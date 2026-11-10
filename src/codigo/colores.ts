/**
 * Colores del código como en VS Code (Light+ y Dark+): cada cosa con su color para leer el programa de un
 * vistazo (palabras clave, funciones, clases, cadenas, números, comentarios…), paréntesis de colores por
 * nivel y los docstrings (texto suelto entre """ """) con color de comentario, porque explican, no calculan.
 * Además, como las extensiones de VS Code: sangría de colores por nivel (indent-rainbow) y el error escrito
 * al final de su línea (Error Lens).
 */
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { forEachDiagnostic, setDiagnosticsEffect } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'

interface Paleta {
  control: string
  clave: string
  funcion: string
  variable: string
  propiedad: string
  tipo: string
  cadena: string
  numero: string
  comentario: string
  operador: string
  constante: string
  regex: string
  parentesis: [string, string, string]
}

const CLARO: Paleta = {
  control: '#af00db',
  clave: '#0000ff',
  funcion: '#795e26',
  variable: '#001080',
  propiedad: '#001080',
  tipo: '#267f99',
  cadena: '#a31515',
  numero: '#098658',
  comentario: '#008000',
  operador: '#383a42',
  constante: '#0000ff',
  regex: '#811f3f',
  parentesis: ['#0431fa', '#319331', '#7b3814']
}

const OSCURO: Paleta = {
  control: '#c586c0',
  clave: '#569cd6',
  funcion: '#dcdcaa',
  variable: '#9cdcfe',
  propiedad: '#9cdcfe',
  tipo: '#4ec9b0',
  cadena: '#ce9178',
  numero: '#b5cea8',
  comentario: '#6a9955',
  operador: '#d4d4d4',
  constante: '#569cd6',
  regex: '#d16969',
  parentesis: ['#ffd700', '#da70d6', '#179fff']
}

const estilo = (p: Paleta): HighlightStyle =>
  HighlightStyle.define([
    { tag: t.controlKeyword, color: p.control },
    { tag: [t.moduleKeyword, t.definitionKeyword, t.keyword, t.operatorKeyword, t.modifier], color: p.clave },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: p.funcion },
    { tag: [t.definition(t.variableName), t.variableName], color: p.variable },
    { tag: [t.propertyName, t.attributeName], color: p.propiedad },
    { tag: [t.className, t.typeName, t.namespace, t.definition(t.className)], color: p.tipo },
    { tag: [t.self, t.bool, t.null, t.atom], color: p.constante },
    { tag: [t.string, t.special(t.string), t.character], color: p.cadena },
    { tag: t.regexp, color: p.regex },
    { tag: [t.number, t.integer, t.float], color: p.numero },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: p.comentario, fontStyle: 'italic' },
    { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator, t.definitionOperator], color: p.operador },
    { tag: t.meta, color: p.funcion },
    { tag: t.invalid, color: '#f44747' }
  ])

const CORCHETES: Record<string, 1 | -1> = { '(': 1, '[': 1, '{': 1, ')': -1, ']': -1, '}': -1 }

/**
 * Paréntesis, corchetes y llaves de colores según qué tan adentro están (tres colores que se repiten), y
 * docstrings marcados aparte. Se recorre el árbol del lenguaje, así que lo que está dentro de una cadena o
 * un comentario no cuenta.
 */
const marcas = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.armar(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = this.armar(u.view)
    }
    armar(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>()
      const hasta = view.viewport.to
      const desde = view.viewport.from
      let nivel = 0
      syntaxTree(view.state).iterate({
        to: hasta,
        enter: (n) => {
          const paso = CORCHETES[n.name]
          if (paso) {
            if (paso === -1) nivel = Math.max(0, nivel - 1)
            if (n.from >= desde) b.add(n.from, n.to, Decoration.mark({ class: `cm-par-${nivel % 3}` }))
            if (paso === 1) nivel++
            return
          }
          // Docstring: una cadena sola como instrucción (lo primero de un archivo, clase o función)
          if (n.name === 'String' && n.node.parent?.name === 'ExpressionStatement' && n.to > desde) {
            b.add(n.from, n.to, Decoration.mark({ class: 'cm-docstring' }))
            return false
          }
          return undefined
        }
      })
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

/** Sangría de colores: cada nivel (4 espacios o un tabulador) con su franja; en Python la sangría es la lógica */
const sangria = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.armar(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = this.armar(u.view)
    }
    armar(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>()
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const linea = view.state.doc.lineAt(pos)
          const blanco = /^[ \t]*/.exec(linea.text)?.[0] ?? ''
          // Las líneas vacías o solo con espacios no se pintan
          if (blanco.length < linea.text.length) {
            let i = 0
            let nivel = 0
            while (i < blanco.length) {
              const largo = blanco[i] === '\t' ? 1 : Math.min(4, blanco.length - i)
              if (blanco[i] !== '\t' && largo < 4) break
              b.add(linea.from + i, linea.from + i + largo, Decoration.mark({ class: `cm-sangria-${nivel % 4}` }))
              i += largo
              nivel++
            }
          }
          pos = linea.to + 1
        }
      }
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

