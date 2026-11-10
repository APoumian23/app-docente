import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { DetallePartida, Participante, PreguntaPartida } from '@shared/portal'
import Markdown from '../../componentes/Markdown'
import { Boton, Modal, avisar } from '../../componentes/ui'
import { api } from '../../lib/api'
import { useSesion } from '../../lib/sesion'
import { AvisoConexion, BarraTiempo, Podio, TablaPosiciones, conectarPartida, estiloOpcion, formatoPin, type EstadoPartidaVivo, type ResultadoPregunta, type SocketPartida } from './comun'

type Accion = 'iniciar' | 'siguiente' | 'mostrar' | 'terminar'

/** Lo que espera el acuse del servidor antes de soltar los botones. */
const ESPERA_ACUSE_MS = 5000

/** Quién eligió cada opción incorrecta de una pregunta y quién no respondió. */
function QuienFallo({ detalle, indice, opciones }: { detalle: DetallePartida | null; indice: number; opciones: string[] }): JSX.Element {
  if (!detalle) return <div className="rounded-2xl bg-white p-4 text-ink-500 md:p-5">Cargando respuestas…</div>
  const q = detalle.preguntas.find((x) => x.indice === indice)
  const correcta = q?.correcta ?? -1
  const textos = q?.opciones ?? opciones
  const porOpcion = textos.map((_, i) => detalle.jugadores.filter((j) => j.respuestas[indice]?.opcion === i).map((j) => j.apodo))
  const sinResponder = detalle.jugadores.filter((j) => !j.respuestas[indice]).map((j) => j.apodo)
  const fallaron = porOpcion.reduce((n, l, i) => (i === correcta ? n : n + l.length), 0)
  return (
    <div className="rounded-2xl bg-white p-4 text-ink-900 md:p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        Quién falló · {fallaron} {fallaron === 1 ? 'respuesta incorrecta' : 'respuestas incorrectas'}
        {sinResponder.length ? ` · ${sinResponder.length} sin responder` : ''}
      </div>
      <div className="mt-2 space-y-2 text-base md:text-lg">
        {textos.map((t, i) =>
          i === correcta || !porOpcion[i].length ? null : (
            <div key={i} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <span className="shrink-0 font-semibold text-red-600">
                ✗ {estiloOpcion(i).simbolo} {t}
              </span>
              <span className="min-w-0 break-words text-ink-700">{porOpcion[i].join(', ')}</span>
            </div>
          )
        )}
        {sinResponder.length ? (
          <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
            <span className="shrink-0 font-semibold text-ink-500">⏱ Sin responder</span>
            <span className="min-w-0 break-words text-ink-700">{sinResponder.join(', ')}</span>
          </div>
        ) : null}
        {fallaron === 0 && !sinResponder.length ? <div className="text-green-700">¡Nadie falló esta pregunta! 🎉</div> : null}
      </div>
    </div>
  )
}

/** Al final: aciertos, errores y en qué preguntas falló cada jugador. */
function RespuestasPorJugador({ detalle }: { detalle: DetallePartida | null }): JSX.Element {
  if (!detalle) return <div className="py-4 text-white/70">Cargando respuestas…</div>
  const total = detalle.preguntas.length
  const filas = detalle.jugadores.map((j) => {
    const mal = detalle.preguntas.filter((q) => j.respuestas[q.indice] && !j.respuestas[q.indice].correcta).map((q) => q.indice + 1)
    const sin = detalle.preguntas.filter((q) => !j.respuestas[q.indice]).map((q) => q.indice + 1)
    return { ...j, bien: total - mal.length - sin.length, mal, sin }
  })
  const ninguna = total ? filas.filter((f) => f.sin.length === total) : []
  return (
    <div className="space-y-3">
      {ninguna.length ? (
        <div className="rounded-2xl bg-amber-300/20 p-3 text-amber-100 ring-1 ring-amber-300/40">
          <span className="font-semibold">⚠ No contestaron ninguna ({ninguna.length}):</span> {ninguna.map((f) => f.apodo).join(', ')}
        </div>
      ) : total ? (
        <div className="text-sm text-white/70">Todos contestaron al menos una pregunta.</div>
      ) : null}
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm md:text-base">
        <thead className="text-xs uppercase tracking-wide text-white/60">
          <tr>
            <th className="py-2 pr-3">Jugador</th>
            <th className="py-2 pr-3 text-right">✓</th>
            <th className="py-2 pr-3 text-right">✗</th>
            <th className="py-2 pr-3 text-right">⏱</th>
            <th className="py-2">Falló en las preguntas</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.id} className="border-t border-white/10 align-top">
              <td className="py-2 pr-3 font-semibold">
                {f.apodo}
                {total && f.sin.length === total ? <span className="ml-2 rounded-full bg-amber-300/25 px-2 py-0.5 text-xs font-semibold text-amber-100">no contestó ninguna</span> : null}
              </td>
              <td className="py-2 pr-3 text-right font-mono tabular-nums text-green-300">{f.bien}</td>
              <td className="py-2 pr-3 text-right font-mono tabular-nums text-red-300">{f.mal.length}</td>
              <td className="py-2 pr-3 text-right font-mono tabular-nums text-white/60">{f.sin.length}</td>
              <td className="py-2 text-white/80">
                {f.mal.length ? f.mal.join(', ') : '—'}
                {f.sin.length ? <span className="text-white/50"> · sin responder: {f.sin.join(', ')}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  )
}

