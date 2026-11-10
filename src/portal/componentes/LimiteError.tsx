import { Component, type ErrorInfo, type ReactNode } from 'react'

const CLAVE_RECARGA = 'docente-portal.recarga-modulo'
/** Tiempo en que no se vuelve a recargar sola: si el archivo sigue sin llegar, se muestra el aviso y no se entra en ciclo. */
const VENTANA_RECARGA_MS = 60_000

/**
 * ¿Falló la descarga de una parte de la app (import dinámico)? Pasa con Wi-Fi inestable o cuando la app
 * se actualizó y el celular aún tenía la página vieja: el archivo con la huella anterior ya no existe.
 */
export function esErrorDeModulo(error: unknown): boolean {
  const texto = `${(error as { name?: string })?.name ?? ''} ${(error as Error)?.message ?? String(error ?? '')}`
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Unable to preload|Failed to load module script/i.test(texto)
}

/**
 * Recarga la página una sola vez por incidente (marca con hora en sessionStorage).
 * Devuelve false si ya se recargó hace poco: entonces toca mostrar el aviso.
 */
export function recargarPorModulo(): boolean {
  try {
    const ultima = Number(sessionStorage.getItem(CLAVE_RECARGA)) || 0
    if (Date.now() - ultima < VENTANA_RECARGA_MS) return false
    sessionStorage.setItem(CLAVE_RECARGA, String(Date.now()))
  } catch {
    // Sin sessionStorage no hay forma de evitar el ciclo: mejor mostrar el aviso
    return false
  }
  window.location.reload()
  return true
}

/**
 * Límite de errores del portal. Sin esto, si una pantalla truena o no se descarga, React desmonta todo
 * y el alumno ve una página en blanco sin botón para salir.
 */
export default class LimiteError extends Component<{ children: ReactNode }, { error: Error | null; recargando: boolean }> {
  state: { error: Error | null; recargando: boolean } = { error: null, recargando: false }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error al pintar la pantalla:', error, info.componentStack)
    if (esErrorDeModulo(error) && recargarPorModulo()) this.setState({ recargando: true })
  }

  render(): ReactNode {
    const { error, recargando } = this.state
    if (!error) return this.props.children
    const modulo = esErrorDeModulo(error)
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-ink-50 p-4">
        <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-white p-6 text-center shadow-sm" role="alert">
          <div className="text-4xl">{modulo ? '📶' : '⚠️'}</div>
          <h1 className="mt-2 text-lg font-bold text-ink-900">{recargando ? 'Actualizando…' : modulo ? 'No se pudo cargar esta pantalla' : 'Algo salió mal en esta pantalla'}</h1>
          <p className="mt-1 text-sm text-ink-500">
            {modulo
              ? 'Puede ser la conexión o que el portal se acaba de actualizar. Recarga la página para traer la versión nueva.'
              : 'No se pudo mostrar. Lo que ya guardaste no se pierde: recarga o vuelve al inicio.'}
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
              onClick={() => window.location.reload()}
            >
              Recargar
            </button>
            <button
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-ink-200 bg-white px-4 py-2.5 text-sm font-semibold text-ink-700 hover:bg-ink-100"
              onClick={() => window.location.assign('/')}
            >
              Volver al inicio
            </button>
          </div>
        </div>
      </div>
    )
  }
}
