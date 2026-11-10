import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { GastoIA as TGasto } from '@shared/types'

const MODELOS: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5'
}

const usd = (n: number): string => `USD ${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`

/** Ajustes › Inteligencia artificial: cuánto se ha gastado en Claude y en qué, para saber qué conviene abaratar. */
export default function GastoIA(): JSX.Element {
  const [dias, setDias] = useState(30)
  const [g, setG] = useState<TGasto | null>(null)
  useEffect(() => {
    api.ia.gasto(dias).then(setG).catch(() => setG(null))
  }, [dias])

  const mayor = Math.max(...(g?.por_uso.map((u) => u.costo_usd) ?? [0]), 0.000001)

  return (
    <section id="ajustes-gasto-ia" className="tarjeta scroll-mt-28 p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-ink-900">Gasto de la IA</h3>
        <select className="input w-auto py-1 text-sm" value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Periodo">
          <option value={7}>Últimos 7 días</option>
          <option value={30}>Últimos 30 días</option>
          <option value={90}>Últimos 90 días</option>
        </select>
      </div>
      {!g ? (
        <p className="text-sm text-ink-500">Cargando…</p>
      ) : g.llamadas === 0 ? (
        <p className="text-sm text-ink-500">Sin peticiones a Claude en este periodo.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-2xl font-semibold text-ink-900 tabular-nums">{usd(g.total_usd)}</span>
            <span className="text-sm text-ink-500">{g.llamadas === 1 ? '1 petición' : `${g.llamadas} peticiones`}</span>
            <span className="flex flex-wrap gap-1.5">
              {g.por_modelo.map((m) => (
                <span key={m.modelo} className="chip bg-ink-100 text-ink-600">{MODELOS[m.modelo] ?? m.modelo} · {usd(m.costo_usd)}</span>
              ))}
            </span>
          </div>
          <ul className="space-y-2">
            {g.por_uso.map((u) => (
              <li key={u.uso} className="text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-ink-800">{u.nombre} <span className="text-xs text-ink-400">· {u.llamadas === 1 ? '1 vez' : `${u.llamadas} veces`}</span></span>
                  <span className="tabular-nums text-ink-700">{usd(u.costo_usd)} <span className="text-xs text-ink-400">({usd(u.costo_usd / u.llamadas)} c/u)</span></span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-ink-100" aria-hidden>
                  <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${Math.max(2, (u.costo_usd / mayor) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
          {g.sin_precio > 0 && <p className="text-xs text-amber-700">{g.sin_precio} petición(es) de un modelo sin precio conocido no suman al total.</p>}
        </>
      )}
      <p className="text-xs text-ink-500">
        Costo aproximado con los precios públicos de Anthropic; la cifra exacta está en console.anthropic.com › Costo. Junta lo de la app de escritorio y lo de la versión web, y empieza a contar desde esta versión.
      </p>
    </section>
  )
}
