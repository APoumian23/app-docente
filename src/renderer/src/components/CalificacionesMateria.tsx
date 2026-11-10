import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, type CalificacionesEsquema } from '../lib/api'
import { avisar } from './Aviso'
import Markdown from './Markdown'
import { Buscador, ChipFiltro, Conteo, Segmentado, SinResultados, coincide, ordenNatural } from './Filtros'
import { useRecordado } from '../lib/recordado'
import { hoyIso, fmtFechaMx } from '../lib/tiempo'
import { ETIQUETA_ESTADO_CALIF, ETIQUETA_FUENTE, validarEsquema, type Componente, type EstadoCalif, type Esquema, type Fuente, type Parcial, type ResultadoParcial } from '@shared/esquema'
import { ETIQUETA_CLASIFICACION, SUPUESTOS_PROYECCION, ETIQUETA_NIVEL_FALTAS, alertaFaltas, type Clasificacion, type NivelFaltas, type ResumenProyeccion } from '@shared/proyeccion'
import type { Alumno } from '@shared/types'

export const COLOR_ESTADO: Record<EstadoCalif, string> = {
  aprobado: 'bg-green-100 text-green-700',
  reprobado: 'bg-red-100 text-red-700',
  na_inasistencia: 'bg-red-600 text-white',
  pendiente: 'bg-ink-100 text-ink-500'
}
export const COLOR_CLASIFICACION: Record<Clasificacion, string> = {
  va_aprobando: 'bg-green-100 text-green-700',
  en_riesgo: 'bg-amber-100 text-amber-800',
  reprobaria: 'bg-red-100 text-red-700',
  na_inasistencias: 'bg-red-600 text-white',
  sin_datos: 'bg-ink-100 text-ink-500'
}
export const COLOR_NIVEL_FALTAS: Record<NivelFaltas, string> = {
  alerta: 'bg-amber-100 text-amber-800',
  atencion: 'bg-orange-100 text-orange-800',
  extraordinario: 'bg-orange-500 text-white',
  titulo: 'bg-red-600 text-white',
  recursa: 'bg-red-900 text-white'
}
export const nota1 = (v: number | null | undefined): string => (v == null ? 'pend.' : (Math.round(v * 10) / 10).toFixed(1))
const nombreDe = (a: Alumno): string => `${a.apellidos} ${a.nombre}`.trim()

type Vista = { tipo: 'parcial'; i: number } | { tipo: 'final' } | { tipo: 'proyeccion' } | { tipo: 'asistencia' } | { tipo: 'esquema' }

// ---------------- Filtros de las tablas de alumnos ----------------
type OrdenCalif = 'alumno' | 'menor' | 'mayor'
const ORDENES_CALIF: [OrdenCalif, string][] = [['alumno', 'Alumno (A–Z)'], ['menor', 'Calificación, menor primero'], ['mayor', 'Calificación, mayor primero']]
/** Búsqueda y orden compartidos por parciales, final, captura y proyección: al cambiar de vista se conservan. */
interface FiltrosCalif {
  materiaId: number
  busqueda: string
  setBusqueda: (v: string) => void
  orden: OrdenCalif
  setOrden: (v: OrdenCalif) => void
}
const buscaAlumno = (q: string, a: { matricula?: string; nombre: string; apellidos?: string }): boolean => coincide(q, a.matricula, a.nombre, a.apellidos)
/** Ordena por calificación según el orden elegido; lo que aún no tiene dato va al final en ambos sentidos. */
function ordenarPor<T>(lista: T[], o: OrdenCalif, calif: (x: T) => number | null | undefined, nombre: (x: T) => string): T[] {
  return [...lista].sort((x, y) => {
    if (o !== 'alumno') {
      const a = calif(x)
      const b = calif(y)
      if (a == null || b == null) {
        if (a != null || b != null) return a == null ? 1 : -1
      } else if (a !== b) return o === 'menor' ? a - b : b - a
    }
    return ordenNatural(nombre(x), nombre(y))
  })
}

