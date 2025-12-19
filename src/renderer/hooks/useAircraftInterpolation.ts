import { useState, useEffect, useRef, useCallback } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import { interpolateAircraftState } from '../utils/interpolation'
import type { InterpolatedAircraftState, AircraftState } from '../types/vatsim'

/**
 * Hook that provides smoothly interpolated aircraft positions
 * Updates at 60fps for smooth rendering
 */
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  const [interpolatedStates, setInterpolatedStates] = useState<Map<string, InterpolatedAircraftState>>(new Map())

  // Use refs to always have latest state without re-creating the animation loop
  const aircraftStatesRef = useRef<Map<string, AircraftState>>(new Map())
  const previousStatesRef = useRef<Map<string, AircraftState>>(new Map())
  const animationFrameRef = useRef<number | null>(null)

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
    const newStates = new Map<string, InterpolatedAircraftState>()

    const aircraftStates = aircraftStatesRef.current
    const previousStates = previousStatesRef.current

    for (const [callsign, currentState] of aircraftStates) {
      const previousState = previousStates.get(callsign)
      const interpolated = interpolateAircraftState(previousState, currentState, now)
      newStates.set(callsign, interpolated)
    }

    setInterpolatedStates(newStates)

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

  return interpolatedStates
}

export default useAircraftInterpolation
