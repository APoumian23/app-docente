/// <reference lib="webworker" />
/**
 * Ayudas del editor para Python, como en VS Code: autocompletado y documentación con Jedi y errores
 * con pyflakes. Corre en su propio worker (con su propio Pyodide) para que se pueda escribir mientras
 * un programa se ejecuta. Jedi, parso y pyflakes vienen con la app: funciona sin internet.
 * «Dar formato» usa autopep8 (PEP 8, también viene con la app) y se carga solo la primera vez que se pide.
 */
declare const self: DedicatedWorkerGlobalScope

export type PeticionAyuda =
  | { id: number; tipo: 'completar'; codigo: string; linea: number; columna: number }
  | { id: number; tipo: 'diagnosticar'; codigo: string }
  | { id: number; tipo: 'ayuda'; codigo: string; linea: number; columna: number }
  | { id: number; tipo: 'formatear'; codigo: string }

interface Pyodide {
  loadPackage: (p: string | string[], o?: Record<string, unknown>) => Promise<unknown>
  loadPackagesFromImports: (codigo: string, o?: Record<string, unknown>) => Promise<unknown>
  runPython: (codigo: string) => unknown
  globals: { get: (k: string) => (...a: unknown[]) => string }
}

let base = ''
let py: Promise<Pyodide> | null = null

const PYTHON = `
import jedi, json
from pyflakes import api as _api, reporter as _rep, messages as _m

jedi.settings.case_insensitive_completion = False

def _doc(c, tope=600):
    try:
        d = c.docstring()
    except Exception:
        d = ''
    return d[:tope] + ('…' if len(d) > tope else '')

def completar(codigo, linea, columna):
    s = jedi.Script(codigo)
    salida = []
    for i, c in enumerate(s.complete(linea, columna)):
        if i >= 150:
            break
        if c.name.startswith('__') and not c.name.endswith('__'):
            continue
        detalle = ''
        if c.type in ('function', 'class') and i < 40:
            try:
                firmas = c.get_signatures()
                if firmas:
                    detalle = firmas[0].to_string()
            except Exception:
                pass
        salida.append({'n': c.name, 't': c.type, 'd': detalle, 'doc': _doc(c) if i < 25 else '', 'p': c.complete or ''})
    return json.dumps(salida)

def ayuda(codigo, linea, columna):
    s = jedi.Script(codigo)
    try:
        nombres = s.help(linea, columna) or s.infer(linea, columna)
    except Exception:
        nombres = []
    for n in nombres:
        firma = ''
        try:
            fs = n.get_signatures()
            if fs:
                firma = fs[0].to_string()
        except Exception:
            pass
        doc = _doc(n, 1200)
        if firma or doc:
            return json.dumps({'firma': firma or n.name, 'doc': doc, 'tipo': n.type})
    return 'null'

_TRAD = {
    _m.UndefinedName: lambda a: f"«{a[0]}» no está definido",
    _m.UnusedImport: lambda a: f"{a[0]} se importa pero no se usa",
    _m.UnusedVariable: lambda a: f"la variable «{a[0]}» se asigna pero no se usa",
    _m.RedefinedWhileUnused: lambda a: f"«{a[0]}» se vuelve a definir sin haberse usado",
    _m.UndefinedLocal: lambda a: f"«{a[0]}» se usa antes de asignarse",
    _m.ImportStarUsed: lambda a: f"«from {a[0]} import *» oculta qué nombres se usan",
    _m.ReturnOutsideFunction: lambda a: "return fuera de una función",
    _m.FStringMissingPlaceholders: lambda a: "f-string sin {…}: no hace falta la f",
    _m.IsLiteral: lambda a: "usa == (no «is») para comparar con un número o texto",
}
_AVISOS = (_m.UnusedImport, _m.UnusedVariable, _m.RedefinedWhileUnused, _m.ImportStarUsed, _m.FStringMissingPlaceholders, _m.IsLiteral)

class _Junta(_rep.Reporter):
    def __init__(self):
        self.lista = []
    def unexpectedError(self, nombre, msg):
        pass
    def syntaxError(self, nombre, msg, linea, col, texto):
        self.lista.append({'l': linea or 1, 'c': max(0, (col or 1) - 1), 's': 'error', 'm': 'Error de sintaxis: ' + str(msg)})
    def flake(self, m):
        f = _TRAD.get(type(m))
        texto = f(m.message_args) if f else (m.message % m.message_args)
        self.lista.append({'l': m.lineno, 'c': m.col, 's': 'warning' if isinstance(m, _AVISOS) else 'error', 'm': texto})

def diagnosticar(codigo):
    r = _Junta()
    try:
        _api.check(codigo, 'tu_codigo.py', r)
    except Exception:
        pass
    return json.dumps(r.lista)
`

function cargar(): Promise<Pyodide> {
  if (py) return py
  py = (async () => {
    const { loadPyodide } = (await import(/* @vite-ignore */ base + 'pyodide.mjs')) as { loadPyodide: (o: Record<string, unknown>) => Promise<Pyodide> }
    const p = await loadPyodide({ indexURL: base, fullStdLib: false })
    await p.loadPackage(['jedi', 'parso', base + 'pyflakes-4.0.3-py2.py3-none-any.whl'], { messageCallback: () => undefined, errorCallback: () => undefined })
    p.runPython(PYTHON)
    return p
  })()
  py.catch(() => (py = null))
  return py
}

/** autopep8 + pycodestyle, la primera vez que se da formato */
let formato: Promise<void> | null = null
function cargarFormato(p: Pyodide): Promise<void> {
  formato ??= (async () => {
    await p.loadPackage([base + 'pycodestyle-2.14.0-py2.py3-none-any.whl', base + 'autopep8-2.3.2-py2.py3-none-any.whl'], { messageCallback: () => undefined, errorCallback: () => undefined })
    p.runPython(`
import autopep8, json
def formatear(codigo):
    # Solo cambios seguros (espacios, sangrías, renglones en blanco): no reescribe la lógica ni mueve los import
    return json.dumps(autopep8.fix_code(codigo, options={'aggressive': 0, 'max_line_length': 100, 'ignore': ['E402', 'E501']}))
`)
  })()
  formato.catch(() => (formato = null))
  return formato
}

/** Si el programa importa un paquete descargado (numpy…), Jedi también lo conoce. */
let importsVistos = ''
async function conImports(p: Pyodide, codigo: string): Promise<void> {
  const imports = (codigo.match(/^\s*(?:import|from)\s+[\w.]+/gm) ?? []).join('|')
  if (imports === importsVistos) return
  importsVistos = imports
  await p.loadPackagesFromImports(codigo, { messageCallback: () => undefined, errorCallback: () => undefined }).catch(() => undefined)
}

self.onmessage = async (e: MessageEvent<PeticionAyuda & { base?: string }>) => {
  const m = e.data
  if (m.base) base = m.base
  try {
    const p = await cargar()
    let r: string
    if (m.tipo === 'completar') {
      await conImports(p, m.codigo)
      r = p.globals.get('completar')(m.codigo, m.linea, m.columna)
    } else if (m.tipo === 'ayuda') r = p.globals.get('ayuda')(m.codigo, m.linea, m.columna)
    else if (m.tipo === 'formatear') {
      await cargarFormato(p)
      r = p.globals.get('formatear')(m.codigo)
    }
    else {
      await conImports(p, m.codigo)
      r = p.globals.get('diagnosticar')(m.codigo)
    }
    self.postMessage({ id: m.id, ok: true, r: JSON.parse(r) })
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err as Error).message })
  }
}
