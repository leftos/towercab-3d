import { useEffect, useState } from 'react'
import { performanceMonitor, type PerformanceMetrics } from '../../utils/performanceMonitor'
import './PerformanceHUD.css'

interface PerformanceHUDProps {
  visible: boolean
}

export function PerformanceHUD({ visible }: PerformanceHUDProps) {
  const [metrics, setMetrics] = useState<PerformanceMetrics>(performanceMonitor.getMetrics())

  useEffect(() => {
    if (!visible) return

    // Update metrics display at 10Hz (every 100ms)
    const intervalId = setInterval(() => {
      setMetrics(performanceMonitor.getMetrics())
    }, 100)

    return () => clearInterval(intervalId)
  }, [visible])

  if (!visible) return null

  const formatMs = (ms: number) => ms.toFixed(2)
  const formatFps = (fps: number) => Math.round(fps)

  // Calculate percentages of total frame interval
  const frameTotal = metrics.frameInterval || 1

  // Our work time breakdown
  const operationsPct = ((metrics.totalFrame / frameTotal) * 100).toFixed(1)
  const idlePct = ((metrics.idleTime / frameTotal) * 100).toFixed(1)

  // Individual component percentages of operations
  const opsTotal = metrics.totalFrame || 1
  const interpolationPct = ((metrics.interpolation / opsTotal) * 100).toFixed(1)
  const aircraftUpdatePct = ((metrics.aircraftUpdate / opsTotal) * 100).toFixed(1)
  const babylonSyncPct = ((metrics.babylonSync / opsTotal) * 100).toFixed(1)
  const babylonRenderPct = ((metrics.babylonRender / opsTotal) * 100).toFixed(1)
  const cesiumRenderPct = ((metrics.cesiumRender / opsTotal) * 100).toFixed(1)
  const unaccountedPct = ((metrics.unaccountedTime / opsTotal) * 100).toFixed(1)

  // Color code based on performance
  const fpsColor = metrics.fps >= 55 ? '#0f0' : metrics.fps >= 30 ? '#ff0' : '#f00'
  const frameColor = metrics.totalFrame <= 16.67 ? '#0f0' : metrics.totalFrame <= 33.33 ? '#ff0' : '#f00'

  // Frame interval comes directly from metrics now
  const frameInterval = metrics.frameInterval

  return (
    <div className="performance-hud">
      <div className="performance-header">Performance Monitor (F1)</div>

      <div className="performance-row">
        <span className="performance-label">FPS:</span>
        <span className="performance-value" style={{ color: fpsColor }}>
          {formatFps(metrics.fps)}
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">Frame Interval:</span>
        <span className="performance-value" style={{ color: fpsColor }}>
          {formatMs(frameInterval)}ms
        </span>
      </div>

      <div className="performance-divider" />

      {/* Frame breakdown - these should add up to frame interval */}
      <div className="performance-row">
        <span className="performance-label">Work Time:</span>
        <span className="performance-value" style={{ color: frameColor }}>
          {formatMs(metrics.totalFrame)}ms
          <span className="performance-pct">({operationsPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">Idle/VSync:</span>
        <span className="performance-value">
          {formatMs(metrics.idleTime)}ms
          <span className="performance-pct">({idlePct}%)</span>
        </span>
      </div>

      <div className="performance-divider" />

      {/* Work breakdown - these should add up to Work Time */}
      <div className="performance-row">
        <span className="performance-label">  Cesium:</span>
        <span className="performance-value">
          {formatMs(metrics.cesiumRender)}ms
          <span className="performance-pct">({cesiumRenderPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">    Update:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatMs(metrics.cesiumUpdate)}ms
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">    Draw:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatMs(metrics.cesiumDraw)}ms
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">  Interpolation:</span>
        <span className="performance-value">
          {formatMs(metrics.interpolation)}ms
          <span className="performance-pct">({interpolationPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">  Aircraft:</span>
        <span className="performance-value">
          {formatMs(metrics.aircraftUpdate)}ms
          <span className="performance-pct">({aircraftUpdatePct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">  Babylon Sync:</span>
        <span className="performance-value">
          {formatMs(metrics.babylonSync)}ms
          <span className="performance-pct">({babylonSyncPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label">  Babylon Render:</span>
        <span className="performance-value">
          {formatMs(metrics.babylonRender)}ms
          <span className="performance-pct">({babylonRenderPct}%)</span>
        </span>
      </div>

      {metrics.unaccountedTime > 0.5 && (
        <div className="performance-row">
          <span className="performance-label">  Other:</span>
          <span className="performance-value" style={{ color: '#ff0' }}>
            {formatMs(metrics.unaccountedTime)}ms
            <span className="performance-pct">({unaccountedPct}%)</span>
          </span>
        </div>
      )}

      <div className="performance-divider" />

      <div className="performance-row">
        <span className="performance-label">  Primitives:</span>
        <span className="performance-value">{metrics.cesiumPrimitives}</span>
      </div>

      <div className="performance-row">
        <span className="performance-label">  Tiles:</span>
        <span className="performance-value">
          {metrics.cesiumTilesLoaded} loaded
          {metrics.cesiumTilesLoading > 0 && (
            <span style={{ color: '#ff0' }}> +{metrics.cesiumTilesLoading} loading</span>
          )}
        </span>
      </div>

      <div className="performance-footer">
        Target: 60 FPS (16.67ms interval)
      </div>
    </div>
  )
}
