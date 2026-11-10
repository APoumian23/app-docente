/** Registro de errores de la app (src/main/services/errores.ts). */

export type OrigenError = 'principal' | 'ventana' | 'pantalla' | 'base' | 'sincronizacion'

export interface ErrorRegistrado {
  id: number
  origen: OrigenError
  /** Qué se estaba haciendo: «ipc materiales:compartir», «sincronización», «Classroom»… */
  donde: string
  mensaje: string
  /** Pila o datos extra para diagnosticar */
  detalle: string
  /** Primera vez (ISO, UTC) */
  fecha: string
  /** Última vez que se repitió (ISO, UTC) */
  ultima: string
  veces: number
  version: string
  revisado: boolean
}

export const ORIGENES_ERROR: Record<OrigenError, string> = {
  principal: 'App (proceso principal)',
  ventana: 'Ventana',
  pantalla: 'Pantalla',
  base: 'Acción',
  sincronizacion: 'Portal en línea'
}
