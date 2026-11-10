/**
 * Asistente tipo chat (sección «Asistente» de la app): conversaciones guardadas con Claude (o NVIDIA),
 * con el temario y los materiales de la materia como contexto. La respuesta llega en vivo: cada pedazo
 * de texto se manda a la ventana con el aviso «asistente:trozo». Todo queda en la base local.
 */
import { BrowserWindow } from 'electron'
import type Anthropic from '@anthropic-ai/sdk'
import { getDb } from '../db'
import { cliente, contextoMateria, explicarError, llaveNvidia, modelo, proveedor, MAX_TOKENS_CLAUDE } from './ia'
import { completar as completarNvidia } from './nvidia'
import { registrarUso } from './uso-ia'

export interface Conversacion {
  id: number
  titulo: string
  materia_id: number | null
  materia_nombre: string | null
  actualizado: string
}
export interface MensajeChat {
  id: number
  conversacion_id: number
  rol: 'usuario' | 'asistente'
  contenido: string
  creado: string
}

const SYSTEM_CHAT = `Eres el asistente de un docente de una universidad tecnológica en México. Conversas con él para preparar clases, explicar temas, resolver ejercicios, revisar código, redactar material y planear evaluaciones.
Reglas:
- Responde en español de México, claro y bien organizado (títulos, listas y tablas en Markdown cuando ayuden).
- Cuando expliques un tema, explícalo completo: idea intuitiva, definición formal, ejemplos resueltos paso a paso y errores comunes. No te quedes en viñetas sueltas.
- Fórmulas en LaTeX con $...$ y $$...$$. Código en bloques con su lenguaje (\`\`\`python, \`\`\`javascript…), comentado y que funcione.
- Sé exacto: si algo no es seguro o depende del programa oficial, dilo. No inventes datos, fuentes ni URLs.
- Si hay temario o materiales de la materia en el contexto, apégate a ellos y a su nivel.`

/** Cuántos mensajes anteriores se mandan como memoria de la conversación (los más recientes). */
const MEMORIA = 30

const enCurso = new Map<number, AbortController>()

const db = () => getDb()

export function listarConversaciones(): Conversacion[] {
  return db()
    .prepare(
      `SELECT c.id, c.titulo, c.materia_id, m.nombre AS materia_nombre, c.actualizado FROM asistente_conversaciones c
       LEFT JOIN materias m ON m.id = c.materia_id WHERE c.programa_id IS NULL ORDER BY c.actualizado DESC, c.id DESC`
    )
    .all() as Conversacion[]
}

export function mensajesDe(conversacionId: number): MensajeChat[] {
  return db().prepare('SELECT * FROM asistente_mensajes WHERE conversacion_id = ? ORDER BY id').all(conversacionId) as MensajeChat[]
}

/** La conversación del panel del asistente de un programa (se crea la primera vez). */
export function conversacionDePrograma(programaId: number): number {
  const hay = db().prepare('SELECT id FROM asistente_conversaciones WHERE programa_id = ? ORDER BY id LIMIT 1').get(programaId) as { id: number } | undefined
  if (hay) return hay.id
  const p = db().prepare('SELECT nombre, materia_id FROM programas WHERE id = ?').get(programaId) as { nombre: string; materia_id: number | null } | undefined
  if (!p) throw new Error('Ese programa ya no existe.')
  return Number(db().prepare('INSERT INTO asistente_conversaciones (titulo, materia_id, programa_id) VALUES (?, ?, ?)').run(`Código: ${p.nombre}`, p.materia_id, programaId).lastInsertRowid)
}

export function crearConversacion(materiaId: number | null): number {
  return Number(db().prepare("INSERT INTO asistente_conversaciones (titulo, materia_id) VALUES ('Nueva conversación', ?)").run(materiaId).lastInsertRowid)
}

export function actualizarConversacion(id: number, c: { titulo?: string; materia_id?: number | null }): void {
  if (c.titulo !== undefined) db().prepare('UPDATE asistente_conversaciones SET titulo = ? WHERE id = ?').run(c.titulo.trim().slice(0, 120) || 'Sin título', id)
  if (c.materia_id !== undefined) db().prepare('UPDATE asistente_conversaciones SET materia_id = ? WHERE id = ?').run(c.materia_id, id)
}

export function borrarConversacion(id: number): void {
  enCurso.get(id)?.abort()
  db().prepare('DELETE FROM asistente_conversaciones WHERE id = ?').run(id)
}

/** Corta la respuesta que se está escribiendo; lo que ya llegó se guarda. */
export function detenerRespuesta(conversacionId: number): void {
  enCurso.get(conversacionId)?.abort()
}

