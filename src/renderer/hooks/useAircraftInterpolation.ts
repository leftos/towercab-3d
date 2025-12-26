import { useState, useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { getAircraftDataSource } from './useAircraftDataSource'
import { interpolateAircraftState, calculateFlarePitch } from '../utils/interpolation'
import { performanceMonitor } from '../utils/performanceMonitor'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  FLYING_AIRCRAFT_TERRAIN_OFFSET,
  TERRAIN_SMOOTHING_LERP_FACTOR,
  HEIGHT_TRANSITION_LERP_FACTOR,
  NOSEWHEEL_LOWERING_LERP_FACTOR,
  FALLBACK_FLARE_PITCH_DEGREES
} from '../constants/rendering'

// SINGLETON: Shared interpolated states map and animation loop
// This ensures only ONE interpolation loop runs, even if hook is called multiple times
const sharedInterpolatedStates = new Map<string, InterpolatedAircraftState>()
let animationLoopRunning = false
let animationFrameId: number | null = null
let hookInstanceCount = 0

// Shared state for animation loop (accessed by singleton loop)
const sharedAircraftStatesRef = { current: new Map<string, AircraftState>() }
const sharedPreviousStatesRef = { current: new Map<string, AircraftState>() }
const sharedOrientationEnabledRef = { current: true }
const sharedOrientationIntensityRef = { current: 1.0 }
const sharedLastInterpolationTimeRef = { current: 0 }
const sharedLastAircraftCountRef = { current: 0 }

// Shared state for terrain correction (injected from rendering layer)
const sharedGroundAircraftTerrainRef = { current: new Map<string, number>() }
const sharedTerrainOffsetRef = { current: 0 }
const sharedGroundElevationMetersRef = { current: 0 }

// Terrain correction transition state (for smooth ground/air transitions)
const sharedSmoothedTerrainHeightsRef = { current: new Map<string, number>() }
const sharedPrevClampStateRef = { current: new Map<string, boolean>() }
const sharedTransitionHeightsRef = { current: new Map<string, { source: number; target: number; progress: number }>() }
// Store previous frame's corrected height for accurate transition source
const sharedPrevCorrectedHeightRef = { current: new Map<string, number>() }

// Nosewheel lowering transition state (for smooth pitch after landing)
// Tracks the last flare pitch to smoothly transition to ground pitch after touchdown
const sharedNosewheelTransitionRef = { current: new Map<string, { sourcePitch: number; progress: number }>() }
const sharedWasInFlareRef = { current: new Map<string, boolean>() }
// Store the actual flare pitch from the previous frame for accurate nosewheel transition
const sharedLastFlarePitchRef = { current: new Map<string, number>() }

// Store subscribers for triggering re-renders
const subscribers = new Set<() => void>()

