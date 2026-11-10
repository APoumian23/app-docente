import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import { createServer, type Server as ServidorHttp } from 'http'
import { Server as ServidorSockets } from 'socket.io'
import multer from 'multer'
import compression from 'compression'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, extname, relative, isAbsolute, sep } from 'path'
import type Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import {
  obtenerSecreto, iniciarSesion, cerrarSesion, cambiarPassword, requerir, ErrorHttp, crearAccesosAlumnos, crearAccesoAlumno, reiniciarPasswordAlumno, asegurarDocente, canjearCodigo, crearCodigoAcceso,
  type Contexto, type PeticionAutenticada
} from './auth'
import * as s from './servicios'
import { exigirAcceso, alcanceDe, alumnoSoloDe, type Recurso, tieneAcceso } from './permisos'
import { registrarPartidas, crearPartida, leerPartida, tablaDe, detallePartida } from './partidas'
import { escribirAjuste, leerAjuste } from './base'
import { direccionesLocales } from './red'
import { avanceDeAlumno } from './avance'
import { servirPyodide } from './pyodide-http'
import * as tareas from './tareas'
import * as asistencia from './asistencia'
import * as calif from './calificaciones'
import * as extras from './portalAlumno'
import * as cuadernos from './cuadernos'
import * as push from './push'
import { mkdirSync as crearCarpeta, readdirSync, renameSync, statSync, unlinkSync as borrarArchivo, writeFileSync } from 'fs'
import * as sincro from './sincronizacion'
import { aplicarCambios, cambiosDesde, podarCambios, type Cambio } from './cambios'
import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { docentePrincipalId } from './permisos'

/** ws:// y wss:// del mismo servidor (Safari viejo no los incluye en 'self'). Solo letras, números, puntos, guiones y puerto. */
const hostWs = (req: Request): string => {
  const h = String(req.headers.host ?? '')
  return /^[\w.-]+(:\d+)?$/.test(h) ? ` ws://${h} wss://${h}` : ''
}

export interface OpcionesServidor {
  db: Database.Database
  carpetaEntregas: string
  carpetaPortal: string | null
  /** Python del editor de código (núcleo de Pyodide, Jedi y paquetes descargados), en orden de búsqueda */
  carpetasPyodide?: string[]
  /** Clave con la que la app de escritorio sincroniza con este servidor («Portal en línea»). Sin ella no hay sincronización. */
  claveSincro?: string
  /** Detrás de nginx en el mismo servidor: la IP real del alumno viene en X-Forwarded-For (sin esto todos serían «locales» y no habría freno a contraseñas) */
  detrasDeProxy?: boolean
  /** Rutas extra que monta el arranque antes de la página del portal */
  montar?: (app: Express, ctx: Contexto) => void
}

export interface ServidorPortal {
  http: ServidorHttp
  io: ServidorSockets
  iniciar: (puerto: number, host?: string) => Promise<{ puerto: number; urls: string[] }>
  detener: () => Promise<void>
  contexto: Contexto
}

const LIMITE_ARCHIVO = 25 * 1024 * 1024

/** multer entrega el nombre como latin1: un «Tarea_Álgebra.pdf» en UTF-8 se vería «Tarea_Ã\x81lgebra.pdf» */
function nombreReal(f: Express.Multer.File): string {
  const utf8 = Buffer.from(f.originalname, 'latin1').toString('utf8')
  return utf8.includes('\uFFFD') ? f.originalname : utf8
}
/** Único aunque lleguen dos «image.jpg» en el mismo milisegundo (fotos del iPhone) */
const nombreEnDisco = (f: Express.Multer.File): string => `${Date.now()}-${randomUUID().slice(0, 8)}-${nombreReal(f).replace(/[^\w.\-áéíóúñÁÉÍÓÚÑ ]/g, '_').slice(0, 120)}`
/** «Subir tarea»: fotos y PDF escaneados pesan más que un adjunto de examen */
const LIMITE_ARCHIVO_TAREA = 50 * 1024 * 1024
const EXTENSIONES_PERMITIDAS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.key', '.txt', '.md', '.zip', '.png', '.jpg', '.jpeg', '.py', '.js', '.ts', '.java', '.c', '.cpp', '.cs', '.sql', '.html', '.css', '.ipynb', '.ggb', '.m', '.r'])

const enteroDe = (v: unknown): number => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new ErrorHttp(400, 'Identificador no válido.')
  return n
}


