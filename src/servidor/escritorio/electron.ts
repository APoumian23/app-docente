/**
 * Electron para el servidor: la app de escritorio en el navegador usa exactamente el mismo código del proceso
 * principal (src/main), y lo poco que en la Mac hace Electron aquí se resuelve con la web:
 *
 * - Elegir un archivo (dialog.showOpenDialog) → el navegador lo sube: la primera vez se avisa que hace falta
 *   (`NecesitaArchivo`) y la ventana repite la llamada con lo que eligió el docente.
 * - Guardar (dialog.showSaveDialog) y abrir un archivo (shell.openPath) → descarga en el navegador.
 * - Avisos a la ventana (webContents.send) → eventos que la página recibe por /api/docente/app/eventos.
 * - Llavero (safeStorage) → cifrado AES-GCM con una llave propia del servidor.
 * - PDF (printToPDF) → la página lo abre listo para «Imprimir › Guardar como PDF».
 *
 * Cada petición trae su contexto (AsyncLocalStorage): qué subió el docente y qué se le va a descargar.
 */
import { AsyncLocalStorage } from 'async_hooks'
import { EventEmitter } from 'events'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

export interface Descarga {
  ruta: string
  nombre: string
  /** El archivo se abre en el navegador en vez de bajarse (ver un material) */
  ver?: boolean
}

export interface ContextoWeb {
  /** Lo que subió el docente para esta llamada; 'cancelado' si cerró el selector sin elegir */
  archivos?: string[] | 'cancelado'
  descargas: Descarga[]
  /** Enlaces que la página debe abrir en otra pestaña */
  abrir: string[]
  /** https://dominio desde el que entró el docente */
  origen?: string
}

export const contextoWeb = new AsyncLocalStorage<ContextoWeb>()
const ctx = (): ContextoWeb | undefined => contextoWeb.getStore()

/** La llamada necesita que el docente elija archivos; la página abre el selector y la repite. */
export class NecesitaArchivo extends Error {
  constructor(
    public opciones: { titulo?: string; extensiones: string[]; multiple: boolean }
  ) {
    super('Elige el archivo.')
    this.name = 'NecesitaArchivo'
  }
}

/** Avisos a la ventana (lo que en la Mac es webContents.send): la página los recibe por eventos. */
export const avisosWeb = new EventEmitter()
avisosWeb.setMaxListeners(50)

