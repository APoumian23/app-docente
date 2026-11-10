import { app } from 'electron'
import { spawn } from 'child_process'
import { accessSync, constants, existsSync, openSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { respaldar } from '../db'

/**
 * Actualización desde la carpeta del proyecto: `pnpm dist:mac` deja la app nueva en
 * release/mac-arm64 y el botón Actualizar la instala encima de la que está corriendo.
 * No se usa electron-updater porque en macOS exige app firmada, y esta no lo está.
 */
export const ORIGEN = join(app.getPath('home'), 'Documentos/app-docente/release/mac-arm64/App_Docente.app')

export interface Cambio {
  hash: string
  fecha: string
  texto: string
}

export interface Compilacion {
  version: string
  fecha: string
  /** Últimos cambios incluidos (de git, del más nuevo al más viejo); las compilaciones viejas no los traen */
  cambios?: Cambio[]
}

export interface EstadoActualizacion {
  instalada: Compilacion | null
  disponible: Compilacion | null
  hay_nueva: boolean
  /** Lo que trae la versión disponible y no tiene la instalada */
  novedades: Cambio[]
  origen: string
  /** Por qué no se puede actualizar desde aquí (desarrollo, sin compilación en release/…). */
  motivo: string
}

function leerCompilacion(ruta: string): Compilacion | null {
  try {
    const c = JSON.parse(readFileSync(ruta, 'utf8'))
    return typeof c.fecha === 'string' && typeof c.version === 'string' ? c : null
  } catch {
    return null
  }
}

/** Carpeta .app de la que corre este proceso: .../App_Docente.app/Contents/MacOS/App_Docente */
function appInstalada(): string {
  return resolve(dirname(process.execPath), '../..')
}

export function revisar(): EstadoActualizacion {
  const base = { instalada: null, disponible: null, hay_nueva: false, novedades: [], origen: ORIGEN, motivo: '' }
  if (!app.isPackaged) return { ...base, motivo: 'En desarrollo (pnpm dev) no se actualiza: se usa el código del proyecto directamente.' }
  const instalada = leerCompilacion(join(process.resourcesPath, 'compilacion.json'))
  if (!existsSync(ORIGEN)) return { ...base, instalada, motivo: 'No hay ninguna compilación en release/. Corre pnpm dist:mac en el proyecto.' }
  const disponible = leerCompilacion(join(ORIGEN, 'Contents/Resources/compilacion.json'))
  if (!disponible) return { ...base, instalada, motivo: 'La compilación de release/ es anterior al botón Actualizar. Instálala una vez desde el DMG.' }
  if (resolve(ORIGEN) === appInstalada()) return { ...base, instalada, disponible, motivo: 'Esta app corre directamente desde release/; instálala en Aplicaciones para poder actualizarla.' }
  // Sin marca propia (versión vieja instalada) cualquier compilación con marca es más nueva
  const hay_nueva = !instalada || Date.parse(disponible.fecha) > Date.parse(instalada.fecha)
  const yaTiene = new Set((instalada?.cambios ?? []).map((c) => c.hash))
  const novedades = hay_nueva ? (disponible.cambios ?? []).filter((c) => !yaTiene.has(c.hash)).slice(0, 20) : []
  return { ...base, instalada, disponible, hay_nueva, novedades }
}

/**
 * Deja corriendo un script aparte que espera a que la app se cierre, copia la versión
 * nueva junto a la instalada, intercambia las dos y abre la nueva. Si la copia falla,
 * la app anterior queda intacta y se vuelve a abrir. Si se abrió con otra carpeta de
 * datos (DOCENTE_DATOS), la nueva se abre con la misma.
 */
export async function instalar(): Promise<void> {
  const estado = revisar()
  if (!estado.hay_nueva) throw new Error(estado.motivo || 'Ya tienes la versión más reciente.')
  const destino = appInstalada()
  if (!destino.endsWith('.app')) throw new Error(`No se reconoce dónde está instalada la app (${destino}).`)
  try {
    accessSync(dirname(destino), constants.W_OK)
  } catch {
    throw new Error(`No hay permiso para escribir en ${dirname(destino)}.`)
  }
  // La versión nueva puede migrar el esquema: antes de cerrar se deja una copia de la base
  await respaldar('antes-de-actualizar', new Date().toISOString().replace(/[:.]/g, '-'), 5)
  const script = `
pid="$1"; origen="$2"; destino="$3"; datos="$4"; nuevo="$destino.nuevo"; viejo="$destino.viejo"
abrir() { if [ -n "$datos" ]; then open -n "$destino" --env DOCENTE_DATOS="$datos"; else open -n "$destino"; fi; }
echo "$(date) actualizando $destino desde $origen"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 200 ] && { echo "la app no se cerró; se cancela"; exit 1; }
  sleep 0.3
done
rm -rf "$nuevo" "$viejo"
if ! ditto "$origen" "$nuevo"; then echo "falló la copia"; rm -rf "$nuevo"; abrir; exit 1; fi
xattr -dr com.apple.quarantine "$nuevo" 2>/dev/null
# Si se pulsó mientras pnpm dist:mac aún escribía en release/, la copia queda incompleta: no se instala
if [ ! -f "$nuevo/Contents/Resources/app.asar" ] || [ ! -f "$nuevo/Contents/Resources/compilacion.json" ] || ! codesign --verify --deep --strict "$nuevo"; then
  echo "la copia está incompleta o su firma no es válida; se conserva la versión anterior"
  rm -rf "$nuevo"; abrir; exit 1
fi
if mv "$destino" "$viejo" && mv "$nuevo" "$destino"; then
  rm -rf "$viejo"
  echo "listo"
else
  echo "falló el intercambio"
  [ ! -d "$destino" ] && [ -d "$viejo" ] && mv "$viejo" "$destino"
fi
abrir
`
  const log = openSync(join(app.getPath('userData'), 'actualizacion.log'), 'a')
  spawn('/bin/sh', ['-c', script, 'actualizar', String(process.pid), ORIGEN, destino, process.env.DOCENTE_DATOS ?? ''], { detached: true, stdio: ['ignore', log, log] }).unref()
  // Se deja responder al renderer antes de cerrar
  setTimeout(() => app.quit(), 300)
}
