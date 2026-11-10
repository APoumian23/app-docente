/**
 * Piezas comunes para filtrar y ordenar listas (Alumnos, Materiales, Asistencias, Classroom…).
 * Mismo aspecto en toda la app: buscador con lupa, selector segmentado con conteos, chips que se
 * prenden y apagan, encabezados de tabla que ordenan y el aviso de «nada coincide».
 */
import type { ReactNode } from 'react'

/** Para buscar sin que importen acentos ni mayúsculas («sesion» encuentra «Sesión»). */
export const sinAcentos = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Orden alfabético en español con números naturales («Sesión 2» antes que «Sesión 10»). */
export const ordenNatural = (a: string, b: string): number => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' })

/** ¿El texto contiene la búsqueda? (búsqueda vacía = sí) */
export const coincide = (busqueda: string, ...campos: (string | null | undefined)[]): boolean => {
  const q = sinAcentos(busqueda.trim())
  return !q || sinAcentos(campos.filter(Boolean).join(' ')).includes(q)
}

export function Buscador({ valor, onCambio, placeholder = 'Buscar', etiqueta, className = '' }: { valor: string; onCambio: (v: string) => void; placeholder?: string; etiqueta?: string; className?: string }): JSX.Element {
  return (
    <div className={`relative min-w-0 flex-[1_1_14rem] max-w-md ${className}`}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden>⌕</span>
      <input className="input pl-7" type="search" value={valor} onChange={(e) => onCambio(e.target.value)} placeholder={placeholder} aria-label={etiqueta ?? placeholder} />
    </div>
  )
}

/** Selector de una sola opción (Todos / Activos / De baja…), con conteo opcional en cada una. */
export function Segmentado<T extends string>({ opciones, valor, onCambio, etiqueta }: { opciones: { valor: T; texto: string; conteo?: number }[]; valor: T; onCambio: (v: T) => void; etiqueta: string }): JSX.Element {
  return (
    <div role="radiogroup" aria-label={etiqueta} className="inline-flex max-w-full flex-wrap rounded-lg border border-ink-200 bg-white p-0.5">
      {opciones.map((o) => {
        const sel = o.valor === valor
        return (
          <button
            key={o.valor}
            type="button"
            role="radio"
            aria-checked={sel}
            onClick={() => onCambio(o.valor)}
            className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${sel ? 'bg-ink-800 text-white' : 'text-ink-600 hover:bg-ink-100'}`}
          >
            {o.texto}
            {o.conteo !== undefined && <span className={`ml-1 ${sel ? 'text-white/70' : 'text-ink-400'}`}>{o.conteo}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Chip que se prende y apaga (tipo de archivo, carrera…). Con `color`, se pinta con él. */
export function ChipFiltro({ activo, onClick, children, conteo, color, titulo }: { activo: boolean; onClick: () => void; children: ReactNode; conteo?: number; color?: string; titulo?: string }): JSX.Element {
  const estilo = color
    ? activo
      ? { backgroundColor: color, color: 'white', ['--tw-ring-color' as string]: color }
      : { color, backgroundColor: `${color}10`, ['--tw-ring-color' as string]: `${color}55` }
    : undefined
  return (
    <button
      type="button"
      aria-pressed={activo}
      title={titulo}
      onClick={onClick}
      style={estilo}
      className={`chip whitespace-nowrap ring-1 transition-colors ${color ? 'font-semibold' : activo ? 'bg-ink-800 text-white ring-ink-800' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-100'}`}
    >
      {children}
      {conteo !== undefined && <span className="ml-1 font-normal opacity-60">{conteo}</span>}
    </button>
  )
}

export interface Orden<C extends string> {
  campo: C
  dir: 1 | -1
}

/** Encabezado de tabla que ordena al tocarlo; otro toque invierte el orden. */
export function EncabezadoOrden<C extends string>({ campo, orden, onOrden, children, className = '' }: { campo: C; orden: Orden<C>; onOrden: (o: Orden<C>) => void; children: string; className?: string }): JSX.Element {
  const activo = orden.campo === campo
  return (
    <th className={`px-3 py-2 ${className}`} aria-sort={activo ? (orden.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 uppercase hover:text-ink-800 ${activo ? 'text-ink-800' : ''}`}
        onClick={() => onOrden(activo ? { campo, dir: orden.dir === 1 ? -1 : 1 } : { campo, dir: 1 })}
        title={`Ordenar por ${children.toLowerCase()}`}
      >
        {children}
        <span className={activo ? 'opacity-100' : 'opacity-0'} aria-hidden>{orden.dir === 1 ? '▲' : '▼'}</span>
      </button>
    </th>
  )
}

/** Conteo a la derecha de la barra: «12 de 80 materiales» o «80 materiales». */
export function Conteo({ visibles, total, nombre, hayFiltro }: { visibles: number; total: number; nombre: string; hayFiltro: boolean }): JSX.Element {
  return <span className="ml-auto whitespace-nowrap text-xs text-ink-500">{hayFiltro ? `${visibles} de ${total} ${nombre}` : `${total} ${nombre}`}</span>
}

/** Lo que se ve cuando los filtros no dejan nada (o cuando todavía no hay nada). */
export function SinResultados({ hayFiltro, onLimpiar, vacio }: { hayFiltro: boolean; onLimpiar: () => void; vacio: ReactNode }): JSX.Element {
  return (
    <div className="px-5 py-10 text-center text-sm text-ink-500">
      {hayFiltro ? (
        <>
          <div className="font-medium text-ink-700">Nada coincide con los filtros</div>
          <button type="button" className="btn-secundario mt-3" onClick={onLimpiar}>Quitar filtros</button>
        </>
      ) : (
        vacio
      )}
    </div>
  )
}
