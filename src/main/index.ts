import { app, BrowserWindow, Menu, dialog, protocol, net } from 'electron'
import { join, relative, isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registrarIpc } from './ipc'
import { respuestaPyodide } from './services/pyodide'
import { materialesDir, getAjuste, respaldoDiario, falloDelRespaldoPrevio } from './db'
import { iniciarPortal, apagarAlSalir, origenPanel } from './services/portal'
import { configRemoto } from './services/portal-remoto'
import { blindarNavegacion } from './abrir'
import { archivoEnCache } from './services/classroom'
import { arrancarAvisos } from './services/avisos'
import { copiarAExterna } from './services/respaldos'
import { instalarCapturaDeErrores, registrarError } from './services/errores'

// Esquema propio para mostrar PDFs/archivos locales dentro de la app sin abrir file:// al renderer.
protocol.registerSchemesAsPrivileged([{ scheme: 'docente', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true } }])

/**
 * La ventana principal se guarda aparte: getAllWindows() también trae la ventana oculta de PDFs
 * y la del panel del portal, y con ellas el Dock no reabría la principal tras cerrarla con ⌘W.
 */
let principal: BrowserWindow | null = null

function crearVentana(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'App_Docente',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#f5f7fa',
    // El preload solo usa contextBridge e ipcRenderer: corre aislado (sandbox) como recomienda Electron
    // webviewTag: el panel del portal se ve dentro de la ventana (página «Panel del portal»); ver will-attach-webview
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, zoomFactor: 1, webviewTag: true }
  })
  principal = win
  win.on('closed', () => {
    if (principal === win) principal = null
  })
  win.on('ready-to-show', () => win.show())
  // El zoom de Chromium agranda toda la ventana (barra lateral incluida). Lo controla la app según el ancho:
  // hasta 1500 px queda al 100 %; en monitores grandes crece hasta 140 % para que la letra no se vea diminuta.
  // Como cambia el ancho de la página, los puntos de quiebre (lg, xl…) siguen correspondiendo a lo que se ve.
  // El tamaño que elige el docente (⌘+ / ⌘- / ⌘0) va aparte y solo agranda el contenido.
  // Chromium guarda el zoom por dirección completa (incluido el #/ruta) y lo vuelve a aplicar al navegar,
  // así que se reaplica en cada carga, cambio de ruta y cambio de tamaño.
  const ajustarZoom = (): void => {
    if (win.isDestroyed()) return
    const ancho = win.getContentBounds().width
    win.webContents.setZoomFactor(Math.min(1.4, Math.max(1, Math.round((ancho / 1500) * 20) / 20)))
  }
  ajustarZoom()
  win.webContents.setVisualZoomLevelLimits(1, 1)
  win.webContents.on('did-finish-load', ajustarZoom)
  win.webContents.on('did-navigate-in-page', ajustarZoom)
  win.on('resize', ajustarZoom)
  // ⌘ + rueda del ratón o pellizco: en vez de agrandar toda la ventana, cambia solo el contenido
  win.webContents.on('zoom-changed', (e, direccion) => {
    e.preventDefault()
    win.webContents.send('ui:zoom', direccion === 'in' ? 1 : -1)
    ajustarZoom()
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// En desarrollo se abre el puerto de depuración para poder inspeccionar y automatizar la UI.
// DOCENTE_CDP_PUERTO permite otra instancia de desarrollo a la vez (por omisión 9222)
if (is.dev) app.commandLine.appendSwitch('remote-debugging-port', process.env.DOCENTE_CDP_PUERTO || '9222')

// DOCENTE_DATOS apunta la app a otra carpeta de datos: sirve para probar sin tocar los datos reales
// y para correr una instancia de desarrollo junto a la instalada (el candado de instancia va por carpeta).
if (process.env.DOCENTE_DATOS) app.setPath('userData', process.env.DOCENTE_DATOS)

/**
 * Una sola instancia: dos ventanas abiertas escribirían en la misma base de datos y
 * el reloj de clase quedaría desincronizado. Si ya hay una, se enfoca esa y esta se cierra.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const ventana = principal
    if (!ventana) return crearVentana()
    if (ventana.isMinimized()) ventana.restore()
    ventana.show()
    ventana.focus()
  })
}

/**
 * Zoom de Chromium (±0.5, 0 restablece) para las ventanas que no son la principal (juego en vivo, panel docente):
 * no tienen preload ni escuchan ui:zoom, y al proyectar el juego hace falta agrandar la letra.
 */
function zoomVentana(w: BrowserWindow, paso: number): void {
  const wc = w.webContents
  wc.setZoomLevel(paso === 0 ? 0 : Math.min(5, Math.max(-3, wc.getZoomLevel() + paso * 0.5)))
}

/** Menú propio: igual al estándar de macOS, pero el zoom cambia solo el contenido de la app. */
function instalarMenu(): void {
  const zoom = (paso: number) => (): void => {
    const w = BrowserWindow.getFocusedWindow()
    if (!w) return
    if (w === principal) w.webContents.send('ui:zoom', paso)
    else zoomVentana(w, paso)
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'Ver',
        submenu: [
          { label: 'Contenido más grande', accelerator: 'CmdOrCtrl+=', click: zoom(1) },
          { label: 'Contenido más pequeño', accelerator: 'CmdOrCtrl+-', click: zoom(-1) },
          { label: 'Tamaño normal', accelerator: 'CmdOrCtrl+0', click: zoom(0) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'reload' },
          { role: 'toggleDevTools' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

// Lo que falle sin atraparse (aquí o en una ventana) queda en Ajustes › Errores
instalarCapturaDeErrores()

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.apoumian.appdocente')
  instalarMenu()
  app.on('browser-window-created', (_, w) => {
    optimizer.watchWindowShortcuts(w)
    // ⌘+ / ⌘− / ⌘0 en las otras ventanas: con teclado latinoamericano «+» no coincide con el atajo ⌘= del menú.
    // preventDefault evita que además dispare el menú (sería doble paso). La principal sigue igual.
    w.webContents.on('before-input-event', (e, tecla) => {
      if (w === principal || tecla.type !== 'keyDown' || !(process.platform === 'darwin' ? tecla.meta : tecla.control) || tecla.alt) return
      const paso = tecla.key === '+' || tecla.key === '=' ? 1 : tecla.key === '-' ? -1 : tecla.key === '0' ? 0 : null
      if (paso === null) return
      e.preventDefault()
      zoomVentana(w, paso)
    })
  })
  // Toda ventana (y sus iframes) se queda en su origen; los enlaces externos van al navegador
  app.on('web-contents-created', (_, contenido) => {
    blindarNavegacion(contenido)
    // Un <webview> solo puede mostrar el panel del portal y sin ningún privilegio de la app
    contenido.on('will-attach-webview', (ev, prefs, params) => {
      delete prefs.preload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      let origen = ''
      try {
        origen = new URL(params.src).origin
      } catch {
        origen = ''
      }
      if (origen !== origenPanel()) ev.preventDefault()
    })
  })

  // docente://materiales/<nombre> → archivo dentro de la carpeta de materiales de la app
  protocol.handle('docente', (req) => {
    const u = new URL(req.url)
    const nombre = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    // docente://pyodide/<archivo> → Python del editor de código (núcleo de la app + paquetes descargados)
    if (u.hostname === 'pyodide') return respuestaPyodide(nombre)
    // docente://classroom/<nombre> → archivo entregado en Classroom, bajado a la caché temporal
    if (u.hostname === 'classroom') {
      const enCache = archivoEnCache(nombre)
      return enCache ? net.fetch(pathToFileURL(enCache).toString()) : new Response('No permitido', { status: 403 })
    }
    const ruta = join(materialesDir(), nombre)
    // startsWith a secas dejaba pasar una carpeta hermana («materiales-x») o «../»
    const r = relative(materialesDir(), ruta)
    if (r.startsWith('..') || isAbsolute(r)) return new Response('No permitido', { status: 403 })
    return net.fetch(pathToFileURL(ruta).toString())
  })

  registrarIpc()
  crearVentana()
  // La versión nueva ya migró la base: si no se pudo respaldar antes, el docente debe saberlo
  if (falloDelRespaldoPrevio())
    setTimeout(
      () =>
        void dialog.showMessageBox({
          type: 'warning',
          message: 'No se pudo respaldar la base antes de abrir esta versión',
          detail: `La app sigue funcionando, pero conviene revisar el espacio en disco y hacer un respaldo en Ajustes.\n\nMotivo: ${falloDelRespaldoPrevio()}`
        }),
      1500
    )
  // Recordatorios y alumnos por faltas: aviso del sistema al abrir, y cada 10 min (detecta el cambio de día)
  arrancarAvisos()
  // Respaldo del día; si el docente eligió una carpeta externa (iCloud, Drive, USB), también se copia ahí
  respaldoDiario()
    .then((ruta) => copiarAExterna(ruta))
    .catch((e) => {
      console.error('[respaldo] no se pudo hacer el respaldo del día:', e.message)
      registrarError('principal', 'respaldo del día', e)
    })
  // El portal de alumnos arranca con la app salvo que el docente lo apague en Ajustes
  // En línea siempre se sincroniza (no hay servidor local que apagar)
  if (configRemoto() || getAjuste('portal_auto', '1') === '1') iniciarPortal().catch((e) => {
      console.error('[portal] no arrancó:', e.message)
      registrarError('principal', 'arranque del portal', e)
    })
  app.on('activate', () => (principal ? principal.show() : crearVentana()))
})

// La salida espera a que el proceso del portal cierre su conexión a la base (máx. 5 s, ver detenerPortal)
let portalCerrado = false
app.on('before-quit', (ev) => {
  if (portalCerrado) return
  ev.preventDefault()
  portalCerrado = true
  apagarAlSalir()
    .catch(() => undefined)
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
