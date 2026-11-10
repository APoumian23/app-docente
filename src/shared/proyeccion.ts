/**
 * Proyección de cada alumno con el esquema de su materia: cuánto lleva, qué falta, qué necesita en lo
 * que falta para aprobar y cómo va de asistencia. Es determinista (sin IA) y la usan la pestaña
 * Calificaciones, el detalle del alumno, el Excel y el resumen que se le puede pasar a la IA.
 */
import { riesgoDe, ETIQUETA_RIESGO, type LimiteFaltas, type Riesgo } from './asistencia'
import { ETIQUETA_ESTADO_CALIF, type DatosCalculo, type EstadoCalif, type Esquema, type ResultadoAlumno } from './esquema'

export type Clasificacion = 'va_aprobando' | 'en_riesgo' | 'reprobaria' | 'na_inasistencias' | 'sin_datos'

export const ETIQUETA_CLASIFICACION: Record<Clasificacion, string> = {
  va_aprobando: 'Va aprobando',
  en_riesgo: 'En riesgo',
  reprobaria: 'Reprobaría con el ritmo actual',
  na_inasistencias: 'NA por inasistencias',
  sin_datos: 'Sin datos todavía'
}

export const SUPUESTOS_PROYECCION = [
  'La calificación «al ritmo actual» supone que lo que falta se califica igual que lo ya evaluado (por eso los pesos de lo evaluado se reparten a 100 %).',
  'La «acumulada» cuenta solo lo ya evaluado, como si lo que falta valiera cero; es el piso de la calificación final.',
  'Lo que necesita es el promedio, sobre 10, que debe sacar en todo lo que falta (todos los componentes y parciales pendientes, con sus pesos) para llegar a la mínima aprobatoria; no considera el redondeo a un decimal.',
  'La final es el promedio de los parciales con su peso. Un componente sin datos queda pendiente, no en cero.',
  'Situación por faltas (oficial, comunicado COM-AS-01): horas de falta acumuladas en todo el curso contra el límite del 20 %: En regla, En el límite, Extraordinario, Título de suficiencia, Recursa. Los justificados no cuentan. «Alerta» = ya lleva faltas y le queda 1 h (o una sesión) o menos para el siguiente escalón; con 0 faltas nunca hay alerta.',
  'La asistencia mínima del esquema (p. ej. 80 % por parcial) es solo de calificación: el parcial queda «NA por inasistencias» si ya terminó debajo del mínimo, o si con las sesiones que le quedan ya es imposible llegar.',
  'Margen de riesgo: va «en riesgo» si al ritmo actual queda a menos de 1 punto de la mínima, si necesita más de 8 en lo que falta, si tiene aviso por faltas, o si una falta más en el parcial en curso lo dejaría NA.'
]

export type Situacion = 'ya_aprobado' | 'alcanzable' | 'imposible' | 'sin_pendientes' | 'sin_datos'

export interface ProyeccionAlumno {
  alumno_id: number
  clasificacion: Clasificacion
  motivos: string[]
  /** Puntos (0–10) ya ganados en la final contando solo lo evaluado. */
  acumulada: number
  /** Final si lo que falta sale como lo evaluado (la provisional del esquema). */
  al_ritmo_actual: number | null
  /** % del total del curso (parciales × componentes) que ya tiene datos. */
  evaluado_pct: number
  situacion: Situacion
  /** Promedio sobre 10 que necesita en lo que falta; null si no aplica. */
  necesita: number | null
  faltan: { parcial: string; componente: string; peso_final: number }[]
  asistencia: AsistenciaProyectada
}

export interface AsistenciaProyectada {
  /** Sesiones con falta en todo el curso (los justificados no cuentan). */
  faltas: number
  /** Regla de calificación del esquema en el parcial en curso (null si no hay regla o no hay parcial en curso). */
  pct_parcial_actual: number | null
  minimo: number | null
  parcial_actual: string | null
  /** Faltas que aún puede tener en el parcial en curso sin quedar NA (negativo: ya no le alcanza). */
  faltas_permitidas_parcial: number | null
  faltas_parcial_actual: number
  sesiones_restantes_parcial: number | null
  /** Situación oficial (COM-AS-01): horas de falta en todo el curso. */
  horas_falta: number
  horas_sesion: number
  limites: LimiteFaltas
  riesgo: Riesgo
  /** Siguiente escalón y cuántas horas le faltan para llegar a él (null si ya recursa). */
  siguiente: { riesgo: Riesgo; umbral: number; horas: number } | null
}

export interface ContextoProyeccion {
  hoy: string // YYYY-MM-DD en Ciudad de México
  sesiones: { fecha: string; horas: number }[] // sesiones no canceladas de la materia
  limites: LimiteFaltas
  horas_falta: number
}

const r1 = (x: number): number => Math.round(x * 10) / 10

