import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { Partida } from '@shared/portal'
import { api, ErrorApi } from '../../lib/api'
import { useSesion } from '../../lib/sesion'
import { Boton, Campo } from '../../componentes/ui'

/** Entrada al juego en vivo: solo hace falta el PIN y un apodo, sin cuenta. */
export default function JuegoEntrar(): JSX.Element {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const usuario = useSesion((s) => s.usuario)
  // El alumno con sesión juega con el nombre de su cuenta: el servidor no le deja elegir otro
  const conCuenta = usuario?.rol === 'alumno'
  const [pin, setPin] = useState((params.get('pin') ?? '').replace(/\D/g, '').slice(0, 6))
  const [apodo, setApodo] = useState(usuario?.nombre.trim().split(/\s+/)[0] ?? '')
  const [errorPin, setErrorPin] = useState('')
  const [errorApodo, setErrorApodo] = useState('')
  const [cargando, setCargando] = useState(false)

  const entrar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setErrorPin('')
    setErrorApodo('')
    const apodoLimpio = (conCuenta ? usuario.nombre : apodo).trim().slice(0, 24)
    let valido = true
    if (!/^\d{6}$/.test(pin)) {
      setErrorPin('El PIN tiene 6 dígitos.')
      valido = false
    }
    if (!apodoLimpio) {
      setErrorApodo('Escribe cómo quieres que te vean.')
      valido = false
    }
    if (!valido) return
    setCargando(true)
    try {
      const partida = await api<Partida>(`/partidas/${pin}`, { sinSesion: true })
      if (partida.estado === 'terminada') {
        setErrorPin('Esa partida ya terminó. Pide un PIN nuevo al docente.')
        return
      }
      nav(`/juego/${pin}?apodo=${encodeURIComponent(apodoLimpio)}`)
    } catch (err) {
      if (err instanceof ErrorApi && err.estado === 404) setErrorPin('No hay ninguna partida con ese PIN.')
      else setErrorPin((err as Error).message)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-b from-violet-700 to-indigo-900 p-4">
      <form onSubmit={entrar} className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-3xl">🎮</div>
          <h1 className="text-xl font-bold text-ink-900">Juego en vivo</h1>
          <p className="text-sm text-ink-500">Escribe el PIN que muestra el docente</p>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-400">PIN de la partida</span>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={6}
            autoFocus
            aria-label="PIN de la partida"
            aria-invalid={errorPin ? true : undefined}
            className={`w-full rounded-2xl border-2 bg-white px-3 py-3 juego-pin-entrada text-center font-mono font-bold text-ink-900 placeholder:text-ink-200 outline-none focus:ring-2 focus:ring-violet-400/40 ${errorPin ? 'border-red-400' : 'border-ink-200 focus:border-violet-500'}`}
          />
          {errorPin && <span className="mt-1 block text-sm text-red-600">{errorPin}</span>}
        </label>

        {conCuenta ? (
          <p className="mt-4 rounded-2xl bg-ink-50 px-3 py-2 text-center text-sm text-ink-600">
            Jugarás como <span className="font-semibold text-ink-900">{usuario.nombre}</span>
          </p>
        ) : (
          <Campo className="mt-4" etiqueta="Tu apodo" value={apodo} onChange={(e) => setApodo(e.target.value.slice(0, 24))} placeholder="Como te verán en la pantalla" maxLength={24} autoComplete="nickname" error={errorApodo} />
        )}

        <Boton type="submit" className="mt-5 w-full min-h-[56px] bg-violet-600 text-base hover:bg-violet-700" disabled={cargando}>
          {cargando ? 'Buscando la partida…' : 'Entrar'}
        </Boton>

        <p className="mt-5 text-center text-xs text-ink-400">
          {usuario ? (
            <Link to={usuario.rol === 'docente' ? '/docente' : '/'} className="text-brand-600 underline">
              Volver al portal
            </Link>
          ) : (
            <>
              ¿Tienes cuenta?{' '}
              <Link to="/entrar" className="text-brand-600 underline">
                Inicia sesión
              </Link>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
