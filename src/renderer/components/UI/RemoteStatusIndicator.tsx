/**
 * Remote Status Indicator Component
 *
 * Compact indicator showing connection status and observation health
 * for remote browser clients. Displayed in the TopBar.
 *
 * Uses source-aware stale thresholds:
 * - vNAS: 5 seconds (1Hz updates)
 * - RealTraffic: 8 seconds (~3s updates)
 * - VATSIM: 25 seconds (15s updates)
 */

import { useEffect, useState } from 'react'
import { SOURCE_STALE_THRESHOLDS, useRemoteStatusStore } from '../../stores/remoteStatusStore'
import { isRemoteMode } from '../../utils/remoteMode'
import './RemoteStatusIndicator.css'

function RemoteStatusIndicator() {
  const wsConnected = useRemoteStatusStore((state) => state.wsConnected)
  const lastObservationTime = useRemoteStatusStore((state) => state.lastObservationTime)
  const lastSource = useRemoteStatusStore((state) => state.lastSource)

  // Track "stale" state - no observations beyond source-specific threshold
  const [isStale, setIsStale] = useState(false)

  useEffect(() => {
    if (!wsConnected) {
      setIsStale(false)
      return
    }

    const checkStale = () => {
      const now = Date.now()
      // Use source-specific threshold, default to VATSIM (most lenient) if unknown
      const threshold = lastSource ? SOURCE_STALE_THRESHOLDS[lastSource] : SOURCE_STALE_THRESHOLDS.vatsim
      const stale = lastObservationTime > 0 && now - lastObservationTime > threshold
      setIsStale(stale)
    }

    // Check immediately and every second
    checkStale()
    const interval = setInterval(checkStale, 1000)

    return () => clearInterval(interval)
  }, [wsConnected, lastObservationTime, lastSource])

  // Don't render if not in remote mode
  if (!isRemoteMode()) return null

  // Determine status
  let status: 'connected' | 'stale' | 'disconnected'
  let label: string

  if (!wsConnected) {
    status = 'disconnected'
    label = 'Disconnected'
  } else if (isStale) {
    status = 'stale'
    label = 'No data'
  } else {
    status = 'connected'
    label = 'Live'
  }

  // Format time since last observation
  const timeSinceObs = lastObservationTime > 0 ? Math.floor((Date.now() - lastObservationTime) / 1000) : null

  return (
    <div className={`remote-status-indicator remote-status-indicator--${status}`}>
      <span className="remote-status-indicator__dot" />
      <span className="remote-status-indicator__label">{label}</span>
      {status === 'stale' && timeSinceObs !== null && (
        <span className="remote-status-indicator__time">{timeSinceObs}s ago</span>
      )}
    </div>
  )
}

export default RemoteStatusIndicator
