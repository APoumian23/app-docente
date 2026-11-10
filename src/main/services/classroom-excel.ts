import ExcelJS from 'exceljs'
import type { EstadoEntrega, ResumenClassroom } from '@shared/classroom'

const LETRA: Record<EstadoEntrega, string> = { entrego: 'E', tarde: 'E (tarde)', no_entrego: 'N', pendiente: 'P', retirada: 'R', no_asignada: '—' }
const SI_NO: Record<EstadoEntrega, string> = { entrego: 'Sí', tarde: 'Sí (tarde)', no_entrego: 'No', pendiente: 'Pendiente', retirada: 'No (la retiró)', no_asignada: '—' }

const fechaCorta = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'America/Mexico_City' }).format(new Date(iso)).replace('.', '') : ''

/**
 * Hoja «Entregas Classroom»: cada tarea de Classroom tal cual (E/N), la consolidación por tarea de la
 * app (¿Entregó?, calificación) y cómo se resolvió cada alumno. Al final, lo que hay que revisar.
 */
export function libroEntregas(r: ResumenClassroom, materia: string): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'App Docente'
  const h = wb.addWorksheet('Entregas Classroom')
  const c = r.consolidado
  h.addRow([`CRUCE DE ENTREGAS — GOOGLE CLASSROOM · ${materia}`]).font = { bold: true, size: 14 }
  h.addRow(['E = entregada · N = sin entregar · P = pendiente (aún no vence) · R = la retiró · — = no asignada. La calificación es la de la entrega que cuenta.'])
  const columnas = c.tareas
  h.addRow([
    'Alumno',
    'Matrícula',
    ...r.tareas.map((t) => `${t.titulo}${t.vence || t.creada ? ` (${fechaCorta(t.vence ?? t.creada)})` : ''}`),
    ...columnas.flatMap((t) => [`¿Entregó ${t.nombre}?`, `Calif. ${t.nombre}`]),
    'Cómo se resolvió'
  ]).font = { bold: true }

  const cruda = new Map(r.entregas.map((e) => [`${e.alumno}|${e.tarea}`, e]))
  const logica = new Map(c.celdas.map((e) => [`${e.alumno}|${e.tarea_app}`, e]))

  for (const al of r.alumnos) {
    h.addRow([
      al.nombre,
      al.matricula,
      ...r.tareas.map((t) => (t.curso_id === al.curso_id ? LETRA[cruda.get(`${al.clave}|${t.clave}`)?.estado ?? 'no_asignada'] : '—')),
      ...columnas.flatMap((t) => {
        const e = logica.get(`${al.clave}|${t.clave}`)
        if (!e) return ['—', '']
        const cal = e.calificacion ?? (e.borrador !== null ? `${e.borrador} (borrador)` : '')
        return [SI_NO[e.estado], cal]
      }),
      c.resolucion[al.clave] ?? ''
    ])
  }
  for (const a of r.sin_ligar.app) {
    h.addRow([`${a.apellidos} ${a.nombre}`.trim(), a.matricula, ...r.tareas.map(() => '—'), ...columnas.flatMap(() => ['No', '']), 'No aparece en la lista de Classroom'])
  }

  const notas: string[] = []
  for (const a of c.por_revisar.ambiguas) {
    notas.push(`${a.nombre} solo pudo recuperar con «${a.titulo}»: se acreditó a ${columnas.find((t) => t.clave === a.acreditada)?.nombre ?? '—'}. Decide cuál acreditar en la app.`)
  }
  for (const a of r.sin_ligar.app) notas.push(`${a.nombre} ${a.apellidos} está en tu lista pero NO aparece en Classroom.`)
  if (notas.length) {
    h.addRow([])
    h.addRow(['REVISAR ANTES DE CERRAR CALIFICACIONES']).font = { bold: true }
    notas.forEach((n, i) => h.addRow([`${i + 1}. ${n}`]))
  }

  h.getColumn(1).width = 36
  h.getColumn(2).width = 12
  for (let i = 3; i <= 2 + r.tareas.length + columnas.length * 2; i++) h.getColumn(i).width = 16
  h.getColumn(3 + r.tareas.length + columnas.length * 2).width = 70
  h.getRow(3).alignment = { wrapText: true, vertical: 'top' }
  h.views = [{ state: 'frozen', xSplit: 1, ySplit: 3 }]
  return wb
}
