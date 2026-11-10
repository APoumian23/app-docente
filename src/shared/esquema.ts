/**
 * Calificación por esquema: cada materia tiene parciales y, por parcial, componentes con peso
 * (examen, asistencia, tareas, actividades, participación…). Aquí solo está el cálculo, sin base de datos,
 * para que la pestaña Calificaciones, el detalle del alumno, el Excel y las pruebas den lo mismo.
 *
 * Un componente sin datos todavía no cuenta como cero: queda «pendiente» y la calificación del parcial
 * se reparte entre los pesos de lo ya evaluado (se marca como provisional y se dice qué porcentaje lleva).
 * Para que algo cuente como cero hay que capturarlo así (0, «no entregó» o «no entregado» en la evaluación).
 * Mientras no haya al menos la mitad del peso evaluado, el estado queda «Pendiente» (no se dice aún si aprueba).
 */

export type Fuente = 'evaluaciones' | 'asistencia' | 'actividades' | 'participacion' | 'manual' | 'classroom_promedio' | 'classroom_entregas'

export const ETIQUETA_FUENTE: Record<Fuente, string> = {
  evaluaciones: 'Evaluaciones de la app',
  asistencia: 'Asistencia del parcial',
  actividades: 'Actividades entregadas',
  participacion: 'Participaciones',
  manual: 'Captura manual',
  classroom_promedio: 'Tareas de Classroom (promedio)',
  classroom_entregas: 'Trabajos entregados de Classroom (%)'
}

export interface Componente {
  id: number
  parcial_id: number
  orden: number
  nombre: string
  peso: number // porcentaje del parcial
  fuente: Fuente
  evaluaciones: number[]
  escala: number // captura manual: calificación máxima
  rubros: string[] // captura manual: lo que se captura (vacío = una sola calificación)
  meta: number // participación: cuántas valen el 100 %
}

export interface Parcial {
  id: number
  materia_id: number
  orden: number
  nombre: string
  desde: string // YYYY-MM-DD
  hasta: string
  peso: number // peso en la calificación final
  /** 1 = los alumnos ven este parcial en «Mi avance» del portal */
  publicado?: number
  componentes: Componente[]
}

export interface Esquema {
  materia_id: number
  minima: number // 0–10
  asistencia_minima: number | null // % del parcial; por debajo queda «NA por inasistencias»
  retardo_vale: number // 1 = cuenta como asistencia completa
  escala_100: boolean // se suma sobre 100, se redondea a un decimal y luego se pasa a 10
  nota: string
  parciales: Parcial[]
}

/** Tipos de evaluación que son material del docente, no trabajo del alumno. */
export const TIPOS_MATERIAL = ['ejemplos', 'glosario', 'material_apoyo', 'plan_sesion', 'presentacion', 'clase_completa', 'apuntes']

