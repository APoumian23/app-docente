import { useEffect, useRef, useState } from 'react'
import { MensajeIA, RespuestaEnVivo, SinRespuesta } from './MensajeIA'
import { avisar } from './Aviso'
import { api } from '../lib/api'
import { bloquesDeCodigo, useChat } from '../lib/chat'

const ATAJOS: { t: string; p: string }[] = [
  { t: 'Explicar', p: 'Explícame este programa paso a paso: qué hace cada parte y por qué.' },
  { t: '¿Por qué falla?', p: 'Revisa el programa y lo que salió en la consola: ¿qué está mal y cómo se corrige?' },
  { t: 'Mejorar y comentar', p: 'Mejora este programa (claridad, nombres, eficiencia) y coméntalo para que lo entienda un alumno.' },
  { t: 'Complejidad', p: '¿Cuál es la complejidad en tiempo y espacio de este programa? Justifícalo paso a paso.' },
  { t: 'Hacer pruebas', p: 'Escribe pruebas con assert para este programa, incluidos casos límite, y dime qué casos cubren.' },
  { t: 'Versión para alumnos', p: 'Haz una versión de este programa para que los alumnos la completen: deja huecos marcados con # TODO y escribe las instrucciones del ejercicio.' }
]

/**
 * Asistente del editor de código (como el chat de VS Code): ve el programa abierto y lo último de la
 * consola, y lo que propone se pasa al editor de un clic. Cada programa tiene su conversación.
 */
export default function ChatCodigo({
  programaId,
  lenguaje,
  codigo,
  salida,
  onReemplazar,
  onAgregar
}: {
  programaId: number
  lenguaje: 'python' | 'javascript'
  codigo: string
  salida: string
  onReemplazar: (codigo: string) => void
  onAgregar: (codigo: string) => void
}): JSX.Element {
  const [conv, setConv] = useState<number | null>(null)
  const { mensajes, escribiendo, error, sinRespuesta, enviar, reintentar, detener } = useChat(conv)
  const [texto, setTexto] = useState('')
  const lista = useRef<HTMLDivElement>(null)
  const fin = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setConv(null)
    api.asistente.dePrograma(programaId).then(setConv).catch((e) => avisar((e as Error).message, 'error'))
  }, [programaId])
  useEffect(() => {
    const l = lista.current
    if (l && l.scrollHeight - l.scrollTop - l.clientHeight < 160) fin.current?.scrollIntoView({ block: 'end' })
  }, [mensajes, escribiendo])

  const mandar = (p: string): void => {
    if (!p.trim() || escribiendo !== null || conv == null) return
    setTexto('')
    void enviar(p, { codigo: { lenguaje, codigo, salida } })
  }

  return (
    <aside className="tarjeta flex flex-col min-h-[50vh] max-h-[calc(80vh/var(--zoom,1))]" aria-label="Asistente del código">
      <div className="px-3 py-2 border-b border-ink-100 text-sm font-semibold flex items-center gap-2">
        ✦ Asistente <span className="font-normal text-xs text-ink-400">ve tu código y la consola</span>
      </div>
      <div ref={lista} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {mensajes.length === 0 && escribiendo === null && <p className="text-xs text-ink-500">Pregunta sobre el programa abierto o usa un atajo. Lo que proponga se puede pasar al editor.</p>}
        {mensajes.map((m) => {
          const bloques = m.rol === 'asistente' ? bloquesDeCodigo(m.contenido) : []
          return (
            <MensajeIA
              key={m.id}
              m={m}
              compacto
              acciones={
                bloques.length ? (
                  <>
                    <button className="btn-fantasma text-xs" onClick={() => onReemplazar(bloques[bloques.length - 1].codigo)} title="Cambia todo el código del editor por el que propuso (se puede deshacer con ⌘Z)">
                      Reemplazar en el editor
                    </button>
                    <button className="btn-fantasma text-xs" onClick={() => onAgregar(bloques[bloques.length - 1].codigo)}>Agregar al final</button>
                    <button className="btn-fantasma text-xs" onClick={() => navigator.clipboard.writeText(bloques[bloques.length - 1].codigo).then(() => avisar('Código copiado'))}>Copiar código</button>
                  </>
                ) : undefined
              }
            />
          )
        })}
        {escribiendo !== null && <RespuestaEnVivo texto={escribiendo} compacto />}
        {sinRespuesta && <SinRespuesta compacto error={error} onReintentar={() => reintentar({ codigo: { lenguaje, codigo, salida } })} />}
        <div ref={fin} />
      </div>
      <div className="border-t border-ink-100 p-2 space-y-2">
        <div className="flex flex-wrap gap-1">
          {ATAJOS.map((a) => (
            <button key={a.t} className="rounded-full border border-ink-200 px-2 py-0.5 text-xs hover:bg-ink-50 disabled:opacity-50" disabled={escribiendo !== null || conv == null} onClick={() => mandar(a.p)}>
              {a.t}
            </button>
          ))}
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            mandar(texto)
          }}
        >
          <textarea
            className="input flex-1 resize-none text-sm"
            rows={2}
            value={texto}
            placeholder="Pregunta sobre tu código… (Enter envía)"
            aria-label="Pregunta al asistente del código"
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                mandar(texto)
              }
            }}
          />
          {escribiendo !== null ? (
            <button type="button" className="btn-peligro" onClick={detener}>■</button>
          ) : (
            <button type="submit" className="btn-primario" disabled={!texto.trim() || conv == null}>Enviar</button>
          )}
        </form>
      </div>
    </aside>
  )
}
