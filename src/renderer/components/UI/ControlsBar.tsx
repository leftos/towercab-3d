import { useState } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCameraStore } from '../../stores/cameraStore'
import GlobalSearchPanel from './GlobalSearchPanel'
import './ControlsBar.css'

function ControlsBar() {
  const [showSettings, setShowSettings] = useState(false)

  // Settings store
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)
  const setLabelVisibilityDistance = useSettingsStore((state) => state.setLabelVisibilityDistance)
  const showAircraftPanel = useSettingsStore((state) => state.showAircraftPanel)
  const setShowAircraftPanel = useSettingsStore((state) => state.setShowAircraftPanel)
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const setCesiumIonToken = useSettingsStore((state) => state.setCesiumIonToken)
  const terrainQuality = useSettingsStore((state) => state.terrainQuality)
  const setTerrainQuality = useSettingsStore((state) => state.setTerrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.show3DBuildings)
  const setShow3DBuildings = useSettingsStore((state) => state.setShow3DBuildings)
  const timeMode = useSettingsStore((state) => state.timeMode)
  const setTimeMode = useSettingsStore((state) => state.setTimeMode)
  const fixedTimeHour = useSettingsStore((state) => state.fixedTimeHour)
  const setFixedTimeHour = useSettingsStore((state) => state.setFixedTimeHour)

  // Camera store
  const viewMode = useCameraStore((state) => state.viewMode)
  const toggleViewMode = useCameraStore((state) => state.toggleViewMode)
  const heading = useCameraStore((state) => state.heading)
  const pitch = useCameraStore((state) => state.pitch)
  const fov = useCameraStore((state) => state.fov)
  const topdownAltitude = useCameraStore((state) => state.topdownAltitude)
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const resetView = useCameraStore((state) => state.resetView)
  const setFov = useCameraStore((state) => state.setFov)
  const saveCurrentAsDefault = useCameraStore((state) => state.saveCurrentAsDefault)
  const resetToDefault = useCameraStore((state) => state.resetToDefault)
  const hasCustomDefault = useCameraStore((state) => state.hasCustomDefault)

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
        <div className="settings-modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button className="close-button" onClick={() => setShowSettings(false)}>
                &times;
              </button>
            </div>

            <div className="settings-content">
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
                <h3>Display</h3>
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

              <div className="settings-section">
                <h3>Graphics</h3>
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
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default ControlsBar