export interface DatosCalculo {
  alumnos: number[]
  evaluaciones: { id: number; tipo: string; puntos_totales: number; fecha: string | null }[]
  resultados: { evaluacion_id: number; alumno_id: number; puntaje: number | null; estado: string }[]
  /** Envíos del portal (intentos enviados o calificados) aunque aún no tengan calificación. */
  entregas: { evaluacion_id: number; alumno_id: number }[]
  /**
   * Evaluaciones que solo se asignaron a algunos alumnos (en todas sus publicaciones): a quiénes. Para los demás
   * esa evaluación no existe y no les cuenta. Sin la evaluación en la lista = es de todos.
   */
  soloPara?: { evaluacion_id: number; alumno_id: number }[]
  asistencias: { alumno_id: number; fecha: string; estado: string }[]
  participaciones: { alumno_id: number; fecha: string }[]
  capturas: { componente_id: number; alumno_id: number; rubro: number; valor: number | null; entregado: number | null; extra: number | null }[]
  /** Día de corte (YYYY-MM-DD). Sin él, todos los parciales se toman como terminados. */
  hoy?: string
  /** Sesiones programadas (no canceladas): para saber si en un parcial en curso aún se puede llegar a la asistencia mínima. */
  sesiones?: { fecha: string }[]
  /**
   * Tareas de Classroom ya consolidadas (duplicados y recuperaciones resueltos), una fila por alumno y tarea.
   * `fecha` es el día (Ciudad de México) que ubica la tarea en un parcial: su fecha límite o, sin ella, su creación.
   */
  classroom?: { tarea: string; nombre: string; fecha: string | null; alumno_id: number; estado: string; calificacion: number | null; puntos: number | null; adicional?: boolean }[]
  /** La materia tiene algún curso de Classroom ligado. Sin el dato, se supone que sí cuando hay filas. */
  classroomConectado?: boolean
  /** Alumnos de la app ligados a Classroom. Sin el dato, se suponen todos. */
  classroomLigados?: number[]
  /** Calificaciones de parcial puestas a mano por el docente (reemplazan al cálculo) */
  ajustes?: { parcial_id: number; alumno_id: number; calificacion: number; nota: string }[]
  /** Calificaciones finales puestas a mano */
  ajustesFinal?: { alumno_id: number; calificacion: number; nota: string }[]
}

export interface ValorComponente {
  componente_id: number
  valor: number | null // 0–10, sin redondear
  detalle: string
  /** No hay de dónde leerlo (Classroom sin conectar o alumno sin ligar): el parcial no dice si aprueba. */
  sin_fuente?: boolean
}

export type EstadoCalif = 'aprobado' | 'reprobado' | 'na_inasistencia' | 'pendiente'

export const ETIQUETA_ESTADO_CALIF: Record<EstadoCalif, string> = {
  aprobado: 'Aprobado',
  reprobado: 'Reprobado',
  na_inasistencia: 'NA por inasistencias',
  pendiente: 'Pendiente'
}

export interface ResultadoParcial {
  parcial_id: number
  componentes: ValorComponente[]
  calificacion: number | null // 0–10, un decimal
  total100: number | null // sobre 100 (con la regla de redondeo del esquema)
  evaluado: number // % del peso que ya tiene datos
  asistencia: number | null // % de asistencia en el rango del parcial
  estado: EstadoCalif
  provisional: boolean
  /** El docente puso la calificación a mano: `calculada` es lo que daba el cálculo */
  ajustada?: { calculada: number | null; nota: string }
}

export interface ResultadoAlumno {
  alumno_id: number
  parciales: ResultadoParcial[]
  final: number | null
  estado: EstadoCalif
  provisional: boolean
  asistencia: number | null // % en todo el periodo del esquema
  /** Final puesta a mano: `calculada` es lo que daba el promedio de los parciales */
  ajustada?: { calculada: number | null; nota: string }
}

/** Redondeo a un decimal como ROUND() de Excel (mitades hacia arriba), sin el ruido de los flotantes. */
export function redondear1(x: number): number {
  return Math.round(Number((x * 10).toFixed(6))) / 10
}

const enRango = (f: string | null | undefined, p: { desde: string; hasta: string }): boolean => !!f && f >= p.desde && f <= p.hasta

/** Evaluaciones que cuentan como «actividades» de un parcial cuando no se eligió ninguna: las del rango, salvo exámenes y material. */
export function actividadesAutomaticas(p: Parcial, c: Componente, evaluaciones: DatosCalculo['evaluaciones']): number[] {
  const usadas = new Set(p.componentes.filter((x) => x.id !== c.id && x.fuente === 'evaluaciones').flatMap((x) => x.evaluaciones))
  return evaluaciones.filter((e) => enRango(e.fecha, p) && e.tipo !== 'examen' && !TIPOS_MATERIAL.includes(e.tipo) && !usadas.has(e.id)).map((e) => e.id)
}

