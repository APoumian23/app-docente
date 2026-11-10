/**
 * Cliente de Google (OAuth de app de escritorio + REST de Classroom y Drive) sin dependencias:
 * fetch y http de Node. No importa Electron para poder probarlo con un servidor simulado.
 * Lee Classroom y Drive; con el permiso de escritura crea, edita y califica solo las tareas que crea la app.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes } from 'crypto'
import type { AddressInfo } from 'net'

export const CUENTA_MAESTRO = 'docente@escuela.edu.mx'

export const SCOPES_CLASSROOM = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
  'https://www.googleapis.com/auth/classroom.profile.emails'
]
export const SCOPE_DRIVE = 'https://www.googleapis.com/auth/drive.readonly'
/** Crear, editar, borrar y calificar tareas. Opcional: sin él la app sigue leyendo como siempre. */
export const SCOPE_ESCRITURA = 'https://www.googleapis.com/auth/classroom.coursework.students'
/** Subir a Drive los archivos que el docente adjunta a sus tareas (solo toca lo que sube la app). Opcional. */
export const SCOPE_SUBIR = 'https://www.googleapis.com/auth/drive.file'
export const SCOPES = [...SCOPES_CLASSROOM, SCOPE_DRIVE, SCOPE_ESCRITURA, SCOPE_SUBIR]

const LIMITE_INICIO_MS = 5 * 60_000

/**
 * Direcciones de Google. DOCENTE_GOOGLE_PRUEBAS las cambia por un servidor simulado, solo en
 * 127.0.0.1/localhost: así una variable de entorno no puede mandar los tokens a otro sitio.
 */
export function urlsGoogle(): { auth: string; token: string; revocar: string; tokeninfo: string; classroom: string; drive: string } {
  const prueba = process.env.DOCENTE_GOOGLE_PRUEBAS
  if (prueba) {
    const u = new URL(prueba)
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) {
      const b = u.origin
      return { auth: `${b}/o/oauth2/v2/auth`, token: `${b}/token`, revocar: `${b}/revoke`, tokeninfo: `${b}/tokeninfo`, classroom: b, drive: b }
    }
  }
  return {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revocar: 'https://oauth2.googleapis.com/revoke',
    tokeninfo: 'https://oauth2.googleapis.com/tokeninfo',
    classroom: 'https://classroom.googleapis.com',
    drive: 'https://www.googleapis.com'
  }
}

export function validarClientId(id: string): void {
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error('Eso no parece un Client ID de Google: debe terminar en ".apps.googleusercontent.com". Cópialo de Google Cloud › APIs y servicios › Credenciales.')
  }
}

const base64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkce(): { verificador: string; reto: string } {
  const verificador = base64url(randomBytes(32))
  return { verificador, reto: base64url(createHash('sha256').update(verificador).digest()) }
}

/** Traduce los códigos de error de OAuth de Google a qué hacer, en español. */
export function errorOAuth(codigo: string, detalle = ''): Error {
  const m: Record<string, string> = {
    access_denied: 'No se concedió el permiso: se canceló el inicio de sesión o no se aceptaron los permisos. Pulsa Conectar otra vez y acepta todo lo que pide.',
    admin_policy_enforced: 'La escuela (administración de Google Workspace) bloquea esta app para tu cuenta. Pide a Sistemas que permita el Client ID de App_Docente; la guía «Cómo configurarlo» explica qué pedir.',
    org_internal: 'Este cliente de Google es «Interno» de otra organización. Entra con docente@escuela.edu.mx o crea el proyecto con esa cuenta.',
    invalid_client: 'Google no reconoce el Client ID o el Client Secret. Vuelve a copiarlos de Google Cloud › Credenciales (cliente tipo «App de escritorio») y guárdalos.',
    unauthorized_client: 'El cliente de Google no permite este tipo de acceso. Crea una credencial «ID de cliente de OAuth» de tipo «App de escritorio».',
    redirect_uri_mismatch: 'El cliente de Google no es de tipo «App de escritorio». Crea uno de ese tipo y pega su Client ID y Client Secret.',
    invalid_grant: 'Google ya no acepta el permiso guardado (se revocó o caducó). Pulsa Conectar otra vez. Si tu proyecto de Google Cloud es «Externo» en modo Prueba, el permiso caduca cada 7 días y hay que reconectar.',
    invalid_scope: 'Google rechazó alguno de los permisos pedidos. Revisa que en la pantalla de consentimiento estén los permisos de la guía.',
    disallowed_useragent: 'Google no permite iniciar sesión desde este navegador. Abre el enlace en Safari o Chrome.'
  }
  return new Error(m[codigo] ?? `Google respondió «${codigo}»${detalle ? `: ${detalle}` : ''}.`)
}

