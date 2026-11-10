import type { Alumno, Evaluacion, Resultado } from './types'
import type { LimiteFaltas, Modalidad, Riesgo } from './asistencia'

/** Fila del concentrado de calificaciones y asistencia de un alumno en una materia. */
export interface FilaCalificacion {
  alumno: Alumno
  horas_falta: number
  riesgo: Riesgo
  sesiones_con_registro: number
  porcentaje_asistencia: number | null
  puntos_obtenidos: number
  puntos_evaluados: number
  promedio_parcial: number | null
  proyeccion: number | null
  pendientes: number
}

export interface DetalleAlumno {
  alumno: Alumno & { carrera_nombre: string | null }
  materias: { materia: { id: number; nombre: string; clave: string; color: string; oculta: number }; limites: LimiteFaltas; evaluaciones: number; fila: FilaCalificacion }[]
  asistencias: { sesion_id: number; materia_id: number; estado: string; hora: string; nota: string; fecha: string; hora_inicio: string; hora_fin: string; tema: string; materia_nombre: string; materia_color: string }[]
  resultados: (Resultado & { titulo: string; tipo: string; puntos_totales: number; fecha_aplicacion: string | null; materia_nombre: string })[]
  entregas: { id: number; estado: string; iniciado_en: string | null; enviado_en: string | null; tiempo_activo_seg: number; puntaje: number | null; puntaje_auto: number | null; pendiente_manual: number; titulo: string; asignacion_id: number; puntos_totales: number; materia_nombre: string; eventos: number }[]
  /** Sus tareas de Classroom (agrupadas como en Alumnos × tareas), con lo que subió al portal */
  tareas: {
    materia_id: number
    materia_nombre: string
    tarea: string
    vence: string | null
    estado: 'entrego' | 'tarde' | 'no_entrego' | 'pendiente' | 'retirada' | 'no_asignada'
    calificacion: number | null
    borrador: number | null
    puntos: number | null
    entregada: string | null
    veces: number
    de_portal: boolean
    recuperacion: boolean
  }[]
  acceso: { usuario: string; debe_cambiar: number; ultimo_acceso: string | null } | null
}

export interface Concentrado {
  materia: { id: number; nombre: string; periodo: string }
  horas_semana: number
  modalidad: Modalidad
  limites: LimiteFaltas
  puntos_totales: number
  evaluaciones: Evaluacion[]
  filas: FilaCalificacion[]
}
