/**
 * Tablas propias de la sincronización con Classroom, empate de alumnos y estados de entrega.
 * Recibe la base como parámetro (sin Electron) para poder probarlo sobre una copia.
 * Nunca crea alumnos en la app: solo liga los de Classroom con los que ya existen.
 */
import type Database from 'better-sqlite3'
import type { GAdjunto, GAlumno, GCurso, GEntrega, GFecha, GTarea } from './classroom-api'
import type {
  Adjunto, AlumnoApp, AlumnoResumen, CeldaEntrega, CursoClassroom, DetalleEntrega, EstadoEntrega, Liga, ResumenClassroom, SinLigarClassroom, TareaResumen
} from '@shared/classroom'

import { consolidar } from './classroom-consolidar'

type DB = Database.Database

const TABLAS = `
CREATE TABLE IF NOT EXISTS classroom_cursos (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  seccion TEXT NOT NULL DEFAULT '',
  enlace TEXT NOT NULL DEFAULT '',
  materia_id INTEGER REFERENCES materias(id) ON DELETE SET NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  sincronizado TEXT
);
CREATE TABLE IF NOT EXISTS classroom_alumnos (
  curso_id TEXT NOT NULL REFERENCES classroom_cursos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  nombre TEXT NOT NULL,
  nombre_pila TEXT NOT NULL DEFAULT '',
  apellidos TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  alumno_id INTEGER REFERENCES alumnos(id) ON DELETE SET NULL,
  liga TEXT NOT NULL DEFAULT 'pendiente',
  sugerido_id INTEGER REFERENCES alumnos(id) ON DELETE SET NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (curso_id, user_id)
);
CREATE TABLE IF NOT EXISTS classroom_tareas (
  curso_id TEXT NOT NULL REFERENCES classroom_cursos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  titulo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT '',
  puntos REAL,
  vence TEXT,
  creada TEXT,
  enlace TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (curso_id, id)
);
CREATE TABLE IF NOT EXISTS classroom_entregas (
  curso_id TEXT NOT NULL REFERENCES classroom_cursos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT '',
  tarde INTEGER NOT NULL DEFAULT 0,
  calificacion REAL,
  borrador REAL,
  actualizada TEXT,
  entregada TEXT,
  alguna_vez_entregada INTEGER,
  enlace TEXT NOT NULL DEFAULT '',
  respuesta TEXT NOT NULL DEFAULT '',
  adjuntos TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (curso_id, id)
);
CREATE INDEX IF NOT EXISTS idx_classroom_entregas_tarea ON classroom_entregas(curso_id, tarea_id);
-- Entregas que el docente recibió por otro lado (correo, USB, impresa) y registró a mano.
-- Van aparte para que la sincronización con Classroom nunca las borre.
CREATE TABLE IF NOT EXISTS classroom_entregas_fuera (
  curso_id TEXT NOT NULL,
  entrega_id TEXT NOT NULL,
  registrada TEXT NOT NULL,
  PRIMARY KEY (curso_id, entrega_id)
);
-- Calificación que el docente pone en la app (sobre los puntos de la tarea). Manda sobre la de Classroom
-- y cuenta la tarea como entregada; Classroom nunca se toca.
CREATE TABLE IF NOT EXISTS classroom_calif_app (
  curso_id TEXT NOT NULL,
  entrega_id TEXT NOT NULL,
  calificacion REAL NOT NULL,
  registrada TEXT NOT NULL,
  PRIMARY KEY (curso_id, entrega_id)
);
`

const listas = new WeakSet<DB>()
export function asegurarTablas(db: DB): void {
  if (listas.has(db)) return
  db.exec(TABLAS)
  // Instrucciones y material de cada tarea (agregados después: bases viejas no los tienen)
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('classroom_tareas')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('descripcion')) db.exec("ALTER TABLE classroom_tareas ADD COLUMN descripcion TEXT NOT NULL DEFAULT ''")
  if (!cols.has('materiales')) db.exec("ALTER TABLE classroom_tareas ADD COLUMN materiales TEXT NOT NULL DEFAULT '[]'")
  // La creó esta app: solo esas se pueden editar, borrar y calificar en Classroom desde aquí
  if (!cols.has('propia')) db.exec('ALTER TABLE classroom_tareas ADD COLUMN propia INTEGER NOT NULL DEFAULT 0')
  listas.add(db)
}

// ---------- Fechas ----------

/**
 * Fecha límite en UTC. Classroom guarda dueDate/dueTime en UTC; si no hay hora se toma el final
 * de ese día en Ciudad de México (UTC−6, sin horario de verano desde 2022).
 */
export function venceUtc(fecha?: GFecha, hora?: { hours?: number; minutes?: number }): string | null {
  if (!fecha?.year || !fecha.month || !fecha.day) return null
  if (hora && (hora.hours !== undefined || hora.minutes !== undefined)) {
    return new Date(Date.UTC(fecha.year, fecha.month - 1, fecha.day, hora.hours ?? 0, hora.minutes ?? 0)).toISOString()
  }
  return new Date(Date.UTC(fecha.year, fecha.month - 1, fecha.day, 23 + 6, 59, 59)).toISOString()
}

// ---------- Estado de cada entrega ----------

/** Una tarea sin fecha de entrega cuenta como vencida una semana después de publicarse */
export const PLAZO_SIN_FECHA_MS = 7 * 24 * 3600_000

/** Cuándo se considera vencida: su fecha de entrega o, si no tiene, una semana después de publicarse */
export function limiteDeEntrega(vence: string | null, creada: string | null = null): number | null {
  if (vence !== null) return Date.parse(vence)
  return creada ? Date.parse(creada) + PLAZO_SIN_FECHA_MS : null
}

export function estadoEntrega(
  e: { estado: string; tarde: number | boolean; alguna_vez_entregada?: number | null } | null,
  vence: string | null,
  ahora = Date.now(),
  creada: string | null = null
): EstadoEntrega {
  if (!e) return 'no_asignada'
  const limite = limiteDeEntrega(vence, creada)
  const vencida = limite !== null && ahora > limite
  switch (e.estado) {
    case 'RECLAIMED_BY_STUDENT':
      return 'retirada'
    case 'TURNED_IN':
      return e.tarde ? 'tarde' : 'entrego'
    case 'RETURNED':
      // Devuelta sin que el alumno la haya entregado nunca (el maestro la regresó con o sin nota)
      if (e.alguna_vez_entregada === 0) return vencida ? 'no_entrego' : 'pendiente'
      return e.tarde ? 'tarde' : 'entrego'
    default:
      return vencida ? 'no_entrego' : 'pendiente'
  }
}

