import { Fragment, type ReactNode } from 'react'
import Encabezado from '../components/Encabezado'
import { useRecordado } from '../lib/recordado'
import { Buscador, Segmentado, SinResultados, coincide } from '../components/Filtros'

/**
 * Los textos van como datos para poder buscar en ellos: **así** se marca lo que va en negritas y
 * [[Tecla]] lo que se dibuja como tecla.
 */
type Grupo = 'app' | 'software'
interface Tema {
  id: string
  grupo: Grupo
  titulo: string
  intro?: string
  /** Pasos numerados (flujo) o viñetas */
  numerado?: boolean
  puntos: string[]
}
interface Area {
  area: string
  items: { n: string; p: string; u: string }[]
}

const TEMAS: Tema[] = [
  {
    id: 'flujo',
    grupo: 'app',
    titulo: 'Flujo de trabajo recomendado',
    numerado: true,
    puntos: [
      '**Configura** periodo (cuatrimestre), carreras y materias con su temario y horario.',
      '**Genera sesiones** del periodo en cada materia: una por clase con actividades cronometradas por plantilla (encuadre, repaso, exposición, ejercicio, receso, práctica, cierre).',
      '**Importa alumnos** desde el Excel de control escolar e inscríbelos a la materia.',
      '**Sube materiales** (presentación, apuntes, prácticas). El texto se extrae para que la IA trabaje con tu contenido real.',
      '**Antes de clase**: en la sesión, escribe el tema o pide a la IA un plan de sesión y aplícalo.',
      '**En clase**: Modo clase. Reloj por actividad, “Después” siempre visible, pase de lista con un clic, presentación en la misma ventana. Espacio para pausar, flechas para cambiar actividad.',
      '**Examen sorpresa**: Estudio IA → examen sorpresa con el tema de hoy → PDF en un minuto.',
      '**Después**: captura entregas y calificaciones; exporta Excel de la materia o el PDF de cada alumno.'
    ]
  },
  {
    id: 'programar',
    grupo: 'app',
    titulo: 'Programar (editor de código)',
    intro: 'Python 3.14 y JavaScript corren dentro de la app, **sin internet**. Tus programas se guardan solos y puedes ordenarlos por materia. **Proyectar** agranda la letra para el proyector.',
    puntos: [
      '[[⌘ + Enter]] ejecuta · [[Ctrl + Espacio]] abre sugerencias · [[⌘ /]] comenta líneas · [[⌘ F]] busca y reemplaza · [[Tab]] sangra.',
      'Como en VS Code: autocompletado con la documentación de cada función (Python usa Jedi), errores subrayados mientras escribes y ayuda al pasar el cursor.',
      '**input()** y **prompt()** leen de «Datos de entrada», un dato por línea. Las gráficas de matplotlib aparecen en la consola.',
      '**Paquetes de Python** (numpy, matplotlib, pandas, sympy…): se descargan una vez con internet y luego funcionan sin conexión, también para los alumnos.',
      'Los alumnos tienen su propio **Programar** en el portal, y las preguntas de tipo «Código» de los exámenes traen el editor con «Ejecutar». Al revisar la entrega puedes correr su código.'
    ]
  },
  {
    id: 'atajos',
    grupo: 'app',
    titulo: 'Atajos en Modo clase',
    puntos: ['[[Espacio]] iniciar / pausar', '[[←]] [[→]] actividad anterior / siguiente (o diapositiva)', '[[Esc]] salir de pantalla completa']
  },
  {
    id: 'presentaciones',
    grupo: 'app',
    titulo: 'Presentaciones',
    intro: 'Los PDF se proyectan dentro de la app. PowerPoint y Keynote se abren en su aplicación con un clic (mantén la app en una pantalla y la presentación en el proyector). También puedes generar diapositivas con IA y proyectarlas desde Modo clase.',
    puntos: []
  }
]

