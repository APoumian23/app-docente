// Tipos del portal de alumnos. Los comparten el servidor, la app de escritorio y el portal web.
import type { ID, Pregunta, TipoEvaluacion } from './types'

export type Rol = 'docente' | 'alumno'

export interface Usuario {
  id: ID
  rol: Rol
  nombre: string
  usuario: string
  email: string
  alumno_id: ID | null
  debe_cambiar: number
  activo: number
  /** Sesión que abrió la app de escritorio (código de un solo uso): cambia su contraseña sin escribir la actual */
  desde_app?: boolean
}

export interface SesionWeb {
  token: string
  usuario: Usuario
  expira: string
}

/** Reglas con las que se publica una evaluación a un grupo. */
export interface Asignacion {
  id: ID
  evaluacion_id: ID
  materia_id: ID
  docente_id: ID | null
  titulo: string
  instrucciones: string
  tipo: TipoEvaluacion
  abre: string
  cierra: string | null
  duracion_min: number | null
  vigilancia: number
  /** Con vigilancia: a la 1.ª salida se avisa y a la 2.ª el intento se envía solo */
  cerrar_al_salir: number
  /** Bloqueo de examen: solo el examen y en pantalla completa hasta enviarlo; el docente lo pone y lo quita en vivo */
  bloqueo: number
  /** Alumnos a los que va (vacío = toda la materia) */
  para?: number[]
  /** Preguntas al azar por alumno (JSON de AzarAsignacion; '' = todas para todos) */
  azar?: string
  /** Candado: hay que contestar todas para poder enviar */
  todas_obligatorias?: number
  permite_borrador: number
  permite_archivos: number
  mostrar_resultado: number
  /** Cuándo ve el alumno qué contestó bien y mal, con la respuesta correcta (requiere mostrar_resultado) */
  mostrar_respuestas?: MostrarRespuestas
  /** Cuánto vale en su parcial (%), p. ej. 30 para el examen; 0 = no se indica */
  ponderacion?: number
  activa: number
  publicada_en: string
  // join
  materia_nombre?: string
  materia_color?: string
  puntos_totales?: number
}

/** «al_cerrar»: cuando pasa la fecha límite o el docente cierra la actividad (nadie más puede contestarla) */
export type MostrarRespuestas = 'no' | 'al_cerrar' | 'al_enviar'

export type EstadoIntento = 'borrador' | 'en_curso' | 'enviado' | 'calificado'

export interface Intento {
  id: ID
  asignacion_id: ID
  alumno_id: ID
  estado: EstadoIntento
  iniciado_en: string
  ultima_actividad: string
  enviado_en: string | null
  tiempo_activo_seg: number
  respuestas: Record<string, string>
  puntaje: number | null
  puntaje_auto: number | null
  pendiente_manual: number
  retro: string
  calificado_en: string | null
  /** El docente le quitó el bloqueo de examen a este alumno */
  desbloqueado: number
  /** Su sorteo de preguntas (con preguntas al azar por alumno); JSON */
  seleccion?: string
  // join
  alumno_nombre?: string
  alumno_matricula?: string
  eventos?: number
  /** En vivo (docente): su último evento fue salir de la pantalla del examen y no ha vuelto */
  fuera?: boolean
  archivos?: ArchivoEntrega[]
}

export type TipoEventoIntegridad =
  | 'salio_pestana'
  | 'volvio_pestana'
  | 'perdio_foco'
  | 'recupero_foco'
  | 'salio_pantalla_completa'
  | 'volvio_pantalla_completa'
  | 'mouse_fuera'
  | 'mouse_volvio'
  | 'copiar'
  | 'pegar'
  | 'recarga'
  | 'cerrado_por_salidas'
  | 'captura_pantalla'

export interface EventoIntegridad {
  id: ID
  intento_id: ID
  tipo: TipoEventoIntegridad
  detalle: string
  en: string
}

export interface ArchivoEntrega {
  id: ID
  intento_id: ID
  nombre: string
  mime: string
  tamano: number
  subido_en: string
}

export interface Notificacion {
  id: ID
  usuario_id: ID
  tipo: string
  titulo: string
  cuerpo: string
  ref_tipo: string
  ref_id: ID | null
  leida: number
  creada: string
}

