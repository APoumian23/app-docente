import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, fechaMx } from '../../lib/api'
import { Boton, Cargando, Chip, EncabezadoPagina, ErrorCarga, Tarjeta, Vacio, aFecha, urgencia } from '../../componentes/ui'
import { FilaChips, ResumenFiltros, SinResultados, useRecordado } from '../../componentes/Filtros'
import type { AsignacionParaAlumno, Notificacion } from '@shared/portal'
import { ProximasFechas } from './Calendario'
import { InvitacionNotificaciones } from '../../componentes/Notificar'
import type { TipoEvaluacion } from '@shared/types'

const TIPOS: Record<TipoEvaluacion, string> = {
  diagnostico: 'Diagnóstico',
  examen: 'Examen',
  examen_sorpresa: 'Examen sorpresa',
  examen_oral: 'Examen oral',
  cuestionario: 'Cuestionario',
  tarea: 'Tarea',
  ejercicios: 'Ejercicios',
  ejemplos: 'Ejemplos',
  glosario: 'Glosario',
  material_apoyo: 'Material de apoyo',
  clase_completa: 'Clase completa',
  plan_sesion: 'Plan de sesión',
  presentacion: 'Presentación',
  apuntes: 'Apuntes'
}

/** Nombre legible del tipo de evaluación. */
export const etiquetaTipo = (t: TipoEvaluacion): string => TIPOS[t] ?? t

/** Puntos con hasta dos decimales, sin ceros de sobra. */
export const puntos = (n: number | null | undefined): string => Number(n ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 2 })

type Seccion = 'pendientes' | 'entregadas' | 'cerradas'

/** En qué apartado va cada asignación según la ventana y el intento del alumno. */
function seccionDe(a: AsignacionParaAlumno): Seccion {
  const e = a.intento?.estado
  if (e === 'enviado' || e === 'calificado') return 'entregadas'
  if (a.abierta) return 'pendientes'
  return 'cerradas'
}

function estadoDe(a: AsignacionParaAlumno): { texto: string; tono: 'gris' | 'verde' | 'ambar' | 'azul' | 'morado' } {
  switch (a.intento?.estado) {
    case 'en_curso':
      return { texto: 'En curso', tono: 'azul' }
    case 'borrador':
      return { texto: 'Borrador guardado', tono: 'morado' }
    case 'enviado':
      return { texto: a.intento.pendiente_manual ? 'Enviada · pendiente de revisión' : 'Enviada', tono: 'verde' }
    case 'calificado':
      return { texto: 'Calificada', tono: 'verde' }
    default:
      return { texto: 'Sin empezar', tono: 'gris' }
  }
}

function accionDe(a: AsignacionParaAlumno, seccion: Seccion): string {
  if (seccion === 'entregadas') return 'Ver resultado'
  if (seccion === 'cerradas') return 'Ver detalles'
  return a.intento ? 'Continuar' : 'Empezar'
}

const SECCIONES: { clave: Seccion; titulo: string; vacio: string }[] = [
  { clave: 'pendientes', titulo: 'Pendientes', vacio: 'No tienes actividades pendientes.' },
  { clave: 'entregadas', titulo: 'Entregadas', vacio: 'Todavía no has entregado ninguna actividad.' },
  { clave: 'cerradas', titulo: 'Cerradas', vacio: 'Ninguna actividad cerrada.' }
]

