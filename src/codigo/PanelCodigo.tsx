/**
 * Editor + Ejecutar + Datos de entrada + Consola. Lo usan la pantalla Programar de la app,
 * las preguntas de código del portal y la revisión de entregas del docente.
 */
import { useEffect, useRef, useState } from 'react'
import EditorCodigo from './EditorCodigo'
import { Ejecutor, type Evento } from './ejecutor'
import { LENGUAJES, type Lenguaje } from './lenguajes'
import { formatearPython } from './ayudas'

type Linea = { tipo: 'salida' | 'error' | 'entrada' | 'aviso'; texto: string } | { tipo: 'imagen'; png: string }

// Clases propias: el portal no tiene los botones ni los campos de la app
const BOTON = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
const PRIMARIO = `${BOTON} bg-brand-500 text-white hover:bg-brand-600`
const SECUNDARIO = `${BOTON} bg-white border border-ink-200 text-ink-700 hover:bg-ink-100`
const PELIGRO = `${BOTON} bg-red-50 text-red-700 border border-red-200 hover:bg-red-100`

/** Un ejecutor por dirección de Pyodide: Python se carga una vez aunque haya varios editores en la pantalla. */
const ejecutores = new Map<string, Ejecutor>()
const ejecutorPara = (base: string): Ejecutor => {
  let e = ejecutores.get(base)
  if (!e) ejecutores.set(base, (e = new Ejecutor(base)))
  return e
}

/** ⌘ en Mac, Ctrl en lo demás; en pantallas táctiles no hay teclado físico que anunciar. */
const tactil = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const ATAJO = /Mac|iPhone|iPad/.test(typeof navigator !== 'undefined' ? navigator.platform || navigator.userAgent : '') ? '⌘ + Enter' : 'Ctrl + Enter'

