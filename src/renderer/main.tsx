import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/styles/global.css'
import { registerTileCacheServiceWorker } from './utils/serviceWorkerRegistration'

// Suppress Cesium render loop console spam
// Cesium logs on every requestAnimationFrame which clutters the console
const originalLog = console.log
console.log = (...args: unknown[]) => {
  // Filter out Cesium render loop logs (typically just "requestAnimationFrame" or empty)
  if (args.length === 0) return
  if (args.length === 1 && args[0] === 'requestAnimationFrame') return
  originalLog.apply(console, args)
}

// Register service worker for tile caching
// This caches tiles at the HTTP layer, transparent to Cesium
registerTileCacheServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
