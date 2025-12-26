/**
 * Remote Indicator Component
 *
 * Shows connection status badge when running in remote/browser mode.
 * Displays the host server URL and connection status.
 */

import { useState, useEffect } from 'react'
import { isRemoteMode } from '../../utils/remoteMode'
import './RemoteIndicator.css'

type ConnectionStatus = 'connected' | 'checking' | 'disconnected'

function RemoteIndicator() {
  const [status, setStatus] = useState<ConnectionStatus>('checking')
  const [hostname, setHostname] = useState('')
  const [lastCheckTime, setLastCheckTime] = useState<Date | null>(null)

  useEffect(() => {
    // Only show in remote mode
    if (!isRemoteMode()) return

    // Get host info from current URL
    const host = window.location.host
    setHostname(host)

    // Check connection status periodically
    const checkConnection = async () => {
      try {
        const response = await fetch('/api/global-settings', {
          method: 'GET',
          cache: 'no-store'
        })
        if (response.ok) {
          setStatus('connected')
          setLastCheckTime(new Date())
        } else {
          setStatus('disconnected')
        }
      } catch {
        setStatus('disconnected')
      }
    }

    // Initial check
    checkConnection()

    // Check every 30 seconds
    const interval = setInterval(checkConnection, 30000)

    return () => clearInterval(interval)
  }, [])

  // Don't render if not in remote mode
  if (!isRemoteMode()) return null

  const statusLabel = {
    connected: 'Connected',
    checking: 'Connecting...',
    disconnected: 'Disconnected'
  }[status]

  const handleReconnect = async () => {
    setStatus('checking')
    try {
      const response = await fetch('/api/global-settings', {
        method: 'GET',
        cache: 'no-store'
      })
      if (response.ok) {
        setStatus('connected')
        setLastCheckTime(new Date())
      } else {
        setStatus('disconnected')
      }
    } catch {
      setStatus('disconnected')
    }
  }

  return (
    <div className={`remote-indicator remote-indicator--${status}`}>
      <div className="remote-indicator__status">
        <span className="remote-indicator__dot" />
        <span className="remote-indicator__label">{statusLabel}</span>
      </div>
      <div className="remote-indicator__host">{hostname}</div>
      {status === 'disconnected' && (
        <button className="remote-indicator__reconnect" onClick={handleReconnect}>
          Reconnect
        </button>
      )}
      {status === 'connected' && lastCheckTime && (
        <div className="remote-indicator__time">
          Last: {lastCheckTime.toLocaleTimeString()}
        </div>
      )}
    </div>
  )
}

export default RemoteIndicator
