import { ipcMain, dialog, shell, BrowserWindow, app, type IpcMainInvokeEvent } from 'electron'
import { SQL_CARRERA_MATERIA } from '../../servidor/base'
import { basename, extname, join, relative, isAbsolute } from 'path'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { getDb, getAjuste, setAjuste, generarSesionesMateria, materialesDir, rutaMaterial, PLANTILLA_ACTIVIDADES } from '../db'
import { extraerTexto, tipoPorExtension } from '../services/extract'
import { generar, generarJuego, examenDesdeArchivo, type OpcionesExamenArchivo, preguntar, guardarApiKey, hayApiKey, probarConexion, proveedor, modeloClaude, ajusteModeloRapido, MODELO_RAPIDO_POR_DEFECTO, MODELO_CLAUDE_POR_DEFECTO, analizarProyeccion } from '../services/ia'
import { gastoIA } from '../services/uso-ia'
import { listarModelos, MODELO_POR_DEFECTO } from '../services/nvidia'
import { passwordConfigurada, establecerPassword, quitarPassword, exigirPassword, verificarPassword } from '../services/seguridad'
import { pdfProyectable, necesitaConversion, convertirAPdf, conversorDisponible, rutaPdfDe } from '../services/presentacion'
import {
  estadoPortal, iniciarPortal, detenerPortal, configurarDocente, guardarAjustesPortal, urlParaAlumnos, qrDe, abrirPanelDocente, urlPanelIncrustado, jugarEnVivo, notificacionesDocente, marcarNotificacionesLeidas,
  accesosDeMateria, accesoDeAlumno, reiniciarAccesoDeAlumno, sincronizarAhora, avisoAlGrupo
} from '../services/portal'
import { configRemoto, accionRemota } from '../services/portal-remoto'
import { ocultarMateria } from '../../servidor/servicios'
import { interpretarLista, leerFilas } from '../services/importar'
import { abrirArchivo } from '../abrir'
import { revisar as revisarActualizacion, instalar as instalarActualizacion } from '../services/actualizacion'
import { exportarMateriaXlsx, exportarAlumnosXlsx, htmlAPdf, evaluacionAHtml, reporteAlumnoHtml, evaluacionADocx, markdownADocxSimple, markdownAHtml } from '../services/export'
import ExcelJS from 'exceljs'
import * as R from '../services/respaldos'
import * as A from '../services/asistente'
import { estadoPaquetes, descargarPaquete, borrarPaquetes, cancelarDescarga } from '../services/pyodide'
import { ajustarParcial, ajustarFinal, concentradoMateria, calificacionesEsquema, guardarEsquema, esquemaPorOmision, capturasDe, guardarCaptura, proyeccionMateria, alertasFaltas, hoyMx } from '../calificacion'
import { revisarRecordatorios, revisarFaltas } from '../services/avisos'
import { exportarTodoXlsx } from '../services/export'
import type { Esquema } from '@shared/esquema'
import type { Actividad, Alumno, Evaluacion, GeneracionIA, Materia, Sesion } from '@shared/types'
import { registrarClassroom } from './classroom'
import { vistaMaterial } from '../services/visor'
import { registrarError, listarErrores, marcarErroresRevisados, borrarErrores, rutaRegistroErrores } from '../services/errores'
import type { OrigenError } from '@shared/errores'
import { resumenMateria } from '../services/classroom-datos'

type Row = Record<string, unknown>
type MaterialLista = { titulo: string; unidad: string; tipo: string }

/**
 * Deja primero el material general (programa, plan, administrativo) y luego el de cada
 * sesión en orden ascendente: "Sesión 2" antes que "Sesión 10", que es como se dan las clases.
 */
function ordenarMateriales<T extends MaterialLista>(lista: T[]): T[] {
  const numero = (u: string): number | null => {
    const m = /(\d+)/.exec(u ?? '')
    return m ? Number(m[1]) : null
  }
  const esDeSesion = (u: string): boolean => /sesi[oó]n|semana/i.test(u ?? '')
  return [...lista].sort((a, b) => {
    const ga = esDeSesion(a.unidad) ? 1 : 0
    const gb = esDeSesion(b.unidad) ? 1 : 0
    if (ga !== gb) return ga - gb
    const na = numero(a.unidad)
    const nb = numero(b.unidad)
    if (na !== null && nb !== null && na !== nb) return na - nb
    return (a.unidad ?? '').localeCompare(b.unidad ?? '', 'es') || a.titulo.localeCompare(b.titulo, 'es')
  })
}

/**
 * Solo la ventana de la app, en su marco principal, puede pedir cosas al proceso principal: ni un
 * iframe (p. ej. GeoGebra) ni una página externa a la que se haya llegado por un enlace.
 */
function esDeLaApp(e: IpcMainInvokeEvent): boolean {
  const marco = e.senderFrame
  if (!marco || marco !== e.sender.mainFrame) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return marco.url.startsWith(dev)
  try {
    const u = new URL(marco.url)
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).endsWith('/renderer/index.html')
  } catch {
    return false
  }
}

