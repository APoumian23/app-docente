import type { ContenidoEvaluacion, Pregunta } from '../shared/types'
import { esLenguaje, lenguajeDeTexto, type Lenguaje } from '../codigo/lenguajes'
import type { PreguntaAlumno } from '../shared/portal'

const normalizar = (t: string): string =>
  (t ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Se conservan letras de cualquier alfabeto (Ω, Θ) y símbolos (√, ≤): O(n) y Ω(n) no son la misma respuesta
    .replace(/[^\p{L}\p{N}\p{S}$]+/gu, ' ')
    .trim()

export function leerContenido(contenido: string): ContenidoEvaluacion | null {
  if (!contenido.trim().startsWith('{')) return null
  try {
    const c = JSON.parse(contenido) as ContenidoEvaluacion
    return Array.isArray(c.preguntas) ? c : null
  } catch {
    return null
  }
}

/** Versión de las preguntas que puede ver el alumno: sin respuesta ni explicación. */
export function preguntasParaAlumno(c: ContenidoEvaluacion): PreguntaAlumno[] {
  return c.preguntas.map((p, indice) => ({
    indice,
    tipo: p.tipo,
    enunciado: p.enunciado,
    opciones: p.tipo === 'verdadero_falso' ? ['Verdadero', 'Falso'] : p.opciones ?? [],
    puntos: p.puntos,
    ...(p.tipo === 'codigo' ? { lenguaje: lenguajeDePregunta(p) } : {}),
    ...(p.tipo === 'cuaderno' ? { cuaderno: p.cuaderno ?? '', paquetes: Boolean(p.paquetes) } : {})
  }))
}

/**
 * Lenguaje de una pregunta de código, decidido una sola vez con el enunciado y la respuesta esperada
 * (nunca con lo que escribió el alumno): el alumno y el docente lo corren igual.
 */
export const lenguajeDePregunta = (p: { enunciado: string; respuesta?: string; lenguaje?: string }): Lenguaje =>
  esLenguaje(p.lenguaje) ? p.lenguaje : lenguajeDeTexto(p.enunciado, p.respuesta)

/**
 * Texto de una opción para compararla tal cual: sin espacios de más ni delimitadores de LaTeX.
 * Respeta mayúsculas y letras griegas: en Algoritmos O(n) y o(n), o Θ y θ, son respuestas distintas.
 */
const exacto = (t: string): string =>
  (t ?? '')
    .normalize('NFC')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const sinLetra = (t: string): string => t.replace(/^\(?[a-hA-H][).:]\s+/, '')

/** Índice de la única opción que cumple la condición; -1 si ninguna o si hay más de una. */
function unica(opciones: string[], cumple: (o: string) => boolean): number {
  const idx = opciones.flatMap((o, i) => (cumple(o) ? [i] : []))
  return idx.length === 1 ? idx[0] : -1
}

/** Qué opción señala un texto: igual a una opción, solo su letra ("b", "b)") o igual sin importar mayúsculas si no hay otra parecida. */
export function indiceDeOpcion(opciones: string[], texto: string): number {
  const t = exacto(texto)
  if (!t) return -1
  const ops = opciones.map(exacto)
  const directa = unica(ops, (o) => o === t)
  if (directa >= 0) return directa
  const conLetra = unica(ops, (o) => sinLetra(o) === sinLetra(t))
  if (conLetra >= 0) return conLetra
  const letra = /^(?:opci[oó]n\s+)?\(?([a-hA-H])\)?[.):]?$/.exec(t)?.[1]
  if (letra) {
    const i = letra.toLowerCase().charCodeAt(0) - 97
    return i < ops.length ? i : -1
  }
  return unica(ops, (o) => normalizar(sinLetra(o)) === normalizar(sinLetra(t)))
}

/**
 * Índice de la opción correcta, o -1 si la clave no señala una sola opción sin ambigüedad.
 * Antes se aceptaba por subcadena y en minúsculas: con clave «O(n^2)» contaba «O(n)», y «o(g(n))» = «O(g(n))».
 */
export function indiceCorrecto(p: Pregunta): number {
  if (p.tipo !== 'opcion_multiple') return -1
  return indiceDeOpcion(p.opciones ?? [], p.respuesta)
}

/** Decide si la respuesta del alumno es la opción correcta. */
export function coincideOpcion(p: Pregunta, respuesta: string): boolean {
  if (p.tipo === 'verdadero_falso') {
    const r = normalizar(respuesta)
    if (!r) return false
    const esV = /^v|^true|^cierto/.test(normalizar(p.respuesta))
    return esV ? /^v|^true|^cierto/.test(r) : /^f|^false/.test(r)
  }
  const correcta = indiceCorrecto(p)
  return correcta >= 0 && indiceDeOpcion(p.opciones ?? [], respuesta) === correcta
}

/** 0 = Verdadero, 1 = Falso, -1 = vacío o no se reconoce («V», «Falso», «true»…). */
export function indiceVerdaderoFalso(texto: string): number {
  const t = normalizar(texto)
  if (/^v|^true|^cierto/.test(t)) return 0
  if (/^f|^false/.test(t)) return 1
  return -1
}

/** Se califica sola si es verdadero/falso o si la clave señala exactamente una opción. */
export function esAutocalificable(p: Pregunta): boolean {
  return p.tipo === 'verdadero_falso' || (p.tipo === 'opcion_multiple' && indiceCorrecto(p) >= 0)
}

export interface ResultadoCalificacion {
  puntaje_auto: number
  puntos_auto_posibles: number
  pendiente_manual: boolean
  detalle: { indice: number; automatica: boolean; correcta: boolean | null; puntos: number }[]
}

/** Califica lo que se puede automáticamente y marca el resto como pendiente. */
export function calificarAutomatico(c: ContenidoEvaluacion, respuestas: Record<string, string>): ResultadoCalificacion {
  let puntaje = 0
  let posibles = 0
  let pendiente = false
  const detalle = c.preguntas.map((p, indice) => {
    const r = respuestas[String(indice)] ?? ''
    // Una clave ambigua no se adivina: la pregunta pasa a revisión del docente
    if (esAutocalificable(p)) {
      posibles += p.puntos
      const correcta = coincideOpcion(p, r)
      if (correcta) puntaje += p.puntos
      return { indice, automatica: true, correcta, puntos: correcta ? p.puntos : 0 }
    }
    if (r.trim()) pendiente = true
    return { indice, automatica: false, correcta: null, puntos: 0 }
  })
  return { puntaje_auto: puntaje, puntos_auto_posibles: posibles, pendiente_manual: pendiente, detalle }
}

/** Puntos de una partida: mitad por acertar, mitad por rapidez. */
export function puntosPorRapidez(correcta: boolean, ms: number, segundosPregunta: number): number {
  if (!correcta) return 0
  const fraccion = Math.max(0, 1 - ms / (segundosPregunta * 1000))
  return 500 + Math.round(500 * fraccion)
}
