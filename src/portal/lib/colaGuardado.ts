/**
 * Guardado confiable para formularios largos en el celular: una cola que nunca tiene dos
 * guardados en vuelo (siempre sube el último estado), reintenta con espera creciente y
 * avisa su estado; más un respaldo local en localStorage que no truena en modo privado.
 * No depende de React ni del DOM, para poder probarse aislada.
 */

// ---------- Respaldo local (localStorage puede no existir o lanzar en Safari privado) ----------

export function leerLocal<T>(clave: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(clave)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

/** Devuelve false si no se pudo escribir (modo privado, cuota llena o sin almacenamiento). */
export function escribirLocal(clave: string, valor: unknown): boolean {
  try {
    if (!globalThis.localStorage) return false
    globalThis.localStorage.setItem(clave, JSON.stringify(valor))
    return true
  } catch {
    return false
  }
}

export function borrarLocal(clave: string): void {
  try {
    globalThis.localStorage?.removeItem(clave)
  } catch {
    /* sin almacenamiento: no hay nada que borrar */
  }
}

/** Huella corta y estable de un objeto de respuestas (claves ordenadas; FNV-1a de 32 bits). */
export function huella(obj: Record<string, string>): string {
  const texto = JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]))
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}.${texto.length}`
}

/** Espera antes del reintento n (1, 2, 3…): 2 s, 4 s, 8 s, 16 s y luego 30 s. */
export const esperaReintento = (n: number): number => Math.min(2000 * 2 ** Math.max(0, n - 1), 30_000)

// ---------- Cola de guardado ----------

export type FaseCola = 'limpio' | 'pendiente' | 'guardando' | 'guardado' | 'reintentando' | 'detenido'

export interface EstadoCola {
  fase: FaseCola
  /** Hay cambios que el servidor no ha confirmado. */
  sucio: boolean
  /** Fallos seguidos desde el último guardado bueno (0 = todo bien). */
  fallos: number
  /** Hora (ms) del último guardado confirmado. */
  hora?: number
  error?: string
}

export type ResultadoGuardado = { ok: true } | { ok: false; error: unknown; definitivo: boolean }

/** definitivo: no se puede guardar (no reintentar); reintentable: red o servidor caído; otro: falla sin reintento automático. */
export type TipoFallo = 'definitivo' | 'reintentable' | 'otro'

interface Reloj {
  poner: (fn: () => void, ms: number) => unknown
  quitar: (id: unknown) => void
  ahora: () => number
}

export interface OpcionesCola<C> {
  /** Estado a subir, leído en el momento de mandar (siempre el más reciente). */
  tomar: () => C
  subir: (cuerpo: C) => Promise<void>
  clasificar: (e: unknown) => TipoFallo
  alCambiar?: (estado: EstadoCola) => void
  /** Se va a intentar subir este cuerpo (puede o no llegar). */
  alIntentar?: (cuerpo: C) => void
  alConfirmar?: (cuerpo: C) => void
  /** Fallo definitivo en un guardado en segundo plano (no se llama mientras la cola está en pausa). */
  alDefinitivo?: (e: unknown) => void
  /** Espera tras un cambio antes de guardar (ms). */
  espera?: number
  reintento?: (fallos: number) => number
  reloj?: Reloj
}

const RELOJ: Reloj = {
  poner: (fn, ms) => globalThis.setTimeout(fn, ms),
  quitar: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  ahora: () => Date.now()
}

const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class ColaGuardado<C> {
  private version = 0
  private confirmada = 0
  private enVuelo: Promise<ResultadoGuardado> | null = null
  private temporizador: unknown = null
  private fallos = 0
  private ultimoTipo: TipoFallo | null = null
  private error?: string
  private hora?: number
  private pausada = false
  private detenida = false
  private readonly reloj: Reloj

  constructor(private readonly op: OpcionesCola<C>) {
    this.reloj = op.reloj ?? RELOJ
  }

  get sucio(): boolean {
    return this.version !== this.confirmada
  }

  get estado(): EstadoCola {
    let fase: FaseCola
    if (this.enVuelo) fase = 'guardando'
    else if (!this.sucio) fase = this.hora ? 'guardado' : 'limpio'
    else if (this.fallos > 0) fase = this.ultimoTipo === 'reintentable' ? 'reintentando' : 'detenido'
    else fase = 'pendiente'
    return { fase, sucio: this.sucio, fallos: this.fallos, hora: this.hora, error: this.error }
  }

  /** Hubo un cambio local: se guarda tras la espera (o lo sube el reintento ya programado). */
  cambio(): void {
    this.marcar()
    // Durante una racha de fallos manda el reintento programado, no cada tecla
    if (this.fallos > 0 && this.temporizador !== null) return
    this.programar(this.op.espera ?? 800)
  }

  /** Marca que hay algo por subir sin programar nada (para forzar un guardado con ahora()). */
  marcar(): void {
    if (this.detenida) return
    this.version += 1
    this.emitir()
  }

  /** Guarda ya: espera al guardado en vuelo y sube lo que falte. Resuelve con el resultado del último intento. */
  async ahora(): Promise<ResultadoGuardado> {
    this.quitarTemporizador()
    for (let vuelta = 0; vuelta < 6; vuelta++) {
      if (this.enVuelo) {
        await this.enVuelo
        continue
      }
      if (!this.sucio) return { ok: true }
      const r = await this.bombear()
      if (!r.ok) return r
    }
    return this.sucio ? { ok: false, error: new Error('Los cambios no dejaron de llegar.'), definitivo: false } : { ok: true }
  }

  /** Volvió la red o la pestaña: si hay algo pendiente, se intenta de inmediato. */
  reintentar(): void {
    if (this.pausada || this.detenida || !this.sucio || this.enVuelo) return
    this.quitarTemporizador()
    void this.bombear()
  }

  /** En pausa no hay guardados en segundo plano (p. ej. mientras se envía la actividad). */
  pausar(pausa: boolean): void {
    this.pausada = pausa
    if (pausa) this.quitarTemporizador()
    else if (this.sucio && !this.enVuelo) this.programar(0)
  }

  activar(): void {
    this.detenida = false
  }

  detener(): void {
    this.detenida = true
    this.quitarTemporizador()
  }

  // ---------- internos ----------

  private emitir(): void {
    this.op.alCambiar?.(this.estado)
  }

  private quitarTemporizador(): void {
    if (this.temporizador !== null) this.reloj.quitar(this.temporizador)
    this.temporizador = null
  }

  private programar(ms: number): void {
    this.quitarTemporizador()
    if (this.pausada || this.detenida) return
    this.temporizador = this.reloj.poner(() => {
      this.temporizador = null
      void this.bombear()
    }, ms)
  }

  private bombear(): Promise<ResultadoGuardado> {
    if (this.enVuelo) return this.enVuelo
    if (!this.sucio || this.detenida) return Promise.resolve({ ok: true })
    const version = this.version
    const cuerpo = this.op.tomar()
    this.op.alIntentar?.(cuerpo)
    this.enVuelo = this.subirUna(version, cuerpo)
    this.emitir()
    return this.enVuelo
  }

  private async subirUna(version: number, cuerpo: C): Promise<ResultadoGuardado> {
    let r: ResultadoGuardado
    try {
      await this.op.subir(cuerpo)
      // Versiones en orden: nunca hay dos en vuelo, así que confirmar esta no pisa una más nueva
      this.confirmada = Math.max(this.confirmada, version)
      this.fallos = 0
      this.ultimoTipo = null
      this.error = undefined
      this.hora = this.reloj.ahora()
      this.op.alConfirmar?.(cuerpo)
      r = { ok: true }
    } catch (e) {
      const tipo = this.op.clasificar(e)
      if (tipo !== 'definitivo') {
        this.fallos += 1
        this.ultimoTipo = tipo
        this.error = mensaje(e)
      }
      r = { ok: false, error: e, definitivo: tipo === 'definitivo' }
    }
    this.enVuelo = null
    if (!this.detenida) {
      if (r.ok) {
        // Llegaron cambios mientras volaba: se sube el último estado (salvo que ya haya una espera corriendo)
        if (this.sucio && this.temporizador === null) this.programar(0)
      } else if (r.definitivo) {
        if (!this.pausada) this.op.alDefinitivo?.(r.error)
      } else if (this.ultimoTipo === 'reintentable') {
        this.programar((this.op.reintento ?? esperaReintento)(this.fallos))
      }
    }
    this.emitir()
    return r
  }
}
