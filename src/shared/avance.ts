/** «Mi avance» del alumno en el portal (lo arma src/servidor/avance.ts). */
import type { EstadoCalif } from './esquema'
import type { Riesgo } from './asistencia'
import type { Situacion } from './proyeccion'

export interface AvanceMateria {
  id: number
  nombre: string
  color: string
  minima: number | null
  /** Final si lo que falta sale como lo evaluado hasta hoy */
  al_ritmo_actual: number | null
  evaluado_pct: number
  necesita: number | null
  situacion: Situacion | null
  /** Los números de la final solo salen si todo lo que ya tiene calificación está publicado */
  resumen_visible: boolean
  parciales: {
    nombre: string
    /** false = «En captura»: el docente aún no lo publica y no se manda nada de él */
    publicado: boolean
    desde: string
    hasta: string
    calificacion: number | null
    estado: EstadoCalif
    etiqueta: string
    provisional: boolean
    asistencia: number | null
    componentes: { nombre: string; peso: number; valor: number | null; detalle: string }[]
  }[]
  asistencia: {
    horas_falta: number
    limite: number
    extraordinario: number
    recursa: number
    riesgo: Riesgo
    etiqueta: string
    /** «Con 2 h más llegas a Extraordinario» */
    siguiente: string | null
    porcentaje: number | null
    /** Clases que ya pasaron sin pase de lista registrado: las faltas pueden cambiar */
    sin_lista: number
  }
  proximas: { fecha: string; fecha_fin: string | null; titulo: string; tipo: string }[]
}