const SOFTWARE: Area[] = [
  { area: 'Matemáticas (álgebra lineal, cálculo, geometría)', items: [
    { n: 'GeoGebra', p: 'Visualizar vectores, transformaciones lineales, sistemas de ecuaciones. Los enlaces geogebra.org se guardan como material y se abren desde la app.', u: 'https://www.geogebra.org/calculator' },
    { n: 'Desmos', p: 'Graficadora rápida para funciones y regresiones.', u: 'https://www.desmos.com/calculator' },
    { n: 'Python + NumPy (Jupyter)', p: 'Resolver sistemas, determinantes, eigenvalores con código; ideal para ingenierías.', u: 'https://jupyter.org' },
    { n: 'Wolfram Alpha', p: 'Verificar resultados paso a paso.', u: 'https://www.wolframalpha.com' }
  ] },
  { area: 'Programación y TI', items: [
    { n: 'VS Code', p: 'Editor estándar; extensiones Live Share para programar en vivo con el grupo.', u: 'https://code.visualstudio.com' },
    { n: 'Replit / CodeSandbox', p: 'Ejercicios en el navegador sin instalar nada en las máquinas del laboratorio.', u: 'https://replit.com' },
    { n: 'GitHub Classroom', p: 'Repartir tareas de código y recibir entregas por repositorio.', u: 'https://classroom.github.com' },
    { n: 'SQLiteOnline / DB Fiddle', p: 'Práctica de bases de datos sin servidor.', u: 'https://sqliteonline.com' }
  ] },
  { area: 'Ingeniería / mecatrónica', items: [
    { n: 'Tinkercad Circuits', p: 'Simulación de circuitos y Arduino en el navegador.', u: 'https://www.tinkercad.com' },
    { n: 'MATLAB Online / Octave', p: 'Cálculo numérico y matrices.', u: 'https://octave.org' },
    { n: 'Fusion 360 / Onshape', p: 'CAD para proyectos.', u: 'https://www.onshape.com' }
  ] },
  { area: 'Dinámicas y evaluación en vivo', items: [
    { n: 'Kahoot / Quizizz', p: 'Convierte el cuestionario generado aquí en un juego en vivo: exporta a Word y pega las preguntas.', u: 'https://kahoot.com' },
    { n: 'Mentimeter', p: 'Encuestas y nubes de palabras para abrir la clase.', u: 'https://www.mentimeter.com' },
    { n: 'Google Forms', p: 'Examen en línea autocalificable; pega los reactivos exportados.', u: 'https://forms.google.com' }
  ] }
]

/** Texto plano (sin marcas) para buscar. */
const plano = (t: string): string => t.replace(/\*\*|\[\[|\]\]/g, '')

