import type Database from 'better-sqlite3'
import { leerAjuste, escribirAjuste } from '../servidor/base'
import { guardarEsquema, leerEsquema } from './calificacion'
import type { Componente, Esquema, Fuente } from '../shared/esquema'

/**
 * Datos que la app trae precargados y llegan al maestro al actualizar. Cada grupo se aplica una sola vez
 * (queda anotado en ajustes): si después borra o cambia algo, no vuelve a aparecer ni se pisa.
 */
export function aplicarSemillas(db: Database.Database): void {
  sembrarFechasInstitucionales(db)
  sembrarFechasAlgebra(db)
  sembrarEsquemas(db)
  tareasDeClassroomEnParciales(db)
}

/**
 * Los esquemas ya sembrados tenían «Tarea 1 / Tarea 2» fijas también en los parciales 2 y 3. Una sola vez,
 * esos dos parciales pasan a contar todas las tareas de Classroom, solo si aún no tienen nada capturado
 * (si el maestro ya capturó o editó algo ahí, no se toca).
 */
function tareasDeClassroomEnParciales(db: Database.Database): void {
  const clave = 'semilla_classroom_parciales_2_3'
  if (leerAjuste(db, clave)) return
  const insertar = db.prepare('INSERT INTO calif_componentes (parcial_id, orden, nombre, peso, fuente, evaluaciones, escala, rubros, meta) VALUES (?,?,?,?,?,?,?,?,?)')
  db.transaction(() => {
    for (const [patron, nuevos, originales] of [
      ['%algoritmos%', componentesAdaClassroom, ['Examen parcial', 'Asistencia', 'Tarea 1', 'Tarea 2', 'Actividades entregadas', 'Participación en clase']],
      ['%lgebra lineal%', componentesAlgebraClassroom, ['Tareas', 'Asistencia', 'Participación y actitud', 'Examen parcial']]
    ] as const) {
      const id = materiaPorNombre(db, patron)
      if (!id) continue
      const parciales = db.prepare('SELECT id FROM calif_parciales WHERE materia_id = ? AND orden IN (2, 3)').all(id) as { id: number }[]
      for (const { id: parcial } of parciales) {
        const actuales = (db.prepare('SELECT nombre FROM calif_componentes WHERE parcial_id = ? ORDER BY orden').all(parcial) as { nombre: string }[]).map((x) => x.nombre)
        const capturas = (db.prepare('SELECT COUNT(*) AS n FROM calif_capturas k JOIN calif_componentes c ON c.id = k.componente_id WHERE c.parcial_id = ?').get(parcial) as { n: number }).n
        if (capturas || actuales.join('|') !== originales.join('|')) continue
        db.prepare('DELETE FROM calif_componentes WHERE parcial_id = ?').run(parcial)
        for (const c of nuevos()) insertar.run(parcial, c.orden, c.nombre, c.peso, c.fuente, JSON.stringify(c.evaluaciones), c.escala, JSON.stringify(c.rubros), c.meta)
      }
    }
  })()
  escribirAjuste(db, clave, new Date().toISOString())
}

type Semilla = { clave: string; fecha: string; fecha_fin?: string; titulo: string; tipo: 'parcial' | 'entrega' | 'suspension' | 'otro'; avisar: number; notas?: string }

const FUENTE_CALENDARIO = 'Calendario académico de ejemplo, semestre agosto–diciembre 2026.'

/** Calendario académico de ejemplo (agosto–diciembre 2026, 16 semanas). Cada escuela pone aquí el suyo. */
const FECHAS_CALENDARIO: Semilla[] = [
  { clave: 'semestre-2026-1:suspension-0916', fecha: '2026-09-16', titulo: 'Suspensión de labores', tipo: 'suspension', avisar: 3 },
  { clave: 'semestre-2026-1:parcial-1', fecha: '2026-09-21', fecha_fin: '2026-09-25', titulo: 'Primer examen parcial (semestre)', tipo: 'parcial', avisar: 7 },
  { clave: 'semestre-2026-1:calif-1', fecha: '2026-09-30', titulo: 'Calificaciones del primer parcial visibles en el sistema escolar', tipo: 'entrega', avisar: 3, notas: 'Consulta de calificaciones en el sistema escolar.' },
  { clave: 'semestre-2026-1:parcial-2', fecha: '2026-10-26', fecha_fin: '2026-10-30', titulo: 'Segundo examen parcial (semestre)', tipo: 'parcial', avisar: 7 },
  { clave: 'semestre-2026-1:calif-2', fecha: '2026-11-05', titulo: 'Calificaciones del segundo parcial visibles en el sistema escolar', tipo: 'entrega', avisar: 3, notas: 'Consulta de calificaciones en el sistema escolar.' },
  { clave: 'semestre-2026-1:suspension-1116', fecha: '2026-11-16', titulo: 'Suspensión de labores', tipo: 'suspension', avisar: 3 },
  { clave: 'semestre-2026-1:final', fecha: '2026-12-04', fecha_fin: '2026-12-10', titulo: 'Tercer examen (final) del semestre', tipo: 'parcial', avisar: 7 },
  { clave: 'semestre-2026-1:fin-cursos', fecha: '2026-12-11', titulo: 'Fin de cursos · calificaciones finales visibles en el sistema escolar', tipo: 'otro', avisar: 5 },
  { clave: 'semestre-2026-1:regularizacion-insc', fecha: '2026-12-14', titulo: 'Inscripciones al primer periodo de regularización', tipo: 'otro', avisar: 2 },
  { clave: 'semestre-2026-1:extraordinarios', fecha: '2026-12-16', fecha_fin: '2026-12-17', titulo: 'Exámenes extraordinarios (primer periodo de regularización)', tipo: 'parcial', avisar: 5, notas: 'Calificaciones visibles en el sistema escolar a partir del 18 de diciembre.' },
  { clave: 'semestre-2026-1:ets', fecha: '2027-01-14', fecha_fin: '2027-01-15', titulo: 'Exámenes a título de suficiencia', tipo: 'parcial', avisar: 5, notas: 'Inscripciones el 11 de enero; calificaciones en el sistema escolar a partir del 18 de enero.' },
  { clave: 'semestre-2026-1:actas', fecha: '2027-02-10', titulo: 'Entrega de actas', tipo: 'entrega', avisar: 7 }
]

