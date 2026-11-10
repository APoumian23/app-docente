/** Revisión de integridad de los datos cargados. No modifica nada. */
const Database = require('better-sqlite3')
const { existsSync } = require('fs')
const { join } = require('path')
const db = new Database(join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite'), { readonly: true })
const problemas = []
const aviso = (t) => problemas.push(t)
const ok = (t) => console.log('  ✓', t)

console.log('DATOS GENERALES')
const materias = db.prepare('SELECT m.*, p.nombre AS periodo, p.semanas, p.fecha_inicio FROM materias m JOIN periodos p ON p.id=m.periodo_id').all()
console.log(`  ${materias.length} materias · ${db.prepare('SELECT COUNT(*) n FROM sesiones').get().n} sesiones · ${db.prepare('SELECT COUNT(*) n FROM actividades').get().n} actividades · ${db.prepare('SELECT COUNT(*) n FROM materiales').get().n} materiales`)

for (const m of materias) {
  console.log(`\n${m.nombre} (${m.clave}) · ${m.periodo}`)
  // horarios
  const hs = db.prepare('SELECT * FROM horarios WHERE materia_id=?').all(m.id)
  if (!hs.length) aviso(`${m.nombre}: sin horario`)
  else ok(`${hs.length} bloque(s) de horario`)

  // sesiones
  const ses = db.prepare('SELECT * FROM sesiones WHERE materia_id=? ORDER BY fecha').all(m.id)
  const activas = ses.filter((s) => s.estado !== 'cancelada')
  const sinTema = activas.filter((s) => !s.tema.trim())
  const sinObjetivo = activas.filter((s) => !s.objetivo.trim())
  const sinAct = activas.filter((s) => db.prepare('SELECT COUNT(*) n FROM actividades WHERE sesion_id=?').get(s.id).n === 0)
  if (sinTema.length) aviso(`${m.nombre}: ${sinTema.length} sesiones sin tema`)
  if (sinObjetivo.length) aviso(`${m.nombre}: ${sinObjetivo.length} sesiones sin objetivo`)
  if (sinAct.length) aviso(`${m.nombre}: ${sinAct.length} sesiones sin actividades`)
  if (!sinTema.length && !sinObjetivo.length && !sinAct.length) ok(`${activas.length} sesiones activas, todas con tema, objetivo y actividades`)

  // duración de actividades contra la duración de la sesión
  const desfase = []
  for (const s of activas) {
    const [h1, m1] = s.hora_inicio.split(':').map(Number)
    const [h2, m2] = s.hora_fin.split(':').map(Number)
    const dur = h2 * 60 + m2 - (h1 * 60 + m1)
    const suma = db.prepare('SELECT COALESCE(SUM(duracion_min),0) t FROM actividades WHERE sesion_id=?').get(s.id).t
    if (suma !== dur) desfase.push(`#${s.numero} ${suma}≠${dur}`)
  }
  if (desfase.length) aviso(`${m.nombre}: ${desfase.length} sesiones cuya suma de actividades no cuadra (${desfase.slice(0, 3).join(', ')})`)
  else ok('la suma de actividades cuadra con la duración en todas las sesiones')

  // fechas dentro del periodo
  const fuera = ses.filter((s) => s.fecha < m.fecha_inicio)
  if (fuera.length) aviso(`${m.nombre}: ${fuera.length} sesiones antes del inicio del periodo`)

  // evaluaciones
  const evs = db.prepare('SELECT * FROM evaluaciones WHERE materia_id=?').all(m.id)
  const suma = evs.reduce((s, e) => s + e.puntos_totales, 0)
  if (Math.abs(suma - 100) > 0.5) aviso(`${m.nombre}: las ponderaciones suman ${suma}, no 100`)
  else ok(`${evs.length} evaluaciones que suman ${Math.round(suma)}%`)
  const sinFecha = evs.filter((e) => !e.fecha_aplicacion)
  if (sinFecha.length) aviso(`${m.nombre}: ${sinFecha.length} evaluaciones sin fecha`)

  // materiales
  const mats = db.prepare('SELECT * FROM materiales WHERE materia_id=?').all(m.id)
  const faltantes = mats.filter((x) => !x.ruta.startsWith('http') && !existsSync(x.ruta))
  const sinTexto = mats.filter((x) => !x.ruta.startsWith('http') && x.tipo !== 'pptx' && x.texto.length < 50)
  if (faltantes.length) aviso(`${m.nombre}: ${faltantes.length} materiales cuyo archivo no existe`)
  if (sinTexto.length) aviso(`${m.nombre}: ${sinTexto.length} materiales sin texto para la IA (${sinTexto.map((x) => x.titulo.slice(0, 30)).join(' / ')})`)
  if (!faltantes.length && !sinTexto.length) ok(`${mats.length} materiales, todos con archivo y con texto donde toca`)

  // presentaciones proyectables
  const pres = [m.presentacion_path, ...db.prepare('SELECT presentacion_path p FROM sesiones WHERE materia_id=? AND presentacion_path IS NOT NULL').all(m.id).map((x) => x.p)].filter(Boolean)
  const noProyectables = pres.filter((r) => !existsSync(r.replace(/\.[^.]+$/, '') + '.pdf') && !r.toLowerCase().endsWith('.pdf'))
  if (noProyectables.length) aviso(`${m.nombre}: ${noProyectables.length} presentaciones sin PDF`)
  else if (pres.length) ok(`${pres.length} presentaciones, todas proyectables`)

  // alumnos
  const al = db.prepare('SELECT COUNT(*) n FROM inscripciones WHERE materia_id=?').get(m.id).n
  if (!al) aviso(`${m.nombre}: sin alumnos inscritos`)
}

// huérfanos
const huerfanos = [
  ['actividades sin sesión', 'SELECT COUNT(*) n FROM actividades a LEFT JOIN sesiones s ON s.id=a.sesion_id WHERE s.id IS NULL'],
  ['asistencias sin sesión', 'SELECT COUNT(*) n FROM asistencias a LEFT JOIN sesiones s ON s.id=a.sesion_id WHERE s.id IS NULL'],
  ['resultados sin evaluación', 'SELECT COUNT(*) n FROM resultados r LEFT JOIN evaluaciones e ON e.id=r.evaluacion_id WHERE e.id IS NULL'],
  ['inscripciones sin alumno', 'SELECT COUNT(*) n FROM inscripciones i LEFT JOIN alumnos a ON a.id=i.alumno_id WHERE a.id IS NULL']
]
console.log('\nINTEGRIDAD REFERENCIAL')
for (const [t, q] of huerfanos) {
  const n = db.prepare(q).get().n
  if (n) aviso(`${n} ${t}`)
}
if (!problemas.some((p) => /sin sesión|sin evaluación|sin alumno/.test(p))) ok('sin registros huérfanos')

console.log('\n' + (problemas.length ? `PENDIENTES (${problemas.length}):` : 'Sin problemas.'))
problemas.forEach((p) => console.log('  •', p))
db.close()
