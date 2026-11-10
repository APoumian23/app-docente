/**
 * Ayudas tipo VS Code para el editor: autocompletado con documentación, errores subrayados mientras
 * se escribe y ayuda al pasar el cursor. Python usa Jedi + pyflakes (worker propio); JavaScript usa
 * los objetos del propio navegador (Math., Array…) y el árbol de sintaxis para marcar errores.
 */
import { StateField, type Extension } from '@codemirror/state'
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import { hoverTooltip, type EditorView } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { globalCompletion, localCompletionSource } from '@codemirror/lang-python'
import { javascriptLanguage, scopeCompletionSource } from '@codemirror/lang-javascript'
import AyudaWorker from './ayuda-python.worker?worker&inline'
import type { PeticionAyuda } from './ayuda-python.worker'
import type { Lenguaje } from './lenguajes'

type SinId<T> = T extends unknown ? Omit<T, 'id'> : never

/** Un worker de ayudas por dirección de Pyodide, compartido por todos los editores de la pantalla. */
const servicios = new Map<string, (p: SinId<PeticionAyuda>) => Promise<unknown>>()
/** El worker se crea al primer pedido (no al abrir el editor) y, si muere, se rehace en el siguiente. */
function servicio(base: string): (p: SinId<PeticionAyuda>) => Promise<unknown> {
  const hay = servicios.get(base)
  if (hay) return hay
  const w = new AyudaWorker()
  let id = 0
  let primera = true
  const pendientes = new Map<number, { ok: (r: unknown) => void; mal: (e: Error) => void }>()
  // Si el worker muere (p. ej. sin memoria en un celular), nada queda esperando para siempre
  w.onerror = (e) => {
    e.preventDefault()
    for (const p of pendientes.values()) p.mal(new Error('Las ayudas de Python se reiniciaron'))
    pendientes.clear()
    w.terminate()
    servicios.delete(base)
  }
  w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; r?: unknown; error?: string }>) => {
    const p = pendientes.get(e.data.id)
    pendientes.delete(e.data.id)
    if (e.data.ok) p?.ok(e.data.r)
    else p?.mal(new Error(e.data.error))
  }
  const pedir = (p: SinId<PeticionAyuda>): Promise<unknown> =>
    new Promise((ok, mal) => {
      const n = ++id
      pendientes.set(n, { ok, mal })
      w.postMessage({ ...p, id: n, ...(primera ? { base: new URL(base, location.href).href } : {}) })
      primera = false
    })
  servicios.set(base, pedir)
  return pedir
}

/** Da formato a un programa de Python (PEP 8 con autopep8, sin internet). Devuelve el código acomodado. */
export async function formatearPython(codigo: string, base: string): Promise<string> {
  return (await servicio(base)({ tipo: 'formatear', codigo })) as string
}

/** Se vuelve true en cuanto se escribe: hasta entonces no se carga Jedi (abrir un editor no cuesta nada). */
const editado = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => v || tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('undo')
})
const yaEditado = (s: EditorView['state']): boolean => s.field(editado, false) ?? false

const TIPO: Record<string, string> = { module: 'namespace', class: 'class', instance: 'variable', function: 'function', param: 'variable', keyword: 'keyword', property: 'property', statement: 'variable', path: 'text' }

function posJedi(view: { state: EditorView['state'] }, pos: number): { linea: number; columna: number } {
  const l = view.state.doc.lineAt(pos)
  return { linea: l.number, columna: pos - l.from }
}

function caja(titulo: string, cuerpo: string): HTMLElement {
  const d = document.createElement('div')
  d.className = 'cm-ayuda'
  const t = document.createElement('div')
  t.className = 'cm-ayuda-firma'
  t.textContent = titulo
  d.append(t)
  // Jedi repite la firma al inicio de la documentación: se quita para no verla dos veces
  const primera = titulo.split('(')[0]
  cuerpo = cuerpo.split('\n').filter((l, i, ls) => !(l.startsWith(primera + '(') && ls.slice(0, i).every((x) => x.startsWith(primera + '(')))).join('\n').trim()
  if (cuerpo) {
    const c = document.createElement('div')
    c.className = 'cm-ayuda-doc'
    c.textContent = cuerpo
    d.append(c)
  }
  return d
}

