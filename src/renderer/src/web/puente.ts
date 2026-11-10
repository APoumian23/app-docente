/**
 * window.api de la versión web: lo mismo que el preload de Electron, pero cada llamada va al servidor
 * (POST /api/docente/app/rpc) con la sesión del docente en el portal. Además resuelve lo que en la Mac hace
 * el sistema:
 *
 * - Una acción que necesita un archivo («Importar», «Agregar material») responde `necesita_archivo`: se
 *   pide al docente con un cuadro propio (el selector del navegador solo abre tras un clic), se sube y se
 *   repite la llamada con lo subido.
 * - Lo que la acción guarda o abre llega como descarga: se baja, se abre en otra pestaña o, si es un PDF,
 *   se abre listo para «Imprimir › Guardar como PDF».
 * - Los avisos de la ventana (asistente escribiendo, notificaciones…) llegan por un flujo de eventos.
 * - Las direcciones docente://… se vuelven direcciones del servidor.
 */
type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }

interface RespuestaServidor {
  ok: boolean
  data?: unknown
  error?: string
  necesita_archivo?: { titulo?: string; extensiones: string[]; multiple: boolean }
  descargas?: { url: string; nombre: string; modo: 'bajar' | 'ver' | 'imprimir' }[]
  abrir?: string[]
}

const CLAVE_SESION = 'docente-portal.sesion'

function sesion(): { token: string; usuario: { rol: string; nombre: string } } | null {
  try {
    const raw = localStorage.getItem(CLAVE_SESION) ?? sessionStorage.getItem(CLAVE_SESION)
    const s = raw ? JSON.parse(raw) : null
    return s?.token ? s : null
  } catch {
    return null
  }
}

/** Sin sesión de docente: a entrar en el portal, que regresa aquí. */
function aEntrar(): Promise<never> {
  location.assign(`/entrar?volver=${encodeURIComponent(location.pathname + location.hash)}`)
  return new Promise(() => undefined)
}

const cabeceras = (): Record<string, string> => ({ Authorization: `Bearer ${sesion()?.token ?? ''}` })

async function rpc(canal: string, args: unknown[], archivos?: string[] | 'cancelado'): Promise<RespuestaServidor> {
  let r: Response
  try {
    r = await fetch('/api/docente/app/rpc', {
      method: 'POST',
      headers: { ...cabeceras(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ canal, args, ...(archivos ? { archivos } : {}) })
    })
  } catch {
    return { ok: false, error: 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.' }
  }
  if (r.status === 401) return aEntrar()
  const datos = (await r.json().catch(() => ({}))) as RespuestaServidor & { codigo?: string }
  // Contraseña que no cumple la regla segura: primero se cambia en el portal, que regresa aquí
  if (r.status === 403 && datos.codigo === 'debe_cambiar') {
    location.assign(`/cuenta?primera=1&volver=${encodeURIComponent(location.pathname + location.hash)}`)
    return new Promise(() => undefined)
  }
  if (!r.ok) return { ok: false, error: datos.error ?? `El servidor respondió ${r.status}.` }
  return datos
}

// ---------- Cuadros propios (sin depender de React) ----------

function cuadro(contenido: (cerrar: () => void, caja: HTMLDivElement) => void, alCerrar?: () => void): void {
  const fondo = document.createElement('div')
  fondo.className = 'fixed inset-0 z-[100] flex items-end justify-center bg-ink-900/40 p-4 sm:items-center'
  const caja = document.createElement('div')
  caja.className = 'tarjeta w-full max-w-md bg-white p-5 shadow-xl'
  caja.setAttribute('role', 'dialog')
  caja.setAttribute('aria-modal', 'true')
  fondo.appendChild(caja)
  let cerrado = false
  const cerrar = (): void => {
    if (cerrado) return
    cerrado = true
    fondo.remove()
    document.removeEventListener('keydown', tecla)
  }
  const tecla = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      cerrar()
      alCerrar?.()
    }
  }
  document.addEventListener('keydown', tecla)
  fondo.addEventListener('click', (e) => {
    if (e.target === fondo) {
      cerrar()
      alCerrar?.()
    }
  })
  contenido(cerrar, caja)
  document.body.appendChild(fondo)
}

