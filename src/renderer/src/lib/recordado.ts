/**
 * Estado que se recuerda mientras la app está abierta (sessionStorage): un filtro elegido sigue igual
 * al entrar a un alumno y regresar, o al ir a otra pantalla y volver.
 */
import { useEffect, useState } from 'react'

export function useRecordado<T>(clave: string, inicial: T): [T, (v: T) => void] {
  const [valor, setValor] = useState<T>(() => {
    try {
      const t = sessionStorage.getItem(`docente.${clave}`)
      return t === null ? inicial : (JSON.parse(t) as T)
    } catch {
      return inicial
    }
  })
  useEffect(() => {
    try {
      sessionStorage.setItem(`docente.${clave}`, JSON.stringify(valor))
    } catch {
      /* sin almacenamiento: dura mientras la pantalla esté abierta */
    }
  }, [clave, valor])
  return [valor, setValor]
}
