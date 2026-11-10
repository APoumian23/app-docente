import type Database from 'better-sqlite3'
import { calcularAlumno, validarEsquema, type Componente, type DatosCalculo, type Esquema, type Fuente, type Parcial, type ResultadoAlumno } from '../shared/esquema'
import type { Alumno, Evaluacion, Materia } from '../shared/types'
import type { Concentrado } from '../shared/calificaciones'
import { modalidadDe, limitesDe, riesgoDe } from '../shared/asistencia'
import { resumenMateria } from './services/classroom-datos'
import { alertaFaltas, asistenciaProyectada, proyectarAlumno, resumenProyeccion, type ContextoProyeccion, type NivelFaltas, type ResumenProyeccion } from '../shared/proyeccion'

/**
 * Lectura y guardado del esquema de calificación de una materia, y el concentrado calculado con él.
 * Sin Electron: lo usan el IPC, la exportación a Excel y las pruebas (sobre una base en memoria).
 */

type FilaComponente = Omit<Componente, 'evaluaciones' | 'rubros'> & { evaluaciones: string; rubros: string }

const json = <T>(t: string, def: T): T => {
  try {
    const v = JSON.parse(t)
    return Array.isArray(def) && !Array.isArray(v) ? def : (v as T)
  } catch {
    return def
  }
}

export function leerEsquema(db: Database.Database, materiaId: number): Esquema | null {
  const e = db.prepare('SELECT * FROM calif_esquemas WHERE materia_id=?').get(materiaId) as { materia_id: number; minima: number; asistencia_minima: number | null; retardo_vale: number; escala_100: number; nota: string } | undefined
  if (!e) return null
  const parciales = db.prepare('SELECT * FROM calif_parciales WHERE materia_id=? ORDER BY orden, id').all(materiaId) as Omit<Parcial, 'componentes'>[]
  const comps = db.prepare('SELECT c.* FROM calif_componentes c JOIN calif_parciales p ON p.id=c.parcial_id WHERE p.materia_id=? ORDER BY c.orden, c.id').all(materiaId) as FilaComponente[]
  return {
    materia_id: e.materia_id,
    minima: e.minima,
    asistencia_minima: e.asistencia_minima,
    retardo_vale: e.retardo_vale,
    escala_100: !!e.escala_100,
    nota: e.nota,
    parciales: parciales.map((p) => ({
      ...p,
      componentes: comps.filter((c) => c.parcial_id === p.id).map((c) => ({ ...c, fuente: c.fuente as Fuente, evaluaciones: json<number[]>(c.evaluaciones, []).map(Number), rubros: json<string[]>(c.rubros, []).map(String) }))
    }))
  }
}

/**
 * Guarda el esquema conservando los ids de parciales y componentes que ya existían: las capturas
 * cuelgan de los componentes, así que solo se pierden las de los componentes que se quitaron.
 */
