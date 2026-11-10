/**
 * Lado servidor de «Portal en línea» (ver src/shared/sincronizacion.ts). Solo responde con la clave
 * de sincronización (PORTAL_SINCRO); sin ella estas rutas no existen.
 */
import type Database from 'better-sqlite3'
import { existsSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { isAbsolute, join, relative } from 'path'
import { asegurarTablas } from '../main/services/classroom-datos'
import { AJUSTES_AL_PORTAL, TABLAS_DEL_PORTAL, TABLAS_SIN_SINCRONIZAR, type PaqueteBajada, type PaqueteSubida, type TablaSincro } from '../shared/sincronizacion'
import { ErrorHttp } from './auth'
import { escribirAjuste } from './base'
import { sinAnotar } from './cambios'

type DB = Database.Database

const NO_SE_SUBEN = new Set<string>([...TABLAS_DEL_PORTAL, ...TABLAS_SIN_SINCRONIZAR])

function columnasDe(db: DB, tabla: string): { nombre: string; pk: number }[] {
  return (db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string; pk: number }[]).map((c) => ({ nombre: c.name, pk: c.pk }))
}

export interface ResultadoSubida {
  tablas: number
  filas: number
  borradas: number
  omitidas: string[]
}

/**
 * Recibe las tablas de la app y deja el servidor igual: inserta o actualiza por llave primaria y borra
 * lo que la app ya no tiene (con sus dependencias del portal, por las llaves foráneas). Todo o nada.
 * Si una tabla perdería más de la mitad de sus filas, se rechaza: protege de una base vacía por error.
 */
export function recibirTablas(db: DB, paquete: PaqueteSubida): ResultadoSubida {
  asegurarTablas(db)
  const existentes = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name))
  const r: ResultadoSubida = { tablas: 0, filas: 0, borradas: 0, omitidas: [] }
  db.exec('CREATE TEMP TABLE IF NOT EXISTS _llaves (k TEXT PRIMARY KEY)')
  const aplicar = db.transaction(() => {
    // Las filas llegan en cualquier orden (hijas antes que madres): las llaves foráneas se revisan al final
    db.pragma('defer_foreign_keys = ON')
    for (const [tabla, datos] of Object.entries(paquete.tablas ?? {})) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tabla) || NO_SE_SUBEN.has(tabla) || !existentes.has(tabla)) {
        r.omitidas.push(tabla)
        continue
      }
      const cols = columnasDe(db, tabla)
      const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.nombre)
      const delServidor = new Set(cols.map((c) => c.nombre))
      const usar = datos.columnas.map((c, i) => ({ c, i })).filter(({ c }) => delServidor.has(c))
      if (!pk.length || !pk.every((c) => usar.some((u) => u.c === c))) {
        r.omitidas.push(tabla)
        continue
      }
      const resto = usar.filter(({ c }) => !pk.includes(c))
      const posPk = pk.map((c) => datos.columnas.indexOf(c))
      db.exec('DELETE FROM _llaves')
      const llave = db.prepare('INSERT OR IGNORE INTO _llaves (k) VALUES (?)')
      for (const fila of datos.filas) llave.run(JSON.stringify(posPk.map((p) => fila[p])))
      // Primero se borra lo que ya no existe: así un alumno dado de baja y vuelto a dar de alta con la misma
      // matrícula (otro id) no choca con el índice único al insertarlo
      const sobra = `json_array(${pk.join(', ')}) NOT IN (SELECT k FROM _llaves)`
      const antes = (db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number }).n
      const aBorrar = (db.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${sobra}`).get() as { n: number }).n
      if (aBorrar > 5 && aBorrar > antes / 2 && !paquete.forzar) {
        throw new ErrorHttp(409, `La app quiere borrar ${aBorrar} de ${antes} filas de «${tabla}». Se detuvo para no perder datos; si es correcto, sincroniza con «forzar».`)
      }
      try {
        if (aBorrar) r.borradas += db.prepare(`DELETE FROM ${tabla} WHERE ${sobra}`).run().changes
        const insertar = db.prepare(
          `INSERT INTO ${tabla} (${usar.map((u) => u.c).join(', ')}) VALUES (${usar.map(() => '?').join(', ')})
           ON CONFLICT (${pk.join(', ')}) DO ${resto.length ? `UPDATE SET ${resto.map(({ c }) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`
        )
        for (const fila of datos.filas) insertar.run(...usar.map(({ i }) => fila[i] ?? null))
      } catch (e) {
        throw new ErrorHttp(409, `No se pudo sincronizar «${tabla}»: ${(e as Error).message}`)
      }
      r.tablas++
      r.filas += datos.filas.length
    }
    for (const clave of AJUSTES_AL_PORTAL) {
      const valor = paquete.ajustes?.[clave]
      if (typeof valor === 'string') escribirAjuste(db, clave, valor)
    }
  })
  try {
    // Es el modo anterior (tablas completas): no se anota como cambio, ya está igual en los dos lados
    sinAnotar(db, aplicar)
  } catch (e) {
    if (e instanceof ErrorHttp) throw e
    // Las llaves foráneas diferidas se revisan al confirmar: una fila que apunta a algo que no llegó
    throw new ErrorHttp(409, `No se pudo sincronizar: ${(e as Error).message}`)
  }
  return r
}

