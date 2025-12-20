import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useMeasureStore } from '../../stores/measureStore'
import './MeasuringTool.css'

interface MeasuringToolProps {
  cesiumViewer: Cesium.Viewer | null
}

function MeasuringTool({ cesiumViewer }: MeasuringToolProps) {
  const isActive = useMeasureStore((state) => state.isActive)
  const point1 = useMeasureStore((state) => state.point1)
  const point2 = useMeasureStore((state) => state.point2)
  const distanceMeters = useMeasureStore((state) => state.distanceMeters)
  const clearMeasurement = useMeasureStore((state) => state.clearMeasurement)
  const stopMeasuring = useMeasureStore((state) => state.stopMeasuring)

  // Refs for Cesium entities
  const point1EntityRef = useRef<Cesium.Entity | null>(null)
  const point2EntityRef = useRef<Cesium.Entity | null>(null)
  const lineEntityRef = useRef<Cesium.Entity | null>(null)

  // Create/update Cesium entities for visualization
  useEffect(() => {
    if (!cesiumViewer || cesiumViewer.isDestroyed()) return

    // Clean up existing entities
    const cleanup = () => {
      if (point1EntityRef.current) {
        cesiumViewer.entities.remove(point1EntityRef.current)
        point1EntityRef.current = null
      }
      if (point2EntityRef.current) {
        cesiumViewer.entities.remove(point2EntityRef.current)
        point2EntityRef.current = null
      }
      if (lineEntityRef.current) {
        cesiumViewer.entities.remove(lineEntityRef.current)
        lineEntityRef.current = null
      }
    }

    // If not active or no points, clean up and exit
    if (!isActive) {
      cleanup()
      return cleanup
    }

    // Create point 1 marker
    if (point1 && !point1EntityRef.current) {
      point1EntityRef.current = cesiumViewer.entities.add({
        id: 'measure_point_1',
        position: point1.cartesian,
        point: {
          pixelSize: 12,
          color: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    } else if (point1 && point1EntityRef.current) {
      point1EntityRef.current.position = new Cesium.ConstantPositionProperty(point1.cartesian)
    } else if (!point1 && point1EntityRef.current) {
      cesiumViewer.entities.remove(point1EntityRef.current)
      point1EntityRef.current = null
    }

    // Create point 2 marker
    if (point2 && !point2EntityRef.current) {
      point2EntityRef.current = cesiumViewer.entities.add({
        id: 'measure_point_2',
        position: point2.cartesian,
        point: {
          pixelSize: 12,
          color: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    } else if (point2 && point2EntityRef.current) {
      point2EntityRef.current.position = new Cesium.ConstantPositionProperty(point2.cartesian)
    } else if (!point2 && point2EntityRef.current) {
      cesiumViewer.entities.remove(point2EntityRef.current)
      point2EntityRef.current = null
    }

    // Create line between points
    if (point1 && point2 && !lineEntityRef.current) {
      lineEntityRef.current = cesiumViewer.entities.add({
        id: 'measure_line',
        polyline: {
          positions: [point1.cartesian, point2.cartesian],
          width: 3,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.CYAN,
            dashLength: 16
          }),
          clampToGround: true
        }
      })
    } else if (point1 && point2 && lineEntityRef.current && lineEntityRef.current.polyline) {
      lineEntityRef.current.polyline.positions = new Cesium.ConstantProperty([point1.cartesian, point2.cartesian])
    } else if ((!point1 || !point2) && lineEntityRef.current) {
      cesiumViewer.entities.remove(lineEntityRef.current)
      lineEntityRef.current = null
    }

    return cleanup
  }, [cesiumViewer, isActive, point1, point2])

  // Format distance for display
  const formatDistance = (meters: number): string => {
    const nm = meters / 1852
    const feet = meters * 3.28084
    const km = meters / 1000

    if (meters < 1000) {
      return `${Math.round(meters)} m (${Math.round(feet)} ft)`
    } else if (nm < 1) {
      return `${km.toFixed(2)} km (${Math.round(feet).toLocaleString()} ft)`
    } else {
      return `${nm.toFixed(2)} nm (${km.toFixed(2)} km)`
    }
  }

  // Don't render UI if not active
  if (!isActive) return null

  return (
    <div className="measuring-tool">
      <div className="measuring-header">
        <span className="measuring-title">Measure Distance</span>
        <button className="measuring-close" onClick={stopMeasuring} title="Close measuring tool">
          &times;
        </button>
      </div>

      <div className="measuring-content">
        {!point1 && (
          <p className="measuring-hint">Click on the terrain to set the first point</p>
        )}

        {point1 && !point2 && (
          <p className="measuring-hint">Click on the terrain to set the second point</p>
        )}

        {point1 && point2 && distanceMeters !== null && (
          <>
            <div className="measuring-result">
              <span className="measuring-label">Distance:</span>
              <span className="measuring-value">{formatDistance(distanceMeters)}</span>
            </div>
            <button className="measuring-reset" onClick={clearMeasurement}>
              New Measurement
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default MeasuringTool