/** Carpeta de trabajo de la app en el servidor (base, materiales, respaldos). */
const carpetaApp = (): string => process.env.PORTAL_APP_DATOS || join(process.env.PORTAL_DATOS || join(process.cwd(), 'datos'), 'app')
export const carpetaTemporal = (): string => {
  const dir = join(tmpdir(), 'docente-app-web')
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------- app ----------

const nada = (): void => undefined
export const app = {
  isPackaged: true,
  getPath: (nombre: string): string => (nombre === 'userData' ? carpetaApp() : carpetaTemporal()),
  getAppPath: (): string => process.env.PORTAL_RAIZ || process.cwd(),
  getVersion: (): string => 'web',
  getName: (): string => 'App_Docente',
  on: nada,
  once: nada,
  quit: nada,
  relaunch: nada,
  exit: nada,
  whenReady: (): Promise<void> => Promise.resolve(),
  commandLine: { appendSwitch: nada }
}

// ---------- Ventanas ----------

const PDF = '<!--DOCENTE-IMPRIMIR-->'

/** La única «ventana»: la página del docente. Lo que se le manda llega como evento. */
class WebContentsWeb {
  private html = ''
  send(canal: string, ...datos: unknown[]): void {
    avisosWeb.emit('aviso', canal, datos)
  }
  async printToPDF(): Promise<Buffer> {
    // Sin Chromium en el servidor: el «PDF» es la página misma, que el navegador imprime al abrirla
    return Buffer.from(`${PDF}${this.html}<script>addEventListener('load',()=>setTimeout(()=>print(),300))</script>`)
  }
  async cargarArchivo(ruta: string): Promise<void> {
    this.html = readFileSync(ruta, 'utf8')
  }
  setZoomFactor = nada
  on = nada
  once = nada
  isDestroyed = (): boolean => false
  executeJavaScript = async (): Promise<undefined> => undefined
}

export class BrowserWindow {
  webContents = new WebContentsWeb()
  constructor(_op?: unknown) {}
  static ventana = new BrowserWindow()
  static getAllWindows(): BrowserWindow[] {
    return [BrowserWindow.ventana]
  }
  static getFocusedWindow(): BrowserWindow {
    return BrowserWindow.ventana
  }
  async loadFile(ruta: string): Promise<void> {
    await this.webContents.cargarArchivo(ruta)
  }
  async loadURL(url: string): Promise<void> {
    ctx()?.abrir.push(url)
  }
  isDestroyed = (): boolean => false
  isVisible = (): boolean => true
  isMinimized = (): boolean => false
  restore = nada
  focus = nada
  show = nada
  close = nada
  destroy = nada
  setFullScreen = nada
  on = nada
  once = nada
}

/** Un «PDF» hecho por printToPDF en el servidor es HTML que se imprime en el navegador. */
export const esPdfWeb = (contenido: Buffer): boolean => contenido.subarray(0, PDF.length).toString() === PDF

// ---------- Diálogos y shell ----------

export const dialog = {
  async showOpenDialog(a: unknown, b?: unknown): Promise<{ canceled: boolean; filePaths: string[] }> {
    const op = (b ?? a) as { title?: string; properties?: string[]; filters?: { extensions: string[] }[] }
    if (op.properties?.includes('openDirectory')) throw new Error('En la versión web no se elige una carpeta de tu computadora; eso se hace en la app de escritorio.')
    const c = ctx()
    if (c?.archivos === 'cancelado') return { canceled: true, filePaths: [] }
    if (c?.archivos?.length) return { canceled: false, filePaths: c.archivos }
    // «Todos» (*) entre los filtros: el selector acepta cualquier archivo, como en la Mac
    const extensiones = (op.filters ?? []).flatMap((f) => f.extensions)
    throw new NecesitaArchivo({ titulo: op.title, extensiones: extensiones.includes('*') ? [] : extensiones, multiple: !!op.properties?.includes('multiSelections') })
  },
  async showSaveDialog(a: unknown, b?: unknown): Promise<{ canceled: boolean; filePath: string }> {
    const op = (b ?? a) as { defaultPath?: string }
    const nombre = basename(op.defaultPath || 'archivo')
    const ruta = join(carpetaTemporal(), `${randomBytes(8).toString('hex')}-${nombre}`)
    ctx()?.descargas.push({ ruta, nombre })
    return { canceled: false, filePath: ruta }
  },
  async showMessageBox(): Promise<{ response: number; checkboxChecked: boolean }> {
    return { response: 0, checkboxChecked: false }
  },
  showErrorBox: nada
}

export const shell = {
  showItemInFolder: nada,
  async openPath(ruta: string): Promise<string> {
    ctx()?.descargas.push({ ruta, nombre: basename(ruta), ver: true })
    return ''
  },
  async openExternal(url: string): Promise<void> {
    ctx()?.abrir.push(url)
  }
}

// ---------- Llavero ----------

/** Llave del servidor para lo que en la Mac guarda el llavero (API keys, Google). */
function llave(): Buffer {
  const base = process.env.PORTAL_SECRETO || process.env.PORTAL_SINCRO
  if (!base) throw new Error('El servidor no tiene PORTAL_SECRETO para cifrar las llaves.')
  return createHash('sha256').update(`docente-app-web:${base}`).digest()
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => Boolean(process.env.PORTAL_SECRETO || process.env.PORTAL_SINCRO),
  encryptString(texto: string): Buffer {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', llave(), iv)
    const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), datos])
  },
  decryptString(buf: Buffer): string {
    const d = createDecipheriv('aes-256-gcm', llave(), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  }
}

// ---------- Lo demás: no aplica en el servidor ----------

export class Notification {
  static isSupported = (): boolean => false
  constructor(_op?: unknown) {}
  show = nada
  on = nada
}

/** Los manejadores que registra src/main/ipc: aquí los llama la ruta RPC en vez de la ventana. */
export const manejadores = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
export const ipcMain = {
  handle: (canal: string, fn: (e: unknown, ...args: unknown[]) => unknown): void => void manejadores.set(canal, fn),
  removeHandler: (canal: string): void => void manejadores.delete(canal),
  on: nada
}

export const powerMonitor = { on: nada }
export const utilityProcess = {
  fork: (): never => {
    throw new Error('No aplica en el servidor.')
  }
}
export const protocol = { registerSchemesAsPrivileged: nada, handle: nada }
export const net = { fetch: (url: string): Promise<Response> => fetch(url) }
export const Menu = { setApplicationMenu: nada, buildFromTemplate: (): object => ({}) }
export const nativeTheme = { shouldUseDarkColors: false, on: nada }
export const clipboard = { writeText: nada, readText: (): string => '' }
export default { app, BrowserWindow, dialog, shell, safeStorage, Notification, ipcMain, powerMonitor, utilityProcess, protocol, net, Menu, nativeTheme, clipboard }
