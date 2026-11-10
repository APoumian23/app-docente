import { fmtMinSeg } from '../lib/tiempo'

/**
 * Reloj circular de cuenta regresiva. Ocupa el lado menor del contenedor más cercano con
 * `container-type: size` (hasta `max` px) y los números escalan con el círculo, así cabe en
 * ventanas bajas y con el texto ampliado.
 */
export default function Reloj({ restante, total, color = '#2d6df6', grande = true }: { restante: number; total: number; color?: string; grande?: boolean }): JSX.Element {
  const r = 120
  const c = 2 * Math.PI * r
  const frac = total > 0 ? Math.max(0, Math.min(1, restante / total)) : 0
  const critico = restante <= 60 && restante > 0
  const max = grande ? 320 : 180
  const tam = `min(100cqw, 100cqh, ${max}px)`
  return (
    <div className="relative shrink-0" style={{ width: tam, height: tam, containerType: 'inline-size' }} role="timer" aria-label={`Quedan ${fmtMinSeg(restante)}`}>
      <svg viewBox="0 0 280 280" width="100%" height="100%" className="-rotate-90">
        <circle cx="140" cy="140" r={r} fill="none" stroke="#e9edf3" strokeWidth="14" />
        <circle cx="140" cy="140" r={r} fill="none" stroke={critico ? '#ef4444' : color} strokeWidth="14" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: 'stroke-dashoffset 0.9s linear, stroke 0.3s' }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className={`font-mono font-semibold tabular-nums leading-none ${critico ? 'text-red-600 pulso' : restante <= 0 ? 'text-red-600' : 'text-ink-900'}`} style={{ fontSize: '21cqw' }}>{fmtMinSeg(restante)}</div>
        {grande && <div className="text-ink-400 mt-1" style={{ fontSize: 'max(11px, 4.4cqw)' }}>de {Math.round(total / 60)} min</div>}
      </div>
    </div>
  )
}
