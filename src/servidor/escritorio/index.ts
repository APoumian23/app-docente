/**
 * La app de escritorio completa en el navegador (portal.ejemplo.com/app).
 *
 * Las pantallas son las mismas de la app (src/renderer, compiladas para la web) y las acciones son las mismas
 * del proceso principal (src/main/ipc): aquí se registran contra la base del servidor y se llaman por
 * POST /api/docente/app/rpc en vez de por IPC. Lo que en la Mac hace Electron lo resuelve ./electron.
 *
 * Solo el docente principal entra: las acciones ven y cambian todo, como en su app.
 *
 * La Mac y la web conviven: lo que se cambia aquí se anota en `_cambios` y la Mac lo baja en su siguiente
 * sincronización (y al revés). Para que una fila creada aquí no choque con una creada en la Mac al mismo
 * tiempo, antes de cada acción los contadores de ids del servidor se adelantan (ver `adelantarIds`).
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import type Database from 'better-sqlite3'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, extname, isAbsolute, join, relative } from 'path'
import { contextoWeb, manejadores, avisosWeb, carpetaTemporal, esPdfWeb, NecesitaArchivo, type ContextoWeb } from './electron'
import { usarBase, materialesDir, getAjuste, setAjuste } from '../../main/db'
import { registrarIpc } from '../../main/ipc'
import { guardarApiKey } from '../../main/services/ia'
import { archivoEnCache, importarConexion } from '../../main/services/classroom'
import { estadoSincro } from '../../main/services/portal-remoto'
import { qrDe } from '../../main/services/portal'
import { crearPartida } from '../partidas'
import { docentePrincipalId } from '../permisos'
import { requerir, ErrorHttp, type Contexto, type PeticionAutenticada } from '../auth'
import { TABLAS_SIN_SINCRONIZAR, AJUSTES_DE_LA_MAC, type SecretosDeLaMac } from '../../shared/sincronizacion'

// ---------- Ids sin choques ----------

const SIN_SINCRO = new Set<string>(TABLAS_SIN_SINCRONIZAR)
/** Distancia mínima entre el último id que existe y el siguiente que da el servidor. */
const SEPARACION = 1_000_000
let tablasConContador: string[] | null = null

/**
 * La Mac crea filas con el siguiente id de cada tabla (el mayor que conoce + 1). Si el servidor hiciera lo mismo,
 * las dos darían el mismo id a filas distintas antes de sincronizar. Aquí el contador del servidor se pone al
 * menos un millón por encima del mayor id de la tabla (con un poco de azar): la Mac nunca crea tantas filas
 * entre dos sincronizaciones. Cuando la Mac recibe esas filas, su contador las alcanza y el servidor vuelve a
 * adelantarse en la siguiente acción.
 */
