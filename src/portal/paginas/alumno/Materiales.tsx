import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, descargar } from '../../lib/api'
import { Boton, Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import { Buscador, FilaChips, ResumenFiltros, SinResultados, coincide, useRecordado } from '../../componentes/Filtros'
import type { MaterialAlumno } from '@shared/portal'

const ICONO: Record<string, string> = { pdf: '📕', docx: '📘', xlsx: '📗', pptx: '📙', geogebra: '📐', codigo: '💻', link: '🔗', otro: '📄' }
const ESTADO_CUADERNO = { nuevo: { texto: 'Sin empezar', tono: 'gris' }, borrador: { texto: 'En progreso', tono: 'azul' }, entregado: { texto: 'Entregado', tono: 'verde' } } as const
// pdf.js pesa: se carga solo al abrir una vista previa
const VisorArchivo = lazy(() => import('../../componentes/VisorArchivo'))
/** Extensión para el nombre del archivo descargado (la descarga se arma en el navegador y no trae el nombre del servidor) */
const EXT: Record<string, string> = { pdf: '.pdf', docx: '.docx', xlsx: '.xlsx', pptx: '.pptx', geogebra: '.ggb' }
const nombreArchivo = (m: MaterialAlumno): string => {
  const ext = EXT[m.tipo] ?? ''
  return !ext || m.titulo.toLowerCase().endsWith(ext) ? m.titulo : `${m.titulo}${ext}`
}
const TIPO: Record<string, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'Presentación', geogebra: 'GeoGebra', codigo: 'Código', link: 'Enlace', otro: 'Archivo' }