export function crearServidor(op: OpcionesServidor): ServidorPortal {
  const { db } = op
  const ctx: Contexto = { db, secreto: obtenerSecreto(db) }
  push.activarPush(db)
  mkdirSync(op.carpetaEntregas, { recursive: true })

  const app = express()
  app.disable('x-powered-by')
  if (op.detrasDeProxy) app.set('trust proxy', 'loopback')
  // El portal pesa ~660 KB sin comprimir y ~200 KB comprimido: con 40 celulares en el mismo Wi-Fi se nota
  app.use(compression())
  // El portal y su API comparten origen (en desarrollo, Vite hace de proxy): no hace falta abrir CORS a cualquiera
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // Solo este mismo sitio puede mostrarlo en un marco: la app web del docente incrusta su panel
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      // El editor de código corre Python (WebAssembly) y el código del alumno en workers (blob).
      // Las conexiones solo van a este mismo servidor (también el WebSocket del juego): el código de un
      // alumno no puede mandar nada a otro lado
      `default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'${hostWs(req)}; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`
    )
    next()
  })
  // ---------- Sincronización con la app de escritorio (antes del JSON general: la subida pesa más de 2 MB) ----------
  if (op.claveSincro && op.claveSincro.length >= 32) {
    const esperada = createHash('sha256').update(op.claveSincro).digest()
    const app_ = (req: Request, _res: Response, next: NextFunction): void => {
      const dada = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!timingSafeEqual(createHash('sha256').update(dada).digest(), esperada)) return next(new ErrorHttp(401, 'Clave de sincronización incorrecta.'))
      next()
    }
    const principal = (): number => {
      const id = docentePrincipalId(db)
      if (!id) throw new ErrorHttp(400, 'El servidor no tiene cuenta docente.')
      return id
    }
    app.post('/api/sincro/subir', app_, express.json({ limit: '200mb' }), (req, res) => res.json(sincro.recibirTablas(db, req.body)))
    app.get('/api/sincro/bajar', app_, (req, res) => res.json(sincro.entregarTablas(db, op.carpetaEntregas, String(req.query.desde ?? ''))))
    app.get('/api/sincro/archivo', app_, (req, res) => res.sendFile(sincro.archivoParaBajar(op.carpetaEntregas, String(req.query.ruta ?? ''))))
    // Sincronización en dos sentidos: la Mac manda sus cambios y pide los de aquí (sin los que ella misma mandó)
    let ultimaPoda = 0
    app.post('/api/sincro/cambios', app_, express.json({ limit: '200mb' }), (req, res) => {
      const cliente = String(req.body?.cliente ?? '')
      if (!/^[\w-]{8,64}$/.test(cliente)) throw new ErrorHttp(400, 'Cliente no válido.')
      try {
        res.json(aplicarCambios(db, (Array.isArray(req.body?.cambios) ? req.body.cambios : []) as Cambio[], cliente, { maxBorrados: req.body?.forzar ? Infinity : undefined }))
      } catch (e) {
        throw new ErrorHttp(409, (e as Error).message)
      }
    })
    app.get('/api/sincro/cambios', app_, (req, res) => {
      if (Date.now() - ultimaPoda > 86_400_000) {
        ultimaPoda = Date.now()
        podarCambios(db)
      }
      const r = cambiosDesde(db, Number(req.query.desde) || 0, String(req.query.cliente ?? ''))
      // Las entregas de exámenes guardan la ruta absoluta del servidor: viajan relativas
      for (const c of r.cambios) if (c.tabla === 'archivos_entrega' && c.fila) c.fila = { ...c.fila, ruta: sincro.rutaRelativa(op.carpetaEntregas, String(c.fila.ruta)) }
      res.json(r)
    })
    // Avisos desde la app de escritorio y materiales que el docente comparte (el archivo lo sube la app)
    app.post('/api/sincro/aviso', app_, express.json(), (req, res) =>
      res.json({ enviados: extras.enviarAviso(db, enteroDe(req.body?.materia_id), String(req.body?.titulo ?? ''), String(req.body?.cuerpo ?? ''), req.body?.carrera_id ? enteroDe(req.body.carrera_id) : null) })
    )
    app.get('/api/sincro/materiales', app_, (_req, res) => {
      const dir = extras.carpetaMateriales(op.carpetaEntregas)
      const hay = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.\w+$/.test(f)).map((f) => ({ id: Number(f.split('.')[0]), tamano: statSync(join(dir, f)).size })) : []
      res.json(hay)
    })
    app.put('/api/sincro/material/:id', app_, express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
      const id = enteroDe(req.params.id)
      const ext = String(req.query.ext ?? '').toLowerCase()
      if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw new ErrorHttp(400, 'Extensión no válida.')
      if (!db.prepare('SELECT 1 FROM materiales WHERE id = ? AND compartido = 1').get(id)) throw new ErrorHttp(404, 'Ese material no está compartido.')
      const dir = extras.carpetaMateriales(op.carpetaEntregas)
      crearCarpeta(dir, { recursive: true })
      // Primero a un temporal: un archivo a medias nunca queda con el nombre final; luego se quitan otras versiones
      const destino = join(dir, `${id}${ext}`)
      writeFileSync(`${destino}.parcial`, req.body as Buffer)
      for (const f of readdirSync(dir)) if (f.startsWith(`${id}.`) && f !== `${id}${ext}` && !f.endsWith('.parcial')) borrarArchivo(join(dir, f))
      renameSync(`${destino}.parcial`, destino)
      res.json({ ok: true })
    })
    app.get('/api/sincro/cursor', app_, (_req, res) => res.json({ cursor: (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM _cambios').get() as { m: number }).m }))
    app.post('/api/sincro/codigo', app_, (_req, res) => res.json({ codigo: crearCodigoAcceso(db, principal()) }))
    app.post('/api/sincro/partida', app_, express.json(), (req, res) => {
      try {
        res.json({ pin: crearPartida(db, enteroDe(req.body?.evaluacion_id), principal(), Number(req.body?.segundos) || 20).pin })
      } catch (e) {
        // «No tiene preguntas para jugar» es un aviso para el docente, no una falla del servidor
        throw new ErrorHttp(400, (e as Error).message)
      }
    })
    app.post('/api/sincro/accesos', app_, express.json(), (req, res) => res.json(crearAccesosAlumnos(db, enteroDe(req.body?.materia_id))))
    app.post('/api/sincro/acceso', app_, express.json(), (req, res) => res.json(crearAccesoAlumno(db, enteroDe(req.body?.alumno_id))))
    app.post('/api/sincro/reiniciar', app_, express.json(), (req, res) => res.json({ password: reiniciarPasswordAlumno(db, enteroDe(req.body?.alumno_id)) }))
    app.post('/api/sincro/leidas', app_, express.json(), (req, res) => res.json({ marcadas: s.marcarLeidas(db, principal(), Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : undefined) }))
    app.post('/api/sincro/asignaciones', app_, express.json(), (req, res) => {
      const cambio = db.prepare('UPDATE asignaciones SET abre = ?, cierra = ? WHERE id = ?')
      let n = 0
      for (const c of (Array.isArray(req.body?.cambios) ? req.body.cambios : []) as { id: number; abre: string; cierra: string | null }[]) n += cambio.run(String(c.abre), c.cierra ?? null, enteroDe(c.id)).changes
      res.json({ cambiadas: n })
    })
  }

  // Un cuaderno de Jupyter con sus salidas pesa más que una petición normal (el servidor lo topa en 4 MB)
  app.use('/api/alumno/cuadernos', express.json({ limit: '6mb' }))
  // Un examen con cuaderno manda el .ipynb completo en cada guardado
  app.use('/api/alumno/intentos', express.json({ limit: '6mb' }))
  app.use(express.json({ limit: '2mb' }))

  // Con «Portal en línea», materias, alumnos e inscripciones los manda la app de escritorio (se suben completos):
  // cambiarlos aquí se perdería en la siguiente sincronización o chocaría con un alumno creado allá
  const soloEnLaApp = (_req: Request, _res: Response, next: NextFunction): void => {
    if (op.claveSincro) return next(new ErrorHttp(409, 'Con el portal en línea, los alumnos y las materias se cambian en la app de escritorio.'))
    next()
  }

  const alumno = requerir(ctx, 'alumno')
  const docente = requerir(ctx, 'docente')
  const cualquiera = requerir(ctx)
  const u = (req: Request): PeticionAutenticada => req as PeticionAutenticada
  const alumnoIdDe = (req: Request): number => {
    const id = u(req).usuario.alumno_id
    if (!id) throw new ErrorHttp(403, 'Esta cuenta no está ligada a un alumno.')
    return id
  }
  /** El recurso del parámetro debe ser de una materia del docente; si no, 404 (ver permisos.ts). */
  const propio =
    (recurso: Recurso, param = 'id') =>
    (req: Request, _res: Response, next: NextFunction): void => {
      try {
        exigirAcceso(db, u(req).usuario.id, recurso, enteroDe(req.params[param]))
        next()
      } catch (e) {
        next(e)
      }
    }
  /** Filtro de entregas de la petición, limitado a las materias del docente. */
  const filtroEntregas = (req: Request): s.FiltroEntregas => {
    const docenteId = u(req).usuario.id
    const materia_id = req.query.materia_id ? enteroDe(req.query.materia_id) : undefined
    if (materia_id) exigirAcceso(db, docenteId, 'materia', materia_id)
    return { materia_id, docente_id: alcanceDe(db, docenteId), desde: (req.query.desde as string) || undefined, hasta: (req.query.hasta as string) || undefined }
  }

  const subida = multer({
    storage: multer.diskStorage({
      // Un error aquí corre fuera de Express: si se lanza, tumba el proceso. Siempre por cb.
      destination: (req, _f, cb) => {
        try {
          const carpeta = join(op.carpetaEntregas, String(enteroDe(req.params.id)))
          mkdirSync(carpeta, { recursive: true })
          cb(null, carpeta)
        } catch (e) {
          cb(e as Error, '')
        }
      },
      filename: (_req, f, cb) => cb(null, nombreEnDisco(f))
    }),
    limits: { fileSize: LIMITE_ARCHIVO, files: 5 },
    fileFilter: (_req, f, cb) => {
      if (!EXTENSIONES_PERMITIDAS.has(extname(f.originalname).toLowerCase())) return cb(new ErrorHttp(400, `Tipo de archivo no permitido: ${extname(f.originalname)}`))
      cb(null, true)
    }
  })

  // «Subir tarea»: cada alumno en su carpeta; la ruta se guarda relativa a la carpeta de entregas
  const subidaTarea = multer({
    storage: multer.diskStorage({
      destination: (req, _f, cb) => {
        try {
          const carpeta = join(op.carpetaEntregas, 'subidas', String(alumnoIdDe(req)))
          mkdirSync(carpeta, { recursive: true })
          cb(null, carpeta)
        } catch (e) {
          cb(e as Error, '')
        }
      },
      filename: (_req, f, cb) => cb(null, nombreEnDisco(f))
    }),
    limits: { fileSize: LIMITE_ARCHIVO_TAREA, files: 5 },
    fileFilter: (_req, f, cb) => {
      if (!EXTENSIONES_PERMITIDAS.has(extname(f.originalname).toLowerCase())) return cb(new ErrorHttp(400, `Tipo de archivo no permitido: ${extname(f.originalname)}`))
      cb(null, true)
    }
  })
  const rutaEnEntregas = (ruta: string): string => (isAbsolute(ruta) ? ruta : join(op.carpetaEntregas, ruta))

  // ---------- Salud ----------
  app.get('/api/salud', (_req, res) => res.json({ ok: true, portal: leerAjuste(db, 'portal_nombre', 'App_Docente'), hora: new Date().toISOString() }))

  // ---------- Autenticación ----------
  app.post('/api/auth/login', async (req, res) => {
    const { usuario, password, recordar } = req.body ?? {}
    if (!usuario || !password) throw new ErrorHttp(400, 'Escribe usuario y contraseña.')
    const r = await iniciarSesion(ctx, String(usuario), String(password), String(req.headers['user-agent'] ?? ''), req.ip ?? '', recordar === true)
    res.json(r)
  })
  app.post('/api/auth/logout', cualquiera, (req, res) => {
    cerrarSesion(db, u(req).sesionId)
    res.json({ ok: true })
  })
  // La app de escritorio abre el panel con un código de un solo uso; aquí se cambia por una sesión
  app.post('/api/auth/canjear', (req, res) => {
    const codigo = String(req.body?.codigo ?? '')
    if (!/^[0-9a-f]{48}$/.test(codigo)) throw new ErrorHttp(400, 'Código de acceso no válido.')
    res.json({ sesion: canjearCodigo(ctx, codigo, String(req.headers['user-agent'] ?? ''), req.ip ?? '') })
  })
  app.post('/api/auth/olvide', (req, res) => {
    s.pedirRestaurar(db, String(req.body?.usuario ?? '').slice(0, 100), req.ip ?? '')
    res.json({ ok: true })
  })
  app.get('/api/auth/yo', cualquiera, (req, res) => res.json(u(req).desdeApp ? { ...u(req).usuario, desde_app: true } : u(req).usuario))
  app.post('/api/auth/password', cualquiera, (req, res) => {
    const { actual, nueva } = req.body ?? {}
    cambiarPassword(db, u(req).usuario.id, String(actual ?? ''), String(nueva ?? ''), u(req).desdeApp)
    res.json({ ok: true })
  })

  // ---------- Notificaciones (ambos roles) ----------
  app.get('/api/notificaciones', cualquiera, (req, res) => res.json(s.notificacionesDe(db, u(req).usuario.id, req.query.no_leidas === '1')))
  app.post('/api/notificaciones/leidas', cualquiera, (req, res) => res.json({ marcadas: s.marcarLeidas(db, u(req).usuario.id, req.body?.ids) }))
  // ---------- Notificaciones push (celular y computadora, aunque el portal esté cerrado) ----------
  app.get('/api/push/clave', cualquiera, (_req, res) => res.json({ publica: push.llavesPush(db).publica }))
  app.post('/api/push/suscripciones', cualquiera, (req, res) => {
    push.guardarSuscripcion(db, u(req).usuario.id, req.body?.suscripcion, String(req.body?.dispositivo ?? ''))
    res.json({ ok: true })
  })
  app.post('/api/push/revisar', cualquiera, (req, res) => res.json({ activa: push.tieneSuscripcion(db, u(req).usuario.id, String(req.body?.endpoint ?? '')) }))
  app.delete('/api/push/suscripciones', cualquiera, (req, res) => res.json({ borradas: push.borrarSuscripcion(db, u(req).usuario.id, String(req.body?.endpoint ?? '')) }))
  app.post('/api/push/prueba', cualquiera, async (req, res, next) => {
    try {
      res.json({ dispositivos: await push.enviarPrueba(db, u(req).usuario.id) })
    } catch (e) {
      next(e)
    }
  })

  // ---------- Alumno ----------
  app.get('/api/alumno/asignaciones', alumno, (req, res) => res.json(s.asignacionesDeAlumno(db, alumnoIdDe(req))))
  app.get('/api/alumno/asignaciones/:id', alumno, (req, res) => res.json(s.asignacionParaAlumno(db, enteroDe(req.params.id), alumnoIdDe(req))))
  app.post('/api/alumno/asignaciones/:id/iniciar', alumno, (req, res) => {
    const intento = s.iniciarIntento(db, enteroDe(req.params.id), alumnoIdDe(req))
    res.json(s.asignacionParaAlumno(db, intento.asignacion_id, alumnoIdDe(req)))
  })
  app.put('/api/alumno/intentos/:id/respuestas', alumno, (req, res) => {
    const { respuestas, tiempo_activo_seg, borrador } = req.body ?? {}
    const i = s.guardarRespuestas(db, enteroDe(req.params.id), alumnoIdDe(req), respuestas ?? {}, Number(tiempo_activo_seg ?? 0), Boolean(borrador))
    res.json(s.vistaParaAlumno(i, s.obtenerAsignacion(db, i.asignacion_id)))
  })
  app.post('/api/alumno/intentos/:id/eventos', alumno, (req, res) => {
    const { tipo, detalle, respuestas, tiempo_activo_seg } = req.body ?? {}
    res.json({ ok: true, ...s.registrarEvento(db, enteroDe(req.params.id), alumnoIdDe(req), String(tipo ?? 'otro') as never, String(detalle ?? ''), { respuestas, tiempo_activo_seg }) })
  })
  app.post('/api/alumno/intentos/:id/enviar', alumno, (req, res) => {
    const i = s.enviarIntento(db, enteroDe(req.params.id), alumnoIdDe(req), req.body?.tiempo_activo_seg)
    res.json(s.vistaParaAlumno(i, s.obtenerAsignacion(db, i.asignacion_id)))
  })
  // Se valida el intento antes de que multer escriba nada en disco
  const antesDeSubir = (req: Request, _res: Response, next: NextFunction): void => {
    try {
      s.validarSubida(db, enteroDe(req.params.id), alumnoIdDe(req))
      next()
    } catch (e) {
      next(e)
    }
  }
  app.post('/api/alumno/intentos/:id/archivos', alumno, antesDeSubir, subida.array('archivos', s.MAX_ARCHIVOS_POR_INTENTO), (req, res) => {
    const archivos = (req.files as Express.Multer.File[] | undefined) ?? []
    if (!archivos.length) throw new ErrorHttp(400, 'No llegó ningún archivo.')
    const registrados: ReturnType<typeof s.registrarArchivo>[] = []
    try {
      for (const f of archivos) registrados.push(s.registrarArchivo(db, enteroDe(req.params.id), alumnoIdDe(req), nombreReal(f), f.path, f.mimetype, f.size))
    } catch (e) {
      // Los que no se pudieron registrar (p. ej. pasaron del máximo) no se quedan en disco
      for (const f of archivos.slice(registrados.length)) if (existsSync(f.path)) unlinkSync(f.path)
      throw e
    }
    res.json(registrados)
  })
  app.delete('/api/alumno/archivos/:id', alumno, (req, res) => {
    const ruta = s.eliminarArchivo(db, enteroDe(req.params.id), alumnoIdDe(req))
    if (existsSync(ruta)) unlinkSync(ruta)
    res.json({ ok: true })
  })
  app.get('/api/alumno/calificaciones', alumno, (req, res) => res.json(s.calificacionesDeAlumno(db, alumnoIdDe(req))))
  app.get('/api/alumno/avance', alumno, (req, res) => res.json(avanceDeAlumno(db, alumnoIdDe(req))))

  /**
   * Modo examen: mientras el alumno tiene abierto un examen, Programar y Jugar se esconden y Programar
   * no guarda (no hay calculadora de sympy a la mano). El cambio de pestaña igual queda registrado.
   */
  const enExamen = (alumnoId: number): boolean =>
    !!db
      .prepare(
        `SELECT 1 FROM intentos i JOIN asignaciones a ON a.id = i.asignacion_id JOIN evaluaciones e ON e.id = a.evaluacion_id
         WHERE i.alumno_id = ? AND i.estado = 'en_curso' AND a.activa = 1 AND (a.cierra IS NULL OR a.cierra > datetime('now'))
           AND e.tipo IN ('examen', 'examen_sorpresa', 'diagnostico') AND i.ultima_actividad > datetime('now', '-3 hours') LIMIT 1`
      )
      .get(alumnoId)
  // `bloqueo`: el examen bloqueado que tiene abierto (el portal lo encierra ahí hasta que lo envíe)
  app.get('/api/alumno/estado', alumno, (req, res) => {
    const bloqueo = s.examenBloqueado(db, alumnoIdDe(req))
    res.json({ examen: enExamen(alumnoIdDe(req)) || bloqueo !== null, bloqueo, ...extras.opcionesAlumno(db, alumnoIdDe(req)) })
  })

  // ---------- Alumno: materiales compartidos y calendario ----------
  app.get('/api/alumno/materiales', alumno, (req, res) => res.json(extras.materialesDeAlumno(db, alumnoIdDe(req), op.carpetaEntregas)))
  app.get('/api/alumno/materiales/:id', alumno, (req, res) => {
    const m = extras.materialParaAlumno(db, alumnoIdDe(req), enteroDe(req.params.id), op.carpetaEntregas)
    if ('url' in m) return void res.json(m)
    res.download(m.ruta, m.nombre)
  })
  app.get('/api/alumno/calendario', alumno, (req, res) => res.json(extras.calendarioDeAlumno(db, alumnoIdDe(req))))

  // ---------- Alumno: cuadernos de Jupyter (su copia, guardado automático y entrega a una tarea) ----------
  // Corre Python como Programar: con un examen abierto no se usa
  const sinExamen = (req: Request, _res: Response, next: NextFunction): void =>
    next(enExamen(alumnoIdDe(req)) ? new ErrorHttp(423, 'Los cuadernos no están disponibles mientras tienes un examen abierto.') : undefined)
  app.get('/api/alumno/cuadernos/:id', alumno, sinExamen, (req, res) => res.json(cuadernos.abrirCuaderno(db, alumnoIdDe(req), enteroDe(req.params.id), op.carpetaEntregas)))
  app.put('/api/alumno/cuadernos/:id', alumno, sinExamen, (req, res) => res.json(cuadernos.guardarCuaderno(db, alumnoIdDe(req), enteroDe(req.params.id), req.body?.contenido)))
  app.get('/api/alumno/cuadernos/:id/tareas', alumno, (req, res) => res.json(cuadernos.tareasParaCuaderno(db, alumnoIdDe(req), enteroDe(req.params.id))))
  app.post('/api/alumno/cuadernos/:id/entregar', alumno, (req, res) =>
    res.json(cuadernos.entregarCuaderno(db, alumnoIdDe(req), enteroDe(req.params.id), String(req.body?.curso_id ?? ''), String(req.body?.tarea_id ?? ''), req.body?.contenido, op.carpetaEntregas))
  )

  // Programas de práctica del alumno (editor de código): cada quien solo ve y cambia los suyos.
  // Topes para que un script no llene el servidor del salón ni los respaldos diarios
  const TOPE_PROGRAMAS = 100
  const TOPE_CODIGO = 100_000
  const TOPE_TOTAL = 2_000_000
  const programa = (b: Record<string, unknown>): [string, string, string, string] => {
    const codigo = String(b.codigo ?? '')
    if (codigo.length > TOPE_CODIGO) throw new ErrorHttp(400, 'El programa es demasiado largo (máximo 100 000 caracteres).')
    return [String(b.nombre ?? '').trim().slice(0, 80) || 'Sin nombre', b.lenguaje === 'javascript' ? 'javascript' : 'python', codigo, String(b.entrada ?? '').slice(0, 20_000)]
  }
  const exigirEspacio = (alumnoId: number, nuevo: string[], sinContar = 0): void => {
    const usado = (db.prepare('SELECT COALESCE(SUM(LENGTH(codigo) + LENGTH(entrada)), 0) AS n FROM programas_alumno WHERE alumno_id = ? AND id <> ?').get(alumnoId, sinContar) as { n: number }).n
    if (usado + nuevo[2].length + nuevo[3].length > TOPE_TOTAL) throw new ErrorHttp(400, 'Ya no tienes espacio para más código: borra programas que no uses.')
  }
  const fueraDeExamen = (alumnoId: number): void => {
    if (enExamen(alumnoId)) throw new ErrorHttp(423, 'Programar no está disponible mientras tienes un examen abierto.')
  }
  app.get('/api/alumno/programas', alumno, (req, res) => {
    fueraDeExamen(alumnoIdDe(req))
    res.json(db.prepare('SELECT id, nombre, lenguaje, codigo, entrada, actualizado FROM programas_alumno WHERE alumno_id = ? ORDER BY actualizado DESC, id DESC').all(alumnoIdDe(req)))
  })
  app.post('/api/alumno/programas', alumno, (req, res) => {
    const yo = alumnoIdDe(req)
    fueraDeExamen(yo)
    if ((db.prepare('SELECT COUNT(*) AS n FROM programas_alumno WHERE alumno_id = ?').get(yo) as { n: number }).n >= TOPE_PROGRAMAS)
      throw new ErrorHttp(400, `Llegaste a ${TOPE_PROGRAMAS} programas: borra alguno para crear otro.`)
    const datos = programa(req.body ?? {})
    exigirEspacio(yo, datos)
    const id = Number(db.prepare('INSERT INTO programas_alumno (nombre, lenguaje, codigo, entrada, alumno_id) VALUES (?, ?, ?, ?, ?)').run(...datos, yo).lastInsertRowid)
    res.json({ id })
  })
  app.put('/api/alumno/programas/:id', alumno, (req, res) => {
    const yo = alumnoIdDe(req)
    const id = enteroDe(req.params.id)
    fueraDeExamen(yo)
    const datos = programa(req.body ?? {})
    exigirEspacio(yo, datos, id)
    const r = db.prepare("UPDATE programas_alumno SET nombre = ?, lenguaje = ?, codigo = ?, entrada = ?, actualizado = datetime('now') WHERE id = ? AND alumno_id = ?").run(...datos, id, yo)
    if (!r.changes) throw new ErrorHttp(404, 'Ese programa no existe.')
    res.json({ ok: true })
  })
  app.delete('/api/alumno/programas/:id', alumno, (req, res) => {
    db.prepare('DELETE FROM programas_alumno WHERE id = ? AND alumno_id = ?').run(enteroDe(req.params.id), alumnoIdDe(req))
    res.json({ ok: true })
  })

  // ---------- Alumno: «Subir tarea» (tareas de Classroom) ----------
  app.get('/api/alumno/tareas', alumno, (req, res) => res.json(tareas.tareasDeAlumno(db, alumnoIdDe(req))))
  const antesDeSubirTarea = (req: Request, _res: Response, next: NextFunction): void => {
    try {
      tareas.validarTareaDeAlumno(db, alumnoIdDe(req), String(req.params.curso), String(req.params.tarea))
      next()
    } catch (e) {
      next(e)
    }
  }
  app.post('/api/alumno/tareas/:curso/:tarea/archivos', alumno, antesDeSubirTarea, subidaTarea.array('archivos', 5), (req, res) => {
    const archivos = (req.files as Express.Multer.File[] | undefined) ?? []
    if (!archivos.length) throw new ErrorHttp(400, 'No llegó ningún archivo.')
    try {
      tareas.registrarSubida(
        db,
        alumnoIdDe(req),
        String(req.params.curso),
        String(req.params.tarea),
        typeof req.body?.nota === 'string' ? req.body.nota : undefined,
        archivos.map((f) => ({ nombre: nombreReal(f), ruta: relative(op.carpetaEntregas, f.path), mime: f.mimetype, tamano: f.size }))
      )
    } catch (e) {
      for (const f of archivos) if (existsSync(f.path)) unlinkSync(f.path)
      throw e
    }
    res.json({ ok: true })
  })
  app.delete('/api/alumno/tareas/archivos/:id', alumno, (req, res) => {
    const ruta = rutaEnEntregas(tareas.quitarArchivoSubida(db, alumnoIdDe(req), enteroDe(req.params.id)))
    if (existsSync(ruta)) unlinkSync(ruta)
    res.json({ ok: true })
  })
  app.get('/api/subidas/archivos/:id', cualquiera, (req, res) => {
    const f = tareas.archivoDeSubida(db, enteroDe(req.params.id))
    const quien = u(req).usuario
    if (quien.rol === 'docente') exigirAcceso(db, quien.id, 'materia', f.materia_id)
    else if (quien.alumno_id !== f.alumno_id) throw new ErrorHttp(403, 'No puedes ver este archivo.')
    const ruta = rutaEnEntregas(f.ruta)
    if (!existsSync(ruta)) throw new ErrorHttp(404, 'El archivo ya no está en el servidor.')
    res.download(ruta, f.nombre)
  })

  // ---------- Archivos (dueño o docente de la materia) ----------
  app.get('/api/archivos/:id', cualquiera, (req, res) => {
    const f = s.rutaDeArchivo(db, enteroDe(req.params.id))
    const quien = u(req).usuario
    if (quien.rol === 'docente') exigirAcceso(db, quien.id, 'archivo', enteroDe(req.params.id))
    else if (quien.alumno_id !== f.alumno_id) throw new ErrorHttp(403, 'No puedes ver este archivo.')
    if (!existsSync(f.ruta)) throw new ErrorHttp(404, 'El archivo ya no está en el servidor.')
    res.download(f.ruta, f.nombre)
  })

  // ---------- Docente: cada ruta revisa que el recurso sea de sus materias (`propio`) ----------
  app.get('/api/docente/materias', docente, (req, res) => res.json(s.materiasVisibles(db, alcanceDe(db, u(req).usuario.id))))
  // Partidas del juego que siguen abiertas (de las últimas 12 h): si se cerró la ventana, se retoman de aquí
  app.get('/api/docente/partidas', docente, (req, res) => {
    const yo = u(req).usuario.id
    const abiertas = db
      .prepare(
        `SELECT p.pin, p.estado, p.pregunta_actual, p.creada, e.titulo, m.nombre AS materia_nombre,
           (SELECT COUNT(*) FROM participantes x WHERE x.partida_id = p.id) AS jugadores
         FROM partidas p JOIN evaluaciones e ON e.id = p.evaluacion_id JOIN materias m ON m.id = e.materia_id
         WHERE p.estado <> 'terminada' AND p.creada > datetime('now', '-12 hours') ORDER BY p.creada DESC`
      )
      .all() as { pin: string }[]
    res.json(abiertas.filter((p) => tieneAcceso(db, yo, 'partida', p.pin)))
  })
  app.patch('/api/docente/materias/:id', docente, soloEnLaApp, propio('materia'), (req, res) => {
    s.ocultarMateria(db, enteroDe(req.params.id), Boolean(req.body?.oculta))
    res.json({ ok: true })
  })
  // ---------- Docente: pase de lista (la clase se revisa contra sus materias) ----------
  const propioSesion = (req: Request, _res: Response, next: NextFunction): void => {
    try {
      exigirAcceso(db, u(req).usuario.id, 'materia', asistencia.materiaDeSesion(db, enteroDe(req.params.id)))
      next()
    } catch (e) {
      next(e)
    }
  }
  app.get('/api/docente/materias/:id/sesiones', docente, propio('materia'), (req, res) => res.json(asistencia.sesionesDeMateria(db, enteroDe(req.params.id))))
  app.get('/api/docente/sesiones/:id/asistencia', docente, propioSesion, (req, res) => res.json(asistencia.listaDeSesion(db, enteroDe(req.params.id))))
  app.put('/api/docente/sesiones/:id/asistencia', docente, propioSesion, (req, res) => {
    asistencia.marcar(db, enteroDe(req.params.id), enteroDe(req.body?.alumno_id), String(req.body?.estado ?? ''), typeof req.body?.nota === 'string' ? req.body.nota.slice(0, 500) : undefined)
    res.json(asistencia.listaDeSesion(db, enteroDe(req.params.id)))
  })
  app.post('/api/docente/sesiones/:id/asistencia/todos', docente, propioSesion, (req, res) => {
    const carrera = req.body?.carrera_id === undefined || req.body?.carrera_id === null ? null : enteroDe(req.body.carrera_id)
    const marcados = asistencia.marcarTodos(db, enteroDe(req.params.id), String(req.body?.estado ?? ''), carrera)
    res.json({ marcados, ...asistencia.listaDeSesion(db, enteroDe(req.params.id)) })
  })
  app.post('/api/docente/sesiones/:id/asistencia/justificar', docente, propioSesion, (req, res) => {
    asistencia.justificar(db, enteroDe(req.params.id), enteroDe(req.body?.alumno_id), String(req.body?.motivo ?? ''))
    res.json(asistencia.listaDeSesion(db, enteroDe(req.params.id)))
  })

  // ---------- Docente: avisos al grupo (a la campana de cada alumno; en grupos mixtos, por carrera) ----------
  // Carreras de los alumnos del grupo: con más de una, el aviso puede ir solo a una
  app.get('/api/docente/materias/:id/carreras', docente, propio('materia'), (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT DISTINCT c.id, c.nombre, c.clave, c.color FROM carreras c JOIN alumnos a ON a.carrera_id = c.id JOIN inscripciones i ON i.alumno_id = a.id
           WHERE i.materia_id = ? AND a.activo = 1 ORDER BY c.nombre`
        )
        .all(enteroDe(req.params.id))
    )
  })
  app.post('/api/docente/materias/:id/avisos', docente, propio('materia'), (req, res) => {
    const carrera = req.body?.carrera_id === undefined || req.body?.carrera_id === null || req.body?.carrera_id === '' ? null : enteroDe(req.body.carrera_id)
    res.json({ enviados: extras.enviarAviso(db, enteroDe(req.params.id), String(req.body?.titulo ?? ''), String(req.body?.cuerpo ?? ''), carrera) })
  })

  // ---------- Docente: calificaciones (mismo cálculo que la app) y captura a mano ----------
  app.get('/api/docente/materias/:id/calificaciones', docente, propio('materia'), (req, res) => res.json(calif.calificacionesDeMateria(db, enteroDe(req.params.id))))
  app.put('/api/docente/materias/:id/capturas', docente, propio('materia'), (req, res) => {
    const valor = req.body?.valor === null || req.body?.valor === '' || req.body?.valor === undefined ? null : Number(req.body.valor)
    res.json(calif.capturar(db, enteroDe(req.params.id), { componente_id: enteroDe(req.body?.componente_id), alumno_id: enteroDe(req.body?.alumno_id), rubro: Number(req.body?.rubro ?? 0), valor }))
  })

  app.get('/api/docente/materias/:id/evaluaciones', docente, propio('materia'), (req, res) => {
    res.json(db.prepare("SELECT id, titulo, tipo, puntos_totales, fecha_aplicacion, creado, (contenido LIKE '{%') AS con_reactivos FROM evaluaciones WHERE materia_id = ? ORDER BY fecha_aplicacion, id").all(enteroDe(req.params.id)))
  })
  app.get('/api/docente/materias/:id/alumnos', docente, propio('materia'), (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT a.id, a.matricula, a.nombre, a.apellidos, a.email, a.carrera_id, c.nombre AS carrera_nombre, c.clave AS carrera_clave, u.usuario, u.debe_cambiar
           FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id LEFT JOIN usuarios u ON u.alumno_id = a.id LEFT JOIN carreras c ON c.id = a.carrera_id
           WHERE i.materia_id = ? ORDER BY a.apellidos, a.nombre`
        )
        .all(enteroDe(req.params.id))
    )
  })
  app.post('/api/docente/materias/:id/alumnos', docente, soloEnLaApp, propio('materia'), (req, res) => {
    const lista = Array.isArray(req.body) ? req.body : [req.body]
    const docenteId = u(req).usuario.id
    const resultados = db.transaction(() => lista.map((d: s.DatosAlumno) => s.inscribirAlumno(db, enteroDe(req.params.id), d, docenteId)))()
    res.json({ inscritos: resultados.length, nuevos: resultados.filter((r: { nuevo: boolean }) => r.nuevo).length })
  })
  app.delete('/api/docente/materias/:id/alumnos/:alumnoId', docente, soloEnLaApp, propio('materia'), (req, res) => res.json({ quitados: s.desinscribirAlumno(db, enteroDe(req.params.id), enteroDe(req.params.alumnoId)) }))
  app.get('/api/docente/evaluaciones/:id', docente, propio('evaluacion'), (req, res) => res.json(s.evaluacionCompleta(db, enteroDe(req.params.id))))
  app.post('/api/docente/materias/:id/accesos', docente, propio('materia'), (req, res) => res.json(crearAccesosAlumnos(db, enteroDe(req.params.id))))
  app.post('/api/docente/alumnos/:id/reiniciar-password', docente, propio('alumno'), (req, res) => {
    const id = enteroDe(req.params.id)
    if (!alumnoSoloDe(db, u(req).usuario.id, id)) throw new ErrorHttp(403, 'Este alumno también está en materias de otro docente: pide al administrador del portal que le reinicie la contraseña.')
    res.json({ password: reiniciarPasswordAlumno(db, id) })
  })

  app.post('/api/docente/asignaciones', docente, (req, res) => {
    exigirAcceso(db, u(req).usuario.id, 'materia', enteroDe(req.body?.materia_id))
    exigirAcceso(db, u(req).usuario.id, 'evaluacion', enteroDe(req.body?.evaluacion_id))
    res.json(s.crearAsignacion(db, { ...req.body, docente_id: u(req).usuario.id }))
  })
  app.get('/api/docente/asignaciones', docente, (req, res) => res.json(s.asignacionesConResumen(db, filtroEntregas(req))))
  // Eliminar una publicación (con sus entregas); la evaluación queda para volver a publicarla
  app.delete('/api/docente/asignaciones/:id', docente, propio('asignacion'), (req, res) => res.json(s.eliminarAsignacion(db, enteroDe(req.params.id), op.carpetaEntregas)))
  app.patch('/api/docente/asignaciones/:id', docente, propio('asignacion'), (req, res) => res.json(s.actualizarAsignacion(db, enteroDe(req.params.id), req.body ?? {})))
  app.get('/api/docente/asignaciones/:id/entregas', docente, propio('asignacion'), (req, res) => res.json({ asignacion: s.obtenerAsignacion(db, enteroDe(req.params.id)), entregas: s.entregasDeAsignacion(db, enteroDe(req.params.id)) }))
  app.get('/api/docente/intentos/:id', docente, propio('intento'), (req, res) => res.json(s.intentoDetallado(db, enteroDe(req.params.id))))
  // Quitar (o devolver) el bloqueo de examen a un solo alumno
  app.patch('/api/docente/intentos/:id/desbloqueo', docente, propio('intento'), (req, res) => res.json(s.desbloquearIntento(db, enteroDe(req.params.id), req.body?.desbloqueado)))
  app.put('/api/docente/intentos/:id/calificar', docente, propio('intento'), (req, res) => {
    const { puntaje, retro } = req.body ?? {}
    const n = Number(puntaje)
    if (!Number.isFinite(n)) throw new ErrorHttp(400, 'El puntaje debe ser un número.')
    res.json(s.calificarIntento(db, enteroDe(req.params.id), n, String(retro ?? '')))
  })
  app.get('/api/docente/entregas/exportar', docente, async (req, res) => {
    const filas = s.filasParaExportar(db, filtroEntregas(req))
    const wb = new ExcelJS.Workbook()
    const hoja = wb.addWorksheet('Entregas')
    const columnas = ['materia', 'actividad', 'tipo', 'publicada', 'matricula', 'alumno', 'estado', 'iniciado', 'enviado', 'minutos_activo', 'eventos_integridad', 'puntaje', 'puntos_totales', 'retro']
    hoja.addRow(columnas.map((c) => c.replace(/_/g, ' '))).font = { bold: true }
    filas.forEach((fila) => hoja.addRow(columnas.map((c) => fila[c])))
    hoja.columns.forEach((c) => (c.width = 18))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="entregas.xlsx"')
    res.send(Buffer.from(await wb.xlsx.writeBuffer()))
  })

  // ---------- Juego en vivo ----------
  app.post('/api/docente/partidas', docente, (req, res) => {
    exigirAcceso(db, u(req).usuario.id, 'evaluacion', enteroDe(req.body?.evaluacion_id))
    try {
      res.json(crearPartida(db, enteroDe(req.body?.evaluacion_id), u(req).usuario.id, Number(req.body?.segundos ?? 20)))
    } catch (e) {
      throw new ErrorHttp(400, (e as Error).message)
    }
  })
  // Quién respondió qué: solo el docente de la partida (la pantalla pública no lo muestra sin que él lo pida)
  app.get('/api/docente/partidas/:pin/detalle', docente, (req, res) => {
    const pin = String(req.params.pin)
    const p = leerPartida(db, pin)
    if (!p || !tieneAcceso(db, u(req).usuario.id, 'partida', pin)) throw new ErrorHttp(404, 'No hay ninguna partida con ese PIN.')
    res.json(detallePartida(db, p))
  })
  app.get('/api/partidas/:pin', (req, res) => {
    const p = leerPartida(db, String(req.params.pin))
    if (!p) throw new ErrorHttp(404, 'No hay ninguna partida con ese PIN.')
    // Dirección que el anfitrión proyecta: la pública si existe, si no la IP de la red local
    // (el anfitrión suele abrirse en localhost desde la app y esa dirección no le sirve a nadie más)
    const host = req.get('host') ?? ''
    const puerto = host.split(':')[1]
    const ip = direccionesLocales()[0]
    const url_alumnos = leerAjuste(db, 'portal_url_publica') || (ip && puerto ? `http://${ip}:${puerto}` : `${req.protocol}://${host}`)
    res.json({ ...p, participantes: tablaDe(db, p.id), url_alumnos })
  })

  // Rutas extra del arranque (en el VPS: la app de escritorio en la web), antes de la página del portal
  op.montar?.(app, ctx)

  // ---------- Python del editor de código (sin internet: sale de la app) ----------
  app.get('/pyodide/:archivo', servirPyodide((op.carpetasPyodide ?? []).filter((c) => existsSync(c))))
  app.use('/pyodide', (_req, res) => void res.status(404).end())

  // ---------- Portal estático ----------
  if (op.carpetaPortal && existsSync(op.carpetaPortal)) {
    // index.html nunca se guarda en caché: tras actualizar la app apunta a archivos nuevos y los viejos ya no existen.
    // Los de /assets llevan huella en el nombre (Vite) y pueden guardarse mucho tiempo.
    const sinCache = (res: Response): void => void res.setHeader('Cache-Control', 'no-cache')
    app.use(
      express.static(op.carpetaPortal, {
        index: 'index.html',
        maxAge: '30d',
        immutable: true,
        setHeaders: (res, ruta) => {
          // Solo /assets lleva huella en el nombre; index.html, sw.js, el manifest y los íconos se revalidan siempre
          if (!ruta.includes(`${sep}assets${sep}`)) sinCache(res)
        }
      })
    )
    // Un archivo del portal que ya no existe (p. ej. el celular tenía abierta la versión anterior) da 404,
    // no la página: así el portal detecta la falla y se recarga en vez de quedar en blanco
    app.get(/^\/assets\//, (_req, res) => void res.status(404).end())
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      sinCache(res)
      res.sendFile(join(op.carpetaPortal!, 'index.html'))
    })
  }

  // ---------- Errores ----------
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ErrorHttp) return res.status(err.estado).json({ error: err.message, codigo: err.codigo })
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE'
          ? `El archivo pasa de ${req.path.startsWith('/api/alumno/tareas') ? 50 : 25} MB.`
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'Sube máximo 5 archivos a la vez.'
            : err.message })
    console.error('[portal]', err)
    res.status(500).json({ error: 'Error interno del servidor.' })
  })

  const http = createServer(app)
  const io = new ServidorSockets(http)
  registrarPartidas(io, ctx)

  return {
    http,
    io,
    contexto: ctx,
    iniciar: (puerto, host = '0.0.0.0') =>
      new Promise((resolver, rechazar) => {
        http.once('error', rechazar)
        http.listen(puerto, host, () => {
          const real = (http.address() as { port: number }).port
          escribirAjuste(db, 'portal_puerto', String(real))
          resolver({ puerto: real, urls: [`http://localhost:${real}`, ...direccionesLocales().map((ip) => `http://${ip}:${real}`)] })
        })
      }),
    detener: () =>
      new Promise((resolver) => {
        io.close()
        http.close(() => resolver())
      })
  }
}

export { asegurarDocente, direccionesLocales }
