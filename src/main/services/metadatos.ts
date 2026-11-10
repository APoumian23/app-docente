/**
 * Revisión de copias por metadatos: lee lo que cada archivo entregado dice de sí mismo (autor, último editor,
 * título interno, fechas, minutos de edición, programa, cámara de la foto) y lo compara entre alumnos.
 * Sin Electron: recibe rutas y datos, así se puede probar sobre copias.
 *
 * Las señales son pistas para que el docente revise, no pruebas: un autor genérico o un mismo programa no
 * dicen nada; el mismo archivo, el mismo texto o el nombre de otro alumno adentro, sí.
 */
import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'
import JSZip from 'jszip'
import { extraerTexto } from './extract'
import type { ArchivoRevisado, HallazgoMetadatos, InformeCopias, SenalCopia } from '@shared/copias'
import { cortoDesdeCompleto } from '@shared/copias'

// ---------- Lectura ----------

export interface MetadatosArchivo {
  autor: string
  ultimo_editor: string
  titulo: string
  programa: string
  empresa: string
  plantilla: string
  creado: string | null
  modificado: string | null
  minutos_edicion: number | null
  revision: string
  camara: string
  fecha_foto: string | null
  /** Identificador de la cuenta que creó el archivo (en Colab, su «authorship_tag»): igual en dos alumnos = misma cuenta */
  cuenta: string
  /** Quiénes dejaron comentarios o cambios controlados dentro del documento (Word, PowerPoint, Excel) */
  otros_autores: string
}

const vacio = (): MetadatosArchivo => ({
  autor: '',
  ultimo_editor: '',
  titulo: '',
  programa: '',
  empresa: '',
  plantilla: '',
  creado: null,
  modificado: null,
  minutos_edicion: null,
  revision: '',
  camara: '',
  fecha_foto: null,
  cuenta: '',
  otros_autores: ''
})

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const desescapar = (t: string): string =>
  t.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTIDADES[e] ?? m)
  )
