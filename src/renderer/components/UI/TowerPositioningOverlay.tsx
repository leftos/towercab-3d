/**
 * Tower Positioning Overlay
 *
 * HUD overlay displayed when tower positioning mode is active.
 * Content varies by wizard step:
 *
 * Step 1 (Model Positioning):
 * - Shows model offset values and rotation
 * - Control hints for WASD/QE/ZX movement
 *
 * Step 2 (Camera Positioning):
 * - Shows current camera position
 * - Control hints for normal camera movement
 *
 * Also handles:
 * - Updating camera position display in real-time (Step 2)
 * - Saving the manifest when Enter is pressed in Step 2
 */

import { useEffect, useCallback } from 'react'
import { useTowerPositioningStore } from '../../stores/towerPositioningStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useAirportStore } from '../../stores/airportStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { modApi, shellApi } from '../../utils/tauriApi'
import type { TowerModManifest } from '../../types/mod'

function TowerPositioningOverlay() {
  const isActive = useTowerPositioningStore((state) => state.isActive)
  const step = useTowerPositioningStore((state) => state.step)
  const targetIcao = useTowerPositioningStore((state) => state.targetIcao)
  const modelOffset = useTowerPositioningStore((state) => state.modelOffset)
  const modelRotation = useTowerPositioningStore((state) => state.modelRotation)
  const manifestPath = useTowerPositioningStore((state) => state.manifestPath)
  const step1ControlMode = useTowerPositioningStore((state) => state.step1ControlMode)
  const getAbsoluteModelPosition = useTowerPositioningStore((state) => state.getAbsoluteModelPosition)
  const captureCameraPosition = useTowerPositioningStore((state) => state.captureCameraPosition)
  const stopPositioning = useTowerPositioningStore((state) => state.stopPositioning)

  // Get current camera state for Step 2
  const cameraState = useViewportStore((state) => state.getActiveCameraState())
  const heading = cameraState.heading
  const pitch = cameraState.pitch
  const positionOffsetX = cameraState.positionOffsetX
  const positionOffsetY = cameraState.positionOffsetY
  const positionOffsetZ = cameraState.positionOffsetZ

  // Get camera position from positioning store
  const storedCameraPosition = useTowerPositioningStore((state) => state.cameraPosition)

  // Feedback
  const showFeedback = useUIFeedbackStore((state) => state.showFeedback)

  // Get airport data to compute camera AGL
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Update camera position in Step 2 based on current camera state
  useEffect(() => {
    if (!isActive || step !== 'camera' || !currentAirport) return

    // Compute camera lat/lon from airport position + offsets
    // positionOffsetX = east, positionOffsetY = north, positionOffsetZ = up
    const METERS_PER_DEGREE_LAT = 111320
    const getMetersPerDegreeLon = (lat: number) => 111320 * Math.cos(lat * Math.PI / 180)

    const baseLat = currentAirport.lat
    const baseLon = currentAirport.lon

    const cameraLat = baseLat + positionOffsetY / METERS_PER_DEGREE_LAT
    const cameraLon = baseLon + positionOffsetX / getMetersPerDegreeLon(baseLat)
    const cameraAglHeight = towerHeight + positionOffsetZ

    captureCameraPosition({
      lat: cameraLat,
      lon: cameraLon,
      height: cameraAglHeight,
      heading,
      pitch
    })
  }, [isActive, step, currentAirport, towerHeight, positionOffsetX, positionOffsetY, positionOffsetZ, heading, pitch, captureCameraPosition])

  // Handle save event (triggered when Enter is pressed in Step 2)
  const handleSave = useCallback(async () => {
    if (!manifestPath || !targetIcao) {
      showFeedback('Missing manifest path or ICAO', 'error')
      return
    }

    // Get final model position
    const modelPos = getAbsoluteModelPosition()
    if (!modelPos) {
      showFeedback('Failed to calculate model position', 'error')
      return
    }

    // Get camera position
    const cameraPos = storedCameraPosition
    if (!cameraPos) {
      showFeedback('Camera position not captured', 'error')
      return
    }

    try {
      // Read existing manifest
      let manifest: TowerModManifest
      try {
        const content = await modApi.readTextFile(manifestPath)
        manifest = JSON.parse(content) as TowerModManifest
      } catch {
        showFeedback('Failed to read manifest file', 'error')
        return
      }

      // Update manifest with new positions (using new structure)
      manifest.modelPosition = {
        lat: modelPos.lat,
        lon: modelPos.lon,
        height: modelPos.height,
        rotation: modelPos.rotation
      }

      manifest.cameraPosition = {
        lat: cameraPos.lat,
        lon: cameraPos.lon,
        height: cameraPos.height,
        heading: cameraPos.heading,
        pitch: cameraPos.pitch
      }

      // Remove deprecated fields if they exist
      delete manifest.position
      delete manifest.heightOffset
      delete manifest.cabPosition
      delete manifest.cabHeading

      // Format manifest with nice indentation
      const manifestContent = JSON.stringify(manifest, null, 2)

      // Get the directory containing the manifest
      const manifestDir = manifestPath.substring(0, manifestPath.lastIndexOf('\\'))

      // Check if directory is writable
      const isWritable = await modApi.checkPathWritable(manifestDir)

      if (isWritable) {
        // Save directly to manifest
        await modApi.writeTextFile(manifestPath, manifestContent)
        showFeedback(`Tower position saved for ${targetIcao}`, 'success')
      } else {
        // Save to temp folder
        const tempDir = `%APPDATA%/TowerCab 3D/temp-manifests/${targetIcao}`
        const tempPath = `${tempDir}/manifest.json`

        try {
          await modApi.writeTextFile(tempPath, manifestContent)
          showFeedback(
            `Saved to temp folder (no write permission)`,
            'success'
          )
          // Open the temp folder
          shellApi.openExternal(tempDir)
        } catch (e) {
          showFeedback(`Failed to save: ${e}`, 'error')
          return
        }
      }

      // Stop positioning mode
      stopPositioning()
    } catch (e) {
      showFeedback(`Save failed: ${e}`, 'error')
    }
  }, [manifestPath, targetIcao, getAbsoluteModelPosition, storedCameraPosition, showFeedback, stopPositioning])

  // Listen for save event
  useEffect(() => {
    const handleSaveEvent = () => {
      handleSave()
    }

    window.addEventListener('tower-positioning-save', handleSaveEvent)
    return () => {
      window.removeEventListener('tower-positioning-save', handleSaveEvent)
    }
  }, [handleSave])

  if (!isActive) {
    return null
  }

  // Display camera position (use stored position or fallback)
  const displayCameraPosition = storedCameraPosition

  return (
    <div className="tower-positioning-overlay">
      <div className="positioning-header">
        <span className="step-indicator">
          Step {step === 'model' ? '1' : '2'}/2
        </span>
        <span className="step-title">
          {step === 'model' ? 'Position Model' : 'Set Camera Position'}
        </span>
        <span className="icao-badge">{targetIcao}</span>
      </div>

      {step === 'model' ? (
        <div className="positioning-content">
          <div className="control-mode-toggle">
            <span className={`mode-option ${step1ControlMode === 'model' ? 'active' : ''}`}>
              Model
            </span>
            <span className="mode-separator">|</span>
            <span className={`mode-option ${step1ControlMode === 'camera' ? 'active' : ''}`}>
              Camera
            </span>
            <span className="tab-hint">(<kbd>Tab</kbd>)</span>
          </div>

          <div className="values-grid">
            <div className="value-row">
              <span className="value-label">N/S:</span>
              <span className="value-number">
                {modelOffset.north >= 0 ? '+' : ''}{modelOffset.north.toFixed(1)}m
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">E/W:</span>
              <span className="value-number">
                {modelOffset.east >= 0 ? '+' : ''}{modelOffset.east.toFixed(1)}m
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">Height:</span>
              <span className="value-number">
                {modelOffset.up >= 0 ? '+' : ''}{modelOffset.up.toFixed(1)}m
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">Rotation:</span>
              <span className="value-number">{modelRotation.toFixed(0)}°</span>
            </div>
          </div>

          {step1ControlMode === 'model' ? (
            <div className="controls-hint">
              <div className="hint-row">
                <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move
              </div>
              <div className="hint-row">
                <kbd>Q</kbd><kbd>E</kbd> Height
              </div>
              <div className="hint-row">
                <kbd>Z</kbd><kbd>X</kbd> Rotate
              </div>
              <div className="hint-row">
                <kbd>Shift</kbd> Fast | <kbd>Ctrl</kbd> Fine
              </div>
            </div>
          ) : (
            <div className="controls-hint camera-mode">
              <div className="hint-row">Normal camera controls active</div>
              <div className="hint-row">Adjust viewing angle, then Tab back</div>
            </div>
          )}

          <div className="actions-hint">
            <span className="action"><kbd>Enter</kbd> Next Step</span>
            {step1ControlMode === 'model' && <span className="action"><kbd>R</kbd> Reset</span>}
            <span className="action"><kbd>Esc</kbd> Cancel</span>
          </div>
        </div>
      ) : (
        <div className="positioning-content">
          <div className="values-grid">
            <div className="value-row">
              <span className="value-label">Lat:</span>
              <span className="value-number">
                {displayCameraPosition?.lat.toFixed(6) ?? '-'}
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">Lon:</span>
              <span className="value-number">
                {displayCameraPosition?.lon.toFixed(6) ?? '-'}
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">AGL:</span>
              <span className="value-number">
                {displayCameraPosition?.height.toFixed(1) ?? '-'}m
              </span>
            </div>
            <div className="value-row">
              <span className="value-label">Heading:</span>
              <span className="value-number">{heading.toFixed(0)}°</span>
            </div>
            <div className="value-row">
              <span className="value-label">Pitch:</span>
              <span className="value-number">{pitch.toFixed(0)}°</span>
            </div>
          </div>

          <div className="controls-hint">
            <div className="hint-row">Use normal camera controls</div>
            <div className="hint-row">Fly to desired cab viewpoint</div>
          </div>

          <div className="actions-hint">
            <span className="action"><kbd>Enter</kbd> Save All</span>
            <span className="action"><kbd>Esc</kbd> Back</span>
          </div>
        </div>
      )}

      <style>{`
        .tower-positioning-overlay {
          position: fixed;
          top: 80px;
          left: 20px;
          background: rgba(0, 0, 0, 0.85);
          border: 2px solid #4fc3f7;
          border-radius: 8px;
          padding: 16px;
          color: #fff;
          font-family: monospace;
          font-size: 13px;
          z-index: 1000;
          min-width: 220px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }

        .positioning-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
          padding-bottom: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.2);
        }

        .step-indicator {
          background: #4fc3f7;
          color: #000;
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: bold;
          font-size: 11px;
        }

        .step-title {
          font-weight: bold;
          font-size: 14px;
        }

        .icao-badge {
          margin-left: auto;
          background: rgba(255, 255, 255, 0.1);
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          color: #4fc3f7;
        }

        .control-mode-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 4px;
          font-size: 12px;
        }

        .mode-option {
          color: rgba(255, 255, 255, 0.4);
          transition: color 0.15s;
        }

        .mode-option.active {
          color: #4fc3f7;
          font-weight: bold;
        }

        .mode-separator {
          color: rgba(255, 255, 255, 0.2);
        }

        .tab-hint {
          margin-left: auto;
          font-size: 10px;
          color: rgba(255, 255, 255, 0.5);
        }

        .tab-hint kbd {
          font-size: 9px;
        }

        .controls-hint.camera-mode {
          border: 1px solid rgba(79, 195, 247, 0.3);
          background: rgba(79, 195, 247, 0.1);
        }

        .positioning-content {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .values-grid {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .value-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .value-label {
          color: rgba(255, 255, 255, 0.7);
        }

        .value-number {
          color: #4fc3f7;
          font-weight: bold;
        }

        .controls-hint {
          background: rgba(255, 255, 255, 0.05);
          padding: 8px;
          border-radius: 4px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .hint-row {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.8);
        }

        kbd {
          background: rgba(255, 255, 255, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 3px;
          padding: 1px 5px;
          font-size: 10px;
          font-family: inherit;
        }

        .actions-hint {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding-top: 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.2);
        }

        .action {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          color: rgba(255, 255, 255, 0.9);
        }

        .action kbd {
          background: #4fc3f7;
          color: #000;
          border-color: #4fc3f7;
        }
      `}</style>
    </div>
  )
}

export default TowerPositioningOverlay
