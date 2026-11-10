/**
 * Editor de código para las preguntas de tipo «Código»: se carga aparte (solo si la actividad lo usa)
 * para que el portal siga ligero en los celulares. Python sale del servidor del salón, sin internet.
 */
import { lazy, Suspense } from 'react'
import { lenguajeDeTexto, type Lenguaje } from '@codigo/lenguajes'

const PanelCodigo = lazy(() => import('@codigo/PanelCodigo'))

export default function Codigo({
  valor,
  onCambio,
  pistas = [],
  lenguaje,
  soloLectura = false,
  revision = false
}: {
  valor: string
  onCambio?: (v: string) => void
  /** Lenguaje que manda el servidor con la pregunta (el mismo para alumno y docente) */
  lenguaje?: Lenguaje
  /** Si la pregunta no trae lenguaje, se adivina con estos textos */
  pistas?: string[]
  soloLectura?: boolean
  /** Revisión del docente: Python nuevo por ejecución (el código de un alumno no afecta al de otro) */
  revision?: boolean
}): JSX.Element {
  return (
    <Suspense fallback={<div className="rounded-xl border border-ink-200 bg-white p-4 text-sm text-ink-500">Cargando el editor…</div>}>
      <PanelCodigo
        codigo={valor}
        onCambio={onCambio}
        lenguaje={lenguaje ?? lenguajeDeTexto(...pistas)}
        basePyodide="/pyodide/"
        limiteSeg={15}
        lado={false}
        altoEditor="min(36vh, 22rem)"
        soloLectura={soloLectura}
        aislado={revision}
        // En actividades: solo Python puro (nada de sympy en un examen) y sin las ayudas pesadas
        paquetes={false}
        ayudas={false}
      />
    </Suspense>
  )
}