export interface Tokens {
  access_token: string
  expira: number
  refresh_token?: string
  scope: string
}

async function pedirToken(cuerpo: Record<string, string>): Promise<Tokens> {
  let r: Response
  try {
    r = await fetch(urlsGoogle().token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(cuerpo).toString()
    })
  } catch {
    throw new Error('No hay conexión con Google. Revisa el internet y vuelve a intentar.')
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok || !j.access_token) throw errorOAuth(String(j.error ?? `HTTP ${r.status}`), String(j.error_description ?? ''))
  return {
    access_token: String(j.access_token),
    // Un minuto de margen para no usar un token a punto de vencer
    expira: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000,
    refresh_token: j.refresh_token ? String(j.refresh_token) : undefined,
    scope: String(j.scope ?? '')
  }
}

export function refrescar(clientId: string, clientSecret: string, refreshToken: string): Promise<Tokens> {
  return pedirToken({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken })
}

/** Revoca el permiso en Google. Si no hay red no importa: los tokens locales se borran igual. */
/** Permisos que Google tiene registrados para un token (la fuente de verdad, no el texto de la respuesta). */
export async function permisosDelToken(token: string): Promise<string[]> {
  try {
    const r = await fetch(`${urlsGoogle().tokeninfo}?access_token=${encodeURIComponent(token)}`)
    if (!r.ok) return []
    const j = (await r.json()) as { scope?: string }
    return String(j.scope ?? '').split(' ').filter(Boolean)
  } catch {
    return []
  }
}

/** Nombres antiguos con los que Google a veces regresa un permiso (son el mismo permiso) */
const ALIAS_PERMISO: Record<string, string[]> = {
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly': ['https://www.googleapis.com/auth/classroom.student-submissions.students.readonly'],
  'https://www.googleapis.com/auth/classroom.coursework.students': ['https://www.googleapis.com/auth/classroom.student-submissions.students']
}

/** Un permiso cuenta si llegó tal cual, con su nombre antiguo o en su versión amplia (sin «.readonly»), que lo incluye. */
export function permisosQueFaltan(pedidos: string[], recibidos: string[]): string[] {
  const r = new Set(recibidos)
  const llego = (s: string): boolean => r.has(s) || (ALIAS_PERMISO[s] ?? []).some((a) => r.has(a))
  return pedidos.filter((s) => !llego(s) && !llego(s.replace(/\.readonly$/, '')))
}

export async function revocar(token: string): Promise<void> {
  await fetch(urlsGoogle().revocar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString()
  }).catch(() => undefined)
}

const pagina = (titulo: string, texto: string): string =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>App_Docente</title></head>` +
  `<body style="font-family:-apple-system,Helvetica,sans-serif;background:#f5f7fa;color:#1f2632;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
  `<div style="background:#fff;border:1px solid #d3dae5;border-radius:12px;padding:32px 40px;max-width:460px;text-align:center">` +
  `<h1 style="font-size:22px;margin:0 0 8px">${titulo}</h1><p style="margin:0;color:#56657f">${texto}</p></div></body></html>`

let cancelarAnterior: (() => void) | null = null

/**
 * Inicio de sesión de app de escritorio: servidor de un solo uso en 127.0.0.1 (puerto libre),
 * PKCE S256 y state aleatorio. `abrir` lleva al maestro al navegador del sistema.
 */
