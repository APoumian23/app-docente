import { useEffect, useMemo, useRef, useState } from 'react'
import VisorMaterial from '../components/VisorMaterial'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api, type AlertaFaltas, type MateriaDetalle } from '../lib/api'
import { useClase, abrirEnClase } from '../store/clase'
import Reloj from '../components/Reloj'
import Markdown from '../components/Markdown'
import { avisar } from '../components/Aviso'
import InscribirAlumnos from '../components/InscribirAlumnos'
import { COLOR_NIVEL_FALTAS } from '../components/CalificacionesMateria'
import { Buscador, ChipFiltro, SinResultados, coincide } from '../components/Filtros'
import { ETIQUETA_NIVEL_FALTAS } from '@shared/proyeccion'
import { fmtMinSeg, ahoraMx, aMinutos } from '../lib/tiempo'
import type { Alumno, Asistencia, Carrera, EstadoAsistencia, Evaluacion, TipoActividad } from '@shared/types'

const ICONO: Record<TipoActividad, string> = { apertura: '▶', exposicion: '▤', ejercicio: '✎', discusion: '☰', evaluacion: '✓', receso: '☕', cierre: '■' }
const ESTADOS: { v: EstadoAsistencia; t: string; n: string; c: string }[] = [
  { v: 'presente', t: 'P', n: 'Presente', c: 'bg-green-500 text-white' },
  { v: 'retardo', t: 'R', n: 'Retardo', c: 'bg-amber-500 text-white' },
  { v: 'ausente', t: 'A', n: 'Ausente', c: 'bg-red-500 text-white' },
  { v: 'justificado', t: 'J', n: 'Justificado', c: 'bg-sky-500 text-white' }
]

type Panel = 'actividades' | 'asistencia' | 'presentacion' | 'material'

