/**
 * Prueba del borrado protegido. Trabaja sobre una COPIA temporal de la base: antes abría la real
 * y, si se interrumpía a la mitad, dejaba la contraseña de borrado del docente en «prueba1234» o vacía.
 */
process.env.SEG_TEST = '1'
const Database = require('better-sqlite3')
const { join } = require('path')
const { mkdtempSync, rmSync } = require('fs')
const { tmpdir } = require('os')
const { randomBytes, scryptSync, timingSafeEqual } = require('crypto')
const real = new Database(join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite'), { readonly: true })
const carpeta = mkdtempSync(join(tmpdir(), 'docente-seguridad-'))
const copia = join(carpeta, 'docente.sqlite')
real.exec(`VACUUM INTO '${copia.replace(/'/g, "''")}'`)
real.close()
process.on('exit', () => rmSync(carpeta, { recursive: true, force: true }))
const db = new Database(copia)
db.pragma('foreign_keys = ON')

// Réplica exacta de src/main/services/seguridad.ts sobre la misma base
const CLAVE = 'pass_borrado'
const getAjuste = (k) => (db.prepare('SELECT valor FROM ajustes WHERE clave=?').get(k) || { valor: '' }).valor
const setAjuste = (k, v) => db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor').run(k, v)
const derivar = (p, sal) => scryptSync(p.normalize('NFKC'), sal, 32, { N: 16384, r: 8, p: 1 })
const configurada = () => getAjuste(CLAVE).startsWith('scrypt$')
const verificar = (p) => {
  const g = getAjuste(CLAVE)
  if (!g.startsWith('scrypt$')) return false
  const [, salHex, hashHex] = g.split('$')
  const esperado = Buffer.from(hashHex, 'hex')
  const calc = derivar(p ?? '', Buffer.from(salHex, 'hex'))
  return esperado.length === calc.length && timingSafeEqual(esperado, calc)
}
const establecer = (nueva, actual) => {
  if (configurada() && !verificar(actual ?? '')) throw new Error('La contraseña actual no es correcta.')
  // Copia de src/shared/password.ts: la misma regla segura del portal
  const faltan = [[[...(nueva ?? '')].length >= 8, '8 caracteres'], [/\p{Lu}/u.test(nueva ?? ''), 'mayúscula'], [/\p{Ll}/u.test(nueva ?? ''), 'minúscula'], [/\p{Nd}/u.test(nueva ?? ''), 'número'], [/[^\p{L}\p{N}\s]/u.test(nueva ?? ''), 'especial']].filter(([c]) => !c)
  if (faltan.length) throw new Error('La contraseña necesita: ' + faltan.map(([, t]) => t).join(', '))
  const sal = randomBytes(16)
  setAjuste(CLAVE, `scrypt$${sal.toString('hex')}$${derivar(nueva, sal).toString('hex')}`)
}
const exigir = (p) => {
  if (!configurada()) throw new Error('Primero define la contraseña de borrado en Ajustes › Seguridad.')
  if (!verificar(p)) throw new Error('Contraseña incorrecta.')
}
const borrarMateria = (id, pass) => { exigir(pass); return db.prepare('DELETE FROM materias WHERE id=?').run(id).changes }

const estadoPrevio = getAjuste(CLAVE)
const ok = (t, f) => { try { f(); console.log('  ✓', t) } catch (e) { console.log('  ✗', t, '→', e.message); process.exitCode = 1 } }
const debeFallar = (t, f, esperado) => {
  try { f(); console.log('  ✗', t, '→ NO falló (debía fallar)'); process.exitCode = 1 }
  catch (e) { console.log(e.message === esperado ? '  ✓' : '  ✗', t, '→', e.message) }
}

// materia de prueba
const per = db.prepare('SELECT id FROM periodos WHERE activo=1').get()
const car = db.prepare('SELECT id FROM carreras LIMIT 1').get()
const idPrueba = Number(db.prepare("INSERT INTO materias (carrera_id, periodo_id, nombre, clave) VALUES (?,?,'ZZ Materia de prueba','TEST')").run(car.id, per.id).lastInsertRowid)
db.prepare("INSERT INTO sesiones (materia_id, semana, numero, fecha, hora_inicio, hora_fin) VALUES (?,1,1,'2026-09-02','07:00','08:00')").run(idPrueba)

console.log('Sin contraseña configurada:')
setAjuste(CLAVE, '')
debeFallar('borrar queda bloqueado', () => borrarMateria(idPrueba, 'loquesea'), 'Primero define la contraseña de borrado en Ajustes › Seguridad.')

console.log('Con contraseña configurada:')
ok('se define la contraseña', () => establecer('Prueba-1234!'))
debeFallar('contraseña vacía rechazada', () => borrarMateria(idPrueba, ''), 'Contraseña incorrecta.')
debeFallar('contraseña incorrecta rechazada', () => borrarMateria(idPrueba, 'Prueba1234'), 'Contraseña incorrecta.')
ok('la materia de prueba sigue existiendo', () => { if (!db.prepare('SELECT 1 FROM materias WHERE id=?').get(idPrueba)) throw new Error('se borró antes de tiempo') })
debeFallar('cambiar contraseña sin la actual', () => establecer('Otra-1234!', 'malísima'), 'La contraseña actual no es correcta.')
debeFallar('contraseña insegura rechazada (sin mayúscula ni especial)', () => establecer('prueba1234', 'Prueba-1234!'), 'La contraseña necesita: mayúscula, especial')
ok('borrado con la contraseña correcta', () => { if (borrarMateria(idPrueba, 'Prueba-1234!') !== 1) throw new Error('no borró') })
ok('la materia y su sesión desaparecieron (cascade)', () => {
  if (db.prepare('SELECT 1 FROM materias WHERE id=?').get(idPrueba)) throw new Error('la materia sigue')
  if (db.prepare('SELECT 1 FROM sesiones WHERE materia_id=?').get(idPrueba)) throw new Error('quedaron sesiones huérfanas')
})
ok('el hash guardado no contiene la contraseña en claro', () => { if (getAjuste(CLAVE).includes('Prueba-1234!')) throw new Error('¡contraseña en claro!') })

// dejar la protección como estaba (sin configurar) para que el usuario ponga la suya
setAjuste(CLAVE, estadoPrevio)
console.log('Estado final:', configurada() ? 'contraseña configurada' : 'sin contraseña (define la tuya en Ajustes › Seguridad)')
console.log('Materias:', db.prepare('SELECT nombre FROM materias ORDER BY nombre').all().map((m) => m.nombre).join(' · '))
db.close()
