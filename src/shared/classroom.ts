/** Tipos de la sincronización con Google Classroom (solo lectura), compartidos entre el proceso principal y la interfaz. */

/** Estado de una entrega tal como lo ve el maestro. */
export type EstadoEntrega = 'entrego' | 'tarde' | 'no_entrego' | 'pendiente' | 'retirada' | 'no_asignada'

export const ETIQUETA_ESTADO: Record<EstadoEntrega, string> = {
  entrego: 'Entregó',
  tarde: 'Entregó tarde',
  no_entrego: 'No entregó',
  pendiente: 'Pendiente',
  retirada: 'La retiró',
  no_asignada: 'No asignada'
}

/** Cómo quedó ligado un alumno de Classroom con uno de la app. */
export type Liga = 'correo' | 'nombre' | 'manual' | 'ajeno' | 'dudoso' | 'pendiente'

export type Adjunto =
  | { tipo: 'drive'; id: string; titulo: string; enlace: string; miniatura: string }
  | { tipo: 'enlace'; url: string; titulo: string }
  | { tipo: 'youtube'; id: string; titulo: string; enlace: string }
  | { tipo: 'formulario'; titulo: string; enlace: string; respuestas: string }

export interface EstadoConexion {
  client_id: string
  /** Hay Client ID y Client Secret guardados. */
  credenciales: boolean
  conectado: boolean
  cuenta: string
  /** Se concedió el permiso de Drive (para previsualizar y descargar archivos entregados). */
  drive: boolean
  /** Se concedió el permiso para crear, editar, borrar y calificar tareas. */
  escritura: boolean
  /** Se concedió el permiso para subir a Drive los archivos que se adjuntan a las tareas. */
  subir: boolean
  ultima_sync: string | null
  cuenta_esperada: string
}

export interface CursoClassroom {
  id: string
  nombre: string
  seccion: string
  enlace: string
  materia_id: number | null
  materia_nombre: string | null
  activo: number
  sincronizado: string | null
  alumnos: number
  tareas: number
}

export interface ResultadoSync {
  cursos: number
  ligados: number
  alumnos: number
  tareas: number
  entregas: number
  sin_ligar: number
  sincronizado: string
}

export interface TotalesTarea {
  asignadas: number
  entrego: number
  tarde: number
  no_entrego: number
  pendiente: number
  retirada: number
  calificadas: number
}

export interface TareaResumen {
  /** curso_id:id, única aunque la materia tenga varios cursos ligados. */
  clave: string
  curso_id: string
  id: string
  titulo: string
  tipo: string
  puntos: number | null
  /** Fecha límite en UTC (ISO) o null si no tiene. */
  vence: string | null
  creada: string | null
  enlace: string
  /** La creó esta app: se puede editar, borrar y calificar en Classroom desde aquí */
  propia: boolean
  descripcion: string
  /** Cómo se ve en el portal de alumnos: para quién es y si acepta entregas tarde */
  portal: { visibilidad: 'todos' | 'algunos' | 'oculta'; alumnos: number[]; acepta_tarde: boolean }
  totales: TotalesTarea
}

/** Alumno de Classroom ligado a uno de la lista de la app (los demás no cuentan). */
export interface AlumnoResumen {
  /** curso_id:user_id */
  clave: string
  curso_id: string
  user_id: string
  alumno_id: number
  nombre: string
  matricula: string
  email: string
  liga: Liga
  totales: {
    asignadas: number
    /** Entregó a tiempo o tarde. */
    entregadas: number
    tarde: number
    no_entrego: number
    pendiente: number
    retirada: number
    /** Suma de calificaciones asignadas y de puntos posibles de esas tareas. */
    puntos_obtenidos: number
    puntos_posibles: number
  }
}

export interface CeldaEntrega {
  alumno: string
  tarea: string
  entrega_id: string
  estado: EstadoEntrega
  tarde: boolean
  calificacion: number | null
  borrador: number | null
  puntos: number | null
  /** Última vez que la entregó (UTC ISO). */
  entregada: string | null
  adjuntos: number
  /** La registró el docente a mano (la recibió fuera de Classroom) */
  fuera?: boolean
  /** El alumno la subió desde el portal («Subir tarea») */
  portal?: boolean
  /** La calificación la puso el docente en la app (manda sobre la de Classroom) */
  calif_app?: boolean
}

