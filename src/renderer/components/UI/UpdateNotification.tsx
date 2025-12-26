import { useEffect, useCallback } from 'react'
import { useUpdateStore } from '../../stores/updateStore'
import {
  downloadAndInstallUpdate,
  restartApp,
  startAutoUpdateCheck,
  stopAutoUpdateCheck
} from '../../services/UpdateService'
import { isRemoteMode } from '../../utils/remoteMode'
import './UpdateNotification.css'

/**
 * Update notification component that displays at top of screen
 *
 * Shows notifications for:
 * - Update available (with download button)
 * - Download progress
 * - Ready to restart
 * - Errors
 *
 * Automatically checks for updates on startup and every 4 hours.
 * Hidden in remote mode (updates are handled by the host PC).
 */
function UpdateNotification() {
  // Check remote mode outside of hooks (this value never changes during runtime)
  const inRemoteMode = isRemoteMode()

  const status = useUpdateStore((state) => state.status)
  const updateInfo = useUpdateStore((state) => state.updateInfo)
  const progress = useUpdateStore((state) => state.progress)
  const error = useUpdateStore((state) => state.error)
  const reset = useUpdateStore((state) => state.reset)

  // Start auto-update check on mount (only in Tauri mode)
  useEffect(() => {
    if (inRemoteMode) return
    startAutoUpdateCheck(5000) // 5 second delay on startup
    return () => stopAutoUpdateCheck()
  }, [inRemoteMode])

  const handleDownload = useCallback(() => {
    downloadAndInstallUpdate()
  }, [])

  const handleRestart = useCallback(() => {
    restartApp()
  }, [])

  const handleDismiss = useCallback(() => {
    reset()
  }, [reset])

  // Don't render in remote mode - updates are handled by host
  // Don't render for idle, checking, or up-to-date states
  if (inRemoteMode || status === 'idle' || status === 'checking' || status === 'up-to-date') {
    return null
  }

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className={`update-notification update-${status}`}>
      <div className="update-content">
        {status === 'available' && updateInfo && (
          <>
            <span className="update-message">
              Update available: v{updateInfo.version}
            </span>
            <button className="update-button primary" onClick={handleDownload}>
              Download & Install
            </button>
            <button className="update-button secondary" onClick={handleDismiss}>
              Later
            </button>
          </>
        )}

        {status === 'downloading' && progress && (
          <>
            <span className="update-message">
              Downloading update...
              {progress.total && (
                <span className="progress-text">
                  {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
                </span>
              )}
            </span>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: progress.total
                    ? `${(progress.downloaded / progress.total) * 100}%`
                    : '50%'
                }}
              />
            </div>
          </>
        )}

        {status === 'ready' && (
          <>
            <span className="update-message">
              Update ready! Restart to apply.
            </span>
            <button className="update-button primary" onClick={handleRestart}>
              Restart Now
            </button>
            <button className="update-button secondary" onClick={handleDismiss}>
              Later
            </button>
          </>
        )}

        {status === 'error' && (
          <>
            <span className="update-message error">
              Update failed: {error}
            </span>
            <button className="update-button secondary" onClick={handleDismiss}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default UpdateNotification