/** Barra de filtros de las tablas: buscador, lo propio de cada vista (children), orden y conteo. */
function BarraAlumnos({ f, visibles, total, hayFiltro, onLimpiar, sinOrden = false, children }: { f: FiltrosCalif; visibles: number; total: number; hayFiltro: boolean; onLimpiar: () => void; sinOrden?: boolean; children?: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filtrar alumnos">
      <Buscador valor={f.busqueda} onCambio={f.setBusqueda} placeholder="Buscar por matrícula o nombre" etiqueta="Buscar alumnos" />
      {children}
      {!sinOrden && (
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-500">
          Ordenar
          <select className="input w-auto py-1" value={f.orden} onChange={(e) => f.setOrden(e.target.value as OrdenCalif)} aria-label="Ordenar alumnos">
            {ORDENES_CALIF.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </label>
      )}
      {hayFiltro && <button className="btn-fantasma text-xs" onClick={onLimpiar}>Quitar filtros</button>}
      <Conteo visibles={visibles} total={total} nombre="alumnos" hayFiltro={hayFiltro} />
    </div>
  )
}

/** Fila de «nada coincide» (o vacío) dentro de una tabla. */
function FilaVacia({ columnas, hayFiltro, onLimpiar, vacio }: { columnas: number; hayFiltro: boolean; onLimpiar: () => void; vacio: ReactNode }): JSX.Element {
  return (
    <tr>
      <td colSpan={columnas}>
        <SinResultados hayFiltro={hayFiltro} onLimpiar={onLimpiar} vacio={vacio} />
      </td>
    </tr>
  )
}

/**
 * Pestaña Calificaciones de una materia: calificación por parcial con el esquema del maestro (desglose
 * por componente), final, proyección, captura de lo manual y el editor del esquema. La vista de
 * asistencia por horas (comunicado COM-AS-01) se recibe ya armada.
 */
export default function CalificacionesMateria({ materiaId, asistencia }: { materiaId: number; asistencia: ReactNode }): JSX.Element {
  const [c, setC] = useState<CalificacionesEsquema | null>(null)
  const [pr, setPr] = useState<ResumenProyeccion | null>(null)
  const [vista, setVista] = useState<Vista | null>(null)
  const [borrador, setBorrador] = useState<Esquema | null>(null)
  const [error, setError] = useState('')
  // Se recuerdan por materia: al ir a la ficha de un alumno y regresar siguen igual
  const [busqueda, setBusqueda] = useRecordado(`calif.${materiaId}.busqueda`, '')
  const [orden, setOrden] = useRecordado<OrdenCalif>(`calif.${materiaId}.orden`, 'alumno')
  const f: FiltrosCalif = { materiaId, busqueda, setBusqueda, orden, setOrden }

  const traerDeClassroom = async (orden: number): Promise<void> => {
    try {
      const r = await api.classroom.aCalificaciones(materiaId, orden)
      if (!r.tareas.length) {
        avisar(`Ninguna tarea de Classroom se llama como los componentes de este parcial${r.sin_tarea.length ? ` (${r.sin_tarea.join(', ')})` : ''}. Agrúpalas con ese nombre en la pantalla de Classroom › Agrupar tareas.`, 'error')
        return
      }
      avisar(`Listo: ${r.tareas.join(', ')} desde Classroom (${r.capturas} capturas).${r.respetadas ? ` Se respetaron ${r.respetadas} que capturaste a mano y que Classroom marca sin entregar.` : ''}${r.sin_tarea.length ? ` Sin tarea en Classroom: ${r.sin_tarea.join(', ')}.` : ''}`)
      await cargar()
    } catch (err) {
      avisar((err as Error).message, 'error')
    }
  }
  const cargar = async (): Promise<void> => {
    const [d, p] = await Promise.all([api.calificaciones.esquema(materiaId), api.calificaciones.proyeccion(materiaId)])
    setC(d)
    setPr(p)
    // Al entrar se abre el parcial en curso (o el último que ya empezó)
    setVista((v) => {
      if (v) return v
      if (!d.esquema) return { tipo: 'asistencia' }
      const hoy = hoyIso()
      const i = d.esquema.parciales.findIndex((x) => x.desde <= hoy && hoy <= x.hasta)
      const ultimo = d.esquema.parciales.map((x) => x.desde <= hoy).lastIndexOf(true)
      return { tipo: 'parcial', i: i >= 0 ? i : Math.max(0, ultimo) }
    })
  }
  useEffect(() => {
    cargar().catch((e) => setError((e as Error).message))
    // Al volver a la ventana se vuelve a leer: Classroom pudo conectarse o sincronizarse mientras tanto
    const alVolver = (): void => void cargar().catch(() => undefined)
    window.addEventListener('focus', alVolver)
    return () => window.removeEventListener('focus', alVolver)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materiaId])

  if (error) return <div className="tarjeta p-6 text-red-600">{error}</div>
  if (!c || !vista) return <div className="text-ink-500">Calculando…</div>
  const e = c.esquema

  const abrirEditor = async (): Promise<void> => {
    try {
      setBorrador(e ? structuredClone(e) : await api.esquema.porOmision(materiaId))
      setVista({ tipo: 'esquema' })
    } catch (err) {
      avisar((err as Error).message, 'error')
    }
  }
  // Las vistas van en un selector segmentado; «parcial:N» identifica a cada parcial
  const claveVista = vista.tipo === 'parcial' ? `parcial:${vista.i}` : vista.tipo
  const opcionesVista = [
    ...(e?.parciales.map((p, i) => ({ valor: `parcial:${i}`, texto: p.nombre })) ?? []),
    ...(e ? [{ valor: 'final', texto: 'Final' }, { valor: 'proyeccion', texto: 'Proyección' }] : []),
    { valor: 'asistencia', texto: 'Asistencia y faltas' }
  ]
  const elegirVista = (v: string): void => {
    if (v.startsWith('parcial:')) setVista({ tipo: 'parcial', i: Number(v.slice(8)) })
    else setVista({ tipo: v as 'final' | 'proyeccion' | 'asistencia' })
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmentado etiqueta="Vista de calificaciones" valor={claveVista} onCambio={elegirVista} opciones={opcionesVista} />
        <button className={e ? `btn-fantasma ${vista.tipo === 'esquema' ? 'bg-ink-100 text-ink-900' : ''}` : 'btn-secundario'} aria-pressed={vista.tipo === 'esquema'} onClick={abrirEditor} title="Parciales, componentes y pesos con que se califica">
          {e ? 'Esquema' : '+ Crear esquema'}
        </button>
        {/* Solo donde hay tareas capturadas a mano: en los parciales con componentes de Classroom, Classroom ya entra solo */}
        {e && vista.tipo === 'parcial' && e.parciales[vista.i].componentes.some((k) => k.fuente === 'manual' && (k.rubros.length > 0 || /tarea/i.test(k.nombre))) &&
          !e.parciales[vista.i].componentes.some((k) => k.fuente.startsWith('classroom')) && (
          <button className="btn-secundario ml-auto" onClick={() => traerDeClassroom(e.parciales[vista.i].orden)} title="Entregó / no entregó y calificación de las tareas consolidadas de Classroom, en los componentes que se llamen igual">
            Traer tareas de Classroom
          </button>
        )}
        <button className={`btn-secundario ${e && vista.tipo === 'parcial' ? '' : 'ml-auto'}`} onClick={() => api.exportar.todoXlsx(materiaId).then((r) => r && avisar('Excel exportado'))}>Exportar todo (Excel)</button>
      </div>

      {!e && vista.tipo !== 'esquema' && (
        <div className="tarjeta p-4 text-sm text-ink-600 flex flex-wrap items-center justify-between gap-3">
          <span>Esta materia no tiene esquema de calificación: por ahora solo se ve la asistencia. Con un esquema (parciales y componentes con peso) la app califica como tú.</span>
          <button className="btn-primario" onClick={abrirEditor}>Crear esquema</button>
        </div>
      )}

      {vista.tipo === 'asistencia' && asistencia}
      {e && vista.tipo === 'parcial' && e.parciales[vista.i] && <VistaParcial c={c} e={e} i={vista.i} materiaId={materiaId} f={f} onCambio={cargar} />}
      {e && vista.tipo === 'final' && <VistaFinal c={c} e={e} materiaId={materiaId} f={f} onCambio={cargar} />}
      {e && vista.tipo === 'proyeccion' && pr && (
        <div className="space-y-4">
          <AnalisisIA materiaId={materiaId} />
          <VistaProyeccion pr={pr} f={f} />
        </div>
      )}
      {vista.tipo === 'esquema' && borrador && (
        <EditorEsquema
          inicial={borrador}
          evaluaciones={c.evaluaciones}
          nuevo={!e}
          onCancelar={() => setVista(e ? { tipo: 'parcial', i: 0 } : { tipo: 'asistencia' })}
          onGuardado={async () => {
            setVista(null)
            await cargar()
          }}
        />
      )}
    </div>
  )
}

function ChipEstado({ estado, provisional, evaluado }: { estado: EstadoCalif; provisional?: boolean; evaluado?: number }): JSX.Element {
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className={`chip whitespace-nowrap ${COLOR_ESTADO[estado]}`}>{ETIQUETA_ESTADO_CALIF[estado]}</span>
      {provisional && evaluado != null && evaluado > 0 && <span className="text-[11px] text-ink-400">provisional · {evaluado} % evaluado</span>}
    </span>
  )
}

// ---------------- Un parcial ----------------
type EstadoParcialF = 'todos' | 'aprobados' | 'abajo' | 'en_curso' | 'pendientes'
const ESTADOS_PARCIAL_F: [EstadoParcialF, string][] = [['todos', 'Todos'], ['en_curso', 'En curso'], ['aprobados', 'Aprobados'], ['abajo', 'Abajo de la mínima'], ['pendientes', 'Pendientes']]
/** Mientras falta algo por evaluar se ve «En curso» (con lo que necesita), no el estado al ritmo actual. */
const enCursoParcial = (r: ResultadoParcial): boolean => r.provisional && !r.ajustada && r.estado !== 'na_inasistencia' && r.evaluado > 0
const categoriaParcial = (r: ResultadoParcial): EstadoParcialF =>
  enCursoParcial(r) ? 'en_curso' : r.estado === 'aprobado' ? 'aprobados' : r.estado === 'pendiente' ? 'pendientes' : 'abajo'

