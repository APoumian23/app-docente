import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getAjuste, setAjuste } from '../db'
import { problemaPassword } from '../../shared/password'

/**
 * Contraseña para acciones destructivas (eliminar materias y alumnos).
 * Se guarda solo el hash scrypt con sal aleatoria: la contraseña nunca se almacena en claro.
 */
const CLAVE = 'pass_borrado'
const N = 16384

function derivar(password: string, sal: Buffer): Buffer {
  return scryptSync(password.normalize('NFKC'), sal, 32, { N, r: 8, p: 1 })
}

export function passwordConfigurada(): boolean {
  return getAjuste(CLAVE).startsWith('scrypt$')
}

export function verificarPassword(password: string): boolean {
  const guardado = getAjuste(CLAVE)
  if (!guardado.startsWith('scrypt$')) return false
  const [, salHex, hashHex] = guardado.split('$')
  try {
    const esperado = Buffer.from(hashHex, 'hex')
    const calculado = derivar(password ?? '', Buffer.from(salHex, 'hex'))
    return esperado.length === calculado.length && timingSafeEqual(esperado, calculado)
  } catch {
    return false
  }
}

/** Define o cambia la contraseña. Si ya existe una, exige la actual. */
export function establecerPassword(nueva: string, actual?: string): void {
  if (passwordConfigurada() && !verificarPassword(actual ?? '')) throw new Error('La contraseña actual no es correcta.')
  // La misma regla segura que las cuentas del portal (docente y alumnos)
  const problema = problemaPassword(nueva ?? '')
  if (problema) throw new Error(problema)
  const sal = randomBytes(16)
  setAjuste(CLAVE, `scrypt$${sal.toString('hex')}$${derivar(nueva, sal).toString('hex')}`)
}

/** Quita la protección. Exige la contraseña vigente. */
export function quitarPassword(actual: string): void {
  if (!verificarPassword(actual)) throw new Error('La contraseña no es correcta.')
  setAjuste(CLAVE, '')
}

/** Puerta para acciones destructivas: lanza si no hay contraseña configurada o si no coincide. */
export function exigirPassword(password: string): void {
  if (!passwordConfigurada()) throw new Error('Primero define la contraseña de borrado en Ajustes › Seguridad.')
  if (!verificarPassword(password)) throw new Error('Contraseña incorrecta.')
}
