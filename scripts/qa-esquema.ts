/**
 * Calificación por esquema, proyección y avisos por faltas, sobre una base en memoria (nunca la real).
 * Reproduce alumnos con datos conocidos de los libros del maestro:
 *   · Calificaciones_Parcial1_ADA_5.xlsx (Escobedo Mireles 7.4, Bustos Olvera 6.2, Cervantes Landa 8.4)
 *   · Calificaciones_Parcial_1_Algebra.xlsx (Ernesto Arizmendi 8.7 Aprobado, Pacheco Saucedo 7.5 NA por inasistencias…)
 * y revisa que las semillas (fechas del calendario y esquemas) sean idempotentes.
 * Se corre desde qa.sh con Electron como Node (better-sqlite3 está compilado para Electron).
 */
import { abrirBase } from '../src/servidor/base'
import { aplicarSemillas } from '../src/main/semillas'
import { calificacionesEsquema, leerEsquema, guardarCaptura, proyeccionMateria, alertasFaltas } from '../src/main/calificacion'
import { calcularAlumno, type Componente, type DatosCalculo, type Esquema } from '../src/shared/esquema'
import { proyectarAlumno, asistenciaProyectada, alertaFaltas, type ContextoProyeccion } from '../src/shared/proyeccion'
import { limitesDe } from '../src/shared/asistencia'

let fallos = 0
const ok = (t: string, cond: boolean, extra = ''): void => {
  console.log(cond ? '  ✓' : '  ✗', t, cond ? '' : extra)
  if (!cond) fallos++
}

const db = abrirBase(':memory:')
const run = (sql: string, ...p: unknown[]): number => Number(db.prepare(sql).run(...p).lastInsertRowid)
const carrera = run("INSERT INTO carreras (nombre) VALUES ('IIA')")
const semestre = run("INSERT INTO periodos (nombre, fecha_inicio, semanas) VALUES ('Semestre', '2026-08-24', 16)")
const cuatri = run("INSERT INTO periodos (nombre, fecha_inicio, semanas) VALUES ('Cuatrimestre', '2026-08-31', 14)")
const ada = run("INSERT INTO materias (carrera_id, periodo_id, nombre) VALUES (?, ?, 'Análisis y Diseño de Algoritmos')", carrera, semestre)
const alg = run("INSERT INTO materias (carrera_id, periodo_id, nombre) VALUES (?, ?, 'Álgebra Lineal')", carrera, cuatri)
run("INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin) VALUES (?, 1, '11:00', '12:30'), (?, 4, '11:00', '12:30')", ada, ada)
run("INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin) VALUES (?, 6, '09:00', '10:00')", alg)

console.log('Semillas:')
aplicarSemillas(db)
aplicarSemillas(db)
const nRec = (db.prepare('SELECT COUNT(*) AS n FROM recordatorios').get() as { n: number }).n
ok(`fechas precargadas una sola vez (${nRec})`, nRec === 16)
ok('parcial 2 del semestre del 26 al 30 de octubre', !!db.prepare("SELECT 1 FROM recordatorios WHERE fecha='2026-10-26' AND fecha_fin='2026-10-30' AND tipo='parcial'").get())
db.prepare("DELETE FROM recordatorios WHERE clave='semestre-2026-1:actas'").run()
aplicarSemillas(db)
ok('una fecha borrada por el maestro no vuelve', !db.prepare("SELECT 1 FROM recordatorios WHERE clave='semestre-2026-1:actas'").get())
const eAda = leerEsquema(db, ada)!
const eAlg = leerEsquema(db, alg)!
ok('esquema de ADA: 3 parciales, pesos 30/20/12.5×4, mínima 7', eAda.parciales.length === 3 && eAda.parciales[0].componentes.map((c) => c.peso).join() === '30,20,12.5,12.5,12.5,12.5' && eAda.minima === 7)
ok('esquema de Álgebra: tareas 40, asistencia 15, participación 15, examen 30; mínima 6; asistencia 80 %', eAlg.parciales[0].componentes.map((c) => c.peso).join() === '40,15,15,30' && eAlg.minima === 6 && eAlg.asistencia_minima === 80 && eAlg.escala_100)

