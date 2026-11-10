import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { api, descargar, fechaMx } from '../../lib/api'
import { Boton, Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio, aFecha, avisar, urgencia } from '../../componentes/ui'
import Markdown from '../../componentes/Markdown'
import { Buscador, FilaChips, ResumenFiltros, SinResultados, coincide, useRecordado, type OpcionFiltro } from '../../componentes/Filtros'
import type { ArchivoSubida, EstadoTareaAlumno, MateriaTareasAlumno, TareaAlumno } from '@shared/portal'
import { puntos } from './Actividades'

const ESTADO: Record<EstadoTareaAlumno, { texto: string; tono: 'gris' | 'verde' | 'ambar' | 'rojo' | 'azul' }> = {
  pendiente: { texto: 'Por entregar', tono: 'azul' },
  vencida: { texto: 'Vencida · aún puedes subirla', tono: 'rojo' },
  subida: { texto: 'Entregada aquí', tono: 'verde' },
  entregada_classroom: { texto: 'Entregada en Classroom', tono: 'verde' },
  recuperacion: { texto: 'Recuperación (opcional)', tono: 'gris' },
  cerrada: { texto: 'Cerrada · ya no se recibe', tono: 'gris' }
}

const tamano = (b: number): string => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

async function abrir(f: ArchivoSubida): Promise<void> {
  try {
    await descargar(`/subidas/archivos/${f.id}`, f.nombre)
  } catch (e) {
    avisar(`No se pudo abrir ${f.nombre}: ${(e as Error).message}`, 'error')
  }
}

