import { useEffect, useId, useState } from 'react'
import { api } from '../lib/api'
import { avisar } from './Aviso'
import type { VistaMaterial } from '@shared/types'

/**
 * Visor de un material dentro de la app (Materias › Materiales › Abrir). Ocupa casi toda la ventana;
 * «Abrir con otra app» queda como salida para lo que aquí no se puede mostrar o editar.
 */
export default function VisorMaterial({ material, onCerrar }: { material: { id: number; titulo: string; ruta: string }; onCerrar: () => void }): JSX.Element {
  const idTitulo = useId()
  const [v, setV] = useState<VistaMaterial | null>(null)
  const [error, setError] = useState('')
  const [convirtiendo, setConvirtiendo] = useState(false)
  const cargar = (): void => {
    setV(null)
    setError('')
    api.materiales.vista(material.id).then(setV, (e: Error) => setError(e.message))
  }
  useEffect(cargar, [material.id])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCerrar()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onCerrar])

  const convertir = async (): Promise<void> => {
    setConvirtiendo(true)
    try {
      await api.presentacion.convertir(material.ruta)
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setConvirtiendo(false)
    }
  }
  const fuera = (): void => void api.materiales.abrir(material.ruta)

  const marco = 'h-full w-full rounded-lg border border-ink-200 bg-white'
  let cuerpo: JSX.Element
  if (error) cuerpo = <Mensaje texto={error} rojo />
  else if (!v) cuerpo = <Mensaje texto="Preparando la vista…" />
  else if (v.tipo === 'pdf') cuerpo = <iframe title={material.titulo} src={`${v.url}#navpanes=0&view=FitH`} className={marco} />
  else if (v.tipo === 'web') cuerpo = <iframe title={material.titulo} src={v.url} className={marco} allow="fullscreen" />
  else if (v.tipo === 'imagen')
    cuerpo = (
      <div className="flex h-full w-full items-center justify-center overflow-auto rounded-lg border border-ink-200 bg-ink-50 p-2">
        <img src={v.url} alt={material.titulo} className="max-h-full max-w-full object-contain" />
      </div>
    )
  // Sin scripts ni mismo origen: el HTML de un Word o Excel solo se dibuja
  else if (v.tipo === 'html') cuerpo = <iframe title={material.titulo} srcDoc={v.html} sandbox="" className={marco} />
  else if (v.tipo === 'texto')
    cuerpo = (
      <pre className="h-full w-full overflow-auto rounded-lg bg-ink-900 p-4 text-[13px] leading-relaxed text-ink-50 select-text whitespace-pre-wrap break-words">
        {v.texto}
        {v.recortado ? '\n\n… (se muestra solo el inicio; ábrelo con otra app para verlo completo)' : ''}
      </pre>
    )
  else if (v.tipo === 'convertir' || v.tipo === 'externo')
    cuerpo = (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md space-y-3 text-center">
          <p className="text-sm text-ink-600">{v.motivo}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {v.tipo === 'convertir' && (
              <button className="btn-primario" disabled={convirtiendo} onClick={convertir}>
                {convirtiendo ? 'Convirtiendo…' : 'Convertir y ver aquí'}
              </button>
            )}
            <button className={v.tipo === 'convertir' ? 'btn-secundario' : 'btn-primario'} onClick={fuera}>
              {/^https?:/i.test(material.ruta) ? 'Abrir en el navegador' : 'Abrir con otra app'}
            </button>
          </div>
        </div>
      </div>
    )
  else cuerpo = <Mensaje texto="No se puede mostrar este material." />

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-ink-900/50 p-2 sm:p-5" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div role="dialog" aria-modal="true" aria-labelledby={idTitulo} className="tarjeta flex w-full max-w-6xl flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 px-4 py-2.5">
          <h3 id={idTitulo} className="min-w-0 flex-1 truncate font-semibold" title={material.titulo}>
            {material.titulo}
          </h3>
          {v && v.tipo !== 'externo' && v.tipo !== 'convertir' && (
            <button className="btn-fantasma text-xs py-1" onClick={fuera} title="Para editarlo o imprimirlo">
              {/^https?:/i.test(material.ruta) ? 'Abrir en el navegador' : 'Abrir con otra app'}
            </button>
          )}
          <button className="btn-fantasma shrink-0 px-2" onClick={onCerrar} aria-label="Cerrar" title="Cerrar (Esc)">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 p-2 sm:p-3">{cuerpo}</div>
      </div>
    </div>
  )
}

function Mensaje({ texto, rojo }: { texto: string; rojo?: boolean }): JSX.Element {
  return <div className={`flex h-full items-center justify-center text-sm ${rojo ? 'text-red-600' : 'text-ink-500'}`}>{texto}</div>
}
