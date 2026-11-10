import { app } from 'electron'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { markdownADocxSimple } from '../src/main/services/export'
app.setName('app-docente')
const destino = process.argv[process.argv.length - 1]
app.whenReady().then(async () => {
  const ruta = join(destino, 'prueba.docx')
  console.log('generando…')
  await markdownADocxSimple('Parcial 1', '# Parcial 1\n\n## Instrucciones\n\n- Resuelve a mano\n- Sin calculadora\n\nTexto normal con **negritas**.', ruta)
  console.log(existsSync(ruta) ? `OK ${statSync(ruta).size} bytes` : 'NO se generó')
  app.quit()
}).catch((e) => { console.error('FALLO:', e instanceof Error ? e.stack?.split('\n').slice(0,4).join(' | ') : e); app.quit() })