/** Guarda una respuesta como apuntes de la materia (para exportarla a PDF o Word, o publicarla). */
export function guardarEnMateria(materiaId: number, titulo: string, contenido: string): number {
  return Number(
    db().prepare("INSERT INTO evaluaciones (materia_id, tipo, titulo, contenido, puntos_totales) VALUES (?, 'apuntes', ?, ?, 0)").run(materiaId, titulo.trim().slice(0, 150) || 'Apuntes del asistente', contenido).lastInsertRowid
  )
}

/**
 * Los pedazos de texto se juntan y se mandan a la ventana cada 50 ms: con cientos de avisos por
 * respuesta la ventana repintaría sin parar y se sentiría trabada.
 */
const pendientes = new Map<number, string>()
/** Lo que va escrito de cada respuesta en curso: la ventana lo recupera si se recarga o vuelve a la pantalla */
const escrito = new Map<number, string>()
export const respuestasEnCurso = (): { conversacion_id: number; texto: string }[] => [...enCurso.keys()].map((id) => ({ conversacion_id: id, texto: escrito.get(id) ?? '' }))
let reloj: ReturnType<typeof setTimeout> | null = null
const vaciar = (): void => {
  reloj = null
  for (const [conversacion_id, texto] of pendientes)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('asistente:trozo', { conversacion_id, texto })
  pendientes.clear()
}
const avisar = (conversacion_id: number, texto: string): void => {
  escrito.set(conversacion_id, (escrito.get(conversacion_id) ?? '') + texto)
  pendientes.set(conversacion_id, (pendientes.get(conversacion_id) ?? '') + texto)
  reloj ??= setTimeout(vaciar, 50)
}

/**
 * Manda la pregunta y devuelve la respuesta completa ya guardada. Mientras se escribe, cada pedazo
 * llega a la ventana. Con `web`, Claude busca en internet y la respuesta trae sus fuentes.
 */
