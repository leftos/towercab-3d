import { useEffect, useState } from 'react'
import { type PerformanceMetrics, performanceMonitor } from '../../utils/performanceMonitor'
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
  const formatGpu = (ms: number) => (ms < 0 ? 'n/a' : `${ms.toFixed(2)}ms`)

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

  // GPU timing (real GPU execution time via timer queries). -1 means unsupported.
  const gpuCesium = metrics.gpuCesiumMs
  const gpuBabylon = metrics.gpuBabylonMs
  const gpuTotal = (gpuCesium >= 0 ? gpuCesium : 0) + (gpuBabylon >= 0 ? gpuBabylon : 0)
  // GPU-bound frames show gpuTotal close to the frame interval; a small gpuTotal with a large
  // idle points at a scheduling/present problem instead.
  const gpuColor = gpuTotal > frameTotal * 0.7 ? '#f00' : gpuTotal > 16.67 ? '#ff0' : '#0f0'

  // Split the idle gap into JS that blocked the main thread vs pure GPU/compositor wait.
  const blockedJs = metrics.blockedJsMs
  const presentWait = Math.max(0, metrics.idleTime - blockedJs)
  const blockedColor = blockedJs > 16.67 ? '#f00' : blockedJs > 4 ? '#ff0' : '#888'

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

      <div className="performance-row">
        <span className="performance-label"> Blocked JS:</span>
        <span className="performance-value" style={{ color: blockedColor }}>
          {formatMs(blockedJs)}ms
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> GPU/Present:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatMs(presentWait)}ms
        </span>
      </div>

      <div className="performance-divider" />

      {/* Real GPU execution time (timer queries) - reveals GPU-bound frames the JS timers miss */}
      <div className="performance-row">
        <span className="performance-label">GPU Total:</span>
        <span className="performance-value" style={{ color: metrics.gpuSupported ? gpuColor : '#888' }}>
          {metrics.gpuSupported ? `${formatMs(gpuTotal)}ms` : 'n/a (no timer ext)'}
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> GPU Cesium:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatGpu(gpuCesium)}
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> GPU Babylon:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatGpu(gpuBabylon)}
        </span>
      </div>

      <div className="performance-divider" />

      {/* Work breakdown - these should add up to Work Time */}
      <div className="performance-row">
        <span className="performance-label"> Cesium:</span>
        <span className="performance-value">
          {formatMs(metrics.cesiumRender)}ms
          <span className="performance-pct">({cesiumRenderPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Update:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatMs(metrics.cesiumUpdate)}ms
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Draw:</span>
        <span className="performance-value" style={{ color: '#888' }}>
          {formatMs(metrics.cesiumDraw)}ms
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Interpolation:</span>
        <span className="performance-value">
          {formatMs(metrics.interpolation)}ms
          <span className="performance-pct">({interpolationPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Aircraft:</span>
        <span className="performance-value">
          {formatMs(metrics.aircraftUpdate)}ms
          <span className="performance-pct">({aircraftUpdatePct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Babylon Sync:</span>
        <span className="performance-value">
          {formatMs(metrics.babylonSync)}ms
          <span className="performance-pct">({babylonSyncPct}%)</span>
        </span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Babylon Render:</span>
        <span className="performance-value">
          {formatMs(metrics.babylonRender)}ms
          <span className="performance-pct">({babylonRenderPct}%)</span>
        </span>
      </div>

      {metrics.unaccountedTime > 0.5 && (
        <div className="performance-row">
          <span className="performance-label"> Other:</span>
          <span className="performance-value" style={{ color: '#ff0' }}>
            {formatMs(metrics.unaccountedTime)}ms
            <span className="performance-pct">({unaccountedPct}%)</span>
          </span>
        </div>
      )}

      <div className="performance-divider" />

      <div className="performance-row">
        <span className="performance-label"> Primitives:</span>
        <span className="performance-value">{metrics.cesiumPrimitives}</span>
      </div>

      <div className="performance-row">
        <span className="performance-label"> Tiles:</span>
        <span className="performance-value">
          {metrics.cesiumTilesLoaded} loaded
          {metrics.cesiumTilesLoading > 0 && (
            <span style={{ color: '#ff0' }}> +{metrics.cesiumTilesLoading} loading</span>
          )}
        </span>
      </div>

      {metrics.gpuRenderer && (
        <div className="performance-footer" style={{ wordBreak: 'break-word' }}>
          {metrics.gpuRenderer}
        </div>
      )}

      <div className="performance-footer">Target: 60 FPS (16.67ms interval)</div>
    </div>
  )
}
