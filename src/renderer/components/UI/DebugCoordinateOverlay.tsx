/**
 * Debug Coordinate Overlay
 *
 * Shows camera position coordinates and allows clicking to copy coordinates.
 * Enable via Settings > Advanced > Debugging
 */

import { useState, useEffect } from 'react'
import * as Cesium from 'cesium'
import './DebugCoordinateOverlay.css'

interface DebugCoordinateOverlayProps {
  viewer: Cesium.Viewer | null
  enabled: boolean
}

interface ClickedCoord {
  lat: number
  lon: number
  height: number
}

function DebugCoordinateOverlay({ viewer, enabled }: DebugCoordinateOverlayProps) {
  const [cameraPosition, setCameraPosition] = useState<{ lat: number; lon: number; height: number } | null>(null)
  const [clickedPosition, setClickedPosition] = useState<ClickedCoord | null>(null)
  const [copied, setCopied] = useState(false)

  // Update camera position on camera move
  useEffect(() => {
    if (!viewer || !enabled || viewer.isDestroyed()) return

    const updatePosition = () => {
      if (viewer.isDestroyed()) return
      const camera = viewer.camera
      const carto = camera.positionCartographic
      setCameraPosition({
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
        height: carto.height,
      })
    }

    // Initial update
    updatePosition()

    // Subscribe to camera changes
    const removeListener = viewer.camera.changed.addEventListener(updatePosition)

    return () => {
      removeListener()
    }
  }, [viewer, enabled])

  // Use Cesium's ScreenSpaceEventHandler to capture clicks on terrain
  useEffect(() => {
    if (!viewer || !enabled || viewer.isDestroyed()) return

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (viewer.isDestroyed()) return

      // Pick the terrain position
      const cartesian = viewer.scene.pickPosition(movement.position)
      if (cartesian) {
        const carto = Cesium.Cartographic.fromCartesian(cartesian)
        const coord = {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
          height: carto.height,
        }
        setClickedPosition(coord)

        // Copy to clipboard
        const coordStr = `${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)} (${coord.height.toFixed(1)}m)`
        navigator.clipboard.writeText(coordStr).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })

        console.log(`[DebugCoords] Clicked: ${coordStr}`)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    return () => {
      handler.destroy()
    }
  }, [viewer, enabled])

  if (!enabled || !cameraPosition) return null

  return (
    <div className="debug-coordinate-overlay">
      <div className="debug-coord-panel">
        <div className="debug-coord-title">Debug Coordinates</div>
        <div className="debug-coord-row">
          <span className="debug-coord-label">Camera:</span>
          <span className="debug-coord-value">
            {cameraPosition.lat.toFixed(6)}, {cameraPosition.lon.toFixed(6)}
          </span>
        </div>
        <div className="debug-coord-row">
          <span className="debug-coord-label">Height:</span>
          <span className="debug-coord-value">{cameraPosition.height.toFixed(1)}m</span>
        </div>
        {clickedPosition && (
          <>
            <div className="debug-coord-row clicked">
              <span className="debug-coord-label">Clicked:</span>
              <span className="debug-coord-value">
                {clickedPosition.lat.toFixed(6)}, {clickedPosition.lon.toFixed(6)}
              </span>
            </div>
            <div className="debug-coord-row clicked">
              <span className="debug-coord-label">Terrain:</span>
              <span className="debug-coord-value">{clickedPosition.height.toFixed(1)}m</span>
            </div>
          </>
        )}
        {copied && <div className="debug-coord-copied">Copied to clipboard!</div>}
        <div className="debug-coord-hint">Left-click on terrain to copy coordinates</div>
      </div>
    </div>
  )
}

export default DebugCoordinateOverlay
