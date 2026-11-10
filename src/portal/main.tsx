import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import LimiteError, { recargarPorModulo } from './componentes/LimiteError'
import { escucharInstalacion, registrarServiceWorker } from './lib/push'
import './estilos.css'
import 'katex/dist/katex.min.css'

// Vite avisa antes de que truene un import dinámico (archivo viejo tras actualizar): se recarga una vez.
// Si ya se recargó hace poco, se deja seguir el error para que el límite muestre el aviso con botones.
window.addEventListener('vite:preloadError', (e) => {
  if (recargarPorModulo()) e.preventDefault()
})

// Dentro de la app de escritorio (página «Panel del portal»): la app pone su propio menú, el panel no repite el suyo
try {
  if (new URLSearchParams(location.search).get('incrustado') === '1') sessionStorage.setItem('docente.incrustado', '1')
} catch {
  /* sin almacenamiento: se ve como siempre */
}

// Instalable como app y con notificaciones push (el service worker no guarda caché)
escucharInstalacion()
registrarServiceWorker()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LimiteError>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LimiteError>
  </React.StrictMode>
)
