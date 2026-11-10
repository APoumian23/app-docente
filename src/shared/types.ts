// Tipos compartidos entre main, preload y renderer.

export type ID = number

export interface Carrera { id: ID; nombre: string; clave: string; color: string }

export interface Periodo {
  id: ID
  nombre: string
  fecha_inicio: string // YYYY-MM-DD (lunes de la semana 1)
  semanas: number
  activo: number
}

export interface Materia {
  id: ID
  carrera_id: ID
  periodo_id: ID
  nombre: string
  clave: string
  cuatrimestre: number
  color: string
  descripcion: string
  temario: string // markdown con unidades y temas
  presentacion_path: string | null
  oculta: number // 1 = no aparece en Hoy, Horario ni listados de trabajo
  /** 1 = sus alumnos ven la pestaña «Programar» del portal */
  portal_programar?: number
  docente_id: number | null // usuario del portal dueño de la materia
  // join
  carrera_nombre?: string
  /** Carreras de sus alumnos activos («2,3»): la materia se muestra en cada una */
  carreras_alumnos?: string | null
}

export interface Horario {
  id: ID
  materia_id: ID
  dia: number // 1=lunes ... 7=domingo
  hora_inicio: string // HH:MM
  hora_fin: string
  aula: string
}

export interface Alumno {
  id: ID
  matricula: string
  nombre: string
  apellidos: string
  email: string
  carrera_id: ID | null
  activo: number
  /** Materias en que está inscrito (solo en la lista general de alumnos). */
  materias?: ID[]
}

export type TipoActividad = 'apertura' | 'exposicion' | 'ejercicio' | 'discusion' | 'evaluacion' | 'receso' | 'cierre'

export interface Actividad {
  id: ID
  sesion_id: ID
  orden: number
  nombre: string
  tipo: TipoActividad
  duracion_min: number
  descripcion: string
  recurso: string // ruta o URL opcional
}

export interface Sesion {
  id: ID
  materia_id: ID
  semana: number
  numero: number
  fecha: string // YYYY-MM-DD
  hora_inicio: string
  hora_fin: string
  tema: string
  objetivo: string
  notas: string
  estado: 'planeada' | 'en_curso' | 'terminada' | 'cancelada'
  presentacion_path: string | null
  actividades?: Actividad[]
  materia_nombre?: string
  materia_color?: string
}

export type EstadoAsistencia = 'presente' | 'ausente' | 'retardo' | 'justificado'

export interface Asistencia {
  id: ID
  sesion_id: ID
  alumno_id: ID
  estado: EstadoAsistencia
  hora: string
  nota: string
}

export interface Material {
  id: ID
  materia_id: ID
  titulo: string
  tipo: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'geogebra' | 'codigo' | 'link' | 'otro'
  ruta: string
  unidad: string
  texto: string // texto extraído para dar contexto a la IA
  creado: string
  /** 1 = los alumnos lo ven y lo descargan en el portal */
  compartido?: number
}

export type TipoEvaluacion =
  | 'diagnostico'
  | 'examen'
  | 'examen_sorpresa'
  | 'examen_oral'
  | 'cuestionario'
  | 'tarea'
  | 'ejercicios'
  | 'ejemplos'
  | 'glosario'
  | 'material_apoyo'
  | 'plan_sesion'
  | 'presentacion'
  | 'clase_completa'
  | 'apuntes'

export interface Pregunta {
  tipo: 'opcion_multiple' | 'abierta' | 'verdadero_falso' | 'problema' | 'codigo' | 'cuaderno'
  enunciado: string
  opciones?: string[]
  respuesta: string
  puntos: number
  explicacion: string
  /** Pregunta «cuaderno»: el .ipynb que resuelve el alumno (texto JSON de nbformat 4), copiado al crear el examen */
  cuaderno?: string
  /** Pregunta «cuaderno»: deja importar numpy, pandas, matplotlib… (sin esto, solo la biblioteca estándar) */
  paquetes?: boolean
}

export interface ContenidoEvaluacion {
  titulo: string
  instrucciones: string
  duracion_min: number
  preguntas: Pregunta[]
}

export interface Evaluacion {
  id: ID
  materia_id: ID
  tipo: TipoEvaluacion
  titulo: string
  contenido: string // JSON o markdown según tipo
  fecha_aplicacion: string | null
  puntos_totales: number
  creado: string
}

export interface Resultado {
  id: ID
  evaluacion_id: ID
  alumno_id: ID
  puntaje: number | null
  estado: 'pendiente' | 'entregado' | 'calificado' | 'no_entregado'
  fecha_entrega: string | null
  comentario: string
}

export interface TerminoGlosario { id: ID; materia_id: ID; termino: string; definicion: string; ejemplo: string }

export interface Ajustes {
  tolerancia_retardo_min: number
  avanzar_auto: boolean
  sonido: boolean
  proveedor_ia: 'anthropic' | 'nvidia'
  modelo_ia: string
  /** Solo para llaves de Anthropic que no están ligadas a un workspace (wrkspc_…). */
  workspace_anthropic: string
  modelo_nvidia: string
  /** Para tareas, ejercicios, cuestionarios, glosario, plan de sesión y juego en vivo. 'principal' = el mismo modelo, con esfuerzo medio. */
  modelo_ia_rapido: string
  nombre_docente: string
}

/** Gasto de la IA en un periodo (Ajustes › Inteligencia artificial). Costo aproximado con precios públicos. */
export interface GastoIA {
  dias: number
  total_usd: number
  llamadas: number
  /** Peticiones de un modelo sin precio conocido: no suman al total */
  sin_precio: number
  por_uso: { uso: string; nombre: string; llamadas: number; costo_usd: number; salida: number }[]
  por_modelo: { modelo: string; llamadas: number; costo_usd: number }[]
}

export interface GeneracionIA {
  materia_id: ID
  tipo: TipoEvaluacion
  tema: string
  unidad?: string
  dificultad: 'basico' | 'intermedio' | 'avanzado'
  cantidad: number
  instrucciones?: string
  usar_materiales: boolean
  /** Solo textos (material, clase, presentación): Claude verifica en internet y cita fuentes. Cuesta más. */
  verificar_web?: boolean
  /** Solo textos: qué tan desarrollado sale (por omisión, completo) */
  detalle?: 'breve' | 'completo' | 'muy_detallado'
}

export interface ExportAlumnoOpts { materia_id: ID; alumno_id?: ID; formato: 'xlsx' | 'pdf' }

/** Cómo se muestra un material dentro de la app (src/main/services/visor.ts) */
export type VistaMaterial =
  | { tipo: 'pdf' | 'imagen' | 'web'; nombre: string; url: string }
  | { tipo: 'html'; nombre: string; html: string }
  | { tipo: 'texto'; nombre: string; texto: string; recortado: boolean }
  | { tipo: 'convertir' | 'externo'; nombre: string; motivo: string }
