import { useEffect } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import type { PilotData } from '../types/vatsim'

/**
 * Hook for accessing VATSIM data with automatic polling
 */
export function useVatsimData() {
  const pilots = useVatsimStore((state) => state.pilots)
  const isConnected = useVatsimStore((state) => state.isConnected)
  const lastUpdate = useVatsimStore((state) => state.lastUpdate)
  const error = useVatsimStore((state) => state.error)
  const isLoading = useVatsimStore((state) => state.isLoading)
  const startPolling = useVatsimStore((state) => state.startPolling)
  const stopPolling = useVatsimStore((state) => state.stopPolling)

  // Start polling on mount
  useEffect(() => {
    startPolling()

    return () => {
      stopPolling()
    }
  }, [startPolling, stopPolling])

  return {
    pilots,
    isConnected,
    lastUpdate,
    error,
    isLoading,
    pilotCount: pilots.length
  }
}

/**
 * Get pilots near a specific location
 */
export function filterPilotsNearLocation(
  pilots: PilotData[],
  latitude: number,
  longitude: number,
  radiusNm: number
): PilotData[] {
  const R = 3440.065 // Earth radius in nautical miles

  return pilots.filter((pilot) => {
    const dLat = (pilot.latitude - latitude) * Math.PI / 180
    const dLon = (pilot.longitude - longitude) * Math.PI / 180

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(latitude * Math.PI / 180) *
      Math.cos(pilot.latitude * Math.PI / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2)

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    const distance = R * c

    return distance <= radiusNm
  })
}

/**
 * Get pilots filtered by departure/arrival airport
 */
export function filterPilotsByAirport(
  pilots: PilotData[],
  icao: string
): { departing: PilotData[]; arriving: PilotData[]; all: PilotData[] } {
  const normalizedIcao = icao.toUpperCase()

  const departing = pilots.filter(
    (p) => p.flight_plan?.departure?.toUpperCase() === normalizedIcao
  )
  const arriving = pilots.filter(
    (p) => p.flight_plan?.arrival?.toUpperCase() === normalizedIcao
  )
  const all = [...new Set([...departing, ...arriving])]

  return { departing, arriving, all }
}

export default useVatsimData
