/**
 * Tareas de la app: agrupan las tareas duplicadas de Classroom («1er Tarea» + «Subida de Tarea 1» = Tarea 1)
 * y acreditan las tareas de recuperación «comodín» a la que le falte a cada alumno. Así el maestro
 * revisa una sola vez por alumno y tarea. Las decisiones se guardan y se respetan al re-sincronizar.
 */
import type Database from 'better-sqlite3'
import type {
  AlumnoResumen, AmbiguaComodin, CeldaApp, CeldaEntrega, Comodin, Consolidacion, EstadoEntrega, FuenteEntrega, ReglaCalificacion, SugerenciaGrupo, TareaApp, TareaResumen
} from '@shared/classroom'

type DB = Database.Database

const TABLAS = `
CREATE TABLE IF NOT EXISTS classroom_tareas_app (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  regla TEXT NOT NULL DEFAULT 'alta'
);
CREATE TABLE IF NOT EXISTS classroom_tareas_grupo (
  curso_id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  tarea_app_id INTEGER NOT NULL REFERENCES classroom_tareas_app(id) ON DELETE CASCADE,
  PRIMARY KEY (curso_id, tarea_id)
);
CREATE TABLE IF NOT EXISTS classroom_comodines (
  curso_id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  cubre TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (curso_id, tarea_id)
);
CREATE TABLE IF NOT EXISTS classroom_comodin_decisiones (
  curso_id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tarea_app_id INTEGER,
  PRIMARY KEY (curso_id, tarea_id, user_id)
);
`
const listas = new WeakSet<DB>()
export function asegurarTablasApp(db: DB): void {
  if (listas.has(db)) return
  db.exec(TABLAS)
  listas.add(db)
}

// ---------- Sugerencias por título ----------

const ORDINALES: [RegExp, string][] = [
  [/\b(1er|1ero|1ro|1ra|1a|1o|primer|primera|primero)\b/g, '1'],
  [/\b(2do|2da|2o|2a|segunda|segundo)\b/g, '2'],
  [/\b(3er|3ero|3ro|3ra|3a|3o|tercer|tercera|tercero)\b/g, '3'],
  [/\b(4to|4ta|4o|4a|cuarta|cuarto)\b/g, '4'],
  [/\b(5to|5ta|5o|5a|quinta|quinto)\b/g, '5'],
  [/\b(6to|6ta|sexta|sexto)\b/g, '6'],
  [/\b(7mo|7ma|septima|septimo)\b/g, '7'],
  [/\b(8vo|8va|octava|octavo)\b/g, '8'],
  [/\b(9no|9na|novena|noveno)\b/g, '9'],
  [/\b(10mo|10ma|decima|decimo)\b/g, '10']
]
const TIPOS = ['tarea', 'practica', 'actividad', 'ejercicio', 'ejercicios', 'proyecto', 'reporte', 'investigacion', 'cuestionario', 'examen', 'evaluacion', 'laboratorio', 'taller']

/** «1er Tarea», «Subida de Tarea 1» y «Tarea 1 (recuperación)» dan la misma clave: «tarea 1». */
export function claveTitulo(titulo: string): { clave: string | null; nombre: string; comodin: boolean } {
  let n = titulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  for (const [re, num] of ORDINALES) n = n.replace(re, num)
  n = n.replace(/\b(re)?(subida|subir|envio|entrega|correccion|recuperacion|reposicion)\s+(de|del)\b/g, ' ')
  const tipo = n.split(/\s+/).find((p) => TIPOS.includes(p))
  const numero = /\b(\d{1,2})\b/.exec(n)?.[1]
  if (tipo && numero) {
    const t = tipo === 'ejercicios' ? 'ejercicio' : tipo
    return { clave: `${t} ${Number(numero)}`, nombre: `${t[0].toUpperCase()}${t.slice(1).replace('practica', 'práctica').replace('investigacion', 'investigación').replace('evaluacion', 'evaluación')} ${Number(numero)}`, comodin: false }
  }
  const comodin = !numero && /\b(falto|faltaron|faltante|faltantes|recuperacion|recuperar|rezagad[ao]s?|atrasad[ao]s?|pendientes?|extemporane[ao]s?)\b/.test(n)
  return { clave: null, nombre: titulo, comodin }
}

// ---------- Cambios que hace el maestro ----------

