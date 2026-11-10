import type Database from 'better-sqlite3'
import { unlinkSync } from 'fs'
import { resolve, sep } from 'path'
import type { Asignacion, AsignacionParaAlumno, Intento, Notificacion, ResumenEntregas, EventoIntegridad, ArchivoEntrega, TipoEventoIntegridad, MostrarRespuestas } from '../shared/portal'
import type { ContenidoEvaluacion, Evaluacion, Materia, Pregunta } from '../shared/types'
import { ErrorHttp, buscarUsuarioPorNombre } from './auth'
import { SQL_CARRERA_MATERIA, pesoDelExamen } from './base'
import { leerContenido, preguntasParaAlumno, calificarAutomatico, indiceDeOpcion, indiceVerdaderoFalso, lenguajeDePregunta } from './calificar'
import { alumnoSoloDe, docentePrincipalId } from './permisos'
import { validarCuaderno } from './cuadernos'
import { delIntento, leerAzar, leerSeleccion, preguntasDelAlumno, puntosPorAlumno, sortear, validarAzar } from './azar'

type Fila = Record<string, unknown>

/**
 * Las fechas se guardan en UTC con el formato de SQLite ("YYYY-MM-DD HH:MM:SS").
 * Se muestran en hora de Ciudad de México solo al presentarlas.
 */
const ahoraIso = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** Convierte lo guardado (UTC sin zona) o lo recibido (ISO con zona) a Date. */
export function aFecha(texto: string): Date {
  const t = texto.trim()
  const tieneZona = /Z$|[+-]\d{2}:?\d{2}$/.test(t)
  return new Date(tieneZona ? t : t.replace(' ', 'T') + 'Z')
}

/** Ciudad de México está en UTC-6 todo el año desde que se eliminó el horario de verano (2022). */
const DESFASE_MX = '-06:00'

