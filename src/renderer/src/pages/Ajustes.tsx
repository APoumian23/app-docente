import Respaldos from '../components/Respaldos'
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import Encabezado from '../components/Encabezado'
import { avisar } from '../components/Aviso'
import { TarjetaVersion } from '../components/Actualizacion'
import ClassroomAjustes from '../components/ClassroomAjustes'
import RegistroErrores from '../components/RegistroErrores'
import GastoIA from '../components/GastoIA'
import RequisitosPassword from '../components/RequisitosPassword'
import { problemaPassword } from '@shared/password'
import type { Ajustes as TAjustes } from '@shared/types'

/** Versión web: lo que es de la Mac (respaldos en su disco, convertir presentaciones, actualizar) no se muestra */
const WEB = window.api.plataforma === 'web'

/** Estado de algo configurado (llave, contraseña): verde si está, ámbar si falta. */
function Estado({ ok, si, no }: { ok: boolean; si: string; no: string }): JSX.Element {
  return (
    <span className={`chip gap-1.5 ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
      {ok ? si : no}
    </span>
  )
}

/** Título de un grupo de secciones (General, Datos y seguridad…). */
function Grupo({ titulo, nota }: { titulo: string; nota?: string }): JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1 pt-3">
      <h2 className="etiqueta">{titulo}</h2>
      {nota && <span className="text-xs text-ink-400">{nota}</span>}
    </div>
  )
}

export default function Ajustes(): JSX.Element {
  const [a, setA] = useState<(TAjustes & { api_key_configurada: boolean; api_key_nvidia_configurada: boolean; password_configurada: boolean; conversor: { tipo: 'libreoffice' | 'keynote'; detalle: string }; ruta_datos: string }) | null>(null)
  const [modelosNv, setModelosNv] = useState<{ id: string; nombre: string; nota: string; recomendado: boolean }[]>([])
  const [probando, setProbando] = useState(false)
  const [key, setKey] = useState('')
  const [pass, setPass] = useState({ actual: '', nueva: '', repetir: '' })
  const [passError, setPassError] = useState('')
  useEffect(() => {
    api.ajustes.leer().then(setA)
    api.ia.modelosNvidia().then(setModelosNv)
  }, [])
  if (!a) return <div className="p-8 text-ink-500">Cargando…</div>

  const probar = async (): Promise<void> => {
    if (!a) return
    setProbando(true)
    try {
      // Se guarda lo que está en pantalla antes de probar: de otro modo se probaría
      // contra el proveedor y la llave anteriores, que es justo lo que confunde.
      if (key) {
        await api.ia.guardarApiKey(key, a.proveedor_ia)
        setKey('')
        setA({ ...a, ...(a.proveedor_ia === 'nvidia' ? { api_key_nvidia_configurada: true } : { api_key_configurada: true }) })
      }
      await api.ajustes.guardar(a)
      const r = await api.ia.probar()
      avisar(`Conexión correcta. El modelo respondió: “${r}”`)
    } catch (e) {
      avisar((e as Error).message, 'error')
    } finally {
      setProbando(false)
    }
  }
  const guardarPass = async (): Promise<void> => {
    const problema = problemaPassword(pass.nueva)
    if (problema) return setPassError(problema)
    if (pass.nueva !== pass.repetir) return setPassError('Las contraseñas no coinciden.')
    try {
      await api.seguridad.establecer(pass.nueva, pass.actual || undefined)
      setPass({ actual: '', nueva: '', repetir: '' })
      setA({ ...a!, password_configurada: true })
      avisar('Contraseña de borrado guardada')
    } catch (e) {
      setPassError((e as Error).message)
    }
  }
  const quitarPass = async (): Promise<void> => {
    if (!pass.actual) return setPassError('Escribe la contraseña actual para quitar la protección.')
    if (!confirm('¿Quitar la protección? Sin contraseña no se podrán eliminar materias ni alumnos hasta definir una nueva.')) return
    try {
      await api.seguridad.quitar(pass.actual)
      setPass({ actual: '', nueva: '', repetir: '' })
      setA({ ...a!, password_configurada: false })
      avisar('Protección retirada')
    } catch (e) {
      setPassError((e as Error).message)
    }
  }
  const guardar = async (): Promise<void> => {
    await api.ajustes.guardar(a)
    if (key) {
      try {
        await api.ia.guardarApiKey(key, a.proveedor_ia)
      } catch (e) {
        return avisar((e as Error).message, 'error')
      }
      setKey('')
      setA({ ...a, ...(a.proveedor_ia === 'nvidia' ? { api_key_nvidia_configurada: true } : { api_key_configurada: true }) })
    }
    avisar('Ajustes guardados')
  }

  // Índice de la página: con el contenido largo se salta directo a la sección (botones, no enlaces: la app usa rutas con #)
  const ir = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const SECCIONES: [string, string][] = ([['ajustes-general', 'Docente y clase'], ['ajustes-ia', 'Inteligencia artificial'], ['ajustes-presentaciones', 'Presentaciones'], ['ajustes-seguridad', 'Seguridad y respaldos'], ['ajustes-integraciones', 'Classroom'], ['ajustes-errores', 'Errores'], ['ajustes-version', 'Versión']] as [string, string][]).filter(
    ([id]) => !WEB || (id !== 'ajustes-presentaciones' && id !== 'ajustes-version')
  )
  return (
    <div>
      <Encabezado
        titulo="Ajustes"
        sub="Docente, clase e IA se guardan con «Guardar ajustes»; las demás secciones se aplican con su propio botón."
        acciones={<button className="btn-primario" onClick={guardar}>Guardar ajustes</button>}
      />
      <div className="px-4 sm:px-8 py-5 max-w-3xl space-y-4">
        <nav className="flex flex-wrap gap-1.5" aria-label="Secciones de ajustes">
          {SECCIONES.map(([id, t]) => (
            <button key={id} type="button" className="chip whitespace-nowrap bg-white text-ink-600 ring-1 ring-ink-200 transition-colors hover:bg-ink-100" onClick={() => ir(id)}>{t}</button>
          ))}
        </nav>

        <Grupo titulo="General" nota="Se guarda con «Guardar ajustes»" />
        <section id="ajustes-general" className="tarjeta scroll-mt-28 p-5 space-y-4">
          <h3 className="font-semibold text-ink-900">Docente y clase</h3>
          <label className="block"><span className="etiqueta">Nombre del docente (aparece en exámenes y reportes)</span><input className="input" value={a.nombre_docente} onChange={(e) => setA({ ...a, nombre_docente: e.target.value })} /></label>
          <label className="block">
            <span className="etiqueta">Tolerancia para retardo</span>
            <span className="mt-1 flex items-center gap-2 text-sm text-ink-500">
              <input type="number" min={0} className="input w-24" value={a.tolerancia_retardo_min} onChange={(e) => setA({ ...a, tolerancia_retardo_min: Number(e.target.value) })} />
              minutos después del inicio de la clase
            </span>
          </label>
          <div className="space-y-2 border-t border-ink-100 pt-3 text-sm">
            <span className="etiqueta">Reloj del Modo clase</span>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={a.avanzar_auto} onChange={(e) => setA({ ...a, avanzar_auto: e.target.checked })} /> <span>Pasar automáticamente a la siguiente actividad cuando el reloj llega a cero</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={a.sonido} onChange={(e) => setA({ ...a, sonido: e.target.checked })} /> <span>Sonido a 10 segundos y al terminar cada actividad</span></label>
          </div>
        </section>
        <section id="ajustes-ia" className="tarjeta scroll-mt-28 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink-900">Inteligencia artificial</h3>
            {a.proveedor_ia === 'nvidia' ? (
              <Estado ok={a.api_key_nvidia_configurada} si="API key de NVIDIA configurada" no="Sin API key de NVIDIA" />
            ) : (
              <Estado ok={a.api_key_configurada} si="API key de Anthropic configurada" no="Sin API key de Anthropic" />
            )}
          </div>
          <div>
            <span className="etiqueta">Proveedor</span>
            <div className="mt-1 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2" role="radiogroup" aria-label="Proveedor de IA">
              {([['nvidia', 'NVIDIA (build.nvidia.com)', 'Modelos abiertos con créditos gratuitos.'], ['anthropic', 'Anthropic (Claude)', 'Mejor calidad, se paga por uso.']] as const).map(([v, t, d]) => (
                <button key={v} type="button" role="radio" aria-checked={a.proveedor_ia === v} onClick={() => setA({ ...a, proveedor_ia: v })} className={`text-left rounded-lg border px-3 py-2 transition-colors ${a.proveedor_ia === v ? 'border-brand-500 bg-brand-500/5 ring-1 ring-brand-500' : 'border-ink-200 hover:bg-ink-50'}`}>
                  <div className={`font-medium text-sm ${a.proveedor_ia === v ? 'text-brand-600' : 'text-ink-900'}`}>{t}</div>
                  <div className="text-xs text-ink-500">{d}</div>
                </button>
              ))}
            </div>
          </div>

          {a.proveedor_ia === 'nvidia' ? (
            <>
              <label className="block"><span className="etiqueta">{a.api_key_nvidia_configurada ? 'Reemplazar API key de NVIDIA' : 'API key de NVIDIA'}</span><input type="password" className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="nvapi-…" /></label>
              <p className="-mt-2 text-xs text-ink-500">Consigue la llave en build.nvidia.com: entra a cualquier modelo y pulsa “Get API Key”. Empieza con <code className="bg-ink-100 rounded px-1">nvapi-</code>.</p>
              <label className="block"><span className="etiqueta">Modelo</span>
                <select className="input" value={a.modelo_nvidia} onChange={(e) => setA({ ...a, modelo_nvidia: e.target.value })}>
                  <optgroup label="Recomendados para docencia">
                    {modelosNv.filter((m) => m.recomendado).map((m) => <option key={m.id} value={m.id}>{m.nombre} — {m.nota}</option>)}
                  </optgroup>
                  <optgroup label="Todo el catálogo de build.nvidia.com">
                    {modelosNv.filter((m) => !m.recomendado).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                  </optgroup>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="block"><span className="etiqueta">{a.api_key_configurada ? 'Reemplazar API key' : 'API key de Anthropic'}</span><input type="password" className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" /></label>
              <p className="-mt-2 text-xs text-ink-500">Consigue tu llave en console.anthropic.com → API Keys.</p>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
                <label className="block"><span className="etiqueta">Modelo principal</span>
                  <select className="input" value={a.modelo_ia} onChange={(e) => setA({ ...a, modelo_ia: e.target.value })}>
                    <option value="claude-opus-5-5">Claude Opus 5.5 — mejor calidad</option>
                    <option value="claude-sonnet-5-5">Claude Sonnet 5.5 — la mitad de costo</option>
                    <option value="claude-haiku-5-5">Claude Haiku 5.5 — el más económico</option>
                  </select>
                  <span className="mt-1 block text-xs text-ink-500">Exámenes, clases, apuntes, presentaciones y revisión de copias con esfuerzo alto; el asistente, con esfuerzo medio.</span>
                </label>
                <label className="block"><span className="etiqueta">Modelo para lo rutinario</span>
                  <select className="input" value={a.modelo_ia_rapido} onChange={(e) => setA({ ...a, modelo_ia_rapido: e.target.value })}>
                    <option value="claude-haiku-5-5">Claude Haiku 5.5 — el más económico</option>
                    <option value="claude-sonnet-5-5">Claude Sonnet 5.5 — la mitad de costo</option>
                    <option value="principal">Igual que el principal</option>
                  </select>
                  <span className="mt-1 block text-xs text-ink-500">Tareas, ejercicios, cuestionarios, glosario, plan de sesión y juego en vivo. Esfuerzo medio.</span>
                </label>
              </div>
              <label className="block"><span className="etiqueta">ID del workspace (opcional)</span><input className="input font-mono" value={a.workspace_anthropic} onChange={(e) => setA({ ...a, workspace_anthropic: e.target.value })} placeholder="wrkspc_…" /></label>
              <p className="-mt-2 text-xs text-ink-500">Si al probar dice que la llave no está ligada a un workspace, copia el ID en Settings → Workspaces y pégalo aquí.</p>
            </>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-ink-100 pt-3">
            <button className="btn-secundario" disabled={probando} onClick={probar}>{probando ? 'Probando…' : 'Probar conexión'}</button>
            <span className="min-w-0 flex-[1_1_16rem] text-xs text-ink-500">Guarda la llave y el modelo elegidos, y luego hace una petición de prueba.</span>
          </div>
          <p className="text-xs text-ink-500">
            {WEB
              ? 'Aquí la llave se guarda cifrada en el servidor. La de tu app de escritorio llega sola cada vez que la abres.'
              : 'La llave se guarda cifrada con el llavero de macOS.'}{' '}
            Puedes tener las dos configuradas y cambiar de proveedor cuando quieras.
          </p>
        </section>
        <div className="flex justify-end"><button className="btn-primario" onClick={guardar}>Guardar ajustes</button></div>
        <GastoIA />

        {!WEB && <>
        <Grupo titulo="Clase" />
        <section id="ajustes-presentaciones" className="tarjeta scroll-mt-28 p-5 space-y-2 text-sm">
          <h3 className="font-semibold text-ink-900">Presentaciones</h3>
          <p className="text-ink-600">
            Para proyectar un PowerPoint dentro del Modo clase se convierte a PDF una sola vez.
            Conversor detectado: <b>{a.conversor.tipo === 'libreoffice' ? 'LibreOffice' : 'Keynote'}</b>. {a.conversor.detalle}
          </p>
          {a.conversor.tipo === 'keynote' && (
            <p className="text-xs text-ink-500">Para instalarlo: <code className="bg-ink-100 rounded px-1 select-all">brew install --cask libreoffice</code></p>
          )}
          <p className="text-xs text-ink-500">La conversión se lanza desde la pestaña Materiales de cada materia, o desde el propio panel de Presentación en Modo clase.</p>
        </section>
        </>}

        <Grupo titulo="Datos y seguridad" nota="Cada sección se aplica con su propio botón" />
        <section id="ajustes-seguridad" className="tarjeta scroll-mt-28 p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink-900">Contraseña de borrado</h3>
            <Estado ok={a.password_configurada} si="Configurada" no="Sin configurar" />
          </div>
          <p className="text-sm text-ink-600">
            Se pide para eliminar una materia o un alumno, que son las acciones que borran asistencias y calificaciones.
            {!a.password_configurada && ' Mientras no la definas, esas eliminaciones quedan bloqueadas.'}
          </p>
          {a.password_configurada && (
            <label className="block max-w-sm"><span className="etiqueta">Contraseña actual</span><input type="password" className="input font-mono" value={pass.actual} onChange={(e) => { setPass({ ...pass, actual: e.target.value }); setPassError('') }} /></label>
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
            <label><span className="etiqueta">{a.password_configurada ? 'Nueva contraseña' : 'Contraseña'}</span><input type="password" className="input font-mono" value={pass.nueva} onChange={(e) => { setPass({ ...pass, nueva: e.target.value }); setPassError('') }} autoComplete="new-password" /></label>
            <label><span className="etiqueta">Repetir</span><input type="password" className="input font-mono" value={pass.repetir} onChange={(e) => { setPass({ ...pass, repetir: e.target.value }); setPassError('') }} /></label>
          </div>
          <RequisitosPassword password={pass.nueva} repetir={pass.repetir} />
          {passError && <p className="text-sm text-red-600" role="alert">{passError}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {a.password_configurada ? (
              <button className="btn-peligro" onClick={quitarPass}>Quitar protección</button>
            ) : <span />}
            <button className="btn-primario" onClick={guardarPass}>{a.password_configurada ? 'Cambiar contraseña' : 'Definir contraseña'}</button>
          </div>
          <p className="text-xs text-ink-500">Se guarda solo un hash scrypt con sal aleatoria; la contraseña nunca queda escrita en la base ni en un archivo. Si la olvidas no hay recuperación: habría que borrar el ajuste desde la base de datos.</p>
        </section>
        {WEB ? (
          <section className="tarjeta p-5 space-y-2 text-sm">
            <h3 className="font-semibold text-ink-900">Respaldos de tu información</h3>
            <p className="text-ink-600">Tu información vive en el servidor y en tu Mac, que se mantienen iguales solas. El servidor se respalda solo cada día; los respaldos de tu Mac, la copia en otra carpeta y restaurar se manejan en la app de escritorio.</p>
          </section>
        ) : (
          <Respaldos rutaDatos={a.ruta_datos} />
        )}

        <Grupo titulo="Integraciones" />
        <div id="ajustes-integraciones" className="scroll-mt-28">
          <ClassroomAjustes />
        </div>

        <Grupo titulo="Diagnóstico" />
        <RegistroErrores />

        {!WEB && <>
        <Grupo titulo="Acerca de la app" />
        <div id="ajustes-version" className="scroll-mt-28">
          <TarjetaVersion />
        </div>
        </>}
      </div>
    </div>
  )
}
