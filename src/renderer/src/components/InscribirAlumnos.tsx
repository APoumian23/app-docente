import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import Modal from './Modal'
import { avisar } from './Aviso'
import type { Alumno } from '@shared/types'

interface Props {
  abierto: boolean
  materiaId: number
  materiaNombre: string
  carreraId: number | null
  inscritos: number[]
  onCerrar: () => void
  onListo: () => void
}

/**
 * Elige alumnos ya registrados y los inscribe en una materia. Los de la misma carrera van
 * primero y se pueden marcar de un golpe: es el caso normal al empezar el periodo.
 */
export default function InscribirAlumnos({ abierto, materiaId, materiaNombre, carreraId, inscritos, onCerrar, onListo }: Props): JSX.Element {
  const [todos, setTodos] = useState<Alumno[]>([])
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [filtro, setFiltro] = useState('')
  const [ocupado, setOcupado] = useState(false)

  // La lista se arma al abrir. Se depende del contenido de `inscritos`, no del arreglo: el padre
  // puede crear uno nuevo en cada render (p. ej. con el reloj de clase corriendo) y eso borraba la búsqueda
  const claveInscritos = inscritos.join(',')
  useEffect(() => {
    if (!abierto) return
    const ya = new Set(claveInscritos ? claveInscritos.split(',').map(Number) : [])
    api.alumnos.listar().then((lista) => {
      const libres = lista.filter((a) => a.activo && !ya.has(a.id))
      setTodos(libres)
      // Los de la carrera de la materia se proponen marcados: casi siempre son exactamente el grupo
      setSel(new Set(libres.filter((a) => carreraId !== null && a.carrera_id === carreraId).map((a) => a.id)))
      setFiltro('')
    })
  }, [abierto, carreraId, claveInscritos])

  const visibles = useMemo(() => {
    const f = filtro.toLowerCase()
    return todos
      .filter((a) => `${a.matricula} ${a.nombre} ${a.apellidos}`.toLowerCase().includes(f))
      .sort((a, b) => Number(b.carrera_id === carreraId) - Number(a.carrera_id === carreraId) || a.apellidos.localeCompare(b.apellidos))
  }, [todos, filtro, carreraId])

  const alternar = (id: number): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const marcarVisibles = (on: boolean): void => setSel((s) => {
    const n = new Set(s)
    visibles.forEach((a) => (on ? n.add(a.id) : n.delete(a.id)))
    return n
  })

  const inscribir = async (): Promise<void> => {
    if (sel.size === 0) return
    setOcupado(true)
    try {
      await api.alumnos.inscribir(materiaId, [...sel])
      avisar(`${sel.size} alumnos inscritos en ${materiaNombre}`)
      onListo()
      onCerrar()
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setOcupado(false)
    }
  }

  return (
    <Modal titulo={`Inscribir alumnos en ${materiaNombre}`} abierto={abierto} onCerrar={onCerrar} ancho="max-w-2xl">
      {todos.length === 0 ? (
        <p className="text-sm text-ink-500">No hay alumnos registrados que falten por inscribir. Regístralos primero en Alumnos (+ Alumno o Importar Excel/CSV).</p>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <input className="input flex-1" placeholder="Buscar…" value={filtro} onChange={(e) => setFiltro(e.target.value)} autoFocus />
            <button className="btn-fantasma text-xs" onClick={() => marcarVisibles(true)}>Marcar todos</button>
            <button className="btn-fantasma text-xs" onClick={() => marcarVisibles(false)}>Ninguno</button>
          </div>
          <ul className="max-h-80 overflow-auto divide-y divide-ink-100 rounded-lg border border-ink-200">
            {visibles.map((a) => (
              <li key={a.id}>
                <label className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-ink-50">
                  <input type="checkbox" checked={sel.has(a.id)} onChange={() => alternar(a.id)} />
                  <span className="font-mono text-xs w-20 text-ink-500">{a.matricula || '—'}</span>
                  <span className="flex-1">{a.apellidos} {a.nombre}</span>
                  {carreraId !== null && a.carrera_id !== carreraId && <span className="text-xs text-ink-400">otra carrera</span>}
                </label>
              </li>
            ))}
            {visibles.length === 0 && <li className="px-3 py-4 text-sm text-ink-500">Sin coincidencias.</li>}
          </ul>
          <div className="flex justify-between items-center gap-2">
            <span className="text-xs text-ink-500">{sel.size} seleccionados</span>
            <div className="flex gap-2">
              <button className="btn-secundario" onClick={onCerrar}>Cancelar</button>
              <button className="btn-primario" disabled={ocupado || sel.size === 0} onClick={inscribir}>Inscribir {sel.size > 0 ? `(${sel.size})` : ''}</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