// ---------- ADA, parcial 1 ----------
console.log('ADA · parcial 1 (libro Calificaciones_Parcial1_ADA_5.xlsx):')
const alumno = (materia: number, apellidos: string, nombre: string): number => {
  const id = run('INSERT INTO alumnos (nombre, apellidos) VALUES (?, ?)', nombre, apellidos)
  run('INSERT INTO inscripciones (materia_id, alumno_id) VALUES (?, ?)', materia, id)
  return id
}
const sesion = (materia: number, fecha: string, ini: string, fin: string, estado = 'terminada'): number => run('INSERT INTO sesiones (materia_id, semana, numero, fecha, hora_inicio, hora_fin, estado) VALUES (?, 1, 1, ?, ?, ?, ?)', materia, fecha, ini, fin, estado)
const marcar = (s: number, a: number, estado: string): number => run('INSERT INTO asistencias (sesion_id, alumno_id, estado) VALUES (?, ?, ?)', s, a, estado)

const mireya = alumno(ada, 'Escobedo Mireles', 'Mireya Liliana')
const bustos = alumno(ada, 'Bustos Olvera', 'Rubén')
const cervantes = alumno(ada, 'Cervantes Landa', 'Gerardo')
const fechasAda = ['2026-09-03', '2026-09-04', '2026-09-07', '2026-09-10', '2026-09-14', '2026-09-17', '2026-09-21', '2026-09-24']
const sesAda = fechasAda.map((f) => sesion(ada, f, '11:00', '12:30'))
// Una sesión cancelada con registros no cuenta
const cancelada = sesion(ada, '2026-08-31', '11:00', '12:30', 'cancelada')
;[mireya, bustos, cervantes].forEach((a) => marcar(cancelada, a, 'ausente'))
sesAda.forEach((s, i) => {
  marcar(s, mireya, 'presente')
  marcar(s, bustos, i === 1 || i === 2 ? 'ausente' : 'presente') // 6 de 8, como en el libro
  marcar(s, cervantes, i === 0 ? 'justificado' : 'presente') // un justificado no es falta
})
const comps = eAda.parciales[0].componentes
const comp = (nombre: string): Componente => comps.find((c) => c.nombre === nombre)!
// Examen: aciertos de 26 reactivos; tareas sobre 10
for (const [a, aciertos, t1, t2] of [[mireya, 10, 6.2, 8], [bustos, 9, 1, 8], [cervantes, 19, 5.8, 8]]) {
  guardarCaptura(db, { componente_id: comp('Examen parcial').id, alumno_id: a, valor: aciertos })
  guardarCaptura(db, { componente_id: comp('Tarea 1').id, alumno_id: a, valor: t1 })
  guardarCaptura(db, { componente_id: comp('Tarea 2').id, alumno_id: a, valor: t2 })
}
// Seis actividades entregadas (diagnóstico, presentación, oral, sorpresa, tarea 1, tarea 2) y 5+ participaciones
for (let i = 0; i < 6; i++) {
  const ev = run("INSERT INTO evaluaciones (materia_id, tipo, titulo, fecha_aplicacion, puntos_totales) VALUES (?, 'tarea', ?, ?, 10)", ada, `Actividad ${i + 1}`, fechasAda[i])
  for (const a of [mireya, bustos, cervantes]) run("INSERT INTO resultados (evaluacion_id, alumno_id, estado) VALUES (?, ?, 'entregado')", ev, a)
}
for (const a of [mireya, bustos, cervantes]) for (let i = 0; i < 6; i++) run('INSERT INTO participaciones (materia_id, alumno_id, fecha) VALUES (?, ?, ?)', ada, a, fechasAda[i])

