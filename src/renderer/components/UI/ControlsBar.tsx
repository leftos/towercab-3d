import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCameraStore } from '../../stores/cameraStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useMeasureStore } from '../../stores/measureStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { exportAllData, downloadExport } from '../../services/ExportImportService'
import GlobalSearchPanel from './GlobalSearchPanel'
import VRButton from '../VR/VRButton'
import ImportModal from './ImportModal'
import './ControlsBar.css'

type SettingsTab = 'general' | 'display' | 'graphics' | 'performance' | 'help'

function ControlsBar() {
  const [showSettings, setShowSettings] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [showImportModal, setShowImportModal] = useState(false)

  // Settings store - General
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const setCesiumIonToken = useSettingsStore((state) => state.setCesiumIonToken)
  const theme = useSettingsStore((state) => state.theme)
  const setTheme = useSettingsStore((state) => state.setTheme)
  const defaultFov = useSettingsStore((state) => state.defaultFov)
  const setDefaultFov = useSettingsStore((state) => state.setDefaultFov)
  const cameraSpeed = useSettingsStore((state) => state.cameraSpeed)
  const setCameraSpeed = useSettingsStore((state) => state.setCameraSpeed)
  const mouseSensitivity = useSettingsStore((state) => state.mouseSensitivity)
  const setMouseSensitivity = useSettingsStore((state) => state.setMouseSensitivity)

  // Settings store - Display
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)
  const setLabelVisibilityDistance = useSettingsStore((state) => state.setLabelVisibilityDistance)
  const maxAircraftDisplay = useSettingsStore((state) => state.maxAircraftDisplay)
  const setMaxAircraftDisplay = useSettingsStore((state) => state.setMaxAircraftDisplay)
  const datablockMode = useSettingsStore((state) => state.datablockMode)
  const setDatablockMode = useSettingsStore((state) => state.setDatablockMode)
  const showGroundTraffic = useSettingsStore((state) => state.showGroundTraffic)
  const setShowGroundTraffic = useSettingsStore((state) => state.setShowGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.showAirborneTraffic)
  const setShowAirborneTraffic = useSettingsStore((state) => state.setShowAirborneTraffic)
  const showAircraftPanel = useSettingsStore((state) => state.showAircraftPanel)
  const setShowAircraftPanel = useSettingsStore((state) => state.setShowAircraftPanel)

  // Settings store - Graphics
  const terrainQuality = useSettingsStore((state) => state.terrainQuality)
  const setTerrainQuality = useSettingsStore((state) => state.setTerrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.show3DBuildings)
  const setShow3DBuildings = useSettingsStore((state) => state.setShow3DBuildings)
  const timeMode = useSettingsStore((state) => state.timeMode)
  const setTimeMode = useSettingsStore((state) => state.setTimeMode)
  const fixedTimeHour = useSettingsStore((state) => state.fixedTimeHour)
  const setFixedTimeHour = useSettingsStore((state) => state.setFixedTimeHour)

  // Settings store - Weather
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const setShowWeatherEffects = useSettingsStore((state) => state.setShowWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.showCesiumFog)
  const setShowCesiumFog = useSettingsStore((state) => state.setShowCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.showBabylonFog)
  const setShowBabylonFog = useSettingsStore((state) => state.setShowBabylonFog)
  const showClouds = useSettingsStore((state) => state.showClouds)
  const setShowClouds = useSettingsStore((state) => state.setShowClouds)
  const cloudOpacity = useSettingsStore((state) => state.cloudOpacity)
  const setCloudOpacity = useSettingsStore((state) => state.setCloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.fogIntensity)
  const setFogIntensity = useSettingsStore((state) => state.setFogIntensity)
  const visibilityScale = useSettingsStore((state) => state.visibilityScale)
  const setVisibilityScale = useSettingsStore((state) => state.setVisibilityScale)

  // Weather store
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const isLoadingWeather = useWeatherStore((state) => state.isLoading)

  // Settings store - Performance
  const inMemoryTileCacheSize = useSettingsStore((state) => state.inMemoryTileCacheSize)
  const setInMemoryTileCacheSize = useSettingsStore((state) => state.setInMemoryTileCacheSize)
  const diskCacheSizeGB = useSettingsStore((state) => state.diskCacheSizeGB)
  const setDiskCacheSizeGB = useSettingsStore((state) => state.setDiskCacheSizeGB)
  const aircraftDataRadiusNM = useSettingsStore((state) => state.aircraftDataRadiusNM)
  const setAircraftDataRadiusNM = useSettingsStore((state) => state.setAircraftDataRadiusNM)

  // Settings store - Experimental Graphics
  const msaaSamples = useSettingsStore((state) => state.msaaSamples)
  const setMsaaSamples = useSettingsStore((state) => state.setMsaaSamples)
  const enableFxaa = useSettingsStore((state) => state.enableFxaa)
  const setEnableFxaa = useSettingsStore((state) => state.setEnableFxaa)
  const enableHdr = useSettingsStore((state) => state.enableHdr)
  const setEnableHdr = useSettingsStore((state) => state.setEnableHdr)
  const enableLogDepth = useSettingsStore((state) => state.enableLogDepth)
  const setEnableLogDepth = useSettingsStore((state) => state.setEnableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.enableGroundAtmosphere)
  const setEnableGroundAtmosphere = useSettingsStore((state) => state.setEnableGroundAtmosphere)
  const enableLighting = useSettingsStore((state) => state.enableLighting)
  const setEnableLighting = useSettingsStore((state) => state.setEnableLighting)
  const enableShadows = useSettingsStore((state) => state.enableShadows)
  const setEnableShadows = useSettingsStore((state) => state.setEnableShadows)
  const shadowMapSize = useSettingsStore((state) => state.shadowMapSize)
  const setShadowMapSize = useSettingsStore((state) => state.setShadowMapSize)
  const shadowCascades = useSettingsStore((state) => state.shadowCascades)
  const setShadowCascades = useSettingsStore((state) => state.setShadowCascades)
  const shadowMaxDistance = useSettingsStore((state) => state.shadowMaxDistance)
  const setShadowMaxDistance = useSettingsStore((state) => state.setShadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.shadowDarkness)
  const setShadowDarkness = useSettingsStore((state) => state.setShadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.shadowSoftness)
  const setShadowSoftness = useSettingsStore((state) => state.setShadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.shadowFadingEnabled)
  const setShadowFadingEnabled = useSettingsStore((state) => state.setShadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.shadowNormalOffset)
  const setShadowNormalOffset = useSettingsStore((state) => state.setShadowNormalOffset)

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

  // Camera store - only for default saving (shared across viewports)
  const saveCurrentAsDefault = useCameraStore((state) => state.saveCurrentAsDefault)
  const resetToDefault = useCameraStore((state) => state.resetToDefault)
  const hasCustomDefault = useCameraStore((state) => state.hasCustomDefault)

  // Measure store
  const isMeasuring = useMeasureStore((state) => state.isActive)
  const toggleMeasuring = useMeasureStore((state) => state.toggleMeasuring)

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

  return (
    <>
      <div className="controls-bar">
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
      </div>

      {showSettings && (
        <div className={`settings-modal-overlay ${activeTab === 'graphics' ? 'no-blur' : ''}`} onClick={() => setShowSettings(false)}>
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
                      <input
                        type="text"
                        value={cesiumIonToken}
                        onChange={(e) => setCesiumIonToken(e.target.value)}
                        placeholder="Enter your Cesium Ion access token"
                        className="text-input"
                      />
                      <p className="setting-hint">
                        Get a free token at{' '}
                        <a href="https://cesium.com/ion/" target="_blank" rel="noopener noreferrer">
                          cesium.com/ion
                        </a>
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
                            onChange={() => setTheme('dark')}
                          />
                          Dark
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="theme"
                            value="light"
                            checked={theme === 'light'}
                            onChange={() => setTheme('light')}
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
                          onChange={(e) => setDefaultFov(Number(e.target.value))}
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
                          onChange={(e) => setCameraSpeed(Number(e.target.value))}
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
                          onChange={(e) => setMouseSensitivity(Number(e.target.value))}
                        />
                        <span>{mouseSensitivity.toFixed(1)}</span>
                      </div>
                      <p className="setting-hint">Right-click drag sensitivity for camera rotation.</p>
                    </div>
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
                          onClick={() => {
                            setImportError(null)
                            setShowImportModal(true)
                          }}
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
                    <h3>Labels</h3>
                    <div className="setting-item">
                      <label>Label Visibility Distance</label>
                      <div className="slider-with-value">
                        <input
                          type="range"
                          min="5"
                          max="100"
                          value={labelVisibilityDistance}
                          onChange={(e) => setLabelVisibilityDistance(Number(e.target.value))}
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
                            onChange={() => setDatablockMode('full')}
                          />
                          Full (callsign + type + altitude + speed)
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="datablockMode"
                            value="airline"
                            checked={datablockMode === 'airline'}
                            onChange={() => setDatablockMode('airline')}
                          />
                          Airline Codes Only (ICAO code for airline flights)
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="datablockMode"
                            value="none"
                            checked={datablockMode === 'none'}
                            onChange={() => setDatablockMode('none')}
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
                          onChange={(e) => setMaxAircraftDisplay(Number(e.target.value))}
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
                          onChange={(e) => setShowGroundTraffic(e.target.checked)}
                        />
                        Show Ground Traffic
                      </label>
                    </div>

                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showAirborneTraffic}
                          onChange={(e) => setShowAirborneTraffic(e.target.checked)}
                        />
                        Show Airborne Traffic
                      </label>
                    </div>
                  </div>

                  <div className="settings-section">
                    <h3>UI</h3>
                    <div className="setting-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={showAircraftPanel}
                          onChange={(e) => setShowAircraftPanel(e.target.checked)}
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
                          onChange={(e) => setTerrainQuality(Number(e.target.value))}
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
                          onChange={(e) => setShow3DBuildings(e.target.checked)}
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
                            onChange={() => setTimeMode('real')}
                          />
                          Real Time
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="timeMode"
                            value="fixed"
                            checked={timeMode === 'fixed'}
                            onChange={() => setTimeMode('fixed')}
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
                            onChange={(e) => setFixedTimeHour(Number(e.target.value))}
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
                          onChange={(e) => setShowWeatherEffects(e.target.checked)}
                        />
                        Enable Weather Effects
                      </label>
                      <p className="setting-hint">
                        Fetches real weather data for the current airport.
                      </p>
                    </div>

                    {showWeatherEffects && (
                      <>
                        <div className="setting-item">
                          <label>
                            <input
                              type="checkbox"
                              checked={showCesiumFog}
                              onChange={(e) => setShowCesiumFog(e.target.checked)}
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
                              onChange={(e) => setShowBabylonFog(e.target.checked)}
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
                              onChange={(e) => setShowClouds(e.target.checked)}
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
                              onChange={(e) => setCloudOpacity(Number(e.target.value))}
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
                              onChange={(e) => setFogIntensity(Number(e.target.value))}
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
                              onChange={(e) => setVisibilityScale(Number(e.target.value))}
                              disabled={!showBabylonFog}
                            />
                            <span>{visibilityScale.toFixed(1)}x</span>
                          </div>
                          <p className="setting-hint">
                            Multiplier for fog distance. 2.0 = see twice as far as METAR visibility.
                          </p>
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
                        onChange={(e) => setMsaaSamples(Number(e.target.value))}
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
                          onChange={(e) => setEnableFxaa(e.target.checked)}
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
                          onChange={(e) => setEnableHdr(e.target.checked)}
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
                          onChange={(e) => setEnableLogDepth(e.target.checked)}
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
                          onChange={(e) => setEnableGroundAtmosphere(e.target.checked)}
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
                          checked={enableLighting}
                          onChange={(e) => setEnableLighting(e.target.checked)}
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
                          onChange={(e) => setEnableShadows(e.target.checked)}
                        />
                        Shadows
                      </label>
                      <p className="setting-hint">
                        Enables shadow casting for terrain and 3D models. Performance impact.
                      </p>
                    </div>

                    {enableShadows && (
                      <>
                        <div className="setting-item">
                          <label>Shadow Map Size</label>
                          <select
                            value={shadowMapSize}
                            onChange={(e) => setShadowMapSize(Number(e.target.value))}
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
                          <label>Shadow Cascades</label>
                          <select
                            value={shadowCascades}
                            onChange={(e) => setShadowCascades(Number(e.target.value))}
                            className="select-input"
                          >
                            <option value={1}>1 (Single)</option>
                            <option value={2}>2 (Dual)</option>
                            <option value={4}>4 (Quad)</option>
                          </select>
                          <p className="setting-hint">
                            More cascades = better shadow quality at different distances.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label>Shadow Max Distance</label>
                          <div className="slider-with-value">
                            <input
                              type="range"
                              min="100"
                              max="10000"
                              step="100"
                              value={shadowMaxDistance}
                              onChange={(e) => setShadowMaxDistance(Number(e.target.value))}
                            />
                            <span>{shadowMaxDistance}m</span>
                          </div>
                          <p className="setting-hint">
                            Maximum distance for shadows. Lower = better quality nearby.
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
                              onChange={(e) => setShadowDarkness(Number(e.target.value))}
                            />
                            <span>{(shadowDarkness * 100).toFixed(0)}%</span>
                          </div>
                          <p className="setting-hint">
                            Shadow brightness. 0% = black shadows, 100% = invisible shadows.
                          </p>
                        </div>

                        <div className="setting-item">
                          <label>
                            <input
                              type="checkbox"
                              checked={shadowSoftness}
                              onChange={(e) => setShadowSoftness(e.target.checked)}
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
                              onChange={(e) => setShadowFadingEnabled(e.target.checked)}
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
                              onChange={(e) => setShadowNormalOffset(e.target.checked)}
                            />
                            Normal Offset
                          </label>
                          <p className="setting-hint">
                            Reduces shadow acne artifacts. Try disabling if you see banding.
                          </p>
                        </div>
                      </>
                    )}
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
                          onChange={(e) => setInMemoryTileCacheSize(Number(e.target.value))}
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
                          onChange={(e) => setDiskCacheSizeGB(Number(e.target.value))}
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
                          onChange={(e) => setAircraftDataRadiusNM(Number(e.target.value))}
                        />
                        <span>{aircraftDataRadiusNM} nm</span>
                      </div>
                      <p className="setting-hint">
                        Only keep aircraft data within this radius of tower.
                      </p>
                    </div>
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
                        <span className="action">Reset everything</span>
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
    </>
  )
}

export default ControlsBar