function materiaDeCurso(db: DB, cursoId: string): number {
  const c = db.prepare('SELECT materia_id FROM classroom_cursos WHERE id = ?').get(cursoId) as { materia_id: number | null } | undefined
  if (!c?.materia_id) throw new Error('Ese curso de Classroom no está ligado a una materia.')
  return c.materia_id
}

function materiaDeTareaApp(db: DB, id: number): number {
  const t = db.prepare('SELECT materia_id FROM classroom_tareas_app WHERE id = ?').get(id) as { materia_id: number } | undefined
  if (!t) throw new Error('Esa tarea de la app ya no existe.')
  return t.materia_id
}

const separar = (clave: string): [string, string] => {
  const i = clave.indexOf(':')
  if (i < 1) throw new Error('Tarea no válida.')
  return [clave.slice(0, i), clave.slice(i + 1)]
}

/** Pone una tarea de Classroom dentro de una tarea de la app (o la deja suelta con null). Deja de ser comodín. */
export function asignarTarea(db: DB, claveClassroom: string, tareaAppId: number | null): void {
  asegurarTablasApp(db)
  const [curso, tarea] = separar(claveClassroom)
  if (tareaAppId !== null && materiaDeTareaApp(db, tareaAppId) !== materiaDeCurso(db, curso)) throw new Error('Esa tarea de Classroom es de un curso ligado a otra materia.')
  db.transaction(() => {
    db.prepare('DELETE FROM classroom_comodines WHERE curso_id = ? AND tarea_id = ?').run(curso, tarea)
    db.prepare('DELETE FROM classroom_tareas_grupo WHERE curso_id = ? AND tarea_id = ?').run(curso, tarea)
    if (tareaAppId !== null) db.prepare('INSERT INTO classroom_tareas_grupo (curso_id, tarea_id, tarea_app_id) VALUES (?, ?, ?)').run(curso, tarea, tareaAppId)
  })()
}

export function crearTareaApp(db: DB, materiaId: number, nombre: string, claves: string[] = []): number {
  asegurarTablasApp(db)
  const n = nombre.trim()
  if (!n) throw new Error('Escribe el nombre de la tarea.')
  const id = Number(db.prepare('INSERT INTO classroom_tareas_app (materia_id, nombre) VALUES (?, ?)').run(materiaId, n).lastInsertRowid)
  for (const c of claves) asignarTarea(db, c, id)
  return id
}

export function actualizarTareaApp(db: DB, id: number, cambios: { nombre?: string; regla?: ReglaCalificacion }): void {
  asegurarTablasApp(db)
  materiaDeTareaApp(db, id)
  if (cambios.nombre !== undefined) {
    if (!cambios.nombre.trim()) throw new Error('El nombre no puede quedar vacío.')
    db.prepare('UPDATE classroom_tareas_app SET nombre = ? WHERE id = ?').run(cambios.nombre.trim(), id)
  }
  if (cambios.regla) db.prepare('UPDATE classroom_tareas_app SET regla = ? WHERE id = ?').run(cambios.regla === 'ultima' ? 'ultima' : 'alta', id)
}

/** Borra la tarea de la app; sus tareas de Classroom vuelven a quedar sueltas. */
export function eliminarTareaApp(db: DB, id: number): void {
  asegurarTablasApp(db)
  db.transaction(() => {
    db.prepare('DELETE FROM classroom_tareas_grupo WHERE tarea_app_id = ?').run(id)
    db.prepare('DELETE FROM classroom_comodin_decisiones WHERE tarea_app_id = ?').run(id)
    db.prepare('DELETE FROM classroom_tareas_app WHERE id = ?').run(id)
  })()
}

