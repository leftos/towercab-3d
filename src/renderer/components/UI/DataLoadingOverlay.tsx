import { useEffect, useState } from 'react'
import { useAircraftTimelineStore } from '../../stores/aircraftTimelineStore'
import './DataLoadingOverlay.css'

/**
 * Overlay that shows when waiting for aircraft data to arrive.
 *
 * We need at least 2 data points per aircraft to interpolate smoothly.
 * This overlay shows until we have enough data for at least one aircraft.
 *
 * Positioned in the bottom-left corner with a spinner animation.
 */
export function DataLoadingOverlay() {
  const [hasReadyAircraft, setHasReadyAircraft] = useState(false)

  // Poll the timeline store to check if any aircraft is ready
  // Using polling instead of subscription since hasReadyAircraft is a derived state
  useEffect(() => {
    const checkReady = () => {
      const ready = useAircraftTimelineStore.getState().hasReadyAircraft()
      setHasReadyAircraft(ready)
    }

    // Check immediately
    checkReady()

    // Poll every 100ms while waiting
    const interval = setInterval(checkReady, 100)

    return () => clearInterval(interval)
  }, [])

  // Don't render if we have ready aircraft
  if (hasReadyAircraft) {
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
