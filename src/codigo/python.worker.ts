/// <reference lib="webworker" />
/**
 * Python (Pyodide) en un worker clásico. Pyodide se carga una sola vez y se reusa; cada ejecución
 * usa un espacio de nombres nuevo para que no se arrastren variables de la anterior, salvo las de una
 * misma «sesión» (las celdas de un cuaderno comparten variables, como en Jupyter).
 * Los archivos de Pyodide vienen de `base` (docente://pyodide/ en la app, /pyodide/ en el portal),
 * así funciona sin internet. Los paquetes (numpy, matplotlib…) solo si ya se descargaron.
 */
import type { ALWorker, DelWorker } from './mensajes'

declare const self: DedicatedWorkerGlobalScope

interface PyProxy { destroy: () => void; set: (k: string, v: unknown) => void }
interface Pyodide {
  runPythonAsync: (codigo: string, o?: { globals?: PyProxy }) => Promise<unknown>
  runPython: (codigo: string, o?: { globals?: PyProxy }) => unknown
  loadPackagesFromImports: (codigo: string, o?: Record<string, unknown>) => Promise<unknown>
  setStdout: (o: { write: (b: Uint8Array) => number }) => void
  setStderr: (o: { write: (b: Uint8Array) => number }) => void
  setStdin: (o: { stdin: () => string | null | undefined }) => void
  globals: { get: (k: string) => () => PyProxy }
}

const enviar = (m: DelWorker): void => self.postMessage(m)
let py: Promise<Pyodide> | null = null
let entrada: string[] = []
/** Variables de cada sesión de cuaderno */
const sesiones = new Map<string, PyProxy>()

function cargar(base: string): Promise<Pyodide> {
  if (py) return py
  py = (async () => {
    enviar({ tipo: 'cargando', texto: 'Preparando Python (solo la primera vez)…' })
    // import() sirve igual si el worker es módulo (desarrollo) o clásico (empaquetado)
    const { loadPyodide } = (await import(/* @vite-ignore */ base + 'pyodide.mjs')) as { loadPyodide: (o: Record<string, unknown>) => Promise<Pyodide> }
    const p = await loadPyodide({ indexURL: base, fullStdLib: false })
    // Sin esperar el salto de línea: «Número: » de input() sale antes de leer el dato
    const salida = new TextDecoder()
    const errores = new TextDecoder()
    p.setStdout({ write: (b) => (enviar({ tipo: 'salida', texto: salida.decode(b, { stream: true }) }), b.length) })
    p.setStderr({ write: (b) => (enviar({ tipo: 'error', texto: errores.decode(b, { stream: true }) }), b.length) })
    // input() lee de lo que el usuario escribió en «Datos de entrada», línea por línea
    p.setStdin({
      stdin: () => {
        const linea = entrada.shift()
        if (linea === undefined) return null
        enviar({ tipo: 'entrada', texto: linea + '\n' })
        return linea
      }
    })
    // matplotlib sin ventana: las figuras se mandan como imagen al terminar, y plt.show() no avisa nada
    p.runPython("import os, warnings\nos.environ['MPLBACKEND'] = 'AGG'\nwarnings.filterwarnings('ignore', message='.*non-interactive.*')")
    return p
  })()
  py.catch(() => (py = null))
  return py
}

/** Quita del traceback las líneas internas de Pyodide: el alumno solo ve su código. */
function limpiarTraceback(t: string): string {
  const lineas = t.split('\n')
  const fuera: string[] = []
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i]
    // Renglones de Pyodide que Python 3.13 resume («...<10 lines>...») o que son de su propia llamada
    if (/^\s+\.\.\.<\d+ lines?>\.\.\.$/.test(l) || /\.run_async\(globals, locals\)/.test(l)) continue
    if (/^\s+File "\/(lib|home\/pyodide)\//.test(l)) {
      // salta también la línea de código que sigue al «File …» interno
      if (lineas[i + 1]?.startsWith('    ')) i++
      continue
    }
    fuera.push(l.replace(/File "<exec>"/g, 'Tu código'))
  }
  return fuera.join('\n').trim() + '\n'
}

/** Mensajes de Pyodide que no le dicen nada al alumno, traducidos. */
function explicar(msg: string, paquetes: boolean): string {
  if (/EOFError/.test(msg)) return 'input() ya no tiene datos: escríbelos en «Datos de entrada», uno por línea.\n'
  const falta = /No module named '([\w.]+)'[\s\S]*included in the Pyodide distribution/.exec(msg)
  if (falta)
    return paquetes
      ? `Falta el paquete «${falta[1]}»: descárgalo en la app de escritorio (Programar › Paquetes de Python) y vuelve a ejecutar.\n`
      : `En esta actividad no se pueden usar paquetes externos («${falta[1]}»): resuélvelo con Python puro.\n`
  if (/Maximum call stack size exceeded|RecursionError/.test(msg))
    return limpiarTraceback(msg) + '\nLa recursión es demasiado profunda: revisa el caso base o usa una versión iterativa.\n'
  return limpiarTraceback(msg)
}

