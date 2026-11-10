import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { Boton, Campo, Cargando, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import type { Asignacion, MostrarRespuestas } from '@shared/portal'
import type { ContenidoEvaluacion, Evaluacion, TipoEvaluacion } from '@shared/types'
import { AreaTexto, Casilla, ErrorServidor, OPCIONES_RESPUESTAS, Selector, aDatetimeLocal, type MateriaDocente } from './comun'

interface AlumnoMateria {
  id: number
  matricula: string
  nombre: string
  apellidos: string
  carrera_id: number | null
  carrera_nombre: string | null
  carrera_clave: string | null
}

type Para = 'todos' | 'carrera' | 'alumnos'

interface EvaluacionResumen {
  id: number
  titulo: string
  tipo: TipoEvaluacion
  puntos_totales: number
  con_reactivos: number
}

/** Publica una evaluación a los alumnos de la materia con ventana, duración y reglas. */
export default function Publicar(): JSX.Element {
  const { materiaId: idTexto } = useParams()
  const materiaId = Number(idTexto)
  const [params] = useSearchParams()
  const nav = useNavigate()

  const [materia, setMateria] = useState<MateriaDocente | null | undefined>(undefined)
  const [evaluaciones, setEvaluaciones] = useState<EvaluacionResumen[] | null>(null)
  const [errorCarga, setErrorCarga] = useState('')

  const [evaluacionId, setEvaluacionId] = useState(Number(params.get('evaluacion')) || 0)
  const [titulo, setTitulo] = useState('')
  const [instrucciones, setInstrucciones] = useState('')
  const [abre, setAbre] = useState(aDatetimeLocal(new Date()))
  const [cierra, setCierra] = useState('')
  const [duracion, setDuracion] = useState('')
  const [vigilancia, setVigilancia] = useState(false)
  const [cerrarAlSalir, setCerrarAlSalir] = useState(true)
  const [bloqueo, setBloqueo] = useState(false)
  // Candado: no pueden enviar con preguntas en blanco (de inicio en exámenes)
  const [todasObligatorias, setTodasObligatorias] = useState(false)
  const [permiteBorrador, setPermiteBorrador] = useState(false)
  const [permiteArchivos, setPermiteArchivos] = useState(false)
  const [mostrarResultado, setMostrarResultado] = useState(true)
  const [mostrarRespuestas, setMostrarRespuestas] = useState<MostrarRespuestas>('al_cerrar')
  // Vacío = en exámenes, el peso del examen en el esquema de la materia (o 30 %)
  const [ponderacion, setPonderacion] = useState('')
  const [esExamen, setEsExamen] = useState(false)
  // Para quién: toda la materia, una carrera (grupos mixtos) o alumnos elegidos
  const [alumnos, setAlumnos] = useState<AlumnoMateria[]>([])
  const [para, setPara] = useState<Para>('todos')
  const [carreraPara, setCarreraPara] = useState<number>(0)
  const [elegidos, setElegidos] = useState<Set<number>>(new Set())
  const [buscar, setBuscar] = useState('')
  // Preguntas al azar por alumno: cuántas de cada tipo le tocan a cada uno (del examen completo)
  const [hay, setHay] = useState({ opcion_multiple: 0, verdadero_falso: 0, abierta: 0, puntos: { opcion_multiple: 0, verdadero_falso: 0, abierta: 0 } })
  const [azar, setAzar] = useState(false)
  const [azarOm, setAzarOm] = useState('')
  const [azarVf, setAzarVf] = useState('')
  const [azarAb, setAzarAb] = useState('')
  const [error, setError] = useState('')
  const [enviando, setEnviando] = useState(false)

  useEffect(() => {
    Promise.all([api<MateriaDocente[]>('/docente/materias'), api<EvaluacionResumen[]>(`/docente/materias/${materiaId}/evaluaciones`), api<AlumnoMateria[]>(`/docente/materias/${materiaId}/alumnos`)])
      .then(([materias, evs, als]) => {
        setMateria(materias.find((m) => m.id === materiaId) ?? null)
        setAlumnos(als)
        const conReactivos = evs.filter((e) => e.con_reactivos)
        setEvaluaciones(conReactivos)
        setEvaluacionId((actual) => (conReactivos.some((e) => e.id === actual) ? actual : conReactivos[0]?.id ?? 0))
      })
      .catch((e: Error) => {
        setErrorCarga(e.message)
        setMateria(null)
        setEvaluaciones([])
      })
  }, [materiaId])

  // Al cambiar de evaluación se toman su título, instrucciones y duración como punto de partida
  useEffect(() => {
    if (!evaluacionId) return
    let vigente = true
    api<Evaluacion & { contenido_json: ContenidoEvaluacion | null }>(`/docente/evaluaciones/${evaluacionId}`)
      .then((ev) => {
        if (!vigente) return
        setTitulo(ev.titulo)
        setInstrucciones(ev.contenido_json?.instrucciones ?? '')
        setDuracion(ev.contenido_json?.duracion_min ? String(ev.contenido_json.duracion_min) : '')
        // Los exámenes se publican vigilados por omisión; el docente puede quitarlo
        setVigilancia(ev.tipo === 'examen' || ev.tipo === 'examen_sorpresa')
        setTodasObligatorias(ev.tipo === 'examen' || ev.tipo === 'examen_sorpresa')
        setEsExamen(ev.tipo === 'examen')
        // Cuántas preguntas hay de cada tipo (y sus puntos) para el sorteo por alumno
        const grupo = (t: string): 'opcion_multiple' | 'verdadero_falso' | 'abierta' => (t === 'opcion_multiple' ? 'opcion_multiple' : t === 'verdadero_falso' ? 'verdadero_falso' : 'abierta')
        const h = { opcion_multiple: 0, verdadero_falso: 0, abierta: 0, puntos: { opcion_multiple: 0, verdadero_falso: 0, abierta: 0 } }
        for (const p of ev.contenido_json?.preguntas ?? []) {
          h[grupo(p.tipo)]++
          h.puntos[grupo(p.tipo)] += p.puntos || 0
        }
        setHay(h)
        setAzar(false)
        setAzarOm(h.opcion_multiple ? String(Math.min(10, h.opcion_multiple)) : '')
        setAzarVf(h.verdadero_falso ? String(Math.min(5, h.verdadero_falso)) : '')
        setAzarAb('')
      })
      .catch((e: Error) => vigente && setError(e.message))
    return () => {
      vigente = false
    }
  }, [evaluacionId])

  const enviar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    if (!evaluacionId) return setError('Elige una evaluación.')
    const fechaAbre = new Date(abre)
    if (Number.isNaN(fechaAbre.getTime())) return setError('La fecha de apertura no es válida.')
    const fechaCierra = cierra ? new Date(cierra) : null
    if (fechaCierra && Number.isNaN(fechaCierra.getTime())) return setError('La fecha de cierre no es válida.')
    if (fechaCierra && fechaCierra <= fechaAbre) return setError('La fecha de cierre debe ser posterior a la de apertura.')
    const minutos = duracion.trim() === '' ? 0 : Number(duracion)
    if (!Number.isInteger(minutos) || minutos < 0) return setError('La duración debe ser un número entero de minutos.')
    if (para !== 'todos' && destinatarios.length === 0) return setError(para === 'carrera' ? 'Elige una carrera con alumnos inscritos.' : 'Elige al menos un alumno.')
    if (azar) {
      if (porAlumno.opcion_multiple + porAlumno.verdadero_falso + porAlumno.abierta === 0) return setError('Pon cuántas preguntas al azar le tocan a cada alumno.')
      if (porAlumno.opcion_multiple > hay.opcion_multiple || porAlumno.verdadero_falso > hay.verdadero_falso || porAlumno.abierta > hay.abierta) return setError('Pediste más preguntas al azar de las que tiene el examen.')
    }
    setEnviando(true)
    try {
      const a = await api<Asignacion>('/docente/asignaciones', {
        metodo: 'POST',
        cuerpo: {
          evaluacion_id: evaluacionId,
          materia_id: materiaId,
          titulo: titulo.trim(),
          instrucciones,
          abre: fechaAbre.toISOString(),
          cierra: fechaCierra ? fechaCierra.toISOString() : null,
          // 0 = sin límite; null haría que el servidor tomara la duración de la evaluación
          duracion_min: minutos,
          vigilancia,
          cerrar_al_salir: vigilancia && cerrarAlSalir,
          bloqueo,
          todas_obligatorias: todasObligatorias,
          alumnos: para === 'todos' ? undefined : destinatarios,
          azar: azar ? porAlumno : undefined,
          permite_borrador: permiteBorrador,
          permite_archivos: permiteArchivos,
          mostrar_resultado: mostrarResultado,
          mostrar_respuestas: mostrarRespuestas,
          ...(ponderacion.trim() ? { ponderacion: Number(ponderacion) } : {})
        }
      })
      avisar(`"${a.titulo}" publicada. ${para === 'todos' ? 'Los alumnos' : destinatarios.length === 1 ? 'El alumno elegido' : `Los ${destinatarios.length} alumnos elegidos`} ya fueron avisados.`)
      nav(`/docente/asignaciones/${a.id}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setEnviando(false)
    }
  }

  // Carreras presentes entre los inscritos (para grupos mixtos) y los destinatarios que resultan de la elección
  const carreras = [...new Map(alumnos.filter((a) => a.carrera_id).map((a) => [a.carrera_id as number, { id: a.carrera_id as number, nombre: a.carrera_nombre ?? '', clave: a.carrera_clave ?? '' }])).values()]
  const destinatarios = para === 'carrera' ? alumnos.filter((a) => a.carrera_id === carreraPara).map((a) => a.id) : para === 'alumnos' ? [...elegidos] : []
  const sinAcentos = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const visiblesLista = alumnos.filter((a) => !buscar.trim() || sinAcentos(`${a.nombre} ${a.apellidos} ${a.matricula}`).includes(sinAcentos(buscar.trim())))
  const alternarAlumno = (id: number): void =>
    setElegidos((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const numeroDe = (t: string): number => Math.max(0, Math.round(Number(t) || 0))
  const porAlumno = { opcion_multiple: numeroDe(azarOm), verdadero_falso: numeroDe(azarVf), abierta: numeroDe(azarAb) }
  const promedio = (g: 'opcion_multiple' | 'verdadero_falso' | 'abierta'): number => (hay[g] ? hay.puntos[g] / hay[g] : 0)
  const valePorAlumno = Math.round((porAlumno.opcion_multiple * promedio('opcion_multiple') + porAlumno.verdadero_falso * promedio('verdadero_falso') + porAlumno.abierta * promedio('abierta')) * 100) / 100
  const totalBanco = hay.opcion_multiple + hay.verdadero_falso + hay.abierta
  const campoAzar = (etiqueta: string, valor: string, cambiar: (t: string) => void, max: number): JSX.Element => (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">{etiqueta} <span className="font-normal normal-case">(de {max})</span></span>
      <input
        className="mt-1 min-h-[44px] w-full rounded-xl border border-ink-200 bg-white px-3 text-sm disabled:bg-ink-50"
        inputMode="numeric"
        value={valor}
        placeholder="0"
        disabled={max === 0}
        onChange={(e) => cambiar(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 3))}
      />
    </label>
  )

  if (materia === undefined || evaluaciones === null) return <Cargando texto="Preparando publicación…" />

  const volver = <Link to={`/docente/materias/${materiaId}?pestana=evaluaciones`} className="inline-flex min-h-[44px] items-center text-sm text-ink-500 hover:text-ink-800">← Volver a la materia</Link>

  if (materia === null) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <ErrorServidor texto={errorCarga} />
        <Vacio titulo="No encontramos esa materia" />
        <Link to="/docente" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-brand-600">← Mis materias</Link>
      </div>
    )
  }

  if (evaluaciones.length === 0) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        {volver}
        <ErrorServidor texto={errorCarga} />
        <Vacio titulo="No hay evaluaciones con reactivos" detalle="Solo se pueden publicar evaluaciones cuyo contenido ya fue generado en Estudio IA." />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {volver}
      <div>
        <h2 className="text-xl font-bold text-ink-900">Publicar actividad</h2>
        <p className="text-sm text-ink-500">
          {materia.nombre} · {para === 'todos' ? materia.inscritos : destinatarios.length} {(para === 'todos' ? materia.inscritos : destinatarios.length) === 1 ? 'alumno recibirá' : 'alumnos recibirán'} la notificación
        </p>
      </div>
      {materia.inscritos === 0 && <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">La materia no tiene alumnos inscritos; el servidor rechazará la publicación hasta que inscribas al menos uno.</div>}

      <form onSubmit={enviar} className="space-y-4">
        <Tarjeta className="space-y-3">
          <Selector etiqueta="Evaluación" value={evaluacionId} onChange={(e) => setEvaluacionId(Number(e.target.value))}>
            {evaluaciones.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.titulo} ({ev.puntos_totales} pts)
              </option>
            ))}
          </Selector>
          <Campo etiqueta="Título que verán los alumnos" value={titulo} onChange={(e) => setTitulo(e.target.value)} required maxLength={200} />
          <AreaTexto etiqueta="Instrucciones" value={instrucciones} onChange={(e) => setInstrucciones(e.target.value)} rows={4} placeholder="Qué deben hacer, cómo se califica, qué pueden consultar…" />
        </Tarjeta>

        <Tarjeta className="space-y-3">
          <h3 className="font-semibold text-ink-900">Para quién</h3>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Para quién">
            {(
              [
                ['todos', 'Toda la materia'],
                ...(carreras.length > 1 ? [['carrera', 'Por carrera']] : []),
                ['alumnos', 'Alumnos elegidos']
              ] as [Para, string][]
            ).map(([v, t]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={para === v}
                onClick={() => {
                  setPara(v)
                  if (v === 'carrera' && !carreraPara && carreras[0]) setCarreraPara(carreras[0].id)
                }}
                className={`min-h-[44px] rounded-xl px-4 text-sm font-semibold ${para === v ? 'bg-brand-500 text-white' : 'border border-ink-200 bg-white text-ink-700 hover:bg-ink-100'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {para === 'todos' ? <p className="text-xs text-ink-500">Todos los inscritos ({alumnos.length}) la ven y reciben el aviso.</p> : null}
          {para === 'carrera' ? (
            <Selector etiqueta="Carrera" value={carreraPara} onChange={(e) => setCarreraPara(Number(e.target.value))}>
              {carreras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                  {c.clave ? ` (${c.clave})` : ''} · {alumnos.filter((a) => a.carrera_id === c.id).length} alumnos
                </option>
              ))}
            </Selector>
          ) : null}
          {para === 'alumnos' ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-ink-200 bg-white px-3 text-sm"
                  placeholder="Buscar por nombre o matrícula"
                  value={buscar}
                  onChange={(e) => setBuscar(e.target.value)}
                  aria-label="Buscar alumno"
                />
                <span className="text-xs text-ink-500">{elegidos.size} elegido{elegidos.size === 1 ? '' : 's'}</span>
                {elegidos.size ? (
                  <button type="button" className="min-h-[36px] rounded-lg px-2 text-xs font-semibold text-ink-600 hover:bg-ink-100" onClick={() => setElegidos(new Set())}>
                    Quitar todos
                  </button>
                ) : null}
              </div>
              <ul className="max-h-72 divide-y divide-ink-100 overflow-y-auto rounded-xl border border-ink-200 bg-white">
                {visiblesLista.map((a) => (
                  <li key={a.id}>
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 hover:bg-ink-50">
                      <input type="checkbox" className="h-4 w-4" checked={elegidos.has(a.id)} onChange={() => alternarAlumno(a.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink-900">
                          {a.apellidos} {a.nombre}
                        </span>
                        <span className="block truncate text-xs text-ink-500">
                          {[a.matricula, a.carrera_clave].filter(Boolean).join(' · ') || 'Sin matrícula'}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
                {visiblesLista.length === 0 ? <li className="px-3 py-3 text-sm text-ink-500">Nadie coincide con la búsqueda.</li> : null}
              </ul>
            </div>
          ) : null}
          {para !== 'todos' ? <p className="text-xs text-ink-500">Solo ellos la ven y reciben el aviso; a los demás no les aparece ni les cuenta en la calificación.</p> : null}
        </Tarjeta>

        {totalBanco > 1 ? (
          <Tarjeta className="space-y-3">
            <Casilla
              etiqueta="Preguntas al azar por alumno"
              detalle={`A cada alumno le toca su propio sorteo de las ${totalBanco} preguntas, en otro orden y con las opciones revueltas; si recarga, ve el mismo. Se califica sobre las suyas.`}
              marcada={azar}
              onCambio={setAzar}
            />
            {azar ? (
              <div className="space-y-2">
                <div className="grid gap-3 sm:grid-cols-3">
                  {campoAzar('Opción múltiple', azarOm, setAzarOm, hay.opcion_multiple)}
                  {campoAzar('Verdadero / falso', azarVf, setAzarVf, hay.verdadero_falso)}
                  {campoAzar('Abiertas', azarAb, setAzarAb, hay.abierta)}
                </div>
                <p className="text-xs text-ink-500">
                  Cada alumno contesta {porAlumno.opcion_multiple + porAlumno.verdadero_falso + porAlumno.abierta} preguntas y el examen le vale {valePorAlumno} pts.
                </p>
              </div>
            ) : null}
          </Tarjeta>
        ) : null}

        <Tarjeta className="space-y-3">
          <h3 className="font-semibold text-ink-900">Ventana de tiempo</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo etiqueta="Abre" type="datetime-local" value={abre} onChange={(e) => setAbre(e.target.value)} required />
            <Campo etiqueta="Cierra (opcional)" type="datetime-local" value={cierra} onChange={(e) => setCierra(e.target.value)} min={abre} />
          </div>
          <Campo etiqueta="Duración en minutos (vacío = sin límite)" type="number" inputMode="numeric" min={0} step={1} value={duracion} onChange={(e) => setDuracion(e.target.value)} placeholder="Sin límite" />
          <p className="text-xs text-ink-500">Las horas se toman de tu dispositivo y se muestran a los alumnos en hora de Ciudad de México.</p>
        </Tarjeta>

        <Tarjeta className="space-y-2">
          <h3 className="font-semibold text-ink-900">Reglas</h3>
          <Casilla etiqueta="Vigilancia" detalle="Pantalla completa obligatoria; se registra si el alumno sale de la pestaña, cambia de aplicación o copia y pega." marcada={vigilancia} onCambio={(v) => {
            setVigilancia(v)
            // El bloqueo necesita la vigilancia: sin ella también se quita
            if (!v) setBloqueo(false)
          }} />
          {vigilancia && (
            <Casilla
              etiqueta="Cerrar el examen a la segunda salida"
              detalle="A la primera vez que salga (otra pestaña, otra aplicación o escritorio, un aviso o salir de pantalla completa) se le advierte; a la segunda su examen se envía solo con lo que lleve."
              marcada={cerrarAlSalir}
              onCambio={setCerrarAlSalir}
            />
          )}
          <Casilla
            etiqueta="Bloquear pantalla"
            detalle="El alumno solo puede estar en el examen y en pantalla completa: si sale, el examen se tapa hasta que regrese, y no puede abrir otra parte del portal. Al enviar se libera. Tú lo quitas o lo vuelves a poner en vivo desde Entregas (a todos o a uno). Incluye la vigilancia."
            marcada={bloqueo}
            onCambio={(v) => {
              setBloqueo(v)
              if (v) setVigilancia(true)
            }}
          />
          <Casilla
            etiqueta="Contestar todas para poder enviar"
            detalle="Con alguna pregunta en blanco el botón Enviar queda bloqueado y se le dice cuáles le faltan. Si se acaba el tiempo o se cierra por salidas, se envía de todos modos."
            marcada={todasObligatorias}
            onCambio={setTodasObligatorias}
          />
          <Casilla etiqueta="Permitir borrador" detalle="El alumno puede guardar y volver después antes de enviar." marcada={permiteBorrador} onCambio={setPermiteBorrador} />
          <Casilla etiqueta="Permitir archivos" detalle="Hasta 5 archivos de 25 MB por entrega (PDF, Office, código, imágenes…)." marcada={permiteArchivos} onCambio={setPermiteArchivos} />
          <Casilla etiqueta="Mostrar resultado al alumno" detalle="Su calificación sobre 10 y lo que aporta a su parcial. Si se desmarca, el alumno ve que fue revisado pero no su puntaje ni la retroalimentación." marcada={mostrarResultado} onCambio={setMostrarResultado} />
          {mostrarResultado ? (
            <div className="grid gap-3 rounded-xl border border-ink-200 bg-white px-3 py-2.5 sm:grid-cols-2">
              <Selector etiqueta="Respuestas correctas e incorrectas" value={mostrarRespuestas} onChange={(e) => setMostrarRespuestas(e.target.value as MostrarRespuestas)}>
                {OPCIONES_RESPUESTAS.map(([v, t]) => (
                  <option key={v} value={v}>{t}</option>
                ))}
              </Selector>
              <Campo
                etiqueta="Vale en el parcial (%)"
                type="number"
                inputMode="decimal"
                min={0}
                max={100}
                step="any"
                value={ponderacion}
                onChange={(e) => setPonderacion(e.target.value)}
                placeholder={esExamen ? 'Automático: el del examen en tu esquema (30 %)' : 'Sin ponderación'}
              />
              <p className="text-xs text-ink-500 sm:col-span-2">El alumno ve cada pregunta con lo que contestó, la respuesta correcta y la explicación («al cerrar»: hasta que pase la fecha límite o lo cierres, para que nadie se las pase a quien sigue contestando), y cuánto le aporta este examen a su parcial (p. ej. 8.0 × 30 % = 2.4 de 3.0).</p>
            </div>
          ) : null}
        </Tarjeta>

        <ErrorServidor texto={error} />
        <Boton type="submit" className="w-full" disabled={enviando}>{enviando ? 'Publicando…' : 'Publicar a los alumnos'}</Boton>
      </form>
    </div>
  )
}
