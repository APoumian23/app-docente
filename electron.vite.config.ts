import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import type { Plugin } from 'vite'

/**
 * Marca de compilación: el botón Actualizar compara la de la app instalada con la de
 * release/. electron-builder la copia fuera del asar (extraResources) para poder leerla
 * en otra app sin abrir su asar, que Electron deja en caché aunque el archivo cambie.
 */
function marcaDeCompilacion(): Plugin {
  return {
    name: 'marca-de-compilacion',
    generateBundle() {
      const base = String(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version)
      // Cada compilación lleva su propio número (cuántos cambios hay guardados en git) y la lista de
      // los últimos cambios, para que el docente vea qué trae cada versión
      const git = (cmd: string): string => {
        try {
          return execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        } catch {
          return ''
        }
      }
      const numero = git('rev-list --count HEAD')
      const version = numero ? `${base.split('.').slice(0, 2).join('.')}.${numero}` : base
      const cambios = git('log -40 --format=%h%x1f%cI%x1f%s')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [hash, fecha, texto] = l.split('\x1f')
          return { hash, fecha, texto }
        })
      this.emitFile({ type: 'asset', fileName: 'compilacion.json', source: JSON.stringify({ version, fecha: new Date().toISOString(), cambios }) })
    }
  }
}

export default defineConfig({
  main: {
    // Solo better-sqlite3 queda fuera del bundle porque es nativa. El resto se empaqueta:
    // electron-builder no resuelve bien el árbol de enlaces de pnpm y se pierden dependencias transitivas.
    plugins: [marcaDeCompilacion()],
    // portal-proceso: el servidor del portal corre en su propio utilityProcess (ver services/portal.ts)
    build: {
      outDir: 'dist/main',
      externalizeDeps: { exclude: ['exceljs', 'docx', 'mammoth', 'jszip', '@anthropic-ai/sdk', 'zod', 'date-fns'] },
      rollupOptions: { input: { index: resolve('src/main/index.ts'), 'portal-proceso': resolve('src/main/portal-proceso.ts') } }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    build: { outDir: 'dist/preload', rollupOptions: { output: { entryFileNames: '[name].js' } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    root: 'src/renderer',
    // Puerto propio en desarrollo: el 5173 lo usan otros proyectos (si otro lo toma en ::1, la ventana
    // de desarrollo cargaría esa otra app). strictPort: si está ocupado, falla en vez de cambiar de puerto
    server: { host: '127.0.0.1', port: 5197, strictPort: true },
    build: { outDir: 'dist/renderer' },
    plugins: [react()],
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared'), '@codigo': resolve('src/codigo') }
    }
  }
})
