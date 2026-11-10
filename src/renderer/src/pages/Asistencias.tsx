import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import Encabezado from '../components/Encabezado'
import { avisar } from '../components/Aviso'
import { api, type MatrizAsistencia } from '../lib/api'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, Segmentado, SinResultados, coincide, ordenNatural } from '../components/Filtros'
import { ETIQUETA_RIESGO } from '@shared/asistencia'
import type { Carrera, EstadoAsistencia, Materia } from '@shared/types'

/** Orden al hacer clic en una celda */
const CICLO: EstadoAsistencia[] = ['presente', 'ausente', 'retardo', 'justificado']
const CELDA: Record<EstadoAsistencia, { t: string; c: string; n: string }> = {
  presente: { t: 'P', c: 'bg-green-100 text-green-800', n: 'Presente' },
  ausente: { t: 'F', c: 'bg-red-100 text-red-700', n: 'Falta' },
  retardo: { t: 'R', c: 'bg-amber-100 text-amber-800', n: 'Retardo' },
  justificado: { t: 'J', c: 'bg-sky-100 text-sky-800', n: 'Justificada' }
}
const RIESGO_COLOR: Record<string, string> = { ok: 'bg-green-100 text-green-700', atencion: 'bg-amber-100 text-amber-800', extraordinario: 'bg-red-100 text-red-700', titulo: 'bg-red-100 text-red-700', recursa: 'bg-red-600 text-white' }
const diaMes = (f: string): string => new Date(f + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '')

type Sesion = MatrizAsistencia['sesiones'][number]
type AlumnoM = MatrizAsistencia['alumnos'][number]

/** Niveles por faltas (comunicado COM-AS-01) más «Alerta»: aún en regla pero a una clase o menos del límite */
type Nivel = 'recursa' | 'titulo' | 'extraordinario' | 'atencion' | 'alerta'
const NIVELES: { n: Nivel; t: string; d: string; c: string }[] = [
  { n: 'recursa', t: 'Recursa', d: 'Pasó el máximo de horas: recursa la materia', c: 'border-red-600 bg-red-600 text-white' },
  { n: 'titulo', t: 'Título de suficiencia', d: 'Ya no tiene extraordinario: va a título', c: 'border-red-300 bg-red-50 text-red-800' },
  { n: 'extraordinario', t: 'Extraordinario', d: 'Por faltas ya va a extraordinario', c: 'border-red-300 bg-red-50 text-red-800' },
  { n: 'atencion', t: 'En el límite', d: 'Llegó al límite: una falta más y va a extraordinario', c: 'border-amber-300 bg-amber-50 text-amber-900' },
  { n: 'alerta', t: 'Alerta', d: 'Aún en regla, pero a una clase o menos del límite', c: 'border-amber-200 bg-amber-50/60 text-amber-900' }
]
const FONDO_NIVEL: Record<Nivel, string> = { recursa: 'bg-red-100', titulo: 'bg-red-50', extraordinario: 'bg-red-50', atencion: 'bg-amber-50', alerta: 'bg-amber-50/60' }
const redondear = (x: number): number => Math.round(x * 10) / 10
/** Llave de una celda en la selección */
const llave = (alumno: number, sesion: number): string => `${alumno}:${sesion}`
const SIN_SELECCION = new Set<number>()

/** Filtros de la cuadrícula: solo cambian qué filas se ven, nunca las horas ni la situación */
type Situacion = 'todos' | 'faltas' | 'riesgo' | 'sin'
type OrdenFilas = 'apellidos' | 'nombre' | 'horas' | 'matricula'
const SITUACIONES: [Situacion, string][] = [['todos', 'Todos'], ['faltas', 'Con faltas'], ['riesgo', 'En riesgo'], ['sin', 'Sin faltas']]
const ORDENES: [OrdenFilas, string][] = [['apellidos', 'Apellidos'], ['nombre', 'Nombre'], ['horas', 'Más horas de falta'], ['matricula', 'Matrícula']]