/** El mensaje del error o aviso, en gris al final de su línea */
class MensajeError extends WidgetType {
  constructor(
    readonly texto: string,
    readonly grave: boolean
  ) {
    super()
  }
  eq(o: MensajeError): boolean {
    return o.texto === this.texto && o.grave === this.grave
  }
  toDOM(): HTMLElement {
    const s = document.createElement('span')
    s.className = `cm-error-linea ${this.grave ? 'cm-error-linea-grave' : 'cm-error-linea-aviso'}`
    s.textContent = this.texto
    s.setAttribute('aria-hidden', 'true')
    return s
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** Error Lens: el primer error de cada línea se escribe al final de ella (el subrayado y el detalle siguen igual) */
const erroresEnLinea = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.armar(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnosticsEffect)))) this.decorations = this.armar(u.view)
    }
    armar(view: EditorView): DecorationSet {
      const porLinea = new Map<number, { texto: string; grave: boolean }>()
      forEachDiagnostic(view.state, (d, from) => {
        const linea = view.state.doc.lineAt(Math.min(from, view.state.doc.length))
        const grave = d.severity === 'error'
        const ya = porLinea.get(linea.to)
        // Uno por línea: el error gana al aviso
        if (!ya || (grave && !ya.grave)) porLinea.set(linea.to, { texto: d.message, grave })
      })
      const b = new RangeSetBuilder<Decoration>()
      for (const [pos, m] of [...porLinea.entries()].sort((a, c) => a[0] - c[0])) b.add(pos, pos, Decoration.widget({ widget: new MensajeError(m.texto, m.grave), side: 1 }))
      return b.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

const SANGRIA_CLARO = ['rgba(255, 196, 0, 0.13)', 'rgba(16, 185, 129, 0.11)', 'rgba(217, 70, 239, 0.10)', 'rgba(14, 165, 233, 0.11)']
const SANGRIA_OSCURO = ['rgba(255, 255, 64, 0.07)', 'rgba(127, 255, 127, 0.07)', 'rgba(255, 127, 255, 0.07)', 'rgba(79, 236, 236, 0.07)']

const temaMarcas = (p: Paleta, oscuro: boolean): Extension =>
  EditorView.theme(
    {
      '.cm-par-0': { color: `${p.parentesis[0]} !important` },
      '.cm-par-1': { color: `${p.parentesis[1]} !important` },
      '.cm-par-2': { color: `${p.parentesis[2]} !important` },
      '.cm-docstring, .cm-docstring *': { color: `${p.comentario} !important`, fontStyle: 'italic' },
      ...Object.fromEntries((oscuro ? SANGRIA_OSCURO : SANGRIA_CLARO).map((c, i) => [`.cm-sangria-${i}`, { backgroundColor: c }])),
      '.cm-error-linea': { marginLeft: '2.5em', fontStyle: 'italic', fontSize: '0.88em', whiteSpace: 'pre', pointerEvents: 'none' },
      '.cm-error-linea-grave': { color: oscuro ? '#f48771' : '#d32f2f' },
      '.cm-error-linea-aviso': { color: oscuro ? '#cca700' : '#9a6700' }
    },
    { dark: oscuro }
  )

/** Colores tipo VS Code para el editor (claro u oscuro) */
export function coloresCodigo(oscuro: boolean): Extension {
  const p = oscuro ? OSCURO : CLARO
  return [syntaxHighlighting(estilo(p)), marcas, sangria, erroresEnLinea, temaMarcas(p, oscuro)]
}
