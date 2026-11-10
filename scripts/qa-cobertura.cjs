/**
 * ¿El contenido cargado cubre el temario oficial y alcanza para dar y evaluar el curso?
 * Compara los temas numerados del temario contra lo que aparece en las sesiones, y
 * revisa cuántas evaluaciones tienen reactivos de verdad y no solo su ficha.
 */
const Database = require('better-sqlite3')
const { join } = require('path')
const db = new Database(join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite'), { readonly: true })

const sinAcentos = (t) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

for (const m of db.prepare('SELECT * FROM materias ORDER BY nombre').all()) {
  console.log(`\n${'='.repeat(70)}\n${m.nombre} (${m.clave})\n${'='.repeat(70)}`)

  // ---------- 1. Cobertura del temario ----------
  // Se toman los códigos numerados del temario (1.1, 2.3.4…) y se buscan en las sesiones.
  const codigos = new Set()
  for (const linea of m.temario.split('\n')) {
    for (const c of linea.matchAll(/(?:^|[\s·(])(\d+\.\d+(?:\.\d+)*)/g)) codigos.add(c[1])
  }
  const sesiones = db.prepare('SELECT numero, tema, objetivo, estado FROM sesiones WHERE materia_id=? ORDER BY numero').all(m.id)
  const textoSesiones = sesiones.map((s) => `${s.tema} ${s.objetivo}`).join(' ')
  const cubiertos = [...codigos].filter((c) => textoSesiones.includes(c))
  const huecos = [...codigos].filter((c) => !textoSesiones.includes(c))
  const pct = codigos.size ? Math.round((cubiertos.length / codigos.size) * 100) : 0
  console.log(`\nTEMARIO: ${cubiertos.length} de ${codigos.size} temas numerados aparecen en alguna sesión (${pct} %)`)
  if (huecos.length) console.log(`  sin sesión asignada: ${huecos.sort().join(', ')}`)

  // Unidades del temario contra unidades mencionadas
  const unidades = (m.temario.match(/^##\s+(Unidad[^\n]*)/gm) || []).map((u) => u.replace(/^##\s+/, ''))
  console.log(`  unidades del programa: ${unidades.length}`)

  // ---------- 2. Sesiones ----------
  const activas = sesiones.filter((s) => s.estado !== 'cancelada')
  const conActividades = db.prepare('SELECT COUNT(DISTINCT s.id) n FROM sesiones s JOIN actividades a ON a.sesion_id=s.id WHERE s.materia_id=?').get(m.id).n
  const conPresentacion = db.prepare('SELECT COUNT(*) n FROM sesiones WHERE materia_id=? AND presentacion_path IS NOT NULL').get(m.id).n
  console.log(`\nSESIONES: ${activas.length} activas · ${conActividades} con secuencia cronometrada · ${conPresentacion} con presentación`)

  // ---------- 3. Evaluaciones: ficha contra contenido real ----------
  const evs = db.prepare('SELECT id, titulo, tipo, contenido, puntos_totales FROM evaluaciones WHERE materia_id=? ORDER BY fecha_aplicacion, id').all(m.id)
  let conReactivos = 0
  let soloFicha = 0
  const pendientes = []
  for (const e of evs) {
    let reactivos = 0
    if (e.contenido.trim().startsWith('{')) {
      try {
        const c = JSON.parse(e.contenido)
        reactivos = Array.isArray(c.preguntas) ? c.preguntas.length : 0
      } catch { /* contenido no válido */ }
    }
    if (reactivos > 0) conReactivos++
    else {
      soloFicha++
      pendientes.push(`${e.titulo} (${e.puntos_totales}%)`)
    }
  }
  const puntosSinContenido = evs
    .filter((e) => !e.contenido.trim().startsWith('{'))
    .reduce((s, e) => s + e.puntos_totales, 0)
  console.log(`\nEVALUACIONES: ${evs.length} en total · ${conReactivos} con reactivos escritos · ${soloFicha} solo con la ficha`)
  console.log(`  puntos de la calificación que aún no tienen contenido: ${Math.round(puntosSinContenido)} de 100`)
  if (pendientes.length) {
    console.log('  faltan por redactar:')
    pendientes.slice(0, 8).forEach((p) => console.log(`    · ${p}`))
    if (pendientes.length > 8) console.log(`    · … y ${pendientes.length - 8} más`)
  }

  // ---------- 4. Apoyo al estudio ----------
  const glosario = db.prepare('SELECT COUNT(*) n FROM glosario WHERE materia_id=?').get(m.id).n
  const materiales = db.prepare('SELECT tipo, COUNT(*) n FROM materiales WHERE materia_id=? GROUP BY tipo').all(m.id)
  const conTexto = db.prepare("SELECT COUNT(*) n FROM materiales WHERE materia_id=? AND length(texto)>200").get(m.id).n
  console.log(`\nAPOYO: ${glosario} términos de glosario · ${materiales.map((x) => `${x.n} ${x.tipo}`).join(', ')} · ${conTexto} materiales con texto para la IA`)
  const porTermino = codigos.size ? (glosario / codigos.size).toFixed(1) : '0'
  console.log(`  términos por tema del programa: ${porTermino}`)

  // ---------- 5. Lo que no existe todavía ----------
  const faltantes = []
  if (soloFicha > 0) faltantes.push(`${soloFicha} evaluaciones sin reactivos (${Math.round(puntosSinContenido)} % de la calificación)`)
  if (glosario < codigos.size) faltantes.push(`glosario corto: ${glosario} términos para ${codigos.size} temas`)
  const tiposIA = db.prepare("SELECT COUNT(*) n FROM evaluaciones WHERE materia_id=? AND tipo IN ('ejemplos','material_apoyo')").get(m.id).n
  if (!tiposIA) faltantes.push('sin ejemplos resueltos ni material de apoyo generados')
  const alumnos = db.prepare('SELECT COUNT(*) n FROM inscripciones WHERE materia_id=?').get(m.id).n
  if (!alumnos) faltantes.push('sin alumnos inscritos')
  console.log(`\nFALTA:`)
  faltantes.forEach((f) => console.log(`  · ${f}`))
}
db.close()
