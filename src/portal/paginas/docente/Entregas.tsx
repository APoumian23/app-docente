import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, descargar, duracion, fechaMx, segundosEntre } from '../../lib/api'
import { calificacionExamen } from '../../lib/calificacion'
import { Boton, Campo, Cargando, Chip, Estadistica, Modal, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import type { Asignacion, MostrarRespuestas, ResumenEntregas } from '@shared/portal'
import { ChipEstado, ErrorServidor, OPCIONES_RESPUESTAS, Selector, aIsoDia, numeroOSinDatos, partesMx, type EstadoEntrega, type MateriaDocente } from './comun'

/** Una fila de la tabla: inscrito con o sin intento. Solo hay `id` cuando el alumno ya empezó. */
interface FilaEntrega {
  id?: number
  alumno_id: number
  alumno_nombre: string
  alumno_matricula: string
  estado: EstadoEntrega
  enviado_en?: string | null
  iniciado_en?: string
  tiempo_activo_seg?: number
  eventos?: number
  fuera?: boolean
  desbloqueado?: number
  puntaje?: number | null
  pendiente_manual?: number
}

type Rango = 'hoy' | 'semana' | 'mes' | 'todo' | 'personalizado'
const RANGOS: { clave: Rango; texto: string }[] = [
  { clave: 'hoy', texto: 'Hoy' },
  { clave: 'semana', texto: 'Esta semana' },
  { clave: 'mes', texto: 'Este mes' },
  { clave: 'todo', texto: 'Todo el periodo' },
  { clave: 'personalizado', texto: 'Personalizado' }
]

/** Con :id muestra las entregas de una actividad; sin él, el listado filtrable de todo lo publicado. */
export default function Entregas(): JSX.Element {
  const { id } = useParams()
  return id ? <EntregasDeAsignacion asignacionId={Number(id)} /> : <ListadoEntregas />
}

// ---------------- Listado con filtros ----------------

function calcularRango(rango: Rango, desdeManual: string, hastaManual: string): { desde?: string; hasta?: string } {
  const p = partesMx()
  const hoy = aIsoDia(p.anio, p.mes, p.dia)
  if (rango === 'hoy') return { desde: hoy, hasta: hoy }
  if (rango === 'semana') {
    const lunes = p.dia - ((p.diaSemana + 6) % 7)
    return { desde: aIsoDia(p.anio, p.mes, lunes), hasta: aIsoDia(p.anio, p.mes, lunes + 6) }
  }
  if (rango === 'mes') return { desde: aIsoDia(p.anio, p.mes, 1), hasta: aIsoDia(p.anio, p.mes + 1, 0) }
  if (rango === 'personalizado') return { desde: desdeManual || undefined, hasta: hastaManual || undefined }
  return {}
}

function ListadoEntregas(): JSX.Element {
  const [materias, setMaterias] = useState<MateriaDocente[]>([])
  const [materiaId, setMateriaId] = useState(0)
  const [rango, setRango] = useState<Rango>('todo')
  const [desdeManual, setDesdeManual] = useState('')
  const [hastaManual, setHastaManual] = useState('')
  const [lista, setLista] = useState<ResumenEntregas[] | null>(null)
  const [error, setError] = useState('')
  const [exportando, setExportando] = useState(false)

  const filtros = useMemo(() => {
    const { desde, hasta } = calcularRango(rango, desdeManual, hastaManual)
    const q = new URLSearchParams()
    if (materiaId) q.set('materia_id', String(materiaId))
    if (desde) q.set('desde', desde)
    if (hasta) q.set('hasta', hasta)
    return q.toString()
  }, [materiaId, rango, desdeManual, hastaManual])

  useEffect(() => {
    api<MateriaDocente[]>('/docente/materias')
      .then(setMaterias)
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    let vigente = true
    setLista(null)
    api<ResumenEntregas[]>(`/docente/asignaciones${filtros ? `?${filtros}` : ''}`)
      .then((r) => vigente && setLista(r))
      .catch((e: Error) => {
        if (!vigente) return
        setError(e.message)
        setLista([])
      })
    return () => {
      vigente = false
    }
  }, [filtros])

  const exportar = async (): Promise<void> => {
    setExportando(true)
    try {
      await descargar(`/docente/entregas/exportar${filtros ? `?${filtros}` : ''}`, 'entregas.xlsx')
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setExportando(false)
    }
  }

  const totales = (lista ?? []).reduce((t, r) => ({ entregados: t.entregados + r.entregados, pendientes: t.pendientes + r.pendientes_manual }), { entregados: 0, pendientes: 0 })

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-ink-900">Entregas</h2>
        <Boton variante="secundario" onClick={exportar} disabled={exportando || !lista?.length}>
          {exportando ? 'Generando…' : '⬇ Exportar Excel'}
        </Boton>
      </div>

      <Tarjeta className="space-y-3">
        <Selector etiqueta="Materia" value={materiaId} onChange={(e) => setMateriaId(Number(e.target.value))}>
          <option value={0}>Todas las materias</option>
          {materias.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nombre}{m.oculta ? ' (oculta)' : ''}
            </option>
          ))}
        </Selector>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Publicadas</div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {RANGOS.map((r) => (
              <button
                key={r.clave}
                type="button"
                onClick={() => setRango(r.clave)}
                className={`min-h-[44px] shrink-0 rounded-xl border px-3 text-sm font-semibold ${rango === r.clave ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'}`}
              >
                {r.texto}
              </button>
            ))}
          </div>
        </div>
        {rango === 'personalizado' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo etiqueta="Desde" type="date" value={desdeManual} onChange={(e) => setDesdeManual(e.target.value)} max={hastaManual || undefined} />
            <Campo etiqueta="Hasta" type="date" value={hastaManual} onChange={(e) => setHastaManual(e.target.value)} min={desdeManual || undefined} />
          </div>
        )}
      </Tarjeta>

      <ErrorServidor texto={error} />

      {lista === null ? (
        <Cargando texto="Buscando entregas…" />
      ) : lista.length === 0 ? (
        <Vacio titulo="No hay actividades publicadas en este rango" detalle="Cambia el filtro o publica una evaluación desde alguna materia." />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Estadistica valor={lista.length} etiqueta={lista.length === 1 ? 'actividad' : 'actividades'} />
            <Estadistica valor={totales.entregados} etiqueta="entregas" />
            <Estadistica valor={<span className={totales.pendientes ? 'text-amber-600' : ''}>{totales.pendientes}</span>} etiqueta="por revisar" />
          </div>
          <div className="space-y-3">
            {lista.map((r) => (
              <Link key={r.asignacion.id} to={`/docente/asignaciones/${r.asignacion.id}`} className="block rounded-2xl border border-ink-200 bg-white p-4 shadow-sm transition hover:border-brand-400">
                <div className="flex items-start gap-3">
                  <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: r.asignacion.materia_color || '#2d6df6' }} />
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-semibold leading-snug text-ink-900">{r.asignacion.titulo}</div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {r.asignacion.materia_nombre} · publicada {fechaMx(r.asignacion.publicada_en)}
                      {r.asignacion.cierra ? ` · cierra ${fechaMx(r.asignacion.cierra)}` : ''}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-700">
                      {r.asignacion.activa ? <Chip tono="verde">Abierta</Chip> : <Chip tono="rojo">Cerrada</Chip>}
                      <span>
                        <span className="font-semibold">{r.entregados}</span>/{r.inscritos} entregados
                      </span>
                      {r.pendientes_manual > 0 && <Chip tono="ambar">{r.pendientes_manual} por revisar</Chip>}
                      <span className="text-ink-500">
                        promedio {numeroOSinDatos(r.promedio)}{r.asignacion.puntos_totales ? ` / ${r.asignacion.puntos_totales}` : ''}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------- Entregas de una asignación ----------------

function EntregasDeAsignacion({ asignacionId }: { asignacionId: number }): JSX.Element {
  const [datos, setDatos] = useState<{ asignacion: Asignacion; entregas: FilaEntrega[] } | null>(null)
  const [error, setError] = useState('')
  const [cambiando, setCambiando] = useState(false)
  const nav = useNavigate()
  // Eliminar la publicación: ventana de confirmación; con entregas hay que marcar que se entiende que se borran
  const [eliminar, setEliminar] = useState(false)
  const [entiendo, setEntiendo] = useState(false)

  const cargar = async (): Promise<void> => {
    try {
      setDatos(await api<{ asignacion: Asignacion; entregas: FilaEntrega[] }>(`/docente/asignaciones/${asignacionId}/entregas`))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    setDatos(null)
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asignacionId])
  // En vivo mientras la actividad está abierta: quién empezó, quién salió de la pantalla, quién ya envió
  const abiertaAhora = Boolean(datos?.asignacion.activa)
  useEffect(() => {
    if (!abiertaAhora) return
    const t = window.setInterval(() => void cargar(), 5000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abiertaAhora, asignacionId])

  const eliminarPublicacion = async (): Promise<void> => {
    setCambiando(true)
    try {
      const r = await api<{ intentos: number; archivos: number }>(`/docente/asignaciones/${asignacionId}`, { metodo: 'DELETE' })
      avisar(r.intentos ? `Publicación eliminada con ${r.intentos} ${r.intentos === 1 ? 'entrega' : 'entregas'}` : 'Publicación eliminada')
      nav('/docente/entregas')
    } catch (e) {
      avisar((e as Error).message, 'error')
      setCambiando(false)
    }
  }
  const alternarBloqueo = async (): Promise<void> => {
    if (!datos) return
    const bloquear = !datos.asignacion.bloqueo
    setCambiando(true)
    try {
      const a = await api<Asignacion>(`/docente/asignaciones/${asignacionId}`, { metodo: 'PATCH', cuerpo: { bloqueo: bloquear } })
      setDatos({ ...datos, asignacion: a })
      avisar(bloquear ? 'Pantalla bloqueada para todo el grupo' : 'Pantalla desbloqueada para todo el grupo')
      void cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setCambiando(false)
    }
  }
  /** Lo que ve el alumno al terminar: se puede cambiar con entregas ya hechas (lo ven al volver a abrirla) */
  const ajustar = async (cuerpo: { mostrar_resultado?: boolean; mostrar_respuestas?: MostrarRespuestas; ponderacion?: number }, aviso: string): Promise<void> => {
    if (!datos) return
    setCambiando(true)
    try {
      const a = await api<Asignacion>(`/docente/asignaciones/${asignacionId}`, { metodo: 'PATCH', cuerpo })
      setDatos({ ...datos, asignacion: a })
      avisar(aviso)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setCambiando(false)
    }
  }
  const alternarAlumno = async (e: FilaEntrega): Promise<void> => {
    if (!e.id) return
    try {
      await api(`/docente/intentos/${e.id}/desbloqueo`, { metodo: 'PATCH', cuerpo: { desbloqueado: !e.desbloqueado } })
      avisar(e.desbloqueado ? `${e.alumno_nombre}: bloqueado de nuevo` : `${e.alumno_nombre}: desbloqueado`)
      void cargar()
    } catch (err) {
      avisar((err as Error).message, 'error')
    }
  }

  const alternarActiva = async (): Promise<void> => {
    if (!datos) return
    const abrir = !datos.asignacion.activa
    if (!abrir && !window.confirm('¿Cerrar la actividad ahora? Los alumnos que no hayan enviado ya no podrán hacerlo.')) return
    setCambiando(true)
    try {
      const a = await api<Asignacion>(`/docente/asignaciones/${asignacionId}`, { metodo: 'PATCH', cuerpo: { activa: abrir } })
      setDatos({ ...datos, asignacion: a })
      avisar(abrir ? 'Actividad reabierta' : 'Actividad cerrada')
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setCambiando(false)
    }
  }

  if (!datos && !error) return <Cargando texto="Cargando entregas…" />
  if (!datos) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <ErrorServidor texto={error} />
        <Link to="/docente/entregas" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-600">← Todas las entregas</Link>
      </div>
    )
  }

  const { asignacion: a, entregas } = datos
  const entregados = entregas.filter((e) => e.estado === 'enviado' || e.estado === 'calificado').length
  const porRevisar = entregas.filter((e) => e.estado === 'enviado' && e.pendiente_manual).length
  const fueraAhora = entregas.filter((e) => e.fuera).length
  const conIntento = entregas.filter((e) => e.id).length
  const cerradaPorFecha = Boolean(a.cierra && new Date(a.cierra.replace(' ', 'T') + 'Z') < new Date())
  // La columna de bloqueo solo sirve mientras el examen sigue abierto
  const bloqueoVivo = Boolean(a.bloqueo && a.activa && !cerradaPorFecha)

  // Celdas que comparten la tabla (pantallas anchas) y las tarjetas (celular y tablet)
  const tiempoDe = (e: FilaEntrega): JSX.Element | string => {
    if (!e.id || !e.iniciado_en) return '—'
    if (!e.enviado_en) return <span className="text-amber-700">lleva {duracion(segundosEntre(e.iniciado_en) ?? 0)}</span>
    return (
      <span title="Debajo: solo el tiempo con el examen a la vista">
        {duracion(segundosEntre(e.iniciado_en, e.enviado_en) ?? 0)}
        <span className="block text-xs text-ink-400">activo {duracion(e.tiempo_activo_seg ?? 0)}</span>
      </span>
    )
  }
  const integridadDe = (e: FilaEntrega): JSX.Element | string => (
    <span className="inline-flex flex-wrap items-center gap-1">
      {e.fuera ? <Chip tono="rojo">Fuera ahora</Chip> : null}
      {(e.eventos ?? 0) > 0 ? <Chip tono="ambar">{e.eventos} {e.eventos === 1 ? 'evento' : 'eventos'}</Chip> : e.id ? <span className="whitespace-nowrap text-ink-300">sin alertas</span> : '—'}
    </span>
  )
  const bloqueoDe = (e: FilaEntrega): JSX.Element =>
    e.id && (e.estado === 'en_curso' || e.estado === 'borrador') ? (
      <button type="button" className={`inline-flex min-h-[36px] items-center rounded-lg px-2.5 text-xs font-semibold ${e.desbloqueado ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-ink-100 text-ink-700 hover:bg-ink-200'}`} onClick={() => void alternarAlumno(e)} title={e.desbloqueado ? 'Volver a bloquear a este alumno' : 'Quitar el bloqueo solo a este alumno'}>
        {e.desbloqueado ? '🔓 Desbloqueado' : '🔒 Bloqueado'}
      </button>
    ) : e.estado === 'enviado' || e.estado === 'calificado' ? (
      <span className="text-xs text-ink-400">Libre (envió)</span>
    ) : (
      <span className="text-xs text-ink-400">—</span>
    )
  const puntajeDe = (e: FilaEntrega): JSX.Element | string =>
    e.puntaje !== null && e.puntaje !== undefined ? `${numeroOSinDatos(e.puntaje, 2)} / ${a.puntos_totales ?? '—'}` : e.estado === 'enviado' ? <span className="font-normal text-amber-600">pendiente</span> : '—'
  const califDe = (e: FilaEntrega): JSX.Element | null => {
    const c = calificacionExamen(e.puntaje, a.puntos_totales)
    if (!c) return null
    return <span className={`font-bold tabular-nums ${c.sobre10 >= 8 ? 'text-emerald-600' : c.sobre10 >= 6 ? 'text-amber-600' : 'text-red-600'}`}>{c.sobre10.toFixed(1)}</span>
  }
  const revisarDe = (e: FilaEntrega): JSX.Element | null =>
    e.id ? (
      <Link to={`/docente/intentos/${e.id}`} className="inline-flex min-h-[44px] items-center rounded-xl px-3 text-sm font-semibold text-brand-600 hover:bg-brand-500/10">
        Revisar
      </Link>
    ) : null

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Link to="/docente/entregas" className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← Todas las entregas</Link>

      <Tarjeta className="space-y-3">
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: a.materia_color || '#2d6df6' }} />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-xl font-bold leading-snug text-ink-900">{a.titulo}</h2>
            <p className="text-sm text-ink-500">
              <Link to={`/docente/materias/${a.materia_id}?pestana=publicadas`} className="hover:underline">{a.materia_nombre}</Link> · {a.puntos_totales ?? '—'} pts
            </p>
          </div>
        </div>
        <div className="grid gap-2 text-sm text-ink-700 sm:grid-cols-2">
          <div>
            <span className="text-ink-400">Abre:</span> {fechaMx(a.abre)}
          </div>
          <div>
            <span className="text-ink-400">Cierra:</span> {a.cierra ? fechaMx(a.cierra) : 'sin fecha límite'}
          </div>
          <div>
            <span className="text-ink-400">Duración:</span> {a.duracion_min ? `${a.duracion_min} min` : 'sin límite'}
          </div>
          <div>
            <span className="text-ink-400">Publicada:</span> {fechaMx(a.publicada_en)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {a.activa ? cerradaPorFecha ? <Chip tono="rojo">Cerrada por fecha</Chip> : <Chip tono="verde">Abierta</Chip> : <Chip tono="rojo">Cerrada por el docente</Chip>}
          {a.azar ? <Chip tono="azul">🎲 Preguntas al azar por alumno</Chip> : null}
          {a.todas_obligatorias ? <Chip tono="azul">✅ Contestar todas para enviar</Chip> : null}
          {a.para?.length ? <Chip tono="morado">Solo para {a.para.length} {a.para.length === 1 ? 'alumno' : 'alumnos'}</Chip> : null}
          {a.bloqueo ? <Chip tono="rojo">🔒 Pantalla bloqueada</Chip> : null}
          {a.vigilancia ? <Chip tono="rojo">Vigilancia</Chip> : null}
          {a.permite_borrador ? <Chip tono="azul">Borrador</Chip> : null}
          {a.permite_archivos ? <Chip tono="azul">Archivos</Chip> : null}
          {!a.mostrar_resultado && <Chip>Resultado oculto</Chip>}
        </div>
        {a.instrucciones && <p className="whitespace-pre-wrap break-words text-sm text-ink-600">{a.instrucciones}</p>}
        <div className="space-y-2 rounded-xl border border-ink-200 bg-ink-50/60 p-3">
          <div className="text-sm font-semibold text-ink-800">Lo que ve el alumno al terminar</div>
          <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_10rem] sm:items-end">
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                className="h-5 w-5 accent-brand-500"
                checked={Boolean(a.mostrar_resultado)}
                disabled={cambiando}
                onChange={(e) => void ajustar({ mostrar_resultado: e.target.checked }, e.target.checked ? 'Los alumnos ya ven su calificación' : 'Calificación oculta para los alumnos')}
              />
              Su calificación
            </label>
            <Selector
              etiqueta="Respuestas correctas e incorrectas"
              value={a.mostrar_respuestas ?? 'al_cerrar'}
              disabled={cambiando || !a.mostrar_resultado}
              onChange={(e) => void ajustar({ mostrar_respuestas: e.target.value as MostrarRespuestas }, 'Guardado: los alumnos lo ven al volver a abrir su examen')}
            >
              {OPCIONES_RESPUESTAS.map(([v, t]) => (
                <option key={v} value={v}>{t}</option>
              ))}
            </Selector>
            <Campo
              key={`pond-${a.ponderacion ?? 0}`}
              etiqueta="Vale en el parcial (%)"
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step="any"
              defaultValue={a.ponderacion ? String(a.ponderacion) : ''}
              placeholder="0"
              disabled={cambiando || !a.mostrar_resultado}
              onBlur={(e) => {
                const n = Number(e.target.value || 0)
                if (n !== (a.ponderacion ?? 0)) void ajustar({ ponderacion: n }, n ? `Ponderación: ${n} % del parcial` : 'Sin ponderación')
              }}
            />
          </div>
          {a.mostrar_resultado && (a.mostrar_respuestas ?? 'al_cerrar') === 'al_cerrar' && a.activa && !cerradaPorFecha ? (
            <p className="text-xs text-ink-500">Las respuestas se muestran cuando cierre (por fecha o con «Cerrar ahora»), para que nadie se las pase a quien sigue contestando.</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Boton variante={a.activa ? 'peligro' : 'primario'} onClick={alternarActiva} disabled={cambiando}>
            {cambiando ? 'Guardando…' : a.activa ? 'Cerrar ahora' : 'Reabrir'}
          </Boton>
          <Boton
            variante="fantasma"
            className="text-red-700 hover:bg-red-50"
            onClick={() => {
              setEntiendo(false)
              setEliminar(true)
            }}
            disabled={cambiando}
          >
            🗑 Eliminar publicación
          </Boton>
          {a.activa ? (
            <Boton variante={a.bloqueo ? 'secundario' : 'primario'} onClick={alternarBloqueo} disabled={cambiando} title={a.bloqueo ? 'Todos pueden salir de pantalla completa y usar el portal; el examen sigue abierto hasta que lo envíen' : 'Todos quedan en el examen y en pantalla completa hasta enviarlo'}>
              {a.bloqueo ? '🔓 Desbloquear a todos' : '🔒 Bloquear pantalla'}
            </Boton>
          ) : null}
        </div>
        {a.activa && a.bloqueo ? (
          <p className="text-xs text-ink-500">
            Bloqueado: los alumnos solo ven el examen y en pantalla completa; si salen, se les tapa hasta que regresen. Al enviar se liberan. Se actualiza cada 5 segundos.
          </p>
        ) : a.activa ? (
          <p className="text-xs text-ink-500">Se actualiza cada 5 segundos.</p>
        ) : null}
      </Tarjeta>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Estadistica valor={`${entregados}/${entregas.length}`} etiqueta="entregados" />
        <Estadistica valor={<span className={fueraAhora ? 'text-red-600' : ''}>{fueraAhora}</span>} etiqueta="fuera de la pantalla" />
        <Estadistica valor={<span className={porRevisar ? 'text-amber-600' : ''}>{porRevisar}</span>} etiqueta="por revisar" />
        <Estadistica valor={entregas.filter((e) => (e.eventos ?? 0) > 0).length} etiqueta="con alertas" />
      </div>

      <ErrorServidor texto={error} />

      {entregas.length === 0 ? (
        <Vacio titulo="La materia no tiene alumnos inscritos" detalle="Inscribe alumnos desde la materia para que puedan ver esta actividad." />
      ) : (
        <>
          {/* Pantallas anchas: tabla; el nombre nunca se corta y la matrícula va debajo de él */}
          <Tarjeta className="hidden p-0 lg:block">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-3">Alumno</th>
                  <th className="px-3 py-3">Estado</th>
                  <th className="px-3 py-3">Enviado</th>
                  <th className="px-3 py-3" title="Desde que empezó hasta que envió (o hasta ahora si sigue contestando); debajo, solo el tiempo con el examen a la vista">Tardó</th>
                  <th className="px-3 py-3">Integridad</th>
                  {bloqueoVivo ? <th className="px-3 py-3">Bloqueo</th> : null}
                  <th className="px-3 py-3 text-right">Puntaje</th>
                  <th className="px-3 py-3 text-right" title="Calificación del examen sobre 10">Calif.</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {entregas.map((e) => (
                  <tr key={e.alumno_id} className={e.estado === 'enviado' && e.pendiente_manual ? 'bg-amber-50/40' : ''}>
                    <td className="min-w-[13rem] px-4 py-2">
                      <div className="font-medium leading-snug text-ink-900">{e.alumno_nombre}</div>
                      <div className="font-mono text-xs text-ink-400">{e.alumno_matricula}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2"><ChipEstado estado={e.estado} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{e.enviado_en ? fechaMx(e.enviado_en) : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-600">{tiempoDe(e)}</td>
                    <td className="px-3 py-2">{integridadDe(e)}</td>
                    {bloqueoVivo ? <td className="whitespace-nowrap px-3 py-2">{bloqueoDe(e)}</td> : null}
                    <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-ink-900">{puntajeDe(e)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">{califDe(e)}</td>
                    <td className="px-2 py-2 text-right">{revisarDe(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Tarjeta>

          {/* Celular, tablet y ventanas angostas: una tarjeta por alumno, sin desplazarse a lo ancho */}
          <ul className="grid gap-2 sm:grid-cols-2 lg:hidden">
            {entregas.map((e) => (
              <li key={e.alumno_id} className={`space-y-2 rounded-2xl border border-ink-200 p-3 ${e.estado === 'enviado' && e.pendiente_manual ? 'bg-amber-50/60' : 'bg-white'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium leading-snug text-ink-900">{e.alumno_nombre}</div>
                    <div className="font-mono text-xs text-ink-400">{e.alumno_matricula}</div>
                  </div>
                  <ChipEstado estado={e.estado} />
                </div>
                {e.id ? (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <div>
                      <dt className="text-xs text-ink-400">Puntaje</dt>
                      <dd className="font-semibold text-ink-900">{puntajeDe(e)} <span className="ml-1">{califDe(e)}</span></dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-400">Tardó</dt>
                      <dd className="text-ink-700">{tiempoDe(e)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-400">Enviado</dt>
                      <dd className="text-ink-700">{e.enviado_en ? fechaMx(e.enviado_en) : '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-400">Integridad</dt>
                      <dd>{integridadDe(e)}</dd>
                    </div>
                  </dl>
                ) : null}
                {e.id ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {bloqueoVivo ? bloqueoDe(e) : null}
                    {revisarDe(e)}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <Modal abierto={eliminar} titulo="¿Eliminar esta publicación?" onCerrar={() => !cambiando && setEliminar(false)}>
        <div className="space-y-3 text-sm text-ink-700">
          <p>
            Se quita <b>«{a.titulo}»</b> del portal: los alumnos ya no la verán.
            {conIntento ? (
              <>
                {' '}
                También se borran <b>{conIntento} {conIntento === 1 ? 'entrega' : 'entregas'}</b> ({entregados} {entregados === 1 ? 'enviada' : 'enviadas'}) con sus respuestas, calificaciones, eventos de vigilancia y archivos subidos.
              </>
            ) : (
              ' Nadie la ha empezado.'
            )}
          </p>
          <p className="text-ink-500">La evaluación no se borra: puedes volver a publicarla cuando quieras.</p>
          {conIntento ? (
            <label className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-red-800">
              <input type="checkbox" className="mt-0.5" checked={entiendo} onChange={(e) => setEntiendo(e.target.checked)} />
              <span>Entiendo que esas entregas se borran y no se pueden recuperar.</span>
            </label>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Boton variante="secundario" className="flex-1" onClick={() => setEliminar(false)} disabled={cambiando}>Cancelar</Boton>
            <Boton variante="peligro" className="flex-1" onClick={() => void eliminarPublicacion()} disabled={cambiando || (conIntento > 0 && !entiendo)}>
              {cambiando ? 'Eliminando…' : 'Eliminar publicación'}
            </Boton>
          </div>
        </div>
      </Modal>
    </div>
  )
}