function TarjetaActividad({ a }: { a: AsignacionParaAlumno }): JSX.Element {
  const nav = useNavigate()
  const seccion = seccionDe(a)
  const estado = estadoDe(a)
  // Solo lo que se puede contestar todavía avisa que está por cerrar
  const prisa = seccion === 'pendientes' ? urgencia(a.cierra) : null
  return (
    <Tarjeta className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-1.5 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: a.materia_color || '#7c8ba3' }} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold uppercase tracking-wide text-ink-500">{a.materia_nombre ?? 'Materia'}</div>
          <h3 className="break-words font-semibold leading-snug text-ink-900">{a.titulo}</h3>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {prisa ? <Chip tono={prisa.tono}>{prisa.texto}</Chip> : null}
        <Chip tono="azul">{etiquetaTipo(a.tipo)}</Chip>
        {a.vigilancia ? <Chip tono="ambar">Con vigilancia</Chip> : null}
        <Chip tono={estado.tono}>{estado.texto}</Chip>
      </div>

      <dl className="space-y-0.5 text-sm text-ink-700">
        <div className="flex flex-wrap gap-x-1">
          <dt className="text-ink-500">Cierra:</dt>
          <dd className={`break-words ${prisa?.tono === 'rojo' ? 'font-semibold text-red-700' : ''}`}>{a.cierra ? fechaMx(a.cierra) : 'sin fecha límite'}</dd>
        </div>
        {a.duracion_min ? (
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-ink-500">Duración:</dt>
            <dd>{a.duracion_min} min desde que empiezas</dd>
          </div>
        ) : null}
        {a.puntos_totales ? (
          <div className="flex flex-wrap gap-x-1">
            <dt className="text-ink-500">Vale:</dt>
            <dd>{puntos(a.puntos_totales)} pts</dd>
          </div>
        ) : null}
        {seccion === 'cerradas' && a.motivo_cierre ? <div className="break-words pt-1 text-red-700">{a.motivo_cierre}</div> : null}
      </dl>

      {/* El botón de la tarjeta debe ser el primero dentro de ella (las pruebas en celular lo buscan así) */}
      <Boton variante={seccion === 'pendientes' ? 'primario' : 'secundario'} className="w-full min-h-[48px] text-base" onClick={() => nav(`/actividad/${a.id}`)}>
        {accionDe(a, seccion)}
      </Boton>
    </Tarjeta>
  )
}