self.onmessage = async (e: MessageEvent<ALWorker>) => {
  const m = e.data
  // Al abrir el editor se carga Python de una vez: cuando el alumno pulse «Ejecutar» ya está listo
  if (m.tipo === 'precargar') return void cargar(m.base).catch(() => undefined)
  if (m.tipo === 'olvidar') {
    try {
      sesiones.get(m.sesion)?.destroy()
    } catch {
      /* ya no servía */
    }
    return void sesiones.delete(m.sesion)
  }
  if (m.tipo !== 'ejecutar') return
  const paquetes = m.paquetes !== false
  entrada = [...m.entrada]
  let p: Pyodide
  try {
    p = await cargar(m.base)
  } catch (err) {
    enviar({ tipo: 'error', texto: `No se pudo cargar Python: ${(err as Error).message}\n` })
    return enviar({ tipo: 'fin', ok: false })
  }
  let ns = m.sesion ? sesiones.get(m.sesion) : undefined
  if (!ns) {
    ns = p.globals.get('dict')()
    ns.set('__name__', '__main__')
    if (m.sesion) sesiones.set(m.sesion, ns)
  }
  try {
    if (paquetes) {
      // Pyodide no siempre lanza el error de un paquete que no se pudo bajar: se juntan y se revisan
      const fallas: string[] = []
      try {
        await p.loadPackagesFromImports(m.codigo, { messageCallback: (t: string) => enviar({ tipo: 'cargando', texto: t }), errorCallback: (t: string) => fallas.push(t) })
      } catch (err) {
        fallas.push((err as Error).message)
      }
      if (fallas.length) {
        const nombre = fallas.map((f) => /(?:package|paquete)\s+["'«]?([\w-]+)/i.exec(f)?.[1] ?? /\/([\w-]+)-[\d.]+[^/]*\.whl/.exec(f)?.[1]).find(Boolean)
        enviar({ tipo: 'error', texto: `Falta el paquete${nombre ? ` «${nombre}»` : ''}: descárgalo en la app de escritorio (Programar › Paquetes de Python) y vuelve a ejecutar.\n` })
        return enviar({ tipo: 'fin', ok: false })
      }
    }
    enviar({ tipo: 'listo' })
    const resultado = await p.runPythonAsync(m.codigo, { globals: ns })
    // En un cuaderno, como en Jupyter, se muestra el valor de la última línea (si no es None)
    if (m.sesion && resultado !== undefined && resultado !== null) {
      const texto = typeof resultado === 'string' ? `'${resultado}'` : String(resultado)
      enviar({ tipo: 'salida', texto: texto + '\n' })
      ;(resultado as { destroy?: () => void }).destroy?.()
    }
    // Figuras de matplotlib que quedaron abiertas → imágenes
    const pngs = p.runPython(
      `import sys
_r = []
if 'matplotlib.pyplot' in sys.modules:
    import io, base64, warnings
    import matplotlib.pyplot as _plt
    # Los avisos de matplotlib al guardar la figura son de esta conversión, no del programa del alumno
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        for _n in _plt.get_fignums():
            _b = io.BytesIO()
            _plt.figure(_n).savefig(_b, format='png', dpi=110, bbox_inches='tight')
            _r.append(base64.b64encode(_b.getvalue()).decode())
    _plt.close('all')
'\\n'.join(_r)`,
      { globals: ns }
    ) as string
    for (const png of pngs ? pngs.split('\n') : []) enviar({ tipo: 'imagen', png })
    enviar({ tipo: 'fin', ok: true })
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    enviar({ tipo: 'error', texto: explicar(msg, paquetes) })
    // Tras un error fatal (pila desbordada) Pyodide ya no sirve: la página crea otro worker
    const fatal = /fatal error|fatally failed|Maximum call stack size exceeded/i.test(msg)
    if (fatal) {
      py = null
      sesiones.clear()
    }
    enviar({ tipo: 'fin', ok: false, ...(fatal ? { reiniciar: true } : {}) })
  } finally {
    // Las variables de una sesión se quedan para la siguiente celda
    if (!m.sesion) {
      try {
        ns.destroy()
      } catch {
        /* Pyodide pudo quedar inservible */
      }
    }
  }
}
