/**
 * Notificaciones push: llegan al celular o la computadora aunque el portal esté cerrado (como las de una app).
 *
 * Cada aviso que se guarda en la campana (`crearNotificacion`) también sale como push a todos los
 * dispositivos donde ese usuario las activó. Las llaves VAPID con que el servidor firma los envíos se
 * generan solas la primera vez y se guardan en la base de este servidor (no viajan a la Mac).
 *
 * El navegador del alumno guarda la suscripción con el servicio de push de su sistema (Google, Apple,
 * Mozilla); aquí solo se guarda la dirección a la que hay que mandar. Si ese servicio responde que ya no
 * existe (el alumno desinstaló o quitó el permiso), se borra.
 */
import type Database from 'better-sqlite3'
import webpush from 'web-push'
import { ErrorHttp } from './auth'
import { leerAjuste, escribirAjuste } from './base'
import { escucharNotificaciones, type NuevaNotificacion } from './servicios'

type DB = Database.Database

interface Llaves {
  publica: string
  privada: string
}

const CONTACTO = 'mailto:portal@ejemplo.com'

/** Llaves del servidor: de las variables de entorno o, si no hay, las de la base (se crean una vez). */
export function llavesPush(db: DB): Llaves {
  if (process.env.PORTAL_VAPID_PUBLICA && process.env.PORTAL_VAPID_PRIVADA) return { publica: process.env.PORTAL_VAPID_PUBLICA, privada: process.env.PORTAL_VAPID_PRIVADA }
  const guardadas = leerAjuste(db, 'push_vapid')
  if (guardadas) {
    try {
      const l = JSON.parse(guardadas) as Llaves
      if (l.publica && l.privada) return l
    } catch {
      /* se regeneran abajo */
    }
  }
  const nuevas = webpush.generateVAPIDKeys()
  const l = { publica: nuevas.publicKey, privada: nuevas.privateKey }
  escribirAjuste(db, 'push_vapid', JSON.stringify(l))
  return l
}

export interface SuscripcionNavegador {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * Guarda (o vuelve a ligar) la suscripción de este dispositivo al usuario que la manda.
 * En un celular compartido, la del último que activó las notificaciones es la que vale.
 */
export function guardarSuscripcion(db: DB, usuarioId: number, s: SuscripcionNavegador, dispositivo: string): void {
  const endpoint = String(s?.endpoint ?? '')
  const p256dh = String(s?.keys?.p256dh ?? '')
  const auth = String(s?.keys?.auth ?? '')
  // Solo servicios de push reales por https: el servidor no debe mandar peticiones a cualquier dirección
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new ErrorHttp(400, 'Suscripción no válida.')
  }
  if (url.protocol !== 'https:' || endpoint.length > 1000 || !/^[\w-]{20,200}$/.test(p256dh) || !/^[\w-]{10,100}$/.test(auth)) throw new ErrorHttp(400, 'Suscripción no válida.')
  db.prepare(
    `INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth, dispositivo) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET usuario_id = excluded.usuario_id, p256dh = excluded.p256dh, auth = excluded.auth, dispositivo = excluded.dispositivo`
  ).run(usuarioId, endpoint, p256dh, auth, dispositivo.slice(0, 200))
  // Un usuario no necesita más de 10 dispositivos: se quedan los más recientes
  db.prepare('DELETE FROM push_suscripciones WHERE usuario_id = ? AND id NOT IN (SELECT id FROM push_suscripciones WHERE usuario_id = ? ORDER BY id DESC LIMIT 10)').run(usuarioId, usuarioId)
}

/** Deja de mandar a este dispositivo (desactivó las notificaciones o cerró sesión). */
export function borrarSuscripcion(db: DB, usuarioId: number, endpoint: string): number {
  return db.prepare('DELETE FROM push_suscripciones WHERE usuario_id = ? AND endpoint = ?').run(usuarioId, String(endpoint ?? '')).changes
}

