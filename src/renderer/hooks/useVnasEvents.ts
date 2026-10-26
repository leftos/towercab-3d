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
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useUIFeedbackStore } from '../stores/uiFeedbackStore'
import { useVatsimStore } from '../stores/vatsimStore'
import { useVnasStore } from '../stores/vnasStore'
import type { VnasAircraft, VnasStatus } from '../types/vnas'
import { isRemoteMode } from '../utils/remoteMode'
import { decideRoomAirport } from '../utils/roomAirport'
import { getRoomAirportNotice } from '../utils/vnasStatusText'

type SessionState = VnasStatus['state']

/** How long the toast saying a room's airport has no tower view stays up */
const ROOM_AIRPORT_NOTICE_TOAST_MS = 5000

/**
 * Follow the session joined at `serial` (after the store has read its kind and airports):
 * a YAAT room takes the view to its airport, or keeps the current one with a notice when
 * that airport has no tower view. Then subscribe the airport in view, since the hub dropped
 * the old session's subscriptions. Runs once per join, and not at all once a newer join or
 * a disconnect has replaced it; a `connected` from the same session does not stop it.
 */
async function followJoinedSession(serial: number): Promise<void> {
  const vnas = useVnasStore.getState()
  if (vnas.joinSerial !== serial || !vnas.followPending) {
    return
  }
  vnas.clearFollowPending()
  if (vnas.status.state !== 'subscribing' && vnas.status.state !== 'connected') {
    return
  }
  const airportStore = useAirportStore.getState()
  const decision = decideRoomAirport({
    sessionKind: vnas.status.sessionKind,
    isRemote: isRemoteMode(),
    facilityId: vnas.sessionFacilities[0] ?? '',
    hasAirport: (icao) => airportStore.airports.has(icao),
    currentIcao: airportStore.currentAirport?.icao ?? null,
  })
  if (decision.action === 'switch') {
    console.log('[vNAS] Following the room to its airport:', decision.icao)
    // RealTraffic remote browsers stay at their own airport when the room moves this one
    airportStore.selectAirport(decision.icao, { skipRealTrafficBroadcast: true })
  } else if (decision.action === 'notice') {
    const notice = getRoomAirportNotice(decision.facilityId)
    console.log(`[vNAS] ${notice}`)
    vnas.setRoomAirportNotice(notice)
    useUIFeedbackStore.getState().showFeedback(notice, 'info', ROOM_AIRPORT_NOTICE_TOAST_MS)
  }

  const icao = useAirportStore.getState().currentAirport?.icao
  if (icao) {
    await vnas.subscribeToFacility(icao, { fromFollow: true }).catch((err) => {
      console.warn('[vNAS] Failed to subscribe after joining a session:', err)
    })
  }
}

/**
 * Stop the VATSIM feed while connected to a non-Live environment, so data from different
 * environments never blends, and restart it on disconnect when VATSIM is the data source.
 */
function applyDataFeedPolicy(state: SessionState): void {
  const vnasEnv = useVnasStore.getState().status.environment
  if (state === 'connected' && vnasEnv !== 'live') {
    console.log(`[vNAS] Connected to ${vnasEnv} — stopping VATSIM data feed polling`)
    useVatsimStore.getState().stopPolling()
  }

  // followSessionState drops an ended session's aircraft, facility lists and vNAS
  // observations at disconnected, waitingForSession and subscribing. Only a disconnect
  // leaves the environment, so only it restarts VATSIM polling, if that's the active data source.
  if (state === 'disconnected') {
    const dataSource = useGlobalSettingsStore.getState().realtraffic.dataSource
    if (dataSource !== 'realtraffic') {
      console.log('[vNAS] Disconnected — resuming VATSIM data feed polling')
      useVatsimStore.getState().startPolling()
    }
  }
}

/** Fetch the joined session's ARTCC and resolved airport list, for debugging and the UI */
async function logSessionInfo(): Promise<void> {
  const vnas = useVnasStore.getState()
  try {
    const [artcc, airports] = await Promise.all([vnas.getSessionArtcc(), vnas.getSessionAirports()])
    console.log('[vNAS] Session info - ARTCC:', artcc, 'Airports:', airports)
  } catch (err) {
    console.warn('[vNAS] Failed to fetch session info:', err)
  }
}

/**
 * Handle one `vnas-state-changed` event: apply the state, tell remote browsers, set the
 * VATSIM feed for it, and follow a joined session.
 */
