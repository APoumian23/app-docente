/**
 * Calificación automática: casos que antes se calificaban mal y una revisión de todas las
 * evaluaciones guardadas (solo lectura) para que cada opción múltiple acepte una sola opción.
 * Se corre desde qa.sh con Electron como Node (better-sqlite3 está compilado para Electron).
 */
import Database from 'better-sqlite3'
import { join } from 'path'
import { coincideOpcion, indiceCorrecto, calificarAutomatico, leerContenido } from '../src/servidor/calificar'
import type { Pregunta } from '../src/shared/types'

let fallos = 0
const ok = (t: string, cond: boolean): void => {
  console.log(cond ? '  ✓' : '  ✗', t)
  if (!cond) fallos++
}
const om = (respuesta: string, opciones: string[]): Pregunta => ({ tipo: 'opcion_multiple', enunciado: '', respuesta, opciones, puntos: 1, explicacion: '' })
/** Opciones que la calificación acepta como correctas. */
const aceptadas = (p: Pregunta): string[] => (p.opciones ?? []).filter((o) => coincideOpcion(p, o))

console.log('Casos conocidos:')
ok('«O(n)» no cuenta cuando la clave es «O(n^2)»', aceptadas(om('O(n^2)', ['O(n)', 'O(n^2)', 'O(log n)'])).join() === 'O(n^2)')
ok('«O(g(n))» y «o(g(n))» son distintas', aceptadas(om('o(g(n))', ['O(g(n))', 'Ω(g(n))', 'θ(g(n))', 'o(g(n))'])).join() === 'o(g(n))')
ok('Θ y θ son distintas', aceptadas(om('Θ(n)', ['θ(n)', 'Θ(n)'])).join() === 'Θ(n)')
ok('«1» no cuenta cuando la clave es «10»', aceptadas(om('10', ['1', '10', '100'])).join() === '10')
ok('clave con delimitadores de LaTeX ($…$)', aceptadas(om('$x^2$', ['x', 'x^2'])).join() === 'x^2')
ok('clave por letra («c»)', aceptadas(om('c', ['uno', 'dos', 'tres'])).join() === 'tres')
ok('clave con letra y texto («b) dos»)', aceptadas(om('b) dos', ['uno', 'dos', 'tres'])).join() === 'dos')
ok('mayúsculas distintas sin otra opción parecida', aceptadas(om('verdad absoluta', ['Verdad absoluta', 'Mentira'])).join() === 'Verdad absoluta')
ok('clave que no señala ninguna opción → revisión manual', indiceCorrecto(om('ninguna', ['a1', 'b2'])) === -1)
ok('respuesta vacía no cuenta', !coincideOpcion(om('dos', ['uno', 'dos']), ''))
const vf: Pregunta = { tipo: 'verdadero_falso', enunciado: '', respuesta: 'Falso', puntos: 1, explicacion: '' }
ok('verdadero/falso sigue funcionando', coincideOpcion(vf, 'Falso') && !coincideOpcion(vf, 'Verdadero'))
const cal = calificarAutomatico({ titulo: '', instrucciones: '', duracion_min: 0, preguntas: [om('O(n^2)', ['O(n)', 'O(n^2)']), om('ninguna', ['a1', 'b2'])] }, { '0': 'O(n)', '1': 'a1' })
ok('una clave ambigua pasa a revisión del docente', cal.puntaje_auto === 0 && cal.pendiente_manual && cal.detalle[1].automatica === false)

console.log('Evaluaciones guardadas:')
const db = new Database(join(process.env.HOME ?? '', 'Library/Application Support/app-docente/datos/docente.sqlite'), { readonly: true })
let total = 0
const malas: string[] = []
for (const ev of db.prepare("SELECT id, titulo, contenido FROM evaluaciones WHERE contenido LIKE '{%'").all() as { id: number; titulo: string; contenido: string }[]) {
  const c = leerContenido(ev.contenido)
  c?.preguntas.forEach((p, i) => {
    if (p.tipo !== 'opcion_multiple') return
    total++
    const n = aceptadas(p).length
    if (n !== 1) malas.push(`«${ev.titulo}» (id ${ev.id}) pregunta ${i + 1}: ${n === 0 ? 'clave sin opción clara, irá a revisión manual' : `acepta ${n} opciones`}`)
  })
}
ok(`${total} preguntas de opción múltiple aceptan exactamente una opción`, malas.every((m) => m.includes('revisión manual')))
for (const m of malas) console.log('    ·', m)
db.close()

if (fallos) {
  console.log(`${fallos} fallo(s) en la calificación`)
  process.exitCode = 1
}
