/**
 * Hook to set up vNAS Tauri event listeners and auto-restore session.
 *
 * This hook:
 * - Sets up event listeners for real-time updates from the Rust backend
 * - Attempts to restore a previous vNAS session on app startup
 * - Auto-connects if valid tokens are found
 *
 * Should be called once at app initialization (e.g., in App.tsx).
 */
import { useEffect } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useVnasStore } from '../stores/vnasStore'
import { useAirportStore } from '../stores/airportStore'
import type { VnasAircraft, VnasStatus } from '../types/vnas'

type SessionState = VnasStatus['state']

export function useVnasEvents(): void {
  const handleAircraftUpdate = useVnasStore(state => state.handleAircraftUpdate)
  const setStatus = useVnasStore(state => state.setStatus)
  const setError = useVnasStore(state => state.setError)
  const tryRestoreSession = useVnasStore(state => state.tryRestoreSession)
  const connect = useVnasStore(state => state.connect)
  const subscribe = useVnasStore(state => state.subscribe)
  const getSessionArtcc = useVnasStore(state => state.getSessionArtcc)
  const getSessionAirports = useVnasStore(state => state.getSessionAirports)

  useEffect(() => {
    // Only set up listeners in Tauri mode (not remote browser)
    if (isRemoteMode()) {
      return
    }

    let unlistenState: (() => void) | null = null
    let unlistenAircraft: (() => void) | null = null
    let unlistenDisconnected: (() => void) | null = null
    let unlistenError: (() => void) | null = null

    const setupListenersAndRestore = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')

        // Listen for state changes
        unlistenState = await listen<SessionState>('vnas-state-changed', async (event) => {
          console.log('[vNAS] State changed:', event.payload)
          // Update status with new state while preserving other fields
          const currentStatus = useVnasStore.getState().status
          setStatus({
            ...currentStatus,
            state: event.payload
          })

          // Fetch session info when we've joined a session (subscribing or connected state)
          if (event.payload === 'subscribing' || event.payload === 'connected') {
            try {
              // Fetch ARTCC and resolved airport list for debugging and UI
              const [artcc, airports] = await Promise.all([
                getSessionArtcc(),
                getSessionAirports()
              ])
              console.log('[vNAS] Session info - ARTCC:', artcc, 'Airports:', airports)
            } catch (err) {
              console.warn('[vNAS] Failed to fetch session info:', err)
            }
          }
        })

        // Listen for aircraft updates
        unlistenAircraft = await listen<VnasAircraft>('vnas-aircraft-update', (event) => {
          handleAircraftUpdate(event.payload)
        })

        // Listen for aircraft disconnections
        unlistenDisconnected = await listen<string>('vnas-aircraft-disconnected', (event) => {
          console.log('[vNAS] Aircraft disconnected:', event.payload)
          // TODO: Remove aircraft from store if needed
        })

        // Listen for errors
        unlistenError = await listen<string>('vnas-error', (event) => {
          console.error('[vNAS] Error:', event.payload)
          setError(event.payload)
        })

        console.log('[vNAS] Event listeners set up')

        // Try to restore previous session
        console.log('[vNAS] Attempting to restore previous session...')
        const restored = await tryRestoreSession('live')
        if (restored) {
          console.log('[vNAS] Session restored, connecting...')
          try {
            await connect()
            console.log('[vNAS] Connected after session restore')

            // Auto-subscribe to current airport if one is selected
            const currentAirport = useAirportStore.getState().currentAirport
            if (currentAirport?.icao) {
              console.log('[vNAS] Auto-subscribing to:', currentAirport.icao)
              await subscribe(currentAirport.icao)
            }
          } catch (err) {
            console.warn('[vNAS] Failed to connect after restore:', err)
          }
        } else {
          console.log('[vNAS] No valid session to restore')
        }
      } catch (error) {
        console.warn('[vNAS] Failed to set up event listeners:', error)
      }
    }

    setupListenersAndRestore()

    // Cleanup on unmount
    return () => {
      unlistenState?.()
      unlistenAircraft?.()
      unlistenDisconnected?.()
      unlistenError?.()
    }
  }, [handleAircraftUpdate, setStatus, setError, tryRestoreSession, connect, subscribe, getSessionArtcc, getSessionAirports])
}
