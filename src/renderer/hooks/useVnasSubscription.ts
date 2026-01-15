/**
 * Host vNAS Subscription Hook
 *
 * In host mode (Tauri desktop app), automatically subscribes to vNAS when the user
 * selects an airport that's within the CRC session's available facilities.
 *
 * Also handles unsubscription when switching away from an airport.
 *
 * This is the host-side counterpart to useRemoteVnasSubscription.
 */

import { useEffect, useRef } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useAirportStore } from '../stores/airportStore'
import { useVnasStore } from '../stores/vnasStore'

/**
 * Normalize facility ID for vNAS lookup.
 * vNAS uses ICAO codes without K-prefix for US airports (e.g., "JFK" not "KJFK").
 */
function normalizeForVnas(icao: string): string {
  // Strip K-prefix for US airports
  if (icao.length === 4 && icao.startsWith('K')) {
    return icao.slice(1)
  }
  return icao
}

/**
 * Hook to auto-request vNAS subscription when viewing an airport (host mode).
 * Also requests unsubscription when switching away from an airport.
 * Only active in host mode (Tauri desktop app).
 */
export function useVnasSubscription(): void {
  const currentAirport = useAirportStore(state => state.currentAirport)
  const sessionFacilities = useVnasStore(state => state.sessionFacilities)
  const subscribedFacilities = useVnasStore(state => state.status.subscribedFacilities)
  const subscribeToFacility = useVnasStore(state => state.subscribeToFacility)
  const unsubscribeFromFacility = useVnasStore(state => state.unsubscribeFromFacility)

  // Track the previous airport to handle unsubscription
  const previousAirportRef = useRef<string | null>(null)

  useEffect(() => {
    // Only active in host mode (not remote browser)
    if (isRemoteMode()) return

    const currentIcao = currentAirport?.icao ?? null
    const previousIcao = previousAirportRef.current

    // Handle unsubscription from previous airport
    if (previousIcao && previousIcao !== currentIcao) {
      const previousVnasId = normalizeForVnas(previousIcao)
      const wasSubscribed = subscribedFacilities.includes(previousVnasId) || subscribedFacilities.includes(previousIcao)

      if (wasSubscribed) {
        console.log(`[VnasSubscription] Unsubscribing from ${previousIcao} (vNAS: ${previousVnasId})`)
        unsubscribeFromFacility(previousIcao)
      }
    }

    // Update the previous airport reference
    previousAirportRef.current = currentIcao

    // No current airport selected - nothing to subscribe to
    if (!currentIcao) return

    const vnasId = normalizeForVnas(currentIcao)

    // Check if this airport is available in the CRC session
    const isAvailable = sessionFacilities.includes(vnasId) || sessionFacilities.includes(currentIcao)

    if (!isAvailable) {
      // Airport not in session facilities
      return
    }

    // Check if already subscribed (using both formats)
    const isSubscribed = subscribedFacilities.includes(vnasId) || subscribedFacilities.includes(currentIcao)

    if (isSubscribed) {
      // Already subscribed
      return
    }

    // Subscribe to the facility
    console.log(`[VnasSubscription] Subscribing to ${currentIcao} (vNAS: ${vnasId})`)
    subscribeToFacility(currentIcao)
  }, [currentAirport, sessionFacilities, subscribedFacilities, subscribeToFacility, unsubscribeFromFacility])

  // Cleanup: unsubscribe when component unmounts
  useEffect(() => {
    return () => {
      if (isRemoteMode()) return

      const currentIcao = previousAirportRef.current
      if (currentIcao) {
        console.log(`[VnasSubscription] Component unmounting, unsubscribing from ${currentIcao}`)
        // Note: This may not work reliably since the component is unmounting,
        // but it's a best-effort cleanup
        unsubscribeFromFacility(currentIcao)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
