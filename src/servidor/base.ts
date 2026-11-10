import Database from 'better-sqlite3'
import esquemaApp from '../main/schema.sql?raw'
import esquemaPortal from '../shared/esquema-portal.sql?raw'
import { asegurarTablas } from '../main/services/classroom-datos'
import { prepararCambios } from './cambios'

/**
 * Abre la base de datos y deja el esquema al día. La usan la app de escritorio y el
 * servidor web, de modo que ambos ven exactamente las mismas tablas.
 */
export function abrirBase(ruta: string): Database.Database {
  const db = new Database(ruta)
  db.exec(esquemaApp)
  db.exec(esquemaPortal)
  migrar(db)
  // Registro de cambios para sincronizar en dos sentidos: con todas las tablas ya creadas (Classroom incluido)
  asegurarTablas(db)
  prepararCambios(db)
  return db
}

/** Columnas añadidas después de la primera versión. Cada una se agrega solo si falta. */
function migrar(db: Database.Database): void {
  const columnasDe = (tabla: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).map((c) => c.name))

  const sesiones = columnasDe('sesiones')
  if (!sesiones.has('presentacion_path')) db.exec('ALTER TABLE sesiones ADD COLUMN presentacion_path TEXT')

  // Cada parcial se publica a los alumnos («Mi avance») cuando el docente lo decide
  if (!columnasDe('calif_parciales').has('publicado')) db.exec('ALTER TABLE calif_parciales ADD COLUMN publicado INTEGER NOT NULL DEFAULT 0')

  // Juego en vivo: el invitado que sale retoma su lugar con su clave, aunque el servidor se haya reiniciado
  if (!columnasDe('participantes').has('clave')) db.exec('ALTER TABLE participantes ADD COLUMN clave TEXT')

  if (!columnasDe('asignaciones').has('cerrar_al_salir')) db.exec('ALTER TABLE asignaciones ADD COLUMN cerrar_al_salir INTEGER NOT NULL DEFAULT 0')
  // Bloqueo de examen (pantalla completa y nada más que el examen hasta enviarlo) y su excepción por alumno
  if (!columnasDe('asignaciones').has('bloqueo')) db.exec('ALTER TABLE asignaciones ADD COLUMN bloqueo INTEGER NOT NULL DEFAULT 0')
  if (!columnasDe('intentos').has('desbloqueado')) db.exec('ALTER TABLE intentos ADD COLUMN desbloqueado INTEGER NOT NULL DEFAULT 0')
  // Preguntas al azar por alumno: la regla en la asignación y el sorteo de cada quien en su intento
  if (!columnasDe('asignaciones').has('azar')) db.exec("ALTER TABLE asignaciones ADD COLUMN azar TEXT NOT NULL DEFAULT ''")
  if (!columnasDe('intentos').has('seleccion')) db.exec("ALTER TABLE intentos ADD COLUMN seleccion TEXT NOT NULL DEFAULT ''")
  // Candado: contestar todas antes de poder enviar
  if (!columnasDe('asignaciones').has('todas_obligatorias')) db.exec('ALTER TABLE asignaciones ADD COLUMN todas_obligatorias INTEGER NOT NULL DEFAULT 0')
  // Revisión de aciertos para el alumno y cuánto vale el examen en su parcial
  if (!columnasDe('asignaciones').has('mostrar_respuestas')) db.exec("ALTER TABLE asignaciones ADD COLUMN mostrar_respuestas TEXT NOT NULL DEFAULT 'al_cerrar'")
  if (!columnasDe('asignaciones').has('ponderacion')) {
    db.exec('ALTER TABLE asignaciones ADD COLUMN ponderacion REAL NOT NULL DEFAULT 0')
    // Los exámenes ya publicados toman el peso del examen en el esquema de su materia (o 30 %)
    const examenes = db.prepare("SELECT a.id, a.materia_id FROM asignaciones a JOIN evaluaciones e ON e.id = a.evaluacion_id WHERE e.tipo = 'examen'").all() as { id: number; materia_id: number }[]
    const poner = db.prepare('UPDATE asignaciones SET ponderacion = ? WHERE id = ?')
    for (const x of examenes) poner.run(pesoDelExamen(db, x.materia_id), x.id)
  }

  const materias = columnasDe('materias')
  // Pestaña «Programar» del portal por materia (en Álgebra no se programa)
  if (!materias.has('portal_programar')) db.exec('ALTER TABLE materias ADD COLUMN portal_programar INTEGER NOT NULL DEFAULT 1')
  // Materiales que el docente comparte en el portal
  if (!columnasDe('materiales').has('compartido')) db.exec('ALTER TABLE materiales ADD COLUMN compartido INTEGER NOT NULL DEFAULT 0')
  if (!materias.has('oculta')) db.exec('ALTER TABLE materias ADD COLUMN oculta INTEGER NOT NULL DEFAULT 0')
  if (!materias.has('docente_id')) db.exec('ALTER TABLE materias ADD COLUMN docente_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL')

  // La matrícula dejó de ser obligatoria. SQLite no permite quitar un UNIQUE de columna,
  // así que la tabla se reconstruye una sola vez (con las claves foráneas apagadas para no arrastrar inscripciones).
  const indicesAlumnos = db.prepare('PRAGMA index_list(alumnos)').all() as { name: string; origin: string }[]
  if (indicesAlumnos.some((i) => i.origin === 'u')) {
    db.pragma('foreign_keys = OFF')
    db.exec(`
      BEGIN;
      CREATE TABLE alumnos_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matricula TEXT NOT NULL DEFAULT '',
        nombre TEXT NOT NULL,
        apellidos TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        carrera_id INTEGER REFERENCES carreras(id) ON DELETE SET NULL,
        activo INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO alumnos_nueva (id, matricula, nombre, apellidos, email, carrera_id, activo)
        SELECT id, matricula, nombre, apellidos, email, carrera_id, activo FROM alumnos;
      DROP TABLE alumnos;
      ALTER TABLE alumnos_nueva RENAME TO alumnos;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_alumnos_matricula ON alumnos(matricula) WHERE matricula <> '';
      COMMIT;
    `)
    db.pragma('foreign_keys = ON')
  }

  // Las fuentes de Classroom llegaron después de crear calif_componentes: su CHECK no las admite.
  // Se reconstruye la tabla una sola vez con las claves foráneas apagadas (así no se borran las capturas).
  const defComponentes = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='calif_componentes'").get() as { sql: string } | undefined)?.sql
  if (defComponentes && !defComponentes.includes('classroom_promedio')) {
    db.pragma('foreign_keys = OFF')
    db.exec(`
      BEGIN;
      CREATE TABLE calif_componentes_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parcial_id INTEGER NOT NULL REFERENCES calif_parciales(id) ON DELETE CASCADE,
        orden INTEGER NOT NULL,
        nombre TEXT NOT NULL,
        peso REAL NOT NULL,
        fuente TEXT NOT NULL CHECK (fuente IN ('evaluaciones', 'asistencia', 'actividades', 'participacion', 'manual', 'classroom_promedio', 'classroom_entregas')),
        evaluaciones TEXT NOT NULL DEFAULT '[]',
        escala REAL NOT NULL DEFAULT 10,
        rubros TEXT NOT NULL DEFAULT '[]',
        meta REAL NOT NULL DEFAULT 5
      );
      INSERT INTO calif_componentes_nueva (id, parcial_id, orden, nombre, peso, fuente, evaluaciones, escala, rubros, meta)
        SELECT id, parcial_id, orden, nombre, peso, fuente, evaluaciones, escala, rubros, meta FROM calif_componentes;
      DROP TABLE calif_componentes;
      ALTER TABLE calif_componentes_nueva RENAME TO calif_componentes;
      CREATE INDEX IF NOT EXISTS idx_calif_componentes_parcial ON calif_componentes(parcial_id, orden);
      COMMIT;
    `)
    db.pragma('foreign_keys = ON')
  }
}

