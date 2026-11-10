import { extname } from 'path'
import { readFileSync } from 'fs'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import type { Material } from '@shared/types'
import { rutaMaterial } from '../db'

export function tipoPorExtension(ruta: string): Material['tipo'] {
  const ext = extname(ruta).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx' || ext === '.doc') return 'docx'
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'xlsx'
  if (ext === '.pptx' || ext === '.ppt' || ext === '.key') return 'pptx'
  if (ext === '.ggb') return 'geogebra'
  if (['.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.sql', '.html', '.css', '.m', '.r', '.ipynb', '.txt', '.md'].includes(ext)) return 'codigo'
  return 'otro'
}

/** Extrae texto plano de un archivo para usarlo como contexto de la IA. Nunca lanza: si falla regresa ''. */
export async function extraerTexto(ruta: string): Promise<string> {
  ruta = rutaMaterial(ruta)
  const tipo = tipoPorExtension(ruta)
  try {
    if (tipo === 'docx') {
      const r = await mammoth.extractRawText({ path: ruta })
      return limpiar(r.value)
    }
    if (tipo === 'xlsx') {
      if (extname(ruta).toLowerCase() === '.csv') return limpiar(readFileSync(ruta, 'utf8'))
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(ruta)
      const partes: string[] = []
      wb.eachSheet((ws) => {
        partes.push(`### Hoja: ${ws.name}`)
        ws.eachRow((row) => {
          const celdas = (row.values as unknown[]).slice(1).map((v) => (v == null ? '' : String(typeof v === 'object' && v && 'result' in (v as object) ? (v as { result: unknown }).result : v)))
          partes.push(celdas.join(' | '))
        })
      })
      return limpiar(partes.join('\n'))
    }
    if (tipo === 'pdf') return limpiar(await textoDePdf(ruta))
    if (tipo === 'pptx' && extname(ruta).toLowerCase() === '.pptx') return limpiar(await textoDePptx(ruta))
    if (tipo === 'codigo') return limpiar(readFileSync(ruta, 'utf8'))
    if (tipo === 'geogebra') return '(Archivo GeoGebra .ggb: ábrelo con GeoGebra o incrústalo en la app con su enlace de geogebra.org)'
  } catch (e) {
    console.error('extraerTexto', ruta, e)
  }
  return ''
}

/**
 * Texto de un PDF con pdf.js (Mozilla). Se usa directo y en versión ≥ 6.2.108: la anterior, que traía
 * officeparser, podía ejecutar JavaScript al abrir un PDF malicioso.
 */
async function textoDePdf(ruta: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const tarea = pdfjs.getDocument({ data: new Uint8Array(readFileSync(ruta)), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await tarea.promise
  try {
    const paginas: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const contenido = await (await doc.getPage(n)).getTextContent()
      paginas.push(contenido.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join(''))
    }
    return paginas.join('\n\n')
  } finally {
    await tarea.destroy()
  }
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const desescapar = (t: string): string =>
  t.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTIDADES[e] ?? m)
  )

/** Texto de un PowerPoint: cada diapositiva en orden, un párrafo por línea, con sus notas del orador. */
async function textoDePptx(ruta: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(ruta))
  const leer = async (f: string): Promise<string> => (await zip.file(f)?.async('string')) ?? ''
  const deXml = (xml: string): string =>
    (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => desescapar(t.slice(5, -6))).join(''))
      .filter((l) => l.trim())
      .join('\n')
  const diapositivas = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
  const partes = await Promise.all(
    diapositivas.map(async (f) => {
      // Las notas no siempre llevan el número de su diapositiva: se siguen por la relación de la diapositiva
      const rels = await leer(f.replace('slides/', 'slides/_rels/') + '.rels')
      const destino = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1]
      const notas = destino ? deXml(await leer(`ppt/notesSlides/${destino}`)).replace(/^\d+$/m, '').trim() : ''
      return [deXml(await leer(f)), notas && `Notas: ${notas}`].filter(Boolean).join('\n')
    })
  )
  return partes.join('\n\n')
}

function limpiar(t: string): string {
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 120_000)
}