/** Normaliza una fecha que llega del cliente al formato de almacenamiento (UTC). */
export function aAlmacen(texto: string | null | undefined): string | null {
  if (!texto) return null
  const d = aFecha(String(texto))
  if (Number.isNaN(d.getTime())) throw new ErrorHttp(400, `Fecha no válida: ${texto}`)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function formatearMx(texto: string | null | undefined): string {
  if (!texto) return ''
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(aFecha(texto))
}

// ---------------- Materias ----------------

/** Sin docente: todas (el principal). Con docente: solo las suyas; las que no tienen dueño son del principal. */
export function materiasVisibles(db: Database.Database, docenteId?: number): (Materia & { inscritos: number })[] {
  const filtro = docenteId ? 'AND m.docente_id = ?' : ''
  const params = docenteId ? [docenteId] : []
  return db
    .prepare(
      `SELECT m.*, ${SQL_CARRERA_MATERIA}, (SELECT COUNT(*) FROM inscripciones i WHERE i.materia_id = m.id) AS inscritos,
         p.fecha_inicio AS periodo_inicio, p.semanas AS periodo_semanas
       FROM materias m JOIN carreras c ON c.id = m.carrera_id LEFT JOIN periodos p ON p.id = m.periodo_id WHERE 1=1 ${filtro} ORDER BY m.oculta, c.nombre, m.nombre`
    )
    .all(...params) as (Materia & { inscritos: number })[]
}

export function ocultarMateria(db: Database.Database, materiaId: number, oculta: boolean): void {
  db.prepare('UPDATE materias SET oculta = ? WHERE id = ?').run(oculta ? 1 : 0, materiaId)
}

// ---------------- Alumnos ----------------

export interface DatosAlumno {
  matricula?: string
  nombre: string
  apellidos?: string
  email?: string
}

/**
 * Da de alta al alumno si no existe (por matrícula) y lo inscribe en la materia.
 * Con `docenteId`, los datos de un alumno que también es de otro docente no se sobrescriben.
 */
export function inscribirAlumno(db: Database.Database, materiaId: number, d: DatosAlumno, docenteId?: number): { alumno_id: number; nuevo: boolean } {
  const matricula = String(d.matricula ?? '').trim()
  const nombre = String(d.nombre ?? '').trim()
  if (!nombre) throw new ErrorHttp(400, 'El nombre es obligatorio.')
  if (!db.prepare('SELECT 1 FROM materias WHERE id = ?').get(materiaId)) throw new ErrorHttp(404, 'La materia no existe.')
  // Sin matrícula no hay forma de reconocer a un alumno previo: siempre se da de alta uno nuevo
  const existente = matricula ? (db.prepare('SELECT id FROM alumnos WHERE matricula = ?').get(matricula) as { id: number } | undefined) : undefined
  let alumnoId: number
  if (existente) {
    alumnoId = existente.id
    if (docenteId === undefined || alumnoSoloDe(db, docenteId, alumnoId)) db.prepare("UPDATE alumnos SET nombre = ?, apellidos = ?, email = CASE WHEN ? <> '' THEN ? ELSE email END WHERE id = ?").run(nombre, String(d.apellidos ?? '').trim(), String(d.email ?? '').trim(), String(d.email ?? '').trim(), alumnoId)
  } else {
    const carrera = db.prepare('SELECT carrera_id FROM materias WHERE id = ?').get(materiaId) as { carrera_id: number }
    alumnoId = Number(db.prepare('INSERT INTO alumnos (matricula, nombre, apellidos, email, carrera_id) VALUES (?,?,?,?,?)').run(matricula, nombre, String(d.apellidos ?? '').trim(), String(d.email ?? '').trim(), carrera.carrera_id).lastInsertRowid)
  }
  db.prepare('INSERT OR IGNORE INTO inscripciones (materia_id, alumno_id) VALUES (?, ?)').run(materiaId, alumnoId)
  return { alumno_id: alumnoId, nuevo: !existente }
}

export function desinscribirAlumno(db: Database.Database, materiaId: number, alumnoId: number): number {
  return db.prepare('DELETE FROM inscripciones WHERE materia_id = ? AND alumno_id = ?').run(materiaId, alumnoId).changes
}

export function evaluacionCompleta(db: Database.Database, evaluacionId: number): Evaluacion & { contenido_json: ReturnType<typeof leerContenido> } {
  const ev = db.prepare('SELECT * FROM evaluaciones WHERE id = ?').get(evaluacionId) as Evaluacion | undefined
  if (!ev) throw new ErrorHttp(404, 'La evaluación no existe.')
  return { ...ev, contenido_json: leerContenido(ev.contenido) }
}

// ---------------- Asignaciones ----------------

export interface NuevaAsignacion {
  evaluacion_id: number
  materia_id: number
  docente_id?: number | null
  titulo?: string
  instrucciones?: string
  abre?: string
  cierra?: string | null
  duracion_min?: number | null
  vigilancia?: boolean
  cerrar_al_salir?: boolean
  bloqueo?: boolean
  /** Solo para estos alumnos (inscritos en la materia); vacío o ausente = toda la materia */
  alumnos?: number[]
  /** Preguntas al azar por alumno: cuántas de cada tipo (ausente = todas, en orden) */
  azar?: unknown
  /** Candado: no se puede enviar con preguntas sin contestar */
  todas_obligatorias?: boolean
  permite_borrador?: boolean
  permite_archivos?: boolean
  mostrar_resultado?: boolean
  /** Cuándo ve el alumno sus aciertos con la respuesta correcta (ausente = al cerrar) */
  mostrar_respuestas?: MostrarRespuestas
  /** Cuánto vale en su parcial (%); ausente = en exámenes, el peso del examen en el esquema de la materia */
  ponderacion?: number
}

const MOSTRAR_RESPUESTAS: MostrarRespuestas[] = ['no', 'al_cerrar', 'al_enviar']
function validarMostrarRespuestas(v: unknown): MostrarRespuestas {
  if (!MOSTRAR_RESPUESTAS.includes(v as MostrarRespuestas)) throw new ErrorHttp(400, 'Indica cuándo ve el alumno sus respuestas: no, al cerrar o al enviar.')
  return v as MostrarRespuestas
}
function validarPonderacion(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new ErrorHttp(400, 'La ponderación debe ser un porcentaje entre 0 y 100.')
  return Math.round(n * 100) / 100
}

/**
 * La asignación `a` es para el alumno `?`: va a toda la materia (sin destinatarios) o él está entre los elegidos.
 * Se usa junto a la inscripción en todas las consultas del alumno.
 */
export const PARA_ALUMNO = `(NOT EXISTS (SELECT 1 FROM asignacion_alumnos pa WHERE pa.asignacion_id = a.id)
  OR EXISTS (SELECT 1 FROM asignacion_alumnos pa WHERE pa.asignacion_id = a.id AND pa.alumno_id = ?))`

/** A quiénes va (vacío = toda la materia) */
const paraDe = (db: Database.Database, asignacionId: number): number[] =>
  (db.prepare('SELECT alumno_id FROM asignacion_alumnos WHERE asignacion_id = ? ORDER BY alumno_id').all(asignacionId) as { alumno_id: number }[]).map((x) => x.alumno_id)

const SELECT_ASIGNACION = `
  SELECT a.*, e.tipo, e.puntos_totales, m.nombre AS materia_nombre, m.color AS materia_color
  FROM asignaciones a JOIN evaluaciones e ON e.id = a.evaluacion_id JOIN materias m ON m.id = a.materia_id`

export function crearAsignacion(db: Database.Database, d: NuevaAsignacion): Asignacion {
  const ev = db.prepare('SELECT * FROM evaluaciones WHERE id = ?').get(d.evaluacion_id) as Evaluacion | undefined
  if (!ev) throw new ErrorHttp(404, 'La evaluación no existe.')
  if (ev.materia_id !== d.materia_id) throw new ErrorHttp(400, 'La evaluación no pertenece a esa materia.')
  const contenido = leerContenido(ev.contenido)
  if (!contenido || contenido.preguntas.length === 0) {
    throw new ErrorHttp(400, 'Esta evaluación no tiene reactivos todavía. Genera su contenido en Estudio IA antes de publicarla.')
  }
  const inscritos = (db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE materia_id = ?').get(d.materia_id) as { n: number }).n
  if (!inscritos) throw new ErrorHttp(400, 'La materia no tiene alumnos inscritos.')
  const azar = validarAzar(contenido, d.azar)
  const mostrarRespuestas = d.mostrar_respuestas === undefined ? 'al_cerrar' : validarMostrarRespuestas(d.mostrar_respuestas)
  const ponderacion = d.ponderacion === undefined || d.ponderacion === null ? (ev.tipo === 'examen' ? pesoDelExamen(db, d.materia_id) : 0) : validarPonderacion(d.ponderacion)
  // Destinatarios: solo alumnos inscritos en la materia, sin repetir
  let para: number[] = []
  if (d.alumnos !== undefined && d.alumnos !== null) {
    if (!Array.isArray(d.alumnos)) throw new ErrorHttp(400, 'Los destinatarios deben ser una lista de alumnos.')
    para = [...new Set(d.alumnos.map(Number))]
    if (para.some((x) => !Number.isInteger(x))) throw new ErrorHttp(400, 'Hay un alumno no válido en los destinatarios.')
    const enMateria = new Set((db.prepare('SELECT alumno_id FROM inscripciones WHERE materia_id = ?').all(d.materia_id) as { alumno_id: number }[]).map((x) => x.alumno_id))
    if (para.some((x) => !enMateria.has(x))) throw new ErrorHttp(400, 'Solo puedes elegir alumnos inscritos en esta materia.')
  }
  const id = Number(
    db
      .prepare(
        `INSERT INTO asignaciones (evaluacion_id, materia_id, docente_id, titulo, instrucciones, abre, cierra, duracion_min, vigilancia, cerrar_al_salir, bloqueo, azar, todas_obligatorias, permite_borrador, permite_archivos, mostrar_resultado, mostrar_respuestas, ponderacion)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        d.evaluacion_id,
        d.materia_id,
        d.docente_id ?? null,
        (d.titulo ?? ev.titulo).trim() || ev.titulo,
        d.instrucciones ?? contenido.instrucciones ?? '',
        aAlmacen(d.abre) ?? ahoraIso(),
        aAlmacen(d.cierra),
        // null explícito = sin límite; ausente = el que traiga la evaluación
        d.duracion_min !== undefined ? d.duracion_min || null : contenido.duracion_min || null,
        // El bloqueo vigila: sin el registro de salidas el docente no sabría quién se salió
        d.vigilancia || d.bloqueo ? 1 : 0,
        d.vigilancia && d.cerrar_al_salir ? 1 : 0,
        d.bloqueo ? 1 : 0,
        azar ? JSON.stringify(azar) : '',
        d.todas_obligatorias ? 1 : 0,
        d.permite_borrador ? 1 : 0,
        d.permite_archivos ? 1 : 0,
        d.mostrar_resultado === false ? 0 : 1,
        mostrarRespuestas,
        ponderacion
      ).lastInsertRowid
  )
  if (para.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO asignacion_alumnos (asignacion_id, alumno_id) VALUES (?, ?)')
    db.transaction(() => para.forEach((x) => ins.run(id, x)))()
  }
  const asignacion = obtenerAsignacion(db, id)
  // El aviso solo les llega a quienes va
  notificarInscritos(db, d.materia_id, para.length ? para : null, {
    tipo: 'asignacion',
    titulo: `Nueva actividad: ${asignacion.titulo}`,
    cuerpo: `${asignacion.materia_nombre} · ${describirVentana(asignacion)}`,
    ref_tipo: 'asignacion',
    ref_id: id
  })
  return asignacion
}

export function obtenerAsignacion(db: Database.Database, id: number): Asignacion {
  const a = db.prepare(`${SELECT_ASIGNACION} WHERE a.id = ?`).get(id) as Asignacion | undefined
  if (!a) throw new ErrorHttp(404, 'La asignación no existe.')
  return { ...conPuntosAzar(db, a), para: paraDe(db, id) }
}

/** Con preguntas al azar, el examen vale lo que vale el sorteo de cada alumno, no el banco completo */
function conPuntosAzar(db: Database.Database, a: Asignacion): Asignacion {
  const azar = leerAzar(a.azar)
  if (!azar) return a
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string } | undefined
  const c = ev ? leerContenido(ev.contenido) : null
  return c ? { ...a, puntos_totales: puntosPorAlumno(c, azar) } : a
}

export function actualizarAsignacion(
  db: Database.Database,
  id: number,
  cambios: Partial<Pick<Asignacion, 'cierra' | 'activa' | 'abre' | 'duracion_min' | 'instrucciones' | 'titulo'>> & {
    bloqueo?: boolean
    mostrar_resultado?: boolean
    mostrar_respuestas?: MostrarRespuestas
    ponderacion?: number
  }
): Asignacion {
  const actual = obtenerAsignacion(db, id)
  // Lo que ve el alumno al terminar se puede cambiar después de publicar (también con entregas ya hechas)
  if (cambios.mostrar_resultado !== undefined) {
    if (typeof cambios.mostrar_resultado !== 'boolean') throw new ErrorHttp(400, 'Mostrar el resultado debe ser sí o no.')
    db.prepare('UPDATE asignaciones SET mostrar_resultado = ? WHERE id = ?').run(cambios.mostrar_resultado ? 1 : 0, id)
  }
  if (cambios.mostrar_respuestas !== undefined) db.prepare('UPDATE asignaciones SET mostrar_respuestas = ? WHERE id = ?').run(validarMostrarRespuestas(cambios.mostrar_respuestas), id)
  if (cambios.ponderacion !== undefined) db.prepare('UPDATE asignaciones SET ponderacion = ? WHERE id = ?').run(validarPonderacion(cambios.ponderacion), id)
  // Bloquear o desbloquear en vivo a todo el grupo; bloquear también enciende la vigilancia
  if (cambios.bloqueo !== undefined) {
    if (typeof cambios.bloqueo !== 'boolean') throw new ErrorHttp(400, 'El bloqueo debe ser sí o no.')
    db.prepare(`UPDATE asignaciones SET bloqueo = ?${cambios.bloqueo ? ', vigilancia = 1' : ''} WHERE id = ?`).run(cambios.bloqueo ? 1 : 0, id)
    // Volver a bloquear al grupo también quita las excepciones: «Bloquear» es para todos
    if (cambios.bloqueo) db.prepare("UPDATE intentos SET desbloqueado = 0 WHERE asignacion_id = ? AND desbloqueado = 1 AND estado IN ('en_curso', 'borrador')").run(id)
  }
  db.prepare('UPDATE asignaciones SET titulo = ?, instrucciones = ?, abre = ?, cierra = ?, duracion_min = ?, activa = ? WHERE id = ?').run(
    cambios.titulo ?? actual.titulo,
    cambios.instrucciones ?? actual.instrucciones,
    cambios.abre ? aAlmacen(cambios.abre) : actual.abre,
    cambios.cierra === undefined ? actual.cierra : aAlmacen(cambios.cierra),
    cambios.duracion_min === undefined ? actual.duracion_min : cambios.duracion_min,
    cambios.activa === undefined ? actual.activa : cambios.activa ? 1 : 0,
    id
  )
  return obtenerAsignacion(db, id)
}

export function describirVentana(a: Asignacion): string {
  const partes: string[] = []
  if (a.cierra) partes.push(`cierra ${formatearMx(a.cierra)}`)
  if (a.duracion_min) partes.push(`${a.duracion_min} min`)
  if (a.vigilancia) partes.push('con vigilancia')
  return partes.join(' · ') || 'sin límite'
}

/** Margen para la latencia de la red al terminar el tiempo de un examen. */
const GRACIA_MS = 30_000

/** Determina si un alumno puede trabajar ahora en una asignación. */
export function ventana(a: Asignacion, intento: Intento | null, ahora = new Date()): { abierta: boolean; motivo?: string } {
  if (!a.activa) return { abierta: false, motivo: 'El docente cerró esta actividad.' }
  if (aFecha(a.abre) > ahora) return { abierta: false, motivo: `Se abre el ${formatearMx(a.abre)}` }
  if (a.cierra && aFecha(a.cierra) < ahora) return { abierta: false, motivo: 'La fecha límite ya pasó.' }
  if (intento && (intento.estado === 'enviado' || intento.estado === 'calificado')) return { abierta: false, motivo: 'Ya la entregaste.' }
  if (intento && a.duracion_min) {
    const limite = aFecha(intento.iniciado_en).getTime() + a.duracion_min * 60000
    if (ahora.getTime() > limite + GRACIA_MS) return { abierta: false, motivo: 'Se agotó el tiempo.' }
  }
  return { abierta: true }
}

// ---------------- Vista del alumno ----------------

function leerIntento(fila: Fila | undefined): Intento | null {
  if (!fila) return null
  return { ...(fila as unknown as Intento), respuestas: JSON.parse((fila.respuestas as string) || '{}') }
}

/**
 * Lo que el alumno puede ver de su intento. Si el docente decidió no mostrar el resultado,
 * no viajan el puntaje (automático ni final) ni la retroalimentación. Toda respuesta al alumno pasa por aquí.
 */
export function vistaParaAlumno<T extends Intento>(intento: T, a: Pick<Asignacion, 'mostrar_resultado'>): T
export function vistaParaAlumno<T extends Intento>(intento: T | null, a: Pick<Asignacion, 'mostrar_resultado'>): T | null
export function vistaParaAlumno<T extends Intento>(intento: T | null, a: Pick<Asignacion, 'mostrar_resultado'>): T | null {
  if (!intento || a.mostrar_resultado) return intento
  return { ...intento, puntaje: null, puntaje_auto: null, retro: '' }
}

export function asignacionesDeAlumno(db: Database.Database, alumnoId: number): AsignacionParaAlumno[] {
  cerrarVencidos(db)
  const filas = db
    .prepare(
      `${SELECT_ASIGNACION}
       JOIN inscripciones i ON i.materia_id = a.materia_id AND i.alumno_id = ?
       WHERE ${PARA_ALUMNO}
       ORDER BY a.publicada_en DESC`
    )
    .all(alumnoId, alumnoId) as Asignacion[]
  const intentoDe = db.prepare('SELECT * FROM intentos WHERE asignacion_id = ? AND alumno_id = ?')
  return filas.map((fila) => {
    const a = conPuntosAzar(db, fila)
    const intento = leerIntento(intentoDe.get(a.id, alumnoId) as Fila | undefined)
    const v = ventana(a, intento)
    return { ...a, intento: vistaParaAlumno(intento, a), abierta: v.abierta, motivo_cierre: v.motivo }
  })
}

export function asignacionParaAlumno(db: Database.Database, asignacionId: number, alumnoId: number): AsignacionParaAlumno {
  cerrarVencidos(db)
  const a = obtenerAsignacion(db, asignacionId)
  const inscrito = db.prepare('SELECT 1 FROM inscripciones WHERE materia_id = ? AND alumno_id = ?').get(a.materia_id, alumnoId)
  if (!inscrito) throw new ErrorHttp(403, 'No estás inscrito en esa materia.')
  if (a.para?.length && !a.para.includes(alumnoId)) throw new ErrorHttp(403, 'Esta actividad no es para ti.')
  const intento = leerIntento(db.prepare('SELECT * FROM intentos WHERE asignacion_id = ? AND alumno_id = ?').get(asignacionId, alumnoId) as Fila | undefined)
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
  const contenido = leerContenido(ev.contenido)
  const v = ventana(a, intento)
  // Las preguntas solo viajan cuando hay un intento abierto: así no se descargan antes de empezar
  const puedeVer = intento !== null
  // Los archivos ya subidos viajan con el intento para que sigan visibles tras recargar
  const conArchivos = intento ? { ...intento, archivos: archivosDeIntento(db, intento.id) } : null
  const rev = intento && contenido ? revisionParaAlumno(a, intento, contenido) : {}
  return {
    ...rev,
    ...a,
    intento: vistaParaAlumno(conArchivos, a),
    abierta: v.abierta,
    motivo_cierre: v.motivo,
    // Con preguntas al azar, solo las de su sorteo, en su orden y con sus opciones revueltas
    preguntas: puedeVer && contenido ? preguntasDelAlumno(preguntasParaAlumno(contenido), leerSeleccion(intento?.seleccion)) : undefined,
    // El celular corrige su reloj con este dato: la cuenta regresiva no depende de su hora
    servidor_ms: Date.now(),
    // Las salidas ya contadas sobreviven a una recarga: la advertencia y el cierre no se reinician
    salidas: intento && a.vigilancia ? salidasContadas(db, intento.id) : 0,
    bloqueado: Boolean(a.bloqueo && v.abierta && (!intento || ((intento.estado === 'en_curso' || intento.estado === 'borrador') && !intento.desbloqueado)))
  }
}

/** ¿Ya nadie puede contestarla? (pasó la fecha límite o el docente la cerró) */
const yaCerro = (a: Asignacion, ahora = new Date()): boolean => !a.activa || (a.cierra !== null && aFecha(a.cierra) < ahora)

/**
 * Lo que el alumno puede revisar de su entrega: cada pregunta con lo que contestó, la respuesta correcta y la
 * explicación. Solo si ya entregó, el docente muestra el resultado y, según lo elegido, al enviar o hasta que
 * la actividad cierre (así nadie le pasa las respuestas a quien todavía la contesta).
 */
function revisionParaAlumno(a: Asignacion, i: Intento, c: ContenidoEvaluacion): Pick<AsignacionParaAlumno, 'revision' | 'revision_aviso'> {
  if (i.estado !== 'enviado' && i.estado !== 'calificado') return {}
  const modo = a.mostrar_respuestas ?? 'al_cerrar'
  if (!a.mostrar_resultado || modo === 'no') return {}
  if (modo === 'al_cerrar' && !yaCerro(a)) {
    return { revision_aviso: a.cierra ? `Verás qué contestaste bien y mal cuando cierre la actividad (${formatearMx(a.cierra)}).` : 'Verás qué contestaste bien y mal cuando tu docente cierre la actividad.' }
  }
  const suyo = delIntento(c, leerSeleccion(i.seleccion), i.respuestas)
  const cal = calificarAutomatico(suyo.contenido, suyo.respuestas)
  return {
    revision: suyo.contenido.preguntas.map((p, pos) => {
      const r = suyo.respuestas[String(pos)] ?? ''
      const correcto = indiceEnOpciones(p, p.respuesta)
      return {
        numero: pos + 1,
        tipo: p.tipo,
        enunciado: p.enunciado,
        opciones: opcionesDe(p),
        puntos: p.puntos,
        // El cuaderno completo no hace falta para revisar: lo califica el docente
        respuesta_alumno: p.tipo === 'cuaderno' ? '' : r,
        respuesta_correcta: correcto >= 0 ? opcionesDe(p)[correcto] : p.tipo === 'cuaderno' ? '' : p.respuesta,
        explicacion: p.explicacion ?? '',
        indice_correcto: correcto,
        indice_alumno: indiceEnOpciones(p, r),
        correcta: cal.detalle[pos]?.correcta ?? null,
        ...(p.tipo === 'codigo' ? { lenguaje: lenguajeDePregunta(p) } : {})
      }
    })
  }
}

/**
 * Elimina una publicación con todo lo que generó: intentos, respuestas, eventos de vigilancia, archivos subidos
 * (también del disco), destinatarios y sus avisos. La evaluación no se toca: se puede volver a publicar.
 */
export function eliminarAsignacion(db: Database.Database, asignacionId: number, carpetaEntregas: string): { intentos: number; archivos: number } {
  obtenerAsignacion(db, asignacionId)
  const archivos = db
    .prepare('SELECT ar.ruta FROM archivos_entrega ar JOIN intentos i ON i.id = ar.intento_id WHERE i.asignacion_id = ?')
    .all(asignacionId) as { ruta: string }[]
  const intentos = (db.prepare('SELECT COUNT(*) AS n FROM intentos WHERE asignacion_id = ?').get(asignacionId) as { n: number }).n
  db.transaction(() => {
    // Hijo por hijo (sin depender de ON DELETE CASCADE): cada borrado queda anotado para la sincronización
    db.prepare("DELETE FROM notificaciones WHERE ref_tipo = 'intento' AND ref_id IN (SELECT id FROM intentos WHERE asignacion_id = ?)").run(asignacionId)
    db.prepare('DELETE FROM eventos_integridad WHERE intento_id IN (SELECT id FROM intentos WHERE asignacion_id = ?)').run(asignacionId)
    db.prepare('DELETE FROM archivos_entrega WHERE intento_id IN (SELECT id FROM intentos WHERE asignacion_id = ?)').run(asignacionId)
    db.prepare('DELETE FROM intentos WHERE asignacion_id = ?').run(asignacionId)
    db.prepare('DELETE FROM asignacion_alumnos WHERE asignacion_id = ?').run(asignacionId)
    db.prepare("DELETE FROM notificaciones WHERE ref_tipo = 'asignacion' AND ref_id = ?").run(asignacionId)
    db.prepare('DELETE FROM asignaciones WHERE id = ?').run(asignacionId)
  })()
  // Los archivos solo se borran si están dentro de la carpeta de entregas
  const base = resolve(carpetaEntregas)
  let borrados = 0
  for (const { ruta } of archivos) {
    const r = resolve(ruta)
    if (!r.startsWith(base + sep)) continue
    try {
      unlinkSync(r)
      borrados++
    } catch {
      /* ya no estaba */
    }
  }
  return { intentos, archivos: borrados }
}

/** El docente quita (o vuelve a poner) el bloqueo de examen a un solo alumno. */
export function desbloquearIntento(db: Database.Database, intentoId: number, desbloqueado: unknown): Intento {
  if (typeof desbloqueado !== 'boolean') throw new ErrorHttp(400, 'Indica si se desbloquea o no.')
  const r = db.prepare("UPDATE intentos SET desbloqueado = ? WHERE id = ? AND estado IN ('en_curso', 'borrador')").run(desbloqueado ? 1 : 0, intentoId)
  if (!r.changes) throw new ErrorHttp(409, 'Ese examen ya se envió: no hay nada que desbloquear.')
  return leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(intentoId) as Fila)!
}

/**
 * El examen bloqueado que el alumno tiene abierto ahora (o null): mientras exista, el portal solo le muestra
 * ese examen. Cuenta aunque todavía no lo empiece: el docente lo bloqueó para el grupo.
 */
export function examenBloqueado(db: Database.Database, alumnoId: number): { asignacion_id: number; intento_id: number | null } | null {
  cerrarVencidos(db)
  const f = db
    .prepare(
      `SELECT a.id AS asignacion_id, i.id AS intento_id FROM asignaciones a
       JOIN inscripciones ins ON ins.materia_id = a.materia_id AND ins.alumno_id = ?
       LEFT JOIN intentos i ON i.asignacion_id = a.id AND i.alumno_id = ins.alumno_id
       WHERE ${PARA_ALUMNO} AND a.bloqueo = 1 AND a.activa = 1 AND a.abre <= datetime('now') AND (a.cierra IS NULL OR a.cierra > datetime('now'))
         AND (i.id IS NULL OR (i.estado IN ('en_curso', 'borrador') AND i.desbloqueado = 0))
       ORDER BY a.abre DESC LIMIT 1`
    )
    .get(alumnoId, alumnoId) as { asignacion_id: number; intento_id: number | null } | undefined
  return f ?? null
}

export function iniciarIntento(db: Database.Database, asignacionId: number, alumnoId: number): Intento {
  const a = asignacionParaAlumno(db, asignacionId, alumnoId)
  if (a.intento) {
    if (a.abierta) return a.intento
    throw new ErrorHttp(400, a.motivo_cierre ?? 'No se puede continuar.')
  }
  if (!a.abierta) throw new ErrorHttp(400, a.motivo_cierre ?? 'La actividad no está disponible.')
  // Preguntas al azar: su sorteo se hace ahora y queda guardado (si recarga o vuelve, ve el mismo examen)
  const azar = leerAzar(a.azar)
  let seleccion = ''
  if (azar) {
    const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
    const c = leerContenido(ev.contenido)
    if (c) seleccion = JSON.stringify(sortear(c, azar))
  }
  const id = Number(db.prepare("INSERT INTO intentos (asignacion_id, alumno_id, estado, seleccion) VALUES (?, ?, 'en_curso', ?)").run(asignacionId, alumnoId, seleccion).lastInsertRowid)
  return leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(id) as Fila)!
}

function intentoDelAlumno(db: Database.Database, intentoId: number, alumnoId: number): Intento {
  const i = leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ? AND alumno_id = ?').get(intentoId, alumnoId) as Fila | undefined)
  if (!i) throw new ErrorHttp(404, 'Intento no encontrado.')
  return i
}

/** Guarda respuestas parciales. Se llama con cada cambio, así nada se pierde si se cae la conexión. */
const tiposDePreguntas = (db: Database.Database, evaluacionId: number): string[] =>
  (leerContenido((db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(evaluacionId) as { contenido: string } | undefined)?.contenido ?? '')?.preguntas ?? []).map((p) => p.tipo)

export function guardarRespuestas(db: Database.Database, intentoId: number, alumnoId: number, respuestas: Record<string, string>, tiempoActivoSeg: number, comoBorrador = false): Intento {
  const i = intentoDelAlumno(db, intentoId, alumnoId)
  if (i.estado === 'enviado' || i.estado === 'calificado') throw new ErrorHttp(400, 'Esta entrega ya fue enviada y no se puede modificar.')
  const a = obtenerAsignacion(db, i.asignacion_id)
  const v = ventana(a, i)
  if (!v.abierta) throw new ErrorHttp(400, v.motivo ?? 'La actividad está cerrada.')
  if (comoBorrador && !a.permite_borrador) throw new ErrorHttp(400, 'Esta actividad no permite guardar borrador.')
  // Un cuaderno de Jupyter trae su código y sus salidas: no se recorta (se partiría el JSON), se revisa que siga siendo un .ipynb
  const tipos = tiposDePreguntas(db, a.evaluacion_id)
  const limpias: Record<string, string> = {}
  for (const [k, val] of Object.entries(respuestas ?? {})) {
    if (!/^\d+$/.test(k)) continue
    const texto = String(val ?? '')
    limpias[k] = tipos[Number(k)] === 'cuaderno' ? (texto.trim() ? validarCuaderno(texto) : '') : texto.slice(0, 20000)
  }
  // Un autoguardado normal no degrada un borrador a "en curso": el estado solo sube a borrador cuando el alumno lo pide
  const estado = comoBorrador ? 'borrador' : i.estado
  db.prepare("UPDATE intentos SET respuestas = ?, tiempo_activo_seg = MAX(tiempo_activo_seg, ?), ultima_actividad = datetime('now'), estado = ? WHERE id = ?").run(
    JSON.stringify(limpias),
    tiempoCreible(i, tiempoActivoSeg),
    estado,
    intentoId
  )
  return intentoDelAlumno(db, intentoId, alumnoId)
}

/** Eventos que cuentan como salir del examen. El navegador marca con DETALLE_NO_CUENTA los que no suman. */
const SALIDAS: TipoEventoIntegridad[] = ['salio_pestana', 'perdio_foco', 'salio_pantalla_completa', 'mouse_fuera']
export const DETALLE_NO_CUENTA = ['misma salida', 'al elegir un archivo para subir', 'al recargar', 'pantalla completa no disponible', 'al entrar a pantalla completa']

function salidasContadas(db: Database.Database, intentoId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM eventos_integridad WHERE intento_id = ? AND tipo IN (${SALIDAS.map(() => '?').join(',')}) AND detalle NOT IN (${DETALLE_NO_CUENTA.map(() => '?').join(',')})`)
      .get(intentoId, ...SALIDAS, ...DETALLE_NO_CUENTA) as { n: number }
  ).n
}
export const SALIDAS_PARA_CERRAR = 2

/**
 * Anota lo que reporta el navegador. Si la actividad cierra al salir, a la segunda salida el intento
 * se envía con lo guardado: así se cumple aunque la página del alumno no lo haga (pestaña congelada, trampas).
 */
export function registrarEvento(
  db: Database.Database,
  intentoId: number,
  alumnoId: number,
  tipo: TipoEventoIntegridad,
  detalle = '',
  ultimo?: { respuestas?: Record<string, string>; tiempo_activo_seg?: number }
): { salidas: number; cerrado: boolean } {
  const i = intentoDelAlumno(db, intentoId, alumnoId)
  if (i.estado === 'enviado' || i.estado === 'calificado') return { salidas: 0, cerrado: true }
  // Ese evento solo lo escribe el servidor
  if (tipo === 'cerrado_por_salidas') tipo = 'salio_pestana'
  db.prepare('INSERT INTO eventos_integridad (intento_id, tipo, detalle) VALUES (?, ?, ?)').run(intentoId, tipo, detalle.slice(0, 300))
  const salidas = salidasContadas(db, intentoId)
  const a = obtenerAsignacion(db, i.asignacion_id)
  if (!a.vigilancia || !a.cerrar_al_salir || salidas < SALIDAS_PARA_CERRAR) return { salidas, cerrado: false }
  // El evento que cierra trae lo último contestado: se guarda antes de calificar (el autoguardado pudo no llegar)
  if (ultimo?.respuestas && typeof ultimo.respuestas === 'object') {
    try {
      guardarRespuestas(db, intentoId, alumnoId, ultimo.respuestas, Number(ultimo.tiempo_activo_seg ?? 0))
    } catch {
      /* fuera de tiempo o ya cerrada: se califica con lo que había */
    }
  }
  const actual = intentoDelAlumno(db, intentoId, alumnoId)
  db.prepare('INSERT INTO eventos_integridad (intento_id, tipo, detalle) VALUES (?, ?, ?)').run(intentoId, 'cerrado_por_salidas', `${salidas} salidas`)
  cerrarYCalificar(db, actual, a, undefined, 'salidas')
  return { salidas, cerrado: true }
}

/**
 * Envía la entrega. Si el tiempo o la fecha límite ya pasaron se cierra con lo último que se
 * guardó en vez de rechazarla: el alumno no pierde lo contestado y el docente la puede calificar.
 * Un segundo envío (p. ej. el reintento del celular) devuelve la entrega ya enviada.
 */
export function enviarIntento(db: Database.Database, intentoId: number, alumnoId: number, tiempoActivoSeg?: number): Intento {
  const i = intentoDelAlumno(db, intentoId, alumnoId)
  if (i.estado === 'enviado' || i.estado === 'calificado') return i
  const a = obtenerAsignacion(db, i.asignacion_id)
  const v = ventana(a, i)
  if (!v.abierta && !vencido(a, i)) throw new ErrorHttp(400, v.motivo ?? 'La actividad está cerrada.')
  // Candado: con preguntas en blanco no se envía, salvo que ya se acabó el tiempo o se cierra por salidas
  if (a.todas_obligatorias && !vencido(a, i) && !(a.cerrar_al_salir && salidasContadas(db, intentoId) >= SALIDAS_PARA_CERRAR)) {
    const faltan = sinContestar(db, a, i)
    if (faltan.length) throw new ErrorHttp(400, `Te ${faltan.length === 1 ? 'falta 1 pregunta' : `faltan ${faltan.length} preguntas`} por contestar (${faltan.join(', ')}). Contesta todas para poder enviar.`)
  }
  cerrarYCalificar(db, i, a, tiempoActivoSeg)
  return intentoDelAlumno(db, intentoId, alumnoId)
}

/** Números (como los ve el alumno) de las preguntas que dejó en blanco */
function sinContestar(db: Database.Database, a: Asignacion, i: Intento): number[] {
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
  const c = leerContenido(ev.contenido)
  if (!c) return []
  const suyo = delIntento(c, leerSeleccion(i.seleccion), i.respuestas)
  return suyo.contenido.preguntas.flatMap((_, pos) => ((suyo.respuestas[String(pos)] ?? '').trim() ? [] : [pos + 1]))
}

/** Ya se le acabó el tiempo al intento o pasó la fecha límite de la actividad. */
function vencido(a: Asignacion, i: Intento, ahora = new Date()): boolean {
  if (a.cierra && aFecha(a.cierra) < ahora) return true
  return Boolean(a.duracion_min) && ahora.getTime() > aFecha(i.iniciado_en).getTime() + a.duracion_min! * 60000 + GRACIA_MS
}

/**
 * Cierra y califica con lo guardado los intentos que siguen abiertos aunque ya vencieron
 * (el celular se apagó, perdió la red o el alumno cerró la pestaña). Se llama al leer.
 */
export function cerrarVencidos(db: Database.Database, ahora = new Date()): number {
  const abiertos = db
    .prepare(
      `SELECT i.id FROM intentos i JOIN asignaciones a ON a.id = i.asignacion_id
       WHERE i.estado IN ('en_curso', 'borrador') AND (a.duracion_min > 0 OR a.cierra IS NOT NULL)`
    )
    .all() as { id: number }[]
  let cerrados = 0
  for (const { id } of abiertos) {
    const i = leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(id) as Fila)!
    const a = obtenerAsignacion(db, i.asignacion_id)
    if (!vencido(a, i, ahora)) continue
    cerrarYCalificar(db, i, a, undefined, true)
    cerrados++
  }
  return cerrados
}

/** El tiempo activo lo reporta el celular: no puede pasar del tiempo transcurrido desde que empezó (+1 min de margen). */
function tiempoCreible(i: Intento, segundos: number | undefined): number {
  const transcurrido = Math.floor((Date.now() - aFecha(i.iniciado_en).getTime()) / 1000) + 60
  return Math.min(Math.max(0, Math.floor(Number(segundos) || 0)), Math.max(0, transcurrido))
}

function cerrarYCalificar(db: Database.Database, i: Intento, a: Asignacion, tiempoActivoSeg?: number, automatico: boolean | 'salidas' = false): void {
  const intentoId = i.id
  const alumnoId = i.alumno_id
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
  const contenido = leerContenido(ev.contenido)
  // Sobre las preguntas que le tocaron (con preguntas al azar, solo su sorteo)
  const suyo = contenido ? delIntento(contenido, leerSeleccion(i.seleccion), i.respuestas) : null
  const resultado = suyo ? calificarAutomatico(suyo.contenido, suyo.respuestas) : { puntaje_auto: 0, pendiente_manual: true, puntos_auto_posibles: 0, detalle: [] }
  const puntaje = resultado.pendiente_manual ? null : resultado.puntaje_auto
  db.prepare(
    `UPDATE intentos SET estado = 'enviado', enviado_en = datetime('now'), ultima_actividad = datetime('now'),
     tiempo_activo_seg = MAX(tiempo_activo_seg, ?), puntaje_auto = ?, puntaje = ?, pendiente_manual = ?, calificado_en = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
     WHERE id = ?`
  ).run(tiempoCreible(i, tiempoActivoSeg ?? i.tiempo_activo_seg), resultado.puntaje_auto, puntaje, resultado.pendiente_manual ? 1 : 0, puntaje, intentoId)
  if (puntaje !== null) db.prepare("UPDATE intentos SET estado = 'calificado' WHERE id = ?").run(intentoId)

  const alumno = db.prepare('SELECT nombre, apellidos FROM alumnos WHERE id = ?').get(alumnoId) as { nombre: string; apellidos: string }
  notificarDocentes(db, a.materia_id, {
    tipo: 'entrega',
    titulo: `${alumno.apellidos} ${alumno.nombre} entregó: ${a.titulo}`,
    cuerpo:
      (automatico === 'salidas' ? 'Cerrada por salir dos veces del examen · ' : automatico ? 'Cerrada al vencer el tiempo con lo que tenía guardado · ' : '') +
      (puntaje !== null ? `${a.materia_nombre} · ${puntaje} de ${a.puntos_totales} pts (automático)` : `${a.materia_nombre} · pendiente de calificar a mano`),
    ref_tipo: 'intento',
    ref_id: intentoId
  })
}

/** Entregas del alumno, ya filtradas con `vistaParaAlumno`. */
export function calificacionesDeAlumno(db: Database.Database, alumnoId: number): (Intento & { titulo: string; materia_nombre: string; materia_color: string; puntos_totales: number; mostrar_resultado: number; ponderacion: number })[] {
  cerrarVencidos(db)
  return (
    db
      .prepare(
        `SELECT i.*, a.titulo, a.mostrar_resultado, a.ponderacion, m.nombre AS materia_nombre, m.color AS materia_color, e.puntos_totales
         FROM intentos i JOIN asignaciones a ON a.id = i.asignacion_id JOIN materias m ON m.id = a.materia_id JOIN evaluaciones e ON e.id = a.evaluacion_id
         WHERE i.alumno_id = ? AND i.estado IN ('enviado', 'calificado') ORDER BY i.enviado_en DESC`
      )
      .all(alumnoId) as Fila[]
  ).map((f) =>
    vistaParaAlumno(
      { ...(leerIntento(f) as Intento), titulo: f.titulo as string, materia_nombre: f.materia_nombre as string, materia_color: f.materia_color as string, puntos_totales: f.puntos_totales as number, mostrar_resultado: f.mostrar_resultado as number, ponderacion: Number(f.ponderacion) || 0 },
      { mostrar_resultado: f.mostrar_resultado as number }
    )
  )
}

// ---------------- Archivos ----------------

export const MAX_ARCHIVOS_POR_INTENTO = 5

/**
 * Revisa que el alumno pueda subir archivos a ese intento. Se llama ANTES de que multer escriba
 * en disco: así un intento ajeno, inexistente o cerrado no deja archivos huérfanos.
 */
export function validarSubida(db: Database.Database, intentoId: number, alumnoId: number): void {
  const i = intentoDelAlumno(db, intentoId, alumnoId)
  if (i.estado === 'enviado' || i.estado === 'calificado') throw new ErrorHttp(400, 'La entrega ya fue enviada.')
  const a = obtenerAsignacion(db, i.asignacion_id)
  if (!a.permite_archivos) throw new ErrorHttp(400, 'Esta actividad no admite archivos.')
  const v = ventana(a, i)
  if (!v.abierta) throw new ErrorHttp(400, v.motivo ?? 'La actividad está cerrada.')
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM archivos_entrega WHERE intento_id = ?').get(intentoId) as { n: number }
  if (n >= MAX_ARCHIVOS_POR_INTENTO) throw new ErrorHttp(400, `Ya subiste el máximo de ${MAX_ARCHIVOS_POR_INTENTO} archivos. Borra uno para subir otro.`)
}

export function registrarArchivo(db: Database.Database, intentoId: number, alumnoId: number, nombre: string, ruta: string, mime: string, tamano: number): ArchivoEntrega {
  validarSubida(db, intentoId, alumnoId)
  const id = Number(db.prepare('INSERT INTO archivos_entrega (intento_id, nombre, ruta, mime, tamano) VALUES (?,?,?,?,?)').run(intentoId, nombre, ruta, mime, tamano).lastInsertRowid)
  return db.prepare('SELECT id, intento_id, nombre, mime, tamano, subido_en FROM archivos_entrega WHERE id = ?').get(id) as ArchivoEntrega
}

export function archivosDeIntento(db: Database.Database, intentoId: number): ArchivoEntrega[] {
  return db.prepare('SELECT id, intento_id, nombre, mime, tamano, subido_en FROM archivos_entrega WHERE intento_id = ? ORDER BY id').all(intentoId) as ArchivoEntrega[]
}

export function rutaDeArchivo(db: Database.Database, archivoId: number): { ruta: string; nombre: string; mime: string; intento_id: number; alumno_id: number } {
  const f = db.prepare('SELECT ar.ruta, ar.nombre, ar.mime, ar.intento_id, i.alumno_id FROM archivos_entrega ar JOIN intentos i ON i.id = ar.intento_id WHERE ar.id = ?').get(archivoId) as
    | { ruta: string; nombre: string; mime: string; intento_id: number; alumno_id: number }
    | undefined
  if (!f) throw new ErrorHttp(404, 'Archivo no encontrado.')
  return f
}

export function eliminarArchivo(db: Database.Database, archivoId: number, alumnoId: number): string {
  const f = rutaDeArchivo(db, archivoId)
  if (f.alumno_id !== alumnoId) throw new ErrorHttp(403, 'No es tu archivo.')
  const i = intentoDelAlumno(db, f.intento_id, alumnoId)
  if (i.estado === 'enviado' || i.estado === 'calificado') throw new ErrorHttp(400, 'La entrega ya fue enviada.')
  db.prepare('DELETE FROM archivos_entrega WHERE id = ?').run(archivoId)
  return f.ruta
}

// ---------------- Vista del docente ----------------

export interface FiltroEntregas {
  materia_id?: number
  /** Solo las materias de este docente (sin él, todas: el principal). */
  docente_id?: number
  desde?: string
  hasta?: string
}

export function asignacionesConResumen(db: Database.Database, filtro: FiltroEntregas = {}): ResumenEntregas[] {
  cerrarVencidos(db)
  const condiciones: string[] = []
  const params: unknown[] = []
  if (filtro.materia_id) {
    condiciones.push('a.materia_id = ?')
    params.push(filtro.materia_id)
  }
  if (filtro.docente_id) {
    condiciones.push('m.docente_id = ?')
    params.push(filtro.docente_id)
  }
  // Los días del filtro son de Ciudad de México y publicada_en está en UTC: sin convertir, lo publicado
  // entre las 18:00 y las 23:59 caía en el día siguiente, en pantalla y en el Excel
  if (filtro.desde) {
    condiciones.push('a.publicada_en >= ?')
    params.push(aAlmacen(`${filtro.desde}T00:00:00${DESFASE_MX}`))
  }
  if (filtro.hasta) {
    condiciones.push('a.publicada_en <= ?')
    params.push(aAlmacen(`${filtro.hasta}T23:59:59${DESFASE_MX}`))
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''
  const filas = db.prepare(`${SELECT_ASIGNACION} ${where} ORDER BY a.publicada_en DESC`).all(...params) as Asignacion[]
  const resumen = db.prepare(
    `SELECT
       CASE WHEN EXISTS (SELECT 1 FROM asignacion_alumnos WHERE asignacion_id = ?) THEN (SELECT COUNT(*) FROM asignacion_alumnos WHERE asignacion_id = ?)
            ELSE (SELECT COUNT(*) FROM inscripciones WHERE materia_id = ?) END AS inscritos,
       (SELECT COUNT(*) FROM intentos WHERE asignacion_id = ? AND estado IN ('enviado','calificado')) AS entregados,
       (SELECT COUNT(*) FROM intentos WHERE asignacion_id = ? AND pendiente_manual = 1 AND estado = 'enviado') AS pendientes_manual,
       (SELECT AVG(puntaje) FROM intentos WHERE asignacion_id = ? AND puntaje IS NOT NULL) AS promedio`
  )
  return filas.map((fila) => {
    const a = conPuntosAzar(db, fila)
    const r = resumen.get(a.id, a.id, a.materia_id, a.id, a.id, a.id) as { inscritos: number; entregados: number; pendientes_manual: number; promedio: number | null }
    return { asignacion: a, inscritos: r.inscritos, entregados: r.entregados, pendientes_manual: r.pendientes_manual, promedio: r.promedio === null ? null : Math.round(r.promedio * 100) / 100 }
  })
}

/** Todos los inscritos de la materia con su intento (o sin él), para la tabla de entregas. */
export function entregasDeAsignacion(db: Database.Database, asignacionId: number): (Intento | { alumno_id: number; estado: 'sin_iniciar' })[] & { asignacion?: Asignacion } {
  cerrarVencidos(db)
  const a = obtenerAsignacion(db, asignacionId)
  const inscritos = db
    .prepare('SELECT al.id, al.matricula, al.nombre, al.apellidos FROM alumnos al JOIN inscripciones i ON i.alumno_id = al.id WHERE i.materia_id = ? ORDER BY al.apellidos, al.nombre')
    .all(a.materia_id)
    // Con destinatarios, solo ellos
    .filter((al) => !a.para?.length || a.para.includes((al as { id: number }).id)) as { id: number; matricula: string; nombre: string; apellidos: string }[]
  const intentoDe = db.prepare(
    // «Eventos» son alertas: no cuentan los regresos ni lo que el navegador marcó como que no es salida
    `SELECT i.*, (SELECT COUNT(*) FROM eventos_integridad e WHERE e.intento_id = i.id
        AND e.tipo NOT IN ('volvio_pestana', 'recupero_foco', 'volvio_pantalla_completa', 'mouse_volvio')
        AND e.detalle NOT IN (${DETALLE_NO_CUENTA.map((t) => `'${t}'`).join(', ')})) AS eventos,
       (SELECT e.tipo FROM eventos_integridad e WHERE e.intento_id = i.id
          AND e.tipo IN ('salio_pestana', 'perdio_foco', 'salio_pantalla_completa', 'mouse_fuera', 'volvio_pestana', 'recupero_foco', 'volvio_pantalla_completa', 'mouse_volvio')
          AND e.detalle <> 'al entrar a pantalla completa'
        ORDER BY e.id DESC LIMIT 1) AS ultimo_evento
     FROM intentos i WHERE i.asignacion_id = ? AND i.alumno_id = ?`
  )
  return inscritos.map((al) => {
    const f = intentoDe.get(asignacionId, al.id) as Fila | undefined
    const base = { alumno_id: al.id, alumno_nombre: `${al.apellidos} ${al.nombre}`.trim(), alumno_matricula: al.matricula }
    if (!f) return { ...base, estado: 'sin_iniciar' as const } as unknown as Intento
    const enCurso = f.estado === 'en_curso' || f.estado === 'borrador'
    // «Fuera»: lo último que se supo es que salió de la pantalla del examen (y sigue sin enviar)
    const fuera = enCurso && ['salio_pestana', 'perdio_foco', 'salio_pantalla_completa', 'mouse_fuera'].includes(String(f.ultimo_evento ?? ''))
    const { ultimo_evento: _u, ...resto } = f
    return { ...(leerIntento(resto as Fila) as Intento), ...base, eventos: f.eventos as number, fuera }
  })
}

const indiceEnOpciones = (p: Pregunta, texto: string): number =>
  p.tipo === 'verdadero_falso' ? indiceVerdaderoFalso(texto) : p.tipo === 'opcion_multiple' ? indiceDeOpcion(p.opciones ?? [], texto) : -1

/** Opciones tal como las ve el alumno: verdadero/falso se presenta como dos opciones. */
const opcionesDe = (p: { tipo: string; opciones?: string[] }): string[] => (p.tipo === 'verdadero_falso' ? ['Verdadero', 'Falso'] : p.opciones ?? [])

export interface IntentoDetallado extends Intento {
  asignacion: Asignacion
  preguntas: { indice: number; tipo: string; enunciado: string; opciones: string[]; respuesta_correcta: string; explicacion: string; puntos: number; respuesta_alumno: string; indice_correcto: number; indice_alumno: number; correcta: boolean | null; automatica: boolean; lenguaje?: string; cuaderno?: string }[]
  eventos_lista: EventoIntegridad[]
  archivos: ArchivoEntrega[]
}

export function intentoDetallado(db: Database.Database, intentoId: number): IntentoDetallado {
  cerrarVencidos(db)
  const i = leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(intentoId) as Fila | undefined)
  if (!i) throw new ErrorHttp(404, 'Intento no encontrado.')
  const a = obtenerAsignacion(db, i.asignacion_id)
  const al = db.prepare('SELECT matricula, nombre, apellidos FROM alumnos WHERE id = ?').get(i.alumno_id) as { matricula: string; nombre: string; apellidos: string }
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
  const original = leerContenido(ev.contenido)
  // El examen como lo vio este alumno (con preguntas al azar, su sorteo en su orden)
  const suyo = original ? delIntento(original, leerSeleccion(i.seleccion), i.respuestas) : null
  const contenido = suyo?.contenido ?? null
  const respuestasSuyas = suyo?.respuestas ?? {}
  const cal = contenido ? calificarAutomatico(contenido, respuestasSuyas) : null
  const preguntas = (contenido?.preguntas ?? []).map((p, indice) => ({
    indice,
    tipo: p.tipo,
    enunciado: p.enunciado,
    opciones: opcionesDe(p),
    respuesta_correcta: p.respuesta,
    explicacion: p.explicacion,
    puntos: p.puntos,
    respuesta_alumno: respuestasSuyas[String(indice)] ?? '',
    // Con la misma regla que califica: así la pantalla del docente resalta exactamente lo que se calificó
    indice_correcto: indiceEnOpciones(p, p.respuesta),
    indice_alumno: indiceEnOpciones(p, respuestasSuyas[String(indice)] ?? ''),
    correcta: cal?.detalle[indice]?.correcta ?? null,
    automatica: cal?.detalle[indice]?.automatica ?? false,
    ...(p.tipo === 'codigo' ? { lenguaje: lenguajeDePregunta(p) } : {}),
    // El original: si el alumno no lo tocó, el docente ve con qué empezó
    ...(p.tipo === 'cuaderno' ? { cuaderno: p.cuaderno ?? '' } : {})
  }))
  return {
    ...i,
    alumno_nombre: `${al.apellidos} ${al.nombre}`.trim(),
    alumno_matricula: al.matricula,
    asignacion: a,
    preguntas,
    eventos_lista: db.prepare('SELECT * FROM eventos_integridad WHERE intento_id = ? ORDER BY en').all(intentoId) as EventoIntegridad[],
    archivos: archivosDeIntento(db, intentoId)
  }
}

export function calificarIntento(db: Database.Database, intentoId: number, puntaje: number, retro: string): Intento {
  cerrarVencidos(db)
  const i = leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(intentoId) as Fila | undefined)
  if (!i) throw new ErrorHttp(404, 'Intento no encontrado.')
  if (i.estado === 'en_curso' || i.estado === 'borrador') throw new ErrorHttp(400, 'El alumno aún no envía esta entrega.')
  const a = obtenerAsignacion(db, i.asignacion_id)
  // Con preguntas al azar, el tope es lo que vale su propio sorteo
  let tope = a.puntos_totales ?? Infinity
  const sel = leerSeleccion(i.seleccion)
  if (sel) {
    const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(a.evaluacion_id) as { contenido: string }
    const c = leerContenido(ev.contenido)
    if (c) tope = Math.round(delIntento(c, sel, {}).contenido.preguntas.reduce((t, p) => t + (p.puntos || 0), 0) * 100) / 100
  }
  if (puntaje < 0 || puntaje > tope + 0.001) throw new ErrorHttp(400, `El puntaje debe estar entre 0 y ${tope}.`)
  db.prepare("UPDATE intentos SET puntaje = ?, retro = ?, pendiente_manual = 0, estado = 'calificado', calificado_en = datetime('now') WHERE id = ?").run(puntaje, retro.slice(0, 4000), intentoId)
  const usuario = db.prepare('SELECT id FROM usuarios WHERE alumno_id = ?').get(i.alumno_id) as { id: number } | undefined
  if (usuario) {
    crearNotificacion(db, usuario.id, {
      tipo: 'calificacion',
      titulo: `Calificación: ${a.titulo}`,
      cuerpo: a.mostrar_resultado ? `${puntaje} de ${a.puntos_totales} pts${retro ? ' · ' + retro.slice(0, 120) : ''}` : 'Tu entrega fue revisada.',
      ref_tipo: 'intento',
      ref_id: intentoId
    })
  }
  return leerIntento(db.prepare('SELECT * FROM intentos WHERE id = ?').get(intentoId) as Fila)!
}

