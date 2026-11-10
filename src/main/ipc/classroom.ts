import * as C from '../services/classroom'
import { classroomACalificaciones } from '../services/classroom-calificaciones'
import { join, isAbsolute } from 'path'
import { existsSync } from 'fs'
import { getDb, dataDir } from '../db'
import { abrirArchivo } from '../abrir'
import { revisarEntregasConIA } from '../services/ia'
import { guardarAjusteTarea } from '../../servidor/tareas'
import type { PortalTarea } from '../../shared/portal'

type Registrar = (canal: string, fn: (...args: any[]) => unknown) => void

/** Canales de Google Classroom (solo lectura). Se registran con el mismo `h` que el resto. */
export function registrarClassroom(h: Registrar): void {
  C.prepararCache()
  h('classroom:estado', () => C.estado())
  h('classroom:guardarCredenciales', (clientId: string, clientSecret: string) => C.guardarCredenciales(String(clientId ?? ''), String(clientSecret ?? '')))
  h('classroom:conectar', () => C.conectar())
  h('classroom:desconectar', () => C.desconectar())
  h('classroom:sincronizar', () => C.sincronizar())
  h('classroom:aCalificaciones', (materiaId: number, parcialOrden: number) => classroomACalificaciones(getDb(), Number(materiaId), Number(parcialOrden)))
  h('classroom:cursos', () => C.cursos())
  h('classroom:ligarCurso', (cursoId: string, materiaId: number | null) => C.ligarCurso(String(cursoId), materiaId ? Number(materiaId) : null))
  h('classroom:ligarAlumno', (cursoId: string, userId: string, destino: number | 'ajeno' | null) =>
    C.ligarAlumno(String(cursoId), String(userId), destino === 'ajeno' ? 'ajeno' : destino ? Number(destino) : null))
  // Resumen por materia (alumnos × tareas): también lo usarán el esquema de calificación y los avisos de no entrega
  h('classroom:resumen', (materiaId: number) => C.resumen(Number(materiaId)))
  h('classroom:entrega', (cursoId: string, entregaId: string) => C.entrega(String(cursoId), String(entregaId)))
  h('classroom:calificarEnApp', (cursoId: string, entregaId: string, calificacion: number | null) =>
    C.calificarEnApp(String(cursoId), String(entregaId), calificacion === null || calificacion === undefined ? null : Number(calificacion)))
  h('classroom:marcarEntregaFuera', (cursoId: string, entregaId: string, recibida: boolean) => C.marcarEntregaFuera(String(cursoId), String(entregaId), !!recibida))
  h('classroom:previsualizar', (cursoId: string, entregaId: string, archivoId: string) => C.previsualizar(String(cursoId), String(entregaId), String(archivoId)))
  h('classroom:previsualizarMaterial', (cursoId: string, tareaId: string, archivoId: string) => C.previsualizarMaterial(String(cursoId), String(tareaId), String(archivoId)))
  h('classroom:descargar', (cursoId: string, entregaId: string, archivoId: string) => C.descargar(String(cursoId), String(entregaId), String(archivoId)))
  // Para quién es cada tarea en el portal y si acepta entregas tarde (viaja al portal en línea con la sincronización)
  h('classroom:ajustePortal', (cursoId: string, tareaId: string, a: PortalTarea) =>
    guardarAjusteTarea(getDb(), String(cursoId), String(tareaId), { visibilidad: a?.visibilidad, alumnos: Array.isArray(a?.alumnos) ? a.alumnos.map(Number) : [], acepta_tarde: !!a?.acepta_tarde }))
  h('classroom:activarTareasApp', (materiaId: number) => C.activarTareasApp(Number(materiaId)))
  h('classroom:crearTarea', (cursoId: string, t: C.NuevaTarea) => C.crearTarea(String(cursoId), t))
  h('classroom:subirArchivosTarea', () => C.subirArchivosTarea())
  h('classroom:editarTarea', (cursoId: string, tareaId: string, t: Partial<C.NuevaTarea>) => C.editarTarea(String(cursoId), String(tareaId), t))
  h('classroom:borrarTarea', (cursoId: string, tareaId: string) => C.borrarTarea(String(cursoId), String(tareaId)))
  h('classroom:calificarEnClassroom', (cursoId: string, tareaId: string, notas: { entrega_id: string; nota: number }[], devolver: boolean) =>
    C.calificarEnClassroom(String(cursoId), String(tareaId), (Array.isArray(notas) ? notas : []).map((n) => ({ entrega_id: String(n.entrega_id), nota: Number(n.nota) })), !!devolver))
  h('classroom:revisarCopias', (claves: string[]) => C.revisarCopias((Array.isArray(claves) ? claves : []).map(String)))
  // Segunda opinión con IA sobre el último informe de copias (lee el contenido, no solo los metadatos)
  h('classroom:revisarCopiasIA', (generado: string) => revisarEntregasConIA(String(generado)))
  h('classroom:metadatosEntrega', (cursoId: string, entregaId: string) => C.metadatosDeEntrega(String(cursoId), String(entregaId)))
  // Lo que ya se revisó (metadatos, copias, IA) queda guardado para verlo al volver
  h('classroom:revisionGuardada', (clave: string) => {
    const f = getDb().prepare('SELECT datos, guardado FROM revisiones_guardadas WHERE clave = ?').get(String(clave).slice(0, 2000)) as { datos: string; guardado: string } | undefined
    if (!f) return null
    try {
      return { datos: JSON.parse(f.datos) as unknown, guardado: f.guardado }
    } catch {
      return null
    }
  })
  h('classroom:guardarRevision', (clave: string, datos: unknown) => {
    getDb()
      .prepare("INSERT INTO revisiones_guardadas (clave, datos, guardado) VALUES (?, ?, datetime('now')) ON CONFLICT(clave) DO UPDATE SET datos = excluded.datos, guardado = excluded.guardado")
      .run(String(clave).slice(0, 2000), JSON.stringify(datos ?? null))
    return true
  })
  h('classroom:descargarTarea', (claves: string[]) => C.descargarTarea((Array.isArray(claves) ? claves : []).map(String)))
  h('classroom:abrirEnlace', (url: string) => C.abrirEnlace(String(url)))
  // Archivo que el alumno subió desde el portal («Subir tarea»): la ruta es relativa a datos/entregas
  h('classroom:abrirSubida', (archivoId: number) => {
    const f = getDb().prepare('SELECT ruta FROM archivos_subida WHERE id = ?').get(Number(archivoId)) as { ruta: string } | undefined
    if (!f) throw new Error('Ese archivo ya no está.')
    const ruta = isAbsolute(f.ruta) ? f.ruta : join(dataDir(), 'entregas', f.ruta)
    if (!existsSync(ruta)) throw new Error('El archivo todavía no llega a esta Mac. Espera a la siguiente sincronización con el portal.')
    return abrirArchivo(ruta)
  })
  // Tareas de la app: agrupan duplicados de Classroom y acreditan las de recuperación (comodín)
  h('classroom:crearTareaApp', (materiaId: number, nombre: string, claves: string[] = []) => C.crearTareaApp(Number(materiaId), String(nombre ?? ''), (claves ?? []).map(String)))
  h('classroom:actualizarTareaApp', (id: number, cambios: { nombre?: string; regla?: 'alta' | 'ultima' }) =>
    C.actualizarTareaApp(Number(id), { nombre: cambios?.nombre === undefined ? undefined : String(cambios.nombre), regla: cambios?.regla === 'ultima' ? 'ultima' : cambios?.regla ? 'alta' : undefined }))
  h('classroom:eliminarTareaApp', (id: number) => C.eliminarTareaApp(Number(id)))
  h('classroom:asignarTarea', (clave: string, tareaAppId: number | null) => C.asignarTarea(String(clave), tareaAppId ? Number(tareaAppId) : null))
  h('classroom:marcarComodin', (clave: string, comodin: boolean, cubre: number[] = []) => C.marcarComodin(String(clave), !!comodin, (cubre ?? []).map(Number)))
  h('classroom:decidirComodin', (clave: string, userId: string, destino: number | 'ninguna' | 'auto') =>
    C.decidirComodin(String(clave), String(userId), destino === 'ninguna' || destino === 'auto' ? destino : Number(destino)))
  h('classroom:aceptarSugerencias', (materiaId: number) => C.aceptarSugerencias(Number(materiaId)))
  h('classroom:exportarExcel', (materiaId: number) => C.exportarExcel(Number(materiaId)))
}
