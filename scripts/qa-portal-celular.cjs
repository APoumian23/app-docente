/**
 * El portal de alumnos en un navegador real a tamaño de celular (375×812 y 360 px), sobre una
 * COPIA temporal de la base: nada real se toca. El navegador es el mismo Electron del proyecto
 * (ventana oculta, user agent de iPhone, sesión en memoria), así que no hace falta instalar nada.
 *
 *   pnpm build:portal && node scripts/build-servidor.mjs
 *   pnpm exec electron scripts/qa-portal-celular.cjs
 *
 * Cubre: primer acceso con cambio de contraseña obligatorio; que ninguna pantalla del alumno se
 * salga a lo ancho (tablas y fórmulas largas se desplazan dentro de su bloque); autoguardado y
 * recarga; perder la red a media actividad (franja «Sin guardar», respaldo local, reintento);
 * tiempo agotado con y sin red; y la vigilancia (salidas normales sí cuentan, el selector de
 * archivos no).
 *
 * Las capturas quedan en QA_CAPTURAS (o en una carpeta temporal que se indica al final).
 */
const { app, BrowserWindow, session } = require('electron')
const { spawn, execFileSync } = require('child_process')
const { mkdtempSync, copyFileSync, existsSync, rmSync, writeFileSync, mkdirSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')

const RAIZ = join(__dirname, '..')
const PUERTO = Number(process.env.QA_PUERTO_CELULAR ?? 8792)
const BASE = `http://localhost:${PUERTO}`
const ORIGEN = join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite')
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const TOPE_MS = 240_000

const datos = mkdtempSync(join(tmpdir(), 'portal-celular-qa-'))
const capturas = process.env.QA_CAPTURAS || mkdtempSync(join(tmpdir(), 'portal-celular-capturas-'))
mkdirSync(capturas, { recursive: true })
const rutaBase = join(datos, 'docente.sqlite')

// Nada de este Electron se mezcla con la app instalada: perfil propio, temporal
app.setName('qa-portal-celular')
app.setPath('userData', join(datos, 'perfil'))
app.dock?.hide()

/** Escribe directo en la copia temporal (p. ej. para simular que pasó el tiempo de un examen). */
const sql = (consulta) => execFileSync('sqlite3', [rutaBase, consulta], { encoding: 'utf8' })
const textoSql = (t) => `'${String(t).replace(/'/g, "''")}'`

let servidor = null
let logServidor = ''
let terminado = false
function limpiar() {
  try { servidor?.kill() } catch { /* ya terminó */ }
  try { rmSync(datos, { recursive: true, force: true }) } catch { /* nada que borrar */ }
}
for (const senal of ['SIGINT', 'SIGTERM', 'SIGALRM', 'SIGHUP']) {
  process.on(senal, () => {
    console.log(`  ✗ interrumpido (${senal})`)
    limpiar()
    app.exit(1)
  })
}
process.on('exit', limpiar)

let pasos = 0
const fallos = []
const ok = (t) => { pasos++; console.log('  ✓', t) }
const falla = (t, e) => { fallos.push(`${t}: ${e}`); console.log('  ✗', t, '→', e) }
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const exige = (cond, msg) => { if (!cond) throw new Error(msg) }
const prueba = async (nombre, fn) => { try { await fn() } catch (e) { falla(nombre, e.message) } }

async function api(ruta, { metodo = 'GET', token, cuerpo } = {}) {
  const cab = {}
  if (token) cab.Authorization = `Bearer ${token}`
  if (cuerpo) cab['Content-Type'] = 'application/json'
  const r = await fetch(`${BASE}/api${ruta}`, { method: metodo, headers: cab, body: cuerpo ? JSON.stringify(cuerpo) : undefined })
  const tipo = r.headers.get('content-type') ?? ''
  return { estado: r.status, datos: tipo.includes('json') ? await r.json() : await r.text() }
}

// ---------- Navegador ----------

let win
let ses
let sinRed = async () => undefined
const js = (codigo, gesto = false) => win.webContents.executeJavaScript(codigo, gesto)

/** Espera a que una expresión del lado de la página sea verdadera. */
async function esperarQue(expr, ms, que) {
  const fin = Date.now() + ms
  let ultimo
  while (Date.now() < fin) {
    try {
      ultimo = await js(`(() => { try { return ${expr} } catch (e) { return false } })()`)
      if (ultimo) return ultimo
    } catch { /* la página se está recargando */ }
    await espera(150)
  }
  const visible = await js('document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, 300) : ""').catch(() => '')
  throw new Error(`no ocurrió en ${Math.round(ms / 1000)} s: ${que} · pantalla: «${visible}»`)
}

async function ir(ruta) {
  await win.loadURL(BASE + ruta)
}

async function recargar() {
  const listo = new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.reload()
  await listo
}

const textoPagina = () => js('document.body.innerText')

/** Funciones de apoyo dentro de la página (se instalan en cada carga). */
const APOYO = `
window.__qa = window.__qa || {
  poner(el, valor) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, valor)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  boton(texto) {
    return [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === texto && !b.disabled)
  },
  clic(texto) {
    const b = this.boton(texto)
    if (!b) throw new Error('no hay botón «' + texto + '»')
    b.click()
    return true
  },
  respuesta(i) { return document.querySelector('textarea[aria-label="Respuesta a la pregunta ' + (i + 1) + '"]') },
  opcion(i, n) { return document.querySelectorAll('[role=radiogroup]')[i]?.querySelectorAll('[role=radio]')[n] },
  cabecera() { return document.querySelector('header')?.innerText ?? '' },
  salidas() { const m = document.body.innerText.match(/Salidas registradas: (\\d+)/); return m ? Number(m[1]) : null },
  respaldo() {
    const k = Object.keys(localStorage).find((x) => x.startsWith('docente-portal.respaldo.'))
    return k ? JSON.parse(localStorage.getItem(k)) : null
  },
  visibilidad(estado) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => estado })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => estado === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  },
  /** Mide el ancho sin el overflow-x:hidden de html/body/#root: con él, lo que se sale queda cortado y no se ve. */
  ancho() {
    const st = document.createElement('style')
    st.textContent = 'html,body,#root{overflow-x:visible!important}'
    document.head.appendChild(st)
    const ancho = innerWidth
    const sw = document.documentElement.scrollWidth
    const culpables = []
    const fuera = (r) => r.right > ancho + 1 || r.left < -1
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || !fuera(r)) continue
      if (el.parentElement && fuera(el.parentElement.getBoundingClientRect()) && el.parentElement !== document.body) continue
      let p = el.parentElement, contenido = false
      while (p && p !== document.body) {
        const cs = getComputedStyle(p)
        if (cs.overflowX !== 'visible' && p.id !== 'root' && !fuera(p.getBoundingClientRect())) { contenido = true; break }
        p = p.parentElement
      }
      if (contenido) continue
      culpables.push('<' + el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? ' class="' + el.className.slice(0, 60) + '"' : '') + '> ' + Math.round(r.left) + '…' + Math.round(r.right) + 'px «' + (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40) + '»')
    }
    st.remove()
    return { ancho, sw, culpables: culpables.slice(0, 4) }
  },
  /** Un bloque ancho (tabla, fórmula) debe caber en pantalla y desplazarse por dentro. */
  bloque(sel) {
    const el = document.querySelector(sel)
    if (!el) return { existe: false }
    const r = el.getBoundingClientRect()
    const antes = el.scrollLeft
    el.scrollLeft = 60
    const desplaza = el.scrollLeft > antes
    el.scrollLeft = antes
    return { existe: true, cabe: r.left >= -1 && r.right <= innerWidth + 1, ancho: el.clientWidth, contenido: el.scrollWidth, overflowX: getComputedStyle(el).overflowX, desplaza }
  }
}
true`
const apoyo = () => js(APOYO)

async function capturar(nombre) {
  const img = await win.webContents.capturePage()
  const ruta = join(capturas, `${nombre}.png`)
  writeFileSync(ruta, img.toPNG())
  return ruta
}

async function anchoDe(w) {
  win.setContentSize(w, 812)
  await esperarQue(`innerWidth === ${w}`, 3000, `ventana de ${w} px`)
  await espera(250)
}

/** Ninguna parte de la pantalla actual se sale a lo ancho, a 375 y a 360 px. */
async function revisarAncho(pantalla) {
  await prueba(`${pantalla} cabe a lo ancho`, async () => {
    const problemas = []
    for (const w of [375, 360]) {
      await anchoDe(w)
      await apoyo()
      const r = await js('__qa.ancho()')
      if (r.sw > r.ancho) problemas.push(`a ${w} px el contenido mide ${r.sw} px: ${r.culpables.join(' · ') || 'sin culpable identificado'}`)
    }
    await anchoDe(375)
    exige(!problemas.length, problemas.join(' | '))
    ok(`${pantalla}: sin desplazamiento horizontal a 375 ni a 360 px`)
  })
}

// ---------- Contenido de prueba ----------

const TABLA = [
  '| n | 10 | 100 | 1 000 | 10 000 | 100 000 | 1 000 000 | 10 000 000 |',
  '|---|---|---|---|---|---|---|---|',
  '| log₂ n | 3.32 | 6.64 | 9.97 | 13.29 | 16.61 | 19.93 | 23.25 |',
  '| n log₂ n | 33.2 | 664.4 | 9 965.8 | 132 877.1 | 1 660 964.0 | 19 931 568.6 | 232 534 966.6 |',
  '| n² | 100 | 10 000 | 1 000 000 | 100 000 000 | 10 000 000 000 | 1 000 000 000 000 | 100 000 000 000 000 |'
].join('\n')
const CONTENIDO = {
  titulo: 'QA celular',
  instrucciones: 'Contesta desde el celular. Consulta https://ejemplo.escuela.edu.mx/recursos/analisis-de-algoritmos/unidad-dos/recurrencias-y-teorema-maestro si lo necesitas.',
  preguntas: [
    { tipo: 'opcion_multiple', enunciado: '¿Cuál es la complejidad de la búsqueda binaria?', opciones: ['$O(n)$', '$O(\\log n)$', '$O(n^2)$', '$O(1)$'], respuesta: '$O(\\log n)$', puntos: 1, explicacion: '' },
    { tipo: 'abierta', enunciado: `Observa la tabla y explica la tendencia:\n\n${TABLA}`, puntos: 2, respuesta: '', explicacion: '' },
    {
      tipo: 'problema',
      enunciado:
        'Resuelve la recurrencia:\n\n$$\nT(n) = 2T\\left(\\frac{n}{2}\\right) + n \\log n = \\sum_{i=0}^{\\log_2 n - 1} 2^i \\cdot \\frac{n}{2^i} \\log\\left(\\frac{n}{2^i}\\right) = n \\sum_{i=0}^{\\log_2 n - 1} \\left(\\log n - i\\right) = \\Theta\\left(n \\log^2 n\\right)\n$$\n\ny el polinomio en línea $f(n) = a_0 + a_1 n + a_2 n^2 + a_3 n^3 + a_4 n^4 + a_5 n^5 + a_6 n^6 + a_7 n^7 + a_8 n^8 + a_9 n^9$.\n\n```\npara i = 1 hasta n:  para j = i + 1 hasta n:  si A[i] > A[j]: intercambiar(A[i], A[j])  // comparación de la burbuja\n```',
      puntos: 2,
      respuesta: '',
      explicacion: ''
    },
    { tipo: 'verdadero_falso', enunciado: 'Todo algoritmo $O(n)$ es también $O(n^2)$.', respuesta: 'Verdadero', puntos: 1, explicacion: '' },
    { tipo: 'abierta', enunciado: 'Describe en una frase qué es un invariante de ciclo.', puntos: 1, respuesta: '', explicacion: '' },
    { tipo: 'abierta', enunciado: '¿Qué harías si el celular pierde la red durante el examen?', puntos: 1, respuesta: '', explicacion: '' },
    { tipo: 'codigo', enunciado: 'Escribe en Python la función `suma(n)` que sume del 1 al n e imprime `suma(10)`.', respuesta: 'def suma(n):\n    return n * (n + 1) // 2', puntos: 2, explicacion: '' }
  ]
}

// ---------- Recorrido ----------

async function recorrido() {
  // Copia consistente aunque la app esté abierta (la base usa WAL: copiar solo el .sqlite perdería lo último)
  exige(existsSync(ORIGEN), `no existe la base de origen ${ORIGEN}`)
  try {
    execFileSync('sqlite3', ['-readonly', ORIGEN, `VACUUM INTO ${textoSql(rutaBase)}`])
  } catch {
    copyFileSync(ORIGEN, rutaBase)
  }
  sql("INSERT INTO ajustes (clave, valor) VALUES ('portal_docente_usuario', 'profe') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")

  // better-sqlite3 está compilado para Electron: el servidor corre con este mismo binario como Node
  servidor = spawn(process.execPath, ['dist/servidor/index.mjs'], {
    cwd: RAIZ,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORTAL_DATOS: datos, PORTAL_PUERTO: String(PUERTO), PORTAL_DOCENTE: 'profe:Secreto-123!:Docente de prueba' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  servidor.stdout.on('data', (d) => (logServidor += d))
  servidor.stderr.on('data', (d) => (logServidor += d))
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/salud`)).ok) break } catch { /* aún no */ }
    exige(i < 60, 'el servidor no respondió\n' + logServidor.slice(-1500))
    await espera(250)
  }
  ok(`servidor en :${PUERTO} sobre una copia temporal de la base`)

  // ---------- Datos por la API del docente ----------
  const login = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'profe', password: 'Secreto-123!' } })
  exige(login.estado === 200, 'login del docente: ' + JSON.stringify(login.datos))
  const docente = login.datos.sesion.token
  const materias = (await api('/docente/materias', { token: docente })).datos
  exige(Array.isArray(materias) && materias.length, 'la base no tiene materias')
  // Análisis y Diseño de Algoritmos tiene parciales y faltas que revisar en «Mi avance»; si no está, la primera
  const materia = materias.find((m) => /Análisis y Diseño de Algoritmos/.test(m.nombre)) ?? materias[0]
  const matricula = `QACEL${String(Date.now()).slice(-6)}`
  const ins = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: { matricula, nombre: 'Celia', apellidos: 'Prueba Celular' } })
  exige(ins.estado === 200, 'inscribir alumno: ' + JSON.stringify(ins.datos))
  const acc = await api(`/docente/materias/${materia.id}/accesos`, { metodo: 'POST', token: docente })
  const acceso = acc.datos.creados?.find((c) => c.matricula === matricula)
  exige(acceso, 'no se creó el acceso del alumno: ' + JSON.stringify(acc.datos).slice(0, 200))
  const evaluacionId = Number(
    sql(`INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (${materia.id}, 'examen', 'QA celular', ${textoSql(JSON.stringify(CONTENIDO))}, 10); SELECT last_insert_rowid();`).trim()
  )
  const publicar = async (extra) => {
    const r = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacionId, materia_id: materia.id, ...extra } })
    exige(r.estado === 200 && r.datos.id, 'publicar: ' + JSON.stringify(r.datos))
    return r.datos
  }
  const asigVigilada = await publicar({ titulo: 'QA celular · con vigilancia', vigilancia: true, permite_archivos: true, permite_borrador: true, duracion_min: 30 })
  const asigMinuto = await publicar({ titulo: 'QA celular · 1 minuto', duracion_min: 1 })
  const asigSinRed = await publicar({ titulo: 'QA celular · 1 minuto sin red', duracion_min: 1 })
  ok(`datos: alumno ${matricula} en «${materia.nombre}» y 3 actividades (vigilada 30 min, 1 min, 1 min sin red)`)

  /** El intento del alumno en una actividad, visto por el docente. */
  const intentoDe = async (asig) => {
    const r = await api(`/docente/asignaciones/${asig.id}/entregas`, { token: docente })
    const fila = r.datos.entregas?.find((e) => e.alumno_matricula === matricula)
    if (!fila || fila.estado === 'sin_iniciar') return null
    return (await api(`/docente/intentos/${fila.id}`, { token: docente })).datos
  }

  // ---------- Navegador de celular ----------
  ses = session.fromPartition(`qa-celular-${Date.now()}`) // sin "persist:": todo en memoria
  ses.setUserAgent(UA_IPHONE)
  win = new BrowserWindow({
    width: 375,
    height: 812,
    useContentSize: true,
    show: false,
    fullscreenable: false,
    webPreferences: { session: ses, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const cdp = win.webContents.debugger
  cdp.attach('1.3')
  // Los comandos de CDP se cuelgan si se mandan antes de que haya una página: primero una en blanco
  await win.loadURL('about:blank')
  await cdp.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await cdp.sendCommand('Network.enable')
  /** Corta o devuelve la red: la sesión hace fallar las peticiones y CDP, además, avisa a la página (navigator.onLine y eventos offline/online). */
  sinRed = async (cortar) => {
    await ses.enableNetworkEmulation({ offline: cortar })
    await cdp.sendCommand('Network.emulateNetworkConditions', { offline: cortar, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  }
  const consola = []
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) consola.push(String(e.message).slice(0, 200)) })

  // ---------- 1. Primer acceso ----------
  await prueba('primer acceso: matrícula, cambio obligatorio y llegada a Actividades', async () => {
    await ir('/entrar')
    await apoyo()
    await esperarQue('document.querySelector("input[autocomplete=username]")', 8000, 'formulario de entrada')
    exige((await js('navigator.userAgent')).includes('iPhone'), 'el user agent no es de iPhone')
    await revisarAncho('Entrar')
    await js(`__qa.poner(document.querySelector('input[autocomplete=username]'), ${JSON.stringify(matricula)}); __qa.poner(document.querySelector('input[autocomplete=current-password]'), ${JSON.stringify(acceso.password)}); __qa.clic('Entrar')`)
    await esperarQue('location.pathname === "/cuenta" && location.search.includes("primera=1") && document.body.innerText.includes("Crea tu contraseña")', 8000, 'pantalla de contraseña obligatoria')
    ok('con la contraseña inicial lleva a «Crea tu contraseña»')
    // Intentar saltarse el cambio regresa a la misma pantalla
    await ir('/calificaciones')
    await esperarQue('location.pathname === "/cuenta" && document.body.innerText.includes("Crea tu contraseña")', 8000, 'redirección a /cuenta')
    await apoyo()
    await revisarAncho('Cuenta (primer acceso)')
    await js(`const c = document.querySelectorAll('input[autocomplete=new-password]'); const a = document.querySelector('input[autocomplete=current-password]'); if (a) __qa.poner(a, ${JSON.stringify(acceso.password)}); __qa.poner(c[0], 'Celular-2026'); __qa.poner(c[1], 'Celular-2026'); __qa.clic('Guardar contraseña')`)
    // Tras cambiarla regresa a donde quería ir (Calificaciones), no al inicio
    await esperarQue('location.pathname === "/calificaciones"', 10000, 'regreso a la pantalla que pidió')
    await ir('/')
    await esperarQue(`location.pathname === "/" && document.body.innerText.includes(${JSON.stringify(asigVigilada.titulo)})`, 10000, 'lista de actividades')
    ok('saltarse el cambio no deja pasar; tras cambiarla regresa a donde iba y ve sus 3 actividades')
  })
  await apoyo()
  await revisarAncho('Actividades')
  await prueba('el detector de desbordes sí detecta uno', async () => {
    // Control: si un bloque de 600 px no se detecta, todos los «cabe a lo ancho» de arriba no valen nada
    const r = await js('(() => { const d = document.createElement("div"); d.style.width = "600px"; d.style.height = "10px"; d.textContent = "x"; document.querySelector("main, #root").appendChild(d); const r = __qa.ancho(); d.remove(); return r })()')
    exige(r.sw > r.ancho && r.culpables.length > 0, JSON.stringify(r))
    ok(`control: un bloque de 600 px se detecta (${r.sw} px > ${r.ancho} px)`)
  })
  console.log('    captura:', await capturar('1-actividades-375'))

  // ---------- 2-3. Actividad con tabla y fórmula; autoguardado y recarga ----------
  await prueba('abrir la actividad vigilada y comenzar', async () => {
    await js(`[...document.querySelectorAll('h3')].find((h) => h.innerText === ${JSON.stringify(asigVigilada.titulo)}).closest('.space-y-3').querySelector('button').click()`)
    await esperarQue('__qa.boton("Comenzar")', 8000, 'pantalla de inicio de la actividad')
    ok('la tarjeta abre la pantalla de inicio con reglas y botón Comenzar')
  })
  await apoyo()
  await revisarAncho('Inicio de actividad (instrucciones con URL larga)')
  await prueba('comenzar muestra las preguntas', async () => {
    await js('__qa.clic("Comenzar")')
    await esperarQue('document.querySelectorAll("[role=radiogroup]").length >= 2 && __qa.respuesta(1)', 10000, 'preguntas')
    ok('preguntas visibles con cuenta regresiva y vigilancia')
  })
  await revisarAncho('Actividad con tabla, fórmula y código')
  await prueba('tabla Markdown ancha y fórmulas largas se desplazan dentro de su bloque', async () => {
    const detalle = []
    for (const w of [375, 360]) {
      await anchoDe(w)
      for (const [nombre, sel] of [['tabla', '.prosa table'], ['fórmula en bloque', '.prosa .katex-display'], ['fórmula en línea', '.prosa p .katex'], ['código', '.prosa pre']]) {
        const b = await js(`__qa.bloque(${JSON.stringify(sel)})`)
        if (!b.existe) { detalle.push(`${nombre}: no se encontró ${sel}`); continue }
        if (!b.cabe) detalle.push(`${nombre} a ${w} px se sale de la pantalla`)
        else if (b.contenido > b.ancho && !b.desplaza) detalle.push(`${nombre} a ${w} px mide ${b.contenido} px en ${b.ancho} px y no se desplaza (overflow-x: ${b.overflowX})`)
      }
    }
    await anchoDe(375)
    exige(!detalle.length, detalle.join(' · '))
    ok('tabla, fórmula en bloque, fórmula en línea y código caben y se desplazan por dentro a 375 y 360 px')
  })
  await prueba('las opciones con fórmulas se ven como fórmulas, no como LaTeX crudo', async () => {
    // Las evaluaciones reales traen opciones como «$n(n-1)/2$»
    const crudas = await js('[...document.querySelectorAll("[role=radio]")].map((b) => b.innerText.trim()).filter((t) => /\\$[^$]+\\$/.test(t))')
    exige(!crudas.length, `${crudas.length} opciones muestran el LaTeX tal cual, p. ej. «${crudas.slice(0, 2).join('», «')}»`)
    ok('opciones con fórmulas renderizadas')
  })
  await prueba('pregunta de código: editor y Python en el celular, sin internet', async () => {
    // El editor se carga aparte (solo en actividades con código) y Python sale del servidor del salón
    await esperarQue('document.querySelector(".cm-content")', 20000, 'editor de código')
    await js(`document.querySelector('.cm-content').cmTile.view.dispatch({ changes: { from: 0, insert: 'def suma(n):\\n    return n * (n + 1) // 2\\n\\nprint(suma(10))\\n' } })`)
    await js('__qa.clic("▶ Ejecutar")')
    try {
      await esperarQue('(document.querySelector("[role=log]")?.innerText ?? "").includes("55")', 60000, 'salida de Python')
    } catch {
      throw new Error(`Python no imprimió «55»; la consola dice: «${(await js('document.querySelector("[role=log]")?.innerText ?? "(sin consola)"')).slice(0, 400)}»`)
    }
    const guardada = await js('JSON.stringify(__qa.respaldo()?.respuestas ?? {})')
    exige(guardada.includes('def suma'), `la respuesta de código no quedó en el respaldo local: ${guardada.slice(0, 200)}`)
    ok('el alumno escribe, pulsa «Ejecutar», ve «55» y su código queda como respuesta')
  })
  await revisarAncho('Actividad con editor de código')
  await js('document.querySelector(".cm-content").scrollIntoView({ block: "start" })')
  console.log('    captura:', await capturar('2b-codigo-375'))
  await js('window.scrollTo(0, 0)')
  console.log('    captura:', await capturar('2-actividad-375'))

  let intentoVigilado
  await prueba('contestar, ver «Guardado» y recargar sin perder nada', async () => {
    await js('__qa.opcion(0, 1).click(); __qa.poner(__qa.respuesta(1), "Crece cada vez más rápido: n² domina.")')
    await esperarQue('/Guardado a las/.test(__qa.cabecera())', 10000, 'indicador «Guardado»')
    intentoVigilado = await intentoDe(asigVigilada)
    exige(intentoVigilado?.respuestas?.['0'] === '$O(\\log n)$' && intentoVigilado.respuestas['1']?.startsWith('Crece'), 'el servidor no tiene las respuestas: ' + JSON.stringify(intentoVigilado?.respuestas))
    // Sin el respaldo del teléfono: lo que aparezca tras recargar viene del servidor
    await js('Object.keys(localStorage).filter((k) => k.startsWith("docente-portal.respaldo.")).forEach((k) => localStorage.removeItem(k))')
    await recargar()
    await apoyo()
    await esperarQue('__qa.respuesta(1)', 10000, 'preguntas tras recargar')
    const tras = await js('({ opcion: __qa.opcion(0, 1).getAttribute("aria-checked"), texto: __qa.respuesta(1).value })')
    exige(tras.opcion === 'true' && tras.texto.startsWith('Crece'), 'tras recargar: ' + JSON.stringify(tras))
    ok('«Guardado» aparece, el docente ve las respuestas y siguen ahí tras recargar (sin respaldo local)')
  })

  // ---------- 4. Sin red ----------
  await prueba('sin red: franja «Sin guardar», respaldo local y recuperación al volver', async () => {
    await sinRed(true)
    await espera(200)
    const enLinea = await js('navigator.onLine')
    await js('__qa.poner(__qa.respuesta(4), "Una propiedad que se cumple antes y después de cada vuelta.")')
    await esperarQue('/Sin guardar · reintentando/.test(document.querySelector("[role=status]")?.innerText ?? "")', 10000, 'franja «Sin guardar · reintentando»')
    const pie = await textoPagina()
    exige(pie.includes('Hay cambios sin guardar y no hay conexión'), 'falta el aviso junto al botón Enviar')
    const r = await js('__qa.respaldo()')
    exige(r?.respuestas?.['4']?.startsWith('Una propiedad'), 'el respaldo local no tiene la respuesta: ' + JSON.stringify(r))
    const antes = await intentoDe(asigVigilada)
    exige(!antes.respuestas['4'], 'el servidor ya la tenía estando sin red (la emulación no cortó la red)')
    ok(`franja «Sin guardar · reintentando» y aviso junto a Enviar; respaldo local con la respuesta (navigator.onLine=${enLinea})`)
    console.log('    captura:', await capturar('3-sin-red-375'))
    await sinRed(false)
    await esperarQue('!document.querySelector("[role=status]") && /Guardado a las/.test(__qa.cabecera())', 25000, 'la franja desaparece y vuelve «Guardado»')
    const despues = await intentoDe(asigVigilada)
    exige(despues.respuestas['4']?.startsWith('Una propiedad'), 'el servidor no recibió la respuesta tras volver la red')
    ok('al volver la red la franja desaparece y el docente ve la respuesta escrita sin red')
  })
  await sinRed(false)

  // ---------- 6. Vigilancia ----------
  await prueba('vigilancia: cambiar de pestaña cuenta una salida', async () => {
    const n0 = await js('__qa.salidas()')
    exige(n0 !== null, 'no se ve «Salidas registradas»')
    await js('__qa.visibilidad("hidden"); window.dispatchEvent(new Event("blur"))')
    await esperarQue(`__qa.salidas() === ${n0 + 1}`, 3000, 'salida contada')
    await js('__qa.visibilidad("visible"); window.dispatchEvent(new Event("focus"))')
    await espera(1200)
    await js('window.dispatchEvent(new Event("blur"))')
    await esperarQue(`__qa.salidas() === ${n0 + 2}`, 3000, 'segunda salida contada')
    await js('window.dispatchEvent(new Event("focus"))')
    ok(`blur + visibilitychange a la vez cuentan 1 salida; otro blur después cuenta otra (${n0} → ${n0 + 2})`)
  })
  await prueba('vigilancia: abrir el selector de archivos no cuenta como salida', async () => {
    await espera(1200)
    const n0 = await js('__qa.salidas()')
    await cdp.sendCommand('Page.enable')
    await cdp.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    const abierto = new Promise((r, rechazar) => {
      const t = setTimeout(() => rechazar(new Error('el clic no abrió el selector de archivos')), 5000)
      const al = (_e, metodo, params) => { if (metodo === 'Page.fileChooserOpened') { clearTimeout(t); cdp.off('message', al); r(params) } }
      cdp.on('message', al)
    })
    // Clic real (con gesto de usuario) en el input: dispara el onClick que marca «eligiendo archivo»
    await js('document.querySelector("input[type=file]").click()', true)
    const selector = await abierto
    // En el celular, la cámara o la galería sacan de la página y luego regresan
    await js('__qa.visibilidad("hidden"); window.dispatchEvent(new Event("blur"))')
    await espera(400)
    await js('__qa.visibilidad("visible"); window.dispatchEvent(new Event("focus"))')
    const archivo = join(datos, 'tarea-celular.txt')
    writeFileSync(archivo, 'entrega desde el celular')
    await cdp.sendCommand('DOM.setFileInputFiles', { files: [archivo], backendNodeId: selector.backendNodeId })
    await esperarQue('document.body.innerText.includes("tarea-celular.txt")', 8000, 'archivo subido en la lista')
    exige((await js('__qa.salidas()')) === n0, `el selector contó como salida (${n0} → ${await js('__qa.salidas()')})`)
    await cdp.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
    const det = await intentoDe(asigVigilada)
    exige(det.eventos_lista.some((e) => e.detalle === 'al elegir un archivo para subir'), 'no se anotó el evento «al elegir un archivo»')
    exige(det.archivos.some((a) => a.nombre === 'tarea-celular.txt'), 'el docente no ve el archivo')
    // Pasado el margen, salir sí vuelve a contar
    await espera(2500)
    await js('window.dispatchEvent(new Event("blur"))')
    await esperarQue(`__qa.salidas() === ${n0 + 1}`, 3000, 'salida contada después de elegir el archivo')
    await js('window.dispatchEvent(new Event("focus"))')
    ok(`elegir y subir un archivo deja «Salidas registradas: ${n0}» (se anota aparte); 2 s después una salida normal sí cuenta`)
  })

  await prueba('enviar la actividad vigilada desde el celular', async () => {
    await js('__qa.clic("Enviar")')
    await esperarQue('__qa.boton("Enviar ahora")', 5000, 'confirmación de envío')
    await apoyo()
    await revisarAncho('Confirmación de envío')
    await js('__qa.clic("Enviar ahora")')
    await esperarQue('document.body.innerText.includes("Tiempo activo") && __qa.boton("Volver a mis actividades")', 10000, 'pantalla de resultado')
    const det = await intentoDe(asigVigilada)
    exige(['enviado', 'calificado'].includes(det.estado), `quedó ${det.estado}`)
    exige(!(await js('__qa.respaldo()')), 'el respaldo local sigue después de enviar')
    ok(`enviada: el docente la ve «${det.estado}» y el respaldo local se borró`)
  })
  await apoyo()
  await revisarAncho('Resultado de la actividad')

  // ---------- 5. Tiempo agotado ----------
  const comenzar = async (asig) => {
    await ir(`/actividad/${asig.id}`)
    await apoyo()
    await esperarQue('__qa.boton("Comenzar")', 8000, 'botón Comenzar')
    await js('__qa.clic("Comenzar")')
    await esperarQue('__qa.respuesta(4) && document.querySelector("[aria-label=\'Tiempo restante\']")', 10000, 'preguntas con cuenta regresiva')
    await js('__qa.opcion(0, 1).click()')
    await esperarQue('/Guardado a las/.test(__qa.cabecera())', 10000, '«Guardado»')
    const i = await intentoDe(asig)
    exige(i, 'el docente no ve el intento')
    return i
  }
  /** Simula que ya pasó casi todo el minuto y recarga: la cuenta regresiva parte de iniciado_en. */
  const casiSinTiempo = async (intento, segundos) => {
    sql(`UPDATE intentos SET iniciado_en = datetime('now', '-${segundos} seconds') WHERE id = ${intento.id}`)
    await recargar()
    await apoyo()
    await esperarQue('__qa.respuesta(4)', 10000, 'preguntas tras recargar')
    const reloj = await js('document.querySelector("[aria-label=\'Tiempo restante\']").innerText')
    exige(/^00:(0\d|1\d)$/.test(reloj), `la cuenta regresiva muestra ${reloj}`)
    return reloj
  }

  await prueba('tiempo agotado: la pantalla envía sola y el docente la ve con lo guardado', async () => {
    const intento = await comenzar(asigMinuto)
    const reloj = await casiSinTiempo(intento, 50)
    await js('__qa.poner(__qa.respuesta(4), "Respuesta de último segundo")')
    await esperarQue('document.body.innerText.includes("Tiempo activo") && __qa.boton("Volver a mis actividades")', 30000, 'envío automático al agotarse el tiempo')
    const det = await intentoDe(asigMinuto)
    exige(['enviado', 'calificado'].includes(det.estado), `quedó ${det.estado}`)
    exige(det.respuestas['0'] === '$O(\\log n)$' && det.respuestas['4'] === 'Respuesta de último segundo', 'respuestas del docente: ' + JSON.stringify(det.respuestas))
    ok(`con ${reloj} restantes contesta otra; al llegar a 00:00 se envía sola y el docente la ve «${det.estado}» con ambas respuestas`)
  })

  await prueba('tiempo agotado sin red: espera la red, conserva lo escrito y se envía al volver', async () => {
    const intento = await comenzar(asigSinRed)
    await casiSinTiempo(intento, 50)
    await sinRed(true)
    await espera(200)
    await js('__qa.poner(__qa.respuesta(4), "Escrita sin red al final")')
    await esperarQue('document.body.innerText.includes("Se agotó el tiempo · enviando en cuanto haya conexión")', 20000, 'franja «Se agotó el tiempo · enviando en cuanto haya conexión»')
    const r = await js('__qa.respaldo()')
    exige(r?.respuestas?.['4'] === 'Escrita sin red al final', 'el respaldo local no tiene lo escrito sin red')
    const antes = await intentoDe(asigSinRed)
    exige(['en_curso', 'borrador'].includes(antes.estado), `el servidor ya la cerró (${antes.estado}) antes de volver la red`)
    console.log('    captura:', await capturar('4-tiempo-agotado-sin-red-375'))
    await sinRed(false)
    await esperarQue('document.body.innerText.includes("Tiempo activo") && __qa.boton("Volver a mis actividades")', 25000, 'envío al volver la red')
    const det = await intentoDe(asigSinRed)
    exige(['enviado', 'calificado'].includes(det.estado), `quedó ${det.estado}`)
    exige(det.respuestas['4'] === 'Escrita sin red al final', 'el docente no ve lo escrito sin red: ' + JSON.stringify(det.respuestas))
    ok(`franja de tiempo agotado sin red con respaldo local; al volver la red se envía y el docente la ve «${det.estado}» con lo escrito sin red`)
  })
  await sinRed(false)

  // ---------- 2. Resto de pantallas, ya con entregas ----------
  await ir('/')
  await apoyo()
  await esperarQue('/entregadas/i.test(document.body.innerText)', 8000, 'Actividades')
  await revisarAncho('Actividades con entregas')
  await ir('/calificaciones')
  await apoyo()
  await esperarQue(`document.body.innerText.includes(${JSON.stringify(asigMinuto.titulo)})`, 8000, 'Calificaciones con entregas')
  await revisarAncho('Calificaciones')
  await prueba('Calificaciones: parciales, tareas y entregas del portal con filtro por parcial', async () => {
    const t = await js('document.body.innerText')
    // Los títulos de sección van en mayúsculas por estilo: se compara sin distinguir
    const faltan = ['Calificación del parcial', 'Exámenes y actividades del portal', 'Parcial 1'].filter((x) => !t.toLowerCase().includes(x.toLowerCase()))
    exige(!faltan.length, `faltan: ${faltan.join(', ')} · «${t.replace(/\s+/g, ' ').slice(0, 600)}»`)
    // Filtrar por un parcial deja fuera lo de otros parciales y se puede quitar
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Parcial 3'))?.click()`)
    await esperarQue('/Quitar filtros/.test(document.body.innerText)', 5000, 'filtro de parcial aplicado')
    await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Quitar filtros')?.click()`)
    await esperarQue(`document.body.innerText.includes(${JSON.stringify(asigMinuto.titulo)})`, 5000, 'sin filtros vuelven las entregas')
    ok('Calificaciones: parciales, tareas y entregas del portal con filtro por parcial')
  })
  await ir('/cuenta')
  await apoyo()
  await esperarQue('document.body.innerText.includes("Cambiar contraseña")', 8000, 'Cuenta')
  await revisarAncho('Cuenta')
  await ir('/notificaciones')
  await apoyo()
  await esperarQue('location.pathname === "/notificaciones" && document.body.innerText.length > 40', 8000, 'Notificaciones')
  await revisarAncho('Notificaciones')

  // Apartado del alumno: su avance (calificaciones por parcial y faltas) y su editor de código
  await ir('/avance')
  await apoyo()
  await esperarQue(`document.body.innerText.includes("Faltas") && document.body.innerText.includes(${JSON.stringify(materia.nombre)})`, 15000, 'Mi avance')
  await prueba('Mi avance: parciales, faltas contra el límite y próximas fechas', async () => {
    const t = await js('document.body.innerText')
    // Los parciales empiezan sin publicar: el alumno ve «En captura» y no la final
    exige(/Parcial 1/.test(t) && /En captura/.test(t) && /Llevas .* h de falta/.test(t) && /aparecerán cuando tu docente publique/.test(t), `faltan datos en Mi avance: «${t.slice(0, 300)}»`)
    ok('Mi avance: parciales «En captura» hasta que se publican, horas de falta contra el límite')
  })
  await revisarAncho('Mi avance')
  await ir('/programar')
  await apoyo()
  await esperarQue('document.body.innerText.includes("Nuevo programa en Python")', 10000, 'Programar vacío')
  await prueba('Programar: crea un programa, lo corre y se guarda en el servidor', async () => {
    await js('__qa.clic("Nuevo programa en Python")')
    await esperarQue('document.querySelector(".cm-content")', 20000, 'editor')
    await js(`document.querySelector('.cm-content').cmTile.view.dispatch({ changes: { from: 0, to: document.querySelector('.cm-content').cmTile.view.state.doc.length, insert: 'print(sum(range(1, 101)))\\n' } })`)
    await js('__qa.clic("▶ Ejecutar")')
    await esperarQue('(document.querySelector("[role=log]")?.innerText ?? "").includes("5050")', 60000, 'salida 5050')
    await esperarQue('document.body.innerText.includes("Guardado")', 8000, 'guardado en el servidor')
    ok('el alumno crea un programa, ve «5050» al ejecutarlo y queda guardado')
  })
  await revisarAncho('Programar (alumno)')
  console.log('    captura:', await capturar('5-programar-375'))

  if (consola.length) console.log(`    (errores en la consola del navegador: ${[...new Set(consola)].slice(0, 3).join(' · ')})`)
}

app.whenReady().then(async () => {
  const tope = setTimeout(() => {
    console.log(`  ✗ las pruebas del portal en celular no terminaron en ${TOPE_MS / 60000} minutos (se cortan)`)
    limpiar()
    app.exit(1)
  }, TOPE_MS)
  try {
    await recorrido()
  } catch (e) {
    falla('recorrido', e.message)
  } finally {
    clearTimeout(tope)
    terminado = true
    try { win?.destroy() } catch { /* ya cerrada */ }
    limpiar()
  }
  console.log(`\n${pasos} comprobaciones correctas · ${fallos.length} fallos`)
  fallos.forEach((f) => console.log('  •', f))
  console.log(`  capturas en ${capturas}`)
  if (fallos.length && /Error|error/.test(logServidor)) console.log('\n--- salida del servidor ---\n' + logServidor.slice(-2000))
  app.exit(fallos.length ? 1 : 0)
})
app.on('window-all-closed', () => { if (!terminado) { /* la ventana es oculta; no se cierra sola */ } })
