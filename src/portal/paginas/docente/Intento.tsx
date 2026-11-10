import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, descargar, duracion, fechaMx, segundosEntre } from '../../lib/api'
import { calificacionExamen } from '../../lib/calificacion'
import { Boton, Campo, Cargando, Chip, Estadistica, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import Markdown from '../../componentes/Markdown'
import Codigo from '../../componentes/Codigo'
import type { ArchivoEntrega, Asignacion, EventoIntegridad, Intento as IntentoBase } from '@shared/portal'
import { AreaTexto, ChipEstado, ETIQUETA_EVENTO, ETIQUETA_TIPO_PREGUNTA, ErrorServidor, numeroOSinDatos } from './comun'

const EditorCuaderno = lazy(() => import('../../componentes/EditorCuaderno'))

/** Espejo de `IntentoDetallado` del servidor (src/servidor/servicios.ts). */
interface PreguntaRevisada {
  indice: number
  tipo: string
  enunciado: string
  opciones: string[]
  respuesta_correcta: string
  explicacion: string
  puntos: number
  respuesta_alumno: string
  /** Calculados en el servidor con la misma regla que califica. */
  indice_correcto: number
  indice_alumno: number
  correcta: boolean | null
  automatica: boolean
  lenguaje?: 'python' | 'javascript'
  /** Pregunta de cuaderno: el .ipynb con el que empezó el alumno */
  cuaderno?: string
}

interface IntentoDetallado extends IntentoBase {
  asignacion: Asignacion
  preguntas: PreguntaRevisada[]
  eventos_lista: EventoIntegridad[]
  archivos: ArchivoEntrega[]
}

function tamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** El cuaderno como lo dejó el alumno (código, respuestas y salidas), para leerlo o descargarlo y abrirlo en Jupyter. */
function CuadernoDelAlumno({ p, nombre }: { p: PreguntaRevisada; nombre: string }): JSX.Element {
  const intacto = !p.respuesta_alumno.trim()
  let nb: { cells: unknown[] } | null = null
  try {
    nb = JSON.parse(intacto ? (p.cuaderno ?? '') : p.respuesta_alumno)
  } catch {
    nb = null
  }
  const archivo = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '')
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">{intacto ? 'El alumno no cambió el cuaderno: así se le entregó' : 'Cuaderno del alumno'}</div>
      {nb && Array.isArray(nb.cells) ? (
        <Suspense fallback={<Cargando texto="Abriendo el cuaderno…" />}>
          <EditorCuaderno inicial={nb as never} cerrado nombreArchivo={archivo || 'cuaderno'} />
        </Suspense>
      ) : (
        <div className="text-sm italic text-ink-400">No se pudo leer el cuaderno.</div>
      )}
    </div>
  )
}