const texto = (etiqueta: string, clase: string, t: string): HTMLElement => {
  const el = document.createElement(etiqueta)
  el.className = clase
  el.textContent = t
  return el
}
const boton = (clase: string, t: string, alPulsar: () => void): HTMLButtonElement => {
  const b = texto('button', clase, t) as HTMLButtonElement
  b.type = 'button'
  b.addEventListener('click', alPulsar)
  return b
}

/** Pide los archivos con un botón (el navegador solo abre su selector tras un clic del docente). */
function elegirArchivos(op: NonNullable<RespuestaServidor['necesita_archivo']>): Promise<File[] | null> {
  return new Promise((resolver) => {
    let listo = false
    const fin = (v: File[] | null): void => {
      if (listo) return
      listo = true
      resolver(v)
    }
    cuadro(
      (cerrar, caja) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = op.multiple
        if (op.extensiones.length) input.accept = op.extensiones.map((e) => `.${e}`).join(',')
        input.className = 'hidden'
        input.addEventListener('change', () => {
          const f = input.files ? [...input.files] : []
          if (!f.length) return
          cerrar()
          fin(f)
        })
        caja.append(
          texto('h2', 'text-lg font-semibold text-ink-900', op.titulo || 'Elige el archivo'),
          texto('p', 'mt-1 text-sm text-ink-500', op.extensiones.length ? `Tipos: ${op.extensiones.map((e) => e.toUpperCase()).join(', ')}` : 'Cualquier tipo de archivo'),
          input
        )
        const fila = document.createElement('div')
        fila.className = 'mt-5 flex flex-wrap justify-end gap-2'
        fila.append(
          boton('btn-secundario', 'Cancelar', () => {
            cerrar()
            fin(null)
          }),
          boton('btn-primario', op.multiple ? 'Elegir archivos…' : 'Elegir archivo…', () => input.click())
        )
        caja.append(fila)
      },
      () => fin(null)
    )
  })
}

async function subir(archivos: File[]): Promise<string[] | null> {
  const fd = new FormData()
  for (const f of archivos) fd.append('archivos', f, f.name)
  const aviso = avisoFlotante(`Subiendo ${archivos.length === 1 ? archivos[0].name : `${archivos.length} archivos`}…`)
  try {
    const r = await fetch('/api/docente/app/subir', { method: 'POST', headers: cabeceras(), body: fd })
    if (r.status === 401) return aEntrar()
    const d = (await r.json().catch(() => ({}))) as { tokens?: string[]; error?: string }
    if (!r.ok || !d.tokens) throw new Error(d.error ?? `No se pudo subir (${r.status}).`)
    return d.tokens
  } finally {
    aviso()
  }
}

/** Avisito abajo a la derecha mientras algo tarda; devuelve con qué quitarlo. */
function avisoFlotante(t: string): () => void {
  const el = texto('div', 'fixed bottom-4 right-4 z-[100] rounded-xl bg-ink-900 px-4 py-2 text-sm text-white shadow-lg', t)
  el.setAttribute('role', 'status')
  document.body.appendChild(el)
  return () => el.remove()
}

/** Abre en otra pestaña; si el navegador lo bloquea (pasó tiempo desde el clic), lo ofrece con un botón. */
function abrirPestana(url: string, titulo: string): void {
  const w = window.open(url, '_blank', 'noopener')
  if (w) return
  cuadro((cerrar, caja) => {
    caja.append(texto('h2', 'text-lg font-semibold text-ink-900', titulo), texto('p', 'mt-1 text-sm text-ink-500', 'Se abre en otra pestaña.'))
    const fila = document.createElement('div')
    fila.className = 'mt-5 flex flex-wrap justify-end gap-2'
    const a = texto('a', 'btn-primario', 'Abrir') as HTMLAnchorElement
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    a.addEventListener('click', () => cerrar())
    fila.append(boton('btn-secundario', 'Cerrar', cerrar), a)
    caja.append(fila)
  })
}

