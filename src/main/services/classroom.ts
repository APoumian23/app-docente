/**
 * Google Classroom en solo lectura: conexión de la cuenta del maestro, sincronización y
 * vista previa / descarga de lo que entregaron los alumnos. Los secretos se guardan cifrados
 * con el llavero de macOS (safeStorage), igual que las API keys de la IA.
 */
import { app, dialog, safeStorage, shell, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { basename, join, extname, relative, isAbsolute } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dataDir, getDb, getAjuste, setAjuste } from '../db'
import { abrirFuera } from '../abrir'
import { conversorDisponible, convertirAPdf } from './presentacion'
import * as G from './classroom-api'
import * as D from './classroom-datos'
import * as T from './classroom-consolidar'
import { libroEntregas } from './classroom-excel'
import { revisarEntregas, type AlumnoDelGrupo, type Entregado } from './metadatos'
import type { InformeCopias } from '@shared/copias'
import { nombreCorto } from '@shared/copias'

/** Cómo se ve cada permiso en la pantalla de Google, para decir cuál quedó sin marcar */
const NOMBRE_PERMISO: Record<string, string> = {
  'https://www.googleapis.com/auth/classroom.courses.readonly': 'Ver tus clases de Google Classroom',
  'https://www.googleapis.com/auth/classroom.rosters.readonly': 'Ver las listas de tus clases',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly': 'Ver el trabajo en clase y las calificaciones de los alumnos',
  'https://www.googleapis.com/auth/classroom.profile.emails': 'Ver las direcciones de correo de los alumnos'
}
import type { ArchivoAdjuntado, DetalleEntrega, EstadoConexion, ResultadoSync, ResumenClassroom, Vista, CursoClassroom, ReglaCalificacion } from '@shared/classroom'

// ---------- Secretos cifrados ----------

const K = {
  clientId: 'classroom_client_id',
  secret: 'classroom_secret_enc',
  refresh: 'classroom_refresh_enc',
  cifrado: 'classroom_cifrado',
  cuenta: 'classroom_cuenta',
  scopes: 'classroom_scopes',
  ultima: 'classroom_ultima_sync'
}

/** Valores ya descifrados: sin esto macOS pediría el llavero en cada petición. */
const cache = new Map<string, string>()
let llaveroNego = false
const LLAVERO_NEGO = 'macOS no autorizó leer los datos de Google guardados en el llavero. Cierra y abre la app y, cuando lo pida, escribe la contraseña de tu Mac y elige «Siempre permitir». Si no, vuelve a conectar.'

function guardarSecreto(clave: string, valor: string): void {
  cache.delete(clave)
  if (!valor) return setAjuste(clave, '')
  const cifra = safeStorage.isEncryptionAvailable()
  setAjuste(clave, cifra ? safeStorage.encryptString(valor).toString('base64') : Buffer.from(valor).toString('base64'))
  setAjuste(K.cifrado, cifra ? '1' : '0')
  cache.set(clave, valor)
}

function leerSecreto(clave: string): string {
  const enCache = cache.get(clave)
  if (enCache !== undefined) return enCache
  const enc = getAjuste(clave)
  if (!enc) return ''
  const buf = Buffer.from(enc, 'base64')
  try {
    const v = getAjuste(K.cifrado) === '1' ? safeStorage.decryptString(buf) : buf.toString('utf8')
    cache.set(clave, v)
    llaveroNego = false
    return v
  } catch {
    llaveroNego = true
    return ''
  }
}

// ---------- Conexión ----------

let acceso: { token: string; expira: number } | null = null

function credenciales(): { clientId: string; clientSecret: string } {
  const clientId = getAjuste(K.clientId)
  const clientSecret = leerSecreto(K.secret)
  if (!clientId || !clientSecret) throw new Error(llaveroNego ? LLAVERO_NEGO : 'Faltan el Client ID y el Client Secret de Google. Pégalos en Ajustes › Google Classroom.')
  return { clientId, clientSecret }
}

/**
 * La conexión con Google tal cual, para llevarla al portal en línea (la versión web la usa sin volver a
 * conectar). Vacía si no hay conexión o el llavero no deja leerla.
 */
export function conexionParaPortal(): { client_id: string; secret: string; refresh: string } | null {
  const refresh = leerSecreto(K.refresh)
  const secret = leerSecreto(K.secret)
  const client_id = getAjuste(K.clientId)
  return refresh && secret && client_id ? { client_id, secret, refresh } : null
}

/** En el servidor: guarda la conexión que mandó la Mac, cifrada con la llave del servidor. */
export function importarConexion(c: { client_id: string; secret: string; refresh: string }): void {
  setAjuste(K.clientId, c.client_id)
  guardarSecreto(K.secret, c.secret)
  guardarSecreto(K.refresh, c.refresh)
  acceso = null
}

/** Token de acceso vigente; se refresca solo cuando vence o cuando Google lo rechaza. */
const token: G.ObtenerToken = async (forzar = false) => {
  if (acceso && !forzar && Date.now() < acceso.expira) return acceso.token
  const refresh = leerSecreto(K.refresh)
  if (!refresh) throw new Error(llaveroNego ? LLAVERO_NEGO : 'Google Classroom no está conectado. Ve a Ajustes › Google Classroom y pulsa Conectar.')
  const { clientId, clientSecret } = credenciales()
  try {
    const t = await G.refrescar(clientId, clientSecret, refresh)
    acceso = { token: t.access_token, expira: t.expira }
    // Google a veces rota el refresh token
    if (t.refresh_token && t.refresh_token !== refresh) guardarSecreto(K.refresh, t.refresh_token)
    return t.access_token
  } catch (e) {
    // Revocado o caducado: se borra para que la pantalla pida reconectar
    if (/ya no acepta el permiso/.test((e as Error).message)) {
      guardarSecreto(K.refresh, '')
      acceso = null
    }
    throw e
  }
}

