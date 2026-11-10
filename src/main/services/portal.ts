import { app, BrowserWindow, shell, utilityProcess, type UtilityProcess } from 'electron'
import { join, delimiter } from 'path'
import { existsSync } from 'fs'
import QRCode from 'qrcode'
import { getDb, getAjuste, setAjuste, dataDir } from '../db'
import { carpetasPyodide } from './pyodide'
import { buscarUsuarioPorNombre, crearCodigoAcceso, asegurarDocente } from '../../servidor/auth'
import { direccionesLocales } from '../../servidor/red'
import { notificacionesDe, marcarLeidas } from '../../servidor/servicios'
import { crearPartida } from '../../servidor/partidas'
import type { Notificacion } from '../../shared/portal'
import { mostrarAviso } from './avisos'
import type { MensajeAlProceso, MensajeDelProceso } from '../portal-proceso'
import { configRemoto, sincronizar, arrancarSincronizacion, detenerSincronizacion, estadoSincro, accionRemota, type EstadoSincro } from './portal-remoto'
import { crearAccesosAlumnos, crearAccesoAlumno, reiniciarPasswordAlumno, type AccesoCreado } from '../../servidor/auth'
import { enviarAviso } from '../../servidor/portalAlumno'
import { problemaPassword } from '../../shared/password'

/**
 * El portal de alumnos lo sirve la app de escritorio, sobre la misma base de datos, pero en un proceso
 * aparte (dist/main/portal-proceso.js) para que el trabajo pesado del docente no lo congele.
 * Lo que la app hace directo en la base (accesos, partidas, códigos, avisos) sigue aquí con su conexión.
 * Los alumnos entran desde la red del salón o desde internet si se publica la dirección.
 */
let proceso: UtilityProcess | null = null
let puertoActivo = 0
let vigilante: NodeJS.Timeout | null = null
let ultimaNotificacionAvisada = 0
/** Por qué no está encendido como se esperaba (no arrancó o se cayó). Se limpia al encender o apagar a mano. */
let falla = ''
let ultimoReinicio = 0
/** Procesos que se mandaron cerrar: su salida no es una caída. */
const despedidos = new WeakSet<UtilityProcess>()

export const PUERTO_POR_OMISION = 8787

export interface EstadoPortal {
  encendido: boolean
  puerto: number
  urls: string[]
  url_publica: string
  docente_usuario: string
  docente_configurado: boolean
  auto_iniciar: boolean
  /** Los alumnos ven «Mi avance» (calificaciones por parcial y faltas) en el portal */
  avance_alumnos: boolean
  portal_compilado: boolean
  no_leidas: number
  falla: string
  /** El portal vive en internet (VPS) y esta app se sincroniza con él */
  en_linea: boolean
  sincro: EstadoSincro | null
}

/** Usuario docente: el del servidor en línea o el que se configuró aquí. */
const usuarioDocente = (): string => configRemoto()?.docente || getAjuste('portal_docente_usuario')
let sincronizando = false

function carpetaPortal(): string {
  // En desarrollo el portal compilado vive en dist/portal; empaquetado, dentro del asar junto a dist/main
  const candidatos = [join(__dirname, '../portal'), join(app.getAppPath(), 'dist/portal')]
  return candidatos.find((c) => existsSync(join(c, 'index.html'))) ?? candidatos[0]
}

export function estadoPortal(): EstadoPortal {
  const db = getDb()
  const usuario = usuarioDocente()
  const docente = usuario ? buscarUsuarioPorNombre(db, usuario) : undefined
  const puerto = puertoActivo || Number(getAjuste('portal_puerto', String(PUERTO_POR_OMISION)))
  const remoto = configRemoto()
  if (remoto) {
    const sincro = estadoSincro()
    return {
      encendido: sincronizando,
      puerto: 443,
      urls: [remoto.url],
      url_publica: remoto.url,
      docente_usuario: usuario,
      docente_configurado: true,
      auto_iniciar: true,
      avance_alumnos: getAjuste('portal_alumno_avance', '1') === '1',
      portal_compilado: true,
      no_leidas: docente ? notificacionesDe(db, docente.id, true).length : 0,
      falla: sincro.falla ? `No se pudo sincronizar con el portal en línea: ${sincro.falla}` : '',
      en_linea: true,
      sincro
    }
  }
  return {
    encendido: proceso !== null,
    puerto,
    urls: proceso ? [`http://localhost:${puerto}`, ...direccionesLocales().map((ip) => `http://${ip}:${puerto}`)] : [],
    url_publica: getAjuste('portal_url_publica'),
    docente_usuario: usuario,
    docente_configurado: Boolean(docente),
    auto_iniciar: getAjuste('portal_auto', '1') === '1',
    avance_alumnos: getAjuste('portal_alumno_avance', '1') === '1',
    portal_compilado: existsSync(join(carpetaPortal(), 'index.html')),
    no_leidas: docente ? notificacionesDe(db, docente.id, true).length : 0,
    falla,
    en_linea: false,
    sincro: null
  }
}

