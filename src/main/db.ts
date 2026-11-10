import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { format, addDays, startOfWeek } from 'date-fns'
import { abrirBase } from '../servidor/base'
import { aplicarSemillas } from './semillas'

let db: Database.Database

export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'datos')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function materialesDir(): string {
  const dir = join(dataDir(), 'materiales')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Copia consistente de la base (aunque esté en uso) en datos/respaldos/<prefijo>-<sello>.sqlite.
 * Se conservan las últimas `conservar` de ese prefijo. Devuelve la ruta, o null si ya existía.
 */
export async function respaldar(prefijo: string, sello: string, conservar: number): Promise<string | null> {
  const carpeta = join(dataDir(), 'respaldos')
  mkdirSync(carpeta, { recursive: true })
  const destino = join(carpeta, `${prefijo}-${sello}.sqlite`)
  if (existsSync(destino)) return null
  await getDb().backup(destino)
  const viejos = readdirSync(carpeta).filter((f) => f.startsWith(`${prefijo}-`)).sort().slice(0, -conservar)
  for (const f of viejos) rmSync(join(carpeta, f), { force: true })
  return destino
}

/** Un respaldo al día, al abrir la app; se guardan las últimas dos semanas. */
export function respaldoDiario(): Promise<string | null> {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
  return respaldar('diario', hoy, 14)
}

/**
 * La primera vez que abre una compilación distinta (instalada desde el DMG o con Actualizar), se respalda
 * la base ANTES de abrirla: abrirla migra el esquema y aplica semillas, y el respaldo diario ya llega tarde.
 * Se usa la API de respaldo de SQLite sobre una conexión de solo lectura (incluye lo que esté en el WAL).
 */
/** Si el respaldo previo a migrar falló, el motivo (para avisarle al docente al abrir). */
let falloRespaldo = ''
export const falloDelRespaldoPrevio = (): string => falloRespaldo

function respaldoAntesDeMigrar(ruta: string): void {
  try {
    const marca = existsSync(join(process.resourcesPath ?? '', 'compilacion.json'))
      ? readFileSync(join(process.resourcesPath, 'compilacion.json'), 'utf8').trim()
      : `dev-${app.getVersion()}`
    const archivoMarca = join(dataDir(), 'ultima-compilacion.txt')
    if (!existsSync(ruta) || (existsSync(archivoMarca) && readFileSync(archivoMarca, 'utf8').trim() === marca)) return
    const carpeta = join(dataDir(), 'respaldos')
    mkdirSync(carpeta, { recursive: true })
    const sello = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
    const destino = join(carpeta, `antes-de-abrir-version-nueva-${sello}-${Date.now()}.sqlite`)
    const vieja = new Database(ruta, { readonly: true, fileMustExist: true })
    try {
      vieja.prepare(`VACUUM INTO ?`).run(destino)
    } finally {
      vieja.close()
    }
    const previos = readdirSync(carpeta).filter((f) => f.startsWith('antes-de-abrir-version-nueva-')).sort().slice(0, -5)
    for (const f of previos) rmSync(join(carpeta, f), { force: true })
    writeFileSync(archivoMarca, marca)
  } catch (e) {
    console.error('[respaldo] no se pudo respaldar antes de abrir la versión nueva:', (e as Error).message)
    falloRespaldo = (e as Error).message
  }
}

/**
 * Restaurar un respaldo (Ajustes › Respaldos) no se hace con la base abierta: se deja anotado, la app se
 * reinicia y aquí, antes de abrirla, se guarda la actual como «antes-de-restaurar» y se pone el respaldo.
 */
function aplicarRestauracionPendiente(rutaBase: string): void {
  const marca = join(dataDir(), 'restaurar-pendiente.json')
  if (!existsSync(marca)) return
  try {
    const { ruta } = JSON.parse(readFileSync(marca, 'utf8')) as { ruta: string }
    if (existsSync(ruta)) {
      const carpeta = join(dataDir(), 'respaldos')
      mkdirSync(carpeta, { recursive: true })
      if (existsSync(rutaBase)) copyFileSync(rutaBase, join(carpeta, `antes-de-restaurar-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`))
      // Lo que quedara en el diario de la base anterior no debe mezclarse con el respaldo
      for (const ext of ['-wal', '-shm']) rmSync(rutaBase + ext, { force: true })
      copyFileSync(ruta, rutaBase)
    }
  } catch (e) {
    console.error('[respaldo] no se pudo restaurar:', (e as Error).message)
  } finally {
    rmSync(marca, { force: true })
  }
}

/**
 * Versión web (el servidor del portal): la app usa la base que ya tiene abierta el servidor, sin semillas
 * ni datos de ejemplo (esa base ya trae todo lo de la Mac por la sincronización).
 */
export function usarBase(base: Database.Database): void {
  db = base
}

/**
 * Ruta de un material en esta computadora. En la base queda la ruta de donde se agregó (la Mac o el servidor):
 * si ahí no está, se busca con el mismo nombre en la carpeta de materiales de aquí.
 */
export function rutaMaterial(ruta: string): string {
  if (!ruta || /^https?:/i.test(ruta) || existsSync(ruta)) return ruta
  const i = ruta.replace(/\\/g, '/').lastIndexOf('/materiales/')
  return i >= 0 ? join(materialesDir(), ruta.slice(i + '/materiales/'.length)) : ruta
}

export function getDb(): Database.Database {
  if (db) return db
  const ruta = join(dataDir(), 'docente.sqlite')
  aplicarRestauracionPendiente(ruta)
  respaldoAntesDeMigrar(ruta)
  db = abrirBase(ruta)
  seedSiVacio()
  // Fechas del calendario y esquemas de calificación precargados: cada grupo una sola vez
  try {
    aplicarSemillas(db)
  } catch (e) {
    console.error('[semillas]', (e as Error).message)
  }
  return db
}

export function getAjuste(clave: string, def = ''): string {
  const row = getDb().prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave) as { valor: string } | undefined
  return row ? row.valor : def
}

