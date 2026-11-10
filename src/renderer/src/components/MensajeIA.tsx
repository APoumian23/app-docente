import { memo, type ReactNode } from 'react'
import Markdown from './Markdown'
import type { MensajeChat } from '../lib/api'

/**
 * Un mensaje del chat. Memorizado: mientras llega una respuesta nueva, los anteriores no se vuelven a
 * dibujar (el Markdown con fórmulas es lo más caro de pintar).
 */
export const MensajeIA = memo(function MensajeIA({ m, acciones, compacto = false }: { m: MensajeChat; acciones?: ReactNode; compacto?: boolean; /** Lo que cambia las acciones (p. ej. la materia elegida) */ dep?: unknown }): JSX.Element {
  if (m.rol === 'usuario')
    return (
      <div className="flex justify-end">
        <div className={`max-w-[85%] rounded-2xl rounded-br-sm bg-brand-500 text-white px-3 py-2 whitespace-pre-wrap break-words select-text ${compacto ? 'text-sm' : ''}`}>{m.contenido}</div>
      </div>
    )
  return (
    <div className="max-w-full">
      <div className={`rounded-2xl rounded-bl-sm bg-ink-50 px-3 py-2 select-text overflow-x-auto ${compacto ? 'text-sm [&_.prosa]:text-sm' : ''}`}>
        <Markdown texto={m.contenido} />
      </div>
      {acciones && <div className="mt-1 flex flex-wrap gap-1 text-xs">{acciones}</div>}
    </div>
  )
  // Las acciones son JSX nuevo en cada render: se comparan solo el mensaje y lo que las cambia
}, (a, b) => a.m === b.m && a.compacto === b.compacto && a.dep === b.dep)

/** La respuesta que se está escribiendo: se pinta como texto simple y el Markdown llega al terminar (rápido). */
export function RespuestaEnVivo({ texto, compacto = false, etiqueta = 'Pensando…' }: { texto: string; compacto?: boolean; etiqueta?: string }): JSX.Element {
  return (
    <div className={`rounded-2xl rounded-bl-sm bg-ink-50 px-3 py-2 whitespace-pre-wrap break-words ${compacto ? 'text-sm' : 'text-[15px]'} text-ink-800`}>
      {texto || <span className="text-ink-400">{etiqueta}</span>}
      <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom bg-brand-400 animate-pulse" aria-hidden />
    </div>
  )
}

/** La pregunta se quedó sin respuesta (falló la IA o se cerró la app): el motivo y «Reintentar». */
export function SinRespuesta({ error, onReintentar, compacto = false }: { error: string; onReintentar: () => void; compacto?: boolean }): JSX.Element {
  return (
    <div className={`rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-red-800 ${compacto ? 'text-xs' : 'text-sm'}`} role="alert">
      <div className="font-medium">{error ? 'No se pudo responder' : 'Esta pregunta se quedó sin respuesta'}</div>
      {error && <div className="mt-0.5 break-words">{error}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="btn-secundario text-xs" onClick={onReintentar}>Reintentar</button>
        <a href="#/ajustes" className="btn-fantasma text-xs">Revisar la IA en Ajustes</a>
      </div>
    </div>
  )
}
