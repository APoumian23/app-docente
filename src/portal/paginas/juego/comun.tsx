import { useEffect, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { EventosPartida, Participante } from '@shared/portal'

/**
 * Piezas que comparten la pantalla del jugador y la del anfitrión, para que colores,
 * símbolos y formas de los eventos coincidan en ambos lados del juego.
 */

// ---------- Socket tipado ----------
type EventosServidor = Pick<EventosPartida, 'partida:estado' | 'partida:pregunta' | 'partida:resultado' | 'partida:fin' | 'partida:respondieron'>
type EventosCliente = Pick<EventosPartida, 'partida:unirse' | 'partida:responder' | 'partida:controlar'> & {
  'partida:observar': (d: { pin: string }) => void
}
export type SocketPartida = Socket<EventosServidor, EventosCliente>
export type EstadoPartidaVivo = Parameters<EventosPartida['partida:estado']>[0]
export type ResultadoPregunta = Parameters<EventosPartida['partida:resultado']>[0]

/** Abre la conexión al mismo origen del portal (Vite la reenvía al servidor en desarrollo). */
export function conectarPartida(token: string | null): SocketPartida {
  const socket: SocketPartida = io(window.location.origin, { auth: token ? { token } : {}, reconnectionDelayMax: 5000 })
  return socket
}

// ---------- Opciones estilo Kahoot ----------
export interface EstiloOpcion {
  nombre: string
  simbolo: string
  /** Fondo y color de texto del botón/tarjeta. */
  fondo: string
  hover: string
  /** Versión suave para chips y filas sobre fondo blanco. */
  suave: string
}

export const ESTILO_OPCIONES: EstiloOpcion[] = [
  { nombre: 'rojo', simbolo: '▲', fondo: 'bg-red-500 text-white', hover: 'hover:bg-red-600', suave: 'bg-red-100 text-red-800' },
  { nombre: 'azul', simbolo: '◆', fondo: 'bg-blue-500 text-white', hover: 'hover:bg-blue-600', suave: 'bg-blue-100 text-blue-800' },
  { nombre: 'amarillo', simbolo: '●', fondo: 'bg-yellow-400 text-ink-900', hover: 'hover:bg-yellow-500', suave: 'bg-yellow-100 text-yellow-800' },
  { nombre: 'verde', simbolo: '■', fondo: 'bg-green-500 text-white', hover: 'hover:bg-green-600', suave: 'bg-green-100 text-green-800' }
]

export function estiloOpcion(indice: number): EstiloOpcion {
  return ESTILO_OPCIONES[indice % ESTILO_OPCIONES.length]
}

export const MEDALLAS = ['🥇', '🥈', '🥉']

/** Lugar (1 = primero) de un participante dentro de una tabla ya ordenada por puntos; 0 si no está. */
export function posicionDe(tabla: Participante[], id: number | null | undefined): number {
  if (id === null || id === undefined) return 0
  return tabla.findIndex((p) => p.id === id) + 1
}

export function formatoPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin
}

// ---------- Barra de tiempo ----------
/** Barra que se agota en `segundos` a partir del instante `inicio` (Date.now() cuando llegó la pregunta). */
export function BarraTiempo({ segundos, inicio, grande = false, onAgotado }: { segundos: number; inicio: number; grande?: boolean; onAgotado?: () => void }): JSX.Element {
  const [restante, setRestante] = useState(segundos)
  useEffect(() => {
    let avisado = false
    const tic = (): void => {
      const r = Math.max(0, segundos - (Date.now() - inicio) / 1000)
      setRestante(r)
      if (r <= 0 && !avisado) {
        avisado = true
        onAgotado?.()
      }
    }
    tic()
    const id = setInterval(tic, 100)
    return () => clearInterval(id)
    // onAgotado se lee en cada tic; no hace falta reiniciar el reloj si cambia
  }, [segundos, inicio])
  const pct = segundos > 0 ? (restante / segundos) * 100 : 0
  const urgente = restante <= 5
  return (
    <div className="flex items-center gap-3">
      <div className={`flex-1 overflow-hidden rounded-full bg-white/25 ${grande ? 'h-5' : 'h-3'}`}>
        <div className={`h-full rounded-full transition-[width] duration-100 ease-linear ${urgente ? 'bg-red-400' : 'bg-white'}`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`w-12 shrink-0 text-right font-mono font-bold tabular-nums ${grande ? 'text-3xl md:text-4xl' : 'text-lg'} ${urgente ? 'text-red-300' : ''}`}>{Math.ceil(restante)}</div>
    </div>
  )
}