function VistaParcial({ c, e, i, materiaId, f, onCambio }: { c: CalificacionesEsquema; e: Esquema; i: number; materiaId: number; f: FiltrosCalif; onCambio: () => Promise<void> }): JSX.Element {
  const p = e.parciales[i]
  const capturables = p.componentes.filter((k) => k.fuente !== 'asistencia')
  const [capturando, setCapturando] = useState<number | null>(null)
  useEffect(() => setCapturando(null), [p.id])
  const comp = capturables.find((k) => k.id === capturando) ?? null
  const [estadoF, setEstadoF] = useRecordado<EstadoParcialF>(`calif.${materiaId}.parcial.estado`, 'todos')
  const filas = c.alumnos.map((a) => ({ a, r: c.resultados.find((x) => x.alumno_id === a.id)!.parciales[i] }))
  const buscados = filas.filter((x) => buscaAlumno(f.busqueda, x.a))
  const lista = ordenarPor(
    buscados.filter((x) => estadoF === 'todos' || categoriaParcial(x.r) === estadoF),
    f.orden,
    (x) => x.r.calificacion,
    (x) => nombreDe(x.a)
  )
  const hayFiltro = !!f.busqueda.trim() || estadoF !== 'todos'
  const quitarFiltros = (): void => {
    f.setBusqueda('')
    setEstadoF('todos')
  }
  // Solo cuenta a quien ya no puede cambiar: mientras falta algo, «al ritmo actual» no es reprobado todavía
  const reprobados = c.resultados.filter((r) => (r.parciales[i].estado === 'reprobado' && (!r.parciales[i].provisional || r.parciales[i].ajustada)) || r.parciales[i].estado === 'na_inasistencia').length
  const pesoTotal = p.componentes.reduce((s, k) => s + k.peso, 0) || 100
  /** Puntos que el alumno ya ganó (sobre 10), lo que se podía ganar con lo evaluado y lo que necesita en lo que falta */
  const llevaDe = (r: ResultadoParcial): { lleva: number; posible: number; necesita: number | null } => {
    const lleva = r.componentes.reduce((s, v) => {
      const k = p.componentes.find((x) => x.id === v.componente_id)
      return v.valor == null || !k ? s : s + (v.valor * k.peso) / pesoTotal
    }, 0)
    const posible = r.evaluado / 10
    const resta = (100 - r.evaluado) / 100
    return { lleva, posible, necesita: resta > 0.001 ? (e.minima - lleva) / resta : null }
  }
  // Avisos de datos que faltan: cambian lo que la app dice del parcial
  const deClassroom = p.componentes.filter((k) => (k.fuente === 'classroom_promedio' || k.fuente === 'classroom_entregas') && k.peso > 0)
  const pesoClassroom = deClassroom.reduce((s, k) => s + k.peso, 0)
  const sinLista = c.sesiones_sin_lista.filter((f) => f >= p.desde && f <= p.hasta)
  const sinLigar = c.alumnos.filter((a) => c.classroom.sin_ligar.includes(a.id))

  return (
    <div className="space-y-3">
      <div className="tarjeta p-4 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="font-semibold">{p.nombre} <span className="font-normal text-sm text-ink-500">· {fmtFechaMx(p.desde, false)} – {fmtFechaMx(p.hasta, false)}</span></div>
            <div className="text-xs text-ink-500">Mínima aprobatoria {e.minima.toFixed(1)}{e.asistencia_minima != null ? ` · asistencia mínima ${e.asistencia_minima} % (si no, NA por inasistencias)` : ''} · {reprobados} {reprobados === 1 ? 'alumno abajo' : 'alumnos abajo'} de la mínima</div>
          </div>
          <label className="flex items-center gap-2 text-sm" title="Los alumnos ven este parcial en «Mi avance» del portal: su calificación con el detalle de cada parte. Mientras no lo publiques ven «En captura».">
            <input
              type="checkbox"
              checked={p.publicado === 1}
              onChange={(ev) =>
                api.esquema
                  .publicarParcial(p.id, ev.target.checked)
                  .then(() => onCambio())
                  .then(() => avisar(ev.target.checked ? `${p.nombre} publicado: los alumnos ya lo ven en «Mi avance»` : `${p.nombre} oculto a los alumnos`))
                  .catch((e) => avisar((e as Error).message, 'error'))
              }
            />
            Publicado a los alumnos
          </label>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="etiqueta">Capturar</span>
            <select className="input w-auto" value={capturando ?? ''} onChange={(ev) => setCapturando(ev.target.value ? Number(ev.target.value) : null)}>
              <option value="">Ver calificaciones</option>
              {capturables.map((k) => <option key={k.id} value={k.id}>{k.nombre}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {p.componentes.map((k) => (
            <span key={k.id} className="chip whitespace-nowrap bg-ink-50 border border-ink-200 text-ink-600" title={ETIQUETA_FUENTE[k.fuente]}>{k.nombre} · {k.peso} %</span>
          ))}
        </div>
        {deClassroom.length > 0 && !c.classroom.conectado && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
            <b>Classroom no está conectado:</b> {deClassroom.map((k) => k.nombre).join(' y ')} ({Math.round(pesoClassroom * 10) / 10} % del parcial) no tienen de dónde leer, así que el estado queda en «Pendiente».{' '}
            <Link className="underline" to={`/classroom?materia=${materiaId}`}>Conecta Classroom</Link> o captúralos a mano en «Capturar».
          </div>
        )}
        {deClassroom.length > 0 && sinLigar.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
            <b>{sinLigar.length === 1 ? '1 alumno no está ligado' : `${sinLigar.length} alumnos no están ligados`} a Classroom</b> ({sinLigar.map(nombreDe).join(', ')}): sus tareas no se cuentan.{' '}
            <Link className="underline" to={`/classroom?materia=${materiaId}`}>Lígalos en Classroom</Link> o captura a mano.
          </div>
        )}
        {sinLista.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
            <b>{sinLista.length === 1 ? '1 sesión ya pasó' : `${sinLista.length} sesiones ya pasaron`} sin pase de lista</b> ({sinLista.map((f) => fmtFechaMx(f, false)).join(', ')}): la asistencia del parcial se calcula solo con los días registrados. <Link className="underline" to={`/asistencias?materia=${materiaId}`}>Captúralas en Asistencias</Link> o márcalas canceladas si no hubo clase.
          </div>
        )}
        <p className="text-xs text-ink-500">Componentes en escala de 0 a 10 (pasa el cursor para ver el detalle). <b>pend.</b> = aún sin datos: no cuenta como cero, la calificación se reparte entre lo ya evaluado y se marca como provisional. Para que algo cuente cero, captúralo en 0 o como «no entregó».</p>
      </div>

      {comp ? (
        <Captura c={c} p={p} k={comp} materiaId={materiaId} f={f} onCambio={onCambio} onCerrar={() => setCapturando(null)} />
      ) : (
        <>
          {c.alumnos.length > 0 && (
            <BarraAlumnos f={f} visibles={lista.length} total={c.alumnos.length} hayFiltro={hayFiltro} onLimpiar={quitarFiltros}>
              <Segmentado
                etiqueta="Estado en el parcial"
                valor={estadoF}
                onCambio={setEstadoF}
                opciones={ESTADOS_PARCIAL_F.map(([k, t]) => ({ valor: k, texto: t, conteo: buscados.filter((x) => k === 'todos' || categoriaParcial(x.r) === k).length })).filter((o) => o.valor === 'todos' || o.valor === estadoF || o.conteo > 0)}
              />
            </BarraAlumnos>
          )}
          <div className="tarjeta overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-3 py-2">Alumno</th>
                  {p.componentes.map((k) => <th key={k.id} className="px-2 py-2 text-center normal-case font-semibold">{k.nombre}<div className="font-normal text-ink-400">{k.peso} %</div></th>)}
                  <th className="px-3 py-2 text-center" title="Puntos que ya ganó, sobre 10: lo que falta evaluar todavía no suma">Lleva<div className="font-normal normal-case text-ink-400">de 10</div></th>
                  <th className="px-3 py-2 text-center" title="Si falta algo por evaluar, es la calificación si sigue igual en lo que falta">Calif.<div className="font-normal normal-case text-ink-400">al ritmo actual</div></th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {lista.map(({ a, r }) => {
                  const ll = llevaDe(r)
                  const enCurso = enCursoParcial(r)
                  return (
                    <tr key={a.id} className="hover:bg-ink-50/70">
                      <td className="px-3 py-2"><Link to={`/alumnos/${a.id}`} className="font-medium hover:underline">{nombreDe(a)}</Link><div className="text-xs text-ink-400">{r.asistencia != null ? `asistencia ${Math.round(r.asistencia)} %` : 'sin asistencia'}</div></td>
                      {r.componentes.map((v) => {
                        const k = p.componentes.find((x) => x.id === v.componente_id)!
                        // Las partes de captura manual se capturan en su vista; las calculadas se pueden poner a mano aquí
                        if (k.fuente === 'manual')
                          return (
                            <td key={v.componente_id} className="px-2 py-2 text-center">
                              <button className={`rounded px-1.5 py-0.5 font-mono hover:bg-ink-100 ${v.valor == null ? 'text-ink-300' : ''}`} title={`${v.detalle}. Clic para capturar ${k.nombre}.`} onClick={() => setCapturando(k.id)}>
                                {nota1(v.valor)}
                              </button>
                            </td>
                          )
                        const aMano = /\(a mano\)/.test(v.detalle)
                        return (
                          <td key={v.componente_id} className={`px-2 py-2 text-center ${v.valor == null ? 'text-ink-300' : ''}`}>
                            <NotaEditable
                              valor={v.valor}
                              ajustada={aMano}
                              conNota={false}
                              ayuda={v.detalle}
                              etiqueta={`${k.nombre} de ${nombreDe(a)}`}
                              onGuardar={async (nuevo) => {
                                // En las partes de Classroom se guarda sobre su escala; en las demás, sobre 10
                                const escala = k.fuente.startsWith('classroom') && k.escala > 0 ? k.escala : 10
                                await api.calificaciones.guardarCaptura({ componente_id: k.id, alumno_id: a.id, rubro: 0, valor: nuevo == null ? null : (nuevo * escala) / 10, ...(nuevo == null ? { entregado: null } : {}) })
                                await onCambio()
                              }}
                            />
                          </td>
                        )
                      })}
                      <td className="px-2 py-2 text-center">
                        <div className="font-mono text-lg font-semibold">{r.evaluado > 0 ? ll.lleva.toFixed(1) : '—'}</div>
                        {enCurso && <div className="text-[11px] text-ink-400">de {ll.posible.toFixed(ll.posible % 1 ? 2 : 0)} posibles</div>}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <NotaEditable
                          grande
                          valor={r.calificacion}
                          ajustada={!!r.ajustada}
                          calculada={r.ajustada?.calculada}
                          nota={r.ajustada?.nota}
                          color={r.estado === 'reprobado' || r.estado === 'na_inasistencia' ? 'text-red-600' : r.provisional ? 'text-ink-400' : ''}
                          ayuda={r.provisional ? `Provisional: ${r.evaluado} % del peso evaluado` : undefined}
                          etiqueta={`Calificación del ${p.nombre} de ${nombreDe(a)}`}
                          onGuardar={async (v, nota) => {
                            await api.esquema.ajustarParcial(p.id, a.id, v, nota)
                            await onCambio()
                            avisar(v == null ? `${nombreDe(a)}: vuelve a la calificación calculada` : `${nombreDe(a)}: ${p.nombre} puesto a mano (${v.toFixed(1)})`)
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        {enCurso ? (
                          <span className="inline-flex flex-col items-start gap-0.5">
                            <span className="chip whitespace-nowrap bg-ink-100 text-ink-700">En curso</span>
                            <span className="text-[11px] text-ink-500">
                              {ll.necesita == null
                                ? `${r.evaluado} % evaluado`
                                : ll.necesita <= 0
                                  ? 'ya aprueba aunque saque 0 en lo que falta'
                                  : ll.necesita > 10
                                    ? 'no alcanza la mínima aunque saque 10'
                                    : `necesita ${ll.necesita.toFixed(1)} en lo que falta (${Math.round((100 - r.evaluado) * 10) / 10} %)`}
                            </span>
                          </span>
                        ) : (
                          <ChipEstado estado={r.estado} provisional={r.provisional} evaluado={r.evaluado} />
                        )}
                      </td>
                    </tr>
                  )
                })}
                {lista.length === 0 && <FilaVacia columnas={p.componentes.length + 4} hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos en la materia." />}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Una calificación que calcula la app pero el docente puede poner a mano (redondeo, trabajo extra,
 * decisión de academia). Se ve la marca ✎ y lo que daba el cálculo; «Usar el cálculo» lo regresa.
 * Sirve para cada parte del parcial, el parcial completo y la final.
 */
function NotaEditable({
  valor,
  ajustada,
  calculada,
  nota: notaInicial = '',
  conNota = true,
  color = '',
  ayuda,
  etiqueta,
  grande = false,
  onGuardar
}: {
  valor: number | null
  ajustada: boolean
  calculada?: number | null
  nota?: string
  conNota?: boolean
  color?: string
  ayuda?: string
  etiqueta: string
  grande?: boolean
  onGuardar: (v: number | null, nota: string) => Promise<void>
}): JSX.Element {
  const [editando, setEditando] = useState(false)
  const [texto, setTexto] = useState('')
  const [nota, setNota] = useState('')
  const abrir = (): void => {
    setTexto(valor == null ? '' : String(Math.round(valor * 10) / 10))
    setNota(notaInicial)
    setEditando(true)
  }
  const leer = (): number | null => {
    const n = Number(texto.trim().replace(',', '.'))
    return texto.trim() === '' || Number.isNaN(n) || n < 0 || n > 10 ? null : n
  }
  const guardar = async (v: number | null): Promise<void> => {
    try {
      await onGuardar(v, nota)
      setEditando(false)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const confirmar = (): void => {
    const v = leer()
    if (v == null) avisar('Escribe una calificación entre 0 y 10', 'error')
    else void guardar(v)
  }
  if (!editando)
    return (
      <button
        className={`rounded px-1.5 py-0.5 hover:bg-ink-100 font-mono ${grande ? 'font-semibold text-base' : ''} ${color}`}
        onClick={abrir}
        title={ajustada ? `Puesta a mano${notaInicial ? `: ${notaInicial}` : ''} · el cálculo daba ${calculada == null ? '—' : calculada.toFixed(1)}. Clic para cambiarla.` : `${ayuda ? `${ayuda}. ` : ''}Clic para ponerla a mano.`}
      >
        {valor == null ? (grande ? '—' : 'pend.') : valor.toFixed(1)}
        {ajustada && <span className="ml-0.5 text-xs text-brand-600" aria-label="puesta a mano">✎</span>}
        {ajustada && calculada !== undefined && <div className="text-[10px] font-normal font-sans text-ink-400">cálculo {calculada == null ? '—' : calculada.toFixed(1)}</div>}
      </button>
    )
  return (
    <div className="flex flex-col items-center gap-1 min-w-[9rem]">
      <input
        className="input w-20 text-center font-mono"
        inputMode="decimal"
        autoFocus
        aria-label={`${etiqueta} (0 a 10)`}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditando(false)
          if (e.key === 'Enter') confirmar()
        }}
      />
      {conNota && <input className="input w-full text-xs" placeholder="Motivo (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} aria-label="Motivo del ajuste" />}
      <div className="flex flex-wrap justify-center gap-1">
        <button className="btn-primario text-xs px-2 py-1" onClick={confirmar}>Guardar</button>
        {ajustada && <button className="btn-secundario text-xs px-2 py-1" onClick={() => void guardar(null)}>Usar el cálculo</button>}
        <button className="btn-fantasma text-xs px-2 py-1" onClick={() => setEditando(false)}>Cancelar</button>
      </div>
    </div>
  )
}

/** Número que se guarda al salir del campo o con Enter. Vacío = sin capturar. */
function CampoNumero({ valor, max, etiqueta, onGuardar }: { valor: number | null; max: number; etiqueta: string; onGuardar: (v: number | null) => void }): JSX.Element {
  const [t, setT] = useState(valor == null ? '' : String(valor))
  useEffect(() => setT(valor == null ? '' : String(valor)), [valor])
  const salir = (): void => {
    const limpio = t.trim().replace(',', '.')
    const v = limpio === '' ? null : Number(limpio)
    if (v != null && (Number.isNaN(v) || v < 0 || v > max)) {
      avisar(`${etiqueta}: escribe un número entre 0 y ${max}`, 'error')
      setT(valor == null ? '' : String(valor))
      return
    }
    if (v !== valor) onGuardar(v)
  }
  return <input className="input w-20 text-right font-mono" inputMode="decimal" aria-label={etiqueta} value={t} onChange={(ev) => setT(ev.target.value)} onBlur={salir} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
}

type CapturaF = 'todos' | 'sin' | 'con'

function Captura({ c, p, k, materiaId, f, onCambio, onCerrar }: { c: CalificacionesEsquema; p: Parcial; k: Componente; materiaId: number; f: FiltrosCalif; onCambio: () => Promise<void>; onCerrar: () => void }): JSX.Element {
  const deClassroom = k.fuente === 'classroom_promedio' || k.fuente === 'classroom_entregas'
  // En los componentes de Classroom se puede capturar a mano un valor que reemplaza a Classroom para ese alumno
  const rubros = k.fuente === 'manual' ? (k.rubros.length ? k.rubros : ['Calificación']) : deClassroom ? ['A mano (opcional)'] : []
  const iParcial = c.esquema!.parciales.findIndex((x) => x.id === p.id)
  const cap = (alumno: number, rubro: number) => c.capturas.find((x) => x.componente_id === k.id && x.alumno_id === alumno && x.rubro === rubro)
  // Solo se manda el campo que cambió: el proceso principal conserva los demás (dos capturas seguidas no se pisan)
  const guardar = async (alumno: number, rubro: number, cambios: { valor?: number | null; entregado?: number | null; extra?: number | null }): Promise<void> => {
    try {
      await api.calificaciones.guardarCaptura({ componente_id: k.id, alumno_id: alumno, rubro, ...cambios })
      await onCambio()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  // Participaciones anotadas desde aquí: con la fecha de hoy si cae en el parcial, si no con la de su último día
  const hoy = hoyIso()
  const fechaParticipacion = hoy < p.desde ? p.desde : hoy > p.hasta ? p.hasta : hoy
  const participaciones = (alumno: number): number => c.participaciones.filter((x) => x.alumno_id === alumno && x.fecha >= p.desde && x.fecha <= p.hasta).length
  const cambiarParticipacion = async (alumno: number, mas: boolean): Promise<void> => {
    try {
      if (mas) await api.participaciones.agregar(materiaId, alumno, null, fechaParticipacion)
      else await api.participaciones.quitar(materiaId, alumno, null, p.desde, p.hasta)
      await onCambio()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const conExtra = k.fuente === 'manual' || k.fuente === 'evaluaciones' || deClassroom

  const [capturaF, setCapturaF] = useRecordado<CapturaF>(`calif.${materiaId}.captura.filtro`, 'todos')
  const valorDe = (alumno: number): ResultadoParcial['componentes'][number] =>
    c.resultados.find((x) => x.alumno_id === alumno)!.parciales[iParcial].componentes.find((x) => x.componente_id === k.id)!
  const buscados = c.alumnos.filter((a) => buscaAlumno(f.busqueda, a))
  const enFiltro = (a: Alumno, filtro: CapturaF): boolean => filtro === 'todos' || (filtro === 'sin' ? valorDe(a.id).valor == null : valorDe(a.id).valor != null)
  // Quién entra en «Sin calificación» se decide al elegir el filtro, no con cada captura: así el alumno
  // no desaparece de la tabla mientras se le escribe la calificación
  const claveAlumnos = c.alumnos.map((a) => a.id).join(',')
  const lista = useMemo(
    () => ordenarPor(buscados.filter((a) => enFiltro(a, capturaF)), f.orden, (a) => valorDe(a.id).valor, nombreDe),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capturaF, f.busqueda, f.orden, k.id, iParcial, claveAlumnos]
  )
  const hayFiltro = !!f.busqueda.trim() || capturaF !== 'todos'
  const quitarFiltros = (): void => {
    f.setBusqueda('')
    setCapturaF('todos')
  }

  return (
    <div className="space-y-3">
      {c.alumnos.length > 0 && (
        <BarraAlumnos f={f} visibles={lista.length} total={c.alumnos.length} hayFiltro={hayFiltro} onLimpiar={quitarFiltros}>
          <Segmentado
            etiqueta="Captura"
            valor={capturaF}
            onCambio={setCapturaF}
            opciones={([['todos', 'Todos'], ['sin', 'Sin calificación'], ['con', 'Con calificación']] as [CapturaF, string][]).map(([v, t]) => ({ valor: v, texto: t, conteo: buscados.filter((a) => enFiltro(a, v)).length }))}
          />
        </BarraAlumnos>
      )}
      <div className="tarjeta overflow-x-auto">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 border-b border-ink-100 text-sm text-ink-600">
          <p className="min-w-0 flex-[1_1_20rem]">
            <b>{k.nombre}</b> ({k.peso} %) ·{' '}
            {k.fuente === 'manual' && <>captura sobre {k.escala}{rubros.length > 1 ? `; cuenta el promedio de ${rubros.join(' y ')}` : ''}. «No entregó» cuenta cero aunque tenga calificación. Se guarda al salir de cada campo.</>}
            {k.fuente === 'evaluaciones' && <>sale de {k.evaluaciones.length === 1 ? 'la evaluación elegida' : `${k.evaluaciones.length} evaluaciones`} (califícalas en cada evaluación). Aquí solo agregas décimas extra (tope 10).</>}
            {k.fuente === 'actividades' && <>se calcula solo con las entregas registradas en las evaluaciones del parcial. No hay nada que capturar aquí.</>}
            {k.fuente === 'participacion' && <>{k.meta} participaciones = 100 %. También se anotan con «+1» en el pase de lista del Modo clase.</>}
            {k.fuente === 'classroom_promedio' && <>promedio de TODAS las tareas de Classroom con fecha dentro del parcial (duplicados y recuperaciones ya juntos): no entregada = 0 (al cerrar el parcial también lo que siga pendiente o retirado); entregada sin calificar queda pendiente. Se actualiza al sincronizar Classroom. Lo que captures a mano reemplaza a Classroom para ese alumno (por ejemplo, si te la mandó por correo o Classroom no está conectado).</>}
            {k.fuente === 'classroom_entregas' && <>porcentaje de trabajos de Classroom del parcial que entregó, de los que ya vencieron (al cerrar el parcial, todos). Se actualiza al sincronizar Classroom. Lo que captures a mano (sobre {k.escala}) reemplaza a Classroom para ese alumno.</>}
          </p>
          <button className="btn-secundario shrink-0 text-xs py-1" onClick={onCerrar}>Ver calificaciones del parcial</button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2">Alumno</th>
              {rubros.map((r) => <th key={r} className="px-2 py-2 normal-case">{r}</th>)}
              {k.fuente === 'participacion' && <th className="px-2 py-2">Participaciones</th>}
              {conExtra && <th className="px-2 py-2 normal-case">Extra (sobre 10)</th>}
              <th className="px-3 py-2 text-center">Vale (0–10)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((a) => {
              const valor = valorDe(a.id)
              return (
                <tr key={a.id} className="hover:bg-ink-50/70">
                  <td className="px-3 py-2 font-medium">{nombreDe(a)}</td>
                  {rubros.map((r, j) => {
                    const x = cap(a.id, j)
                    return (
                      <td key={r} className="px-2 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <CampoNumero valor={x?.valor ?? null} max={k.escala} etiqueta={`${r} de ${nombreDe(a)}`} onGuardar={(v) => guardar(a.id, j, { valor: v })} />
                          <select className="input w-auto py-1 text-xs" aria-label={`¿Entregó ${r}? ${nombreDe(a)}`} value={x?.entregado == null ? '' : String(x.entregado)} onChange={(ev) => guardar(a.id, j, { entregado: ev.target.value === '' ? null : Number(ev.target.value) })}>
                            <option value="">Entregó: —</option>
                            <option value="1">Entregó: sí</option>
                            <option value="0">No entregó</option>
                          </select>
                        </div>
                      </td>
                    )
                  })}
                  {k.fuente === 'participacion' && (
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <button className="btn-secundario px-2 py-1" aria-label={`Quitar participación de ${nombreDe(a)}`} onClick={() => cambiarParticipacion(a.id, false)} disabled={!participaciones(a.id)}>−</button>
                        <span className="w-8 text-center font-mono">{participaciones(a.id)}</span>
                        <button className="btn-secundario px-2 py-1" aria-label={`Agregar participación de ${nombreDe(a)}`} onClick={() => cambiarParticipacion(a.id, true)}>+1</button>
                      </div>
                    </td>
                  )}
                  {conExtra && <td className="px-2 py-1.5"><CampoNumero valor={cap(a.id, 0)?.extra ?? null} max={10} etiqueta={`Extra de ${nombreDe(a)}`} onGuardar={(v) => guardar(a.id, 0, { extra: v })} /></td>}
                  <td className={`px-3 py-2 text-center font-mono ${valor.valor == null ? 'text-ink-300' : ''}`} title={valor.detalle}>{nota1(valor.valor)}<div className="text-[11px] text-ink-400 font-sans">{valor.detalle}</div></td>
                </tr>
              )
            })}
            {lista.length === 0 && (
              <FilaVacia columnas={rubros.length + (k.fuente === 'participacion' ? 1 : 0) + (conExtra ? 1 : 0) + 2} hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos en la materia." />
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Final ----------------
type EstadoFinalF = 'todos' | 'aprobados' | 'abajo' | 'pendientes'
const categoriaFinal = (estado: EstadoCalif): EstadoFinalF => (estado === 'aprobado' ? 'aprobados' : estado === 'pendiente' ? 'pendientes' : 'abajo')

function VistaFinal({ c, e, materiaId, f, onCambio }: { c: CalificacionesEsquema; e: Esquema; materiaId: number; f: FiltrosCalif; onCambio: () => Promise<void> }): JSX.Element {
  const [estadoF, setEstadoF] = useRecordado<EstadoFinalF>(`calif.${materiaId}.final.estado`, 'todos')
  const filas = c.alumnos.map((a) => ({ a, r: c.resultados.find((x) => x.alumno_id === a.id)! }))
  const buscados = filas.filter((x) => buscaAlumno(f.busqueda, x.a))
  const lista = ordenarPor(
    buscados.filter((x) => estadoF === 'todos' || categoriaFinal(x.r.estado) === estadoF),
    f.orden,
    (x) => x.r.final,
    (x) => nombreDe(x.a)
  )
  const hayFiltro = !!f.busqueda.trim() || estadoF !== 'todos'
  const quitarFiltros = (): void => {
    f.setBusqueda('')
    setEstadoF('todos')
  }
  return (
    <div className="space-y-3">
      {c.alumnos.length > 0 && (
        <BarraAlumnos f={f} visibles={lista.length} total={c.alumnos.length} hayFiltro={hayFiltro} onLimpiar={quitarFiltros}>
          <Segmentado
            etiqueta="Estado en la final"
            valor={estadoF}
            onCambio={setEstadoF}
            opciones={([['todos', 'Todos'], ['aprobados', 'Aprobados'], ['abajo', 'Abajo de la mínima'], ['pendientes', 'Pendientes']] as [EstadoFinalF, string][])
              .map(([k, t]) => ({ valor: k, texto: t, conteo: buscados.filter((x) => k === 'todos' || categoriaFinal(x.r.estado) === k).length }))
              .filter((o) => o.valor === 'todos' || o.valor === estadoF || o.conteo > 0)}
          />
        </BarraAlumnos>
      )}
      <p className="text-xs text-ink-500">La final es el promedio de los parciales{e.parciales.some((p) => p.peso !== e.parciales[0].peso) ? ' con su peso' : ''}, a un decimal. Solo entran los parciales con al menos la mitad del peso evaluado; mientras falte alguno es provisional. Un parcial «NA» se marca en su columna (cómo pesa en la final lo decides tú). Mínima aprobatoria {e.minima.toFixed(1)}.</p>
      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2">Alumno</th>
              {e.parciales.map((p) => <th key={p.id} className="px-3 py-2 text-center normal-case font-semibold">{p.nombre}</th>)}
              <th className="px-3 py-2 text-center">Final</th>
              <th className="px-3 py-2">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map(({ a, r }) => {
              return (
                <tr key={a.id} className="hover:bg-ink-50/70">
                  <td className="px-3 py-2"><Link to={`/alumnos/${a.id}`} className="font-medium hover:underline">{nombreDe(a)}</Link></td>
                  {r.parciales.map((p) => (
                    <td key={p.parcial_id} className="px-3 py-2 text-center">
                      <span className={`font-mono ${p.calificacion == null ? 'text-ink-300' : p.estado === 'reprobado' || p.estado === 'na_inasistencia' ? 'text-red-600 font-semibold' : ''}`}>{p.calificacion == null ? 'pend.' : p.calificacion.toFixed(1)}</span>
                      {p.estado === 'na_inasistencia' && <div className="text-[11px] text-red-600">NA</div>}
                      {p.provisional && p.calificacion != null && <div className="text-[11px] text-ink-400">prov.</div>}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center">
                    <NotaEditable
                      grande
                      valor={r.final}
                      ajustada={!!r.ajustada}
                      calculada={r.ajustada?.calculada}
                      nota={r.ajustada?.nota}
                      color={r.estado === 'reprobado' || r.estado === 'na_inasistencia' ? 'text-red-600' : ''}
                      etiqueta={`Calificación final de ${nombreDe(a)}`}
                      onGuardar={async (v, nota) => {
                        await api.esquema.ajustarFinal(materiaId, a.id, v, nota)
                        await onCambio()
                        avisar(v == null ? `${nombreDe(a)}: la final vuelve al promedio de los parciales` : `${nombreDe(a)}: final puesta a mano (${v.toFixed(1)})`)
                      }}
                    />
                  </td>
                  <td className="px-3 py-2"><ChipEstado estado={r.estado} provisional={r.provisional && r.final != null} evaluado={undefined} />{r.provisional && r.final != null && <div className="text-[11px] text-ink-400">provisional</div>}</td>
                </tr>
              )
            })}
            {lista.length === 0 && <FilaVacia columnas={e.parciales.length + 3} hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos en la materia." />}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Proyección ----------------
/** Lectura de la proyección con IA: Claude interpreta los números de la app y propone acciones. */
function AnalisisIA({ materiaId }: { materiaId: number }): JSX.Element {
  const [texto, setTexto] = useState('')
  const [cargando, setCargando] = useState(false)
  const [segundos, setSegundos] = useState(0)
  const analizar = async (): Promise<void> => {
    setCargando(true)
    setSegundos(0)
    const reloj = window.setInterval(() => setSegundos((x) => x + 1), 1000)
    try {
      setTexto(await api.ia.analizarProyeccion(materiaId))
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      window.clearInterval(reloj)
      setCargando(false)
    }
  }
  return (
    <div className="tarjeta p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold">Análisis con IA</h4>
          <p className="text-xs text-ink-500">La IA lee estos números (no inventa calificaciones) y te dice quién necesita atención, por qué y qué hacer. Los nombres no se envían: van como «Alumno 1, 2…» y se reponen aquí.</p>
        </div>
        <div className="flex gap-2">
          {texto && <button className="btn-secundario" onClick={() => navigator.clipboard.writeText(texto).then(() => avisar('Análisis copiado'))}>Copiar</button>}
          <button className="btn-primario" disabled={cargando} onClick={analizar}>{cargando ? `Analizando… ${segundos}s` : texto ? '✦ Volver a analizar' : '✦ Analizar con IA'}</button>
        </div>
      </div>
      {texto && <Markdown texto={texto} />}
    </div>
  )
}

function VistaProyeccion({ pr, f }: { pr: ResumenProyeccion; f: FiltrosCalif }): JSX.Element {
  const [filtro, setFiltro] = useRecordado<Clasificacion | 'todas'>(`calif.${f.materiaId}.proyeccion.clasificacion`, 'todas')
  const buscados = pr.alumnos.filter((a) => buscaAlumno(f.busqueda, a))
  const lista = ordenarPor(
    buscados.filter((a) => filtro === 'todas' || a.clasificacion === filtro),
    f.orden,
    (a) => a.al_ritmo_actual ?? a.acumulada,
    (a) => a.nombre
  )
  const orden: Clasificacion[] = ['na_inasistencias', 'reprobaria', 'en_riesgo', 'va_aprobando', 'sin_datos']
  const hayFiltro = !!f.busqueda.trim() || filtro !== 'todas'
  const quitarFiltros = (): void => {
    f.setBusqueda('')
    setFiltro('todas')
  }
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <BarraAlumnos f={f} visibles={lista.length} total={pr.alumnos.length} hayFiltro={hayFiltro} onLimpiar={quitarFiltros} />
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Situación">
          <ChipFiltro activo={filtro === 'todas'} onClick={() => setFiltro('todas')} conteo={buscados.length}>Todas las situaciones</ChipFiltro>
          {orden.filter((k) => pr.conteo[k] > 0 || filtro === k).map((k) => (
            <ChipFiltro key={k} activo={filtro === k} onClick={() => setFiltro(filtro === k ? 'todas' : k)} conteo={buscados.filter((a) => a.clasificacion === k).length}>{ETIQUETA_CLASIFICACION[k]}</ChipFiltro>
          ))}
          <span className="ml-auto whitespace-nowrap text-xs text-ink-400">Corte: {fmtFechaMx(pr.fecha_corte, false)}</span>
        </div>
      </div>
      <details className="tarjeta px-4 py-2 text-xs text-ink-600">
        <summary className="cursor-pointer text-sm font-medium text-ink-700">Cómo se calcula (supuestos)</summary>
        <ul className="list-disc pl-5 mt-2 space-y-1">{SUPUESTOS_PROYECCION.map((s) => <li key={s}>{s}</li>)}</ul>
      </details>
      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <th className="px-3 py-2">Alumno</th>
              <th className="px-3 py-2">Situación</th>
              <th className="px-3 py-2 text-center">Acumulada</th>
              <th className="px-3 py-2 text-center">Al ritmo actual</th>
              <th className="px-3 py-2 text-center">Necesita en lo que falta</th>
              <th className="px-3 py-2">Asistencia</th>
              <th className="px-3 py-2">Por qué</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((a) => (
              <tr key={a.alumno_id} className="align-top hover:bg-ink-50/70">
                <td className="px-3 py-2"><Link to={`/alumnos/${a.alumno_id}`} className="font-medium hover:underline">{a.nombre}</Link></td>
                <td className="px-3 py-2"><span className={`chip whitespace-nowrap ${COLOR_CLASIFICACION[a.clasificacion]}`}>{a.etiqueta}</span></td>
                <td className="px-3 py-2 text-center font-mono">{a.acumulada.toFixed(1)}<div className="text-[11px] text-ink-400 font-sans">{a.evaluado_pct} % evaluado</div></td>
                <td className="px-3 py-2 text-center font-mono">{a.al_ritmo_actual == null ? '—' : a.al_ritmo_actual.toFixed(1)}</td>
                <td className="px-3 py-2 text-center">{a.situacion === 'ya_aprobado' ? <span className="text-green-700 text-xs">ya aprueba aunque saque 0</span> : a.situacion === 'imposible' ? <span className="text-red-600 text-xs">no alcanza aunque saque 10</span> : a.necesita != null ? <span className="font-mono">{a.necesita.toFixed(1)}</span> : '—'}</td>
                <td className="px-3 py-2 text-xs text-ink-600 min-w-[11rem]">
                  {(() => {
                    const f = alertaFaltas(a.asistencia)
                    return f.nivel ? <span className={`chip whitespace-nowrap ${COLOR_NIVEL_FALTAS[f.nivel]}`} title={f.texto}>{ETIQUETA_NIVEL_FALTAS[f.nivel]}</span> : <span className="chip whitespace-nowrap bg-green-100 text-green-700">En regla</span>
                  })()}
                  <div className="mt-0.5">{a.asistencia.horas_falta} h de falta · límite {a.asistencia.limites.limite} h</div>
                  {a.asistencia.pct_parcial_actual != null && <div className="text-ink-400">{a.asistencia.pct_parcial_actual} % en {a.asistencia.parcial_actual} (mín. {a.asistencia.minimo} %)</div>}
                </td>
                <td className="px-3 py-2 text-xs text-ink-600 min-w-[14rem]">{a.motivos.join(' ')}</td>
              </tr>
            ))}
            {lista.length === 0 && <FilaVacia columnas={7} hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos en la materia." />}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Editor del esquema ----------------
const FUENTES = Object.keys(ETIQUETA_FUENTE) as Fuente[]
let siguienteId = -1000

function EditorEsquema({ inicial, evaluaciones, nuevo, onCancelar, onGuardado }: { inicial: Esquema; evaluaciones: CalificacionesEsquema['evaluaciones']; nuevo: boolean; onCancelar: () => void; onGuardado: () => Promise<void> }): JSX.Element {
  const [e, setE] = useState<Esquema>(inicial)
  const [guardando, setGuardando] = useState(false)
  const problemas = useMemo(() => validarEsquema(e), [e])
  const idsIniciales = useMemo(() => inicial.parciales.flatMap((p) => p.componentes.map((k) => k.id)).filter((id) => id > 0), [inicial])

  const cambiarParcial = (i: number, cambios: Partial<Parcial>): void => setE({ ...e, parciales: e.parciales.map((p, j) => (j === i ? { ...p, ...cambios } : p)) })
  const cambiarComp = (i: number, j: number, cambios: Partial<Componente>): void =>
    cambiarParcial(i, { componentes: e.parciales[i].componentes.map((k, n) => (n === j ? { ...k, ...cambios } : k)) })

  const guardar = async (): Promise<void> => {
    const quedan = new Set(e.parciales.flatMap((p) => p.componentes.map((k) => k.id)))
    const quitados = idsIniciales.filter((id) => !quedan.has(id))
    const perdidas = quitados.length ? await api.esquema.capturasDe(quitados) : 0
    if (perdidas && !confirm(`Quitaste componentes que ya tienen ${perdidas} ${perdidas === 1 ? 'calificación capturada' : 'calificaciones capturadas'}. Se borrarán. ¿Continuar?`)) return
    setGuardando(true)
    try {
      await api.esquema.guardar(e)
      avisar('Esquema guardado')
      await onGuardado()
    } catch (err) {
      avisar((err as Error).message, 'error')
    } finally {
      setGuardando(false)
    }
  }
  const copiarATodos = (i: number): void => {
    if (!confirm(`¿Usar los componentes de ${e.parciales[i].nombre} en todos los parciales? Los de los demás se reemplazan (sus capturas se pierden al guardar).`)) return
    setE({ ...e, parciales: e.parciales.map((p, j) => (j === i ? p : { ...p, componentes: e.parciales[i].componentes.map((k) => ({ ...k, id: siguienteId--, parcial_id: p.id, evaluaciones: k.fuente === 'evaluaciones' ? [] : k.evaluaciones })) })) })
  }

  return (
    <div className="space-y-4">
      {nuevo && <div className="tarjeta p-4 text-sm text-ink-600">Propuesta inicial: tres parciales que reparten el periodo y los componentes de tu libro de ADA (examen 30, asistencia 20, tarea 1 y 2, actividades y participación 12.5). Ajústala y guarda.</div>}
      <section className="tarjeta p-4 space-y-3">
        <h3 className="font-semibold">Reglas de la materia</h3>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3 text-sm">
          <label><span className="etiqueta">Mínima aprobatoria (0–10)</span><input type="number" step="0.1" min={0} max={10} className="input" value={e.minima} onChange={(ev) => setE({ ...e, minima: Number(ev.target.value) })} /></label>
          <label><span className="etiqueta">Asistencia mínima por parcial (%)</span><input type="number" min={0} max={100} className="input" placeholder="sin regla" value={e.asistencia_minima ?? ''} onChange={(ev) => setE({ ...e, asistencia_minima: ev.target.value === '' ? null : Number(ev.target.value) })} /></label>
          <label><span className="etiqueta">Un retardo vale</span><select className="input" value={e.retardo_vale} onChange={(ev) => setE({ ...e, retardo_vale: Number(ev.target.value) })}><option value={1}>Asistencia completa</option><option value={0.5}>Media asistencia</option><option value={0}>Falta</option></select></label>
          <label><span className="etiqueta">Redondeo</span><select className="input" value={e.escala_100 ? '1' : '0'} onChange={(ev) => setE({ ...e, escala_100: ev.target.value === '1' })}><option value="0">Sumar sobre 10, un decimal</option><option value="1">Sumar sobre 100, un decimal, luego ÷ 10</option></select></label>
        </div>
        <label className="block text-sm"><span className="etiqueta">Nota (de dónde sale este esquema)</span><input className="input" value={e.nota} onChange={(ev) => setE({ ...e, nota: ev.target.value })} /></label>
        <p className="text-xs text-ink-500">Con asistencia mínima, quien quede abajo en un parcial aparece «NA por inasistencias» aunque la suma le alcance. Los justificados no cuentan como falta.</p>
      </section>

      {e.parciales.map((p, i) => {
        const suma = p.componentes.reduce((s, k) => s + (Number(k.peso) || 0), 0)
        const ok = Math.abs(suma - 100) < 0.001
        return (
          <section key={p.id} className="tarjeta p-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-[1_1_10rem]"><span className="etiqueta">Parcial</span><input className="input" value={p.nombre} onChange={(ev) => cambiarParcial(i, { nombre: ev.target.value })} /></label>
              <label><span className="etiqueta">Desde</span><input type="date" className="input" value={p.desde} onChange={(ev) => cambiarParcial(i, { desde: ev.target.value })} /></label>
              <label><span className="etiqueta">Hasta</span><input type="date" className="input" value={p.hasta} onChange={(ev) => cambiarParcial(i, { hasta: ev.target.value })} /></label>
              <label className="w-28"><span className="etiqueta">Peso en final</span><input type="number" min={0} step="0.5" className="input" value={p.peso} onChange={(ev) => cambiarParcial(i, { peso: Number(ev.target.value) })} /></label>
              <button className="btn-fantasma text-red-600" onClick={() => confirm(`¿Quitar ${p.nombre}?`) && setE({ ...e, parciales: e.parciales.filter((_, j) => j !== i) })}>Quitar parcial</button>
            </div>
            <div className="space-y-2">
              {p.componentes.map((k, j) => (
                <div key={k.id} className="rounded-lg border border-ink-200 p-3 flex flex-wrap items-end gap-3">
                  <label className="flex-[2_1_11rem]"><span className="etiqueta">Componente</span><input className="input" value={k.nombre} onChange={(ev) => cambiarComp(i, j, { nombre: ev.target.value })} /></label>
                  <label className="w-24"><span className="etiqueta">Peso %</span><input type="number" min={0} max={100} step="0.5" className="input" value={k.peso} onChange={(ev) => cambiarComp(i, j, { peso: Number(ev.target.value) })} /></label>
                  <label className="flex-[1_1_12rem]"><span className="etiqueta">Fuente</span><select className="input" value={k.fuente} onChange={(ev) => cambiarComp(i, j, { fuente: ev.target.value as Fuente })}>{FUENTES.map((f) => <option key={f} value={f}>{ETIQUETA_FUENTE[f]}</option>)}</select></label>
                  {k.fuente === 'manual' && (
                    <>
                      <label className="w-28"><span className="etiqueta">Calificar sobre</span><input type="number" min={1} className="input" value={k.escala} onChange={(ev) => cambiarComp(i, j, { escala: Number(ev.target.value) })} /></label>
                      <label className="flex-[2_1_12rem]"><span className="etiqueta">Se captura (separa con comas)</span><input className="input" placeholder="una sola calificación" value={k.rubros.join(', ')} onChange={(ev) => cambiarComp(i, j, { rubros: ev.target.value.split(',').map((x) => x.trimStart()) })} /></label>
                    </>
                  )}
                  {k.fuente === 'participacion' && <label className="w-40"><span className="etiqueta">Participaciones = 100 %</span><input type="number" min={1} className="input" value={k.meta} onChange={(ev) => cambiarComp(i, j, { meta: Number(ev.target.value) })} /></label>}
                  {(k.fuente === 'evaluaciones' || k.fuente === 'actividades') && <ElegirEvaluaciones p={p} k={k} evaluaciones={evaluaciones} onCambio={(ids) => cambiarComp(i, j, { evaluaciones: ids })} />}
                  <button className="btn-fantasma text-red-600 px-2" aria-label={`Quitar ${k.nombre}`} onClick={() => cambiarParcial(i, { componentes: p.componentes.filter((_, n) => n !== j) })}>✕</button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secundario" onClick={() => cambiarParcial(i, { componentes: [...p.componentes, { id: siguienteId--, parcial_id: p.id, orden: p.componentes.length + 1, nombre: '', peso: Math.max(0, 100 - suma), fuente: 'manual', evaluaciones: [], escala: 10, rubros: [], meta: 5 }] })}>+ Componente</button>
              {e.parciales.length > 1 && <button className="btn-fantasma" onClick={() => copiarATodos(i)}>Usar estos componentes en todos los parciales</button>}
              <span className={`ml-auto chip ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`} role="status">Suman {Math.round(suma * 100) / 100} %{ok ? ' ✓' : ' · deben sumar 100 %'}</span>
            </div>
          </section>
        )
      })}

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secundario" onClick={() => {
          const ultimo = e.parciales[e.parciales.length - 1]
          const id = siguienteId--
          setE({ ...e, parciales: [...e.parciales, { id, materia_id: e.materia_id, orden: e.parciales.length + 1, nombre: `Parcial ${e.parciales.length + 1}`, desde: ultimo?.hasta ?? hoyIso(), hasta: ultimo?.hasta ?? hoyIso(), peso: 1, componentes: (ultimo?.componentes ?? []).map((k) => ({ ...k, id: siguienteId--, parcial_id: id, evaluaciones: [] })) }] })
        }}>+ Parcial</button>
      </div>

      {problemas.length > 0 && (
        <div className="tarjeta p-4 border-red-200 bg-red-50 text-sm text-red-700" role="alert">
          <div className="font-semibold mb-1">Antes de guardar:</div>
          <ul className="list-disc pl-5 space-y-0.5">{problemas.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2 pb-4">
        <button className="btn-secundario" onClick={onCancelar}>Descartar cambios</button>
        <button className="btn-primario" disabled={problemas.length > 0 || guardando} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar esquema'}</button>
      </div>
    </div>
  )
}

function ElegirEvaluaciones({ p, k, evaluaciones, onCambio }: { p: Parcial; k: Componente; evaluaciones: CalificacionesEsquema['evaluaciones']; onCambio: (ids: number[]) => void }): JSX.Element {
  const [todas, setTodas] = useState(false)
  const lista = evaluaciones.filter((x) => todas || k.evaluaciones.includes(x.id) || (x.fecha != null && x.fecha >= p.desde && x.fecha <= p.hasta))
  const sel = new Set(k.evaluaciones)
  const resumen = k.evaluaciones.length ? `${k.evaluaciones.length} elegida${k.evaluaciones.length === 1 ? '' : 's'}` : k.fuente === 'actividades' ? 'Automático (las del rango, sin exámenes)' : 'Ninguna elegida'
  return (
    <details className="flex-[3_1_16rem] min-w-0">
      <summary className="cursor-pointer text-sm"><span className="etiqueta block">Evaluaciones</span><span className={k.fuente === 'evaluaciones' && !k.evaluaciones.length ? 'text-red-600' : ''}>{resumen}</span></summary>
      <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-ink-200 divide-y divide-ink-100">
        {lista.map((x) => (
          <label key={x.id} className="flex items-start gap-2 px-2 py-1.5 text-sm">
            <input type="checkbox" className="mt-1" checked={sel.has(x.id)} onChange={(ev) => onCambio(ev.target.checked ? [...k.evaluaciones, x.id] : k.evaluaciones.filter((y) => y !== x.id))} />
            <span className="min-w-0 break-words">{x.titulo} <span className="text-xs text-ink-400">· {x.tipo.replace('_', ' ')}{x.puntos_totales ? ` · ${x.puntos_totales} pts` : ''}{x.fecha ? ` · ${x.fecha}` : ''}</span></span>
          </label>
        ))}
        {lista.length === 0 && <div className="px-2 py-2 text-xs text-ink-500">No hay evaluaciones en el rango del parcial.</div>}
      </div>
      <button className="btn-fantasma text-xs mt-1" onClick={() => setTodas(!todas)}>{todas ? 'Solo las del rango' : 'Ver todas las de la materia'}</button>
    </details>
  )
}
