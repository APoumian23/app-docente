/**
 * Texto de un PDF o PowerPoint para los scripts de carga (CommonJS). Es la misma extracción que
 * src/main/services/extract.ts; reemplaza a officeparser, que traía un pdf.js vulnerable.
 */
const { readFileSync } = require('fs')
const { extname } = require('path')
const JSZip = require('jszip')

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const desescapar = (t) =>
  t.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTIDADES[e] ?? m)))

async function textoDePdf(ruta) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const tarea = pdfjs.getDocument({ data: new Uint8Array(readFileSync(ruta)), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  const doc = await tarea.promise
  try {
    const paginas = []
    for (let n = 1; n <= doc.numPages; n++) {
      const c = await (await doc.getPage(n)).getTextContent()
      paginas.push(c.items.map((i) => ('str' in i ? i.str + (i.hasEOL ? '\n' : ' ') : '')).join(''))
    }
    return paginas.join('\n\n')
  } finally {
    await tarea.destroy()
  }
}

async function textoDePptx(ruta) {
  const zip = await JSZip.loadAsync(readFileSync(ruta))
  const deXml = (xml) =>
    (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => desescapar(t.slice(5, -6))).join(''))
      .filter((l) => l.trim())
      .join('\n')
  const diapositivas = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]))
  const partes = []
  for (const f of diapositivas) partes.push(deXml(await zip.file(f).async('string')))
  return partes.join('\n\n')
}

/** Igual que el antiguo parseOfficeAsync de officeparser para PDF y PPTX. */
async function textoDeArchivo(ruta) {
  const ext = extname(ruta).toLowerCase()
  if (ext === '.pdf') return textoDePdf(ruta)
  if (ext === '.pptx') return textoDePptx(ruta)
  throw new Error(`Formato no soportado: ${ext}`)
}

module.exports = { textoDeArchivo }
