/**
 * Cuadernos de Jupyter (.ipynb) en el portal del alumno.
 *
 * El docente comparte el .ipynb como cualquier material. Al abrirlo, el alumno recibe su propia copia
 * (tabla `cuadernos_alumno`): contesta en las celdas de texto, corre y escribe código, agrega celdas, y
 * todo se guarda solo. Al entregarlo se genera el .ipynb con lo que tenga (respuestas y salidas), se sube
 * a la tarea que elija igual que «Subir tarea» (al docente le llega el aviso y cuenta como entregada) y
 * la copia queda cerrada.
 *
 * El contenido se guarda tal cual en formato nbformat 4; aquí solo se revisa que tenga esa forma.
 */
import type Database from 'better-sqlite3'
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join, relative } from 'path'
import type { CuadernoAlumno, TareaParaCuaderno } from '../shared/portal'
import { ErrorHttp } from './auth'
import { esCuaderno, materialParaAlumno } from './portalAlumno'
import { registrarSubida, tareasDeAlumno } from './tareas'

type DB = Database.Database

/** Un cuaderno con fórmulas, tablas y salidas cabe de sobra; más que esto es una imagen enorme o un ciclo que imprimió de más. */
const MAX_BYTES = 4 * 1024 * 1024
const MAX_CELDAS = 600

interface Fila {
  id: number
  material_id: number
  contenido: string
  estado: 'borrador' | 'entregado'
  curso_id: string | null
  tarea_id: string | null
  actualizado: string
  entregado_en: string | null
}

/** Revisa que sea un cuaderno (nbformat 4 con una lista de celdas) y lo devuelve como texto listo para guardar. */
export function validarCuaderno(contenido: unknown): string {
  const nb = typeof contenido === 'string' ? (() => {
    try {
      return JSON.parse(contenido) as unknown
    } catch {
      throw new ErrorHttp(400, 'El cuaderno no es un archivo .ipynb válido.')
    }
  })() : contenido
  const c = nb as { nbformat?: unknown; cells?: unknown }
  if (!c || typeof c !== 'object' || !Array.isArray(c.cells) || Number(c.nbformat) < 4) throw new ErrorHttp(400, 'El cuaderno no es un archivo .ipynb válido (se necesita el formato 4 de Jupyter).')
  if (c.cells.length > MAX_CELDAS) throw new ErrorHttp(400, `El cuaderno tiene demasiadas celdas (más de ${MAX_CELDAS}).`)
  for (const celda of c.cells as { cell_type?: unknown }[]) {
    if (!celda || typeof celda !== 'object' || !['code', 'markdown', 'raw'].includes(String(celda.cell_type))) throw new ErrorHttp(400, 'El cuaderno tiene una celda que no se reconoce.')
  }
  const texto = JSON.stringify(nb)
  if (Buffer.byteLength(texto) > MAX_BYTES) throw new ErrorHttp(413, 'El cuaderno quedó demasiado grande (más de 4 MB). Borra salidas muy largas o imágenes y vuelve a intentar.')
  return texto
}

function materialDe(db: DB, materialId: number): { titulo: string; materia_id: number; materia_nombre: string } {
  const m = db
    .prepare('SELECT x.titulo, x.materia_id, m.nombre AS materia_nombre FROM materiales x JOIN materias m ON m.id = x.materia_id WHERE x.id = ?')
    .get(materialId) as { titulo: string; materia_id: number; materia_nombre: string } | undefined
  if (!m) throw new ErrorHttp(404, 'Ese cuaderno ya no existe.')
  return m
}

