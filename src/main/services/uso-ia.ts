import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getDb } from '../db'
import type { GastoIA } from '@shared/types'

/**
 * Precio público por millón de tokens (USD). La caché se cobra aparte: leerla cuesta una fracción de la
 * entrada y escribirla (5 min) 1.25 veces. Haiku 5.5 sube de precio cuando la petición pasa de 100 mil tokens.
 */
const PRECIOS: Record<string, { entrada: number; salida: number; cache: number; largo?: { desde: number; entrada: number; salida: number } }> = {
  'claude-opus-5-5': { entrada: 4, salida: 20, cache: 0.2 },
  'claude-sonnet-5-5': { entrada: 2, salida: 10, cache: 0.2 },
  'claude-haiku-5-5': { entrada: 0.1, salida: 0.5, cache: 0.01, largo: { desde: 100_000, entrada: 0.5, salida: 2.5 } }
}
/** Cada búsqueda web se cobra aparte: USD 10 por cada mil. */
const PRECIO_BUSQUEDA = 0.01

export function costoDe(modelo: string, u: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'server_tool_use'>): number | null {
  const p = PRECIOS[modelo]
  if (!p) return null
  const leida = u.cache_read_input_tokens ?? 0
  const escrita = u.cache_creation_input_tokens ?? 0
  const largo = p.largo && u.input_tokens + leida + escrita > p.largo.desde ? p.largo : null
  const entrada = largo?.entrada ?? p.entrada
  const salida = largo?.salida ?? p.salida
  return (u.input_tokens * entrada + escrita * entrada * 1.25 + leida * p.cache + u.output_tokens * salida) / 1e6 + (u.server_tool_use?.web_search_requests ?? 0) * PRECIO_BUSQUEDA
}

/** Anota una petición ya contestada (o cortada: también se cobra). Nunca rompe la generación si falla. */
export function registrarUso(uso: string, modelo: string, esfuerzo: string, msg: Pick<Anthropic.Message, 'usage'> | null | undefined): void {
  const u = msg?.usage
  if (!u) return
  try {
    getDb()
      .prepare('INSERT INTO uso_ia (id, uso, modelo, esfuerzo, entrada, salida, cache_leida, cache_escrita, busquedas, costo_usd) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), uso, modelo, esfuerzo, u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.server_tool_use?.web_search_requests ?? 0, costoDe(modelo, u))
  } catch (e) {
    console.error('[uso-ia]', (e as Error).message)
  }
}

const NOMBRES_USO: Record<string, string> = {
  diagnostico: 'Examen diagnóstico',
  examen: 'Examen parcial',
  examen_sorpresa: 'Examen sorpresa',
  examen_oral: 'Examen oral',
  cuestionario: 'Cuestionario',
  tarea: 'Tarea',
  ejercicios: 'Ejercicios',
  ejemplos: 'Ejemplos resueltos',
  glosario: 'Glosario',
  material_apoyo: 'Material de apoyo',
  plan_sesion: 'Plan de sesión',
  presentacion: 'Presentación',
  clase_completa: 'Clase completa',
  apuntes: 'Apuntes',
  juego: 'Juego en vivo',
  examen_archivo: 'Examen desde archivo',
  revision_copias: 'Revisión de copias',
  proyeccion: 'Análisis de proyección',
  pregunta: 'Pregunta sobre la materia',
  asistente: 'Asistente',
  prueba: 'Probar conexión'
}

/** Gasto de los últimos `dias` días, por uso y por modelo, de lo más caro a lo más barato. */
export function gastoIA(dias = 30): GastoIA {
  const d = getDb()
  const desde = `-${Math.max(1, Math.min(366, Math.floor(dias)))} days`
  const tot = d
    .prepare("SELECT COUNT(*) AS llamadas, COALESCE(SUM(costo_usd), 0) AS total, SUM(costo_usd IS NULL) AS sin_precio FROM uso_ia WHERE fecha >= datetime('now', ?)")
    .get(desde) as { llamadas: number; total: number; sin_precio: number | null }
  const porUso = d
    .prepare("SELECT uso, COUNT(*) AS llamadas, COALESCE(SUM(costo_usd), 0) AS costo_usd, SUM(salida) AS salida FROM uso_ia WHERE fecha >= datetime('now', ?) GROUP BY uso ORDER BY costo_usd DESC")
    .all(desde) as { uso: string; llamadas: number; costo_usd: number; salida: number }[]
  const porModelo = d
    .prepare("SELECT modelo, COUNT(*) AS llamadas, COALESCE(SUM(costo_usd), 0) AS costo_usd FROM uso_ia WHERE fecha >= datetime('now', ?) GROUP BY modelo ORDER BY costo_usd DESC")
    .all(desde) as { modelo: string; llamadas: number; costo_usd: number }[]
  return {
    dias,
    total_usd: tot.total,
    llamadas: tot.llamadas,
    sin_precio: tot.sin_precio ?? 0,
    por_uso: porUso.map((r) => ({ ...r, nombre: NOMBRES_USO[r.uso] ?? r.uso })),
    por_modelo: porModelo
  }
}