export function iniciarSesion(o: { clientId: string; clientSecret: string; abrir: (url: string) => void; limiteMs?: number }): Promise<Tokens> {
  cancelarAnterior?.()
  return new Promise((resolver, rechazar) => {
    const { verificador, reto } = pkce()
    const state = base64url(randomBytes(16))
    let redirect = ''
    let terminado = false
    const servidor = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/' || terminado) {
        res.writeHead(404).end()
        return
      }
      const responder = (titulo: string, texto: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(pagina(titulo, texto))
      }
      const error = u.searchParams.get('error')
      const codigo = u.searchParams.get('code')
      if (!error && !codigo) {
        res.writeHead(404).end()
        return
      }
      if (u.searchParams.get('state') !== state) {
        responder('No se pudo conectar', 'La respuesta no corresponde a este inicio de sesión. Vuelve a App_Docente y pulsa Conectar otra vez.')
        return terminar(new Error('La respuesta de Google no corresponde a este inicio de sesión (state distinto). Vuelve a pulsar Conectar.'))
      }
      if (error) {
        const e = errorOAuth(error, u.searchParams.get('error_description') ?? '')
        responder('No se pudo conectar', e.message)
        return terminar(e)
      }
      responder('Listo, ya puedes volver a App_Docente', 'Puedes cerrar esta pestaña.')
      terminar(null, codigo!)
    })

    const limite = setTimeout(
      () => terminar(new Error('Pasaron 5 minutos sin terminar el inicio de sesión en Google. Pulsa Conectar otra vez.')),
      o.limiteMs ?? LIMITE_INICIO_MS
    )

    function terminar(error: Error | null, codigo?: string): void {
      if (terminado) return
      terminado = true
      clearTimeout(limite)
      cancelarAnterior = null
      // Se cierra después de mandar la página al navegador
      setTimeout(() => {
        servidor.close()
        servidor.closeAllConnections()
      }, 50)
      if (error) return rechazar(error)
      pedirToken({
        grant_type: 'authorization_code',
        code: codigo!,
        client_id: o.clientId,
        client_secret: o.clientSecret,
        redirect_uri: redirect,
        code_verifier: verificador
      }).then(resolver, rechazar)
    }
    cancelarAnterior = () => terminar(new Error('Se empezó otro inicio de sesión.'))

    servidor.on('error', (e) => terminar(new Error(`No se pudo esperar la respuesta de Google: ${e.message}`)))
    servidor.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
      const url = new URL(urlsGoogle().auth)
      const p = url.searchParams
      p.set('client_id', o.clientId)
      p.set('response_type', 'code')
      p.set('redirect_uri', redirect)
      p.set('scope', SCOPES.join(' '))
      p.set('code_challenge', reto)
      p.set('code_challenge_method', 'S256')
      p.set('state', state)
      p.set('access_type', 'offline')
      p.set('prompt', 'consent')
      p.set('login_hint', CUENTA_MAESTRO)
      o.abrir(url.toString())
    })
  })
}

/** De dónde sale el token de acceso vigente; quien lo implementa refresca y guarda. */
export type ObtenerToken = (forzar?: boolean) => Promise<string>

const espera = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const REINTENTABLE = new Set([429, 500, 502, 503, 504])

/** Mensaje claro para los errores de la API (no de OAuth). */
async function errorApi(r: Response, que: string): Promise<Error> {
  const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } }
  const msg = j.error?.message ?? ''
  const razon = j.error?.details?.map((d) => d.reason).join(' ') ?? ''
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(msg + razon)) {
    const api = /drive/i.test(msg) ? 'Google Drive API' : 'Google Classroom API'
    return new Error(`La «${api}» no está habilitada en tu proyecto de Google Cloud. Habilítala en APIs y servicios › Biblioteca y vuelve a intentar en unos minutos.`)
  }
  if (r.status === 401) return new Error('Google rechazó el acceso guardado. Pulsa Desconectar y luego Conectar.')
  if (r.status === 403 && /insufficient|scope/i.test(msg)) return new Error(`Falta un permiso para ${que}. Pulsa Conectar otra vez y marca todas las casillas de permisos.`)
  if (r.status === 403) return new Error(`Google no dio acceso a ${que}${msg ? `: ${msg}` : ''}.`)
  if (r.status === 404) return new Error(`No se encontró ${que} en Google (pudo borrarse o ya no está compartido contigo).`)
  return new Error(`Google respondió ${r.status} al leer ${que}${msg ? `: ${msg}` : ''}.`)
}