function ayudasPython(base: string): Extension[] {
  const pedir = servicio(base)
  const respaldo = async (ctx: CompletionContext): Promise<CompletionResult | null> => (await globalCompletion(ctx)) ?? localCompletionSource(ctx)

  const completar = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const antes = ctx.matchBefore(/[\w.]*/)
    // Se abre al escribir una palabra o un punto (math.), o con Ctrl+Espacio
    if (!ctx.explicit && (!antes || antes.from === antes.to)) return null
    const { linea, columna } = posJedi(ctx, ctx.pos)
    try {
      const r = (await pedir({ tipo: 'completar', codigo: ctx.state.doc.toString(), linea, columna })) as { n: string; t: string; d: string; doc: string }[]
      if (ctx.aborted) return null
      const desde = ctx.matchBefore(/\w*/)?.from ?? ctx.pos
      const opciones: Completion[] = r.map((c, i) => ({
        label: c.n,
        type: TIPO[c.t] ?? 'variable',
        detail: c.d ? c.d.replace(/^\w+/, '') : undefined,
        info: c.doc || c.d ? () => caja(c.d || c.n, c.doc) : undefined,
        boost: -i / 1000
      }))
      return { from: desde, options: opciones, validFor: /^\w*$/ }
    } catch (e) {
      // Mientras Jedi carga (o si fallara) siguen las sugerencias básicas
      console.warn('[ayudas de Python]', (e as Error).message)
      return respaldo(ctx)
    }
  }

  const diagnosticar = async (view: EditorView): Promise<Diagnostic[]> => {
    const codigo = view.state.doc.toString()
    if (!codigo.trim() || !yaEditado(view.state)) return []
    try {
      const r = (await pedir({ tipo: 'diagnosticar', codigo })) as { l: number; c: number; s: 'error' | 'warning'; m: string }[]
      const doc = view.state.doc
      if (doc.toString() !== codigo) return []
      return r.map((d) => {
        const l = doc.line(Math.min(Math.max(1, d.l), doc.lines))
        const desde = l.from + Math.min(d.c, l.length)
        const palabra = /^\w+/.exec(l.text.slice(desde - l.from))?.[0].length ?? 0
        return { from: desde, to: palabra ? desde + palabra : Math.max(desde, l.to), severity: d.s, message: d.m }
      })
    } catch {
      return []
    }
  }

  const alPasar = hoverTooltip(async (view, pos) => {
    if (!yaEditado(view.state)) return null
    const { linea, columna } = posJedi(view, pos)
    try {
      const r = (await pedir({ tipo: 'ayuda', codigo: view.state.doc.toString(), linea, columna })) as { firma: string; doc: string } | null
      if (!r) return null
      return { pos, above: true, create: () => ({ dom: caja(r.firma, r.doc) }) }
    } catch {
      return null
    }
  })

  return [editado, autocompletion({ override: [completar], activateOnTypingDelay: 120 }), linter(diagnosticar, { delay: 700, needsRefresh: (u) => u.docChanged }), alPasar]
}

/** JavaScript: completa lo que existe en el navegador (Math., JSON., console.…) y marca errores de sintaxis. */
function ayudasJs(): Extension[] {
  const errores = linter((view) => {
    const fuera: Diagnostic[] = []
    syntaxTree(view.state).iterate({
      enter: (n) => {
        if (n.type.isError && fuera.length < 20) fuera.push({ from: n.from, to: Math.max(n.to, n.from + 1), severity: 'error', message: 'Error de sintaxis' })
      }
    })
    return fuera
  })
  return [javascriptLanguage.data.of({ autocomplete: scopeCompletionSource(globalThis) }), errores]
}

export function extensionesAyuda(lenguaje: Lenguaje, basePyodide?: string): Extension[] {
  if (lenguaje === 'python') return basePyodide ? ayudasPython(basePyodide) : []
  return ayudasJs()
}
