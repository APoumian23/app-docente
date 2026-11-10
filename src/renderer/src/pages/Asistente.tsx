import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import Encabezado from '../components/Encabezado'
import { MensajeIA, RespuestaEnVivo, SinRespuesta } from '../components/MensajeIA'
import { avisar } from '../components/Aviso'
import { api, type ConversacionChat, type MensajeChat } from '../lib/api'
import { bloquesDeCodigo, useChat } from '../lib/chat'
import { useRecordado } from '../lib/recordado'
import { fmtFechaMx } from '../lib/tiempo'
import { Buscador, SinResultados, coincide, ordenNatural } from '../components/Filtros'
import type { Materia } from '@shared/types'

const primerCodigo = (texto: string): ReturnType<typeof bloquesDeCodigo>[number] | null => bloquesDeCodigo(texto)[0] ?? null

const SUGERENCIAS = [
  'Explícame el tema de hoy como si lo fuera a dar en clase, con ejemplos resueltos',
  'Dame 5 ejercicios de práctica con sus soluciones paso a paso',
  'Revisa este código y dime qué está mal y por qué:',
  'Arma una analogía para explicar este concepto a alumnos de primer semestre:'
]

/**
 * Asistente tipo chat con la IA (Claude o NVIDIA, según Ajustes). Conversaciones guardadas, con la
 * materia como contexto (temario y materiales), respuesta en vivo y atajos para llevar lo útil a la
 * materia o a Programar.
 */