const insertarFecha = (db: Database.Database, s: Semilla, materiaId: number | null, fuente: string): void => {
  db.prepare('INSERT OR IGNORE INTO recordatorios (clave, fecha, fecha_fin, titulo, tipo, materia_id, avisar_dias, notas) VALUES (?,?,?,?,?,?,?,?)').run(
    s.clave, s.fecha, s.fecha_fin ?? null, s.titulo, s.tipo, materiaId, s.avisar, [s.notas, fuente].filter(Boolean).join(' ')
  )
}

function sembrarFechasInstitucionales(db: Database.Database): void {
  const clave = 'semilla_fechas_semestre_2026_1'
  if (leerAjuste(db, clave)) return
  db.transaction(() => {
    for (const s of FECHAS_CALENDARIO) insertarFecha(db, s, null, FUENTE_CALENDARIO)
    escribirAjuste(db, clave, new Date().toISOString())
  })()
}

/** Álgebra Lineal es cuatrimestral (sábados) y no entra en el calendario semestral: sus exámenes vienen de su planeación. */
function sembrarFechasAlgebra(db: Database.Database): void {
  const clave = 'semilla_fechas_algebra_2026'
  if (leerAjuste(db, clave)) return
  const m = materiaPorNombre(db, '%lgebra lineal%')
  if (!m) return
  const fuente = 'Fecha de la planeación del cuatrimestre cargada en la app (no hay calendario cuatrimestral oficial).'
  db.transaction(() => {
    for (const s of [
      { clave: 'alg-2026:p1', fecha: '2026-09-26', titulo: 'Álgebra Lineal: Parcial 1', tipo: 'parcial', avisar: 7 },
      { clave: 'alg-2026:p2', fecha: '2026-10-24', titulo: 'Álgebra Lineal: Parcial 2', tipo: 'parcial', avisar: 7 },
      { clave: 'alg-2026:p3', fecha: '2026-11-28', titulo: 'Álgebra Lineal: Parcial 3', tipo: 'parcial', avisar: 7 },
      { clave: 'alg-2026:final', fecha: '2026-12-05', titulo: 'Álgebra Lineal: Examen final integrador', tipo: 'parcial', avisar: 7 }
    ] as Semilla[])
      insertarFecha(db, s, m, fuente)
    escribirAjuste(db, clave, new Date().toISOString())
  })()
}

function materiaPorNombre(db: Database.Database, patron: string): number | null {
  const r = db.prepare('SELECT id FROM materias WHERE nombre LIKE ? ORDER BY oculta, id LIMIT 1').get(patron) as { id: number } | undefined
  return r?.id ?? null
}

const comp = (orden: number, nombre: string, peso: number, fuente: Fuente, extra: Partial<Componente> = {}): Componente => ({ id: 0, parcial_id: 0, orden, nombre, peso, fuente, evaluaciones: [], escala: 10, rubros: [], meta: 5, ...extra })

/**
 * Desde el parcial 2 el maestro deja muchas tareas en Classroom (no solo dos): los mismos pesos del libro,
 * pero «Tarea 1 + Tarea 2» (25 %) pasa a ser el promedio de TODAS las tareas de Classroom del parcial y
 * «Actividades entregadas» (12.5 %) el porcentaje de trabajos entregados en Classroom.
 */
const componentesAdaClassroom = (): Componente[] => [
  comp(1, 'Examen parcial', 30, 'manual', { escala: 10 }),
  comp(2, 'Asistencia', 20, 'asistencia'),
  comp(3, 'Tareas de Classroom', 25, 'classroom_promedio'),
  comp(4, 'Trabajos entregados (Classroom)', 12.5, 'classroom_entregas'),
  comp(5, 'Participación en clase', 12.5, 'participacion', { meta: 5 })
]

