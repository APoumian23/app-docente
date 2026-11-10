/**
 * Quitar los nombres de los alumnos antes de mandar texto a la IA (la revisión de entregas).
 * Sin Electron: se prueba sobre textos sueltos.
 */
/** Letras con y sin acento valen igual al buscar un nombre («Ramirez» encuentra «Ramírez»). */
const VARIANTES: Record<string, string> = { a: '[aáàä]', e: '[eéèë]', i: '[iíìï]', o: '[oóòö]', u: '[uúùü]', n: '[nñ]' }
const sinAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const patronDe = (palabra: string): string => [...sinAcento(palabra)].map((c) => VARIANTES[c] ?? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')

/**
 * Quita los nombres del grupo antes de mandar nada: cada alumno con entrega pasa a «Alumno N»; una palabra
 * de su nombre que comparte con otro del grupo, o el nombre de alguien sin entrega, queda como «[alguien del grupo]».
 */
export function anonimizador(grupo: string[], conEntrega: string[]): { tapar: (t: string) => string; etiqueta: Map<string, string> } {
  const etiqueta = new Map(conEntrega.map((n, i) => [n, `Alumno ${i + 1}`]))
  const veces = new Map<string, number>()
  const palabrasDe = (n: string): string[] => [...new Set(n.split(/[^\p{L}]+/u).filter((p) => p.length >= 4).map(sinAcento))]
  for (const n of grupo) for (const p of palabrasDe(n)) veces.set(p, (veces.get(p) ?? 0) + 1)
  const reglas: [RegExp, string][] = []
  // Primero el nombre completo y luego cada palabra, de la más larga a la más corta
  for (const n of grupo) reglas.push([new RegExp(n.split(/\s+/).map(patronDe).join('[\\s_.-]*'), 'giu'), etiqueta.get(n) ?? '[alguien del grupo]'])
  const sueltas = [...veces.keys()].sort((a, b) => b.length - a.length)
  for (const p of sueltas) {
    const dueno = grupo.find((n) => palabrasDe(n).includes(p))
    const quien = veces.get(p) === 1 && dueno ? (etiqueta.get(dueno) ?? '[alguien del grupo]') : '[alguien del grupo]'
    reglas.push([new RegExp(`(?<!\\p{L})${patronDe(p)}(?!\\p{L})`, 'giu'), quien])
  }
  // «FloresCorona» en un nombre de archivo: se separan las palabras pegadas para encontrar cada apellido
  const tapar = (t: string): string =>
    reglas
      .reduce((x, [r, por]) => x.replace(r, por), (t ?? '').replace(/(\p{Ll})(\p{Lu})/gu, '$1\u200b$2'))
      .replace(/\u200b/g, '')
  return { tapar, etiqueta }
}