/** Entrega registrada a mano: cuenta como entregada en la fecha en que se registró (tarde si ya había vencido) */
function estadoFuera(registrada: string, vence: string | null, creada: string | null): EstadoEntrega {
  const limite = limiteDeEntrega(vence, creada)
  return limite !== null && Date.parse(registrada) > limite ? 'tarde' : 'entrego'
}
const YA_ENTREGADA = new Set<EstadoEntrega>(['entrego', 'tarde'])

/** Registra (o quita) una entrega recibida fuera de Classroom. Solo cambia la app, nunca Classroom. */
export function marcarEntregaFuera(db: DB, cursoId: string, entregaId: string, recibida: boolean, ahora = new Date()): void {
  asegurarTablas(db)
  if (!db.prepare('SELECT 1 FROM classroom_entregas WHERE curso_id = ? AND id = ?').get(cursoId, entregaId)) throw new Error('Esa entrega ya no está. Sincroniza otra vez.')
  if (recibida) db.prepare('INSERT OR IGNORE INTO classroom_entregas_fuera (curso_id, entrega_id, registrada) VALUES (?, ?, ?)').run(cursoId, entregaId, ahora.toISOString())
  else db.prepare('DELETE FROM classroom_entregas_fuera WHERE curso_id = ? AND entrega_id = ?').run(cursoId, entregaId)
}

/** Pone (o quita con null) la calificación de la app para una entrega. Solo cambia la app, nunca Classroom. */
export function calificarEnApp(db: DB, cursoId: string, entregaId: string, calificacion: number | null, ahora = new Date()): void {
  asegurarTablas(db)
  const t = db.prepare(`SELECT t.puntos FROM classroom_entregas e JOIN classroom_tareas t ON t.curso_id = e.curso_id AND t.id = e.tarea_id
    WHERE e.curso_id = ? AND e.id = ?`).get(cursoId, entregaId) as { puntos: number | null } | undefined
  if (!t) throw new Error('Esa entrega ya no está. Sincroniza otra vez.')
  if (calificacion === null) {
    db.prepare('DELETE FROM classroom_calif_app WHERE curso_id = ? AND entrega_id = ?').run(cursoId, entregaId)
    return
  }
  const max = t.puntos ?? 100
  if (!Number.isFinite(calificacion) || calificacion < 0 || calificacion > max) throw new Error(`La calificación va de 0 a ${max}.`)
  db.prepare(`INSERT INTO classroom_calif_app (curso_id, entrega_id, calificacion, registrada) VALUES (?, ?, ?, ?)
    ON CONFLICT(curso_id, entrega_id) DO UPDATE SET calificacion = excluded.calificacion`).run(cursoId, entregaId, calificacion, ahora.toISOString())
}

// ---------- Empate de nombres ----------

/** Minúsculas, sin acentos ni signos; palabras ordenadas para que el orden apellidos/nombre no importe. */
export function palabras(nombre: string): string[] {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 0 && !['de', 'del', 'la', 'las', 'los', 'y'].includes(p))
    .sort()
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

/**
 * Compara dos nombres palabra por palabra (cada palabra con su más parecida).
 * `seguro`: mismas palabras con a lo más un par de letras distintas en total.
 * `parecido`: una de las listas contiene a la otra (p. ej. sin segundo apellido) o difieren un poco más.
 */
export function compararNombres(a: string, b: string): { distancia: number; tipo: 'seguro' | 'parecido' | 'distinto' } {
  const pa = palabras(a)
  const pb = palabras(b)
  if (!pa.length || !pb.length) return { distancia: 99, tipo: 'distinto' }
  const [corta, larga] = pa.length <= pb.length ? [pa, pb] : [pb, pa]
  const libres = [...larga]
  let distancia = 0
  let maxPorPalabra = 0
  for (const p of corta) {
    let mejor = -1
    let dMejor = Infinity
    libres.forEach((q, i) => {
      const d = levenshtein(p, q)
      if (d < dMejor) { dMejor = d; mejor = i }
    })
    distancia += dMejor
    maxPorPalabra = Math.max(maxPorPalabra, dMejor)
    libres.splice(mejor, 1)
  }
  const letras = corta.join('').length
  if (corta.length === larga.length) {
    if (distancia === 0 || (distancia <= 2 && maxPorPalabra <= 1 && letras >= 10)) return { distancia, tipo: 'seguro' }
    if (distancia <= 4) return { distancia, tipo: 'parecido' }
    return { distancia, tipo: 'distinto' }
  }
  // Le falta alguna palabra (segundo nombre o apellido): solo sugerencia, y con al menos nombre y apellido
  const sobran = libres.reduce((n, q) => n + q.length, 0)
  if (corta.length >= 2 && maxPorPalabra <= 1 && distancia <= 1) return { distancia: distancia + sobran, tipo: 'parecido' }
  return { distancia: distancia + sobran, tipo: 'distinto' }
}

// ---------- Guardar lo leído de Classroom ----------

const ahoraIso = (): string => new Date().toISOString()

/** Cursos activos del maestro. Los que ya no aparecen se marcan inactivos (se conserva su liga a la materia). */
export function guardarCursos(db: DB, cursos: GCurso[]): void {
  asegurarTablas(db)
  const up = db.prepare(`INSERT INTO classroom_cursos (id, nombre, seccion, enlace, activo) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET nombre = excluded.nombre, seccion = excluded.seccion, enlace = excluded.enlace, activo = 1`)
  db.transaction(() => {
    // Los cursos de la app (materias sin Classroom) no vienen de Google: no se tocan
    db.prepare("UPDATE classroom_cursos SET activo = 0 WHERE id NOT LIKE 'app-%'").run()
    for (const c of cursos) up.run(c.id, c.name ?? '(sin nombre)', c.section ?? '', c.alternateLink ?? '')
  })()
}

