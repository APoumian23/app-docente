import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { avisar } from './Aviso'
import Modal from './Modal'
import Markdown from './Markdown'
import guia from '../../../../docs/CLASSROOM.md?raw'
import type { EstadoConexion } from '@shared/classroom'

/** La guía paso a paso, dentro de la app (también se ve en docs/CLASSROOM.md). */
export function GuiaClassroom({ abierta, onCerrar }: { abierta: boolean; onCerrar: () => void }): JSX.Element {
  return (
    <Modal titulo="Cómo configurar Google Classroom" abierto={abierta} onCerrar={onCerrar} ancho="max-w-3xl !max-h-[calc(88vh/var(--zoom,1))]">
      <div className="select-text">
        <Markdown texto={guia} />
      </div>
    </Modal>
  )
}

/**
 * Aviso con botón para pedir a Google los permisos que la conexión guardada no tiene (crear y calificar
 * tareas, subir los archivos que se adjuntan), p. ej. porque se conectó antes de que la app los pidiera.
 * Vuelve a abrir el inicio de sesión de Google sin desconectar: el permiso nuevo reemplaza al anterior.
 */
export function PermisoEscritura({ estado, onCambio }: { estado: EstadoConexion; onCambio: (e: EstadoConexion) => void }): JSX.Element | null {
  const [esperando, setEsperando] = useState(false)
  if (!estado.conectado || (estado.escritura && estado.subir)) return null
  const web = window.api.plataforma === 'web'
  const falta = [!estado.escritura && 'crear y calificar tareas', !estado.subir && 'adjuntar archivos a las tareas'].filter(Boolean).join(' y ')
  const pedir = async (): Promise<void> => {
    setEsperando(true)
    try {
      const x = await api.classroom.conectar()
      onCambio(x)
      const siguen = [!x.escritura && '«ver, crear y editar trabajos y calificaciones»', !x.subir && '«ver, editar, crear y borrar solo los archivos de Google Drive que usas con esta app»'].filter(Boolean)
      if (!siguen.length) avisar('Listo: ya puedes crear tareas, calificarlas y adjuntarles archivos desde la app')
      else avisar(`Google no dio todos los permisos. Pulsa otra vez y, en la pantalla de Google, marca ${siguen.join(' y ')} (o «Seleccionar todo»).`, 'error')
    } catch (err) {
      avisar((err as Error).message, 'error')
    } finally {
      setEsperando(false)
    }
  }
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-2">
      <p>
        A tu conexión con Google le falta el permiso para {falta}.
        {web ? ' Dalo desde la app de tu Mac (Ajustes › Google Classroom › «Dar permisos que faltan»); la web lo toma sola.' : ' Pulsa el botón, entra con tu cuenta y marca todas las casillas en Google.'}
      </p>
      {!web && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primario" disabled={esperando} onClick={pedir}>{esperando ? 'Esperando a Google…' : 'Dar permisos que faltan'}</button>
          {esperando && <span className="text-xs text-ink-600">Se abrió tu navegador: acepta los permisos y vuelve aquí. Tienes 5 minutos.</span>}
        </div>
      )}
    </div>
  )
}