/** Fracción de asistencia (0–1) de un alumno en un rango, sobre las sesiones en que tiene registro. */
function asistenciaEn(d: DatosCalculo, alumno: number, rango: { desde: string; hasta: string }, retardoVale: number): { fraccion: number | null; asistidas: number; sesiones: number } {
  const mias = d.asistencias.filter((a) => a.alumno_id === alumno && enRango(a.fecha, rango))
  if (!mias.length) return { fraccion: null, asistidas: 0, sesiones: 0 }
  const asistidas = mias.reduce((s, a) => s + (a.estado === 'ausente' ? 0 : a.estado === 'retardo' ? retardoVale : 1), 0)
  return { fraccion: asistidas / mias.length, asistidas, sesiones: mias.length }
}

const num = (x: number): string => String(Math.round(x * 100) / 100)

function valorComponente(e: Esquema, p: Parcial, c: Componente, d: DatosCalculo, alumno: number): ValorComponente {
  const res = (valor: number | null, detalle: string, sinFuente = false): ValorComponente => ({
    componente_id: c.id, valor: valor == null ? null : Math.max(0, Math.min(10, valor)), detalle, ...(sinFuente ? { sin_fuente: true } : {})
  })
  const extra = d.capturas.find((x) => x.componente_id === c.id && x.alumno_id === alumno && x.rubro === 0)?.extra ?? 0

  // Una parte calculada puesta a mano por el docente (0 a 10) manda sobre el cálculo
  if (c.fuente === 'asistencia' || c.fuente === 'participacion' || c.fuente === 'actividades' || c.fuente === 'evaluaciones') {
    const mano = d.capturas.find((x) => x.componente_id === c.id && x.alumno_id === alumno && x.rubro === 0)
    if (mano?.valor != null) return res(Math.min(10, mano.valor + extra), `${num(mano.valor)} (a mano)${extra ? ` + ${num(extra)} extra` : ''}`)
  }

  if (c.fuente === 'asistencia') {
    const a = asistenciaEn(d, alumno, p, e.retardo_vale)
    return a.fraccion == null ? res(null, 'sin registros de asistencia') : res(a.fraccion * 10, `${num(a.asistidas)} de ${a.sesiones} sesiones`)
  }

  // ¿Esta evaluación le toca a este alumno? (las asignadas solo a algunos no cuentan para los demás)
  const conDestino = new Set((d.soloPara ?? []).map((x) => x.evaluacion_id))
  const leToca = (id: number): boolean => !conDestino.has(id) || (d.soloPara ?? []).some((x) => x.evaluacion_id === id && x.alumno_id === alumno)

  if (c.fuente === 'evaluaciones') {
    if (!c.evaluaciones.length) return res(null, 'elige las evaluaciones en el esquema')
    let obtenidos = 0
    let posibles = 0
    let faltan = 0
    for (const id of c.evaluaciones) {
      const ev = d.evaluaciones.find((x) => x.id === id)
      if (!ev || ev.puntos_totales <= 0 || !leToca(id)) continue
      const r = d.resultados.find((x) => x.evaluacion_id === id && x.alumno_id === alumno)
      // «No entregado» cuenta cero aunque tenga puntaje capturado
      if (r?.estado === 'no_entregado') posibles += ev.puntos_totales
      else if (r && r.puntaje != null) {
        obtenidos += r.puntaje
        posibles += ev.puntos_totales
      } else faltan++
    }
    if (posibles === 0) return res(null, 'sin calificar')
    const v = Math.min(10, (obtenidos / posibles) * 10 + extra)
    return res(v, `${num(obtenidos)} de ${num(posibles)} pts${extra ? ` + ${num(extra)} extra` : ''}${faltan ? ` · ${faltan} sin calificar` : ''}`)
  }

  if (c.fuente === 'actividades') {
    const ids = c.evaluaciones.length ? c.evaluaciones : actividadesAutomaticas(p, c, d.evaluaciones)
    // Solo cuentan las actividades ya revisadas (con alguna entrega o calificación capturada en el grupo)
    const entregoAlguien = (id: number): boolean =>
      d.resultados.some((r) => r.evaluacion_id === id && (r.puntaje != null || ['entregado', 'calificado', 'no_entregado'].includes(r.estado))) || d.entregas.some((x) => x.evaluacion_id === id)
    const revisadas = ids.filter((id) => entregoAlguien(id) && leToca(id))
    if (!revisadas.length) return res(null, ids.length ? 'aún sin entregas registradas' : 'sin actividades en el rango')
    const entregadas = revisadas.filter((id) => {
      const r = d.resultados.find((x) => x.evaluacion_id === id && x.alumno_id === alumno)
      if (r?.estado === 'no_entregado') return false
      return (r && (r.puntaje != null || r.estado === 'entregado' || r.estado === 'calificado')) || d.entregas.some((x) => x.evaluacion_id === id && x.alumno_id === alumno)
    }).length
    return res((entregadas / revisadas.length) * 10, `${entregadas} de ${revisadas.length} actividades`)
  }

  if (c.fuente === 'classroom_promedio' || c.fuente === 'classroom_entregas') {
    // Lo capturado a mano en el componente manda sobre Classroom (tarea entregada por otro medio, Classroom sin conectar…)
    const mano = d.capturas.find((x) => x.componente_id === c.id && x.alumno_id === alumno && x.rubro === 0)
    if (mano && (mano.valor != null || mano.entregado != null)) {
      const escala = c.escala > 0 ? c.escala : 10
      const ext = extra ? ` + ${num(extra)} extra` : ''
      if (mano.entregado === 0) return res(Math.min(10, extra), `no entregó (a mano)${ext}`)
      if (mano.valor != null) {
        const base = Math.max(0, Math.min(1, mano.valor / escala)) * 10
        return res(Math.min(10, base + extra), `${num((base / 10) * escala)} / ${num(escala)} (a mano)${ext}`)
      }
      // «Entregó: sí» sin calificación: en «trabajos entregados» vale completo; en el promedio falta la nota
      if (c.fuente === 'classroom_entregas') return res(Math.min(10, 10 + extra), `entregó (a mano)${ext}`)
      return res(null, 'entregó (a mano), falta capturar la calificación')
    }
    if (!(d.classroomConectado ?? !!d.classroom?.length)) return res(null, 'Classroom no conectado: conéctalo o captura a mano', true)
    if (d.classroomLigados && !d.classroomLigados.includes(alumno)) return res(null, 'sin ligar a Classroom: lígalo en Classroom o captura a mano', true)
    // Todas las tareas de Classroom del parcial, por fecha: lo que el docente deja se suma solo
    const enParcial = (d.classroom ?? []).filter((x) => x.fecha && enRango(x.fecha, p))
    const delParcial = enParcial.filter((x) => !x.adicional)
    // Recuperaciones entregadas sin deber nada: nota adicional que solo cuenta si sube el promedio
    const adicionales = enParcial.filter((x) => x.adicional && x.alumno_id === alumno && x.calificacion != null && x.puntos)
    const tareas = new Set(delParcial.map((x) => x.tarea))
    if (!tareas.size) return res(null, 'sin tareas de Classroom en el parcial')
    const mias = delParcial.filter((x) => x.alumno_id === alumno)
    const entrego = (x: { estado: string }): boolean => x.estado === 'entrego' || x.estado === 'tarde'
    // Ya cuenta como no entregada si venció sin entrega; al cerrar el parcial, también lo que siga
    // pendiente (tareas sin fecha límite, grupos con una tarea sin fecha) o retirado por el alumno
    const cerrado = !d.hoy || p.hasta < d.hoy
    const noEntrego = (x: { estado: string }): boolean => x.estado === 'no_entrego' || (cerrado && !entrego(x))
    const vencidas = mias.filter((x) => entrego(x) || noEntrego(x))
    if (c.fuente === 'classroom_entregas') {
      if (!vencidas.length) return res(null, `${tareas.size} tarea(s) aún sin vencer`)
      const n = vencidas.filter(entrego).length
      return res(Math.min(10, (n / vencidas.length) * 10 + extra), `entregó ${n} de ${vencidas.length}${extra ? ` + ${num(extra)} extra` : ''}`)
    }
    // Promedio: no entregada = 0; entregada y calificada = calificación sobre sus puntos; entregada sin calificar = pendiente
    const notas: number[] = []
    let sinCalificar = 0
    for (const x of vencidas) {
      if (!entrego(x)) notas.push(0)
      else if (x.calificacion != null && x.puntos) notas.push(Math.max(0, Math.min(1, x.calificacion / x.puntos)))
      else sinCalificar++
    }
    if (!notas.length) return res(null, sinCalificar ? `${sinCalificar} entregada(s) sin calificar en Classroom` : `${tareas.size} tarea(s) aún sin vencer`)
    const base = notas.length
    for (const x of adicionales.map((a) => Math.max(0, Math.min(1, a.calificacion! / a.puntos!))).sort((a, b) => b - a)) {
      if (x > notas.reduce((s, y) => s + y, 0) / notas.length) notas.push(x)
    }
    const suma = notas.length - base
    const v = Math.min(10, (notas.reduce((s, x) => s + x, 0) / notas.length) * 10 + extra)
    return res(v, `${base} de ${tareas.size} tareas${suma ? ` + ${suma === 1 ? '1 recuperación' : `${suma} recuperaciones`}` : ''}${sinCalificar ? ` · ${sinCalificar} sin calificar` : ''}${extra ? ` + ${num(extra)} extra` : ''}`)
  }

  if (c.fuente === 'participacion') {
    // Si en el rango nadie tiene participaciones anotadas, todavía no se evalúa (no es un cero para todos)
    if (!d.participaciones.some((x) => enRango(x.fecha, p))) return res(null, 'sin participaciones anotadas')
    const n = d.participaciones.filter((x) => x.alumno_id === alumno && enRango(x.fecha, p)).length
    const meta = c.meta > 0 ? c.meta : 1
    return res(Math.min(1, n / meta) * 10, `${n} de ${num(meta)}`)
  }

  // Captura manual: cada rubro sobre la escala; «no entregó» cuenta cero; lo no capturado queda pendiente
  const rubros = Math.max(1, c.rubros.length)
  const escala = c.escala > 0 ? c.escala : 10
  const valores: number[] = []
  for (let i = 0; i < rubros; i++) {
    const x = d.capturas.find((k) => k.componente_id === c.id && k.alumno_id === alumno && k.rubro === i)
    if (x?.entregado === 0) valores.push(0)
    else if (x?.valor != null) valores.push(Math.max(0, Math.min(1, x.valor / escala)))
  }
  if (!valores.length) return res(null, 'sin capturar')
  const base = (valores.reduce((s, x) => s + x, 0) / valores.length) * 10
  const ext = extra ? ` + ${num(extra)} extra` : ''
  return res(Math.min(10, base + extra), rubros > 1 ? `${valores.length} de ${rubros} capturadas${ext}` : `${num((base / 10) * escala)} / ${num(escala)}${ext}`)
}

