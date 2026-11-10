import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { Boton, Cargando, Modal, Vacio, avisar } from '../../componentes/ui'
import { ETIQUETA_ESTADO_CALIF, type Componente, type EstadoCalif, type Esquema, type ResultadoAlumno } from '@shared/esquema'
import { ErrorServidor, type MateriaDocente } from './comun'

interface CalificacionesWeb {
  esquema: Esquema | null
  alumnos: { id: number; matricula: string; nombre: string; apellidos: string; activo: number }[]
  resultados: ResultadoAlumno[]
  capturas: { componente_id: number; alumno_id: number; rubro: number; valor: number | null }[]
}

const COLOR: Record<EstadoCalif, string> = {
  aprobado: 'text-emerald-700',
  reprobado: 'text-red-700',
  na_inasistencia: 'text-red-700',
  pendiente: 'text-ink-500'
}
const uno = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))

/** Calificaciones de la materia: cada parcial con sus componentes y la final. Tocar una celda abre la captura a mano. */
export default function Calificaciones(): JSX.Element {
  const { materiaId: idTexto } = useParams()
  const materiaId = Number(idTexto)
  const [materia, setMateria] = useState<MateriaDocente | null>(null)
  const [datos, setDatos] = useState<CalificacionesWeb | null>(null)
  const [error, setError] = useState('')
  const [vista, setVista] = useState<number | 'final'>('final')
  const [captura, setCaptura] = useState<{ alumnoId: number; comp: Componente } | null>(null)

  useEffect(() => {
    Promise.all([api<MateriaDocente[]>('/docente/materias'), api<CalificacionesWeb>(`/docente/materias/${materiaId}/calificaciones`)])
      .then(([ms, d]) => {
        setMateria(ms.find((m) => m.id === materiaId) ?? null)
        setDatos(d)
        // Abre en el parcial en curso (el último que ya empezó)
        const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
        const enCurso = [...(d.esquema?.parciales ?? [])].reverse().find((p) => p.desde <= hoy)
        if (enCurso) setVista(enCurso.id)
      })
      .catch((e: Error) => setError(e.message))
  }, [materiaId])

  const alumnos = useMemo(() => (datos?.alumnos ?? []).filter((a) => a.activo), [datos])
  const resultadoDe = (id: number): ResultadoAlumno | undefined => datos?.resultados.find((r) => r.alumno_id === id)

  if (error && !datos) return <ErrorServidor texto={error} />
  if (!datos) return <Cargando texto="Calculando calificaciones…" />
  const esquema = datos.esquema
  const parcial = esquema?.parciales.find((p) => p.id === vista)

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <Link to={`/docente/materias/${materiaId}`} className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← {materia?.nombre ?? 'Materia'}</Link>
        <h2 className="text-xl font-bold text-ink-900">Calificaciones</h2>
      </div>
      {!esquema ? (
        <Vacio titulo="Esta materia aún no tiene esquema de calificación" detalle="Arma el esquema (parciales y componentes) en la app de escritorio." />
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="tablist">
            {esquema.parciales.map((p) => (
              <button key={p.id} role="tab" aria-selected={vista === p.id} onClick={() => setVista(p.id)} className={`min-h-[40px] rounded-xl border px-3 text-sm font-semibold ${vista === p.id ? 'border-ink-800 bg-ink-800 text-white' : 'border-ink-200 bg-white text-ink-700'}`}>
                {p.nombre}
              </button>
            ))}
            <button role="tab" aria-selected={vista === 'final'} onClick={() => setVista('final')} className={`min-h-[40px] rounded-xl border px-3 text-sm font-semibold ${vista === 'final' ? 'border-ink-800 bg-ink-800 text-white' : 'border-ink-200 bg-white text-ink-700'}`}>
              Final
            </button>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="bg-ink-50 text-left text-xs text-ink-600">
                  <th className="sticky left-0 z-[1] min-w-[11rem] border-b border-ink-200 bg-ink-50 px-3 py-2">Alumno</th>
                  {parcial
                    ? parcial.componentes.map((c) => (
                        <th key={c.id} className="min-w-[6rem] border-b border-ink-200 px-2 py-2 align-bottom">
                          <div className="font-semibold text-ink-800">{c.nombre}</div>
                          <div>{c.peso} %</div>
                        </th>
                      ))
                    : esquema.parciales.map((p) => (
                        <th key={p.id} className="min-w-[5rem] border-b border-ink-200 px-2 py-2">
                          {p.nombre} <span className="font-normal">({p.peso} %)</span>
                        </th>
                      ))}
                  <th className="min-w-[6rem] border-b border-ink-200 px-2 py-2">{parcial ? 'Parcial' : 'Final'}</th>
                </tr>
              </thead>
              <tbody>
                {alumnos.map((a) => {
                  const r = resultadoDe(a.id)
                  const rp = parcial ? r?.parciales.find((x) => x.parcial_id === parcial.id) : undefined
                  const total = parcial ? rp : r
                  return (
                    <tr key={a.id}>
                      <th scope="row" className="sticky left-0 z-[1] border-b border-ink-100 bg-white px-3 py-2 text-left font-medium">
                        <div className="break-words leading-tight">{a.apellidos} {a.nombre}</div>
                      </th>
                      {parcial
                        ? parcial.componentes.map((c) => {
                            const v = rp?.componentes.find((x) => x.componente_id === c.id)
                            const aMano = datos.capturas.some((x) => x.componente_id === c.id && x.alumno_id === a.id && x.valor !== null)
                            return (
                              <td key={c.id} className="border-b border-ink-100 px-1 py-1">
                                <button
                                  className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-ink-50"
                                  title={v?.detalle || 'Capturar a mano'}
                                  onClick={() => setCaptura({ alumnoId: a.id, comp: c })}
                                >
                                  <span className="font-semibold">{uno(v?.valor)}</span>
                                  {aMano && <span className="ml-1 text-[10px] text-brand-600">✎</span>}
                                  {v?.sin_fuente && <span className="ml-1 text-[10px] text-amber-700">sin fuente</span>}
                                </button>
                              </td>
                            )
                          })
                        : esquema.parciales.map((p) => {
                            const x = r?.parciales.find((y) => y.parcial_id === p.id)
                            return (
                              <td key={p.id} className={`border-b border-ink-100 px-2 py-2 font-semibold ${x ? COLOR[x.estado] : ''}`}>
                                {uno(x?.calificacion)}
                                {x?.provisional && <span className="ml-1 text-[10px] font-normal text-ink-400">en curso</span>}
                              </td>
                            )
                          })}
                      <td className={`border-b border-ink-100 px-2 py-2 ${total ? COLOR[total.estado] : ''}`}>
                        <div className="font-bold">{uno(parcial ? rp?.calificacion : r?.final)}</div>
                        <div className="text-[11px]">{total ? ETIQUETA_ESTADO_CALIF[total.estado] : ''}{total?.provisional ? ' · en curso' : ''}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-500">
            {parcial ? 'Toca una celda para capturar a mano; lo capturado (✎) manda sobre lo calculado. ' : ''}Es el mismo cálculo que la app de escritorio; con el portal en línea, lo que captures aquí llega a la app en el siguiente minuto.
          </p>
        </>
      )}
      <Modal abierto={!!captura} titulo={captura ? `${captura.comp.nombre} · ${alumnos.find((a) => a.id === captura.alumnoId)?.apellidos ?? ''}` : ''} onCerrar={() => setCaptura(null)}>
        {captura && (
          <Captura
            materiaId={materiaId}
            alumnoId={captura.alumnoId}
            comp={captura.comp}
            datos={datos}
            onGuardado={(d) => {
              setDatos(d)
              setCaptura(null)
              avisar('Calificación guardada')
            }}
          />
        )}
      </Modal>
    </div>
  )
}

/** Captura a mano de un componente: una calificación o una por rubro (sobre la escala del componente). Vacío = quitar. */
function Captura({ materiaId, alumnoId, comp, datos, onGuardado }: { materiaId: number; alumnoId: number; comp: Componente; datos: CalificacionesWeb; onGuardado: (d: CalificacionesWeb) => void }): JSX.Element {
  const rubros = comp.rubros.length ? comp.rubros : ['Calificación']
  const inicial = rubros.map((_, i) => {
    const c = datos.capturas.find((x) => x.componente_id === comp.id && x.alumno_id === alumnoId && x.rubro === i)
    return c?.valor === null || c?.valor === undefined ? '' : String(c.valor)
  })
  const [valores, setValores] = useState(inicial)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState('')
  const detalle = datos.resultados.find((r) => r.alumno_id === alumnoId)?.parciales.flatMap((p) => p.componentes).find((c) => c.componente_id === comp.id)?.detalle
  const guardar = async (): Promise<void> => {
    setError('')
    setGuardando(true)
    try {
      let d: CalificacionesWeb | null = null
      for (let i = 0; i < rubros.length; i++) {
        if (valores[i] === inicial[i]) continue
        const v = valores[i].trim() === '' ? null : Number(valores[i].replace(',', '.'))
        d = await api<CalificacionesWeb>(`/docente/materias/${materiaId}/capturas`, { metodo: 'PUT', cuerpo: { componente_id: comp.id, alumno_id: alumnoId, rubro: i, valor: v } })
      }
      if (d) onGuardado(d)
      else setError('No cambiaste nada.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGuardando(false)
    }
  }
  return (
    <div className="space-y-3 text-sm">
      {detalle && <p className="break-words text-ink-600">Ahora: {detalle}</p>}
      <p className="text-ink-500">Sobre {comp.escala}. Déjalo vacío para quitar la captura y volver a lo calculado.</p>
      {rubros.map((r, i) => (
        <label key={i} className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-400">{r}</span>
          <input
            className="min-h-[44px] w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-base outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/40"
            inputMode="decimal"
            value={valores[i]}
            onChange={(e) => setValores((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
            autoFocus={i === 0}
          />
        </label>
      ))}
      <ErrorServidor texto={error} />
      <Boton className="w-full" disabled={guardando} onClick={() => void guardar()}>
        {guardando ? 'Guardando…' : 'Guardar'}
      </Boton>
    </div>
  )
}