/** Una fila: memorizada para que cambiar una celda no vuelva a pintar las 20 filas. */
const Fila = memo(function Fila({
  a,
  sesiones,
  estados,
  cambiar,
  limite,
  nivel,
  fi,
  sel,
  carrera
}: {
  a: MatrizAsistencia['alumnos'][number]
  /** Solo en materias con alumnos de varias carreras: su clave con su color */
  carrera?: Carrera
  nivel: Nivel | null
  /** Posición de la fila (para seleccionar arrastrando) */
  fi: number
  /** Sesiones seleccionadas de este alumno */
  sel: Set<number>
  sesiones: Sesion[]
  estados: Map<number, EstadoAsistencia>
  cambiar: (sesion: Sesion, alumno: number, actual: EstadoAsistencia | undefined, teclado: boolean) => void
  limite: number
}): JSX.Element {
  const faltas = sesiones.filter((s) => estados.get(s.id) === 'ausente').length
  return (
    <tr className="border-t border-ink-100">
      {/* Columna fija: nombre y totales siempre a la vista aunque se desplace la tabla */}
      <th scope="row" className={`sticky left-0 z-10 px-3 py-1 text-left font-medium border-r border-ink-100 min-w-[15rem] max-w-[20rem] ${nivel ? FONDO_NIVEL[nivel] : 'bg-white'}`}>
        <Link to={`/alumnos/${a.id}`} className="block truncate hover:underline" title={`${a.apellidos} ${a.nombre}`}>{`${a.apellidos} ${a.nombre}`.trim()}</Link>
        <div className="flex flex-wrap items-center gap-x-2 text-xs font-normal text-ink-500">
          {carrera && <span className="rounded px-1 text-[10px] font-bold" style={{ color: carrera.color, backgroundColor: `${carrera.color}18` }} title={carrera.nombre}>{carrera.clave}</span>}
          <span title="Faltas en las clases que se ven">{faltas} falta{faltas === 1 ? '' : 's'}</span>
          <span className="font-mono" title="Horas de falta en todo el curso / límite oficial">{a.horas_falta}/{limite} h</span>
          {a.porcentaje != null && <span>{Math.round(a.porcentaje)} %</span>}
          <span className={`chip !py-0 ${RIESGO_COLOR[a.riesgo] ?? ''}`}>{ETIQUETA_RIESGO[a.riesgo]}</span>
        </div>
      </th>
      {sesiones.map((s, ci) => {
        const e = estados.get(s.id)
        const elegida = sel.has(s.id)
        return (
          <td key={s.id} className="p-0.5 text-center">
            {s.estado === 'cancelada' ? (
              <span className="block w-8 h-8 leading-8 text-ink-300" title="Clase cancelada">–</span>
            ) : (
              <button
                data-f={fi}
                data-c={ci}
                aria-pressed={elegida || undefined}
                className={`w-8 h-8 rounded font-mono text-sm ${e ? CELDA[e].c : 'border border-dashed border-ink-200 text-ink-300 hover:bg-ink-50'} ${elegida ? 'ring-2 ring-brand-500 ring-offset-1' : ''}`}
                title={`${diaMes(s.fecha)} · ${e ? CELDA[e].n : 'Sin registro'} (clic para cambiar; arrastra o ⌘ + clic para elegir varias)`}
                aria-label={`${a.apellidos} ${a.nombre}, ${diaMes(s.fecha)}: ${e ? CELDA[e].n : 'sin registro'}${elegida ? ', seleccionada' : ''}`}
                onClick={(ev) => cambiar(s, a.id, e, ev.detail === 0)}
              >
                {e ? CELDA[e].t : '·'}
              </button>
            )}
          </td>
        )
      })}
    </tr>
  )
})

/**
 * Asistencias de una materia en una sola cuadrícula: revisar, corregir y pasar lista de clases que ya
 * pasaron. Cada clic cambia el estado (Presente → Falta → Retardo → Justificada) y se guarda al momento.
 */
