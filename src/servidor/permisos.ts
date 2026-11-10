import type Database from 'better-sqlite3'
import { ErrorHttp } from './auth'
import { leerAjuste } from './base'

/**
 * Aislamiento entre docentes. Cada materia es de un docente (`materias.docente_id`).
 *
 * El docente principal administra la base: es la cuenta que configura la app de escritorio
 * (ajuste `portal_docente_usuario`) o, en un servidor sin ese ajuste, el primer docente dado de alta.
 * Ve y maneja todas las materias, incluidas las que aún no tienen dueño (las que se crean en la app).
 * Cualquier otro docente solo ve y toca las materias cuyo `docente_id` es el suyo.
 */
export function docentePrincipalId(db: Database.Database): number | null {
  const usuario = leerAjuste(db, 'portal_docente_usuario').trim()
  if (usuario) {
    const f = db.prepare("SELECT id FROM usuarios WHERE usuario = ? COLLATE NOCASE AND rol = 'docente' AND activo = 1").get(usuario) as { id: number } | undefined
    return f?.id ?? null
  }
  const primero = db.prepare("SELECT id FROM usuarios WHERE rol = 'docente' AND activo = 1 ORDER BY id LIMIT 1").get() as { id: number } | undefined
  return primero?.id ?? null
}

export const esPrincipal = (db: Database.Database, docenteId: number): boolean => docentePrincipalId(db) === docenteId

/** Para filtrar listados: undefined = todas las materias (principal); un id = solo las de ese docente. */
export function alcanceDe(db: Database.Database, docenteId: number): number | undefined {
  return esPrincipal(db, docenteId) ? undefined : docenteId
}

export type Recurso = 'materia' | 'evaluacion' | 'asignacion' | 'intento' | 'archivo' | 'partida' | 'alumno'

/** Cómo llegar del recurso a la materia (y a su dueño). La partida se identifica por su PIN. */
const DUENO_DE: Record<Exclude<Recurso, 'alumno'>, string> = {
  materia: 'SELECT m.docente_id FROM materias m WHERE m.id = ?',
  evaluacion: 'SELECT m.docente_id FROM evaluaciones e JOIN materias m ON m.id = e.materia_id WHERE e.id = ?',
  asignacion: 'SELECT m.docente_id FROM asignaciones a JOIN materias m ON m.id = a.materia_id WHERE a.id = ?',
  intento: 'SELECT m.docente_id FROM intentos i JOIN asignaciones a ON a.id = i.asignacion_id JOIN materias m ON m.id = a.materia_id WHERE i.id = ?',
  archivo:
    'SELECT m.docente_id FROM archivos_entrega ar JOIN intentos i ON i.id = ar.intento_id JOIN asignaciones a ON a.id = i.asignacion_id JOIN materias m ON m.id = a.materia_id WHERE ar.id = ?',
  partida: 'SELECT m.docente_id FROM partidas p JOIN evaluaciones e ON e.id = p.evaluacion_id JOIN materias m ON m.id = e.materia_id WHERE p.pin = ?'
}

/** ¿El docente puede ver y manejar este recurso? */
export function tieneAcceso(db: Database.Database, docenteId: number, recurso: Recurso, id: number | string): boolean {
  if (esPrincipal(db, docenteId)) return true
  if (recurso === 'alumno') {
    // Un alumno es "suyo" si está inscrito en alguna de sus materias
    return Boolean(db.prepare('SELECT 1 FROM inscripciones i JOIN materias m ON m.id = i.materia_id WHERE i.alumno_id = ? AND m.docente_id = ?').get(id, docenteId))
  }
  const f = db.prepare(DUENO_DE[recurso]).get(id) as { docente_id: number | null } | undefined
  return f?.docente_id === docenteId
}

/**
 * Lanza 404 si el recurso no existe o es de otro docente: así no se revela que existe.
 * Es la verificación central que usan todas las rutas /api/docente/* y los sockets del anfitrión.
 */
export function exigirAcceso(db: Database.Database, docenteId: number, recurso: Recurso, id: number | string): void {
  if (!tieneAcceso(db, docenteId, recurso, id)) throw new ErrorHttp(404, 'No existe o no es de tus materias.')
}

/**
 * Un alumno que también está en materias de otro docente solo lo puede modificar el principal
 * (reiniciar su contraseña, cambiar su nombre): si no, bastaría inscribir una matrícula ajena para tomar su cuenta.
 */
export function alumnoSoloDe(db: Database.Database, docenteId: number, alumnoId: number): boolean {
  if (esPrincipal(db, docenteId)) return true
  return !db.prepare('SELECT 1 FROM inscripciones i JOIN materias m ON m.id = i.materia_id WHERE i.alumno_id = ? AND (m.docente_id IS NULL OR m.docente_id <> ?)').get(alumnoId, docenteId)
}