/** Lo que ve el alumno de una evaluación asignada: preguntas sin respuestas ni explicaciones. */
/** Cuántas preguntas de cada tipo le tocan a cada alumno, sorteadas del examen */
export interface AzarAsignacion {
  opcion_multiple: number
  verdadero_falso: number
  abierta: number
}

export interface PreguntaAlumno {
  /** Índice en el examen original: con él se guarda la respuesta */
  indice: number
  /** Número con que la ve el alumno (con preguntas al azar no coincide con el índice) */
  numero?: number
  tipo: Pregunta['tipo']
  enunciado: string
  opciones: string[]
  puntos: number
  /** Preguntas de código: lenguaje en que se corre (el mismo para el alumno y para el docente) */
  lenguaje?: 'python' | 'javascript'
  /** Preguntas de cuaderno: el .ipynb del docente (texto JSON) con el que empieza el alumno */
  cuaderno?: string
  paquetes?: boolean
}

export interface AsignacionParaAlumno extends Asignacion {
  intento: Intento | null
  preguntas?: PreguntaAlumno[]
  abierta: boolean
  motivo_cierre?: string
  /** Hora del servidor al responder (ms): el celular calcula con ella su desfase de reloj. */
  servidor_ms?: number
  /** Salidas ya contadas en este intento (vigilancia) */
  salidas?: number
  /** Bloqueo de examen vigente para este alumno ahora (con la asignación bloqueada y sin excepción suya) */
  bloqueado?: boolean
  /** Ya entregó y el docente deja ver las respuestas: cada pregunta con lo que contestó y si estuvo bien */
  revision?: PreguntaRevisada[]
  /** Ya entregó pero las respuestas todavía no se muestran: por qué y desde cuándo */
  revision_aviso?: string
}

/** Una pregunta del examen ya entregado, como la revisa el alumno */
export interface PreguntaRevisada {
  numero: number
  tipo: PreguntaAlumno['tipo']
  enunciado: string
  opciones: string[]
  puntos: number
  respuesta_alumno: string
  /** La clave del docente (en opción múltiple, el texto de la opción correcta) */
  respuesta_correcta: string
  explicacion: string
  indice_correcto: number
  indice_alumno: number
  /** true/false si se califica sola; null si la revisa el docente */
  correcta: boolean | null
  lenguaje?: string
}

export interface ResumenEntregas {
  asignacion: Asignacion
  inscritos: number
  entregados: number
  pendientes_manual: number
  promedio: number | null
}

// ---------- Juego en vivo ----------
export type EstadoPartida = 'lobby' | 'pregunta' | 'resultado' | 'terminada'

export interface Partida {
  id: ID
  evaluacion_id: ID
  pin: string
  estado: EstadoPartida
  pregunta_actual: number
  segundos_por_pregunta: number
  total_preguntas: number
  titulo: string
  /** Solo en GET /api/partidas/:pin: dirección que se proyecta a los alumnos. */
  url_alumnos?: string
}

export interface Participante {
  id: ID
  apodo: string
  puntos: number
}

/**
 * Quién respondió qué en una partida (solo para el docente): las preguntas ya lanzadas, con su opción correcta,
 * y por jugador la opción que eligió en cada una. Una pregunta sin entrada en `respuestas` quedó sin responder.
 */
export interface DetallePartida {
  preguntas: { indice: number; enunciado: string; opciones: string[]; correcta: number }[]
  jugadores: { id: ID; apodo: string; puntos: number; respuestas: Record<number, { opcion: number; correcta: boolean }> }[]
}

export interface PreguntaPartida {
  indice: number
  enunciado: string
  opciones: string[]
  segundos: number
  total: number
}

