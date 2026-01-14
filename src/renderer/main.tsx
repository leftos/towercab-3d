import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './assets/styles/global.css'
import { registerTileCacheServiceWorker } from './utils/serviceWorkerRegistration'
import { initFileLogging } from './utils/fileLogger'

// Initialize file logging FIRST, before anything else
// This must happen synchronously to catch all early logs
initFileLogging().catch(() => {
  // Ignore errors - logging is optional
})

// Suppress Cesium render loop console spam
// Cesium logs on every requestAnimationFrame which clutters the console
const originalLog = console.log
console.log = (...args: unknown[]) => {
  // Filter out Cesium render loop logs (typically just "requestAnimationFrame" or empty)
  if (args.length === 0) return
  if (args.length === 1 && args[0] === 'requestAnimationFrame') return
  originalLog.apply(console, args)
}

// Error boundary to catch and display errors
interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error)
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '20px',
          backgroundColor: '#1a1a2e',
          color: '#ff6b6b',
          fontFamily: 'monospace',
          height: '100vh',
          overflow: 'auto'
        }}>
          <h1>Application Error</h1>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {this.state.error?.message}
          </pre>
          <h2>Stack Trace:</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px' }}>
            {this.state.error?.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// Register service worker for tile caching
// This caches tiles at the HTTP layer, transparent to Cesium
registerTileCacheServiceWorker()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
