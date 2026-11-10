import Anthropic from '@anthropic-ai/sdk'
import { SQL_CARRERA_MATERIA } from '../../servidor/base'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { safeStorage } from 'electron'
import { getAjuste, setAjuste, getDb } from '../db'
import type { GeneracionIA, Materia, TipoEvaluacion } from '@shared/types'
import type { ResumenProyeccion } from '@shared/proyeccion'
import type { RevisionIA } from '@shared/copias'
import { datosParaIA } from './metadatos'
import { anonimizador } from './anonimizar'
import { completar as completarNvidia, extraerJson, probar as probarNvidia, MODELO_POR_DEFECTO } from './nvidia'
import { registrarUso } from './uso-ia'

export type Proveedor = 'anthropic' | 'nvidia'
export function proveedor(): Proveedor {
  return getAjuste('proveedor_ia', 'anthropic') === 'nvidia' ? 'nvidia' : 'anthropic'
}

// ---- API keys: cifradas con el llavero de macOS vía safeStorage ----
const CLAVE_DE: Record<Proveedor, string> = { anthropic: 'api_key_enc', nvidia: 'api_key_nvidia_enc' }
const ENTORNO_DE: Record<Proveedor, string> = { anthropic: 'ANTHROPIC_API_KEY', nvidia: 'NVIDIA_API_KEY' }

/** Llaves ya descifradas. Sin esto, macOS pide autorización del llavero en cada generación. */
const cacheLlaves = new Map<Proveedor, string>()

/** Rechaza lo que claramente no es una llave, antes de guardarlo y fallar en cada generación. */
function validarFormato(key: string, p: Proveedor): void {
  if (p === 'nvidia') {
    if (!key.startsWith('nvapi-')) throw new Error('Eso no parece una API key de NVIDIA: debe empezar con "nvapi-".')
    return
  }
  if (key.startsWith('wrkspc_')) throw new Error('Eso es el ID de un workspace, no una API key. Pégalo en el campo "ID del workspace" y en este pega la llave que empieza con "sk-ant-".')
  if (key.startsWith('sk-ant-admin')) throw new Error('Esa es una Admin API key; no sirve para generar. Crea una API key normal en console.anthropic.com → API Keys.')
  if (!key.startsWith('sk-ant-')) throw new Error('Eso no parece una API key de Anthropic: debe empezar con "sk-ant-".')
}

export function guardarApiKey(key: string, p: Proveedor = proveedor()): void {
  const clave = CLAVE_DE[p]
  if (!key) {
    cacheLlaves.delete(p)
    setAjuste(clave, '')
    return
  }
  validarFormato(key, p)
  cacheLlaves.delete(p)
  const enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString('base64') : Buffer.from(key).toString('base64')
  setAjuste(clave, enc)
  setAjuste('api_key_cifrada', safeStorage.isEncryptionAvailable() ? '1' : '0')
}

export function leerApiKey(p: Proveedor = proveedor()): string {
  const enCache = cacheLlaves.get(p)
  if (enCache !== undefined) return enCache
  const enc = getAjuste(CLAVE_DE[p])
  if (!enc) return process.env[ENTORNO_DE[p]] ?? ''
  const buf = Buffer.from(enc, 'base64')
  try {
    const llave = getAjuste('api_key_cifrada') === '1' ? safeStorage.decryptString(buf) : buf.toString('utf8')
    cacheLlaves.set(p, llave)
    llaveroNego.delete(p)
    return llave
  } catch {
    llaveroNego.add(p)
    return ''
  }
}

export function llaveNvidia(): string {
  const llave = leerApiKey('nvidia')
  if (!llave && llaveroNego.has('nvidia')) throw new Error(LLAVERO_NEGO)
  return llave
}

/** Proveedores cuya llave existe pero el llavero de macOS no dejó descifrar (se pulsó «Denegar»). */
const llaveroNego = new Set<Proveedor>()
const LLAVERO_NEGO = 'macOS no autorizó leer la API key guardada en el llavero. Cierra y abre la app y, cuando lo pida, escribe la contraseña de tu Mac y elige «Siempre permitir». Si no, vuelve a pegar la llave en Ajustes.'

export function hayApiKey(p: Proveedor = proveedor()): boolean {
  return leerApiKey(p).length > 0
}

/** Comprueba que la configuración actual responde. */
export async function probarConexion(): Promise<string> {
  if (proveedor() === 'nvidia') return probarNvidia(llaveNvidia(), modelo())
  try {
    // Los modelos actuales siempre piensan antes de responder: con 20 tokens la respuesta salía vacía.
    const r = await cliente().messages.create({
      model: modelo(),
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Di "listo" y nada más.' }]
    })
    registrarUso('prueba', modelo(), 'low', r)
    return r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join(' ').slice(0, 80)
  } catch (e) {
    throw explicarError(e)
  }
}

/** Traduce los errores de configuración de Anthropic a algo que diga qué corregir en Ajustes. */
export function explicarError(e: unknown): unknown {
  if (e instanceof Anthropic.AuthenticationError) return new Error('Anthropic rechazó la API key guardada. Pega una llave válida (empieza con "sk-ant-") de console.anthropic.com → API Keys.')
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('La llave no tiene permiso para ese modelo o su workspace lo bloquea. Revisa los límites del workspace en console.anthropic.com.')
  if (e instanceof Anthropic.NotFoundError) return new Error(`El modelo "${modelo()}" no está disponible para esta llave. Elige otro en Ajustes.`)
  if (e instanceof Anthropic.BadRequestError && /workspace/i.test(e.message)) {
    return new Error(
      getAjuste('workspace_anthropic')
        ? 'Anthropic no aceptó el ID del workspace. Cópialo de nuevo desde console.anthropic.com → Settings → Workspaces (empieza con "wrkspc_").'
        : 'Tu API key no está ligada a un workspace. En Ajustes › IA pega el ID del workspace (console.anthropic.com → Settings → Workspaces, empieza con "wrkspc_") y pulsa Probar conexión.'
    )
  }
  return e
}

export function cliente(): Anthropic {
  const apiKey = leerApiKey()
  if (!apiKey) throw new Error(llaveroNego.has('anthropic') ? LLAVERO_NEGO : 'Falta la API key de Anthropic. Escríbela en Ajustes o cambia el proveedor a NVIDIA.')
  // Las llaves que no nacieron dentro de un workspace exigen indicarlo en cada petición.
  const workspace = getAjuste('workspace_anthropic', '').trim()
  return new Anthropic({ apiKey, ...(workspace ? { defaultHeaders: { 'anthropic-workspace-id': workspace } } : {}) })
}

export const MODELO_CLAUDE_POR_DEFECTO = 'claude-opus-5-5'

/** Modelos de Claude que ya se guardaron en Ajustes y su sucesor actual. */
const SUCESOR_CLAUDE: Record<string, string> = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5'
}

export function modeloClaude(): string {
  const guardado = getAjuste('modelo_ia', MODELO_CLAUDE_POR_DEFECTO) || MODELO_CLAUDE_POR_DEFECTO
  return SUCESOR_CLAUDE[guardado] ?? guardado
}

export function modelo(): string {
  return proveedor() === 'nvidia' ? getAjuste('modelo_nvidia', MODELO_POR_DEFECTO) || MODELO_POR_DEFECTO : modeloClaude()
}

/** Lo rutinario va con un modelo más barato: el costo está en lo que el modelo piensa y escribe, no en lo que lee. */
export const MODELO_RAPIDO_POR_DEFECTO = 'claude-haiku-5-5'

