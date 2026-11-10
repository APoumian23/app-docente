/**
 * Pase de lista desde el panel web (celular): las mismas reglas que la app de escritorio
 * (src/main/ipc/index.ts, «asistencia:*»). Con el portal en línea lo marcado aquí llega a la Mac
 * en la siguiente sincronización.
 *
 * Las filas nuevas usan `idNuevo()`: la Mac también crea asistencias y con AUTOINCREMENT chocarían.
 */
import type Database from 'better-sqlite3'
import { hoyMx } from '../main/calificacion'
import type { EstadoAsistencia } from '../shared/types'
import { ErrorHttp } from './auth'
import { idNuevo } from './cambios'

type DB = Database.Database

export const ESTADOS: EstadoAsistencia[] = ['presente', 'retardo', 'ausente', 'justificado']

export interface SesionLista {
  id: number
  numero: number
  semana: number
  fecha: string
  hora_inicio: string
  hora_fin: string
  tema: string
  estado: string
  marcados: number
  inscritos: number
}

export interface RegistroLista {
  alumno_id: number
  matricula: string
  nombre: string
  apellidos: string
  /** Su carrera: en un grupo con varias carreras (Álgebra) se distingue y se filtra por ella */
  carrera_id: number | null
  carrera_clave: string
  carrera_nombre: string
  carrera_color: string
  estado: EstadoAsistencia | null
  hora: string
  nota: string
}

const horaMx = (): string => new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })

/** Materia de la sesión (para revisar permisos antes de tocar nada). */
export function materiaDeSesion(db: DB, sesionId: number): number {
  const s = db.prepare('SELECT materia_id FROM sesiones WHERE id = ?').get(sesionId) as { materia_id: number } | undefined
  if (!s) throw new ErrorHttp(404, 'Esa clase no existe.')
  return s.materia_id
}

