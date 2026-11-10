import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import { avisar } from '../components/Aviso'
import { GuiaClassroom, PermisoEscritura } from '../components/ClassroomAjustes'
import { Buscador, ChipFiltro, Conteo, EncabezadoOrden, Segmentado, SinResultados, coincide, ordenNatural, sinAcentos, type Orden } from '../components/Filtros'
import { useRecordado } from '../lib/recordado'
import type { ArchivoRevisado, HallazgoMetadatos, InformeCopias, RevisionIA, SenalCopia } from '@shared/copias'
import { cortoDesdeCompleto } from '@shared/copias'
import type { Materia } from '@shared/types'
import {
  ETIQUETA_ESTADO, type Adjunto, type ArchivoAdjuntado, type AlumnoResumen, type CeldaApp, type CeldaEntrega, type Consolidacion, type CursoClassroom, type DetalleEntrega, type EstadoConexion, type EstadoEntrega,
  type FuenteEntrega, type ResumenClassroom, type SinLigarClassroom, type TareaApp, type TareaResumen, type Vista
} from '@shared/classroom'

// ---------- Utilidades de presentación ----------

const ZONA = 'America/Mexico_City'
const fechaHora = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: ZONA }).format(new Date(iso)) : '—'
const fecha = (iso: string | null): string => (iso ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: ZONA }).format(new Date(iso)) : '')
/** Fecha guardada en la base (UTC, «AAAA-MM-DD HH:MM:SS») o ISO, en hora de México */
const fechaGuardada = (t: string): string => fechaHora(/T/.test(t) ? t : `${t.replace(' ', 'T')}Z`)

/**
 * Lo último que se revisó con esa clave (metadatos, copias, IA): se carga al abrir y se guarda cada vez que se
 * revisa, para no perderlo al salir de la pantalla. Viaja a la versión web con la sincronización.
 */
