/**
 * Prueba de punta a punta del portal contra una COPIA temporal de la base: nada real se toca.
 * Arranca el servidor empaquetado, recorre el flujo completo de docente y alumno, y el juego en vivo.
 *
 *   node scripts/build-servidor.mjs && node scripts/qa-portal.mjs
 */
import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, copyFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { io as conectar } from 'socket.io-client'
import { createHash, randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'

const PUERTO = 8790
const BASE = `http://localhost:${PUERTO}`
const ORIGEN = join(process.env.HOME, 'Library/Application Support/app-docente/datos/docente.sqlite')
const datos = mkdtempSync(join(tmpdir(), 'portal-qa-'))
/** Escribe directo en la copia temporal (p. ej. para simular que pasó el tiempo de un examen). */
const sql = (consulta) => execFileSync('sqlite3', [join(datos, 'docente.sqlite'), consulta], { encoding: 'utf8' })
if (existsSync(ORIGEN)) {
  copyFileSync(ORIGEN, join(datos, 'docente.sqlite'))
  // En la copia, "profe" hace el papel del docente principal (el de la app de escritorio)
  sql("INSERT INTO ajustes (clave, valor) VALUES ('portal_docente_usuario', 'profe') ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
}

// better-sqlite3 está compilado para Electron: el servidor se corre con el Node que trae Electron
import { readFileSync } from 'fs'
const electronBin = (() => { try { return join('node_modules/electron/dist', readFileSync('node_modules/electron/path.txt', 'utf8').trim()) } catch { return null } })()
const servidor = spawn(electronBin ?? process.execPath, ['dist/servidor/index.mjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORTAL_DATOS: datos, PORTAL_PUERTO: String(PUERTO), PORTAL_DOCENTE: 'profe:Secreto-123!:Docente de prueba', PORTAL_PUSH_PRUEBA: '1', PORTAL_AVISOS_CADA: '1500' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let logServidor = ''
servidor.stdout.on('data', (d) => (logServidor += d))
servidor.stderr.on('data', (d) => (logServidor += d))

const fallos = []
// Si algo se queda esperando un evento que nunca llega, el QA no debe colgarse para siempre
setTimeout(() => {
  console.log('  ✗ las pruebas del portal no terminaron en 4 minutos (se cortan)')
  servidor.kill()
  rmSync(datos, { recursive: true, force: true })
  process.exit(1)
}, 240_000).unref()
let pasos = 0
const ok = (t) => { pasos++; console.log('  ✓', t) }
const falla = (t, e) => { fallos.push(`${t}: ${e}`); console.log('  ✗', t, '→', e) }
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
async function esperarServidor() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/salud`)).ok) return } catch { /* aún no */ }
    await espera(250)
  }
  throw new Error('el servidor no respondió\n' + logServidor)
}
async function api(ruta, { metodo = 'GET', token, cuerpo, form } = {}) {
  const cab = {}
  if (token) cab.Authorization = `Bearer ${token}`
  if (cuerpo) cab['Content-Type'] = 'application/json'
  const r = await fetch(`${BASE}/api${ruta}`, { method: metodo, headers: cab, body: form ?? (cuerpo ? JSON.stringify(cuerpo) : undefined) })
  const tipo = r.headers.get('content-type') ?? ''
  const datos = tipo.includes('json') ? await r.json() : await r.arrayBuffer()
  return { estado: r.status, datos }
}
/**
 * Un socket puede conectarse antes de que se le pida esperar: si se escucha 'connect' después,
 * la espera no termina nunca (era el atasco intermitente de estas pruebas).
 */
const conectado = (sock) => (sock.connected ? Promise.resolve() : new Promise((r) => sock.once('connect', r)))
/** Emite y espera el acuse, con límite: un acuse perdido falla la prueba en vez de colgarla. */
const emitirCon = (sock, ev, d) => new Promise((r) => sock.timeout(5000).emit(ev, d, (err, res) => r(err ? { ok: false, error: 'sin acuse en 5 s' } : res)))
const prueba = async (nombre, fn) => { try { await fn() } catch (e) { falla(nombre, e.message) } }
const exige = (cond, msg) => { if (!cond) throw new Error(msg) }

try {
  await esperarServidor()
  ok('el servidor arranca sobre una copia temporal de la base')

  // ---------- Docente ----------
  let docente
  await prueba('login del docente', async () => {
    const r = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'profe', password: 'Secreto-123!' } })
    exige(r.estado === 200 && r.datos.sesion?.token, JSON.stringify(r.datos))
    docente = r.datos.sesion.token
    ok('login del docente')
  })
  await prueba('login con contraseña incorrecta rechazado', async () => {
    const r = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'profe', password: 'mala' } })
    exige(r.estado === 401, `esperaba 401, llegó ${r.estado}`)
    ok('contraseña incorrecta rechazada')
  })

  let materia, evaluacion, alumnos
  await prueba('lista de materias y evaluaciones con reactivos', async () => {
    const m = await api('/docente/materias', { token: docente })
    exige(m.estado === 200 && m.datos.length > 0, 'sin materias')
    const total = Number(sql('SELECT COUNT(*) FROM materias').trim())
    exige(m.datos.length === total, `el principal ve ${m.datos.length} de ${total} materias`)
    // La primera materia (con alumnos, si hay) que tenga un examen de opción múltiple: el juego y la calificación
    // automática lo necesitan, y el orden de la lista cambia si una materia cambia de carrera
    const candidatas = [...m.datos.filter((x) => x.inscritos > 0), ...m.datos.filter((x) => !x.inscritos)]
    for (const x of candidatas) {
      const e = await api(`/docente/materias/${x.id}/evaluaciones`, { token: docente })
      const conOpciones = e.datos.find((y) => y.con_reactivos && sql(`SELECT contenido FROM evaluaciones WHERE id = ${y.id}`).includes('"opcion_multiple"'))
      if (conOpciones) {
        materia = x
        evaluacion = conOpciones
        break
      }
    }
    exige(evaluacion, 'ninguna materia tiene una evaluación de opción múltiple')
    ok(`el principal ve sus ${total} materias · "${materia.nombre}" con evaluación "${evaluacion.titulo}"`)
  })

  // Alumnos de prueba propios: los reales de la copia ya cambiaron su contraseña (o la cambiarán), así que las
  // pruebas de alumno no pueden contar con que su matrícula siga siendo su contraseña
  await prueba('inscribir alumnos de prueba si hacen falta', async () => {
    const a = await api(`/docente/materias/${materia.id}/alumnos`, { token: docente })
    if (!a.datos.some((x) => x.matricula === 'QA2601')) {
      const r = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: [
        { matricula: 'QA2601', nombre: 'Ana', apellidos: 'Prueba', email: 'qa2601@qa.mx' },
        { matricula: 'QA2602', nombre: 'Luis', apellidos: 'Prueba' }
      ] })
      exige(r.estado === 200 && r.datos.inscritos === 2, JSON.stringify(r.datos))
      const invalido = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: { matricula: '', nombre: '' } })
      exige(invalido.estado === 400, 'aceptó alumno sin matrícula')
    }
    const deQA = (x) => (String(x.matricula ?? '').startsWith('QA26') ? 0 : 1)
    alumnos = (await api(`/docente/materias/${materia.id}/alumnos`, { token: docente })).datos.sort((x, y) => deQA(x) - deQA(y) || String(x.matricula).localeCompare(String(y.matricula)))
    exige(alumnos.length >= 2 && alumnos[0].matricula === 'QA2601', 'sin los alumnos de prueba')
    ok(`${alumnos.length} alumnos inscritos`)
  })

  await prueba('generar accesos de alumnos', async () => {
    const r = await api(`/docente/materias/${materia.id}/accesos`, { metodo: 'POST', token: docente })
    exige(r.estado === 200 && (r.datos.creados.length > 0 || r.datos.existentes > 0), JSON.stringify(r.datos))
    ok(`accesos: ${r.datos.creados.length} creados, ${r.datos.existentes} existentes`)
  })

  let asignacion
  await prueba('alumno sin matrícula: se inscribe y recibe usuario generado', async () => {
    const r = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: { nombre: 'Ximena', apellidos: 'Quiroz Campos' } })
    exige(r.estado === 200, JSON.stringify(r.datos))
    const acc = await api(`/docente/materias/${materia.id}/accesos`, { metodo: 'POST', token: docente })
    const c = acc.datos.creados.find((x) => x.nombre.includes('Ximena'))
    exige(c && c.usuario === 'ximena.quiroz' && c.password.length === 8 && c.matricula === '', JSON.stringify(acc.datos))
    const login = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: c.usuario, password: c.password, dispositivo: 'qa' } })
    exige(login.estado === 200 && login.datos.sesion.usuario.debe_cambiar === 1, 'no pudo entrar con el usuario generado')
    const sinNombre = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: { matricula: 'X1' } })
    exige(sinNombre.estado === 400, 'aceptó alumno sin nombre')
    ok(`alumno sin matrícula → usuario ${c.usuario}, contraseña generada`)
  })
  await prueba('publicar evaluación con vigilancia y archivos', async () => {
    const r = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id, materia_id: materia.id, vigilancia: true, permite_archivos: true, permite_borrador: true, duracion_min: 30 } })
    exige(r.estado === 200 && r.datos.id, JSON.stringify(r.datos))
    asignacion = r.datos
    ok(`asignación ${asignacion.id} publicada`)
  })
  await prueba('publicar evaluación sin reactivos es rechazado', async () => {
    const e = await api(`/docente/materias/${materia.id}/evaluaciones`, { token: docente })
    const vacia = e.datos.find((x) => !x.con_reactivos)
    if (!vacia) return ok('(no hay evaluaciones vacías que probar)')
    const r = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: vacia.id, materia_id: materia.id } })
    exige(r.estado === 400, `esperaba 400, llegó ${r.estado}`)
    ok('evaluación sin reactivos rechazada con mensaje claro')
  })

  // ---------- Alumno ----------
  const matricula = alumnos[0].matricula
  let alumno, alumno2
  await prueba('login del alumno con su matrícula', async () => {
    const r = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: matricula, password: matricula } })
    exige(r.estado === 200, JSON.stringify(r.datos))
    exige(r.datos.sesion.usuario.debe_cambiar === 1, 'debería pedir cambio de contraseña')
    alumno = r.datos.sesion.token
    ok('alumno entra y se le pide cambiar contraseña')
  })
  await prueba('sesión única: un segundo login cierra el primero', async () => {
    const r = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: matricula, password: matricula } })
    exige(r.datos.reemplazo === true, 'no marcó reemplazo')
    alumno2 = r.datos.sesion.token
    const viejo = await api('/alumno/asignaciones', { token: alumno })
    exige(viejo.estado === 401 && viejo.datos.codigo === 'sesion_reemplazada', `la sesión vieja siguió viva: ${viejo.estado}`)
    alumno = alumno2
    ok('la sesión anterior queda cerrada con código sesion_reemplazada')
  })
  await prueba('con la contraseña inicial solo se puede cambiar la contraseña', async () => {
    const r = await api('/alumno/asignaciones', { token: alumno })
    exige(r.estado === 403 && r.datos.codigo === 'debe_cambiar', `el servidor dejó usar la cuenta sin cambiarla: ${r.estado}`)
    // En el primer acceso no se pide la actual (acaba de entrar con ella): el navegador solía rellenarla con otra
    const igual = await api('/auth/password', { metodo: 'POST', token: alumno, cuerpo: { actual: 'lo-que-sea', nueva: matricula } })
    exige(igual.estado === 400, 'aceptó la matrícula como contraseña nueva')
    const bien = await api('/auth/password', { metodo: 'POST', token: alumno, cuerpo: { actual: matricula, nueva: 'Nueva123!' } })
    exige(bien.estado === 200, JSON.stringify(bien.datos))
    const yo = await api('/auth/yo', { token: alumno })
    exige(yo.datos.debe_cambiar === 0, 'sigue pidiendo cambio')
    const ya = await api('/alumno/asignaciones', { token: alumno })
    exige(ya.estado === 200, `tras cambiarla sigue bloqueado: ${ya.estado}`)
    // Ya con su propia contraseña, cambiarla otra vez sí pide la actual
    const mal = await api('/auth/password', { metodo: 'POST', token: alumno, cuerpo: { actual: 'mala', nueva: 'Otra1234!' } })
    exige(mal.estado === 400, 'aceptó contraseña actual incorrecta')
    ok('contraseña inicial obligatoria en el servidor; la matrícula no sirve como nueva; después se pide la actual')
  })
  await prueba('una contraseña que no cumple la regla segura se cambia al entrar', async () => {
    // Alumno con contraseña de antes de la regla (débil) y sin cambio pendiente
    const hash = bcrypt.hashSync('debil1234', 10)
    sql(`INSERT INTO usuarios (rol, nombre, usuario, hash, debe_cambiar) VALUES ('alumno', 'Débil QA', 'debil.qa', '${hash}', 0)`)
    const r = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'debil.qa', password: 'debil1234', dispositivo: 'qa' } })
    exige(r.estado === 200 && r.datos.sesion.usuario.debe_cambiar === 1, `no pidió cambiarla: ${JSON.stringify(r.datos)}`)
    const t = r.datos.sesion.token
    const bloqueado = await api('/auth/yo', { token: t })
    exige(bloqueado.datos.debe_cambiar === 1, 'no quedó marcado en la base')
    const otraDebil = await api('/auth/password', { metodo: 'POST', token: t, cuerpo: { actual: '', nueva: 'otra12345' } })
    exige(otraDebil.estado === 400 && /necesita/.test(otraDebil.datos.error), 'aceptó otra contraseña débil')
    const bien = await api('/auth/password', { metodo: 'POST', token: t, cuerpo: { actual: '', nueva: 'Fuerte-2026!' } })
    exige(bien.estado === 200, JSON.stringify(bien.datos))
    const otra = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'debil.qa', password: 'Fuerte-2026!', dispositivo: 'qa' } })
    exige(otra.estado === 200 && otra.datos.sesion.usuario.debe_cambiar === 0, 'con la contraseña segura volvió a pedir cambio')
    ok('contraseña débil → cambio obligatorio al entrar, sin pedir la actual; con una segura entra normal')
  })
  await prueba('demasiados intentos de login se bloquean', async () => {
    const estados = []
    for (let i = 0; i < 6; i++) estados.push((await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'nadie.qa', password: `mala${i}` } })).estado)
    exige(estados.slice(0, 5).every((e) => e === 401) && estados[5] === 429, estados.join(','))
    ok('5 fallos → el sexto intento recibe 429')
  })
  await prueba('el alumno recibió la notificación de la actividad', async () => {
    const n = await api('/notificaciones?no_leidas=1', { token: alumno })
    exige(n.datos.some((x) => x.ref_id === asignacion.id), 'sin notificación')
    ok('notificación de nueva actividad')
  })
  await prueba('el alumno no ve preguntas antes de iniciar', async () => {
    const r = await api(`/alumno/asignaciones/${asignacion.id}`, { token: alumno })
    exige(r.estado === 200 && r.datos.preguntas === undefined && r.datos.abierta === true, JSON.stringify(r.datos).slice(0, 200))
    ok('las preguntas no viajan antes de iniciar')
  })
  let intento, preguntas
  await prueba('iniciar intento entrega las preguntas sin respuestas', async () => {
    const r = await api(`/alumno/asignaciones/${asignacion.id}/iniciar`, { metodo: 'POST', token: alumno })
    exige(r.estado === 200 && r.datos.intento && r.datos.preguntas?.length, JSON.stringify(r.datos).slice(0, 200))
    intento = r.datos.intento
    preguntas = r.datos.preguntas
    exige(!JSON.stringify(preguntas).includes('"respuesta"'), 'las preguntas traen respuesta')
    ok(`intento ${intento.id} con ${preguntas.length} preguntas, sin claves`)
  })
  await prueba('autoguardado de respuestas con tiempo', async () => {
    const r = await api(`/alumno/intentos/${intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: preguntas[0].opciones[0] ?? 'x' }, tiempo_activo_seg: 42 } })
    exige(r.estado === 200 && r.datos.tiempo_activo_seg === 42, JSON.stringify(r.datos).slice(0, 200))
    ok('respuestas guardadas y tiempo activo registrado')
  })
  await prueba('borrador se guarda con estado borrador', async () => {
    const r = await api(`/alumno/intentos/${intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: preguntas[0].opciones[0] ?? 'x' }, tiempo_activo_seg: 60, borrador: true } })
    exige(r.datos.estado === 'borrador', r.datos.estado)
    ok('borrador guardado')
  })
  await prueba('un autoguardado normal no degrada el borrador', async () => {
    const r = await api(`/alumno/intentos/${intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: preguntas[0].opciones[0] ?? 'x' }, tiempo_activo_seg: 61 } })
    exige(r.datos.estado === 'borrador', `quedó ${r.datos.estado}`)
    ok('borrador conservado tras autoguardar')
  })
  await prueba('eventos de integridad se registran', async () => {
    for (const tipo of ['salio_pestana', 'volvio_pestana', 'perdio_foco']) await api(`/alumno/intentos/${intento.id}/eventos`, { metodo: 'POST', token: alumno, cuerpo: { tipo, detalle: 'prueba' } })
    ok('3 eventos enviados')
  })
  await prueba('subir un archivo a la entrega', async () => {
    const form = new FormData()
    form.append('archivos', new Blob(['hola'], { type: 'text/plain' }), 'tarea.txt')
    const r = await api(`/alumno/intentos/${intento.id}/archivos`, { metodo: 'POST', token: alumno, form })
    exige(r.estado === 200 && r.datos[0]?.nombre === 'tarea.txt', JSON.stringify(r.datos))
    const a = await api(`/alumno/asignaciones/${asignacion.id}`, { token: alumno })
    exige(a.datos.intento?.archivos?.length === 1, 'la asignación no trae los archivos del intento')
    ok('archivo adjuntado y visible al recargar')
  })
  await prueba('archivo con extensión prohibida se rechaza', async () => {
    const form = new FormData()
    form.append('archivos', new Blob(['x'], { type: 'application/octet-stream' }), 'virus.exe')
    const r = await api(`/alumno/intentos/${intento.id}/archivos`, { metodo: 'POST', token: alumno, form })
    exige(r.estado === 400, `esperaba 400, llegó ${r.estado}`)
    ok('.exe rechazado')
  })
  // Contestar todo correctamente para verificar la calificación automática
  let esperado = 0
  await prueba('enviar la entrega con calificación automática', async () => {
    const ev = await api(`/docente/evaluaciones/${evaluacion.id}`, { token: docente })
    exige(ev.estado === 200 && ev.datos.contenido_json, 'no se pudo leer la evaluación completa')
    const claves = ev.datos.contenido_json.preguntas
    const respuestas = {}
    claves.forEach((p, i) => {
      if (p.tipo === 'opcion_multiple' || p.tipo === 'verdadero_falso') { respuestas[i] = p.respuesta; esperado += p.puntos }
      else respuestas[i] = 'respuesta abierta de prueba'
    })
    await api(`/alumno/intentos/${intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas, tiempo_activo_seg: 300 } })
    const r = await api(`/alumno/intentos/${intento.id}/enviar`, { metodo: 'POST', token: alumno, cuerpo: { tiempo_activo_seg: 310 } })
    exige(r.estado === 200 && (r.datos.estado === 'enviado' || r.datos.estado === 'calificado'), JSON.stringify(r.datos).slice(0, 200))
    exige(r.datos.puntaje_auto === esperado, `puntaje automático ${r.datos.puntaje_auto}, esperaba ${esperado}`)
    intento = r.datos
    ok(`enviada · automático ${r.datos.puntaje_auto} pts · ${r.datos.pendiente_manual ? 'pendiente de revisión manual' : 'calificada completa'}`)
  })
  await prueba('no se puede volver a enviar ni modificar', async () => {
    // Reenviar (el reintento del celular) devuelve la misma entrega sin recalificar
    const r = await api(`/alumno/intentos/${intento.id}/enviar`, { metodo: 'POST', token: alumno })
    const r2 = await api(`/alumno/intentos/${intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: 'cambio' } } })
    exige(r.estado === 200 && r.datos.enviado_en === intento.enviado_en && r.datos.puntaje_auto === intento.puntaje_auto, `reenvío: ${r.estado} ${JSON.stringify(r.datos).slice(0, 120)}`)
    exige(r2.estado === 400, `edición: ${r2.estado}`)
    ok('reenvío devuelve la misma entrega y la edición queda bloqueada')
  })
  await prueba('una subida con id inválido no tumba el servidor', async () => {
    const form = new FormData()
    form.append('archivos', new Blob(['x'], { type: 'text/plain' }), 'a.txt')
    const r = await api('/alumno/intentos/abc/archivos', { metodo: 'POST', token: alumno, form })
    exige(r.estado >= 400 && r.estado < 500, `llegó ${r.estado}`)
    exige((await fetch(`${BASE}/api/salud`)).ok, 'el servidor se cayó')
    ok(`id inválido → ${r.estado} y el servidor sigue vivo`)
  })
  await prueba('subir a un intento ajeno no deja archivos en disco', async () => {
    const form = new FormData()
    form.append('archivos', new Blob(['x'.repeat(1000)], { type: 'text/plain' }), 'b.txt')
    const r = await api('/alumno/intentos/999999/archivos', { metodo: 'POST', token: alumno, form })
    exige(r.estado === 404, `llegó ${r.estado}`)
    exige(!existsSync(join(datos, 'entregas', '999999')), 'quedó una carpeta con el archivo')
    ok('intento ajeno → 404 sin escribir en disco')
  })
  await prueba('un examen vencido se cierra con lo guardado y se puede calificar', async () => {
    const pub = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id, materia_id: materia.id, duracion_min: 10, titulo: 'QA vencido' } })
    exige(pub.estado === 200, JSON.stringify(pub.datos))
    const ini = await api(`/alumno/asignaciones/${pub.datos.id}/iniciar`, { metodo: 'POST', token: alumno })
    exige(ini.estado === 200 && typeof ini.datos.servidor_ms === 'number', 'no llegó la hora del servidor para corregir el reloj del celular')
    const ev = await api(`/docente/evaluaciones/${evaluacion.id}`, { token: docente })
    const claves = ev.datos.contenido_json.preguntas
    const respuestas = {}
    let puntos = 0
    claves.forEach((p, i) => { if (p.tipo === 'opcion_multiple' || p.tipo === 'verdadero_falso') { respuestas[i] = p.respuesta; puntos += p.puntos } })
    await api(`/alumno/intentos/${ini.datos.intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas, tiempo_activo_seg: 30 } })
    // El celular se apagó: pasaron 2 horas sin que enviara
    sql(`UPDATE intentos SET iniciado_en = datetime('now', '-2 hours') WHERE id = ${ini.datos.intento.id}`)
    const vista = await api(`/alumno/asignaciones/${pub.datos.id}`, { token: alumno })
    const cerrado = vista.datos.intento
    exige(cerrado && ['enviado', 'calificado'].includes(cerrado.estado), `quedó ${cerrado?.estado}`)
    exige(cerrado.puntaje_auto === puntos, `puntaje ${cerrado.puntaje_auto}, esperaba ${puntos}`)
    const tarde = await api(`/alumno/intentos/${ini.datos.intento.id}/enviar`, { metodo: 'POST', token: alumno })
    exige(tarde.estado === 200, `el envío tardío respondió ${tarde.estado}`)
    const cal = await api(`/docente/intentos/${ini.datos.intento.id}/calificar`, { metodo: 'PUT', token: docente, cuerpo: { puntaje: puntos, retro: 'ok' } })
    exige(cal.estado === 200, `el docente no pudo calificar: ${JSON.stringify(cal.datos)}`)
    ok(`cerrado solo con ${cerrado.puntaje_auto} pts automáticos y calificable por el docente`)
  })

  await prueba('mostrar_resultado = 0 oculta el puntaje y la retroalimentación al alumno', async () => {
    const pub = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id, materia_id: materia.id, mostrar_resultado: false, titulo: 'QA sin resultado' } })
    exige(pub.estado === 200 && pub.datos.mostrar_resultado === 0, JSON.stringify(pub.datos).slice(0, 200))
    const ini = await api(`/alumno/asignaciones/${pub.datos.id}/iniciar`, { metodo: 'POST', token: alumno })
    const ev = await api(`/docente/evaluaciones/${evaluacion.id}`, { token: docente })
    const respuestas = {}
    ev.datos.contenido_json.preguntas.forEach((p, i) => { if (p.tipo === 'opcion_multiple' || p.tipo === 'verdadero_falso') respuestas[i] = p.respuesta })
    await api(`/alumno/intentos/${ini.datos.intento.id}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas, tiempo_activo_seg: 20 } })
    const env = await api(`/alumno/intentos/${ini.datos.intento.id}/enviar`, { metodo: 'POST', token: alumno })
    exige(env.estado === 200 && env.datos.puntaje_auto === null && env.datos.puntaje === null, `el envío devolvió puntaje: ${JSON.stringify(env.datos).slice(0, 200)}`)
    const det = await api(`/docente/intentos/${ini.datos.intento.id}`, { token: docente })
    exige(det.datos.puntaje_auto > 0, 'el docente debería ver el puntaje automático')
    await api(`/docente/intentos/${ini.datos.intento.id}/calificar`, { metodo: 'PUT', token: docente, cuerpo: { puntaje: det.datos.puntaje_auto, retro: 'retro secreta' } })
    const vista = await api(`/alumno/asignaciones/${pub.datos.id}`, { token: alumno })
    const lista = (await api('/alumno/asignaciones', { token: alumno })).datos.find((a) => a.id === pub.datos.id)
    const cal = (await api('/alumno/calificaciones', { token: alumno })).datos.find((c) => c.asignacion_id === pub.datos.id)
    for (const [donde, i] of [['detalle', vista.datos.intento], ['lista', lista?.intento], ['calificaciones', cal]]) {
      exige(i && i.puntaje === null && i.puntaje_auto === null && i.retro === '', `${donde} filtró el resultado: ${JSON.stringify(i).slice(0, 160)}`)
    }
    exige(vista.datos.intento.estado === 'calificado', 'el alumno debería ver que ya se revisó')
    ok('sin puntaje ni retro en el envío, el detalle, la lista y calificaciones; el docente sí los ve')
  })

  // ---------- Docente revisa ----------
  await prueba('el docente recibió la notificación de entrega', async () => {
    const n = await api('/notificaciones?no_leidas=1', { token: docente })
    exige(n.datos.some((x) => x.tipo === 'entrega' && x.ref_id === intento.id), 'sin notificación de entrega')
    ok('notificación de entrega al docente')
  })
  await prueba('tabla de entregas con tiempo y eventos', async () => {
    const r = await api(`/docente/asignaciones/${asignacion.id}/entregas`, { token: docente })
    const fila = r.datos.entregas.find((e) => e.id === intento.id)
    // El celular reportó 310 s a segundos de empezar: el servidor no cree más del tiempo transcurrido (+1 min).
    // Las alertas son las salidas: de los 3 eventos, «volvió a la pestaña» no cuenta
    exige(fila && fila.eventos === 2 && fila.tiempo_activo_seg > 0 && fila.tiempo_activo_seg <= 120, JSON.stringify({ eventos: fila?.eventos, tiempo: fila?.tiempo_activo_seg }))
    ok(`entrega con 2 alertas de integridad (el regreso no cuenta); tiempo activo inflado limitado a ${fila.tiempo_activo_seg} s`)
  })
  await prueba('detalle del intento muestra respuestas y clave', async () => {
    const r = await api(`/docente/intentos/${intento.id}`, { token: docente })
    exige(r.datos.preguntas.length === preguntas.length && r.datos.archivos.length === 1 && r.datos.eventos_lista.length === 3, 'detalle incompleto')
    exige(r.datos.preguntas.every((p) => p.respuesta_correcta !== undefined), 'sin clave')
    ok('detalle completo para el docente')
  })
  await prueba('calificar a mano y notificar al alumno', async () => {
    const r = await api(`/docente/intentos/${intento.id}/calificar`, { metodo: 'PUT', token: docente, cuerpo: { puntaje: esperado, retro: 'Bien' } })
    exige(r.estado === 200 && r.datos.estado === 'calificado', JSON.stringify(r.datos).slice(0, 200))
    const n = await api('/notificaciones?no_leidas=1', { token: alumno })
    exige(n.datos.some((x) => x.tipo === 'calificacion'), 'el alumno no recibió la calificación')
    const c = await api('/alumno/calificaciones', { token: alumno })
    exige(c.datos.find((x) => x.id === intento.id)?.puntaje === esperado, 'el alumno no ve su puntaje')
    ok('calificada, notificada y visible para el alumno')
  })
  await prueba('puntaje fuera de rango rechazado', async () => {
    const r = await api(`/docente/intentos/${intento.id}/calificar`, { metodo: 'PUT', token: docente, cuerpo: { puntaje: 9999 } })
    exige(r.estado === 400, `esperaba 400, llegó ${r.estado}`)
    ok('puntaje fuera de rango rechazado')
  })
  await prueba('exportar entregas a Excel', async () => {
    const r = await api(`/docente/entregas/exportar?materia_id=${materia.id}`, { token: docente })
    exige(r.estado === 200 && r.datos.byteLength > 2000, `excel de ${r.datos.byteLength} bytes`)
    ok(`Excel de entregas: ${Math.round(r.datos.byteLength / 1024)} KB`)
  })
  await prueba('el alumno no puede usar rutas del docente', async () => {
    const r = await api('/docente/materias', { token: alumno })
    exige(r.estado === 403, `esperaba 403, llegó ${r.estado}`)
    ok('rol respetado')
  })
  await prueba('ocultar y mostrar materia', async () => {
    await api(`/docente/materias/${materia.id}`, { metodo: 'PATCH', token: docente, cuerpo: { oculta: true } })
    let m = (await api('/docente/materias', { token: docente })).datos.find((x) => x.id === materia.id)
    exige(m.oculta === 1, 'no se ocultó')
    await api(`/docente/materias/${materia.id}`, { metodo: 'PATCH', token: docente, cuerpo: { oculta: false } })
    m = (await api('/docente/materias', { token: docente })).datos.find((x) => x.id === materia.id)
    exige(m.oculta === 0, 'no se mostró')
    ok('ocultar/mostrar materia')
  })

  // ---------- Juego en vivo ----------
  await prueba('partida completa por WebSocket', async () => {
    const p = await api('/docente/partidas', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id, segundos: 5 } })
    exige(p.estado === 200 && p.datos.pin, JSON.stringify(p.datos))
    const pin = p.datos.pin
    const anfitrion = conectar(BASE, { auth: { token: docente } })
    const jugador = conectar(BASE, { auth: { token: alumno } })
    const invitado = conectar(BASE)
    const emitir = (sock, ev, d) => emitirCon(sock, ev, d)
    await conectado(anfitrion)
    await conectado(jugador)
    await conectado(invitado)
    const u1 = await emitir(jugador, 'partida:unirse', { pin, apodo: 'Ana' })
    const u2 = await emitir(invitado, 'partida:unirse', { pin, apodo: 'Invitado' })
    exige(u1.ok && u2.ok, JSON.stringify([u1, u2]))
    // El alumno con sesión juega con el nombre de su cuenta, no con el que escribió
    const nombreCuenta = `${alumnos[0].nombre} ${alumnos[0].apellidos}`.trim()
    exige(u1.participante.apodo !== 'Ana' && (nombreCuenta.length <= 24 ? u1.participante.apodo === nombreCuenta : nombreCuenta.startsWith(u1.participante.apodo.split(' ')[0])), `apodo del alumno: ${u1.participante.apodo}`)
    const dup = await emitir(invitado, 'partida:unirse', { pin, apodo: u1.participante.apodo })
    exige(!dup.ok, 'permitió apodo duplicado')
    // Un invitado no puede apartar el nombre (ni la matrícula) de un alumno del grupo
    const suplanta = await emitir(invitado, 'partida:unirse', { pin, apodo: 'ximena quiroz campos' })
    exige(!suplanta.ok && /alumno del grupo/.test(suplanta.error), `un invitado usó el nombre de un alumno inscrito: ${JSON.stringify(suplanta)}`)
    if (alumnos[1]?.matricula) {
      const conMatricula = await emitir(invitado, 'partida:unirse', { pin, apodo: alumnos[1].matricula })
      exige(!conMatricula.ok, 'un invitado usó la matrícula de un alumno inscrito')
    }
    const noAutorizado = await emitir(jugador, 'partida:controlar', { pin, accion: 'iniciar' })
    exige(!noAutorizado.ok, 'un alumno pudo controlar la partida')
    exige(typeof u2.clave === 'string' && u2.clave.length > 8, 'no entregó clave de reconexión')
    const preguntaRecibida = new Promise((r) => jugador.once('partida:pregunta', r))
    const c = await emitir(anfitrion, 'partida:controlar', { pin, accion: 'iniciar' })
    exige(c.ok, JSON.stringify(c))
    const q = await preguntaRecibida
    exige(q.opciones.length >= 2 && q.total === p.datos.total_preguntas, 'pregunta incompleta')
    // El invitado se desconecta a media pregunta y vuelve con otro socket: retoma su apodo con la clave y recibe la pregunta en curso
    invitado.close()
    const invitado2 = conectar(BASE)
    await conectado(invitado2)
    const sinClave = await emitir(invitado2, 'partida:unirse', { pin, apodo: 'Invitado' })
    exige(!sinClave.ok, 'retomó el apodo sin clave')
    const conClave = await emitir(invitado2, 'partida:unirse', { pin, apodo: 'Invitado', clave: u2.clave })
    exige(conClave.ok && conClave.participante.id === u2.participante.id && conClave.pregunta?.indice === q.indice && conClave.pregunta.segundos <= q.segundos && conClave.clave === u2.clave, JSON.stringify(conClave).slice(0, 200))
    // El anfitrión que recarga recupera la pregunta y el conteo
    const reenvio = new Promise((r) => anfitrion.once('partida:pregunta', r))
    anfitrion.emit('partida:observar', { pin })
    exige((await reenvio).indice === q.indice, 'observar no reenvió la pregunta')
    // El conteo que reenvía observar (n = 0) puede llegar tarde: se espera el que cuenta la respuesta
    const respondieron = new Promise((r) => { const al = (d) => { if (d.n > 0) { anfitrion.off('partida:respondieron', al); r(d) } }; anfitrion.on('partida:respondieron', al) })
    const resultado = new Promise((r) => jugador.once('partida:resultado', r))
    const r1 = await emitir(jugador, 'partida:responder', { pin, participante_id: u1.participante.id, opcion: 0 })
    const cuenta = await respondieron
    exige(cuenta.n === 1 && cuenta.total === 2, `conteo de respuestas ${JSON.stringify(cuenta)}`)
    // El acuse no revela si fue correcta ni los puntos, y la tabla no se mueve hasta el resultado
    exige(r1.ok && !('correcta' in r1) && !('puntos' in r1), `el acuse reveló el resultado: ${JSON.stringify(r1)}`)
    // Un reintento (acuse perdido) no cuenta dos veces, pero avisa que la respuesta sí quedó
    const reintento = await emitir(jugador, 'partida:responder', { pin, participante_id: u1.participante.id, opcion: 1 })
    exige(!reintento.ok && reintento.ya_respondida === true, `reintento: ${JSON.stringify(reintento)}`)
    const aMedias = await api(`/partidas/${pin}`)
    exige(aMedias.datos.participantes.every((x) => x.puntos === 0), `la tabla cambió antes del resultado: ${JSON.stringify(aMedias.datos.participantes)}`)
    const r2 = await emitir(invitado2, 'partida:responder', { pin, participante_id: u2.participante.id, opcion: 1 })
    exige(r1.ok && r2.ok, 'no aceptó respuestas')
    const repetida = await emitir(jugador, 'partida:responder', { pin, participante_id: u1.participante.id, opcion: 1 })
    exige(!repetida.ok, 'aceptó responder dos veces')
    const res = await resultado
    exige(Array.isArray(res.tabla) && res.tabla.length === 2 && res.conteo.reduce((a, b) => a + b, 0) === 2, 'resultado incompleto')
    // Con el resultado, los puntos sí se suman: quien eligió la correcta tiene más de 0
    const acertaron = [[0, u1], [1, u2]].filter(([op]) => op === res.correcta).map(([, x]) => x.participante.id)
    exige(res.tabla.every((x) => (acertaron.includes(x.id) ? x.puntos > 0 : x.puntos === 0)), `puntos tras el resultado: ${JSON.stringify(res.tabla)} correcta=${res.correcta}`)
    const fin = new Promise((r) => jugador.once('partida:fin', r))
    await emitir(anfitrion, 'partida:controlar', { pin, accion: 'terminar' })
    const tabla = await fin
    exige(tabla.length === 2, 'tabla final incompleta')
    const estado = await api(`/partidas/${pin}`)
    exige(estado.datos.estado === 'terminada', 'no quedó terminada')
    // Quién respondió qué: solo el docente lo ve, con la opción de cada jugador y la correcta
    const det = await api(`/docente/partidas/${pin}/detalle`, { token: docente })
    exige(det.estado === 200 && det.datos.preguntas.length === 1 && det.datos.preguntas[0].correcta === res.correcta, `detalle: ${JSON.stringify(det.datos)}`)
    const de = (id) => det.datos.jugadores.find((j) => j.id === id)?.respuestas[0]
    exige(de(u1.participante.id)?.opcion === 0 && de(u2.participante.id)?.opcion === 1, `opciones por jugador: ${JSON.stringify(det.datos.jugadores)}`)
    exige(de(u1.participante.id).correcta === (res.correcta === 0) && de(u2.participante.id).correcta === (res.correcta === 1), 'correcta por jugador no cuadra')
    const sinSesion = await api(`/docente/partidas/${pin}/detalle`)
    exige(sinSesion.estado === 401 || sinSesion.estado === 403, `detalle sin sesión → ${sinSesion.estado}`)
    anfitrion.close(); jugador.close(); invitado2.close()
    ok(`partida ${pin}: lobby → pregunta → reconexión → resultado → fin; el acuse no revela la correcta y los puntos llegan con el resultado; el docente ve quién eligió qué`)
  })
  await prueba('tope de jugadores por partida', async () => {
    const p = await api('/docente/partidas', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id } })
    const bot = conectar(BASE)
    await conectado(bot)
    const emitir = (ev, d) => emitirCon(bot, ev, d)
    let aceptados = 0
    for (let i = 1; i <= 100; i++) if ((await emitir('partida:unirse', { pin: p.datos.pin, apodo: `bot ${i}` })).ok) aceptados++
    const extra = await emitir('partida:unirse', { pin: p.datos.pin, apodo: 'bot 101' })
    bot.close()
    exige(aceptados === 100 && !extra.ok && /llena/.test(extra.error), `aceptó ${aceptados} y el 101 → ${JSON.stringify(extra)}`)
    ok('100 jugadores entran; el 101 recibe «La partida está llena»')
  })

  // ---------- Aislamiento entre docentes ----------
  await prueba('un segundo docente no ve ni toca materias ajenas', async () => {
    const hash = bcrypt.hashSync('Segundo-123!', 10)
    const id2 = Number(sql(`INSERT INTO usuarios (rol, nombre, usuario, hash, debe_cambiar) VALUES ('docente', 'Segundo QA', 'profe2.qa', '${hash}', 0); SELECT last_insert_rowid();`).trim())
    const propia = Number(sql(`INSERT INTO materias (carrera_id, periodo_id, nombre, clave, docente_id) SELECT carrera_id, periodo_id, 'QA materia del segundo', 'QA-2', ${id2} FROM materias WHERE id = ${materia.id}; SELECT last_insert_rowid();`).trim())
    const login = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'profe2.qa', password: 'Segundo-123!' } })
    exige(login.estado === 200, JSON.stringify(login.datos))
    const otro = login.datos.sesion.token
    const suyas = await api('/docente/materias', { token: otro })
    exige(suyas.estado === 200 && suyas.datos.length === 1 && suyas.datos[0].id === propia, `ve ${JSON.stringify(suyas.datos.map((m) => m.nombre))}`)
    const det = await api(`/docente/intentos/${intento.id}`, { token: docente })
    const archivo = det.datos.archivos[0]
    const intentoAjeno = intento.id
    const alumnoAjeno = alumnos[0].id
    const pAjena = await api('/docente/partidas', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id } })
    const casos = [
      ['GET', `/docente/materias/${materia.id}/evaluaciones`],
      ['GET', `/docente/materias/${materia.id}/alumnos`],
      ['POST', `/docente/materias/${materia.id}/alumnos`, { nombre: 'Intruso' }],
      ['DELETE', `/docente/materias/${materia.id}/alumnos/${alumnoAjeno}`],
      ['PATCH', `/docente/materias/${materia.id}`, { oculta: true }],
      ['POST', `/docente/materias/${materia.id}/accesos`],
      ['GET', `/docente/evaluaciones/${evaluacion.id}`],
      ['POST', '/docente/asignaciones', { evaluacion_id: evaluacion.id, materia_id: materia.id }],
      ['GET', `/docente/asignaciones?materia_id=${materia.id}`],
      ['PATCH', `/docente/asignaciones/${asignacion.id}`, { activa: false }],
      ['GET', `/docente/asignaciones/${asignacion.id}/entregas`],
      ['GET', `/docente/intentos/${intentoAjeno}`],
      ['PUT', `/docente/intentos/${intentoAjeno}/calificar`, { puntaje: 0, retro: 'x' }],
      ['GET', `/docente/entregas/exportar?materia_id=${materia.id}`],
      ['POST', `/docente/alumnos/${alumnoAjeno}/reiniciar-password`],
      ['GET', `/archivos/${archivo.id}`],
      ['POST', '/docente/partidas', { evaluacion_id: evaluacion.id }],
      ['GET', `/docente/partidas/${pAjena.datos.pin}/detalle`]
    ]
    const pasaron = []
    for (const [metodo, ruta, cuerpo] of casos) {
      const r = await api(ruta, { metodo, token: otro, cuerpo })
      if (r.estado !== 404 && r.estado !== 403) pasaron.push(`${metodo} ${ruta} → ${r.estado}`)
    }
    exige(!pasaron.length, pasaron.join(' · '))
    // Los listados sin filtro no traen nada de las materias ajenas
    const lista = await api('/docente/asignaciones', { token: otro })
    exige(lista.estado === 200 && lista.datos.every((r) => r.asignacion.materia_id === propia), 'el listado de entregas trae materias ajenas')
    const avisos = await api('/notificaciones', { token: otro })
    exige(avisos.datos.length === 0, `recibió ${avisos.datos.length} avisos de materias ajenas`)
    // Nada cambió en lo del principal
    const intacta = await api(`/docente/asignaciones/${asignacion.id}/entregas`, { token: docente })
    exige(intacta.datos.asignacion.activa === 1, 'el segundo docente cerró una actividad ajena')
    // El juego: no puede controlar la partida de otro
    const sock = conectar(BASE, { auth: { token: otro } })
    await conectado(sock)
    const control = await new Promise((r) => sock.emit('partida:controlar', { pin: pAjena.datos.pin, accion: 'iniciar' }, r))
    sock.close()
    exige(!control.ok, 'controló la partida de otro docente')
    // Si inscribe a un alumno ajeno en su materia, no le cambia los datos ni le reinicia la contraseña
    const ins = await api(`/docente/materias/${propia}/alumnos`, { metodo: 'POST', token: otro, cuerpo: { matricula: alumnos[0].matricula, nombre: 'Cambiado', apellidos: 'Por Otro' } })
    exige(ins.estado === 200, JSON.stringify(ins.datos))
    const nombre = sql(`SELECT nombre FROM alumnos WHERE id = ${alumnoAjeno}`).trim()
    exige(nombre === alumnos[0].nombre, `le cambió el nombre a ${nombre}`)
    const reinicio = await api(`/docente/alumnos/${alumnoAjeno}/reiniciar-password`, { metodo: 'POST', token: otro })
    exige(reinicio.estado === 403, `reinició la contraseña de un alumno compartido: ${reinicio.estado}`)
    // Lo suyo sí lo maneja
    const evs = await api(`/docente/materias/${propia}/evaluaciones`, { token: otro })
    exige(evs.estado === 200, `su propia materia → ${evs.estado}`)
    // El principal sigue viendo todo, incluida la materia del segundo
    const todas = await api('/docente/materias', { token: docente })
    exige(todas.datos.some((m) => m.id === propia) && todas.datos.length === Number(sql('SELECT COUNT(*) FROM materias').trim()), 'el principal dejó de ver alguna materia')
    ok(`${casos.length} rutas ajenas → 404/403, listados y avisos limpios, sin control de partidas ajenas; el principal ve todo`)
  })

  // ---------- Código de acceso de la app de escritorio ----------
  await prueba('el código de acceso sirve una sola vez, caduca y no cierra otras sesiones', async () => {
    const nuevo = (vida) => {
      const codigo = randomBytes(24).toString('hex')
      const huella = createHash('sha256').update(codigo).digest('hex')
      sql(`INSERT INTO codigos_acceso (huella, usuario_id, expira) SELECT '${huella}', id, datetime('now', '${vida}') FROM usuarios WHERE usuario = 'profe'`)
      return codigo
    }
    const codigo = nuevo('+60 seconds')
    const r = await api('/auth/canjear', { metodo: 'POST', cuerpo: { codigo } })
    exige(r.estado === 200 && r.datos.sesion?.token && r.datos.sesion.usuario.usuario === 'profe', JSON.stringify(r.datos))
    const usa = await api('/docente/materias', { token: r.datos.sesion.token })
    exige(usa.estado === 200, `la sesión canjeada no sirve: ${usa.estado}`)
    const otraVez = await api('/auth/canjear', { metodo: 'POST', cuerpo: { codigo } })
    exige(otraVez.estado === 401, `el código sirvió dos veces: ${otraVez.estado}`)
    const caducado = await api('/auth/canjear', { metodo: 'POST', cuerpo: { codigo: nuevo('-1 seconds') } })
    exige(caducado.estado === 401, `un código caducado sirvió: ${caducado.estado}`)
    const inventado = await api('/auth/canjear', { metodo: 'POST', cuerpo: { codigo: randomBytes(24).toString('hex') } })
    exige(inventado.estado === 401, `un código inventado sirvió: ${inventado.estado}`)
    // La sesión que ya tenía abierta el docente sigue viva
    const sigue = await api('/docente/materias', { token: docente })
    exige(sigue.estado === 200, `el canje cerró la otra sesión del docente: ${sigue.estado}`)
    // El token ya no se acepta en la dirección
    const porUrl = await fetch(`${BASE}/api/docente/materias?token=${encodeURIComponent(docente)}`)
    exige(porUrl.status === 401, `?token= sigue sirviendo: ${porUrl.status}`)
    ok('canje único de 60 s, sin cerrar otras sesiones; ?token= rechazado')
  })
  await prueba('desde la app se cambia la contraseña sin la actual; con login normal se sigue pidiendo', async () => {
    const r = await api('/auth/canjear', { metodo: 'POST', cuerpo: { codigo: (() => {
      const codigo = randomBytes(24).toString('hex')
      sql(`INSERT INTO codigos_acceso (huella, usuario_id, expira) SELECT '${createHash('sha256').update(codigo).digest('hex')}', id, datetime('now', '+60 seconds') FROM usuarios WHERE usuario = 'profe'`)
      return codigo
    })() } })
    const app = r.datos.sesion.token
    exige(r.datos.sesion.usuario.desde_app === true, 'la sesión de la app no viene marcada')
    const yo = await api('/auth/yo', { token: app })
    exige(yo.datos.desde_app === true, '/auth/yo no dice que es de la app')
    const yoNormal = await api('/auth/yo', { token: docente })
    exige(!yoNormal.datos.desde_app, 'una sesión de login normal salió marcada como de la app')
    const debil = await api('/auth/password', { metodo: 'POST', token: app, cuerpo: { actual: '', nueva: 'debil' } })
    exige(debil.estado === 400 && /necesita/.test(debil.datos.error), 'aceptó una contraseña débil desde la app')
    const sinActual = await api('/auth/password', { metodo: 'POST', token: app, cuerpo: { actual: '', nueva: 'Desde-App-2026!' } })
    exige(sinActual.estado === 200, JSON.stringify(sinActual.datos))
    const nuevaSirve = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'profe', password: 'Desde-App-2026!' } })
    exige(nuevaSirve.estado === 200, 'la contraseña puesta desde la app no sirve para entrar')
    const normalSinActual = await api('/auth/password', { metodo: 'POST', token: docente, cuerpo: { actual: '', nueva: 'Otra-Mas-2026!' } })
    exige(normalSinActual.estado === 400, 'con login normal dejó cambiarla sin la actual')
    // Se deja como estaba para el resto de las pruebas
    const regreso = await api('/auth/password', { metodo: 'POST', token: app, cuerpo: { actual: '', nueva: 'Secreto-123!' } })
    exige(regreso.estado === 200, JSON.stringify(regreso.datos))
    ok('desde la app se cambia la contraseña sin la actual; con login normal se sigue pidiendo')
  })

  // ---------- Editor de código: programas del alumno, Python y modo examen ----------
  let programaId
  await prueba('programas del alumno: crear, leer y cambiar', async () => {
    const c = await api('/alumno/programas', { metodo: 'POST', token: alumno, cuerpo: { nombre: 'qa.py', lenguaje: 'python', codigo: 'print(1)', entrada: '' } })
    exige(c.estado === 200 && c.datos.id, JSON.stringify(c.datos))
    programaId = c.datos.id
    const u = await api(`/alumno/programas/${programaId}`, { metodo: 'PUT', token: alumno, cuerpo: { nombre: 'qa.py', lenguaje: 'python', codigo: 'print(2)', entrada: '' } })
    exige(u.estado === 200, JSON.stringify(u.datos))
    const l = await api('/alumno/programas', { token: alumno })
    exige(l.datos.some((p) => p.id === programaId && p.codigo === 'print(2)'), 'no se guardó el cambio')
    ok('el alumno crea, cambia y lee su programa')
  })
  await prueba('programas: un alumno no puede leer, cambiar ni borrar los de otro', async () => {
    const alta = await api(`/docente/materias/${materia.id}/alumnos`, { metodo: 'POST', token: docente, cuerpo: { matricula: 'QA2699', nombre: 'Otro', apellidos: 'Alumno' } })
    exige(alta.estado === 200, JSON.stringify(alta.datos))
    await api(`/docente/materias/${materia.id}/accesos`, { metodo: 'POST', token: docente })
    let l = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'QA2699', password: 'QA2699' } })
    await api('/auth/password', { metodo: 'POST', token: l.datos.sesion.token, cuerpo: { actual: 'QA2699', nueva: 'Otro4567!' } })
    l = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: 'QA2699', password: 'Otro4567!' } })
    const otro = l.datos.sesion.token
    const lista = await api('/alumno/programas', { token: otro })
    exige(lista.estado === 200 && !lista.datos.some((p) => p.id === programaId), 've programas ajenos')
    const cambio = await api(`/alumno/programas/${programaId}`, { metodo: 'PUT', token: otro, cuerpo: { nombre: 'robado', codigo: 'x' } })
    exige(cambio.estado === 404, `cambiar uno ajeno respondió ${cambio.estado}`)
    await api(`/alumno/programas/${programaId}`, { metodo: 'DELETE', token: otro })
    const sigue = await api('/alumno/programas', { token: alumno })
    exige(sigue.datos.some((p) => p.id === programaId && p.codigo === 'print(2)'), 'otro alumno lo cambió o lo borró')
    const docenteAqui = await api('/alumno/programas', { token: docente })
    exige(docenteAqui.estado === 403, `el docente entró a rutas de alumno: ${docenteAqui.estado}`)
    ok('cada alumno solo ve y cambia sus programas; el docente no usa rutas de alumno')
  })
  await prueba('programas: topes de tamaño', async () => {
    const largo = await api(`/alumno/programas/${programaId}`, { metodo: 'PUT', token: alumno, cuerpo: { nombre: 'qa.py', codigo: 'x'.repeat(100_001) } })
    exige(largo.estado === 400, `un programa de 100 001 caracteres respondió ${largo.estado}`)
    ok('un programa demasiado largo se rechaza con mensaje')
  })
  await prueba('Mi avance: apagado, por parcial publicado y sin fechas personales', async () => {
    sql(`INSERT INTO recordatorios (fecha, titulo, tipo) VALUES (date('now', '+3 days'), 'QA cita personal', 'otro')`)
    sql(`UPDATE calif_parciales SET publicado = 0 WHERE materia_id = ${materia.id}`)
    let r = await api('/alumno/avance', { token: alumno })
    exige(r.estado === 200 && r.datos.visible === true, JSON.stringify(r.datos).slice(0, 200))
    const m = r.datos.materias.find((x) => x.id === materia.id)
    exige(m, 'la materia no aparece en Mi avance')
    exige(m.parciales.every((p) => !p.publicado && p.calificacion === null && p.componentes.length === 0), 'muestra datos de un parcial sin publicar')
    exige(!m.proximas.some((f) => f.titulo === 'QA cita personal'), 'muestra un recordatorio personal sin materia')
    if (m.parciales.length) {
      sql(`UPDATE calif_parciales SET publicado = 1 WHERE id = (SELECT id FROM calif_parciales WHERE materia_id = ${materia.id} ORDER BY orden, id LIMIT 1)`)
      r = await api('/alumno/avance', { token: alumno })
      const p0 = r.datos.materias.find((x) => x.id === materia.id).parciales[0]
      exige(p0.publicado === true && Array.isArray(p0.componentes) && p0.componentes.length > 0, 'el parcial publicado no trae su detalle')
      exige(p0.componentes.every((c) => !/conéctalo|captura a mano|sin ligar/.test(c.detalle)), 'muestra al alumno instrucciones para el docente')
    }
    sql("INSERT INTO ajustes (clave, valor) VALUES ('portal_alumno_avance', '0') ON CONFLICT(clave) DO UPDATE SET valor = '0'")
    r = await api('/alumno/avance', { token: alumno })
    exige(r.datos.visible === false && r.datos.materias.length === 0, 'apagado sigue mostrando datos')
    sql("UPDATE ajustes SET valor = '1' WHERE clave = 'portal_alumno_avance'")
    ok('parcial sin publicar = «En captura» sin datos; publicado con detalle; sin fechas personales; se puede apagar')
  })
  await prueba('Python para los celulares: 404 real, revalidación y nada fuera de la carpeta', async () => {
    const no = await fetch(`${BASE}/pyodide/no-existe-1.0-py3-none-any.whl`)
    exige(no.status === 404, `un paquete que falta respondió ${no.status} (${no.headers.get('content-type')})`)
    const si = await fetch(`${BASE}/pyodide/pyodide.mjs`, { headers: { 'Accept-Encoding': 'gzip' } })
    const etag = si.headers.get('etag')
    exige(si.status === 200 && etag && /no-cache/.test(si.headers.get('cache-control') ?? ''), `pyodide.mjs: ${si.status} ${si.headers.get('cache-control')}`)
    const otra = await fetch(`${BASE}/pyodide/pyodide.mjs`, { headers: { 'If-None-Match': etag } })
    exige(otra.status === 304, `la revalidación respondió ${otra.status}`)
    const fuera = await fetch(`${BASE}/pyodide/..%2Fpackage.json`)
    exige(fuera.status === 403 || fuera.status === 404, `salirse de la carpeta respondió ${fuera.status}`)
    const csp = (await fetch(`${BASE}/`)).headers.get('content-security-policy') ?? ''
    exige(/connect-src 'self'/.test(csp) && !/connect-src[^;]* ws: /.test(csp), `connect-src abierto: ${csp}`)
    ok('falta → 404; se revalida con ETag (304); no sale de la carpeta; conexiones solo al mismo servidor')
  })
  await prueba('modo examen: con un examen abierto no hay Programar', async () => {
    const tipo = sql(`SELECT tipo FROM evaluaciones WHERE id = ${evaluacion.id}`).trim()
    sql(`UPDATE evaluaciones SET tipo = 'examen' WHERE id = ${evaluacion.id}`)
    const pub = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evaluacion.id, materia_id: materia.id, titulo: 'QA modo examen' } })
    const ini = await api(`/alumno/asignaciones/${pub.datos.id}/iniciar`, { metodo: 'POST', token: alumno })
    exige(ini.estado === 200, JSON.stringify(ini.datos))
    const durante = await api('/alumno/estado', { token: alumno })
    exige(durante.datos.examen === true, 'no detectó el examen abierto')
    const bloqueado = await api('/alumno/programas', { token: alumno })
    exige(bloqueado.estado === 423, `Programar durante el examen respondió ${bloqueado.estado}`)
    await api(`/alumno/intentos/${ini.datos.intento.id}/enviar`, { metodo: 'POST', token: alumno })
    const despues = await api('/alumno/estado', { token: alumno })
    exige(despues.datos.examen === false, 'siguió en modo examen después de enviar')
    sql(`UPDATE evaluaciones SET tipo = '${tipo}' WHERE id = ${evaluacion.id}`)
    ok('examen abierto → Programar bloqueado (423); al enviar vuelve')
  })
  // ---------- Lo que el alumno ve además de sus actividades ----------
  const alumnoId = Number(sql(`SELECT id FROM alumnos WHERE matricula = '${matricula}'`).trim())
  await prueba('Programar por materia: se apaga si ninguna de sus materias lo usa', async () => {
    const antes = sql(`SELECT group_concat(id || ':' || portal_programar) FROM materias`).trim()
    let r = await api('/alumno/estado', { token: alumno })
    exige(r.datos.programar === true, `con todas encendidas: ${JSON.stringify(r.datos)}`)
    sql(`UPDATE materias SET portal_programar = 0 WHERE id IN (SELECT materia_id FROM inscripciones WHERE alumno_id = ${alumnoId})`)
    r = await api('/alumno/estado', { token: alumno })
    exige(r.datos.programar === false, 'siguió mostrando Programar con todas sus materias apagadas')
    for (const par of antes.split(',')) { const [id, v] = par.split(':'); sql(`UPDATE materias SET portal_programar = ${v} WHERE id = ${id}`) }
    ok('Programar se oculta cuando ninguna de sus materias lo usa')
  })
  await prueba('materiales: solo los compartidos; archivo y enlace', async () => {
    const archivo = join(datos, 'qa-lectura.pdf')
    writeFileSync(archivo, '%PDF-1.4 qa')
    sql(`INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, compartido) VALUES (${materia.id}, 'QA lectura', 'pdf', '${archivo}', 'Unidad QA', 1)`)
    sql(`INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, compartido) VALUES (${materia.id}, 'QA enlace', 'link', 'https://example.com/qa', 'Unidad QA', 1)`)
    sql(`INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, compartido) VALUES (${materia.id}, 'QA privado', 'pdf', '${archivo}', 'Unidad QA', 0)`)
    const r = await api('/alumno/materiales', { token: alumno })
    exige(r.estado === 200, JSON.stringify(r.datos))
    const lectura = r.datos.find((m) => m.titulo === 'QA lectura')
    const enlace = r.datos.find((m) => m.titulo === 'QA enlace')
    exige(lectura?.disponible && enlace?.disponible, 'faltan los compartidos')
    exige(!r.datos.some((m) => m.titulo === 'QA privado'), 've un material sin compartir')
    const d = await api(`/alumno/materiales/${lectura.id}`, { token: alumno })
    exige(d.estado === 200 && Buffer.from(d.datos).toString().startsWith('%PDF'), `descarga: ${d.estado}`)
    const l = await api(`/alumno/materiales/${enlace.id}`, { token: alumno })
    exige(l.datos.url === 'https://example.com/qa', JSON.stringify(l.datos))
    const privado = Number(sql("SELECT id FROM materiales WHERE titulo = 'QA privado'").trim())
    const no = await api(`/alumno/materiales/${privado}`, { token: alumno })
    exige(no.estado === 404, `uno sin compartir respondió ${no.estado}`)
    ok('ve y descarga los compartidos (archivo y enlace); uno sin compartir → 404')
  })
  await prueba('calendario: exámenes anunciados sí, sorpresa no', async () => {
    sql(`INSERT INTO evaluaciones (materia_id, tipo, titulo, fecha_aplicacion) VALUES (${materia.id}, 'examen', 'QA examen anunciado', date('now', '+2 days'))`)
    sql(`INSERT INTO evaluaciones (materia_id, tipo, titulo, fecha_aplicacion) VALUES (${materia.id}, 'examen_sorpresa', 'QA sorpresa', date('now', '+2 days'))`)
    const r = await api('/alumno/calendario', { token: alumno })
    exige(r.estado === 200 && Array.isArray(r.datos), JSON.stringify(r.datos))
    exige(r.datos.some((e) => e.tipo === 'examen' && e.titulo === 'QA examen anunciado'), 'no aparece el examen anunciado')
    exige(!r.datos.some((e) => e.titulo === 'QA sorpresa'), 'aparece el examen sorpresa')
    exige(r.datos.every((e, i, a) => i === 0 || a[i - 1].fecha <= e.fecha), 'no viene en orden')
    ok(`calendario con ${r.datos.length} eventos en orden; el sorpresa no se anuncia`)
  })
  await prueba('avisos del docente: al grupo y por carrera', async () => {
    const r = await api(`/docente/materias/${materia.id}/avisos`, { metodo: 'POST', token: docente, cuerpo: { titulo: 'QA mañana no hay clase', cuerpo: 'Nos vemos el jueves' } })
    exige(r.estado === 200 && r.datos.enviados >= 1, JSON.stringify(r.datos))
    const n = await api('/notificaciones?no_leidas=1', { token: alumno })
    const aviso = n.datos.find((x) => x.tipo === 'aviso' && x.titulo === 'QA mañana no hay clase')
    exige(aviso && aviso.cuerpo.includes('Nos vemos el jueves'), 'el alumno no recibió el aviso')
    const ninguna = await api(`/docente/materias/${materia.id}/avisos`, { metodo: 'POST', token: docente, cuerpo: { titulo: 'QA otra carrera', carrera_id: 999999 } })
    exige(ninguna.datos.enviados === 0, `a una carrera sin alumnos llegó a ${ninguna.datos.enviados}`)
    const vacio = await api(`/docente/materias/${materia.id}/avisos`, { metodo: 'POST', token: docente, cuerpo: { titulo: '  ' } })
    exige(vacio.estado === 400, `un aviso vacío respondió ${vacio.estado}`)
    const c = await api(`/docente/materias/${materia.id}/carreras`, { token: docente })
    exige(c.estado === 200 && Array.isArray(c.datos), JSON.stringify(c.datos))
    const deAlumno = await api(`/docente/materias/${materia.id}/avisos`, { metodo: 'POST', token: alumno, cuerpo: { titulo: 'x' } })
    exige(deAlumno.estado === 403, `un alumno mandó un aviso: ${deAlumno.estado}`)
    await api('/notificaciones/leidas', { metodo: 'POST', token: alumno, cuerpo: { ids: [aviso.id] } })
    ok(`aviso a ${r.datos.enviados} alumno(s); por carrera filtra; vacío → 400; un alumno no puede mandarlos`)
  })
  await prueba('tareas: ocultas, para algunos y entregas tarde', async () => {
    const t = await api('/alumno/tareas', { token: alumno })
    exige(t.estado === 200, JSON.stringify(t.datos))
    const todas = t.datos.flatMap((m) => m.tareas)
    if (!todas.length) return ok('tareas: el alumno de prueba no tiene tareas de Classroom en esta copia (se omite)')
    const x = todas[0]
    sql(`INSERT OR REPLACE INTO portal_tareas (curso_id, tarea_id, visibilidad, alumnos, acepta_tarde) VALUES ('${x.curso_id}', '${x.tarea_id}', 'oculta', '[]', 1)`)
    let r = await api('/alumno/tareas', { token: alumno })
    exige(!r.datos.flatMap((m) => m.tareas).some((y) => y.tarea_id === x.tarea_id), 'una tarea oculta se sigue viendo')
    sql(`UPDATE portal_tareas SET visibilidad = 'algunos', alumnos = '[${alumnoId}]' WHERE tarea_id = '${x.tarea_id}'`)
    r = await api('/alumno/tareas', { token: alumno })
    exige(r.datos.flatMap((m) => m.tareas).some((y) => y.tarea_id === x.tarea_id), 'no ve la tarea que es solo para él')
    sql(`UPDATE portal_tareas SET alumnos = '[-1]' WHERE tarea_id = '${x.tarea_id}'`)
    r = await api('/alumno/tareas', { token: alumno })
    exige(!r.datos.flatMap((m) => m.tareas).some((y) => y.tarea_id === x.tarea_id), 've una tarea que es para otro alumno')
    const vencida = todas.find((y) => y.estado === 'vencida')
    if (vencida) {
      sql(`INSERT OR REPLACE INTO portal_tareas (curso_id, tarea_id, visibilidad, alumnos, acepta_tarde) VALUES ('${vencida.curso_id}', '${vencida.tarea_id}', 'todos', '[]', 0)`)
      r = await api('/alumno/tareas', { token: alumno })
      const v = r.datos.flatMap((m) => m.tareas).find((y) => y.tarea_id === vencida.tarea_id)
      exige(v?.estado === 'cerrada' && v.acepta_tarde === false, `sin entregas tarde quedó ${v?.estado}`)
      const form = new FormData()
      form.append('archivos', new Blob(['hola']), 'tarde.txt')
      const subir = await api(`/alumno/tareas/${encodeURIComponent(vencida.curso_id)}/${encodeURIComponent(vencida.tarea_id)}/archivos`, { metodo: 'POST', token: alumno, form })
      exige(subir.estado >= 400, `aceptó una entrega tarde: ${subir.estado}`)
    }
    sql(`DELETE FROM portal_tareas`)
    ok(`oculta no se ve; «algunos» solo a los elegidos${vencida ? '; sin entregas tarde queda «cerrada» y no acepta archivos' : ''}`)
  })
  await prueba('sincronización: columnas nuevas también se registran', async () => {
    const antes = Number(sql("SELECT COUNT(*) FROM _cambios WHERE tabla = 'materiales'").trim())
    sql(`UPDATE materiales SET compartido = 1 - compartido WHERE titulo = 'QA privado'`)
    const despues = Number(sql("SELECT COUNT(*) FROM _cambios WHERE tabla = 'materiales'").trim())
    exige(despues > antes, 'compartir un material no quedó en el registro de cambios')
    ok('compartir un material (columna nueva) entra al registro de cambios')
  })
  // ---------- Notificaciones push y avisos automáticos ----------
  const endpointQa = 'https://push.example.com/qa-' + randomBytes(6).toString('hex')
  const suscripcionQa = { endpoint: endpointQa, keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'a'.repeat(22) } }
  await prueba('push: llave del servidor y suscripción por usuario', async () => {
    const c = await api('/push/clave', { token: alumno })
    exige(c.estado === 200 && /^[\w-]{80,100}$/.test(c.datos.publica), JSON.stringify(c.datos))
    const c2 = await api('/push/clave', { token: docente })
    exige(c2.datos.publica === c.datos.publica, 'la llave cambia entre usuarios')
    const sinSesion = await api('/push/clave')
    exige(sinSesion.estado === 401, `sin sesión respondió ${sinSesion.estado}`)
    const r = await api('/push/suscripciones', { metodo: 'POST', token: alumno, cuerpo: { suscripcion: suscripcionQa, dispositivo: 'Android · app' } })
    exige(r.estado === 200, JSON.stringify(r.datos))
    const http = await api('/push/suscripciones', { metodo: 'POST', token: alumno, cuerpo: { suscripcion: { ...suscripcionQa, endpoint: 'http://127.0.0.1:22/x' }, dispositivo: 'x' } })
    exige(http.estado === 400, `aceptó un destino que no es https: ${http.estado}`)
    const mia = await api('/push/revisar', { metodo: 'POST', token: alumno, cuerpo: { endpoint: endpointQa } })
    exige(mia.datos.activa === true, 'no quedó activa para el alumno')
    const ajena = await api('/push/revisar', { metodo: 'POST', token: docente, cuerpo: { endpoint: endpointQa } })
    exige(ajena.datos.activa === false, 'aparece activa para otro usuario')
    const llave = sql("SELECT valor FROM ajustes WHERE clave = 'push_vapid'").trim()
    exige(llave.includes(c.datos.publica), 'la llave no quedó guardada en la base')
    exige(Number(sql("SELECT COUNT(*) FROM _cambios WHERE tabla IN ('push_suscripciones', 'avisos_dados')").trim()) === 0, 'las suscripciones entran a la sincronización')
    ok('llave propia guardada; suscripción solo https, ligada a su usuario y fuera de la sincronización')
  })
  await prueba('push: un aviso del docente sale al dispositivo del alumno', async () => {
    sql(`UPDATE push_suscripciones SET ultimo_envio = NULL WHERE endpoint = '${endpointQa}'`)
    await api(`/docente/materias/${materia.id}/avisos`, { metodo: 'POST', token: docente, cuerpo: { titulo: 'QA push' } })
    let enviado = ''
    for (let i = 0; i < 20 && !enviado; i++) { await espera(100); enviado = sql(`SELECT COALESCE(ultimo_envio, '') FROM push_suscripciones WHERE endpoint = '${endpointQa}'`).trim() }
    exige(enviado, 'no se mandó el push del aviso')
    const prueba_ = await api('/push/prueba', { metodo: 'POST', token: alumno })
    exige(prueba_.estado === 200 && prueba_.datos.dispositivos === 1, JSON.stringify(prueba_.datos))
    ok('el aviso guardado en la campana también sale como push; «Enviar una de prueba» responde')
  })
  await prueba('avisos automáticos: tarea nueva, vence pronto y calificación', async () => {
    for (let i = 0; i < 50 && !sql("SELECT valor FROM ajustes WHERE clave = 'avisos_auto_desde'").trim(); i++) await espera(200)
    exige(sql("SELECT valor FROM ajustes WHERE clave = 'avisos_auto_desde'").trim(), 'la revisión automática no arrancó')
    const usuarioId = Number(sql(`SELECT id FROM usuarios WHERE alumno_id = ${alumnoId}`).trim())
    const vence = new Date(Date.now() + 10 * 3600_000).toISOString()
    sql(`INSERT INTO classroom_cursos (id, nombre, materia_id, activo) VALUES ('qa-curso', 'QA curso', ${materia.id}, 1)`)
    sql(`INSERT INTO classroom_alumnos (curso_id, user_id, nombre, alumno_id, liga) VALUES ('qa-curso', 'qa-u1', 'QA', ${alumnoId}, 'confirmada')`)
    sql(`INSERT INTO classroom_tareas (curso_id, id, titulo, puntos, vence, creada) VALUES ('qa-curso', 'qa-t1', 'QA tarea push', 10, '${vence}', datetime('now'))`)
    sql(`INSERT INTO classroom_entregas (curso_id, id, tarea_id, user_id, estado) VALUES ('qa-curso', 'qa-e1', 'qa-t1', 'qa-u1', 'CREATED')`)
    const titulos = () => sql(`SELECT titulo FROM notificaciones WHERE usuario_id = ${usuarioId} AND ref_tipo = 'tarea'`)
    let t = ''
    for (let i = 0; i < 40 && !(t.includes('Tarea nueva: QA tarea push') && t.includes('Vence')); i++) { await espera(200); t = titulos() }
    exige(t.includes('Tarea nueva: QA tarea push'), `no avisó de la tarea nueva: ${t}`)
    exige(/Vence (hoy|mañana) a las \d\d:\d\d: QA tarea push/.test(t), `no avisó que vence pronto: ${t}`)
    sql(`UPDATE classroom_entregas SET estado = 'RETURNED', calificacion = 9 WHERE id = 'qa-e1'`)
    for (let i = 0; i < 40 && !t.includes('Calificación: QA tarea push'); i++) { await espera(200); t = titulos() }
    exige(t.includes('Calificación: QA tarea push'), `no avisó de la calificación: ${t}`)
    await espera(3500)
    const veces = Number(sql(`SELECT COUNT(*) FROM notificaciones WHERE usuario_id = ${usuarioId} AND titulo LIKE '%QA tarea push%'`).trim())
    exige(veces === 3, `los avisos se repitieron: ${veces}`)
    // A los de la materia sin cuenta de Classroom ligada también les toca (ven todas las tareas del curso); a los de otras materias, no
    const otros = Number(sql(`SELECT COUNT(*) FROM notificaciones n JOIN usuarios u ON u.id = n.usuario_id WHERE n.titulo LIKE '%QA tarea push%' AND u.alumno_id NOT IN (SELECT alumno_id FROM inscripciones WHERE materia_id = ${materia.id})`).trim())
    exige(otros === 0, `les llegó a ${otros} que no están en la materia`)
    const n = await api('/notificaciones', { token: alumno })
    exige(n.datos.some((x) => x.ref_tipo === 'tarea'), 'no aparecen en su campana')
    ok('tarea nueva + «vence hoy/mañana» + calificación devuelta, una sola vez y solo a quien la tiene')
  })
  await prueba('cuadernos: copia propia, guardado, entrega a la tarea y cerrado', async () => {
    const nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# QA cuaderno\n', 'Contesta aquí'] },
      { cell_type: 'code', metadata: {}, source: ['x = 2'], outputs: [], execution_count: null }
    ] }
    const archivo = join(datos, 'qa-cuaderno.ipynb')
    writeFileSync(archivo, JSON.stringify(nb))
    sql(`INSERT INTO materiales (materia_id, titulo, tipo, ruta, unidad, compartido) VALUES (${materia.id}, 'QA cuaderno.ipynb', 'codigo', '${archivo}', 'QA', 1)`)
    const mid = Number(sql("SELECT id FROM materiales WHERE titulo = 'QA cuaderno.ipynb'").trim())
    const lista = await api('/alumno/materiales', { token: alumno })
    const m = lista.datos.find((x) => x.id === mid)
    exige(m?.cuaderno === true && m.cuaderno_estado === 'nuevo', `en Materiales: ${JSON.stringify(m)}`)
    const abierto = await api(`/alumno/cuadernos/${mid}`, { token: alumno })
    exige(abierto.estado === 200 && abierto.datos.estado === 'borrador' && abierto.datos.contenido.cells.length === 2, JSON.stringify(abierto.datos).slice(0, 200))
    const mio = { ...nb, cells: [...nb.cells, { cell_type: 'code', metadata: { docente_agregada: true }, source: ['print(x)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['2\n'] }], execution_count: 1 }] }
    const g = await api(`/alumno/cuadernos/${mid}`, { metodo: 'PUT', token: alumno, cuerpo: { contenido: mio } })
    exige(g.estado === 200, JSON.stringify(g.datos))
    const malo = await api(`/alumno/cuadernos/${mid}`, { metodo: 'PUT', token: alumno, cuerpo: { contenido: { hola: 1 } } })
    exige(malo.estado === 400, `un contenido que no es cuaderno respondió ${malo.estado}`)
    const otro = Number(sql("SELECT id FROM materiales WHERE titulo = 'QA lectura'").trim())
    const noEs = await api(`/alumno/cuadernos/${otro}`, { token: alumno })
    exige(noEs.estado === 400, `un PDF abierto como cuaderno respondió ${noEs.estado}`)
    // Una tarea abierta propia de esta prueba (la de los avisos ya quedó devuelta con calificación)
    sql(`INSERT INTO classroom_tareas (curso_id, id, titulo, puntos, vence, creada) VALUES ('qa-curso', 'qa-t2', 'QA tarea cuaderno', 10, '${new Date(Date.now() + 2 * 86400_000).toISOString()}', datetime('now'))`)
    sql(`INSERT INTO classroom_entregas (curso_id, id, tarea_id, user_id, estado) VALUES ('qa-curso', 'qa-e2', 'qa-t2', 'qa-u1', 'CREATED')`)
    const tareasC = await api(`/alumno/cuadernos/${mid}/tareas`, { token: alumno })
    exige(tareasC.datos.some((t) => t.tarea_id === 'qa-t2') && !tareasC.datos.some((t) => t.tarea_id === 'qa-t1'), `tareas ofrecidas: ${JSON.stringify(tareasC.datos.map((t) => t.tarea_id))}`)
    const sinTarea = await api(`/alumno/cuadernos/${mid}/entregar`, { metodo: 'POST', token: alumno, cuerpo: {} })
    exige(sinTarea.estado === 400, `entregar sin tarea respondió ${sinTarea.estado}`)
    const e = await api(`/alumno/cuadernos/${mid}/entregar`, { metodo: 'POST', token: alumno, cuerpo: { curso_id: 'qa-curso', tarea_id: 'qa-t2', contenido: mio } })
    exige(e.estado === 200 && e.datos.estado === 'entregado' && e.datos.tarea_titulo === 'QA tarea cuaderno', JSON.stringify(e.datos).slice(0, 200))
    const archivoEntregado = sql(`SELECT a.nombre || '|' || a.ruta FROM archivos_subida a JOIN subidas_alumno s ON s.id = a.subida_id WHERE s.alumno_id = ${alumnoId} AND s.tarea_id = 'qa-t2' AND a.nombre LIKE '%.ipynb'`).trim()
    exige(archivoEntregado, 'no se registró el archivo en la tarea')
    const [nombre, ruta] = archivoEntregado.split('|')
    const final = JSON.parse(readFileSync(join(datos, 'entregas', ruta), 'utf8'))
    exige(/^QA_cuaderno_\w+\.ipynb$/.test(nombre) && final.metadata.kernelspec?.name === 'python3' && final.cells.length === 3 && final.cells[2].outputs[0].text.join('') === '2\n', `archivo entregado: ${nombre}`)
    const despues = await api(`/alumno/cuadernos/${mid}`, { metodo: 'PUT', token: alumno, cuerpo: { contenido: nb } })
    exige(despues.estado === 409, `cambiar uno entregado respondió ${despues.estado}`)
    const otraVez = await api(`/alumno/cuadernos/${mid}/entregar`, { metodo: 'POST', token: alumno, cuerpo: { curso_id: 'qa-curso', tarea_id: 'qa-t2' } })
    exige(otraVez.estado === 409, `entregar dos veces respondió ${otraVez.estado}`)
    const aviso = sql(`SELECT COUNT(*) FROM notificaciones WHERE tipo = 'entrega' AND titulo LIKE '%QA tarea cuaderno%'`).trim()
    exige(Number(aviso) >= 1, 'al docente no le llegó el aviso')
    const ajeno = await api(`/alumno/cuadernos/${mid}`, { token: docente })
    exige(ajeno.estado === 403, `el docente usó la ruta de alumno: ${ajeno.estado}`)
    ok('el alumno abre su copia, guarda, entrega a la tarea (.ipynb con respuestas y salidas, aviso al docente) y queda cerrado')
  })
  await prueba('examen con cuaderno: tiempo, guardado completo, bloqueo de otros cuadernos y revisión', async () => {
    const nbEx = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Examen QA\n', 'Explica tu respuesta'] },
      { cell_type: 'code', metadata: {}, source: ['def suma(a, b):\n', '    pass'], outputs: [], execution_count: null }
    ] }
    const contenido = { titulo: 'QA examen cuaderno', instrucciones: 'Resuelve', duracion_min: 30, preguntas: [{ tipo: 'cuaderno', enunciado: 'Resuelve el cuaderno', respuesta: '', puntos: 100, explicacion: '', cuaderno: JSON.stringify(nbEx), paquetes: false }] }
    sql(`INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (${materia.id}, 'examen', 'QA examen cuaderno', '${JSON.stringify(contenido).replace(/'/g, "''")}', 100)`)
    const evId = Number(sql("SELECT id FROM evaluaciones WHERE titulo = 'QA examen cuaderno'").trim())
    const pub = await api('/docente/asignaciones', { metodo: 'POST', token: docente, cuerpo: { evaluacion_id: evId, materia_id: materia.id, titulo: 'QA examen cuaderno', vigilancia: true, cerrar_al_salir: true, duracion_min: 30 } })
    exige(pub.estado === 200, JSON.stringify(pub.datos))
    const ini = await api(`/alumno/asignaciones/${pub.datos.id}/iniciar`, { metodo: 'POST', token: alumno })
    const p0 = ini.datos.preguntas?.[0]
    exige(ini.estado === 200 && p0?.tipo === 'cuaderno' && JSON.parse(p0.cuaderno).cells.length === 2 && p0.paquetes === false && !('respuesta' in p0), `pregunta: ${JSON.stringify(p0).slice(0, 200)}`)
    const iid = ini.datos.intento.id
    const mid = Number(sql("SELECT id FROM materiales WHERE titulo = 'QA cuaderno.ipynb'").trim())
    const otroCuaderno = await api(`/alumno/cuadernos/${mid}`, { token: alumno })
    exige(otroCuaderno.estado === 423, `otro cuaderno durante el examen respondió ${otroCuaderno.estado}`)
    // Un cuaderno con salidas largas pasa de los 20 000 caracteres de una respuesta normal: no se recorta
    const largo = 'x'.repeat(50_000)
    const resuelto = { ...nbEx, cells: [{ ...nbEx.cells[0], source: ['Mi respuesta'] }, { ...nbEx.cells[1], source: ['def suma(a, b):\n', '    return a + b\n', 'print(suma(2, 3))'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['5\n', largo] }], execution_count: 1 }] }
    const g = await api(`/alumno/intentos/${iid}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: JSON.stringify(resuelto) }, tiempo_activo_seg: 30 } })
    exige(g.estado === 200, JSON.stringify(g.datos).slice(0, 200))
    const guardada = JSON.parse(JSON.parse(sql(`SELECT respuestas FROM intentos WHERE id = ${iid}`).trim())['0'])
    exige(guardada.cells[1].outputs[0].text.join('').length === 50_002, 'el cuaderno se recortó al guardarlo')
    const malo = await api(`/alumno/intentos/${iid}/respuestas`, { metodo: 'PUT', token: alumno, cuerpo: { respuestas: { 0: '{"no":"cuaderno"}' }, tiempo_activo_seg: 31 } })
    exige(malo.estado === 400, `una respuesta que no es cuaderno respondió ${malo.estado}`)
    const env = await api(`/alumno/intentos/${iid}/enviar`, { metodo: 'POST', token: alumno })
    exige(env.estado === 200 && env.datos.estado === 'enviado' && env.datos.pendiente_manual, `envío: ${JSON.stringify(env.datos).slice(0, 200)}`)
    const libre = await api(`/alumno/cuadernos/${mid}`, { token: alumno })
    exige(libre.estado === 200, `al terminar el examen el cuaderno de Materiales respondió ${libre.estado}`)
    const det = await api(`/docente/intentos/${iid}`, { token: docente })
    const q = det.datos.preguntas[0]
    exige(q.tipo === 'cuaderno' && JSON.parse(q.respuesta_alumno).cells[1].execution_count === 1 && JSON.parse(q.cuaderno).cells.length === 2, 'el docente no ve el cuaderno del alumno')
    const cal = await api(`/docente/intentos/${iid}/calificar`, { metodo: 'PUT', token: docente, cuerpo: { puntaje: 90, retro: 'Bien' } })
    exige(cal.estado === 200 && cal.datos.estado === 'calificado', JSON.stringify(cal.datos).slice(0, 200))
    ok('el alumno resuelve el cuaderno en el examen (guardado completo, sin otros cuadernos), lo envía y el docente lo revisa y califica')
  })
  await prueba('push: al apagarlas este dispositivo deja de recibir', async () => {
    const r = await api('/push/suscripciones', { metodo: 'DELETE', token: alumno, cuerpo: { endpoint: endpointQa } })
    exige(r.datos.borradas === 1, JSON.stringify(r.datos))
    const ya = await api('/push/revisar', { metodo: 'POST', token: alumno, cuerpo: { endpoint: endpointQa } })
    exige(ya.datos.activa === false, 'sigue activa')
    ok('apagar borra la suscripción de ese dispositivo')
  })
  await prueba('portal instalable: manifest, service worker e íconos sin caché larga', async () => {
    const m = await fetch(`${BASE}/manifest.webmanifest`)
    const j = await m.json()
    exige(m.ok && j.display === 'standalone' && j.icons.some((i) => i.purpose === 'maskable'), JSON.stringify(j).slice(0, 200))
    const sw = await fetch(`${BASE}/sw.js`)
    exige(sw.ok && /javascript/.test(sw.headers.get('content-type') ?? '') && /no-cache/.test(sw.headers.get('cache-control') ?? ''), `sw.js: ${sw.status} ${sw.headers.get('content-type')} ${sw.headers.get('cache-control')}`)
    for (const f of ['icono-192.png', 'icono-512.png', 'icono-maskable-512.png', 'apple-touch-icon.png', 'insignia-96.png']) {
      const r = await fetch(`${BASE}/${f}`)
      exige(r.ok && r.headers.get('content-type') === 'image/png', `${f}: ${r.status}`)
    }
    const html = await (await fetch(`${BASE}/`)).text()
    exige(html.includes('rel="manifest"') && html.includes('apple-touch-icon'), 'index.html sin manifest o ícono de iPhone')
    ok('manifest standalone con ícono adaptable; sw.js sin caché; íconos servidos')
  })
  await prueba('la raíz es la app para el docente y el portal para los alumnos; /app lleva a la raíz', async () => {
    const sinPista = await fetch(`${BASE}/`)
    const portal = await sinPista.text()
    exige(sinPista.ok && !portal.includes('/app/assets/'), 'sin la pista la raíz no es el portal')
    const conPista = await fetch(`${BASE}/`, { headers: { Cookie: 'docente_app=1' } })
    const app = await conPista.text()
    exige(conPista.ok && app.includes('/app/assets/'), 'con la pista del docente la raíz no es la app')
    exige(/frame-ancestors 'none'/.test(conPista.headers.get('content-security-policy') ?? ''), 'la app en la raíz perdió su CSP')
    exige((conPista.headers.get('vary') ?? '').toLowerCase().includes('cookie'), 'falta Vary: Cookie (una caché podría mezclar las dos páginas)')
    const otraCookie = await fetch(`${BASE}/`, { headers: { Cookie: 'otra=1; docente_app=0' } })
    exige(!(await otraCookie.text()).includes('/app/assets/'), 'una cookie parecida abrió la app')
    const viejo = await fetch(`${BASE}/app/`, { redirect: 'manual' })
    exige(viejo.status === 302 && viejo.headers.get('location') === '/', `/app no lleva a la raíz: ${viejo.status} ${viejo.headers.get('location')}`)
    const alumnoRuta = await fetch(`${BASE}/tareas`, { headers: { Cookie: 'docente_app=1' } })
    exige(alumnoRuta.ok && !(await alumnoRuta.text()).includes('/app/assets/'), 'la pista cambió otras rutas del portal')
    ok('la raíz es la app para el docente y el portal para los alumnos; /app lleva a la raíz')
  })
  await prueba('partidas abiertas para retomarlas', async () => {
    const r = await api('/docente/partidas', { token: docente })
    exige(r.estado === 200 && Array.isArray(r.datos), JSON.stringify(r.datos))
    ok(`lista de partidas abiertas (${r.datos.length})`)
  })

  // ---------- Contraseña ----------
  await prueba('cambio de contraseña del alumno', async () => {
    const bien = await api('/auth/password', { metodo: 'POST', token: alumno, cuerpo: { actual: 'Nueva123!', nueva: 'Otra4567!' } })
    exige(bien.estado === 200, JSON.stringify(bien.datos))
    const viejo = await api('/auth/login', { metodo: 'POST', cuerpo: { usuario: matricula, password: 'Nueva123!' } })
    exige(viejo.estado === 401, 'la contraseña anterior sigue sirviendo')
    ok('cambio de contraseña')
  })
  await prueba('cerrar sesión invalida el token', async () => {
    await api('/auth/logout', { metodo: 'POST', token: alumno })
    const r = await api('/alumno/asignaciones', { token: alumno })
    exige(r.estado === 401, `token siguió vivo: ${r.estado}`)
    ok('logout')
  })
} catch (e) {
  fallos.push(`arranque: ${e.message}`)
} finally {
  servidor.kill()
  rmSync(datos, { recursive: true, force: true })
}

console.log(`\n${pasos} comprobaciones correctas · ${fallos.length} fallos`)
fallos.forEach((f) => console.log('  •', f))
if (fallos.length && /Error|error/.test(logServidor)) console.log('\n--- salida del servidor ---\n' + logServidor.slice(-2000))
process.exit(fallos.length ? 1 : 0)
