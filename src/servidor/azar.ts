/**
 * Preguntas al azar por alumno: del examen (por ejemplo un banco de 30) a cada alumno le tocan N de cada tipo,
 * en su propio orden y con las opciones revueltas. El sorteo se hace al empezar y se guarda en su intento
 * (intentos.seleccion): si recarga o vuelve, ve el mismo examen. Las respuestas se guardan con el índice
 * original de la pregunta, así que guardar, calificar y revisar solo necesitan «el examen como lo vio él».
 */
import { randomInt } from 'crypto'
import type { ContenidoEvaluacion, Pregunta } from '../shared/types'
import type { AzarAsignacion, PreguntaAlumno } from '../shared/portal'
import { ErrorHttp } from './auth'

export interface Seleccion {
  /** Índices originales, en el orden en que los ve el alumno */
  preguntas: number[]
  /** Orden de las opciones de cada pregunta de opción múltiple (por índice original) */
  opciones: Record<string, number[]>
}

const GRUPOS: (keyof AzarAsignacion)[] = ['opcion_multiple', 'verdadero_falso', 'abierta']
const grupoDe = (p: Pregunta): keyof AzarAsignacion => (p.tipo === 'opcion_multiple' ? 'opcion_multiple' : p.tipo === 'verdadero_falso' ? 'verdadero_falso' : 'abierta')

function barajar<T>(lista: T[]): T[] {
  const r = [...lista]
  for (let i = r.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  return r
}

export function leerAzar(t: string | null | undefined): AzarAsignacion | null {
  if (!t) return null
  try {
    const a = JSON.parse(t) as Partial<AzarAsignacion>
    const r = { opcion_multiple: Number(a.opcion_multiple) || 0, verdadero_falso: Number(a.verdadero_falso) || 0, abierta: Number(a.abierta) || 0 }
    return r.opcion_multiple + r.verdadero_falso + r.abierta > 0 ? r : null
  } catch {
    return null
  }
}

export function leerSeleccion(t: string | null | undefined): Seleccion | null {
  if (!t) return null
  try {
    const s = JSON.parse(t) as Seleccion
    return Array.isArray(s.preguntas) && s.preguntas.length ? { preguntas: s.preguntas.map(Number), opciones: s.opciones ?? {} } : null
  } catch {
    return null
  }
}

/** Cuántas hay de cada tipo en el examen */
export function disponibles(c: ContenidoEvaluacion): AzarAsignacion {
  const r: AzarAsignacion = { opcion_multiple: 0, verdadero_falso: 0, abierta: 0 }
  for (const p of c.preguntas) r[grupoDe(p)]++
  return r
}

/** La regla que pide el docente, revisada contra lo que trae el examen (null = sin azar) */
export function validarAzar(c: ContenidoEvaluacion, pedido: unknown): AzarAsignacion | null {
  if (!pedido) return null
  if (typeof pedido !== 'object') throw new ErrorHttp(400, 'Las preguntas al azar deben indicar cuántas de cada tipo.')
  const p = pedido as Record<string, unknown>
  const azar: AzarAsignacion = { opcion_multiple: 0, verdadero_falso: 0, abierta: 0 }
  for (const g of GRUPOS) {
    const n = Number(p[g] ?? 0)
    if (!Number.isInteger(n) || n < 0) throw new ErrorHttp(400, 'Las cantidades al azar deben ser números enteros.')
    azar[g] = n
  }
  if (azar.opcion_multiple + azar.verdadero_falso + azar.abierta === 0) throw new ErrorHttp(400, 'Pide al menos una pregunta al azar por alumno.')
  const hay = disponibles(c)
  const nombres: Record<keyof AzarAsignacion, string> = { opcion_multiple: 'de opción múltiple', verdadero_falso: 'de verdadero/falso', abierta: 'abiertas' }
  for (const g of GRUPOS) if (azar[g] > hay[g]) throw new ErrorHttp(400, `El examen solo tiene ${hay[g]} preguntas ${nombres[g]}; pediste ${azar[g]} por alumno.`)
  return azar
}

/** El sorteo de un alumno: N de cada tipo, todas revueltas, y las opciones de cada una en otro orden */
export function sortear(c: ContenidoEvaluacion, azar: AzarAsignacion): Seleccion {
  const elegidas: number[] = []
  for (const g of GRUPOS) {
    const pos = c.preguntas.flatMap((p, i) => (grupoDe(p) === g ? [i] : []))
    elegidas.push(...barajar(pos).slice(0, azar[g]))
  }
  const opciones: Record<string, number[]> = {}
  for (const i of elegidas) {
    const p = c.preguntas[i]
    if (p.tipo === 'opcion_multiple' && (p.opciones?.length ?? 0) > 1) opciones[String(i)] = barajar(p.opciones!.map((_, k) => k))
  }
  return { preguntas: barajar(elegidas), opciones }
}

const conOpciones = (p: Pregunta, orden?: number[]): Pregunta => (orden && p.opciones ? { ...p, opciones: orden.map((k) => p.opciones![k]).filter((o) => o !== undefined) } : p)

/**
 * El examen como lo vio el alumno: sus preguntas en su orden (con sus opciones) y sus respuestas con el número
 * de esa posición. La clave de opción múltiple es el texto de la opción, así que revolverlas no cambia la calificación.
 */
export function delIntento(c: ContenidoEvaluacion, sel: Seleccion | null, respuestas: Record<string, string>): { contenido: ContenidoEvaluacion; respuestas: Record<string, string>; originales: number[] } {
  if (!sel) return { contenido: c, respuestas, originales: c.preguntas.map((_, i) => i) }
  const validas = sel.preguntas.filter((i) => c.preguntas[i])
  return {
    contenido: { ...c, preguntas: validas.map((i) => conOpciones(c.preguntas[i], sel.opciones[String(i)])) },
    respuestas: Object.fromEntries(validas.map((orig, pos) => [String(pos), respuestas[String(orig)] ?? ''])),
    originales: validas
  }
}

/** Las preguntas que ve el alumno (todas en orden si no hay sorteo), numeradas como las ve */
export function preguntasDelAlumno(todas: PreguntaAlumno[], sel: Seleccion | null): PreguntaAlumno[] {
  if (!sel) return todas.map((p) => ({ ...p, numero: p.indice + 1 }))
  return sel.preguntas
    .map((i) => todas.find((p) => p.indice === i))
    .filter((p): p is PreguntaAlumno => Boolean(p))
    .map((p, pos) => {
      const orden = sel.opciones[String(p.indice)]
      return { ...p, numero: pos + 1, opciones: orden && p.tipo === 'opcion_multiple' ? orden.map((k) => p.opciones[k]).filter((o) => o !== undefined) : p.opciones }
    })
}

/** Cuánto vale el examen para cada alumno con el sorteo (el promedio de puntos de cada tipo por cuántas le tocan) */
export function puntosPorAlumno(c: ContenidoEvaluacion, azar: AzarAsignacion): number {
  let total = 0
  for (const g of GRUPOS) {
    const ps = c.preguntas.filter((p) => grupoDe(p) === g)
    if (ps.length && azar[g]) total += (ps.reduce((s, p) => s + (p.puntos || 0), 0) / ps.length) * azar[g]
  }
  return Math.round(total * 100) / 100
}