export interface AlumnoApp {
  id: number
  nombre: string
  apellidos: string
  email: string
  matricula: string
}

export interface SinLigarClassroom {
  clave: string
  curso_id: string
  user_id: string
  nombre: string
  email: string
  liga: Liga
  sugerido: AlumnoApp | null
}

// ---------- Tareas de la app (agrupan duplicados de Classroom) ----------

/** Si entregó en varias tareas agrupadas, cuál calificación cuenta. */
export type ReglaCalificacion = 'alta' | 'ultima'

/** Columna de la vista consolidada: una tarea de la app o una de Classroom que aún no se agrupa. */
export interface TareaApp {
  /** 'app:<id>' o 'cr:<curso>:<tarea>' para las sueltas. */
  clave: string
  /** id en classroom_tareas_app; null si es una tarea de Classroom suelta. */
  id: number | null
  nombre: string
  regla: ReglaCalificacion
  /** Claves (curso:id) de las tareas de Classroom que agrupa. */
  tareas: string[]
  /** La fecha límite más antigua de sus tareas (o la de creación): define cuál es «la más antigua». */
  referencia: string | null
  totales: TotalesTarea
}

export interface Comodin {
  clave: string
  curso_id: string
  tarea_id: string
  titulo: string
  /** Ids de tareas de la app que puede acreditar. Vacío = todas las anteriores a la comodín. */
  cubre: number[]
  /** Las que de verdad considera (resuelto «todas las anteriores»). */
  cubre_efectivo: number[]
}

/** Una entrega de Classroom vista desde la tarea de la app. */
export interface FuenteEntrega {
  curso_id: string
  entrega_id: string
  /** Clave curso:id de la tarea de Classroom. */
  tarea: string
  titulo: string
  estado: EstadoEntrega
  tarde: boolean
  calificacion: number | null
  borrador: number | null
  puntos: number | null
  entregada: string | null
  adjuntos: number
  /** Llegó por una tarea de recuperación comodín. */
  comodin: boolean
}

export interface CeldaApp {
  alumno: string
  tarea_app: string
  estado: EstadoEntrega
  tarde: boolean
  calificacion: number | null
  borrador: number | null
  puntos: number | null
  entregada: string | null
  /** La entrega que cuenta (null si no entregó). */
  cuenta: FuenteEntrega | null
  /** Las demás entregas de esa tarea (duplicados), para verlas plegadas. */
  otras: FuenteEntrega[]
  /** Cuántas veces la entregó (2 o más = «entregó dos veces»). */
  veces: number
  comodin: boolean
  /** La comodín se acreditó aquí por omisión, pero también podía ir a otra: falta que el maestro decida. */
  ambigua: boolean
}

export interface AmbiguaComodin {
  alumno: string
  nombre: string
  comodin: string
  titulo: string
  curso_id: string
  tarea_id: string
  user_id: string
  /** Claves 'app:<id>' a las que se puede acreditar. */
  opciones: string[]
  acreditada: string | null
}

export interface PorRevisar {
  /** Entregas que cuentan y aún no tienen calificación asignada (los duplicados no salen). */
  sin_calificar: { alumno: string; nombre: string; tarea_app: string; tarea_nombre: string; fuente: FuenteEntrega }[]
  ambiguas: AmbiguaComodin[]
  /** Tareas vencidas sin entrega, ya consolidadas (si entregó en la duplicada no aparece). */
  sin_entrega: { alumno: string; nombre: string; tarea_app: string; tarea_nombre: string }[]
}

export interface SugerenciaGrupo {
  nombre: string
  /** Si ya existe una tarea de la app con ese nombre, se agregan a ella. */
  tarea_app_id: number | null
  tareas: { clave: string; titulo: string }[]
}