// ---------- Tareas sin Classroom: el «curso de la app» de una materia ----------

/**
 * Una materia que no usa Classroom tiene un curso propio («app-<materia>») con las mismas tablas: así la
 * tabla de alumnos × tareas, las calificaciones, «Subir tarea» del portal y la revisión de copias funcionan igual.
 * Sus alumnos son los inscritos y cada tarea tiene una entrega por alumno; nada de esto va a Google.
 */
export const esCursoApp = (id: string): boolean => id.startsWith('app-')
export const cursoAppDe = (materiaId: number): string => `app-${materiaId}`

export function crearCursoApp(db: DB, materiaId: number): string {
  asegurarTablas(db)
  const m = db.prepare('SELECT nombre FROM materias WHERE id = ?').get(materiaId) as { nombre: string } | undefined
  if (!m) throw new Error('Esa materia no existe.')
  const id = cursoAppDe(materiaId)
  db.prepare(
    `INSERT INTO classroom_cursos (id, nombre, seccion, enlace, materia_id, activo) VALUES (?, ?, 'sin Classroom', '', ?, 1)
     ON CONFLICT(id) DO UPDATE SET materia_id = excluded.materia_id, activo = 1`
  ).run(id, `Tareas de la app · ${m.nombre}`, materiaId)
  asegurarCursoApp(db, materiaId)
  return id
}

/** Pone al día los alumnos del curso de la app (los inscritos activos) y una entrega por alumno en cada tarea. */
export function asegurarCursoApp(db: DB, materiaId: number): void {
  asegurarTablas(db)
  const curso = cursoAppDe(materiaId)
  if (!db.prepare('SELECT 1 FROM classroom_cursos WHERE id = ? AND materia_id = ?').get(curso, materiaId)) return
  const inscritos = db
    .prepare('SELECT a.id, a.nombre, a.apellidos, a.email FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id WHERE i.materia_id = ? AND a.activo = 1')
    .all(materiaId) as { id: number; nombre: string; apellidos: string; email: string }[]
  const tareas = db.prepare('SELECT id FROM classroom_tareas WHERE curso_id = ?').all(curso) as { id: string }[]
  const upA = db.prepare(`INSERT INTO classroom_alumnos (curso_id, user_id, nombre, nombre_pila, apellidos, email, alumno_id, liga, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1)
    ON CONFLICT(curso_id, user_id) DO UPDATE SET nombre = excluded.nombre, nombre_pila = excluded.nombre_pila, apellidos = excluded.apellidos, email = excluded.email, alumno_id = excluded.alumno_id, activo = 1`)
  const upE = db.prepare(`INSERT OR IGNORE INTO classroom_entregas (curso_id, id, tarea_id, user_id, estado) VALUES (?, ?, ?, ?, 'CREATED')`)
  db.transaction(() => {
    db.prepare('UPDATE classroom_alumnos SET activo = 0 WHERE curso_id = ?').run(curso)
    for (const a of inscritos) {
      const user = `app-${a.id}`
      upA.run(curso, user, `${a.nombre} ${a.apellidos}`.trim(), a.nombre, a.apellidos, a.email.toLowerCase(), a.id)
      for (const t of tareas) upE.run(curso, `${t.id}-${a.id}`, t.id, user)
    }
  })()
}

function adjuntosDe(e: GEntrega): Adjunto[] {
  return (e.assignmentSubmission?.attachments ?? []).flatMap((a: GAdjunto): Adjunto[] => {
    if (a.driveFile?.id) return [{ tipo: 'drive', id: a.driveFile.id, titulo: a.driveFile.title ?? 'Archivo', enlace: a.driveFile.alternateLink ?? '', miniatura: a.driveFile.thumbnailUrl ?? '' }]
    if (a.link?.url) return [{ tipo: 'enlace', url: a.link.url, titulo: a.link.title ?? a.link.url }]
    if (a.youTubeVideo?.id) return [{ tipo: 'youtube', id: a.youTubeVideo.id, titulo: a.youTubeVideo.title ?? 'Video', enlace: a.youTubeVideo.alternateLink ?? `https://www.youtube.com/watch?v=${a.youTubeVideo.id}` }]
    if (a.form) return [{ tipo: 'formulario', titulo: a.form.title ?? 'Formulario', enlace: a.form.formUrl ?? '', respuestas: a.form.responseUrl ?? '' }]
    return []
  })
}

/** Momento de la última entrega y si alguna vez la entregó (null si Classroom no mandó historial). */
function historial(e: GEntrega): { entregada: string | null; algunaVez: number | null } {
  const h = e.submissionHistory
  if (!h?.length) return { entregada: e.state === 'TURNED_IN' ? e.updateTime ?? null : null, algunaVez: null }
  const entregas = h.map((x) => x.stateHistory).filter((s) => s?.state === 'TURNED_IN' && s.stateTimestamp).map((s) => s!.stateTimestamp!)
  entregas.sort()
  return { entregada: entregas[entregas.length - 1] ?? null, algunaVez: entregas.length ? 1 : 0 }
}

/**
 * Guarda alumnos, tareas y entregas de un curso. Re-sincronizar actualiza sin duplicar; las tareas
 * y entregas que ya no existen se borran, los alumnos que salieron quedan inactivos (con su liga).
 */
