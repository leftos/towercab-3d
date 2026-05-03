import { Ion, type Viewer } from 'cesium'
import { useCallback, useEffect, useState } from 'react'
import CesiumViewer from './components/CesiumViewer/CesiumViewer'
import AircraftPanel from './components/UI/AircraftPanel'
import AircraftTimelineModal from './components/UI/AircraftTimelineModal'
import AirportSelector from './components/UI/AirportSelector'
import CommandInput from './components/UI/CommandInput'
import ControlsBar from './components/UI/ControlsBar'
import DataLoadingOverlay from './components/UI/DataLoadingOverlay'
import DeviceOptimizationPrompt from './components/UI/DeviceOptimizationPrompt'
import LoadingScreen, { type LoadingProgress, type LoadingStep } from './components/UI/LoadingScreen'
import MagnificationIndicator from './components/UI/MagnificationIndicator'
import MeasuringTool from './components/UI/MeasuringTool'
import MetarOverlay from './components/UI/MetarOverlay'
import ModelMatchingModal from './components/UI/ModelMatchingModal'
import { MSFSIndexingModal } from './components/UI/MSFSIndexingModal'
import { PerformanceHUD } from './components/UI/PerformanceHUD'
import TopBar from './components/UI/TopBar'
import TouchControls, { TouchCommandInput } from './components/UI/TouchControls'
import TowerPositioningOverlay from './components/UI/TowerPositioningOverlay'
import UpdateNotification from './components/UI/UpdateNotification'
import { VnasPanel } from './components/UI/VnasPanel'
import { WeatherDebugPanel } from './components/UI/WeatherDebugPanel'
import ViewportManager from './components/Viewport/ViewportManager'
import VRScene from './components/VR/VRScene'
import { useAircraftInterpolation } from './hooks/useAircraftInterpolation'
import { useAirportSyncListener } from './hooks/useAirportSyncListener'
import { usePresenceWebSocket } from './hooks/usePresenceWebSocket'
import { useRemoteObservations } from './hooks/useRemoteObservations'
import { useRemoteVnasSubscription } from './hooks/useRemoteVnasSubscription'
import { useVnasEvents } from './hooks/useVnasEvents'
import { useVnasSubscription } from './hooks/useVnasSubscription'
import { aircraftDimensionsService } from './services/AircraftDimensionsService'
import { airportService } from './services/AirportService'
import { isMigrationComplete, migrateFromElectron } from './services/MigrationService'
import { modService } from './services/ModService'
import { MSFSModelConversionService } from './services/MSFSModelConversionService'
import { realTrafficService } from './services/RealTrafficService'
import { settingsSharedWorkerService } from './services/SettingsSharedWorkerService'
import { userVMRService } from './services/UserVMRService'
import { useAircraftTimelineStore } from './stores/aircraftTimelineStore'
import { useAirportStore } from './stores/airportStore'
import { initializeGlobalSettings, useGlobalSettingsStore } from './stores/globalSettingsStore'
import { useRealTrafficStore } from './stores/realTrafficStore'
import { useRunwayStore } from './stores/runwayStore'
import { useSettingsStore } from './stores/settingsStore'
import { useUIFeedbackStore } from './stores/uiFeedbackStore'
import { useVatsimStore } from './stores/vatsimStore'
import { flushPendingGlobalSync } from './stores/viewport'
import { useViewportStore } from './stores/viewportStore'
import { useVnasStore } from './stores/vnasStore'
import { useVRStore } from './stores/vrStore'
import { useWeatherStore } from './stores/weatherStore'
import { stopFileLogging } from './utils/fileLogger'
import { isRemoteMode } from './utils/remoteMode'
import { shellApi } from './utils/tauriApi'
import type { UrlCameraState } from './utils/urlParams'
import {
  flushUrlCameraSave,
  getUrlAirportParams,
  loadUrlCameraState,
  scheduleSaveUrlCameraState,
} from './utils/urlParams'
import { isOrbitWithoutAirport } from './utils/viewingContext'

