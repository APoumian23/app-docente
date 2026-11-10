import { basename, extname, isAbsolute, relative } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import { materialesDir, rutaMaterial } from '../db'
import { pdfProyectable, necesitaConversion } from './presentacion'
import type { VistaMaterial } from '@shared/types'

/**
 * Cómo mostrar un material dentro de la app (Materias › Materiales › Abrir), sin mandarlo a otro programa:
 * PDF e imágenes con el protocolo docente://, Word como HTML, Excel/CSV como tabla, presentaciones
 * convertidas a PDF, y código o texto tal cual.
 */

const IMAGENES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])
const TEXTO = new Set(['.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.sql', '.html', '.css', '.md', '.txt', '.json', '.csv', '.r', '.m', '.sh', '.xml', '.yml', '.yaml'])
const MAX_TEXTO = 400_000
const MAX_FILAS = 1000

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** URL docente:// si el archivo vive en la carpeta de materiales (el protocolo no sirve nada fuera de ella) */
function urlDocente(ruta: string): string | null {
  const r = relative(materialesDir(), ruta)
  if (!r || r.startsWith('..') || isAbsolute(r) || r.includes('/')) return null
  return `docente://materiales/${encodeURIComponent(basename(ruta))}`
}

const ESTILO = `<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2430;margin:0;padding:28px 36px;background:#fff;max-width:900px}
  img{max-width:100%;height:auto} table{border-collapse:collapse;font-size:13px}
  td,th{border:1px solid #d9dce3;padding:4px 8px;vertical-align:top} th{background:#f3f4f7;position:sticky;top:0}
  h1,h2,h3{line-height:1.25} a{color:#2f5bd3}
  .hoja{margin:0 0 28px} .hoja h2{font-size:15px;margin:0 0 8px} .nota{color:#6b7280;font-size:12px}
</style>`

async function excelAHtml(ruta: string): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(ruta)
  const partes: string[] = []
  wb.eachSheet((ws) => {
    const filas: string[] = []
    let n = 0
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (++n > MAX_FILAS) return
      const celdas = (row.values as unknown[]).slice(1).map((v) => {
        const x = v && typeof v === 'object' ? ('result' in v ? (v as { result: unknown }).result : 'text' in v ? (v as { text: unknown }).text : 'richText' in v ? (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('') : v) : v
        return x == null ? '' : x instanceof Date ? x.toLocaleDateString('es-MX', { timeZone: 'UTC' }) : String(x)
      })
      const etiqueta = n === 1 ? 'th' : 'td'
      filas.push(`<tr>${celdas.map((c) => `<${etiqueta}>${esc(c)}</${etiqueta}>`).join('')}</tr>`)
    })
    partes.push(`<section class="hoja"><h2>${esc(ws.name)}</h2>${filas.length ? `<table>${filas.join('')}</table>` : '<p class="nota">Hoja vacía</p>'}${n > MAX_FILAS ? `<p class="nota">Se muestran las primeras ${MAX_FILAS} filas de ${n}.</p>` : ''}</section>`)
  })
  return partes.join('') || '<p class="nota">El libro no tiene hojas.</p>'
}

function csvAHtml(texto: string): string {
  const sep = (texto.split('\n')[0].match(/;/g)?.length ?? 0) > (texto.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ','
  const filas = texto.split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_FILAS)
  return `<table>${filas.map((l, i) => `<tr>${l.split(sep).map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`
}

/** Celdas de un cuaderno de Jupyter como texto legible */
function cuadernoATexto(texto: string): string {
  try {
    const nb = JSON.parse(texto) as { cells?: { cell_type: string; source: string | string[] }[] }
    return (nb.cells ?? []).map((c) => `${c.cell_type === 'code' ? '# ── Código ──' : '# ── Texto ──'}\n${Array.isArray(c.source) ? c.source.join('') : c.source}`).join('\n\n')
  } catch {
    return texto
  }
}

export async function vistaMaterial(ruta: string): Promise<VistaMaterial> {
  ruta = rutaMaterial(ruta)
  const nombre = basename(ruta).replace(/^\d{10,}-/, '')
  if (/^https?:\/\//i.test(ruta)) {
    // GeoGebra se deja incrustar (está permitido en la app); el resto de las páginas no
    if (/^https:\/\/(www\.)?geogebra\.org\//i.test(ruta)) return { tipo: 'web', nombre, url: ruta }
    return { tipo: 'externo', nombre, motivo: 'Es una página de internet: se abre en el navegador.' }
  }
  if (!existsSync(ruta)) return { tipo: 'externo', nombre, motivo: 'El archivo ya no está en la carpeta de materiales.' }
  const ext = extname(ruta).toLowerCase()
  const tamano = statSync(ruta).size

  if (ext === '.pdf' || ['.pptx', '.ppt', '.key'].includes(ext)) {
    const pdf = pdfProyectable(ruta)
    const url = pdf ? urlDocente(pdf) : null
    if (url) return { tipo: 'pdf', nombre, url }
    if (necesitaConversion(ruta)) return { tipo: 'convertir', nombre, motivo: 'La presentación se convierte a PDF una vez para verla dentro de la app.' }
    return { tipo: 'externo', nombre, motivo: 'El archivo está fuera de la carpeta de materiales de la app.' }
  }
  if (IMAGENES.has(ext)) {
    const url = urlDocente(ruta)
    return url ? { tipo: 'imagen', nombre, url } : { tipo: 'externo', nombre, motivo: 'El archivo está fuera de la carpeta de materiales de la app.' }
  }
  if (ext === '.docx') {
    const r = await mammoth.convertToHtml({ path: ruta })
    return { tipo: 'html', nombre, html: `${ESTILO}${r.value || '<p class="nota">El documento no tiene texto.</p>'}` }
  }
  if (ext === '.xlsx') return { tipo: 'html', nombre, html: `${ESTILO}${await excelAHtml(ruta)}` }
  if (ext === '.csv') return { tipo: 'html', nombre, html: `${ESTILO}${csvAHtml(readFileSync(ruta, 'utf8'))}` }
  if (TEXTO.has(ext) || ext === '.ipynb') {
    let texto = readFileSync(ruta, 'utf8')
    if (ext === '.ipynb') texto = cuadernoATexto(texto)
    return { tipo: 'texto', nombre, texto: texto.slice(0, MAX_TEXTO), recortado: texto.length > MAX_TEXTO }
  }
  if (ext === '.ggb') return { tipo: 'externo', nombre, motivo: 'Los archivos .ggb se abren con GeoGebra. Para verlo dentro de la app, agrégalo como enlace de geogebra.org.' }
  if (ext === '.doc' || ext === '.xls') return { tipo: 'externo', nombre, motivo: `El formato ${ext} es antiguo y no se puede mostrar dentro de la app; guárdalo como ${ext}x para verlo aquí.` }
  return { tipo: 'externo', nombre, motivo: `No hay vista dentro de la app para archivos ${ext || 'sin extensión'}${tamano ? '' : ' (está vacío)'}.` }
}