export const tieneSuscripcion = (db: DB, usuarioId: number, endpoint: string): boolean =>
  !!db.prepare('SELECT 1 FROM push_suscripciones WHERE usuario_id = ? AND endpoint = ?').get(usuarioId, String(endpoint ?? ''))

/** Pantalla que abre la notificación al tocarla (la misma a la que lleva la campana). */
export function destinoDe(rol: string, n: NuevaNotificacion): string {
  if (rol === 'docente') {
    if (n.ref_tipo === 'intento' && n.ref_id) return `/docente/intentos/${n.ref_id}`
    if (n.ref_tipo === 'restaurar') return '/docente/notificaciones'
    return '/docente/entregas'
  }
  if (n.ref_tipo === 'asignacion' && n.ref_id) return `/actividad/${n.ref_id}`
  if (n.ref_tipo === 'tarea') return '/tareas'
  if (n.tipo === 'aviso') return '/'
  return '/calificaciones'
}

interface FilaSuscripcion {
  id: number
  endpoint: string
  p256dh: string
  auth: string
}

async function enviar(db: DB, usuarioId: number, n: NuevaNotificacion): Promise<void> {
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_suscripciones WHERE usuario_id = ?').all(usuarioId) as FilaSuscripcion[]
  if (!subs.length) return
  const u = db.prepare('SELECT rol FROM usuarios WHERE id = ? AND activo = 1').get(usuarioId) as { rol: string } | undefined
  if (!u) return
  const datos = {
    titulo: n.titulo.slice(0, 120),
    cuerpo: n.cuerpo.slice(0, 240),
    url: destinoDe(u.rol, n),
    // Un aviso nuevo de la misma cosa reemplaza al anterior en vez de amontonarse
    etiqueta: n.ref_id ? `${n.tipo}-${n.ref_tipo}-${n.ref_id}` : `${n.tipo}-${Date.now()}`
  }
  const llaves = llavesPush(db)
  for (const s of subs) {
    // En las pruebas no se sale a internet: solo se anota que se habría mandado
    if (process.env.PORTAL_PUSH_PRUEBA === '1') {
      db.prepare("UPDATE push_suscripciones SET ultimo_envio = datetime('now') WHERE id = ?").run(s.id)
      continue
    }
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(datos), {
        TTL: 3 * 24 * 3600,
        urgency: 'normal',
        vapidDetails: { subject: CONTACTO, publicKey: llaves.publica, privateKey: llaves.privada },
        timeout: 15_000
      })
      db.prepare("UPDATE push_suscripciones SET ultimo_envio = datetime('now') WHERE id = ?").run(s.id)
    } catch (e) {
      const estado = (e as { statusCode?: number }).statusCode
      // 404/410: el dispositivo ya no existe o quitó el permiso
      if (estado === 404 || estado === 410) db.prepare('DELETE FROM push_suscripciones WHERE id = ?').run(s.id)
      else console.error('[push]', estado ?? '', (e as Error).message)
    }
  }
}

/** «Enviar una de prueba» desde Cuenta: sale solo como push (no se guarda en la campana). Devuelve a cuántos dispositivos. */
export async function enviarPrueba(db: DB, usuarioId: number): Promise<number> {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM push_suscripciones WHERE usuario_id = ?').get(usuarioId) as { n: number }).n
  await enviar(db, usuarioId, { tipo: 'prueba', titulo: '¡Listo! Las notificaciones funcionan', cuerpo: 'Así te llegarán los avisos de tus clases.', ref_tipo: 'prueba', ref_id: null })
  return n
}

const activadas = new WeakSet<DB>()

/** Cada aviso de la campana sale también como push (después de que se guarda: muchos se crean dentro de una transacción). */
export function activarPush(db: DB): void {
  if (activadas.has(db)) return
  activadas.add(db)
  llavesPush(db)
  escucharNotificaciones((usuarioId, n) => {
    setImmediate(() => void enviar(db, usuarioId, n).catch((e) => console.error('[push]', (e as Error).message)))
  })
}
