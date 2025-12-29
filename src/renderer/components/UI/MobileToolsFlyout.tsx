/**
 * Mobile Tools Flyout Component
 *
 * Provides quick access to debug tools (Performance HUD, Model Matching, Command Input)
 * and shows connectivity status on compact/mobile layouts.
 */

import { useState, useEffect } from 'react'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { isRemoteMode } from '../../utils/remoteMode'
import './MobileToolsFlyout.css'

interface MobileToolsFlyoutProps {
  onCommandClick: () => void
  /** Data feed source name (e.g., "VATSIM" or "RealTraffic") */
  dataSourceLabel: string
  /** Whether connected to data feed */
  isDataConnected: boolean
  /** Total traffic count from data feed */
  trafficCount: number
  /** Label for traffic count (e.g., "pilots online" or "aircraft") */
  trafficLabel: string
}

type RemoteStatus = 'connected' | 'checking' | 'disconnected'

function MobileToolsFlyout({
  onCommandClick,
  dataSourceLabel,
  isDataConnected,
  trafficCount,
  trafficLabel
}: MobileToolsFlyoutProps) {
  const [isOpen, setIsOpen] = useState(false)

  // Debug overlay toggles
  const togglePerformanceHUD = useUIFeedbackStore((state) => state.togglePerformanceHUD)
  const toggleModelMatchingModal = useUIFeedbackStore((state) => state.toggleModelMatchingModal)

  // Remote server status (only relevant in remote/browser mode)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus>('checking')
  const [remoteHost, setRemoteHost] = useState('')
  const inRemoteMode = isRemoteMode()

  useEffect(() => {
    if (!inRemoteMode) return

    setRemoteHost(window.location.host)

    const checkConnection = async () => {
      try {
        const response = await fetch('/api/global-settings', {
          method: 'GET',
          cache: 'no-store'
        })
        setRemoteStatus(response.ok ? 'connected' : 'disconnected')
      } catch {
        setRemoteStatus('disconnected')
      }
    }

    checkConnection()
    const interval = setInterval(checkConnection, 30000)
    return () => clearInterval(interval)
  }, [inRemoteMode])

  const handleReconnect = async () => {
    setRemoteStatus('checking')
    try {
      const response = await fetch('/api/global-settings', {
        method: 'GET',
        cache: 'no-store'
      })
      setRemoteStatus(response.ok ? 'connected' : 'disconnected')
    } catch {
      setRemoteStatus('disconnected')
    }
  }

  return (
    <div className={`mobile-tools-flyout ${isOpen ? 'open' : ''}`}>
      {/* Status indicator dots - always visible next to toggle */}
      <div className="mobile-tools-indicators">
        <span
          className={`mobile-indicator-dot ${isDataConnected ? 'connected' : 'disconnected'}`}
          title={`${dataSourceLabel}: ${isDataConnected ? 'Connected' : 'Disconnected'}`}
        />
        {inRemoteMode && (
          <span
            className={`mobile-indicator-dot ${remoteStatus}`}
            title={`Remote Server: ${remoteStatus === 'connected' ? 'Connected' : remoteStatus === 'checking' ? 'Connecting...' : 'Disconnected'}`}
          />
        )}
      </div>

      {/* Toggle button - always visible */}
      <button
        className={`mobile-tools-toggle ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? 'Hide tools' : 'Show tools'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {/* Flyout panel */}
      {isOpen && (
        <div className="mobile-tools-panel">
          {/* Connectivity status section */}
          <div className="mobile-tools-status">
            {/* Data feed status */}
            <div className="mobile-status-row">
              <span className={`mobile-status-dot ${isDataConnected ? 'connected' : 'disconnected'}`} />
              <div className="mobile-status-info">
                <span className="mobile-status-label">{dataSourceLabel}</span>
                <span className="mobile-status-detail">
                  {isDataConnected ? `${trafficCount} ${trafficLabel}` : 'Disconnected'}
                </span>
              </div>
            </div>

            {/* Remote server status (only in remote mode) */}
            {inRemoteMode && (
              <div className="mobile-status-row">
                <span className={`mobile-status-dot ${remoteStatus}`} />
                <div className="mobile-status-info">
                  <span className="mobile-status-label">Remote Server</span>
                  <span className="mobile-status-detail">{remoteHost}</span>
                </div>
                {remoteStatus === 'disconnected' && (
                  <button className="mobile-reconnect-btn" onClick={handleReconnect}>
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="mobile-tools-divider" />

          {/* Tool buttons */}
          <div className="mobile-tools-buttons">
            <button
              className="mobile-tool-btn"
              onClick={() => {
                togglePerformanceHUD()
                setIsOpen(false)
              }}
              title="Performance monitor (F1)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 20V10M18 20V4M6 20v-4" />
              </svg>
              <span>Perf</span>
            </button>

            <button
              className="mobile-tool-btn"
              onClick={() => {
                toggleModelMatchingModal()
                setIsOpen(false)
              }}
              title="Model matching (F3)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
              <span>Models</span>
            </button>

            <button
              className="mobile-tool-btn"
              onClick={() => {
                onCommandClick()
                setIsOpen(false)
              }}
              title="Open command input"
            >
              <span className="cmd-dot">.</span>
              <span>Cmd</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default MobileToolsFlyout
