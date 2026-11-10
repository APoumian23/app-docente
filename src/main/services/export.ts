import ExcelJS from 'exceljs'
import { SQL_CARRERA_MATERIA } from '../../servidor/base'
import { BrowserWindow } from 'electron'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx'
import { getDb } from '../db'
import type { Alumno, ContenidoEvaluacion, Evaluacion, Materia, Sesion } from '@shared/types'
import { calificacionesEsquema, concentradoMateria, proyeccionMateria, alertasFaltas, hoyMx } from '../calificacion'
import { ETIQUETA_ESTADO_CALIF, ETIQUETA_FUENTE, type Esquema, type ResultadoAlumno } from '../../shared/esquema'
import { ETIQUETA_RIESGO } from '../../shared/asistencia'
import { ETIQUETA_CLASIFICACION, ETIQUETA_NIVEL_FALTAS, SUPUESTOS_PROYECCION, alertaFaltas } from '../../shared/proyeccion'

const ESTADO_ABREV: Record<string, string> = { presente: 'P', ausente: 'A', retardo: 'R', justificado: 'J' }

export async function exportarMateriaXlsx(materiaId: number, destino: string, alumnoId?: number): Promise<void> {
  const d = getDb()
  const materia = d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id = ?`).get(materiaId) as Materia
  let alumnos = d
    .prepare('SELECT a.* FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id WHERE i.materia_id = ? ORDER BY a.apellidos, a.nombre')
    .all(materiaId) as Alumno[]
  if (alumnoId) alumnos = alumnos.filter((a) => a.id === alumnoId)
  const sesiones = d.prepare("SELECT * FROM sesiones WHERE materia_id = ? AND estado <> 'cancelada' ORDER BY fecha, hora_inicio").all(materiaId) as Sesion[]
  const asistencias = d
    .prepare('SELECT s.id AS sesion_id, a.alumno_id, a.estado FROM asistencias a JOIN sesiones s ON s.id = a.sesion_id WHERE s.materia_id = ?')
    .all(materiaId) as { sesion_id: number; alumno_id: number; estado: string }[]
  const evaluaciones = d.prepare('SELECT * FROM evaluaciones WHERE materia_id = ? ORDER BY creado').all(materiaId) as Evaluacion[]
  const resultados = d
    .prepare('SELECT r.* FROM resultados r JOIN evaluaciones e ON e.id = r.evaluacion_id WHERE e.materia_id = ?')
    .all(materiaId) as { evaluacion_id: number; alumno_id: number; puntaje: number | null; estado: string; fecha_entrega: string | null }[]

  const wb = new ExcelJS.Workbook()
  wb.creator = 'App Docente'

  // Hoja 1: Alumnos + resumen
  const h1 = wb.addWorksheet('Alumnos')
  h1.addRow([materia.nombre, materia.carrera_nombre]).font = { bold: true, size: 14 }
  h1.addRow([])
  h1.addRow(['Matrícula', 'Apellidos', 'Nombre', 'Correo', 'Sesiones', 'Presentes', 'Retardos', 'Faltas', 'Justificadas', '% Asistencia']).font = { bold: true }
  const conAsistencia = sesiones.filter((s) => asistencias.some((a) => a.sesion_id === s.id))
  for (const al of alumnos) {
    const mias = asistencias.filter((a) => a.alumno_id === al.id)
    const cuenta = (e: string): number => mias.filter((a) => a.estado === e).length
    const total = conAsistencia.length
    const pct = total ? Math.round(((cuenta('presente') + cuenta('retardo') + cuenta('justificado')) / total) * 100) : 0
    h1.addRow([al.matricula, al.apellidos, al.nombre, al.email, total, cuenta('presente'), cuenta('retardo'), cuenta('ausente'), cuenta('justificado'), pct])
  }
  h1.columns.forEach((c) => (c.width = 18))

  // Hoja 2: Matriz de asistencia
  const h2 = wb.addWorksheet('Asistencia')
  h2.addRow(['Matrícula', 'Alumno', ...conAsistencia.map((s) => `${s.fecha} (S${s.semana})`)]).font = { bold: true }
  for (const al of alumnos) {
    h2.addRow([
      al.matricula,
      `${al.apellidos} ${al.nombre}`,
      ...conAsistencia.map((s) => ESTADO_ABREV[asistencias.find((a) => a.sesion_id === s.id && a.alumno_id === al.id)?.estado ?? ''] ?? '')
    ])
  }
  h2.getColumn(2).width = 32

  // Hoja 3: Tareas y evaluaciones
  const h3 = wb.addWorksheet('Evaluaciones')
  h3.addRow(['Matrícula', 'Alumno', ...evaluaciones.map((e) => `${e.titulo} (${e.tipo}, ${e.puntos_totales} pts)`)]).font = { bold: true }
  for (const al of alumnos) {
    h3.addRow([
      al.matricula,
      `${al.apellidos} ${al.nombre}`,
      ...evaluaciones.map((e) => {
        const r = resultados.find((x) => x.evaluacion_id === e.id && x.alumno_id === al.id)
        if (!r) return ''
        return r.puntaje != null ? r.puntaje : r.estado
      })
    ])
  }
  h3.getColumn(2).width = 32

  // Hoja 4: Calificaciones con el esquema de la materia (si lo tiene)
  hojaConcentrado(wb, materiaId, alumnoId)

  // Hoja 5: Sesiones
  const h4 = wb.addWorksheet('Sesiones')
  h4.addRow(['#', 'Semana', 'Fecha', 'Inicio', 'Fin', 'Tema', 'Objetivo', 'Estado']).font = { bold: true }
  sesiones.forEach((s) => h4.addRow([s.numero, s.semana, s.fecha, s.hora_inicio, s.hora_fin, s.tema, s.objetivo, s.estado]))
  h4.getColumn(6).width = 40

  await wb.xlsx.writeFile(destino)
}

const r1 = (x: number | null | undefined): number | string => (x == null ? 'pend.' : Math.round(x * 10) / 10)

/** Calificación por parcial con su desglose por componente según el esquema, final y estado. */
function hojaConcentrado(wb: ExcelJS.Workbook, materiaId: number, alumnoId?: number, encabezado: (h: ExcelJS.Worksheet) => void = () => undefined): void {
  const c = calificacionesEsquema(getDb(), materiaId)
  const h = wb.addWorksheet('Concentrado')
  encabezado(h)
  const e = c.esquema
  if (!e) {
    h.addRow(['Esta materia no tiene esquema de calificación. Configúralo en la pestaña Calificaciones › Esquema.'])
    return
  }
  const fila1: string[] = ['', '', '']
  const fila2: string[] = ['No.', 'Matrícula', 'Alumno']
  for (const p of e.parciales) {
    p.componentes.forEach((k, i) => {
      fila1.push(i === 0 ? p.nombre : '')
      fila2.push(`${k.nombre} (${k.peso} %)`)
    })
    fila1.push('', '', '')
    fila2.push(`Calif. ${p.nombre}`, 'Asistencia %', `Estado ${p.nombre}`)
  }
  fila1.push('Final')
  fila2.push('Calificación final', 'Estado final', '¿Provisional?')
  h.addRow(fila1).font = { bold: true }
  h.addRow(fila2).font = { bold: true }
  const alumnos = alumnoId ? c.alumnos.filter((a) => a.id === alumnoId) : c.alumnos
  alumnos.forEach((a, n) => {
    const r = c.resultados.find((x) => x.alumno_id === a.id) as ResultadoAlumno
    const fila: (string | number)[] = [n + 1, a.matricula, `${a.apellidos} ${a.nombre}`.trim()]
    r.parciales.forEach((rp) => {
      rp.componentes.forEach((k) => fila.push(r1(k.valor)))
      fila.push(r1(rp.calificacion), rp.asistencia == null ? '' : Math.round(rp.asistencia * 10) / 10, ETIQUETA_ESTADO_CALIF[rp.estado] + (rp.provisional && rp.calificacion != null ? ` (sobre ${rp.evaluado} % evaluado)` : ''))
    })
    fila.push(r1(r.final), ETIQUETA_ESTADO_CALIF[r.estado], r.provisional ? 'Sí' : 'No')
    const fx = h.addRow(fila)
    const iFinal = fila.length - 2
    if (r.estado === 'reprobado' || r.estado === 'na_inasistencia') fx.getCell(iFinal).font = { color: { argb: 'FFB91C1C' }, bold: true }
  })
  h.columns.forEach((col, i) => (col.width = i === 2 ? 34 : i < 2 ? 12 : 14))
  h.addRow([])
  h.addRow([`Componentes en escala 0–10. «pend.» = sin datos todavía: no cuenta como cero, la calificación del parcial se reparte entre lo ya evaluado. Mínima aprobatoria ${e.minima}${e.asistencia_minima != null ? `; con menos de ${e.asistencia_minima} % de asistencia en el parcial queda «NA por inasistencias»` : ''}.`])
}

function hojaEsquema(wb: ExcelJS.Workbook, e: Esquema | null, encabezado: (h: ExcelJS.Worksheet) => void): void {
  const h = wb.addWorksheet('Esquema')
  encabezado(h)
  if (!e) {
    h.addRow(['Sin esquema de calificación.'])
    return
  }
  h.addRow(['Reglas']).font = { bold: true }
  h.addRow(['Calificación mínima aprobatoria (0–10)', e.minima])
  h.addRow(['Asistencia mínima por parcial', e.asistencia_minima == null ? 'Sin regla (se usa el límite de horas del comunicado COM-AS-01)' : `${e.asistencia_minima} % (debajo: NA por inasistencias)`])
  h.addRow(['Un retardo cuenta como', `${e.retardo_vale} asistencia`])
  h.addRow(['Redondeo', e.escala_100 ? 'Se suma sobre 100, se redondea a un decimal y se divide entre 10 (un decimal)' : 'Se suma sobre 10 y se redondea a un decimal'])
  h.addRow(['Final', 'Promedio de los parciales con su peso'])
  if (e.nota) h.addRow(['Nota', e.nota])
  h.addRow([])
  h.addRow(['Parcial', 'Desde', 'Hasta', 'Peso en la final', 'Componente', 'Peso %', 'Fuente', 'Detalle']).font = { bold: true }
  for (const p of e.parciales)
    p.componentes.forEach((k, i) =>
      h.addRow([
        i === 0 ? p.nombre : '', i === 0 ? p.desde : '', i === 0 ? p.hasta : '', i === 0 ? p.peso : '', k.nombre, k.peso, ETIQUETA_FUENTE[k.fuente],
        k.fuente === 'manual' ? `Captura sobre ${k.escala}${k.rubros.length > 1 ? ` · promedio de ${k.rubros.join(', ')}` : ''}` : k.fuente === 'participacion' ? `${k.meta} participaciones = 100 %` : k.fuente === 'evaluaciones' || k.fuente === 'actividades' ? (k.evaluaciones.length ? `${k.evaluaciones.length} evaluaciones elegidas` : 'Automático: evaluaciones del rango')
          : k.fuente === 'classroom_promedio' ? 'Promedio de las tareas de Classroom con fecha en el parcial (no entregada = 0); lo capturado a mano manda'
          : k.fuente === 'classroom_entregas' ? '% de trabajos de Classroom del parcial entregados; lo capturado a mano manda'
          : 'Sesiones del rango del parcial'
      ])
    )
  h.addRow([])
  h.addRow(['Un componente sin datos queda pendiente (no es cero) y la calificación del parcial se reparte entre los pesos de lo ya evaluado. «No entregó» sí cuenta como cero.'])
  h.getColumn(1).width = 38
  h.columns.forEach((c, i) => i > 0 && (c.width = i === 4 ? 28 : i === 7 ? 40 : 16))
}

/**
 * Libro completo de una materia: concentrado con el esquema, asistencia, participaciones, esquema y proyección.
 * Cada hoja lleva materia, periodo, docente y fecha de corte para que el archivo se entienda solo.
 */
export async function exportarTodoXlsx(materiaId: number, destino: string, docente: string): Promise<void> {
  const d = getDb()
  const hoy = hoyMx()
  const c = concentradoMateria(d, materiaId)
  const datos = calificacionesEsquema(d, materiaId)
  const materia = d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id = ?`).get(materiaId) as Materia
  const encabezado = (h: ExcelJS.Worksheet): void => {
    h.addRow([`${materia.nombre} · ${materia.carrera_nombre ?? ''}`]).font = { bold: true, size: 14 }
    h.addRow([`Periodo: ${c.materia.periodo} · Docente: ${docente || '—'} · Fecha de corte: ${hoy}`])
    h.addRow([])
  }
  const wb = new ExcelJS.Workbook()
  wb.creator = 'App Docente'
  hojaConcentrado(wb, materiaId, undefined, encabezado)

  // Asistencia: alumnos × sesiones con registro
  const ha = wb.addWorksheet('Asistencia')
  encabezado(ha)
  const sesiones = d.prepare("SELECT s.* FROM sesiones s WHERE s.materia_id = ? AND s.estado <> 'cancelada' AND EXISTS (SELECT 1 FROM asistencias a WHERE a.sesion_id = s.id) ORDER BY s.fecha, s.hora_inicio").all(materiaId) as Sesion[]
  const asis = d.prepare('SELECT a.sesion_id, a.alumno_id, a.estado FROM asistencias a JOIN sesiones s ON s.id = a.sesion_id WHERE s.materia_id = ?').all(materiaId) as { sesion_id: number; alumno_id: number; estado: string }[]
  ha.addRow(['Matrícula', 'Alumno', ...sesiones.map((s) => `${s.fecha} (S${s.numero})`), 'Sesiones', 'Presentes', 'Retardos', 'Faltas', 'Justificadas', '% asistencia', 'Horas de falta', 'Límite (h)', 'Situación']).font = { bold: true }
  for (const f of c.filas) {
    const mias = asis.filter((a) => a.alumno_id === f.alumno.id)
    const n = (e: string): number => mias.filter((a) => a.estado === e).length
    ha.addRow([
      f.alumno.matricula, `${f.alumno.apellidos} ${f.alumno.nombre}`.trim(),
      ...sesiones.map((s) => ESTADO_ABREV[mias.find((a) => a.sesion_id === s.id)?.estado ?? ''] ?? ''),
      mias.length, n('presente'), n('retardo'), n('ausente'), n('justificado'), f.porcentaje_asistencia ?? '', f.horas_falta, c.limites.limite, ETIQUETA_RIESGO[f.riesgo]
    ])
  }
  ha.getColumn(2).width = 34
  ha.addRow([])
  ha.addRow(['P = presente · R = retardo · A = falta · J = justificada (no cuenta como falta). Las horas de falta se cuentan por hora de clase (comunicado COM-AS-01).'])

  // Participaciones por parcial (solo si hay)
  if (datos.participaciones.length) {
    const hp = wb.addWorksheet('Participaciones')
    encabezado(hp)
    const parciales = datos.esquema?.parciales ?? []
    hp.addRow(['Matrícula', 'Alumno', ...parciales.map((p) => p.nombre), 'Total']).font = { bold: true }
    for (const a of datos.alumnos) {
      const mias = datos.participaciones.filter((x) => x.alumno_id === a.id)
      hp.addRow([a.matricula, `${a.apellidos} ${a.nombre}`.trim(), ...parciales.map((p) => mias.filter((x) => x.fecha >= p.desde && x.fecha <= p.hasta).length), mias.length])
    }
    hp.getColumn(2).width = 34
  }

  hojaEsquema(wb, datos.esquema, encabezado)

  // Proyección y avisos por faltas
  const hpr = wb.addWorksheet('Proyección')
  encabezado(hpr)
  const pr = proyeccionMateria(d, materiaId, hoy)
  const alertas = alertasFaltas(d, materiaId, hoy)
  if (!pr) hpr.addRow(['Sin esquema de calificación: no hay proyección.'])
  else {
    hpr.addRow(['Matrícula', 'Alumno', 'Clasificación', 'Acumulada (0–10)', 'Al ritmo actual', '% evaluado', 'Necesita en lo que falta', 'Situación', 'Asistencia parcial actual %', 'Faltas', 'Horas de falta', 'Límite (h)', 'Situación por faltas (COM-AS-01)', 'Detalle de faltas', 'Faltas que aún puede tener en el parcial (regla de calificación)', 'Motivos']).font = { bold: true }
    const situacion: Record<string, string> = { ya_aprobado: 'Ya aprobado aunque saque 0', alcanzable: 'Alcanzable', imposible: 'Ya no alcanza aunque saque 10', sin_pendientes: 'Sin pendientes', sin_datos: 'Sin datos' }
    for (const a of pr.alumnos) {
      const al = alertas.find((x) => x.alumno_id === a.alumno_id)
      hpr.addRow([
        a.matricula, a.nombre, ETIQUETA_CLASIFICACION[a.clasificacion], a.acumulada, a.al_ritmo_actual ?? '', a.evaluado_pct, a.necesita ?? '', situacion[a.situacion],
        a.asistencia.pct_parcial_actual ?? '', a.asistencia.faltas, a.asistencia.horas_falta, a.asistencia.limites.limite, al ? ETIQUETA_NIVEL_FALTAS[al.nivel] : 'En regla', alertaFaltas(a.asistencia).texto, a.asistencia.faltas_permitidas_parcial ?? '', a.motivos.join(' ')
      ])
    }
    hpr.getColumn(2).width = 34
    hpr.getColumn(13).width = 22
    hpr.getColumn(14).width = 50
    hpr.getColumn(16).width = 70
    hpr.addRow([])
    hpr.addRow(['Supuestos']).font = { bold: true }
    SUPUESTOS_PROYECCION.forEach((t) => hpr.addRow([t]))
  }
  await wb.xlsx.writeFile(destino)
}

