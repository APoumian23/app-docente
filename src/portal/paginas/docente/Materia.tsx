import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ErrorApi, fechaMx } from '../../lib/api'
import { Boton, Campo, Cargando, Chip, Modal, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import type { ResumenEntregas } from '@shared/portal'
import type { TipoEvaluacion } from '@shared/types'
import { AreaTexto, ErrorServidor, descargarCsv, numeroOSinDatos, type MateriaDocente } from './comun'

interface AlumnoInscrito {
  id: number
  matricula: string
  nombre: string
  apellidos: string
  email: string
  usuario: string | null
  debe_cambiar: number | null
}

interface EvaluacionResumen {
  id: number
  titulo: string
  tipo: TipoEvaluacion
  puntos_totales: number
  fecha_aplicacion: string | null
  con_reactivos: number
}

interface AccesoCreado {
  matricula: string
  nombre: string
  usuario: string
  password: string
}

type Pestana = 'alumnos' | 'evaluaciones' | 'publicadas'
const PESTANAS: { clave: Pestana; texto: string }[] = [
  { clave: 'alumnos', texto: 'Alumnos' },
  { clave: 'evaluaciones', texto: 'Evaluaciones' },
  { clave: 'publicadas', texto: 'Publicadas' }
]

const TIPO_TEXTO: Record<string, string> = {
  diagnostico: 'Diagnóstico',
  examen: 'Examen',
  examen_sorpresa: 'Examen sorpresa',
  examen_oral: 'Examen oral',
  cuestionario: 'Cuestionario',
  tarea: 'Tarea',
  ejercicios: 'Ejercicios',
  ejemplos: 'Ejemplos',
  glosario: 'Glosario',
  material_apoyo: 'Material de apoyo',
  clase_completa: 'Clase completa',
  plan_sesion: 'Plan de sesión',
  presentacion: 'Presentación'
}

/** Una materia del docente: alumnos inscritos, evaluaciones disponibles y actividades publicadas. */
export default function Materia(): JSX.Element {
  const { id } = useParams()
  const materiaId = Number(id)
  const [params, setParams] = useSearchParams()
  const pestana = (PESTANAS.find((p) => p.clave === params.get('pestana'))?.clave ?? 'alumnos') as Pestana
  const [materia, setMateria] = useState<MateriaDocente | null | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    api<MateriaDocente[]>('/docente/materias')
      .then((lista) => setMateria(lista.find((m) => m.id === materiaId) ?? null))
      .catch((e: Error) => {
        setError(e.message)
        setMateria(null)
      })
  }, [materiaId])

  if (materia === undefined) return <Cargando texto="Cargando materia…" />
  if (materia === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <ErrorServidor texto={error} />
        <Vacio titulo="No encontramos esa materia" detalle="Puede que ya no exista o que el enlace esté incompleto." />
        <Link to="/docente" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-600">← Volver a mis materias</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <Link to="/docente" className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← Mis materias</Link>
        <div className="flex items-start gap-3">
          <span className="mt-1.5 h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: materia.color || '#2d6df6' }} />
          <div className="min-w-0">
            <h2 className="break-words text-xl font-bold leading-snug text-ink-900">{materia.nombre}</h2>
            <p className="text-sm text-ink-500">
              {materia.carrera_nombre} · {materia.clave} · {materia.cuatrimestre}° cuatrimestre · {materia.inscritos} {materia.inscritos === 1 ? 'inscrito' : 'inscritos'}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to={`/docente/asistencia/${materia.id}`} className="inline-flex min-h-[44px] items-center rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700">✓ Pasar lista</Link>
          <Link to={`/docente/calificaciones/${materia.id}`} className="inline-flex min-h-[44px] items-center rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600">★ Calificaciones</Link>
          <BotonAviso materiaId={materia.id} materiaNombre={materia.nombre} />
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-xl bg-ink-100 p-1" role="tablist">
        {PESTANAS.map((p) => (
          <button
            key={p.clave}
            role="tab"
            aria-selected={pestana === p.clave}
            onClick={() => setParams({ pestana: p.clave }, { replace: true })}
            className={`min-h-[44px] flex-1 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition ${pestana === p.clave ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          >
            {p.texto}
          </button>
        ))}
      </div>

      {pestana === 'alumnos' && <PestanaAlumnos materiaId={materiaId} materiaNombre={materia.nombre} onCambio={(n) => setMateria({ ...materia, inscritos: n })} />}
      {pestana === 'evaluaciones' && <PestanaEvaluaciones materiaId={materiaId} inscritos={materia.inscritos} />}
      {pestana === 'publicadas' && <PestanaPublicadas materiaId={materiaId} />}
    </div>
  )
}

// ---------------- Alumnos ----------------

function separarLinea(linea: string): string[] {
  const sep = linea.includes('\t') ? '\t' : linea.includes(';') ? ';' : ','
  return linea.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))
}

function PestanaAlumnos({ materiaId, materiaNombre, onCambio }: { materiaId: number; materiaNombre: string; onCambio: (inscritos: number) => void }): JSX.Element {
  const [alumnos, setAlumnos] = useState<AlumnoInscrito[] | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'ninguno' | 'agregar' | 'importar' | 'accesos'>('ninguno')
  const [ocupado, setOcupado] = useState('')
  const [accesos, setAccesos] = useState<{ creados: AccesoCreado[]; existentes: number } | null>(null)
  const [passwordNueva, setPasswordNueva] = useState<{ alumno: AlumnoInscrito; password: string } | null>(null)
  const [nuevo, setNuevo] = useState({ matricula: '', nombre: '', apellidos: '', email: '' })
  const [pegado, setPegado] = useState('')
  const [errorModal, setErrorModal] = useState('')

  const cargar = async (): Promise<void> => {
    try {
      const lista = await api<AlumnoInscrito[]>(`/docente/materias/${materiaId}/alumnos`)
      setAlumnos(lista)
      onCambio(lista.length)
      setError('')
    } catch (e) {
      setError((e as Error).message)
      setAlumnos([])
    }
  }
  useEffect(() => {
    cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materiaId])

  const cerrarModal = (): void => {
    setModal('ninguno')
    setErrorModal('')
  }

  const generarAccesos = async (): Promise<void> => {
    setOcupado('accesos')
    try {
      const r = await api<{ creados: AccesoCreado[]; existentes: number }>(`/docente/materias/${materiaId}/accesos`, { metodo: 'POST' })
      setAccesos(r)
      setModal('accesos')
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado('')
    }
  }

  const reiniciar = async (a: AlumnoInscrito): Promise<void> => {
    if (!window.confirm(`¿Reiniciar la contraseña de ${a.apellidos} ${a.nombre}? Se cerrarán sus sesiones abiertas.`)) return
    setOcupado(`reiniciar-${a.id}`)
    try {
      const r = await api<{ password: string }>(`/docente/alumnos/${a.id}/reiniciar-password`, { metodo: 'POST' })
      setPasswordNueva({ alumno: a, password: r.password })
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado('')
    }
  }

  const quitar = async (a: AlumnoInscrito): Promise<void> => {
    if (!window.confirm(`¿Quitar a ${a.apellidos} ${a.nombre} de ${materiaNombre}? Su cuenta y sus entregas se conservan.`)) return
    setOcupado(`quitar-${a.id}`)
    try {
      await api(`/docente/materias/${materiaId}/alumnos/${a.id}`, { metodo: 'DELETE' })
      avisar('Alumno quitado de la materia')
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado('')
    }
  }

  const agregar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setOcupado('agregar')
    setErrorModal('')
    try {
      await api(`/docente/materias/${materiaId}/alumnos`, { metodo: 'POST', cuerpo: nuevo })
      avisar(`${nuevo.nombre} quedó inscrito`)
      setNuevo({ matricula: '', nombre: '', apellidos: '', email: '' })
      cerrarModal()
      await cargar()
    } catch (err) {
      setErrorModal((err as Error).message)
    } finally {
      setOcupado('')
    }
  }

  const filasImportar = pegado
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(separarLinea)
    .filter((c) => c.some(Boolean) && !/^matr[ií]cula$/i.test(c[0]))
    .map(([matricula, nombre = '', apellidos = '', email = '']) => ({ matricula, nombre, apellidos, email }))

  const importar = async (): Promise<void> => {
    if (!filasImportar.length) return setErrorModal('Pega al menos una línea con matrícula y nombre.')
    const sinNombre = filasImportar.find((f) => !f.nombre)
    if (sinNombre) return setErrorModal(`La línea "${sinNombre.matricula || '(sin matrícula)'}" no tiene nombre.`)
    setOcupado('importar')
    setErrorModal('')
    try {
      const r = await api<{ inscritos: number; nuevos: number }>(`/docente/materias/${materiaId}/alumnos`, { metodo: 'POST', cuerpo: filasImportar })
      avisar(`${r.inscritos} inscritos (${r.nuevos} nuevos)`)
      setPegado('')
      cerrarModal()
      await cargar()
    } catch (err) {
      setErrorModal((err as Error).message)
    } finally {
      setOcupado('')
    }
  }

  const exportar = (): void => {
    if (!alumnos?.length) return
    descargarCsv(
      `alumnos-${materiaNombre.replace(/[^\wáéíóúñ]+/gi, '-').toLowerCase()}.csv`,
      ['matricula', 'nombre', 'apellidos', 'correo', 'usuario', 'debe_cambiar'],
      alumnos.map((a) => [a.matricula, a.nombre, a.apellidos, a.email, a.usuario ?? '', a.debe_cambiar ? 'sí' : 'no'])
    )
  }

  if (alumnos === null) return <Cargando texto="Cargando alumnos…" />

  return (
    <div className="space-y-4">
      <ErrorServidor texto={error} />
      <div className="flex flex-wrap gap-2">
        <Boton onClick={() => setModal('agregar')}>+ Agregar alumno</Boton>
        <Boton variante="secundario" onClick={() => setModal('importar')}>Importar lista</Boton>
        <Boton variante="secundario" onClick={generarAccesos} disabled={ocupado === 'accesos' || alumnos.length === 0}>
          {ocupado === 'accesos' ? 'Generando…' : 'Generar accesos'}
        </Boton>
        <Boton variante="fantasma" onClick={exportar} disabled={alumnos.length === 0}>Exportar CSV</Boton>
      </div>

      {alumnos.length === 0 ? (
        <Vacio titulo="Aún no hay alumnos inscritos" detalle="Agrega uno a uno o pega la lista completa desde tu hoja de cálculo." />
      ) : (
        <Tarjeta className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
                <tr>
                  <th className="px-4 py-3">Matrícula</th>
                  <th className="px-4 py-3">Alumno</th>
                  <th className="px-4 py-3">Correo</th>
                  <th className="px-4 py-3">Acceso</th>
                  <th className="px-4 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {alumnos.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{a.matricula}</td>
                    <td className="px-4 py-2 font-medium text-ink-900">
                      {a.apellidos} {a.nombre}
                    </td>
                    <td className="px-4 py-2 text-ink-600">{a.email || <span className="text-ink-300">—</span>}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      {a.usuario ? a.debe_cambiar ? <Chip tono="ambar">Contraseña inicial</Chip> : <Chip tono="verde">Activo</Chip> : <Chip>Sin acceso</Chip>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {a.usuario && (
                          <Boton variante="fantasma" className="px-3 text-xs" onClick={() => reiniciar(a)} disabled={ocupado === `reiniciar-${a.id}`}>
                            Reiniciar contraseña
                          </Boton>
                        )}
                        <Boton variante="peligro" className="px-3 text-xs" onClick={() => quitar(a)} disabled={ocupado === `quitar-${a.id}`}>
                          Quitar
                        </Boton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      )}

      <Modal abierto={modal === 'agregar'} titulo="Agregar alumno" onCerrar={cerrarModal}>
        <form onSubmit={agregar} className="space-y-3">
          <Campo etiqueta="Nombre" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} required autoFocus />
          <Campo etiqueta="Matrícula (opcional)" value={nuevo.matricula} onChange={(e) => setNuevo({ ...nuevo, matricula: e.target.value })} />
          <Campo etiqueta="Apellidos" value={nuevo.apellidos} onChange={(e) => setNuevo({ ...nuevo, apellidos: e.target.value })} />
          <Campo etiqueta="Correo" type="email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
          <ErrorServidor texto={errorModal} />
          <p className="text-xs text-ink-500">Si la matrícula ya existe, solo se inscribe en esta materia y se actualizan sus datos. Sin matrícula, el usuario del portal se genera con el nombre.</p>
          <Boton type="submit" className="w-full" disabled={ocupado === 'agregar'}>{ocupado === 'agregar' ? 'Guardando…' : 'Inscribir'}</Boton>
        </form>
      </Modal>

      <Modal abierto={modal === 'importar'} titulo="Importar lista" onCerrar={cerrarModal}>
        <div className="space-y-3">
          <p className="text-sm text-ink-600">
            Pega una línea por alumno con <span className="font-mono text-xs">matrícula, nombre, apellidos, correo</span>. Sirve con comas, punto y coma o tabulador (copiado desde Excel).
          </p>
          <AreaTexto value={pegado} onChange={(e) => setPegado(e.target.value)} rows={8} placeholder={'A2026001, Ana, Pérez López, ana@correo.com\nA2026002\tLuis\tRamírez\tluis@correo.com'} autoFocus />
          <div className="text-xs text-ink-500">{filasImportar.length} {filasImportar.length === 1 ? 'alumno detectado' : 'alumnos detectados'}</div>
          <ErrorServidor texto={errorModal} />
          <Boton className="w-full" onClick={importar} disabled={ocupado === 'importar' || filasImportar.length === 0}>
            {ocupado === 'importar' ? 'Inscribiendo…' : `Inscribir ${filasImportar.length || ''}`.trim()}
          </Boton>
        </div>
      </Modal>

      <Modal abierto={modal === 'accesos'} titulo="Accesos generados" onCerrar={cerrarModal}>
        {accesos && (
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              {accesos.creados.length === 0 ? 'Todos los alumnos ya tenían acceso; no se creó ninguno nuevo.' : `Se crearon ${accesos.creados.length} accesos.`}
              {accesos.existentes > 0 && ` ${accesos.existentes} ya tenían cuenta y no cambiaron.`}
            </p>
            {accesos.creados.length > 0 && (
              <>
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">La contraseña inicial es la matrícula y el alumno debe cambiarla al entrar. Descarga la lista ahora: no se vuelve a mostrar.</p>
                <div className="overflow-x-auto rounded-xl border border-ink-200">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-400">
                      <tr>
                        <th className="px-3 py-2">Matrícula</th>
                        <th className="px-3 py-2">Nombre</th>
                        <th className="px-3 py-2">Usuario</th>
                        <th className="px-3 py-2">Contraseña</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {accesos.creados.map((c) => (
                        <tr key={c.usuario}>
                          <td className="px-3 py-2 font-mono text-xs">{c.matricula}</td>
                          <td className="px-3 py-2">{c.nombre}</td>
                          <td className="px-3 py-2 font-mono text-xs">{c.usuario}</td>
                          <td className="px-3 py-2 font-mono text-xs">{c.password}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Boton className="w-full" onClick={() => descargarCsv('accesos.csv', ['matricula', 'nombre', 'usuario', 'contraseña'], accesos.creados.map((c) => [c.matricula, c.nombre, c.usuario, c.password]))}>
                  Descargar CSV
                </Boton>
              </>
            )}
          </div>
        )}
      </Modal>

      <Modal abierto={passwordNueva !== null} titulo="Contraseña reiniciada" onCerrar={() => setPasswordNueva(null)}>
        {passwordNueva && (
          <div className="space-y-3">
            <p className="text-sm text-ink-600">
              {passwordNueva.alumno.apellidos} {passwordNueva.alumno.nombre} entra con el usuario <span className="font-mono">{passwordNueva.alumno.usuario}</span> y esta contraseña temporal:
            </p>
            <div className="select-all rounded-xl bg-ink-900 px-4 py-3 text-center font-mono text-lg text-white">{passwordNueva.password}</div>
            <p className="text-xs text-ink-500">Deberá cambiarla en cuanto entre.</p>
            <Boton className="w-full" variante="secundario" onClick={() => setPasswordNueva(null)}>Listo</Boton>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------------- Evaluaciones ----------------

function PestanaEvaluaciones({ materiaId, inscritos }: { materiaId: number; inscritos: number }): JSX.Element {
  const nav = useNavigate()
  const [evaluaciones, setEvaluaciones] = useState<EvaluacionResumen[] | null>(null)
  const [error, setError] = useState('')
  const [paraJugar, setParaJugar] = useState<EvaluacionResumen | null>(null)
  const [segundos, setSegundos] = useState(20)
  const [errorJuego, setErrorJuego] = useState('')
  const [creando, setCreando] = useState(false)

  useEffect(() => {
    api<EvaluacionResumen[]>(`/docente/materias/${materiaId}/evaluaciones`)
      .then(setEvaluaciones)
      .catch((e: Error) => {
        setError(e.message)
        setEvaluaciones([])
      })
  }, [materiaId])

  const jugar = async (): Promise<void> => {
    if (!paraJugar) return
    setCreando(true)
    setErrorJuego('')
    try {
      const p = await api<{ pin: string }>('/docente/partidas', { metodo: 'POST', cuerpo: { evaluacion_id: paraJugar.id, segundos } })
      nav(`/docente/juego/${p.pin}`)
    } catch (e) {
      setErrorJuego(e instanceof ErrorApi && e.estado === 400 ? e.message : (e as Error).message)
    } finally {
      setCreando(false)
    }
  }

  if (evaluaciones === null) return <Cargando texto="Cargando evaluaciones…" />

  return (
    <div className="space-y-4">
      <ErrorServidor texto={error} />
      {inscritos === 0 && evaluaciones.length > 0 && <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Para publicar necesitas al menos un alumno inscrito en la materia.</div>}
      {evaluaciones.length === 0 && !error && <Vacio titulo="No hay evaluaciones en esta materia" detalle="Genera exámenes, tareas y cuestionarios desde Estudio IA en la aplicación de escritorio." />}
      <div className="grid gap-3 sm:grid-cols-2">
        {evaluaciones.map((ev) => (
          <Tarjeta key={ev.id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tono="morado">{TIPO_TEXTO[ev.tipo] ?? ev.tipo}</Chip>
              {ev.con_reactivos ? <Chip tono="verde">Con reactivos</Chip> : <Chip>Sin contenido</Chip>}
            </div>
            <div className="min-w-0">
              <div className="break-words font-semibold leading-snug text-ink-900">{ev.titulo}</div>
              <div className="mt-0.5 text-xs text-ink-500">
                {ev.puntos_totales} pts{ev.fecha_aplicacion ? ` · aplicación ${fechaMx(ev.fecha_aplicacion, false)}` : ''}
              </div>
            </div>
            {ev.con_reactivos ? (
              <div className="mt-auto grid grid-cols-2 gap-2">
                <Boton onClick={() => nav(`/docente/publicar/${materiaId}?evaluacion=${ev.id}`)}>Publicar</Boton>
                <Boton variante="secundario" onClick={() => { setParaJugar(ev); setErrorJuego('') }}>🎮 Jugar en vivo</Boton>
              </div>
            ) : (
              <p className="mt-auto text-xs text-ink-400">Genera su contenido en Estudio IA para poder publicarla o jugarla.</p>
            )}
          </Tarjeta>
        ))}
      </div>

      <Modal abierto={paraJugar !== null} titulo="Jugar en vivo" onCerrar={() => setParaJugar(null)}>
        {paraJugar && (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              Se abrirá una partida con las preguntas de opción múltiple de <span className="font-semibold">{paraJugar.titulo}</span>. Los alumnos entran con un PIN desde su celular.
            </p>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Segundos por pregunta</div>
              <div className="grid grid-cols-3 gap-2">
                {[10, 20, 30].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSegundos(s)}
                    className={`min-h-[44px] rounded-xl border text-sm font-semibold ${segundos === s ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-200 bg-white text-ink-700'}`}
                  >
                    {s} s
                  </button>
                ))}
              </div>
            </div>
            <ErrorServidor texto={errorJuego} />
            <Boton className="w-full" onClick={jugar} disabled={creando}>{creando ? 'Creando partida…' : 'Crear partida'}</Boton>
          </div>
        )}
      </Modal>
    </div>
  )
}

