import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import { avisar } from '../components/Aviso'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, Segmentado, SinResultados, coincide, ordenNatural } from '../components/Filtros'
import type { Carrera, Materia, Periodo } from '@shared/types'
import { periodoTerminado } from '@shared/periodo'

const COLORES = ['#2d6df6', '#7c3aed', '#0ea5a4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#6366f1']

type Estado = 'visibles' | 'ocultas' | 'todas'
type OrdenMaterias = 'mio' | 'nivel' | 'az' | 'clave'
const ORDENES: [OrdenMaterias, string][] = [['mio', 'Mi orden'], ['nivel', 'Por nivel'], ['az', 'Nombre (A–Z)'], ['clave', 'Clave']]

/** Una materia es de su carrera y de la de cada alumno inscrito: Álgebra puede ser de Industrial y de Diseño Industrial. */
const deCarrera = (m: Materia, carreraId: number): boolean =>
  m.carrera_id === carreraId || (m.carreras_alumnos ?? '').split(',').map(Number).includes(carreraId)

/** Ancho de una carrera en la cuadrícula: lo de sus tarjetas (16rem cada una), crece en proporción y nunca pasa del renglón */
const anchoGrupo = (n: number): React.CSSProperties => {
  const k = Math.max(1, n)
  return { flex: `${k} 1 min(100%, calc(${k} * 16rem + ${k - 1} * 0.75rem))` }
}

