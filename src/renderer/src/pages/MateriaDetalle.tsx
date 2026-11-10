import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type AccesoCreado, type MateriaDetalle as Detalle, type Concentrado } from '../lib/api'
import { ETIQUETA_RIESGO } from '@shared/asistencia'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import ModalPassword from '../components/ModalPassword'
import Markdown from '../components/Markdown'
import CalificacionesMateria from '../components/CalificacionesMateria'
import { BotonJustificar } from '../components/Justificar'
import { avisar } from '../components/Aviso'
import { Buscador, ChipFiltro, Conteo, EncabezadoOrden, Segmentado, SinResultados, coincide, ordenNatural, type Orden } from '../components/Filtros'
import { useRecordado } from '../lib/recordado'
import VisorMaterial from '../components/VisorMaterial'
import ConvertirExamen from '../components/ConvertirExamen'
import { abrirEnClase } from '../store/clase'
import { DIAS, DIAS_CORTOS, diaMx, fmtFechaCorta, hoyIso } from '../lib/tiempo'
import type { Actividad, Alumno, Carrera, Horario, Sesion, TerminoGlosario, TipoActividad, TipoEvaluacion } from '@shared/types'

type Tab = 'plan' | 'alumnos' | 'calificaciones' | 'materiales' | 'evaluaciones' | 'glosario' | 'config'
const TIPOS: TipoActividad[] = ['apertura', 'exposicion', 'ejercicio', 'discusion', 'evaluacion', 'receso', 'cierre']