function entregar(r: RespuestaServidor): void {
  for (const d of r.descargas ?? []) {
    if (d.modo === 'bajar') {
      const a = document.createElement('a')
      a.href = d.url
      a.download = d.nombre
      document.body.appendChild(a)
      a.click()
      a.remove()
    } else abrirPestana(d.url, d.modo === 'imprimir' ? `${d.nombre}: listo para imprimir o guardar como PDF` : d.nombre)
  }
  for (const u of r.abrir ?? []) abrirPestana(u, 'Abrir')
}

// ---------- Direcciones docente://… ----------

let llave = ''
function url(ruta: string): string {
  if (ruta.startsWith('pyodide/')) return `/pyodide/${ruta.slice('pyodide/'.length)}`
  return `/api/docente/app/archivo/${llave}/${ruta}`
}

function reescribir(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith('docente://') ? url(v.slice('docente://'.length)) : v
  if (Array.isArray(v)) return v.map(reescribir)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reescribir(x)]))
  return v
}

// ---------- Avisos del servidor ----------

const oyentes = new Map<string, Set<(...datos: unknown[]) => void>>()
let flujo = false

async function escucharServidor(): Promise<void> {
  if (flujo) return
  flujo = true
  for (;;) {
    try {
      const r = await fetch('/api/docente/app/eventos', { headers: cabeceras() })
      if (r.status === 401) return void aEntrar()
      if (!r.ok || !r.body) throw new Error(String(r.status))
      const lector = r.body.pipeThrough(new TextDecoderStream()).getReader()
      let resto = ''
      for (;;) {
        const { value, done } = await lector.read()
        if (done) break
        resto += value
        const partes = resto.split('\n\n')
        resto = partes.pop() ?? ''
        for (const p of partes) {
          const linea = p.split('\n').find((l) => l.startsWith('data: '))
          if (!linea) continue
          const { canal, datos } = JSON.parse(linea.slice(6)) as { canal: string; datos: unknown[] }
          for (const cb of oyentes.get(canal) ?? []) cb(...(datos.map(reescribir) as unknown[]))
        }
      }
    } catch {
      /* se reconecta abajo */
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
}

// ---------- window.api ----------

async function invoke<T = unknown>(canal: string, ...args: unknown[]): Promise<Respuesta<T>> {
  // Lo que es de la ventana se hace aquí mismo
  if (canal === 'sistema:pantallaCompleta') {
    try {
      if (args[0]) await document.documentElement.requestFullscreen()
      else if (document.fullscreenElement) await document.exitFullscreen()
    } catch {
      /* el navegador no lo permitió */
    }
    return { ok: true, data: undefined as T }
  }
  let r = await rpc(canal, args)
  while (r.necesita_archivo) {
    const elegidos = await elegirArchivos(r.necesita_archivo)
    if (!elegidos) {
      r = await rpc(canal, args, 'cancelado')
      break
    }
    let tokens: string[] | null
    try {
      tokens = await subir(elegidos)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    if (!tokens) return { ok: false, error: 'No se pudo subir el archivo.' }
    r = await rpc(canal, args, tokens)
  }
  entregar(r)
  return r.ok ? { ok: true, data: reescribir(r.data) as T } : { ok: false, error: r.error ?? 'No se pudo completar.' }
}

const api = {
  invoke,
  escuchar: (canal: string, cb: (...datos: unknown[]) => void): (() => void) => {
    if (!oyentes.has(canal)) oyentes.set(canal, new Set())
    oyentes.get(canal)!.add(cb)
    void escucharServidor()
    return () => void oyentes.get(canal)?.delete(cb)
  },
  plataforma: 'web' as string,
  url
}

/** Antes de pintar la app: sesión de docente y la llave de los archivos. */
export async function prepararPuente(): Promise<void> {
  const s = sesion()
  // La raíz es la app solo para el docente: a cualquier otra sesión se le quita la pista y vuelve a su portal
  if (s && s.usuario?.rol !== 'docente') {
    document.cookie = 'docente_app=; Path=/; Max-Age=0; SameSite=Lax; Secure'
    location.replace('/')
    return new Promise(() => undefined)
  }
  if (!s) return aEntrar()
  ;(window as unknown as { api: typeof api }).api = api
  const r = await rpc('web:llave', [])
  if (!r.ok) {
    document.body.textContent = r.error ?? 'No se pudo abrir la app.'
    return new Promise(() => undefined)
  }
  llave = String(r.data)
}
