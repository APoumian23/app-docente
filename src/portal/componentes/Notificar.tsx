import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { activarPush, alCambiarInstalacion, apagarPush, esIOS, estadoPush, instalada, instalarApp, sePuedeInstalar, type EstadoPush } from '../lib/push'
import { Boton, Tarjeta, avisar } from './ui'

function usePush(): { estado: EstadoPush | null; puedeInstalar: boolean; recargar: () => void; setEstado: (e: EstadoPush) => void } {
  const [estado, setEstado] = useState<EstadoPush | null>(null)
  const [puedeInstalar, setPuedeInstalar] = useState(sePuedeInstalar())
  const recargar = useCallback(() => void estadoPush().then(setEstado).catch(() => setEstado('sin-soporte')), [])
  useEffect(() => {
    recargar()
    return alCambiarInstalacion(() => setPuedeInstalar(sePuedeInstalar()))
  }, [recargar])
  return { estado, puedeInstalar, recargar, setEstado }
}

/** Pasos para agregar el portal a la pantalla de inicio del iPhone (sin eso iOS no deja mandar notificaciones). */
function PasosIPhone(): JSX.Element {
  return (
    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-700">
      <li>Abre esta página en <b>Safari</b>.</li>
      <li>Toca <b>Compartir</b> <span aria-hidden>(el cuadro con la flecha ↑)</span>.</li>
      <li>Elige <b>«Agregar a pantalla de inicio»</b> y luego <b>Agregar</b>.</li>
      <li>Abre <b>Docente</b> desde el ícono nuevo y activa aquí las notificaciones.</li>
    </ol>
  )
}

const TEXTO_BLOQUEADAS = esIOS()
  ? 'Las bloqueaste. Para activarlas: Ajustes del iPhone › Notificaciones › Docente › Permitir notificaciones.'
  : 'Las bloqueaste en este navegador. Para activarlas: toca el candado junto a la dirección (o mantén presionado el ícono de Docente › Información de la app) › Notificaciones › Permitir. Luego vuelve aquí.'

/** Tarjeta completa (Cuenta): instalar la app, activar, probar y apagar las notificaciones de este dispositivo. */
export function TarjetaNotificaciones(): JSX.Element {
  const { estado, puedeInstalar, recargar, setEstado } = usePush()
  const [ocupado, setOcupado] = useState(false)
  const accion = async (f: () => Promise<void>): Promise<void> => {
    setOcupado(true)
    try {
      await f()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(false)
    }
  }
  const activar = (): Promise<void> =>
    accion(async () => {
      const e = await activarPush()
      setEstado(e)
      if (e === 'activas') avisar('Notificaciones activadas en este dispositivo')
    })
  return (
    <Tarjeta className="space-y-3">
      <div>
        <h2 className="text-lg font-bold">Notificaciones en este dispositivo</h2>
        <p className="mt-1 text-sm text-ink-500">Te avisamos de tareas nuevas, entregas que vencen, calificaciones y avisos de tu docente, aunque tengas el portal cerrado.</p>
      </div>
      {estado === null && <div className="text-sm text-ink-400">Revisando…</div>}
      {estado === 'activas' && (
        <>
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">✓ Activas en este dispositivo</div>
          <div className="flex flex-wrap gap-2">
            <Boton
              variante="secundario"
              disabled={ocupado}
              onClick={() =>
                accion(async () => {
                  await api('/push/prueba', { metodo: 'POST' })
                  avisar('Enviada: debe llegarte en unos segundos')
                })
              }
            >
              Enviar una de prueba
            </Boton>
            <Boton variante="fantasma" disabled={ocupado} onClick={() => accion(async () => { await apagarPush(); recargar() })}>Apagar</Boton>
          </div>
        </>
      )}
      {estado === 'apagadas' && <Boton className="w-full min-h-[48px]" disabled={ocupado} onClick={activar}>🔔 Activar notificaciones</Boton>}
      {estado === 'instalar-primero' && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">En iPhone primero instala el portal como app</div>
          <PasosIPhone />
        </div>
      )}
      {estado === 'bloqueadas' && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{TEXTO_BLOQUEADAS}</div>}
      {estado === 'sin-soporte' && <div className="rounded-xl bg-ink-100 p-3 text-sm text-ink-700">Este navegador no recibe notificaciones. En Android usa Chrome; en iPhone, Safari con el portal agregado a la pantalla de inicio.</div>}
      {!instalada() && puedeInstalar && (
        <div className="border-t border-ink-100 pt-3">
          <Boton variante="secundario" className="w-full min-h-[48px]" onClick={() =>
              accion(async () => {
                if (await instalarApp()) avisar('App instalada: búscala como «Docente»')
              })
            }>📲 Instalar la app en este dispositivo</Boton>
        </div>
      )}
    </Tarjeta>
  )
}

const CLAVE_OCULTA = 'docente-portal.invitacion-push'

/** Invitación breve arriba de Actividades / Mis materias mientras no estén activas. Se puede cerrar. */
export function InvitacionNotificaciones(): JSX.Element | null {
  const { estado, setEstado } = usePush()
  // Dentro de la app de escritorio no aplica: los avisos ya llegan como notificaciones del sistema
  let enLaApp = false
  try {
    enLaApp = sessionStorage.getItem('docente.incrustado') === '1'
  } catch {
    enLaApp = false
  }
  const [oculta, setOculta] = useState(() => {
    try {
      return localStorage.getItem(CLAVE_OCULTA) === '1'
    } catch {
      return false
    }
  })
  const [ocupado, setOcupado] = useState(false)
  if (enLaApp) return null
  if (oculta || (estado !== 'apagadas' && estado !== 'instalar-primero')) return null
  const cerrar = (): void => {
    setOculta(true)
    try {
      localStorage.setItem(CLAVE_OCULTA, '1')
    } catch {
      /* sin almacenamiento: vuelve a salir la próxima vez */
    }
  }
  return (
    <div className="rounded-2xl border border-brand-400/40 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="text-2xl leading-none" aria-hidden>🔔</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink-900">Recibe los avisos en tu celular</div>
          {estado === 'instalar-primero' ? (
            <>
              <p className="text-sm text-ink-600">En iPhone, agrega el portal a tu pantalla de inicio para que te lleguen las notificaciones.</p>
              <PasosIPhone />
            </>
          ) : (
            <p className="text-sm text-ink-600">Tareas nuevas, entregas que vencen, calificaciones y avisos de tu docente, aunque tengas el portal cerrado.</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Boton variante="fantasma" onClick={cerrar}>Ahora no</Boton>
        {estado === 'apagadas' && (
          <Boton
            disabled={ocupado}
            onClick={async () => {
              setOcupado(true)
              try {
                const e = await activarPush()
                setEstado(e)
                if (e === 'activas') avisar('Notificaciones activadas')
                else if (e === 'bloqueadas') avisar('Las bloqueaste; puedes activarlas después en Cuenta.', 'info')
              } catch (err) {
                avisar((err as Error).message, 'error')
              } finally {
                setOcupado(false)
              }
            }}
          >
            Activar
          </Boton>
        )}
      </div>
    </div>
  )
}
