/**
 * Controla la app en desarrollo por el puerto de depuración (solo para pruebas).
 *   node scripts/ui.cjs "<expresión JS en el renderer>"
 *   node scripts/ui.cjs --shot <archivo.png>
 *   node scripts/ui.cjs --click "<texto del elemento>"
 */
const { writeFileSync } = require('fs')

async function conectar() {
  const targets = await (await fetch(`http://localhost:${process.env.DOCENTE_CDP_PUERTO || 9222}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('La app no está corriendo con depuración activa')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0
  const pendientes = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m); pendientes.delete(m.id) }
  }
  const enviar = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pendientes.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  return { enviar, cerrar: () => ws.close() }
}

const evaluar = async (c, expr) => {
  const r = await c.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'error en el renderer')
  return r.result.value
}

;(async () => {
  const c = await conectar()
  const [cmd, arg] = process.argv.slice(2)
  try {
    if (cmd === '--shot') {
      const r = await c.enviar('Page.captureScreenshot', { format: 'png' })
      writeFileSync(arg, Buffer.from(r.data, 'base64'))
      console.log('captura guardada en', arg)
    } else if (cmd === '--click') {
      const ok = await evaluar(c, `(() => {
        const t = ${JSON.stringify(arg)}.toLowerCase()
        const els = [...document.querySelectorAll('button, a, [role=button], select, li, td')]
        const el = els.find(e => (e.innerText||'').trim().toLowerCase().includes(t) && e.offsetParent !== null)
        if (!el) return 'NO ENCONTRADO: ' + t
        el.click()
        return 'clic en: ' + (el.innerText||'').trim().slice(0,60).replace(/\\n/g,' ')
      })()`)
      console.log(ok)
    } else {
      console.log(JSON.stringify(await evaluar(c, cmd), null, 2))
    }
  } finally {
    c.cerrar()
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
