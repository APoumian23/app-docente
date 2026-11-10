/**
 * Lenguajes que el editor sabe correr. Cada uno corre en un Web Worker aparte (sin acceso a la
 * página ni a la app) para que un ciclo infinito no congele la ventana: «Detener» mata el worker.
 * Para agregar un lenguaje: su entrada aquí, su worker y su caso en ejecutor.ts.
 */
export type Lenguaje = 'python' | 'javascript'

export const LENGUAJES: Record<Lenguaje, { nombre: string; extension: string; ejemplo: string }> = {
  python: {
    nombre: 'Python 3.14',
    extension: '.py',
    ejemplo: `# Lee un número y dice si es primo
n = int(input("Número: "))
es_primo = n > 1 and all(n % d for d in range(2, int(n ** 0.5) + 1))
print(n, "es primo" if es_primo else "no es primo")
`
  },
  javascript: {
    nombre: 'JavaScript',
    extension: '.js',
    ejemplo: `// Ordena una lista con burbuja y cuenta las comparaciones
const a = [5, 2, 9, 1, 7]
let comparaciones = 0
for (let i = 0; i < a.length; i++)
  for (let j = 0; j < a.length - 1 - i; j++) {
    comparaciones++
    if (a[j] > a[j + 1]) [a[j], a[j + 1]] = [a[j + 1], a[j]]
  }
console.log(a, 'comparaciones:', comparaciones)
`
  }
}

export const esLenguaje = (x: unknown): x is Lenguaje => x === 'python' || x === 'javascript'

/** Lenguaje de una pregunta de código: el que diga la pregunta o, si no, el que se adivine por su texto. */
export function lenguajeDeTexto(...textos: (string | undefined | null)[]): Lenguaje {
  const t = textos.filter(Boolean).join('\n')
  return /javascript|\bconsole\.log\b|\bfunction\s+\w+\s*\(|\b(const|let)\s+\w+\s*=|=>/i.test(t) ? 'javascript' : 'python'
}
