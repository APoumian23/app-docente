import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { Boton, Cargando, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import type { EstadoAsistencia } from '@shared/types'
import { ErrorServidor, Selector, aIsoDia, partesMx, type MateriaDocente } from './comun'

interface SesionLista {
  id: number
  numero: number
  fecha: string
  hora_inicio: string
  tema: string
  marcados: number
  inscritos: number
}

interface RegistroLista {
  alumno_id: number
  matricula: string
  nombre: string
  apellidos: string
  carrera_id: number | null
  carrera_clave: string
  carrera_nombre: string
  carrera_color: string
  estado: EstadoAsistencia | null
  hora: string
  nota: string
}

const BOTONES: { e: EstadoAsistencia; t: string; corto: string; activo: string }[] = [
  { e: 'presente', t: 'Presente', corto: '✓', activo: 'bg-emerald-600 text-white border-emerald-600' },
  { e: 'retardo', t: 'Retardo', corto: '⏱', activo: 'bg-amber-500 text-white border-amber-500' },
  { e: 'ausente', t: 'Falta', corto: '✗', activo: 'bg-red-600 text-white border-red-600' },
  { e: 'justificado', t: 'Justificada', corto: 'J', activo: 'bg-sky-600 text-white border-sky-600' }
]

const fechaClase = (s: SesionLista): string => {
  const d = new Date(`${s.fecha}T12:00:00Z`)
  const dia = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d)
  return `${dia} · ${s.hora_inicio.slice(0, 5)} · clase ${s.numero}${s.tema ? ` · ${s.tema}` : ''}`
}

