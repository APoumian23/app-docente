import { api } from './api'

/**
 * Notificaciones push del portal. El celular las recibe aunque el portal esté cerrado.
 *  - Android y computadoras: funcionan desde el navegador (mejor si se instala la app).
 *  - iPhone/iPad: solo con la app agregada a la pantalla de inicio (iOS 16.4 o más nuevo).
 */
export type EstadoPush = 'sin-soporte' | 'instalar-primero' | 'bloqueadas' | 'activas' | 'apagadas'

export const esIOS = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Abierta como app instalada (no en una pestaña del navegador). */
export const instalada = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

const hayServiceWorker = (): boolean => 'serviceWorker' in navigator && window.isSecureContext

/** Registra el service worker (solo atiende notificaciones; no guarda nada en caché). */
export function registrarServiceWorker(): void {
  if (!hayServiceWorker()) return
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('[push] service worker', e))
}

async function suscripcionActual(): Promise<PushSubscription | null> {
  if (!hayServiceWorker() || !('PushManager' in window)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

export async function estadoPush(): Promise<EstadoPush> {
  if (esIOS() && !instalada()) return 'instalar-primero'
  if (!hayServiceWorker() || !('PushManager' in window) || !('Notification' in window)) return 'sin-soporte'
  if (Notification.permission === 'denied') return 'bloqueadas'
  const s = await suscripcionActual()
  if (!s || Notification.permission !== 'granted') return 'apagadas'
  // Este dispositivo pudo quedar ligado a otra cuenta (celular compartido): cuenta solo si el servidor lo tiene para esta sesión
  const r = await api<{ activa: boolean }>('/push/revisar', { metodo: 'POST', cuerpo: { endpoint: s.endpoint } }).catch(() => ({ activa: false }))
  return r.activa ? 'activas' : 'apagadas'
}

const aBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const base = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const texto = atob(base)
  const bytes = new Uint8Array(new ArrayBuffer(texto.length))
  for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i)
  return bytes
}

const nombreDispositivo = (): string => {
  const ua = navigator.userAgent
  const sistema = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Otro'
  return `${sistema}${instalada() ? ' · app' : ' · navegador'}`
}

/** Pide el permiso (debe llamarse desde un toque del usuario) y registra este dispositivo. */
export async function activarPush(): Promise<EstadoPush> {
  if (esIOS() && !instalada()) return 'instalar-primero'
  if (!hayServiceWorker() || !('PushManager' in window)) return 'sin-soporte'
  const permiso = await Notification.requestPermission()
  if (permiso !== 'granted') return permiso === 'denied' ? 'bloqueadas' : 'apagadas'
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'))
  await navigator.serviceWorker.ready
  const { publica } = await api<{ publica: string }>('/push/clave')
  let s = await reg.pushManager.getSubscription()
  // Si el servidor cambió de llaves, la suscripción vieja ya no sirve: se rehace
  if (s && s.options.applicationServerKey) {
    const actual = new Uint8Array(s.options.applicationServerKey)
    const nueva = aBytes(publica)
    if (actual.length !== nueva.length || actual.some((b, i) => b !== nueva[i])) {
      await s.unsubscribe()
      s = null
    }
  }
  s ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: aBytes(publica) })
  await api('/push/suscripciones', { metodo: 'POST', cuerpo: { suscripcion: s.toJSON(), dispositivo: nombreDispositivo() } })
  return 'activas'
}

export async function apagarPush(): Promise<void> {
  const s = await suscripcionActual()
  if (!s) return
  await api('/push/suscripciones', { metodo: 'DELETE', cuerpo: { endpoint: s.endpoint } }).catch(() => undefined)
  await s.unsubscribe().catch(() => undefined)
}

/** Al cerrar sesión: este dispositivo deja de recibir los avisos de esta cuenta (el permiso del navegador se queda). */
export async function olvidarEnServidor(): Promise<void> {
  const s = await suscripcionActual().catch(() => null)
  if (s) await api('/push/suscripciones', { metodo: 'DELETE', cuerpo: { endpoint: s.endpoint } }).catch(() => undefined)
}

/** Al entrar con el permiso ya dado: vuelve a ligar este dispositivo a la cuenta (por si cambió de usuario o se borró). */
export async function refrescarPush(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const s = await suscripcionActual().catch(() => null)
  if (s) await api('/push/suscripciones', { metodo: 'POST', cuerpo: { suscripcion: s.toJSON(), dispositivo: nombreDispositivo() } }).catch(() => undefined)
}

// ---------- Instalar como app (Android y computadoras con Chrome/Edge) ----------

interface EventoInstalar extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let invitacion: EventoInstalar | null = null
const avisos = new Set<() => void>()

/** El navegador avisa que se puede instalar; se guarda para ofrecer el botón «Instalar app» cuando el usuario quiera. */
export function escucharInstalacion(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    invitacion = e as EventoInstalar
    avisos.forEach((f) => f())
  })
  window.addEventListener('appinstalled', () => {
    invitacion = null
    avisos.forEach((f) => f())
  })
}

export const sePuedeInstalar = (): boolean => invitacion !== null
export const alCambiarInstalacion = (f: () => void): (() => void) => {
  avisos.add(f)
  return () => void avisos.delete(f)
}

export async function instalarApp(): Promise<boolean> {
  if (!invitacion) return false
  await invitacion.prompt()
  const { outcome } = await invitacion.userChoice
  invitacion = null
  avisos.forEach((f) => f())
  return outcome === 'accepted'
}
