import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useSesion } from '../lib/sesion'
import { Boton, CampoPassword, EncabezadoPagina, Tarjeta, avisar } from '../componentes/ui'
import { TarjetaNotificaciones } from '../componentes/Notificar'
import type { Usuario } from '@shared/portal'
import { REQUISITOS_PASSWORD, problemaPassword } from '@shared/password'

/** Cambio de contraseña. Con ?primera=1 explica que es obligatorio en el primer acceso. */
export default function Cuenta(): JSX.Element {
  const nav = useNavigate()
  const loc = useLocation()
  const [params] = useSearchParams()
  const { usuario, actualizarUsuario } = useSesion()
  // Primer acceso (o contraseña reiniciada): no se pide la actual, ya entró con ella
  const primera = params.get('primera') === '1' || Boolean(usuario?.debe_cambiar)
  // Panel abierto desde la app de escritorio: tampoco se pide la actual (así se pone otra si se olvidó)
  const desdeApp = !primera && Boolean(usuario?.desde_app)
  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [repetir, setRepetir] = useState('')
  const [error, setError] = useState('')
  const [cargando, setCargando] = useState(false)

  const enviar = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const problema = problemaPassword(nueva)
    if (problema) return setError(problema)
    if (nueva !== repetir) return setError('Las contraseñas no coinciden.')
    setError('')
    setCargando(true)
    try {
      await api('/auth/password', { metodo: 'POST', cuerpo: { actual, nueva } })
      const yo = await api<Usuario>('/auth/yo')
      actualizarUsuario(yo)
      avisar('Contraseña actualizada')
      // El docente que venía de la app completa (/app) regresa a ella
      const volver = params.get('volver')
      if (yo.rol === 'docente' && volver && /^\/(#.*)?$|^\/app(\/|$)/.test(volver)) return void window.location.assign(volver.replace(/^\/app\/?/, '/'))
      // Si venía de otra pantalla (p. ej. su actividad tras un reinicio de contraseña), vuelve ahí
      const desde = (loc.state as { desde?: string } | null)?.desde
      const valido = !!desde && desde.startsWith('/') && !desde.startsWith('/cuenta') && desde.startsWith('/docente') === (yo.rol === 'docente')
      nav(valido ? desde! : yo.rol === 'docente' ? '/docente' : '/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCargando(false)
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      {!primera && <EncabezadoPagina titulo="Mi cuenta" />}
      {/* Con la contraseña inicial todavía no: primero la cambia */}
      {!primera && !usuario?.debe_cambiar && <TarjetaNotificaciones />}
      <Tarjeta>
        {usuario && (
          <div className="mb-4 rounded-xl bg-brand-500/5 px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">Tu usuario para entrar</div>
            <div className="break-all font-mono text-xl font-bold text-ink-900 select-all">{usuario.usuario}</div>
            <div className="mt-0.5 text-sm text-ink-600">{usuario.nombre}</div>
          </div>
        )}
        <h2 className="text-lg font-bold">{primera ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h2>
        <p className="mt-1 text-sm text-ink-600">
          {primera
            ? 'Por seguridad, elige una contraseña nueva que cumpla las reglas de abajo antes de continuar. No puede ser tu matrícula ni tu usuario.'
            : desdeApp
              ? 'Abriste el panel desde tu app: no hace falta la contraseña actual.'
              : `Sesión de ${usuario?.nombre}.`}
        </p>
        <form onSubmit={enviar} className="mt-4 space-y-3">
          {primera || desdeApp ? null : <CampoPassword etiqueta="Contraseña actual" value={actual} onChange={(e) => setActual(e.target.value)} autoComplete="current-password" required />}
          <CampoPassword etiqueta="Nueva contraseña" value={nueva} onChange={(e) => setNueva(e.target.value)} autoComplete="new-password" required />
          {/* Lo que pide una contraseña segura, marcado en verde conforme se cumple */}
          <ul className="space-y-0.5 text-xs" aria-label="Requisitos de la contraseña">
            {REQUISITOS_PASSWORD.map((r) => {
              const ok = r.cumple(nueva)
              return (
                <li key={r.texto} className={`flex items-center gap-1.5 ${ok ? 'text-emerald-700' : 'text-ink-500'}`}>
                  <span aria-hidden className="w-4 text-center">{ok ? '✓' : '○'}</span>
                  <span>{r.texto}</span>
                  <span className="sr-only">{ok ? '(cumple)' : '(falta)'}</span>
                </li>
              )
            })}
            {repetir ? (
              <li className={`flex items-center gap-1.5 ${repetir === nueva ? 'text-emerald-700' : 'text-red-600'}`}>
                <span aria-hidden className="w-4 text-center">{repetir === nueva ? '✓' : '✗'}</span>
                <span>{repetir === nueva ? 'Las dos coinciden' : 'Las dos no coinciden'}</span>
              </li>
            ) : null}
          </ul>
          <CampoPassword etiqueta="Repetir nueva contraseña" value={repetir} onChange={(e) => setRepetir(e.target.value)} autoComplete="new-password" required />
          {/* El error a la vista, junto al botón (antes quedaba chico bajo el último campo y no se notaba) */}
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700" role="alert">
              {error}
            </div>
          ) : null}
          <Boton type="submit" className="w-full min-h-[48px] text-base" disabled={cargando}>{cargando ? 'Guardando…' : 'Guardar contraseña'}</Boton>
        </form>
      </Tarjeta>
    </div>
  )
}