/** Lo que el docente comparte de cada materia (presentaciones, lecturas, enlaces), por unidad. */
export default function Materiales(): JSX.Element {
  const nav = useNavigate()
  const [lista, setLista] = useState<MaterialAlumno[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [abriendo, setAbriendo] = useState<number | null>(null)
  const [viendo, setViendo] = useState<MaterialAlumno | null>(null)
  const [busqueda, setBusqueda] = useState('')
  const [materia, setMateria] = useRecordado<string>('materiales.materia', 'todas')
  const [tipo, setTipo] = useRecordado<string>('materiales.tipo', 'todos')

  const cargar = useCallback((): void => {
    setError(null)
    api<MaterialAlumno[]>('/alumno/materiales')
      .then(setLista)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(cargar, [cargar])

  // Materias y tipos que hay, con su conteo, para los filtros
  const materias = useMemo(() => {
    const m = new Map<string, { nombre: string; color: string; total: number }>()
    for (const x of lista ?? []) {
      const g = m.get(String(x.materia_id)) ?? { nombre: x.materia_nombre, color: x.materia_color, total: 0 }
      g.total++
      m.set(String(x.materia_id), g)
    }
    return [...m.entries()].sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, 'es'))
  }, [lista])
  const materiaEf = materia !== 'todas' && materias.some(([id]) => id === materia) ? materia : 'todas'
  const deMateria = (lista ?? []).filter((m) => materiaEf === 'todas' || String(m.materia_id) === materiaEf)
  const tipos = [...new Set((lista ?? []).map((m) => (TIPO[m.tipo] ? m.tipo : 'otro')))]
  const tipoEf = tipo !== 'todos' && tipos.includes(tipo) ? tipo : 'todos'
  const visibles = deMateria.filter((m) => (tipoEf === 'todos' || (TIPO[m.tipo] ? m.tipo : 'otro') === tipoEf) && coincide(busqueda, m.titulo, m.unidad, m.materia_nombre))
  const hayFiltro = materiaEf !== 'todas' || tipoEf !== 'todos' || busqueda.trim() !== ''
  const limpiar = (): void => {
    setMateria('todas')
    setTipo('todos')
    setBusqueda('')
  }

  // Materia → unidad → materiales (solo lo que pasa los filtros)
  const grupos = (() => {
    const porMateria = new Map<number, { nombre: string; color: string; unidades: Map<string, MaterialAlumno[]> }>()
    for (const m of visibles) {
      const g = porMateria.get(m.materia_id) ?? { nombre: m.materia_nombre, color: m.materia_color, unidades: new Map() }
      const u = m.unidad.trim() || 'General'
      g.unidades.set(u, [...(g.unidades.get(u) ?? []), m])
      porMateria.set(m.materia_id, g)
    }
    return [...porMateria.entries()]
  })()

  const abrir = async (m: MaterialAlumno): Promise<void> => {
    setAbriendo(m.id)
    try {
      if (m.tipo === 'link') {
        const r = await api<{ url: string }>(`/alumno/materiales/${m.id}`)
        window.open(r.url, '_blank', 'noopener')
      } else {
        await descargar(`/alumno/materiales/${m.id}`, nombreArchivo(m))
      }
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setAbriendo(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {viendo && (
        <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/95 text-sm text-white/80">Abriendo el archivo…</div>}>
          <VisorArchivo ruta={`/alumno/materiales/${viendo.id}`} titulo={viendo.titulo} nombre={nombreArchivo(viendo)} tipo="pdf" onCerrar={() => setViendo(null)} />
        </Suspense>
      )}
      <EncabezadoPagina titulo="Materiales de clase">
        <Boton variante="fantasma" onClick={cargar} aria-label="Recargar materiales">
          <span aria-hidden>↻</span> Recargar
        </Boton>
      </EncabezadoPagina>

      {error && <ErrorCarga titulo="No se pudieron cargar los materiales" detalle={error} onReintentar={cargar} />}
      {!lista && !error && <Cargando texto="Cargando materiales…" />}
      {lista && lista.length === 0 && <Vacio icono="📚" titulo="Aún no hay materiales" detalle="Cuando tu docente comparta presentaciones, lecturas o enlaces aparecerán aquí." />}

      {lista && lista.length > 0 && (
        <div className="space-y-2">
          {/* Con pocos materiales el buscador solo estorba */}
          {lista.length > 5 && <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar material o unidad" etiqueta="Buscar material por nombre o unidad" />}
          {materias.length > 1 && (
            <FilaChips
              etiqueta="Filtrar por materia"
              valor={materiaEf}
              onCambio={setMateria}
              opciones={[{ valor: 'todas', texto: 'Todas las materias', conteo: lista.length }, ...materias.map(([id, g]) => ({ valor: id, texto: g.nombre, color: g.color || '#7c8ba3', conteo: g.total }))]}
            />
          )}
          {tipos.length > 1 && (
            <FilaChips
              etiqueta="Filtrar por tipo de material"
              valor={tipoEf}
              onCambio={setTipo}
              opciones={[
                { valor: 'todos', texto: 'Todo tipo', conteo: deMateria.length },
                ...tipos.map((t) => ({ valor: t, texto: `${ICONO[t] ?? '📄'} ${TIPO[t] ?? 'Archivo'}`, conteo: deMateria.filter((m) => (TIPO[m.tipo] ? m.tipo : 'otro') === t).length }))
              ]}
            />
          )}
          {hayFiltro && <ResumenFiltros visibles={visibles.length} total={lista.length} nombre={['material', 'materiales']} hayFiltro onLimpiar={limpiar} />}
        </div>
      )}

      {lista && lista.length > 0 && visibles.length === 0 && <SinResultados onLimpiar={limpiar} detalle="Prueba con otra palabra, materia o tipo." />}

      {grupos.map(([id, g]) => (
        <section key={id} className="space-y-3">
          <h3 className="flex items-center gap-2 font-semibold text-ink-900">
            <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: g.color || '#7c8ba3' }} aria-hidden />
            <span className="min-w-0 break-words">{g.nombre}</span>
          </h3>
          {[...g.unidades.entries()].map(([unidad, items]) => (
            <Tarjeta key={unidad} className="space-y-1 py-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{unidad}</div>
              <ul className="divide-y divide-ink-100">
                {items.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                    <span className="text-2xl leading-none" aria-hidden>{ICONO[m.tipo] ?? '📄'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-sm font-medium text-ink-900">{m.titulo}</div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        <Chip>{m.cuaderno ? 'Cuaderno' : (TIPO[m.tipo] ?? 'Archivo')}</Chip>
                        {m.cuaderno && m.cuaderno_estado && <Chip tono={ESTADO_CUADERNO[m.cuaderno_estado].tono}>{ESTADO_CUADERNO[m.cuaderno_estado].texto}</Chip>}
                        {!m.disponible && <Chip tono="ambar">Aún no disponible</Chip>}
                      </div>
                    </div>
                    {/* Un cuaderno de Jupyter se resuelve aquí mismo: se abre en el portal en vez de descargarse */}
                    {m.cuaderno ? (
                      <Boton className="min-h-[44px] shrink-0 px-3" disabled={!m.disponible} onClick={() => nav(`/cuaderno/${m.id}`)} aria-label={`Abrir el cuaderno ${m.titulo}`}>
                        {m.cuaderno_estado === 'entregado' ? 'Ver' : m.cuaderno_estado === 'borrador' ? 'Continuar' : 'Abrir'}
                      </Boton>
                    ) : m.tipo === 'pdf' ? (
                      // PDF: vista previa en el portal y descarga; en celular los dos botones bajan a su propia fila
                      <div className="flex w-full gap-2 sm:w-auto sm:shrink-0">
                        <Boton className="flex-1 px-3 sm:flex-none" disabled={!m.disponible} onClick={() => setViendo(m)} aria-label={`Ver ${m.titulo}`}>
                          Ver
                        </Boton>
                        <Boton variante="secundario" className="flex-1 px-3 sm:flex-none" disabled={!m.disponible || abriendo === m.id} onClick={() => abrir(m)} aria-label={`Descargar ${m.titulo}`}>
                          {abriendo === m.id ? 'Descargando…' : 'Descargar'}
                        </Boton>
                      </div>
                    ) : (
                    <Boton
                      variante="secundario"
                      className="min-h-[44px] shrink-0 px-3"
                      disabled={!m.disponible || abriendo === m.id}
                      onClick={() => abrir(m)}
                      aria-label={`${m.tipo === 'link' ? 'Abrir' : 'Descargar'} ${m.titulo}`}
                    >
                      {abriendo === m.id ? 'Abriendo…' : m.tipo === 'link' ? 'Abrir' : 'Descargar'}
                    </Boton>
                    )}
                  </li>
                ))}
              </ul>
            </Tarjeta>
          ))}
        </section>
      ))}
    </div>
  )
}