export function leerAjuste(db: Database.Database, clave: string, def = ''): string {
  const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave) as { valor: string } | undefined
  return fila ? fila.valor : def
}

export function escribirAjuste(db: Database.Database, clave: string, valor: string): void {
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, valor)
}

/**
 * Nombre de carrera de una materia (alias `m` para materias y `c` para su carrera): el de las carreras de sus
 * alumnos inscritos activos, juntas si son varias (Álgebra con Industrial y Diseño Industrial); si no tiene
 * alumnos, la carrera registrada en la materia.
 */
export const SQL_CARRERA_MATERIA = `COALESCE((SELECT group_concat(nombre, ' · ') FROM (SELECT DISTINCT c2.nombre FROM inscripciones i2 JOIN alumnos a2 ON a2.id = i2.alumno_id
  JOIN carreras c2 ON c2.id = a2.carrera_id WHERE i2.materia_id = m.id AND a2.activo = 1 ORDER BY c2.nombre)), c.nombre) AS carrera_nombre`

/** Peso por omisión de un examen en su parcial si la materia no tiene esquema con examen */
export const PESO_EXAMEN = 30

/**
 * Cuánto vale el examen en el parcial según el esquema de calificación de la materia: el componente que se
 * llame «examen…» del parcial que cubre la fecha (o del primero que lo tenga). Sin esquema, 30 %.
 */
export function pesoDelExamen(db: Database.Database, materiaId: number, fecha = new Date().toISOString().slice(0, 10)): number {
  const filas = db
    .prepare(
      `SELECT c.peso, p.desde, p.hasta FROM calif_componentes c JOIN calif_parciales p ON p.id = c.parcial_id
       WHERE p.materia_id = ? AND c.nombre LIKE '%examen%' ORDER BY p.orden, c.orden`
    )
    .all(materiaId) as { peso: number; desde: string; hasta: string }[]
  const delParcial = filas.find((f) => fecha >= f.desde && fecha <= f.hasta) ?? filas[0]
  return delParcial && delParcial.peso > 0 ? delParcial.peso : PESO_EXAMEN
}
