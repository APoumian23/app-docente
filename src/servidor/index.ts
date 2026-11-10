/**
 * Arranque del portal fuera de la app de escritorio (por ejemplo, en un VPS).
 *
 *   PORTAL_DATOS=/ruta/a/datos PORTAL_PUERTO=8080 node dist/servidor/index.js
 *
 * Variables:
 *   PORTAL_DATOS    carpeta con docente.sqlite y las entregas (se crea si no existe)
 *   PORTAL_PUERTO   puerto (8080 por omisión)
 *   PORTAL_SECRETO  secreto para firmar sesiones; si falta se genera y se guarda en la base
 *   PORTAL_HOST     interfaz donde escucha (0.0.0.0 por omisión; 127.0.0.1 detrás de nginx)
 *   PORTAL_PROXY    1 = detrás de un proxy en el mismo servidor (toma la IP real de X-Forwarded-For)
 *   PORTAL_SINCRO   clave (32+ caracteres) con la que la app de escritorio sincroniza («Portal en línea»)
 *   PORTAL_DOCENTE  "usuario:contraseña:Nombre" para crear el docente en el primer arranque; si la base
 *                   aún no tiene docente principal (el que ve todas las materias), queda como principal
 *   PORTAL_AVISOS   0 = sin avisos automáticos de tareas (tarea nueva, vence pronto, calificación)
 *   PORTAL_APP_WEB  0 = sin la app de escritorio en la web (/app)
 *   PORTAL_APP_DATOS carpeta de la app web (materiales, cachés); por omisión <PORTAL_DATOS>/app
 *   PORTAL_VAPID_PUBLICA / PORTAL_VAPID_PRIVADA  llaves de las notificaciones push; si faltan se generan y se guardan en la base
 */
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { abrirBase, leerAjuste, escribirAjuste } from './base'
import { crearServidor, asegurarDocente } from './app'
import { arrancarAvisosAutomaticos } from './avisosAuto'
import { montarEscritorio } from './escritorio'

const aqui = dirname(fileURLToPath(import.meta.url))
const datos = process.env.PORTAL_DATOS ?? join(process.cwd(), 'datos')
mkdirSync(datos, { recursive: true })
const db = abrirBase(join(datos, 'docente.sqlite'))

if (process.env.PORTAL_DOCENTE) {
  const [usuario, password, ...nombre] = process.env.PORTAL_DOCENTE.split(':')
  if (usuario && password) {
    asegurarDocente(db, nombre.join(':') || usuario, usuario, password)
    if (!leerAjuste(db, 'portal_docente_usuario')) escribirAjuste(db, 'portal_docente_usuario', usuario.trim())
  }
}

// Python del editor de código: con el repositorio completo, de node_modules y build/pyodide-extra
const raiz = join(aqui, '../..')
// La app web toma de aquí node_modules (Python del editor) como la de escritorio de su carpeta
process.env.PORTAL_RAIZ ??= raiz
// …y los paquetes que se descarguen desde la app web (Programar), que quedan en su carpeta
const carpetasPyodide = [
  join(raiz, 'node_modules/pyodide'),
  join(raiz, 'build/pyodide-extra'),
  join(datos, 'pyodide-paquetes'),
  join(process.env.PORTAL_APP_DATOS || join(datos, 'app'), 'datos', 'pyodide-paquetes')
]
// El servidor solo sirve de las carpetas que existen al arrancar
mkdirSync(carpetasPyodide[3], { recursive: true })
// La app de escritorio completa en el navegador (/app): mismas pantallas y acciones, sobre esta base
const carpetaApp = join(aqui, '../app')
const servidor = crearServidor({
  db,
  carpetaEntregas: join(datos, 'entregas'),
  carpetaPortal: join(aqui, '../portal'),
  carpetasPyodide,
  claveSincro: process.env.PORTAL_SINCRO,
  detrasDeProxy: process.env.PORTAL_PROXY === '1',
  montar: process.env.PORTAL_APP_WEB === '0' ? undefined : (app, ctx) => montarEscritorio(app, { db, ctx, claveSincro: process.env.PORTAL_SINCRO, carpetaApp })
})
// Tarea nueva, «vence pronto» y calificación devuelta: solo aquí (en la Mac se duplicarían al sincronizar)
if (process.env.PORTAL_AVISOS !== '0') arrancarAvisosAutomaticos(db, Number(process.env.PORTAL_AVISOS_CADA) || undefined)
servidor
  .iniciar(Number(process.env.PORTAL_PUERTO ?? 8080), process.env.PORTAL_HOST || undefined)
  .then(({ urls }) => console.log('Portal escuchando en:\n  ' + urls.join('\n  ')))
  .catch((e) => {
    console.error('No se pudo iniciar el portal:', e.message)
    process.exit(1)
  })

for (const señal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(señal, () => {
    servidor.detener().then(() => {
      db.close()
      process.exit(0)
    })
  })
}