function estadoDe(e: Esquema, calif: number | null, total100: number | null, na: boolean): EstadoCalif {
  if (na) return 'na_inasistencia'
  if (calif == null) return 'pendiente'
  const aprueba = e.escala_100 && total100 != null ? total100 >= e.minima * 10 - 1e-9 : calif >= e.minima - 1e-9
  return aprueba ? 'aprobado' : 'reprobado'
}

/**
 * Regla de asistencia mínima del esquema (es de calificación, no del comunicado de faltas): un parcial
 * terminado queda NA si cerró debajo del mínimo; uno en curso, solo si con las sesiones que le quedan
 * ya es imposible llegar. Un parcial que no ha empezado nunca.
 */
function naPorInasistencias(e: Esquema, p: Parcial, d: DatosCalculo, a: { asistidas: number; sesiones: number; fraccion: number | null }): boolean {
  if (e.asistencia_minima == null || a.fraccion == null) return false
  const min = e.asistencia_minima / 100
  if (!d.hoy || p.hasta < d.hoy) return a.fraccion < min - 1e-9
  if (p.desde > d.hoy) return false
  const total = (d.sesiones ?? []).filter((s) => enRango(s.fecha, p)).length
  if (total <= 0) return false
  const restantes = Math.max(0, total - a.sesiones)
  return (a.asistidas + restantes) / total < min - 1e-9
}