/** Pantalla del docente para proyectar: PIN, preguntas, resultados y podio. */
export default function Anfitrion(): JSX.Element {
  const { pin = '' } = useParams()
  const token = useSesion((s) => s.token)
  const socketRef = useRef<SocketPartida | null>(null)

  const [estado, setEstado] = useState<EstadoPartidaVivo | null>(null)
  const [errorCarga, setErrorCarga] = useState('')
  const [conectado, setConectado] = useState(false)
  const [pregunta, setPregunta] = useState<PreguntaPartida | null>(null)
  const [inicio, setInicio] = useState(0)
  const [respondieron, setRespondieron] = useState(0)
  const [resultado, setResultado] = useState<ResultadoPregunta | null>(null)
  const [tablaFinal, setTablaFinal] = useState<Participante[] | null>(null)
  const [confirmarFin, setConfirmarFin] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [pantallaCompleta, setPantallaCompleta] = useState(false)
  // Dirección que ven los alumnos (IP de la red o dominio público): la de esta ventana suele ser localhost
  const [urlAlumnos, setUrlAlumnos] = useState('')
  // Quién falló: oculto hasta que el docente lo pide (la pantalla suele estar proyectada al grupo)
  const [verFallos, setVerFallos] = useState(false)
  const [detalle, setDetalle] = useState<DetallePartida | null>(null)

  useEffect(() => {
    api<EstadoPartidaVivo & { url_alumnos?: string }>(`/partidas/${pin}`)
      .then((p) => {
        setEstado(p)
        if (p.url_alumnos) setUrlAlumnos(p.url_alumnos)
        if (p.estado === 'terminada') setTablaFinal(p.participantes)
      })
      .catch((e) => setErrorCarga((e as Error).message))
  }, [pin])

  useEffect(() => {
    const socket = conectarPartida(token)
    socketRef.current = socket
    socket.on('connect', () => {
      setConectado(true)
      socket.emit('partida:observar', { pin })
    })
    socket.on('disconnect', () => setConectado(false))
    socket.on('connect_error', () => setConectado(false))
    socket.on('partida:estado', (e) => setEstado(e))
    socket.on('partida:pregunta', (q) => {
      setPregunta(q)
      setInicio(Date.now())
      setRespondieron(0)
      setResultado(null)
      // Si el acuse de la acción anterior se perdió, los botones no se quedan bloqueados
      setOcupado(false)
    })
    socket.on('partida:respondieron', (d) => setRespondieron(d.n))
    socket.on('partida:resultado', (r) => {
      setResultado(r)
      setOcupado(false)
    })
    socket.on('partida:fin', (t) => setTablaFinal(t))
    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [pin, token])

  // Las respuestas se piden al mostrar cada resultado (o al terminar) solo si el docente las quiere ver
  const enResultado = estado?.estado === 'resultado' || estado?.estado === 'terminada' || tablaFinal !== null
  useEffect(() => {
    if (!verFallos || !enResultado) return
    setDetalle(null)
    api<DetallePartida>(`/docente/partidas/${pin}/detalle`)
      .then(setDetalle)
      .catch((e) => avisar((e as Error).message, 'error'))
  }, [verFallos, enResultado, resultado, tablaFinal, pin])

  useEffect(() => {
    const al = (): void => setPantallaCompleta(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', al)
    return () => document.removeEventListener('fullscreenchange', al)
  }, [])

  const controlar = (accion: Accion): void => {
    const socket = socketRef.current
    if (!socket) return
    setOcupado(true)
    socket.timeout(ESPERA_ACUSE_MS).emit('partida:controlar', { pin, accion }, (err, r) => {
      setOcupado(false)
      if (err) avisar('El servidor no respondió. Revisa la conexión e inténtalo otra vez.', 'error')
      else if (!r.ok) avisar(r.error ?? 'No se pudo hacer eso.', 'error')
    })
  }

  const alternarPantalla = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen?.()
  }

  const participantes = estado?.participantes ?? []
  const tabla = tablaFinal ?? resultado?.tabla ?? participantes
  const terminada = tablaFinal !== null || estado?.estado === 'terminada'
  const hayMas = estado ? estado.pregunta_actual + 1 < estado.total_preguntas : false
  const numero = pregunta ? pregunta.indice + 1 : (estado?.pregunta_actual ?? 0) + 1
  const totalPreguntas = pregunta?.total ?? estado?.total_preguntas ?? 0
  const direccion = `${(urlAlumnos || window.location.origin).replace(/^https?:\/\//, '')}/juego`

  let contenido: JSX.Element
  if (errorCarga) {
    contenido = (
      <div className="m-auto max-w-lg rounded-3xl bg-white p-8 text-center text-ink-900">
        <div className="text-5xl">😕</div>
        <p className="mt-3 text-2xl font-semibold">{errorCarga}</p>
        <Link to="/docente" className="mt-6 inline-flex min-h-[56px] items-center justify-center rounded-2xl bg-brand-500 px-6 text-lg font-semibold text-white hover:bg-brand-600">
          Volver a mis materias
        </Link>
      </div>
    )
  } else if (!estado) {
    contenido = (
      <div className="m-auto flex items-center gap-3 text-xl text-white/80">
        <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        Cargando la partida…
      </div>
    )
  } else if (terminada) {
    contenido = (
      <div className="flex flex-1 flex-col gap-8 py-4">
        <div className="text-center">
          <div className="text-lg uppercase tracking-widest text-white/70 md:text-2xl">Fin de la partida</div>
          <h2 className="mt-1 text-4xl font-black md:text-6xl">¡Felicidades!</h2>
        </div>
        <Podio tabla={tabla} oscuro />
        <div className="mx-auto w-full max-w-3xl rounded-3xl bg-white/10 p-4 md:p-6">
          <div className="mb-3 text-sm uppercase tracking-wide text-white/70">Tabla completa · {tabla.length} {tabla.length === 1 ? 'jugador' : 'jugadores'}</div>
          <TablaPosiciones tabla={tabla} oscuro grande />
        </div>
        <div className="mx-auto w-full max-w-3xl rounded-3xl bg-white/10 p-4 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm uppercase tracking-wide text-white/70">Respuestas por jugador</span>
            <Boton variante="fantasma" onClick={() => setVerFallos((v) => !v)} className="text-white hover:bg-white/15">
              {verFallos ? 'Ocultar' : '👀 Ver quién falló'}
            </Boton>
          </div>
          {verFallos ? <div className="mt-3"><RespuestasPorJugador detalle={detalle} /></div> : null}
        </div>
        <Link to="/docente" className="mx-auto inline-flex min-h-[56px] items-center justify-center rounded-2xl bg-white px-8 text-lg font-semibold text-ink-900 hover:bg-ink-100">
          Volver a mis materias
        </Link>
      </div>
    )
  } else if (estado.estado === 'resultado') {
    const conteo = resultado?.conteo ?? []
    const maximo = Math.max(1, ...conteo)
    const opciones = pregunta?.opciones ?? conteo.map((_, i) => `Opción ${i + 1}`)
    contenido = (
      <div className="flex flex-1 flex-col gap-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-lg text-white/80 md:text-2xl">
          <span className="font-semibold">
            Pregunta {numero} de {totalPreguntas}
          </span>
          <span>Resultado</span>
        </div>
        {resultado ? (
          <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
            <div className="space-y-3">
              {opciones.map((texto, i) => {
                const e = estiloOpcion(i)
                const esCorrecta = i === resultado.correcta
                const n = conteo[i] ?? 0
                return (
                  <div key={i} className={`rounded-2xl p-3 md:p-4 ${esCorrecta ? 'bg-white/20 ring-4 ring-white' : 'bg-white/5 opacity-70'}`}>
                    <div className="juego-opcion-proyector flex items-center gap-3 font-semibold">
                      <span className={`flex h-[1.8em] w-[1.8em] shrink-0 items-center justify-center rounded-lg ${e.fondo}`}>{e.simbolo}</span>
                      <Markdown texto={texto} enLinea className="min-w-0 flex-1 break-words" />
                      {esCorrecta && <span className="shrink-0 text-green-300">✓</span>}
                      <span className="shrink-0 font-mono tabular-nums">{n}</span>
                    </div>
                    <div className="mt-2 h-4 overflow-hidden rounded-full bg-white/15 md:h-6">
                      <div className={`h-full rounded-full transition-[width] duration-700 ease-out ${e.fondo}`} style={{ width: `${(n / maximo) * 100}%` }} />
                    </div>
                  </div>
                )
              })}
              {verFallos && pregunta ? <QuienFallo detalle={detalle} indice={pregunta.indice} opciones={opciones} /> : null}
              {resultado.explicacion && (
                <div className="rounded-2xl bg-white p-4 text-ink-900 md:p-5">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Explicación</div>
                  <Markdown texto={resultado.explicacion} className="juego-explicacion mt-1" />
                </div>
              )}
            </div>
            <div className="rounded-3xl bg-white/10 p-4 md:p-6">
              <div className="mb-3 text-sm uppercase tracking-wide text-white/70">Los 5 primeros</div>
              <TablaPosiciones tabla={resultado.tabla} limite={5} oscuro grande />
            </div>
          </div>
        ) : (
          <div className="rounded-3xl bg-white/10 p-6 md:p-8">
            <p className="mb-4 text-lg text-white/80 md:text-2xl">Se mostró el resultado de esta pregunta antes de abrir esta pantalla. Puedes continuar.</p>
            <TablaPosiciones tabla={participantes} limite={5} oscuro grande />
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-end gap-3">
          {resultado && pregunta ? (
            <Boton variante="fantasma" onClick={() => setVerFallos((v) => !v)} className="min-h-[64px] px-6 text-lg text-white hover:bg-white/15">
              {verFallos ? 'Ocultar quién falló' : '👀 Ver quién falló'}
            </Boton>
          ) : null}
          {hayMas ? (
            <Boton onClick={() => controlar('siguiente')} disabled={ocupado} className="min-h-[64px] px-10 text-xl">
              Siguiente →
            </Boton>
          ) : (
            <Boton onClick={() => controlar('terminar')} disabled={ocupado} className="min-h-[64px] px-10 text-xl">
              Terminar y ver podio
            </Boton>
          )}
        </div>
      </div>
    )
  } else if (estado.estado === 'pregunta') {
    contenido = (
      <div className="flex flex-1 flex-col gap-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3 text-lg text-white/80 md:text-2xl">
          <span className="font-semibold">
            Pregunta {numero} de {totalPreguntas}
          </span>
          <span>
            Han respondido <span className="font-mono font-bold text-white">{respondieron}</span> de {participantes.length}
          </span>
        </div>
        {pregunta ? (
          <>
            <BarraTiempo segundos={pregunta.segundos} inicio={inicio} grande />
            <div className="rounded-3xl bg-white p-5 text-ink-900 md:p-8">
              <Markdown texto={pregunta.enunciado} className="juego-proyector" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
              {pregunta.opciones.map((texto, i) => {
                const e = estiloOpcion(i)
                return (
                  <div key={i} className={`juego-opcion-proyector flex min-h-[72px] items-center gap-4 rounded-2xl px-5 py-4 font-semibold shadow-lg md:min-h-[110px] ${e.fondo}`}>
                    <span className="shrink-0 text-[1.5em] leading-none">{e.simbolo}</span>
                    <Markdown texto={texto} enLinea className="min-w-0 flex-1 break-words" />
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <div className="rounded-3xl bg-white/10 p-6 md:p-8">
            <p className="text-lg text-white/80 md:text-2xl">Hay una pregunta en curso que se lanzó antes de abrir esta pantalla; los jugadores la ven en su celular. Muestra el resultado o pasa a la siguiente.</p>
          </div>
        )}
        <div className="mt-auto flex flex-wrap justify-end gap-3">
          <Boton variante="secundario" onClick={() => controlar('mostrar')} disabled={ocupado} className="min-h-[64px] px-8 text-xl">
            Mostrar resultado
          </Boton>
          <Boton onClick={() => controlar('siguiente')} disabled={ocupado} className="min-h-[64px] px-8 text-xl">
            {hayMas ? 'Siguiente →' : 'Terminar'}
          </Boton>
        </div>
      </div>
    )
  } else {
    // Lobby
    contenido = (
      <div className="flex flex-1 flex-col gap-8 py-4">
        <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
          <div className="text-center">
            <div className="text-lg text-white/80 md:text-2xl">Entra desde tu celular en</div>
            <div className="mt-1 break-all font-mono text-xl font-bold md:text-3xl">{direccion}</div>
            <div className="mt-8 text-lg uppercase tracking-widest text-white/80 md:text-2xl">PIN de la partida</div>
            <div className="juego-pin mt-2 whitespace-nowrap font-mono font-black">{formatoPin(pin)}</div>
            <div className="mt-6 text-white/70 md:text-xl">
              {estado.titulo} · {estado.total_preguntas} {estado.total_preguntas === 1 ? 'pregunta' : 'preguntas'} · {estado.segundos_por_pregunta} s cada una
            </div>
          </div>
          <div className="rounded-3xl bg-white/10 p-5 md:p-8">
            <div className="mb-4 flex items-baseline justify-between">
              <span className="text-xl font-semibold md:text-3xl">Jugadores</span>
              <span className="font-mono text-3xl font-black tabular-nums md:text-4xl">{participantes.length}</span>
            </div>
            {participantes.length ? (
              <div className="flex max-h-[45vh] flex-wrap gap-2 overflow-y-auto md:gap-3">
                {participantes.map((p) => (
                  <span key={p.id} className="max-w-full truncate rounded-full bg-white px-4 py-2 text-lg font-semibold text-ink-900 md:text-2xl" style={{ animation: 'podio-subir .4s ease-out both' }}>
                    {p.apodo}
                  </span>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-lg text-white/60 md:text-2xl">Aún no entra nadie. Espera a que escriban el PIN.</div>
            )}
          </div>
        </div>
        <div className="mt-auto flex flex-col items-center gap-2">
          <Boton onClick={() => controlar('iniciar')} disabled={ocupado || participantes.length === 0} className="min-h-[72px] w-full max-w-md px-10 text-2xl">
            Iniciar
          </Boton>
          {participantes.length === 0 && <span className="text-sm text-white/60">Se necesita al menos un jugador.</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-gradient-to-br from-violet-800 via-indigo-900 to-ink-900 text-white">
      <style>{`@keyframes podio-subir{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <AvisoConexion visible={!conectado && estado !== null} />
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className={`h-3 w-3 shrink-0 rounded-full ${conectado ? 'bg-green-400' : 'bg-red-400'}`} title={conectado ? 'Conectado' : 'Sin conexión'} />
          <span className="truncate text-base font-semibold md:text-xl">{estado?.titulo ?? 'Juego en vivo'}</span>
          {!terminada && estado && estado.estado !== 'lobby' && <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 font-mono text-sm tracking-widest md:text-base">PIN {formatoPin(pin)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Boton variante="fantasma" onClick={alternarPantalla} className="text-white hover:bg-white/15">
            {pantallaCompleta ? 'Salir de pantalla completa' : 'Pantalla completa'}
          </Boton>
          {!terminada && (
            <Boton variante="peligro" onClick={() => setConfirmarFin(true)} disabled={!estado}>
              Terminar partida
            </Boton>
          )}
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 pb-6 md:px-8">{contenido}</main>

      <Modal abierto={confirmarFin} titulo="Terminar la partida" onCerrar={() => setConfirmarFin(false)}>
        <p className="text-ink-700">Se cerrará la partida para todos y se mostrará la tabla final con los puntos que llevan hasta ahora.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Boton variante="secundario" onClick={() => setConfirmarFin(false)}>
            Cancelar
          </Boton>
          <Boton
            variante="peligro"
            onClick={() => {
              setConfirmarFin(false)
              controlar('terminar')
            }}
          >
            Terminar
          </Boton>
        </div>
      </Modal>
    </div>
  )
}
