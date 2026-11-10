import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { enMarco, irAlApp, useSesion } from './lib/sesion'
import { api } from './lib/api'
import type { SesionWeb } from '@shared/portal'
import { Cargando, Vacio, avisar } from './componentes/ui'
import Marco from './componentes/Marco'
import { Avisos } from './componentes/ui'
import Entrar from './paginas/Entrar'
import Cuenta from './paginas/Cuenta'
import Notificaciones from './paginas/Notificaciones'
import Actividades from './paginas/alumno/Actividades'
import Actividad from './paginas/alumno/Actividad'
import Calificaciones from './paginas/alumno/Calificaciones'
import MiAvance from './paginas/alumno/MiAvance'
import ProgramarAlumno from './paginas/alumno/Programar'
import TareasAlumno from './paginas/alumno/Tareas'
import MaterialesAlumno from './paginas/alumno/Materiales'
import CalendarioAlumno from './paginas/alumno/Calendario'
import { useProteccionAlumno } from './componentes/Proteccion'
// El panel docente y el juego se descargan solo si se usan: el celular del alumno no carga
// pantallas que nunca verá (40 celulares bajando todo a la vez saturaban el Wi-Fi del salón)
const Inicio = lazy(() => import('./paginas/docente/Inicio'))
const Materia = lazy(() => import('./paginas/docente/Materia'))
const Publicar = lazy(() => import('./paginas/docente/Publicar'))
const Entregas = lazy(() => import('./paginas/docente/Entregas'))
const Intento = lazy(() => import('./paginas/docente/Intento'))
const AsistenciaDocente = lazy(() => import('./paginas/docente/Asistencia'))
const CalificacionesDocente = lazy(() => import('./paginas/docente/Calificaciones'))
// El cuaderno trae el editor de código y Python: solo lo descarga quien abre uno
const CuadernoAlumno = lazy(() => import('./paginas/alumno/Cuaderno'))
const JuegoEntrar = lazy(() => import('./paginas/juego/JuegoEntrar'))
const Jugar = lazy(() => import('./paginas/juego/Jugar'))
const Anfitrion = lazy(() => import('./paginas/juego/Anfitrion'))

// En celular la barra de abajo lleva a lo sumo seis; Calendario, Mi avance y Cuenta («soloArriba») pasan a la barra superior
const PESTANAS_ALUMNO: { a: string; t: string; icono: string; tambien?: string[]; soloArriba?: boolean }[] = [
  { a: '/', t: 'Actividades', icono: '📝' },
  { a: '/tareas', t: 'Tareas', icono: '📤' },
  { a: '/materiales', t: 'Materiales', icono: '📚' },
  { a: '/calendario', t: 'Calendario', icono: '📅', soloArriba: true },
  { a: '/calificaciones', t: 'Calificaciones', icono: '📊' },
  { a: '/avance', t: 'Mi avance', icono: '⭐', soloArriba: true },
  { a: '/juego', t: 'Jugar', icono: '🎮' },
  { a: '/programar', t: 'Programar', icono: '⌨' },
  { a: '/cuenta', t: 'Cuenta', icono: '👤', soloArriba: true }
]
const PESTANAS_DOCENTE = [
  { a: '/docente', t: 'Materias', icono: '▤' },
  { a: '/docente/entregas', t: 'Entregas', icono: '📥' },
  { a: '/docente/notificaciones', t: 'Avisos', icono: '🔔' },
  { a: '/cuenta', t: 'Cuenta', icono: '👤' }
]

