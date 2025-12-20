import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useMeasureStore } from '../../stores/measureStore'
import './MeasuringTool.css'

interface MeasuringToolProps {
  cesiumViewer: Cesium.Viewer | null
}

function MeasuringTool({ cesiumViewer }: MeasuringToolProps) {
  const isActive = useMeasureStore((state) => state.isActive)
  const measurements = useMeasureStore((state) => state.measurements)
  const pendingPoint = useMeasureStore((state) => state.pendingPoint)
  const previewPoint = useMeasureStore((state) => state.previewPoint)
  const previewDistance = useMeasureStore((state) => state.previewDistance)
  const stopMeasuring = useMeasureStore((state) => state.stopMeasuring)
  const clearAllMeasurements = useMeasureStore((state) => state.clearAllMeasurements)

  // Refs for Cesium entities - keyed by measurement id
  const measurementEntitiesRef = useRef<Map<string, {
    point1: Cesium.Entity
    point2: Cesium.Entity
    line: Cesium.Entity
    label: Cesium.Entity
  }>>(new Map())

  // Refs for pending/preview entities
  const pendingPointEntityRef = useRef<Cesium.Entity | null>(null)
  const previewLineEntityRef = useRef<Cesium.Entity | null>(null)
  const previewLabelEntityRef = useRef<Cesium.Entity | null>(null)

  // Create/update Cesium entities for completed measurements
  useEffect(() => {
    if (!cesiumViewer || cesiumViewer.isDestroyed()) return

    const existingIds = new Set(measurementEntitiesRef.current.keys())
    const currentIds = new Set(measurements.map(m => m.id))

    // Remove entities for deleted measurements
    for (const id of existingIds) {
      if (!currentIds.has(id)) {
        const entities = measurementEntitiesRef.current.get(id)
        if (entities) {
          cesiumViewer.entities.remove(entities.point1)
          cesiumViewer.entities.remove(entities.point2)
          cesiumViewer.entities.remove(entities.line)
          cesiumViewer.entities.remove(entities.label)
          measurementEntitiesRef.current.delete(id)
        }
      }
    }

    // Create entities for new measurements
    for (const m of measurements) {
      if (!measurementEntitiesRef.current.has(m.id)) {
        // Calculate midpoint for label
        const midpoint = Cesium.Cartesian3.midpoint(
          m.point1.cartesian,
          m.point2.cartesian,
          new Cesium.Cartesian3()
        )

        const point1Entity = cesiumViewer.entities.add({
          id: `measure_${m.id}_p1`,
          position: m.point1.cartesian,
          point: {
            pixelSize: 10,
            color: Cesium.Color.CYAN,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })

        const point2Entity = cesiumViewer.entities.add({
          id: `measure_${m.id}_p2`,
          position: m.point2.cartesian,
          point: {
            pixelSize: 10,
            color: Cesium.Color.CYAN,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })

        const lineEntity = cesiumViewer.entities.add({
          id: `measure_${m.id}_line`,
          polyline: {
            positions: [m.point1.cartesian, m.point2.cartesian],
            width: 3,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.CYAN,
              dashLength: 16
            }),
            clampToGround: true
          }
        })

        const labelEntity = cesiumViewer.entities.add({
          id: `measure_${m.id}_label`,
          position: midpoint,
          label: {
            text: formatDistance(m.distanceMeters),
            font: '14px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            showBackground: true,
            backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })

        measurementEntitiesRef.current.set(m.id, {
          point1: point1Entity,
          point2: point2Entity,
          line: lineEntity,
          label: labelEntity
        })
      }
    }

    // Cleanup on unmount - capture ref value to avoid stale closure
    const entitiesMap = measurementEntitiesRef.current
    return () => {
      for (const entities of entitiesMap.values()) {
        if (!cesiumViewer.isDestroyed()) {
          cesiumViewer.entities.remove(entities.point1)
          cesiumViewer.entities.remove(entities.point2)
          cesiumViewer.entities.remove(entities.line)
          cesiumViewer.entities.remove(entities.label)
        }
      }
      entitiesMap.clear()
    }
  }, [cesiumViewer, measurements])

  // Create/update pending point and preview line
  useEffect(() => {
    if (!cesiumViewer || cesiumViewer.isDestroyed()) return

    // Cleanup function
    const cleanup = () => {
      if (pendingPointEntityRef.current && !cesiumViewer.isDestroyed()) {
        cesiumViewer.entities.remove(pendingPointEntityRef.current)
        pendingPointEntityRef.current = null
      }
      if (previewLineEntityRef.current && !cesiumViewer.isDestroyed()) {
        cesiumViewer.entities.remove(previewLineEntityRef.current)
        previewLineEntityRef.current = null
      }
      if (previewLabelEntityRef.current && !cesiumViewer.isDestroyed()) {
        cesiumViewer.entities.remove(previewLabelEntityRef.current)
        previewLabelEntityRef.current = null
      }
    }

    // Create/update pending point marker
    if (pendingPoint) {
      if (!pendingPointEntityRef.current) {
        pendingPointEntityRef.current = cesiumViewer.entities.add({
          id: 'measure_pending_point',
          position: pendingPoint.cartesian,
          point: {
            pixelSize: 12,
            color: Cesium.Color.YELLOW,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        })
      } else {
        pendingPointEntityRef.current.position = new Cesium.ConstantPositionProperty(pendingPoint.cartesian)
      }

      // Create/update preview line if we have a preview point
      if (previewPoint) {
        const midpoint = Cesium.Cartesian3.midpoint(
          pendingPoint.cartesian,
          previewPoint.cartesian,
          new Cesium.Cartesian3()
        )

        if (!previewLineEntityRef.current) {
          previewLineEntityRef.current = cesiumViewer.entities.add({
            id: 'measure_preview_line',
            polyline: {
              positions: [pendingPoint.cartesian, previewPoint.cartesian],
              width: 2,
              material: new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.YELLOW.withAlpha(0.7),
                dashLength: 12
              }),
              clampToGround: true
            }
          })
        } else if (previewLineEntityRef.current.polyline) {
          previewLineEntityRef.current.polyline.positions = new Cesium.ConstantProperty([
            pendingPoint.cartesian,
            previewPoint.cartesian
          ])
        }

        // Create/update preview distance label
        if (previewDistance !== null) {
          if (!previewLabelEntityRef.current) {
            previewLabelEntityRef.current = cesiumViewer.entities.add({
              id: 'measure_preview_label',
              position: midpoint,
              label: {
                text: formatDistance(previewDistance),
                font: '13px sans-serif',
                fillColor: Cesium.Color.YELLOW,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                showBackground: true,
                backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
                backgroundPadding: new Cesium.Cartesian2(6, 4),
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -8),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
              }
            })
          } else {
            previewLabelEntityRef.current.position = new Cesium.ConstantPositionProperty(midpoint)
            if (previewLabelEntityRef.current.label) {
              previewLabelEntityRef.current.label.text = new Cesium.ConstantProperty(formatDistance(previewDistance))
            }
          }
        }
      } else {
        // No preview point, remove preview line and label
        if (previewLineEntityRef.current) {
          cesiumViewer.entities.remove(previewLineEntityRef.current)
          previewLineEntityRef.current = null
        }
        if (previewLabelEntityRef.current) {
          cesiumViewer.entities.remove(previewLabelEntityRef.current)
          previewLabelEntityRef.current = null
        }
      }
    } else {
      // No pending point, clean up all preview entities
      cleanup()
    }

    return cleanup
  }, [cesiumViewer, pendingPoint, previewPoint, previewDistance])

  // Format distance for display
  function formatDistance(meters: number): string {
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

  // Don't render UI if not active and no measurements
  if (!isActive && measurements.length === 0) return null

  return (
    <div className="measuring-tool">
      <div className="measuring-header">
        <span className="measuring-title">Measure Distance</span>
        <button className="measuring-close" onClick={stopMeasuring} title="Close measuring tool">
          &times;
        </button>
      </div>

      <div className="measuring-content">
        {isActive && !pendingPoint && (
          <p className="measuring-hint">Click on the terrain to start measuring</p>
        )}

        {isActive && pendingPoint && !previewPoint && (
          <p className="measuring-hint">Move mouse to preview, click to confirm (Esc to cancel)</p>
        )}

        {isActive && pendingPoint && previewPoint && previewDistance !== null && (
          <div className="measuring-preview">
            <span className="measuring-label">Preview:</span>
            <span className="measuring-value preview">{formatDistance(previewDistance)}</span>
          </div>
        )}

        {measurements.length > 0 && (
          <div className="measuring-list">
            <div className="measuring-list-header">
              <span>Measurements ({measurements.length})</span>
              <button className="measuring-clear-all" onClick={clearAllMeasurements} title="Clear all measurements">
                Clear All
              </button>
            </div>
            {measurements.map((m, index) => (
              <div key={m.id} className="measuring-item">
                <span className="measuring-item-number">{index + 1}.</span>
                <span className="measuring-item-value">{formatDistance(m.distanceMeters)}</span>
                <span className="measuring-item-hint">(right-click endpoint to remove)</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default MeasuringTool
