/**
 * Google Classroom sin Google: un servidor local imita OAuth (token con PKCE, refresco, errores),
 * Classroom v1 (perfil, cursos, alumnos, tareas y entregas, con paginación y fallas 429/503) y Drive.
 * Trabaja sobre una COPIA de la base (VACUUM INTO) y nunca escribe en los datos reales.
 * Se corre desde qa.sh con Electron como Node (better-sqlite3 está compilado para Electron).
 */
import Database from 'better-sqlite3'
import ExcelJS from 'exceljs'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { abrirBase } from '../src/servidor/base'
import * as G from '../src/main/services/classroom-api'
import * as D from '../src/main/services/classroom-datos'
import * as T from '../src/main/services/classroom-consolidar'
import { libroEntregas } from '../src/main/services/classroom-excel'
import { classroomACalificaciones } from '../src/main/services/classroom-calificaciones'

let fallos = 0
const ok = (t: string, cond: boolean, extra = ''): void => {
  console.log(cond ? '  ✓' : '  ✗', t, cond || !extra ? '' : `→ ${extra}`)
  if (!cond) fallos++
}

const CLIENT_ID = '1234-prueba.apps.googleusercontent.com'
const SECRET = 'GOCSPX-secreto-de-prueba'
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// ---------- Datos simulados (formato real de la API v1) ----------
const CURSO = 'c-algebra'
const OTRO = 'c-otro'
const fecha = (y: number, m: number, d: number) => ({ year: y, month: m, day: d })
const tareas = [
  { id: 't1', title: '1er Tarea', dueDate: fecha(2026, 9, 20), dueTime: { hours: 5, minutes: 59 }, maxPoints: 10, workType: 'ASSIGNMENT', creationTime: '2026-09-12T16:00:00Z', alternateLink: 'https://classroom.google.com/c/x/a/t1' },
  { id: 't1b', title: 'Subida de Tarea 1', dueDate: fecha(2026, 9, 27), dueTime: { hours: 5, minutes: 59 }, maxPoints: 10, workType: 'ASSIGNMENT', creationTime: '2026-09-21T16:00:00Z' },
  { id: 't2', title: 'Tarea 2', dueDate: fecha(2026, 9, 27), maxPoints: 10, workType: 'ASSIGNMENT', creationTime: '2026-09-21T17:00:00Z' },
  { id: 'tf', title: 'Tarea que faltó', dueDate: fecha(2026, 10, 8), dueTime: { hours: 5, minutes: 59 }, maxPoints: 10, workType: 'ASSIGNMENT', creationTime: '2026-10-01T16:00:00Z' },
  { id: 't3', title: 'Tarea 3', dueDate: fecha(2030, 1, 15), maxPoints: 20, workType: 'ASSIGNMENT', creationTime: '2026-10-20T16:00:00Z' }
]
// Nombres como vienen de Classroom: sin acentos, en otro orden, en mayúsculas, con una letra de menos
const alumnosG = [
  ['u-herrera', 'Lorena Patricia', 'Herrera Aranda', 'alumno@alumnos.escuela.edu.mx'],
  ['u-zun', 'Araceli Graciela', 'Tapia Alcantara', ''],
  ['u-hy', 'Martina Noemí', 'Bravo Ugalde', ''],
  ['u-jay', 'Celia', 'Orozco Alcantara', ''],
  ['u-rob', 'RICARDO', 'ARELLANO MURILLO', ''],
  ['u-pacheco', 'Octavio', 'Pacheco Saucedo', ''],
  ['u-mig', 'Arturo Raul', 'Orozco Lemus', ''],
  ['u-enr', 'Alfonso', 'Pineda Campos', ''],
  ['u-nic', 'Ramon Esteban', 'Orozco Gamboa', ''],
  ['u-tad', 'Lorenzo Toledo', 'Valdiva Prado', ''],
  ['u-van', 'Silvia', 'Rangel', ''],
  ['u-jj', 'Ramón Pablo', 'Orozco Carrillo', ''],
  // Ya no está en la lista de Álgebra de la app, y otro que nunca estuvo: se ignoran
  ['u-riv', 'Beatriz Rocío', 'Becerra Villegas', ''],
  ['u-mar', 'Felipe Hugo', 'Varela C.', '']
].map(([id, dado, fam, email]) => ({ courseId: CURSO, userId: id, profile: { id, name: { givenName: dado, familyName: fam, fullName: `${dado} ${fam}` }, ...(email ? { emailAddress: email } : {}) } }))