export function guardarEsquema(db: Database.Database, e: Esquema): Esquema {
  const problemas = validarEsquema(e)
  if (problemas.length) throw new Error(problemas.join(' '))
  db.transaction(() => {
    db.prepare(
      `INSERT INTO calif_esquemas (materia_id, minima, asistencia_minima, retardo_vale, escala_100, nota, actualizado) VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(materia_id) DO UPDATE SET minima=excluded.minima, asistencia_minima=excluded.asistencia_minima, retardo_vale=excluded.retardo_vale, escala_100=excluded.escala_100, nota=excluded.nota, actualizado=excluded.actualizado`
    ).run(e.materia_id, e.minima, e.asistencia_minima, e.retardo_vale, e.escala_100 ? 1 : 0, e.nota ?? '')
    const previosP = new Set((db.prepare('SELECT id FROM calif_parciales WHERE materia_id=?').all(e.materia_id) as { id: number }[]).map((x) => x.id))
    const quedanP = new Set<number>()
    e.parciales.forEach((p, i) => {
      let pid = p.id
      if (pid > 0 && previosP.has(pid)) db.prepare('UPDATE calif_parciales SET orden=?, nombre=?, desde=?, hasta=?, peso=? WHERE id=?').run(i + 1, p.nombre.trim(), p.desde, p.hasta, p.peso > 0 ? p.peso : 1, pid)
      else pid = Number(db.prepare('INSERT INTO calif_parciales (materia_id, orden, nombre, desde, hasta, peso) VALUES (?,?,?,?,?,?)').run(e.materia_id, i + 1, p.nombre.trim(), p.desde, p.hasta, p.peso > 0 ? p.peso : 1).lastInsertRowid)
      quedanP.add(pid)
      const previosC = new Set((db.prepare('SELECT id FROM calif_componentes WHERE parcial_id=?').all(pid) as { id: number }[]).map((x) => x.id))
      const quedanC = new Set<number>()
      p.componentes.forEach((c, j) => {
        const vals = [j + 1, c.nombre.trim(), Number(c.peso), c.fuente, JSON.stringify(c.evaluaciones ?? []), c.escala > 0 ? c.escala : 10, JSON.stringify((c.rubros ?? []).map((r) => r.trim()).filter(Boolean)), c.meta > 0 ? c.meta : 5]
        if (c.id > 0 && previosC.has(c.id)) {
          db.prepare('UPDATE calif_componentes SET orden=?, nombre=?, peso=?, fuente=?, evaluaciones=?, escala=?, rubros=?, meta=? WHERE id=?').run(...vals, c.id)
          quedanC.add(c.id)
        } else quedanC.add(Number(db.prepare('INSERT INTO calif_componentes (parcial_id, orden, nombre, peso, fuente, evaluaciones, escala, rubros, meta) VALUES (?,?,?,?,?,?,?,?,?)').run(pid, ...vals).lastInsertRowid))
      })
      for (const id of previosC) if (!quedanC.has(id)) db.prepare('DELETE FROM calif_componentes WHERE id=?').run(id)
    })
    for (const id of previosP) if (!quedanP.has(id)) db.prepare('DELETE FROM calif_parciales WHERE id=?').run(id)
  })()
  return leerEsquema(db, e.materia_id)!
}

/** Cuántas capturas a mano se perderían si se quitan esos componentes (para avisar antes de guardar). */
export function capturasDe(db: Database.Database, componenteIds: number[]): number {
  if (!componenteIds.length) return 0
  return (db.prepare(`SELECT COUNT(*) AS n FROM calif_capturas WHERE componente_id IN (${componenteIds.map(() => '?').join(',')})`).get(...componenteIds) as { n: number }).n
}