/** Lo elegido en Ajustes: un modelo o 'principal'. Vacío (nunca se eligió) cuenta como el de omisión. */
export function ajusteModeloRapido(): string {
  return getAjuste('modelo_ia_rapido') || MODELO_RAPIDO_POR_DEFECTO
}

/** El modelo con que va lo rutinario ('principal' = el mismo que lo demás, pero con esfuerzo medio). */
export function modeloRapido(): string {
  const v = ajusteModeloRapido()
  return v === 'principal' ? modeloClaude() : v
}

/** Para qué es la petición (se anota en el gasto) y si es rutinaria. */
interface Pedido {
  uso: string
  rapido?: boolean
}

/** Modelo y esfuerzo de Claude: lo rutinario con el modelo rápido a esfuerzo medio; lo demás con el principal a esfuerzo alto. */
function eleccion(p: Pedido): { modelo: string; esfuerzo: 'medium' | 'high' } {
  return p.rapido ? { modelo: modeloRapido(), esfuerzo: 'medium' } : { modelo: modeloClaude(), esfuerzo: 'high' }
}

/** Tareas, ejercicios, cuestionarios, glosario y plan de sesión: piden menos razonamiento que un examen o una clase. */
const TIPOS_RAPIDOS = new Set<TipoEvaluacion>(['tarea', 'ejercicios', 'cuestionario', 'glosario', 'plan_sesion'])

// ---- Esquemas JSON para la salida guiada de NVIDIA (zod no viaja por la API) ----
const JSON_EVALUACION = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    instrucciones: { type: 'string' },
    duracion_min: { type: 'integer' },
    preguntas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['opcion_multiple', 'abierta', 'verdadero_falso', 'problema', 'codigo'] },
          enunciado: { type: 'string' },
          opciones: { type: 'array', items: { type: 'string' } },
          respuesta: { type: 'string' },
          puntos: { type: 'number' },
          explicacion: { type: 'string' }
        },
        required: ['tipo', 'enunciado', 'opciones', 'respuesta', 'puntos', 'explicacion']
      }
    }
  },
  required: ['titulo', 'instrucciones', 'duracion_min', 'preguntas']
}
const JSON_GLOSARIO = {
  type: 'object',
  properties: {
    terminos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { termino: { type: 'string' }, definicion: { type: 'string' }, ejemplo: { type: 'string' } },
        required: ['termino', 'definicion', 'ejemplo']
      }
    }
  },
  required: ['terminos']
}
const JSON_PLAN = {
  type: 'object',
  properties: {
    tema: { type: 'string' },
    objetivo: { type: 'string' },
    actividades: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          tipo: { type: 'string', enum: ['apertura', 'exposicion', 'ejercicio', 'discusion', 'evaluacion', 'receso', 'cierre'] },
          duracion_min: { type: 'integer' },
          descripcion: { type: 'string' }
        },
        required: ['nombre', 'tipo', 'duracion_min', 'descripcion']
      }
    }
  },
  required: ['tema', 'objetivo', 'actividades']
}

/** Pide un JSON que cumpla el esquema, con el proveedor configurado. */
async function generarJson<T>(system: string, user: string, zod: z.ZodType<T>, jsonSchema: Record<string, unknown>, maxTokens: number, pedido: Pedido): Promise<T> {
  if (proveedor() === 'nvidia') {
    const texto = await completarNvidia({
      apiKey: llaveNvidia(),
      modelo: modelo(),
      system: `${system}\n\nResponde ÚNICAMENTE con un objeto JSON válido que cumpla este esquema, sin texto alrededor ni bloques de código:\n${JSON.stringify(jsonSchema)}`,
      user,
      esquema: jsonSchema,
      maxTokens
    })
    const parseado = zod.safeParse(extraerJson(texto))
    if (!parseado.success) throw new Error(`El modelo devolvió un JSON que no cumple lo esperado: ${parseado.error.issues[0]?.message ?? 'estructura inválida'}`)
    return parseado.data
  }
  // `maxTokens` solo acota a NVIDIA. Claude piensa antes de escribir y ese pensamiento cuenta contra
  // max_tokens: con el techo por reactivo los exámenes salían cortados. Con streaming no hay riesgo de timeout.
  const { modelo: m, esfuerzo } = eleccion(pedido)
  const stream = cliente().messages.stream({
    model: m,
    max_tokens: MAX_TOKENS_CLAUDE,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    // Opus 5.5 y Haiku 5.5 bajan a "medium" si no se indica: se dice siempre
    output_config: { format: zodOutputFormat(zod as never), effort: esfuerzo }
  })
  const r = await stream.finalMessage().catch((e) => {
    // Una respuesta cortada también se cobra
    registrarUso(pedido.uso, m, esfuerzo, stream.currentMessage)
    // Un JSON cortado no se puede interpretar: el SDK lo reporta como error de parseo
    if (stream.currentMessage?.stop_reason === 'max_tokens' || (e instanceof Anthropic.AnthropicError && /parse/i.test(e.message))) throw new Error(RESPUESTA_INCOMPLETA)
    throw explicarError(e)
  })
  registrarUso(pedido.uso, m, esfuerzo, r)
  if (r.stop_reason === 'refusal') throw new Error('El modelo declinó la solicitud.')
  if (r.stop_reason === 'max_tokens') throw new Error(RESPUESTA_INCOMPLETA)
  if (!r.parsed_output) throw new Error('No se pudo interpretar la respuesta del modelo.')
  return r.parsed_output as T
}

export const MAX_TOKENS_CLAUDE = 64000
const RESPUESTA_INCOMPLETA = 'La respuesta de Claude salió incompleta por ser demasiado larga. Pide menos reactivos o divide el tema.'

/** Pide texto libre (markdown) con el proveedor configurado. */
async function generarTexto(system: string, user: string, maxTokens: number, pedido: Pedido, conWeb = false): Promise<string> {
  if (proveedor() === 'nvidia') {
    return completarNvidia({ apiKey: llaveNvidia(), modelo: modelo(), system, user, maxTokens })
  }
  const mensajes: Anthropic.MessageParam[] = [{ role: 'user', content: user }]
  const bloques: Anthropic.ContentBlock[] = []
  // La búsqueda web no está en Haiku: con ella va siempre el modelo principal
  const { modelo: m, esfuerzo } = eleccion(conWeb ? { ...pedido, rapido: false } : pedido)
  // Con búsqueda web el servidor puede pausar el turno (pause_turn) a media investigación: se continúa
  for (let vuelta = 0; vuelta < 4; vuelta++) {
    const stream = cliente().messages.stream({
      model: m,
      max_tokens: Math.max(maxTokens, MAX_TOKENS_CLAUDE),
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: mensajes,
      output_config: { effort: esfuerzo },
      ...(conWeb ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }] } : {})
    })
    const msg = await stream.finalMessage().catch((e) => {
      registrarUso(pedido.uso, m, esfuerzo, stream.currentMessage)
      throw explicarError(e)
    })
    registrarUso(pedido.uso, m, esfuerzo, msg)
    if (msg.stop_reason === 'refusal') throw new Error('El modelo declinó la solicitud.')
    if (msg.stop_reason === 'max_tokens') throw new Error(RESPUESTA_INCOMPLETA)
    bloques.push(...msg.content)
    if (msg.stop_reason !== 'pause_turn') break
    mensajes.push({ role: 'assistant', content: msg.content })
  }
  const textos = bloques.filter((b): b is Anthropic.TextBlock => b.type === 'text')
  let texto = textos.map((b) => b.text).join('')
  // Si usó la web pero no listó sus fuentes, se agregan las que citó para que el docente pueda revisarlas
  const citadas = new Map<string, string>()
  for (const b of textos) for (const c of b.citations ?? []) if (c.type === 'web_search_result_location') citadas.set(c.url, c.title ?? c.url)
  if (citadas.size && !/^##\s+Fuentes/m.test(texto)) texto += `\n\n## Fuentes consultadas\n${[...citadas].map(([url, t]) => `- [${t}](${url})`).join('\n')}`
  return texto
}

