import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * La app de escritorio para el navegador (portal.ejemplo.com/app): las mismas pantallas de src/renderer con
 * window.api contra el servidor (src/renderer/src/web/puente.ts). Se sirve desde el servidor en dist/app.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: '/app/',
  plugins: [react()],
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared'), '@codigo': resolve(__dirname, 'src/codigo') }
  },
  build: {
    outDir: resolve(__dirname, 'dist/app'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: { input: resolve(__dirname, 'src/renderer/web.html') }
  },
  server: {
    port: 5181,
    proxy: { '/api': 'http://localhost:8797', '/pyodide': 'http://localhost:8797', '/entrar': 'http://localhost:8797' }
  }
})