/** Todo lo que el cálculo necesita de una materia. Las fechas de evaluación sin programar usan el día en que se crearon. */
export function datosCalculo(db: Database.Database, materiaId: number, hoy = hoyMx()): DatosCalculo {
  return {
    hoy,
    sesiones: db.prepare("SELECT fecha FROM sesiones WHERE materia_id=? AND estado <> 'cancelada'").all(materiaId) as { fecha: string }[],
    alumnos: (db.prepare('SELECT alumno_id FROM inscripciones WHERE materia_id=?').all(materiaId) as { alumno_id: number }[]).map((x) => x.alumno_id),
    evaluaciones: db.prepare(`SELECT id, tipo, puntos_totales, COALESCE(fecha_aplicacion, date(creado, '-6 hours')) AS fecha FROM evaluaciones WHERE materia_id=?`).all(materiaId) as DatosCalculo['evaluaciones'],
    // Lo capturado en la app manda; sin captura, cuenta la calificación del portal (la mejor si se publicó más de una vez).
    // Las del portal van primero: una fila de la app sin puntaje no las tapa.
    resultados: db
      .prepare(
        `SELECT a.evaluacion_id, i.alumno_id, MAX(i.puntaje) AS puntaje, 'calificado' AS estado FROM intentos i JOIN asignaciones a ON a.id=i.asignacion_id
         WHERE a.materia_id=? AND i.estado='calificado' AND i.puntaje IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM resultados r WHERE r.evaluacion_id=a.evaluacion_id AND r.alumno_id=i.alumno_id AND (r.puntaje IS NOT NULL OR r.estado='no_entregado'))
         GROUP BY a.evaluacion_id, i.alumno_id
         UNION ALL
         SELECT r.evaluacion_id, r.alumno_id, r.puntaje, r.estado FROM resultados r JOIN evaluaciones e ON e.id=r.evaluacion_id WHERE e.materia_id=?`
      )
      .all(materiaId, materiaId) as DatosCalculo['resultados'],
    entregas: db.prepare("SELECT DISTINCT a.evaluacion_id, i.alumno_id FROM intentos i JOIN asignaciones a ON a.id=i.asignacion_id WHERE a.materia_id=? AND i.estado IN ('enviado','calificado')").all(materiaId) as DatosCalculo['entregas'],
    // Evaluaciones publicadas solo a algunos (todas sus publicaciones con destinatarios): no cuentan para los demás
    soloPara: db
      .prepare(
        `SELECT DISTINCT a.evaluacion_id, x.alumno_id FROM asignaciones a JOIN asignacion_alumnos x ON x.asignacion_id = a.id
         WHERE a.materia_id = ? AND NOT EXISTS (
           SELECT 1 FROM asignaciones b WHERE b.evaluacion_id = a.evaluacion_id AND NOT EXISTS (SELECT 1 FROM asignacion_alumnos y WHERE y.asignacion_id = b.id))`
      )
      .all(materiaId) as NonNullable<DatosCalculo['soloPara']>,
    asistencias: db.prepare("SELECT a.alumno_id, s.fecha, a.estado FROM asistencias a JOIN sesiones s ON s.id=a.sesion_id WHERE s.materia_id=? AND s.estado <> 'cancelada'").all(materiaId) as DatosCalculo['asistencias'],
    participaciones: db.prepare('SELECT alumno_id, fecha FROM participaciones WHERE materia_id=?').all(materiaId) as DatosCalculo['participaciones'],
    capturas: db.prepare('SELECT k.* FROM calif_capturas k JOIN calif_componentes c ON c.id=k.componente_id JOIN calif_parciales p ON p.id=c.parcial_id WHERE p.materia_id=?').all(materiaId) as DatosCalculo['capturas'],
    ...classroomParaCalculo(db, materiaId),
    ajustes: db.prepare('SELECT a.parcial_id, a.alumno_id, a.calificacion, a.nota FROM calif_ajustes a JOIN calif_parciales p ON p.id = a.parcial_id WHERE p.materia_id = ?').all(materiaId) as DatosCalculo['ajustes'],
    ajustesFinal: db.prepare('SELECT alumno_id, calificacion, nota FROM calif_ajustes_final WHERE materia_id = ?').all(materiaId) as DatosCalculo['ajustesFinal']
  }
}

/** Pone (o quita, con null) la calificación final de la materia a mano. */
export function ajustarFinal(db: Database.Database, materiaId: number, alumnoId: number, calificacion: number | null, nota = ''): void {
  if (calificacion == null) return void db.prepare('DELETE FROM calif_ajustes_final WHERE materia_id = ? AND alumno_id = ?').run(materiaId, alumnoId)
  if (!(calificacion >= 0 && calificacion <= 10)) throw new Error('La calificación debe estar entre 0 y 10.')
  db.prepare(
    `INSERT INTO calif_ajustes_final (materia_id, alumno_id, calificacion, nota) VALUES (?, ?, ?, ?)
     ON CONFLICT(materia_id, alumno_id) DO UPDATE SET calificacion = excluded.calificacion, nota = excluded.nota, actualizado = datetime('now')`
  ).run(materiaId, alumnoId, Math.round(calificacion * 10) / 10, nota.trim().slice(0, 300))
}

