import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useSesion } from '../lib/sesion'
import { api } from '../lib/api'
import { olvidarEnServidor, refrescarPush } from '../lib/push'
import type { Notificacion } from '@shared/portal'

/**
 * Dentro de la app de escritorio el menú lateral lo pone la app: aquí van las pestañas abajo, como en celular.
 * Se lee al pintar (no al cargar el módulo): los import se evalúan antes de que main.tsx anote la marca.
 */
const esIncrustado = (): boolean => {
  try {
    return sessionStorage.getItem('docente.incrustado') === '1' || new URLSearchParams(location.search).get('incrustado') === '1'
  } catch {
    return false
  }
}

interface Pestana {
  a: string
  t: string
  icono: string
  /** Otras rutas que pertenecen a esta pestaña (p. ej. «Mis entregas» dentro de Mi avance) */
  tambien?: string[]
  /** En celular no va en la barra de abajo (que ya va llena) sino como ícono en la barra de arriba */
  soloArriba?: boolean
}

/** Más pestañas abajo ya no caben al dedo en un celular de 360 px */
const MAX_ABAJO = 6

/**
 * Marco común: barra superior con campana de notificaciones y navegación.
 * En celular la navegación va abajo, al alcance del pulgar; en pantallas anchas, a la izquierda.
 */