/** Lista de alumnos de una materia con su usuario del portal, para control escolar o para repartir accesos. */
export async function exportarAlumnosXlsx(materiaId: number, destino: string): Promise<number> {
  const d = getDb()
  const materia = d.prepare(`SELECT m.nombre, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id = ?`).get(materiaId) as { nombre: string; carrera_nombre: string }
  const alumnos = d
    .prepare('SELECT a.matricula, a.apellidos, a.nombre, a.email, u.usuario, u.debe_cambiar FROM alumnos a JOIN inscripciones i ON i.alumno_id = a.id LEFT JOIN usuarios u ON u.alumno_id = a.id WHERE i.materia_id = ? ORDER BY a.apellidos, a.nombre')
    .all(materiaId) as { matricula: string; apellidos: string; nombre: string; email: string; usuario: string | null; debe_cambiar: number | null }[]
  const wb = new ExcelJS.Workbook()
  const h = wb.addWorksheet('Alumnos')
  h.addRow([materia.nombre, materia.carrera_nombre]).font = { bold: true, size: 14 }
  h.addRow([])
  h.addRow(['#', 'Matrícula', 'Apellidos', 'Nombre', 'Correo', 'Usuario del portal', 'Estado del acceso']).font = { bold: true }
  alumnos.forEach((a, i) => h.addRow([i + 1, a.matricula, a.apellidos, a.nombre, a.email, a.usuario ?? '', a.usuario ? (a.debe_cambiar ? 'Contraseña inicial sin cambiar' : 'Activo') : 'Sin acceso']))
  h.columns.forEach((c) => (c.width = 20))
  await wb.xlsx.writeFile(destino)
  return alumnos.length
}

