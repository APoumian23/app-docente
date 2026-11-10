/**
 * Servidor del portal para desarrollo, sobre una COPIA de la base real en .dev-datos/.
 * Así se puede probar con alumnos y entregas de prueba sin tocar los datos del docente.
 *   node scripts/servidor-dev.mjs [--reset]
 */
import { spawn } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const datos = join(process.cwd(), '.dev-datos')
if (process.argv.includes('--reset')) rmSync(datos, { recursive: true, force: true })
mkdirSync(datos, { recursive: true })
const real = join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite')
if (!existsSync(join(datos, 'docente.sqlite')) && existsSync(real)) copyFileSync(real, join(datos, 'docente.sqlite'))

execSync('node scripts/build-servidor.mjs', { stdio: 'inherit' })
const electron = join('node_modules/electron/dist', readFileSync('node_modules/electron/path.txt', 'utf8').trim())
const p = spawn(electron, ['dist/servidor/index.mjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORTAL_DATOS: datos, PORTAL_PUERTO: process.env.PORTAL_PUERTO ?? '8787', PORTAL_DOCENTE: 'profe:secreto123:Docente Demo' },
  stdio: 'inherit'
})
p.on('exit', (c) => process.exit(c ?? 0))
