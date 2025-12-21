import { useEffect } from 'react'
import { useVatsimStore } from '../stores/vatsimStore'
import type { PilotData } from '../types/vatsim'

/**
 * Provides access to VATSIM network data with automatic polling and lifecycle management.
 *
 * ## Responsibilities
 * - Starts VATSIM API polling on component mount
 * - Stops polling on component unmount (cleanup)
 * - Provides reactive access to pilot data, connection status, and errors
 * - Includes helper utilities for filtering pilots by location or airport
 *
 * ## Dependencies
 * - Requires: `vatsimStore` to be initialized
 * - Reads: `vatsimStore` (pilots array, connection status, timestamps, errors)
 * - Writes: Via `startPolling()` and `stopPolling()` actions
 *
 * ## Call Order
 * This hook should be called in top-level components that need VATSIM data:
 * ```typescript
 * function App() {
 *   // Start polling and get pilot data
 *   const { pilots, isConnected, pilotCount } = useVatsimData()
 *
 *   // Data is now available to child components
 *   return <CesiumViewer pilots={pilots} />
 * }
 * ```
 *
 * **IMPORTANT:** Only call this hook **once** at the top level. Multiple calls will create
 * multiple polling intervals, wasting bandwidth and CPU.
 *
 * ## Polling Lifecycle
 *
 * The hook automatically manages the VATSIM API polling lifecycle:
 *
 * 1. **Mount**: Calls `startPolling()` to begin API requests
 * 2. **Polling**: Fetches from `https://data.vatsim.net/v3/vatsim-data.json` every 3 seconds
 * 3. **Unmount**: Calls `stopPolling()` to clean up interval
 *
 * This ensures polling only happens while components need the data.
 *
 * ## VATSIM API Details
 *
 * - **URL**: `https://data.vatsim.net/v3/vatsim-data.json`
 * - **Poll interval**: 3 seconds (client-side), but VATSIM data updates every 15 seconds (server-side)
 * - **Data format**: JSON with `pilots`, `controllers`, `atis`, `servers`, `general` fields
 * - **Rate limits**: No official limit, but frequent polling (>1/sec) is discouraged
 *
 * The 3-second poll interval ensures fresh data is fetched quickly after each 15-second server update.
 *
 * ## Return Values
 *
 * - **pilots**: Array of `PilotData` objects (all active VATSIM pilots)
 * - **isConnected**: Boolean indicating successful connection to VATSIM API
 * - **lastUpdate**: Timestamp of last successful data fetch (Date object)
 * - **error**: Error message if fetch failed (or null)
 * - **isLoading**: Boolean indicating initial data load in progress
 * - **pilotCount**: Convenience property = `pilots.length`
 *
 * ## Error Handling
 *
 * If the VATSIM API is unreachable:
 * - `isConnected` becomes `false`
 * - `error` contains the error message
 * - `pilots` array remains at last known state (not cleared)
 * - Polling continues and will reconnect when API is available
 *
 * ## Performance Considerations
 *
 * - **Network**: ~200KB JSON download every 3 seconds
 * - **Parsing**: ~5-10ms to parse JSON (typically 1000-2000 pilots)
 * - **Memory**: ~2-3MB for pilot data storage
 * - **CPU**: Negligible (polling interval handles scheduling)
 *
 * ## Helper Utilities
 *
 * The module also exports two utility functions for filtering pilots:
 *
 * ### `filterPilotsNearLocation(pilots, lat, lon, radiusNm)`
 * Filters pilots within a radius using Haversine distance formula.
 *
 * ### `filterPilotsByAirport(pilots, icao)`
 * Filters pilots by departure/arrival airport ICAO code.
 *
 * See function definitions below for usage examples.
 *
 * @returns VATSIM data and connection state
 *
 * @example
 * // Basic usage in App component
 * function App() {
 *   const { pilots, isConnected, error } = useVatsimData()
 *
 *   if (!isConnected) {
 *     return <div>Connecting to VATSIM... {error}</div>
 *   }
 *
 *   return <div>{pilots.length} pilots online</div>
 * }
 *
 * @example
 * // Using helper utilities
 * function AirportTraffic() {
 *   const { pilots } = useVatsimData()
 *
 *   // Get all pilots within 50 NM of KSFO
 *   const nearby = filterPilotsNearLocation(pilots, 37.619, -122.375, 50)
 *
 *   // Get all pilots departing/arriving KSFO
 *   const { departing, arriving, all } = filterPilotsByAirport(pilots, 'KSFO')
 *
 *   return (
 *     <div>
 *       <div>{nearby.length} pilots nearby</div>
 *       <div>{departing.length} departing, {arriving.length} arriving</div>
 *     </div>
 *   )
 * }
 *
 * @example
 * // Checking connection status
 * function StatusBar() {
 *   const { isConnected, lastUpdate, error, pilotCount } = useVatsimData()
 *
 *   return (
 *     <div>
 *       {isConnected ? (
 *         <span>Connected - {pilotCount} pilots - Updated {lastUpdate?.toLocaleTimeString()}</span>
 *       ) : (
 *         <span>Disconnected - {error}</span>
 *       )}
 *     </div>
 *   )
 * }
 *
 * @see vatsimStore - For VATSIM state management and polling logic
 * @see VatsimService - For API fetching implementation
 * @see useAircraftInterpolation - For smooth aircraft position interpolation
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
