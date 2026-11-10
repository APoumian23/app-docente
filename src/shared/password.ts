/**
 * Contraseña segura para el portal (alumnos y docente): mínimo 8 caracteres con mayúscula, minúscula, número
 * y un carácter especial. La misma regla la revisa el servidor y la muestra la pantalla mientras se escribe.
 */

export interface RequisitoPassword {
  texto: string
  cumple: (p: string) => boolean
}

export const REQUISITOS_PASSWORD: RequisitoPassword[] = [
  { texto: 'Al menos 8 caracteres', cumple: (p) => [...p].length >= 8 },
  { texto: 'Una letra mayúscula', cumple: (p) => /\p{Lu}/u.test(p) },
  { texto: 'Una letra minúscula', cumple: (p) => /\p{Ll}/u.test(p) },
  { texto: 'Un número', cumple: (p) => /\p{Nd}/u.test(p) },
  { texto: 'Un carácter especial (por ejemplo ! @ # $ % & * ? -)', cumple: (p) => /[^\p{L}\p{N}\s]/u.test(p) }
]

/** null si cumple todo; si no, qué le falta, en una frase */
export function problemaPassword(p: string): string | null {
  const faltan = REQUISITOS_PASSWORD.filter((r) => !r.cumple(p)).map((r) => r.texto.toLowerCase())
  return faltan.length ? `La contraseña necesita: ${faltan.join(', ')}.` : null
}