/** Mensaje claro al escribir en Classroom (crear, editar, borrar, calificar). */
async function errorEscritura(r: Response, que: string): Promise<Error> {
  const copia = r.clone()
  const j = (await copia.json().catch(() => ({}))) as { error?: { message?: string } }
  const msg = j.error?.message ?? ''
  // Google solo deja tocar las tareas que creó esta misma app (su proyecto de Google Cloud)
  if (r.status === 403 && /ProjectPermissionDenied|Developer Console project is not permitted/i.test(msg)) {
    return new Error(`Esa tarea se creó directamente en Classroom: Google solo deja cambiarla o calificarla allá. En la app puedes ponerle «Calificación en la app».`)
  }
  if (r.status === 403 && /insufficient|scope/i.test(msg)) {
    return new Error('Falta el permiso para crear y calificar tareas. Pulsa «Dar permisos que faltan» en Classroom o en Ajustes › Google Classroom y marca todas las casillas en Google.')
  }
  if (r.status === 400 && msg) return new Error(`Classroom no aceptó ${que}: ${msg}`)
  const e = await errorApi(r, que)
  return new Error(e.message.replace(' al leer ', ' al guardar '))
}

/**
 * POST, PATCH o DELETE con refresco del token ante 401. Se reintenta ante 429 (Google no lo procesó);
 * ante 5xx solo PATCH y DELETE, que se pueden repetir: un POST repetido crearía la tarea dos veces.
 */
export async function escribir(token: ObtenerToken, metodo: 'POST' | 'PATCH' | 'DELETE', url: string, cuerpo: unknown, que: string, retardoBase = 500): Promise<Response> {
  let refrescado = false
  let forzar = false
  for (let intento = 0; ; intento++) {
    let r: Response
    try {
      const t = await token(forzar)
      forzar = false
      r = await fetch(url, {
        method: metodo,
        headers: { Authorization: `Bearer ${t}`, ...(cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined
      })
    } catch (e) {
      if (metodo !== 'POST' && intento < 3) {
        await espera(retardoBase * 2 ** intento)
        continue
      }
      throw new Error(`No hay conexión con Google (${(e as Error).message}). Revisa el internet y vuelve a intentar.`)
    }
    if (r.ok) return r
    if (r.status === 401 && !refrescado) {
      refrescado = true
      forzar = true
      continue
    }
    if ((r.status === 429 || (metodo !== 'POST' && REINTENTABLE.has(r.status))) && intento < 4) {
      const pide = Number(r.headers.get('retry-after'))
      await espera(Number.isFinite(pide) && pide > 0 ? Math.min(pide, 30) * 1000 : retardoBase * 2 ** intento)
      continue
    }
    throw await errorEscritura(r, que)
  }
}

/**
 * GET con reintentos ante 429/5xx (respeta Retry-After) y un refresco del token ante 401.
 * Para escribir (tareas y calificaciones) está `escribir`.
 */
export async function obtener(token: ObtenerToken, url: string, que: string, retardoBase = 500): Promise<Response> {
  let refrescado = false
  let forzar = false
  for (let intento = 0; ; intento++) {
    let r: Response
    try {
      const t = await token(forzar)
      forzar = false
      r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } })
    } catch (e) {
      if (intento < 3) {
        await espera(retardoBase * 2 ** intento)
        continue
      }
      throw new Error(`No hay conexión con Google (${(e as Error).message}). Revisa el internet y vuelve a intentar.`)
    }
    if (r.ok) return r
    if (r.status === 401 && !refrescado) {
      refrescado = true
      forzar = true
      continue
    }
    if (REINTENTABLE.has(r.status) && intento < 4) {
      const pide = Number(r.headers.get('retry-after'))
      await espera(Number.isFinite(pide) && pide > 0 ? Math.min(pide, 30) * 1000 : retardoBase * 2 ** intento)
      continue
    }
    throw await errorApi(r, que)
  }
}

