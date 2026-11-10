import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, duracion, fechaMx } from '../../lib/api'
import { calificacionExamen } from '../../lib/calificacion'
import { Boton, Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio } from '../../componentes/ui'
import { FilaChips, ResumenFiltros, useRecordado } from '../../componentes/Filtros'
import type { Intento, MateriaTareasAlumno, TareaAlumno } from '@shared/portal'
import type { AvanceMateria } from '@shared/avance'
import { puntos } from './Actividades'

/** Lo que devuelve GET /api/alumno/calificaciones: el intento con datos de la asignación. */
type Calificacion = Intento & { titulo: string; materia_nombre: string; puntos_totales: number; mostrar_resultado: number; ponderacion?: number }

function resultadoDe(c: Calificacion): { texto: string; tono: 'gris' | 'verde' | 'ambar'; detalle?: string } {
  if (!c.mostrar_resultado) return { texto: 'Resultado no visible', tono: 'gris', detalle: 'El docente decidió no mostrar el puntaje de esta actividad.' }
  const p = c.puntaje ?? c.puntaje_auto
  if (p !== null && c.puntos_totales > 0) {
    // Sobre 10 y, si el docente indicó cuánto vale en el parcial, lo que le aporta (p. ej. 8.0 × 30 % = 2.40 de 3.0)
    const { sobre10, aporte: a, maximo, ponderacion: pond } = calificacionExamen(p, c.puntos_totales, c.ponderacion)!
    const aporte = a !== null ? ` · aporta ${a.toFixed(2)} de ${maximo.toFixed(1)} a tu parcial (${puntos(pond)} %)` : ''
    const parcial = c.pendiente_manual && c.puntaje === null ? ' · faltan preguntas que revisa tu docente' : ''
    return { texto: `${sobre10.toFixed(1)} / 10`, tono: c.puntaje === null && c.pendiente_manual ? 'ambar' : 'verde', detalle: `${puntos(p)} de ${puntos(c.puntos_totales)} pts${aporte}${parcial}` }
  }
  if (c.pendiente_manual) return { texto: 'Pendiente de revisión', tono: 'ambar', detalle: 'Tiene preguntas que el docente califica a mano.' }
  return { texto: 'Sin calificar todavía', tono: 'gris' }
}

/** Día en Ciudad de México (YYYY-MM-DD) de una fecha ISO: así se ubica en el parcial que le toca */
const diaMx = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(iso))
const nota = (v: number | null): string => (v == null ? '—' : v.toFixed(1))
const TONO_ESTADO: Record<string, 'verde' | 'rojo' | 'ambar' | 'gris'> = { aprobado: 'verde', reprobado: 'rojo', na_inasistencia: 'rojo', pendiente: 'gris' }

/** Estados de una tarea que ya entregó (aunque falte la calificación) */
const ENTREGADA: TareaAlumno['estado'][] = ['subida', 'entregada_classroom', 'recuperacion']

type Datos = { avance: { visible: boolean; materias: AvanceMateria[] }; tareas: MateriaTareasAlumno[]; entregas: Calificacion[] }

/** Nombre del parcial al que pertenece una fecha en esa materia (por sus fechas de inicio y fin), o null */
function parcialDe(m: AvanceMateria | undefined, iso: string | null): string | null {
  if (!m || !iso) return null
  const d = diaMx(iso)
  return m.parciales.find((p) => p.desde && p.hasta && d >= p.desde && d <= p.hasta)?.nombre ?? null
}

/**
 * Calificaciones del alumno en un lugar: la de cada parcial (cuando el docente la publica), las de sus tareas y las
 * de sus exámenes y actividades del portal. Se filtra por materia y por parcial.
 */
