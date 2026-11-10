/**
 * Cliente de NVIDIA NIM (build.nvidia.com). La API es compatible con la de OpenAI,
 * así que basta con fetch: no hace falta otro SDK.
 */
const BASE = 'https://integrate.api.nvidia.com/v1'

/**
 * Qué modo de salida estructurada aceptó cada modelo. Sin esto, un modelo que no
 * soporta `guided_json` paga dos peticiones fallidas en cada generación.
 */
const modoConocido = new Map<string, 'guided' | 'json' | 'libre'>()

export const MODELO_POR_DEFECTO = 'nvidia/nemotron-3-super-120b-a12b'

/** Notas para los modelos que conviene sugerir primero. El catálogo real se consulta en vivo. */
const RECOMENDADOS: Record<string, { nombre: string; nota: string }> = {
  'nvidia/nemotron-3-super-120b-a12b': { nombre: 'Nemotron 3 Super 120B', nota: 'Equilibrado. Buena opción por defecto.' },
  'deepseek-ai/deepseek-v4-pro-0813': { nombre: 'DeepSeek V4 Pro', nota: 'Razona paso a paso; el mejor para matemáticas.' },
  'nvidia/nemotron-nano-3-30b-a3b': { nombre: 'Nemotron Nano 3 30B', nota: 'Rápido y barato, para exámenes cortos.' },
  'mistralai/mistral-large-2-instruct': { nombre: 'Mistral Large 2', nota: 'Sólido en español y texto largo.' },
  'google/gemma-4-31b-it': { nombre: 'Gemma 4 31B', nota: 'Alternativa ligera de Google.' },
  'moonshotai/kimi-k3': { nombre: 'Kimi K3', nota: 'Contexto muy largo, útil con muchos materiales.' },
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': { nombre: 'Nemotron Ultra 253B', nota: 'El más grande; lento pero muy capaz.' }
}

const NO_CHAT = /embed|rerank|guard|safety|parse|ocr|reward|clip|diffusion|vision|kosmos|deplot|fuyu|detector|retriev/i

export interface ModeloNvidia { id: string; nombre: string; nota: string; recomendado: boolean }

/** Catálogo vigente de build.nvidia.com. Los modelos se retiran seguido, así que no se cablea una lista fija. */
export async function listarModelos(): Promise<ModeloNvidia[]> {
  try {
    const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(String(r.status))
    const datos = (await r.json()) as { data?: { id: string }[] }
    const ids = (datos.data ?? []).map((m) => m.id).filter((id) => !NO_CHAT.test(id))
    const lista = ids.map((id) => ({
      id,
      nombre: RECOMENDADOS[id]?.nombre ?? id.split('/').pop() ?? id,
      nota: RECOMENDADOS[id]?.nota ?? '',
      recomendado: id in RECOMENDADOS
    }))
    lista.sort((a, b) => (a.recomendado === b.recomendado ? a.nombre.localeCompare(b.nombre) : a.recomendado ? -1 : 1))
    return lista
  } catch {
    // Sin internet se ofrecen al menos los recomendados
    return Object.entries(RECOMENDADOS).map(([id, v]) => ({ id, ...v, recomendado: true }))
  }
}

interface Peticion {
  apiKey: string
  modelo: string
  system: string
  user: string
  maxTokens?: number
  /** JSON Schema para forzar la forma de la respuesta. */
  esquema?: Record<string, unknown>
}

async function pedir(p: Peticion, modo: 'guided' | 'json' | 'libre'): Promise<Response> {
  const cuerpo: Record<string, unknown> = {
    model: p.modelo,
    messages: [
      { role: 'system', content: p.system },
      { role: 'user', content: p.user }
    ],
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: p.maxTokens ?? 8192,
    stream: false
  }
  if (p.esquema && modo === 'guided') cuerpo.nvext = { guided_json: p.esquema }
  if (p.esquema && modo === 'json') cuerpo.response_format = { type: 'json_object' }

  // Sin límite, una conexión colgada dejaba la pantalla en «Generando…» para siempre
  return fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(LIMITE_MS)
  }).catch((e: Error) => {
    if (e.name === 'TimeoutError') throw new Error(`NVIDIA no respondió en ${LIMITE_MS / 60_000} minutos. Intenta de nuevo o elige un modelo más rápido en Ajustes.`)
    throw e
  })
}

