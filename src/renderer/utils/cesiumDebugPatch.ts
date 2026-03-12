/**
 * Cesium Debug Patch
 *
 * Monkey patches Cesium's Scene.render to capture debugging information
 * when crashes occur (e.g., "Invalid array length" in updateFrustums).
 *
 * This helps identify what bad camera/frustum values caused the crash.
 */

import * as Cesium from 'cesium'

interface CameraSnapshot {
  position: { x: number; y: number; z: number }
  direction: { x: number; y: number; z: number }
  up: { x: number; y: number; z: number }
  right: { x: number; y: number; z: number }
  positionCartographic: { lat: number; lon: number; height: number } | null
}

interface FrustumSnapshot {
  type: string
  near?: number
  far?: number
  fov?: number
  aspectRatio?: number
  xOffset?: number
  yOffset?: number
  // For orthographic frustums
  left?: number
  right?: number
  top?: number
  bottom?: number
}

interface DebugSnapshot {
  timestamp: string
  frameNumber: number
  camera: CameraSnapshot
  frustum: FrustumSnapshot
  canvas: { width: number; height: number }
  drawingBufferSize: { width: number; height: number } | null
  issues: string[]
}

let frameCount = 0
let lastSnapshot: DebugSnapshot | null = null
// Track which viewer instances have been patched (WeakSet allows GC of destroyed viewers)
const patchedViewers = new WeakSet<Cesium.Viewer>()

/**
 * Check if a number is invalid (NaN, Infinity, or extremely large)
 */
function isInvalidNumber(value: unknown, name: string, issues: string[]): boolean {
  if (typeof value !== 'number') return false

  if (Number.isNaN(value)) {
    issues.push(`${name} is NaN`)
    return true
  }
  if (!Number.isFinite(value)) {
    issues.push(`${name} is ${value > 0 ? '+' : '-'}Infinity`)
    return true
  }
  // Check for extremely large values that could cause array length issues
  if (Math.abs(value) > 1e15) {
    issues.push(`${name} is extremely large: ${value}`)
    return true
  }
  // Check for negative values where they shouldn't be
  if (name.includes('near') || name.includes('far') || name.includes('fov')) {
    if (value <= 0) {
      issues.push(`${name} is non-positive: ${value}`)
      return true
    }
  }
  return false
}

/**
 * Capture current camera and frustum state
 */
