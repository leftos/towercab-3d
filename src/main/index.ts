import { app, BrowserWindow, shell, screen, session, dialog } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Note: V8 pointer compression in Electron 14+ limits the renderer V8 heap to 4GB max.
// This flag ensures we use the full 4GB rather than a smaller default.
// ArrayBuffers (used by Cesium/Babylon for geometry/textures) have separate, larger limits.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')

// GPU and rendering optimizations for Cesium/Babylon performance
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-webgl2-compute-context')
// Use high-performance GPU on multi-GPU systems (laptops with integrated + discrete)
app.commandLine.appendSwitch('force_high_performance_gpu')
// Disable throttling when window is in background (useful for ATC monitoring)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

const BOUNDS_FILE = join(app.getPath('userData'), 'window-bounds.json')

function loadWindowBounds(): WindowBounds | null {
  try {
    const data = readFileSync(BOUNDS_FILE, 'utf-8')
    return JSON.parse(data) as WindowBounds
  } catch {
    return null
  }
}

function saveWindowBounds(window: BrowserWindow): void {
  const bounds = window.getBounds()
  const isMaximized = window.isMaximized()
  const data: WindowBounds = { ...bounds, isMaximized }
  try {
    writeFileSync(BOUNDS_FILE, JSON.stringify(data))
  } catch {
    // Ignore write errors
  }
}

function getValidBounds(saved: WindowBounds | null): Partial<WindowBounds> {
  if (!saved) return { width: 1600, height: 900 }

  // Check if saved position is still on a visible display
  const displays = screen.getAllDisplays()
  const isOnScreen = displays.some((display) => {
    const { x, y, width, height } = display.bounds
    return (
      saved.x >= x &&
      saved.x < x + width &&
      saved.y >= y &&
      saved.y < y + height
    )
  })

  if (isOnScreen) {
    return saved
  }

  // Position off-screen, use saved size but default position
  return { width: saved.width, height: saved.height }
}

function createWindow(): void {
  const savedBounds = loadWindowBounds()
  const bounds = getValidBounds(savedBounds)

  const mainWindow = new BrowserWindow({
    title: `TowerCab 3D v${app.getVersion()}`,
    width: bounds.width ?? 1600,
    height: bounds.height ?? 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Performance optimizations
      backgroundThrottling: false, // Keep rendering at full speed when minimized/background
      spellcheck: false // Disable spellcheck (not needed for ATC app)
    }
  })

  // Restore maximized state
  if (savedBounds?.isMaximized) {
    mainWindow.maximize()
  }

  // Save bounds when window is moved, resized, or closed
  mainWindow.on('close', () => saveWindowBounds(mainWindow))

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // Set title after page loads (HTML <title> would otherwise override BrowserWindow title)
    mainWindow.setTitle(`TowerCab 3D v${app.getVersion()}`)
    // Open DevTools in dev mode for easier debugging
    if (is.dev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Always show crash dialog (important for debugging production issues)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process crashed:', details.reason)
    dialog.showErrorBox(
      'Renderer Crashed',
      `Reason: ${details.reason}\nExit code: ${details.exitCode}`
    )
  })

  // Dev-only debug handlers (reduce overhead in production)
  if (is.dev) {
    mainWindow.webContents.on('unresponsive', () => {
      console.error('Renderer became unresponsive')
    })

    mainWindow.webContents.on('responsive', () => {
      console.log('Renderer is responsive again')
    })

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Failed to load:', errorCode, errorDescription)
    })

    // Log console messages from renderer
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error']
      if (level >= 2) {
        console.log(`[Renderer ${levels[level]}] ${message} (${sourceId}:${line})`)
      }
    })
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.towercab.viewer')

  // Bypass CORS for Cesium Ion assets
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {}
    // Check for CORS header (case-insensitive)
    const hasOriginHeader = Object.keys(headers).some(
      (key) => key.toLowerCase() === 'access-control-allow-origin'
    )
    // Add CORS headers only if not already present
    if (!hasOriginHeader) {
      headers['Access-Control-Allow-Origin'] = ['*']
    }
    callback({ responseHeaders: headers })
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
