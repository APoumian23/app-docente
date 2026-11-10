/**
 * Editor de código (CodeMirror 6): resaltado, autocompletado, sangría con Tab y buscar/reemplazar.
 * Funciona con teclado de celular. El tamaño de letra se puede subir para proyectar.
 */
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab, indentMore, indentLess, undo } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { oneDarkTheme } from '@codemirror/theme-one-dark'
import { coloresCodigo } from './colores'
import { extensionesAyuda } from './ayudas'
import type { Lenguaje } from './lenguajes'

// Lenguaje + sus ayudas (autocompletado, errores y documentación al pasar el cursor)
const sintaxis = (l: Lenguaje, base?: string) => [l === 'python' ? python() : javascript(), ...extensionesAyuda(l, base)]
const tema = (letra: number, alto: string, oscuro: boolean) => [
  EditorView.theme(
    {
      '&': { fontSize: `${letra}px`, height: alto, ...(oscuro ? {} : { backgroundColor: '#fff' }) },
      '.cm-scroller': { fontFamily: '"SF Mono", Menlo, Consolas, monospace', lineHeight: '1.55' },
      '.cm-gutters': oscuro ? { border: 'none' } : { backgroundColor: '#f5f7fa', color: '#7c8ba3', border: 'none' },
      '&.cm-focused': { outline: 'none' },
      '.cm-tooltip': { fontSize: `${Math.max(12, letra - 2)}px`, maxWidth: 'min(36rem, 90vw)' },
      '.cm-ayuda': { padding: '6px 10px', maxHeight: '18rem', overflow: 'auto' },
      '.cm-ayuda-firma': { fontFamily: '"SF Mono", Menlo, monospace', fontWeight: '600', whiteSpace: 'pre-wrap' },
      '.cm-ayuda-doc': { marginTop: '4px', whiteSpace: 'pre-wrap', opacity: '0.85' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#2d6df6', color: '#fff' }
    },
    { dark: oscuro }
  ),
  // Fondo y marco de One Dark en oscuro; los colores del código, como VS Code en los dos temas
  ...(oscuro ? [oneDarkTheme] : []),
  coloresCodigo(oscuro)
]

export default function EditorCodigo({
  valor,
  onCambio,
  lenguaje,
  letra = 14,
  alto = '320px',
  soloLectura = false,
  onEjecutar,
  etiqueta = 'Editor de código',
  basePyodide,
  oscuro = false,
  teclas = false,
  ajustar = false
}: {
  valor: string
  onCambio?: (v: string) => void
  lenguaje: Lenguaje
  letra?: number
  alto?: string
  soloLectura?: boolean
  /** ⌘/Ctrl + Enter */
  onEjecutar?: () => void
  etiqueta?: string
  /** Para el autocompletado de Python (Jedi corre con el mismo Pyodide) */
  basePyodide?: string
  /** Tema oscuro tipo VS Code */
  oscuro?: boolean
  /** Barra con Tab, : ( ) [ ] = # para el teclado del celular (que no tiene Tab y esconde los símbolos) */
  teclas?: boolean
  /** Las líneas largas bajan al siguiente renglón en vez de salirse del editor */
  ajustar?: boolean
}): JSX.Element {
  const caja = useRef<HTMLDivElement>(null)
  const vista = useRef<EditorView | null>(null)
  const lengC = useRef(new Compartment())
  const temaC = useRef(new Compartment())
  const lecturaC = useRef(new Compartment())
  const ajusteC = useRef(new Compartment())
  // Las funciones cambian en cada render: el editor siempre llama a la última
  const cambio = useRef(onCambio)
  const ejecutar = useRef(onEjecutar)
  cambio.current = onCambio
  ejecutar.current = onEjecutar

  useEffect(() => {
    const v = new EditorView({
      parent: caja.current!,
      state: EditorState.create({
        doc: valor,
        extensions: [
          basicSetup,
          keymap.of([{ key: 'Mod-Enter', run: () => (ejecutar.current?.(), true) }, indentWithTab]),
          indentUnit.of('    '),
          lengC.current.of(sintaxis(lenguaje, basePyodide)),
          temaC.current.of(tema(letra, alto, oscuro)),
          lecturaC.current.of(EditorState.readOnly.of(soloLectura)),
          ajusteC.current.of(ajustar ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({ 'aria-label': etiqueta, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cambio.current?.(u.state.doc.toString())
          })
        ]
      })
    })
    vista.current = v
    return () => v.destroy()
    // El editor se crea una vez; lo demás se actualiza abajo sin perder el cursor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    vista.current?.dispatch({ effects: lengC.current.reconfigure(sintaxis(lenguaje, basePyodide)) })
  }, [lenguaje, basePyodide])
  useEffect(() => {
    vista.current?.dispatch({ effects: temaC.current.reconfigure(tema(letra, alto, oscuro)) })
  }, [letra, alto, oscuro])
  useEffect(() => {
    vista.current?.dispatch({ effects: lecturaC.current.reconfigure(EditorState.readOnly.of(soloLectura)) })
  }, [soloLectura])
  useEffect(() => {
    vista.current?.dispatch({ effects: ajusteC.current.reconfigure(ajustar ? EditorView.lineWrapping : []) })
  }, [ajustar])
  // Si el texto cambia por fuera (otro archivo, otra pregunta), se reemplaza
  useEffect(() => {
    const v = vista.current
    if (v && v.state.doc.toString() !== valor) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: valor } })
  }, [valor])

  // Cada tecla de la barra actúa sobre el editor sin quitarle el foco (onPointerDown + preventDefault)
  const tecla = (accion: (v: EditorView) => void) => (e: React.PointerEvent) => {
    e.preventDefault()
    const v = vista.current
    if (v) accion(v)
  }
  const escribir = (texto: string, retroceso = 0) => (v: EditorView) => {
    const { from, to } = v.state.selection.main
    v.dispatch({ changes: { from, to, insert: texto }, selection: { anchor: from + texto.length - retroceso }, userEvent: 'input.type' })
  }
  const TECLAS: { t: string; e: string; a: (v: EditorView) => void }[] = [
    { t: '⇥', e: 'Sangrar', a: (v) => void indentMore(v) },
    { t: '⇤', e: 'Quitar sangría', a: (v) => void indentLess(v) },
    { t: ':', e: 'Dos puntos', a: escribir(':') },
    { t: '( )', e: 'Paréntesis', a: escribir('()', 1) },
    { t: '[ ]', e: 'Corchetes', a: escribir('[]', 1) },
    { t: '=', e: 'Igual', a: escribir(' = ') },
    { t: '"', e: 'Comillas', a: escribir('""', 1) },
    { t: '#', e: 'Comentario', a: escribir('# ') },
    { t: '↶', e: 'Deshacer', a: (v) => void undo(v) }
  ]

  return (
    <div className="min-w-0">
      {teclas && !soloLectura && (
        <div className="mb-1 flex gap-1 overflow-x-auto pb-0.5" role="toolbar" aria-label="Teclas para programar">
          {TECLAS.map((k) => (
            <button key={k.t} type="button" aria-label={k.e} onPointerDown={tecla(k.a)} className="min-h-[40px] min-w-[44px] shrink-0 rounded-lg border border-ink-200 bg-white px-2 font-mono text-base text-ink-700 active:bg-ink-100">
              {k.t}
            </button>
          ))}
        </div>
      )}
      <div ref={caja} className="rounded-lg border border-ink-200 overflow-hidden min-w-0 [&_.cm-editor]:max-w-full" />
    </div>
  )
}
