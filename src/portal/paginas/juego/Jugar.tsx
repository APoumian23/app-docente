import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Participante, PreguntaPartida } from '@shared/portal'
import Markdown from '../../componentes/Markdown'
import { avisar } from '../../componentes/ui'
import { useSesion } from '../../lib/sesion'
import { AvisoConexion, BarraTiempo, Podio, conectarPartida, estiloOpcion, formatoPin, posicionDe, type EstadoPartidaVivo, type ResultadoPregunta, type SocketPartida } from './comun'

/** La respuesta ya enviada. Si fue correcta se sabe hasta el resultado; `opcion` es null si se retomó tras reconectar. */
interface Respuesta {
  opcion: number | null
  /** Puntos que tenía al responder: lo ganado es la diferencia con la tabla del resultado. */
  puntosAntes: number
}

/** Lo que espera el acuse del servidor antes de soltar los botones. */
const ESPERA_ACUSE_MS = 5000

/** Pantalla del jugador: celular en vertical, botones grandes para el pulgar. */
export default function Jugar(): JSX.Element {
  const { pin = '' } = useParams()
  const [params] = useSearchParams()
  const apodo = (params.get('apodo') ?? '').trim().slice(0, 24)
  const nav = useNavigate()
  const token = useSesion((s) => s.token)
  const socketRef = useRef<SocketPartida | null>(null)

  const [conectado, setConectado] = useState(false)
  const [participante, setParticipante] = useState<Participante | null>(null)
  const [estado, setEstado] = useState<EstadoPartidaVivo | null>(null)
  const [pregunta, setPregunta] = useState<PreguntaPartida | null>(null)
  const [inicio, setInicio] = useState(0)
  const [agotado, setAgotado] = useState(false)
  const [respuesta, setRespuesta] = useState<Respuesta | null>(null)
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState<ResultadoPregunta | null>(null)
  const [tablaFinal, setTablaFinal] = useState<Participante[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!apodo) {
      nav(`/juego?pin=${pin}`, { replace: true })
      return
    }
    const socket = conectarPartida(token)
    socketRef.current = socket
    // Clave que entrega el servidor al unirse: con ella se retoma el apodo al reconectar.
    // Se guarda en el celular: quien cierra la página o se sale puede volver con el mismo nombre y sus puntos
    const guardada = `docente.juego.${pin}.${apodo.trim().toLowerCase()}`
    let clave: string | undefined
    try {
      clave = localStorage.getItem(guardada) ?? undefined
    } catch {
      clave = undefined
    }
    const unirse = (): void => {
      socket.emit('partida:unirse', { pin, apodo, clave }, (r) => {
        if (!r.ok || !r.participante) {
          setError(r.error ?? 'No se pudo entrar a la partida.')
          return
        }
        clave = r.clave ?? clave
        try {
          if (clave) localStorage.setItem(guardada, clave)
        } catch {
          // Sin almacenamiento (modo privado): solo se retoma mientras la página siga abierta
        }
        setError('')
        setParticipante(r.participante)
        // Si la partida va a media pregunta, se muestra con el tiempo que queda
        if (r.pregunta) {
          setPregunta(r.pregunta)
          setInicio(Date.now())
          setAgotado(false)
          setEnviando(false)
          setRespuesta(r.respondida ? { opcion: null, puntosAntes: r.participante.puntos } : null)
          setResultado(null)
        }
      })
    }
    // 'connect' se dispara también en cada reconexión: así se retoma el apodo
    socket.on('connect', () => {
      setConectado(true)
      unirse()
    })
    socket.on('disconnect', () => setConectado(false))
    socket.on('connect_error', () => setConectado(false))
    socket.on('partida:estado', (e) => setEstado(e))
    socket.on('partida:pregunta', (q) => {
      setPregunta(q)
      setInicio(Date.now())
      setAgotado(false)
      // Un acuse que nunca llegó no deja los botones congelados en la siguiente pregunta
      setEnviando(false)
      setRespuesta(null)
      setResultado(null)
    })
    socket.on('partida:resultado', (r) => setResultado(r))
    socket.on('partida:fin', (t) => setTablaFinal(t))
    return () => {
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [pin, apodo, token, nav])

  const responder = (opcion: number): void => {
    const socket = socketRef.current
    if (!socket || !participante || !pregunta || respuesta || enviando) return
    const puntosAntes = puntos
    setEnviando(true)
    socket.timeout(ESPERA_ACUSE_MS).emit('partida:responder', { pin, participante_id: participante.id, opcion }, (err, r) => {
      setEnviando(false)
      if (err) {
        avisar('El servidor no confirmó tu respuesta. Toca tu opción otra vez.', 'error')
        return
      }
      // ya_respondida: el acuse anterior se perdió, pero la respuesta sí quedó
      if (r.ok || r.ya_respondida) {
        setRespuesta({ opcion, puntosAntes })
        return
      }
      avisar('No se pudo registrar tu respuesta. Quizá se acabó el tiempo.', 'error')
    })
  }

  // La tabla más reciente que conocemos, de donde salen puntos y posición
  const tabla = tablaFinal ?? resultado?.tabla ?? estado?.participantes ?? []
  const yo = participante ? (tabla.find((p) => p.id === participante.id) ?? participante) : null
  const puntos = yo?.puntos ?? 0
  const posicion = posicionDe(tabla, participante?.id)
  const terminada = tablaFinal !== null || estado?.estado === 'terminada'

  let contenido: JSX.Element
  if (error) {
    contenido = (
      <div className="m-auto w-full max-w-sm rounded-3xl bg-white p-6 text-center text-ink-900 shadow-xl">
        <div className="text-4xl">😕</div>
        <p className="mt-3 text-lg font-semibold">{error}</p>
        <Link to={`/juego?pin=${pin}`} className="mt-5 inline-flex min-h-[56px] w-full items-center justify-center rounded-2xl bg-violet-600 px-4 font-semibold text-white hover:bg-violet-700">
          Volver a entrar
        </Link>
      </div>
    )
  } else if (!participante) {
    contenido = (
      <div className="m-auto flex flex-col items-center gap-3 text-white/90">
        <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/30 border-t-white" />
        <span>{conectado ? 'Entrando a la partida…' : 'Conectando…'}</span>
      </div>
    )
  } else if (terminada) {
    contenido = (
      <div className="flex flex-1 flex-col gap-6 py-4">
        <div className="text-center">
          <div className="text-sm uppercase tracking-widest text-white/70">Fin de la partida</div>
          <h2 className="mt-1 text-3xl font-black">¡Gracias por jugar!</h2>
        </div>
        <Podio tabla={tabla} destacado={participante.id} oscuro />
        <div className="rounded-3xl bg-white p-5 text-center text-ink-900">
          <div className="text-sm text-ink-500">Tu resultado</div>
          <div className="mt-1 text-2xl font-black">
            {posicion > 0 ? `Lugar ${posicion} de ${tabla.length}` : 'Sin lugar'}
          </div>
          <div className="text-lg text-ink-600">{puntos.toLocaleString('es-MX')} puntos</div>
        </div>
        <Link to="/juego" className="mt-auto inline-flex min-h-[56px] items-center justify-center rounded-2xl bg-white/15 px-4 font-semibold text-white hover:bg-white/25">
          Jugar otra partida
        </Link>
      </div>
    )
  } else if (resultado && pregunta) {
    const ganados = respuesta ? Math.max(0, puntos - respuesta.puntosAntes) : 0
    // Una respuesta correcta siempre da puntos; así se sabe aunque la opción se haya perdido al reconectar
    const acerto = respuesta !== null && (respuesta.opcion !== null ? respuesta.opcion === resultado.correcta : ganados > 0)
    const correcta = estiloOpcion(resultado.correcta)
    contenido = (
      <div className="flex flex-1 flex-col gap-4 py-4">
        <div className={`rounded-3xl p-6 text-center shadow-xl ${acerto ? 'bg-green-500' : respuesta ? 'bg-red-500' : 'bg-ink-700'}`}>
          <div className="text-6xl">{acerto ? '✓' : respuesta ? '✗' : '⏱'}</div>
          <div className="mt-2 text-3xl font-black">{acerto ? '¡Correcto!' : respuesta ? 'Incorrecto' : 'No respondiste'}</div>
          <div className="mt-1 text-xl font-semibold text-white/90">+{ganados.toLocaleString('es-MX')} puntos</div>
        </div>
        <div className="rounded-2xl bg-white p-4 text-ink-900">
          <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Respuesta correcta</div>
          <div className={`mt-2 flex items-center gap-3 rounded-xl px-3 py-2 ${correcta.fondo}`}>
            <span className="text-2xl">{correcta.simbolo}</span>
            <span className="min-w-0 flex-1 break-words font-semibold">{pregunta.opciones[resultado.correcta] ?? '—'}</span>
          </div>
          {resultado.explicacion && <Markdown texto={resultado.explicacion} className="mt-3" />}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-white/15 p-4 text-center">
            <div className="text-xs uppercase tracking-wide text-white/70">Tu puntaje</div>
            <div className="text-2xl font-black">{puntos.toLocaleString('es-MX')}</div>
          </div>
          <div className="rounded-2xl bg-white/15 p-4 text-center">
            <div className="text-xs uppercase tracking-wide text-white/70">Posición</div>
            <div className="text-2xl font-black">
              {posicion > 0 ? `${posicion}.º` : '—'} <span className="text-base font-normal text-white/70">de {tabla.length}</span>
            </div>
          </div>
        </div>
        <p className="mt-auto text-center text-white/70">Espera la siguiente pregunta…</p>
      </div>
    )
  } else if (pregunta && estado?.estado !== 'lobby') {
    contenido = (
      <div className="flex flex-1 flex-col gap-4 py-3">
        <div className="flex items-center justify-between text-sm text-white/80">
          <span className="font-semibold">
            Pregunta {pregunta.indice + 1} de {pregunta.total}
          </span>
        </div>
        <BarraTiempo segundos={pregunta.segundos} inicio={inicio} onAgotado={() => setAgotado(true)} />
        <div className="rounded-2xl bg-white p-4 text-ink-900">
          <Markdown texto={pregunta.enunciado} className="juego-celular" />
        </div>
        {respuesta ? (
          <div className="mt-auto rounded-3xl bg-white/15 p-6 text-center">
            {respuesta.opcion !== null && (
              <div className={`mx-auto inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-semibold ${estiloOpcion(respuesta.opcion).fondo}`}>
                <span>{estiloOpcion(respuesta.opcion).simbolo}</span>
                <span>Opción {respuesta.opcion + 1}</span>
              </div>
            )}
            <div className="mt-3 text-xl font-bold">Respuesta enviada</div>
            <div className="mt-1 text-sm text-white/70">El resultado sale cuando todos respondan o se acabe el tiempo.</div>
          </div>
        ) : agotado ? (
          <div className="mt-auto rounded-3xl bg-white/15 p-6 text-center">
            <div className="text-4xl">⏱</div>
            <div className="mt-2 text-xl font-bold">Se acabó el tiempo</div>
            <div className="mt-1 text-sm text-white/70">Espera el resultado…</div>
          </div>
        ) : (
          <div className="mt-auto grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pregunta.opciones.map((texto, i) => {
              const e = estiloOpcion(i)
              return (
                <button
                  key={i}
                  type="button"
                  disabled={enviando}
                  onClick={() => responder(i)}
                  className={`juego-opcion-celular flex min-h-[72px] items-center gap-3 rounded-2xl px-4 py-3 text-left font-semibold shadow-lg transition active:scale-[0.97] disabled:opacity-60 ${e.fondo} ${e.hover}`}
                  aria-label={`Opción ${i + 1}: ${texto}`}
                >
                  <span className="shrink-0 text-[1.6em] leading-none">{e.simbolo}</span>
                  <Markdown texto={texto} enLinea className="min-w-0 flex-1 break-words" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  } else {
    // Lobby, o llegamos con una pregunta ya en curso (el servidor no la reenvía)
    const enCurso = estado?.estado === 'pregunta' || estado?.estado === 'resultado'
    contenido = (
      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-white/15 text-5xl">🙌</div>
        <div>
          <div className="text-sm uppercase tracking-widest text-white/70">¡Estás dentro!</div>
          <h2 className="mt-1 break-words text-3xl font-black">{participante.apodo}</h2>
        </div>
        {estado?.titulo && <div className="rounded-full bg-white/15 px-4 py-1.5 text-sm">{estado.titulo}</div>}
        <div className="flex items-center gap-2 text-lg">
          <span className="h-3 w-3 animate-pulse rounded-full bg-green-400" />
          {enCurso ? 'Hay una pregunta en curso; entrarás en la siguiente.' : 'Esperando al docente…'}
        </div>
        <div className="text-white/70">
          {tabla.length} {tabla.length === 1 ? 'jugador conectado' : 'jugadores conectados'}
        </div>
        <p className="text-xs text-white/50">Mira la pantalla del proyector: ahí aparecerán las preguntas.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-gradient-to-b from-violet-700 to-indigo-900 text-white">
      <AvisoConexion visible={!conectado && participante !== null} />
      <header className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
        <span className="flex items-center gap-3">
          {/* Salir del juego a media partida (el lugar en la tabla se conserva si vuelve con el mismo apodo) */}
          <a
            href="/juego"
            onClick={(e) => {
              if (!confirm('¿Salir del juego? Puedes volver a entrar con el mismo PIN y apodo.')) e.preventDefault()
            }}
            className="rounded-lg px-2 py-1 text-white/80 hover:bg-white/10"
          >
            ← Salir
          </a>
          <span className="font-mono tracking-widest text-white/70">PIN {formatoPin(pin)}</span>
        </span>
        {participante && (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold">{participante.apodo}</span>
            <span className="shrink-0 rounded-full bg-white/20 px-2 py-0.5 font-mono tabular-nums">{puntos.toLocaleString('es-MX')} pts</span>
          </span>
        )}
      </header>
      <main className="flex flex-1 flex-col px-4 pb-6">{contenido}</main>
    </div>
  )
}
