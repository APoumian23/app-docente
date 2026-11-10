import { networkInterfaces } from 'os'

/** Direcciones en las que los alumnos pueden alcanzar el servidor desde la misma red. */
export function direccionesLocales(): string[] {
  const salida: string[] = []
  for (const lista of Object.values(networkInterfaces())) {
    for (const red of lista ?? []) if (red.family === 'IPv4' && !red.internal) salida.push(red.address)
  }
  return salida
}
