import { useEffect, useState } from 'react'
import { api } from '../lib/api'

let escuchador: ((m: string, tipo: 'ok' | 'error') => void) | null = null
export function avisar(m: string, tipo: 'ok' | 'error' = 'ok'): void {
  escuchador?.(m, tipo)
}

export default function Aviso(): JSX.Element | null {
  const [msg, setMsg] = useState<{ m: string; tipo: 'ok' | 'error' } | null>(null)
  useEffect(() => {
    let timer: number | undefined
    escuchador = (m, tipo) => {
      // Cada aviso trae su propio plazo: el temporizador del anterior ya no lo cierra
      window.clearTimeout(timer)
      setMsg({ m, tipo })
      timer = window.setTimeout(() => setMsg(null), tipo === 'error' ? 6000 : 3000)
    }
    // Red de seguridad: cualquier llamada al proceso principal que falle sin atraparse se muestra,
    // en vez de dejar un botón que "no hace nada"
    const sinAtrapar = (e: PromiseRejectionEvent): void => {
      const r = e.reason
      const mensaje = r instanceof Error ? r.message : String(r ?? 'Error desconocido')
      avisar(mensaje, 'error')
      // Las fallas de una llamada al proceso principal ya quedaron anotadas allá
      if (!(r as { desdeIpc?: boolean } | null)?.desdeIpc) api.errores.registrar('pantalla', `promesa sin atrapar en ${location.hash || '#/'}`, mensaje, r instanceof Error ? (r.stack ?? '') : '')
    }
    // Errores de JavaScript que no pasan por una promesa (un clic que truena, un temporizador…)
    const errorJs = (e: ErrorEvent): void => {
      const mensaje = e.message || 'Error desconocido'
      // Ruido conocido del navegador, no es una falla
      if (/ResizeObserver loop/.test(mensaje)) return
      avisar(mensaje, 'error')
      api.errores.registrar('pantalla', `error en ${location.hash || '#/'}`, mensaje, e.error instanceof Error ? (e.error.stack ?? '') : `${e.filename}:${e.lineno}:${e.colno}`)
    }
    window.addEventListener('unhandledrejection', sinAtrapar)
    window.addEventListener('error', errorJs)
    return () => {
      escuchador = null
      window.clearTimeout(timer)
      window.removeEventListener('unhandledrejection', sinAtrapar)
      window.removeEventListener('error', errorJs)
    }
  }, [])
  if (!msg) return null
  return (
    <div role={msg.tipo === 'error' ? 'alert' : 'status'} className={`fixed bottom-5 right-5 left-5 sm:left-auto sm:max-w-md z-[60] rounded-lg px-4 py-2.5 text-sm shadow-lg break-words ${msg.tipo === 'ok' ? 'bg-ink-900 text-white' : 'bg-red-600 text-white'}`}>{msg.m}</div>
  )
}