export default function Materias(): JSX.Element {
  const [materias, setMaterias] = useState<Materia[]>([])
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [periodos, setPeriodos] = useState<Periodo[]>([])
  const [modal, setModal] = useState<'materia' | 'carrera' | 'periodo' | null>(null)
  const [form, setForm] = useState<Partial<Materia>>({})
  const [carreraForm, setCarreraForm] = useState<Partial<Carrera>>({ color: COLORES[0] })
  const [periodoForm, setPeriodoForm] = useState<Partial<Periodo>>({ semanas: 15 })
  // Filtros: se recuerdan al entrar a una materia y regresar
  const [busqueda, setBusqueda] = useRecordado('materias.busqueda', '')
  const [carreraF, setCarreraF] = useRecordado<number | ''>('materias.carrera', '')
  const [periodoF, setPeriodoF] = useRecordado<number | ''>('materias.periodo', '')
  const [estadoF, setEstadoF] = useRecordado<Estado>('materias.estado', 'visibles')
  const [orden, setOrden] = useRecordado<OrdenMaterias>('materias.orden2', 'mio')
  // «Mi orden»: ids en el orden en que el docente acomodó las tarjetas (las que no están, después y por nivel)
  const [ordenMio, setOrdenMio] = useState<number[]>([])
  // Orden de las carreras (también se acomodan arrastrando una tarjeta sobre otra carrera)
  const [ordenCarreras, setOrdenCarreras] = useState<number[]>([])
  // Qué tarjeta se arrastra y de qué carrera (Álgebra puede estar en dos); `sobre` es «carrera-materia»
  const [arrastrando, setArrastrando] = useState<{ id: number; carrera: number | null } | null>(null)
  const [sobre, setSobre] = useState<string | null>(null)

  const cargar = async (): Promise<void> => {
    const [m, c, p, o, oc] = await Promise.all([api.materias.listar(), api.carreras.listar(), api.periodos.listar(), api.ordenMaterias.leer(), api.ordenCarreras.leer()])
    setOrdenMio(o)
    setOrdenCarreras(oc)
    setMaterias(m)
    setCarreras(c)
    setPeriodos(p)
  }
  useEffect(() => {
    cargar()
  }, [])

  const nueva = (): void => {
    setForm({ carrera_id: carreras[0]?.id, periodo_id: periodos.find((p) => p.activo)?.id ?? periodos[0]?.id, cuatrimestre: 1, color: COLORES[materias.length % COLORES.length], temario: '' })
    setModal('materia')
  }
  const guardarMateria = async (): Promise<void> => {
    if (!form.nombre || !form.carrera_id || !form.periodo_id) return avisar('Nombre, carrera y periodo son obligatorios', 'error')
    await api.materias.guardar(form)
    setModal(null)
    avisar('Materia guardada')
    cargar()
  }
  const guardarCarrera = async (): Promise<void> => {
    if (!carreraForm.nombre) return
    await api.carreras.guardar(carreraForm)
    setModal(null)
    setCarreraForm({ color: COLORES[0] })
    cargar()
  }
  const guardarPeriodo = async (): Promise<void> => {
    if (!periodoForm.nombre || !periodoForm.fecha_inicio) return
    await api.periodos.guardar({ ...periodoForm, activo: 1 })
    setModal(null)
    cargar()
  }

  const visibles = materias.filter((m) => !m.oculta)
  const ocultas = materias.filter((m) => m.oculta)
  const alternar = async (m: Materia): Promise<void> => {
    await api.materias.ocultar(m.id, !m.oculta)
    avisar(m.oculta ? `${m.nombre} vuelve a aparecer en Hoy y Horario` : `${m.nombre} quedó oculta (no aparece en Hoy ni Horario)`)
    cargar()
  }
  const periodoDe = (id: number): Periodo | undefined => periodos.find((p) => p.id === id)
  // El periodo solo se muestra y se filtra cuando hay más de uno: con uno solo no distingue nada
  const variosPeriodos = periodos.length > 1

  // Cada filtro por separado, para que los conteos de cada opción respondan a los demás
  const pasa = useMemo(
    () => ({
      busqueda: (m: Materia) => coincide(busqueda, m.nombre, m.clave, m.descripcion, m.carrera_nombre),
      carrera: (m: Materia) => carreraF === '' || deCarrera(m, carreraF),
      periodo: (m: Materia) => periodoF === '' || m.periodo_id === periodoF,
      estado: (m: Materia) => estadoF === 'todas' || (estadoF === 'ocultas' ? !!m.oculta : !m.oculta)
    }),
    [busqueda, carreraF, periodoF, estadoF]
  )
  const salvo = (excepto: keyof typeof pasa): Materia[] => materias.filter((m) => (Object.keys(pasa) as (keyof typeof pasa)[]).every((k) => k === excepto || pasa[k](m)))
  const paraCarreras = salvo('carrera')
  const paraEstado = salvo('estado')
  const porNivel = (a: Materia, b: Materia): number => a.cuatrimestre - b.cuatrimestre || ordenNatural(a.nombre, b.nombre)
  const posicion = useMemo(() => new Map(ordenMio.map((id, i) => [id, i])), [ordenMio])
  const porMiOrden = (a: Materia, b: Materia): number => (posicion.get(a.id) ?? Infinity) - (posicion.get(b.id) ?? Infinity) || porNivel(a, b)
  const lista = useMemo(() => {
    const comparar = (a: Materia, b: Materia): number =>
      orden === 'az' ? ordenNatural(a.nombre, b.nombre) : orden === 'clave' ? ordenNatural(a.clave || '~', b.clave || '~') || ordenNatural(a.nombre, b.nombre) : orden === 'mio' ? porMiOrden(a, b) : porNivel(a, b)
    return materias.filter((m) => Object.values(pasa).every((f) => f(m))).sort(comparar)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materias, pasa, orden, posicion])

  /**
   * Pone `id` en el lugar de `destino` (antes si venía de atrás, después si venía de adelante). Parte del orden
   * que se ve en pantalla, así que acomodar con «Por nivel» o «Nombre» puesto también funciona y pasa a «Mi orden».
   */
  const mover = (id: number, destino: number): void => {
    if (id === destino) return
    const base = [...lista.map((m) => m.id), ...[...materias].sort(porMiOrden).map((m) => m.id)].filter((x, i, a) => a.indexOf(x) === i)
    const desde = base.indexOf(id)
    const sin = base.filter((x) => x !== id)
    const hacia = sin.indexOf(destino)
    if (desde < 0 || hacia < 0) return
    sin.splice(desde <= base.indexOf(destino) ? hacia + 1 : hacia, 0, id)
    setOrdenMio(sin)
    setOrden('mio')
    api.ordenMaterias.guardar(sin).catch((e) => avisar(`No se guardó el orden: ${(e as Error).message}`, 'error'))
  }
  /** Pone la carrera `id` en el lugar de `destino`, igual que `mover` con las materias */
  const moverCarrera = (id: number, destino: number): void => {
    if (id === destino) return
    const base = porCarrera.map(({ c }) => c.id)
    const desde = base.indexOf(id)
    const sin = base.filter((x) => x !== id)
    const hacia = sin.indexOf(destino)
    if (desde < 0 || hacia < 0) return
    sin.splice(desde <= base.indexOf(destino) ? hacia + 1 : hacia, 0, id)
    // Las carreras que no se ven (por un filtro) conservan su lugar relativo al final
    const completo = [...sin, ...ordenCarrerasVisto.filter((x) => !sin.includes(x))]
    setOrdenCarreras(completo)
    api.ordenCarreras.guardar(completo).catch((e) => avisar(`No se guardó el orden: ${(e as Error).message}`, 'error'))
  }
  /** Soltar una tarjeta: en su misma carrera cambia de lugar la materia; en otra carrera, se mueve la carrera completa */
  const soltar = (destino: Materia, carreraDestino: number | null): void => {
    if (!arrastrando) return
    if (arrastrando.carrera === carreraDestino || arrastrando.carrera === null || carreraDestino === null) mover(arrastrando.id, destino.id)
    else moverCarrera(arrastrando.carrera, carreraDestino)
  }
  /** Con el teclado: Alt + flechas mueve la tarjeta dentro de su carrera; si es la orilla, mueve la carrera */
  const moverConTeclas = (e: React.KeyboardEvent, m: Materia, grupo: Materia[], carrera: number | null): void => {
    if (!e.altKey) return
    const paso = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0
    if (!paso) return
    e.preventDefault()
    const i = grupo.findIndex((x) => x.id === m.id)
    const otro = grupo[i + paso]
    if (otro) return mover(m.id, otro.id)
    if (carrera === null) return
    const cs = porCarrera.map(({ c }) => c.id)
    const vecina = cs[cs.indexOf(carrera) + paso]
    if (vecina !== undefined) moverCarrera(carrera, vecina)
  }
  const hayFiltro = !!busqueda.trim() || carreraF !== '' || periodoF !== '' || estadoF !== 'visibles'
  const quitarFiltros = (): void => {
    setBusqueda('')
    setCarreraF('')
    setPeriodoF('')
    setEstadoF('visibles')
  }
  // Por carrera, en el orden que acomodó el docente (las nuevas al final); con filtros solo las que tienen algo
  const posCarrera = new Map(ordenCarreras.map((id, i) => [id, i]))
  const carrerasEnOrden = [...carreras].sort((a, b) => (posCarrera.get(a.id) ?? Infinity) - (posCarrera.get(b.id) ?? Infinity))
  const ordenCarrerasVisto = carrerasEnOrden.map((c) => c.id)
  const porCarrera = carrerasEnOrden
    .map((c) => ({ c, ms: lista.filter((m) => deCarrera(m, c.id)) }))
    .filter(({ ms }) => ms.length > 0 || !hayFiltro)

  // Se llama como función, no como componente: definido aquí dentro, como componente se volvería a montar en
  // cada pintado y al empezar a arrastrar la tarjeta desaparecería de debajo del mouse (el navegador cancela el arrastre)
  const tarjeta = (m: Materia, grupo: Materia[], carrera: number | null): JSX.Element => {
    const periodo = variosPeriodos ? periodoDe(m.periodo_id) : undefined
    const clave = `${carrera ?? 'x'}-${m.id}`
    const esta = arrastrando?.id === m.id && arrastrando.carrera === carrera
    return (
      <div
        key={m.id}
        // Se acomoda arrastrando (o con Alt + flechas); el enlace no se arrastra solo para que se mueva la tarjeta entera
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', String(m.id))
          setArrastrando({ id: m.id, carrera })
        }}
        onDragEnd={() => {
          setArrastrando(null)
          setSobre(null)
        }}
        onDragOver={(e) => {
          if (arrastrando === null) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (sobre !== clave) setSobre(clave)
        }}
        onDragLeave={() => sobre === clave && setSobre(null)}
        onDrop={(e) => {
          e.preventDefault()
          soltar(m, carrera)
          setArrastrando(null)
          setSobre(null)
        }}
        onKeyDown={(e) => moverConTeclas(e, m, grupo, carrera)}
        title="Arrastra para cambiar el orden (o Alt + flechas). Sobre otra carrera, mueve la carrera completa"
        className={`group tarjeta relative flex cursor-grab flex-col p-4 transition hover:shadow-md active:cursor-grabbing ${m.oculta ? 'bg-ink-50/60' : ''} ${esta ? 'opacity-40' : ''} ${sobre === clave && !esta ? 'ring-2 ring-brand-400' : ''}`}
      >
        <span className="pointer-events-none absolute right-2 top-2 text-ink-300 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>⠿</span>
        <Link to={`/materias/${m.id}`} draggable={false} className="block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50">
          <div className="flex items-start gap-2.5">
            {/* El color de la materia, igual que en Hoy y Horario */}
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: m.color }} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className={`break-words font-semibold leading-snug ${m.oculta ? 'text-ink-500' : 'text-ink-900'}`}>{m.nombre}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink-400">
                {m.clave && <span className="font-mono">{m.clave}</span>}
                {m.clave && <span aria-hidden>·</span>}
                <span>Nivel {m.cuatrimestre}</span>
                {periodo && <><span aria-hidden>·</span><span className="truncate">{periodo.nombre}</span></>}
              </div>
            </div>
          </div>
          <p className={`mt-2 line-clamp-2 text-sm ${m.descripcion ? 'text-ink-600' : 'text-ink-400'}`}>{m.descripcion || 'Sin descripción'}</p>
        </Link>
        <div className="mt-3 flex items-center gap-2">
          {m.oculta ? <span className="chip bg-ink-100 text-ink-500" title="No aparece en Hoy, Horario ni Estudio IA">Oculta</span> : null}
          {/* Se ve al pasar el mouse o al llegar con el teclado; la tarjeta ya abre la materia.
              Ocultar = archivarla: se ofrece hasta que termina su periodo (una oculta siempre se puede mostrar) */}
          {m.oculta || periodoTerminado(periodos.find((p) => p.id === m.periodo_id)) ? (
          <button
            className="btn-fantasma ml-auto py-1 text-xs opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
            title={m.oculta ? 'Mostrar de nuevo en Hoy y Horario' : 'Ocultar de Hoy y Horario'}
            onClick={() => alternar(m)}
          >
            {m.oculta ? 'Mostrar' : 'Ocultar'}
          </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div>
      <Encabezado
        titulo="Materias"
        sub={`${visibles.length} ${visibles.length === 1 ? 'materia activa' : 'materias activas'}${ocultas.length ? ` · ${ocultas.length} ${ocultas.length === 1 ? 'oculta' : 'ocultas'}` : ''} · ${carreras.length} ${carreras.length === 1 ? 'carrera' : 'carreras'}`}
        acciones={
          <>
            <button className="btn-secundario" onClick={() => setModal('periodo')}>+ Periodo</button>
            <button className="btn-secundario" onClick={() => setModal('carrera')}>+ Carrera</button>
            <button className="btn-primario" onClick={nueva}>+ Materia</button>
          </>
        }
      />
      <div className="px-4 sm:px-8 py-5 space-y-6">
        {materias.length > 0 && (
          // Filtros: solo cambian qué materias se ven (se recuerdan al entrar a una materia y regresar)
          <div className="tarjeta p-3 space-y-2.5" role="search" aria-label="Filtrar materias">
            <div className="flex flex-wrap items-center gap-2">
              <Buscador valor={busqueda} onCambio={setBusqueda} placeholder="Buscar por nombre, clave o descripción" etiqueta="Buscar materias" />
              <Segmentado
                etiqueta="Visibilidad"
                valor={estadoF}
                onCambio={setEstadoF}
                opciones={([['visibles', 'Activas'], ['ocultas', 'Ocultas'], ['todas', 'Todas']] as [Estado, string][]).map(([k, t]) => ({
                  valor: k,
                  texto: t,
                  conteo: paraEstado.filter((m) => (k === 'todas' ? true : k === 'ocultas' ? !!m.oculta : !m.oculta)).length
                }))}
              />
              {variosPeriodos && (
                <select className="input w-auto max-w-[16rem]" value={periodoF} onChange={(e) => setPeriodoF(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Filtrar por periodo">
                  <option value="">Todos los periodos</option>
                  {periodos.map((p) => (
                    <option key={p.id} value={p.id}>{p.nombre}{p.activo ? ' (activo)' : ''} ({salvo('periodo').filter((m) => m.periodo_id === p.id).length})</option>
                  ))}
                </select>
              )}
              <label className="flex items-center gap-1.5 text-xs text-ink-500">
                Ordenar
                <select className="input w-auto py-1" value={orden} onChange={(e) => setOrden(e.target.value as OrdenMaterias)} aria-label="Ordenar materias">
                  {ORDENES.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
              </label>
              {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
              {carreras.length <= 1 && <Conteo visibles={lista.length} total={materias.length} nombre="materias" hayFiltro={lista.length !== materias.length} />}
            </div>
            {carreras.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Carrera">
                <ChipFiltro activo={carreraF === ''} onClick={() => setCarreraF('')} conteo={paraCarreras.length}>Todas las carreras</ChipFiltro>
                {carreras.map((c) => (
                  <ChipFiltro key={c.id} activo={carreraF === c.id} color={c.color} titulo={c.nombre} onClick={() => setCarreraF(carreraF === c.id ? '' : c.id)} conteo={paraCarreras.filter((m) => deCarrera(m, c.id)).length}>
                    {c.clave || c.nombre}
                  </ChipFiltro>
                ))}
                <Conteo visibles={lista.length} total={materias.length} nombre="materias" hayFiltro={lista.length !== materias.length} />
              </div>
            )}
            {estadoF !== 'visibles' && ocultas.length > 0 && <p className="text-xs text-ink-500">Las materias ocultas no aparecen en Hoy, Horario ni Estudio IA. Ábrelas o usa «Mostrar» para que vuelvan.</p>}
          </div>
        )}

        {/* Las carreras se acomodan lado a lado: cada una pide el ancho de sus tarjetas, y la que tiene muchas toma su propio renglón */}
        <div className="flex flex-wrap items-start gap-x-6 gap-y-8">
        {porCarrera.map(({ c, ms }) => (
          <section key={c.id} aria-labelledby={`carrera-${c.id}`} className="min-w-0" style={anchoGrupo(ms.length)}>
            {/* Encabezado de un solo renglón: así las tarjetas de carreras vecinas arrancan a la misma altura */}
            <h2 id={`carrera-${c.id}`} className="mb-3 flex min-w-0 items-center gap-x-2" title={c.nombre}>
              <span className="h-3 w-3 shrink-0 rounded" style={{ background: c.color }} aria-hidden />
              <span className="min-w-0 truncate text-lg font-semibold text-ink-900">{c.nombre}</span>
              {c.clave && <span className="shrink-0 text-sm text-ink-400">{c.clave}</span>}
              <span className="shrink-0 whitespace-nowrap text-sm text-ink-400">· {ms.length} {ms.length === 1 ? 'materia' : 'materias'}</span>
              {/* Una carrera creada por error se puede quitar mientras no tenga materias (ni ocultas) */}
              {!materias.some((m) => deCarrera(m, c.id)) && (
                <button
                  className="btn-fantasma ml-auto text-xs text-red-600 hover:bg-red-50"
                  onClick={async () => {
                    if (!confirm(`¿Eliminar la carrera «${c.nombre}»? No tiene materias.`)) return
                    await api.carreras.eliminar(c.id).catch((e) => avisar((e as Error).message, 'error'))
                    cargar()
                  }}
                >
                  Eliminar carrera
                </button>
              )}
            </h2>
            {ms.length === 0 ? (
              <div className="rounded-xl border border-dashed border-ink-200 px-4 py-5 text-sm text-ink-500">
                {materias.some((m) => deCarrera(m, c.id)) ? 'Todas sus materias están ocultas. Elige «Ocultas» o «Todas» arriba para verlas.' : 'Sin materias en esta carrera. Agrégalas con «+ Materia».'}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {ms.map((m) => tarjeta(m, ms, c.id))}
              </div>
            )}
          </section>
        ))}
        {/* Materias de una carrera que ya no está en la lista: que no se pierdan de vista */}
        {(() => {
          const huerfanas = lista.filter((m) => !carreras.some((c) => c.id === m.carrera_id))
          return huerfanas.length > 0 ? (
            <section className="min-w-0" style={anchoGrupo(huerfanas.length)}>
              <h2 className="mb-3 text-lg font-semibold text-ink-500">Sin carrera</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">{huerfanas.map((m) => tarjeta(m, huerfanas, null))}</div>
            </section>
          ) : null
        })()}
        </div>
        {hayFiltro && lista.length === 0 && (
          <div className="tarjeta">
            <SinResultados hayFiltro={hayFiltro} onLimpiar={quitarFiltros} vacio="No hay materias." />
          </div>
        )}
        {carreras.length === 0 && (
          <div className="tarjeta px-5 py-8 text-center">
            <div className="font-medium text-ink-800">Aún no hay carreras ni materias</div>
            <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">Empieza con el periodo (semestre o cuatrimestre), luego la carrera y después sus materias con su temario.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button className="btn-secundario" onClick={() => setModal('periodo')}>+ Periodo</button>
              <button className="btn-primario" onClick={() => setModal('carrera')}>+ Carrera</button>
            </div>
          </div>
        )}
      </div>

      <Modal titulo="Nueva materia" abierto={modal === 'materia'} onCerrar={() => setModal(null)}>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2"><span className="etiqueta">Nombre</span><input className="input" value={form.nombre ?? ''} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder="Álgebra Lineal" /></label>
          <label><span className="etiqueta">Clave</span><input className="input" value={form.clave ?? ''} onChange={(e) => setForm({ ...form, clave: e.target.value })} placeholder="MAT-201" /></label>
          <label><span className="etiqueta">Nivel (semestre/cuatrimestre)</span><input type="number" min={1} max={11} className="input" value={form.cuatrimestre ?? 1} onChange={(e) => setForm({ ...form, cuatrimestre: Number(e.target.value) })} /></label>
          <label><span className="etiqueta">Carrera</span>
            <select className="input" value={form.carrera_id ?? ''} onChange={(e) => setForm({ ...form, carrera_id: Number(e.target.value) })}>{carreras.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
          </label>
          <label><span className="etiqueta">Periodo</span>
            <select className="input" value={form.periodo_id ?? ''} onChange={(e) => setForm({ ...form, periodo_id: Number(e.target.value) })}>{periodos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select>
          </label>
          <label className="col-span-2"><span className="etiqueta">Descripción</span><input className="input" value={form.descripcion ?? ''} onChange={(e) => setForm({ ...form, descripcion: e.target.value })} /></label>
          <label className="col-span-2"><span className="etiqueta">Temario (markdown: ## Unidad, - tema)</span><textarea rows={6} className="input font-mono text-xs" value={form.temario ?? ''} onChange={(e) => setForm({ ...form, temario: e.target.value })} /></label>
          <div className="col-span-2 flex flex-wrap items-center gap-2"><span className="etiqueta">Color</span>{COLORES.map((c, i) => <button key={c} aria-label={`Color ${i + 1} de ${COLORES.length}`} aria-pressed={form.color === c} title={c} className={`w-6 h-6 rounded-full ${form.color === c ? 'ring-2 ring-offset-2 ring-ink-400' : ''}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />)}</div>
        </div>
        <div className="mt-5 flex justify-end gap-2"><button className="btn-secundario" onClick={() => setModal(null)}>Cancelar</button><button className="btn-primario" onClick={guardarMateria}>Guardar</button></div>
      </Modal>

      <Modal titulo="Nueva carrera" abierto={modal === 'carrera'} onCerrar={() => setModal(null)} ancho="max-w-md">
        <div className="space-y-3">
          <label><span className="etiqueta">Nombre</span><input className="input" value={carreraForm.nombre ?? ''} onChange={(e) => setCarreraForm({ ...carreraForm, nombre: e.target.value })} placeholder="Ingeniería en Mecatrónica" /></label>
          <label><span className="etiqueta">Clave</span><input className="input" value={carreraForm.clave ?? ''} onChange={(e) => setCarreraForm({ ...carreraForm, clave: e.target.value })} placeholder="MEC" /></label>
          <div className="flex flex-wrap items-center gap-2"><span className="etiqueta">Color</span>{COLORES.map((c, i) => <button key={c} aria-label={`Color ${i + 1} de ${COLORES.length}`} aria-pressed={carreraForm.color === c} title={c} className={`w-6 h-6 rounded-full ${carreraForm.color === c ? 'ring-2 ring-offset-2 ring-ink-400' : ''}`} style={{ background: c }} onClick={() => setCarreraForm({ ...carreraForm, color: c })} />)}</div>
        </div>
        <div className="mt-5 flex justify-end gap-2"><button className="btn-secundario" onClick={() => setModal(null)}>Cancelar</button><button className="btn-primario" onClick={guardarCarrera}>Guardar</button></div>
      </Modal>

      <Modal titulo="Nuevo periodo (semestre o cuatrimestre)" abierto={modal === 'periodo'} onCerrar={() => setModal(null)} ancho="max-w-md">
        <div className="space-y-3">
          <label><span className="etiqueta">Nombre</span><input className="input" value={periodoForm.nombre ?? ''} onChange={(e) => setPeriodoForm({ ...periodoForm, nombre: e.target.value })} placeholder="Enero - Abril 2027" /></label>
          <label><span className="etiqueta">Lunes de la semana 1</span><input type="date" className="input" value={periodoForm.fecha_inicio ?? ''} onChange={(e) => setPeriodoForm({ ...periodoForm, fecha_inicio: e.target.value })} /></label>
          <label><span className="etiqueta">Semanas</span><input type="number" className="input" value={periodoForm.semanas ?? 15} onChange={(e) => setPeriodoForm({ ...periodoForm, semanas: Number(e.target.value) })} /></label>
          <p className="text-xs text-ink-500">Los periodos existentes: {periodos.map((p) => `${p.nombre}${p.activo ? ' (activo)' : ''}`).join(', ') || 'ninguno'}.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2"><button className="btn-secundario" onClick={() => setModal(null)}>Cancelar</button><button className="btn-primario" onClick={guardarPeriodo}>Guardar</button></div>
      </Modal>
    </div>
  )
}
