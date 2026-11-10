import { randomBytes } from 'crypto'
import type Database from 'better-sqlite3'
import type { Server, Socket } from 'socket.io'
import type { DetallePartida, Partida, Participante, PreguntaPartida } from '../shared/portal'
import type { Pregunta } from '../shared/types'
import { leerContenido, coincideOpcion, esAutocalificable, indiceCorrecto, puntosPorRapidez } from './calificar'
import { usuarioDeToken, type Contexto } from './auth'
import { tieneAcceso } from './permisos'

/** Tope de jugadores por partida: un grupo grande cabe de sobra y nadie llena la sala con bots. */
export const MAX_PARTICIPANTES = 100

/** Estado en memoria de cada partida en curso: lo que no hace falta persistir por jugada. */
interface EstadoVivo {
  inicioPregunta: number
  temporizador: NodeJS.Timeout | null
  respondieron: Set<number>
}

const vivas = new Map<string, EstadoVivo>()

function generarPin(db: Database.Database): string {
  for (let i = 0; i < 50; i++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000))
    if (!db.prepare("SELECT 1 FROM partidas WHERE pin = ? AND estado <> 'terminada'").get(pin)) return pin
  }
  throw new Error('No se pudo generar un PIN libre')
}

/**
 * Solo las preguntas con opciones y una clave sin ambigüedad se pueden jugar;
 * verdadero/falso se convierte en dos opciones.
 */
export function preguntasJugables(contenido: string): Pregunta[] {
  const c = leerContenido(contenido)
  if (!c) return []
  return c.preguntas
    .filter(esAutocalificable)
    .map((p) => (p.tipo === 'verdadero_falso' ? { ...p, opciones: ['Verdadero', 'Falso'] } : p))
    .filter((p) => (p.opciones?.length ?? 0) >= 2)
}

export function crearPartida(db: Database.Database, evaluacionId: number, docenteId: number | null, segundos = 20): Partida {
  const ev = db.prepare('SELECT titulo, contenido FROM evaluaciones WHERE id = ?').get(evaluacionId) as { titulo: string; contenido: string } | undefined
  if (!ev) throw new Error('La evaluación no existe.')
  const preguntas = preguntasJugables(ev.contenido)
  if (!preguntas.length) throw new Error('Esta evaluación no tiene preguntas de opción múltiple para jugar.')
  const pin = generarPin(db)
  const id = Number(db.prepare('INSERT INTO partidas (evaluacion_id, docente_id, pin, segundos_por_pregunta) VALUES (?,?,?,?)').run(evaluacionId, docenteId, pin, Math.min(120, Math.max(5, segundos))).lastInsertRowid)
  return leerPartida(db, pin)!
}

export function leerPartida(db: Database.Database, pin: string): Partida | null {
  const p = db.prepare('SELECT p.*, e.titulo, e.contenido FROM partidas p JOIN evaluaciones e ON e.id = p.evaluacion_id WHERE p.pin = ?').get(pin) as
    | (Partida & { contenido: string })
    | undefined
  if (!p) return null
  const { contenido, ...resto } = p
  return { ...resto, total_preguntas: preguntasJugables(contenido).length }
}

export function tablaDe(db: Database.Database, partidaId: number): Participante[] {
  return db.prepare('SELECT id, apodo, puntos FROM participantes WHERE partida_id = ? ORDER BY puntos DESC, unido_en').all(partidaId) as Participante[]
}

/** Opción correcta de una pregunta jugable (V/F ya viene como dos opciones). */
function correctaDe(q: Pregunta): number {
  return q.tipo === 'opcion_multiple' ? indiceCorrecto(q) : (q.opciones ?? []).findIndex((o) => coincideOpcion(q, o))
}

/**
 * Quién eligió qué en cada pregunta ya cerrada (la que está en curso no: delataría a quien aún responde).
 * Solo para el docente de la partida.
 */