export async function handleSessionStateEvent(state: SessionState): Promise<void> {
  console.log('[vNAS] State changed:', state)
  // Applies the state now, a join's serial included; the status re-read that goes with it
  // (how the last session ended, the joined session's kind) is awaited below
  const following = useVnasStore.getState().followSessionState(state)
  const serial = useVnasStore.getState().joinSerial

  // Broadcast vNAS state to remote browsers
  const { invoke } = await import('@tauri-apps/api/core')
  invoke('broadcast_vnas_state', { state }).catch(() => {})

  applyDataFeedPolicy(state)

  await following
  if (state === 'subscribing') {
    await followJoinedSession(serial)
  }
  if (state === 'subscribing' || state === 'connected') {
    await logSessionInfo()
  }
}

// Module-level flag to prevent double initialization from React Strict Mode.
// Using module-level instead of useRef because Strict Mode unmount/remount
// would reset the ref, but we want to prevent the second initialization entirely.
let vnasInitialized = false

export function useVnasEvents(): void {
  const handleAircraftUpdate = useVnasStore((state) => state.handleAircraftUpdate)
  const removeAircraft = useVnasStore((state) => state.removeAircraft)
  const setError = useVnasStore((state) => state.setError)
  const tryRestoreSession = useVnasStore((state) => state.tryRestoreSession)
  const connect = useVnasStore((state) => state.connect)
  const subscribeToFacility = useVnasStore((state) => state.subscribeToFacility)
  const setSubscribedFacilities = useVnasStore((state) => state.setSubscribedFacilities)
  const isSubscribedTo = useVnasStore((state) => state.isSubscribedTo)
  const getSessionArtcc = useVnasStore((state) => state.getSessionArtcc)
  const getSessionAirports = useVnasStore((state) => state.getSessionAirports)
  const vnasState = useVnasStore((state) => state.status.state)
  const subscribedFacilities = useVnasStore((state) => state.status.subscribedFacilities)
  const currentAirport = useAirportStore((state) => state.currentAirport)

  // Auto-subscribe when airport changes and vNAS is ready.
  // This handles the race condition where vNAS connects before airport is loaded.
  // subscribedFacilities is in deps so the effect re-fires when a sibling subscription
  // completes during the same 'subscribing' state — multiple concurrent facility subscriptions
  // are a real scenario. The !isSubscribedTo(icao) guard prevents double-fire.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribedFacilities triggers re-evaluation when a concurrent sibling subscription completes
  useEffect(() => {
    if (isRemoteMode()) return

    // Only auto-subscribe when vNAS is in 'subscribing' state (connected but not subscribed yet)
    // and we have a current airport that we're not already subscribed to
    const icao = currentAirport?.icao
    if (vnasState === 'subscribing' && icao && !isSubscribedTo(icao)) {
      console.log('[vNAS] Auto-subscribing to airport:', icao)
      subscribeToFacility(icao).catch((err) => {
        console.warn('[vNAS] Failed to auto-subscribe to airport:', err)
      })
    }
  }, [vnasState, currentAirport?.icao, subscribeToFacility, isSubscribedTo, subscribedFacilities])

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
    let unlistenSubscriptions: (() => void) | null = null

    const setupListenersAndRestore = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')

        // Listen for state changes
        unlistenState = await listen<SessionState>('vnas-state-changed', (event) =>
          handleSessionStateEvent(event.payload),
        )

        // Listen for aircraft updates
        unlistenAircraft = await listen<VnasAircraft>('vnas-aircraft-update', (event) => {
          handleAircraftUpdate(event.payload)
        })

        // Listen for the host's subscribed-facility list (the source of truth).
        // The backend clears it when the session ends.
        unlistenSubscriptions = await listen<string[]>('vnas-subscriptions-changed', (event) => {
          setSubscribedFacilities(event.payload)
        })

        // Listen for aircraft disconnections
        // An explicit message from the SignalR hub that the aircraft's vNAS feed is
        // over — different from simply not receiving updates (idle aircraft at gate).
        // removeAircraft() drops its vNAS observations from the timeline, so it falls
        // back to VATSIM when VATSIM also reports it.
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
              await subscribeToFacility(currentAirport.icao)
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
      unlistenSubscriptions?.()
    }
  }, [
    handleAircraftUpdate,
    removeAircraft,
    setError,
    tryRestoreSession,
    connect,
    subscribeToFacility,
    setSubscribedFacilities,
    getSessionArtcc,
    getSessionAirports,
  ])
}
