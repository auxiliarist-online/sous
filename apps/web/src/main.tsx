import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { startErrorReporting } from './errors.ts'
import { listenForInstall } from './install.ts'

registerSW({ immediate: true })
void startErrorReporting()
listenForInstall()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
