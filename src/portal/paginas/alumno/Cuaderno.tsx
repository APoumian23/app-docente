import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ErrorApi, fechaMx } from '../../lib/api'
import { Boton, Cargando, Chip, ErrorCarga, Modal, Tarjeta, avisar } from '../../componentes/ui'
import EditorCuaderno, { celdasSinCorrer, type Nb } from '../../componentes/EditorCuaderno'
import type { CuadernoAlumno, TareaParaCuaderno } from '@shared/portal'

/**
 * Cuaderno de Jupyter en el portal: el alumno contesta en las celdas de texto, corre y escribe código
 * (las variables se quedan entre celdas, como en Jupyter), agrega celdas propias y todo se guarda solo.
 * Al entregarlo, el .ipynb con sus respuestas y salidas le llega al docente como archivo de la tarea.
 */

type EstadoGuardado = 'guardado' | 'pendiente' | 'guardando' | 'error'

export default function Cuaderno(): JSX.Element {
  const { id } = useParams()
  const materialId = Number(id)
  const [cuaderno, setCuaderno] = useState<CuadernoAlumno | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [guardado, setGuardado] = useState<EstadoGuardado>('guardado')
  const [entregar, setEntregar] = useState(false)
  const [sinCorrer, setSinCorrer] = useState(0)
  // Lo último que mostró el editor y lo último que llegó al servidor
  const actual = useRef<Nb | null>(null)
  const ultimoGuardado = useRef('')
  const cerrado = cuaderno?.estado === 'entregado'

  const cargar = useCallback(() => {
    setError(null)
    api<CuadernoAlumno>(`/alumno/cuadernos/${materialId}`)
      .then((c) => {
        const nb = c.contenido as Nb
        actual.current = nb
        ultimoGuardado.current = JSON.stringify(nb)
        setSinCorrer(celdasSinCorrer(nb))
        setCuaderno(c)
        setGuardado('guardado')
      })
      .catch((e: Error) => setError(e.message))
  }, [materialId])
  useEffect(cargar, [cargar])

  // ---------- Guardado automático ----------
  const cerradoRef = useRef(cerrado)
  cerradoRef.current = cerrado
  const guardar = useCallback(async (): Promise<boolean> => {
    const contenido = actual.current
    if (!contenido || cerradoRef.current) return true
    const texto = JSON.stringify(contenido)
    if (texto === ultimoGuardado.current) {
      setGuardado('guardado')
      return true
    }
    setGuardado('guardando')
    try {
      await api(`/alumno/cuadernos/${materialId}`, { metodo: 'PUT', cuerpo: { contenido } })
      ultimoGuardado.current = texto
      setGuardado('guardado')
      return true
    } catch (e) {
      setGuardado('error')
      if (e instanceof ErrorApi && e.estado === 409) cargar()
      return false
    }
  }, [materialId, cargar])
  const temporizador = useRef<number | undefined>(undefined)
  const saliendo = useRef(false)
  const alCambiar = (nb: Nb): void => {
    actual.current = nb
    setSinCorrer(celdasSinCorrer(nb))
    window.clearTimeout(temporizador.current)
    // Al ocultarse la pestaña o salir de la pantalla se manda ya; si no, al dejar de escribir
    if (saliendo.current || document.visibilityState === 'hidden') return void guardar()
    setGuardado('pendiente')
    temporizador.current = window.setTimeout(() => void guardar(), 1500)
  }
  useEffect(
    () => () => {
      saliendo.current = true
      window.clearTimeout(temporizador.current)
      void guardar()
    },
    [guardar]
  )

  if (error)
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Link to="/materiales" className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600">← Materiales</Link>
        <ErrorCarga titulo="No se pudo abrir el cuaderno" detalle={error} onReintentar={cargar} />
      </div>
    )
  if (!cuaderno || !actual.current) return <Cargando texto="Abriendo el cuaderno…" />

  const pedirEntrega = (): void => {
    window.clearTimeout(temporizador.current)
    void guardar().then((ok) => ok && setEntregar(true))
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 pb-10">
      <div className="space-y-2">
        <Link to="/materiales" className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-600">← Materiales</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{cuaderno.materia_nombre} · Cuaderno</div>
            <h2 className="break-words text-xl font-bold text-ink-900">{cuaderno.titulo}</h2>
          </div>
          {cerrado ? (
            <Chip tono="verde">Entregado</Chip>
          ) : (
            <span className={`text-xs ${guardado === 'error' ? 'text-red-600' : 'text-ink-500'}`} role="status">
              {guardado === 'guardado' ? '✓ Guardado' : guardado === 'guardando' ? 'Guardando…' : guardado === 'pendiente' ? 'Cambios sin guardar…' : 'No se pudo guardar: revisa tu conexión'}
            </span>
          )}
        </div>
      </div>

      {cerrado && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <div className="font-semibold">Ya lo entregaste{cuaderno.entregado_en ? ` el ${fechaMx(cuaderno.entregado_en)}` : ''}</div>
          <div className="mt-0.5">
            {cuaderno.tarea_titulo ? <>Le llegó a tu docente en «{cuaderno.tarea_titulo}». </> : null}
            Ya no se puede cambiar; puedes descargarlo para verlo.
          </div>
        </div>
      )}

      {/* Al entregar se vuelve a montar en solo lectura con lo entregado */}
      <EditorCuaderno
        key={cuaderno.estado}
        inicial={actual.current}
        cerrado={cerrado}
        nombreArchivo={cuaderno.titulo}
        onCambio={alCambiar}
        acciones={<Boton className="min-h-[44px]" onClick={pedirEntrega}>Entregar</Boton>}
      />

      {!cerrado && (
        <Tarjeta className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink-600">
            ¿Terminaste? Al entregarlo le llega a tu docente con tus respuestas y lo que salió al correr el código.
            {sinCorrer > 0 && <span className="block text-amber-700">Te faltan {sinCorrer} celda{sinCorrer === 1 ? '' : 's'} de código por correr.</span>}
          </div>
          <Boton className="min-h-[44px]" onClick={pedirEntrega}>Entregar cuaderno</Boton>
        </Tarjeta>
      )}

      <ModalEntregar
        abierto={entregar}
        materialId={materialId}
        sinCorrer={sinCorrer}
        onCerrar={() => setEntregar(false)}
        contenido={() => actual.current}
        onEntregado={(c) => {
          setEntregar(false)
          actual.current = c.contenido as Nb
          setCuaderno(c)
          avisar('Cuaderno entregado: ya le llegó a tu docente.')
        }}
      />
    </div>
  )
}

