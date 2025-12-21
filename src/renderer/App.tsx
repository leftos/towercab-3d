import { useEffect, useState, useCallback } from 'react'
import { Ion, Viewer } from 'cesium'
import CesiumViewer from './components/CesiumViewer/CesiumViewer'
import TopBar from './components/UI/TopBar'
import AircraftPanel from './components/UI/AircraftPanel'
import ControlsBar from './components/UI/ControlsBar'
import AirportSelector from './components/UI/AirportSelector'
import CommandInput from './components/UI/CommandInput'
import MeasuringTool from './components/UI/MeasuringTool'
import ViewportManager from './components/Viewport/ViewportManager'
import VRScene from './components/VR/VRScene'
import { useVatsimStore } from './stores/vatsimStore'
import { useAirportStore } from './stores/airportStore'
import { useSettingsStore } from './stores/settingsStore'
import { useWeatherStore } from './stores/weatherStore'
import { useCameraStore } from './stores/cameraStore'
import { useVRStore } from './stores/vrStore'
import { airportService } from './services/AirportService'
import { aircraftDimensionsService } from './services/AircraftDimensionsService'
import { migrateFromElectron, isMigrationComplete } from './services/MigrationService'

function App() {
  const startPolling = useVatsimStore((state) => state.startPolling)
  const loadAirports = useAirportStore((state) => state.loadAirports)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const fetchWeather = useWeatherStore((state) => state.fetchWeather)
  const startAutoRefresh = useWeatherStore((state) => state.startAutoRefresh)
  const startNearestAutoRefresh = useWeatherStore((state) => state.startNearestAutoRefresh)
  const stopAutoRefresh = useWeatherStore((state) => state.stopAutoRefresh)
  const clearWeather = useWeatherStore((state) => state.clearWeather)

  // VR state
  const isVRActive = useVRStore((state) => state.isVRActive)
  const checkVRSupport = useVRStore((state) => state.checkVRSupport)

  const [isLoading, setIsLoading] = useState(true)
  const [loadingStatus, setLoadingStatus] = useState('Initializing...')

  // Track Cesium viewer for VR integration
  const [cesiumViewer, setCesiumViewer] = useState<Viewer | null>(null)

  const handleViewerReady = useCallback((viewer: Viewer | null) => {
    setCesiumViewer(viewer)
  }, [])

  useEffect(() => {
    async function initialize() {
      try {
        // Migrate settings from Electron version (one-time, on first launch)
        if (!isMigrationComplete()) {
          setLoadingStatus('Checking for previous installation...')
          const migrationResult = await migrateFromElectron()
          if (migrationResult.settingsFound) {
            console.log('Migrated settings from Electron version')
          }
        }

        // Set Cesium Ion access token
        if (cesiumIonToken) {
          Ion.defaultAccessToken = cesiumIonToken
        }

        // Load airport database
        setLoadingStatus('Loading airport database...')
        const airports = await airportService.loadAirports()
        loadAirports(Object.fromEntries(airports))

        // Load aircraft dimensions data (non-blocking)
        aircraftDimensionsService.load()

        // Start VATSIM data polling
        setLoadingStatus('Connecting to VATSIM...')
        startPolling()

        // Check VR support
        checkVRSupport()

        setIsLoading(false)
      } catch (error) {
        console.error('Initialization error:', error)
        setLoadingStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    initialize()
  }, [cesiumIonToken, startPolling, loadAirports, checkVRSupport])

  // Fetch weather data when airport changes or weather effects are enabled
  // When no airport is selected but following an aircraft, use nearest METAR mode
  const currentIcao = currentAirport?.icao
  const isOrbitModeWithoutAirport = !currentAirport && followingCallsign

  useEffect(() => {
    if (!showWeatherEffects) {
      stopAutoRefresh()
      clearWeather()
      return
    }

    if (currentIcao) {
      // Airport selected - use airport's METAR
      fetchWeather(currentIcao)
      startAutoRefresh(currentIcao)
    } else if (isOrbitModeWithoutAirport) {
      // No airport but following aircraft - use nearest METAR mode
      // The actual position updates will come from CesiumViewer
      startNearestAutoRefresh()
    } else {
      // No airport and not following - stop weather
      stopAutoRefresh()
    }

    return () => {
      stopAutoRefresh()
    }
  }, [currentIcao, showWeatherEffects, isOrbitModeWithoutAirport, fetchWeather, startAutoRefresh, startNearestAutoRefresh, stopAutoRefresh, clearWeather])

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
      {/* VR Scene - renders when VR is active */}
      <VRScene cesiumViewer={cesiumViewer} />

      {/* Hide normal UI when VR is active */}
      {!isVRActive && <TopBar />}
      <div className="main-content">
        <ViewportManager mainViewportContent={<CesiumViewer onViewerReady={handleViewerReady} />}>
          {!isVRActive && <CommandInput />}
          {!isVRActive && <AircraftPanel />}
        </ViewportManager>
      </div>
      {!isVRActive && <ControlsBar />}
      {!isVRActive && <AirportSelector />}
      {!isVRActive && <MeasuringTool cesiumViewer={cesiumViewer} />}
    </div>
  )
}

export default App
