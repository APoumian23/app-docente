/**
 * Modelo, esfuerzo y gasto de la IA, sobre una base en memoria y un Claude falso local (no se gasta nada).
 * Revisa que lo rutinario vaya con el modelo rápido a esfuerzo medio y lo demás con el principal a esfuerzo alto,
 * que cada petición (también la cortada) quede anotada con su costo, y que el gasto viaje en la sincronización.
 * Se corre desde qa.sh con Electron como Node (better-sqlite3 está compilado para Electron).
 */
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { abrirBase } from '../src/servidor/base'
import { tablasSincronizadas } from '../src/servidor/cambios'
import { usarBase, setAjuste } from '../src/main/db'
import { generar } from '../src/main/services/ia'
import { costoDe, gastoIA } from '../src/main/services/uso-ia'

let fallos = 0
const ok = (t: string, cond: boolean, extra = ''): void => {
  console.log(cond ? '  ✓' : '  ✗', t, cond ? '' : extra)
  if (!cond) fallos++
}
const cerca = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

const db = abrirBase(':memory:')
usarBase(db)
const run = (sql: string, ...p: unknown[]): number => Number(db.prepare(sql).run(...p).lastInsertRowid)
const carrera = run("INSERT INTO carreras (nombre) VALUES ('IIA')")
const periodo = run("INSERT INTO periodos (nombre, fecha_inicio, semanas) VALUES ('Semestre', '2026-08-24', 16)")
const materia = run("INSERT INTO materias (carrera_id, periodo_id, nombre, temario) VALUES (?, ?, 'Álgebra Lineal', '1. Matrices')", carrera, periodo)

// ---- Claude falso: contesta en streaming con 1000 tokens de entrada y 5000 de salida ----
const pedidos: { model: string; effort?: string }[] = []
let cortar = false
const evaluacion = JSON.stringify({ titulo: 'Prueba', instrucciones: 'Contesta', duracion_min: 30, preguntas: [{ tipo: 'abierta', enunciado: '¿2+2?', opciones: [], respuesta: '4', puntos: 10, explicacion: 'suma' }] })
const servidor = createServer((req, res) => {
  let cuerpo = ''
  req.on('data', (c) => (cuerpo += c))
  req.on('end', () => {
    const b = JSON.parse(cuerpo) as { model: string; output_config?: { effort?: string } }
    pedidos.push({ model: b.model, effort: b.output_config?.effort })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (tipo: string, datos: object): void => {
      res.write(`event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...datos })}\n\n`)
    }
    const texto = cortar ? evaluacion.slice(0, 40) : evaluacion
    ev('message_start', { message: { id: 'msg_prueba', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '', citations: null } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: texto } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: cortar ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5000 } })
    ev('message_stop', {})
    res.end()
  })
})

const pedir = (tipo: 'tarea' | 'examen' | 'cuestionario'): Promise<unknown> =>
  generar({ materia_id: materia, tipo, tema: 'Matrices', dificultad: 'intermedio', cantidad: 1, usar_materiales: false } as Parameters<typeof generar>[0])
const ultimo = (): { model: string; effort?: string } => pedidos[pedidos.length - 1]
const ultimaFila = (): { uso: string; modelo: string; esfuerzo: string; entrada: number; salida: number; costo_usd: number } =>
  db.prepare('SELECT uso, modelo, esfuerzo, entrada, salida, costo_usd FROM uso_ia ORDER BY rowid DESC LIMIT 1').get() as never