/** Pone (o quita, con null) la calificación de un parcial a mano. */
export function ajustarParcial(db: Database.Database, parcialId: number, alumnoId: number, calificacion: number | null, nota = ''): void {
  if (calificacion == null) return void db.prepare('DELETE FROM calif_ajustes WHERE parcial_id = ? AND alumno_id = ?').run(parcialId, alumnoId)
  if (!(calificacion >= 0 && calificacion <= 10)) throw new Error('La calificación debe estar entre 0 y 10.')
  db.prepare(
    `INSERT INTO calif_ajustes (parcial_id, alumno_id, calificacion, nota) VALUES (?, ?, ?, ?)
     ON CONFLICT(parcial_id, alumno_id) DO UPDATE SET calificacion = excluded.calificacion, nota = excluded.nota, actualizado = datetime('now')`
  ).run(parcialId, alumnoId, Math.round(calificacion * 10) / 10, nota.trim().slice(0, 300))
}

/** Fecha guardada en UTC (o solo día) → día en Ciudad de México. */
const diaMx = (t: string | null): string | null => {
  if (!t) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(d)
}

/**
 * Entregas de Classroom ya consolidadas (duplicados agrupados, recuperaciones acreditadas), solo de
 * alumnos de la lista de la app. Si la materia no está ligada a Classroom, no hay filas.
 */
function classroomParaCalculo(db: Database.Database, materiaId: number): Pick<DatosCalculo, 'classroom' | 'classroomConectado' | 'classroomLigados'> {
  const nada = { classroom: [], classroomConectado: false, classroomLigados: [] }
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='classroom_cursos'").get()) return nada
    const r = resumenMateria(db, materiaId)
    if (!r.cursos.length) return nada
    const alumnoDe = new Map(r.alumnos.map((a) => [a.clave, a.alumno_id]))
    const tareas = new Map(r.consolidado.tareas.map((t) => [t.clave, t]))
    const classroom: NonNullable<DatosCalculo['classroom']> = r.consolidado.celdas.flatMap((c) => {
      const alumno = alumnoDe.get(c.alumno)
      const t = tareas.get(c.tarea_app)
      if (!alumno || !t) return []
      return [{ tarea: t.clave, nombre: t.nombre, fecha: diaMx(t.referencia), alumno_id: alumno, estado: c.estado, calificacion: c.calificacion ?? c.borrador, puntos: c.puntos }]
    })
    // Recuperaciones de quien no debía nada: nota adicional (el cálculo solo la usa si sube el promedio)
    for (const x of r.consolidado.adicionales ?? []) {
      const alumno = alumnoDe.get(x.alumno)
      if (alumno) classroom.push({ tarea: x.comodin, nombre: x.titulo, fecha: diaMx(x.fecha), alumno_id: alumno, estado: 'entrego', calificacion: x.calificacion, puntos: x.puntos, adicional: true })
    }
    return { classroom, classroomConectado: true, classroomLigados: [...new Set(r.alumnos.map((a) => a.alumno_id).filter((x): x is number => x != null))] }
  } catch (e) {
    console.error('[calificación] no se pudo leer Classroom:', (e as Error).message)
    // Si falla la lectura no se puede decir que falta ligar a nadie: se trata como sin conexión
    return nada
  }
}

export interface CalificacionesEsquema {
  esquema: Esquema | null
  alumnos: Alumno[]
  resultados: ResultadoAlumno[]
  capturas: DatosCalculo['capturas']
  participaciones: { alumno_id: number; fecha: string }[]
  evaluaciones: { id: number; titulo: string; tipo: string; puntos_totales: number; fecha: string | null }[]
  /** Sesiones que ya pasaron (no canceladas) sin ningún pase de lista: la asistencia del parcial no las cuenta. */
  sesiones_sin_lista: string[]
  /** Si la materia está ligada a Classroom y cuántos alumnos de la lista no están ligados. */
  classroom: { conectado: boolean; sin_ligar: number[] }
}

