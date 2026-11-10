import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type HorarioSemana } from '../lib/api'
import Encabezado from '../components/Encabezado'
import { DIAS, aMinutos, ahoraMx } from '../lib/tiempo'

export default function Horario(): JSX.Element {
  const [hs, setHs] = useState<HorarioSemana[]>([])
  // La línea roja de «ahora» avanza sola; al volver a la ventana se releen los horarios
  const [ahora, setAhora] = useState(ahoraMx)
  useEffect(() => {
    api.horarios.semana().then(setHs)
    const t = setInterval(() => setAhora(ahoraMx()), 60_000)
    const alVolver = (): void => {
      if (document.hidden) return
      setAhora(ahoraMx())
      api.horarios.semana().then(setHs).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', alVolver)
    window.addEventListener('focus', alVolver)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', alVolver)
      window.removeEventListener('focus', alVolver)
    }
  }, [])
  // Lunes a sábado; el domingo solo aparece si hay clase ese día
  const dias = hs.some((h) => h.dia === 7) ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6]
  const minH = hs.length ? Math.min(...hs.map((h) => aMinutos(h.hora_inicio))) : 7 * 60
  const maxH = hs.length ? Math.max(...hs.map((h) => aMinutos(h.hora_fin))) : 20 * 60
  const inicio = Math.floor(minH / 60) * 60
  const fin = Math.ceil(maxH / 60) * 60
  const horas = Array.from({ length: (fin - inicio) / 60 }, (_, i) => inicio + i * 60)
  const px = 56
  const totalHoras = hs.reduce((s, h) => s + (aMinutos(h.hora_fin) - aMinutos(h.hora_inicio)) / 60, 0)
  const materiasDistintas = new Set(hs.map((h) => h.materia_id)).size

  return (
    <div>
      <Encabezado
        titulo="Horario semanal"
        sub={hs.length ? `${materiasDistintas} ${materiasDistintas === 1 ? 'materia' : 'materias'} · ${hs.length} ${hs.length === 1 ? 'bloque' : 'bloques'} · ${totalHoras.toLocaleString('es-MX', { maximumFractionDigits: 1 })} horas de clase por semana` : 'Sin clases registradas'}
        acciones={<Link to="/fechas" className="btn-secundario">Fechas importantes</Link>}
      />
      <div className="px-4 sm:px-8 py-5">
        {hs.length === 0 ? (
          <div className="tarjeta px-5 py-8 text-center">
            <div className="font-medium text-ink-800">Todavía no hay horario</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Define los días y horas de cada materia en su pestaña Configuración; aquí se arma la semana completa, con la hora actual marcada.</p>
            <Link to="/materias" className="btn-secundario mt-4">Ir a Materias</Link>
          </div>
        ) : (
          // En ventana angosta la cuadrícula se desplaza de lado dentro de la tarjeta, no la página
          <div className="tarjeta overflow-x-auto">
            <div className="grid" style={{ gridTemplateColumns: `56px repeat(${dias.length}, minmax(128px, 1fr))` }}>
              <div className="sticky left-0 z-[3] border-b border-r border-ink-100 bg-ink-50" />
              {dias.map((d) => (
                <div key={d} className={`border-b border-r border-ink-100 px-2 py-2 text-center text-sm font-semibold ${ahora.dia === d ? 'bg-brand-500/10 text-brand-600' : 'bg-ink-50 text-ink-700'}`}>
                  {DIAS[d]}
                  {ahora.dia === d && <span className="ml-1.5 text-[11px] font-medium uppercase tracking-wide">· hoy</span>}
                </div>
              ))}
              {/* La columna de horas queda fija al desplazar de lado */}
              <div className="sticky left-0 z-[3] border-r border-ink-100 bg-white" style={{ height: horas.length * px }}>
                {horas.map((h) => <div key={h} className="absolute left-0 right-0 -translate-y-1/2 pr-2 text-right text-[11px] tabular-nums text-ink-400" style={{ top: ((h - inicio) / 60) * px }}>{String(h / 60).padStart(2, '0')}:00</div>)}
              </div>
              {dias.map((d) => (
                <div key={d} className={`relative border-r border-ink-100 ${ahora.dia === d ? 'bg-brand-500/[0.03]' : ''}`} style={{ height: horas.length * px }}>
                  {horas.map((h) => <div key={h} className="absolute left-0 right-0 border-t border-ink-100" style={{ top: ((h - inicio) / 60) * px }} />)}
                  {hs.filter((h) => h.dia === d).map((h) => {
                    const top = ((aMinutos(h.hora_inicio) - inicio) / 60) * px
                    const alto = ((aMinutos(h.hora_fin) - aMinutos(h.hora_inicio)) / 60) * px
                    // En bloques cortos solo caben nombre y hora; el resto queda en el texto al pasar el mouse
                    const corto = alto < 64
                    return (
                      <Link
                        key={h.id}
                        to={`/materias/${h.materia_id}`}
                        title={`${h.materia_nombre} · ${h.hora_inicio}–${h.hora_fin}${h.carrera_clave ? ` · ${h.carrera_clave}` : ''}${h.aula ? ` · ${h.aula}` : ''}`}
                        className="absolute left-1 right-1 overflow-hidden rounded-lg px-2 py-1.5 text-xs text-white shadow-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-800 focus-visible:ring-offset-1"
                        style={{ top: top + 2, height: alto - 4, background: h.materia_color }}
                      >
                        <div className={`font-semibold leading-tight ${corto ? 'truncate' : 'line-clamp-2'}`}>{h.materia_nombre}</div>
                        <div className="truncate tabular-nums opacity-90">{h.hora_inicio}–{h.hora_fin}</div>
                        {!corto && <div className="truncate opacity-80">{[h.carrera_clave, h.aula].filter(Boolean).join(' · ')}</div>}
                      </Link>
                    )
                  })}
                  {ahora.dia === d && ahora.minutos >= inicio && ahora.minutos <= fin && (
                    <div className="pointer-events-none absolute left-0 right-0 z-[2] border-t-2 border-red-500" style={{ top: ((ahora.minutos - inicio) / 60) * px }} aria-label="Ahora">
                      <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