function captureSnapshot(scene: Cesium.Scene): DebugSnapshot {
  const issues: string[] = []
  const camera = scene.camera

  // Capture camera vectors
  const cameraSnapshot: CameraSnapshot = {
    position: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z
    },
    direction: {
      x: camera.direction.x,
      y: camera.direction.y,
      z: camera.direction.z
    },
    up: {
      x: camera.up.x,
      y: camera.up.y,
      z: camera.up.z
    },
    right: {
      x: camera.right.x,
      y: camera.right.y,
      z: camera.right.z
    },
    positionCartographic: null
  }

  // Check camera position
  isInvalidNumber(camera.position.x, 'camera.position.x', issues)
  isInvalidNumber(camera.position.y, 'camera.position.y', issues)
  isInvalidNumber(camera.position.z, 'camera.position.z', issues)
  isInvalidNumber(camera.direction.x, 'camera.direction.x', issues)
  isInvalidNumber(camera.direction.y, 'camera.direction.y', issues)
  isInvalidNumber(camera.direction.z, 'camera.direction.z', issues)
  isInvalidNumber(camera.up.x, 'camera.up.x', issues)
  isInvalidNumber(camera.up.y, 'camera.up.y', issues)
  isInvalidNumber(camera.up.z, 'camera.up.z', issues)

  // Try to get cartographic position
  try {
    const cartographic = camera.positionCartographic
    if (cartographic) {
      cameraSnapshot.positionCartographic = {
        lat: Cesium.Math.toDegrees(cartographic.latitude),
        lon: Cesium.Math.toDegrees(cartographic.longitude),
        height: cartographic.height
      }
      isInvalidNumber(cartographic.latitude, 'cartographic.latitude', issues)
      isInvalidNumber(cartographic.longitude, 'cartographic.longitude', issues)
      isInvalidNumber(cartographic.height, 'cartographic.height', issues)
    }
  } catch {
    issues.push('Failed to get positionCartographic')
  }

  // Capture frustum
  const frustum = camera.frustum
  const frustumSnapshot: FrustumSnapshot = {
    type: frustum.constructor.name
  }

  if (frustum instanceof Cesium.PerspectiveFrustum) {
    frustumSnapshot.near = frustum.near
    frustumSnapshot.far = frustum.far
    frustumSnapshot.fov = frustum.fov
    frustumSnapshot.aspectRatio = frustum.aspectRatio
    frustumSnapshot.xOffset = frustum.xOffset
    frustumSnapshot.yOffset = frustum.yOffset

    isInvalidNumber(frustum.near, 'frustum.near', issues)
    isInvalidNumber(frustum.far, 'frustum.far', issues)
    isInvalidNumber(frustum.fov, 'frustum.fov', issues)
    isInvalidNumber(frustum.aspectRatio, 'frustum.aspectRatio', issues)
    isInvalidNumber(frustum.xOffset, 'frustum.xOffset', issues)
    isInvalidNumber(frustum.yOffset, 'frustum.yOffset', issues)

    // Check for invalid relationships
    if (frustum.near !== undefined && frustum.far !== undefined) {
      if (frustum.near >= frustum.far) {
        issues.push(`frustum.near (${frustum.near}) >= frustum.far (${frustum.far})`)
      }
    }
  } else if (frustum instanceof Cesium.OrthographicFrustum) {
    frustumSnapshot.near = frustum.near
    frustumSnapshot.far = frustum.far
    // Orthographic has width instead of fov
    isInvalidNumber(frustum.near, 'frustum.near', issues)
    isInvalidNumber(frustum.far, 'frustum.far', issues)
  } else if (frustum instanceof Cesium.PerspectiveOffCenterFrustum) {
    frustumSnapshot.near = frustum.near
    frustumSnapshot.far = frustum.far
    frustumSnapshot.left = frustum.left
    frustumSnapshot.right = frustum.right
    frustumSnapshot.top = frustum.top
    frustumSnapshot.bottom = frustum.bottom

    isInvalidNumber(frustum.near, 'frustum.near', issues)
    isInvalidNumber(frustum.far, 'frustum.far', issues)
    isInvalidNumber(frustum.left, 'frustum.left', issues)
    isInvalidNumber(frustum.right, 'frustum.right', issues)
    isInvalidNumber(frustum.top, 'frustum.top', issues)
    isInvalidNumber(frustum.bottom, 'frustum.bottom', issues)
  }

  // Check canvas dimensions
  const canvas = scene.canvas
  const canvasSnapshot = {
    width: canvas.width,
    height: canvas.height
  }
  if (canvas.width <= 0 || canvas.height <= 0) {
    issues.push(`Invalid canvas dimensions: ${canvas.width}x${canvas.height}`)
  }

  // Check drawing buffer
  let drawingBufferSize: { width: number; height: number } | null = null
  try {
    const context = (scene as unknown as { context?: { drawingBufferWidth?: number; drawingBufferHeight?: number } }).context
    if (context?.drawingBufferWidth !== undefined && context?.drawingBufferHeight !== undefined) {
      drawingBufferSize = {
        width: context.drawingBufferWidth,
        height: context.drawingBufferHeight
      }
      if (context.drawingBufferWidth <= 0 || context.drawingBufferHeight <= 0) {
        issues.push(`Invalid drawing buffer: ${context.drawingBufferWidth}x${context.drawingBufferHeight}`)
      }
    }
  } catch {
    // Ignore - internal API
  }

  return {
    timestamp: new Date().toISOString(),
    frameNumber: frameCount,
    camera: cameraSnapshot,
    frustum: frustumSnapshot,
    canvas: canvasSnapshot,
    drawingBufferSize,
    issues
  }
}

/**
 * Log crash diagnostics with the captured snapshot
 */
