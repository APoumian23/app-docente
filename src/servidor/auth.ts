import type Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { Rol, Usuario, SesionWeb } from '../shared/portal'
import { leerAjuste, escribirAjuste } from './base'
import { problemaPassword } from '../shared/password'

const DURACION_SESION = '12h'
/** «Recordarme en este dispositivo»: el celular propio no pide entrar cada día */
const DURACION_RECORDADA = '30d'
const RONDAS_HASH = 10

export interface Contexto {
  db: Database.Database
  secreto: string
}

/** El secreto para firmar sesiones se genera una vez y se guarda en la base. */
export function obtenerSecreto(db: Database.Database): string {
  const env = process.env.PORTAL_SECRETO
  if (env) return env
  let s = leerAjuste(db, 'portal_secreto')
  if (!s) {
    s = randomBytes(32).toString('hex')
    escribirAjuste(db, 'portal_secreto', s)
  }
  return s
}

export const hashPassword = (p: string): string => bcrypt.hashSync(p, RONDAS_HASH)
export const verificarPassword = (p: string, hash: string): boolean => bcrypt.compareSync(p, hash)
// Asíncrona en el login: la versión síncrona bloquea ~60 ms el servidor (y la app) por cada intento
const verificarPasswordAsync = (p: string, hash: string): Promise<boolean> => bcrypt.compare(p, hash)
/** Para comparar aunque el usuario no exista y no revelar con el tiempo de respuesta cuáles existen. */
const HASH_FALSO = bcrypt.hashSync('usuario-inexistente', RONDAS_HASH)

// ---------- Límite de intentos de inicio de sesión ----------
const FALLOS_ANTES_DE_ESPERAR = 5
const ESPERA_MAX_MS = 15 * 60_000
const FALLOS_POR_DISPOSITIVO = 30
const VENTANA_DISPOSITIVO_MS = 15 * 60_000
type Registro = { fallos: number; hasta: number; desde: number }
const fallosCuenta = new Map<string, Registro>()
const fallosDispositivo = new Map<string, Registro>()

/**
 * La cuenta se limita por usuario Y dispositivo: así nadie puede adivinar la contraseña de otro,
 * pero tampoco bloquearle la cuenta desde su propio celular. Detrás de un proxy (VPS) todas las
 * peticiones llegan como 127.0.0.1; ahí no se aplica el límite por dispositivo para no castigar a todo el grupo.
 */
function claveCuenta(usuario: string, ip: string): string {
  return `${usuario.trim().toLowerCase()}|${ip}`
}
const esLocal = (ip: string): boolean => ip === '' || ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1'

function revisarBloqueo(usuario: string, ip: string): void {
  const ahora = Date.now()
  const c = fallosCuenta.get(claveCuenta(usuario, ip))
  if (c && c.hasta > ahora) throw new ErrorHttp(429, `Demasiados intentos. Espera ${Math.ceil((c.hasta - ahora) / 60_000)} min y vuelve a intentarlo.`)
  const d = fallosDispositivo.get(ip)
  if (d && d.hasta > ahora) throw new ErrorHttp(429, 'Demasiados intentos desde este dispositivo. Espera unos minutos.')
}

function registrarFallo(usuario: string, ip: string): void {
  const ahora = Date.now()
  const k = claveCuenta(usuario, ip)
  const c = fallosCuenta.get(k) ?? { fallos: 0, hasta: 0, desde: ahora }
  c.fallos++
  // 5 fallos → 1 min; cada fallo extra duplica la espera, hasta 15 min
  if (c.fallos >= FALLOS_ANTES_DE_ESPERAR) c.hasta = ahora + Math.min(ESPERA_MAX_MS, 60_000 * 2 ** (c.fallos - FALLOS_ANTES_DE_ESPERAR))
  fallosCuenta.set(k, c)
  if (esLocal(ip)) return
  const d = fallosDispositivo.get(ip)
  const vigente = d && ahora - d.desde < VENTANA_DISPOSITIVO_MS ? d : { fallos: 0, hasta: 0, desde: ahora }
  vigente.fallos++
  if (vigente.fallos >= FALLOS_POR_DISPOSITIVO) vigente.hasta = ahora + VENTANA_DISPOSITIVO_MS
  fallosDispositivo.set(ip, vigente)
}