function useRevisionGuardada<T>(clave: string | null): [{ datos: T; guardado: string } | null, (d: T) => void] {
  const [g, setG] = useState<{ datos: T; guardado: string } | null>(null)
  useEffect(() => {
    setG(null)
    if (!clave) return
    let vivo = true
    api.classroom
      .revisionGuardada<T>(clave)
      .then((x) => vivo && setG(x))
      .catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [clave])
  const guardar = useCallback(
    (d: T) => {
      if (!clave) return
      setG({ datos: d, guardado: new Date().toISOString() })
      void api.classroom.guardarRevision(clave, d).catch(() => undefined)
    },
    [clave]
  )
  return [g, guardar]
}

const tamano = (n: number | null): string => (n === null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const ESTILO: Record<EstadoEntrega, { i: string; c: string; corto: string }> = {
  entrego: { i: '✓', c: 'bg-green-50 text-green-800 border-green-200', corto: 'Entregó' },
  tarde: { i: '◷', c: 'bg-amber-50 text-amber-800 border-amber-300', corto: 'Tarde' },
  no_entrego: { i: '✗', c: 'bg-red-50 text-red-700 border-red-200', corto: 'No entregó' },
  pendiente: { i: '○', c: 'bg-ink-50 text-ink-500 border-ink-200', corto: 'Pendiente' },
  retirada: { i: '↺', c: 'bg-purple-50 text-purple-700 border-purple-200', corto: 'La retiró' },
  no_asignada: { i: '—', c: 'bg-white text-ink-300 border-ink-100', corto: 'No asignada' }
}

function Estado({ e, grande = false }: { e: EstadoEntrega; grande?: boolean }): JSX.Element {
  const s = ESTILO[e]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${grande ? 'text-sm' : 'text-xs'} ${s.c}`}>
      <span aria-hidden>{s.i}</span>
      {ETIQUETA_ESTADO[e]}
    </span>
  )
}

function textoCalif(c: { calificacion: number | null; borrador: number | null; puntos: number | null }): { t: string; borrador: boolean } | null {
  const sobre = c.puntos ? `/${c.puntos}` : ''
  if (c.calificacion !== null) return { t: `${c.calificacion}${sobre}`, borrador: false }
  if (c.borrador !== null) return { t: `${c.borrador}${sobre}`, borrador: true }
  return null
}

function Calif({ c }: { c: { calificacion: number | null; borrador: number | null; puntos: number | null } }): JSX.Element | null {
  const t = textoCalif(c)
  if (!t) return null
  return <span className={t.borrador ? 'italic text-ink-500' : 'font-semibold text-ink-800'}>{t.t}{t.borrador ? ' borrador' : ''}</span>
}

/** Pestaña con subrayado (como en la ficha de la materia); el número es lo que espera atención. */
const Pestana = ({ activa, onClick, children, conteo, titulo }: { activa: boolean; onClick: () => void; children: ReactNode; conteo?: number; titulo?: string }): JSX.Element => (
  <button
    role="tab"
    aria-selected={activa}
    onClick={onClick}
    title={titulo}
    className={`-mb-px inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm ${activa ? 'border-brand-500 font-medium text-brand-600' : 'border-transparent text-ink-500 hover:text-ink-800'}`}
  >
    {children}
    {!!conteo && <span className={`ml-1.5 rounded-full px-1.5 text-[11px] font-semibold ${activa ? 'bg-brand-500/10 text-brand-600' : 'bg-ink-100 text-ink-600'}`}>{conteo}</span>}
  </button>
)

/** El contenido va con zoom (80–180 %): sin compensar, el modal se sale de la ventana al ampliar. */
export const ALTO_MODAL = '!max-h-[calc(88vh/var(--zoom,1))]'

type Abierta = { tipo: 'app'; celda: CeldaApp } | { tipo: 'cruda'; celda: CeldaEntrega }
type PestanaId = 'revisar' | 'tabla' | 'agrupar' | 'sinligar'

// ---------- Pantalla ----------

export default function Classroom(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const [conexion, setConexion] = useState<EstadoConexion | null>(null)
  const [cursos, setCursos] = useState<CursoClassroom[]>([])
  const [materias, setMaterias] = useState<Materia[]>([])
  const [r, setR] = useState<ResumenClassroom | null>(null)
  const [pestana, setPestana] = useState<PestanaId>(() => (localStorage.getItem('docente.classroom.pestana') as PestanaId) || 'revisar')
  const [sincronizando, setSincronizando] = useState(false)
  const [abierta, setAbierta] = useState<Abierta | null>(null)
  const [verGuia, setVerGuia] = useState(false)
  // Tareas creadas desde la app: formulario (nueva o editar) y calificación en bloque
  const [formTarea, setFormTarea] = useState<{ tarea: TareaResumen | null } | null>(null)
  const [calificando, setCalificando] = useState<TareaResumen | null>(null)
  const [ajustandoPortal, setAjustandoPortal] = useState<TareaResumen | null>(null)
  const materiaParam = Number(params.get('materia')) || null

  const cargar = useCallback(async () => {
    const [e, c, m] = await Promise.all([api.classroom.estado(), api.classroom.cursos(), api.materias.listar()])
    setConexion(e)
    setCursos(c)
    setMaterias(m)
  }, [])
  useEffect(() => { cargar().catch((e) => avisar((e as Error).message, 'error')) }, [cargar])

  const ligadas = useMemo(() => {
    const ids = [...new Set(cursos.filter((c) => c.materia_id).map((c) => c.materia_id!))]
    return materias.filter((m) => ids.includes(m.id))
  }, [cursos, materias])
  const materiaId = materiaParam && ligadas.some((m) => m.id === materiaParam) ? materiaParam : ligadas[0]?.id ?? null
  const elegirMateria = (id: number): void => setParams({ materia: String(id) }, { replace: true })

  const cargarResumen = useCallback(async () => {
    if (!materiaId) return setR(null)
    setR(await api.classroom.resumen(materiaId))
  }, [materiaId])
  useEffect(() => { cargarResumen().catch((e) => avisar((e as Error).message, 'error')) }, [cargarResumen])
  const refrescar = async (): Promise<void> => {
    await cargar()
    await cargarResumen()
  }
  /** Ejecuta un cambio y recarga, mostrando el error si falla. */
  const cambiar = async (f: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await f()
      await refrescar()
      if (ok) avisar(ok)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const elegirPestana = (p: PestanaId): void => {
    setPestana(p)
    try { localStorage.setItem('docente.classroom.pestana', p) } catch { /* sin almacenamiento */ }
  }

  const sincronizar = async (): Promise<void> => {
    setSincronizando(true)
    try {
      const x = await api.classroom.sincronizar()
      await refrescar()
      avisar(x.ligados ? `Sincronizado: ${x.tareas} tareas y ${x.entregas} entregas de ${x.ligados} curso(s)` : `Se encontraron ${x.cursos} curso(s). Liga cada uno a su materia y vuelve a sincronizar.`)
    } catch (e) {
      avisar((e as Error).message, 'error')
      setConexion(await api.classroom.estado().catch(() => conexion))
    } finally {
      setSincronizando(false)
    }
  }

  if (!conexion) return <div className="p-8 text-ink-500">Cargando…</div>
  const sinLigarN = r ? r.sin_ligar.classroom.filter((x) => x.sugerido).length : 0
  const revisarN = r ? r.consolidado.por_revisar.ambiguas.length + r.consolidado.por_revisar.sin_calificar.length : 0
  const sugerN = r ? r.consolidado.sugerencias.grupos.length + r.consolidado.sugerencias.comodines.length : 0
  const cursosSinLigar = cursos.filter((c) => c.activo && !c.materia_id).length

  return (
    <div>
      <Encabezado
        titulo="Google Classroom"
        sub={
          <>
            {conexion.conectado ? <>Conectado como {conexion.cuenta}</> : <span className="text-amber-700">Sin conectar</span>}
            {' · '}Última sincronización: {conexion.ultima_sync ? fechaHora(conexion.ultima_sync) : 'nunca'}
            {conexion.conectado && (conexion.escritura ? ' · puedes crear y calificar tareas' : ' · solo lectura')}
          </>
        }
        acciones={
          <>
            <button className="btn-fantasma" onClick={() => setVerGuia(true)}>Guía</button>
            {materiaId && <button className="btn-secundario" onClick={() => cambiar(() => api.classroom.exportarExcel(materiaId))}>Exportar Excel</button>}
            {r && (conexion.conectado || r.cursos.some((c) => c.id.startsWith('app-'))) && (
              <button
                className="btn-secundario"
                onClick={() =>
                  conexion.escritura || r.cursos.some((c) => c.id.startsWith('app-'))
                    ? setFormTarea({ tarea: null })
                    : avisar(window.api.plataforma === 'web' ? 'Falta el permiso para crear tareas: dalo desde la app de tu Mac con «Dar permisos que faltan» (arriba de esta página o en Ajustes › Google Classroom).' : 'Falta el permiso para crear tareas: pulsa «Dar permisos que faltan» arriba de esta página.', 'error')
                }
              >
                + Nueva tarea
              </button>
            )}
            <button className="btn-primario" disabled={!conexion.conectado || sincronizando} onClick={sincronizar}>{sincronizando ? 'Sincronizando…' : 'Sincronizar ahora'}</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-5 space-y-5 max-w-full">
        <PermisoEscritura estado={conexion} onCambio={setConexion} />
        {!conexion.conectado && (
          <section className="tarjeta p-5 text-sm space-y-2">
            <p className="text-ink-700">Para sincronizar, conecta la cuenta {conexion.cuenta_esperada} en Ajustes. Lo ya sincronizado se puede seguir consultando.</p>
            <div className="flex flex-wrap gap-2">
              <Link to="/ajustes" className="btn-primario">Ir a Ajustes › Google Classroom</Link>
              <button className="btn-secundario" onClick={() => setVerGuia(true)}>Cómo configurarlo</button>
            </div>
          </section>
        )}

        <CursosLigar cursos={cursos} materias={materias} abierto={cursosSinLigar > 0 || ligadas.length === 0} onLigar={(c, m) => cambiar(() => api.classroom.ligarCurso(c, m), m ? 'Curso ligado. Sincroniza para traer sus tareas.' : 'Curso desligado')} />

        {/* Materias que no usan Classroom: sus tareas viven solo en la app (con el portal de alumnos) */}
        {(() => {
          const sinCurso = materias.filter((m) => !m.oculta && !cursos.some((c) => c.materia_id === m.id))
          if (!sinCurso.length) return null
          return (
            <details className="tarjeta p-4 text-sm">
              <summary className="cursor-pointer font-semibold">Materias sin Classroom ({sinCurso.length}): usar tareas solo en la app</summary>
              <p className="mt-2 text-ink-600">Creas, calificas y devuelves las tareas aquí; los alumnos las ven y entregan en la pestaña «Tareas» del portal. Nada de esto va a Google.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sinCurso.map((m) => (
                  <button
                    key={m.id}
                    className="btn-secundario"
                    onClick={() => cambiar(async () => { await api.classroom.activarTareasApp(m.id); elegirMateria(m.id) }, `Tareas de la app activadas en ${m.nombre}`)}
                  >
                    Activar en {m.nombre}
                  </button>
                ))}
              </div>
            </details>
          )
        })()}

        {materiaParam && !ligadas.some((m) => m.id === materiaParam) && (
          <p className="text-sm text-amber-700">Esa materia aún no tiene un curso de Classroom ligado. Lígalo arriba y sincroniza.</p>
        )}

        {ligadas.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="etiqueta mr-1">Materia</span>
            {ligadas.map((m) => (
              <button key={m.id} onClick={() => elegirMateria(m.id)} className={`chip border text-sm px-3 py-1 ${m.id === materiaId ? 'bg-ink-800 text-white border-ink-800' : 'bg-white border-ink-200 text-ink-700 hover:bg-ink-100'}`}>
                {m.nombre}
              </button>
            ))}
          </div>
        )}

        {r && (
          <>
            <nav role="tablist" aria-label="Vistas de Classroom" className="flex flex-wrap gap-x-1 border-b border-ink-200">
              <Pestana activa={pestana === 'revisar'} onClick={() => elegirPestana('revisar')} conteo={revisarN} titulo="Recuperaciones por decidir y entregas sin calificar">Por revisar</Pestana>
              <Pestana activa={pestana === 'tabla'} onClick={() => elegirPestana('tabla')}>Alumnos × tareas</Pestana>
              <Pestana activa={pestana === 'agrupar'} onClick={() => elegirPestana('agrupar')} conteo={sugerN} titulo={sugerN ? `${sugerN} sugerencia(s) para agrupar` : undefined}>Agrupar tareas</Pestana>
              <Pestana activa={pestana === 'sinligar'} onClick={() => elegirPestana('sinligar')} conteo={sinLigarN} titulo={sinLigarN ? `${sinLigarN} alumno(s) por confirmar` : undefined}>Sin ligar</Pestana>
            </nav>
            {!r.tareas.length && (pestana === 'revisar' || pestana === 'tabla') && (
              <div className="tarjeta px-5 py-8 text-center">
                <div className="font-medium text-ink-800">Todavía no hay tareas en esta materia</div>
                <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">
                  {r.cursos.every((c) => c.id.startsWith('app-'))
                    ? 'Crea la primera con «+ Nueva tarea»: los alumnos la verán y la entregarán en el portal.'
                    : 'Pulsa «Sincronizar ahora» para traerlas de Classroom, o crea una con «+ Nueva tarea».'}
                </p>
              </div>
            )}
            {pestana === 'revisar' && r.tareas.length > 0 && <PorRevisar r={r} onAbrir={setAbierta} onIr={elegirPestana} onDecidir={(clave, user, d) => cambiar(() => api.classroom.decidirComodin(clave, user, d), 'Decisión guardada')} />}
            {pestana === 'tabla' && (
              <Tabla
                r={r}
                onAbrir={setAbierta}
                onIr={elegirPestana}
                propias={{
                  editar: (t) => setFormTarea({ tarea: t }),
                  calificar: setCalificando,
                  portal: setAjustandoPortal,
                  borrar: (t) => {
                    if (window.confirm(`¿Eliminar «${t.titulo}» de Classroom? Se borran también las entregas y calificaciones de los alumnos. No se puede deshacer.`)) {
                      void cambiar(() => api.classroom.borrarTarea(t.curso_id, t.id), 'Tarea eliminada de Classroom')
                    }
                  }
                }}
              />
            )}
            {pestana === 'agrupar' && materiaId && <Agrupar r={r} materiaId={materiaId} cambiar={cambiar} />}
            {pestana === 'sinligar' && <SinLigar r={r} cambiar={cambiar} />}
          </>
        )}
      </div>
      {abierta && r && <DetalleCelda abierta={abierta} r={r} onCerrar={() => setAbierta(null)} cambiar={cambiar} />}
      {formTarea && r && (
        <Modal titulo={formTarea.tarea ? `Editar «${formTarea.tarea.titulo}»` : 'Nueva tarea'} abierto onCerrar={() => setFormTarea(null)} ancho="max-w-2xl">
          <FormTarea r={r} tarea={formTarea.tarea} onListo={async (ok) => { setFormTarea(null); await refrescar(); avisar(ok) }} />
        </Modal>
      )}
      {ajustandoPortal && r && (
        <Modal titulo={`«${ajustandoPortal.titulo}» en el portal`} abierto onCerrar={() => setAjustandoPortal(null)} ancho="max-w-xl">
          <AjustePortal r={r} tarea={ajustandoPortal} onListo={async () => { setAjustandoPortal(null); await refrescar(); avisar('Guardado: los alumnos lo verán así en el portal') }} />
        </Modal>
      )}
      {calificando && r && (
        <Modal titulo={`Calificar «${calificando.titulo}»`} abierto onCerrar={() => setCalificando(null)} ancho="max-w-3xl">
          <CalificarTarea r={r} tarea={calificando} onListo={async (ok) => { setCalificando(null); await refrescar(); avisar(calificando.curso_id.startsWith('app-') ? ok.replace(' en Classroom', '') : ok) }} />
        </Modal>
      )}
      <GuiaClassroom abierta={verGuia} onCerrar={() => setVerGuia(false)} />
    </div>
  )
}

// ---------- Ligar cursos a materias ----------

function CursosLigar({ cursos, materias, abierto, onLigar }: { cursos: CursoClassroom[]; materias: Materia[]; abierto: boolean; onLigar: (curso: string, materia: number | null) => void }): JSX.Element {
  if (!cursos.length) {
    return <section className="tarjeta p-5 text-sm text-ink-600">Aún no hay cursos. Pulsa «Sincronizar ahora» para traer tus clases activas de Classroom.</section>
  }
  return (
    <details className="tarjeta" open={abierto}>
      <summary className="cursor-pointer px-5 py-3 font-semibold">Cursos de Classroom ({cursos.filter((c) => c.activo).length})</summary>
      <ul className="divide-y divide-ink-100 border-t border-ink-100">
        {cursos.map((c) => (
          <li key={c.id} className="px-5 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-0 flex-[1_1_14rem]">
              <div className="font-medium break-words">{c.nombre}{c.seccion ? <span className="text-ink-500 font-normal"> · {c.seccion}</span> : null}</div>
              <div className="text-xs text-ink-500">
                {c.activo ? (c.materia_id ? `${c.alumnos} alumnos · ${c.tareas} tareas` : 'Sin ligar: no se sincroniza') : 'Ya no está activo en Classroom'}
                {c.enlace && <> · <button className="underline" onClick={() => api.classroom.abrirEnlace(c.enlace)}>abrir en Classroom</button></>}
              </div>
            </div>
            <select className="input w-auto max-w-full flex-[0_1_18rem]" value={c.materia_id ?? ''} onChange={(e) => onLigar(c.id, e.target.value ? Number(e.target.value) : null)} aria-label={`Materia de ${c.nombre}`}>
              <option value="">— No ligar —</option>
              {materias.map((m) => <option key={m.id} value={m.id}>{m.nombre}{m.oculta ? ' (oculta)' : ''}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </details>
  )
}

// ---------- Por revisar ----------

function PorRevisar({ r, onAbrir, onIr, onDecidir }: { r: ResumenClassroom; onAbrir: (a: Abierta) => void; onIr: (p: PestanaId) => void; onDecidir: (clave: string, user: string, d: number | 'ninguna' | 'auto') => void }): JSX.Element {
  const c = r.consolidado
  const pr = c.por_revisar
  // La búsqueda se recuerda al abrir una entrega y volver, o al cambiar de pestaña
  const [busca, setBusca] = useRecordado('classroom.revisar.busqueda', '')
  const nombreTarea = (k: string | null): string => c.tareas.find((t) => t.clave === k)?.nombre ?? '—'
  const celda = (alumno: string, tarea: string): CeldaApp | undefined => c.celdas.find((x) => x.alumno === alumno && x.tarea_app === tarea)
  const ambiguas = pr.ambiguas.filter((a) => coincide(busca, a.nombre, a.titulo, nombreTarea(a.acreditada)))
  const sinCalificar = pr.sin_calificar.filter((x) => coincide(busca, x.nombre, x.tarea_nombre, x.fuente.titulo))
  const sinEntregaPorTarea = c.tareas
    .map((t) => ({ t, alumnos: pr.sin_entrega.filter((x) => x.tarea_app === t.clave && coincide(busca, x.nombre, x.tarea_nombre)) }))
    .filter((x) => x.alumnos.length)
  const sinEntregaN = sinEntregaPorTarea.reduce((n, x) => n + x.alumnos.length, 0)
  const total = pr.ambiguas.length + pr.sin_calificar.length + pr.sin_entrega.length
  const visibles = ambiguas.length + sinCalificar.length + sinEntregaN
  const hayFiltro = !!busca.trim()
  const sug = c.sugerencias.grupos.length + c.sugerencias.comodines.length
  const porConfirmar = r.sin_ligar.classroom.filter((x) => x.sugerido).length
  /** Encabezado de cada bloque: título, cuántos hay (con filtro: «3 de 12») y una línea de ayuda opcional. */
  const titulo = (texto: string, n: number, de: number, ayuda?: string): JSX.Element => (
    <div className="px-5 pt-4 pb-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 font-semibold text-ink-800">
        {texto}
        <span className="text-sm font-normal text-ink-500">{hayFiltro && n !== de ? `${n} de ${de}` : de}</span>
      </h3>
      {ayuda && <p className="mt-0.5 text-xs text-ink-500">{ayuda}</p>}
    </div>
  )
  const vacio = (texto: string): JSX.Element => <p className="px-5 pb-4 text-sm text-ink-500">{hayFiltro ? `Nada coincide con «${busca.trim()}».` : texto}</p>
  return (
    <div className="space-y-4">
      {(sug > 0 || porConfirmar > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-brand-400/30 bg-brand-500/5 px-4 py-2.5 text-sm text-ink-700">
          {sug > 0 && (
            <span>
              {sug === 1 ? 'Hay 1 sugerencia' : `Hay ${sug} sugerencias`} para agrupar tareas duplicadas.{' '}
              <button className="font-medium text-brand-600 hover:underline" onClick={() => onIr('agrupar')}>Revisarlas</button>
            </span>
          )}
          {porConfirmar > 0 && (
            <span>
              {porConfirmar === 1 ? '1 alumno de Classroom parece' : `${porConfirmar} alumnos de Classroom parecen`} ser de tu lista.{' '}
              <button className="font-medium text-brand-600 hover:underline" onClick={() => onIr('sinligar')}>Confirmarlos</button>
            </span>
          )}
        </div>
      )}

      {/* Solo aparece cuando hay algo que buscar */}
      {total > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filtrar lo que está por revisar">
          <Buscador valor={busca} onCambio={setBusca} placeholder="Buscar por alumno o tarea" etiqueta="Buscar en lo que está por revisar" />
          {hayFiltro && <button className="btn-fantasma text-xs" onClick={() => setBusca('')}>Quitar filtro</button>}
          <Conteo visibles={visibles} total={total} nombre={total === 1 ? 'pendiente' : 'pendientes'} hayFiltro={hayFiltro} />
        </div>
      )}

      <section className="tarjeta">
        {titulo('Recuperaciones por decidir', ambiguas.length, pr.ambiguas.length)}
        {ambiguas.length === 0 ? vacio('Nada que decidir.') : (
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {ambiguas.map((a) => (
              <li key={`${a.comodin}|${a.user_id}`} className="space-y-2 px-5 py-3">
                <p className="text-sm text-ink-700"><b className="text-ink-900">{a.nombre}</b> entregó «{a.titulo}» y le faltan varias. Por ahora se acreditó a <b className="text-ink-900">{nombreTarea(a.acreditada)}</b>. ¿A cuál va?</p>
                <div className="flex flex-wrap gap-2">
                  {a.opciones.map((o) => (
                    <button key={o} className={o === a.acreditada ? 'btn-primario' : 'btn-secundario'} onClick={() => onDecidir(a.comodin, a.user_id, Number(o.replace('app:', '')))}>{nombreTarea(o)}</button>
                  ))}
                  <button className="btn-fantasma" onClick={() => onDecidir(a.comodin, a.user_id, 'ninguna')}>No acreditar</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="tarjeta">
        {titulo('Entregas sin calificar', sinCalificar.length, pr.sin_calificar.length, 'Solo la entrega que cuenta: si un alumno subió la misma tarea dos veces, aparece una sola vez. Clic para abrirla y calificar.')}
        {sinCalificar.length === 0 ? vacio('Todo lo entregado ya tiene calificación.') : (
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {sinCalificar.map((x) => {
              const cel = celda(x.alumno, x.tarea_app)
              return (
                <li key={`${x.alumno}|${x.tarea_app}`}>
                  <button className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-left hover:bg-ink-50 focus:bg-ink-50 focus:outline-none" onClick={() => cel && onAbrir({ tipo: 'app', celda: cel })}>
                    <span className="min-w-0 flex-[1_1_12rem]">
                      <span className="block break-words font-medium text-ink-900">{x.nombre}</span>
                      <span className="block break-words text-xs text-ink-500">{x.tarea_nombre}</span>
                    </span>
                    <span className="min-w-0 flex-[1_1_14rem] break-words text-xs text-ink-500">
                      en «{x.fuente.titulo}»{x.fuente.comodin ? ' (recuperación)' : ''} · {fechaHora(x.fuente.entregada)}
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {x.fuente.tarde && <Estado e="tarde" />}
                      {cel && cel.veces > 1 && <span className="chip bg-ink-100 text-ink-700">entregó {cel.veces} veces</span>}
                      {x.fuente.adjuntos > 0 && <span className="text-xs text-ink-500" title={`${x.fuente.adjuntos} archivo(s) adjunto(s)`}>📎 {x.fuente.adjuntos}</span>}
                      <span className="text-xs font-medium text-brand-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100" aria-hidden>Abrir ›</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="tarjeta">
        {titulo('Sin entrega en tareas vencidas', sinEntregaN, pr.sin_entrega.length)}
        {sinEntregaPorTarea.length === 0 ? vacio('Nadie debe tareas vencidas.') : (
          <div className="divide-y divide-ink-100 border-t border-ink-100">
            {sinEntregaPorTarea.map(({ t, alumnos }) => (
              <div key={t.clave} className="px-5 py-3">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="break-words font-medium text-ink-900">{t.nombre}</span>
                  <span className="text-xs text-ink-500">{alumnos.length} sin entregar</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {alumnos.map((a) => {
                    const cel = celda(a.alumno, a.tarea_app)
                    return <button key={a.alumno} className="chip border border-red-200 bg-red-50 text-red-700 hover:bg-red-100" onClick={() => cel && onAbrir({ tipo: 'app', celda: cel })}>{a.nombre}</button>
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ---------- Tabla alumnos × tareas ----------

interface AccionesPropias {
  editar: (t: TareaResumen) => void
  borrar: (t: TareaResumen) => void
  calificar: (t: TareaResumen) => void
  /** Para quién es en el portal y si acepta tarde (cualquier tarea, no solo las creadas en la app) */
  portal: (t: TareaResumen) => void
}

type FiltroAlumnos = 'todos' | 'deben' | 'corriente'
type FiltroFecha = 'todas' | 'por_vencer' | 'vencidas' | 'sin_fecha'
type MarcaTarea = 'por_calificar' | 'propias' | 'portal'
type CampoAlumno = 'nombre' | 'entregas' | 'promedio'
type TotalesAlumno = AlumnoResumen['totales']

/** Una columna de la tabla, ya sea una tarea de la app (agrupa duplicados) o una de Classroom tal cual. */
interface Columna {
  clave: string
  nombre: string
  claves: string[]
  /** Las tareas de Classroom que la forman */
  tareas: TareaResumen[]
  tot: TareaApp['totales']
  /** La fecha límite más antigua de sus tareas (null = sin fecha) */
  vence: string | null
  /** Sin fecha: desde cuándo cuenta como no entregada (solo en «Como están en Classroom») */
  cuentaDesde: string | null
  /** Tarea de Classroom que todavía no se agrupa (solo en «Tareas de la app») */
  suelta: boolean
  /** Alguna de sus tareas se creó desde la app */
  propia: boolean
  /** Alguna de sus tareas se ve en el portal (para todos o para algunos) */
  enPortal: boolean
  /** Entregas que cuentan y aún no tienen calificación */
  porCalificar: number
}

const TRES_DIAS = 3 * 24 * 3600_000
const fechaDeColumna = (col: Columna, ahora: number): Exclude<FiltroFecha, 'todas'> => (!col.vence ? 'sin_fecha' : Date.parse(col.vence) < ahora ? 'vencidas' : 'por_vencer')
/** Promedio de lo ya calificado (0–100), o null si aún no hay nada calificado con puntos. */
const promedioDe = (t: TotalesAlumno | undefined): number | null => (t && t.puntos_posibles > 0 ? (t.puntos_obtenidos / t.puntos_posibles) * 100 : null)

function Tabla({ r, onAbrir, onIr, propias }: { r: ResumenClassroom; onAbrir: (a: Abierta) => void; onIr: (p: PestanaId) => void; propias: AccionesPropias }): JSX.Element | null {
  // Vista y filtros se recuerdan: al abrir una entrega, calificar o ir a otra pantalla y volver siguen igual
  const [modo, setModo] = useRecordado<'app' | 'classroom'>('classroom.tabla.modo', 'app')
  const [buscaA, setBuscaA] = useRecordado('classroom.tabla.alumno', '')
  const [estadoA, setEstadoA] = useRecordado<FiltroAlumnos>('classroom.tabla.estado', 'todos')
  const [buscaT, setBuscaT] = useRecordado('classroom.tabla.tarea', '')
  const [fechaT, setFechaT] = useRecordado<FiltroFecha>('classroom.tabla.fecha', 'todas')
  const [marcas, setMarcas] = useRecordado<MarcaTarea[]>('classroom.tabla.marcas', [])
  const [orden, setOrden] = useRecordado<Orden<CampoAlumno>>('classroom.tabla.orden', { campo: 'nombre', dir: 1 })
  const c = r.consolidado
  const ahora = Date.now()

  const columnas = useMemo((): Columna[] => {
    const porClave = new Map(r.tareas.map((t) => [t.clave, t]))
    if (modo === 'app') {
      const sinCalificar = new Map<string, number>()
      for (const x of c.por_revisar.sin_calificar) sinCalificar.set(x.tarea_app, (sinCalificar.get(x.tarea_app) ?? 0) + 1)
      return c.tareas.map((t) => {
        const tareas = t.tareas.map((k) => porClave.get(k)).filter((x): x is TareaResumen => !!x)
        const fechas = tareas.map((x) => x.vence).filter((x): x is string => !!x).sort()
        return {
          clave: t.clave, nombre: t.nombre, claves: t.tareas, tareas, tot: t.totales, vence: fechas[0] ?? null, cuentaDesde: null, suelta: t.id === null,
          propia: tareas.some((x) => x.propia), enPortal: tareas.some((x) => x.portal.visibilidad !== 'oculta'), porCalificar: sinCalificar.get(t.clave) ?? 0
        }
      })
    }
    const sinCalificar = new Map<string, number>()
    for (const e of r.entregas) if ((e.estado === 'entrego' || e.estado === 'tarde') && e.calificacion === null) sinCalificar.set(e.tarea, (sinCalificar.get(e.tarea) ?? 0) + 1)
    return r.tareas.map((t) => ({
      clave: t.clave, nombre: t.titulo, claves: [t.clave], tareas: [t], tot: t.totales, vence: t.vence,
      cuentaDesde: !t.vence && t.creada ? new Date(Date.parse(t.creada) + 7 * 24 * 3600_000).toISOString() : null,
      suelta: false, propia: t.propia, enPortal: t.portal.visibilidad !== 'oculta', porCalificar: sinCalificar.get(t.clave) ?? 0
    }))
  }, [modo, r.tareas, r.entregas, c.tareas, c.por_revisar.sin_calificar])
  const hayGrupos = c.tareas.some((t) => t.id !== null)

  const celdasApp = useMemo(() => new Map(c.celdas.map((x) => [`${x.alumno}|${x.tarea_app}`, x])), [c.celdas])
  const celdasCr = useMemo(() => new Map(r.entregas.map((x) => [`${x.alumno}|${x.tarea}`, x])), [r.entregas])
  const tareaPorClave = useMemo(() => new Map(r.tareas.map((t) => [t.clave, t])), [r.tareas])
  const totalesDe = (clave: string): TotalesAlumno | undefined => (modo === 'app' ? c.totales[clave] : r.alumnos.find((a) => a.clave === clave)?.totales)

  // Cada filtro por separado, para contar cuántos quedan en cada opción con los demás puestos
  const pasaA = {
    busqueda: (a: AlumnoResumen) => coincide(buscaA, a.nombre, a.matricula, a.email),
    estado: (a: AlumnoResumen) => {
      const debe = (totalesDe(a.clave)?.no_entrego ?? 0) > 0
      return estadoA === 'todos' || (estadoA === 'deben' ? debe : !debe)
    }
  }
  const pasaT: Record<'busqueda' | 'fecha' | MarcaTarea, (col: Columna) => boolean> = {
    busqueda: (col) => coincide(buscaT, col.nombre, ...col.tareas.map((t) => t.titulo)),
    fecha: (col) => fechaT === 'todas' || fechaDeColumna(col, ahora) === fechaT,
    por_calificar: (col) => !marcas.includes('por_calificar') || col.porCalificar > 0,
    propias: (col) => !marcas.includes('propias') || col.propia,
    portal: (col) => !marcas.includes('portal') || col.enPortal
  }
  const alumnosSalvo = (k: keyof typeof pasaA): AlumnoResumen[] => r.alumnos.filter((a) => (Object.keys(pasaA) as (keyof typeof pasaA)[]).every((x) => x === k || pasaA[x](a)))
  const columnasSalvo = (k: keyof typeof pasaT): Columna[] => columnas.filter((col) => (Object.keys(pasaT) as (keyof typeof pasaT)[]).every((x) => x === k || pasaT[x](col)))

  const filas = r.alumnos
    .filter((a) => Object.values(pasaA).every((f) => f(a)))
    .sort((a, b) => {
      if (orden.campo === 'nombre') return orden.dir * ordenNatural(a.nombre, b.nombre)
      const valor = (x: AlumnoResumen): number | null => {
        const t = totalesDe(x.clave)
        return orden.campo === 'promedio' ? promedioDe(t) : t && t.asignadas ? t.entregadas / t.asignadas : null
      }
      const va = valor(a)
      const vb = valor(b)
      // Sin dato (sin tareas asignadas o sin nada calificado) siempre al final, ordene como ordene
      if (va === null || vb === null) return va === vb ? ordenNatural(a.nombre, b.nombre) : va === null ? 1 : -1
      return orden.dir * (va - vb) || ordenNatural(a.nombre, b.nombre)
    })
  const cols = columnas.filter((col) => Object.values(pasaT).every((f) => f(col)))

  const filtroAlumnos = !!buscaA.trim() || estadoA !== 'todos'
  const filtroTareas = !!buscaT.trim() || fechaT !== 'todas' || marcas.length > 0
  const hayFiltro = filtroAlumnos || filtroTareas
  const quitarFiltros = (): void => {
    setBuscaA('')
    setEstadoA('todos')
    setBuscaT('')
    setFechaT('todas')
    setMarcas([])
  }
  const alternarMarca = (m: MarcaTarea): void => setMarcas(marcas.includes(m) ? marcas.filter((x) => x !== m) : [...marcas, m])
  const paraEstado = alumnosSalvo('estado')
  const paraFecha = columnasSalvo('fecha')
  const debe = (a: AlumnoResumen): boolean => (totalesDe(a.clave)?.no_entrego ?? 0) > 0

  // Revisión de copias por metadatos: baja los archivos de la tarea, los lee y los compara entre alumnos
  // Lo ya revisado se muestra al instante (queda guardado); «Revisar otra vez» vuelve a leer los archivos
  const [copias, setCopias] = useState<CopiasAbiertas | null>(null)
  const revisar = async (nombre: string, claves: string[], deNuevo = false): Promise<void> => {
    const clave = claveCopias(claves)
    setCopias({ nombre, claves, informe: null, error: '', guardado: null })
    if (!deNuevo) {
      const g = await api.classroom.revisionGuardada<InformeCopias>(clave).catch(() => null)
      if (g) return setCopias((c) => (c && c.nombre === nombre ? { ...c, informe: g.datos, guardado: g.guardado } : c))
    }
    try {
      const informe = await api.classroom.revisarCopias(claves)
      void api.classroom.guardarRevision(clave, informe).catch(() => undefined)
      setCopias((c) => (c && c.nombre === nombre ? { ...c, informe, guardado: new Date().toISOString() } : c))
    } catch (e) {
      setCopias((c) => (c && c.nombre === nombre ? { ...c, error: (e as Error).message } : c))
    }
  }
  const descargar = async (claves: string[]): Promise<void> => {
    try {
      const x = await api.classroom.descargarTarea(claves)
      if (x) avisar(`${x.archivos} archivo(s) guardados${x.enlaces ? ` · ${x.enlaces} enlace(s) no se descargan` : ''}${x.errores.length ? ` · ${x.errores.length} con error` : ''}`, x.errores.length ? 'error' : 'ok')
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  // Sin tareas no hay tabla: arriba ya se explica cómo traerlas o crearlas
  if (!columnas.length) return null

  return (
    <div className="space-y-3">
      <Modal titulo={copias ? `Revisión de copias · ${copias.nombre}` : ''} abierto={!!copias} onCerrar={() => setCopias(null)} ancho="max-w-5xl">
        {copias && <VistaCopias c={copias} onOtraVez={() => void revisar(copias.nombre, copias.claves, true)} />}
      </Modal>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmentado
          etiqueta="Qué columnas mostrar"
          valor={modo}
          onCambio={setModo}
          opciones={[
            { valor: 'app', texto: 'Tareas de la app' },
            { valor: 'classroom', texto: 'Como están en Classroom' }
          ]}
        />
        <div className="flex flex-wrap gap-1.5" title="Qué significa cada color">
          {(['entrego', 'tarde', 'no_entrego', 'pendiente', 'retirada'] as EstadoEntrega[]).map((e) => <Estado key={e} e={e} />)}
        </div>
      </div>

      {/* Filtros: solo cambian qué se ve; los totales de cada alumno siguen contando todas sus tareas */}
      <div className="tarjeta space-y-2.5 p-3" role="search" aria-label="Filtrar la tabla">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Alumnos">
          <span className="etiqueta w-16 shrink-0">Alumnos</span>
          <Buscador valor={buscaA} onCambio={setBuscaA} placeholder="Nombre, matrícula o correo" etiqueta="Buscar alumno" />
          <Segmentado
            etiqueta="Entregas del alumno"
            valor={estadoA}
            onCambio={setEstadoA}
            opciones={([['todos', 'Todos'], ['deben', 'Deben tareas'], ['corriente', 'Al corriente']] as [FiltroAlumnos, string][]).map(([k, t]) => ({
              valor: k,
              texto: t,
              conteo: paraEstado.filter((a) => (k === 'todos' ? true : k === 'deben' ? debe(a) : !debe(a))).length
            }))}
          />
          <Conteo visibles={filas.length} total={r.alumnos.length} nombre="alumnos" hayFiltro={filtroAlumnos} />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2.5" role="group" aria-label="Tareas">
          <span className="etiqueta w-16 shrink-0">Tareas</span>
          <Buscador valor={buscaT} onCambio={setBuscaT} placeholder="Nombre de la tarea" etiqueta="Buscar tarea" />
          <Segmentado
            etiqueta="Fecha de entrega"
            valor={fechaT}
            onCambio={setFechaT}
            opciones={([['todas', 'Todas'], ['por_vencer', 'Por vencer'], ['vencidas', 'Vencidas'], ['sin_fecha', 'Sin fecha']] as [FiltroFecha, string][]).map(([k, t]) => ({
              valor: k,
              texto: t,
              conteo: k === 'todas' ? paraFecha.length : paraFecha.filter((col) => fechaDeColumna(col, ahora) === k).length
            }))}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ['por_calificar', 'Por calificar', (col: Columna) => col.porCalificar > 0, 'Tienen entregas que aún no calificas'],
                ['propias', 'Creadas desde aquí', (col: Columna) => col.propia, 'Las creaste desde la app: se editan y califican aquí'],
                ['portal', 'Visibles en el portal', (col: Columna) => col.enPortal, 'Los alumnos (todos o algunos) las ven en «Tareas» del portal']
              ] as [MarcaTarea, string, (col: Columna) => boolean, string][]
            ).map(([m, texto, cumple, titulo]) => (
              <ChipFiltro key={m} activo={marcas.includes(m)} onClick={() => alternarMarca(m)} titulo={titulo} conteo={columnasSalvo(m).filter(cumple).length}>
                {texto}
              </ChipFiltro>
            ))}
          </div>
          <Conteo visibles={cols.length} total={columnas.length} nombre="tareas" hayFiltro={filtroTareas} />
        </div>
        {hayFiltro && (
          <div className="flex justify-end border-t border-ink-100 pt-2">
            <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>
          </div>
        )}
      </div>

      <p className="text-xs text-ink-500">
        {modo === 'app' && <>Cada columna junta las tareas duplicadas de Classroom; «×2» = la entregó dos veces (cuenta una), «R» = llegó por una recuperación. </>}
        Clic en una celda para ver la entrega. El promedio es sobre lo ya calificado. En el pie de cada columna, al pasar el mouse, puedes descargar las entregas o revisar copias.
      </p>

      {filas.length === 0 || cols.length === 0 ? (
        <div className="tarjeta">
          <SinResultados
            hayFiltro={hayFiltro}
            onLimpiar={quitarFiltros}
            vacio={
              <>
                <div className="font-medium text-ink-700">Todavía no hay alumnos ligados a Classroom</div>
                <p className="mx-auto mt-1 max-w-md">Solo cuentan los alumnos de tu lista. Liga a los de Classroom con su nombre en tu lista para verlos aquí.</p>
                <button className="btn-secundario mt-3" onClick={() => onIr('sinligar')}>Ir a «Sin ligar»</button>
              </>
            }
          />
        </div>
      ) : (
        // Desplazamiento propio en ambos sentidos: encabezados y nombres quedan fijos y la página no se desborda
        <div className="tarjeta max-h-[calc(72vh/var(--zoom,1))] overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead className="text-left text-xs text-ink-500">
              <tr>
                <EncabezadoOrden campo="nombre" orden={orden} onOrden={setOrden} className="sticky left-0 top-0 z-[4] min-w-[11rem] max-w-[15rem] border-b border-r border-ink-200 bg-ink-50 align-bottom">
                  Alumno
                </EncabezadoOrden>
                {cols.map((col) => (
                  <th
                    key={col.clave}
                    scope="col"
                    className="sticky top-0 z-[3] min-w-[8.5rem] max-w-[11rem] border-b border-ink-200 bg-ink-50 px-2 py-2 align-bottom font-normal"
                    title={col.tareas.length > 1 ? `${col.nombre}\nJunta: ${col.tareas.map((t) => `«${t.titulo}»`).join(', ')}` : col.nombre}
                  >
                    <EncabezadoTarea col={col} ahora={ahora} conSuelta={modo === 'app' && hayGrupos} />
                  </th>
                ))}
                <EncabezadoOrden campo="entregas" orden={orden} onOrden={setOrden} className="sticky top-0 z-[3] whitespace-nowrap border-b border-l border-ink-200 bg-ink-50 align-bottom">
                  Entregas
                </EncabezadoOrden>
                <EncabezadoOrden campo="promedio" orden={orden} onOrden={setOrden} className="sticky top-0 z-[3] whitespace-nowrap border-b border-ink-200 bg-ink-50 text-right align-bottom">
                  Promedio
                </EncabezadoOrden>
              </tr>
            </thead>
            <tbody>
              {filas.map((a) => {
                const tot = totalesDe(a.clave)
                const prom = promedioDe(tot)
                return (
                  <tr key={a.clave} className="group">
                    <th scope="row" className="sticky left-0 z-[1] max-w-[15rem] border-b border-r border-ink-100 bg-white px-3 py-1.5 text-left font-medium group-hover:bg-ink-50">
                      <div className="break-words leading-tight text-ink-900">{a.nombre}</div>
                      {a.matricula && <div className="font-mono text-[11px] font-normal text-ink-400">{a.matricula}</div>}
                    </th>
                    {cols.map((col) => {
                      if (modo === 'app') {
                        const x = celdasApp.get(`${a.clave}|${col.clave}`)
                        if (!x) return <td key={col.clave} className="border-b border-ink-100 px-2 py-1.5 text-ink-300 group-hover:bg-ink-50/60">—</td>
                        return (
                          <td key={col.clave} className="border-b border-ink-100 px-1.5 py-1 group-hover:bg-ink-50/60">
                            <button className={`w-full rounded-md border px-2 py-1 text-left hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 ${ESTILO[x.estado].c} ${x.ambigua ? 'ring-2 ring-amber-400' : ''}`} onClick={() => onAbrir({ tipo: 'app', celda: x })} title={`${ETIQUETA_ESTADO[x.estado]}${x.cuenta ? ` en «${x.cuenta.titulo}»` : ''}`}>
                              <div className="flex items-center gap-1 whitespace-nowrap text-xs font-medium">
                                <span aria-hidden>{ESTILO[x.estado].i}</span>{ESTILO[x.estado].corto}
                                {x.veces > 1 && <span className="ml-auto rounded bg-white/70 px-1 text-[10px]">×{x.veces}</span>}
                                {x.comodin && <span className="rounded bg-white/70 px-1 text-[10px]" title="Por recuperación">R</span>}
                                {x.ambigua && <span className="rounded bg-amber-200 px-1 text-[10px]" title="Decide a cuál acreditar">?</span>}
                              </div>
                              <div className="text-xs"><Calif c={x} /></div>
                            </button>
                          </td>
                        )
                      }
                      const x = celdasCr.get(`${a.clave}|${col.clave}`)
                      if (!x || tareaPorClave.get(col.clave)?.curso_id !== a.curso_id) return <td key={col.clave} className="border-b border-ink-100 px-2 py-1.5 text-ink-300 group-hover:bg-ink-50/60">—</td>
                      return (
                        <td key={col.clave} className="border-b border-ink-100 px-1.5 py-1 group-hover:bg-ink-50/60">
                          <button className={`w-full rounded-md border px-2 py-1 text-left hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 ${ESTILO[x.estado].c}`} onClick={() => onAbrir({ tipo: 'cruda', celda: x })} title={ETIQUETA_ESTADO[x.estado]}>
                            <div className="flex items-center gap-1 whitespace-nowrap text-xs font-medium"><span aria-hidden>{ESTILO[x.estado].i}</span>{ESTILO[x.estado].corto}{x.adjuntos > 0 && <span className="ml-auto text-[10px]">📎{x.adjuntos}</span>}</div>
                            <div className="text-xs"><Calif c={x} /></div>
                          </button>
                        </td>
                      )
                    })}
                    <td className="whitespace-nowrap border-b border-l border-ink-100 px-3 py-1.5 text-xs group-hover:bg-ink-50/60">
                      {tot && (
                        <>
                          <div className="text-ink-600"><b className="text-ink-900">{tot.entregadas}</b> de {tot.asignadas}</div>
                          {tot.no_entrego > 0 && <div className="text-red-700">{tot.no_entrego} sin entregar</div>}
                          {tot.tarde > 0 && <div className="text-amber-700">{tot.tarde} tarde</div>}
                        </>
                      )}
                    </td>
                    <td
                      className="whitespace-nowrap border-b border-ink-100 px-3 py-1.5 text-right tabular-nums group-hover:bg-ink-50/60"
                      title={tot && prom !== null ? `${tot.puntos_obtenidos.toLocaleString('es-MX')} de ${tot.puntos_posibles.toLocaleString('es-MX')} puntos calificados` : 'Aún no tiene nada calificado'}
                    >
                      {prom === null ? <span className="text-ink-300">—</span> : <span className={`font-semibold ${prom < 60 ? 'text-red-700' : 'text-ink-900'}`}>{Math.round(prom)}%</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="sticky left-0 z-[1] border-r border-t border-ink-200 bg-ink-50 px-3 py-2 text-left align-top text-xs font-semibold text-ink-600">Por tarea</th>
                {cols.map((col) => (
                  <td key={col.clave} className="group/pie border-t border-ink-200 bg-ink-50 px-2 py-2 align-top text-xs">
                    <PieTarea col={col} tarea={col.claves.length === 1 ? tareaPorClave.get(col.claves[0]) : undefined} propias={propias} onDescargar={() => descargar(col.claves)} onRevisar={() => revisar(col.nombre, col.claves)} />
                  </td>
                ))}
                <td colSpan={2} className="border-l border-t border-ink-200 bg-ink-50" />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {modo === 'app' && filas.length > 0 && cols.length > 0 && (
        <ResolucionAlumnos filas={filas} detalle={c.resolucion_detalle} columnas={columnas} materiaId={r.materia_id} />
      )}
    </div>
  )
}

const mismoNombre = (a: string, b: string): boolean => sinAcentos(a).replace(/\s+/g, ' ').trim() === sinAcentos(b).replace(/\s+/g, ' ').trim()

/**
 * Cómo se resolvió cada alumno, solo con lo que no fue directo: una tarea que se tomó de otra tarea de Classroom
 * (duplicadas con otro nombre), la que entregó más de una vez y las recuperaciones. Lo directo no se repite.
 */
function ResolucionAlumnos({ filas, detalle, columnas, materiaId }: { filas: AlumnoResumen[]; detalle: Consolidacion['resolucion_detalle']; columnas: Columna[]; materiaId: number }): JSX.Element {
  // De qué tarea de Classroom sale normalmente cada tarea de la app (la que usa la mayoría): eso se dice una vez arriba
  const veces = new Map<string, Map<string, number>>()
  for (const a of filas)
    for (const t of detalle[a.clave]?.tareas ?? []) {
      const m = veces.get(t.tarea) ?? new Map<string, number>()
      m.set(t.en.trim(), (m.get(t.en.trim()) ?? 0) + 1)
      veces.set(t.tarea, m)
    }
  const comun = new Map([...veces].map(([tarea, m]) => [tarea, [...m].sort((x, y) => y[1] - x[1])[0][0]]))
  const fuentes = [...comun].filter(([tarea, en]) => !mismoNombre(tarea, en))
  const conAlgo = filas
    .map((a) => {
      const d = detalle[a.clave] ?? { tareas: [], notas: [] }
      return { a, tareas: d.tareas.filter((t) => !mismoNombre(t.en, comun.get(t.tarea) ?? t.tarea) || t.tambien.length), notas: d.notas }
    })
    .filter((x) => x.tareas.length || x.notas.length)
  const directos = filas.length - conAlgo.length
  return (
    <details className="tarjeta">
      <summary className="cursor-pointer px-5 py-3">
        <span className="font-semibold">Cómo se resolvió cada alumno</span>
        <span className="ml-2 text-sm text-ink-500">
          {conAlgo.length ? `${conAlgo.length} con algo que revisar · ${directos} sin nada raro` : 'todos sin nada raro'}
        </span>
      </summary>
      <div className="space-y-3 border-t border-ink-100 px-5 py-3 text-sm">
        {fuentes.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">De dónde sale cada tarea en Classroom</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {fuentes.map(([tarea, en]) => (
                <span key={tarea} className="chip max-w-full whitespace-normal break-words bg-ink-100 text-ink-700">
                  <b className="font-semibold">{tarea}</b>
                  <span className="ml-1 text-ink-500">← «{en}»</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <MetadatosDeTodas columnas={columnas} filas={filas} materiaId={materiaId} />
        <p className="text-xs text-ink-500">Por alumno solo aparece lo que se sale de eso: la tomó de otra tarea de Classroom, la entregó varias veces (×N) o entregó una recuperación.</p>
        {conAlgo.length === 0 ? (
          <p className="text-emerald-700">Nada fuera de lo normal.</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {conAlgo.map(({ a, tareas, notas }) => (
              <li key={a.clave} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-2.5">
                <span className="min-w-0 flex-[0_1_15rem] break-words font-medium text-ink-900">{a.nombre}</span>
                <div className="flex min-w-0 flex-[1_1_18rem] flex-wrap gap-1.5">
                  {tareas.map((t) => {
                    const otra = !mismoNombre(t.en, comun.get(t.tarea) ?? t.tarea)
                    return (
                      <span
                        key={t.tarea}
                        className={`chip max-w-full whitespace-normal break-words ${otra ? 'bg-sky-50 text-sky-900' : 'bg-ink-100 text-ink-700'}`}
                        title={t.tambien.length ? `También la entregó en ${t.tambien.map((x) => `«${x.trim()}»`).join(', ')}` : undefined}
                      >
                        <b className="font-semibold">{t.tarea}</b>
                        {otra && <span className="ml-1">← «{t.en.trim()}»</span>}
                        {t.tambien.length > 0 && <span className="ml-1 text-ink-500">entregada {t.tambien.length + 1} veces</span>}
                      </span>
                    )
                  })}
                  {notas.map((n, i) => (
                    <span key={i} className="chip max-w-full whitespace-normal break-words bg-amber-50 text-amber-800">{n}</span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

type HallazgoDeTarea = InformeCopias['hallazgos'][number] & { tarea: string }
type LecturaMetadatos = {
  hallazgos: HallazgoDeTarea[]
  cadenas: { tarea: string; cadena: string }[]
  propio: { tarea: string; texto: string }[]
  /** Todo lo que se leyó de cada archivo y las señales, por tarea: para el detalle al hacer clic */
  archivos: (ArchivoRevisado & { tarea: string })[]
  senales: (SenalCopia & { tarea: string })[]
  /** Nombre completo → primer nombre y apellido paterno */
  nombres: Record<string, string>
  errores: string[]
  /** Las tareas que se leyeron (una, varias o todas) */
  leidas: string[]
}
/** Lo que se abre al hacer clic en una etiqueta: un caso (quién tomó de quién) o el trabajo propio de un alumno */
type DetalleAbierto = { tarea: string; alumnos: string[]; hallazgo?: HallazgoMetadatos }

/**
 * Los metadatos de todas las tareas de la materia, como en un resumen de revisión: tarea por tarea se bajan los
 * archivos y se leen (lo mismo que «Revisar copias»), y aquí se juntan por alumno: de quién tomó su archivo, a quién
 * se lo pasó, su trabajo propio y las cadenas de cada tarea. Tarda unos minutos; se ve el avance.
 */
function MetadatosDeTodas({ columnas, filas, materiaId }: { columnas: Columna[]; filas: AlumnoResumen[]; materiaId: number }): JSX.Element {
  const [avance, setAvance] = useState<{ hecho: number; total: number; actual: string } | null>(null)
  // La última lectura queda guardada por materia: al volver se ve sin leer otra vez
  const [guardada, guardar] = useRevisionGuardada<LecturaMetadatos>(`metadatos-todas:${materiaId}`)
  const [nueva, setR] = useState<LecturaMetadatos | null>(null)
  const r = nueva ?? (avance ? null : guardada?.datos ?? null)
  const [detalle, setDetalle] = useState<DetalleAbierto | null>(null)
  // Qué tareas leer: una, varias o todas
  const [elegidas, setElegidas] = useState<Set<string>>(new Set())
  const alternar = (clave: string): void =>
    setElegidas((x) => {
      const n = new Set(x)
      if (n.has(clave)) n.delete(clave)
      else n.add(clave)
      return n
    })
  const leer = async (cuales: Columna[]): Promise<void> => {
    const hallazgos: HallazgoDeTarea[] = []
    const cadenas: { tarea: string; cadena: string }[] = []
    const propio: { tarea: string; texto: string }[] = []
    const archivos: LecturaMetadatos['archivos'] = []
    const senales: LecturaMetadatos['senales'] = []
    const nombres: Record<string, string> = {}
    const errores: string[] = []
    // Una tarea tras otra: Drive no se satura y el avance se ve
    for (const [i, col] of cuales.entries()) {
      setAvance({ hecho: i, total: cuales.length, actual: col.nombre })
      try {
        const inf = await api.classroom.revisarCopias(col.claves)
        hallazgos.push(...inf.hallazgos.map((h) => ({ ...h, tarea: col.nombre })))
        cadenas.push(...inf.cadenas.map((c) => ({ tarea: col.nombre, cadena: c })))
        propio.push(...inf.trabajo_propio.map((t) => ({ tarea: col.nombre, texto: t })))
        archivos.push(...inf.archivos.map((a) => ({ ...a, tarea: col.nombre })))
        senales.push(...inf.senales.map((s) => ({ ...s, tarea: col.nombre })))
        Object.assign(nombres, inf.nombres ?? {})
      } catch (e) {
        // «Nadie ha entregado archivos» no es un error que importe: solo se anota
        const m = (e as Error).message
        if (!/Nadie ha entregado archivos/.test(m)) errores.push(`${col.nombre}: ${m}`)
      }
    }
    setAvance(null)
    const lectura = { hallazgos, cadenas, propio, archivos, senales, nombres, errores, leidas: cuales.map((c) => c.nombre) }
    guardar(lectura)
    setR(lectura)
  }
  /** Primer nombre y apellido paterno («Mateo Ibarra») */
  const corto = (n?: string): string => (n ? r?.nombres[n] ?? cortoDesdeCompleto(n) : '')
  const porAlumno = r
    ? filas
        .map((a) => ({
          a,
          tomo: r.hallazgos.filter((h) => h.copia === a.nombre),
          paso: r.hallazgos.filter((h) => h.original === a.nombre && h.copia),
          junto: r.hallazgos.filter((h) => !h.original && h.alumnos.includes(a.nombre)),
          propio: r.propio.filter((p) => p.texto.startsWith(`${corto(a.nombre)}:`))
        }))
        .filter((x) => x.tomo.length || x.paso.length || x.junto.length || x.propio.length)
    : []
  return (
    <div className="space-y-2 rounded-lg border border-ink-200 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Metadatos de las entregas</div>
          <div className="text-xs text-ink-500">Quién creó cada archivo, quién lo tomó de quién y quién trabajó lo suyo. Elige una o más tareas, o léelas todas.</div>
          {r && guardada && !nueva && <div className="mt-0.5 text-xs text-ink-400">Última lectura: {fechaGuardada(guardada.guardado)} · {r.leidas.length === columnas.length ? 'todas las tareas' : r.leidas.join(', ')}. Vuelve a leer si llegaron entregas nuevas.</div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tareas a revisar">
        {columnas.map((col) => (
          <ChipFiltro key={col.clave} activo={elegidas.has(col.clave)} onClick={() => alternar(col.clave)} titulo={col.nombre}>
            {col.nombre}
          </ChipFiltro>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primario" onClick={() => void leer(columnas.filter((c) => elegidas.has(c.clave)))} disabled={!!avance || !elegidas.size}>
          {elegidas.size ? `Leer ${elegidas.size === 1 ? 'esta tarea' : `estas ${elegidas.size} tareas`}` : 'Elige una o más tareas'}
        </button>
        <button className="btn-secundario" onClick={() => void leer(columnas)} disabled={!!avance || !columnas.length}>
          Leer todas ({columnas.length})
        </button>
        {elegidas.size > 0 && !avance && <button className="btn-fantasma text-xs" onClick={() => setElegidas(new Set())}>Quitar selección</button>}
        {avance && <span className="text-xs font-medium text-ink-600">Leyendo {avance.hecho + 1} de {avance.total}…</span>}
      </div>
      {avance && <p className="text-xs text-ink-500">Bajando y leyendo «{avance.actual}»… cada tarea tarda alrededor de medio minuto.</p>}
      {r && (
        <div className="space-y-3">
          <p className="text-xs text-ink-500">Tareas leídas: {r.leidas.join(' · ')}</p>
          {porAlumno.length === 0 ? (
            <p className="text-emerald-700">Los metadatos no muestran que algún archivo haya salido de otro alumno.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {porAlumno.map(({ a, tomo, paso, junto, propio }) => (
                <li key={a.clave} className="flex flex-wrap items-start gap-x-4 gap-y-1.5 py-2.5">
                  <span className="min-w-0 flex-[0_1_12rem] break-words font-medium text-ink-900" title={a.nombre}>{corto(a.nombre)}</span>
                  <div className="flex min-w-0 flex-[1_1_18rem] flex-wrap gap-1.5">
                    {tomo.map((h, i) => (
                      <button key={`t${i}`} title="Ver todos los metadatos y la cronología" onClick={() => setDetalle({ tarea: h.tarea, alumnos: h.alumnos, hallazgo: h })}
                        className={`chip max-w-full whitespace-normal break-words text-left hover:ring-1 hover:ring-current ${h.fuerza === 'prueba' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-800'}`}>
                        <b className="font-semibold">{h.tarea}</b>
                        <span className="ml-1">tomó el de {corto(h.original)}{h.fuerza === 'prueba' ? ' · prueba directa' : ' · indicio'}</span>
                      </button>
                    ))}
                    {paso.map((h, i) => (
                      <button key={`p${i}`} title="Ver todos los metadatos y la cronología" onClick={() => setDetalle({ tarea: h.tarea, alumnos: h.alumnos, hallazgo: h })}
                        className="chip max-w-full whitespace-normal break-words bg-violet-50 text-left text-violet-800 hover:ring-1 hover:ring-current">
                        <b className="font-semibold">{h.tarea}</b>
                        <span className="ml-1">su archivo pasó a {corto(h.copia)}</span>
                      </button>
                    ))}
                    {junto.map((h, i) => (
                      <button key={`j${i}`} title="Ver todos los metadatos y la cronología" onClick={() => setDetalle({ tarea: h.tarea, alumnos: h.alumnos, hallazgo: h })}
                        className="chip max-w-full whitespace-normal break-words bg-ink-100 text-left text-ink-700 hover:ring-1 hover:ring-current">
                        <b className="font-semibold">{h.tarea}</b>
                        <span className="ml-1">{h.conclusion}</span>
                      </button>
                    ))}
                    {propio.map((p, i) => (
                      <button key={`o${i}`} title="Ver todos los metadatos y la cronología" onClick={() => setDetalle({ tarea: p.tarea, alumnos: [a.nombre] })}
                        className="chip max-w-full whitespace-normal break-words bg-emerald-50 text-left text-emerald-800 hover:ring-1 hover:ring-current">
                        <b className="font-semibold">{p.tarea}</b>
                        <span className="ml-1">trabajo propio ({p.texto.slice(corto(a.nombre).length + 2).replace(/\.$/, '')})</span>
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {r.cadenas.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Cadenas, por la hora de cada archivo</div>
              <ul className="mt-1 space-y-0.5">
                {r.cadenas.map((c, i) => (
                  <li key={i} className="break-words"><b>{c.tarea}:</b> {c.cadena}</li>
                ))}
              </ul>
            </div>
          )}
          {r.hallazgos.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-ink-600">Evidencia caso por caso ({r.hallazgos.length})</summary>
              <ul className="mt-1 space-y-1">
                {r.hallazgos.map((h, i) => (
                  <li key={i} className="break-words text-ink-700">
                    <span className={`mr-1.5 rounded px-1.5 text-xs font-semibold ${h.fuerza === 'prueba' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{h.fuerza === 'prueba' ? 'Prueba directa' : 'Indicio'}</span>
                    <b>{h.tarea} · {h.caso}:</b> {h.evidencia} <b>{h.conclusion}</b>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {r.errores.length > 0 && <p className="text-xs text-red-700">No se pudieron leer: {r.errores.join(' · ')}</p>}
          <p className="text-xs text-ink-400">Haz clic en una etiqueta para ver todos los metadatos de los archivos y su cronología. Son pistas: confírmalas abriendo los archivos.</p>
        </div>
      )}
      {r && detalle && (
        <Modal titulo={`${detalle.tarea} · ${detalle.alumnos.map(corto).join(' y ')}`} abierto onCerrar={() => setDetalle(null)} ancho="max-w-4xl">
          <DetalleMetadatos detalle={detalle} lectura={r} corto={corto} />
        </Modal>
      )}
    </div>
  )
}

/** «2026-10-23T06:23:00Z» → «23 oct 2026, 00:23» (con año: un archivo viejo de otro semestre también es una pista) */
const fechaConAnio = (iso: string): string =>
  new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONA })
    .format(new Date(iso))
    .replace('.', '')

/** Cuánto pasó entre dos momentos: «7 h 35 min», «2 días», «al mismo minuto» */
function lapso(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'al mismo minuto'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `${Math.round(h / 24)} días`
}

/** Los campos de un archivo, con su nombre en español, en el orden en que conviene leerlos (los vacíos no se muestran) */
const CAMPOS: [keyof ArchivoRevisado, string, ((a: ArchivoRevisado) => string)?][] = [
  ['nombre', 'Archivo'],
  ['nombre_original', 'Se subió a Drive como'],
  ['origen', 'Entregado en', (a) => (a.origen === 'portal' ? 'Portal de alumnos' : 'Classroom')],
  ['entregado', 'Entregado', (a) => (a.entregado ? fechaConAnio(a.entregado) : '')],
  ['autor', 'Autor (dentro del archivo)'],
  ['ultimo_editor', 'Último que lo guardó (dentro del archivo)'],
  ['creado', 'Creado (según el archivo)', (a) => (a.creado ? fechaConAnio(a.creado) : '')],
  ['modificado', 'Modificado (según el archivo)', (a) => (a.modificado ? fechaConAnio(a.modificado) : '')],
  ['minutos_edicion', 'Minutos de edición', (a) => (a.minutos_edicion === null ? '' : `${a.minutos_edicion} min`)],
  ['revision', 'Número de guardados (revisión)'],
  ['otros_autores', 'Comentaron o corrigieron adentro'],
  ['cuenta', 'Cuenta que lo creó (Colab)'],
  ['drive_dueno', 'Dueño en Drive'],
  ['drive_creado', 'Creado en Drive', (a) => (a.drive_creado ? fechaConAnio(a.drive_creado) : '')],
  ['drive_editor', 'Último que lo modificó en Drive'],
  ['drive_modificado', 'Modificado en Drive', (a) => (a.drive_modificado ? fechaConAnio(a.drive_modificado) : '')],
  ['drive_editores', 'Versiones guardadas en Drive (en orden)'],
  ['titulo', 'Título (propiedades)'],
  ['programa', 'Programa con que se hizo'],
  ['empresa', 'Empresa (propiedades)'],
  ['plantilla', 'Plantilla'],
  ['camara', 'Cámara'],
  ['fecha_foto', 'Fecha de la foto', (a) => (a.fecha_foto ? fechaConAnio(a.fecha_foto) : '')],
  ['palabras', 'Palabras de texto', (a) => (a.palabras ? a.palabras.toLocaleString('es-MX') : 'sin texto (escaneado o foto)')],
  ['tamano', 'Tamaño', (a) => tamano(a.tamano)],
  ['sha256', 'Huella del archivo', (a) => (a.sha256 ? a.sha256.slice(0, 16) : '')],
  ['historia', 'En resumen'],
  ['error', 'No se pudo leer']
]

/**
 * Todo lo que se sabe de un caso: la evidencia, la cronología de los archivos de los alumnos involucrados en esa
 * tarea (lo más viejo primero, con el tiempo entre cada paso), las señales y la ficha completa de cada archivo.
 */
function DetalleMetadatos({ detalle, lectura, corto }: { detalle: DetalleAbierto; lectura: LecturaMetadatos; corto: (n?: string) => string }): JSX.Element {
  const { tarea, alumnos, hallazgo: h } = detalle
  const archivos = lectura.archivos.filter((a) => a.tarea === tarea && alumnos.includes(a.alumno))
  const senales = lectura.senales.filter((s) => s.tarea === tarea && s.alumnos.some((x) => alumnos.includes(x)))
  // Un mismo archivo exacto (misma huella) en dos alumnos es la prueba más fuerte
  const huellas = new Map<string, Set<string>>()
  for (const a of archivos) if (a.sha256) huellas.set(a.sha256, (huellas.get(a.sha256) ?? new Set()).add(a.alumno))
  const repetidas = new Set([...huellas].filter(([, quien]) => quien.size > 1).map(([sha]) => sha))

  const eventos = archivos
    .flatMap((a) => {
      const de = (cuando: string | null, que: string): { t: number; a: typeof a; que: string }[] =>
        cuando && !Number.isNaN(Date.parse(cuando)) ? [{ t: Date.parse(cuando), a, que }] : []
      return [
        ...de(a.creado, `Se creó${a.autor ? ` (autor: «${a.autor}»)` : ''}${a.programa ? ` con ${a.programa}` : ''}`),
        ...de(a.drive_creado, `Apareció en Drive${a.drive_dueno ? ` (dueño: «${a.drive_dueno}»)` : ''}`),
        ...de(a.fecha_foto, `Se tomó la foto${a.camara ? ` (${a.camara})` : ''}`),
        ...de(a.modificado, `Se guardó por última vez${a.ultimo_editor ? ` (cuenta: «${a.ultimo_editor}»)` : ''}${a.minutos_edicion !== null ? `, ${a.minutos_edicion} min de edición` : ''}`),
        ...de(a.drive_modificado, `Última modificación en Drive${a.drive_editor ? ` (por «${a.drive_editor}»)` : ''}`),
        ...de(a.entregado, `Lo entregó en ${a.origen === 'portal' ? 'el portal' : 'Classroom'}`)
      ]
    })
    .sort((x, y) => x.t - y.t)

  const colorDe = (alumno: string): string => (alumnos.indexOf(alumno) === 0 ? 'bg-sky-500' : alumnos.indexOf(alumno) === 1 ? 'bg-orange-500' : 'bg-ink-400')

  return (
    <div className="space-y-5 text-sm">
      {h && (
        <section className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 text-xs font-semibold ${h.fuerza === 'prueba' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{h.fuerza === 'prueba' ? 'Prueba directa' : 'Indicio'}</span>
            <b className="text-ink-900">{h.conclusion}</b>
          </div>
          {h.original && h.copia && (
            <p className="text-ink-700">Lo hizo <b>{corto(h.original)}</b> y lo entregó como suyo <b>{corto(h.copia)}</b>.</p>
          )}
          <p className="break-words text-ink-700">{h.evidencia}</p>
        </section>
      )}

      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Cronología</div>
        {eventos.length === 0 ? (
          <p className="mt-1 text-ink-500">Los archivos no traen fechas.</p>
        ) : (
          <ol className="mt-2 border-l-2 border-ink-100 pl-4">
            {eventos.map((e, i) => (
              <li key={i} className="relative pb-3 last:pb-0">
                <span className={`absolute -left-[1.4rem] top-1.5 size-2.5 rounded-full ${colorDe(e.a.alumno)}`} aria-hidden="true" />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium tabular-nums text-ink-900">{fechaConAnio(new Date(e.t).toISOString())}</span>
                  {i > 0 && <span className="text-xs text-ink-400">{lapso(e.t - eventos[i - 1].t)} después</span>}
                </div>
                <div className="break-words text-ink-700">
                  <b>{corto(e.a.alumno)}</b> · {e.que} <span className="text-ink-500">· «{e.a.nombre}»</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {senales.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Señales que se encontraron</div>
          <ul className="mt-1 space-y-1">
            {senales.map((s, i) => (
              <li key={i} className="break-words text-ink-700">
                <span className={`mr-1.5 rounded px-1.5 text-xs font-semibold ${s.nivel === 'alta' ? 'bg-red-100 text-red-800' : s.nivel === 'media' ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-600'}`}>{s.nivel}</span>
                {s.texto}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Todos los metadatos de cada archivo</div>
        {archivos.length === 0 ? (
          <p className="mt-1 text-ink-500">No hay archivos leídos de {alumnos.map(corto).join(' ni ')} en esta tarea.</p>
        ) : (
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {archivos.map((a, i) => (
              <div key={i} className="min-w-0 rounded-lg border border-ink-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className={`size-2.5 shrink-0 rounded-full ${colorDe(a.alumno)}`} aria-hidden="true" />
                  <b className="min-w-0 break-words text-ink-900">{corto(a.alumno)}</b>
                  {repetidas.has(a.sha256) && <span className="rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800">mismo archivo exacto que otro alumno</span>}
                </div>
                <dl className="space-y-1">
                  {CAMPOS.map(([campo, etiqueta, ver]) => {
                    const valor = ver ? ver(a) : String(a[campo] ?? '')
                    if (!valor || valor === '0') return null
                    return (
                      <div key={campo} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-2">
                        <dt className="text-xs text-ink-500">{etiqueta}</dt>
                        <dd className={`break-words text-ink-800 ${campo === 'error' ? 'text-red-700' : ''}`}>{valor}</dd>
                      </div>
                    )
                  })}
                </dl>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className="text-xs text-ink-400">Son pistas: confírmalas abriendo los archivos. Las horas están en hora de Ciudad de México.</p>
    </div>
  )
}

/** Encabezado de una columna de tarea: nombre (hasta tres renglones), fecha y marcas de lo que conviene saber de un vistazo. */
function EncabezadoTarea({ col, ahora, conSuelta }: { col: Columna; ahora: number; conSuelta: boolean }): JSX.Element {
  const vencida = !!col.vence && Date.parse(col.vence) < ahora
  const pronto = !!col.vence && !vencida && Date.parse(col.vence) - ahora < TRES_DIAS
  const cuando = col.vence ? `${vencida ? 'venció' : 'vence'} ${fecha(col.vence)}` : col.cuentaDesde ? `sin fecha · cuenta desde ${fecha(col.cuentaDesde)}` : 'sin fecha'
  // El portal solo se ajusta por tarea de Classroom: en una columna que junta varias no se marca
  const p = col.tareas.length === 1 ? col.tareas[0].portal : null
  const marcas: { t: string; c: string; titulo?: string }[] = [
    ...(col.tareas.length > 1 ? [{ t: `junta ${col.tareas.length}`, c: 'bg-ink-100 text-ink-600', titulo: col.tareas.map((t) => `«${t.titulo}»`).join(', ') }] : []),
    ...(conSuelta && col.suelta ? [{ t: 'sin agrupar', c: 'bg-ink-100 text-ink-500' }] : []),
    ...(col.propia ? [{ t: 'creada aquí', c: 'bg-brand-500/10 text-brand-600', titulo: 'La creaste desde la app: se edita y califica aquí' }] : []),
    ...(p?.visibilidad === 'oculta' ? [{ t: 'oculta en portal', c: 'bg-amber-50 text-amber-800' }] : []),
    ...(p?.visibilidad === 'algunos' ? [{ t: `solo para ${p.alumnos.length} ${p.alumnos.length === 1 ? 'alumno' : 'alumnos'}`, c: 'bg-amber-50 text-amber-800' }] : []),
    ...(p && !p.acepta_tarde ? [{ t: 'sin entregas tarde', c: 'bg-amber-50 text-amber-800' }] : [])
  ]
  return (
    <>
      <div className="line-clamp-3 break-words text-[13px] font-semibold leading-snug text-ink-800">{col.nombre}</div>
      <div className={`mt-0.5 text-[11px] ${pronto ? 'font-medium text-amber-700' : 'text-ink-500'}`}>{cuando}</div>
      {marcas.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {marcas.map((m) => <span key={m.t} className={`whitespace-nowrap rounded px-1 py-px text-[10px] font-medium ${m.c}`} title={m.titulo}>{m.t}</span>)}
        </div>
      )}
    </>
  )
}

/** Pie de una columna: cómo va la tarea y sus acciones. Calificar y Portal siempre a la vista; lo demás al pasar el mouse o llegar con el teclado. */
function PieTarea({ col, tarea, propias, onDescargar, onRevisar }: { col: Columna; tarea: TareaResumen | undefined; propias: AccionesPropias; onDescargar: () => void; onRevisar: () => void }): JSX.Element {
  const t = col.tot
  return (
    <>
      <div className="space-y-0.5 text-ink-600">
        <div><b className="text-ink-900">{t.entrego + t.tarde}</b> de {t.asignadas} entregaron</div>
        {t.tarde > 0 && <div className="text-amber-700">{t.tarde} tarde</div>}
        {t.no_entrego > 0 && <div className="text-red-700">{t.no_entrego} sin entregar</div>}
        {t.pendiente > 0 && <div className="text-ink-500">{t.pendiente} pendientes</div>}
        {col.porCalificar > 0 && <div className="font-medium text-brand-600">{col.porCalificar} por calificar</div>}
      </div>
      <div className="mt-2 flex flex-col items-start gap-0.5">
        {/* Solo las que creó la app se pueden cambiar y calificar en Classroom desde aquí */}
        {tarea?.propia && <button className="btn-secundario px-2 py-0.5 text-xs" onClick={() => propias.calificar(tarea)}>✓ Calificar</button>}
        {tarea && (
          <button className="btn-fantasma px-1.5 py-0.5 text-xs" onClick={() => propias.portal(tarea)} title="Para quién es en el portal de alumnos y si acepta entregas tarde">
            👁 Portal
          </button>
        )}
        <div className="flex flex-col items-start gap-0.5 opacity-0 transition-opacity duration-150 group-hover/pie:opacity-100 group-focus-within/pie:opacity-100">
          <button className="btn-fantasma px-1.5 py-0.5 text-xs" onClick={onDescargar} title="Guardar en una carpeta todos los archivos entregados">⤓ Descargar todo</button>
          <button className="btn-fantasma px-1.5 py-0.5 text-xs" onClick={onRevisar} title="Lee los metadatos de los archivos entregados y los compara entre alumnos">🔍 Revisar copias</button>
          {tarea?.propia && (
            <>
              <button className="btn-fantasma px-1.5 py-0.5 text-xs" onClick={() => propias.editar(tarea)}>✎ Editar</button>
              <button className="btn-fantasma px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50" onClick={() => propias.borrar(tarea)}>🗑 Eliminar</button>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// ---------- Agrupar tareas ----------

function Agrupar({ r, materiaId, cambiar }: { r: ResumenClassroom; materiaId: number; cambiar: (f: () => Promise<unknown>, ok?: string) => Promise<void> }): JSX.Element {
  const c = r.consolidado
  const [nueva, setNueva] = useState('')
  const apps = c.tareas.filter((t) => t.id !== null)
  const sueltas = c.tareas.filter((t) => t.id === null)
  const titulo = (k: string): string => r.tareas.find((t) => t.clave === k)?.titulo ?? k
  const fechaDe = (k: string): string => {
    const t = r.tareas.find((x) => x.clave === k)
    return t?.vence ? `vence ${fecha(t.vence)}` : t?.creada ? `sin fecha · cuenta como no entregada desde ${fecha(new Date(Date.parse(t.creada) + 7 * 24 * 3600_000).toISOString())}` : ''
  }
  const sug = c.sugerencias
  return (
    <div className="space-y-5">
      {(sug.grupos.length > 0 || sug.comodines.length > 0) && (
        <section className="tarjeta p-5 space-y-3 border-brand-400/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Sugerencias</h3>
            <button className="btn-primario" onClick={() => cambiar(() => api.classroom.aceptarSugerencias(materiaId), 'Sugerencias aplicadas')}>Aceptar todas</button>
          </div>
          <ul className="space-y-2 text-sm">
            {sug.grupos.map((g) => (
              <li key={g.nombre} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words"><b>{g.nombre}</b>{g.tarea_app_id ? ' (ya existe)' : ''} ← {g.tareas.map((t) => `«${t.titulo}»`).join(' + ')}</span>
                <button className="btn-secundario" onClick={() => cambiar(async () => {
                  if (g.tarea_app_id) for (const t of g.tareas) await api.classroom.asignarTarea(t.clave, g.tarea_app_id)
                  else await api.classroom.crearTareaApp(materiaId, g.nombre, g.tareas.map((t) => t.clave))
                })}>Aceptar</button>
              </li>
            ))}
            {sug.comodines.map((x) => (
              <li key={x.clave} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words">«{x.titulo}» es una <b>recuperación comodín</b>: se acredita a la tarea que le falte a cada alumno</span>
                <button className="btn-secundario" onClick={() => cambiar(() => api.classroom.marcarComodin(x.clave, true))}>Aceptar</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tarjeta p-5 space-y-3">
        <h3 className="font-semibold">Tareas de la app ({apps.length})</h3>
        <p className="text-xs text-ink-500">Cada una junta las tareas de Classroom que son la misma (p. ej. «1er Tarea» y «Subida de Tarea 1»). Si un alumno la entregó en varias, cuenta una sola.</p>
        {apps.map((t) => (
          <div key={t.clave} className="rounded-lg border border-ink-200 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input className="input flex-[1_1_10rem] w-auto font-medium" defaultValue={t.nombre} aria-label="Nombre de la tarea"
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== t.nombre && cambiar(() => api.classroom.actualizarTareaApp(t.id!, { nombre: e.target.value }), 'Nombre guardado')} />
              <label className="flex items-center gap-1.5 text-sm">
                <span className="text-ink-500">Si la entregó varias veces, cuenta</span>
                <select className="input w-auto" value={t.regla} onChange={(e) => cambiar(() => api.classroom.actualizarTareaApp(t.id!, { regla: e.target.value as 'alta' | 'ultima' }))}>
                  <option value="alta">la calificación más alta</option>
                  <option value="ultima">la última entrega</option>
                </select>
              </label>
              <button className="btn-fantasma text-red-700" onClick={() => confirm(`¿Quitar «${t.nombre}»? Sus tareas de Classroom quedan sueltas; nada se borra en Classroom.`) && cambiar(() => api.classroom.eliminarTareaApp(t.id!))}>Quitar</button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {t.tareas.map((k) => (
                <span key={k} className="chip bg-ink-100 text-ink-700 gap-1">
                  «{titulo(k)}» <span className="text-ink-500">{fechaDe(k)}</span>
                  <button className="ml-0.5 text-ink-500 hover:text-red-700" aria-label={`Sacar «${titulo(k)}»`} onClick={() => cambiar(() => api.classroom.asignarTarea(k, null))}>✕</button>
                </span>
              ))}
              {sueltas.length > 0 && (
                <select className="input w-auto text-xs py-1" value="" onChange={(e) => e.target.value && cambiar(() => api.classroom.asignarTarea(e.target.value, t.id!))} aria-label="Agregar tarea de Classroom">
                  <option value="">+ Agregar tarea de Classroom…</option>
                  {sueltas.map((s) => <option key={s.clave} value={s.tareas[0]}>{s.nombre}</option>)}
                </select>
              )}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <input className="input flex-[1_1_12rem] w-auto" value={nueva} onChange={(e) => setNueva(e.target.value)} placeholder="Nombre de una tarea nueva (p. ej. Tarea 3)" />
          <button className="btn-secundario" disabled={!nueva.trim()} onClick={() => cambiar(() => api.classroom.crearTareaApp(materiaId, nueva)).then(() => setNueva(''))}>Crear tarea</button>
        </div>
      </section>

      <section className="tarjeta p-5 space-y-3">
        <h3 className="font-semibold">Recuperaciones comodín ({c.comodines.length})</h3>
        <p className="text-xs text-ink-500">Se acreditan, por alumno, a la tarea más antigua que le falte. Si le faltan varias, la app la pone en la más antigua y te pide confirmar en «Por revisar». Tus decisiones se respetan al volver a sincronizar.</p>
        {c.comodines.map((x) => (
          <div key={x.clave} className="rounded-lg border border-ink-200 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium min-w-0 flex-1 break-words">«{x.titulo}» <span className="text-ink-500 font-normal text-xs">{fechaDe(x.clave)}</span></span>
              <button className="btn-fantasma" onClick={() => cambiar(() => api.classroom.marcarComodin(x.clave, false))}>Ya no es comodín</button>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-ink-500">Puede acreditar a:</span>
              {apps.map((t) => (
                <label key={t.clave} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={x.cubre_efectivo.includes(t.id!)}
                    onChange={(e) => {
                      const base = x.cubre.length ? x.cubre : x.cubre_efectivo
                      const nuevo = e.target.checked ? [...base, t.id!] : base.filter((i) => i !== t.id)
                      void cambiar(() => api.classroom.marcarComodin(x.clave, true, nuevo))
                    }} />
                  {t.nombre}
                </label>
              ))}
              {x.cubre.length > 0 && <button className="underline text-xs text-brand-600" onClick={() => cambiar(() => api.classroom.marcarComodin(x.clave, true, []))}>volver a «todas las anteriores»</button>}
            </div>
          </div>
        ))}
        {c.comodines.length === 0 && <p className="text-sm text-ink-500">Ninguna. Marca como comodín una tarea suelta de abajo (p. ej. «Tarea que faltó»).</p>}
      </section>

      <section className="tarjeta p-5 space-y-2">
        <h3 className="font-semibold">Tareas de Classroom sueltas ({sueltas.length})</h3>
        <p className="text-xs text-ink-500">Se muestran como columna propia hasta que las agrupes.</p>
        <ul className="divide-y divide-ink-100">
          {sueltas.map((s) => (
            <li key={s.clave} className="py-2 flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-[1_1_12rem] break-words">«{s.nombre}» <span className="text-xs text-ink-500">{fechaDe(s.tareas[0])}</span></span>
              {apps.length > 0 && (
                <select className="input w-auto text-sm" value="" onChange={(e) => e.target.value && cambiar(() => api.classroom.asignarTarea(s.tareas[0], Number(e.target.value)))} aria-label={`Agregar «${s.nombre}» a una tarea`}>
                  <option value="">Agregar a…</option>
                  {apps.map((t) => <option key={t.clave} value={t.id!}>{t.nombre}</option>)}
                </select>
              )}
              <button className="btn-secundario" onClick={() => cambiar(() => api.classroom.crearTareaApp(materiaId, s.nombre, s.tareas))}>Crear tarea con esta</button>
              <button className="btn-fantasma" onClick={() => cambiar(() => api.classroom.marcarComodin(s.tareas[0], true))}>Es recuperación</button>
            </li>
          ))}
        </ul>
        {sueltas.length === 0 && <p className="text-sm text-ink-500">Todas están agrupadas.</p>}
      </section>
    </div>
  )
}

// ---------- Sin ligar ----------

function SinLigar({ r, cambiar }: { r: ResumenClassroom; cambiar: (f: () => Promise<unknown>, ok?: string) => Promise<void> }): JSX.Element {
  const s = r.sin_ligar
  const porConfirmar = s.classroom.filter((x) => x.sugerido)
  const ignorados = [...s.classroom.filter((x) => !x.sugerido), ...s.ajenos]
  const ligar = (x: SinLigarClassroom, destino: number | 'ajeno' | null): Promise<void> => cambiar(() => api.classroom.ligarAlumno(x.curso_id, x.user_id, destino))
  const elegir = (x: SinLigarClassroom, texto: string): JSX.Element => (
    <select className="input w-auto max-w-full text-sm" value="" onChange={(e) => e.target.value && ligar(x, Number(e.target.value))} aria-label={`Ligar a ${x.nombre}`}>
      <option value="">{texto}</option>
      {s.app.map((a) => <option key={a.id} value={a.id}>{a.apellidos} {a.nombre}{a.matricula ? ` (${a.matricula})` : ''}</option>)}
    </select>
  )
  return (
    <div className="grid gap-5 lg:grid-cols-2 items-start">
      <div className="space-y-5">
        <section className="tarjeta">
          <div className="px-5 pt-4 pb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Por confirmar ({porConfirmar.length})</h3>
            {porConfirmar.length > 1 && (
              <button className="btn-secundario" onClick={() => cambiar(async () => { for (const x of porConfirmar) await api.classroom.ligarAlumno(x.curso_id, x.user_id, x.sugerido!.id) }, 'Sugerencias confirmadas')}>Confirmar las {porConfirmar.length}</button>
            )}
          </div>
          <p className="px-5 pb-2 text-xs text-ink-500">Su nombre en Classroom se parece a alguien de tu lista, pero no lo suficiente para ligarlo solo. Mientras no lo confirmes, no cuenta en nada.</p>
          {porConfirmar.length === 0 ? <p className="px-5 pb-4 text-sm text-ink-500">Nada que confirmar.</p> : (
            <ul className="divide-y divide-ink-100 border-t border-ink-100">
              {porConfirmar.map((x) => (
                <li key={x.clave} className="px-5 py-2.5 space-y-1.5">
                  <div className="text-sm"><b>{x.nombre}</b>{x.email && <span className="text-ink-500"> · {x.email}</span>}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="btn-primario" onClick={() => ligar(x, x.sugerido!.id)}>Es {x.sugerido!.apellidos} {x.sugerido!.nombre}</button>
                    {elegir(x, 'Es otro…')}
                    <button className="btn-fantasma" onClick={() => ligar(x, 'ajeno')}>No es de mi grupo</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <details className="tarjeta">
          <summary className="cursor-pointer px-5 py-3 font-semibold">En Classroom pero no en tu lista (ignorados) ({ignorados.length})</summary>
          <p className="px-5 pb-2 text-xs text-ink-500">Tu lista manda: no se dan de alta ni cuentan en la tabla, los totales, «Por revisar» o el Excel. Si alguno es de tu grupo con otro nombre, lígalo a mano.</p>
          <ul className="border-t border-ink-100 divide-y divide-ink-100 text-sm">
            {ignorados.map((x) => (
              <li key={x.clave} className="px-5 py-2 flex flex-wrap items-center gap-2">
                <span className="flex-[1_1_10rem] min-w-0 break-words">{x.nombre}{x.liga === 'ajeno' && <span className="text-ink-500"> · marcado «no es de mi grupo»</span>}</span>
                {s.app.length > 0 && elegir(x, 'Ligar con…')}
                {x.liga === 'ajeno' && <button className="btn-fantasma" onClick={() => ligar(x, null)}>Deshacer</button>}
              </li>
            ))}
          </ul>
        </details>
      </div>
      <div className="space-y-5">
        <section className="tarjeta">
          <h3 className="px-5 pt-4 pb-1 font-semibold">En tu lista, no en Classroom ({s.app.length})</h3>
          <p className="px-5 pb-2 text-xs text-ink-500">Pueden no estar inscritos en la clase de Classroom o estar con otro nombre (lígalos desde la izquierda).</p>
          <ul className="border-t border-ink-100 divide-y divide-ink-100 text-sm">
            {s.app.map((a) => <li key={a.id} className="px-5 py-2">{a.apellidos} {a.nombre} {a.matricula && <span className="text-ink-500">· {a.matricula}</span>}</li>)}
          </ul>
        </section>
        <details className="tarjeta">
          <summary className="cursor-pointer px-5 py-3 font-semibold">Ligados ({r.alumnos.length})</summary>
          <ul className="border-t border-ink-100 divide-y divide-ink-100 text-sm">
            {r.alumnos.map((a) => (
              <li key={a.clave} className="px-5 py-2 flex flex-wrap items-center gap-2">
                <span className="flex-1 min-w-0 break-words">{a.nombre}</span>
                <span className="text-xs text-ink-500">{a.liga === 'correo' ? 'por correo' : a.liga === 'nombre' ? 'por nombre' : 'a mano'}</span>
                <button className="btn-fantasma" onClick={() => cambiar(() => api.classroom.ligarAlumno(a.curso_id, a.user_id, null))}>Desligar</button>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  )
}

// ---------- Detalle de una celda ----------

function DetalleCelda({ abierta, r, onCerrar, cambiar }: { abierta: Abierta; r: ResumenClassroom; onCerrar: () => void; cambiar: (f: () => Promise<unknown>, ok?: string) => Promise<void> }): JSX.Element {
  // Tras un cambio el resumen se recarga: se busca la celda actualizada
  const c = r.consolidado
  const celdaApp = abierta.tipo === 'app' ? c.celdas.find((x) => x.alumno === abierta.celda.alumno && x.tarea_app === abierta.celda.tarea_app) ?? abierta.celda : null
  const alumnoClave = abierta.celda.alumno
  const al = r.alumnos.find((a) => a.clave === alumnoClave)
  const col = celdaApp ? c.tareas.find((t) => t.clave === celdaApp.tarea_app) : null
  const tituloCr = abierta.tipo === 'cruda' ? r.tareas.find((t) => t.clave === abierta.celda.tarea)?.titulo ?? '' : ''
  const titulo = `${al?.nombre ?? ''} · ${col?.nombre ?? tituloCr}`

  // Recuperaciones que este alumno entregó y que podrían ir a esta tarea
  const comodines = celdaApp && col?.id
    ? c.comodines.filter((k) => k.cubre_efectivo.includes(col.id!) && r.entregas.some((e) => e.alumno === alumnoClave && e.tarea === k.clave && (e.estado === 'entrego' || e.estado === 'tarde')))
    : []
  const acreditadaA = (comodin: string): string | null =>
    c.celdas.find((x) => x.alumno === alumnoClave && [x.cuenta, ...x.otras].some((f) => f?.comodin && f.tarea === comodin))?.tarea_app ?? null

  return (
    <Modal titulo={titulo} abierto onCerrar={onCerrar} ancho={`max-w-5xl ${ALTO_MODAL}`}>
      {celdaApp && col ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Estado e={celdaApp.estado} grande />
            {celdaApp.cuenta && <span className="text-sm">en «{celdaApp.cuenta.titulo}»{celdaApp.cuenta.comodin ? ' (recuperación)' : ''}</span>}
            {celdaApp.entregada && <span className="text-sm text-ink-600">· {fechaHora(celdaApp.entregada)}</span>}
            <span className="text-sm">{textoCalif(celdaApp) ? <>· Calificación: <Calif c={celdaApp} /></> : celdaApp.cuenta ? '· Sin calificar' : ''}</span>
          </div>
          {celdaApp.veces > 1 && (
            <p className="text-sm rounded-lg bg-ink-50 border border-ink-200 px-3 py-2">
              Entregó {celdaApp.veces} veces. Cuenta «{celdaApp.cuenta?.titulo}» ({col.regla === 'alta' ? 'la calificación más alta' : 'la última entrega'}; se cambia en Agrupar tareas). No hace falta revisar las demás.
            </p>
          )}
          {comodines.map((k) => {
            const actual = acreditadaA(k.clave)
            return (
              <div key={k.clave} className={`rounded-lg border px-3 py-2 space-y-1.5 ${celdaApp.ambigua ? 'border-amber-300 bg-amber-50' : 'border-ink-200'}`}>
                <p className="text-sm">Entregó la recuperación «{k.titulo}». Se acredita a: <b>{c.tareas.find((t) => t.clave === actual)?.nombre ?? 'ninguna'}</b>{celdaApp.ambigua ? ' (por omisión: decide tú)' : ''}</p>
                <div className="flex flex-wrap gap-2">
                  {k.cubre_efectivo.map((id) => {
                    const t = c.tareas.find((x) => x.id === id)
                    return t ? <button key={id} className={actual === t.clave ? 'btn-primario' : 'btn-secundario'} onClick={() => cambiar(() => api.classroom.decidirComodin(k.clave, al!.user_id, id), 'Decisión guardada')}>{t.nombre}</button> : null
                  })}
                  <button className="btn-fantasma" onClick={() => cambiar(() => api.classroom.decidirComodin(k.clave, al!.user_id, 'ninguna'), 'Decisión guardada')}>No acreditar</button>
                  <button className="btn-fantasma" onClick={() => cambiar(() => api.classroom.decidirComodin(k.clave, al!.user_id, 'auto'))}>Automático</button>
                </div>
              </div>
            )
          })}
          {celdaApp.cuenta && <EntregaVista fuente={celdaApp.cuenta} cambiar={cambiar} />}
          {celdaApp.otras.length > 0 && (
            <details className="rounded-lg border border-ink-200">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{celdaApp.cuenta ? 'Las demás entregas de esta tarea' : 'Tareas de Classroom que la forman'} ({celdaApp.otras.length})</summary>
              <div className="border-t border-ink-100 p-3 space-y-4">
                {celdaApp.otras.map((f) => <EntregaVista key={f.entrega_id} fuente={f} cambiar={cambiar} />)}
              </div>
            </details>
          )}
        </div>
      ) : abierta.tipo === 'cruda' ? (
        <EntregaVista fuente={{ curso_id: abierta.celda.alumno.split(':')[0], entrega_id: abierta.celda.entrega_id, tarea: abierta.celda.tarea, titulo: tituloCr, estado: abierta.celda.estado, tarde: abierta.celda.tarde, calificacion: abierta.celda.calificacion, borrador: abierta.celda.borrador, puntos: abierta.celda.puntos, entregada: abierta.celda.entregada, adjuntos: abierta.celda.adjuntos, comodin: false }} cambiar={cambiar} />
      ) : null}
    </Modal>
  )
}

/** Una entrega de Classroom: estado, fechas, calificación, respuesta y adjuntos con vista previa. */
function EntregaVista({ fuente, cambiar }: { fuente: FuenteEntrega; cambiar?: (f: () => Promise<unknown>, ok?: string) => Promise<void> }): JSX.Element {
  const [d, setD] = useState<DetalleEntrega | null>(null)
  const [error, setError] = useState('')
  const [vista, setVista] = useState<{ id: string; v: Vista | null } | null>(null)
  const [bajando, setBajando] = useState('')
  const leer = (): Promise<void> => api.classroom.entrega(fuente.curso_id, fuente.entrega_id).then(setD).catch((e) => setError((e as Error).message))
  useEffect(() => {
    void leer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuente.curso_id, fuente.entrega_id])
  // Calificación en la app: manda sobre la de Classroom para los promedios y se puede quitar
  const [nota, setNota] = useState('')
  useEffect(() => setNota(d?.propia ? (d.calificacion == null ? '' : String(d.calificacion)) : d?.calif_app == null ? '' : String(d.calif_app)), [d?.calif_app, d?.propia, d?.calificacion])
  const guardarNota = async (valor: number | null, devolver = false): Promise<void> => {
    // Tarea creada desde la app: la calificación va a Classroom (y se devuelve si se pide)
    if (d?.propia && valor !== null) {
      const f = async (): Promise<void> => {
        const x = await api.classroom.calificarEnClassroom(fuente.curso_id, d.tarea_id, [{ entrega_id: fuente.entrega_id, nota: valor }], devolver)
        if (x.errores.length) throw new Error(x.errores.join(' · '))
      }
      if (cambiar) await cambiar(f, devolver ? 'Calificada en Classroom y devuelta al alumno' : 'Calificación guardada en Classroom')
      else await f().catch((e) => avisar((e as Error).message, 'error'))
      await leer()
      return
    }
    const f = (): Promise<void> => api.classroom.calificarEnApp(fuente.curso_id, fuente.entrega_id, valor)
    if (cambiar) await cambiar(f, valor === null ? 'Se quitó la calificación de la app' : 'Calificación guardada en la app')
    else await f().catch((e) => avisar((e as Error).message, 'error'))
    await leer()
  }
  // Entregas recibidas por correo, USB o impresas: cuentan en la app sin tocar Classroom
  const registrarFuera = async (recibida: boolean): Promise<void> => {
    const f = (): Promise<void> => api.classroom.marcarEntregaFuera(fuente.curso_id, fuente.entrega_id, recibida)
    if (cambiar) await cambiar(f, recibida ? 'Registrada como entregada fuera de Classroom' : 'Se quitó el registro')
    else await f()
    await leer()
  }
  if (error) return <p className="text-sm text-red-700">{error}</p>
  if (!d) return <p className="text-sm text-ink-500">Cargando entrega…</p>

  const ver = async (a: Extract<Adjunto, { tipo: 'drive' }>): Promise<void> => {
    setVista({ id: a.id, v: null })
    try {
      setVista({ id: a.id, v: await api.classroom.previsualizar(d.curso_id, d.entrega_id, a.id) })
    } catch (e) {
      setVista({ id: a.id, v: { tipo: 'ninguno', nombre: a.titulo, mime: '', tamano: null, enlace: a.enlace, motivo: (e as Error).message } })
    }
  }
  const descargar = async (a: Extract<Adjunto, { tipo: 'drive' }>): Promise<void> => {
    setBajando(a.id)
    try {
      const ruta = await api.classroom.descargar(d.curso_id, d.entrega_id, a.id)
      if (ruta) avisar(`Guardado en ${ruta}`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setBajando('')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <b className="break-words">«{d.tarea}»</b>
        <Estado e={d.estado} />
        {d.tarde && d.estado !== 'tarde' && <span className="chip bg-amber-50 text-amber-800">marcada tarde</span>}
        <span className="text-ink-600">Vence: {fechaHora(d.vence)}</span>
        <span className="text-ink-600">Entregada: {fechaHora(d.entregada)}</span>
        {d.portal && <span className="chip bg-violet-50 text-violet-800" title="La subió el alumno en «Subir tarea» del portal; en Classroom sigue igual">subida al portal</span>}
        {d.fuera && !d.portal && <span className="chip bg-sky-50 text-sky-800" title="Solo cuenta en la app; en Classroom sigue igual">registrada a mano</span>}
        <span>{textoCalif(d) ? <>Calificación: <Calif c={d} /></> : 'Sin calificar'}</span>
        {d.enlace && <button className="underline text-brand-600" onClick={() => api.classroom.abrirEnlace(d.enlace)}>Abrir en Classroom</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-ink-600">{d.curso_id.startsWith('app-') ? 'Calificación:' : d.propia ? 'Calificación en Classroom:' : 'Calificación en la app:'}</span>
          <input
            className="input w-20"
            inputMode="decimal"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && nota.trim() !== '' && guardarNota(Number(nota.replace(',', '.')))}
            aria-label="Calificación en la app"
          />
          <span className="text-ink-500">/ {d.puntos ?? 100}</span>
        </label>
        <button className="btn-secundario" disabled={nota.trim() === '' || (!d.propia && Number(nota.replace(',', '.')) === d.calif_app)} onClick={() => guardarNota(Number(nota.replace(',', '.')))}>Guardar</button>
        {d.propia && <button className="btn-primario" disabled={nota.trim() === ''} onClick={() => guardarNota(Number(nota.replace(',', '.')), true)}>Guardar y devolver</button>}
        {!d.propia && d.calif_app != null && <button className="btn-fantasma" onClick={() => guardarNota(null)}>Quitar</button>}
        <span className="text-xs text-ink-500">
          {d.curso_id.startsWith('app-')
            ? 'Esta materia no usa Classroom: la calificación se guarda en la app. «Guardar y devolver» hace que el alumno la vea en el portal.'
            : d.propia
            ? 'Esta tarea la creaste desde la app: la calificación se guarda en Classroom. «Guardar y devolver» hace que el alumno la vea.'
            : d.calif_app != null
              ? `Manda sobre Classroom${d.calif_classroom != null ? ` (allá tiene ${d.calif_classroom})` : ''}. Solo cambia la app.`
              : 'Si la pones, cuenta como entregada y manda sobre la de Classroom. Classroom no se toca (la tarea se creó allá).'}
        </span>
      </div>
      {d.portal && (
        <div className="space-y-2 rounded-lg border border-violet-200 bg-violet-50/40 px-3 py-2 text-sm">
          <div className="text-ink-700">
            La subió al portal el {fechaHora(d.portal.subida)}. Cuenta como entregada en la app; Classroom no se toca.
          </div>
          {d.portal.nota.trim() && <div className="whitespace-pre-wrap break-words rounded bg-white px-2 py-1 text-ink-800 select-text">«{d.portal.nota}»</div>}
          <ul className="divide-y divide-violet-100">
            {d.portal.archivos.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span aria-hidden>📎</span>
                <span className="min-w-0 flex-[1_1_12rem] break-words">{f.nombre}</span>
                <span className="text-xs text-ink-500">{tamano(f.tamano)}</span>
                <button className="btn-secundario" onClick={() => api.classroom.abrirSubida(f.id).catch((e) => avisar((e as Error).message, 'error'))}>Abrir</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!d.portal && (d.fuera || d.puede_registrarse) && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
          {d.fuera ? (
            <>
              <span className="text-ink-700">La registraste como recibida fuera de Classroom el {fechaHora(d.fuera)}. Solo cuenta en la app.</span>
              <button className="btn-fantasma" onClick={() => registrarFuera(false)}>Quitar registro</button>
            </>
          ) : (
            <>
              <span className="text-ink-600">¿Te la entregó por otro lado (correo, USB, impresa)?</span>
              <button className="btn-secundario" onClick={() => registrarFuera(true)}>Registrar como entregada</button>
            </>
          )}
        </div>
      )}
      {d.respuesta && <div className="rounded-lg bg-ink-50 border border-ink-200 px-3 py-2 text-sm select-text whitespace-pre-wrap break-words">{d.respuesta}</div>}
      {d.adjuntos.length === 0 ? (
        <p className="text-sm text-ink-500">Sin archivos adjuntos.</p>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {d.adjuntos.map((a, i) => (
            <li key={i} className="px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
              <span aria-hidden>{a.tipo === 'drive' ? '📄' : a.tipo === 'youtube' ? '▶' : a.tipo === 'formulario' ? '☑' : '🔗'}</span>
              <span className="min-w-0 flex-[1_1_12rem] break-words">{a.titulo}</span>
              {a.tipo === 'drive' ? (
                <span className="flex flex-wrap gap-1.5">
                  <button className={vista?.id === a.id ? 'btn-primario' : 'btn-secundario'} onClick={() => (vista?.id === a.id ? setVista(null) : ver(a))}>{vista?.id === a.id ? 'Ocultar' : 'Ver'}</button>
                  <button className="btn-secundario" disabled={bajando === a.id} onClick={() => descargar(a)}>{bajando === a.id ? 'Descargando…' : 'Descargar'}</button>
                  {a.enlace && <button className="btn-fantasma" onClick={() => api.classroom.abrirEnlace(a.enlace)}>Abrir en Drive</button>}
                </span>
              ) : (
                <button className="btn-secundario" onClick={() => api.classroom.abrirEnlace(a.tipo === 'enlace' ? a.url : a.tipo === 'formulario' ? a.respuestas || a.enlace : a.enlace)}>Abrir en el navegador</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {vista && <VistaPrevia v={vista.v} />}
      {(d.adjuntos.some((a) => a.tipo === 'drive') || (d.portal?.archivos.length ?? 0) > 0) && <MetadatosEntrega key={`${d.curso_id}:${d.entrega_id}`} cursoId={d.curso_id} entregaId={d.entrega_id} />}
    </div>
  )
}

/**
 * Metadatos de los archivos de esta entrega: quién los creó y en qué computadora, quién los modificó, minutos de
 * edición, quién los editó en Drive. Se piden aparte porque hay que bajar los archivos; se comparan con el grupo
 * para avisar si traen el nombre o la cuenta de otro alumno.
 */
function MetadatosEntrega({ cursoId, entregaId }: { cursoId: string; entregaId: string }): JSX.Element {
  const [estado, setEstado] = useState<{ cargando: boolean; r: InformeCopias | null; error: string }>({ cargando: false, r: null, error: '' })
  const [guardada, guardar] = useRevisionGuardada<InformeCopias>(`entrega:${cursoId}:${entregaId}`)
  const leer = async (): Promise<void> => {
    setEstado({ cargando: true, r: null, error: '' })
    try {
      const r = await api.classroom.metadatosEntrega(cursoId, entregaId)
      guardar(r)
      setEstado({ cargando: false, r, error: '' })
    } catch (e) {
      setEstado({ cargando: false, r: null, error: (e as Error).message })
    }
  }
  const r = estado.r ?? (estado.cargando ? null : guardada?.datos ?? null)
  const f = (x: string | null): string => (x ? fecha(x) : '—')
  // Lo que ya sale como hallazgo (nombres de otro, pares parecidos) no se repite; quedan las del archivo solo
  const otras = r ? r.senales.filter((x) => x.alumnos.length === 1 && !/corresponde a/.test(x.texto)) : []
  const quien = r?.archivos[0]?.alumno ?? ''
  /** Desde el punto de vista de este alumno: si el archivo salió de él, se dice a quién pasó */
  const conclusion = (h: InformeCopias['hallazgos'][number]): string => (h.original === quien && h.copia ? `Su archivo pasó a ${r?.nombres?.[h.copia] ?? cortoDesdeCompleto(h.copia)}.` : h.conclusion)
  return (
    <section className="space-y-2 rounded-lg border border-ink-200 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">Metadatos</div>
          <div className="text-xs text-ink-500">Quién creó cada archivo y en qué computadora, quién lo modificó y si salió del archivo de otro alumno (se compara con toda la tarea).</div>
          {r && guardada && !estado.r && <div className="text-xs text-ink-400">Leído el {fechaGuardada(guardada.guardado)}</div>}
        </div>
        <button className="btn-secundario shrink-0" onClick={() => void leer()} disabled={estado.cargando}>
          {estado.cargando ? 'Leyendo…' : r ? 'Leer otra vez' : 'Leer metadatos'}
        </button>
      </div>
      {estado.cargando && <p className="text-ink-500">Bajando los archivos de la tarea y comparándolos… puede tardar un minuto.</p>}
      {estado.error && <p className="break-words text-red-700">{estado.error}</p>}
      {r && (
        <div className="space-y-2">
          {r.hallazgos.length > 0 ? (
            <ul className="space-y-1.5">
              {r.hallazgos.map((h, i) => (
                <li key={i} className={`rounded-lg border px-3 py-2 ${h.fuerza === 'prueba' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
                  <span className="mr-2 rounded bg-white/70 px-1.5 text-xs font-semibold">{h.fuerza === 'prueba' ? 'Prueba directa' : 'Indicio'}</span>
                  <span className="break-words">{h.evidencia} <b>{conclusion(h)}</b></span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-emerald-700">No hay rastro de que haya salido del archivo de otro alumno.</p>
          )}
          {r.cadenas.map((c, i) => (
            <div key={i} className="rounded-lg border border-ink-200 bg-white px-3 py-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Cadena en esta tarea, por la hora de cada archivo</div>
              <div className="break-words font-medium text-ink-800">{c}</div>
            </div>
          ))}
          {r.trabajo_propio.map((t, i) => (
            <p key={i} className="text-emerald-800">Trabajo propio: {t}</p>
          ))}
          {otras.map((x, i) => (
            <p key={i} className={`rounded-lg border px-3 py-1.5 ${ESTILO_SENAL[x.nivel].c}`}>{x.texto}</p>
          ))}
          <ul className="space-y-2">
            {r.archivos.map((a, i) => (
              <li key={i} className="rounded-lg bg-ink-50 px-3 py-2">
                <div className="break-words font-medium">{a.nombre} <span className="text-xs font-normal text-ink-400">{a.origen === 'portal' ? 'portal' : 'Classroom'}</span></div>
                <div className="break-words text-ink-600">{a.historia}</div>
                <dl className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-4 gap-y-0.5 text-xs">
                  {(
                    [
                      ['Autor', a.autor],
                      ['Último editor', a.ultimo_editor],
                      ['Creado', a.creado ? f(a.creado) : ''],
                      ['Modificado', a.modificado ? f(a.modificado) : ''],
                      ['Minutos de edición', a.minutos_edicion === null ? '' : String(a.minutos_edicion)],
                      ['Título interno', a.titulo],
                      ['Programa', a.programa],
                      ['Empresa', a.empresa],
                      ['Comentarios o cambios de', a.otros_autores],
                      ['Nombre original en Drive', a.nombre_original !== a.nombre ? a.nombre_original : ''],
                      ['Editaron en Drive', a.drive_editores],
                      ['Foto', a.camara ? `${a.camara}${a.fecha_foto ? ` · ${a.fecha_foto}` : ''}` : '']
                    ] as [string, string][]
                  )
                    .filter(([, v]) => v)
                    .map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <dt className="inline text-ink-400">{k}: </dt>
                        <dd className="inline break-words text-ink-800">{v}</dd>
                      </div>
                    ))}
                </dl>
                {a.error && <div className="text-xs text-red-600">{a.error}</div>}
              </li>
            ))}
          </ul>
          {r.sin_archivo.length > 0 && <p className="text-xs text-ink-500">{r.sin_archivo.join(' · ')}</p>}
        </div>
      )}
    </section>
  )
}

function VistaPrevia({ v }: { v: Vista | null }): JSX.Element {
  if (!v) return <div className="rounded-lg border border-ink-200 bg-ink-50 p-6 text-center text-sm text-ink-500">Preparando la vista previa…</div>
  const pie = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
      <span className="break-words">{v.nombre}{v.tamano !== null ? ` · ${tamano(v.tamano)}` : ''}</span>
      {v.enlace && <button className="underline text-brand-600" onClick={() => api.classroom.abrirEnlace(v.enlace)}>Abrir en Google Drive</button>}
    </div>
  )
  if (v.tipo === 'pdf') return <div className="space-y-1.5"><iframe title={v.nombre} src={`${v.url}#navpanes=0&view=FitH`} className="w-full h-[calc(55vh/var(--zoom,1))] min-h-[200px] rounded-lg border border-ink-200 bg-white" />{pie}</div>
  if (v.tipo === 'imagen') return <div className="space-y-1.5"><div className="rounded-lg border border-ink-200 bg-ink-50 p-2 flex justify-center"><img src={v.url} alt={v.nombre} className="max-h-[calc(55vh/var(--zoom,1))] max-w-full object-contain" /></div>{pie}</div>
  if (v.tipo === 'texto') return <div className="space-y-1.5"><pre className="max-h-[calc(55vh/var(--zoom,1))] overflow-auto rounded-lg bg-ink-900 text-ink-50 p-3 text-[13px] select-text whitespace-pre-wrap break-words">{v.texto}{v.recortado ? '\n\n… (se muestra solo el inicio; descárgalo para verlo completo)' : ''}</pre>{pie}</div>
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50 p-4 space-y-2 text-sm">
      <div className="font-medium break-words">{v.nombre}{v.tamano !== null ? <span className="text-ink-500 font-normal"> · {tamano(v.tamano)}</span> : null}</div>
      <p className="text-ink-600">{v.motivo}</p>
      {v.enlace && <button className="btn-secundario" onClick={() => api.classroom.abrirEnlace(v.enlace)}>Abrir en Google Drive</button>}
    </div>
  )
}

const ESTILO_SENAL: Record<SenalCopia['nivel'], { c: string; t: string }> = {
  alta: { c: 'border-red-300 bg-red-50 text-red-900', t: 'Alta' },
  media: { c: 'border-amber-300 bg-amber-50 text-amber-900', t: 'Media' },
  baja: { c: 'border-ink-200 bg-ink-50 text-ink-700', t: 'Baja' }
}

const USO_DE_IA: Record<RevisionIA['alumnos'][number]['uso_de_ia'], string> = {
  probable: 'Probablemente hecho con IA',
  posible: 'Posible uso de IA',
  poco_probable: 'Poco probable que sea de IA',
  sin_texto: 'Sin texto que leer'
}

/**
 * Segunda opinión con IA: lee el contenido de las entregas (no solo los metadatos) para lo que las reglas no ven,
 * como paráfrasis, mismos errores o texto que parece generado. Se pide aparte porque usa la llave de IA.
 */
function RevisionConIA({ generado, clave }: { generado: string; clave: string }): JSX.Element {
  const [estado, setEstado] = useState<{ cargando: boolean; r: RevisionIA | null; error: string }>({ cargando: false, r: null, error: '' })
  const [guardada, guardar] = useRevisionGuardada<RevisionIA>(clave)
  const pedir = async (): Promise<void> => {
    setEstado({ cargando: true, r: null, error: '' })
    try {
      const r = await api.classroom.revisarCopiasIA(generado)
      guardar(r)
      setEstado({ cargando: false, r, error: '' })
    } catch (e) {
      setEstado({ cargando: false, r: null, error: (e as Error).message })
    }
  }
  // Sin revisión nueva en pantalla se muestra la guardada
  const r = estado.r ?? (estado.cargando ? null : guardada?.datos ?? null)
  const atender = r ? r.alumnos.filter((a) => a.nivel !== 'ninguna' || a.uso_de_ia === 'probable' || a.uso_de_ia === 'posible') : []
  const tranquilos = r ? r.alumnos.filter((a) => !atender.includes(a)) : []
  return (
    <section className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">Revisión adicional con IA</h3>
          <p className="text-xs text-ink-500">Lee el contenido de cada entrega: paráfrasis, mismos errores, texto que parece hecho con IA y fechas que no cuadran. Los nombres se mandan como «Alumno N».</p>
        </div>
        <button className="btn-secundario shrink-0" onClick={() => void pedir()} disabled={estado.cargando}>
          {estado.cargando ? 'Revisando…' : r ? 'Revisar otra vez' : 'Revisar con IA'}
        </button>
      </div>
      {estado.cargando && <p className="text-ink-500">Leyendo las entregas… tarda uno o dos minutos con un grupo completo.</p>}
      {estado.error && <p className="break-words text-red-700">{estado.error}</p>}
      {r && (
        <div className="space-y-3">
          <p className="whitespace-pre-line text-ink-800">{r.resumen}</p>
          {r.parecidos.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Se parecen más allá de lo literal</div>
              <ul className="space-y-1.5">
                {r.parecidos.map((p, i) => (
                  <li key={i} className={`rounded-lg border px-3 py-2 ${ESTILO_SENAL[p.nivel].c}`}>
                    <span className="mr-2 rounded bg-white/70 px-1.5 text-xs font-semibold">{ESTILO_SENAL[p.nivel].t}</span>
                    <b>{p.alumnos.join(' · ')}</b>
                    {p.original && !/no se sabe/i.test(p.original) ? <span className="ml-1 text-xs">(lo hizo primero: <b>{p.original}</b>)</span> : <span className="ml-1 text-xs">(no se sabe quién lo hizo primero)</span>}
                    : <span className="break-words">{p.explicacion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {atender.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Por alumno</div>
              <ul className="grid gap-2 md:grid-cols-2">
                {atender.map((a) => (
                  <li key={a.alumno} className="rounded-lg border border-ink-200 bg-white px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <b className="mr-1">{a.alumno}</b>
                      {a.nivel !== 'ninguna' && <span className={`rounded px-1.5 text-xs font-semibold ${ESTILO_SENAL[a.nivel].c}`}>{ESTILO_SENAL[a.nivel].t}</span>}
                      <span className={`text-xs ${a.uso_de_ia === 'probable' ? 'font-semibold text-violet-800' : 'text-ink-500'}`}>{USO_DE_IA[a.uso_de_ia]}</span>
                    </div>
                    {a.hallazgos.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-700">{a.hallazgos.map((h, i) => <li key={i} className="break-words">{h}</li>)}</ul>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {tranquilos.length > 0 && <p className="text-xs text-emerald-700">Sin nada que revisar: {tranquilos.map((a) => a.alumno).join(', ')}.</p>}
          {r.recomendaciones.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Qué revisar primero</div>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-700">{r.recomendaciones.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ol>
            </div>
          )}
          <p className="text-xs text-ink-400">Son pistas de la IA, no pruebas: confírmalas abriendo los archivos antes de decidir.</p>
        </div>
      )}
    </section>
  )
}

/** Informe de «Revisar copias»: señales de la más grave a la más leve y la ficha de metadatos de cada archivo. */
type CopiasAbiertas = { nombre: string; claves: string[]; informe: InformeCopias | null; error: string; guardado: string | null }
const claveCopias = (claves: string[]): string => `copias:${[...claves].sort().join(',')}`

function VistaCopias({ c, onOtraVez }: { c: CopiasAbiertas; onOtraVez: () => void }): JSX.Element {
  if (c.error) return <p className="text-sm text-red-700 break-words">{c.error}</p>
  if (!c.informe) return <p className="text-sm text-ink-500">Bajando los archivos y leyendo sus metadatos… puede tardar un minuto si son muchos.</p>
  const r = c.informe
  const f = (x: string | null): string => (x ? fecha(x) : '—')
  return (
    <div className="space-y-4 text-sm">
      {c.guardado && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          <span>Revisado el {fechaGuardada(c.guardado)}. Si llegaron entregas nuevas, vuelve a revisar.</span>
          <button className="btn-secundario py-1 text-xs" onClick={onOtraVez}>Revisar otra vez</button>
        </div>
      )}
      <p className="text-ink-600">
        {r.archivos.length} archivo(s) de {new Set(r.archivos.map((a) => a.alumno)).size} alumno(s). Las señales son pistas para revisar, no pruebas: confírmalas abriendo los archivos.
      </p>
      <section className="space-y-2">
        <h3 className="font-semibold">Lo que mostraron los metadatos</h3>
        {r.hallazgos.length === 0 ? (
          <p className="text-emerald-700">Los metadatos no muestran que algún archivo haya salido de otro alumno.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-ink-200">
            <table className="min-w-full text-sm">
              <thead className="bg-ink-50 text-left text-xs">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">Caso</th>
                  <th className="px-3 py-1.5 font-semibold">Evidencia en el archivo</th>
                  <th className="px-3 py-1.5 font-semibold">Conclusión</th>
                </tr>
              </thead>
              <tbody>
                {r.hallazgos.map((h, i) => (
                  <tr key={i} className="border-t border-ink-100 align-top">
                    <td className="max-w-[14rem] break-words px-3 py-2 font-medium">{h.caso}</td>
                    <td className="break-words px-3 py-2 text-ink-700">{h.evidencia}</td>
                    <td className="max-w-[18rem] break-words px-3 py-2">
                      <span className={`mr-1.5 rounded px-1.5 text-xs font-semibold ${h.fuerza === 'prueba' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}>{h.fuerza === 'prueba' ? 'Prueba directa' : 'Indicio'}</span>
                      {h.conclusion}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {r.cadenas.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Cadenas, por la hora en que apareció cada archivo</div>
            <ul className="mt-1 space-y-0.5">{r.cadenas.map((c, i) => <li key={i} className="break-words font-medium text-ink-800">{c}</li>)}</ul>
          </div>
        )}
        {r.trabajo_propio.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Trabajo propio (horas de edición, sin rastro de otro alumno)</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-emerald-800">{r.trabajo_propio.map((t, i) => <li key={i} className="break-words">{t}</li>)}</ul>
          </div>
        )}
      </section>
      <RevisionConIA key={r.generado} generado={r.generado} clave={`ia:${claveCopias(c.claves)}`} />
      <details className="space-y-2">
        <summary className="cursor-pointer font-semibold">Todas las señales ({r.senales.length})</summary>
        {r.senales.length === 0 ? (
          <p className="text-emerald-700">No se encontraron señales de copia entre estos archivos.</p>
        ) : (
          <ul className="space-y-1.5">
            {r.senales.map((s, i) => (
              <li key={i} className={`rounded-lg border px-3 py-2 ${ESTILO_SENAL[s.nivel].c}`}>
                <span className="mr-2 rounded bg-white/70 px-1.5 text-xs font-semibold">{ESTILO_SENAL[s.nivel].t}</span>
                <span className="break-words">{s.texto}</span>
              </li>
            ))}
          </ul>
        )}
        {r.sin_archivo.length > 0 && (
          <details className="text-xs text-ink-500">
            <summary className="cursor-pointer">{r.sin_archivo.length} entrega(s) sin archivo que revisar</summary>
            <ul className="mt-1 list-disc pl-5">{r.sin_archivo.map((x, i) => <li key={i} className="break-words">{x}</li>)}</ul>
          </details>
        )}
      </details>
      <section className="space-y-2">
        <h3 className="font-semibold">Metadatos de cada archivo</h3>
        <div className="overflow-x-auto rounded-lg border border-ink-200">
          <table className="min-w-full text-xs">
            <thead className="bg-ink-50 text-left">
              <tr>
                {['Alumno', 'Archivo e historia', 'Autor', 'Último editor', 'Comentarios o cambios de', 'Título interno', 'Creado', 'Modificado', 'Min. edición', 'Programa', 'Nombre original', 'Editaron en Drive', 'Drive: dueño', 'Foto'].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.archivos.map((a, i) => (
                <tr key={i} className="border-t border-ink-100 align-top">
                  <td className="px-2 py-1.5 font-medium" title={a.alumno}>{r.nombres?.[a.alumno] ?? cortoDesdeCompleto(a.alumno)}<div className="font-normal text-ink-400">{a.origen === 'portal' ? 'portal' : 'Classroom'}</div></td>
                  <td className="min-w-[16rem] max-w-[22rem] break-words px-2 py-1.5"><div className="font-medium">{a.nombre}</div><div className="text-ink-500">{a.historia}</div>{a.error && <div className="text-red-600">{a.error}</div>}</td>
                  <td className="px-2 py-1.5">{a.autor || '—'}</td>
                  <td className="px-2 py-1.5">{a.ultimo_editor || '—'}</td>
                  <td className="max-w-[12rem] break-words px-2 py-1.5">{a.otros_autores || '—'}</td>
                  <td className="max-w-[12rem] break-words px-2 py-1.5">{a.titulo || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{f(a.creado)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{f(a.modificado)}</td>
                  <td className="px-2 py-1.5">{a.minutos_edicion ?? '—'}</td>
                  <td className="max-w-[10rem] break-words px-2 py-1.5">{a.programa || '—'}</td>
                  <td className="max-w-[12rem] break-words px-2 py-1.5">{a.nombre_original && a.nombre_original !== a.nombre ? a.nombre_original : '—'}</td>
                  <td className="max-w-[16rem] break-words px-2 py-1.5">{a.drive_editores || a.drive_editor || '—'}</td>
                  <td className="max-w-[12rem] break-words px-2 py-1.5">{a.drive_dueno || '—'}</td>
                  <td className="px-2 py-1.5">{a.camara ? `${a.camara}${a.fecha_foto ? ` · ${a.fecha_foto}` : ''}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/** «2026-10-24T15:30:00Z» → «2026-10-24» y «09:30» en Ciudad de México (para los campos del formulario). */
function aLocal(iso: string | null): { fecha: string; hora: string } {
  if (!iso) return { fecha: '', hora: '' }
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value])
  )
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` }
}

/** Crear una tarea en Classroom desde la app, o editar una que la app creó. */
function FormTarea({ r, tarea, onListo }: { r: ResumenClassroom; tarea: TareaResumen | null; onListo: (ok: string) => Promise<void> }): JSX.Element {
  const inicio = aLocal(tarea?.vence ?? null)
  const [curso, setCurso] = useState(tarea?.curso_id ?? r.cursos[0]?.id ?? '')
  const [titulo, setTitulo] = useState(tarea?.titulo ?? '')
  const [descripcion, setDescripcion] = useState(tarea?.descripcion ?? '')
  const [puntos, setPuntos] = useState(tarea ? String(tarea.puntos ?? '') : '100')
  const [fecha, setFecha] = useState(inicio.fecha)
  const [hora, setHora] = useState(inicio.hora || '23:59')
  const [enlaces, setEnlaces] = useState('')
  const [archivos, setArchivos] = useState<ArchivoAdjuntado[]>([])
  const [subiendo, setSubiendo] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const enClassroom = !(tarea?.curso_id ?? curso).startsWith('app-')
  const adjuntar = async (): Promise<void> => {
    setError('')
    setSubiendo(true)
    try {
      const nuevos = await api.classroom.subirArchivosTarea()
      setArchivos((a) => [...a, ...nuevos])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubiendo(false)
    }
  }
  const guardar = async (): Promise<void> => {
    setError('')
    const p = puntos.trim() === '' ? null : Number(puntos.replace(',', '.'))
    if (p !== null && !Number.isFinite(p)) return setError('Los puntos deben ser un número.')
    const datos = { titulo, descripcion, puntos: p, vence: fecha ? `${fecha}T${hora || '23:59'}` : '' }
    setGuardando(true)
    try {
      if (tarea) await api.classroom.editarTarea(tarea.curso_id, tarea.id, { ...datos, archivos })
      else await api.classroom.crearTarea(curso, { ...datos, enlaces: enlaces.split('\n').map((x) => x.trim()).filter(Boolean), archivos })
      const local = (tarea?.curso_id ?? curso).startsWith('app-')
      await onListo(tarea ? (local ? 'Cambios guardados' : 'Cambios guardados en Classroom') : local ? 'Tarea publicada: los alumnos ya la ven en el portal' : 'Tarea publicada en Classroom: los alumnos ya la ven')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGuardando(false)
    }
  }
  return (
    <div className="space-y-3 text-sm">
      {!tarea && r.cursos.length > 1 && (
        <label className="block">
          <span className="etiqueta">Curso de Classroom</span>
          <select className="input" value={curso} onChange={(e) => setCurso(e.target.value)}>
            {r.cursos.map((c) => <option key={c.id} value={c.id}>{c.nombre}{c.seccion ? ` · ${c.seccion}` : ''}</option>)}
          </select>
        </label>
      )}
      <label className="block">
        <span className="etiqueta">Título</span>
        <input className="input" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Tarea 3 · Programación dinámica" autoFocus />
      </label>
      <label className="block">
        <span className="etiqueta">Instrucciones</span>
        <textarea className="input min-h-[8rem]" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Qué deben entregar, en qué formato y cómo se califica." />
      </label>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
        <label className="block">
          <span className="etiqueta">Puntos (vacío = sin calificar)</span>
          <input className="input" inputMode="decimal" value={puntos} onChange={(e) => setPuntos(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Fecha de entrega</span>
          <input className="input" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label className="block">
          <span className="etiqueta">Hora (Ciudad de México)</span>
          <input className="input" type="time" value={hora} onChange={(e) => setHora(e.target.value)} disabled={!fecha} />
        </label>
      </div>
      {!tarea && (
        <label className="block">
          <span className="etiqueta">Enlaces de material (uno por línea, opcional)</span>
          <textarea className="input min-h-[4rem]" value={enlaces} onChange={(e) => setEnlaces(e.target.value)} placeholder="https://…" />
          <span className="text-xs text-ink-500">Classroom solo deja agregar material al crear la tarea.</span>
        </label>
      )}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="etiqueta !mb-0">Archivos</span>
          <button type="button" className="btn-secundario" disabled={subiendo || guardando} onClick={() => void adjuntar()}>
            {subiendo ? 'Subiendo a tu Drive…' : '📎 Adjuntar archivo'}
          </button>
        </div>
        {archivos.length > 0 && (
          <ul className="space-y-1">
            {archivos.map((a) => (
              <li key={a.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-ink-200 px-2 py-1.5">
                <span aria-hidden>📎</span>
                <span className="min-w-0 flex-1 break-words">
                  {a.titulo}
                  {a.compartido === 'dominio' && <span className="block text-xs text-amber-700">Solo lo abren cuentas de la universidad (la universidad no deja compartirlo con cualquiera).</span>}
                  {a.compartido === 'no' && <span className="block text-xs text-amber-700">No se pudo compartir: en Drive dale «Cualquier persona con el enlace».</span>}
                </span>
                <button type="button" className="btn-fantasma shrink-0 px-2 text-ink-500" aria-label={`Quitar ${a.titulo}`} onClick={() => setArchivos((x) => x.filter((y) => y.id !== a.id))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-500">
          Se suben a tu Google Drive y los alumnos los abren con el enlace.
          {tarea && enClassroom ? ' Google no deja agregar material a una tarea ya publicada: el enlace de cada archivo se agrega al final de las instrucciones al guardar.' : ''}
        </p>
      </div>
      {error && <p className="break-words text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn-primario" disabled={guardando || subiendo || !titulo.trim()} onClick={() => void guardar()}>
          {guardando ? 'Guardando…' : tarea ? 'Guardar cambios' : curso.startsWith('app-') ? 'Publicar a los alumnos' : 'Publicar en Classroom'}
        </button>
      </div>
    </div>
  )
}

/** Calificar todas las entregas de una tarea creada desde la app y, si se quiere, devolvérselas a los alumnos. */
function CalificarTarea({ r, tarea, onListo }: { r: ResumenClassroom; tarea: TareaResumen; onListo: (ok: string) => Promise<void> }): JSX.Element {
  const filas = r.alumnos
    .filter((a) => a.curso_id === tarea.curso_id)
    .map((a) => ({ a, e: r.entregas.find((x) => x.alumno === a.clave && x.tarea === tarea.clave) }))
    .filter((x): x is { a: (typeof r.alumnos)[number]; e: CeldaEntrega } => !!x.e)
  const [notas, setNotas] = useState<Record<string, string>>(() => Object.fromEntries(filas.map(({ e }) => [e.entrega_id, e.calificacion == null ? '' : String(e.calificacion)])))
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const cambiadas = filas.filter(({ e }) => notas[e.entrega_id].trim() !== '' && Number(notas[e.entrega_id].replace(',', '.')) !== e.calificacion)
  const guardar = async (devolver: boolean): Promise<void> => {
    setError('')
    const lista = (devolver ? filas.filter(({ e }) => notas[e.entrega_id].trim() !== '') : cambiadas).map(({ e }) => ({ entrega_id: e.entrega_id, nota: Number(notas[e.entrega_id].replace(',', '.')) }))
    if (!lista.length) return setError('No hay calificaciones nuevas que guardar.')
    setGuardando(true)
    try {
      const x = await api.classroom.calificarEnClassroom(tarea.curso_id, tarea.id, lista, devolver)
      if (x.errores.length) setError(x.errores.join(' · '))
      else await onListo(`${x.calificadas} calificación(es) guardadas en Classroom${devolver ? ' y devueltas a los alumnos' : ''}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGuardando(false)
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-ink-600">Sobre {tarea.puntos ?? '—'} puntos. «Guardar» deja la calificación en Classroom sin que el alumno la vea; «Guardar y devolver» se la devuelve y la ve.</p>
      <div className="max-h-[55vh] overflow-auto rounded-lg border border-ink-200">
        <table className="min-w-full">
          <tbody>
            {filas.map(({ a, e }) => (
              <tr key={e.entrega_id} className="border-b border-ink-100">
                <td className="px-3 py-1.5 font-medium">{a.nombre}</td>
                <td className="px-2 py-1.5"><Estado e={e.estado} /></td>
                <td className="px-2 py-1.5">
                  <input
                    className="input w-24"
                    inputMode="decimal"
                    aria-label={`Calificación de ${a.nombre}`}
                    value={notas[e.entrega_id]}
                    onChange={(ev) => setNotas((n) => ({ ...n, [e.entrega_id]: ev.target.value }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="break-words text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-secundario" disabled={guardando || !cambiadas.length} onClick={() => void guardar(false)}>Guardar ({cambiadas.length})</button>
        <button className="btn-primario" disabled={guardando} onClick={() => void guardar(true)}>{guardando ? 'Guardando…' : 'Guardar y devolver'}</button>
      </div>
    </div>
  )
}

/** Para quién es la tarea en «Tareas» del portal y si se reciben entregas después de la fecha. */
function AjustePortal({ r, tarea, onListo }: { r: ResumenClassroom; tarea: TareaResumen; onListo: () => Promise<void> }): JSX.Element {
  const [visibilidad, setVisibilidad] = useState(tarea.portal.visibilidad)
  const [alumnos, setAlumnos] = useState<Set<number>>(() => new Set(tarea.portal.alumnos))
  const [aceptaTarde, setAceptaTarde] = useState(tarea.portal.acepta_tarde)
  const [error, setError] = useState('')
  const del = r.alumnos.filter((a) => a.curso_id === tarea.curso_id && a.alumno_id !== null)
  const guardar = async (): Promise<void> => {
    setError('')
    try {
      await api.classroom.ajustePortal(tarea.curso_id, tarea.id, { visibilidad, alumnos: [...alumnos], acepta_tarde: aceptaTarde })
      await onListo()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <fieldset className="space-y-1.5">
        <legend className="etiqueta">¿Quién la ve en «Tareas»?</legend>
        {(
          [
            ['todos', 'Todos los alumnos'],
            ['algunos', 'Solo algunos alumnos (por ejemplo, una tarea de un solo alumno)'],
            ['oculta', 'Nadie: no aparece en el portal']
          ] as const
        ).map(([v, t]) => (
          <label key={v} className="flex items-center gap-2">
            <input type="radio" name="visibilidad" checked={visibilidad === v} onChange={() => setVisibilidad(v)} /> {t}
          </label>
        ))}
      </fieldset>
      {visibilidad === 'algunos' && (
        <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-ink-200 p-2">
          {del.map((a) => (
            <label key={a.clave} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={alumnos.has(a.alumno_id!)}
                onChange={(e) => setAlumnos((s) => { const n = new Set(s); if (e.target.checked) n.add(a.alumno_id!); else n.delete(a.alumno_id!); return n })}
              />
              {a.nombre}
            </label>
          ))}
        </div>
      )}
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={aceptaTarde} onChange={(e) => setAceptaTarde(e.target.checked)} />
        <span>Aceptar entregas después de la fecha límite (si no, al vencer ya no se puede subir)</span>
      </label>
      <p className="text-xs text-ink-500">Solo cambia el portal de alumnos; Classroom no se toca. Las de recuperación se muestran solas como «Recuperación (opcional)».</p>
      {error && <p className="break-words text-red-700">{error}</p>}
      <div className="flex justify-end">
        <button className="btn-primario" disabled={visibilidad === 'algunos' && alumnos.size === 0} onClick={() => void guardar()}>Guardar</button>
      </div>
    </div>
  )
}
