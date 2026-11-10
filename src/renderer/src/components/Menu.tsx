import { useEffect, useRef, useState } from 'react'

export interface OpcionMenu {
  t: string
  onClick: () => void
  titulo?: string
}

/** Botón con lista desplegable para acciones secundarias; deja la cabecera corta en ventanas angostas. */
export default function Menu({ etiqueta, opciones, className = 'btn-secundario' }: { etiqueta: string; opciones: OpcionMenu[]; className?: string }): JSX.Element {
  const [abierto, setAbierto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!abierto) return
    const fuera = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setAbierto(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAbierto(false)
    }
    window.addEventListener('mousedown', fuera)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', fuera)
      window.removeEventListener('keydown', esc)
    }
  }, [abierto])
  return (
    <div ref={ref} className="relative">
      <button className={className} aria-haspopup="menu" aria-expanded={abierto} onClick={() => setAbierto((a) => !a)}>{etiqueta} ▾</button>
      {abierto && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 min-w-[11rem] tarjeta py-1 shadow-lg">
          {opciones.map((o) => (
            <button key={o.t} role="menuitem" title={o.titulo} className="block w-full text-left px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100 whitespace-nowrap" onClick={() => { setAbierto(false); o.onClick() }}>
              {o.t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
