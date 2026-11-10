import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type MateriaDetalle } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Markdown from '../components/Markdown'
import { diaMx } from '../lib/tiempo'
import { avisar } from '../components/Aviso'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, SinResultados, coincide, ordenNatural } from '../components/Filtros'
import type { GeneracionIA, Materia, TipoEvaluacion } from '@shared/types'

const TIPOS: { v: TipoEvaluacion; t: string; d: string; cantidad: string }[] = [
  { v: 'diagnostico', t: 'Examen diagnóstico', d: 'Mide los conocimientos previos que exige la materia. No pondera.', cantidad: 'reactivos' },
  { v: 'examen', t: 'Examen', d: 'Parcial o final con reactivos mixtos y clave de respuestas.', cantidad: 'reactivos' },
  { v: 'examen_sorpresa', t: 'Examen sorpresa', d: 'Quiz corto de 10–15 min para aplicar ahora mismo.', cantidad: 'reactivos' },
  { v: 'examen_oral', t: 'Examen sorpresa oral', d: 'Preguntas para hacer en voz alta y responder al momento.', cantidad: 'preguntas' },
  { v: 'cuestionario', t: 'Cuestionario', d: 'Preguntas de repaso y comprensión.', cantidad: 'preguntas' },
  { v: 'tarea', t: 'Tarea', d: 'Actividad para entregar con puntos por reactivo.', cantidad: 'reactivos' },
  { v: 'ejercicios', t: 'Ejercicios', d: 'Serie de problemas para resolver en clase.', cantidad: 'ejercicios' },
  { v: 'ejemplos', t: 'Ejemplos resueltos', d: 'Paso a paso, con errores comunes.', cantidad: 'ejemplos' },
  { v: 'glosario', t: 'Glosario', d: 'Términos con definición y ejemplo. Se guardan en la materia.', cantidad: 'términos' },
  { v: 'material_apoyo', t: 'Material de apoyo', d: 'Resumen didáctico + recursos y software recomendado.', cantidad: 'secciones' },
  { v: 'plan_sesion', t: 'Plan de sesión', d: 'Actividades cronometradas para aplicar al reloj de clase.', cantidad: 'minutos totales' },
  { v: 'presentacion', t: 'Presentación', d: 'Diapositivas en markdown para proyectar en Modo clase.', cantidad: 'diapositivas' },
  { v: 'clase_completa', t: 'Clase completa', d: 'Guion con el contenido, ejemplos, actividad y cierre, más un cuestionario para jugar en vivo.', cantidad: 'minutos de clase' },
  { v: 'apuntes', t: 'Apuntes para el alumno', d: 'El tema, la unidad o todo el temario explicado a fondo para estudiar solo: ejemplos, ejercicios y sus soluciones.', cantidad: 'ejercicios propuestos' }
]

/** Nombre legible de un tipo («examen_sorpresa» → «Examen sorpresa»). */
const nombreTipo = (v: string): string => TIPOS.find((t) => t.v === v)?.t ?? v.replace(/_/g, ' ')

type OrdenGenerado = 'recientes' | 'antiguos' | 'az'
const ORDENES: [OrdenGenerado, string][] = [['recientes', 'Más recientes'], ['antiguos', 'Más antiguos'], ['az', 'Título (A–Z)']]

/** Textos en los que tiene sentido verificar en internet (las evaluaciones se basan solo en el temario). */
const TIPOS_TEXTO: GeneracionIA['tipo'][] = ['material_apoyo', 'ejemplos', 'presentacion', 'clase_completa', 'apuntes']

