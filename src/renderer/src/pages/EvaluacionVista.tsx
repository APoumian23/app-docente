import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type MateriaDetalle } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Markdown from '../components/Markdown'
import { avisar } from '../components/Aviso'
import ModalPassword from '../components/ModalPassword'
import Menu from '../components/Menu'
import { Buscador, Conteo, EncabezadoOrden, Segmentado, SinResultados, coincide, ordenNatural, type Orden } from '../components/Filtros'
import { useRecordado } from '../lib/recordado'
import { diaMx, fmtFechaCorta, hoyIso } from '../lib/tiempo'
import type { Alumno, ContenidoEvaluacion, Evaluacion, Resultado } from '@shared/types'

/** PIN de la última partida en vivo de cada evaluación: si se cierra la ventana del juego, se puede volver a abrir. */
const clavePartida = (evId: number): string => `docente.partida.${evId}`
const VIDA_PARTIDA_MS = 4 * 3600_000
function leerPartida(evId: number): string | null {
  try {
    const p = JSON.parse(localStorage.getItem(clavePartida(evId)) ?? 'null') as { pin: string; creada: number } | null
    return p && Date.now() - p.creada < VIDA_PARTIDA_MS ? p.pin : null
  } catch {
    return null
  }
}

export default function EvaluacionVista(): JSX.Element {
  const { id } = useParams()
  const nav = useNavigate()
  const [ev, setEv] = useState<Evaluacion | null>(null)
  const [materia, setMateria] = useState<MateriaDetalle | null>(null)
  const [resultados, setResultados] = useState<Resultado[]>([])
  // Siempre arranca sin la clave a la vista: la pantalla puede estar proyectada
  const [conRespuestas, setConRespuestas] = useState(false)
  const [modo, setModo] = useState<'ver' | 'resultados' | 'editar'>('ver')
  const [editor, setEditor] = useState('')
  const [fecha, setFecha] = useState('')
  const [borrar, setBorrar] = useState<string | null>(null) // advertencia del modal de contraseña
  const [noExiste, setNoExiste] = useState(false)
  const [pin, setPin] = useState<string | null>(null)
  const [generandoJuego, setGenerandoJuego] = useState(false)
  useEffect(() => setPin(leerPartida(Number(id))), [id])

  const cargar = async (): Promise<void> => {
    const e = await api.evaluaciones.obtener(Number(id))
    // Enlace viejo o evaluación borrada: se dice claro en vez de un error técnico
    setNoExiste(!e)
    if (!e) return
    setEv(e)
    setConRespuestas(false)
    setEditor(e.contenido)
    setFecha(e.fecha_aplicacion ?? '')
    const [m, r] = await Promise.all([api.materias.obtener(e.materia_id), api.evaluaciones.resultados(e.id)])
    setMateria(m)
    setResultados(r)
  }
  const [error, setError] = useState('')
  useEffect(() => {
    setError('')
    cargar().catch((e) => setError((e as Error).message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const esJson = useMemo(() => !!ev && ev.contenido.trim().startsWith('{'), [ev])
  const contenido = useMemo<ContenidoEvaluacion | null>(() => {
    if (!ev || !esJson) return null
    try {
      const c = JSON.parse(ev.contenido)
      return 'preguntas' in c ? (c as ContenidoEvaluacion) : null
    } catch {
      return null
    }
  }, [ev, esJson])
  const otroJson = useMemo(() => (ev && esJson && !contenido ? JSON.parse(ev.contenido) : null), [ev, esJson, contenido])

  if (noExiste)
    return (
      <div className="p-8">
        <div className="tarjeta max-w-md p-6">
          <h1 className="text-lg font-semibold text-ink-900">Esa evaluación ya no existe</h1>
          <p className="mt-1 text-sm text-ink-500">Puede que se haya borrado o que el enlace sea viejo.</p>
          <Link to="/materias" className="btn-primario mt-4">Ir a Materias</Link>
        </div>
      </div>
    )
  if (error && (!ev || !materia)) return <div className="p-8 text-red-600">No se pudo abrir la evaluación: {error}</div>
  if (!ev || !materia) return <div className="p-8 text-ink-500">Cargando…</div>

  const guardarEdicion = async (): Promise<void> => {
    let puntos = ev.puntos_totales
    if (esJson) {
      try {
        const c = JSON.parse(editor)
        if (c.preguntas) puntos = c.preguntas.reduce((s: number, p: { puntos: number }) => s + (p.puntos || 0), 0)
      } catch {
        return avisar('El JSON no es válido', 'error')
      }
    }
    await api.evaluaciones.guardar({ id: ev.id, titulo: ev.titulo, contenido: editor, fecha_aplicacion: fecha || null, puntos_totales: puntos })
    avisar('Guardado')
    setModo('ver')
    cargar()
  }
  const guardarResultado = async (alumnoId: number, cambios: Partial<Resultado>): Promise<void> => {
    const actual = resultados.find((r) => r.alumno_id === alumnoId)
    await api.evaluaciones.guardarResultado({ evaluacion_id: ev.id, alumno_id: alumnoId, puntaje: actual?.puntaje ?? null, estado: actual?.estado ?? 'pendiente', fecha_entrega: actual?.fecha_entrega ?? null, comentario: actual?.comentario ?? '', ...cambios })
    setResultados(await api.evaluaciones.resultados(ev.id))
  }
  const exportar = async (f: 'pdf' | 'docx', clave: boolean): Promise<void> => {
    const r = await api.exportar.evaluacion(ev.id, f, clave)
    if (r) avisar(`Exportado: ${r.split('/').pop()}`)
  }
  const letras = 'abcdefgh'
  const esContestable = ev.tipo !== 'presentacion' && ev.tipo !== 'plan_sesion' && ev.tipo !== 'glosario'
  const jugable = !!contenido && !contenido.preguntas.some((p) => p.tipo === 'cuaderno') && contenido.preguntas.some((p) => p.tipo === 'opcion_multiple' || p.tipo === 'verdadero_falso')
  // Lo que no se puede jugar tal cual (examen oral, preguntas abiertas, una clase, apuntes…) se convierte en juego con IA
  const convertibleEnJuego = !jugable && !otroJson && ev.tipo !== 'glosario' && ev.contenido.trim().length > 0
  const generarJuego = async (): Promise<void> => {
    setGenerandoJuego(true)
    try {
      const nuevo = await api.ia.generarJuego(ev.id)
      avisar(`Juego listo: «${nuevo.titulo}». Revísalo y pulsa Jugar en vivo.`)
      nav(`/evaluacion/${nuevo.id}`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setGenerandoJuego(false)
    }
  }
  /** Abre el panel web del docente ya autenticado en la pantalla de publicación de esta evaluación. */
  const publicar = async (): Promise<void> => {
    try {
      // Dentro de la app: la página «Panel del portal» en la pantalla de publicar
      nav(`/panel?ruta=${encodeURIComponent(`/docente/publicar/${ev.materia_id}?evaluacion=${ev.id}`)}`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const reabrirPartida = async (): Promise<void> => {
    if (!pin) return
    try {
      await api.portal.abrirPanel(`/docente/juego/${pin}`, true)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const olvidarPartida = (): void => {
    setPin(null)
    try {
      localStorage.removeItem(clavePartida(ev.id))
    } catch {
      /* nada que limpiar */
    }
  }
  const jugar = async (): Promise<void> => {
    try {
      const nuevo = await api.portal.jugar(ev.id)
      // El PIN queda a la vista (no solo en el aviso): si se cierra la ventana del juego se puede volver a abrir
      setPin(nuevo)
      try {
        localStorage.setItem(clavePartida(ev.id), JSON.stringify({ pin: nuevo, creada: Date.now() }))
      } catch {
        /* sin almacenamiento: el PIN se ve mientras siga en esta pantalla */
      }
      avisar(`Partida creada. PIN: ${nuevo}. Los alumnos entran en el portal › Jugar`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  // Sin datos ligados basta confirmar; si se llevaría calificaciones o entregas del portal, pide la contraseña
  const eliminar = async (): Promise<void> => {
    try {
      const i = await api.evaluaciones.impacto(ev.id)
      const partes = [
        i.calificaciones && `${i.calificaciones} calificación${i.calificaciones === 1 ? '' : 'es'} capturada${i.calificaciones === 1 ? '' : 's'}`,
        i.publicaciones && `${i.publicaciones} publicación${i.publicaciones === 1 ? '' : 'es'} en el portal`,
        i.entregas && `${i.entregas} entrega${i.entregas === 1 ? '' : 's'} de alumnos`
      ].filter(Boolean)
      if (partes.length) return setBorrar(`Se borran también ${partes.join(', ')}. Esta acción no se puede deshacer.`)
      if (!confirm('¿Eliminar esta evaluación?')) return
      await api.evaluaciones.eliminar(ev.id)
      nav(`/materias/${ev.materia_id}`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  return (
    <div>
      <Encabezado
        titulo={ev.titulo}
        sub={<span><Link to={`/materias/${ev.materia_id}`} className="hover:underline">{materia.nombre}</Link> · {ev.tipo.replace('_', ' ')} · {ev.puntos_totales ? `${ev.puntos_totales} pts · ` : ''}creado el {fmtFechaCorta(diaMx(ev.creado) || hoyIso())}{ev.fecha_aplicacion ? ` · se aplica el ${fmtFechaCorta(ev.fecha_aplicacion)}` : ''}</span>}
        acciones={
          <>
            {(modo !== 'editar') && <>
              <button className="btn-secundario" onClick={() => setModo('editar')}>Editar</button>
              {esContestable && contenido && <>
                <div className="w-px h-6 bg-ink-200 mx-1" />
                <button className="btn-secundario" title="Publicarla a toda la materia, a una carrera o a alumnos elegidos (se abre aquí mismo, en la ventana del panel)" onClick={publicar}>Publicar a alumnos</button>
                {jugable && <button className="btn-secundario" title="Concurso en vivo tipo Kahoot" onClick={jugar}>Jugar en vivo</button>}
              </>}
              {convertibleEnJuego && (
                <button className="btn-secundario" title="Con IA crea un cuestionario de opción múltiple sobre este contenido, listo para jugarlo en vivo (se guarda aparte en la misma materia)" onClick={generarJuego} disabled={generandoJuego}>
                  {generandoJuego ? 'Generando juego…' : '🎮 Generar juego en vivo'}
                </button>
              )}
              <div className="w-px h-6 bg-ink-200 mx-1" />
              {/* Las cuatro exportaciones van en un menú: con el texto ampliado la cabecera ya no se come la pantalla */}
              <Menu
                etiqueta="Exportar"
                opciones={[
                  { t: 'PDF', onClick: () => exportar('pdf', false) },
                  ...(contenido ? [{ t: 'PDF + clave', onClick: () => exportar('pdf', true) }] : []),
                  { t: 'Word', onClick: () => exportar('docx', false) },
                  ...(contenido ? [{ t: 'Word + clave', onClick: () => exportar('docx', true) }] : [])
                ]}
              />
            </>}
            <button className="btn-peligro" onClick={eliminar}>Eliminar</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-5">
        {/* Contenido o entregas: lo que se ve de la evaluación (editar va arriba, con las demás acciones) */}
        {modo !== 'editar' && esContestable && (
          <div className="mb-4">
            <Segmentado
              etiqueta="Qué ver"
              valor={modo}
              onCambio={setModo}
              opciones={[
                { valor: 'ver', texto: contenido ? `Preguntas (${contenido.preguntas.length})` : 'Contenido' },
                { valor: 'resultados', texto: 'Entregas y calificaciones' }
              ]}
            />
          </div>
        )}
        {pin && (
          <div className="tarjeta mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-brand-200 bg-brand-50/40 px-4 py-3" role="status">
            <div className="min-w-0 flex-1">
              <div className="etiqueta">Partida en vivo</div>
              <div className="text-sm text-ink-600">
                PIN <span className="font-mono text-2xl font-bold tracking-widest text-ink-900 align-middle">{pin}</span> · los alumnos entran en el portal › Jugar
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primario" onClick={reabrirPartida}>Abrir la partida otra vez</button>
              <button className="btn-fantasma" onClick={olvidarPartida} title="Quitar este aviso">Ocultar</button>
            </div>
          </div>
        )}
        {modo === 'editar' && (
          <div className="tarjeta p-5 space-y-3">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
              <label><span className="etiqueta">Título</span><input className="input" value={ev.titulo} onChange={(e) => setEv({ ...ev, titulo: e.target.value })} /></label>
              <label><span className="etiqueta">Fecha de aplicación / entrega</span><input type="date" className="input" value={fecha} onChange={(e) => setFecha(e.target.value)} /></label>
            </div>
            <label><span className="etiqueta">{esJson ? 'Contenido (JSON)' : 'Contenido (markdown)'}</span><textarea rows={24} className="input font-mono text-xs" value={editor} onChange={(e) => setEditor(e.target.value)} /></label>
            <div className="flex justify-end gap-2"><button className="btn-secundario" onClick={() => setModo('ver')}>Cancelar</button><button className="btn-primario" onClick={guardarEdicion}>Guardar</button></div>
          </div>
        )}

        {modo === 'ver' && contenido && (
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="min-w-0 flex-[1_1_18rem]">
                <p className="text-sm text-ink-700">{contenido.instrucciones}</p>
                <p className="text-xs text-ink-500">{contenido.preguntas.length} {contenido.preguntas.length === 1 ? 'pregunta' : 'preguntas'} · {contenido.preguntas.reduce((x, q) => x + (q.puntos || 0), 0)} pts · duración sugerida {contenido.duracion_min} min</p>
              </div>
              <label className={`text-sm flex items-center gap-2 rounded-lg px-2 py-1 ${conRespuestas ? 'bg-amber-50 text-amber-800' : ''}`} title={conRespuestas ? 'Cuidado si estás proyectando' : ''}>
                <input type="checkbox" checked={conRespuestas} onChange={(e) => setConRespuestas(e.target.checked)} />
                {conRespuestas ? 'Respuestas a la vista' : 'Mostrar respuestas'}
              </label>
            </div>
            <ol className="space-y-4">
              {contenido.preguntas.map((p, i) => (
                <li key={i} className="tarjeta p-4">
                  <div className="flex flex-wrap gap-2">
                    <span className="font-bold">{i + 1}.</span>
                    <div className="flex-[1_1_16rem] min-w-0">
                      <Markdown texto={p.enunciado} />
                      {p.tipo === 'cuaderno' && (
                        <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-700">
                          <div className="font-medium text-ink-900">Cuaderno de Jupyter</div>
                          <div className="text-xs text-ink-500">
                            {resumenCuaderno(p.cuaderno)} · {p.paquetes ? 'puede usar numpy, pandas, matplotlib…' : 'solo Python puro (biblioteca estándar)'}
                          </div>
                          <div className="mt-1 text-xs text-ink-500">El alumno lo resuelve en el portal; al publicarlo elige la duración y la vigilancia. Se califica a mano al revisar cada entrega.</div>
                        </div>
                      )}
                      {(p.opciones?.length ?? 0) > 0 && <ol className="mt-2 space-y-1">{p.opciones!.map((o, j) => <li key={j} className="flex gap-2"><span className="text-ink-400">{letras[j]})</span><Markdown texto={o} className="!text-sm" /></li>)}</ol>}
                      {conRespuestas && p.tipo !== 'cuaderno' && (
                        <div className="mt-3 rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm">
                          <b>Respuesta:</b> <Markdown texto={p.respuesta} className="inline !text-sm" />
                          {p.explicacion && <div className="text-ink-600 mt-1"><Markdown texto={p.explicacion} className="!text-sm" /></div>}
                        </div>
                      )}
                    </div>
                    <span className="chip h-fit whitespace-nowrap bg-ink-100 text-ink-600">{p.puntos} pts · {TIPO_PREGUNTA[p.tipo] ?? p.tipo.replace('_', ' ')}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {modo === 'ver' && otroJson && ev.tipo === 'plan_sesion' && (
          <div className="max-w-3xl tarjeta p-5">
            <h3 className="text-lg font-semibold">{otroJson.tema}</h3>
            <p className="text-ink-600 mb-4">{otroJson.objetivo}</p>
            <ol className="space-y-2">
              {(otroJson.actividades as { nombre: string; tipo: string; duracion_min: number; descripcion: string }[]).map((a, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 inline-flex h-6 w-12 shrink-0 items-center justify-center rounded-md bg-ink-100 font-mono text-xs text-ink-700">{a.duracion_min}′</span>
                  <div className="min-w-0"><div className="font-medium">{a.nombre} <span className="whitespace-nowrap text-xs text-ink-400">{a.tipo}</span></div><div className="text-sm text-ink-600">{a.descripcion}</div></div>
                </li>
              ))}
            </ol>
            <p className="text-xs text-ink-500 mt-4">Para aplicarlo: en la materia, abre una sesión y elige “Aplicar plan generado con IA”.</p>
          </div>
        )}
        {modo === 'ver' && otroJson && ev.tipo === 'glosario' && (
          <div className="max-w-3xl tarjeta divide-y divide-ink-100">
            {(otroJson.terminos as { termino: string; definicion: string; ejemplo: string }[]).map((t, i) => <div key={i} className="px-4 py-3"><b>{t.termino}</b><div className="text-sm text-ink-700">{t.definicion}</div><div className="text-xs text-ink-500 mt-1">Ej.: {t.ejemplo}</div></div>)}
            <p className="text-xs text-ink-500 px-4 py-3">Estos términos ya se agregaron al glosario de la materia.</p>
          </div>
        )}
        {modo === 'ver' && !esJson && (
          <div className="max-w-3xl tarjeta p-6">
            {ev.tipo === 'presentacion' && <p className="text-xs text-ink-500 mb-3">Diapositivas separadas por “---”. Se proyectan desde Modo clase → Presentación.</p>}
            <Markdown texto={ev.contenido} />
          </div>
        )}

        {modo === 'resultados' && <TablaResultados key={ev.id} ev={ev} alumnos={materia.alumnos} resultados={resultados} onGuardar={guardarResultado} />}
      </div>
      <ModalPassword
        abierto={borrar !== null}
        titulo={`Eliminar ${ev.titulo}`}
        advertencia={borrar ?? ''}
        textoBoton="Eliminar evaluación"
        onCerrar={() => setBorrar(null)}
        onConfirmar={async (password) => {
          await api.evaluaciones.eliminar(ev.id, password)
          nav(`/materias/${ev.materia_id}`)
        }}
      />
    </div>
  )
}

const TIPO_PREGUNTA: Record<string, string> = {
  opcion_multiple: 'opción múltiple',
  abierta: 'abierta',
  verdadero_falso: 'verdadero o falso',
  problema: 'problema',
  codigo: 'código',
  cuaderno: 'cuaderno de Jupyter'
}

/** Resumen de un cuaderno de Jupyter (pregunta «cuaderno»): cuántas celdas trae y de qué tipo. */
function resumenCuaderno(texto?: string): string {
  try {
    const celdas = (JSON.parse(texto ?? '') as { cells: { cell_type: string }[] }).cells
    const codigo = celdas.filter((c) => c.cell_type === 'code').length
    return `${celdas.length} celdas · ${codigo} de código · ${celdas.length - codigo} de texto`
  } catch {
    return 'El cuaderno no se pudo leer'
  }
}

// ---------------- Entregas y calificaciones ----------------
type EstadoRes = Resultado['estado']
const ESTADO_RESULTADO: Record<EstadoRes, { texto: string; tono: string }> = {
  pendiente: { texto: 'Pendiente', tono: 'text-ink-500' },
  entregado: { texto: 'Entregado', tono: 'text-sky-700' },
  calificado: { texto: 'Calificado', tono: 'text-green-700' },
  no_entregado: { texto: 'No entregado', tono: 'text-red-700' }
}
const ESTADOS_RESULTADO = Object.keys(ESTADO_RESULTADO) as EstadoRes[]
type CampoRes = 'alumno' | 'entrega' | 'puntaje'

/**
 * Captura de entregas y puntajes de una evaluación, con búsqueda, filtro por estado y orden. Quién
 * aparece se decide al cambiar los filtros, no con cada captura: con «Pendientes» elegido, el alumno
 * no se esfuma de la tabla mientras se le escribe el puntaje.
 */
function TablaResultados({ ev, alumnos, resultados, onGuardar }: { ev: Evaluacion; alumnos: Alumno[]; resultados: Resultado[]; onGuardar: (alumnoId: number, cambios: Partial<Resultado>) => Promise<void> }): JSX.Element {
  const clave = `evaluacion.${ev.id}.entregas`
  const [busqueda, setBusqueda] = useRecordado(`${clave}.busqueda`, '')
  const [estadoF, setEstadoF] = useRecordado<EstadoRes | 'todos'>(`${clave}.estado`, 'todos')
  const [orden, setOrden] = useRecordado<Orden<CampoRes>>(`${clave}.orden`, { campo: 'alumno', dir: 1 })
  const resultadoDe = (id: number): Resultado | undefined => resultados.find((x) => x.alumno_id === id)
  const estadoDe = (id: number): EstadoRes => resultadoDe(id)?.estado ?? 'pendiente'
  const nombre = (a: Alumno): string => `${a.apellidos} ${a.nombre}`.trim()
  const buscados = alumnos.filter((a) => coincide(busqueda, a.matricula, a.nombre, a.apellidos))
  const claveAlumnos = alumnos.map((a) => a.id).join(',')
  const lista = useMemo(() => {
    // Sin dato va al final en ambos sentidos
    const valor = (a: Alumno): string | number | null => (orden.campo === 'puntaje' ? (resultadoDe(a.id)?.puntaje ?? null) : orden.campo === 'entrega' ? (resultadoDe(a.id)?.fecha_entrega ?? null) : null)
    return buscados
      .filter((a) => estadoF === 'todos' || estadoDe(a.id) === estadoF)
      .sort((a, b) => {
        if (orden.campo !== 'alumno') {
          const x = valor(a)
          const y = valor(b)
          if (x == null || y == null) {
            if (x != null || y != null) return x == null ? 1 : -1
          } else if (x !== y) return orden.dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)))
          return ordenNatural(nombre(a), nombre(b))
        }
        return orden.dir * ordenNatural(nombre(a), nombre(b))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda, estadoF, orden, claveAlumnos])
  const hayFiltro = !!busqueda.trim() || estadoF !== 'todos'
  const quitarFiltros = (): void => {
    setBusqueda('')
    setEstadoF('todos')
  }
  const calificados = resultados.filter((r) => alumnos.some((a) => a.id === r.alumno_id) && r.puntaje != null)
  const promedio = calificados.length ? calificados.reduce((x, r) => x + (r.puntaje ?? 0), 0) / calificados.length : null

  return (
    <div className="space-y-3">
      {alumnos.length > 0 && (
        <div className="space-y-2" role="search" aria-label="Filtrar entregas">
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por matrícula o nombre" etiqueta="Buscar alumnos" />
            <Segmentado
              etiqueta="Estado de la entrega"
              valor={estadoF}
              onCambio={setEstadoF}
              opciones={[
                { valor: 'todos' as const, texto: 'Todos', conteo: buscados.length },
                ...ESTADOS_RESULTADO.map((k) => ({ valor: k, texto: ESTADO_RESULTADO[k].texto, conteo: buscados.filter((a) => estadoDe(a.id) === k).length }))
              ]}
            />
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            <span className="whitespace-nowrap">{calificados.length} de {alumnos.length} con puntaje</span>
            {promedio != null && <span className="whitespace-nowrap">· promedio {(Math.round(promedio * 10) / 10).toFixed(1)}{ev.puntos_totales ? ` de ${ev.puntos_totales}` : ''}</span>}
            <Conteo visibles={lista.length} total={alumnos.length} nombre="alumnos" hayFiltro={hayFiltro} />
          </div>
        </div>
      )}
      <div className="tarjeta overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
            <tr>
              <EncabezadoOrden campo="alumno" orden={orden} onOrden={setOrden}>Alumno</EncabezadoOrden>
              <th className="px-3 py-2">Estado</th>
              <EncabezadoOrden campo="entrega" orden={orden} onOrden={setOrden}>Entrega</EncabezadoOrden>
              <EncabezadoOrden campo="puntaje" orden={orden} onOrden={setOrden} className="whitespace-nowrap">{`Puntaje / ${ev.puntos_totales}`}</EncabezadoOrden>
              <th className="px-3 py-2">Comentario</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {lista.map((a) => {
              const r = resultadoDe(a.id)
              const estado = r?.estado ?? 'pendiente'
              return (
                <tr key={a.id} className="hover:bg-ink-50/70">
                  <td className="px-3 py-2"><Link to={`/alumnos/${a.id}`} className="font-medium text-ink-900 hover:underline">{nombre(a)}</Link><div className="text-xs text-ink-400 font-mono">{a.matricula}</div></td>
                  <td className="px-3 py-2">
                    <select className={`input w-36 ${ESTADO_RESULTADO[estado].tono}`} aria-label={`Estado de la entrega de ${nombre(a)}`} value={estado} onChange={(e) => onGuardar(a.id, { estado: e.target.value as Resultado['estado'], fecha_entrega: e.target.value === 'entregado' || e.target.value === 'calificado' ? (r?.fecha_entrega ?? hoyIso()) : r?.fecha_entrega ?? null })}>
                      {ESTADOS_RESULTADO.map((s) => <option key={s} value={s}>{ESTADO_RESULTADO[s].texto}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2"><input type="date" className="input w-40" aria-label={`Fecha de entrega de ${nombre(a)}`} value={r?.fecha_entrega ?? ''} onChange={(e) => onGuardar(a.id, { fecha_entrega: e.target.value || null })} /></td>
                  <td className="px-3 py-2"><input type="number" step="0.5" className="input w-24" aria-label={`Puntaje de ${nombre(a)}`} value={r?.puntaje ?? ''} onChange={(e) => onGuardar(a.id, { puntaje: e.target.value === '' ? null : Number(e.target.value), estado: e.target.value === '' ? (r?.estado ?? 'pendiente') : 'calificado' })} /></td>
                  <td className="px-3 py-2 min-w-[12rem]"><input className="input" aria-label={`Comentario para ${nombre(a)}`} defaultValue={r?.comentario ?? ''} onBlur={(e) => e.target.value !== (r?.comentario ?? '') && onGuardar(a.id, { comentario: e.target.value })} /></td>
                </tr>
              )
            })}
            {lista.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <SinResultados hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay alumnos inscritos en la materia." />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
