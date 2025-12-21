import { useState, useEffect } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useViewportStore } from '../stores/viewportStore'
import { interpolateAircraftState } from '../utils/interpolation'
import { performanceMonitor } from '../utils/performanceMonitor'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'

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

// Store subscribers for triggering re-renders
const subscribers = new Set<() => void>()

// Singleton animation loop function
function updateInterpolation() {
  performanceMonitor.startTimer('interpolation')

  const now = Date.now()

  // Track frame timing for diagnostics
  const frameDelta = sharedLastInterpolationTimeRef.current > 0 ? now - sharedLastInterpolationTimeRef.current : 0
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

    // Add diagnostic logging for followed aircraft only (avoid console spam)
    const mainViewport = useViewportStore.getState().viewports.find(v => v.id === 'main')
    if (callsign === mainViewport?.cameraState.followingCallsign) {
      const timeSinceUpdate = now - currentState.timestamp
      // Calculate t-value: time since last update divided by time between updates
      const deltaTime = previousState ? currentState.timestamp - previousState.timestamp : 15000
      const t = deltaTime > 0 ? timeSinceUpdate / deltaTime : 0
      const isExtrapolating = t > 1.0

      // Log every 60 frames (~1 second at 60Hz)
      if (Math.floor(now / 1000) !== Math.floor((now - 16) / 1000)) {
        const extrapolatingFlag = isExtrapolating ? ' [EXTRAPOLATING]' : ''
        const frameWarning = frameDelta > 25 ? ' ⚠️ SLOW FRAME' : ''
        console.log(
          `[Interpolation] ${callsign}${extrapolatingFlag}${frameWarning}: ` +
          `t=${t.toFixed(3)} | ${(timeSinceUpdate / 1000).toFixed(1)}s since update | ` +
          `frameDelta=${frameDelta.toFixed(1)}ms | ` +
          `pos=${interpolated.interpolatedLatitude.toFixed(6)},${interpolated.interpolatedLongitude.toFixed(6)} | ` +
          `alt=${interpolated.interpolatedAltitude.toFixed(0)}ft | ` +
          `hdg=${interpolated.interpolatedHeading.toFixed(1)}° | ` +
          `gs=${interpolated.interpolatedGroundspeed.toFixed(0)}kts`
        )
      }
    }

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