export function detallePartida(db: Database.Database, p: Partida): DetallePartida {
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(p.evaluacion_id) as { contenido: string } | undefined
  const lista = ev ? preguntasJugables(ev.contenido) : []
  const ultima = p.estado === 'lobby' ? -1 : Math.min(lista.length - 1, p.estado === 'pregunta' ? p.pregunta_actual - 1 : p.pregunta_actual)
  const preguntas = lista.slice(0, ultima + 1).map((q, indice) => ({ indice, enunciado: q.enunciado, opciones: q.opciones ?? [], correcta: correctaDe(q) }))
  const jugadores = tablaDe(db, p.id).map((j) => ({ ...j, respuestas: {} as DetallePartida['jugadores'][number]['respuestas'] }))
  const porId = new Map(jugadores.map((j) => [j.id, j]))
  const filas = db.prepare('SELECT participante_id, pregunta_idx, opcion, correcta FROM respuestas_partida WHERE partida_id = ? AND pregunta_idx <= ?').all(p.id, ultima) as {
    participante_id: number
    pregunta_idx: number
    opcion: number
    correcta: number
  }[]
  for (const f of filas) {
    const j = porId.get(f.participante_id)
    if (j) j.respuestas[f.pregunta_idx] = { opcion: f.opcion, correcta: f.correcta === 1 }
  }
  return { preguntas, jugadores }
}

const normalizar = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/** Nombre con el que juega un alumno con sesión: el de su cuenta, no uno que elija. */
function nombreDeAlumno(db: Database.Database, alumnoId: number): string {
  const a = db.prepare('SELECT nombre, apellidos FROM alumnos WHERE id = ?').get(alumnoId) as { nombre: string; apellidos: string } | undefined
  if (!a) return 'Alumno'
  const completo = `${a.nombre} ${a.apellidos}`.trim()
  return (completo.length <= 24 ? completo : `${a.nombre.split(' ')[0]} ${a.apellidos.split(' ')[0]}`.trim()).slice(0, 24)
}

/** Nombres que un invitado no puede usar: los de los alumnos inscritos en la materia de la evaluación. */
function nombresReservados(db: Database.Database, evaluacionId: number): Set<string> {
  const filas = db
    .prepare(
      `SELECT a.id, a.nombre, a.apellidos, a.matricula, u.usuario FROM alumnos a
       JOIN inscripciones i ON i.alumno_id = a.id JOIN evaluaciones e ON e.materia_id = i.materia_id
       LEFT JOIN usuarios u ON u.alumno_id = a.id WHERE e.id = ?`
    )
    .all(evaluacionId) as { id: number; nombre: string; apellidos: string; matricula: string; usuario: string | null }[]
  const salida = new Set<string>()
  for (const f of filas) {
    for (const t of [`${f.nombre} ${f.apellidos}`, `${f.nombre} ${f.apellidos.split(' ')[0]}`, nombreDeAlumno(db, f.id), f.matricula, f.usuario ?? '']) if (t.trim()) salida.add(normalizar(t))
  }
  return salida
}

function preguntaActual(db: Database.Database, p: Partida): { pregunta: Pregunta; indice: number } | null {
  const ev = db.prepare('SELECT contenido FROM evaluaciones WHERE id = ?').get(p.evaluacion_id) as { contenido: string }
  const lista = preguntasJugables(ev.contenido)
  const q = lista[p.pregunta_actual]
  return q ? { pregunta: q, indice: p.pregunta_actual } : null
}

