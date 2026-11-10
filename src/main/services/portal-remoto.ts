/**
 * «Portal en línea»: el portal vive en un servidor (VPS) y esta app se sincroniza con él en dos sentidos
 * (ver src/servidor/cambios.ts): cada lado manda lo que cambió y aplica lo del otro; gana el cambio más reciente.
 * La primera vez se igualan los dos lados con el modo anterior (tablas completas) y desde ahí solo viajan cambios.
 *
 * La configuración vive en datos/portal-remoto.json (permiso 600), no en la base: así los respaldos
 * y copias de la base no se llevan la clave. { "url": "https://…", "clave": "…", "docente": "usuario" }
 */
import { createHash, randomUUID } from 'crypto'
import { powerMonitor } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import { getDb, getAjuste, setAjuste, dataDir, respaldar, materialesDir } from '../db'
import { AJUSTES_AL_PORTAL, AJUSTES_DE_LA_MAC, TABLAS_DEL_PORTAL, TABLAS_SIN_SINCRONIZAR, type SecretosDeLaMac, type PaqueteSubida, type RespuestaBajada, type TablaSincro } from '../../shared/sincronizacion'
import { aplicarCambios, cambiosDesde, podarCambios, sinAnotar, type Cambio } from '../../servidor/cambios'
import { registrarError } from './errores'
import { leerApiKey } from './ia'
import { conexionParaPortal } from './classroom'

export interface ConfigRemoto {
  url: string
  clave: string
  docente: string
}

let config: ConfigRemoto | null | undefined

/** null = el portal corre en esta Mac (modo de siempre). */
export function configRemoto(): ConfigRemoto | null {
  if (config !== undefined) return config
  config = null
  try {
    const ruta = join(dataDir(), 'portal-remoto.json')
    if (existsSync(ruta)) {
      const c = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<ConfigRemoto>
      if (c.url && c.clave && c.clave.length >= 32) config = { url: c.url.replace(/\/+$/, ''), clave: c.clave, docente: c.docente ?? '' }
    }
  } catch (e) {
    console.error('[portal remoto] configuración ilegible', e)
  }
  return config
}

export interface EstadoSincro {
  ultima: string | null
  /** Lo que salió mal en el último intento (vacío si salió bien) */
  falla: string
  enCurso: boolean
}
const estado: EstadoSincro = { ultima: null, falla: '', enCurso: false }
export const estadoSincro = (): EstadoSincro => ({ ...estado })

