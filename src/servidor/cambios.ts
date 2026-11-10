/**
 * Sincronización en dos sentidos (Mac ↔ servidor) por registro de cambios.
 *
 * Cada lado anota en `_cambios` cada alta, edición o borrado de las tablas sincronizadas (con disparadores
 * de SQLite: el resto del código no se entera). Al sincronizar, cada lado manda el estado actual de las filas
 * que cambiaron y aplica el de las del otro. Si los dos tocaron la misma fila gana el cambio más reciente.
 *
 * - Lo que se aplica de afuera se anota con su origen (para no regresarlo a quien lo mandó y para comparar
 *   fechas), pero no vuelve a disparar el registro (bandera `aplicando` en `_sincro`).
 * - Si una fila nueva choca con otra por un índice único (la misma asistencia creada en los dos lados), gana
 *   la que llega y el borrado de la otra se anota como cambio propio: así el otro lado también la quita.
 * - Las filas que crea el servidor en tablas que también edita la Mac usan `idNuevo` (ids altos al azar):
 *   con AUTOINCREMENT, los dos lados contando desde el mismo número chocarían.
 */
import type Database from 'better-sqlite3'
import { randomInt } from 'crypto'
import { AJUSTES_AL_PORTAL, TABLAS_SIN_SINCRONIZAR } from '../shared/sincronizacion'

type DB = Database.Database

export interface Cambio {
  tabla: string
  /** Valores de la llave primaria, en orden */
  pk: unknown[]
  op: 'u' | 'd'
  /** Cuándo se hizo (ms) */
  en: number
  /** Fila completa (solo en 'u') */
  fila?: Record<string, unknown>
}

const INTERNAS = new Set(['_cambios', '_sincro'])
const NO_SINCRONIZA = new Set<string>([...TABLAS_SIN_SINCRONIZAR].filter((t) => t !== 'ajustes'))
const AJUSTES = new Set<string>(AJUSTES_AL_PORTAL)
const AHORA_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

interface InfoTabla {
  columnas: string[]
  pk: string[]
  /** Índices únicos distintos de la llave primaria: columnas de cada uno */
  unicos: string[][]
}

const cacheInfo = new WeakMap<DB, Map<string, InfoTabla>>()

function infoDe(db: DB, tabla: string): InfoTabla {
  let porTabla = cacheInfo.get(db)
  if (!porTabla) cacheInfo.set(db, (porTabla = new Map()))
  const ya = porTabla.get(tabla)
  if (ya) return ya
  const cols = db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string; pk: number }[]
  const unicos = (db.prepare(`PRAGMA index_list(${tabla})`).all() as { name: string; unique: number; origin: string }[])
    .filter((i) => i.unique && i.origin !== 'pk')
    .map((i) => (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string | null }[]).map((c) => c.name).filter((c): c is string => !!c))
    .filter((c) => c.length > 0)
  const info = { columnas: cols.map((c) => c.name), pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), unicos }
  porTabla.set(tabla, info)
  return info
}

/** Tablas que viajan: todas menos las internas, las de cada lado (sesiones, códigos, asistente) y sqlite_*. */
export function tablasSincronizadas(db: DB): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((t) => t.name)
    .filter((t) => !INTERNAS.has(t) && !NO_SINCRONIZA.has(t) && /^[a-z_][a-z0-9_]*$/.test(t))
}

/**
 * Crea el registro y los disparadores (idempotente: se llama al abrir y tras crear tablas nuevas).
 * Un disparador que ya existe se deja; si la tabla se reconstruyó, el suyo se fue con ella y se vuelve a crear.
 */