// ---- Esquemas de salida ----
const PreguntaSchema = z.object({
  tipo: z.enum(['opcion_multiple', 'abierta', 'verdadero_falso', 'problema', 'codigo']),
  enunciado: z.string(),
  opciones: z.array(z.string()),
  respuesta: z.string(),
  puntos: z.number(),
  explicacion: z.string()
})
export const EvaluacionSchema = z.object({
  titulo: z.string(),
  instrucciones: z.string(),
  duracion_min: z.number(),
  preguntas: z.array(PreguntaSchema)
})

const GlosarioSchema = z.object({
  terminos: z.array(z.object({ termino: z.string(), definicion: z.string(), ejemplo: z.string() }))
})

const PlanSesionSchema = z.object({
  tema: z.string(),
  objetivo: z.string(),
  actividades: z.array(
    z.object({
      nombre: z.string(),
      tipo: z.enum(['apertura', 'exposicion', 'ejercicio', 'discusion', 'evaluacion', 'receso', 'cierre']),
      duracion_min: z.number(),
      descripcion: z.string()
    })
  )
})

const TIPOS_JSON: TipoEvaluacion[] = ['diagnostico', 'examen', 'examen_sorpresa', 'examen_oral', 'cuestionario', 'tarea', 'ejercicios']

const NOMBRES: Record<TipoEvaluacion, string> = {
  diagnostico: 'examen diagnóstico de conocimientos previos',
  examen: 'examen parcial',
  examen_sorpresa: 'examen sorpresa corto (quiz de 10-15 minutos)',
  examen_oral: 'examen sorpresa oral para preguntar en voz alta durante la clase',
  cuestionario: 'cuestionario de repaso',
  tarea: 'tarea para entregar',
  ejercicios: 'serie de ejercicios para resolver en clase',
  ejemplos: 'ejemplos resueltos paso a paso',
  glosario: 'glosario de términos',
  material_apoyo: 'material de apoyo (resumen didáctico con recursos recomendados)',
  plan_sesion: 'plan de sesión con actividades cronometradas',
  presentacion: 'presentación en diapositivas',
  clase_completa: 'clase completa lista para impartir',
  apuntes: 'apuntes para el alumno (documento de estudio completo, como un capítulo de libro)'
}

/** Qué tan desarrollado sale un texto. Los alumnos necesitan explicación, no solo los títulos. */
const DETALLE: Record<NonNullable<GeneracionIA['detalle']>, string> = {
  breve: 'Nivel de detalle: BREVE. Lo esencial, claro y correcto, sin relleno.',
  completo:
    'Nivel de detalle: COMPLETO. Explica cada idea en párrafos claros (no solo viñetas ni frases sueltas), de lo intuitivo a lo formal, con al menos un ejemplo por concepto. Escribe para que un alumno que faltó a la clase lo entienda leyendo solo.',
  muy_detallado:
    'Nivel de detalle: MUY DETALLADO, como un libro de texto. Explica cada concepto paso a paso y justifica cada paso, incluye varios ejemplos resueltos (de menor a mayor dificultad), casos especiales, errores comunes y su corrección, e interpretación o aplicación de cada resultado. No resumas: desarrolla.'
}

