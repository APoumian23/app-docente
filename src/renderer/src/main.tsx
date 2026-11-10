import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import LimiteError from './components/LimiteError'
import './index.css'
import 'katex/dist/katex.min.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Respaldo por si truena algo fuera del contenido (p. ej. la barra lateral); el contenido tiene su propio límite en App */}
    <LimiteError>
      <HashRouter>
        <App />
      </HashRouter>
    </LimiteError>
  </React.StrictMode>
)
