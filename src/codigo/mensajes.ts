/** Mensajes entre la página y los workers que corren el código. */
export type ALWorker =
  | { tipo: 'precargar'; base: string }
  /**
   * `paquetes: false` = solo la biblioteca estándar (p. ej. en un examen).
   * `sesion`: las variables se quedan para la siguiente ejecución con la misma sesión (celdas de un cuaderno).
   */
  | { tipo: 'ejecutar'; codigo: string; entrada: string[]; base: string; paquetes?: boolean; sesion?: string }
  /** Olvida las variables de una sesión («Reiniciar Python» en un cuaderno) */
  | { tipo: 'olvidar'; sesion: string }

export type DelWorker =
  | { tipo: 'cargando'; texto: string }
  /** Python ya cargó y el código empieza a correr: desde aquí cuenta el tope de tiempo */
  | { tipo: 'listo' }
  | { tipo: 'salida'; texto: string }
  | { tipo: 'error'; texto: string }
  | { tipo: 'entrada'; texto: string } // eco de lo que leyó input() / prompt()
  | { tipo: 'imagen'; png: string } // base64, p. ej. una figura de matplotlib
  /** `reiniciar`: Python quedó inservible (p. ej. desbordó la pila) y hay que crear otro worker */
  | { tipo: 'fin'; ok: boolean; reiniciar?: boolean }
