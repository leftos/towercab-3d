import { useEffect, useState, useCallback } from 'react'
import { Ion, Viewer } from 'cesium'
import { shellApi } from './utils/tauriApi'
import CesiumViewer from './components/CesiumViewer/CesiumViewer'
import TopBar from './components/UI/TopBar'
import AircraftPanel from './components/UI/AircraftPanel'
import ControlsBar from './components/UI/ControlsBar'
import AirportSelector from './components/UI/AirportSelector'
import CommandInput from './components/UI/CommandInput'
import TouchControls from './components/UI/TouchControls'
import DeviceOptimizationPrompt from './components/UI/DeviceOptimizationPrompt'
import RemoteIndicator from './components/UI/RemoteIndicator'
import MeasuringTool from './components/UI/MeasuringTool'
import MetarOverlay from './components/UI/MetarOverlay'
import UpdateNotification from './components/UI/UpdateNotification'
import ViewportManager from './components/Viewport/ViewportManager'
import VRScene from './components/VR/VRScene'
import { PerformanceHUD } from './components/UI/PerformanceHUD'
import ModelMatchingModal from './components/UI/ModelMatchingModal'
import AircraftTimelineModal from './components/UI/AircraftTimelineModal'
import { WeatherDebugPanel } from './components/UI/WeatherDebugPanel'
import { VnasPanel } from './components/UI/VnasPanel'
import { performanceMonitor } from './utils/performanceMonitor'
import { useVatsimStore } from './stores/vatsimStore'
import { useRealTrafficStore } from './stores/realTrafficStore'
import { useAirportStore } from './stores/airportStore'
import { useSettingsStore } from './stores/settingsStore'
import { useGlobalSettingsStore, initializeGlobalSettings } from './stores/globalSettingsStore'
import { useWeatherStore } from './stores/weatherStore'
import { useViewportStore } from './stores/viewportStore'
import { useVRStore } from './stores/vrStore'
import { useUIFeedbackStore } from './stores/uiFeedbackStore'
import { useRunwayStore } from './stores/runwayStore'
import { useVnasStore } from './stores/vnasStore'
import { useAircraftTimelineStore } from './stores/aircraftTimelineStore'
import { airportService } from './services/AirportService'
import { aircraftDimensionsService } from './services/AircraftDimensionsService'
import { fsltlService } from './services/FSLTLService'
import * as fsltlApi from './services/fsltlApi'
import { migrateFromElectron, isMigrationComplete } from './services/MigrationService'
import { modService } from './services/ModService'
import { realTrafficService } from './services/RealTrafficService'
import { isOrbitWithoutAirport } from './utils/viewingContext'
import { isRemoteMode } from './utils/remoteMode'

