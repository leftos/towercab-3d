import { useState, useEffect } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import { useSettingsStore } from '../stores/settingsStore'
import { interpolateAircraftState, calculateFlarePitch } from '../utils/interpolation'
import { performanceMonitor } from '../utils/performanceMonitor'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  GROUND_AIRCRAFT_TERRAIN_OFFSET,
  FLYING_AIRCRAFT_TERRAIN_OFFSET
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
const sharedPrevGroundStateRef = { current: new Map<string, boolean>() }
const sharedTransitionHeightsRef = { current: new Map<string, { source: number; target: number; progress: number }>() }

// Store subscribers for triggering re-renders
const subscribers = new Set<() => void>()

// Singleton animation loop function
function updateInterpolation() {
  performanceMonitor.startTimer('interpolation')

  const now = Date.now()

  // Track frame timing for diagnostics
  sharedLastInterpolationTimeRef.current = now

  const statesMap = sharedInterpolatedStates
  const aircraftStates = sharedAircraftStatesRef.current
  const previousStates = sharedPreviousStatesRef.current

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
      const lerpFactor = 0.2
      const newSmoothed = currentSmoothed + (sampledTerrainHeight - currentSmoothed) * lerpFactor
      sharedSmoothedTerrainHeightsRef.current.set(callsign, newSmoothed)

      // Target height: smoothed terrain + offset
      targetHeight = newSmoothed + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else if (isOnGround) {
      // Low groundspeed but no terrain sample - use fallback
      const groundEllipsoidHeight = groundElevationMeters + terrainOffset
      targetHeight = Math.max(reportedEllipsoidHeight, groundEllipsoidHeight) + GROUND_AIRCRAFT_TERRAIN_OFFSET
    } else {
      // Truly airborne: use reported altitude + terrain offset + flying offset
      targetHeight = reportedEllipsoidHeight + FLYING_AIRCRAFT_TERRAIN_OFFSET

      // Clean up smoothed terrain height for aircraft that are truly airborne
      sharedSmoothedTerrainHeightsRef.current.delete(callsign)
    }

    // Smooth transition when switching between ground/airborne states
    let correctedHeight = targetHeight
    const prevGroundState = sharedPrevGroundStateRef.current.get(callsign)

    if (prevGroundState !== undefined && prevGroundState !== isOnGround) {
      // State changed! Start a transition
      const currentTransition = sharedTransitionHeightsRef.current.get(callsign)

      if (!currentTransition || currentTransition.target !== targetHeight) {
        // Initialize new transition from current position to target
        const sourceHeight = currentTransition?.source ?? targetHeight
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
      // Lerp from source to target over ~7 frames (0.12 seconds at 60fps)
      const lerpFactor = 0.15
      transition.progress = Math.min(1.0, transition.progress + lerpFactor)
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
    sharedPrevGroundStateRef.current.set(callsign, isOnGround)

    // Apply corrected height to interpolated altitude
    entry.interpolatedAltitude = correctedHeight

    // Apply landing flare pitch adjustment
    // When aircraft is descending close to the ground, pitch nose up to emulate flare
    if (orientationEnabled && sampledTerrainHeight !== undefined) {
      // Calculate altitude above ground level (AGL)
      // Use reported altitude (not corrected) since terrain height is in ellipsoid coords
      const altitudeAGL = reportedEllipsoidHeight - sampledTerrainHeight

      entry.interpolatedPitch = calculateFlarePitch(
        entry.interpolatedPitch,
        altitudeAGL,
        entry.verticalRate,  // Already in m/min
        entry.interpolatedGroundspeed,
        orientationIntensity
      )
    }
  }

  // Remove stale entries (aircraft that are no longer in the data)
  for (const callsign of statesMap.keys()) {
    if (!activeCallsigns.has(callsign)) {
      statesMap.delete(callsign)
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
 * - Reads: vatsimStore (for current/previous aircraft states)
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
 * VATSIM API (15s updates)
 *   ↓
 * vatsimStore.aircraftStates (current/previous)
 *   ↓
 * useAircraftInterpolation (60 Hz singleton loop)
 *   ↓
 * sharedInterpolatedStates Map
 *   ↓
 * ├─ CesiumViewer (labels, culling)
 * └─ useBabylonOverlay (3D models, shadows)
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

  // Subscribe to store changes and update shared refs
  useEffect(() => {
    hookInstanceCount++

    const unsubscribeVatsim = useVatsimStore.subscribe((state) => {
      sharedAircraftStatesRef.current = state.aircraftStates
      sharedPreviousStatesRef.current = state.previousStates
    })

    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      sharedOrientationEnabledRef.current = state.aircraft.orientationEmulation
      sharedOrientationIntensityRef.current = state.aircraft.orientationIntensity
    })

    // Initialize shared refs with current state
    const vatsimState = useVatsimStore.getState()
    sharedAircraftStatesRef.current = vatsimState.aircraftStates
    sharedPreviousStatesRef.current = vatsimState.previousStates

    const settingsState = useSettingsStore.getState()
    sharedOrientationEnabledRef.current = settingsState.aircraft.orientationEmulation
    sharedOrientationIntensityRef.current = settingsState.aircraft.orientationIntensity

    // Subscribe this component to updates
    const updateCallback = () => setVersion(v => v + 1)
    subscribers.add(updateCallback)

    return () => {
      hookInstanceCount--
      unsubscribeVatsim()
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