/** Marca (o desmarca) una tarea de Classroom como recuperación comodín. `cubre` vacío = todas las anteriores. */
export function marcarComodin(db: DB, claveClassroom: string, comodin: boolean, cubre: number[] = []): void {
  asegurarTablasApp(db)
  const [curso, tarea] = separar(claveClassroom)
  const materia = materiaDeCurso(db, curso)
  for (const id of cubre) if (materiaDeTareaApp(db, id) !== materia) throw new Error('Una de las tareas elegidas es de otra materia.')
  db.transaction(() => {
    db.prepare('DELETE FROM classroom_tareas_grupo WHERE curso_id = ? AND tarea_id = ?').run(curso, tarea)
    if (!comodin) {
      db.prepare('DELETE FROM classroom_comodines WHERE curso_id = ? AND tarea_id = ?').run(curso, tarea)
      db.prepare('DELETE FROM classroom_comodin_decisiones WHERE curso_id = ? AND tarea_id = ?').run(curso, tarea)
      return
    }
    db.prepare(`INSERT INTO classroom_comodines (curso_id, tarea_id, cubre) VALUES (?, ?, ?)
      ON CONFLICT(curso_id, tarea_id) DO UPDATE SET cubre = excluded.cubre`).run(curso, tarea, JSON.stringify(cubre))
  })()
}

/** Decisión del maestro para un alumno: a qué tarea de la app acreditar la comodín ('ninguna' o 'auto' para volver a la regla). */
export function decidirComodin(db: DB, claveClassroom: string, userId: string, destino: number | 'ninguna' | 'auto'): void {
  asegurarTablasApp(db)
  const [curso, tarea] = separar(claveClassroom)
  if (!db.prepare('SELECT 1 FROM classroom_comodines WHERE curso_id = ? AND tarea_id = ?').get(curso, tarea)) throw new Error('Esa tarea ya no está marcada como comodín.')
  if (destino === 'auto') {
    db.prepare('DELETE FROM classroom_comodin_decisiones WHERE curso_id = ? AND tarea_id = ? AND user_id = ?').run(curso, tarea, userId)
    return
  }
  if (destino !== 'ninguna' && materiaDeTareaApp(db, destino) !== materiaDeCurso(db, curso)) throw new Error('Esa tarea es de otra materia.')
  db.prepare(`INSERT INTO classroom_comodin_decisiones (curso_id, tarea_id, user_id, tarea_app_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(curso_id, tarea_id, user_id) DO UPDATE SET tarea_app_id = excluded.tarea_app_id`).run(curso, tarea, userId, destino === 'ninguna' ? null : destino)
}

// ---------- Consolidación ----------

const entregada = (e: EstadoEntrega): boolean => e === 'entrego' || e === 'tarde'
const nota = (f: FuenteEntrega): number => f.calificacion ?? f.borrador ?? -Infinity

/** La entrega que cuenta: la de calificación más alta (empate: la primera) o la última entregada. */
function queCuenta(fuentes: FuenteEntrega[], regla: ReglaCalificacion): FuenteEntrega {
  const orden = [...fuentes]
  if (regla === 'ultima') orden.sort((a, b) => (b.entregada ?? '').localeCompare(a.entregada ?? ''))
  else orden.sort((a, b) => nota(b) - nota(a) || (a.entregada ?? '~').localeCompare(b.entregada ?? '~'))
  return orden[0]
}

const lista = (nombres: string[]): string => (nombres.length <= 1 ? nombres.join('') : `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`)

const vacio = (): AlumnoResumen['totales'] => ({ asignadas: 0, entregadas: 0, tarde: 0, no_entrego: 0, pendiente: 0, retirada: 0, puntos_obtenidos: 0, puntos_posibles: 0 })

