/**
 * Touch Input Hook for Camera Controls
 *
 * Implements touch gestures for camera manipulation on touch devices (iPad, etc.).
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
import {
  PITCH_MIN,
  PITCH_MAX,
  FOV_MIN,
  FOV_MAX,
  ORBIT_PITCH_MIN,
  ORBIT_PITCH_MAX,
  ORBIT_DISTANCE_MIN,
  ORBIT_DISTANCE_MAX,
  TOPDOWN_ALTITUDE_MIN,
  TOPDOWN_ALTITUDE_MAX,
  FOLLOW_ZOOM_MIN,
  FOLLOW_ZOOM_MAX
} from '../constants'

interface UseTouchInputOptions {
  /** Callback when user manually breaks out of tower follow mode */
  onBreakTowerFollow?: () => void
}

interface TouchState {
  /** Is a single-finger drag in progress */
  isDragging: boolean
  /** Is a two-finger gesture in progress */
  isPinching: boolean
  /** Last single-finger position */
  lastPos: { x: number; y: number }
  /** Starting distance between two fingers (for pinch) */
  initialPinchDistance: number
  /** Starting angle between two fingers (for rotation) */
  initialPinchAngle: number
  /** Last pinch distance (for continuous pinch tracking) */
  lastPinchDistance: number
  /** Last pinch angle (for continuous rotation tracking) */
  lastPinchAngle: number
  /** Center point of pinch gesture */
  pinchCenter: { x: number; y: number }
}

/**
 * Calculate distance between two touch points
 */
function getTouchDistance(touch1: Touch, touch2: Touch): number {
  const dx = touch2.clientX - touch1.clientX
  const dy = touch2.clientY - touch1.clientY
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Calculate angle between two touch points (in degrees)
 */
function getTouchAngle(touch1: Touch, touch2: Touch): number {
  const dx = touch2.clientX - touch1.clientX
  const dy = touch2.clientY - touch1.clientY
  return Math.atan2(dy, dx) * (180 / Math.PI)
}

/**
 * Calculate center point between two touches
 */
function getTouchCenter(touch1: Touch, touch2: Touch): { x: number; y: number } {
  return {
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2
  }
}

/**
 * Hook for handling touch input on camera controls
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

  // Touch state ref
  const touchStateRef = useRef<TouchState>({
    isDragging: false,
    isPinching: false,
    lastPos: { x: 0, y: 0 },
    initialPinchDistance: 0,
    initialPinchAngle: 0,
    lastPinchDistance: 0,
    lastPinchAngle: 0,
    pinchCenter: { x: 0, y: 0 }
  })

  // Refs for current state (avoid stale closures)
  const viewportIdRef = useRef(viewportId)
  const touchSensitivityRef = useRef(touchSensitivity)

  // Keep refs updated
  viewportIdRef.current = viewportId
  touchSensitivityRef.current = touchSensitivity

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const canvas = viewer.canvas

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

    const handleTouchStart = (event: TouchEvent) => {
      event.preventDefault()

      // Activate this viewport on touch
      setActiveViewport(viewportIdRef.current)

      const touches = event.touches
      const state = touchStateRef.current

      if (touches.length === 1) {
        // Single finger - start drag
        state.isDragging = true
        state.isPinching = false
        state.lastPos = { x: touches[0].clientX, y: touches[0].clientY }

        // Cancel any look-at animation
        clearLookAtTarget()

        // Break tower follow on touch drag start
        const vpState = getViewportState()
        if (vpState.followingCallsign && vpState.followMode === 'tower') {
          onBreakTowerFollow?.()
        }
      } else if (touches.length === 2) {
        // Two fingers - start pinch/rotate
        state.isDragging = false
        state.isPinching = true
        state.initialPinchDistance = getTouchDistance(touches[0], touches[1])
        state.lastPinchDistance = state.initialPinchDistance
        state.initialPinchAngle = getTouchAngle(touches[0], touches[1])
        state.lastPinchAngle = state.initialPinchAngle
        state.pinchCenter = getTouchCenter(touches[0], touches[1])
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      event.preventDefault()

      const touches = event.touches
      const state = touchStateRef.current
      const vpState = getViewportState()

      // Base sensitivity scaled by user setting
      const sensitivity = 0.3 * touchSensitivityRef.current

      if (state.isDragging && touches.length === 1) {
        // Single finger drag
        const touch = touches[0]
        const deltaX = touch.clientX - state.lastPos.x
        const deltaY = touch.clientY - state.lastPos.y

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
          // Orbit mode - rotate orbit
          adjustOrbitHeading(deltaX * sensitivity)
          adjustOrbitPitch(deltaY * sensitivity)
        } else {
          // 3D/Tower mode - rotate camera
          adjustHeading(deltaX * sensitivity)
          adjustPitch(-deltaY * sensitivity)
        }

        state.lastPos = { x: touch.clientX, y: touch.clientY }
      } else if (state.isPinching && touches.length === 2) {
        // Two finger pinch/rotate
        const currentDistance = getTouchDistance(touches[0], touches[1])
        const currentAngle = getTouchAngle(touches[0], touches[1])

        // Calculate deltas from last position (not initial - for continuous tracking)
        const pinchDelta = currentDistance - state.lastPinchDistance
        const angleDelta = currentAngle - state.lastPinchAngle

        // Handle angle wrap-around (e.g., 179 to -179)
        let normalizedAngleDelta = angleDelta
        if (normalizedAngleDelta > 180) normalizedAngleDelta -= 360
        if (normalizedAngleDelta < -180) normalizedAngleDelta += 360

        // Apply rotation (two-finger twist)
        if (Math.abs(normalizedAngleDelta) > 0.5) {
          if (vpState.followingCallsign && vpState.followMode === 'orbit') {
            adjustOrbitHeading(-normalizedAngleDelta * 0.5)
          } else {
            adjustHeading(-normalizedAngleDelta * 0.5)
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

        state.lastPinchDistance = currentDistance
        state.lastPinchAngle = currentAngle
        state.pinchCenter = getTouchCenter(touches[0], touches[1])
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      event.preventDefault()

      const touches = event.touches
      const state = touchStateRef.current

      if (touches.length === 0) {
        // All fingers lifted
        state.isDragging = false
        state.isPinching = false
      } else if (touches.length === 1) {
        // Went from 2 fingers to 1 - transition to drag
        state.isDragging = true
        state.isPinching = false
        state.lastPos = { x: touches[0].clientX, y: touches[0].clientY }
      }
    }

    const handleTouchCancel = (event: TouchEvent) => {
      event.preventDefault()
      const state = touchStateRef.current
      state.isDragging = false
      state.isPinching = false
    }

    // Add touch event listeners with passive: false to allow preventDefault
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false })
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false })
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false })
    canvas.addEventListener('touchcancel', handleTouchCancel, { passive: false })

    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart)
      canvas.removeEventListener('touchmove', handleTouchMove)
      canvas.removeEventListener('touchend', handleTouchEnd)
      canvas.removeEventListener('touchcancel', handleTouchCancel)
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
