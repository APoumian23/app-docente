import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio } from '../../componentes/ui'
import { FilaChips, ResumenFiltros, SinResultados, useRecordado, type OpcionFiltro } from '../../componentes/Filtros'
import type { EventoCalendario } from '@shared/portal'

const TIPO: Record<EventoCalendario['tipo'], { texto: string; tono: 'gris' | 'rojo' | 'ambar' | 'azul' }> = {
  clase: { texto: 'Clase', tono: 'gris' },
  examen: { texto: 'Examen', tono: 'rojo' },
  entrega: { texto: 'Entrega', tono: 'ambar' },
  actividad: { texto: 'Cierra actividad', tono: 'azul' }
}

const hoyMx = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
/** El día siguiente a una fecha YYYY-MM-DD (para decir «Mañana») */
const diaSiguiente = (fecha: string): string => new Date(new Date(`${fecha}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
const nombreDia = (fecha: string): string => {
  const t = new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${fecha}T12:00:00Z`))
  return t.charAt(0).toUpperCase() + t.slice(1)
}
/** «Hoy», «Mañana» o el nombre del día */
const cuando = (fecha: string, hoy: string): string => (fecha === hoy ? 'Hoy' : fecha === diaSiguiente(hoy) ? 'Mañana' : nombreDia(fecha))

function Evento({ e }: { e: EventoCalendario }): JSX.Element {
  const t = TIPO[e.tipo]
  return (
    <li className="flex items-start gap-3 py-2.5">
      <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: e.materia_color || '#7c8ba3' }} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="break-words text-sm font-medium text-ink-900">{e.titulo}</div>
        <div className="break-words text-xs text-ink-600">
          {e.materia_nombre}
          {e.tipo === 'clase' ? ` · ${e.detalle}` : e.hora ? ` · ${e.hora}` : ''}
        </div>
      </div>
      <span className="shrink-0">
        <Chip tono={t.tono}>{t.texto}</Chip>
      </span>
    </li>
  )
}

/** Próximas tres fechas que no son clase normal (exámenes, entregas, cierres): va arriba de Actividades. */
export function ProximasFechas(): JSX.Element | null {
  const [eventos, setEventos] = useState<EventoCalendario[] | null>(null)
  useEffect(() => {
    api<EventoCalendario[]>('/alumno/calendario').then(setEventos).catch(() => setEventos([]))
  }, [])
  const hoy = hoyMx()
  const proximas = (eventos ?? []).filter((e) => e.tipo !== 'clase' && e.fecha >= hoy).slice(0, 3)
  if (!proximas.length) return null
  return (
    <Tarjeta className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Próximas fechas</h3>
        <Link to="/calendario" className="-mr-2 inline-flex min-h-[44px] items-center rounded-xl px-2 text-sm font-semibold text-brand-600 hover:bg-ink-100">
          Ver calendario
        </Link>
      </div>
      <div className="divide-y divide-ink-100">
        {proximas.map((e, i) => (
          <div key={i}>
            <div className={`pt-2 text-xs font-semibold ${e.fecha === hoy ? 'text-red-700' : 'text-ink-600'}`}>{cuando(e.fecha, hoy)}</div>
            <ul>
              <Evento e={e} />
            </ul>
          </div>
        ))}
      </div>
    </Tarjeta>
  )
}

type FiltroTipo = 'todo' | 'sin_clases' | EventoCalendario['tipo']
const TIPOS_FILTRO: { valor: FiltroTipo; texto: string; pasa: (e: EventoCalendario) => boolean }[] = [
  { valor: 'todo', texto: 'Todo', pasa: () => true },
  { valor: 'sin_clases', texto: 'Fechas importantes', pasa: (e) => e.tipo !== 'clase' },
  { valor: 'examen', texto: 'Exámenes', pasa: (e) => e.tipo === 'examen' },
  { valor: 'entrega', texto: 'Entregas', pasa: (e) => e.tipo === 'entrega' },
  { valor: 'actividad', texto: 'Cierres de actividad', pasa: (e) => e.tipo === 'actividad' },
  { valor: 'clase', texto: 'Clases', pasa: (e) => e.tipo === 'clase' }
]

