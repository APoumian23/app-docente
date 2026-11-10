import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type DetalleAlumno } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import ModalPassword from '../components/ModalPassword'
import { avisar } from '../components/Aviso'
import { BotonJustificar } from '../components/Justificar'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, EncabezadoOrden, Segmentado, SinResultados, coincide, ordenNatural, type Orden } from '../components/Filtros'
import { ETIQUETA_RIESGO } from '@shared/asistencia'
import { fmtFechaMx as fechaMx } from '../lib/tiempo'
import type { Alumno, Carrera } from '@shared/types'
import type { ResumenProyeccion } from '@shared/proyeccion'
import { ETIQUETA_ESTADO_CALIF } from '@shared/esquema'
import { COLOR_CLASIFICACION, COLOR_ESTADO, nota1 } from '../components/CalificacionesMateria'

const COLOR_RIESGO: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  atencion: 'bg-amber-100 text-amber-800',
  extraordinario: 'bg-orange-100 text-orange-800',
  titulo: 'bg-red-100 text-red-800',
  recursa: 'bg-red-200 text-red-900'
}
const ETIQUETA_ASISTENCIA: Record<string, string> = { presente: 'Presente', retardo: 'Retardo', ausente: 'Falta', justificado: 'Justificada' }
const COLOR_ASISTENCIA: Record<string, string> = { presente: 'text-emerald-700', retardo: 'text-amber-700', ausente: 'text-red-700', justificado: 'text-ink-500' }
const ETIQUETA_ESTADO: Record<string, string> = { pendiente: 'Pendiente', entregado: 'Entregado', calificado: 'Calificado', no_entregado: 'No entregado', borrador: 'Borrador', en_curso: 'En curso', enviado: 'Enviado' }

const minutos = (seg: number): string => (seg >= 60 ? `${Math.round(seg / 60)} min` : `${seg} s`)

type Pestana = 'materias' | 'asistencia' | 'calificaciones' | 'entregas'
type FiltroAsistencia = 'todas' | 'incidencias' | 'ausente' | 'retardo' | 'justificado'
const FILTROS_ASISTENCIA: [FiltroAsistencia, string][] = [['todas', 'Todas'], ['incidencias', 'No presentes'], ['ausente', 'Faltas'], ['retardo', 'Retardos'], ['justificado', 'Justificadas']]
const cumpleAsistencia = (f: FiltroAsistencia, estado: string): boolean => (f === 'todas' ? true : f === 'incidencias' ? estado !== 'presente' : estado === f)
/** El servidor manda solo los registros de asistencia más recientes */
const TOPE_ASISTENCIAS = 80
const thClase = 'px-3 py-2'

