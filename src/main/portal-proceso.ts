/**
 * Servidor del portal en su propio proceso (utilityProcess de Electron), con su propia conexión
 * a la misma base (WAL). Así un PDF pesado o una exportación en la app del docente no congelan
 * el portal ni el tiempo de las partidas en vivo, y una falla del servidor no tumba la app.
 *
 * La app lo lanza con la configuración en variables de entorno (PORTAL_BASE, PORTAL_ENTREGAS,
 * PORTAL_CARPETA, PORTAL_PUERTO); aquí se avisa «listo» o «error» y se espera «detener».
 */
import { delimiter } from 'path'
import type Database from 'better-sqlite3'
import { abrirBase } from '../servidor/base'
import { crearServidor, type ServidorPortal } from '../servidor/app'

export type MensajeAlProceso = { tipo: 'detener' }
export type MensajeDelProceso = { tipo: 'listo'; puerto: number } | { tipo: 'error'; codigo?: string; mensaje: string }

const avisar = (m: MensajeDelProceso): void => process.parentPort.postMessage(m)
let db: Database.Database | null = null
let servidor: ServidorPortal | null = null

async function arrancar(): Promise<void> {
  const env = process.env
  try {
    db = abrirBase(env.PORTAL_BASE!)
    servidor = crearServidor({
      db,
      carpetaEntregas: env.PORTAL_ENTREGAS!,
      carpetaPortal: env.PORTAL_CARPETA || null,
      carpetasPyodide: (env.PORTAL_PYODIDE ?? '').split(delimiter).filter(Boolean)
    })
    const r = await servidor.iniciar(Number(env.PORTAL_PUERTO))
    avisar({ tipo: 'listo', puerto: r.puerto })
  } catch (e) {
    // La app mata este proceso al recibir el error
    avisar({ tipo: 'error', codigo: (e as NodeJS.ErrnoException).code, mensaje: (e as Error).message })
  }
}

async function detener(): Promise<void> {
  // Conexiones que no sueltan (navegadores con keep-alive) no deben dejar colgada la salida
  await Promise.race([servidor?.detener(), new Promise((r) => setTimeout(r, 3000))])
  db?.close()
  process.exit(0)
}

process.parentPort.on('message', ({ data }: { data: MensajeAlProceso }) => {
  if (data?.tipo === 'detener') void detener()
})

void arrancar()