function h(canal: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(canal, async (e, ...args) => {
    // En la versión web la llamada ya llega autenticada por el servidor (solo el docente principal)
    if (process.env.DOCENTE_WEB !== '1' && !esDeLaApp(e)) {
      console.error(`[ipc ${canal}] rechazado: viene de ${e.senderFrame?.url ?? 'un marco desconocido'}`)
      return { ok: false, error: 'Petición no permitida.' }
    }
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      // Versión web: «elige el archivo» no es una falla, la página abre el selector y repite la llamada
      if (err instanceof Error && err.name === 'NecesitaArchivo') throw err
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[ipc ${canal}]`, msg)
      if (!canal.startsWith('errores:')) registrarError('base', `ipc ${canal}`, err)
      return { ok: false, error: msg }
    }
  })
}

export function registrarIpc(): void {
  const d = getDb()
  registrarClassroom(h)
  // Registro de errores (Ajustes › Errores)
  h('errores:listar', () => listarErrores())
  h('errores:revisados', () => marcarErroresRevisados())
  h('errores:borrar', () => borrarErrores())
  h('errores:mostrarArchivo', () => shell.showItemInFolder(rutaRegistroErrores()))
  // Lo que manda la ventana siempre es «pantalla»: «ventana» queda para caídas que ve el proceso principal
  h('errores:registrar', (_origen: OrigenError, donde: string, mensaje: string, detalle: string) =>
    registrarError('pantalla', String(donde ?? '').slice(0, 200), String(mensaje ?? ''), String(detalle ?? ''))
  )
  const olvidarAvisosArriba = (sesionId: number, alumnoId: number): void => {
    const s = d.prepare('SELECT materia_id FROM sesiones WHERE id=?').get(sesionId) as { materia_id: number } | undefined
    if (!s) return
    const orden = ['atencion', 'extraordinario', 'titulo', 'recursa']
    const actual = alertasFaltas(d, s.materia_id).find((a) => a.alumno_id === alumnoId)?.nivel
    const desde = actual ? orden.indexOf(actual) + 1 : 0
    const borrar = d.prepare('DELETE FROM avisos_faltas WHERE materia_id=? AND alumno_id=? AND nivel=?')
    for (const nivel of orden.slice(Math.max(0, desde))) borrar.run(s.materia_id, alumnoId, nivel)
  }
  // Tras pasar lista se revisa si alguien cambió de nivel por faltas (aviso del sistema, una vez por nivel)
  const revisarFaltasDeSesion = (sesionId: number): void => {
    const s = d.prepare('SELECT materia_id FROM sesiones WHERE id=?').get(sesionId) as { materia_id: number } | undefined
    if (s)
      setTimeout(() => {
        try {
          revisarFaltas(s.materia_id)
        } catch (e) {
          console.error('[faltas]', (e as Error).message)
        }
      }, 300)
  }

  // ---------- Carreras / periodos ----------
  h('carreras:listar', () => d.prepare('SELECT * FROM carreras ORDER BY nombre').all())
  h('carreras:guardar', (c: Row) => {
    if (c.id) d.prepare('UPDATE carreras SET nombre=?, clave=?, color=? WHERE id=?').run(c.nombre, c.clave, c.color, c.id)
    else return Number(d.prepare('INSERT INTO carreras (nombre, clave, color) VALUES (?,?,?)').run(c.nombre, c.clave ?? '', c.color ?? '#2d6df6').lastInsertRowid)
    return c.id
  })
  // Borra en cascada todas sus materias: con materias, pide la contraseña de borrado
  h('carreras:eliminar', (id: number, password?: string) => {
    const { n } = d.prepare('SELECT COUNT(*) AS n FROM materias WHERE carrera_id=?').get(id) as { n: number }
    if (n > 0) exigirPassword(password ?? '')
    return d.prepare('DELETE FROM carreras WHERE id=?').run(id).changes
  })
  h('periodos:listar', () => d.prepare('SELECT * FROM periodos ORDER BY fecha_inicio DESC').all())
  h('periodos:guardar', (p: Row) => {
    if (p.id) d.prepare('UPDATE periodos SET nombre=?, fecha_inicio=?, semanas=?, activo=? WHERE id=?').run(p.nombre, p.fecha_inicio, p.semanas, p.activo ? 1 : 0, p.id)
    else return Number(d.prepare('INSERT INTO periodos (nombre, fecha_inicio, semanas, activo) VALUES (?,?,?,?)').run(p.nombre, p.fecha_inicio, p.semanas ?? 15, 1).lastInsertRowid)
    return p.id
  })

  // ---------- Materias ----------
  h('materias:listar', () =>
    // carreras_alumnos: una materia compartida (p. ej. Álgebra para Industrial y Diseño Industrial) sale en cada carrera de sus alumnos
    d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA},
      (SELECT group_concat(DISTINCT a.carrera_id) FROM inscripciones i JOIN alumnos a ON a.id = i.alumno_id WHERE i.materia_id = m.id AND a.activo = 1 AND a.carrera_id IS NOT NULL) AS carreras_alumnos
      FROM materias m JOIN carreras c ON c.id = m.carrera_id ORDER BY m.oculta, c.nombre, m.nombre`).all()
  )
  h('materias:ocultar', (id: number, oculta: boolean) => {
    ocultarMateria(d, id, oculta)
    return true
  })
  h('materias:obtener', (id: number) => {
    const m = d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id=?`).get(id) as Materia
    if (!m) return null
    return {
      ...m,
      horarios: d.prepare('SELECT * FROM horarios WHERE materia_id=? ORDER BY dia, hora_inicio').all(id),
      alumnos: d.prepare('SELECT a.* FROM alumnos a JOIN inscripciones i ON i.alumno_id=a.id WHERE i.materia_id=? ORDER BY a.apellidos, a.nombre').all(id),
      materiales: ordenarMateriales(d.prepare('SELECT id, materia_id, titulo, tipo, ruta, unidad, creado, compartido, length(texto) AS texto_len FROM materiales WHERE materia_id=?').all(id) as MaterialLista[]),
      // Cronológico: primero lo que se aplica antes, y al final lo que aún no tiene fecha
      evaluaciones: d.prepare("SELECT * FROM evaluaciones WHERE materia_id=? ORDER BY CASE WHEN fecha_aplicacion IS NULL THEN 1 ELSE 0 END, fecha_aplicacion, id").all(id),
      glosario: d.prepare('SELECT * FROM glosario WHERE materia_id=? ORDER BY termino').all(id)
    }
  })
  h('materias:guardar', (m: Row) => {
    if (m.id) {
      d.prepare('UPDATE materias SET carrera_id=?, periodo_id=?, nombre=?, clave=?, cuatrimestre=?, color=?, descripcion=?, temario=?, presentacion_path=? WHERE id=?').run(
        m.carrera_id, m.periodo_id, m.nombre, m.clave ?? '', m.cuatrimestre ?? 1, m.color ?? '#2d6df6', m.descripcion ?? '', m.temario ?? '', m.presentacion_path ?? null, m.id
      )
      return m.id
    }
    return Number(
      d.prepare('INSERT INTO materias (carrera_id, periodo_id, nombre, clave, cuatrimestre, color, descripcion, temario, presentacion_path) VALUES (?,?,?,?,?,?,?,?,?)').run(
        m.carrera_id, m.periodo_id, m.nombre, m.clave ?? '', m.cuatrimestre ?? 1, m.color ?? '#2d6df6', m.descripcion ?? '', m.temario ?? '', m.presentacion_path ?? null
      ).lastInsertRowid
    )
  })
  h('materias:eliminar', (id: number, password: string) => {
    exigirPassword(password)
    const m = d.prepare('SELECT nombre FROM materias WHERE id=?').get(id) as { nombre: string } | undefined
    if (!m) throw new Error('La materia ya no existe.')
    const borradas = d.prepare('DELETE FROM materias WHERE id=?').run(id).changes
    console.log(`[borrado] materia "${m.nombre}" eliminada`)
    return borradas
  })
  h('materias:generarSesiones', (materiaId: number) => {
    const m = d.prepare('SELECT periodo_id FROM materias WHERE id=?').get(materiaId) as { periodo_id: number }
    return generarSesionesMateria(materiaId, m.periodo_id)
  })

  // ---------- Horarios ----------
  h('horarios:guardar', (hz: Row) => {
    if (hz.id) d.prepare('UPDATE horarios SET dia=?, hora_inicio=?, hora_fin=?, aula=? WHERE id=?').run(hz.dia, hz.hora_inicio, hz.hora_fin, hz.aula ?? '', hz.id)
    else return Number(d.prepare('INSERT INTO horarios (materia_id, dia, hora_inicio, hora_fin, aula) VALUES (?,?,?,?,?)').run(hz.materia_id, hz.dia, hz.hora_inicio, hz.hora_fin, hz.aula ?? '').lastInsertRowid)
    return hz.id
  })
  h('horarios:eliminar', (id: number) => d.prepare('DELETE FROM horarios WHERE id=?').run(id).changes)
  h('horarios:semana', () =>
    d.prepare('SELECT h.*, m.nombre AS materia_nombre, m.color AS materia_color, c.clave AS carrera_clave FROM horarios h JOIN materias m ON m.id=h.materia_id JOIN carreras c ON c.id=m.carrera_id WHERE m.oculta = 0 ORDER BY h.dia, h.hora_inicio').all()
  )

  // ---------- Alumnos ----------
  // Cada alumno trae las materias en que está inscrito (para filtrar la lista por materia)
  h('alumnos:listar', (carreraId?: number) => {
    const conMaterias = "SELECT a.*, (SELECT group_concat(i.materia_id) FROM inscripciones i WHERE i.alumno_id = a.id) AS materias_ids FROM alumnos a"
    const filas = (carreraId ? d.prepare(`${conMaterias} WHERE a.carrera_id=? ORDER BY a.apellidos, a.nombre`).all(carreraId) : d.prepare(`${conMaterias} ORDER BY a.apellidos, a.nombre`).all()) as (Row & { materias_ids: string | null })[]
    return filas.map(({ materias_ids, ...a }) => ({ ...a, materias: materias_ids ? materias_ids.split(',').map(Number) : [] }))
  })
  h('alumnos:guardar', (a: Row) => {
    const matricula = String(a.matricula ?? '').trim()
    const nombre = String(a.nombre ?? '').trim()
    if (!nombre) throw new Error('El nombre es obligatorio.')
    // La matrícula es opcional, pero si se captura no puede repetirse
    if (matricula) {
      const otro = d.prepare('SELECT id FROM alumnos WHERE matricula=? AND id<>?').get(matricula, a.id ?? 0)
      if (otro) throw new Error(`Ya hay otro alumno con la matrícula ${matricula}.`)
    }
    if (a.id) {
      d.prepare('UPDATE alumnos SET matricula=?, nombre=?, apellidos=?, email=?, carrera_id=?, activo=? WHERE id=?').run(matricula, nombre, a.apellidos ?? '', a.email ?? '', a.carrera_id ?? null, a.activo ?? 1, a.id)
      return a.id
    }
    return Number(d.prepare('INSERT INTO alumnos (matricula, nombre, apellidos, email, carrera_id) VALUES (?,?,?,?,?)').run(matricula, nombre, a.apellidos ?? '', a.email ?? '', a.carrera_id ?? null).lastInsertRowid)
  })
  h('alumnos:eliminar', (id: number, password: string) => {
    exigirPassword(password)
    return d.prepare('DELETE FROM alumnos WHERE id=?').run(id).changes
  })
  h('alumnos:inscribir', (materiaId: number, alumnoIds: number[]) => {
    const ins = d.prepare('INSERT OR IGNORE INTO inscripciones (materia_id, alumno_id) VALUES (?,?)')
    d.transaction(() => alumnoIds.forEach((id) => ins.run(materiaId, id)))()
    return alumnoIds.length
  })
  h('alumnos:cambiarCarrera', (alumnoIds: number[], carreraId: number) => {
    if (!d.prepare('SELECT 1 FROM carreras WHERE id=?').get(carreraId)) throw new Error('Esa carrera ya no existe.')
    const st = d.prepare('UPDATE alumnos SET carrera_id=? WHERE id=?')
    return d.transaction(() => alumnoIds.reduce((n, id) => n + st.run(carreraId, id).changes, 0))()
  })
  h('alumnos:desinscribir', (materiaId: number, alumnoId: number) => d.prepare('DELETE FROM inscripciones WHERE materia_id=? AND alumno_id=?').run(materiaId, alumnoId).changes)

  /** Importa alumnos desde Excel/CSV. Columnas reconocidas (sin importar mayúsculas): matricula, nombre, apellidos, email/correo. */
  h('alumnos:importarExcel', async (materiaId: number | null, carreraId: number | null) => {
    const r = await dialog.showOpenDialog({ title: 'Importar alumnos', filters: [{ name: 'Excel o CSV', extensions: ['xlsx', 'csv'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return { importados: 0, cancelado: true }
    const ruta = r.filePaths[0]
    const alumnos = interpretarLista(await leerFilas(ruta))
    if (!alumnos.length) return { importados: 0 }
    const ins = d.prepare('INSERT INTO alumnos (matricula, nombre, apellidos, email, carrera_id) VALUES (?,?,?,?,?)')
    const act = d.prepare("UPDATE alumnos SET nombre=?, apellidos=?, email=CASE WHEN ?<>'' THEN ? ELSE email END WHERE id=?")
    const insI = d.prepare('INSERT OR IGNORE INTO inscripciones (materia_id, alumno_id) VALUES (?,?)')
    const buscar = d.prepare('SELECT id FROM alumnos WHERE matricula=?')
    d.transaction(() => {
      for (const a of alumnos) {
        // Con matrícula se actualiza al alumno existente; sin matrícula siempre es un alumno nuevo
        const previo = a.matricula ? (buscar.get(a.matricula) as { id: number } | undefined) : undefined
        let id: number
        if (previo) {
          act.run(a.nombre, a.apellidos, a.email, a.email, previo.id)
          id = previo.id
        } else id = Number(ins.run(a.matricula, a.nombre, a.apellidos, a.email, carreraId).lastInsertRowid)
        if (materiaId) insI.run(materiaId, id)
      }
    })()
    return { importados: alumnos.length }
  })

  // ---------- Sesiones y actividades ----------
  const conActividades = (s: Sesion): Sesion => ({ ...s, actividades: d.prepare('SELECT * FROM actividades WHERE sesion_id=? ORDER BY orden').all(s.id) as Actividad[] })
  const selSesion = 'SELECT s.*, m.nombre AS materia_nombre, m.color AS materia_color FROM sesiones s JOIN materias m ON m.id=s.materia_id'
  h('sesiones:porMateria', (materiaId: number) => (d.prepare(`${selSesion} WHERE s.materia_id=? ORDER BY s.fecha, s.hora_inicio`).all(materiaId) as Sesion[]).map(conActividades))
  h('sesiones:porFecha', (fecha: string) => (d.prepare(`${selSesion} WHERE s.fecha=? AND m.oculta = 0 ORDER BY s.hora_inicio`).all(fecha) as Sesion[]).map(conActividades))
  h('sesiones:rango', (desde: string, hasta: string) => d.prepare(`${selSesion} WHERE s.fecha BETWEEN ? AND ? AND m.oculta = 0 ORDER BY s.fecha, s.hora_inicio`).all(desde, hasta))
  h('sesiones:obtener', (id: number) => {
    const s = d.prepare(`${selSesion} WHERE s.id=?`).get(id) as Sesion | undefined
    return s ? conActividades(s) : null
  })
  /** Evaluaciones de la materia con fecha de aplicación ese día (para moverlas junto con la sesión). */
  const evaluacionesDelDia = (materiaId: number, fecha: string): { id: number; titulo: string }[] =>
    d.prepare('SELECT id, titulo FROM evaluaciones WHERE materia_id = ? AND fecha_aplicacion = ? ORDER BY id').all(materiaId, fecha) as { id: number; titulo: string }[]
  h('evaluaciones:delDia', (materiaId: number, fecha: string) => evaluacionesDelDia(materiaId, fecha))
  /**
   * Cambia de día una evaluación y, si está publicada en el portal y aún no abre, corre su apertura y
   * cierre los mismos días. Lo que ya abrió no se toca (puede haber alumnos contestando).
   */
  const cambiosRemotos: { id: number; abre: string; cierra: string | null }[] = []
  const moverEvaluacion = (id: number, de: string, a: string): number => {
    d.prepare('UPDATE evaluaciones SET fecha_aplicacion = ? WHERE id = ?').run(a, id)
    const dias = Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 86_400_000)
    if (!dias || !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asignaciones'").get()) return 0
    // Mismo formato que guarda el portal: «YYYY-MM-DD HH:MM:SS» en UTC (sin zona = UTC)
    const leer = (f: string): number => Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(f.trim()) ? f.trim() : f.trim().replace(' ', 'T') + 'Z')
    const correr = (f: string | null): string | null => {
      if (!f || Number.isNaN(leer(f))) return f
      return new Date(leer(f) + dias * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    }
    const ahora = Date.now()
    let n = 0
    for (const x of d.prepare('SELECT id, abre, cierra FROM asignaciones WHERE evaluacion_id = ?').all(id) as { id: number; abre: string; cierra: string | null }[]) {
      if (leer(x.abre) <= ahora) continue
      n += d.prepare('UPDATE asignaciones SET abre = ?, cierra = ? WHERE id = ?').run(correr(x.abre), correr(x.cierra), x.id).changes
      if (configRemoto()) cambiosRemotos.push({ id: x.id, abre: correr(x.abre)!, cierra: correr(x.cierra) })
    }
    // En línea las publicaciones viven en el servidor: allá también se corren (si no, la siguiente sincronización lo regresaría)
    if (cambiosRemotos.length && configRemoto()) {
      const cambios = cambiosRemotos.splice(0)
      void accionRemota('asignaciones', { cambios }).catch((e) => console.error('[portal remoto] mover asignaciones', e))
    }
    return n
  }
  h('evaluaciones:moverFecha', (materiaId: number, de: string, a: string) =>
    d.transaction(() => {
      const evs = evaluacionesDelDia(materiaId, de)
      evs.forEach((e) => moverEvaluacion(e.id, de, a))
      return evs.length
    })()
  )
  /**
   * Intercambia el plan de dos sesiones de la misma materia (tema, objetivo, notas, presentación y
   * actividades); las fechas y horarios se quedan. Con `moverEvaluaciones`, los exámenes y tareas
   * programados en una fecha pasan a la otra. Así el docente mueve un examen de día sin rehacer nada.
   */
  h('sesiones:intercambiarPlan', (aId: number, bId: number, moverEvaluaciones = true) => {
    type S = { id: number; materia_id: number; fecha: string; tema: string; objetivo: string; notas: string; presentacion_path: string | null }
    const leer = (id: number): S => {
      const s = d.prepare('SELECT id, materia_id, fecha, tema, objetivo, notas, presentacion_path FROM sesiones WHERE id = ?').get(id) as S | undefined
      if (!s) throw new Error('La sesión ya no existe.')
      return s
    }
    const a = leer(aId)
    const b = leer(bId)
    if (a.materia_id !== b.materia_id) throw new Error('Solo se pueden intercambiar sesiones de la misma materia.')
    if (a.id === b.id) throw new Error('Elige otra sesión.')
    const actividades = (id: number): number[] => (d.prepare('SELECT id FROM actividades WHERE sesion_id = ?').all(id) as { id: number }[]).map((x) => x.id)
    const plan = d.prepare('UPDATE sesiones SET tema = ?, objetivo = ?, notas = ?, presentacion_path = ? WHERE id = ?')
    const reasignar = d.prepare('UPDATE actividades SET sesion_id = ? WHERE id = ?')
    return d.transaction(() => {
      const actsA = actividades(a.id)
      const actsB = actividades(b.id)
      plan.run(b.tema, b.objetivo, b.notas, b.presentacion_path, a.id)
      plan.run(a.tema, a.objetivo, a.notas, a.presentacion_path, b.id)
      actsA.forEach((id) => reasignar.run(b.id, id))
      actsB.forEach((id) => reasignar.run(a.id, id))
      let movidas = 0
      if (moverEvaluaciones && a.fecha !== b.fecha) {
        const evA = evaluacionesDelDia(a.materia_id, a.fecha)
        const evB = evaluacionesDelDia(b.materia_id, b.fecha)
        evA.forEach((e) => moverEvaluacion(e.id, a.fecha, b.fecha))
        evB.forEach((e) => moverEvaluacion(e.id, b.fecha, a.fecha))
        movidas = evA.length + evB.length
      }
      return { evaluaciones_movidas: movidas }
    })()
  })
  h('sesiones:guardar', (s: Row) => {
    const minutos = (h: unknown): number => String(h).split(':').map(Number).reduce((t, x, i) => t + (i === 0 ? x * 60 : x), 0)
    if (minutos(s.hora_fin) <= minutos(s.hora_inicio)) throw new Error('La hora de fin debe ser posterior a la de inicio.')
    if (s.id) {
      d.prepare('UPDATE sesiones SET semana=?, numero=?, fecha=?, hora_inicio=?, hora_fin=?, tema=?, objetivo=?, notas=?, estado=?, presentacion_path=? WHERE id=?').run(s.semana, s.numero, s.fecha, s.hora_inicio, s.hora_fin, s.tema ?? '', s.objetivo ?? '', s.notas ?? '', s.estado ?? 'planeada', s.presentacion_path ?? null, s.id)
      return s.id
    }
    // La sesión y sus actividades se crean juntas: si algo falla no queda una sesión sin plan
    return d.transaction(() => {
      const id = Number(d.prepare('INSERT INTO sesiones (materia_id, semana, numero, fecha, hora_inicio, hora_fin, tema, objetivo, notas) VALUES (?,?,?,?,?,?,?,?,?)').run(s.materia_id, s.semana ?? 1, s.numero ?? 1, s.fecha, s.hora_inicio, s.hora_fin, s.tema ?? '', s.objetivo ?? '', s.notas ?? '').lastInsertRowid)
      const ins = d.prepare('INSERT INTO actividades (sesion_id, orden, nombre, tipo, duracion_min) VALUES (?,?,?,?,?)')
      const [h1, m1] = String(s.hora_inicio).split(':').map(Number)
      const [h2, m2] = String(s.hora_fin).split(':').map(Number)
      const total = h2 * 60 + m2 - (h1 * 60 + m1)
      let acum = 0
      PLANTILLA_ACTIVIDADES.forEach((p, i) => {
        const ultima = i === PLANTILLA_ACTIVIDADES.length - 1
        const min = ultima ? total - acum : Math.max(1, Math.round(total * p.pct))
        acum += min
        ins.run(id, i + 1, p.nombre, p.tipo, min)
      })
      return id
    })()
  })
  h('sesiones:estado', (id: number, estado: string) => d.prepare('UPDATE sesiones SET estado=? WHERE id=?').run(estado, id).changes)
  /** Lo que se perdería al borrar la sesión: su asistencia se borra en cascada. */
  const impactoSesion = (id: number): { asistencias: number } => d.prepare('SELECT COUNT(*) AS asistencias FROM asistencias WHERE sesion_id=?').get(id) as { asistencias: number }
  h('sesiones:impacto', (id: number) => impactoSesion(id))
  h('sesiones:eliminar', (id: number, password?: string) => {
    if (impactoSesion(id).asistencias > 0) exigirPassword(password ?? '')
    return d.prepare('DELETE FROM sesiones WHERE id=?').run(id).changes
  })
  h('actividades:reemplazar', (sesionId: number, acts: Row[]) => {
    d.transaction(() => {
      d.prepare('DELETE FROM actividades WHERE sesion_id=?').run(sesionId)
      const ins = d.prepare('INSERT INTO actividades (sesion_id, orden, nombre, tipo, duracion_min, descripcion, recurso) VALUES (?,?,?,?,?,?,?)')
      acts.forEach((a, i) => ins.run(sesionId, i + 1, a.nombre, a.tipo ?? 'exposicion', a.duracion_min ?? 10, a.descripcion ?? '', a.recurso ?? ''))
    })()
    return acts.length
  })

  // ---------- Asistencia ----------
  h('asistencia:porSesion', (sesionId: number) => d.prepare('SELECT * FROM asistencias WHERE sesion_id=?').all(sesionId))
  h('asistencia:marcar', (sesionId: number, alumnoId: number, estado: string, nota = '') => {
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
    const antes = (d.prepare('SELECT estado FROM asistencias WHERE sesion_id=? AND alumno_id=?').get(sesionId, alumnoId) as { estado: string } | undefined)?.estado
    // Si el estado no cambia se conserva la hora de llegada original (solo se actualiza la nota)
    d.prepare(
      `INSERT INTO asistencias (sesion_id, alumno_id, estado, hora, nota) VALUES (?,?,?,?,?)
       ON CONFLICT(sesion_id, alumno_id) DO UPDATE SET hora=CASE WHEN asistencias.estado = excluded.estado THEN asistencias.hora ELSE excluded.hora END,
       estado=excluded.estado, nota=excluded.nota`
    ).run(sesionId, alumnoId, estado, hora, nota)
    // Corregir una falta (ausente → presente o retardo) baja sus horas: el aviso de ese nivel debe poder volver a sonar
    if (antes === 'ausente' && estado !== 'ausente') olvidarAvisosArriba(sesionId, alumnoId)
    revisarFaltasDeSesion(sesionId)
    return true
  })
  h('asistencia:marcarTodos', (sesionId: number, alumnoIds: number[], estado: string) => {
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
    // «Todos presentes/ausentes» solo marca a quien no tiene registro: nunca pisa un retardo o un justificado
    const st = d.prepare('INSERT INTO asistencias (sesion_id, alumno_id, estado, hora) VALUES (?,?,?,?) ON CONFLICT(sesion_id, alumno_id) DO NOTHING')
    d.transaction(() => alumnoIds.forEach((id) => st.run(sesionId, id, estado, hora)))()
    revisarFaltasDeSesion(sesionId)
    return alumnoIds.length
  })
  /**
   * Justificar una falta o un retardo: queda «justificado» (no cuenta como hora de falta ni en la asistencia
   * mínima del parcial) y el motivo se agrega a la nota. Si el alumno baja de escalón, se olvidan los avisos de
   * los escalones de arriba para que vuelvan a sonar si los alcanza de nuevo.
   */
  h('asistencia:justificar', (sesionId: number, alumnoId: number, motivo: string) => {
    const texto = String(motivo ?? '').trim()
    if (!texto) throw new Error('Escribe el motivo de la justificación.')
    const previo = d.prepare('SELECT estado, nota FROM asistencias WHERE sesion_id=? AND alumno_id=?').get(sesionId, alumnoId) as { estado: string; nota: string } | undefined
    if (!previo) throw new Error('No hay registro de asistencia de ese alumno en esa sesión.')
    if (previo.estado === 'justificado') return false
    const nota = previo.nota.trim() ? `${previo.nota.trim()} · ${texto}` : texto
    d.prepare("UPDATE asistencias SET estado='justificado', nota=? WHERE sesion_id=? AND alumno_id=?").run(nota, sesionId, alumnoId)
    olvidarAvisosArriba(sesionId, alumnoId)
    return true
  })
  /** Varias celdas de la cuadrícula de Asistencias de una vez (selección múltiple), en una sola transacción. */
  h('asistencia:marcarVarios', (celdas: { sesion_id: number; alumno_id: number }[], estado: string) => {
    if (!['presente', 'ausente', 'retardo', 'justificado'].includes(estado)) throw new Error('Estado de asistencia no válido.')
    const previo = d.prepare('SELECT estado, nota FROM asistencias WHERE sesion_id=? AND alumno_id=?')
    const poner = d.prepare(
      `INSERT INTO asistencias (sesion_id, alumno_id, estado, hora, nota) VALUES (?,?,?,?,?)
       ON CONFLICT(sesion_id, alumno_id) DO UPDATE SET estado=excluded.estado, nota=excluded.nota`
    )
    const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' })
    const olvidar: [number, number][] = []
    const n = d.transaction(() => {
      let cambios = 0
      for (const c of celdas.slice(0, 5000)) {
        const p = previo.get(c.sesion_id, c.alumno_id) as { estado: string; nota: string } | undefined
        if (p?.estado === estado) continue
        const nota = estado === 'justificado' ? [p?.nota?.trim(), 'Justificada desde Asistencias'].filter(Boolean).join(' · ') : p?.nota ?? ''
        cambios += poner.run(c.sesion_id, c.alumno_id, estado, hora, nota).changes
        // Una falta que deja de serlo baja las horas: el aviso de ese nivel debe poder volver a sonar
        if (p?.estado === 'ausente' || estado === 'justificado') olvidar.push([c.sesion_id, c.alumno_id])
      }
      return cambios
    })()
    for (const [s, a] of olvidar) olvidarAvisosArriba(s, a)
    for (const s of new Set(celdas.map((c) => c.sesion_id))) revisarFaltasDeSesion(s)
    return n
  })
  /** Quitar la justificación: vuelve a «ausente» (la nota se conserva como historial). */
  h('asistencia:quitarJustificacion', (sesionId: number, alumnoId: number) => {
    const r = d.prepare("UPDATE asistencias SET estado='ausente' WHERE sesion_id=? AND alumno_id=? AND estado='justificado'").run(sesionId, alumnoId).changes
    if (r) revisarFaltasDeSesion(sesionId)
    return r > 0
  })
  /**
   * Cuadrícula de asistencia de una materia (sección Asistencias): clases hasta hoy, cada registro,
   * los alumnos con sus horas de falta contra el comunicado y los parciales para filtrar.
   */
  h('asistencia:matriz', (materiaId: number) => {
    const hoy = hoyMx()
    const conc = concentradoMateria(d, materiaId)
    return {
      sesiones: d
        .prepare("SELECT id, numero, semana, fecha, hora_inicio, hora_fin, estado, tema FROM sesiones WHERE materia_id = ? AND fecha <= ? ORDER BY fecha, hora_inicio, id")
        .all(materiaId, hoy),
      registros: d.prepare('SELECT a.sesion_id, a.alumno_id, a.estado, a.nota FROM asistencias a JOIN sesiones s ON s.id = a.sesion_id WHERE s.materia_id = ?').all(materiaId),
      alumnos: conc.filas.map((f) => ({ ...f.alumno, horas_falta: f.horas_falta, riesgo: f.riesgo, porcentaje: f.porcentaje_asistencia })),
      limites: conc.limites,
      parciales: d.prepare('SELECT id, nombre, desde, hasta FROM calif_parciales WHERE materia_id = ? ORDER BY orden, id').all(materiaId)
    }
  })
  h('asistencia:resumenMateria', (materiaId: number) =>
    d.prepare(`SELECT a.alumno_id, a.estado, COUNT(*) AS n FROM asistencias a JOIN sesiones s ON s.id=a.sesion_id WHERE s.materia_id=? GROUP BY a.alumno_id, a.estado`).all(materiaId)
  )

  /**
   * Concentrado por alumno: horas de falta contra el límite del comunicado y
   * promedio ponderado de lo que ya está calificado.
   */
  h('calificaciones:materia', (materiaId: number) => concentradoMateria(d, materiaId))

  // ---------- Esquema de calificación, capturas, participaciones y proyección ----------
  h('calificaciones:esquema', (materiaId: number) => calificacionesEsquema(d, materiaId))
  /** Resumen serializable por alumno (acumulada, lo que falta, lo que necesita, asistencia, clasificación). */
  h('calificaciones:proyeccion', (materiaId: number) => proyeccionMateria(d, materiaId))
  h('ia:analizarProyeccion', async (materiaId: number) => {
    const r = proyeccionMateria(d, materiaId)
    if (!r) throw new Error('Esta materia aún no tiene esquema de calificación.')
    return analizarProyeccion(r)
  })
  h('esquema:porOmision', (materiaId: number) => esquemaPorOmision(d, materiaId))
  h('esquema:guardar', (e: Esquema) => guardarEsquema(d, e))
  h('esquema:capturasDe', (ids: number[]) => capturasDe(d, ids))
  // El alumno ve un parcial en «Mi avance» del portal solo cuando el docente lo publica
  h('calificaciones:ajustarFinal', (materiaId: number, alumnoId: number, calificacion: number | null, nota?: string) => ajustarFinal(d, materiaId, alumnoId, calificacion, nota ?? ''))
  h('calificaciones:ajustarParcial', (parcialId: number, alumnoId: number, calificacion: number | null, nota?: string) => ajustarParcial(d, parcialId, alumnoId, calificacion, nota ?? ''))
  h('esquema:publicarParcial', (parcialId: number, publicado: boolean) => d.prepare('UPDATE calif_parciales SET publicado=? WHERE id=?').run(publicado ? 1 : 0, parcialId).changes)
  h('capturas:guardar', (c: { componente_id: number; alumno_id: number; rubro?: number; valor?: number | null; entregado?: number | null; extra?: number | null }) => {
    guardarCaptura(d, c)
    return true
  })
  h('participaciones:porSesion', (sesionId: number) => d.prepare('SELECT alumno_id, COUNT(*) AS n FROM participaciones WHERE sesion_id=? GROUP BY alumno_id').all(sesionId))
  h('participaciones:agregar', (materiaId: number, alumnoId: number, sesionId: number | null, fecha: string, nota = '') => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Fecha inválida')
    return Number(d.prepare('INSERT INTO participaciones (materia_id, alumno_id, sesion_id, fecha, nota) VALUES (?,?,?,?,?)').run(materiaId, alumnoId, sesionId, fecha, nota).lastInsertRowid)
  })
  /** Quita la participación más reciente: la de esa sesión o, sin sesión, la última del rango. */
  h('participaciones:quitar', (materiaId: number, alumnoId: number, sesionId: number | null, desde?: string, hasta?: string) => {
    const fila = (sesionId
      ? d.prepare('SELECT id FROM participaciones WHERE materia_id=? AND alumno_id=? AND sesion_id=? ORDER BY id DESC LIMIT 1').get(materiaId, alumnoId, sesionId)
      : d.prepare('SELECT id FROM participaciones WHERE materia_id=? AND alumno_id=? AND fecha BETWEEN ? AND ? ORDER BY (sesion_id IS NOT NULL), fecha DESC, id DESC LIMIT 1').get(materiaId, alumnoId, desde ?? '0000-00-00', hasta ?? '9999-12-31')) as { id: number } | undefined
    return fila ? d.prepare('DELETE FROM participaciones WHERE id=?').run(fila.id).changes : 0
  })
  h('faltas:alertas', (materiaId?: number) => alertasFaltas(d, materiaId))

  // ---------- Recordatorios (fechas importantes) ----------
  const selRecordatorio = 'SELECT r.*, m.nombre AS materia_nombre, m.color AS materia_color FROM recordatorios r LEFT JOIN materias m ON m.id = r.materia_id'
  h('recordatorios:listar', () => d.prepare(`${selRecordatorio} ORDER BY r.fecha, r.hora`).all())
  h('recordatorios:guardar', (r: Row) => {
    const fecha = String(r.fecha ?? '')
    const fin = r.fecha_fin ? String(r.fecha_fin) : null
    const hora = r.hora ? String(r.hora) : null
    const titulo = String(r.titulo ?? '').trim()
    if (!titulo) throw new Error('Escribe un título.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('La fecha no es válida.')
    if (fin && (!/^\d{4}-\d{2}-\d{2}$/.test(fin) || fin < fecha)) throw new Error('La fecha de fin debe ser igual o posterior a la de inicio.')
    if (hora && !/^\d{2}:\d{2}$/.test(hora)) throw new Error('La hora no es válida.')
    const tipo = ['parcial', 'entrega', 'suspension', 'otro'].includes(String(r.tipo)) ? String(r.tipo) : 'otro'
    const avisar = Math.max(0, Math.min(60, Math.round(Number(r.avisar_dias ?? 1)) || 0))
    const vals = [fecha, fin, hora, titulo, tipo, r.materia_id ? Number(r.materia_id) : null, avisar, String(r.notas ?? '')]
    let id = Number(r.id ?? 0)
    // Al editarla se vuelve a poder avisar hoy (por si cambió la fecha o los días de aviso)
    if (id) d.prepare('UPDATE recordatorios SET fecha=?, fecha_fin=?, hora=?, titulo=?, tipo=?, materia_id=?, avisar_dias=?, notas=?, avisado_en=NULL WHERE id=?').run(...vals, id)
    else id = Number(d.prepare('INSERT INTO recordatorios (fecha, fecha_fin, hora, titulo, tipo, materia_id, avisar_dias, notas) VALUES (?,?,?,?,?,?,?,?)').run(...vals).lastInsertRowid)
    try {
      revisarRecordatorios()
    } catch (e) {
      console.error('[recordatorios]', (e as Error).message)
    }
    return id
  })
  h('recordatorios:eliminar', (id: number) => d.prepare('DELETE FROM recordatorios WHERE id=?').run(id).changes)
  /** Lo que viene entre dos fechas: recordatorios, evaluaciones programadas y cierres de entregas del portal. */
  h('fechas:proximas', (desde: string, hasta: string) => {
    const recordatorios = d.prepare(`${selRecordatorio} WHERE r.fecha <= ? AND COALESCE(r.fecha_fin, r.fecha) >= ? AND (m.id IS NULL OR m.oculta = 0) ORDER BY r.fecha, r.hora`).all(hasta, desde)
    const evaluaciones = d
      .prepare(
        `SELECT e.id, e.titulo, e.tipo, e.fecha_aplicacion AS fecha, e.materia_id, m.nombre AS materia_nombre, m.color AS materia_color FROM evaluaciones e JOIN materias m ON m.id = e.materia_id
         WHERE m.oculta = 0 AND e.fecha_aplicacion BETWEEN ? AND ? AND e.tipo NOT IN ('ejemplos','glosario','material_apoyo','plan_sesion','presentacion','clase_completa','apuntes') ORDER BY e.fecha_aplicacion`
      )
      .all(desde, hasta)
    const dia = (t: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(t.replace(' ', 'T') + (/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? '' : 'Z')))
    const portal = (d.prepare('SELECT a.id, a.titulo, a.cierra, a.materia_id, m.nombre AS materia_nombre, m.color AS materia_color FROM asignaciones a JOIN materias m ON m.id = a.materia_id WHERE a.activa = 1 AND a.cierra IS NOT NULL AND m.oculta = 0').all() as { cierra: string }[])
      .map((a) => ({ ...a, fecha: dia(a.cierra), hora: new Date(a.cierra.replace(' ', 'T') + (/Z$/.test(a.cierra) ? '' : 'Z')).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' }) }))
      .filter((a) => a.fecha >= desde && a.fecha <= hasta)
    return { recordatorios, evaluaciones, portal }
  })

  /** Todo lo de un alumno en una sola consulta: materias con su concentrado, asistencias, calificaciones, entregas del portal y acceso. */
  h('alumnos:detalle', (id: number) => {
    const alumno = d.prepare('SELECT a.*, c.nombre AS carrera_nombre FROM alumnos a LEFT JOIN carreras c ON c.id=a.carrera_id WHERE a.id=?').get(id) as (Alumno & { carrera_nombre: string | null }) | undefined
    if (!alumno) throw new Error('Alumno no encontrado')
    const materias = d.prepare('SELECT m.id, m.nombre, m.clave, m.color, m.oculta FROM materias m JOIN inscripciones i ON i.materia_id=m.id WHERE i.alumno_id=? ORDER BY m.oculta, m.nombre').all(id) as { id: number; nombre: string; clave: string; color: string; oculta: number }[]
    const porMateria = materias.map((m) => {
      const c = concentradoMateria(d, m.id)
      const fila = c.filas.find((f) => f.alumno.id === id)!
      return { materia: m, limites: c.limites, evaluaciones: c.evaluaciones.length, fila }
    })
    const asistencias = d
      .prepare('SELECT a.sesion_id, a.estado, a.hora, a.nota, s.fecha, s.hora_inicio, s.hora_fin, s.tema, s.materia_id, m.nombre AS materia_nombre, m.color AS materia_color FROM asistencias a JOIN sesiones s ON s.id=a.sesion_id JOIN materias m ON m.id=s.materia_id WHERE a.alumno_id=? ORDER BY s.fecha DESC, s.hora_inicio DESC LIMIT 80')
      .all(id)
    const resultados = d
      .prepare('SELECT r.*, e.titulo, e.tipo, e.puntos_totales, e.fecha_aplicacion, m.nombre AS materia_nombre FROM resultados r JOIN evaluaciones e ON e.id=r.evaluacion_id JOIN materias m ON m.id=e.materia_id WHERE r.alumno_id=? ORDER BY e.fecha_aplicacion DESC, e.id DESC')
      .all(id)
    const entregas = d
      .prepare(
        `SELECT i.id, i.estado, i.iniciado_en, i.enviado_en, i.tiempo_activo_seg, i.puntaje, i.puntaje_auto, i.pendiente_manual, a.titulo, a.id AS asignacion_id, e.puntos_totales, m.nombre AS materia_nombre,
                (SELECT COUNT(*) FROM eventos_integridad ev WHERE ev.intento_id=i.id) AS eventos
         FROM intentos i JOIN asignaciones a ON a.id=i.asignacion_id JOIN evaluaciones e ON e.id=a.evaluacion_id JOIN materias m ON m.id=a.materia_id
         WHERE i.alumno_id=? ORDER BY COALESCE(i.enviado_en, i.iniciado_en) DESC`
      )
      .all(id)
    const acceso = d.prepare("SELECT u.usuario, u.debe_cambiar, (SELECT MAX(s.creada) FROM sesiones_web s WHERE s.usuario_id=u.id) AS ultimo_acceso FROM usuarios u WHERE u.alumno_id=? AND u.rol='alumno'").get(id) ?? null
    // Sus tareas de Classroom (y lo que subió al portal), como en Alumnos × tareas: estado, calificación y entrega
    const tareas = materias.flatMap((m) => {
      try {
        const r = resumenMateria(d, m.id)
        const claves = new Set(r.alumnos.filter((x) => x.alumno_id === id).map((x) => x.clave))
        if (!claves.size) return []
        const tareaDe = new Map(r.consolidado.tareas.map((t) => [t.clave, t]))
        // r.entregas: lo que subió al portal se marca en cada entrega
        return r.consolidado.celdas
          .filter((c) => claves.has(c.alumno) && c.estado !== 'no_asignada')
          .map((c) => ({
            materia_id: m.id,
            materia_nombre: m.nombre,
            tarea: tareaDe.get(c.tarea_app)?.nombre ?? c.tarea_app,
            vence: tareaDe.get(c.tarea_app)?.referencia ?? null,
            estado: c.estado,
            calificacion: c.calificacion,
            borrador: c.borrador,
            puntos: c.puntos,
            entregada: c.entregada,
            veces: c.veces,
            de_portal: !!r.entregas.find((e) => e.entrega_id === c.cuenta?.entrega_id)?.portal,
            recuperacion: c.comodin
          }))
      } catch {
        // Materia sin Classroom ligado: no tiene tareas que mostrar
        return []
      }
    })
    return { alumno, materias: porMateria, asistencias, resultados, entregas, tareas, acceso }
  })
  h('alumnos:crearAcceso', (id: number) => accesoDeAlumno(Number(id)))
  h('alumnos:reiniciarPassword', (id: number) => reiniciarAccesoDeAlumno(Number(id)))

  // ---------- Materiales ----------
  h('materiales:agregar', async (materiaId: number, unidad = '') => {
    const r = await dialog.showOpenDialog({
      title: 'Agregar material',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documentos', extensions: ['pdf', 'docx', 'xlsx', 'csv', 'pptx', 'key', 'ggb', 'py', 'js', 'ts', 'java', 'c', 'cpp', 'cs', 'sql', 'html', 'md', 'txt', 'ipynb'] }, { name: 'Todos', extensions: ['*'] }]
    })
    if (r.canceled) return []
    const ids: number[] = []
    for (const origen of r.filePaths) {
      const nombre = `${Date.now()}-${basename(origen)}`
      const destino = join(materialesDir(), nombre)
      copyFileSync(origen, destino)
      const texto = await extraerTexto(destino)
      const id = Number(d.prepare('INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, texto) VALUES (?,?,?,?,?,?)').run(materiaId, basename(origen, extname(origen)), tipoPorExtension(origen), destino, unidad, texto).lastInsertRowid)
      ids.push(id)
      // Un PowerPoint se convierte a PDF en cuanto llega, para proyectarlo dentro de la app sin pasos extra
      if (necesitaConversion(destino)) {
        try {
          await convertirAPdf(destino)
        } catch (e) {
          console.error('[materiales] conversión automática', (e as Error).message)
        }
      }
    }
    return ids
  })
  h('materiales:agregarLink', (materiaId: number, titulo: string, url: string, unidad = '') => {
    const tipo = /geogebra\.org/.test(url) ? 'geogebra' : 'link'
    return Number(d.prepare('INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, texto) VALUES (?,?,?,?,?,?)').run(materiaId, titulo, tipo, url, unidad, '').lastInsertRowid)
  })
  h('materiales:texto', (id: number) => (d.prepare('SELECT texto FROM materiales WHERE id=?').get(id) as { texto: string } | undefined)?.texto ?? '')
  // Portal: materiales que ven los alumnos y si la materia muestra «Programar»
  h('materiales:compartir', (ids: number[], compartido: boolean) => {
    const st = d.prepare('UPDATE materiales SET compartido = ? WHERE id = ?')
    return d.transaction(() => (Array.isArray(ids) ? ids : []).reduce((n, id) => n + st.run(compartido ? 1 : 0, Number(id)).changes, 0))()
  })
  h('materias:portalProgramar', (id: number, activo: boolean) => d.prepare('UPDATE materias SET portal_programar = ? WHERE id = ?').run(activo ? 1 : 0, Number(id)).changes)
  h('materiales:eliminar', (id: number) => {
    const m = d.prepare('SELECT ruta FROM materiales WHERE id=?').get(id) as { ruta: string } | undefined
    const borrados = d.transaction(() => {
      if (m) {
        // Las sesiones y materias que lo usaban como presentación vuelven a la de la materia o a ninguna
        d.prepare('UPDATE sesiones SET presentacion_path=NULL WHERE presentacion_path=?').run(m.ruta)
        d.prepare('UPDATE materias SET presentacion_path=NULL WHERE presentacion_path=?').run(m.ruta)
      }
      return d.prepare('DELETE FROM materiales WHERE id=?').run(id).changes
    })()
    // Solo se borra del disco la copia que la app guardó en su carpeta, nunca un archivo del docente en otro lado
    const r = m && !/^https?:/i.test(m.ruta) ? relative(materialesDir(), m.ruta) : '..'
    if (m && !r.startsWith('..') && !isAbsolute(r)) {
      rmSync(m.ruta, { force: true })
      // El PDF que se generó para proyectar una presentación, salvo que sea a su vez otro material
      const pdf = rutaPdfDe(m.ruta)
      if (['.pptx', '.ppt', '.key'].includes(extname(m.ruta).toLowerCase()) && !d.prepare('SELECT 1 FROM materiales WHERE ruta=?').get(pdf)) rmSync(pdf, { force: true })
    }
    return borrados
  })
  h('materiales:abrir', (ruta: string) => abrirArchivo(ruta))
  // Visor dentro de la app (Abrir): PDF, imágenes, Word, Excel, presentaciones convertidas, código y texto
  h('materiales:vista', (id: number) => {
    const m = d.prepare('SELECT ruta FROM materiales WHERE id=?').get(Number(id)) as { ruta: string } | undefined
    if (!m) throw new Error('El material ya no existe.')
    return vistaMaterial(m.ruta)
  })
  h('materiales:establecerPresentacion', (materiaId: number, materialId: number | null) => {
    const ruta = materialId ? (d.prepare('SELECT ruta FROM materiales WHERE id=?').get(materialId) as { ruta: string }).ruta : null
    d.prepare('UPDATE materias SET presentacion_path=? WHERE id=?').run(ruta, materiaId)
    return ruta
  })

  // ---------- Presentaciones proyectables ----------
  /** Devuelve el PDF que se puede mostrar dentro de la app, o dice que hay que convertir. */
  h('presentacion:estado', (ruta: string | null) => ({
    pdf: pdfProyectable(ruta),
    convertible: necesitaConversion(ruta)
  }))
  h('presentacion:convertir', (ruta: string) => convertirAPdf(ruta))
  /** Convierte todas las presentaciones pendientes de una materia (las suyas y las de sus sesiones). */
  h('presentacion:prepararMateria', async (materiaId: number) => {
    const rutas = new Set<string>()
    const m = d.prepare('SELECT presentacion_path FROM materias WHERE id=?').get(materiaId) as { presentacion_path: string | null }
    if (m?.presentacion_path) rutas.add(m.presentacion_path)
    for (const s of d.prepare('SELECT presentacion_path FROM sesiones WHERE materia_id=? AND presentacion_path IS NOT NULL').all(materiaId) as { presentacion_path: string }[]) rutas.add(s.presentacion_path)
    for (const x of d.prepare("SELECT ruta FROM materiales WHERE materia_id=? AND tipo='pptx'").all(materiaId) as { ruta: string }[]) rutas.add(x.ruta)
    const pendientes = [...rutas].filter(necesitaConversion)
    const errores: string[] = []
    let convertidas = 0
    for (const r of pendientes) {
      try {
        await convertirAPdf(r)
        convertidas++
      } catch (e) {
        errores.push(`${r.split('/').pop()}: ${(e as Error).message}`)
      }
    }
    return { total: pendientes.length, convertidas, errores }
  })

  // ---------- Evaluaciones / resultados ----------
  h('evaluaciones:obtener', (id: number) => d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(id))
  h('evaluaciones:guardar', (e: Row) => {
    if (e.id) {
      d.prepare('UPDATE evaluaciones SET titulo=?, contenido=?, fecha_aplicacion=?, puntos_totales=? WHERE id=?').run(e.titulo, e.contenido, e.fecha_aplicacion ?? null, e.puntos_totales ?? 0, e.id)
      return e.id
    }
    return Number(d.prepare('INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, fecha_aplicacion, puntos_totales) VALUES (?,?,?,?,?,?)').run(e.materia_id, e.tipo, e.titulo, e.contenido ?? '', e.fecha_aplicacion ?? null, e.puntos_totales ?? 0).lastInsertRowid)
  })
  /**
   * Examen a partir de un cuaderno de Jupyter de los materiales: una sola pregunta «cuaderno» con el .ipynb
   * copiado dentro (así el examen no cambia si después se edita o se borra el material). Se publica como
   * cualquier examen: con duración, vigilancia y entrega automática.
   */
  h('evaluaciones:desdeCuaderno', (materialId: number) => {
    const m = d.prepare('SELECT materia_id, titulo, ruta FROM materiales WHERE id=?').get(materialId) as { materia_id: number; titulo: string; ruta: string } | undefined
    if (!m || extname(m.ruta).toLowerCase() !== '.ipynb') throw new Error('Ese material no es un cuaderno de Jupyter (.ipynb).')
    m.ruta = rutaMaterial(m.ruta)
    if (!existsSync(m.ruta)) throw new Error('No se encontró el archivo del cuaderno en esta computadora.')
    let nb: { cells?: { cell_type?: string; source?: string | string[] }[]; nbformat?: number }
    try {
      nb = JSON.parse(readFileSync(m.ruta, 'utf8'))
    } catch {
      throw new Error('El archivo no es un cuaderno .ipynb válido.')
    }
    if (!Array.isArray(nb.cells) || Number(nb.nbformat) < 4) throw new Error('El cuaderno necesita el formato 4 de Jupyter (ábrelo y guárdalo con Jupyter o Colab).')
    const codigo = nb.cells.filter((c) => c.cell_type === 'code').map((c) => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? ''))).join('\n')
    // Si el cuaderno usa numpy, pandas, matplotlib… se dejan cargar; si no, solo Python puro como en las preguntas de código
    const paquetes = /^\s*(?:import|from)\s+(?:numpy|pandas|matplotlib|scipy|sympy|sklearn|seaborn|networkx|statsmodels)\b/m.test(codigo)
    const titulo = m.titulo.replace(/\.ipynb$/i, '')
    const contenido = {
      titulo,
      instrucciones: 'Resuelve el cuaderno: contesta en las celdas de texto y escribe y corre el código que se pide. Todo se guarda solo y se envía al terminar el tiempo.',
      duracion_min: 60,
      preguntas: [{ tipo: 'cuaderno', enunciado: `Resuelve el cuaderno **${titulo}**.`, respuesta: '', puntos: 100, explicacion: '', cuaderno: JSON.stringify(nb), paquetes }]
    }
    return Number(
      d.prepare("INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, fecha_aplicacion, puntos_totales) VALUES (?, 'examen', ?, ?, NULL, 100)").run(m.materia_id, `Examen: ${titulo}`, JSON.stringify(contenido)).lastInsertRowid
    )
  })
  /** Lo que se perdería al borrar la evaluación: calificaciones, publicaciones en el portal y sus entregas. */
  const impactoEvaluacion = (id: number): { calificaciones: number; publicaciones: number; entregas: number } =>
    d
      .prepare(
        `SELECT (SELECT COUNT(*) FROM resultados WHERE evaluacion_id = @id) AS calificaciones,
                (SELECT COUNT(*) FROM asignaciones WHERE evaluacion_id = @id) AS publicaciones,
                (SELECT COUNT(*) FROM intentos i JOIN asignaciones a ON a.id = i.asignacion_id WHERE a.evaluacion_id = @id) AS entregas`
      )
      .get({ id }) as { calificaciones: number; publicaciones: number; entregas: number }
  h('evaluaciones:impacto', (id: number) => impactoEvaluacion(id))
  h('evaluaciones:eliminar', (id: number, password?: string) => {
    const i = impactoEvaluacion(id)
    if (i.calificaciones + i.publicaciones + i.entregas > 0) exigirPassword(password ?? '')
    return d.prepare('DELETE FROM evaluaciones WHERE id=?').run(id).changes
  })
  h('resultados:porEvaluacion', (evId: number) => d.prepare('SELECT * FROM resultados WHERE evaluacion_id=?').all(evId))
  h('resultados:guardar', (r: Row) => {
    d.prepare('INSERT INTO resultados (evaluacion_id, alumno_id, puntaje, estado, fecha_entrega, comentario) VALUES (?,?,?,?,?,?) ON CONFLICT(evaluacion_id, alumno_id) DO UPDATE SET puntaje=excluded.puntaje, estado=excluded.estado, fecha_entrega=excluded.fecha_entrega, comentario=excluded.comentario').run(
      r.evaluacion_id, r.alumno_id, r.puntaje ?? null, r.estado ?? 'pendiente', r.fecha_entrega ?? null, r.comentario ?? ''
    )
    return true
  })

  // ---------- Programar (editor de código) ----------
  h('programas:listar', () =>
    d.prepare('SELECT p.*, m.nombre AS materia_nombre FROM programas p LEFT JOIN materias m ON m.id = p.materia_id ORDER BY p.actualizado DESC, p.id DESC').all()
  )
  h('programas:guardar', (p: Row) => {
    const lenguaje = p.lenguaje === 'javascript' ? 'javascript' : 'python'
    const nombre = String(p.nombre ?? '').trim() || 'Sin nombre'
    const materia = p.materia_id ? Number(p.materia_id) : null
    if (p.id) {
      d.prepare("UPDATE programas SET nombre=?, lenguaje=?, codigo=?, entrada=?, materia_id=?, actualizado=datetime('now') WHERE id=?")
        .run(nombre, lenguaje, String(p.codigo ?? ''), String(p.entrada ?? ''), materia, p.id)
      return Number(p.id)
    }
    return Number(d.prepare('INSERT INTO programas (nombre, lenguaje, codigo, entrada, materia_id) VALUES (?,?,?,?,?)').run(nombre, lenguaje, String(p.codigo ?? ''), String(p.entrada ?? ''), materia).lastInsertRowid)
  })
  h('programas:eliminar', (id: number) => d.prepare('DELETE FROM programas WHERE id=?').run(id).changes)
  h('pyodide:paquetes', () => estadoPaquetes())
  h('pyodide:descargar', (nombre: string) => descargarPaquete(String(nombre).trim().toLowerCase()))
  h('pyodide:borrar', () => borrarPaquetes())
  h('pyodide:cancelar', () => cancelarDescarga())

  // ---------- Glosario ----------
  h('glosario:guardar', (g: Row) => {
    if (g.id) d.prepare('UPDATE glosario SET termino=?, definicion=?, ejemplo=? WHERE id=?').run(g.termino, g.definicion ?? '', g.ejemplo ?? '', g.id)
    else return Number(d.prepare('INSERT INTO glosario (materia_id, termino, definicion, ejemplo) VALUES (?,?,?,?)').run(g.materia_id, g.termino, g.definicion ?? '', g.ejemplo ?? '').lastInsertRowid)
    return g.id
  })
  h('glosario:eliminar', (id: number) => d.prepare('DELETE FROM glosario WHERE id=?').run(id).changes)

  // ---------- IA ----------
  h('ia:disponible', () => process.env.DOCENTE_IA_FALSA === '1' || hayApiKey())
  h('ia:guardarApiKey', (k: string, prov?: 'anthropic' | 'nvidia') => {
    guardarApiKey(k.trim(), prov)
    return hayApiKey()
  })
  h('ia:modelosNvidia', () => listarModelos())
  h('ia:probar', () => probarConexion())
  h('ia:gasto', (dias?: number) => gastoIA(Number(dias) || 30))
  h('ia:generar', async (req: GeneracionIA) => {
    const r = await generar(req)
    const ins = d.prepare('INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (?,?,?,?,?)')
    // Una clase completa se guarda junto con su cuestionario (para jugarlo en vivo)
    const id = d.transaction(() => {
      const principal = Number(ins.run(req.materia_id, req.tipo, r.titulo, r.contenido, r.puntos).lastInsertRowid)
      for (const a of r.adicionales ?? []) ins.run(req.materia_id, a.tipo, a.titulo, a.contenido, a.puntos)
      return principal
    })()
    return d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(id) as Evaluacion
  })
  // Juego en vivo de una evaluación que no se puede jugar tal cual: se guarda como cuestionario en la misma materia
  h('ia:generarJuego', async (evaluacionId: number, cantidad?: number) => {
    const r = await generarJuego(evaluacionId, cantidad)
    const id = Number(d.prepare('INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (?,?,?,?,?)').run(r.materia_id, 'cuestionario', r.titulo, r.contenido, r.puntos).lastInsertRowid)
    return d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(id) as Evaluacion
  })
  h('ia:preguntar', (materiaId: number, pregunta: string) => preguntar(materiaId, pregunta))
  // Convertir un material (PDF, Word, PowerPoint…) en examen: pasa sus preguntas o genera unas de su contenido
  h('evaluaciones:desdeArchivo', async (materialId: number, op: OpcionesExamenArchivo) => {
    const m = d.prepare('SELECT id, materia_id, titulo, ruta, texto FROM materiales WHERE id=?').get(Number(materialId)) as { id: number; materia_id: number; titulo: string; ruta: string; texto: string } | undefined
    if (!m) throw new Error('El material ya no existe.')
    if (/^https?:/i.test(m.ruta)) throw new Error('Es un enlace, no un archivo: no hay texto que convertir.')
    const modo = op?.modo === 'extraer' || op?.modo === 'generar' ? op.modo : 'auto'
    // El texto ya se extrajo al subirlo; si quedó vacío se intenta de nuevo
    const texto = m.texto?.trim() ? m.texto : await extraerTexto(m.ruta)
    const materia = d.prepare('SELECT nombre FROM materias WHERE id=?').get(m.materia_id) as { nombre: string }
    const r = await examenDesdeArchivo(texto, m.titulo, materia.nombre, { ...op, modo, todas: op?.todas !== false })
    const id = Number(d.prepare('INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (?,?,?,?,?)').run(m.materia_id, 'examen', r.titulo, r.contenido, r.puntos).lastInsertRowid)
    return d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(id) as Evaluacion
  })

  // ---------- Asistente tipo chat ----------
  h('asistente:listar', () => A.listarConversaciones())
  h('asistente:mensajes', (id: number) => A.mensajesDe(id))
  h('asistente:crear', (materiaId: number | null) => A.crearConversacion(materiaId ?? null))
  h('asistente:dePrograma', (programaId: number) => A.conversacionDePrograma(programaId))
  h('asistente:actualizar', (id: number, c: { titulo?: string; materia_id?: number | null }) => A.actualizarConversacion(id, c))
  h('asistente:borrar', (id: number) => A.borrarConversacion(id))
  h('asistente:enviar', (id: number, texto: string, opciones?: Parameters<typeof A.enviarMensaje>[2]) => A.enviarMensaje(id, String(texto ?? ''), opciones ?? {}))
  h('asistente:detener', (id: number) => A.detenerRespuesta(id))
  h('asistente:enCurso', () => A.respuestasEnCurso())

  // ---------- Respaldos (Ajustes) ----------
  h('respaldos:listar', () => ({ respaldos: R.listarRespaldos(), carpeta_externa: R.carpetaExterna(), ultimo_externo: getAjuste('respaldo_externo_ultimo', ''), error_externo: getAjuste('respaldo_externo_error', '') }))
  h('respaldos:crear', () => R.respaldarAhora())
  h('respaldos:elegirCarpeta', () => R.elegirCarpetaExterna())
  h('respaldos:quitarCarpeta', () => R.quitarCarpetaExterna())
  h('respaldos:restaurar', (nombre: string) => R.restaurarRespaldo(String(nombre)))
  h('asistente:guardarEnMateria', (materiaId: number, titulo: string, contenido: string) => A.guardarEnMateria(materiaId, titulo, contenido))
  h('ia:aplicarPlan', (sesionId: number, evaluacionId: number) => {
    const ev = d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(evaluacionId) as Evaluacion
    const plan = JSON.parse(ev.contenido) as { tema: string; objetivo: string; actividades: Row[] }
    d.transaction(() => {
      d.prepare('UPDATE sesiones SET tema=?, objetivo=? WHERE id=?').run(plan.tema, plan.objetivo, sesionId)
      d.prepare('DELETE FROM actividades WHERE sesion_id=?').run(sesionId)
      const ins = d.prepare('INSERT INTO actividades (sesion_id, orden, nombre, tipo, duracion_min, descripcion) VALUES (?,?,?,?,?,?)')
      plan.actividades.forEach((a, i) => ins.run(sesionId, i + 1, a.nombre, a.tipo, a.duracion_min, a.descripcion ?? ''))
    })()
    return true
  })

  // ---------- Exportar ----------
  h('exportar:materiaXlsx', async (materiaId: number, alumnoId?: number) => {
    const m = d.prepare('SELECT nombre FROM materias WHERE id=?').get(materiaId) as { nombre: string }
    const r = await dialog.showSaveDialog({ title: 'Exportar a Excel', defaultPath: `${m.nombre.replace(/[^\w\sáéíóúñ-]/gi, '')} - registro.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    await exportarMateriaXlsx(materiaId, r.filePath, alumnoId)
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  h('exportar:todoXlsx', async (materiaId: number) => {
    const m = d.prepare('SELECT nombre FROM materias WHERE id=?').get(materiaId) as { nombre: string }
    const r = await dialog.showSaveDialog({ title: 'Exportar todo a Excel', defaultPath: `${m.nombre.replace(/[^\w\sáéíóúñ-]/gi, '')} - calificaciones ${hoyMx()}.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    await exportarTodoXlsx(materiaId, r.filePath, getAjuste('nombre_docente'))
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  h('exportar:alumnosXlsx', async (materiaId: number) => {
    const m = d.prepare('SELECT nombre FROM materias WHERE id=?').get(materiaId) as { nombre: string }
    const r = await dialog.showSaveDialog({ title: 'Exportar lista de alumnos', defaultPath: `${m.nombre.replace(/[^\w\sáéíóúñ-]/gi, '')} - alumnos.xlsx`, filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (r.canceled || !r.filePath) return null
    await exportarAlumnosXlsx(materiaId, r.filePath)
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  h('exportar:reporteAlumnoPdf', async (materiaId: number, alumnoId: number) => {
    const a = d.prepare('SELECT matricula, apellidos, nombre FROM alumnos WHERE id=?').get(alumnoId) as Alumno
    const r = await dialog.showSaveDialog({ title: 'Reporte del alumno (PDF)', defaultPath: `Reporte ${a.matricula} ${a.apellidos} ${a.nombre}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    if (r.canceled || !r.filePath) return null
    await htmlAPdf(reporteAlumnoHtml(materiaId, alumnoId, getAjuste('nombre_docente')), r.filePath)
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })
  h('exportar:evaluacion', async (evId: number, formato: 'pdf' | 'docx', conRespuestas: boolean) => {
    const ev = d.prepare('SELECT * FROM evaluaciones WHERE id=?').get(evId) as Evaluacion
    const materia = d.prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id=m.carrera_id WHERE m.id=?`).get(ev.materia_id) as Materia
    const sufijo = conRespuestas ? ' - CLAVE' : ''
    const r = await dialog.showSaveDialog({ title: 'Exportar', defaultPath: `${ev.titulo.replace(/[^\w\sáéíóúñ-]/gi, '')}${sufijo}.${formato}`, filters: [{ name: formato.toUpperCase(), extensions: [formato] }] })
    if (r.canceled || !r.filePath) return null
    const esJson = ev.contenido.trim().startsWith('{')
    if (formato === 'pdf') {
      const html = esJson ? evaluacionAHtml(ev, materia, conRespuestas, getAjuste('nombre_docente')) : markdownAHtml(ev.titulo, ev.contenido)
      await htmlAPdf(html, r.filePath)
    } else if (esJson) await evaluacionADocx(ev, materia, conRespuestas, r.filePath)
    else await markdownADocxSimple(ev.titulo, ev.contenido, r.filePath)
    shell.showItemInFolder(r.filePath)
    return r.filePath
  })

  // ---------- Seguridad ----------
  h('seguridad:estado', () => ({ configurada: passwordConfigurada() }))
  h('seguridad:establecer', (nueva: string, actual?: string) => {
    establecerPassword(nueva, actual)
    return true
  })
  h('seguridad:quitar', (actual: string) => {
    quitarPassword(actual)
    return true
  })

  // ---------- Portal de alumnos ----------
  h('portal:estado', () => estadoPortal())
  h('portal:iniciar', () => iniciarPortal())
  h('portal:detener', () => detenerPortal())
  h('portal:docente', (nombre: string, usuario: string, password: string) => configurarDocente(nombre, usuario, password))
  h('portal:ajustes', (a: { puerto?: number; url_publica?: string; auto_iniciar?: boolean; avance_alumnos?: boolean }) => guardarAjustesPortal(a))
  h('portal:qr', async () => {
    const url = urlParaAlumnos()
    return { url, qr: url ? await qrDe(url) : '' }
  })
  // Dentro de la app (su ventana del panel); `enVentana` = otra ventana aparte (juego en vivo); `navegador` = el del sistema
  h('portal:urlPanel', (ruta?: string) => urlPanelIncrustado(ruta))
  h('portal:abrirPanel', (ruta?: string, enVentana?: boolean | 'navegador') => abrirPanelDocente(ruta, enVentana === 'navegador' ? 'navegador' : enVentana ? 'nueva' : 'panel'))
  h('portal:accesos', (materiaId: number) => accesosDeMateria(Number(materiaId)))
  h('portal:sincronizar', (forzar?: boolean) => sincronizarAhora(Boolean(forzar)))
  h('portal:aviso', (materiaId: number, titulo: string, cuerpo: string, carreraId?: number | null) => avisoAlGrupo(Number(materiaId), String(titulo ?? ''), String(cuerpo ?? ''), carreraId ? Number(carreraId) : null))
  h('portal:jugar', (evaluacionId: number, segundos?: number) => jugarEnVivo(evaluacionId, segundos))
  h('portal:notificaciones', (soloNoLeidas?: boolean) => notificacionesDocente(soloNoLeidas))
  h('portal:leidas', (ids?: number[]) => marcarNotificacionesLeidas(ids))

  // ---------- Ajustes / sistema ----------
  h('ajustes:leer', () => ({
    tolerancia_retardo_min: Number(getAjuste('tolerancia_retardo_min', '10')),
    avanzar_auto: getAjuste('avanzar_auto', '1') === '1',
    sonido: getAjuste('sonido', '1') === '1',
    modelo_ia: modeloClaude(),
    workspace_anthropic: getAjuste('workspace_anthropic', ''),
    nombre_docente: getAjuste('nombre_docente', ''),
    proveedor_ia: proveedor(),
    modelo_nvidia: getAjuste('modelo_nvidia', MODELO_POR_DEFECTO),
    modelo_ia_rapido: ajusteModeloRapido(),
    api_key_configurada: hayApiKey('anthropic'),
    api_key_nvidia_configurada: hayApiKey('nvidia'),
    password_configurada: passwordConfigurada(),
    conversor: conversorDisponible(),
    ruta_datos: app.getPath('userData')
  }))
  // Orden de las materias que el docente acomoda arrastrando (Materias › «Mi orden»). Solo vive en esta app
  h('materias:ordenLeer', (): number[] => {
    try {
      const l = JSON.parse(getAjuste('orden_materias', '[]')) as unknown
      return Array.isArray(l) ? l.map(Number).filter(Number.isFinite) : []
    } catch {
      return []
    }
  })
  // Orden de las carreras en Materias (mismo trato que el de las materias)
  h('carreras:ordenLeer', (): number[] => {
    try {
      const l = JSON.parse(getAjuste('orden_carreras', '[]')) as unknown
      return Array.isArray(l) ? l.map(Number).filter(Number.isFinite) : []
    } catch {
      return []
    }
  })
  h('carreras:ordenGuardar', (ids: unknown) => {
    if (!Array.isArray(ids)) throw new Error('El orden debe ser una lista de carreras.')
    const existen = new Set((d.prepare('SELECT id FROM carreras').all() as { id: number }[]).map((c) => c.id))
    const limpio = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && existen.has(id))
    setAjuste('orden_carreras', JSON.stringify(limpio))
    return limpio.length
  })
  h('materias:ordenGuardar', (ids: unknown) => {
    // Solo ids de materias que existen, sin repetir: una lista rara de la ventana no ensucia el ajuste
    if (!Array.isArray(ids)) throw new Error('El orden debe ser una lista de materias.')
    const existen = new Set((d.prepare('SELECT id FROM materias').all() as { id: number }[]).map((m) => m.id))
    const limpio = [...new Set(ids.map(Number))].filter((id) => Number.isInteger(id) && existen.has(id))
    setAjuste('orden_materias', JSON.stringify(limpio))
    return limpio.length
  })
  h('ajustes:guardar', (a: Row) => {
    setAjuste('tolerancia_retardo_min', String(a.tolerancia_retardo_min ?? 10))
    setAjuste('avanzar_auto', a.avanzar_auto ? '1' : '0')
    setAjuste('sonido', a.sonido ? '1' : '0')
    setAjuste('modelo_ia', String(a.modelo_ia || MODELO_CLAUDE_POR_DEFECTO))
    setAjuste('workspace_anthropic', String(a.workspace_anthropic ?? '').trim())
    setAjuste('proveedor_ia', a.proveedor_ia === 'nvidia' ? 'nvidia' : 'anthropic')
    setAjuste('modelo_nvidia', String(a.modelo_nvidia || MODELO_POR_DEFECTO))
    setAjuste('modelo_ia_rapido', String(a.modelo_ia_rapido || MODELO_RAPIDO_POR_DEFECTO))
    setAjuste('nombre_docente', String(a.nombre_docente ?? ''))
    return true
  })
  h('sistema:abrirRuta', (ruta: string) => abrirArchivo(ruta))
  h('sistema:pantallaCompleta', (on: boolean) => BrowserWindow.getFocusedWindow()?.setFullScreen(on))
  h('actualizacion:revisar', () => revisarActualizacion())
  h('actualizacion:instalar', () => instalarActualizacion())
  // Antes de actualizar: alumnos con una actividad abierta en el portal (la actualización lo apaga unos segundos)
  h('portal:contestando', () => {
    // En línea el portal no depende de esta app: actualizarla no corta a nadie
    if (configRemoto() || !d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intentos'").get()) return { alumnos: 0, partidas: 0 }
    const alumnos = (d.prepare("SELECT COUNT(DISTINCT alumno_id) AS n FROM intentos WHERE estado = 'en_curso' AND ultima_actividad > datetime('now', '-15 minutes')").get() as { n: number }).n
    const partidas = (d.prepare("SELECT COUNT(*) AS n FROM partidas WHERE estado IN ('pregunta', 'resultado') AND creada > datetime('now', '-3 hours')").get() as { n: number }).n
    return { alumnos, partidas }
  })
}