type Sub = { st: string; late?: boolean; g?: number; dg?: number; adj?: unknown[]; nunca?: boolean }
const E = (o: Partial<Sub> = {}): Sub => ({ st: 'TURNED_IN', ...o })
const N: Sub = { st: 'CREATED' }
// Columnas: 1er Tarea, Subida de Tarea 1, Tarea 2, Tarea que faltó, Tarea 3 — como la hoja «Entregas Classroom»
const matriz: Record<string, Sub[]> = {
  'u-herrera': [E({ g: 8, adj: [{ driveFile: { id: 'f-pdf', title: 'tarea1.pdf', alternateLink: 'https://drive.google.com/file/d/f-pdf/view' } }] }), E({ g: 10, adj: [{ driveFile: { id: 'f-img', title: 'foto.png', alternateLink: 'https://drive.google.com/file/d/f-img/view' } }, { link: { url: 'https://geogebra.org/m/abc', title: 'GeoGebra' } }] }), E({ adj: [{ driveFile: { id: 'f-doc', title: 'Tarea 2 (Documento de Google)', alternateLink: 'https://docs.google.com/document/d/f-doc/edit' } }] }), N, E()],
  'u-zun': [N, N, E({ late: true }), N, N],
  'u-hy': [N, E(), { st: 'RECLAIMED_BY_STUDENT' }, N, N],
  'u-jay': [{ st: 'RETURNED', g: 9 }, N, N, E(), N],
  'u-rob': [E(), E(), E(), E(), N],
  'u-pacheco': [N, N, N, E(), N],
  'u-mig': [N, N, N, N, N],
  'u-enr': [E(), N, N, N, N],
  'u-nic': [E(), E(), E(), E(), N],
  'u-tad': [E(), E(), E(), N, N],
  'u-van': [E(), E(), E(), N, N],
  // Devuelta por el maestro sin que la entregara nunca: no cuenta como entregada
  'u-jj': [{ st: 'RETURNED', g: 0, nunca: true }, N, N, N, N],
  'u-riv': [N, N, N, N, N],
  'u-mar': [N, N, N, N, N]
}
const entregasG = Object.entries(matriz).flatMap(([u, fila]) =>
  fila.map((s, i) => ({
    courseId: CURSO, courseWorkId: tareas[i].id, id: `s-${u}-${tareas[i].id}`, userId: u, state: s.st, late: s.late || undefined,
    assignedGrade: s.g, draftGrade: s.dg, updateTime: '2026-10-10T12:00:00Z', alternateLink: `https://classroom.google.com/s/${u}/${tareas[i].id}`,
    assignmentSubmission: s.adj ? { attachments: s.adj } : {},
    submissionHistory: [
      { stateHistory: { state: 'CREATED', stateTimestamp: '2026-09-12T16:00:00Z' } },
      ...(['TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT'].includes(s.st) && !s.nunca ? [{ stateHistory: { state: 'TURNED_IN', stateTimestamp: `2026-09-${10 + i}T18:00:00Z` } }] : [])
    ]
  }))
)

// Un PDF y un PNG mínimos para Drive
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const archivos: Record<string, { name: string; mimeType: string; datos?: Buffer }> = {
  'f-pdf': { name: 'tarea1.pdf', mimeType: 'application/pdf', datos: PDF },
  'f-img': { name: 'foto.png', mimeType: 'image/png', datos: PNG },
  'f-doc': { name: 'Tarea 2', mimeType: 'application/vnd.google-apps.document' }
}

// ---------- Servidor simulado ----------
const s = { escrituras: 0, reto: '', codigo: 'codigo-123', tokens: new Set<string>(), refrescos: 0, fallas: { 429: 0, 503: 0 }, bloquear: false, revocados: 0, tokensUsados: [] as string[],
  subidos: [] as { nombre: string; mime: string; datos: Buffer }[], permisos: [] as { id: string; type: string; domain?: string }[], negarCualquiera: false }
let pidio429 = false
let pidio503 = false

function json(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(cuerpo))
}
const leerCuerpo = (req: IncomingMessage): Promise<URLSearchParams> =>
  new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(new URLSearchParams(b))) })

/** Pagina de a `n` con nextPageToken como lo hace Classroom. */
function paginado(res: ServerResponse, u: URL, campo: string, lista: unknown[], n: number): void {
  const desde = Number(u.searchParams.get('pageToken') || 0)
  const pagina = lista.slice(desde, desde + n)
  json(res, 200, { [campo]: pagina, ...(desde + n < lista.length ? { nextPageToken: String(desde + n) } : {}) })
}

