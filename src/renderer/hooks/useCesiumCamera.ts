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
  feetToMeters
} from '../utils/cameraGeometry'
import { useCameraInput } from './useCameraInput'
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
 * @param viewportId - The ID of the viewport this camera controls
 * @param interpolatedAircraft - Map of interpolated aircraft states for smooth follow tracking
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

  // Smoothed camera position for orbit mode (prevents jitter)
  const smoothedOrbitPositionRef = useRef<{
    lat: number
    lon: number
    height: number
  } | null>(null)

  // Callback for when user breaks out of tower follow mode via input
  const handleBreakTowerFollow = useCallback(() => {
    clearPreFollowState()
    stopFollowingStore(false)
  }, [clearPreFollowState, stopFollowingStore])

  // Use camera input hook for keyboard/mouse handling
  useCameraInput(viewer, viewportId, { onBreakTowerFollow: handleBreakTowerFollow })

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
        const altitudeMeters = feetToMeters(aircraft.interpolatedAltitude)

        if (state.followMode === 'orbit') {
          // ORBIT MODE: Camera orbits around aircraft
          const orbitResult = calculateOrbitCameraPosition(
            aircraftLat,
            aircraftLon,
            altitudeMeters,
            aircraftHeading,
            state.orbitHeading,
            state.orbitPitch,
            state.orbitDistance
          )

          // Apply smoothing to camera position to reduce jitter
          // Smoothing factor: lower = smoother but more lag (0.15 = good balance)
          const smoothingFactor = 0.15

          if (!smoothedOrbitPositionRef.current) {
            // Initialize smoothed position on first frame
            smoothedOrbitPositionRef.current = {
              lat: orbitResult.cameraLat,
              lon: orbitResult.cameraLon,
              height: orbitResult.cameraHeight
            }
          } else {
            // Exponential moving average (lerp) for smooth camera movement
            const prev = smoothedOrbitPositionRef.current
            smoothedOrbitPositionRef.current = {
              lat: prev.lat + (orbitResult.cameraLat - prev.lat) * smoothingFactor,
              lon: prev.lon + (orbitResult.cameraLon - prev.lon) * smoothingFactor,
              height: prev.height + (orbitResult.cameraHeight - prev.height) * smoothingFactor
            }
          }

          const smoothed = smoothedOrbitPositionRef.current
          const targetFov = calculateFollowFov(60, state.followZoom)

          // Set camera position using smoothed coordinates
          const cameraPosition = Cesium.Cartesian3.fromDegrees(
            smoothed.lon,
            smoothed.lat,
            smoothed.height
          )
          viewer.camera.setView({
            destination: cameraPosition,
            orientation: {
              heading: Cesium.Math.toRadians(orbitResult.heading),
              pitch: Cesium.Math.toRadians(orbitResult.pitch),
              roll: 0
            }
          })

          // Set FOV
          if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
            viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
          }

          // Update store with calculated values (for UI display) - but only if changed
          if (Math.abs(orbitResult.heading - state.heading) > 0.1 || Math.abs(orbitResult.pitch - state.pitch) > 0.1) {
            updateCameraState({
              heading: orbitResult.heading,
              pitch: orbitResult.pitch
            })
          }
        } else if (state.followMode === 'tower' && state.viewMode === '3d') {
          // TOWER MODE: Camera stays at tower, rotates to look at aircraft
          const airportState = useAirportStore.getState()
          if (!airportState.currentAirport) return

          const towerPos = getTowerPosition(airportState.currentAirport, airportState.towerHeight)
          const offsetPos = applyPositionOffsets(
            { latitude: towerPos.latitude, longitude: towerPos.longitude, height: towerPos.height },
            { x: state.positionOffsetX, y: state.positionOffsetY, z: state.positionOffsetZ }
          )

          // Calculate bearing and pitch to aircraft
          const lookAt = calculateTowerLookAt(
            offsetPos.latitude,
            offsetPos.longitude,
            offsetPos.height,
            aircraftLat,
            aircraftLon,
            altitudeMeters
          )

          const targetFov = calculateFollowFov(60, state.followZoom)

          // Set camera position and orientation
          const cameraPosition = Cesium.Cartesian3.fromDegrees(offsetPos.longitude, offsetPos.latitude, offsetPos.height)
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
        const altitudeMeters = feetToMeters(aircraft.interpolatedAltitude)

        // Calculate orbit camera position and orientation
        const orbitResult = calculateOrbitCameraPosition(
          aircraftLat,
          aircraftLon,
          altitudeMeters,
          aircraft.interpolatedHeading,
          orbitHeading,
          orbitPitch,
          orbitDistance
        )

        // Apply smoothing to camera position to reduce jitter
        const smoothingFactor = 0.15

        if (!smoothedOrbitPositionRef.current) {
          // Initialize smoothed position on first frame
          smoothedOrbitPositionRef.current = {
            lat: orbitResult.cameraLat,
            lon: orbitResult.cameraLon,
            height: orbitResult.cameraHeight
          }
        } else {
          // Exponential moving average (lerp) for smooth camera movement
          const prev = smoothedOrbitPositionRef.current
          smoothedOrbitPositionRef.current = {
            lat: prev.lat + (orbitResult.cameraLat - prev.lat) * smoothingFactor,
            lon: prev.lon + (orbitResult.cameraLon - prev.lon) * smoothingFactor,
            height: prev.height + (orbitResult.cameraHeight - prev.height) * smoothingFactor
          }
        }

        const smoothed = smoothedOrbitPositionRef.current
        const targetFov = calculateFollowFov(60, followZoom)

        // Update store with calculated values (for UI display)
        setHeading(orbitResult.heading)
        setPitch(orbitResult.pitch)

        // Set camera position using smoothed coordinates
        const cameraPosition = Cesium.Cartesian3.fromDegrees(
          smoothed.lon,
          smoothed.lat,
          smoothed.height
        )
        viewer.camera.setView({
          destination: cameraPosition,
          orientation: {
            heading: Cesium.Math.toRadians(orbitResult.heading),
            pitch: Cesium.Math.toRadians(orbitResult.pitch),
            roll: 0
          }
        })

        // Set FOV
        if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
          viewer.camera.frustum.fov = Cesium.Math.toRadians(targetFov)
        }
        return
      }
      // Aircraft not found in interpolated map yet - don't stop following here.
      // The preRender handler will keep checking, and the aircraft may appear
      // after the next animation frame. Let the user manually stop following
      // or wait for the aircraft to appear.
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
      const cameraPosition = Cesium.Cartesian3.fromDegrees(offsetPos.longitude, offsetPos.latitude, offsetPos.height)
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

      // Determine camera center point - follow aircraft if active, otherwise use tower/offset
      let centerLat = offsetPos.latitude
      let centerLon = offsetPos.longitude

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
    const cameraLat = offsetPos.latitude
    const cameraLon = offsetPos.longitude
    const cameraHeight = offsetPos.height

    // If following an aircraft in tower mode
    if (followingCallsign && followMode === 'tower' && interpolatedAircraft) {
      const aircraft = interpolatedAircraft.get(followingCallsign)
      if (aircraft) {
        // Use interpolated positions for smooth tracking
        const aircraftLat = aircraft.interpolatedLatitude
        const aircraftLon = aircraft.interpolatedLongitude
        const altitudeMeters = feetToMeters(aircraft.interpolatedAltitude)

        // TOWER MODE: Camera stays at tower, rotates to look at aircraft
        const lookAt = calculateTowerLookAt(
          offsetPos.latitude,
          offsetPos.longitude,
          offsetPos.height,
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
              setHeading(lookAt.heading)
              setPitch(lookAt.pitch)
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
        setHeading(lookAt.heading)
        setPitch(lookAt.pitch)
      }
      // If aircraft not found, don't stop following immediately - it may appear
      // after the next animation frame. The preRender handler keeps checking.
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

  // Reset smoothed orbit position when following stops or follow mode changes
  useEffect(() => {
    if (!followingCallsign || followMode !== 'orbit') {
      smoothedOrbitPositionRef.current = null
    }
  }, [followingCallsign, followMode])

  return {
    resetView,
    followAircraft,
    stopFollowing
  }
}

export default useCesiumCamera