export function calificacionesEsquema(db: Database.Database, materiaId: number, hoy = hoyMx()): CalificacionesEsquema {
  const esquema = leerEsquema(db, materiaId)
  const alumnos = db.prepare('SELECT a.* FROM alumnos a JOIN inscripciones i ON i.alumno_id=a.id WHERE i.materia_id=? ORDER BY a.apellidos, a.nombre').all(materiaId) as Alumno[]
  const evaluaciones = db.prepare(`SELECT id, titulo, tipo, puntos_totales, COALESCE(fecha_aplicacion, date(creado, '-6 hours')) AS fecha FROM evaluaciones WHERE materia_id=? ORDER BY fecha, id`).all(materiaId) as CalificacionesEsquema['evaluaciones']
  const datos = datosCalculo(db, materiaId, hoy)
  return {
    esquema,
    alumnos,
    resultados: esquema ? alumnos.map((a) => calcularAlumno(esquema, datos, a.id)) : [],
    capturas: datos.capturas,
    participaciones: datos.participaciones,
    evaluaciones,
    sesiones_sin_lista: (db.prepare(`SELECT fecha FROM sesiones s WHERE materia_id=? AND estado <> 'cancelada' AND fecha < ?
      AND NOT EXISTS (SELECT 1 FROM asistencias a WHERE a.sesion_id = s.id) ORDER BY fecha`).all(materiaId, hoy) as { fecha: string }[]).map((x) => x.fecha),
    classroom: {
      conectado: !!datos.classroomConectado,
      sin_ligar: datos.classroomConectado ? alumnos.filter((a) => !(datos.classroomLigados ?? []).includes(a.id)).map((a) => a.id) : []
    }
  }
}

/**
 * Guarda (o borra, si todo queda vacío) una captura manual. Solo cambia los campos que vienen:
 * un campo ausente conserva lo guardado, así dos capturas seguidas del mismo alumno no se pisan.
 */
export function guardarCaptura(db: Database.Database, c: { componente_id: number; alumno_id: number; rubro?: number; valor?: number | null; entregado?: number | null; extra?: number | null }): void {
  const rubro = c.rubro ?? 0
  const antes = db.prepare('SELECT valor, entregado, extra FROM calif_capturas WHERE componente_id=? AND alumno_id=? AND rubro=?').get(c.componente_id, c.alumno_id, rubro) as
    { valor: number | null; entregado: number | null; extra: number | null } | undefined
  const valor = c.valor === undefined ? antes?.valor ?? null : c.valor == null || Number.isNaN(Number(c.valor)) ? null : Number(c.valor)
  const extra = c.extra === undefined ? antes?.extra ?? null : c.extra == null || Number.isNaN(Number(c.extra)) || Number(c.extra) === 0 ? null : Number(c.extra)
  const entregado = c.entregado === undefined ? antes?.entregado ?? null : c.entregado == null ? null : c.entregado ? 1 : 0
  if (valor == null && extra == null && entregado == null) {
    db.prepare('DELETE FROM calif_capturas WHERE componente_id=? AND alumno_id=? AND rubro=?').run(c.componente_id, c.alumno_id, rubro)
    return
  }
  db.prepare(
    `INSERT INTO calif_capturas (componente_id, alumno_id, rubro, valor, entregado, extra) VALUES (?,?,?,?,?,?)
     ON CONFLICT(componente_id, alumno_id, rubro) DO UPDATE SET valor=excluded.valor, entregado=excluded.entregado, extra=excluded.extra`
  ).run(c.componente_id, c.alumno_id, rubro, valor, entregado, extra)
}

