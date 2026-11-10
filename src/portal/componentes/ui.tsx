import { useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'

/** Piezas de interfaz del portal. Mobile primero: todo cabe en 360 px de ancho. */

export function Boton({ variante = 'primario', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: 'primario' | 'secundario' | 'peligro' | 'fantasma' }): JSX.Element {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 focus-visible:ring-offset-1 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]'
  const estilos = {
    primario: 'bg-brand-500 text-white hover:bg-brand-600',
    secundario: 'bg-white border border-ink-200 text-ink-700 hover:bg-ink-100',
    peligro: 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100',
    fantasma: 'text-ink-600 hover:bg-ink-100'
  }
  return <button className={`${base} ${estilos[variante]} ${className}`} {...props} />
}

export function Campo({ etiqueta, error, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { etiqueta?: string; error?: string }): JSX.Element {
  return (
    <label className={`block ${className}`}>
      {etiqueta && <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-400">{etiqueta}</span>}
      <input className={`w-full rounded-xl border bg-white px-3 py-2.5 text-base text-ink-800 outline-none focus:ring-2 focus:ring-brand-400/40 min-h-[44px] ${error ? 'border-red-400' : 'border-ink-200 focus:border-brand-400'}`} {...props} />
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  )
}

/** Contraseña con botón para verla mientras se escribe (en el celular es fácil equivocarse). */
export function CampoPassword({ etiqueta, error, className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { etiqueta?: string; error?: string }): JSX.Element {
  const [ver, setVer] = useState(false)
  return (
    <label className={`block ${className}`}>
      {etiqueta && <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-400">{etiqueta}</span>}
      <span className="relative block">
        <input
          type={ver ? 'text' : 'password'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`w-full rounded-xl border bg-white py-2.5 pl-3 pr-24 text-base text-ink-800 outline-none focus:ring-2 focus:ring-brand-400/40 min-h-[44px] ${error ? 'border-red-400' : 'border-ink-200 focus:border-brand-400'}`}
          {...props}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex min-w-[44px] items-center gap-1 rounded-r-xl px-3 text-sm font-semibold text-brand-600 hover:bg-brand-500/5"
          onClick={() => setVer((v) => !v)}
          aria-label={ver ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          aria-pressed={ver}
        >
          <span aria-hidden>{ver ? '🙈' : '👁'}</span> {ver ? 'Ocultar' : 'Ver'}
        </button>
      </span>
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  )
}

export function Tarjeta({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }): JSX.Element {
  return <div id={id} className={`rounded-2xl border border-ink-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>
}

export function Chip({ children, tono = 'gris' }: { children: ReactNode; tono?: 'gris' | 'verde' | 'ambar' | 'rojo' | 'azul' | 'morado' }): JSX.Element {
  const tonos = { gris: 'bg-ink-100 text-ink-600', verde: 'bg-green-100 text-green-700', ambar: 'bg-amber-100 text-amber-700', rojo: 'bg-red-100 text-red-700', azul: 'bg-sky-100 text-sky-700', morado: 'bg-violet-100 text-violet-700' }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tonos[tono]}`}>{children}</span>
}

export function Cargando({ texto = 'Cargando…' }: { texto?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-ink-400">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
      <span className="text-sm">{texto}</span>
    </div>
  )
}

/** Estado vacío: qué pasa y, si aplica, qué hacer (`children` = acción, p. ej. «Quitar filtros»). */
export function Vacio({ titulo, detalle, icono, children }: { titulo: string; detalle?: string; icono?: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="rounded-2xl border border-dashed border-ink-200 px-6 py-10 text-center">
      {icono && <div className="mb-2 text-3xl leading-none" aria-hidden>{icono}</div>}
      <div className="font-medium text-ink-700">{titulo}</div>
      {detalle && <div className="mx-auto mt-1 max-w-sm text-sm text-ink-500">{detalle}</div>}
      {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

/** Título de pantalla con sus acciones a la derecha (se acomodan abajo si no caben). */
export function EncabezadoPagina({ titulo, detalle, children }: { titulo: string; detalle?: ReactNode; children?: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="min-w-0 text-xl font-bold text-ink-900">{titulo}</h2>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
      {detalle && <p className="text-sm text-ink-600">{detalle}</p>}
    </div>
  )
}

/** Falla al cargar: qué no se pudo, por qué y un botón para reintentar. */
export function ErrorCarga({ titulo, detalle, onReintentar }: { titulo: string; detalle?: string | null; onReintentar?: () => void }): JSX.Element {
  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      <div className="font-semibold">{titulo}</div>
      {detalle && <div className="mt-1 break-words">{detalle}</div>}
      {onReintentar && (
        <Boton variante="secundario" className="mt-3" onClick={onReintentar}>
          Intentar de nuevo
        </Boton>
      )}
    </div>
  )
}

/** Fecha que manda el servidor («2026-10-27 18:00:00» en UTC o ISO) como `Date`; null si no se entiende. */
export function aFecha(texto: string | null | undefined): Date | null {
  if (!texto) return null
  const t = texto.trim()
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z')
  return Number.isNaN(d.getTime()) ? null : d
}

/** «Quedan 5 h» / «Quedan 2 días» cuando algo cierra en los próximos tres días; null si falta más o ya pasó. */
export function urgencia(texto: string | null | undefined, ahora = Date.now()): { texto: string; tono: 'rojo' | 'ambar' } | null {
  const d = aFecha(texto)
  if (!d) return null
  const min = (d.getTime() - ahora) / 60_000
  if (min <= 0 || min > 72 * 60) return null
  if (min < 60) return { texto: `Quedan ${Math.max(1, Math.floor(min))} min`, tono: 'rojo' }
  if (min < 24 * 60) {
    const h = Math.floor(min / 60)
    return { texto: h === 1 ? 'Queda 1 h' : `Quedan ${h} h`, tono: 'rojo' }
  }
  const dias = Math.floor(min / (24 * 60))
  return { texto: dias === 1 ? 'Queda 1 día' : `Quedan ${dias} días`, tono: 'ambar' }
}

/** Avisos flotantes. `avisar()` se puede llamar desde cualquier parte. */
type Aviso = { id: number; texto: string; tipo: 'ok' | 'error' | 'info' }
let escuchador: ((a: Aviso) => void) | null = null
let contador = 0
export function avisar(texto: string, tipo: Aviso['tipo'] = 'ok'): void {
  escuchador?.({ id: ++contador, texto, tipo })
}

export function Avisos(): JSX.Element {
  const [lista, setLista] = useState<Aviso[]>([])
  useEffect(() => {
    escuchador = (a) => {
      setLista((l) => [...l, a])
      setTimeout(() => setLista((l) => l.filter((x) => x.id !== a.id)), a.tipo === 'error' ? 7000 : 3500)
    }
    return () => {
      escuchador = null
    }
  }, [])
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-20 z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end">
      {lista.map((a) => (
        <div key={a.id} className={`pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm shadow-lg ${a.tipo === 'error' ? 'bg-red-600 text-white' : a.tipo === 'info' ? 'bg-sky-700 text-white' : 'bg-ink-900 text-white'}`}>
          {a.texto}
        </div>
      ))}
    </div>
  )
}

export function Modal({ abierto, titulo, onCerrar, children }: { abierto: boolean; titulo: string; onCerrar: () => void; children: ReactNode }): JSX.Element | null {
  const idTitulo = useId()
  // En una referencia para que el oyente de Esc no se reinstale con cada pintado del padre
  const cerrar = useRef(onCerrar)
  cerrar.current = onCerrar
  useEffect(() => {
    if (!abierto) return
    const tecla = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cerrar.current()
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [abierto])
  if (!abierto) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div role="dialog" aria-modal="true" aria-labelledby={idTitulo} className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white sm:max-w-lg sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-ink-100 bg-white px-5 py-3">
          <h3 id={idTitulo} className="font-semibold">{titulo}</h3>
          <button className="-mr-2 flex h-11 w-11 items-center justify-center rounded-xl text-ink-500 hover:bg-ink-100" onClick={onCerrar} aria-label="Cerrar">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Estadistica({ valor, etiqueta }: { valor: ReactNode; etiqueta: string }): JSX.Element {
  return (
    <div className="rounded-xl bg-ink-50 px-3 py-2">
      <div className="text-lg font-bold text-ink-900">{valor}</div>
      <div className="text-xs text-ink-500">{etiqueta}</div>
    </div>
  )
}