const norm = (t: string): string => (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * Elige los materiales que de verdad sirven para lo que se pide, en vez de los últimos
 * cargados. Con 40 materiales, mandarlos todos hace la petición lenta y además mete
 * contenido de otras sesiones, que empeora el resultado.
 */
function materialesRelevantes(
  materiaId: number,
  tema: string,
  unidad: string,
  limite = 4,
  presupuesto = 12_000
): { titulo: string; unidad: string; texto: string }[] {
  const mats = getDb()
    .prepare("SELECT titulo, unidad, texto FROM materiales WHERE materia_id = ? AND texto <> ''")
    .all(materiaId) as { titulo: string; unidad: string; texto: string }[]
  const claves = norm(`${tema} ${unidad}`)
    .split(/[^a-z0-9.]+/)
    .filter((p) => p.length > 3 || /^\d+\.\d/.test(p))

  const puntuar = (m: { titulo: string; unidad: string; texto: string }): number => {
    const encabezado = norm(`${m.titulo} ${m.unidad}`)
    const cuerpo = norm(m.texto.slice(0, 6000))
    let p = 0
    for (const k of claves) {
      if (encabezado.includes(k)) p += 10
      else if (cuerpo.includes(k)) p += 3
    }
    // El programa y la planeación aportan poco: el temario ya viaja aparte en el contexto
    if (/programa|plan |plan\b|f-04|planeaci/i.test(m.titulo)) p += 1
    return p
  }

  const ordenados = mats
    .map((m) => ({ m, p: puntuar(m) }))
    .sort((a, b) => b.p - a.p)
    .filter((x, i) => x.p > 0 || i < 2) // si nada coincide, al menos el material general
    .slice(0, limite)
    .map((x) => x.m)

  const salida: typeof mats = []
  let resto = presupuesto
  for (const m of ordenados) {
    if (resto <= 500) break
    const frag = m.texto.slice(0, Math.min(m.texto.length, resto))
    resto -= frag.length
    salida.push({ ...m, texto: frag })
  }
  return salida
}

export function contextoMateria(
  materiaId: number,
  usarMateriales: boolean,
  tema = '',
  unidad = ''
): { materia: Materia; contexto: string } {
  const d = getDb()
  const materia = d
    .prepare(`SELECT m.*, ${SQL_CARRERA_MATERIA} FROM materias m JOIN carreras c ON c.id = m.carrera_id WHERE m.id = ?`)
    .get(materiaId) as Materia
  if (!materia) throw new Error('Materia no encontrada')
  let contexto = `Materia: ${materia.nombre} (${materia.clave})\nCarrera: ${materia.carrera_nombre}\nNivel (semestre/cuatrimestre): ${materia.cuatrimestre}\nDescripción: ${materia.descripcion}\n\nTemario:\n${materia.temario}`
  if (usarMateriales) {
    for (const m of materialesRelevantes(materiaId, tema, unidad)) {
      contexto += `\n\n--- Material: ${m.titulo}${m.unidad ? ` (${m.unidad})` : ''} ---\n${m.texto}`
    }
  }
  return { materia, contexto }
}

const SYSTEM = `Eres un docente experto de nivel superior (universidad tecnológica en México) que diseña material didáctico de alta calidad.
Escribes siempre en español de México, con lenguaje claro y apropiado para estudiantes universitarios.
Para matemáticas usa notación LaTeX entre $...$ (en línea) o $$...$$ (bloque). Para código usa bloques de código markdown con el lenguaje indicado.
Los ejercicios deben ser aplicados al perfil de la carrera cuando sea posible (contextos de ingeniería, industria, software, etc.).
Cuando generes preguntas de opción múltiple incluye 4 opciones con una sola correcta y distractores plausibles. La respuesta debe indicar la opción correcta con su texto.
Cuando el tipo de pregunta no lleve opciones, deja el arreglo de opciones vacío.
Respeta la cantidad de reactivos solicitada y la dificultad indicada.

Rigor (obligatorio en todo lo que generes):
- La base es el temario institucional y los materiales del docente que vienen en el contexto: lo que generes debe corresponder a ese temario.
- Puedes agregar información fuera del temario solo si es necesaria para entender o aplicar el tema. En textos márcala como una cita en markdown que empiece con «**Complemento (fuera del temario):**». Los reactivos de evaluación nunca evalúan contenido fuera del temario.
- No inventes datos, cifras, fechas, citas textuales, autores, referencias bibliográficas, URLs ni versiones de software. Recomienda solo recursos ampliamente conocidos y verificables; si no estás seguro de que algo existe o es exacto, omítelo.
- Definiciones, propiedades y fórmulas deben ser correctas y estándar. Resuelve cada ejemplo y cada clave paso a paso antes de escribirla y comprueba el resultado.
- Si algo depende de una convención o puede variar entre autores, dilo explícitamente. Si hay un punto que el docente debe revisar, márcalo con «**Verificar:**».
- En opción múltiple, la respuesta es la copia textual exacta de la opción correcta (con las mismas mayúsculas y símbolos).`

/** Lo que se guarda como evaluación; una clase completa trae además su cuestionario para jugar en vivo. */
export interface Generado {
  contenido: string
  titulo: string
  puntos: number
  adicionales?: { tipo: TipoEvaluacion; titulo: string; contenido: string; puntos: number }[]
}

export async function generar(req: GeneracionIA): Promise<Generado> {
  const { materia, contexto } = contextoMateria(req.materia_id, req.usar_materiales, req.tema, req.unidad ?? '')
  const nombre = NOMBRES[req.tipo]
  const base = `${contexto}\n\n---\nGenera: ${nombre}.\nTema/unidad: ${req.tema || req.unidad || 'según el temario'}\nDificultad: ${req.dificultad}\nCantidad: ${req.cantidad}\n${req.instrucciones ? `Instrucciones adicionales del docente: ${req.instrucciones}` : ''}`

  if (TIPOS_JSON.includes(req.tipo)) {
    const indicacion =
      req.tipo === 'examen_oral'
        ? `${base}

IMPORTANTE: este examen se aplica EN VOZ ALTA durante la clase, preguntando al azar. Reglas:
- Todas las preguntas de tipo "abierta". Nada de opción múltiple, nada que haya que escribir o dibujar.
- Cada pregunta debe poder contestarse hablando en menos de 30 segundos.
- El enunciado se lee tal cual: frases cortas y autocontenidas. No menciones diagramas, incisos ni "la figura anterior".
- Evita respuestas que exijan cálculo largo; privilegia comprensión, definiciones aplicadas, comparaciones y justificaciones.
- En "respuesta" pon la contestación esperada en una o dos frases, tal como sonaría dicha por un alumno que sí entendió.
- En "explicación" indica qué se acepta como correcto y qué error común NO se debe dar por bueno.
- Ordena las preguntas de menor a mayor dificultad.
- En las instrucciones describe la mecánica: cómo elegir a quién preguntar, cuántos segundos esperar y qué hacer si el alumno no sabe (pasar a otro y volver después).`
        : req.tipo === 'diagnostico'
        ? `${base}

IMPORTANTE: un examen diagnóstico NO evalúa el contenido de esta materia, sino los conocimientos previos que el alumno necesita traer para poder cursarla. Deduce esos antecedentes del temario y de la intención educativa del programa (las materias que anteceden a esta) y evalúa eso.
Reglas:
- Ningún reactivo debe requerir haber tomado ya esta materia.
- Reparte los reactivos entre las áreas de conocimiento previo que hagan falta y dilo en las instrucciones.
- Cada reactivo vale 1 punto y el examen no pondera para la calificación: sirve para saber qué reforzar.
- En la explicación de cada reactivo indica en qué momento del curso se volverá a necesitar ese conocimiento.`
        : base
    // Techo solo para NVIDIA (sus modelos tienen salida más corta); Claude usa MAX_TOKENS_CLAUDE
    const techo = Math.min(16000, 900 + Math.max(1, req.cantidad) * 450)
    const out = await generarJson(SYSTEM, indicacion, EvaluacionSchema, JSON_EVALUACION, techo, { uso: req.tipo, rapido: TIPOS_RAPIDOS.has(req.tipo) })
    const puntos = req.tipo === 'diagnostico' ? 0 : out.preguntas.reduce((s, p) => s + (p.puntos || 0), 0)
    return { contenido: JSON.stringify(out), titulo: out.titulo, puntos }
  }

  if (req.tipo === 'glosario') {
    const out = await generarJson(SYSTEM, base + '\nIncluye definición precisa y un ejemplo concreto por término.', GlosarioSchema, JSON_GLOSARIO, Math.min(16000, 600 + Math.max(1, req.cantidad) * 220), { uso: 'glosario', rapido: true })
    const d = getDb()
    const ins = d.prepare('INSERT INTO glosario (materia_id, termino, definicion, ejemplo) VALUES (?, ?, ?, ?)')
    d.transaction(() => out.terminos.forEach((t) => ins.run(req.materia_id, t.termino, t.definicion, t.ejemplo)))()
    return { contenido: JSON.stringify(out), titulo: `Glosario: ${req.tema || materia.nombre}`, puntos: 0 }
  }

  if (req.tipo === 'plan_sesion') {
    const out = await generarJson(
      SYSTEM,
      base + `\nLa sesión dura ${req.cantidad} minutos en total; la suma de duraciones de las actividades debe ser exactamente ${req.cantidad}. Incluye apertura, exposición, práctica y cierre. Cada actividad con descripción concreta de qué hace el docente y qué hacen los alumnos.`,
      PlanSesionSchema,
      JSON_PLAN,
      16000,
      { uso: 'plan_sesion', rapido: true }
    )
    return { contenido: JSON.stringify(out), titulo: `Plan: ${out.tema}`, puntos: 0 }
  }

  if (req.tipo === 'clase_completa') return generarClaseCompleta(req, base, materia.nombre)

  // Markdown libre: ejemplos, material de apoyo, presentación, apuntes
  const detalle = `\n${DETALLE[req.detalle ?? 'completo']}`
  const extra =
    req.tipo === 'presentacion'
      ? `\nFormato: diapositivas en markdown separadas por una línea que contenga solo "---". Alrededor de ${req.cantidad} diapositivas: si el tema da para más, usa más diapositivas en vez de saturarlas.
Cada diapositiva:
- Inicia con un título "# ".
- Lleva de 3 a 7 viñetas que sean FRASES COMPLETAS que expliquen (no palabras sueltas ni títulos), y cuando ayude, un ejemplo concreto, una fórmula en LaTeX o un fragmento de código corto.
- Termina con una línea que empiece exactamente con "Notas:" seguida de la explicación ampliada que el docente dirá al proyectarla (4 a 8 oraciones, con el razonamiento, un ejemplo adicional y la pregunta que conviene hacer al grupo). Las notas no se proyectan.
Incluye una diapositiva de objetivo, el desarrollo completo del tema (definiciones, propiedades, procedimiento y ejemplos resueltos repartidos en varias diapositivas), una de errores comunes y una de cierre con preguntas de reflexión.`
      : req.tipo === 'ejemplos'
        ? '\nFormato: markdown. Cada ejemplo con: enunciado, planteamiento (qué se pide y qué herramienta se usa y por qué), solución paso a paso explicando el razonamiento de cada paso, resultado, comprobación y una nota didáctica del error común.'
        : req.tipo === 'apuntes'
          ? `\nFormato: markdown. Es un DOCUMENTO DE ESTUDIO para que el alumno lo lea solo, sin el docente: redacción completa y amena en párrafos, no un esquema.
Estructura:
# <título>
## Objetivos de aprendizaje
## Lo que necesitas saber antes (repaso breve de los conocimientos previos, con un ejemplo)
Luego, para CADA subtema que abarque lo pedido (si se pidió una unidad o todo el temario, todos sus temas, en el orden del temario):
## <subtema>
- Explicación desarrollada: idea intuitiva, después la definición formal; propiedades o teoremas con su justificación o demostración cuando corresponda al nivel.
- Al menos 2 ejemplos resueltos paso a paso, explicando por qué se hace cada paso.
- «Cuidado con…»: errores comunes y cómo evitarlos.
- Cuando aplique: cómo hacerlo con Python (código comentado) o con GeoGebra.
## Ejercicios propuestos (${req.cantidad}, de menor a mayor dificultad, con la sección a la que corresponde cada uno)
## Soluciones de los ejercicios (desarrolladas, no solo el resultado)
## Resumen (los puntos clave en una lista) y mapa de conceptos en texto
## Para estudiar más (libros o recursos del área; no inventes URLs)
Usa LaTeX con $...$ y $$...$$ para las fórmulas.`
          : `\nFormato: markdown con secciones: Resumen del tema (explicado en párrafos), Conceptos clave (cada uno con definición, explicación y ejemplo), Ejemplos resueltos, Recursos recomendados (videos, sitios, software de terceros como GeoGebra, Python, Excel, etc. con para qué usarlo), Preguntas de autoevaluación con respuestas al final.`
  // Los apuntes completos de una unidad son largos: con Claude se deja todo el espacio de salida
  const texto = await generarTexto(SYSTEM, base + extra + detalle + indicacionWeb(req.verificar_web), proveedor() === 'nvidia' ? 32000 : MAX_TOKENS_CLAUDE, { uso: req.tipo }, Boolean(req.verificar_web))
  const titulo = (texto.match(/^#\s+(.+)$/m)?.[1] ?? `${NOMBRES[req.tipo]}: ${req.tema || materia.nombre}`).trim()
  return { contenido: texto, titulo, puntos: 0 }
}

/** Solo Claude tiene búsqueda web: con NVIDIA no se le piden fuentes (las inventaría). */
const indicacionWeb = (pedir?: boolean): string => (pedir && proveedor() !== 'nvidia' ? INDICACION_WEB : '')

const INDICACION_WEB = `
Verifica en internet (búsqueda web) los datos, definiciones y recursos que no sean de conocimiento estándar del temario, prefiriendo fuentes académicas o institucionales. Al final agrega una sección «## Fuentes consultadas» con el título y la URL de cada fuente que realmente usaste.`

/**
 * Clase completa para una sesión: guion del docente con el contenido que se explica, ejemplos
 * resueltos, actividad y cierre; y un cuestionario de opción múltiple, alineado a lo que se
 * explicó, que se guarda aparte para jugarlo en vivo.
 */
async function generarClaseCompleta(req: GeneracionIA, base: string, materia: string): Promise<Generado> {
  const minutos = Math.max(30, req.cantidad || 90)
  const indicacion = `${base}

Duración de la clase: ${minutos} minutos.
${DETALLE[req.detalle ?? 'completo']}
Formato: markdown con estas secciones, en este orden:
# <título de la clase>
## Datos — apartado del temario que cubre (cítalo tal como aparece en el temario), objetivo de aprendizaje y conocimientos previos necesarios.
## Guion de la clase — bloques con minutos que sumen exactamente ${minutos}: activación, exposición, práctica guiada, actividad de los alumnos y cierre. En la exposición escribe el CONTENIDO completo que el docente explica (definiciones, propiedades, procedimientos, demostraciones o justificaciones cuando correspondan), no solo títulos.
## Ejemplos resueltos — al menos 3, de menor a mayor dificultad, paso a paso y aplicados al perfil de la carrera.
## Actividad para los alumnos — instrucciones, entregable y criterio de evaluación.
## Errores comunes — los que suelen cometer los alumnos en este tema y cómo corregirlos.
## Cierre — síntesis en 5 puntos y 3 preguntas de reflexión.
## Para el docente — lo que conviene revisar antes de dar la clase (todo lo marcado con «Verificar:»).
${indicacionWeb(req.verificar_web)}`
  const clase = await generarTexto(SYSTEM, indicacion, 32000, { uso: 'clase_completa' }, Boolean(req.verificar_web))
  const titulo = (clase.match(/^#\s+(.+)$/m)?.[1] ?? `Clase: ${req.tema || materia}`).trim()
  // El cuestionario se basa en la clase ya generada: pregunta lo que se explicó, nada más.
  // Si falla, la clase (lo caro: minutos y búsquedas) se guarda igual con una nota.
  let cuestionario: z.infer<typeof EvaluacionSchema>
  try {
    cuestionario = await generarJson(
      SYSTEM,
      `${base}\n\nClase que se impartirá:\n${clase}\n\n---\nGenera un cuestionario de 8 preguntas de opción múltiple (4 opciones, una sola correcta, 1 punto cada una) sobre lo que se explica en esa clase, para jugarlo en vivo en el salón: enunciados cortos que se lean en pantalla en menos de 20 segundos.`,
      EvaluacionSchema,
      JSON_EVALUACION,
      900 + 8 * 450,
      { uso: 'juego', rapido: true }
    )
  } catch (e) {
    const nota = `\n\n---\n> El cuestionario para jugar en vivo no se pudo generar (${(explicarError(e) as Error)?.message ?? String(e)}). Pídelo aparte en Estudio IA con el tipo «Cuestionario» y este mismo tema.`
    return { contenido: clase + nota, titulo, puntos: 0 }
  }
  const cuest = revolverOpciones({ ...cuestionario, titulo: `Cuestionario: ${titulo}` })
  return {
    contenido: clase,
    titulo,
    puntos: 0,
    adicionales: [{ tipo: 'cuestionario', titulo: cuest.titulo, contenido: JSON.stringify(cuest), puntos: cuest.preguntas.reduce((s, p) => s + (p.puntos || 0), 0) }]
  }
}

/**
 * La IA suele poner la correcta como primera opción; en un juego eso se aprende en dos preguntas.
 * Se revuelven en su lugar (la clave es el texto de la opción, así que sigue valiendo).
 */
function revolverOpciones<T extends { preguntas: { opciones?: string[] }[] }>(c: T): T {
  for (const p of c.preguntas) {
    const o = p.opciones
    if (!o || o.length < 2) continue
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[o[i], o[j]] = [o[j], o[i]]
    }
  }
  return c
}

/**
 * Juego en vivo a partir de algo que ya existe (un examen oral, de preguntas abiertas, una clase,
 * unos apuntes…): un cuestionario de opción múltiple sobre ese mismo contenido, que sí se puede jugar.
 */
export async function generarJuego(evaluacionId: number, cantidad = 10): Promise<Generado & { materia_id: number }> {
  const ev = getDb().prepare('SELECT materia_id, titulo, contenido FROM evaluaciones WHERE id = ?').get(evaluacionId) as
    | { materia_id: number; titulo: string; contenido: string }
    | undefined
  if (!ev) throw new Error('La evaluación no existe.')
  const { contexto } = contextoMateria(ev.materia_id, false)
  // De un examen basta con sus reactivos y claves; un texto largo se recorta para no pasar del contexto
  let fuente = ev.contenido
  try {
    const c = JSON.parse(ev.contenido) as { preguntas?: { enunciado: string; respuesta?: string; explicacion?: string }[] }
    if (c.preguntas?.length) fuente = c.preguntas.map((p, i) => `${i + 1}. ${p.enunciado}\nRespuesta: ${p.respuesta ?? ''}${p.explicacion ? `\nExplicación: ${p.explicacion}` : ''}`).join('\n\n')
  } catch {
    /* no es JSON: es texto (clase, apuntes, presentación) */
  }
  const n = Math.min(20, Math.max(4, Math.round(cantidad)))
  const out = revolverOpciones(await generarJson(
    SYSTEM,
    `${contexto}\n\n---\nContenido de «${ev.titulo}»:\n${fuente.slice(0, 60_000)}\n\n---\nGenera un cuestionario de ${n} preguntas de opción múltiple (4 opciones, una sola correcta, 1 punto cada una) sobre ese contenido, para jugarlo en vivo en el salón al estilo Kahoot: enunciados cortos que se lean en pantalla en menos de 20 segundos, opciones breves y distractores creíbles. Pregunta solo lo que viene en ese contenido, de menor a mayor dificultad, y en la explicación di en una frase por qué la correcta lo es.`,
    EvaluacionSchema,
    JSON_EVALUACION,
    900 + n * 450,
    { uso: 'juego', rapido: true }
  ))
  const titulo = `Juego en vivo: ${ev.titulo}`
  return { contenido: JSON.stringify({ ...out, titulo }), titulo, puntos: out.preguntas.reduce((s, p) => s + (p.puntos || 0), 0), materia_id: ev.materia_id }
}

/**
 * Lectura de la proyección del grupo. Los números los calcula la app (src/shared/proyeccion.ts);
 * Claude solo los interpreta: quién va bien, quién está en riesgo, por qué y qué conviene hacer.
 */
export async function analizarProyeccion(r: ResumenProyeccion): Promise<string> {
  const datos = {
    materia: r.materia,
    fecha_corte: r.fecha_corte,
    esquema: r.esquema,
    supuestos: r.supuestos,
    conteo: r.conteo,
    // Los nombres no salen del equipo: se manda «Alumno N» y se reponen en la respuesta
    alumnos: r.alumnos.map((a, i) => ({
      nombre: `Alumno ${i + 1}`,
      clasificacion: a.etiqueta,
      motivos: a.motivos,
      acumulada: a.acumulada,
      al_ritmo_actual: a.al_ritmo_actual,
      evaluado_pct: a.evaluado_pct,
      situacion: a.situacion,
      necesita_en_lo_que_falta: a.necesita,
      falta_evaluar: a.faltan,
      parciales: a.parciales.map((p) => ({ nombre: p.nombre, calificacion: p.calificacion, estado: p.estado, provisional: p.provisional, asistencia: p.asistencia })),
      faltas: { horas: a.asistencia.horas_falta, situacion_oficial: a.asistencia.riesgo, siguiente_escalon: a.asistencia.siguiente }
    }))
  }
  const system = `${SYSTEM}

Ahora actúas como asesor académico del docente. Recibes la proyección de calificaciones de un grupo, calculada por la app.
Reglas estrictas:
- Usa SOLO los datos recibidos. No inventes calificaciones, faltas, fechas ni causas. Cita las cifras tal como vienen.
- Si un alumno no tiene datos suficientes, dilo; no lo clasifiques por tu cuenta.
- "necesita_en_lo_que_falta" es la calificación mínima (0–10) que le falta obtener en lo que queda por evaluar para llegar a la aprobatoria.
- Las faltas siguen el reglamento institucional (horas de falta en todo el curso: límite, extraordinario, título de suficiencia, recursa).
- Escribe en español de México, claro y profesional, para el docente (no para los alumnos).`
  const pedido = `Proyección del grupo (JSON):
${JSON.stringify(datos)}

Redacta en markdown:
# Proyección del grupo · ${r.materia.nombre}
## Panorama (3–5 líneas con los conteos)
## Requieren atención inmediata — por alumno: situación con cifras, por qué y una acción concreta del docente (p. ej. "necesita 7.5 en el examen del parcial 2 y no puede faltar más de 1 h").
## En riesgo
## Van aprobando (lista breve; menciona a quien podría bajar si falta o no entrega)
## Situación por faltas (escalones del reglamento)
## Recomendaciones para el grupo (máximo 5)
Al final, una línea con la fecha de corte y que los supuestos de la proyección vienen de la app.
Refiérete a cada alumno exactamente como viene («Alumno 3»), sin agregarle nombre.`
  const texto = await generarTexto(system, pedido, 16000, { uso: 'proyeccion' })
  return texto.replace(/\bAlumno (\d+)\b/g, (todo, n: string) => r.alumnos[Number(n) - 1]?.nombre ?? todo)
}

// ---------- Revisión de entregas con IA ----------

const esquemaRevisionIA = z.object({
  resumen: z.string(),
  alumnos: z.array(
    z.object({
      alumno: z.string(),
      nivel: z.enum(['alta', 'media', 'baja', 'ninguna']),
      uso_de_ia: z.enum(['probable', 'posible', 'poco_probable', 'sin_texto']),
      hallazgos: z.array(z.string())
    })
  ),
  parecidos: z.array(z.object({ alumnos: z.array(z.string()), nivel: z.enum(['alta', 'media', 'baja']), original: z.string(), explicacion: z.string() })),
  recomendaciones: z.array(z.string())
})
const jsonRevisionIA = {
  type: 'object',
  properties: {
    resumen: { type: 'string' },
    alumnos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          alumno: { type: 'string' },
          nivel: { type: 'string', enum: ['alta', 'media', 'baja', 'ninguna'] },
          uso_de_ia: { type: 'string', enum: ['probable', 'posible', 'poco_probable', 'sin_texto'] },
          hallazgos: { type: 'array', items: { type: 'string' } }
        },
        required: ['alumno', 'nivel', 'uso_de_ia', 'hallazgos']
      }
    },
    parecidos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          alumnos: { type: 'array', items: { type: 'string' } },
          nivel: { type: 'string', enum: ['alta', 'media', 'baja'] },
          original: { type: 'string' },
          explicacion: { type: 'string' }
        },
        required: ['alumnos', 'nivel', 'original', 'explicacion']
      }
    },
    recomendaciones: { type: 'array', items: { type: 'string' } }
  },
  required: ['resumen', 'alumnos', 'parecidos', 'recomendaciones']
}