/** Clases, exámenes, entregas y cierres de los próximos días, agrupados por día. */
export default function Calendario(): JSX.Element {
  const [eventos, setEventos] = useState<EventoCalendario[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tipo, setTipo] = useRecordado<FiltroTipo>('calendario.tipo', 'todo')
  const [materia, setMateria] = useRecordado<string>('calendario.materia', 'todas')
  const cargar = (): void => {
    setError(null)
    api<EventoCalendario[]>('/alumno/calendario').then(setEventos).catch((e: Error) => setError(e.message))
  }
  useEffect(cargar, [])
  const hoy = hoyMx()

  const materias = useMemo(() => {
    const m = new Map<string, { color: string; total: number }>()
    for (const e of eventos ?? []) {
      const g = m.get(e.materia_nombre) ?? { color: e.materia_color, total: 0 }
      g.total++
      m.set(e.materia_nombre, g)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es'))
  }, [eventos])
  const materiaEf = materia !== 'todas' && materias.some(([n]) => n === materia) ? materia : 'todas'
  const deMateria = (eventos ?? []).filter((e) => materiaEf === 'todas' || e.materia_nombre === materiaEf)
  const filtroTipo = TIPOS_FILTRO.find((t) => t.valor === tipo) ?? TIPOS_FILTRO[0]
  const visibles = deMateria.filter(filtroTipo.pasa)
  const hayFiltro = materiaEf !== 'todas' || filtroTipo.valor !== 'todo'
  const limpiar = (): void => {
    setTipo('todo')
    setMateria('todas')
  }

  const porDia = new Map<string, EventoCalendario[]>()
  for (const e of visibles) porDia.set(e.fecha, [...(porDia.get(e.fecha) ?? []), e])
  const dias = [...porDia.entries()]

  // Solo los tipos que hay (con la materia elegida); el elegido siempre se ve para poder cambiarlo
  const opcionesTipo: OpcionFiltro<FiltroTipo>[] = TIPOS_FILTRO.map((t) => ({ valor: t.valor, texto: t.texto, conteo: deMateria.filter(t.pasa).length })).filter(
    (o) => o.valor === 'todo' || o.valor === filtroTipo.valor || (o.conteo ?? 0) > 0
  )

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <EncabezadoPagina titulo="Calendario" detalle="Tus clases, exámenes y fechas de entrega de los próximos días." />
      {error && <ErrorCarga titulo="No se pudo cargar el calendario" detalle={error} onReintentar={cargar} />}
      {!eventos && !error && <Cargando texto="Cargando calendario…" />}
      {eventos && eventos.length === 0 && <Vacio icono="📅" titulo="Nada en las próximas semanas" detalle="Aquí verás tus clases, exámenes y fechas de entrega." />}

      {eventos && eventos.length > 0 && (
        <div className="space-y-2">
          <FilaChips etiqueta="Filtrar por tipo de evento" valor={filtroTipo.valor} onCambio={setTipo} opciones={opcionesTipo} />
          {materias.length > 1 && (
            <FilaChips
              etiqueta="Filtrar por materia"
              valor={materiaEf}
              onCambio={setMateria}
              opciones={[{ valor: 'todas', texto: 'Todas las materias' }, ...materias.map(([n, g]) => ({ valor: n, texto: n, color: g.color || '#7c8ba3', conteo: g.total }))]}
            />
          )}
          {hayFiltro && <ResumenFiltros visibles={visibles.length} total={eventos.length} nombre={['evento', 'eventos']} hayFiltro onLimpiar={limpiar} />}
        </div>
      )}

      {eventos && eventos.length > 0 && dias.length === 0 && <SinResultados onLimpiar={limpiar} detalle="Prueba con otra materia u otro tipo de evento." />}

      {dias.map(([fecha, lista]) => (
        <Tarjeta key={fecha} className={fecha < hoy ? 'bg-ink-50 shadow-none' : fecha === hoy ? 'ring-2 ring-brand-400' : ''}>
          <h3 className={`text-sm font-semibold ${fecha < hoy ? 'text-ink-500' : 'text-ink-800'}`}>
            {fecha === hoy ? `Hoy · ${nombreDia(fecha)}` : fecha === diaSiguiente(hoy) ? `Mañana · ${nombreDia(fecha)}` : nombreDia(fecha)}
            {fecha < hoy && <span className="font-normal"> · ya pasó</span>}
          </h3>
          <ul className="divide-y divide-ink-100">
            {lista.map((e, i) => <Evento key={i} e={e} />)}
          </ul>
        </Tarjeta>
      ))}
    </div>
  )
}