const LIMITE_MS = 5 * 60_000

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 503 y 429 son del lado de NVIDIA y suelen pasarse solos; conviene reintentar antes de rendirse. */
const TRANSITORIO = [429, 500, 502, 503, 504]
const ESPERAS = [2000, 5000, 12000]

function mensajeDeError(estado: number, texto: string): string {
  if (estado === 401 || estado === 403) return 'La API key de NVIDIA no es válida o no tiene acceso a ese modelo. Revísala en Ajustes.'
  if (estado === 404) return 'Ese modelo no existe en build.nvidia.com o cambió de nombre. Elige otro en Ajustes.'
  if (estado === 410) return 'NVIDIA retiró ese modelo. Elige otro en Ajustes: la lista se consulta en vivo, así que ya no aparecerá.'
  if (estado === 429) return 'NVIDIA está limitando las peticiones (créditos agotados o demasiadas seguidas). Se reintentó sin éxito; espera unos minutos.'
  if (estado === 503 || estado === 502 || estado === 504) return 'El servicio de NVIDIA está saturado en este momento. Se reintentó tres veces sin éxito: espera unos minutos o cambia de modelo en Ajustes, los más pedidos se saturan más.'
  const detalle = texto.slice(0, 300).replace(/\s+/g, ' ')
  return `NVIDIA respondió ${estado}: ${detalle}`
}

/** Devuelve el texto de la respuesta. Si se pide esquema, intenta con salida guiada. */
export async function completar(p: Peticion): Promise<string> {
  if (!p.apiKey) throw new Error('Falta la API key de NVIDIA. Pégala en Ajustes y vuelve a probar.')
  const recordado = modoConocido.get(p.modelo)
  const modos: ('guided' | 'json' | 'libre')[] = !p.esquema
    ? ['libre']
    : recordado
      ? [recordado, ...(['guided', 'json', 'libre'] as const).filter((m) => m !== recordado)]
      : ['guided', 'json', 'libre']
  let ultimo = ''
  for (const modo of modos) {
    let r = await pedir(p, modo)
    // El servicio se satura seguido: se reintenta con esperas crecientes antes de dar error
    for (let intento = 0; intento < ESPERAS.length && TRANSITORIO.includes(r.status); intento++) {
      await esperar(ESPERAS[intento])
      r = await pedir(p, modo)
    }
    if (r.ok) {
      const datos = (await r.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] }
      const c = datos.choices?.[0]?.message
      const texto = (c?.content ?? '').trim()
      if (texto) {
        if (p.esquema) modoConocido.set(p.modelo, modo)
        return texto
      }
      // Algunos modelos de razonamiento devuelven todo en reasoning_content
      if (c?.reasoning_content) return c.reasoning_content.trim()
      throw new Error('NVIDIA devolvió una respuesta vacía.')
    }
    ultimo = mensajeDeError(r.status, await r.text())
    // Si el modelo no acepta la salida guiada, se prueba el siguiente modo; los demás errores se propagan
    if (r.status !== 400 && r.status !== 422) throw new Error(ultimo)
  }
  throw new Error(ultimo || 'No se pudo obtener respuesta de NVIDIA.')
}

/**
 * Extrae el primer objeto JSON de una respuesta que puede venir con texto alrededor
 * o dentro de un bloque de código.
 */
export function extraerJson(texto: string): unknown {
  const limpio = texto.trim()
  const bloque = limpio.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidatos = [bloque?.[1], limpio].filter(Boolean) as string[]
  for (const c of candidatos) {
    const t = c.trim()
    try {
      return JSON.parse(t)
    } catch {
      const ini = t.indexOf('{')
      const fin = t.lastIndexOf('}')
      if (ini >= 0 && fin > ini) {
        try {
          return JSON.parse(t.slice(ini, fin + 1))
        } catch {
          /* sigue con el siguiente candidato */
        }
      }
    }
  }
  throw new Error('El modelo no devolvió un JSON válido. Prueba con otro modelo en Ajustes.')
}

/** Comprueba que la llave sirve y que el modelo responde. */
export async function probar(apiKey: string, modelo: string): Promise<string> {
  const t = await completar({ apiKey, modelo, system: 'Responde en español, brevísimo.', user: 'Di "listo" y nada más.', maxTokens: 20 })
  return t.slice(0, 80)
}