/** Tope de texto por archivo y en total: un grupo de 40 cabe sin que la petición se vuelva enorme */
const TOPE_ARCHIVO = 8000
const TOPE_TOTAL = 240_000

/**
 * Segunda opinión sobre la revisión de copias: la app ya comparó metadatos y textos con reglas fijas; la IA lee
 * el contenido para lo que las reglas no ven (paráfrasis, mismos errores, texto que parece generado por IA,
 * fechas que no cuadran con la entrega). Los nombres no salen del equipo: van como «Alumno N».
 */
export async function revisarEntregasConIA(generado: string): Promise<RevisionIA> {
  const d = datosParaIA(generado)
  if (!d) throw new Error('Esta revisión de copias es una guardada y sus archivos ya no están en memoria. Pulsa «Revisar otra vez» arriba y luego «Revisar con IA».')
  const conEntrega = [...new Set(d.informe.archivos.map((a) => a.alumno))]
  const { tapar, etiqueta } = anonimizador(d.grupo, conEntrega)
  const porArchivo = Math.min(TOPE_ARCHIVO, Math.floor(TOPE_TOTAL / Math.max(1, d.textos.length)))
  const archivos = d.informe.archivos.map((a) => {
    const t = d.textos.find((x) => x.alumno === a.alumno && x.nombre === a.nombre)?.texto ?? ''
    return {
      alumno: etiqueta.get(a.alumno),
      archivo: tapar(a.nombre),
      origen: a.origen,
      entregado: a.entregado,
      palabras: a.palabras,
      historia: tapar(a.historia),
      metadatos: {
        autor: tapar(a.autor),
        ultimo_editor: tapar(a.ultimo_editor),
        titulo_interno: tapar(a.titulo),
        programa: a.programa,
        creado: a.creado,
        modificado: a.modificado,
        minutos_de_edicion: a.minutos_edicion,
        drive_dueno: tapar(a.drive_dueno),
        drive_ultima_modificacion: tapar(a.drive_editor),
        drive_creado: a.drive_creado,
        drive_modificado: a.drive_modificado,
        nombre_original_en_drive: tapar(a.nombre_original),
        editaron_en_drive: tapar(a.drive_editores),
        foto: a.camara ? `${a.camara} ${a.fecha_foto ?? ''}`.trim() : ''
      },
      texto: t.length > porArchivo ? `${tapar(t.slice(0, porArchivo))}\n[… recortado: ${t.length - porArchivo} caracteres más]` : tapar(t)
    }
  })
  const system = `${SYSTEM}

Ahora revisas la integridad académica de las entregas de una tarea, como apoyo al docente. La app ya comparó los archivos con reglas fijas (mismo archivo, mismo texto, mismos datos, nombres de otros alumnos en los metadatos) y te pasa esas señales. Tu trabajo es lo que esas reglas no ven:
- Paráfrasis: el mismo contenido con otras palabras, el mismo orden de ideas, los mismos ejemplos poco comunes.
- En código: mismos nombres de variables raros, mismos comentarios, la misma solución poco usual o el mismo error.
- Contenido que parece generado por una IA: prosa pulida y genérica que no corresponde al nivel ni a lo que pide la tarea, frases típicas de asistentes, referencias inventadas, código perfecto con comentarios de tutorial, cambios bruscos de estilo dentro del mismo trabajo.
- Metadatos que no cuadran: creado después de la fecha límite o minutos antes de entregarlo con mucho contenido, editado por otra persona, programa que genera documentos.
- Quién copió a quién: en cada par parecido di quién parece haberlo hecho primero («original»: «Alumno N» o «no se sabe») y por qué (horas de creación y entrega, quién tiene el error original, quién tiene el trabajo más completo, nombres o cuentas dentro del archivo). Si las horas no alcanzan, dilo.
Reglas estrictas:
- Son pistas para que el docente revise, no pruebas. No acuses: describe lo que se ve y por qué llama la atención.
- Cada hallazgo debe apoyarse en algo concreto del archivo (cita un fragmento corto entre comillas o el dato de metadatos).
- Lo que tienen todos los alumnos (instrucciones, plantilla, el cuaderno o el código que dio el docente) no cuenta como copia.
- No repitas las señales de la app; si confirmas o descartas alguna, dilo en el resumen.
- Si un archivo no tiene texto (foto, escaneo), usa "sin_texto" y básate solo en metadatos.
- Refiérete a cada alumno exactamente como viene («Alumno 3»). Escribe en español de México, breve y claro.
- "nivel" es qué tanto amerita que el docente lo revise: alta, media, baja o ninguna. Incluye a todos los alumnos que vienen.`
  const pedido = `Tareas revisadas:
${JSON.stringify(d.tareas.map((t) => ({ titulo: t.titulo, instrucciones: tapar(t.descripcion ?? '').slice(0, 4000), fecha_limite: t.vence })))}

Cuentas de Drive del curso o del docente (dueñas de archivos de buena parte del grupo; no son de ningún alumno y no cuentan como señal):
${JSON.stringify(d.cuentas_del_curso.map(tapar))}

Lo que ya mostraron los metadatos (quién hizo el archivo y quién lo entregó):
${JSON.stringify(d.informe.hallazgos.map((h) => ({ caso: tapar(h.caso), evidencia: tapar(h.evidencia), conclusion: tapar(h.conclusion), fuerza: h.fuerza, original: h.original ? etiqueta.get(h.original) : undefined, copia: h.copia ? etiqueta.get(h.copia) : undefined })))}

Cadenas por hora: ${JSON.stringify(d.informe.cadenas.map(tapar))}

Señales que ya encontró la app:
${JSON.stringify(d.informe.senales.map((x) => ({ nivel: x.nivel, alumnos: x.alumnos.map((n) => etiqueta.get(n) ?? '[alguien del grupo]'), texto: tapar(x.texto) })))}

Archivos entregados (${archivos.length}):
${JSON.stringify(archivos)}

Devuelve: un resumen de 2 a 4 líneas; por cada alumno su nivel, si parece hecho con IA y sus hallazgos (vacío si no hay nada); los pares o grupos que se parecen más allá de lo literal; y hasta 4 recomendaciones para el docente (qué abrir primero, a quién preguntarle qué).`
  const r = await generarJson(system, pedido, esquemaRevisionIA, jsonRevisionIA, 16000, { uso: 'revision_copias' })
  // Se reponen los nombres
  const nombres = new Map([...etiqueta].map(([n, e]) => [e, n]))
  // Se reponen con su nombre corto (primer nombre y apellido paterno), como en el resto de la revisión
  const reponer = (t: string): string =>
    t.replace(/\bAlumno (\d+)\b/g, (todo) => {
      const n = nombres.get(todo)
      return n ? (d.informe.nombres?.[n] ?? n) : todo
    })
  return {
    resumen: reponer(r.resumen),
    alumnos: r.alumnos.map((a) => ({ ...a, alumno: reponer(a.alumno), hallazgos: a.hallazgos.map(reponer) })),
    parecidos: r.parecidos.map((p) => ({ ...p, alumnos: p.alumnos.map(reponer), original: reponer(p.original), explicacion: reponer(p.explicacion) })),
    recomendaciones: r.recomendaciones.map(reponer),
    generado: new Date().toISOString()
  }
}

