/**
 * Hook afterPack de electron-builder: firma la app con el certificado propio
 * ("App_Docente firma local", lo crea scripts/crear-certificado.sh) antes de armar el DMG.
 *
 * electron-builder no lo hace solo porque solo acepta certificados de confianza, y este es
 * autofirmado. Lo que importa es que la firma sea siempre la misma: así macOS reconoce cada
 * versión como la misma app y el llavero no vuelve a pedir la contraseña tras actualizar.
 */
const { execFileSync } = require('child_process')
const { join } = require('path')

const NOMBRE = 'App_Docente firma local'

function huellaDelCertificado() {
  const salida = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' })
  const linea = salida.split('\n').find((l) => l.includes(`"${NOMBRE}"`))
  const huella = linea && /([0-9A-F]{40})/.exec(linea)?.[1]
  if (!huella) throw new Error(`No está el certificado "${NOMBRE}" en el llavero. Créalo una vez con: sh scripts/crear-certificado.sh`)
  return huella
}

exports.default = async function firmar(contexto) {
  if (contexto.electronPlatformName !== 'darwin') return
  const app = join(contexto.appOutDir, `${contexto.packager.appInfo.productFilename}.app`)
  const huella = huellaDelCertificado()
  execFileSync('codesign', ['--force', '--deep', '--sign', huella, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • firmada con "${NOMBRE}" (${huella.slice(0, 8)}…)`)
}
