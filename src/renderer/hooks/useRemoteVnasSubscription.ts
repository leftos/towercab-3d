/**
 * Remote vNAS Subscription Hook
 *
 * In remote mode, automatically requests vNAS subscription when the user
 * views an airport that's within the host's available facilities.
 *
 * This enables remote clients to get 1Hz vNAS data for their selected airport
 * without the host needing to manually subscribe to every facility.
 *
 * Also handles unsubscription when switching away from an airport.
 */

import { useEffect, useRef, useMemo } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useAirportStore } from '../stores/airportStore'
import { useVnasStore } from '../stores/vnasStore'
import { requestRemoteSubscription, requestRemoteUnsubscription } from './useRemoteObservations'

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
 * Hook to auto-request vNAS subscription when viewing an airport.
 * Also requests unsubscription when switching away from an airport.
 * Only active in remote mode.
 */
export function useRemoteVnasSubscription(): void {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const sessionFacilitiesRaw = useVnasStore((state) => state.sessionFacilities)
  const sessionFacilities = useMemo(() => sessionFacilitiesRaw ?? [], [sessionFacilitiesRaw])
  const subscribedFacilities = useVnasStore((state) => state.status.subscribedFacilities)

  // Track the previous airport to handle unsubscription
  const previousAirportRef = useRef<string | null>(null)

  useEffect(() => {
    // Only active in remote mode
    if (!isRemoteMode()) return

    const currentIcao = currentAirport?.icao ?? null
    const previousIcao = previousAirportRef.current

    // Handle unsubscription from previous airport
    if (previousIcao && previousIcao !== currentIcao) {
      const previousVnasId = normalizeForVnas(previousIcao)
      const wasSubscribed = subscribedFacilities.includes(previousVnasId) || subscribedFacilities.includes(previousIcao)

      if (wasSubscribed) {
        console.log(`[RemoteVnasSubscription] Requesting unsubscription from ${previousIcao} (vNAS: ${previousVnasId})`)
        requestRemoteUnsubscription(previousVnasId)
      }
    }

    // Update the previous airport reference
    previousAirportRef.current = currentIcao

    // No current airport selected - nothing to subscribe to
    if (!currentIcao) return

    const vnasId = normalizeForVnas(currentIcao)

    // Check if this airport is available in the host's CRC session
    const isAvailable = sessionFacilities.includes(vnasId) || sessionFacilities.includes(currentIcao)

    if (!isAvailable) {
      // Airport not in host's session facilities
      return
    }

    // Check if already subscribed (using both formats)
    const isSubscribed = subscribedFacilities.includes(vnasId) || subscribedFacilities.includes(currentIcao)

    if (isSubscribed) {
      // Already subscribed
      return
    }

    // Request subscription from host
    console.log(`[RemoteVnasSubscription] Requesting subscription for ${currentIcao} (vNAS: ${vnasId})`)
    requestRemoteSubscription(vnasId)
  }, [currentAirport, sessionFacilities, subscribedFacilities])

  // Cleanup: unsubscribe when component unmounts (client disconnects)
  useEffect(() => {
    return () => {
      if (!isRemoteMode()) return

      const currentIcao = previousAirportRef.current
      if (currentIcao) {
        const vnasId = normalizeForVnas(currentIcao)
        console.log(`[RemoteVnasSubscription] Component unmounting, requesting unsubscription from ${currentIcao}`)
        requestRemoteUnsubscription(vnasId)
      }
    }
  }, [])
}
