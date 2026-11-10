/**
 * Freno de borrados de la sincronización, sobre una base en memoria (nunca la real).
 * Un lote que borra más de la mitad de una tabla se detiene, salvo en avisos y eventos de vigilancia, que se
 * vacían en bloque al eliminar una publicación. Entregas y publicaciones conservan el freno.
 * Se corre desde qa.sh con Electron como Node (better-sqlite3 está compilado para Electron).
 */
import { abrirBase } from '../src/servidor/base'
import { aplicarCambios, type Cambio } from '../src/servidor/cambios'

let fallos = 0
const ok = (t: string, cond: boolean, extra = ''): void => {
  console.log(cond ? '  ✓' : '  ✗', t, cond ? '' : extra)
  if (!cond) fallos++
}

const db = abrirBase(':memory:')
db.pragma('foreign_keys = OFF')
for (let i = 1; i <= 10; i++) {
  db.prepare("INSERT INTO notificaciones (id, usuario_id, tipo, titulo) VALUES (?, 1, 'aviso', 'Aviso')").run(i)
  db.prepare('INSERT INTO intentos (id, asignacion_id, alumno_id) VALUES (?, 1, ?)').run(i, i)
}
const borrar = (tabla: string, n: number): Cambio[] => Array.from({ length: n }, (_, i) => ({ tabla, pk: [i + 1], op: 'd' as const, en: Date.now() }))
const cuenta = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
const intentar = (cambios: Cambio[], forzar = false): string | null => {
  try {
    aplicarCambios(db, cambios, 'otro-lado', forzar ? { maxBorrados: Infinity } : {})
    return null
  } catch (e) {
    return (e as Error).message
  }
}

console.log('Freno de borrados:')
ok('8 de 10 avisos se borran sin frenar (al eliminar una publicación)', intentar(borrar('notificaciones', 8)) === null && cuenta('notificaciones') === 2)
const e = intentar(borrar('intentos', 8))
ok('8 de 10 entregas se detienen y piden confirmar', !!e && /Se detuvo para no perder datos/.test(e) && cuenta('intentos') === 10, String(e))
ok('5 entregas o menos pasan (no es un borrado masivo)', intentar(borrar('intentos', 5)) === null && cuenta('intentos') === 5)
// aplicarCambios deja las llaves foráneas encendidas al terminar
db.pragma('foreign_keys = OFF')
for (let i = 1; i <= 5; i++) db.prepare('INSERT INTO intentos (id, asignacion_id, alumno_id) VALUES (?, 1, ?)').run(i, i)
ok('«Aplicar de todos modos» sí las borra', intentar(borrar('intentos', 8), true) === null && cuenta('intentos') === 2)

console.log(fallos ? `\n${fallos} comprobación(es) fallaron` : '\nSin fallos')
process.exit(fallos ? 1 : 0)