/** Sección de Ajustes: credenciales del cliente OAuth, Conectar y Desconectar. */
export default function ClassroomAjustes(): JSX.Element {
  const [e, setE] = useState<EstadoConexion | null>(null)
  const [id, setId] = useState('')
  const [secreto, setSecreto] = useState('')
  const [ocupado, setOcupado] = useState<'' | 'guardar' | 'conectar' | 'desconectar'>('')
  const [verGuia, setVerGuia] = useState(false)
  useEffect(() => {
    api.classroom.estado().then((x) => { setE(x); setId(x.client_id) }).catch(() => undefined)
  }, [])
  if (!e) return <section className="tarjeta p-5 text-sm text-ink-500">Google Classroom: cargando…</section>

  const hacer = async (que: typeof ocupado, f: () => Promise<EstadoConexion>, ok: string): Promise<void> => {
    setOcupado(que)
    try {
      const x = await f()
      setE(x)
      setId(x.client_id)
      setSecreto('')
      avisar(ok)
    } catch (err) {
      avisar((err as Error).message, 'error')
    } finally {
      setOcupado('')
    }
  }
  const otraCuenta = e.conectado && e.cuenta && e.cuenta !== e.cuenta_esperada

  return (
    <section className="tarjeta p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Google Classroom</h3>
        <button className="btn-fantasma text-brand-600" onClick={() => setVerGuia(true)}>Cómo configurarlo</button>
      </div>
      <p className="text-sm text-ink-600">
        Estado:{' '}
        {e.conectado ? (
          <span className="text-green-700 font-medium">conectado como {e.cuenta || 'tu cuenta'}</span>
        ) : e.credenciales ? (
          <span className="text-amber-700 font-medium">credenciales guardadas, falta conectar</span>
        ) : (
          <span className="text-amber-700 font-medium">sin configurar</span>
        )}
        .{' '}
        {e.conectado && e.escritura
          ? 'La app puede crear, editar y calificar las tareas que ella crea; las que hiciste directo en Classroom solo se leen.'
          : 'Solo lectura: la app no cambia ni califica nada en Classroom.'}
      </p>
      {otraCuenta && <p className="text-sm text-amber-700">Ojo: se conectó {e.cuenta}, no {e.cuenta_esperada}. Si no es la cuenta de tus clases, desconecta y vuelve a conectar eligiendo la correcta.</p>}
      <PermisoEscritura estado={e} onCambio={setE} />
      {e.conectado && !e.drive && <p className="text-sm text-amber-700">Falta el permiso de Google Drive: no podrás ver los archivos entregados. Desconecta y conecta otra vez marcando todas las casillas.</p>}
      {window.api.plataforma === 'web' ? (
        <p className="text-sm text-ink-600">En la versión web se usa la conexión de tu app de escritorio: se trae sola cada vez que la abres. Conectar, reconectar o cambiar las credenciales se hace en la app de tu Mac.</p>
      ) : (
      <>
      <label className="block"><span className="etiqueta">Client ID</span><input className="input font-mono" value={id} onChange={(x) => setId(x.target.value)} placeholder="…apps.googleusercontent.com" spellCheck={false} /></label>
      <label className="block"><span className="etiqueta">{e.credenciales ? 'Reemplazar Client Secret' : 'Client Secret'}</span><input type="password" className="input font-mono" value={secreto} onChange={(x) => setSecreto(x.target.value)} placeholder={e.credenciales ? '•••••••• (guardado)' : 'GOCSPX-…'} /></label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-secundario" disabled={!!ocupado || !id.trim()} onClick={() => hacer('guardar', () => api.classroom.guardarCredenciales(id, secreto), 'Credenciales guardadas')}>
          {ocupado === 'guardar' ? 'Guardando…' : 'Guardar credenciales'}
        </button>
        <button className="btn-primario" disabled={!!ocupado || !e.credenciales} onClick={() => hacer('conectar', () => api.classroom.conectar(), 'Google Classroom conectado')}>
          {ocupado === 'conectar' ? 'Esperando a Google…' : e.conectado ? 'Reconectar' : 'Conectar'}
        </button>
        {e.conectado && (
          <button className="btn-peligro" disabled={!!ocupado} onClick={() => confirm('¿Desconectar Google Classroom? Se borra el permiso guardado; los datos ya sincronizados se conservan.') && hacer('desconectar', () => api.classroom.desconectar(), 'Desconectado de Google Classroom')}>
            Desconectar
          </button>
        )}
        <Link to="/classroom" className="btn-fantasma text-brand-600 ml-auto">Abrir Google Classroom →</Link>
      </div>
      {ocupado === 'conectar' && <p className="text-xs text-ink-500">Se abrió tu navegador: entra con {e.cuenta_esperada}, acepta los permisos y vuelve aquí. Tienes 5 minutos.</p>}
      <p className="text-xs text-ink-500">El Client Secret y el permiso de Google se guardan cifrados con el llavero de macOS.</p>
      </>
      )}
      <GuiaClassroom abierta={verGuia} onCerrar={() => setVerGuia(false)} />
    </section>
  )
}
