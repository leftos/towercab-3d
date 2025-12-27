/**
 * Touch Input Hook for Camera Controls
 *
 * Implements touch gestures for camera manipulation on touch devices (iPad, etc.).
 * Uses Cesium's ScreenSpaceEventHandler for reliable touch event handling.
 *
 * ## Touch Gestures
 *
 * ### Single-finger drag
 * - **3D/Tower view**: Rotate camera (heading/pitch)
 * - **Top-down view**: Pan the map
 * - **Orbit follow mode**: Rotate orbit (heading/pitch)
 *
 * ### Two-finger pinch
 * - **3D/Tower view**: Zoom (FOV adjustment)
 * - **Top-down view**: Altitude adjustment
 * - **Tower follow mode**: Follow zoom adjustment
 * - **Orbit follow mode**: Orbit distance adjustment
 *
 * ### Two-finger rotate (twist)
 * - Rotates heading in all view modes
 *
 * @see useCameraInput - Main input hook that integrates this
 */

import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useViewportStore } from '../stores/viewportStore'
import { useSettingsStore } from '../stores/settingsStore'
import { isTouchDevice } from '../utils/deviceDetection'

interface UseTouchInputOptions {
  /** Callback when user manually breaks out of tower follow mode */
  onBreakTowerFollow?: () => void
}

interface PinchState {
  /** Is a two-finger gesture in progress */
  isPinching: boolean
}

/**
 * Cesium's PINCH_MOVE callback receives this custom format,
 * NOT the documented TwoPointMotionEvent type.
 * See: packages/engine/Source/Core/ScreenSpaceEventHandler.js
 */
interface CesiumPinchMoveEvent {
  /** Distance info: startPosition.y = prev distance, endPosition.y = curr distance (scaled ×0.25) */
  distance: {
    startPosition: Cesium.Cartesian2
    endPosition: Cesium.Cartesian2
  }
  /** Angle/height info: x = angle (radians), y = center Y (scaled ×0.125) */
  angleAndHeight: {
    startPosition: Cesium.Cartesian2
    endPosition: Cesium.Cartesian2
  }
}

/**
 * Hook for handling touch input on camera controls
 * Uses Cesium's ScreenSpaceEventHandler for reliable event handling.
 *
 * @param viewer - The Cesium viewer instance
 * @param viewportId - The unique ID of this viewport
 * @param options - Optional configuration
 */
