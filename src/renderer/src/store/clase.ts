import { create } from 'zustand'
import type { Sesion } from '@shared/types'
import { api } from '../lib/api'

/**
 * Motor del reloj de clase. Vive fuera de la página para que el conteo no se pierda
 * al navegar. Se persiste en localStorage para sobrevivir a un reinicio de la app.
 * Mientras corre se guarda la hora de fin (finEn) y `restante` se calcula de la hora real,
 * así no se atrasa si la Mac se duerme o la ventana queda oculta.
 */
interface EstadoClase {
  sesion: Sesion | null
  indice: number
  restante: number // segundos de la actividad actual; negativo = tiempo excedido
  corriendo: boolean
  finEn: number | null // ms en que la actividad actual llega a 0; solo mientras corre
  inicioSesion: number | null
  avanzarAuto: boolean
  sonido: boolean
  _timer: number | null
  cargar: (s: Sesion, opts?: Opciones) => void
  iniciar: () => void
  pausar: () => void
  siguiente: () => void
  anterior: () => void
  irA: (i: number) => void
  ajustar: (seg: number) => void
  reiniciarActividad: () => void
  terminar: () => void
  refrescarSesion: (s: Sesion, opts?: Opciones) => void
}

type Opciones = { avanzarAuto?: boolean; sonido?: boolean }

const CLAVE = 'app-docente.clase'

// Un solo AudioContext para toda la app: Chromium limita cuántos puede haber abiertos
let audio: AudioContext | null = null
function beep(veces = 1): void {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const ctx = audio
    for (let i = 0; i < veces; i++) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g)
      g.connect(ctx.destination)
      o.frequency.value = 880
      g.gain.value = 0.15
      o.start(ctx.currentTime + i * 0.35)
      o.stop(ctx.currentTime + i * 0.35 + 0.22)
    }
  } catch {
    /* sin audio */
  }
}

function guardar(e: Partial<EstadoClase>): void {
  const { sesion, indice, restante, corriendo, finEn, inicioSesion, avanzarAuto, sonido } = e
  localStorage.setItem(CLAVE, JSON.stringify({ sesion, indice, restante, corriendo, finEn, inicioSesion, avanzarAuto, sonido, guardadoEn: Date.now() }))
}