const cAda = calificacionesEsquema(db, ada)
const p1 = (a: number) => cAda.resultados.find((r) => r.alumno_id === a)!.parciales[0]
ok('Escobedo Mireles: 7.4 Aprobado', p1(mireya).calificacion === 7.4 && p1(mireya).estado === 'aprobado', JSON.stringify(p1(mireya)))
ok('Bustos Olvera (6 de 8 asistencias): 6.2 Reprobado', p1(bustos).calificacion === 6.2 && p1(bustos).estado === 'reprobado', JSON.stringify(p1(bustos)))
ok('Cervantes Landa (con un justificado): 8.4 Aprobado', p1(cervantes).calificacion === 8.4 && p1(cervantes).estado === 'aprobado', JSON.stringify(p1(cervantes)))
ok('el justificado y la sesión cancelada no cuentan como falta', p1(cervantes).asistencia === 100)
ok('parcial 1 completo (no provisional)', !p1(mireya).provisional && p1(mireya).evaluado === 100)
const p2 = cAda.resultados.find((r) => r.alumno_id === mireya)!.parciales[1]
ok('parcial 2 sin datos queda pendiente, no en cero', p2.calificacion === null && p2.estado === 'pendiente')

// Sin examen capturado: la calificación se reparte entre lo evaluado y se marca provisional
guardarCaptura(db, { componente_id: comp('Examen parcial').id, alumno_id: mireya, valor: null })
const sinExamen = calificacionesEsquema(db, ada).resultados.find((r) => r.alumno_id === mireya)!.parciales[0]
// (20·10 + 12.5·6.2 + 12.5·8 + 12.5·10 + 12.5·10) / 70 = 9.04
ok('sin examen: 9.0 provisional sobre 70 % evaluado', sinExamen.calificacion === 9 && sinExamen.provisional && sinExamen.evaluado === 70, JSON.stringify(sinExamen))
guardarCaptura(db, { componente_id: comp('Examen parcial').id, alumno_id: mireya, valor: 10, extra: 0.5 })
const conExtra = calificacionesEsquema(db, ada).resultados.find((r) => r.alumno_id === mireya)!.parciales[0]
ok('décimas extra en el examen: 3.85 + 0.5 → 4.35 × 30 % → 7.6', conExtra.calificacion === 7.6, JSON.stringify(conExtra.componentes[0]))

// ---------- Álgebra, parcial 1 ----------
console.log('Álgebra · parcial 1 (libro Calificaciones_Parcial_1_Algebra.xlsx):')
const sabados = ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10']
const sesAlg = sabados.map((f) => sesion(alg, f, '09:00', '10:00'))
const ca = eAlg.parciales[0].componentes
const [cTareas, , cPart, cExamen] = ca
type FilaLibro = [string, string, string, number, number, number, number, number | null] // apellidos, nombre, asistencia (x = asistió, / = falta), T1, entregó T1, T2, entregó T2, examen
const libro: (FilaLibro & { participacion?: number })[] = [
  ['Ernesto Arizmendi', 'Ramón Ignacio', 'xxxxxx', 10, 1, 10, 1, 58],
  ['Pacheco Saucedo', 'Octavio', '/xxxx/', 8, 1, 8, 1, 59],
  ['Bravo Ugalde', 'Martina Noemí', 'xxx/xx', 8, 1, 8, 1, 4],
  ['Tapia Alcantara', 'Araceli Graciela', 'xxxxxx', 8, 1, 8, 1, 14],
  ['Becerra Villegas', 'Beatriz Rocío', 'xx////', 8, 0, 8, 0, null]
]
const ids: number[] = []
for (const [ap, nom, asis, t1, e1, t2, e2, ex] of libro) {
  const a = alumno(alg, ap, nom)
  ids.push(a)
  sesAlg.forEach((s, i) => marcar(s, a, asis[i] === 'x' ? 'presente' : 'ausente'))
  guardarCaptura(db, { componente_id: cTareas.id, alumno_id: a, rubro: 0, valor: t1, entregado: e1 })
  guardarCaptura(db, { componente_id: cTareas.id, alumno_id: a, rubro: 1, valor: t2, entregado: e2 })
  guardarCaptura(db, { componente_id: cPart.id, alumno_id: a, valor: 15 })
  if (ex != null) guardarCaptura(db, { componente_id: cExamen.id, alumno_id: a, valor: ex })
}
const cAlg = calificacionesEsquema(db, alg)
const pa = (i: number) => cAlg.resultados.find((r) => r.alumno_id === ids[i])!.parciales[0]
ok('Ernesto Arizmendi: 70 + 17.4 = 87.4 → 8.7 Aprobado', pa(0).total100 === 87.4 && pa(0).calificacion === 8.7 && pa(0).estado === 'aprobado', JSON.stringify(pa(0)))
ok('Pacheco Saucedo: 74.7 → 7.5 pero 66.7 % de asistencia → NA por inasistencias', pa(1).total100 === 74.7 && pa(1).calificacion === 7.5 && pa(1).estado === 'na_inasistencia', JSON.stringify(pa(1)))
ok('Bravo Ugalde: 60.7 → 6.1 Aprobado (83 % de asistencia)', pa(2).total100 === 60.7 && pa(2).calificacion === 6.1 && pa(2).estado === 'aprobado', JSON.stringify(pa(2)))
ok('Tapia Alcántara: 66.2 → 6.6 Aprobado', pa(3).total100 === 66.2 && pa(3).calificacion === 6.6)
ok('Becerra Villegas: tareas «No» cuentan cero; NA por inasistencias', pa(4).componentes[0].valor === 0 && pa(4).estado === 'na_inasistencia')

