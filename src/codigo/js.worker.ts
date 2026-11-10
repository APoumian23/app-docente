/// <reference lib="webworker" />
/**
 * JavaScript en un worker: sin DOM, sin la API de la app y sin red útil. console.* va a la consola
 * del editor y prompt() lee de «Datos de entrada». El código del alumno se carga como un módulo (blob)
 * dentro de una función async: funciona `await`, los números de línea coinciden y corre en modo
 * estricto (una variable sin let/const da error, como conviene al aprender).
 */
import type { ALWorker, DelWorker } from './mensajes'

declare const self: DedicatedWorkerGlobalScope & Record<string, unknown>
const enviar = (m: DelWorker): void => self.postMessage(m)

function mostrar(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    const t = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x))
    return t === undefined ? String(v) : t
  } catch {
    return String(v)
  }
}
const linea = (args: unknown[]): string => args.map(mostrar).join(' ') + '\n'

/** «blob:…:12:5» → «línea 12»: el alumno solo ve su código. */
const lineaDe = (e: unknown): string => {
  const m = /blob:[^\s)]*:(\d+):\d+/.exec((e as Error)?.stack ?? '')
  return m ? ` (línea ${m[1]})` : ''
}

self.onmessage = (e: MessageEvent<ALWorker>) => {
  const m = e.data
  if (m.tipo !== 'ejecutar') return
  const entrada = [...m.entrada]
  const consola = {
    log: (...a: unknown[]) => enviar({ tipo: 'salida', texto: linea(a) }),
    info: (...a: unknown[]) => enviar({ tipo: 'salida', texto: linea(a) }),
    warn: (...a: unknown[]) => enviar({ tipo: 'error', texto: linea(a) }),
    error: (...a: unknown[]) => enviar({ tipo: 'error', texto: linea(a) }),
    table: (t: unknown) => enviar({ tipo: 'salida', texto: Array.isArray(t) ? t.map((x, i) => `${i}\t${mostrar(x)}`).join('\n') + '\n' : linea([t]) })
  }
  Object.assign(console, consola)
  self.prompt = (pregunta?: string): string | null => {
    if (pregunta) enviar({ tipo: 'salida', texto: pregunta })
    const v = entrada.shift()
    if (v === undefined) {
      enviar({ tipo: 'error', texto: '\nprompt() ya no tiene datos: escríbelos en «Datos de entrada», uno por línea.\n' })
      return null
    }
    enviar({ tipo: 'entrada', texto: v + '\n' })
    return v
  }
  self.__fin = () => enviar({ tipo: 'fin', ok: true })
  self.__falla = (err: unknown) => {
    const pista = err instanceof ReferenceError && /is not defined/.test(err.message) ? '\n(¿Te faltó declararla con let o const?)' : ''
    enviar({ tipo: 'error', texto: `${mostrar(err)}${lineaDe(err)}${pista}\n` })
    enviar({ tipo: 'fin', ok: false })
  }
  // El código va en la misma primera línea que el envoltorio: los números de línea no se corren
  const fuente = `(async () => {${m.codigo}\n})().then(() => self.__fin(), (e) => self.__falla(e))`
  enviar({ tipo: 'listo' })
  const url = URL.createObjectURL(new Blob([fuente], { type: 'text/javascript' }))
  import(/* @vite-ignore */ url)
    .catch((err) => {
      // Error de sintaxis: el código ni siquiera arrancó
      enviar({ tipo: 'error', texto: `${mostrar(err)}${lineaDe(err)}\n` })
      enviar({ tipo: 'fin', ok: false })
    })
    .finally(() => URL.revokeObjectURL(url))
}
