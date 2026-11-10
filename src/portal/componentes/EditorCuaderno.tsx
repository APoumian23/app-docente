/**
 * Editor de cuadernos de Jupyter (.ipynb) del portal: el alumno contesta en las celdas de texto, corre y
 * escribe código (las variables se quedan entre celdas, como en Jupyter) y agrega celdas propias.
 * Lo usan el cuaderno de Materiales, la pregunta «cuaderno» de un examen y la revisión del docente.
 * Se carga aparte (Python y el editor pesan) para que el portal siga ligero en los celulares.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Boton, Chip, Modal, avisar } from './ui'
import Markdown from './Markdown'
import EditorCodigo from '@codigo/EditorCodigo'
import { Ejecutor, type Evento } from '@codigo/ejecutor'

// ---------- Formato .ipynb (nbformat 4) ----------

type Texto = string | string[]
interface SalidaNb {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  name?: 'stdout' | 'stderr'
  text?: Texto
  data?: Record<string, Texto>
  traceback?: string[]
  ename?: string
  evalue?: string
  metadata?: Record<string, unknown>
  execution_count?: number | null
}
interface CeldaNb {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  source: Texto
  metadata?: Record<string, unknown>
  outputs?: SalidaNb[]
  execution_count?: number | null
  attachments?: unknown
}
export interface Nb {
  cells: CeldaNb[]
  metadata?: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

interface Celda {
  id: string
  tipo: 'code' | 'markdown' | 'raw'
  fuente: string
  salidas: SalidaNb[]
  conteo: number | null
  /** La agregó el alumno: solo esas se pueden quitar (las del docente se quedan) */
  agregada: boolean
  meta: Record<string, unknown>
  attachments?: unknown
}

