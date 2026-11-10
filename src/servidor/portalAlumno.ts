/**
 * Lo que el alumno ve además de sus actividades: materiales que el docente comparte, su calendario
 * (clases, exámenes y entregas), los avisos del docente y si su materia usa «Programar».
 */
import type Database from 'better-sqlite3'
import { existsSync, readdirSync } from 'fs'
import { extname, join } from 'path'
import { hoyMx } from '../main/calificacion'
import type { EventoCalendario, MaterialAlumno } from '../shared/portal'
import { ErrorHttp } from './auth'
import { PARA_ALUMNO, crearNotificacion } from './servicios'
import { tareasDeAlumno } from './tareas'

type DB = Database.Database

/** Opciones del portal que dependen de sus materias. */
export function opcionesAlumno(db: DB, alumnoId: number): { programar: boolean } {
  const r = db
    .prepare('SELECT MAX(COALESCE(m.portal_programar, 1)) AS p FROM materias m JOIN inscripciones i ON i.materia_id = m.id WHERE i.alumno_id = ? AND m.oculta = 0')
    .get(alumnoId) as { p: number | null }
  return { programar: (r.p ?? 0) === 1 }
}

// ---------- Materiales ----------

/** Carpeta donde el servidor guarda los materiales compartidos (los sube la app de escritorio). */
export const carpetaMateriales = (carpetaEntregas: string): string => join(carpetaEntregas, 'materiales')

/** Archivo del material en el servidor (`<id>.<ext>`), si ya llegó. */
function copiaEnServidor(carpetaEntregas: string, id: number): string | null {
  const dir = carpetaMateriales(carpetaEntregas)
  if (!existsSync(dir)) return null
  const f = readdirSync(dir).find((x) => x.startsWith(`${id}.`) && !x.endsWith('.parcial'))
  return f ? join(dir, f) : null
}

interface FilaMaterial {
  id: number
  materia_id: number
  titulo: string
  tipo: string
  ruta: string
  unidad: string
}

/** Cuaderno de Jupyter: se abre y se resuelve en el portal (Cuaderno.tsx) */
export const esCuaderno = (ruta: string): boolean => extname(ruta).toLowerCase() === '.ipynb'

/** Archivo para descargar: la copia que subió la app (portal en línea) o el archivo original (portal en la Mac). */
function archivoDe(carpetaEntregas: string, m: FilaMaterial): string | null {
  return copiaEnServidor(carpetaEntregas, m.id) ?? (m.ruta && existsSync(m.ruta) ? m.ruta : null)
}

export function materialesDeAlumno(db: DB, alumnoId: number, carpetaEntregas: string): MaterialAlumno[] {
  const filas = db
    .prepare(
      `SELECT x.id, x.materia_id, x.titulo, x.tipo, x.ruta, x.unidad, m.nombre AS materia_nombre, m.color AS materia_color
       FROM materiales x JOIN materias m ON m.id = x.materia_id JOIN inscripciones i ON i.materia_id = m.id
       WHERE i.alumno_id = ? AND x.compartido = 1 AND m.oculta = 0
       ORDER BY m.nombre, x.unidad, x.titulo`
    )
    .all(alumnoId) as (FilaMaterial & { materia_nombre: string; materia_color: string })[]
  const copias = new Map(
    (db.prepare("SELECT material_id, estado FROM cuadernos_alumno WHERE alumno_id = ?").all(alumnoId) as { material_id: number; estado: 'borrador' | 'entregado' }[]).map((c) => [c.material_id, c.estado])
  )
  return filas.map((f) => ({
    id: f.id,
    materia_id: f.materia_id,
    materia_nombre: f.materia_nombre,
    materia_color: f.materia_color,
    titulo: f.titulo,
    tipo: f.tipo,
    unidad: f.unidad,
    disponible: f.tipo === 'link' || archivoDe(carpetaEntregas, f) !== null,
    cuaderno: esCuaderno(f.ruta),
    cuaderno_estado: esCuaderno(f.ruta) ? (copias.get(f.id) ?? 'nuevo') : null
  }))
}

/** Material compartido de una materia del alumno: el archivo o, si es un enlace, su dirección. */
export function materialParaAlumno(db: DB, alumnoId: number, id: number, carpetaEntregas: string): { ruta: string; nombre: string } | { url: string } {
  const m = db
    .prepare(
      `SELECT x.id, x.materia_id, x.titulo, x.tipo, x.ruta, x.unidad FROM materiales x JOIN inscripciones i ON i.materia_id = x.materia_id
       WHERE x.id = ? AND i.alumno_id = ? AND x.compartido = 1`
    )
    .get(id, alumnoId) as FilaMaterial | undefined
  if (!m) throw new ErrorHttp(404, 'Ese material no está compartido contigo.')
  if (m.tipo === 'link') return { url: m.ruta }
  const ruta = archivoDe(carpetaEntregas, m)
  if (!ruta) throw new ErrorHttp(404, 'El archivo todavía no está disponible; tu docente lo acaba de compartir. Intenta en unos minutos.')
  const ext = extname(ruta)
  return { ruta, nombre: m.titulo.toLowerCase().endsWith(ext.toLowerCase()) ? m.titulo : `${m.titulo}${ext}` }
}

// ---------- Calendario ----------

