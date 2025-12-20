import { useState, useEffect, useRef, useCallback } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
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

  // Subscribe to store changes and update refs
  useEffect(() => {
    const unsubscribe = useVatsimStore.subscribe((state) => {
      aircraftStatesRef.current = state.aircraftStates
      previousStatesRef.current = state.previousStates
    })

    // Initialize refs with current state
    const state = useVatsimStore.getState()
    aircraftStatesRef.current = state.aircraftStates
    previousStatesRef.current = state.previousStates

    return unsubscribe
  }, [])

  // Animation loop that reads from refs (no stale closures)
  const updateInterpolation = useCallback(() => {
    const now = Date.now()
    const statesMap = interpolatedStatesRef.current
    const aircraftStates = aircraftStatesRef.current
    const previousStates = previousStatesRef.current

    // Track which callsigns are still active
    const activeCallsigns = new Set<string>()

    for (const [callsign, currentState] of aircraftStates) {
      activeCallsigns.add(callsign)
      const previousState = previousStates.get(callsign)
      const interpolated = interpolateAircraftState(previousState, currentState, now)

      // Reuse existing entry or create new one
      const existing = statesMap.get(callsign)
      if (existing) {
        // Update in place to avoid object allocation
        existing.callsign = interpolated.callsign
        existing.interpolatedLatitude = interpolated.interpolatedLatitude
        existing.interpolatedLongitude = interpolated.interpolatedLongitude
        existing.interpolatedAltitude = interpolated.interpolatedAltitude
        existing.interpolatedGroundspeed = interpolated.interpolatedGroundspeed
        existing.interpolatedHeading = interpolated.interpolatedHeading
        existing.aircraftType = interpolated.aircraftType
        existing.departure = interpolated.departure
        existing.arrival = interpolated.arrival
        existing.isInterpolated = interpolated.isInterpolated
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