export function guardarCurso(db: DB, cursoId: string, alumnos: GAlumno[], tareas: GTarea[], entregas: GEntrega[]): void {
  asegurarTablas(db)
  const upA = db.prepare(`INSERT INTO classroom_alumnos (curso_id, user_id, nombre, nombre_pila, apellidos, email, activo) VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(curso_id, user_id) DO UPDATE SET nombre = excluded.nombre, nombre_pila = excluded.nombre_pila, apellidos = excluded.apellidos, email = excluded.email, activo = 1`)
  const upT = db.prepare(`INSERT INTO classroom_tareas (curso_id, id, titulo, tipo, puntos, vence, creada, enlace, descripcion, materiales, propia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(curso_id, id) DO UPDATE SET titulo = excluded.titulo, tipo = excluded.tipo, puntos = excluded.puntos, vence = excluded.vence, creada = excluded.creada, enlace = excluded.enlace,
      descripcion = excluded.descripcion, materiales = excluded.materiales, propia = excluded.propia`)
  const upE = db.prepare(`INSERT INTO classroom_entregas (curso_id, id, tarea_id, user_id, estado, tarde, calificacion, borrador, actualizada, entregada, alguna_vez_entregada, enlace, respuesta, adjuntos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(curso_id, id) DO UPDATE SET tarea_id = excluded.tarea_id, user_id = excluded.user_id, estado = excluded.estado, tarde = excluded.tarde,
      calificacion = excluded.calificacion, borrador = excluded.borrador, actualizada = excluded.actualizada, entregada = excluded.entregada,
      alguna_vez_entregada = excluded.alguna_vez_entregada, enlace = excluded.enlace, respuesta = excluded.respuesta, adjuntos = excluded.adjuntos`)
  db.transaction(() => {
    db.prepare('UPDATE classroom_alumnos SET activo = 0 WHERE curso_id = ?').run(cursoId)
    for (const a of alumnos) {
      const p = a.profile ?? { id: a.userId }
      const nombre = p.name?.fullName || [p.name?.givenName, p.name?.familyName].filter(Boolean).join(' ') || '(sin nombre)'
      upA.run(cursoId, a.userId || p.id, nombre, p.name?.givenName ?? '', p.name?.familyName ?? '', (p.emailAddress ?? '').toLowerCase())
    }
    const idsT = new Set<string>()
    // Tareas nuevas en el portal: sin entregas tarde por omisión (el docente lo abre en «👁 Portal»).
    // La primera sincronización de un curso trae tareas viejas: esas se quedan como estaban.
    const yaEstaban = new Set((db.prepare('SELECT id FROM classroom_tareas WHERE curso_id = ?').all(cursoId) as { id: string }[]).map((f) => f.id))
    const cerrarTarde = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_tareas'").get()
      ? db.prepare(`INSERT INTO portal_tareas (curso_id, tarea_id, visibilidad, alumnos, acepta_tarde) VALUES (?, ?, 'todos', '[]', 0) ON CONFLICT (curso_id, tarea_id) DO NOTHING`)
      : null
    for (const t of tareas) {
      idsT.add(t.id)
      if (cerrarTarde && yaEstaban.size && !yaEstaban.has(t.id)) cerrarTarde.run(cursoId, t.id)
      const materiales = (t.materials ?? []).map((m) =>
        m.driveFile?.driveFile ? { tipo: 'drive', id: m.driveFile.driveFile.id, titulo: m.driveFile.driveFile.title ?? '', enlace: m.driveFile.driveFile.alternateLink ?? '' }
          : m.link ? { tipo: 'enlace', titulo: m.link.title ?? m.link.url, enlace: m.link.url }
            : m.youtubeVideo ? { tipo: 'youtube', titulo: m.youtubeVideo.title ?? '', enlace: m.youtubeVideo.alternateLink ?? '' }
              : m.form ? { tipo: 'formulario', titulo: m.form.title ?? '', enlace: m.form.formUrl ?? '' } : null).filter(Boolean)
      upT.run(cursoId, t.id, t.title ?? '(sin título)', t.workType ?? '', t.maxPoints ?? null, venceUtc(t.dueDate, t.dueTime), t.creationTime ?? null, t.alternateLink ?? '',
        t.description ?? '', JSON.stringify(materiales), t.associatedWithDeveloper ? 1 : 0)
    }
    for (const t of db.prepare('SELECT id FROM classroom_tareas WHERE curso_id = ?').all(cursoId) as { id: string }[]) {
      if (!idsT.has(t.id)) db.prepare('DELETE FROM classroom_tareas WHERE curso_id = ? AND id = ?').run(cursoId, t.id)
    }
    const idsE = new Set<string>()
    for (const e of entregas) {
      // Entregas de tareas en borrador o de material: no hay tarea publicada a la cual ligarlas
      if (!idsT.has(e.courseWorkId)) continue
      idsE.add(e.id)
      const h = historial(e)
      const respuesta = e.shortAnswerSubmission?.answer ?? e.multipleChoiceSubmission?.answer ?? ''
      upE.run(cursoId, e.id, e.courseWorkId, e.userId, e.state ?? '', e.late ? 1 : 0, e.assignedGrade ?? null, e.draftGrade ?? null,
        e.updateTime ?? null, h.entregada, h.algunaVez, e.alternateLink ?? '', respuesta, JSON.stringify(adjuntosDe(e)))
    }
    for (const e of db.prepare('SELECT id FROM classroom_entregas WHERE curso_id = ?').all(cursoId) as { id: string }[]) {
      if (!idsE.has(e.id)) db.prepare('DELETE FROM classroom_entregas WHERE curso_id = ? AND id = ?').run(cursoId, e.id)
    }
    db.prepare('UPDATE classroom_cursos SET sincronizado = ? WHERE id = ?').run(ahoraIso(), cursoId)
  })()
}

// ---------- Empate de alumnos ----------

interface FilaCA { curso_id: string; user_id: string; nombre: string; email: string; alumno_id: number | null; liga: Liga }

function alumnosDeMateria(db: DB, materiaId: number): AlumnoApp[] {
  return db.prepare(`SELECT a.id, a.nombre, a.apellidos, a.email, a.matricula FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id
    WHERE i.materia_id = ? ORDER BY a.apellidos, a.nombre`).all(materiaId) as AlumnoApp[]
}

/**
 * Liga automáticamente los alumnos de Classroom de los cursos de una materia: primero por correo,
 * luego por nombre. Lo ligado a mano o marcado «no es de mi grupo» no se toca. Lo dudoso queda
 * sin ligar con una sugerencia para que el maestro confirme.
 */