/** Filas planas para exportar: una por alumno y asignación, con tiempo, eventos y puntaje. */
export function filasParaExportar(db: Database.Database, filtro: FiltroEntregas = {}): Record<string, string | number | null>[] {
  const resumenes = asignacionesConResumen(db, filtro)
  const filas: Record<string, string | number | null>[] = []
  for (const r of resumenes) {
    for (const e of entregasDeAsignacion(db, r.asignacion.id)) {
      const i = e as Intento & { alumno_nombre?: string; alumno_matricula?: string; eventos?: number }
      filas.push({
        materia: r.asignacion.materia_nombre ?? '',
        actividad: r.asignacion.titulo,
        tipo: r.asignacion.tipo,
        publicada: r.asignacion.publicada_en,
        matricula: i.alumno_matricula ?? '',
        alumno: i.alumno_nombre ?? '',
        estado: i.estado,
        iniciado: i.iniciado_en ?? null,
        enviado: i.enviado_en ?? null,
        minutos_activo: i.tiempo_activo_seg != null ? Math.round(i.tiempo_activo_seg / 60) : null,
        eventos_integridad: i.eventos ?? 0,
        puntaje: i.puntaje ?? null,
        puntos_totales: r.asignacion.puntos_totales ?? null,
        retro: i.retro ?? ''
      })
    }
  }
  return filas
}