/** Renderiza HTML en una ventana oculta y lo imprime a PDF. */
let ventanaPdf: BrowserWindow | null = null

/** Una sola ventana oculta para todos los PDF: crear y destruir una por exportación tiraba el proceso al exportar en ráfaga. */
function ventanaParaPdf(): BrowserWindow {
  // Sesión propia: Chromium comparte el zoom entre páginas file:// de la misma sesión y el de la ventana principal agrandaría el PDF
  if (!ventanaPdf || ventanaPdf.isDestroyed()) ventanaPdf = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition: 'pdf' } })
  return ventanaPdf
}

let colaPdf: Promise<void> = Promise.resolve()

export function htmlAPdf(html: string, destino: string): Promise<void> {
  // Las exportaciones se encolan: la ventana compartida solo puede renderizar un documento a la vez
  const tarea = colaPdf.then(async () => {
    // El HTML se escribe a un archivo temporal: una URL data: con un documento grande supera el límite de Chromium
    const temporal = join(tmpdir(), `app-docente-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
    writeFileSync(temporal, html, 'utf8')
    try {
      const win = ventanaParaPdf()
      await win.loadFile(temporal)
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
      writeFileSync(destino, pdf)
    } finally {
      rmSync(temporal, { force: true })
    }
  })
  colaPdf = tarea.catch(() => undefined)
  return tarea
}

export function evaluacionAHtml(ev: Evaluacion, materia: Materia, conRespuestas: boolean, docente: string): string {
  const c = JSON.parse(ev.contenido) as ContenidoEvaluacion
  const letras = 'abcdefgh'
  const preguntas = c.preguntas
    .map((p, i) => {
      const opciones = p.opciones?.length
        ? `<ol class="op">${p.opciones.map((o, j) => `<li>${letras[j]}) ${esc(o)}</li>`).join('')}</ol>`
        : p.tipo === 'verdadero_falso'
          ? '<p class="vf">( ) Verdadero &nbsp;&nbsp; ( ) Falso</p>'
          : '<div class="espacio"></div>'
      const resp = conRespuestas ? `<div class="resp"><b>Respuesta:</b> ${esc(p.respuesta)}<br><i>${esc(p.explicacion)}</i></div>` : ''
      return `<div class="preg"><p><b>${i + 1}.</b> ${esc(p.enunciado)} <span class="pts">(${p.puntos} pts)</span></p>${opciones}${resp}</div>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12pt;color:#111;margin:0}
  h1{font-size:18pt;margin:0 0 4px}.meta{color:#444;font-size:10pt;margin-bottom:12px;border-bottom:2px solid #222;padding-bottom:8px}
  .datos{display:flex;gap:24px;margin:10px 0 16px;font-size:11pt}.datos span{border-bottom:1px solid #333;min-width:180px;display:inline-block}
  .instr{background:#f3f4f6;padding:8px 10px;border-radius:6px;font-size:11pt}
  .preg{margin:14px 0;page-break-inside:avoid}.op{list-style:none;padding-left:14px;margin:4px 0}.op li{margin:2px 0}
  .espacio{height:70px;border-bottom:1px dashed #999;margin:6px 0}.pts{color:#666;font-size:10pt}
  .resp{background:#ecfdf5;border-left:3px solid #10b981;padding:6px 8px;margin-top:6px;font-size:10.5pt}.vf{margin:4px 0 0 14px}
  </style></head><body>
  <h1>${esc(c.titulo || ev.titulo)}</h1>
  <div class="meta">${esc(materia.nombre)} · ${esc(materia.carrera_nombre ?? '')} · Docente: ${esc(docente)} · Duración sugerida: ${c.duracion_min} min · Total: ${ev.puntos_totales} pts${conRespuestas ? ' · <b>CLAVE DE RESPUESTAS</b>' : ''}</div>
  ${conRespuestas ? '' : '<div class="datos"><div>Nombre: <span></span></div><div>Matrícula: <span></span></div><div>Fecha: <span></span></div></div>'}
  <div class="instr">${esc(c.instrucciones)}</div>
  ${preguntas}
  </body></html>`
}

export function reporteAlumnoHtml(materiaId: number, alumnoId: number, docente: string): string {
  const d = getDb()
  const materia = d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id = ?`).get(materiaId) as Materia
  const al = d.prepare('SELECT * FROM alumnos WHERE id = ?').get(alumnoId) as Alumno
  const asis = d
    .prepare('SELECT s.fecha, s.semana, s.tema, a.estado FROM asistencias a JOIN sesiones s ON s.id = a.sesion_id WHERE s.materia_id = ? AND a.alumno_id = ? ORDER BY s.fecha')
    .all(materiaId, alumnoId) as { fecha: string; semana: number; tema: string; estado: string }[]
  const evs = d
    .prepare('SELECT e.titulo, e.tipo, e.puntos_totales, r.puntaje, r.estado, r.fecha_entrega FROM evaluaciones e LEFT JOIN resultados r ON r.evaluacion_id = e.id AND r.alumno_id = ? WHERE e.materia_id = ? ORDER BY e.creado')
    .all(alumnoId, materiaId) as { titulo: string; tipo: string; puntos_totales: number; puntaje: number | null; estado: string | null; fecha_entrega: string | null }[]
  const total = asis.length
  const efectivas = asis.filter((a) => a.estado !== 'ausente').length
  const pct = total ? Math.round((efectivas / total) * 100) : 0
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11pt;color:#111}h1{font-size:17pt;margin:0}h2{font-size:13pt;margin:18px 0 6px;border-bottom:1px solid #999}
  table{border-collapse:collapse;width:100%;font-size:10pt}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}th{background:#eef}
  .kpi{display:flex;gap:18px;margin:10px 0}.kpi div{background:#f3f4f6;padding:8px 12px;border-radius:6px}.kpi b{font-size:16pt;display:block}
  </style></head><body>
  <h1>Reporte del alumno</h1><div>${esc(materia.nombre)} · ${esc(materia.carrera_nombre ?? '')} · Docente: ${esc(docente)}</div>
  <div class="kpi"><div><b>${esc(al.matricula)}</b>${esc(al.apellidos)} ${esc(al.nombre)}</div><div><b>${pct}%</b>Asistencia</div><div><b>${efectivas}/${total}</b>Sesiones asistidas</div></div>
  <h2>Asistencias</h2><table><tr><th>Fecha</th><th>Semana</th><th>Tema</th><th>Estado</th></tr>${asis.map((a) => `<tr><td>${a.fecha}</td><td>${a.semana}</td><td>${esc(a.tema)}</td><td>${a.estado}</td></tr>`).join('')}</table>
  <h2>Tareas y evaluaciones</h2><table><tr><th>Título</th><th>Tipo</th><th>Estado</th><th>Entrega</th><th>Puntaje</th></tr>${evs.map((e) => `<tr><td>${esc(e.titulo)}</td><td>${e.tipo}</td><td>${e.estado ?? 'pendiente'}</td><td>${e.fecha_entrega ?? ''}</td><td>${e.puntaje != null ? `${e.puntaje} / ${e.puntos_totales}` : ''}</td></tr>`).join('')}</table>
  </body></html>`
}

export async function evaluacionADocx(ev: Evaluacion, materia: Materia, conRespuestas: boolean, destino: string): Promise<void> {
  const c = JSON.parse(ev.contenido) as ContenidoEvaluacion
  const letras = 'abcdefgh'
  const parrafos: Paragraph[] = [
    new Paragraph({ text: c.titulo || ev.titulo, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({ text: `${materia.nombre} · ${materia.carrera_nombre ?? ''} · ${c.duracion_min} min · ${ev.puntos_totales} pts`, color: '555555' })] }),
    new Paragraph({ text: conRespuestas ? 'CLAVE DE RESPUESTAS' : 'Nombre: ______________________________   Matrícula: __________   Fecha: __________' }),
    new Paragraph({ text: c.instrucciones, spacing: { after: 200 } })
  ]
  c.preguntas.forEach((p, i) => {
    parrafos.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}. `, bold: true }), new TextRun(p.enunciado), new TextRun({ text: `  (${p.puntos} pts)`, color: '777777' })], spacing: { before: 160 } }))
    p.opciones?.forEach((o, j) => parrafos.push(new Paragraph({ text: `${letras[j]}) ${o}`, indent: { left: 480 } })))
    if (p.tipo === 'verdadero_falso') parrafos.push(new Paragraph({ text: '( ) Verdadero    ( ) Falso', indent: { left: 480 } }))
    if (!p.opciones?.length && p.tipo !== 'verdadero_falso' && !conRespuestas) parrafos.push(new Paragraph({ text: '\n\n', alignment: AlignmentType.LEFT }))
    if (conRespuestas) parrafos.push(new Paragraph({ children: [new TextRun({ text: 'Respuesta: ', bold: true }), new TextRun(p.respuesta), new TextRun({ text: `  ${p.explicacion}`, italics: true })], indent: { left: 480 } }))
  })
  const doc = new Document({ sections: [{ children: parrafos }] })
  const buf = await Packer.toBuffer(doc)
  writeFileSync(destino, buf)
}

