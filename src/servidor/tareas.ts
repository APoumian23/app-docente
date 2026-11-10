/**
 * «Subir tarea»: el alumno entrega desde el portal una tarea de Classroom de sus materias.
 * Solo se escribe en subidas_alumno / archivos_subida; Classroom nunca se toca. La app de
 * escritorio la cuenta como entregada (igual que una registrada a mano) y muestra los archivos.
 */
import type Database from 'better-sqlite3'
import { asegurarTablas, limiteDeEntrega } from '../main/services/classroom-datos'
import type { ArchivoSubida, EstadoTareaAlumno, MateriaTareasAlumno, PortalTarea, TareaAlumno } from '../shared/portal'
import { ErrorHttp } from './auth'
import { notificarDocentes } from './servicios'

type DB = Database.Database

export const MAX_ARCHIVOS_POR_TAREA = 10
const YA_ENTREGADA = new Set(['TURNED_IN', 'RETURNED'])

/** «YYYY-MM-DD HH:MM:SS» en UTC (como guarda el portal) a milisegundos */
const msDe = (texto: string): number => Date.parse(texto.includes('T') ? texto : `${texto.replace(' ', 'T')}Z`)

interface FilaTarea {
  curso_id: string
  id: string
  titulo: string
  descripcion?: string
  puntos: number | null
  vence: string | null
  creada: string | null
  enlace: string
  materiales?: string
  materia_id: number
}