export function estado(): EstadoConexion {
  const conectado = !!getAjuste(K.refresh)
  return {
    client_id: getAjuste(K.clientId),
    credenciales: !!getAjuste(K.clientId) && !!getAjuste(K.secret),
    conectado,
    cuenta: conectado ? getAjuste(K.cuenta) : '',
    drive: conectado && getAjuste(K.scopes).includes(G.SCOPE_DRIVE),
    escritura: conectado && getAjuste(K.scopes).split(' ').includes(G.SCOPE_ESCRITURA),
    subir: conectado && getAjuste(K.scopes).split(' ').includes(G.SCOPE_SUBIR),
    ultima_sync: getAjuste(K.ultima) || null,
    cuenta_esperada: G.CUENTA_MAESTRO
  }
}

export function guardarCredenciales(clientId: string, clientSecret: string): EstadoConexion {
  const id = clientId.trim()
  const secreto = clientSecret.trim()
  G.validarClientId(id)
  if (!secreto && !getAjuste(K.secret)) throw new Error('Pega también el Client Secret (en Google Cloud aparece junto al Client ID).')
  // Otro cliente invalida el permiso anterior
  if (id !== getAjuste(K.clientId)) {
    guardarSecreto(K.refresh, '')
    acceso = null
  }
  setAjuste(K.clientId, id)
  if (secreto) guardarSecreto(K.secret, secreto)
  return estado()
}

export async function conectar(): Promise<EstadoConexion> {
  const { clientId, clientSecret } = credenciales()
  const t = await G.iniciarSesion({ clientId, clientSecret, abrir: abrirFuera })
  let recibidos = t.scope.split(' ').filter(Boolean)
  let faltan = G.permisosQueFaltan(G.SCOPES_CLASSROOM, recibidos)
  // La respuesta a veces no enumera todo: se confirma con Google antes de dar por faltante un permiso
  if (faltan.length) {
    const confirmados = await G.permisosDelToken(t.access_token)
    if (confirmados.length) {
      recibidos = [...new Set([...recibidos, ...confirmados])]
      faltan = G.permisosQueFaltan(G.SCOPES_CLASSROOM, recibidos)
    }
  }
  if (faltan.length) {
    await G.revocar(t.access_token)
    // Queda anotado lo que Google sí dio, para revisar el caso sin adivinar
    try {
      writeFileSync(join(dataDir(), 'classroom-permisos.log'), `${new Date().toISOString()}\npedidos: ${G.SCOPES.join(' ')}\nrecibidos: ${recibidos.join(' ')}\n`)
    } catch {
      /* sin registro */
    }
    const nombres = faltan.map((s) => `«${NOMBRE_PERMISO[s] ?? s}»`).join(', ')
    throw new Error(
      `Google no dio ${faltan.length === 1 ? 'este permiso' : 'estos permisos'}: ${nombres}. Pulsa Conectar otra vez y, en la pantalla de Google, marca «Seleccionar todo» (o cada casilla) antes de Continuar. Si los marcaste y sigue pasando, la universidad puede tener bloqueado ese permiso para apps externas: pídeselo a sistemas.`
    )
  }
  t.scope = recibidos.join(' ')
  if (!t.refresh_token) throw new Error('Google no entregó un permiso permanente. Quita el acceso de «App_Docente» en myaccount.google.com › Seguridad › Apps de terceros y vuelve a conectar.')
  acceso = { token: t.access_token, expira: t.expira }
  guardarSecreto(K.refresh, t.refresh_token)
  setAjuste(K.scopes, t.scope)
  const perfil = await G.leerPerfil(token)
  setAjuste(K.cuenta, (perfil.emailAddress ?? '').toLowerCase())
  return estado()
}

export async function desconectar(): Promise<EstadoConexion> {
  const refresh = leerSecreto(K.refresh)
  if (refresh) await G.revocar(refresh)
  guardarSecreto(K.refresh, '')
  setAjuste(K.cuenta, '')
  setAjuste(K.scopes, '')
  acceso = null
  return estado()
}

// ---------- Sincronización ----------

let sincronizando: Promise<ResultadoSync> | null = null

/** Lee los cursos activos y, de los ligados a una materia, alumnos, tareas y entregas. */
export function sincronizar(): Promise<ResultadoSync> {
  // Dos clics seguidos comparten la misma sincronización
  sincronizando ??= (async () => {
    const db = getDb()
    const cursos = await G.leerCursos(token)
    D.guardarCursos(db, cursos)
    // Los cursos de la app (materias sin Classroom) no se piden a Google
    const ligados = D.listarCursos(db).filter((c) => c.activo && c.materia_id && !D.esCursoApp(c.id))
    let alumnos = 0
    let tareas = 0
    let entregas = 0
    for (const c of ligados) {
      const [a, t, e] = await Promise.all([G.leerAlumnos(token, c.id), G.leerTareas(token, c.id), G.leerEntregas(token, c.id)])
      D.guardarCurso(db, c.id, a, t, e)
      alumnos += a.length
      tareas += t.length
      entregas += e.length
    }
    let sinLigar = 0
    for (const m of new Set(ligados.map((c) => c.materia_id!))) {
      D.empatarMateria(db, m)
      sinLigar += D.resumenMateria(db, m).sin_ligar.classroom.length
    }
    const sincronizado = new Date().toISOString()
    setAjuste(K.ultima, sincronizado)
    return { cursos: cursos.length, ligados: ligados.length, alumnos, tareas, entregas, sin_ligar: sinLigar, sincronizado }
  })().finally(() => {
    sincronizando = null
  })
  return sincronizando
}

export const cursos = (): CursoClassroom[] => D.listarCursos(getDb())
export const ligarCurso = (cursoId: string, materiaId: number | null): void => D.ligarCurso(getDb(), cursoId, materiaId)
export const ligarAlumno = (cursoId: string, userId: string, destino: number | 'ajeno' | null): void => D.ligarAlumno(getDb(), cursoId, userId, destino)
export function resumen(materiaId: number): ResumenClassroom {
  // Alumnos inscritos después de crear las tareas también deben tener su entrega
  D.asegurarCursoApp(getDb(), materiaId)
  return D.resumenMateria(getDb(), materiaId)
}

