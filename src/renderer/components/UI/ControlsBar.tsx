import { useState, useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useMeasureStore } from '../../stores/measureStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAirportStore } from '../../stores/airportStore'
import { useReplayStore } from '../../stores/replayStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { calculateShareable3dPosition, calculateShareable2dPosition } from '../../utils/cameraGeometry'
import { hasViewingContext } from '../../utils/viewingContext'
import { modService } from '../../services/ModService'
import { modApi } from '../../utils/tauriApi'
import GlobalSearchPanel from './GlobalSearchPanel'
import VRButton from '../VR/VRButton'
import ImportModal from './ImportModal'
import BookmarkManagerModal from './BookmarkManagerModal'
import SettingsModal from './SettingsModal'
import ReplayControls from './ReplayControls'
import ContributeDialog, { type ContributeDialogData } from './ContributeDialog'
import './ControlsBar.css'

type BarMode = 'controls' | 'replay'

function ControlsBar() {
  const [showSettings, setShowSettings] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [barMode, setBarMode] = useState<BarMode>('controls')
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle')

  // Contribution dialog state
  const [contributeDialogData, setContributeDialogData] = useState<ContributeDialogData | null>(null)

  // Visual feedback for save/load default buttons
  const [defaultSaved, setDefaultSaved] = useState(false)
  const [defaultLoaded, setDefaultLoaded] = useState(false)

  // Track Shift key state for button label updates
  const [shiftPressed, setShiftPressed] = useState(false)

  // Settings store
  const askToContributePositions = useSettingsStore((state) => state.ui.askToContributePositions)

  // Active viewport camera state (from viewportStore)
  const {
    viewMode,
    toggleViewMode,
    heading,
    pitch,
    fov,
    topdownAltitude,
    followingCallsign,
    followMode,
    followZoom,
    orbitDistance,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ,
    resetView
  } = useActiveViewportCamera()

  // Viewport store - for default saving (shared across viewports)
  const saveCurrentAsDefault = useViewportStore((state) => state.saveCurrentAsDefault)
  const resetToDefault = useViewportStore((state) => state.resetToDefault)
  const resetToAppDefault = useViewportStore((state) => state.resetToAppDefault)
  const hasCustomDefault = useViewportStore((state) => state.hasCustomDefault)

  // Measure store
  const isMeasuring = useMeasureStore((state) => state.isActive)
  const toggleMeasuring = useMeasureStore((state) => state.toggleMeasuring)

  // Viewport store
  const insetCount = useViewportStore((state) => state.viewports.length - 1)
  const addViewport = useViewportStore((state) => state.addViewport)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const deselectAirport = useAirportStore((state) => state.deselectAirport)
  const pushModal = useUIFeedbackStore((state) => state.pushModal)
  const popModal = useUIFeedbackStore((state) => state.popModal)

  // Determine if we have a valid reference point (airport or orbit-following)
  const hasReference = hasViewingContext(currentAirport, followMode, followingCallsign)

  // Replay store - for isLive indicator
  const playbackMode = useReplayStore((state) => state.playbackMode)
  const isLive = playbackMode === 'live'

  // Track Shift key for button label updates
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPressed(true)
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShiftPressed(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // Register modals with UI feedback store for keyboard blocking
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

  useEffect(() => {
    if (showExitConfirm) {
      pushModal()
      return () => popModal()
    }
  }, [showExitConfirm, pushModal, popModal])

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

      if (e.key.toLowerCase() === 'b' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setShowBookmarkModal(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentAirport])

  const handleResetView = () => {
    resetView()
  }

  const handleSaveAsDefault = async (e: React.MouseEvent) => {
    // Shift+click saves to tower-positions/{ICAO}.json for sharing
    if (e.shiftKey && currentAirport) {
      const icao = currentAirport.icao.toUpperCase()
      const isTopdown = viewMode === 'topdown'
      const viewLabel = isTopdown ? '2D' : '3D'

      // Get existing positions for this airport
      const existing3d = modService.get3dPosition(icao)
      const existing2d = modService.get2dPosition(icao)

      try {
        // Check if this specific view already has a saved position
        const hasExisting = isTopdown ? !!existing2d : !!existing3d

        if (hasExisting) {
          // Show confirmation dialog
          const confirmed = window.confirm(
            `A ${viewLabel} tower position for ${icao} already exists.\n\nDo you want to overwrite it?`
          )
          if (!confirmed) return
        }

        // Build the complete file content (preserving the other view if it exists)
        const fileContent: {
          view3d?: { lat: number; lon: number; aglHeight: number; heading?: number }
          view2d?: { lat: number; lon: number; altitude: number; heading?: number }
        } = {}

        if (isTopdown) {
          // Save 2D topdown position
          const shareablePos = calculateShareable2dPosition(
            currentAirport.lat,
            currentAirport.lon,
            topdownAltitude,
            existing2d ?? null,
            positionOffsetX,
            positionOffsetY,
            heading
          )

          // Preserve existing 3D if present
          if (existing3d) {
            fileContent.view3d = {
              lat: existing3d.lat,
              lon: existing3d.lon,
              aglHeight: existing3d.aglHeight,
              heading: existing3d.heading
            }
          }

          fileContent.view2d = {
            lat: shareablePos.lat,
            lon: shareablePos.lon,
            altitude: shareablePos.altitude,
            heading: shareablePos.heading
          }

          await modApi.updateTowerPosition(icao, { view2d: fileContent.view2d })
          console.log(`[TowerPositions] Saved 2D position for ${icao}:`, shareablePos)
        } else {
          // Save 3D position
          const shareablePos = calculateShareable3dPosition(
            currentAirport.lat,
            currentAirport.lon,
            towerHeight,
            existing3d ?? null,
            positionOffsetX,
            positionOffsetY,
            positionOffsetZ,
            heading
          )

          fileContent.view3d = {
            lat: shareablePos.lat,
            lon: shareablePos.lon,
            aglHeight: shareablePos.aglHeight,
            heading: shareablePos.heading
          }

          // Preserve existing 2D if present
          if (existing2d) {
            fileContent.view2d = {
              lat: existing2d.lat ?? currentAirport.lat,
              lon: existing2d.lon ?? currentAirport.lon,
              altitude: existing2d.altitude,
              heading: existing2d.heading
            }
          }

          await modApi.updateTowerPosition(icao, { view3d: fileContent.view3d })
          console.log(`[TowerPositions] Saved 3D position for ${icao}:`, shareablePos)
        }

        // Show visual feedback
        setDefaultSaved(true)
        setTimeout(() => setDefaultSaved(false), 1500)

        // Offer to contribute to GitHub (if setting is enabled)
        if (askToContributePositions) {
          setContributeDialogData({ icao, viewLabel, fileContent })
        }
      } catch (error) {
        console.error('[TowerPositions] Failed to save shareable position:', error)
        alert(`Failed to save tower position: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    } else {
      // Normal click saves to local settings
      saveCurrentAsDefault()
      // Show visual feedback
      setDefaultSaved(true)
      setTimeout(() => setDefaultSaved(false), 1500)
    }
  }

  const handleResetToDefault = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      // Shift+click loads app default (from tower-positions/{ICAO}.json if exists, otherwise built-in default)
      // View-mode aware: uses view3d or view2d settings based on current view mode
      resetToAppDefault()
    } else {
      // Normal click loads user's saved default
      resetToDefault()
    }
    // Show visual feedback
    setDefaultLoaded(true)
    setTimeout(() => setDefaultLoaded(false), 1500)
  }

  const formatHeading = (angle: number) => {
    return Math.round(((angle % 360) + 360) % 360).toString().padStart(3, '0')
  }

  const formatPitch = (angle: number) => {
    const sign = angle >= 0 ? '+' : ''
    return sign + Math.round(angle) + '°'
  }

  const handleImportSuccess = () => {
    setImportStatus('success')
    setTimeout(() => setImportStatus('idle'), 3000)
  }

  const handleImportFromElectron = async () => {
    // Use the migration service to re-attempt Electron migration
    const { migrateFromElectron } = await import('../../services/MigrationService')

    // Reset migration flag to allow re-migration
    localStorage.removeItem('electron-migration-complete')

    const migrated = await migrateFromElectron()
    if (migrated) {
      // Close the import modal and show success
      setShowImportModal(false)
      setImportStatus('success')
      setTimeout(() => setImportStatus('idle'), 3000)

      // Reload to apply settings
      setTimeout(() => window.location.reload(), 500)
    } else {
      // Show error message
      alert('Could not find Electron settings to migrate. Make sure you have run the Electron version of TowerCab on this computer.')
    }
  }

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
              <button
                className="control-button"
                onClick={handleResetView}
                title="Reset View (Shift+R)"
                disabled={!hasReference}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                Reset
              </button>

              <button
                className="control-button"
                onClick={toggleViewMode}
                title="Toggle View Mode (T)"
                disabled={!hasReference}
              >
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

              <button
                className={`control-button ${defaultSaved ? 'success' : ''}`}
                onClick={handleSaveAsDefault}
                title={shiftPressed ? "Save to tower-positions file (for sharing)" : "Set Default View"}
                disabled={!currentAirport}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                {defaultSaved ? 'Saved!' : (shiftPressed ? 'Save Tower Pos' : 'Set Default')}
              </button>

              <button
                className={`control-button ${defaultLoaded ? 'success' : ''} ${(!currentAirport || (!hasCustomDefault() && !shiftPressed)) ? 'disabled' : ''}`}
                onClick={handleResetToDefault}
                disabled={!currentAirport || (!hasCustomDefault() && !shiftPressed)}
                title={shiftPressed ? "Load app default (from tower-positions file)" : "Load your saved default view"}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                {defaultLoaded ? 'Loaded!' : (shiftPressed ? 'Load Tower Pos' : 'To Default')}
              </button>

              <GlobalSearchPanel />

              <div className="camera-info">
                {viewMode === 'topdown' ? (
                  <>
                    <span className="info-item" title="Heading">
                      HDG {hasReference ? formatHeading(heading) : '--'}
                    </span>
                    <span className="info-item" title="Above Ground Level">
                      AGL {hasReference ? `${Math.round(topdownAltitude).toLocaleString()}ft` : '--'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="info-item" title="Heading">
                      HDG {hasReference ? formatHeading(heading) : '--'}
                    </span>
                    <span className="info-item" title="Pitch">
                      PIT {hasReference ? formatPitch(pitch) : '--'}
                    </span>
                    <span className="info-item" title="Field of View">
                      FOV {hasReference ? `${Math.round(fov)}°` : '--'}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="controls-center">
              {followingCallsign && (
                <div className="follow-status">
                  <span className="follow-indicator">Following: {followingCallsign}</span>
                  {followMode === 'tower' && (
                    <span className="follow-zoom-info">
                      Zoom: {followZoom.toFixed(1)}x
                      <span className="follow-range">(0.5–5.0)</span>
                    </span>
                  )}
                  {followMode === 'orbit' && (
                    <span className="follow-zoom-info">
                      Distance: {orbitDistance >= 1000 ? `${(orbitDistance / 1000).toFixed(1)}km` : `${Math.round(orbitDistance)}m`}
                      <span className="follow-range">(50m–5km)</span>
                    </span>
                  )}
                  <span className="follow-hint">Scroll to {followMode === 'tower' ? 'zoom' : 'adjust'} • O to switch • Esc to stop</span>
                </div>
              )}
            </div>

            <div className="controls-right">
              <button
                className={`control-button ${isMeasuring ? 'active' : ''}`}
                onClick={toggleMeasuring}
                title="Measuring Tool (M)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12h20M12 2v20M6 6l12 12M18 6L6 18" />
                </svg>
              </button>

              <button
                className="control-button"
                onClick={() => setShowBookmarkModal(!showBookmarkModal)}
                title="Bookmark Manager (Ctrl+B)"
                disabled={!currentAirport}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 6h16M4 12h16M4 18h16" />
                  <path d="M19 4l-5 5M19 10l-5 5M19 16l-5 5" />
                </svg>
              </button>

              <button
                className="control-button"
                onClick={() => addViewport()}
                title={`Add Inset Viewport (${insetCount} active)`}
                disabled={!currentAirport}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <rect x="12" y="3" width="9" height="9" rx="1" ry="1" />
                </svg>
                {insetCount > 0 && <span className="inset-count">{insetCount}</span>}
              </button>

              <VRButton />

              {currentAirport && (
                <button
                  className="control-button"
                  onClick={() => setShowExitConfirm(true)}
                  title="Back to Main Menu"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                </button>
              )}

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
          <ReplayControls onSettingsClick={() => setShowSettings(!showSettings)} />
        )}
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        onShowImportModal={() => setShowImportModal(true)}
        importStatus={importStatus}
      />

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

      {/* Contribution Dialog */}
      {contributeDialogData && (
        <ContributeDialog
          data={contributeDialogData}
          onClose={() => setContributeDialogData(null)}
        />
      )}

      {/* Exit Airport Confirmation Modal */}
      {showExitConfirm && (
        <div className="modal-overlay" onClick={() => setShowExitConfirm(false)}>
          <div className="modal exit-confirm-modal" onClick={e => e.stopPropagation()}>
            <h3>Leave {currentAirport?.icao}?</h3>
            <p>Return to the airport selection screen?</p>
            <div className="modal-buttons">
              <button
                className="modal-button cancel"
                onClick={() => setShowExitConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="modal-button confirm"
                onClick={() => {
                  setShowExitConfirm(false)
                  deselectAirport()
                }}
              >
                Leave Airport
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default ControlsBar