export default function MateriaDetalle(): JSX.Element {
  const { id } = useParams()
  const materiaId = Number(id)
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [m, setM] = useState<Detalle | null>(null)
  const [sesiones, setSesiones] = useState<Sesion[]>([])
  const [tab, setTab] = useState<Tab>(() => (params.get('tab') === 'calificaciones' ? 'calificaciones' : 'plan'))
  const [sesionSel, setSesionSel] = useState<Sesion | null>(null)
  // Sube cuando el plan cambia por fuera del editor (intercambio): el editor se vuelve a montar con lo nuevo
  const [versionEditor, setVersionEditor] = useState(0)
  const refEditor = useRef<HTMLDivElement>(null)
  // En ventana angosta el editor queda debajo de la lista: al elegir una sesión se lleva a la vista
  useEffect(() => {
    const ed = refEditor.current
    if (!sesionSel || !ed) return
    const lista = ed.previousElementSibling as HTMLElement | null
    if (lista && ed.offsetTop > lista.offsetTop + 8) ed.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [sesionSel?.id])

  // Enlace viejo o materia borrada: obtener devuelve null y sin esto se quedaba en «Cargando…» para siempre
  const [noExiste, setNoExiste] = useState(false)
  const cargar = async (): Promise<void> => {
    const [d, s] = await Promise.all([api.materias.obtener(materiaId), api.sesiones.porMateria(materiaId)])
    setNoExiste(!d)
    setM(d)
    setSesiones(s)
    // Tras guardar se toma la versión nueva de la sesión elegida; si no hay, la de ?sesion=
    const q = Number(params.get('sesion'))
    setSesionSel((sel) => s.find((x) => x.id === sel?.id) ?? (q ? s.find((x) => x.id === q) ?? null : null))
  }
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    cargar().catch((e) => setError((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materiaId])

  if (noExiste)
    return (
      <div className="p-8">
        <div className="tarjeta max-w-md p-6">
          <h1 className="text-lg font-semibold text-ink-900">Esa materia ya no existe</h1>
          <p className="mt-1 text-sm text-ink-500">Puede que se haya borrado o que el enlace sea viejo.</p>
          <Link to="/materias" className="btn-primario mt-4">Ir a Materias</Link>
        </div>
      </div>
    )
  if (error && !m) return <div className="p-8 text-red-600">No se pudo cargar la materia: {error}</div>
  if (!m) return <div className="p-8 text-ink-500">Cargando…</div>

  const generarSesiones = async (): Promise<void> => {
    if (m.horarios.length === 0) return avisar('Primero agrega el horario de la materia (pestaña Configuración).', 'error')
    const n = await api.materias.generarSesiones(materiaId)
    avisar(`${n} sesiones creadas para todo el periodo`)
    cargar()
  }
  const abrirClase = async (s: Sesion): Promise<void> => {
    if (await abrirEnClase(s.id)) nav(`/clase/${s.id}`)
  }

  return (
    <div>
      <Encabezado
        titulo={m.nombre}
        sub={<span><span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5" style={{ background: m.color }} />{m.carrera_nombre} · {m.clave} · Nivel {m.cuatrimestre} · {m.horarios.map((h) => `${DIAS[h.dia]} ${h.hora_inicio}–${h.hora_fin}`).join(', ') || 'sin horario'}</span>}
        acciones={
          <>
            <Link to={`/ia/${m.id}`} className="btn-secundario">✦ Estudio IA</Link>
            <Link to={`/classroom?materia=${m.id}`} className="btn-secundario">Google Classroom</Link>
            <Link to={`/programar?materia=${m.id}`} className="btn-secundario">Programar</Link>
            <Link to={`/asistente?materia=${m.id}`} className="btn-secundario">💬 Asistente</Link>
            <BotonAviso m={m} />
            <button className="btn-secundario" onClick={() => api.exportar.materiaXlsx(m.id).then((r) => r && avisar('Excel exportado'))}>Exportar Excel</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 pt-4">
        <nav className="flex flex-wrap gap-x-1 border-b border-ink-200">
          {([['plan', 'Plan y sesiones', sesiones.length], ['alumnos', 'Alumnos', m.alumnos.length], ['calificaciones', 'Calificaciones'], ['materiales', 'Materiales', m.materiales.length], ['evaluaciones', 'Evaluaciones y tareas', m.evaluaciones.length], ['glosario', 'Glosario', m.glosario.length], ['config', 'Configuración']] as [Tab, string, number?][]).map(([t, l, n]) => (
            <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined} className={`whitespace-nowrap px-3 py-2 text-sm border-b-2 -mb-px ${tab === t ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-ink-500 hover:text-ink-800'}`}>
              {l}
              {n !== undefined && <span className={`ml-1.5 text-xs font-normal ${tab === t ? 'text-brand-600/70' : 'text-ink-400'}`}>{n}</span>}
            </button>
          ))}
        </nav>
      </div>

      <div className="px-4 sm:px-8 py-5">
        {tab === 'plan' && (
          <div className="flex flex-wrap items-start gap-5">
            <div className="min-w-0 flex-[999_1_28rem]">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold">Sesiones del periodo</h3>
                <button className={sesiones.length ? 'btn-fantasma' : 'btn-primario'} onClick={generarSesiones} title="Crea una sesión por cada clase de cada semana del periodo, con la plantilla de actividades">Generar sesiones del periodo</button>
              </div>
              {sesiones.length === 0 ? (
                <div className="tarjeta px-5 py-8 text-center">
                  <div className="font-medium text-ink-800">Aún no hay sesiones</div>
                  <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">
                    {m.horarios.length ? 'Pulsa «Generar sesiones del periodo»: se crea una sesión por cada clase de cada semana con la plantilla de actividades.' : 'Primero define el horario en la pestaña Configuración; luego genera las sesiones del periodo.'}
                  </p>
                  {!m.horarios.length && <button className="btn-secundario mt-3" onClick={() => setTab('config')}>Ir a Configuración</button>}
                </div>
              ) : (
                <ListaSesiones key={m.id} materiaId={m.id} sesiones={sesiones} elegida={sesionSel} onElegir={setSesionSel} />
              )}
            </div>
            <div ref={refEditor} className="min-w-0 flex-[1_1_420px] scroll-mt-28">
              {sesionSel ? (
                <EditorSesion
                  key={`${sesionSel.id}-${versionEditor}`}
                  sesion={sesionSel}
                  materiaId={m.id}
                  onCambio={cargar}
                  onIntercambio={async () => { await cargar(); setVersionEditor((v) => v + 1) }}
                  onClase={() => abrirClase(sesionSel)}
                />
              ) : (
                <div className="tarjeta p-5">
                  <h3 className="font-semibold mb-2">Temario</h3>
                  <Markdown texto={m.temario || '_Sin temario. Agrégalo en Configuración._'} className="text-sm" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Con `key` por materia: los filtros recordados se leen otra vez al pasar de una materia a otra */}
        {tab === 'alumnos' && <TabAlumnos key={m.id} m={m} onCambio={cargar} />}
        {tab === 'calificaciones' && <CalificacionesMateria key={m.id} materiaId={m.id} asistencia={<TabCalificaciones materiaId={m.id} />} />}
        {tab === 'materiales' && <TabMateriales m={m} onCambio={cargar} />}
        {tab === 'evaluaciones' && <TabEvaluaciones key={m.id} m={m} />}
        {tab === 'glosario' && <TabGlosario key={m.id} m={m} onCambio={cargar} />}
        {tab === 'config' && <TabConfig m={m} onCambio={cargar} />}
      </div>
    </div>
  )
}

// ---------------- Lista de sesiones ----------------
const ESTADO_SESION: Record<Sesion['estado'], { texto: string; tono: string }> = {
  planeada: { texto: 'Planeada', tono: 'bg-ink-100 text-ink-500' },
  en_curso: { texto: 'En curso', tono: 'bg-amber-100 text-amber-700' },
  terminada: { texto: 'Terminada', tono: 'bg-green-100 text-green-700' },
  cancelada: { texto: 'Cancelada', tono: 'bg-red-100 text-red-700' }
}
const ESTADOS_SESION = Object.keys(ESTADO_SESION) as Sesion['estado'][]
const TIPO_ACTIVIDAD: Record<TipoActividad, string> = {
  apertura: 'Apertura',
  exposicion: 'Exposición',
  ejercicio: 'Ejercicio',
  discusion: 'Discusión',
  evaluacion: 'Evaluación',
  receso: 'Receso',
  cierre: 'Cierre'
}
/** Día de la semana corto de una fecha YYYY-MM-DD («Mar»). */
const diaCorto = (fecha: string): string => DIAS_CORTOS[new Date(`${fecha}T12:00:00`).getDay() || 7]
/** Ya pasó y nadie la terminó desde el Modo clase. */
const sinTerminar = (s: Sesion, hoy: string): boolean => s.fecha < hoy && s.estado === 'planeada'

type Cuando = 'todas' | 'proximas' | 'pasadas'
type FiltroEstadoSesion = '' | Sesion['estado'] | 'sin_terminar'

/**
 * Sesiones del periodo agrupadas por semana, con filtros que se recuerdan por materia. Al abrir se
 * lleva a la sesión elegida o a la siguiente clase (con 50+ sesiones, la de hoy quedaba muy abajo).
 */
function ListaSesiones({ materiaId, sesiones, elegida, onElegir }: { materiaId: number; sesiones: Sesion[]; elegida: Sesion | null; onElegir: (s: Sesion) => void }): JSX.Element {
  const hoy = hoyIso()
  const clave = `materia.${materiaId}.plan`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [cuando, setCuando] = useRecordado<Cuando>(`${clave}.cuando`, 'todas')
  const [estadoF, setEstadoF] = useRecordado<FiltroEstadoSesion>(`${clave}.estado`, '')
  const [semanaF, setSemanaF] = useRecordado<number | ''>(`${clave}.semana`, '')
  const [sinTema, setSinTema] = useRecordado(`${clave}.sinTema`, false)
  const refLista = useRef<HTMLDivElement>(null)

  // Cada filtro por separado, para contar cuántas quedan en cada opción con los demás puestos
  const pasa = useMemo(
    () => ({
      busqueda: (s: Sesion) => coincide(busqueda, s.tema, s.objetivo, s.notas),
      cuando: (s: Sesion) => cuando === 'todas' || (cuando === 'proximas' ? s.fecha >= hoy : s.fecha < hoy),
      estado: (s: Sesion) => estadoF === '' || (estadoF === 'sin_terminar' ? sinTerminar(s, hoy) : s.estado === estadoF),
      semana: (s: Sesion) => semanaF === '' || s.semana === semanaF,
      tema: (s: Sesion) => !sinTema || !s.tema.trim()
    }),
    [busqueda, cuando, estadoF, semanaF, sinTema, hoy]
  )
  type Filtro = keyof typeof pasa
  const salvo = (excepto: Filtro): Sesion[] => sesiones.filter((s) => (Object.keys(pasa) as Filtro[]).every((k) => k === excepto || pasa[k](s)))
  const lista = useMemo(
    () => sesiones.filter((s) => Object.values(pasa).every((f) => f(s))).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.hora_inicio.localeCompare(b.hora_inicio) || a.numero - b.numero),
    [sesiones, pasa]
  )
  const grupos = useMemo(() => {
    const g = new Map<number, Sesion[]>()
    for (const s of lista) g.set(s.semana, [...(g.get(s.semana) ?? []), s])
    return [...g.entries()]
  }, [lista])
  const semanas = useMemo(() => [...new Set(sesiones.map((s) => s.semana))].sort((a, b) => a - b), [sesiones])
  const hayFiltro = !!busqueda.trim() || cuando !== 'todas' || estadoF !== '' || semanaF !== '' || sinTema
  const quitarFiltros = (): void => {
    setBusqueda('')
    setCuando('todas')
    setEstadoF('')
    setSemanaF('')
    setSinTema(false)
  }
  const paraCuando = salvo('cuando')
  const paraEstado = salvo('estado')
  const paraSemana = salvo('semana')
  const paraTema = salvo('tema')
  const pendientes = sesiones.filter((s) => sinTerminar(s, hoy)).length

  /** Desplaza la lista (no la página) hasta una sesión. */
  const irA = (s: Sesion | undefined, suave = true): void => {
    const cont = refLista.current
    const el = s && cont?.querySelector<HTMLElement>(`[data-sesion="${s.id}"]`)
    if (cont && el) cont.scrollTo({ top: Math.max(0, el.offsetTop - 40), behavior: suave ? 'smooth' : 'auto' })
  }
  const siguiente = lista.find((s) => s.fecha >= hoy)
  useEffect(() => {
    irA(elegida ? lista.find((s) => s.id === elegida.id) ?? siguiente : siguiente, false)
    // Solo al abrir la pestaña
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-2.5">
      <div className="space-y-2" role="search" aria-label="Filtrar sesiones">
        <div className="flex flex-wrap items-center gap-2">
          <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por tema, objetivo o notas" etiqueta="Buscar sesiones" />
          <Segmentado
            etiqueta="Cuándo"
            valor={cuando}
            onCambio={setCuando}
            opciones={([['todas', 'Todas'], ['proximas', 'Próximas'], ['pasadas', 'Pasadas']] as [Cuando, string][]).map(([k, t]) => ({
              valor: k,
              texto: t,
              conteo: paraCuando.filter((s) => k === 'todas' || (k === 'proximas' ? s.fecha >= hoy : s.fecha < hoy)).length
            }))}
          />
          <select className="input w-auto" value={semanaF} onChange={(e) => setSemanaF(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Filtrar por semana">
            <option value="">Todas las semanas</option>
            {semanas.map((n) => <option key={n} value={n}>Semana {n} ({paraSemana.filter((s) => s.semana === n).length})</option>)}
          </select>
          {siguiente && <button className="btn-fantasma text-xs" onClick={() => irA(siguiente)} title="Lleva la lista a la clase de hoy o a la siguiente">Ir a hoy</button>}
          {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Estado de la sesión">
          {ESTADOS_SESION.map((k) => {
            const n = paraEstado.filter((s) => s.estado === k).length
            return n > 0 || estadoF === k ? (
              <ChipFiltro key={k} activo={estadoF === k} onClick={() => setEstadoF(estadoF === k ? '' : k)} conteo={n}>{ESTADO_SESION[k].texto}</ChipFiltro>
            ) : null
          })}
          {(pendientes > 0 || estadoF === 'sin_terminar') && (
            <ChipFiltro activo={estadoF === 'sin_terminar'} onClick={() => setEstadoF(estadoF === 'sin_terminar' ? '' : 'sin_terminar')} conteo={paraEstado.filter((s) => sinTerminar(s, hoy)).length} titulo="Ya pasaron y siguen como planeadas: no se terminaron desde el Modo clase">
              Pasadas sin terminar
            </ChipFiltro>
          )}
          <ChipFiltro activo={sinTema} onClick={() => setSinTema(!sinTema)} conteo={paraTema.filter((s) => !s.tema.trim()).length}>Sin tema</ChipFiltro>
          <Conteo visibles={lista.length} total={sesiones.length} nombre="sesiones" hayFiltro={hayFiltro} />
        </div>
      </div>
      <div ref={refLista} className="tarjeta relative max-h-[70vh] overflow-y-auto">
        {grupos.map(([semana, l]) => (
          <section key={semana} aria-label={`Semana ${semana}`}>
            <h4 className="sticky top-0 z-[1] flex items-baseline gap-2 border-b border-ink-100 bg-ink-50/95 px-4 py-1.5 text-xs font-semibold text-ink-600 backdrop-blur">
              Semana {semana}
              <span className="whitespace-nowrap font-normal text-ink-400">{fmtFechaCorta(l[0].fecha)}{l.length > 1 && l[l.length - 1].fecha !== l[0].fecha ? ` – ${fmtFechaCorta(l[l.length - 1].fecha)}` : ''}</span>
            </h4>
            <ul className="divide-y divide-ink-100">
              {l.map((s) => {
                const sel = elegida?.id === s.id
                const pendiente = sinTerminar(s, hoy)
                return (
                  <li key={s.id}>
                    <button
                      data-sesion={s.id}
                      onClick={() => onElegir(s)}
                      aria-current={sel ? 'true' : undefined}
                      className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left transition-colors ${sel ? 'bg-brand-500/5' : 'hover:bg-ink-50/70'}`}
                    >
                      <span className={`w-[4.5rem] shrink-0 whitespace-nowrap text-sm ${pendiente ? 'text-ink-400' : 'text-ink-700'}`}><span className="text-ink-400">{diaCorto(s.fecha)}</span> {fmtFechaCorta(s.fecha)}</span>
                      <span className="w-[5.5rem] shrink-0 whitespace-nowrap font-mono text-xs text-ink-400">{s.hora_inicio}–{s.hora_fin}</span>
                      <span className={`min-w-0 flex-[1_1_10rem] truncate ${sel ? 'font-medium text-ink-900' : pendiente ? 'text-ink-500' : 'text-ink-800'}`}>{s.tema || <i className="text-ink-400">Sin tema</i>}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {s.fecha === hoy && <span className="chip whitespace-nowrap bg-brand-500 text-white">Hoy</span>}
                        <span className={`chip whitespace-nowrap ${ESTADO_SESION[s.estado].tono}`} title={pendiente ? 'Ya pasó y no se terminó desde el Modo clase' : undefined}>{ESTADO_SESION[s.estado].texto}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {lista.length === 0 && <SinResultados hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="Sin sesiones." />}
      </div>
    </div>
  )
}

// ---------------- Editor de sesión ----------------
/**
 * Intercambia el plan de una sesión con otra de la misma materia: así el docente mueve un examen
 * (u otro tema) a otro día sin rehacer el plan. Las fechas y horarios de cada sesión no cambian.
 */
function IntercambiarSesion({ abierto, sesion, materiaId, onCerrar, onHecho }: { abierto: boolean; sesion: Sesion; materiaId: number; onCerrar: () => void; onHecho: () => void }): JSX.Element {
  const [sesiones, setSesiones] = useState<Sesion[]>([])
  const [otra, setOtra] = useState<number | ''>('')
  const [moverEvals, setMoverEvals] = useState(true)
  const [evs, setEvs] = useState<{ aqui: string[]; alla: string[] }>({ aqui: [], alla: [] })
  const [ocupado, setOcupado] = useState(false)
  useEffect(() => {
    if (!abierto) return
    setOtra('')
    api.sesiones.porMateria(materiaId).then((l) => setSesiones(l.filter((x) => x.id !== sesion.id && x.estado !== 'cancelada')))
  }, [abierto, materiaId, sesion.id])
  const destino = sesiones.find((x) => x.id === otra)
  useEffect(() => {
    if (!destino) return setEvs({ aqui: [], alla: [] })
    Promise.all([api.sesiones.evaluacionesDelDia(materiaId, sesion.fecha), api.sesiones.evaluacionesDelDia(materiaId, destino.fecha)]).then(([a, b]) =>
      setEvs({ aqui: a.map((e) => e.titulo), alla: b.map((e) => e.titulo) })
    )
  }, [destino, materiaId, sesion.fecha])
  const confirmar = async (): Promise<void> => {
    if (!destino) return
    setOcupado(true)
    try {
      const r = await api.sesiones.intercambiarPlan(sesion.id, destino.id, moverEvals)
      avisar(`Listo: «${sesion.tema || 'esta sesión'}» quedó el ${fmtFechaCorta(destino.fecha)}${r.evaluaciones_movidas ? ` y se movieron ${r.evaluaciones_movidas} evaluación(es)` : ''}.`)
      onCerrar()
      onHecho()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(false)
    }
  }
  return (
    <Modal titulo="Intercambiar con otra sesión" abierto={abierto} onCerrar={onCerrar} ancho="max-w-lg">
      <div className="space-y-3 text-sm">
        <p className="text-ink-600">
          El plan de esta sesión (<b>{sesion.tema || 'sin tema'}</b>, {fmtFechaCorta(sesion.fecha)}) pasa a la sesión que elijas, y el de esa sesión pasa a esta. Fechas y horarios no cambian.
        </p>
        <label>
          <span className="etiqueta">Llevarlo a</span>
          <select className="input" value={otra} onChange={(e) => setOtra(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Elige la sesión…</option>
            {sesiones.map((x) => (
              <option key={x.id} value={x.id}>
                {fmtFechaCorta(x.fecha)} · Sesión {x.numero} · {x.tema || 'sin tema'}{x.fecha < hoyIso() ? ' (ya pasó)' : ''}
              </option>
            ))}
          </select>
        </label>
        {destino && (
          <div className="rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 space-y-1">
            <div>
              <b>{fmtFechaCorta(destino.fecha)}</b> quedará con: {sesion.tema || 'sin tema'}
            </div>
            <div>
              <b>{fmtFechaCorta(sesion.fecha)}</b> quedará con: {destino.tema || 'sin tema'}
            </div>
          </div>
        )}
        {destino && (destino.fecha < hoyIso() || sesion.fecha < hoyIso()) && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800" role="alert">
            {destino.fecha < hoyIso() ? `El ${fmtFechaCorta(destino.fecha)} ya pasó` : `Esta sesión (${fmtFechaCorta(sesion.fecha)}) ya pasó`}: la clase que ya diste se quedaría con el plan de otra fecha
            {(evs.aqui.length > 0 || evs.alla.length > 0) ? ' y una evaluación podría cambiar de parcial' : ''}. Revisa que sea lo que quieres.
          </div>
        )}
        {destino && (evs.aqui.length > 0 || evs.alla.length > 0) && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={moverEvals} onChange={(e) => setMoverEvals(e.target.checked)} />
            <span>
              Mover también las evaluaciones de esos días (y su publicación en el portal, si aún no abre)
              {evs.aqui.length > 0 && <span className="block text-ink-500">Al {fmtFechaCorta(destino.fecha)}: {evs.aqui.join(', ')}</span>}
              {evs.alla.length > 0 && <span className="block text-ink-500">Al {fmtFechaCorta(sesion.fecha)}: {evs.alla.join(', ')}</span>}
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-secundario" onClick={onCerrar} disabled={ocupado}>Cancelar</button>
          <button className="btn-primario" onClick={confirmar} disabled={!destino || ocupado}>{ocupado ? 'Intercambiando…' : 'Intercambiar'}</button>
        </div>
      </div>
    </Modal>
  )
}

function EditorSesion({ sesion, materiaId, onCambio, onIntercambio, onClase }: { sesion: Sesion; materiaId: number; onCambio: () => void; onIntercambio: () => void; onClase: () => void }): JSX.Element {
  const [s, setS] = useState<Sesion>(sesion)
  const [borrar, setBorrar] = useState<string | null>(null) // advertencia del modal de contraseña
  const [acts, setActs] = useState<Partial<Actividad>[]>(sesion.actividades ?? [])
  const [planes, setPlanes] = useState<{ id: number; titulo: string }[]>([])
  const [presentaciones, setPresentaciones] = useState<{ id: number; titulo: string; ruta: string }[]>([])
  const total = acts.reduce((x, a) => x + Number(a.duracion_min ?? 0), 0)
  const [h1, m1] = s.hora_inicio.split(':').map(Number)
  const [h2, m2] = s.hora_fin.split(':').map(Number)
  const disponible = h2 * 60 + m2 - (h1 * 60 + m1)

  useEffect(() => {
    api.materias.obtener(materiaId).then((d) => {
      setPlanes((d?.evaluaciones ?? []).filter((e) => e.tipo === 'plan_sesion').map((e) => ({ id: e.id, titulo: e.titulo })))
      setPresentaciones((d?.materiales ?? []).filter((m) => m.tipo === 'pdf' || m.tipo === 'pptx').map((m) => ({ id: m.id, titulo: m.titulo, ruta: m.ruta })))
    })
  }, [materiaId])

  const [intercambio, setIntercambio] = useState(false)
  const guardar = async (): Promise<void> => {
    try {
      // Si la sesión cambió de día, lo que estaba programado ese día (examen, tarea) puede irse con ella
      const evs = s.fecha !== sesion.fecha ? await api.sesiones.evaluacionesDelDia(materiaId, sesion.fecha) : []
      await api.sesiones.guardar(s)
      await api.sesiones.reemplazarActividades(s.id, acts)
      if (evs.length && confirm(`El ${fmtFechaCorta(sesion.fecha)} estaba programado:\n• ${evs.map((e) => e.titulo).join('\n• ')}\n\n¿Mover también ${evs.length === 1 ? 'esa evaluación' : 'esas evaluaciones'} al ${fmtFechaCorta(s.fecha)}?`)) {
        await api.sesiones.moverEvaluaciones(materiaId, sesion.fecha, s.fecha)
      }
      avisar('Sesión guardada')
      onCambio()
    } catch (e) {
      avisar(`No se guardó la sesión: ${(e as Error).message}`, 'error')
    }
  }
  const aplicarPlan = async (evId: number): Promise<void> => {
    await api.ia.aplicarPlan(s.id, evId)
    const nueva = await api.sesiones.obtener(s.id)
    if (nueva) {
      setS(nueva)
      setActs(nueva.actividades ?? [])
    }
    avisar('Plan aplicado a la sesión')
    onCambio()
  }
  const mover = (i: number, d: number): void => {
    const j = i + d
    if (j < 0 || j >= acts.length) return
    const copia = [...acts]
    ;[copia[i], copia[j]] = [copia[j], copia[i]]
    setActs(copia)
  }
  // Sin asistencia registrada basta confirmar; si la hay, se borraría con la sesión: pide la contraseña
  const eliminar = async (): Promise<void> => {
    try {
      const { asistencias } = await api.sesiones.impacto(s.id)
      if (asistencias) return setBorrar(`Se borra también la asistencia registrada (${asistencias} ${asistencias === 1 ? 'registro' : 'registros'}). Esta acción no se puede deshacer.`)
      if (!confirm('¿Eliminar esta sesión?')) return
      await api.sesiones.eliminar(s.id)
      onCambio()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  return (
    <div className="tarjeta p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Sesión {s.numero} · {fmtFechaCorta(s.fecha)} · {s.hora_inicio}–{s.hora_fin}</h3>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secundario" onClick={() => setIntercambio(true)} title="Pasa el plan de esta sesión (por ejemplo, un examen) a otro día y trae el de ese día">⇄ Intercambiar con otra sesión</button>
          <button className="btn-primario" onClick={onClase}>⏱ Modo clase</button>
        </div>
      </div>
      <IntercambiarSesion abierto={intercambio} sesion={sesion} materiaId={materiaId} onCerrar={() => setIntercambio(false)} onHecho={onIntercambio} />
      <label><span className="etiqueta">Tema</span><input className="input" value={s.tema} onChange={(e) => setS({ ...s, tema: e.target.value })} /></label>
      <label><span className="etiqueta">Objetivo</span><textarea rows={2} className="input" value={s.objetivo} onChange={(e) => setS({ ...s, objetivo: e.target.value })} /></label>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
        <label><span className="etiqueta">Fecha</span><input type="date" className="input" value={s.fecha} onChange={(e) => setS({ ...s, fecha: e.target.value })} /></label>
        <label><span className="etiqueta">Inicio</span><input type="time" className="input" value={s.hora_inicio} onChange={(e) => setS({ ...s, hora_inicio: e.target.value })} /></label>
        <label><span className="etiqueta">Fin</span><input type="time" className="input" value={s.hora_fin} onChange={(e) => setS({ ...s, hora_fin: e.target.value })} /></label>
      </div>
      <label><span className="etiqueta">Estado</span>
        <select className="input" value={s.estado} onChange={(e) => setS({ ...s, estado: e.target.value as Sesion['estado'] })}>
          {ESTADOS_SESION.map((x) => <option key={x} value={x}>{ESTADO_SESION[x].texto}</option>)}
        </select>
      </label>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1">
          <span className="etiqueta">Actividades ({total} de {disponible} min)</span>
          <span className={`text-xs ${total > disponible ? 'text-red-600' : total < disponible ? 'text-amber-600' : 'text-green-600'}`}>{total > disponible ? `Excede ${total - disponible} min` : total < disponible ? `Sobran ${disponible - total} min` : 'Cuadra exacto'}</span>
        </div>
        <div className="space-y-1.5">
          {acts.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <select className="input w-28 text-xs" value={a.tipo ?? 'exposicion'} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, tipo: e.target.value as TipoActividad } : x)))}>{TIPOS.map((t) => <option key={t} value={t}>{TIPO_ACTIVIDAD[t]}</option>)}</select>
              <input className="input flex-[1_1_8rem] w-auto min-w-0" value={a.nombre ?? ''} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))} placeholder="Nombre de la actividad" />
              <input type="number" min={1} className="input w-16 text-center" value={a.duracion_min ?? 10} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, duracion_min: Number(e.target.value) } : x)))} />
              <button className="btn-fantasma px-1.5" onClick={() => mover(i, -1)} aria-label="Subir actividad">↑</button>
              <button className="btn-fantasma px-1.5" onClick={() => mover(i, 1)} aria-label="Bajar actividad">↓</button>
              <button className="btn-fantasma px-1.5 text-red-600" onClick={() => setActs(acts.filter((_, j) => j !== i))} aria-label="Quitar actividad">✕</button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <button className="btn-secundario text-xs" onClick={() => setActs([...acts, { nombre: '', tipo: 'ejercicio', duracion_min: Math.max(1, disponible - total) || 10, descripcion: '' }])}>+ Actividad</button>
          {planes.length > 0 && (
            <select className="input w-auto text-xs" value="" onChange={(e) => e.target.value && aplicarPlan(Number(e.target.value))}>
              <option value="">Aplicar plan generado con IA…</option>
              {planes.map((p) => <option key={p.id} value={p.id}>{p.titulo}</option>)}
            </select>
          )}
        </div>
      </div>
      <label><span className="etiqueta">Presentación de esta sesión</span>
        <select className="input" value={presentaciones.find((p) => p.ruta === s.presentacion_path)?.id ?? ''} onChange={(e) => setS({ ...s, presentacion_path: e.target.value ? presentaciones.find((p) => p.id === Number(e.target.value))!.ruta : null })}>
          <option value="">— Usar la presentación de la materia —</option>
          {presentaciones.map((p) => <option key={p.id} value={p.id}>{p.titulo}</option>)}
        </select>
      </label>
      <label><span className="etiqueta">Notas del docente</span><textarea rows={4} className="input" value={s.notas} onChange={(e) => setS({ ...s, notas: e.target.value })} /></label>
      <AsistenciaDeSesion sesion={sesion} materiaId={materiaId} />
      <div className="flex justify-between">
        <button className="btn-peligro" onClick={eliminar}>Eliminar</button>
        <button className="btn-primario" onClick={guardar}>Guardar sesión</button>
      </div>
      <ModalPassword
        abierto={borrar !== null}
        titulo={`Eliminar la sesión ${s.numero}`}
        advertencia={borrar ?? ''}
        textoBoton="Eliminar sesión"
        onCerrar={() => setBorrar(null)}
        onConfirmar={async (password) => {
          await api.sesiones.eliminar(s.id, password)
          onCambio()
        }}
      />
    </div>
  )
}

// ---------------- Alumnos ----------------
type Asistio = 'todos' | 'faltas' | 'retardos' | 'sin_registro'
type EstadoAlumno = 'todos' | 'activos' | 'baja'
type FaltaDato = '' | 'correo' | 'matricula'
type CampoAlumno = 'matricula' | 'apellidos' | 'presente' | 'retardo' | 'ausente' | 'justificado'

function TabAlumnos({ m, onCambio }: { m: Detalle; onCambio: () => void }): JSX.Element {
  const [modal, setModal] = useState(false)
  const [todos, setTodos] = useState<Alumno[]>([])
  const [sel, setSel] = useState<number[]>([])
  const [resumen, setResumen] = useState<{ alumno_id: number; estado: string; n: number }[]>([])
  const [filtro, setFiltro] = useState('')
  const [accesos, setAccesos] = useState<{ creados: AccesoCreado[]; existentes: number } | null>(null)
  const [carreras, setCarreras] = useState<Carrera[]>([])
  // Filtros de la lista: se recuerdan por materia al ir a la ficha de un alumno y regresar
  const clave = `materia.${m.id}.alumnos`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [asistioF, setAsistioF] = useRecordado<Asistio>(`${clave}.asistencia`, 'todos')
  const [estadoF, setEstadoF] = useRecordado<EstadoAlumno>(`${clave}.estado`, 'todos')
  const [carreraF, setCarreraF] = useRecordado<number | '' | 'sin'>(`${clave}.carrera`, '')
  const [faltaF, setFaltaF] = useRecordado<FaltaDato>(`${clave}.falta`, '')
  const [orden, setOrden] = useRecordado<Orden<CampoAlumno>>(`${clave}.orden`, { campo: 'apellidos', dir: 1 })

  const exportarLista = async (): Promise<void> => {
    const r = await api.exportar.alumnosXlsx(m.id)
    if (r) avisar('Lista de alumnos exportada')
  }
  const generarAccesos = async (): Promise<void> => {
    if (m.alumnos.length === 0) return avisar('Primero inscribe alumnos en la materia', 'error')
    try {
      setAccesos(await api.portal.accesos(m.id))
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  useEffect(() => {
    api.asistencia.resumenMateria(m.id).then(setResumen)
  }, [m.id, m.alumnos.length])
  useEffect(() => {
    api.carreras.listar().then(setCarreras).catch(() => undefined)
  }, [])

  const abrir = async (): Promise<void> => {
    const t = await api.alumnos.listar()
    setTodos(t.filter((a) => !m.alumnos.some((x) => x.id === a.id)))
    setSel([])
    setFiltro('')
    setModal(true)
  }
  const inscribir = async (): Promise<void> => {
    await api.alumnos.inscribir(m.id, sel)
    setModal(false)
    onCambio()
  }
  const importar = async (): Promise<void> => {
    try {
      const r = await api.alumnos.importarExcel(m.id, m.carrera_id)
      if (!r.cancelado) avisar(`${r.importados} alumnos importados e inscritos`)
      onCambio()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  // Quitar de la materia no borra al alumno ni su asistencia, pero deja de verse en el pase de lista y en Calificaciones
  const quitar = async (a: Alumno): Promise<void> => {
    if (!confirm(`¿Quitar a ${`${a.apellidos} ${a.nombre}`.trim()} de ${m.nombre}?\n\nDeja de aparecer en el pase de lista y en Calificaciones de esta materia. Sus registros no se borran: si lo vuelves a inscribir, reaparecen.`)) return
    await api.alumnos.desinscribir(m.id, a.id)
    onCambio()
  }
  const cuenta = (id: number, e: string): number => resumen.find((r) => r.alumno_id === id && r.estado === e)?.n ?? 0
  const carreraDe = (id: number | null): Carrera | undefined => carreras.find((c) => c.id === id)
  const sinRegistro = (a: Alumno): boolean => !resumen.some((r) => r.alumno_id === a.id && r.n > 0)

  // Cada filtro por separado, para contar cuántos quedan en cada opción con los demás puestos
  const pasa = useMemo(
    () => ({
      busqueda: (a: Alumno) => coincide(busqueda, a.matricula, a.nombre, a.apellidos, a.email),
      asistencia: (a: Alumno) =>
        asistioF === 'todos' || (asistioF === 'faltas' ? cuenta(a.id, 'ausente') > 0 : asistioF === 'retardos' ? cuenta(a.id, 'retardo') > 0 : sinRegistro(a)),
      estado: (a: Alumno) => estadoF === 'todos' || (estadoF === 'activos' ? !!a.activo : !a.activo),
      carrera: (a: Alumno) => carreraF === '' || (carreraF === 'sin' ? a.carrera_id == null : a.carrera_id === carreraF),
      falta: (a: Alumno) => faltaF === '' || (faltaF === 'correo' ? !a.email?.trim() : !a.matricula?.trim())
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busqueda, asistioF, estadoF, carreraF, faltaF, resumen]
  )
  type Filtro = keyof typeof pasa
  const salvo = (excepto: Filtro): Alumno[] => m.alumnos.filter((a) => (Object.keys(pasa) as Filtro[]).every((k) => k === excepto || pasa[k](a)))
  const lista = useMemo(() => {
    const porNombre = (a: Alumno, b: Alumno): number => ordenNatural(a.apellidos, b.apellidos) || ordenNatural(a.nombre, b.nombre)
    const comparar = (a: Alumno, b: Alumno): number =>
      orden.campo === 'apellidos' ? porNombre(a, b) : orden.campo === 'matricula' ? ordenNatural(a.matricula || '~', b.matricula || '~') : cuenta(a.id, orden.campo) - cuenta(b.id, orden.campo)
    return m.alumnos.filter((a) => Object.values(pasa).every((f) => f(a))).sort((a, b) => orden.dir * comparar(a, b) || porNombre(a, b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.alumnos, pasa, orden, resumen])
  const hayFiltro = !!busqueda.trim() || asistioF !== 'todos' || estadoF !== 'todos' || carreraF !== '' || faltaF !== ''
  const quitarFiltros = (): void => {
    setBusqueda('')
    setAsistioF('todos')
    setEstadoF('todos')
    setCarreraF('')
    setFaltaF('')
  }
  const paraAsistencia = salvo('asistencia')
  const paraEstado = salvo('estado')
  const paraCarrera = salvo('carrera')
  const carrerasDelGrupo = carreras.filter((c) => m.alumnos.some((a) => a.carrera_id === c.id))
  const sinCarrera = m.alumnos.filter((a) => a.carrera_id == null).length
  const deBaja = m.alumnos.filter((a) => !a.activo).length
  const sinCorreo = m.alumnos.filter((a) => !a.email?.trim()).length
  const sinMatricula = m.alumnos.filter((a) => !a.matricula?.trim()).length
  // Ordenar por faltas de mayor a menor de entrada: lo que más se busca en esas columnas
  const alOrdenar = (o: Orden<CampoAlumno>): void => setOrden(o.campo !== orden.campo && o.campo !== 'apellidos' && o.campo !== 'matricula' ? { campo: o.campo, dir: -1 } : o)

  // Inscribir existentes: buscador y orden por apellidos
  const disponibles = todos.filter((a) => coincide(filtro, a.matricula, a.nombre, a.apellidos, a.email)).sort((a, b) => ordenNatural(a.apellidos, b.apellidos) || ordenNatural(a.nombre, b.nombre))
  const todosMarcados = disponibles.length > 0 && disponibles.every((a) => sel.includes(a.id))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-[1_1_18rem] text-sm text-ink-500">Alumnos inscritos en esta materia. La asistencia se captura desde el Modo clase.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secundario" onClick={importar}>Importar Excel/CSV</button>
          <button className="btn-secundario" onClick={abrir}>Inscribir existentes</button>
          <button className="btn-secundario" onClick={exportarLista} disabled={m.alumnos.length === 0}>Exportar lista</button>
          <button className="btn-primario" onClick={generarAccesos}>Accesos al portal</button>
          <Link to="/alumnos" className="btn-fantasma">Administrar alumnos</Link>
        </div>
      </div>
      <Modal titulo="Accesos al portal de alumnos" abierto={accesos !== null} onCerrar={() => setAccesos(null)} ancho="max-w-2xl">
        {accesos && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-600">
              {accesos.creados.length > 0 ? `Se crearon ${accesos.creados.length} accesos nuevos.` : 'Todos los alumnos ya tenían acceso.'}
              {accesos.existentes > 0 && ` ${accesos.existentes} ya existían y no se tocaron.`}
              {' '}El usuario y la contraseña inicial son la matrícula; si el alumno no tiene, se generan a partir de su nombre y aquí se muestra la contraseña. El portal les pedirá cambiarla al entrar.
            </p>
            {accesos.creados.length > 0 && (
              <div className="tarjeta overflow-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-ink-500 text-xs"><tr><th className="text-left px-3 py-2">Alumno</th><th className="text-left px-3 py-2">Usuario</th><th className="text-left px-3 py-2">Contraseña inicial</th></tr></thead>
                  <tbody>{accesos.creados.map((c) => <tr key={c.usuario} className="border-t border-ink-100"><td className="px-3 py-1.5">{c.nombre}</td><td className="px-3 py-1.5 font-mono">{c.usuario}</td><td className="px-3 py-1.5 font-mono">{c.password}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn-secundario" onClick={exportarLista}>Exportar lista con usuarios</button>
              <Link to="/portal" className="btn-primario">Ver dirección del portal</Link>
            </div>
          </div>
        )}
      </Modal>

      {m.alumnos.length > 0 && (
        <div className="tarjeta p-3 space-y-2.5" role="search" aria-label="Filtrar alumnos de la materia">
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por matrícula, nombre o correo" etiqueta="Buscar alumnos" />
            <Segmentado
              etiqueta="Asistencia"
              valor={asistioF}
              onCambio={setAsistioF}
              opciones={([['todos', 'Todos'], ['faltas', 'Con faltas'], ['retardos', 'Con retardos'], ['sin_registro', 'Sin registros']] as [Asistio, string][])
                .map(([k, t]) => ({
                  valor: k,
                  texto: t,
                  conteo: paraAsistencia.filter((a) => (k === 'todos' ? true : k === 'faltas' ? cuenta(a.id, 'ausente') > 0 : k === 'retardos' ? cuenta(a.id, 'retardo') > 0 : sinRegistro(a))).length
                }))
                .filter((o) => o.valor === 'todos' || o.valor === asistioF || o.conteo > 0)}
            />
            {(deBaja > 0 || estadoF !== 'todos') && (
              <Segmentado
                etiqueta="Estado"
                valor={estadoF}
                onCambio={setEstadoF}
                opciones={([['todos', 'Todos'], ['activos', 'Activos'], ['baja', 'De baja']] as [EstadoAlumno, string][]).map(([k, t]) => ({
                  valor: k,
                  texto: t,
                  conteo: paraEstado.filter((a) => (k === 'todos' ? true : k === 'activos' ? !!a.activo : !a.activo)).length
                }))}
              />
            )}
            {(sinCorreo > 0 || sinMatricula > 0 || faltaF !== '') && (
              <select className={`input w-auto ${faltaF ? 'border-amber-300 bg-amber-50 text-amber-900' : ''}`} value={faltaF} onChange={(e) => setFaltaF(e.target.value as FaltaDato)} aria-label="Datos que faltan">
                <option value="">Datos completos o no</option>
                <option value="matricula">Sin matrícula ({sinMatricula})</option>
                <option value="correo">Sin correo ({sinCorreo})</option>
              </select>
            )}
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Carrera">
            {/* En grupos de una sola carrera los chips no aportan: solo el conteo */}
            {carrerasDelGrupo.length + (sinCarrera > 0 ? 1 : 0) > 1 && (
              <>
                <ChipFiltro activo={carreraF === ''} onClick={() => setCarreraF('')} conteo={paraCarrera.length}>Todas las carreras</ChipFiltro>
                {carrerasDelGrupo.map((c) => (
                  <ChipFiltro key={c.id} activo={carreraF === c.id} color={c.color} titulo={c.nombre} onClick={() => setCarreraF(carreraF === c.id ? '' : c.id)} conteo={paraCarrera.filter((a) => a.carrera_id === c.id).length}>
                    {c.clave}
                  </ChipFiltro>
                ))}
                {sinCarrera > 0 && (
                  <ChipFiltro activo={carreraF === 'sin'} onClick={() => setCarreraF(carreraF === 'sin' ? '' : 'sin')} conteo={paraCarrera.filter((a) => a.carrera_id == null).length}>Sin carrera</ChipFiltro>
                )}
              </>
            )}
            <Conteo visibles={lista.length} total={m.alumnos.length} nombre="alumnos" hayFiltro={hayFiltro} />
          </div>
        </div>
      )}

      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <EncabezadoOrden campo="matricula" orden={orden} onOrden={alOrdenar}>Matrícula</EncabezadoOrden>
              <EncabezadoOrden campo="apellidos" orden={orden} onOrden={alOrdenar}>Alumno</EncabezadoOrden>
              <EncabezadoOrden campo="presente" orden={orden} onOrden={alOrdenar} className="text-center">Asistencias</EncabezadoOrden>
              <EncabezadoOrden campo="retardo" orden={orden} onOrden={alOrdenar} className="text-center">Retardos</EncabezadoOrden>
              <EncabezadoOrden campo="ausente" orden={orden} onOrden={alOrdenar} className="text-center">Faltas</EncabezadoOrden>
              <EncabezadoOrden campo="justificado" orden={orden} onOrden={alOrdenar} className="text-center">Justificadas</EncabezadoOrden>
              <th className="px-3 py-2"><span className="sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((a) => {
              const c = carreraDe(a.carrera_id)
              const num = (e: string, tono: string): JSX.Element => {
                const n = cuenta(a.id, e)
                return <td className={`px-3 py-2 text-center font-mono tabular-nums ${n ? tono : 'text-ink-300'}`}>{n}</td>
              }
              return (
                <tr key={a.id} className="group transition-colors hover:bg-ink-50/70">
                  <td className={`whitespace-nowrap px-3 py-2 font-mono text-xs ${a.activo ? 'text-ink-600' : 'text-ink-400'}`}>{a.matricula || <span className="font-sans text-amber-600">Sin matrícula</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Link to={`/alumnos/${a.id}`} className={`font-medium hover:underline ${a.activo ? 'text-ink-900' : 'text-ink-400'}`}>{`${a.apellidos} ${a.nombre}`.trim()}</Link>
                      {/* La carrera solo distingue en grupos mixtos */}
                      {c && carrerasDelGrupo.length > 1 && <span className="chip whitespace-nowrap border font-semibold" style={{ color: c.color, borderColor: `${c.color}55`, backgroundColor: `${c.color}14` }} title={c.nombre}>{c.clave}</span>}
                      {!a.activo && <span className="chip whitespace-nowrap bg-ink-100 text-ink-500">De baja</span>}
                    </div>
                    <div className="max-w-[18rem] truncate text-xs text-ink-400" title={a.email}>{a.email || <span className="text-amber-600">Sin correo</span>}</div>
                  </td>
                  {num('presente', 'text-green-700')}
                  {num('retardo', 'text-amber-700')}
                  {num('ausente', 'font-semibold text-red-700')}
                  {num('justificado', 'text-sky-700')}
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {/* Se ven al pasar el mouse o al llegar con el teclado: el nombre ya abre su ficha */}
                    <div className="inline-flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                      <button className="btn-fantasma text-xs" title="Reporte del alumno en PDF" onClick={() => api.exportar.reporteAlumnoPdf(m.id, a.id).then((r) => r && avisar('Reporte PDF generado'))}>PDF</button>
                      <button className="btn-fantasma text-xs" title="Reporte del alumno en Excel" onClick={() => api.exportar.materiaXlsx(m.id, a.id).then((r) => r && avisar('Excel generado'))}>Excel</button>
                      <button className="btn-fantasma text-xs text-red-600 hover:bg-red-50" title="Quitar de esta materia (no borra al alumno)" onClick={() => quitar(a)}>Quitar</button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {lista.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <SinResultados
                    hayFiltro={hayFiltro}
                    onLimpiar={quitarFiltros}
                    vacio={
                      <>
                        <div className="font-medium text-ink-700">Aún no hay alumnos en esta materia</div>
                        <p className="mx-auto mt-1 max-w-md">Importa un Excel con columnas matrícula, nombre, apellidos y correo, o inscribe alumnos que ya registraste.</p>
                        <div className="mt-3 flex flex-wrap justify-center gap-2">
                          <button className="btn-secundario" onClick={importar}>Importar Excel/CSV</button>
                          <button className="btn-secundario" onClick={abrir}>Inscribir existentes</button>
                        </div>
                      </>
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal titulo="Inscribir alumnos existentes" abierto={modal} onCerrar={() => setModal(false)}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Buscador valor={filtro} onCambio={setFiltro} placeholder="Buscar por matrícula, nombre o correo" etiqueta="Buscar alumnos para inscribir" />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-600">
            <input
              type="checkbox"
              checked={todosMarcados}
              disabled={!disponibles.length}
              onChange={(e) => setSel(e.target.checked ? [...new Set([...sel, ...disponibles.map((a) => a.id)])] : sel.filter((id) => !disponibles.some((a) => a.id === id)))}
            />
            Marcar los que se ven
          </label>
        </div>
        <div className="max-h-80 overflow-y-auto divide-y divide-ink-100 border border-ink-100 rounded-lg">
          {disponibles.map((a) => (
            <label key={a.id} className="flex items-center gap-3 px-3 py-2 hover:bg-ink-50 cursor-pointer">
              <input type="checkbox" checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} />
              <span className="w-24 shrink-0 font-mono text-xs text-ink-500">{a.matricula || '—'}</span>
              <span className="min-w-0 flex-1 truncate">{`${a.apellidos} ${a.nombre}`.trim()}</span>
              {carreraDe(a.carrera_id) && <span className="chip whitespace-nowrap bg-ink-100 text-ink-600" title={carreraDe(a.carrera_id)!.nombre}>{carreraDe(a.carrera_id)!.clave}</span>}
            </label>
          ))}
          {disponibles.length === 0 && <div className="px-3 py-4 text-ink-500 text-sm">{todos.length ? 'Nadie coincide con la búsqueda.' : 'No hay alumnos disponibles: todos los registrados ya están en esta materia.'}</div>}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-ink-500">{sel.length ? `${sel.length} marcado${sel.length === 1 ? '' : 's'}` : `${todos.length} sin inscribir`}</span>
          <button className="btn-secundario" onClick={() => setModal(false)}>Cancelar</button>
          <button className="btn-primario" disabled={!sel.length} onClick={inscribir}>Inscribir {sel.length}</button>
        </div>
      </Modal>
    </div>
  )
}

// ---------------- Calificaciones ----------------
const COLOR_RIESGO: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  atencion: 'bg-amber-100 text-amber-700',
  extraordinario: 'bg-orange-100 text-orange-700',
  titulo: 'bg-red-100 text-red-700',
  recursa: 'bg-red-600 text-white'
}
type Riesgo = keyof typeof ETIQUETA_RIESGO
const RIESGOS = Object.keys(ETIQUETA_RIESGO) as Riesgo[]
type CampoConcentrado = 'alumno' | 'asistencia' | 'faltas' | 'promedio' | 'pendientes'

/** Asistencia y faltas por horas (comunicado COM-AS-01), con filtro por situación y orden por columna. */
function TabCalificaciones({ materiaId }: { materiaId: number }): JSX.Element {
  const [c, setC] = useState<Concentrado | null>(null)
  const [error, setError] = useState('')
  const clave = `materia.${materiaId}.asistencia`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [riesgoF, setRiesgoF] = useRecordado<Riesgo | ''>(`${clave}.riesgo`, '')
  const [conPendientes, setConPendientes] = useRecordado(`${clave}.pendientes`, false)
  const [orden, setOrden] = useRecordado<Orden<CampoConcentrado>>(`${clave}.orden`, { campo: 'alumno', dir: 1 })
  useEffect(() => {
    api.calificaciones.materia(materiaId).then(setC).catch((e) => setError((e as Error).message))
  }, [materiaId])

  type Fila = Concentrado['filas'][number]
  const filas = c?.filas ?? []
  const pasaBusqueda = (f: Fila): boolean => coincide(busqueda, f.alumno.matricula, f.alumno.nombre, f.alumno.apellidos)
  const pasaPendientes = (f: Fila): boolean => !conPendientes || f.pendientes > 0
  const paraRiesgo = filas.filter((f) => pasaBusqueda(f) && pasaPendientes(f))
  const lista = useMemo(() => {
    const nombre = (f: Fila): string => `${f.alumno.apellidos} ${f.alumno.nombre}`
    // Sin dato va al final en ambos sentidos
    const num = (v: number | null): number => (v == null ? Infinity * orden.dir : v)
    const valor = (f: Fila): number =>
      orden.campo === 'asistencia' ? num(f.porcentaje_asistencia) : orden.campo === 'faltas' ? f.horas_falta : orden.campo === 'promedio' ? num(f.promedio_parcial) : f.pendientes
    return paraRiesgo
      .filter((f) => !riesgoF || f.riesgo === riesgoF)
      .sort((a, b) => (orden.campo === 'alumno' ? orden.dir * ordenNatural(nombre(a), nombre(b)) : orden.dir * (valor(a) - valor(b)) || ordenNatural(nombre(a), nombre(b))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, busqueda, riesgoF, conPendientes, orden])

  if (error) return <div className="tarjeta p-6 text-red-600">{error}</div>
  if (!c) return <div className="text-ink-500">Calculando…</div>

  const nota = (n: number | null): string => (n == null ? '—' : n.toFixed(1))
  const modalidad = c.modalidad === 'sabatino14' ? 'sabatina de 14 semanas' : c.modalidad === 'semestral16' ? 'semestral de 16 semanas' : 'cuatrimestral de 14 semanas'
  const hayFiltro = !!busqueda.trim() || riesgoF !== '' || conPendientes
  const quitarFiltros = (): void => {
    setBusqueda('')
    setRiesgoF('')
    setConPendientes(false)
  }
  // Faltas, pendientes y asistencia: de entrada, lo peor primero
  const alOrdenar = (o: Orden<CampoConcentrado>): void =>
    setOrden(o.campo !== orden.campo && o.campo !== 'alumno' ? { campo: o.campo, dir: o.campo === 'asistencia' || o.campo === 'promedio' ? 1 : -1 } : o)

  return (
    <div className="space-y-4">
      <div className="tarjeta p-4 grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-4 text-sm">
        <div><div className="etiqueta">Carga</div>{c.horas_semana} h por semana · modalidad {modalidad}</div>
        <div><div className="etiqueta">Horas del periodo</div>{c.limites.horas_totales} h · debe asistir a {c.limites.debe_asistir} h</div>
        <div><div className="etiqueta">Límite de faltas</div>{c.limites.limite} h · extraordinario a las {c.limites.extraordinario} h</div>
        <div><div className="etiqueta">Evidencias</div>{c.evaluaciones.length} · suman {Math.round(c.puntos_totales)} puntos</div>
      </div>
      <p className="text-xs text-ink-500">
        Las faltas se cuentan por hora de clase, no por sesión, como indica el comunicado de asistencias. El promedio parcial usa solo lo ya calificado, en escala de 10. El avance del curso es cuántos de los 100 puntos del periodo lleva ganados.
      </p>
      {filas.length > 0 && (
        <div className="space-y-2" role="search" aria-label="Filtrar alumnos">
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por matrícula o nombre" etiqueta="Buscar alumnos" />
            <ChipFiltro activo={conPendientes} onClick={() => setConPendientes(!conPendientes)} conteo={filas.filter((f) => pasaBusqueda(f) && f.pendientes > 0).length} titulo="Alumnos con evidencias sin entregar o sin calificar">
              Con pendientes
            </ChipFiltro>
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Situación por faltas">
            <ChipFiltro activo={riesgoF === ''} onClick={() => setRiesgoF('')} conteo={paraRiesgo.length}>Todas las situaciones</ChipFiltro>
            {RIESGOS.map((k) => {
              const n = paraRiesgo.filter((f) => f.riesgo === k).length
              return n > 0 || riesgoF === k ? <ChipFiltro key={k} activo={riesgoF === k} onClick={() => setRiesgoF(riesgoF === k ? '' : k)} conteo={n}>{ETIQUETA_RIESGO[k]}</ChipFiltro> : null
            })}
            <Conteo visibles={lista.length} total={filas.length} nombre="alumnos" hayFiltro={hayFiltro} />
          </div>
        </div>
      )}
      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <EncabezadoOrden campo="alumno" orden={orden} onOrden={alOrdenar}>Alumno</EncabezadoOrden>
              <EncabezadoOrden campo="asistencia" orden={orden} onOrden={alOrdenar} className="text-center">Asistencia</EncabezadoOrden>
              <EncabezadoOrden campo="faltas" orden={orden} onOrden={alOrdenar} className="text-center">Horas de falta</EncabezadoOrden>
              <th className="px-3 py-2">Situación</th>
              <th className="px-3 py-2 text-center">Calificado</th>
              <EncabezadoOrden campo="promedio" orden={orden} onOrden={alOrdenar} className="text-center">Promedio parcial</EncabezadoOrden>
              <th className="px-3 py-2 text-center">Avance del curso</th>
              <EncabezadoOrden campo="pendientes" orden={orden} onOrden={alOrdenar} className="text-center">Pendientes</EncabezadoOrden>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((f) => (
              <tr key={f.alumno.id} className="hover:bg-ink-50/70">
                <td className="px-3 py-2"><Link to={`/alumnos/${f.alumno.id}`} className="font-medium text-ink-900 hover:underline">{f.alumno.apellidos} {f.alumno.nombre}</Link><div className="text-xs text-ink-400 font-mono">{f.alumno.matricula}</div></td>
                <td className="px-3 py-2 text-center tabular-nums">{f.porcentaje_asistencia == null ? '—' : `${f.porcentaje_asistencia}%`}</td>
                <td className={`whitespace-nowrap px-3 py-2 text-center font-mono ${f.horas_falta >= c.limites.limite ? 'font-semibold text-red-700' : ''}`}>{f.horas_falta} / {c.limites.limite}</td>
                <td className="px-3 py-2"><span className={`chip whitespace-nowrap ${COLOR_RIESGO[f.riesgo]}`}>{ETIQUETA_RIESGO[f.riesgo]}</span></td>
                <td className="whitespace-nowrap px-3 py-2 text-center text-ink-500">{f.puntos_obtenidos} / {f.puntos_evaluados}</td>
                <td className="px-3 py-2 text-center font-semibold tabular-nums">{nota(f.promedio_parcial)}</td>
                <td className="px-3 py-2 text-center text-ink-500 tabular-nums">{c.puntos_totales ? `${Math.round((f.puntos_obtenidos / c.puntos_totales) * 100)}%` : '—'}</td>
                <td className={`px-3 py-2 text-center tabular-nums ${f.pendientes ? 'text-amber-700' : 'text-ink-300'}`}>{f.pendientes}</td>
              </tr>
            ))}
            {lista.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <SinResultados hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos. Impórtalos desde la pestaña Alumnos y la tabla se llena sola conforme captures asistencia y calificaciones." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Materiales ----------------
type MaterialFila = Detalle['materiales'][number]

/** Tipo de archivo: nombre legible y un tono suave para reconocerlo de un vistazo. */
const TIPOS_MATERIAL: Record<string, { nombre: string; tono: string }> = {
  pdf: { nombre: 'PDF', tono: 'bg-red-50 text-red-700 ring-red-200' },
  pptx: { nombre: 'PowerPoint', tono: 'bg-orange-50 text-orange-700 ring-orange-200' },
  docx: { nombre: 'Word', tono: 'bg-sky-50 text-sky-700 ring-sky-200' },
  xlsx: { nombre: 'Excel', tono: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  codigo: { nombre: 'Código', tono: 'bg-violet-50 text-violet-700 ring-violet-200' },
  geogebra: { nombre: 'GeoGebra', tono: 'bg-teal-50 text-teal-700 ring-teal-200' },
  link: { nombre: 'Enlace', tono: 'bg-cyan-50 text-cyan-700 ring-cyan-200' },
  otro: { nombre: 'Otro', tono: 'bg-ink-100 text-ink-600 ring-ink-200' }
}
const tipoDe = (t: string): { nombre: string; tono: string } => TIPOS_MATERIAL[t] ?? TIPOS_MATERIAL.otro
const ABREVIATURA: Record<string, string> = { pdf: 'PDF', pptx: 'PPT', docx: 'DOC', xlsx: 'XLS', codigo: '</>', geogebra: 'GGB', link: 'URL', otro: '···' }

/** «Sesión 12», «Semana 3»… se juntan en una sola sección («Sesiones») para no tener 33 grupos de un material. */
const NUMERADA = /^(.*\S)\s+(\d+)$/
const pluralSeccion = (p: string): string => (/ón$/.test(p) ? p.replace(/ón$/, 'ones') : /[aeiouáéíóú]$/i.test(p) ? `${p}s` : `${p}es`)
const SIN_UNIDAD = 'Sin unidad'

function seccionesDe(lista: MaterialFila[]): Map<string, string> {
  // Prefijos numerados que se repiten (al menos 3): esos se agrupan
  const cuenta = new Map<string, number>()
  for (const x of lista) {
    const n = NUMERADA.exec(x.unidad.trim())
    if (n) cuenta.set(n[1], (cuenta.get(n[1]) ?? 0) + 1)
  }
  const seccion = new Map<string, string>()
  for (const x of lista) {
    const u = x.unidad.trim()
    const n = NUMERADA.exec(u)
    seccion.set(String(x.id), !u ? SIN_UNIDAD : n && (cuenta.get(n[1]) ?? 0) >= 3 ? pluralSeccion(n[1]) : u)
  }
  return seccion
}


type FiltroPortal = 'todos' | 'compartidos' | 'sin'
type OrdenMateriales = 'unidad' | 'recientes' | 'antiguos' | 'az' | 'za'
const ORDENES: [OrdenMateriales, string][] = [['unidad', 'Por unidad'], ['recientes', 'Más recientes'], ['antiguos', 'Más antiguos'], ['az', 'A–Z'], ['za', 'Z–A']]
const CLAVE_ORDEN = 'docente.materiales.orden'
const leerOrden = (): OrdenMateriales => {
  try {
    const o = localStorage.getItem(CLAVE_ORDEN) as OrdenMateriales | null
    return o && ORDENES.some(([k]) => k === o) ? o : 'unidad'
  } catch {
    return 'unidad'
  }
}
/** «2026-10-26 18:00:00» (UTC) → «26 oct 2026» en hora de Ciudad de México */
const fechaAlta = (creado: string): string => {
  const d = new Date(creado.includes('T') ? creado : `${creado.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', year: 'numeric' })
}

/** Interruptor «visible para alumnos»: más claro que una casilla dentro de una píldora. */
function InterruptorAlumnos({ activo, onCambio, titulo }: { activo: boolean; onCambio: (v: boolean) => void; titulo: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={`${titulo}: ${activo ? 'visible para alumnos' : 'oculto para alumnos'}`}
      title={activo ? 'Los alumnos lo ven y lo descargan en el portal' : 'Solo tú lo ves'}
      onClick={() => onCambio(!activo)}
      className="group/sw inline-flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 text-xs font-medium text-ink-600 hover:bg-ink-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50"
    >
      <span className={`relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200 ${activo ? 'bg-emerald-500' : 'bg-ink-200 group-hover/sw:bg-ink-300'}`}>
        <span className={`absolute left-0 top-0.5 block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${activo ? 'translate-x-[16px]' : 'translate-x-0.5'}`} />
      </span>
      <span className={`w-14 text-left ${activo ? 'text-emerald-700' : ''}`}>{activo ? 'Alumnos' : 'Privado'}</span>
    </button>
  )
}

function TabMateriales({ m, onCambio }: { m: Detalle; onCambio: () => void }): JSX.Element {
  const nav = useNavigate()
  const [unidad, setUnidad] = useState('')
  const [link, setLink] = useState({ titulo: '', url: '' })
  const [conEnlace, setConEnlace] = useState(false)
  const [vista, setVista] = useState<{ titulo: string; texto: string } | null>(null)
  // Material abierto en el visor de la app
  const [abierto, setAbierto] = useState<{ id: number; titulo: string; ruta: string } | null>(null)
  // Material que se convierte en examen con IA
  const [aExamen, setAExamen] = useState<{ id: number; titulo: string; juego?: boolean } | null>(null)
  const [preparando, setPreparando] = useState(false)
  // Filtros
  const [busqueda, setBusqueda] = useState('')
  const [portal, setPortal] = useState<FiltroPortal>('todos')
  const [tipos, setTipos] = useState<Set<string>>(new Set())
  const [seccionSel, setSeccionSel] = useState('')
  const [plegadas, setPlegadas] = useState<Set<string>>(new Set())
  const [orden, setOrdenEstado] = useState<OrdenMateriales>(leerOrden)
  const setOrden = (o: OrdenMateriales): void => {
    setOrdenEstado(o)
    try {
      localStorage.setItem(CLAVE_ORDEN, o)
    } catch {
      /* se queda solo por ahora */
    }
  }
  const pptx = m.materiales.filter((x) => x.tipo === 'pptx').length

  const prepararPresentaciones = async (): Promise<void> => {
    setPreparando(true)
    try {
      const r = await api.presentacion.prepararMateria(m.id)
      if (r.total === 0) avisar('Todas las presentaciones ya se pueden proyectar')
      else if (r.errores.length) avisar(`${r.convertidas} de ${r.total} convertidas. ${r.errores[0]}`, 'error')
      else avisar(`${r.convertidas} presentaciones listas para proyectar`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setPreparando(false)
    }
  }
  const unidades = useMemo(() => (m.temario.match(/^##\s+(.+)$/gm) ?? []).map((u) => u.replace(/^##\s+/, '')), [m.temario])

  const agregar = async (): Promise<void> => {
    const ids = await api.materiales.agregar(m.id, unidad)
    if (ids.length) avisar(`${ids.length} archivo(s) agregado(s) y texto extraído para la IA`)
    onCambio()
  }
  // Subir un archivo y convertirlo de una vez en examen (queda también como material)
  const subirYConvertir = async (): Promise<void> => {
    const ids = await api.materiales.agregar(m.id, unidad)
    if (!ids.length) return
    onCambio()
    setAExamen({ id: ids[0], titulo: ids.length > 1 ? 'el primer archivo elegido' : 'el archivo subido' })
  }
  const agregarLink = async (): Promise<void> => {
    if (!link.url) return
    await api.materiales.agregarLink(m.id, link.titulo || link.url, link.url, unidad)
    setLink({ titulo: '', url: '' })
    setConEnlace(false)
    onCambio()
  }
  const verTexto = async (id: number, titulo: string): Promise<void> => setVista({ titulo, texto: await api.materiales.texto(id) })
  // Portal: lo compartido lo ven y lo descargan los alumnos (con el portal en línea se sube solo al servidor)
  const compartidos = m.materiales.filter((x) => x.compartido).length
  const compartir = async (ids: number[], si: boolean): Promise<void> => {
    if (!ids.length) return
    await api.materiales.compartir(ids, si)
    onCambio()
    // Confirmación: guardado en la app al momento; el portal en línea lo recibe en la siguiente sincronización (5 s)
    const enLinea = await api.portal.estado().then((e) => e.en_linea).catch(() => false)
    const cuales = ids.length === 1 ? '' : ` (${ids.length} materiales)`
    avisar(
      si
        ? `Guardado${cuales} · ${enLinea ? 'los alumnos lo verán en el portal en unos segundos' : 'visible para alumnos'}`
        : `Guardado${cuales} · ${enLinea ? 'se quita del portal en unos segundos' : 'ya no lo ven los alumnos'}`
    )
  }

  const seccion = useMemo(() => seccionesDe(m.materiales), [m.materiales])
  const secciones = useMemo(() => {
    const n = new Map<string, number>()
    for (const x of m.materiales) n.set(seccion.get(String(x.id))!, (n.get(seccion.get(String(x.id))!) ?? 0) + 1)
    return [...n.entries()].sort(([a], [b]) => (a === SIN_UNIDAD ? 1 : b === SIN_UNIDAD ? -1 : ordenNatural(a, b)))
  }, [m.materiales, seccion])
  const tiposPresentes = useMemo(() => {
    const n = new Map<string, number>()
    for (const x of m.materiales) n.set(x.tipo, (n.get(x.tipo) ?? 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1])
  }, [m.materiales])

  // Todo menos el filtro del portal: así los conteos de «Compartidos / Sin compartir» responden a lo demás
  const casiFiltrados = useMemo(() => {
    return m.materiales.filter(
      (x) => (!tipos.size || tipos.has(x.tipo)) && (!seccionSel || seccion.get(String(x.id)) === seccionSel) && coincide(busqueda, x.titulo, x.unidad, tipoDe(x.tipo).nombre)
    )
  }, [m.materiales, tipos, seccionSel, busqueda, seccion])
  const filtrados = casiFiltrados.filter((x) => (portal === 'todos' ? true : portal === 'compartidos' ? !!x.compartido : !x.compartido))
  const hayFiltro = !!busqueda.trim() || portal !== 'todos' || tipos.size > 0 || !!seccionSel
  const limpiar = (): void => {
    setBusqueda('')
    setPortal('todos')
    setTipos(new Set())
    setSeccionSel('')
  }
  const grupos = useMemo(() => {
    const g = new Map<string, MaterialFila[]>()
    for (const x of filtrados) {
      const k = seccion.get(String(x.id))!
      g.set(k, [...(g.get(k) ?? []), x])
    }
    for (const lista of g.values()) lista.sort((a, b) => ordenNatural(a.unidad, b.unidad) || ordenNatural(a.titulo, b.titulo))
    return [...g.entries()].sort(([a], [b]) => (a === SIN_UNIDAD ? 1 : b === SIN_UNIDAD ? -1 : ordenNatural(a, b)))
  }, [filtrados, seccion])
  // Fuera de «Por unidad»: una sola lista ordenada (a igual fecha, el que se agregó después va primero)
  const ordenados = useMemo(() => {
    const l = [...filtrados]
    const fecha = (x: MaterialFila): string => x.creado ?? ''
    if (orden === 'recientes') l.sort((a, b) => fecha(b).localeCompare(fecha(a)) || b.id - a.id)
    else if (orden === 'antiguos') l.sort((a, b) => fecha(a).localeCompare(fecha(b)) || a.id - b.id)
    else if (orden === 'az') l.sort((a, b) => ordenNatural(a.titulo, b.titulo))
    else if (orden === 'za') l.sort((a, b) => ordenNatural(b.titulo, a.titulo))
    return l
  }, [filtrados, orden])
  const porFecha = orden === 'recientes' || orden === 'antiguos'
  const alternarTipo = (t: string): void =>
    setTipos((s) => {
      const n = new Set(s)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  const alternarPlegada = (k: string): void =>
    setPlegadas((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  const hacerExamen = async (id: number): Promise<void> => {
    try {
      const evId = await api.evaluaciones.desdeCuaderno(id)
      avisar('Examen creado: revisa los puntos y publícalo en el portal con su duración.')
      nav(`/evaluacion/${evId}`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  const filaMaterial = (x: MaterialFila, k: string): JSX.Element => {
    const esPresentacion = m.presentacion_path === x.ruta
    return (
      <li key={x.id} className="group flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 hover:bg-ink-50/60">
        <span className={`inline-flex h-8 w-10 shrink-0 items-center justify-center rounded-md text-[11px] font-bold ring-1 ${tipoDe(x.tipo).tono}`} title={tipoDe(x.tipo).nombre}>{ABREVIATURA[x.tipo] ?? '···'}</span>
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink-900">{x.titulo}</span>
            {esPresentacion && <span className="chip shrink-0 bg-brand-500 text-white">En Modo clase</span>}
          </div>
          <div className="truncate text-xs text-ink-400">
            {k !== x.unidad && x.unidad ? `${x.unidad} · ` : ''}
            {porFecha && x.creado ? `Agregado el ${fechaAlta(x.creado)} · ` : ''}
            {x.texto_len ? `${x.texto_len.toLocaleString('es-MX')} caracteres para la IA` : 'Sin texto para la IA'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* Lo secundario aparece al pasar el mouse o al llegar con el teclado; el interruptor y «Abrir» quedan alineados a la derecha */}
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            {x.texto_len > 0 && <button className="btn-fantasma text-xs" onClick={() => verTexto(x.id, x.titulo)}>Ver texto</button>}
            {!/\.ipynb$/i.test(x.ruta) && !/^https?:/i.test(x.ruta) && x.texto_len > 0 && (
              <button className="btn-fantasma text-xs" title="Convertir este archivo en examen con IA: pasa sus preguntas o genera unas de su contenido" onClick={() => setAExamen({ id: x.id, titulo: x.titulo })}>📝 Convertir en examen</button>
            )}
            {!/\.ipynb$/i.test(x.ruta) && !/^https?:/i.test(x.ruta) && x.texto_len > 0 && (
              <button className="btn-fantasma text-xs" title="Crear con IA un cuestionario jugable (opción múltiple y verdadero/falso) para el juego en vivo tipo Kahoot" onClick={() => setAExamen({ id: x.id, titulo: x.titulo, juego: true })}>🎮 Juego en vivo</button>
            )}
            {(x.tipo === 'pdf' || x.tipo === 'pptx') && (
              <button className="btn-fantasma text-xs" onClick={async () => { await api.materiales.establecerPresentacion(m.id, esPresentacion ? null : x.id); onCambio() }}>{esPresentacion ? 'Quitar de Modo clase' : 'Usar en Modo clase'}</button>
            )}
            <button className="btn-fantasma text-xs text-red-600 hover:bg-red-50" aria-label={`Eliminar ${x.titulo}`} title="Eliminar material" onClick={async () => { if (confirm(`¿Eliminar «${x.titulo}»?`)) { await api.materiales.eliminar(x.id); onCambio() } }}>✕</button>
          </div>
          {/\.ipynb$/i.test(x.ruta) && (
            <button className="btn-fantasma text-xs py-1" title="Examen en el portal: el alumno resuelve este cuaderno con tiempo y vigilancia" onClick={() => void hacerExamen(x.id)}>Hacer examen</button>
          )}
          <InterruptorAlumnos activo={!!x.compartido} titulo={x.titulo} onCambio={(v) => void compartir([x.id], v)} />
          <button className="btn-secundario text-xs py-1" onClick={() => setAbierto({ id: x.id, titulo: x.titulo, ruta: x.ruta })}>Abrir</button>
        </div>
      </li>
    )
  }

  const contar = (f: FiltroPortal): number => casiFiltrados.filter((x) => (f === 'todos' ? true : f === 'compartidos' ? !!x.compartido : !x.compartido)).length
  const filtrosPortal: [FiltroPortal, string][] = [['todos', 'Todos'], ['compartidos', 'Compartidos'], ['sin', 'Sin compartir']]

  return (
    <div className="space-y-4">
      {/* Agregar */}
      <div className="tarjeta p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="w-56 max-w-full"><span className="etiqueta">Guardar en la unidad</span>
            <select className="input" value={unidad} onChange={(e) => setUnidad(e.target.value)}><option value="">Sin unidad</option>{unidades.map((u) => <option key={u}>{u}</option>)}</select>
          </label>
          <button className="btn-primario" onClick={agregar} title="PDF, Word, Excel, PowerPoint, GeoGebra o código: el texto se extrae para la IA">+ Subir archivos</button>
          <button className="btn-secundario" onClick={() => void subirYConvertir()} title="Sube un PDF, Word o PowerPoint y conviértelo en examen de opción múltiple, verdadero/falso y abiertas">📝 Subir y convertir en examen</button>
          <button className={`btn-secundario ${conEnlace ? 'bg-ink-100' : ''}`} aria-expanded={conEnlace} onClick={() => setConEnlace((v) => !v)}>+ Enlace</button>
          {pptx > 0 && (
            <button className="btn-fantasma" disabled={preparando} onClick={prepararPresentaciones} title="Convierte los PowerPoint a PDF para poder proyectarlos dentro del Modo clase">
              {preparando ? 'Preparando…' : `Preparar ${pptx} ${pptx === 1 ? 'presentación' : 'presentaciones'} para proyectar`}
            </button>
          )}
        </div>
        <p className="text-xs text-ink-400">PDF, Word, Excel, PowerPoint, GeoGebra o código. Su texto alimenta a la IA para generar exámenes y ejercicios.</p>
        {conEnlace && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-ink-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              void agregarLink()
            }}
          >
            <label className="flex-[1_1_12rem] min-w-0"><span className="etiqueta">Título</span><input className="input" value={link.titulo} onChange={(e) => setLink({ ...link, titulo: e.target.value })} placeholder="Ej. Simulador de árboles AVL" /></label>
            <label className="flex-[2_1_16rem] min-w-0"><span className="etiqueta">Dirección</span><input className="input" type="url" required autoFocus value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://www.geogebra.org/m/…" /></label>
            <button className="btn-primario" type="submit" disabled={!link.url.trim()}>Agregar enlace</button>
            <button className="btn-fantasma" type="button" onClick={() => setConEnlace(false)}>Cancelar</button>
          </form>
        )}
      </div>

      {m.materiales.length > 0 && (
        <div className="space-y-2.5">
          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por título o unidad" etiqueta="Buscar materiales" />
            <Segmentado etiqueta="Portal de alumnos" valor={portal} onCambio={setPortal} opciones={filtrosPortal.map(([f, t]) => ({ valor: f, texto: t, conteo: contar(f) }))} />
            <select className="input w-auto max-w-[16rem]" value={seccionSel} onChange={(e) => setSeccionSel(e.target.value)} aria-label="Filtrar por unidad">
              <option value="">Todas las unidades</option>
              {secciones.map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-500">
              Ordenar
              <select className="input w-auto py-1" value={orden} onChange={(e) => setOrden(e.target.value as OrdenMateriales)} aria-label="Ordenar materiales">
                {ORDENES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={limpiar}>Limpiar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tipo de archivo">
            {tiposPresentes.map(([t, n]) => (
              <ChipFiltro key={t} activo={tipos.has(t)} onClick={() => alternarTipo(t)} conteo={n}>{tipoDe(t).nombre}</ChipFiltro>
            ))}
            <Conteo visibles={filtrados.length} total={m.materiales.length} nombre="materiales" hayFiltro={hayFiltro} />
            <span className="whitespace-nowrap text-xs text-emerald-700">· {compartidos} visibles para alumnos</span>
          </div>
          {hayFiltro && filtrados.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-100/70 px-3 py-2 text-xs text-ink-600">
              <span>Con estos filtros:</span>
              <button className="btn-secundario text-xs py-1" disabled={filtrados.every((x) => x.compartido)} onClick={() => compartir(filtrados.map((x) => x.id), true)}>Compartir los {filtrados.length}</button>
              <button className="btn-fantasma text-xs py-1" disabled={!filtrados.some((x) => x.compartido)} onClick={() => compartir(filtrados.map((x) => x.id), false)}>Dejar de compartirlos</button>
            </div>
          )}
        </div>
      )}

      {/* Lista por sección */}
      {m.materiales.length === 0 && (
        <div className="tarjeta px-5 py-8 text-center">
          <div className="font-medium text-ink-800">Aún no hay materiales</div>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Sube tu presentación, apuntes, prácticas o ejercicios. El texto se extrae para que la IA genere exámenes y ejercicios alineados a tu material, y puedes compartirlos con tus alumnos en el portal.</p>
        </div>
      )}
      {m.materiales.length > 0 && filtrados.length === 0 && (
        <div className="tarjeta px-5 py-8 text-center">
          <div className="font-medium text-ink-800">Ningún material coincide</div>
          <button className="btn-secundario mt-3" onClick={limpiar}>Limpiar filtros</button>
        </div>
      )}
      {orden !== 'unidad' && ordenados.length > 0 && (
        <section className="tarjeta overflow-hidden">
          <ul className="divide-y divide-ink-100">{ordenados.map((x) => filaMaterial(x, ''))}</ul>
        </section>
      )}
      {orden === 'unidad' && grupos.map(([k, lista]) => {
        const plegada = plegadas.has(k)
        const todos = lista.every((x) => x.compartido)
        const visibles = lista.filter((x) => x.compartido).length
        return (
          <section key={k} className="tarjeta overflow-hidden">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-ink-50/70 px-4 py-2">
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={!plegada} onClick={() => alternarPlegada(k)}>
                <span className={`text-ink-400 transition-transform duration-200 ${plegada ? '-rotate-90' : ''}`} aria-hidden>▾</span>
                <span className="truncate font-semibold text-ink-800">{k}</span>
                <span className="text-xs text-ink-400">{lista.length}{visibles ? ` · ${visibles} para alumnos` : ''}</span>
              </button>
              <button className="btn-fantasma text-xs py-1" onClick={() => compartir(lista.map((x) => x.id), !todos)}>{todos ? 'Dejar de compartir la sección' : 'Compartir la sección'}</button>
            </header>
            {!plegada && (
              <ul className="divide-y divide-ink-100">
                {lista.map((x) => filaMaterial(x, k))}
              </ul>
            )}
          </section>
        )
      })}
      {abierto && <VisorMaterial material={abierto} onCerrar={() => setAbierto(null)} />}
      {aExamen && (
        <ConvertirExamen
          material={aExamen}
          juego={aExamen.juego}
          onCerrar={() => setAExamen(null)}
          onListo={(evId) => {
            setAExamen(null)
            nav(`/evaluacion/${evId}`)
          }}
        />
      )}
      <Modal titulo={vista?.titulo ?? ''} abierto={!!vista} onCerrar={() => setVista(null)} ancho="max-w-3xl">
        <pre className="whitespace-pre-wrap text-xs font-mono text-ink-700 max-h-[65vh] overflow-y-auto select-text">{vista?.texto}</pre>
      </Modal>
    </div>
  )
}

// ---------------- Evaluaciones y tareas ----------------
/** Nombre legible de cada tipo y su familia: lo que se califica (exámenes, tareas) o material de clase. */
const TIPO_EVALUACION: Record<TipoEvaluacion, { nombre: string; familia: 'examen' | 'tarea' | 'material' }> = {
  diagnostico: { nombre: 'Diagnóstico', familia: 'examen' },
  examen: { nombre: 'Examen', familia: 'examen' },
  examen_sorpresa: { nombre: 'Examen sorpresa', familia: 'examen' },
  examen_oral: { nombre: 'Examen oral', familia: 'examen' },
  cuestionario: { nombre: 'Cuestionario', familia: 'examen' },
  tarea: { nombre: 'Tarea', familia: 'tarea' },
  ejercicios: { nombre: 'Ejercicios', familia: 'tarea' },
  ejemplos: { nombre: 'Ejemplos', familia: 'material' },
  glosario: { nombre: 'Glosario', familia: 'material' },
  material_apoyo: { nombre: 'Material de apoyo', familia: 'material' },
  plan_sesion: { nombre: 'Plan de sesión', familia: 'material' },
  presentacion: { nombre: 'Presentación', familia: 'material' },
  clase_completa: { nombre: 'Clase completa', familia: 'material' },
  apuntes: { nombre: 'Apuntes', familia: 'material' }
}
const TONO_FAMILIA = { examen: 'bg-violet-50 text-violet-700 ring-violet-200', tarea: 'bg-sky-50 text-sky-700 ring-sky-200', material: 'bg-ink-100 text-ink-600 ring-ink-200' }
const tipoEv = (t: string): { nombre: string; familia: 'examen' | 'tarea' | 'material' } => TIPO_EVALUACION[t as TipoEvaluacion] ?? { nombre: t.replace(/_/g, ' '), familia: 'material' }

type Familia = 'todas' | 'calificables' | 'material'
type CuandoEv = 'todas' | 'proximas' | 'aplicadas' | 'sin_fecha'
type OrdenEv = 'fecha' | 'recientes' | 'az'
const ORDENES_EV: [OrdenEv, string][] = [['fecha', 'Por fecha de aplicación'], ['recientes', 'Más recientes'], ['az', 'A–Z']]

function TabEvaluaciones({ m }: { m: Detalle }): JSX.Element {
  const hoy = hoyIso()
  const clave = `materia.${m.id}.evaluaciones`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [familia, setFamilia] = useRecordado<Familia>(`${clave}.familia`, 'todas')
  const [cuando, setCuando] = useRecordado<CuandoEv>(`${clave}.cuando`, 'todas')
  const [tipos, setTipos] = useRecordado<string[]>(`${clave}.tipos`, [])
  const [orden, setOrden] = useRecordado<OrdenEv>(`${clave}.orden`, 'fecha')
  type Ev = Detalle['evaluaciones'][number]

  const pasa = useMemo(
    () => ({
      busqueda: (e: Ev) => coincide(busqueda, e.titulo, tipoEv(e.tipo).nombre),
      familia: (e: Ev) => familia === 'todas' || (familia === 'material' ? tipoEv(e.tipo).familia === 'material' : tipoEv(e.tipo).familia !== 'material'),
      cuando: (e: Ev) =>
        cuando === 'todas' || (cuando === 'sin_fecha' ? !e.fecha_aplicacion : !!e.fecha_aplicacion && (cuando === 'proximas' ? e.fecha_aplicacion >= hoy : e.fecha_aplicacion < hoy)),
      tipo: (e: Ev) => !tipos.length || tipos.includes(e.tipo)
    }),
    [busqueda, familia, cuando, tipos, hoy]
  )
  type Filtro = keyof typeof pasa
  const salvo = (excepto: Filtro): Ev[] => m.evaluaciones.filter((e) => (Object.keys(pasa) as Filtro[]).every((k) => k === excepto || pasa[k](e)))
  const lista = useMemo(() => {
    const l = m.evaluaciones.filter((e) => Object.values(pasa).every((f) => f(e)))
    // «Por fecha» es el orden en que llegan: con fecha primero, luego las que no tienen
    if (orden === 'recientes') l.sort((a, b) => b.creado.localeCompare(a.creado) || b.id - a.id)
    else if (orden === 'az') l.sort((a, b) => ordenNatural(a.titulo, b.titulo))
    else l.sort((a, b) => (a.fecha_aplicacion ? 0 : 1) - (b.fecha_aplicacion ? 0 : 1) || (a.fecha_aplicacion ?? '').localeCompare(b.fecha_aplicacion ?? '') || a.id - b.id)
    return l
  }, [m.evaluaciones, pasa, orden])
  const hayFiltro = !!busqueda.trim() || familia !== 'todas' || cuando !== 'todas' || tipos.length > 0
  const quitarFiltros = (): void => {
    setBusqueda('')
    setFamilia('todas')
    setCuando('todas')
    setTipos([])
  }
  const paraFamilia = salvo('familia')
  const paraCuando = salvo('cuando')
  const paraTipo = salvo('tipo')
  const tiposPresentes = useMemo(() => {
    const n = new Map<string, number>()
    for (const e of m.evaluaciones) n.set(e.tipo, (n.get(e.tipo) ?? 0) + 1)
    return [...n.keys()].sort((a, b) => ordenNatural(tipoEv(a).nombre, tipoEv(b).nombre))
  }, [m.evaluaciones])
  const enCuando = (e: Ev, k: CuandoEv): boolean =>
    k === 'todas' || (k === 'sin_fecha' ? !e.fecha_aplicacion : !!e.fecha_aplicacion && (k === 'proximas' ? e.fecha_aplicacion >= hoy : e.fecha_aplicacion < hoy))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-[1_1_18rem] text-sm text-ink-500">Exámenes, cuestionarios, tareas, ejercicios y material generados o capturados para esta materia.</p>
        <Link to={`/ia/${m.id}`} className="btn-primario">✦ Generar con IA</Link>
      </div>

      {m.evaluaciones.length > 0 && (
        <div className="space-y-2" role="search" aria-label="Filtrar evaluaciones y tareas">
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por título o tipo" etiqueta="Buscar evaluaciones y tareas" />
            <Segmentado
              etiqueta="Qué es"
              valor={familia}
              onCambio={setFamilia}
              opciones={([['todas', 'Todo'], ['calificables', 'Para calificar'], ['material', 'Material de clase']] as [Familia, string][]).map(([k, t]) => ({
                valor: k,
                texto: t,
                conteo: paraFamilia.filter((e) => k === 'todas' || (k === 'material' ? tipoEv(e.tipo).familia === 'material' : tipoEv(e.tipo).familia !== 'material')).length
              }))}
            />
            <Segmentado
              etiqueta="Cuándo se aplica"
              valor={cuando}
              onCambio={setCuando}
              opciones={([['todas', 'Cualquier fecha'], ['proximas', 'Próximas'], ['aplicadas', 'Ya aplicadas'], ['sin_fecha', 'Sin fecha']] as [CuandoEv, string][])
                .map(([k, t]) => ({ valor: k, texto: t, conteo: paraCuando.filter((e) => enCuando(e, k)).length }))
                .filter((o) => o.valor === 'todas' || o.valor === cuando || o.conteo > 0)}
            />
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-500">
              Ordenar
              <select className="input w-auto py-1" value={orden} onChange={(e) => setOrden(e.target.value as OrdenEv)} aria-label="Ordenar evaluaciones">
                {ORDENES_EV.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tipo">
            {tiposPresentes.length > 1 &&
              tiposPresentes.map((t) => (
                <ChipFiltro key={t} activo={tipos.includes(t)} onClick={() => setTipos(tipos.includes(t) ? tipos.filter((x) => x !== t) : [...tipos, t])} conteo={paraTipo.filter((e) => e.tipo === t).length}>
                  {tipoEv(t).nombre}
                </ChipFiltro>
              ))}
            <Conteo visibles={lista.length} total={m.evaluaciones.length} nombre={m.evaluaciones.length === 1 ? 'elemento' : 'elementos'} hayFiltro={hayFiltro} />
          </div>
        </div>
      )}

      <div className="tarjeta overflow-hidden">
        <ul className="divide-y divide-ink-100">
          {lista.map((e) => {
            const t = tipoEv(e.tipo)
            const f = e.fecha_aplicacion
            return (
              <li key={e.id}>
                <Link to={`/evaluacion/${e.id}`} className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-ink-50/70 focus-visible:bg-ink-50/70 focus-visible:outline-none">
                  <span className={`chip w-32 shrink-0 justify-center whitespace-nowrap ring-1 ${TONO_FAMILIA[t.familia]}`}>{t.nombre}</span>
                  <div className="min-w-0 flex-[1_1_14rem]">
                    <div className="truncate font-medium text-ink-900">{e.titulo}</div>
                    <div className="truncate text-xs text-ink-400">{e.puntos_totales ? `${e.puntos_totales} pts · ` : ''}creada el {fmtFechaCorta(diaMx(e.creado) || hoy)}</div>
                  </div>
                  <span className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-xs">
                    {!f ? (
                      <span className="text-ink-400">Sin fecha</span>
                    ) : f === hoy ? (
                      <span className="chip bg-brand-500 text-white">Hoy</span>
                    ) : (
                      <span className={f > hoy ? 'text-ink-700' : 'text-ink-400'}>{f > hoy ? 'Se aplica' : 'Se aplicó'} el {fmtFechaCorta(f)}</span>
                    )}
                    <span className="text-ink-300 transition-colors group-hover:text-ink-500" aria-hidden>›</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
        {lista.length === 0 && (
          <SinResultados
            hayFiltro={hayFiltro}
            onLimpiar={quitarFiltros}
            vacio={
              <>
                <div className="font-medium text-ink-700">Aún no hay evaluaciones ni tareas</div>
                <p className="mx-auto mt-1 max-w-md">Genera exámenes, tareas, ejercicios o material con la IA a partir del temario y tus materiales.</p>
              </>
            }
          />
        )}
      </div>
    </div>
  )
}

// ---------------- Glosario ----------------
type OrdenGlosario = 'az' | 'za' | 'recientes'

function TabGlosario({ m, onCambio }: { m: Detalle; onCambio: () => void }): JSX.Element {
  const [f, setF] = useState<Partial<TerminoGlosario>>({})
  const clave = `materia.${m.id}.glosario`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [sinEjemplo, setSinEjemplo] = useRecordado(`${clave}.sinEjemplo`, false)
  const [orden, setOrden] = useRecordado<OrdenGlosario>(`${clave}.orden`, 'az')
  const refForm = useRef<HTMLDivElement>(null)
  const guardar = async (): Promise<void> => {
    if (!f.termino) return
    await api.glosario.guardar({ ...f, materia_id: m.id })
    setF({})
    onCambio()
  }
  const editar = (g: TerminoGlosario): void => {
    setF(g)
    // En ventana angosta el formulario queda debajo de la lista: se lleva a la vista
    const form = refForm.current
    const lista = form?.previousElementSibling as HTMLElement | null
    if (form && lista && form.offsetTop > lista.offsetTop + 8) form.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const porBusqueda = m.glosario.filter((g) => coincide(busqueda, g.termino, g.definicion, g.ejemplo))
  const lista = useMemo(() => {
    const l = porBusqueda.filter((g) => !sinEjemplo || !g.ejemplo?.trim())
    if (orden === 'recientes') l.sort((a, b) => b.id - a.id)
    else l.sort((a, b) => (orden === 'za' ? -1 : 1) * ordenNatural(a.termino, b.termino))
    return l
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.glosario, busqueda, sinEjemplo, orden])
  const hayFiltro = !!busqueda.trim() || sinEjemplo
  const quitarFiltros = (): void => {
    setBusqueda('')
    setSinEjemplo(false)
  }
  const nSinEjemplo = porBusqueda.filter((g) => !g.ejemplo?.trim()).length

  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="min-w-0 flex-[999_1_28rem] space-y-2.5">
        {m.glosario.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filtrar glosario">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar término o definición" etiqueta="Buscar en el glosario" />
            {(nSinEjemplo > 0 || sinEjemplo) && (
              <ChipFiltro activo={sinEjemplo} onClick={() => setSinEjemplo(!sinEjemplo)} conteo={nSinEjemplo}>Sin ejemplo</ChipFiltro>
            )}
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-ink-500">
              Ordenar
              <select className="input w-auto py-1" value={orden} onChange={(e) => setOrden(e.target.value as OrdenGlosario)} aria-label="Ordenar glosario">
                <option value="az">A–Z</option>
                <option value="za">Z–A</option>
                <option value="recientes">Más recientes</option>
              </select>
            </label>
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
            <Conteo visibles={lista.length} total={m.glosario.length} nombre={m.glosario.length === 1 ? 'término' : 'términos'} hayFiltro={hayFiltro} />
          </div>
        )}
        <div className="tarjeta overflow-hidden">
          <ul className="divide-y divide-ink-100">
            {lista.map((g) => (
              <li key={g.id} className={`group flex gap-3 px-4 py-3 transition-colors ${f.id === g.id ? 'bg-brand-500/5' : 'hover:bg-ink-50/60'}`}>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-ink-900 break-words">{g.termino}</div>
                  <Markdown texto={g.definicion} className="text-sm" />
                  {g.ejemplo && <div className="text-xs text-ink-500 mt-1"><b>Ejemplo:</b> {g.ejemplo}</div>}
                </div>
                {/* Se ven al pasar el mouse o al llegar con el teclado */}
                <div className="flex h-fit shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button className="btn-fantasma text-xs" onClick={() => editar(g)}>Editar</button>
                  <button className="btn-fantasma text-xs text-red-600 hover:bg-red-50" aria-label={`Eliminar ${g.termino}`} title="Eliminar término" onClick={async () => { if (!confirm(`¿Eliminar «${g.termino}» del glosario?`)) return; await api.glosario.eliminar(g.id); if (f.id === g.id) setF({}); onCambio() }}>✕</button>
                </div>
              </li>
            ))}
          </ul>
          {lista.length === 0 && (
            <SinResultados
              hayFiltro={hayFiltro}
              onLimpiar={quitarFiltros}
              vacio={
                <>
                  <div className="font-medium text-ink-700">Aún no hay términos</div>
                  <p className="mx-auto mt-1 max-w-md">Genera un glosario completo en Estudio IA o agrégalos a mano con el formulario.</p>
                </>
              }
            />
          )}
        </div>
      </div>
      <div ref={refForm} className="tarjeta p-4 space-y-3 min-w-0 flex-[1_1_360px] scroll-mt-28">
        <h3 className="font-semibold">{f.id ? 'Editar término' : 'Nuevo término'}</h3>
        <label className="block"><span className="etiqueta">Término</span><input className="input" value={f.termino ?? ''} onChange={(e) => setF({ ...f, termino: e.target.value })} /></label>
        <label className="block"><span className="etiqueta">Definición</span><textarea className="input" rows={3} value={f.definicion ?? ''} onChange={(e) => setF({ ...f, definicion: e.target.value })} /></label>
        <label className="block"><span className="etiqueta">Ejemplo (opcional)</span><textarea className="input" rows={2} value={f.ejemplo ?? ''} onChange={(e) => setF({ ...f, ejemplo: e.target.value })} /></label>
        <div className="flex justify-end gap-2">{f.id && <button className="btn-secundario" onClick={() => setF({})}>Cancelar</button>}<button className="btn-primario" disabled={!f.termino?.trim()} onClick={guardar}>{f.id ? 'Guardar cambios' : 'Agregar término'}</button></div>
      </div>
    </div>
  )
}

// ---------------- Configuración ----------------
function TabConfig({ m, onCambio }: { m: Detalle; onCambio: () => void }): JSX.Element {
  const nav = useNavigate()
  const [f, setF] = useState({ nombre: m.nombre, clave: m.clave, cuatrimestre: m.cuatrimestre, descripcion: m.descripcion, temario: m.temario, color: m.color, carrera_id: m.carrera_id, periodo_id: m.periodo_id })
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [h, setH] = useState<Partial<Horario>>({ dia: 1, hora_inicio: '07:00', hora_fin: '09:00', aula: '' })
  useEffect(() => {
    api.carreras.listar().then(setCarreras)
  }, [])
  const [confirmar, setConfirmar] = useState(false)
  const guardar = async (): Promise<void> => {
    await api.materias.guardar({ id: m.id, ...f, presentacion_path: m.presentacion_path })
    avisar('Materia guardada')
    onCambio()
  }
  const eliminar = async (password: string): Promise<void> => {
    await api.materias.eliminar(m.id, password)
    avisar(`Materia "${m.nombre}" eliminada`)
    nav('/materias')
  }
  const quitarHorario = async (x: Horario): Promise<void> => {
    if (!confirm(`¿Quitar el horario del ${DIAS[x.dia].toLowerCase()} ${x.hora_inicio}–${x.hora_fin}?\n\nLas sesiones ya generadas no se borran.`)) return
    await api.horarios.eliminar(x.id)
    onCambio()
  }
  const agregarHorario = async (): Promise<void> => {
    await api.horarios.guardar({ ...h, materia_id: m.id })
    onCambio()
  }
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="tarjeta p-5 space-y-3 min-w-0 flex-[999_1_28rem]">
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2"><span className="etiqueta">Nombre</span><input className="input" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></label>
          <label><span className="etiqueta">Clave</span><input className="input" value={f.clave} onChange={(e) => setF({ ...f, clave: e.target.value })} /></label>
          <label><span className="etiqueta">Nivel (semestre o cuatrimestre)</span><input type="number" className="input" value={f.cuatrimestre} onChange={(e) => setF({ ...f, cuatrimestre: Number(e.target.value) })} /></label>
          <label><span className="etiqueta">Carrera</span><select className="input" value={f.carrera_id} onChange={(e) => setF({ ...f, carrera_id: Number(e.target.value) })}>{carreras.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
          <label><span className="etiqueta">Color</span><input type="color" className="input h-9" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></label>
          <label className="col-span-2"><span className="etiqueta">Descripción</span><input className="input" value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} /></label>
          <label className="col-span-2"><span className="etiqueta">Temario (markdown). La IA lo usa como base para todo lo que genera.</span><textarea rows={12} className="input font-mono text-xs" value={f.temario} onChange={(e) => setF({ ...f, temario: e.target.value })} /></label>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={(m.portal_programar ?? 1) === 1}
            onChange={async (e) => {
              await api.materias.portalProgramar(m.id, e.target.checked)
              avisar(e.target.checked ? 'Sus alumnos ven «Programar» en el portal' : 'Sus alumnos ya no ven «Programar» en el portal')
              onCambio()
            }}
          />
          <span>Portal de alumnos: mostrar la pestaña <b>Programar</b> (Python y JavaScript). Quítala en materias donde no se programa.</span>
        </label>
        <div className="flex justify-between">
          <button className="btn-peligro" onClick={() => setConfirmar(true)}>Eliminar materia</button>
          <button className="btn-primario" onClick={guardar}>Guardar</button>
        </div>
      </div>
      <div className="tarjeta p-5 space-y-3 min-w-0 flex-[1_1_380px]">
        <h3 className="font-semibold">Horario semanal</h3>
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
          {m.horarios.map((x) => (
            <li key={x.id} className="group flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-ink-50/70">
              <span className="w-20 shrink-0 font-medium">{DIAS[x.dia]}</span><span className="shrink-0 whitespace-nowrap font-mono text-ink-700">{x.hora_inicio}–{x.hora_fin}</span><span className="text-ink-500 flex-1 min-w-0 truncate">{x.aula}</span>
              {/* Se ve al pasar el mouse o al llegar con el teclado */}
              <button className="btn-fantasma text-xs text-red-600 hover:bg-red-50 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100" aria-label={`Quitar horario del ${DIAS[x.dia]}`} title="Quitar horario" onClick={() => quitarHorario(x)}>✕</button>
            </li>
          ))}
          {m.horarios.length === 0 && <li className="px-3 py-2 text-ink-500 text-sm">Sin horario: agrégalo abajo para poder generar las sesiones.</li>}
        </ul>
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-ink-100">
          <label><span className="etiqueta">Día</span><select className="input" value={h.dia} onChange={(e) => setH({ ...h, dia: Number(e.target.value) })}>{[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DIAS[d]}</option>)}</select></label>
          <label><span className="etiqueta">Aula</span><input className="input" value={h.aula ?? ''} onChange={(e) => setH({ ...h, aula: e.target.value })} /></label>
          <label><span className="etiqueta">Inicio</span><input type="time" className="input" value={h.hora_inicio} onChange={(e) => setH({ ...h, hora_inicio: e.target.value })} /></label>
          <label><span className="etiqueta">Fin</span><input type="time" className="input" value={h.hora_fin} onChange={(e) => setH({ ...h, hora_fin: e.target.value })} /></label>
        </div>
        <button className="btn-secundario w-full justify-center" onClick={agregarHorario}>+ Agregar horario</button>
        <p className="text-xs text-ink-500">Después de definir el horario, ve a “Plan y sesiones” y genera las sesiones del periodo.</p>
      </div>
      <ModalPassword
        abierto={confirmar}
        titulo={`Eliminar ${m.nombre}`}
        advertencia={`Se borran también ${m.horarios.length === 1 ? 'su horario' : `sus ${m.horarios.length} horarios`}, todas sus sesiones y actividades, la asistencia registrada, ${plural(m.materiales.length, 'material', 'materiales')}, ${plural(m.evaluaciones.length, 'evaluación', 'evaluaciones')} con sus calificaciones y ${plural(m.glosario.length, 'término', 'términos')} del glosario. Esta acción no se puede deshacer.`}
        textoBoton="Eliminar materia"
        onCerrar={() => setConfirmar(false)}
        onConfirmar={eliminar}
      />
    </div>
  )
}

/** "1 material" / "21 materiales", para que los avisos de borrado se lean bien. */
function plural(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** Asistencia ya registrada de una sesión, con «Justificar» para faltas y retardos sin entrar al Modo clase. */
function AsistenciaDeSesion({ sesion, materiaId }: { sesion: Sesion; materiaId: number }): JSX.Element | null {
  const [registros, setRegistros] = useState<{ alumno_id: number; estado: string; nota: string }[]>([])
  const [alumnos, setAlumnos] = useState<Alumno[]>([])
  const [todos, setTodos] = useState(false)
  const leer = (): void => {
    api.asistencia.porSesion(sesion.id).then(setRegistros).catch(() => undefined)
  }
  useEffect(() => {
    leer()
    api.materias.obtener(materiaId).then((d) => setAlumnos(d?.alumnos ?? []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sesion.id, materiaId])
  if (!registros.length) return null
  const nombre = (id: number): string => {
    const a = alumnos.find((x) => x.id === id)
    return a ? `${a.apellidos} ${a.nombre}`.trim() : `Alumno ${id}`
  }
  const lista = registros.filter((r) => todos || r.estado !== 'presente').sort((a, b) => nombre(a.alumno_id).localeCompare(nombre(b.alumno_id), 'es'))
  const cuenta = (e: string): number => registros.filter((r) => r.estado === e).length
  const etiqueta: Record<string, string> = { presente: 'Presente', ausente: 'Falta', retardo: 'Retardo', justificado: 'Justificada' }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <span className="etiqueta">Asistencia de la sesión · P {cuenta('presente')} · A {cuenta('ausente')} · R {cuenta('retardo')} · J {cuenta('justificado')}</span>
        <button className="btn-fantasma text-xs" onClick={() => setTodos(!todos)}>{todos ? 'Solo faltas y retardos' : 'Ver todos'}</button>
      </div>
      <ul className="rounded-lg border border-ink-200 divide-y divide-ink-100">
        {lista.map((r) => (
          <li key={r.alumno_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
            <span className="flex-[1_1_12rem] min-w-0 break-words">{nombre(r.alumno_id)}{r.nota && <span className="block text-xs text-ink-400">{r.nota}</span>}</span>
            <span className={`text-xs font-medium ${r.estado === 'ausente' ? 'text-red-700' : r.estado === 'retardo' ? 'text-amber-700' : 'text-ink-500'}`}>{etiqueta[r.estado] ?? r.estado}</span>
            <BotonJustificar o={{ sesionId: sesion.id, alumnoId: r.alumno_id, alumno: nombre(r.alumno_id), fecha: fmtFechaCorta(sesion.fecha), estado: r.estado }} onCambio={leer} />
          </li>
        ))}
        {lista.length === 0 && <li className="px-3 py-2 text-sm text-ink-500">Nadie faltó ni llegó tarde.</li>}
      </ul>
    </div>
  )
}

/** Aviso del docente al grupo: llega a la campana del portal de cada alumno (en grupos mixtos, a todos o a una carrera). */
function BotonAviso({ m }: { m: Detalle }): JSX.Element {
  const [abierto, setAbierto] = useState(false)
  const [titulo, setTitulo] = useState('')
  const [cuerpo, setCuerpo] = useState('')
  const [carrera, setCarrera] = useState<number | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [carreras, setCarreras] = useState<Carrera[]>([])
  useEffect(() => {
    if (abierto) api.carreras.listar().then(setCarreras)
  }, [abierto])
  // Carreras de los alumnos inscritos: con más de una, se puede avisar solo a una
  const delGrupo = useMemo(() => {
    const ids = new Set(m.alumnos.filter((a) => a.activo).map((a) => a.carrera_id).filter((x): x is number => x != null))
    return carreras.filter((c) => ids.has(c.id))
  }, [m.alumnos, carreras])
  const cerrar = (): void => {
    setAbierto(false)
    setTitulo('')
    setCuerpo('')
    setCarrera(null)
  }
  const enviar = async (): Promise<void> => {
    setEnviando(true)
    try {
      const n = await api.portal.aviso(m.id, titulo, cuerpo, carrera)
      avisar(n ? `Aviso enviado a ${n} alumno${n === 1 ? '' : 's'}` : 'Nadie lo recibió: ningún alumno del grupo tiene acceso al portal')
      cerrar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setEnviando(false)
    }
  }
  return (
    <>
      <button className="btn-secundario" onClick={() => setAbierto(true)}>📣 Aviso a alumnos</button>
      <Modal titulo={`Aviso a ${m.nombre}`} abierto={abierto} onCerrar={cerrar}>
        <p className="text-sm text-ink-500 mb-3">Les llega a la campana del portal y lo ven arriba de sus Actividades hasta que lo marquen como leído.</p>
        {delGrupo.length > 1 && (
          <label className="block mb-3">
            <span className="etiqueta">Para</span>
            <select className="input" value={carrera ?? ''} onChange={(e) => setCarrera(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Todo el grupo</option>
              {delGrupo.map((c) => <option key={c.id} value={c.id}>Solo {c.nombre}</option>)}
            </select>
          </label>
        )}
        <label className="block mb-3">
          <span className="etiqueta">Aviso</span>
          <input className="input" maxLength={200} value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Mañana no hay clase" autoFocus />
        </label>
        <label className="block">
          <span className="etiqueta">Detalle (opcional)</span>
          <textarea className="input min-h-[96px]" maxLength={2000} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-fantasma" onClick={cerrar}>Cancelar</button>
          <button className="btn-primario" disabled={!titulo.trim() || enviando} onClick={enviar}>{enviando ? 'Enviando…' : 'Enviar aviso'}</button>
        </div>
      </Modal>
    </>
  )
}
