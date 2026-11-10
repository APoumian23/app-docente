/**
 * Estado del Asistente que vive mientras la app está abierta (no solo mientras su pantalla está a la
 * vista): si el docente pide algo y se va a otra pantalla, la respuesta sigue llegando y se guarda; al
 * volver la ve avanzando o ya terminada. Si termina mientras está en otra pantalla, se le avisa.
 * Lo que llega se junta y se pinta cada 60 ms (con setTimeout: funciona aunque la ventana esté detrás).
 */
import { create } from 'zustand'
import { api } from '../lib/api'
import { avisar } from '../components/Aviso'

type Opciones = Parameters<typeof api.asistente.enviar>[2]

interface EstadoAsistente {
  /** Texto en vivo de cada conversación que se está respondiendo */
  vivos: Record<number, string>
  /** Último error de cada conversación (se muestra con «Reintentar») */
  errores: Record<number, string>
  /** Sube cada vez que una conversación recibe respuesta guardada (las pantallas recargan sus mensajes) */
  version: Record<number, number>
  /** Conversación que el docente tiene a la vista (para no avisarle de lo que ya está viendo) */
  aLaVista: number | null
  enviar: (id: number, texto: string, opciones?: Opciones) => Promise<void>
  detener: (id: number) => void
  verConversacion: (id: number | null) => void
}

const buffer = new Map<number, string>()
let reloj: ReturnType<typeof setTimeout> | null = null

export const useAsistente = create<EstadoAsistente>((set, get) => ({
  vivos: {},
  errores: {},
  version: {},
  aLaVista: null,
  verConversacion: (id) => set({ aLaVista: id }),
  detener: (id) => void api.asistente.detener(id),
  enviar: async (id, texto, opciones) => {
    if (get().vivos[id] !== undefined) return
    buffer.set(id, '')
    set((s) => ({ vivos: { ...s.vivos, [id]: '' }, errores: { ...s.errores, [id]: '' } }))
    try {
      await api.asistente.enviar(id, texto, opciones)
      if (get().aLaVista !== id) avisar('El Asistente terminó de responder: ábrelo para verlo.')
    } catch (e) {
      const msg = (e as Error).message
      set((s) => ({ errores: { ...s.errores, [id]: msg } }))
      if (get().aLaVista !== id) avisar(`El Asistente no pudo responder: ${msg}`, 'error')
    } finally {
      buffer.delete(id)
      set((s) => {
        const vivos = { ...s.vivos }
        delete vivos[id]
        return { vivos, version: { ...s.version, [id]: (s.version[id] ?? 0) + 1 } }
      })
    }
  }
}))

/** Se llama una vez al abrir la app: escucha los pedazos y recupera lo que ya se estaba respondiendo. */
export function iniciarAsistente(): () => void {
  const pintar = (): void => {
    reloj = null
    useAsistente.setState((s) => {
      const vivos = { ...s.vivos }
      for (const [id, t] of buffer) if (vivos[id] !== undefined) vivos[id] = t
      return { vivos }
    })
  }
  const quitar = api.asistente.alTrozo((d) => {
    if (!buffer.has(d.conversacion_id)) {
      // Respuesta que empezó antes de recargar la ventana: se sigue mostrando
      buffer.set(d.conversacion_id, '')
      useAsistente.setState((s) => ({ vivos: { ...s.vivos, [d.conversacion_id]: '' } }))
    }
    buffer.set(d.conversacion_id, (buffer.get(d.conversacion_id) ?? '') + d.texto)
    reloj ??= setTimeout(pintar, 60)
  })
  // Lo que ya iba escrito al recargar
  api.asistente
    .enCurso()
    .then((l) => {
      for (const r of l) buffer.set(r.conversacion_id, r.texto)
      if (l.length) useAsistente.setState((s) => ({ vivos: { ...s.vivos, ...Object.fromEntries(l.map((r) => [r.conversacion_id, r.texto])) } }))
      // Al terminar una que empezó antes de recargar, se nota por el último pedazo y una consulta corta
      if (l.length) {
        const revisar = setInterval(async () => {
          const siguen = new Set((await api.asistente.enCurso().catch(() => [])).map((r) => r.conversacion_id))
          const terminadas = l.filter((r) => !siguen.has(r.conversacion_id))
          if (!terminadas.length) return
          useAsistente.setState((s) => {
            const vivos = { ...s.vivos }
            const version = { ...s.version }
            for (const r of terminadas) {
              delete vivos[r.conversacion_id]
              buffer.delete(r.conversacion_id)
              version[r.conversacion_id] = (version[r.conversacion_id] ?? 0) + 1
            }
            return { vivos, version }
          })
          if (terminadas.length === l.length) clearInterval(revisar)
        }, 1500)
      }
    })
    .catch(() => undefined)
  return quitar
}