function logCrashDiagnostics(error: unknown, snapshot: DebugSnapshot | null): void {
  console.error('[CesiumDebugPatch] RENDER CRASH DETECTED!')
  console.error('[CesiumDebugPatch] Error:', error)

  if (snapshot) {
    console.error('[CesiumDebugPatch] Last known state before crash:')
    console.error('[CesiumDebugPatch] Frame:', snapshot.frameNumber)
    console.error('[CesiumDebugPatch] Timestamp:', snapshot.timestamp)
    console.error('[CesiumDebugPatch] Camera:', JSON.stringify(snapshot.camera, null, 2))
    console.error('[CesiumDebugPatch] Frustum:', JSON.stringify(snapshot.frustum, null, 2))
    console.error('[CesiumDebugPatch] Canvas:', JSON.stringify(snapshot.canvas))
    console.error('[CesiumDebugPatch] DrawingBuffer:', JSON.stringify(snapshot.drawingBufferSize))
    console.error('[CesiumDebugPatch] Issues:', snapshot.issues)

    // Also store in window for debugging
    // biome-ignore lint/suspicious/noExplicitAny: debug window property
    ;(window as any).__cesiumCrashSnapshot = snapshot
    console.error('[CesiumDebugPatch] Snapshot saved to window.__cesiumCrashSnapshot')
  } else {
    console.error('[CesiumDebugPatch] No snapshot available (crash on first frame?)')
  }
}

/**
 * Apply the debug monkey patch to a Cesium Scene
 *
 * Call this after creating the Cesium.Viewer to enable crash diagnostics.
 *
 * NOTE: Cesium's Scene.render() has internal error handling via tryAndCatchError()
 * which catches errors and raises scene.renderError event instead of re-throwing.
 * So we must listen to renderError event to capture crash diagnostics.
 */
export function applyCesiumDebugPatch(viewer: Cesium.Viewer): void {
  // Check if THIS viewer instance has already been patched
  if (patchedViewers.has(viewer)) {
    console.warn('[CesiumDebugPatch] This viewer already patched, skipping')
    return
  }

  const scene = viewer.scene
  const originalRender = scene.render.bind(scene)

  // Listen to Cesium's renderError event - this is how Cesium reports render crashes
  // The error is caught internally by tryAndCatchError() and raised via this event
  const errorHandler = (_scene: Cesium.Scene, error: unknown) => {
    console.error('[CesiumDebugPatch] renderError event received!')
    logCrashDiagnostics(error, lastSnapshot)
  }
  scene.renderError.addEventListener(errorHandler)
  console.log('[CesiumDebugPatch] Added renderError listener, numberOfListeners:', scene.renderError.numberOfListeners)

  scene.render = function(time?: Cesium.JulianDate) {
    frameCount++

    // Capture state before render
    try {
      lastSnapshot = captureSnapshot(scene)

      // Log warning if issues detected BEFORE the crash happens
      if (lastSnapshot.issues.length > 0) {
        console.warn(
          `[CesiumDebugPatch] Frame ${frameCount} - Issues detected BEFORE render:`,
          lastSnapshot.issues
        )
        console.warn('[CesiumDebugPatch] Full snapshot:', JSON.stringify(lastSnapshot, null, 2))
      }
    } catch (e) {
      console.error('[CesiumDebugPatch] Failed to capture pre-render snapshot:', e)
    }

    // Call original render
    // Note: Cesium catches errors internally and raises renderError event,
    // so we also wrap in try/catch as a fallback for any uncaught errors
    try {
      return originalRender(time)
    } catch (error) {
      // This shouldn't normally fire since Cesium catches internally,
      // but keep as fallback
      console.error('[CesiumDebugPatch] Caught error in try/catch fallback!')
      logCrashDiagnostics(error, lastSnapshot)
      throw error
    }
  }

  patchedViewers.add(viewer)
  console.log('[CesiumDebugPatch] Debug patch applied - listening to renderError event')
}

/**
 * Get the last captured snapshot (useful for debugging)
 */
export function getLastCesiumSnapshot(): DebugSnapshot | null {
  return lastSnapshot
}

/**
 * Get current frame count
 */
export function getCesiumFrameCount(): number {
  return frameCount
}