/**
 * Asistencia del alumno: situación oficial por horas (COM-AS-01, todo el curso) y, si el esquema tiene
 * asistencia mínima, cómo va en el parcial en curso. Sirve sin esquema (solo horas).
 */
export function asistenciaProyectada(e: Esquema | null, alumnoId: number, d: Pick<DatosCalculo, 'asistencias'>, ctx: ContextoProyeccion): AsistenciaProyectada {
  // Solo el parcial en curso: uno que aún no empieza no cuenta
  const actual = (e?.parciales ?? []).find((p) => p.desde <= ctx.hoy && ctx.hoy <= p.hasta) ?? null
  const retardo = e?.retardo_vale ?? 1
  let permitidas: number | null = null
  let restantesParcial: number | null = null
  let faltasParcial = 0
  let pct: number | null = null
  if (actual) {
    const enParcial = (f: string): boolean => f >= actual.desde && f <= actual.hasta
    const total = ctx.sesiones.filter((s) => enParcial(s.fecha)).length
    const mias = d.asistencias.filter((a) => a.alumno_id === alumnoId && enParcial(a.fecha))
    const asistidas = mias.reduce((s, a) => s + (a.estado === 'ausente' ? 0 : a.estado === 'retardo' ? retardo : 1), 0)
    if (mias.length) pct = r1((asistidas / mias.length) * 100)
    restantesParcial = Math.max(0, total - mias.length)
    faltasParcial = mias.filter((a) => a.estado === 'ausente').length
    if (e?.asistencia_minima != null && total > 0) permitidas = Math.floor(asistidas + restantesParcial - (e.asistencia_minima / 100) * total + 1e-9)
  }
  const horasSesion = ctx.sesiones.length ? ctx.sesiones.reduce((s, x) => s + x.horas, 0) / ctx.sesiones.length : 1
  const l = ctx.limites
  const h = ctx.horas_falta
  const escalones: [Riesgo, number][] = [['atencion', l.limite], ['extraordinario', l.extraordinario], ['titulo', l.titulo_suficiencia], ['recursa', l.recursa]]
  const sig = escalones.find(([, umbral]) => h < umbral - 1e-9)
  return {
    faltas: d.asistencias.filter((a) => a.alumno_id === alumnoId && a.estado === 'ausente').length,
    pct_parcial_actual: e?.asistencia_minima != null ? pct : null,
    minimo: e?.asistencia_minima ?? null,
    parcial_actual: actual?.nombre ?? null,
    faltas_permitidas_parcial: permitidas,
    faltas_parcial_actual: faltasParcial,
    sesiones_restantes_parcial: restantesParcial,
    horas_falta: h,
    horas_sesion: r1(horasSesion),
    limites: l,
    riesgo: riesgoDe(h, l),
    siguiente: sig ? { riesgo: sig[0], umbral: sig[1], horas: r1(sig[1] - h) } : null
  }
}

/** Nivel del aviso por faltas: la situación del comunicado, o «alerta» si aún está en regla pero cerca del límite. */
export type NivelFaltas = 'alerta' | Exclude<Riesgo, 'ok'>

export const ETIQUETA_NIVEL_FALTAS: Record<NivelFaltas, string> = { alerta: 'Alerta', ...(Object.fromEntries(Object.entries(ETIQUETA_RIESGO).filter(([k]) => k !== 'ok')) as Record<Exclude<Riesgo, 'ok'>, string>) }

const A_QUE: Record<Riesgo, string> = { ok: '', atencion: 'llega al límite', extraordinario: 'va a extraordinario', titulo: 'va a título de suficiencia', recursa: 'recursa' }

/**
 * Aviso por faltas según el comunicado COM-AS-01 (horas en todo el curso). Fuera de «En regla» siempre hay aviso;
 * «Alerta» si ya lleva faltas y le queda 1 h (o una sesión, si son más largas) o menos para el límite.
 * Con 0 faltas nunca hay aviso. La asistencia mínima del esquema no entra aquí: es de calificación.
 */
export function alertaFaltas(a: AsistenciaProyectada): { nivel: NivelFaltas | null; texto: string } {
  const h = a.horas_falta
  const s = a.siguiente
  const sesiones = (horas: number): string => {
    const n = Math.max(1, Math.ceil(horas / (a.horas_sesion || 1) - 1e-9))
    return a.horas_sesion === 1 ? '' : ` (${n} ${n === 1 ? 'sesión' : 'sesiones'})`
  }
  const despues = s ? `con ${s.horas} h más${sesiones(s.horas)} ${A_QUE[s.riesgo]}${s.riesgo === 'atencion' ? ` (${s.umbral} h)` : ''}` : ''
  if (a.riesgo === 'recursa') return { nivel: 'recursa', texto: `Recursa: lleva ${h} h de falta (desde ${a.limites.recursa} h).` }
  if (a.riesgo === 'atencion') return { nivel: 'atencion', texto: `En el límite: lleva ${h} h de falta; ${despues}.` }
  if (a.riesgo !== 'ok') return { nivel: a.riesgo, texto: `Ya está en ${ETIQUETA_RIESGO[a.riesgo].toLowerCase()} (${h} h de falta); ${despues}.` }
  if (h > 0 && s && s.horas <= Math.max(1, a.horas_sesion) + 1e-9) return { nivel: 'alerta', texto: `Lleva ${h} h de falta; ${despues}.` }
  return { nivel: null, texto: h > 0 ? `Lleva ${h} h de falta; ${despues}.` : 'Sin faltas.' }
}

