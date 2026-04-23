import { invoke } from '@tauri-apps/api/core'
import { getApiBaseUrl, isRemoteMode } from './remoteMode'

let logBuffer: Array<{ level: string; message: string }> = []
let isLoggingEnabled = false
let flushInterval: number | null = null
let isInitialized = false
let isRemote = false
let clientId: string | null = null

const MAX_BUFFER = 50 // Flush after 50 lines
const FLUSH_INTERVAL = 2000 // Or every 2 seconds

/**
 * Generate a short unique client ID for remote logging identification
 */
function generateClientId(): string {
  return Math.random().toString(36).substring(2, 8)
}

/**
 * Initialize file logging if --log flag was passed to npm run dev
 * Called from main.tsx before anything else
 *
 * In Tauri mode: sends console.log calls to the Rust backend, which writes them
 * to the same unified log file that Rust uses for its own logging.
 *
 * In remote mode: sends console.log calls to the host's HTTP server, which
 * forwards them to the Rust backend for unified logging.
 */
export async function initFileLogging() {
  // Don't initialize twice
  if (isInitialized) return
  isInitialized = true

  isRemote = isRemoteMode()

  if (isRemote) {
    // Remote mode: always enable logging to send to host
    isLoggingEnabled = true
    clientId = generateClientId()
    console.log(`[fileLogger] Remote mode enabled, client ID: ${clientId}`)

    // Override console methods
    setupConsoleInterception()

    // Periodic flush
    flushInterval = setInterval(() => {
      flushLogs().catch(() => {
        // Silently ignore flush errors to avoid console spam
      })
    }, FLUSH_INTERVAL)

    // Flush on unload
    window.addEventListener('beforeunload', () => {
      flushLogs().catch(() => {})
    })
    return
  }

  // Tauri mode: check if log file is configured (set via --log flag)
  try {
    const logPath = await invoke<string | null>('get_log_file_path')
    if (!logPath) {
      // No log file specified, only log to console
      return
    }

    isLoggingEnabled = true
    console.log(`[fileLogger] Logging enabled, Rust will write to: ${logPath}`)

    // Override console methods
    setupConsoleInterception()

    // Periodic flush - properly handle async operation
    flushInterval = setInterval(() => {
      flushLogs().catch(() => {
        // Silently ignore flush errors to avoid console spam
      })
    }, FLUSH_INTERVAL)

    // Flush on unload - try to flush before closing (won't always complete)
    window.addEventListener('beforeunload', () => {
      flushLogs().catch(() => {})
    })
  } catch (error) {
    console.error('[fileLogger] Failed to initialize:', error)
  }
}

/**
 * Intercept console methods and send to Rust for unified logging
 */
function setupConsoleInterception() {
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  const originalInfo = console.info

  // Log that interception is being set up (using original methods)
  originalLog('[fileLogger] Console interception setup starting...')

  console.log = (...args) => {
    originalLog(...args)
    const message = formatMessage(args)
    logBuffer.push({ level: 'LOG', message })
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.error = (...args) => {
    originalError(...args)
    const message = formatMessage(args)
    logBuffer.push({ level: 'ERROR', message })
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.warn = (...args) => {
    originalWarn(...args)
    const message = formatMessage(args)
    logBuffer.push({ level: 'WARN', message })
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.info = (...args) => {
    originalInfo(...args)
    const message = formatMessage(args)
    logBuffer.push({ level: 'INFO', message })
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  // Log that interception is complete
  originalLog('[fileLogger] Console interception setup complete')
}

/**
 * Format console arguments into a readable string
 */
function formatMessage(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        // Error objects don't serialize with JSON.stringify (properties aren't enumerable)
        return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`
      }
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    })
    .join(' ')
}

/**
 * Flush buffered logs to backend
 */
async function flushLogs() {
  if (!isLoggingEnabled || logBuffer.length === 0) return

  // Atomically grab and clear buffer to prevent race conditions
  // (multiple concurrent flushLogs calls from timer + buffer overflow)
  const toFlush = logBuffer
  logBuffer = []

  if (isRemote) {
    // Remote mode: send to HTTP endpoint in a single batch
    try {
      const entries = toFlush.map((entry) => ({
        level: entry.level,
        message: entry.message,
        clientId,
      }))

      await fetch(`${getApiBaseUrl()}/api/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
    } catch {
      // Silently fail to avoid recursion
    }
    return
  }

  // Tauri mode: send each log entry to Rust
  for (const entry of toFlush) {
    try {
      await invoke('log_from_frontend', {
        level: entry.level,
        message: entry.message,
      })
    } catch {
      // Silently fail to avoid recursion
      // The original console is still available, so errors won't disappear
    }
  }
}

/**
 * Stop file logging and flush remaining logs
 */
export async function stopFileLogging() {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }
  await flushLogs()
}