/** Registra los manejadores de WebSocket del juego en vivo. */
export function registrarPartidas(io: Server, ctx: Contexto): void {
  const { db } = ctx


  const preguntaEnCurso = (p: Partida, vivo: EstadoVivo | undefined): PreguntaPartida | undefined => {
    if (p.estado !== 'pregunta' || !vivo) return undefined
    const q = preguntaActual(db, p)
    if (!q) return undefined
    const restante = Math.max(0, Math.ceil((vivo.inicioPregunta + p.segundos_por_pregunta * 1000 - Date.now()) / 1000))
    return { indice: q.indice, enunciado: q.pregunta.enunciado, opciones: q.pregunta.opciones ?? [], segundos: restante, total: p.total_preguntas }
  }

  const emitirRespondieron = (p: Partida, vivo: EstadoVivo): void => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM participantes WHERE partida_id = ?').get(p.id) as { n: number }).n
    // Solo al anfitrión: 40 celulares no necesitan el conteo de cada respuesta
    io.to(`anfitrion:${p.pin}`).emit('partida:respondieron', { n: vivo.respondieron.size, total })
  }

  const emitirEstado = (pin: string): void => {
    const p = leerPartida(db, pin)
    if (!p) return
    io.to(`partida:${pin}`).emit('partida:estado', { ...p, participantes: tablaDe(db, p.id) })
  }

  /**
   * Los puntos de una pregunta se suman a la tabla solo al cerrarla: si se sumaran al responder,
   * la tabla (o el aviso de "correcta") delataría la opción buena antes de tiempo.
   */
  const sumarPuntos = (p: Partida, indice: number): void => {
    db.prepare(
      `UPDATE participantes SET puntos = puntos + COALESCE((SELECT r.puntos FROM respuestas_partida r WHERE r.participante_id = participantes.id AND r.pregunta_idx = ?), 0)
       WHERE partida_id = ?`
    ).run(indice, p.id)
  }

  const mostrarResultado = (pin: string): void => {
    const p = leerPartida(db, pin)
    if (!p || p.estado !== 'pregunta') return
    const q = preguntaActual(db, p)
    if (!q) return
    const vivo = vivas.get(pin)
    if (vivo?.temporizador) clearTimeout(vivo.temporizador)
    db.transaction(() => {
      sumarPuntos(p, q.indice)
      db.prepare("UPDATE partidas SET estado = 'resultado' WHERE id = ?").run(p.id)
    })()
    const opciones = q.pregunta.opciones ?? []
    const correcta = correctaDe(q.pregunta)
    const conteo = opciones.map((_, idx) => (db.prepare('SELECT COUNT(*) AS n FROM respuestas_partida WHERE partida_id = ? AND pregunta_idx = ? AND opcion = ?').get(p.id, q.indice, idx) as { n: number }).n)
    io.to(`partida:${pin}`).emit('partida:resultado', { correcta, conteo, tabla: tablaDe(db, p.id), explicacion: q.pregunta.explicacion ?? '' })
    emitirEstado(pin)
  }

  const lanzarPregunta = (pin: string, indice: number): void => {
    const p = leerPartida(db, pin)
    if (!p) return
    if (indice >= p.total_preguntas) return terminar(pin)
    db.prepare("UPDATE partidas SET estado = 'pregunta', pregunta_actual = ? WHERE id = ?").run(indice, p.id)
    const actualizada = leerPartida(db, pin)!
    const q = preguntaActual(db, actualizada)!
    const vivo: EstadoVivo = { inicioPregunta: Date.now(), temporizador: null, respondieron: new Set() }
    vivo.temporizador = setTimeout(() => mostrarResultado(pin), actualizada.segundos_por_pregunta * 1000 + 500)
    vivas.set(pin, vivo)
    const carga: PreguntaPartida = { indice, enunciado: q.pregunta.enunciado, opciones: q.pregunta.opciones ?? [], segundos: actualizada.segundos_por_pregunta, total: actualizada.total_preguntas }
    io.to(`partida:${pin}`).emit('partida:pregunta', carga)
    emitirRespondieron(actualizada, vivo)
    emitirEstado(pin)
  }

  const terminar = (pin: string): void => {
    const p = leerPartida(db, pin)
    if (!p) return
    const vivo = vivas.get(pin)
    if (vivo?.temporizador) clearTimeout(vivo.temporizador)
    vivas.delete(pin)
    db.transaction(() => {
      // Terminar a media pregunta: lo que ya se respondió cuenta
      if (p.estado === 'pregunta') sumarPuntos(p, p.pregunta_actual)
      db.prepare("UPDATE partidas SET estado = 'terminada', terminada_en = datetime('now') WHERE id = ?").run(p.id)
    })()
    io.to(`partida:${pin}`).emit('partida:fin', tablaDe(db, p.id))
    emitirEstado(pin)
  }

  io.on('connection', (socket: Socket) => {
    const token = socket.handshake.auth?.token as string | undefined
    const usuario = usuarioDeToken(ctx, token)
    // La identidad se fija al conectar: si después la sesión se cierra o se abre en otro dispositivo,
    // esta conexión ya no debe seguir jugando ni controlando partidas en su nombre
    socket.use((_paquete, next) => {
      if (usuario && !usuarioDeToken(ctx, token)) return void socket.disconnect(true)
      next()
    })

    socket.on('partida:unirse', (d: { pin: string; apodo: string; clave?: string }, cb) => {
      try {
        const p = leerPartida(db, String(d?.pin ?? ''))
        if (!p) return cb({ ok: false, error: 'No hay ninguna partida con ese PIN.' })
        if (p.estado === 'terminada') return cb({ ok: false, error: 'Esa partida ya terminó.' })
        const alumnoId = usuario?.rol === 'alumno' ? usuario.alumno_id : null
        const buscar = db.prepare('SELECT id, apodo, puntos, alumno_id, clave FROM participantes WHERE partida_id = ? AND apodo = ? COLLATE NOCASE')
        let participante: (Participante & { alumno_id: number | null; clave: string | null }) | undefined
        let apodo: string
        if (alumnoId !== null) {
          // El alumno con sesión juega con el nombre de su cuenta y retoma su lugar aunque cambie de dispositivo
          participante = db.prepare('SELECT id, apodo, puntos, alumno_id, clave FROM participantes WHERE partida_id = ? AND alumno_id = ?').get(p.id, alumnoId) as typeof participante
          const base = nombreDeAlumno(db, alumnoId)
          apodo = participante?.apodo ?? base
          for (let n = 2; !participante && buscar.get(p.id, apodo); n++) apodo = `${base.slice(0, 21)} ${n}`
        } else {
          apodo = String(d.apodo ?? '').trim().slice(0, 24) || 'Jugador'
          participante = buscar.get(p.id, apodo) as typeof participante
          // El apodo solo se puede retomar con la clave que se le dio al unirse (el celular la guarda: sirve aunque salga y vuelva)
          const esSuyo = participante && participante.alumno_id === null && (socket.data.participanteId === participante.id || (Boolean(d.clave) && Boolean(participante.clave) && participante.clave === String(d.clave)))
          if (participante && !esSuyo) return cb({ ok: false, error: 'Ese nombre ya está en uso en esta partida. Si eres tú y entras desde otro celular o navegador, usa otro nombre.' })
          if (!participante && nombresReservados(db, p.evaluacion_id).has(normalizar(apodo))) {
            return cb({ ok: false, error: 'Ese nombre es de un alumno del grupo. Si eres tú, inicia sesión para jugar con tu cuenta; si no, elige otro apodo.' })
          }
        }
        if (!participante) {
          const { n } = db.prepare('SELECT COUNT(*) AS n FROM participantes WHERE partida_id = ?').get(p.id) as { n: number }
          if (n >= MAX_PARTICIPANTES) return cb({ ok: false, error: `La partida está llena (máximo ${MAX_PARTICIPANTES} jugadores).` })
        }
        let clave = participante?.clave ?? null
        const definitivo: Participante = participante ?? {
          id: Number(db.prepare('INSERT INTO participantes (partida_id, alumno_id, apodo, clave) VALUES (?,?,?,?)').run(p.id, alumnoId, apodo, (clave = randomBytes(12).toString('hex'))).lastInsertRowid),
          apodo,
          puntos: 0
        }
        // Lugares de antes de esta versión: se les da su clave al volver a entrar
        if (!clave) db.prepare('UPDATE participantes SET clave = ? WHERE id = ?').run((clave = randomBytes(12).toString('hex')), definitivo.id)
        socket.data.participanteId = definitivo.id
        socket.data.pin = p.pin
        socket.join(`partida:${p.pin}`)
        // Si entra a media pregunta, recibe la pregunta con el tiempo que queda (y si ya la había respondido)
        const vivo = vivas.get(p.pin)
        cb({
          ok: true,
          participante: { id: definitivo.id, apodo: definitivo.apodo, puntos: definitivo.puntos },
          clave,
          pregunta: preguntaEnCurso(p, vivo),
          respondida: vivo?.respondieron.has(definitivo.id) ?? false
        })
        emitirEstado(p.pin)
      } catch (e) {
        cb({ ok: false, error: (e as Error).message })
      }
    })

    socket.on('partida:responder', (d: { pin: string; participante_id: number; opcion: number }, cb) => {
      try {
        const p = leerPartida(db, String(d?.pin ?? ''))
        const vivo = p ? vivas.get(p.pin) : undefined
        if (!p || p.estado !== 'pregunta' || !vivo) return cb({ ok: false })
        const participanteId = Number(d.participante_id)
        if (socket.data.participanteId !== participanteId) return cb({ ok: false })
        // Un reintento tras perder el acuse no cuenta dos veces, pero el jugador sabe que sí quedó
        if (vivo.respondieron.has(participanteId)) return cb({ ok: false, ya_respondida: true })
        const q = preguntaActual(db, p)
        if (!q) return cb({ ok: false })
        const opcion = Number(d.opcion)
        const texto = q.pregunta.opciones?.[opcion]
        if (texto === undefined) return cb({ ok: false })
        const ms = Date.now() - vivo.inicioPregunta
        const correcta = coincideOpcion(q.pregunta, texto)
        const puntos = puntosPorRapidez(correcta, ms, p.segundos_por_pregunta)
        // Los puntos se guardan aquí pero se suman a la tabla al mostrar el resultado (sumarPuntos)
        db.prepare('INSERT OR IGNORE INTO respuestas_partida (partida_id, participante_id, pregunta_idx, opcion, correcta, ms, puntos) VALUES (?,?,?,?,?,?,?)').run(p.id, participanteId, q.indice, opcion, correcta ? 1 : 0, ms, puntos)
        vivo.respondieron.add(participanteId)
        // Solo el acuse: si fue correcta y cuántos puntos se sabe hasta partida:resultado
        cb({ ok: true })
        emitirRespondieron(p, vivo)
        const total = (db.prepare('SELECT COUNT(*) AS n FROM participantes WHERE partida_id = ?').get(p.id) as { n: number }).n
        // Si todos ya respondieron no hay por qué esperar al reloj
        if (vivo.respondieron.size >= total) mostrarResultado(p.pin)
      } catch (e) {
        cb({ ok: false })
      }
    })

    socket.on('partida:controlar', (d: { pin: string; accion: 'iniciar' | 'siguiente' | 'mostrar' | 'terminar' }, cb) => {
      if (!usuario || usuario.rol !== 'docente') return cb({ ok: false, error: 'Solo el docente controla la partida.' })
      const p = leerPartida(db, String(d?.pin ?? ''))
      // Solo el docente dueño de la materia de la evaluación (o el principal) controla su partida
      if (!p || !tieneAcceso(db, usuario.id, 'partida', p.pin)) return cb({ ok: false, error: 'Partida no encontrada.' })
      socket.join(`partida:${p.pin}`)
      socket.join(`anfitrion:${p.pin}`)
      switch (d.accion) {
        case 'iniciar':
          if (p.estado !== 'lobby') return cb({ ok: false, error: 'La partida ya empezó.' })
          lanzarPregunta(p.pin, 0)
          return cb({ ok: true })
        case 'mostrar':
          mostrarResultado(p.pin)
          return cb({ ok: true })
        case 'siguiente':
          if (p.estado === 'pregunta') mostrarResultado(p.pin)
          lanzarPregunta(p.pin, p.pregunta_actual + 1)
          return cb({ ok: true })
        case 'terminar':
          terminar(p.pin)
          return cb({ ok: true })
        default:
          return cb({ ok: false, error: 'Acción desconocida.' })
      }
    })

    socket.on('partida:observar', (d: { pin: string }) => {
      const pin = String(d?.pin ?? '')
      socket.join(`partida:${pin}`)
      if (usuario?.rol === 'docente' && tieneAcceso(db, usuario.id, 'partida', pin)) socket.join(`anfitrion:${pin}`)
      emitirEstado(pin)
      // El anfitrión que recarga a media pregunta recupera la pregunta y el conteo de respuestas
      const p = leerPartida(db, pin)
      const vivo = p ? vivas.get(pin) : undefined
      const q = p ? preguntaEnCurso(p, vivo) : undefined
      if (p && vivo && q) {
        socket.emit('partida:pregunta', q)
        emitirRespondieron(p, vivo)
      }
    })
  })
}
