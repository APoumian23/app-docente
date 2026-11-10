/**
 * Avisos automáticos al alumno sobre sus tareas (van a la campana y, si las activó, como push):
 *  - tarea nueva que puede entregar,
 *  - «vence pronto»: faltan menos de 24 h y no la ha entregado,
 *  - calificación devuelta.
 *
 * Se revisa cada pocos minutos sobre lo mismo que ve el alumno en «Tareas» (así respeta tareas ocultas,
 * «solo para algunos» y lo que no le asignaron en Classroom). Cada aviso se da una sola vez (tabla
 * `avisos_dados`). La primera vez solo se anota lo que ya existe, para no llenar de avisos viejos a nadie.
 *
 * Solo lo corre el servidor en línea (dist/servidor/index.ts): si también lo corriera la Mac, los avisos
 * llegarían dos veces al sincronizar.
 */
import type Database from 'better-sqlite3'
import { leerAjuste, escribirAjuste } from './base'
import { crearNotificacion } from './servicios'
import { tareasDeAlumno } from './tareas'

type DB = Database.Database

const DIA = 86_400_000

const fechaMx = (ms: number): { dia: string; hora: string } => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  )
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` }
}

/** «hoy a las 23:59», «mañana a las 08:00» o «el 3 nov a las 10:00» (hora de Ciudad de México). */
export function cuandoVence(vence: number, ahora: number): string {
  const v = fechaMx(vence)
  if (v.dia === fechaMx(ahora).dia) return `hoy a las ${v.hora}`
  if (v.dia === fechaMx(ahora + DIA).dia) return `mañana a las ${v.hora}`
  const d = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short' }).format(new Date(vence))
  return `el ${d} a las ${v.hora}`
}

/** Revisa a todos los alumnos con cuenta. Devuelve cuántos avisos dio. */
export function revisarAvisos(db: DB, ahora = Date.now()): number {
  const primera = !leerAjuste(db, 'avisos_auto_desde')
  const ya = new Set((db.prepare('SELECT clave FROM avisos_dados').all() as { clave: string }[]).map((r) => r.clave))
  const anotar = db.prepare('INSERT OR IGNORE INTO avisos_dados (clave) VALUES (?)')
  const alumnos = db.prepare("SELECT id, alumno_id FROM usuarios WHERE rol = 'alumno' AND activo = 1 AND alumno_id IS NOT NULL").all() as { id: number; alumno_id: number }[]
  let dados = 0
  db.transaction(() => {
    for (const u of alumnos) {
      for (const m of tareasDeAlumno(db, u.alumno_id, ahora)) {
        for (const t of m.tareas) {
          const base = `${u.alumno_id}:${t.curso_id}:${t.tarea_id}`
          const avisar = (clave: string, titulo: string, cuerpo: string): void => {
            if (ya.has(clave)) return
            ya.add(clave)
            anotar.run(clave)
            if (primera) return
            crearNotificacion(db, u.id, { tipo: 'tarea', titulo, cuerpo, ref_tipo: 'tarea', ref_id: null })
            dados++
          }
          const vence = t.vence ? Date.parse(t.vence) : null
          if (t.estado === 'pendiente' || t.estado === 'recuperacion') {
            const cuando = vence !== null && !t.sin_fecha ? ` · vence ${cuandoVence(vence, ahora)}` : ''
            avisar(`nueva:${base}`, t.estado === 'recuperacion' ? `Tarea de recuperación: ${t.titulo}` : `Tarea nueva: ${t.titulo}`, `${m.materia_nombre}${cuando}`)
          } else {
            // Ya entregada, vencida o cerrada antes de verla: no se anuncia como nueva
            if (!ya.has(`nueva:${base}`)) {
              ya.add(`nueva:${base}`)
              anotar.run(`nueva:${base}`)
            }
          }
          if (t.estado === 'pendiente' && vence !== null && !t.sin_fecha && vence > ahora && vence - ahora <= DIA) {
            avisar(`vence:${base}`, `Vence ${cuandoVence(vence, ahora)}: ${t.titulo}`, `${m.materia_nombre} · todavía no la entregas`)
          }
          if (t.calificacion !== null) {
            avisar(`calif:${base}:${t.calificacion}`, `Calificación: ${t.titulo}`, `${m.materia_nombre} · ${t.calificacion}${t.puntos ? ` de ${t.puntos}` : ''}`)
          }
        }
      }
    }
    if (primera) escribirAjuste(db, 'avisos_auto_desde', new Date(ahora).toISOString())
  })()
  return dados
}

let reloj: NodeJS.Timeout | null = null

/** Cada 3 minutos (y uno a los 20 s de arrancar). `cada` solo cambia en las pruebas. */
export function arrancarAvisosAutomaticos(db: DB, cada = 3 * 60_000): void {
  if (reloj) return
  const revisar = (): void => {
    try {
      const n = revisarAvisos(db)
      if (n) console.log(`[avisos] ${n} aviso(s) automático(s)`)
    } catch (e) {
      console.error('[avisos]', (e as Error).message)
    }
  }
  setTimeout(revisar, Math.min(20_000, cada)).unref()
  reloj = setInterval(revisar, cada)
  reloj.unref()
}
