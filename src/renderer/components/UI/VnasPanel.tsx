import { useState, useEffect, useCallback } from 'react'
import { useVnasStore } from '@/stores/vnasStore'
import { useAirportStore } from '@/stores/airportStore'
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

  const status = useVnasStore((state) => state.status)
  const startAuth = useVnasStore((state) => state.startAuth)
  const completeAuth = useVnasStore((state) => state.completeAuth)
  const connect = useVnasStore((state) => state.connect)
  const subscribe = useVnasStore((state) => state.subscribe)
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
      const authUrl = await startAuth(selectedEnv)
      // Open auth URL in browser
      window.open(authUrl, '_blank')
      // Wait for OAuth callback
      await completeAuth()
      // Connect after auth
      await connect()
      // Subscribe to current airport if set
      if (currentAirport?.icao) {
        await subscribe(currentAirport.icao)
      }
    } catch (error) {
      console.error('vNAS auth failed:', error)
    } finally {
      setIsAuthenticating(false)
    }
  }, [selectedEnv, startAuth, completeAuth, connect, subscribe, currentAirport?.icao])

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
      case 'connected': return '#0c7'
      case 'authenticating':
      case 'connecting':
      case 'joiningSession':
      case 'subscribing':
        return '#fc0'
      case 'unavailable': return '#666'
      default: return '#888'
    }
  }, [status.state])

  const getStateLabel = useCallback(() => {
    switch (status.state) {
      case 'disconnected': return 'Disconnected'
      case 'authenticating': return 'Authenticating...'
      case 'connecting': return 'Connecting...'
      case 'joiningSession': return 'Joining Session...'
      case 'subscribing': return 'Subscribing...'
      case 'connected': return 'Connected'
      case 'unavailable': return 'Not Available'
      default: return status.state
    }
  }, [status.state])

  // Don't render in production
  if (!import.meta.env.DEV) {
    return null
  }

  if (!isOpen) {
    return (
      <button
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
        <button onClick={() => setIsOpen(false)}>X</button>
      </div>

      <div className="vnas-panel-content">
        {/* Availability Status */}
        <div className="vnas-panel-row">
          <label>Feature Status</label>
          <span className={`vnas-status-badge ${status.available ? 'available' : 'unavailable'}`}>
            {status.available ? 'Compiled In' : 'Not Compiled'}
          </span>
        </div>

        {/* Connection State */}
        <div className="vnas-panel-row">
          <label>Connection</label>
          <span className="vnas-status-indicator" style={{ color: getStateColor() }}>
            {getStateLabel()}
          </span>
        </div>

        {/* Show subscribed facility if connected */}
        {status.facilityId && (
          <div className="vnas-panel-row">
            <label>Subscribed</label>
            <span className="vnas-facility">{status.facilityId}</span>
          </div>
        )}

        {/* Error display */}
        {status.error && (
          <div className="vnas-panel-error">
            {status.error}
          </div>
        )}

        {/* Controls - only show if feature is available */}
        {status.available && (
          <>
            {status.state === 'disconnected' && (
              <>
                <div className="vnas-panel-row">
                  <label>Environment</label>
                  <select
                    value={selectedEnv}
                    onChange={(e) => setSelectedEnv(e.target.value as VnasEnvironment)}
                    disabled={isAuthenticating}
                  >
                    <option value="live">Live</option>
                    <option value="sweatbox1">Sweatbox 1</option>
                    <option value="sweatbox2">Sweatbox 2</option>
                  </select>
                </div>

                <button
                  className="vnas-panel-button primary"
                  onClick={handleStartAuth}
                  disabled={isAuthenticating}
                >
                  {isAuthenticating ? 'Connecting...' : 'Connect to vNAS'}
                </button>
              </>
            )}

            {status.state === 'connected' && (
              <>
                {/* Subscribe button if not subscribed to current airport */}
                {currentAirport?.icao && status.facilityId !== currentAirport.icao && (
                  <button
                    className="vnas-panel-button"
                    onClick={handleSubscribe}
                  >
                    Subscribe to {currentAirport.icao}
                  </button>
                )}

                <button
                  className="vnas-panel-button danger"
                  onClick={handleDisconnect}
                >
                  Disconnect
                </button>
              </>
            )}
          </>
        )}

        {/* Note about OAuth credentials */}
        {status.available && status.state === 'disconnected' && (
          <div className="vnas-panel-note">
            Note: Requires OAuth credentials from VATSIM tech team.
          </div>
        )}
      </div>
    </div>
  )
}