/** Dibuja **negritas** y [[teclas]]. */
function Texto({ t }: { t: string }): JSX.Element {
  const partes = t.split(/(\*\*[^*]+\*\*|\[\[[^\]]+\]\])/g)
  return (
    <>
      {partes.map((p, i): ReactNode =>
        p.startsWith('**') ? (
          <b key={i} className="font-semibold text-ink-900">{p.slice(2, -2)}</b>
        ) : p.startsWith('[[') ? (
          <kbd key={i} className="whitespace-nowrap rounded border border-ink-200 bg-ink-50 px-1 font-sans text-[12px] text-ink-700">{p.slice(2, -2)}</kbd>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  )
}

export default function Ayuda(): JSX.Element {
  const [busqueda, setBusqueda] = useRecordado('ayuda.busqueda', '')
  const [grupo, setGrupo] = useRecordado<Grupo | 'todo'>('ayuda.grupo', 'todo')

  // Si el título del tema coincide se ve completo; si no, solo los puntos que coinciden
  const temas = TEMAS.map((t) => {
    const todo = coincide(busqueda, t.titulo)
    const intro = t.intro && (todo || coincide(busqueda, plano(t.intro))) ? t.intro : undefined
    const puntos = todo ? t.puntos : t.puntos.filter((p) => coincide(busqueda, plano(p)))
    return { ...t, intro: todo ? t.intro : intro, puntos, visible: todo || !!intro || puntos.length > 0 }
  }).filter((t) => t.visible)
  const areas = SOFTWARE.map((s) => ({ ...s, items: coincide(busqueda, s.area) ? s.items : s.items.filter((i) => coincide(busqueda, i.n, i.p)) })).filter((s) => s.items.length > 0)
  const nSoftware = areas.reduce((n, a) => n + a.items.length, 0)
  const verApp = grupo !== 'software'
  const verSoftware = grupo !== 'app'
  const hayFiltro = !!busqueda.trim() || grupo !== 'todo'
  const quitarFiltros = (): void => {
    setBusqueda('')
    setGrupo('todo')
  }
  const nada = (!verApp || temas.length === 0) && (!verSoftware || areas.length === 0)

  return (
    <div>
      <Encabezado titulo="Ayuda y recomendaciones" sub="Flujo de trabajo sugerido, atajos y software de terceros para ejercicios" />
      <div className="px-4 sm:px-8 py-5 max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Buscar en la ayuda">
          <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar en la ayuda (atajos, Python, Kahoot…)" etiqueta="Buscar en la ayuda" />
          <Segmentado
            etiqueta="Qué mostrar"
            valor={grupo}
            onCambio={setGrupo}
            opciones={[
              { valor: 'todo', texto: 'Todo' },
              { valor: 'app', texto: 'Uso de la app', conteo: busqueda.trim() ? temas.length : undefined },
              { valor: 'software', texto: 'Software recomendado', conteo: busqueda.trim() ? nSoftware : undefined }
            ]}
          />
          {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
        </div>

        {nada && (
          <div className="tarjeta">
            <SinResultados hayFiltro onLimpiar={quitarFiltros} vacio={null} />
          </div>
        )}

        {verApp &&
          temas.map((t) => (
            <section key={t.id} className="tarjeta p-5 text-sm text-ink-700 space-y-2" aria-labelledby={`ayuda-${t.id}`}>
              <h3 id={`ayuda-${t.id}`} className="font-semibold text-ink-900">{t.titulo}</h3>
              {t.intro && <p><Texto t={t.intro} /></p>}
              {t.puntos.length > 0 &&
                (t.numerado ? (
                  <ol className="list-decimal space-y-1.5 pl-5">
                    {t.puntos.map((p) => <li key={p}><Texto t={p} /></li>)}
                  </ol>
                ) : t.id === 'atajos' ? (
                  // Atajos en columnas: se leen de un vistazo y bajan a una sola en ventana angosta
                  <ul className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-4 gap-y-1.5">
                    {t.puntos.map((p) => <li key={p}><Texto t={p} /></li>)}
                  </ul>
                ) : (
                  <ul className="list-disc space-y-1 pl-5">
                    {t.puntos.map((p) => <li key={p}><Texto t={p} /></li>)}
                  </ul>
                ))}
            </section>
          ))}

        {verSoftware && areas.length > 0 && (
          <>
            {grupo === 'todo' && <h2 className="etiqueta px-1 pt-2">Software recomendado</h2>}
            {areas.map((s) => (
              <section key={s.area} className="tarjeta overflow-hidden" aria-label={s.area}>
                <h3 className="border-b border-ink-100 bg-ink-50/70 px-5 py-2.5 font-semibold text-ink-900">{s.area}</h3>
                <ul className="divide-y divide-ink-100 text-sm">
                  {s.items.map((i) => (
                    // Nombre y para qué sirve en dos columnas; en ventana angosta, uno debajo del otro
                    <li key={i.n} className="flex flex-wrap gap-x-4 gap-y-0.5 px-5 py-2.5">
                      <a href={i.u} target="_blank" rel="noreferrer" className="min-w-0 font-medium text-brand-600 hover:underline sm:w-48 sm:shrink-0">{i.n} <span className="text-xs text-ink-400" aria-hidden>↗</span></a>
                      <span className="min-w-0 flex-[1_1_16rem] text-ink-600">{i.p}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
