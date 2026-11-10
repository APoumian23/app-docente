import type {
  Actividad, Ajustes, Alumno, Asistencia, Carrera, EstadoAsistencia, Evaluacion, GastoIA, GeneracionIA, Horario, Materia, Material, Periodo, Resultado, Sesion, TerminoGlosario, VistaMaterial
} from '@shared/types'
import type { LimiteFaltas, Modalidad, Riesgo } from '@shared/asistencia'
import type { Notificacion } from '@shared/portal'
import type { InformeCopias, RevisionIA } from '@shared/copias'
import type { ErrorRegistrado, OrigenError } from '@shared/errores'

/** Tarea nueva para Classroom (fecha y hora de entrega en Ciudad de México, «YYYY-MM-DDTHH:MM» o '') */
export interface NuevaTarea {
  titulo: string
  descripcion: string
  puntos: number | null
  vence: string
  enlaces: string[]
  /** Archivos ya subidos a Drive (subirArchivosTarea) que se adjuntan al guardar */
  archivos?: ArchivoAdjuntado[]
}
import type { ArchivoAdjuntado, CursoClassroom, DetalleEntrega, EstadoConexion, ReglaCalificacion, ResultadoSync, ResumenClassroom, Vista } from '@shared/classroom'

export interface EstadoPortal {
  encendido: boolean
  puerto: number
  urls: string[]
  url_publica: string
  docente_usuario: string
  docente_configurado: boolean
  auto_iniciar: boolean
  avance_alumnos: boolean
  portal_compilado: boolean
  no_leidas: number
  /** Por qué el portal no arrancó o se cayó (vacío si todo va bien). */
  falla: string
  /** El portal vive en internet y esta app se sincroniza con él */
  en_linea: boolean
  sincro: { ultima: string | null; falla: string; enCurso: boolean } | null
}

export interface CambioVersion {
  hash: string
  fecha: string
  texto: string
}
export interface EstadoActualizacion {
  instalada: { version: string; fecha: string; cambios?: CambioVersion[] } | null
  disponible: { version: string; fecha: string; cambios?: CambioVersion[] } | null
  hay_nueva: boolean
  novedades: CambioVersion[]
  origen: string
  motivo: string
}

export interface AccesoCreado {
  matricula: string
  nombre: string
  usuario: string
  password: string
}

export type { FilaCalificacion, Concentrado, DetalleAlumno } from '@shared/calificaciones'
import type { Concentrado, DetalleAlumno } from '@shared/calificaciones'
import type { Esquema, ResultadoAlumno } from '@shared/esquema'
import type { ResumenProyeccion, NivelFaltas } from '@shared/proyeccion'

export type TipoRecordatorio = 'parcial' | 'entrega' | 'suspension' | 'otro'
export interface Recordatorio {
  id: number
  fecha: string
  fecha_fin: string | null
  hora: string | null
  titulo: string
  tipo: TipoRecordatorio
  materia_id: number | null
  avisar_dias: number
  notas: string
  clave: string | null
  avisado_en: string | null
  materia_nombre?: string | null
  materia_color?: string | null
}
export interface FechasProximas {
  recordatorios: Recordatorio[]
  evaluaciones: { id: number; titulo: string; tipo: string; fecha: string; materia_id: number; materia_nombre: string; materia_color: string }[]
  portal: { id: number; titulo: string; fecha: string; hora: string; materia_id: number; materia_nombre: string; materia_color: string }[]
}
export interface Captura { componente_id: number; alumno_id: number; rubro: number; valor: number | null; entregado: number | null; extra: number | null }
export interface CalificacionesEsquema {
  esquema: Esquema | null
  alumnos: Alumno[]
  resultados: ResultadoAlumno[]
  capturas: Captura[]
  participaciones: { alumno_id: number; fecha: string }[]
  evaluaciones: { id: number; titulo: string; tipo: string; puntos_totales: number; fecha: string | null }[]
  /** Sesiones que ya pasaron (no canceladas) sin ningún pase de lista: la asistencia del parcial no las cuenta. */
  sesiones_sin_lista: string[]
  /** Si la materia está ligada a Classroom y cuántos alumnos de la lista no están ligados. */
  classroom: { conectado: boolean; sin_ligar: number[] }
}
export interface AlertaFaltas {
  materia_id: number
  materia_nombre: string
  materia_color: string
  alumno_id: number
  alumno: string
  matricula: string
  nivel: NivelFaltas
  texto: string
  faltas: number
  horas_falta: number
}

