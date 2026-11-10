/**
 * Archivos de Python (Pyodide) para el editor de código, sin internet:
 * - el núcleo viene con la app (Resources/pyodide; en desarrollo, node_modules/pyodide);
 * - los paquetes (numpy, matplotlib…) se descargan una vez a datos/pyodide-paquetes y los usan
 *   la app y el portal (los alumnos los reciben del servidor del salón, sin internet).
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { dataDir } from '../db'

export function carpetaNucleo(): string {
  const empaquetada = join(process.resourcesPath ?? '', 'pyodide')
  return existsSync(join(empaquetada, 'pyodide.js')) ? empaquetada : join(app.getAppPath(), 'node_modules/pyodide')
}

export function carpetaPaquetes(): string {
  const dir = join(dataDir(), 'pyodide-paquetes')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Jedi, parso y pyflakes (autocompletado y errores del editor): en la app empaquetada van junto al núcleo. */
const carpetaExtra = (): string => join(app.getAppPath(), 'build/pyodide-extra')

/** Carpetas donde buscar un archivo de Pyodide, en orden. */
export const carpetasPyodide = (): string[] => [carpetaNucleo(), ...(existsSync(carpetaExtra()) ? [carpetaExtra()] : []), carpetaPaquetes()]

interface Paquete { name: string; file_name: string; sha256: string; depends: string[]; imports?: string[]; package_type?: string }
interface Lock { info: { version?: string }; packages: Record<string, Paquete> }

const lock = (): Lock => JSON.parse(readFileSync(join(carpetaNucleo(), 'pyodide-lock.json'), 'utf8')) as Lock
const versionPyodide = (): string => (JSON.parse(readFileSync(join(carpetaNucleo(), 'package.json'), 'utf8')) as { version: string }).version

/** Los que más se usan en clase; se puede descargar cualquier otro del catálogo por su nombre. */
export const PAQUETES_SUGERIDOS: { nombre: string; para: string }[] = [
  { nombre: 'numpy', para: 'arreglos y álgebra lineal' },
  { nombre: 'matplotlib', para: 'gráficas' },
  { nombre: 'pandas', para: 'tablas de datos' },
  { nombre: 'sympy', para: 'álgebra simbólica (ecuaciones, derivadas, matrices exactas)' },
  { nombre: 'networkx', para: 'grafos (rutas, árboles, BFS/DFS)' },
  { nombre: 'scipy', para: 'métodos numéricos y estadística' }
]

/** Archivo + todas sus dependencias, sin repetir. */
function conDependencias(nombre: string, l: Lock): Paquete[] {
  const vistos = new Map<string, Paquete>()
  const visitar = (n: string): void => {
    const p = l.packages[n.toLowerCase()]
    if (!p || vistos.has(p.name)) return
    vistos.set(p.name, p)
    p.depends.forEach(visitar)
  }
  visitar(nombre)
  return [...vistos.values()]
}

/** Al actualizar Pyodide, los paquetes de la versión anterior ya no sirven: se borran para no ocupar espacio. */
function limpiarViejos(l: Lock, dir: string): void {
  const vigentes = new Set(Object.values(l.packages).map((p) => basename(p.file_name)))
  for (const f of readdirSync(dir)) if (!vigentes.has(f)) rmSync(join(dir, f), { force: true })
}

export function estadoPaquetes(): { nombre: string; para: string; descargado: boolean }[] {
  const l = lock()
  const dir = carpetaPaquetes()
  limpiarViejos(l, dir)
  return PAQUETES_SUGERIDOS.map((s) => {
    const todos = conDependencias(s.nombre, l)
    // Los que ya vienen con el núcleo no hacen falta (están en la carpeta de la app)
    const faltan = todos.filter((p) => !existsSync(join(dir, p.file_name)) && !existsSync(join(carpetaNucleo(), p.file_name)))
    return { ...s, descargado: todos.length > 0 && faltan.length === 0 }
  })
}

let cancelar: AbortController | null = null
/** Corta la descarga en curso (botón «Cancelar» o internet caído a medias). */
export function cancelarDescarga(): void {
  cancelar?.abort()
}

/** Descarga un paquete y sus dependencias del CDN oficial de Pyodide, verificando su huella (sha256). */
export async function descargarPaquete(nombre: string, avance?: (t: string) => void): Promise<string[]> {
  const l = lock()
  const todos = conDependencias(nombre, l)
  if (!todos.length) throw new Error(`«${nombre}» no está en el catálogo de Pyodide.`)
  const dir = carpetaPaquetes()
  const base = `https://cdn.jsdelivr.net/pyodide/v${versionPyodide()}/full/`
  const bajados: string[] = []
  for (const [i, p] of todos.entries()) {
    const destino = join(dir, basename(p.file_name))
    if (existsSync(destino) || existsSync(join(carpetaNucleo(), p.file_name))) continue
    avance?.(`Descargando ${p.name} (${i + 1} de ${todos.length})…`)
    // Cada archivo tiene 2 min; «Cancelar» corta todo
    cancelar = new AbortController()
    const tope = setTimeout(() => cancelar?.abort(), 120_000)
    let datos: Buffer
    try {
      const r = await fetch(base + p.file_name, { signal: cancelar.signal })
      if (!r.ok) throw new Error(`No se pudo descargar ${p.name} (HTTP ${r.status}). Revisa la conexión a internet.`)
      datos = Buffer.from(await r.arrayBuffer())
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error(`Se canceló la descarga de ${p.name} (o tardó más de 2 min). Lo que ya bajó se conserva.`)
      throw e
    } finally {
      clearTimeout(tope)
      cancelar = null
    }
    if (createHash('sha256').update(datos).digest('hex') !== p.sha256) throw new Error(`La descarga de ${p.name} llegó dañada; vuelve a intentar.`)
    // Se escribe aparte y luego se renombra: nunca queda un archivo a medias con el nombre bueno
    writeFileSync(destino + '.parcial', datos)
    renameSync(destino + '.parcial', destino)
    bajados.push(p.name)
  }
  return bajados
}

/** Borra los paquetes descargados (para liberar espacio). */
export function borrarPaquetes(): number {
  const dir = carpetaPaquetes()
  const archivos = readdirSync(dir)
  for (const f of archivos) rmSync(join(dir, f), { force: true })
  return archivos.length
}

const TIPOS: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.whl': 'application/zip',
  '.tar': 'application/x-tar'
}

/** docente://pyodide/<archivo> → el archivo, buscando en el núcleo y en los paquetes. */
export function respuestaPyodide(nombre: string): Response {
  const limpio = basename(nombre)
  if (!limpio || limpio !== nombre) return new Response('No permitido', { status: 403 })
  const ruta = carpetasPyodide().map((c) => join(c, limpio)).find((r) => existsSync(r))
  if (!ruta) return new Response('No encontrado', { status: 404 })
  const ext = limpio.slice(limpio.lastIndexOf('.'))
  return new Response(readFileSync(ruta), {
    headers: { 'Content-Type': TIPOS[ext] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=31536000' }
  })
}
