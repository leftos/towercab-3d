// Debug logging utility - writes to a file for easier analysis
// Logs are stored in memory and can be downloaded

const logs: string[] = []
const MAX_LOGS = 10000

export function debugLog(message: string): void {
  const timestamp = new Date().toISOString()
  const entry = `[${timestamp}] ${message}`
  logs.push(entry)

  // Also log to console for immediate visibility
  console.log(entry)

  // Trim if too many logs
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS)
  }
}

export function downloadLogs(): void {
  const content = logs.join('\n')
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = `towercab-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function clearLogs(): void {
  logs.length = 0
}

export function getLogs(): string[] {
  return [...logs]
}

// Add keyboard shortcut to download logs (Ctrl+Shift+L)
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault()
      downloadLogs()
      console.log('Logs downloaded!')
    }
  })
}
