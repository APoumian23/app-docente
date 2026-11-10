import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { Boton, Cargando, Vacio, avisar } from '../../componentes/ui'
import { ErrorServidor, type MateriaDocente } from './comun'
import { InvitacionNotificaciones } from '../../componentes/Notificar'
import { periodoTerminado } from '@shared/periodo'
import { irAlApp, useSesion } from '../../lib/sesion'

/** Inicio del docente: sus materias agrupadas por carrera, con acceso rápido a las entregas. */
export default function Inicio(): JSX.Element {
  const [materias, setMaterias] = useState<MateriaDocente[] | null>(null)
  const [error, setError] = useState('')
  const [ocupada, setOcupada] = useState<number | null>(null)
  const [mostrarOcultas, setMostrarOcultas] = useState(false)
  // Partidas del juego aún abiertas: si se cerró su ventana, desde aquí se retoman
  const [partidas, setPartidas] = useState<{ pin: string; estado: string; titulo: string; materia_nombre: string; jugadores: number }[]>([])
  useEffect(() => {
    api<typeof partidas>('/docente/partidas').then(setPartidas).catch(() => undefined)
  }, [])

  const cargar = async (): Promise<void> => {
    try {
      setMaterias(await api<MateriaDocente[]>('/docente/materias'))
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setMaterias([])
    }
  }
  useEffect(() => {
    cargar()
  }, [])

  const alternar = async (m: MateriaDocente): Promise<void> => {
    setOcupada(m.id)
    try {
      await api(`/docente/materias/${m.id}`, { metodo: 'PATCH', cuerpo: { oculta: !m.oculta } })
      setMaterias((lista) => (lista ?? []).map((x) => (x.id === m.id ? { ...x, oculta: m.oculta ? 0 : 1 } : x)))
      avisar(m.oculta ? `"${m.nombre}" vuelve a mostrarse` : `"${m.nombre}" quedó oculta`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupada(null)
    }
  }

  if (materias === null) return <Cargando texto="Cargando materias…" />

  const visibles = materias.filter((m) => !m.oculta)
  const ocultas = materias.filter((m) => m.oculta)
  const porCarrera = new Map<string, MateriaDocente[]>()
  for (const m of visibles) {
    const clave = m.carrera_nombre ?? 'Sin carrera'
    porCarrera.set(clave, [...(porCarrera.get(clave) ?? []), m])
  }

  const incrustado = (() => {
    try {
      return sessionStorage.getItem('docente.incrustado') === '1'
    } catch {
      return false
    }
  })()

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <InvitacionNotificaciones />
      {partidas.length > 0 && (
        <section className="rounded-2xl border border-violet-200 bg-violet-50 p-4">
          <h2 className="mb-2 font-semibold text-violet-900">Juegos en vivo abiertos</h2>
          <ul className="space-y-2">
            {partidas.map((p) => (
              <li key={p.pin} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-bold tracking-widest">{p.pin}</span>
                <span className="min-w-0 flex-1 break-words">{p.titulo} <span className="text-ink-500">· {p.materia_nombre} · {p.jugadores} jugador{p.jugadores === 1 ? '' : 'es'} · {p.estado === 'lobby' ? 'esperando' : 'en juego'}</span></span>
                <Link to={`/docente/juego/${p.pin}`} className="inline-flex min-h-[40px] items-center rounded-xl bg-violet-600 px-3 font-semibold text-white hover:bg-violet-700">Volver a la partida</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Mis materias</h2>
          <p className="text-sm text-ink-500">
            {materias.length === 0 ? 'Todavía no hay materias.' : `${visibles.length} visible${visibles.length === 1 ? '' : 's'}${ocultas.length ? ` · ${ocultas.length} oculta${ocultas.length === 1 ? '' : 's'}` : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* La app de escritorio completa en el navegador; dentro de la app (incrustado) no hace falta */}
          {!incrustado && (
            <a href="/" onClick={(e) => { e.preventDefault(); irAlApp(useSesion.getState().usuario) }} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-800 hover:bg-ink-50">
              🖥️ App completa
            </a>
          )}
          <Link to="/docente/entregas" className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">
            📥 Ver entregas
          </Link>
        </div>
      </div>

      <ErrorServidor texto={error} />

      {materias.length === 0 && !error && <Vacio titulo="No hay materias registradas" detalle="Las materias se crean desde la aplicación de escritorio y aparecen aquí automáticamente." />}
      {materias.length > 0 && visibles.length === 0 && <Vacio titulo="Todas tus materias están ocultas" detalle="Ábrelas desde la sección de abajo para volver a mostrarlas." />}

      {/* Las carreras lado a lado: cada una pide el ancho de sus tarjetas (16rem cada una) y la que tiene muchas toma su renglón */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-6">
        {[...porCarrera.entries()].map(([carrera, lista]) => {
          const k = Math.max(1, lista.length)
          return (
            <section key={carrera} className="min-w-0" style={{ flex: `${k} 1 min(100%, calc(${k} * 16rem + ${k - 1} * 0.75rem))` }}>
              {/* Un solo renglón: así las tarjetas de carreras vecinas arrancan a la misma altura */}
              <h3 className="mb-3 truncate text-xs font-bold uppercase tracking-widest text-ink-400" title={carrera}>{carrera}</h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {lista.map((m) => (
                  <TarjetaMateria key={m.id} materia={m} ocupada={ocupada === m.id} onAlternar={() => alternar(m)} />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {ocultas.length > 0 && (
        <section className="rounded-2xl border border-dashed border-ink-200 p-2">
          <button type="button" onClick={() => setMostrarOcultas((v) => !v)} className="flex min-h-[44px] w-full items-center justify-between rounded-xl px-3 text-left text-sm font-semibold text-ink-600 hover:bg-ink-100" aria-expanded={mostrarOcultas}>
            <span>Materias ocultas ({ocultas.length})</span>
            <span className="text-ink-400">{mostrarOcultas ? '▲' : '▼'}</span>
          </button>
          {mostrarOcultas && (
            <div className="grid gap-3 p-2 sm:grid-cols-2 lg:grid-cols-3">
              {ocultas.map((m) => (
                <TarjetaMateria key={m.id} materia={m} ocupada={ocupada === m.id} onAlternar={() => alternar(m)} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function TarjetaMateria({ materia: m, ocupada, onAlternar }: { materia: MateriaDocente; ocupada: boolean; onAlternar: () => void }): JSX.Element {
  // Ocultar = archivarla: se ofrece al terminar su periodo; una ya oculta siempre se puede volver a mostrar
  const ofrecer = Boolean(m.oculta) || periodoTerminado(m.periodo_inicio ? { fecha_inicio: m.periodo_inicio, semanas: m.periodo_semanas ?? 15 } : null)
  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm ${m.oculta ? 'opacity-70' : ''}`}>
      <div className="h-1.5" style={{ backgroundColor: m.color || '#2d6df6' }} />
      <Link to={`/docente/materias/${m.id}`} className="flex flex-1 flex-col gap-2 p-4 hover:bg-ink-50">
        <div className="min-w-0">
          <div className="break-words font-semibold leading-snug text-ink-900">{m.nombre}</div>
          <div className="mt-0.5 text-xs text-ink-500">
            {m.clave} · {m.cuatrimestre}° cuatrimestre
          </div>
        </div>
        <div className="mt-auto text-sm text-ink-600">
          <span className="font-semibold text-ink-900">{m.inscritos}</span> {m.inscritos === 1 ? 'alumno inscrito' : 'alumnos inscritos'}
        </div>
      </Link>
      <div className="grid grid-cols-2 border-t border-ink-100">
        <Link to={`/docente/asistencia/${m.id}`} className="flex min-h-[44px] items-center justify-center text-sm font-semibold text-emerald-700 hover:bg-emerald-50">✓ Pasar lista</Link>
        <Link to={`/docente/calificaciones/${m.id}`} className="flex min-h-[44px] items-center justify-center border-l border-ink-100 text-sm font-semibold text-brand-600 hover:bg-brand-500/5">★ Calificaciones</Link>
      </div>
      {ofrecer ? (
        <div className="border-t border-ink-100 px-2 py-1">
          <Boton variante="fantasma" className="w-full text-xs" onClick={onAlternar} disabled={ocupada} title={m.oculta ? 'Mostrarla de nuevo' : 'Terminó su periodo: archivarla (sus datos se conservan)'}>
            {ocupada ? 'Guardando…' : m.oculta ? 'Mostrar' : 'Ocultar'}
          </Boton>
        </div>
      ) : null}
    </div>
  )
}