export function empatarMateria(db: DB, materiaId: number): void {
  asegurarTablas(db)
  const app = alumnosDeMateria(db, materiaId)
  const idsApp = new Set(app.map((a) => a.id))
  const filas = db.prepare(`SELECT ca.curso_id, ca.user_id, ca.nombre, ca.email, ca.alumno_id, ca.liga FROM classroom_alumnos ca
    JOIN classroom_cursos c ON c.id = ca.curso_id WHERE c.materia_id = ? AND ca.activo = 1`).all(materiaId) as FilaCA[]
  // Los ligados a mano apartan a su alumno; los automáticos se recalculan (p. ej. si ya tiene correo)
  const fijas = filas.filter((f) => (f.liga === 'manual' && f.alumno_id && idsApp.has(f.alumno_id)) || f.liga === 'ajeno')
  const ocupados = new Set(fijas.map((f) => f.alumno_id).filter((x): x is number => !!x))
  const porDecidir = filas.filter((f) => !fijas.includes(f))

  type Propuesta = { fila: FilaCA; alumno: number | null; liga: Liga; sugerido: number | null }
  const propuestas: Propuesta[] = porDecidir.map((f) => {
    const libres = app.filter((a) => !ocupados.has(a.id))
    if (f.email) {
      const porCorreo = libres.filter((a) => a.email && a.email.trim().toLowerCase() === f.email)
      if (porCorreo.length === 1) return { fila: f, alumno: porCorreo[0].id, liga: 'correo', sugerido: null }
    }
    const cmp = libres
      .map((a) => ({ a, ...compararNombres(f.nombre, `${a.nombre} ${a.apellidos}`) }))
      .filter((x) => x.tipo !== 'distinto')
      .sort((x, y) => x.distancia - y.distancia)
    const [mejor, segundo] = cmp
    if (!mejor) return { fila: f, alumno: null, liga: 'pendiente', sugerido: null }
    const unico = !segundo || segundo.distancia >= mejor.distancia + 2
    if (mejor.tipo === 'seguro' && unico) return { fila: f, alumno: mejor.a.id, liga: 'nombre', sugerido: null }
    return { fila: f, alumno: null, liga: 'dudoso', sugerido: mejor.a.id }
  })
  // Dos de Classroom que caen en el mismo alumno: ninguno se liga solo
  const cuenta = new Map<number, number>()
  for (const p of propuestas) if (p.alumno) cuenta.set(p.alumno, (cuenta.get(p.alumno) ?? 0) + 1)
  const upd = db.prepare('UPDATE classroom_alumnos SET alumno_id = ?, liga = ?, sugerido_id = ? WHERE curso_id = ? AND user_id = ?')
  db.transaction(() => {
    for (const p of propuestas) {
      if (p.alumno && (cuenta.get(p.alumno) ?? 0) > 1) upd.run(null, 'dudoso', p.alumno, p.fila.curso_id, p.fila.user_id)
      else upd.run(p.alumno, p.liga, p.sugerido, p.fila.curso_id, p.fila.user_id)
    }
  })()
}

/** Liga a mano (alumnoId), marca «no es de mi grupo» ('ajeno') o deshace (null). */
export function ligarAlumno(db: DB, cursoId: string, userId: string, destino: number | 'ajeno' | null): void {
  asegurarTablas(db)
  const fila = db.prepare(`SELECT c.materia_id FROM classroom_alumnos ca JOIN classroom_cursos c ON c.id = ca.curso_id WHERE ca.curso_id = ? AND ca.user_id = ?`).get(cursoId, userId) as { materia_id: number | null } | undefined
  if (!fila) throw new Error('Ese alumno de Classroom ya no está en la lista. Sincroniza otra vez.')
  if (destino === 'ajeno') {
    db.prepare("UPDATE classroom_alumnos SET alumno_id = NULL, liga = 'ajeno', sugerido_id = NULL WHERE curso_id = ? AND user_id = ?").run(cursoId, userId)
    return
  }
  if (destino === null) {
    db.prepare("UPDATE classroom_alumnos SET alumno_id = NULL, liga = 'pendiente', sugerido_id = NULL WHERE curso_id = ? AND user_id = ?").run(cursoId, userId)
    if (fila.materia_id) empatarMateria(db, fila.materia_id)
    return
  }
  if (!fila.materia_id) throw new Error('Primero liga el curso de Classroom a una materia.')
  const inscrito = db.prepare('SELECT 1 FROM inscripciones WHERE materia_id = ? AND alumno_id = ?').get(fila.materia_id, destino)
  if (!inscrito) throw new Error('Ese alumno no está inscrito en la materia.')
  db.transaction(() => {
    // Un alumno de la app corresponde a un solo alumno de Classroom en los cursos de la materia
    db.prepare(`UPDATE classroom_alumnos SET alumno_id = NULL, liga = 'pendiente' WHERE alumno_id = ? AND NOT (curso_id = ? AND user_id = ?)
      AND curso_id IN (SELECT id FROM classroom_cursos WHERE materia_id = ?)`).run(destino, cursoId, userId, fila.materia_id)
    db.prepare("UPDATE classroom_alumnos SET alumno_id = ?, liga = 'manual', sugerido_id = NULL WHERE curso_id = ? AND user_id = ?").run(destino, cursoId, userId)
  })()
}

/** Liga un curso de Classroom a una materia (o lo desliga con null) y vuelve a empatar alumnos. */
export function ligarCurso(db: DB, cursoId: string, materiaId: number | null): void {
  asegurarTablas(db)
  const antes = db.prepare('SELECT materia_id FROM classroom_cursos WHERE id = ?').get(cursoId) as { materia_id: number | null } | undefined
  if (!antes) throw new Error('Ese curso ya no está. Sincroniza otra vez.')
  db.transaction(() => {
    db.prepare('UPDATE classroom_cursos SET materia_id = ? WHERE id = ?').run(materiaId, cursoId)
    // Las ligas de alumnos eran contra los inscritos de la materia anterior
    if (antes.materia_id !== materiaId) {
      db.prepare("UPDATE classroom_alumnos SET alumno_id = NULL, liga = 'pendiente', sugerido_id = NULL WHERE curso_id = ? AND liga <> 'ajeno'").run(cursoId)
    }
  })()
  if (materiaId) empatarMateria(db, materiaId)
}

export function listarCursos(db: DB): CursoClassroom[] {
  asegurarTablas(db)
  return db.prepare(`SELECT c.*, m.nombre AS materia_nombre,
      (SELECT COUNT(*) FROM classroom_alumnos a WHERE a.curso_id = c.id AND a.activo = 1) AS alumnos,
      (SELECT COUNT(*) FROM classroom_tareas t WHERE t.curso_id = c.id) AS tareas
    FROM classroom_cursos c LEFT JOIN materias m ON m.id = c.materia_id
    ORDER BY c.activo DESC, c.nombre`).all() as CursoClassroom[]
}