export function setAjuste(clave: string, valor: string): void {
  getDb().prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, valor)
}

/** Datos de ejemplo la primera vez que abre la app, para que se vea funcionando. */
function seedSiVacio(): void {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM materias').get() as { n: number }).n
  if (n > 0) return

  const lunes = startOfWeek(new Date(), { weekStartsOn: 1 })
  const periodo = db
    .prepare('INSERT INTO periodos (nombre, fecha_inicio, semanas, activo) VALUES (?, ?, 15, 1)')
    .run('Septiembre - Diciembre 2026', format(lunes, 'yyyy-MM-dd'))
  const periodoId = Number(periodo.lastInsertRowid)

  const c1 = Number(db.prepare("INSERT INTO carreras (nombre, clave, color) VALUES ('TSU Tecnologías de la Información', 'TI', '#2d6df6')").run().lastInsertRowid)
  const c2 = Number(db.prepare("INSERT INTO carreras (nombre, clave, color) VALUES ('Ingeniería en Mecatrónica', 'MEC', '#0ea5a4')").run().lastInsertRowid)

  const temarioAlgebra = `## Unidad 1. Sistemas de ecuaciones lineales
- Método de Gauss y Gauss-Jordan
- Matriz inversa
- Determinantes y regla de Cramer

## Unidad 2. Espacios vectoriales
- Subespacios, combinación lineal e independencia
- Base y dimensión

## Unidad 3. Transformaciones lineales
- Matriz asociada, núcleo e imagen
- Valores y vectores propios`

  const temarioProg = `## Unidad 1. Fundamentos
- Variables, tipos y operadores
- Estructuras de control

## Unidad 2. Funciones y estructuras de datos
- Funciones, parámetros, ámbito
- Arreglos y objetos

## Unidad 3. Programación orientada a objetos
- Clases, herencia, polimorfismo`

  const m1 = Number(
    db.prepare(
      "INSERT INTO materias (carrera_id, periodo_id, nombre, clave, cuatrimestre, color, descripcion, temario) VALUES (?, ?, 'Álgebra Lineal', 'MAT-201', 2, '#7c3aed', 'Matrices, sistemas de ecuaciones, espacios vectoriales y transformaciones lineales aplicadas a ingeniería.', ?)"
    ).run(c2, periodoId, temarioAlgebra).lastInsertRowid
  )
  const m2 = Number(
    db.prepare(
      "INSERT INTO materias (carrera_id, periodo_id, nombre, clave, cuatrimestre, color, descripcion, temario) VALUES (?, ?, 'Programación Estructurada', 'TI-101', 1, '#2d6df6', 'Lógica de programación y resolución de problemas con código.', ?)"
    ).run(c1, periodoId, temarioProg).lastInsertRowid
  )

  const insH = db.prepare('INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin, aula) VALUES (?, ?, ?, ?, ?)')
  insH.run(m1, 1, '07:00', '09:00', 'Aula B-204')
  insH.run(m1, 3, '07:00', '09:00', 'Aula B-204')
  insH.run(m2, 2, '09:00', '11:00', 'Lab. Cómputo 1')
  insH.run(m2, 4, '09:00', '11:00', 'Lab. Cómputo 1')

  const insA = db.prepare('INSERT INTO alumnos (matricula, nombre, apellidos, email, carrera_id) VALUES (?, ?, ?, ?, ?)')
  const insI = db.prepare('INSERT INTO inscripciones (materia_id, alumno_id) VALUES (?, ?)')
  const demoMec = [
    ['MEC24001', 'Ana', 'Ramírez López'],
    ['MEC24002', 'Luis', 'Hernández Cruz'],
    ['MEC24003', 'María', 'Torres Vega'],
    ['MEC24004', 'Carlos', 'Mendoza Ruiz'],
    ['MEC24005', 'Sofía', 'García Díaz']
  ]
  const demoTi = [
    ['TI25001', 'Diego', 'Flores Ortiz'],
    ['TI25002', 'Valeria', 'Castillo Mora'],
    ['TI25003', 'Emilio', 'Sánchez Peña'],
    ['TI25004', 'Regina', 'Jiménez Salas']
  ]
  for (const [mat, nom, ape] of demoMec) {
    const id = Number(insA.run(mat, nom, ape, `${mat.toLowerCase()}@escuela.edu.mx`, c2).lastInsertRowid)
    insI.run(m1, id)
  }
  for (const [mat, nom, ape] of demoTi) {
    const id = Number(insA.run(mat, nom, ape, `${mat.toLowerCase()}@escuela.edu.mx`, c1).lastInsertRowid)
    insI.run(m2, id)
  }

  const insG = db.prepare('INSERT INTO glosario (materia_id, termino, definicion, ejemplo) VALUES (?, ?, ?, ?)')
  insG.run(m1, 'Matriz', 'Arreglo rectangular de números organizados en filas y columnas.', 'A = [[1,2],[3,4]] es una matriz de 2×2.')
  insG.run(m1, 'Determinante', 'Escalar asociado a una matriz cuadrada que indica si es invertible.', 'det([[1,2],[3,4]]) = 1·4 − 2·3 = −2.')

  // Sesiones de las primeras 2 semanas con plantilla de actividades
  generarSesionesMateria(m1, periodoId, 2)
  generarSesionesMateria(m2, periodoId, 2)
  const s1 = db.prepare('SELECT id FROM sesiones WHERE materia_id = ? ORDER BY fecha LIMIT 1').get(m1) as { id: number } | undefined
  if (s1) db.prepare("UPDATE sesiones SET tema = 'Método de Gauss', objetivo = 'Resolver sistemas 3×3 por eliminación gaussiana' WHERE id = ?").run(s1.id)

  setAjuste('tolerancia_retardo_min', '10')
  setAjuste('avanzar_auto', '1')
  setAjuste('sonido', '1')
  setAjuste('modelo_ia', 'claude-opus-5-5')
  setAjuste('nombre_docente', 'Docente Demo')
}

