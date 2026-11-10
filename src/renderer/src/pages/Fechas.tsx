import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Recordatorio, type TipoRecordatorio } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import { avisar } from '../components/Aviso'
import { hoyIso } from '../lib/tiempo'
import Cuando from '../components/Cuando'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, SinResultados, coincide } from '../components/Filtros'
import type { Materia } from '@shared/types'

export const TIPOS_RECORDATORIO: { v: TipoRecordatorio; t: string; c: string }[] = [
  { v: 'parcial', t: 'Parcial / examen', c: 'bg-violet-100 text-violet-700' },
  { v: 'entrega', t: 'Entrega', c: 'bg-sky-100 text-sky-700' },
  { v: 'suspension', t: 'Suspensión', c: 'bg-amber-100 text-amber-800' },
  { v: 'otro', t: 'Otro', c: 'bg-ink-100 text-ink-600' }
]
export const colorTipo = (t: string): string => TIPOS_RECORDATORIO.find((x) => x.v === t)?.c ?? 'bg-ink-100 text-ink-600'
export const nombreTipo = (t: string): string => TIPOS_RECORDATORIO.find((x) => x.v === t)?.t ?? t

/** «21 sep 2026», «21–25 sep 2026» o «30 nov – 4 dic 2026»; la hora va aparte. */
export function rangoFechas(desde: string, hasta?: string | null): string {
  const f = (x: string, o: Intl.DateTimeFormatOptions): string => new Date(x + 'T12:00:00').toLocaleDateString('es-MX', o).replace(/\./g, '')
  if (!hasta || hasta === desde) return f(desde, { day: 'numeric', month: 'short', year: 'numeric' })
  if (desde.slice(0, 7) === hasta.slice(0, 7)) return `${Number(desde.slice(8))}–${f(hasta, { day: 'numeric', month: 'short', year: 'numeric' })}`
  if (desde.slice(0, 4) === hasta.slice(0, 4)) return `${f(desde, { day: 'numeric', month: 'short' })} – ${f(hasta, { day: 'numeric', month: 'short', year: 'numeric' })}`
  return `${f(desde, { day: 'numeric', month: 'short', year: 'numeric' })} – ${f(hasta, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

const vacio = (): Partial<Recordatorio> => ({ fecha: hoyIso(), fecha_fin: null, hora: null, titulo: '', tipo: 'parcial', materia_id: null, avisar_dias: 3, notas: '' })

/** Fechas importantes: parciales, entregas y suspensiones, con su aviso del sistema. */
export default function Fechas(): JSX.Element {
  const [lista, setLista] = useState<Recordatorio[]>([])
  const [materias, setMaterias] = useState<Materia[]>([])
  // Los filtros se recuerdan al ir a otra pantalla y volver
  const [busqueda, setBusqueda] = useRecordado('fechas.busqueda', '')
  const [filtro, setFiltro] = useRecordado<string>('fechas.materia', 'todas')
  const [tipos, setTipos] = useRecordado<TipoRecordatorio[]>('fechas.tipos', [])
  const [verPasadas, setVerPasadas] = useRecordado('fechas.verPasadas', false)
  const [form, setForm] = useState<Partial<Recordatorio> | null>(null)
  const hoy = hoyIso()

  const cargar = (): void => {
    api.recordatorios.listar().then(setLista).catch((e) => avisar((e as Error).message, 'error'))
  }
  useEffect(() => {
    cargar()
    api.materias.listar().then((m) => setMaterias(m.filter((x) => !x.oculta)))
  }, [])

  // Cada filtro por separado, para contar cuántas quedan en cada tipo con los demás puestos
  const pasaMateria = (r: Recordatorio): boolean => filtro === 'todas' || (filtro === 'general' ? r.materia_id == null : String(r.materia_id) === filtro)
  const pasaBusqueda = (r: Recordatorio): boolean => coincide(busqueda, r.titulo, r.notas, r.materia_nombre, nombreTipo(r.tipo))
  const paraTipos = useMemo(() => lista.filter((r) => pasaMateria(r) && pasaBusqueda(r)), [lista, filtro, busqueda]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtradas = useMemo(() => paraTipos.filter((r) => !tipos.length || tipos.includes(r.tipo)), [paraTipos, tipos])
  const proximas = filtradas.filter((r) => (r.fecha_fin ?? r.fecha) >= hoy)
  const pasadas = filtradas.filter((r) => (r.fecha_fin ?? r.fecha) < hoy).reverse()
  const hayFiltro = !!busqueda.trim() || filtro !== 'todas' || tipos.length > 0
  const quitarFiltros = (): void => {
    setBusqueda('')
    setFiltro('todas')
    setTipos([])
  }
  const alternarTipo = (t: TipoRecordatorio): void => setTipos(tipos.includes(t) ? tipos.filter((x) => x !== t) : [...tipos, t])
  const generales = lista.filter((r) => r.materia_id == null).length

  const guardar = async (): Promise<void> => {
    if (!form) return
    try {
      await api.recordatorios.guardar(form)
      setForm(null)
      avisar('Fecha guardada')
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const borrar = async (r: Recordatorio): Promise<void> => {
    if (!confirm(`¿Borrar «${r.titulo}»?`)) return
    await api.recordatorios.eliminar(r.id)
    setForm(null)
    cargar()
  }

  // Función y no componente: así las filas no se vuelven a montar en cada cambio de la pantalla
  const fila = (r: Recordatorio): JSX.Element => {
    const fin = r.fecha_fin ?? r.fecha
    const vigente = fin >= hoy
    return (
      <button
        key={r.id}
        onClick={() => setForm({ ...r })}
        title="Editar esta fecha"
        className="fila-fecha w-full text-left px-4 py-2.5 hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none"
        style={{ ['--col-fecha' as string]: '8rem' }}
      >
        <span className="c-fecha text-sm text-ink-600">
          {rangoFechas(r.fecha, r.fecha_fin)}
          {r.hora && <span className="block text-xs text-ink-400">{r.hora}</span>}
        </span>
        <span className="c-titulo">
          <span className="block truncate font-medium text-ink-900" title={r.titulo}>{r.titulo}</span>
          <span className="block text-xs text-ink-400 truncate" title={r.notas || undefined}>aviso {r.avisar_dias === 0 ? 'el mismo día' : `${r.avisar_dias} ${r.avisar_dias === 1 ? 'día' : 'días'} antes`}{r.notas ? ` · ${r.notas}` : ''}</span>
        </span>
        <span className="c-meta">
          <span className="c-materia flex items-center gap-1.5 text-xs text-ink-500 min-w-0"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.materia_color ?? '#94a3b8' }} /><span className="truncate" title={r.materia_nombre ?? 'General'}>{r.materia_nombre ?? 'General'}</span></span>
          <span className={`c-tipo chip whitespace-nowrap ${colorTipo(r.tipo)}`}>{nombreTipo(r.tipo)}</span>
        </span>
        <span className="c-cuando">{vigente ? <Cuando fecha={r.fecha} fin={r.fecha_fin} hoy={hoy} /> : <span className="text-xs text-ink-400">pasó</span>}</span>
      </button>
    )
  }

  return (
    <div>
      <Encabezado
        titulo="Fechas importantes"
        sub={<span><Link to="/" className="hover:underline">Hoy</Link> · Parciales, entregas y suspensiones. La app te avisa con una notificación los días previos.</span>}
        acciones={<button className="btn-primario" onClick={() => setForm(vacio())}>+ Nueva fecha</button>}
      />
      <div className="px-4 sm:px-8 py-5 space-y-5">
        {lista.length === 0 ? (
          <div className="tarjeta px-5 py-10 text-center">
            <div className="font-medium text-ink-800">Aún no hay fechas anotadas</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Anota parciales, entregas y suspensiones. Aparecen en Hoy y la app te avisa con una notificación los días previos.</p>
            <button className="btn-primario mt-4" onClick={() => setForm(vacio())}>+ Nueva fecha</button>
          </div>
        ) : (
          <>
            {/* Filtros: solo cambian qué fechas se ven */}
            <div className="tarjeta p-3 space-y-2.5" role="search" aria-label="Filtrar fechas">
              <div className="flex flex-wrap items-center gap-2">
                <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por título o notas" etiqueta="Buscar fechas" />
                <select className="input w-auto max-w-[16rem]" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar por materia">
                  <option value="todas">Todas las materias</option>
                  <option value="general">Solo generales ({generales})</option>
                  {materias.map((m) => <option key={m.id} value={m.id}>{m.nombre} ({lista.filter((r) => r.materia_id === m.id).length})</option>)}
                </select>
                {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tipo de fecha">
                {TIPOS_RECORDATORIO.map((t) => (
                  <ChipFiltro key={t.v} activo={tipos.includes(t.v)} onClick={() => alternarTipo(t.v)} conteo={paraTipos.filter((r) => r.tipo === t.v).length}>{t.t}</ChipFiltro>
                ))}
                <Conteo visibles={filtradas.length} total={lista.length} nombre="fechas" hayFiltro={hayFiltro} />
              </div>
            </div>

            <section>
              <h2 className="mb-2 flex items-baseline gap-2 font-semibold text-lg">Próximas <span className="text-sm font-normal text-ink-400">{proximas.length}</span></h2>
              <div className="tarjeta divide-y divide-ink-100 lista-filas overflow-hidden">
                {proximas.map(fila)}
                {proximas.length === 0 &&
                  (hayFiltro && filtradas.length === 0 ? (
                    <SinResultados hayFiltro onLimpiar={quitarFiltros} vacio={null} />
                  ) : (
                    <div className="px-4 py-6 text-ink-500 text-sm">{hayFiltro ? 'Ninguna fecha próxima con estos filtros; las que coinciden ya pasaron.' : 'No hay fechas próximas. Agrega una con «+ Nueva fecha».'}</div>
                  ))}
              </div>
            </section>
            {pasadas.length > 0 && (
              <section>
                <button className="btn-fantasma -ml-3" onClick={() => setVerPasadas(!verPasadas)} aria-expanded={verPasadas}>
                  <span className={`text-ink-400 transition-transform duration-200 ${verPasadas ? '' : '-rotate-90'}`} aria-hidden>▾</span> Pasadas <span className="text-ink-400">{pasadas.length}</span>
                </button>
                {verPasadas && <div className="tarjeta divide-y divide-ink-100 mt-2 lista-filas overflow-hidden opacity-80">{pasadas.map(fila)}</div>}
              </section>
            )}
          </>
        )}
      </div>

      <Modal titulo={form?.id ? 'Editar fecha' : 'Nueva fecha'} abierto={!!form} onCerrar={() => setForm(null)} ancho="max-w-lg">
        {form && (
          <div className="space-y-3">
            <label className="block"><span className="etiqueta">Título</span><input className="input" autoFocus value={form.titulo ?? ''} onChange={(e) => setForm({ ...form, titulo: e.target.value })} placeholder="Segundo examen parcial" /></label>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
              <label><span className="etiqueta">Fecha</span><input type="date" className="input" value={form.fecha ?? ''} onChange={(e) => setForm({ ...form, fecha: e.target.value })} /></label>
              <label><span className="etiqueta">Hasta (opcional)</span><input type="date" className="input" value={form.fecha_fin ?? ''} min={form.fecha} onChange={(e) => setForm({ ...form, fecha_fin: e.target.value || null })} /></label>
              <label><span className="etiqueta">Hora (opcional)</span><input type="time" className="input" value={form.hora ?? ''} onChange={(e) => setForm({ ...form, hora: e.target.value || null })} /></label>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-3">
              <label><span className="etiqueta">Tipo</span><select className="input" value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as TipoRecordatorio })}>{TIPOS_RECORDATORIO.map((t) => <option key={t.v} value={t.v}>{t.t}</option>)}</select></label>
              <label><span className="etiqueta">Materia</span><select className="input" value={form.materia_id ?? ''} onChange={(e) => setForm({ ...form, materia_id: e.target.value ? Number(e.target.value) : null })}><option value="">General (todas)</option>{materias.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></label>
              <label><span className="etiqueta">Avisar días antes</span><input type="number" min={0} max={60} className="input" value={form.avisar_dias ?? 0} onChange={(e) => setForm({ ...form, avisar_dias: Number(e.target.value) })} /></label>
            </div>
            <label className="block"><span className="etiqueta">Notas</span><textarea className="input min-h-[70px]" value={form.notas ?? ''} onChange={(e) => setForm({ ...form, notas: e.target.value })} /></label>
            <p className="text-xs text-ink-500">Recibirás una notificación del sistema una vez al día desde {form.avisar_dias ? `${form.avisar_dias} ${form.avisar_dias === 1 ? 'día' : 'días'} antes` : 'ese mismo día'} y hasta que pase la fecha (con la app abierta).</p>
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              {form.id ? <button className="btn-peligro" onClick={() => borrar(form as Recordatorio)}>Borrar</button> : <span />}
              <div className="flex gap-2"><button className="btn-secundario" onClick={() => setForm(null)}>Cancelar</button><button className="btn-primario" onClick={guardar}>Guardar</button></div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