// ---------- Resumen por materia ----------

interface FilaTarea { curso_id: string; id: string; titulo: string; tipo: string; puntos: number | null; vence: string | null; enlace: string; creada: string | null; propia?: number; descripcion?: string }
interface FilaEntrega { curso_id: string; id: string; tarea_id: string; user_id: string; estado: string; tarde: number; calificacion: number | null; borrador: number | null; entregada: string | null; alguna_vez_entregada: number | null; adjuntos: string }

export const nombreApp = (a: { nombre: string; apellidos: string }): string => `${a.apellidos} ${a.nombre}`.trim()

export function resumenMateria(db: DB, materiaId: number, ahora = Date.now()): ResumenClassroom {
  asegurarTablas(db)
  const cursos = db.prepare('SELECT id, nombre, seccion, enlace, sincronizado FROM classroom_cursos WHERE materia_id = ? ORDER BY nombre').all(materiaId) as
    { id: string; nombre: string; seccion: string; enlace: string; sincronizado: string | null }[]
  const ids = cursos.map((c) => c.id)
  const enCursos = `(${ids.map(() => '?').join(',') || "''"})`
  const app = alumnosDeMateria(db, materiaId)
  const appPorId = new Map(app.map((a) => [a.id, a]))

  const filasCA = db.prepare(`SELECT ca.curso_id, ca.user_id, ca.nombre, ca.email, ca.alumno_id, ca.liga, ca.sugerido_id FROM classroom_alumnos ca
    WHERE ca.activo = 1 AND ca.curso_id IN ${enCursos}`).all(...ids) as (FilaCA & { sugerido_id: number | null })[]
  // Una liga a un alumno que ya no está inscrito (o se borró) cuenta como sin ligar
  const ligadoA = (f: FilaCA): AlumnoApp | null => (f.alumno_id ? appPorId.get(f.alumno_id) ?? null : null)
  const sinLigar = (f: FilaCA & { sugerido_id: number | null }): SinLigarClassroom => ({
    clave: `${f.curso_id}:${f.user_id}`, curso_id: f.curso_id, user_id: f.user_id, nombre: f.nombre, email: f.email, liga: f.liga,
    sugerido: f.sugerido_id ? appPorId.get(f.sugerido_id) ?? null : null
  })

  const tareasF = db.prepare(`SELECT * FROM classroom_tareas WHERE curso_id IN ${enCursos} ORDER BY COALESCE(vence, creada), creada`).all(...ids) as FilaTarea[]
  const entregasF = db.prepare(`SELECT curso_id, id, tarea_id, user_id, estado, tarde, calificacion, borrador, entregada, alguna_vez_entregada, adjuntos
    FROM classroom_entregas WHERE curso_id IN ${enCursos}`).all(...ids) as FilaEntrega[]
  const entregaDe = new Map(entregasF.map((e) => [`${e.curso_id}:${e.user_id}|${e.curso_id}:${e.tarea_id}`, e]))
  const califApp = new Map(
    (db.prepare(`SELECT curso_id, entrega_id, calificacion, registrada FROM classroom_calif_app WHERE curso_id IN ${enCursos}`).all(...ids) as { curso_id: string; entrega_id: string; calificacion: number; registrada: string }[])
      .map((f) => [`${f.curso_id}:${f.entrega_id}`, f])
  )
  const fuera = new Map(
    (db.prepare(`SELECT curso_id, entrega_id, registrada FROM classroom_entregas_fuera WHERE curso_id IN ${enCursos}`).all(...ids) as { curso_id: string; entrega_id: string; registrada: string }[])
      .map((f) => [`${f.curso_id}:${f.entrega_id}`, f.registrada])
  )
  // Lo que el alumno subió desde el portal («Subir tarea») cuenta como recibido fuera de Classroom
  // (la tabla es del portal: una base que nunca lo abrió no la tiene)
  const conPortal = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subidas_alumno'").get())
  const subidas = new Map(
    ((conPortal ? db.prepare(`SELECT s.curso_id, s.tarea_id, s.alumno_id, MAX(a.subido_en) AS creada FROM subidas_alumno s JOIN archivos_subida a ON a.subida_id = s.id
        WHERE s.curso_id IN ${enCursos} GROUP BY s.id`).all(...ids) : []) as { curso_id: string; tarea_id: string; alumno_id: number; creada: string }[])
      .map((f) => [`${f.curso_id}:${f.tarea_id}:${f.alumno_id}`, isoDePortal(f.creada)])
  )

  const visibles = filasCA.filter((f) => f.liga !== 'ajeno')
  // La lista de la app manda: quien está en Classroom pero no ligado a ella no cuenta en la tabla,
  // los totales, «Por revisar» ni el Excel; solo aparece en «Sin ligar» para ligarlo a mano.
  const alumnos: AlumnoResumen[] = visibles.filter((f) => ligadoA(f)).map((f) => {
    const a = ligadoA(f)!
    return {
      clave: `${f.curso_id}:${f.user_id}`, curso_id: f.curso_id, user_id: f.user_id, alumno_id: a.id,
      nombre: nombreApp(a), matricula: a.matricula, email: f.email, liga: f.liga,
      totales: { asignadas: 0, entregadas: 0, tarde: 0, no_entrego: 0, pendiente: 0, retirada: 0, puntos_obtenidos: 0, puntos_posibles: 0 }
    }
  })
  alumnos.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'))

  // Cómo se ve cada tarea en el portal (tabla del portal: una base que nunca lo abrió no la tiene)
  const ajustesPortal = new Map(
    (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_tareas'").get()
      ? (db.prepare(`SELECT curso_id, tarea_id, visibilidad, alumnos, acepta_tarde FROM portal_tareas WHERE curso_id IN ${enCursos}`).all(...ids) as { curso_id: string; tarea_id: string; visibilidad: string; alumnos: string; acepta_tarde: number }[])
      : []
    ).map((f) => [`${f.curso_id}:${f.tarea_id}`, { visibilidad: f.visibilidad as 'todos' | 'algunos' | 'oculta', alumnos: JSON.parse(f.alumnos || '[]') as number[], acepta_tarde: !!f.acepta_tarde }])
  )
  const tareas: TareaResumen[] = tareasF.map((t) => ({
    clave: `${t.curso_id}:${t.id}`, curso_id: t.curso_id, id: t.id, titulo: t.titulo, tipo: t.tipo, puntos: t.puntos, vence: t.vence, creada: t.creada, enlace: t.enlace,
    propia: !!t.propia, descripcion: t.descripcion ?? '',
    portal: ajustesPortal.get(`${t.curso_id}:${t.id}`) ?? { visibilidad: 'todos', alumnos: [], acepta_tarde: true },
    totales: { asignadas: 0, entrego: 0, tarde: 0, no_entrego: 0, pendiente: 0, retirada: 0, calificadas: 0 }
  }))

  const entregas: CeldaEntrega[] = []
  for (const al of alumnos) {
    for (const t of tareas) {
      if (t.curso_id !== al.curso_id) continue
      const e = entregaDe.get(`${al.clave}|${t.clave}`) ?? null
      const deClassroom = estadoEntrega(e, t.vence, ahora, t.creada)
      if (deClassroom === 'no_asignada') continue
      // Lo que el docente registró a mano cuenta solo si Classroom no la tiene ya como entregada.
      // Calificar en la app también la cuenta como entregada.
      const ca = califApp.get(`${t.curso_id}:${e!.id}`)
      const subida = subidas.get(`${t.clave}:${al.alumno_id}`)
      const registrada = YA_ENTREGADA.has(deClassroom) ? undefined : fuera.get(`${t.curso_id}:${e!.id}`) ?? subida ?? ca?.registrada
      const estado = registrada ? estadoFuera(registrada, t.vence, t.creada) : deClassroom
      // Una tarea que en el portal es solo para algunos (p. ej. una recuperación) no es de los demás aunque Classroom
      // se la asigne a todo el grupo: no les cuenta como «no entregó» ni en sus totales, salvo que la hayan entregado
      if (t.portal.visibilidad === 'algunos' && !t.portal.alumnos.includes(al.alumno_id ?? -1) && estado !== 'entrego' && estado !== 'tarde' && ca === undefined) continue
      const nAdj = e ? (JSON.parse(e.adjuntos) as unknown[]).length : 0
      entregas.push({
        alumno: al.clave, tarea: t.clave, entrega_id: e!.id, estado, tarde: registrada ? estado === 'tarde' : !!e!.tarde, calificacion: ca ? ca.calificacion : e!.calificacion, borrador: e!.borrador,
        puntos: t.puntos, entregada: registrada ?? e!.entregada, adjuntos: nAdj, fuera: !!registrada, calif_app: !!ca, portal: !!subida
      })
      const calif = ca ? ca.calificacion : e!.calificacion
      const ta = al.totales
      const tt = t.totales
      ta.asignadas++
      tt.asignadas++
      if (estado === 'entrego' || estado === 'tarde') ta.entregadas++
      if (estado === 'entrego') tt.entrego++
      if (estado === 'tarde') { ta.tarde++; tt.tarde++ }
      if (estado === 'no_entrego') { ta.no_entrego++; tt.no_entrego++ }
      if (estado === 'pendiente') { ta.pendiente++; tt.pendiente++ }
      if (estado === 'retirada') { ta.retirada++; tt.retirada++ }
      if (calif !== null) {
        tt.calificadas++
        if (t.puntos) { ta.puntos_obtenidos += calif; ta.puntos_posibles += t.puntos }
      }
    }
  }

  const ligados = new Set(alumnos.map((a) => a.alumno_id).filter((x): x is number => x !== null))
  const ultima = cursos.map((c) => c.sincronizado).filter((x): x is string => !!x).sort()
  const nombres = Object.fromEntries(alumnos.map((a) => [a.clave, a.nombre]))
  return {
    materia_id: materiaId,
    cursos: cursos.map(({ id, nombre, seccion, enlace }) => ({ id, nombre, seccion, enlace })),
    sincronizado: ultima[0] ?? null,
    tareas,
    alumnos,
    entregas,
    sin_ligar: {
      classroom: visibles.filter((f) => !ligadoA(f)).map(sinLigar).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')),
      app: app.filter((a) => !ligados.has(a.id)),
      ajenos: filasCA.filter((f) => f.liga === 'ajeno').map(sinLigar)
    },
    consolidado: consolidar(db, materiaId, ids, alumnos.map((a) => a.clave), nombres, tareas, entregas)
  }
}