export function calcularParcial(e: Esquema, p: Parcial, d: DatosCalculo, alumno: number): ResultadoParcial {
  const r = calcularParcialSinAjuste(e, p, d, alumno)
  const a = d.ajustes?.find((x) => x.parcial_id === p.id && x.alumno_id === alumno)
  if (!a) return r
  // Lo que el docente decidió manda: calificación, estado contra la mínima y ya no es provisional
  const calificacion = redondear1(a.calificacion)
  return { ...r, calificacion, total100: calificacion * 10, estado: estadoDe(e, calificacion, calificacion * 10, false), provisional: false, ajustada: { calculada: r.calificacion, nota: a.nota } }
}

function calcularParcialSinAjuste(e: Esquema, p: Parcial, d: DatosCalculo, alumno: number): ResultadoParcial {
  const componentes = p.componentes.map((c) => valorComponente(e, p, c, d, alumno))
  const pesoTotal = p.componentes.reduce((s, c) => s + c.peso, 0)
  let pesoEvaluado = 0
  let suma = 0
  p.componentes.forEach((c, i) => {
    const v = componentes[i].valor
    if (v == null || c.peso <= 0) return
    pesoEvaluado += c.peso
    suma += c.peso * v
  })
  const a = asistenciaEn(d, alumno, p, e.retardo_vale)
  const asistencia = a.fraccion == null ? null : a.fraccion * 100
  const na = naPorInasistencias(e, p, d, a)
  const sinFuente = componentes.some((v, i) => v.sin_fuente && p.componentes[i].peso > 0)
  if (pesoEvaluado <= 0) return { parcial_id: p.id, componentes, calificacion: null, total100: null, evaluado: 0, asistencia, estado: estadoDe(e, null, null, na), provisional: true }
  const crudo100 = (suma / pesoEvaluado) * 10 // los pesos de lo evaluado se reparten a 100
  let total100: number
  let calificacion: number
  if (e.escala_100) {
    total100 = redondear1(crudo100)
    calificacion = redondear1(total100 / 10)
  } else {
    calificacion = redondear1(crudo100 / 10)
    total100 = calificacion * 10
  }
  const evaluado = pesoTotal > 0 ? Math.round((pesoEvaluado / pesoTotal) * 1000) / 10 : 0
  // Con menos de la mitad evaluada la calificación se muestra, pero aún no se dice si aprueba
  return {
    parcial_id: p.id,
    componentes,
    calificacion,
    total100,
    evaluado,
    asistencia,
    // Si a un componente le falta de dónde leer (Classroom), tampoco: la calificación cambiaría mucho al llegar
    estado: na ? 'na_inasistencia' : evaluado < MITAD || sinFuente ? 'pendiente' : estadoDe(e, calificacion, total100, false),
    provisional: pesoEvaluado < pesoTotal - 1e-9
  }
}