export async function obtenerJson<T>(token: ObtenerToken, url: string, que: string): Promise<T> {
  return (await (await obtener(token, url, que)).json()) as T
}

/** Recorre todas las páginas (pageToken) de una lista de Classroom. */
export async function paginar<T>(token: ObtenerToken, ruta: string, params: Record<string, string>, campo: string, que: string): Promise<T[]> {
  const todos: T[] = []
  let pageToken = ''
  do {
    const u = new URL(urlsGoogle().classroom + ruta)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    u.searchParams.set('pageSize', '100')
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    const j = await obtenerJson<Record<string, unknown>>(token, u.toString(), que)
    todos.push(...((j[campo] as T[] | undefined) ?? []))
    pageToken = String(j.nextPageToken ?? '')
  } while (pageToken)
  return todos
}

// ---- Formas de la API v1 de Classroom (solo los campos que se usan) ----
export interface GCurso { id: string; name: string; section?: string; alternateLink?: string; courseState?: string }
export interface GAlumno { userId: string; profile: { id: string; name?: { fullName?: string; givenName?: string; familyName?: string }; emailAddress?: string } }
export interface GFecha { year: number; month: number; day: number }
export interface GTarea {
  id: string
  title: string
  dueDate?: GFecha
  dueTime?: { hours?: number; minutes?: number }
  maxPoints?: number
  workType?: string
  creationTime?: string
  alternateLink?: string
  /** La creó esta app (su proyecto de Google Cloud): solo esas se pueden editar, borrar y calificar por la API */
  associatedWithDeveloper?: boolean
  state?: string
  /** Instrucciones de la tarea y el material que el maestro adjuntó (para revisar contra lo que se pidió) */
  description?: string
  materials?: {
    driveFile?: { driveFile?: { id: string; title?: string; alternateLink?: string } }
    link?: { url: string; title?: string }
    youtubeVideo?: { id: string; title?: string; alternateLink?: string }
    form?: { formUrl?: string; title?: string }
  }[]
}
export interface GAdjunto {
  driveFile?: { id: string; title?: string; alternateLink?: string; thumbnailUrl?: string }
  link?: { url: string; title?: string }
  youTubeVideo?: { id: string; title?: string; alternateLink?: string }
  form?: { formUrl?: string; responseUrl?: string; title?: string }
}
export interface GEntrega {
  id: string
  courseWorkId: string
  userId: string
  state?: string
  late?: boolean
  assignedGrade?: number
  draftGrade?: number
  updateTime?: string
  alternateLink?: string
  assignmentSubmission?: { attachments?: GAdjunto[] }
  shortAnswerSubmission?: { answer?: string }
  multipleChoiceSubmission?: { answer?: string }
  submissionHistory?: { stateHistory?: { state?: string; stateTimestamp?: string } }[]
}

export const leerCursos = (t: ObtenerToken): Promise<GCurso[]> =>
  paginar<GCurso>(t, '/v1/courses', { teacherId: 'me', courseStates: 'ACTIVE' }, 'courses', 'tus cursos')
export const leerAlumnos = (t: ObtenerToken, curso: string): Promise<GAlumno[]> =>
  paginar<GAlumno>(t, `/v1/courses/${encodeURIComponent(curso)}/students`, {}, 'students', 'los alumnos del curso')
export const leerTareas = (t: ObtenerToken, curso: string): Promise<GTarea[]> =>
  paginar<GTarea>(t, `/v1/courses/${encodeURIComponent(curso)}/courseWork`, { courseWorkStates: 'PUBLISHED' }, 'courseWork', 'las tareas del curso')
export const leerEntregas = (t: ObtenerToken, curso: string): Promise<GEntrega[]> =>
  paginar<GEntrega>(t, `/v1/courses/${encodeURIComponent(curso)}/courseWork/-/studentSubmissions`, {}, 'studentSubmissions', 'las entregas del curso')
