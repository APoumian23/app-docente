import type { Lenguaje } from './lenguajes'

/**
 * «Abrir archivo» en Programar (app y portal): convierte un archivo de la computadora o del celular
 * en un programa nuevo. Se lee en el navegador; al servidor solo llega el texto, como al escribirlo.
 */

/** Lo que acepta el selector de archivos */
export const EXTENSIONES_CODIGO = '.py,.pyw,.js,.mjs,.ipynb,.txt,.md,.csv,.json'

/** Mismo tope que el servidor del portal para un programa */
const MAX_CARACTERES = 100_000

export interface ArchivoDeCodigo {
  nombre: string
  lenguaje: Lenguaje
  codigo: string
}

/** Celdas de un cuaderno de Jupyter en un solo programa: el código tal cual y el texto como comentarios */
function cuadernoAPython(texto: string): string {
  const nb = JSON.parse(texto) as { cells?: { cell_type: string; source: string | string[] }[] }
  if (!Array.isArray(nb.cells)) throw new Error('No parece un cuaderno de Jupyter.')
  const fuente = (s: string | string[]): string => (Array.isArray(s) ? s.join('') : String(s ?? '')).trimEnd()
  return (
    nb.cells
      .map((c) => {
        const t = fuente(c.source)
        if (!t) return ''
        if (c.cell_type === 'code') return t
        return t
          .split('\n')
          .map((l) => (l ? `# ${l}` : '#'))
          .join('\n')
      })
      .filter(Boolean)
      .join('\n\n') + '\n'
  )
}

export async function leerArchivoDeCodigo(f: File): Promise<ArchivoDeCodigo> {
  const ext = (f.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase()
  if (f.size > MAX_CARACTERES * 4) throw new Error(`«${f.name}» es demasiado grande para abrirlo aquí.`)
  let codigo = (await f.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let nombre = f.name
  if (ext === '.ipynb') {
    try {
      codigo = cuadernoAPython(codigo)
    } catch {
      throw new Error(`«${f.name}» no se pudo leer como cuaderno de Jupyter.`)
    }
    nombre = f.name.replace(/\.ipynb$/i, '.py')
  }
  if (codigo.includes('\u0000')) throw new Error(`«${f.name}» no es un archivo de texto.`)
  if (codigo.length > MAX_CARACTERES) throw new Error(`«${f.name}» tiene más de 100 000 caracteres.`)
  return { nombre: nombre.slice(0, 80), lenguaje: ext === '.js' || ext === '.mjs' ? 'javascript' : 'python', codigo }
}

/** Abre el selector de archivos del sistema (varios a la vez) y devuelve los elegidos */
export function elegirArchivos(): Promise<File[]> {
  return new Promise((resolver) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    // En celular no se filtra: iPhone deja grises los tipos que no conoce (como .ipynb). El contenido se revisa al leerlo
    if (!window.matchMedia('(pointer: coarse)').matches) input.accept = EXTENSIONES_CODIGO
    input.onchange = () => resolver([...(input.files ?? [])])
    // Si se cierra sin elegir, no hay evento en todos los navegadores: el botón simplemente no hace nada
    input.addEventListener('cancel', () => resolver([]))
    input.click()
  })
}