const MITAD = 50

/** Todos los parciales y la final de un alumno. La final promedia las calificaciones de los parciales con su peso. */
export function calcularAlumno(e: Esquema, d: DatosCalculo, alumno: number): ResultadoAlumno {
  const parciales = e.parciales.map((p) => calcularParcial(e, p, d, alumno))
  let peso = 0
  let suma = 0
  // En la final solo entran los parciales con al menos la mitad evaluada (uno recién empezado no la mueve)
  e.parciales.forEach((p, i) => {
    const c = parciales[i].calificacion
    if (c == null || parciales[i].evaluado < MITAD) return
    peso += p.peso
    suma += p.peso * c
  })
  const final = peso > 0 ? redondear1(suma / peso) : null
  const rango = e.parciales.length ? { desde: e.parciales.reduce((m, p) => (p.desde < m ? p.desde : m), e.parciales[0].desde), hasta: e.parciales.reduce((m, p) => (p.hasta > m ? p.hasta : m), e.parciales[0].hasta) } : null
  const a = rango ? asistenciaEn(d, alumno, rango, e.retardo_vale) : null
  const asistencia = a?.fraccion == null ? null : a.fraccion * 100
  const provisional = parciales.some((p) => p.calificacion == null || p.provisional)
  // La final se juzga por calificación; un parcial NA se ve en su columna (cómo pesa en la final lo decide el maestro)
  const pesoTotal = e.parciales.reduce((s, p) => s + p.peso, 0)
  const conDatos = e.parciales.reduce((s, p, i) => s + (parciales[i].calificacion == null ? 0 : (p.peso * parciales[i].evaluado) / 100), 0)
  const estado = pesoTotal > 0 && (conDatos / pesoTotal) * 100 < MITAD ? 'pendiente' : estadoDe(e, final, final == null ? null : final * 10, false)
  const aj = d.ajustesFinal?.find((x) => x.alumno_id === alumno)
  if (aj) {
    const f = redondear1(aj.calificacion)
    return { alumno_id: alumno, parciales, final: f, estado: estadoDe(e, f, f * 10, false), provisional: false, asistencia, ajustada: { calculada: final, nota: aj.nota } }
  }
  return { alumno_id: alumno, parciales, final, estado, provisional, asistencia }
}