/** Arranque en curso: el automático al abrir y un clic en «Encender» no deben pedir dos veces el puerto (EADDRINUSE falso). */
let arrancando: Promise<EstadoPortal> | null = null

export function iniciarPortal(puerto = Number(getAjuste('portal_puerto', String(PUERTO_POR_OMISION)))): Promise<EstadoPortal> {
  // En línea no se levanta el servidor local: sus datos quedarían desfasados del de internet
  if (configRemoto()) {
    if (!sincronizando) {
      sincronizando = true
      // Lo que ya estaba en el servidor al abrir la app no se anuncia: solo lo que llegue después
      let primera = true
      arrancarSincronizacion(() => {
        if (primera && !estadoSincro().falla) {
          primera = false
          ultimaNotificacionAvisada = Math.max(0, ...notificacionesDocente().map((n) => n.id))
        } else if (!primera) revisarNovedades()
        avisarVentanas()
      })
    }
    return Promise.resolve(estadoPortal())
  }
  if (proceso) return Promise.resolve(estadoPortal())
  if (!arrancando) falla = ''
  arrancando ??= arrancarPortal(puerto).finally(() => (arrancando = null))
  return arrancando
}

async function arrancarPortal(puerto: number): Promise<EstadoPortal> {
  getDb() // el esquema y las migraciones quedan al día antes de que el otro proceso abra la base
  const p = utilityProcess.fork(join(__dirname, 'portal-proceso.js'), [], {
    serviceName: 'Portal App_Docente',
    env: {
      ...process.env,
      PORTAL_BASE: join(dataDir(), 'docente.sqlite'),
      PORTAL_ENTREGAS: join(dataDir(), 'entregas'),
      PORTAL_CARPETA: carpetaPortal(),
      PORTAL_PYODIDE: carpetasPyodide().join(delimiter),
      PORTAL_PUERTO: String(puerto)
    }
  })
  try {
    puertoActivo = await new Promise<number>((resolver, rechazar) => {
      const limite = setTimeout(() => rechazar(new Error('El servidor del portal no respondió al arrancar.')), 20_000)
      p.on('message', (m: MensajeDelProceso) => {
        clearTimeout(limite)
        if (m.tipo === 'listo') return resolver(m.puerto)
        rechazar(m.codigo === 'EADDRINUSE' ? new Error(`El puerto ${puerto} ya está ocupado por otro programa. Cambia el puerto en Ajustes.`) : new Error(m.mensaje))
      })
      p.once('exit', (codigo) => {
        clearTimeout(limite)
        rechazar(new Error(`El servidor del portal se cerró al arrancar (código ${codigo}).`))
      })
    })
  } catch (e) {
    despedidos.add(p)
    p.kill()
    falla = (e as Error).message
    throw e
  }
  proceso = p
  p.once('exit', (codigo) => alCaerse(p, codigo))
  arrancarVigilante()
  return estadoPortal()
}

/**
 * Si el servidor se cae, la app sigue. Se reinicia solo una vez; si vuelve a caer antes de un minuto
 * se queda apagado con el motivo para que el docente lo encienda cuando quiera.
 */