export function consolidar(
  db: DB,
  materiaId: number,
  cursos: string[],
  alumnos: string[],
  nombres: Record<string, string>,
  tareas: TareaResumen[],
  entregas: CeldaEntrega[]
): Consolidacion {
  asegurarTablasApp(db)
  const enCursos = `(${cursos.map(() => '?').join(',') || "''"})`
  const apps = db.prepare('SELECT id, nombre, regla FROM classroom_tareas_app WHERE materia_id = ? ORDER BY id').all(materiaId) as { id: number; nombre: string; regla: ReglaCalificacion }[]
  const grupos = db.prepare(`SELECT g.curso_id, g.tarea_id, g.tarea_app_id FROM classroom_tareas_grupo g JOIN classroom_tareas_app a ON a.id = g.tarea_app_id
    WHERE a.materia_id = ?`).all(materiaId) as { curso_id: string; tarea_id: string; tarea_app_id: number }[]
  const comodinesF = db.prepare(`SELECT curso_id, tarea_id, cubre FROM classroom_comodines WHERE curso_id IN ${enCursos}`).all(...cursos) as { curso_id: string; tarea_id: string; cubre: string }[]
  const decisiones = new Map(
    (db.prepare(`SELECT curso_id, tarea_id, user_id, tarea_app_id FROM classroom_comodin_decisiones WHERE curso_id IN ${enCursos}`).all(...cursos) as
      { curso_id: string; tarea_id: string; user_id: string; tarea_app_id: number | null }[]).map((d) => [`${d.curso_id}:${d.tarea_id}|${d.user_id}`, d.tarea_app_id])
  )

  const porClave = new Map(tareas.map((t) => [t.clave, t]))
  const referencia = (t: TareaResumen): string | null => t.vence ?? t.creada
  const esComodin = new Set(comodinesF.map((c) => `${c.curso_id}:${c.tarea_id}`).filter((k) => porClave.has(k)))
  const enGrupo = new Map<string, number>()
  for (const g of grupos) {
    const k = `${g.curso_id}:${g.tarea_id}`
    if (porClave.has(k) && !esComodin.has(k)) enGrupo.set(k, g.tarea_app_id)
  }

  const minimo = (fechas: (string | null)[]): string | null => fechas.filter((x): x is string => !!x).sort()[0] ?? null
  const columnas: TareaApp[] = [
    ...apps.map((a) => {
      const claves = tareas.filter((t) => enGrupo.get(t.clave) === a.id).map((t) => t.clave)
      return { clave: `app:${a.id}`, id: a.id, nombre: a.nombre, regla: a.regla, tareas: claves, referencia: minimo(claves.map((k) => referencia(porClave.get(k)!))), totales: { asignadas: 0, entrego: 0, tarde: 0, no_entrego: 0, pendiente: 0, retirada: 0, calificadas: 0 } }
    }),
    ...tareas.filter((t) => !enGrupo.has(t.clave) && !esComodin.has(t.clave)).map((t): TareaApp => ({
      clave: `cr:${t.clave}`, id: null, nombre: t.titulo, regla: 'alta', tareas: [t.clave], referencia: referencia(t),
      totales: { asignadas: 0, entrego: 0, tarde: 0, no_entrego: 0, pendiente: 0, retirada: 0, calificadas: 0 }
    }))
  ].sort((a, b) => (a.referencia ?? '~').localeCompare(b.referencia ?? '~') || a.nombre.localeCompare(b.nombre, 'es'))
  const posicion = new Map(columnas.map((c, i) => [c.clave, i]))
  const nombreCol = new Map(columnas.map((c) => [c.clave, c.nombre]))

  const comodines: Comodin[] = comodinesF
    .filter((c) => porClave.has(`${c.curso_id}:${c.tarea_id}`))
    .map((c) => {
      const t = porClave.get(`${c.curso_id}:${c.tarea_id}`)!
      const cubre = (JSON.parse(c.cubre) as number[]).filter((id) => apps.some((a) => a.id === id))
      const ref = referencia(t)
      // «Todas las anteriores»: las tareas de la app cuya fecha es anterior a la comodín
      const efectivo = cubre.length ? cubre : columnas.filter((col) => col.id !== null && (!ref || !col.referencia || col.referencia <= ref)).map((col) => col.id!)
      efectivo.sort((x, y) => (posicion.get(`app:${x}`) ?? 0) - (posicion.get(`app:${y}`) ?? 0))
      return { clave: t.clave, curso_id: c.curso_id, tarea_id: c.tarea_id, titulo: t.titulo, cubre, cubre_efectivo: efectivo }
    })
    .sort((a, b) => (referencia(porClave.get(a.clave)!) ?? '~').localeCompare(referencia(porClave.get(b.clave)!) ?? '~'))

  const celdaDe = new Map(entregas.map((e) => [`${e.alumno}|${e.tarea}`, e]))
  const fuente = (e: CeldaEntrega, comodin: boolean): FuenteEntrega => {
    const [curso] = separar(e.tarea)
    return {
      curso_id: curso, entrega_id: e.entrega_id, tarea: e.tarea, titulo: porClave.get(e.tarea)?.titulo ?? '', estado: e.estado, tarde: e.tarde,
      calificacion: e.calificacion, borrador: e.borrador, puntos: e.puntos, entregada: e.entregada, adjuntos: e.adjuntos, comodin
    }
  }

  const celdas: CeldaApp[] = []
  const resolucion: Record<string, string> = {}
  const resolucionDetalle: Consolidacion['resolucion_detalle'] = {}
  const totales: Record<string, AlumnoResumen['totales']> = {}
  const ambiguas: AmbiguaComodin[] = []
  const adicionales: Consolidacion['adicionales'] = []

  for (const al of alumnos) {
    const [cursoAl, userId] = separar(al)
    const todas = new Map<string, FuenteEntrega[]>()
    const hechas = new Map<string, FuenteEntrega[]>()
    for (const col of columnas) {
      todas.set(col.clave, [])
      hechas.set(col.clave, [])
      for (const k of col.tareas) {
        const e = celdaDe.get(`${al}|${k}`)
        if (!e) continue
        const f = fuente(e, false)
        todas.get(col.clave)!.push(f)
        if (entregada(f.estado)) hechas.get(col.clave)!.push(f)
      }
    }
    const notas: string[] = []
    const ambiguaEn = new Map<string, string>()
    for (const com of comodines) {
      if (com.curso_id !== cursoAl) continue
      const e = celdaDe.get(`${al}|${com.clave}`)
      if (!e || !entregada(e.estado)) continue
      const opciones = com.cubre_efectivo.map((id) => `app:${id}`).filter((k) => hechas.has(k))
      const faltan = opciones.filter((k) => !hechas.get(k)!.length)
      const clave = `${com.clave}|${userId}`
      let destino: string | null = null
      let ambigua = false
      let decidida = false
      if (decisiones.has(clave)) {
        const d = decisiones.get(clave)
        const k = d ? `app:${d}` : null
        if (k === null || opciones.includes(k)) {
          destino = k
          decidida = true
        }
      }
      if (!decidida) {
        if (faltan.length === 1) destino = faltan[0]
        else if (faltan.length > 1) {
          // Por omisión a la más antigua que le falta, pero el maestro debe confirmar
          destino = faltan[0]
          ambigua = true
        }
      }
      if (destino) {
        const f = fuente(e, true)
        hechas.get(destino)!.push(f)
        todas.get(destino)!.push(f)
        if (ambigua) {
          ambiguaEn.set(destino, com.titulo)
          notas.push(`«${com.titulo}» aplicada a ${nombreCol.get(destino)} — decide cuál acreditar`)
        }
      } else if (decidida) {
        notas.push(`«${com.titulo}» no se acreditó (lo decidiste tú)`)
      } else {
        // No le faltaba nada: la recuperación cuenta como nota adicional (solo si sube el promedio)
        const ya = opciones.map((k) => nombreCol.get(k)!)
        notas.push(`«${com.titulo}» entregada además de ${ya.length === 2 ? 'las dos' : ya.length > 2 ? `las ${ya.length}` : lista(ya) || 'las demás'} (nota adicional)`)
        adicionales.push({ alumno: al, comodin: com.clave, titulo: com.titulo, fecha: referencia(porClave.get(com.clave)!), calificacion: e.calificacion ?? e.borrador, puntos: e.puntos })
      }
      if (ambigua) {
        ambiguas.push({
          alumno: al, nombre: nombres[al] ?? al, comodin: com.clave, titulo: com.titulo, curso_id: com.curso_id, tarea_id: com.tarea_id, user_id: userId,
          opciones, acreditada: destino
        })
      }
    }

    const tot = vacio()
    const partes: string[] = []
    const detalle: Consolidacion['resolucion_detalle'][string]['tareas'] = []
    for (const col of columnas) {
      const hay = hechas.get(col.clave)!
      const todo = todas.get(col.clave)!
      if (!todo.length) continue
      let celda: CeldaApp
      if (hay.length) {
        const cuenta = queCuenta(hay, col.regla)
        celda = {
          alumno: al, tarea_app: col.clave, estado: cuenta.tarde ? 'tarde' : 'entrego', tarde: cuenta.tarde, calificacion: cuenta.calificacion, borrador: cuenta.borrador,
          puntos: cuenta.puntos, entregada: cuenta.entregada, cuenta, otras: todo.filter((f) => f !== cuenta), veces: hay.length, comodin: cuenta.comodin,
          ambigua: ambiguaEn.has(col.clave)
        }
        if (!celda.ambigua) {
          const otrasHechas = hay.filter((f) => f !== cuenta).map((f) => `«${f.titulo}»`)
          partes.push(`${col.nombre} en «${cuenta.titulo}»${otrasHechas.length ? ` (también en ${lista(otrasHechas)})` : ''}`)
          detalle.push({ tarea: col.nombre, en: cuenta.titulo, tambien: hay.filter((f) => f !== cuenta).map((f) => f.titulo) })
        }
      } else {
        const estado: EstadoEntrega = todo.some((f) => f.estado === 'pendiente') ? 'pendiente' : todo.some((f) => f.estado === 'retirada') ? 'retirada' : 'no_entrego'
        celda = { alumno: al, tarea_app: col.clave, estado, tarde: false, calificacion: null, borrador: null, puntos: todo[0].puntos, entregada: null, cuenta: null, otras: todo, veces: 0, comodin: false, ambigua: false }
      }
      celdas.push(celda)
      const ct = col.totales
      tot.asignadas++
      ct.asignadas++
      if (entregada(celda.estado)) tot.entregadas++
      if (celda.estado === 'entrego') ct.entrego++
      if (celda.estado === 'tarde') { tot.tarde++; ct.tarde++ }
      if (celda.estado === 'no_entrego') { tot.no_entrego++; ct.no_entrego++ }
      if (celda.estado === 'pendiente') { tot.pendiente++; ct.pendiente++ }
      if (celda.estado === 'retirada') { tot.retirada++; ct.retirada++ }
      if (celda.calificacion !== null) {
        ct.calificadas++
        if (celda.puntos) { tot.puntos_obtenidos += celda.calificacion; tot.puntos_posibles += celda.puntos }
      }
    }
    totales[al] = tot
    resolucion[al] = [...partes, ...notas].join(' · ') || 'Sin entregas'
    resolucionDetalle[al] = { tareas: detalle, notas }
  }

  // ---- Sugerencias para lo que aún no se agrupa ----
  const sueltas = tareas.filter((t) => !enGrupo.has(t.clave) && !esComodin.has(t.clave))
  const porNombre = new Map<string, SugerenciaGrupo>()
  const sugComodines: { clave: string; titulo: string }[] = []
  for (const t of sueltas) {
    const k = claveTitulo(t.titulo)
    if (k.comodin) {
      sugComodines.push({ clave: t.clave, titulo: t.titulo })
      continue
    }
    if (!k.clave) continue
    if (!porNombre.has(k.clave)) {
      const existente = apps.find((a) => claveTitulo(a.nombre).clave === k.clave)
      porNombre.set(k.clave, { nombre: existente?.nombre ?? k.nombre, tarea_app_id: existente?.id ?? null, tareas: [] })
    }
    porNombre.get(k.clave)!.tareas.push({ clave: t.clave, titulo: t.titulo })
  }

  const nombreDe = (k: string): string => nombres[k] ?? k
  return {
    tareas: columnas,
    comodines,
    celdas,
    resolucion,
    resolucion_detalle: resolucionDetalle,
    totales,
    por_revisar: {
      sin_calificar: celdas.filter((c) => c.cuenta && c.cuenta.calificacion === null)
        .map((c) => ({ alumno: c.alumno, nombre: nombreDe(c.alumno), tarea_app: c.tarea_app, tarea_nombre: nombreCol.get(c.tarea_app) ?? '', fuente: c.cuenta! })),
      ambiguas,
      sin_entrega: celdas.filter((c) => c.estado === 'no_entrego').map((c) => ({ alumno: c.alumno, nombre: nombreDe(c.alumno), tarea_app: c.tarea_app, tarea_nombre: nombreCol.get(c.tarea_app) ?? '' }))
    },
    sugerencias: { grupos: [...porNombre.values()], comodines: sugComodines },
    adicionales
  }
}

/** Acepta todas las sugerencias de la materia: crea las tareas de la app y marca las comodines. */
export function aceptarSugerencias(db: DB, materiaId: number, s: Consolidacion['sugerencias']): number {
  let n = 0
  db.transaction(() => {
    for (const g of s.grupos) {
      if (g.tarea_app_id) for (const t of g.tareas) asignarTarea(db, t.clave, g.tarea_app_id)
      else crearTareaApp(db, materiaId, g.nombre, g.tareas.map((t) => t.clave))
      n++
    }
    for (const c of s.comodines) {
      marcarComodin(db, c.clave, true)
      n++
    }
  })()
  return n
}
