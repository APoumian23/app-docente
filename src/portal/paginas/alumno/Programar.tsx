import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ErrorApi } from '../../lib/api'
import { useSesion } from '../../lib/sesion'
import { Boton, Cargando, EncabezadoPagina, Tarjeta, avisar } from '../../componentes/ui'
import { LENGUAJES, type Lenguaje } from '@codigo/lenguajes'
import { elegirArchivos, leerArchivoDeCodigo } from '@codigo/abrirArchivo'

// El editor y Python se cargan aparte: solo quien entra a Programar los descarga
const PanelCodigo = lazy(() => import('@codigo/PanelCodigo'))

interface Programa { id: number; nombre: string; lenguaje: Lenguaje; codigo: string; entrada: string; actualizado: string }

/** Copia en el celular de lo que no se ha guardado en el servidor (se borra al guardarse). */
const claveLocal = (usuario: number, id: number): string => `docente-portal.programa.${usuario}.${id}`
const leerLocal = (clave: string): Programa | null => {
  try {
    const t = localStorage.getItem(clave)
    return t ? (JSON.parse(t) as Programa) : null
  } catch {
    return null
  }
}
const escribirLocal = (clave: string, p: Programa | null): void => {
  try {
    if (p) localStorage.setItem(clave, JSON.stringify(p))
    else localStorage.removeItem(clave)
  } catch {
    /* sin almacenamiento local: solo queda el servidor */
  }
}

/**
 * Práctica libre de programación del alumno: Python o JavaScript que corre en su celular o laptop
 * (Python sale del servidor del salón, sin internet). Sus programas se guardan solos en el servidor:
 * un guardado a la vez (el último gana), reintento si falla la red, copia en el celular hasta que el
 * servidor confirma y un último envío al cerrar la pestaña.
 */
