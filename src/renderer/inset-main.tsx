/**
 * Entry point for inset iframe app
 *
 * This is a minimal React app that renders only a CesiumViewer in inset mode.
 * It receives data from the main app via SharedWorker and communicates camera
 * state changes back via postMessage.
 *
 * URL parameters:
 * - viewportId: Unique ID for this inset viewport (required)
 * - parentOrigin: Origin of the parent window for postMessage security (required)
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import InsetApp from './components/InsetApp'
import './assets/styles/global.css'

// Parse URL parameters
const urlParams = new URLSearchParams(window.location.search)
const viewportId = urlParams.get('viewportId')
const parentOrigin = urlParams.get('parentOrigin')

// Validate required parameters
if (!viewportId) {
  console.error('[InsetApp] Missing required viewportId parameter')
  document.body.innerHTML = '<div style="color: red; padding: 20px;">Error: Missing viewportId parameter</div>'
} else if (!parentOrigin) {
  console.error('[InsetApp] Missing required parentOrigin parameter')
  document.body.innerHTML = '<div style="color: red; padding: 20px;">Error: Missing parentOrigin parameter</div>'
} else {
  // Suppress Cesium render loop console spam (same as main app)
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    if (args.length === 0) return
    if (args.length === 1 && args[0] === 'requestAnimationFrame') return
    originalLog.apply(console, args)
  }

  // Wait for webfonts before mounting (matches main.tsx — see comment there).
  Promise.race([
    Promise.all([
      document.fonts.load('400 12px "Geist"'),
      document.fonts.load('500 12px "Geist"'),
      document.fonts.load('400 12px "Geist Mono"'),
      document.fonts.load('700 12px "Geist Mono"'),
    ]),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
    .catch(() => {})
    .then(() => {
      ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
        <React.StrictMode>
          <InsetApp viewportId={viewportId} parentOrigin={parentOrigin} />
        </React.StrictMode>,
      )

      // Notify parent that inset is ready
      window.parent.postMessage({ type: 'inset-ready', viewportId }, parentOrigin)

      console.log(`[InsetApp] Initialized with viewportId=${viewportId}`)
    })
}
