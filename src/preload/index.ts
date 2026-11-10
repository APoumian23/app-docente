import { contextBridge, ipcRenderer } from 'electron'

export type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

/** Los únicos avisos que el proceso principal manda a la ventana. */
const AVISOS = new Set(['ui:zoom', 'portal:novedades', 'faltas:novedades', 'asistente:trozo', 'errores:nuevo', 'portal:verPanel'])

const api = {
  invoke: <T = unknown>(canal: string, ...args: unknown[]): Promise<Respuesta<T>> => ipcRenderer.invoke(canal, ...args),
  /** Suscribe a un aviso del proceso principal; devuelve la función para desuscribirse. */
  escuchar: (canal: string, cb: (...datos: unknown[]) => void): (() => void) => {
    if (!AVISOS.has(canal)) throw new Error(`Aviso desconocido: ${canal}`)
    const f = (_e: Electron.IpcRendererEvent, ...datos: unknown[]): void => cb(...datos)
    ipcRenderer.on(canal, f)
    return () => ipcRenderer.removeListener(canal, f)
  },
  plataforma: process.platform as string,
  /** Dirección de un archivo de la app (materiales/…, pyodide/…, classroom/…); en la versión web es otra */
  url: (ruta: string): string => `docente://${ruta}`
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
