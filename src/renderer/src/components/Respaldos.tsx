import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { avisar } from './Aviso'

type Lista = Awaited<ReturnType<typeof api.respaldos.listar>>
const tam = (b: number): string => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`)
const fecha = (iso: string): string =>
  new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Respaldos de la base en Ajustes. Actualizar la app nunca toca los datos (viven fuera de la app), pero
 * aquí el docente respalda cuando quiera, restaura uno y elige una carpeta externa para copias diarias.
 */
export default function Respaldos({ rutaDatos }: { rutaDatos: string }): JSX.Element {
  const [l, setL] = useState<Lista | null>(null)
  const [verTodos, setVerTodos] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const leer = (): void => void api.respaldos.listar().then(setL).catch((e) => avisar((e as Error).message, 'error'))
  useEffect(leer, [])

  const respaldar = async (): Promise<void> => {
    setOcupado(true)
    try {
      await api.respaldos.crear()
      avisar(l?.carpeta_externa ? 'Respaldo hecho (y copiado a tu carpeta externa)' : 'Respaldo hecho')
      leer()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(false)
    }
  }
  const restaurar = async (nombre: string, cuando: string): Promise<void> => {
    if (!confirm(`¿Restaurar el respaldo del ${cuando}?\n\nLa app se reiniciará y tus datos quedarán como estaban en ese momento. Lo que tienes ahora se guarda antes como respaldo «Antes de restaurar», por si te arrepientes.`)) return
    await api.respaldos.restaurar(nombre).catch((e) => avisar((e as Error).message, 'error'))
  }
  const lista = l?.respaldos ?? []

  return (
    <section className="tarjeta p-5 space-y-3 text-sm">
      <h3 className="font-semibold">Respaldos de tu información</h3>
      <p className="text-ink-600">
        Tus datos (alumnos, asistencias, calificaciones, materiales) viven en tu Mac, <b>fuera de la app</b>: actualizarla o reinstalarla <b>no los borra</b>. Además se respaldan solos cada día y antes de cada actualización.
      </p>
      <div className="flex flex-wrap gap-2">
        <button className="btn-primario" onClick={respaldar} disabled={ocupado}>{ocupado ? 'Respaldando…' : 'Respaldar ahora'}</button>
        <button className="btn-secundario" onClick={() => api.sistema.abrirRuta(rutaDatos + '/datos/respaldos')}>Abrir carpeta de respaldos</button>
      </div>

      <div className="rounded-lg border border-ink-200 p-3 space-y-2">
        <div className="font-medium">Copia en otra carpeta (recomendado)</div>
        <p className="text-ink-600">
          Si eliges una carpeta de iCloud Drive, Google Drive o una memoria USB, cada respaldo también se guarda ahí (los últimos 30). Así, si le pasa algo a la Mac, tu información sigue a salvo.
        </p>
        {l?.carpeta_externa ? (
          <>
            <code className="block text-xs bg-ink-100 rounded px-2 py-1 select-text break-all">{l.carpeta_externa}/App_Docente respaldos</code>
            {l.ultimo_externo && <p className="text-xs text-green-700">Última copia: {fecha(l.ultimo_externo)}</p>}
            {l.error_externo && <p className="text-xs text-red-700">La última copia falló: {l.error_externo}</p>}
            <div className="flex flex-wrap gap-2">
              <button className="btn-secundario" onClick={() => api.respaldos.elegirCarpeta().then(leer)}>Cambiar carpeta</button>
              <button className="btn-fantasma text-red-600" onClick={() => api.respaldos.quitarCarpeta().then(leer)}>Dejar de copiar</button>
            </div>
          </>
        ) : (
          <button className="btn-secundario" onClick={() => api.respaldos.elegirCarpeta().then(leer).catch((e) => avisar((e as Error).message, 'error'))}>Elegir carpeta…</button>
        )}
      </div>

      <div>
        <div className="font-medium mb-1">Respaldos guardados ({lista.length})</div>
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {(verTodos ? lista : lista.slice(0, 6)).map((r) => (
            <li key={r.nombre} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="w-32 shrink-0">{fecha(r.fecha)}</span>
              <span className="flex-1 min-w-[10rem] text-ink-600">{r.tipo}</span>
              <span className="text-xs text-ink-400">{tam(r.bytes)}</span>
              <button className="btn-fantasma text-xs" onClick={() => restaurar(r.nombre, fecha(r.fecha))}>Restaurar</button>
            </li>
          ))}
          {lista.length === 0 && <li className="px-3 py-2 text-ink-500">Aún no hay respaldos.</li>}
        </ul>
        {lista.length > 6 && (
          <button className="btn-fantasma text-xs mt-1" onClick={() => setVerTodos((v) => !v)}>{verTodos ? 'Ver menos' : `Ver los ${lista.length}`}</button>
        )}
      </div>
      <p className="text-xs text-ink-500">Carpeta de datos: <code className="select-text">{rutaDatos}/datos</code>. Time Machine también la incluye.</p>
    </section>
  )
}
