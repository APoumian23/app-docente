import { Routes, Route, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { usePreferencia } from './lib/preferencia'
import Hoy from './pages/Hoy'
import ModoClase from './pages/ModoClase'
import Materias from './pages/Materias'
import MateriaDetalle from './pages/MateriaDetalle'
import Alumnos from './pages/Alumnos'
import AlumnoDetalle from './pages/AlumnoDetalle'
import Horario from './pages/Horario'
import EstudioIA from './pages/EstudioIA'
import Programar from './pages/Programar'
import Asistente from './pages/Asistente'
import Asistencias from './pages/Asistencias'
import { iniciarAsistente } from './store/asistente'
import EvaluacionVista from './pages/EvaluacionVista'
import Ajustes from './pages/Ajustes'
import Portal from './pages/Portal'
import PanelPortal from './pages/PanelPortal'
import { api } from './lib/api'
import Ayuda from './pages/Ayuda'
import Classroom from './pages/Classroom'
import Fechas from './pages/Fechas'
import { useClase } from './store/clase'
import { fmtMinSeg } from './lib/tiempo'
import Aviso, { avisar } from './components/Aviso'
import { esFalla } from './components/RegistroErrores'
import { ORIGENES_ERROR } from '@shared/errores'
import { AvisoActualizacion } from './components/Actualizacion'
import LimiteError from './components/LimiteError'

const NAV = [
  { a: '/', t: 'Hoy', i: '◉' },
  { a: '/clase', t: 'Modo clase', i: '⏱' },
  { a: '/materias', t: 'Materias', i: '▤' },
  { a: '/alumnos', t: 'Alumnos', i: '☺' },
  { a: '/asistencias', t: 'Asistencias', i: '☑' },
  { a: '/horario', t: 'Horario', i: '▦' },
  { a: '/ia', t: 'Estudio IA', i: '✦' },
  { a: '/asistente', t: 'Asistente', i: '💬' },
  { a: '/programar', t: 'Programar', i: '⌨' },
  { a: '/portal', t: 'Portal', i: '◎' },
  { a: '/ajustes', t: 'Ajustes', i: '⚙' },
  { a: '/ayuda', t: 'Ayuda', i: '?' }
]

/** Pantallas fuera del menú que se resaltan bajo la entrada a la que pertenecen. */
const PADRE_DE: { prefijo: string; a: string }[] = [
  { prefijo: '/fechas', a: '/' },
  { prefijo: '/classroom', a: '/materias' },
  { prefijo: '/evaluacion/', a: '/materias' },
  { prefijo: '/panel', a: '/portal' }
]

export default function App(): JSX.Element {
  const loc = useLocation()
  const nav = useNavigate()
  const padre = PADRE_DE.find((p) => loc.pathname === p.prefijo || loc.pathname.startsWith(p.prefijo.endsWith('/') ? p.prefijo : `${p.prefijo}/`))?.a
  const enClase = loc.pathname.startsWith('/clase')
  // Solo si hay clase cargada: el conteo vive en <RelojNav> para no repintar toda la app cada segundo
  const hayClase = useClase((s) => s.sesion !== null)
  const [reloj, setReloj] = useState('')
  const [noLeidas, setNoLeidas] = useState(0)
  const [erroresNuevos, setErroresNuevos] = useState(0)
  // Barra lateral en pantallas anchas: desplegada o plegada (solo íconos), y fija o flotante. Flotante = se ve
  // plegada y se despliega encima del contenido al pasar el mouse, sin quitarle espacio
  const [plegada, setPlegada] = usePreferencia('menu.plegada', false)
  const [fija, setFija] = usePreferencia('menu.fija', true)
  const [encima, setEncima] = useState(false)
  const angosta = fija ? plegada : !encima
  // En pantallas angostas (celular) la barra lateral se abre como menú encima del contenido
  const [menu, setMenu] = useState(false)
  useEffect(() => setMenu(false), [loc.pathname])
  useEffect(() => {
    if (!menu) return
    const tecla = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [menu])
  const seccion = NAV.find((n) => (n.a === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.a)) || padre === n.a)?.t ?? ''
  // Tamaño del contenido (no de la barra lateral): 80 % a 180 %, se recuerda en este equipo.
  // Va encima del ajuste automático por ancho de ventana. Antes de ese ajuste se bajaba a 80 % en monitores
  // grandes y la letra quedaba diminuta: una sola vez se regresa a 100 %.
  const [zoom, setZoom] = useState(() => {
    try {
      if (!localStorage.getItem('docente.zoom.auto')) {
        localStorage.setItem('docente.zoom.auto', '1')
        if (Number(localStorage.getItem('docente.zoom')) < 1) localStorage.setItem('docente.zoom', '1')
      }
      return Number(localStorage.getItem('docente.zoom')) || 1
    } catch {
      return 1
    }
  })
  useEffect(() => {
    const cambiar = (paso: number): void =>
      setZoom((z) => {
        const nuevo = paso === 0 ? 1 : Math.min(1.8, Math.max(0.8, Math.round((z + paso * 0.1) * 10) / 10))
        localStorage.setItem('docente.zoom', String(nuevo))
        return nuevo
      })
    const quitar = window.api.escuchar('ui:zoom', (paso) => cambiar(Number(paso)))
    const teclas = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') { e.preventDefault(); cambiar(1) }
      else if (e.key === '-') { e.preventDefault(); cambiar(-1) }
      else if (e.key === '0') { e.preventDefault(); cambiar(0) }
    }
    window.addEventListener('keydown', teclas)
    ;(window as unknown as { cambiarZoom: (p: number) => void }).cambiarZoom = cambiar
    return () => { quitar(); window.removeEventListener('keydown', teclas) }
  }, [])
  const cambiarZoom = (p: number): void => (window as unknown as { cambiarZoom: (p: number) => void }).cambiarZoom(p)
  // Contador de avisos del portal: se refresca solo y al llegar novedades
  useEffect(() => {
    const leer = (): void => { api.portal.estado().then((e) => setNoLeidas(e.no_leidas)).catch(() => undefined) }
    leer()
    const t = setInterval(leer, 30_000)
    const quitar = api.portal.alRecibir(() => leer())
    const alVolver = (): void => leer()
    window.addEventListener('portal:leidas', alVolver)
    return () => { clearInterval(t); quitar(); window.removeEventListener('portal:leidas', alVolver) }
  }, [])
  // Errores de la app: contador en Ajustes y aviso al momento de lo que falla fuera de la pantalla
  // (las pantallas ya muestran sus propios errores; aquí entran la sincronización y el proceso principal)
  useEffect(() => {
    const contar = (): void => { api.errores.listar().then((l) => setErroresNuevos(l.filter((e) => esFalla(e) && !e.revisado).length)).catch(() => undefined) }
    contar()
    const quitar = api.errores.alNuevo((e) => {
      contar()
      if (e.origen === 'principal' || e.origen === 'ventana' || e.origen === 'sincronizacion') avisar(`${ORIGENES_ERROR[e.origen]}: ${e.mensaje} · detalle en Ajustes › Errores`, 'error')
    })
    window.addEventListener('errores:revisados', contar)
    return () => { quitar(); window.removeEventListener('errores:revisados', contar) }
  }, [])
  // El proceso principal pide ver una pantalla del panel (p. ej. al tocar el aviso de una entrega)
  useEffect(() => api.portal.alVerPanel((ruta) => nav(`/panel?ruta=${encodeURIComponent(ruta)}`)), [nav])
  // El Asistente responde en segundo plano: se escucha desde que abre la app, no solo en su pantalla
  useEffect(() => iniciarAsistente(), [])
  useEffect(() => {
    const f = (): void => setReloj(new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' }))
    f()
    const t = setInterval(f, 1000 * 15)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-full flex-col md:flex-row">
      {!enClase && (
        <header className="md:hidden arrastre h-12 shrink-0 flex items-center gap-2 border-b border-ink-200 bg-white pl-20 pr-3">
          <button className="no-arrastre w-9 h-9 rounded-lg text-xl leading-none text-ink-700 hover:bg-ink-100" onClick={() => setMenu(true)} aria-label="Abrir el menú" aria-expanded={menu}>
            ☰
          </button>
          <span className="truncate font-semibold text-ink-800">{seccion}</span>
          {noLeidas > 0 && <span className="ml-auto rounded-full bg-red-500 text-white text-[11px] font-semibold px-1.5 min-w-[20px] text-center" title="Avisos del portal">{noLeidas}</span>}
        </header>
      )}
      {!enClase && menu && <div className="md:hidden fixed inset-0 z-30 bg-ink-900/30" onClick={() => setMenu(false)} aria-hidden />}
      {!enClase && (
        // Hueco que ocupa la barra en pantallas anchas: la barra va encima (fixed) para poder desplegarse sin mover el contenido
        <div className={`hidden md:block shrink-0 transition-[width] duration-200 ${fija && !plegada ? 'w-56' : 'w-[4.5rem]'}`} aria-hidden />
      )}
      {!enClase && (
        <aside
          onMouseEnter={() => !fija && setEncima(true)}
          onMouseLeave={() => setEncima(false)}
          onFocus={() => !fija && setEncima(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setEncima(false)}
          className={`fixed inset-y-0 left-0 z-40 w-64 max-w-[85vw] shadow-xl transition-[transform,width] duration-200 md:z-40 md:max-w-none md:translate-x-0 ${angosta ? 'md:w-[4.5rem]' : 'md:w-56'} ${!fija && encima ? 'md:shadow-xl' : 'md:shadow-none'} ${menu ? 'translate-x-0' : '-translate-x-full'} border-r border-ink-200 bg-white flex flex-col overflow-y-auto overflow-x-hidden`}
          aria-label="Menú"
        >
          {/* Los botones de la ventana (cerrar, minimizar, ampliar) ocupan la primera franja: el nombre va debajo, nunca encima */}
          <div className={`arrastre shrink-0 pt-11 pb-1.5 ${angosta ? 'px-4 md:px-2' : 'px-4'}`}>
            <span className={`text-[11px] font-semibold tracking-widest text-ink-400 ${angosta ? 'md:hidden' : ''}`}>APP DOCENTE</span>
            {/* Plegar y fijar: solo en pantallas anchas (en celular la barra es un menú que se abre con ☰) */}
            <div className={`no-arrastre mt-1 hidden gap-1 md:flex ${angosta ? 'flex-col items-center' : ''}`}>
              {fija && (
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-800"
                  onClick={() => setPlegada((v) => !v)}
                  aria-label={plegada ? 'Desplegar el menú' : 'Plegar el menú'}
                  title={plegada ? 'Desplegar el menú' : 'Plegar el menú (solo íconos)'}
                >
                  {plegada ? '»' : '«'}
                </button>
              )}
              <button
                className={`flex h-7 w-7 items-center justify-center rounded-md hover:bg-ink-100 ${fija ? 'text-brand-600' : 'text-ink-400'}`}
                onClick={() => {
                  setFija((v) => !v)
                  setEncima(false)
                }}
                aria-pressed={fija}
                aria-label={fija ? 'Soltar el menú' : 'Fijar el menú'}
                title={fija ? 'Soltar: el menú queda plegado y se despliega al pasar el mouse' : 'Fijar el menú en su lugar'}
              >
                {fija ? '📌' : '📍'}
              </button>
            </div>
          </div>
          <nav className={`py-2 space-y-0.5 no-arrastre ${angosta ? 'px-2 md:px-1.5' : 'px-2'}`}>
            {NAV.map((n) => (
              <NavLink
                key={n.a}
                to={n.a}
                end={n.a === '/'}
                title={angosta ? n.t : undefined}
                className={({ isActive }) => `relative flex items-center gap-2.5 rounded-lg py-2 text-sm ${angosta ? 'px-3 md:justify-center md:px-0' : 'px-3'} ${isActive || padre === n.a ? 'bg-brand-500 text-white' : 'text-ink-700 hover:bg-ink-100'}`}
              >
                <span className="w-4 shrink-0 text-center opacity-80">{n.i}</span>
                <span className={`whitespace-nowrap ${angosta ? 'md:sr-only' : ''}`}>{n.t}</span>
                {n.a === '/portal' && noLeidas > 0 && <span className={`ml-auto rounded-full bg-red-500 text-white text-[11px] font-semibold px-1.5 min-w-[20px] text-center ${angosta ? 'md:absolute md:right-0.5 md:top-0.5 md:min-w-[16px] md:px-1 md:text-[9px]' : ''}`}>{noLeidas}</span>}
                {n.a === '/ajustes' && erroresNuevos > 0 && <span className={`ml-auto rounded-full bg-red-500 text-white text-[11px] font-semibold px-1.5 min-w-[20px] text-center ${angosta ? 'md:absolute md:right-0.5 md:top-0.5 md:min-w-[16px] md:px-1 md:text-[9px]' : ''}`} title="Errores sin revisar (Ajustes › Errores)">{erroresNuevos}</span>}
                {n.a === '/clase' && hayClase && <span className={angosta ? 'md:hidden ml-auto' : 'ml-auto'}><RelojNav /></span>}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto" />
          <div className={angosta ? 'md:hidden' : ''}><AvisoActualizacion /></div>
          <div className={`px-4 py-3 text-xs text-ink-400 border-t border-ink-100 no-arrastre ${angosta ? 'md:hidden' : ''}`}>
            <div className="flex items-center justify-between mb-2" title="Tamaño del contenido (⌘+ / ⌘- / ⌘0). Además, en ventanas grandes toda la app crece sola.">
              <span>Texto {Math.round(zoom * 100)}%</span>
              <span className="flex gap-1">
                <button className="w-6 h-6 rounded border border-ink-200 text-ink-700 hover:bg-ink-100" onClick={() => cambiarZoom(-1)} aria-label="Contenido más pequeño">−</button>
                <button className="w-6 h-6 rounded border border-ink-200 text-ink-700 hover:bg-ink-100" onClick={() => cambiarZoom(1)} aria-label="Contenido más grande">+</button>
              </span>
            </div>
            <div className="font-mono text-base text-ink-700">{reloj}</div>
            <div>Ciudad de México</div>
          </div>
        </aside>
      )}
      {/* --zoom permite a una pantalla compensar medidas que deben quedar fijas en la ventana (p. ej. el hueco de los semáforos de macOS) */}
      <main className="flex-1 min-w-0 overflow-y-auto" style={{ zoom, ['--zoom' as string]: zoom }}>
        <LimiteError ruta={loc.pathname} alInicio={() => nav('/')}>
          <Routes>
            <Route path="/" element={<Hoy />} />
            <Route path="/clase" element={<ModoClase />} />
            <Route path="/clase/:sesionId" element={<ModoClase />} />
            <Route path="/materias" element={<Materias />} />
            <Route path="/materias/:id" element={<MateriaDetalle />} />
            <Route path="/alumnos" element={<Alumnos />} />
            <Route path="/alumnos/:id" element={<AlumnoDetalle />} />
            <Route path="/horario" element={<Horario />} />
            <Route path="/fechas" element={<Fechas />} />
            <Route path="/ia" element={<EstudioIA />} />
            <Route path="/programar" element={<Programar />} />
          <Route path="/asistente" element={<Asistente />} />
          <Route path="/asistencias" element={<Asistencias />} />
            <Route path="/ia/:materiaId" element={<EstudioIA />} />
            <Route path="/evaluacion/:id" element={<EvaluacionVista />} />
            <Route path="/portal" element={<Portal />} />
            <Route path="/panel" element={<PanelPortal />} />
            <Route path="/ajustes" element={<Ajustes />} />
            <Route path="/classroom" element={<Classroom />} />
            <Route path="/ayuda" element={<Ayuda />} />
            <Route path="*" element={<NoExiste />} />
          </Routes>
        </LimiteError>
      </main>
      <Aviso />
    </div>
  )
}

/** Dirección que no corresponde a ninguna pantalla (p. ej. un enlace viejo). */
function NoExiste(): JSX.Element {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="tarjeta w-full max-w-md p-6 text-center">
        <h1 className="text-lg font-semibold text-ink-900">Esa pantalla no existe</h1>
        <p className="mt-1 text-sm text-ink-500">Puede ser un enlace viejo. Usa el menú de la izquierda o vuelve a Hoy.</p>
        <Link to="/" className="btn-primario mt-5">
          Ir a Hoy
        </Link>
      </div>
    </div>
  )
}

function RelojNav(): JSX.Element {
  const corriendo = useClase((s) => s.corriendo)
  const restante = useClase((s) => s.restante)
  return <span className={`ml-auto font-mono text-xs ${corriendo ? 'pulso' : 'opacity-60'}`}>{fmtMinSeg(restante)}</span>
}