/** Una tarea de Classroom: qué pide, cuándo vence y lo que el alumno ya subió. */
function Tarea({ t, recargar }: { t: TareaAlumno; recargar: () => void }): JSX.Element {
  const [abierta, setAbierta] = useState(t.estado === 'pendiente')
  const [nota, setNota] = useState(t.nota)
  const [subiendo, setSubiendo] = useState(false)
  const [error, setError] = useState('')
  const e = ESTADO[t.estado]
  // «Quedan 5 h»: solo para lo que falta entregar y tiene fecha de verdad
  const prisa = t.estado === 'pendiente' && !t.sin_fecha ? urgencia(t.vence) : null

  const subir = async (ev: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const lista = ev.target.files
    if (!lista || lista.length === 0) return
    const form = new FormData()
    Array.from(lista).forEach((f) => form.append('archivos', f))
    form.append('nota', nota)
    ev.target.value = ''
    setSubiendo(true)
    setError('')
    try {
      await api(`/alumno/tareas/${encodeURIComponent(t.curso_id)}/${encodeURIComponent(t.tarea_id)}/archivos`, { metodo: 'POST', form })
      avisar(lista.length === 1 ? 'Archivo subido: tu tarea cuenta como entregada.' : `${lista.length} archivos subidos: tu tarea cuenta como entregada.`)
      recargar()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubiendo(false)
    }
  }
  const quitar = async (f: ArchivoSubida): Promise<void> => {
    if (!window.confirm(`¿Quitar «${f.nombre}»?${t.archivos.length === 1 ? ' Es el único archivo: la tarea volverá a quedar sin entregar.' : ''}`)) return
    setError('')
    try {
      await api(`/alumno/tareas/archivos/${f.id}`, { metodo: 'DELETE' })
      recargar()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Tarjeta className="space-y-3">
      <button type="button" className="flex w-full items-start gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60" onClick={() => setAbierta((x) => !x)} aria-expanded={abierta}>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="break-words font-semibold leading-snug text-ink-900">{t.titulo}</div>
            <div className={`mt-0.5 text-sm ${prisa?.tono === 'rojo' || t.estado === 'vencida' ? 'font-medium text-red-700' : 'text-ink-600'}`}>
              {t.vence ? `${t.sin_fecha ? 'Sin fecha · cuenta hasta' : 'Vence'} ${fechaMx(t.vence)}` : 'Sin fecha de entrega'}
              {t.puntos ? ` · ${puntos(t.puntos)} pts` : ''}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {prisa ? <Chip tono={prisa.tono}>{prisa.texto}</Chip> : null}
            <Chip tono={e.tono}>{e.texto}</Chip>
            {t.tarde ? <Chip tono="ambar">Tarde</Chip> : null}
            {t.calificacion !== null ? <Chip tono="morado">{puntos(t.calificacion)}{t.puntos ? ` / ${puntos(t.puntos)}` : ''}</Chip> : null}
          </div>
        </div>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg text-ink-500 transition-transform duration-150 ${abierta ? 'rotate-180' : ''}`} aria-hidden>
          ⌄
        </span>
      </button>

      {abierta ? (
        <div className="space-y-3 border-t border-ink-100 pt-3">
          {t.descripcion.trim() ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Lo que pide</div>
              <Markdown texto={t.descripcion} />
            </div>
          ) : null}
          {t.materiales?.length ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">Material</div>
              <ul className="space-y-1">
                {t.materiales.map((m, i) => (
                  <li key={i} className="min-w-0">
                    <a className="inline-flex min-h-[44px] max-w-full items-center gap-2 break-all text-sm font-semibold text-brand-600 hover:underline" href={m.enlace} target="_blank" rel="noreferrer">
                      <span aria-hidden>📎</span>
                      <span className="min-w-0 break-words">{m.titulo}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {t.enlace ? (
            <a className="inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-600 hover:underline" href={t.enlace} target="_blank" rel="noreferrer">
              Ver la tarea en Classroom ↗
            </a>
          ) : null}
          {t.estado === 'entregada_classroom' ? <p className="text-sm text-green-700">Ya la entregaste en Classroom. Si te faltó algo, puedes subirlo aquí también.</p> : null}
          {t.estado === 'recuperacion' ? <p className="text-sm text-ink-600">Es opcional: súbela solo si te falta alguna tarea que pueda recuperar.</p> : null}
          {t.estado === 'cerrada' ? <p className="text-sm text-ink-600">La fecha de entrega ya pasó y tu docente no recibe esta tarea tarde.</p> : null}

          {t.archivos.length > 0 ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Lo que subiste{t.subida_en ? ` · ${fechaMx(t.subida_en)}` : ''}
              </div>
              <ul className="divide-y divide-ink-100">
                {t.archivos.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink-800">{f.nombre}</div>
                      <div className="text-xs text-ink-500">{tamano(f.tamano)}</div>
                    </div>
                    <Boton variante="secundario" className="shrink-0 px-3" onClick={() => void abrir(f)} aria-label={`Abrir ${f.nombre}`}>
                      Abrir
                    </Boton>
                    <Boton variante="peligro" className="shrink-0 px-3" onClick={() => void quitar(f)} aria-label={`Quitar ${f.nombre}`}>
                      Quitar
                    </Boton>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Cerrada: ya no se recibe (el docente no acepta tarde); lo ya subido se sigue viendo arriba */}
          {t.estado !== 'cerrada' && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-500">Comentario para tu docente (opcional)</span>
                <textarea
                  className="min-h-[72px] w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-base focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  value={nota}
                  maxLength={2000}
                  onChange={(ev) => setNota(ev.target.value)}
                  placeholder="Por ejemplo: la parte 3 va en la segunda foto."
                />
              </label>
              <label className={`flex min-h-[52px] cursor-pointer items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold focus-within:ring-2 focus-within:ring-brand-400/60 ${t.archivos.length ? 'border border-brand-400 bg-white text-brand-600 hover:bg-brand-500/5' : 'bg-brand-500 text-white hover:bg-brand-600'} ${subiendo ? 'opacity-50' : ''}`}>
                <input type="file" multiple className="sr-only" onChange={(ev) => void subir(ev)} disabled={subiendo} />
                <span aria-hidden>⬆</span>
                {subiendo ? 'Subiendo…' : t.archivos.length ? 'Agregar más archivos' : 'Subir archivos'}
              </label>
              <p className="text-xs text-ink-500">PDF, Word, Excel, PowerPoint, imágenes, código o ZIP. Hasta 50 MB por archivo y 10 por tarea.</p>
            </>
          )}
          {error ? <div className="break-words text-sm text-red-600">{error}</div> : null}
        </div>
      ) : null}
    </Tarjeta>
  )
}

type FiltroEstado = 'todas' | 'pendientes' | 'vencidas' | 'entregadas' | 'recuperacion' | 'cerradas'
const ESTADOS_FILTRO: { valor: FiltroEstado; texto: string; pasa: (t: TareaAlumno) => boolean }[] = [
  { valor: 'todas', texto: 'Todas', pasa: () => true },
  { valor: 'pendientes', texto: 'Por entregar', pasa: (t) => t.estado === 'pendiente' },
  { valor: 'vencidas', texto: 'Vencidas', pasa: (t) => t.estado === 'vencida' },
  { valor: 'entregadas', texto: 'Entregadas', pasa: (t) => t.estado === 'subida' || t.estado === 'entregada_classroom' },
  { valor: 'recuperacion', texto: 'Recuperación', pasa: (t) => t.estado === 'recuperacion' },
  { valor: 'cerradas', texto: 'Cerradas', pasa: (t) => t.estado === 'cerrada' }
]

/** Lo que falta entregar va arriba y, dentro de eso, lo que vence primero; lo ya resuelto, al final. */
const RANGO: Record<EstadoTareaAlumno, number> = { pendiente: 0, vencida: 0, recuperacion: 1, subida: 2, entregada_classroom: 2, cerrada: 3 }
const porUrgencia = (a: TareaAlumno, b: TareaAlumno): number =>
  RANGO[a.estado] - RANGO[b.estado] || (aFecha(a.vence)?.getTime() ?? Infinity) - (aFecha(b.vence)?.getTime() ?? Infinity)

const faltan = (t: TareaAlumno): boolean => t.estado === 'pendiente' || t.estado === 'vencida'

/** «Subir tarea»: las tareas de Classroom de cada materia, para entregarlas desde aquí. */
export default function Tareas(): JSX.Element {
  const [materias, setMaterias] = useState<MateriaTareasAlumno[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)
  const [estado, setEstado] = useRecordado<FiltroEstado>('tareas.estado', 'todas')
  const [materia, setMateria] = useRecordado<string>('tareas.materia', 'todas')
  const [busqueda, setBusqueda] = useState('')

  const cargar = useCallback((): void => {
    setCargando(true)
    setError(null)
    api<MateriaTareasAlumno[]>('/alumno/tareas')
      .then(setMaterias)
      .catch((e: Error) => setError(e.message))
      .finally(() => setCargando(false))
  }, [])
  useEffect(cargar, [cargar])

  const todas = useMemo(() => (materias ?? []).flatMap((m) => m.tareas), [materias])
  const materiaEf = materia !== 'todas' && materias?.some((m) => String(m.materia_id) === materia) ? materia : 'todas'
  const filtroEstado = ESTADOS_FILTRO.find((f) => f.valor === estado) ?? ESTADOS_FILTRO[0]
  const hayFiltro = materiaEf !== 'todas' || filtroEstado.valor !== 'todas' || busqueda.trim() !== ''
  const limpiar = (): void => {
    setEstado('todas')
    setMateria('todas')
    setBusqueda('')
  }

  // Cada filtro cuenta con los demás ya aplicados: el número dice cuántas quedarían al tocarlo
  const deMateria = (m: MateriaTareasAlumno): boolean => materiaEf === 'todas' || String(m.materia_id) === materiaEf
  const porTexto = (t: TareaAlumno): boolean => coincide(busqueda, t.titulo)
  const enMateria = (materias ?? []).filter(deMateria).flatMap((m) => m.tareas).filter(porTexto)
  const opcionesEstado: OpcionFiltro<FiltroEstado>[] = ESTADOS_FILTRO.map((f) => ({ valor: f.valor, texto: f.texto, conteo: enMateria.filter(f.pasa).length })).filter(
    (o) => o.valor === 'todas' || o.valor === filtroEstado.valor || (o.conteo ?? 0) > 0
  )
  const grupos = (materias ?? [])
    .filter(deMateria)
    .map((m) => ({ m, lista: m.tareas.filter((t) => filtroEstado.pasa(t) && porTexto(t)).sort(porUrgencia) }))
  const visibles = grupos.reduce((n, g) => n + g.lista.length, 0)
  const porEntregar = todas.filter(faltan).length

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <EncabezadoPagina
        titulo="Subir tarea"
        detalle={
          porEntregar > 0
            ? `Te ${porEntregar === 1 ? 'falta 1 tarea' : `faltan ${porEntregar} tareas`}. Elige una y sube tus archivos: en cuanto los subas, tu docente la ve como entregada.`
            : 'Elige la tarea y sube tus archivos. En cuanto los subas, tu docente la ve como entregada.'
        }
      >
        <Boton variante="fantasma" onClick={cargar} disabled={cargando} aria-label="Recargar tareas">
          <span aria-hidden>↻</span> Recargar
        </Boton>
      </EncabezadoPagina>

      {error ? (
        <ErrorCarga titulo="No se pudieron cargar tus tareas" detalle={error} onReintentar={cargar} />
      ) : materias === null ? (
        <Cargando texto="Buscando tus tareas…" />
      ) : materias.length === 0 ? (
        <Vacio icono="📤" titulo="No hay tareas para subir" detalle="Tus materias todavía no tienen tareas de Classroom en este portal." />
      ) : (
        <>
          <div className="space-y-2">
            {todas.length > 6 && <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar tarea" etiqueta="Buscar tarea por nombre" />}
            <FilaChips etiqueta="Filtrar por estado" valor={filtroEstado.valor} onCambio={setEstado} opciones={opcionesEstado} />
            {materias.length > 1 && (
              <FilaChips
                etiqueta="Filtrar por materia"
                valor={materiaEf}
                onCambio={setMateria}
                opciones={[
                  { valor: 'todas', texto: 'Todas las materias' },
                  ...materias.map((m) => ({ valor: String(m.materia_id), texto: m.materia_nombre, color: m.materia_color || '#7c8ba3', conteo: m.tareas.filter((t) => filtroEstado.pasa(t) && porTexto(t)).length }))
                ]}
              />
            )}
            {hayFiltro && <ResumenFiltros visibles={visibles} total={todas.length} nombre={['tarea', 'tareas']} hayFiltro onLimpiar={limpiar} />}
          </div>

          {hayFiltro && visibles === 0 ? (
            <SinResultados onLimpiar={limpiar} detalle={filtroEstado.valor === 'pendientes' ? 'No te falta ninguna por entregar con estos filtros. 🎉' : undefined} />
          ) : (
            grupos
              // Con filtros, las materias que no tienen nada que mostrar no ocupan lugar
              .filter((g) => !hayFiltro || g.lista.length > 0)
              .map(({ m, lista }) => {
                const pendientes = m.tareas.filter(faltan).length
                return (
                  <section key={m.materia_id} className="space-y-2">
                    <h3 className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-sm font-bold uppercase tracking-wide text-ink-600">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.materia_color }} aria-hidden />
                      <span className="min-w-0 break-words">{m.materia_nombre}</span>
                      <span className={`font-normal normal-case ${pendientes ? 'text-ink-700' : 'text-ink-500'}`}>· {pendientes} por entregar</span>
                    </h3>
                    {lista.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-ink-200 px-3 py-4 text-center text-sm text-ink-500">Sin tareas.</div>
                    ) : (
                      lista.map((t) => <Tarea key={`${t.curso_id}:${t.tarea_id}`} t={t} recargar={cargar} />)
                    )}
                  </section>
                )
              })
          )}
        </>
      )}
    </div>
  )
}