function tablaCompleta(db: DB, tabla: string): TablaSincro {
  const columnas = columnasDe(db, tabla).map((c) => c.nombre)
  const filas = (db.prepare(`SELECT ${columnas.join(', ')} FROM ${tabla}`).raw(true).all() as unknown[][]) ?? []
  return { columnas, filas }
}

/**
 * Lo que manda el portal, completo, más la lista de archivos de entregas (rutas relativas). Si la app ya tiene
 * esa misma versión (`desde` = su huella), solo responde que no hay cambios: no se reescribe nada allá.
 */
export function entregarTablas(db: DB, carpetaEntregas: string, desde = ''): PaqueteBajada | { sin_cambios: true; huella: string } {
  asegurarTablas(db)
  const tablas: Record<string, TablaSincro> = {}
  for (const t of TABLAS_DEL_PORTAL) tablas[t] = tablaCompleta(db, t)
  // Las entregas de exámenes guardan la ruta absoluta del servidor: viajan relativas
  const ae = tablas.archivos_entrega
  const iRuta = ae.columnas.indexOf('ruta')
  for (const f of ae.filas) f[iRuta] = aRelativa(carpetaEntregas, String(f[iRuta]))
  const archivos: PaqueteBajada['archivos'] = []
  for (const t of [ae, tablas.archivos_subida]) {
    const i = t.columnas.indexOf('ruta')
    for (const f of t.filas) {
      const ruta = String(f[i])
      const abs = join(carpetaEntregas, ruta)
      if (!ruta.startsWith('..') && existsSync(abs)) archivos.push({ ruta, tamano: statSync(abs).size })
    }
  }
  const huella = createHash('sha1').update(JSON.stringify(tablas)).digest('hex')
  if (desde && desde === huella) return { sin_cambios: true, huella }
  return { tablas, archivos, hora: new Date().toISOString(), huella }
}

export const rutaRelativa = (base: string, ruta: string): string => aRelativa(base, ruta)

function aRelativa(base: string, ruta: string): string {
  return isAbsolute(ruta) ? relative(base, ruta) : ruta
}

/** Ruta absoluta de un archivo de entregas pedido por la app; nada fuera de la carpeta. */
export function archivoParaBajar(carpetaEntregas: string, ruta: string): string {
  const abs = join(carpetaEntregas, ruta)
  const rel = relative(carpetaEntregas, abs)
  if (!ruta || rel.startsWith('..') || isAbsolute(rel)) throw new ErrorHttp(400, 'Ruta no válida.')
  if (!existsSync(abs)) throw new ErrorHttp(404, 'El archivo ya no está.')
  return abs
}
