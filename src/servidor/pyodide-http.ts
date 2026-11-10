/**
 * Python del editor de código para los celulares del salón (sin internet: sale de la app).
 * - Un archivo que no existe responde 404 (no la página del portal), así el alumno ve «falta el paquete».
 * - Se revalida con ETag en cada carga: al actualizar Pyodide ningún celular mezcla versiones viejas
 *   y nuevas guardadas en caché; si nada cambió, la respuesta es un 304 vacío.
 * - Los archivos grandes que se comprimen bien (el .wasm de ~10 MB) se comprimen una sola vez y se
 *   guardan en memoria: con 40 celulares no se recomprime 40 veces.
 */
import type { Request, Response } from 'express'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import { gzipSync } from 'zlib'

const TIPOS: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.whl': 'application/zip',
  '.tar': 'application/x-tar'
}
/** .zip y .whl ya vienen comprimidos: recomprimirlos no ahorra nada. */
const COMPRIMIBLES = new Set(['.js', '.mjs', '.wasm', '.json'])

const comprimidos = new Map<string, { etag: string; datos: Buffer }>()

export function servirPyodide(carpetas: string[]) {
  return (req: Request, res: Response): void => {
    const nombre = String(req.params.archivo ?? '')
    if (!nombre || basename(nombre) !== nombre) return void res.status(403).end()
    const ruta = carpetas.map((c) => join(c, nombre)).find((r) => existsSync(r))
    if (!ruta) return void res.status(404).type('text/plain').send(`No existe ${nombre} en este servidor.`)
    const st = statSync(ruta)
    const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`
    const ext = extname(nombre)
    res.setHeader('ETag', etag)
    // no-transform: el middleware de compresión general no vuelve a tocar esta respuesta
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Content-Type', TIPOS[ext] ?? 'application/octet-stream')
    res.setHeader('Vary', 'Accept-Encoding')
    if (req.headers['if-none-match'] === etag) return void res.status(304).end()
    if (COMPRIMIBLES.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      let gz = comprimidos.get(ruta)
      if (!gz || gz.etag !== etag) comprimidos.set(ruta, (gz = { etag, datos: gzipSync(readFileSync(ruta), { level: 6 }) }))
      res.setHeader('Content-Encoding', 'gzip')
      return void res.end(gz.datos)
    }
    res.sendFile(ruta)
  }
}
