import { invoke } from '@tauri-apps/api/core'
import { isRemoteMode } from './remoteMode'

let logBuffer: string[] = []
let logFilePath: string | null = null
let flushInterval: NodeJS.Timeout | null = null
let isInitialized = false

const MAX_BUFFER = 100 // Flush after 100 lines
const FLUSH_INTERVAL = 5000 // Or every 5 seconds

/**
 * Initialize file logging if --log flag was passed to npm run dev
 * Called from main.tsx before anything else
 */
export async function initFileLogging() {
  // Don't initialize in remote browser mode or if already initialized
  if (isRemoteMode() || isInitialized) return
  isInitialized = true

  try {
    // Get the log file path from the Tauri backend (set via --log flag)
    const logPath = await invoke<string | null>('get_log_file_path')
    if (!logPath) {
      // No log file specified, only log to console
      return
    }

    logFilePath = logPath
    console.log(`[fileLogger] Logging to: ${logFilePath}`)

    // Create fresh log file on first initialization
    try {
      await invoke('create_text_file', {
        path: logFilePath,
        content: `[${timestamp()}] === Console Log Started ===\n`
      })
    } catch (error) {
      console.error('[fileLogger] Failed to create log file:', error)
      return
    }

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
 * Intercept console methods and write to log file
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
    logBuffer.push(`[${timestamp()}] LOG: ${message}`)
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.error = (...args) => {
    originalError(...args)
    const message = formatMessage(args)
    logBuffer.push(`[${timestamp()}] ERROR: ${message}`)
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.warn = (...args) => {
    originalWarn(...args)
    const message = formatMessage(args)
    logBuffer.push(`[${timestamp()}] WARN: ${message}`)
    if (logBuffer.length >= MAX_BUFFER) flushLogs()
  }

  console.info = (...args) => {
    originalInfo(...args)
    const message = formatMessage(args)
    logBuffer.push(`[${timestamp()}] INFO: ${message}`)
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
    .map(arg => {
      if (typeof arg === 'object') {
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
 * Get current timestamp in ISO format
 */
function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Flush buffered logs to file
 */
async function flushLogs() {
  if (!logFilePath || logBuffer.length === 0) return

  try {
    const content = logBuffer.join('\n') + '\n'

    // Append to the log file via Tauri command
    await invoke('append_to_text_file', {
      path: logFilePath,
      content
    })

    logBuffer = []
  } catch (error) {
    // Silently fail to avoid recursion
    // The original console is still available, so errors won't disappear
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