export default function Asistente(): JSX.Element {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [conversaciones, setConversaciones] = useState<ConversacionChat[]>([])
  const [materias, setMaterias] = useState<Materia[]>([])
  const [actual, setActual] = useState<number | null>(null)
  const { mensajes, escribiendo, error, sinRespuesta, enviar: enviarChat, reintentar, detener } = useChat(actual)
  const [texto, setTexto] = useState('')
  const [web, setWeb] = useState(false)
  const [disponible, setDisponible] = useState<boolean | null>(null)
  const [verLista, setVerLista] = useState(true)
  const fin = useRef<HTMLDivElement>(null)
  const caja = useRef<HTMLTextAreaElement>(null)

  const conv = conversaciones.find((c) => c.id === actual) ?? null
  // Buscar y filtrar conversaciones: solo cambia la lista, no la conversación abierta
  const [busqueda, setBusqueda] = useRecordado('asistente.busqueda', '')
  const [materiaF, setMateriaF] = useRecordado<number | '' | 'sin'>('asistente.materia', '')
  const materiasEnLista = useMemo(() => {
    const n = new Map<number, { nombre: string; total: number }>()
    for (const c of conversaciones) if (c.materia_id != null) n.set(c.materia_id, { nombre: c.materia_nombre ?? 'Materia', total: (n.get(c.materia_id)?.total ?? 0) + 1 })
    return [...n.entries()].sort((a, b) => ordenNatural(a[1].nombre, b[1].nombre))
  }, [conversaciones])
  const sinMateria = conversaciones.filter((c) => c.materia_id == null).length
  const listaConv = conversaciones.filter(
    (c) => coincide(busqueda, c.titulo, c.materia_nombre) && (materiaF === '' || (materiaF === 'sin' ? c.materia_id == null : c.materia_id === materiaF))
  )
  const hayFiltro = !!busqueda.trim() || materiaF !== ''
  const quitarFiltros = (): void => {
    setBusqueda('')
    setMateriaF('')
  }

  const cargarLista = async (elegir?: number): Promise<void> => {
    const l = await api.asistente.listar()
    setConversaciones(l)
    // Desde una materia (?materia=) se abre su conversación más reciente; si no tiene, una nueva al escribir
    const deMateria = params.get('materia') ? Number(params.get('materia')) : null
    setActual((a) => elegir ?? a ?? (deMateria ? l.find((c) => c.materia_id === deMateria)?.id ?? null : l[0]?.id ?? null))
  }
  useEffect(() => {
    cargarLista().catch((e) => avisar((e as Error).message, 'error'))
    api.materias.listar().then((m) => setMaterias(m.filter((x) => !x.oculta)))
    api.ia.disponible().then(setDisponible).catch(() => setDisponible(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Baja sola mientras llega la respuesta, salvo que el docente haya subido a leer algo anterior
  const lista = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const l = lista.current
    if (l && l.scrollHeight - l.scrollTop - l.clientHeight < 160) fin.current?.scrollIntoView({ block: 'end' })
  }, [mensajes, escribiendo])

  const nueva = async (): Promise<void> => {
    const materia = params.get('materia') ? Number(params.get('materia')) : conv?.materia_id ?? null
    const id = await api.asistente.crear(materia)
    await cargarLista(id)
    caja.current?.focus()
  }

  const enviar = async (contenido = texto): Promise<void> => {
    const t = contenido.trim()
    if (!t || escribiendo !== null) return
    let id = actual
    if (id == null) {
      id = await api.asistente.crear(params.get('materia') ? Number(params.get('materia')) : null)
      await cargarLista(id)
    }
    setTexto('')
    await enviarChat(t, { web }, id)
    cargarLista(id)
  }

  const guardarEnMateria = async (m: MensajeChat): Promise<void> => {
    if (!conv?.materia_id) return avisar('Elige una materia para esta conversación (arriba) y vuelve a intentar.', 'error')
    const titulo = /^#\s+(.+)$/m.exec(m.contenido)?.[1] ?? conv.titulo
    const id = await api.asistente.guardarEnMateria(conv.materia_id, titulo, m.contenido)
    avisar('Guardado en la materia como apuntes')
    nav(`/evaluacion/${id}`)
  }
  const aProgramar = async (m: MensajeChat): Promise<void> => {
    const c = primerCodigo(m.contenido)
    if (!c) return
    await api.programas.guardar({ nombre: `Del asistente${c.lenguaje === 'python' ? '.py' : '.js'}`, lenguaje: c.lenguaje, codigo: c.codigo, entrada: '', materia_id: conv?.materia_id ?? null })
    nav(conv?.materia_id ? `/programar?materia=${conv.materia_id}` : '/programar')
  }
  const borrar = async (): Promise<void> => {
    if (!conv || !confirm(`¿Borrar la conversación «${conv.titulo}»?`)) return
    await api.asistente.borrar(conv.id)
    setActual(null)
    await cargarLista()
  }

  return (
    <div className="flex flex-col h-full">
      <Encabezado
        titulo="Asistente"
        sub="Conversa con la IA sobre tus materias: explicaciones, ejercicios, código y material para tus alumnos"
        acciones={
          <>
            <button className="btn-secundario lg:hidden" onClick={() => setVerLista((v) => !v)}>{verLista ? 'Ocultar conversaciones' : 'Conversaciones'}</button>
            <button className="btn-primario" onClick={nueva}>+ Nueva conversación</button>
          </>
        }
      />
      {disponible === false && (
        <div className="mx-4 sm:mx-8 mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Falta configurar la IA: elige proveedor y pega tu API key en <Link to="/ajustes" className="underline font-medium">Ajustes</Link>.
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-wrap gap-4 px-4 sm:px-8 py-4">
        {verLista && (
          <nav className="tarjeta flex flex-col flex-[1_1_14rem] max-w-full lg:max-w-[17rem] max-h-[40vh] lg:max-h-none overflow-hidden" aria-label="Conversaciones">
            {conversaciones.length > 0 && (
              // Buscar arriba, fijo; la lista se desplaza debajo
              <div className="space-y-1.5 border-b border-ink-100 p-2" role="search" aria-label="Buscar conversaciones">
                <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar conversación" etiqueta="Buscar conversaciones" />
                {(materiasEnLista.length > 1 || (materiasEnLista.length > 0 && sinMateria > 0) || materiaF !== '') && (
                  <select
                    className="input py-1 text-xs"
                    value={materiaF}
                    onChange={(e) => setMateriaF(e.target.value === '' || e.target.value === 'sin' ? (e.target.value as '' | 'sin') : Number(e.target.value))}
                    aria-label="Filtrar por materia"
                  >
                    <option value="">Todas las materias ({conversaciones.length})</option>
                    {materiasEnLista.map(([id, m]) => <option key={id} value={id}>{m.nombre} ({m.total})</option>)}
                    {sinMateria > 0 && <option value="sin">Sin materia ({sinMateria})</option>}
                  </select>
                )}
                {hayFiltro && (
                  <div className="flex items-center justify-between gap-2 px-1 text-xs text-ink-500">
                    <span>{listaConv.length} de {conversaciones.length}</span>
                    <button className="btn-fantasma text-xs py-0.5" onClick={quitarFiltros}>Quitar filtros</button>
                  </div>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {conversaciones.length === 0 && <p className="p-3 text-sm text-ink-500">Aún no hay conversaciones. Escribe abajo o pulsa «+ Nueva conversación».</p>}
              {conversaciones.length > 0 && listaConv.length === 0 && <SinResultados hayFiltro onLimpiar={quitarFiltros} vacio={null} />}
              {listaConv.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActual(c.id)}
                  aria-current={actual === c.id ? 'true' : undefined}
                  title={c.titulo}
                  className={`w-full text-left rounded-lg px-3 py-2 text-sm ${actual === c.id ? 'bg-brand-500 text-white' : 'hover:bg-ink-100 text-ink-700'}`}
                >
                  <div className="truncate font-medium">{c.titulo}</div>
                  <div className={`flex items-center gap-1.5 text-xs ${actual === c.id ? 'text-white/80' : 'text-ink-400'}`}>
                    <span className="min-w-0 truncate">{c.materia_nombre ?? 'Sin materia'}</span>
                    {c.actualizado && <span className="ml-auto shrink-0 whitespace-nowrap">{fmtFechaMx(c.actualizado, false)}</span>}
                  </div>
                </button>
              ))}
            </div>
          </nav>
        )}

        <section className="flex-[999_1_28rem] min-w-0 flex flex-col tarjeta min-h-[60vh]">
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="etiqueta">Materia</span>
              <select
                className="input w-auto"
                value={conv?.materia_id ?? ''}
                disabled={!conv}
                onChange={async (e) => {
                  if (!conv) return
                  await api.asistente.actualizar(conv.id, { materia_id: e.target.value ? Number(e.target.value) : null })
                  cargarLista(conv.id)
                }}
              >
                <option value="">Sin materia (pregunta general)</option>
                {materias.map((m) => (
                  <option key={m.id} value={m.id}>{m.nombre}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm" title="Solo con Claude: busca en internet y cita sus fuentes. Tarda más y cuesta un poco más.">
              <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Buscar en internet
            </label>
            {conv && <button className="btn-fantasma text-red-600 ml-auto" onClick={borrar}>Borrar conversación</button>}
          </div>

          <div ref={lista} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4" aria-live="off">
            {mensajes.length === 0 && escribiendo === null && (
              <div className="text-sm text-ink-500 space-y-3">
                <p>
                  {conv?.materia_nombre
                    ? <>Pregunta lo que quieras sobre <b>{conv.materia_nombre}</b>: la IA usa su temario y tus materiales.</>
                    : 'Elige una materia arriba para que la IA use su temario y tus materiales, o pregunta algo general.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGERENCIAS.map((s) => (
                    <button key={s} className="rounded-full border border-ink-200 px-3 py-1.5 text-left hover:bg-ink-50" onClick={() => setTexto(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {mensajes.map((m) => (
              <MensajeIA
                key={m.id}
                m={m}
                dep={conv?.materia_id}
                acciones={
                  m.rol === 'asistente' ? (
                    <>
                      <button className="btn-fantasma text-xs" onClick={() => navigator.clipboard.writeText(m.contenido).then(() => avisar('Copiado'))}>Copiar</button>
                      <button className="btn-fantasma text-xs" onClick={() => guardarEnMateria(m)} title="Se guarda como apuntes de la materia: lo puedes exportar a PDF o Word, o publicarlo">Guardar en la materia</button>
                      {primerCodigo(m.contenido) && <button className="btn-fantasma text-xs" onClick={() => aProgramar(m)}>Abrir el código en Programar</button>}
                    </>
                  ) : undefined
                }
              />
            ))}
            {escribiendo !== null && <RespuestaEnVivo texto={escribiendo} etiqueta={web ? 'Buscando y pensando…' : 'Pensando…'} />}
            {sinRespuesta && <SinRespuesta error={error} onReintentar={() => reintentar({ web })} />}
            <div ref={fin} />
          </div>

          <form
            className="border-t border-ink-100 p-3 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              enviar()
            }}
          >
            <textarea
              ref={caja}
              className="input flex-1 resize-none min-h-[44px] max-h-48"
              rows={Math.min(8, Math.max(2, texto.split('\n').length))}
              value={texto}
              placeholder={disponible === false ? 'Configura la IA en Ajustes para conversar' : 'Escribe tu mensaje… (Enter envía, Shift + Enter hace un salto de línea)'}
              aria-label="Tu mensaje"
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  enviar()
                }
              }}
            />
            {escribiendo !== null ? (
              <button type="button" className="btn-peligro" onClick={detener}>■ Detener</button>
            ) : (
              <button type="submit" className="btn-primario" disabled={!texto.trim() || disponible === false}>Enviar</button>
            )}
          </form>
        </section>
      </div>
    </div>
  )
}