/** Pregunta libre con el contexto de la materia (asistente del docente). */
export async function preguntar(materiaId: number, pregunta: string): Promise<string> {
  const { contexto } = contextoMateria(materiaId, true, pregunta)
  return generarTexto(`${SYSTEM}\n\nContexto de la materia:\n${contexto}`, pregunta, 16000, { uso: 'pregunta' })
}

// ---- Convertir un archivo en examen ----

/** Qué hacer con el archivo: pasar sus preguntas tal cual, generar preguntas de su contenido, o que la IA decida */
export interface OpcionesExamenArchivo {
  modo: 'auto' | 'extraer' | 'generar'
  /** Cuántas de cada tipo: al generar, las que se crean; si el archivo ya trae preguntas, cuántas se toman de ellas */
  opcion_multiple: number
  verdadero_falso: number
  abierta: number
  /** Solo con «extraer»: todas las del archivo, sin importar las cantidades */
  todas?: boolean
  /** Cómo se eligen de las que trae el archivo: repartidas a lo largo de él, o al azar (otra combinación cada vez) */
  eleccion?: 'repartidas' | 'azar'
  instrucciones?: string
}

/** Como la evaluación, más de dónde salieron las preguntas (para saber si hay que elegir entre ellas) */
const EvaluacionArchivoSchema = EvaluacionSchema.extend({ origen: z.enum(['extraidas', 'generadas']) })
const JSON_EVALUACION_ARCHIVO = {
  ...JSON_EVALUACION,
  properties: { ...JSON_EVALUACION.properties, origen: { type: 'string', enum: ['extraidas', 'generadas'] } },
  required: [...JSON_EVALUACION.required, 'origen']
}