export default function Calificaciones(): JSX.Element {
  const [datos, setDatos] = useState<Datos | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)
  const [materia, setMateria] = useRecordado<string>('calificaciones.materia', 'todas')
  const [parcial, setParcial] = useRecordado<string>('calificaciones.parcial', 'todos')

  const cargar = useCallback((): void => {
    setCargando(true)
    setError(null)
    Promise.all([
      api<{ visible: boolean; materias: AvanceMateria[] }>('/alumno/avance'),
      // Sin Classroom en ninguna materia no hay tareas: no es un error
      api<MateriaTareasAlumno[]>('/alumno/tareas').catch(() => [] as MateriaTareasAlumno[]),
      api<Calificacion[]>('/alumno/calificaciones')
    ])
      .then(([avance, tareas, entregas]) => setDatos({ avance, tareas, entregas }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setCargando(false))
  }, [])
  useEffect(cargar, [cargar])

  const porNombre = useMemo(() => new Map((datos?.avance.materias ?? []).map((m) => [m.nombre, m])), [datos])
  const materias = useMemo(() => {
    const n = new Set<string>([...(datos?.avance.materias ?? []).map((m) => m.nombre), ...(datos?.tareas ?? []).map((t) => t.materia_nombre), ...(datos?.entregas ?? []).map((c) => c.materia_nombre)])
    return [...n].sort((a, b) => a.localeCompare(b, 'es'))
  }, [datos])
  const materiaEf = materia !== 'todas' && materias.includes(materia) ? materia : 'todas'
  const enMateria = (nombre: string): boolean => materiaEf === 'todas' || nombre === materiaEf
  // Parciales por nombre (Parcial 1, Parcial 2…): los mismos en todas las materias
  const parciales = useMemo(() => {
    const n: string[] = []
    for (const m of datos?.avance.materias ?? []) for (const p of m.parciales) if (!n.includes(p.nombre)) n.push(p.nombre)
    return n
  }, [datos])
  const parcialEf = parcial !== 'todos' && parciales.includes(parcial) ? parcial : 'todos'
  const enParcial = (nombre: string | null): boolean => parcialEf === 'todos' || nombre === parcialEf

  // Calificación de cada parcial (solo lo que el docente publicó trae números)
  const deParciales = (datos?.avance.visible ? datos.avance.materias : [])
    .filter((m) => enMateria(m.nombre))
    .flatMap((m) => m.parciales.filter((p) => enParcial(p.nombre)).map((p) => ({ m, p })))
  // Tareas con calificación o ya entregadas, ubicadas en su parcial por la fecha límite
  const tareas = (datos?.tareas ?? [])
    .filter((mt) => enMateria(mt.materia_nombre))
    .flatMap((mt) => mt.tareas.map((t) => ({ mt, t, parcial: parcialDe(porNombre.get(mt.materia_nombre), t.vence) })))
    .filter((x) => (x.t.calificacion !== null || ENTREGADA.includes(x.t.estado)) && enParcial(x.parcial))
    .sort((a, b) => (b.t.vence ?? '').localeCompare(a.t.vence ?? ''))
  // Exámenes y actividades del portal, en el parcial de su fecha de envío
  const entregas = (datos?.entregas ?? [])
    .filter((c) => enMateria(c.materia_nombre) && enParcial(parcialDe(porNombre.get(c.materia_nombre), c.enviado_en)))

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <EncabezadoPagina titulo="Calificaciones">
        <Boton variante="fantasma" onClick={cargar} disabled={cargando} aria-label="Recargar calificaciones">
          <span aria-hidden>↻</span> Recargar
        </Boton>
      </EncabezadoPagina>
      <Link to="/avance" className="-ml-2 inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-semibold text-brand-600 hover:bg-ink-100">
        Ver mi avance completo (faltas y lo que necesito para aprobar) →
      </Link>

      {error && <ErrorCarga titulo="No se pudieron cargar tus calificaciones" detalle={error} onReintentar={cargar} />}
      {!datos && !error && <Cargando texto="Cargando calificaciones…" />}

      {datos && (
        <div className="space-y-2">
          {materias.length > 1 && (
            <FilaChips
              etiqueta="Materia"
              valor={materiaEf}
              onCambio={setMateria}
              opciones={[{ valor: 'todas', texto: 'Todas las materias' }, ...materias.map((m) => ({ valor: m, texto: m }))]}
            />
          )}
          {parciales.length > 0 && (
            <FilaChips etiqueta="Parcial" valor={parcialEf} onCambio={setParcial} opciones={[{ valor: 'todos', texto: 'Todos' }, ...parciales.map((p) => ({ valor: p, texto: p }))]} />
          )}
          {(materiaEf !== 'todas' || parcialEf !== 'todos') && (
            <button className="-ml-2 inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-semibold text-brand-600 hover:bg-ink-100" onClick={() => { setMateria('todas'); setParcial('todos') }}>
              Quitar filtros
            </button>
          )}
        </div>
      )}

      {datos && (
        <section className="space-y-2" aria-labelledby="titulo-parciales">
          <h2 id="titulo-parciales" className="text-sm font-bold uppercase tracking-wide text-ink-500">Calificación del parcial</h2>
          {!datos.avance.visible ? (
            <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-600">Tu docente aún no publica las calificaciones de los parciales.</p>
          ) : deParciales.length === 0 ? (
            <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-600">No hay parciales con este filtro.</p>
          ) : (
            deParciales.map(({ m, p }) => (
              <Tarjeta key={`${m.id}:${p.nombre}`} className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
                      <span className="truncate">{m.nombre}</span>
                    </div>
                    <h3 className="font-semibold text-ink-900">{p.nombre}</h3>
                  </div>
                  {p.publicado ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xl font-bold tabular-nums text-ink-900">{nota(p.calificacion)}</span>
                      <Chip tono={TONO_ESTADO[p.estado] ?? 'gris'}>{p.etiqueta}</Chip>
                    </div>
                  ) : (
                    <Chip>En captura</Chip>
                  )}
                </div>
                {p.publicado ? (
                  <ul className="divide-y divide-ink-100 text-sm">
                    {p.componentes.map((c) => (
                      <li key={c.nombre} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                        <span className="min-w-0 text-ink-700">
                          {c.nombre} <span className="text-xs text-ink-400">{c.peso} %</span>
                          {c.detalle && <span className="block text-xs text-ink-500">{c.detalle}</span>}
                        </span>
                        <span className="font-semibold tabular-nums text-ink-900">{nota(c.valor)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-600">Tu docente todavía está calificando este parcial.</p>
                )}
              </Tarjeta>
            ))
          )}
        </section>
      )}

      {datos && (
        <section className="space-y-2" aria-labelledby="titulo-tareas">
          <h2 id="titulo-tareas" className="text-sm font-bold uppercase tracking-wide text-ink-500">Tareas</h2>
          {tareas.length === 0 ? (
            <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-600">No hay tareas entregadas o calificadas con este filtro.</p>
          ) : (
            <Tarjeta className="p-0">
              <ul className="divide-y divide-ink-100">
                {tareas.map(({ mt, t, parcial: pa }) => (
                  <li key={`${t.curso_id}:${t.tarea_id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_14rem]">
                      <div className="break-words font-medium text-ink-900">{t.titulo}</div>
                      <div className="text-xs text-ink-500">
                        {mt.materia_nombre}{pa ? ` · ${pa}` : ''}{t.vence ? ` · vence ${fechaMx(t.vence)}` : ''}
                      </div>
                    </div>
                    <TareaNota t={t} />
                  </li>
                ))}
              </ul>
            </Tarjeta>
          )}
        </section>
      )}

      {datos && (
        <section className="space-y-2" aria-labelledby="titulo-entregas">
          <h2 id="titulo-entregas" className="text-sm font-bold uppercase tracking-wide text-ink-500">Exámenes y actividades del portal</h2>
          {entregas.length === 0 ? (
            <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-600">No hay entregas del portal con este filtro.</p>
          ) : (
            entregas.map((c) => <TarjetaEntrega key={c.id} c={c} />)
          )}
        </section>
      )}
    </div>
  )
}

/** Calificación de una tarea: la que devolvió el docente (sobre sus puntos) o en qué va */
function TareaNota({ t }: { t: TareaAlumno }): JSX.Element {
  if (t.calificacion !== null) {
    const sobre = t.puntos ? ` / ${puntos(t.puntos)}` : ''
    return <span className="inline-flex min-h-[32px] items-center rounded-xl bg-green-100 px-3 font-bold tabular-nums text-green-800">{puntos(t.calificacion)}{sobre}</span>
  }
  return <Chip tono="azul">Entregada · sin calificar</Chip>
}

/** Una entrega del portal con su resultado, cuando el docente lo permite. */
function TarjetaEntrega({ c }: { c: Calificacion }): JSX.Element {
  const r = resultadoDe(c)
  return (
      <Tarjeta key={c.id} className="space-y-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold uppercase tracking-wide text-ink-500">{c.materia_nombre}</div>
          <h3 className="break-words font-semibold leading-snug text-ink-900">{c.titulo}</h3>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex min-h-[32px] items-center rounded-xl px-3 text-base font-bold ${r.tono === 'verde' ? 'bg-green-100 text-green-800' : r.tono === 'ambar' ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-600'}`}>
            {r.texto}
          </span>
          <Chip tono={c.estado === 'calificado' ? 'verde' : 'azul'}>{c.estado === 'calificado' ? 'Calificada' : 'Enviada'}</Chip>
        </div>
        {r.detalle && <div className="text-sm text-ink-600">{r.detalle}</div>}

        <dl className="space-y-0.5 text-sm text-ink-700">
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-ink-500">Enviado:</dt>
            <dd>{c.enviado_en ? fechaMx(c.enviado_en) : '—'}</dd>
          </div>
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-ink-500">Tiempo activo:</dt>
            <dd>{duracion(c.tiempo_activo_seg)}</dd>
          </div>
          {c.calificado_en && (
            <div className="flex flex-wrap gap-x-1">
              <dt className="text-ink-500">Calificado:</dt>
              <dd>{fechaMx(c.calificado_en)}</dd>
            </div>
          )}
        </dl>

        {c.mostrar_resultado ? (
          <Link to={`/actividad/${c.asignacion_id}`} className="-ml-2 inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-semibold text-brand-600 hover:bg-ink-100">
            Ver mis respuestas →
          </Link>
        ) : null}
        {c.retro ? (
          <div className="rounded-xl bg-ink-50 p-3 text-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Retroalimentación del docente</div>
            <p className="whitespace-pre-wrap break-words text-ink-800">{c.retro}</p>
          </div>
        ) : null}
      </Tarjeta>
  )
}
