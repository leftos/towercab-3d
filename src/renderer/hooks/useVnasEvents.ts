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
import { useAirportStore } from '../stores/airportStore'
import { useVnasStore } from '../stores/vnasStore'
import type { VnasAircraft, VnasStatus } from '../types/vnas'
import { isRemoteMode } from '../utils/remoteMode'

type SessionState = VnasStatus['state']

// Module-level flag to prevent double initialization from React Strict Mode.
// Using module-level instead of useRef because Strict Mode unmount/remount
// would reset the ref, but we want to prevent the second initialization entirely.
let vnasInitialized = false

export function useVnasEvents(): void {
  const handleAircraftUpdate = useVnasStore((state) => state.handleAircraftUpdate)
  const removeAircraft = useVnasStore((state) => state.removeAircraft)
  const setStateOnly = useVnasStore((state) => state.setStateOnly)
  const setError = useVnasStore((state) => state.setError)
  const tryRestoreSession = useVnasStore((state) => state.tryRestoreSession)
  const connect = useVnasStore((state) => state.connect)
  const subscribe = useVnasStore((state) => state.subscribe)
  const isSubscribedTo = useVnasStore((state) => state.isSubscribedTo)
  const getSessionArtcc = useVnasStore((state) => state.getSessionArtcc)
  const getSessionAirports = useVnasStore((state) => state.getSessionAirports)
  const vnasState = useVnasStore((state) => state.status.state)
  const _subscribedFacilities = useVnasStore((state) => state.status.subscribedFacilities)
  const currentAirport = useAirportStore((state) => state.currentAirport)

  // Auto-subscribe when airport changes and vNAS is ready
  // This handles the race condition where vNAS connects before airport is loaded
  useEffect(() => {
    if (isRemoteMode()) return

    // Only auto-subscribe when vNAS is in 'subscribing' state (connected but not subscribed yet)
    // and we have a current airport that we're not already subscribed to
    const icao = currentAirport?.icao
    if (vnasState === 'subscribing' && icao && !isSubscribedTo(icao)) {
      console.log('[vNAS] Auto-subscribing to airport:', icao)
      subscribe(icao).catch((err) => {
        console.warn('[vNAS] Failed to auto-subscribe to airport:', err)
      })
    }
  }, [vnasState, currentAirport?.icao, subscribe, isSubscribedTo])

  useEffect(() => {
    // Only set up listeners in Tauri mode (not remote browser)
    if (isRemoteMode()) {
      return
    }

    // Prevent double initialization from React Strict Mode
    if (vnasInitialized) {
      console.log('[vNAS] Already initialized, skipping (Strict Mode protection)')
      return
    }
    vnasInitialized = true

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
          // Update just the state field using functional update to avoid race conditions
          setStateOnly(event.payload)

          // Broadcast vNAS state to remote browsers
          const { invoke } = await import('@tauri-apps/api/core')
          invoke('broadcast_vnas_state', { state: event.payload }).catch(() => {})

          // Fetch session info when we've joined a session (subscribing or connected state)
          if (event.payload === 'subscribing' || event.payload === 'connected') {
            try {
              // Fetch ARTCC and resolved airport list for debugging and UI
              const [artcc, airports] = await Promise.all([getSessionArtcc(), getSessionAirports()])
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
        // This is an explicit message from the SignalR hub that the aircraft should be removed.
        // Different from simply not receiving updates (idle aircraft at gate).
        unlistenDisconnected = await listen<string>('vnas-aircraft-disconnected', (event) => {
          console.log('[vNAS] Aircraft disconnected:', event.payload)
          removeAircraft(event.payload)
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

            // Fetch session info (airports available for 1Hz updates)
            try {
              const [artcc, airports] = await Promise.all([getSessionArtcc(), getSessionAirports()])
              console.log('[vNAS] Session info after restore - ARTCC:', artcc, 'Airports:', airports)
            } catch (err) {
              console.warn('[vNAS] Failed to fetch session info after restore:', err)
            }

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
  }, [
    handleAircraftUpdate,
    removeAircraft,
    setStateOnly,
    setError,
    tryRestoreSession,
    connect,
    subscribe,
    getSessionArtcc,
    getSessionAirports,
  ])
}