/**
 * De las preguntas que trae el archivo, `n` de las que cumplen `es`, repartidas a lo largo del archivo (no las
 * primeras): así cubren todos los temas. Devuelve sus posiciones.
 */
function repartidas<T>(lista: T[], es: (x: T) => boolean, n: number, alAzar = false): number[] {
  const pos = lista.map((x, i) => (es(x) ? i : -1)).filter((i) => i >= 0)
  if (n >= pos.length) return pos
  if (n <= 0) return []
  if (alAzar) {
    // Fisher-Yates y se toman las primeras n
    for (let i = pos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pos[i], pos[j]] = [pos[j], pos[i]]
    }
    return pos.slice(0, n)
  }
  return Array.from({ length: n }, (_, k) => pos[Math.floor((k * pos.length) / n)])
}

/** Tope del texto del archivo que se manda: un libro entero no hace falta para un examen y encarece la llamada */
const MAX_TEXTO_ARCHIVO = 120_000

/**
 * Convierte el texto de un archivo (PDF, Word, PowerPoint…) en un examen con preguntas de opción múltiple,
 * verdadero/falso y abiertas. Si el archivo ya trae reactivos, se transcriben fielmente; si es material de
 * estudio, se generan preguntas solo con lo que dice el documento.
 */
export async function examenDesdeArchivo(texto: string, archivo: string, materiaNombre: string, op: OpcionesExamenArchivo): Promise<Generado> {
  const limpio = texto.trim()
  if (limpio.length < 40) throw new Error('El archivo casi no tiene texto que se pueda leer (¿es una imagen escaneada?). Prueba con un PDF o Word con texto.')
  const recortado = limpio.length > MAX_TEXTO_ARCHIVO
  const doc = recortado ? limpio.slice(0, MAX_TEXTO_ARCHIVO) : limpio
  const om = Math.max(0, Math.round(op.opcion_multiple || 0))
  const vf = Math.max(0, Math.round(op.verdadero_falso || 0))
  const ab = Math.max(0, Math.round(op.abierta || 0))
  const conTodas = op.modo === 'extraer' && op.todas !== false
  if (!conTodas && om + vf + ab === 0) throw new Error('Indica cuántas preguntas quieres de al menos un tipo.')
  const mezcla = [om && `${om} de opción múltiple`, vf && `${vf} de verdadero/falso`, ab && `${ab} abiertas`].filter(Boolean).join(', ')
  const tarea =
    op.modo === 'extraer'
      ? `El documento contiene un examen, guía o lista de preguntas. TRANSCRIBE TODAS sus preguntas fielmente, en el mismo orden, sin inventar ni quitar ninguna y sin cambiar su redacción (solo corrige errores evidentes de ortografía o de formato). "origen" = "extraidas".`
      : op.modo === 'generar'
        ? `El documento es material de estudio. GENERA un examen con ${mezcla}, basado ÚNICAMENTE en lo que dice el documento (nada que no esté en él). "origen" = "generadas".`
        : `Primero decide qué es el documento:
- Si YA CONTIENE preguntas o reactivos (un examen, una guía con preguntas, un cuestionario): TRANSCRÍBELOS TODOS fielmente, en el mismo orden, sin inventar ni quitar ninguno y sin cambiar su redacción (después se eligen las que se van a usar). "origen" = "extraidas".
- Si es material de estudio sin preguntas: GENERA un examen con ${mezcla}, basado ÚNICAMENTE en lo que dice el documento. "origen" = "generadas".`
  const indicacion = `Materia: ${materiaNombre}
Archivo: ${archivo}

${tarea}

Formato de cada reactivo:
- Opción múltiple → tipo "opcion_multiple", 4 opciones (si el original trae otro número, respétalo), "respuesta" = copia textual exacta de la opción correcta.
- Verdadero o falso → tipo "verdadero_falso", opciones vacías, "respuesta" = "Verdadero" o "Falso".
- Pregunta abierta, de desarrollo o problema → tipo "abierta", opciones vacías, "respuesta" = la respuesta esperada en una o dos frases (o los pasos clave).
- Si el documento trae la clave de respuestas, úsala. Si no la trae, resuelve cada reactivo tú y explica por qué en "explicacion"; si no estás seguro de la correcta, escribe al inicio de la explicación «**Verificar:**».
- Puntos: los que indique el documento; si no indica, 1 por opción múltiple o verdadero/falso y 2 por abierta.
- "titulo": un título corto para el examen; "instrucciones": las del documento si trae, o unas breves; "duracion_min": la que indique o 0.
${op.instrucciones?.trim() ? `\nIndicaciones adicionales del docente: ${op.instrucciones.trim()}` : ''}${recortado ? '\n(El documento es largo: se envía solo el inicio.)' : ''}

--- DOCUMENTO ---
${doc}
--- FIN DEL DOCUMENTO ---`
  const { origen, ...out } = await generarJson(SYSTEM, indicacion, EvaluacionArchivoSchema, JSON_EVALUACION_ARCHIVO, 16000, { uso: 'examen_archivo' })
  if (!out.preguntas.length) throw new Error('No se encontraron preguntas en el archivo ni se pudieron generar. Prueba con «Generar preguntas de su contenido».')
  // Verdadero/falso siempre con sus dos opciones, como las espera el portal
  let preguntas = out.preguntas.map((p) => (p.tipo === 'verdadero_falso' ? { ...p, opciones: [], respuesta: /^f/i.test(p.respuesta.trim()) ? 'Falso' : 'Verdadero' } : p))
  // Sin el número que traían en el archivo («3. ¿Qué…»): el portal numera, y al elegir unas quedarían saltados
  if (origen === 'extraidas') preguntas = preguntas.map((p) => ({ ...p, enunciado: p.enunciado.replace(/^\s*(?:\d{1,3}|[a-zA-Z])\s*[.)-]\s+/, '') }))
  // El archivo traía sus preguntas: se toman las cantidades pedidas de cada tipo (salvo «todas»), en su orden original
  if (origen === 'extraidas' && !conTodas) {
    const azar = op.eleccion === 'azar'
    const elegidas = new Set([
      ...repartidas(preguntas, (p) => p.tipo === 'opcion_multiple', om, azar),
      ...repartidas(preguntas, (p) => p.tipo === 'verdadero_falso', vf, azar),
      ...repartidas(preguntas, (p) => p.tipo !== 'opcion_multiple' && p.tipo !== 'verdadero_falso', ab, azar)
    ])
    preguntas = preguntas.filter((_, i) => elegidas.has(i))
    if (!preguntas.length) throw new Error('El archivo no trae preguntas de los tipos que pediste.')
  }
  const contenido = { ...out, preguntas }
  return { contenido: JSON.stringify(contenido), titulo: out.titulo || `Examen: ${archivo}`, puntos: preguntas.reduce((s, p) => s + (p.puntos || 0), 0) }
}
