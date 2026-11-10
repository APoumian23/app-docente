import { app, BrowserWindow } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../db'
import type { ErrorRegistrado, OrigenError } from '@shared/errores'

/**
 * Registro de errores de la app: lo que falla en el proceso principal, en las ventanas, en las llamadas
 * a la base o en la sincronización. Se guarda en <datos>/errores.log (una línea JSON por error) para
 * verlo en Ajustes aunque la app se haya cerrado, y se avisa a la ventana al momento.
 */

const MAX_BYTES = 1_000_000
/** El mismo error repetido dentro de este plazo suma a la cuenta en vez de abrir otra línea (la sincronización corre cada 5 s) */
const AGRUPAR_MS = 10 * 60_000

let recientes: ErrorRegistrado[] | null = null
let siguienteId = 1

const archivo = (): string => join(dataDir(), 'errores.log')

function cargar(): ErrorRegistrado[] {
  if (recientes) return recientes
  recientes = []
  try {
    if (existsSync(archivo())) {
      for (const linea of readFileSync(archivo(), 'utf8').split('\n')) {
        if (!linea.trim()) continue
        try {
          const e = JSON.parse(linea) as ErrorRegistrado
          // Las líneas de repetición traen el mismo id: la última manda
          const i = recientes.findIndex((x) => x.id === e.id)
          if (i >= 0) recientes[i] = e
          else recientes.push(e)
        } catch {
          // línea cortada por un cierre a medias: se ignora
        }
      }
    }
  } catch (e) {
    console.error('[errores] no se pudo leer el registro', (e as Error).message)
  }
  siguienteId = recientes.reduce((m, e) => Math.max(m, e.id), 0) + 1
  return recientes
}

function escribir(e: ErrorRegistrado): void {
  try {
    if (existsSync(archivo()) && statSync(archivo()).size > MAX_BYTES) {
      // Se conserva el anterior una vez y se reescribe con lo vigente
      renameSync(archivo(), `${archivo()}.1`)
      writeFileSync(archivo(), cargar().slice(-300).map((x) => JSON.stringify(x)).join('\n') + '\n')
    }
    appendFileSync(archivo(), JSON.stringify(e) + '\n')
  } catch (err) {
    console.error('[errores] no se pudo guardar', (err as Error).message)
  }
}

function avisarVentanas(e: ErrorRegistrado): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('errores:nuevo', e)
}

const texto = (x: unknown): { mensaje: string; detalle: string } => {
  if (x instanceof Error) return { mensaje: x.message || x.name, detalle: x.stack ?? '' }
  if (typeof x === 'string') return { mensaje: x, detalle: '' }
  try {
    return { mensaje: JSON.stringify(x), detalle: '' }
  } catch {
    return { mensaje: String(x), detalle: '' }
  }
}

/** Anota un error. `donde` dice qué se estaba haciendo («ipc materiales:compartir», «sincronización»…). */
export function registrarError(origen: OrigenError, donde: string, error: unknown, detalleExtra = ''): void {
  try {
    const { mensaje, detalle } = texto(error)
    const lista = cargar()
    const ahora = new Date()
    const previo = [...lista].reverse().find((x) => x.origen === origen && x.donde === donde && x.mensaje === mensaje)
    if (previo && ahora.getTime() - new Date(previo.ultima).getTime() < AGRUPAR_MS) {
      previo.veces += 1
      previo.ultima = ahora.toISOString()
      previo.revisado = false
      // Al archivo no va cada repetición (un servidor caído fallaría cada 5 s): las primeras y luego cada 20
      if (previo.veces <= 3 || previo.veces % 20 === 0) escribir(previo)
      return
    }
    const e: ErrorRegistrado = {
      id: siguienteId++,
      origen,
      donde,
      mensaje: mensaje.slice(0, 2000),
      detalle: [detalle, detalleExtra].filter(Boolean).join('\n').slice(0, 8000),
      fecha: ahora.toISOString(),
      ultima: ahora.toISOString(),
      veces: 1,
      version: app.getVersion(),
      revisado: false
    }
    lista.push(e)
    if (lista.length > 500) lista.splice(0, lista.length - 500)
    escribir(e)
    avisarVentanas(e)
  } catch (err) {
    console.error('[errores] no se pudo registrar', err)
  }
}

/** Lo más reciente primero */
export function listarErrores(): ErrorRegistrado[] {
  return [...cargar()].sort((a, b) => b.ultima.localeCompare(a.ultima))
}

export function marcarErroresRevisados(): number {
  const pendientes = cargar().filter((e) => !e.revisado)
  for (const e of pendientes) e.revisado = true
  try {
    writeFileSync(archivo(), cargar().map((x) => JSON.stringify(x)).join('\n') + (cargar().length ? '\n' : ''))
  } catch (err) {
    console.error('[errores] no se pudo guardar', (err as Error).message)
  }
  return pendientes.length
}

export function borrarErrores(): void {
  recientes = []
  try {
    writeFileSync(archivo(), '')
  } catch (err) {
    console.error('[errores] no se pudo borrar', (err as Error).message)
  }
}

export const rutaRegistroErrores = archivo

/**
 * Captura global: errores sin atrapar del proceso principal, ventanas que se caen o se congelan
 * y procesos auxiliares (GPU, utilidades) que terminan mal.
 */
export function instalarCapturaDeErrores(): void {
  process.on('uncaughtException', (e) => {
    console.error('[sin atrapar]', e)
    registrarError('principal', 'error sin atrapar', e)
  })
  process.on('unhandledRejection', (e) => {
    console.error('[promesa sin atrapar]', e)
    registrarError('principal', 'promesa sin atrapar', e)
  })
  app.on('render-process-gone', (_ev, contenido, info) => {
    if (info.reason === 'clean-exit') return
    registrarError('ventana', 'la ventana se cerró de golpe', `Motivo: ${info.reason} (código ${info.exitCode})`, contenido.getURL())
  })
  app.on('child-process-gone', (_ev, info) => {
    if (info.reason === 'clean-exit' || info.reason === 'killed') return
    registrarError('principal', `proceso ${info.type}${info.name ? ` (${info.name})` : ''}`, `Terminó: ${info.reason} (código ${info.exitCode})`)
  })
  app.on('browser-window-created', (_ev, w) => {
    w.on('unresponsive', () => registrarError('ventana', 'la ventana dejó de responder', 'Se quedó congelada más de unos segundos', w.webContents.getURL()))
    w.webContents.on('preload-error', (_e, ruta, error) => registrarError('ventana', 'preload', error, ruta))
  })
}
