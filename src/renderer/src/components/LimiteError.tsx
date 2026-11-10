import { Component, type ErrorInfo, type ReactNode } from 'react'
import { api } from '../lib/api'

interface Props {
  /** Ruta actual: al cambiar de pantalla desde la barra lateral se intenta pintar de nuevo. */
  ruta?: string
  /** Lleva a Hoy (lo da App porque aquí no hay enrutador a la mano). Sin él, se recarga en Hoy. */
  alInicio?: () => void
  children: ReactNode
}

/**
 * Límite de errores del contenido. Si una pantalla truena al pintarse, sin esto React desmonta
 * toda la ventana (también la barra lateral) y queda en blanco; aquí se avisa y se ofrece salida.
 */
export default class LimiteError extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error al pintar la pantalla:', error, info.componentStack)
    api.errores.registrar('pantalla', `no se pudo mostrar ${location.hash || '#/'}`, error.message || error.name, [error.stack, info.componentStack].filter(Boolean).join('\n'))
  }

  componentDidUpdate(previas: Props): void {
    if (this.state.error && previas.ruta !== this.props.ruta) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <div className="tarjeta w-full max-w-lg p-6 text-center" role="alert">
          <div className="text-3xl">⚠</div>
          <h1 className="mt-2 text-lg font-semibold text-ink-900">Esta pantalla tuvo un problema</h1>
          <p className="mt-1 text-sm text-ink-500">
            No se pudo mostrar. Tus datos están guardados: recarga la pantalla o vuelve al inicio.{this.props.alInicio ? ' El menú de la izquierda sigue funcionando.' : ''}
          </p>
          {error.message && <p className="mt-3 break-words rounded-lg bg-ink-50 px-3 py-2 font-mono text-xs text-ink-500">{error.message}</p>}
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button className="btn-primario" onClick={() => window.location.reload()}>
              Recargar
            </button>
            <button
              className="btn-secundario"
              onClick={() => {
                if (!this.props.alInicio) {
                  window.location.hash = '#/'
                  window.location.reload()
                  return
                }
                this.setState({ error: null })
                this.props.alInicio()
              }}
            >
              Volver al inicio
            </button>
          </div>
        </div>
      </div>
    )
  }
}