function adelantarIds(db: Database.Database): void {
  tablasConContador ??= (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%AUTOINCREMENT%'").all() as { name: string }[])
    .map((t) => t.name)
    .filter((t) => !SIN_SINCRO.has(t) && !t.startsWith('_'))
  const leerSeq = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?')
  const ponerSeq = db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
  const nuevoSeq = db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)')
  db.transaction(() => {
    for (const t of tablasConContador!) {
      const mayor = (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM "${t}"`).get() as { m: number }).m
      const fila = leerSeq.get(t) as { seq: number } | undefined
      if (fila && fila.seq >= mayor + SEPARACION) continue
      const siguiente = Math.max(mayor, fila?.seq ?? 0) + SEPARACION + randomInt(SEPARACION)
      if (fila) ponerSeq.run(siguiente, t)
      else nuevoSeq.run(t, siguiente)
    }
  })()
}

// ---------- Archivos que suben y bajan ----------

interface Pendiente {
  ruta: string
  nombre: string
  modo: 'bajar' | 'ver' | 'imprimir'
  temporal: boolean
  vence: number
}
const subidas = new Map<string, { ruta: string; vence: number }>()
const descargas = new Map<string, Pendiente>()
const VIDA_MS = 30 * 60_000

function limpiarVencidos(): void {
  const ahora = Date.now()
  for (const [k, s] of subidas) {
    if (s.vence >= ahora) continue
    subidas.delete(k)
    rmSync(join(s.ruta, '..'), { recursive: true, force: true })
  }
  for (const [k, d] of descargas) {
    if (d.vence >= ahora) continue
    descargas.delete(k)
    if (d.temporal) rmSync(d.ruta, { force: true })
  }
}

const TIPOS: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg'
}

/** Lo que la acción dejó para descargar o ver, ya con su enlace de un solo uso por 30 min. */
function registrarDescargas(c: ContextoWeb): { url: string; nombre: string; modo: Pendiente['modo'] }[] {
  const tmp = carpetaTemporal()
  return c.descargas
    .filter((d) => existsSync(d.ruta) && statSync(d.ruta).isFile())
    .map((d) => {
      const temporal = !relative(tmp, d.ruta).startsWith('..')
      const cabeza = Buffer.alloc(32)
      const fd = openSync(d.ruta, 'r')
      readSync(fd, cabeza, 0, 32, 0)
      closeSync(fd)
      const modo: Pendiente['modo'] = esPdfWeb(cabeza) ? 'imprimir' : d.ver ? 'ver' : 'bajar'
      const token = randomBytes(18).toString('base64url')
      const nombre = modo === 'imprimir' ? d.nombre.replace(/\.pdf$/i, '') : d.nombre
      descargas.set(token, { ruta: d.ruta, nombre, modo, temporal, vence: Date.now() + VIDA_MS })
      return { url: `/api/docente/app/descarga/${token}`, nombre, modo }
    })
}

/**
 * Llave de los enlaces a archivos (materiales, Classroom): las etiquetas <iframe>/<img> no mandan la sesión.
 * Sale del secreto del servidor, así sigue valiendo tras reiniciarlo (una página abierta no pierde sus PDFs).
 */
let llaveArchivos = ''

// ---------- Acciones que en la web son distintas ----------

type Manejador = (e: unknown, ...args: unknown[]) => unknown
const ok = <T>(data: T): { ok: true; data: T } => ({ ok: true, data })
const no = (error: string): { ok: false; error: string } => ({ ok: false, error })
const SOLO_MAC = 'Esto se hace en la app de escritorio de tu Mac.'

function sobrescribir(db: Database.Database): void {
  const poner = (canal: string, fn: (...args: never[]) => unknown): void => {
    manejadores.set(canal, async (_e, ...args) => {
      try {
        return ok(await (fn as (...a: unknown[]) => unknown)(...args))
      } catch (err) {
        return no((err as Error).message)
      }
    })
  }
  const origen = (): string => contextoWeb.getStore()?.origen ?? ''
  const docenteId = (): number => {
    const id = docentePrincipalId(db)
    if (!id) throw new Error('El servidor no tiene cuenta docente.')
    return id
  }
  // El portal ES este servidor: siempre en línea, sin nada que encender, apagar ni sincronizar desde aquí
  const estado = (): unknown => ({
    encendido: true,
    puerto: 443,
    urls: [origen()],
    url_publica: origen(),
    docente_usuario: getAjuste('portal_docente_usuario'),
    docente_configurado: true,
    auto_iniciar: true,
    avance_alumnos: getAjuste('portal_alumno_avance', '1') === '1',
    portal_compilado: true,
    no_leidas: (db.prepare('SELECT COUNT(*) AS n FROM notificaciones WHERE usuario_id = ? AND leida = 0').get(docenteId()) as { n: number }).n,
    falla: '',
    en_linea: true,
    web: true,
    sincro: { ...estadoSincro(), ultima: new Date().toISOString(), falla: '', enCurso: false }
  })
  poner('portal:estado', estado)
  poner('portal:sincronizar', estado)
  for (const c of ['portal:iniciar', 'portal:detener', 'portal:docente']) poner(c, () => {
    throw new Error('En la versión web el portal siempre está en línea.')
  })
  poner('portal:ajustes', (a: { avance_alumnos?: boolean }) => {
    if (a?.avance_alumnos !== undefined) setAjuste('portal_alumno_avance', a.avance_alumnos ? '1' : '0')
    return estado()
  })
  poner('portal:qr', async () => ({ url: origen(), qr: await qrDe(origen()) }))
  // El panel del portal es este mismo sitio: la sesión del docente ya vale ahí
  const conIncrustado = (ruta = '/docente'): string => {
    const r = String(ruta || '/docente')
    if (!r.startsWith('/') || r.startsWith('//')) throw new Error('Ruta no válida.')
    return `${r}${r.includes('?') ? '&' : '?'}incrustado=1`
  }
  poner('portal:urlPanel', (ruta?: string) => conIncrustado(ruta))
  poner('portal:abrirPanel', (ruta?: string, enVentana?: boolean | 'navegador') => {
    const r = String(ruta || '/docente')
    if (!r.startsWith('/') || r.startsWith('//')) throw new Error('Ruta no válida.')
    if (enVentana) contextoWeb.getStore()?.abrir.push(r)
    else avisosWeb.emit('aviso', 'portal:verPanel', [r])
  })
  poner('portal:jugar', (evaluacionId: number, segundos?: number) => {
    const p = crearPartida(db, Number(evaluacionId), docenteId(), Number(segundos) || 20)
    contextoWeb.getStore()?.abrir.push(`/docente/juego/${p.pin}`)
    return p.pin
  })
  poner('portal:contestando', () => ({ alumnos: 0, partidas: 0 }))
  poner('actualizacion:revisar', () => ({ instalada: null, disponible: null, hay_nueva: false, novedades: [], origen: '', motivo: 'En la web siempre tienes la versión más reciente.' }))
  poner('actualizacion:instalar', () => {
    throw new Error('En la web siempre tienes la versión más reciente.')
  })
  for (const c of ['respaldos:restaurar', 'respaldos:elegirCarpeta', 'respaldos:quitarCarpeta', 'classroom:conectar', 'classroom:guardarCredenciales', 'classroom:desconectar'])
    poner(c, () => {
      throw new Error(SOLO_MAC)
    })
  poner('errores:mostrarArchivo', () => undefined)
  poner('sistema:pantallaCompleta', () => undefined)
  // Llave para los enlaces de archivos (docente://… en la Mac)
  poner('web:llave', () => llaveArchivos)
}

// ---------- Llaves y ajustes que manda la Mac ----------

export function recibirSecretos(s: SecretosDeLaMac): { guardados: string[]; fallas: string[] } {
  const guardados: string[] = []
  const fallas: string[] = []
  // Cada cosa por su cuenta: una llave que no pasa la revisión no impide guardar las demás
  const guardar = (nombre: string, fn: () => void): void => {
    try {
      fn()
      guardados.push(nombre)
    } catch (e) {
      fallas.push(`${nombre}: ${(e as Error).message}`)
    }
  }
  if (s.ia?.anthropic) guardar('anthropic', () => guardarApiKey(s.ia!.anthropic!, 'anthropic'))
  if (s.ia?.nvidia) guardar('nvidia', () => guardarApiKey(s.ia!.nvidia!, 'nvidia'))
  if (s.classroom?.refresh) guardar('classroom', () => importarConexion(s.classroom!))
  for (const [k, v] of Object.entries(s.ajustes ?? {})) {
    if ((AJUSTES_DE_LA_MAC as readonly string[]).includes(k) && typeof v === 'string') setAjuste(k, v)
  }
  return { guardados, fallas }
}

// ---------- Montaje ----------

export interface OpcionesEscritorio {
  db: Database.Database
  ctx: Contexto
  /** Clave con la que sincroniza la Mac (para que mande sus llaves y sus materiales) */
  claveSincro?: string
  /** Carpeta con la app compilada para la web (dist/app) */
  carpetaApp: string | null
}

export function montarEscritorio(app: Express, op: OpcionesEscritorio): void {
  const { db } = op
  process.env.DOCENTE_WEB = '1'
  llaveArchivos = createHash('sha256').update(`docente-app-archivos:${op.ctx.secreto}`).digest('base64url').slice(0, 32)
  usarBase(db)
  registrarIpc()
  sobrescribir(db)
  setInterval(limpiarVencidos, 5 * 60_000).unref()

  const docente = requerir(op.ctx, 'docente')
  const soloPrincipal = (req: Request, _res: Response, next: NextFunction): void => {
    const id = (req as PeticionAutenticada).usuario.id
    if (id !== docentePrincipalId(db)) return next(new ErrorHttp(403, 'La app completa en la web es solo para el docente titular.'))
    next()
  }
  const origenDe = (req: Request): string => `${req.protocol}://${req.get('host')}`

  app.post('/api/docente/app/rpc', docente, soloPrincipal, express.json({ limit: '60mb' }), async (req, res) => {
    const canal = String(req.body?.canal ?? '')
    const fn = manejadores.get(canal) as Manejador | undefined
    if (!fn) throw new ErrorHttp(404, `Acción desconocida: ${canal}`)
    const archivos = req.body?.archivos
    const c: ContextoWeb = {
      archivos: archivos === 'cancelado' ? 'cancelado' : Array.isArray(archivos) ? archivos.map((t) => {
        const s = subidas.get(String(t))
        if (!s) throw new ErrorHttp(410, 'El archivo que subiste ya venció; vuelve a elegirlo.')
        return s.ruta
      }) : undefined,
      descargas: [],
      abrir: [],
      origen: origenDe(req)
    }
    const args = Array.isArray(req.body?.args) ? req.body.args : []
    try {
      adelantarIds(db)
      const r = await contextoWeb.run(c, () => fn({ web: true }, ...args))
      res.json({ ...(r as object), descargas: registrarDescargas(c), abrir: c.abrir })
    } catch (e) {
      if (e instanceof NecesitaArchivo) return void res.json({ ok: false, necesita_archivo: e.opciones })
      throw e
    }
  })

  // Archivos que el docente elige en el navegador (lo que en la Mac es «Abrir…»): cada uno en su carpeta,
  // con su nombre original, porque la acción usa el nombre (p. ej. como título del material)
  const subir = multer({
    storage: multer.diskStorage({
      destination: (_req, _f, cb) => {
        const dir = join(carpetaTemporal(), 'subidas', randomBytes(12).toString('hex'))
        mkdirSync(dir, { recursive: true })
        cb(null, dir)
      },
      filename: (_req, f, cb) => cb(null, basename(Buffer.from(f.originalname, 'latin1').toString('utf8')).replace(/[/\\]/g, '_') || 'archivo')
    }),
    limits: { fileSize: 300 * 1024 * 1024, files: 30 }
  })
  app.post('/api/docente/app/subir', docente, soloPrincipal, subir.array('archivos', 30), (req, res) => {
    const tokens = ((req.files as Express.Multer.File[]) ?? []).map((f) => {
      const t = randomBytes(18).toString('base64url')
      subidas.set(t, { ruta: f.path, vence: Date.now() + VIDA_MS })
      return t
    })
    res.json({ tokens })
  })

  app.get('/api/docente/app/descarga/:token', (req, res) => {
    const d = descargas.get(String(req.params.token))
    if (!d || d.vence < Date.now() || !existsSync(d.ruta)) throw new ErrorHttp(404, 'Ese enlace ya venció. Vuelve a pedir el archivo.')
    res.setHeader('Cache-Control', 'no-store')
    if (d.modo === 'imprimir') {
      // La página trae su propio script para abrir «Imprimir»; solo ella puede correr aquí
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data: https: 'self'; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'")
      res.type('html').send(readFileSync(d.ruta, 'utf8').replace('<!--DOCENTE-IMPRIMIR-->', ''))
      return
    }
    if (d.modo === 'ver') {
      const tipo = TIPOS[extname(d.ruta).toLowerCase()]
      if (tipo) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'")
        res.type(tipo)
        return void res.sendFile(d.ruta)
      }
    }
    res.download(d.ruta, d.nombre)
  })

  // Avisos en vivo a la página (lo que en la Mac es webContents.send): flujo de eventos con la sesión en la cabecera
  app.get('/api/docente/app/eventos', docente, soloPrincipal, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const mandar = (texto: string): void => {
      res.write(texto)
      ;(res as Response & { flush?: () => void }).flush?.()
    }
    const alAviso = (canal: string, datos: unknown[]): void => mandar(`data: ${JSON.stringify({ canal, datos })}\n\n`)
    avisosWeb.on('aviso', alAviso)
    const latido = setInterval(() => mandar(': latido\n\n'), 25_000)
    mandar(': conectado\n\n')
    req.on('close', () => {
      clearInterval(latido)
      avisosWeb.off('aviso', alAviso)
    })
  })

  // docente://materiales/<nombre> y docente://classroom/<nombre> de la Mac
  app.get('/api/docente/app/archivo/:llave/:donde/:nombre', (req, res) => {
    const dada = Buffer.from(String(req.params.llave))
    const esperada = Buffer.from(llaveArchivos)
    if (dada.length !== esperada.length || !timingSafeEqual(dada, esperada)) throw new ErrorHttp(403, 'No permitido.')
    const nombre = String(req.params.nombre)
    let ruta: string | null = null
    if (req.params.donde === 'materiales') {
      ruta = join(materialesDir(), nombre)
      const r = relative(materialesDir(), ruta)
      if (!r || r.startsWith('..') || isAbsolute(r)) ruta = null
    } else if (req.params.donde === 'classroom') ruta = archivoEnCache(nombre)
    if (!ruta || !existsSync(ruta)) throw new ErrorHttp(404, 'Ese archivo no está en el servidor.')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; frame-ancestors 'self'")
    res.setHeader('Cache-Control', 'private, max-age=3600')
    const tipo = TIPOS[extname(ruta).toLowerCase()]
    if (tipo) res.type(tipo)
    res.sendFile(ruta)
  })

  // ---------- Lo que manda la Mac: llaves y archivos de materiales ----------
  if (op.claveSincro && op.claveSincro.length >= 32) {
    const esperada = createHash('sha256').update(op.claveSincro).digest()
    const deLaMac = (req: Request, _res: Response, next: NextFunction): void => {
      const dada = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!timingSafeEqual(createHash('sha256').update(dada).digest(), esperada)) return next(new ErrorHttp(401, 'Clave de sincronización incorrecta.'))
      next()
    }
    app.post('/api/sincro/app-secretos', deLaMac, express.json(), (req, res) => res.json(recibirSecretos(req.body ?? {})))
    const nombreSeguro = (n: unknown): string => {
      const x = String(n ?? '')
      if (!x || x !== basename(x) || x.startsWith('.') || x.length > 255) throw new ErrorHttp(400, 'Nombre de archivo no válido.')
      return x
    }
    app.get('/api/sincro/app-materiales', deLaMac, (_req, res) => {
      const dir = materialesDir()
      res.json(readdirSync(dir).filter((f) => !f.startsWith('.') && !f.endsWith('.parcial')).map((f) => ({ nombre: f, tamano: statSync(join(dir, f)).size })))
    })
    app.put('/api/sincro/app-material', deLaMac, express.raw({ type: '*/*', limit: '300mb' }), (req, res) => {
      const destino = join(materialesDir(), nombreSeguro(req.query.nombre))
      writeFileSync(`${destino}.parcial`, req.body as Buffer)
      renameSync(`${destino}.parcial`, destino)
      res.json({ ok: true })
    })
    app.get('/api/sincro/app-material', deLaMac, (req, res) => {
      const ruta = join(materialesDir(), nombreSeguro(req.query.nombre))
      if (!existsSync(ruta)) throw new ErrorHttp(404, 'No está.')
      res.sendFile(ruta)
    })
  }

  // ---------- La app compilada ----------
  if (op.carpetaApp && existsSync(op.carpetaApp)) {
    const carpeta = op.carpetaApp
    const csp = (res: Response): void => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' https://www.geogebra.org https://geogebra.org https://www.youtube.com https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      )
    }
    const pagina = (res: Response): void => {
      csp(res)
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(join(carpeta, 'web.html'))
    }
    // La raíz del sitio es la app para el docente y el portal para los alumnos. La sesión vive en el navegador
    // (no en una cookie), así que el portal deja la pista `docente_app=1` al entrar un docente. Es solo para elegir
    // la página: los datos los sigue cuidando el token, y la app regresa al portal a quien no sea docente.
    app.get('/', (req, res, next) => {
      res.setHeader('Vary', 'Cookie')
      if (!/(?:^|;\s*)docente_app=1(?:;|$)/.test(req.headers.cookie ?? '')) return next()
      pagina(res)
    })
    app.use('/app', (req, res, next) => {
      csp(res)
      next()
    }, express.static(carpeta, { index: false, maxAge: '30d', immutable: true }))
    // La dirección vieja (/app) lleva a la raíz; el navegador conserva la pantalla (#…)
    app.get(/^\/app(\/.*)?$/, (req, res) => {
      if (/^\/app\/assets\//.test(req.path)) return void res.status(404).end()
      res.redirect(302, '/')
    })
  }
}