export interface Consolidacion {
  tareas: TareaApp[]
  comodines: Comodin[]
  celdas: CeldaApp[]
  /** Por alumno: «Tarea 1 en «1er Tarea» · Tarea 2 en «Tarea que faltó»». */
  resolucion: Record<string, string>
  /**
   * Lo mismo, en partes, para mostrar solo lo que no fue directo: tareas que se tomaron de otra tarea de Classroom
   * (nombre distinto) o que entregó más de una vez, y las notas de recuperaciones.
   */
  resolucion_detalle: Record<string, { tareas: { tarea: string; en: string; tambien: string[] }[]; notas: string[] }>
  totales: Record<string, AlumnoResumen['totales']>
  por_revisar: PorRevisar
  sugerencias: { grupos: SugerenciaGrupo[]; comodines: { clave: string; titulo: string }[] }
  /**
   * Recuperaciones entregadas por alumnos a los que no les faltaba nada: cuentan como nota adicional en el
   * promedio de tareas, solo si lo suben. `fecha` es la fecha límite o de creación de la recuperación (UTC ISO).
   */
  adicionales: { alumno: string; comodin: string; titulo: string; fecha: string | null; calificacion: number | null; puntos: number | null }[]
}

/** Resumen serializable por materia: sirve para la pantalla, el esquema de calificación y los avisos de no entrega. */
export interface ResumenClassroom {
  materia_id: number
  cursos: { id: string; nombre: string; seccion: string; enlace: string }[]
  sincronizado: string | null
  tareas: TareaResumen[]
  alumnos: AlumnoResumen[]
  entregas: CeldaEntrega[]
  sin_ligar: {
    /** En Classroom pero no ligados a la lista: no cuentan en nada. Con `sugerido`, falta confirmar; sin él, se ignoran. */
    classroom: SinLigarClassroom[]
    /** En la lista de la app pero no en Classroom. */
    app: AlumnoApp[]
    /** Marcados a mano «no es de mi grupo». */
    ajenos: SinLigarClassroom[]
  }
  /** Vista por tareas de la app: duplicados agrupados y comodines acreditadas. */
  consolidado: Consolidacion
}

export interface DetalleEntrega {
  curso_id: string
  entrega_id: string
  alumno: string
  tarea: string
  tarea_id: string
  estado: EstadoEntrega
  estado_classroom: string
  tarde: boolean
  /** Fecha en que el docente la registró como recibida fuera de Classroom (null = no) */
  fuera: string | null
  /** La tarea la creó esta app: se califica en Classroom desde aquí */
  propia: boolean
  /** Lo que el alumno subió desde el portal («Subir tarea») */
  portal: { subida: string; nota: string; archivos: { id: number; nombre: string; tamano: number; subido_en: string }[] } | null
  /** Se puede registrar a mano: Classroom no la tiene como entregada */
  puede_registrarse: boolean
  /** Calificación puesta en la app (null = se usa la de Classroom) y la que trae Classroom */
  calif_app: number | null
  calif_classroom: number | null
  calificacion: number | null
  borrador: number | null
  puntos: number | null
  vence: string | null
  entregada: string | null
  actualizada: string | null
  enlace: string
  respuesta: string
  adjuntos: Adjunto[]
}

export type Vista =
  | { tipo: 'pdf'; nombre: string; mime: string; tamano: number | null; url: string; enlace: string }
  | { tipo: 'imagen'; nombre: string; mime: string; tamano: number | null; url: string; enlace: string }
  | { tipo: 'texto'; nombre: string; mime: string; tamano: number | null; texto: string; recortado: boolean; enlace: string }
  | { tipo: 'ninguno'; nombre: string; mime: string; tamano: number | null; motivo: string; enlace: string }

/** Archivo que el docente adjuntó a una tarea: ya está en su Drive, visible con el enlace. */
export interface ArchivoAdjuntado {
  id: string
  titulo: string
  enlace: string
  /** 'enlace' = cualquiera con el enlace; 'dominio' = solo cuentas de la universidad; 'no' = no se pudo compartir */
  compartido: 'enlace' | 'dominio' | 'no'
}
