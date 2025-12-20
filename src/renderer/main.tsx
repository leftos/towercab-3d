import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/styles/global.css'
import { registerTileCacheServiceWorker } from './utils/serviceWorkerRegistration'

// Register service worker for tile caching
// This caches tiles at the HTTP layer, transparent to Cesium
registerTileCacheServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