const etiqueta = (xml: string, nombre: string): string => desescapar(xml.match(new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}>`))?.[1]?.trim() ?? '')
const fechaIso = (t: string): string | null => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null)

/** Word, PowerPoint y Excel (formato moderno): docProps/core.xml y docProps/app.xml. */
async function deOffice(datos: Buffer): Promise<MetadatosArchivo> {
  const m = vacio()
  const zip = await JSZip.loadAsync(datos)
  const core = (await zip.file('docProps/core.xml')?.async('string')) ?? ''
  const app = (await zip.file('docProps/app.xml')?.async('string')) ?? ''
  m.autor = etiqueta(core, 'dc:creator')
  m.ultimo_editor = etiqueta(core, 'cp:lastModifiedBy')
  m.titulo = etiqueta(core, 'dc:title')
  m.revision = etiqueta(core, 'cp:revision')
  m.creado = fechaIso(etiqueta(core, 'dcterms:created'))
  m.modificado = fechaIso(etiqueta(core, 'dcterms:modified'))
  m.programa = [etiqueta(app, 'Application'), etiqueta(app, 'AppVersion')].filter(Boolean).join(' ')
  m.empresa = etiqueta(app, 'Company')
  m.plantilla = etiqueta(app, 'Template')
  const total = etiqueta(app, 'TotalTime')
  m.minutos_edicion = total && /^\d+$/.test(total) ? Number(total) : null
  m.otros_autores = (await autoresDentro(zip)).join(' · ')
  return m
}

/**
 * Quién comentó o hizo cambios controlados dentro del archivo: Word (comentarios y control de cambios),
 * PowerPoint (autores de comentarios) y Excel (notas y comentarios). Ahí suele quedar el nombre de quien lo hizo de verdad.
 */
async function autoresDentro(zip: JSZip): Promise<string[]> {
  const nombres = new Set<string>()
  const de = async (ruta: string, patron: RegExp): Promise<void> => {
    const xml = (await zip.file(ruta)?.async('string')) ?? ''
    for (const x of xml.matchAll(patron)) if (x[1]?.trim()) nombres.add(desescapar(x[1].trim()))
  }
  await de('word/comments.xml', /w:author="([^"]*)"/g)
  await de('word/document.xml', /<w:(?:ins|del|moveFrom|moveTo)\b[^>]*w:author="([^"]*)"/g)
  await de('ppt/commentAuthors.xml', /\bname="([^"]*)"/g)
  await de('ppt/authors.xml', /\bname="([^"]*)"/g)
  for (const f of Object.keys(zip.files).filter((n) => /^xl\/comments\d*\.xml$/.test(n))) await de(f, /<author>([^<]*)<\/author>/g)
  await de('xl/persons/person.xml', /displayName="([^"]*)"/g)
  return [...nombres].slice(0, 12)
}

/** LibreOffice y OpenOffice (.odt, .ods, .odp): meta.xml. */
async function deOdf(datos: Buffer): Promise<MetadatosArchivo> {
  const m = vacio()
  const zip = await JSZip.loadAsync(datos)
  const meta = (await zip.file('meta.xml')?.async('string')) ?? ''
  m.autor = etiqueta(meta, 'meta:initial-creator')
  m.ultimo_editor = etiqueta(meta, 'dc:creator')
  m.titulo = etiqueta(meta, 'dc:title')
  m.creado = fechaIso(etiqueta(meta, 'meta:creation-date'))
  m.modificado = fechaIso(etiqueta(meta, 'dc:date'))
  m.programa = etiqueta(meta, 'meta:generator')
  m.revision = etiqueta(meta, 'meta:editing-cycles')
  // «PT1H23M4S»
  // Quién dejó comentarios dentro del documento
  const contenido = (await zip.file('content.xml')?.async('string')) ?? ''
  const comentaron = new Set<string>()
  for (const x of contenido.matchAll(/<office:annotation\b[\s\S]*?<dc:creator>([^<]*)<\/dc:creator>/g)) if (x[1].trim()) comentaron.add(desescapar(x[1].trim()))
  m.otros_autores = [...comentaron].slice(0, 12).join(' · ')
  const d = etiqueta(meta, 'meta:editing-duration').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/)
  if (d && (d[1] || d[2] || d[3])) m.minutos_edicion = Number(d[1] ?? 0) * 1440 + Number(d[2] ?? 0) * 60 + Number(d[3] ?? 0)
  return m
}

/**
 * Word, Excel y PowerPoint de antes de 2007 (.doc, .xls, .ppt): un archivo «compuesto» de Microsoft (OLE) con
 * una ficha de propiedades adentro (SummaryInformation). Aquí se lee solo esa ficha, sin abrir el documento.
 */
function deOle(datos: Buffer): MetadatosArchivo {
  const m = vacio()
  if (datos.length < 512 || datos.readUInt32LE(0) !== 0xe011cfd0) return m
  const tam = 1 << datos.readUInt16LE(0x1e)
  const tamMini = 1 << datos.readUInt16LE(0x20)
  const corte = datos.readUInt32LE(0x38)
  const sector = (n: number): Buffer => datos.subarray((n + 1) * tam, (n + 2) * tam)
  const FIN = 0xfffffffe
  // Tabla de asignación (FAT): sus sectores vienen en la cabecera y, si son muchos, en una cadena aparte (DIFAT)
  const sectoresFat: number[] = []
  for (let i = 0; i < 109; i++) {
    const n = datos.readUInt32LE(0x4c + i * 4)
    if (n < FIN) sectoresFat.push(n)
  }
  for (let d = datos.readUInt32LE(0x44), vueltas = 0; d < FIN && vueltas < 1000; vueltas++) {
    const b = sector(d)
    for (let i = 0; i < tam / 4 - 1; i++) {
      const n = b.readUInt32LE(i * 4)
      if (n < FIN) sectoresFat.push(n)
    }
    d = b.readUInt32LE(tam - 4)
  }
  const fat: number[] = []
  for (const n of sectoresFat) {
    const b = sector(n)
    for (let i = 0; i + 4 <= b.length; i += 4) fat.push(b.readUInt32LE(i))
  }
  const cadena = (inicio: number, tabla: number[]): number[] => {
    const r: number[] = []
    for (let n = inicio; n < FIN && r.length <= tabla.length; n = tabla[n] ?? FIN) r.push(n)
    return r
  }
  const leer = (inicio: number): Buffer => Buffer.concat(cadena(inicio, fat).map(sector))
  const dir = leer(datos.readUInt32LE(0x30))
  const entradas: { nombre: string; inicio: number; tamano: number }[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const largo = dir.readUInt16LE(o + 0x40)
    if (!largo) continue
    entradas.push({ nombre: dir.toString('utf16le', o, o + largo - 2), inicio: dir.readUInt32LE(o + 0x74), tamano: dir.readUInt32LE(o + 0x78) })
  }
  const raiz = entradas[0]
  const miniFat: number[] = []
  const bMini = datos.readUInt32LE(0x3c) < FIN ? leer(datos.readUInt32LE(0x3c)) : Buffer.alloc(0)
  for (let i = 0; i + 4 <= bMini.length; i += 4) miniFat.push(bMini.readUInt32LE(i))
  const miniFlujo = raiz ? leer(raiz.inicio) : Buffer.alloc(0)
  const flujo = (nombre: string): Buffer | null => {
    const e = entradas.find((x) => x.nombre === nombre)
    if (!e) return null
    const b = e.tamano < corte ? Buffer.concat(cadena(e.inicio, miniFat).map((n) => miniFlujo.subarray(n * tamMini, (n + 1) * tamMini))) : leer(e.inicio)
    return b.subarray(0, e.tamano)
  }
  // Ficha de propiedades: identificador → valor (texto, fecha o número)
  const propiedades = (b: Buffer | null): Map<number, string | number | Date> => {
    const r = new Map<number, string | number | Date>()
    if (!b || b.length < 48) return r
    const base = b.readUInt32LE(44)
    const n = b.readUInt32LE(base + 4)
    // La página de códigos (propiedad 1) dice cómo leer los textos: LibreOffice escribe UTF-8; Office, Windows-1252
    let utf8 = false
    for (let i = 0; i < n && i < 200; i++) {
      if (b.readUInt32LE(base + 8 + i * 8) !== 1) continue
      const o = base + b.readUInt32LE(base + 12 + i * 8)
      if (o + 6 <= b.length) utf8 = b.readUInt16LE(o + 4) === 65001
    }
    for (let i = 0; i < n && i < 200; i++) {
      const id = b.readUInt32LE(base + 8 + i * 8)
      const o = base + b.readUInt32LE(base + 12 + i * 8)
      if (o + 8 > b.length) continue
      const tipo = b.readUInt32LE(o)
      if (tipo === 0x1e) r.set(id, b.toString(utf8 ? 'utf8' : 'latin1', o + 8, o + 8 + b.readUInt32LE(o + 4)).replace(/\0+$/, '').trim())
      else if (tipo === 0x1f) r.set(id, b.toString('utf16le', o + 8, o + 8 + b.readUInt32LE(o + 4) * 2).replace(/\0+$/, '').trim())
      else if (tipo === 0x03) r.set(id, b.readInt32LE(o + 4))
      else if (tipo === 0x40) {
        const t = b.readBigUInt64LE(o + 4)
        // El tiempo de edición también es FILETIME, pero como duración
        r.set(id, id === 10 ? Number(t / 600000000n) : new Date(Number(t / 10000n) - 11644473600000))
      }
    }
    return r
  }
  const si = propiedades(flujo('\u0005SummaryInformation'))
  const dsi = propiedades(flujo('\u0005DocumentSummaryInformation'))
  const texto = (v: unknown): string => (typeof v === 'string' ? v : '')
  const fecha = (v: unknown): string | null => (v instanceof Date && v.getFullYear() > 1990 ? v.toISOString() : null)
  m.titulo = texto(si.get(2))
  m.autor = texto(si.get(4))
  m.plantilla = texto(si.get(7))
  m.ultimo_editor = texto(si.get(8))
  m.revision = texto(si.get(9))
  m.minutos_edicion = typeof si.get(10) === 'number' ? (si.get(10) as number) : null
  m.creado = fecha(si.get(12))
  m.modificado = fecha(si.get(13))
  m.programa = texto(si.get(18))
  m.empresa = texto(dsi.get(15))
  return m
}

/** PNG (capturas de pantalla, imágenes exportadas): sus textos internos (programa, autor, fecha). */
function dePng(datos: Buffer): MetadatosArchivo {
  const m = vacio()
  const textos = new Map<string, string>()
  for (let o = 8; o + 12 <= datos.length; ) {
    const largo = datos.readUInt32BE(o)
    const tipo = datos.toString('ascii', o + 4, o + 8)
    const d = datos.subarray(o + 8, o + 8 + largo)
    if (tipo === 'tEXt' || tipo === 'iTXt') {
      const cero = d.indexOf(0)
      const clave = d.toString('latin1', 0, cero)
      let valor = ''
      if (tipo === 'tEXt') valor = d.toString('latin1', cero + 1)
      else if (d[cero + 1] === 0) {
        // iTXt sin comprimir: clave\0 bandera método idioma\0 clave traducida\0 texto
        const idioma = d.indexOf(0, cero + 3)
        const traducida = d.indexOf(0, idioma + 1)
        valor = d.toString('utf8', traducida + 1)
      }
      textos.set(clave, valor.trim())
    }
    if (tipo === 'IEND') break
    o += 12 + largo
  }
  const xmp = textos.get('XML:com.adobe.xmp') ?? ''
  m.programa = textos.get('Software') || etiqueta(xmp, 'xmp:CreatorTool') || (/Screenshot/i.test(xmp) ? 'Captura de pantalla' : '')
  m.autor = textos.get('Author') ?? ''
  m.titulo = textos.get('Title') ?? ''
  m.creado = fechaIso(textos.get('Creation Time') ?? '') ?? fechaIso(etiqueta(xmp, 'xmp:CreateDate') || etiqueta(xmp, 'photoshop:DateCreated'))
  return m
}

/** RTF: el bloque {\\info …} con autor, operador (último que guardó), fechas y minutos de edición. */
function deRtf(datos: Buffer): MetadatosArchivo {
  const m = vacio()
  const t = datos.toString('latin1', 0, Math.min(datos.length, 200_000))
  // Los acentos vienen escapados: \\'ed = í (Windows-1252) o \\u237? (Unicode)
  const sinEscapes = (x: string): string =>
    x
      .replace(/\\u(-?\d+)\??/g, (_, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
      .replace(/\\'([0-9a-f]{2})/gi, (_, h: string) => Buffer.from([parseInt(h, 16)]).toString('latin1'))
  const campo = (n: string): string => sinEscapes(t.match(new RegExp(`\\{\\\\${n}\\s+([^}]*)\\}`))?.[1]?.trim() ?? '')
  const fecha = (n: string): string | null => {
    const b = t.match(new RegExp(`\\{\\\\${n}([^}]*)\\}`))?.[1] ?? ''
    const v = (k: string): string => (b.match(new RegExp(`\\\\${k}(\\d+)`))?.[1] ?? '').padStart(2, '0')
    return v('yr') !== '00' ? fechaIso(`${v('yr')}-${v('mo')}-${v('dy')}T${v('hr')}:${v('min')}:00`) : null
  }
  m.titulo = campo('title')
  m.autor = campo('author')
  m.ultimo_editor = campo('operator')
  m.empresa = campo('company')
  m.creado = fecha('creatim')
  m.modificado = fecha('revtim')
  const min = t.match(/\\edmins(\d+)/)?.[1]
  m.minutos_edicion = min ? Number(min) : null
  return m
}

/** «D:20261023002300-06'00'» → ISO */
function fechaPdf(t: unknown): string | null {
  const s = String(t ?? '')
  const x = s.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/)
  if (!x) return null
  const [, a, mes = '01', d = '01', h = '00', mi = '00', se = '00', signo, zh = '00', zm = '00'] = x
  const zona = !signo || signo.toUpperCase() === 'Z' ? 'Z' : `${signo}${zh}:${zm}`
  return fechaIso(`${a}-${mes}-${d}T${h}:${mi}:${se}${zona}`)
}

async function dePdf(datos: Buffer): Promise<MetadatosArchivo> {
  const m = vacio()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const tarea = pdfjs.getDocument({ data: new Uint8Array(datos), disableFontFace: true, useSystemFonts: false, verbosity: 0 })
  try {
    const doc = await tarea.promise
    const info = (await doc.getMetadata()).info as unknown as Record<string, unknown>
    m.autor = String(info.Author ?? '').trim()
    m.titulo = String(info.Title ?? '').trim()
    m.programa = [info.Creator, info.Producer].filter((x) => x && String(x).trim()).map(String).join(' · ')
    m.creado = fechaPdf(info.CreationDate)
    m.modificado = fechaPdf(info.ModDate)
    // Lo que el Info no trae suele estar en el XMP (Word, Google Docs, Canva y los exportadores lo llenan)
    const xmp = (await doc.getMetadata()).metadata as unknown as { get?: (k: string) => unknown } | null
    const de = (k: string): string => {
      const v = xmp?.get?.(k)
      return (Array.isArray(v) ? v.join(', ') : String(v ?? '')).trim()
    }
    if (!m.autor) m.autor = de('dc:creator')
    if (!m.titulo) m.titulo = de('dc:title')
    if (!m.programa) m.programa = [de('xmp:creatortool'), de('pdf:producer')].filter(Boolean).join(' · ')
    if (!m.creado) m.creado = fechaIso(de('xmp:createdate'))
    if (!m.modificado) m.modificado = fechaIso(de('xmp:modifydate'))
  } finally {
    await tarea.destroy()
  }
  return m
}

/** EXIF de una foto JPEG: cámara (marca y modelo) y cuándo se tomó. Lo justo para saber si dos fotos son la misma. */
function deJpeg(datos: Buffer): MetadatosArchivo {
  const m = vacio()
  let i = 2
  while (i + 4 < datos.length && datos[i] === 0xff) {
    const marca = datos[i + 1]
    const largo = datos.readUInt16BE(i + 2)
    if (marca === 0xe1 && datos.toString('ascii', i + 4, i + 10) === 'Exif\u0000\u0000') {
      const tiff = i + 10
      const le = datos.toString('ascii', tiff, tiff + 2) === 'II'
      const u16 = (o: number): number => (le ? datos.readUInt16LE(o) : datos.readUInt16BE(o))
      const u32 = (o: number): number => (le ? datos.readUInt32LE(o) : datos.readUInt32BE(o))
      const texto = (e: number): string => {
        const n = u32(e + 4)
        const o = n <= 4 ? e + 8 : tiff + u32(e + 8)
        return o + n <= datos.length ? datos.toString('latin1', o, o + n).replace(/\u0000+$/, '').trim() : ''
      }
      const leerIfd = (ifd: number, f: (tag: number, entrada: number) => void): void => {
        if (ifd + 2 > datos.length) return
        const n = u16(ifd)
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12
          if (e + 12 > datos.length) return
          f(u16(e), e)
        }
      }
      let marcaCam = ''
      let modelo = ''
      let exif = 0
      leerIfd(tiff + u32(tiff + 4), (tag, e) => {
        if (tag === 0x010f) marcaCam = texto(e)
        else if (tag === 0x0110) modelo = texto(e)
        else if (tag === 0x0131) m.programa = texto(e)
        else if (tag === 0x013b) m.autor = texto(e)
        else if (tag === 0x8769) exif = tiff + u32(e + 8)
      })
      if (exif) {
        leerIfd(exif, (tag, e) => {
          if (tag === 0x9003) {
            const t = texto(e).match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
            // Sin zona horaria: es la hora del teléfono, sirve para comparar fotos entre sí
            if (t) m.fecha_foto = `${t[1]}-${t[2]}-${t[3]} ${t[4]}:${t[5]}:${t[6]}`
          }
        })
      }
      m.camara = [marcaCam, modelo].filter(Boolean).join(' ')
      return m
    }
    if (marca === 0xda) break
    i += 2 + largo
  }
  return m
}

interface Ipynb {
  metadata?: { colab?: { name?: string; authorship_tag?: string }; kernelspec?: { display_name?: string } }
  cells?: { cell_type?: string; source?: string | string[]; outputs?: { text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string }[] }[]
}
const unirTexto = (t: string | string[] | undefined): string => (Array.isArray(t) ? t.join('') : (t ?? ''))

/** Cuaderno de Jupyter o Colab: con qué se hizo, su nombre en Colab y la cuenta que lo creó. */
function deIpynb(nb: Ipynb): MetadatosArchivo {
  const m = vacio()
  const colab = nb.metadata?.colab
  m.programa = colab ? 'Google Colab' : nb.metadata?.kernelspec?.display_name ? `Jupyter (${nb.metadata.kernelspec.display_name})` : 'Jupyter'
  m.titulo = colab?.name ?? ''
  m.cuenta = colab?.authorship_tag ?? ''
  return m
}

/** El cuaderno si el archivo lo es (JSON con celdas); null si no. */
function cuadernoDe(datos: Buffer): Ipynb | null {
  const t = datos.toString('utf8').trimStart()
  if (!t.startsWith('{')) return null
  try {
    const nb = JSON.parse(t) as Ipynb
    return Array.isArray(nb.cells) ? nb : null
  } catch {
    return null
  }
}

/** Lo que se lee de un cuaderno: el texto de sus celdas y lo que salió al correrlas (sin imágenes ni el JSON alrededor). */
const textoDeIpynb = (nb: Ipynb): string =>
  (nb.cells ?? [])
    .map((c) => [unirTexto(c.source), ...(c.outputs ?? []).map((o) => unirTexto(o.text) || unirTexto(o.data?.['text/plain']) || [o.ename, o.evalue].filter(Boolean).join(': '))].join('\n'))
    .join('\n\n')

/** Metadatos y huella de un archivo. Nunca lanza: si algo no se puede leer, regresa lo que haya. */
export async function leerMetadatos(ruta: string): Promise<{ meta: MetadatosArchivo; sha256: string; tamano: number; texto: string; fuente?: string; error?: string }> {
  const datos = readFileSync(ruta)
  const sha256 = createHash('sha256').update(datos).digest('hex')
  const tamano = statSync(ruta).size
  const ext = extname(ruta).toLowerCase()
  let meta = vacio()
  let error: string | undefined
  try {
    if (['.docx', '.pptx', '.xlsx', '.docm', '.pptm', '.xlsm'].includes(ext)) meta = await deOffice(datos)
    else if (ext === '.pdf') meta = await dePdf(datos)
    else if (ext === '.jpg' || ext === '.jpeg') meta = deJpeg(datos)
    else if (ext === '.ipynb') meta = deIpynb(JSON.parse(datos.toString('utf8')) as Ipynb)
    else if (['.odt', '.ods', '.odp'].includes(ext)) meta = await deOdf(datos)
    else if (['.doc', '.xls', '.ppt'].includes(ext)) meta = deOle(datos)
    else if (ext === '.png') meta = dePng(datos)
    else if (ext === '.rtf') meta = deRtf(datos)
  } catch (e) {
    error = `No se pudieron leer sus metadatos (${(e as Error).message}).`
  }
  let texto = ''
  // Lo que escribió (celdas o código), sin las salidas: con eso se compara el código línea por línea
  let fuente: string | undefined
  try {
    // Un cuaderno puede llegar como «.ipynb.txt» (Classroom o el celular le agregan la extensión)
    const nb = ext === '.ipynb' || ext === '.txt' ? cuadernoDe(datos) : null
    if (nb) {
      texto = textoDeIpynb(nb)
      fuente = (nb.cells ?? []).map((c) => unirTexto(c.source)).join('\n')
      if (ext === '.txt' && !meta.programa) meta = deIpynb(nb)
    } else if (['.docx', '.pptx', '.xlsx', '.pdf', '.txt', '.md', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.sql'].includes(ext)) {
      texto = await extraerTexto(ruta)
      if (!['.docx', '.pptx', '.xlsx', '.pdf'].includes(ext)) fuente = texto
    }
  } catch {
    /* sin texto: no se compara el contenido */
  }
  return { meta, sha256, tamano, texto, fuente, error }
}

// ---------- Comparación ----------

export interface AlumnoDelGrupo {
  id: number | null
  nombre: string
  /** Primer nombre y apellido paterno («Mateo Ibarra»), para mostrar */
  corto?: string
  /** Correos y matrícula: lo que podría aparecer en una cuenta o en un nombre de archivo */
  cuentas: string[]
}

const normal = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
const palabras = (t: string): string[] => normal(t).split(/[^a-z0-9ñ]+/).filter(Boolean)

/** Autores que no dicen nada (cuentas genéricas de Office, de la escuela o de programas). */
const GENERICOS = new Set(['', 'usuario', 'user', 'microsoft office user', 'usuario de microsoft office', 'autor', 'author', 'admin', 'administrador', 'windows user', 'usuario de windows', 'hp', 'dell', 'lenovo', 'asus', 'acer', 'pc', 'alumno'])
/** Lo que deja python-pptx («Steve Canny» es su autor): presentaciones armadas por un programa, típico de las que genera una IA. */
const DE_PROGRAMA = /steve canny|python-pptx|python-docx|openpyxl|reportlab|chatgpt|openai|\bcopilot\b|\bgemini\b|\bclaude\b|gamma\.app|gamma|tome\.app|beautiful\.ai/i

/** Números con muchos dígitos (tiempos medidos, resultados con decimales): dos alumnos no los obtienen iguales por casualidad. */
const datosNumericos = (t: string): Set<string> => new Set(t.match(/\d+[.,]\d{3,}|\d{5,}/g) ?? [])

/**
 * ¿Es una medición (un tiempo, una razón con decimales) o un resultado entero? «75,025» o «317811» son enteros (Python
 * pone comas de miles): cualquiera que resuelva bien el ejercicio obtiene lo mismo, así que no dicen que alguien copió.
 * «0.016», «6.286,513» o «157.912» son mediciones de cada computadora: si salen iguales, se copiaron.
 */
const esMedicion = (x: string): boolean => !/^\d{1,3}(,\d{3})+$/.test(x) && /[.,]/.test(x)

/** Línea de código o de texto comparable: sin espacios de más ni mayúsculas */
const lineaNormal = (l: string): string => l.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Lo que cada alumno escribió en su código, línea por línea, sin lo que no dice nada de él:
 * - lo que la plantilla dicta en comentarios («#   candidato = precios[i] + r[largo - i]»): quien resuelve el ejercicio
 *   escribe esas líneas tal cual (se toman los comentarios que traen 3 o más archivos: los de la plantilla);
 * - lo que trae buena parte del grupo (la plantilla misma);
 * - las líneas triviales («else:», «return r»).
 * fuentes vacías (documentos) dan conjuntos vacíos.
 */
function lineasPropias(fuentes: string[]): Set<string>[] {
  const conCodigo = fuentes.filter((f) => f.trim()).length
  const dictadas = new Map<string, number>()
  const veces = new Map<string, number>()
  const porArchivo = fuentes.map((f) => {
    const comentarios = new Set<string>()
    const lineas = new Set<string>()
    for (const l of f.split('\n')) {
      const comentario = /^\s*#+\s*(.*)$/.exec(l)
      if (comentario) {
        if (comentario[1].trim()) comentarios.add(lineaNormal(comentario[1]))
        continue
      }
      const n = lineaNormal(l)
      if (n.replace(/\s/g, '').length >= 12) lineas.add(n)
    }
    for (const c of comentarios) dictadas.set(c, (dictadas.get(c) ?? 0) + 1)
    for (const x of lineas) veces.set(x, (veces.get(x) ?? 0) + 1)
    return lineas
  })
  const tope = Math.max(3, Math.ceil(conCodigo * 0.4))
  return porArchivo.map((lineas) => new Set([...lineas].filter((x) => (dictadas.get(x) ?? 0) < 3 && (veces.get(x) ?? 0) < tope)))
}

/** Líneas propias de código que dos alumnos tienen idénticas (sobre el menor de los dos) */
const MIN_LINEAS = 8

/** Pedazos de 5 palabras seguidas: dos textos que comparten muchos se copiaron (aunque cambien el orden de los párrafos). */
function pedazos(t: string): Set<string> {
  const p = palabras(t)
  const s = new Set<string>()
  for (let i = 0; i + 4 < p.length; i++) s.add(p.slice(i, i + 5).join(' '))
  return s
}

/** Archivos que se comparan entre sí para saber qué es base: un cuaderno y su exportación a .py traen el mismo código. */
function familia(nombre: string): string {
  const ext = extname(nombre).toLowerCase()
  if (['.ipynb', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.sql', '.txt', '.md'].includes(ext)) return 'codigo'
  if (['.xlsx', '.xls', '.ods', '.csv', '.xlsm'].includes(ext)) return 'hoja'
  if (['.pptx', '.ppt', '.odp', '.pptm'].includes(ext)) return 'presentacion'
  return 'documento'
}

/**
 * Lo que trae buena parte del grupo es la base del docente (instrucciones, plantilla, el cuaderno o el código
 * que compartió, los números de sus pruebas): no dice que uno copió a otro y se quita antes de comparar.
 * Se cuenta dentro de cada familia de archivos; es base lo que aparece en el 40 % de ella (y en 3 archivos o más),
 * así una copia entre dos o tres alumnos sigue saliendo. Con menos de 3 archivos de una familia se compara todo.
 */
function sinBaseComun(conjuntos: Set<string>[], familias: string[], fraccion = 0.4): Set<string>[] {
  const r = [...conjuntos]
  for (const f of new Set(familias)) {
    const indices = conjuntos.map((c, i) => (familias[i] === f && c.size ? i : -1)).filter((i) => i >= 0)
    if (indices.length < 3) continue
    const veces = new Map<string, number>()
    for (const i of indices) for (const x of conjuntos[i]) veces.set(x, (veces.get(x) ?? 0) + 1)
    const tope = Math.max(3, Math.ceil(indices.length * fraccion))
    for (const i of indices) r[i] = new Set([...conjuntos[i]].filter((x) => (veces.get(x) ?? 0) < tope))
  }
  return r
}

/** Pedazos propios (fuera de la base) que necesita cada archivo para comparar su texto */
const MIN_PROPIO = 30

function similitud(x: Set<string>, y: Set<string>): number {
  if (!x.size || !y.size) return 0
  let comunes = 0
  for (const s of x) if (y.has(s)) comunes++
  return comunes / Math.min(x.size, y.size)
}

/**
 * Palabras que identifican a cada alumno: las de su nombre que nadie más del grupo tiene (un «Orozco»
 * compartido no sirve), más sus cuentas. Los diminutivos («Gio») se buscan aparte, solo en títulos y nombres de archivo.
 */
function identificadores(alumnos: AlumnoDelGrupo[]): Map<string, { unicas: Set<string>; cuentas: string[]; nombres: string[] }> {
  const veces = new Map<string, number>()
  for (const a of alumnos) for (const p of new Set(palabras(a.nombre))) veces.set(p, (veces.get(p) ?? 0) + 1)
  const r = new Map<string, { unicas: Set<string>; cuentas: string[]; nombres: string[] }>()
  for (const a of alumnos) {
    const propias = palabras(a.nombre).filter((p) => p.length >= 4)
    r.set(a.nombre, {
      unicas: new Set(propias.filter((p) => veces.get(p) === 1 && !['jose', 'maria', 'juan', 'luis', 'angel', 'miguel', 'guadalupe', 'concepcion'].includes(p))),
      cuentas: a.cuentas.map((c) => normal(c).split('@')[0]).filter((c) => c.length >= 5),
      nombres: propias
    })
  }
  return r
}

/** A quién de los demás menciona un texto (autor, editor, título, nombre de archivo, cuenta de Drive). */
/** soloCuentas: en Drive se busca la cuenta (correo o matrícula), no el apellido: el docente o el dueño del curso pueden compartirlo. */
function mencionados(texto: string, dueno: string, ids: ReturnType<typeof identificadores>, conDiminutivos: boolean, soloCuentas = false): { alumno: string; fuerte: boolean }[] {
  const ps = palabras(texto)
  if (!ps.length) return []
  const unido = normal(texto)
  const propias = new Set(ids.get(dueno)?.nombres ?? [])
  const r: { alumno: string; fuerte: boolean }[] = []
  for (const [nombre, id] of ids) {
    if (nombre === dueno) continue
    if ((!soloCuentas && ps.some((p) => id.unicas.has(p) && !propias.has(p))) || id.cuentas.some((c) => unido.includes(c))) {
      r.push({ alumno: nombre, fuerte: true })
      continue
    }
    // «Tablas del 22_Gio»: un pedazo corto que solo puede ser el nombre de uno del grupo
    if (conDiminutivos && !soloCuentas) {
      const candidatos = [...id.unicas].filter((u) => ps.some((p) => p.length >= 3 && p.length <= 5 && p.length < u.length && u.startsWith(p) && ![...propias].some((q) => q.startsWith(p))))
      if (candidatos.length) r.push({ alumno: nombre, fuerte: false })
    }
  }
  return r
}

export interface Entregado {
  alumno: AlumnoDelGrupo
  origen: ArchivoRevisado['origen']
  nombre: string
  ruta: string
  entregado: string | null
  drive?: {
    dueno: string
    dueno_correo: string
    editor: string
    editor_correo: string
    creado: string | null
    modificado: string | null
    nombre_original?: string
    editores?: { nombre: string; correo: string; cuando: string | null }[]
  }
}

/** «23 oct, 00:23» en Ciudad de México */
const fechaCorta = (iso: string | null): string => {
  if (!iso || Number.isNaN(Date.parse(iso))) return ''
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(iso))
    .replace('.', '')
}

/** Nombres de computadora («LATITUDE 3520», «DESKTOP-4KJ2») en vez de una persona: delatan en qué equipo se hizo. */
const ES_EQUIPO = /latitude|thinkpad|ideapad|inspiron|pavilion|vivobook|zenbook|aspire|macbook|imac|surface|probook|elitebook|^desktop-|^laptop-|^pc-|\b[a-z]+[- ]?\d{3,}\b/i

/** Su historia en una línea, para leerla de corrido. */
function historiaDe(a: ArchivoRevisado): string {
  const p: string[] = []
  const creo = a.autor || a.cuenta
  if (creo) p.push(`Lo creó ${ES_EQUIPO.test(a.autor) ? 'la computadora' : 'la cuenta'} «${creo}»${a.creado ? ` el ${fechaCorta(a.creado)}` : ''}`)
  else if (a.creado) p.push(`Creado el ${fechaCorta(a.creado)}`)
  if (a.ultimo_editor && a.ultimo_editor !== a.autor) p.push(`lo modificó al final «${a.ultimo_editor}»${a.modificado ? ` el ${fechaCorta(a.modificado)}` : ''}`)
  if (a.minutos_edicion !== null) p.push(`${a.minutos_edicion} min de edición`)
  if (a.titulo) p.push(`título interno «${a.titulo}»`)
  if (a.nombre_original && a.nombre_original !== a.nombre) p.push(`se subió a Drive como «${a.nombre_original}»`)
  if (a.drive_editores) p.push(`en Drive lo editaron: ${a.drive_editores}`)
  if (a.programa) p.push(`hecho con ${a.programa}`)
  if (a.entregado) p.push(`entregado el ${fechaCorta(a.entregado)}`)
  const t = p.join(' · ')
  return t ? t[0].toUpperCase() + t.slice(1) : 'El archivo no trae datos de quién lo hizo.'
}

/** Lo que la revisión con IA necesita además del informe: el texto de cada archivo, el grupo y de qué tareas se trata. */
export interface DatosParaIA {
  informe: InformeCopias
  /** Cuentas de Drive que son del curso (dueñas de archivos de buena parte del grupo) */
  cuentas_del_curso: string[]
  textos: { alumno: string; nombre: string; texto: string }[]
  grupo: string[]
  tareas: { titulo: string; descripcion: string; vence: string | null }[]
}
/** Los últimos informes (por su hora de generación): la revisión con IA se pide después, sobre el mismo informe */
const recientes = new Map<string, DatosParaIA>()
export const datosParaIA = (generado: string): DatosParaIA | undefined => recientes.get(generado)

/** Lee todos los archivos de la tarea y arma las señales, de la más grave a la más leve. */
export async function revisarEntregas(
  tareas: string[],
  entregados: Entregado[],
  grupo: AlumnoDelGrupo[],
  sinArchivo: string[],
  contexto: DatosParaIA['tareas'] = []
): Promise<InformeCopias> {
  const archivos: (ArchivoRevisado & { _texto: string; _fuente: string; _editores: string[] })[] = []
  for (const e of entregados) {
    const l = await leerMetadatos(e.ruta).catch((err: Error) => ({ meta: vacio(), sha256: '', tamano: 0, texto: '', error: err.message }))
    archivos.push({
      alumno: e.alumno.nombre,
      origen: e.origen,
      nombre: e.nombre,
      entregado: e.entregado,
      tamano: l.tamano,
      sha256: l.sha256,
      palabras: palabras(l.texto).length,
      ...l.meta,
      drive_dueno: e.drive ? [e.drive.dueno, e.drive.dueno_correo].filter(Boolean).join(' · ') : '',
      drive_editor: e.drive ? [e.drive.editor, e.drive.editor_correo].filter(Boolean).join(' · ') : '',
      drive_creado: e.drive?.creado ?? null,
      drive_modificado: e.drive?.modificado ?? null,
      nombre_original: e.drive?.nombre_original ?? '',
      drive_editores: (e.drive?.editores ?? []).map((x) => [x.nombre, x.correo].filter(Boolean).join(' · ') + (x.cuando ? ` (${fechaCorta(x.cuando)})` : '')).join(' → '),
      historia: '',
      error: l.error,
      _texto: l.texto,
      _fuente: ('fuente' in l ? l.fuente : undefined) ?? '',
      _editores: (e.drive?.editores ?? []).map((x) => [x.nombre, x.correo].filter(Boolean).join(' · '))
    })
  }
  // Las cuentas de la escuela se llaman por matrícula («2500000»): se dice de quién es
  const deQuien = (texto: string): string => {
    const t = normal(texto)
    const a = grupo.find((g) => g.cuentas.some((c) => {
      const cc = normal(c).split('@')[0]
      return cc.length >= 5 && t.includes(cc)
    }))
    return a ? `${texto} (${a.nombre})` : texto
  }
  for (const a of archivos) {
    a._editores = a._editores.map(deQuien)
    a.drive_editores = a.drive_editores
      .split(' → ')
      .filter(Boolean)
      .map((e) => {
        const [quien, ...resto] = e.split(' (')
        return [deQuien(quien), ...resto].join(' (')
      })
      .join(' → ')
    a.historia = historiaDe(a)
  }

  const ids = identificadores(grupo)
  const senales: SenalCopia[] = []
  const agregar = (s: SenalCopia): void => {
    const clave = `${s.nivel}|${[...s.alumnos].sort().join('|')}|${s.texto}`
    if (!senales.some((x) => `${x.nivel}|${[...x.alumnos].sort().join('|')}|${x.texto}` === clave)) senales.push(s)
  }

  // Lo que mostraron los metadatos, caso por caso: quién lo hizo y quién lo entregó como suyo
  const hallazgos: HallazgoMetadatos[] = []
  // El mismo caso por varios motivos (texto igual y misma cuenta) es un solo renglón con todas sus evidencias
  const hallazgo = (h: HallazgoMetadatos): void => {
    const ya = hallazgos.find((x) => x.caso === h.caso && x.conclusion === h.conclusion)
    if (!ya) return void hallazgos.push(h)
    if (!ya.evidencia.includes(h.evidencia)) ya.evidencia = `${ya.evidencia} ${h.evidencia}`
    if (h.fuerza === 'prueba') ya.fuerza = 'prueba'
  }
  // Para mostrar: primer nombre y apellido paterno («Mateo Ibarra»); el nombre completo sigue siendo la clave
  const cortos = new Map(grupo.map((g) => [g.nombre, g.corto ?? cortoDesdeCompleto(g.nombre)]))
  const corto = (n: string): string => cortos.get(n) ?? cortoDesdeCompleto(n)
  /** Cuándo apareció el archivo: su creación (dentro del archivo o en Drive) y, si no, su entrega */
  const cuando = (a: ArchivoRevisado): number => {
    const t = [a.creado, a.drive_creado].filter((x): x is string => !!x).map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x))
    return t.length ? Math.min(...t) : a.entregado ? Date.parse(a.entregado) : NaN
  }
  /** Quién lo tuvo primero entre dos archivos parecidos (por hora); null si no se puede saber */
  const primero = (a: ArchivoRevisado, b: ArchivoRevisado): { original: ArchivoRevisado; copia: ArchivoRevisado } | null => {
    const ta = cuando(a)
    const tb = cuando(b)
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) {
      const ea = a.entregado ? Date.parse(a.entregado) : NaN
      const eb = b.entregado ? Date.parse(b.entregado) : NaN
      if (Number.isNaN(ea) || Number.isNaN(eb) || ea === eb) return null
      return ea < eb ? { original: a, copia: b } : { original: b, copia: a }
    }
    return ta < tb ? { original: a, copia: b } : { original: b, copia: a }
  }
  const hora = (a: ArchivoRevisado): string => {
    const t = cuando(a)
    return Number.isNaN(t) ? '' : fechaCorta(new Date(t).toISOString())
  }
  /** Un par de archivos que coinciden: dice quién lo tuvo primero, o que no se sabe */
  const parecidos = (a: ArchivoRevisado, b: ArchivoRevisado, evidencia: string, fuerza: HallazgoMetadatos['fuerza']): void => {
    const p = primero(a, b)
    if (!p) {
      hallazgo({ alumnos: [a.alumno, b.alumno], caso: `${corto(a.alumno)} y ${corto(b.alumno)}`, evidencia, conclusion: 'Comparten el trabajo; por las horas no se sabe quién lo tuvo primero.', fuerza })
      return
    }
    hallazgo({
      alumnos: [p.original.alumno, p.copia.alumno],
      caso: `${corto(p.copia.alumno)} · ${p.copia.nombre}`,
      evidencia: `${evidencia} El de ${corto(p.original.alumno)} es de ${hora(p.original)}; el de ${corto(p.copia.alumno)}, de ${hora(p.copia)}.`,
      conclusion: `Probablemente salió del archivo de ${corto(p.original.alumno)}.`,
      fuerza,
      original: p.original.alumno,
      copia: p.copia.alumno
    })
  }

  // Una cuenta que es dueña (o la última que modificó) archivos de buena parte del grupo es la del curso o la del
  // docente (Classroom les pasa los archivos), no la de un alumno: no dice nada de nadie
  const conDrive = new Set(archivos.filter((a) => a.drive_dueno).map((a) => a.alumno)).size
  const delCurso = (campo: 'drive_dueno' | 'drive_editor'): Set<string> => {
    const alumnosPor = new Map<string, Set<string>>()
    for (const a of archivos) if (a[campo]) alumnosPor.set(normal(a[campo]), (alumnosPor.get(normal(a[campo])) ?? new Set()).add(a.alumno))
    return new Set([...alumnosPor].filter(([, x]) => x.size >= Math.max(3, Math.ceil(conDrive * 0.4))).map(([c]) => c))
  }
  const duenosDelCurso = delCurso('drive_dueno')
  const editoresDelCurso = delCurso('drive_editor')
  // Lo mismo con quienes guardaron versiones en Drive: el docente o la cuenta del curso editan los de todos
  const versionesPor = new Map<string, Set<string>>()
  for (const a of archivos) for (const e of a._editores) versionesPor.set(normal(e), (versionesPor.get(normal(e)) ?? new Set()).add(a.alumno))
  const versionesDelCurso = new Set([...versionesPor].filter(([, x]) => x.size >= Math.max(3, Math.ceil(conDrive * 0.4))).map(([c]) => c))
  for (const a of archivos) {
    const de = `«${a.nombre}» de ${corto(a.alumno)}`
    // El nombre de otro alumno dentro del archivo o en su cuenta de Drive
    const campos: [string, string, boolean, boolean?][] = [
      ['autor', a.autor, false],
      ['último editor', a.ultimo_editor, false],
      ['título interno', a.titulo, true],
      ['nombre del archivo', a.nombre, true],
      ['nombre original en Drive', a.nombre_original, true],
      ['editores en Drive', a._editores.filter((e) => !versionesDelCurso.has(normal(e))).join(' → '), false, true],
      ['empresa', a.empresa, false],
      ['comentarios o cambios dentro del archivo', a.otros_autores, false],
      ['dueño en Drive', duenosDelCurso.has(normal(a.drive_dueno)) ? '' : a.drive_dueno, false, true],
      ['última modificación en Drive', editoresDelCurso.has(normal(a.drive_editor)) ? '' : a.drive_editor, false, true]
    ]
    const comoLoDice: Record<string, (v: string) => string> = {
      autor: (v) => `Lo creó ${ES_EQUIPO.test(v) ? 'la computadora' : 'la cuenta'} «${v}»${a.creado ? ` el ${fechaCorta(a.creado)}` : ''}.`,
      'último editor': (v) => `Lo modificó por última vez la cuenta «${v}»${a.minutos_edicion !== null ? `, con ${a.minutos_edicion} min de edición` : ''}.`,
      'título interno': (v) => `Su título interno es «${v}».`,
      'nombre del archivo': (v) => `El archivo se llama «${v}».`,
      'nombre original en Drive': (v) => `Se subió a Drive con el nombre «${v}».`,
      empresa: (v) => `Su campo «empresa» dice «${v}».`,
      'comentarios o cambios dentro del archivo': (v) => `Tiene comentarios o cambios controlados de «${v}».`,
      'editores en Drive': (v) => `En Drive guardaron versiones: ${v}.`,
      'dueño en Drive': (v) => `En Drive es de la cuenta «${v}».`,
      'última modificación en Drive': (v) => `En Drive lo modificó por última vez «${v}».`
    }
    for (const [campo, valor, diminutivos, soloCuentas] of campos) {
      for (const m of mencionados(valor, a.alumno, ids, diminutivos, soloCuentas)) {
        const evidencia = (comoLoDice[campo] ?? ((v: string) => `Su ${campo} es «${v}».`))(valor)
        hallazgo({
          alumnos: [a.alumno, m.alumno],
          caso: `${corto(a.alumno)} · ${a.nombre}`,
          evidencia,
          ...(campo === 'comentarios o cambios dentro del archivo' || campo === 'editores en Drive'
            ? // Trabajó dentro del archivo, pero eso solo no dice quién lo hizo
              { conclusion: `${corto(m.alumno)} también trabajó en este archivo (comentó, corrigió o lo editó).`, fuerza: 'indicio' as const }
            : {
                conclusion: m.fuerte ? `Salió del archivo de ${corto(m.alumno)}.` : `Puede ser de ${corto(m.alumno)} (el nombre parece un diminutivo; revísalo).`,
                fuerza: m.fuerte ? ('prueba' as const) : ('indicio' as const),
                original: m.alumno,
                copia: a.alumno
              })
        })
        agregar({
          nivel: m.fuerte ? 'alta' : 'media',
          alumnos: [a.alumno, m.alumno],
          texto: `${de}: ${evidencia.replace(/\.$/, '')} (corresponde a ${m.alumno}${m.fuerte ? '' : '; parece un diminutivo, revísalo'}).`
        })
      }
    }
    if (DE_PROGRAMA.test(`${a.autor} ${a.ultimo_editor} ${a.programa}`)) {
      agregar({ nivel: 'media', alumnos: [a.alumno], texto: `${de}: lo armó un programa (${[a.autor, a.programa].filter(Boolean).join(' · ')}); es típico de presentaciones o documentos generados con IA.` })
    }
    if (a.minutos_edicion !== null && a.minutos_edicion <= 3 && a.palabras >= 150) {
      agregar({ nivel: 'baja', alumnos: [a.alumno], texto: `${de}: solo ${a.minutos_edicion} min de edición para ${a.palabras} palabras; pudo pegarse de otro lado.` })
    }
  }

  const familias = archivos.map((a) => familia(a.nombre))
  const completos = archivos.map((a) => pedazos(a._texto))
  const textos = sinBaseComun(completos, familias)
  // El código (cuadernos y programas) se compara línea por línea con lo que escribió cada quien, sin lo que la plantilla
  // dicta en comentarios ni lo que trae buena parte del grupo; los documentos, por pedazos de texto
  const propias = lineasPropias(archivos.map((a, i) => (familias[i] === 'codigo' ? a._fuente : '')))
  const comparables = textos
  // Solo las mediciones (tiempos, razones con decimales) dicen que alguien copió: los resultados enteros salen iguales
  // a cualquiera que lo resuelva bien. Son base si las trae casi todo el grupo (salidas del cuaderno del docente);
  // cuatro de nueve con los mismos milisegundos es una copia, no la plantilla
  const numeros = sinBaseComun(archivos.map((a) => new Set([...datosNumericos(a._texto)].filter(esMedicion))), familias, 0.8)
  for (let i = 0; i < archivos.length; i++) {
    for (let j = i + 1; j < archivos.length; j++) {
      const a = archivos[i]
      const b = archivos[j]
      if (a.alumno === b.alumno) continue
      const par = [a.alumno, b.alumno]
      const ambos = `«${a.nombre}» de ${corto(a.alumno)} y «${b.nombre}» de ${corto(b.alumno)}`
      if (a.sha256 && a.sha256 === b.sha256) {
        agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} son exactamente el mismo archivo.` })
        parecidos(a, b, 'Es exactamente el mismo archivo, byte por byte.', 'prueba')
        continue
      }
      // Con muy poco propio (la plantilla casi sin tocar) el porcentaje no dice nada: eso se avisa aparte
      const deCodigo = familias[i] === 'codigo' && familias[j] === 'codigo'
      const minimo = deCodigo ? Math.min(propias[i].size, propias[j].size) >= MIN_LINEAS : a.palabras >= 80 && b.palabras >= 80 && Math.min(comparables[i].size, comparables[j].size) >= MIN_PROPIO
      if (minimo) {
        const s = deCodigo ? similitud(propias[i], propias[j]) : similitud(comparables[i], comparables[j])
        const pct = Math.round(s * 100)
        const que = deCodigo ? 'de las líneas que escribieron (sin la plantilla ni lo que dicta)' : 'del texto propio (sin contar la plantilla)'
        if (s >= 0.8) {
          agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} tienen el ${pct} % ${deCodigo ? 'del código propio' : 'del texto'} igual.` })
          parecidos(a, b, `Tienen el ${pct} % ${que} igual.`, 'indicio')
        } else if (s >= 0.5) agregar({ nivel: 'media', alumnos: par, texto: `${ambos} comparten el ${pct} % ${deCodigo ? 'del código propio' : 'del texto'}.` })
      }
      // Mismos números (mediciones, resultados): en tablas el texto es casi todo números y no se parece en palabras
      const na = numeros[i]
      const nb = numeros[j]
      const comunes = [...na].filter((x) => nb.has(x)).length
      const menor = Math.min(na.size, nb.size)
      if (comunes >= 4 && comunes >= menor / 2) {
        agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} tienen ${comunes} de ${menor} mediciones idénticas (tiempos o razones con decimales).` })
        parecidos(a, b, `Tienen ${comunes} de ${menor} mediciones idénticas (tiempos o razones con decimales, que cambian en cada computadora).`, 'indicio')
      } else if (comunes >= 3) {
        agregar({ nivel: 'media', alumnos: par, texto: `${ambos} comparten ${comunes} mediciones idénticas (tiempos o razones con decimales).` })
      }
      if (a.cuenta && a.cuenta === b.cuenta) {
        agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} los creó la misma cuenta de Google Colab: uno trabajó en el cuaderno del otro o se lo pasó.` })
        parecidos(a, b, 'Los dos cuadernos los creó la misma cuenta de Google Colab.', 'prueba')
      }
      if (a.creado && a.creado === b.creado && (a.autor === b.autor || !a.autor || !b.autor)) {
        agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} se crearon en el mismo instante (${a.creado}): salieron del mismo archivo original.` })
        parecidos(a, b, `Los dos archivos dicen que se crearon en el mismo instante (${fechaCorta(a.creado)}): son el mismo documento guardado dos veces.`, 'prueba')
      }
      if (a.fecha_foto && a.fecha_foto === b.fecha_foto && a.camara === b.camara) {
        agregar({ nivel: 'alta', alumnos: par, texto: `${ambos} son la misma foto (${a.camara || 'misma cámara'}, tomada el ${a.fecha_foto}).` })
        parecidos(a, b, `Es la misma foto (${a.camara || 'misma cámara'}, tomada el ${a.fecha_foto}).`, 'prueba')
      } else if (a.camara && a.camara === b.camara && a.fecha_foto && b.fecha_foto && a.fecha_foto.slice(0, 13) === b.fecha_foto.slice(0, 13)) {
        agregar({ nivel: 'media', alumnos: par, texto: `${ambos} son fotos del mismo teléfono (${a.camara}) tomadas en la misma hora.` })
      }
      const autorA = normal(a.autor)
      if (autorA && autorA === normal(b.autor) && !GENERICOS.has(autorA) && !DE_PROGRAMA.test(autorA) && !mencionados(a.autor, '', ids, false).length) {
        agregar({ nivel: 'media', alumnos: par, texto: `${ambos} tienen el mismo autor: «${a.autor}».` })
        parecidos(a, b, ES_EQUIPO.test(a.autor) ? `Los dos se crearon en la misma computadora, «${a.autor}».` : `Los dos los creó la misma cuenta, «${a.autor}».`, ES_EQUIPO.test(a.autor) ? 'prueba' : 'indicio')
      }
    }
  }

  // Lo que entregó es casi solo la base: la plantilla sin resolver (o subió el archivo equivocado)
  archivos.forEach((a, i) => {
    const deSuFamilia = familias.filter((f, k) => f === familias[i] && completos[k].size).length
    if (deSuFamilia >= 3 && completos[i].size >= 100 && textos[i].size < Math.max(15, completos[i].size * 0.05)) {
      agregar({ nivel: 'baja', alumnos: [a.alumno], texto: `«${a.nombre}» de ${a.alumno} casi no tiene nada propio: parece la plantilla sin resolver o el archivo equivocado.` })
    }
  })

  const peso = { alta: 0, media: 1, baja: 2 }
  senales.sort((x, y) => peso[x.nivel] - peso[y.nivel])
  hallazgos.sort((x, y) => (x.fuerza === y.fuerza ? 0 : x.fuerza === 'prueba' ? -1 : 1))

  // Cadenas: alumnos unidos por archivos que pasaron de uno a otro, en el orden en que aparecieron
  const enlaces = hallazgos.filter((h) => h.original && h.copia)
  const vecinos = new Map<string, Set<string>>()
  for (const h of enlaces) {
    vecinos.set(h.original!, (vecinos.get(h.original!) ?? new Set()).add(h.copia!))
    vecinos.set(h.copia!, (vecinos.get(h.copia!) ?? new Set()).add(h.original!))
  }
  const vistos = new Set<string>()
  const cadenas: string[] = []
  const primeraHora = (alumno: string): number => Math.min(...archivos.filter((a) => a.alumno === alumno).map(cuando).filter((t) => !Number.isNaN(t)), Infinity)
  for (const inicio of vecinos.keys()) {
    if (vistos.has(inicio)) continue
    const grupoCadena: string[] = []
    const pila = [inicio]
    while (pila.length) {
      const x = pila.pop()!
      if (vistos.has(x)) continue
      vistos.add(x)
      grupoCadena.push(x)
      for (const y of vecinos.get(x) ?? []) pila.push(y)
    }
    if (grupoCadena.length < 3) continue
    grupoCadena.sort((x, y) => primeraHora(x) - primeraHora(y))
    cadenas.push(grupoCadena.map((x) => (Number.isFinite(primeraHora(x)) ? `${corto(x)} (${fechaCorta(new Date(primeraHora(x)).toISOString())})` : corto(x))).join(' → '))
  }

  // Trabajo propio: muchos minutos de edición y nada que diga que lo tomó de otro
  const copiaron = new Set(enlaces.map((h) => h.copia!))
  const trabajoPropio: string[] = []
  for (const alumno of [...new Set(archivos.map((a) => a.alumno))].sort((x, y) => x.localeCompare(y, 'es'))) {
    if (copiaron.has(alumno)) continue
    const largos = archivos.filter((a) => a.alumno === alumno && (a.minutos_edicion ?? 0) >= 30)
    // Empieza con su nombre corto: así se busca a quién pertenece (classroom.ts, Classroom.tsx)
    if (largos.length) trabajoPropio.push(`${corto(alumno)}: ${largos.map((a) => `${a.minutos_edicion} min de edición en «${a.nombre}»`).join(', ')}.`)
  }
  const informe: InformeCopias = {
    tareas,
    archivos: archivos.map(({ _texto: _, _fuente: ___, _editores: __, ...a }) => a).sort((x, y) => x.alumno.localeCompare(y.alumno, 'es')),
    senales,
    hallazgos,
    cadenas,
    trabajo_propio: trabajoPropio,
    sin_archivo: sinArchivo,
    nombres: Object.fromEntries([...new Set([...grupo.map((g) => g.nombre), ...archivos.map((a) => a.alumno)])].map((n) => [n, corto(n)])),
    generado: new Date().toISOString()
  }
  recientes.set(informe.generado, {
    informe,
    cuentas_del_curso: [...new Set([...archivos.filter((a) => duenosDelCurso.has(normal(a.drive_dueno))).map((a) => a.drive_dueno), ...archivos.filter((a) => editoresDelCurso.has(normal(a.drive_editor))).map((a) => a.drive_editor)])],
    textos: archivos.map((a) => ({ alumno: a.alumno, nombre: a.nombre, texto: a._texto })),
    grupo: [...new Set([...grupo.map((g) => g.nombre), ...archivos.map((a) => a.alumno)])],
    tareas: contexto
  })
  // Solo los más recientes: los textos de un grupo entero ocupan memoria
  while (recientes.size > 3) recientes.delete(recientes.keys().next().value as string)
  return informe
}