export function useTouchInput(
  viewer: Cesium.Viewer | null,
  viewportId: string,
  options: UseTouchInputOptions = {}
): void {
  const { onBreakTowerFollow } = options

  // Settings
  const touchSensitivity = useSettingsStore((state) => state.camera.mouseSensitivity) // Reuse mouse sensitivity for touch

  // Viewport store actions
  const setActiveViewport = useViewportStore((state) => state.setActiveViewport)
  const adjustHeading = useViewportStore((state) => state.adjustHeading)
  const adjustPitch = useViewportStore((state) => state.adjustPitch)
  const adjustFov = useViewportStore((state) => state.adjustFov)
  const adjustTopdownAltitude = useViewportStore((state) => state.adjustTopdownAltitude)
  const adjustFollowZoom = useViewportStore((state) => state.adjustFollowZoom)
  const adjustOrbitHeading = useViewportStore((state) => state.adjustOrbitHeading)
  const adjustOrbitPitch = useViewportStore((state) => state.adjustOrbitPitch)
  const adjustOrbitDistance = useViewportStore((state) => state.adjustOrbitDistance)
  const moveForward = useViewportStore((state) => state.moveForward)
  const moveRight = useViewportStore((state) => state.moveRight)
  const clearLookAtTarget = useViewportStore((state) => state.clearLookAtTarget)

  // Refs for current state (avoid stale closures)
  const viewportIdRef = useRef(viewportId)
  const touchSensitivityRef = useRef(touchSensitivity)
  const isDraggingRef = useRef(false)
  const lastPosRef = useRef({ x: 0, y: 0 })
  const pinchStateRef = useRef<PinchState>({
    isPinching: false
  })

  // Keep refs updated
  viewportIdRef.current = viewportId
  touchSensitivityRef.current = touchSensitivity

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Only enable touch input on touch-capable devices
    // This prevents conflicts with useCameraInput's mouse handling on desktop
    if (!isTouchDevice()) return

    // Use Cesium's ScreenSpaceEventHandler for reliable touch handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Get current viewport state (fresh each time)
    const getViewportState = () => {
      const state = useViewportStore.getState()
      const viewport = state.viewports.find(v => v.id === viewportIdRef.current)
      return {
        viewMode: viewport?.cameraState.viewMode ?? '3d',
        heading: viewport?.cameraState.heading ?? 0,
        topdownAltitude: viewport?.cameraState.topdownAltitude ?? 5000,
        followingCallsign: viewport?.cameraState.followingCallsign ?? null,
        followMode: viewport?.cameraState.followMode ?? 'tower',
        isActive: state.activeViewportId === viewportIdRef.current
      }
    }

    // Single-finger touch start (treated as LEFT_DOWN in Cesium)
    // Note: useCameraInput already handles LEFT_DOWN for mouse, but on touch devices
    // we need separate handling for single-finger drag (camera rotation)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      // Activate this viewport on touch
      setActiveViewport(viewportIdRef.current)

      isDraggingRef.current = true
      lastPosRef.current = { x: movement.position.x, y: movement.position.y }

      // Cancel any look-at animation
      clearLookAtTarget()

      // Break tower follow on touch drag start
      const vpState = getViewportState()
      if (vpState.followingCallsign && vpState.followMode === 'tower') {
        onBreakTowerFollow?.()
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    // Single-finger touch end
    handler.setInputAction(() => {
      isDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    // Single-finger drag (treated as MOUSE_MOVE in Cesium)
    handler.setInputAction((movement: { startPosition: Cesium.Cartesian2; endPosition: Cesium.Cartesian2 }) => {
      // Only handle if we initiated a touch drag (not a mouse drag)
      // useCameraInput handles right-click/middle-click drags
      if (!isDraggingRef.current || pinchStateRef.current.isPinching) return

      const vpState = getViewportState()
      const sensitivity = 0.3 * touchSensitivityRef.current

      const deltaX = movement.endPosition.x - lastPosRef.current.x
      const deltaY = movement.endPosition.y - lastPosRef.current.y

      if (vpState.viewMode === 'topdown') {
        // Pan in top-down view
        const panScale = vpState.topdownAltitude / 1000
        const headingRad = vpState.heading * Math.PI / 180
        const cosH = Math.cos(headingRad)
        const sinH = Math.sin(headingRad)
        // Rotate delta by heading (inverted for grab-and-drag feel)
        const worldDeltaX = -(deltaX * cosH - deltaY * sinH)
        const worldDeltaY = -(deltaX * sinH + deltaY * cosH)
        moveRight(worldDeltaX * panScale)
        moveForward(worldDeltaY * panScale)
      } else if (vpState.followingCallsign && vpState.followMode === 'orbit') {
        // Orbit mode - rotate orbit (inverted for natural touch feel)
        adjustOrbitHeading(-deltaX * sensitivity)
        adjustOrbitPitch(-deltaY * sensitivity)
      } else {
        // 3D/Tower mode - rotate camera (inverted for natural touch feel)
        adjustHeading(-deltaX * sensitivity)
        adjustPitch(deltaY * sensitivity)
      }

      lastPosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Two-finger pinch start
    // Type: TwoPointEvent = { position1: Cartesian2, position2: Cartesian2 }
    handler.setInputAction(() => {
      // Stop single-finger drag when pinch starts
      isDraggingRef.current = false
      pinchStateRef.current.isPinching = true
    }, Cesium.ScreenSpaceEventType.PINCH_START)

    // Two-finger pinch move
    // IMPORTANT: Cesium passes a custom format, NOT TwoPointMotionEvent!
    // Format: { distance: { startPosition, endPosition }, angleAndHeight: { startPosition, endPosition } }
    // distance.y values are finger distance (scaled ×0.25)
    // angleAndHeight.x values are angle in radians
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler.setInputAction((event: any) => {
      const pinchEvent = event as CesiumPinchMoveEvent
      if (!pinchStateRef.current.isPinching) return

      const vpState = getViewportState()

      // Extract distance delta from Cesium's pre-calculated values
      // Cesium scales by 0.25, so we multiply back to get pixel-like values
      const prevDistance = pinchEvent.distance.startPosition.y * 4
      const currDistance = pinchEvent.distance.endPosition.y * 4
      const pinchDelta = currDistance - prevDistance

      // Extract angle delta from Cesium's pre-calculated values (in radians)
      const prevAngle = pinchEvent.angleAndHeight.startPosition.x
      const currAngle = pinchEvent.angleAndHeight.endPosition.x
      let angleDelta = (currAngle - prevAngle) * (180 / Math.PI) // Convert to degrees

      // Handle angle wrap-around (e.g., 179 to -179)
      if (angleDelta > 180) angleDelta -= 360
      if (angleDelta < -180) angleDelta += 360

      // Apply rotation (two-finger twist)
      if (Math.abs(angleDelta) > 0.5) {
        if (vpState.followingCallsign && vpState.followMode === 'orbit') {
          adjustOrbitHeading(-angleDelta * 0.5)
        } else {
          adjustHeading(-angleDelta * 0.5)
        }
      }

      // Apply pinch zoom
      const pinchSensitivity = 0.5
      if (Math.abs(pinchDelta) > 1) {
        if (vpState.viewMode === 'topdown') {
          // Top-down: adjust altitude (pinch out = lower altitude = zoom in)
          const altitudeDelta = -pinchDelta * vpState.topdownAltitude * 0.005
          adjustTopdownAltitude(altitudeDelta)
        } else if (vpState.followingCallsign) {
          if (vpState.followMode === 'tower') {
            // Tower follow: adjust follow zoom (pinch out = zoom in = higher value)
            adjustFollowZoom(pinchDelta * pinchSensitivity * 0.02)
          } else {
            // Orbit follow: adjust distance (pinch out = closer = lower distance)
            adjustOrbitDistance(-pinchDelta * pinchSensitivity * 2)
          }
        } else {
          // 3D view: adjust FOV (pinch out = lower FOV = zoom in)
          adjustFov(-pinchDelta * pinchSensitivity * 0.3)
        }
      }
    }, Cesium.ScreenSpaceEventType.PINCH_MOVE)

    // Two-finger pinch end
    handler.setInputAction(() => {
      pinchStateRef.current.isPinching = false
    }, Cesium.ScreenSpaceEventType.PINCH_END)

    return () => {
      handler.destroy()
    }
  }, [
    viewer,
    setActiveViewport,
    adjustHeading,
    adjustPitch,
    adjustFov,
    adjustTopdownAltitude,
    adjustFollowZoom,
    adjustOrbitHeading,
    adjustOrbitPitch,
    adjustOrbitDistance,
    moveForward,
    moveRight,
    clearLookAtTarget,
    onBreakTowerFollow
  ])
}

// Re-export isTouchDevice for convenience
export { isTouchDevice } from '../utils/deviceDetection'
