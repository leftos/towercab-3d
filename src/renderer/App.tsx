import { useEffect, useState } from 'react'
import { Ion } from 'cesium'
import CesiumViewer from './components/CesiumViewer/CesiumViewer'
import TopBar from './components/UI/TopBar'
import AircraftPanel from './components/UI/AircraftPanel'
import ControlsBar from './components/UI/ControlsBar'
import AirportSelector from './components/UI/AirportSelector'
import CommandInput from './components/UI/CommandInput'
import { useVatsimStore } from './stores/vatsimStore'
import { useAirportStore } from './stores/airportStore'
import { useSettingsStore } from './stores/settingsStore'
import { useWeatherStore } from './stores/weatherStore'
import { airportService } from './services/AirportService'

function App() {
  const startPolling = useVatsimStore((state) => state.startPolling)
  const loadAirports = useAirportStore((state) => state.loadAirports)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const fetchWeather = useWeatherStore((state) => state.fetchWeather)
  const startAutoRefresh = useWeatherStore((state) => state.startAutoRefresh)
  const stopAutoRefresh = useWeatherStore((state) => state.stopAutoRefresh)
  const clearWeather = useWeatherStore((state) => state.clearWeather)

  const [isLoading, setIsLoading] = useState(true)
  const [loadingStatus, setLoadingStatus] = useState('Initializing...')

  useEffect(() => {
    async function initialize() {
      try {
        // Set Cesium Ion access token
        if (cesiumIonToken) {
          Ion.defaultAccessToken = cesiumIonToken
        }

        // Load airport database
        setLoadingStatus('Loading airport database...')
        const airports = await airportService.loadAirports()
        loadAirports(Object.fromEntries(airports))

        // Start VATSIM data polling
        setLoadingStatus('Connecting to VATSIM...')
        startPolling()

        setIsLoading(false)
      } catch (error) {
        console.error('Initialization error:', error)
        setLoadingStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    initialize()
  }, [cesiumIonToken, startPolling, loadAirports])

  // Fetch weather data when airport changes or weather effects are enabled
  const currentIcao = currentAirport?.icao
  useEffect(() => {
    if (!currentIcao || !showWeatherEffects) {
      stopAutoRefresh()
      if (!showWeatherEffects) {
        clearWeather()
      }
      return
    }

    // Fetch immediately on airport change
    fetchWeather(currentIcao)

    // Start 5-minute auto-refresh
    startAutoRefresh(currentIcao)

    return () => {
      stopAutoRefresh()
    }
  }, [currentIcao, showWeatherEffects, fetchWeather, startAutoRefresh, stopAutoRefresh, clearWeather])

  if (isLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-content">
          <h1>TowerCab 3D</h1>
          <div className="loading-spinner"></div>
          <p>{loadingStatus}</p>
        </div>
        <style>{`
          .loading-screen {
            width: 100vw;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2f 100%);
          }
          .loading-content {
            text-align: center;
            color: white;
          }
          .loading-content h1 {
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 24px;
            color: #4fc3f7;
          }
          .loading-spinner {
            width: 40px;
            height: 40px;
            border: 3px solid rgba(79, 195, 247, 0.2);
            border-top-color: #4fc3f7;
            border-radius: 50%;
            margin: 0 auto 16px;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          .loading-content p {
            font-size: 14px;
            color: rgba(255, 255, 255, 0.6);
          }
        `}</style>
      </div>
    )
  }

  return (
    <div className="app">
      <TopBar />
      <div className="main-content">
        <CommandInput />
        <CesiumViewer />
        <AircraftPanel />
      </div>
      <ControlsBar />
      <AirportSelector />
    </div>
  )
}

export default App
