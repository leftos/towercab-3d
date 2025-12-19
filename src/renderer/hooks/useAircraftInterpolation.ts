import { useState, useEffect, useRef, useCallback } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import { interpolateAircraftState } from '../utils/interpolation'
import { debugLog } from '../utils/debugLog'
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

  // Debug: throttle logging to once per second
  const lastDebugLogRef = useRef<number>(0)

  // Animation loop that reads from refs (no stale closures)
  const updateInterpolation = useCallback(() => {
    const now = Date.now()
    const newStates = new Map<string, InterpolatedAircraftState>()

    const aircraftStates = aircraftStatesRef.current
    const previousStates = previousStatesRef.current

    // Debug logging for UAL1882 (throttled to once per second)
    const shouldLog = now - lastDebugLogRef.current > 1000

    for (const [callsign, currentState] of aircraftStates) {
      const previousState = previousStates.get(callsign)
      const interpolated = interpolateAircraftState(previousState, currentState, now)
      newStates.set(callsign, interpolated)

      // Debug UAL1882
      if (callsign === 'UAL1882' && shouldLog) {
        const interval = previousState ? currentState.timestamp - previousState.timestamp : 0
        const t = interval > 0 ? (now - currentState.timestamp) / interval : 0
        debugLog(`[Frame] UAL1882: t=${t.toFixed(3)}, prev=${previousState?.latitude.toFixed(5) ?? 'none'}, curr=${currentState.latitude.toFixed(5)}, interp=${interpolated.interpolatedLatitude.toFixed(5)}`)
        lastDebugLogRef.current = now
      }
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