/** Avisos del docente sin leer: arriba de todo hasta que el alumno los marque como leídos. */
function AvisosDocente(): JSX.Element | null {
  const [avisos, setAvisos] = useState<Notificacion[]>([])
  useEffect(() => {
    api<Notificacion[]>('/notificaciones?no_leidas=1')
      .then((n) => setAvisos(n.filter((x) => x.tipo === 'aviso')))
      .catch(() => undefined)
  }, [])
  const entendido = (id: number): void => {
    setAvisos((a) => a.filter((x) => x.id !== id))
    void api('/notificaciones/leidas', { metodo: 'POST', cuerpo: { ids: [id] } }).catch(() => undefined)
  }
  if (!avisos.length) return null
  return (
    <div className="space-y-2">
      {avisos.map((a) => (
        <div key={a.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <span className="text-xl leading-none" aria-hidden>📣</span>
            <div className="min-w-0 flex-1">
              <div className="break-words font-semibold text-ink-900">{a.titulo}</div>
              <div className="mt-0.5 whitespace-pre-line break-words text-sm text-ink-700">{a.cuerpo}</div>
              <div className="mt-1 text-xs text-ink-400">{fechaMx(a.creada)}</div>
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <Boton variante="secundario" onClick={() => entendido(a.id)}>Entendido</Boton>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Lo que cierra antes va primero; sin fecha límite, al final. */
const porCierre = (a: AsignacionParaAlumno, b: AsignacionParaAlumno): number =>
  (aFecha(a.cierra)?.getTime() ?? Infinity) - (aFecha(b.cierra)?.getTime() ?? Infinity)

/** Actividades del alumno agrupadas: lo que puede contestar ahora, lo que ya entregó y lo que se cerró sin entrega. */
export default function Actividades(): JSX.Element {
  const [lista, setLista] = useState<AsignacionParaAlumno[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)
  const [materia, setMateria] = useRecordado<string>('actividades.materia', 'todas')

  const cargar = useCallback((): void => {
    setCargando(true)
    setError(null)
    api<AsignacionParaAlumno[]>('/alumno/asignaciones')
      .then(setLista)
      .catch((e: Error) => setError(e.message))
      .finally(() => setCargando(false))
  }, [])
  useEffect(cargar, [cargar])

  // Materias con actividades, con cuántas tiene pendientes cada una
  const materias = useMemo(() => {
    const m = new Map<string, { nombre: string; color?: string; total: number }>()
    for (const a of lista ?? []) {
      const clave = String(a.materia_id)
      const g = m.get(clave) ?? { nombre: a.materia_nombre ?? 'Materia', color: a.materia_color, total: 0 }
      g.total++
      m.set(clave, g)
    }
    return [...m.entries()].sort((x, y) => x[1].nombre.localeCompare(y[1].nombre, 'es'))
  }, [lista])
  // Un filtro recordado de una materia que ya no aparece no debe dejar la lista vacía
  const materiaEf = materia !== 'todas' && materias.some(([id]) => id === materia) ? materia : 'todas'
  const visibles = (lista ?? []).filter((a) => materiaEf === 'todas' || String(a.materia_id) === materiaEf)
  const hayFiltro = materiaEf !== 'todas'

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <EncabezadoPagina titulo="Mis actividades">
        <Boton variante="fantasma" onClick={cargar} disabled={cargando} aria-label="Recargar actividades">
          <span aria-hidden>↻</span> Recargar
        </Boton>
      </EncabezadoPagina>

      <AvisosDocente />
      <InvitacionNotificaciones />
      <ProximasFechas />

      {error && <ErrorCarga titulo="No se pudieron cargar tus actividades" detalle={error} onReintentar={cargar} />}

      {!lista && !error && <Cargando texto="Cargando tus actividades…" />}

      {lista && lista.length === 0 && !error && <Vacio icono="📝" titulo="Aún no tienes actividades" detalle="Cuando tu docente publique una tarea o examen aparecerá aquí." />}

      {lista && lista.length > 0 && materias.length > 1 && (
        <div className="space-y-1">
          <FilaChips
            etiqueta="Filtrar por materia"
            valor={materiaEf}
            onCambio={setMateria}
            opciones={[{ valor: 'todas', texto: 'Todas las materias', conteo: lista.length }, ...materias.map(([id, g]) => ({ valor: id, texto: g.nombre, color: g.color || '#7c8ba3', conteo: g.total }))]}
          />
          {hayFiltro && <ResumenFiltros visibles={visibles.length} total={lista.length} nombre={['actividad', 'actividades']} hayFiltro onLimpiar={() => setMateria('todas')} />}
        </div>
      )}

      {lista && lista.length > 0 && visibles.length === 0 && <SinResultados onLimpiar={() => setMateria('todas')} detalle="Esa materia no tiene actividades." />}

      {visibles.length > 0 &&
        SECCIONES.map((s) => {
          const grupo = visibles.filter((a) => seccionDe(a) === s.clave)
          // Lo que está por cerrar, arriba
          if (s.clave === 'pendientes') grupo.sort(porCierre)
          const encabezado = (
            <>
              {s.titulo}
              <span className="rounded-full bg-ink-200/70 px-2 py-0.5 text-xs text-ink-700">{grupo.length}</span>
            </>
          )
          // Las cerradas sin entrega casi no se consultan: van plegadas para no empujar lo importante
          if (s.clave === 'cerradas')
            return grupo.length === 0 ? null : (
              <details key={s.clave} className="group space-y-3">
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-500 [&::-webkit-details-marker]:hidden">
                  {encabezado}
                  <span className="ml-auto text-base normal-case transition-transform duration-150 group-open:rotate-180" aria-hidden>⌄</span>
                </summary>
                <div className="space-y-3 pt-1">
                  {grupo.map((a) => <TarjetaActividad key={a.id} a={a} />)}
                </div>
              </details>
            )
          return (
            <section key={s.clave} className="space-y-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-500">{encabezado}</h3>
              {grupo.length === 0 ? <div className="rounded-xl border border-dashed border-ink-200 px-3 py-4 text-center text-sm text-ink-500">{s.vacio}</div> : grupo.map((a) => <TarjetaActividad key={a.id} a={a} />)}
            </section>
          )
        })}
    </div>
  )
}