function App() {
  const startPolling = useVatsimStore((state) => state.startPolling)
  const loadAirports = useAirportStore((state) => state.loadAirports)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  // Cesium token comes from global settings (shared across browsers)
  const setCesiumIonToken = useGlobalSettingsStore((state) => state.setCesiumIonToken)
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

  // Loading progress state
  const [isLoading, setIsLoading] = useState(true)
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress>({
    currentStep: 0,
    totalSteps: 8,
    stepProgress: 0,
    status: 'Initializing...',
  })

  // Define loading steps with relative weights (heavier = takes longer)
  const loadingSteps: LoadingStep[] = [
    { id: 'settings', label: 'Loading settings', weight: 5 },
    { id: 'migration', label: 'Checking migration', weight: 5 },
    { id: 'mods', label: 'Loading mods', weight: 10 },
    { id: 'airports', label: 'Loading airports', weight: 25 },
    { id: 'msfs', label: 'Detecting MSFS', weight: 30 },
    { id: 'vmr', label: 'Loading VMR rules', weight: 5 },
    { id: 'datasource', label: 'Connecting', weight: 15 },
    { id: 'finalize', label: 'Finalizing', weight: 5 },
  ]

  // Helper to update progress
  const updateProgress = useCallback(
    (step: number, stepProgress: number, status: string) => {
      setLoadingProgress({
        currentStep: step,
        totalSteps: loadingSteps.length,
        stepProgress,
        status,
      })
    },
    [loadingSteps.length],
  )

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

  // Touch command modal state (opened from TopBar's MobileToolsFlyout)
  const [showTouchCommand, setShowTouchCommand] = useState(false)

  // Connect to presence WebSocket in remote mode (registers this client with the server)
  usePresenceWebSocket()

  // Set up vNAS event listeners (receives real-time aircraft updates from Rust backend)
  useVnasEvents()

  // Initialize aircraft interpolation (singleton pattern - shared with CesiumViewer)
  // Both main app and insets run this - observations are shared via SharedWorker
  useAircraftInterpolation()

  // Receive observations from host via WebSocket (remote mode only)
  // In remote mode, the host relays observations from data sources, so we don't poll directly
  useRemoteObservations()

  // Auto-request vNAS subscription when viewing an airport in remote mode
  useRemoteVnasSubscription()

  // Listen for airport sync changes in remote mode (RealTraffic requires all clients at same airport)
  useAirportSyncListener()

  // Auto-request vNAS subscription when viewing an airport in host mode
  useVnasSubscription()

  // Initialize SettingsSharedWorkerService for inset iframes
  // Broadcasts settings, weather, airport, token, and aircraft observations via SharedWorker
  useEffect(() => {
    settingsSharedWorkerService.initialize()
  }, [])

  const handleViewerReady = useCallback((viewer: Viewer | null) => {
    setCesiumViewer(viewer)
  }, [])

  useEffect(() => {
    async function initialize() {
      try {
        // Step 0: Initialize global settings first (loads from host file system)
        // This also migrates cesiumIonToken and FSLTL settings from localStorage
        updateProgress(0, 0, 'Loading settings...')
        await initializeGlobalSettings()
        updateProgress(0, 100, 'Settings loaded')

        // Step 1: Migrate settings from Electron version (one-time, on first launch)
        updateProgress(1, 0, 'Checking for previous installation...')
        if (!isMigrationComplete()) {
          const migrationResult = await migrateFromElectron()
          if (migrationResult.settingsFound) {
            console.log('Migrated settings from Electron version')
          }
        }
        updateProgress(1, 100, 'Migration check complete')

        // Set Cesium Ion access token (from global settings)
        const token = useGlobalSettingsStore.getState().cesiumIonToken
        if (token) {
          Ion.defaultAccessToken = token
        }

        // Step 2: Load mods (tower positions, custom aircraft, etc.)
        updateProgress(2, 0, 'Loading mods...')
        await modService.loadMods()
        updateProgress(2, 100, 'Mods loaded')

        // Step 3: Load airport database
        updateProgress(3, 0, 'Loading airport database...')
        const airports = await airportService.loadAirports()
        updateProgress(3, 80, 'Processing airports...')
        loadAirports(Object.fromEntries(airports))
        updateProgress(3, 100, 'Airports loaded')

        // Load runway database (non-blocking, used for smart sort)
        useRunwayStore.getState().loadRunways()

        // Load aircraft dimensions data (non-blocking)
        aircraftDimensionsService.load()

        // Step 4: Initialize MSFS model conversion service (detects FSLTL/AIG from Community folder)
        updateProgress(4, 0, 'Detecting MSFS installations...')
        // Pass a progress callback that updates step progress
        await MSFSModelConversionService.initialize((status, progress) => {
          updateProgress(4, progress ?? 50, status)
        })
        updateProgress(4, 100, 'MSFS detection complete')

        // Step 5: Load user VMR files (from Settings > MSFS Aircraft Models)
        updateProgress(5, 0, 'Loading VMR rules...')
        await userVMRService.loadVMRFiles((status, progress) => {
          updateProgress(5, progress, status)
        })
        updateProgress(5, 100, 'VMR rules loaded')

        // Step 6: Start data source polling based on settings
        // In remote mode, the host relays observations via WebSocket, so we don't poll directly
        if (isRemoteMode()) {
          updateProgress(6, 0, 'Connecting to host...')
          // Start the timeline store prune timer (still needed for local timeline management)
          useAircraftTimelineStore.getState().startPruneTimer()
          updateProgress(6, 100, 'Receiving from host')
        } else {
          const dataSource = useGlobalSettingsStore.getState().realtraffic.dataSource
          if (dataSource === 'realtraffic') {
            const licenseKey = useGlobalSettingsStore.getState().realtraffic.licenseKey
            if (licenseKey) {
              updateProgress(6, 0, 'Connecting to RealTraffic...')
              const rtStore = useRealTrafficStore.getState()
              await rtStore.authenticate(licenseKey)
              // If authentication succeeded and we're connected, start polling
              if (useRealTrafficStore.getState().status === 'connected') {
                rtStore.startPolling()
                // Start the timeline store prune timer for RealTraffic
                useAircraftTimelineStore.getState().startPruneTimer()
              }
              updateProgress(6, 100, 'Connected to RealTraffic')
            } else {
              updateProgress(6, 100, 'RealTraffic license required')
              // No license key - user will need to enter one in settings
            }
          } else {
            // VATSIM data source
            updateProgress(6, 0, 'Connecting to VATSIM...')
            startPolling()
            // Start the timeline store prune timer for VATSIM
            useAircraftTimelineStore.getState().startPruneTimer()
            updateProgress(6, 100, 'Connected to VATSIM')
          }
        }

        // Step 7: Finalize
        updateProgress(7, 0, 'Finalizing...')
        checkVRSupport()
        updateProgress(7, 100, 'Ready')

        setIsLoading(false)

        // Show token prompt if no Cesium Ion token is set (check global settings)
        const globalToken = useGlobalSettingsStore.getState().cesiumIonToken
        if (!globalToken) {
          setShowTokenPrompt(true)
        }
      } catch (error) {
        console.error('Initialization error:', error)
        // Keep current step, just update status to show error
        setLoadingProgress((prev) => ({
          ...prev,
          stepProgress: 0,
          status: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }))
      }
    }

    initialize()

    return () => {
      if (import.meta.env.DEV) {
        stopFileLogging().catch(() => {
          // Ignore errors during cleanup
        })
      }
    }
  }, [startPolling, loadAirports, checkVRSupport, updateProgress])

  // Auto-select airport from URL params in remote browser mode (e.g., /?airport=KJFK&bookmark=3)
  const selectAirport = useAirportStore((state) => state.selectAirport)
  const airports = useAirportStore((state) => state.airports)

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-time init after airports load — re-running this would clobber any user-driven camera state with the URL-param defaults
  useEffect(() => {
    if (isLoading) return

    const { airport, bookmark } = getUrlAirportParams()
    if (!airport) return

    // Validate the airport exists in the database
    if (!airports.has(airport)) return

    selectAirport(airport)

    // Apply view after a frame delay so the airport camera is set up first
    requestAnimationFrame(() => {
      // Each URL (airport+bookmark combo) has its own saved camera in localStorage.
      // Restore it so reopening the same tab/bookmark picks up where the user left off.
      const savedCamera = loadUrlCameraState(airport, bookmark)
      if (savedCamera) {
        const store = useViewportStore.getState()
        useViewportStore.setState({
          viewports: store.viewports.map((v) =>
            v.id === store.activeViewportId
              ? {
                  ...v,
                  cameraState: {
                    ...v.cameraState,
                    viewMode: savedCamera.viewMode === 'topdown' ? 'topdown' : '3d',
                    heading: savedCamera.heading,
                    pitch: savedCamera.pitch,
                    fov: savedCamera.fov,
                    positionOffsetX: savedCamera.positionOffsetX,
                    positionOffsetY: savedCamera.positionOffsetY,
                    positionOffsetZ: savedCamera.positionOffsetZ,
                    topdownAltitude: savedCamera.topdownAltitude,
                    followingCallsign: null,
                    preFollowState: null,
                  },
                }
              : v,
          ),
        })
      } else if (bookmark !== null) {
        useViewportStore.getState().loadBookmark(bookmark)
      } else {
        // Apply user's saved default view for this airport (synced from host via global settings).
        // Without this, remote browsers that have no local camera history would show a bare default.
        useViewportStore.getState().resetToDefault()
      }
    })

    // Persist camera state changes for this URL (debounced, 2s hysteresis)
    const unsubscribe = useViewportStore.subscribe(
      (state) => {
        const active = state.viewports.find((v) => v.id === state.activeViewportId)
        if (!active) return null
        const cam = active.cameraState
        return {
          viewMode: cam.viewMode,
          heading: cam.heading,
          pitch: cam.pitch,
          fov: cam.fov,
          positionOffsetX: cam.positionOffsetX,
          positionOffsetY: cam.positionOffsetY,
          positionOffsetZ: cam.positionOffsetZ,
          topdownAltitude: cam.topdownAltitude,
        } as UrlCameraState
      },
      (cameraState) => {
        if (cameraState) scheduleSaveUrlCameraState(cameraState)
      },
      { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    )

    return () => {
      unsubscribe()
      flushUrlCameraSave()
    }
  }, [isLoading])

  // Deep link handler for OAuth callbacks (tc3d://oauth/callback)
  useEffect(() => {
    // Only handle deep links in desktop mode (not remote browser)
    if (isRemoteMode()) return

    // Flag to prevent stale async operations (Strict Mode double-mount)
    let isActive = true
    let cleanup: (() => void) | undefined

    async function setupDeepLinkHandler() {
      try {
        const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link')

        // Abort if effect was cleaned up while async import was pending
        if (!isActive) return

        cleanup = await onOpenUrl((urls) => {
          console.log('[App] Deep link received:', urls)

          for (const url of urls) {
            // Handle OAuth callback
            if (url.startsWith('tc3d://oauth/callback')) {
              console.log('[App] OAuth callback received, processing...')
              useVnasStore
                .getState()
                .handleOAuthCallback(url)
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
      isActive = false
      if (cleanup) cleanup()
    }
  }, [showFeedback])

  // Cleanup and save state when app is closing
  useEffect(() => {
    const handleBeforeUnload = () => {
      // Flush any pending viewport settings sync before closing
      // This ensures camera positions, insets, etc. are saved even if the
      // debounced sync timer (2s) hasn't fired yet
      flushPendingGlobalSync()
      flushUrlCameraSave()

      // Fire-and-forget deauth - we don't await since the window is closing
      realTrafficService.deauthenticate().catch(() => {
        // Ignore errors during shutdown
      })
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // Also flush and deauth when the component unmounts (e.g., hot reload in dev)
      flushPendingGlobalSync()
      flushUrlCameraSave()
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
  }, [
    currentIcao,
    showWeatherEffects,
    orbitWithoutAirport,
    fetchWeather,
    startAutoRefresh,
    startNearestAutoRefresh,
    stopAutoRefresh,
    clearWeather,
  ])

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
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
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
  }, [
    showMetarOverlay,
    updateUISettings,
    currentAirportIcao,
    loadBookmark,
    showFeedback,
    togglePerformanceHUD,
    toggleModelMatchingModal,
    toggleTimelineDebugModal,
  ])

  if (isLoading) {
    return <LoadingScreen progress={loadingProgress} steps={loadingSteps} />
  }

  return (
    <div className="app">
      {/* VR Scene - renders when VR is active */}
      <VRScene cesiumViewer={cesiumViewer} />

      {/* Hide normal UI when VR is active */}
      {!isVRActive && <TopBar onCommandClick={() => setShowTouchCommand(true)} />}
      {!isVRActive && <UpdateNotification />}
      {!isVRActive && <MetarOverlay />}
      {!isVRActive && <MagnificationIndicator />}
      {!isVRActive && <DataLoadingOverlay />}
      {!isVRActive && <TowerPositioningOverlay />}
      <div className="main-content">
        <ViewportManager mainViewportContent={<CesiumViewer onViewerReady={handleViewerReady} />}>
          {!isVRActive && <CommandInput />}
          {!isVRActive && (currentAirport || followingCallsign) && <AircraftPanel />}
        </ViewportManager>
      </div>
      {!isVRActive && <ControlsBar />}
      {!isVRActive && <TouchControls />}
      {/* Touch command input modal - shown on mobile when Cmd button clicked */}
      {!isVRActive && <TouchCommandInput isOpen={showTouchCommand} onClose={() => setShowTouchCommand(false)} />}
      {!isVRActive && import.meta.env.DEV && <WeatherDebugPanel />}
      {!isVRActive && import.meta.env.DEV && <VnasPanel />}
      {!isVRActive && <AirportSelector />}
      {!isVRActive && <MeasuringTool cesiumViewer={cesiumViewer} />}
      <PerformanceHUD visible={showPerformanceHUD} />
      {!isVRActive && showModelMatchingModal && <ModelMatchingModal onClose={() => setShowModelMatchingModal(false)} />}
      {!isVRActive && showTimelineDebugModal && (
        <AircraftTimelineModal onClose={() => setShowTimelineDebugModal(false)} />
      )}
      <MSFSIndexingModal />

      {/* Cesium Ion Token Prompt */}
      {showTokenPrompt && (
        <div className="token-prompt-overlay">
          <div className="token-prompt-modal">
            <h2>Cesium Ion Access Token Required</h2>
            <p>
              TowerCab 3D uses Cesium Ion for terrain and satellite imagery. You need a free access token to continue.
            </p>
            <ol>
              <li>
                <button
                  type="button"
                  onClick={() => {
                    shellApi.openExternal('https://ion.cesium.com/signup/')
                  }}
                  className="external-link"
                >
                  Create a free Cesium Ion account
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => {
                    shellApi.openExternal('https://ion.cesium.com/tokens')
                  }}
                  className="external-link"
                >
                  Go to Access Tokens
                </button>{' '}
                and copy your default token
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
              <button type="button" className="token-button secondary" onClick={() => setShowTokenPrompt(false)}>
                Skip for now
              </button>
              <button
                type="button"
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
