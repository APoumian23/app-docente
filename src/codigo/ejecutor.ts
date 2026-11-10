/**
 * Corre código en un worker y entrega lo que va saliendo. Python reusa su worker (cargar Pyodide
 * tarda unos segundos); «Detener», el tope de tiempo o un error fatal matan el worker y el siguiente
 * se crea de cero. El tope cuenta desde que el código empieza a correr, no mientras Python se descarga
 * (con 40 celulares en el mismo Wi-Fi la descarga puede tardar más que el tope).
 */
import PythonWorker from './python.worker?worker&inline'
import JsWorker from './js.worker?worker&inline'
import type { DelWorker } from './mensajes'
import type { Lenguaje } from './lenguajes'

export type Evento = Exclude<DelWorker, { tipo: 'fin' } | { tipo: 'listo' }>

/** Tope de lo que se muestra: un print en un ciclo infinito no debe congelar la ventana. */
const TOPE_SALIDA = 200_000
/** Si Python no termina de llegar en este tiempo (red caída), se avisa en vez de esperar para siempre. */
const TOPE_CARGA_MS = 180_000

export class Ejecutor {
  private workers: Partial<Record<Lenguaje, Worker>> = {}
  private terminar: ((ok: boolean, motivo?: string) => void) | null = null
  private activo: Lenguaje | null = null
  private base: string
  /** Sube cada vez que se crea otro Python (Detener, tope de tiempo o error fatal): las variables de las sesiones se perdieron */
  generacionPython = 0

  /**
   * `base`: dirección de los archivos de Pyodide, con «/» al final.
   * `aislado`: Python nuevo en cada ejecución (al revisar entregas: el código de un alumno no puede
   * alterar print, sum o random para el siguiente).
   */
  constructor(base: string, private aislado = false) {
    // El worker vive en un blob: una ruta relativa («/pyodide/») no se podría resolver allá dentro
    this.base = new URL(base, location.href).href
  }

  get ocupado(): boolean {
    return this.terminar !== null
  }

  private worker(l: Lenguaje): Worker {
    return (this.workers[l] ??= l === 'python' ? new PythonWorker() : new JsWorker())
  }

  /** Empieza a cargar Python en cuanto se abre el editor, para que «Ejecutar» responda de inmediato. */
  precargar(lenguaje: Lenguaje): void {
    if (lenguaje !== 'python' || this.aislado || this.workers.python) return
    this.worker('python').postMessage({ tipo: 'precargar', base: this.base })
  }

  ejecutar(
    lenguaje: Lenguaje,
    codigo: string,
    entrada: string,
    alEvento: (e: Evento) => void,
    limiteSeg = 0,
    paquetes = true,
    sesion?: string
  ): Promise<{ ok: boolean; motivo?: string }> {
    if (this.terminar) this.detener('Se inició otra ejecución.')
    // JavaScript no guarda nada entre ejecuciones: worker nuevo cada vez (variables globales limpias)
    if (lenguaje === 'javascript' || this.aislado) this.matar(lenguaje)
    const w = this.worker(lenguaje)
    this.activo = lenguaje
    let mostrado = 0
    let recortado = false
    return new Promise((resolver) => {
      let reloj: ReturnType<typeof setTimeout> | null = null
      let carga: ReturnType<typeof setTimeout> | null = setTimeout(
        () => this.detener('Python no terminó de cargar: revisa la conexión con el servidor del salón y vuelve a intentar.'),
        TOPE_CARGA_MS
      )
      this.terminar = (ok, motivo) => {
        if (reloj) clearTimeout(reloj)
        if (carga) clearTimeout(carga)
        w.onmessage = null
        w.onerror = null
        this.terminar = null
        this.activo = null
        resolver({ ok, motivo })
      }
      w.onmessage = (e: MessageEvent<DelWorker>) => {
        const m = e.data
        if (m.tipo === 'fin') {
          if (m.reiniciar) this.matar(lenguaje)
          return this.terminar?.(m.ok)
        }
        if (m.tipo === 'listo') {
          if (carga) clearTimeout(carga)
          carga = null
          if (limiteSeg > 0) reloj = setTimeout(() => this.detener(`Se detuvo: pasó de ${limiteSeg} s (¿un ciclo que no termina?).`), limiteSeg * 1000)
          return
        }
        if (m.tipo === 'salida' || m.tipo === 'error' || m.tipo === 'entrada') {
          if (recortado) return
          mostrado += m.texto.length
          if (mostrado > TOPE_SALIDA) {
            recortado = true
            alEvento({ tipo: 'error', texto: '\n… (salida recortada: es demasiado larga)\n' })
            return this.detener('Se detuvo: imprimía demasiado (¿un ciclo que no termina?).')
          }
        }
        alEvento(m)
      }
      w.onerror = (e) => {
        e.preventDefault()
        alEvento({ tipo: 'error', texto: `${e.message || 'Error al correr el código'}\n` })
        this.matar(lenguaje)
        this.terminar?.(false)
      }
      w.postMessage({ tipo: 'ejecutar', codigo, entrada: entrada === '' ? [] : entrada.replace(/\r/g, '').split('\n'), base: this.base, paquetes, ...(sesion ? { sesion } : {}) })
    })
  }

  /** Olvida las variables de una sesión de cuaderno («Reiniciar Python»). */
  olvidarSesion(sesion: string): void {
    this.workers.python?.postMessage({ tipo: 'olvidar', sesion })
  }

  /** Corta lo que esté corriendo (mata el worker). */
  detener(motivo = 'Detenido.'): void {
    if (!this.terminar) return
    if (this.activo) this.matar(this.activo)
    this.terminar(false, motivo)
  }

  private matar(l: Lenguaje): void {
    if (l === 'python' && this.workers.python) this.generacionPython++
    this.workers[l]?.terminate()
    delete this.workers[l]
  }

  cerrar(): void {
    this.detener()
    for (const l of Object.keys(this.workers) as Lenguaje[]) this.matar(l)
  }
}
