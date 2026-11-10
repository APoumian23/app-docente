import { useEffect, useId, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import trabajador from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { api } from '../lib/api'
import { avisar } from './ui'

pdfjs.GlobalWorkerOptions.workerSrc = trabajador

/**
 * Vista previa de un material dentro del portal, con opción a descargarlo. Los PDF se dibujan con pdf.js
 * página por página: en Android un PDF dentro de un marco no se ve y en iPhone solo sale la primera hoja.
 */
export default function VisorArchivo({ ruta, titulo, nombre, tipo, onCerrar }: { ruta: string; titulo: string; nombre: string; tipo: 'pdf' | 'imagen'; onCerrar: () => void }): JSX.Element {
  const idTitulo = useId()
  const [blob, setBlob] = useState<Blob | null>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [zoom, setZoom] = useState(1)
  const [urlImagen, setUrlImagen] = useState('')
  const cerrar = useRef(onCerrar)
  cerrar.current = onCerrar

  // Se baja una sola vez: el mismo archivo sirve para verlo y para descargarlo
  useEffect(() => {
    let vivo = true
    let tarea: ReturnType<typeof pdfjs.getDocument> | null = null
    let url = ''
    api<Blob>(ruta)
      .then(async (b) => {
        if (!vivo) return
        setBlob(b)
        if (tipo === 'imagen') {
          url = URL.createObjectURL(b)
          setUrlImagen(url)
          return
        }
        tarea = pdfjs.getDocument({ data: new Uint8Array(await b.arrayBuffer()) })
        const cargado = await tarea.promise
        if (vivo) setDoc(cargado)
      })
      .catch((e: Error) => vivo && setError(e.message || 'No se pudo abrir el archivo.'))
    return () => {
      vivo = false
      void tarea?.destroy()
      if (url) URL.revokeObjectURL(url)
    }
  }, [ruta, tipo])

  // Esc cierra y la página de atrás no se desplaza mientras está abierto
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cerrar.current()
    }
    window.addEventListener('keydown', tecla)
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', tecla)
      document.body.style.overflow = previo
    }
  }, [])

  const descargar = (): void => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nombre
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    avisar('Descargando…')
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ink-900/95" role="dialog" aria-modal="true" aria-labelledby={idTitulo}>
      <div className="flex items-center gap-1 bg-white px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] shadow-sm sm:gap-2 sm:px-4">
        <button className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg text-ink-600 hover:bg-ink-100" onClick={onCerrar} aria-label="Cerrar la vista previa">
          ✕
        </button>
        <div className="min-w-0 flex-1">
          <h2 id={idTitulo} className="truncate text-sm font-semibold text-ink-900">{titulo}</h2>
          {doc && <div className="text-xs text-ink-500">{doc.numPages === 1 ? '1 página' : `${doc.numPages} páginas`}</div>}
        </div>
        {tipo === 'pdf' && (
          <div className="hidden items-center sm:flex" aria-label="Tamaño">
            <button className="flex h-11 w-11 items-center justify-center rounded-xl text-ink-600 hover:bg-ink-100 disabled:opacity-40" disabled={zoom <= 0.6} onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(1)))} aria-label="Reducir">
              −
            </button>
            <span className="w-11 text-center text-xs text-ink-500">{Math.round(zoom * 100)}%</span>
            <button className="flex h-11 w-11 items-center justify-center rounded-xl text-ink-600 hover:bg-ink-100 disabled:opacity-40" disabled={zoom >= 2.4} onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.2).toFixed(1)))} aria-label="Ampliar">
              +
            </button>
          </div>
        )}
        <button className="min-h-[44px] shrink-0 rounded-xl bg-brand-500 px-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50" disabled={!blob} onClick={descargar}>
          Descargar
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        {error ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-white">{error}</div>
        ) : tipo === 'imagen' ? (
          urlImagen ? (
            <div className="flex min-h-full items-center justify-center p-2">
              <img src={urlImagen} alt={titulo} className="max-w-full" />
            </div>
          ) : (
            <Cargando />
          )
        ) : !doc ? (
          <Cargando />
        ) : (
          <div className="mx-auto space-y-3 px-2 py-3 sm:px-4" style={{ maxWidth: `${Math.round(900 * zoom)}px` }}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <Pagina key={i} doc={doc} numero={i + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Cargando(): JSX.Element {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-white/80">Abriendo el archivo…</div>
}

/** Una página: se dibuja al acercarse a la pantalla y al ancho disponible (nítida en pantallas de alta densidad) */
function Pagina({ doc, numero }: { doc: PDFDocumentProxy; numero: number }): JSX.Element {
  const caja = useRef<HTMLDivElement>(null)
  const lienzo = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(numero <= 2)
  const [proporcion, setProporcion] = useState(1.294)
  const [ancho, setAncho] = useState(0)

  useEffect(() => {
    void doc.getPage(numero).then((p) => {
      const v = p.getViewport({ scale: 1 })
      setProporcion(v.height / v.width)
    })
  }, [doc, numero])

  useEffect(() => {
    const el = caja.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '600px 0px' })
    obs.observe(el)
    const medir = new ResizeObserver(([e]) => setAncho(Math.round(e.contentRect.width)))
    medir.observe(el)
    return () => {
      obs.disconnect()
      medir.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!visible || !ancho || !lienzo.current) return
    let tarea: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null
    let vivo = true
    void doc.getPage(numero).then((p) => {
      if (!vivo || !lienzo.current) return
      const base = p.getViewport({ scale: 1 })
      // Tope de densidad: en celulares con pantalla 3x una página grande pesaría demasiado
      const densidad = Math.min(window.devicePixelRatio || 1, 2.5)
      const vista = p.getViewport({ scale: (ancho / base.width) * densidad })
      const c = lienzo.current
      c.width = Math.floor(vista.width)
      c.height = Math.floor(vista.height)
      tarea = p.render({ canvas: c, viewport: vista })
      tarea.promise.catch(() => undefined)
    })
    return () => {
      vivo = false
      tarea?.cancel()
    }
  }, [doc, numero, visible, ancho])

  return (
    <div ref={caja} className="relative w-full overflow-hidden rounded bg-white shadow" style={{ aspectRatio: `1 / ${proporcion}` }}>
      <canvas ref={lienzo} className="block h-full w-full" aria-label={`Página ${numero}`} />
      <span className="absolute bottom-1 right-2 rounded bg-ink-900/60 px-1.5 text-[11px] text-white">{numero}</span>
    </div>
  )
}