// ---------- Aviso de conexión ----------
export function AvisoConexion({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) return null
  return (
    <div className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-amber-400 px-4 py-2 text-center text-sm font-semibold text-amber-950" role="status">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-900/40 border-t-amber-900" />
      Conexión perdida, reintentando…
    </div>
  )
}

// ---------- Podio ----------
/** Los tres primeros con una animación sencilla de subida. Funciona sobre fondo claro u oscuro. */
export function Podio({ tabla, destacado, oscuro = false }: { tabla: Participante[]; destacado?: number | null; oscuro?: boolean }): JSX.Element {
  const primeros = tabla.slice(0, 3)
  if (!primeros.length) return <div className={`text-center ${oscuro ? 'text-white/70' : 'text-ink-500'}`}>Nadie jugó esta partida.</div>
  // Se dibuja 2.º, 1.º, 3.º para que el ganador quede al centro
  const orden = [primeros[1], primeros[0], primeros[2]]
  const alturas = ['h-28 md:h-36', 'h-40 md:h-56', 'h-20 md:h-28']
  const colores = ['bg-slate-300 text-slate-900', 'bg-amber-400 text-amber-950', 'bg-orange-300 text-orange-950']
  const lugares = [2, 1, 3]
  const retrasos = ['0.35s', '0.7s', '0s']
  return (
    <div className="mx-auto w-full max-w-2xl">
      <style>{`@keyframes podio-subir{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <div className="flex items-end justify-center gap-2 sm:gap-4">
        {orden.map((p, i) =>
          p ? (
            <div key={p.id} className="flex w-1/3 flex-col items-center" style={{ animation: `podio-subir .6s ease-out ${retrasos[i]} both` }}>
              <div className="text-3xl md:text-5xl">{MEDALLAS[lugares[i] - 1]}</div>
              <div className={`mt-1 w-full truncate text-center text-base font-bold md:text-2xl ${destacado === p.id ? 'underline decoration-2 underline-offset-4' : ''} ${oscuro ? 'text-white' : 'text-ink-900'}`} title={p.apodo}>
                {p.apodo}
              </div>
              <div className={`text-sm md:text-lg ${oscuro ? 'text-white/70' : 'text-ink-500'}`}>{p.puntos.toLocaleString('es-MX')} pts</div>
              <div className={`mt-2 flex w-full items-start justify-center rounded-t-2xl pt-3 text-2xl font-black md:text-4xl ${alturas[i]} ${colores[i]}`}>{lugares[i]}</div>
            </div>
          ) : (
            <div key={`vacio-${i}`} className="w-1/3" />
          )
        )}
      </div>
    </div>
  )
}

/** Tabla de posiciones; `limite` recorta a los primeros N. */
export function TablaPosiciones({ tabla, destacado, limite, oscuro = false, grande = false }: { tabla: Participante[]; destacado?: number | null; limite?: number; oscuro?: boolean; grande?: boolean }): JSX.Element {
  const filas = limite ? tabla.slice(0, limite) : tabla
  if (!filas.length) return <div className={`py-4 text-center ${oscuro ? 'text-white/60' : 'text-ink-400'}`}>Sin participantes.</div>
  return (
    <ol className="space-y-1.5">
      {filas.map((p, i) => {
        const esYo = destacado === p.id
        return (
          <li key={p.id} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${grande ? 'text-xl md:text-2xl' : 'text-base'} ${esYo ? 'bg-brand-500 text-white' : oscuro ? 'bg-white/10 text-white' : 'bg-ink-50 text-ink-800'}`}>
            <span className="w-8 shrink-0 text-center font-bold tabular-nums">{i < 3 ? MEDALLAS[i] : i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-semibold">{p.apodo}</span>
            <span className="shrink-0 font-mono tabular-nums">{p.puntos.toLocaleString('es-MX')}</span>
          </li>
        )
      })}
    </ol>
  )
}