export const leerPerfil = (t: ObtenerToken): Promise<{ emailAddress?: string; name?: { fullName?: string } }> =>
  obtenerJson(t, `${urlsGoogle().classroom}/v1/userProfiles/me`, 'tu perfil')

// ---- Drive (solo para ver y bajar lo que entregaron los alumnos) ----
export interface GArchivo { id: string; name: string; mimeType: string; size?: string; webViewLink?: string }

export const leerArchivo = (t: ObtenerToken, id: string): Promise<GArchivo> =>
  obtenerJson(t, `${urlsGoogle().drive}/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`, 'el archivo en Drive')

/** Lo que Drive sabe del archivo: dueño, quién lo modificó por última vez y cuándo (para revisar copias). */
export interface GHistorial {
  id: string
  name: string
  mimeType: string
  md5Checksum?: string
  originalFilename?: string
  createdTime?: string
  modifiedTime?: string
  owners?: { displayName?: string; emailAddress?: string }[]
  lastModifyingUser?: { displayName?: string; emailAddress?: string }
}
export const historialArchivo = (t: ObtenerToken, id: string): Promise<GHistorial> =>
  obtenerJson(
    t,
    `${urlsGoogle().drive}/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,md5Checksum,originalFilename,createdTime,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)&supportsAllDrives=true`,
    'el archivo en Drive'
  )

/** Cada versión guardada en Drive: quién la guardó y cuándo (así se sabe quién más editó el archivo). */
export interface GRevision { id: string; modifiedTime?: string; lastModifyingUser?: { displayName?: string; emailAddress?: string } }
export const revisionesArchivo = async (t: ObtenerToken, id: string): Promise<GRevision[]> =>
  (
    await obtenerJson<{ revisions?: GRevision[] }>(
      t,
      `${urlsGoogle().drive}/drive/v3/files/${encodeURIComponent(id)}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))&pageSize=200`,
      'el historial del archivo en Drive'
    )
  ).revisions ?? []

/** Contenido del archivo; los de Google (Docs, Hojas, Presentaciones) se exportan al formato indicado. */
export async function bajarArchivo(t: ObtenerToken, id: string, exportarComo?: string): Promise<Buffer> {
  const b = `${urlsGoogle().drive}/drive/v3/files/${encodeURIComponent(id)}`
  const url = exportarComo ? `${b}/export?mimeType=${encodeURIComponent(exportarComo)}` : `${b}?alt=media&supportsAllDrives=true`
  const r = await obtener(t, url, 'el archivo en Drive')
  return Buffer.from(await r.arrayBuffer())
}

// ---- Escritura: tareas creadas desde la app y sus calificaciones ----

export interface DatosTareaG {
  title?: string
  description?: string
  maxPoints?: number
  dueDate?: GFecha | null
  dueTime?: { hours: number; minutes: number } | null
  materials?: ({ link: { url: string } } | { driveFile: { driveFile: { id: string }; shareMode: 'VIEW' } })[]
}

const cw = (curso: string): string => `${urlsGoogle().classroom}/v1/courses/${encodeURIComponent(curso)}/courseWork`

export async function crearTareaG(t: ObtenerToken, curso: string, d: DatosTareaG): Promise<GTarea> {
  const cuerpo = { ...d, workType: 'ASSIGNMENT', state: 'PUBLISHED' }
  return (await (await escribir(t, 'POST', cw(curso), cuerpo, 'la tarea nueva')).json()) as GTarea
}

/** Solo cambia los campos que vienen (Google pide la lista en updateMask). */
export async function editarTareaG(t: ObtenerToken, curso: string, id: string, d: DatosTareaG): Promise<GTarea> {
  const campos = Object.keys(d).filter((k) => k !== 'materials')
  if (!campos.length) throw new Error('No hay cambios que guardar.')
  const url = `${cw(curso)}/${encodeURIComponent(id)}?updateMask=${campos.join(',')}`
  return (await (await escribir(t, 'PATCH', url, d, 'los cambios de la tarea')).json()) as GTarea
}