function alCaerse(p: UtilityProcess, codigo: number): void {
  if (despedidos.has(p) || proceso !== p) return
  proceso = null
  puertoActivo = 0
  detenerVigilante()
  console.error(`[portal] el servidor se cerró inesperadamente (código ${codigo})`)
  const reciente = Date.now() - ultimoReinicio < 60_000
  if (reciente) {
    falla = `El servidor del portal se cerró inesperadamente (código ${codigo}) por segunda vez en un minuto. Enciéndelo de nuevo cuando quieras.`
  } else {
    ultimoReinicio = Date.now()
    falla = `El servidor del portal se cerró inesperadamente (código ${codigo}) y se volvió a encender solo.`
    arrancando ??= arrancarPortal(Number(getAjuste('portal_puerto', String(PUERTO_POR_OMISION)))).finally(() => (arrancando = null))
    arrancando
      .catch((e) => (falla = `El servidor del portal se cerró inesperadamente (código ${codigo}) y no pudo volver a encender: ${(e as Error).message}`))
      .finally(() => avisarVentanas())
  }
  avisarVentanas()
}

/** La pestaña Portal y la barra lateral releen el estado con este aviso. */
function avisarVentanas(nuevas: Notificacion[] = []): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('portal:novedades', nuevas)
}

export async function detenerPortal(): Promise<EstadoPortal> {
  if (configRemoto()) {
    detenerSincronizacion()
    sincronizando = false
    return estadoPortal()
  }
  if (arrancando) await arrancando.catch(() => undefined)
  detenerVigilante()
  falla = ''
  const p = proceso
  if (p) {
    proceso = null
    puertoActivo = 0
    despedidos.add(p)
    await new Promise<void>((resolver) => {
      const limite = setTimeout(() => (p.kill(), resolver()), 5000)
      p.once('exit', () => (clearTimeout(limite), resolver()))
      p.postMessage({ tipo: 'detener' } satisfies MensajeAlProceso)
    })
  }
  return estadoPortal()
}

/** Guarda o actualiza la cuenta del docente y liga todas las materias sin dueño a ella. */
export function configurarDocente(nombre: string, usuario: string, password: string): EstadoPortal {
  if (!usuario.trim()) throw new Error('El usuario es obligatorio.')
  // En línea el servidor reconoce a su docente principal por el usuario: aquí solo se cambia la contraseña
  if (configRemoto() && usuario.trim().toLowerCase() !== usuarioDocente().toLowerCase()) throw new Error('Con el portal en línea, desde aquí solo se cambia la contraseña; el usuario se queda igual.')
  const problema = problemaPassword(password)
  if (problema) throw new Error(problema)
  const db = getDb()
  // «Cambiar contraseña» no pide el nombre: se conserva el que ya tiene
  const id = asegurarDocente(db, nombre.trim() || buscarUsuarioPorNombre(db, usuario)?.nombre || usuario.trim(), usuario.trim(), password)
  db.prepare('UPDATE materias SET docente_id = ? WHERE docente_id IS NULL').run(id)
  setAjuste('portal_docente_usuario', usuario.trim())
  return estadoPortal()
}

export function guardarAjustesPortal(a: { puerto?: number; url_publica?: string; auto_iniciar?: boolean; avance_alumnos?: boolean }): EstadoPortal {
  if (a.puerto !== undefined) {
    if (!Number.isInteger(a.puerto) || a.puerto < 1024 || a.puerto > 65535) throw new Error('El puerto debe estar entre 1024 y 65535.')
    setAjuste('portal_puerto', String(a.puerto))
  }
  if (a.url_publica !== undefined) setAjuste('portal_url_publica', a.url_publica.trim().replace(/\/+$/, ''))
  if (a.auto_iniciar !== undefined) setAjuste('portal_auto', a.auto_iniciar ? '1' : '0')
  if (a.avance_alumnos !== undefined) setAjuste('portal_alumno_avance', a.avance_alumnos ? '1' : '0')
  return estadoPortal()
}

/** Dirección que se comparte con los alumnos: la pública si existe, si no la de la red local. */
export function urlParaAlumnos(): string {
  const e = estadoPortal()
  return e.url_publica || e.urls.find((u) => !u.includes('localhost')) || e.urls[0] || ''
}

export async function qrDe(texto: string): Promise<string> {
  return QRCode.toDataURL(texto, { margin: 1, width: 320, color: { dark: '#141a23', light: '#ffffff' } })
}

/**
 * Código de un solo uso (60 s) para abrir el panel web ya autenticado sin pedir la contraseña.
 * El portal lo canjea por una sesión propia: no es la sesión en sí ni cierra las demás del docente.
 */