// ---------- Proyección (cálculo puro) ----------
console.log('Proyección:')
const limites = limitesDe('semestral16', 3, 16)
const esquemaDos = (pesos: [number, number], asistenciaMinima: number | null = null): Esquema => ({
  materia_id: 1, minima: 7, asistencia_minima: asistenciaMinima, retardo_vale: 1, escala_100: false, nota: '',
  parciales: [
    { id: 1, materia_id: 1, orden: 1, nombre: 'Parcial 1', desde: '2026-09-01', hasta: '2026-09-30', peso: pesos[0], componentes: [{ id: 11, parcial_id: 1, orden: 1, nombre: 'Examen', peso: 100, fuente: 'manual', evaluaciones: [], escala: 10, rubros: [], meta: 5 }] },
    { id: 2, materia_id: 1, orden: 2, nombre: 'Parcial 2', desde: '2026-10-01', hasta: '2026-10-31', peso: pesos[1], componentes: [{ id: 21, parcial_id: 2, orden: 1, nombre: 'Examen', peso: 100, fuente: 'manual', evaluaciones: [], escala: 10, rubros: [], meta: 5 }] }
  ]
})
const datos = (examen1: number, asistencias: DatosCalculo['asistencias'] = []): DatosCalculo => ({ alumnos: [1], evaluaciones: [], resultados: [], entregas: [], asistencias, participaciones: [], capturas: [{ componente_id: 11, alumno_id: 1, rubro: 0, valor: examen1, entregado: null, extra: null }] })
const sesionesOct = Array.from({ length: 10 }, (_, i) => ({ fecha: `2026-10-${String(i * 3 + 1).padStart(2, '0')}`, horas: 1.5 }))
const ctx = (horas = 0): ContextoProyeccion => ({ hoy: '2026-10-15', sesiones: sesionesOct, limites, horas_falta: horas })
const proyectar = (e: Esquema, d: DatosCalculo, c = ctx()) => proyectarAlumno(e, calcularAlumno(e, d, 1), d, c)

const yaAprobado = proyectar(esquemaDos([3, 1]), datos(10))
ok('ya aprobado aunque saque 0 (parcial 1 vale 75 % y sacó 10)', yaAprobado.situacion === 'ya_aprobado' && yaAprobado.clasificacion === 'va_aprobando', JSON.stringify(yaAprobado))
const imposible = proyectar(esquemaDos([1, 1]), datos(2))
ok('ya no alcanza aunque saque 10 (2 en la mitad del curso)', imposible.situacion === 'imposible' && imposible.clasificacion === 'reprobaria' && imposible.necesita === 12)
const alcanzable = proyectar(esquemaDos([1, 1]), datos(6))
ok('con 6 necesita 8 en lo que falta y reprobaría al ritmo actual', alcanzable.situacion === 'alcanzable' && alcanzable.necesita === 8 && alcanzable.clasificacion === 'reprobaria')
const bien = proyectar(esquemaDos([1, 1]), datos(9.5))
ok('con 9.5 va aprobando (necesita 4.5)', bien.clasificacion === 'va_aprobando' && bien.necesita === 4.5)