export default function ModoClase(): JSX.Element {
  const { sesionId } = useParams()
  const nav = useNavigate()
  // Con selectores: el segundero solo repinta el reloj y la barra de avance, no la lista de alumnos
  const sesion = useClase((e) => e.sesion)
  const indice = useClase((e) => e.indice)
  const corriendo = useClase((e) => e.corriendo)
  const { pausar, siguiente: irSiguiente, anterior, irA, ajustar, reiniciarActividad } = useClase.getState()
  const [materia, setMateria] = useState<MateriaDetalle | null>(null)
  // Material abierto en el visor de la app
  const [abierto, setAbierto] = useState<{ id: number; titulo: string; ruta: string } | null>(null)
  const [inscribiendo, setInscribiendo] = useState(false)
  // Grupo con varias carreras en la misma materia (Álgebra): cada alumno con la suya y filtro por carrera
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [carreraF, setCarreraF] = useState<number | null>(null)
  // Solo para encontrar a alguien en la lista: no cambian a quién marcan «Todos / Resto presentes»
  const [buscarAlumno, setBuscarAlumno] = useState('')
  const [soloSinRegistro, setSoloSinRegistro] = useState(false)
  useEffect(() => {
    api.carreras.listar().then(setCarreras).catch(() => undefined)
  }, [])
  const [asistencia, setAsistencia] = useState<Asistencia[]>([])
  const [participaciones, setParticipaciones] = useState<Record<number, number>>({})
  const [alertas, setAlertas] = useState<AlertaFaltas[]>([])
  const [panel, setPanel] = useState<Panel>('actividades')
  const [tolerancia, setTolerancia] = useState(10)
  const [pantallaCompleta, setPantallaCompleta] = useState(false)
  const [diapositivas, setDiapositivas] = useState<Evaluacion | null>(null)
  const [diapo, setDiapo] = useState(0)
  const [presEstado, setPresEstado] = useState<{ pdf: string | null; convertible: boolean }>({ pdf: null, convertible: false })
  const [convirtiendo, setConvirtiendo] = useState(false)
  // Apilado (ventana angosta o texto ampliado), el panel elegido va arriba: se vuelve al inicio al cambiarlo
  const refCuerpo = useRef<HTMLDivElement>(null)
  useEffect(() => {
    refCuerpo.current?.scrollTo({ top: 0 })
  }, [panel])
  // Hora de México que se refresca sola, para que la sugerencia de retardo cambie con el tiempo
  const [ahora, setAhora] = useState(ahoraMx)
  useEffect(() => {
    const t = setInterval(() => setAhora(ahoraMx()), 20_000)
    return () => clearInterval(t)
  }, [])

  // Cargar la sesión indicada en la ruta si no es la que está en el reloj (p. ej. con "atrás");
  // si no se cambia, la ruta vuelve a la clase en curso
  useEffect(() => {
    const id = Number(sesionId)
    if (!id || sesion?.id === id) return
    abrirEnClase(id).then((ok) => {
      const actual = useClase.getState().sesion
      if (!ok && actual) nav(`/clase/${actual.id}`, { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sesionId])

  useEffect(() => {
    const ruta = sesion?.presentacion_path || materia?.presentacion_path
    if (!ruta) return setPresEstado({ pdf: null, convertible: false })
    api.presentacion.estado(ruta).then(setPresEstado)
  }, [sesion?.presentacion_path, materia?.presentacion_path])

  useEffect(() => {
    if (!sesion) return
    api.materias.obtener(sesion.materia_id).then(setMateria)
    api.asistencia.porSesion(sesion.id).then(setAsistencia)
    leerParticipaciones(sesion.id)
    api.faltas.alertas(sesion.materia_id).then(setAlertas).catch(() => undefined)
    api.ajustes.leer().then((a) => setTolerancia(a.tolerancia_retardo_min))
  }, [sesion?.id, sesion?.materia_id])

  const acts = sesion?.actividades ?? []
  const actual = acts[indice]
  const siguiente = acts[indice + 1]
  // Cada diapositiva puede traer «Notas:» al final: lo que el docente explica; no se proyecta
  const slides = useMemo(
    () =>
      diapositivas
        ? diapositivas.contenido.split(/\n---\n/).map((x) => {
            const [lamina, ...notas] = x.trim().split(/\n\s*Notas:\s*/i)
            return { lamina: lamina.trim(), notas: notas.join('\n').trim() }
          })
        : [],
    [diapositivas]
  )
  const [verNotas, setVerNotas] = useState(true)

  // Igual que el botón ▶: además de arrancar el reloj, marca la sesión «en curso»
  const iniciar = async (): Promise<void> => {
    const s = useClase.getState().sesion
    if (!s) return
    useClase.getState().iniciar()
    if (s.estado === 'planeada') await api.sesiones.estado(s.id, 'en_curso')
  }
  const alternar = (): Promise<void> | void => (useClase.getState().corriendo ? pausar() : iniciar())

  // El manejador se registra una vez y siempre llama a la versión más reciente
  const teclas = useRef<(e: KeyboardEvent) => void>(() => undefined)
  teclas.current = (e) => {
    const t = e.target as HTMLElement | null
    if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // Con un diálogo abierto (p. ej. Inscribir) las teclas son del diálogo
    if (document.querySelector('[role=dialog]')) return
    if (e.code === 'Space') {
      e.preventDefault()
      void alternar()
    } else if (e.key === 'ArrowRight' && panel !== 'presentacion') irSiguiente()
    else if (e.key === 'ArrowLeft' && panel !== 'presentacion') anterior()
    else if (e.key === 'ArrowRight' && diapositivas) setDiapo((d) => Math.min(slides.length - 1, d + 1))
    else if (e.key === 'ArrowLeft' && diapositivas) setDiapo((d) => Math.max(0, d - 1))
    else if (e.key === 'Escape' && pantallaCompleta) togglePantalla()
  }
  useEffect(() => {
    const k = (e: KeyboardEvent): void => teclas.current(e)
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const terminar = async (): Promise<void> => {
    if (!sesion) return
    if (!confirm('¿Terminar la sesión? Se marcará como terminada.')) return
    await api.sesiones.estado(sesion.id, 'terminada')
    useClase.getState().terminar()
    nav('/')
  }
  const togglePantalla = (): void => {
    const v = !pantallaCompleta
    setPantallaCompleta(v)
    api.sistema.pantallaCompleta(v)
  }

  function leerParticipaciones(sesionId: number): void {
    api.participaciones.porSesion(sesionId).then((l) => setParticipaciones(Object.fromEntries(l.map((x) => [x.alumno_id, x.n])))).catch(() => undefined)
  }
  const participar = async (al: Alumno, mas: boolean): Promise<void> => {
    if (!sesion) return
    if (mas) await api.participaciones.agregar(sesion.materia_id, al.id, sesion.id, sesion.fecha)
    else await api.participaciones.quitar(sesion.materia_id, al.id, sesion.id)
    leerParticipaciones(sesion.id)
  }
  // Tras pasar lista se recalcula quién quedó en alerta o rebasó por faltas
  const releerAlertas = (): void => {
    if (sesion) setTimeout(() => api.faltas.alertas(sesion.materia_id).then(setAlertas).catch(() => undefined), 400)
  }
  const marcar = async (al: Alumno, estado: EstadoAsistencia): Promise<void> => {
    if (!sesion) return
    const previo = asistencia.find((x) => x.alumno_id === al.id)
    // Mismo estado: no se toca, así se conservan la hora en que llegó y la nota
    if (previo?.estado === estado) return
    await api.asistencia.marcar(sesion.id, al.id, estado, previo?.nota ?? '')
    setAsistencia(await api.asistencia.porSesion(sesion.id))
    releerAlertas()
  }
  // Solo a quienes aún no tienen registro: no pisa retardos, justificados ni notas
  const marcarTodos = async (estado: EstadoAsistencia): Promise<void> => {
    if (!sesion || !materia) return
    // Con el filtro de carrera puesto, solo a los de esa carrera
    const grupo = materia.alumnos.filter((al) => carreraF === null || al.carrera_id === carreraF)
    const faltan = grupo.filter((al) => !asistencia.some((x) => x.alumno_id === al.id)).map((al) => al.id)
    if (faltan.length === 0) return avisar('Todos ya tienen registro. Cambia a cada quien con P, R, A o J.')
    await api.asistencia.marcarTodos(sesion.id, faltan, estado)
    setAsistencia(await api.asistencia.porSesion(sesion.id))
    releerAlertas()
    const yaTenian = grupo.length - faltan.length
    avisar(`${faltan.length} ${estado === 'presente' ? 'presentes' : 'ausentes'}${yaTenian ? ` · ${yaTenian === 1 ? '1 ya tenía registro y no se tocó' : `${yaTenian} ya tenían registro y no se tocaron`}` : ''}`)
  }
  // Sugerencia de retardo: si ya pasó la tolerancia desde la hora de inicio de la sesión
  const sugerido: EstadoAsistencia = sesion && ahora.fecha === sesion.fecha && ahora.minutos > aMinutos(sesion.hora_inicio) + tolerancia ? 'retardo' : 'presente'

  const inscritos = useMemo(() => materia?.alumnos.map((al) => al.id) ?? [], [materia])
  const presentaciones = useMemo(() => materia?.evaluaciones.filter((e) => e.tipo === 'presentacion') ?? [], [materia])
  // La presentación de la sesión manda sobre la de la materia
  const rutaPresentacion = sesion?.presentacion_path || materia?.presentacion_path
  const presentacionEsDeLaSesion = !!sesion?.presentacion_path
  // navpanes=0 oculta el panel de miniaturas y view=FitH ajusta la diapositiva al ancho: al proyectar se quiere la lámina grande
  const urlPdf = presEstado.pdf ? `${window.api.url(`materiales/${encodeURIComponent(presEstado.pdf.split('/').pop() ?? '')}`)}#navpanes=0&view=FitH` : null
  const nombreArchivo = (r: string): string => decodeURIComponent(r.split('/').pop() ?? '').replace(/^\d+-[a-z0-9]{4}-/, '').replace(/^\d+-/, '')

  const convertir = async (): Promise<void> => {
    if (!rutaPresentacion) return
    setConvirtiendo(true)
    try {
      await api.presentacion.convertir(rutaPresentacion)
      setPresEstado(await api.presentacion.estado(rutaPresentacion))
      avisar('Presentación lista para proyectar')
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setConvirtiendo(false)
    }
  }

  if (!sesion) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-4 sm:px-8">
        <div className="arrastre absolute top-0 left-0 right-0 h-12" />
        <div className="text-5xl">⏱</div>
        <h1 className="text-2xl font-bold">No hay ninguna clase cargada</h1>
        <p className="text-ink-500 max-w-md">Elige una sesión desde <Link to="/" className="text-brand-500 underline">Hoy</Link> o desde el plan de una materia y pulsa “Modo clase”.</p>
        <Link to="/" className="btn-primario">Ir a Hoy</Link>
      </div>
    )
  }

  const s = sesion
  const pres = panel === 'presentacion'
  const color = s.materia_color ?? '#2d6df6'
  // Con filtro de carrera, los conteos son de esa carrera
  const delFiltro = (alumnoId: number): boolean => carreraF === null || materia?.alumnos.find((al) => al.id === alumnoId)?.carrera_id === carreraF
  const hayRegistros = asistencia.some((a) => delFiltro(a.alumno_id))
  const conteo = (e: EstadoAsistencia): number => asistencia.filter((a) => a.estado === e && delFiltro(a.alumno_id)).length

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Barra superior: se acomoda en varias filas si no cabe */}
      <header className="arrastre flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-3 pb-2 border-b border-ink-100" style={{ paddingLeft: pantallaCompleta ? 24 : 'calc(90px / var(--zoom, 1))' }}>
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="font-semibold truncate">{s.materia_nombre} <span className="text-ink-400 font-normal">· {materia?.carrera_nombre}</span></div>
          <div className="text-xs text-ink-500 truncate">Sesión {s.numero} · Semana {s.semana} · {s.hora_inicio}–{s.hora_fin} · {s.tema || 'sin tema'}</div>
        </div>
        <div className="no-arrastre ml-auto flex flex-wrap items-center justify-end gap-2">
          <nav className="flex flex-wrap items-center gap-1 bg-ink-100 rounded-lg p-1">
            {(['actividades', 'asistencia', 'presentacion', 'material'] as Panel[]).map((p) => (
              <button key={p} onClick={() => setPanel(p)} aria-pressed={panel === p} className={`px-3 py-1 rounded-md text-sm capitalize ${panel === p ? 'bg-white shadow-sm font-medium' : 'text-ink-600'}`}>
                {p === 'asistencia' ? `Asistencia ${asistencia.length}/${materia?.alumnos.length ?? 0}` : p === 'presentacion' ? 'Presentación' : p}
              </button>
            ))}
          </nav>
          <button className="btn-secundario" onClick={togglePantalla} title="Pantalla completa" aria-label="Pantalla completa">⛶</button>
          <button className="btn-fantasma" onClick={() => nav('/')}>Salir</button>
          <button className="btn-peligro" onClick={terminar}>Terminar</button>
        </div>
      </header>

      {/* Reloj y panel lado a lado si caben; si no, uno debajo del otro con desplazamiento (ver .clase-* en index.css) */}
      <div ref={refCuerpo} className="clase-cuerpo flex-1 min-h-0">
        <div className="clase-columnas">
          {/* Columna del reloj */}
          <section className={`clase-reloj ${pres ? 'estrecha' : ''}`}>
            {actual ? (
              <>
                <div className="text-center max-w-full">
                  <div className="etiqueta" style={{ color }}>{ICONO[actual.tipo]} {actual.tipo} · actividad {indice + 1} de {acts.length}</div>
                  <h2 className={`font-bold text-ink-900 mt-1 break-words ${pres ? 'text-2xl' : 'text-4xl'}`}>{actual.nombre}</h2>
                  {actual.descripcion && !pres && <p className="clase-si-alto text-ink-500 mt-2 max-w-xl">{actual.descripcion}</p>}
                </div>
                <div className={`reloj-caja ${pres ? 'chica' : ''}`}>
                  <RelojClase total={actual.duracion_min * 60} color={color} grande={!pres} />
                </div>
                <div className="flex flex-wrap justify-center items-center gap-2">
                  <button className="btn-secundario" onClick={anterior} disabled={indice === 0}>‹ Anterior</button>
                  <button className={`btn text-white text-base px-6 py-2.5 ${corriendo ? 'bg-amber-500 hover:bg-amber-600' : 'bg-brand-500 hover:bg-brand-600'}`} onClick={corriendo ? pausar : iniciar}>
                    {corriendo ? '❚❚ Pausar' : '▶ Iniciar'}
                  </button>
                  <button className="btn-secundario" onClick={irSiguiente} disabled={!siguiente}>Siguiente ›</button>
                </div>
                <div className="flex flex-wrap justify-center items-center gap-1.5 text-sm">
                  <button className="btn-fantasma" onClick={() => ajustar(-60)}>−1 min</button>
                  <button className="btn-fantasma" onClick={() => ajustar(60)}>+1 min</button>
                  <button className="btn-fantasma" onClick={() => ajustar(300)}>+5 min</button>
                  <button className="btn-fantasma" onClick={reiniciarActividad}>↺ Reiniciar</button>
                </div>
                {siguiente && !pres && (
                  <div className="clase-si-alto rounded-xl border border-dashed border-ink-200 px-5 py-3 text-center max-w-full">
                    <div className="etiqueta">Después</div>
                    <div className="font-medium break-words">{ICONO[siguiente.tipo]} {siguiente.nombre} · {siguiente.duracion_min} min</div>
                  </div>
                )}
                <ProgresoSesion color={color} />
                <div className="clase-si-alto text-xs text-ink-400 text-center">Espacio: iniciar/pausar · ← →: cambiar actividad</div>
              </>
            ) : (
              <div className="text-ink-500 text-center">Esta sesión no tiene actividades. Agrégalas desde el plan de la materia.</div>
            )}
          </section>

          {/* Panel lateral */}
          <aside className={`clase-panel ${pres ? 'ancho' : ''} ${panel !== 'actividades' ? 'primero' : ''}`}>
            {panel === 'actividades' && (
              <div className="p-5">
                <div className="etiqueta mb-2">Plan de la sesión</div>
                <ol className="space-y-1.5">
                  {acts.map((a, i) => {
                    const hecha = i < indice
                    const esActual = i === indice
                    return (
                      <li key={a.id}>
                        <button onClick={() => irA(i)} className={`w-full text-left rounded-lg px-3 py-2 border transition ${esActual ? 'border-brand-400 bg-brand-500/5' : hecha ? 'border-transparent opacity-50' : 'border-ink-100 hover:bg-ink-50'}`}>
                          <div className="flex items-center gap-2">
                            <span className="w-5 text-center">{hecha ? '✓' : ICONO[a.tipo]}</span>
                            <span className={`flex-1 min-w-0 break-words ${esActual ? 'font-semibold' : ''}`}>{a.nombre}</span>
                            <span className="font-mono text-sm text-ink-500">{a.duracion_min}′</span>
                          </div>
                          {a.descripcion && esActual && <div className="text-xs text-ink-500 mt-1 pl-7">{a.descripcion}</div>}
                        </button>
                      </li>
                    )
                  })}
                </ol>
                {s.objetivo && (
                  <div className="mt-5">
                    <div className="etiqueta mb-1">Objetivo</div>
                    <p className="text-sm text-ink-700">{s.objetivo}</p>
                  </div>
                )}
                <Link to={`/materias/${s.materia_id}?sesion=${s.id}`} className="btn-secundario mt-5 w-full justify-center">Editar plan de la sesión</Link>
              </div>
            )}

            {panel === 'asistencia' && materia && (
              <div className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="etiqueta">Pase de lista</div>
                  <div className="flex flex-wrap gap-1">
                    <button className="btn-fantasma text-xs" onClick={() => setInscribiendo(true)} title="Agregar alumnos registrados a esta materia">+ Inscribir</button>
                    <button className="btn-secundario text-xs" onClick={() => marcarTodos('presente')} title="Solo a quienes aún no tienen registro">{hayRegistros ? 'Resto presentes' : 'Todos presentes'}</button>
                    <button className="btn-secundario text-xs" onClick={() => marcarTodos('ausente')} title="Solo a quienes aún no tienen registro">{hayRegistros ? 'Resto ausentes' : 'Todos ausentes'}</button>
                  </div>
                  <InscribirAlumnos
                    abierto={inscribiendo}
                    materiaId={materia.id}
                    materiaNombre={materia.nombre}
                    carreraId={materia.carrera_id}
                    inscritos={inscritos}
                    onCerrar={() => setInscribiendo(false)}
                    onListo={() => api.materias.obtener(materia.id).then(setMateria)}
                  />
                </div>
                {(() => {
                  const enGrupo = carreras.filter((c) => materia.alumnos.some((al) => al.carrera_id === c.id))
                  const delGrupo = materia.alumnos.filter((al) => carreraF === null || al.carrera_id === carreraF)
                  const sinRegistro = delGrupo.filter((al) => !asistencia.some((x) => x.alumno_id === al.id)).length
                  if (materia.alumnos.length === 0) return null
                  return (
                    <div className="mb-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Buscador valor={buscarAlumno} onCambio={setBuscarAlumno} placeholder="Buscar alumno" etiqueta="Buscar alumno en el pase de lista" />
                        <ChipFiltro activo={soloSinRegistro} onClick={() => setSoloSinRegistro(!soloSinRegistro)} conteo={sinRegistro} titulo="Ver solo a quienes aún no tienen registro en esta clase">
                          Sin registro
                        </ChipFiltro>
                      </div>
                      {enGrupo.length > 1 && (
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Carrera">
                          <ChipFiltro activo={carreraF === null} onClick={() => setCarreraF(null)} conteo={materia.alumnos.length}>Todas</ChipFiltro>
                          {enGrupo.map((c) => (
                            <ChipFiltro key={c.id} activo={carreraF === c.id} color={c.color} titulo={c.nombre} onClick={() => setCarreraF(carreraF === c.id ? null : c.id)} conteo={materia.alumnos.filter((al) => al.carrera_id === c.id).length}>
                              {c.clave}
                            </ChipFiltro>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })()}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500 mb-3">
                  {ESTADOS.map((e) => (
                    <span key={e.v} className="flex items-center gap-1 whitespace-nowrap" title={e.n}>
                      <span className={`inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-bold ${e.c}`} aria-hidden>{e.t}</span>
                      <span className="font-medium text-ink-700">{conteo(e.v)}</span>
                      <span className="sr-only">{e.n}</span>
                    </span>
                  ))}
                  {sugerido === 'retardo' && <span className="ml-auto text-amber-600">Ya pasó la tolerancia ({tolerancia} min): clic en el nombre marca retardo</span>}
                </div>
                <ul className="divide-y divide-ink-100">
                  {(() => {
                    const mixta = new Set(materia.alumnos.map((x) => x.carrera_id)).size > 1
                    const visibles = materia.alumnos.filter(
                      (al) => (carreraF === null || al.carrera_id === carreraF) && coincide(buscarAlumno, al.apellidos, al.nombre, al.matricula) && (!soloSinRegistro || !asistencia.some((x) => x.alumno_id === al.id))
                    )
                    if (materia.alumnos.length > 0 && visibles.length === 0)
                      return (
                        <li>
                          {soloSinRegistro && !buscarAlumno.trim() ? (
                            <div className="px-5 py-8 text-center text-sm text-green-700">Todos ya tienen registro en esta clase.</div>
                          ) : (
                            <SinResultados
                              hayFiltro
                              onLimpiar={() => {
                                setBuscarAlumno('')
                                setSoloSinRegistro(false)
                              }}
                              vacio={null}
                            />
                          )}
                        </li>
                      )
                    return visibles.map((al) => {
                    const a = asistencia.find((x) => x.alumno_id === al.id)
                    const car = carreras.find((c) => c.id === al.carrera_id)
                    const nombre = `${al.apellidos} ${al.nombre}`.trim()
                    const alerta = alertas.find((x) => x.alumno_id === al.id)
                    const nPart = participaciones[al.id] ?? 0
                    return (
                      <li key={al.id} className="flex items-center gap-2 py-2">
                        {/* El clic rápido solo marca a quien no tiene registro: no reescribe la hora ni borra la nota */}
                        <button className={`flex-1 text-left min-w-0 rounded-md ${a ? 'cursor-default' : 'hover:bg-ink-50'}`} onClick={() => !a && marcar(al, sugerido)} title={a ? 'Ya tiene registro: cámbialo con P, R, A o J' : `Clic rápido: marca ${sugerido}`}>
                          {/* Nombre completo siempre visible: apellidos y nombres en líneas separadas, sin recortar */}
                          <div className="font-medium leading-tight break-words">
                            {al.apellidos}
                            {mixta && car && <span className="ml-1.5 rounded px-1.5 py-0.5 align-middle text-[10px] font-bold" style={{ color: car.color, backgroundColor: `${car.color}18` }} title={car.nombre}>{car.clave}</span>}
                          </div>
                          <div className="text-sm text-ink-700 leading-tight break-words">{al.nombre}</div>
                          <div className="text-xs text-ink-400 break-words">{al.matricula}{a?.hora ? ` · ${a.hora}` : ''}{a?.nota ? ` · ${a.nota}` : ''}</div>
                          {alerta && <div className={`mt-0.5 inline-block chip ${COLOR_NIVEL_FALTAS[alerta.nivel]}`} title={alerta.texto}>⚠ {ETIQUETA_NIVEL_FALTAS[alerta.nivel]} · {alerta.horas_falta} h</div>}
                        </button>
                        <div className="flex items-center shrink-0" role="group" aria-label={`Participaciones de ${nombre}`}>
                          {nPart > 0 && <button onClick={() => participar(al, false)} aria-label={`Quitar participación: ${nombre}`} title="Quitar una participación" className="w-6 h-8 rounded-l-md text-xs bg-ink-100 text-ink-500 hover:bg-ink-200">−</button>}
                          <button onClick={() => participar(al, true)} aria-label={`Participación: ${nombre}`} title="Anotar una participación (presentación, examen oral, pregunta…)" className={`h-8 px-1.5 text-xs font-bold ${nPart > 0 ? 'rounded-r-md bg-violet-500 text-white' : 'rounded-md bg-ink-100 text-ink-500 hover:bg-ink-200'}`}>{nPart > 0 ? `✋${nPart}` : '✋+1'}</button>
                        </div>
                        <div className="flex gap-1 shrink-0" role="group" aria-label={`Asistencia de ${nombre}`}>
                          {ESTADOS.map((e) => (
                            <button key={e.v} onClick={() => marcar(al, e.v)} aria-label={`${e.n}: ${nombre}`} aria-pressed={a?.estado === e.v} title={e.n} className={`w-8 h-8 rounded-md text-xs font-bold ${a?.estado === e.v ? e.c : 'bg-ink-100 text-ink-500 hover:bg-ink-200'}`}>{e.t}</button>
                          ))}
                        </div>
                      </li>
                    )
                    })
                  })()}
                  {materia.alumnos.length === 0 && (
                    <li className="text-ink-500 text-sm py-4">
                      No hay alumnos inscritos en esta materia. Los alumnos registrados en la app no aparecen en el pase de lista hasta inscribirlos aquí.
                      <button className="btn-primario text-xs mt-2 block" onClick={() => setInscribiendo(true)}>Inscribir alumnos</button>
                    </li>
                  )}
                </ul>
              </div>
            )}

            {panel === 'presentacion' && materia && (
              <div className="h-full flex flex-col">
                <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-ink-100 text-sm">
                  <span className="etiqueta">Presentación</span>
                  {rutaPresentacion && (
                    <>
                      <span className="text-xs text-ink-500 truncate min-w-0 max-w-[260px]" title={rutaPresentacion}>
                        {presentacionEsDeLaSesion ? 'de esta sesión' : 'de la materia'}: {nombreArchivo(rutaPresentacion)}
                      </span>
                      <button className="btn-secundario text-xs" onClick={() => api.materiales.abrir(rutaPresentacion)}>Abrir en su app</button>
                    </>
                  )}
                  {presentaciones.length > 0 && (
                    <select className="input w-auto text-xs" value={diapositivas?.id ?? ''} onChange={(e) => { const ev = presentaciones.find((p) => p.id === Number(e.target.value)) ?? null; setDiapositivas(ev); setDiapo(0) }}>
                      <option value="">Diapositivas generadas con IA…</option>
                      {presentaciones.map((p) => <option key={p.id} value={p.id}>{p.titulo}</option>)}
                    </select>
                  )}
                  {diapositivas && (
                    <div className="ml-auto flex items-center gap-1">
                      <button className="btn-secundario text-xs" onClick={() => setDiapo((d) => Math.max(0, d - 1))} disabled={diapo === 0}>‹</button>
                      <span className="text-xs text-ink-500">{Math.min(diapo + 1, slides.length)} / {slides.length}</span>
                      <button className="btn-secundario text-xs" onClick={() => setDiapo((d) => Math.min(slides.length - 1, d + 1))} disabled={diapo >= slides.length - 1}>›</button>
                      <button className="btn-fantasma text-xs" onClick={() => setDiapositivas(null)}>✕</button>
                    </div>
                  )}
                </div>
                <div className="flex-1 min-h-0 bg-ink-900">
                  {diapositivas ? (
                    <div className="h-full flex flex-col">
                      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center p-10 text-white">
                        <div className="diapositiva max-w-5xl w-full prosa !text-white max-h-full">
                          <Markdown texto={slides[Math.min(diapo, slides.length - 1)]?.lamina ?? ''} className="!text-white [&_*]:!text-white" />
                        </div>
                      </div>
                      {slides[Math.min(diapo, slides.length - 1)]?.notas && (
                        <div className="shrink-0 border-t border-ink-700 bg-ink-800 px-6 py-3 text-ink-100 text-sm max-h-[30%] overflow-y-auto">
                          <button className="text-xs uppercase tracking-wide text-ink-400 hover:text-ink-200" onClick={() => setVerNotas((v) => !v)}>
                            {verNotas ? '▾' : '▸'} Notas para ti · ocúltalas si proyectas esta ventana
                          </button>
                          {verNotas && <Markdown texto={slides[Math.min(diapo, slides.length - 1)]!.notas} className="mt-1 !text-ink-100 [&_*]:!text-ink-100" />}
                        </div>
                      )}
                    </div>
                  ) : urlPdf ? (
                    <iframe title="Presentación" src={urlPdf} className="w-full h-full border-0 bg-white" />
                  ) : presEstado.convertible && rutaPresentacion ? (
                    <div className="h-full flex flex-col items-center justify-center text-ink-300 gap-3 text-center px-4 sm:px-8">
                      <div className="text-4xl">▣</div>
                      <p className="text-white font-medium">{nombreArchivo(rutaPresentacion)}</p>
                      <p className="max-w-md text-sm">PowerPoint no se puede proyectar dentro de la app. Se convierte una sola vez a PDF y a partir de ahí se ve aquí mismo.</p>
                      <div className="flex gap-2">
                        <button className="btn-primario" disabled={convirtiendo} onClick={convertir}>{convirtiendo ? 'Convirtiendo…' : 'Preparar para proyectar'}</button>
                        <button className="btn-secundario" onClick={() => api.materiales.abrir(rutaPresentacion)}>Abrir en PowerPoint</button>
                      </div>
                      <p className="text-xs max-w-md">Si no tienes LibreOffice, la conversión abre Keynote unos segundos y toma el foco. Conviene hacerlo antes de la clase, desde la pestaña Materiales de la materia.</p>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-ink-300 gap-3 text-center px-4 sm:px-8">
                      <div className="text-4xl">▣</div>
                      <p>Esta materia no tiene presentación asignada.</p>
                      <p className="text-sm">Asígnala a esta sesión desde el plan de la materia, o marca una para toda la materia en la pestaña Materiales. Los PDF se ven aquí mismo; PowerPoint y Keynote se abren en su app.</p>
                      <p className="text-sm">También puedes generar diapositivas con IA en Estudio IA.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {abierto && <VisorMaterial material={abierto} onCerrar={() => setAbierto(null)} />}
            {panel === 'material' && materia && (
              <div className="p-5 space-y-4">
                <div>
                  <div className="etiqueta mb-2">Materiales de la materia</div>
                  <ul className="space-y-1">
                    {materia.materiales.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-sm">
                        <span className="chip bg-ink-100 text-ink-600 uppercase">{m.tipo}</span>
                        <span className="flex-1 truncate">{m.titulo}</span>
                        <button className="btn-fantasma text-xs" onClick={() => setAbierto({ id: m.id, titulo: m.titulo, ruta: m.ruta })}>Abrir</button>
                      </li>
                    ))}
                    {materia.materiales.length === 0 && <li className="text-ink-500 text-sm">Sin materiales.</li>}
                  </ul>
                </div>
                {(() => {
                  // Las presentaciones se ven arriba: el mensaje de vacío revisa la lista ya sin ellas
                  const ejercicios = materia.evaluaciones.filter((e) => e.tipo !== 'presentacion')
                  return (
                    <div>
                      <div className="etiqueta mb-2">Ejercicios, exámenes y tareas</div>
                      <ul className="space-y-1">
                        {ejercicios.map((e) => (
                          <li key={e.id} className="flex items-center gap-2 text-sm">
                            <span className="chip bg-violet-100 text-violet-700">{e.tipo.replace('_', ' ')}</span>
                            <Link to={`/evaluacion/${e.id}`} className="flex-1 truncate hover:underline">{e.titulo}</Link>
                          </li>
                        ))}
                        {ejercicios.length === 0 && <li className="text-ink-500 text-sm">Aún no generas ejercicios ni exámenes. Ve a Estudio IA.</li>}
                      </ul>
                    </div>
                  )
                })()}
                <div>
                  <div className="etiqueta mb-2">Glosario</div>
                  <ul className="space-y-1.5 text-sm">
                    {materia.glosario.slice(0, 12).map((g) => (
                      <li key={g.id}><b>{g.termino}:</b> <span className="text-ink-600">{g.definicion}</span></li>
                    ))}
                  </ul>
                </div>
                {/* Un solo enlace con estilo de botón: antes era un botón con un enlace adentro y casi nunca navegaba */}
                <Link to={`/ia/${materia.id}`} className="btn-secundario w-full justify-center">
                  ✦ Generar examen sorpresa / ejercicio ahora
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}

/** Reloj que escucha el segundero por su cuenta: así el resto de la pantalla no se repinta cada segundo. */
function RelojClase({ total, color, grande }: { total: number; color: string; grande: boolean }): JSX.Element {
  const restante = useClase((e) => e.restante)
  return <Reloj restante={restante} total={total} color={color} grande={grande} />
}

function ProgresoSesion({ color }: { color: string }): JSX.Element {
  const acts = useClase((e) => e.sesion?.actividades) ?? []
  const indice = useClase((e) => e.indice)
  const restante = useClase((e) => e.restante)
  const actual = acts[indice]
  const totalSeg = acts.reduce((s, a) => s + a.duracion_min * 60, 0)
  const transcurrido = acts.slice(0, indice).reduce((s, a) => s + a.duracion_min * 60, 0) + (actual ? actual.duracion_min * 60 - restante : 0)
  return (
    <div className="w-full max-w-md">
      <div className="flex justify-between text-xs text-ink-400 mb-1"><span>Sesión</span><span>{fmtMinSeg(transcurrido)} / {fmtMinSeg(totalSeg)}</span></div>
      <div className="h-1.5 rounded bg-ink-100 overflow-hidden"><div className="h-full" style={{ width: `${totalSeg ? Math.min(100, Math.max(0, (transcurrido / totalSeg) * 100)) : 0}%`, background: color }} /></div>
    </div>
  )
}