/** Exige sesión y, si se indica, un rol. Redirige al inicio de sesión conservando el destino. */
function Protegida({ rol }: { rol?: 'alumno' | 'docente' }): JSX.Element {
  const { usuario } = useSesion()
  const loc = useLocation()
  if (!usuario) return <Navigate to="/entrar" state={{ desde: loc.pathname + loc.search }} replace />
  if (rol && usuario.rol !== rol) {
    // El docente en la portada de los alumnos (p. ej. con una sesión de antes): a la app completa, que es su inicio
    if (usuario.rol === 'docente' && loc.pathname === '/' && !enMarco()) {
      irAlApp(usuario)
      return <></>
    }
    // Los avisos tienen ruta distinta por rol: se lleva a la del rol correcto en vez de al inicio
    if (loc.pathname === '/notificaciones' && usuario.rol === 'docente') return <Navigate to="/docente/notificaciones" replace />
    return <Navigate to={usuario.rol === 'docente' ? '/docente' : '/'} replace />
  }
  // Con contraseña inicial o que no cumple la regla segura no se puede hacer nada hasta cambiarla
  if (usuario.debe_cambiar && loc.pathname !== '/cuenta') return <Navigate to="/cuenta?primera=1" state={{ desde: loc.pathname + loc.search }} replace />
  return <Outlet />
}

interface EstadoAlumno {
  examen: boolean
  /** Examen con la pantalla bloqueada por el docente: mientras exista, el alumno solo puede estar ahí */
  bloqueo: { asignacion_id: number; intento_id: number | null } | null
  /** Alguna de sus materias usa «Programar» (el docente la apaga por materia) */
  programar: boolean
}

/**
 * Modo examen: mientras el alumno tiene un examen abierto no ve Programar ni Jugar (el servidor
 * tampoco deja usar Programar). Se revisa al cambiar de pantalla y cada 30 s.
 */
