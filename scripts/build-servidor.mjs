/**
 * Empaqueta el servidor del portal en un solo archivo Node (dist/servidor/index.mjs).
 * Solo better-sqlite3 queda fuera por ser nativa. Uso:
 *   node scripts/build-servidor.mjs            # compila
 *   node scripts/build-servidor.mjs --watch    # recompila al guardar
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const opciones = {
  entryPoints: [join(raiz, 'src/servidor/index.ts')],
  outfile: join(raiz, 'dist/servidor/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3'],
  // La app de escritorio en la web usa el código del proceso principal (src/main): «electron» es su versión de servidor
  alias: { electron: join(raiz, 'src/servidor/escritorio/electron.ts'), '@shared': join(raiz, 'src/shared') },
  loader: { '.sql': 'text' },
  // Los módulos CommonJS empaquetados en ESM necesitan `require` a la mano
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info'
}

if (process.argv.includes('--watch')) {
  const ctx = await context(opciones)
  await ctx.watch()
  console.log('vigilando cambios del servidor…')
} else {
  await build(opciones)
}