export function proyectarAlumno(e: Esquema, r: ResultadoAlumno, d: DatosCalculo, ctx: ContextoProyeccion): ProyeccionAlumno {
  const pesoParciales = e.parciales.reduce((s, p) => s + (p.peso > 0 ? p.peso : 0), 0) || 1
  let ganado = 0
  let pendiente = 0
  let evaluado = 0
  let evaluadoSinAsistencia = 0
  const faltan: ProyeccionAlumno['faltan'] = []
  e.parciales.forEach((p, i) => {
    const wp = (p.peso > 0 ? p.peso : 0) / pesoParciales
    const sumaC = p.componentes.reduce((s, c) => s + c.peso, 0) || 1
    p.componentes.forEach((c, j) => {
      const w = wp * (c.peso / sumaC)
      const v = r.parciales[i]?.componentes[j]?.valor
      if (v == null) {
        pendiente += w
        faltan.push({ parcial: p.nombre, componente: c.nombre, peso_final: r1(w * 100) })
      } else {
        ganado += w * v
        evaluado += w
        if (c.fuente !== 'asistencia') evaluadoSinAsistencia += w
      }
    })
  })

  const asistencia = asistenciaProyectada(e, r.alumno_id, d, ctx)
  const actual = e.parciales.find((p) => p.nombre === asistencia.parcial_actual) ?? null
  const permitidas = asistencia.faltas_permitidas_parcial

  const acumulada = r1(ganado)
  const total = evaluado + pendiente
  const evaluado_pct = total > 0 ? r1((evaluado / total) * 100) : 0
  let situacion: Situacion
  let necesita: number | null = null
  // Con solo la asistencia capturada todavía no hay de dónde proyectar una calificación
  if (evaluadoSinAsistencia <= 0) situacion = 'sin_datos'
  else if (pendiente <= 1e-9) situacion = 'sin_pendientes'
  else {
    necesita = (e.minima - ganado) / pendiente
    situacion = necesita <= 0 ? 'ya_aprobado' : necesita > 10 ? 'imposible' : 'alcanzable'
    necesita = Math.max(0, Math.round(necesita * 100) / 100)
  }

  const motivos: string[] = []
  // El estado NA del parcial ya considera solo parciales terminados o imposibles de recuperar
  const naEn = r.parciales.map((p, i) => (p.estado === 'na_inasistencia' ? i : -1)).filter((i) => i >= 0)
  let clasificacion: Clasificacion
  if (naEn.length) {
    clasificacion = 'na_inasistencias'
    for (const i of naEn) motivos.push(`${e.parciales[i].nombre}: ${ETIQUETA_ESTADO_CALIF.na_inasistencia} (${r1(r.parciales[i].asistencia ?? 0)} % de asistencia, mínimo ${e.asistencia_minima} %).`)
  } else if (situacion === 'sin_datos') {
    clasificacion = 'sin_datos'
    motivos.push(evaluado > 0 ? 'Solo tiene asistencia registrada; aún no hay calificaciones para proyectar.' : 'Aún no tiene nada evaluado.')
  } else {
    const ritmo = r.final
    if (situacion === 'imposible') motivos.push(`Ya no alcanza ${e.minima} aunque saque 10 en todo lo que falta.`)
    else if (situacion === 'ya_aprobado') motivos.push(`Ya aprueba aunque saque 0 en lo que falta (lleva ${acumulada}).`)
    else if (situacion === 'alcanzable') motivos.push(`Necesita en promedio ${necesita} en lo que falta (${r1(100 - evaluado_pct)} % del curso).`)
    if (ritmo != null) motivos.push(`Al ritmo actual terminaría con ${ritmo}.`)
    const aprobaria = situacion === 'sin_pendientes' ? r.final != null && r.final >= e.minima - 1e-9 : situacion !== 'imposible' && ritmo != null && ritmo >= e.minima - 1e-9
    if (!aprobaria || situacion === 'imposible') clasificacion = 'reprobaria'
    else {
      const riesgos: string[] = []
      if (situacion !== 'ya_aprobado' && situacion !== 'sin_pendientes' && ritmo != null && ritmo < e.minima + 1) riesgos.push(`queda a menos de 1 punto de la mínima (${e.minima})`)
      if (situacion === 'alcanzable' && necesita != null && necesita > 8) riesgos.push(`necesita más de 8 en lo que falta`)
      const aviso = alertaFaltas(asistencia)
      if (aviso.nivel) riesgos.push(`faltas: ${aviso.texto.replace(/\.$/, '')}`)
      if (permitidas === 0 && asistencia.faltas_parcial_actual > 0 && (asistencia.sesiones_restantes_parcial ?? 0) > 0) riesgos.push(`una falta más en ${actual!.nombre} lo deja NA por inasistencias`)
      clasificacion = riesgos.length ? 'en_riesgo' : 'va_aprobando'
      if (riesgos.length) motivos.push(`En riesgo: ${riesgos.join('; ')}.`)
    }
  }
  return { alumno_id: r.alumno_id, clasificacion, motivos, acumulada, al_ritmo_actual: r.final, evaluado_pct, situacion, necesita, faltan, asistencia }
}

