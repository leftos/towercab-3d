/**
 * vNAS Status Popover
 *
 * A small popover that appears when clicking the vNAS indicator in the TopBar.
 * Allows users to quickly:
 * - See connection status
 * - Change environment (Live, Sweatbox 1/2)
 * - Connect or disconnect
 * - See errors if any
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useVnasStore } from '../../stores/vnasStore'
import type { VnasEnvironment } from '../../types/vnas'
import './VnasStatusPopover.css'

interface VnasStatusPopoverProps {
  onClose: () => void
  /** Ref to the toggle button - clicks on it are excluded from click-outside detection */
  toggleRef?: React.RefObject<HTMLButtonElement | null>
}

export function VnasStatusPopover({ onClose, toggleRef }: VnasStatusPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)

  // vNAS store state
  const vnasStatus = useVnasStore((state) => state.status)
  const vnasTryConnect = useVnasStore((state) => state.tryConnectWithStoredTokens)
  const vnasStartAuth = useVnasStore((state) => state.startAuth)
  const vnasHandleOAuthCallback = useVnasStore((state) => state.handleOAuthCallback)
  const vnasDisconnect = useVnasStore((state) => state.disconnect)

  // Local state
  const [selectedEnv, setSelectedEnv] = useState<VnasEnvironment>(vnasStatus.environment)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      // Ignore clicks on the popover itself
      if (popoverRef.current && popoverRef.current.contains(target)) {
        return
      }
      // Ignore clicks on the toggle button (let the button handle its own toggle)
      if (toggleRef?.current && toggleRef.current.contains(target)) {
        return
      }
      onClose()
    }

    // Add listener after a small delay to prevent immediate close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 100)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose, toggleRef])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const getStateLabel = useCallback(() => {
    switch (vnasStatus.state) {
      case 'disconnected': return 'Disconnected'
      case 'authenticating': return 'Authenticating...'
      case 'connecting': return 'Connecting...'
      case 'joiningSession': return 'Joining Session...'
      case 'waitingForSession': return 'Waiting for CRC...'
      case 'subscribing': return 'Ready for vNAS Airport...'
      case 'connected': return 'Connected'
      case 'unavailable': return 'Not Available'
      default: return vnasStatus.state
    }
  }, [vnasStatus.state])

  const getStateColor = useCallback(() => {
    switch (vnasStatus.state) {
      case 'connected': return '#81c784'
      case 'authenticating':
      case 'connecting':
      case 'joiningSession':
      case 'waitingForSession':
      case 'subscribing':
        return '#ffb74d'
      case 'unavailable': return '#888'
      default: return '#ef5350'
    }
  }, [vnasStatus.state])

  const handleStartAuth = useCallback(async () => {
    try {
      // First try to connect using stored tokens (avoids OAuth if possible)
      const connected = await vnasTryConnect(selectedEnv)
      if (connected) {
        console.log('[vNAS] Connected using stored tokens')
        onClose()
        return
      }

      // No valid tokens, start OAuth flow
      setIsAuthenticating(true)
      setCallbackUrl('')
      const authUrl = await vnasStartAuth(selectedEnv)

      // Open auth URL in system browser using Tauri shell plugin
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(authUrl)
    } catch (error) {
      console.error('vNAS auth failed:', error)
      setIsAuthenticating(false)
    }
  }, [selectedEnv, vnasTryConnect, vnasStartAuth, onClose])

  const handleManualCallback = useCallback(async () => {
    if (!callbackUrl.trim()) return
    try {
      await vnasHandleOAuthCallback(callbackUrl.trim())
      setCallbackUrl('')
      setIsAuthenticating(false)
      onClose()
    } catch (error) {
      console.error('vNAS manual callback failed:', error)
    }
  }, [callbackUrl, vnasHandleOAuthCallback, onClose])

  const handleCancelAuth = useCallback(() => {
    setIsAuthenticating(false)
    setCallbackUrl('')
    vnasDisconnect()
  }, [vnasDisconnect])

  const handleDisconnect = useCallback(async () => {
    try {
      await vnasDisconnect()
    } catch (error) {
      console.error('vNAS disconnect failed:', error)
    }
  }, [vnasDisconnect])

  const isConnecting = ['authenticating', 'connecting', 'joiningSession', 'waitingForSession', 'subscribing'].includes(vnasStatus.state)

  return (
    <div className="vnas-popover" ref={popoverRef}>
      <div className="vnas-popover-header">
        <span>vNAS Real-Time Updates</span>
        <button className="vnas-popover-close" onClick={onClose}>×</button>
      </div>

      <div className="vnas-popover-content">
        {/* Status indicator */}
        <div className="vnas-popover-status">
          <span className="vnas-popover-status-dot" style={{ backgroundColor: getStateColor() }} />
          <span className="vnas-popover-status-text" style={{ color: getStateColor() }}>
            {getStateLabel()}
          </span>
          {vnasStatus.facilityId && vnasStatus.state === 'connected' && (
            <span className="vnas-popover-facility">{vnasStatus.facilityId}</span>
          )}
        </div>

        {/* Error message */}
        {vnasStatus.error && (
          <div className="vnas-popover-error">
            {vnasStatus.error}
          </div>
        )}

        {/* Environment selector - only when disconnected */}
        {vnasStatus.state === 'disconnected' && !isAuthenticating && (
          <div className="vnas-popover-env">
            <label>Environment</label>
            <select
              value={selectedEnv}
              onChange={(e) => setSelectedEnv(e.target.value as VnasEnvironment)}
            >
              <option value="live">Live</option>
              <option value="sweatbox1">Sweatbox 1</option>
              <option value="sweatbox2">Sweatbox 2</option>
            </select>
          </div>
        )}

        {/* Manual callback input - only during authentication */}
        {isAuthenticating && (
          <div className="vnas-popover-callback">
            <p>Complete authorization in browser. If it doesn&apos;t auto-connect:</p>
            <input
              type="text"
              placeholder="Paste tc3d://oauth/callback?... URL"
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleManualCallback()}
            />
          </div>
        )}

        {/* Action buttons */}
        <div className="vnas-popover-actions">
          {vnasStatus.state === 'disconnected' && !isAuthenticating && (
            <button className="vnas-popover-btn primary" onClick={handleStartAuth}>
              Connect
            </button>
          )}

          {isAuthenticating && (
            <>
              <button
                className="vnas-popover-btn primary"
                onClick={handleManualCallback}
                disabled={!callbackUrl.trim()}
              >
                Submit
              </button>
              <button className="vnas-popover-btn" onClick={handleCancelAuth}>
                Cancel
              </button>
            </>
          )}

          {(isConnecting || vnasStatus.state === 'connected') && !isAuthenticating && (
            <button className="vnas-popover-btn danger" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
