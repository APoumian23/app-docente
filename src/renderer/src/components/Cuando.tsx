import { sumarDias } from '../lib/tiempo'

/** «Hoy», «Mañana», «En curso» o «en N días», siempre en la misma columna. */
export default function Cuando({ fecha, fin, hoy }: { fecha: string; fin?: string | null; hoy: string }): JSX.Element {
  if (fecha <= hoy && (fin ?? fecha) >= hoy) return <span className="chip bg-brand-500 text-white">{(fin ?? fecha) > hoy && fecha < hoy ? 'En curso' : 'Hoy'}</span>
  if (fecha === sumarDias(hoy, 1)) return <span className="chip bg-amber-500 text-white">Mañana</span>
  if (fecha < hoy) return <span className="text-xs text-ink-400">pasó</span>
  const dias = Math.round((new Date(fecha + 'T12:00:00').getTime() - new Date(hoy + 'T12:00:00').getTime()) / 86_400_000)
  return <span className="text-xs text-ink-500 whitespace-nowrap">en {dias} días</span>
}
