/**
 * Auto-airport switching hook
 *
 * Monitors camera position and automatically switches to the nearest airport
 * when the camera moves far enough from the current airport.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAirportStore } from '@/stores/airportStore'
import type { Airport } from '@/types'
import {
  AUTO_SWITCH_CHECK_INTERVAL_MS,
  AUTO_SWITCH_HYSTERESIS_NM,
  AUTO_SWITCH_MIN_DISTANCE_NM
} from '@/constants'

// Earth radius in nautical miles for haversine calculation
const EARTH_RADIUS_NM = 3440.065

/**
 * Calculate distance between two coordinates using haversine formula
 * @returns Distance in nautical miles
 */
function haversineDistanceNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_NM * c
}

interface UseAutoAirportSwitchOptions {
  /** Camera position in lat/lon */
  cameraPosition: { lat: number; lon: number } | null
  /** Whether the feature is enabled */
  enabled: boolean
}

interface UseAutoAirportSwitchResult {
  /** Nearest airport to camera */
  nearestAirport: Airport | null
  /** Distance to current airport (NM) */
  distanceToCurrentNM: number | null
  /** Distance to nearest airport (NM) */
  distanceToNearestNM: number | null
  /** Whether a switch is recommended */
  shouldSwitch: boolean
  /** Manually trigger the switch */
  performSwitch: () => void
}

/**
 * Hook for auto-switching to the nearest airport based on camera position
 *
 * When enabled, monitors the camera position and automatically switches
 * to the nearest airport when:
 * 1. The camera is more than hysteresis distance from current airport
 * 2. A different airport is significantly closer
 *
 * @param options Configuration options
 * @returns Auto-switch state and controls
 */
export function useAutoAirportSwitch(
  options: UseAutoAirportSwitchOptions
): UseAutoAirportSwitchResult {
  const { cameraPosition, enabled } = options

  // Store state
  const airports = useAirportStore((state) => state.airports)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const selectAirport = useAirportStore((state) => state.selectAirport)

  // Local state
  const [nearestAirport, setNearestAirport] = useState<Airport | null>(null)
  const [distanceToCurrentNM, setDistanceToCurrentNM] = useState<number | null>(null)
  const [distanceToNearestNM, setDistanceToNearestNM] = useState<number | null>(null)
  const [shouldSwitch, setShouldSwitch] = useState(false)

  // Refs for throttling
  const lastCheckRef = useRef<number>(0)
  const lastSwitchRef = useRef<string | null>(null) // ICAO of last switched airport

  /**
   * Find the nearest airport to a given position
   */
  const findNearestAirport = useCallback(
    (lat: number, lon: number): { airport: Airport; distance: number } | null => {
      if (airports.size === 0) return null

      let nearest: Airport | null = null
      let nearestDistance = Infinity

      for (const airport of airports.values()) {
        const distance = haversineDistanceNM(lat, lon, airport.lat, airport.lon)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearest = airport
        }
      }

      return nearest ? { airport: nearest, distance: nearestDistance } : null
    },
    [airports]
  )

  /**
   * Perform the switch to the nearest airport
   */
  const performSwitch = useCallback(() => {
    if (nearestAirport && nearestAirport.icao !== currentAirport?.icao) {
      lastSwitchRef.current = nearestAirport.icao
      selectAirport(nearestAirport.icao)
    }
  }, [nearestAirport, currentAirport?.icao, selectAirport])

  /**
   * Check if auto-switch should occur
   */
  useEffect(() => {
    if (!enabled || !cameraPosition) {
      setNearestAirport(null)
      setDistanceToCurrentNM(null)
      setDistanceToNearestNM(null)
      setShouldSwitch(false)
      return
    }

    // Throttle checks
    const now = Date.now()
    if (now - lastCheckRef.current < AUTO_SWITCH_CHECK_INTERVAL_MS) {
      return
    }
    lastCheckRef.current = now

    // Find nearest airport
    const nearestResult = findNearestAirport(cameraPosition.lat, cameraPosition.lon)
    if (!nearestResult) {
      setNearestAirport(null)
      setDistanceToNearestNM(null)
      setShouldSwitch(false)
      return
    }

    setNearestAirport(nearestResult.airport)
    setDistanceToNearestNM(nearestResult.distance)

    // Calculate distance to current airport
    let currentDistance: number | null = null
    if (currentAirport) {
      currentDistance = haversineDistanceNM(
        cameraPosition.lat,
        cameraPosition.lon,
        currentAirport.lat,
        currentAirport.lon
      )
      setDistanceToCurrentNM(currentDistance)
    } else {
      setDistanceToCurrentNM(null)
    }

    // Determine if we should switch
    // Don't switch if:
    // 1. No current airport (let user pick first)
    // 2. Nearest is the current airport
    // 3. Recently switched to this airport (hysteresis)
    // 4. Distance to nearest is below minimum threshold
    if (!currentAirport) {
      setShouldSwitch(false)
      return
    }

    const isSameAirport = nearestResult.airport.icao === currentAirport.icao
    const recentlySwitch = lastSwitchRef.current === nearestResult.airport.icao
    const tooClose = nearestResult.distance < AUTO_SWITCH_MIN_DISTANCE_NM

    if (isSameAirport || tooClose) {
      setShouldSwitch(false)
      // Clear recent switch memory if we're back at current airport
      if (isSameAirport) {
        lastSwitchRef.current = null
      }
      return
    }

    // Apply hysteresis: only switch if we're significantly closer to the new airport
    // and far enough from the current airport
    const distanceDiff = currentDistance !== null
      ? currentDistance - nearestResult.distance
      : 0

    const shouldSwitchNow =
      !recentlySwitch &&
      distanceDiff > AUTO_SWITCH_HYSTERESIS_NM

    setShouldSwitch(shouldSwitchNow)

    // Auto-perform switch when conditions are met
    if (shouldSwitchNow) {
      lastSwitchRef.current = nearestResult.airport.icao
      selectAirport(nearestResult.airport.icao)
    }
  }, [
    enabled,
    cameraPosition,
    currentAirport,
    findNearestAirport,
    selectAirport
  ])

  // Reset recent switch tracking when current airport changes externally
  useEffect(() => {
    if (currentAirport?.icao !== lastSwitchRef.current) {
      lastSwitchRef.current = null
    }
  }, [currentAirport?.icao])

  return {
    nearestAirport,
    distanceToCurrentNM,
    distanceToNearestNM,
    shouldSwitch,
    performSwitch
  }
}
