import { readFileSync } from 'fs'
import { extname } from 'path'
import ExcelJS from 'exceljs'

export interface AlumnoImportado {
  matricula: string
  nombre: string
  apellidos: string
  email: string
}

/** Lee un .xlsx o .csv como matriz de textos (primera hoja). */
export async function leerFilas(ruta: string): Promise<string[][]> {
  const filas: string[][] = []
  if (extname(ruta).toLowerCase() === '.csv') {
    readFileSync(ruta, 'utf8')
      .split(/\r?\n/)
      .forEach((l) => l.trim() && filas.push(l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''))))
    return filas
  }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(ruta)
  const ws = wb.worksheets[0]
  const texto = (v: unknown): string => {
    if (v == null) return ''
    if (typeof v === 'object') {
      const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] }
      if (o.richText) return o.richText.map((r) => r.text).join('')
      if ('text' in o) return String(o.text ?? '')
      if ('result' in o) return String(o.result ?? '') // celda con fórmula
      return ''
    }
    return String(v)
  }
  ws.eachRow((row) => filas.push((row.values as unknown[]).slice(1).map((v) => texto(v).trim())))
  return filas
}

const normalizar = (c: string): string => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Una matrícula real es corta; un texto largo en esa columna es un título o una nota al pie, no un alumno. */
const pareceMatricula = (m: string): boolean => m.length <= 20

/**
 * Convierte la matriz de una lista en alumnos. El encabezado puede no estar en la primera fila
 * (las listas oficiales traen título, materia y periodo antes) y puede llevar una columna "#" de numeración.
 * Sin encabezado se asume matrícula, nombre, apellidos, correo.
 */
export function interpretarLista(filas: string[][]): AlumnoImportado[] {
  const filaEnc = filas.slice(0, 25).findIndex((f) => {
    const n = f.map(normalizar)
    return n.some((c) => c.includes('matric')) || (n.some((c) => c.includes('nombre')) && n.some((c) => c.includes('apellid')))
  })
  const enc = filaEnc >= 0 ? filas[filaEnc].map(normalizar) : []
  // Se prefiere la columna cuyo encabezado EMPIEZA con la palabra ("Nombre(s)") sobre la que solo la contiene
  // ("Estudiante (apellidos y nombre)"), que es la columna combinada de las listas oficiales.
  const idx = (...n: string[]): number => {
    const exacta = enc.findIndex((c) => n.some((x) => c.startsWith(x)))
    return exacta >= 0 ? exacta : enc.findIndex((c) => n.some((x) => c.includes(x)))
  }
  // «id» solo cuenta como encabezado exacto: buscado como parte de la palabra, «apellidos» lo contiene
  // y los alumnos con los mismos apellidos se fusionaban en uno solo
  const iMatricula = idx('matric', 'no. de control', 'numero de control', 'número de control')
  const iMat = iMatricula >= 0 ? iMatricula : enc.findIndex((c) => c === 'id'), iNom = idx('nombre'), iApe = idx('apellid'), iMail = idx('email', 'correo', 'mail')
  // Si solo hay una columna con apellidos y nombre juntos, los dos primeros términos son los apellidos
  const combinada = iNom >= 0 && iNom === iApe
  const conEnc = filaEnc >= 0
  const datos = conEnc ? filas.slice(filaEnc + 1) : filas
  const alumnos: AlumnoImportado[] = []
  for (const f of datos) {
    // Con encabezados y sin columna de matrícula queda vacía (la app la admite): antes se tomaba la
    // primera columna, que suele ser el nombre, y dos alumnos con el mismo nombre se fusionaban
    const matricula = (conEnc ? (iMat >= 0 ? f[iMat] : '') : f[0]) ?? ''
    let nombre = (conEnc ? f[iNom >= 0 ? iNom : 1] : f[1]) ?? ''
    let apellidos = (conEnc ? (iApe >= 0 ? f[iApe] : '') : f[2] ?? '') ?? ''
    const email = (conEnc ? (iMail >= 0 ? f[iMail] : '') : f[3] ?? '') ?? ''
    if (!nombre || !pareceMatricula(matricula)) continue
    if (combinada) {
      const partes = nombre.split(/\s+/)
      apellidos = partes.slice(0, 2).join(' ')
      nombre = partes.slice(2).join(' ') || partes[0]
    } else if (!apellidos && nombre.includes(' ') && iApe < 0) {
      // "Nombre Apellido Apellido" → separa por el primer espacio si viene todo junto
      const partes = nombre.split(' ')
      nombre = partes[0]
      apellidos = partes.slice(1).join(' ')
    }
    alumnos.push({ matricula, nombre, apellidos, email })
  }
  return alumnos
}