export default function Marco({ pestanas, children, titulo }: { pestanas: Pestana[]; children: ReactNode; titulo?: string }): JSX.Element {
  const { usuario, cerrar } = useSesion()
  const nav = useNavigate()
  const [noLeidas, setNoLeidas] = useState(0)

  // Con el permiso ya dado, este dispositivo se vuelve a ligar a la cuenta con la que se entró
  useEffect(() => void refrescarPush(), [usuario?.id])

  useEffect(() => {
    let vivo = true
    const consultar = (): void => {
      api<Notificacion[]>('/notificaciones?no_leidas=1')
        .then((n) => vivo && setNoLeidas(n.length))
        .catch(() => undefined)
    }
    consultar()
    const t = setInterval(consultar, 30_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [])

  const salir = async (): Promise<void> => {
    try {
      // Este dispositivo deja de recibir los avisos de esta cuenta
      await olvidarEnServidor()
      await api('/auth/logout', { metodo: 'POST' })
    } catch {
      /* la sesión local se cierra de todos modos */
    }
    cerrar()
    nav('/entrar')
  }
  const base = usuario?.rol === 'docente' ? '/docente' : '/'
  const loc = useLocation()
  const INCRUSTADO = esIncrustado()
  // Pestaña a la que pertenece la pantalla actual (también subpantallas como /docente/intentos/12)
  const activa = (p: Pestana): boolean =>
    p.a === base ? loc.pathname === base || (base !== '/' && /^\/docente\/(materias|publicar|asignaciones|intentos)\//.test(loc.pathname)) : loc.pathname === p.a || loc.pathname.startsWith(p.a + '/') || !!p.tambien?.some((x) => loc.pathname.startsWith(x))
  const actual = pestanas.find(activa)
  // La barra de abajo lleva a lo sumo seis pestañas (más ya no caben al dedo en 360 px): las que
  // sobran, igual que las marcadas «soloArriba», pasan como ícono a la barra superior
  const candidatas = pestanas.filter((p) => !p.soloArriba)
  const abajo = candidatas.slice(0, MAX_ABAJO)
  const arriba = [...pestanas.filter((p) => p.soloArriba), ...candidatas.slice(MAX_ABAJO)]
  const icono = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors duration-150'

  return (
    <div className="flex min-h-[100dvh] flex-col bg-ink-50 sm:flex-row">
      <aside className={`sticky top-0 hidden h-[100dvh] w-60 shrink-0 flex-col border-r border-ink-200 bg-white ${INCRUSTADO ? '' : 'sm:flex'}`}>
        <div className="px-5 py-5">
          <div className="text-[11px] font-bold tracking-widest text-brand-500">APP DOCENTE</div>
          <div className="mt-1 truncate text-sm text-ink-600" title={usuario?.nombre}>{usuario?.nombre}</div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Secciones">
          {pestanas.map((p) => (
            <NavLink key={p.a} to={p.a} end={p.a === base} aria-current={activa(p) ? 'page' : undefined} className={() => `flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors duration-150 ${activa(p) ? 'bg-brand-500 text-white' : 'text-ink-700 hover:bg-ink-100'}`}>
              <span className="w-5 text-center text-base" aria-hidden>{p.icono}</span>
              <span className="truncate">{p.t}</span>
            </NavLink>
          ))}
        </nav>
        <button onClick={salir} className="m-3 flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-left text-sm text-ink-600 hover:bg-ink-100">
          <span className="w-5 text-center" aria-hidden>⎋</span>
          Cerrar sesión
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-1 border-b border-ink-200 bg-white px-3 py-1.5 sm:gap-2 sm:px-6 sm:py-2">
          <div className="min-w-0 flex-1 pl-1">
            {INCRUSTADO ? null : <div className="text-[11px] font-bold tracking-widest text-brand-500 sm:hidden">APP DOCENTE</div>}
            {/* Cada pantalla trae su propio título visible; este es para lectores de pantalla */}
            <h1 className={titulo ? 'truncate text-lg font-bold text-ink-900' : 'sr-only'}>{titulo ?? actual?.t ?? 'App Docente'}</h1>
          </div>
          {arriba.map((p) => (
            <NavLink key={p.a} to={p.a} aria-label={p.t} title={p.t} aria-current={activa(p) ? 'page' : undefined} className={`${icono} ${INCRUSTADO ? '' : 'sm:hidden'} ${activa(p) ? 'bg-brand-500/10 text-brand-600' : 'text-ink-600 hover:bg-ink-100'}`}>
              <span className="text-xl leading-none" aria-hidden>{p.icono}</span>
            </NavLink>
          ))}
          <NavLink to={`${base === '/' ? '' : base}/notificaciones`} className={({ isActive }) => `relative ${icono} ${isActive ? 'bg-brand-500/10 text-brand-600' : 'text-ink-600 hover:bg-ink-100'}`} aria-label={noLeidas > 0 ? `Notificaciones (${noLeidas} sin leer)` : 'Notificaciones'}>
            <span className="text-xl leading-none" aria-hidden>🔔</span>
            {noLeidas > 0 && <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-red-600 px-1 text-center text-[11px] font-bold leading-[18px] text-white" aria-hidden>{noLeidas > 99 ? '99+' : noLeidas}</span>}
          </NavLink>
          <button onClick={salir} className={`${icono} text-ink-500 hover:bg-ink-100 ${INCRUSTADO ? '' : 'sm:hidden'}`} aria-label="Cerrar sesión" title="Cerrar sesión">
            <span className="text-xl leading-none" aria-hidden>⎋</span>
          </button>
        </header>
        <main className={`flex-1 px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:pt-6 ${INCRUSTADO ? '' : 'sm:pb-10'}`}>{children}</main>
      </div>

      <nav className={`fixed inset-x-0 bottom-0 z-30 flex border-t border-ink-200 bg-white pb-[env(safe-area-inset-bottom)] ${INCRUSTADO ? 'justify-center' : 'sm:hidden'}`} aria-label="Secciones">
        {abajo.map((p) => {
          const sel = activa(p)
          return (
            <NavLink key={p.a} to={p.a} end={p.a === base} aria-current={sel ? 'page' : undefined} className={() => `flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pb-1.5 pt-1 ${INCRUSTADO ? 'sm:max-w-[9rem]' : ''} ${abajo.length >= 6 ? 'text-[10px]' : 'text-[11px]'} ${sel ? 'font-semibold text-brand-600' : 'text-ink-500'}`}>
              {/* Píldora detrás del ícono activo: se distingue sin depender solo del color del texto */}
              <span className={`flex h-7 w-12 items-center justify-center rounded-full text-xl leading-none transition-colors duration-150 ${sel ? 'bg-brand-500/15' : ''}`} aria-hidden>{p.icono}</span>
              <span className="max-w-full truncate px-0.5 tracking-tight">{p.t}</span>
            </NavLink>
          )
        })}
      </nav>
    </div>
  )
}