const servidor = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const p = u.pathname
  if (p === '/o/oauth2/v2/auth') {
    const q = u.searchParams
    const redirect = q.get('redirect_uri')!
    if (s.bloquear) return res.writeHead(302, { Location: `${redirect}?error=admin_policy_enforced&state=${q.get('state')}` }).end()
    const faltan = G.SCOPES.filter((x) => !(q.get('scope') ?? '').split(' ').includes(x))
    if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || q.get('access_type') !== 'offline' || q.get('prompt') !== 'consent' ||
      q.get('login_hint') !== G.CUENTA_MAESTRO || q.get('client_id') !== CLIENT_ID || faltan.length || !/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect)) {
      return res.writeHead(400).end('parámetros incorrectos')
    }
    s.reto = q.get('code_challenge')!
    return res.writeHead(302, { Location: `${redirect}?code=${s.codigo}&state=${q.get('state')}&scope=${encodeURIComponent(G.SCOPES.join(' '))}` }).end()
  }
  if (p === '/token' && req.method === 'POST') {
    const b = await leerCuerpo(req)
    if (b.get('client_id') !== CLIENT_ID || b.get('client_secret') !== SECRET) return json(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' })
    if (b.get('grant_type') === 'authorization_code') {
      const pkceOk = b64url(createHash('sha256').update(b.get('code_verifier') ?? '').digest()) === s.reto
      if (b.get('code') !== s.codigo || !pkceOk || !b.get('redirect_uri')?.startsWith('http://127.0.0.1:')) return json(res, 400, { error: 'invalid_grant', error_description: 'Bad Request' })
      s.tokens.add('at-1')
      return json(res, 200, { access_token: 'at-1', expires_in: 3599, refresh_token: 'rt-1', scope: G.SCOPES.join(' '), token_type: 'Bearer' })
    }
    if (b.get('grant_type') === 'refresh_token') {
      if (b.get('refresh_token') !== 'rt-1') return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
      s.refrescos++
      const nuevo = `at-${s.refrescos + 1}`
      s.tokens.add(nuevo)
      return json(res, 200, { access_token: nuevo, expires_in: 3599, scope: G.SCOPES.join(' '), token_type: 'Bearer' })
    }
  }
  if (p === '/revoke') {
    s.revocados++
    return res.writeHead(200).end()
  }
  // Todo lo demás pide Bearer válido
  const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  if (!s.tokens.has(tok)) return json(res, 401, { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } })
  s.tokensUsados.push(tok)
  // Archivos que el docente adjunta a sus tareas: subida multipart y permiso de lectura
  if (p === '/upload/drive/v3/files' && req.method === 'POST') {
    const partes: Buffer[] = []
    for await (const c of req) partes.push(c as Buffer)
    const cuerpo = Buffer.concat(partes)
    const frontera = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1]
    if (u.searchParams.get('uploadType') !== 'multipart' || !frontera) return json(res, 400, { error: { message: 'multipart' } })
    const trozos = cuerpo.toString('latin1').split(`--${frontera}`).slice(1, -1)
    const meta = JSON.parse(Buffer.from(trozos[0].split('\r\n\r\n')[1].trim(), 'latin1').toString('utf8')) as { name: string; mimeType: string }
    const inicio = cuerpo.indexOf('\r\n\r\n', cuerpo.indexOf(`--${frontera}`, 10)) + 4
    const fin = cuerpo.lastIndexOf(`\r\n--${frontera}--`)
    const id = `subido-${s.subidos.length + 1}`
    s.subidos.push({ nombre: meta.name, mime: meta.mimeType, datos: cuerpo.subarray(inicio, fin) })
    return json(res, 200, { id, name: meta.name, webViewLink: `https://drive.google.com/file/d/${id}/view` })
  }
  const perm = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(p)
  if (perm && req.method === 'POST') {
    const b = await new Promise<string>((r) => { let x = ''; req.on('data', (c) => (x += c)); req.on('end', () => r(x)) })
    const j = JSON.parse(b) as { role: string; type: string; domain?: string }
    if (j.type === 'anyone' && s.negarCualquiera) return json(res, 403, { error: { message: 'The user does not have sufficient permissions for this file. (publishOutNotPermitted)' } })
    s.permisos.push({ id: perm[1], type: j.type, domain: j.domain })
    return json(res, 200, { id: 'p1', role: j.role, type: j.type })
  }
  if (req.method !== 'GET') { s.escrituras++; return json(res, 405, { error: { message: 'solo lectura' } }) }
  if (p === '/v1/userProfiles/me') {
    // El primer token «caduca» aquí: obliga al cliente a refrescar
    s.tokens.delete('at-1')
    return json(res, 200, { id: 'yo', emailAddress: G.CUENTA_MAESTRO, name: { fullName: 'Docente Demo' } })
  }
  if (p === '/v1/courses') {
    if (u.searchParams.get('teacherId') !== 'me' || u.searchParams.get('courseStates') !== 'ACTIVE') return json(res, 400, { error: { message: 'filtros' } })
    if (!pidio429) {
      pidio429 = true
      s.fallas[429]++
      return res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' }).end('{"error":{"status":"RESOURCE_EXHAUSTED"}}')
    }
    return paginado(res, u, 'courses', [
      { id: CURSO, name: 'Álgebra Lineal', section: 'MEC 2A', alternateLink: 'https://classroom.google.com/c/alg', courseState: 'ACTIVE' },
      { id: OTRO, name: 'Otro curso', section: '', courseState: 'ACTIVE' }
    ], 1)
  }
  const m = /^\/v1\/courses\/([^/]+)\/(students|courseWork|courseWork\/-\/studentSubmissions)$/.exec(p)
  if (m) {
    if (m[1] !== CURSO) return json(res, 200, {})
    if (m[2] === 'students') {
      if (!pidio503) {
        pidio503 = true
        s.fallas[503]++
        return json(res, 503, { error: { status: 'UNAVAILABLE' } })
      }
      return paginado(res, u, 'students', alumnosG, 5)
    }
    if (m[2] === 'courseWork') {
      if (u.searchParams.get('courseWorkStates') !== 'PUBLISHED') return json(res, 400, {})
      return paginado(res, u, 'courseWork', tareas, 2)
    }
    return paginado(res, u, 'studentSubmissions', entregasG, 25)
  }
  const d = /^\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(p)
  if (d) {
    const a = archivos[d[1]]
    if (!a) return json(res, 404, { error: { message: 'File not found' } })
    if (d[2]) {
      if (u.searchParams.get('mimeType') !== 'application/pdf') return json(res, 400, {})
      return res.writeHead(200, { 'Content-Type': 'application/pdf' }).end(PDF)
    }
    if (u.searchParams.get('alt') === 'media') return res.writeHead(200, { 'Content-Type': a.mimeType }).end(a.datos)
    return json(res, 200, { id: d[1], name: a.name, mimeType: a.mimeType, size: a.datos ? String(a.datos.length) : undefined, webViewLink: `https://drive.google.com/file/d/${d[1]}/view` })
  }
  json(res, 404, { error: { message: `no simulado: ${p}` } })
})

/** Hace de navegador: sigue la redirección de Google al servidor de un solo uso de la app. */
async function navegador(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'manual' })
  const destino = r.headers.get('location')
  if (!destino) return ''
  return (await fetch(destino)).text()
}