export default function PanelCodigo({
  codigo,
  onCambio,
  lenguaje,
  basePyodide,
  letra = 14,
  altoEditor = '320px',
  limiteSeg = 0,
  soloLectura = false,
  lado = true,
  extraBarra,
  entrada: entradaProp,
  onEntrada,
  oscuro = false,
  aislado = false,
  paquetes = true,
  ayudas = true,
  onSalida,
  ajustar = false
}: {
  codigo: string
  onCambio?: (v: string) => void
  lenguaje: Lenguaje
  /** Dónde están los archivos de Python (docente://pyodide/ o /pyodide/) */
  basePyodide: string
  letra?: number
  altoEditor?: string
  /** Tope de tiempo por ejecución (0 = sin tope, solo el botón Detener) */
  limiteSeg?: number
  soloLectura?: boolean
  /** Editor y consola lado a lado cuando hay espacio */
  lado?: boolean
  extraBarra?: React.ReactNode
  /** Datos de entrada guardados por fuera (p. ej. con el programa); si no se pasan, viven aquí */
  entrada?: string
  onEntrada?: (v: string) => void
  oscuro?: boolean
  /** Python nuevo en cada ejecución (revisar entregas de varios alumnos) */
  aislado?: boolean
  /** false = solo la biblioteca estándar (p. ej. en un examen: nada de sympy) */
  paquetes?: boolean
  /** Autocompletado y errores con Jedi (pesa: se apaga en exámenes y en celulares) */
  ayudas?: boolean
  /** Al terminar cada ejecución: todo lo que mostró la consola (texto) */
  onSalida?: (texto: string) => void
  /** Las líneas largas del editor bajan al siguiente renglón */
  ajustar?: boolean
}): JSX.Element {
  const [lineas, setLineas] = useState<Linea[]>([])
  const [corriendo, setCorriendo] = useState(false)
  const [cargando, setCargando] = useState('')
  const [entradaLocal, setEntradaLocal] = useState('')
  const entrada = entradaProp ?? entradaLocal
  const setEntrada = onEntrada ?? setEntradaLocal
  const [verEntrada, setVerEntrada] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const consola = useRef<HTMLDivElement>(null)
  // Al revisar entregas cada panel tiene su propio Python, nuevo en cada ejecución
  const [propio] = useState(() => (aislado ? new Ejecutor(basePyodide, true) : null))
  const ejecutor = propio ?? ejecutorPara(basePyodide)
  const [fin, setFin] = useState('')
  const usaEntrada = lenguaje === 'python' ? /\binput\s*\(/.test(codigo) : /\bprompt\s*\(/.test(codigo)

  useEffect(() => {
    consola.current?.scrollTo({ top: consola.current.scrollHeight })
  }, [lineas])
  // Al salir de la pantalla se corta lo que esté corriendo
  useEffect(() => () => (propio ? propio.cerrar() : ejecutor.detener()), [ejecutor, propio])
  // Python se empieza a cargar al abrir el editor, no hasta pulsar «Ejecutar»
  useEffect(() => {
    if (!soloLectura) ejecutor.precargar(lenguaje)
  }, [ejecutor, lenguaje, soloLectura])

  const agregar = (l: Linea): void =>
    setLineas((xs) => {
      const u = xs[xs.length - 1]
      // Se juntan los pedazos seguidos del mismo tipo (menos nodos en pantalla)
      if (u && l.tipo !== 'imagen' && u.tipo === l.tipo && 'texto' in u && u.texto.length < 4000) return [...xs.slice(0, -1), { ...u, texto: u.texto + l.texto }]
      return [...xs, l]
    })

  const ejecutar = async (): Promise<void> => {
    if (corriendo) return
    setLineas([])
    setMs(null)
    setFin('')
    setCorriendo(true)
    // En pantallas angostas la consola queda debajo del editor: se lleva a la vista
    const c = consola.current
    if (c && c.getBoundingClientRect().top > innerHeight - 80) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t0 = performance.now()
    let inicio = 0
    let todo = ''
    const r = await ejecutor.ejecutar(
      lenguaje,
      codigo,
      entrada,
      (e: Evento) => {
        if (e.tipo === 'cargando') return setCargando(e.texto)
        if (!inicio) inicio = performance.now()
        if (e.tipo !== 'imagen') todo += e.texto
        else todo += '[gráfica]\n'
        setCargando('')
        agregar(e.tipo === 'imagen' ? e : { tipo: e.tipo, texto: e.texto })
      },
      limiteSeg,
      paquetes
    )
    setCargando('')
    setCorriendo(false)
    setMs(Math.round(performance.now() - (inicio || t0)))
    if (r.motivo) agregar({ tipo: 'aviso', texto: `\n${r.motivo}\n` })
    onSalida?.(todo + (r.motivo ? `\n${r.motivo}` : ''))
    // Un solo anuncio al terminar (la consola no se lee línea por línea con lector de pantalla)
    setFin(r.motivo ? r.motivo : r.ok ? 'Terminó de ejecutarse.' : 'Terminó con un error.')
  }

  // «Dar formato»: espacios, sangrías y renglones según PEP 8 (autopep8, sin internet); ⌘Z en el editor lo deshace
  const [formateando, setFormateando] = useState(false)
  const darFormato = async (): Promise<void> => {
    if (!onCambio || formateando) return
    setFormateando(true)
    try {
      const nuevo = await formatearPython(codigo, basePyodide)
      if (nuevo !== codigo) onCambio(nuevo)
      const aviso = nuevo === codigo ? 'El código ya tenía buen formato.' : 'Formato aplicado (⌘Z en el editor lo deshace).'
      agregar({ tipo: 'aviso', texto: `${aviso}\n` })
      setFin(aviso)
    } catch (e) {
      agregar({ tipo: 'aviso', texto: `No se pudo dar formato: ${(e as Error).message}\n` })
    } finally {
      setFormateando(false)
    }
  }

  const estilo: Record<string, string> = { salida: 'text-ink-50', error: 'text-red-300', entrada: 'text-emerald-300', aviso: 'text-amber-300' }

  return (
    <div className={`grid gap-3 min-w-0 ${lado ? 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : ''}`}>
      <div className="space-y-2 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={PRIMARIO} onClick={ejecutar} disabled={corriendo} title={ATAJO}>
            {corriendo ? 'Ejecutando…' : '▶ Ejecutar'}
          </button>
          {corriendo && (
            <button type="button" className={PELIGRO} onClick={() => ejecutor.detener()}>
              ■ Detener
            </button>
          )}
          <button type="button" className={`${SECUNDARIO} ${usaEntrada && !entrada ? '!border-amber-400' : ''}`} onClick={() => setVerEntrada((v) => !v)} aria-expanded={verEntrada}>
            Datos de entrada{entrada ? ` (${entrada.split('\n').filter((x) => x !== '').length})` : ''}
          </button>
          {usaEntrada && !entrada && !verEntrada && <span className="text-xs text-amber-700">Usa {lenguaje === 'python' ? 'input()' : 'prompt()'}: escribe sus datos</span>}
          <span className="text-xs text-ink-400">{LENGUAJES[lenguaje].nombre}</span>
          {lenguaje === 'python' && ayudas && !soloLectura && onCambio && (
            <button type="button" className={SECUNDARIO} onClick={() => void darFormato()} disabled={formateando || corriendo} title="Acomoda espacios, sangrías y renglones como lo pide PEP 8 (⌘Z lo deshace)">
              {formateando ? 'Dando formato…' : '✨ Dar formato'}
            </button>
          )}
          {extraBarra}
        </div>
        {verEntrada && (
          <label className="block">
            <span className="text-xs text-ink-500">Lo que leerá {lenguaje === 'python' ? 'input()' : 'prompt()'}, un dato por línea</span>
            <textarea className="w-full rounded-lg border border-ink-200 bg-white px-3 py-1.5 font-mono text-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-brand-400/40" rows={3} value={entrada} onChange={(e) => setEntrada(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          </label>
        )}
        <EditorCodigo
          valor={codigo}
          onCambio={onCambio}
          lenguaje={lenguaje}
          letra={letra}
          alto={altoEditor}
          soloLectura={soloLectura}
          onEjecutar={ejecutar}
          basePyodide={ayudas && !tactil ? basePyodide : undefined}
          oscuro={oscuro}
          teclas={tactil && !soloLectura}
          ajustar={ajustar}
        />
      </div>
      <div className="min-w-0 flex flex-col">
        <div className="flex items-center justify-between text-xs text-ink-500 mb-1">
          <span>Consola</span>
          <span className="flex items-center gap-2">
            {ms !== null && <span>{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}</span>}
            {lineas.length > 0 && (
              <button type="button" className="underline" onClick={() => setLineas([])}>
                Limpiar
              </button>
            )}
          </span>
        </div>
        <div
          ref={consola}
          role="log"
          aria-live="off"
          className="flex-1 min-h-[160px] max-h-[60vh] overflow-auto rounded-lg bg-ink-900 p-3 font-mono whitespace-pre-wrap break-words select-text"
          style={{ fontSize: Math.max(12, letra - 1) }}
        >
          {cargando && <div className="text-ink-300">{cargando}</div>}
          {!cargando && lineas.length === 0 && <div className="text-ink-400">{corriendo ? '…' : `Pulsa «Ejecutar»${tactil ? '' : ` (${ATAJO})`} para ver aquí el resultado.`}</div>}
          {lineas.map((l, i) =>
            l.tipo === 'imagen' ? (
              <img key={i} src={`data:image/png;base64,${l.png}`} alt="Gráfica generada por el programa" className="my-2 max-w-full rounded bg-white" />
            ) : (
              <span key={i} className={estilo[l.tipo]}>
                {l.texto}
              </span>
            )
          )}
        </div>
        {/* aria-live sin role=status: la página que contiene el editor puede tener su propia franja de estado */}
        <span className="sr-only" aria-live="polite">{fin}</span>
      </div>
    </div>
  )
}
