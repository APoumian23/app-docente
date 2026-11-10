import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { Chip } from '../../componentes/ui'
import type { EstadoIntento, MostrarRespuestas, TipoEventoIntegridad } from '@shared/portal'
import type { Materia } from '@shared/types'

/** Piezas que comparten las pantallas del docente. */

/** Con su periodo (inicio y semanas): «Ocultar» se ofrece hasta que termina */
export type MateriaDocente = Materia & { inscritos: number; oculta: number; periodo_inicio?: string | null; periodo_semanas?: number | null }

export type EstadoEntrega = EstadoIntento | 'sin_iniciar'

const ESTADOS: Record<EstadoEntrega, { texto: string; tono: 'gris' | 'ambar' | 'azul' | 'verde' }> = {
  sin_iniciar: { texto: 'Sin iniciar', tono: 'gris' },
  en_curso: { texto: 'En curso', tono: 'ambar' },
  borrador: { texto: 'Borrador', tono: 'ambar' },
  enviado: { texto: 'Enviado', tono: 'azul' },
  calificado: { texto: 'Calificado', tono: 'verde' }
}

export function ChipEstado({ estado }: { estado: EstadoEntrega }): JSX.Element {
  const e = ESTADOS[estado] ?? { texto: estado, tono: 'gris' as const }
  return <Chip tono={e.tono}>{e.texto}</Chip>
}

export const ETIQUETA_EVENTO: Record<TipoEventoIntegridad, string> = {
  salio_pestana: 'Salió de la pestaña',
  volvio_pestana: 'Volvió a la pestaña',
  perdio_foco: 'Cambió de aplicación',
  recupero_foco: 'Regresó a la aplicación',
  salio_pantalla_completa: 'Salió de pantalla completa',
  volvio_pantalla_completa: 'Volvió a pantalla completa',
  mouse_fuera: 'Sacó el cursor de la pantalla del examen (¿otro monitor?)',
  mouse_volvio: 'Regresó el cursor al examen',
  copiar: 'Copió texto',
  pegar: 'Pegó texto',
  recarga: 'Recargó la página',
  cerrado_por_salidas: 'Examen cerrado por salir dos veces',
  captura_pantalla: 'Intentó tomar una captura de pantalla'
}

export const ETIQUETA_TIPO_PREGUNTA: Record<string, string> = {
  opcion_multiple: 'Opción múltiple',
  verdadero_falso: 'Verdadero / falso',
  abierta: 'Abierta',
  problema: 'Problema',
  codigo: 'Código',
  cuaderno: 'Cuaderno de Jupyter'
}

/** Mismo aspecto que el input de `Campo`, para select y textarea. */
export const CLASE_ENTRADA = 'w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-base text-ink-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/40 min-h-[44px]'

export function Etiqueta({ texto, children, className = '' }: { texto: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-400">{texto}</span>
      {children}
    </label>
  )
}

export function Selector({ etiqueta, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement> & { etiqueta?: string }): JSX.Element {
  const select = <select className={`${CLASE_ENTRADA} ${etiqueta ? '' : className}`} {...props} />
  return etiqueta ? <Etiqueta texto={etiqueta} className={className}>{select}</Etiqueta> : select
}

export function AreaTexto({ etiqueta, className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { etiqueta?: string }): JSX.Element {
  const area = <textarea className={`${CLASE_ENTRADA} min-h-[96px] ${etiqueta ? '' : className}`} {...props} />
  return etiqueta ? <Etiqueta texto={etiqueta} className={className}>{area}</Etiqueta> : area
}

export function Casilla({ etiqueta, detalle, marcada, onCambio }: { etiqueta: string; detalle?: string; marcada: boolean; onCambio: (v: boolean) => void }): JSX.Element {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border border-ink-200 bg-white px-3 py-2.5">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand-500" checked={marcada} onChange={(e) => onCambio(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-800">{etiqueta}</span>
        {detalle && <span className="block text-xs text-ink-500">{detalle}</span>}
      </span>
    </label>
  )
}

/** Mensaje de error del servidor, visible y sin desbordar. */
export function ErrorServidor({ texto }: { texto: string }): JSX.Element | null {
  if (!texto) return null
  return <div className="break-words rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{texto}</div>
}

/** Genera un CSV (UTF-8 con BOM para que Excel lo abra bien) y lo descarga desde el navegador. */
export function descargarCsv(nombre: string, columnas: string[], filas: (string | number | null | undefined)[][]): void {
  const escapar = (v: string | number | null | undefined): string => {
    const t = v === null || v === undefined ? '' : String(v)
    return /[",\n;]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const texto = [columnas, ...filas].map((f) => f.map(escapar).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF' + texto], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Partes de una fecha en hora de Ciudad de México, para armar rangos YYYY-MM-DD. */
export function partesMx(d = new Date()): { anio: number; mes: number; dia: number; diaSemana: number } {
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(d)
  const leer = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? ''
  const semana: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { anio: Number(leer('year')), mes: Number(leer('month')), dia: Number(leer('day')), diaSemana: semana[leer('weekday')] ?? 0 }
}

export function aIsoDia(anio: number, mes: number, dia: number): string {
  // Date.UTC normaliza desbordes (día 0, mes 13) sin depender de la zona local
  return new Date(Date.UTC(anio, mes - 1, dia)).toISOString().slice(0, 10)
}

/** Fecha local como valor para <input type="datetime-local">. */
export function aDatetimeLocal(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function numeroOSinDatos(n: number | null | undefined, decimales = 1): string {
  return n === null || n === undefined ? '—' : n.toFixed(decimales).replace(/\.0+$/, '')
}

/** Cuándo ve el alumno qué contestó bien y mal, con la respuesta correcta y la explicación */
export const OPCIONES_RESPUESTAS: [MostrarRespuestas, string][] = [
  ['al_cerrar', 'Al cerrar la actividad (recomendado)'],
  ['al_enviar', 'En cuanto envíe'],
  ['no', 'No mostrarlas']
]