// Regla del esquema (80 %): es de calificación; en un parcial en curso solo es NA si ya es imposible llegar
const e80 = esquemaDos([1, 1], 80)
const conAsis = (presentes: number, faltas: number, hoy: string): DatosCalculo => ({
  ...datos(9.5, sesionesOct.slice(0, presentes + faltas).map((x, i) => ({ alumno_id: 1, fecha: x.fecha, estado: i < faltas ? 'ausente' : 'presente' }))),
  hoy,
  sesiones: sesionesOct.slice(0, 6) // parcial 2 con 6 sesiones programadas
})
const enCurso = (presentes: number, faltas: number) => calcularAlumno(e80, conAsis(presentes, faltas, '2026-10-10'), 1).parciales[1]
ok('parcial en curso, 1 falta de 3 sesiones (aún puede llegar a 5 de 6): no es NA', enCurso(2, 1).estado !== 'na_inasistencia', JSON.stringify(enCurso(2, 1)))
ok('parcial en curso, 2 faltas de 3: ya es imposible llegar al 80 % → NA', enCurso(1, 2).estado === 'na_inasistencia')
const cerrado = calcularAlumno(e80, conAsis(4, 2, '2026-11-15'), 1).parciales[1]
ok('parcial terminado con 4 de 6 → NA por inasistencias', cerrado.estado === 'na_inasistencia')
const futuro = calcularAlumno(e80, conAsis(0, 0, '2026-09-10'), 1).parciales[1]
ok('un parcial que no ha empezado nunca queda NA', futuro.estado === 'pendiente')

// Situación oficial por faltas (COM-AS-01): horas en todo el curso
const sabatino = limitesDe('sabatino14', 1, 14) // límite 3 h, extraordinario 4, título 5, recursa 6
const sesiones1h = Array.from({ length: 14 }, (_, i) => ({ fecha: `2026-09-${String(i + 1).padStart(2, '0')}`, horas: 1 }))
const nivelAlg = (h: number) => alertaFaltas(asistenciaProyectada(e80, 1, { asistencias: [] }, { hoy: '2026-10-25', sesiones: sesiones1h, limites: sabatino, horas_falta: h }))
ok('Álgebra (1 h por semana): límite 3, extraordinario 4, título 5, recursa 6', sabatino.limite === 3 && sabatino.extraordinario === 4 && sabatino.titulo_suficiencia === 5 && sabatino.recursa === 6)
ok('0 h de falta: sin aviso', nivelAlg(0).nivel === null)
ok('1 h: sin aviso (le quedan 2 h para el límite)', nivelAlg(1).nivel === null)
ok('2 h: pasa a Alerta con esa falta (1 h para el límite)', nivelAlg(2).nivel === 'alerta', nivelAlg(2).texto)
ok('3 h: En el límite, «con 1 h más va a extraordinario»', nivelAlg(3).nivel === 'atencion' && nivelAlg(3).texto.includes('con 1 h más va a extraordinario'), nivelAlg(3).texto)
ok('4 h: Extraordinario · 5 h: Título de suficiencia · 6 h: Recursa', nivelAlg(4).nivel === 'extraordinario' && nivelAlg(5).nivel === 'titulo' && nivelAlg(6).nivel === 'recursa')
const nivelAda = (h: number) => alertaFaltas(asistenciaProyectada(null, 1, { asistencias: [] }, ctx(h))).nivel
ok('ADA (3 h por semana, sesiones de 1.5 h): 7.5 h sin aviso, 9 h Alerta, 10.5 h En el límite, 12 h Título', limites.limite === 10 && nivelAda(7.5) === null && nivelAda(9) === 'alerta' && nivelAda(10.5) === 'atencion' && nivelAda(12) === 'titulo')

