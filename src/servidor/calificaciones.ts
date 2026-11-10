/**
 * Calificaciones desde el panel web: el mismo cálculo que la app de escritorio (src/main/calificacion.ts)
 * y la captura a mano de componentes. Las capturas tienen llave natural (componente, alumno, rubro):
 * con el portal en línea viajan a la Mac sin chocar.
 */
import type Database from 'better-sqlite3'
import { calificacionesEsquema, guardarCaptura } from '../main/calificacion'
import type { Esquema, ResultadoAlumno } from '../shared/esquema'
import { ErrorHttp } from './auth'

type DB = Database.Database

export interface CalificacionesWeb {
  esquema: Esquema | null
  alumnos: { id: number; matricula: string; nombre: string; apellidos: string; activo: number }[]
  resultados: ResultadoAlumno[]
  capturas: { componente_id: number; alumno_id: number; rubro: number; valor: number | null; entregado: number | null; extra: number | null }[]
}

export function calificacionesDeMateria(db: DB, materiaId: number): CalificacionesWeb {
  const c = calificacionesEsquema(db, materiaId)
  return {
    esquema: c.esquema,
    alumnos: c.alumnos.map((a) => ({ id: a.id, matricula: a.matricula, nombre: a.nombre, apellidos: a.apellidos, activo: a.activo })),
    resultados: c.resultados,
    capturas: c.capturas
  }
}

/** Captura a mano: el componente debe ser de esta materia y el valor estar dentro de su escala. */
export function capturar(db: DB, materiaId: number, c: { componente_id: number; alumno_id: number; rubro?: number; valor: number | null }): CalificacionesWeb {
  const comp = db
    .prepare('SELECT c.escala, c.rubros FROM calif_componentes c JOIN calif_parciales p ON p.id = c.parcial_id WHERE c.id = ? AND p.materia_id = ?')
    .get(c.componente_id, materiaId) as { escala: number; rubros: string } | undefined
  if (!comp) throw new ErrorHttp(404, 'Ese componente no es de esta materia.')
  if (!db.prepare('SELECT 1 FROM inscripciones WHERE materia_id = ? AND alumno_id = ?').get(materiaId, c.alumno_id)) throw new ErrorHttp(400, 'Ese alumno no está inscrito en esta materia.')
  const rubros = JSON.parse(comp.rubros || '[]') as string[]
  const rubro = Number(c.rubro ?? 0)
  if (!Number.isInteger(rubro) || rubro < 0 || rubro >= Math.max(1, rubros.length)) throw new ErrorHttp(400, 'Rubro no válido.')
  if (c.valor !== null && (!Number.isFinite(c.valor) || c.valor < 0 || c.valor > comp.escala)) throw new ErrorHttp(400, `La calificación debe estar entre 0 y ${comp.escala}.`)
  guardarCaptura(db, { componente_id: c.componente_id, alumno_id: c.alumno_id, rubro, valor: c.valor })
  return calificacionesDeMateria(db, materiaId)
}