async function pedir<T>(ruta: string, op: { metodo?: string; cuerpo?: unknown; tiempo?: number } = {}): Promise<T> {
  const c = configRemoto()
  if (!c) throw new Error('El portal en línea no está configurado.')
  let r: Response
  try {
    r = await fetch(`${c.url}/api${ruta}`, {
      method: op.metodo ?? (op.cuerpo === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${c.clave}`, ...(op.cuerpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: op.cuerpo !== undefined ? JSON.stringify(op.cuerpo) : undefined,
      signal: AbortSignal.timeout(op.tiempo ?? 60_000)
    })
  } catch (e) {
    throw new Error(`Sin conexión con el portal en línea (${(e as Error).message}).`)
  }
  if (!r.ok) {
    const datos = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(datos.error ?? `El portal en línea respondió ${r.status}.`)
  }
  return (await r.json()) as T
}

export const accionRemota = <T>(ruta: string, cuerpo: unknown = {}): Promise<T> => pedir<T>(`/sincro/${ruta}`, { cuerpo })

// ---------- Subir: lo que manda la app ----------

/** Huella de lo último que se subió de cada tabla: solo viaja lo que cambió. */
const subidas = new Map<string, string>()

function tablasDeLaApp(): string[] {
  const fuera = new Set<string>([...TABLAS_DEL_PORTAL, ...TABLAS_SIN_SINCRONIZAR])
  return (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name).filter((t) => !fuera.has(t))
}

function leerTabla(tabla: string): TablaSincro {
  const db = getDb()
  const columnas = (db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).map((c) => c.name)
  return { columnas, filas: db.prepare(`SELECT ${columnas.join(', ')} FROM ${tabla}`).raw(true).all() as unknown[][] }
}

async function subir(forzar = false): Promise<void> {
  const paquete: PaqueteSubida = { tablas: {}, ajustes: {}, forzar }
  const huellas = new Map<string, string>()
  for (const t of tablasDeLaApp()) {
    const datos = leerTabla(t)
    const h = createHash('sha1').update(JSON.stringify(datos)).digest('hex')
    huellas.set(t, h)
    if (subidas.get(t) !== h) paquete.tablas[t] = datos
  }
  for (const clave of AJUSTES_AL_PORTAL) {
    const v = getAjuste(clave)
    if (v) paquete.ajustes[clave] = v
  }
  if (!Object.keys(paquete.tablas).length && subidas.has('_ajustes') && subidas.get('_ajustes') === JSON.stringify(paquete.ajustes)) return
  const r = await pedir<{ omitidas?: string[] }>('/sincro/subir', { cuerpo: paquete, tiempo: 180_000 })
  // Lo que el servidor no aceptó (tabla que aún no tiene) se vuelve a mandar la próxima vez
  for (const t of r.omitidas ?? []) huellas.delete(t)
  for (const [t, h] of huellas) subidas.set(t, h)
  subidas.set('_ajustes', JSON.stringify(paquete.ajustes))
}


// ---------- Bajar: lo que manda el portal ----------

let huellaBajada = ''
let respaldoHecho = false
/** Archivos por traer: se descargan aparte para que una sincronización no espere minutos por un PDF grande. */
let pendientes: { ruta: string }[] = []

/** Dentro de la carpeta de entregas, sin rutas absolutas ni «..» (el servidor es público: no se le cree a ciegas). */
function rutaSegura(base: string, ruta: string): string | null {
  const abs = resolve(base, ruta)
  const rel = relative(base, abs)
  return !ruta || isAbsolute(ruta) || rel.startsWith('..') || isAbsolute(rel) ? null : abs
}

/** Reemplaza las tablas del portal con lo del servidor y anota los archivos que falten. */
async function bajar(forzar: boolean): Promise<void> {
  const p = await pedir<RespuestaBajada>(`/sincro/bajar?desde=${huellaBajada}`, { tiempo: 120_000 })
  if ('sin_cambios' in p) return
  const db = getDb()
  // Freno igual al de la subida: un servidor vacío o restaurado de un respaldo viejo no vacía la Mac
  for (const tabla of TABLAS_DEL_PORTAL) {
    const aqui = (db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number }).n
    const alla = p.tablas[tabla]?.filas.length ?? 0
    if (aqui > 5 && alla < aqui / 2 && !forzar) {
      throw new Error(`El portal en línea trae ${alla} filas de «${tabla}» y esta app tiene ${aqui}. Se detuvo para no perder datos; si es correcto, sincroniza con «forzar».`)
    }
  }
  // La primera vez en cada arranque, una copia de la base antes de reemplazar nada
  if (!respaldoHecho) {
    await respaldar('antes-de-sincronizar', new Date().toISOString().replace(/[:.]/g, '-'), 5)
    respaldoHecho = true
  }
  const entregas = join(dataDir(), 'entregas')
  // Las rutas llegan relativas; en esta Mac las de exámenes se guardan absolutas (como las escribe el portal local)
  const ae = p.tablas.archivos_entrega
  if (ae) {
    const i = ae.columnas.indexOf('ruta')
    for (const f of ae.filas) f[i] = rutaSegura(entregas, String(f[i])) ?? ''
  }
  // Con las llaves foráneas apagadas: se vacían y llenan tablas que dependen entre sí
  db.pragma('foreign_keys = OFF')
  try {
    // Tablas completas del modo anterior: no son cambios de esta Mac (no se regresan al servidor)
    sinAnotar(db, () => db.transaction(() => {
      db.exec('DELETE FROM sesiones_web; DELETE FROM codigos_acceso;')
      for (const tabla of TABLAS_DEL_PORTAL) {
        const datos = p.tablas[tabla]
        if (!datos) continue
        const locales = new Set((db.prepare(`PRAGMA table_info(${tabla})`).all() as { name: string }[]).map((c) => c.name))
        const usar = datos.columnas.map((c, i) => ({ c, i })).filter(({ c }) => locales.has(c))
        db.exec(`DELETE FROM ${tabla}`)
        const ins = db.prepare(`INSERT INTO ${tabla} (${usar.map((u) => u.c).join(', ')}) VALUES (${usar.map(() => '?').join(', ')})`)
        for (const f of datos.filas) ins.run(...usar.map(({ i }) => f[i] ?? null))
      }
    })())
  } finally {
    db.pragma('foreign_keys = ON')
  }
  huellaBajada = p.huella
  pendientes = p.archivos.filter((a) => {
    const destino = rutaSegura(entregas, a.ruta)
    return destino !== null && !existsSync(destino)
  })
}

let descargando = false
/** Trae los archivos que falten, uno por uno, fuera de la sincronización. */
async function descargarPendientes(): Promise<void> {
  if (descargando) return
  descargando = true
  const entregas = join(dataDir(), 'entregas')
  try {
    while (pendientes.length) {
      const a = pendientes.shift()!
      const destino = rutaSegura(entregas, a.ruta)
      const c = configRemoto()
      if (!destino || !c || existsSync(destino)) continue
      try {
        const r = await fetch(`${c.url}/api/sincro/archivo?ruta=${encodeURIComponent(a.ruta)}`, { headers: { Authorization: `Bearer ${c.clave}` }, signal: AbortSignal.timeout(300_000) })
        if (!r.ok) continue
        mkdirSync(dirname(destino), { recursive: true })
        // Primero a un temporal: un archivo a medias nunca queda con el nombre final
        writeFileSync(`${destino}.parcial`, Buffer.from(await r.arrayBuffer()))
        renameSync(`${destino}.parcial`, destino)
      } catch (e) {
        console.error('[portal remoto] archivo', a.ruta, (e as Error).message)
      }
    }
  } finally {
    descargando = false
  }
}

// ---------- Dos sentidos: solo cambios ----------

/** Esta Mac ante el servidor: así el servidor no le regresa lo que ella misma mandó. */
function cliente(): string {
  let id = getAjuste('sincro_cliente')
  if (!id) setAjuste('sincro_cliente', (id = `mac-${randomUUID()}`))
  return id
}
const ORIGEN_SERVIDOR = 'servidor'

/** Manda lo que cambió aquí desde la última vez (en lotes). */
async function enviarCambios(forzar: boolean): Promise<void> {
  const db = getDb()
  for (;;) {
    const desde = Number(getAjuste('sincro_enviado', '0'))
    const r = cambiosDesde(db, desde, ORIGEN_SERVIDOR)
    if (r.cambios.length) await pedir('/sincro/cambios', { cuerpo: { cliente: cliente(), cambios: r.cambios, forzar }, tiempo: 180_000 })
    setAjuste('sincro_enviado', String(r.cursor))
    if (!r.hay_mas) return
  }
}

/** Trae y aplica lo que cambió en el servidor; anota los archivos que falten. */
async function recibirCambios(forzar: boolean): Promise<void> {
  const db = getDb()
  const entregas = join(dataDir(), 'entregas')
  for (;;) {
    const desde = Number(getAjuste('sincro_recibido', '0'))
    const r = await pedir<{ cambios: Cambio[]; cursor: number; hay_mas: boolean }>(`/sincro/cambios?desde=${desde}&cliente=${encodeURIComponent(cliente())}`, { tiempo: 120_000 })
    if (r.cambios.length) {
      if (!respaldoHecho) {
        await respaldar('antes-de-sincronizar', new Date().toISOString().replace(/[:.]/g, '-'), 5)
        respaldoHecho = true
      }
      aplicarCambios(db, r.cambios, ORIGEN_SERVIDOR, {
        maxBorrados: forzar ? Infinity : undefined,
        // Las entregas de exámenes llegan con ruta relativa; aquí se guardan absolutas (como las escribe el portal local)
        transformar: (tabla, fila) => {
          if (tabla !== 'archivos_entrega') return fila
          const abs = rutaSegura(entregas, String(fila.ruta))
          return abs ? { ...fila, ruta: abs } : null
        }
      })
    }
    setAjuste('sincro_recibido', String(r.cursor))
    if (!r.hay_mas) break
  }
  anotarArchivosFaltantes()
}

/** Archivos de entregas y de «Subir tarea» que la base menciona y aún no están en esta Mac. */
function anotarArchivosFaltantes(): void {
  const db = getDb()
  const entregas = join(dataDir(), 'entregas')
  const rutas = [
    ...(db.prepare('SELECT ruta FROM archivos_entrega').all() as { ruta: string }[]).map((f) => relative(entregas, f.ruta)),
    ...(db.prepare('SELECT ruta FROM archivos_subida').all() as { ruta: string }[]).map((f) => f.ruta)
  ]
  pendientes = rutas.filter((ruta) => {
    const destino = rutaSegura(entregas, ruta)
    return destino !== null && !existsSync(destino)
  }).map((ruta) => ({ ruta }))
}

/**
 * Primera vez con dos sentidos: se igualan los dos lados con el modo anterior (tablas completas) y desde
 * ese punto solo viajan cambios. Lo de antes ya quedó igual allá y aquí.
 */
async function pasarADosSentidos(forzar: boolean): Promise<void> {
  await subir(forzar)
  await bajar(forzar)
  const { cursor } = await pedir<{ cursor: number }>('/sincro/cursor')
  const db = getDb()
  setAjuste('sincro_enviado', String((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM _cambios').get() as { m: number }).m))
  setAjuste('sincro_recibido', String(cursor))
  setAjuste('sincro_v2', '1')
  podarCambios(db)
}

// ---------- Materiales compartidos: el archivo vive en esta Mac; el servidor necesita su copia ----------

let subiendoMateriales = false
/** Sube (uno por uno, fuera de la sincronización) los materiales compartidos que el servidor aún no tiene o que cambiaron. */
async function subirMateriales(): Promise<void> {
  const c = configRemoto()
  if (subiendoMateriales || !c) return
  subiendoMateriales = true
  try {
    const db = getDb()
    const compartidos = db.prepare("SELECT id, ruta FROM materiales WHERE compartido = 1 AND tipo <> 'link'").all() as { id: number; ruta: string }[]
    if (!compartidos.length) return
    const enServidor = new Map((await pedir<{ id: number; tamano: number }[]>('/sincro/materiales')).map((x) => [x.id, x.tamano]))
    for (const m of compartidos) {
      if (!m.ruta || !existsSync(m.ruta)) continue
      const datos = readFileSync(m.ruta)
      if (enServidor.get(m.id) === datos.length) continue
      const ext = (extname(m.ruta) || '.bin').toLowerCase()
      try {
        const r = await fetch(`${c.url}/api/sincro/material/${m.id}?ext=${encodeURIComponent(ext)}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${c.clave}`, 'Content-Type': 'application/octet-stream' },
          body: datos,
          signal: AbortSignal.timeout(600_000)
        })
        if (!r.ok) console.error('[portal remoto] material', m.id, r.status)
      } catch (e) {
        console.error('[portal remoto] material', m.id, (e as Error).message)
      }
    }
  } catch (e) {
    console.error('[portal remoto] materiales', (e as Error).message)
  } finally {
    subiendoMateriales = false
  }
}

// ---------- Versión web de la app (portal.ejemplo.com/app) ----------

/**
 * Las llaves de la IA y de Google viven cifradas en el llavero de esta Mac y nunca viajan con la sincronización:
 * para que la versión web pueda generar con IA y usar Classroom, se le mandan una vez por sesión (por HTTPS, y
 * allá se vuelven a cifrar con la llave del servidor). Si el servidor aún no tiene la versión web, no pasa nada.
 */
let secretosEnviados = false
async function enviarSecretos(): Promise<void> {
  if (secretosEnviados || !configRemoto()) return
  secretosEnviados = true
  try {
    const anthropic = leerApiKey('anthropic')
    const nvidia = leerApiKey('nvidia')
    const classroom = conexionParaPortal()
    const ajustes: Record<string, string> = {}
    // Todos, también los vacíos: quitar la contraseña de borrado en la Mac la quita también en la web
    for (const k of AJUSTES_DE_LA_MAC) ajustes[k] = getAjuste(k)
    const s: SecretosDeLaMac = { ia: { ...(anthropic ? { anthropic } : {}), ...(nvidia ? { nvidia } : {}) }, ...(classroom ? { classroom } : {}), ajustes }
    await pedir('/sincro/app-secretos', { cuerpo: s })
  } catch (e) {
    console.error('[portal remoto] llaves para la web', (e as Error).message)
  }
}

/**
 * La carpeta de materiales igual en los dos lados: lo que se agregó en la Mac sube (para verlo y proyectarlo
 * desde la web) y lo que se agregó en la web baja. Cada archivo lleva un sello de tiempo en el nombre, así que
 * mismo nombre = mismo archivo; solo se compara el tamaño.
 */
let igualandoMateriales = false
let ultimaIgualacion = 0
async function igualarMateriales(): Promise<void> {
  const c = configRemoto()
  // La sincronización corre cada 5 s; la carpeta basta revisarla cada par de minutos
  if (igualandoMateriales || !c || Date.now() - ultimaIgualacion < 120_000) return
  igualandoMateriales = true
  ultimaIgualacion = Date.now()
  try {
    let allá: Map<string, number>
    try {
      allá = new Map((await pedir<{ nombre: string; tamano: number }[]>('/sincro/app-materiales')).map((x) => [x.nombre, x.tamano]))
    } catch {
      return // el servidor aún no tiene la versión web
    }
    const dir = materialesDir()
    // Solo lo que usa algún material (el archivo y el PDF de una presentación convertida): lo que se borró en un
    // lado no regresa del otro
    const usados = new Set<string>()
    for (const { ruta } of getDb().prepare("SELECT ruta FROM materiales WHERE tipo <> 'link' AND ruta NOT LIKE 'http%'").all() as { ruta: string }[]) {
      const nombre = ruta.replace(/\\/g, '/').split('/').pop() ?? ''
      if (!nombre) continue
      usados.add(nombre)
      usados.add(nombre.replace(/\.[^.]+$/, '') + '.pdf')
    }
    const aquí = new Map(readdirSync(dir).filter((f) => usados.has(f)).map((f) => [f, statSync(join(dir, f)).size]))
    for (const [nombre, tamano] of aquí) {
      if (allá.get(nombre) === tamano) continue
      try {
        const r = await fetch(`${c.url}/api/sincro/app-material?nombre=${encodeURIComponent(nombre)}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${c.clave}`, 'Content-Type': 'application/octet-stream' },
          body: readFileSync(join(dir, nombre)),
          signal: AbortSignal.timeout(600_000)
        })
        if (!r.ok) console.error('[portal remoto] subir material', nombre, r.status)
      } catch (e) {
        console.error('[portal remoto] subir material', nombre, (e as Error).message)
      }
    }
    for (const [nombre] of allá) {
      if (aquí.has(nombre) || !usados.has(nombre)) continue
      try {
        const r = await fetch(`${c.url}/api/sincro/app-material?nombre=${encodeURIComponent(nombre)}`, { headers: { Authorization: `Bearer ${c.clave}` }, signal: AbortSignal.timeout(600_000) })
        if (!r.ok) continue
        const destino = join(dir, nombre)
        writeFileSync(`${destino}.parcial`, Buffer.from(await r.arrayBuffer()))
        renameSync(`${destino}.parcial`, destino)
      } catch (e) {
        console.error('[portal remoto] bajar material', nombre, (e as Error).message)
      }
    }
  } finally {
    igualandoMateriales = false
  }
}

let enVuelo: Promise<void> | null = null

/**
 * Sube y luego baja. Si ya hay una en curso, espera a esa; si se pide forzar, espera y corre otra forzada.
 * Los archivos se traen aparte (no la alargan).
 */
export async function sincronizar(op: { soloSubir?: boolean; forzar?: boolean } = {}): Promise<void> {
  if (!configRemoto()) return
  if (enVuelo) {
    if (!op.forzar) return enVuelo
    await enVuelo.catch(() => undefined)
  }
  enVuelo ??= (async () => {
    estado.enCurso = true
    try {
      if (getAjuste('sincro_v2') !== '1') await pasarADosSentidos(Boolean(op.forzar))
      else {
        await enviarCambios(Boolean(op.forzar))
        if (!op.soloSubir) await recibirCambios(Boolean(op.forzar))
      }
      estado.ultima = new Date().toISOString()
      estado.falla = ''
      setAjuste('portal_remoto_ultima', estado.ultima)
    } catch (e) {
      estado.falla = (e as Error).message
      throw e
    } finally {
      estado.enCurso = false
      enVuelo = null
    }
  })()
  await enVuelo
  void descargarPendientes()
  void subirMateriales()
  void enviarSecretos()
  void igualarMateriales()
}

let reloj: NodeJS.Timeout | null = null

/**
 * Los cortes breves no son fallas: la red que se cae unos segundos, la Mac que despierta o el reinicio del
 * portal al publicar. Lo pendiente se manda en la siguiente vuelta, así que solo se anotan si duran más de esto.
 */
const TOLERANCIA_CORTE_MS = 2 * 60_000
let sinConexionDesde: number | null = null
/**
 * Con la tapa cerrada macOS despierta la Mac a oscuras unos segundos cada ~15 min (Power Nap): la vuelta corre
 * sin red o se le vence el tiempo mientras duerme. Entre «suspend» y «resume» no se anota ningún corte.
 */
let dormida = false
const esCorte = (e: unknown): boolean => /^Sin conexión con el portal en línea|^El portal en línea respondió 5\d\d/.test((e as Error)?.message ?? '')

/** Sincroniza ahora y luego cada 5 segundos mientras la app esté abierta (sin cambios es una sola consulta corta). `alTerminar` corre tras cada vuelta. */
export function arrancarSincronizacion(alTerminar: () => void): void {
  if (reloj || !configRemoto()) return
  estado.ultima = getAjuste('portal_remoto_ultima') || null
  const vuelta = (): void => {
    sincronizar()
      .then(() => {
        sinConexionDesde = null
      })
      .catch((e) => {
        console.error('[portal remoto]', (e as Error).message)
        if (esCorte(e)) {
          if (dormida) return
          sinConexionDesde ??= Date.now()
          if (Date.now() - sinConexionDesde < TOLERANCIA_CORTE_MS) return
          registrarError('sincronizacion', 'sincronización con el portal en línea', e, `Sin conexión desde ${new Date(sinConexionDesde).toISOString()}`)
          return
        }
        registrarError('sincronizacion', 'sincronización con el portal en línea', e)
      })
      .finally(() => {
        try {
          alTerminar()
        } catch (e) {
          console.error('[portal remoto] después de sincronizar', e)
        }
      })
  }
  // Al despertar la Mac el conteo empieza de nuevo: el tiempo dormida no cuenta como corte
  powerMonitor.on('suspend', () => {
    dormida = true
  })
  const despierta = (): void => {
    dormida = false
    sinConexionDesde = null
  }
  powerMonitor.on('resume', despierta)
  // Por si el «resume» no llega: el docente de vuelta en la Mac también cuenta como despierta
  powerMonitor.on('unlock-screen', despierta)
  powerMonitor.on('user-did-become-active', despierta)
  vuelta()
  reloj = setInterval(vuelta, 5_000)
}

export function detenerSincronizacion(): void {
  if (reloj) clearInterval(reloj)
  reloj = null
}