const enRiesgoFaltas = proyectar(esquemaDos([1, 1]), datos(9.5), ctx(9))
ok('buena calificación pero con Alerta por faltas → En riesgo', enRiesgoFaltas.clasificacion === 'en_riesgo', JSON.stringify(enRiesgoFaltas.motivos))
const naProy = proyectarAlumno(e80, calcularAlumno(e80, conAsis(4, 2, '2026-11-15'), 1), conAsis(4, 2, '2026-11-15'), { ...ctx(), hoy: '2026-11-15' })
ok('con un parcial NA por inasistencias → clasificación NA por inasistencias', naProy.clasificacion === 'na_inasistencias')

// ---------- Avisos por faltas y resumen sobre la base ----------
console.log('Avisos por faltas y resumen de la materia:')
const alertas = alertasFaltas(db, alg, '2026-10-12')
const nivelDe = (i: number): string | undefined => alertas.find((a) => a.alumno_id === ids[i])?.nivel
ok('Álgebra (sesiones de 1 h): Becerra 4 h → Extraordinario; Pacheco 2 h → Alerta', nivelDe(4) === 'extraordinario' && nivelDe(1) === 'alerta', JSON.stringify(alertas.map((a) => [a.alumno, a.nivel, a.horas_falta])))
ok('Ernesto (0 faltas) y Bravo Ugalde (1 h) sin aviso', nivelDe(0) === undefined && nivelDe(2) === undefined)
// Justificar una falta: deja de contar en horas (comunicado) y en el 80 % del parcial
db.prepare("UPDATE asistencias SET estado='justificado', nota='Justificante médico' WHERE alumno_id=? AND sesion_id=?").run(ids[1], sesAlg[0])
const navaJ = alertasFaltas(db, alg, '2026-10-12').find((a) => a.alumno_id === ids[1])
const navaP1 = calificacionesEsquema(db, alg, '2026-10-12').resultados.find((r) => r.alumno_id === ids[1])!.parciales[0]
ok('Pacheco con una falta justificada: 1 h, sale de la lista de riesgo y su parcial 1 ya no es NA (5 de 6)', !navaJ && navaP1.estado !== 'na_inasistencia' && Math.round(navaP1.asistencia!) === 83, JSON.stringify(navaP1))
db.prepare("UPDATE asistencias SET estado='ausente' WHERE alumno_id=? AND sesion_id=?").run(ids[1], sesAlg[0])
const resumen = proyeccionMateria(db, alg, '2026-10-12')!
ok('resumen serializable con esquema, supuestos, conteo y alumnos', !!resumen && resumen.alumnos.length === 5 && resumen.supuestos.length > 0 && JSON.parse(JSON.stringify(resumen)).alumnos[0].parciales.length === 3)

