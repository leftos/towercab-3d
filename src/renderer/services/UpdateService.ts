// Update service for checking and installing app updates
// Uses Tauri's updater plugin with GitHub Releases

import { check, Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { useUpdateStore } from '@/stores/updateStore'

// Auto-check interval: 4 hours in milliseconds
const AUTO_CHECK_INTERVAL = 4 * 60 * 60 * 1000

// Store reference to current update for download/install
let currentUpdate: Update | null = null

// Timer IDs for auto-update checks
let initialDelayTimer: ReturnType<typeof setTimeout> | null = null
let autoCheckTimer: ReturnType<typeof setInterval> | null = null

/**
 * Check for available updates
 * @returns true if an update is available
 */
export async function checkForUpdates(): Promise<boolean> {
  const store = useUpdateStore.getState()

  // Don't check if already downloading or ready
  if (store.status === 'downloading' || store.status === 'ready') {
    return store.status === 'ready'
  }

  try {
    store.setStatus('checking')
    store.setError(null)

    const update = await check()

    if (update) {
      currentUpdate = update
      store.setUpdateInfo({
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date ?? null,
        body: update.body ?? null
      })
      store.setStatus('available')
      console.log(`[Update] Update available: v${update.version}`)
      return true
    } else {
      store.setStatus('up-to-date')
      console.log('[Update] App is up to date')
      return false
    }
  } catch (error) {
    console.error('[Update] Check failed:', error)
    store.setError(error instanceof Error ? error.message : 'Failed to check for updates')
    return false
  }
}

/**
 * Download and install the available update
 */
export async function downloadAndInstallUpdate(): Promise<void> {
  const store = useUpdateStore.getState()

  if (!currentUpdate) {
    store.setError('No update available')
    return
  }

  try {
    store.setStatus('downloading')
    store.setProgress({ downloaded: 0, total: null })

    let totalBytes = 0
    let downloadedBytes = 0

    await currentUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        totalBytes = event.data.contentLength ?? 0
        store.setProgress({ downloaded: 0, total: totalBytes || null })
        console.log(`[Update] Started downloading ${totalBytes} bytes`)
      } else if (event.event === 'Progress') {
        downloadedBytes += event.data.chunkLength
        store.setProgress({ downloaded: downloadedBytes, total: totalBytes || null })
      } else if (event.event === 'Finished') {
        store.setProgress({ downloaded: totalBytes, total: totalBytes || null })
        console.log('[Update] Download finished')
      }
    })

    store.setStatus('ready')
    console.log('[Update] Update installed, ready to restart')

  } catch (error) {
    console.error('[Update] Download/install failed:', error)
    store.setError(error instanceof Error ? error.message : 'Failed to download update')
  }
}

/**
 * Restart the app to apply the update
 */
export async function restartApp(): Promise<void> {
  const store = useUpdateStore.getState()

  try {
    console.log('[Update] Restarting app...')
    await relaunch()
  } catch (error) {
    console.error('[Update] Failed to restart app:', error)
    store.setError(error instanceof Error ? error.message : 'Failed to restart app')
  }
}

/**
 * Start periodic update checks (call on app startup)
 * @param initialDelay Delay before first check in ms (default 5000)
 */
export function startAutoUpdateCheck(initialDelay: number = 5000): void {
  // Clear any existing timers
  stopAutoUpdateCheck()

  // Initial check after delay
  initialDelayTimer = setTimeout(() => {
    initialDelayTimer = null
    checkForUpdates()

    // Set up periodic checks every 4 hours
    autoCheckTimer = setInterval(() => {
      console.log('[Update] Running periodic update check')
      checkForUpdates()
    }, AUTO_CHECK_INTERVAL)
  }, initialDelay)

  console.log(`[Update] Auto-update check scheduled (initial delay: ${initialDelay}ms, interval: ${AUTO_CHECK_INTERVAL}ms)`)
}

/**
 * Stop periodic update checks
 */
export function stopAutoUpdateCheck(): void {
  if (initialDelayTimer) {
    clearTimeout(initialDelayTimer)
    initialDelayTimer = null
  }
  if (autoCheckTimer) {
    clearInterval(autoCheckTimer)
    autoCheckTimer = null
  }
}