async function llamar<T>(canal: string, ...args: unknown[]): Promise<T> {
  const r = await window.api.invoke<T>(canal, ...args)
  // Marcado: el proceso principal ya lo anotó en el registro de errores, la ventana no lo vuelve a anotar
  if (!r.ok) throw Object.assign(new Error(r.error), { desdeIpc: true })
  return r.data
}

export interface MateriaDetalle extends Materia {
  horarios: Horario[]
  alumnos: Alumno[]
  materiales: (Omit<Material, 'texto'> & { texto_len: number })[]
  evaluaciones: Evaluacion[]
  glosario: TerminoGlosario[]
}

export type HorarioSemana = Horario & { materia_nombre: string; materia_color: string; carrera_clave: string }

/** Cuadrícula de la sección Asistencias. */
export interface MatrizAsistencia {
  sesiones: { id: number; numero: number; semana: number; fecha: string; hora_inicio: string; hora_fin: string; estado: string; tema: string }[]
  registros: { sesion_id: number; alumno_id: number; estado: EstadoAsistencia; nota: string }[]
  alumnos: (Alumno & { horas_falta: number; riesgo: Riesgo; porcentaje: number | null })[]
  limites: LimiteFaltas
  parciales: { id: number; nombre: string; desde: string; hasta: string }[]
}

/** Conversación del Asistente (chat con la IA). */
export interface ConversacionChat {
  id: number
  titulo: string
  materia_id: number | null
  materia_nombre: string | null
  actualizado: string
}
export interface MensajeChat {
  id: number
  conversacion_id: number
  rol: 'usuario' | 'asistente'
  contenido: string
  creado: string
}

/** Programa del editor de código (pantalla Programar). */
export interface Programa {
  id: number
  materia_id: number | null
  materia_nombre?: string | null
  nombre: string
  lenguaje: 'python' | 'javascript'
  codigo: string
  entrada: string
  actualizado: string
}