/** Detalle de una entrega para el panel: estado, fechas, calificación y adjuntos. */
export function detalleEntrega(db: DB, cursoId: string, entregaId: string, ahora = Date.now()): DetalleEntrega {
  asegurarTablas(db)
  const e = db.prepare(`SELECT e.*, t.titulo, t.puntos, t.vence, t.creada, t.propia, ca.nombre AS nombre_classroom, ca.alumno_id, a.nombre AS a_nombre, a.apellidos AS a_apellidos
    FROM classroom_entregas e
    JOIN classroom_tareas t ON t.curso_id = e.curso_id AND t.id = e.tarea_id
    LEFT JOIN classroom_alumnos ca ON ca.curso_id = e.curso_id AND ca.user_id = e.user_id
    LEFT JOIN alumnos a ON a.id = ca.alumno_id
    WHERE e.curso_id = ? AND e.id = ?`).get(cursoId, entregaId) as (FilaEntrega & {
      titulo: string; puntos: number | null; vence: string | null; creada: string | null; propia: number; nombre_classroom: string | null; alumno_id: number | null; a_nombre: string | null; a_apellidos: string | null
      actualizada: string | null; enlace: string; respuesta: string
    }) | undefined
  if (!e) throw new Error('Esa entrega ya no está. Sincroniza otra vez.')
  const deClassroom = estadoEntrega(e, e.vence, ahora, e.creada)
  const f = db.prepare('SELECT registrada FROM classroom_entregas_fuera WHERE curso_id = ? AND entrega_id = ?').get(cursoId, entregaId) as { registrada: string } | undefined
  const ca = db.prepare('SELECT calificacion, registrada FROM classroom_calif_app WHERE curso_id = ? AND entrega_id = ?').get(cursoId, entregaId) as { calificacion: number; registrada: string } | undefined
  const subida = e.alumno_id && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subidas_alumno'").get()
    ? (db.prepare(`SELECT s.id, s.nota, MAX(a.subido_en) AS creada FROM subidas_alumno s JOIN archivos_subida a ON a.subida_id = s.id
        WHERE s.curso_id = ? AND s.tarea_id = ? AND s.alumno_id = ? GROUP BY s.id`).get(cursoId, e.tarea_id, e.alumno_id) as
        | { id: number; nota: string; creada: string }
        | undefined)
    : undefined
  const registrada = YA_ENTREGADA.has(deClassroom) ? null : f?.registrada ?? (subida ? isoDePortal(subida.creada) : null) ?? ca?.registrada ?? null
  return {
    curso_id: cursoId, entrega_id: entregaId,
    alumno: e.a_nombre ? nombreApp({ nombre: e.a_nombre, apellidos: e.a_apellidos ?? '' }) : e.nombre_classroom ?? '(alumno)',
    tarea: e.titulo, tarea_id: e.tarea_id, estado: registrada ? estadoFuera(registrada, e.vence, e.creada) : deClassroom, estado_classroom: e.estado,
    tarde: registrada ? estadoFuera(registrada, e.vence, e.creada) === 'tarde' : !!e.tarde, fuera: registrada, puede_registrarse: !YA_ENTREGADA.has(deClassroom) && deClassroom !== 'no_asignada',
    calificacion: ca ? ca.calificacion : e.calificacion, calif_app: ca ? ca.calificacion : null, calif_classroom: e.calificacion,
    borrador: e.borrador, puntos: e.puntos, vence: e.vence, entregada: registrada ?? e.entregada, actualizada: e.actualizada,
    enlace: e.enlace, respuesta: e.respuesta, adjuntos: JSON.parse(e.adjuntos) as Adjunto[], propia: !!e.propia,
    portal: subida
      ? {
          subida: isoDePortal(subida.creada),
          nota: subida.nota,
          archivos: db.prepare('SELECT id, nombre, tamano, subido_en FROM archivos_subida WHERE subida_id = ? ORDER BY id').all(subida.id) as { id: number; nombre: string; tamano: number; subido_en: string }[]
        }
      : null
  }
}

