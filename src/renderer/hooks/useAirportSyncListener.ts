/**
 * Airport Sync Listener Hook
 *
 * Listens to airport synchronization changes in remote mode when RealTraffic
 * is active. Automatically changes the local airport to match the host's
 * selected airport.
 *
 * This is required because RealTraffic uses a bounding box query, so all
 * clients must be viewing the same airport to receive observations.
 */

import { useEffect, useRef } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useRemoteStatusStore } from '../stores/remoteStatusStore'
import { useAirportStore } from '../stores/airportStore'

/**
 * Hook to handle airport synchronization in remote mode.
 * When RealTraffic is active on the host, all clients must view the same airport.
 *
 * Call this hook once at the app level (e.g., in App.tsx).
 */
export function useAirportSyncListener(): void {
  const syncedAirport = useRemoteStatusStore(state => state.syncedAirport)
  const realtrafficActive = useRemoteStatusStore(state => state.realtrafficActive)
  const currentAirport = useAirportStore(state => state.currentAirport)
  const selectAirport = useAirportStore(state => state.selectAirport)
  const isLoaded = useAirportStore(state => state.isLoaded)

  // Track if this is the initial sync (avoid changing on first load)
  const initialSyncRef = useRef(true)

  useEffect(() => {
    // Only relevant in remote mode
    if (!isRemoteMode()) return

    // Only sync when RealTraffic is active
    if (!realtrafficActive) {
      initialSyncRef.current = true
      return
    }

    // Wait for airport database to load
    if (!isLoaded) return

    // On first sync, just record the current state
    if (initialSyncRef.current) {
      initialSyncRef.current = false
      // If we don't have an airport yet but host does, select it
      if (!currentAirport && syncedAirport) {
        console.log('[AirportSyncListener] Initial sync to host airport:', syncedAirport)
        selectAirport(syncedAirport)
      }
      return
    }

    // If synced airport differs from current, change to it
    if (syncedAirport && syncedAirport !== currentAirport?.icao) {
      console.log('[AirportSyncListener] Syncing to host airport:', syncedAirport, '(was:', currentAirport?.icao, ')')
      selectAirport(syncedAirport)
    }
  }, [syncedAirport, realtrafficActive, currentAirport, selectAirport, isLoaded])
}
