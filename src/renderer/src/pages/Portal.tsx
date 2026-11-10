import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type EstadoPortal } from '../lib/api'
import Encabezado from '../components/Encabezado'
import { avisar } from '../components/Aviso'
import { fmtFechaMx } from '../lib/tiempo'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Segmentado, SinResultados, coincide } from '../components/Filtros'
import type { Notificacion } from '@shared/portal'
import { problemaPassword } from '@shared/password'
import RequisitosPassword from '../components/RequisitosPassword'

type Leidos = 'todos' | 'sin_leer'
type Clase = 'entrega' | 'contrasena' | 'otro'
/** De qué trata un aviso, para filtrarlos: entregas, contraseñas olvidadas o lo demás. */
const claseDe = (a: Notificacion): Clase => (a.ref_tipo === 'intento' ? 'entrega' : a.ref_tipo === 'restaurar' ? 'contrasena' : 'otro')
const CLASES: [Clase, string][] = [['entrega', 'Entregas'], ['contrasena', 'Contraseñas'], ['otro', 'Otros']]

/**
 * Portal de alumnos: el servidor web lo sirve esta app (en un proceso aparte). Desde aquí se enciende,
 * se comparte la dirección (QR) y se administra la cuenta con la que el docente entra al panel web.
 */
export default function Portal(): JSX.Element {
  const nav = useNavigate()
  const [e, setE] = useState<EstadoPortal | null>(null)
  const [qr, setQr] = useState<{ url: string; qr: string } | null>(null)
  const [avisos, setAvisos] = useState<Notificacion[]>([])
  const [ocupado, setOcupado] = useState(false)
  const [cuenta, setCuenta] = useState({ nombre: '', usuario: '', password: '' })
  const [editarCuenta, setEditarCuenta] = useState(false)
  const [puerto, setPuerto] = useState('')
  const [urlPublica, setUrlPublica] = useState('')
  const [error, setError] = useState('')
  // Filtros de los avisos: se recuerdan al ir a otra pantalla y volver
  const [leidosF, setLeidosF] = useRecordado<Leidos>('portal.avisos.leidos', 'todos')
  const [claseF, setClaseF] = useRecordado<Clase | ''>('portal.avisos.clase', '')
  const [buscarAviso, setBuscarAviso] = useRecordado('portal.avisos.busqueda', '')

  const cargar = async (): Promise<void> => {
    const est = await api.portal.estado()
    setE(est)
    setPuerto(String(est.puerto))
    setUrlPublica(est.url_publica)
    setQr(est.encendido ? await api.portal.qr() : null)
    setAvisos(await api.portal.notificaciones())
  }
  // Si falla la primera lectura se dice por qué, en vez de quedarse en «Cargando…»
  const primeraCarga = (): void => {
    setError('')
    cargar().catch((err) => setError((err as Error).message))
  }
  useEffect(() => {
    primeraCarga()
    return api.portal.alRecibir(() => cargar().catch(() => undefined))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const accion = async (f: () => Promise<unknown>, exito?: string): Promise<void> => {
    setOcupado(true)
    try {
      await f()
      if (exito) avisar(exito)
      await cargar()
    } catch (err) {
      avisar((err as Error).message, 'error')
    } finally {
      setOcupado(false)
    }
  }

  /** Abre la entrega en el panel web y la marca como leída (como al tocarla en el portal). */
  const abrirEntrega = async (a: Notificacion): Promise<void> => {
    try {
      nav(`/panel?ruta=${encodeURIComponent(`/docente/intentos/${a.ref_id}`)}`)
      if (!a.leida) {
        await api.portal.leidas([a.id])
        window.dispatchEvent(new Event('portal:leidas'))
        await cargar()
      }
    } catch (err) {
      avisar((err as Error).message, 'error')
    }
  }

  // «¿Olvidaste tu contraseña?» del alumno: se restaura aquí y se ve la nueva para dársela
  const [restauradas, setRestauradas] = useState<Record<number, string>>({})
  const restaurar = async (a: Notificacion): Promise<void> => {
    try {
      const password = await api.alumnos.reiniciarPassword(a.ref_id!)
      setRestauradas((x) => ({ ...x, [a.id]: password }))
      await api.portal.leidas([a.id])
      window.dispatchEvent(new Event('portal:leidas'))
      setAvisos(await api.portal.notificaciones())
    } catch (err) {
      avisar((err as Error).message, 'error')
    }
  }

  const guardarCuenta = (): Promise<void> =>
    accion(async () => {
      await api.portal.docente(cuenta.nombre, cuenta.usuario, cuenta.password)
      setCuenta({ nombre: '', usuario: '', password: '' })
      setEditarCuenta(false)
    }, 'Cuenta docente guardada')

  const marcarLeidas = (): Promise<void> =>
    accion(async () => {
      await api.portal.leidas()
      window.dispatchEvent(new Event('portal:leidas'))
    })

  if (!e && error) {
    return (
      <div className="p-8 space-y-3">
        <p className="text-red-600">No se pudo leer el estado del portal: {error}</p>
        <button className="btn-secundario" onClick={primeraCarga}>Reintentar</button>
      </div>
    )
  }
  if (!e) return <div className="p-8 text-ink-500">Cargando…</div>
  const noLeidas = avisos.filter((a) => !a.leida).length
  const pasaClase = (a: Notificacion): boolean => claseF === '' || claseDe(a) === claseF
  const pasaBusqueda = (a: Notificacion): boolean => coincide(buscarAviso, a.titulo, a.cuerpo)
  const pasaLeidos = (a: Notificacion): boolean => leidosF === 'todos' || !a.leida
  const avisosVisibles = avisos.filter((a) => pasaClase(a) && pasaBusqueda(a) && pasaLeidos(a))
  const clasesPresentes = CLASES.filter(([k]) => avisos.some((a) => claseDe(a) === k))
  const hayFiltroAvisos = leidosF !== 'todos' || claseF !== '' || !!buscarAviso.trim()
  const quitarFiltrosAvisos = (): void => {
    setLeidosF('todos')
    setClaseF('')
    setBuscarAviso('')
  }

  return (
    <div>
      <Encabezado
        titulo="Portal de alumnos"
        sub={
          e.en_linea
            ? `En línea en ${e.url_publica} · ${e.sincro?.ultima ? `sincronizado ${fmtFechaMx(e.sincro.ultima)}` : 'sin sincronizar todavía'}`
            : e.encendido
              ? `Encendido en el puerto ${e.puerto}`
              : 'Apagado'
        }
        acciones={
          <>
            {(e.encendido || e.en_linea) && e.docente_configurado && (
              <>
                {/* El panel se ve dentro de la app (página «Panel del portal»), ya con tu sesión */}
                <button className="btn-secundario" title="Quién está contestando, quién salió de la pantalla, bloquear o desbloquear exámenes" onClick={() => nav('/panel?ruta=%2Fdocente%2Fentregas')}>📊 Entregas en vivo</button>
                <button className="btn-secundario" title="Materias, publicar actividades, asistencia y calificaciones del portal" onClick={() => nav('/panel?ruta=%2Fdocente')}>Panel docente</button>
              </>
            )}
            {e.en_linea ? (
              <button className="btn-primario" disabled={ocupado} onClick={() => accion(() => api.portal.sincronizar(), 'Sincronizado con el portal en línea')}>
                {ocupado ? 'Sincronizando…' : 'Sincronizar ahora'}
              </button>
            ) : e.encendido ? (
              <button className="btn-secundario" disabled={ocupado} onClick={() => accion(() => api.portal.detener(), 'Portal apagado')}>Apagar</button>
            ) : (
              <button className="btn-primario" disabled={ocupado || !e.portal_compilado} onClick={() => accion(() => api.portal.iniciar(), 'Portal encendido')}>Encender</button>
            )}
          </>
        }
      />
      {/* Avisos a un lado mientras quepan; si no (ventana angosta o texto ampliado), debajo */}
      <div className="px-4 sm:px-8 py-6 flex flex-wrap items-start gap-5">
        <div className="space-y-5 min-w-0 flex-[999_1_30rem]">
          {e.falla && (
            <div className={`rounded-xl border p-4 text-sm space-y-2 ${e.encendido ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-red-200 bg-red-50 text-red-900'}`} role="alert">
              <div className="font-semibold">{e.encendido ? 'El portal tiene un problema' : 'El portal no pudo encender'}</div>
              <div className="break-words">{e.falla}</div>
              {/* El servidor detiene una subida que borraría más de la mitad de una tabla; solo se fuerza a sabiendas */}
              {e.en_linea && e.falla.includes('forzar') && (
                <button
                  className="btn-peligro"
                  disabled={ocupado}
                  onClick={() => window.confirm('Se aplicará de todos modos: lo que falte de un lado se borrará del otro (con lo que dependa de ello, como entregas o evaluaciones). Antes se guarda un respaldo de esta app. ¿Seguro?') && accion(() => api.portal.sincronizar(true), 'Sincronizado')}
                >
                  Sí, es correcto: sincronizar de todos modos
                </button>
              )}
            </div>
          )}
          {e.en_linea && (
            <section className="tarjeta p-5 text-sm text-ink-700 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                <h2 className="font-semibold text-ink-900">En línea</h2>
              </div>
              <p>El portal vive en internet: los alumnos entran desde cualquier lugar. Esta app sube tus materias, alumnos y evaluaciones y baja lo que ellos entregan cada minuto mientras está abierta.</p>
              <label className="flex items-start gap-2 border-t border-ink-100 pt-3"><input type="checkbox" className="mt-1" checked={e.avance_alumnos} onChange={(ev) => accion(() => api.portal.ajustes({ avance_alumnos: ev.target.checked }))} /> <span>Los alumnos ven «Mi avance»: su calificación por parcial, sus faltas y lo que necesitan para aprobar. Cada quien solo ve lo suyo.</span></label>
            </section>
          )}
          {!e.portal_compilado && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">La interfaz del portal no está compilada en esta instalación. Ejecuta <code className="font-mono">pnpm build:portal</code> o reinstala la app.</div>}

          <section className="tarjeta p-5">
            <h2 className="font-semibold text-ink-900 mb-1">Dirección para los alumnos</h2>
            <p className="text-sm text-ink-500 mb-3">Los alumnos entran desde su celular o computadora con su matrícula. Proyecta el QR o dicta la dirección.</p>
            {e.encendido || e.en_linea ? (
              <div className="flex flex-wrap gap-5 items-start">
                {qr?.qr && <img src={qr.qr} alt="QR del portal" className="w-44 h-44 shrink-0 rounded-lg border border-ink-200 bg-white" />}
                <div className="space-y-2 text-sm min-w-0 flex-[1_1_16rem]">
                  {qr?.url && <div className="font-mono text-lg text-brand-600 break-all select-all">{qr.url}</div>}
                  {!e.en_linea && <div className="text-ink-500">Todas las direcciones disponibles en esta computadora:</div>}
                  <ul className="space-y-1">
                    {e.urls.map((u) => (
                      <li key={u} className="group flex items-center gap-2 rounded-lg px-2 py-1 -mx-2 hover:bg-ink-50">
                        <span className="min-w-0 flex-1 font-mono select-all break-all">{u}</span>
                        <button className="btn-fantasma shrink-0 text-xs py-1" onClick={() => { navigator.clipboard.writeText(u); avisar('Copiada') }}>Copiar</button>
                      </li>
                    ))}
                  </ul>
                  {!e.en_linea && <p className="text-xs text-ink-400">La dirección con IP funciona en la misma red Wi-Fi que esta computadora. Para acceso desde internet, publica el portal en un servidor y escribe su dirección abajo.</p>}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-600">
                <span className="flex-1 min-w-[12rem]">El portal está apagado. Enciéndelo para ver la dirección y el QR.</span>
                <button className="btn-primario" disabled={ocupado || !e.portal_compilado} onClick={() => accion(() => api.portal.iniciar(), 'Portal encendido')}>Encender</button>
              </div>
            )}
          </section>

          <section className="tarjeta p-5 space-y-3">
            <h2 className="font-semibold text-ink-900">Cuenta docente</h2>
            {e.docente_configurado && !editarCuenta ? (
              <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
                <div className="min-w-0 flex-[1_1_16rem]">Entras al panel web como <span className="font-mono font-semibold">{e.docente_usuario}</span>. Desde la app el panel se abre sin pedir contraseña.</div>
                <button className="btn-secundario" onClick={() => { setCuenta({ nombre: '', usuario: e.docente_usuario, password: '' }); setEditarCuenta(true) }}>Cambiar contraseña</button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink-500">
                  {e.en_linea
                    ? <>Escribe la contraseña nueva de <span className="font-mono font-semibold">{cuenta.usuario}</span>; no hace falta la actual. Llega al portal en línea en unos segundos.</>
                    : 'Con esta cuenta entras al panel web desde cualquier dispositivo para publicar actividades, revisar entregas y calificar. Todas tus materias quedan ligadas a ella.'}
                </p>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
                  {!e.en_linea && <label><span className="etiqueta">Nombre</span><input className="input" value={cuenta.nombre} onChange={(ev) => setCuenta({ ...cuenta, nombre: ev.target.value })} placeholder="Si lo dejas vacío, se queda el actual" /></label>}
                  {!e.en_linea && <label><span className="etiqueta">Usuario</span><input className="input" value={cuenta.usuario} onChange={(ev) => setCuenta({ ...cuenta, usuario: ev.target.value })} placeholder="jpoumian" autoCapitalize="off" /></label>}
                  <label><span className="etiqueta">{e.en_linea ? 'Contraseña nueva' : 'Contraseña'}</span><input type="password" className="input" value={cuenta.password} onChange={(ev) => setCuenta({ ...cuenta, password: ev.target.value })} autoComplete="new-password" /></label>
                </div>
                <RequisitosPassword password={cuenta.password} />
                <div className="flex justify-end gap-2">
                  {editarCuenta && <button className="btn-secundario" onClick={() => setEditarCuenta(false)}>Cancelar</button>}
                  <button className="btn-primario" disabled={ocupado || !cuenta.usuario || problemaPassword(cuenta.password) !== null} title={problemaPassword(cuenta.password) ?? undefined} onClick={guardarCuenta}>Guardar</button>
                </div>
              </div>
            )}
          </section>

          {!e.en_linea && (
          <section className="tarjeta p-5 space-y-3">
            <h2 className="font-semibold text-ink-900">Configuración</h2>
            {/* Puerto y dirección se guardan con su botón; las casillas se aplican al momento */}
            <div className="flex flex-wrap gap-3 items-end">
              <label className="flex-[1_1_7rem]"><span className="etiqueta">Puerto</span><input className="input" inputMode="numeric" value={puerto} onChange={(ev) => setPuerto(ev.target.value.replace(/\D/g, ''))} /></label>
              <label className="flex-[3_1_16rem] min-w-0"><span className="etiqueta">Dirección pública (opcional, si lo publicas en internet)</span><input className="input" value={urlPublica} onChange={(ev) => setUrlPublica(ev.target.value)} placeholder="https://portal.mi-universidad.edu.mx" /></label>
              <button className="btn-secundario" disabled={ocupado} onClick={() => accion(() => api.portal.ajustes({ puerto: Number(puerto), url_publica: urlPublica }), e.encendido ? 'Guardado. Apaga y enciende el portal para aplicar el puerto.' : 'Guardado')}>Guardar</button>
            </div>
            <div className="space-y-2 border-t border-ink-100 pt-3 text-sm">
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={e.auto_iniciar} onChange={(ev) => accion(() => api.portal.ajustes({ auto_iniciar: ev.target.checked }))} /> <span>Encender el portal al abrir la app</span></label>
              <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={e.avance_alumnos} onChange={(ev) => accion(() => api.portal.ajustes({ avance_alumnos: ev.target.checked }))} /> <span>Los alumnos ven «Mi avance»: su calificación por parcial (con el detalle de cada parte), sus faltas y lo que necesitan para aprobar. Cada quien solo ve lo suyo.</span></label>
            </div>
          </section>
          )}

          <details className="tarjeta p-5 text-sm text-ink-600 group/como">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden font-semibold text-ink-900 flex items-center gap-2">
              <span className="text-ink-400 transition-transform duration-200 group-open/como:rotate-90" aria-hidden>▸</span>
              Cómo funciona
            </summary>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5">
              <li>En cada materia, pestaña <b>Alumnos</b>, pulsa <b>Accesos al portal</b>: cada alumno entra con su matrícula y la cambia por su contraseña al primer ingreso.</li>
              <li>En una evaluación pulsa <b>Publicar en el portal</b> para asignarla con fecha de apertura, cierre, duración y vigilancia. Los alumnos reciben el aviso.</li>
              <li>Las respuestas se guardan solas; las de opción múltiple y verdadero/falso se califican automáticamente. Aquí recibes un aviso por cada entrega.</li>
              <li><b>Jugar en vivo</b> convierte cualquier evaluación en un concurso con PIN al estilo Kahoot.</li>
              <li>Un alumno solo puede tener una sesión abierta; si entra en otro dispositivo, la anterior se cierra.</li>
            </ol>
          </details>
        </div>

        <aside className="tarjeta min-w-0 flex-[1_1_20rem] overflow-hidden" aria-label="Avisos del portal">
          <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
            <h2 className="flex items-center gap-1.5 font-semibold text-ink-900">
              Avisos
              {noLeidas > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white" aria-label={`${noLeidas} sin leer`}>{noLeidas}</span>}
            </h2>
            {noLeidas > 0 && <button className="btn-fantasma text-xs py-1" onClick={marcarLeidas}>Marcar todos leídos</button>}
          </div>
          {avisos.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-500">Aquí aparecerán las entregas de los alumnos, las contraseñas olvidadas y otros avisos del portal.</p>
          ) : (
            <>
              {/* Filtros: solo cambian qué avisos se ven */}
              <div className="space-y-2 border-b border-ink-100 bg-ink-50/50 px-4 py-2.5" role="search" aria-label="Filtrar avisos">
                <div className="flex flex-wrap items-center gap-2">
                  <Segmentado
                    etiqueta="Leídos"
                    valor={leidosF}
                    onCambio={setLeidosF}
                    opciones={[
                      { valor: 'todos', texto: 'Todos', conteo: avisos.filter((a) => pasaClase(a) && pasaBusqueda(a)).length },
                      { valor: 'sin_leer', texto: 'Sin leer', conteo: avisos.filter((a) => pasaClase(a) && pasaBusqueda(a) && !a.leida).length }
                    ]}
                  />
                  {hayFiltroAvisos && <button className="btn-fantasma text-xs py-1" onClick={quitarFiltrosAvisos}>Quitar filtros</button>}
                </div>
                {clasesPresentes.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Tipo de aviso">
                    {clasesPresentes.map(([k, t]) => (
                      <ChipFiltro key={k} activo={claseF === k} onClick={() => setClaseF(claseF === k ? '' : k)} conteo={avisos.filter((a) => claseDe(a) === k && pasaBusqueda(a) && pasaLeidos(a)).length}>
                        {t}
                      </ChipFiltro>
                    ))}
                  </div>
                )}
                {/* Con pocos avisos el buscador estorba más de lo que ayuda */}
                {(avisos.length > 8 || buscarAviso) && <Buscador valor={buscarAviso} onCambio={setBuscarAviso} placeholder="Buscar alumno o evaluación" etiqueta="Buscar en los avisos" />}
              </div>
              {avisosVisibles.length === 0 ? (
                <SinResultados hayFiltro={hayFiltroAvisos} onLimpiar={quitarFiltrosAvisos} vacio="Sin avisos." />
              ) : (
                <ul className="max-h-[60vh] divide-y divide-ink-100 overflow-auto">
                  {avisosVisibles.map((a) => (
                    <li key={a.id} className={`px-4 py-2.5 text-sm ${a.leida ? '' : 'bg-brand-500/[0.04]'}`}>
                      <div className="flex items-start gap-2">
                        {/* Punto para lo que no se ha leído */}
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.leida ? 'bg-transparent' : 'bg-brand-500'}`} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className={`break-words ${a.leida ? 'text-ink-600' : 'font-medium text-ink-900'}`}>{a.titulo}</div>
                          {a.cuerpo && <div className="mt-0.5 break-words text-xs text-ink-500">{a.cuerpo}</div>}
                          {restauradas[a.id] && (
                            <div className="mt-1.5 rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                              Restaurada. Su contraseña ahora es <span className="font-mono font-bold select-all">{restauradas[a.id]}</span>; al entrar la cambiará.
                            </div>
                          )}
                          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11px] text-ink-400">{fmtFechaMx(a.creada)}</span>
                            {/* Igual que en el portal web: el aviso de una entrega lleva a ella */}
                            {a.ref_tipo === 'restaurar' && a.ref_id && !a.leida && !restauradas[a.id] ? (
                              <button className="btn-primario text-xs py-1" onClick={() => void restaurar(a)}>
                                Restaurar contraseña
                              </button>
                            ) : null}
                            {a.ref_tipo === 'intento' && a.ref_id ? (
                              <button className="btn-secundario text-xs py-1" onClick={() => void abrirEntrega(a)}>
                                Abrir entrega
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