/** Esquema inicial para una materia sin esquema: tres parciales que reparten el periodo y los componentes del maestro. */
export function esquemaPorOmision(db: Database.Database, materiaId: number): Esquema {
  const m = db.prepare('SELECT p.fecha_inicio, p.semanas FROM materias m JOIN periodos p ON p.id=m.periodo_id WHERE m.id=?').get(materiaId) as { fecha_inicio: string; semanas: number } | undefined
  if (!m) throw new Error('Materia no encontrada')
  const inicio = new Date(m.fecha_inicio + 'T12:00:00')
  const dia = (n: number): string => {
    const d = new Date(inicio)
    d.setDate(d.getDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const dias = m.semanas * 7 - 1
  const cortes = [0, Math.round(dias / 3), Math.round((dias * 2) / 3), dias]
  const evals = db.prepare("SELECT id, tipo, COALESCE(fecha_aplicacion, date(creado, '-6 hours')) AS fecha FROM evaluaciones WHERE materia_id=? AND tipo='examen'").all(materiaId) as { id: number; fecha: string }[]
  const parciales: Parcial[] = [0, 1, 2].map((i) => {
    const desde = dia(cortes[i] + (i ? 1 : 0))
    const hasta = dia(cortes[i + 1])
    return { id: -(i + 1), materia_id: materiaId, orden: i + 1, nombre: i === 2 ? 'Parcial 3 (final)' : `Parcial ${i + 1}`, desde, hasta, peso: 1, componentes: componentesBase(-(i + 1), evals.filter((e) => e.fecha >= desde && e.fecha <= hasta).map((e) => e.id)) }
  })
  return { materia_id: materiaId, minima: 7, asistencia_minima: null, retardo_vale: 1, escala_100: false, nota: '', parciales }
}

/** Componentes del libro de calificaciones de ADA: examen 30, asistencia 20, tarea 1 y 2, actividades y participación 12.5 cada uno. */
export function componentesBase(parcialId: number, examenes: number[]): Componente[] {
  const c = (orden: number, nombre: string, peso: number, fuente: Fuente, extra: Partial<Componente> = {}): Componente => ({ id: -(Math.abs(parcialId) * 100 + orden), parcial_id: parcialId, orden, nombre, peso, fuente, evaluaciones: [], escala: 10, rubros: [], meta: 5, ...extra })
  return [
    examenes.length ? c(1, 'Examen parcial', 30, 'evaluaciones', { evaluaciones: examenes }) : c(1, 'Examen parcial', 30, 'manual'),
    c(2, 'Asistencia', 20, 'asistencia'),
    c(3, 'Tarea 1', 12.5, 'manual'),
    c(4, 'Tarea 2', 12.5, 'manual'),
    c(5, 'Actividades entregadas', 12.5, 'actividades'),
    c(6, 'Participación en clase', 12.5, 'participacion')
  ]
}

/**
 * Concentrado por alumno de una materia: horas de falta contra el límite del comunicado y
 * promedio ponderado de lo que ya está calificado. Lo usan la pestaña Calificaciones y el detalle del alumno.
 */
export function concentradoMateria(d: Database.Database, materiaId: number): Concentrado {
  const materia = d.prepare('SELECT m.*, p.semanas, p.nombre AS periodo FROM materias m JOIN periodos p ON p.id=m.periodo_id WHERE m.id=?').get(materiaId) as (Materia & { semanas: number; periodo: string }) | undefined
  if (!materia) throw new Error('Materia no encontrada')
  const horarios = d.prepare('SELECT dia, hora_inicio, hora_fin FROM horarios WHERE materia_id=?').all(materiaId) as { dia: number; hora_inicio: string; hora_fin: string }[]
  const minutos = (a: string, b: string): number => {
    const [h1, m1] = a.split(':').map(Number)
    const [h2, m2] = b.split(':').map(Number)
    return h2 * 60 + m2 - (h1 * 60 + m1)
  }
  const horasSemana = horarios.reduce((s, x) => s + minutos(x.hora_inicio, x.hora_fin), 0) / 60
  const modalidad = modalidadDe(materia.semanas, horarios.length > 0 && horarios.every((x) => x.dia === 6))
  const limites = limitesDe(modalidad, horasSemana, materia.semanas)

  const alumnos = d.prepare('SELECT a.* FROM alumnos a JOIN inscripciones i ON i.alumno_id=a.id WHERE i.materia_id=? ORDER BY a.apellidos, a.nombre').all(materiaId) as Alumno[]
  const evaluaciones = d.prepare('SELECT id, titulo, tipo, puntos_totales, fecha_aplicacion FROM evaluaciones WHERE materia_id=? ORDER BY fecha_aplicacion, id').all(materiaId) as Evaluacion[]
  const asistencias = d.prepare("SELECT a.alumno_id, a.estado, s.hora_inicio, s.hora_fin FROM asistencias a JOIN sesiones s ON s.id=a.sesion_id WHERE s.materia_id=? AND s.estado <> 'cancelada'").all(materiaId) as { alumno_id: number; estado: string; hora_inicio: string; hora_fin: string }[]
  const resultados = d.prepare('SELECT r.evaluacion_id, r.alumno_id, r.puntaje, r.estado FROM resultados r JOIN evaluaciones e ON e.id=r.evaluacion_id WHERE e.materia_id=?').all(materiaId) as { evaluacion_id: number; alumno_id: number; puntaje: number | null; estado: string }[]
  const puntosTotales = evaluaciones.reduce((s, e) => s + e.puntos_totales, 0)

  const filas = alumnos.map((al) => {
    const mias = asistencias.filter((x) => x.alumno_id === al.id)
    const horasFalta = mias.filter((x) => x.estado === 'ausente').reduce((s, x) => s + minutos(x.hora_inicio, x.hora_fin) / 60, 0)
    const sesionesConRegistro = mias.length
    const presentes = mias.filter((x) => x.estado !== 'ausente').length
    const calificadas = evaluaciones.filter((e) => {
      const r = resultados.find((x) => x.evaluacion_id === e.id && x.alumno_id === al.id)
      return r && r.puntaje != null
    })
    const obtenidos = calificadas.reduce((s, e) => s + (resultados.find((x) => x.evaluacion_id === e.id && x.alumno_id === al.id)!.puntaje ?? 0), 0)
    const posibles = calificadas.reduce((s, e) => s + e.puntos_totales, 0)
    return {
      alumno: al,
      horas_falta: Math.round(horasFalta * 10) / 10,
      riesgo: riesgoDe(horasFalta, limites),
      sesiones_con_registro: sesionesConRegistro,
      porcentaje_asistencia: sesionesConRegistro ? Math.round((presentes / sesionesConRegistro) * 100) : null,
      puntos_obtenidos: Math.round(obtenidos * 100) / 100,
      puntos_evaluados: Math.round(posibles * 100) / 100,
      // Promedio sobre lo ya calificado, en escala de 10
      promedio_parcial: posibles > 0 ? Math.round((obtenidos / posibles) * 100) / 10 : null,
      // Calificación si no entregara nada más
      proyeccion: puntosTotales > 0 ? Math.round((obtenidos / puntosTotales) * 100) / 10 : null,
      pendientes: evaluaciones.length - calificadas.length
    }
  })
  return { materia: { id: materia.id, nombre: materia.nombre, periodo: materia.periodo }, horas_semana: Math.round(horasSemana * 100) / 100, modalidad, limites, puntos_totales: puntosTotales, evaluaciones, filas }
}


const minutosEntre = (a: string, b: string): number => {
  const [h1, m1] = a.split(':').map(Number)
  const [h2, m2] = b.split(':').map(Number)
  return h2 * 60 + m2 - (h1 * 60 + m1)
}

/** Hoy en Ciudad de México (YYYY-MM-DD). */
export function hoyMx(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
}

function contexto(db: Database.Database, c: Concentrado, alumnoId: number, hoy: string): ContextoProyeccion {
  const sesiones = (db.prepare("SELECT fecha, hora_inicio, hora_fin FROM sesiones WHERE materia_id=? AND estado <> 'cancelada'").all(c.materia.id) as { fecha: string; hora_inicio: string; hora_fin: string }[]).map((s) => ({ fecha: s.fecha, horas: Math.max(0, minutosEntre(s.hora_inicio, s.hora_fin)) / 60 }))
  return { hoy, sesiones, limites: c.limites, horas_falta: c.filas.find((f) => f.alumno.id === alumnoId)?.horas_falta ?? 0 }
}

/**
 * Proyección de toda la materia: lo que muestra la vista Proyección, la hoja del Excel y el resumen
 * que se le puede pasar a la IA. Sin esquema devuelve null.
 */
export function proyeccionMateria(db: Database.Database, materiaId: number, hoy = hoyMx()): ResumenProyeccion | null {
  const e = leerEsquema(db, materiaId)
  if (!e) return null
  const c = concentradoMateria(db, materiaId)
  const datos = datosCalculo(db, materiaId, hoy)
  const alumnos = db.prepare('SELECT a.* FROM alumnos a JOIN inscripciones i ON i.alumno_id=a.id WHERE i.materia_id=? ORDER BY a.apellidos, a.nombre').all(materiaId) as Alumno[]
  const resultados = alumnos.map((a) => calcularAlumno(e, datos, a.id))
  const proyecciones = resultados.map((r) => proyectarAlumno(e, r, datos, contexto(db, c, r.alumno_id, hoy)))
  return resumenProyeccion(c.materia, e, alumnos, resultados, proyecciones, hoy)
}

export interface AlertaFaltas {
  materia_id: number
  materia_nombre: string
  materia_color: string
  alumno_id: number
  alumno: string
  matricula: string
  nivel: NivelFaltas
  texto: string
  faltas: number
  horas_falta: number
}

/** Alumnos con aviso por faltas (comunicado COM-AS-01, horas en todo el curso), de una materia o de todas las visibles. */
export function alertasFaltas(db: Database.Database, materiaId?: number, hoy = hoyMx()): AlertaFaltas[] {
  const materias = materiaId
    ? (db.prepare('SELECT id, nombre, color FROM materias WHERE id=?').all(materiaId) as Pick<Materia, 'id' | 'nombre' | 'color'>[])
    : (db.prepare('SELECT id, nombre, color FROM materias WHERE oculta = 0 ORDER BY nombre').all() as Pick<Materia, 'id' | 'nombre' | 'color'>[])
  const lista: AlertaFaltas[] = []
  for (const m of materias) {
    const c = concentradoMateria(db, m.id)
    const e = leerEsquema(db, m.id)
    const asistencias = (db.prepare("SELECT a.alumno_id, s.fecha, a.estado FROM asistencias a JOIN sesiones s ON s.id=a.sesion_id WHERE s.materia_id=? AND s.estado <> 'cancelada'").all(m.id)) as DatosCalculo['asistencias']
    for (const f of c.filas) {
      if (!asistencias.some((a) => a.alumno_id === f.alumno.id)) continue
      const a = asistenciaProyectada(e, f.alumno.id, { asistencias }, contexto(db, c, f.alumno.id, hoy))
      const al = alertaFaltas(a)
      if (!al.nivel) continue
      lista.push({ materia_id: m.id, materia_nombre: m.nombre, materia_color: m.color, alumno_id: f.alumno.id, alumno: `${f.alumno.apellidos} ${f.alumno.nombre}`.trim(), matricula: f.alumno.matricula, nivel: al.nivel, texto: al.texto, faltas: a.faltas, horas_falta: a.horas_falta })
    }
  }
  const orden: NivelFaltas[] = ['recursa', 'titulo', 'extraordinario', 'atencion', 'alerta']
  return lista.sort((x, y) => orden.indexOf(x.nivel) - orden.indexOf(y.nivel) || y.horas_falta - x.horas_falta || x.alumno.localeCompare(y.alumno, 'es'))
}