// ---------------- Publicadas ----------------

function PestanaPublicadas({ materiaId }: { materiaId: number }): JSX.Element {
  const [lista, setLista] = useState<ResumenEntregas[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api<ResumenEntregas[]>(`/docente/asignaciones?materia_id=${materiaId}`)
      .then(setLista)
      .catch((e: Error) => {
        setError(e.message)
        setLista([])
      })
  }, [materiaId])

  if (lista === null) return <Cargando texto="Cargando actividades publicadas…" />

  return (
    <div className="space-y-4">
      <ErrorServidor texto={error} />
      {lista.length === 0 && !error && <Vacio titulo="Todavía no has publicado nada en esta materia" detalle="Ve a la pestaña Evaluaciones y publica una que tenga reactivos." />}
      <div className="grid gap-3 sm:grid-cols-2">
        {lista.map((r) => (
          <Link key={r.asignacion.id} to={`/docente/asignaciones/${r.asignacion.id}`} className="block rounded-2xl border border-ink-200 bg-white p-4 shadow-sm transition hover:border-brand-400">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tono="morado">{TIPO_TEXTO[r.asignacion.tipo] ?? r.asignacion.tipo}</Chip>
              {r.asignacion.activa ? <Chip tono="verde">Abierta</Chip> : <Chip tono="rojo">Cerrada</Chip>}
              {r.pendientes_manual > 0 && <Chip tono="ambar">{r.pendientes_manual} por revisar</Chip>}
            </div>
            <div className="mt-2 break-words font-semibold leading-snug text-ink-900">{r.asignacion.titulo}</div>
            <div className="mt-1 text-xs text-ink-500">
              Publicada {fechaMx(r.asignacion.publicada_en)} · {r.asignacion.cierra ? `cierra ${fechaMx(r.asignacion.cierra)}` : 'sin fecha límite'}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-ink-50 py-2">
                <div className="text-lg font-bold text-ink-900">
                  {r.entregados}<span className="text-xs font-normal text-ink-400">/{r.inscritos}</span>
                </div>
                <div className="text-[11px] text-ink-500">entregados</div>
              </div>
              <div className="rounded-xl bg-ink-50 py-2">
                <div className="text-lg font-bold text-ink-900">{r.pendientes_manual}</div>
                <div className="text-[11px] text-ink-500">por revisar</div>
              </div>
              <div className="rounded-xl bg-ink-50 py-2">
                <div className="text-lg font-bold text-ink-900">{numeroOSinDatos(r.promedio)}</div>
                <div className="text-[11px] text-ink-500">promedio / {r.asignacion.puntos_totales ?? '—'}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

/** Aviso al grupo: llega a la campana de cada alumno y lo ve arriba de sus actividades. */
function BotonAviso({ materiaId, materiaNombre }: { materiaId: number; materiaNombre: string }): JSX.Element {
  const [abierto, setAbierto] = useState(false)
  const [titulo, setTitulo] = useState('')
  const [cuerpo, setCuerpo] = useState('')
  const [carrera, setCarrera] = useState('')
  const [carreras, setCarreras] = useState<{ id: number; nombre: string }[]>([])
  const [enviando, setEnviando] = useState(false)
  useEffect(() => {
    if (abierto) api<{ id: number; nombre: string }[]>(`/docente/materias/${materiaId}/carreras`).then(setCarreras).catch(() => setCarreras([]))
  }, [abierto, materiaId])
  const cerrar = (): void => {
    setAbierto(false)
    setTitulo('')
    setCuerpo('')
    setCarrera('')
  }
  const enviar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setEnviando(true)
    try {
      const r = await api<{ enviados: number }>(`/docente/materias/${materiaId}/avisos`, { metodo: 'POST', cuerpo: { titulo, cuerpo, carrera_id: carrera || null } })
      avisar(r.enviados ? `Aviso enviado a ${r.enviados} alumno${r.enviados === 1 ? '' : 's'}` : 'Nadie lo recibió: ningún alumno del grupo tiene acceso al portal', r.enviados ? 'ok' : 'info')
      cerrar()
    } catch (err) {
      avisar((err as Error).message, 'error')
    } finally {
      setEnviando(false)
    }
  }
  return (
    <>
      <button onClick={() => setAbierto(true)} className="inline-flex min-h-[44px] items-center rounded-xl border border-ink-200 bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-ink-100">📣 Enviar aviso</button>
      <Modal abierto={abierto} titulo={`Aviso a ${materiaNombre}`} onCerrar={cerrar}>
        <form onSubmit={enviar} className="space-y-3">
          <p className="text-sm text-ink-500">Les llega a la campana y lo ven arriba de sus actividades hasta que lo marquen como leído.</p>
          {carreras.length > 1 && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-700">Para</span>
              <select className="min-h-[44px] w-full rounded-xl border border-ink-200 bg-white px-3" value={carrera} onChange={(e) => setCarrera(e.target.value)}>
                <option value="">Todo el grupo</option>
                {carreras.map((c) => <option key={c.id} value={c.id}>Solo {c.nombre}</option>)}
              </select>
            </label>
          )}
          <Campo etiqueta="Aviso" maxLength={200} value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ej. Mañana no hay clase" required />
          <AreaTexto etiqueta="Detalle (opcional)" maxLength={2000} value={cuerpo} onChange={(e) => setCuerpo(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Boton type="button" variante="fantasma" onClick={cerrar}>Cancelar</Boton>
            <Boton type="submit" disabled={!titulo.trim() || enviando}>{enviando ? 'Enviando…' : 'Enviar aviso'}</Boton>
          </div>
        </form>
      </Modal>
    </>
  )
}