async function main(): Promise<void> {
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r))
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba-local'

  console.log('Modelo y esfuerzo:')
  await pedir('tarea')
  ok('tarea → Haiku 5.5 con esfuerzo medio (lo rutinario, por omisión)', ultimo().model === 'claude-haiku-5-5' && ultimo().effort === 'medium', JSON.stringify(ultimo()))
  const t = ultimaFila()
  ok('queda anotada: tarea, 1000 de entrada, 5000 de salida, USD 0.0026', t.uso === 'tarea' && t.entrada === 1000 && t.salida === 5000 && cerca(t.costo_usd, 0.0026), JSON.stringify(t))
  await pedir('examen')
  ok('examen → Opus 5.5 con esfuerzo alto', ultimo().model === 'claude-opus-5-5' && ultimo().effort === 'high', JSON.stringify(ultimo()))
  ok('examen cuesta USD 0.104', cerca(ultimaFila().costo_usd, 0.104), JSON.stringify(ultimaFila()))
  setAjuste('modelo_ia_rapido', 'claude-sonnet-5-5')
  await pedir('cuestionario')
  ok('con Sonnet elegido para lo rutinario, el cuestionario va con Sonnet a esfuerzo medio', ultimo().model === 'claude-sonnet-5-5' && ultimo().effort === 'medium', JSON.stringify(ultimo()))
  setAjuste('modelo_ia_rapido', 'principal')
  await pedir('tarea')
  ok('«Igual que el principal» → Opus 5.5, pero a esfuerzo medio', ultimo().model === 'claude-opus-5-5' && ultimo().effort === 'medium', JSON.stringify(ultimo()))
  setAjuste('modelo_ia_rapido', '')
  await pedir('tarea')
  ok('vacío (la Mac nunca lo eligió y así lo manda a la web) cuenta como Haiku', ultimo().model === 'claude-haiku-5-5', JSON.stringify(ultimo()))
  setAjuste('modelo_ia', 'claude-sonnet-5-5')
  await pedir('examen')
  ok('el principal cambiado a Sonnet manda en los exámenes', ultimo().model === 'claude-sonnet-5-5' && ultimo().effort === 'high', JSON.stringify(ultimo()))

  console.log('Respuesta cortada:')
  cortar = true
  const n = (db.prepare('SELECT COUNT(*) AS n FROM uso_ia').get() as { n: number }).n
  const err = await pedir('examen').then(() => null, (e: Error) => e.message)
  cortar = false
  ok('avisa que salió incompleta', !!err && /incompleta/.test(err), String(err))
  ok('y también queda anotada (se cobra igual)', (db.prepare('SELECT COUNT(*) AS n FROM uso_ia').get() as { n: number }).n === n + 1)

  console.log('Precios y resumen:')
  ok('Haiku pasa a la tarifa larga arriba de 100 mil tokens de entrada', cerca(costoDe('claude-haiku-5-5', { input_tokens: 120_000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null })!, (120_000 * 0.5 + 1000 * 2.5) / 1e6))
  ok('caché leída y escrita, y búsquedas web, cuentan en Opus', cerca(costoDe('claude-opus-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } })!, 0.2 + 5 + 0.02))
  ok('un modelo sin precio no inventa costo', costoDe('modelo-raro', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null }) === null)
  const g = gastoIA(30)
  const suma = (db.prepare('SELECT SUM(costo_usd) AS s FROM uso_ia').get() as { s: number }).s
  ok(`resumen de 30 días: ${g.llamadas} peticiones, USD ${g.total_usd.toFixed(4)}`, g.llamadas === 7 && cerca(g.total_usd, suma), JSON.stringify(g))
  ok('lo más caro primero, con nombre legible', g.por_uso[0]?.uso === 'examen' && g.por_uso[0]?.nombre === 'Examen parcial', JSON.stringify(g.por_uso[0]))
  ok('por modelo: Opus, Sonnet y Haiku', g.por_modelo.length === 3, JSON.stringify(g.por_modelo))
  db.prepare("UPDATE uso_ia SET fecha = datetime('now', '-40 days') WHERE uso = 'cuestionario'").run()
  ok('lo de hace 40 días no entra en los últimos 30', gastoIA(30).llamadas === 6 && gastoIA(90).llamadas === 7)

  console.log('Sincronización:')
  ok('uso_ia viaja entre la Mac y la web', tablasSincronizadas(db).includes('uso_ia'))
  ok('cada anotación entra al registro de cambios', (db.prepare("SELECT COUNT(*) AS n FROM _cambios WHERE tabla = 'uso_ia'").get() as { n: number }).n >= 6)

  servidor.close()
  console.log(fallos ? `\n${fallos} comprobación(es) fallaron` : '\nSin fallos')
  process.exit(fallos ? 1 : 0)
}

main().catch((e) => {
  console.error('  ✗', e)
  process.exit(1)
})