const tituloDeTarea = (db: DB, cursoId: string | null, tareaId: string | null): string | null =>
  cursoId && tareaId ? ((db.prepare('SELECT titulo FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { titulo: string } | undefined)?.titulo ?? null) : null

function aCuaderno(db: DB, f: Fila): CuadernoAlumno {
  const m = materialDe(db, f.material_id)
  return {
    material_id: f.material_id,
    titulo: m.titulo.replace(/\.ipynb$/i, ''),
    materia_nombre: m.materia_nombre,
    estado: f.estado,
    contenido: JSON.parse(f.contenido),
    actualizado: f.actualizado,
    entregado_en: f.entregado_en,
    tarea_titulo: tituloDeTarea(db, f.curso_id, f.tarea_id)
  }
}

const filaDe = (db: DB, alumnoId: number, materialId: number): Fila | undefined =>
  db.prepare('SELECT * FROM cuadernos_alumno WHERE alumno_id = ? AND material_id = ?').get(alumnoId, materialId) as Fila | undefined

/** Su copia del cuaderno; la primera vez se crea desde el archivo que compartió el docente. */
export function abrirCuaderno(db: DB, alumnoId: number, materialId: number, carpetaEntregas: string): CuadernoAlumno {
  // Revisa que el material esté compartido con él (aunque ya tenga copia: si el docente lo dejó de compartir, ya no se abre)
  const archivo = materialParaAlumno(db, alumnoId, materialId, carpetaEntregas)
  if ('url' in archivo || !esCuaderno(archivo.ruta)) throw new ErrorHttp(400, 'Ese material no es un cuaderno de Jupyter.')
  let f = filaDe(db, alumnoId, materialId)
  if (!f) {
    const contenido = validarCuaderno(readFileSync(archivo.ruta, 'utf8'))
    db.prepare('INSERT OR IGNORE INTO cuadernos_alumno (alumno_id, material_id, contenido) VALUES (?, ?, ?)').run(alumnoId, materialId, contenido)
    f = filaDe(db, alumnoId, materialId)!
  }
  return aCuaderno(db, f)
}

/** Guardado automático mientras trabaja. Una vez entregado ya no cambia. */
export function guardarCuaderno(db: DB, alumnoId: number, materialId: number, contenido: unknown): { actualizado: string } {
  const f = filaDe(db, alumnoId, materialId)
  if (!f) throw new ErrorHttp(404, 'Primero abre el cuaderno.')
  if (f.estado === 'entregado') throw new ErrorHttp(409, 'Este cuaderno ya está entregado: ya no se puede cambiar.')
  db.prepare("UPDATE cuadernos_alumno SET contenido = ?, actualizado = datetime('now') WHERE id = ?").run(validarCuaderno(contenido), f.id)
  return { actualizado: filaDe(db, alumnoId, materialId)!.actualizado }
}

/** Tareas de la materia del cuaderno donde todavía puede entregar. */
export function tareasParaCuaderno(db: DB, alumnoId: number, materialId: number): TareaParaCuaderno[] {
  const { materia_id } = materialDe(db, materialId)
  const m = tareasDeAlumno(db, alumnoId).find((x) => x.materia_id === materia_id)
  return (m?.tareas ?? [])
    .filter((t) => t.estado !== 'cerrada' && t.estado !== 'entregada_classroom')
    .map((t) => ({ curso_id: t.curso_id, tarea_id: t.tarea_id, titulo: t.titulo, vence: t.vence, estado: t.estado }))
}

/** Nombre del archivo que le llega al docente: «Actividades_PD_ADA_FloresCorona.ipynb». */
function nombreDeEntrega(db: DB, alumnoId: number, titulo: string): string {
  const a = db.prepare('SELECT apellidos, nombre FROM alumnos WHERE id = ?').get(alumnoId) as { apellidos: string; nombre: string } | undefined
  const limpio = (t: string): string =>
    t
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\w]+/g, '_')
      .replace(/^_+|_+$/g, '')
  const apellidos = (a?.apellidos || a?.nombre || 'Alumno')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('')
  return `${limpio(titulo.replace(/\.ipynb$/i, '')) || 'Cuaderno'}_${limpio(apellidos)}.ipynb`
}

/**
 * Entrega: guarda lo último que mandó, genera el .ipynb, lo sube a la tarea elegida (cuenta como entregada
 * y al docente le llega el aviso) y cierra la copia.
 */
export function entregarCuaderno(db: DB, alumnoId: number, materialId: number, cursoId: string, tareaId: string, contenido: unknown, carpetaEntregas: string): CuadernoAlumno {
  const f = filaDe(db, alumnoId, materialId)
  if (!f) throw new ErrorHttp(404, 'Primero abre el cuaderno.')
  if (f.estado === 'entregado') throw new ErrorHttp(409, 'Este cuaderno ya está entregado.')
  if (!cursoId || !tareaId) throw new ErrorHttp(400, 'Elige la tarea donde lo entregas.')
  const { materia_id, titulo } = materialDe(db, materialId)
  const t = db.prepare('SELECT c.materia_id FROM classroom_tareas x JOIN classroom_cursos c ON c.id = x.curso_id WHERE x.curso_id = ? AND x.id = ?').get(cursoId, tareaId) as { materia_id: number } | undefined
  if (!t || t.materia_id !== materia_id) throw new ErrorHttp(400, 'Esa tarea no es de la materia de este cuaderno.')

  const texto = contenido === undefined ? f.contenido : validarCuaderno(contenido)
  // Que Jupyter, Colab y VS Code lo abran como Python aunque el original no lo dijera
  const nb = JSON.parse(texto) as { metadata?: Record<string, unknown>; nbformat?: number; nbformat_minor?: number }
  nb.metadata = { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' }, ...(nb.metadata ?? {}) }
  const carpeta = join(carpetaEntregas, 'subidas', String(alumnoId))
  mkdirSync(carpeta, { recursive: true })
  const nombre = nombreDeEntrega(db, alumnoId, titulo)
  const ruta = join(carpeta, `${Date.now()}-${nombre}`)
  writeFileSync(ruta, JSON.stringify(nb, null, 1))
  try {
    registrarSubida(db, alumnoId, cursoId, tareaId, undefined, [{ nombre, ruta: relative(carpetaEntregas, ruta), mime: 'application/x-ipynb+json', tamano: statSync(ruta).size }])
  } catch (e) {
    unlinkSync(ruta)
    throw e
  }
  db.prepare("UPDATE cuadernos_alumno SET contenido = ?, estado = 'entregado', curso_id = ?, tarea_id = ?, entregado_en = datetime('now'), actualizado = datetime('now') WHERE id = ?").run(texto, cursoId, tareaId, f.id)
  return aCuaderno(db, filaDe(db, alumnoId, materialId)!)
}