export const PLANTILLA_ACTIVIDADES = [
  { nombre: 'Pase de lista y encuadre', tipo: 'apertura', pct: 0.08 },
  { nombre: 'Repaso de la sesión anterior', tipo: 'discusion', pct: 0.08 },
  { nombre: 'Exposición del tema', tipo: 'exposicion', pct: 0.34 },
  { nombre: 'Ejercicio guiado', tipo: 'ejercicio', pct: 0.2 },
  { nombre: 'Receso', tipo: 'receso', pct: 0.05 },
  { nombre: 'Práctica en equipos', tipo: 'ejercicio', pct: 0.17 },
  { nombre: 'Cierre y tarea', tipo: 'cierre', pct: 0.08 }
] as const

function minutosEntre(a: string, b: string): number {
  const [h1, m1] = a.split(':').map(Number)
  const [h2, m2] = b.split(':').map(Number)
  return h2 * 60 + m2 - (h1 * 60 + m1)
}

/** Crea sesiones para una materia a partir de su horario y las semanas del periodo. No duplica. */
export function generarSesionesMateria(materiaId: number, periodoId: number, soloSemanas?: number): number {
  const d = getDb()
  const periodo = d.prepare('SELECT * FROM periodos WHERE id = ?').get(periodoId) as { fecha_inicio: string; semanas: number }
  const horarios = d.prepare('SELECT * FROM horarios WHERE materia_id = ? ORDER BY dia, hora_inicio').all(materiaId) as {
    dia: number; hora_inicio: string; hora_fin: string
  }[]
  const existe = d.prepare('SELECT id FROM sesiones WHERE materia_id = ? AND fecha = ? AND hora_inicio = ?')
  const insS = d.prepare('INSERT INTO sesiones (materia_id, semana, numero, fecha, hora_inicio, hora_fin) VALUES (?, ?, ?, ?, ?, ?)')
  const insAct = d.prepare('INSERT INTO actividades (sesion_id, orden, nombre, tipo, duracion_min) VALUES (?, ?, ?, ?, ?)')
  const inicio = new Date(periodo.fecha_inicio + 'T00:00:00')
  // Las semanas se cuentan desde el lunes de la semana de inicio: si el periodo empieza un miércoles,
  // antes todas las sesiones caían dos días tarde. Lo anterior a la fecha de inicio no se crea.
  const lunes = startOfWeek(inicio, { weekStartsOn: 1 })
  const semanas = soloSemanas ?? periodo.semanas
  let numero = (d.prepare('SELECT COUNT(*) AS n FROM sesiones WHERE materia_id = ?').get(materiaId) as { n: number }).n
  let creadas = 0
  const tx = d.transaction(() => {
    for (let s = 0; s < semanas; s++) {
      for (const h of horarios) {
        const dia = addDays(lunes, s * 7 + (h.dia - 1))
        if (dia < inicio) continue
        const fecha = format(dia, 'yyyy-MM-dd')
        if (existe.get(materiaId, fecha, h.hora_inicio)) continue
        numero += 1
        const sid = Number(insS.run(materiaId, s + 1, numero, fecha, h.hora_inicio, h.hora_fin).lastInsertRowid)
        const total = Math.max(0, minutosEntre(h.hora_inicio, h.hora_fin))
        let acumulado = 0
        PLANTILLA_ACTIVIDADES.forEach((p, i) => {
          const esUltima = i === PLANTILLA_ACTIVIDADES.length - 1
          const min = esUltima ? total - acumulado : Math.max(1, Math.round(total * p.pct))
          acumulado += min
          insAct.run(sid, i + 1, p.nombre, p.tipo, min)
        })
        creadas++
      }
    }
  })
  tx()
  return creadas
}

export function leerArchivoTexto(ruta: string): string {
  return readFileSync(ruta, 'utf8')
}
