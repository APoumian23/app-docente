import { useState } from 'react'
import Modal from './Modal'
import { api } from '../lib/api'
import { avisar } from './Aviso'

export type ObjetivoJustificar = { sesionId: number; alumnoId: number; alumno: string; fecha: string; estado: string }

/**
 * Botón «Justificar» / «Quitar justificación» para un registro de asistencia. Un justificado no cuenta
 * como hora de falta (comunicado) ni en la asistencia mínima del parcial. El motivo es obligatorio.
 */
export function BotonJustificar({ o, onCambio }: { o: ObjetivoJustificar; onCambio: () => void }): JSX.Element | null {
  const [abierto, setAbierto] = useState(false)
  if (o.estado === 'justificado')
    return (
      <button
        className="btn-fantasma text-xs px-2 py-1"
        onClick={async () => {
          if (!confirm(`¿Quitar la justificación de ${o.alumno} (${o.fecha})? Vuelve a contar como falta.`)) return
          try {
            await api.asistencia.quitarJustificacion(o.sesionId, o.alumnoId)
            avisar('Justificación quitada')
            onCambio()
          } catch (e) {
            avisar((e as Error).message, 'error')
          }
        }}
      >
        Quitar justificación
      </button>
    )
  if (o.estado !== 'ausente' && o.estado !== 'retardo') return null
  return (
    <>
      <button className="btn-secundario text-xs px-2 py-1" onClick={() => setAbierto(true)}>Justificar</button>
      <ModalJustificar abierto={abierto} o={o} onCerrar={() => setAbierto(false)} onListo={onCambio} />
    </>
  )
}

function ModalJustificar({ abierto, o, onCerrar, onListo }: { abierto: boolean; o: ObjetivoJustificar; onCerrar: () => void; onListo: () => void }): JSX.Element {
  const [motivo, setMotivo] = useState('')
  const guardar = async (): Promise<void> => {
    if (!motivo.trim()) return avisar('Escribe el motivo', 'error')
    try {
      await api.asistencia.justificar(o.sesionId, o.alumnoId, motivo)
      avisar(`${o.estado === 'retardo' ? 'Retardo' : 'Falta'} justificada`)
      setMotivo('')
      onCerrar()
      onListo()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  return (
    <Modal titulo={`Justificar ${o.estado === 'retardo' ? 'retardo' : 'falta'} · ${o.alumno}`} abierto={abierto} onCerrar={onCerrar} ancho="max-w-md">
      <div className="space-y-3">
        <p className="text-sm text-ink-600">Sesión del {o.fecha}. Al justificarla deja de contar como hora de falta y en la asistencia del parcial.</p>
        <label className="block"><span className="etiqueta">Motivo</span><input className="input" autoFocus value={motivo} placeholder="Justificante médico" onChange={(e) => setMotivo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && guardar()} /></label>
        <div className="flex justify-end gap-2"><button className="btn-secundario" onClick={onCerrar}>Cancelar</button><button className="btn-primario" disabled={!motivo.trim()} onClick={guardar}>Justificar</button></div>
      </div>
    </Modal>
  )
}
