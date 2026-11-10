/** Fin de un periodo escolar: domingo de su última semana (fecha_inicio es el lunes de la semana 1). */
export function finDePeriodo(p: { fecha_inicio: string; semanas: number }): string {
  const d = new Date(`${p.fecha_inicio}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + Math.max(1, p.semanas) * 7 - 1)
  return d.toISOString().slice(0, 10)
}

/** Hoy (YYYY-MM-DD) en Ciudad de México */
export const hoyEnMexico = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * «Ocultar» una materia es archivarla: se ofrece hasta que su periodo terminó (antes sería fácil esconderla por
 * error a mitad del semestre). Sin periodo conocido se ofrece siempre.
 */
export function periodoTerminado(p: { fecha_inicio: string; semanas: number } | null | undefined, hoy = hoyEnMexico()): boolean {
  if (!p?.fecha_inicio) return true
  return hoy > finDePeriodo(p)
}