// --servir <puerto>: solo levanta el Google simulado (para probar la pantalla con DOCENTE_GOOGLE_PRUEBAS)
const servir = process.argv.indexOf('--servir')
if (servir > 0) {
  servidor.listen(Number(process.argv[servir + 1]), '127.0.0.1', () => console.log('Google simulado en', servidor.address()))
} else void (async () => {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
  process.env.DOCENTE_GOOGLE_PRUEBAS = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  const tmp = mkdtempSync(join(tmpdir(), 'qa-classroom-'))
  try {
    console.log('Conexión (OAuth de escritorio con PKCE):')
    const { verificador, reto } = G.pkce()
    ok('PKCE S256: reto = base64url(sha256(verificador))', reto === b64url(createHash('sha256').update(verificador).digest()) && verificador.length >= 43)
    let validos = 0
    for (const id of [CLIENT_ID, 'x.apps.googleusercontent.com']) { try { G.validarClientId(id); validos++ } catch { /* */ } }
    let rechazado = false
    try { G.validarClientId('sk-ant-123') } catch { rechazado = true }
    ok('valida el formato del Client ID', validos === 2 && rechazado)
    ok('las URLs de prueba solo se aceptan en 127.0.0.1', G.urlsGoogle().token.startsWith('http://127.0.0.1:'))
    const prev = process.env.DOCENTE_GOOGLE_PRUEBAS
    process.env.DOCENTE_GOOGLE_PRUEBAS = 'http://evil.example.com'
    ok('…y una URL ajena se ignora', G.urlsGoogle().token === 'https://oauth2.googleapis.com/token')
    process.env.DOCENTE_GOOGLE_PRUEBAS = prev

    let pagina = ''
    const t = await G.iniciarSesion({ clientId: CLIENT_ID, clientSecret: SECRET, abrir: (url) => { void navegador(url).then((h) => (pagina = h)) } })
    ok('canjea el código con PKCE y recibe refresh_token', t.access_token === 'at-1' && t.refresh_token === 'rt-1')
    await new Promise((r) => setTimeout(r, 100))
    ok('el navegador ve «Listo, ya puedes volver a App_Docente»', pagina.includes('Listo, ya puedes volver a App_Docente'))
    ok('se concedieron los 4 permisos de Classroom y el de Drive', G.SCOPES.every((x) => t.scope.includes(x)))

    s.bloquear = true
    let msg = ''
    await G.iniciarSesion({ clientId: CLIENT_ID, clientSecret: SECRET, abrir: (url) => void navegador(url) }).catch((e: Error) => (msg = e.message))
    ok('admin_policy_enforced → explica que la escuela bloquea la app', /escuela/.test(msg) && /Sistemas/.test(msg), msg)
    s.bloquear = false
    msg = ''
    await G.iniciarSesion({ clientId: CLIENT_ID, clientSecret: SECRET, abrir: () => undefined, limiteMs: 150 }).catch((e: Error) => (msg = e.message))
    ok('tiempo límite del inicio de sesión', /minutos/.test(msg), msg)
    msg = ''
    await G.refrescar(CLIENT_ID, SECRET, 'rt-viejo').catch((e: Error) => (msg = e.message))
    ok('invalid_grant → pide reconectar y menciona los 7 días del modo Prueba', /Conectar otra vez/.test(msg) && /7 días/.test(msg), msg)
    msg = ''
    await G.refrescar(CLIENT_ID, 'otro', 'rt-1').catch((e: Error) => (msg = e.message))
    ok('invalid_client → revisar Client ID y Secret', /Client ID/.test(msg), msg)

    // Token como lo maneja la app: se refresca cuando vence o cuando Google lo rechaza
    let acceso = { token: t.access_token, expira: t.expira }
    const token: G.ObtenerToken = async (forzar = false) => {
      if (!forzar && Date.now() < acceso.expira) return acceso.token
      const n = await G.refrescar(CLIENT_ID, SECRET, 'rt-1')
      acceso = { token: n.access_token, expira: n.expira }
      return n.access_token
    }
    const perfil = await G.leerPerfil(token)
    ok('lee el correo de la cuenta (userProfiles/me)', perfil.emailAddress === G.CUENTA_MAESTRO)

    console.log('Sincronización (copia de la base):')
    const real = join(process.env.HOME ?? '', 'Library/Application Support/app-docente/datos/docente.sqlite')
    const copia = join(tmp, 'docente.sqlite')
    // Con la base del docente se prueba sobre una copia; sin ella, sobre una base nueva con su materia
    if (existsSync(real)) execFileSync('sqlite3', ['-readonly', real, `VACUUM INTO '${copia}'`])
    else abrirBase(copia).close()
    const db = new Database(copia)
    db.pragma('foreign_keys = ON')
    if (!db.prepare("SELECT 1 FROM materias WHERE nombre LIKE '%lgebra%'").get()) {
      const carrera = Number(db.prepare("INSERT INTO carreras (nombre) VALUES ('Ingeniería de prueba')").run().lastInsertRowid)
      const periodo = Number(db.prepare("INSERT INTO periodos (nombre, fecha_inicio, semanas) VALUES ('Cuatrimestre', '2026-08-31', 14)").run().lastInsertRowid)
      db.prepare("INSERT INTO materias (carrera_id, periodo_id, nombre) VALUES (?, ?, 'Álgebra Lineal')").run(carrera, periodo)
    }
    const materia = (db.prepare("SELECT id FROM materias WHERE nombre LIKE '%lgebra%' ORDER BY id LIMIT 1").get() as { id: number } | undefined)?.id
    if (!materia) throw new Error('La copia no tiene la materia de Álgebra')
    // La lista de Álgebra que la prueba espera en la app (nombres inventados). Becerra NO va: ya no está en la lista.
    for (const [nombre, apellidos] of [
      ['Lorena Patricia', 'Herrera Aranda'], ['Araceli Graciela', 'Tapia Alcántara'], ['Martina Noemí', 'Bravo Ugalde'],
      ['Celia', 'Orozco Alcántara'], ['Ricardo', 'Arellano Murillo'], ['Octavio', 'Pacheco Saucedo'], ['Arturo Raúl', 'Orozco Lemus'],
      ['Alfonso', 'Pineda Campos'], ['Ramón Esteban', 'Orozco Gamboa'], ['Lorenzo Toledo', 'Valdivia Prado'],
      ['Silvia Elena', 'Rangel Rangel'], ['Paulina', 'Serrano Mondragon']
    ]) {
      const ya = db.prepare('SELECT id FROM alumnos WHERE apellidos = ? AND nombre = ?').get(apellidos, nombre) as { id: number } | undefined
      const id = ya?.id ?? Number(db.prepare('INSERT INTO alumnos (nombre, apellidos) VALUES (?, ?)').run(nombre, apellidos).lastInsertRowid)
      db.prepare('INSERT OR IGNORE INTO inscripciones (materia_id, alumno_id) VALUES (?, ?)').run(materia, id)
    }
    // Sin datos de Classroom previos en la copia
    for (const tb of ['classroom_comodin_decisiones', 'classroom_comodines', 'classroom_tareas_grupo', 'classroom_tareas_app', 'classroom_entregas', 'classroom_tareas', 'classroom_alumnos', 'classroom_cursos']) {
      db.exec(`DROP TABLE IF EXISTS ${tb}`)
    }
    const inicioRefrescos = s.refrescos
    const sincronizar = async (): Promise<void> => {
      D.guardarCursos(db, await G.leerCursos(token))
      for (const c of D.listarCursos(db).filter((c) => c.activo && c.materia_id)) {
        D.guardarCurso(db, c.id, await G.leerAlumnos(token, c.id), await G.leerTareas(token, c.id), await G.leerEntregas(token, c.id))
        D.empatarMateria(db, c.materia_id!)
      }
    }
    await sincronizar()
    ok('refresca el token cuando Google lo rechaza (401 → refresh → reintento)', s.refrescos === inicioRefrescos + 1 && s.tokensUsados.includes(`at-${s.refrescos + 1}`))
    ok('reintenta ante 429 (Retry-After) y 503', s.fallas[429] === 1 && s.fallas[503] === 0)
    ok('lee los cursos paginados (2 páginas)', D.listarCursos(db).length === 2)
    D.ligarCurso(db, CURSO, materia)
    await sincronizar()
    ok('reintenta ante 503 al leer alumnos', s.fallas[503] === 1)
    const cuenta = (): string => ['classroom_cursos', 'classroom_alumnos', 'classroom_tareas', 'classroom_entregas'].map((tb) => (db.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get() as { n: number }).n).join('/')
    const despues1 = cuenta()
    ok(`guarda todo lo del curso ligado (cursos/alumnos/tareas/entregas = ${despues1})`, despues1 === `2/${alumnosG.length}/${tareas.length}/${entregasG.length}`)
    await sincronizar()
    ok('re-sincronizar no duplica nada', cuenta() === despues1)

    console.log('Empate de alumnos:')
    let r = D.resumenMateria(db, materia)
    const por = (u: string) => r.alumnos.find((a) => a.user_id === u)
    // La lista real puede cambiar de acentos: se busca sin ellos
    const sinAcentos = (x: string): string => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const appAlumnos = db.prepare('SELECT id, nombre, apellidos FROM alumnos').all() as { id: number; nombre: string; apellidos: string }[]
    const idApp = (ap: string): number | undefined => appAlumnos.find((a) => sinAcentos(a.apellidos) === sinAcentos(ap))?.id
    const nombreApp = (ap: string): string => { const a = appAlumnos.find((x) => sinAcentos(x.apellidos) === sinAcentos(ap))!; return `${a.apellidos} ${a.nombre}` }
    ok('«Araceli Graciela Tapia Alcantara» = «Tapia Alcántara Araceli Graciela» (acentos y ñ)', por('u-zun')?.alumno_id === idApp('Tapia Alcántara') && por('u-zun')?.liga === 'nombre')
    ok('mayúsculas: «RICARDO ARELLANO MURILLO»', por('u-rob')?.alumno_id === idApp('Arellano Murillo'))
    ok('una letra de menos: «Valdiva Prado» = «Valdivia Prado»', por('u-tad')?.alumno_id === idApp('Valdivia Prado'))
    const van = r.sin_ligar.classroom.find((x) => x.user_id === 'u-van')
    ok('incompleto («Silvia Rangel») queda sin ligar con sugerencia', !!van && van.liga === 'dudoso' && van.sugerido?.apellidos === 'Rangel Rangel')
    ok('quien no está en la app («Ramón Pablo Orozco Carrillo») queda sin ligar', r.sin_ligar.classroom.some((x) => x.user_id === 'u-jj' && !x.sugerido))
    ok('los de la app que no están en Classroom salen en «Sin ligar»', r.sin_ligar.app.some((a) => a.apellidos === 'Serrano Mondragon'))
    const ignorados = ['u-jj', 'u-riv', 'u-mar', 'u-van']
    ok('los que no están en tu lista no entran a la tabla ni a los totales', ignorados.every((u) => !por(u) && !r.entregas.some((e) => e.alumno === `${CURSO}:${u}`)))
    ok('…y quedan como ignorados (Becerra ya no está en la lista de Álgebra)', ['u-jj', 'u-riv', 'u-mar'].every((u) => r.sin_ligar.classroom.some((x) => x.user_id === u && !x.sugerido)))
    const antesAlumnos = (db.prepare('SELECT COUNT(*) AS n FROM alumnos').get() as { n: number }).n
    D.ligarAlumno(db, CURSO, 'u-van', idApp('Rangel Rangel')!)
    D.ligarAlumno(db, CURSO, 'u-jj', 'ajeno')
    await sincronizar()
    r = D.resumenMateria(db, materia)
    ok('la liga a mano y «no es de mi grupo» se respetan al re-sincronizar', por('u-van')?.liga === 'manual' && !por('u-jj') && r.sin_ligar.ajenos.some((x) => x.user_id === 'u-jj'))
    ok('nunca crea alumnos en la app', (db.prepare('SELECT COUNT(*) AS n FROM alumnos').get() as { n: number }).n === antesAlumnos)

    console.log('Estados de entrega (tareas de Classroom tal cual):')
    const celda = (u: string, t: string) => r.entregas.find((e) => e.alumno === `${CURSO}:${u}` && e.tarea === `${CURSO}:${t}`)
    ok('entregó tarde', celda('u-zun', 't2')?.estado === 'tarde')
    ok('devuelta con calificación = entregó, 9/10', celda('u-jay', 't1')?.estado === 'entrego' && celda('u-jay', 't1')?.calificacion === 9 && celda('u-jay', 't1')?.puntos === 10)
    ok('sin entregar con fecha vencida = no entregó', celda('u-mig', 't1')?.estado === 'no_entrego')
    ok('sin entregar y aún no vence = pendiente', celda('u-mig', 't3')?.estado === 'pendiente')
    ok('la retiró', celda('u-hy', 't2')?.estado === 'retirada')
    ok('fecha sin hora = fin del día en Ciudad de México', r.tareas.find((x) => x.id === 't2')?.vence === '2026-09-28T05:59:59.000Z')
    ok('adjuntos guardados (2 en «Subida de Tarea 1» de Herrera)', celda('u-herrera', 't1b')?.adjuntos === 2)
    const det = D.detalleEntrega(db, CURSO, 's-u-herrera-t1b')
    ok('detalle con adjuntos de Drive y enlace', det.adjuntos.some((a) => a.tipo === 'drive' && a.id === 'f-img') && det.adjuntos.some((a) => a.tipo === 'enlace'))

    console.log('Tareas de la app (duplicados y comodín, caso real de Álgebra):')
    const sug = r.consolidado.sugerencias
    const g1 = sug.grupos.find((g) => g.nombre === 'Tarea 1')
    ok('sugiere «Tarea 1» = «1er Tarea» + «Subida de Tarea 1»', !!g1 && g1.tareas.map((x) => x.titulo).sort().join('|') === '1er Tarea|Subida de Tarea 1')
    ok('sugiere «Tarea 2» y «Tarea 3» aparte', sug.grupos.some((g) => g.nombre === 'Tarea 2' && g.tareas.length === 1) && sug.grupos.some((g) => g.nombre === 'Tarea 3'))
    ok('sugiere «Tarea que faltó» como comodín', sug.comodines.map((x) => x.titulo).join() === 'Tarea que faltó')
    T.aceptarSugerencias(db, materia, sug)
    await sincronizar()
    r = D.resumenMateria(db, materia)
    const c = r.consolidado
    const col = (n: string) => c.tareas.find((x) => x.nombre === n)!
    ok('vista consolidada: Tarea 1, Tarea 2, Tarea 3 (sin la comodín como columna)', c.tareas.map((x) => x.nombre).join('|') === 'Tarea 1|Tarea 2|Tarea 3')
    ok('la comodín cubre Tarea 1 y Tarea 2 (las anteriores), no la 3', c.comodines[0]?.cubre_efectivo.join() === [col('Tarea 1').id, col('Tarea 2').id].join())
    const lc = (u: string, n: string) => c.celdas.find((x) => x.alumno === `${CURSO}:${u}` && x.tarea_app === col(n).clave)
    const si = (u: string, n: string): string => (['entrego', 'tarde'].includes(lc(u, n)?.estado ?? '') ? 'Sí' : 'No')
    // Lo que el maestro resolvió a mano en su hoja «Entregas Classroom»
    const hoja: [string, string, string, string][] = [
      ['u-herrera', 'Sí', 'Sí', 'Tarea 1 en «Subida de Tarea 1» (también en «1er Tarea») · Tarea 2 en «Tarea 2»'],
      ['u-zun', 'No', 'Sí', 'Tarea 2 en «Tarea 2»'],
      ['u-hy', 'Sí', 'No', 'Tarea 1 en «Subida de Tarea 1»'],
      ['u-jay', 'Sí', 'Sí', 'Tarea 1 en «1er Tarea» · Tarea 2 en «Tarea que faltó»'],
      ['u-rob', 'Sí', 'Sí', '«Tarea que faltó» entregada además de las dos'],
      ['u-pacheco', 'Sí', 'No', '«Tarea que faltó» aplicada a Tarea 1 — decide cuál acreditar'],
      ['u-mig', 'No', 'No', 'Sin entregas'],
      ['u-enr', 'Sí', 'No', 'Tarea 1 en «1er Tarea»']
    ]
    for (const [u, t1, t2, como] of hoja) {
      const res = c.resolucion[`${CURSO}:${u}`] ?? ''
      ok(`${por(u)?.nombre}: T1 ${t1}, T2 ${t2} · ${como}`, si(u, 'Tarea 1') === t1 && si(u, 'Tarea 2') === t2 && res.includes(como), `T1 ${si(u, 'Tarea 1')} T2 ${si(u, 'Tarea 2')} · ${res}`)
    }
    ok('entregó dos veces la Tarea 1: cuenta la calificación más alta (10)', lc('u-herrera', 'Tarea 1')?.veces === 2 && lc('u-herrera', 'Tarea 1')?.calificacion === 10 && lc('u-herrera', 'Tarea 1')?.otras.length === 1)
    T.actualizarTareaApp(db, col('Tarea 1').id!, { regla: 'ultima' })
    r = D.resumenMateria(db, materia)
    ok('regla «la última»: cuenta la entrega más reciente', r.consolidado.celdas.find((x) => x.alumno === `${CURSO}:u-herrera` && x.tarea_app === col('Tarea 1').clave)?.cuenta?.titulo === 'Subida de Tarea 1')
    T.actualizarTareaApp(db, col('Tarea 1').id!, { regla: 'alta' })
    ok('la comodín de Octavio queda «por revisar» (ambigua)', c.por_revisar.ambiguas.length === 1 && c.por_revisar.ambiguas[0].user_id === 'u-pacheco' && lc('u-pacheco', 'Tarea 1')?.ambigua === true)
    ok('«Por revisar» no repite duplicados: Herrera aparece una sola vez por tarea', c.por_revisar.sin_calificar.filter((x) => x.alumno === `${CURSO}:u-herrera` && x.tarea_app === col('Tarea 1').clave).length === 0 &&
      c.por_revisar.sin_calificar.filter((x) => x.alumno === `${CURSO}:u-hy`).length === 1)
    ok('los ignorados no salen en «Por revisar»', ['u-jj', 'u-riv', 'u-mar'].every((u) => !c.por_revisar.sin_entrega.some((x) => x.alumno === `${CURSO}:${u}`) && !c.totales[`${CURSO}:${u}`]))
    ok('«Por revisar» lista los vencidos sin entrega ya consolidados', c.por_revisar.sin_entrega.some((x) => x.alumno === `${CURSO}:u-mig` && x.tarea_nombre === 'Tarea 1') && !c.por_revisar.sin_entrega.some((x) => x.alumno === `${CURSO}:u-hy` && x.tarea_nombre === 'Tarea 1'))
    T.decidirComodin(db, `${CURSO}:tf`, 'u-pacheco', col('Tarea 2').id!)
    await sincronizar()
    await sincronizar()
    r = D.resumenMateria(db, materia)
    const lc2 = (u: string, n: string) => r.consolidado.celdas.find((x) => x.alumno === `${CURSO}:${u}` && x.tarea_app === col(n).clave)
    ok('la decisión del maestro (Octavio → Tarea 2) se respeta tras re-sincronizar dos veces', lc2('u-pacheco', 'Tarea 2')?.estado === 'entrego' && lc2('u-pacheco', 'Tarea 2')?.comodin === true &&
      lc2('u-pacheco', 'Tarea 1')?.estado === 'no_entrego' && r.consolidado.por_revisar.ambiguas.length === 0)
    ok('sigue sin duplicar tras agrupar y decidir', cuenta() === despues1)

    // Las tareas consolidadas llegan al esquema de calificación (rubros «Tarea 1» y «Tarea 2» del parcial 1 de Álgebra)
    if (db.prepare("SELECT 1 FROM calif_parciales WHERE materia_id = ? AND orden = 1").get(materia)) {
      const aCal = classroomACalificaciones(db, materia, 1)
      const capt = (u: string, rubro: number) => {
        const alumno = r.alumnos.find((a) => a.clave === `${CURSO}:${u}`)?.alumno_id
        return db.prepare("SELECT k.valor, k.entregado FROM calif_capturas k JOIN calif_componentes c ON c.id = k.componente_id JOIN calif_parciales p ON p.id = c.parcial_id WHERE p.materia_id = ? AND p.orden = 1 AND c.nombre = 'Tareas' AND k.alumno_id = ? AND k.rubro = ?").get(materia, alumno, rubro) as { valor: number | null; entregado: number } | undefined
      }
      ok(`Classroom → calificaciones: ${aCal.tareas.join(', ')} (${aCal.capturas} capturas)`, aCal.tareas.join() === 'Tarea 1,Tarea 2' && aCal.capturas > 0)
      ok('Herrera: Tarea 1 entregada con su calificación (10 → 10 sobre 10)', capt('u-herrera', 0)?.entregado === 1 && capt('u-herrera', 0)?.valor === 10)
      ok('Orozco Lemus: sin entregas → «No» en las dos tareas', capt('u-mig', 0)?.entregado === 0 && capt('u-mig', 1)?.entregado === 0)
    } else ok('(la copia no tiene esquema de Álgebra: se omite Classroom → calificaciones)', true)

    console.log('Excel «Entregas Classroom»:')
    const xlsx = join(tmp, 'entregas.xlsx')
    await libroEntregas(r, 'Álgebra Lineal').xlsx.writeFile(xlsx)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsx)
    const h = wb.getWorksheet('Entregas Classroom')!
    const enc = (h.getRow(3).values as unknown[]).map(String)
    ok('columnas de cada tarea de Classroom, ¿Entregó Tarea 1/2? y «Cómo se resolvió»', enc.some((x) => x.startsWith('1er Tarea')) && enc.includes('¿Entregó Tarea 1?') && enc.includes('¿Entregó Tarea 2?') && enc.includes('Cómo se resolvió'))
    let filaNava: unknown[] = []
    h.eachRow((row) => { if (String(row.getCell(1).value).includes('Pacheco Saucedo')) filaNava = row.values as unknown[] })
    const iT2 = enc.indexOf('¿Entregó Tarea 2?')
    ok('fila de Octavio: T2 «Sí» por la comodín', filaNava[iT2] === 'Sí' && String(filaNava[filaNava.length - 1]).includes('Tarea 2 en «Tarea que faltó»'), JSON.stringify(filaNava))
    let serrano = false
    let ignoradoEnExcel = false
    h.eachRow((row) => {
      const v = String(row.values)
      if (v.includes('Serrano Mondragon') && v.includes('No aparece en la lista de Classroom')) serrano = true
      if (/Orozco Carrillo|Becerra Villegas|Varela C\./.test(v)) ignoradoEnExcel = true
    })
    ok('incluye a quien está en la lista pero no en Classroom', serrano)
    ok('no incluye a los ignorados (en Classroom, no en tu lista)', !ignoradoEnExcel)

    console.log('Drive (vista previa y descarga):')
    const pdf = await G.bajarArchivo(token, 'f-pdf')
    ok('baja un PDF (alt=media)', pdf.subarray(0, 5).toString() === '%PDF-')
    ok('baja una imagen', (await G.bajarArchivo(token, 'f-img')).equals(PNG))
    ok('exporta un Documento de Google a PDF (files/{id}/export)', (await G.bajarArchivo(token, 'f-doc', 'application/pdf')).subarray(0, 5).toString() === '%PDF-')
    ok('metadatos de Drive (nombre, tipo, tamaño)', (await G.leerArchivo(token, 'f-img')).size === String(PNG.length))
    msg = ''
    await G.leerArchivo(token, 'no-existe').catch((e: Error) => (msg = e.message))
    ok('archivo inexistente → mensaje claro', /No se encontró/.test(msg), msg)
    let ajeno = false
    try { D.adjuntoDeEntrega(db, CURSO, 's-u-herrera-t1', 'f-img') } catch { ajeno = true }
    ok('solo se pueden pedir archivos que pertenecen a esa entrega', ajeno && D.adjuntoDeEntrega(db, CURSO, 's-u-herrera-t1', 'f-pdf').adjunto.titulo === 'tarea1.pdf')
    ok('nombre para descargar: «Apellidos Nombre»', D.nombreParaArchivo(db, CURSO, 'u-herrera') === nombreApp('Herrera Aranda') && D.nombreParaArchivo(db, CURSO, 'u-jj') === 'Orozco Carrillo Ramón Pablo')
    ok('a Classroom y Drive solo se les hizo GET (solo lectura)', s.escrituras === 0)

    console.log('Archivos adjuntos a las tareas (Drive):')
    ok('se pide el permiso drive.file (solo los archivos que sube la app)', G.SCOPES.includes(G.SCOPE_SUBIR) && G.SCOPE_SUBIR.endsWith('/drive.file'))
    const word = Buffer.concat([Buffer.from('PK\u0003\u0004'), randomBytes(5000), Buffer.from('\r\n--falsa--\r\n')])
    const a1 = await G.subirArchivoG(token, 'Instrucciones Tarea 3 ñ.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', word, 'escuela.edu.mx')
    ok('sube el archivo íntegro con su nombre y tipo', s.subidos[0]?.datos.equals(word) && s.subidos[0].nombre === 'Instrucciones Tarea 3 ñ.docx' && s.subidos[0].mime.includes('wordprocessingml'))
    ok('queda visible con el enlace (cualquiera con el enlace)', a1.compartido === 'enlace' && s.permisos.some((x) => x.id === a1.id && x.type === 'anyone') && a1.enlace.includes(a1.id))
    s.negarCualquiera = true
    const a2 = await G.subirArchivoG(token, 'rubrica.pdf', 'application/pdf', PDF, 'escuela.edu.mx')
    ok('si la universidad no deja «cualquiera», se comparte con su dominio', a2.compartido === 'dominio' && s.permisos.some((x) => x.id === a2.id && x.type === 'domain' && x.domain === 'escuela.edu.mx'))
    db.close()
  } finally {
    servidor.close()
    servidor.closeAllConnections()
    rmSync(tmp, { recursive: true, force: true })
    ok('la copia temporal se borró', !existsSync(tmp))
  }
  if (fallos) {
    console.log(`${fallos} fallo(s) en Classroom`)
    process.exitCode = 1
  }
})().catch((e) => {
  console.error('  ✗ la prueba se detuvo:', e)
  process.exitCode = 1
  servidor.close()
})