/** Revisión de la entrega de un alumno: integridad, archivos, respuestas y calificación. */
export default function Intento(): JSX.Element {
  const { id } = useParams()
  const intentoId = Number(id)
  const [intento, setIntento] = useState<IntentoDetallado | null>(null)
  const [error, setError] = useState('')
  const [puntaje, setPuntaje] = useState('')
  const [retro, setRetro] = useState('')
  const [errorForma, setErrorForma] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [descargando, setDescargando] = useState<number | null>(null)

  const cargar = async (): Promise<void> => {
    try {
      const i = await api<IntentoDetallado>(`/docente/intentos/${intentoId}`)
      setIntento(i)
      setPuntaje(i.puntaje !== null ? String(i.puntaje) : i.puntaje_auto !== null ? String(i.puntaje_auto) : '')
      setRetro(i.retro ?? '')
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    setIntento(null)
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentoId])

  const calificar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!intento) return
    const n = Number(puntaje)
    const maximo = intento.asignacion.puntos_totales ?? Infinity
    if (puntaje.trim() === '' || !Number.isFinite(n)) return setErrorForma('Escribe el puntaje.')
    if (n < 0 || n > maximo) return setErrorForma(`El puntaje debe estar entre 0 y ${maximo}.`)
    setErrorForma('')
    setGuardando(true)
    try {
      await api(`/docente/intentos/${intentoId}/calificar`, { metodo: 'PUT', cuerpo: { puntaje: n, retro } })
      avisar(intento.asignacion.mostrar_resultado ? 'Calificación guardada y notificada al alumno' : 'Calificación guardada (el alumno no ve el puntaje)')
      await cargar()
    } catch (err) {
      setErrorForma((err as Error).message)
    } finally {
      setGuardando(false)
    }
  }

  const bajar = async (a: ArchivoEntrega): Promise<void> => {
    setDescargando(a.id)
    try {
      await descargar(`/archivos/${a.id}`, a.nombre)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setDescargando(null)
    }
  }

  if (!intento && !error) return <Cargando texto="Cargando entrega…" />
  if (!intento) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <ErrorServidor texto={error} />
        <Vacio titulo="No encontramos esa entrega" />
        <Link to="/docente/entregas" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-600">← Todas las entregas</Link>
      </div>
    )
  }

  const a = intento.asignacion
  const enviado = intento.estado === 'enviado' || intento.estado === 'calificado'
  const puntosAuto = intento.preguntas.filter((p) => p.automatica).reduce((t, p) => t + p.puntos, 0)
  const puntosManuales = intento.preguntas.filter((p) => !p.automatica).reduce((t, p) => t + p.puntos, 0)
  // La calificación vigente (la final si ya se calificó; si no, la automática) sobre 10 y su peso en el parcial
  const puntajeVigente = intento.puntaje ?? intento.puntaje_auto
  const cal = calificacionExamen(puntajeVigente, a.puntos_totales, a.ponderacion)
  // Mientras se escribe el puntaje en el formulario
  const calForma = calificacionExamen(puntaje.trim() === '' ? null : Number(puntaje), a.puntos_totales, a.ponderacion)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to={`/docente/asignaciones/${a.id}`} className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← Entregas de "{a.titulo}"</Link>

      <Tarjeta className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-bold leading-snug text-ink-900">{intento.alumno_nombre}</h2>
            <p className="font-mono text-xs text-ink-500">{intento.alumno_matricula}</p>
          </div>
          <ChipEstado estado={intento.estado} />
        </div>
        <p className="text-sm text-ink-600">
          <span className="font-semibold">{a.titulo}</span> · {a.materia_nombre} · {a.puntos_totales ?? '—'} pts
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Estadistica valor={<span className="text-sm">{fechaMx(intento.iniciado_en)}</span>} etiqueta="iniciado" />
          <Estadistica valor={<span className="text-sm">{intento.enviado_en ? fechaMx(intento.enviado_en) : '—'}</span>} etiqueta="enviado" />
          <Estadistica valor={<span className="text-sm">{intento.enviado_en ? duracion(segundosEntre(intento.iniciado_en, intento.enviado_en) ?? 0) : `lleva ${duracion(segundosEntre(intento.iniciado_en) ?? 0)}`}</span>} etiqueta="tardó en contestar" />
          <Estadistica valor={<span className="text-sm">{duracion(intento.tiempo_activo_seg)}</span>} etiqueta="tiempo activo" />
          <Estadistica valor={<span className={`text-sm ${intento.eventos_lista.length ? 'text-red-600' : ''}`}>{intento.eventos_lista.length}</span>} etiqueta="alertas de integridad" />
        </div>
        {enviado && cal ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-ink-200 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Calificación del examen</div>
              <div className={`mt-0.5 text-3xl font-bold tabular-nums ${cal.sobre10 >= 8 ? 'text-emerald-600' : cal.sobre10 >= 6 ? 'text-amber-600' : 'text-red-600'}`}>
                {cal.sobre10.toFixed(1)} <span className="text-base font-medium text-ink-400">/ 10</span>
              </div>
              <div className="text-xs text-ink-500">
                {numeroOSinDatos(puntajeVigente, 2)} de {a.puntos_totales} pts{intento.puntaje === null ? ' (automático)' : ''}
                {intento.pendiente_manual && intento.puntaje === null ? ' · faltan las abiertas' : ''}
              </div>
            </div>
            <div className="rounded-xl border border-ink-200 px-4 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">En el parcial</div>
              {cal.aporte !== null ? (
                <>
                  <div className="mt-0.5 text-3xl font-bold tabular-nums text-ink-900">
                    {cal.aporte.toFixed(2)} <span className="text-base font-medium text-ink-400">de {cal.maximo.toFixed(1)}</span>
                  </div>
                  <div className="text-xs text-ink-500">
                    Vale {cal.ponderacion} %: {cal.sobre10.toFixed(1)} × {cal.ponderacion} % = {cal.aporte.toFixed(2)}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-sm text-ink-500">Sin ponderación. Ponla en Entregas › «Vale en el parcial (%)».</div>
              )}
            </div>
          </div>
        ) : null}
        {!enviado && <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">El alumno aún no envía esta entrega: lo que ves son sus respuestas guardadas hasta ahora. Podrás calificar cuando la envíe.</div>}
      </Tarjeta>

      {intento.eventos_lista.length > 0 && (
        <Tarjeta>
          <h3 className="font-semibold text-ink-900">Línea de tiempo de integridad</h3>
          <p className="mb-3 text-xs text-ink-500">Lo que registró el navegador del alumno mientras trabajaba{a.vigilancia ? ' (actividad con vigilancia)' : ''}.</p>
          <ol className="space-y-2 border-l-2 border-ink-100 pl-4">
            {intento.eventos_lista.map((ev) => {
              const grave = ev.tipo === 'cerrado_por_salidas' || ev.tipo === 'captura_pantalla' || ev.tipo === 'salio_pestana' || ev.tipo === 'perdio_foco' || ev.tipo === 'salio_pantalla_completa' || ev.tipo === 'pegar'
              return (
                <li key={ev.id} className="relative text-sm">
                  <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ${grave ? 'bg-red-500' : 'bg-ink-300'}`} />
                  <span className="font-mono text-xs text-ink-400">{fechaMx(ev.en)}</span>{' '}
                  <span className={grave ? 'font-medium text-red-700' : 'text-ink-700'}>{ETIQUETA_EVENTO[ev.tipo] ?? ev.tipo}</span>
                  {ev.detalle && <span className="break-words text-ink-400"> · {ev.detalle}</span>}
                </li>
              )
            })}
          </ol>
        </Tarjeta>
      )}

      {intento.archivos.length > 0 && (
        <Tarjeta>
          <h3 className="mb-2 font-semibold text-ink-900">Archivos entregados ({intento.archivos.length})</h3>
          <ul className="divide-y divide-ink-100">
            {intento.archivos.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink-900">{f.nombre}</div>
                  <div className="text-xs text-ink-500">
                    {tamano(f.tamano)} · {fechaMx(f.subido_en)}
                  </div>
                </div>
                <Boton variante="secundario" className="shrink-0 px-3" onClick={() => bajar(f)} disabled={descargando === f.id}>
                  {descargando === f.id ? '…' : '⬇ Descargar'}
                </Boton>
              </li>
            ))}
          </ul>
        </Tarjeta>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-ink-900">Respuestas ({intento.preguntas.length})</h3>
          <span className="text-xs text-ink-500">
            Automático: {numeroOSinDatos(intento.puntaje_auto, 2)} de {puntosAuto} pts{puntosManuales ? ` · ${puntosManuales} pts a revisar a mano` : ''}
          </span>
        </div>
        {intento.preguntas.length === 0 && <Vacio titulo="Esta evaluación no tiene preguntas" />}
        {intento.preguntas.map((p) => (
          <Tarjeta key={p.indice} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-bold text-ink-400">#{p.indice + 1}</span>
              <Chip>{ETIQUETA_TIPO_PREGUNTA[p.tipo] ?? p.tipo}</Chip>
              <Chip tono="morado">{p.puntos} {p.puntos === 1 ? 'pt' : 'pts'}</Chip>
              {p.automatica && (p.correcta ? <Chip tono="verde">✓ Correcta</Chip> : <Chip tono="rojo">✗ Incorrecta</Chip>)}
              {!p.automatica && p.respuesta_alumno.trim() && <Chip tono="ambar">Revisión manual</Chip>}
            </div>
            <Markdown texto={p.enunciado} />

            {p.opciones.length > 0 ? (
              <ul className="space-y-1.5">
                {p.opciones.map((op, i) => {
                  const elegida = i === p.indice_alumno
                  const clave = i === p.indice_correcto
                  const estilo = elegida && clave ? 'border-green-400 bg-green-50' : elegida ? 'border-red-300 bg-red-50' : clave ? 'border-green-300 bg-green-50/50' : 'border-ink-200'
                  return (
                    <li key={i} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${estilo}`}>
                      <span className="w-5 shrink-0 text-center">{elegida ? '●' : clave ? '○' : ''}</span>
                      <span className="min-w-0 flex-1 break-words">
                        <span className="mr-1 font-mono text-xs text-ink-400">{String.fromCharCode(97 + i)})</span>
                        <Markdown texto={op} enLinea />
                      </span>
                      {elegida && <span className="shrink-0 text-xs text-ink-500">alumno</span>}
                      {clave && <span className="shrink-0 text-xs text-green-700">correcta</span>}
                    </li>
                  )
                })}
              </ul>
            ) : p.tipo === 'cuaderno' ? (
              <CuadernoDelAlumno p={p} nombre={`${intento.asignacion.titulo}_${intento.alumno_nombre ?? 'alumno'}`} />
            ) : p.tipo === 'codigo' && p.respuesta_alumno.trim() ? (
              // El código del alumno se puede correr aquí mismo para revisarlo
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">Código del alumno</div>
                <Codigo valor={p.respuesta_alumno} soloLectura revision lenguaje={p.lenguaje} pistas={[p.enunciado, p.respuesta_correcta]} />
              </div>
            ) : (
              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-sky-700">Respuesta del alumno</div>
                {p.respuesta_alumno.trim() ? <Markdown texto={p.respuesta_alumno} /> : <span className="text-sm italic text-ink-400">Sin respuesta</span>}
              </div>
            )}
            {p.opciones.length > 0 && !p.respuesta_alumno.trim() && <div className="text-sm italic text-ink-400">El alumno no eligió ninguna opción.</div>}

            {(p.opciones.length === 0 || p.indice_correcto < 0) && p.respuesta_correcta && (
              <div className="rounded-xl bg-green-50 p-3">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-green-700">Respuesta esperada</div>
                <Markdown texto={p.respuesta_correcta} />
              </div>
            )}
            {p.explicacion && (
              <details className="text-sm">
                <summary className="min-h-[44px] cursor-pointer select-none py-2 text-ink-500">Explicación</summary>
                <Markdown texto={p.explicacion} className="text-ink-600" />
              </details>
            )}
          </Tarjeta>
        ))}
      </section>

      {enviado ? (
        <Tarjeta>
          <form onSubmit={calificar} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold text-ink-900">{intento.estado === 'calificado' ? 'Ajustar calificación' : 'Calificar'}</h3>
              {intento.calificado_en && <span className="text-xs text-ink-500">calificada {fechaMx(intento.calificado_en)}</span>}
            </div>
            {intento.pendiente_manual ? <p className="text-sm text-amber-700">Hay respuestas abiertas por revisar. El puntaje sugerido solo cuenta las preguntas automáticas.</p> : null}
            <Campo etiqueta={`Puntaje (máximo ${a.puntos_totales ?? '—'})`} type="number" inputMode="decimal" min={0} max={a.puntos_totales ?? undefined} step="0.5" value={puntaje} onChange={(e) => setPuntaje(e.target.value)} required />
            {calForma ? (
              <p className="text-sm text-ink-600">
                = <b>{calForma.sobre10.toFixed(1)} / 10</b>
                {calForma.aporte !== null ? (
                  <>
                    {' '}· en el parcial <b>{calForma.aporte.toFixed(2)} de {calForma.maximo.toFixed(1)}</b> ({calForma.ponderacion} %)
                  </>
                ) : null}
              </p>
            ) : null}
            <AreaTexto etiqueta="Retroalimentación" value={retro} onChange={(e) => setRetro(e.target.value)} rows={4} maxLength={4000} placeholder="Qué hizo bien, qué debe repasar…" />
            <ErrorServidor texto={errorForma} />
            <Boton type="submit" className="w-full" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar calificación'}</Boton>
          </form>
        </Tarjeta>
      ) : (
        <Vacio titulo="Aún no se puede calificar" detalle="El alumno todavía no envía la entrega." />
      )}
    </div>
  )
}