/** Material de la tarea que el alumno puede abrir (archivos de Drive, enlaces, videos y formularios). */
function materialesDe(texto: string | undefined): { titulo: string; enlace: string }[] {
  try {
    const lista = JSON.parse(texto || '[]') as { titulo?: string; enlace?: string }[]
    return lista.filter((m) => m && typeof m.enlace === 'string' && /^https?:\/\//i.test(m.enlace)).map((m) => ({ titulo: String(m.titulo || m.enlace), enlace: String(m.enlace) }))
  } catch {
    return []
  }
}

/** Tareas de Classroom de las materias del alumno, de la más reciente a la más vieja, con lo que ya subió. */
export function tareasDeAlumno(db: DB, alumnoId: number, ahora = Date.now()): MateriaTareasAlumno[] {
  asegurarTablas(db)
  const materias = db
    .prepare(
      `SELECT m.id, m.nombre, m.color FROM materias m JOIN inscripciones i ON i.materia_id = m.id
       WHERE i.alumno_id = ? AND m.oculta = 0 AND EXISTS (SELECT 1 FROM classroom_cursos c WHERE c.materia_id = m.id AND c.activo = 1)
       ORDER BY m.nombre`
    )
    .all(alumnoId) as { id: number; nombre: string; color: string }[]
  if (!materias.length) return []

  const tareas = db
    .prepare(
      `SELECT t.*, c.materia_id FROM classroom_tareas t JOIN classroom_cursos c ON c.id = t.curso_id
       WHERE c.activo = 1 AND c.materia_id IN (${materias.map(() => '?').join(',')})`
    )
    .all(...materias.map((m) => m.id)) as FilaTarea[]
  // Su cuenta de Classroom (si el docente ya la ligó): sirve para saber qué entregó allá y qué no le asignaron
  const cuentas = new Map(
    (db.prepare("SELECT curso_id, user_id FROM classroom_alumnos WHERE alumno_id = ? AND activo = 1 AND liga <> 'ajeno'").all(alumnoId) as { curso_id: string; user_id: string }[]).map((c) => [
      c.curso_id,
      c.user_id
    ])
  )
  const entregas = new Map(
    (
      db
        .prepare(
          `SELECT e.curso_id, e.tarea_id, e.estado FROM classroom_entregas e JOIN classroom_alumnos ca ON ca.curso_id = e.curso_id AND ca.user_id = e.user_id
           WHERE ca.alumno_id = ?`
        )
        .all(alumnoId) as { curso_id: string; tarea_id: string; estado: string }[]
    ).map((e) => [`${e.curso_id}:${e.tarea_id}`, e.estado])
  )
  // Calificación que el docente ya le devolvió (en Classroom o, sin Classroom, en la app)
  const devueltas = new Map(
    (
      db
        .prepare(
          `SELECT e.curso_id, e.tarea_id, e.calificacion FROM classroom_entregas e JOIN classroom_alumnos ca ON ca.curso_id = e.curso_id AND ca.user_id = e.user_id
           WHERE ca.alumno_id = ? AND e.estado = 'RETURNED' AND e.calificacion IS NOT NULL`
        )
        .all(alumnoId) as { curso_id: string; tarea_id: string; calificacion: number }[]
    ).map((e) => [`${e.curso_id}:${e.tarea_id}`, e.calificacion])
  )
  const subidas = new Map(
    (db.prepare('SELECT * FROM subidas_alumno WHERE alumno_id = ?').all(alumnoId) as { id: number; curso_id: string; tarea_id: string; nota: string; creada: string }[]).map((s) => [
      `${s.curso_id}:${s.tarea_id}`,
      s
    ])
  )
  const archivos = db
    .prepare('SELECT a.id, a.subida_id, a.nombre, a.tamano, a.subido_en FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE s.alumno_id = ? ORDER BY a.id')
    .all(alumnoId) as (ArchivoSubida & { subida_id: number })[]

  const ajustes = ajustesDeTareas(db)
  // Las de recuperación (marcadas como comodín en la app) son opcionales: no cuentan como «por entregar»
  const recuperacion = new Set((db.prepare('SELECT curso_id, tarea_id FROM classroom_comodines').all() as { curso_id: string; tarea_id: string }[]).map((c) => `${c.curso_id}:${c.tarea_id}`))

  return materias.map((m) => {
    const lista: TareaAlumno[] = []
    for (const t of tareas.filter((x) => x.materia_id === m.id)) {
      const clave = `${t.curso_id}:${t.id}`
      const deClassroom = entregas.get(clave)
      // Ligado y sin entrega en Classroom = la tarea no es para él (se asignó a otros alumnos)
      if (cuentas.has(t.curso_id) && deClassroom === undefined) continue
      const ajuste = ajustes.get(clave) ?? AJUSTE_POR_OMISION
      if (!esParaAlumno(ajuste, alumnoId)) continue
      const limite = limiteDeEntrega(t.vence, t.creada)
      const s = subidas.get(clave)
      const propios = s ? archivos.filter((a) => a.subida_id === s.id).map(({ subida_id: _, ...a }) => a) : []
      // Cuenta la fecha del último archivo: lo agregado después de la fecha límite es entrega tarde
      const ultima = propios.reduce<string | null>((m, a) => (m === null || a.subido_en > m ? a.subido_en : m), null)
      const vencio = limite !== null && ahora > limite
      let estado: EstadoTareaAlumno = recuperacion.has(clave) ? 'recuperacion' : vencio ? (ajuste.acepta_tarde ? 'vencida' : 'cerrada') : 'pendiente'
      if (s) estado = 'subida'
      // Sin Classroom (curso de la app) «devuelta» no es que la entregó allá: cuenta lo que subió al portal
      if (deClassroom && YA_ENTREGADA.has(deClassroom) && !t.curso_id.startsWith('app-')) estado = 'entregada_classroom'
      lista.push({
        curso_id: t.curso_id,
        tarea_id: t.id,
        titulo: t.titulo,
        descripcion: t.descripcion ?? '',
        vence: limite !== null ? new Date(limite).toISOString() : null,
        sin_fecha: t.vence === null,
        puntos: t.puntos,
        enlace: t.enlace,
        materiales: materialesDe(t.materiales),
        estado,
        tarde: Boolean(ultima && limite !== null && msDe(ultima) > limite),
        nota: s?.nota ?? '',
        calificacion: devueltas.get(clave) ?? null,
        acepta_tarde: ajuste.acepta_tarde,
        subida_en: ultima,
        archivos: propios
      })
    }
    // Primero lo que falta por entregar (lo que vence antes arriba); luego lo demás, lo más reciente arriba
    const falta = (x: TareaAlumno): boolean => x.estado === 'pendiente' || x.estado === 'vencida'
    lista.sort((a, b) => {
      if (falta(a) !== falta(b)) return falta(a) ? -1 : 1
      const va = a.vence ? Date.parse(a.vence) : 0
      const vb = b.vence ? Date.parse(b.vence) : 0
      return a.estado === 'pendiente' && b.estado === 'pendiente' ? va - vb : vb - va
    })
    return { materia_id: m.id, materia_nombre: m.nombre, materia_color: m.color, tareas: lista }
  })
}

// ---------- Ajustes de cada tarea en el portal (para quién es y si acepta tarde) ----------

export const AJUSTE_POR_OMISION: PortalTarea = { visibilidad: 'todos', alumnos: [], acepta_tarde: true }

export function ajustesDeTareas(db: DB): Map<string, PortalTarea> {
  return new Map(
    (db.prepare('SELECT curso_id, tarea_id, visibilidad, alumnos, acepta_tarde FROM portal_tareas').all() as { curso_id: string; tarea_id: string; visibilidad: string; alumnos: string; acepta_tarde: number }[]).map(
      (f) => [
        `${f.curso_id}:${f.tarea_id}`,
        { visibilidad: (['todos', 'algunos', 'oculta'].includes(f.visibilidad) ? f.visibilidad : 'todos') as PortalTarea['visibilidad'], alumnos: JSON.parse(f.alumnos || '[]') as number[], acepta_tarde: !!f.acepta_tarde }
      ]
    )
  )
}

const esParaAlumno = (a: PortalTarea, alumnoId: number): boolean => a.visibilidad === 'todos' || (a.visibilidad === 'algunos' && a.alumnos.includes(alumnoId))

/** Guarda el ajuste de una tarea (lo usa la app de escritorio). Lo que queda igual al de omisión se borra. */
export function guardarAjusteTarea(db: DB, cursoId: string, tareaId: string, a: PortalTarea): void {
  if (!['todos', 'algunos', 'oculta'].includes(a.visibilidad)) throw new Error('Visibilidad no válida.')
  const alumnos = a.visibilidad === 'algunos' ? [...new Set(a.alumnos.map(Number).filter(Number.isInteger))] : []
  if (a.visibilidad === 'algunos' && !alumnos.length) throw new Error('Elige al menos un alumno.')
  if (a.visibilidad === 'todos' && a.acepta_tarde) {
    db.prepare('DELETE FROM portal_tareas WHERE curso_id = ? AND tarea_id = ?').run(cursoId, tareaId)
    return
  }
  db.prepare(
    `INSERT INTO portal_tareas (curso_id, tarea_id, visibilidad, alumnos, acepta_tarde) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (curso_id, tarea_id) DO UPDATE SET visibilidad = excluded.visibilidad, alumnos = excluded.alumnos, acepta_tarde = excluded.acepta_tarde`
  ).run(cursoId, tareaId, a.visibilidad, JSON.stringify(alumnos), a.acepta_tarde ? 1 : 0)
}

/** La tarea es de un curso ligado a una materia en la que el alumno está inscrito. */
export function validarTareaDeAlumno(db: DB, alumnoId: number, cursoId: string, tareaId: string): { materia_id: number; titulo: string } {
  asegurarTablas(db)
  const t = db
    .prepare(
      `SELECT t.titulo, c.materia_id FROM classroom_tareas t JOIN classroom_cursos c ON c.id = t.curso_id
       JOIN inscripciones i ON i.materia_id = c.materia_id AND i.alumno_id = ?
       WHERE t.curso_id = ? AND t.id = ? AND c.activo = 1`
    )
    .get(alumnoId, cursoId, tareaId) as { titulo: string; materia_id: number } | undefined
  if (!t) throw new ErrorHttp(404, 'Esa tarea no es de tus materias.')
  const ajuste = ajustesDeTareas(db).get(`${cursoId}:${tareaId}`) ?? AJUSTE_POR_OMISION
  if (!esParaAlumno(ajuste, alumnoId)) throw new ErrorHttp(404, 'Esa tarea no es de tus materias.')
  if (!ajuste.acepta_tarde) {
    const f = db.prepare('SELECT vence, creada FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { vence: string | null; creada: string | null }
    const limite = limiteDeEntrega(f.vence, f.creada)
    if (limite !== null && Date.now() > limite) throw new ErrorHttp(400, 'La fecha de entrega ya pasó y tu docente no acepta entregas tarde en esta tarea.')
  }
  const n = (
    db
      .prepare('SELECT COUNT(*) AS n FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE s.alumno_id = ? AND s.curso_id = ? AND s.tarea_id = ?')
      .get(alumnoId, cursoId, tareaId) as { n: number }
  ).n
  if (n >= MAX_ARCHIVOS_POR_TAREA) throw new ErrorHttp(400, `Ya subiste ${MAX_ARCHIVOS_POR_TAREA} archivos a esta tarea. Quita alguno para subir otro.`)
  return t
}

export interface ArchivoNuevo {
  nombre: string
  /** Relativa a la carpeta de entregas */
  ruta: string
  mime: string
  tamano: number
}

/** Guarda los archivos (y la nota, si viene) y avisa al docente. */
export function registrarSubida(db: DB, alumnoId: number, cursoId: string, tareaId: string, nota: string | undefined, archivos: ArchivoNuevo[]): void {
  const t = validarTareaDeAlumno(db, alumnoId, cursoId, tareaId)
  const total = (
    db
      .prepare('SELECT COUNT(*) AS n FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE s.alumno_id = ? AND s.curso_id = ? AND s.tarea_id = ?')
      .get(alumnoId, cursoId, tareaId) as { n: number }
  ).n
  if (total + archivos.length > MAX_ARCHIVOS_POR_TAREA) throw new ErrorHttp(400, `Cada tarea admite hasta ${MAX_ARCHIVOS_POR_TAREA} archivos.`)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO subidas_alumno (alumno_id, materia_id, curso_id, tarea_id, titulo, nota) VALUES (?,?,?,?,?,?)
       ON CONFLICT (alumno_id, curso_id, tarea_id) DO UPDATE SET actualizada = datetime('now'), titulo = excluded.titulo,
         nota = CASE WHEN ? THEN excluded.nota ELSE nota END`
    ).run(alumnoId, t.materia_id, cursoId, tareaId, t.titulo, (nota ?? '').slice(0, 2000), nota !== undefined ? 1 : 0)
    const s = db.prepare('SELECT id FROM subidas_alumno WHERE alumno_id = ? AND curso_id = ? AND tarea_id = ?').get(alumnoId, cursoId, tareaId) as { id: number }
    const ins = db.prepare('INSERT INTO archivos_subida (subida_id, nombre, ruta, mime, tamano) VALUES (?,?,?,?,?)')
    for (const a of archivos) ins.run(s.id, a.nombre, a.ruta, a.mime, a.tamano)
  })()
  const alumno = db.prepare('SELECT nombre, apellidos FROM alumnos WHERE id = ?').get(alumnoId) as { nombre: string; apellidos: string }
  notificarDocentes(db, t.materia_id, {
    tipo: 'entrega',
    titulo: `${alumno.apellidos} ${alumno.nombre} subió: ${t.titulo}`,
    cuerpo: `${archivos.length === 1 ? '1 archivo' : `${archivos.length} archivos`} desde el portal · cuenta como entregada en Classroom › celda de la tarea`,
    ref_tipo: 'subida',
    ref_id: null
  })
}

/** Quita un archivo propio. Sin archivos, la subida se borra y la tarea vuelve a contar como no entregada. */
export function quitarArchivoSubida(db: DB, alumnoId: number, archivoId: number): string {
  const f = db
    .prepare('SELECT a.ruta, a.subida_id FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE a.id = ? AND s.alumno_id = ?')
    .get(archivoId, alumnoId) as { ruta: string; subida_id: number } | undefined
  if (!f) throw new ErrorHttp(404, 'Ese archivo no es tuyo o ya no está.')
  db.transaction(() => {
    db.prepare('DELETE FROM archivos_subida WHERE id = ?').run(archivoId)
    db.prepare('DELETE FROM subidas_alumno WHERE id = ? AND NOT EXISTS (SELECT 1 FROM archivos_subida WHERE subida_id = ?)').run(f.subida_id, f.subida_id)
  })()
  return f.ruta
}

/** Para descargar: lo ve su dueño o el docente de la materia. */
export function archivoDeSubida(db: DB, archivoId: number): { ruta: string; nombre: string; alumno_id: number; materia_id: number } {
  const f = db
    .prepare('SELECT a.ruta, a.nombre, s.alumno_id, s.materia_id FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE a.id = ?')
    .get(archivoId) as { ruta: string; nombre: string; alumno_id: number; materia_id: number } | undefined
  if (!f) throw new ErrorHttp(404, 'El archivo ya no está.')
  return f
}
