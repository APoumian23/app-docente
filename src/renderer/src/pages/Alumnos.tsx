import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import Encabezado from '../components/Encabezado'
import Modal from '../components/Modal'
import ModalPassword from '../components/ModalPassword'
import { avisar } from '../components/Aviso'
import { useRecordado } from '../lib/recordado'
import { Buscador, ChipFiltro, Conteo, EncabezadoOrden, Segmentado, coincide, ordenNatural as comparar, type Orden } from '../components/Filtros'
import type { Alumno, Carrera, Materia } from '@shared/types'

type Estado = 'todos' | 'activos' | 'baja'
type Faltante = '' | 'correo' | 'matricula' | 'carrera' | 'materia'
type Campo = 'apellidos' | 'nombre' | 'matricula' | 'carrera'

export default function Alumnos(): JSX.Element {
  const [alumnos, setAlumnos] = useState<Alumno[]>([])
  const [carreras, setCarreras] = useState<Carrera[]>([])
  const [materias, setMaterias] = useState<Materia[]>([])
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [materiaDestino, setMateriaDestino] = useState('')
  const [carreraDestino, setCarreraDestino] = useState('')
  // Los filtros se recuerdan: al entrar a un alumno y regresar siguen igual
  const [filtro, setFiltro] = useRecordado('alumnos.busqueda', '')
  const [carreraF, setCarreraF] = useRecordado<number | '' | 'sin'>('alumnos.carrera', '')
  const [materiaF, setMateriaF] = useRecordado<number | '' | 'ninguna'>('alumnos.materia', '')
  const [estadoF, setEstadoF] = useRecordado<Estado>('alumnos.estado', 'todos')
  const [faltaF, setFaltaF] = useRecordado<Faltante>('alumnos.falta', '')
  const [orden, setOrden] = useRecordado<Orden<Campo>>('alumnos.orden', { campo: 'apellidos', dir: 1 })
  const [form, setForm] = useState<Partial<Alumno> | null>(null)
  const [borrar, setBorrar] = useState<Alumno | null>(null)

  const cargar = async (): Promise<void> => {
    const [a, c] = await Promise.all([api.alumnos.listar(), api.carreras.listar()])
    setAlumnos(a)
    setCarreras(c)
    api.materias.listar().then(setMaterias)
  }
  const alternar = (id: number): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const inscribirSeleccion = async (): Promise<void> => {
    const m = materias.find((x) => x.id === Number(materiaDestino))
    if (!m || sel.size === 0) return
    try {
      await api.alumnos.inscribir(m.id, [...sel])
      avisar(`${sel.size} alumnos inscritos en ${m.nombre}`)
      setSel(new Set())
      // La columna Materias y el filtro salen de la lista: se recarga para que se vea al momento
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  const cambiarCarreraSeleccion = async (): Promise<void> => {
    const c = carreras.find((x) => x.id === Number(carreraDestino))
    if (!c || sel.size === 0) return
    try {
      await api.alumnos.cambiarCarrera([...sel], c.id)
      avisar(`${sel.size === 1 ? '1 alumno quedó' : `${sel.size} alumnos quedaron`} en ${c.nombre}`)
      setSel(new Set())
      await cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }
  useEffect(() => {
    cargar()
    // Lo que llega de otro lado (portal en línea, otra ventana) aparece al volver a la app
    const alVolver = (): void => void cargar().catch(() => undefined)
    window.addEventListener('focus', alVolver)
    return () => window.removeEventListener('focus', alVolver)
  }, [])

  const guardar = async (): Promise<void> => {
    if (!form?.nombre?.trim()) return avisar('El nombre es obligatorio', 'error')
    try {
      await api.alumnos.guardar(form)
      setForm(null)
      cargar()
    } catch (e) {
      avisar(String((e as Error).message), 'error')
    }
  }
  const importar = async (): Promise<void> => {
    try {
      const r = await api.alumnos.importarExcel(null, typeof carreraF === 'number' ? carreraF : null)
      if (!r.cancelado) avisar(`${r.importados} alumnos importados`)
      cargar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    }
  }

  const nombreMateria = (id: number): Materia | undefined => materias.find((m) => m.id === id)
  const carreraDe = (id: number | null): Carrera | undefined => carreras.find((c) => c.id === id)

  // Cada filtro por separado, para contar cuántos quedan en cada opción con los demás puestos
  const pasa = useMemo(() => {
    return {
      busqueda: (a: Alumno) => coincide(filtro, a.matricula, a.nombre, a.apellidos, a.email),
      carrera: (a: Alumno) => carreraF === '' || (carreraF === 'sin' ? a.carrera_id == null : a.carrera_id === carreraF),
      materia: (a: Alumno) => materiaF === '' || (materiaF === 'ninguna' ? !a.materias?.length : Boolean(a.materias?.includes(materiaF))),
      estado: (a: Alumno) => estadoF === 'todos' || (estadoF === 'activos' ? !!a.activo : !a.activo),
      falta: (a: Alumno) =>
        faltaF === '' ||
        (faltaF === 'correo' ? !a.email?.trim() : faltaF === 'matricula' ? !a.matricula?.trim() : faltaF === 'carrera' ? a.carrera_id == null : !a.materias?.length)
    }
  }, [filtro, carreraF, materiaF, estadoF, faltaF])
  const salvo = (excepto: keyof typeof pasa): Alumno[] => alumnos.filter((a) => (Object.keys(pasa) as (keyof typeof pasa)[]).every((k) => k === excepto || pasa[k](a)))
  const paraCarreras = salvo('carrera')
  const paraEstado = salvo('estado')
  const lista = useMemo(() => {
    const valor = (a: Alumno): string =>
      orden.campo === 'carrera' ? (carreraDe(a.carrera_id)?.clave ?? '~') : orden.campo === 'matricula' ? a.matricula || '~' : orden.campo === 'nombre' ? a.nombre : a.apellidos
    return alumnos
      .filter((a) => Object.values(pasa).every((f) => f(a)))
      .sort((a, b) => orden.dir * (comparar(valor(a), valor(b)) || comparar(a.apellidos, b.apellidos) || comparar(a.nombre, b.nombre)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alumnos, pasa, orden, carreras])
  const hayFiltro = !!filtro.trim() || carreraF !== '' || materiaF !== '' || estadoF !== 'todos' || faltaF !== ''
  const quitarFiltros = (): void => {
    setFiltro('')
    setCarreraF('')
    setMateriaF('')
    setEstadoF('todos')
    setFaltaF('')
  }
  const carrerasConAlumnos = carreras.filter((c) => alumnos.some((a) => a.carrera_id === c.id))
  const sinCarrera = alumnos.filter((a) => a.carrera_id == null).length
  const contarEn = (l: Alumno[], f: (a: Alumno) => boolean): number => l.filter(f).length

  return (
    <div>
      <Encabezado titulo="Alumnos" sub={lista.length === alumnos.length ? `${alumnos.length} en total` : `${lista.length} de ${alumnos.length}`} acciones={<><button className="btn-secundario" onClick={importar}>Importar Excel/CSV</button><button className="btn-primario" onClick={() => setForm({ carrera_id: carreras[0]?.id ?? null, activo: 1 })}>+ Alumno</button></>} />
      <div className="px-4 sm:px-8 py-5 space-y-4">
        {/* Filtros: solo cambian qué alumnos se ven (se recuerdan al entrar a un alumno y regresar) */}
        <div className="tarjeta p-3 space-y-2.5" role="search" aria-label="Filtrar alumnos">
          <div className="flex flex-wrap items-center gap-2">
            <Buscador valor={filtro} onCambio={setFiltro} placeholder="Buscar por matrícula, nombre o correo" etiqueta="Buscar alumnos" />
            <select className="input w-auto max-w-[16rem]" value={materiaF} onChange={(e) => setMateriaF(e.target.value === '' || e.target.value === 'ninguna' ? (e.target.value as '' | 'ninguna') : Number(e.target.value))} aria-label="Filtrar por materia">
              <option value="">Todas las materias</option>
              {materias.map((m) => <option key={m.id} value={m.id}>{m.nombre} ({alumnos.filter((a) => a.materias?.includes(m.id)).length})</option>)}
              <option value="ninguna">Sin materia ({alumnos.filter((a) => !a.materias?.length).length})</option>
            </select>
            <Segmentado
              etiqueta="Estado"
              valor={estadoF}
              onCambio={setEstadoF}
              opciones={([['todos', 'Todos'], ['activos', 'Activos'], ['baja', 'De baja']] as [Estado, string][]).map(([k, t]) => ({ valor: k, texto: t, conteo: contarEn(paraEstado, (a) => (k === 'todos' ? true : k === 'activos' ? !!a.activo : !a.activo)) }))}
            />
            <select className={`input w-auto ${faltaF ? 'border-amber-300 bg-amber-50 text-amber-900' : ''}`} value={faltaF} onChange={(e) => setFaltaF(e.target.value as Faltante)} aria-label="Datos que faltan">
              <option value="">Datos completos o no</option>
              <option value="correo">Sin correo ({alumnos.filter((a) => !a.email?.trim()).length})</option>
              <option value="matricula">Sin matrícula ({alumnos.filter((a) => !a.matricula?.trim()).length})</option>
              <option value="carrera">Sin carrera ({sinCarrera})</option>
              <option value="materia">Sin materia ({alumnos.filter((a) => !a.materias?.length).length})</option>
            </select>
            {hayFiltro && <button className="btn-fantasma text-xs" onClick={quitarFiltros}>Quitar filtros</button>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Carrera">
            <ChipFiltro activo={carreraF === ''} onClick={() => setCarreraF('')} conteo={paraCarreras.length}>Todas las carreras</ChipFiltro>
            {carrerasConAlumnos.map((c) => (
              <ChipFiltro key={c.id} activo={carreraF === c.id} color={c.color} titulo={c.nombre} onClick={() => setCarreraF(carreraF === c.id ? '' : c.id)} conteo={contarEn(paraCarreras, (a) => a.carrera_id === c.id)}>
                {c.clave}
              </ChipFiltro>
            ))}
            {sinCarrera > 0 && (
              <ChipFiltro activo={carreraF === 'sin'} onClick={() => setCarreraF(carreraF === 'sin' ? '' : 'sin')} conteo={contarEn(paraCarreras, (a) => a.carrera_id == null)}>
                Sin carrera
              </ChipFiltro>
            )}
            <Conteo visibles={lista.length} total={alumnos.length} nombre="alumnos" hayFiltro={hayFiltro} />
          </div>
        </div>
        {/* Acciones con lo marcado: solo aparecen al marcar alumnos, para no confundirse con los filtros */}
        {sel.size > 0 && (
          <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-brand-400/40 bg-white px-4 py-2.5 text-sm shadow-md">
            <span className="font-semibold text-ink-800">{sel.size === 1 ? '1 alumno marcado' : `${sel.size} alumnos marcados`}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select className="input w-auto max-w-[16rem] py-1" value={materiaDestino} onChange={(e) => setMateriaDestino(e.target.value)} aria-label="Materia donde inscribir">
                <option value="">Inscribir en materia…</option>
                {materias.map((m) => <option key={m.id} value={m.id}>{m.nombre}{m.oculta ? ' (oculta)' : ''}</option>)}
              </select>
              <button className="btn-primario py-1" disabled={!materiaDestino} onClick={inscribirSeleccion}>Inscribir</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select className="input w-auto max-w-[16rem] py-1" value={carreraDestino} onChange={(e) => setCarreraDestino(e.target.value)} aria-label="Carrera nueva">
                <option value="">Cambiar carrera a…</option>
                {carreras.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
              <button className="btn-secundario py-1" disabled={!carreraDestino} onClick={cambiarCarreraSeleccion}>Cambiar</button>
            </div>
            <button className="btn-fantasma ml-auto py-1" onClick={() => setSel(new Set())}>Quitar selección</button>
          </div>
        )}
        <div className="tarjeta relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Marcar todos los que se ven"
                    title="Marcar todos los que se ven"
                    checked={lista.length > 0 && lista.every((a) => sel.has(a.id))}
                    ref={(el) => {
                      if (el) el.indeterminate = lista.some((a) => sel.has(a.id)) && !lista.every((a) => sel.has(a.id))
                    }}
                    onChange={(e) => setSel(e.target.checked ? new Set(lista.map((a) => a.id)) : new Set())}
                  />
                </th>
                <EncabezadoOrden campo="matricula" orden={orden} onOrden={setOrden}>Matrícula</EncabezadoOrden>
                <EncabezadoOrden campo="apellidos" orden={orden} onOrden={setOrden}>Apellidos</EncabezadoOrden>
                <EncabezadoOrden campo="nombre" orden={orden} onOrden={setOrden} className="hidden lg:table-cell">Nombre</EncabezadoOrden>
                <th className="hidden px-3 py-2 xl:table-cell">Correo</th>
                <EncabezadoOrden campo="carrera" orden={orden} onOrden={setOrden}>Carrera</EncabezadoOrden>
                <th className="px-3 py-2">Materias</th>
                <th className="px-3 py-2"><span className="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {lista.map((a) => {
                const c = carreraDe(a.carrera_id)
                const marcado = sel.has(a.id)
                const iniciales = `${a.nombre.trim()[0] ?? ''}${a.apellidos.trim()[0] ?? ''}`.toUpperCase()
                return (
                  <tr key={a.id} className={`group transition-colors ${marcado ? 'bg-brand-500/5' : 'hover:bg-ink-50/70'}`}>
                    <td className="px-3 py-2"><input type="checkbox" checked={marcado} onChange={() => alternar(a.id)} aria-label={`Marcar a ${a.nombre} ${a.apellidos}`} /></td>
                    <td className={`px-3 py-2 font-mono text-xs ${a.activo ? 'text-ink-700' : 'text-ink-400'}`}>{a.matricula || <span className="font-sans text-amber-600">Sin matrícula</span>}</td>
                    <td className="px-3 py-2">
                      <Link to={`/alumnos/${a.id}`} className="flex items-center gap-2.5 font-medium">
                        {/* Iniciales con el color de su carrera: en grupos mixtos se distingue de un vistazo */}
                        <span
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                          style={c ? { color: c.color, backgroundColor: `${c.color}1a` } : undefined}
                          aria-hidden
                        >
                          {iniciales}
                        </span>
                        <span className="min-w-0">
                          <span className={`hover:underline ${a.activo ? 'text-brand-600' : 'text-ink-400'}`}>{a.apellidos || '(sin apellidos)'}</span>
                          {/* En ventana angosta el nombre y el correo van aquí debajo, en lugar de sus columnas */}
                          <span className="block text-xs font-normal text-ink-500 lg:hidden">{a.nombre}</span>
                          <span className="block truncate text-xs font-normal text-ink-400 xl:hidden">{a.email || <span className="text-amber-600">Sin correo</span>}</span>
                        </span>
                        {!a.activo && <span className="chip shrink-0 whitespace-nowrap bg-ink-100 text-ink-500">De baja</span>}
                      </Link>
                    </td>
                    <td className={`hidden px-3 py-2 lg:table-cell ${a.activo ? 'text-ink-800' : 'text-ink-400'}`}><Link to={`/alumnos/${a.id}`} className="hover:underline">{a.nombre}</Link></td>
                    <td className="hidden max-w-[15rem] truncate whitespace-nowrap px-3 py-2 text-ink-500 xl:table-cell" title={a.email}>{a.email || <span className="text-amber-600">Sin correo</span>}</td>
                    <td className="px-3 py-2">
                      {c ? (
                        <span className="chip border font-semibold" style={{ color: c.color, borderColor: `${c.color}55`, backgroundColor: `${c.color}14` }} title={c.nombre}>{c.clave}</span>
                      ) : (
                        <span className="chip whitespace-nowrap bg-amber-50 text-amber-700">Sin carrera</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(a.materias ?? []).map((id) => {
                          const m = nombreMateria(id)
                          return m ? <span key={id} className="chip whitespace-nowrap text-white" style={{ backgroundColor: m.color }} title={m.nombre}>{m.clave || m.nombre}</span> : null
                        })}
                        {!a.materias?.length && <span className="text-xs text-ink-400">Sin materia</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {/* Se ven al pasar el mouse o al llegar con el teclado: el nombre ya abre su ficha */}
                      <div className="inline-flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                        <button className="btn-fantasma text-xs" onClick={() => setForm(a)}>Editar</button>
                        <button className="btn-fantasma text-xs text-red-600 hover:bg-red-50" onClick={() => setBorrar(a)}>Eliminar</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {lista.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-ink-500">
                    {hayFiltro ? (
                      <>
                        <div className="font-medium text-ink-700">Ningún alumno coincide</div>
                        <button className="btn-secundario mt-3" onClick={quitarFiltros}>Quitar filtros</button>
                      </>
                    ) : (
                      'Todavía no hay alumnos. Impórtalos de Excel o agrégalos con «+ Alumno».'
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <details className="text-xs text-ink-500">
          <summary className="cursor-pointer select-none font-medium text-ink-600 hover:text-ink-800">¿Cómo debe venir el Excel para importar?</summary>
          <p className="mt-1.5 max-w-3xl">Se aceptan listas con título antes del encabezado y columnas <code>matrícula, apellidos, nombre, correo</code> en cualquier orden (o una sola columna con apellidos y nombre). La matrícula es opcional. Importar desde aquí solo registra; para que aparezcan en el pase de lista hay que inscribirlos en la materia (marcándolos aquí, o desde la materia o el Modo clase).</p>
        </details>
      </div>
      <ModalPassword
        abierto={!!borrar}
        titulo={`Eliminar a ${borrar?.nombre ?? ''} ${borrar?.apellidos ?? ''}`}
        advertencia="Se borran también sus asistencias, entregas y calificaciones en todas las materias. Esta acción no se puede deshacer."
        textoBoton="Eliminar alumno"
        onCerrar={() => setBorrar(null)}
        onConfirmar={async (password) => {
          await api.alumnos.eliminar(borrar!.id, password)
          avisar('Alumno eliminado')
          cargar()
        }}
      />
      <Modal titulo={form?.id ? 'Editar alumno' : 'Nuevo alumno'} abierto={!!form} onCerrar={() => setForm(null)} ancho="max-w-md">
        {form && (
          <div className="space-y-3">
            <label><span className="etiqueta">Matrícula (opcional)</span><input className="input" value={form.matricula ?? ''} onChange={(e) => setForm({ ...form, matricula: e.target.value })} placeholder="Se puede dejar vacía" /></label>
            <label><span className="etiqueta">Nombre(s)</span><input className="input" value={form.nombre ?? ''} onChange={(e) => setForm({ ...form, nombre: e.target.value })} /></label>
            <label><span className="etiqueta">Apellidos</span><input className="input" value={form.apellidos ?? ''} onChange={(e) => setForm({ ...form, apellidos: e.target.value })} /></label>
            <label><span className="etiqueta">Correo</span><input className="input" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label><span className="etiqueta">Carrera</span><select className="input" value={form.carrera_id ?? ''} onChange={(e) => setForm({ ...form, carrera_id: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{carreras.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!form.activo} onChange={(e) => setForm({ ...form, activo: e.target.checked ? 1 : 0 })} /> Activo</label>
            <div className="flex justify-end gap-2"><button className="btn-secundario" onClick={() => setForm(null)}>Cancelar</button><button className="btn-primario" onClick={guardar}>Guardar</button></div>
          </div>
        )}
      </Modal>
    </div>
  )
}