// Singleton animation loop function
function updateInterpolation() {
  performanceMonitor.startTimer('interpolation')

  // Get aircraft data from unified source (handles live vs replay mode)
  const source = getAircraftDataSource()

  // Update shared refs from source (for any external code that reads them)
  sharedAircraftStatesRef.current = source.aircraftStates
  sharedPreviousStatesRef.current = source.previousStates

  // Use source timestamp as "now" - for live mode this is Date.now(),
  // for replay mode this is calculated based on segment progress
  const now = source.timestamp

  // Track frame timing for diagnostics
  sharedLastInterpolationTimeRef.current = now

  const statesMap = sharedInterpolatedStates
  const aircraftStates = source.aircraftStates
  const previousStates = source.previousStates

  // Track which callsigns are still active
  const activeCallsigns = new Set<string>()

  const orientationEnabled = sharedOrientationEnabledRef.current
  const orientationIntensity = sharedOrientationIntensityRef.current

  for (const [callsign, currentState] of aircraftStates) {
    activeCallsigns.add(callsign)
    const previousState = previousStates.get(callsign)

    // Get previous segment's physics from last interpolated state for smooth transitions
    const existing = statesMap.get(callsign)

    // Detect if this is a new VATSIM data update (currentState timestamp changed)
    const isNewVatsimData = !existing || existing.timestamp !== currentState.timestamp

    // Only extract previous physics if we have existing data and it's a NEW update
    // This preserves the OLD segment's physics for smooth transitions
    const previousVerticalRate = (existing && isNewVatsimData) ? (existing.verticalRate / 60000) : 0
    const previousTurnRate = (existing && isNewVatsimData) ? existing.turnRate : 0

    const interpolated = interpolateAircraftState(
      previousState,
      currentState,
      now,
      orientationEnabled,
      orientationIntensity,
      previousVerticalRate,
      previousTurnRate
    )

    // Diagnostic logging removed - use performance monitor for frame timing

    // Reuse existing entry or create new one
    if (existing) {
      // Update in place to avoid object allocation
      existing.callsign = interpolated.callsign
      existing.interpolatedLatitude = interpolated.interpolatedLatitude
      existing.interpolatedLongitude = interpolated.interpolatedLongitude
      existing.interpolatedAltitude = interpolated.interpolatedAltitude
      existing.interpolatedGroundspeed = interpolated.interpolatedGroundspeed
      existing.interpolatedHeading = interpolated.interpolatedHeading
      existing.interpolatedPitch = interpolated.interpolatedPitch
      existing.interpolatedRoll = interpolated.interpolatedRoll
      existing.aircraftType = interpolated.aircraftType
      existing.departure = interpolated.departure
      existing.arrival = interpolated.arrival
      existing.isInterpolated = interpolated.isInterpolated

      // CRITICAL: Only update physics when VATSIM data changes
      // This preserves the segment's physics for smooth orientation transitions
      if (isNewVatsimData) {
        existing.verticalRate = interpolated.verticalRate
        existing.turnRate = interpolated.turnRate
        existing.timestamp = interpolated.timestamp
      }
    } else {
      statesMap.set(callsign, interpolated)
    }

    // Apply terrain correction to aircraft altitude
    // This ensures consistent height across all rendering (models, labels, etc.)
    const entry = statesMap.get(callsign)!
    const isOnGround = entry.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
    const heightAboveEllipsoid = entry.interpolatedAltitude // VATSIM altitude in meters MSL
    const terrainOffset = sharedTerrainOffsetRef.current
    const groundElevationMeters = sharedGroundElevationMetersRef.current
    const groundAircraftTerrain = sharedGroundAircraftTerrainRef.current

    // Calculate heights in ellipsoid coordinates for comparison
    const reportedEllipsoidHeight = heightAboveEllipsoid + terrainOffset
    const sampledTerrainHeight = groundAircraftTerrain.get(callsign)

    // Determine if we should clamp to terrain:
    // 1. Groundspeed is low (definitely on ground), OR
    // 2. Terrain sample exists AND is higher than reported altitude (prevents going underground)
    //    This fixes the issue where landing aircraft (>40kts) would clip through runway
    let shouldClampToTerrain = false
    if (sampledTerrainHeight !== undefined) {
      const terrainEllipsoidHeight = sampledTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
      shouldClampToTerrain = isOnGround || (terrainEllipsoidHeight > reportedEllipsoidHeight)
    } else {
      shouldClampToTerrain = isOnGround
    }

    let targetHeight: number

    if (shouldClampToTerrain && sampledTerrainHeight !== undefined) {
      // Clamp to terrain: use terrain-sampled height (smoothed for consistency)
      const currentSmoothed = sharedSmoothedTerrainHeightsRef.current.get(callsign) ?? sampledTerrainHeight
      const newSmoothed = currentSmoothed + (sampledTerrainHeight - currentSmoothed) * TERRAIN_SMOOTHING_LERP_FACTOR
      sharedSmoothedTerrainHeightsRef.current.set(callsign, newSmoothed)

      // Target height: smoothed terrain + offset
      targetHeight = newSmoothed + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else if (isOnGround) {
      // Low groundspeed but no terrain sample - use fallback
      const groundEllipsoidHeight = groundElevationMeters + terrainOffset
      targetHeight = Math.max(reportedEllipsoidHeight, groundEllipsoidHeight) + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else {
      // Moving fast (>= 40 kts) but not necessarily airborne yet
      // Scale the flying offset based on actual altitude above ground
      // This prevents the 5m jump when aircraft is still on the runway during takeoff roll
      let flyingOffset = FLYING_AIRCRAFT_TERRAIN_OFFSET
      if (sampledTerrainHeight !== undefined) {
        const altitudeAGL = reportedEllipsoidHeight - sampledTerrainHeight
        // Gradually increase offset from 0.1m (ground) to 5m (fully airborne at 30m AGL)
        // This creates a smooth visual transition during takeoff/landing
        const transitionProgress = Math.min(1.0, Math.max(0, altitudeAGL / 30))
        flyingOffset = GROUND_AIRCRAFT_TERRAIN_OFFSET +
          (FLYING_AIRCRAFT_TERRAIN_OFFSET - GROUND_AIRCRAFT_TERRAIN_OFFSET) * transitionProgress
      }
      targetHeight = reportedEllipsoidHeight + flyingOffset

      // Clean up smoothed terrain height for aircraft that are truly airborne
      if (sampledTerrainHeight !== undefined) {
        const altitudeAGL = reportedEllipsoidHeight - sampledTerrainHeight
        if (altitudeAGL > 50) {
          // Only clean up once truly airborne (50m+ AGL)
          sharedSmoothedTerrainHeightsRef.current.delete(callsign)
        }
      } else {
        sharedSmoothedTerrainHeightsRef.current.delete(callsign)
      }
    }

    // Smooth transition when switching between clamped/unclamped states
    // Track shouldClampToTerrain changes (not just isOnGround) to handle landing transition
    let correctedHeight = targetHeight
    const prevClampState = sharedPrevClampStateRef.current.get(callsign)

    if (prevClampState !== undefined && prevClampState !== shouldClampToTerrain) {
      // State changed! Start a transition
      const currentTransition = sharedTransitionHeightsRef.current.get(callsign)

      if (!currentTransition || currentTransition.target !== targetHeight) {
        // Initialize new transition from current position to target
        // Use the PREVIOUS FRAME's corrected height as source (not raw interpolated altitude)
        // This prevents visual jumps when transitioning between ground/airborne states
        let sourceHeight: number
        if (currentTransition) {
          // Mid-transition: calculate current interpolated height
          sourceHeight = currentTransition.source +
            (currentTransition.target - currentTransition.source) * currentTransition.progress
        } else {
          // New transition: use previous frame's corrected height if available
          const prevCorrectedHeight = sharedPrevCorrectedHeightRef.current.get(callsign)
          sourceHeight = prevCorrectedHeight ?? entry.interpolatedAltitude
        }
        sharedTransitionHeightsRef.current.set(callsign, {
          source: sourceHeight,
          target: targetHeight,
          progress: 0
        })
      }
    }

    // Apply ongoing transition if exists
    const transition = sharedTransitionHeightsRef.current.get(callsign)
    if (transition && transition.progress < 1.0) {
      // Lerp from source to target over ~15 frames (~0.25 seconds at 60fps)
      // Slower transition for smoother landing appearance
      transition.progress = Math.min(1.0, transition.progress + HEIGHT_TRANSITION_LERP_FACTOR)
      correctedHeight = transition.source + (transition.target - transition.source) * transition.progress

      // Update target if it changed during transition
      if (transition.target !== targetHeight) {
        transition.target = targetHeight
      }

      // Clean up completed transitions
      if (transition.progress >= 1.0) {
        sharedTransitionHeightsRef.current.delete(callsign)
      }
    }

    // Update previous state
    sharedPrevClampStateRef.current.set(callsign, shouldClampToTerrain)

    // Apply corrected height to interpolated altitude
    entry.interpolatedAltitude = correctedHeight

    // Store corrected height for next frame (used as transition source when state changes)
    sharedPrevCorrectedHeightRef.current.set(callsign, correctedHeight)

    // Apply landing flare pitch adjustment
    // When aircraft is descending close to the ground, pitch nose up to emulate flare
    // NOTE: Calculate AGL BEFORE terrain correction is applied to entry.interpolatedAltitude
    if (orientationEnabled && sampledTerrainHeight !== undefined) {
      // Calculate altitude above ground level (AGL)
      // Use reported altitude (not corrected) since terrain height is in ellipsoid coords
      const altitudeAGL = reportedEllipsoidHeight - sampledTerrainHeight

      // Determine if aircraft is currently in flare conditions BEFORE applying flare
      // This allows us to capture the actual flare pitch when aircraft is in flare
      const isDescending = entry.verticalRate < -50  // m/min
      const inFlareZone = altitudeAGL > 0 && altitudeAGL < 15  // meters
      const isAirborne = entry.interpolatedGroundspeed >= GROUNDSPEED_THRESHOLD_KNOTS
      const isInFlare = isDescending && inFlareZone && isAirborne

      // Get the base pitch (without flare) for reference
      const basePitch = entry.interpolatedPitch

      // Apply flare pitch calculation
      entry.interpolatedPitch = calculateFlarePitch(
        entry.interpolatedPitch,
        altitudeAGL,
        entry.verticalRate,  // Already in m/min
        entry.interpolatedGroundspeed,
        orientationIntensity
      )

      // If currently in flare, store the actual flare pitch for nosewheel transition
      if (isInFlare) {
        sharedLastFlarePitchRef.current.set(callsign, entry.interpolatedPitch)
      }

      // Track flare state for nosewheel lowering transition
      const wasInFlare = sharedWasInFlareRef.current.get(callsign) ?? false
      const nosewheelTransition = sharedNosewheelTransitionRef.current.get(callsign)

      if (wasInFlare && !isInFlare && !nosewheelTransition) {
        // Just exited flare! Start nosewheel lowering transition
        // Use the stored flare pitch from when we were actually in flare
        const lastFlarePitch = sharedLastFlarePitchRef.current.get(callsign) ?? (basePitch + FALLBACK_FLARE_PITCH_DEGREES)
        sharedNosewheelTransitionRef.current.set(callsign, {
          sourcePitch: lastFlarePitch,
          progress: 0
        })
        // Clean up stored flare pitch
        sharedLastFlarePitchRef.current.delete(callsign)
      }

      // Apply ongoing nosewheel lowering transition
      if (nosewheelTransition && nosewheelTransition.progress < 1.0) {
        // Gradually lower nose over ~1 second at 60fps (~60 frames)
        // smoothstep easing for natural deceleration
        nosewheelTransition.progress = Math.min(1.0, nosewheelTransition.progress + NOSEWHEEL_LOWERING_LERP_FACTOR)

        // smoothstep: x^2 * (3 - 2x) for smooth acceleration/deceleration
        const easedProgress = nosewheelTransition.progress * nosewheelTransition.progress * (3 - 2 * nosewheelTransition.progress)

        // Blend from flare pitch to base pitch (physics-based pitch for current motion)
        entry.interpolatedPitch = nosewheelTransition.sourcePitch * (1 - easedProgress) + basePitch * easedProgress

        // Clean up completed transitions
        if (nosewheelTransition.progress >= 1.0) {
          sharedNosewheelTransitionRef.current.delete(callsign)
        }
      }

      // Update flare state for next frame
      sharedWasInFlareRef.current.set(callsign, isInFlare)
    }
  }

  // Remove stale entries (aircraft that are no longer in the data)
  for (const callsign of statesMap.keys()) {
    if (!activeCallsigns.has(callsign)) {
      statesMap.delete(callsign)
      // Clean up transition state for removed aircraft
      sharedSmoothedTerrainHeightsRef.current.delete(callsign)
      sharedPrevClampStateRef.current.delete(callsign)
      sharedTransitionHeightsRef.current.delete(callsign)
      sharedPrevCorrectedHeightRef.current.delete(callsign)
      sharedNosewheelTransitionRef.current.delete(callsign)
      sharedWasInFlareRef.current.delete(callsign)
      sharedLastFlarePitchRef.current.delete(callsign)
    }
  }

  // Trigger React re-render for subscribers when aircraft count changes
  const currentCount = statesMap.size
  if (currentCount !== sharedLastAircraftCountRef.current) {
    sharedLastAircraftCountRef.current = currentCount
    subscribers.forEach(callback => callback())
  }

  performanceMonitor.endTimer('interpolation')

  // Schedule next frame
  animationFrameId = requestAnimationFrame(updateInterpolation)
}

/**
 * Inject terrain correction data into the interpolation system
 *
 * This function allows the rendering layer to provide terrain data that will be
 * used for ground aircraft altitude correction during interpolation.
 *
 * @param groundAircraftTerrain - Map of terrain heights (ellipsoid) sampled at 3Hz
 * @param terrainOffset - Geoid offset for MSL → ellipsoid conversion
 * @param groundElevationMeters - Ground elevation at tower/reference position
 */
export function setInterpolationTerrainData(
  groundAircraftTerrain: Map<string, number>,
  terrainOffset: number,
  groundElevationMeters: number
) {
  sharedGroundAircraftTerrainRef.current = groundAircraftTerrain
  sharedTerrainOffsetRef.current = terrainOffset
  sharedGroundElevationMetersRef.current = groundElevationMeters
}

/**
 * Hook that provides smoothly interpolated aircraft positions
 * Updates at 60fps for smooth rendering
 *
 * SINGLETON PATTERN: Multiple calls to this hook share the same interpolation loop
 * and the same Map instance to prevent duplicate calculations and memory waste.
 */
/**
 * Provides smooth 60 Hz aircraft position and orientation interpolation using a
 * singleton animation loop.
 *
 * ## Responsibilities
 * - Interpolate aircraft positions between 15-second VATSIM API updates
 * - Calculate smooth heading changes during turns
 * - Estimate pitch/roll from climb/descent and turn rates
 * - Extrapolate positions when data is stale
 * - Maintain singleton animation loop (only ONE loop for entire app)
 *
 * ## Singleton Pattern
 * **CRITICAL:** This hook uses a singleton pattern. Multiple components can call this
 * hook, but only ONE animation loop runs for the entire application. All instances
 * share the same interpolated states map.
 *
 * Benefits:
 * - Single source of truth for interpolated positions
 * - Prevents duplicate calculations (60 Hz * N components = waste)
 * - Consistent aircraft state across all viewports
 * - Automatic cleanup when last instance unmounts
 *
 * ## Dependencies
 * - Reads: vatsimStore OR replayStore (via getAircraftDataSource abstraction)
 * - Reads: settingsStore (for orientation emulation settings)
 * - Writes: Shared interpolatedStates Map (singleton)
 *
 * ## Interpolation Algorithm
 *
 * ### Position Interpolation
 * Uses linear interpolation (lerp) between previous and current position:
 * ```
 * t = (now - lastUpdate) / (currentUpdate - lastUpdate)
 * interpolatedPos = lerp(previousPos, currentPos, clamp(t, 0, 1.2))
 * ```
 * Note: Allows 20% extrapolation (t > 1.0) for stale data.
 *
 * ### Heading Interpolation
 * Uses spherical interpolation to avoid wrap-around issues:
 * - Handles 350° → 10° transition smoothly
 * - Calculates turn rate from heading delta
 *
 * ### Pitch/Roll Estimation
 * Derives orientation from motion:
 * - Pitch: Based on vertical rate (climb/descent)
 * - Roll: Based on turn rate (banking in turns)
 * - Intensity configurable via settings (25% to 150%)
 *
 * ## Performance
 * - Runs at 60 Hz (requestAnimationFrame)
 * - Processes all aircraft each frame (~100-500 aircraft typical)
 * - Performance monitored via performanceMonitor.startTimer('interpolation')
 * - Frame timing logged for followed aircraft
 *
 * ## Data Flow
 * ```
 * LIVE MODE:                          REPLAY MODE:
 * VATSIM API (15s updates)            replayStore snapshots
 *   ↓                                    ↓
 * vatsimStore                         getActiveSnapshots()
 *   ↓                                    ↓
 *   └──────────────┬────────────────────┘
 *                  ↓
 *        getAircraftDataSource() (unified abstraction)
 *                  ↓
 *        useAircraftInterpolation (60 Hz singleton loop)
 *                  ↓
 *        sharedInterpolatedStates Map
 *                  ↓
 *        ├─ CesiumViewer (labels, culling)
 *        └─ useBabylonOverlay (3D models, shadows)
 * ```
 *
 * ## Memory Management
 * - Automatically removes stale aircraft (no longer in VATSIM data)
 * - Cleans up animation loop when last component unmounts
 * - Reuses Map entries to minimize allocations
 *
 * @returns Shared Map of interpolated aircraft states (callsign → InterpolatedAircraftState)
 *
 * @example
 * // Basic usage (call once per component that needs interpolated data)
 * const interpolatedAircraft = useAircraftInterpolation()
 *
 * // Access interpolated state for specific aircraft
 * const aircraft = interpolatedAircraft.get('AAL123')
 * if (aircraft) {
 *   console.log(aircraft.latitude, aircraft.longitude, aircraft.altitude)
 *   console.log(aircraft.heading, aircraft.pitch, aircraft.roll)
 * }
 *
 * @example
 * // Multiple components can call this hook - only ONE loop runs
 * function ComponentA() {
 *   const aircraft = useAircraftInterpolation() // Instance 1
 *   // ...
 * }
 *
 * function ComponentB() {
 *   const aircraft = useAircraftInterpolation() // Instance 2 (same data!)
 *   // ...
 * }
 *
 * @example
 * // Iterate over all interpolated aircraft
 * const interpolatedAircraft = useAircraftInterpolation()
 * for (const [callsign, aircraft] of interpolatedAircraft) {
 *   // Process each aircraft at 60 Hz
 * }
 *
 * @see interpolateAircraftState - core interpolation math
 * @see vatsimStore - source data for interpolation
 * @see docs/architecture.md - data flow diagram
 */
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  // Version counter to trigger re-renders when data changes
  const [, setVersion] = useState(0)

  // Subscribe to store changes and manage singleton lifecycle
  useEffect(() => {
    hookInstanceCount++

    // Subscribe to settings for orientation emulation
    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      sharedOrientationEnabledRef.current = state.aircraft.orientationEmulation
      sharedOrientationIntensityRef.current = state.aircraft.orientationIntensity
    })

    // Initialize settings refs
    const settingsState = useSettingsStore.getState()
    sharedOrientationEnabledRef.current = settingsState.aircraft.orientationEmulation
    sharedOrientationIntensityRef.current = settingsState.aircraft.orientationIntensity

    // Note: We no longer subscribe to vatsimStore here because the animation loop
    // now calls getAircraftDataSource() each frame, which reads directly from
    // the appropriate store (vatsimStore for live, replayStore for replay).
    // This eliminates the 60Hz store subscription issue during replay.

    // Subscribe this component to updates (for React re-renders when aircraft count changes)
    const updateCallback = () => setVersion(v => v + 1)
    subscribers.add(updateCallback)

    return () => {
      hookInstanceCount--
      unsubscribeSettings()
      subscribers.delete(updateCallback)

      // Stop animation loop when last component unmounts
      if (hookInstanceCount === 0 && animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
        animationFrameId = null
        animationLoopRunning = false
      }
    }
  }, [])

  // Start singleton animation loop (only once, regardless of hook calls)
  useEffect(() => {
    if (!animationLoopRunning) {
      animationLoopRunning = true
      animationFrameId = requestAnimationFrame(updateInterpolation)
    }
  }, [])

  return sharedInterpolatedStates
}

export default useAircraftInterpolation