/** Activa las tareas de la app en una materia que no usa Classroom. */
export const activarTareasApp = (materiaId: number): string => D.crearCursoApp(getDb(), materiaId)
export const entrega = (cursoId: string, entregaId: string): DetalleEntrega => D.detalleEntrega(getDb(), cursoId, entregaId)
export const marcarEntregaFuera = (cursoId: string, entregaId: string, recibida: boolean): void => D.marcarEntregaFuera(getDb(), cursoId, entregaId, recibida)
export const calificarEnApp = (cursoId: string, entregaId: string, calificacion: number | null): void => D.calificarEnApp(getDb(), cursoId, entregaId, calificacion)

// ---------- Tareas de la app (agrupan duplicados) ----------

export const crearTareaApp = (materiaId: number, nombre: string, claves: string[]): number => T.crearTareaApp(getDb(), materiaId, nombre, claves)
export const actualizarTareaApp = (id: number, cambios: { nombre?: string; regla?: ReglaCalificacion }): void => T.actualizarTareaApp(getDb(), id, cambios)
export const eliminarTareaApp = (id: number): void => T.eliminarTareaApp(getDb(), id)
export const asignarTarea = (clave: string, tareaAppId: number | null): void => T.asignarTarea(getDb(), clave, tareaAppId)
export const marcarComodin = (clave: string, comodin: boolean, cubre: number[]): void => T.marcarComodin(getDb(), clave, comodin, cubre)
export const decidirComodin = (clave: string, userId: string, destino: number | 'ninguna' | 'auto'): void => T.decidirComodin(getDb(), clave, userId, destino)
export function aceptarSugerencias(materiaId: number): number {
  const db = getDb()
  return T.aceptarSugerencias(db, materiaId, D.resumenMateria(db, materiaId).consolidado.sugerencias)
}

/** Excel con la consolidación (como la hoja «Entregas Classroom» que el maestro hacía a mano). */
export async function exportarExcel(materiaId: number): Promise<string | null> {
  const db = getDb()
  const m = db.prepare('SELECT nombre FROM materias WHERE id = ?').get(materiaId) as { nombre: string } | undefined
  if (!m) throw new Error('La materia ya no existe.')
  const opciones = { title: 'Exportar entregas de Classroom', defaultPath: join(app.getPath('downloads'), nombreSeguro(`${m.nombre} - Entregas Classroom.xlsx`)), filters: [{ name: 'Excel', extensions: ['xlsx'] }] }
  const w = ventana()
  const r = w ? await dialog.showSaveDialog(w, opciones) : await dialog.showSaveDialog(opciones)
  if (r.canceled || !r.filePath) return null
  await libroEntregas(D.resumenMateria(db, materiaId), m.nombre).xlsx.writeFile(r.filePath)
  shell.showItemInFolder(r.filePath)
  return r.filePath
}

// ---------- Archivos entregados: caché, vista previa y descarga ----------

/** Fuera de «datos»: es temporal, no entra al respaldo y se borra al cerrar la app. */
export function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'cache-classroom')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Para el protocolo docente://classroom/<nombre>: la ruta solo si queda dentro de la caché. */
export function archivoEnCache(nombre: string): string | null {
  const ruta = join(cacheDir(), nombre)
  const r = relative(cacheDir(), ruta)
  if (!r || r.startsWith('..') || isAbsolute(r) || !existsSync(ruta)) return null
  return ruta
}

/** Lo bajado hace poco se reutiliza; pasado ese tiempo se vuelve a pedir (el alumno pudo cambiarlo). */
function reciente(archivo: string): string | null {
  const ruta = archivoEnCache(archivo)
  return ruta && Date.now() - statSync(ruta).mtimeMs < 10 * 60_000 ? ruta : null
}

const DIAS_CACHE = 3
export function limpiarCache(todo = false): void {
  const dir = join(app.getPath('userData'), 'cache-classroom')
  if (!existsSync(dir)) return
  if (todo) return rmSync(dir, { recursive: true, force: true })
  const limite = Date.now() - DIAS_CACHE * 86_400_000
  for (const f of readdirSync(dir)) {
    const ruta = join(dir, f)
    try {
      if (statSync(ruta).mtimeMs < limite) rmSync(ruta, { recursive: true, force: true })
    } catch {
      /* ya no existe */
    }
  }
}

const GOOGLE_PDF: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.spreadsheet': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf'
}
/** Al descargar, los archivos de Google se bajan en formato de Office (más útil que PDF para revisar). */
const GOOGLE_OFFICE: Record<string, [string, string]> = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.drawing': ['application/pdf', '.pdf']
}
const IMAGENES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'])
const OFFICE = new Set(['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp', '.key', '.xls', '.xlsx', '.ods'])
const PRESENTACIONES = new Set(['.ppt', '.pptx', '.key'])
const TEXTO = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yml', '.yaml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.kt', '.swift', '.m', '.r', '.sh', '.ipynb'])
const MAX_VISTA = 200 * 1024 * 1024
const MAX_TEXTO = 300 * 1024

const nombreSeguro = (s: string): string => s.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150) || 'archivo'
const idSeguro = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '')

function extensionDe(nombre: string, mime: string): string {
  const e = extname(nombre).toLowerCase()
  if (e) return e
  const porMime: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'text/plain': '.txt' }
  return porMime[mime] ?? ''
}

/** Baja a la caché (o reutiliza lo bajado hoy) y devuelve cómo mostrarlo dentro de la app. */
export async function previsualizar(cursoId: string, entregaId: string, archivoId: string): Promise<Vista> {
  const { adjunto } = D.adjuntoDeEntrega(getDb(), cursoId, entregaId, archivoId)
  return vistaDeArchivo(archivoId, adjunto)
}

/** Vista de un archivo que el maestro adjuntó a una tarea (el enunciado, una plantilla…). */
export async function previsualizarMaterial(cursoId: string, tareaId: string, archivoId: string): Promise<Vista> {
  return vistaDeArchivo(archivoId, D.materialDeTarea(getDb(), cursoId, tareaId, archivoId))
}

