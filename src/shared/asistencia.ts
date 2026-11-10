/**
 * Reglas de asistencia del comunicado de asistencia de la escuela (vigente desde agosto de 2026).
 * Las faltas se cuentan por hora de clase, no por sesión, y el límite es el 20 % de las horas del periodo.
 * Las tablas vienen tal cual del comunicado porque su redondeo no es uniforme entre modalidades.
 */
export type Modalidad = 'semestral16' | 'cuatrimestral14' | 'sabatino14'

export interface LimiteFaltas {
  horas_totales: number
  debe_asistir: number
  limite: number
  extraordinario: number
  titulo_suficiencia: number
  recursa: number
}

const TABLAS: Record<Modalidad, Record<number, LimiteFaltas>> = {
  // Semestre de 16 semanas (plan A)
  semestral16: {
    2: { horas_totales: 32, debe_asistir: 25, limite: 7, extraordinario: 8, titulo_suficiencia: 9, recursa: 10 },
    3: { horas_totales: 48, debe_asistir: 38, limite: 10, extraordinario: 11, titulo_suficiencia: 12, recursa: 13 },
    4: { horas_totales: 64, debe_asistir: 51, limite: 13, extraordinario: 14, titulo_suficiencia: 15, recursa: 16 },
    5: { horas_totales: 80, debe_asistir: 64, limite: 16, extraordinario: 17, titulo_suficiencia: 18, recursa: 19 }
  },
  // Cuatrimestre de 14 semanas
  cuatrimestral14: {
    2: { horas_totales: 28, debe_asistir: 23, limite: 5, extraordinario: 6, titulo_suficiencia: 7, recursa: 8 },
    3: { horas_totales: 42, debe_asistir: 34, limite: 8, extraordinario: 9, titulo_suficiencia: 10, recursa: 11 },
    4: { horas_totales: 56, debe_asistir: 45, limite: 11, extraordinario: 12, titulo_suficiencia: 13, recursa: 14 },
    5: { horas_totales: 70, debe_asistir: 56, limite: 14, extraordinario: 15, titulo_suficiencia: 16, recursa: 17 }
  },
  // Modalidad mixta sabatina de 14 semanas
  sabatino14: {
    1: { horas_totales: 14, debe_asistir: 11, limite: 3, extraordinario: 4, titulo_suficiencia: 5, recursa: 6 }
  }
}

/** Modalidad a partir de las semanas del periodo y de si la clase es en sábado. */
export function modalidadDe(semanas: number, soloSabado: boolean): Modalidad {
  if (soloSabado) return 'sabatino14'
  return semanas >= 16 ? 'semestral16' : 'cuatrimestral14'
}

/**
 * Límites para una materia. Si las horas por semana no están en la tabla, se
 * calcula con la misma regla del 20 % que sigue el comunicado.
 */
export function limitesDe(modalidad: Modalidad, horasSemana: number, semanas: number): LimiteFaltas {
  const tabla = TABLAS[modalidad]
  const exacta = tabla[Math.round(horasSemana)]
  if (exacta && Math.abs(Math.round(horasSemana) - horasSemana) < 0.01) return exacta
  const horas_totales = Math.round(horasSemana * semanas)
  const debe_asistir = Math.floor(horas_totales * 0.8)
  const limite = horas_totales - debe_asistir
  return { horas_totales, debe_asistir, limite, extraordinario: limite + 1, titulo_suficiencia: limite + 2, recursa: limite + 3 }
}

export type Riesgo = 'ok' | 'atencion' | 'extraordinario' | 'titulo' | 'recursa'

/** Situación del alumno según las horas de falta acumuladas. */
export function riesgoDe(horasFalta: number, l: LimiteFaltas): Riesgo {
  if (horasFalta >= l.recursa) return 'recursa'
  if (horasFalta >= l.titulo_suficiencia) return 'titulo'
  if (horasFalta >= l.extraordinario) return 'extraordinario'
  if (horasFalta >= l.limite) return 'atencion'
  return 'ok'
}

export const ETIQUETA_RIESGO: Record<Riesgo, string> = {
  ok: 'En regla',
  atencion: 'En el límite',
  extraordinario: 'Extraordinario',
  titulo: 'Título de suficiencia',
  recursa: 'Recursa'
}
