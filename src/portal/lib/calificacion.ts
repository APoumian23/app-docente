/**
 * Calificación de un examen sobre 10 y lo que aporta al parcial con su ponderación (p. ej. 13 de 24 pts = 5.4;
 * con 30 %: 5.4 × 30 % = 1.62 de 3.0). La misma cuenta para el alumno y para el docente.
 */
export interface CalificacionExamen {
  sobre10: number
  /** null si la actividad no tiene ponderación */
  aporte: number | null
  /** Lo más que puede aportar (ponderación / 10) */
  maximo: number
  ponderacion: number
}

const red = (n: number, dec: number): number => Math.round(n * 10 ** dec) / 10 ** dec

export function calificacionExamen(puntaje: number | null | undefined, total: number | null | undefined, ponderacion?: number | null): CalificacionExamen | null {
  if (puntaje === null || puntaje === undefined || !Number.isFinite(puntaje) || !total || total <= 0) return null
  const sobre10 = red(Math.max(0, Math.min(10, (puntaje / total) * 10)), 1)
  const pond = ponderacion && ponderacion > 0 ? ponderacion : 0
  return { sobre10, aporte: pond ? red((sobre10 * pond) / 100, 2) : null, maximo: red(pond / 10, 2), ponderacion: pond }
}