function useEstadoAlumno(activo: boolean): EstadoAlumno | null {
  const [estado, setEstado] = useState<EstadoAlumno | null>(null)
  const loc = useLocation()
  useEffect(() => {
    if (!activo) return
    let vivo = true
    const leer = (): void => void api<EstadoAlumno>('/alumno/estado').then((r) => vivo && setEstado(r)).catch(() => undefined)
    leer()
    // Cada 10 s: si el docente bloquea la pantalla del examen, el alumno pasa a él sin tardar
    const t = setInterval(leer, 10_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [activo, loc.pathname])
  return estado
}

function ConMarcoAlumno(): JSX.Element {
  const estado = useEstadoAlumno(true)
  // Pantalla bloqueada: ninguna otra parte del portal, solo el examen (hasta enviarlo o que el docente lo quite)
  if (estado?.bloqueo) return <Navigate to={`/actividad/${estado.bloqueo.asignacion_id}`} replace />
  const ocultas = new Set<string>()
  if (estado?.examen) ['/programar', '/juego', '/tareas'].forEach((a) => ocultas.add(a))
  if (estado && !estado.programar) ocultas.add('/programar')
  return <ConMarco pestanas={PESTANAS_ALUMNO.filter((p) => !ocultas.has(p.a))} />
}

/** Programar solo existe si alguna de sus materias lo usa; si entra por la dirección, se le explica. */
function ProgramarSiAplica(): JSX.Element {
  const estado = useEstadoAlumno(true)
  if (!estado) return <Cargando />
  if (!estado.programar) return <Vacio titulo="Programar no está activo" detalle="Ninguna de tus materias usa el editor de código. Si lo necesitas, pídeselo a tu docente." />
  return <ProgramarAlumno />
}

/** Dirección que no existe: avisa y lleva al inicio (no deja la pantalla en blanco). */
function NoExiste({ a }: { a: string }): JSX.Element {
  useEffect(() => avisar('Esa página no existe; te llevamos al inicio.', 'info'), [])
  return <Navigate to={a} replace />
}

function ConMarco({ pestanas }: { pestanas: typeof PESTANAS_ALUMNO }): JSX.Element {
  return (
    <Marco pestanas={pestanas}>
      <Outlet />
    </Marco>
  )
}

/** Códigos ya enviados a canjear: el modo estricto de React corre el efecto dos veces y el segundo canje fallaría. */
const canjeados = new Set<string>()

/**
 * La app de escritorio abre el panel con `?codigo=`: un código de un solo uso que caduca en 60 s.
 * Se quita de la dirección en cuanto se lee (no queda en el historial) y se canjea por una sesión.
 */
function useCodigoDeApp(): boolean {
  const nav = useNavigate()
  const { entrar } = useSesion()
  const [codigo] = useState(() => new URLSearchParams(window.location.search).get('codigo'))
  const [listo, setListo] = useState(!codigo)
  useEffect(() => {
    if (!codigo || canjeados.has(codigo)) return
    canjeados.add(codigo)
    const params = new URLSearchParams(window.location.search)
    params.delete('codigo')
    const limpia = { pathname: window.location.pathname, search: params.toString() }
    window.history.replaceState(window.history.state, '', `${limpia.pathname}${limpia.search ? `?${limpia.search}` : ''}${window.location.hash}`)
    api<{ sesion: SesionWeb }>('/auth/canjear', { metodo: 'POST', cuerpo: { codigo }, sinSesion: true })
      .then((r) => entrar(r.sesion.token, r.sesion.usuario))
      .catch((e) => useSesion.getState().cerrar((e as Error).message || 'El enlace de acceso no es válido o expiró.'))
      .finally(() => {
        // El enrutador también olvida el código
        nav(limpia, { replace: true })
        setListo(true)
      })
  }, [codigo, entrar, nav])
  return listo
}

export default function App(): JSX.Element {
  const { usuario } = useSesion()
  const listo = useCodigoDeApp()
  useProteccionAlumno(usuario?.rol === 'alumno')
  if (!listo) return <Cargando texto="Abriendo sesión…" />
  return (
    <>
      <Suspense fallback={<Cargando />}>
        <Routes>
          <Route path="/entrar" element={usuario ? <Navigate to={usuario.rol === 'docente' ? '/docente' : '/'} replace /> : <Entrar />} />
          {/* El juego se puede jugar sin cuenta: solo con el PIN */}
          <Route path="/juego" element={<JuegoEntrar />} />
          <Route path="/juego/:pin" element={<Jugar />} />

          <Route element={<Protegida />}>
            <Route element={<ConMarco pestanas={usuario?.rol === 'docente' ? PESTANAS_DOCENTE : PESTANAS_ALUMNO} />}>
              <Route path="/cuenta" element={<Cuenta />} />
            </Route>
          </Route>

          <Route element={<Protegida rol="alumno" />}>
            <Route element={<ConMarcoAlumno />}>
              <Route path="/" element={<Actividades />} />
              <Route path="/calificaciones" element={<Calificaciones />} />
              <Route path="/avance" element={<MiAvance />} />
              <Route path="/programar" element={<ProgramarSiAplica />} />
              <Route path="/tareas" element={<TareasAlumno />} />
              <Route path="/materiales" element={<MaterialesAlumno />} />
              <Route path="/cuaderno/:id" element={<CuadernoAlumno />} />
              <Route path="/calendario" element={<CalendarioAlumno />} />
              <Route path="/notificaciones" element={<Notificaciones />} />
            </Route>
            {/* La actividad se contesta a pantalla completa, sin la navegación del marco */}
            <Route path="/actividad/:id" element={<Actividad />} />
          </Route>

          <Route element={<Protegida rol="docente" />}>
            <Route element={<ConMarco pestanas={PESTANAS_DOCENTE} />}>
              <Route path="/docente" element={<Inicio />} />
              <Route path="/docente/materias/:id" element={<Materia />} />
              <Route path="/docente/publicar/:materiaId" element={<Publicar />} />
              <Route path="/docente/asistencia/:materiaId" element={<AsistenciaDocente />} />
              <Route path="/docente/calificaciones/:materiaId" element={<CalificacionesDocente />} />
              <Route path="/docente/entregas" element={<Entregas />} />
              <Route path="/docente/asignaciones/:id" element={<Entregas />} />
              <Route path="/docente/intentos/:id" element={<Intento />} />
              <Route path="/docente/notificaciones" element={<Notificaciones />} />
            </Route>
            <Route path="/docente/juego/:pin" element={<Anfitrion />} />
          </Route>

          <Route path="*" element={usuario ? <NoExiste a={usuario.rol === 'docente' ? '/docente' : '/'} /> : <Navigate to="/entrar" replace />} />
        </Routes>
      </Suspense>
      <Avisos />
    </>
  )
}