const fechaHoraMx = (iso: string): { fecha: string; hora: string } => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value])
  )
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` }
}
const masDias = (dia: string, n: number): string => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** Clases, exámenes, entregas y actividades del alumno de unos días atrás a un mes adelante. */
export function calendarioDeAlumno(db: DB, alumnoId: number, hoy = hoyMx()): EventoCalendario[] {
  const desde = masDias(hoy, -3)
  const hasta = masDias(hoy, 35)
  const eventos: EventoCalendario[] = []
  const clases = db
    .prepare(
      `SELECT s.fecha, s.hora_inicio, s.hora_fin, s.numero, s.tema, m.nombre AS materia_nombre, m.color AS materia_color
       FROM sesiones s JOIN materias m ON m.id = s.materia_id JOIN inscripciones i ON i.materia_id = m.id
       WHERE i.alumno_id = ? AND m.oculta = 0 AND s.estado <> 'cancelada' AND s.fecha BETWEEN ? AND ?`
    )
    .all(alumnoId, desde, hasta) as { fecha: string; hora_inicio: string; hora_fin: string; numero: number; tema: string; materia_nombre: string; materia_color: string }[]
  for (const c of clases) {
    eventos.push({ fecha: c.fecha, hora: c.hora_inicio, tipo: 'clase', titulo: c.tema || `Clase ${c.numero}`, detalle: `${c.hora_inicio}–${c.hora_fin}`, materia_nombre: c.materia_nombre, materia_color: c.materia_color })
  }
  // Solo exámenes anunciados: los sorpresa no se avisan
  const examenes = db
    .prepare(
      `SELECT e.titulo, e.fecha_aplicacion AS fecha, m.nombre AS materia_nombre, m.color AS materia_color FROM evaluaciones e JOIN materias m ON m.id = e.materia_id
       JOIN inscripciones i ON i.materia_id = m.id WHERE i.alumno_id = ? AND m.oculta = 0 AND e.tipo = 'examen' AND e.fecha_aplicacion BETWEEN ? AND ?`
    )
    .all(alumnoId, desde, hasta) as { titulo: string; fecha: string; materia_nombre: string; materia_color: string }[]
  for (const e of examenes) eventos.push({ fecha: e.fecha, hora: '', tipo: 'examen', titulo: e.titulo, detalle: 'Examen', materia_nombre: e.materia_nombre, materia_color: e.materia_color })
  // Entregas de tareas que le faltan (las que ve en «Tareas»)
  for (const m of tareasDeAlumno(db, alumnoId)) {
    for (const t of m.tareas) {
      if (!t.vence || t.sin_fecha || (t.estado !== 'pendiente' && t.estado !== 'vencida')) continue
      const { fecha, hora } = fechaHoraMx(t.vence)
      if (fecha < desde || fecha > hasta) continue
      eventos.push({ fecha, hora, tipo: 'entrega', titulo: t.titulo, detalle: 'Entrega de tarea', materia_nombre: m.materia_nombre, materia_color: m.materia_color })
    }
  }
  // Actividades del portal (exámenes en línea) con fecha de cierre
  const actividades = db
    .prepare(
      `SELECT a.titulo, a.cierra, m.nombre AS materia_nombre, m.color AS materia_color FROM asignaciones a JOIN materias m ON m.id = a.materia_id
       JOIN inscripciones i ON i.materia_id = m.id WHERE i.alumno_id = ? AND a.activa = 1 AND a.cierra IS NOT NULL AND ${PARA_ALUMNO}`
    )
    .all(alumnoId, alumnoId) as { titulo: string; cierra: string; materia_nombre: string; materia_color: string }[]
  for (const a of actividades) {
    const { fecha, hora } = fechaHoraMx(a.cierra.includes('T') ? a.cierra : `${a.cierra.replace(' ', 'T')}Z`)
    if (fecha < desde || fecha > hasta) continue
    eventos.push({ fecha, hora, tipo: 'actividad', titulo: a.titulo, detalle: 'Cierra la actividad', materia_nombre: a.materia_nombre, materia_color: a.materia_color })
  }
  return eventos.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.hora || '99').localeCompare(b.hora || '99'))
}

// ---------- Avisos del docente ----------

/** Aviso a los alumnos de una materia (o solo a los de una carrera, en grupos mixtos). Llega a su campana. */
export function enviarAviso(db: DB, materiaId: number, titulo: string, cuerpo: string, carreraId: number | null = null): number {
  const t = titulo.trim().slice(0, 200)
  if (!t) throw new ErrorHttp(400, 'Escribe el aviso.')
  const m = db.prepare('SELECT nombre FROM materias WHERE id = ?').get(materiaId) as { nombre: string } | undefined
  if (!m) throw new ErrorHttp(404, 'Esa materia no existe.')
  const usuarios = db
    .prepare(
      `SELECT u.id FROM usuarios u JOIN inscripciones i ON i.alumno_id = u.alumno_id JOIN alumnos a ON a.id = u.alumno_id
       WHERE i.materia_id = ? AND u.activo = 1 AND a.activo = 1 AND (? IS NULL OR a.carrera_id = ?)`
    )
    .all(materiaId, carreraId, carreraId) as { id: number }[]
  db.transaction(() => usuarios.forEach((u) => crearNotificacion(db, u.id, { tipo: 'aviso', titulo: t, cuerpo: cuerpo.trim() ? `${m.nombre} · ${cuerpo.trim().slice(0, 2000)}` : m.nombre, ref_tipo: 'materia', ref_id: materiaId })))()
  return usuarios.length
}
