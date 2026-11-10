/**
 * Portal en línea: la app de escritorio y el servidor (VPS) tienen cada uno su base. Cada tabla tiene
 * un solo dueño, así nunca hay dos versiones que mezclar:
 *  - la app manda en todo lo del docente (materias, alumnos, evaluaciones, asistencias, Classroom,
 *    calificaciones) y lo sube completo;
 *  - el portal manda en lo que hacen los alumnos y el panel web (cuentas, publicaciones, intentos,
 *    archivos, avisos, juegos, «Subir tarea») y la app lo baja completo.
 */

/** El portal es el dueño: la app las reemplaza con lo que baja. */
export const TABLAS_DEL_PORTAL = [
  'usuarios',
  'asignaciones',
  'asignacion_alumnos',
  'intentos',
  'eventos_integridad',
  'archivos_entrega',
  'notificaciones',
  'partidas',
  'participantes',
  'respuestas_partida',
  'programas_alumno',
  'subidas_alumno',
  'archivos_subida',
  'cuadernos_alumno'
] as const

/** Ni se suben ni se bajan: sesiones y códigos son de cada lado; el asistente es privado; ajustes va aparte. */
/** Push: cada celular se suscribe al servidor que le manda las notificaciones; los avisos automáticos los da solo ese servidor. */
export const TABLAS_SIN_SINCRONIZAR = ['sesiones_web', 'codigos_acceso', 'sqlite_sequence', 'asistente_conversaciones', 'asistente_mensajes', 'ajustes', 'push_suscripciones', 'avisos_dados'] as const

/** Ajustes que el portal necesita. Llaves, tokens de Classroom y contraseñas nunca salen de la Mac. */
export const AJUSTES_AL_PORTAL = ['nombre_docente', 'tolerancia_retardo_min', 'portal_alumno_avance', 'portal_nombre'] as const

/**
 * Versión web de la app: ajustes del docente que la Mac le manda al servidor junto con sus llaves (IA y Google),
 * que nunca viajan en la sincronización normal. La Mac manda; lo que se cambie en la web no regresa.
 */
export const AJUSTES_DE_LA_MAC = [
  'nombre_docente', 'proveedor_ia', 'modelo_ia', 'modelo_ia_rapido', 'modelo_nvidia', 'workspace_anthropic', 'sonido', 'orden_materias', 'orden_carreras',
  'avanzar_auto', 'tolerancia_retardo_min', 'classroom_cuenta', 'classroom_scopes', 'classroom_client_id', 'classroom_ultima_sync',
  // Solo su hash (scrypt): para que eliminar en la web pida la misma contraseña que en la Mac
  'pass_borrado'
] as const

export interface SecretosDeLaMac {
  ia?: { anthropic?: string; nvidia?: string }
  classroom?: { client_id: string; secret: string; refresh: string }
  ajustes?: Record<string, string>
}

export interface TablaSincro {
  columnas: string[]
  filas: unknown[][]
}

export interface PaqueteSubida {
  tablas: Record<string, TablaSincro>
  ajustes: Record<string, string>
  /** Permite borrar más de la mitad de una tabla (solo si el docente lo confirmó) */
  forzar?: boolean
}

export interface PaqueteBajada {
  tablas: Record<string, TablaSincro>
  /** Archivos de entregas, relativos a la carpeta de entregas */
  archivos: { ruta: string; tamano: number }[]
  hora: string
  /** Huella de las tablas: la app la manda de vuelta y, si nada cambió, no se le reenvía todo */
  huella: string
}

export type RespuestaBajada = PaqueteBajada | { sin_cambios: true; huella: string }
