/**
 * Piezas para filtrar listas del portal (Tareas, Actividades, Materiales, Calendario, Notificaciones).
 * Pensadas para el dedo: todo mide al menos 44 px de alto, los chips se desplazan a lo ancho en el
 * celular (sin desbordar la pantalla) y se acomodan en renglones en pantallas anchas.
 */
import { useState } from 'react'
import { Boton, Vacio } from './ui'

/** Para buscar sin que importen acentos ni mayúsculas («sesion» encuentra «Sesión»). */
export const sinAcentos = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** ¿El texto contiene la búsqueda? (búsqueda vacía = sí) */
export const coincide = (busqueda: string, ...campos: (string | null | undefined)[]): boolean => {
  const q = sinAcentos(busqueda.trim())
  return !q || sinAcentos(campos.filter(Boolean).join(' ')).includes(q)
}

/**
 * Estado que se recuerda mientras la pestaña siga abierta (sessionStorage): al ir a una tarea y
 * regresar, los filtros siguen como estaban. Sin almacenamiento (modo privado) funciona igual, sin recordar.
 */
export function useRecordado<T extends string>(clave: string, inicial: T): [T, (v: T) => void] {
  const llave = `docente-portal.filtro.${clave}`
  const [valor, setValor] = useState<T>(() => {
    try {
      return (sessionStorage.getItem(llave) as T | null) ?? inicial
    } catch {
      return inicial
    }
  })
  const cambiar = (v: T): void => {
    setValor(v)
    try {
      if (v === inicial) sessionStorage.removeItem(llave)
      else sessionStorage.setItem(llave, v)
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
  }
  return [valor, cambiar]
}

/** Buscador con lupa y botón para borrar lo escrito. */
export function Buscador({ valor, onCambio, placeholder = 'Buscar', etiqueta }: { valor: string; onCambio: (v: string) => void; placeholder?: string; etiqueta?: string }): JSX.Element {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lg leading-none text-ink-400" aria-hidden>
        ⌕
      </span>
      <input
        type="search"
        enterKeyHint="search"
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        placeholder={placeholder}
        aria-label={etiqueta ?? placeholder}
        className="min-h-[44px] w-full rounded-xl border border-ink-200 bg-white py-2 pl-9 pr-11 text-base text-ink-800 outline-none placeholder:text-ink-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-400/40 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {valor && (
        <button type="button" onClick={() => onCambio('')} aria-label="Borrar búsqueda" className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-ink-400 hover:text-ink-700">
          ✕
        </button>
      )}
    </div>
  )
}

export interface OpcionFiltro<T extends string> {
  valor: T
  texto: string
  conteo?: number
  /** Punto de color (la materia) antes del texto */
  color?: string
}

/**
 * Renglón de chips de una sola opción (materia, estado, tipo…). En el celular se desplaza a lo ancho
 * de orilla a orilla; desde 640 px se acomoda en varios renglones.
 */
export function FilaChips<T extends string>({ etiqueta, opciones, valor, onCambio }: { etiqueta: string; opciones: OpcionFiltro<T>[]; valor: T; onCambio: (v: T) => void }): JSX.Element {
  return (
    <div role="group" aria-label={etiqueta} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      {opciones.map((o) => {
        const sel = o.valor === valor
        return (
          <button
            key={o.valor}
            type="button"
            aria-pressed={sel}
            onClick={() => onCambio(o.valor)}
            className={`inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 ${
              sel ? 'bg-ink-800 text-white' : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100'
            }`}
          >
            {o.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: o.color }} aria-hidden />}
            <span className="max-w-[13rem] truncate">{o.texto}</span>
            {o.conteo !== undefined && <span className={`tabular-nums ${sel ? 'text-white/75' : 'text-ink-500'}`}>{o.conteo}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** «4 de 12 tareas · Quitar filtros», o solo «12 tareas» si no hay filtro. */
export function ResumenFiltros({ visibles, total, nombre, hayFiltro, onLimpiar }: { visibles: number; total: number; nombre: [string, string]; hayFiltro: boolean; onLimpiar: () => void }): JSX.Element {
  const palabra = (n: number): string => (n === 1 ? nombre[0] : nombre[1])
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-ink-600">
      <span aria-live="polite">{hayFiltro ? `${visibles} de ${total} ${palabra(total)}` : `${total} ${palabra(total)}`}</span>
      {hayFiltro && (
        <button type="button" onClick={onLimpiar} className="-mr-2 min-h-[44px] rounded-xl px-2 font-semibold text-brand-600 hover:bg-ink-100">
          Quitar filtros
        </button>
      )}
    </div>
  )
}

/** Cuando los filtros no dejan nada: lo dice y ofrece quitarlos. */
export function SinResultados({ onLimpiar, detalle = 'Prueba con otra materia u otro estado.' }: { onLimpiar: () => void; detalle?: string }): JSX.Element {
  return (
    <Vacio titulo="Nada coincide con los filtros" detalle={detalle}>
      <Boton variante="secundario" onClick={onLimpiar}>
        Quitar filtros
      </Boton>
    </Vacio>
  )
}
