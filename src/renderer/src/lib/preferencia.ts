/**
 * Preferencia que se recuerda en este equipo aunque se cierre la app (localStorage), a diferencia de
 * useRecordado, que dura mientras la app está abierta. Para cosas del acomodo: la barra lateral, el editor…
 */
import { useState } from 'react'

export function usePreferencia<T>(clave: string, inicial: T): [T, (f: T | ((v: T) => T)) => void] {
  const [valor, setValor] = useState<T>(() => {
    try {
      const t = localStorage.getItem(`docente.${clave}`)
      return t === null ? inicial : (JSON.parse(t) as T)
    } catch {
      return inicial
    }
  })
  const cambiar = (f: T | ((v: T) => T)): void =>
    setValor((v) => {
      const n = typeof f === 'function' ? (f as (v: T) => T)(v) : f
      try {
        localStorage.setItem(`docente.${clave}`, JSON.stringify(n))
      } catch {
        /* sin almacenamiento: solo dura esta vez */
      }
      return n
    })
  return [valor, cambiar]
}