/** Clases hasta hoy (la más reciente primero) y las de la próxima semana, con cuántos tienen registro. */
export function sesionesDeMateria(db: DB, materiaId: number, hoy = hoyMx()): SesionLista[] {
  const limite = new Date(Date.parse(`${hoy}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
  return db
    .prepare(
      `SELECT s.id, s.numero, s.semana, s.fecha, s.hora_inicio, s.hora_fin, s.tema, s.estado,
         (SELECT COUNT(*) FROM asistencias a JOIN alumnos al ON al.id = a.alumno_id JOIN inscripciones i ON i.alumno_id = al.id AND i.materia_id = s.materia_id
          WHERE a.sesion_id = s.id AND al.activo = 1) AS marcados,
         (SELECT COUNT(*) FROM inscripciones i JOIN alumnos al ON al.id = i.alumno_id WHERE i.materia_id = s.materia_id AND al.activo = 1) AS inscritos
       FROM sesiones s WHERE s.materia_id = ? AND s.fecha <= ? ORDER BY s.fecha DESC, s.hora_inicio DESC, s.id DESC`
    )
    .all(materiaId, limite) as SesionLista[]
}

/** Lista de la clase: los alumnos activos inscritos con lo que tengan registrado. */
export function listaDeSesion(db: DB, sesionId: number): { sesion: SesionLista; registros: RegistroLista[] } {
  const materiaId = materiaDeSesion(db, sesionId)
  const sesion = sesionesDeMateria(db, materiaId, '9999-12-31').find((s) => s.id === sesionId)!
  const registros = db
    .prepare(
      `SELECT al.id AS alumno_id, al.matricula, al.nombre, al.apellidos, al.carrera_id, COALESCE(c.clave, '') AS carrera_clave, COALESCE(c.nombre, '') AS carrera_nombre,
         COALESCE(c.color, '') AS carrera_color, a.estado, COALESCE(a.hora, '') AS hora, COALESCE(a.nota, '') AS nota
       FROM inscripciones i JOIN alumnos al ON al.id = i.alumno_id
       LEFT JOIN carreras c ON c.id = al.carrera_id
       LEFT JOIN asistencias a ON a.sesion_id = ? AND a.alumno_id = al.id
       WHERE i.materia_id = ? AND al.activo = 1
       ORDER BY al.apellidos COLLATE NOCASE, al.nombre COLLATE NOCASE`
    )
    .all(sesionId, materiaId) as RegistroLista[]
  return { sesion, registros }
}

function exigirInscrito(db: DB, sesionId: number, alumnoId: number): void {
  const ok = db
    .prepare('SELECT 1 FROM sesiones s JOIN inscripciones i ON i.materia_id = s.materia_id JOIN alumnos a ON a.id = i.alumno_id WHERE s.id = ? AND i.alumno_id = ? AND a.activo = 1')
    .get(sesionId, alumnoId)
  if (!ok) throw new ErrorHttp(400, 'Ese alumno no está inscrito en esta materia.')
}

/** Marca a un alumno. Si el estado no cambia se conserva la hora de llegada (solo cambia la nota). */
export function marcar(db: DB, sesionId: number, alumnoId: number, estado: string, nota?: string): void {
  if (!ESTADOS.includes(estado as EstadoAsistencia)) throw new ErrorHttp(400, 'Estado de asistencia no válido.')
  exigirInscrito(db, sesionId, alumnoId)
  const previo = db.prepare('SELECT id, estado, nota FROM asistencias WHERE sesion_id = ? AND alumno_id = ?').get(sesionId, alumnoId) as
    | { id: number; estado: string; nota: string }
    | undefined
  if (previo) {
    db.prepare('UPDATE asistencias SET estado = ?, hora = CASE WHEN estado = ? THEN hora ELSE ? END, nota = ? WHERE id = ?').run(estado, estado, horaMx(), nota ?? previo.nota, previo.id)
  } else {
    db.prepare('INSERT INTO asistencias (id, sesion_id, alumno_id, estado, hora, nota) VALUES (?, ?, ?, ?, ?, ?)').run(idNuevo(), sesionId, alumnoId, estado, horaMx(), nota ?? '')
  }
}

/** «Todos presentes / ausentes»: solo a quien no tiene registro (nunca pisa un retardo o un justificado). */
export function marcarTodos(db: DB, sesionId: number, estado: string, carreraId?: number | null): number {
  if (estado !== 'presente' && estado !== 'ausente') throw new ErrorHttp(400, 'Solo se puede marcar a todos como presentes o ausentes.')
  // Con el filtro de carrera puesto, solo a los de esa carrera
  const faltan = listaDeSesion(db, sesionId).registros.filter((r) => r.estado === null && (carreraId === undefined || carreraId === null || r.carrera_id === carreraId))
  const ins = db.prepare('INSERT INTO asistencias (id, sesion_id, alumno_id, estado, hora) VALUES (?, ?, ?, ?, ?)')
  const hora = horaMx()
  db.transaction(() => faltan.forEach((r) => ins.run(idNuevo(), sesionId, r.alumno_id, estado, hora)))()
  return faltan.length
}

/** Justifica una falta o un retardo: queda «justificado» y el motivo se agrega a la nota. */
export function justificar(db: DB, sesionId: number, alumnoId: number, motivo: string): void {
  const texto = String(motivo ?? '').trim()
  if (!texto) throw new ErrorHttp(400, 'Escribe el motivo de la justificación.')
  exigirInscrito(db, sesionId, alumnoId)
  const previo = db.prepare('SELECT estado, nota FROM asistencias WHERE sesion_id = ? AND alumno_id = ?').get(sesionId, alumnoId) as { estado: string; nota: string } | undefined
  if (!previo) throw new ErrorHttp(400, 'Primero marca su asistencia; luego se justifica.')
  if (previo.estado === 'justificado') return
  const nota = previo.nota.trim() ? `${previo.nota.trim()} · ${texto}` : texto
  db.prepare("UPDATE asistencias SET estado = 'justificado', nota = ? WHERE sesion_id = ? AND alumno_id = ?").run(nota.slice(0, 500), sesionId, alumnoId)
}