/** Resumen serializable de una materia (para la interfaz, el Excel o para pasárselo a la IA). */
export interface ResumenProyeccion {
  materia: { id: number; nombre: string; periodo: string }
  fecha_corte: string
  esquema: {
    minima: number
    asistencia_minima: number | null
    escala_100: boolean
    nota: string
    parciales: { nombre: string; desde: string; hasta: string; peso: number; componentes: { nombre: string; peso: number; fuente: string }[] }[]
  }
  supuestos: string[]
  conteo: Record<Clasificacion, number>
  alumnos: {
    alumno_id: number
    matricula: string
    nombre: string
    clasificacion: Clasificacion
    etiqueta: string
    motivos: string[]
    acumulada: number
    al_ritmo_actual: number | null
    evaluado_pct: number
    situacion: Situacion
    necesita: number | null
    faltan: ProyeccionAlumno['faltan']
    parciales: { nombre: string; calificacion: number | null; estado: EstadoCalif; provisional: boolean; asistencia: number | null; componentes: { nombre: string; peso: number; valor: number | null; detalle: string }[] }[]
    asistencia: ProyeccionAlumno['asistencia']
  }[]
}

export function resumenProyeccion(
  materia: ResumenProyeccion['materia'],
  e: Esquema,
  alumnos: { id: number; matricula: string; nombre: string; apellidos: string }[],
  resultados: ResultadoAlumno[],
  proyecciones: ProyeccionAlumno[],
  hoy: string
): ResumenProyeccion {
  const conteo: Record<Clasificacion, number> = { va_aprobando: 0, en_riesgo: 0, reprobaria: 0, na_inasistencias: 0, sin_datos: 0 }
  proyecciones.forEach((p) => conteo[p.clasificacion]++)
  return {
    materia,
    fecha_corte: hoy,
    esquema: {
      minima: e.minima,
      asistencia_minima: e.asistencia_minima,
      escala_100: e.escala_100,
      nota: e.nota,
      parciales: e.parciales.map((p) => ({ nombre: p.nombre, desde: p.desde, hasta: p.hasta, peso: p.peso, componentes: p.componentes.map((c) => ({ nombre: c.nombre, peso: c.peso, fuente: c.fuente })) }))
    },
    supuestos: SUPUESTOS_PROYECCION,
    conteo,
    alumnos: alumnos.map((a) => {
      const r = resultados.find((x) => x.alumno_id === a.id)!
      const p = proyecciones.find((x) => x.alumno_id === a.id)!
      return {
        alumno_id: a.id,
        matricula: a.matricula,
        nombre: `${a.apellidos} ${a.nombre}`.trim(),
        clasificacion: p.clasificacion,
        etiqueta: ETIQUETA_CLASIFICACION[p.clasificacion],
        motivos: p.motivos,
        acumulada: p.acumulada,
        al_ritmo_actual: p.al_ritmo_actual,
        evaluado_pct: p.evaluado_pct,
        situacion: p.situacion,
        necesita: p.necesita,
        faltan: p.faltan,
        parciales: e.parciales.map((pa, i) => ({
          nombre: pa.nombre,
          calificacion: r.parciales[i].calificacion,
          estado: r.parciales[i].estado,
          provisional: r.parciales[i].provisional,
          asistencia: r.parciales[i].asistencia == null ? null : r1(r.parciales[i].asistencia!),
          componentes: pa.componentes.map((c, j) => ({ nombre: c.nombre, peso: c.peso, valor: r.parciales[i].componentes[j].valor == null ? null : r1(r.parciales[i].componentes[j].valor!), detalle: r.parciales[i].componentes[j].detalle }))
        })),
        asistencia: p.asistencia
      }
    })
  }
}
