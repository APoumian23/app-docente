import { format, parseISO, addDays, startOfWeek, differenceInCalendarWeeks } from 'date-fns'
import { es } from 'date-fns/locale'

export const ZONA = 'America/Mexico_City'
export const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']
export const DIAS_CORTOS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

/** Fecha/hora actual en Ciudad de México como partes. */
export function ahoraMx(): { fecha: string; hora: string; dia: number; minutos: number; date: Date } {
  const d = new Date()
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' }).formatToParts(d)
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]))
  const hh = p.hour === '24' ? '00' : p.hour
  const mapa: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${hh}:${p.minute}`, dia: mapa[p.weekday] ?? 1, minutos: Number(hh) * 60 + Number(p.minute), date: d }
}

export function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function fmtMinSeg(totalSeg: number): string {
  const neg = totalSeg < 0
  const s = Math.abs(Math.round(totalSeg))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function fmtFechaLarga(iso: string): string {
  return format(parseISO(iso), "EEEE d 'de' MMMM", { locale: es })
}

export function fmtFechaCorta(iso: string): string {
  return format(parseISO(iso), 'd MMM', { locale: es })
}

export function semanaDelPeriodo(fechaInicio: string, fecha: string): number {
  return differenceInCalendarWeeks(parseISO(fecha), parseISO(fechaInicio), { weekStartsOn: 1 }) + 1
}

export function lunesDe(fecha: string): string {
  return format(startOfWeek(parseISO(fecha), { weekStartsOn: 1 }), 'yyyy-MM-dd')
}

export function sumarDias(fecha: string, n: number): string {
  return format(addDays(parseISO(fecha), n), 'yyyy-MM-dd')
}

/** Día de hoy en Ciudad de México (YYYY-MM-DD). No usar toISOString(): da el día en UTC. */
export function hoyIso(): string {
  return ahoraMx().fecha
}

// SQLite guarda 'YYYY-MM-DD HH:MM:SS' en UTC sin zona; una fecha sola se toma a mediodía para que no cambie de día
function aDate(t: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(`${t}T12:00:00`)
  return new Date(t.replace(' ', 'T') + (/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? '' : 'Z'))
}

/** Fecha (y hora) legible en Ciudad de México a partir de un timestamp de SQLite. */
export function fmtFechaMx(t: string | null | undefined, conHora = true): string {
  if (!t) return '—'
  return aDate(t).toLocaleString('es-MX', { timeZone: ZONA, dateStyle: 'medium', ...(conHora ? { timeStyle: 'short' } : {}) })
}

/** Día (YYYY-MM-DD) en Ciudad de México de un timestamp UTC de SQLite. */
export function diaMx(t: string | null | undefined): string {
  if (!t) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(aDate(t))
}