export function prepararCambios(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _cambios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tabla TEXT NOT NULL,
      pk TEXT NOT NULL,
      op TEXT NOT NULL,
      en INTEGER NOT NULL,
      origen TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cambios_fila ON _cambios(tabla, pk);
    CREATE TABLE IF NOT EXISTS _sincro (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    DELETE FROM _sincro WHERE clave = 'aplicando';
  `)
  cacheInfo.delete(db)
  const disparadores = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_c\\_%' ESCAPE '\\'").all() as { name: string; sql: string }[]
  const existentes = new Set(disparadores.map((t) => t.name))
  const sqlDe = new Map(disparadores.map((t) => [t.name, t.sql]))
  const noAplicando = "(SELECT 1 FROM _sincro WHERE clave = 'aplicando') IS NULL"
  for (const t of tablasSincronizadas(db)) {
    const { columnas, pk } = infoDe(db, t)
    if (!pk.length) continue
    const pkDe = (fila: 'NEW' | 'OLD'): string => `json_array(${pk.map((c) => `${fila}.${c}`).join(', ')})`
    // Ajustes: solo los que el portal usa (los demás cambian a cada rato y no salen de la Mac)
    const filtro = t === 'ajustes' ? ` AND NEW.clave IN (${[...AJUSTES].map((a) => `'${a}'`).join(', ')})` : ''
    const filtroBorrado = t === 'ajustes' ? ` AND OLD.clave IN (${[...AJUSTES].map((a) => `'${a}'`).join(', ')})` : ''
    if (!existentes.has(`_c_${t}_i`)) {
      db.exec(`CREATE TRIGGER _c_${t}_i AFTER INSERT ON ${t} WHEN ${noAplicando}${filtro} BEGIN
        INSERT INTO _cambios (tabla, pk, op, en) VALUES ('${t}', ${pkDe('NEW')}, 'u', ${AHORA_MS}); END`)
    }
    // El de actualización compara columna por columna: si la tabla ganó columnas (migración), se rehace con todas
    if (existentes.has(`_c_${t}_u`) && columnas.some((c) => !sqlDe.get(`_c_${t}_u`)?.includes(`NEW.${c},`) && !sqlDe.get(`_c_${t}_u`)?.includes(`NEW.${c})`))) {
      db.exec(`DROP TRIGGER _c_${t}_u`)
      existentes.delete(`_c_${t}_u`)
    }
    if (!existentes.has(`_c_${t}_u`)) {
      // Solo si algo cambió de verdad: la sincronización con Classroom reescribe filas iguales a cada rato
      const todas = (f: string): string => `json_array(${columnas.map((c) => `${f}.${c}`).join(', ')})`
      db.exec(`CREATE TRIGGER _c_${t}_u AFTER UPDATE ON ${t} WHEN ${noAplicando}${filtro} AND ${todas('OLD')} IS NOT ${todas('NEW')} BEGIN
        INSERT INTO _cambios (tabla, pk, op, en) SELECT '${t}', ${pkDe('OLD')}, 'd', ${AHORA_MS} WHERE ${pkDe('OLD')} IS NOT ${pkDe('NEW')};
        INSERT INTO _cambios (tabla, pk, op, en) VALUES ('${t}', ${pkDe('NEW')}, 'u', ${AHORA_MS}); END`)
    }
    if (!existentes.has(`_c_${t}_d`)) {
      db.exec(`CREATE TRIGGER _c_${t}_d AFTER DELETE ON ${t} WHEN ${noAplicando}${filtroBorrado} BEGIN
        INSERT INTO _cambios (tabla, pk, op, en) VALUES ('${t}', ${pkDe('OLD')}, 'd', ${AHORA_MS}); END`)
    }
  }
}

/** Id nuevo para una fila creada en el servidor en una tabla que también edita la Mac (ver arriba). */
export function idNuevo(): number {
  return 1_000_000_000_000 + randomInt(0, 2 ** 47)
}

const filaPorPk = (db: DB, tabla: string, pk: string[], valores: unknown[]): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM ${tabla} WHERE ${pk.map((c) => `${c} IS ?`).join(' AND ')}`).get(...valores) as Record<string, unknown> | undefined

/**
 * Cambios desde `desde` (id del registro), sin los que vinieron de `excluir`. De cada fila va solo su último
 * cambio, con su estado actual. `cursor` es hasta dónde se revisó (para la siguiente vez).
 */