export async function borrarTareaG(t: ObtenerToken, curso: string, id: string): Promise<void> {
  await escribir(t, 'DELETE', `${cw(curso)}/${encodeURIComponent(id)}`, undefined, 'el borrado de la tarea')
}

/** Calificación de una entrega: queda como calificación asignada (y borrador, que es lo que ve el docente en Classroom). */
export async function calificarG(t: ObtenerToken, curso: string, tarea: string, entrega: string, nota: number): Promise<void> {
  const url = `${cw(curso)}/${encodeURIComponent(tarea)}/studentSubmissions/${encodeURIComponent(entrega)}?updateMask=assignedGrade,draftGrade`
  await escribir(t, 'PATCH', url, { assignedGrade: nota, draftGrade: nota }, 'la calificación')
}

/** Devuelve la entrega al alumno: así ve su calificación en Classroom. */
export async function devolverG(t: ObtenerToken, curso: string, tarea: string, entrega: string): Promise<void> {
  await escribir(t, 'POST', `${cw(curso)}/${encodeURIComponent(tarea)}/studentSubmissions/${encodeURIComponent(entrega)}:return`, {}, 'la devolución de la entrega')
}

// ---- Archivos que el docente adjunta a sus tareas ----

export interface ArchivoDrive {
  id: string
  titulo: string
  enlace: string
  /** El enlace lo puede abrir cualquiera que lo tenga (si la universidad lo bloquea, solo su dominio) */
  compartido: 'enlace' | 'dominio' | 'no'
}

/**
 * Sube un archivo a la unidad del docente y lo deja visible con el enlace: así lo abren los alumnos desde
 * Classroom, desde las instrucciones o desde el portal. Si Google Workspace no deja compartir «con
 * cualquiera», se comparte con el dominio de la cuenta.
 */
export async function subirArchivoG(t: ObtenerToken, nombre: string, mime: string, datos: Buffer, dominio: string): Promise<ArchivoDrive> {
  const frontera = `docente-${randomBytes(12).toString('hex')}`
  const meta = JSON.stringify({ name: nombre, mimeType: mime })
  const cuerpo = Buffer.concat([
    Buffer.from(`--${frontera}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${frontera}\r\nContent-Type: ${mime}\r\n\r\n`),
    datos,
    Buffer.from(`\r\n--${frontera}--`)
  ])
  const url = `${urlsGoogle().drive}/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`
  let r: Response | null = null
  for (let intento = 0; intento < 2; intento++) {
    try {
      r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await t(intento > 0)}`, 'Content-Type': `multipart/related; boundary=${frontera}` }, body: cuerpo })
    } catch (e) {
      throw new Error(`No hay conexión con Google (${(e as Error).message}). Revisa el internet y vuelve a intentar.`)
    }
    if (r.status !== 401) break
  }
  if (!r!.ok) {
    const j = (await r!.clone().json().catch(() => ({}))) as { error?: { message?: string } }
    if (r!.status === 403 && /insufficient|scope/i.test(j.error?.message ?? '')) {
      throw new Error('Falta el permiso para subir archivos a tu Drive. Pulsa «Dar permisos que faltan» en Classroom o en Ajustes › Google Classroom y marca todas las casillas en Google.')
    }
    throw new Error((await errorApi(r!, `«${nombre}»`)).message.replace(' al leer ', ' al subir '))
  }
  const f = (await r!.json()) as { id: string; name?: string; webViewLink?: string }
  const permiso = async (cuerpoP: unknown): Promise<boolean> => {
    try {
      await escribir(t, 'POST', `${urlsGoogle().drive}/drive/v3/files/${encodeURIComponent(f.id)}/permissions?supportsAllDrives=true`, cuerpoP, 'el permiso del archivo')
      return true
    } catch {
      return false
    }
  }
  let compartido: ArchivoDrive['compartido'] = 'no'
  if (await permiso({ role: 'reader', type: 'anyone', allowFileDiscovery: false })) compartido = 'enlace'
  else if (dominio && (await permiso({ role: 'reader', type: 'domain', domain: dominio, allowFileDiscovery: false }))) compartido = 'dominio'
  return { id: f.id, titulo: f.name || nombre, enlace: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, compartido }
}
