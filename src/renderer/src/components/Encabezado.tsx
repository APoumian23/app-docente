import { useEffect, useRef, useState, type ReactNode } from 'react'

export default function Encabezado({ titulo, sub, acciones }: { titulo: string; sub?: ReactNode; acciones?: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Fija arriba solo mientras es baja: con el texto ampliado y muchos botones se volvería una
  // franja que tapa media pantalla, así que entonces se desplaza con el contenido
  const [fija, setFija] = useState(true)
  useEffect(() => {
    const el = ref.current
    const cont = el?.parentElement?.closest('main') ?? null
    if (!el || !cont) return
    const medir = (): void => setFija(el.getBoundingClientRect().height <= cont.getBoundingClientRect().height * 0.22)
    const ro = new ResizeObserver(medir)
    ro.observe(el)
    ro.observe(cont)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={ref} className={`arrastre ${fija ? 'sticky top-0' : 'relative'} z-10 bg-ink-50/90 backdrop-blur border-b border-ink-200 px-4 sm:px-8 pt-5 pb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2`}>
      <div className="min-w-0 flex-[1_1_16rem]">
        <h1 className="text-2xl font-bold text-ink-900 leading-tight break-words">{titulo}</h1>
        {sub && <div className="text-sm text-ink-500 mt-0.5 break-words">{sub}</div>}
      </div>
      {/* Los botones se acomodan en varias filas cuando no caben; si ni así caben junto al título, bajan a su propia fila */}
      {acciones && <div className="no-arrastre flex flex-wrap items-center justify-end gap-2 max-w-full">{acciones}</div>}
    </div>
  )
}