/** Convierte **negritas**, *cursivas* y `código` de una línea de markdown en fragmentos con formato. */
function fragmentos(linea: string): TextRun[] {
  const partes = linea.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean)
  return partes.map((p) => {
    if (p.startsWith('**') && p.endsWith('**')) return new TextRun({ text: p.slice(2, -2), bold: true })
    if (p.startsWith('`') && p.endsWith('`')) return new TextRun({ text: p.slice(1, -1), font: 'Menlo' })
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return new TextRun({ text: p.slice(1, -1), italics: true })
    return new TextRun(p)
  })
}

export function markdownADocxSimple(titulo: string, markdown: string, destino: string): Promise<void> {
  const lineas = markdown.split('\n')
  const parrafos: Paragraph[] = [new Paragraph({ text: titulo, heading: HeadingLevel.HEADING_1 })]
  for (const l of lineas) {
    if (l.startsWith('### ')) parrafos.push(new Paragraph({ text: l.slice(4), heading: HeadingLevel.HEADING_3 }))
    else if (l.startsWith('## ')) parrafos.push(new Paragraph({ text: l.slice(3), heading: HeadingLevel.HEADING_2 }))
    else if (l.startsWith('# ')) parrafos.push(new Paragraph({ text: l.slice(2), heading: HeadingLevel.HEADING_1 }))
    else if (/^\s*[-*] /.test(l)) parrafos.push(new Paragraph({ children: fragmentos(l.replace(/^\s*[-*] /, '')), bullet: { level: 0 } }))
    else parrafos.push(new Paragraph({ children: fragmentos(l) }))
  }
  const doc = new Document({ sections: [{ children: parrafos }] })
  return Packer.toBuffer(doc).then((b) => writeFileSync(destino, b))
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Material en markdown (planes, tareas, glosarios) a HTML imprimible. */
export function markdownAHtml(titulo: string, md: string): string {
  // Conversión mínima para PDF (encabezados, listas, negritas, código). Suficiente para material de apoyo.
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lineas = md.split('\n')
  let html = ''
  let enLista = false
  let enCodigo = false
  for (const l of lineas) {
    if (l.startsWith('```')) {
      html += enCodigo ? '</pre>' : '<pre>'
      enCodigo = !enCodigo
      continue
    }
    if (enCodigo) {
      html += esc(l) + '\n'
      continue
    }
    const esItem = /^\s*[-*] /.test(l)
    if (esItem && !enLista) {
      html += '<ul>'
      enLista = true
    }
    if (!esItem && enLista) {
      html += '</ul>'
      enLista = false
    }
    let t = esc(l).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')
    if (l === '---') t = '<hr>'
    else if (l.startsWith('### ')) t = `<h3>${t.slice(4)}</h3>`
    else if (l.startsWith('## ')) t = `<h2>${t.slice(3)}</h2>`
    else if (l.startsWith('# ')) t = `<h1>${t.slice(2)}</h1>`
    else if (esItem) t = `<li>${t.replace(/^\s*[-*] /, '')}</li>`
    else if (l.trim()) t = `<p>${t}</p>`
    html += t
  }
  if (enLista) html += '</ul>'
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11.5pt;color:#111;line-height:1.45}h1{font-size:18pt}h2{font-size:14pt;margin-top:18px}pre{background:#f3f4f6;padding:8px;border-radius:6px;font-size:10pt;white-space:pre-wrap}code{background:#f3f4f6;padding:1px 4px;border-radius:3px}hr{border:0;border-top:1px solid #999;margin:14px 0}</style></head><body><h1>${esc(titulo)}</h1>${html}</body></html>`
}