/** Cómo se comunican docente y alumnos durante una partida por WebSocket. */
export interface EventosPartida {
  // servidor → todos
  'partida:estado': (p: Partida & { participantes: Participante[] }) => void
  'partida:pregunta': (q: PreguntaPartida) => void
  'partida:resultado': (r: { correcta: number; conteo: number[]; tabla: Participante[]; explicacion: string }) => void
  'partida:fin': (tabla: Participante[]) => void
  'partida:respondieron': (d: { n: number; total: number }) => void
  // cliente → servidor
  /**
   * `clave` es el secreto que devolvió el servidor al unirse; permite retomar el apodo tras reconectar.
   * Un alumno con sesión juega con el nombre de su cuenta (el `apodo` se ignora). `respondida`: ya contestó la pregunta en curso.
   */
  'partida:unirse': (
    d: { pin: string; apodo: string; clave?: string },
    cb: (r: { ok: boolean; error?: string; participante?: Participante; clave?: string; pregunta?: PreguntaPartida; respondida?: boolean }) => void
  ) => void
  /** El acuse no dice si fue correcta ni los puntos: eso llega con partida:resultado. `ya_respondida`: un reintento de una respuesta que sí quedó. */
  'partida:responder': (d: { pin: string; participante_id: number; opcion: number }, cb: (r: { ok: boolean; ya_respondida?: boolean }) => void) => void
  'partida:controlar': (d: { pin: string; accion: 'iniciar' | 'siguiente' | 'mostrar' | 'terminar' }, cb: (r: { ok: boolean; error?: string }) => void) => void
}

// ---------- «Subir tarea» (tareas de Classroom entregadas desde el portal) ----------

export type EstadoTareaAlumno = 'pendiente' | 'vencida' | 'subida' | 'entregada_classroom' | 'recuperacion' | 'cerrada'

export interface ArchivoSubida {
  id: ID
  nombre: string
  tamano: number
  subido_en: string
}

export interface TareaAlumno {
  curso_id: string
  tarea_id: string
  titulo: string
  descripcion: string
  /** Fecha límite (ISO, UTC) o la de «una semana después de publicada» si no tiene */
  vence: string | null
  sin_fecha: boolean
  puntos: number | null
  enlace: string
  /** Archivos y enlaces que el docente adjuntó a la tarea */
  materiales: { titulo: string; enlace: string }[]
  estado: EstadoTareaAlumno
  /** Subida desde el portal después de la fecha límite */
  tarde: boolean
  /** Calificación que el docente ya le devolvió (null = aún no) */
  calificacion: number | null
  /** El docente acepta entregas después de la fecha límite */
  acepta_tarde: boolean
  nota: string
  subida_en: string | null
  archivos: ArchivoSubida[]
}

export interface MateriaTareasAlumno {
  materia_id: ID
  materia_nombre: string
  materia_color: string
  tareas: TareaAlumno[]
}

// ---------- Ajustes de cada tarea en el portal ----------

export interface PortalTarea {
  visibilidad: 'todos' | 'algunos' | 'oculta'
  /** Ids de alumnos cuando es 'algunos' */
  alumnos: number[]
  acepta_tarde: boolean
}

// ---------- Materiales, calendario y avisos del alumno ----------

export interface MaterialAlumno {
  id: ID
  materia_id: ID
  materia_nombre: string
  materia_color: string
  titulo: string
  tipo: string
  unidad: string
  /** El archivo ya está en el servidor (con el portal en línea, se sube desde la Mac del docente) */
  disponible: boolean
  /** Es un cuaderno de Jupyter (.ipynb): se abre y se resuelve en el portal */
  cuaderno: boolean
  /** Su copia del cuaderno: sin empezar, en borrador o ya entregada */
  cuaderno_estado: 'nuevo' | 'borrador' | 'entregado' | null
}

/** La copia de un cuaderno que trabaja el alumno. `contenido` es el .ipynb (formato 4) tal cual. */
export interface CuadernoAlumno {
  material_id: ID
  titulo: string
  materia_nombre: string
  estado: 'borrador' | 'entregado'
  contenido: unknown
  actualizado: string
  entregado_en: string | null
  tarea_titulo: string | null
}

/** Tarea donde se puede entregar un cuaderno. */
export interface TareaParaCuaderno {
  curso_id: string
  tarea_id: string
  titulo: string
  vence: string | null
  estado: string
}

export interface EventoCalendario {
  /** YYYY-MM-DD (hora de Ciudad de México) */
  fecha: string
  hora: string
  tipo: 'clase' | 'examen' | 'entrega' | 'actividad'
  titulo: string
  detalle: string
  materia_nombre: string
  materia_color: string
}