/** Revisa que cada parcial tenga nombre, fechas en orden y pesos que sumen 100 %. Devuelve los problemas. */
export function validarEsquema(e: Esquema): string[] {
  const problemas: string[] = []
  if (!(e.minima > 0 && e.minima <= 10)) problemas.push('La calificación mínima aprobatoria debe estar entre 0 y 10.')
  if (e.asistencia_minima != null && !(e.asistencia_minima >= 0 && e.asistencia_minima <= 100)) problemas.push('La asistencia mínima debe estar entre 0 y 100 %.')
  if (!e.parciales.length) problemas.push('Agrega al menos un parcial.')
  for (const p of e.parciales) {
    const n = p.nombre.trim() || 'Un parcial'
    if (!p.nombre.trim()) problemas.push('Hay un parcial sin nombre.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.desde) || !/^\d{4}-\d{2}-\d{2}$/.test(p.hasta)) problemas.push(`${n}: faltan las fechas.`)
    else if (p.desde > p.hasta) problemas.push(`${n}: la fecha de inicio es posterior a la de fin.`)
    const suma = p.componentes.reduce((s, c) => s + (Number(c.peso) || 0), 0)
    if (Math.abs(suma - 100) > 0.001) problemas.push(`${n}: los pesos suman ${Math.round(suma * 100) / 100} %, deben sumar 100 %.`)
    if (p.componentes.some((c) => !c.nombre.trim())) problemas.push(`${n}: hay un componente sin nombre.`)
    if (p.componentes.some((c) => c.fuente === 'evaluaciones' && !c.evaluaciones.length)) problemas.push(`${n}: elige qué evaluaciones cuentan en ${p.componentes.find((c) => c.fuente === 'evaluaciones' && !c.evaluaciones.length)!.nombre}.`)
    if (p.componentes.some((c) => c.fuente === 'manual' && !(c.escala > 0))) problemas.push(`${n}: la escala de captura debe ser mayor que cero.`)
  }
  return problemas
}
