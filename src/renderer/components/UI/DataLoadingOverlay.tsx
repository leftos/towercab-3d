import { useEffect, useState } from 'react'
import { useAircraftTimelineStore } from '../../stores/aircraftTimelineStore'
import './DataLoadingOverlay.css'

/**
 * Overlay that shows when waiting for aircraft data to arrive.
 *
 * We need at least 2 data points per aircraft to interpolate smoothly.
 * This overlay shows when:
 * - There's at least 1 aircraft in range (has received data)
 * - But none of them have 2+ observations yet (not ready to render)
 *
 * Positioned in the bottom-left corner with a spinner animation.
 */
export function DataLoadingOverlay() {
  const [showOverlay, setShowOverlay] = useState(false)

  // Poll the timeline store to check data loading status
  useEffect(() => {
    const checkStatus = () => {
      const { hasAircraftInRange, hasReadyAircraft } = useAircraftTimelineStore.getState().getDataLoadingStatus()
      // Show overlay when we have aircraft in range but none are ready yet
      setShowOverlay(hasAircraftInRange && !hasReadyAircraft)
    }

    // Check immediately
    checkStatus()

    // Poll every 100ms while waiting
    const interval = setInterval(checkStatus, 100)

    return () => clearInterval(interval)
  }, [])

  if (!showOverlay) {
    return null
  }

  return (
    <div className="data-loading-overlay">
      <div className="data-loading-spinner" />
      <span className="data-loading-text">Waiting for data updates...</span>
    </div>
  )
}

export default DataLoadingOverlay
