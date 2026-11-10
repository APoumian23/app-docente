import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fechaMx } from '../../lib/api'
import { Boton, Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio } from '../../componentes/ui'
import type { AvanceMateria } from '@shared/avance'

/** Hoy en Ciudad de México (YYYY-MM-DD): abre el parcial en curso */
const hoyMx = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
const nota = (v: number | null): string => (v == null ? '—' : v.toFixed(1))
const TONO_ESTADO: Record<string, 'verde' | 'rojo' | 'ambar' | 'gris'> = { aprobado: 'verde', reprobado: 'rojo', na_inasistencia: 'rojo', pendiente: 'gris' }
const TONO_RIESGO: Record<string, 'verde' | 'ambar' | 'rojo'> = { ok: 'verde', atencion: 'ambar', extraordinario: 'rojo', titulo: 'rojo', recursa: 'rojo' }

/** Todo lo del alumno en un lugar: calificaciones por parcial, faltas, lo que necesita y próximas fechas. */
export default function MiAvance(): JSX.Element {
  const [datos, setDatos] = useState<{ visible: boolean; materias: AvanceMateria[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cargar = useCallback((): void => {
    setError(null)
    api<{ visible: boolean; materias: AvanceMateria[] }>('/alumno/avance')
      .then(setDatos)
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(cargar, [cargar])

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <EncabezadoPagina titulo="Mi avance">
        <Link to="/calificaciones" className="inline-flex min-h-[44px] items-center rounded-xl px-3 text-sm font-semibold text-brand-600 hover:bg-ink-100">Mis entregas del portal →</Link>
        <Boton variante="fantasma" onClick={cargar} aria-label="Recargar">
          <span aria-hidden>↻</span> Recargar
        </Boton>
      </EncabezadoPagina>
      {error && <ErrorCarga titulo="No se pudo cargar tu avance" detalle={error} onReintentar={cargar} />}
      {!datos && !error && <Cargando texto="Calculando tu avance…" />}
      {datos && !datos.visible && (
        <Vacio icono="⭐" titulo="Tu docente aún no publica el avance" detalle="Por ahora revisa tus entregas en «Mis entregas del portal».">
          <Link to="/calificaciones" className="inline-flex min-h-[44px] items-center rounded-xl border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100">Ver mis entregas</Link>
        </Vacio>
      )}
      {datos?.visible && datos.materias.length === 0 && <Vacio icono="📚" titulo="No estás inscrito en ninguna materia" detalle="Si crees que es un error, avísale a tu docente." />}

      {datos?.materias.map((m) => (
        <Tarjeta key={m.id} className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="flex min-w-0 items-center gap-2 text-base font-bold text-ink-900">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
              <span className="break-words">{m.nombre}</span>
            </h3>
            {m.minima != null && <span className="text-xs text-ink-600">Mínima aprobatoria {m.minima.toFixed(1)}</span>}
          </div>

          {/* Resumen en cifras (solo si no deja ver un parcial que tu docente aún no publica) */}
          {!m.resumen_visible ? (
            <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-600">Tu final y lo que necesitas para aprobar aparecerán cuando tu docente publique el parcial que está calificando.</p>
          ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Cifra valor={nota(m.al_ritmo_actual)} etiqueta="Final si sigues igual" />
            <Cifra valor={`${Math.round(m.evaluado_pct)} %`} etiqueta="Del curso ya evaluado" />
            <Cifra
              valor={m.situacion === 'ya_aprobado' ? '✓' : m.necesita != null ? nota(m.necesita) : '—'}
              etiqueta={m.situacion === 'ya_aprobado' ? 'Ya alcanzas la mínima' : m.situacion === 'imposible' ? 'Ya no alcanza con lo que falta' : 'Necesitas en lo que falta'}
            />
          </div>
          )}

          {/* Faltas según el comunicado de asistencias */}
          <div className={`rounded-xl border p-3 text-sm ${m.asistencia.riesgo === 'ok' ? 'border-ink-200' : m.asistencia.riesgo === 'atencion' ? 'border-amber-300 bg-amber-50' : 'border-red-300 bg-red-50'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Faltas</span>
              <Chip tono={TONO_RIESGO[m.asistencia.riesgo]}>{m.asistencia.etiqueta}</Chip>
              {m.asistencia.porcentaje != null && <span className="text-ink-500">Asistencia {Math.round(m.asistencia.porcentaje)} %</span>}
            </div>
            <div className="mt-1 text-ink-700">
              Llevas <b>{m.asistencia.horas_falta} h</b> de falta. Límite: {m.asistencia.limite} h · extraordinario desde {m.asistencia.extraordinario} h · recursas con {m.asistencia.recursa} h.
            </div>
            {m.asistencia.siguiente && <div className="mt-1 text-ink-500">{m.asistencia.siguiente}.</div>}
            {m.asistencia.sin_lista > 0 && (
              <div className="mt-1 text-ink-500">
                Hay {m.asistencia.sin_lista === 1 ? '1 clase' : `${m.asistencia.sin_lista} clases`} sin pase de lista registrado todavía: tus faltas pueden cambiar cuando tu docente las capture.
              </div>
            )}
          </div>

          {/* Parciales con el detalle de cada parte */}
          {m.parciales.length === 0 ? (
            <p className="text-sm text-ink-500">Tu docente aún no define cómo se califica esta materia.</p>
          ) : (
            <div className="space-y-2">
              {m.parciales.map((p) =>
                !p.publicado ? (
                  <div key={p.nombre} className="flex min-h-[48px] flex-wrap items-center gap-2 rounded-xl border border-dashed border-ink-200 px-3 py-2 text-sm">
                    <span className="font-semibold">{p.nombre}</span>
                    <Chip>En captura</Chip>
                    <span className="text-ink-500">Tu docente lo publicará cuando termine de calificar.</span>
                  </div>
                ) : (
                <details key={p.nombre} className="group rounded-xl border border-ink-200" open={p.desde <= hoyMx() && hoyMx() <= p.hasta}>
                  <summary className="flex min-h-[48px] cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                    <span className="font-semibold">{p.nombre}</span>
                    <span className="text-lg font-bold tabular-nums">{nota(p.calificacion)}</span>
                    <Chip tono={TONO_ESTADO[p.estado] ?? 'gris'}>{p.etiqueta}</Chip>
                    {p.provisional && p.calificacion != null && <span className="text-xs text-ink-500">provisional</span>}
                    {p.desde && <span className="ml-auto text-xs text-ink-500">{fechaCorta(p.desde)} – {fechaCorta(p.hasta)}</span>}
                    <span className="text-ink-400 transition-transform duration-150 group-open:rotate-180" aria-hidden>⌄</span>
                  </summary>
                  <ul className="divide-y divide-ink-100 border-t border-ink-100 text-sm">
                    {p.componentes.map((c) => (
                      <li key={c.nombre} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                        <span className="min-w-0 flex-1 break-words">{c.nombre} <span className="text-ink-500">· {c.peso} %</span></span>
                        <span className="font-mono tabular-nums">{c.valor == null ? 'pendiente' : nota(c.valor)}</span>
                        <span className="w-full text-xs text-ink-500 break-words">{c.detalle}</span>
                      </li>
                    ))}
                  </ul>
                </details>
                )
              )}
              <p className="text-xs text-ink-500">«Pendiente» no cuenta como cero: la calificación se reparte entre lo ya evaluado y se marca provisional.</p>
            </div>
          )}

          {m.proximas.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-semibold">Próximas fechas</div>
              <ul className="space-y-1 text-sm">
                {m.proximas.map((f) => (
                  <li key={f.fecha + f.titulo} className="flex flex-wrap gap-x-3">
                    <span className="w-24 shrink-0 text-ink-500">{fechaCorta(f.fecha)}{f.fecha_fin && f.fecha_fin !== f.fecha ? ` – ${fechaCorta(f.fecha_fin)}` : ''}</span>
                    <span className="min-w-0 flex-1 break-words">{f.titulo}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Tarjeta>
      ))}
      {datos?.visible && datos.materias.length > 0 && <p className="text-center text-xs text-ink-500">Calculado el {fechaMx(new Date().toISOString())} con lo que tu docente lleva capturado.</p>}
    </div>
  )
}

function Cifra({ valor, etiqueta }: { valor: string; etiqueta: string }): JSX.Element {
  return (
    <div className="rounded-xl bg-ink-50 px-3 py-2">
      <div className="text-xl font-bold tabular-nums text-ink-900">{valor}</div>
      <div className="text-xs text-ink-500">{etiqueta}</div>
    </div>
  )
}

const fechaCorta = (f: string): string => new Date(f + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '')
