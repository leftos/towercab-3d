import { useCallback, useEffect, useRef, useMemo } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../stores/airportStore'
import { useViewportStore } from '../stores/viewportStore'
import { getTowerPosition } from '../utils/towerHeight'
import {
  calculateOrbitCameraPosition,
  calculateTowerLookAt,
  calculateFollowFov,
  applyPositionOffsets,
  feetToMeters,
  calculateHorizontalDistance
} from '../utils/cameraGeometry'
import { CAMERA_MIN_AGL, AIRPORT_FLYTO_DURATION } from '../constants/camera'
import { useCameraInput } from './useCameraInput'
import type { InterpolatedAircraftState } from '../types/vatsim'

interface CameraControls {
  resetView: () => void
  followAircraft: (callsign: string) => void
  stopFollowing: () => void
}

/**
 * Manages Cesium camera state for a specific viewport with tower-based controls
 * and aircraft following modes.
 *
 * ## Responsibilities
 * - Synchronize Cesium camera with viewport camera state (heading, pitch, FOV)
 * - Implement tower-based camera positioning with WASD offsets
 * - Handle aircraft following modes (tower track, orbit)
 * - Manage smooth camera transitions and animations
 * - Support top-down orthographic-style view
 *
 * ## Dependencies
 * - Requires: Initialized Cesium.Viewer from useCesiumViewer
 * - Reads: viewportStore (for camera state)
 * - Reads: airportStore (for tower location)
 * - Reads: interpolatedAircraft (for follow target)
 *
 * ## Call Order
 * Must be called AFTER useCesiumViewer but BEFORE useBabylonOverlay:
 * ```typescript
 * const viewer = useCesiumViewer(...)
 * const camera = useCesiumCamera(viewer, viewportId, aircraft) // ← HERE
 * const babylon = useBabylonOverlay({ cesiumViewer: viewer, ... })
 * ```
 *
 * ## View Modes
 *
 * ### 3D Tower View (default)
 * Camera positioned at tower location, user controls heading/pitch/FOV.
 * Position offset (WASD) allows moving away from tower center.
 *
 * ### Top-Down View
 * Camera looks straight down from configurable altitude above airport.
 * Simulates orthographic projection (small FOV at high altitude).
 * Toggle with 'T' key.
 *
 * ## Follow Modes
 *
 * ### Tower Mode
 * - Camera stays at tower position
 * - Rotates to track aircraft
 * - Zoom (FOV) adjusts to keep aircraft in view
 * - Smooth transitions using linear interpolation
 *
 * ### Orbit Mode
 * - Camera orbits around aircraft at fixed distance
 * - User controls orbit heading and pitch
 * - Distance configurable (50-5000m)
 * - Aircraft stays centered in view
 *
 * ## State Transitions
 * ```
 * NOT_FOLLOWING
 *   → followAircraft() → ANIMATING_TO_FOLLOW
 *   → (animation complete) → FOLLOWING
 *
 * FOLLOWING
 *   → stopFollowing(restore=true) → ANIMATING_TO_RESTORE
 *   → (animation complete) → NOT_FOLLOWING (at saved position)
 *
 * FOLLOWING
 *   → stopFollowing(restore=false) → NOT_FOLLOWING (at current position)
 * ```
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param viewportId - Unique identifier for this viewport
 * @param interpolatedAircraft - Map of smoothly interpolated aircraft positions (60 Hz updates)
 *
 * @returns Camera control functions
 *
 * @example
 * // Basic setup
 * const viewer = useCesiumViewer(containerRef)
 * const { interpolatedAircraft } = useAircraftInterpolation()
 * const camera = useCesiumCamera(viewer, 'main', interpolatedAircraft)
 *
 * @example
 * // Follow an aircraft in tower mode
 * camera.followAircraft('AAL123')
 *
 * // Later, stop following and restore previous view
 * camera.stopFollowing()
 *
 * @example
 * // Reset camera to default position
 * camera.resetView()
 *
 * @see viewportStore - for camera state persistence
 * @see docs/coordinate-systems.md - for position calculations
 * @see docs/architecture.md - for hook call order
 */
