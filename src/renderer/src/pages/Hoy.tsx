import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type AlertaFaltas, type FechasProximas } from '../lib/api'
import { colorTipo, nombreTipo, rangoFechas } from './Fechas'
import Cuando from '../components/Cuando'
import { COLOR_NIVEL_FALTAS } from '../components/CalificacionesMateria'
import { ETIQUETA_NIVEL_FALTAS } from '@shared/proyeccion'
import { ahoraMx, aMinutos, fmtFechaLarga, semanaDelPeriodo, sumarDias, DIAS_CORTOS } from '../lib/tiempo'
import type { Periodo, Sesion } from '@shared/types'
import Encabezado from '../components/Encabezado'
import { abrirEnClase } from '../store/clase'

export default function Hoy(): JSX.Element {
  const nav = useNavigate()
  const [hoy, setHoy] = useState<Sesion[]>([])
  const [proximas, setProximas] = useState<Sesion[]>([])
  const [periodo, setPeriodo] = useState<Periodo | null>(null)
  const [ahora, setAhora] = useState(ahoraMx())
  const [fechas, setFechas] = useState<FechasProximas | null>(null)
  const [alertas, setAlertas] = useState<AlertaFaltas[]>([])

  // La pantalla suele quedarse abierta todo el día: se recarga cada pocos minutos, al volver a la
  // ventana y al cambiar de día. Solo la primera carga avisa si falla, para no repetir el aviso
  const cargar = async (fecha: string): Promise<void> => {
    const [h, p, ps, f, al] = await Promise.all([
      api.sesiones.porFecha(fecha),
      api.sesiones.rango(sumarDias(fecha, 1), sumarDias(fecha, 7)),
      api.periodos.listar(),
      api.recordatorios.proximas(fecha, sumarDias(fecha, 14)),
      api.faltas.alertas()
    ])
    setFechas(f)
    setAlertas(al)
    setHoy(h)
    setProximas(p)
    setPeriodo(ps.find((x) => x.activo) ?? ps[0] ?? null)
  }
  useEffect(() => {
    cargar(ahora.fecha)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ahora.fecha])
  useEffect(() => {
    const refrescar = (): void => {
      const a = ahoraMx()
      setAhora(a)
      cargar(a.fecha).catch(() => undefined)
    }
    const alVolver = (): void => {
      if (!document.hidden) refrescar()
    }
    const t = setInterval(() => setAhora(ahoraMx()), 30_000)
    const r = setInterval(refrescar, 3 * 60_000)
    // Cuando un alumno cambia de situación por faltas, la app lo avisa: las alertas se recargan al momento
    const quitarFaltas = api.faltas.alCambiar(() => {
      api.faltas.alertas().then(setAlertas).catch(() => undefined)
    })
    document.addEventListener('visibilitychange', alVolver)
    window.addEventListener('focus', alVolver)
    return () => {
      quitarFaltas()
      clearInterval(t)
      clearInterval(r)
      document.removeEventListener('visibilitychange', alVolver)
      window.removeEventListener('focus', alVolver)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enCurso = hoy.find((s) => aMinutos(s.hora_inicio) <= ahora.minutos && ahora.minutos < aMinutos(s.hora_fin))
  const siguiente = hoy.find((s) => aMinutos(s.hora_inicio) > ahora.minutos)
  const semana = periodo ? semanaDelPeriodo(periodo.fecha_inicio, ahora.fecha) : null
  const destacada = enCurso ?? siguiente
  const faltan = !enCurso && siguiente ? aMinutos(siguiente.hora_inicio) - ahora.minutos : null
  // Los próximos días agrupados por fecha: se lee de un vistazo qué toca cada día
  const porDia = [...proximas.reduce((m, s) => m.set(s.fecha, [...(m.get(s.fecha) ?? []), s]), new Map<string, Sesion[]>())]

  const abrirClase = async (s: Sesion): Promise<void> => {
    if (await abrirEnClase(s.id)) nav(`/clase/${s.id}`)
  }

  return (
    <div>
      <Encabezado titulo={fmtFechaLarga(ahora.fecha)} sub={periodo ? `${periodo.nombre} · Semana ${semana} de ${periodo.semanas}` : 'Sin periodo activo'} />
      <div className="px-4 sm:px-8 py-6 space-y-8">
        {destacada && (
          <section className="tarjeta p-5 sm:p-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
            <div className="flex min-w-0 flex-[1_1_18rem] items-start gap-3">
              {/* El color de la materia en un punto, igual que en el resto de la app */}
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: destacada.materia_color }} aria-hidden />
              <div className="min-w-0">
                <div className="etiqueta">
                  {enCurso ? 'Clase en curso' : 'Siguiente clase'}
                  {!enCurso && faltan !== null && <span className="ml-1.5 normal-case tracking-normal font-medium text-ink-500">· {faltan < 60 ? `en ${faltan} min` : `en ${Math.floor(faltan / 60)} h ${faltan % 60 ? `${faltan % 60} min` : ''}`.trim()}</span>}
                </div>
                <div className="text-2xl font-bold mt-1 break-words">{destacada.materia_nombre}</div>
                <div className="text-ink-500 mt-0.5 break-words">
                  <span className="font-mono">{destacada.hora_inicio}–{destacada.hora_fin}</span> · {destacada.tema || 'Sin tema asignado'}
                </div>
              </div>
            </div>
            <button className="btn-primario text-base px-5 py-2.5" onClick={() => abrirClase(destacada)}>
              {enCurso ? 'Entrar al modo clase' : 'Preparar clase'}
            </button>
          </section>
        )}

        <section>
          <h2 className="mb-3 flex items-baseline gap-2 font-semibold text-lg">Sesiones de hoy {hoy.length > 0 && <span className="text-sm font-normal text-ink-400">{hoy.length}</span>}</h2>
          {hoy.length === 0 ? (
            <div className="tarjeta px-5 py-8 text-center">
              <div className="font-medium text-ink-800">No hay sesiones programadas hoy</div>
              <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Si esperabas una clase, genera el calendario de sesiones desde el Plan de la materia.</p>
              <Link to="/materias" className="btn-secundario mt-3">Ir a Materias</Link>
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))]">
              {hoy.map((s) => (
                <TarjetaSesion key={s.id} s={s} onAbrir={() => abrirClase(s)} activa={enCurso?.id === s.id} />
              ))}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-6 items-start">
          <ProximasFechas f={fechas} hoy={ahora.fecha} />
          <RiesgoFaltas alertas={alertas} />
        </div>

        <section>
          <h2 className="font-semibold text-lg mb-3">Próximos 7 días</h2>
          {proximas.length === 0 ? (
            <div className="tarjeta px-4 py-5 text-sm text-ink-500">Nada programado en los próximos 7 días.</div>
          ) : (
            <div className="tarjeta overflow-hidden divide-y divide-ink-100">
              {porDia.map(([fecha, ses]) => (
                <div key={fecha}>
                  <div className="bg-ink-50/70 px-4 py-1.5 text-xs font-semibold text-ink-600">
                    {DIAS_CORTOS[new Date(fecha + 'T12:00:00').getDay() || 7]} {fmtDiaMes(fecha)}
                    <span className="ml-1.5 font-normal text-ink-400">· {ses.length === 1 ? '1 sesión' : `${ses.length} sesiones`}</span>
                  </div>
                  <ul className="divide-y divide-ink-100">
                    {ses.map((s) => (
                      <li key={s.id}>
                        <Link to={`/materias/${s.materia_id}?sesion=${s.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-2 hover:bg-ink-50">
                          <span className="w-24 shrink-0 font-mono text-sm text-ink-600">{s.hora_inicio}–{s.hora_fin}</span>
                          <span className="flex min-w-[8rem] flex-[0_1_14rem] items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.materia_color }} aria-hidden />
                            <span className="truncate font-medium" title={s.materia_nombre}>{s.materia_nombre}</span>
                          </span>
                          <span className="min-w-[8rem] flex-1 truncate text-ink-500" title={s.tema || undefined}>{s.tema || <i>sin tema</i>}</span>
                          <span className="shrink-0 text-right text-xs text-ink-400">Semana {s.semana}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

const ESTADO_SESION: Record<Sesion['estado'], { t: string; c: string }> = {
  planeada: { t: 'Planeada', c: 'bg-ink-100 text-ink-600' },
  en_curso: { t: 'En curso', c: 'bg-brand-500/10 text-brand-600' },
  terminada: { t: 'Terminada', c: 'bg-green-100 text-green-700' },
  cancelada: { t: 'Cancelada', c: 'bg-ink-100 text-ink-400 line-through' }
}

function TarjetaSesion({ s, onAbrir, activa }: { s: Sesion; onAbrir: () => void; activa: boolean }): JSX.Element {
  const acts = s.actividades ?? []
  const est = ESTADO_SESION[s.estado] ?? { t: s.estado, c: 'bg-ink-100 text-ink-600' }
  return (
    <div className={`tarjeta p-4 ${activa ? 'ring-2 ring-brand-400' : ''} ${s.estado === 'cancelada' ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-2.5 h-2.5 shrink-0 rounded-full" style={{ background: s.materia_color }} aria-hidden />
            <span className="font-semibold break-words">{s.materia_nombre}</span>
            <span className={`chip whitespace-nowrap ${est.c}`}>{est.t}</span>
          </div>
          <div className="text-sm text-ink-500 mt-1">
            <span className="font-mono">{s.hora_inicio}–{s.hora_fin}</span> · Sesión {s.numero} · Semana {s.semana}
          </div>
          <div className="mt-1 break-words">{s.tema || <span className="text-ink-400 italic">Sin tema. Asígnalo en la materia.</span>}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Para cambiar el plan, la fecha o pasar un examen a otro día */}
          <Link className="btn-secundario" to={`/materias/${s.materia_id}?sesion=${s.id}`}>Editar / reprogramar</Link>
          <button className="btn-primario" onClick={onAbrir}>Modo clase</button>
        </div>
      </div>
      {acts.length > 0 && (
        <ol className="mt-3 flex flex-wrap gap-1.5" aria-label="Actividades de la sesión">
          {acts.slice(0, 6).map((a) => (
            <li key={a.id} className="chip max-w-[220px] gap-1 border border-ink-200 bg-ink-50 text-ink-600" title={`${a.nombre} · ${a.duracion_min} min`}>
              <span className="truncate">{a.nombre}</span>
              <span className="shrink-0 text-ink-400">{a.duracion_min}′</span>
            </li>
          ))}
          {acts.length > 6 && <li className="chip text-ink-400">+{acts.length - 6} más</li>}
        </ol>
      )}
    </div>
  )
}

type Proxima = { clave: string; fecha: string; fin: string | null; hora: string | null; titulo: string; etiqueta: string; color: string; materia: string; materiaColor: string; enlace: string }

/** Recordatorios, evaluaciones programadas y cierres del portal de las próximas dos semanas. */
function ProximasFechas({ f, hoy }: { f: FechasProximas | null; hoy: string }): JSX.Element {
  const manana = sumarDias(hoy, 1)
  const items: Proxima[] = []
  if (f) {
    for (const r of f.recordatorios) items.push({ clave: `r${r.id}`, fecha: r.fecha, fin: r.fecha_fin, hora: r.hora, titulo: r.titulo, etiqueta: nombreTipo(r.tipo), color: colorTipo(r.tipo), materia: r.materia_nombre ?? 'General', materiaColor: r.materia_color ?? '#94a3b8', enlace: '/fechas' })
    // Un examen ya anotado como recordatorio de la misma materia y día no se repite
    for (const e of f.evaluaciones)
      if (!f.recordatorios.some((r) => r.materia_id === e.materia_id && r.fecha === e.fecha))
        items.push({ clave: `e${e.id}`, fecha: e.fecha, fin: null, hora: null, titulo: e.titulo, etiqueta: e.tipo === 'examen' ? 'Parcial / examen' : 'Evaluación', color: e.tipo === 'examen' ? colorTipo('parcial') : 'bg-violet-50 text-violet-700', materia: e.materia_nombre, materiaColor: e.materia_color, enlace: `/evaluacion/${e.id}` })
    for (const a of f.portal) items.push({ clave: `p${a.id}`, fecha: a.fecha, fin: null, hora: a.hora, titulo: `Cierra en el portal: ${a.titulo}`, etiqueta: nombreTipo('entrega'), color: colorTipo('entrega'), materia: a.materia_nombre, materiaColor: a.materia_color, enlace: '/portal' })
  }
  const orden = (x: Proxima): string => (x.fecha < hoy ? hoy : x.fecha)
  items.sort((a, b) => orden(a).localeCompare(orden(b)) || (a.hora ?? '').localeCompare(b.hora ?? ''))
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold text-lg">Próximas fechas</h2>
        <Link to="/fechas" className="text-sm text-brand-600 hover:underline">Ver y agregar fechas</Link>
      </div>
      <div className="tarjeta divide-y divide-ink-100 lista-filas">
        {items.map((x) => {
          const esHoy = x.fecha <= hoy
          const esManana = x.fecha === manana
          return (
            <Link key={x.clave} to={x.enlace} className={`fila-fecha px-4 py-2.5 hover:bg-ink-50 ${esHoy ? 'bg-brand-500/5' : esManana ? 'bg-amber-50' : ''}`}>
              <span className="c-fecha text-sm text-ink-600 whitespace-nowrap">
                {DIAS_CORTOS[new Date(orden(x) + 'T12:00:00').getDay() || 7]} {fmtDiaMes(orden(x))}
                {x.hora && <span className="block text-xs text-ink-400">{x.hora}</span>}
              </span>
              <span className="c-titulo">
                <span className="line-clamp-2 break-words font-medium" title={x.titulo}>{x.titulo}</span>
                {x.fin && x.fin !== x.fecha && <span className="block text-xs text-ink-400 truncate">{rangoFechas(x.fecha, x.fin)}</span>}
              </span>
              <span className="c-meta">
                <span className="c-materia flex items-center gap-1.5 text-xs text-ink-500 min-w-0"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: x.materiaColor }} /><span className="truncate" title={x.materia}>{x.materia}</span></span>
                <span className={`c-tipo chip ${x.color}`}>{x.etiqueta}</span>
              </span>
              <span className="c-cuando"><Cuando fecha={x.fecha} fin={x.fin} hoy={hoy} /></span>
            </Link>
          )
        })}
        {f && items.length === 0 && <div className="px-4 py-5 text-sm text-ink-500">Nada en las próximas dos semanas.</div>}
        {!f && <div className="px-4 py-5 text-sm text-ink-400">Cargando…</div>}
      </div>
    </section>
  )
}

const fmtDiaMes = (f: string): string => new Date(f + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '')

/** Situación por faltas del comunicado COM-AS-01 (horas en todo el curso), por materia. */
function RiesgoFaltas({ alertas }: { alertas: AlertaFaltas[] }): JSX.Element {
  const materias = [...new Map(alertas.map((a) => [a.materia_id, a])).values()]
  return (
    <section className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-semibold text-lg">Alumnos en riesgo por faltas</h2>
        <Link to="/asistencias" className="text-sm text-brand-600 hover:underline">Ver asistencias</Link>
      </div>
      <div className="tarjeta divide-y divide-ink-100 lista-filas">
        {materias.map((m) => (
          <div key={m.materia_id} className="group px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <Link to={`/materias/${m.materia_id}?tab=calificaciones`} className="flex min-w-0 items-center gap-2 font-medium hover:underline">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: m.materia_color }} aria-hidden />
                <span className="break-words">{m.materia_nombre}</span>
              </Link>
              {/* Directo a la cuadrícula de esa materia: aparece al pasar el mouse o con el teclado */}
              <Link to={`/asistencias?materia=${m.materia_id}`} className="text-xs text-brand-600 hover:underline opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100">Pase de lista</Link>
            </div>
            <ul className="mt-2 space-y-2">
              {alertas.filter((a) => a.materia_id === m.materia_id).map((a) => (
                <li key={a.alumno_id} className="fila-riesgo text-sm">
                  <span className="c-nivel"><span className={`chip ${COLOR_NIVEL_FALTAS[a.nivel]}`}>{ETIQUETA_NIVEL_FALTAS[a.nivel]}</span></span>
                  <Link to={`/alumnos/${a.alumno_id}`} className="font-medium hover:underline break-words min-w-0">{a.alumno}</Link>
                  <span className="text-xs text-ink-600 text-right whitespace-nowrap font-mono">{a.horas_falta} h</span>
                  <span className="c-texto text-xs text-ink-500">{a.texto}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {alertas.length === 0 && <div className="px-4 py-5 text-sm text-ink-500">Nadie está cerca del límite de faltas.</div>}
      </div>
      <p className="text-xs text-ink-400 mt-2">Según el comunicado de asistencias (horas de falta en todo el curso). «Alerta»: ya lleva faltas y le queda 1 h o menos para el límite.</p>
    </section>
  )
}
