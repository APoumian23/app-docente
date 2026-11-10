/**
 * Lógica común del chat con la IA (sección Asistente y panel de Programar). El envío y la respuesta en
 * vivo viven en el almacén global (store/asistente.ts): si el docente cambia de pantalla, la respuesta
 * sigue llegando y al volver se ve. Aquí solo se cargan los mensajes de la conversación a la vista.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type MensajeChat } from './api'
import { avisar } from '../components/Aviso'
import { useAsistente } from '../store/asistente'

type Opciones = Parameters<typeof api.asistente.enviar>[2]

export function useChat(conversacionId: number | null): {
  mensajes: MensajeChat[]
  /** Texto en vivo de la respuesta (null = no se está respondiendo) */
  escribiendo: string | null
  /** Error de la última respuesta, o la pregunta que se quedó sin respuesta */
  error: string
  sinRespuesta: boolean
  enviar: (texto: string, opciones?: Opciones, id?: number) => Promise<void>
  reintentar: (opciones?: Opciones) => Promise<void>
  detener: () => void
} {
  const [mensajes, setMensajes] = useState<MensajeChat[]>([])
  const vivo = useAsistente((s) => (conversacionId == null ? undefined : s.vivos[conversacionId]))
  const error = useAsistente((s) => (conversacionId == null ? '' : s.errores[conversacionId] ?? ''))
  const version = useAsistente((s) => (conversacionId == null ? 0 : s.version[conversacionId] ?? 0))
  const enviarGlobal = useAsistente((s) => s.enviar)
  const detenerGlobal = useAsistente((s) => s.detener)
  const verConversacion = useAsistente((s) => s.verConversacion)

  // Mensajes guardados: al cambiar de conversación y cada vez que llega una respuesta
  useEffect(() => {
    if (conversacionId == null) return setMensajes([])
    let activo = true
    api.asistente.mensajes(conversacionId).then((m) => activo && setMensajes(m)).catch((e) => avisar((e as Error).message, 'error'))
    return () => {
      activo = false
    }
  }, [conversacionId, version])
  // Mientras está a la vista no se avisa al terminar
  useEffect(() => {
    verConversacion(conversacionId)
    return () => verConversacion(null)
  }, [conversacionId, verConversacion])

  const enviar = useCallback(
    async (texto: string, opciones?: Opciones, id = conversacionId ?? undefined): Promise<void> => {
      const t = texto.trim()
      if (!t || id == null) return
      setMensajes((m) => [...m, { id: -Date.now(), conversacion_id: id, rol: 'usuario', contenido: t, creado: '' }])
      await enviarGlobal(id, t, opciones)
    },
    [conversacionId, enviarGlobal]
  )

  const ultima = mensajes[mensajes.length - 1]
  const sinRespuesta = vivo === undefined && !!ultima && ultima.rol === 'usuario' && ultima.id > 0
  const reintentar = useCallback(
    async (opciones?: Opciones): Promise<void> => {
      if (conversacionId == null || !ultima || ultima.rol !== 'usuario') return
      await enviarGlobal(conversacionId, ultima.contenido, { ...opciones, reintento: true })
    },
    [conversacionId, ultima, enviarGlobal]
  )

  return {
    mensajes,
    escribiendo: vivo ?? null,
    error,
    sinRespuesta,
    enviar,
    reintentar,
    detener: () => conversacionId != null && detenerGlobal(conversacionId)
  }
}

/** Bloques de código de una respuesta (para mandarlos al editor). */
export function bloquesDeCodigo(texto: string): { lenguaje: 'python' | 'javascript'; codigo: string }[] {
  return [...texto.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)]
    .filter((m) => !/^(text|txt|bash|sh|console|salida|output)$/i.test(m[1]))
    .map((m) => ({ lenguaje: /^(javascript|js)$/i.test(m[1]) ? 'javascript' : 'python', codigo: m[2] }))
}
