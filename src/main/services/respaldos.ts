/**
 * Respaldos de la base desde Ajustes: respaldar ahora, ver los que hay, restaurar uno y una copia
 * automática a otra carpeta (iCloud Drive, Google Drive o una USB) por si le pasa algo a la Mac.
 * Restaurar no se hace con la base abierta: se deja anotado, la app se reinicia y se aplica antes de abrirla
 * (guardando primero una copia de lo que había).
 */
import { app, dialog, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { dataDir, getAjuste, respaldar, setAjuste } from '../db'

const carpetaRespaldos = (): string => join(dataDir(), 'respaldos')
const marcaRestaurar = (): string => join(dataDir(), 'restaurar-pendiente.json') // se aplica en db.ts al abrir

export interface Respaldo {
  nombre: string
  tipo: string
  fecha: string // ISO
  bytes: number
}

const TIPOS: Record<string, string> = {
  diario: 'Diario',
  manual: 'Hecho por ti',
  'antes-de-actualizar': 'Antes de actualizar',
  'antes-de-abrir-version-nueva': 'Antes de abrir una versión nueva',
  'antes-de-restaurar': 'Antes de restaurar',
  'antes-de-sincronizar': 'Antes de sincronizar con el portal en línea'
}

export function listarRespaldos(): Respaldo[] {
  const dir = carpetaRespaldos()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const st = statSync(join(dir, f))
      const tipo = Object.keys(TIPOS).sort((a, b) => b.length - a.length).find((t) => f.startsWith(t + '-'))
      return { nombre: f, tipo: tipo ? TIPOS[tipo] : 'Otro', fecha: st.mtime.toISOString(), bytes: st.size }
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
}

/** Respaldo en el momento; también se copia a la carpeta externa si hay una. */
export async function respaldarAhora(): Promise<Respaldo> {
  const sello = new Date().toISOString().replace(/[:.]/g, '-')
  const ruta = await respaldar('manual', sello, 20)
  if (!ruta) throw new Error('No se pudo crear el respaldo.')
  copiarAExterna(ruta)
  return listarRespaldos().find((r) => r.nombre === basename(ruta))!
}

/** Carpeta externa elegida por el docente ('' = ninguna). */
export const carpetaExterna = (): string => getAjuste('respaldo_carpeta_externa', '')

export async function elegirCarpetaExterna(): Promise<string> {
  const v = BrowserWindow.getFocusedWindow()
  const r = await (v ? dialog.showOpenDialog(v, { properties: ['openDirectory', 'createDirectory'], title: 'Carpeta para copias de respaldo' }) : dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] }))
  if (r.canceled || !r.filePaths[0]) return carpetaExterna()
  setAjuste('respaldo_carpeta_externa', r.filePaths[0])
  // Primera copia de inmediato
  await respaldarAhora().catch(() => undefined)
  return r.filePaths[0]
}

export function quitarCarpetaExterna(): void {
  setAjuste('respaldo_carpeta_externa', '')
}

/** Copia un respaldo a la carpeta externa (se guardan los últimos 30 ahí). Nunca tumba la app si falla. */
export function copiarAExterna(ruta: string | null): void {
  let destino = carpetaExterna()
  if (!ruta || !destino) return
  try {
    if (!existsSync(destino)) {
      // Google Drive renombra su carpeta al cambiar de idioma («Mi unidad» ↔ «My Drive»): se sigue a la nueva
      const otra = [['/Mi unidad/', '/My Drive/'], ['/My Drive/', '/Mi unidad/']].map(([de, a]) => destino.replace(de, a)).find((r) => r !== destino && existsSync(r))
      if (!otra) throw new Error(`No se encuentra la carpeta ${destino}. Si es de Google Drive o iCloud, revisa que esté abierto; si cambió de nombre, elígela otra vez con «Cambiar carpeta».`)
      setAjuste('respaldo_carpeta_externa', otra)
      destino = otra
    }
    const dir = join(destino, 'App_Docente respaldos')
    mkdirSync(dir, { recursive: true })
    const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date())
    copyFileSync(ruta, join(dir, `App_Docente-${fecha}-${basename(ruta)}`))
    const viejos = readdirSync(dir).filter((f) => f.startsWith('App_Docente-') && f.endsWith('.sqlite')).sort().slice(0, -30)
    for (const f of viejos) rmSync(join(dir, f), { force: true })
    setAjuste('respaldo_externo_ultimo', new Date().toISOString())
    setAjuste('respaldo_externo_error', '')
  } catch (e) {
    console.error('[respaldo] no se pudo copiar a la carpeta externa:', (e as Error).message)
    setAjuste('respaldo_externo_error', (e as Error).message)
  }
}

/** Deja anotado qué respaldo restaurar y reinicia la app: se aplica antes de abrir la base. */
export function restaurarRespaldo(nombre: string): void {
  const limpio = basename(nombre)
  const ruta = join(carpetaRespaldos(), limpio)
  if (limpio !== nombre || !existsSync(ruta)) throw new Error('Ese respaldo ya no existe.')
  writeFileSync(marcaRestaurar(), JSON.stringify({ ruta }))
  app.relaunch()
  app.exit(0)
}