async function codigoDocente(): Promise<string> {
  if (configRemoto()) return (await accionRemota<{ codigo: string }>('codigo')).codigo
  const db = getDb()
  const usuario = getAjuste('portal_docente_usuario')
  const docente = usuario ? buscarUsuarioPorNombre(db, usuario) : undefined
  if (!docente || !proceso) throw new Error('Configura la cuenta docente y enciende el portal primero.')
  return crearCodigoAcceso(db, docente.id)
}

/** Solo rutas del propio portal (relativas, mismo origen): la ruta llega del renderer por IPC. */
function urlDelPanel(ruta: string): URL {
  const origen = configRemoto() ? new URL(configRemoto()!.url).origin : `http://localhost:${puertoActivo}`
  let url: URL | null = null
  try {
    if (ruta.startsWith('/') && !ruta.startsWith('//')) url = new URL(ruta, origen)
  } catch {
    url = null
  }
  if (!url || url.origin !== origen) throw new Error('Ruta del portal no válida.')
  return url
}

/** Origen del panel (portal en línea o local): lo único que la app deja cargar dentro de su ventana */
export function origenPanel(): string {
  return configRemoto() ? new URL(configRemoto()!.url).origin : `http://localhost:${puertoActivo}`
}

/** Dirección del panel ya autenticada para verlo dentro de la ventana de la app (sin su menú: lo pone la app) */
export async function urlPanelIncrustado(ruta = '/docente'): Promise<string> {
  const destino = urlDelPanel(String(ruta))
  if (configRemoto()) await sincronizar({ soloSubir: true })
  destino.searchParams.set('codigo', await codigoDocente())
  destino.searchParams.set('incrustado', '1')
  return destino.toString()
}

/**
 * Abre una ruta del panel web docente ya autenticado. Por omisión dentro de la ventana de la app (publicar,
 * entregas en vivo, bloqueo de examen…); `nueva` abre otra ventana aparte (el juego en vivo) y `navegador`
 * lo manda al navegador del sistema.
 */
export async function abrirPanelDocente(ruta = '/docente', modo: 'panel' | 'nueva' | 'navegador' = 'panel'): Promise<void> {
  const destino = urlDelPanel(String(ruta))
  // Lo recién creado aquí (una evaluación nueva, un alumno) debe existir allá antes de abrir el panel
  if (configRemoto()) await sincronizar({ soloSubir: true })
  destino.searchParams.set('codigo', await codigoDocente())
  const url = destino.toString()
  if (modo === 'navegador') return shell.openExternal(url)
  if (modo === 'nueva') {
    const w = new BrowserWindow({ width: 1280, height: 800, title: 'Portal · panel docente', autoHideMenuBar: true })
    await w.loadURL(url)
    return
  }
  // Dentro de la app: la ventana principal muestra el panel en su página «Panel del portal»
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('portal:verPanel', String(ruta))
  const principal = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  if (principal) {
    if (principal.isMinimized()) principal.restore()
    principal.focus()
  }
}

/** Crea una partida en vivo de una evaluación y abre la pantalla del anfitrión en una ventana propia. */
export async function jugarEnVivo(evaluacionId: number, segundos = 20): Promise<string> {
  if (configRemoto()) {
    await sincronizar({ soloSubir: true })
    const { pin } = await accionRemota<{ pin: string }>('partida', { evaluacion_id: evaluacionId, segundos })
    await abrirPanelDocente(`/docente/juego/${pin}`, 'nueva')
    return pin
  }
  const db = getDb()
  const usuario = getAjuste('portal_docente_usuario')
  const docente = usuario ? buscarUsuarioPorNombre(db, usuario) : undefined
  if (!docente || !proceso) throw new Error('Configura la cuenta docente y enciende el portal primero.')
  const partida = crearPartida(db, evaluacionId, docente.id, segundos)
  await abrirPanelDocente(`/docente/juego/${partida.pin}`, 'nueva')
  return partida.pin
}

export function notificacionesDocente(soloNoLeidas = false): Notificacion[] {
  const db = getDb()
  const usuario = usuarioDocente()
  const docente = usuario ? buscarUsuarioPorNombre(db, usuario) : undefined
  return docente ? notificacionesDe(db, docente.id, soloNoLeidas) : []
}

