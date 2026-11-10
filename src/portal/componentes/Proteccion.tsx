import { useEffect } from 'react'
import { useSesion } from '../lib/sesion'
import { avisar } from './ui'

/**
 * Protección del contenido para alumnos: no se selecciona, copia, corta, arrastra, imprime ni se abre el menú
 * contextual, salvo dentro de lo que el alumno escribe (respuestas y editor de código).
 * Ninguna página web puede impedir una captura del sistema (o una foto con el celular): por eso en los
 * exámenes va además la marca de agua con el nombre del alumno, y la tecla Impr Pant se anota.
 */

/** Intento de examen en curso: la pantalla del examen lo pone para anotar los intentos de captura. */
export const vigilancia: { intentoId: number | null } = { intentoId: null }

const editable = (t: EventTarget | null): boolean => t instanceof Element && Boolean(t.closest('input, textarea, [contenteditable="true"], .cm-editor'))

function anotarCaptura(): void {
  const id = vigilancia.intentoId
  const token = useSesion.getState().token
  if (!id || !token) return
  void fetch(`/api/alumno/intentos/${id}/eventos`, {
    method: 'POST',
    keepalive: true,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo: 'captura_pantalla', detalle: 'tecla Impr Pant' })
  }).catch(() => undefined)
}

export function useProteccionAlumno(activa: boolean): void {
  useEffect(() => {
    if (!activa) return
    document.documentElement.classList.add('alumno-protegido')
    let ultimoAviso = 0
    const avisarUnaVez = (texto: string): void => {
      if (Date.now() - ultimoAviso < 3000) return
      ultimoAviso = Date.now()
      avisar(texto, 'info')
    }
    const copiar = (e: ClipboardEvent): void => {
      if (editable(e.target)) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', '')
      avisarUnaVez('En el portal no se puede copiar el contenido.')
    }
    const menu = (e: MouseEvent): void => {
      if (!editable(e.target)) e.preventDefault()
    }
    const arrastrar = (e: DragEvent): void => {
      if (!editable(e.target)) e.preventDefault()
    }
    const teclas = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      // Imprimir o guardar la página
      if (mod && (k === 'p' || k === 's')) {
        e.preventDefault()
        avisarUnaVez('En el portal no se puede imprimir ni guardar la página.')
      }
    }
    const captura = (e: KeyboardEvent): void => {
      if (e.key !== 'PrintScreen') return
      // Windows copia la pantalla al portapapeles: se borra (si el navegador lo permite) y se anota
      void navigator.clipboard?.writeText('').catch(() => undefined)
      anotarCaptura()
      avisarUnaVez('No se permiten capturas de pantalla. Quedó registrado.')
    }
    document.addEventListener('copy', copiar)
    document.addEventListener('cut', copiar)
    document.addEventListener('contextmenu', menu)
    document.addEventListener('dragstart', arrastrar)
    document.addEventListener('keydown', teclas)
    document.addEventListener('keyup', captura)
    return () => {
      document.documentElement.classList.remove('alumno-protegido')
      document.removeEventListener('copy', copiar)
      document.removeEventListener('cut', copiar)
      document.removeEventListener('contextmenu', menu)
      document.removeEventListener('dragstart', arrastrar)
      document.removeEventListener('keydown', teclas)
      document.removeEventListener('keyup', captura)
    }
  }, [activa])
}

/** Marca de agua del examen: nombre y matrícula del alumno sobre todo el contenido (una captura o foto dice de quién salió). */
export function MarcaDeAgua(): JSX.Element | null {
  const usuario = useSesion((s) => s.usuario)
  if (!usuario) return null
  const texto = `${usuario.nombre} · ${usuario.usuario} · ${new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date())}`
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-40 overflow-hidden select-none">
      <div className="absolute -inset-1/2 flex rotate-[-24deg] flex-wrap content-start gap-x-16 gap-y-20 opacity-[0.07]">
        {Array.from({ length: 80 }, (_, i) => (
          <span key={i} className="whitespace-nowrap text-sm font-bold text-ink-900">
            {texto}
          </span>
        ))}
      </div>
    </div>
  )
}