/** Pase de lista desde el celular: elige la clase (hoy por omisión) y marca a cada alumno con un toque. */
export default function Asistencia(): JSX.Element {
  const { materiaId: idTexto } = useParams()
  const materiaId = Number(idTexto)
  const [materia, setMateria] = useState<MateriaDocente | null>(null)
  const [sesiones, setSesiones] = useState<SesionLista[] | null>(null)
  const [sesionId, setSesionId] = useState<number | null>(null)
  const [lista, setLista] = useState<RegistroLista[] | null>(null)
  const [error, setError] = useState('')
  const [ocupado, setOcupado] = useState<number | 'todos' | null>(null)
  // Grupo con alumnos de varias carreras en la misma materia: se pasa lista por carrera
  const [carrera, setCarrera] = useState<number | null>(null)

  useEffect(() => {
    Promise.all([api<MateriaDocente[]>('/docente/materias'), api<SesionLista[]>(`/docente/materias/${materiaId}/sesiones`)])
      .then(([ms, ss]) => {
        setMateria(ms.find((m) => m.id === materiaId) ?? null)
        setSesiones(ss)
        // La de hoy si hay; si no, la más reciente que ya pasó
        const p = partesMx()
        const hoy = aIsoDia(p.anio, p.mes, p.dia)
        setSesionId((ss.find((s) => s.fecha === hoy) ?? ss.find((s) => s.fecha <= hoy) ?? ss[ss.length - 1])?.id ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [materiaId])

  const cargarLista = useCallback((): void => {
    if (!sesionId) return
    setLista(null)
    api<{ registros: RegistroLista[] }>(`/docente/sesiones/${sesionId}/asistencia`)
      .then((r) => setLista(r.registros))
      .catch((e: Error) => setError(e.message))
  }, [sesionId])
  useEffect(cargarLista, [cargarLista])

  const actualizar = (registros: RegistroLista[]): void => {
    setLista(registros)
    const marcados = registros.filter((r) => r.estado !== null).length
    setSesiones((ss) => ss?.map((s) => (s.id === sesionId ? { ...s, marcados } : s)) ?? ss)
  }

  const marcar = async (r: RegistroLista, estado: EstadoAsistencia): Promise<void> => {
    if (!sesionId || ocupado !== null) return
    if (estado === 'justificado') return justificar(r)
    setOcupado(r.alumno_id)
    // Se ve de inmediato; si falla, se recarga la lista
    setLista((l) => l?.map((x) => (x.alumno_id === r.alumno_id ? { ...x, estado } : x)) ?? l)
    try {
      actualizar((await api<{ registros: RegistroLista[] }>(`/docente/sesiones/${sesionId}/asistencia`, { metodo: 'PUT', cuerpo: { alumno_id: r.alumno_id, estado } })).registros)
    } catch (e) {
      avisar((e as Error).message, 'error')
      cargarLista()
    } finally {
      setOcupado(null)
    }
  }

  const justificar = async (r: RegistroLista): Promise<void> => {
    if (!sesionId) return
    if (r.estado === null) return avisar('Primero márcalo como falta o retardo; luego se justifica.', 'info')
    const motivo = window.prompt(`Motivo de la justificación de ${r.nombre} ${r.apellidos}:`)
    if (!motivo?.trim()) return
    setOcupado(r.alumno_id)
    try {
      actualizar((await api<{ registros: RegistroLista[] }>(`/docente/sesiones/${sesionId}/asistencia/justificar`, { metodo: 'POST', cuerpo: { alumno_id: r.alumno_id, motivo } })).registros)
      avisar('Justificada')
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(null)
    }
  }

  const todos = async (estado: 'presente' | 'ausente'): Promise<void> => {
    if (!sesionId) return
    setOcupado('todos')
    try {
      const r = await api<{ marcados: number; registros: RegistroLista[] }>(`/docente/sesiones/${sesionId}/asistencia/todos`, { metodo: 'POST', cuerpo: { estado, carrera_id: carrera } })
      actualizar(r.registros)
      avisar(r.marcados ? `${r.marcados} marcado(s) como ${estado === 'presente' ? 'presentes' : 'ausentes'}` : 'Todos ya tenían registro')
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(null)
    }
  }

  const carreras = useMemo(() => {
    const m = new Map<number, { id: number; clave: string; nombre: string; color: string; n: number }>()
    for (const r of lista ?? []) {
      if (r.carrera_id === null) continue
      const c = m.get(r.carrera_id) ?? { id: r.carrera_id, clave: r.carrera_clave, nombre: r.carrera_nombre, color: r.carrera_color, n: 0 }
      c.n++
      m.set(r.carrera_id, c)
    }
    return [...m.values()]
  }, [lista])
  const visibles = useMemo(() => (lista ?? []).filter((r) => carrera === null || r.carrera_id === carrera), [lista, carrera])
  const cuenta = useMemo(() => {
    const c = { presente: 0, retardo: 0, ausente: 0, justificado: 0, sin: 0 }
    for (const r of visibles) c[r.estado ?? 'sin']++
    return c
  }, [visibles])

  if (error && !sesiones) return <ErrorServidor texto={error} />
  if (!sesiones) return <Cargando texto="Cargando clases…" />

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link to={`/docente/materias/${materiaId}`} className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← {materia?.nombre ?? 'Materia'}</Link>
        <h2 className="text-xl font-bold text-ink-900">Pase de lista</h2>
      </div>
      {sesiones.length === 0 ? (
        <Vacio titulo="Esta materia no tiene clases programadas" detalle="Las clases se generan en la app de escritorio, en el horario de la materia." />
      ) : (
        <>
          <Selector etiqueta="Clase" value={sesionId ?? ''} onChange={(e) => setSesionId(Number(e.target.value))}>
            {sesiones.map((s) => (
              <option key={s.id} value={s.id}>
                {fechaClase(s)} ({s.marcados}/{s.inscritos})
              </option>
            ))}
          </Selector>
          {carreras.length > 1 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Carrera">
              <button type="button" onClick={() => setCarrera(null)} aria-pressed={carrera === null} className={`min-h-[40px] rounded-xl border px-3 text-sm font-semibold ${carrera === null ? 'border-ink-800 bg-ink-800 text-white' : 'border-ink-200 bg-white text-ink-700'}`}>
                Todas ({lista?.length ?? 0})
              </button>
              {carreras.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCarrera(c.id)}
                  aria-pressed={carrera === c.id}
                  title={c.nombre}
                  className="min-h-[40px] rounded-xl border px-3 text-sm font-semibold"
                  style={carrera === c.id ? { backgroundColor: c.color, borderColor: c.color, color: '#fff' } : { borderColor: `${c.color}66`, color: c.color }}
                >
                  {c.clave} ({c.n})
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-800">✓ {cuenta.presente} presentes</span>
            <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-800">⏱ {cuenta.retardo} retardos</span>
            <span className="rounded-full bg-red-50 px-2 py-1 text-red-800">✗ {cuenta.ausente} faltas</span>
            <span className="rounded-full bg-sky-50 px-2 py-1 text-sky-800">J {cuenta.justificado} justificadas</span>
            {cuenta.sin > 0 && <span className="rounded-full bg-ink-100 px-2 py-1 text-ink-700">{cuenta.sin} sin marcar</span>}
          </div>
          {cuenta.sin > 0 && (
            <div className="flex flex-wrap gap-2">
              <Boton className="flex-1" disabled={ocupado !== null} onClick={() => void todos('presente')}>
                Marcar presentes a los {cuenta.sin} sin marcar{carrera !== null ? ` de ${carreras.find((c) => c.id === carrera)?.clave ?? ''}` : ''}
              </Boton>
              <Boton variante="secundario" disabled={ocupado !== null} onClick={() => void todos('ausente')}>
                Ausentes
              </Boton>
            </div>
          )}
          {lista === null ? (
            <Cargando texto="Cargando lista…" />
          ) : (
            <Tarjeta className="divide-y divide-ink-100 p-0">
              {visibles.map((r) => (
                <div key={r.alumno_id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-[1_1_10rem]">
                    <div className="break-words text-sm font-medium text-ink-900">
                      {r.apellidos} {r.nombre}
                      {carreras.length > 1 && r.carrera_clave && (
                        <span className="ml-1.5 rounded px-1.5 py-0.5 align-middle text-[10px] font-bold" style={{ color: r.carrera_color, backgroundColor: `${r.carrera_color}18` }} title={r.carrera_nombre}>
                          {r.carrera_clave}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-ink-400">
                      {r.matricula || 'sin matrícula'}
                      {r.hora ? ` · ${r.hora}` : ''}
                      {r.nota ? ` · ${r.nota}` : ''}
                    </div>
                  </div>
                  <div className="flex gap-1" role="group" aria-label={`Asistencia de ${r.nombre}`}>
                    {BOTONES.map((b) => (
                      <button
                        key={b.e}
                        type="button"
                        title={b.t}
                        aria-label={b.t}
                        aria-pressed={r.estado === b.e}
                        disabled={ocupado !== null}
                        onClick={() => void marcar(r, b.e)}
                        className={`h-11 w-11 rounded-xl border text-base font-bold transition ${r.estado === b.e ? b.activo : 'border-ink-200 bg-white text-ink-500 hover:bg-ink-50'}`}
                      >
                        {b.corto}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </Tarjeta>
          )}
          <p className="text-xs text-ink-500">Se guarda al tocar. Con el portal en línea, tu app de escritorio lo recibe en el siguiente minuto.</p>
        </>
      )}
    </div>
  )
}
