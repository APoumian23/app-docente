/**
 * Con nodeLinker: hoisted, pnpm a veces deja sin permiso de ejecución el archivo al que apunta
 * node_modules/.bin/<herramienta> (pasó con electron-vite al actualizarlo): `pnpm dev` y
 * `pnpm build` fallaban con EACCES. Se corre al final de cada instalación (postinstall).
 */
const { readdirSync, realpathSync, statSync, chmodSync } = require('fs')
const { join } = require('path')

const bin = join(__dirname, '..', 'node_modules', '.bin')
let arreglados = 0
for (const nombre of readdirSync(bin)) {
  try {
    const destino = realpathSync(join(bin, nombre))
    const modo = statSync(destino).mode
    if ((modo & 0o111) === 0) {
      chmodSync(destino, modo | 0o755)
      arreglados++
    }
  } catch {
    /* enlace roto o sin permiso: no se toca */
  }
}
if (arreglados) console.log(`permisos de ejecución restaurados en ${arreglados} herramienta(s) de node_modules/.bin`)