// ---------- Tareas de Classroom: todas las del parcial, no solo dos ----------
const eCr: Esquema = {
  materia_id: 9, minima: 7, asistencia_minima: null, retardo_vale: 1, escala_100: false, nota: '',
  parciales: [{ id: 9, materia_id: 9, orden: 2, nombre: 'Parcial 2', desde: '2026-09-26', hasta: '2026-10-30', peso: 1, componentes: [
    { id: 91, parcial_id: 9, orden: 1, nombre: 'Tareas de Classroom', peso: 25, fuente: 'classroom_promedio', evaluaciones: [], escala: 10, rubros: [], meta: 5 },
    { id: 92, parcial_id: 9, orden: 2, nombre: 'Trabajos entregados (Classroom)', peso: 12.5, fuente: 'classroom_entregas', evaluaciones: [], escala: 10, rubros: [], meta: 5 }
  ] }]
}
const fila = (tarea: string, fecha: string, estado: string, calificacion: number | null, puntos = 10) => ({ tarea, nombre: tarea, fecha, alumno_id: 1, estado, calificacion, puntos })
const dCr: DatosCalculo = {
  // En curso (20-oct): lo pendiente aún no cuenta
  hoy: '2026-10-20', alumnos: [1], evaluaciones: [], resultados: [], entregas: [], asistencias: [], participaciones: [], capturas: [],
  classroom: [
    fila('T3', '2026-10-01', 'entrego', 9), fila('T4', '2026-10-05', 'tarde', 8), fila('T5', '2026-10-08', 'entrego', 10, 20),
    fila('T6', '2026-10-12', 'no_entrego', null), fila('T7', '2026-10-15', 'entrego', null), fila('T8', '2026-10-29', 'pendiente', null),
    fila('T1', '2026-09-20', 'entrego', 2) // es del parcial 1: no cuenta
  ]
}
const cr = calcularAlumno(eCr, dCr, 1).parciales[0].componentes
const prom = cr.find((c) => c.componente_id === 91)!, ent = cr.find((c) => c.componente_id === 92)!
// Promedio: 9/10, 8/10 (tarde cuenta), 10/20, 0 (no entregó) → (0.9+0.8+0.5+0)/4 = 5.5; T7 sin calificar y T8 pendiente no cuentan; T1 es de otro parcial
ok(`Classroom promedio con 6 tareas del parcial: ${prom.valor} (${prom.detalle})`, prom.valor === 5.5 && /4 de 6 tareas/.test(prom.detalle) && /1 sin calificar/.test(prom.detalle))
// Entregadas: de las vencidas (T3, T4, T5, T6, T7) entregó 4 → 8.0
ok(`Classroom entregadas: ${ent.valor} (${ent.detalle})`, ent.valor === 8 && /entregó 4 de 5/.test(ent.detalle))
const sinCr = calcularAlumno(eCr, { ...dCr, classroom: [] }, 1).parciales[0].componentes[0]
ok('sin Classroom ligado el componente queda pendiente (no cero)', sinCr.valor === null)

// Al cerrar el parcial, lo que siga pendiente o retirado cuenta como no entregado
const crCerrado = calcularAlumno(eCr, { ...dCr, hoy: '2026-11-02', classroom: [...dCr.classroom!, fila('T9', '2026-10-20', 'retirada', null)] }, 1).parciales[0].componentes
const promC = crCerrado.find((c) => c.componente_id === 91)!, entC = crCerrado.find((c) => c.componente_id === 92)!
ok(`parcial cerrado: pendiente y retirada cuentan 0 → promedio ${promC.valor}`, promC.valor === 3.67 || Math.round(promC.valor! * 100) / 100 === 3.67, promC.detalle)
ok(`parcial cerrado: entregó 4 de 7 → ${Math.round(entC.valor! * 100) / 100}`, /entregó 4 de 7/.test(entC.detalle), entC.detalle)
const abierto = calcularAlumno(eCr, { ...dCr, classroom: [...dCr.classroom!, fila('T9', '2026-10-20', 'retirada', null)] }, 1).parciales[0].componentes
ok('parcial en curso: la retirada todavía no cuenta', abierto.find((c) => c.componente_id === 92)!.detalle === 'entregó 4 de 5')
// Sin conexión o sin ligar: no hay de dónde leer y el parcial no dice si aprueba
const sinCon = calcularAlumno(eCr, { ...dCr, classroom: [], classroomConectado: false }, 1).parciales[0]
ok('Classroom sin conectar: componente sin fuente y parcial «Pendiente»', sinCon.componentes[0].sin_fuente === true && /no conectado/.test(sinCon.componentes[0].detalle) && sinCon.estado === 'pendiente')
const sinLig = calcularAlumno(eCr, { ...dCr, classroomConectado: true, classroomLigados: [2] }, 1).parciales[0].componentes[0]
ok('alumno sin ligar: no se le cuentan tareas y se dice por qué', sinLig.valor === null && sinLig.sin_fuente === true && /sin ligar/.test(sinLig.detalle), sinLig.detalle)
// Lo capturado a mano manda sobre Classroom (y admite décimas extra)
const aMano = calcularAlumno(eCr, { ...dCr, classroomConectado: false, capturas: [{ componente_id: 91, alumno_id: 1, rubro: 0, valor: 8, entregado: null, extra: 0.5 }] }, 1).parciales[0].componentes[0]
ok(`captura a mano en un componente de Classroom: ${aMano.valor} (${aMano.detalle})`, aMano.valor === 8.5 && /a mano/.test(aMano.detalle) && !aMano.sin_fuente)

