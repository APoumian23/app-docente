import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, descargar, duracion, fechaMx, type ErrorApi } from '../../lib/api'
import { calificacionExamen } from '../../lib/calificacion'
import { useSesion } from '../../lib/sesion'
import { ColaGuardado, borrarLocal, esperaReintento, escribirLocal, huella, leerLocal, type EstadoCola, type TipoFallo } from '../../lib/colaGuardado'
import { Boton, Cargando, Chip, Modal, Tarjeta, Vacio, avisar } from '../../componentes/ui'
import { MarcaDeAgua, vigilancia } from '../../componentes/Proteccion'
import Markdown from '../../componentes/Markdown'
import Codigo from '../../componentes/Codigo'
import type { ArchivoEntrega, AsignacionParaAlumno, Intento, PreguntaAlumno, PreguntaRevisada, TipoEventoIntegridad } from '@shared/portal'
import { etiquetaTipo, puntos } from './Actividades'

// El cuaderno trae Python y su editor: solo se descarga si el examen tiene uno
const EditorCuaderno = lazy(() => import('../../componentes/EditorCuaderno'))

// ---------- Utilidades ----------

/** Fecha guardada en UTC sin zona ("YYYY-MM-DD HH:MM:SS") a Date, con el mismo criterio que fechaMx al mostrar. */
function aFecha(texto: string): Date {
  const t = texto.trim()
  return new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z')
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const tamano = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

/** Abre o descarga un archivo que subió el alumno (el servidor solo se lo da a su dueño). */
async function abrirArchivo(f: ArchivoEntrega): Promise<void> {
  try {
    await descargar(`/archivos/${f.id}`, f.nombre)
  } catch (e) {
    avisar(`No se pudo abrir ${f.nombre}: ${(e as Error).message}`, 'error')
  }
}

/** Esperar un guardado sin dejar al alumno atorado: si la red no responde, se sale con el respaldo del teléfono. */
const ESPERA_SALIR_MS = 6000

const horaMx = (d: Date): string => new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit' }).format(d)

/**
 * Petición que sobrevive al cierre o cambio de pestaña. sendBeacon no permite el encabezado
 * Authorization, así que se usa fetch con keepalive. No espera respuesta.
 */
function enviarConKeepalive(ruta: string, metodo: 'PUT' | 'POST', cuerpo: unknown): void {
  const token = useSesion.getState().token
  if (!token) return
  try {
    void fetch(`/api${ruta}`, { method: metodo, keepalive: true, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) }).catch(() => undefined)
  } catch {
    /* sin red: no hay nada más que hacer al salir */
  }
}

/**
 * Mientras el navegador entra a pantalla completa (en Mac cambia de escritorio con una animación), la página
 * pierde el foco o queda oculta un instante: eso no es salirse del examen. Hasta esta hora no se cuenta.
 */
let entrandoAPantallaHasta = 0
const DETALLE_ENTRADA = 'al entrar a pantalla completa'

/** true si quedó en pantalla completa. Algunos navegadores ni rechazan ni la conceden: se revisa al segundo. */
async function pedirPantallaCompleta(): Promise<boolean> {
  const raiz = document.documentElement
  if (document.fullscreenElement) return true
  entrandoAPantallaHasta = Date.now() + 3000
  if (typeof raiz.requestFullscreen !== 'function') return false
  try {
    // Hay navegadores incrustados que ni la conceden ni la niegan: la promesa se queda pendiente para siempre
    await Promise.race([raiz.requestFullscreen(), new Promise((r) => setTimeout(r, 1500))])
  } catch {
    /* el navegador no lo permite; se revisa abajo */
  }
  if (!document.fullscreenElement) await new Promise((r) => setTimeout(r, 1000))
  if (document.fullscreenElement) bloquearEsc()
  return Boolean(document.fullscreenElement)
}

/**
 * En Chrome, Edge y Opera (de computadora) se puede «capturar» Esc durante la pantalla completa: un toque ya no
 * la quita; para salir hay que mantenerlo presionado unos segundos (lo indica el propio navegador). Firefox y
 * Safari no lo permiten: ahí Esc siempre saca y solo se puede registrar.
 */
function bloquearEsc(): void {
  const teclado = (navigator as Navigator & { keyboard?: { lock?: (teclas?: string[]) => Promise<void> } }).keyboard
  teclado?.lock?.(['Escape']).catch(() => undefined)
}

/** El navegador deja capturar Esc (Chrome, Edge, Opera de computadora) */
export const escSePuedeCapturar = (): boolean => typeof (navigator as Navigator & { keyboard?: { lock?: unknown } }).keyboard?.lock === 'function'

/** iPhone y iPad (también el iPad que se presenta como Mac): el teclado saca de pantalla completa. */
function esAppleMovil(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

const enCurso = (i: Intento): boolean => i.estado === 'en_curso' || i.estado === 'borrador'
const entregado = (i: Intento): boolean => i.estado === 'enviado' || i.estado === 'calificado'
const respondida = (valor: string | undefined): boolean => Boolean(valor && valor.trim())

const TIPO_PREGUNTA: Record<PreguntaAlumno['tipo'], string> = { opcion_multiple: 'Opción múltiple', verdadero_falso: 'Verdadero o falso', abierta: 'Respuesta abierta', problema: 'Problema', codigo: 'Código', cuaderno: 'Cuaderno de Jupyter' }

// ---------- Piezas de pantalla ----------

function Encabezado({ asig }: { asig: AsignacionParaAlumno }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: asig.materia_color || '#7c8ba3' }} aria-hidden />
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-ink-400">{asig.materia_nombre ?? 'Materia'}</span>
      </div>
      <h1 className="mt-1 break-words text-xl font-bold leading-snug text-ink-900">{asig.titulo}</h1>
    </div>
  )
}

/** Pantalla de un solo mensaje (error, cierre, tiempo agotado) con salida a la lista. */
function PantallaMensaje({ titulo, texto, reintentar }: { titulo: string; texto: string; reintentar?: () => void }): JSX.Element {
  const nav = useNavigate()
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-ink-50 p-4">
      <Tarjeta className="w-full max-w-md space-y-4">
        <h1 className="text-lg font-bold text-ink-900">{titulo}</h1>
        <p className="break-words text-sm text-ink-600">{texto}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          {reintentar && <Boton variante="secundario" className="flex-1" onClick={reintentar}>Intentar de nuevo</Boton>}
          <Boton className="flex-1" onClick={() => nav('/')}>Volver a mis actividades</Boton>
        </div>
      </Tarjeta>
    </div>
  )
}

function PantallaInicio({ asig, iniciando, comenzar }: { asig: AsignacionParaAlumno; iniciando: boolean; comenzar: () => void }): JSX.Element {
  const nav = useNavigate()
  const reglas: string[] = []
  reglas.push(asig.duracion_min ? `Tienes ${asig.duracion_min} minutos desde que pulses Comenzar; el tiempo no se detiene si sales.` : 'Sin límite de tiempo por intento.')
  reglas.push(asig.cierra ? `Debes enviarla antes del ${fechaMx(asig.cierra)}.` : 'No tiene fecha límite de entrega.')
  reglas.push(asig.permite_borrador ? 'Puedes guardar un borrador y volver después.' : 'No se puede guardar borrador: una vez que empieces, termina y envía.')
  reglas.push(asig.permite_archivos ? 'Admite archivos adjuntos (hasta 25 MB cada uno).' : 'No admite archivos adjuntos.')
  if (asig.todas_obligatorias) reglas.push('Debes contestar todas las preguntas para poder enviar.')
  reglas.push(asig.mostrar_resultado ? 'Verás tu resultado al terminar.' : 'El resultado lo dará a conocer el docente.')
  if (asig.puntos_totales) reglas.push(`Vale ${puntos(asig.puntos_totales)} puntos.`)

  return (
    <div className="min-h-[100dvh] bg-ink-50">
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 pb-8">
        {/* Con la pantalla bloqueada no hay a dónde volver: el portal lo regresa aquí hasta que envíe */}
        {asig.bloqueado ? null : (
          <button className="inline-flex min-h-[44px] items-center gap-1 text-sm text-ink-500 hover:text-ink-800" onClick={() => nav('/')}>
            <span aria-hidden>←</span> Mis actividades
          </button>
        )}
        <Tarjeta className="space-y-4">
          <Encabezado asig={asig} />
          <div className="flex flex-wrap gap-1.5">
            <Chip tono="azul">{etiquetaTipo(asig.tipo)}</Chip>
            {asig.bloqueado ? <Chip tono="rojo">🔒 Pantalla bloqueada</Chip> : null}
            {asig.vigilancia ? <Chip tono="ambar">Con vigilancia</Chip> : null}
          </div>
          {asig.instrucciones.trim() ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Instrucciones</div>
              <Markdown texto={asig.instrucciones} />
            </div>
          ) : null}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Reglas</div>
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-700">
              {reglas.map((r) => (
                <li key={r} className="break-words">{r}</li>
              ))}
            </ul>
          </div>
          {asig.vigilancia ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">Actividad con vigilancia</div>
              <p className="mt-1">Durante esta actividad se registra si sales de esta pantalla, cambias de pestaña o de aplicación. Al comenzar se abrirá en pantalla completa.</p>
              {/* Firefox y Safari no dejan capturar Esc: ahí un toque saca de pantalla completa y cuenta como salida */}
              {!escSePuedeCapturar() && !esAppleMovil() && typeof document !== 'undefined' && document.fullscreenEnabled ? (
                <p className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-xs">
                  <b>Ojo:</b> en este navegador la tecla <b>Esc</b> saca de pantalla completa y cuenta como salida. Si puedes, contesta en <b>Chrome</b> o <b>Edge</b>: ahí Esc no te saca por accidente.
                </p>
              ) : null}
              {asig.bloqueado ? (
                <p className="mt-1 font-semibold">
                  Tu docente bloqueó la pantalla: no podrás usar otra parte del portal hasta enviar el examen, y si sales de pantalla completa o de esta pantalla, el examen se tapará hasta que regreses.
                </p>
              ) : null}
              {asig.cerrar_al_salir ? (
                <p className="mt-1 font-semibold">
                  Si sales una vez (otra pestaña, otra aplicación o escritorio, abrir un aviso o salir de pantalla completa) verás una advertencia. Si sales una segunda vez, tu examen se enviará solo con lo que lleves.
                </p>
              ) : null}
            </div>
          ) : null}
          {asig.abierta ? (
            <Boton className="w-full min-h-[52px] text-base" onClick={comenzar} disabled={iniciando}>
              {iniciando ? 'Preparando…' : 'Comenzar'}
            </Boton>
          ) : (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <div className="font-semibold">No disponible</div>
              <p className="mt-1 break-words">{asig.motivo_cierre ?? 'Esta actividad no está abierta.'}</p>
            </div>
          )}
        </Tarjeta>
      </div>
    </div>
  )
}