// ---------------- Notificaciones ----------------

export interface NuevaNotificacion {
  tipo: string
  titulo: string
  cuerpo: string
  ref_tipo: string
  ref_id: number | null
}

/** Quien quiera enterarse de cada aviso nuevo (las notificaciones push). */
const escuchas: ((usuarioId: number, n: NuevaNotificacion) => void)[] = []
export const escucharNotificaciones = (f: (usuarioId: number, n: NuevaNotificacion) => void): void => void escuchas.push(f)

export function crearNotificacion(db: Database.Database, usuarioId: number, n: NuevaNotificacion): void {
  db.prepare('INSERT INTO notificaciones (usuario_id, tipo, titulo, cuerpo, ref_tipo, ref_id) VALUES (?,?,?,?,?,?)').run(usuarioId, n.tipo, n.titulo, n.cuerpo, n.ref_tipo, n.ref_id)
  for (const f of escuchas) f(usuarioId, n)
}

function notificarInscritos(db: Database.Database, materiaId: number, soloAlumnos: number[] | null, n: NuevaNotificacion): void {
  const todos = db.prepare('SELECT u.id, u.alumno_id FROM usuarios u JOIN inscripciones i ON i.alumno_id = u.alumno_id WHERE i.materia_id = ? AND u.activo = 1').all(materiaId) as { id: number; alumno_id: number }[]
  const usuarios = soloAlumnos ? todos.filter((u) => soloAlumnos.includes(u.alumno_id)) : todos
  const tx = db.transaction(() => usuarios.forEach((u) => crearNotificacion(db, u.id, n)))
  tx()
}

