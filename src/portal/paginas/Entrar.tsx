import { useState, type FormEvent } from 'react'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { api } from '../lib/api'
import { CLAVE_USUARIO, enMarco, irAlApp, useSesion } from '../lib/sesion'
import { Boton, Campo, CampoPassword, avisar } from '../componentes/ui'
import type { Rol, SesionWeb } from '@shared/portal'

/**
 * Destino guardado por la ruta protegida al pedir sesión. Solo se respeta si es una ruta interna
 * del rol que entró: un alumno no regresa a /docente/… ni un docente a pantallas de alumno.
 */
function destinoValido(desde: unknown, rol: Rol): string | null {
  if (typeof desde !== 'string' || !desde.startsWith('/') || desde.startsWith('//')) return null
  const ruta = desde.split(/[?#]/)[0]
  if (ruta === '/entrar' || ruta === '/') return null
  if (ruta === '/cuenta' || ruta.startsWith('/juego')) return desde
  const esDocente = ruta === '/docente' || ruta.startsWith('/docente/')
  return (rol === 'docente') === esDocente ? desde : null
}

const CLAVE_RECORDAR = 'docente-portal.recordar'
const leerLocal = (clave: string): string | null => {
  try {
    return localStorage.getItem(clave)
  } catch {
    return null
  }
}
const escribirLocal = (clave: string, valor: string | null): void => {
  try {
    if (valor) localStorage.setItem(clave, valor)
    else localStorage.removeItem(clave)
  } catch {
    /* sin almacenamiento */
  }
}

/**
 * Le pide al navegador que guarde usuario y contraseña (Chrome y Android lo ofrecen con esto; Safari y el
 * llavero del iPhone lo detectan solos al enviar el formulario). Si el navegador no lo permite, no pasa nada.
 */
async function guardarEnLlavero(id: string, password: string, nombre: string): Promise<void> {
  const PC = (window as Window & { PasswordCredential?: new (d: { id: string; password: string; name?: string }) => Credential }).PasswordCredential
  if (!PC || !navigator.credentials?.store) return
  try {
    await navigator.credentials.store(new PC({ id, password, name: nombre }))
  } catch {
    /* lo rechazó o no se puede: se puede guardar a mano */
  }
}

export default function Entrar(): JSX.Element {
  const nav = useNavigate()
  const loc = useLocation()
  const { entrar, aviso, limpiarAviso } = useSesion()
  const [usuario, setUsuario] = useState(() => leerLocal(CLAVE_USUARIO) ?? '')
  const [password, setPassword] = useState('')
  // Marcada por omisión (lo normal es su celular), salvo que la última vez la haya quitado
  const [recordar, setRecordar] = useState(() => leerLocal(CLAVE_RECORDAR) !== '0')
  const [error, setError] = useState('')
  const [cargando, setCargando] = useState(false)
  // «¿Olvidaste tu contraseña?»: avisa al docente, que la restaura con un clic
  const [olvido, setOlvido] = useState(false)
  const [pedida, setPedida] = useState(false)

  const pedirRestaurar = async (): Promise<void> => {
    if (!usuario.trim()) return setError('Escribe tu usuario o matrícula.')
    setError('')
    setCargando(true)
    try {
      await api('/auth/olvide', { metodo: 'POST', cuerpo: { usuario }, sinSesion: true })
      setPedida(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCargando(false)
    }
  }

  const enviar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    // Enter en «¿Olvidaste tu contraseña?» pide la restauración, no intenta entrar sin contraseña
    if (olvido) {
      if (!pedida) void pedirRestaurar()
      return
    }
    setError('')
    setCargando(true)
    try {
      const r = await api<{ sesion: SesionWeb; reemplazo: boolean }>('/auth/login', { metodo: 'POST', cuerpo: { usuario, password, recordar }, sinSesion: true })
      entrar(r.sesion.token, r.sesion.usuario, recordar)
      escribirLocal(CLAVE_RECORDAR, recordar ? '1' : '0')
      escribirLocal(CLAVE_USUARIO, recordar ? usuario.trim() : null)
      // Sin esperar: si el navegador deja abierta su ventanita de «¿Guardar contraseña?», la entrada no se detiene
      if (recordar) void guardarEnLlavero(usuario.trim(), password, r.sesion.usuario.nombre)
      if (r.reemplazo) avisar('Tenías otra sesión abierta; se cerró para dejar esta.', 'info')
      // Regresa a donde iba (p. ej. a media actividad); con la contraseña inicial primero hay que cambiarla
      const desde = destinoValido((loc.state as { desde?: unknown } | null)?.desde, r.sesion.usuario.rol)
      // Desde la app completa (la raíz para el docente; antes /app): se regresa ahí, que es otra página del sitio
      const volver = new URLSearchParams(loc.search).get('volver')
      if (r.sesion.usuario.rol === 'docente' && volver && /^\/(#.*)?$|^\/app(\/|$)/.test(volver)) return void window.location.assign(volver.replace(/^\/app\/?/, '/'))
      // El docente entra a la app completa; el panel dentro de ella (iframe) se queda en el panel
      if (r.sesion.usuario.rol === 'docente' && !desde && !enMarco()) return void irAlApp(r.sesion.usuario)
      if (r.sesion.usuario.rol === 'docente') nav(desde ?? '/docente', { replace: true })
      else if (r.sesion.usuario.debe_cambiar) nav('/cuenta?primera=1', { replace: true })
      else nav(desde ?? '/', { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-gradient-to-br from-brand-500 to-violet-600 p-4">
      <form onSubmit={enviar} className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f4491a] text-3xl font-black text-white">U</div>
          <h1 className="text-xl font-bold text-ink-900">Portal App Docente</h1>
          <p className="text-sm text-ink-500">Entra con tu matrícula o usuario</p>
        </div>
        {aviso && (
          <div className="mb-4 flex items-start gap-1 rounded-xl bg-amber-50 pl-3 text-sm text-amber-800" role="alert">
            <span className="min-w-0 flex-1 py-3">{aviso}</span>
            <button type="button" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-amber-700 hover:bg-amber-100" onClick={limpiarAviso} aria-label="Cerrar aviso">
              ✕
            </button>
          </div>
        )}
        {olvido ? (
          pedida ? (
            <div className="space-y-3 text-sm text-ink-700">
              <div className="rounded-xl bg-green-50 px-3 py-3 text-green-800">
                Listo: le avisamos a tu docente. Cuando la restaure, tu contraseña volverá a ser <b>tu matrícula</b> (si no tienes matrícula, te dará una nueva) y al entrar te pediremos cambiarla.
              </div>
              <Boton type="button" variante="secundario" className="w-full" onClick={() => { setOlvido(false); setPedida(false) }}>
                Volver a entrar
              </Boton>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-600">Escribe tu usuario o matrícula. Le avisaremos a tu docente para que restaure tu contraseña.</p>
              <Campo etiqueta="Usuario o matrícula" value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="username" autoCapitalize="none" error={error} autoFocus />
              <Boton type="button" className="w-full" disabled={cargando} onClick={() => void pedirRestaurar()}>
                {cargando ? 'Enviando…' : 'Pedir que la restauren'}
              </Boton>
              <button type="button" className="min-h-[44px] w-full text-sm text-ink-500 underline" onClick={() => { setOlvido(false); setError('') }}>
                Ya me acordé, volver
              </button>
            </div>
          )
        ) : (
          <>
            <div className="space-y-3">
              <Campo etiqueta="Usuario o matrícula" value={usuario} onChange={(e) => setUsuario(e.target.value)} autoComplete="username" autoCapitalize="none" required autoFocus />
              <CampoPassword etiqueta="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required error={error} />
            </div>
            <label className="mt-4 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl px-1 py-2 text-sm text-ink-700">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand-500" checked={recordar} onChange={(e) => setRecordar(e.target.checked)} />
              <span>
                <span className="font-medium">Recordarme en este dispositivo</span>
                <span className="block text-xs text-ink-500">Guarda tu usuario y tu contraseña y no te pide entrar en 30 días. No lo marques en computadoras compartidas.</span>
              </span>
            </label>
            <Boton type="submit" className="mt-3 w-full" disabled={cargando}>
              {cargando ? 'Entrando…' : 'Entrar'}
            </Boton>
            <button type="button" className="mt-3 min-h-[44px] w-full text-sm font-semibold text-brand-600 underline" onClick={() => { setOlvido(true); setError('') }}>
              ¿Olvidaste tu contraseña?
            </button>
          </>
        )}
        <p className="mt-4 text-center text-sm text-ink-500">
          ¿Vas a jugar? <Link to="/juego" className="font-semibold text-brand-600 underline">Entra con el PIN</Link>
        </p>
        <p className="mt-2 text-center text-xs text-ink-500">Primera vez: tu usuario y tu contraseña son tu matrícula. Te pediremos cambiar la contraseña.</p>
      </form>
    </div>
  )
}