/** El portal guarda «YYYY-MM-DD HH:MM:SS» en UTC; aquí se usa ISO */
const isoDePortal = (texto: string): string => (texto.includes('T') ? texto : `${texto.replace(' ', 'T')}Z`)

/** Nombre para archivos descargados: «Apellidos Nombre» (de la app si está ligado; si no, de Classroom). */
export function nombreParaArchivo(db: DB, cursoId: string, userId: string): string {
  const f = db.prepare(`SELECT ca.nombre, ca.nombre_pila, ca.apellidos, a.nombre AS a_nombre, a.apellidos AS a_apellidos FROM classroom_alumnos ca
    LEFT JOIN alumnos a ON a.id = ca.alumno_id WHERE ca.curso_id = ? AND ca.user_id = ?`).get(cursoId, userId) as
    { nombre: string; nombre_pila: string; apellidos: string; a_nombre: string | null; a_apellidos: string | null } | undefined
  if (!f) return 'Alumno'
  if (f.a_nombre) return nombreApp({ nombre: f.a_nombre, apellidos: f.a_apellidos ?? '' })
  return (f.apellidos && f.nombre_pila ? `${f.apellidos} ${f.nombre_pila}` : f.nombre).trim()
}

/** Material de Drive que el maestro adjuntó a la tarea: la interfaz no puede pedir archivos arbitrarios. */
export function materialDeTarea(db: DB, cursoId: string, tareaId: string, archivoId: string): { titulo: string; enlace: string } {
  asegurarTablas(db)
  const t = db.prepare('SELECT materiales FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { materiales: string } | undefined
  const m = t ? (JSON.parse(t.materiales || '[]') as { tipo: string; id?: string; titulo: string; enlace: string }[]).find((x) => x.tipo === 'drive' && x.id === archivoId) : undefined
  if (!m) throw new Error('Ese archivo no es material de la tarea. Sincroniza otra vez.')
  return { titulo: m.titulo, enlace: m.enlace }
}

/** El archivo de Drive pertenece a alguna entrega guardada: la interfaz no puede pedir archivos arbitrarios. */
export function adjuntoDeEntrega(db: DB, cursoId: string, entregaId: string, archivoId: string): { adjunto: Extract<Adjunto, { tipo: 'drive' }>; user_id: string } {
  asegurarTablas(db)
  const e = db.prepare('SELECT user_id, adjuntos FROM classroom_entregas WHERE curso_id = ? AND id = ?').get(cursoId, entregaId) as { user_id: string; adjuntos: string } | undefined
  const adj = e ? (JSON.parse(e.adjuntos) as Adjunto[]).find((a): a is Extract<Adjunto, { tipo: 'drive' }> => a.tipo === 'drive' && a.id === archivoId) : undefined
  if (!e || !adj) throw new Error('Ese archivo no pertenece a la entrega. Sincroniza otra vez.')
  return { adjunto: adj, user_id: e.user_id }
}

/** Archivos de Drive de todas las entregas de una tarea, con quién los entregó. */
export function adjuntosDeTarea(db: DB, cursoId: string, tareaId: string): { user_id: string; entrega_id: string; adjuntos: Adjunto[] }[] {
  asegurarTablas(db)
  const filas = db.prepare(`SELECT e.id, e.user_id, e.adjuntos FROM classroom_entregas e
    LEFT JOIN classroom_alumnos ca ON ca.curso_id = e.curso_id AND ca.user_id = e.user_id
    WHERE e.curso_id = ? AND e.tarea_id = ? AND COALESCE(ca.liga, '') <> 'ajeno'`).all(cursoId, tareaId) as { id: string; user_id: string; adjuntos: string }[]
  return filas.map((f) => ({ user_id: f.user_id, entrega_id: f.id, adjuntos: JSON.parse(f.adjuntos) as Adjunto[] }))
}
