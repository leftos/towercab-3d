import { useEffect, useState } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useViewportStore } from '../../stores/viewportStore'
import './TopBar.css'

/**
 * Convert heading (0-360) to cardinal direction
 */
function getCardinalDirection(heading: number): string {
  const h = ((heading % 360) + 360) % 360
  if (h >= 337.5 || h < 22.5) return 'N'
  if (h >= 22.5 && h < 67.5) return 'NE'
  if (h >= 67.5 && h < 112.5) return 'E'
  if (h >= 112.5 && h < 157.5) return 'SE'
  if (h >= 157.5 && h < 202.5) return 'S'
  if (h >= 202.5 && h < 247.5) return 'SW'
  if (h >= 247.5 && h < 292.5) return 'W'
  return 'NW'
}

function TopBar() {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const setAirportSelectorOpen = useAirportStore((state) => state.setAirportSelectorOpen)
  const isConnected = useVatsimStore((state) => state.isConnected)
  const totalPilotsFromApi = useVatsimStore((state) => state.totalPilotsFromApi)
  const heading = useViewportStore((state) => state.getActiveCameraState().heading)

  const [zuluTime, setZuluTime] = useState('')

  // Update Zulu time every second
  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      const hours = now.getUTCHours().toString().padStart(2, '0')
      const minutes = now.getUTCMinutes().toString().padStart(2, '0')
      const seconds = now.getUTCSeconds().toString().padStart(2, '0')
      setZuluTime(`${hours}:${minutes}:${seconds}Z`)
    }

    updateTime()
    const interval = setInterval(updateTime, 1000)

    return () => clearInterval(interval)
  }, [])

  const handleAirportClick = () => {
    setAirportSelectorOpen(true)
  }

  return (
    <div className="top-bar">
      <div className="top-bar-left">
        <span className="compass-direction">{getCardinalDirection(heading)}</span>
        <button className="airport-button" onClick={handleAirportClick}>
          {currentAirport ? (
            <>
              <span className="airport-icao">{currentAirport.icao}</span>
              <span className="airport-name">{currentAirport.name}</span>
            </>
          ) : (
            <span className="airport-placeholder">Select Airport</span>
          )}
        </button>
      </div>

      <div className="top-bar-center">
        <span className="zulu-time">{zuluTime}</span>
      </div>

      <div className="top-bar-right">
        <div className="status-info">
          <span className="aircraft-count">{totalPilotsFromApi} pilots online</span>
          <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default TopBar