export default function Asistencias(): JSX.Element {
  const [params] = useSearchParams()
  const [materias, setMaterias] = useState<Materia[]>([])
  const [materia, setMateria] = useRecordado<number | ''>('asistencias.materia', params.get('materia') ? Number(params.get('materia')) : '')
  const [parcial, setParcial] = useRecordado<number | ''>('asistencias.parcial', '')
  const [m, setM] = useState<MatrizAsistencia | null>(null)
  const [cargando, setCargando] = useState(false)
  // Los filtros se recuerdan: al abrir a un alumno y regresar siguen igual
  const [busqueda, setBusqueda] = useRecordado('asistencias.busqueda', '')
  const [situacion, setSituacion] = useRecordado<Situacion>('asistencias.situacion', 'todos')
  const [orden, setOrden] = useRecordado<OrdenFilas>('asistencias.orden', 'apellidos')
  // Materia con alumnos de varias carreras (Álgebra): se distinguen y se puede ver una sola
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [carreraF, setCarreraF] = useRecordado<number | ''>('asistencias.carrera', '')
  useEffect(() => {
    api.carreras.listar().then(setCarreras).catch(() => undefined)
  }, [])

  useEffect(() => {
    api.materias.listar().then((l) => {
      const visibles = l.filter((x) => !x.oculta)
      setMaterias(visibles)
      if (params.get('materia')) setMateria(Number(params.get('materia')))
      else if (materia === '' && visibles[0]) setMateria(visibles[0].id)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cargar = useCallback(async (): Promise<void> => {
    if (materia === '') return
    setCargando(true)
    try {
      setM(await api.asistencia.matriz(materia))
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setCargando(false)
    }
  }, [materia])
  useEffect(() => {
    void cargar()
  }, [cargar])

  const p = m?.parciales.find((x) => x.id === parcial)
  const sesiones = useMemo(() => (m ? m.sesiones.filter((s) => !p || (s.fecha >= p.desde && s.fecha <= p.hasta)) : []), [m, p])
  // estado por alumno → (sesión → estado), reconstruido solo cuando cambian los registros
  const porAlumno = useMemo(() => {
    const r = new Map<number, Map<number, EstadoAsistencia>>()
    for (const x of m?.registros ?? []) {
      if (!r.has(x.alumno_id)) r.set(x.alumno_id, new Map())
      r.get(x.alumno_id)!.set(x.sesion_id, x.estado)
    }
    return r
  }, [m])
  const sinLista = sesiones.filter((s) => s.estado !== 'cancelada' && !m?.registros.some((r) => r.sesion_id === s.id))

  // Horas de una clase (la más larga del horario): «Alerta» = le queda una clase o menos para el límite
  const horasClase = useMemo(() => {
    const h = (m?.sesiones ?? []).filter((s) => s.estado !== 'cancelada').map((s) => {
      const [a, b] = s.hora_inicio.split(':').map(Number)
      const [c, d] = s.hora_fin.split(':').map(Number)
      return (c * 60 + d - (a * 60 + b)) / 60
    })
    return h.length ? Math.max(...h) : 1
  }, [m])
  const nivelDe = useCallback(
    (a: AlumnoM): Nivel | null => {
      if (!m) return null
      if (a.riesgo !== 'ok') return a.riesgo
      return a.horas_falta > 0 && m.limites.limite - a.horas_falta <= horasClase ? 'alerta' : null
    },
    [m, horasClase]
  )
  /** «Con 1.5 h más va a extraordinario» */
  const siguiente = (a: AlumnoM): string => {
    if (!m) return ''
    const l = m.limites
    const escalones: [string, number][] = [['llega al límite', l.limite], ['va a extraordinario', l.extraordinario], ['va a título de suficiencia', l.titulo_suficiencia], ['recursa', l.recursa]]
    const s = escalones.find(([, u]) => a.horas_falta < u)
    if (!s) return 'ya recursa'
    const falta = redondear(s[1] - a.horas_falta)
    const clases = Math.ceil(falta / horasClase)
    return `con ${falta} h más (${clases === 1 ? '1 clase' : `${clases} clases`}) ${s[0]}`
  }
  const enRiesgo = useMemo(() => (m ? m.alumnos.map((a) => ({ a, n: nivelDe(a) })).filter((x): x is { a: AlumnoM; n: Nivel } => x.n !== null) : []), [m, nivelDe])
  const enMateria = useMemo(() => carreras.filter((c) => m?.alumnos.some((a) => a.carrera_id === c.id)), [carreras, m])
  const mixta = enMateria.length > 1
  // La carrera recordada solo cuenta si esta materia tiene alumnos de ella
  const carreraSel: number | '' = mixta && enMateria.some((c) => c.id === carreraF) ? carreraF : ''

  // Cada filtro por separado, para contar cuántos quedan en cada opción con los demás puestos
  const pasa = useMemo(
    () => ({
      busqueda: (a: AlumnoM) => coincide(busqueda, a.apellidos, a.nombre, a.matricula),
      carrera: (a: AlumnoM) => carreraSel === '' || a.carrera_id === carreraSel,
      situacion: (a: AlumnoM) => situacion === 'todos' || (situacion === 'riesgo' ? nivelDe(a) !== null : situacion === 'faltas' ? a.horas_falta > 0 : a.horas_falta === 0)
    }),
    [busqueda, carreraSel, situacion, nivelDe]
  )
  const salvo = (excepto: keyof typeof pasa): AlumnoM[] => (m?.alumnos ?? []).filter((a) => (Object.keys(pasa) as (keyof typeof pasa)[]).every((k) => k === excepto || pasa[k](a)))
  const filas = useMemo(() => {
    const valor = (a: AlumnoM): string => (orden === 'nombre' ? a.nombre : orden === 'matricula' ? a.matricula || '~' : a.apellidos)
    return (m?.alumnos ?? [])
      .filter((a) => Object.values(pasa).every((f) => f(a)))
      .sort((a, b) => (orden === 'horas' ? b.horas_falta - a.horas_falta : 0) || ordenNatural(valor(a), valor(b)) || ordenNatural(a.apellidos, b.apellidos) || ordenNatural(a.nombre, b.nombre))
  }, [m, pasa, orden])
  const hayFiltro = !!busqueda.trim() || carreraSel !== '' || situacion !== 'todos'
  const quitarFiltros = (): void => {
    setBusqueda('')
    setCarreraF('')
    setSituacion('todos')
  }
  const vacio = useMemo(() => new Map<number, EstadoAsistencia>(), [])

  // Al cambiar una celda: se pinta al momento y se guarda; los totales se recalculan sin bloquear
  const ciclar = useCallback(
    async (s: Sesion, alumno: number, actual: EstadoAsistencia | undefined): Promise<void> => {
      const siguiente = actual ? CICLO[(CICLO.indexOf(actual) + 1) % CICLO.length] : 'presente'
      setM((x) =>
        x && {
          ...x,
          registros: [...x.registros.filter((r) => !(r.sesion_id === s.id && r.alumno_id === alumno)), { sesion_id: s.id, alumno_id: alumno, estado: siguiente, nota: '' }]
        }
      )
      try {
        if (siguiente === 'justificado') await api.asistencia.justificar(s.id, alumno, 'Justificada desde Asistencias')
        else await api.asistencia.marcar(s.id, alumno, siguiente)
        if (materia === '') return
        // Solo se refrescan los totales (horas, %, situación); las celdas ya están pintadas
        const n = await api.asistencia.matriz(materia)
        setM((x) => (x ? { ...x, alumnos: n.alumnos } : n))
      } catch (e) {
        avisar((e as Error).message, 'error')
        void cargar()
      }
    },
    [materia, cargar]
  )

  /*
   * Selección de varias celdas: arrastrar con el mouse (fila, columna o bloque), ⌘/Ctrl + clic para
   * agregar o quitar una, Mayúsculas + clic para el bloque desde la última, o «Elegir varias» en
   * pantallas táctiles (cada toque agrega o quita). Luego se marcan todas juntas desde la barra.
   */
  const [seleccion, setSeleccion] = useState<Set<string>>(() => new Set())
  const [modoElegir, setModoElegir] = useState(false)
  const ancla = useRef<{ f: number; c: number } | null>(null)
  const arrastre = useRef<{ f: number; c: number; base: Set<string> } | null>(null)
  const suprimirClic = useRef(false)
  const [guardando, setGuardando] = useState(false)
  const rejilla = useRef({ filas, sesiones })
  rejilla.current = { filas, sesiones }

  // Al cambiar de materia, parcial o filtro, la selección ya no corresponde a lo que se ve
  useEffect(() => {
    setSeleccion(new Set())
    ancla.current = null
  }, [materia, parcial, busqueda, situacion, carreraSel, orden])
  useEffect(() => {
    const soltar = (): void => {
      arrastre.current = null
    }
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSeleccion((x) => (x.size ? new Set() : x))
    }
    window.addEventListener('pointerup', soltar)
    window.addEventListener('pointercancel', soltar)
    window.addEventListener('keydown', tecla)
    return () => {
      window.removeEventListener('pointerup', soltar)
      window.removeEventListener('pointercancel', soltar)
      window.removeEventListener('keydown', tecla)
    }
  }, [])

  /** Celdas de un bloque (sin clases canceladas) */
  const bloque = (a: { f: number; c: number }, b: { f: number; c: number }): string[] => {
    const { filas: fs, sesiones: ss } = rejilla.current
    const r: string[] = []
    for (let f = Math.min(a.f, b.f); f <= Math.max(a.f, b.f); f++)
      for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) if (fs[f] && ss[c] && ss[c].estado !== 'cancelada') r.push(llave(fs[f].id, ss[c].id))
    return r
  }
  const celdaDe = (t: EventTarget): { f: number; c: number } | null => {
    const b = (t as HTMLElement).closest?.('button[data-f]') as HTMLElement | null
    return b ? { f: Number(b.dataset.f), c: Number(b.dataset.c) } : null
  }
  const alPresionar = (e: React.PointerEvent): void => {
    const p = celdaDe(e.target)
    if (!p || e.button !== 0) return
    const k = bloque(p, p)[0]
    if (e.shiftKey && ancla.current) {
      const desde = ancla.current
      setSeleccion((x) => new Set([...x, ...bloque(desde, p)]))
      suprimirClic.current = true
    } else if (e.metaKey || e.ctrlKey) {
      setSeleccion((x) => {
        const n = new Set(x)
        if (n.has(k)) n.delete(k)
        else n.add(k)
        return n
      })
      ancla.current = p
      suprimirClic.current = true
    } else if (e.pointerType === 'mouse') {
      // Puede ser un clic normal o el inicio de un arrastre: se decide al pasar a otra celda
      arrastre.current = { ...p, base: new Set() }
      ancla.current = p
      suprimirClic.current = false
    }
  }
  const alPasar = (e: React.PointerEvent): void => {
    const d = arrastre.current
    if (!d) return
    const p = celdaDe(e.target)
    if (!p || (p.f === d.f && p.c === d.c && !suprimirClic.current)) return
    suprimirClic.current = true
    setSeleccion(new Set([...d.base, ...bloque(d, p)]))
  }
  const cambiar = useCallback(
    (s: Sesion, alumno: number, actual: EstadoAsistencia | undefined, teclado: boolean): void => {
      if (suprimirClic.current && !teclado) {
        suprimirClic.current = false
        return
      }
      if (modoElegir) {
        const k = llave(alumno, s.id)
        setSeleccion((x) => {
          const n = new Set(x)
          if (n.has(k)) n.delete(k)
          else n.add(k)
          return n
        })
        return
      }
      setSeleccion((x) => (x.size ? new Set() : x))
      void ciclar(s, alumno, actual)
    },
    [modoElegir, ciclar]
  )
  const selPorAlumno = useMemo(() => {
    const r = new Map<number, Set<number>>()
    for (const k of seleccion) {
      const [a, s] = k.split(':').map(Number)
      if (!r.has(a)) r.set(a, new Set())
      r.get(a)!.add(s)
    }
    return r
  }, [seleccion])
  const marcarSeleccion = async (estado: EstadoAsistencia): Promise<void> => {
    const celdas = [...seleccion].map((k) => {
      const [alumno_id, sesion_id] = k.split(':').map(Number)
      return { alumno_id, sesion_id }
    })
    if (!celdas.length || materia === '') return
    setGuardando(true)
    setM((x) =>
      x && {
        ...x,
        registros: [...x.registros.filter((r) => !seleccion.has(llave(r.alumno_id, r.sesion_id))), ...celdas.map((c) => ({ ...c, estado, nota: '' }))]
      }
    )
    try {
      await api.asistencia.marcarVarios(celdas, estado)
      avisar(`${celdas.length === 1 ? '1 celda quedó' : `${celdas.length} celdas quedaron`} como ${CELDA[estado].n.toLowerCase()}`)
      setSeleccion(new Set())
      const n = await api.asistencia.matriz(materia)
      setM((x) => (x ? { ...x, alumnos: n.alumnos } : n))
    } catch (e) {
      avisar((e as Error).message, 'error')
      void cargar()
    } finally {
      setGuardando(false)
    }
  }
  const vacioSel = SIN_SELECCION

  const todosPresentes = async (s: Sesion): Promise<void> => {
    if (!m) return
    // Con filtro de carrera, solo a los de esa carrera (la búsqueda y la situación no cuentan aquí)
    await api.asistencia.marcarTodos(s.id, m.alumnos.filter((a) => carreraSel === '' || a.carrera_id === carreraSel).map((a) => a.id), 'presente')
    avisar(`${diaMes(s.fecha)}: los que no tenían registro quedaron presentes`)
    void cargar()
  }

  const contarEn = (l: AlumnoM[], f: (a: AlumnoM) => boolean): number => l.filter(f).length
  const paraSituacion = salvo('situacion')
  const paraCarrera = salvo('carrera')
  const cumpleSituacion = (k: Situacion, a: AlumnoM): boolean => (k === 'todos' ? true : k === 'riesgo' ? nivelDe(a) !== null : k === 'faltas' ? a.horas_falta > 0 : a.horas_falta === 0)

  return (
    <div>
      <Encabezado
        titulo="Asistencias"
        sub="Revisa y corrige el pase de lista de cada clase; cada cambio se guarda al momento"
        acciones={
          <>
            <select className="input w-auto max-w-[16rem]" value={materia} onChange={(e) => { setMateria(e.target.value ? Number(e.target.value) : ''); setParcial('') }} aria-label="Materia">
              {materias.map((x) => (
                <option key={x.id} value={x.id}>{x.nombre}</option>
              ))}
            </select>
            <select className="input w-auto max-w-[12rem]" value={parcial} onChange={(e) => setParcial(e.target.value ? Number(e.target.value) : '')} aria-label="Parcial">
              <option value="">Todo el periodo</option>
              {m?.parciales.map((x) => (
                <option key={x.id} value={x.id}>{x.nombre}</option>
              ))}
            </select>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-5 space-y-4">
        {!m ? (
          <div className="tarjeta px-5 py-10 text-center text-sm text-ink-500">
            {cargando ? 'Cargando…' : materias.length === 0 ? 'No hay materias visibles. Crea una o deja de ocultarla en Materias.' : 'Elige una materia arriba para ver su pase de lista.'}
          </div>
        ) : (
          <>
            {/* Quién va mal por faltas, del caso más grave al menos grave */}
            <section className="tarjeta p-4 space-y-3" aria-label="Alumnos en riesgo por faltas">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <h2 className="font-semibold">Riesgo por faltas</h2>
                  <p className="text-xs text-ink-500">
                    Límite oficial {m.limites.limite} h · extraordinario desde {m.limites.extraordinario} h · recursa con {m.limites.recursa} h
                  </p>
                </div>
                {enRiesgo.length > 0 && (
                  <button className="btn-secundario text-xs py-1" aria-pressed={situacion === 'riesgo'} onClick={() => setSituacion(situacion === 'riesgo' ? 'todos' : 'riesgo')}>
                    {situacion === 'riesgo' ? 'Ver a todos en la cuadrícula' : `Ver solo a ${enRiesgo.length === 1 ? 'él' : `los ${enRiesgo.length}`} en la cuadrícula`}
                  </button>
                )}
              </div>
              {enRiesgo.length === 0 ? (
                <p className="text-sm text-green-700">Nadie está en riesgo por faltas en esta materia.</p>
              ) : (
                <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
                  {NIVELES.map((nv) => {
                    const lista = enRiesgo.filter((x) => x.n === nv.n).sort((x, y) => y.a.horas_falta - x.a.horas_falta)
                    if (!lista.length) return null
                    return (
                      <div key={nv.n} className={`min-w-0 rounded-lg border px-3 py-2 ${nv.c}`}>
                        <div className="font-semibold">
                          {nv.t} <span className="font-normal">· {lista.length}</span>
                        </div>
                        <div className="text-xs opacity-80">{nv.d}</div>
                        <ul className="mt-1.5 space-y-1 text-sm">
                          {lista.map(({ a }) => (
                            <li key={a.id} className="min-w-0">
                              <Link to={`/alumnos/${a.id}`} className="font-medium break-words hover:underline">{`${a.apellidos} ${a.nombre}`.trim()}</Link>
                              <span className="block text-xs opacity-90">
                                {a.horas_falta} h de falta · {siguiente(a)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
            {sinLista.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">
                <b>{sinLista.length === 1 ? '1 clase' : `${sinLista.length} clases`} sin pase de lista</b> (columnas en ámbar). Usa «todos P» en la columna y luego marca las faltas, o cancela la clase en Plan y sesiones si no hubo.
              </div>
            )}

            {/* Filtros: solo cambian qué alumnos se ven en la cuadrícula (se recuerdan al abrir a un alumno y regresar) */}
            {m.alumnos.length > 0 && (
              <div className="tarjeta p-3 space-y-2.5" role="search" aria-label="Filtrar alumnos">
                <div className="flex flex-wrap items-center gap-2">
                  <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por nombre o matrícula" etiqueta="Buscar alumno" />
                  <Segmentado
                    etiqueta="Situación por faltas"
                    valor={situacion}
                    onCambio={setSituacion}
                    opciones={SITUACIONES.map(([k, t]) => ({ valor: k, texto: t, conteo: contarEn(paraSituacion, (a) => cumpleSituacion(k, a)) }))}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-ink-500">
                    Ordenar
                    <select className="input w-auto py-1" value={orden} onChange={(e) => setOrden(e.target.value as OrdenFilas)} aria-label="Ordenar alumnos">
                      {ORDENES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                    </select>
                  </label>
                  {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {mixta && (
                    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Carrera">
                      <ChipFiltro activo={carreraSel === ''} onClick={() => setCarreraF('')} conteo={paraCarrera.length}>Todas las carreras</ChipFiltro>
                      {enMateria.map((c) => (
                        <ChipFiltro key={c.id} activo={carreraSel === c.id} color={c.color} titulo={c.nombre} onClick={() => setCarreraF(carreraSel === c.id ? '' : c.id)} conteo={contarEn(paraCarrera, (a) => a.carrera_id === c.id)}>
                          {c.clave}
                        </ChipFiltro>
                      ))}
                    </div>
                  )}
                  <Conteo visibles={filas.length} total={m.alumnos.length} nombre="alumnos" hayFiltro={hayFiltro} />
                </div>
              </div>
            )}

            {/* Leyenda de la cuadrícula y la herramienta para marcar varias celdas juntas */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-600">
              {Object.entries(CELDA).map(([k, v]) => (
                <span key={k} className="flex items-center gap-1 whitespace-nowrap">
                  <span className={`inline-block w-5 h-5 rounded text-center leading-5 font-mono text-[11px] ${v.c}`}>{v.t}</span>
                  {v.n}
                </span>
              ))}
              <span className="text-ink-400">Clic en una celda: Presente → Falta → Retardo → Justificada · arrastra o ⌘ + clic para elegir varias</span>
              <button
                className={`${modoElegir ? 'btn-primario' : 'btn-secundario'} ml-auto !py-1 text-xs`}
                aria-pressed={modoElegir}
                title="Cada toque agrega o quita una celda; luego márcalas todas juntas. Con mouse también puedes arrastrar o usar ⌘ + clic."
                onClick={() => {
                  setModoElegir((x) => !x)
                  setSeleccion(new Set())
                }}
              >
                {modoElegir ? 'Terminar de elegir' : 'Elegir varias'}
              </button>
            </div>

            <div className="tarjeta overflow-x-auto">
              {filas.length === 0 ? (
                <SinResultados
                  hayFiltro={hayFiltro && m.alumnos.length > 0}
                  onLimpiar={quitarFiltros}
                  vacio={
                    <>
                      <div className="font-medium text-ink-700">No hay alumnos inscritos en esta materia</div>
                      <p className="mt-1">Inscríbelos desde la materia o desde el Modo clase para pasarles lista.</p>
                      <Link to={`/materias/${materia}`} className="btn-secundario mt-3">Ir a la materia</Link>
                    </>
                  }
                />
              ) : (
                <table className="text-sm border-separate border-spacing-0 select-none" onPointerDown={alPresionar} onPointerOver={alPasar}>
                  <thead>
                    <tr className="text-xs text-ink-500">
                      <th className="sticky left-0 z-20 bg-white px-3 py-2 text-left align-bottom font-medium border-r border-ink-100">
                        Alumno · faltas · horas/límite
                        {sesiones.length === 0 && <span className="block font-normal text-ink-400">Sin clases en este periodo</span>}
                      </th>
                      {sesiones.map((s) => {
                        const sin = sinLista.includes(s)
                        return (
                          <th key={s.id} className={`px-0.5 py-1 font-normal align-top ${sin ? 'bg-amber-50' : ''}`}>
                            <div className={`w-8 h-8 text-center leading-tight ${s.estado === 'cancelada' ? 'line-through text-ink-300' : ''}`} title={`${s.fecha} ${s.hora_inicio}–${s.hora_fin} · ${s.tema || 'sin tema'}${s.estado === 'cancelada' ? ' (cancelada)' : ''}`}>
                              {/* Siempre día arriba y mes abajo: «3 sep» y «10 sep» quedan alineados */}
                              <span className="block font-medium text-ink-700">{diaMes(s.fecha).split(' ')[0]}</span>
                              <span className="block text-[10px] uppercase text-ink-400">{diaMes(s.fecha).split(' ').slice(1).join(' ')}</span>
                            </div>
                            {sin ? (
                              <button
                                className="mt-1 w-8 rounded bg-amber-200 text-[10px] leading-tight text-amber-900 hover:bg-amber-300"
                                title={`Marcar presentes a todos los que no tienen registro${carreraSel !== '' ? ' (solo de la carrera elegida)' : ''}`}
                                onClick={() => todosPresentes(s)}
                              >
                                todos P
                              </button>
                            ) : (
                              <div className="mt-1 h-[26px]" aria-hidden />
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((a, i) => (
                      <Fila key={a.id} a={a} fi={i} sel={selPorAlumno.get(a.id) ?? vacioSel} sesiones={sesiones} estados={porAlumno.get(a.id) ?? vacio} cambiar={cambiar} limite={m.limites.limite} nivel={nivelDe(a)} carrera={mixta ? enMateria.find((c) => c.id === a.carrera_id) : undefined} />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {seleccion.size > 0 && (
              <div className="sticky bottom-3 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2 shadow-lg" role="toolbar" aria-label="Marcar celdas seleccionadas">
                <span className="text-sm font-medium">
                  {seleccion.size === 1 ? '1 celda' : `${seleccion.size} celdas`} · marcar como:
                </span>
                {CICLO.map((e) => (
                  <button key={e} className={`rounded px-2.5 py-1 text-sm font-medium ${CELDA[e].c} hover:brightness-95 disabled:opacity-50`} disabled={guardando} onClick={() => marcarSeleccion(e)}>
                    <span className="font-mono">{CELDA[e].t}</span> {CELDA[e].n}
                  </button>
                ))}
                <button className="btn-fantasma !py-1 text-sm" onClick={() => setSeleccion(new Set())} title="Quitar la selección (Esc)">
                  ✕ Quitar selección
                </button>
              </div>
            )}
            <p className="text-xs text-ink-500">Las horas de falta cuentan todo el curso (comunicado de asistencias); el filtro de parcial solo cambia las clases que ves. Una justificada no cuenta como falta.</p>
          </>
        )}
      </div>
    </div>
  )
}
