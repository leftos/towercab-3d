import { useEffect, useState } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import './TopBar.css'

function TopBar() {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const setAirportSelectorOpen = useAirportStore((state) => state.setAirportSelectorOpen)
  const isConnected = useVatsimStore((state) => state.isConnected)
  const lastUpdate = useVatsimStore((state) => state.lastUpdate)
  const pilots = useVatsimStore((state) => state.pilots)

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
          <span className="aircraft-count">{pilots.length} aircraft online</span>
          <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default TopBar
