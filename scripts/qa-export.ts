/**
 * Prueba TODAS las exportaciones sin abrir diálogos: Excel de materia, lista de alumnos,
 * reporte PDF por alumno y, para cada evaluación de cada materia, PDF, PDF + clave,
 * Word y Word + clave. Escribe en la carpeta que se pase como último argumento.
 */
import { app } from 'electron'
import { existsSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { getDb } from '../src/main/db'
import { exportarMateriaXlsx, exportarTodoXlsx, exportarAlumnosXlsx, htmlAPdf, evaluacionAHtml, reporteAlumnoHtml, evaluacionADocx, markdownADocxSimple, markdownAHtml } from '../src/main/services/export'
import type { Evaluacion, Materia } from '../src/shared/types'

const destino = process.argv[process.argv.length - 1]
// Se trabaja sobre una copia de la base (la de DOCENTE_DATOS o la real, leída en solo lectura): la prueba
// agrega un alumno temporal y la app aplica sus migraciones y semillas al abrir, y nada de eso debe tocar la real.
const origen = join(process.env.DOCENTE_DATOS ?? join(process.env.HOME ?? '', 'Library/Application Support/app-docente'), 'datos/docente.sqlite')
const copia = join(destino, 'datos-qa')
mkdirSync(join(copia, 'datos'), { recursive: true })
execFileSync('sqlite3', ['-readonly', origen, `VACUUM INTO '${join(copia, 'datos/docente.sqlite').replace(/'/g, "''")}'`])
app.setName('app-docente-qa')
app.setPath('userData', copia)

const limpio = (t: string): string => t.replace(/[^\w\dáéíóúñ-]+/gi, '_').slice(0, 40)

app.whenReady().then(async () => {
  const d = getDb()
  console.log('base:', app.getPath('userData'))
  const materias = d.prepare('SELECT m.*, c.nombre AS carrera_nombre FROM materias m JOIN carreras c ON c.id=m.carrera_id ORDER BY m.id').all() as Materia[]
  const fallos: string[] = []
  let ok = 0
  const revisar = (nombre: string, ruta: string): void => {
    const bien = existsSync(ruta) && statSync(ruta).size > 500
    if (bien) ok++
    else fallos.push(`${nombre}: no se generó o quedó vacío`)
  }
  const intentar = async (nombre: string, ruta: string, f: () => Promise<unknown>): Promise<void> => {
    if (process.env.QA_VERBOSO) console.log('  …', nombre)
    try {
      await f()
      revisar(nombre, ruta)
    } catch (e) {
      fallos.push(`${nombre}: ${(e as Error).message}`)
    }
  }

  // Un alumno temporal para el reporte en PDF. Se limpia primero por si una corrida anterior no terminó.
  d.prepare("DELETE FROM alumnos WHERE matricula='QA001'").run()
  const alumnoId = Number(d.prepare("INSERT INTO alumnos (matricula, nombre, apellidos, email) VALUES ('QA001','Prueba','De Exportación','qa@escuela.edu.mx')").run().lastInsertRowid)

  for (const materia of materias) {
    d.prepare('INSERT OR IGNORE INTO inscripciones (materia_id, alumno_id) VALUES (?,?)').run(materia.id, alumnoId)
    const base = join(destino, limpio(materia.clave || materia.nombre))
    await intentar(`${materia.nombre} · Excel de la materia`, `${base}-materia.xlsx`, () => exportarMateriaXlsx(materia.id, `${base}-materia.xlsx`))
    await intentar(`${materia.nombre} · Excel completo (concentrado, asistencia, esquema, proyección)`, `${base}-todo.xlsx`, () => exportarTodoXlsx(materia.id, `${base}-todo.xlsx`, 'Docente Demo'))
    await intentar(`${materia.nombre} · lista de alumnos`, `${base}-alumnos.xlsx`, () => exportarAlumnosXlsx(materia.id, `${base}-alumnos.xlsx`))
    await intentar(`${materia.nombre} · reporte PDF del alumno`, `${base}-reporte.pdf`, () => htmlAPdf(reporteAlumnoHtml(materia.id, alumnoId, 'Docente Demo'), `${base}-reporte.pdf`))

    const evaluaciones = d.prepare('SELECT * FROM evaluaciones WHERE materia_id=? ORDER BY id').all(materia.id) as Evaluacion[]
    for (const ev of evaluaciones) {
      const esJson = ev.contenido.trim().startsWith('{')
      const nombre = `${materia.nombre} · ${ev.titulo}`
      const ruta = `${base}-${ev.id}-${limpio(ev.titulo)}`
      if (esJson) {
        // Los mismos cuatro botones que ve el docente en la evaluación
        await intentar(`${nombre} · PDF`, `${ruta}.pdf`, () => htmlAPdf(evaluacionAHtml(ev, materia, false, 'Docente Demo'), `${ruta}.pdf`))
        await intentar(`${nombre} · PDF + clave`, `${ruta}-clave.pdf`, () => htmlAPdf(evaluacionAHtml(ev, materia, true, 'Docente Demo'), `${ruta}-clave.pdf`))
        await intentar(`${nombre} · Word`, `${ruta}.docx`, () => evaluacionADocx(ev, materia, false, `${ruta}.docx`))
        await intentar(`${nombre} · Word + clave`, `${ruta}-clave.docx`, () => evaluacionADocx(ev, materia, true, `${ruta}-clave.docx`))
      } else {
        await intentar(`${nombre} · PDF`, `${ruta}.pdf`, () => htmlAPdf(markdownAHtml(ev.titulo, ev.contenido), `${ruta}.pdf`))
        await intentar(`${nombre} · Word`, `${ruta}.docx`, () => markdownADocxSimple(ev.titulo, ev.contenido, `${ruta}.docx`))
      }
    }
  }

  d.prepare('DELETE FROM alumnos WHERE id=?').run(alumnoId)
  console.log(`  ✓ ${ok} archivos generados correctamente en ${materias.length} materias`)
  fallos.forEach((f) => console.log('  ✗', f))
  console.log(fallos.length === 0 ? 'Todas las exportaciones funcionan.' : `HAY ${fallos.length} FALLOS EN EXPORTACIÓN`)
  app.quit()
}).catch((e) => {
  console.error('FALLO:', e instanceof Error ? e.message : e)
  app.quit()
})
