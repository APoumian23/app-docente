import { create } from 'zustand'
import type { Usuario } from '@shared/portal'

const CLAVE = 'docente-portal.sesion'
/** Usuario recordado para llenar «Usuario o matrícula» la próxima vez */
export const CLAVE_USUARIO = 'docente-portal.usuario-recordado'

interface EstadoSesion {
  token: string | null
  usuario: Usuario | null
  aviso: string | null
  /** `recordar = false`: la sesión vive solo mientras el navegador siga abierto (computadoras compartidas) */
  entrar: (token: string, usuario: Usuario, recordar?: boolean) => void
  actualizarUsuario: (u: Usuario) => void
  cerrar: (aviso?: string) => void
  limpiarAviso: () => void
}

/** Dónde vive la sesión: localStorage si pidió que se le recuerde; si no, sessionStorage (se borra al cerrar el navegador). */
const almacen = (): Storage | null => {
  try {
    if (localStorage.getItem(CLAVE)) return localStorage
    if (sessionStorage.getItem(CLAVE)) return sessionStorage
  } catch {
    /* sin almacenamiento */
  }
  return null
}

function leer(): { token: string | null; usuario: Usuario | null } {
  try {
    const raw = almacen()?.getItem(CLAVE)
    if (raw) return JSON.parse(raw)
  } catch {
    /* sin almacenamiento */
  }
  return { token: null, usuario: null }
}

/**
 * Pista (no es la sesión) para que el servidor sirva la app completa en la raíz cuando entra un docente; los
 * alumnos ven ahí su portal. Se borra con cualquier otra sesión o al salir.
 */
export function pistaApp(usuario: Usuario | null): void {
  try {
    document.cookie = usuario?.rol === 'docente' ? 'docente_app=1; Path=/; Max-Age=2592000; SameSite=Lax; Secure' : 'docente_app=; Path=/; Max-Age=0; SameSite=Lax; Secure'
  } catch {
    /* sin cookies: el docente usa el panel */
  }
}

/** Fuera de un marco (el panel dentro de la app va en un iframe): ahí no se abre otra app encima */
export const enMarco = (): boolean => {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

/** Docente fuera de la app: a la raíz, donde el servidor ya le sirve la app completa. */
export function irAlApp(usuario: Usuario | null): void {
  pistaApp(usuario)
  window.location.replace('/')
}

// Las sesiones abiertas antes de existir la pista también la dejan
pistaApp(leer().usuario)

function borrar(): void {
  try {
    localStorage.removeItem(CLAVE)
    sessionStorage.removeItem(CLAVE)
  } catch {
    /* sin almacenamiento */
  }
}

/** Sesión del portal, persistida en el navegador para sobrevivir recargas. */
export const useSesion = create<EstadoSesion>((set) => ({
  ...leer(),
  aviso: null,
  entrar: (token, usuario, recordar = true) => {
    borrar()
    try {
      ;(recordar ? localStorage : sessionStorage).setItem(CLAVE, JSON.stringify({ token, usuario }))
    } catch {
      /* sin almacenamiento: dura mientras la pestaña siga abierta */
    }
    pistaApp(usuario)
    set({ token, usuario, aviso: null })
  },
  actualizarUsuario: (usuario) =>
    set((e) => {
      try {
        ;(almacen() ?? localStorage).setItem(CLAVE, JSON.stringify({ token: e.token, usuario }))
      } catch {
        /* sin almacenamiento */
      }
      return { usuario }
    }),
  cerrar: (aviso) => {
    borrar()
    pistaApp(null)
    set({ token: null, usuario: null, aviso: aviso ?? null })
  },
  limpiarAviso: () => set({ aviso: null })
}))