/** Todo lo de un alumno en una pantalla: materias, asistencia, calificaciones, entregas del portal y su acceso. */
export default function AlumnoDetalle(): JSX.Element {
  const { id } = useParams()
  const nav = useNavigate()
  const [d, setD] = useState<DetalleAlumno | null>(null)
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [form, setForm] = useState<Partial<Alumno> | null>(null)
  const [borrar, setBorrar] = useState(false)
  const [credencial, setCredencial] = useState<{ usuario: string; password: string } | null>(null)
  // La pestaña y los filtros se recuerdan al pasar de un alumno a otro; la materia y la búsqueda son de cada alumno
  const [tab, setTab] = useRecordado<Pestana>('alumno.pestana', 'materias')
  const [busqueda, setBusqueda] = useState('')
  const [materiaF, setMateriaF] = useState('')
  const [asisF, setAsisF] = useRecordado<FiltroAsistencia>('alumno.asistencia', 'todas')
  const [calF, setCalF] = useRecordado('alumno.calificaciones', '')
  const [entF, setEntF] = useRecordado('alumno.entregas', '')
  const [porRevisar, setPorRevisar] = useState(false)
  const [conAlertas, setConAlertas] = useState(false)
  const [ordenAsis, setOrdenAsis] = useRecordado<Orden<'fecha' | 'materia'>>('alumno.asistencia.orden', { campo: 'fecha', dir: -1 })
  const [ordenCal, setOrdenCal] = useRecordado<Orden<'titulo' | 'materia' | 'fecha'>>('alumno.calificaciones.orden', { campo: 'fecha', dir: 1 })
  const [ordenEnt, setOrdenEnt] = useRecordado<Orden<'titulo' | 'materia' | 'enviado'>>('alumno.entregas.orden', { campo: 'enviado', dir: -1 })
  // Calificación con el esquema de cada materia y su proyección (solo lo de este alumno)
  const [proyecciones, setProyecciones] = useState<Record<number, ResumenProyeccion['alumnos'][number] | null>>({})

  const cargar = async (): Promise<void> => {
    try {
      const det = await api.alumnos.detalle(Number(id))
      setD(det)
      const lista = await Promise.all(det.materias.map((m) => api.calificaciones.proyeccion(m.materia.id).catch(() => null)))
      setProyecciones(Object.fromEntries(det.materias.map((m, i) => [m.materia.id, lista[i]?.alumnos.find((x) => x.alumno_id === det.alumno.id) ?? null])))
    } catch (e) {
      avisar((e as Error).message, 'error')
      nav('/alumnos')
    }
  }
  useEffect(() => {
    cargar()
    api.carreras.listar().then(setCarreras)
    setMateriaF('')
    setBusqueda('')
    setPorRevisar(false)
    setConAlertas(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  if (!d) return <div className="p-8 text-ink-500">Cargando…</div>
  const a = d.alumno

  const guardar = async (): Promise<void> => {
    if (!form?.nombre?.trim()) return avisar('El nombre es obligatorio', 'error')
    try {
      await api.alumnos.guardar({ ...form, id: a.id })
      setForm(null)
      avisar('Alumno actualizado')
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const crearAcceso = async (): Promise<void> => {
    try {
      const c = await api.alumnos.crearAcceso(a.id)
      if (c) setCredencial({ usuario: c.usuario, password: c.password })
      else avisar('Este alumno ya tiene acceso')
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const reiniciar = async (): Promise<void> => {
    if (!d.acceso) return
    if (!confirm(`¿Reiniciar la contraseña de ${`${a.nombre} ${a.apellidos}`.trim()}?\n\nVuelve a la contraseña inicial y se cierran sus sesiones abiertas en el portal: si está contestando un examen, lo saca y tendrá que volver a entrar.`)) return
    try {
      const password = await api.alumnos.reiniciarPassword(a.id)
      setCredencial({ usuario: d.acceso.usuario, password })
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  // Su calificación con el esquema de cada materia (la columna «al ritmo actual» de Calificaciones); sin esquema, el promedio de evaluaciones
  const califDe = (m: DetalleAlumno['materias'][number]): number | null => proyecciones[m.materia.id]?.al_ritmo_actual ?? m.fila.promedio_parcial
  const promedioGeneral = (() => {
    const con = d.materias.map(califDe).filter((x): x is number => x != null)
    return con.length ? Math.round((con.reduce((s, x) => s + x, 0) / con.length) * 10) / 10 : null
  })()
  // El riesgo se mide en horas de clase (comunicado de asistencias); se muestran ambas cifras para que cuadren
  const faltasTotales = d.asistencias.filter((x) => x.estado === 'ausente').length
  const horasFalta = d.materias.reduce((s, m) => s + m.fila.horas_falta, 0)
  const peorRiesgo = d.materias.map((m) => m.fila.riesgo).sort((x, y) => Object.keys(COLOR_RIESGO).indexOf(y) - Object.keys(COLOR_RIESGO).indexOf(x))[0]

  // ---- Filtros de las pestañas: solo cambian qué renglones se ven ----
  const cambiarTab = (t: Pestana): void => {
    setTab(t)
    setBusqueda('')
  }
  const quitarFiltros = (): void => {
    setBusqueda('')
    setMateriaF('')
    if (tab === 'asistencia') setAsisF('todas')
    if (tab === 'calificaciones') setCalF('')
    if (tab === 'entregas') {
      setEntF('')
      setPorRevisar(false)
      setConAlertas(false)
    }
  }
  // La materia elegida solo cuenta en la pestaña si hay renglones de ella
  const materiaEn = (nombres: string[]): string => (nombres.includes(materiaF) ? materiaF : '')
  const contar = <T,>(l: T[], f: (x: T) => boolean): number => l.filter(f).length

  // Asistencia
  const nombresAsis = d.asistencias.map((x) => x.materia_nombre)
  const matAsis = materiaEn(nombresAsis)
  const asisBase = d.asistencias.filter((x) => (!matAsis || x.materia_nombre === matAsis) && coincide(busqueda, x.tema, x.nota, x.materia_nombre))
  const momento = (x: DetalleAlumno['asistencias'][number]): string => `${x.fecha} ${x.hora_inicio}`
  const asistencias = asisBase
    .filter((x) => cumpleAsistencia(asisF, x.estado))
    .sort((x, y) => (ordenAsis.campo === 'materia' ? ordenAsis.dir * ordenNatural(x.materia_nombre, y.materia_nombre) : ordenAsis.dir * momento(x).localeCompare(momento(y))) || momento(y).localeCompare(momento(x)))
  const hayFiltroAsis = !!busqueda.trim() || !!matAsis || asisF !== 'todas'

  // Calificaciones
  const nombresCal = d.resultados.map((r) => r.materia_nombre)
  const matCal = materiaEn(nombresCal)
  const estadosCal = [...new Set(d.resultados.map((r) => r.estado))]
  const calSel = estadosCal.includes(calF as (typeof estadosCal)[number]) ? calF : ''
  const calBase = d.resultados.filter((r) => (!matCal || r.materia_nombre === matCal) && coincide(busqueda, r.titulo, r.comentario, r.materia_nombre, r.tipo.replace('_', ' ')))
  const resultados = calBase
    .filter((r) => !calSel || r.estado === calSel)
    .sort((x, y) => {
      if (ordenCal.campo === 'fecha') {
        // Las que aún no tienen fecha van al final en cualquier sentido
        if (!x.fecha_aplicacion || !y.fecha_aplicacion) return (x.fecha_aplicacion ? -1 : y.fecha_aplicacion ? 1 : 0) || ordenNatural(x.titulo, y.titulo)
        return ordenCal.dir * x.fecha_aplicacion.localeCompare(y.fecha_aplicacion) || ordenNatural(x.titulo, y.titulo)
      }
      return ordenCal.dir * (ordenCal.campo === 'materia' ? ordenNatural(x.materia_nombre, y.materia_nombre) : 0) || ordenCal.dir * ordenNatural(x.titulo, y.titulo)
    })
  const hayFiltroCal = !!busqueda.trim() || !!matCal || !!calSel

  // Entregas del portal
  const nombresEnt = d.entregas.map((e) => e.materia_nombre)
  const matEnt = materiaEn(nombresEnt)
  const estadosEnt = [...new Set(d.entregas.map((e) => e.estado))]
  const entSel = estadosEnt.includes(entF) ? entF : ''
  const entBase = d.entregas.filter((e) => (!matEnt || e.materia_nombre === matEnt) && coincide(busqueda, e.titulo, e.materia_nombre) && (!porRevisar || !!e.pendiente_manual) && (!conAlertas || e.eventos > 0))
  const entregas = entBase
    .filter((e) => !entSel || e.estado === entSel)
    .sort((x, y) => {
      if (ordenEnt.campo === 'enviado') {
        if (!x.enviado_en || !y.enviado_en) return (x.enviado_en ? -1 : y.enviado_en ? 1 : 0) || ordenNatural(x.titulo, y.titulo)
        return ordenEnt.dir * x.enviado_en.localeCompare(y.enviado_en)
      }
      return ordenEnt.dir * (ordenEnt.campo === 'materia' ? ordenNatural(x.materia_nombre, y.materia_nombre) : 0) || ordenEnt.dir * ordenNatural(x.titulo, y.titulo)
    })
  const hayFiltroEnt = !!busqueda.trim() || !!matEnt || !!entSel || porRevisar || conAlertas

  /** Barra de filtros común a las pestañas (función y no componente, para que el buscador no pierda el foco) */
  const barra = (nombres: string[], materiaSel: string, placeholder: string, extra: ReactNode, visibles: number, total: number, nombre: string, hayFiltro: boolean): JSX.Element => {
    const mats = [...new Set(nombres)].sort(ordenNatural)
    return (
      <div className="flex flex-wrap items-center gap-2" role="search" aria-label={`Filtrar ${nombre}`}>
        <Buscador valor={busqueda} onCambio={setBusqueda} placeholder={placeholder} etiqueta={placeholder} />
        {mats.length > 1 && (
          <select className="input w-auto max-w-[16rem]" value={materiaSel} onChange={(e) => setMateriaF(e.target.value)} aria-label="Filtrar por materia">
            <option value="">Todas las materias</option>
            {mats.map((n) => <option key={n} value={n}>{n} ({nombres.filter((x) => x === n).length})</option>)}
          </select>
        )}
        {extra}
        {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
        <Conteo visibles={visibles} total={total} nombre={nombre} hayFiltro={hayFiltro} />
      </div>
    )
  }

  return (
    <div>
      <Encabezado
        titulo={`${a.apellidos} ${a.nombre}`.trim()}
        sub={
          <span>
            <Link to="/alumnos" className="hover:underline">Alumnos</Link> · {a.matricula ? <span className="font-mono">{a.matricula}</span> : 'sin matrícula'} · {a.carrera_nombre ?? 'sin carrera'}
            {a.email && <> · {a.email}</>}
            {!a.activo && <span className="chip bg-ink-100 text-ink-600 ml-2">De baja</span>}
          </span>
        }
        acciones={
          <>
            <button className="btn-secundario" onClick={() => setForm({ ...a })}>Editar</button>
            <button className="btn-peligro" onClick={() => setBorrar(true)}>Eliminar</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-5 space-y-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Dato titulo="Materias" valor={String(d.materias.length)} />
          <Dato titulo="Calificación actual" valor={promedioGeneral != null ? promedioGeneral.toFixed(1) : '—'} nota={d.materias.length > 1 ? 'promedio de sus materias, al ritmo actual' : 'al ritmo actual, con el esquema de la materia'} />
          <Dato titulo="Horas de falta" valor={`${horasFalta} h`} nota={`${d.materias.length > 1 ? 'suma de sus materias · ' : ''}${faltasTotales} ${faltasTotales === 1 ? 'sesión' : 'sesiones'} con falta de ${d.asistencias.length} registradas`} />
          <Dato titulo="Riesgo por asistencia" valor={peorRiesgo ? ETIQUETA_RIESGO[peorRiesgo] : '—'} clase={peorRiesgo ? COLOR_RIESGO[peorRiesgo] : ''} nota={d.materias.length > 1 ? 'la materia más comprometida, por horas' : 'por horas de falta'} />
        </div>

        <section className="tarjeta p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-semibold">Acceso al portal</h2>
              {d.acceso ? (
                <p className="text-sm text-ink-600 mt-1">
                  Usuario <span className="font-mono font-semibold">{d.acceso.usuario}</span> · {d.acceso.debe_cambiar ? 'contraseña inicial sin cambiar' : 'contraseña propia'} · último acceso {fechaMx(d.acceso.ultimo_acceso)}
                </p>
              ) : (
                <p className="text-sm text-ink-600 mt-1">Todavía no tiene cuenta. Con ella contesta evaluaciones y ve sus calificaciones desde su celular.</p>
              )}
            </div>
            {d.acceso ? <button className="btn-secundario" onClick={reiniciar}>Reiniciar contraseña</button> : <button className="btn-primario" onClick={crearAcceso}>Crear acceso</button>}
          </div>
        </section>

        <div className="flex flex-wrap gap-x-1 border-b border-ink-200" role="tablist" aria-label="Secciones del alumno">
          {([['materias', 'Materias', d.materias.length], ['asistencia', 'Asistencia', d.asistencias.length], ['calificaciones', 'Calificaciones', d.resultados.length + d.tareas.length], ['entregas', 'Entregas del portal', d.entregas.length]] as const).map(([t, l, n]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-ink-500 hover:text-ink-800'}`}
              onClick={() => cambiarTab(t)}
            >
              {l} <span className={tab === t ? 'text-brand-600/60' : 'text-ink-400'}>{n}</span>
            </button>
          ))}
        </div>

        {tab === 'materias' && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-3">
            {d.materias.length === 0 && <div className="tarjeta p-6 text-ink-500 text-sm">No está inscrito en ninguna materia. Inscríbelo desde Alumnos (marcándolo) o desde la pestaña Alumnos de la materia.</div>}
            {d.materias.map(({ materia, fila, limites, evaluaciones }) => (
              <Link key={materia.id} to={`/materias/${materia.id}`} className="group tarjeta min-w-0 p-4 transition hover:border-ink-300 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 font-semibold">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: materia.color }} aria-hidden />
                    <span className="break-words">{materia.nombre}</span>
                    {materia.oculta ? <span className="shrink-0 text-xs font-normal text-ink-400">(oculta)</span> : null}
                  </div>
                  <span className={`chip shrink-0 whitespace-nowrap ${COLOR_RIESGO[fila.riesgo]}`}>{ETIQUETA_RIESGO[fila.riesgo]}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2 mt-3 text-sm">
                  <div><div className="text-xs text-ink-400">Asistencia</div><div className="font-medium">{fila.porcentaje_asistencia != null ? `${fila.porcentaje_asistencia}%` : '—'}</div><div className="text-xs text-ink-400">{fila.horas_falta} h de falta · límite {limites.limite} h</div></div>
                  {proyecciones[materia.id] ? (
                    <div><div className="text-xs text-ink-400">Calificación actual</div><div className="font-medium">{proyecciones[materia.id]!.al_ritmo_actual != null ? proyecciones[materia.id]!.al_ritmo_actual!.toFixed(1) : '—'}</div><div className="text-xs text-ink-400">al ritmo actual · {proyecciones[materia.id]!.evaluado_pct}% evaluado</div></div>
                  ) : (
                    <div><div className="text-xs text-ink-400">Promedio parcial</div><div className="font-medium">{fila.promedio_parcial != null ? fila.promedio_parcial.toFixed(1) : '—'}</div><div className="text-xs text-ink-400">{fila.puntos_obtenidos} de {fila.puntos_evaluados} pts</div></div>
                  )}
                  {(() => {
                    // Con tareas de Classroom, eso es lo que entrega; si no, las evaluaciones capturadas en la app
                    const suyas = d.tareas.filter((t) => t.materia_id === materia.id)
                    if (!suyas.length) return <div><div className="text-xs text-ink-400">Evaluaciones</div><div className="font-medium">{evaluaciones - fila.pendientes} de {evaluaciones}</div><div className="text-xs text-ink-400">{fila.pendientes} pendientes</div></div>
                    const hechas = suyas.filter((t) => t.estado === 'entrego' || t.estado === 'tarde').length
                    const faltan = suyas.filter((t) => t.estado === 'no_entrego').length
                    return <div><div className="text-xs text-ink-400">Tareas</div><div className="font-medium">{hechas} de {suyas.length} entregadas</div><div className="text-xs text-ink-400">{faltan ? `${faltan} sin entregar` : 'ninguna sin entregar'}</div></div>
                  })()}
                </div>
                {proyecciones[materia.id] && <EsquemaAlumno p={proyecciones[materia.id]!} />}
                {/* Las descargas aparecen al pasar el mouse o al llegar con el teclado: la tarjeta ya abre la materia */}
                <div className="mt-3 flex gap-1 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button className="btn-fantasma text-xs" onClick={(e) => { e.preventDefault(); api.exportar.reporteAlumnoPdf(materia.id, a.id).then((r) => r && avisar('Reporte PDF generado')) }}>Reporte PDF</button>
                  <button className="btn-fantasma text-xs" onClick={(e) => { e.preventDefault(); api.exportar.materiaXlsx(materia.id, a.id).then((r) => r && avisar('Excel generado')) }}>Excel</button>
                </div>
              </Link>
            ))}
          </div>
        )}

        {tab === 'asistencia' && (
          <div className="space-y-2.5">
            {d.asistencias.length > 0 &&
              barra(
                nombresAsis,
                matAsis,
                'Buscar por tema o nota',
                <Segmentado etiqueta="Estado de asistencia" valor={asisF} onCambio={setAsisF} opciones={FILTROS_ASISTENCIA.map(([k, t]) => ({ valor: k, texto: t, conteo: contar(asisBase, (x) => cumpleAsistencia(k, x.estado)) }))} />,
                asistencias.length,
                d.asistencias.length,
                'registros',
                hayFiltroAsis
              )}
            <div className="tarjeta overflow-x-auto">
              {asistencias.length === 0 ? (
                <SinResultados hayFiltro={hayFiltroAsis && d.asistencias.length > 0} onLimpiar={quitarFiltros} vacio="Sin registros de asistencia. Se capturan desde el Modo clase o en Asistencias." />
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
                    <tr>
                      <EncabezadoOrden campo="fecha" orden={ordenAsis} onOrden={setOrdenAsis}>Fecha</EncabezadoOrden>
                      <EncabezadoOrden campo="materia" orden={ordenAsis} onOrden={setOrdenAsis}>Materia</EncabezadoOrden>
                      <th className={thClase}>Sesión</th>
                      <th className={thClase}>Estado</th>
                      <th className={thClase}>Nota</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {asistencias.map((x) => (
                      <tr key={`${x.sesion_id}`} className="align-top hover:bg-ink-50/60">
                        <td className="px-3 py-2 whitespace-nowrap">{fechaMx(x.fecha, false)} <span className="text-ink-400">{x.hora_inicio}</span></td>
                        <td className="px-3 py-2"><span className="flex min-w-0 items-center gap-1.5"><span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: x.materia_color }} aria-hidden /><span className="break-words">{x.materia_nombre}</span></span></td>
                        <td className="px-3 py-2 text-ink-600 max-w-[16rem] truncate" title={x.tema}>{x.tema || <span className="text-ink-400">Sin tema</span>}</td>
                        <td className="px-3 py-2"><div className={`font-medium ${COLOR_ASISTENCIA[x.estado] ?? ''}`}>{ETIQUETA_ASISTENCIA[x.estado] ?? x.estado}</div><BotonJustificar o={{ sesionId: x.sesion_id, alumnoId: a.id, alumno: `${a.nombre} ${a.apellidos}`.trim(), fecha: fechaMx(x.fecha, false), estado: x.estado }} onCambio={cargar} /></td>
                        <td className="px-3 py-2 text-ink-500 break-words">{x.nota}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="text-xs text-ink-500">
              Una falta justificada no cuenta como hora de falta ni en la asistencia del parcial.
              {d.asistencias.length >= TOPE_ASISTENCIAS && ` Se muestran los ${TOPE_ASISTENCIAS} registros más recientes; el historial completo está en Asistencias de cada materia.`}
            </p>
          </div>
        )}

        {tab === 'calificaciones' && (
          <div className="space-y-2.5">
            <TareasDelAlumno tareas={d.tareas} />
            {d.tareas.length > 0 && <h3 className="pt-2 text-sm font-semibold text-ink-700">Evaluaciones de la app</h3>}
            {d.resultados.length > 0 &&
              barra(
                nombresCal,
                matCal,
                'Buscar por evaluación o comentario',
                estadosCal.length > 1 ? (
                  <Segmentado
                    etiqueta="Estado de la calificación"
                    valor={calSel}
                    onCambio={setCalF}
                    opciones={[{ valor: '', texto: 'Todos', conteo: calBase.length }, ...estadosCal.map((e) => ({ valor: e as string, texto: ETIQUETA_ESTADO[e] ?? e, conteo: contar(calBase, (r) => r.estado === e) }))]}
                  />
                ) : null,
                resultados.length,
                d.resultados.length,
                'evaluaciones',
                hayFiltroCal
              )}
            <div className="tarjeta overflow-x-auto">
              {resultados.length === 0 ? (
                <SinResultados
                  hayFiltro={hayFiltroCal && d.resultados.length > 0}
                  onLimpiar={quitarFiltros}
                  vacio={d.tareas.length ? 'Ninguna evaluación de la app calificada todavía (exámenes y actividades que capturas en cada evaluación).' : 'Sin calificaciones todavía. Se capturan en cada evaluación, pestaña Entregas y calificaciones, o llegan de Google Classroom.'}
                />
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
                    <tr>
                      <EncabezadoOrden campo="titulo" orden={ordenCal} onOrden={setOrdenCal}>Evaluación</EncabezadoOrden>
                      <EncabezadoOrden campo="materia" orden={ordenCal} onOrden={setOrdenCal}>Materia</EncabezadoOrden>
                      <EncabezadoOrden campo="fecha" orden={ordenCal} onOrden={setOrdenCal}>Aplica</EncabezadoOrden>
                      <th className={thClase}>Estado</th>
                      <th className={`${thClase} text-right`}>Puntaje</th>
                      <th className={thClase}>Comentario</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {resultados.map((r) => (
                      <tr key={r.id} className="align-top hover:bg-ink-50/60">
                        <td className="px-3 py-2 min-w-[12rem]"><Link to={`/evaluacion/${r.evaluacion_id}`} className="font-medium text-ink-900 break-words hover:underline">{r.titulo}</Link> <span className="whitespace-nowrap text-xs text-ink-400">{r.tipo.replace('_', ' ')}</span></td>
                        <td className="px-3 py-2 text-ink-600">{r.materia_nombre}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.fecha_aplicacion ? fechaMx(r.fecha_aplicacion, false) : <span className="text-ink-400">Sin fecha</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{ETIQUETA_ESTADO[r.estado] ?? r.estado}</td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{r.puntaje != null ? `${r.puntaje} / ${r.puntos_totales}` : `— / ${r.puntos_totales}`}</td>
                        <td className="px-3 py-2 text-ink-500 break-words">{r.comentario}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {tab === 'entregas' && (
          <div className="space-y-2.5">
            {d.entregas.length > 0 &&
              barra(
                nombresEnt,
                matEnt,
                'Buscar por actividad',
                <>
                  {estadosEnt.length > 1 && (
                    <Segmentado
                      etiqueta="Estado de la entrega"
                      valor={entSel}
                      onCambio={setEntF}
                      opciones={[{ valor: '', texto: 'Todas', conteo: entBase.length }, ...estadosEnt.map((e) => ({ valor: e, texto: ETIQUETA_ESTADO[e] ?? e, conteo: contar(entBase, (x) => x.estado === e) }))]}
                    />
                  )}
                  {d.entregas.some((e) => e.pendiente_manual) && <ChipFiltro activo={porRevisar} onClick={() => setPorRevisar(!porRevisar)} conteo={d.entregas.filter((e) => e.pendiente_manual).length}>Por revisar</ChipFiltro>}
                  {d.entregas.some((e) => e.eventos > 0) && <ChipFiltro activo={conAlertas} onClick={() => setConAlertas(!conAlertas)} conteo={d.entregas.filter((e) => e.eventos > 0).length} titulo="Entregas en las que el portal registró salidas de la pantalla u otras alertas">Con alertas</ChipFiltro>}
                </>,
                entregas.length,
                d.entregas.length,
                'entregas',
                hayFiltroEnt
              )}
            <div className="tarjeta overflow-x-auto">
              {entregas.length === 0 ? (
                <SinResultados hayFiltro={hayFiltroEnt && d.entregas.length > 0} onLimpiar={quitarFiltros} vacio="Sin entregas en el portal. Publica una evaluación para que pueda contestarla desde su celular." />
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
                    <tr>
                      <EncabezadoOrden campo="titulo" orden={ordenEnt} onOrden={setOrdenEnt}>Actividad</EncabezadoOrden>
                      <EncabezadoOrden campo="materia" orden={ordenEnt} onOrden={setOrdenEnt}>Materia</EncabezadoOrden>
                      <th className={thClase}>Estado</th>
                      <EncabezadoOrden campo="enviado" orden={ordenEnt} onOrden={setOrdenEnt}>Enviado</EncabezadoOrden>
                      <th className={thClase}>Tiempo activo</th>
                      <th className={thClase}>Alertas</th>
                      <th className={`${thClase} text-right`}>Puntaje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {entregas.map((e) => (
                      <tr key={e.id} className="align-top hover:bg-ink-50/60">
                        <td className="px-3 py-2 min-w-[12rem] font-medium text-ink-900 break-words">{e.titulo}</td>
                        <td className="px-3 py-2 text-ink-600">{e.materia_nombre}</td>
                        <td className="px-3 py-2">{ETIQUETA_ESTADO[e.estado] ?? e.estado}{e.pendiente_manual ? <span className="ml-1 whitespace-nowrap text-xs text-amber-700">· por revisar</span> : null}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{fechaMx(e.enviado_en)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{minutos(e.tiempo_activo_seg)}</td>
                        <td className={`px-3 py-2 ${e.eventos ? 'text-red-700 font-medium' : 'text-ink-400'}`}>{e.eventos}</td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{e.puntaje != null ? `${e.puntaje} / ${e.puntos_totales}` : e.puntaje_auto != null ? `${e.puntaje_auto} auto` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {d.entregas.length > 0 && <div className="px-3 py-2 text-xs text-ink-500 border-t border-ink-100">Para revisar respuestas y calificar a mano, abre la actividad desde Portal › Abrir panel docente › Entregas.</div>}
            </div>
          </div>
        )}
      </div>

      <Modal titulo="Editar alumno" abierto={!!form} onCerrar={() => setForm(null)} ancho="max-w-md">
        {form && (
          <div className="space-y-3">
            <label><span className="etiqueta">Matrícula (opcional)</span><input className="input" value={form.matricula ?? ''} onChange={(e) => setForm({ ...form, matricula: e.target.value })} /></label>
            <label><span className="etiqueta">Nombre(s)</span><input className="input" value={form.nombre ?? ''} onChange={(e) => setForm({ ...form, nombre: e.target.value })} /></label>
            <label><span className="etiqueta">Apellidos</span><input className="input" value={form.apellidos ?? ''} onChange={(e) => setForm({ ...form, apellidos: e.target.value })} /></label>
            <label><span className="etiqueta">Correo</span><input className="input" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label><span className="etiqueta">Carrera</span><select className="input" value={form.carrera_id ?? ''} onChange={(e) => setForm({ ...form, carrera_id: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{carreras.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!form.activo} onChange={(e) => setForm({ ...form, activo: e.target.checked ? 1 : 0 })} /> Activo</label>
            <div className="flex justify-end gap-2"><button className="btn-secundario" onClick={() => setForm(null)}>Cancelar</button><button className="btn-primario" onClick={guardar}>Guardar</button></div>
          </div>
        )}
      </Modal>

      <Modal titulo="Acceso al portal" abierto={!!credencial} onCerrar={() => setCredencial(null)} ancho="max-w-md">
        {credencial && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-600">Entrégale estos datos al alumno. El portal le pedirá cambiar la contraseña al entrar.</p>
            <div className="tarjeta p-4 grid grid-cols-2 gap-3">
              <div><div className="text-xs text-ink-400">Usuario</div><div className="font-mono text-lg select-all">{credencial.usuario}</div></div>
              <div><div className="text-xs text-ink-400">Contraseña inicial</div><div className="font-mono text-lg select-all">{credencial.password}</div></div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-secundario" onClick={() => { navigator.clipboard.writeText(`Usuario: ${credencial.usuario}\nContraseña: ${credencial.password}`); avisar('Copiado') }}>Copiar</button>
              <button className="btn-primario" onClick={() => setCredencial(null)}>Listo</button>
            </div>
          </div>
        )}
      </Modal>

      <ModalPassword
        abierto={borrar}
        titulo={`Eliminar a ${a.apellidos} ${a.nombre}`}
        advertencia="Se borran sus inscripciones, asistencias, calificaciones, entregas y su acceso al portal. No se puede deshacer."
        textoBoton="Eliminar alumno"
        onCerrar={() => setBorrar(false)}
        onConfirmar={async (password) => {
          await api.alumnos.eliminar(a.id, password)
          avisar('Alumno eliminado')
          nav('/alumnos')
        }}
      />
    </div>
  )
}

function Dato({ titulo, valor, nota, clase = '' }: { titulo: string; valor: string; nota?: string; clase?: string }): JSX.Element {
  return (
    <div className="tarjeta p-4">
      <div className="text-xs uppercase tracking-wide text-ink-400">{titulo}</div>
      <div className={`text-2xl font-semibold mt-1 ${clase ? `inline-block px-2 rounded text-base ${clase}` : ''}`}>{valor}</div>
      {nota && <div className="text-xs text-ink-400 mt-0.5">{nota}</div>}
    </div>
  )
}

/** Calificación de cada parcial con su desglose, y la proyección del alumno en la materia. */
function EsquemaAlumno({ p }: { p: ResumenProyeccion['alumnos'][number] }): JSX.Element {
  return (
    <div className="mt-3 border-t border-ink-100 pt-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-400">Proyección</span>
        <span className={`chip ${COLOR_CLASIFICACION[p.clasificacion]}`}>{p.etiqueta}</span>
        <span className="text-xs text-ink-500">acumulada {p.acumulada.toFixed(1)} · al ritmo actual {p.al_ritmo_actual == null ? '—' : p.al_ritmo_actual.toFixed(1)}</span>
      </div>
      {p.motivos.length > 0 && <div className="text-xs text-ink-600">{p.motivos.join(' ')}</div>}
      <div className="space-y-1.5">
        {p.parciales.map((x) => (
          <div key={x.nombre} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium w-32 shrink-0">{x.nombre}</span>
            <span className={`font-mono font-semibold ${x.estado === 'reprobado' || x.estado === 'na_inasistencia' ? 'text-red-600' : ''}`}>{x.calificacion == null ? 'pend.' : x.calificacion.toFixed(1)}</span>
            <span className={`chip ${COLOR_ESTADO[x.estado]}`}>{ETIQUETA_ESTADO_CALIF[x.estado]}{x.provisional && x.calificacion != null ? ' · prov.' : ''}</span>
            <span className="basis-full text-xs text-ink-500">{x.componentes.map((k) => `${k.nombre} ${nota1(k.valor)}`).join(' · ')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const ESTADO_TAREA: Record<DetalleAlumno['tareas'][number]['estado'], { t: string; c: string }> = {
  entrego: { t: '✓ Entregó', c: 'bg-emerald-50 text-emerald-800' },
  tarde: { t: '◷ Tarde', c: 'bg-amber-50 text-amber-800' },
  no_entrego: { t: '✕ No entregó', c: 'bg-red-50 text-red-700' },
  pendiente: { t: 'Pendiente', c: 'bg-ink-100 text-ink-600' },
  retirada: { t: '↺ La retiró', c: 'bg-violet-50 text-violet-800' },
  no_asignada: { t: '—', c: 'bg-ink-50 text-ink-400' }
}

/** Sus tareas de Google Classroom (agrupadas como en Alumnos × tareas) y lo que subió al portal: estado, calificación y entrega. */
function TareasDelAlumno({ tareas }: { tareas: DetalleAlumno['tareas'] }): JSX.Element | null {
  if (!tareas.length) return null
  const lista = [...tareas].sort((x, y) => (y.vence ?? '').localeCompare(x.vence ?? '') || ordenNatural(x.tarea, y.tarea))
  const entregadas = tareas.filter((t) => t.estado === 'entrego' || t.estado === 'tarde').length
  const tarde = tareas.filter((t) => t.estado === 'tarde').length
  const faltan = tareas.filter((t) => t.estado === 'no_entrego').length
  const conPuntos = tareas.filter((t) => t.calificacion !== null && t.puntos)
  const promedio = conPuntos.length ? Math.round((conPuntos.reduce((s, t) => s + t.calificacion! / t.puntos!, 0) / conPuntos.length) * 100) : null
  const variasMaterias = new Set(tareas.map((t) => t.materia_id)).size > 1
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-ink-700">Tareas (Google Classroom y portal)</h3>
        <span className="text-xs text-ink-500">
          {entregadas} de {tareas.length} entregadas{tarde ? ` · ${tarde} tarde` : ''}{faltan ? ` · ${faltan} sin entregar` : ''}
          {promedio !== null ? ` · promedio de lo calificado ${promedio} %` : ''}
        </span>
      </div>
      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2">Tarea</th>
              {variasMaterias && <th className="px-3 py-2">Materia</th>}
              <th className="px-3 py-2">Vence</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2 text-right">Calificación</th>
              <th className="px-3 py-2">Entregada</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((t, i) => {
              const nota = t.calificacion ?? t.borrador
              return (
                <tr key={`${t.materia_id}-${t.tarea}-${i}`} className="align-top hover:bg-ink-50/60">
                  <td className="min-w-[12rem] px-3 py-2">
                    <span className="break-words font-medium text-ink-900">{t.tarea}</span>
                    <span className="ml-1.5 whitespace-nowrap text-xs text-ink-400">
                      {[t.de_portal && 'subida al portal', t.recuperacion && 'por recuperación', t.veces > 1 && `entregada ${t.veces} veces`].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  {variasMaterias && <td className="px-3 py-2 text-ink-600">{t.materia_nombre}</td>}
                  <td className="whitespace-nowrap px-3 py-2 text-ink-600">{t.vence ? fechaMx(t.vence, false) : <span className="text-ink-400">Sin fecha</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2"><span className={`chip ${ESTADO_TAREA[t.estado].c}`}>{ESTADO_TAREA[t.estado].t}</span></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                    {nota !== null ? `${nota} / ${t.puntos ?? 100}` : <span className="text-ink-400">—</span>}
                    {t.calificacion === null && t.borrador !== null && <span className="ml-1 font-sans text-xs italic text-ink-400">borrador</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-600">{t.entregada ? fechaMx(t.entregada) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