export function notificarDocentes(db: Database.Database, materiaId: number, n: NuevaNotificacion): void {
  // Una materia sin dueño es del principal: el aviso (con nombre y puntaje del alumno) no llega a los demás docentes
  const m = db.prepare('SELECT docente_id FROM materias WHERE id = ?').get(materiaId) as { docente_id: number | null } | undefined
  const dueno = m?.docente_id ?? docentePrincipalId(db)
  const docentes = dueno ? [{ id: dueno }] : (db.prepare("SELECT id FROM usuarios WHERE rol = 'docente' AND activo = 1").all() as { id: number }[])
  const tx = db.transaction(() => docentes.forEach((d) => crearNotificacion(db, d.id, n)))
  tx()
}

export function notificacionesDe(db: Database.Database, usuarioId: number, soloNoLeidas = false, limite = 50): Notificacion[] {
  return db
    .prepare(`SELECT * FROM notificaciones WHERE usuario_id = ? ${soloNoLeidas ? 'AND leida = 0' : ''} ORDER BY creada DESC LIMIT ?`)
    .all(usuarioId, limite) as Notificacion[]
}

export function marcarLeidas(db: Database.Database, usuarioId: number, ids?: number[]): number {
  if (ids !== undefined && ids !== null && !Array.isArray(ids)) throw new ErrorHttp(400, 'ids debe ser una lista.')
  if (ids && ids.length) {
    const marcar = db.prepare('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ? AND id = ?')
    return db.transaction(() => ids.reduce((n, id) => n + marcar.run(usuarioId, id).changes, 0))()
  }
  return db.prepare('UPDATE notificaciones SET leida = 1 WHERE usuario_id = ? AND leida = 0').run(usuarioId).changes
}

