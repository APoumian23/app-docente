import { useEffect, useId, useRef, type ReactNode } from 'react'

export default function Modal({ titulo, abierto, onCerrar, children, ancho = 'max-w-xl' }: { titulo: string; abierto: boolean; onCerrar: () => void; children: ReactNode; ancho?: string }): JSX.Element | null {
  const idTitulo = useId()
  const cerrar = useRef(onCerrar)
  cerrar.current = onCerrar
  // Esc cierra; con varios modales abiertos solo el de más arriba
  useEffect(() => {
    if (!abierto) return
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const dialogos = document.querySelectorAll('[role=dialog]')
      if (dialogos[dialogos.length - 1]?.getAttribute('aria-labelledby') !== idTitulo) return
      e.preventDefault()
      cerrar.current()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [abierto, idTitulo])
  if (!abierto) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div role="dialog" aria-modal="true" aria-labelledby={idTitulo} className={`tarjeta w-full max-h-[calc(88vh/var(--zoom,1))] ${ancho} overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 border-b border-ink-100 px-5 py-3">
          <h3 id={idTitulo} className="font-semibold min-w-0 break-words">{titulo}</h3>
          <button className="btn-fantasma px-2 shrink-0" onClick={onCerrar} aria-label="Cerrar" title="Cerrar (Esc)">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}