/** Solo para pruebas: olvida los fallos registrados. */
export function reiniciarLimiteLogin(): void {
  fallosCuenta.clear()
  fallosDispositivo.clear()
}
const huella = (token: string): string => createHash('sha256').update(token).digest('hex')

const COLUMNAS_USUARIO = 'id, rol, nombre, usuario, email, alumno_id, debe_cambiar, activo'

export function buscarUsuarioPorNombre(db: Database.Database, usuario: string): (Usuario & { hash: string }) | undefined {
  return db.prepare(`SELECT ${COLUMNAS_USUARIO}, hash FROM usuarios WHERE usuario = ? COLLATE NOCASE`).get(usuario.trim()) as (Usuario & { hash: string }) | undefined
}

export function obtenerUsuario(db: Database.Database, id: number): Usuario | undefined {
  return db.prepare(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`).get(id) as Usuario | undefined
}

/**
 * Inicia sesión. Solo puede haber una sesión activa por usuario: las anteriores se cierran,
 * y el otro dispositivo recibirá "sesión reemplazada" en su siguiente petición.
 */
export async function iniciarSesion(ctx: Contexto, usuario: string, password: string, dispositivo: string, ip: string, recordar = false): Promise<{ sesion: SesionWeb; reemplazo: boolean }> {
  revisarBloqueo(usuario, ip)
  const u = buscarUsuarioPorNombre(ctx.db, usuario)
  const valida = await verificarPasswordAsync(password, u?.hash ?? HASH_FALSO)
  if (!u || !u.activo || !valida) {
    registrarFallo(usuario, ip)
    throw new ErrorHttp(401, 'Usuario o contraseña incorrectos.')
  }
  fallosCuenta.delete(claveCuenta(usuario, ip))
  // Una contraseña de antes de la regla segura (o débil) se cambia al entrar: es el único momento en que se conoce
  if (!u.debe_cambiar && problemaPassword(password)) {
    ctx.db.prepare('UPDATE usuarios SET debe_cambiar = 1 WHERE id = ?').run(u.id)
    u.debe_cambiar = 1
  }
  // Un alumno, una sesión (que nadie conteste por él desde otro equipo). El docente puede tener varias: la app
  // completa en la computadora y el portal en el celular a la vez
  const previas = u.rol === 'alumno' ? ctx.db.prepare('UPDATE sesiones_web SET activa = 0 WHERE usuario_id = ? AND activa = 1').run(u.id).changes : 0
  const { hash: _h, ...publico } = u
  return { sesion: abrirSesion(ctx, publico, dispositivo, ip, recordar), reemplazo: previas > 0 }
}

/** Registra la sesión y firma su token. No cierra las demás: eso lo decide quien la llama. */
function abrirSesion(ctx: Contexto, u: Usuario, dispositivo: string, ip: string, recordar = false, desdeApp = false): SesionWeb {
  const token = randomBytes(24).toString('hex')
  const sid = Number(
    ctx.db.prepare('INSERT INTO sesiones_web (usuario_id, token_hash, dispositivo, ip) VALUES (?, ?, ?, ?)').run(u.id, huella(token), dispositivo.slice(0, 200), ip).lastInsertRowid
  )
  const jwtToken = jwt.sign({ uid: u.id, sid, rol: u.rol, t: huella(token), ...(desdeApp ? { app: 1 } : {}) }, ctx.secreto, { expiresIn: recordar ? DURACION_RECORDADA : DURACION_SESION })
  const expira = new Date(Date.now() + (recordar ? 30 * 24 : 12) * 3600 * 1000).toISOString()
  return { token: jwtToken, usuario: desdeApp ? { ...u, desde_app: true } : u, expira }
}

// ---------- Código de acceso de la app de escritorio ----------
const VIDA_CODIGO_SEG = 60

/**
 * La app de escritorio abre el panel web con un código de un solo uso que caduca en 60 s,
 * no con la sesión: así lo que queda en el historial del navegador ya no sirve para nada.
 */
export function crearCodigoAcceso(db: Database.Database, usuarioId: number): string {
  db.prepare("DELETE FROM codigos_acceso WHERE expira < datetime('now')").run()
  const codigo = randomBytes(24).toString('hex')
  db.prepare(`INSERT INTO codigos_acceso (huella, usuario_id, expira) VALUES (?, ?, datetime('now', '+${VIDA_CODIGO_SEG} seconds'))`).run(huella(codigo), usuarioId)
  return codigo
}

/** Canjea el código por una sesión normal. Se borra al leerlo (un solo uso) y no cierra las otras sesiones del docente. */
export function canjearCodigo(ctx: Contexto, codigo: string, dispositivo: string, ip: string): SesionWeb {
  const f = ctx.db.prepare("DELETE FROM codigos_acceso WHERE huella = ? RETURNING usuario_id, expira >= datetime('now') AS vigente").get(huella(codigo)) as
    | { usuario_id: number; vigente: number }
    | undefined
  const u = f?.vigente ? obtenerUsuario(ctx.db, f.usuario_id) : undefined
  if (!u || !u.activo) throw new ErrorHttp(401, 'El enlace de acceso ya se usó o expiró. Ábrelo otra vez desde la app.', 'codigo_invalido')
  // La app de escritorio ya es de confianza (tiene la clave de sincronización): desde ella no se pide la contraseña actual
  return abrirSesion(ctx, u, dispositivo, ip, false, true)
}

export function cerrarSesion(db: Database.Database, sid: number): void {
  db.prepare('UPDATE sesiones_web SET activa = 0 WHERE id = ?').run(sid)
}

export function cambiarPassword(db: Database.Database, usuarioId: number, actual: string, nueva: string, sinActual = false): void {
  const u = db.prepare('SELECT hash, debe_cambiar FROM usuarios WHERE id = ?').get(usuarioId) as { hash: string; debe_cambiar: number } | undefined
  if (!u) throw new ErrorHttp(400, 'La contraseña actual no es correcta.')
  // Con la contraseña inicial (debe cambiarla) acaba de entrar con ella: no se le vuelve a pedir. Así el navegador
  // no la estropea rellenando ese campo con otra contraseña guardada
  // Desde la app de escritorio tampoco: es la manera de poner una nueva si se olvidó la actual
  if (!u.debe_cambiar && !sinActual && !verificarPassword(actual, u.hash)) throw new ErrorHttp(400, 'La contraseña actual no es correcta.')
  const problema = problemaPassword(nueva)
  if (problema) throw new ErrorHttp(400, problema)
  if (nueva === actual) throw new ErrorHttp(400, 'La nueva contraseña debe ser distinta de la actual.')
  // La contraseña inicial es la matrícula: si se queda igual, cualquiera que la conozca entra
  const datos = db.prepare('SELECT u.usuario, a.matricula FROM usuarios u LEFT JOIN alumnos a ON a.id = u.alumno_id WHERE u.id = ?').get(usuarioId) as { usuario: string; matricula: string | null }
  const prohibidas = [datos.usuario, datos.matricula].filter(Boolean).map((t) => String(t).trim().toLowerCase())
  if (prohibidas.includes(nueva.trim().toLowerCase())) throw new ErrorHttp(400, 'La nueva contraseña no puede ser tu matrícula ni tu usuario.')
  db.prepare('UPDATE usuarios SET hash = ?, debe_cambiar = 0 WHERE id = ?').run(hashPassword(nueva), usuarioId)
}

export class ErrorHttp extends Error {
  constructor(
    public estado: number,
    mensaje: string,
    public codigo?: string
  ) {
    super(mensaje)
  }
}

export interface PeticionAutenticada extends Request {
  usuario: Usuario
  sesionId: number
  /** La sesión la abrió la app de escritorio con su código (firmado en el token, no se puede inventar) */
  desdeApp: boolean
}

/**
 * Por qué se cerró una sesión, para decírselo bien a quien la tenía abierta (NULL = la reemplazó otro inicio).
 * La columna se agrega aquí y no en `migrar` porque la usan tanto la app como el servidor; se revisa una vez por base.
 */
const basesConMotivo = new WeakSet<Database.Database>()
function asegurarMotivoCierre(db: Database.Database): void {
  if (basesConMotivo.has(db)) return
  const columnas = db.prepare('PRAGMA table_info(sesiones_web)').all() as { name: string }[]
  if (!columnas.some((c) => c.name === 'motivo_cierre')) {
    try {
      db.exec('ALTER TABLE sesiones_web ADD COLUMN motivo_cierre TEXT')
    } catch {
      // El otro proceso (app o servidor) pudo agregarla al mismo tiempo
    }
  }
  basesConMotivo.add(db)
}

const RUTAS_CON_CONTRASENA_INICIAL = new Set(['/api/auth/password', '/api/auth/yo', '/api/auth/logout'])

/**
 * Middleware: exige un token válido con sesión activa y, si se indica, un rol.
 * Solo por la cabecera Authorization: un token en la dirección se queda en el historial y en los registros.
 */
export function requerir(ctx: Contexto, rol?: Rol) {
  asegurarMotivoCierre(ctx.db)
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cabecera = req.headers.authorization ?? ''
    const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : undefined
    if (!token) return next(new ErrorHttp(401, 'Inicia sesión para continuar.', 'sin_sesion'))
    let carga: { uid: number; sid: number; rol: Rol; t: string; app?: number }
    try {
      carga = jwt.verify(token, ctx.secreto) as typeof carga
    } catch {
      return next(new ErrorHttp(401, 'Tu sesión expiró. Vuelve a iniciar sesión.', 'expirada'))
    }
    const sesion = ctx.db.prepare('SELECT id, activa, token_hash, motivo_cierre FROM sesiones_web WHERE id = ?').get(carga.sid) as
      | { id: number; activa: number; token_hash: string; motivo_cierre: string | null }
      | undefined
    if (!sesion || sesion.token_hash !== carga.t) return next(new ErrorHttp(401, 'Sesión no válida.', 'sin_sesion'))
    if (!sesion.activa) {
      // Si el docente reinició la contraseña no es que alguien más haya entrado: se dice tal cual
      if (sesion.motivo_cierre === 'password_reiniciada') return next(new ErrorHttp(401, 'Tu docente reinició tu contraseña. Entra de nuevo con tu matrícula.', 'password_reiniciada'))
      return next(new ErrorHttp(401, 'Tu cuenta se abrió en otro dispositivo. Esta sesión se cerró.', 'sesion_reemplazada'))
    }
    const usuario = obtenerUsuario(ctx.db, carga.uid)
    if (!usuario || !usuario.activo) return next(new ErrorHttp(401, 'Usuario no disponible.', 'sin_sesion'))
    if (rol && usuario.rol !== rol) return next(new ErrorHttp(403, 'No tienes permiso para esto.'))
    // Con la contraseña inicial (la matrícula) solo se permite cambiarla: lo exige el servidor, no solo la pantalla
    if (usuario.debe_cambiar && !RUTAS_CON_CONTRASENA_INICIAL.has(req.originalUrl.split('?')[0])) {
      return next(new ErrorHttp(403, 'Primero cambia tu contraseña inicial.', 'debe_cambiar'))
    }
    ctx.db.prepare("UPDATE sesiones_web SET ultimo_uso = datetime('now') WHERE id = ?").run(sesion.id)
    ;(req as PeticionAutenticada).usuario = usuario
    ;(req as PeticionAutenticada).sesionId = sesion.id
    ;(req as PeticionAutenticada).desdeApp = carga.app === 1
    next()
  }
}

/** Verifica un token fuera de Express (WebSocket). Devuelve el usuario o null. */
export function usuarioDeToken(ctx: Contexto, token: string | undefined): Usuario | null {
  if (!token) return null
  try {
    const carga = jwt.verify(token, ctx.secreto) as { uid: number; sid: number; t: string }
    const sesion = ctx.db.prepare('SELECT activa, token_hash FROM sesiones_web WHERE id = ?').get(carga.sid) as { activa: number; token_hash: string } | undefined
    if (!sesion || !sesion.activa || sesion.token_hash !== carga.t) return null
    return obtenerUsuario(ctx.db, carga.uid) ?? null
  } catch {
    return null
  }
}

/** Crea o actualiza el usuario del docente. Devuelve su id. */
export function asegurarDocente(db: Database.Database, nombre: string, usuario: string, password: string, email = ''): number {
  const existente = buscarUsuarioPorNombre(db, usuario)
  if (existente) {
    db.prepare('UPDATE usuarios SET nombre = ?, hash = ?, email = ?, activo = 1, debe_cambiar = 0 WHERE id = ?').run(nombre, hashPassword(password), email, existente.id)
    return existente.id
  }
  return Number(db.prepare("INSERT INTO usuarios (rol, nombre, usuario, email, hash, debe_cambiar) VALUES ('docente', ?, ?, ?, ?, 0)").run(nombre, usuario.trim(), email, hashPassword(password)).lastInsertRowid)
}

/**
 * Crea accesos para los alumnos inscritos en una materia que aún no tienen usuario.
 * Usuario = matrícula; contraseña inicial = matrícula, que deben cambiar al entrar.
 */
/** Contraseña inicial legible (sin caracteres confusos) para alumnos sin matrícula. */
function passwordAleatoria(): string {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from(randomBytes(8), (b) => alfabeto[b % alfabeto.length]).join('')
}

/** Usuario a partir del nombre (juan.perez, juan.perez2…) cuando el alumno no tiene matrícula. */
function usuarioDesdeNombre(db: Database.Database, nombre: string, apellidos: string): string {
  const limpio = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const base = [limpio(nombre.split(' ')[0]), limpio(apellidos.split(' ')[0])].filter(Boolean).join('.') || 'alumno'
  const existe = db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?')
  let candidato = base
  for (let n = 2; existe.get(candidato); n++) candidato = `${base}${n}`
  return candidato
}

/** Contraseña inicial: la matrícula si la hay; si no, una aleatoria que el docente entrega al alumno. */
function passwordInicial(matricula: string): string {
  return matricula || passwordAleatoria()
}

export interface AccesoCreado {
  matricula: string
  nombre: string
  usuario: string
  password: string
}

/** Crea la cuenta del portal de un alumno; si ya la tiene devuelve null. */
export function crearAccesoAlumno(db: Database.Database, alumnoId: number): AccesoCreado | null {
  const a = db.prepare('SELECT id, matricula, nombre, apellidos, email FROM alumnos WHERE id = ?').get(alumnoId) as { id: number; matricula: string; nombre: string; apellidos: string; email: string } | undefined
  if (!a) throw new ErrorHttp(404, 'Alumno no encontrado.')
  if (db.prepare('SELECT id FROM usuarios WHERE alumno_id = ?').get(a.id)) return null
  const password = passwordInicial(a.matricula)
  const usuario = a.matricula || usuarioDesdeNombre(db, a.nombre, a.apellidos)
  db.prepare("INSERT INTO usuarios (rol, nombre, usuario, email, hash, alumno_id, debe_cambiar) VALUES ('alumno', ?, ?, ?, ?, ?, 1)").run(`${a.nombre} ${a.apellidos}`.trim(), usuario, a.email, hashPassword(password), a.id)
  return { matricula: a.matricula, nombre: `${a.apellidos} ${a.nombre}`.trim(), usuario, password }
}

export function crearAccesosAlumnos(db: Database.Database, materiaId: number): { creados: AccesoCreado[]; existentes: number } {
  const alumnos = db
    .prepare('SELECT a.id, a.matricula, a.nombre, a.apellidos, a.email FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id WHERE i.materia_id = ? AND a.activo = 1')
    .all(materiaId) as { id: number; matricula: string; nombre: string; apellidos: string; email: string }[]
  const creados: AccesoCreado[] = []
  let existentes = 0
  const tx = db.transaction(() => {
    for (const a of alumnos) {
      const c = crearAccesoAlumno(db, a.id)
      if (c) creados.push(c)
      else existentes++
    }
  })
  tx()
  return { creados, existentes }
}

/** Reinicia la contraseña de un alumno (su matrícula, o una aleatoria si no tiene) y le pide cambiarla. */
export function reiniciarPasswordAlumno(db: Database.Database, alumnoId: number): string {
  const a = db.prepare('SELECT matricula FROM alumnos WHERE id = ?').get(alumnoId) as { matricula: string } | undefined
  if (!a) throw new ErrorHttp(404, 'Alumno no encontrado.')
  const password = passwordInicial(a.matricula)
  db.prepare('UPDATE usuarios SET hash = ?, debe_cambiar = 1 WHERE alumno_id = ?').run(hashPassword(password), alumnoId)
  asegurarMotivoCierre(db)
  db.prepare("UPDATE sesiones_web SET activa = 0, motivo_cierre = 'password_reiniciada' WHERE activa = 1 AND usuario_id IN (SELECT id FROM usuarios WHERE alumno_id = ?)").run(alumnoId)
  return password
}
