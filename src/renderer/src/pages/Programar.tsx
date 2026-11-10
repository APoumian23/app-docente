import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import { avisar } from '../components/Aviso'
import { api, type Programa } from '../lib/api'
import { useRecordado } from '../lib/recordado'
import { usePreferencia } from '../lib/preferencia'
import { Buscador, Segmentado, SinResultados, coincide } from '../components/Filtros'
import PanelCodigo from '@codigo/PanelCodigo'
import ChatCodigo from '../components/ChatCodigo'
import { LENGUAJES, type Lenguaje } from '@codigo/lenguajes'
import { elegirArchivos, leerArchivoDeCodigo } from '@codigo/abrirArchivo'
import type { Materia } from '@shared/types'

/** Python de la app: el protocolo docente:// lo sirve desde la app y la carpeta de paquetes descargados (en la web, el servidor). */
const BASE_PYODIDE = window.api.url('pyodide/')

/** Copia local de lo que aún no se guarda: si la app se cierra con ⌘Q a media pausa, al abrir se recupera. */
const LOCAL = (id: number): string => `docente.programa.${id}`
const copiaLocal = (p: Programa | null, id?: number): void => {
  try {
    if (p) localStorage.setItem(LOCAL(p.id), JSON.stringify(p))
    else if (id) localStorage.removeItem(LOCAL(id))
  } catch {
    /* sin almacenamiento: solo el guardado normal */
  }
}
const leerCopia = (id: number): Programa | null => {
  try {
    const t = localStorage.getItem(LOCAL(id))
    return t ? (JSON.parse(t) as Programa) : null
  } catch {
    return null
  }
}

const LETRA_MIN = 11
/** Letra automática del editor: [ancho de pantalla menor a, px] */
const LETRA_POR_ANCHO: [number, number][] = [[900, 13], [1280, 14], [1700, 15], [2200, 16]]
/** Desde este ancho de pantalla la lista de programas cabe a un lado del editor */
const LISTA_DESDE_PX = 1100
/** Desde este ancho los botones de la barra del programa llevan texto además del ícono */
const BOTONES_CON_TEXTO_DESDE_PX = 1800
const ANCHO_ASISTENTE_MIN = 280
/** Ancho mínimo del editor con el asistente a un lado (36rem): con menos, el asistente baja debajo */
const EDITOR_MIN_PX = 576
const ANCHO_ASISTENTE_INICIAL = 352
const LETRA_MAX = 24

/**
 * Editor de código del docente: ejemplos por materia que se guardan solos, se corren sin internet
 * y se pueden proyectar con letra grande en clase.
 */
