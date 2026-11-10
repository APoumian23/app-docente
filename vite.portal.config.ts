import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/** Portal web para alumnos y docentes. Se sirve desde el servidor en dist/portal. */
export default defineConfig({
  root: resolve(__dirname, 'src/portal'),
  base: '/',
  plugins: [react()],
  resolve: { alias: { '@portal': resolve(__dirname, 'src/portal'), '@shared': resolve(__dirname, 'src/shared'), '@codigo': resolve(__dirname, 'src/codigo') } },
  build: { outDir: resolve(__dirname, 'dist/portal'), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:8787', '/socket.io': { target: 'http://localhost:8787', ws: true } }
  }
})