export default function Programar(): JSX.Element {
  const usuario = useSesion((s) => s.usuario?.id ?? 0)
  const [lista, setLista] = useState<Programa[] | null>(null)
  const [actual, setActual] = useState<Programa | null>(null)
  const [estado, setEstado] = useState('')
  const [bloqueo, setBloqueo] = useState('')
  const pendientes = useRef(new Map<number, Programa>())
  const enVuelo = useRef(false)
  const reintento = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pausa = useRef<ReturnType<typeof setTimeout> | null>(null)

  const vaciar = useCallback(async (): Promise<void> => {
    if (enVuelo.current) return
    const [id, p] = pendientes.current.entries().next().value ?? []
    if (!id || !p) return
    enVuelo.current = true
    pendientes.current.delete(id)
    try {
      await api(`/alumno/programas/${id}`, { metodo: 'PUT', cuerpo: p })
      // Solo se borra la copia del celular si no hay una versión más nueva esperando
      if (!pendientes.current.has(id)) escribirLocal(claveLocal(usuario, id), null)
      setLista((l) => l?.map((x) => (x.id === id ? p : x)) ?? l)
      setEstado(pendientes.current.size ? 'Guardando…' : 'Guardado')
    } catch (e) {
      if (!pendientes.current.has(id)) pendientes.current.set(id, p)
      if (e instanceof ErrorApi && e.estado === 423) setBloqueo(e.message)
      setEstado('Sin guardar · reintentando (tu copia queda en este celular)')
      if (reintento.current) clearTimeout(reintento.current)
      reintento.current = setTimeout(() => void vaciar(), 4000)
      return
    } finally {
      enVuelo.current = false
    }
    void vaciar()
  }, [usuario])

  const cargar = useCallback(
    async (elegir?: number): Promise<void> => {
      try {
        const l = await api<Programa[]>('/alumno/programas')
        // Lo que quedó sin guardar en este celular (red caída, pestaña cerrada) se recupera y se reenvía
        const recuperados = l.map((p) => {
          const local = leerLocal(claveLocal(usuario, p.id))
          if (!local) return p
          pendientes.current.set(p.id, local)
          return local
        })
        setLista(recuperados)
        setActual((a) => recuperados.find((p) => p.id === (elegir ?? a?.id)) ?? recuperados[0] ?? null)
        if (pendientes.current.size) void vaciar()
      } catch (e) {
        if (e instanceof ErrorApi && e.estado === 423) setBloqueo(e.message)
        else avisar((e as Error).message, 'error')
        setLista((l) => l ?? [])
      }
    },
    [usuario, vaciar]
  )

  useEffect(() => {
    void cargar()
    // Al cerrar o esconder la pestaña: último envío que sobrevive al cierre
    const alSalir = (): void => {
      const token = useSesion.getState().token
      if (!token) return
      for (const [id, p] of pendientes.current)
        void fetch(`/api/alumno/programas/${id}`, { method: 'PUT', keepalive: true, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).catch(() => undefined)
    }
    window.addEventListener('pagehide', alSalir)
    return () => {
      window.removeEventListener('pagehide', alSalir)
      if (reintento.current) clearTimeout(reintento.current)
      if (pausa.current) clearTimeout(pausa.current)
      void vaciar()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cambiar = (c: Partial<Programa>): void => {
    if (!actual) return
    const nuevo = { ...actual, ...c }
    setActual(nuevo)
    pendientes.current.set(nuevo.id, nuevo)
    escribirLocal(claveLocal(usuario, nuevo.id), nuevo)
    setEstado('Guardando…')
    if (pausa.current) clearTimeout(pausa.current)
    pausa.current = setTimeout(() => void vaciar(), 900)
  }
  const nuevo = async (lenguaje: Lenguaje): Promise<void> => {
    try {
      const n = (lista?.filter((p) => p.lenguaje === lenguaje).length ?? 0) + 1
      const r = await api<{ id: number }>('/alumno/programas', {
        metodo: 'POST',
        cuerpo: { nombre: `Programa ${n}${LENGUAJES[lenguaje].extension}`, lenguaje, codigo: lenguaje === 'python' ? 'print("Hola")\n' : "console.log('Hola')\n", entrada: '' }
      })
      await cargar(r.id)
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  // Abrir archivo: cada archivo elegido (.py, .js, .ipynb, .txt…) queda como un programa nuevo
  const abrirArchivos = async (): Promise<void> => {
    const archivos = await elegirArchivos()
    if (!archivos.length) return
    let ultimo: number | null = null
    const abiertos: string[] = []
    for (const f of archivos) {
      try {
        const a = await leerArchivoDeCodigo(f)
        const r = await api<{ id: number }>('/alumno/programas', { metodo: 'POST', cuerpo: { ...a, entrada: '' } })
        ultimo = r.id
        abiertos.push(a.nombre)
      } catch (e) {
        avisar((e as Error).message, 'error')
      }
    }
    if (ultimo === null) return
    await cargar(ultimo)
    avisar(abiertos.length === 1 ? `Abierto: ${abiertos[0]}` : `${abiertos.length} archivos abiertos`)
  }
  const eliminar = async (): Promise<void> => {
    if (!actual || !confirm(`¿Borrar «${actual.nombre}»?`)) return
    try {
      await api(`/alumno/programas/${actual.id}`, { metodo: 'DELETE' })
      pendientes.current.delete(actual.id)
      escribirLocal(claveLocal(usuario, actual.id), null)
      setActual(null)
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const descargar = (): void => {
    if (!actual) return
    const url = URL.createObjectURL(new Blob([actual.codigo], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = /\.\w+$/.test(actual.nombre) ? actual.nombre : actual.nombre + LENGUAJES[actual.lenguaje].extension
    a.click()
    URL.revokeObjectURL(url)
  }

  if (bloqueo)
    return (
      <Tarjeta className="mx-auto max-w-xl space-y-2 text-sm text-ink-700">
        <h2 className="text-lg font-bold">Programar</h2>
        <p>{bloqueo}</p>
        <p className="text-ink-500">Cuando envíes el examen vuelve a esta pantalla: tus programas siguen guardados.</p>
      </Tarjeta>
    )
  if (!lista) return <Cargando texto="Cargando tus programas…" />

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <EncabezadoPagina titulo="Programar">
        <Boton onClick={() => nuevo('python')}>+ Python</Boton>
        <Boton variante="secundario" onClick={() => nuevo('javascript')}>+ JavaScript</Boton>
        <Boton variante="secundario" onClick={() => void abrirArchivos()}>Abrir archivo</Boton>
      </EncabezadoPagina>

      {lista.length === 0 || !actual ? (
        <Tarjeta className="space-y-2 text-sm text-ink-600">
          <p>Escribe y corre programas en Python o JavaScript desde aquí, sin instalar nada. Se guardan solos y solo tú los ves.</p>
          <div className="flex flex-wrap gap-2">
            <Boton onClick={() => nuevo('python')}>Nuevo programa en Python</Boton>
            <Boton variante="secundario" onClick={() => nuevo('javascript')}>Nuevo en JavaScript</Boton>
            <Boton variante="secundario" onClick={() => void abrirArchivos()}>Abrir archivo</Boton>
          </div>
        </Tarjeta>
      ) : (
        <Tarjeta className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="programa">Programa</label>
            <select
              id="programa"
              className="min-h-[44px] min-w-0 flex-[1_1_10rem] rounded-xl border border-ink-200 bg-white px-3 text-sm"
              value={actual.id}
              onChange={(e) => {
                // Lo pendiente del programa anterior sigue en la cola: cambiar de programa no lo pierde
                void vaciar()
                setActual(lista.find((p) => p.id === Number(e.target.value)) ?? null)
              }}
            >
              {lista.map((p) => (
                <option key={p.id} value={p.id}>{p.nombre}</option>
              ))}
            </select>
            <input
              className="min-h-[44px] min-w-0 flex-[1_1_10rem] rounded-xl border border-ink-200 bg-white px-3 text-sm"
              value={actual.nombre}
              onChange={(e) => cambiar({ nombre: e.target.value })}
              aria-label="Nombre del programa"
            />
            <select className="min-h-[44px] rounded-xl border border-ink-200 bg-white px-3 text-sm" value={actual.lenguaje} onChange={(e) => cambiar({ lenguaje: e.target.value as Lenguaje })} aria-label="Lenguaje">
              {(Object.keys(LENGUAJES) as Lenguaje[]).map((l) => (
                <option key={l} value={l}>{LENGUAJES[l].nombre}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Boton variante="fantasma" onClick={descargar}>Descargar</Boton>
            <Boton variante="fantasma" className="text-red-700" onClick={eliminar}>Borrar</Boton>
            <span className="ml-auto text-xs text-ink-500" role="status">{estado}</span>
          </div>
          <Suspense fallback={<Cargando texto="Cargando el editor…" />}>
            <PanelCodigo
              key={actual.id}
              codigo={actual.codigo}
              onCambio={(codigo) => cambiar({ codigo })}
              entrada={actual.entrada}
              onEntrada={(entrada) => cambiar({ entrada })}
              lenguaje={actual.lenguaje}
              basePyodide="/pyodide/"
              limiteSeg={20}
              altoEditor="min(40vh, 28rem)"
            />
          </Suspense>
        </Tarjeta>
      )}
    </div>
  )
}
