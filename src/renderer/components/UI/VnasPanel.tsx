import { useCallback, useEffect, useState } from 'react'
import { useAirportStore } from '@/stores/airportStore'
import { useVnasStore } from '@/stores/vnasStore'
import type { VnasEnvironment } from '@/types/vnas'
import './VnasPanel.css'

/**
 * Dev-only panel for vNAS connection management.
 * Only shows when import.meta.env.DEV is true.
 *
 * This panel allows developers to:
 * - Check if vNAS feature is compiled in
 * - Connect to vNAS (Live, Sweatbox1, Sweatbox2)
 * - Monitor connection status
 * - Subscribe to airport updates
 */
export function VnasPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedEnv, setSelectedEnv] = useState<VnasEnvironment>('live')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')

  const status = useVnasStore((state) => state.status)
  const startAuth = useVnasStore((state) => state.startAuth)
  const handleOAuthCallback = useVnasStore((state) => state.handleOAuthCallback)
  const subscribe = useVnasStore((state) => state.subscribe)
  const isSubscribedTo = useVnasStore((state) => state.isSubscribedTo)
  const disconnect = useVnasStore((state) => state.disconnect)
  const getStatus = useVnasStore((state) => state.getStatus)
  const checkAvailability = useVnasStore((state) => state.checkAvailability)

  const currentAirport = useAirportStore((state) => state.currentAirport)

  // Check availability and get status on mount
  useEffect(() => {
    if (!import.meta.env.DEV) return
    checkAvailability()
    getStatus()
  }, [checkAvailability, getStatus])

  const handleStartAuth = useCallback(async () => {
    try {
      setIsAuthenticating(true)
      setCallbackUrl('')
      const authUrl = await startAuth(selectedEnv)
      console.log('[vNAS] Opening auth URL in browser:', authUrl)

      // Open auth URL in system browser using Tauri shell plugin
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(authUrl)

      // Note: In production, the OAuth callback is handled by the deep-link handler in App.tsx
      // In dev mode, deep links don't work, so user needs to paste the callback URL manually
    } catch (error) {
      console.error('vNAS auth failed:', error)
      setIsAuthenticating(false)
    }
  }, [selectedEnv, startAuth])

  const handleManualCallback = useCallback(async () => {
    if (!callbackUrl.trim()) return
    try {
      console.log('[vNAS] Processing manual callback URL:', callbackUrl)
      await handleOAuthCallback(callbackUrl.trim())
      setCallbackUrl('')
      setIsAuthenticating(false)
    } catch (error) {
      console.error('vNAS manual callback failed:', error)
    }
  }, [callbackUrl, handleOAuthCallback])

  const handleCancelAuth = useCallback(() => {
    setIsAuthenticating(false)
    setCallbackUrl('')
    disconnect()
  }, [disconnect])

  const handleDisconnect = useCallback(async () => {
    try {
      await disconnect()
    } catch (error) {
      console.error('vNAS disconnect failed:', error)
    }
  }, [disconnect])

  const handleSubscribe = useCallback(async () => {
    if (!currentAirport?.icao) return
    try {
      await subscribe(currentAirport.icao)
    } catch (error) {
      console.error('vNAS subscribe failed:', error)
    }
  }, [subscribe, currentAirport?.icao])

  const getStateColor = useCallback(() => {
    switch (status.state) {
      case 'connected':
        return '#0c7'
      case 'authenticating':
      case 'connecting':
      case 'joiningSession':
      case 'subscribing':
        return '#fc0'
      case 'unavailable':
        return '#666'
      default:
        return '#888'
    }
  }, [status.state])

  const getStateLabel = useCallback(() => {
    switch (status.state) {
      case 'disconnected':
        return 'Disconnected'
      case 'authenticating':
        return 'Authenticating...'
      case 'connecting':
        return 'Connecting...'
      case 'joiningSession':
        return 'Joining Session...'
      case 'subscribing':
        return 'Subscribing...'
      case 'connected':
        return 'Connected'
      case 'unavailable':
        return 'Not Available'
      default:
        return status.state
    }
  }, [status.state])

  // Don't render in production
  if (!import.meta.env.DEV) {
    return null
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        className="vnas-panel-toggle"
        onClick={() => setIsOpen(true)}
        title="vNAS Panel (Dev Only)"
        style={{ borderColor: getStateColor() }}
      >
        vNAS
      </button>
    )
  }

  return (
    <div className="vnas-panel">
      <div className="vnas-panel-header">
        <span>vNAS (Dev)</span>
        <button type="button" onClick={() => setIsOpen(false)}>
          X
        </button>
      </div>

      <div className="vnas-panel-content">
        {/* Availability Status */}
        <div className="vnas-panel-row">
          <span>Feature Status</span>
          <span className={`vnas-status-badge ${status.available ? 'available' : 'unavailable'}`}>
            {status.available ? 'Compiled In' : 'Not Compiled'}
          </span>
        </div>

        {/* Connection State */}
        <div className="vnas-panel-row">
          <span>Connection</span>
          <span className="vnas-status-indicator" style={{ color: getStateColor() }}>
            {getStateLabel()}
          </span>
        </div>

        {/* Show subscribed facilities if connected */}
        {status.subscribedFacilities.length > 0 && (
          <div className="vnas-panel-row">
            <span>Subscribed</span>
            <span className="vnas-facility">{status.subscribedFacilities.join(', ')}</span>
          </div>
        )}

        {/* Error display */}
        {status.error && <div className="vnas-panel-error">{status.error}</div>}

        {/* Controls - only show if feature is available */}
        {status.available && (
          <>
            {status.state === 'disconnected' && !isAuthenticating && (
              <>
                <div className="vnas-panel-row">
                  <span>Environment</span>
                  <select value={selectedEnv} onChange={(e) => setSelectedEnv(e.target.value as VnasEnvironment)}>
                    <option value="live">Live</option>
                    <option value="sweatbox1">Sweatbox 1</option>
                    <option value="sweatbox2">Sweatbox 2</option>
                  </select>
                </div>

                <button type="button" className="vnas-panel-button primary" onClick={handleStartAuth}>
                  Connect to vNAS
                </button>
              </>
            )}

            {/* Manual callback input for dev mode (deep links don't work in dev) */}
            {isAuthenticating && (
              <>
                <div className="vnas-panel-note">
                  After authorizing in browser, copy the callback URL (tc3d://...) and paste below:
                </div>
                <input
                  type="text"
                  className="vnas-panel-input"
                  placeholder="tc3d://oauth/callback?code=..."
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleManualCallback()}
                />
                <div className="vnas-panel-buttons">
                  <button
                    type="button"
                    className="vnas-panel-button primary"
                    onClick={handleManualCallback}
                    disabled={!callbackUrl.trim()}
                  >
                    Submit
                  </button>
                  <button type="button" className="vnas-panel-button" onClick={handleCancelAuth}>
                    Cancel
                  </button>
                </div>
              </>
            )}

            {status.state === 'connected' && (
              <>
                {/* Subscribe button if not subscribed to current airport */}
                {currentAirport?.icao && !isSubscribedTo(currentAirport.icao) && (
                  <button type="button" className="vnas-panel-button" onClick={handleSubscribe}>
                    Subscribe to {currentAirport.icao}
                  </button>
                )}

                <button type="button" className="vnas-panel-button danger" onClick={handleDisconnect}>
                  Disconnect
                </button>
              </>
            )}
          </>
        )}

        {/* Note about OAuth credentials */}
        {status.available && status.state === 'disconnected' && (
          <div className="vnas-panel-note">Note: Requires OAuth credentials from VATSIM tech team.</div>
        )}
      </div>
    </div>
  )
}
