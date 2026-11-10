import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { avisar } from '../components/Aviso'

/** Accesos de arriba: las pantallas del panel que más se usan */
const ACCESOS: [string, string][] = [
  ['/docente/entregas', '📊 Entregas en vivo'],
  ['/docente', '▤ Materias y publicar'],
  ['/docente/notificaciones', '🔔 Avisos']
]

/** En la versión web el panel es este mismo sitio: va en un iframe (la sesión del docente ya vale ahí) */
const WEB = window.api.plataforma === 'web'

/** El <webview> de Electron (solo existe en la app; el proceso principal limita a qué puede entrar) */
type Vista = HTMLElement & { reload: () => void; loadURL: (u: string) => Promise<void>; getURL: () => string; canGoBack: () => boolean; goBack: () => void }

/**
 * El panel docente del portal (publicar, entregas en vivo, bloqueo de exámenes, avisos) dentro de la ventana
 * de la app: sin abrir el navegador ni otra ventana. Llega aquí con ?ruta=/docente/…
 */
export default function PanelPortal(): JSX.Element {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const ruta = params.get('ruta') || '/docente/entregas'
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const vista = useRef<Vista | null>(null)

  useEffect(() => {
    let vivo = true
    setError('')
    api.portal
      .urlPanel(ruta)
      .then((u) => {
        if (!vivo) return
        // Si ya está abierto, solo cambia de pantalla (no se crea otro panel)
        if (!WEB && vista.current && url) void vista.current.loadURL(u).catch(() => undefined)
        else setUrl(u)
      })
      .catch((e: Error) => vivo && setError(e.message))
    return () => {
      vivo = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruta])

  const ir = (r: string): void => {
    void nav(`/panel?ruta=${encodeURIComponent(r)}`)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="arrastre flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-200 bg-white px-4 py-2 sm:px-6">
        <h1 className="mr-2 text-lg font-bold text-ink-900">Panel del portal</h1>
        <div className="no-arrastre flex flex-wrap gap-1.5">
          {ACCESOS.map(([r, t]) => (
            <button key={r} className={ruta === r ? 'btn-primario py-1 text-sm' : 'btn-secundario py-1 text-sm'} onClick={() => ir(r)}>
              {t}
            </button>
          ))}
        </div>
        <div className="no-arrastre ml-auto flex gap-1.5">
          <button className="btn-fantasma py-1 text-sm" title="Volver a la pantalla anterior del panel" onClick={() => vista.current?.canGoBack() && vista.current.goBack()}>
            ← Atrás
          </button>
          <button className="btn-fantasma py-1 text-sm" title="Recargar el panel" onClick={() => vista.current?.reload()}>
            ↻
          </button>
          <button
            className="btn-fantasma py-1 text-sm"
            title="Abrir esta pantalla en el navegador"
            onClick={() => {
              const actual = vista.current?.getURL()
              const r = actual ? new URL(actual).pathname : ruta
              api.portal.abrirPanel(r, 'navegador').catch((e: Error) => avisar(e.message, 'error'))
            }}
          >
            ↗
          </button>
        </div>
      </div>
      {error ? (
        <div className="m-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {error}
        </div>
      ) : !url ? (
        <div className="p-8 text-ink-500">Abriendo el panel…</div>
      ) : WEB ? (
        <iframe src={url} title="Panel del portal" className="min-h-0 w-full flex-1 border-0 bg-white" />
      ) : (
        // partition propia: la sesión del panel se queda en la app y no se mezcla con la de los alumnos
        <webview ref={(el) => (vista.current = el as Vista | null)} src={url} partition="persist:panel-docente" className="min-h-0 w-full flex-1" />
      )}
    </div>
  )
}