export async function enviarMensaje(
  conversacionId: number,
  texto: string,
  opciones: {
    web?: boolean
    usarMateriales?: boolean
    /** Panel del editor: el código que está en pantalla y lo último de la consola */
    codigo?: { lenguaje: string; codigo: string; salida?: string }
    /** Reintentar: la pregunta ya está guardada (la respuesta anterior falló), no se vuelve a guardar */
    reintento?: boolean
  } = {}
): Promise<MensajeChat> {
  const d = db()
  const conv = d.prepare('SELECT * FROM asistente_conversaciones WHERE id = ?').get(conversacionId) as { id: number; titulo: string; materia_id: number | null } | undefined
  if (!conv) throw new Error('Esa conversación ya no existe.')
  const pregunta = texto.trim()
  if (!pregunta) throw new Error('Escribe tu mensaje.')
  if (enCurso.has(conversacionId)) throw new Error('Espera a que termine la respuesta anterior (o pulsa Detener).')
  if (!opciones.reintento) d.prepare("INSERT INTO asistente_mensajes (conversacion_id, rol, contenido) VALUES (?, 'usuario', ?)").run(conversacionId, pregunta)
  // La primera pregunta le pone nombre a la conversación
  if (conv.titulo === 'Nueva conversación') d.prepare('UPDATE asistente_conversaciones SET titulo = ? WHERE id = ?').run(pregunta.replace(/\s+/g, ' ').slice(0, 70), conversacionId)

  const contexto = conv.materia_id ? contextoMateria(conv.materia_id, opciones.usarMateriales !== false, pregunta).contexto : ''
  let system = contexto ? `${SYSTEM_CHAT}\n\nContexto de la materia con la que trabaja el docente:\n${contexto}` : SYSTEM_CHAT
  if (opciones.codigo) {
    const c = opciones.codigo
    system += `\n\nEstás en el editor de código de la app (como el chat de VS Code). El programa que el docente tiene abierto, en ${c.lenguaje === 'javascript' ? 'JavaScript' : 'Python 3.14 (Pyodide: corre en el navegador; input() lee de «Datos de entrada»; matplotlib muestra la figura; numpy/sympy/networkx solo si están descargados)'}:
\`\`\`${c.lenguaje}
${c.codigo.slice(0, 60_000)}
\`\`\`
${c.salida ? `Lo último que mostró la consola al ejecutarlo:\n\`\`\`\n${c.salida.slice(-6000)}\n\`\`\`` : ''}
Cuando propongas cambios, da el programa COMPLETO corregido en un solo bloque \`\`\`${c.lenguaje} (así se puede reemplazar en el editor de un clic), y explica brevemente qué cambiaste y por qué.`
  }
  const historial = (d.prepare('SELECT rol, contenido FROM asistente_mensajes WHERE conversacion_id = ? ORDER BY id DESC LIMIT ?').all(conversacionId, MEMORIA) as { rol: string; contenido: string }[]).reverse()

  const control = new AbortController()
  enCurso.set(conversacionId, control)
  escrito.set(conversacionId, '')
  let respuesta = ''
  try {
    if (process.env.DOCENTE_IA_FALSA === '1') {
      // Solo para pruebas (QA): una respuesta fija que llega en pedazos, sin gastar la API
      respuesta = ''
      const falsa = `## Respuesta de prueba\n\nRecibí: «${pregunta.slice(0, 80)}».\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\n\`\`\`python\ndef suma(n):\n    return n * (n + 1) // 2\n\nprint(suma(10))\n\`\`\`\n${opciones.codigo ? `\nVi tu código de ${opciones.codigo.codigo.split('\n').length} líneas.` : ''}`
      for (const pedazo of falsa.match(/[\s\S]{1,12}/g) ?? []) {
        if (control.signal.aborted) break
        respuesta += pedazo
        avisar(conversacionId, pedazo)
        await new Promise((r) => setTimeout(r, 15))
      }
    } else if (proveedor() === 'nvidia') {
      // NVIDIA aquí no conversa por turnos: se le manda la plática previa como texto
      const previa = historial.slice(0, -1).map((m) => `${m.rol === 'usuario' ? 'Docente' : 'Asistente'}: ${m.contenido}`).join('\n\n')
      respuesta = await completarNvidia({ apiKey: llaveNvidia(), modelo: modelo(), system, user: previa ? `Conversación hasta ahora:\n${previa}\n\nDocente: ${pregunta}` : pregunta, maxTokens: 16000 })
      avisar(conversacionId, respuesta)
    } else {
      // Claude pide turnos alternados empezando por el docente
      const mensajes: Anthropic.MessageParam[] = []
      for (const m of historial) {
        const rol = m.rol === 'usuario' ? 'user' : 'assistant'
        if (!mensajes.length && rol !== 'user') continue
        const ultimo = mensajes[mensajes.length - 1]
        if (ultimo && ultimo.role === rol) ultimo.content = `${ultimo.content as string}\n\n${m.contenido}`
        else mensajes.push({ role: rol, content: m.contenido })
      }
      const citadas = new Map<string, string>()
      // Con búsqueda web el servidor puede pausar el turno (pause_turn) a media investigación: se continúa
      for (let vuelta = 0; vuelta < 4; vuelta++) {
        const stream = cliente().messages.stream(
          {
            model: modelo(),
            max_tokens: MAX_TOKENS_CLAUDE,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: mensajes,
            // El mismo esfuerzo con cualquier modelo (Opus 5.5 ya usaba «medium» sin indicarlo)
            output_config: { effort: 'medium' },
            ...(opciones.web ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }] } : {})
          },
          { signal: control.signal }
        )
        stream.on('text', (t) => {
          respuesta += t
          avisar(conversacionId, t)
        })
        const msg = await stream.finalMessage().catch((e) => {
          // Lo que alcanzó a escribir antes de detenerse o fallar también se cobra
          registrarUso('asistente', modelo(), 'medium', stream.currentMessage)
          if (control.signal.aborted) return null
          throw explicarError(e)
        })
        if (!msg) break
        registrarUso('asistente', modelo(), 'medium', msg)
        for (const b of msg.content) if (b.type === 'text') for (const c of b.citations ?? []) if (c.type === 'web_search_result_location') citadas.set(c.url, c.title ?? c.url)
        if (msg.stop_reason === 'refusal') respuesta += '\n\n_(El modelo declinó continuar con esta solicitud.)_'
        if (msg.stop_reason === 'max_tokens') respuesta += '\n\n_(La respuesta llegó al límite de largo: pide «continúa» para seguir.)_'
        if (msg.stop_reason !== 'pause_turn') break
        mensajes.push({ role: 'assistant', content: msg.content })
      }
      if (citadas.size && !/^##\s+Fuentes/m.test(respuesta)) {
        const fuentes = `\n\n## Fuentes consultadas\n${[...citadas].map(([url, t]) => `- [${t}](${url})`).join('\n')}`
        respuesta += fuentes
        avisar(conversacionId, fuentes)
      }
    }
  } catch (e) {
    // La pregunta se queda guardada; el docente puede reintentar
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    enCurso.delete(conversacionId)
    escrito.delete(conversacionId)
  }
  if (reloj) clearTimeout(reloj)
  vaciar()
  if (control.signal.aborted) respuesta = (respuesta ? respuesta + '\n\n' : '') + '_(Respuesta detenida.)_'
  const id = Number(d.prepare("INSERT INTO asistente_mensajes (conversacion_id, rol, contenido) VALUES (?, 'asistente', ?)").run(conversacionId, respuesta).lastInsertRowid)
  d.prepare("UPDATE asistente_conversaciones SET actualizado = datetime('now') WHERE id = ?").run(conversacionId)
  return d.prepare('SELECT * FROM asistente_mensajes WHERE id = ?').get(id) as MensajeChat
}
