import type Database from 'better-sqlite3'
import { resumenMateria } from './classroom-datos'
import { leerEsquema } from '../calificacion'

const norm = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Lleva las tareas consolidadas de Classroom («Tarea 1» con sus duplicados y recuperaciones ya
 * resueltos) a los componentes manuales del parcial que se llamen igual: el rubro «Tarea 1» de
 * Álgebra o el componente «Tarea 1» de ADA. Marca entregó / no entregó y, si hay calificación en
 * Classroom, la convierte a la escala del componente. Lo que Classroom no tiene no se toca.
 * Nunca baja lo capturado a mano: si ya tiene «entregó» o una calificación y Classroom dice que no
 * entregó (o la retiró), se respeta lo capturado y se cuenta en `respetadas`. Una retirada no se toma como «no entregó».
 */
export function classroomACalificaciones(db: Database.Database, materiaId: number, parcialOrden: number): { capturas: number; respetadas: number; tareas: string[]; sin_tarea: string[] } {
  const esquema = leerEsquema(db, materiaId)
  const parcial = esquema?.parciales.find((p) => p.orden === parcialOrden)
  if (!parcial) throw new Error('Ese parcial no existe en el esquema de la materia.')
  const r = resumenMateria(db, materiaId)
  if (!r.cursos.length) throw new Error('Esta materia no está ligada a ninguna clase de Classroom. Lígala en Ajustes › Google Classroom.')
  const alumnoDe = new Map(r.alumnos.map((a) => [a.clave, a.alumno_id]))
  const tareaPorNombre = new Map(r.consolidado.tareas.map((t) => [norm(t.nombre), t]))
  const guardar = db.prepare(
    `INSERT INTO calif_capturas (componente_id, alumno_id, rubro, valor, entregado, extra) VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(componente_id, alumno_id, rubro) DO UPDATE SET entregado = excluded.entregado, valor = COALESCE(excluded.valor, calif_capturas.valor)`
  )
  const previa = db.prepare('SELECT valor, entregado FROM calif_capturas WHERE componente_id = ? AND alumno_id = ? AND rubro = ?')
  const usadas: string[] = []
  const sinTarea: string[] = []
  let capturas = 0
  let respetadas = 0
  db.transaction(() => {
    for (const c of parcial.componentes.filter((x) => x.fuente === 'manual')) {
      const nombres = c.rubros.length ? c.rubros : [c.nombre]
      nombres.forEach((nombre, rubro) => {
        const tarea = tareaPorNombre.get(norm(nombre))
        if (!tarea) return void (/tarea|actividad|pr[aá]ctica/i.test(nombre) && sinTarea.push(nombre))
        usadas.push(nombre)
        for (const celda of r.consolidado.celdas.filter((x) => x.tarea_app === tarea.clave)) {
          const alumno = alumnoDe.get(celda.alumno)
          if (!alumno || celda.estado === 'pendiente' || celda.estado === 'no_asignada' || celda.estado === 'retirada') continue
          const entrego = celda.estado === 'entrego' || celda.estado === 'tarde' ? 1 : 0
          const antes = previa.get(c.id, alumno, rubro) as { valor: number | null; entregado: number | null } | undefined
          if (!entrego && antes && (antes.entregado === 1 || antes.valor !== null)) {
            respetadas++
            continue
          }
          const nota = celda.calificacion ?? celda.borrador
          const valor = entrego && nota !== null && celda.puntos ? Math.round((nota / celda.puntos) * c.escala * 100) / 100 : null
          capturas += guardar.run(c.id, alumno, rubro, valor, entrego).changes
        }
      })
    }
  })()
  return { capturas, respetadas, tareas: usadas, sin_tarea: sinTarea }
}