export function marcarNotificacionesLeidas(ids?: number[]): number {
  // En línea se marcan allá (si no, la siguiente sincronización las regresaría sin leer) y aquí al momento
  if (configRemoto()) void accionRemota('leidas', { ids }).catch((e) => console.error('[portal remoto] leídas', e))
  const db = getDb()
  const usuario = usuarioDocente()
  const docente = usuario ? buscarUsuarioPorNombre(db, usuario) : undefined
  return docente ? marcarLeidas(db, docente.id, ids) : 0
}

/** Cada 20 s (o tras cada sincronización, en línea) revisa si hay notificaciones nuevas y las muestra como aviso del sistema. */
function arrancarVigilante(): void {
  if (vigilante) return
  ultimaNotificacionAvisada = Math.max(0, ...notificacionesDocente().map((n) => n.id))
  vigilante = setInterval(revisarNovedades, 20_000)
}

function revisarNovedades(): void {
  try {
    const nuevas = notificacionesDocente(true).filter((n) => n.id > ultimaNotificacionAvisada)
    if (!nuevas.length) return
    ultimaNotificacionAvisada = Math.max(...nuevas.map((n) => n.id))
    const primera = nuevas[0]
    const titulo = nuevas.length === 1 ? primera.titulo : `${nuevas.length} novedades en el portal`
    const cuerpo = nuevas.length === 1 ? primera.cuerpo : nuevas.map((n) => n.titulo).slice(0, 3).join(' · ')
    // Al hacer clic se trae la app al frente; si es una sola entrega, además se abre en el panel
    const entrega = nuevas.length === 1 && primera.ref_tipo === 'intento' && primera.ref_id ? primera.ref_id : null
    mostrarAviso(titulo, cuerpo, entrega ? () => void abrirPanelDocente(`/docente/intentos/${entrega}`).catch((e) => console.error('[portal] abrir entrega', e)) : undefined)
    avisarVentanas(nuevas)
  } catch (e) {
    console.error('[portal] vigilante', e)
  }
}

// ---------- Accesos de alumnos: en línea se crean en el servidor (allá viven las cuentas) ----------

export async function accesosDeMateria(materiaId: number): Promise<{ creados: AccesoCreado[]; existentes: number }> {
  if (!configRemoto()) return crearAccesosAlumnos(getDb(), materiaId)
  await sincronizar({ soloSubir: true })
  const r = await accionRemota<{ creados: AccesoCreado[]; existentes: number }>('accesos', { materia_id: materiaId })
  void sincronizar().catch(() => undefined)
  return r
}

export async function accesoDeAlumno(alumnoId: number): Promise<AccesoCreado | null> {
  if (!configRemoto()) return crearAccesoAlumno(getDb(), alumnoId)
  await sincronizar({ soloSubir: true })
  const r = await accionRemota<AccesoCreado | null>('acceso', { alumno_id: alumnoId })
  void sincronizar().catch(() => undefined)
  return r
}

export async function reiniciarAccesoDeAlumno(alumnoId: number): Promise<string> {
  if (!configRemoto()) return reiniciarPasswordAlumno(getDb(), alumnoId)
  const { password } = await accionRemota<{ password: string }>('reiniciar', { alumno_id: alumnoId })
  void sincronizar().catch(() => undefined)
  return password
}

/** Aviso a los alumnos de una materia (en grupos mixtos, opcionalmente solo a una carrera). En línea se manda desde el servidor. */
export async function avisoAlGrupo(materiaId: number, titulo: string, cuerpo: string, carreraId: number | null): Promise<number> {
  if (configRemoto()) {
    const r = await accionRemota<{ enviados: number }>('aviso', { materia_id: materiaId, titulo, cuerpo, carrera_id: carreraId })
    void sincronizar().catch(() => undefined)
    return r.enviados
  }
  return enviarAviso(getDb(), materiaId, titulo, cuerpo, carreraId)
}

/** Sincronizar ahora (botón de la pestaña Portal). `forzar` permite borrados grandes que el servidor detuvo. */
export async function sincronizarAhora(forzar = false): Promise<EstadoPortal> {
  await sincronizar({ forzar })
  revisarNovedades()
  avisarVentanas()
  return estadoPortal()
}

function detenerVigilante(): void {
  if (vigilante) clearInterval(vigilante)
  vigilante = null
}

export async function apagarAlSalir(): Promise<void> {
  await detenerPortal()
}
