import { shell, type WebContents } from 'electron'
import { extname, relative, resolve, isAbsolute } from 'path'
import { getDb, dataDir, rutaMaterial } from './db'

/**
 * Todo lo que la app abre fuera de sí misma pasa por aquí. Antes cualquier enlace (p. ej. un
 * «recurso recomendado» de un material generado por la IA) podía llevar la ventana principal a
 * un sitio ajeno, que heredaba el acceso a todos los canales del proceso principal, y se podía
 * abrir cualquier esquema o ejecutar cualquier archivo.
 */

/** Solo web y correo se abren en el navegador; file:, smb: y esquemas de otras apps no. */
export function abrirFuera(url: string): void {
  try {
    const u = new URL(url)
    if (['https:', 'http:', 'mailto:'].includes(u.protocol)) void shell.openExternal(u.toString())
  } catch {
    /* URL inválida: no se abre */
  }
}

const EJECUTABLES = new Set(['.app', '.command', '.sh', '.zsh', '.bash', '.tool', '.terminal', '.scpt', '.applescript', '.workflow', '.pkg', '.mpkg', '.dmg', '.exe', '.jar', '.py', '.rb', '.pl'])

const dentroDe = (base: string, ruta: string): boolean => {
  const r = relative(resolve(base), resolve(ruta))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/** Rutas que la app conoce: su carpeta de datos y los archivos registrados como materiales o presentaciones. */
function esRutaConocida(ruta: string): boolean {
  if (dentroDe(dataDir(), ruta)) return true
  const d = getDb()
  return Boolean(
    d.prepare('SELECT 1 FROM materiales WHERE ruta = ?').get(ruta) ||
      d.prepare('SELECT 1 FROM sesiones WHERE presentacion_path = ?').get(ruta) ||
      d.prepare('SELECT 1 FROM materias WHERE presentacion_path = ?').get(ruta)
  )
}

/** Abre un archivo o carpeta con su app (Finder, PowerPoint…) si es de la app y no es ejecutable. */
export async function abrirArchivo(ruta: string): Promise<void> {
  if (/^https?:\/\//i.test(ruta)) return abrirFuera(ruta)
  if (!ruta || !isAbsolute(ruta)) throw new Error('Ruta no válida.')
  if (EJECUTABLES.has(extname(ruta).toLowerCase())) throw new Error('Por seguridad la app no abre programas ni scripts.')
  if (!esRutaConocida(ruta)) throw new Error('Ese archivo no pertenece a la app.')
  const error = await shell.openPath(rutaMaterial(ruta))
  if (error) throw new Error(error)
}

/**
 * Ninguna ventana de la app navega fuera de su propio origen: los enlaces externos se abren en el
 * navegador. Aplica a la ventana principal, a la del panel del portal y a la oculta de PDFs.
 */
export function blindarNavegacion(contenido: WebContents): void {
  contenido.on('will-navigate', (e, url) => {
    if (!mismoOrigen(contenido.getURL(), url)) {
      e.preventDefault()
      abrirFuera(url)
    }
  })
  contenido.setWindowOpenHandler(({ url }) => {
    abrirFuera(url)
    return { action: 'deny' }
  })
}

function mismoOrigen(actual: string, destino: string): boolean {
  try {
    const a = new URL(actual)
    const b = new URL(destino)
    // file:// no tiene origen: solo se permite volver a cargar la misma página de la app
    if (a.protocol === 'file:' || b.protocol === 'file:') return a.protocol === b.protocol && a.pathname === b.pathname
    return a.origin === b.origin
  } catch {
    return false
  }
}