export function cambiosDesde(db: DB, desde: number, excluir: string, limite = 2000): { cambios: Cambio[]; cursor: number; hay_mas: boolean } {
  const ultimos = db
    .prepare(
      `SELECT c.tabla, c.pk, c.op, c.en, c.origen, u.mid FROM _cambios c
       JOIN (SELECT tabla, pk, MAX(id) AS mid FROM _cambios WHERE id > ? GROUP BY tabla, pk) u ON c.id = u.mid
       ORDER BY u.mid LIMIT ?`
    )
    .all(desde, limite + 1) as { tabla: string; pk: string; op: 'u' | 'd'; en: number; origen: string; mid: number }[]
  const hay_mas = ultimos.length > limite
  const lote = ultimos.slice(0, limite)
  const tablas = new Set(tablasSincronizadas(db))
  const cambios: Cambio[] = []
  for (const c of lote) {
    // Lo último de esa fila vino de quien pregunta: ya lo tiene
    if (c.origen === excluir || !tablas.has(c.tabla)) continue
    const { pk } = infoDe(db, c.tabla)
    const valores = JSON.parse(c.pk) as unknown[]
    if (c.op === 'd') {
      cambios.push({ tabla: c.tabla, pk: valores, op: 'd', en: c.en })
      continue
    }
    const fila = filaPorPk(db, c.tabla, pk, valores)
    if (c.tabla === 'ajustes' && fila && !AJUSTES.has(String(fila.clave))) continue
    cambios.push(fila ? { tabla: c.tabla, pk: valores, op: 'u', en: c.en, fila } : { tabla: c.tabla, pk: valores, op: 'd', en: c.en })
  }
  const cursor = hay_mas ? lote[lote.length - 1].mid : Math.max(desde, (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM _cambios').get() as { m: number }).m)
  return { cambios, cursor, hay_mas }
}

/**
 * Registros secundarios del portal que se vacían en lote por acciones normales: eliminar una publicación borra los
 * avisos de todo el grupo y los eventos de vigilancia. Entregas, archivos y publicaciones (trabajo de los alumnos)
 * sí conservan el freno de abajo, igual que el contenido del docente.
 */
const SIN_FRENO = new Set(['notificaciones', 'eventos_integridad'])

export interface ResultadoAplicar {
  aplicados: number
  /** Ya había aquí un cambio más reciente de esa fila */
  ganaLocal: number
  omitidos: string[]
}

/**
 * Aplica cambios que llegan del otro lado. `origen` = quién los manda (se anota para no regresárselos).
 * `transformar` ajusta una fila antes de escribirla (rutas de archivos, por ejemplo).
 * Todo o nada, con las llaves foráneas apagadas: llegan filas hijas antes que sus madres.
 */
export function aplicarCambios(
  db: DB,
  cambios: Cambio[],
  origen: string,
  op: { transformar?: (tabla: string, fila: Record<string, unknown>) => Record<string, unknown> | null; maxBorrados?: number } = {}
): ResultadoAplicar {
  const r: ResultadoAplicar = { aplicados: 0, ganaLocal: 0, omitidos: [] }
  const tablas = new Set(tablasSincronizadas(db))
  // Freno: un lote que borra más de la mitad de una tabla con datos no se aplica sin confirmarlo
  if (op.maxBorrados !== Infinity) {
    const borrados = new Map<string, number>()
    for (const c of cambios) if (c.op === 'd') borrados.set(c.tabla, (borrados.get(c.tabla) ?? 0) + 1)
    for (const [t, n] of borrados) {
      if (!tablas.has(t) || SIN_FRENO.has(t)) continue
      const hay = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      if (n > 5 && n > hay / 2) throw new Error(`Llegaron ${n} borrados de «${t}» (hay ${hay} filas). Se detuvo para no perder datos; si es correcto, sincroniza con «forzar».`)
    }
  }
  const ultimoLocal = db.prepare('SELECT MAX(en) AS en FROM _cambios WHERE tabla = ? AND pk = ?')
  const anotar = db.prepare('INSERT INTO _cambios (tabla, pk, op, en, origen) VALUES (?, ?, ?, ?, ?)')
  const anotarPropio = db.prepare(`INSERT INTO _cambios (tabla, pk, op, en) VALUES (?, ?, 'd', ${AHORA_MS})`)
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO _sincro (clave, valor) VALUES ('aplicando', '1')").run()
      for (const c of cambios) {
        if (!tablas.has(c.tabla) || (c.tabla === 'ajustes' && !AJUSTES.has(String(c.pk[0])))) {
          if (!r.omitidos.includes(c.tabla)) r.omitidos.push(c.tabla)
          continue
        }
        const info = infoDe(db, c.tabla)
        if (!info.pk.length || c.pk.length !== info.pk.length) continue
        const llave = JSON.stringify(c.pk)
        const local = (ultimoLocal.get(c.tabla, llave) as { en: number | null }).en
        if (local !== null && local > c.en) {
          r.ganaLocal++
          continue
        }
        if (c.op === 'd') {
          db.prepare(`DELETE FROM ${c.tabla} WHERE ${info.pk.map((k) => `${k} IS ?`).join(' AND ')}`).run(...c.pk)
        } else {
          let fila: Record<string, unknown> | null = c.fila ?? null
          if (fila && op.transformar) fila = op.transformar(c.tabla, fila)
          if (!fila) continue
          const cols = info.columnas.filter((k) => k in fila!)
          if (!info.pk.every((k) => cols.includes(k))) continue
          const valores = cols.map((k) => fila![k] ?? null)
          const resto = cols.filter((k) => !info.pk.includes(k))
          const sql = `INSERT INTO ${c.tabla} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
            ON CONFLICT (${info.pk.join(', ')}) DO ${resto.length ? `UPDATE SET ${resto.map((k) => `${k} = excluded.${k}`).join(', ')}` : 'NOTHING'}`
          try {
            db.prepare(sql).run(...valores)
          } catch (e) {
            if (!/UNIQUE/i.test((e as Error).message)) throw e
            // La misma fila lógica creada en los dos lados (otra llave, mismos datos únicos): gana la más reciente.
            // Si gana la que llega, el borrado de la de aquí se anota como cambio propio y viaja de regreso;
            // si gana la de aquí, la que llega no se aplica y el otro lado recibirá la de aquí
            const otras: unknown[][] = []
            for (const u of info.unicos) {
              const vals = u.map((k) => fila![k])
              if (vals.some((v) => v === null || v === undefined || v === '')) continue
              otras.push(
                ...(db
                  .prepare(`SELECT ${info.pk.join(', ')} FROM ${c.tabla} WHERE ${u.map((k) => `${k} = ?`).join(' AND ')} AND NOT (${info.pk.map((k) => `${k} IS ?`).join(' AND ')})`)
                  .raw(true)
                  .all(...vals, ...c.pk) as unknown[][])
              )
            }
            if (otras.some((o) => ((ultimoLocal.get(c.tabla, JSON.stringify(o)) as { en: number | null }).en ?? 0) > c.en)) {
              r.ganaLocal++
              continue
            }
            for (const o of otras) {
              db.prepare(`DELETE FROM ${c.tabla} WHERE ${info.pk.map((k) => `${k} IS ?`).join(' AND ')}`).run(...o)
              anotarPropio.run(c.tabla, JSON.stringify(o))
            }
            db.prepare(sql).run(...valores)
          }
        }
        anotar.run(c.tabla, llave, c.op, c.en, origen)
        r.aplicados++
      }
      db.prepare("DELETE FROM _sincro WHERE clave = 'aplicando'").run()
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  return r
}

/** Corre algo sin anotarlo como cambio (por ejemplo, la sincronización completa del modo anterior). */
export function sinAnotar<T>(db: DB, f: () => T): T {
  db.prepare("INSERT OR REPLACE INTO _sincro (clave, valor) VALUES ('aplicando', '1')").run()
  try {
    return f()
  } finally {
    db.prepare("DELETE FROM _sincro WHERE clave = 'aplicando'").run()
  }
}

/** El registro crece con cada cambio: lo de hace más de 60 días ya viajó. */
export function podarCambios(db: DB, dias = 60): number {
  return db.prepare(`DELETE FROM _cambios WHERE en < ${AHORA_MS} - ? * 86400000`).run(dias).changes
}
