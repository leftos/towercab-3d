import { useState, useRef, useCallback, useEffect } from 'react'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useMeasureStore } from '../../stores/measureStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAirportStore } from '../../stores/airportStore'
import { useReplayStore } from '../../stores/replayStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { useReplayPlayback } from '../../hooks/useReplayPlayback'
import { exportAllData, downloadExport } from '../../services/ExportImportService'
import { checkForUpdates } from '../../services/UpdateService'
import { useUpdateStore } from '../../stores/updateStore'
import { estimateReplayMemoryMB, PLAYBACK_SPEEDS } from '../../constants/replay'
import type { ReplayExportData, PlaybackSpeed } from '../../types/replay'
import GlobalSearchPanel from './GlobalSearchPanel'
import VRButton from '../VR/VRButton'
import ImportModal from './ImportModal'
import FSLTLImportPanel from './FSLTLImportPanel'
import BookmarkManagerModal from './BookmarkManagerModal'
import './ControlsBar.css'

type SettingsTab = 'general' | 'display' | 'graphics' | 'performance' | 'help'
type BarMode = 'controls' | 'replay'

// Replay time formatting helpers
function formatRelativeTime(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes === 0) return `${seconds}s ago`
  return `${minutes}m ${seconds}s ago`
}

function formatUTCTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toISOString().slice(11, 19) + ' UTC'
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds % 60)
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function ControlsBar() {
  const [showSettings, setShowSettings] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [showImportModal, setShowImportModal] = useState(false)
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [barMode, setBarMode] = useState<BarMode>('controls')

  // Local state for Cesium Ion token input (only saved on button click)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)

  // Initialize replay playback engine (needed for replay mode)
  useReplayPlayback()

  // Settings store - General
  const cesiumIonToken = useSettingsStore((state) => state.cesium.cesiumIonToken)
  const updateCesiumSettings = useSettingsStore((state) => state.updateCesiumSettings)
  const theme = useSettingsStore((state) => state.ui.theme)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)
  const defaultFov = useSettingsStore((state) => state.camera.defaultFov)
  const cameraSpeed = useSettingsStore((state) => state.camera.cameraSpeed)
  const mouseSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity)
  const enableAutoAirportSwitch = useSettingsStore((state) => state.camera.enableAutoAirportSwitch ?? false)
  const updateCameraSettings = useSettingsStore((state) => state.updateCameraSettings)

  // Settings store - Display (Aircraft group)
  const labelVisibilityDistance = useSettingsStore((state) => state.aircraft.labelVisibilityDistance)
  const maxAircraftDisplay = useSettingsStore((state) => state.aircraft.maxAircraftDisplay)
  const datablockMode = useSettingsStore((state) => state.aircraft.datablockMode)
  const showGroundTraffic = useSettingsStore((state) => state.aircraft.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.aircraft.showAirborneTraffic)
  const orientationEmulation = useSettingsStore((state) => state.aircraft.orientationEmulation)
  const orientationIntensity = useSettingsStore((state) => state.aircraft.orientationIntensity)
  const updateAircraftSettings = useSettingsStore((state) => state.updateAircraftSettings)
  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)

  // Settings store - Graphics (Cesium group)
  const terrainQuality = useSettingsStore((state) => state.cesium.terrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.cesium.show3DBuildings)
  const timeMode = useSettingsStore((state) => state.cesium.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.cesium.fixedTimeHour)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)

  // Settings store - Weather
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.weather.showBabylonFog)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const cloudOpacity = useSettingsStore((state) => state.weather.cloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.weather.fogIntensity)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)
  const showPrecipitation = useSettingsStore((state) => state.weather.showPrecipitation ?? true)
  const precipitationIntensity = useSettingsStore((state) => state.weather.precipitationIntensity ?? 1.0)
  const showLightning = useSettingsStore((state) => state.weather.showLightning ?? true)
  const enableWeatherInterpolation = useSettingsStore((state) => state.weather.enableWeatherInterpolation ?? true)
  const updateWeatherSettings = useSettingsStore((state) => state.updateWeatherSettings)

  // Weather store
  const currentMetar = useWeatherStore((state) => state.currentMetar)

  // Update store
  const updateStatus = useUpdateStore((state) => state.status)
  const interpolatedWeather = useWeatherStore((state) => state.interpolatedWeather)
  const isLoadingWeather = useWeatherStore((state) => state.isLoading)

  // Settings store - Performance (Memory group)
  const inMemoryTileCacheSize = useSettingsStore((state) => state.memory.inMemoryTileCacheSize)
  const diskCacheSizeGB = useSettingsStore((state) => state.memory.diskCacheSizeGB)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.memory.aircraftDataRadiusNM)
  const maxReplayDurationMinutes = useSettingsStore((state) => state.memory.maxReplayDurationMinutes)
  const updateMemorySettings = useSettingsStore((state) => state.updateMemorySettings)

  // Replay store - settings panel
  const replaySnapshots = useReplayStore((state) => state.snapshots)
  const importedSnapshots = useReplayStore((state) => state.importedSnapshots)
  const exportReplay = useReplayStore((state) => state.exportReplay)
  const importReplay = useReplayStore((state) => state.importReplay)
  const clearImportedReplay = useReplayStore((state) => state.clearImportedReplay)

  // Replay store - playback controls
  const playbackMode = useReplayStore((state) => state.playbackMode)
  const isPlaying = useReplayStore((state) => state.isPlaying)
  const playbackSpeed = useReplayStore((state) => state.playbackSpeed)
  const currentIndex = useReplayStore((state) => state.currentIndex)
  const segmentProgress = useReplayStore((state) => state.segmentProgress)
  const getTotalDuration = useReplayStore((state) => state.getTotalDuration)
  const play = useReplayStore((state) => state.play)
  const pause = useReplayStore((state) => state.pause)
  const goLive = useReplayStore((state) => state.goLive)
  const seekTo = useReplayStore((state) => state.seekTo)
  const stepBackward = useReplayStore((state) => state.stepBackward)
  const stepForward = useReplayStore((state) => state.stepForward)
  const setPlaybackSpeed = useReplayStore((state) => state.setPlaybackSpeed)

  // Derive active snapshots for replay
  const activeSnapshots = playbackMode === 'imported' && importedSnapshots
    ? importedSnapshots
    : replaySnapshots

  // Replay file input ref
  const replayFileInputRef = useRef<HTMLInputElement>(null)
  const scrubberRef = useRef<HTMLInputElement>(null)

  // Settings store - Experimental Graphics (Graphics group)
  const msaaSamples = useSettingsStore((state) => state.graphics.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.graphics.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.graphics.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.graphics.enableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.graphics.enableGroundAtmosphere)
  const enableAmbientOcclusion = useSettingsStore((state) => state.graphics.enableAmbientOcclusion)
  const enableShadows = useSettingsStore((state) => state.graphics.enableShadows)
  const shadowMapSize = useSettingsStore((state) => state.graphics.shadowMapSize)
  const shadowMaxDistance = useSettingsStore((state) => state.graphics.shadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.graphics.shadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.graphics.shadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.graphics.shadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.graphics.shadowNormalOffset)
  const aircraftShadowsOnly = useSettingsStore((state) => state.graphics.aircraftShadowsOnly)
  // New shadow bias settings - use defaults if not yet migrated in localStorage
  const shadowDepthBias = useSettingsStore((state) => state.graphics.shadowDepthBias) ?? 0.0004
  const shadowPolygonOffsetFactor = useSettingsStore((state) => state.graphics.shadowPolygonOffsetFactor) ?? 1.1
  const shadowPolygonOffsetUnits = useSettingsStore((state) => state.graphics.shadowPolygonOffsetUnits) ?? 4.0
  const cameraNearPlane = useSettingsStore((state) => state.graphics.cameraNearPlane) ?? 0.1
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  const fsltlModelBrightness = useSettingsStore((state) => state.graphics.fsltlModelBrightness) ?? 1.0
  const updateGraphicsSettings = useSettingsStore((state) => state.updateGraphicsSettings)

  // Active viewport camera state (from viewportStore)
  const {
    viewMode,
    toggleViewMode,
    heading,
    pitch,
    fov,
    topdownAltitude,
    followingCallsign,
    resetView,
    setFov
  } = useActiveViewportCamera()

  // Viewport store - for default saving (shared across viewports)
  const saveCurrentAsDefault = useViewportStore((state) => state.saveCurrentAsDefault)
  const resetToDefault = useViewportStore((state) => state.resetToDefault)
  const hasCustomDefault = useViewportStore((state) => state.hasCustomDefault)

  // Measure store
  const isMeasuring = useMeasureStore((state) => state.isActive)
  const toggleMeasuring = useMeasureStore((state) => state.toggleMeasuring)

  // Viewport store
  const insetCount = useViewportStore((state) => state.viewports.length - 1)
  const addViewport = useViewportStore((state) => state.addViewport)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  // Sync token input with store value when settings panel opens or store changes
  useEffect(() => {
    setTokenInput(cesiumIonToken)
    setTokenSaved(false)
  }, [cesiumIonToken, showSettings])

  // Close settings modal on Escape key
  useEffect(() => {
    if (!showSettings) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSettings(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showSettings])

  // Register modals with UI feedback store for keyboard blocking
  useEffect(() => {
    if (showSettings) {
      pushModal()
      return () => popModal()
    }
  }, [showSettings, pushModal, popModal])

  useEffect(() => {
    if (showBookmarkModal) {
      pushModal()
      return () => popModal()
    }
  }, [showBookmarkModal, pushModal, popModal])

  useEffect(() => {
    if (showImportModal) {
      pushModal()
      return () => popModal()
    }
  }, [showImportModal, pushModal, popModal])

  // Ctrl+B to open bookmark manager
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

      if (e.ctrlKey && e.key.toLowerCase() === 'b' && currentAirport) {
        e.preventDefault()
        setShowBookmarkModal(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentAirport])

  // Save token handler - only updates store when button is clicked
  const handleSaveToken = useCallback(() => {
    if (tokenInput.trim() && tokenInput !== cesiumIonToken) {
      updateCesiumSettings({ cesiumIonToken: tokenInput.trim() })
      setTokenSaved(true)
      setTimeout(() => setTokenSaved(false), 2000)
    }
  }, [tokenInput, cesiumIonToken, updateCesiumSettings])

  const handleResetView = () => {
    resetView()
  }

  const handleSaveAsDefault = () => {
    saveCurrentAsDefault()
  }

  const handleResetToDefault = () => {
    resetToDefault()
  }

  const formatAngle = (angle: number) => {
    return Math.round(((angle % 360) + 360) % 360).toString().padStart(3, '0') + '°'
  }

  const formatPitch = (angle: number) => {
    const sign = angle >= 0 ? '+' : ''
    return sign + Math.round(angle) + '°'
  }

  const formatTimeHour = (hour: number): string => {
    const h = Math.floor(hour)
    const m = Math.round((hour - h) * 60)
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  const handleExportSettings = () => {
    const data = exportAllData()
    downloadExport(data)
  }

  const handleImportFromElectron = async () => {
    // Use the migration service to re-attempt Electron migration
    const { migrateFromElectron } = await import('../../services/MigrationService')

    // Reset migration flag to allow re-migration
    localStorage.removeItem('electron-migration-complete')

    const result = await migrateFromElectron()

    if (result.settingsFound) {
      setImportStatus('success')
      setShowImportModal(false)
      setTimeout(() => setImportStatus('idle'), 3000)
    } else if (result.success) {
      throw new Error(
        'No Electron settings found. The old version may not have been installed, ' +
        'or its data has been removed.'
      )
    } else {
      throw new Error(result.message)
    }
  }

  const handleImportSuccess = () => {
    setImportStatus('success')
    setTimeout(() => setImportStatus('idle'), 3000)
  }

  const handleReplayFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const data = JSON.parse(text)

      // Validate basic structure before passing to importReplay
      if (!data || typeof data !== 'object') {
        console.error('[Replay Import] Invalid file: not a JSON object')
        alert('Invalid replay file: not a valid JSON object')
        return
      }

      const success = importReplay(data as ReplayExportData)
      if (!success) {
        alert('Invalid replay file format. Check console for details.')
      }
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'Invalid JSON format'
        : error instanceof Error ? error.message : 'Unknown error'
      console.error('[Replay Import] Failed to read file:', error)
      alert(`Failed to read replay file: ${message}`)
    }

    // Reset input so same file can be selected again
    e.target.value = ''
  }

  // ========================================================================
  // REPLAY CONTROLS
  // ========================================================================

  const isLive = playbackMode === 'live'
  const hasSnapshots = activeSnapshots.length >= 2
  const totalDuration = getTotalDuration()

  // Calculate current timestamp for display
  const currentSnapshot = activeSnapshots[currentIndex]
  const currentTimestamp = currentSnapshot?.timestamp || Date.now()
  const newestSnapshot = activeSnapshots[activeSnapshots.length - 1]
  const newestTimestamp = newestSnapshot?.timestamp || Date.now()
  const timeAgo = isLive ? 0 : (newestTimestamp - currentTimestamp) / 1000

  // Scrubber position
  const scrubberValue = currentIndex + segmentProgress
  const scrubberMax = Math.max(1, activeSnapshots.length - 1)

  const handleScrubberChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value)
    const index = Math.floor(value)
    seekTo(index)
  }, [seekTo])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleSpeedChange = useCallback((speed: PlaybackSpeed) => {
    setPlaybackSpeed(speed)
  }, [setPlaybackSpeed])

  // Keyboard shortcuts for replay (only when in replay mode)
  useEffect(() => {
    if (barMode !== 'replay') return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      switch (e.key) {
        case ' ':
          e.preventDefault()
          handlePlayPause()
          break
        case 'ArrowLeft':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            stepBackward()
          }
          break
        case 'ArrowRight':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            stepForward()
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [barMode, handlePlayPause, stepBackward, stepForward])

  return (
    <>
      <div className={`controls-bar ${barMode === 'replay' ? 'replay-mode' : ''} ${isLive ? '' : 'in-replay'}`}>
        {/* Mode toggle button - always visible on the left */}
        <button
          className={`mode-toggle-btn ${barMode === 'replay' ? 'active' : ''}`}
          onClick={() => setBarMode(barMode === 'controls' ? 'replay' : 'controls')}
          title={barMode === 'controls' ? 'Show replay controls' : 'Show main controls'}
        >
          {barMode === 'controls' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polygon points="10 8 16 12 10 16 10 8" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          )}
        </button>

        {barMode === 'controls' ? (
          <>
            {/* MAIN CONTROLS MODE */}
            <div className="controls-left">
              <button className="control-button" onClick={handleResetView} title="Reset View (Shift+R)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                Reset
              </button>

              <button className="control-button" onClick={toggleViewMode} title="Toggle View Mode (T)">
                {viewMode === '3d' ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="M2 17l10 5 10-5" />
                    <path d="M2 12l10 5 10-5" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="12" y1="3" x2="12" y2="21" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                  </svg>
                )}
                {viewMode === '3d' ? '3D' : '2D'}
              </button>

              <div className="button-divider" />

              <button
                className="control-button"
                onClick={handleSaveAsDefault}
                title={`Save current ${viewMode === '3d' ? '3D' : '2D'} view as default for this airport`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                Set Default
              </button>

              <button
                className={`control-button ${hasCustomDefault() ? 'has-default' : ''}`}
                onClick={handleResetToDefault}
                title={`Reset to default ${viewMode === '3d' ? '3D' : '2D'} view for this airport`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                To Default
              </button>

              <GlobalSearchPanel />

              <div className="camera-info">
                {viewMode === 'topdown' ? (
                  <span className="info-item" title="Altitude">
                    ALT {Math.round(topdownAltitude * 3.28084).toLocaleString()}ft
                  </span>
                ) : (
                  <>
                    <span className="info-item" title="Heading">
                      HDG {formatAngle(heading)}
                    </span>
                    <span className="info-item" title="Pitch">
                      PIT {formatPitch(pitch)}
                    </span>
                    <span className="info-item" title="Field of View">
                      FOV {Math.round(fov)}°
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="controls-center">
              {followingCallsign ? (
                <div className="follow-status">
                  <span className="follow-indicator">Following: {followingCallsign}</span>
                  <span className="follow-hint">Scroll to zoom • Esc to stop</span>
                </div>
              ) : (
                <div className="zoom-control">
                  <span className="zoom-label">FOV</span>
                  <input
                    type="range"
                    min="10"
                    max="120"
                    value={fov}
                    onChange={(e) => setFov(Number(e.target.value))}
                    className="zoom-slider"
                  />
                  <span className="zoom-value">{Math.round(fov)}°</span>
                </div>
              )}
            </div>

            <div className="controls-right">
              <button
                className={`control-button ${isMeasuring ? 'active' : ''}`}
                onClick={toggleMeasuring}
                title="Measure distance (M)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12h4m12 0h4" />
                  <path d="M6 8v8" />
                  <path d="M18 8v8" />
                  <path d="M8 12h8" />
                </svg>
                Measure
              </button>

              {currentAirport && (
                <button
                  className={`control-button ${showBookmarkModal ? 'active' : ''}`}
                  onClick={() => setShowBookmarkModal(!showBookmarkModal)}
                  title="Manage bookmarks (Ctrl+B)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                  Bookmarks
                </button>
              )}

              {currentAirport && (
                <button
                  className="control-button"
                  onClick={() => addViewport()}
                  title={insetCount >= 6 ? 'Adding more viewports may impact performance' : 'Add a new inset viewport'}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="12" y1="8" x2="12" y2="16" />
                    <line x1="8" y1="12" x2="16" y2="12" />
                  </svg>
                  Add Inset
                </button>
              )}

              <VRButton />

              <button
                className="control-button"
                onClick={() => setShowSettings(!showSettings)}
                title="Settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <>
            {/* REPLAY CONTROLS MODE */}
            <div className="replay-controls-left">
              <button
                className="timeline-btn step-btn"
                onClick={stepBackward}
                disabled={!hasSnapshots || (!isLive && currentIndex === 0)}
                title="Step backward (15s)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path fill="currentColor" d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                </svg>
              </button>

              <button
                className="timeline-btn play-btn"
                onClick={handlePlayPause}
                disabled={!hasSnapshots}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button
                className="timeline-btn step-btn"
                onClick={stepForward}
                disabled={!hasSnapshots || isLive || currentIndex >= activeSnapshots.length - 1}
                title="Step forward (15s)"
              >
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>
            </div>

            <div className="replay-controls-center">
              <div className="timeline-scrubber">
                <input
                  ref={scrubberRef}
                  type="range"
                  min="0"
                  max={scrubberMax}
                  step="0.01"
                  value={scrubberValue}
                  onChange={handleScrubberChange}
                  disabled={!hasSnapshots}
                  className="scrubber-input"
                />
                <div
                  className="scrubber-progress"
                  style={{ width: `${(scrubberValue / scrubberMax) * 100}%` }}
                />
              </div>

              <div className="timeline-time">
                {isLive ? (
                  <span className="time-live-indicator">LIVE</span>
                ) : (
                  <>
                    <span className="time-relative">{formatRelativeTime(timeAgo)}</span>
                    <span className="time-separator">-</span>
                    <span className="time-absolute">{formatUTCTime(currentTimestamp)}</span>
                  </>
                )}
                <span className="time-total">
                  Buffer: {formatDuration(totalDuration)}
                </span>
              </div>
            </div>

            <div className="replay-controls-right">
              <div className="speed-selector">
                {PLAYBACK_SPEEDS.map((speed) => (
                  <button
                    key={speed}
                    className={`speed-btn ${playbackSpeed === speed ? 'active' : ''}`}
                    onClick={() => handleSpeedChange(speed as PlaybackSpeed)}
                    disabled={isLive}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              <button
                className={`live-btn ${isLive ? 'active' : ''}`}
                onClick={goLive}
                title="Return to live"
              >
                LIVE
              </button>

              <button
                className="control-button"
                onClick={() => setShowSettings(!showSettings)}
                title="Settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>

      {showSettings && (
        <div className={`settings-modal-overlay ${activeTab === 'graphics' ? 'no-blur' : ''}`}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="close-button" onClick={() => setShowSettings(false)}>
                &times;
              </button>
            </div>

            <div className="settings-tabs">
              <button
                className={`tab-button ${activeTab === 'general' ? 'active' : ''}`}
                onClick={() => setActiveTab('general')}
              >
                General
              </button>
              <button
                className={`tab-button ${activeTab === 'display' ? 'active' : ''}`}
                onClick={() => setActiveTab('display')}
              >
                Display
              </button>
              <button
                className={`tab-button ${activeTab === 'graphics' ? 'active' : ''}`}
                onClick={() => setActiveTab('graphics')}
              >
                Graphics
              </button>
              <button
                className={`tab-button ${activeTab === 'performance' ? 'active' : ''}`}
                onClick={() => setActiveTab('performance')}
              >
                Performance
              </button>
              <button
                className={`tab-button ${activeTab === 'help' ? 'active' : ''}`}
                onClick={() => setActiveTab('help')}
              >
                Help
              </button>
            </div>

            <div className="settings-content">
              {/* General Tab */}
              {activeTab === 'general' && (
                <>
                  <div className="settings-section">
                    <h3>Cesium Ion</h3>
                    <div className="setting-item">
                      <label>API Token</label>
                      <div className="token-input-row">
                        <input
                          type="text"
                          value={tokenInput}
                          onChange={(e) => setTokenInput(e.target.value)}
                          placeholder="Enter your Cesium Ion access token"
                          className="text-input token-input"
                        />
                        <button
                          className={`token-save-button ${tokenSaved ? 'saved' : ''}`}
                          onClick={handleSaveToken}
                          disabled={!tokenInput.trim() || tokenInput === cesiumIonToken}
                        >
                          {tokenSaved ? 'Saved!' : 'Save'}
                        </button>
                      </div>
                      <p className="setting-hint">
                        Get a free token at{' '}
                        <a
                          href="#"
                          onClick={(e) => { e.preventDefault(); openExternal('https://ion.cesium.com/tokens') }}
                          className="external-link"
                        >
                          ion.cesium.com
                        </a>
                        . Changes require saving to take effect.
                      </p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Appearance</h3>
                    <div className="setting-item">
                      <label>Theme</label>
                      <div className="radio-group">
                        <label>
                          <input
                            type="radio"
                            name="theme"
                            value="dark"
                            checked={theme === 'dark'}
                            onChange={() => updateUISettings({ theme: 'dark' })}
                          />
                          Dark
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="theme"
                            value="light"
                            checked={theme === 'light'}
                            onChange={() => updateUISettings({ theme: 'light' })}
                          />
                          Light
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Camera</h3>
                    <div className="setting-item">
                      <label>Default FOV</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="10"
                          max="120"
                          value={defaultFov}
                          onChange={(e) => updateCameraSettings({ defaultFov: Number(e.target.value) })}
                        />
                        <span>{defaultFov}°</span>
                      </div>
                      <p className="setting-hint">Field of view used when resetting camera.</p>
                    </div>

                    <div className="setting-item">
                      <label>Camera Speed</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="1"
                          max="10"
                          value={cameraSpeed}
                          onChange={(e) => updateCameraSettings({ cameraSpeed: Number(e.target.value) })}
                        />
                        <span>{cameraSpeed}</span>
                      </div>
                      <p className="setting-hint">WASD movement speed multiplier.</p>
                    </div>

                    <div className="setting-item">
                      <label>Mouse Sensitivity</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="0.1"
                          max="2"
                          step="0.1"
                          value={mouseSensitivity}
                          onChange={(e) => updateCameraSettings({ mouseSensitivity: Number(e.target.value) })}
                        />
                        <span>{mouseSensitivity.toFixed(1)}</span>
                      </div>
                      <p className="setting-hint">Right-click drag sensitivity for camera rotation.</p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableAutoAirportSwitch}
                          onChange={(e) => updateCameraSettings({ enableAutoAirportSwitch: e.target.checked })}
                        />
                        Auto-Switch to Nearest Airport
                      </label>
                      <p className="setting-hint">
                        Automatically switch to the nearest airport as you move the camera.
                      </p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <FSLTLImportPanel />
                  </div>

                  <div className="settings-section">
                    <h3>Import / Export Settings</h3>
                    <p className="setting-hint" style={{ marginBottom: '12px' }}>
                      Migrating from the Electron version? Use Import to transfer your settings.
                    </p>
                    <div className="setting-item">
                      <div className="import-export-buttons">
                        <button className="control-button" onClick={handleExportSettings}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          Export Settings
                        </button>
                        <button
                          className="control-button"
                          onClick={() => setShowImportModal(true)}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          Import Settings
                        </button>
                      </div>
                      {importStatus === 'success' && (
                        <p className="setting-hint" style={{ color: '#4caf50', marginTop: '8px' }}>
                          Settings imported successfully!
                        </p>
                      )}
                    </div>
                  </div>
                </>
              )}

              {/* Display Tab */}
              {activeTab === 'display' && (
                <>
                  <div className="settings-section">
                    <h3>Aircraft Display</h3>
                    <div className="setting-item">
                      <label>Max Nearby Aircraft Range</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="5"
                          max="100"
                          value={labelVisibilityDistance}
                          onChange={(e) => updateAircraftSettings({ labelVisibilityDistance: Number(e.target.value) })}
                        />
                        <span>{labelVisibilityDistance} nm</span>
                      </div>
                    </div>

                    <div className="setting-item">
                      <label>Datablock Mode</label>
                      <div className="radio-group-vertical">
                        <label>
                          <input
                            type="radio"
                            name="datablockMode"
                            value="full"
                            checked={datablockMode === 'full'}
                            onChange={() => updateAircraftSettings({ datablockMode: 'full' })}
                          />
                          Full (callsign + type + altitude + speed)
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="datablockMode"
                            value="airline"
                            checked={datablockMode === 'airline'}
                            onChange={() => updateAircraftSettings({ datablockMode: 'airline' })}
                          />
                          Airline Codes Only (ICAO code for airline flights)
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="datablockMode"
                            value="none"
                            checked={datablockMode === 'none'}
                            onChange={() => updateAircraftSettings({ datablockMode: 'none' })}
                          />
                          None (hide labels, show cones only)
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Aircraft</h3>
                    <div className="setting-item">
                      <label>Max Aircraft Display</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="10"
                          max="1000"
                          step="10"
                          value={maxAircraftDisplay}
                          onChange={(e) => updateAircraftSettings({ maxAircraftDisplay: Number(e.target.value) })}
                        />
                        <span>{maxAircraftDisplay}</span>
                      </div>
                      <p className="setting-hint">Maximum number of aircraft to render.</p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showGroundTraffic}
                          onChange={(e) => updateAircraftSettings({ showGroundTraffic: e.target.checked })}
                        />
                        Show Ground Traffic
                      </label>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showAirborneTraffic}
                          onChange={(e) => updateAircraftSettings({ showAirborneTraffic: e.target.checked })}
                        />
                        Show Airborne Traffic
                      </label>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={orientationEmulation}
                          onChange={(e) => updateAircraftSettings({ orientationEmulation: e.target.checked })}
                        />
                        Emulate Aircraft Pitch/Roll
                      </label>
                      <p className="setting-hint">
                        Tilts aircraft based on climb/descent and turn rates.
                      </p>
                    </div>

                    {orientationEmulation && (
                      <div className="setting-item">
                        <label>Orientation Intensity</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.25"
                            max="1.5"
                            step="0.05"
                            value={orientationIntensity}
                            onChange={(e) => updateAircraftSettings({ orientationIntensity: Number(e.target.value) })}
                          />
                          <span>{Math.round(orientationIntensity * 100)}%</span>
                        </div>
                        <p className="setting-hint">
                          100% = realistic. Lower for subtle, higher for exaggerated motion.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="settings-section">
                    <h3>UI</h3>
                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showAircraftPanel}
                          onChange={(e) => updateUISettings({ showAircraftPanel: e.target.checked })}
                        />
                        Show Aircraft Panel
                      </label>
                    </div>
                  </div>
                </>
              )}

              {/* Graphics Tab */}
              {activeTab === 'graphics' && (
                <>
                  <div className="settings-section">
                    <h3>Terrain</h3>
                    <div className="setting-item">
                      <label>Terrain Quality</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="1"
                          max="5"
                          step="1"
                          value={terrainQuality}
                          onChange={(e) => updateCesiumSettings({ terrainQuality: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
                        />
                        <span>{['Low', 'Medium', 'High', 'Very High', 'Ultra'][terrainQuality - 1]}</span>
                      </div>
                      <p className="setting-hint">
                        Lower quality loads faster. Higher quality shows more detail at distance.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={show3DBuildings}
                          onChange={(e) => updateCesiumSettings({ show3DBuildings: e.target.checked })}
                        />
                        Show 3D Buildings (OSM)
                      </label>
                      <p className="setting-hint">
                        Display OpenStreetMap 3D buildings. May impact performance.
                      </p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Lighting</h3>
                    <div className="setting-item">
                      <label>Time of Day</label>
                      <div className="radio-group">
                        <label>
                          <input
                            type="radio"
                            name="timeMode"
                            value="real"
                            checked={timeMode === 'real'}
                            onChange={() => updateCesiumSettings({ timeMode: 'real' })}
                          />
                          Real Time
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="timeMode"
                            value="fixed"
                            checked={timeMode === 'fixed'}
                            onChange={() => updateCesiumSettings({ timeMode: 'fixed' })}
                          />
                          Fixed Time
                        </label>
                      </div>
                    </div>

                    {timeMode === 'fixed' && (
                      <div className="setting-item">
                        <label>Local Time</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0"
                            max="24"
                            step="0.5"
                            value={fixedTimeHour}
                            onChange={(e) => updateCesiumSettings({ fixedTimeHour: Number(e.target.value) })}
                          />
                          <span>{formatTimeHour(fixedTimeHour)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="settings-section">
                    <h3>Weather (METAR)</h3>
                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showWeatherEffects}
                          onChange={(e) => updateWeatherSettings({ showWeatherEffects: e.target.checked })}
                        />
                        Enable Weather Effects
                      </label>
                      <p className="setting-hint">
                        Fetches real weather data for the current airport.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableWeatherInterpolation}
                          onChange={(e) => updateWeatherSettings({ enableWeatherInterpolation: e.target.checked })}
                          disabled={!showWeatherEffects}
                        />
                        Interpolate Weather from Nearby Stations
                      </label>
                      <p className="setting-hint">
                        Blend weather from the 3 nearest METAR stations based on camera position.
                      </p>
                      {showWeatherEffects && enableWeatherInterpolation && interpolatedWeather &&
                        interpolatedWeather.sourceStations.length > 1 && (
                        <p className="setting-hint" style={{ marginTop: '4px', opacity: 0.8 }}>
                          Sources: {interpolatedWeather.sourceStations.map(s =>
                            `${s.icao} (${Math.round(s.weight * 100)}%)`
                          ).join(', ')}
                        </p>
                      )}
                    </div>

                    {showWeatherEffects && (
                      <>
                        <div className="setting-item">
                          <label>
                            <input
                              type="checkbox"
                              checked={showCesiumFog}
                              onChange={(e) => updateWeatherSettings({ showCesiumFog: e.target.checked })}
                            />
                            Cesium Fog (Distance Fade)
                          </label>
                          <p className="setting-hint">
                            Reduces terrain/imagery draw distance based on visibility.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label>
                            <input
                              type="checkbox"
                              checked={showBabylonFog}
                              onChange={(e) => updateWeatherSettings({ showBabylonFog: e.target.checked })}
                            />
                            Babylon Fog (Visual Atmosphere)
                          </label>
                          <p className="setting-hint">
                            Adds visible fog effect to aircraft and overlays.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label>
                            <input
                              type="checkbox"
                              checked={showClouds}
                              onChange={(e) => updateWeatherSettings({ showClouds: e.target.checked })}
                            />
                            Show Cloud Layers
                          </label>
                        </div>

                        <div className="setting-item">
                          <label>Cloud Opacity</label>
                          <div className="slider-with-value">
                            <input
                              type="range"
                              min="0.3"
                              max="0.8"
                              step="0.1"
                              value={cloudOpacity}
                              onChange={(e) => updateWeatherSettings({ cloudOpacity: Number(e.target.value) })}
                            />
                            <span>{Math.round(cloudOpacity * 100)}%</span>
                          </div>
                        </div>

                        <div className="setting-item">
                          <label>Fog Intensity</label>
                          <div className="slider-with-value">
                            <input
                              type="range"
                              min="0.5"
                              max="2.0"
                              step="0.1"
                              value={fogIntensity}
                              onChange={(e) => updateWeatherSettings({ fogIntensity: Number(e.target.value) })}
                              disabled={!showBabylonFog}
                            />
                            <span>{fogIntensity.toFixed(1)}x</span>
                          </div>
                          <p className="setting-hint">
                            How opaque the fog dome appears. Lower = clearer.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label>Visibility Scale</label>
                          <div className="slider-with-value">
                            <input
                              type="range"
                              min="0.5"
                              max="2.0"
                              step="0.1"
                              value={visibilityScale}
                              onChange={(e) => updateWeatherSettings({ visibilityScale: Number(e.target.value) })}
                              disabled={!showBabylonFog}
                            />
                            <span>{visibilityScale.toFixed(1)}x</span>
                          </div>
                          <p className="setting-hint">
                            Multiplier for fog distance. 2.0 = see twice as far as METAR visibility.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={showPrecipitation}
                              onChange={(e) => updateWeatherSettings({ showPrecipitation: e.target.checked })}
                            />
                            Show Precipitation (Rain/Snow)
                          </label>
                        </div>

                        <div className="setting-item">
                          <label>Precipitation Intensity</label>
                          <div className="slider-with-value">
                            <input
                              type="range"
                              min="0.5"
                              max="2.0"
                              step="0.1"
                              value={precipitationIntensity}
                              onChange={(e) => updateWeatherSettings({ precipitationIntensity: Number(e.target.value) })}
                              disabled={!showPrecipitation}
                            />
                            <span>{precipitationIntensity.toFixed(1)}x</span>
                          </div>
                          <p className="setting-hint">
                            Particle density for rain and snow effects.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={showLightning}
                              onChange={(e) => updateWeatherSettings({ showLightning: e.target.checked })}
                              disabled={!showPrecipitation}
                            />
                            Show Lightning (Thunderstorms)
                          </label>
                        </div>

                        <div className="setting-item weather-status">
                          {isLoadingWeather ? (
                            <span className="loading">Loading weather...</span>
                          ) : currentMetar ? (
                            <span>
                              <strong>{currentMetar.fltCat}</strong> - Vis {currentMetar.visib}SM
                              {currentMetar.clouds.length > 0 && (
                                <> | {currentMetar.clouds.map(c => `${c.cover}${Math.round(c.base / 100).toString().padStart(3, '0')}`).join(' ')}</>
                              )}
                            </span>
                          ) : (
                            <span className="no-data">No weather data available</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="settings-section">
                    <h3>Advanced Graphics (Experimental)</h3>
                    <p className="setting-hint" style={{ marginBottom: '12px' }}>
                      Adjust these settings to troubleshoot terrain texture banding or visual artifacts.
                    </p>

                    <div className="setting-item">
                      <label>MSAA Samples</label>
                      <select
                        value={msaaSamples}
                        onChange={(e) => updateGraphicsSettings({ msaaSamples: Number(e.target.value) as 1 | 2 | 4 | 8 })}
                        className="select-input"
                      >
                        <option value={1}>1 (Off)</option>
                        <option value={2}>2x</option>
                        <option value={4}>4x (Default)</option>
                        <option value={8}>8x</option>
                      </select>
                      <p className="setting-hint">
                        Multisample anti-aliasing. Changing this will briefly reload the 3D view.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableFxaa}
                          onChange={(e) => updateGraphicsSettings({ enableFxaa: e.target.checked })}
                        />
                        FXAA (Fast Approximate Anti-Aliasing)
                      </label>
                      <p className="setting-hint">
                        Post-process anti-aliasing. Works with MSAA for smoother edges.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableHdr}
                          onChange={(e) => updateGraphicsSettings({ enableHdr: e.target.checked })}
                        />
                        HDR (High Dynamic Range)
                      </label>
                      <p className="setting-hint">
                        Enables high dynamic range rendering. May cause color banding on some GPUs.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableLogDepth}
                          onChange={(e) => updateGraphicsSettings({ enableLogDepth: e.target.checked })}
                        />
                        Logarithmic Depth Buffer
                      </label>
                      <p className="setting-hint">
                        Improves depth precision at large distances. Reduces z-fighting artifacts.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableGroundAtmosphere}
                          onChange={(e) => updateGraphicsSettings({ enableGroundAtmosphere: e.target.checked })}
                        />
                        Ground Atmosphere
                      </label>
                      <p className="setting-hint">
                        Adds atmospheric haze effect to distant terrain.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableAmbientOcclusion}
                          onChange={(e) => updateGraphicsSettings({ enableAmbientOcclusion: e.target.checked })}
                        />
                        Ambient Occlusion (HBAO)
                      </label>
                      <p className="setting-hint">
                        Darkens creases and corners for depth. ⚠️ Can cause visible banding artifacts - disable if you see dark bands.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableLighting}
                          onChange={(e) => updateCesiumSettings({ enableLighting: e.target.checked })}
                        />
                        Globe Lighting
                      </label>
                      <p className="setting-hint">
                        Enables sun-based lighting on terrain. Affects day/night cycle.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={enableShadows}
                          onChange={(e) => updateGraphicsSettings({ enableShadows: e.target.checked })}
                        />
                        Shadows
                      </label>
                      <p className="setting-hint">
                        Enables shadow casting for terrain and 3D models. Performance impact.
                      </p>
                    </div>

                    <div className={`shadow-settings-group ${!enableShadows ? 'disabled' : ''}`}>
                      <div className="setting-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={aircraftShadowsOnly}
                            onChange={(e) => updateGraphicsSettings({ aircraftShadowsOnly: e.target.checked })}
                          />
                          Aircraft Shadows Only
                        </label>
                        <p className="setting-hint">
                          Only aircraft cast shadows. Disables terrain self-shadowing for better performance.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Shadow Map Size</label>
                        <select
                          value={shadowMapSize}
                          onChange={(e) => updateGraphicsSettings({ shadowMapSize: Number(e.target.value) as 1024 | 2048 | 4096 | 8192 })}
                          className="select-input"
                        >
                          <option value={1024}>1024 (Low)</option>
                          <option value={2048}>2048 (Medium)</option>
                          <option value={4096}>4096 (High)</option>
                          <option value={8192}>8192 (Ultra)</option>
                        </select>
                        <p className="setting-hint">
                          Shadow texture resolution. Higher = sharper shadows, more VRAM. 8192 uses ~256MB VRAM.
                        </p>
                      </div>


                      <div className="setting-item">
                        <label>Shadow Max Distance</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="100"
                            max="20000"
                            step="100"
                            value={shadowMaxDistance}
                            onChange={(e) => updateGraphicsSettings({ shadowMaxDistance: Number(e.target.value) })}
                          />
                          <span>{shadowMaxDistance}m</span>
                        </div>
                        <p className="setting-hint">
                          Maximum distance for rendering shadows. Higher values reduce banding but may impact performance. Default: 10000m (10km).
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Shadow Darkness</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={shadowDarkness}
                            onChange={(e) => updateGraphicsSettings({ shadowDarkness: Number(e.target.value) })}
                          />
                          <span>{(shadowDarkness * 100).toFixed(0)}%</span>
                        </div>
                        <p className="setting-hint">
                          Shadow brightness. 0% = black shadows, 100% = invisible shadows.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Built-in Model Brightness</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.5"
                            max="3.0"
                            step="0.1"
                            value={builtinModelBrightness}
                            onChange={(e) => updateGraphicsSettings({ builtinModelBrightness: Number(e.target.value) })}
                          />
                          <span>{(builtinModelBrightness * 100).toFixed(0)}%</span>
                        </div>
                        <p className="setting-hint">
                          Brightness for built-in (FR24) models. Default: 170%.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>FSLTL Model Brightness</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.5"
                            max="3.0"
                            step="0.1"
                            value={fsltlModelBrightness}
                            onChange={(e) => updateGraphicsSettings({ fsltlModelBrightness: Number(e.target.value) })}
                          />
                          <span>{(fsltlModelBrightness * 100).toFixed(0)}%</span>
                        </div>
                        <p className="setting-hint">
                          Brightness for imported FSLTL models. Default: 100% (preserves livery colors).
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={shadowSoftness}
                            onChange={(e) => updateGraphicsSettings({ shadowSoftness: e.target.checked })}
                          />
                          Soft Shadows
                        </label>
                        <p className="setting-hint">
                          Blur shadow edges. Disable for sharper (but potentially aliased) shadows.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={shadowFadingEnabled}
                            onChange={(e) => updateGraphicsSettings({ shadowFadingEnabled: e.target.checked })}
                          />
                          Shadow Fading
                        </label>
                        <p className="setting-hint">
                          Fade shadows at the edge of shadow distance.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>
                          <input
                            type="checkbox"
                            checked={shadowNormalOffset}
                            onChange={(e) => updateGraphicsSettings({ shadowNormalOffset: e.target.checked })}
                          />
                          Normal Offset
                        </label>
                        <p className="setting-hint">
                          Reduces shadow acne artifacts. Try disabling if you see banding.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Shadow Depth Bias</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.00001"
                            max="0.01"
                            step="0.00001"
                            value={shadowDepthBias}
                            onChange={(e) => updateGraphicsSettings({ shadowDepthBias: Number(e.target.value) })}
                          />
                          <span>{shadowDepthBias.toFixed(5)}</span>
                        </div>
                        <p className="setting-hint">
                          Reduces shadow banding. Increase if you see striped shadows.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Polygon Offset Factor</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.1"
                            max="5"
                            step="0.1"
                            value={shadowPolygonOffsetFactor}
                            onChange={(e) => updateGraphicsSettings({ shadowPolygonOffsetFactor: Number(e.target.value) })}
                          />
                          <span>{shadowPolygonOffsetFactor.toFixed(1)}</span>
                        </div>
                        <p className="setting-hint">
                          Shadow depth offset multiplier based on polygon slope.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Polygon Offset Units</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.1"
                            max="10"
                            step="0.1"
                            value={shadowPolygonOffsetUnits}
                            onChange={(e) => updateGraphicsSettings({ shadowPolygonOffsetUnits: Number(e.target.value) })}
                          />
                          <span>{shadowPolygonOffsetUnits.toFixed(1)}</span>
                        </div>
                        <p className="setting-hint">
                          Constant shadow depth offset.
                        </p>
                      </div>

                      <div className="setting-item">
                        <label>Camera Near Plane</label>
                        <div className="slider-with-value">
                          <input
                            type="range"
                            min="0.1"
                            max="10"
                            step="0.1"
                            value={cameraNearPlane}
                            onChange={(e) => updateGraphicsSettings({ cameraNearPlane: Number(e.target.value) })}
                          />
                          <span>{cameraNearPlane.toFixed(1)}m</span>
                        </div>
                        <p className="setting-hint">
                          Minimum render distance. Higher values improve shadow/depth precision but clip nearby objects.
                        </p>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Performance Tab */}
              {activeTab === 'performance' && (
                <>
                  <div className="settings-section">
                    <h3>Tile Cache</h3>
                    <div className="setting-item">
                      <label>In-Memory Tile Cache</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="50"
                          max="500"
                          step="50"
                          value={inMemoryTileCacheSize}
                          onChange={(e) => updateMemorySettings({ inMemoryTileCacheSize: Number(e.target.value) })}
                        />
                        <span>{inMemoryTileCacheSize} tiles</span>
                      </div>
                      <p className="setting-hint">
                        Higher values = smoother panning, more RAM usage.
                      </p>
                    </div>

                    <div className="setting-item">
                      <label>Disk Cache Size</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="0.1"
                          max="10"
                          step="0.1"
                          value={diskCacheSizeGB}
                          onChange={(e) => updateMemorySettings({ diskCacheSizeGB: Number(e.target.value) })}
                        />
                        <span>{diskCacheSizeGB.toFixed(1)} GB</span>
                      </div>
                      <p className="setting-hint">
                        IndexedDB cache for satellite/terrain tiles.
                      </p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Data</h3>
                    <div className="setting-item">
                      <label>Aircraft Data Radius</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="10"
                          max="500"
                          step="10"
                          value={aircraftDataRadiusNM}
                          onChange={(e) => updateMemorySettings({ aircraftDataRadiusNM: Number(e.target.value) })}
                        />
                        <span>{aircraftDataRadiusNM} nm</span>
                      </div>
                      <p className="setting-hint">
                        Only keep aircraft data within this radius of tower.
                      </p>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Replay</h3>
                    <div className="setting-item">
                      <label>Replay Buffer Duration</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="1"
                          max="60"
                          step="1"
                          value={maxReplayDurationMinutes}
                          onChange={(e) => updateMemorySettings({ maxReplayDurationMinutes: Number(e.target.value) })}
                        />
                        <span>{maxReplayDurationMinutes} min</span>
                      </div>
                      <p className="setting-hint">
                        How far back you can scrub. Uses ~{estimateReplayMemoryMB(maxReplayDurationMinutes).toFixed(1)} MB memory.
                        Currently recording {replaySnapshots.length} snapshots.
                      </p>
                    </div>

                    <div className="setting-item">
                      <div className="import-export-buttons">
                        <button
                          className="control-button"
                          onClick={exportReplay}
                          disabled={replaySnapshots.length === 0}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          Export Replay
                        </button>
                        <button
                          className="control-button"
                          onClick={() => replayFileInputRef.current?.click()}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          Import Replay
                        </button>
                        <input
                          ref={replayFileInputRef}
                          type="file"
                          accept=".json"
                          onChange={handleReplayFileChange}
                          style={{ display: 'none' }}
                        />
                      </div>
                    </div>

                    {importedSnapshots && (
                      <div className="setting-item">
                        <p className="setting-hint" style={{ color: '#ff9800' }}>
                          Viewing imported replay ({importedSnapshots.length} snapshots)
                        </p>
                        <button
                          className="control-button"
                          onClick={clearImportedReplay}
                          style={{ marginTop: '8px' }}
                        >
                          Clear Imported Replay
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Help Tab */}
              {activeTab === 'help' && (
                <>
                  <div className="settings-section">
                    <h3>Camera Controls</h3>
                    <div className="shortcuts-list">
                      <div className="shortcut">
                        <span className="keys">Right-click + Drag</span>
                        <span className="action">Look around</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">WASD</span>
                        <span className="action">Move position</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Arrow Keys</span>
                        <span className="action">Pan/Tilt camera</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Scroll Wheel</span>
                        <span className="action">Zoom (FOV/Altitude)</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">T</span>
                        <span className="action">Toggle 3D/2D view</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">r</span>
                        <span className="action">Reset position</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Shift+R / Home</span>
                        <span className="action">Reset to default view</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Aircraft Following</h3>
                    <div className="shortcuts-list">
                      <div className="shortcut">
                        <span className="keys">Click target icon</span>
                        <span className="action">Follow aircraft</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Ctrl+K</span>
                        <span className="action">Global aircraft search</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">O</span>
                        <span className="action">Toggle orbit mode</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Scroll (following)</span>
                        <span className="action">Adjust zoom/distance</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Escape</span>
                        <span className="action">Stop following</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Bookmarks</h3>
                    <div className="shortcuts-list">
                      <div className="shortcut">
                        <span className="keys">.XX</span>
                        <span className="action">Load bookmark (e.g., .00, .42)</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">.XX.</span>
                        <span className="action">Save bookmark (e.g., .00., .42.)</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">.XX.NAME.</span>
                        <span className="action">Save named bookmark</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Ctrl+0-9</span>
                        <span className="action">Quick load bookmarks 0-9</span>
                      </div>
                      <div className="shortcut">
                        <span className="keys">Ctrl+B</span>
                        <span className="action">Open bookmark manager</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>Updates</h3>
                    <div className="setting-row">
                      <button
                        className="control-button"
                        onClick={() => checkForUpdates()}
                        disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                      >
                        {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
                      </button>
                    </div>
                    <p className="setting-hint" style={{ marginTop: '8px' }}>
                      Current version: v{APP_VERSION}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import Settings Modal */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onSuccess={handleImportSuccess}
          onElectronImport={handleImportFromElectron}
        />
      )}

      {/* Bookmark Manager Modal */}
      {showBookmarkModal && (
        <BookmarkManagerModal
          onClose={() => setShowBookmarkModal(false)}
        />
      )}
    </>
  )
}

export default ControlsBar