function ModalEntregar({
  abierto,
  materialId,
  sinCorrer,
  contenido,
  onCerrar,
  onEntregado
}: {
  abierto: boolean
  materialId: number
  sinCorrer: number
  contenido: () => Nb | null
  onCerrar: () => void
  onEntregado: (c: CuadernoAlumno) => void
}): JSX.Element {
  const [tareas, setTareas] = useState<TareaParaCuaderno[] | null>(null)
  const [elegida, setElegida] = useState('')
  const [enviando, setEnviando] = useState(false)
  useEffect(() => {
    if (!abierto) return
    setTareas(null)
    api<TareaParaCuaderno[]>(`/alumno/cuadernos/${materialId}/tareas`)
      .then((t) => {
        setTareas(t)
        // Si solo hay una, ya va elegida
        setElegida(t.length === 1 ? `${t[0].curso_id}|${t[0].tarea_id}` : '')
      })
      .catch((e: Error) => {
        setTareas([])
        avisar(e.message, 'error')
      })
  }, [abierto, materialId])
  const entregar = async (): Promise<void> => {
    const [curso_id, tarea_id] = elegida.split('|')
    setEnviando(true)
    try {
      onEntregado(await api<CuadernoAlumno>(`/alumno/cuadernos/${materialId}/entregar`, { metodo: 'POST', cuerpo: { curso_id, tarea_id, contenido: contenido() } }))
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setEnviando(false)
    }
  }
  return (
    <Modal abierto={abierto} titulo="Entregar cuaderno" onCerrar={onCerrar}>
      <div className="space-y-3 text-sm">
        <p className="text-ink-700">Le llega a tu docente como archivo .ipynb con tus respuestas y lo que salió al correr el código. <b>Después ya no podrás cambiarlo.</b></p>
        {sinCorrer > 0 && <p className="rounded-xl bg-amber-50 p-3 text-amber-900">Te faltan {sinCorrer} celda{sinCorrer === 1 ? '' : 's'} de código por correr: su resultado no se verá en tu entrega.</p>}
        {tareas === null ? (
          <Cargando texto="Buscando tus tareas…" />
        ) : tareas.length === 0 ? (
          <p className="rounded-xl bg-ink-100 p-3 text-ink-700">No hay tareas abiertas de esta materia donde entregarlo. Pídele a tu docente que la cree; tu cuaderno se queda guardado mientras.</p>
        ) : (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 font-semibold text-ink-800">¿En qué tarea lo entregas?</legend>
            {tareas.map((t) => {
              const valor = `${t.curso_id}|${t.tarea_id}`
              return (
                <label key={valor} className={`flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${elegida === valor ? 'border-brand-400 bg-brand-500/5' : 'border-ink-200'}`}>
                  <input type="radio" name="tarea" className="h-5 w-5 accent-brand-500" checked={elegida === valor} onChange={() => setElegida(valor)} />
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-ink-900">{t.titulo}</span>
                    <span className="block text-xs text-ink-500">{t.vence ? `Vence ${fechaMx(t.vence)}` : 'Sin fecha'}{t.estado === 'subida' ? ' · ya subiste algo: se agrega este archivo' : ''}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Boton variante="fantasma" className="min-h-[44px]" onClick={onCerrar}>Cancelar</Boton>
          <Boton className="min-h-[44px]" disabled={!elegida || enviando} onClick={() => void entregar()}>{enviando ? 'Entregando…' : 'Entregar'}</Boton>
        </div>
      </div>
    </Modal>
  )
}
