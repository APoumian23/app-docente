/** Entrada de la versión web: primero el puente (window.api contra el servidor), después la app de siempre. */
import { prepararPuente } from './puente'

await prepararPuente()
await import('../main')
