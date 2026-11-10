import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { avisar } from './Aviso'
import { fmtFechaMx } from '../lib/tiempo'
import { ORIGENES_ERROR, type ErrorRegistrado } from '@shared/errores'

/** «Acción» son llamadas que la app rechazó (a veces solo validaciones): se ven aparte de las fallas */
export const esFalla = (e: ErrorRegistrado): boolean => e.origen !== 'base'

const COLOR: Record<ErrorRegistrado['origen'], string> = {
  principal: 'bg-red-50 text-red-700',
  ventana: 'bg-red-50 text-red-700',
  pantalla: 'bg-amber-50 text-amber-800',
  sincronizacion: 'bg-sky-50 text-sky-700',
  base: 'bg-ink-100 text-ink-600'
}

/** Ajustes › Errores: lo que ha fallado en la app, con fecha, cuántas veces y el detalle para diagnosticar. */
export default function RegistroErrores(): JSX.Element {
  const [lista, setLista] = useState<ErrorRegistrado[] | null>(null)
  const [todo, setTodo] = useState(false)
  const cargar = useCallback(() => {
    api.errores.listar().then(setLista).catch(() => setLista([]))
  }, [])
  useEffect(() => {
    cargar()
    return api.errores.alNuevo(() => cargar())
  }, [cargar])

  const visibles = (lista ?? []).filter((e) => todo || esFalla(e))
  const pendientes = (lista ?? []).filter((e) => esFalla(e) && !e.revisado).length
  const acciones = (lista ?? []).filter((e) => !esFalla(e)).length

  const revisados = async (): Promise<void> => {
    await api.errores.revisados()
    cargar()
    window.dispatchEvent(new Event('errores:revisados'))
  }
  const borrar = async (): Promise<void> => {
    if (!confirm('¿Borrar todo el registro de errores? No afecta tus datos.')) return
    await api.errores.borrar()
    cargar()
    window.dispatchEvent(new Event('errores:revisados'))
    avisar('Registro de errores borrado')
  }
  const copiar = (e: ErrorRegistrado): void => {
    const t = [`${ORIGENES_ERROR[e.origen]} · ${e.donde}`, e.mensaje, `Primera vez: ${e.fecha} · Última: ${e.ultima} · ${e.veces} vez/veces · v${e.version}`, e.detalle].filter(Boolean).join('\n')
    navigator.clipboard.writeText(t).then(() => avisar('Error copiado'), () => avisar('No se pudo copiar', 'error'))
  }

  return (
    <section id="ajustes-errores" className="tarjeta scroll-mt-28 p-5 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-ink-900">Errores de la app</h3>
        {pendientes > 0 ? (
          <span className="chip bg-red-50 text-red-700">{pendientes === 1 ? '1 sin revisar' : `${pendientes} sin revisar`}</span>
        ) : (
          lista && <span className="chip bg-emerald-50 text-emerald-700">Todo en orden</span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {pendientes > 0 && <button className="btn-secundario text-xs py-1" onClick={revisados}>Marcar como revisados</button>}
          {window.api.plataforma !== 'web' && <button className="btn-fantasma text-xs py-1" onClick={() => api.errores.mostrarArchivo()}>Ver archivo</button>}
          {!!lista?.length && <button className="btn-fantasma text-xs py-1 text-red-600" onClick={borrar}>Borrar registro</button>}
        </div>
      </div>
      <p className="text-xs text-ink-500">
        Se anota solo lo que falla: errores de la app, pantallas que no se pudieron mostrar y fallas de la sincronización con el portal en línea. Si algo se repite, se cuenta en la misma línea.
      </p>
      {acciones > 0 && (
        <label className="flex items-center gap-2 text-xs text-ink-600">
          <input type="checkbox" checked={todo} onChange={(e) => setTodo(e.target.checked)} />
          Incluir acciones rechazadas ({acciones}), como datos que faltaban al guardar
        </label>
      )}
      {!lista ? (
        <div className="text-sm text-ink-500">Cargando…</div>
      ) : !visibles.length ? (
        <div className="rounded-lg bg-ink-50 px-3 py-4 text-center text-sm text-ink-500">Sin errores registrados.</div>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-ink-200">
          {visibles.slice(0, 100).map((e) => (
            <li key={e.id} className={`p-3 text-sm ${e.revisado || !esFalla(e) ? '' : 'bg-red-50/40'}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`chip ${COLOR[e.origen]}`}>{ORIGENES_ERROR[e.origen]}</span>
                <span className="text-xs text-ink-500">{e.donde}</span>
                <span className="ml-auto text-xs text-ink-400">
                  {fmtFechaMx(e.ultima)}
                  {e.veces > 1 ? ` · ${e.veces} veces desde ${fmtFechaMx(e.fecha)}` : ''}
                </span>
              </div>
              <div className="mt-1 break-words text-ink-800">{e.mensaje}</div>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                {e.detalle && (
                  <details className="min-w-0 flex-1">
                    <summary className="cursor-pointer text-xs text-ink-500">Detalle</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-ink-50 p-2 font-mono text-[11px] text-ink-600">{e.detalle}</pre>
                  </details>
                )}
                <button className="btn-fantasma ml-auto text-xs py-0.5" onClick={() => copiar(e)}>Copiar</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {visibles.length > 100 && <p className="text-xs text-ink-400">Se muestran los 100 más recientes; el resto está en el archivo.</p>}
    </section>
  )
}