export default function EstudioIA(): JSX.Element {
  const { materiaId } = useParams()
  const nav = useNavigate()
  const [materias, setMaterias] = useState<Materia[]>([])
  const [sel, setSel] = useState<number>(Number(materiaId) || 0)
  const [detalle, setDetalle] = useState<MateriaDetalle | null>(null)
  const [disponible, setDisponible] = useState<boolean | null>(null)
  const [req, setReq] = useState<Omit<GeneracionIA, 'materia_id'>>({ tipo: 'examen_sorpresa', tema: '', dificultad: 'intermedio', cantidad: 5, instrucciones: '', usar_materiales: true })
  const [cargando, setCargando] = useState(false)
  const [segundos, setSegundos] = useState(0)
  const [cantidadTexto, setCantidadTexto] = useState('5')
  const fijarCantidad = (texto: string): void => {
    setCantidadTexto(texto.replace(/\D/g, '').slice(0, 3))
    const n = parseInt(texto, 10)
    if (Number.isFinite(n) && n > 0) setReq((r) => ({ ...r, cantidad: n }))
  }
  const elegirTipo = (t: (typeof TIPOS)[number]): void => {
    const cantidad = t.v === 'plan_sesion' ? 120 : t.v === 'clase_completa' ? 90 : t.v === 'glosario' ? 15 : t.v === 'presentacion' ? 14 : t.v === 'apuntes' ? 10 : t.v === 'diagnostico' ? 20 : t.v === 'examen_oral' ? 8 : 5
    setReq((r) => ({ ...r, tipo: t.v, cantidad }))
    setCantidadTexto(String(cantidad))
  }
  const [pregunta, setPregunta] = useState('')
  // El motivo de un fallo se queda a la vista (el aviso flotante desaparece)
  const [errorGen, setErrorGen] = useState('')
  const [respuesta, setRespuesta] = useState('')
  const [preguntando, setPreguntando] = useState(false)
  // Filtros de lo generado: se recuerdan al abrir algo y regresar
  const [busqueda, setBusqueda] = useRecordado('estudio.busqueda', '')
  const [tipoF, setTipoF] = useRecordado<TipoEvaluacion | ''>('estudio.tipo', '')
  const [orden, setOrden] = useRecordado<OrdenGenerado>('estudio.orden', 'recientes')
  // Generar tarda; si el docente ya se fue a otra pantalla (p. ej. Modo clase) no se le saca de ahí
  const montada = useRef(true)
  useEffect(() => {
    montada.current = true
    return () => {
      montada.current = false
    }
  }, [])

  useEffect(() => {
    api.materias.listar().then((todas) => {
      // Las materias ocultas no se ofrecen para generar material, salvo la que ya viene elegida
      // (se llega desde una materia oculta): así el selector coincide con «Generado para…»
      const ms = todas.filter((m) => !m.oculta || m.id === sel)
      setMaterias(ms)
      if (!sel && ms[0]) setSel(ms[0].id)
    })
    api.ia.disponible().then(setDisponible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (sel) api.materias.obtener(sel).then(setDetalle)
  }, [sel])

  // Unidades (## …) con sus temas (- …), en el orden del temario, para elegir de una lista
  const unidades = useMemo(() => {
    const grupos: { unidad: string; temas: string[] }[] = []
    for (const l of detalle?.temario.match(/^(##\s+.+|-\s+.+)$/gm) ?? []) {
      if (l.startsWith('##')) grupos.push({ unidad: l.replace(/^##\s+/, '').trim(), temas: [] })
      else {
        if (!grupos.length) grupos.push({ unidad: 'Temario', temas: [] })
        grupos[grupos.length - 1].temas.push(l.replace(/^-\s+/, '').trim())
      }
    }
    // Secciones como «Modelo de trabajo» o «Evaluación oficial» no son temas de clase: si hay unidades, solo esas
    const soloUnidades = grupos.filter((g) => /^unidad\b/i.test(g.unidad))
    return soloUnidades.length ? soloUnidades : grupos
  }, [detalle])
  const enLista = !req.tema || unidades.some((g) => g.unidad === req.tema || g.temas.includes(req.tema))
  const tipoSel = TIPOS.find((t) => t.v === req.tipo)!

  const generados = detalle?.evaluaciones ?? []
  const porBusqueda = generados.filter((e) => coincide(busqueda, e.titulo, nombreTipo(e.tipo)))
  const tiposPresentes = useMemo(() => {
    const n = new Map<TipoEvaluacion, number>()
    for (const e of porBusqueda) n.set(e.tipo, (n.get(e.tipo) ?? 0) + 1)
    // El tipo elegido sigue a la vista aunque esta materia no tenga ninguno, para poder quitarlo
    if (tipoF && !n.has(tipoF)) n.set(tipoF, 0)
    return [...n.entries()].sort((a, b) => b[1] - a[1] || ordenNatural(nombreTipo(a[0]), nombreTipo(b[0])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generados, busqueda, tipoF])
  const listaGenerados = useMemo(() => {
    const l = porBusqueda.filter((e) => !tipoF || e.tipo === tipoF)
    if (orden === 'az') return l.sort((a, b) => ordenNatural(a.titulo, b.titulo))
    // A igual fecha, lo último que se generó va primero (o al final, en «más antiguos»)
    return l.sort((a, b) => (orden === 'antiguos' ? 1 : -1) * ((a.creado ?? '').localeCompare(b.creado ?? '') || a.id - b.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generados, busqueda, tipoF, orden])
  const hayFiltro = !!busqueda.trim() || tipoF !== ''
  const quitarFiltros = (): void => {
    setBusqueda('')
    setTipoF('')
  }

  const generar = async (): Promise<void> => {
    if (!sel) return
    setErrorGen('')
    setCargando(true)
    setSegundos(0)
    const reloj = window.setInterval(() => setSegundos((s) => s + 1), 1000)
    try {
      const ev = await api.ia.generar({ ...req, materia_id: sel })
      if (montada.current) {
        avisar('Generado y guardado en la materia')
        nav(`/evaluacion/${ev.id}`)
      } else {
        const materia = materias.find((m) => m.id === sel)?.nombre ?? 'la materia'
        avisar(`«${ev.titulo}» quedó listo en ${materia} › Evaluaciones y tareas`)
      }
    } catch (e) {
      avisar((e as Error).message, 'error')
      setErrorGen((e as Error).message)
    } finally {
      window.clearInterval(reloj)
      setCargando(false)
    }
  }
  const preguntar = async (): Promise<void> => {
    if (!sel || !pregunta.trim()) return
    setPreguntando(true)
    setRespuesta('')
    try {
      setRespuesta(await api.ia.preguntar(sel, pregunta))
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setPreguntando(false)
    }
  }

  return (
    <div>
      <Encabezado titulo="Estudio IA" sub="Genera exámenes, tareas, ejercicios, glosarios, planes de sesión y presentaciones a partir del temario y tus materiales." />
      <div className="px-4 sm:px-8 py-5">
        {disponible === false && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Falta configurar la IA. Elige proveedor y pega tu API key en <Link to="/ajustes" className="underline font-medium">Ajustes</Link>. Con NVIDIA hay créditos gratuitos.
          </div>
        )}
        <div className="flex flex-wrap items-start gap-6">
          <div className="space-y-5 min-w-0 flex-[999_1_28rem]">
            <div className="tarjeta p-5 space-y-4">
              <label><span className="etiqueta">Materia</span>
                <select className="input" value={sel} onChange={(e) => setSel(Number(e.target.value))}>{materias.map((m) => <option key={m.id} value={m.id}>{m.nombre} · {m.carrera_nombre}{m.oculta ? ' (oculta)' : ''}</option>)}</select>
              </label>
              <div>
                <span className="etiqueta">¿Qué generamos?</span>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2 mt-1">
                  {TIPOS.map((t) => (
                    <button key={t.v} type="button" aria-pressed={req.tipo === t.v} onClick={() => elegirTipo(t)} className={`text-left rounded-lg border px-3 py-2 transition-colors ${req.tipo === t.v ? 'border-brand-500 bg-brand-500/5 ring-1 ring-brand-500' : 'border-ink-200 hover:bg-ink-50'}`}>
                      <div className={`font-medium text-sm ${req.tipo === t.v ? 'text-brand-600' : 'text-ink-900'}`}>{t.t}</div>
                      <div className="text-xs text-ink-500 leading-snug">{t.d}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                <label className="col-span-full"><span className="etiqueta">Tema o unidad</span>
                  <select className="input" value={req.tema} onChange={(e) => setReq({ ...req, tema: e.target.value })}>
                    <option value="">Todo el temario</option>
                    {/* Un tema que ya no está en el temario (p. ej. de una generación anterior) se conserva visible */}
                    {!enLista && <option value={req.tema}>{req.tema}</option>}
                    {unidades.map((g) => (
                      <optgroup key={g.unidad} label={g.unidad}>
                        <option value={g.unidad}>Toda la unidad: {g.unidad}</option>
                        {g.temas.map((t) => <option key={t} value={t}>{t}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label><span className="etiqueta">Dificultad</span>
                  <select className="input" value={req.dificultad} onChange={(e) => setReq({ ...req, dificultad: e.target.value as GeneracionIA['dificultad'] })}><option value="basico">Básico</option><option value="intermedio">Intermedio</option><option value="avanzado">Avanzado</option></select>
                </label>
                <label><span className="etiqueta">Cantidad ({tipoSel.cantidad})</span><input type="text" inputMode="numeric" pattern="[0-9]*" className="input" value={cantidadTexto} onChange={(e) => fijarCantidad(e.target.value)} onBlur={() => { if (!parseInt(cantidadTexto, 10)) setCantidadTexto(String(req.cantidad)) }} /></label>
                <label className="flex items-end gap-2 pb-2 text-sm" title="Se eligen los materiales que coinciden con el tema, no todos: así la respuesta llega antes y se ciñe a lo visto en esa sesión">
                  <input type="checkbox" checked={req.usar_materiales} onChange={(e) => setReq({ ...req, usar_materiales: e.target.checked })} /> Usar mis materiales ({detalle?.materiales.filter((m) => m.texto_len > 0).length ?? 0} con texto)
                </label>
                {TIPOS_TEXTO.includes(req.tipo) && (
                  <label className="col-span-full">
                    <span className="etiqueta">Nivel de detalle</span>
                    <select className="input" value={req.detalle ?? 'completo'} onChange={(e) => setReq({ ...req, detalle: e.target.value as NonNullable<GeneracionIA['detalle']> })}>
                      <option value="completo">Completo: explicado en párrafos, con ejemplos (recomendado)</option>
                      <option value="muy_detallado">Muy detallado: como un libro de texto, paso a paso</option>
                      <option value="breve">Breve: solo lo esencial</option>
                    </select>
                  </label>
                )}
                {TIPOS_TEXTO.includes(req.tipo) && (
                  <label className="col-span-full flex items-start gap-2 text-sm" title="Solo con Claude. Más lento y con un costo extra por búsqueda.">
                    <input type="checkbox" className="mt-1" checked={Boolean(req.verificar_web)} onChange={(e) => setReq({ ...req, verificar_web: e.target.checked })} />
                    <span>Verificar en internet y citar fuentes <span className="text-ink-500">(solo con Claude; tarda más y cuesta un poco más)</span></span>
                  </label>
                )}
                <label className="col-span-full"><span className="etiqueta">Instrucciones adicionales</span><textarea rows={2} className="input" value={req.instrucciones} onChange={(e) => setReq({ ...req, instrucciones: e.target.value })} placeholder="Ej. enfócalo en aplicaciones de mecatrónica, incluye 2 problemas con matrices 3×3, que se pueda resolver con GeoGebra…" /></label>
              </div>
              {errorGen && !cargando && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                  <b>No se pudo generar:</b> {errorGen}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className="btn-secundario text-xs" onClick={generar}>Reintentar</button>
                    <Link to="/ajustes" className="btn-fantasma text-xs">Revisar la IA en Ajustes (Probar conexión)</Link>
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <button className="btn-primario text-base px-5 py-2.5" disabled={cargando || !sel || disponible === false} onClick={generar}>
                  {cargando ? `Generando… ${segundos}s` : `✦ Generar ${tipoSel.t.toLowerCase()}`}
                </button>
              </div>
            </div>

            <div className="tarjeta p-5 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">Pregúntale al asistente sobre la materia</h3>
                <Link to={sel ? `/asistente?materia=${sel}` : '/asistente'} className="text-sm text-brand-600 hover:underline">Conversar en el Asistente (chat) →</Link>
              </div>
              <p className="text-xs text-ink-500">Usa el temario y tus materiales como contexto. Útil para preparar explicaciones, analogías, o pedir recomendaciones de software de terceros para un tema.</p>
              <textarea rows={3} className="input" value={pregunta} onChange={(e) => setPregunta(e.target.value)} placeholder="Ej. Dame una analogía para explicar independencia lineal a alumnos de mecatrónica y una actividad de 15 minutos con GeoGebra." />
              <div className="flex justify-end"><button className="btn-secundario" disabled={preguntando || disponible === false} onClick={preguntar}>{preguntando ? 'Pensando…' : 'Preguntar'}</button></div>
              {respuesta && <Markdown texto={respuesta} className="border-t border-ink-100 pt-3" />}
            </div>
          </div>

          <aside className="space-y-4 min-w-0 flex-[1_1_380px]">
            <section className="tarjeta overflow-hidden" aria-labelledby="generado-titulo">
              <div className="border-b border-ink-100 px-4 py-3">
                <h3 id="generado-titulo" className="break-words font-semibold text-ink-900">Generado para {detalle?.nombre ?? '…'}</h3>
                <p className="text-xs text-ink-500">Se guarda en la materia, en Evaluaciones y tareas.</p>
              </div>
              {generados.length > 0 && (
                // Filtros: solo cambian qué se ve en la lista
                <div className="space-y-2 border-b border-ink-100 bg-ink-50/50 px-4 py-2.5" role="search" aria-label="Filtrar lo generado">
                  <div className="flex flex-wrap items-center gap-2">
                    <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por título" etiqueta="Buscar en lo generado" />
                    <select className="input w-auto py-1 text-xs" value={orden} onChange={(e) => setOrden(e.target.value as OrdenGenerado)} aria-label="Ordenar lo generado">
                      {ORDENES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                    </select>
                  </div>
                  {tiposPresentes.length > 1 || tipoF ? (
                    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tipo">
                      {tiposPresentes.map(([t, n]) => (
                        <ChipFiltro key={t} activo={tipoF === t} onClick={() => setTipoF(tipoF === t ? '' : t)} conteo={n}>{nombreTipo(t)}</ChipFiltro>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    {hayFiltro && <button className="btn-fantasma text-xs py-1" onClick={quitarFiltros}>Quitar filtros</button>}
                    <Conteo visibles={listaGenerados.length} total={generados.length} nombre={generados.length === 1 ? 'elemento' : 'elementos'} hayFiltro={hayFiltro} />
                  </div>
                </div>
              )}
              {listaGenerados.length > 0 ? (
                <ul className="max-h-[60vh] divide-y divide-ink-100 overflow-y-auto">
                  {listaGenerados.map((e) => (
                    <li key={e.id}>
                      <Link to={`/evaluacion/${e.id}`} className="block px-4 py-2 hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none" title={e.titulo}>
                        <div className="truncate text-sm font-medium text-ink-900">{e.titulo}</div>
                        <div className="truncate text-xs text-ink-400">{nombreTipo(e.tipo)} · {diaMx(e.creado)}</div>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <SinResultados
                  hayFiltro={hayFiltro && generados.length > 0}
                  onLimpiar={quitarFiltros}
                  vacio={detalle ? 'Nada generado aún. Elige qué generar y pulsa «Generar»: aparecerá aquí.' : 'Cargando…'}
                />
              )}
            </section>
            <div className="tarjeta p-4 text-xs text-ink-500 space-y-1">
              <p><b>Consejo:</b> sube tu presentación y apuntes en Materiales. La IA alinea los reactivos a lo que realmente viste en clase.</p>
              <p>Los exámenes se exportan a PDF/Word con y sin clave de respuestas.</p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