export function useCesiumCamera(
  viewer: Cesium.Viewer | null,
  viewportId: string,
  interpolatedAircraft?: Map<string, InterpolatedAircraftState>
): CameraControls {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Viewport store - find this viewport's camera state
  const viewports = useViewportStore((state) => state.viewports)
  const thisViewport = useMemo(
    () => viewports.find(v => v.id === viewportId),
    [viewports, viewportId]
  )
  const cameraState = thisViewport?.cameraState

  // Camera state values (from this viewport)
  const viewMode = cameraState?.viewMode ?? '3d'
  const heading = cameraState?.heading ?? 0
  const pitch = cameraState?.pitch ?? -15
  const fov = cameraState?.fov ?? 60
  const positionOffsetX = cameraState?.positionOffsetX ?? 0
  const positionOffsetY = cameraState?.positionOffsetY ?? 0
  const positionOffsetZ = cameraState?.positionOffsetZ ?? 0
  const topdownAltitude = cameraState?.topdownAltitude ?? 5000
  const followingCallsign = cameraState?.followingCallsign ?? null
  const followZoom = cameraState?.followZoom ?? 1
  const followMode = cameraState?.followMode ?? 'tower'
  const orbitDistance = cameraState?.orbitDistance ?? 500
  const orbitHeading = cameraState?.orbitHeading ?? 0
  const orbitPitch = cameraState?.orbitPitch ?? -20

  // Viewport store - actions (these operate on this specific viewport when called from preRender,
  // but we'll use setState directly for the preRender callback to avoid activeViewport routing)
  const setHeading = useViewportStore((state) => state.setHeading)
  const setPitch = useViewportStore((state) => state.setPitch)
  const resetViewStore = useViewportStore((state) => state.resetView)
  const followAircraftStore = useViewportStore((state) => state.followAircraft)
  const stopFollowingStore = useViewportStore((state) => state.stopFollowing)
  const clearPreFollowState = useViewportStore((state) => state.clearPreFollowState)

  // Track whether heading/pitch updates came from internal calculations
  const internalUpdateRef = useRef(false)
  // Track the previous airport to detect airport switches
  const previousAirportRef = useRef<string | null>(null)
  // Flag to indicate we're in the middle of a flyTo animation
  const isFlyingToAirportRef = useRef(false)
  // Track previous following state to detect follow start/end
  const previousFollowingRef = useRef<string | null>(null)
  // Flag to indicate we're animating to follow target
  const isAnimatingToFollowRef = useRef(false)
  // Track previous heading/pitch for detecting restoration animation
  const prevHeadingRef = useRef(heading)
  const prevPitchRef = useRef(pitch)

  // FOV animation state (Cesium flyTo doesn't animate FOV, so we do it manually)
  const fovAnimationRef = useRef<{
    startFov: number
    targetFov: number
    startTime: number
    duration: number
  } | null>(null)

  // Wrapper functions to mark heading/pitch updates as internal (from calculations)
  // This prevents infinite loops when the main effect depends on heading/pitch
  const setHeadingInternal = useCallback((value: number) => {
    internalUpdateRef.current = true
    setHeading(value)
    queueMicrotask(() => { internalUpdateRef.current = false })
  }, [setHeading])

  const setPitchInternal = useCallback((value: number) => {
    internalUpdateRef.current = true
    setPitch(value)
    queueMicrotask(() => { internalUpdateRef.current = false })
  }, [setPitch])

  // Callback for when user breaks out of tower follow mode via input
  const handleBreakTowerFollow = useCallback(() => {
    clearPreFollowState()
    stopFollowingStore(false)
  }, [clearPreFollowState, stopFollowingStore])

  // Use camera input hook for keyboard/mouse handling
  useCameraInput(viewer, viewportId, { onBreakTowerFollow: handleBreakTowerFollow })

  // Get tower position (3D) and custom 2D center position
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)
  const custom2dPosition = useAirportStore((state) => state.custom2dPosition)
  const getTowerPos = useCallback(() => {
    if (!currentAirport) return null
    return getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
  }, [currentAirport, towerHeight, customTowerPosition])

  /**
   * Clamp position to ensure camera stays above terrain
   * @param position Position with latitude, longitude, height (ellipsoid height)
   * @returns Position with height clamped to minimum AGL above terrain
   */
  const clampToTerrain = useCallback((
    position: { latitude: number; longitude: number; height: number }
  ): { latitude: number; longitude: number; height: number } => {
    if (!viewer || viewer.isDestroyed()) return position

    // Get terrain height at camera position
    const cartographic = Cesium.Cartographic.fromDegrees(position.longitude, position.latitude)
    const terrainHeight = viewer.scene.globe.getHeight(cartographic)

    // If terrain hasn't loaded yet, use 0 as fallback
    const groundHeight = terrainHeight ?? 0
    const minHeight = groundHeight + CAMERA_MIN_AGL

    // Clamp if below minimum
    if (position.height < minHeight) {
      return { ...position, height: minHeight }
    }

    return position
  }, [viewer])

  // Reset view
  const resetView = useCallback(() => {
    resetViewStore()
  }, [resetViewStore])

  // Follow aircraft
  const followAircraft = useCallback((callsign: string) => {
    followAircraftStore(callsign)
  }, [followAircraftStore])

  // Stop following
  const stopFollowing = useCallback(() => {
    stopFollowingStore()
  }, [stopFollowingStore])

  // Disable Cesium's default camera controls
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const controller = viewer.scene.screenSpaceCameraController
    controller.enableRotate = false
    controller.enableTranslate = false
    controller.enableZoom = false
    controller.enableTilt = false
    controller.enableLook = false
  }, [viewer])

  // Store interpolatedAircraft in a ref for access in render callbacks
  const interpolatedAircraftRef = useRef(interpolatedAircraft)
  interpolatedAircraftRef.current = interpolatedAircraft

  // Sync store with camera on every render frame during animations and following
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const onPreRender = () => {
      // Handle camera following every frame (needed because interpolated positions update every frame)
      // Get this viewport's camera state from the store
      const storeState = useViewportStore.getState()
      const thisVp = storeState.viewports.find(v => v.id === viewportId)
      if (!thisVp) return
      const state = thisVp.cameraState
      const currentInterpolatedAircraft = interpolatedAircraftRef.current

      // Helper to update this viewport's camera state directly
      const updateCameraState = (updates: Partial<typeof state>) => {
        useViewportStore.setState((prev) => {
          const viewportsCopy = [...prev.viewports]
          const idx = viewportsCopy.findIndex(v => v.id === viewportId)
          if (idx === -1) return prev
          viewportsCopy[idx] = {
            ...viewportsCopy[idx],
            cameraState: { ...viewportsCopy[idx].cameraState, ...updates }
          }
          return { viewports: viewportsCopy }
        })
      }

      // Skip if animating (let the animation complete)
      if (isAnimatingToFollowRef.current || isFlyingToAirportRef.current) {
        // Handle FOV animation during flyTo
        const fovAnim = fovAnimationRef.current
        if (fovAnim && viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
          const elapsed = (Date.now() - fovAnim.startTime) / 1000
          const t = Math.min(1, elapsed / fovAnim.duration)
          const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const currentFov = fovAnim.startFov + (fovAnim.targetFov - fovAnim.startFov) * eased
          viewer.camera.frustum.fov = Cesium.Math.toRadians(currentFov)
          if (t >= 1) {
            fovAnimationRef.current = null
          }
        }

        // Sync heading/pitch to store during animation
        const cameraHeading = Cesium.Math.toDegrees(viewer.camera.heading)
        const cameraPitch = Cesium.Math.toDegrees(viewer.camera.pitch)
        const normalizedHeading = ((cameraHeading % 360) + 360) % 360
        if (Math.abs(normalizedHeading - state.heading) > 0.5 || Math.abs(cameraPitch - state.pitch) > 0.5) {
          updateCameraState({
            heading: normalizedHeading,
            pitch: cameraPitch
          })
        }
        return
      }

      if (state.followingCallsign && currentInterpolatedAircraft) {
        const aircraft = currentInterpolatedAircraft.get(state.followingCallsign)
        if (!aircraft) return

        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const aircraftHeading = aircraft.interpolatedHeading
        const altitudeMeters = aircraft.interpolatedAltitude  // Already in METERS

        if (state.followMode === 'orbit') {
          // In top-down mode: position camera above aircraft looking straight down
          if (state.viewMode === 'topdown') {
            const airportState = useAirportStore.getState()
            const airportElevation = airportState.currentAirport?.elevation
              ? feetToMeters(airportState.currentAirport.elevation)
              : 0

            const cameraPosition = Cesium.Cartesian3.fromDegrees(
              aircraftLon,
              aircraftLat,
              airportElevation + state.topdownAltitude
            )

            viewer.camera.setView({
              destination: cameraPosition,
              orientation: {
                heading: Cesium.Math.toRadians(state.heading),
                pitch: Cesium.Math.toRadians(-90),
                roll: 0
              }
            })

            if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
              viewer.camera.frustum.fov = Cesium.Math.toRadians(60)
            }
            // Skip normal 3D orbit positioning - we're in top-down mode
          } else {
            // ORBIT MODE (3D): Camera orbits around aircraft
            const orbitResult = calculateOrbitCameraPosition(
              aircraftLat,
              aircraftLon,
              altitudeMeters,
              aircraftHeading,
              state.orbitHeading,
              state.orbitPitch,
              state.orbitDistance
            )

            // Clamp orbit camera to terrain to prevent ground clipping
            const orbitCartographic = Cesium.Cartographic.fromDegrees(
              orbitResult.cameraLon,
              orbitResult.cameraLat
            )
            const orbitTerrainHeight = viewer.scene.globe.getHeight(orbitCartographic) ?? 0
            const orbitMinHeight = orbitTerrainHeight + CAMERA_MIN_AGL
            const clampedOrbitHeight = Math.max(orbitResult.cameraHeight, orbitMinHeight)
            const wasOrbitClamped = clampedOrbitHeight > orbitResult.cameraHeight

            // Recalculate pitch if height was clamped (camera is now higher than intended)
            let finalPitch = orbitResult.pitch
            let effectiveOrbitPitch = state.orbitPitch
            if (wasOrbitClamped) {
              // Recalculate pitch to still look at aircraft from clamped position
              const horizontalDist = calculateHorizontalDistance(
                orbitResult.cameraLat,
                orbitResult.cameraLon,
                aircraftLat,
                aircraftLon
              )
              const altDiff = altitudeMeters - clampedOrbitHeight
              finalPitch = Math.atan2(altDiff, horizontalDist) * 180 / Math.PI

              // Calculate what orbitPitch corresponds to the clamped height
              // orbitPitch = asin((cameraHeight - aircraftAlt) / orbitDistance)
              const heightDiff = clampedOrbitHeight - altitudeMeters
              const clampedRatio = Math.max(-1, Math.min(1, heightDiff / state.orbitDistance))
              effectiveOrbitPitch = Math.asin(clampedRatio) * 180 / Math.PI
            }

            // Set camera position directly (no smoothing)
            const targetFov = calculateFollowFov(60, state.followZoom)

            const cameraPosition = Cesium.Cartesian3.fromDegrees(
              orbitResult.cameraLon,
              orbitResult.cameraLat,
              clampedOrbitHeight
            )
            viewer.camera.setView({
              destination: cameraPosition,
              orientation: {
                heading: Cesium.Math.toRadians(orbitResult.heading),
                pitch: Cesium.Math.toRadians(finalPitch),
                roll: 0
              }
            })

            // Set FOV
            if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
              viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
            }

            // Update store with calculated values
            // Update heading/pitch for UI display, and orbitPitch if terrain-clamped
            const updates: Partial<typeof state> = {}
            if (Math.abs(orbitResult.heading - state.heading) > 0.1) {
              updates.heading = orbitResult.heading
            }
            if (Math.abs(finalPitch - state.pitch) > 0.1) {
              updates.pitch = finalPitch
            }
            // When terrain-clamped, update orbitPitch to reflect effective value
            // This prevents the camera from "snapping" when the constraint is released
            if (wasOrbitClamped && Math.abs(effectiveOrbitPitch - state.orbitPitch) > 0.5) {
              updates.orbitPitch = effectiveOrbitPitch
            }
            if (Object.keys(updates).length > 0) {
              updateCameraState(updates)
            }
          }
        } else if (state.followMode === 'tower' && state.viewMode === '3d') {
          // TOWER MODE: Camera stays at tower, rotates to look at aircraft
          const airportState = useAirportStore.getState()
          if (!airportState.currentAirport) return

          const towerPos = getTowerPosition(airportState.currentAirport, airportState.towerHeight, airportState.customTowerPosition ?? undefined)
          const offsetPos = applyPositionOffsets(
            { latitude: towerPos.latitude, longitude: towerPos.longitude, height: towerPos.height },
            { x: state.positionOffsetX, y: state.positionOffsetY, z: state.positionOffsetZ }
          )

          // Clamp to terrain
          const cartographic = Cesium.Cartographic.fromDegrees(offsetPos.longitude, offsetPos.latitude)
          const terrainHeight = viewer.scene.globe.getHeight(cartographic) ?? 0
          const minHeight = terrainHeight + CAMERA_MIN_AGL
          const clampedHeight = Math.max(offsetPos.height, minHeight)

          // Calculate bearing and pitch to aircraft
          const lookAt = calculateTowerLookAt(
            offsetPos.latitude,
            offsetPos.longitude,
            clampedHeight,
            aircraftLat,
            aircraftLon,
            altitudeMeters
          )

          const targetFov = calculateFollowFov(60, state.followZoom)

          // Set camera position and orientation
          const cameraPosition = Cesium.Cartesian3.fromDegrees(offsetPos.longitude, offsetPos.latitude, clampedHeight)
          viewer.camera.setView({
            destination: cameraPosition,
            orientation: {
              heading: Cesium.Math.toRadians(lookAt.heading),
              pitch: Cesium.Math.toRadians(lookAt.pitch),
              roll: 0
            }
          })

          // Set FOV
          if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
            viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
          }

          // Update store with calculated values (for UI display) - but only if changed
          if (Math.abs(lookAt.heading - state.heading) > 0.1 || Math.abs(lookAt.pitch - state.pitch) > 0.1) {
            updateCameraState({
              heading: lookAt.heading,
              pitch: lookAt.pitch
            })
          }
        }
      }
    }

    viewer.scene.preRender.addEventListener(onPreRender)
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(onPreRender)
      }
    }
  }, [viewer, viewportId])

  // Update camera position and orientation
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Skip if this effect run was triggered by our own internal updates
    if (internalUpdateRef.current) return

    const towerPos = getTowerPos()
    const currentIcao = currentAirport?.icao ?? null

    // Detect airport switch
    const isAirportSwitch = currentIcao !== null &&
      previousAirportRef.current !== null &&
      previousAirportRef.current !== currentIcao

    // Update the ref for next comparison
    previousAirportRef.current = currentIcao

    // Skip camera updates while flying to new airport or animating to follow target
    // (preRender event handler syncs the store during animations)
    if (isFlyingToAirportRef.current || isAnimatingToFollowRef.current) {
      return
    }

    // Detect start of following (transition from not following to following)
    const isStartingToFollow = followingCallsign !== null &&
      previousFollowingRef.current === null &&
      followMode === 'tower'

    // Detect end of following with camera restoration (heading/pitch changed significantly)
    const isEndingFollow = followingCallsign === null &&
      previousFollowingRef.current !== null &&
      (Math.abs(heading - prevHeadingRef.current) > 1 || Math.abs(pitch - prevPitchRef.current) > 1)

    previousFollowingRef.current = followingCallsign
    prevHeadingRef.current = heading
    prevPitchRef.current = pitch

    // Orbit mode following is handled entirely by preRender for smooth updates
    // This effect only needs to early-return to avoid conflicting camera updates
    if (followingCallsign && followMode === 'orbit') {
      // preRender handler manages camera position during active orbit following
      return
    }

    // For all other modes, we need a tower position
    if (!towerPos) return

    // Apply position offsets
    const offsetPos = applyPositionOffsets(
      { latitude: towerPos.latitude, longitude: towerPos.longitude, height: towerPos.height },
      { x: positionOffsetX, y: positionOffsetY, z: positionOffsetZ }
    )

    // Animate smoothly when restoring camera after unfollowing
    if (isEndingFollow && viewMode === '3d') {
      isAnimatingToFollowRef.current = true
      const clampedRestorePos = clampToTerrain(offsetPos)
      const cameraPosition = Cesium.Cartesian3.fromDegrees(clampedRestorePos.longitude, clampedRestorePos.latitude, clampedRestorePos.height)
      const animDuration = 0.5

      // Start FOV animation (Cesium flyTo doesn't animate FOV)
      const currentFov = viewer.camera.frustum instanceof Cesium.PerspectiveFrustum && viewer.camera.frustum.fov !== undefined
        ? Cesium.Math.toDegrees(viewer.camera.frustum.fov)
        : 60
      fovAnimationRef.current = {
        startFov: currentFov,
        targetFov: fov,
        startTime: Date.now(),
        duration: animDuration
      }

      viewer.camera.flyTo({
        destination: cameraPosition,
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(pitch),
          roll: 0
        },
        duration: animDuration,
        complete: () => {
          isAnimatingToFollowRef.current = false
          fovAnimationRef.current = null
          if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
            viewer.camera.frustum.fov = Cesium.Math.toRadians(fov)
          }
        },
        cancel: () => {
          isAnimatingToFollowRef.current = false
          fovAnimationRef.current = null
        }
      })
      return
    }

    // Handle different view modes
    if (viewMode === 'topdown') {
      // Top-down view: camera above looking straight down
      const airportElevation = currentAirport?.elevation ? feetToMeters(currentAirport.elevation) : 0

      // Determine camera center point - follow aircraft if active, otherwise use 2D position or tower/offset
      // Priority: following aircraft > custom 2D position > tower position with offsets
      let centerLat: number
      let centerLon: number

      if (followingCallsign && interpolatedAircraft) {
        const aircraft = interpolatedAircraft.get(followingCallsign)
        if (aircraft) {
          // Center on followed aircraft, with position offset applied
          const aircraftOffsetPos = applyPositionOffsets(
            { latitude: aircraft.interpolatedLatitude, longitude: aircraft.interpolatedLongitude, height: 0 },
            { x: positionOffsetX, y: positionOffsetY, z: 0 }
          )
          centerLat = aircraftOffsetPos.latitude
          centerLon = aircraftOffsetPos.longitude
        } else {
          // Aircraft not found, fall back to 2D position or tower
          if (custom2dPosition?.lat !== undefined && custom2dPosition?.lon !== undefined) {
            const pos2dOffset = applyPositionOffsets(
              { latitude: custom2dPosition.lat, longitude: custom2dPosition.lon, height: 0 },
              { x: positionOffsetX, y: positionOffsetY, z: 0 }
            )
            centerLat = pos2dOffset.latitude
            centerLon = pos2dOffset.longitude
          } else {
            centerLat = offsetPos.latitude
            centerLon = offsetPos.longitude
          }
        }
      } else if (custom2dPosition?.lat !== undefined && custom2dPosition?.lon !== undefined) {
        // Use custom 2D center position if defined, with position offsets applied
        const pos2dOffset = applyPositionOffsets(
          { latitude: custom2dPosition.lat, longitude: custom2dPosition.lon, height: 0 },
          { x: positionOffsetX, y: positionOffsetY, z: 0 }
        )
        centerLat = pos2dOffset.latitude
        centerLon = pos2dOffset.longitude
      } else {
        // Fall back to tower position with offsets
        centerLat = offsetPos.latitude
        centerLon = offsetPos.longitude
      }

      const cameraPosition = Cesium.Cartesian3.fromDegrees(
        centerLon,
        centerLat,
        airportElevation + topdownAltitude
      )

      // Use flyTo for airport switches to allow terrain tiles to load progressively
      if (isAirportSwitch) {
        isFlyingToAirportRef.current = true
        viewer.camera.flyTo({
          destination: cameraPosition,
          orientation: {
            heading: Cesium.Math.toRadians(heading),
            pitch: Cesium.Math.toRadians(-90),
            roll: 0
          },
          duration: AIRPORT_FLYTO_DURATION,
          complete: () => {
            isFlyingToAirportRef.current = false
            if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
              viewer.camera.frustum.fov = Cesium.Math.toRadians(60)
            }
          },
          cancel: () => {
            isFlyingToAirportRef.current = false
          }
        })
        return
      }

      viewer.camera.setView({
        destination: cameraPosition,
        orientation: {
          heading: Cesium.Math.toRadians(heading),
          pitch: Cesium.Math.toRadians(-90), // Look straight down
          roll: 0
        }
      })

      // Wider FOV for top-down view
      if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
        viewer.camera.frustum.fov = Cesium.Math.toRadians(60)
      }
      return
    }

    // 3D tower view mode - clamp to terrain
    const clampedPos = clampToTerrain(offsetPos)
    let targetHeading = heading
    let targetPitch = pitch
    let targetFov = fov
    const cameraLat = clampedPos.latitude
    const cameraLon = clampedPos.longitude
    const cameraHeight = clampedPos.height

    // If following an aircraft in tower mode
    if (followingCallsign && followMode === 'tower' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const altitudeMeters = aircraft.interpolatedAltitude  // Already in METERS

        // TOWER MODE: Camera stays at tower, rotates to look at aircraft
        const lookAt = calculateTowerLookAt(
          clampedPos.latitude,
          clampedPos.longitude,
          clampedPos.height,
          aircraftLat,
          aircraftLon,
          altitudeMeters
        )

        targetHeading = lookAt.heading
        targetPitch = lookAt.pitch

        // Apply follow zoom to FOV
        targetFov = calculateFollowFov(60, followZoom)

        // If just starting to follow, animate smoothly to target
        if (isStartingToFollow) {
          isAnimatingToFollowRef.current = true
          const cameraPosition = Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, cameraHeight)
          const animDuration = 0.5

          // Start FOV animation (Cesium flyTo doesn't animate FOV)
          const currentFov = viewer.camera.frustum instanceof Cesium.PerspectiveFrustum && viewer.camera.frustum.fov !== undefined
            ? Cesium.Math.toDegrees(viewer.camera.frustum.fov)
            : 60
          fovAnimationRef.current = {
            startFov: currentFov,
            targetFov: targetFov,
            startTime: Date.now(),
            duration: animDuration
          }

          viewer.camera.flyTo({
            destination: cameraPosition,
            orientation: {
              heading: Cesium.Math.toRadians(lookAt.heading),
              pitch: Cesium.Math.toRadians(lookAt.pitch),
              roll: 0
            },
            duration: animDuration,
            complete: () => {
              isAnimatingToFollowRef.current = false
              fovAnimationRef.current = null
              setHeadingInternal(lookAt.heading)
              setPitchInternal(lookAt.pitch)
              if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
                viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
              }
            },
            cancel: () => {
              isAnimatingToFollowRef.current = false
              fovAnimationRef.current = null
            }
          })
          return
        }

        // preRender handler manages camera position during active tower following
        // Only the animation on start (above) is handled here
        return
      }
      // If aircraft not found, don't stop following immediately - it may appear
      // after the next animation frame. The preRender handler keeps checking.
      return
    }

    // Set camera position and orientation
    const cameraPosition = Cesium.Cartesian3.fromDegrees(
      cameraLon,
      cameraLat,
      cameraHeight
    )

    // Use flyTo for airport switches to allow terrain tiles to load progressively
    if (isAirportSwitch) {
      isFlyingToAirportRef.current = true
      viewer.camera.flyTo({
        destination: cameraPosition,
        orientation: {
          heading: Cesium.Math.toRadians(targetHeading),
          pitch: Cesium.Math.toRadians(targetPitch),
          roll: 0
        },
        duration: AIRPORT_FLYTO_DURATION,
        complete: () => {
          isFlyingToAirportRef.current = false
          // Set FOV after flight completes
          if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
            viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
          }
        },
        cancel: () => {
          isFlyingToAirportRef.current = false
        }
      })
      return
    }

    viewer.camera.setView({
      destination: cameraPosition,
      orientation: {
        heading: Cesium.Math.toRadians(targetHeading),
        pitch: Cesium.Math.toRadians(targetPitch),
        roll: 0
      }
    })

    // Set FOV
    if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
      viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
    }
  }, [
    viewer,
    getTowerPos,
    viewMode,
    heading,
    pitch,
    fov,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ,
    topdownAltitude,
    currentAirport,
    followingCallsign,
    followMode,
    followZoom,
    orbitDistance,
    orbitHeading,
    orbitPitch,
    interpolatedAircraft,
    setHeading,
    setPitch,
    setHeadingInternal,
    setPitchInternal,
    stopFollowingStore,
    clampToTerrain,
    custom2dPosition
  ])

  return {
    resetView,
    followAircraft,
    stopFollowing
  }
}

export default useCesiumCamera
