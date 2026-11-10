/** Muestra cómo se interpretaría una lista de alumnos (xlsx/csv) sin tocar la base: pnpm exec tsx scripts/prueba-importar.ts <archivo> */
import { leerFilas, interpretarLista } from '../src/main/services/importar'
async function principal(): Promise<void> {
  for (const ruta of process.argv.slice(2)) {
    const filas = await leerFilas(ruta)
    const alumnos = interpretarLista(filas)
    console.log(`\n${ruta}: ${filas.length} filas → ${alumnos.length} alumnos`)
    alumnos.forEach((a) => console.log(`  ${a.matricula.padEnd(10)} | ${a.apellidos} | ${a.nombre} | ${a.email}`))
  }
}
principal()
