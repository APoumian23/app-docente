import { useSesion } from './sesion'

/** Error con estado HTTP y código del servidor, para reaccionar en la interfaz. */
export class ErrorApi extends Error {
  constructor(
    public estado: number,
    mensaje: string,
    public codigo?: string
  ) {
    super(mensaje)
  }
}

/** Lo que se le dice a quien se le cerró la sesión, según el código del servidor. */
const MOTIVOS_CIERRE: Record<string, string> = {
  sesion_reemplazada: 'Tu cuenta se abrió en otro dispositivo, así que esta sesión se cerró.',
  password_reiniciada: 'Tu docente reinició tu contraseña. Entra de nuevo con tu matrícula.'
}

interface Opciones {
  metodo?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  cuerpo?: unknown
  form?: FormData
  sinSesion?: boolean
}

/**
 * Llamada al servidor con la sesión actual. Si el servidor responde que la sesión se cerró
 * (otro dispositivo, contraseña reiniciada, vencida), se cierra localmente y se avisa el motivo.
 */
export async function api<T>(ruta: string, op: Opciones = {}): Promise<T> {
  const cabeceras: Record<string, string> = {}
  const token = useSesion.getState().token
  if (token && !op.sinSesion) cabeceras.Authorization = `Bearer ${token}`
  if (op.cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json'
  let respuesta: Response
  try {
    respuesta = await fetch(`/api${ruta}`, { method: op.metodo ?? 'GET', headers: cabeceras, body: op.form ?? (op.cuerpo !== undefined ? JSON.stringify(op.cuerpo) : undefined) })
  } catch {
    throw new ErrorApi(0, 'Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.', 'sin_red')
  }
  const tipo = respuesta.headers.get('content-type') ?? ''
  if (!respuesta.ok) {
    const datos = tipo.includes('json') ? await respuesta.json().catch(() => ({})) : {}
    const codigo = datos.codigo as string | undefined
    if (respuesta.status === 401 && codigo !== undefined) useSesion.getState().cerrar(MOTIVOS_CIERRE[codigo] ?? 'Tu sesión terminó. Vuelve a entrar.')
    throw new ErrorApi(respuesta.status, (datos.error as string) ?? `Error ${respuesta.status}`, codigo)
  }
  if (tipo.includes('json')) return (await respuesta.json()) as T
  return (await respuesta.blob()) as unknown as T
}

/** Descarga un archivo autenticado y lo abre en el navegador. */
export async function descargar(ruta: string, nombre: string): Promise<void> {
  const blob = await api<Blob>(ruta)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Fecha guardada en UTC mostrada en hora de Ciudad de México. */
export function fechaMx(texto: string | null | undefined, conHora = true): string {
  if (!texto) return ''
  const t = texto.trim()
  const d = new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return texto
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', ...(conHora ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(d)
}

/** Segundos entre dos fechas guardadas en UTC sin zona («YYYY-MM-DD HH:MM:SS»); hasta ahora si falta la segunda */
export function segundosEntre(desde: string | null | undefined, hasta?: string | null): number | null {
  if (!desde) return null
  const f = (t: string): number => new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z').getTime()
  const a = f(desde)
  const b = hasta ? f(hasta) : Date.now()
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, Math.round((b - a) / 1000))
}

export function duracion(segundos: number): string {
  const s = Math.max(0, Math.round(segundos))
  const m = Math.floor(s / 60)
  if (m < 1) return `${s} s`
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}
