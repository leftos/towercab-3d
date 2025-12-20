import { useCallback, useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../stores/airportStore'
import { useCameraStore } from '../stores/cameraStore'
import { getTowerPosition } from '../utils/towerHeight'
import { calculateBearing } from '../utils/interpolation'
import type { InterpolatedAircraftState } from '../types/vatsim'

interface CameraControls {
  resetView: () => void
  followAircraft: (callsign: string) => void
  stopFollowing: () => void
}

/**
 * Hook for managing Cesium camera controls in tower view mode
 * Camera is fixed at tower position, only orientation changes
 * @param viewer - The Cesium viewer instance
 * @param interpolatedAircraft - Map of interpolated aircraft states for smooth follow tracking
 */
export function useCesiumCamera(
  viewer: Cesium.Viewer | null,
  interpolatedAircraft?: Map<string, InterpolatedAircraftState>
): CameraControls {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Camera store
  const viewMode = useCameraStore((state) => state.viewMode)
  const heading = useCameraStore((state) => state.heading)
  const pitch = useCameraStore((state) => state.pitch)
  const fov = useCameraStore((state) => state.fov)
  const positionOffsetX = useCameraStore((state) => state.positionOffsetX)
  const positionOffsetY = useCameraStore((state) => state.positionOffsetY)
  const positionOffsetZ = useCameraStore((state) => state.positionOffsetZ)
  const topdownAltitude = useCameraStore((state) => state.topdownAltitude)
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const followZoom = useCameraStore((state) => state.followZoom)
  const toggleViewMode = useCameraStore((state) => state.toggleViewMode)
  const setHeading = useCameraStore((state) => state.setHeading)
  const setPitch = useCameraStore((state) => state.setPitch)
  const adjustHeading = useCameraStore((state) => state.adjustHeading)
  const adjustPitch = useCameraStore((state) => state.adjustPitch)
  const adjustFov = useCameraStore((state) => state.adjustFov)
  const adjustTopdownAltitude = useCameraStore((state) => state.adjustTopdownAltitude)
  const adjustFollowZoom = useCameraStore((state) => state.adjustFollowZoom)
  const followMode = useCameraStore((state) => state.followMode)
  const toggleFollowMode = useCameraStore((state) => state.toggleFollowMode)
  const orbitDistance = useCameraStore((state) => state.orbitDistance)
  const orbitHeading = useCameraStore((state) => state.orbitHeading)
  const orbitPitch = useCameraStore((state) => state.orbitPitch)
  const adjustOrbitDistance = useCameraStore((state) => state.adjustOrbitDistance)
  const adjustOrbitHeading = useCameraStore((state) => state.adjustOrbitHeading)
  const adjustOrbitPitch = useCameraStore((state) => state.adjustOrbitPitch)
  const moveForward = useCameraStore((state) => state.moveForward)
  const moveRight = useCameraStore((state) => state.moveRight)
  const moveUp = useCameraStore((state) => state.moveUp)
  const resetViewStore = useCameraStore((state) => state.resetView)
  const resetPosition = useCameraStore((state) => state.resetPosition)
  const followAircraftStore = useCameraStore((state) => state.followAircraft)
  const stopFollowingStore = useCameraStore((state) => state.stopFollowing)
  const clearPreFollowState = useCameraStore((state) => state.clearPreFollowState)

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

  // Mouse drag state
  const isDraggingRef = useRef(false)
  const lastMousePosRef = useRef({ x: 0, y: 0 })

  // Smooth keyboard movement state
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const velocityRef = useRef({
    forward: 0,
    right: 0,
    up: 0,
    heading: 0,
    pitch: 0,
    zoom: 0,
    orbitHeading: 0,
    orbitPitch: 0,
    orbitDistance: 0,
    altitude: 0
  })
  const animationFrameRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef<number>(0)

  // Mouse wheel impulse for smooth scrolling
  const wheelImpulseRef = useRef(0)

  // Get tower position
  const getTowerPos = useCallback(() => {
    if (!currentAirport) return null
    return getTowerPosition(currentAirport, towerHeight)
  }, [currentAirport, towerHeight])

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

  // Sync store with camera on every render frame during animations
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const onPreRender = () => {
      // Only sync during animations
      if (!isFlyingToAirportRef.current && !isAnimatingToFollowRef.current) return

      const cameraHeading = Cesium.Math.toDegrees(viewer.camera.heading)
      const cameraPitch = Cesium.Math.toDegrees(viewer.camera.pitch)
      const normalizedHeading = ((cameraHeading % 360) + 360) % 360

      // Update store to keep labels in sync
      const state = useCameraStore.getState()
      if (Math.abs(normalizedHeading - state.heading) > 0.5 || Math.abs(cameraPitch - state.pitch) > 0.5) {
        useCameraStore.setState({
          heading: normalizedHeading,
          pitch: cameraPitch
        })
      }

      // Animate FOV manually (Cesium flyTo doesn't support FOV animation)
      const fovAnim = fovAnimationRef.current
      if (fovAnim && viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
        const elapsed = (Date.now() - fovAnim.startTime) / 1000
        const t = Math.min(1, elapsed / fovAnim.duration)
        // Use ease-in-out curve to match Cesium's flyTo easing
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        const currentFov = fovAnim.startFov + (fovAnim.targetFov - fovAnim.startFov) * eased
        viewer.camera.frustum.fov = Cesium.Math.toRadians(currentFov)

        if (t >= 1) {
          fovAnimationRef.current = null
        }
      }
    }

    viewer.scene.preRender.addEventListener(onPreRender)
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.preRender.removeEventListener(onPreRender)
      }
    }
  }, [viewer])

  // Update camera position and orientation
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

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

    // Handle orbit mode following without requiring an airport
    if (followingCallsign && followMode === 'orbit' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const aircraftAlt = aircraft.interpolatedAltitude
        const aircraftHeading = aircraft.interpolatedHeading
        const altitudeMeters = aircraftAlt * 0.3048

        // ORBIT MODE: Camera orbits around aircraft
        const absoluteOrbitAngle = aircraftHeading + 180 + orbitHeading
        const orbitAngleRad = Cesium.Math.toRadians(absoluteOrbitAngle)
        const orbitPitchRad = Cesium.Math.toRadians(orbitPitch)

        // Calculate camera position using spherical coordinates relative to aircraft
        const horizontalDistance = orbitDistance * Math.cos(orbitPitchRad)
        const verticalOffset = orbitDistance * Math.sin(orbitPitchRad)

        // Convert horizontal distance to lat/lon offset
        const metersToDegreesLatOrbit = 1 / 111111
        const metersToDegreesLonOrbit = 1 / (111111 * Math.cos(aircraftLat * Math.PI / 180))

        // Camera position: aircraft position + spherical offset
        const cameraLat = aircraftLat + horizontalDistance * Math.cos(orbitAngleRad) * metersToDegreesLatOrbit
        const cameraLon = aircraftLon + horizontalDistance * Math.sin(orbitAngleRad) * metersToDegreesLonOrbit
        let cameraHeight = altitudeMeters + verticalOffset

        // Ensure camera doesn't go below ground (minimum 10m)
        cameraHeight = Math.max(10, cameraHeight)

        // Calculate heading/pitch to look at aircraft from camera position
        const targetHeading = calculateBearing(cameraLat, cameraLon, aircraftLat, aircraftLon)

        // Calculate pitch to look at aircraft
        const latDiff = (aircraftLat - cameraLat) * 111111
        const lonDiff = (aircraftLon - cameraLon) * 111111 * Math.cos(cameraLat * Math.PI / 180)
        const distToAircraft = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)
        const altDiff = altitudeMeters - cameraHeight
        const targetPitch = Math.atan2(altDiff, distToAircraft) * 180 / Math.PI

        // Apply follow zoom to FOV
        const targetFov = Math.max(10, Math.min(120, 60 / followZoom))

        // Update store with calculated values (for UI display)
        setHeading(targetHeading)
        setPitch(targetPitch)

        // Set camera position and orientation
        const cameraPosition = Cesium.Cartesian3.fromDegrees(cameraLon, cameraLat, cameraHeight)
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
        return
      } else {
        // Aircraft no longer exists, stop following
        stopFollowingStore()
      }
    }

    // For all other modes, we need a tower position
    if (!towerPos) return

    // Apply position offsets (convert meters to degrees approximately)
    const metersToDegreesLat = 1 / 111111
    const metersToDegreesLon = 1 / (111111 * Math.cos(towerPos.latitude * Math.PI / 180))

    const offsetLat = towerPos.latitude + positionOffsetY * metersToDegreesLat
    const offsetLon = towerPos.longitude + positionOffsetX * metersToDegreesLon
    const offsetHeight = towerPos.height + positionOffsetZ

    // Animate smoothly when restoring camera after unfollowing
    if (isEndingFollow && viewMode === '3d') {
      isAnimatingToFollowRef.current = true
      const cameraPosition = Cesium.Cartesian3.fromDegrees(offsetLon, offsetLat, offsetHeight)
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
      const airportElevation = currentAirport?.elevation ? currentAirport.elevation * 0.3048 : 0

      // Determine camera center point - follow aircraft if active, otherwise use tower/offset
      let centerLat = offsetLat
      let centerLon = offsetLon

      if (followingCallsign && interpolatedAircraft) {
        const aircraft = interpolatedAircraft.get(followingCallsign)
        if (aircraft) {
          // Center on followed aircraft, with position offset applied
          centerLat = aircraft.interpolatedLatitude + positionOffsetY * metersToDegreesLat
          centerLon = aircraft.interpolatedLongitude + positionOffsetX * metersToDegreesLon
        }
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
          duration: 2.0,
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

    // 3D tower view mode
    let targetHeading = heading
    let targetPitch = pitch
    let targetFov = fov
    let cameraLat = offsetLat
    let cameraLon = offsetLon
    let cameraHeight = offsetHeight

    // If following an aircraft in tower mode
    if (followingCallsign && followMode === 'tower' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const aircraftAlt = aircraft.interpolatedAltitude
        const altitudeMeters = aircraftAlt * 0.3048

        // TOWER MODE: Camera stays at tower, rotates to look at aircraft
        // Calculate bearing to aircraft from current position
        const bearing = calculateBearing(
          offsetLat,
          offsetLon,
          aircraftLat,
          aircraftLon
        )

        // Calculate pitch based on altitude difference and distance
        const altitudeDiff = altitudeMeters - offsetHeight

        // Approximate distance in meters
        const latDiff = (aircraftLat - offsetLat) * 111111
        const lonDiff = (aircraftLon - offsetLon) *
          111111 * Math.cos(offsetLat * Math.PI / 180)
        const horizontalDistance = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)

        const pitchAngle = Math.atan2(altitudeDiff, horizontalDistance) * 180 / Math.PI

        targetHeading = bearing
        targetPitch = pitchAngle

        // Apply follow zoom to FOV
        targetFov = Math.max(10, Math.min(120, 60 / followZoom))

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
              heading: Cesium.Math.toRadians(bearing),
              pitch: Cesium.Math.toRadians(pitchAngle),
              roll: 0
            },
            duration: animDuration,
            complete: () => {
              isAnimatingToFollowRef.current = false
              fovAnimationRef.current = null
              setHeading(bearing)
              setPitch(pitchAngle)
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

        // Update store with calculated values (for UI display)
        setHeading(bearing)
        setPitch(pitchAngle)
      } else {
        // Aircraft no longer exists, stop following
        stopFollowingStore()
      }
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
        duration: 2.0, // 2 second flight gives terrain time to stream
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
    stopFollowingStore
  ])

  // Mouse drag state for left-click panning
  const isLeftDraggingRef = useRef(false)

  // Refs for values needed during drag (avoids effect re-running during drag)
  const viewModeRef = useRef(viewMode)
  const topdownAltitudeRef = useRef(topdownAltitude)
  const headingRef = useRef(heading)
  const followingCallsignRef = useRef(followingCallsign)
  const followModeRef = useRef(followMode)

  // Keep refs updated
  viewModeRef.current = viewMode
  topdownAltitudeRef.current = topdownAltitude
  headingRef.current = heading
  followingCallsignRef.current = followingCallsign
  followModeRef.current = followMode

  // Mouse drag controls for panning/tilting using Cesium's event handler
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Use Cesium's ScreenSpaceEventHandler for reliable mouse event handling
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Left-click drag start (for panning in top-down view)
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      if (viewModeRef.current === 'topdown') {
        isLeftDraggingRef.current = true
        lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }
      }
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN)

    // Left-click drag end
    handler.setInputAction(() => {
      isLeftDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.LEFT_UP)

    // Right-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // In tower follow mode, stop following when user starts dragging
      // In orbit mode, allow drag to orbit around the aircraft
      if (followingCallsignRef.current && followModeRef.current === 'tower') {
        // User is breaking out manually - don't restore camera position
        clearPreFollowState()
        stopFollowingStore(false)
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_DOWN)

    // Middle-click drag start
    handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
      isDraggingRef.current = true
      lastMousePosRef.current = { x: movement.position.x, y: movement.position.y }

      // In tower follow mode, stop following when user starts dragging
      if (followingCallsignRef.current && followModeRef.current === 'tower') {
        // User is breaking out manually - don't restore camera position
        clearPreFollowState()
        stopFollowingStore(false)
      }
    }, Cesium.ScreenSpaceEventType.MIDDLE_DOWN)

    // Mouse move while dragging
    handler.setInputAction((movement: { startPosition: Cesium.Cartesian2; endPosition: Cesium.Cartesian2 }) => {
      const deltaX = movement.endPosition.x - lastMousePosRef.current.x
      const deltaY = movement.endPosition.y - lastMousePosRef.current.y

      // Handle left-click drag for panning in top-down view
      if (isLeftDraggingRef.current && viewModeRef.current === 'topdown') {
        // Scale pan speed with altitude (higher = faster panning)
        const panScale = topdownAltitudeRef.current / 1000
        // Invert directions so dragging moves the view intuitively
        // Account for heading rotation
        const headingRad = headingRef.current * Math.PI / 180
        const cosH = Math.cos(headingRad)
        const sinH = Math.sin(headingRad)
        // Rotate the delta by heading to get world-space movement (inverted for grab-and-drag feel)
        const worldDeltaX = -(deltaX * cosH - deltaY * sinH)
        const worldDeltaY = -(deltaX * sinH + deltaY * cosH)
        moveRight(worldDeltaX * panScale)
        moveForward(worldDeltaY * panScale)
        lastMousePosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
        return
      }

      if (!isDraggingRef.current) return

      // Sensitivity
      const sensitivity = 0.3

      if (followingCallsignRef.current && followModeRef.current === 'orbit') {
        // In orbit mode: adjust orbit heading/pitch
        adjustOrbitHeading(deltaX * sensitivity)
        adjustOrbitPitch(deltaY * sensitivity)
      } else {
        // Normal mode: update heading (horizontal movement) - positive deltaX = look right
        adjustHeading(deltaX * sensitivity)
        // Update pitch (vertical movement) - positive deltaY = look down
        adjustPitch(-deltaY * sensitivity)
      }

      lastMousePosRef.current = { x: movement.endPosition.x, y: movement.endPosition.y }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Right-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.RIGHT_UP)

    // Middle-click drag end
    handler.setInputAction(() => {
      isDraggingRef.current = false
    }, Cesium.ScreenSpaceEventType.MIDDLE_UP)

    // Prevent context menu on right-click
    const canvas = viewer.canvas
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
    }
    canvas.addEventListener('contextmenu', handleContextMenu)

    return () => {
      handler.destroy()
      canvas.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [viewer, adjustHeading, adjustPitch, adjustOrbitHeading, adjustOrbitPitch, moveForward, moveRight, stopFollowingStore, clearPreFollowState])

  // Mouse wheel for zoom - adds impulse for smooth scrolling
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      // Normalize wheel delta and add to impulse (accumulates for fast scrolling)
      const normalizedDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 100) / 100
      wheelImpulseRef.current += normalizedDelta
      // Clamp total impulse to prevent excessive buildup
      wheelImpulseRef.current = Math.max(-3, Math.min(3, wheelImpulseRef.current))
    }

    const canvas = viewer.canvas
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
    }
  }, [viewer])

  // Smooth keyboard controls with animation loop
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Movement configuration
    const ACCELERATION = 8.0       // How fast velocity builds up (per second)
    const DECELERATION = 6.0       // How fast velocity decays (per second)
    const MAX_MOVE_SPEED = 60      // Max movement speed (meters per second)
    const MAX_ROTATE_SPEED = 90    // Max rotation speed (degrees per second)
    const MAX_ZOOM_SPEED = 30      // Max FOV change speed (degrees per second)
    const MAX_ALTITUDE_SPEED = 1500 // Max altitude change speed (meters per second)
    const MAX_ORBIT_DIST_SPEED = 500 // Max orbit distance change speed (meters per second)

    // Keys that trigger continuous movement (mapped to velocity channels)
    const MOVEMENT_KEYS = new Set([
      'w', 'W', 's', 'S', 'a', 'A', 'd', 'D',
      'q', 'Q', 'e', 'E',  // Up/down movement
      'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
      '+', '=', '-', '_',
      'Shift'  // Sprint modifier
    ])

    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if typing in an input
      if (event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement) {
        return
      }

      const key = event.key

      // Handle one-shot keys (not continuous movement)
      switch (key) {
        case 't':
        case 'T':
          toggleViewMode()
          return
        case 'r':
          resetPosition()
          return
        case 'R':
        case 'Home':
          resetView()
          return
        case 'o':
        case 'O':
          if (followingCallsign) {
            toggleFollowMode()
          }
          return
        case 'Escape':
          stopFollowing()
          return
      }

      // Track continuous movement keys
      if (MOVEMENT_KEYS.has(key)) {
        pressedKeysRef.current.add(key.toLowerCase())

        // Stop following in tower mode when arrow keys are pressed
        if ((key.startsWith('Arrow')) && followingCallsign && followMode === 'tower') {
          // User is breaking out manually - don't restore camera position
          clearPreFollowState()
          stopFollowingStore(false)
        }
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key
      pressedKeysRef.current.delete(key.toLowerCase())
      // Also remove the uppercase version in case it was tracked that way
      pressedKeysRef.current.delete(key)
    }

    // Clear all keys when window loses focus
    const handleBlur = () => {
      pressedKeysRef.current.clear()
    }

    // Animation loop for smooth movement
    const animate = (currentTime: number) => {
      const deltaTime = lastFrameTimeRef.current ? (currentTime - lastFrameTimeRef.current) / 1000 : 0.016
      lastFrameTimeRef.current = currentTime

      // Clamp deltaTime to avoid huge jumps
      const dt = Math.min(deltaTime, 0.1)

      const keys = pressedKeysRef.current
      const vel = velocityRef.current

      // Calculate target velocities based on pressed keys
      let targetForward = 0
      let targetRight = 0
      let targetUp = 0
      let targetHeading = 0
      let targetPitch = 0
      let targetZoom = 0
      let targetOrbitHeading = 0
      let targetOrbitPitch = 0
      let targetOrbitDistance = 0
      let targetAltitude = 0

      // WASD movement (shift = sprint)
      const shiftHeld = keys.has('shift')
      const sprintMultiplier = shiftHeld ? 3.0 : 1.0

      if (keys.has('w')) targetForward = 1
      if (keys.has('s')) targetForward = -1
      if (keys.has('a')) targetRight = -1
      if (keys.has('d')) targetRight = 1

      // Q/E for vertical movement (height above ground)
      if (keys.has('e')) targetUp = 1
      if (keys.has('q')) targetUp = -1

      // Arrow keys - rotation or orbit control
      const inOrbitMode = followingCallsign && followMode === 'orbit'
      if (keys.has('arrowleft')) {
        if (inOrbitMode) targetOrbitHeading = -1
        else targetHeading = -1
      }
      if (keys.has('arrowright')) {
        if (inOrbitMode) targetOrbitHeading = 1
        else targetHeading = 1
      }
      if (keys.has('arrowup')) {
        if (inOrbitMode) targetOrbitPitch = 1
        else targetPitch = 1
      }
      if (keys.has('arrowdown')) {
        if (inOrbitMode) targetOrbitPitch = -1
        else targetPitch = -1
      }

      // Zoom controls (+/-)
      const zoomIn = keys.has('+') || keys.has('=')
      const zoomOut = keys.has('-') || keys.has('_')
      if (zoomIn) {
        if (viewMode === 'topdown') targetAltitude = -1
        else if (inOrbitMode) targetOrbitDistance = -1
        else if (followingCallsign) targetZoom = 1  // Positive = zoom in (increase followZoom)
        else targetZoom = -1  // Negative = decrease FOV = zoom in
      }
      if (zoomOut) {
        if (viewMode === 'topdown') targetAltitude = 1
        else if (inOrbitMode) targetOrbitDistance = 1
        else if (followingCallsign) targetZoom = -1
        else targetZoom = 1
      }

      // Process mouse wheel impulse (adds to velocity directly)
      const wheelImpulse = wheelImpulseRef.current
      if (Math.abs(wheelImpulse) > 0.001) {
        const WHEEL_IMPULSE_STRENGTH = 80  // How much velocity each unit of wheel adds
        const impulseAmount = wheelImpulse * WHEEL_IMPULSE_STRENGTH

        if (viewMode === 'topdown') {
          vel.altitude += impulseAmount * 3  // Scale up for altitude
        } else if (inOrbitMode) {
          vel.orbitDistance += impulseAmount * 1.2
        } else if (followingCallsign) {
          vel.zoom -= impulseAmount * 0.002  // Inverted and scaled for follow zoom
        } else {
          vel.zoom += impulseAmount * 0.08
        }

        // Decay the impulse
        wheelImpulseRef.current *= 0.6
        if (Math.abs(wheelImpulseRef.current) < 0.01) {
          wheelImpulseRef.current = 0
        }
      }

      // Smoothly interpolate velocities toward targets
      const accelerate = (current: number, target: number, maxSpeed: number): number => {
        const targetVel = target * maxSpeed
        if (Math.abs(targetVel) > 0.001) {
          // Accelerating toward target
          const diff = targetVel - current
          const change = Math.sign(diff) * ACCELERATION * maxSpeed * dt
          if (Math.abs(change) > Math.abs(diff)) {
            return targetVel
          }
          return current + change
        } else {
          // Decelerating to zero
          const change = DECELERATION * maxSpeed * dt
          if (Math.abs(current) < change) {
            return 0
          }
          return current - Math.sign(current) * change
        }
      }

      // Scale movement speed with altitude in topdown view, and apply sprint multiplier
      const referenceAltitude = 2000
      const altitudeScale = viewMode === 'topdown' ? topdownAltitude / referenceAltitude : 1
      const effectiveMoveSpeed = MAX_MOVE_SPEED * altitudeScale * sprintMultiplier

      vel.forward = accelerate(vel.forward, targetForward, effectiveMoveSpeed)
      vel.right = accelerate(vel.right, targetRight, effectiveMoveSpeed)
      vel.up = accelerate(vel.up, targetUp, effectiveMoveSpeed)
      vel.heading = accelerate(vel.heading, targetHeading, MAX_ROTATE_SPEED)
      vel.pitch = accelerate(vel.pitch, targetPitch, MAX_ROTATE_SPEED)
      vel.zoom = accelerate(vel.zoom, targetZoom, MAX_ZOOM_SPEED)
      vel.orbitHeading = accelerate(vel.orbitHeading, targetOrbitHeading, MAX_ROTATE_SPEED)
      vel.orbitPitch = accelerate(vel.orbitPitch, targetOrbitPitch, MAX_ROTATE_SPEED)
      vel.orbitDistance = accelerate(vel.orbitDistance, targetOrbitDistance, MAX_ORBIT_DIST_SPEED)
      vel.altitude = accelerate(vel.altitude, targetAltitude, MAX_ALTITUDE_SPEED)

      // Apply velocities
      const threshold = 0.01

      if (Math.abs(vel.forward) > threshold) {
        moveForward(vel.forward * dt)
      }
      if (Math.abs(vel.right) > threshold) {
        moveRight(vel.right * dt)
      }
      if (Math.abs(vel.up) > threshold) {
        moveUp(vel.up * dt)
      }
      if (Math.abs(vel.heading) > threshold) {
        adjustHeading(vel.heading * dt)
      }
      if (Math.abs(vel.pitch) > threshold) {
        adjustPitch(vel.pitch * dt)
      }
      if (Math.abs(vel.zoom) > threshold) {
        if (followingCallsign && followMode !== 'orbit') {
          adjustFollowZoom(vel.zoom * dt * 0.05)  // Scale down for follow zoom
        } else {
          adjustFov(vel.zoom * dt)
        }
      }
      if (Math.abs(vel.orbitHeading) > threshold) {
        adjustOrbitHeading(vel.orbitHeading * dt)
      }
      if (Math.abs(vel.orbitPitch) > threshold) {
        adjustOrbitPitch(vel.orbitPitch * dt)
      }
      if (Math.abs(vel.orbitDistance) > threshold) {
        adjustOrbitDistance(vel.orbitDistance * dt)
      }
      if (Math.abs(vel.altitude) > threshold) {
        adjustTopdownAltitude(vel.altitude * dt)
      }

      animationFrameRef.current = requestAnimationFrame(animate)
    }

    // Start animation loop
    animationFrameRef.current = requestAnimationFrame(animate)

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
      pressedKeysRef.current.clear()
    }
  }, [
    viewer,
    viewMode,
    topdownAltitude,
    followingCallsign,
    followMode,
    adjustHeading,
    adjustPitch,
    adjustFov,
    adjustTopdownAltitude,
    adjustFollowZoom,
    adjustOrbitHeading,
    adjustOrbitPitch,
    adjustOrbitDistance,
    toggleFollowMode,
    moveForward,
    moveRight,
    toggleViewMode,
    resetView,
    resetPosition,
    stopFollowing,
    stopFollowingStore,
    clearPreFollowState
  ])

  return {
    resetView,
    followAircraft,
    stopFollowing
  }
}

export default useCesiumCamera
