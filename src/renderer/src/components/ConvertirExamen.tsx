import { useState } from 'react'
import Modal from './Modal'
import { api } from '../lib/api'
import { avisar } from './Aviso'

type Modo = 'auto' | 'extraer' | 'generar'

const MODOS: { v: Modo; t: string; d: string }[] = [
  { v: 'auto', t: 'Que la IA decida', d: 'Si el archivo ya trae preguntas, toma de ellas las que pidas; si es material de estudio, las genera.' },
  { v: 'extraer', t: 'Pasar sus preguntas', d: 'El archivo es un examen, guía o cuestionario: pasa todas o las que pidas de cada tipo, sin inventar ni cambiar nada.' },
  { v: 'generar', t: 'Generar de su contenido', d: 'El archivo es material de estudio: se crean preguntas solo con lo que dice.' }
]

/**
 * Con `juego`, lo mismo pero para un juego en vivo: solo preguntas jugables (opción múltiple y verdadero/falso),
 * sin abiertas, y al terminar se abre la evaluación con «Jugar en vivo» a la mano.
 *
 * Convertir un material en examen con IA (Materias › Materiales). Al terminar abre el examen para revisarlo
 * y publicarlo en el portal (a toda la materia, a una carrera o a alumnos elegidos).
 */
export default function ConvertirExamen({ material, onCerrar, onListo, juego = false }: { material: { id: number; titulo: string }; onCerrar: () => void; onListo: (evaluacionId: number) => void; juego?: boolean }): JSX.Element {
  const [modo, setModo] = useState<Modo>('auto')
  // Como texto: así se puede borrar y escribir otro número sin que quede un 0 pegado («01»)
  const [om, setOm] = useState(juego ? '20' : '10')
  const [vf, setVf] = useState(juego ? '0' : '5')
  const [ab, setAb] = useState(juego ? '0' : '3')
  // Al pasar las preguntas de un examen: todas, o solo las que se pidan de cada tipo (en un juego no van abiertas: siempre por cantidades)
  const [todas, setTodas] = useState(!juego)
  // De las que trae el archivo: repartidas a lo largo de él o al azar (otra combinación cada vez)
  const [eleccion, setEleccion] = useState<'repartidas' | 'azar'>('repartidas')
  const [instrucciones, setInstrucciones] = useState('')
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState('')

  const convertir = async (): Promise<void> => {
    setError('')
    const n = (t: string): number => Math.max(0, Math.min(60, Math.round(Number(t) || 0)))
    const conCantidades = modo !== 'extraer' || !todas
    const abiertas = juego ? 0 : n(ab)
    if (conCantidades && n(om) + n(vf) + abiertas === 0) return setError(juego ? 'Pide al menos una pregunta de opción múltiple o de verdadero/falso.' : 'Pide al menos una pregunta de algún tipo.')
    setTrabajando(true)
    try {
      const ev = await api.materiales.aExamen(material.id, { modo, opcion_multiple: n(om), verdadero_falso: n(vf), abierta: abiertas, todas: !juego && modo === 'extraer' && todas, eleccion, instrucciones })
      avisar(juego ? `Juego listo: «${ev.titulo}». Revisa las preguntas y pulsa «Jugar en vivo».` : `Examen listo: «${ev.titulo}». Revísalo y publícalo en el portal.`)
      onListo(ev.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTrabajando(false)
    }
  }

  const numero = (etiqueta: string, valor: string, cambiar: (t: string) => void): JSX.Element => (
    <label className="block">
      <span className="etiqueta">{etiqueta}</span>
      <input
        type="text"
        inputMode="numeric"
        className="input"
        value={valor}
        placeholder="0"
        // Solo dígitos y sin ceros a la izquierda; vacío cuenta como 0
        onChange={(e) => cambiar(e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 2))}
        disabled={trabajando}
      />
    </label>
  )

  return (
    <Modal titulo={`${juego ? 'Juego en vivo' : 'Convertir en examen'}: ${material.titulo}`} abierto onCerrar={() => !trabajando && onCerrar()} ancho="max-w-2xl">
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Qué hacer con el archivo">
          {MODOS.map((m) => (
            <button
              key={m.v}
              type="button"
              role="radio"
              aria-checked={modo === m.v}
              disabled={trabajando}
              onClick={() => setModo(m.v)}
              className={`rounded-xl border p-3 text-left transition-colors ${modo === m.v ? 'border-brand-500 bg-brand-500/5 ring-1 ring-brand-500' : 'border-ink-200 hover:bg-ink-50'}`}
            >
              <div className="text-sm font-semibold text-ink-900">{m.t}</div>
              <div className="mt-1 text-xs text-ink-500">{m.d}</div>
            </button>
          ))}
        </div>

        {juego ? (
          <p className="text-sm text-ink-600">
            🎮 Para el juego solo se usan preguntas de <b>opción múltiple</b> y de <b>verdadero/falso</b>. Si el archivo ya las trae, se pasan tal cual con su respuesta; si es material de estudio, se generan de su contenido.
          </p>
        ) : null}
        {modo === 'extraer' && !juego ? (
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input type="checkbox" className="mt-0.5" checked={todas} onChange={(e) => setTodas(e.target.checked)} disabled={trabajando} />
            <span>
              <b>Todas las preguntas del archivo</b>
              <span className="block text-xs text-ink-500">Desmárcalo para elegir cuántas de cada tipo: se toman repartidas a lo largo del archivo para cubrir todos los temas.</span>
            </span>
          </label>
        ) : null}
        {modo !== 'extraer' || !todas ? (
          <div>
            <div className="mb-1 text-sm font-medium text-ink-700">Cuántas de cada tipo</div>
            <div className={`grid gap-3 ${juego ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
              {numero('Opción múltiple', om, setOm)}
              {numero('Verdadero / falso', vf, setVf)}
              {juego ? null : numero('Abiertas', ab, setAb)}
            </div>
            {modo === 'generar' ? (
              <p className="mt-1 text-xs text-ink-500">Se generan exactamente esas.</p>
            ) : (
              <div className="mt-2 space-y-1">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-700" role="radiogroup" aria-label="Cómo elegirlas">
                  <span className="text-xs text-ink-500">Si el archivo ya trae preguntas, tomarlas:</span>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="eleccion" checked={eleccion === 'repartidas'} onChange={() => setEleccion('repartidas')} disabled={trabajando} /> Repartidas en todo el archivo
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" name="eleccion" checked={eleccion === 'azar'} onChange={() => setEleccion('azar')} disabled={trabajando} /> Al azar
                  </label>
                </div>
                <p className="text-xs text-ink-500">Al azar sale otra combinación cada vez que conviertas (sirve para hacer varias versiones). Si trae menos de algún tipo, se quedan las que haya.</p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-600">Se pasarán todas las preguntas del archivo con su tipo (opción múltiple, verdadero/falso o abierta) y su respuesta si la trae; si no, la IA la resuelve y la marca para que la revises.</p>
        )}

        <label className="block">
          <span className="etiqueta">Indicaciones para la IA (opcional)</span>
          <textarea className="input min-h-[4rem]" value={instrucciones} onChange={(e) => setInstrucciones(e.target.value)} placeholder="Ej.: solo de la unidad 2; nivel intermedio; sin cálculos largos" disabled={trabajando} />
        </label>

        {juego ? null : <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          🎲 ¿Un examen distinto para cada alumno? Conviértelo con todas sus preguntas (o genera un banco grande) y, al publicarlo, activa <b>«Preguntas al azar por alumno»</b>: a cada quien le toca su propio sorteo.
        </p>}

        {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</div> : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {trabajando ? <span className="mr-auto text-xs text-ink-500" role="status">Leyendo el archivo y armando {juego ? 'el juego' : 'el examen'}… puede tardar uno o dos minutos.</span> : <span className="mr-auto text-xs text-ink-500">Usa la IA una vez. Después lo revisas y editas antes de publicarlo.</span>}
          <button className="btn-secundario" onClick={onCerrar} disabled={trabajando}>Cancelar</button>
          <button className="btn-primario" onClick={() => void convertir()} disabled={trabajando}>{trabajando ? (juego ? 'Creando juego…' : 'Convirtiendo…') : juego ? '🎮 Crear juego' : 'Convertir en examen'}</button>
        </div>
      </div>
    </Modal>
  )
}
