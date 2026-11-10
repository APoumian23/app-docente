import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import Modal from './Modal'

/**
 * Pide la contraseña de borrado antes de una acción destructiva.
 * `onConfirmar` recibe la contraseña escrita; si lanza un error, se muestra en el modal.
 */
export default function ModalPassword({
  abierto,
  titulo,
  advertencia,
  textoBoton = 'Eliminar',
  onCerrar,
  onConfirmar
}: {
  abierto: boolean
  titulo: string
  advertencia: string
  textoBoton?: string
  onCerrar: () => void
  onConfirmar: (password: string) => Promise<void>
}): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [configurada, setConfigurada] = useState<boolean | null>(null)

  useEffect(() => {
    if (!abierto) return
    setPassword('')
    setError('')
    api.seguridad.estado().then((e) => setConfigurada(e.configurada))
  }, [abierto])

  const confirmar = async (): Promise<void> => {
    if (!password) return setError('Escribe la contraseña.')
    setOcupado(true)
    setError('')
    try {
      await onConfirmar(password)
      onCerrar()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setOcupado(false)
    }
  }

  return (
    <Modal titulo={titulo} abierto={abierto} onCerrar={onCerrar} ancho="max-w-md">
      <div className="space-y-3">
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{advertencia}</div>
        {configurada === false ? (
          <>
            <p className="text-sm text-ink-600">
              Aún no defines la contraseña de borrado. Configúrala en <Link to="/ajustes" className="text-brand-600 underline" onClick={onCerrar}>Ajustes › Seguridad</Link> y vuelve a intentarlo.
            </p>
            <div className="flex justify-end"><button className="btn-secundario" onClick={onCerrar}>Cerrar</button></div>
          </>
        ) : (
          <>
            <label>
              <span className="etiqueta">Contraseña de borrado</span>
              <input
                type="password"
                autoFocus
                className="input font-mono"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError('') }}
                onKeyDown={(e) => e.key === 'Enter' && confirmar()}
                placeholder="••••••••"
              />
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2">
              <button className="btn-secundario" onClick={onCerrar} disabled={ocupado}>Cancelar</button>
              <button className="btn-peligro" onClick={confirmar} disabled={ocupado || !password}>{ocupado ? 'Verificando…' : textoBoton}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
