import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted, so they work offline (TYL-148).
import '@fontsource/caprasimo/400.css'
import '@fontsource/figtree/400.css'
import '@fontsource/figtree/600.css'
import '@fontsource/figtree/700.css'
import './index.css'
import App from './App.tsx'
import { registerSW } from 'virtual:pwa-register'
import { startTelemetry } from './telemetry.ts'
import { listenForInstall } from './install.ts'

registerSW({ immediate: true })
void startTelemetry()
listenForInstall()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
