/**
 * «Mi avance» del alumno en el portal: por materia, sus parciales con el detalle de cada componente,
 * su asistencia contra el comunicado de faltas y lo que necesita para aprobar. Usa el mismo cálculo
 * que la app del docente (src/main/calificacion.ts), así ambos ven el mismo número. Solo sus datos.
 * Cada parcial sale solo cuando el docente lo publica; mientras, «En captura». El docente puede apagar
 * todo el apartado (ajuste portal_alumno_avance = '0').
 */
import type Database from 'better-sqlite3'
import { concentradoMateria, hoyMx, proyeccionMateria } from '../main/calificacion'
import { ETIQUETA_ESTADO_CALIF } from '../shared/esquema'
import { ETIQUETA_RIESGO, type Riesgo } from '../shared/asistencia'
import type { AvanceMateria } from '../shared/avance'
import { leerAjuste } from './base'

/** Textos del cálculo que son instrucciones para el docente: al alumno solo se le dice que está pendiente. */
const paraAlumno = (detalle: string): string =>
  /Classroom no conectado|sin ligar a Classroom|captura a mano|falta capturar/i.test(detalle) ? 'pendiente' : detalle

/**
 * Al terminar un examen, 40 alumnos abren «Mi avance» a la vez: el cálculo de cada materia se guarda
 * 30 s para no recalcular lo mismo 40 veces (el servidor atiende también los envíos de respuestas).
 */
const CACHE_MS = 30_000
const cache = new Map<number, { t: number; hoy: string; concentrado: ReturnType<typeof concentradoMateria>; proyeccion: ReturnType<typeof proyeccionMateria> }>()
function calculoDe(db: Database.Database, materiaId: number, hoy: string): { concentrado: ReturnType<typeof concentradoMateria>; proyeccion: ReturnType<typeof proyeccionMateria> } {
  const c = cache.get(materiaId)
  if (c && c.hoy === hoy && Date.now() - c.t < CACHE_MS) return c
  const nuevo = { t: Date.now(), hoy, concentrado: concentradoMateria(db, materiaId), proyeccion: proyeccionMateria(db, materiaId, hoy) }
  cache.set(materiaId, nuevo)
  return nuevo
}
export function avanceDeAlumno(db: Database.Database, alumnoId: number): { visible: boolean; materias: AvanceMateria[] } {
  if (leerAjuste(db, 'portal_alumno_avance', '1') === '0') return { visible: false, materias: [] }
  const hoy = hoyMx()
  const materias = db
    .prepare('SELECT m.id, m.nombre, m.color FROM materias m JOIN inscripciones i ON i.materia_id = m.id WHERE i.alumno_id = ? AND m.oculta = 0 ORDER BY m.nombre')
    .all(alumnoId) as { id: number; nombre: string; color: string }[]
  // Fechas de la materia y, del calendario general, solo parciales y suspensiones (no trámites del docente)
  const fechas = db.prepare(
    `SELECT fecha, fecha_fin, titulo, tipo FROM recordatorios
     WHERE (materia_id = ? OR (materia_id IS NULL AND tipo IN ('parcial', 'suspension'))) AND COALESCE(fecha_fin, fecha) >= ?
     ORDER BY fecha LIMIT 6`
  )
  const publicados = db.prepare('SELECT publicado FROM calif_parciales WHERE materia_id = ? ORDER BY orden, id')
  const sinLista = db.prepare(
    `SELECT COUNT(*) AS n FROM sesiones s WHERE s.materia_id = ? AND s.estado <> 'cancelada' AND s.fecha < ?
     AND NOT EXISTS (SELECT 1 FROM asistencias a WHERE a.sesion_id = s.id)`
  )
  return {
    visible: true,
    materias: materias.map((m) => {
      const { concentrado, proyeccion: pr } = calculoDe(db, m.id, hoy)
      const f = concentrado.filas.find((x) => x.alumno.id === alumnoId)
      const p = pr?.alumnos.find((x) => x.alumno_id === alumnoId)
      const l = concentrado.limites
      const horas = p?.asistencia.horas_falta ?? f?.horas_falta ?? 0
      const riesgo: Riesgo = p?.asistencia.riesgo ?? f?.riesgo ?? 'ok'
      const sig = p?.asistencia.siguiente
      const esquema = pr?.esquema
      const pub = (publicados.all(m.id) as { publicado: number }[]).map((x) => x.publicado === 1)
      const parciales = (p?.parciales ?? []).map((x, i) => {
        const base = { nombre: x.nombre, desde: esquema?.parciales[i]?.desde ?? '', hasta: esquema?.parciales[i]?.hasta ?? '' }
        if (!pub[i]) return { ...base, publicado: false, calificacion: null, estado: 'pendiente' as const, etiqueta: 'En captura', provisional: true, asistencia: null, componentes: [] }
        return {
          ...base,
          publicado: true,
          calificacion: x.calificacion,
          estado: x.estado,
          etiqueta: ETIQUETA_ESTADO_CALIF[x.estado],
          provisional: x.provisional,
          asistencia: x.asistencia,
          componentes: x.componentes.map((c) => ({ ...c, detalle: paraAlumno(c.detalle) }))
        }
      })
      // La final y «lo que necesitas» mezclan todos los parciales: solo salen si no revelan uno sin publicar
      const resumenVisible = (p?.parciales ?? []).every((x, i) => pub[i] || x.calificacion == null)
      return {
        ...m,
        minima: esquema?.minima ?? null,
        resumen_visible: resumenVisible,
        al_ritmo_actual: resumenVisible ? p?.al_ritmo_actual ?? null : null,
        evaluado_pct: resumenVisible ? p?.evaluado_pct ?? 0 : 0,
        necesita: resumenVisible ? p?.necesita ?? null : null,
        situacion: resumenVisible ? p?.situacion ?? null : null,
        parciales,
        asistencia: {
          horas_falta: horas,
          limite: l.limite,
          extraordinario: l.extraordinario,
          recursa: l.recursa,
          riesgo,
          etiqueta: ETIQUETA_RIESGO[riesgo],
          siguiente: sig ? `Con ${sig.horas} h más de falta: ${ETIQUETA_RIESGO[sig.riesgo]}` : null,
          porcentaje: f?.porcentaje_asistencia ?? null,
          sin_lista: (sinLista.get(m.id, hoy) as { n: number }).n
        },
        proximas: fechas.all(m.id, hoy) as AvanceMateria['proximas']
      }
    })
  }
}