// «Entregó: sí» a mano sin calificación: en trabajos entregados vale 10; en el promedio queda pendiente sin bloquear
const siEnt = calcularAlumno(eCr, { ...dCr, classroomConectado: false, capturas: [{ componente_id: 92, alumno_id: 1, rubro: 0, valor: null, entregado: 1, extra: null }] }, 1).parciales[0].componentes
ok('«Entregó: sí» a mano en «Trabajos entregados» vale 10', siEnt.find((c) => c.componente_id === 92)!.valor === 10, JSON.stringify(siEnt))
const siProm = calcularAlumno(eCr, { ...dCr, classroomConectado: false, capturas: [{ componente_id: 91, alumno_id: 1, rubro: 0, valor: null, entregado: 1, extra: null }] }, 1).parciales[0].componentes[0]
ok('«Entregó: sí» a mano en el promedio queda pendiente (falta la nota) y ya no dice «no conectado»', siProm.valor === null && !siProm.sin_fuente && /falta capturar/.test(siProm.detalle), JSON.stringify(siProm))

// Guardar solo el campo que cambió: dos capturas seguidas del mismo alumno no se pisan
guardarCaptura(db, { componente_id: cExamen.id, alumno_id: ids[0], valor: 50 })
guardarCaptura(db, { componente_id: cExamen.id, alumno_id: ids[0], entregado: 1 })
const capt = db.prepare('SELECT valor, entregado FROM calif_capturas WHERE componente_id=? AND alumno_id=? AND rubro=0').get(cExamen.id, ids[0]) as { valor: number; entregado: number }
ok('capturar «entregó» después de la calificación conserva la calificación', capt.valor === 50 && capt.entregado === 1, JSON.stringify(capt))

// Examen contestado en el portal: su calificación llega al rubro ligado sin capturarla; lo capturado en la app manda
const evPortal = run("INSERT INTO evaluaciones (materia_id, tipo, titulo, fecha_aplicacion, puntos_totales) VALUES (?, 'examen', 'Examen en el portal', ?, 24)", ada, fechasAda[0])
const asig = run("INSERT INTO asignaciones (evaluacion_id, materia_id, titulo, abre) VALUES (?, ?, 'Examen en el portal', datetime('now'))", evPortal, ada)
run("INSERT INTO intentos (asignacion_id, alumno_id, estado, puntaje) VALUES (?, ?, 'calificado', 18)", asig, mireya)
run("INSERT INTO intentos (asignacion_id, alumno_id, estado) VALUES (?, ?, 'enviado')", asig, bustos)
run("INSERT INTO intentos (asignacion_id, alumno_id, estado, puntaje) VALUES (?, ?, 'calificado', 12)", asig, cervantes)
run("INSERT INTO resultados (evaluacion_id, alumno_id, puntaje, estado) VALUES (?, ?, 20, 'calificado')", evPortal, cervantes)
db.prepare("UPDATE calif_componentes SET fuente='evaluaciones', evaluaciones=? WHERE id=?").run(JSON.stringify([evPortal]), comp('Examen parcial').id)
db.prepare('DELETE FROM calif_capturas WHERE componente_id=?').run(comp('Examen parcial').id)
const exPortal = (a: number) => calificacionesEsquema(db, ada).resultados.find((r) => r.alumno_id === a)!.parciales[0].componentes.find((c) => c.componente_id === comp('Examen parcial').id)!
ok('examen calificado en el portal: 18 de 24 → 7.5', exPortal(mireya).valor === 7.5, JSON.stringify(exPortal(mireya)))
ok('enviado sin calificar en el portal queda pendiente', exPortal(bustos).valor === null, JSON.stringify(exPortal(bustos)))
ok('la calificación capturada en la app manda sobre la del portal', exPortal(cervantes).valor === (20 / 24) * 10, JSON.stringify(exPortal(cervantes)))

db.close()
if (fallos) {
  console.log(`${fallos} fallo(s) en la calificación por esquema`)
  process.exitCode = 1
} else console.log('Calificación por esquema, proyección y avisos: todo cuadra.')
