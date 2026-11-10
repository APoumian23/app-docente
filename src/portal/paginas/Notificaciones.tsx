import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fechaMx } from '../lib/api'
import { useSesion } from '../lib/sesion'
import { Boton, Cargando, EncabezadoPagina, ErrorCarga, Vacio, Tarjeta, avisar } from '../componentes/ui'
import { FilaChips, SinResultados, useRecordado } from '../componentes/Filtros'
import type { Notificacion } from '@shared/portal'

const ICONO: Record<string, string> = { asignacion: '📝', entrega: '📥', calificacion: '⭐', acceso: '🔑' }

type FiltroLeidas = 'todas' | 'no_leidas' | 'leidas'

/** Lista de notificaciones. Cada una lleva a lo que la originó. */
export default function Notificaciones(): JSX.Element {
  const { usuario } = useSesion()
  const [lista, setLista] = useState<Notificacion[] | null>(null)
  // Si la carga falla se dice y se ofrece reintentar: «Sin notificaciones» haría creer que no hay nada
  const [error, setError] = useState('')
  const [filtro, setFiltro] = useRecordado<FiltroLeidas>('notificaciones.leidas', 'todas')

  const cargar = (): void => {
    setError('')
    api<Notificacion[]>('/notificaciones')
      .then(setLista)
      .catch((e) => {
        setLista(null)
        setError((e as Error).message || 'No se pudieron cargar las notificaciones.')
      })
  }
  useEffect(cargar, [])

  const marcarTodas = async (): Promise<void> => {
    try {
      await api('/notificaciones/leidas', { metodo: 'POST', cuerpo: {} })
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  // «¿Olvidaste tu contraseña?»: el docente la restaura aquí mismo y ve la nueva para dársela
  const [restauradas, setRestauradas] = useState<Record<number, string>>({})
  const restaurar = async (n: Notificacion): Promise<void> => {
    try {
      const r = await api<{ password: string }>(`/docente/alumnos/${n.ref_id}/reiniciar-password`, { metodo: 'POST' })
      setRestauradas((x) => ({ ...x, [n.id]: r.password }))
      await api('/notificaciones/leidas', { metodo: 'POST', cuerpo: { ids: [n.id] } }).catch(() => undefined)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const destino = (n: Notificacion): string => {
    if (usuario?.rol === 'docente') return n.ref_tipo === 'intento' ? `/docente/intentos/${n.ref_id}` : '/docente/entregas'
    if (n.ref_tipo === 'asignacion') return `/actividad/${n.ref_id}`
    // Un aviso del docente se lee completo arriba de las actividades
    if (n.tipo === 'aviso') return '/'
    if (n.ref_tipo === 'tarea') return '/tareas'
    return '/calificaciones'
  }

  if (error)
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <EncabezadoPagina titulo="Notificaciones" />
        <ErrorCarga titulo="No se pudieron cargar las notificaciones" detalle={error} onReintentar={cargar} />
      </div>
    )
  if (!lista) return <Cargando />
  const noLeidas = lista.filter((n) => !n.leida).length
  const visibles = lista.filter((n) => filtro === 'todas' || (filtro === 'no_leidas' ? !n.leida : !!n.leida))
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <EncabezadoPagina titulo="Notificaciones">
        {noLeidas > 0 && <Boton variante="fantasma" className="-mr-2" onClick={marcarTodas}>Marcar todas como leídas</Boton>}
      </EncabezadoPagina>
      {lista.length > 0 && (
        <FilaChips
          etiqueta="Filtrar notificaciones"
          valor={filtro}
          onCambio={setFiltro}
          opciones={[
            { valor: 'todas', texto: 'Todas', conteo: lista.length },
            { valor: 'no_leidas', texto: 'Sin leer', conteo: noLeidas },
            { valor: 'leidas', texto: 'Leídas', conteo: lista.length - noLeidas }
          ]}
        />
      )}
      {lista.length === 0 ? (
        <Vacio icono="🔔" titulo="Sin notificaciones" detalle="Aquí verás nuevas actividades, entregas y calificaciones." />
      ) : visibles.length === 0 ? (
        filtro === 'no_leidas' ? (
          <Vacio icono="✓" titulo="Ya leíste todo" detalle="No tienes notificaciones sin leer.">
            <Boton variante="secundario" onClick={() => setFiltro('todas')}>Ver todas</Boton>
          </Vacio>
        ) : (
          <SinResultados onLimpiar={() => setFiltro('todas')} detalle="Todavía no has leído ninguna." />
        )
      ) : (
        <ul className="space-y-2">
          {visibles.map((n) =>
            n.ref_tipo === 'restaurar' && usuario?.rol === 'docente' && n.ref_id ? (
              <li key={n.id}>
                <Tarjeta className={`space-y-2 ${n.leida && !restauradas[n.id] ? 'bg-ink-50 shadow-none' : 'border-brand-200'}`}>
                  <div className="flex gap-3">
                    <span className="text-2xl leading-none" aria-hidden>🔑</span>
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium text-ink-900">{n.titulo}</div>
                      <div className="break-words text-sm text-ink-600">{n.cuerpo}</div>
                      <div className="mt-1 text-xs text-ink-500">{fechaMx(n.creada)}</div>
                    </div>
                  </div>
                  {restauradas[n.id] ? (
                    <div className="rounded-xl bg-green-50 px-3 py-2 text-sm text-green-800">
                      Restaurada. Su contraseña ahora es <span className="font-mono font-bold select-all">{restauradas[n.id]}</span>; al entrar la cambiará.
                    </div>
                  ) : !n.leida ? (
                    <Boton className="w-full sm:w-auto" onClick={() => void restaurar(n)}>Restaurar contraseña</Boton>
                  ) : null}
                </Tarjeta>
              </li>
            ) : (
              <li key={n.id}>
                <Link
                  to={destino(n)}
                  className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
                  onClick={() => api('/notificaciones/leidas', { metodo: 'POST', cuerpo: { ids: [n.id] } }).catch(() => undefined)}
                >
                  {/* Las leídas se apagan con fondo gris, no con transparencia: el texto sigue legible */}
                  <Tarjeta className={`flex gap-3 transition-colors duration-150 ${n.leida ? 'bg-ink-50 shadow-none hover:bg-ink-100' : 'border-brand-200 hover:bg-brand-500/5'}`}>
                    <span className="text-2xl leading-none" aria-hidden>{ICONO[n.tipo] ?? '🔔'}</span>
                    <div className="min-w-0 flex-1">
                      <div className={`break-words text-ink-900 ${n.leida ? 'font-medium' : 'font-semibold'}`}>{n.titulo}</div>
                      <div className="line-clamp-3 break-words text-sm text-ink-600">{n.cuerpo}</div>
                      <div className="mt-1 text-xs text-ink-500">{fechaMx(n.creada)}</div>
                    </div>
                    {!n.leida && (
                      <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500">
                        <span className="sr-only">Sin leer</span>
                      </span>
                    )}
                  </Tarjeta>
                </Link>
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}
