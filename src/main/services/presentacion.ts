import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, statSync } from 'fs'
import { extname } from 'path'
import { rutaMaterial } from '../db'

const ejecutar = promisify(execFile)

/** Ruta del PDF hermano de un archivo de presentación. */
export function rutaPdfDe(ruta: string): string {
  return ruta.replace(/\.[^.]+$/, '') + '.pdf'
}

const SOFFICE = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice']
const conversores = (): string | null => SOFFICE.find((r) => existsSync(r)) ?? null

/**
 * Devuelve el PDF que se puede proyectar dentro de la app, o null si hay que generarlo.
 * Un PDF se proyecta tal cual; un PPTX necesita su PDF hermano y que no esté desactualizado.
 */
export function pdfProyectable(ruta: string | null | undefined): string | null {
  if (!ruta || ruta.startsWith('http')) return null
  ruta = rutaMaterial(ruta)
  const ext = extname(ruta).toLowerCase()
  if (ext === '.pdf') return existsSync(ruta) ? ruta : null
  if (ext !== '.pptx' && ext !== '.ppt' && ext !== '.key') return null
  const pdf = rutaPdfDe(ruta)
  if (!existsSync(pdf) || !existsSync(ruta)) return existsSync(pdf) ? pdf : null
  // Si el original cambió después de convertirlo, el PDF ya no sirve
  return statSync(pdf).mtimeMs >= statSync(ruta).mtimeMs ? pdf : null
}

/** Qué herramienta se usará para convertir presentaciones a PDF. */
export function conversorDisponible(): { tipo: 'libreoffice' | 'keynote'; detalle: string } {
  const so = conversores()
  if (so) return { tipo: 'libreoffice', detalle: 'LibreOffice: convierte en segundo plano, sin abrir ventanas.' }
  return { tipo: 'keynote', detalle: 'Keynote: se abre unos segundos y toma el foco. Instala LibreOffice para convertir sin interrupciones.' }
}

export function necesitaConversion(ruta: string | null | undefined): boolean {
  if (!ruta || ruta.startsWith('http')) return false
  const ext = extname(ruta).toLowerCase()
  return ['.pptx', '.ppt', '.key'].includes(ext) && !pdfProyectable(ruta)
}

/**
 * Convierte una presentación a PDF para poder proyectarla dentro de la app.
 * Usa LibreOffice si está instalado (no abre ventanas); si no, Keynote, que sí se abre
 * unos segundos y toma el foco: conviene hacerlo antes de la clase, no durante.
 */
export async function convertirAPdf(ruta: string): Promise<string> {
  ruta = rutaMaterial(ruta)
  if (!existsSync(ruta)) throw new Error('El archivo de la presentación ya no existe.')
  const ya = pdfProyectable(ruta)
  if (ya) return ya
  const destino = rutaPdfDe(ruta)
  const soffice = conversores()

  if (soffice) {
    const carpeta = ruta.slice(0, ruta.lastIndexOf('/'))
    await ejecutar(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', carpeta, ruta], { timeout: 180_000 })
    if (existsSync(destino)) return destino
  }

  const script = `
set entrada to POSIX file ${JSON.stringify(ruta)}
set salida to POSIX file ${JSON.stringify(destino)}
tell application "Keynote"
  set d to open entrada
  export d to salida as PDF
  close d saving no
end tell
return "ok"`
  try {
    await ejecutar('osascript', ['-e', script], { timeout: 240_000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/-1743|not authorized|no autorizado/i.test(msg)) {
      throw new Error('macOS bloqueó el control de Keynote. Autorízalo en Ajustes del Sistema › Privacidad y seguridad › Automatización y vuelve a intentarlo.')
    }
    throw new Error(`No se pudo convertir con Keynote: ${msg.split('\n')[0]}`)
  }
  if (!existsSync(destino)) throw new Error('La conversión terminó pero no se generó el PDF.')
  return destino
}