/** Álgebra desde el parcial 2: «Tareas» (40 %) es el promedio de todas las tareas de Classroom del parcial. */
const componentesAlgebraClassroom = (): Componente[] => [
  comp(1, 'Tareas de Classroom', 40, 'classroom_promedio'),
  comp(2, 'Asistencia', 15, 'asistencia'),
  comp(3, 'Participación y actitud', 15, 'manual', { escala: 15 }),
  comp(4, 'Examen parcial', 30, 'manual', { escala: 100 })
]

/** Libro «Calificaciones_Parcial1_ADA_5.xlsx», hoja Configuración. Parciales según el calendario del semestre. */
function esquemaAda(materiaId: number): Esquema {
  const componentes = (aciertos: number): Componente[] => [
    comp(1, 'Examen parcial', 30, 'manual', { escala: aciertos }),
    comp(2, 'Asistencia', 20, 'asistencia'),
    comp(3, 'Tarea 1', 12.5, 'manual'),
    comp(4, 'Tarea 2', 12.5, 'manual'),
    comp(5, 'Actividades entregadas', 12.5, 'actividades'),
    comp(6, 'Participación en clase', 12.5, 'participacion', { meta: 5 })
  ]
  return {
    materia_id: materiaId,
    minima: 7,
    asistencia_minima: null,
    retardo_vale: 1,
    escala_100: false,
    nota: 'Tomado del libro Calificaciones_Parcial1_ADA_5.xlsx (hoja Configuración). El examen del parcial 1 se captura en aciertos de 26 reactivos más décimas extra.',
    parciales: [
      { id: 0, materia_id: materiaId, orden: 1, nombre: 'Parcial 1', desde: '2026-08-24', hasta: '2026-09-25', peso: 1, componentes: componentes(26) },
      { id: 0, materia_id: materiaId, orden: 2, nombre: 'Parcial 2', desde: '2026-09-26', hasta: '2026-10-30', peso: 1, componentes: componentesAdaClassroom() },
      { id: 0, materia_id: materiaId, orden: 3, nombre: 'Parcial 3 (final)', desde: '2026-10-31', hasta: '2026-12-11', peso: 1, componentes: componentesAdaClassroom() }
    ]
  }
}

/**
 * Libro «Calificaciones_Parcial_1_Algebra.xlsx», hoja Configuración. El parcial 1 abarca las sesiones 1 a 6
 * (examen en la 4 y dos sesiones más); los otros dos siguen el mismo patrón con los exámenes de la planeación
 * (sesión 8 y sesiones 13–14): P2 = sesiones 7–10, P3 = 11–14. Son editables.
 */
function esquemaAlgebra(materiaId: number): Esquema {
  const componentes = (): Componente[] => [
    comp(1, 'Tareas', 40, 'manual', { escala: 10, rubros: ['Tarea 1', 'Tarea 2'] }),
    comp(2, 'Asistencia', 15, 'asistencia'),
    comp(3, 'Participación y actitud', 15, 'manual', { escala: 15 }),
    comp(4, 'Examen parcial', 30, 'manual', { escala: 100 })
  ]
  return {
    materia_id: materiaId,
    minima: 6,
    asistencia_minima: 80,
    retardo_vale: 1,
    escala_100: true,
    nota: 'Tomado del libro Calificaciones_Parcial_1_Algebra.xlsx (hoja Configuración): rubro 70 % (tareas 40, asistencia 15, participación y actitud 15) + examen 30 %. Con menos de 80 % de asistencia el parcial queda «NA por inasistencias».',
    parciales: [
      { id: 0, materia_id: materiaId, orden: 1, nombre: 'Parcial 1', desde: '2026-08-31', hasta: '2026-10-10', peso: 1, componentes: componentes() },
      { id: 0, materia_id: materiaId, orden: 2, nombre: 'Parcial 2', desde: '2026-10-11', hasta: '2026-11-07', peso: 1, componentes: componentesAlgebraClassroom() },
      { id: 0, materia_id: materiaId, orden: 3, nombre: 'Parcial 3 (final)', desde: '2026-11-08', hasta: '2026-12-05', peso: 1, componentes: componentesAlgebraClassroom() }
    ]
  }
}

function sembrarEsquemas(db: Database.Database): void {
  for (const [patron, armar] of [['%algoritmos%', esquemaAda], ['%lgebra lineal%', esquemaAlgebra]] as const) {
    const id = materiaPorNombre(db, patron)
    if (!id) continue
    const clave = `semilla_esquema_${id}`
    if (leerAjuste(db, clave)) continue
    if (!leerEsquema(db, id)) guardarEsquema(db, armar(id))
    escribirAjuste(db, clave, new Date().toISOString())
  }
}