function PantallaResultado({ asig, intento }: { asig: AsignacionParaAlumno; intento: Intento }): JSX.Element {
  const nav = useNavigate()
  const [soloErrores, setSoloErrores] = useState(false)
  const puntaje = intento.puntaje ?? intento.puntaje_auto
  const total = asig.puntos_totales ?? 0
  // Calificación del examen sobre 10 y lo que aporta al parcial con su ponderación (p. ej. 30 %)
  const cal = calificacionExamen(puntaje, total, asig.ponderacion)
  const sobre10 = cal?.sobre10 ?? null
  const pond = cal?.ponderacion ?? 0
  const aporte = cal?.aporte ?? null
  const maxAporte = cal?.maximo ?? 0
  const parcial = Boolean(intento.pendiente_manual) && intento.estado !== 'calificado'
  const revision = asig.revision ?? []
  const bien = revision.filter((r) => r.correcta === true).length
  const mal = revision.filter((r) => r.correcta === false).length
  const porRevisar = revision.filter((r) => r.correcta === null).length
  const visibles = soloErrores ? revision.filter((r) => r.correcta !== true) : revision
  const tono = sobre10 === null ? 'text-ink-900' : sobre10 >= 8 ? 'text-emerald-600' : sobre10 >= 6 ? 'text-amber-600' : 'text-red-600'

  return (
    <div className="min-h-[100dvh] bg-ink-50">
      <div className={`mx-auto space-y-4 px-4 py-4 pb-10 ${revision.length ? 'max-w-3xl' : 'max-w-md sm:pt-16'}`}>
        <Tarjeta className="space-y-4">
          <Encabezado asig={asig} />
          <div className="flex flex-wrap gap-1.5">
            <Chip tono="verde">{intento.estado === 'calificado' ? 'Calificada' : 'Enviada'}</Chip>
            {intento.enviado_en ? <Chip>Enviada {fechaMx(intento.enviado_en)}</Chip> : null}
          </div>
          {asig.mostrar_resultado ? (
            <div className="rounded-2xl bg-ink-50 p-4 text-center">
              {puntaje !== null ? (
                <>
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Calificación del examen</div>
                  {sobre10 !== null ? (
                    <div className={`mt-1 text-5xl font-bold tabular-nums ${tono}`}>
                      {sobre10.toFixed(1)} <span className="text-lg font-medium text-ink-400">/ 10</span>
                    </div>
                  ) : null}
                  <div className="mt-1 text-sm text-ink-600">
                    {puntos(puntaje)} de {puntos(total)} pts
                  </div>
                  {aporte !== null ? (
                    <div className="mx-auto mt-3 max-w-sm rounded-xl border border-brand-400/40 bg-white p-3 text-left">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-ink-800">En tu parcial</span>
                        <span className="text-sm tabular-nums text-ink-600">
                          <b className="text-lg text-ink-900">{aporte.toFixed(2)}</b> de {maxAporte.toFixed(1)}
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink-100" aria-hidden>
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${maxAporte > 0 ? Math.min(100, (aporte / maxAporte) * 100) : 0}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-ink-500">
                        Este examen vale el <b>{puntos(pond)} %</b> de tu calificación del parcial: {sobre10?.toFixed(1)} × {puntos(pond)} % = {aporte.toFixed(2)} puntos.
                      </p>
                    </div>
                  ) : null}
                  {parcial ? <div className="mt-3 text-sm text-amber-700">Calificación parcial: faltan las preguntas que revisa tu docente.</div> : null}
                </>
              ) : (
                <div className="text-base font-semibold text-amber-700">Pendiente de revisión del docente</div>
              )}
              {intento.retro ? (
                <div className="mt-3 text-left">
                  <div className="text-xs font-semibold uppercase tracking-wide text-ink-400">Retroalimentación</div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink-800">{intento.retro}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl bg-ink-50 p-4 text-center">
              <div className="text-lg font-bold text-ink-900">Entrega recibida</div>
              <div className="mt-1 text-sm text-ink-500">El docente te dará a conocer el resultado.</div>
            </div>
          )}
          {asig.revision_aviso ? <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">🔒 {asig.revision_aviso}</div> : null}
          <div className="text-sm text-ink-500">Tiempo activo: {duracion(intento.tiempo_activo_seg)}</div>
          {intento.archivos?.length ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Archivos entregados</div>
              <ul className="divide-y divide-ink-100">
                {intento.archivos.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{f.nombre}</span>
                    <Boton variante="secundario" className="shrink-0 px-3" onClick={() => void abrirArchivo(f)} aria-label={`Abrir ${f.nombre}`}>
                      Abrir
                    </Boton>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {revision.length ? null : <Boton className="w-full min-h-[48px]" onClick={() => nav('/')}>Volver a mis actividades</Boton>}
        </Tarjeta>

        {revision.length ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="mr-auto text-lg font-bold text-ink-900">Tus respuestas</h2>
              <Chip tono="verde">✓ {bien} bien</Chip>
              <Chip tono="rojo">✗ {mal} mal</Chip>
              {porRevisar ? <Chip tono="ambar">⏳ {porRevisar} por revisar</Chip> : null}
            </div>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Qué preguntas ver">
              {[
                [false, `Todas (${revision.length})`],
                [true, `Solo para repasar (${mal + porRevisar})`]
              ].map(([v, t]) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={soloErrores === v}
                  onClick={() => setSoloErrores(v as boolean)}
                  className={`min-h-[40px] rounded-full border px-3 text-sm ${soloErrores === v ? 'border-brand-500 bg-brand-500/10 font-semibold text-ink-900' : 'border-ink-200 bg-white text-ink-600 hover:bg-ink-50'}`}
                >
                  {t as string}
                </button>
              ))}
            </div>
            {visibles.length ? visibles.map((r) => <PreguntaRevisadaVista key={r.numero} r={r} />) : <Vacio icono="🎉" titulo="¡Todo bien!" detalle="No tuviste ninguna incorrecta ni pendiente." />}
            <Boton className="w-full min-h-[48px]" onClick={() => nav('/')}>Volver a mis actividades</Boton>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Una pregunta ya entregada: lo que contestó, si estuvo bien, la respuesta correcta y por qué */
function PreguntaRevisadaVista({ r }: { r: PreguntaRevisada }): JSX.Element {
  const opciones = r.tipo === 'opcion_multiple' || r.tipo === 'verdadero_falso'
  const vacia = !r.respuesta_alumno.trim()
  const borde = r.correcta === true ? 'border-l-emerald-500' : r.correcta === false ? 'border-l-red-500' : 'border-l-amber-400'
  return (
    <Tarjeta className={`space-y-3 border-l-4 ${borde}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold uppercase tracking-wide text-ink-400">
          Pregunta {r.numero} · {TIPO_PREGUNTA[r.tipo]}
        </span>
        {r.correcta === true ? (
          <span className="font-semibold text-emerald-700">✓ Correcta · {puntos(r.puntos)} de {puntos(r.puntos)} pts</span>
        ) : r.correcta === false ? (
          <span className="font-semibold text-red-700">✗ {vacia ? 'Sin contestar' : 'Incorrecta'} · 0 de {puntos(r.puntos)} pts</span>
        ) : (
          <span className="font-semibold text-amber-700">⏳ La revisa tu docente · vale {puntos(r.puntos)} pts</span>
        )}
      </div>
      <Markdown texto={r.enunciado} />

      {opciones ? (
        <ul className={r.tipo === 'verdadero_falso' ? 'grid grid-cols-2 gap-2' : 'space-y-2'}>
          {r.opciones.map((op, i) => {
            const esCorrecta = i === r.indice_correcto
            const suya = i === r.indice_alumno
            const estilo = esCorrecta ? 'border-emerald-400 bg-emerald-50 text-emerald-900' : suya ? 'border-red-300 bg-red-50 text-red-900' : 'border-ink-200 bg-white text-ink-600'
            return (
              <li key={`${i}-${op}`} className={`flex min-h-[44px] items-center gap-3 rounded-xl border px-3 py-2 text-[15px] ${estilo}`}>
                <span className="w-5 shrink-0 text-center font-bold" aria-hidden>
                  {esCorrecta ? '✓' : suya ? '✗' : ''}
                </span>
                <Markdown texto={op} enLinea className="min-w-0 flex-1 break-words" />
                {suya ? <span className="shrink-0 rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold">Tu respuesta</span> : null}
                {esCorrecta && !suya ? <span className="shrink-0 rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold">Correcta</span> : null}
              </li>
            )
          })}
          {vacia ? <li className="text-sm text-red-700">No contestaste esta pregunta.</li> : null}
        </ul>
      ) : r.tipo === 'cuaderno' ? (
        <p className="text-sm text-ink-600">Tu cuaderno lo revisa tu docente.</p>
      ) : (
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-400">Tu respuesta</div>
            {vacia ? (
              <p className="text-sm text-red-700">No contestaste esta pregunta.</p>
            ) : (
              <pre className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-800 ${r.tipo === 'codigo' ? 'font-mono' : 'font-sans'}`}>{r.respuesta_alumno}</pre>
            )}
          </div>
          {r.respuesta_correcta.trim() ? (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-700">Respuesta esperada</div>
              {r.tipo === 'codigo' ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 font-mono text-sm text-emerald-950">{r.respuesta_correcta}</pre>
              ) : (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
                  <Markdown texto={r.respuesta_correcta} />
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {r.explicacion.trim() ? (
        <div className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-950">
          <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">Por qué</div>
          <Markdown texto={r.explicacion} />
        </div>
      ) : null}
    </Tarjeta>
  )
}

// ---------- Pregunta ----------

function Pregunta({ p, valor, responder }: { p: PreguntaAlumno; valor: string; responder: (v: string) => void }): JSX.Element {
  const opciones = p.tipo === 'opcion_multiple' || p.tipo === 'verdadero_falso'
  return (
    <Tarjeta className="scroll-mt-24 space-y-3" id={`pregunta-${p.indice}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-ink-400">
        <span className="font-semibold uppercase tracking-wide">
          Pregunta {p.numero ?? p.indice + 1} · {TIPO_PREGUNTA[p.tipo]}
        </span>
        <span>{puntos(p.puntos)} pts</span>
      </div>
      <Markdown texto={p.enunciado} />

      {opciones ? (
        <div role="radiogroup" aria-label={`Respuesta a la pregunta ${p.numero ?? p.indice + 1}`} className={p.tipo === 'verdadero_falso' ? 'grid grid-cols-2 gap-2' : 'space-y-2'}>
          {p.opciones.map((op, i) => {
            const activa = valor === op
            return (
              <button
                key={`${i}-${op}`}
                type="button"
                role="radio"
                aria-checked={activa}
                onClick={() => responder(op)}
                className={`flex min-h-[48px] w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-[15px] transition active:scale-[0.99] ${activa ? 'border-brand-500 bg-brand-500/10 text-ink-900' : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50'}`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${activa ? 'border-brand-500' : 'border-ink-300'}`} aria-hidden>
                  {activa ? <span className="h-2.5 w-2.5 rounded-full bg-brand-500" /> : null}
                </span>
                {/* Las opciones traen LaTeX ($n(n-1)/2$) igual que el enunciado */}
                <Markdown texto={op} enLinea className="min-w-0 flex-1 break-words" />
              </button>
            )
          })}
        </div>
      ) : p.tipo === 'cuaderno' ? (
        <PreguntaCuaderno p={p} valor={valor} responder={responder} />
      ) : p.tipo === 'codigo' ? (
        // Editor con «Ejecutar»: el alumno prueba su programa antes de entregarlo (se guarda igual que el texto)
        <Codigo valor={valor} onCambio={responder} lenguaje={p.lenguaje} pistas={[p.enunciado]} />
      ) : (
        <textarea
          value={valor}
          onChange={(e) => responder(e.target.value)}
          rows={4}
          placeholder="Escribe tu respuesta aquí"
          aria-label={`Respuesta a la pregunta ${p.numero ?? p.indice + 1}`}
          className="w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-base text-ink-800 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400/40"
        />
      )}
    </Tarjeta>
  )
}

/**
 * Pregunta «cuaderno»: el alumno resuelve el .ipynb del docente aquí mismo. Su respuesta es el cuaderno
 * completo (texto JSON): se guarda solo como cualquier respuesta y se envía con el examen.
 */
function PreguntaCuaderno({ p, valor, responder }: { p: PreguntaAlumno; valor: string; responder: (v: string) => void }): JSX.Element {
  // Solo al montar: después el editor lleva su propio estado y avisa cada cambio
  const [inicial] = useState(() => {
    try {
      const nb = JSON.parse(valor.trim() ? valor : (p.cuaderno ?? ''))
      return Array.isArray(nb?.cells) ? nb : null
    } catch {
      return null
    }
  })
  if (!inicial) return <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">No se pudo abrir el cuaderno de esta pregunta. Avísale a tu docente.</div>
  return (
    <Suspense fallback={<Cargando texto="Abriendo el cuaderno…" />}>
      <EditorCuaderno inicial={inicial} paquetes={Boolean(p.paquetes)} onCambio={(nb) => responder(JSON.stringify(nb))} />
    </Suspense>
  )
}

// ---------- Respaldo local por intento ----------

/** Copia en el teléfono de lo que el alumno lleva escrito, por si la pestaña se recarga o el sistema la descarta. */
interface Respaldo {
  v: 1
  intento: number
  respuestas: Record<string, string>
  tiempo: number
  borrador: boolean
  /** Hora del último cambio, en reloj del servidor (ms). */
  editado_ms: number
  /** Huellas de los estados que este teléfono mandó o recibió del servidor. */
  conocidas: string[]
}

type CuerpoGuardado = { respuestas: Record<string, string>; tiempo_activo_seg: number; borrador: boolean }

const claveRespaldo = (usuarioId: number | undefined, intentoId: number): string => `docente-portal.respaldo.${usuarioId ?? 'anon'}.${intentoId}`

/**
 * Decide con qué respuestas arranca la pantalla. Se restaura el respaldo cuando difiere de lo que
 * trae el servidor y, o bien lo del servidor salió de este mismo teléfono (así que el respaldo es
 * igual o más nuevo), o bien el respaldo se editó después de la última actividad registrada.
 */
function estadoInicial(clave: string, intento: Intento): { respuestas: Record<string, string>; tiempo: number; borrador: boolean; conocidas: string[]; restaurado: boolean } {
  const servidor = intento.respuestas ?? {}
  const hServidor = huella(servidor)
  const base = { respuestas: servidor, tiempo: intento.tiempo_activo_seg, borrador: intento.estado === 'borrador', conocidas: [hServidor], restaurado: false }
  const r = leerLocal<Respaldo>(clave)
  if (!r || r.v !== 1 || r.intento !== intento.id || !r.respuestas || typeof r.respuestas !== 'object') return base
  const conocidas = Array.isArray(r.conocidas) ? r.conocidas : []
  if (huella(r.respuestas) === hServidor) return { ...base, tiempo: Math.max(base.tiempo, r.tiempo || 0), conocidas: [...conocidas.filter((h) => h !== hServidor), hServidor].slice(-12) }
  const ultima = aFecha(intento.ultima_actividad ?? '').getTime()
  const masNuevo = conocidas.includes(hServidor) || (Number.isFinite(ultima) && r.editado_ms > ultima)
  if (!masNuevo) return base
  return { respuestas: r.respuestas, tiempo: Math.max(base.tiempo, r.tiempo || 0), borrador: base.borrador || Boolean(r.borrador), conocidas: [...conocidas, hServidor].slice(-12), restaurado: true }
}

/** Errores que vale la pena reintentar solos: sin red, tiempo de espera, saturación o fallas del servidor. */
function clasificarFallo(e: unknown): TipoFallo {
  const estado = (e as ErrorApi).estado
  if (estado === 400) return 'definitivo'
  if (estado === undefined || estado === 0 || estado === 408 || estado === 429 || estado >= 500) return 'reintentable'
  return 'otro'
}

// ---------- Contestar ----------

interface PropsContestar {
  asig: AsignacionParaAlumno
  intento: Intento
  preguntas: PreguntaAlumno[]
  alEnviar: (i: Intento) => void
  alBloquear: (motivo: string) => void
}

/** Zona de trabajo: preguntas, autoguardado, tiempo, vigilancia, archivos y envío. */
function Contestar({ asig, intento, preguntas, alEnviar, alBloquear }: PropsContestar): JSX.Element {
  const nav = useNavigate()
  // Un cuaderno de Jupyter necesita más ancho que una pregunta suelta
  const ancho = preguntas.some((p) => p.tipo === 'cuaderno') ? 'max-w-5xl' : 'max-w-2xl'
  const rutaRespuestas = `/alumno/intentos/${intento.id}/respuestas`
  const clave = useMemo(() => claveRespaldo(useSesion.getState().usuario?.id, intento.id), [intento.id])
  // Si el teléfono tiene respuestas más nuevas que el servidor (recarga, pestaña descartada, red caída), se parte de ellas
  const [inicio] = useState(() => estadoInicial(clave, intento))
  const [respuestas, setRespuestas] = useState<Record<string, string>>(inicio.respuestas)
  const respuestasRef = useRef(respuestas)
  // Una vez guardado como borrador, todos los guardados lo conservan así hasta el envío
  const borradorRef = useRef(inicio.borrador)

  const tiempoRef = useRef(inicio.tiempo)
  const [tiempo, setTiempo] = useState(inicio.tiempo)
  const limite = useMemo(() => (asig.duracion_min ? aFecha(intento.iniciado_en).getTime() + asig.duracion_min * 60000 : null), [asig.duracion_min, intento.iniciado_en])
  // Cuánto va adelantado o atrasado el reloj del celular respecto al servidor
  const desfase = useMemo(() => (asig.servidor_ms ? asig.servidor_ms - Date.now() : 0), [asig.servidor_ms])
  const [restante, setRestante] = useState<number | null>(limite === null ? null : limite - (Date.now() + desfase))

  const [salidas, setSalidas] = useState(asig.salidas ?? 0)
  const cierraAlSalir = Boolean(asig.vigilancia && asig.cerrar_al_salir)
  // Sin API de pantalla completa, en iPhone/iPad (el teclado la quita) o si el navegador la niega (visor de
  // WhatsApp/Instagram) no se exige; se vigila lo demás
  const [pantallaNegada, setPantallaNegada] = useState(false)
  const usaPantallaCompleta = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled) && !esAppleMovil() && !pantallaNegada
  const [advertencia, setAdvertencia] = useState(cierraAlSalir && (asig.salidas ?? 0) === 1)
  const recargandoRef = useRef(false)
  /** El examen se envía por haber salido dos veces: cambia el aviso al terminar. */
  const porSalidasRef = useRef(false)
  const eligiendoArchivo = useRef(false)
  const [pantallaCompleta, setPantallaCompleta] = useState(Boolean(document.fullscreenElement))

  // --- Bloqueo de examen: lo pone y lo quita el docente en vivo (se revisa cada 5 s) ---
  const [bloqueado, setBloqueado] = useState(Boolean(asig.bloqueado))
  useEffect(() => {
    let vivo = true
    const leer = (): void =>
      void api<{ bloqueo: { asignacion_id: number } | null }>('/alumno/estado')
        .then((r) => vivo && setBloqueado(r.bloqueo?.asignacion_id === asig.id))
        .catch(() => undefined)
    const t = window.setInterval(leer, 5000)
    return () => {
      vivo = false
      window.clearInterval(t)
    }
  }, [asig.id])
  // El cursor se fue de la pantalla del examen (otro monitor): cuenta como salida y, bloqueado, tapa el examen
  const [mouseFuera, setMouseFuera] = useState(false)
  const mouseFueraRef = useRef(false)
  // Con la pantalla bloqueada, el examen se tapa en cuanto deja de estar a la vista (otra app, otra pestaña)
  const [aLaVista, setALaVista] = useState(() => document.visibilityState === 'visible' && document.hasFocus())
  useEffect(() => {
    const revisar = (): void => setALaVista(document.visibilityState === 'visible' && document.hasFocus())
    const conFoco = (): void => setALaVista(document.visibilityState === 'visible')
    const sinFoco = (): void => setALaVista(false)
    document.addEventListener('visibilitychange', revisar)
    window.addEventListener('focus', conFoco)
    window.addEventListener('blur', sinFoco)
    return () => {
      document.removeEventListener('visibilitychange', revisar)
      window.removeEventListener('focus', conFoco)
      window.removeEventListener('blur', sinFoco)
    }
  }, [])

  const [archivos, setArchivos] = useState<ArchivoEntrega[]>(intento.archivos ?? [])
  const [subiendo, setSubiendo] = useState(false)
  const [errorArchivos, setErrorArchivos] = useState('')

  const [modal, setModal] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const enviandoRef = useRef(false)

  const cuerpoGuardado = useCallback((): CuerpoGuardado => ({ respuestas: respuestasRef.current, tiempo_activo_seg: tiempoRef.current, borrador: borradorRef.current }), [])

  // --- Respaldo local ---
  const conocidasRef = useRef(inicio.conocidas)
  const editadoRef = useRef(Date.now() + desfase)
  const [respaldoOk, setRespaldoOk] = useState(true)
  const escribirRespaldo = useCallback((): void => {
    const r: Respaldo = { v: 1, intento: intento.id, respuestas: respuestasRef.current, tiempo: tiempoRef.current, borrador: borradorRef.current, editado_ms: editadoRef.current, conocidas: conocidasRef.current }
    const ok = escribirLocal(clave, r)
    setRespaldoOk((antes) => (antes === ok ? antes : ok))
  }, [clave, intento.id])
  /** Este teléfono mandó (o recibió) este estado: si el servidor lo trae al recargar, el respaldo es igual o más nuevo. */
  const recordar = useCallback(
    (r: Record<string, string>): void => {
      const h = huella(r)
      if (conocidasRef.current[conocidasRef.current.length - 1] !== h) conocidasRef.current = [...conocidasRef.current.filter((x) => x !== h), h].slice(-12)
      escribirRespaldo()
    },
    [escribirRespaldo]
  )
  const conKeepalive = useCallback((): void => {
    const cuerpo = cuerpoGuardado()
    recordar(cuerpo.respuestas)
    enviarConKeepalive(rutaRespuestas, 'PUT', cuerpo)
  }, [cuerpoGuardado, recordar, rutaRespuestas])

  // --- Guardado: un solo PUT en vuelo, siempre con el último estado, con reintentos ---
  const alBloquearRef = useRef(alBloquear)
  alBloquearRef.current = alBloquear
  const [estadoCola, setEstadoCola] = useState<EstadoCola>({ fase: 'limpio', sucio: false, fallos: 0 })
  const [cola] = useState(
    () =>
      new ColaGuardado<CuerpoGuardado>({
        tomar: cuerpoGuardado,
        subir: async (cuerpo) => {
          await api<Intento>(rutaRespuestas, { metodo: 'PUT', cuerpo })
        },
        clasificar: clasificarFallo,
        alCambiar: setEstadoCola,
        alIntentar: (cuerpo) => recordar(cuerpo.respuestas),
        // Un 400 aquí significa que el intento ya no se puede editar: cerrada, tiempo agotado o ya enviada
        // Al cerrarse por salidas el servidor puede ganarle al último guardado: el envío sigue y muestra el resultado
        alDefinitivo: (e) => {
          if (!porSalidasRef.current) alBloquearRef.current((e as ErrorApi).message)
        }
      })
  )

  const responder = (indice: number, valor: string): void => {
    const nuevas = { ...respuestasRef.current, [String(indice)]: valor }
    respuestasRef.current = nuevas
    setRespuestas(nuevas)
    editadoRef.current = Date.now() + desfase
    escribirRespaldo()
    cola.cambio()
  }

  // Al montar: se escribe el respaldo de partida y, si se restauró algo, se sube de inmediato
  const avisoRestauradoRef = useRef(false)
  useEffect(() => {
    cola.activar()
    escribirRespaldo()
    if (inicio.restaurado) {
      cola.cambio()
      void cola.ahora()
      if (!avisoRestauradoRef.current) {
        avisoRestauradoRef.current = true
        avisar('Recuperamos respuestas que estaban en este teléfono y aún no llegaban al servidor.', 'info')
      }
    }
    return () => cola.detener()
  }, [cola, escribirRespaldo, inicio.restaurado])

  // --- Envío automático pendiente (se agotó el tiempo sin red) ---
  const [esperandoEnvio, setEsperandoEnvio] = useState(false)
  const esperandoEnvioRef = useRef(false)
  const fallosEnvioRef = useRef(0)
  const temporizadorEnvio = useRef<number | undefined>(undefined)
  const enviarRef = useRef<(automatico?: boolean) => Promise<void>>(async () => undefined)

  const [enLinea, setEnLinea] = useState(typeof navigator === 'undefined' || navigator.onLine !== false)

  // Guarda al ocultarse la pestaña y al cerrar o recargar; al volver la red o la pestaña, reintenta lo pendiente
  useEffect(() => {
    const alVolver = (): void => {
      cola.reintentar()
      if (esperandoEnvioRef.current && !enviandoRef.current) {
        window.clearTimeout(temporizadorEnvio.current)
        void enviarRef.current(true)
      }
    }
    const alCambiarVisibilidad = (): void => {
      if (document.visibilityState === 'hidden') conKeepalive()
      else alVolver()
    }
    const alSalir = (): void => conKeepalive()
    const conectado = (): void => {
      setEnLinea(true)
      alVolver()
    }
    const desconectado = (): void => setEnLinea(false)
    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    window.addEventListener('beforeunload', alSalir)
    window.addEventListener('pageshow', alVolver)
    window.addEventListener('online', conectado)
    window.addEventListener('offline', desconectado)
    return () => {
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
      window.removeEventListener('beforeunload', alSalir)
      window.removeEventListener('pageshow', alVolver)
      window.removeEventListener('online', conectado)
      window.removeEventListener('offline', desconectado)
      window.clearTimeout(temporizadorEnvio.current)
      if (cola.sucio && !enviandoRef.current) conKeepalive()
    }
  }, [cola, conKeepalive])

  // --- Tiempo activo (solo con la pestaña visible y con foco) y cuenta regresiva ---
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        tiempoRef.current += 1
        setTiempo(tiempoRef.current)
      }
      if (limite !== null) setRestante(limite - (Date.now() + desfase))
    }, 1000)
    return () => window.clearInterval(t)
  }, [limite, desfase])

  // --- Envío ---
  const tiempoVencido = useCallback((): boolean => limite !== null && limite - (Date.now() + desfase) <= 0, [limite, desfase])
  const enviar = useCallback(
    async (automatico = false): Promise<void> => {
      if (enviandoRef.current) return
      window.clearTimeout(temporizadorEnvio.current)
      enviandoRef.current = true
      setEnviando(true)
      setModal(false)
      // Mientras se envía no hay guardados en segundo plano: el envío sube lo pendiente por la misma cola
      cola.pausar(true)
      try {
        // El servidor califica lo que tiene guardado: primero se suben las respuestas y el tiempo.
        // Si ya venció, el servidor rechaza el guardado (400) pero acepta el envío con lo último guardado.
        const g = await cola.ahora()
        if (!g.ok && !g.definitivo) throw g.error
        const r = await api<Intento>(`/alumno/intentos/${intento.id}/enviar`, { metodo: 'POST', cuerpo: { tiempo_activo_seg: tiempoRef.current } })
        cola.detener()
        borrarLocal(clave)
        if (porSalidasRef.current) avisar('Saliste del examen por segunda vez: se envió automáticamente con lo que llevabas.', 'error')
        else if (automatico) avisar(esperandoEnvioRef.current ? 'Volvió la conexión: tu actividad se envió.' : 'Se agotó el tiempo: tu actividad se envió automáticamente.', 'info')
        esperandoEnvioRef.current = false
        setEsperandoEnvio(false)
        if (document.fullscreenElement && typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => undefined)
        alEnviar(r)
      } catch (e) {
        const err = e as ErrorApi
        enviandoRef.current = false
        if (err.estado === 400) {
          cola.detener()
          setEnviando(false)
          alBloquear(err.message)
          return
        }
        if (automatico || tiempoVencido()) {
          // Sin red al agotarse el tiempo: un solo aviso y reintentos con espera creciente (y al volver la red)
          fallosEnvioRef.current += 1
          if (!esperandoEnvioRef.current) avisar('Se agotó el tiempo y no hay conexión. Tu actividad se enviará en cuanto vuelva la red: no cierres esta página.', 'error')
          esperandoEnvioRef.current = true
          setEsperandoEnvio(true)
          temporizadorEnvio.current = window.setTimeout(() => void enviarRef.current(true), esperaReintento(fallosEnvioRef.current))
        } else {
          setEnviando(false)
          cola.pausar(false)
          avisar(`No se pudo enviar: ${err.message}${cola.sucio ? ' Tus respuestas siguen en este teléfono y se seguirá intentando guardarlas.' : ''}`, 'error')
        }
      }
    },
    [cola, clave, intento.id, alEnviar, alBloquear, tiempoVencido]
  )
  enviarRef.current = enviar

  const autoDisparadoRef = useRef(false)
  useEffect(() => {
    if (restante !== null && restante <= 0 && !autoDisparadoRef.current) {
      autoDisparadoRef.current = true
      void enviar(true)
    }
  }, [restante, enviar])

  // Los intentos de captura de pantalla se anotan en este intento (componentes/Proteccion)
  useEffect(() => {
    vigilancia.intentoId = intento.id
    return () => {
      vigilancia.intentoId = null
    }
  }, [intento.id])

  // --- Vigilancia: registra y, si la actividad lo pide, advierte a la 1.ª salida y envía a la 2.ª ---
  // Se cuenta por episodio: una salida queda abierta hasta que el alumno vuelve (visible, con foco y, si se
  // exige, otra vez en pantalla completa). Lo que llegue mientras tanto (blur, pestaña oculta, fin de pantalla
  // completa que Chrome entrega al volver) es la misma salida.
  const exigePantallaRef = useRef(false)
  exigePantallaRef.current = (cierraAlSalir || bloqueado) && usaPantallaCompleta
  useEffect(() => {
    if (!asig.vigilancia) return
    let fuera = false
    // Se siguen con los mismos eventos (no con document.hasFocus, que algunos navegadores tardan en actualizar)
    let oculta = document.visibilityState === 'hidden'
    let sinFoco = false
    let cuenta = asig.salidas ?? 0
    const ruta = `/alumno/intentos/${intento.id}/eventos`
    const registrar = (tipo: TipoEventoIntegridad, esSalida = false, detalle = ''): void => {
      // Abrir la cámara o la galería para subir la entrega saca de la página: se anota, pero no cuenta como salida
      if (eligiendoArchivo.current) {
        enviarConKeepalive(ruta, 'POST', { tipo, detalle: 'al elegir un archivo para subir' })
        return
      }
      // Al enviar o al salir con el botón se cierra la pantalla completa a propósito
      if (enviandoRef.current) return
      // El parpadeo de foco al entrar a pantalla completa (o al volver a ella) se anota sin contar como salida
      if (esSalida && Date.now() < entrandoAPantallaHasta) {
        enviarConKeepalive(ruta, 'POST', { tipo, detalle: DETALLE_ENTRADA })
        // Si al terminar ese instante sigue fuera (se fue a otra app o salió de pantalla completa), sí cuenta:
        // así entrar a pantalla completa no sirve para escaparse sin que se registre
        window.setTimeout(
          () => {
            const sigueFuera = document.visibilityState === 'hidden' || !document.hasFocus() || (exigePantallaRef.current && !document.fullscreenElement)
            if (sigueFuera && !enviandoRef.current) registrar(tipo, true, detalle)
          },
          entrandoAPantallaHasta - Date.now() + 300
        )
        return
      }
      if (recargandoRef.current && esSalida) detalle = 'al recargar'
      else if (esSalida && fuera) detalle = 'misma salida'
      else if (esSalida) {
        fuera = true
        cuenta += 1
        setSalidas(cuenta)
        if (cierraAlSalir) {
          if (cuenta === 1) setAdvertencia(true)
          // Con lo contestado en el mismo envío: si el servidor cierra por esta salida, califica con lo último
          const token = useSesion.getState().token
          // keepalive admite 64 KB: con respuestas enormes (código largo) viaja solo el evento
          let cuerpo = JSON.stringify({ tipo, detalle, respuestas: respuestasRef.current, tiempo_activo_seg: tiempoRef.current })
          if (cuerpo.length > 60_000) cuerpo = JSON.stringify({ tipo, detalle })
          void fetch(`/api${ruta}`, { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: cuerpo })
            .then((r) => (r.ok ? (r.json() as Promise<{ cerrado?: boolean }>) : null))
            .then((r) => {
              // El servidor lleva la cuenta (sobrevive a recargas): si cerró, aquí se termina igual
              if (r?.cerrado) {
                porSalidasRef.current = true
                void enviarRef.current(true)
              }
            })
            .catch(() => undefined)
          if (cuenta >= 2) {
            porSalidasRef.current = true
            void enviarRef.current(true)
          }
          return
        }
      }
      enviarConKeepalive(ruta, 'POST', { tipo, detalle })
    }
    const volvio = (): void => {
      if (!oculta && !sinFoco && !mouseFueraRef.current && (!exigePantallaRef.current || document.fullscreenElement)) fuera = false
    }
    // Cursor fuera de la pantalla del examen (con dos monitores, irse al otro). Solo en pantalla completa: sin ella
    // el cursor puede ir a la barra del navegador sin dejar el examen. Salir por el borde de arriba no cuenta: ahí
    // Firefox muestra su barra al acercarse. Un roce de menos de un segundo tampoco.
    let esperaMouse = 0
    let mouseContado = false
    const mouseSalio = (e: MouseEvent): void => {
      if (!document.fullscreenElement || e.relatedTarget || e.clientY <= 2) return
      window.clearTimeout(esperaMouse)
      esperaMouse = window.setTimeout(() => {
        mouseContado = true
        mouseFueraRef.current = true
        setMouseFuera(true)
        registrar('mouse_fuera', true, 'el cursor salió de la pantalla del examen')
      }, 800)
    }
    const mouseVolvio = (): void => {
      window.clearTimeout(esperaMouse)
      if (!mouseContado) return
      mouseContado = false
      mouseFueraRef.current = false
      setMouseFuera(false)
      registrar('mouse_volvio')
      volvio()
    }
    // Al volver del selector de archivos aún llegan eventos (p. ej. salir de pantalla completa en Android)
    const terminoDeElegir = (): void => {
      if (eligiendoArchivo.current) window.setTimeout(() => (eligiendoArchivo.current = false), 2000)
    }
    const visibilidad = (): void => {
      oculta = document.visibilityState === 'hidden'
      if (oculta) return registrar('salio_pestana', true)
      registrar('volvio_pestana')
      volvio()
      terminoDeElegir()
    }
    const perdioFoco = (): void => {
      sinFoco = true
      registrar('perdio_foco', true)
    }
    const recuperoFoco = (): void => {
      sinFoco = false
      registrar('recupero_foco')
      volvio()
      terminoDeElegir()
    }
    const pantalla = (): void => {
      const dentro = Boolean(document.fullscreenElement)
      setPantallaCompleta(dentro)
      if (dentro) {
        // La animación de entrada puede dejar un instante sin foco después de este aviso: tampoco cuenta
        entrandoAPantallaHasta = Math.max(entrandoAPantallaHasta, Date.now() + 1500)
        bloquearEsc()
        // El docente ve en vivo quién sigue fuera: volver también se anota
        registrar('volvio_pantalla_completa')
        volvio()
      }
      // En iPad y iPhone el teclado saca de pantalla completa: ahí no cuenta
      else if (usaPantallaCompleta) registrar('salio_pantalla_completa', true)
    }
    const recarga = (): void => {
      recargandoRef.current = true
    }
    const copiar = (): void => registrar('copiar')
    const pegar = (): void => registrar('pegar')
    document.addEventListener('visibilitychange', visibilidad)
    window.addEventListener('blur', perdioFoco)
    window.addEventListener('focus', recuperoFoco)
    window.addEventListener('beforeunload', recarga)
    document.addEventListener('fullscreenchange', pantalla)
    document.addEventListener('copy', copiar)
    document.addEventListener('paste', pegar)
    document.documentElement.addEventListener('mouseleave', mouseSalio)
    document.documentElement.addEventListener('mouseenter', mouseVolvio)
    return () => {
      window.clearTimeout(esperaMouse)
      document.documentElement.removeEventListener('mouseleave', mouseSalio)
      document.documentElement.removeEventListener('mouseenter', mouseVolvio)
      document.removeEventListener('visibilitychange', visibilidad)
      window.removeEventListener('blur', perdioFoco)
      window.removeEventListener('focus', recuperoFoco)
      window.removeEventListener('beforeunload', recarga)
      document.removeEventListener('fullscreenchange', pantalla)
      document.removeEventListener('copy', copiar)
      document.removeEventListener('paste', pegar)
    }
    // asig.salidas solo cuenta al montar: después la lleva este efecto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asig.vigilancia, intento.id, cierraAlSalir, usaPantallaCompleta])

  // --- Archivos ---
  const subir = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const lista = e.target.files
    if (!lista || lista.length === 0) return
    const form = new FormData()
    Array.from(lista).forEach((f) => form.append('archivos', f))
    e.target.value = ''
    setSubiendo(true)
    setErrorArchivos('')
    try {
      const nuevos = await api<ArchivoEntrega[]>(`/alumno/intentos/${intento.id}/archivos`, { metodo: 'POST', form })
      setArchivos((a) => [...a, ...nuevos])
      avisar(nuevos.length === 1 ? 'Archivo subido' : `${nuevos.length} archivos subidos`)
    } catch (err) {
      setErrorArchivos((err as Error).message)
    } finally {
      setSubiendo(false)
    }
  }
  const quitar = async (id: number): Promise<void> => {
    setErrorArchivos('')
    try {
      await api(`/alumno/archivos/${id}`, { metodo: 'DELETE' })
      setArchivos((a) => a.filter((x) => x.id !== id))
    } catch (err) {
      setErrorArchivos((err as Error).message)
    }
  }

  // Tras guardar el borrador se ofrece salir: antes decía «puedes volver después» sin decir cómo
  const [borradorListo, setBorradorListo] = useState(false)
  const guardarBorrador = async (): Promise<void> => {
    borradorRef.current = true
    escribirRespaldo()
    cola.marcar()
    const r = await cola.ahora()
    if (r.ok) {
      avisar('Borrador guardado. Puedes volver después.')
      setBorradorListo(true)
    } else if (!r.definitivo) avisar('Sin conexión: el borrador quedó en este teléfono y se guardará en cuanto vuelva la red.', 'error')
  }

  // --- Salir a la lista sin enviar: primero se fuerza el guardado pendiente ---
  const [saliendo, setSaliendo] = useState(false)
  const salir = async (): Promise<void> => {
    if (saliendo || enviandoRef.current) return
    setSaliendo(true)
    escribirRespaldo()
    let guardado = !cola.sucio
    if (!guardado) {
      const espera = new Promise<null>((listo) => window.setTimeout(() => listo(null), ESPERA_SALIR_MS))
      const r = await Promise.race([cola.ahora(), espera])
      guardado = Boolean(r?.ok)
      // Sin respuesta a tiempo: último intento que sobrevive a la salida; el respaldo del teléfono se usa al volver
      if (!guardado) conKeepalive()
    }
    const reloj = limite !== null ? ' El tiempo sigue corriendo.' : ''
    if (guardado) avisar(`Tus respuestas quedaron guardadas. Puedes volver a esta actividad cuando quieras.${reloj}`)
    else avisar(`Sin conexión: tus respuestas quedaron en este teléfono y se subirán al volver a abrir la actividad.${reloj}`, 'info')
    if (document.fullscreenElement && typeof document.exitFullscreen === 'function') document.exitFullscreen().catch(() => undefined)
    nav('/')
  }

  const total = preguntas.length
  const contestadas = preguntas.filter((p) => respondida(respuestas[String(p.indice)])).length
  const sinResponder = total - contestadas
  // Candado del docente: con preguntas en blanco no se puede enviar (el tiempo agotado sí envía)
  const faltantes = preguntas.filter((p) => !respondida(respuestas[String(p.indice)]))
  const candado = Boolean(asig.todas_obligatorias) && faltantes.length > 0
  const irA = (indice: number): void => {
    setModal(false)
    window.setTimeout(() => document.getElementById(`pregunta-${indice}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }
  const conFallos = estadoCola.fallos > 0
  const textoGuardado = conFallos
    ? estadoCola.fase === 'detenido'
      ? 'Sin guardar'
      : 'Sin guardar · reintentando'
    : estadoCola.fase === 'guardando'
      ? 'Guardando…'
      : estadoCola.fase === 'guardado' && estadoCola.hora
        ? `Guardado a las ${horaMx(new Date(estadoCola.hora))}`
        : estadoCola.fase === 'pendiente'
          ? 'Cambios sin guardar'
          : 'Todo guardado'
  // El aviso de «cerrar al salir» (advertencia o volver a pantalla completa) manda: el del bloqueo no se le encima
  const avisoSalida = cierraAlSalir && !enviando && (advertencia || (usaPantallaCompleta && !pantallaCompleta))
  // Enviar ahora puede fallar: hay cambios que no llegan al servidor y no hay red
  const envioEnRiesgo = estadoCola.sucio && (!enLinea || conFallos)

  return (
    <div className="min-h-[100dvh] bg-ink-50">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className={`mx-auto ${ancho}`}>
          {cierraAlSalir || bloqueado ? null : (
            <button
              type="button"
              className="-ml-1 inline-flex min-h-[36px] items-center gap-1 rounded-lg px-1 text-sm text-ink-500 hover:text-ink-800 disabled:opacity-50"
              onClick={() => void salir()}
              disabled={saliendo || enviando}
            >
              <span aria-hidden>←</span> {saliendo ? 'Guardando antes de salir…' : 'Mis actividades'}
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink-400">{asig.materia_nombre ?? 'Materia'}</div>
              <div className="truncate font-bold text-ink-900">{asig.titulo}</div>
            </div>
            {restante !== null && (
              <div className={`shrink-0 rounded-xl px-2.5 py-1 font-mono text-lg font-bold tabular-nums ${restante <= 60_000 ? 'bg-red-100 text-red-700' : restante <= 5 * 60_000 ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-800'}`} aria-live="polite" aria-label="Tiempo restante">
                {mmss(restante)}
              </div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500">
            <span>
              Respondidas {contestadas} de {total}
            </span>
            <span>Activo {duracion(tiempo)}</span>
            <span className={conFallos ? 'font-semibold text-red-600' : estadoCola.fase === 'guardado' ? 'text-green-700' : ''} aria-live="polite">
              {textoGuardado}
            </span>
          </div>
        </div>
        {esperandoEnvio ? (
          <div className={`mx-auto mt-2 flex ${ancho} flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800`} role="alert">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">Se agotó el tiempo · enviando en cuanto haya conexión</div>
              <div className="break-words text-xs">{respaldoOk ? 'Tus respuestas están a salvo en este teléfono.' : 'No pudimos guardar una copia en este teléfono.'} No cierres esta página.</div>
            </div>
            <button type="button" className="min-h-[40px] shrink-0 rounded-lg border border-red-300 px-3 font-semibold hover:bg-red-100" onClick={() => void enviar(true)} disabled={enviando && !esperandoEnvio}>
              Reintentar ahora
            </button>
          </div>
        ) : conFallos ? (
          <div className={`mx-auto mt-2 flex ${ancho} flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900`} role="status">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{estadoCola.fase === 'detenido' ? 'Sin guardar' : 'Sin guardar · reintentando'}</div>
              <div className="break-words text-xs">
                {!enLinea ? 'Sin conexión a la red. ' : estadoCola.error ? `${estadoCola.error} ` : ''}
                {respaldoOk ? 'Tus respuestas están a salvo en este teléfono; no cierres esta página.' : 'No cierres esta página hasta que se guarde.'}
              </div>
            </div>
            <button type="button" className="min-h-[40px] shrink-0 rounded-lg border border-amber-300 px-3 font-semibold hover:bg-amber-100" onClick={() => cola.reintentar()} disabled={estadoCola.fase === 'guardando'}>
              {estadoCola.fase === 'guardando' ? 'Guardando…' : 'Reintentar ahora'}
            </button>
          </div>
        ) : null}
      </header>

      {asig.vigilancia ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <div className={`mx-auto flex ${ancho} flex-wrap items-center gap-x-3 gap-y-1`}>
            {/* min-w evita que en 375 px el texto se encoja a una columna en vez de bajar el botón */}
            <span className="min-w-[14rem] flex-1 break-words">
              {bloqueado ? '🔒 Pantalla bloqueada por tu docente: quédate en el examen hasta enviarlo. ' : ''}{cierraAlSalir ? 'Examen vigilado: si sales una segunda vez de esta pantalla, se enviará solo.' : 'Actividad con vigilancia: se registra si sales de esta pantalla o cambias de aplicación.'}
            </span>
            <span className="font-semibold">{cierraAlSalir ? `Salidas: ${salidas} de 2` : `Salidas registradas: ${salidas}`}</span>
            {!pantallaCompleta && (
              <button type="button" className="min-h-[36px] rounded-lg border border-amber-300 px-2 font-semibold hover:bg-amber-100" onClick={() => void pedirPantallaCompleta()}>
                Pantalla completa
              </button>
            )}
          </div>
        </div>
      ) : null}

      {asig.vigilancia ? <MarcaDeAgua /> : null}
      {/* Pantalla bloqueada por el docente: fuera de pantalla completa o de la vista, el examen queda tapado */}
      {bloqueado && !enviando && !avisoSalida && ((usaPantallaCompleta && !pantallaCompleta) || !aLaVista || mouseFuera) ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900 p-4" role="alertdialog" aria-modal="true" aria-labelledby="titulo-bloqueo">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 text-center shadow-xl">
            <div className="text-3xl" aria-hidden>🔒</div>
            <h2 id="titulo-bloqueo" className="text-lg font-bold text-ink-900">Tu docente bloqueó la pantalla del examen</h2>
            <p className="text-sm text-ink-700">
              {usaPantallaCompleta && !pantallaCompleta ? 'Para seguir contestando, regresa a pantalla completa.' : mouseFuera ? 'Para seguir contestando, regresa el cursor a la pantalla del examen.' : 'Para seguir contestando, regresa a esta pantalla.'} Tus respuestas están guardadas.{salidas > 0 ? ' Tu salida quedó registrada y tu docente la ve.' : ''}
            </p>
            <p className="text-xs text-ink-500">Cuando envíes el examen podrás salir y usar el portal con normalidad.</p>
            <Boton
              className="w-full min-h-[48px]"
              onClick={() => {
                setALaVista(document.visibilityState === 'visible')
                if (!usaPantallaCompleta || pantallaCompleta) return
                void pedirPantallaCompleta().then((ok) => {
                  if (!ok) {
                    setPantallaNegada(true)
                    enviarConKeepalive(`/alumno/intentos/${intento.id}/eventos`, 'POST', { tipo: 'salio_pantalla_completa', detalle: 'pantalla completa no disponible' })
                  }
                })
              }}
            >
              {usaPantallaCompleta && !pantallaCompleta ? 'Volver a pantalla completa' : 'Continuar el examen'}
            </Boton>
          </div>
        </div>
      ) : null}
      {avisoSalida ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/90 p-4" role="alertdialog" aria-modal="true" aria-labelledby="titulo-advertencia">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl">
            {advertencia ? (
              <>
                <h2 id="titulo-advertencia" className="text-lg font-bold text-red-700">Primera advertencia</h2>
                <p className="text-sm text-ink-700">
                  Saliste de la pantalla del examen. Quedó registrado y tu docente lo verá. <strong>Si vuelves a salir, tu examen se enviará solo</strong> con lo que lleves contestado.
                </p>
              </>
            ) : (
              <>
                <h2 id="titulo-advertencia" className="text-lg font-bold text-ink-900">El examen va en pantalla completa</h2>
                <p className="text-sm text-ink-700">Para seguir contestando, regresa a pantalla completa.</p>
              </>
            )}
            <Boton
              className="w-full min-h-[48px]"
              onClick={() => {
                setAdvertencia(false)
                if (!usaPantallaCompleta || pantallaCompleta) return
                // Si el navegador no la concede, el examen sigue sin ella (no se queda bloqueado)
                void pedirPantallaCompleta().then((ok) => {
                  if (!ok) {
                    setPantallaNegada(true)
                    enviarConKeepalive(`/alumno/intentos/${intento.id}/eventos`, 'POST', { tipo: 'salio_pantalla_completa', detalle: 'pantalla completa no disponible' })
                  }
                })
              }}
            >
              {usaPantallaCompleta && !pantallaCompleta ? 'Volver a pantalla completa' : 'Entendido, continuar'}
            </Boton>
          </div>
        </div>
      ) : null}

      <main className={`mx-auto ${ancho} space-y-4 px-4 py-4 pb-32`}>
        {asig.instrucciones.trim() ? (
          <details className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm" open={total === 0}>
            <summary className="min-h-[28px] cursor-pointer text-sm font-semibold text-ink-700">Instrucciones</summary>
            <Markdown texto={asig.instrucciones} className="mt-2" />
          </details>
        ) : null}

        {total === 0 ? <Vacio titulo="Esta actividad no tiene preguntas" detalle={asig.permite_archivos ? 'Sube tu entrega como archivo y envíala.' : 'Avisa a tu docente.'} /> : preguntas.map((p) => <Pregunta key={p.indice} p={p} valor={respuestas[String(p.indice)] ?? ''} responder={(v) => responder(p.indice, v)} />)}

        {asig.permite_archivos ? (
          <Tarjeta className="space-y-3">
            <div>
              <div className="font-semibold text-ink-900">Archivos adjuntos</div>
              <div className="text-xs text-ink-500">PDF, Office, imágenes, código o ZIP. Hasta 25 MB por archivo y 5 archivos por subida.</div>
            </div>
            {archivos.length > 0 ? (
              <ul className="divide-y divide-ink-100">
                {archivos.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-ink-800">{f.nombre}</div>
                      <div className="text-xs text-ink-400">{tamano(f.tamano)}</div>
                    </div>
                    <Boton variante="secundario" className="shrink-0 px-3" onClick={() => void abrirArchivo(f)} aria-label={`Abrir ${f.nombre}`}>
                      Abrir
                    </Boton>
                    <Boton variante="peligro" className="shrink-0 px-3" onClick={() => void quitar(f.id)} aria-label={`Quitar ${f.nombre}`}>
                      Quitar
                    </Boton>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-sm text-ink-400">Todavía no has subido archivos.</div>
            )}
            <label className={`flex min-h-[48px] cursor-pointer items-center justify-center rounded-xl border border-dashed border-brand-400 bg-brand-500/5 px-4 text-sm font-semibold text-brand-600 ${subiendo ? 'opacity-50' : 'hover:bg-brand-500/10'}`}>
              <input type="file" multiple className="sr-only" onClick={() => (eligiendoArchivo.current = true)} onChange={(e) => void subir(e)} disabled={subiendo} />
              {subiendo ? 'Subiendo…' : 'Elegir archivos'}
            </label>
            {errorArchivos ? <div className="break-words text-sm text-red-600">{errorArchivos}</div> : null}
          </Tarjeta>
        ) : null}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
        {envioEnRiesgo && !enviando ? <div className={`mx-auto mb-2 ${ancho} text-center text-xs font-semibold text-red-600`}>Hay cambios sin guardar y no hay conexión</div> : null}
        {borradorListo && !estadoCola.sucio && !enviando ? (
          <div className={`mx-auto mb-2 flex ${ancho} flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-green-700`} role="status">
            <span>Borrador guardado.</span>
            {bloqueado ? (
              <span className="text-ink-500">La pantalla sigue bloqueada hasta que envíes.</span>
            ) : (
              <button type="button" className="min-h-[32px] font-semibold text-brand-600 underline" onClick={() => void salir()} disabled={saliendo}>
                Volver a mis actividades
              </button>
            )}
          </div>
        ) : null}
        <div className={`mx-auto flex ${ancho} gap-2`}>
          {asig.permite_borrador ? (
            <Boton variante="secundario" className="min-h-[48px] flex-1" onClick={() => void guardarBorrador()} disabled={enviando || estadoCola.fase === 'guardando'}>
              Guardar borrador
            </Boton>
          ) : null}
          <Boton className="min-h-[48px] flex-1" onClick={() => setModal(true)} disabled={enviando}>
            {enviando ? 'Enviando…' : 'Enviar'}
          </Boton>
        </div>
      </div>

      <Modal abierto={modal} titulo="¿Enviar la actividad?" onCerrar={() => setModal(false)}>
        <div className="space-y-4">
          {envioEnRiesgo ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              <div className="font-semibold">Hay cambios sin guardar y no hay conexión</div>
              <p className="mt-1">Al enviar se intentará subirlos primero. Si sigue sin red, el envío no se hará y podrás intentarlo de nuevo; tus respuestas siguen en este teléfono. No cierres esta página.</p>
            </div>
          ) : null}
          {candado ? (
            <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
              <div className="font-semibold">🔒 Tu docente pide contestar todas las preguntas para enviar</div>
              <div>{faltantes.length === 1 ? 'Te falta 1 pregunta:' : `Te faltan ${faltantes.length} preguntas:`}</div>
              <div className="flex flex-wrap gap-1.5">
                {faltantes.map((p) => (
                  <button key={p.indice} type="button" className="min-h-[36px] min-w-[44px] rounded-lg border border-red-300 bg-white px-2 font-semibold hover:bg-red-100" onClick={() => irA(p.indice)}>
                    {p.numero ?? p.indice + 1}
                  </button>
                ))}
              </div>
            </div>
          ) : sinResponder > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {sinResponder === 1 ? 'Queda 1 pregunta sin responder.' : `Quedan ${sinResponder} preguntas sin responder.`} Las preguntas en blanco no suman puntos.
            </div>
          ) : (
            <p className="text-sm text-ink-600">Respondiste las {total} preguntas.</p>
          )}
          {asig.permite_archivos ? <p className="text-sm text-ink-600">{archivos.length === 0 ? 'No has adjuntado archivos.' : `Adjuntaste ${archivos.length} archivo${archivos.length === 1 ? '' : 's'}.`}</p> : null}
          <p className="text-sm text-ink-600">Después de enviar ya no podrás cambiar tus respuestas.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Boton variante="secundario" className="flex-1" onClick={() => setModal(false)}>Seguir contestando</Boton>
            <Boton className="flex-1" onClick={() => void enviar()} disabled={candado} title={candado ? 'Contesta todas las preguntas para poder enviar' : undefined}>
              {candado ? '🔒 Enviar ahora' : 'Enviar ahora'}
            </Boton>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ---------- Página ----------

/** Contestar una actividad a pantalla completa: inicio, preguntas y resultado. */
export default function Actividad(): JSX.Element {
  const { id } = useParams()
  const [asig, setAsig] = useState<AsignacionParaAlumno | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bloqueo, setBloqueo] = useState<string | null>(null)
  const [iniciando, setIniciando] = useState(false)

  const cargar = useCallback((): void => {
    setAsig(null)
    setError(null)
    setBloqueo(null)
    api<AsignacionParaAlumno>(`/alumno/asignaciones/${id}`)
      .then(setAsig)
      .catch((e: Error) => setError(e.message))
  }, [id])
  useEffect(cargar, [cargar])

  const comenzar = async (): Promise<void> => {
    if (!asig) return
    // Debe pedirse dentro del clic; si el navegador lo niega, la actividad sigue igual
    if (asig.vigilancia) void pedirPantallaCompleta()
    setIniciando(true)
    try {
      setAsig(await api<AsignacionParaAlumno>(`/alumno/asignaciones/${id}/iniciar`, { metodo: 'POST' }))
    } catch (e) {
      const err = e as ErrorApi
      if (err.estado === 400) setBloqueo(err.message)
      else avisar(err.message, 'error')
    } finally {
      setIniciando(false)
    }
  }

  const alEnviar = useCallback((i: Intento): void => setAsig((a) => (a ? { ...a, intento: i, abierta: false } : a)), [])
  const alBloquear = useCallback((motivo: string): void => setBloqueo(motivo), [])

  // Ya entregada: el respaldo local de ese intento sobra
  const usuarioId = useSesion((s) => s.usuario?.id)
  const intentoEntregado = asig?.intento && entregado(asig.intento) ? asig.intento.id : null
  useEffect(() => {
    if (intentoEntregado !== null) borrarLocal(claveRespaldo(usuarioId, intentoEntregado))
  }, [intentoEntregado, usuarioId])

  if (bloqueo) return <PantallaMensaje titulo="No se puede continuar" texto={bloqueo} />
  if (error) return <PantallaMensaje titulo="No se pudo abrir la actividad" texto={error} reintentar={cargar} />
  if (!asig) {
    return (
      <div className="min-h-[100dvh] bg-ink-50">
        <Cargando texto="Abriendo la actividad…" />
      </div>
    )
  }
  const intento = asig.intento
  if (intento && entregado(intento)) return <PantallaResultado asig={asig} intento={intento} />
  if (intento && enCurso(intento)) {
    // Intento abierto pero la ventana ya se cerró (tiempo agotado, fecha límite o cierre del docente)
    if (!asig.abierta) return <PantallaMensaje titulo="No se puede continuar" texto={asig.motivo_cierre ?? 'La actividad está cerrada.'} />
    return <Contestar key={intento.id} asig={asig} intento={intento} preguntas={asig.preguntas ?? []} alEnviar={alEnviar} alBloquear={alBloquear} />
  }
  return <PantallaInicio asig={asig} iniciando={iniciando} comenzar={() => void comenzar()} />
}
