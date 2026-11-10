/** Recorre todas las pantallas de la app y reporta errores de consola o de render. */
async function conectar() {
  const t = await (await fetch('http://localhost:9222/json')).json()
  const page = t.find((x) => x.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pend = new Map()
  const eventos = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) eventos.push(`consola ${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`)
    else if (m.method === 'Runtime.exceptionThrown') eventos.push(`excepción: ${m.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? ''}`)
  }
  const enviar = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await enviar('Runtime.enable')
  return { enviar, eventos, cerrar: () => ws.close() }
}
const evaluar = async (c, e) => {
  const r = await c.enviar('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'error')
  return r.result.value
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

const RUTAS = [
  ['#/', 'Hoy', ['Sesiones de hoy', 'Próximos 7 días', 'Próximas fechas', 'Alumnos en riesgo por faltas']],
  ['#/fechas', 'Fechas', ['Fechas importantes', 'Próximas']],
  ['#/materias', 'Materias', ['Ingeniería en Inteligencia Artificial', 'Álgebra Lineal', 'Análisis y Diseño de Algoritmos']],
  ['#/alumnos', 'Alumnos', ['Importar Excel/CSV', 'Todas las carreras']],
  ['#/horario', 'Horario', ['Horario semanal', 'Sábado']],
  ['#/ia', 'Estudio IA', ['¿QUÉ GENERAMOS?', 'Examen sorpresa']],
  ['#/programar', 'Programar', ['Python y JavaScript sin internet', 'Paquetes de Python']],
  ['#/asistente', 'Asistente', ['Conversa con la IA', 'Nueva conversación']],
  ['#/ajustes', 'Ajustes', ['Inteligencia artificial', 'Seguridad', 'Presentaciones']],
  ['#/ayuda', 'Ayuda', ['Flujo de trabajo recomendado', 'GeoGebra', 'Programar (editor de código)']],
  ['#/clase', 'Modo clase', []]
]

;(async () => {
  const c = await conectar()
  const fallos = []
  for (const [ruta, nombre, esperados] of RUTAS) {
    c.eventos.length = 0
    await evaluar(c, `location.hash = '${ruta}'`)
    // Se espera a que aparezca lo esperado (hasta 8 s), no un tiempo fijo: con la máquina ocupada tarda más
    let texto = ''
    for (let i = 0; i < 40; i++) {
      await esperar(200)
      texto = await evaluar(c, 'document.body.innerText')
      if (texto.trim().length >= 30 && esperados.every((e) => texto.includes(e))) break
    }
    const faltan = esperados.filter((e) => !texto.includes(e))
    const vacio = texto.trim().length < 30
    const errores = [...c.eventos]
    const estado = faltan.length || vacio || errores.length ? '✗' : '✓'
    console.log(`${estado} ${nombre.padEnd(12)} ${texto.trim().split('\n')[0].slice(0, 50)}`)
    if (vacio) fallos.push(`${nombre}: la pantalla quedó vacía`)
    if (faltan.length) fallos.push(`${nombre}: no apareció ${faltan.join(', ')}`)
    errores.forEach((e) => fallos.push(`${nombre}: ${e}`))
  }

  // Pestañas de una materia
  console.log('\nPestañas de materia')
  await evaluar(c, `location.hash = '#/materias'`)
  for (let i = 0; i < 40 && !(await evaluar(c, `[...document.querySelectorAll('a')].some(x=>x.innerText.includes('Álgebra Lineal'))`)); i++) await esperar(200)
  const idMateria = await evaluar(c, `(() => { const a=[...document.querySelectorAll('a')].find(x=>x.innerText.includes('Álgebra Lineal')); a.click(); return true })()`)
  for (let i = 0; i < 40 && !(await evaluar(c, `[...document.querySelectorAll('button')].some(x=>x.innerText.trim().startsWith('Plan y sesiones'))`)); i++) await esperar(200)
  for (const pestana of ['Plan y sesiones', 'Alumnos', 'Calificaciones', 'Materiales', 'Evaluaciones y tareas', 'Glosario', 'Configuración']) {
    c.eventos.length = 0
    const r = await evaluar(c, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(pestana)})); if(!b) return 'NO EXISTE'; b.click(); return 'ok' })()`)
    await esperar(1200)
    const largo = await evaluar(c, 'document.body.innerText.length')
    const errores = [...c.eventos]
    console.log(`${r === 'ok' && !errores.length ? '✓' : '✗'} ${pestana.padEnd(22)} ${largo} caracteres`)
    if (r !== 'ok') fallos.push(`pestaña ${pestana}: ${r}`)
    errores.forEach((e) => fallos.push(`pestaña ${pestana}: ${e}`))
  }

  console.log('\n' + (fallos.length ? `FALLOS (${fallos.length}):` : 'Sin fallos en el recorrido.'))
  fallos.forEach((f) => console.log('  •', f))
  c.cerrar()
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