export const api = {
  carreras: {
    listar: () => llamar<Carrera[]>('carreras:listar'),
    guardar: (c: Partial<Carrera>) => llamar<number>('carreras:guardar', c),
    eliminar: (id: number, password?: string) => llamar<number>('carreras:eliminar', id, password)
  },
  periodos: {
    listar: () => llamar<Periodo[]>('periodos:listar'),
    guardar: (p: Partial<Periodo>) => llamar<number>('periodos:guardar', p)
  },
  materias: {
    listar: () => llamar<Materia[]>('materias:listar'),
    obtener: (id: number) => llamar<MateriaDetalle | null>('materias:obtener', id),
    guardar: (m: Partial<Materia>) => llamar<number>('materias:guardar', m),
    portalProgramar: (id: number, activo: boolean) => llamar<number>('materias:portalProgramar', id, activo),
    eliminar: (id: number, password: string) => llamar<number>('materias:eliminar', id, password),
    generarSesiones: (id: number) => llamar<number>('materias:generarSesiones', id),
    ocultar: (id: number, oculta: boolean) => llamar<boolean>('materias:ocultar', id, oculta)
  },
  horarios: {
    guardar: (h: Partial<Horario>) => llamar<number>('horarios:guardar', h),
    eliminar: (id: number) => llamar<number>('horarios:eliminar', id),
    semana: () => llamar<HorarioSemana[]>('horarios:semana')
  },
  alumnos: {
    listar: (carreraId?: number) => llamar<Alumno[]>('alumnos:listar', carreraId),
    guardar: (a: Partial<Alumno>) => llamar<number>('alumnos:guardar', a),
    eliminar: (id: number, password: string) => llamar<number>('alumnos:eliminar', id, password),
    inscribir: (materiaId: number, ids: number[]) => llamar<number>('alumnos:inscribir', materiaId, ids),
    desinscribir: (materiaId: number, alumnoId: number) => llamar<number>('alumnos:desinscribir', materiaId, alumnoId),
    cambiarCarrera: (ids: number[], carreraId: number) => llamar<number>('alumnos:cambiarCarrera', ids, carreraId),
    importarExcel: (materiaId: number | null, carreraId: number | null) => llamar<{ importados: number; cancelado?: boolean }>('alumnos:importarExcel', materiaId, carreraId),
    detalle: (id: number) => llamar<DetalleAlumno>('alumnos:detalle', id),
    crearAcceso: (id: number) => llamar<AccesoCreado | null>('alumnos:crearAcceso', id),
    reiniciarPassword: (id: number) => llamar<string>('alumnos:reiniciarPassword', id)
  },
  sesiones: {
    porMateria: (id: number) => llamar<Sesion[]>('sesiones:porMateria', id),
    porFecha: (fecha: string) => llamar<Sesion[]>('sesiones:porFecha', fecha),
    rango: (desde: string, hasta: string) => llamar<Sesion[]>('sesiones:rango', desde, hasta),
    obtener: (id: number) => llamar<Sesion | null>('sesiones:obtener', id),
    guardar: (s: Partial<Sesion>) => llamar<number>('sesiones:guardar', s),
    estado: (id: number, estado: Sesion['estado']) => llamar<number>('sesiones:estado', id, estado),
    impacto: (id: number) => llamar<{ asistencias: number }>('sesiones:impacto', id),
    eliminar: (id: number, password?: string) => llamar<number>('sesiones:eliminar', id, password),
    reemplazarActividades: (sesionId: number, acts: Partial<Actividad>[]) => llamar<number>('actividades:reemplazar', sesionId, acts),
    /** Intercambia el plan con otra sesión; opcionalmente mueve las evaluaciones de cada fecha a la otra. */
    intercambiarPlan: (aId: number, bId: number, moverEvaluaciones: boolean) => llamar<{ evaluaciones_movidas: number }>('sesiones:intercambiarPlan', aId, bId, moverEvaluaciones),
    evaluacionesDelDia: (materiaId: number, fecha: string) => llamar<{ id: number; titulo: string }[]>('evaluaciones:delDia', materiaId, fecha),
    moverEvaluaciones: (materiaId: number, de: string, a: string) => llamar<number>('evaluaciones:moverFecha', materiaId, de, a)
  },
  asistencia: {
    porSesion: (id: number) => llamar<Asistencia[]>('asistencia:porSesion', id),
    marcar: (sesionId: number, alumnoId: number, estado: string, nota = '') => llamar<boolean>('asistencia:marcar', sesionId, alumnoId, estado, nota),
    marcarTodos: (sesionId: number, ids: number[], estado: string) => llamar<number>('asistencia:marcarTodos', sesionId, ids, estado),
    justificar: (sesionId: number, alumnoId: number, motivo: string) => llamar<boolean>('asistencia:justificar', sesionId, alumnoId, motivo),
    quitarJustificacion: (sesionId: number, alumnoId: number) => llamar<boolean>('asistencia:quitarJustificacion', sesionId, alumnoId),
    resumenMateria: (materiaId: number) => llamar<{ alumno_id: number; estado: string; n: number }[]>('asistencia:resumenMateria', materiaId),
    matriz: (materiaId: number) => llamar<MatrizAsistencia>('asistencia:matriz', materiaId),
    /** Varias celdas a la vez (selección múltiple en Asistencias) */
    marcarVarios: (celdas: { sesion_id: number; alumno_id: number }[], estado: string) => llamar<number>('asistencia:marcarVarios', celdas, estado)
  },
  materiales: {
    agregar: (materiaId: number, unidad?: string) => llamar<number[]>('materiales:agregar', materiaId, unidad),
    compartir: (ids: number[], compartido: boolean) => llamar<number>('materiales:compartir', ids, compartido),
    agregarLink: (materiaId: number, titulo: string, url: string, unidad?: string) => llamar<number>('materiales:agregarLink', materiaId, titulo, url, unidad),
    texto: (id: number) => llamar<string>('materiales:texto', id),
    eliminar: (id: number) => llamar<number>('materiales:eliminar', id),
    abrir: (ruta: string) => llamar<void>('materiales:abrir', ruta),
    /** Cómo verlo dentro de la app (Abrir) */
    vista: (id: number) => llamar<VistaMaterial>('materiales:vista', id),
    /** Convierte el archivo en examen con IA (pasa sus preguntas o genera unas de su contenido) */
    aExamen: (id: number, op: { modo: 'auto' | 'extraer' | 'generar'; opcion_multiple: number; verdadero_falso: number; abierta: number; todas?: boolean; eleccion?: 'repartidas' | 'azar'; instrucciones?: string }) =>
      llamar<Evaluacion>('evaluaciones:desdeArchivo', id, op),
    establecerPresentacion: (materiaId: number, materialId: number | null) => llamar<string | null>('materiales:establecerPresentacion', materiaId, materialId),
  },
  calificaciones: {
    materia: (materiaId: number) => llamar<Concentrado>('calificaciones:materia', materiaId),
    esquema: (materiaId: number) => llamar<CalificacionesEsquema>('calificaciones:esquema', materiaId),
    proyeccion: (materiaId: number) => llamar<ResumenProyeccion | null>('calificaciones:proyeccion', materiaId),
    guardarCaptura: (c: Partial<Captura> & { componente_id: number; alumno_id: number }) => llamar<boolean>('capturas:guardar', c)
  },
  esquema: {
    porOmision: (materiaId: number) => llamar<Esquema>('esquema:porOmision', materiaId),
    guardar: (e: Esquema) => llamar<Esquema>('esquema:guardar', e),
    capturasDe: (ids: number[]) => llamar<number>('esquema:capturasDe', ids),
    publicarParcial: (parcialId: number, publicado: boolean) => llamar<number>('esquema:publicarParcial', parcialId, publicado),
    /** Calificación del parcial a mano (null = volver al cálculo) */
    ajustarParcial: (parcialId: number, alumnoId: number, calificacion: number | null, nota?: string) =>
      llamar<void>('calificaciones:ajustarParcial', parcialId, alumnoId, calificacion, nota),
    /** Calificación final a mano (null = volver al promedio de los parciales) */
    ajustarFinal: (materiaId: number, alumnoId: number, calificacion: number | null, nota?: string) =>
      llamar<void>('calificaciones:ajustarFinal', materiaId, alumnoId, calificacion, nota)
  },
  participaciones: {
    porSesion: (sesionId: number) => llamar<{ alumno_id: number; n: number }[]>('participaciones:porSesion', sesionId),
    agregar: (materiaId: number, alumnoId: number, sesionId: number | null, fecha: string) => llamar<number>('participaciones:agregar', materiaId, alumnoId, sesionId, fecha),
    quitar: (materiaId: number, alumnoId: number, sesionId: number | null, desde?: string, hasta?: string) => llamar<number>('participaciones:quitar', materiaId, alumnoId, sesionId, desde, hasta)
  },
  faltas: {
    alertas: (materiaId?: number) => llamar<AlertaFaltas[]>('faltas:alertas', materiaId),
    alCambiar: (cb: () => void): (() => void) => window.api.escuchar('faltas:novedades', () => cb())
  },
  recordatorios: {
    listar: () => llamar<Recordatorio[]>('recordatorios:listar'),
    guardar: (r: Partial<Recordatorio>) => llamar<number>('recordatorios:guardar', r),
    eliminar: (id: number) => llamar<number>('recordatorios:eliminar', id),
    proximas: (desde: string, hasta: string) => llamar<FechasProximas>('fechas:proximas', desde, hasta)
  },
  presentacion: {
    estado: (ruta: string | null) => llamar<{ pdf: string | null; convertible: boolean }>('presentacion:estado', ruta),
    convertir: (ruta: string) => llamar<string>('presentacion:convertir', ruta),
    prepararMateria: (materiaId: number) => llamar<{ total: number; convertidas: number; errores: string[] }>('presentacion:prepararMateria', materiaId)
  },
  evaluaciones: {
    obtener: (id: number) => llamar<Evaluacion>('evaluaciones:obtener', id),
    guardar: (e: Partial<Evaluacion>) => llamar<number>('evaluaciones:guardar', e),
    /** Examen con un cuaderno de Jupyter de los materiales; devuelve el id de la evaluación */
    desdeCuaderno: (materialId: number) => llamar<number>('evaluaciones:desdeCuaderno', materialId),
    impacto: (id: number) => llamar<{ calificaciones: number; publicaciones: number; entregas: number }>('evaluaciones:impacto', id),
    eliminar: (id: number, password?: string) => llamar<number>('evaluaciones:eliminar', id, password),
    resultados: (id: number) => llamar<Resultado[]>('resultados:porEvaluacion', id),
    guardarResultado: (r: Partial<Resultado>) => llamar<boolean>('resultados:guardar', r)
  },
  programas: {
    listar: () => llamar<Programa[]>('programas:listar'),
    guardar: (p: Partial<Programa>) => llamar<number>('programas:guardar', p),
    eliminar: (id: number) => llamar<number>('programas:eliminar', id)
  },
  pyodide: {
    paquetes: () => llamar<{ nombre: string; para: string; descargado: boolean }[]>('pyodide:paquetes'),
    descargar: (nombre: string) => llamar<string[]>('pyodide:descargar', nombre),
    borrar: () => llamar<number>('pyodide:borrar'),
    cancelar: () => llamar<void>('pyodide:cancelar')
  },
  glosario: {
    guardar: (g: Partial<TerminoGlosario>) => llamar<number>('glosario:guardar', g),
    eliminar: (id: number) => llamar<number>('glosario:eliminar', id)
  },
  respaldos: {
    listar: () =>
      llamar<{ respaldos: { nombre: string; tipo: string; fecha: string; bytes: number }[]; carpeta_externa: string; ultimo_externo: string; error_externo: string }>('respaldos:listar'),
    crear: () => llamar<{ nombre: string }>('respaldos:crear'),
    elegirCarpeta: () => llamar<string>('respaldos:elegirCarpeta'),
    quitarCarpeta: () => llamar<void>('respaldos:quitarCarpeta'),
    /** Reinicia la app y pone ese respaldo en lugar de la base (guardando antes la actual) */
    restaurar: (nombre: string) => llamar<void>('respaldos:restaurar', nombre)
  },
  asistente: {
    listar: () => llamar<ConversacionChat[]>('asistente:listar'),
    mensajes: (id: number) => llamar<MensajeChat[]>('asistente:mensajes', id),
    crear: (materiaId: number | null) => llamar<number>('asistente:crear', materiaId),
    /** Conversación del panel del asistente de un programa (Programar) */
    dePrograma: (programaId: number) => llamar<number>('asistente:dePrograma', programaId),
    actualizar: (id: number, c: { titulo?: string; materia_id?: number | null }) => llamar<void>('asistente:actualizar', id, c),
    borrar: (id: number) => llamar<void>('asistente:borrar', id),
    enviar: (id: number, texto: string, opciones?: { web?: boolean; usarMateriales?: boolean; codigo?: { lenguaje: string; codigo: string; salida?: string }; reintento?: boolean }) =>
      llamar<MensajeChat>('asistente:enviar', id, texto, opciones),
    detener: (id: number) => llamar<void>('asistente:detener', id),
    /** Respuestas que se están escribiendo ahora (con lo que llevan) */
    enCurso: () => llamar<{ conversacion_id: number; texto: string }[]>('asistente:enCurso'),
    guardarEnMateria: (materiaId: number, titulo: string, contenido: string) => llamar<number>('asistente:guardarEnMateria', materiaId, titulo, contenido),
    /** Cada pedazo de la respuesta mientras se escribe */
    alTrozo: (cb: (d: { conversacion_id: number; texto: string }) => void): (() => void) =>
      window.api.escuchar('asistente:trozo', (d) => cb(d as { conversacion_id: number; texto: string }))
  },
  ia: {
    disponible: () => llamar<boolean>('ia:disponible'),
    guardarApiKey: (k: string, proveedor?: 'anthropic' | 'nvidia') => llamar<boolean>('ia:guardarApiKey', k, proveedor),
    modelosNvidia: () => llamar<{ id: string; nombre: string; nota: string; recomendado: boolean }[]>('ia:modelosNvidia'),
    probar: () => llamar<string>('ia:probar'),
    /** Tokens y costo aproximado de la IA en los últimos días, por uso y por modelo. */
    gasto: (dias?: number) => llamar<GastoIA>('ia:gasto', dias),
    generar: (req: GeneracionIA) => llamar<Evaluacion>('ia:generar', req),
    preguntar: (materiaId: number, pregunta: string) => llamar<string>('ia:preguntar', materiaId, pregunta),
    /** Cuestionario de opción múltiple, listo para jugar en vivo, sobre el contenido de una evaluación. */
    generarJuego: (evaluacionId: number, cantidad?: number) => llamar<Evaluacion>('ia:generarJuego', evaluacionId, cantidad),
    /** Claude interpreta la proyección que calcula la app (no inventa números). */
    analizarProyeccion: (materiaId: number) => llamar<string>('ia:analizarProyeccion', materiaId),
    aplicarPlan: (sesionId: number, evaluacionId: number) => llamar<boolean>('ia:aplicarPlan', sesionId, evaluacionId)
  },
  exportar: {
    materiaXlsx: (materiaId: number, alumnoId?: number) => llamar<string | null>('exportar:materiaXlsx', materiaId, alumnoId),
    todoXlsx: (materiaId: number) => llamar<string | null>('exportar:todoXlsx', materiaId),
    alumnosXlsx: (materiaId: number) => llamar<string | null>('exportar:alumnosXlsx', materiaId),
    reporteAlumnoPdf: (materiaId: number, alumnoId: number) => llamar<string | null>('exportar:reporteAlumnoPdf', materiaId, alumnoId),
    evaluacion: (evId: number, formato: 'pdf' | 'docx', conRespuestas: boolean) => llamar<string | null>('exportar:evaluacion', evId, formato, conRespuestas)
  },
  seguridad: {
    estado: () => llamar<{ configurada: boolean }>('seguridad:estado'),
    establecer: (nueva: string, actual?: string) => llamar<boolean>('seguridad:establecer', nueva, actual),
    quitar: (actual: string) => llamar<boolean>('seguridad:quitar', actual),
  },
  ordenCarreras: {
    leer: () => llamar<number[]>('carreras:ordenLeer'),
    guardar: (ids: number[]) => llamar<number>('carreras:ordenGuardar', ids)
  },
  ordenMaterias: {
    leer: () => llamar<number[]>('materias:ordenLeer'),
    guardar: (ids: number[]) => llamar<number>('materias:ordenGuardar', ids)
  },
  ajustes: {
    leer: () => llamar<Ajustes & { api_key_configurada: boolean; api_key_nvidia_configurada: boolean; password_configurada: boolean; conversor: { tipo: 'libreoffice' | 'keynote'; detalle: string }; ruta_datos: string }>('ajustes:leer'),
    guardar: (a: Partial<Ajustes>) => llamar<boolean>('ajustes:guardar', a)
  },
  portal: {
    estado: () => llamar<EstadoPortal>('portal:estado'),
    iniciar: () => llamar<EstadoPortal>('portal:iniciar'),
    detener: () => llamar<EstadoPortal>('portal:detener'),
    docente: (nombre: string, usuario: string, password: string) => llamar<EstadoPortal>('portal:docente', nombre, usuario, password),
    ajustes: (a: { puerto?: number; url_publica?: string; auto_iniciar?: boolean; avance_alumnos?: boolean }) => llamar<EstadoPortal>('portal:ajustes', a),
    qr: () => llamar<{ url: string; qr: string }>('portal:qr'),
    /** Panel docente ya autenticado: dentro de la app (por omisión), en otra ventana (true) o en el navegador */
    abrirPanel: (ruta?: string, enVentana?: boolean | 'navegador') => llamar<void>('portal:abrirPanel', ruta, enVentana),
    /** Dirección autenticada del panel para la página «Panel del portal» (dentro de la app) */
    urlPanel: (ruta?: string) => llamar<string>('portal:urlPanel', ruta),
    /** El proceso principal pide mostrar una ruta del panel (p. ej. al tocar el aviso de una entrega) */
    alVerPanel: (cb: (ruta: string) => void): (() => void) => window.api.escuchar('portal:verPanel', (r) => cb(String(r))),
    accesos: (materiaId: number) => llamar<{ creados: AccesoCreado[]; existentes: number }>('portal:accesos', materiaId),
    jugar: (evaluacionId: number, segundos?: number) => llamar<string>('portal:jugar', evaluacionId, segundos),
    notificaciones: (soloNoLeidas?: boolean) => llamar<Notificacion[]>('portal:notificaciones', soloNoLeidas),
    leidas: (ids?: number[]) => llamar<number>('portal:leidas', ids),
    sincronizar: (forzar?: boolean) => llamar<EstadoPortal>('portal:sincronizar', forzar),
    aviso: (materiaId: number, titulo: string, cuerpo: string, carreraId?: number | null) => llamar<number>('portal:aviso', materiaId, titulo, cuerpo, carreraId ?? null),
    /** Avisos nuevos empujados desde el proceso principal (entregas, etc.). */
    alRecibir: (cb: (nuevas: Notificacion[]) => void): (() => void) => window.api.escuchar('portal:novedades', (n) => cb(n as Notificacion[]))
  },
  /** Registro de errores de la app (se ve en Ajustes › Errores) */
  errores: {
    listar: () => llamar<ErrorRegistrado[]>('errores:listar'),
    revisados: () => llamar<number>('errores:revisados'),
    borrar: () => llamar<void>('errores:borrar'),
    mostrarArchivo: () => llamar<void>('errores:mostrarArchivo'),
    /** Desde la ventana: errores de JS o de una pantalla. No usa `llamar` para no entrar en bucle si el registro falla. */
    registrar: (origen: OrigenError, donde: string, mensaje: string, detalle = ''): void => {
      window.api.invoke('errores:registrar', origen, donde, mensaje, detalle).catch(() => undefined)
    },
    alNuevo: (cb: (e: ErrorRegistrado) => void): (() => void) => window.api.escuchar('errores:nuevo', (e) => cb(e as ErrorRegistrado))
  },
  sistema: {
    abrirRuta: (ruta: string) => llamar<void>('sistema:abrirRuta', ruta),
    pantallaCompleta: (on: boolean) => llamar<void>('sistema:pantallaCompleta', on)
  },
  actualizacion: {
    revisar: () => llamar<EstadoActualizacion>('actualizacion:revisar'),
    /** Cierra la app; un script aparte instala la versión nueva y la vuelve a abrir. */
    instalar: () => llamar<void>('actualizacion:instalar'),
    /** Alumnos contestando y juegos en curso en el portal (para advertir antes de actualizar) */
    contestando: () => llamar<{ alumnos: number; partidas: number }>('portal:contestando')
  },
  /** Google Classroom en solo lectura (entregas por tarea). */
  classroom: {
    /** Lleva las tareas consolidadas de Classroom a los componentes del parcial que se llamen igual. */
    aCalificaciones: (materiaId: number, parcialOrden: number) => llamar<{ capturas: number; respetadas: number; tareas: string[]; sin_tarea: string[] }>('classroom:aCalificaciones', materiaId, parcialOrden),
    estado: () => llamar<EstadoConexion>('classroom:estado'),
    guardarCredenciales: (clientId: string, clientSecret: string) => llamar<EstadoConexion>('classroom:guardarCredenciales', clientId, clientSecret),
    conectar: () => llamar<EstadoConexion>('classroom:conectar'),
    desconectar: () => llamar<EstadoConexion>('classroom:desconectar'),
    sincronizar: () => llamar<ResultadoSync>('classroom:sincronizar'),
    cursos: () => llamar<CursoClassroom[]>('classroom:cursos'),
    ligarCurso: (cursoId: string, materiaId: number | null) => llamar<void>('classroom:ligarCurso', cursoId, materiaId),
    ligarAlumno: (cursoId: string, userId: string, destino: number | 'ajeno' | null) => llamar<void>('classroom:ligarAlumno', cursoId, userId, destino),
    /** Alumnos × tareas de Classroom y la consolidación por tareas de la app (para calificar y avisar de no entregas). */
    resumen: (materiaId: number) => llamar<ResumenClassroom>('classroom:resumen', materiaId),
    entrega: (cursoId: string, entregaId: string) => llamar<DetalleEntrega>('classroom:entrega', cursoId, entregaId),
    marcarEntregaFuera: (cursoId: string, entregaId: string, recibida: boolean) => llamar<void>('classroom:marcarEntregaFuera', cursoId, entregaId, recibida),
    abrirSubida: (archivoId: number) => llamar<void>('classroom:abrirSubida', archivoId),
    calificarEnApp: (cursoId: string, entregaId: string, calificacion: number | null) => llamar<void>('classroom:calificarEnApp', cursoId, entregaId, calificacion),
    previsualizar: (cursoId: string, entregaId: string, archivoId: string) => llamar<Vista>('classroom:previsualizar', cursoId, entregaId, archivoId),
    previsualizarMaterial: (cursoId: string, tareaId: string, archivoId: string) => llamar<Vista>('classroom:previsualizarMaterial', cursoId, tareaId, archivoId),
    descargar: (cursoId: string, entregaId: string, archivoId: string) => llamar<string | null>('classroom:descargar', cursoId, entregaId, archivoId),
    /** Claves curso:tarea de Classroom (las de una tarea de la app, o una sola). */
    crearTarea: (cursoId: string, t: NuevaTarea) => llamar<void>('classroom:crearTarea', cursoId, t),
    editarTarea: (cursoId: string, tareaId: string, t: Partial<NuevaTarea>) => llamar<void>('classroom:editarTarea', cursoId, tareaId, t),
    subirArchivosTarea: () => llamar<ArchivoAdjuntado[]>('classroom:subirArchivosTarea'),
    borrarTarea: (cursoId: string, tareaId: string) => llamar<void>('classroom:borrarTarea', cursoId, tareaId),
    ajustePortal: (cursoId: string, tareaId: string, a: { visibilidad: 'todos' | 'algunos' | 'oculta'; alumnos: number[]; acepta_tarde: boolean }) => llamar<void>('classroom:ajustePortal', cursoId, tareaId, a),
    activarTareasApp: (materiaId: number) => llamar<string>('classroom:activarTareasApp', materiaId),
    calificarEnClassroom: (cursoId: string, tareaId: string, notas: { entrega_id: string; nota: number }[], devolver: boolean) =>
      llamar<{ calificadas: number; errores: string[] }>('classroom:calificarEnClassroom', cursoId, tareaId, notas, devolver),
    revisarCopias: (claves: string[]) => llamar<InformeCopias>('classroom:revisarCopias', claves),
    /** La última revisión guardada con esa clave (metadatos, copias o IA), o null */
    revisionGuardada: <T>(clave: string) => llamar<{ datos: T; guardado: string } | null>('classroom:revisionGuardada', clave),
    guardarRevision: (clave: string, datos: unknown) => llamar<boolean>('classroom:guardarRevision', clave, datos),
    revisarCopiasIA: (generado: string) => llamar<RevisionIA>('classroom:revisarCopiasIA', generado),
    /** Metadatos de los archivos de una sola entrega (comparados con el grupo) */
    metadatosEntrega: (cursoId: string, entregaId: string) => llamar<InformeCopias>('classroom:metadatosEntrega', cursoId, entregaId),
    descargarTarea: (claves: string[]) => llamar<{ carpeta: string; archivos: number; enlaces: number; errores: string[] } | null>('classroom:descargarTarea', claves),
    abrirEnlace: (url: string) => llamar<void>('classroom:abrirEnlace', url),
    crearTareaApp: (materiaId: number, nombre: string, claves: string[] = []) => llamar<number>('classroom:crearTareaApp', materiaId, nombre, claves),
    actualizarTareaApp: (id: number, cambios: { nombre?: string; regla?: ReglaCalificacion }) => llamar<void>('classroom:actualizarTareaApp', id, cambios),
    eliminarTareaApp: (id: number) => llamar<void>('classroom:eliminarTareaApp', id),
    asignarTarea: (clave: string, tareaAppId: number | null) => llamar<void>('classroom:asignarTarea', clave, tareaAppId),
    marcarComodin: (clave: string, comodin: boolean, cubre: number[] = []) => llamar<void>('classroom:marcarComodin', clave, comodin, cubre),
    decidirComodin: (clave: string, userId: string, destino: number | 'ninguna' | 'auto') => llamar<void>('classroom:decidirComodin', clave, userId, destino),
    aceptarSugerencias: (materiaId: number) => llamar<number>('classroom:aceptarSugerencias', materiaId),
    exportarExcel: (materiaId: number) => llamar<string | null>('classroom:exportarExcel', materiaId)
  }
}