export default function Programar(): JSX.Element {
  const [params] = useSearchParams()
  const [programas, setProgramas] = useState<Programa[]>([])
  const [materias, setMaterias] = useState<Materia[]>([])
  const [filtro, setFiltro] = useState<string>(() => params.get('materia') ?? '')
  // Buscar y filtrar por lenguaje solo cambia la lista: el programa abierto se queda
  const [busqueda, setBusqueda] = useRecordado('programar.busqueda', '')
  const [lenguajeF, setLenguajeF] = useRecordado<Lenguaje | ''>('programar.lenguaje', '')
  const [actual, setActual] = useState<Programa | null>(null)
  const [estado, setEstado] = useState<'' | 'guardando' | 'guardado'>('')
  const [proyectar, setProyectar] = useState(false)
  // «Ampliar»: el programa ocupa toda la ventana (sin menú, encabezado ni lista); Esc lo regresa
  const [amplio, setAmplio] = useState(false)
  useEffect(() => {
    if (!amplio) return
    const tecla = (e: KeyboardEvent): void => {
      // Esc dentro del editor cierra primero el autocompletado o la búsqueda; solo sale si no había nada abierto
      if (e.key === 'Escape' && !e.defaultPrevented) setAmplio(false)
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [amplio])
  const [paquetes, setPaquetes] = useState(false)
  // Espacio del editor: la lista se puede ocultar, la letra se ajusta y las líneas largas bajan de renglón
  // Todo responde al ancho de la pantalla: la letra y la lista se acomodan solas; lo que el docente elija a mano manda
  const [anchoVentana, setAnchoVentana] = useState(() => window.innerWidth)
  useEffect(() => {
    const f = (): void => setAnchoVentana(window.innerWidth)
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])
  const [verLista, setVerLista] = usePreferencia('codigo.lista', true)
  // En pantallas angostas la lista se oculta sola (le quitaría medio editor); ahí se abre solo un rato con «☰ Programas»
  const listaCabe = anchoVentana >= LISTA_DESDE_PX
  // Barra de acciones: con poco ancho los botones muestran solo su ícono (el nombre queda en el globo y para lectores)
  const compacto = anchoVentana < BOTONES_CON_TEXTO_DESDE_PX
  const [listaUnRato, setListaUnRato] = useState(false)
  const mostrarLista = listaCabe ? verLista : listaUnRato
  const alternarLista = (): void => (listaCabe ? setVerLista((v) => !v) : setListaUnRato((v) => !v))
  // Letra: automática según el ancho (null) hasta que el docente use A− / A+; «Auto» la regresa
  const [letraManual, setLetraManual] = usePreferencia<number | null>('codigo.letraManual', null)
  const letraAuto = LETRA_POR_ANCHO.find(([hasta]) => anchoVentana < hasta)?.[1] ?? 18
  const letra = letraManual ?? letraAuto
  const setLetra = (f: (l: number) => number): void => setLetraManual(() => f(letra))
  const [ajustar, setAjustar] = usePreferencia('codigo.ajustar', true)
  // Ancho del asistente (px) cuando va a un lado del editor: se cambia arrastrando su borde izquierdo
  const [anchoAsistente, setAnchoAsistente] = usePreferencia('codigo.asistenteAncho', ANCHO_ASISTENTE_INICIAL)
  // El editor nunca se queda con menos de EDITOR_MIN_PX: el tope sale del ancho que tienen juntos editor y asistente
  const rejilla = useRef<HTMLDivElement>(null)
  // El asistente va a un lado solo si de verdad cabe junto al editor (depende del espacio que dejan el menú
  // y la lista, no del ancho de la ventana); si no, baja debajo del editor
  const [anchoRejilla, setAnchoRejilla] = useState(0)
  useEffect(() => {
    const el = rejilla.current
    if (!el) return
    const obs = new ResizeObserver(([e]) => setAnchoRejilla(Math.round(e.contentRect.width)))
    obs.observe(el)
    return () => obs.disconnect()
  })
  const zoomActual = (): number => Number(getComputedStyle(rejilla.current ?? document.documentElement).getPropertyValue('--zoom')) || 1
  const anchoMax = (): number => Math.max(ANCHO_ASISTENTE_MIN, (anchoRejilla || window.innerWidth) - EDITOR_MIN_PX - 16)
  const arrastrarBorde = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const x0 = e.clientX
    const a0 = Math.min(anchoAsistente, anchoMax())
    const zoom = zoomActual()
    const mover = (ev: PointerEvent): void => setAnchoAsistente(() => Math.min(anchoMax(), Math.max(ANCHO_ASISTENTE_MIN, Math.round(a0 + (x0 - ev.clientX) / zoom))))
    const soltar = (): void => {
      window.removeEventListener('pointermove', mover)
      window.removeEventListener('pointerup', soltar)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', mover)
    window.addEventListener('pointerup', soltar)
  }
  // Panel del asistente (como el chat de VS Code); se recuerda abierto o cerrado
  const [verAsistente, setVerAsistente] = useState(() => {
    try {
      return localStorage.getItem('docente.codigo.asistente') !== '0'
    } catch {
      return true
    }
  })
  // El asistente va a un lado solo si junto a él el editor conserva un ancho cómodo (EDITOR_MIN_PX + separación)
  const asistenteALado = verAsistente && !proyectar && anchoRejilla >= EDITOR_MIN_PX + 16 + ANCHO_ASISTENTE_MIN
  const alternarAsistente = (): void =>
    setVerAsistente((v) => {
      try {
        localStorage.setItem('docente.codigo.asistente', v ? '0' : '1')
      } catch {
        /* solo dura esta vez */
      }
      return !v
    })
  const [salida, setSalida] = useState('')
  useEffect(() => setSalida(''), [actual?.id])
  // Tema oscuro tipo VS Code; se recuerda en este equipo
  const [oscuro, setOscuro] = useState(() => {
    try {
      return localStorage.getItem('docente.codigo.oscuro') === '1'
    } catch {
      return false
    }
  })
  const cambiarTema = (): void =>
    setOscuro((v) => {
      try {
        localStorage.setItem('docente.codigo.oscuro', v ? '0' : '1')
      } catch {
        /* sin almacenamiento: solo dura esta vez */
      }
      return !v
    })
  const pendiente = useRef<ReturnType<typeof setTimeout> | null>(null)
  const porGuardar = useRef<Programa | null>(null)

  const cargar = async (elegir?: number): Promise<void> => {
    const crudos = await api.programas.listar()
    // Lo que quedó sin guardar al cerrar la app se recupera y se guarda ya
    const l = await Promise.all(
      crudos.map(async (p) => {
        const c = leerCopia(p.id)
        if (!c) return p
        await api.programas.guardar(c).catch(() => undefined)
        copiaLocal(null, p.id)
        return { ...p, ...c }
      })
    )
    setProgramas(l)
    setActual((a) => l.find((p) => p.id === (elegir ?? a?.id)) ?? a ?? null)
  }
  useEffect(() => {
    cargar().catch((e) => avisar((e as Error).message, 'error'))
    api.materias.listar().then((m) => setMaterias(m.filter((x) => !x.oculta)))
    return () => void guardarYa()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const guardarYa = async (): Promise<void> => {
    if (pendiente.current) clearTimeout(pendiente.current)
    pendiente.current = null
    const p = porGuardar.current
    porGuardar.current = null
    if (!p) return
    try {
      await api.programas.guardar(p)
      const siguiente = porGuardar.current as Programa | null
      if (!siguiente || siguiente.id !== p.id) copiaLocal(null, p.id)
      setEstado('guardado')
      setProgramas((l) => l.map((x) => (x.id === p.id ? { ...p } : x)))
    } catch (e) {
      avisar(`No se guardó: ${(e as Error).message}`, 'error')
    }
  }
  // Se guarda solo, un momento después de dejar de escribir
  const cambiar = (c: Partial<Programa>): void => {
    if (!actual) return
    const nuevo = { ...actual, ...c }
    setActual(nuevo)
    porGuardar.current = nuevo
    copiaLocal(nuevo)
    setEstado('guardando')
    if (pendiente.current) clearTimeout(pendiente.current)
    pendiente.current = setTimeout(() => void guardarYa(), 700)
  }
  const elegir = async (p: Programa): Promise<void> => {
    await guardarYa()
    setActual(p)
    setEstado('')
  }
  const nuevo = async (lenguaje: Lenguaje): Promise<void> => {
    await guardarYa()
    const materia = filtro && filtro !== 'sin' ? Number(filtro) : null
    const n = programas.filter((p) => p.lenguaje === lenguaje).length + 1
    const id = await api.programas.guardar({ nombre: `Ejemplo ${n}${LENGUAJES[lenguaje].extension}`, lenguaje, codigo: LENGUAJES[lenguaje].ejemplo, entrada: lenguaje === 'python' ? '17' : '', materia_id: materia })
    await cargar(id)
  }
  // Abrir archivo: cada archivo elegido (.py, .js, .ipynb, .txt…) queda como un programa nuevo
  const abrirArchivos = async (): Promise<void> => {
    const archivos = await elegirArchivos()
    if (!archivos.length) return
    await guardarYa()
    const materia = filtro && filtro !== 'sin' ? Number(filtro) : null
    let ultimo: number | null = null
    const abiertos: string[] = []
    for (const f of archivos) {
      try {
        const a = await leerArchivoDeCodigo(f)
        ultimo = await api.programas.guardar({ ...a, entrada: '', materia_id: materia })
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
    if (!actual || !confirm(`¿Eliminar «${actual.nombre}»? No se puede deshacer.`)) return
    porGuardar.current = null
    copiaLocal(null, actual.id)
    await api.programas.eliminar(actual.id)
    setActual(null)
    await cargar()
  }

  const visibles = useMemo(
    () => programas.filter((p) => (filtro === '' ? true : filtro === 'sin' ? !p.materia_id : p.materia_id === Number(filtro))),
    [programas, filtro]
  )
  // Si el elegido queda fuera del filtro, se toma el primero que sí se ve
  useEffect(() => {
    if (actual && !visibles.some((p) => p.id === actual.id)) setActual(visibles[0] ?? null)
    else if (!actual && visibles.length) setActual(visibles[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibles])

  const enLista = visibles.filter((p) => (!lenguajeF || p.lenguaje === lenguajeF) && coincide(busqueda, p.nombre, p.materia_nombre, LENGUAJES[p.lenguaje].nombre))
  const lenguajesPresentes = (Object.keys(LENGUAJES) as Lenguaje[]).filter((l) => visibles.some((p) => p.lenguaje === l))
  const hayFiltroLista = !!busqueda.trim() || lenguajeF !== ''
  const quitarFiltrosLista = (): void => {
    setBusqueda('')
    setLenguajeF('')
  }
  const contarMateria = (v: string): number => programas.filter((p) => (v === '' ? true : v === 'sin' ? !p.materia_id : p.materia_id === Number(v))).length

  return (
    <div>
      <Encabezado
        titulo="Programar"
        sub="Python y JavaScript sin internet · tus programas se guardan solos"
        acciones={
          <>
            <button className="btn-secundario" onClick={() => setPaquetes(true)}>Paquetes de Python</button>
            <button className="btn-secundario" onClick={() => void abrirArchivos()} title="Abre .py, .js, cuadernos .ipynb o texto como programas nuevos">Abrir archivo</button>
            <button className="btn-secundario" onClick={() => nuevo('javascript')}>+ JavaScript</button>
            <button className="btn-primario" onClick={() => nuevo('python')}>+ Python</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-6">
        {programas.length === 0 ? (
          <div className="tarjeta px-5 py-8 text-center">
            <div className="font-medium text-ink-800">Aún no tienes programas</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Aquí escribes y corres código en clase: Python o JavaScript, sin internet. Lo que escribas se guarda solo y lo puedes ordenar por materia.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button className="btn-primario" onClick={() => nuevo('python')}>Nuevo programa en Python</button>
              <button className="btn-secundario" onClick={() => nuevo('javascript')}>Nuevo en JavaScript</button>
              <button className="btn-secundario" onClick={() => void abrirArchivos()}>Abrir archivo</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-6 items-start">
            {!proyectar && mostrarLista && (
              <nav className="tarjeta flex flex-col flex-[1_1_12rem] max-w-full lg:max-w-[14rem] max-h-[70vh] overflow-hidden" aria-label="Programas">
                {/* Filtros arriba, fijos; la lista se desplaza debajo */}
                <div className="space-y-1.5 border-b border-ink-100 p-2" role="search" aria-label="Filtrar programas">
                  <select className="input py-1 text-xs" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Materia">
                    <option value="">Todas las materias ({contarMateria('')})</option>
                    {materias.map((m) => (
                      <option key={m.id} value={m.id}>{m.nombre} ({contarMateria(String(m.id))})</option>
                    ))}
                    <option value="sin">Sin materia ({contarMateria('sin')})</option>
                  </select>
                  {visibles.length > 0 && <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar programa" etiqueta="Buscar programas" />}
                  {(lenguajesPresentes.length > 1 || lenguajeF) && (
                    <Segmentado
                      etiqueta="Lenguaje"
                      valor={lenguajeF}
                      onCambio={setLenguajeF}
                      opciones={[
                        { valor: '' as Lenguaje | '', texto: 'Todos', conteo: visibles.filter((p) => coincide(busqueda, p.nombre, p.materia_nombre, LENGUAJES[p.lenguaje].nombre)).length },
                        ...(Object.keys(LENGUAJES) as Lenguaje[]).map((l) => ({
                          valor: l as Lenguaje | '',
                          texto: LENGUAJES[l].nombre,
                          conteo: visibles.filter((p) => p.lenguaje === l && coincide(busqueda, p.nombre, p.materia_nombre, LENGUAJES[p.lenguaje].nombre)).length
                        }))
                      ]}
                    />
                  )}
                  {hayFiltroLista && (
                    <div className="flex items-center justify-between gap-2 px-1 text-xs text-ink-500">
                      <span>{enLista.length} de {visibles.length}</span>
                      <button className="btn-fantasma text-xs py-0.5" onClick={quitarFiltrosLista}>Quitar filtros</button>
                    </div>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {visibles.length === 0 ? (
                    <p className="p-3 text-sm text-ink-500">No hay programas en esta materia.</p>
                  ) : enLista.length === 0 ? (
                    <SinResultados hayFiltro onLimpiar={quitarFiltrosLista} vacio={null} />
                  ) : (
                    enLista.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => elegir(p)}
                        aria-current={actual?.id === p.id ? 'true' : undefined}
                        title={p.nombre}
                        className={`w-full text-left rounded-lg px-3 py-2 text-sm ${actual?.id === p.id ? 'bg-brand-500 text-white' : 'hover:bg-ink-100 text-ink-700'}`}
                      >
                        <div className="font-medium truncate">{p.nombre}</div>
                        <div className={`text-xs truncate ${actual?.id === p.id ? 'text-white/80' : 'text-ink-400'}`}>
                          {LENGUAJES[p.lenguaje].nombre}{p.materia_nombre ? ` · ${p.materia_nombre}` : ''}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </nav>
            )}
            {!actual && (
              <div className="tarjeta flex-[999_1_32rem] min-w-0 px-5 py-8 text-center">
                <div className="font-medium text-ink-800">No hay programas en esta materia</div>
                <p className="mt-1 text-sm text-ink-500">Crea uno aquí o elige otra materia en la lista.</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button className="btn-primario" onClick={() => nuevo('python')}>Nuevo programa en Python</button>
                  <button className="btn-secundario" onClick={() => nuevo('javascript')}>Nuevo en JavaScript</button>
                  {filtro !== '' && <button className="btn-fantasma" onClick={() => setFiltro('')}>Ver todas las materias</button>}
                </div>
              </div>
            )}
            {actual && (
              <section className={amplio ? 'fixed inset-0 z-50 space-y-3 overflow-y-auto bg-ink-50 px-3 pb-3 sm:px-4 sm:pb-4' : 'flex-[999_1_32rem] min-w-0 space-y-3'} aria-label={amplio ? 'Editor ampliado' : undefined}>
                {/* Ampliado tapa la barra lateral: esta franja deja libres los botones de la ventana (cerrar, minimizar, ampliar) y sirve para moverla */}
                {amplio && (
                  <div className="arrastre -mx-3 flex h-10 items-center justify-center text-xs text-ink-400 sm:-mx-4">
                    Programar · {actual.nombre}
                  </div>
                )}
                {/* Qué es el programa a la izquierda; cómo se ve y las acciones a la derecha */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex min-w-0 flex-[1_1_24rem] flex-wrap items-center gap-2">
                    {!proyectar && !amplio && (
                      <button className={mostrarLista ? 'btn-secundario px-3' : 'btn-primario px-3'} onClick={alternarLista} aria-pressed={!mostrarLista} aria-label={mostrarLista ? 'Ocultar la lista de programas' : 'Mostrar la lista de programas'} title={mostrarLista ? 'Ocultar la lista de programas para dar más espacio al código' : listaCabe ? 'Mostrar la lista de programas' : 'Mostrar la lista (en esta pantalla se oculta sola para dar espacio al código)'}>
                        {mostrarLista ? (compacto ? '◧' : '◧ Ocultar lista') : compacto ? '☰' : '☰ Programas'}
                      </button>
                    )}
                    {/* Con la lista oculta, cambiar de programa sin volver a abrirla */}
                    {!proyectar && (!mostrarLista || amplio) && visibles.length > 1 && (
                      <select className="input w-auto max-w-[12rem]" value={actual.id} onChange={(e) => { const p = visibles.find((x) => x.id === Number(e.target.value)); if (p) void elegir(p) }} aria-label="Cambiar de programa">
                        {visibles.map((p) => (
                          <option key={p.id} value={p.id}>{p.nombre}</option>
                        ))}
                      </select>
                    )}
                    <input className="input min-w-[8rem] flex-[1_1_10rem] w-auto font-medium" value={actual.nombre} onChange={(e) => cambiar({ nombre: e.target.value })} aria-label="Nombre del programa" />
                    <select className="input w-auto" value={actual.lenguaje} onChange={(e) => cambiar({ lenguaje: e.target.value as Lenguaje })} aria-label="Lenguaje">
                      {(Object.keys(LENGUAJES) as Lenguaje[]).map((l) => (
                        <option key={l} value={l}>{LENGUAJES[l].nombre}</option>
                      ))}
                    </select>
                    <select className="input w-auto max-w-[12rem]" value={actual.materia_id ?? ''} onChange={(e) => cambiar({ materia_id: e.target.value ? Number(e.target.value) : null })} aria-label="Materia del programa">
                      <option value="">Sin materia</option>
                      {materias.map((m) => (
                        <option key={m.id} value={m.id}>{m.nombre}</option>
                      ))}
                    </select>
                  </div>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <span className="min-w-[4.5rem] text-right text-xs text-ink-400" role="status">{estado === 'guardando' ? 'Guardando…' : estado === 'guardado' ? 'Guardado' : ''}</span>
                    <button className={`${amplio ? 'btn-primario' : 'btn-secundario'} ${compacto ? 'px-3' : ''}`} onClick={() => setAmplio((v) => !v)} aria-pressed={amplio} aria-label={amplio ? 'Reducir' : 'Ampliar'} title={amplio ? 'Volver a la vista normal (Esc)' : 'Ampliar: el programa ocupa toda la ventana'}>
                      {amplio ? '⤡' : '⤢'}{!compacto && (amplio ? ' Reducir' : ' Ampliar')}
                    </button>
                    <button className={`${proyectar ? 'btn-primario' : 'btn-secundario'} ${compacto ? 'px-3' : ''}`} onClick={() => setProyectar((v) => !v)} aria-pressed={proyectar} aria-label={proyectar ? 'Salir de proyectar' : 'Proyectar'} title="Proyectar: letra grande para el proyector y sin la lista de programas">
                      ▣{!compacto && (proyectar ? ' Salir de proyectar' : ' Proyectar')}
                    </button>
                    <button className={`btn-secundario ${compacto ? 'px-3' : ''}`} onClick={cambiarTema} aria-pressed={oscuro} aria-label={oscuro ? 'Tema claro' : 'Tema oscuro'} title={oscuro ? 'Tema claro' : 'Tema oscuro'}>
                      ◐{!compacto && (oscuro ? ' Tema claro' : ' Tema oscuro')}
                    </button>
                    <button className={`${verAsistente ? 'btn-primario' : 'btn-secundario'} ${compacto ? 'px-3' : ''}`} onClick={alternarAsistente} aria-pressed={verAsistente} aria-label="Asistente" title="Asistente con IA que ve tu código y la consola">
                      ✦{!compacto && ' Asistente'}
                    </button>
                    <button className={`btn-fantasma text-red-600 hover:bg-red-50 ${compacto ? 'px-3' : ''}`} onClick={eliminar} aria-label="Eliminar el programa" title="Eliminar el programa">
                      {compacto ? '🗑' : 'Eliminar'}
                    </button>
                  </div>
                </div>
                {/* Con el asistente abierto, la consola va debajo del editor y el asistente a un lado (o abajo si no cabe) */}
                <div
                  ref={rejilla}
                  className="grid gap-4 min-w-0"
                  // El ancho guardado se respeta mientras quepa: el editor siempre conserva EDITOR_MIN_PX
                  style={asistenteALado ? { gridTemplateColumns: `minmax(${EDITOR_MIN_PX}px, 1fr) max(${ANCHO_ASISTENTE_MIN}px, min(${anchoAsistente}px, calc(100% - ${EDITOR_MIN_PX + 16}px)))` } : undefined}
                >
                  <PanelCodigo
                    key={actual.id}
                    codigo={actual.codigo}
                    onCambio={(codigo) => cambiar({ codigo })}
                    entrada={actual.entrada}
                    onEntrada={(entrada) => cambiar({ entrada })}
                    lenguaje={actual.lenguaje}
                    basePyodide={BASE_PYODIDE}
                    letra={proyectar ? Math.max(24, letra) : letra}
                    altoEditor={
                      amplio
                        ? // Ampliado: casi todo el alto; con el asistente abierto la consola va debajo y se le deja su lugar
                          verAsistente && !proyectar
                          ? 'calc(max(50vh, 100vh - 22rem) / var(--zoom, 1))'
                          : 'calc(max(60vh, 100vh - 11rem) / var(--zoom, 1))'
                        : proyectar
                          ? 'calc(62vh / var(--zoom, 1))'
                          : 'calc(max(55vh, 100vh - 24rem) / var(--zoom, 1))'
                    }
                    ajustar={ajustar}
                    extraBarra={
                      <span className="ml-auto flex items-center gap-1">
                        <button type="button" className="btn-fantasma px-2 py-1 text-xs" disabled={letra <= LETRA_MIN} onClick={() => setLetra((l) => Math.max(LETRA_MIN, l - 1))} aria-label="Letra más chica" title="Letra más chica">A−</button>
                        <span className="w-8 text-center text-xs text-ink-500" aria-live="polite" title={letraManual === null ? 'Tamaño automático según el ancho de la pantalla' : 'Tamaño elegido a mano'}>{proyectar ? Math.max(24, letra) : letra}px</span>
                        <button type="button" className="btn-fantasma px-2 py-1 text-xs" disabled={letra >= LETRA_MAX} onClick={() => setLetra((l) => Math.min(LETRA_MAX, l + 1))} aria-label="Letra más grande" title="Letra más grande">A+</button>
                        {letraManual === null ? (
                          <span className="chip bg-ink-100 text-[10px] text-ink-500" title="La letra cambia sola con el ancho de la pantalla">auto</span>
                        ) : (
                          <button type="button" className="btn-fantasma px-2 py-1 text-xs" onClick={() => setLetraManual(null)} title="Que la letra vuelva a ajustarse sola al ancho de la pantalla">Auto</button>
                        )}
                        <button type="button" className={`${ajustar ? 'btn-secundario' : 'btn-fantasma'} px-2 py-1 text-xs`} onClick={() => setAjustar((v) => !v)} aria-pressed={ajustar} title="Las líneas largas bajan al siguiente renglón en vez de salirse del editor">↩ Ajustar líneas</button>
                      </span>
                    }
                    oscuro={oscuro}
                    onSalida={setSalida}
                    lado={!(verAsistente && !proyectar)}
                  />
                  {verAsistente && !proyectar && (
                    // grid: el asistente ocupa todo el alto del renglón (editor + consola)
                    <div className="relative grid min-w-0">
                    {/* Borde para ensanchar o angostar el asistente (solo cuando va a un lado); doble clic lo regresa a su ancho */}
                    {asistenteALado && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Ancho del asistente"
                      aria-valuenow={anchoAsistente}
                      aria-valuemin={ANCHO_ASISTENTE_MIN}
                      tabIndex={0}
                      title="Arrastra para hacer el asistente más ancho o más angosto (doble clic: tamaño original)"
                      onPointerDown={arrastrarBorde}
                      onDoubleClick={() => setAnchoAsistente(() => ANCHO_ASISTENTE_INICIAL)}
                      onKeyDown={(e) => {
                        const paso = e.key === 'ArrowLeft' ? 32 : e.key === 'ArrowRight' ? -32 : 0
                        if (!paso) return
                        e.preventDefault()
                        setAnchoAsistente((a) => Math.min(anchoMax(), Math.max(ANCHO_ASISTENTE_MIN, a + paso)))
                      }}
                      className="group/borde absolute -left-3 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center focus:outline-none"
                    >
                      {/* Línea de todo el alto con un agarre al centro: se nota que ahí se arrastra */}
                      <span className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 bg-ink-200 transition-colors group-hover/borde:bg-brand-400 group-focus-visible/borde:bg-brand-500" />
                      <span className="relative h-12 w-1.5 rounded-full bg-ink-300 transition-colors group-hover/borde:bg-brand-500 group-focus-visible/borde:bg-brand-500" />
                    </div>
                    )}
                    <ChatCodigo
                      programaId={actual.id}
                      lenguaje={actual.lenguaje}
                      codigo={actual.codigo}
                      salida={salida}
                      onReemplazar={(codigo) => {
                        cambiar({ codigo })
                        avisar('Código reemplazado (⌘Z en el editor lo deshace)')
                      }}
                      onAgregar={(codigo) => cambiar({ codigo: `${actual.codigo.replace(/\s*$/, '')}\n\n${codigo}` })}
                    />
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      <Paquetes abierto={paquetes} onCerrar={() => setPaquetes(false)} />
    </div>
  )
}

/** Paquetes de Python: se descargan una vez y quedan para la app y para los alumnos del portal. */
function Paquetes({ abierto, onCerrar }: { abierto: boolean; onCerrar: () => void }): JSX.Element {
  const [lista, setLista] = useState<{ nombre: string; para: string; descargado: boolean }[]>([])
  const [bajando, setBajando] = useState<string | null>(null)
  const [otro, setOtro] = useState('')
  const leer = (): void => void api.pyodide.paquetes().then(setLista).catch((e) => avisar((e as Error).message, 'error'))
  useEffect(() => {
    if (abierto) leer()
  }, [abierto])
  const descargar = async (nombre: string): Promise<void> => {
    if (!nombre.trim()) return
    setBajando(nombre)
    try {
      const r = await api.pyodide.descargar(nombre)
      avisar(r.length ? `Listo: ${r.join(', ')}` : `«${nombre}» ya estaba descargado`)
      setOtro('')
      leer()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setBajando(null)
    }
  }
  return (
    <Modal titulo="Paquetes de Python" abierto={abierto} onCerrar={onCerrar} ancho="max-w-lg">
      <div className="space-y-3 text-sm">
        <p className="text-ink-600">
          Python ya trae lo básico (math, random, statistics, itertools…). Estos paquetes se descargan <b>una sola vez</b> con internet y luego funcionan sin conexión, aquí y en el portal de los alumnos.
        </p>
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {lista.map((p) => (
            <li key={p.nombre} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="flex-1 min-w-[10rem]"><b className="font-mono">{p.nombre}</b> <span className="text-ink-500">— {p.para}</span></span>
              {p.descargado ? (
                <span className="chip bg-green-100 text-green-700">Descargado</span>
              ) : (
                <button className="btn-secundario" disabled={bajando !== null} onClick={() => descargar(p.nombre)}>{bajando === p.nombre ? 'Descargando…' : 'Descargar'}</button>
              )}
            </li>
          ))}
        </ul>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), descargar(otro))}>
          <input className="input flex-1 min-w-[10rem] font-mono" placeholder="otro paquete, p. ej. scikit-learn" value={otro} onChange={(e) => setOtro(e.target.value)} />
          <button className="btn-secundario" disabled={!otro.trim() || bajando !== null}>{bajando === otro ? 'Descargando…' : 'Descargar'}</button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          {bajando !== null && <button className="btn-secundario" onClick={() => api.pyodide.cancelar()}>Cancelar descarga</button>}
          {lista.some((p) => p.descargado) && bajando === null && (
            <button
              className="btn-fantasma text-red-600"
              onClick={async () => {
                if (!confirm('¿Borrar los paquetes descargados? Se pueden volver a descargar.')) return
                const n = await api.pyodide.borrar()
                avisar(`${n} archivo(s) borrados`)
                leer()
              }}
            >
              Borrar paquetes descargados
            </button>
          )}
        </div>
        <p className="text-xs text-ink-500">En el código basta con <code>import numpy</code>: la app carga lo que el programa importe. En los exámenes del portal las preguntas de código solo usan Python puro.</p>
      </div>
    </Modal>
  )
}
