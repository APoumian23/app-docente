import { app, BrowserWindow, Notification } from 'electron'
import { getDb } from '../db'
import { alertasFaltas, hoyMx } from '../calificacion'
import { ETIQUETA_NIVEL_FALTAS } from '../../shared/proyeccion'

/**
 * Avisos del sistema (Centro de notificaciones de macOS):
 *  - Recordatorios: una vez al día por recordatorio mientras está en su ventana de aviso
 *    (desde «avisar N días antes» hasta que termina). Se revisa al abrir la app y cada 10 min,
 *    así que el cambio de día también lo dispara.
 *  - Faltas: cuando un alumno llega a un escalón del comunicado COM-AS-01, una sola vez por alumno, materia y escalón.
 */
let reloj: NodeJS.Timeout | null = null

/** ¿Es la ventana principal? Mismo criterio que `esDeLaApp` en ipc: su página es la de la app (no el panel web ni la de PDFs). */
function esPrincipal(w: BrowserWindow): boolean {
  if (w.isDestroyed()) return false
  const url = w.webContents.getURL()
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return url.startsWith(dev)
  try {
    const u = new URL(url)
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).endsWith('/renderer/index.html')
  } catch {
    return false
  }
}

/** Trae al frente la ventana principal; si se cerró con ⌘W, la vuelve a abrir (index.ts lo hace al activarse la app). */
export function traerVentanaPrincipal(): void {
  const w = BrowserWindow.getAllWindows().find(esPrincipal)
  if (!w) {
    app.emit('activate')
    return
  }
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

/**
 * Avisos vivos: si el objeto se recolecta, macOS sigue mostrando el aviso pero el clic ya no llega.
 * Se sueltan al hacer clic, al cerrarse o tras un rato.
 */
const vivos = new Set<Notification>()

/** Muestra un aviso del sistema. Al hacer clic trae la app al frente y, si se indica, hace algo más (p. ej. abrir una entrega). */
export function mostrarAviso(titulo: string, cuerpo: string, alClic?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: titulo, body: cuerpo })
  vivos.add(n)
  const soltar = (): boolean => vivos.delete(n)
  n.on('click', () => {
    soltar()
    traerVentanaPrincipal()
    try {
      alClic?.()
    } catch (e) {
      console.error('[avisos] clic', (e as Error).message)
    }
  })
  n.on('close', soltar)
  setTimeout(soltar, 6 * 3600_000)
  n.show()
}

const mostrar = (titulo: string, cuerpo: string): void => mostrarAviso(titulo, cuerpo)

function sumarDias(fecha: string, n: number): string {
  const d = new Date(fecha + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const fechaLegible = (f: string): string => new Date(f + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })

export function revisarRecordatorios(hoy = hoyMx()): number {
  const d = getDb()
  const lista = d
    .prepare(
      `SELECT r.*, m.nombre AS materia_nombre FROM recordatorios r LEFT JOIN materias m ON m.id = r.materia_id
       WHERE COALESCE(r.fecha_fin, r.fecha) >= ? AND (r.avisado_en IS NULL OR r.avisado_en < ?) AND (m.id IS NULL OR m.oculta = 0)
       ORDER BY r.fecha, r.hora`
    )
    .all(hoy, hoy) as { id: number; fecha: string; fecha_fin: string | null; hora: string | null; titulo: string; avisar_dias: number; materia_nombre: string | null }[]
  const toca = lista.filter((r) => sumarDias(r.fecha, -Math.max(0, r.avisar_dias)) <= hoy)
  if (!toca.length) return 0
  const cuando = (r: (typeof toca)[number]): string => {
    if (r.fecha <= hoy) return r.fecha_fin && r.fecha_fin > hoy ? `en curso hasta el ${fechaLegible(r.fecha_fin)}` : 'hoy'
    if (r.fecha === sumarDias(hoy, 1)) return 'mañana'
    return `el ${fechaLegible(r.fecha)}`
  }
  if (toca.length <= 2) for (const r of toca) mostrar(r.titulo, `${cuando(r)}${r.hora ? ` a las ${r.hora}` : ''}${r.materia_nombre ? ` · ${r.materia_nombre}` : ''}`.replace(/^./, (c) => c.toUpperCase()))
  else mostrar(`${toca.length} fechas próximas`, toca.slice(0, 4).map((r) => `${r.titulo} (${cuando(r)})`).join(' · '))
  const marcar = d.prepare('UPDATE recordatorios SET avisado_en=? WHERE id=?')
  d.transaction(() => toca.forEach((r) => marcar.run(hoy, r.id)))()
  return toca.length
}

/**
 * Avisa a los alumnos que llegaron a un escalón del comunicado (En el límite, Extraordinario, Título de
 * suficiencia, Recursa): una vez por alumno, materia y escalón. La «Alerta» previa solo se muestra en la app.
 */
export function revisarFaltas(materiaId?: number): number {
  const d = getDb()
  const ya = d.prepare('SELECT 1 FROM avisos_faltas WHERE materia_id=? AND alumno_id=? AND nivel=?')
  const nuevas = alertasFaltas(d, materiaId).filter((a) => a.nivel !== 'alerta' && !ya.get(a.materia_id, a.alumno_id, a.nivel))
  if (!nuevas.length) return 0
  if (nuevas.length <= 2) for (const a of nuevas) mostrar(`${ETIQUETA_NIVEL_FALTAS[a.nivel]}: ${a.alumno}`, `${a.materia_nombre} · ${a.texto}`)
  else mostrar(`${nuevas.length} alumnos cambiaron de situación por faltas`, nuevas.slice(0, 4).map((a) => `${a.alumno}: ${ETIQUETA_NIVEL_FALTAS[a.nivel]} (${a.materia_nombre})`).join(' · '))
  const ins = d.prepare('INSERT OR IGNORE INTO avisos_faltas (materia_id, alumno_id, nivel) VALUES (?,?,?)')
  d.transaction(() => nuevas.forEach((a) => ins.run(a.materia_id, a.alumno_id, a.nivel)))()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('faltas:novedades', nuevas.length)
  return nuevas.length
}

export function arrancarAvisos(): void {
  if (reloj) return
  const revisar = (): void => {
    try {
      revisarRecordatorios()
      revisarFaltas()
    } catch (e) {
      console.error('[avisos]', (e as Error).message)
    }
  }
  setTimeout(revisar, 4000)
  reloj = setInterval(revisar, 10 * 60_000)
}
