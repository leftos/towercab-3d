import { useState, useEffect, useRef, useCallback } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import { useSettingsStore } from '../stores/settingsStore'
import { interpolateAircraftState } from '../utils/interpolation'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'

/**
 * Hook that provides smoothly interpolated aircraft positions
 * Updates at 60fps for smooth rendering
 *
 * Memory optimization: Reuses a single Map and only creates new entries when needed
 */
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  // Use a ref for the mutable map to avoid GC pressure from creating new Maps every frame
  const interpolatedStatesRef = useRef<Map<string, InterpolatedAircraftState>>(new Map())
  // Version counter to trigger re-renders when data changes
  const [, setVersion] = useState(0)

  // Use refs to always have latest state without re-creating the animation loop
  const aircraftStatesRef = useRef<Map<string, AircraftState>>(new Map())
  const previousStatesRef = useRef<Map<string, AircraftState>>(new Map())
  const animationFrameRef = useRef<number | null>(null)
  const lastAircraftCountRef = useRef(0)

  // Orientation settings refs
  const orientationEnabledRef = useRef(true)
  const orientationIntensityRef = useRef(1.0)

  // Subscribe to store changes and update refs
  useEffect(() => {
    const unsubscribeVatsim = useVatsimStore.subscribe((state) => {
      aircraftStatesRef.current = state.aircraftStates
      previousStatesRef.current = state.previousStates
    })

    const unsubscribeSettings = useSettingsStore.subscribe((state) => {
      orientationEnabledRef.current = state.orientationEmulation
      orientationIntensityRef.current = state.orientationIntensity
    })

    // Initialize refs with current state
    const vatsimState = useVatsimStore.getState()
    aircraftStatesRef.current = vatsimState.aircraftStates
    previousStatesRef.current = vatsimState.previousStates

    const settingsState = useSettingsStore.getState()
    orientationEnabledRef.current = settingsState.orientationEmulation
    orientationIntensityRef.current = settingsState.orientationIntensity

    return () => {
      unsubscribeVatsim()
      unsubscribeSettings()
    }
  }, [])

  // Animation loop that reads from refs (no stale closures)
  const updateInterpolation = useCallback(() => {
    const now = Date.now()
    const statesMap = interpolatedStatesRef.current
    const aircraftStates = aircraftStatesRef.current
    const previousStates = previousStatesRef.current

    // Track which callsigns are still active
    const activeCallsigns = new Set<string>()

    const orientationEnabled = orientationEnabledRef.current
    const orientationIntensity = orientationIntensityRef.current

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

    // Only trigger React re-render when aircraft count changes
    // This dramatically reduces React overhead while still updating positions
    const currentCount = statesMap.size
    if (currentCount !== lastAircraftCountRef.current) {
      lastAircraftCountRef.current = currentCount
      setVersion(v => v + 1)
    }

    // Schedule next frame
    animationFrameRef.current = requestAnimationFrame(updateInterpolation)
  }, [])

  // Start animation loop once
  useEffect(() => {
    animationFrameRef.current = requestAnimationFrame(updateInterpolation)

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [updateInterpolation])

  return interpolatedStatesRef.current
}

export default useAircraftInterpolation
