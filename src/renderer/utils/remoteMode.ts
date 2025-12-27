/**
 * Remote Mode Utilities
 *
 * Functions to detect if the app is running in remote browser mode (iPad/tablet)
 * vs native Tauri desktop mode.
 */

/**
 * Check if we're running in remote browser mode (not in Tauri)
 * Remote mode is when the app is accessed via HTTP from a browser
 * rather than running as a native Tauri desktop app.
 *
 * Checks both __TAURI__ and __TAURI_INTERNALS__ for consistency with isTauri()
 */
export function isRemoteMode(): boolean {
  return !('__TAURI__' in window) && !('__TAURI_INTERNALS__' in window)
}

/**
 * Get the API base URL for HTTP requests
 * In remote mode: the origin of the current page (e.g., http://192.168.1.100:8765)
 * In Tauri mode: always use localhost:8765 since Vite dev server is on different port
 */
export function getApiBaseUrl(): string {
  if (isRemoteMode()) {
    return window.location.origin
  }
  // In Tauri mode, the page may be served by Vite (5173) but HTTP server is on 8765
  return 'http://localhost:8765'
}

/**
 * Get the hostname of the host PC (for display purposes)
 * Returns null if not in remote mode
 */
export function getHostname(): string | null {
  if (!isRemoteMode()) return null
  return window.location.hostname
}

/**
 * Get the port of the host server
 * Returns null if not in remote mode
 */
export function getPort(): number | null {
  if (!isRemoteMode()) return null
  const port = window.location.port
  return port ? parseInt(port, 10) : (window.location.protocol === 'https:' ? 443 : 80)
}
