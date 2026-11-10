import { useCallback, useEffect, useState } from 'react'
import { api, type CambioVersion, type EstadoActualizacion } from '../lib/api'
import { avisar } from './Aviso'
import { useClase } from '../store/clase'

export function fmtCompilacion(fecha: string): string {
  return new Date(fecha).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
}

const fmtDia = (fecha: string): string => new Date(fecha).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' })

/** Lista de cambios de una versión (los textos vienen de los cambios guardados en git) */
function ListaCambios({ cambios }: { cambios: CambioVersion[] }): JSX.Element {
  return (
    <ul className="space-y-1 text-sm">
      {cambios.map((c) => (
        <li key={c.hash} className="flex gap-2">
          <span className="shrink-0 w-14 text-xs text-ink-500 pt-0.5">{fmtDia(c.fecha)}</span>
          <span className="text-ink-700">{c.texto}</span>
        </li>
      ))}
    </ul>
  )
}

/** Revisa al abrir y cada vez que la ventana vuelve a tener el foco (tras compilar en la terminal). */
export function useActualizacion(): {
  estado: EstadoActualizacion | null
  revisando: boolean
  instalando: boolean
  revisar: () => Promise<EstadoActualizacion | null>
  instalar: () => Promise<void>
} {
  const [estado, setEstado] = useState<EstadoActualizacion | null>(null)
  const [revisando, setRevisando] = useState(false)
  const [instalando, setInstalando] = useState(false)
  const corriendo = useClase((s) => s.corriendo)

  const revisar = useCallback(async () => {
    setRevisando(true)
    try {
      const e = await api.actualizacion.revisar()
      setEstado(e)
      return e
    } catch {
      return null
    } finally {
      setRevisando(false)
    }
  }, [])

  useEffect(() => {
    revisar()
    const alVolver = (): void => { revisar() }
    window.addEventListener('focus', alVolver)
    return () => window.removeEventListener('focus', alVolver)
  }, [revisar])

  const instalar = async (): Promise<void> => {
    const enPortal = await api.actualizacion.contestando().catch(() => ({ alumnos: 0, partidas: 0 }))
    const aviso =
      (corriendo ? '\n\nHay una clase con el reloj corriendo: se detendrá al cerrar.' : '') +
      (enPortal.alumnos ? `\n\n⚠️ ${enPortal.alumnos === 1 ? 'Hay 1 alumno contestando' : `Hay ${enPortal.alumnos} alumnos contestando`} una actividad en el portal: verán errores de conexión mientras se actualiza (sus respuestas quedan guardadas en su celular). Mejor actualiza al terminar.` : '') +
      (enPortal.partidas ? `\n\n⚠️ Hay un juego en vivo en curso: se interrumpirá.` : '')
    // Sin nada en curso se actualiza directo; solo se pregunta si se interrumpiría una clase, un examen o un juego
    if (aviso && !confirm(`La app se cerrará unos segundos, se instalará la versión nueva y se abrirá sola. El portal de alumnos se apaga mientras tanto.${aviso}\n\n¿Actualizar ahora?`)) return
    setInstalando(true)
    try {
      await api.actualizacion.instalar()
    } catch (e) {
      setInstalando(false)
      avisar((e as Error).message, 'error')
    }
  }

  return { estado, revisando, instalando, revisar, instalar }
}

/** Aviso al pie de la barra lateral; solo aparece si hay una versión más nueva en release/. */
export function AvisoActualizacion(): JSX.Element | null {
  const { estado, instalando, instalar } = useActualizacion()
  if (!estado?.hay_nueva) return null
  return (
    <div className="mx-2 mb-2 rounded-lg border border-brand-500/30 bg-brand-500/5 px-3 py-2 text-xs no-arrastre">
      <div className="font-medium text-ink-700">Hay una versión nueva</div>
      {estado.disponible && <div className="text-ink-500">Versión {estado.disponible.version} · {fmtCompilacion(estado.disponible.fecha)}</div>}
      {estado.novedades.length > 0 && <div className="text-ink-500">{estado.novedades.length === 1 ? '1 cambio nuevo' : `${estado.novedades.length} cambios nuevos`} (detalle en Ajustes)</div>}
      <button className="mt-1.5 w-full rounded-md bg-brand-500 px-2 py-1 font-medium text-white hover:bg-brand-600 disabled:opacity-60" disabled={instalando} onClick={instalar}>
        {instalando ? 'Actualizando…' : 'Actualizar'}
      </button>
    </div>
  )
}

/** Tarjeta de Ajustes: versión instalada, botón Buscar y, si hay una nueva, Actualizar. */
export function TarjetaVersion(): JSX.Element {
  const { estado, revisando, instalando, revisar, instalar } = useActualizacion()
  const [verTodos, setVerTodos] = useState(false)
  const recientes = estado?.instalada?.cambios ?? []
  const buscar = async (): Promise<void> => {
    const e = await revisar()
    if (e && !e.hay_nueva) avisar(e.motivo || 'Ya tienes la versión más reciente.')
  }
  return (
    <section className="tarjeta p-5 space-y-3">
      <h3 className="font-semibold">Versión de la app</h3>
      <p className="text-sm text-ink-600">
        Instalada: {estado?.instalada ? <span className="font-medium">versión {estado.instalada.version} · compilada el {fmtCompilacion(estado.instalada.fecha)}</span> : <span className="text-ink-500">sin fecha de compilación</span>}
      </p>
      {estado?.hay_nueva && estado.disponible && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 space-y-2">
          <p className="text-sm text-green-800 font-medium">Disponible: versión {estado.disponible.version} · compilada el {fmtCompilacion(estado.disponible.fecha)}</p>
          {estado.novedades.length > 0 && (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-green-800">Qué trae</p>
              <ListaCambios cambios={estado.novedades} />
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {estado?.hay_nueva ? (
          <button className="btn-primario" disabled={instalando} onClick={instalar}>{instalando ? 'Actualizando…' : 'Actualizar y reiniciar'}</button>
        ) : (
          <button className="btn-secundario" disabled={revisando} onClick={buscar}>{revisando ? 'Buscando…' : 'Buscar actualización'}</button>
        )}
      </div>
      <p className="text-xs text-ink-500">
        Toma la versión que dejas en <code className="bg-ink-100 rounded px-1">release/</code> al correr <code className="bg-ink-100 rounded px-1">pnpm dist:mac</code> en el proyecto. Revisa sola al abrir la app y cada vez que vuelves a ella.
      </p>
      {estado?.motivo && !estado.hay_nueva && <p className="text-xs text-amber-700">{estado.motivo}</p>}
      {recientes.length > 0 && (
        <div className="space-y-2 border-t border-ink-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Últimos cambios de tu versión</p>
          <ListaCambios cambios={verTodos ? recientes : recientes.slice(0, 6)} />
          {recientes.length > 6 && (
            <button className="text-sm text-brand-600 hover:underline" onClick={() => setVerTodos((x) => !x)}>
              {verTodos ? 'Ver menos' : `Ver los ${recientes.length}`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