export const useClase = create<EstadoClase>((set, get) => {
  // Recalcula con la hora real. Si se saltaron actividades (p. ej. Mac dormida con avance
  // automático) las recorre restando sus duraciones y pita una sola vez.
  const tick = (): void => {
    const e = get()
    if (!e.corriendo || !e.sesion || e.finEn === null) return
    const acts = e.sesion.actividades ?? []
    const ahora = Date.now()
    const seg = (fin: number): number => Math.round((fin - ahora) / 1000)
    let indice = e.indice
    let finEn = e.finEn
    let cruzo = false
    while (e.avanzarAuto && seg(finEn) <= 0 && indice < acts.length - 1) {
      indice++
      finEn += acts[indice].duracion_min * 60_000
      cruzo = true
    }
    const r = seg(finEn)
    if (e.avanzarAuto && r <= 0) {
      // Terminó la última actividad
      pararTimer()
      if (e.sonido) beep(3)
      set({ indice, restante: 0, corriendo: false, finEn: null })
    } else {
      // Sin avance automático sigue contando en negativo (tiempo excedido): pita solo al cruzar
      if (e.sonido) {
        if (cruzo || (e.restante > 0 && r <= 0)) beep(3)
        else if (e.restante > 10 && r <= 10) beep(1)
      }
      set({ indice, finEn, restante: r })
    }
    guardar(get())
  }
  const arrancarTimer = (): void => {
    const e = get()
    if (e._timer) window.clearInterval(e._timer)
    set({ _timer: window.setInterval(tick, 1000) })
  }
  const pararTimer = (): void => {
    const e = get()
    if (e._timer) window.clearInterval(e._timer)
    set({ _timer: null })
  }
  // Fija el tiempo de la actividad; si el reloj corre, mueve también la hora de fin
  const fijar = (cambio: Partial<EstadoClase> & { restante: number }): void => {
    set({ ...cambio, finEn: get().corriendo ? Date.now() + cambio.restante * 1000 : null })
    guardar(get())
  }

  // Oculta, Chromium espacia los timers: al volver al frente se recalcula al instante
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick()
  })
  window.addEventListener('focus', tick)

  // Restaurar sesión previa si existe; si venía corriendo, sigue corriendo
  let inicial: Partial<EstadoClase> = {}
  try {
    const raw = localStorage.getItem(CLAVE)
    if (raw) {
      const g = JSON.parse(raw)
      if (g.sesion) {
        // Tras un cierre a media clase el reloj sigue donde debe; pasadas 3 horas ya no es la misma
        // clase y se restaura en pausa en vez de mostrar horas de tiempo excedido
        const reciente = Date.now() - (g.guardadoEn ?? 0) < 3 * 3600_000
        // Lo guardado antes de existir finEn se deduce de guardadoEn
        const finEn: number | null = g.corriendo && reciente ? (g.finEn ?? g.guardadoEn + g.restante * 1000) : null
        inicial = { sesion: g.sesion, indice: g.indice, restante: g.restante, corriendo: finEn !== null, finEn, inicioSesion: g.inicioSesion, avanzarAuto: g.avanzarAuto ?? true, sonido: g.sonido ?? true }
      }
    }
  } catch {
    /* ignorar */
  }
  if (inicial.corriendo) {
    window.setTimeout(() => {
      arrancarTimer()
      tick()
    }, 0)
  }

  return {
    sesion: null,
    indice: 0,
    restante: 0,
    corriendo: false,
    finEn: null,
    inicioSesion: null,
    avanzarAuto: true,
    sonido: true,
    _timer: null,
    ...inicial,
    cargar: (s, opts) => {
      pararTimer()
      const acts = s.actividades ?? []
      set({ sesion: s, indice: 0, restante: acts[0] ? acts[0].duracion_min * 60 : 0, corriendo: false, finEn: null, inicioSesion: null, avanzarAuto: opts?.avanzarAuto ?? get().avanzarAuto, sonido: opts?.sonido ?? get().sonido })
      guardar(get())
    },
    // Trae lo editado en el plan sin perder la actividad ni lo transcurrido. Al guardar el plan
    // las actividades se reescriben (cambian de id), así que la actual se ubica por nombre.
    refrescarSesion: (s, opts) => {
      tick()
      const e = get()
      const acts = s.actividades ?? []
      const previa = e.sesion?.actividades?.[e.indice]
      let indice = Math.min(e.indice, Math.max(0, acts.length - 1))
      if (previa && acts[indice]?.nombre !== previa.nombre) {
        const i = acts.findIndex((a) => a.nombre === previa.nombre)
        if (i >= 0) indice = i
      }
      const nueva = acts[indice]
      // Si cambió la duración se recorre el fin lo mismo: lo transcurrido se conserva
      const delta = previa && nueva ? (nueva.duracion_min - previa.duracion_min) * 60 : 0
      set({ sesion: s, indice, avanzarAuto: opts?.avanzarAuto ?? e.avanzarAuto, sonido: opts?.sonido ?? e.sonido })
      if (e.corriendo && e.finEn !== null) {
        set({ finEn: e.finEn + delta * 1000 })
        tick()
      } else set({ restante: e.restante + delta })
      guardar(get())
    },
    iniciar: () => {
      const e = get()
      if (!e.sesion || e.corriendo) return
      set({ corriendo: true, finEn: Date.now() + e.restante * 1000, inicioSesion: e.inicioSesion ?? Date.now() })
      arrancarTimer()
      guardar(get())
    },
    pausar: () => {
      tick()
      pararTimer()
      set({ corriendo: false, finEn: null })
      guardar(get())
    },
    siguiente: () => {
      const e = get()
      const acts = e.sesion?.actividades ?? []
      if (e.indice >= acts.length - 1) return
      const i = e.indice + 1
      fijar({ indice: i, restante: acts[i].duracion_min * 60 })
    },
    anterior: () => {
      const e = get()
      const acts = e.sesion?.actividades ?? []
      if (e.indice <= 0) return
      const i = e.indice - 1
      fijar({ indice: i, restante: acts[i].duracion_min * 60 })
    },
    irA: (i) => {
      const acts = get().sesion?.actividades ?? []
      if (!acts[i]) return
      fijar({ indice: i, restante: acts[i].duracion_min * 60 })
    },
    ajustar: (seg) => {
      const e = get()
      if (e.corriendo && e.finEn !== null) {
        const ahora = Date.now()
        const finEn = Math.max(ahora, e.finEn + seg * 1000)
        set({ finEn, restante: Math.round((finEn - ahora) / 1000) })
      } else set({ restante: Math.max(0, e.restante + seg) })
      guardar(get())
    },
    reiniciarActividad: () => {
      const e = get()
      const a = e.sesion?.actividades?.[e.indice]
      if (a) fijar({ restante: a.duracion_min * 60 })
    },
    terminar: () => {
      pararTimer()
      set({ sesion: null, indice: 0, restante: 0, corriendo: false, finEn: null, inicioSesion: null })
      localStorage.removeItem(CLAVE)
    }
  }
})

let abriendo: { id: number; p: Promise<boolean> } | null = null

/**
 * Lleva una sesión al reloj sin tumbar la clase en curso: si ya es la cargada solo refresca
 * su plan; si es otra y el reloj corre, pide confirmación. Devuelve false si no se abrió.
 */
export function abrirEnClase(sesionId: number): Promise<boolean> {
  // Evita doble confirmación por doble clic o por el efecto doble de StrictMode
  if (abriendo?.id === sesionId) return abriendo.p
  const p = (async (): Promise<boolean> => {
    const [s, aj] = await Promise.all([api.sesiones.obtener(sesionId), api.ajustes.leer()])
    if (!s) return false
    const clase = useClase.getState()
    const opts = { avanzarAuto: aj.avanzar_auto, sonido: aj.sonido }
    if (clase.sesion?.id === s.id) {
      clase.refrescarSesion(s, opts)
      return true
    }
    if (clase.corriendo && clase.sesion && !confirm(`El reloj de ${clase.sesion.materia_nombre ?? 'la clase'} (sesión ${clase.sesion.numero}) sigue corriendo. ¿Dejarlo y abrir esta otra clase?`)) return false
    clase.cargar(s, opts)
    return true
  })().finally(() => {
    abriendo = null
  })
  abriendo = { id: sesionId, p }
  return p
}
