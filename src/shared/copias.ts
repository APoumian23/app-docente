/** Revisión de copias por metadatos (src/main/services/metadatos.ts). */

// ---------- Nombres cortos: primer nombre y apellido paterno («Mateo Ibarra») ----------

/** Partículas de apellidos compuestos: «DE LA ROSA» es un solo apellido paterno */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'van', 'von', 'mc', 'san'])
const capital = (t: string): string => t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, l: string) => sep + l.toUpperCase())

/** Primer apellido completo, con sus partículas («DE LA ROSA OROZCO» → «De la Rosa») */
function apellidoPaterno(apellidos: string): string {
  const p = apellidos.trim().split(/\s+/).filter(Boolean)
  const r: string[] = []
  for (const x of p) {
    r.push(x)
    if (!PARTICULAS.has(x.toLowerCase())) break
  }
  return capital(r.join(' ')).replace(/\b(De|Del|La|Las|Los|Y)\b(?=\s)/g, (m, _x, i) => (i === 0 ? m : m.toLowerCase()))
}

/** Con nombre y apellidos por separado: «Sofia Lucía» + «Bravo Quintero» → «Sofia Bravo» */
export function nombreCorto(nombre: string, apellidos: string): string {
  const primero = capital(nombre.trim().split(/\s+/)[0] ?? '')
  return [primero, apellidoPaterno(apellidos)].filter(Boolean).join(' ') || capital(`${nombre} ${apellidos}`.trim())
}

/**
 * Sin los datos separados, desde «APELLIDOS NOMBRE(S)» (como se guardan los alumnos): con 3 o más palabras se toman
 * las dos primeras como apellidos. Es un respaldo: lo normal es usar el mapa de nombres cortos del informe.
 */
export function cortoDesdeCompleto(completo: string): string {
  const p = completo.trim().split(/\s+/).filter(Boolean)
  if (p.length < 3) return capital(completo.trim())
  return nombreCorto(p.slice(2).join(' '), p.slice(0, 2).join(' '))
}

export interface ArchivoRevisado {
  alumno: string
  origen: 'classroom' | 'portal'
  nombre: string
  /** Cuándo lo entregó (ISO), si se sabe */
  entregado: string | null
  tamano: number
  sha256: string
  /** Palabras de texto que se pudieron leer (0 = escaneado o foto) */
  palabras: number
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
  /** Cuenta que creó el archivo (Colab): no es un nombre, solo sirve para comparar */
  cuenta: string
  /** Quiénes comentaron o hicieron cambios controlados adentro (separados por «·») */
  otros_autores: string
  drive_dueno: string
  drive_editor: string
  drive_creado: string | null
  drive_modificado: string | null
  /** Nombre con que se subió a Drive la primera vez (puede traer el nombre de quien lo hizo) */
  nombre_original: string
  /** Quiénes guardaron versiones del archivo en Drive, en orden */
  drive_editores: string
  /** Su historia en una línea: quién lo creó y dónde, quién lo modificó al final, minutos de edición, entrega */
  historia: string
  error?: string
}

/** Un caso que los metadatos explican: quién hizo el archivo y quién lo entregó como suyo. */
export interface HallazgoMetadatos {
  alumnos: string[]
  /** «Carrillo Diego · Avance.docx» */
  caso: string
  /** Lo que dice el archivo: «Lo modificó por última vez la cuenta «MATEO IBARRA», con 6 min de edición» */
  evidencia: string
  /** «Salió del archivo de Ibarra Mateo» */
  conclusion: string
  /** prueba = el archivo trae el nombre o la cuenta del otro; indicio = coincidencias y horas */
  fuerza: 'prueba' | 'indicio'
  /** Quién lo hizo y quién lo entregó como suyo, si se puede saber */
  original?: string
  copia?: string
}

export interface SenalCopia {
  nivel: 'alta' | 'media' | 'baja'
  alumnos: string[]
  texto: string
}

export interface InformeCopias {
  /** Títulos de las tareas revisadas */
  tareas: string[]
  archivos: ArchivoRevisado[]
  senales: SenalCopia[]
  /** Lo que mostraron los metadatos, caso por caso (lo más claro primero) */
  hallazgos: HallazgoMetadatos[]
  /** Cadenas de copia por hora: «Robledo Iker (23 oct, 00:23) → Bustos Ruben (23 oct, 07:28) → …» */
  cadenas: string[]
  /** Quién trabajó sus archivos (minutos de edición, sin señales de haberlos tomado de otro) */
  trabajo_propio: string[]
  /** Quién entregó sin archivo (solo enlace o texto) o cuyo archivo no se pudo bajar */
  sin_archivo: string[]
  /** Nombre completo («BRAVO QUINTERO SOFIA LUCIA») → corto («Sofia Bravo»), para mostrar */
  nombres: Record<string, string>
  generado: string
}

/** Revisión adicional con IA sobre el mismo informe: lee el contenido, no solo los metadatos. Son pistas, no pruebas. */
export interface RevisionIA {
  resumen: string
  alumnos: {
    alumno: string
    nivel: 'alta' | 'media' | 'baja' | 'ninguna'
    /** Qué tan probable es que el contenido lo haya generado una IA */
    uso_de_ia: 'probable' | 'posible' | 'poco_probable' | 'sin_texto'
    hallazgos: string[]
  }[]
  /** original: quién parece haberlo hecho primero («no se sabe» si no hay con qué decidirlo) */
  parecidos: { alumnos: string[]; nivel: 'alta' | 'media' | 'baja'; original: string; explicacion: string }[]
  recomendaciones: string[]
  generado: string
}