const unir = (t: Texto | undefined): string => (Array.isArray(t) ? t.join('') : (t ?? ''))
/** Jupyter guarda el texto como lista de renglones, cada uno con su salto de línea */
const partir = (t: string): string[] => (t === '' ? [] : t.split(/(?<=\n)/))
const idNuevo = (): string => Math.random().toString(36).slice(2, 10)
const sinAnsi = (t: string): string => t.replace(/\u001b\[[0-9;]*m/g, '')
/** Una salida enorme (un print en un ciclo) no debe volver pesadísimo el archivo */
const TOPE_SALIDA = 60_000

function desdeNb(nb: Nb): Celda[] {
  return nb.cells.map((c) => ({
    id: c.id || idNuevo(),
    tipo: c.cell_type,
    fuente: unir(c.source),
    salidas: c.outputs ?? [],
    conteo: c.execution_count ?? null,
    agregada: Boolean(c.metadata?.docente_agregada),
    meta: c.metadata ?? {},
    attachments: c.attachments
  }))
}

function aNb(celdas: Celda[], base: Nb): Nb {
  return {
    ...base,
    nbformat: 4,
    nbformat_minor: Math.max(base.nbformat_minor ?? 0, 5),
    cells: celdas.map((c) => {
      const comun = { id: c.id, metadata: { ...c.meta, ...(c.agregada ? { docente_agregada: true } : {}) }, source: partir(c.fuente) }
      if (c.tipo === 'code') return { cell_type: 'code', ...comun, outputs: c.salidas, execution_count: c.conteo }
      return { cell_type: c.tipo, ...comun, ...(c.attachments ? { attachments: c.attachments } : {}) }
    })
  }
}

/** Celdas de código con algo escrito que no se han corrido (su resultado no saldría en la entrega). */
export const celdasSinCorrer = (nb: Nb | null): number => (nb?.cells ?? []).filter((c) => c.cell_type === 'code' && unir(c.source).trim() && c.execution_count == null).length

/** Lee un .ipynb guardado como texto; null si no es un cuaderno. */
export function leerNb(texto: string | undefined): Nb | null {
  try {
    const nb = JSON.parse(texto ?? '') as Nb
    return nb && Array.isArray(nb.cells) ? nb : null
  } catch {
    return null
  }
}

/** Descarga el cuaderno como archivo .ipynb (Jupyter, Colab y VS Code lo abren). */
export function descargarNb(nb: Nb, nombre: string): void {
  const blob = new Blob([JSON.stringify(nb, null, 1)], { type: 'application/x-ipynb+json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = /\.ipynb$/i.test(nombre) ? nombre : `${nombre}.ipynb`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Lo que va saliendo al correr una celda, en el formato de Jupyter (salida, errores e imágenes). */
function agregarEvento(salidas: SalidaNb[], e: Evento): SalidaNb[] {
  if (e.tipo === 'imagen') return [...salidas, { output_type: 'display_data', data: { 'image/png': e.png, 'text/plain': '<Figure>' }, metadata: {} }]
  if (e.tipo === 'cargando') return salidas
  const nombre: 'stdout' | 'stderr' = e.tipo === 'error' ? 'stderr' : 'stdout'
  const ultima = salidas[salidas.length - 1]
  if (ultima?.output_type === 'stream' && ultima.name === nombre) {
    const texto = unir(ultima.text) + e.texto
    return [...salidas.slice(0, -1), { ...ultima, text: texto.length > TOPE_SALIDA ? texto.slice(0, TOPE_SALIDA) + '\n… (salida recortada)\n' : texto }]
  }
  return [...salidas, { output_type: 'stream', name: nombre, text: e.texto }]
}

// ---------- Editor ----------

interface Props {
  /** El cuaderno con el que arranca (después el editor lleva su propio estado) */
  inicial: Nb
  /** Solo lectura: entregado, o la revisión del docente */
  cerrado?: boolean
  /** false = solo la biblioteca estándar (como en las preguntas de código de un examen) */
  paquetes?: boolean
  /** Nombre del archivo al descargar; sin él no se ofrece descargar */
  nombreArchivo?: string
  /** Cada cambio (texto, código, salidas), un momento después de que ocurre */
  onCambio?: (nb: Nb) => void
  /** Botones extra al final de la barra (p. ej. «Entregar») */
  acciones?: ReactNode
}

/** Para preguntar sin `confirm()`: el cuadro del navegador quita el foco y en un examen contaría como salida. */
interface Pregunta {
  texto: string
  boton: string
  hacer: () => void
}

export default function EditorCuaderno({ inicial, cerrado = false, paquetes = true, nombreArchivo, onCambio, acciones }: Props): JSX.Element {
  const base = useRef<Nb>(inicial)
  const [celdas, setCeldas] = useState<Celda[]>(() => desdeNb(inicial))
  const [corriendo, setCorriendo] = useState<string | null>(null)
  const [corriendoTodo, setCorriendoTodo] = useState(false)
  const [editandoTexto, setEditandoTexto] = useState<string | null>(null)
  const [pythonPerdido, setPythonPerdido] = useState(false)
  const [pregunta, setPregunta] = useState<Pregunta | null>(null)
  const contador = useRef(Math.max(0, ...desdeNb(inicial).map((x) => x.conteo ?? 0)))
  const ejecutor = useMemo(() => new Ejecutor('/pyodide/'), [])
  const generacion = useRef(0)
  const detenerTodo = useRef(false)
  const sesion = 'cuaderno'

  // Python empieza a cargar al abrir, para que la primera celda responda rápido (no hace falta para solo leer)
  useEffect(() => {
    if (!cerrado) ejecutor.precargar('python')
    return () => ejecutor.cerrar()
  }, [ejecutor, cerrado])

  // ---------- Avisar los cambios ----------
  const celdasRef = useRef<Celda[]>(celdas)
  celdasRef.current = celdas
  const onCambioRef = useRef(onCambio)
  onCambioRef.current = onCambio
  const pendiente = useRef(false)
  const avisarCambio = (): void => {
    if (!pendiente.current) return
    pendiente.current = false
    onCambioRef.current?.(aNb(celdasRef.current, base.current))
  }
  const primera = useRef(true)
  useEffect(() => {
    if (primera.current) {
      primera.current = false
      return
    }
    // Las salidas llegan a chorros mientras corre una celda: se avisa una vez que se calma
    pendiente.current = true
    const t = setTimeout(avisarCambio, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [celdas])
  // Lo pendiente sale de inmediato al ocultarse la pestaña o al cerrar el editor
  useEffect(() => {
    const alOcultar = (): void => {
      if (document.visibilityState === 'hidden') avisarCambio()
    }
    document.addEventListener('visibilitychange', alOcultar)
    return () => {
      document.removeEventListener('visibilitychange', alOcultar)
      avisarCambio()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cambiar = (idCelda: string, cambio: Partial<Celda>): void => setCeldas((l) => l.map((c) => (c.id === idCelda ? { ...c, ...cambio } : c)))

  // ---------- Correr código ----------
  const correr = async (idCelda: string): Promise<boolean> => {
    const celda = celdasRef.current.find((c) => c.id === idCelda)
    if (!celda || celda.tipo !== 'code') return true
    // Si Python se reinició (Detener, error fatal), las variables de las celdas de arriba ya no existen
    if (ejecutor.generacionPython !== generacion.current) {
      if (contador.current > 0) setPythonPerdido(true)
      generacion.current = ejecutor.generacionPython
    }
    const n = ++contador.current
    cambiar(idCelda, { salidas: [], conteo: null })
    setCorriendo(idCelda)
    let salidas: SalidaNb[] = []
    const r = await ejecutor.ejecutar(
      'python',
      celda.fuente,
      '',
      (e) => {
        salidas = agregarEvento(salidas, e)
        cambiar(idCelda, { salidas })
      },
      300,
      paquetes,
      sesion
    )
    if (r.motivo) salidas = agregarEvento(salidas, { tipo: 'error', texto: `\n${r.motivo}\n` })
    cambiar(idCelda, { salidas, conteo: n })
    setCorriendo(null)
    if (ejecutor.generacionPython !== generacion.current) {
      setPythonPerdido(true)
      generacion.current = ejecutor.generacionPython
    }
    return r.ok
  }

  const correrTodo = async (): Promise<void> => {
    setCorriendoTodo(true)
    detenerTodo.current = false
    setPythonPerdido(false)
    for (const c of celdasRef.current) {
      if (detenerTodo.current) break
      if (c.tipo !== 'code' || !c.fuente.trim()) continue
      const ok = await correr(c.id)
      if (!ok) {
        avisar('Se detuvo en una celda con error: corrígela y vuelve a correr.', 'error')
        document.getElementById(`celda-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
    setCorriendoTodo(false)
  }

  const detener = (): void => {
    detenerTodo.current = true
    ejecutor.detener('Detenido.')
  }

  const reiniciar = (): void =>
    setPregunta({
      texto: 'Se olvidan todas las variables y tendrás que volver a correr las celdas desde arriba.',
      boton: 'Reiniciar Python',
      hacer: () => {
        ejecutor.olvidarSesion(sesion)
        contador.current = 0
        setPythonPerdido(false)
        avisar('Python reiniciado: corre las celdas desde arriba.', 'info')
      }
    })

  // ---------- Agregar y quitar celdas propias ----------
  const agregar = (despuesDe: number, tipo: 'code' | 'markdown'): void => {
    const nueva: Celda = { id: idNuevo(), tipo, fuente: '', salidas: [], conteo: null, agregada: true, meta: {} }
    setCeldas((l) => [...l.slice(0, despuesDe + 1), nueva, ...l.slice(despuesDe + 1)])
    if (tipo === 'markdown') setEditandoTexto(nueva.id)
  }
  const quitar = (idCelda: string): void =>
    setPregunta({ texto: 'Se borra esta celda con lo que tenga escrito.', boton: 'Quitar celda', hacer: () => setCeldas((l) => l.filter((c) => c.id !== idCelda)) })

  const ocupado = corriendo !== null

  return (
    <div className="space-y-3">
      {cerrado ? (
        nombreArchivo ? (
          <div className="flex justify-end">
            <Boton variante="secundario" className="min-h-[44px]" onClick={() => descargarNb(aNb(celdas, base.current), nombreArchivo)}>⤓ Descargar .ipynb</Boton>
          </div>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink-200 bg-white p-2.5">
          {corriendoTodo || ocupado ? (
            <Boton variante="peligro" className="min-h-[44px]" onClick={detener}>■ Detener</Boton>
          ) : (
            <Boton className="min-h-[44px]" onClick={() => void correrTodo()}>▶ Correr todo</Boton>
          )}
          <Boton variante="secundario" className="min-h-[44px]" disabled={ocupado} onClick={reiniciar} title="Olvida las variables y empieza de cero">↺ Reiniciar Python</Boton>
          {nombreArchivo && <Boton variante="fantasma" className="min-h-[44px]" onClick={() => descargarNb(aNb(celdas, base.current), nombreArchivo)}>⤓ Descargar .ipynb</Boton>}
          {acciones && <span className="flex flex-wrap gap-2 sm:ml-auto">{acciones}</span>}
        </div>
      )}

      {pythonPerdido && !cerrado && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
          Python se reinició y olvidó las variables. Corre las celdas desde arriba (o usa «Correr todo»).
        </div>
      )}

      <div className="space-y-1">
        {celdas.map((c, i) => (
          <div key={c.id}>
            <CeldaVista
              celda={c}
              cerrado={cerrado}
              corriendo={corriendo === c.id}
              ocupado={ocupado}
              editando={editandoTexto === c.id}
              onEditar={(v) => setEditandoTexto(v ? c.id : null)}
              onCambio={(fuente) => cambiar(c.id, { fuente })}
              onCorrer={() => void correr(c.id)}
              onQuitar={() => quitar(c.id)}
            />
            {!cerrado && (
              <div className="flex justify-center gap-1 py-0.5 opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100">
                <button className="min-h-[32px] rounded-lg px-2.5 text-xs text-ink-600 hover:bg-ink-100" onClick={() => agregar(i, 'code')} aria-label="Agregar celda de código aquí">+ Código</button>
                <button className="min-h-[32px] rounded-lg px-2.5 text-xs text-ink-600 hover:bg-ink-100" onClick={() => agregar(i, 'markdown')} aria-label="Agregar celda de texto aquí">+ Texto</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal abierto={pregunta !== null} titulo={pregunta?.boton ?? ''} onCerrar={() => setPregunta(null)}>
        <div className="space-y-4 text-sm">
          <p className="text-ink-700">{pregunta?.texto}</p>
          <div className="flex justify-end gap-2">
            <Boton variante="fantasma" className="min-h-[44px]" onClick={() => setPregunta(null)}>Cancelar</Boton>
            <Boton
              variante="peligro"
              className="min-h-[44px]"
              onClick={() => {
                pregunta?.hacer()
                setPregunta(null)
              }}
            >
              {pregunta?.boton}
            </Boton>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CeldaVista({
  celda,
  cerrado,
  corriendo,
  ocupado,
  editando,
  onEditar,
  onCambio,
  onCorrer,
  onQuitar
}: {
  celda: Celda
  cerrado: boolean
  corriendo: boolean
  ocupado: boolean
  editando: boolean
  onEditar: (v: boolean) => void
  onCambio: (fuente: string) => void
  onCorrer: () => void
  onQuitar: () => void
}): JSX.Element {
  const quitar = celda.agregada && !cerrado && (
    <button className="min-h-[32px] rounded-lg px-2 text-xs text-red-600 hover:bg-red-50" onClick={onQuitar}>Quitar celda</button>
  )
  if (celda.tipo === 'code') {
    const renglones = Math.max(2, celda.fuente.split('\n').length)
    return (
      <section id={`celda-${celda.id}`} className={`rounded-2xl border bg-white ${corriendo ? 'border-brand-400 ring-2 ring-brand-400/30' : 'border-ink-200'}`} aria-label="Celda de código">
        <div className="flex items-center gap-2 border-b border-ink-100 px-2 py-1">
          {!cerrado && (
            <button
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-40"
              onClick={onCorrer}
              disabled={ocupado}
              aria-label="Correr esta celda"
              title="Correr (Ctrl/⌘ + Enter)"
            >
              {corriendo ? <span className="h-3 w-3 animate-pulse rounded-full bg-white" /> : '▶'}
            </button>
          )}
          <span className="font-mono text-xs text-ink-500">{corriendo ? '[*]' : `[${celda.conteo ?? ' '}]`}</span>
          {celda.agregada && <Chip tono="azul">{cerrado ? 'Agregada por el alumno' : 'Tuya'}</Chip>}
          <span className="ml-auto">{quitar}</span>
        </div>
        <EditorCodigo
          valor={celda.fuente}
          onCambio={onCambio}
          lenguaje="python"
          letra={14}
          alto={`${Math.min(renglones, 40) * 20 + 16}px`}
          soloLectura={cerrado}
          onEjecutar={cerrado || ocupado ? undefined : onCorrer}
          basePyodide="/pyodide/"
          etiqueta="Código de la celda"
        />
        {celda.salidas.length > 0 && (
          <div className="space-y-1 border-t border-ink-100 bg-ink-50/60 px-3 py-2">
            {celda.salidas.map((s, i) => (
              <SalidaVista key={i} s={s} />
            ))}
          </div>
        )}
      </section>
    )
  }
  // Texto (markdown): se lee con formato; para contestar se abre el editor
  if (editando && !cerrado) {
    return (
      <section className="rounded-2xl border border-brand-400 bg-white p-3" aria-label="Editar texto">
        <textarea
          className="min-h-[120px] w-full resize-y rounded-xl border border-ink-200 p-3 font-mono text-sm text-ink-800 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/30"
          value={celda.fuente}
          onChange={(e) => onCambio(e.target.value)}
          rows={Math.min(20, Math.max(4, celda.fuente.split('\n').length + 1))}
          autoFocus
          aria-label="Texto de la celda"
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-ink-500">Puedes usar **negritas**, listas y tablas.</span>
          <span className="flex gap-1">
            {quitar}
            <Boton className="min-h-[40px]" onClick={() => onEditar(false)}>Listo</Boton>
          </span>
        </div>
      </section>
    )
  }
  return (
    <section className={`group relative rounded-2xl px-1 py-1 ${celda.agregada && cerrado ? 'border-l-4 border-sky-300 pl-3' : ''}`} aria-label="Celda de texto" onDoubleClick={() => !cerrado && onEditar(true)}>
      {celda.fuente.trim() ? (
        <Markdown texto={celda.fuente} className="text-ink-800" />
      ) : (
        <div className="px-2 py-3 text-sm italic text-ink-400">{cerrado ? 'Celda vacía.' : 'Celda vacía: toca «Escribir» para contestar aquí.'}</div>
      )}
      {!cerrado && (
        <div className="mt-1 flex justify-end gap-1">
          {quitar}
          <button className="min-h-[36px] rounded-lg border border-ink-200 bg-white px-3 text-xs font-medium text-ink-700 hover:bg-ink-100" onClick={() => onEditar(true)}>✎ Escribir</button>
        </div>
      )}
    </section>
  )
}

function SalidaVista({ s }: { s: SalidaNb }): JSX.Element | null {
  const png = s.data?.['image/png']
  if (png) return <img src={`data:image/png;base64,${unir(png)}`} alt="Figura" className="max-w-full rounded-lg bg-white" />
  const texto =
    s.output_type === 'stream'
      ? unir(s.text)
      : s.output_type === 'error'
        ? sinAnsi((s.traceback ?? []).join('\n') || `${s.ename}: ${s.evalue}`)
        : unir(s.data?.['text/plain'])
  if (!texto) return null
  const error = s.output_type === 'error' || s.name === 'stderr'
  return <pre className={`max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed ${error ? 'text-red-700' : 'text-ink-800'}`}>{texto}</pre>
}