async function vistaDeArchivo(archivoId: string, adjunto: { titulo: string; enlace: string }): Promise<Vista> {
  if (!estado().drive) {
    return { tipo: 'ninguno', nombre: adjunto.titulo, mime: '', tamano: null, enlace: adjunto.enlace, motivo: 'Falta el permiso de Google Drive para ver archivos dentro de la app. Pulsa Desconectar y Conectar en Ajustes › Google Classroom y acepta todos los permisos.' }
  }
  const meta = await G.leerArchivo(token, archivoId)
  const tamano = meta.size ? Number(meta.size) : null
  const enlace = meta.webViewLink || adjunto.enlace
  const base = { nombre: meta.name, mime: meta.mimeType, tamano, enlace }
  const ext = extensionDe(meta.name, meta.mimeType)
  const id = idSeguro(archivoId)
  const servir = (archivo: string): string => `docente://classroom/${encodeURIComponent(archivo)}`

  if (tamano !== null && tamano > MAX_VISTA) return { tipo: 'ninguno', ...base, motivo: 'Es demasiado grande para verlo aquí. Descárgalo o ábrelo en Google Drive.' }

  const exportar = GOOGLE_PDF[meta.mimeType]
  if (exportar) {
    const archivo = `${id}.pdf`
    if (!reciente(archivo)) writeFileSync(join(cacheDir(), archivo), await G.bajarArchivo(token, archivoId, exportar))
    return { tipo: 'pdf', ...base, url: servir(archivo) }
  }
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) return { tipo: 'ninguno', ...base, motivo: 'Este tipo de archivo de Google no se puede mostrar aquí.' }

  const esPdf = meta.mimeType === 'application/pdf' || ext === '.pdf'
  const esImagen = IMAGENES.has(meta.mimeType)
  const esTexto = meta.mimeType.startsWith('text/') || TEXTO.has(ext)
  const esOffice = OFFICE.has(ext)
  const libre = conversorDisponible().tipo === 'libreoffice'
  if (esOffice && !libre && !PRESENTACIONES.has(ext)) {
    return { tipo: 'ninguno', ...base, motivo: 'Para ver documentos de Word o Excel dentro de la app instala LibreOffice (brew install --cask libreoffice). Mientras, descárgalo o ábrelo en Google Drive.' }
  }
  if (!esPdf && !esImagen && !esTexto && !esOffice) return { tipo: 'ninguno', ...base, motivo: 'Este tipo de archivo no se puede mostrar dentro de la app.' }

  const archivo = `${id}${ext}`
  const ruta = join(cacheDir(), archivo)
  if (!reciente(archivo)) writeFileSync(ruta, await G.bajarArchivo(token, archivoId))
  if (esPdf) return { tipo: 'pdf', ...base, url: servir(archivo) }
  if (esImagen) return { tipo: 'imagen', ...base, url: servir(archivo) }
  if (esTexto) {
    const buf = readFileSync(ruta)
    return { tipo: 'texto', ...base, texto: buf.subarray(0, MAX_TEXTO).toString('utf8'), recortado: buf.length > MAX_TEXTO }
  }
  try {
    const pdf = await convertirAPdf(ruta)
    return { tipo: 'pdf', ...base, url: servir(relative(cacheDir(), pdf)) }
  } catch (e) {
    return { tipo: 'ninguno', ...base, motivo: `No se pudo convertir a PDF para verlo aquí: ${(e as Error).message}` }
  }
}

/** Contenido y nombre con extensión listos para guardar en disco. */
async function contenidoParaGuardar(archivoId: string): Promise<{ datos: Buffer; nombre: string }> {
  const meta = await G.leerArchivo(token, archivoId)
  const office = GOOGLE_OFFICE[meta.mimeType]
  if (office) {
    const nombre = extname(meta.name).toLowerCase() === office[1] ? meta.name : meta.name + office[1]
    return { datos: await G.bajarArchivo(token, archivoId, office[0]), nombre }
  }
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) throw new Error(`«${meta.name}» es un tipo de archivo de Google que no se puede descargar; ábrelo en Google Drive.`)
  // Si ya se vio en la app, se copia de la caché en vez de bajarlo otra vez
  const enCache = reciente(`${idSeguro(archivoId)}${extensionDe(meta.name, meta.mimeType)}`)
  return { datos: enCache ? readFileSync(enCache) : await G.bajarArchivo(token, archivoId), nombre: meta.name }
}

const ventana = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

function rutaLibre(carpeta: string, nombre: string): string {
  const ext = extname(nombre)
  const base = nombre.slice(0, nombre.length - ext.length)
  let ruta = join(carpeta, nombre)
  for (let i = 2; existsSync(ruta); i++) ruta = join(carpeta, `${base} (${i})${ext}`)
  return ruta
}

/** Descarga un archivo entregado donde el maestro elija. Devuelve la ruta o null si canceló. */
export async function descargar(cursoId: string, entregaId: string, archivoId: string): Promise<string | null> {
  const db = getDb()
  const { user_id } = D.adjuntoDeEntrega(db, cursoId, entregaId, archivoId)
  const { datos, nombre } = await contenidoParaGuardar(archivoId)
  const sugerido = nombreSeguro(`${D.nombreParaArchivo(db, cursoId, user_id)} - ${nombre}`)
  const opciones = { title: 'Guardar archivo entregado', defaultPath: join(app.getPath('downloads'), sugerido) }
  const w = ventana()
  const r = w ? await dialog.showSaveDialog(w, opciones) : await dialog.showSaveDialog(opciones)
  if (r.canceled || !r.filePath) return null
  writeFileSync(r.filePath, datos)
  return r.filePath
}

/**
 * Todas las entregas (archivos de Drive) de una o varias tareas de Classroom (p. ej. las agrupadas en
 * una tarea de la app) a una carpeta: «Apellidos Nombre - archivo.ext».
 */