function App() {
  const startPolling = useVatsimStore((state) => state.startPolling)
  const loadAirports = useAirportStore((state) => state.loadAirports)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  // Cesium token and FSLTL settings come from global settings (shared across browsers)
  const setCesiumIonToken = useGlobalSettingsStore((state) => state.setCesiumIonToken)
  const fsltlSourcePath = useGlobalSettingsStore((state) => state.fsltl.sourcePath)
  const fsltlOutputPath = useGlobalSettingsStore((state) => state.fsltl.outputPath)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showMetarOverlay = useSettingsStore((state) => state.ui.showMetarOverlay)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const followingCallsign = useViewportStore((state) => state.getActiveCameraState().followingCallsign)
  const followMode = useViewportStore((state) => state.getActiveCameraState().followMode)
  const fetchWeather = useWeatherStore((state) => state.fetchWeather)
  const startAutoRefresh = useWeatherStore((state) => state.startAutoRefresh)
  const startNearestAutoRefresh = useWeatherStore((state) => state.startNearestAutoRefresh)
  const stopAutoRefresh = useWeatherStore((state) => state.stopAutoRefresh)
  const clearWeather = useWeatherStore((state) => state.clearWeather)

  // VR state
  const isVRActive = useVRStore((state) => state.isVRActive)
  const checkVRSupport = useVRStore((state) => state.checkVRSupport)

  // Bookmark shortcuts
  const loadBookmark = useViewportStore((state) => state.loadBookmark)
  const currentAirportIcao = useViewportStore((state) => state.currentAirportIcao)
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  const [isLoading, setIsLoading] = useState(true)
  const [loadingStatus, setLoadingStatus] = useState('Initializing...')

  // Track Cesium viewer for VR integration
  const [cesiumViewer, setCesiumViewer] = useState<Viewer | null>(null)

  // Debug overlays (from store, accessible by touch controls)
  const showPerformanceHUD = useUIFeedbackStore((state) => state.showPerformanceHUD)
  const togglePerformanceHUD = useUIFeedbackStore((state) => state.togglePerformanceHUD)
  const showModelMatchingModal = useUIFeedbackStore((state) => state.showModelMatchingModal)
  const toggleModelMatchingModal = useUIFeedbackStore((state) => state.toggleModelMatchingModal)
  const setShowModelMatchingModal = useUIFeedbackStore((state) => state.setShowModelMatchingModal)
  const showTimelineDebugModal = useUIFeedbackStore((state) => state.showTimelineDebugModal)
  const toggleTimelineDebugModal = useUIFeedbackStore((state) => state.toggleTimelineDebugModal)
  const setShowTimelineDebugModal = useUIFeedbackStore((state) => state.setShowTimelineDebugModal)

  // Cesium token prompt
  const [showTokenPrompt, setShowTokenPrompt] = useState(false)
  const [tokenInput, setTokenInput] = useState('')

  const handleViewerReady = useCallback((viewer: Viewer | null) => {
    setCesiumViewer(viewer)
  }, [])

  useEffect(() => {
    async function initialize() {
      try {
        // Initialize global settings first (loads from host file system)
        // This also migrates cesiumIonToken and FSLTL settings from localStorage
        setLoadingStatus('Loading settings...')
        await initializeGlobalSettings()

        // Migrate settings from Electron version (one-time, on first launch)
        if (!isMigrationComplete()) {
          setLoadingStatus('Checking for previous installation...')
          const migrationResult = await migrateFromElectron()
          if (migrationResult.settingsFound) {
            console.log('Migrated settings from Electron version')
          }
        }

        // Set Cesium Ion access token (from global settings)
        const token = useGlobalSettingsStore.getState().cesiumIonToken
        if (token) {
          Ion.defaultAccessToken = token
        }

        // Load mods (tower positions, custom aircraft, etc.)
        setLoadingStatus('Loading mods...')
        await modService.loadMods()

        // Load airport database
        setLoadingStatus('Loading airport database...')
        const airports = await airportService.loadAirports()
        loadAirports(Object.fromEntries(airports))

        // Load runway database (non-blocking, used for smart sort)
        useRunwayStore.getState().loadRunways()

        // Load aircraft dimensions data (non-blocking)
        aircraftDimensionsService.load()

        // Initialize FSLTL service (loads registry and VMR rules if source path is set)
        setLoadingStatus('Loading aircraft models...')
        await fsltlService.initialize()

        // Scan output directory for existing models and rebuild registry
        // This ensures models are loaded even if they were converted with a different path
        let outputPath = fsltlOutputPath
        try {
          // Use saved output path or get default
          console.log(`[App] FSLTL outputPath from settings: ${outputPath}`)
          if (!outputPath) {
            const [defaultPath] = await fsltlApi.getFsltlDefaultOutputPath()
            outputPath = defaultPath
            console.log(`[App] Using default FSLTL path: ${outputPath}`)
          }
          if (outputPath) {
            const scannedCount = await fsltlService.scanAndRebuildRegistry(outputPath)
            console.log(`[App] Scanned ${scannedCount} FSLTL models from ${outputPath}`)
          }
        } catch (err) {
          console.warn('[App] Failed to scan FSLTL models:', err)
        }

        // Load VMR rules - try output folder first (copied during conversion), then source folder
        let vmrLoaded = false
        if (outputPath) {
          try {
            const vmrContent = await fsltlApi.readVmrFromOutput(outputPath)
            if (vmrContent) {
              fsltlService.parseVMRContent(vmrContent)
              console.log('[App] Loaded FSLTL VMR rules from output folder')
              vmrLoaded = true
            }
          } catch (err) {
            console.warn('[App] Failed to load VMR from output folder:', err)
          }
        }
        if (!vmrLoaded && fsltlSourcePath) {
          try {
            const vmrContent = await fsltlApi.readVmrFile(fsltlSourcePath)
            fsltlService.parseVMRContent(vmrContent)
            console.log('[App] Loaded FSLTL VMR rules from source folder')
          } catch (err) {
            console.warn('[App] Failed to load FSLTL VMR (source may not exist):', err)
          }
        }

        // Start data source polling based on settings
        const dataSource = useGlobalSettingsStore.getState().realtraffic.dataSource
        if (dataSource === 'realtraffic') {
          const licenseKey = useGlobalSettingsStore.getState().realtraffic.licenseKey
          if (licenseKey) {
            setLoadingStatus('Connecting to RealTraffic...')
            const rtStore = useRealTrafficStore.getState()
            await rtStore.authenticate(licenseKey)
            // If authentication succeeded and we're connected, start polling
            if (useRealTrafficStore.getState().status === 'connected') {
              rtStore.startPolling()
              // Start the timeline store prune timer for RealTraffic
              useAircraftTimelineStore.getState().startPruneTimer()
            }
          } else {
            setLoadingStatus('RealTraffic license required...')
            // No license key - user will need to enter one in settings
          }
        } else {
          // VATSIM data source
          setLoadingStatus('Connecting to VATSIM...')
          startPolling()
          // Start the timeline store prune timer for VATSIM
          useAircraftTimelineStore.getState().startPruneTimer()
        }

        // Check VR support
        checkVRSupport()

        setIsLoading(false)

        // Show token prompt if no Cesium Ion token is set (check global settings)
        const globalToken = useGlobalSettingsStore.getState().cesiumIonToken
        if (!globalToken) {
          setShowTokenPrompt(true)
        }

        // Start performance logging to console
        performanceMonitor.startLogging()
      } catch (error) {
        console.error('Initialization error:', error)
        setLoadingStatus(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    initialize()

    return () => {
      performanceMonitor.stopLogging()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPolling, loadAirports, checkVRSupport])

  // Deep link handler for OAuth callbacks (tc3d://oauth/callback)
  useEffect(() => {
    // Only handle deep links in desktop mode (not remote browser)
    if (isRemoteMode()) return

    let cleanup: (() => void) | undefined

    async function setupDeepLinkHandler() {
      try {
        const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')

        cleanup = await onOpenUrl((urls) => {
          console.log('[App] Deep link received:', urls)

          for (const url of urls) {
            // Handle OAuth callback
            if (url.startsWith('tc3d://oauth/callback')) {
              console.log('[App] OAuth callback received, processing...')
              useVnasStore.getState().handleOAuthCallback(url)
                .then(() => {
                  console.log('[App] OAuth callback processed successfully')
                  showFeedback('vNAS authentication successful', 'success')
                })
                .catch((error) => {
                  console.error('[App] OAuth callback failed:', error)
                  showFeedback(`vNAS auth failed: ${error}`, 'error')
                })
            }
          }
        })
      } catch (error) {
        // Deep link plugin may not be available (e.g., in dev mode without Tauri)
        console.warn('[App] Deep link handler not available:', error)
      }
    }

    setupDeepLinkHandler()

    return () => {
      if (cleanup) cleanup()
    }
  }, [showFeedback])

  // Cleanup RealTraffic session when app is closing
  // This releases the server-side session to allow immediate reconnection
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Fire-and-forget deauth - we don't await since the window is closing
      realTrafficService.deauthenticate().catch(() => {
        // Ignore errors during shutdown
      })
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // Also deauth when the component unmounts (e.g., hot reload in dev)
      realTrafficService.deauthenticate().catch(() => {})
    }
  }, [])

  // Fetch weather data when airport changes or weather effects are enabled
  // When no airport is selected but orbit-following an aircraft, use nearest METAR mode
  const currentIcao = currentAirport?.icao
  const orbitWithoutAirport = isOrbitWithoutAirport(currentAirport, followMode, followingCallsign)

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
    } else if (orbitWithoutAirport) {
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
  }, [currentIcao, showWeatherEffects, orbitWithoutAirport, fetchWeather, startAutoRefresh, startNearestAutoRefresh, stopAutoRefresh, clearWeather])

  // Register modals with UI feedback store for keyboard blocking
  useEffect(() => {
    if (showModelMatchingModal) {
      pushModal()
      return () => popModal()
    }
  }, [showModelMatchingModal, pushModal, popModal])

  useEffect(() => {
    if (showTimelineDebugModal) {
      pushModal()
      return () => popModal()
    }
  }, [showTimelineDebugModal, pushModal, popModal])

  useEffect(() => {
    if (showTokenPrompt) {
      pushModal()
      return () => popModal()
    }
  }, [showTokenPrompt, pushModal, popModal])

  // Keyboard shortcuts for overlays and bookmarks
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in input field
      if (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          e.target instanceof HTMLSelectElement) {
        return
      }

      // Skip if any modal or command input is active
      if (useUIFeedbackStore.getState().isInputBlocked()) {
        return
      }

      if (e.key === 'F1') {
        e.preventDefault()
        togglePerformanceHUD()
      } else if (e.key === 'F3') {
        e.preventDefault()
        toggleModelMatchingModal()
      } else if (e.key === 'F4') {
        e.preventDefault()
        toggleTimelineDebugModal()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        updateUISettings({ showMetarOverlay: !showMetarOverlay })
      } else if (e.ctrlKey && e.key >= '0' && e.key <= '9') {
        // Ctrl+0-9: Quick load bookmarks 0-9
        e.preventDefault()
        const slot = parseInt(e.key, 10)

        if (!currentAirportIcao) {
          showFeedback('No airport selected', 'error')
          return
        }

        const success = loadBookmark(slot)
        if (success) {
          showFeedback(`Loaded bookmark .${slot}`, 'success')
        } else {
          showFeedback(`No bookmark at .${slot}`, 'error')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showMetarOverlay, updateUISettings, currentAirportIcao, loadBookmark, showFeedback, togglePerformanceHUD, toggleModelMatchingModal])


  if (isLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-content">
          <img src="/logo.png" alt="TowerCab 3D" className="loading-logo" />
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
          .loading-logo {
            width: 128px;
            height: 128px;
            margin-bottom: 24px;
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
      {!isVRActive && <RemoteIndicator />}
      {!isVRActive && <UpdateNotification />}
      {!isVRActive && <MetarOverlay />}
      <div className="main-content">
        <ViewportManager mainViewportContent={<CesiumViewer onViewerReady={handleViewerReady} />}>
          {!isVRActive && <CommandInput />}
          {!isVRActive && (currentAirport || followingCallsign) && <AircraftPanel />}
        </ViewportManager>
      </div>
      {!isVRActive && <ControlsBar />}
      {!isVRActive && <TouchControls />}
      {!isVRActive && import.meta.env.DEV && <WeatherDebugPanel />}
      {!isVRActive && import.meta.env.DEV && <VnasPanel />}
      {!isVRActive && <AirportSelector />}
      {!isVRActive && <MeasuringTool cesiumViewer={cesiumViewer} />}
      <PerformanceHUD visible={showPerformanceHUD} />
      {!isVRActive && showModelMatchingModal && (
        <ModelMatchingModal onClose={() => setShowModelMatchingModal(false)} />
      )}
      {!isVRActive && showTimelineDebugModal && (
        <AircraftTimelineModal onClose={() => setShowTimelineDebugModal(false)} />
      )}

      {/* Cesium Ion Token Prompt */}
      {showTokenPrompt && (
        <div className="token-prompt-overlay">
          <div className="token-prompt-modal">
            <h2>Cesium Ion Access Token Required</h2>
            <p>
              TowerCab 3D uses Cesium Ion for terrain and satellite imagery.
              You need a free access token to continue.
            </p>
            <ol>
              <li>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://ion.cesium.com/signup/') }}
                  className="external-link"
                >
                  Create a free Cesium Ion account
                </a>
              </li>
              <li>
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); shellApi.openExternal('https://ion.cesium.com/tokens') }}
                  className="external-link"
                >
                  Go to Access Tokens
                </a>
                {' '}and copy your default token
              </li>
              <li>Paste it below:</li>
            </ol>
            <input
              type="text"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste your Cesium Ion access token here"
              className="token-input"
            />
            <div className="token-prompt-buttons">
              <button
                className="token-button secondary"
                onClick={() => setShowTokenPrompt(false)}
              >
                Skip for now
              </button>
              <button
                className="token-button primary"
                onClick={async () => {
                  if (tokenInput.trim()) {
                    // Save to global settings (host file system)
                    await setCesiumIonToken(tokenInput.trim())
                    Ion.defaultAccessToken = tokenInput.trim()
                  }
                  setShowTokenPrompt(false)
                }}
                disabled={!tokenInput.trim()}
              >
                Save Token
              </button>
            </div>
          </div>
          <style>{`
            .token-prompt-overlay {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              bottom: 0;
              background: rgba(0, 0, 0, 0.8);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 10000;
            }
            .token-prompt-modal {
              background: #1a1a2e;
              border: 1px solid #333;
              border-radius: 8px;
              padding: 24px;
              max-width: 500px;
              width: 90%;
              color: #fff;
            }
            .token-prompt-modal h2 {
              margin: 0 0 16px 0;
              font-size: 20px;
              color: #4fc3f7;
            }
            .token-prompt-modal p {
              margin: 0 0 16px 0;
              color: rgba(255, 255, 255, 0.8);
              line-height: 1.5;
            }
            .token-prompt-modal ol {
              margin: 0 0 16px 0;
              padding-left: 20px;
              color: rgba(255, 255, 255, 0.8);
              line-height: 1.8;
            }
            .token-prompt-modal .external-link {
              color: #4fc3f7;
              text-decoration: none;
            }
            .token-prompt-modal .external-link:hover {
              text-decoration: underline;
            }
            .token-input {
              width: 100%;
              padding: 10px 12px;
              border: 1px solid #444;
              border-radius: 4px;
              background: #0a0a0f;
              color: #fff;
              font-size: 14px;
              margin-bottom: 16px;
              box-sizing: border-box;
            }
            .token-input:focus {
              outline: none;
              border-color: #4fc3f7;
            }
            .token-prompt-buttons {
              display: flex;
              gap: 12px;
              justify-content: flex-end;
            }
            .token-button {
              padding: 8px 16px;
              border-radius: 4px;
              font-size: 14px;
              cursor: pointer;
              border: none;
            }
            .token-button.primary {
              background: #4fc3f7;
              color: #000;
            }
            .token-button.primary:disabled {
              opacity: 0.5;
              cursor: not-allowed;
            }
            .token-button.secondary {
              background: transparent;
              border: 1px solid #444;
              color: #aaa;
            }
            .token-button.secondary:hover {
              border-color: #666;
              color: #fff;
            }
          `}</style>
        </div>
      )}

      {/* Device Optimization Prompt for touch devices */}
      {!isVRActive && <DeviceOptimizationPrompt />}
    </div>
  )
}

export default App