// ---------- «¿Olvidaste tu contraseña?» ----------

/** Peticiones por IP en la última hora: frena a quien quiera llenar de avisos al docente. */
const pedidosRestaurar = new Map<string, number[]>()

/**
 * El alumno pide restaurar su contraseña: no se cambia nada, se avisa a sus docentes y ellos la restauran
 * con un clic (vuelve a ser su matrícula). Así nadie cambia la contraseña de otro solo con saber su matrícula.
 * Siempre responde igual, exista o no el usuario, para no revelar quién tiene cuenta.
 */
export function pedirRestaurar(db: Database.Database, texto: string, ip: string): void {
  const ahora = Date.now()
  const recientes = (pedidosRestaurar.get(ip) ?? []).filter((t) => ahora - t < 3600_000)
  if (recientes.length >= 5) throw new ErrorHttp(429, 'Ya pediste varias veces. Espera un rato o avísale a tu docente en clase.')
  pedidosRestaurar.set(ip, [...recientes, ahora])
  const u = buscarUsuarioPorNombre(db, texto.trim())
  if (!u || u.rol !== 'alumno' || !u.activo || !u.alumno_id) return
  // Un aviso pendiente por alumno basta
  if (db.prepare("SELECT 1 FROM notificaciones WHERE ref_tipo = 'restaurar' AND ref_id = ? AND leida = 0").get(u.alumno_id)) return
  const a = db.prepare('SELECT nombre, apellidos, matricula FROM alumnos WHERE id = ?').get(u.alumno_id) as { nombre: string; apellidos: string; matricula: string }
  const duenos = new Set<number>()
  for (const m of db.prepare('SELECT m.docente_id FROM materias m JOIN inscripciones i ON i.materia_id = m.id WHERE i.alumno_id = ?').all(u.alumno_id) as { docente_id: number | null }[]) {
    const d = m.docente_id ?? docentePrincipalId(db)
    if (d) duenos.add(d)
  }
  for (const d of duenos) {
    crearNotificacion(db, d, {
      tipo: 'acceso',
      titulo: `${a.apellidos} ${a.nombre} pide restaurar su contraseña`,
      cuerpo: `Usuario ${u.usuario}. ${a.matricula ? 'Al restaurarla vuelve a ser su matrícula' : 'Al restaurarla verás la contraseña nueva para dársela'} y la cambia al entrar.`,
      ref_tipo: 'restaurar',
      ref_id: u.alumno_id
    })
  }
}