export async function descargarTarea(claves: string[]): Promise<{ carpeta: string; archivos: number; enlaces: number; errores: string[] } | null> {
  const db = getDb()
  const lista = claves.flatMap((k) => {
    const i = k.indexOf(':')
    if (i < 1) throw new Error('Tarea no válida.')
    const curso = k.slice(0, i)
    return D.adjuntosDeTarea(db, curso, k.slice(i + 1)).map((e) => ({ ...e, curso }))
  })
  const total = lista.reduce((n, e) => n + e.adjuntos.filter((a) => a.tipo === 'drive').length, 0)
  if (!total) throw new Error('Nadie ha entregado archivos en esta tarea.')
  const opciones = { title: 'Carpeta para las entregas', buttonLabel: 'Guardar aquí', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
  const w = ventana()
  const r = w ? await dialog.showOpenDialog(w, opciones) : await dialog.showOpenDialog(opciones)
  if (r.canceled || !r.filePaths[0]) return null
  const carpeta = r.filePaths[0]
  let archivos = 0
  let enlaces = 0
  const errores: string[] = []
  for (const e of lista) {
    const quien = D.nombreParaArchivo(db, e.curso, e.user_id)
    for (const a of e.adjuntos) {
      if (a.tipo !== 'drive') {
        enlaces++
        continue
      }
      try {
        const { datos, nombre } = await contenidoParaGuardar(a.id)
        writeFileSync(rutaLibre(carpeta, nombreSeguro(`${quien} - ${nombre}`)), datos)
        archivos++
      } catch (err) {
        errores.push(`${quien} - ${a.titulo}: ${(err as Error).message}`)
      }
    }
  }
  return { carpeta, archivos, enlaces, errores }
}

/**
 * Revisión de copias de una o varias tareas (las agrupadas en una tarea de la app): baja los archivos de Drive
 * de cada entrega y toma los subidos al portal («Subir tarea»), lee sus metadatos y los compara entre alumnos.
 */
export async function revisarCopias(claves: string[], sola?: { entregaId: string; alumnoId: number | null }): Promise<InformeCopias> {
  const db = getDb()
  const pares = claves.map((k) => {
    const i = k.indexOf(':')
    if (i < 1) throw new Error('Tarea no válida.')
    return { curso: k.slice(0, i), tarea: k.slice(i + 1) }
  })
  const cursos = [...new Set(pares.map((p) => p.curso))]
  // El grupo: cada alumno ligado con sus correos (de la app y de Classroom) y su matrícula
  const filas = db
    .prepare(
      `SELECT DISTINCT a.id, a.nombre, a.apellidos, a.email, a.matricula, ca.email AS email_classroom FROM classroom_alumnos ca JOIN alumnos a ON a.id = ca.alumno_id
       WHERE ca.curso_id IN (${cursos.map(() => '?').join(',')}) AND ca.liga <> 'ajeno'`
    )
    .all(...cursos) as { id: number; nombre: string; apellidos: string; email: string; matricula: string; email_classroom: string }[]
  const porId = new Map<number, AlumnoDelGrupo>()
  for (const f of filas) {
    const ya = porId.get(f.id)
    const cuentas = [f.email, f.email_classroom, f.matricula].filter(Boolean)
    if (ya) ya.cuentas.push(...cuentas)
    else porId.set(f.id, { id: f.id, nombre: D.nombreApp({ nombre: f.nombre, apellidos: f.apellidos }), corto: nombreCorto(f.nombre, f.apellidos), cuentas })
  }
  const grupo = [...porId.values()]
  const delUsuario = (curso: string, userId: string): AlumnoDelGrupo => {
    const f = db.prepare('SELECT alumno_id, email FROM classroom_alumnos WHERE curso_id = ? AND user_id = ?').get(curso, userId) as { alumno_id: number | null; email: string } | undefined
    return (f?.alumno_id ? porId.get(f.alumno_id) : undefined) ?? { id: null, nombre: D.nombreParaArchivo(db, curso, userId), cuentas: f?.email ? [f.email] : [] }
  }

  const carpeta = join(cacheDir(), 'copias')
  mkdirSync(carpeta, { recursive: true })
  const entregados: Entregado[] = []
  const sinArchivo: string[] = []
  const titulos: string[] = []
  const conDrive = estado().drive
  // Una sola entrega: se leen los archivos de toda la tarea (para saber de dónde salió y en qué cadena está) y al final
  // se deja solo lo de ese alumno
  let nombreSola = sola?.alumnoId ? porId.get(sola.alumnoId)?.nombre ?? '' : ''
  for (const p of pares) {
    titulos.push((db.prepare('SELECT titulo FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(p.curso, p.tarea) as { titulo: string } | undefined)?.titulo ?? p.tarea)
    for (const e of D.adjuntosDeTarea(db, p.curso, p.tarea)) {
      const alumno = delUsuario(p.curso, e.user_id)
      if (sola && e.entrega_id === sola.entregaId) nombreSola = alumno.nombre
      const drive = e.adjuntos.filter((a): a is Extract<typeof a, { tipo: 'drive' }> => a.tipo === 'drive')
      if (!drive.length) {
        if (e.adjuntos.length) sinArchivo.push(`${alumno.nombre}: entregó solo enlaces o formularios`)
        continue
      }
      const cuando = (db.prepare('SELECT entregada FROM classroom_entregas WHERE curso_id = ? AND id = ?').get(p.curso, e.entrega_id) as { entregada: string | null } | undefined)?.entregada ?? null
      for (const a of drive) {
        if (!conDrive) {
          sinArchivo.push(`${alumno.nombre}: «${a.titulo}» (falta el permiso de Google Drive)`)
          continue
        }
        try {
          const h = await G.historialArchivo(token, a.id)
          // Quién más lo editó en Drive (si Drive no deja ver las versiones, se sigue sin ellas)
          const versiones = await G.revisionesArchivo(token, a.id).catch(() => [] as G.GRevision[])
          const editores: { nombre: string; correo: string; cuando: string | null }[] = []
          for (const v of versiones) {
            const correo = v.lastModifyingUser?.emailAddress ?? ''
            const nombreEd = v.lastModifyingUser?.displayName ?? ''
            if ((correo || nombreEd) && !editores.some((e) => (e.correo || e.nombre) === (correo || nombreEd))) editores.push({ nombre: nombreEd, correo, cuando: v.modifiedTime ?? null })
          }
          const { datos, nombre } = await contenidoParaGuardar(a.id)
          const ruta = join(carpeta, `${idSeguro(a.id)}${extensionDe(nombre, '')}`)
          writeFileSync(ruta, datos)
          entregados.push({
            alumno,
            origen: 'classroom',
            nombre,
            ruta,
            entregado: cuando,
            drive: {
              dueno: h.owners?.[0]?.displayName ?? '',
              dueno_correo: h.owners?.[0]?.emailAddress ?? '',
              editor: h.lastModifyingUser?.displayName ?? '',
              editor_correo: h.lastModifyingUser?.emailAddress ?? '',
              creado: h.createdTime ?? null,
              modificado: h.modifiedTime ?? null,
              nombre_original: h.originalFilename ?? '',
              editores
            }
          })
        } catch (err) {
          sinArchivo.push(`${alumno.nombre}: «${a.titulo}» no se pudo bajar (${(err as Error).message})`)
        }
      }
    }
    // Lo subido al portal para esa tarea
    const subidos = db
      .prepare(
        `SELECT s.alumno_id, a.nombre, a.ruta, a.subido_en FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE s.curso_id = ? AND s.tarea_id = ?`
      )
      .all(p.curso, p.tarea) as { alumno_id: number; nombre: string; ruta: string; subido_en: string }[]
    for (const f of subidos) {
      const alumno = porId.get(f.alumno_id) ?? { id: f.alumno_id, nombre: `Alumno ${f.alumno_id}`, cuentas: [] }
      if (sola && f.alumno_id === sola.alumnoId) nombreSola = alumno.nombre
      const ruta = isAbsolute(f.ruta) ? f.ruta : join(dataDir(), 'entregas', f.ruta)
      if (!existsSync(ruta)) {
        sinArchivo.push(`${alumno.nombre}: «${f.nombre}» del portal aún no llega a esta Mac`)
        continue
      }
      entregados.push({ alumno, origen: 'portal', nombre: f.nombre, ruta, entregado: `${f.subido_en.replace(' ', 'T')}Z` })
    }
  }
  const nada = 'Esta entrega no tiene archivos de los que leer metadatos (solo texto o enlaces).'
  if (!entregados.length) throw new Error(sinArchivo.length ? `No hay archivos que revisar: ${sinArchivo.join('; ')}.` : sola ? nada : 'Nadie ha entregado archivos en esta tarea.')
  const contexto = pares.map((p) => {
    const t = db.prepare('SELECT titulo, descripcion, vence FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(p.curso, p.tarea) as { titulo: string; descripcion: string | null; vence: string | null } | undefined
    return { titulo: t?.titulo ?? p.tarea, descripcion: t?.descripcion ?? '', vence: t?.vence ?? null }
  })
  const informe = await revisarEntregas(titulos, entregados, grupo, sinArchivo, contexto)
  if (!sola) return informe
  const quien = nombreSola
  const corto = informe.nombres[quien] ?? quien
  const suyos = informe.archivos.filter((a) => a.alumno === quien)
  if (!quien || !suyos.length) throw new Error(sinArchivo.find((x) => x.startsWith(`${quien}:`)) ?? nada)
  return {
    ...informe,
    archivos: suyos,
    hallazgos: informe.hallazgos.filter((h) => h.alumnos.includes(quien)),
    senales: informe.senales.filter((x) => x.alumnos.includes(quien)),
    cadenas: informe.cadenas.filter((c) => c.includes(corto)),
    trabajo_propio: informe.trabajo_propio.filter((t) => t.startsWith(`${corto}:`)),
    sin_archivo: informe.sin_archivo.filter((x) => x.startsWith(`${quien}:`))
  }
}

/**
 * Metadatos de una sola entrega (la que se abre en la celda de un alumno): compara con los archivos de toda la tarea
 * y deja lo de ese alumno: su historia, de dónde salió (prueba o indicio) y la cadena en la que está.
 */
export async function metadatosDeEntrega(cursoId: string, entregaId: string): Promise<InformeCopias> {
  const db = getDb()
  const e = db
    .prepare('SELECT e.tarea_id, ca.alumno_id FROM classroom_entregas e LEFT JOIN classroom_alumnos ca ON ca.curso_id = e.curso_id AND ca.user_id = e.user_id WHERE e.curso_id = ? AND e.id = ?')
    .get(cursoId, entregaId) as { tarea_id: string; alumno_id: number | null } | undefined
  if (!e) throw new Error('Esa entrega ya no está. Sincroniza otra vez.')
  return revisarCopias([`${cursoId}:${e.tarea_id}`], { entregaId, alumnoId: e.alumno_id })
}

// ---------- Tareas creadas desde la app (se publican en Classroom) ----------

export interface NuevaTarea {
  titulo: string
  descripcion: string
  puntos: number | null
  /** Fecha y hora de entrega en Ciudad de México («YYYY-MM-DDTHH:MM») o '' sin fecha */
  vence: string
  enlaces: string[]
  /** Archivos ya subidos a Drive con `subirArchivosTarea` */
  archivos?: ArchivoAdjuntado[]
}

function exigirEscritura(): void {
  if (!estado().conectado) throw new Error('Conecta Google Classroom en Ajustes primero.')
  if (!estado().escritura) throw new Error('Falta el permiso para crear y calificar tareas. Pulsa «Dar permisos que faltan» en Classroom o en Ajustes › Google Classroom y marca todas las casillas en Google.')
}

const LIMITE_ADJUNTO = 100 * 1024 * 1024
const MIME_ADJUNTO: Record<string, string> = {
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.py': 'text/x-python', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++'
}

/**
 * El docente elige uno o varios archivos y se suben a su Drive, visibles con el enlace. Aún no se pegan a
 * ninguna tarea: el formulario los junta y se adjuntan al publicar o al guardar los cambios.
 */
export async function subirArchivosTarea(): Promise<ArchivoAdjuntado[]> {
  if (!estado().conectado) throw new Error('Para adjuntar archivos conecta Google Classroom en Ajustes: se guardan en tu Google Drive.')
  if (!estado().subir) throw new Error('Falta el permiso para subir archivos a tu Drive. Pulsa «Dar permisos que faltan» en Classroom o en Ajustes › Google Classroom y marca todas las casillas en Google.')
  const opciones = { title: 'Archivos para la tarea', buttonLabel: 'Adjuntar', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], filters: [{ name: 'Todos', extensions: ['*'] }] }
  const w = ventana()
  const r = w ? await dialog.showOpenDialog(w, opciones) : await dialog.showOpenDialog(opciones)
  if (r.canceled || !r.filePaths.length) return []
  for (const ruta of r.filePaths) {
    if (statSync(ruta).size > LIMITE_ADJUNTO) throw new Error(`«${nombreDeRuta(ruta)}» pasa de 100 MB: súbelo a Drive y pega su enlace.`)
  }
  const dominio = (getAjuste(K.cuenta).split('@')[1] ?? '').toLowerCase()
  const subidos: ArchivoAdjuntado[] = []
  for (const ruta of r.filePaths) {
    const nombre = nombreDeRuta(ruta)
    subidos.push(await G.subirArchivoG(token, nombre, MIME_ADJUNTO[extname(nombre).toLowerCase()] ?? 'application/octet-stream', readFileSync(ruta), dominio))
  }
  return subidos
}

/** En la Mac y en la web (el servidor guarda lo subido con su nombre original) el nombre es el del archivo. */
const nombreDeRuta = (ruta: string): string => basename(ruta) || 'archivo'

/** Texto que se agrega a las instrucciones de una tarea de Classroom ya publicada (Google no deja agregarle material). */
const textoAdjuntos = (archivos: ArchivoAdjuntado[]): string =>
  `Material adjunto:\n${archivos.map((a) => `- 📎 ${a.titulo}: ${a.enlace}`).join('\n')}`

/** Lo que pide Classroom: fecha y hora en UTC (Ciudad de México es UTC−6 todo el año desde 2022). */
function aClassroom(t: Partial<NuevaTarea>): G.DatosTareaG {
  const d: G.DatosTareaG = {}
  if (t.titulo !== undefined) {
    if (!t.titulo.trim()) throw new Error('Ponle título a la tarea.')
    d.title = t.titulo.trim().slice(0, 3000)
  }
  if (t.descripcion !== undefined) d.description = t.descripcion.trim().slice(0, 30000)
  if (t.puntos !== undefined) {
    if (t.puntos !== null && (!Number.isFinite(t.puntos) || t.puntos < 0 || t.puntos > 10000)) throw new Error('Los puntos deben estar entre 0 y 10000.')
    d.maxPoints = t.puntos ?? 0
  }
  if (t.vence !== undefined) {
    if (!t.vence) {
      d.dueDate = null
      d.dueTime = null
    } else {
      const ms = Date.parse(`${t.vence.length === 10 ? `${t.vence}T23:59` : t.vence}:00-06:00`)
      if (Number.isNaN(ms)) throw new Error('La fecha de entrega no es válida.')
      const u = new Date(ms)
      d.dueDate = { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate() }
      d.dueTime = { hours: u.getUTCHours(), minutes: u.getUTCMinutes() }
    }
  }
  if (t.enlaces !== undefined) {
    const malos = t.enlaces.filter((e) => e.trim() && !/^https?:\/\//i.test(e.trim()))
    if (malos.length) throw new Error(`Este enlace no es válido: ${malos[0]}`)
    d.materials = t.enlaces.filter((e) => e.trim()).map((url) => ({ link: { url: url.trim() } }))
  }
  if (t.archivos?.length) d.materials = [...(d.materials ?? []), ...t.archivos.map((a) => ({ driveFile: { driveFile: { id: a.id }, shareMode: 'VIEW' as const } }))]
  return d
}

function tareaPropia(cursoId: string, tareaId: string): { titulo: string; puntos: number | null } {
  const t = getDb().prepare('SELECT titulo, puntos, propia FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { titulo: string; puntos: number | null; propia: number } | undefined
  if (!t) throw new Error('Esa tarea ya no está. Sincroniza otra vez.')
  if (!t.propia) throw new Error('Esa tarea se creó directamente en Classroom: Google solo deja cambiarla allá. Aquí puedes ponerle «Calificación en la app».')
  return t
}

/** Fecha de entrega de Classroom (UTC) a la forma en que se guarda aquí (ISO). */
const venceDe = (d: G.DatosTareaG): string | null | undefined =>
  d.dueDate === undefined ? undefined : d.dueDate === null ? null : D.venceUtc(d.dueDate, d.dueTime ?? undefined)

/** Crea la tarea: en Classroom (publicada) y sincroniza, o solo aquí si la materia no usa Classroom. */
export async function crearTarea(cursoId: string, t: NuevaTarea): Promise<void> {
  const db = getDb()
  const curso = db.prepare('SELECT materia_id FROM classroom_cursos WHERE id = ? AND materia_id IS NOT NULL').get(cursoId) as { materia_id: number } | undefined
  if (!curso) throw new Error('Ese curso no está ligado a una materia.')
  if (D.esCursoApp(cursoId)) {
    const d = aClassroom(t)
    const materiales = [
      ...(d.materials ?? []).flatMap((m) => ('link' in m ? [{ tipo: 'enlace', titulo: m.link.url, enlace: m.link.url }] : [])),
      ...(t.archivos ?? []).map((a) => ({ tipo: 'drive', id: a.id, titulo: a.titulo, enlace: a.enlace }))
    ]
    const id = `app-${randomUUID()}`
    db.prepare(
      `INSERT INTO classroom_tareas (curso_id, id, titulo, tipo, puntos, vence, creada, enlace, descripcion, materiales, propia) VALUES (?, ?, ?, 'ASSIGNMENT', ?, ?, ?, '', ?, ?, 1)`
    ).run(cursoId, id, d.title, d.maxPoints || null, venceDe(d) ?? null, new Date().toISOString(), d.description ?? '', JSON.stringify(materiales))
    // Sin entregas tarde por omisión, igual que las tareas nuevas que llegan de Classroom
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portal_tareas'").get())
      db.prepare(`INSERT INTO portal_tareas (curso_id, tarea_id, visibilidad, alumnos, acepta_tarde) VALUES (?, ?, 'todos', '[]', 0) ON CONFLICT (curso_id, tarea_id) DO NOTHING`).run(cursoId, id)
    D.asegurarCursoApp(db, curso.materia_id)
    return
  }
  exigirEscritura()
  await G.crearTareaG(token, cursoId, aClassroom(t))
  await sincronizar()
}

/**
 * Cambia una tarea creada desde la app. Archivos nuevos: en una tarea solo de la app se agregan a su material;
 * en una de Classroom ya publicada, Google no deja agregar material, así que sus enlaces van al final de las
 * instrucciones (los alumnos los abren desde la tarea).
 */
export async function editarTarea(cursoId: string, tareaId: string, t: Partial<Omit<NuevaTarea, 'enlaces'>>): Promise<void> {
  tareaPropia(cursoId, tareaId)
  const { archivos = [], ...resto } = t
  if (archivos.length && !D.esCursoApp(cursoId)) {
    const actual = resto.descripcion ?? ((getDb().prepare('SELECT descripcion FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { descripcion: string } | undefined)?.descripcion ?? '')
    resto.descripcion = [actual.trim(), textoAdjuntos(archivos)].filter(Boolean).join('\n\n')
  }
  const d = aClassroom(resto)
  if (D.esCursoApp(cursoId)) {
    if (archivos.length) {
      const fila = getDb().prepare('SELECT materiales FROM classroom_tareas WHERE curso_id = ? AND id = ?').get(cursoId, tareaId) as { materiales: string }
      const lista = JSON.parse(fila.materiales || '[]') as unknown[]
      lista.push(...archivos.map((a) => ({ tipo: 'drive', id: a.id, titulo: a.titulo, enlace: a.enlace })))
      getDb().prepare('UPDATE classroom_tareas SET materiales = ? WHERE curso_id = ? AND id = ?').run(JSON.stringify(lista), cursoId, tareaId)
    }
    const cambios: [string, unknown][] = []
    if (d.title !== undefined) cambios.push(['titulo', d.title])
    if (d.description !== undefined) cambios.push(['descripcion', d.description])
    if (d.maxPoints !== undefined) cambios.push(['puntos', d.maxPoints || null])
    const vence = venceDe(d)
    if (vence !== undefined) cambios.push(['vence', vence])
    if (cambios.length) getDb().prepare(`UPDATE classroom_tareas SET ${cambios.map(([k]) => `${k} = ?`).join(', ')} WHERE curso_id = ? AND id = ?`).run(...cambios.map(([, v]) => v), cursoId, tareaId)
    return
  }
  exigirEscritura()
  await G.editarTareaG(token, cursoId, tareaId, d)
  await sincronizar()
}

/** Borra una tarea creada desde la app (en Classroom si es de allá) con sus entregas, calificaciones y lo subido al portal. */
export async function borrarTarea(cursoId: string, tareaId: string): Promise<void> {
  tareaPropia(cursoId, tareaId)
  if (!D.esCursoApp(cursoId)) {
    exigirEscritura()
    await G.borrarTareaG(token, cursoId, tareaId)
    await sincronizar()
    return
  }
  const db = getDb()
  db.transaction(() => {
    const entregas = (db.prepare('SELECT id FROM classroom_entregas WHERE curso_id = ? AND tarea_id = ?').all(cursoId, tareaId) as { id: string }[]).map((e) => e.id)
    for (const e of entregas) {
      db.prepare('DELETE FROM classroom_entregas_fuera WHERE curso_id = ? AND entrega_id = ?').run(cursoId, e)
      db.prepare('DELETE FROM classroom_calif_app WHERE curso_id = ? AND entrega_id = ?').run(cursoId, e)
    }
    db.prepare('DELETE FROM classroom_entregas WHERE curso_id = ? AND tarea_id = ?').run(cursoId, tareaId)
    db.prepare('DELETE FROM subidas_alumno WHERE curso_id = ? AND tarea_id = ?').run(cursoId, tareaId)
    db.prepare('DELETE FROM classroom_tareas WHERE curso_id = ? AND id = ?').run(cursoId, tareaId)
  })()
}

/**
 * Califica en Classroom una o varias entregas de una tarea creada desde la app y, si se pide, las devuelve
 * (el alumno ve su calificación). Aquí se actualiza al momento; la calificación de la app, si había, se quita.
 */
export async function calificarEnClassroom(cursoId: string, tareaId: string, notas: { entrega_id: string; nota: number }[], devolver: boolean): Promise<{ calificadas: number; errores: string[] }> {
  // Sin Classroom: la calificación (y la devolución) solo se guardan aquí
  const local = D.esCursoApp(cursoId)
  if (!local) exigirEscritura()
  const t = tareaPropia(cursoId, tareaId)
  const db = getDb()
  const errores: string[] = []
  let calificadas = 0
  for (const n of notas) {
    const e = db.prepare('SELECT user_id FROM classroom_entregas WHERE curso_id = ? AND id = ? AND tarea_id = ?').get(cursoId, n.entrega_id, tareaId) as { user_id: string } | undefined
    const quien = e ? D.nombreParaArchivo(db, cursoId, e.user_id) : n.entrega_id
    if (!e) {
      errores.push(`${quien}: esa entrega no es de esta tarea`)
      continue
    }
    if (!Number.isFinite(n.nota) || n.nota < 0 || (t.puntos !== null && t.puntos > 0 && n.nota > t.puntos)) {
      errores.push(`${quien}: la calificación debe estar entre 0 y ${t.puntos ?? 'los puntos de la tarea'}`)
      continue
    }
    try {
      if (!local) {
        await G.calificarG(token, cursoId, tareaId, n.entrega_id, n.nota)
        if (devolver) await G.devolverG(token, cursoId, tareaId, n.entrega_id)
      }
      db.prepare(`UPDATE classroom_entregas SET calificacion = ?, borrador = ?${devolver ? ", estado = 'RETURNED'" : ''} WHERE curso_id = ? AND id = ?`).run(n.nota, n.nota, cursoId, n.entrega_id)
      db.prepare('DELETE FROM classroom_calif_app WHERE curso_id = ? AND entrega_id = ?').run(cursoId, n.entrega_id)
      calificadas++
    } catch (err) {
      errores.push(`${quien}: ${(err as Error).message}`)
    }
  }
  return { calificadas, errores }
}

/** Abre en el navegador un enlace guardado de Classroom (tarea, entrega o adjunto). */
export function abrirEnlace(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new Error('Enlace no válido.')
  abrirFuera(url)
}

/** Al arrancar se borra la caché vieja; al salir, toda. */
export function prepararCache(): void {
  try {
    limpiarCache()
  } catch {
    /* no es grave */
  }
  app.on('will-quit', () => {
    try {
      limpiarCache(true)
    } catch {
      /* no es grave */
    }
  })
}
