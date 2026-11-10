/** Revisa que las pantallas no desborden a lo ancho en ventanas angostas. */
async function conectar() {
  const t = await (await fetch('http://localhost:9222/json')).json()
  const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0; const pend = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } }
  const enviar = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })) })
  return { enviar, cerrar: () => ws.close() }
}
const ev = async (c, e) => (await c.enviar('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const c = await conectar()
  const anchos = [1440, 1180, 1024, 900]
  const rutas = [['#/', 'Hoy'], ['#/fechas', 'Fechas'], ['#/materias', 'Materias'], ['#/alumnos', 'Alumnos'], ['#/horario', 'Horario'], ['#/ia', 'Estudio IA'], ['#/programar', 'Programar'], ['#/asistente', 'Asistente'], ['#/ajustes', 'Ajustes'], ['#/ayuda', 'Ayuda']]
  const fallos = []
  for (const w of anchos) {
    await c.enviar('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: false })
    const linea = []
    for (const [ruta, nombre] of rutas) {
      await ev(c, `location.hash='${ruta}'`)
      await esperar(700)
      const r = await ev(c, `(() => ({ desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth, anchoTabla: Math.max(0, ...[...document.querySelectorAll('table')].map(t => t.scrollWidth - t.parentElement.clientWidth)) }))()`)
      linea.push(`${nombre}:${r.desborde > 2 ? `DESBORDA ${r.desborde}px` : 'ok'}`)
      if (r.desborde > 2) fallos.push(`${nombre} a ${w}px desborda ${r.desborde}px en horizontal`)
    }
    console.log(`${String(w).padStart(5)}px  ${linea.join('  ')}`)
  }
  // Detalle de una materia, que es la pantalla más densa
  await c.enviar('Emulation.setDeviceMetricsOverride', { width: 1024, height: 860, deviceScaleFactor: 1, mobile: false })
  await ev(c, `location.hash='#/materias'`); await esperar(800)
  await ev(c, `[...document.querySelectorAll('a')].find(x=>x.innerText.includes('Álgebra Lineal')).click()`); await esperar(1200)
  for (const p of ['Plan y sesiones', 'Calificaciones', 'Materiales', 'Configuración']) {
    await ev(c, `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith(${JSON.stringify(p)})); b && b.click() })()`)
    await esperar(900)
    const d = await ev(c, 'document.documentElement.scrollWidth - document.documentElement.clientWidth')
    console.log(` 1024px  materia · ${p}: ${d > 2 ? `DESBORDA ${d}px` : 'ok'}`)
    if (d > 2) fallos.push(`materia · ${p} a 1024px desborda ${d}px`)
  }
  await c.enviar('Emulation.clearDeviceMetricsOverride')
  console.log('\n' + (fallos.length ? `FALLOS (${fallos.length}):` : 'Sin desbordes.'))
  fallos.forEach((f) => console.log('  •', f))
  c.cerrar()
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
