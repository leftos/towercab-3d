import { create, type StoreApi } from 'zustand'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'
import { geoidService } from '../services/GeoidService'
import type { AircraftMetadata, AircraftObservation } from '../types/aircraft-timeline'
import type { AircraftState } from '../types/vatsim'
import type { VnasAircraft, VnasEnvironment, VnasStatus } from '../types/vnas'
import { urlWithoutQuery } from '../utils/redactUrl'
import { isRemoteMode } from '../utils/remoteMode'
import { addAircraftRemovalListener, useAircraftTimelineStore } from './aircraftTimelineStore'
import { useSettingsStore } from './settingsStore'

/** Feet to meters conversion factor */
const FEET_TO_METERS = 0.3048

/** Last processed OAuth callback URL (for frontend-side deduplication) */
let lastProcessedOAuthCallback: string | null = null

/**
 * Speed history for windowed averaging.
 * Stores recent speed samples per aircraft to smooth out GPS jitter.
 */
const speedHistory = new Map<string, number[]>()

/**
 * Ground state hysteresis tracking per aircraft, for the observation's `onGround` flag.
 * The flag is for labels only: drawn height, pitch and ground contact come from the height above ground each
 * observation carries (`heightAboveGround`, raw: vNAS measures a reference point, so an aircraft at rest reads its
 * resting height, which varies by type and by simulator). The interpolation loop measures it over the aircraft's
 * learned resting height (its own, else its type's; `utils/aircraft/restingHeight.ts`), or uses the drop rule while it
 * has none, to decide contact per frame.
 * The hysteresis keeps the flag from toggling when AGL oscillates near the threshold.
 *
 * Enter ground: AGL < 50ft, Exit ground: AGL > 80ft
 */
const groundStateHistory = new Map<string, boolean>()
const GROUND_ENTER_AGL_FT = 50
const GROUND_EXIT_AGL_FT = 80

/** Determine on-ground state with hysteresis to prevent oscillation */
function getOnGroundWithHysteresis(callsign: string, altitudeAglFt: number): boolean {
  const prevState = groundStateHistory.get(callsign)
  let onGround: boolean
  if (prevState === undefined || prevState === false) {
    // Currently airborne or unknown: enter ground state at lower threshold
    onGround = altitudeAglFt < GROUND_ENTER_AGL_FT
  } else {
    // Currently on ground: stay on ground until well above threshold
    onGround = altitudeAglFt < GROUND_EXIT_AGL_FT
  }
  groundStateHistory.set(callsign, onGround)
  return onGround
}

/**
 * The ground fields of a vNAS observation: the 50/80 ft label flag and the simulator's height above ground of the
 * aircraft's reference point in metres, raw (about -0.3 to 14 ft at rest, by type and simulator; contact subtracts the
 * aircraft's learned resting height downstream). A non-finite AGL leaves the height out, so that observation counts as
 * one without height.
 */
function vnasGroundFields(
  callsign: string,
  altitudeAglFt: number,
): Pick<AircraftObservation, 'onGround' | 'heightAboveGround'> {
  const onGround = getOnGroundWithHysteresis(callsign, altitudeAglFt)
  if (!Number.isFinite(altitudeAglFt)) return { onGround }
  return { onGround, heightAboveGround: altitudeAglFt * FEET_TO_METERS }
}

/** Number of samples to keep in the speed history window */
const SPEED_WINDOW_SIZE = 5

/**
 * Hub subscribes still in flight, keyed by the facility id sent to the hub.
 * Several callers race to subscribe to the same facility (airport load, session
 * restore, the auto-subscribe effect); only the first reaches the hub and the
 * rest await its promise. An entry is deleted when its promise settles either way,
 * and the whole map when the session ends.
 */
const inFlightSubscribes = new Map<string, Promise<void>>()

// Drop per-aircraft state when the timeline removes an aircraft (explicit removal
// or stale-prune). Without this, speedHistory and groundStateHistory grow without
// bound across a session because vNAS only clears them on explicit SignalR
// removal messages or full disconnect.
//
// Deferred via queueMicrotask: there is a circular module-init path
// aircraftTimelineStore → replayStore/viewportStore → airportStore → vnasStore
// → aircraftTimelineStore. Calling this synchronously at top level re-enters
// aircraftTimelineStore before its `aircraftRemovalListeners` const has been
// initialised, producing a TDZ ReferenceError. Microtask defers the call past
// the synchronous module-evaluation phase, by which point both modules are fully
// initialised. The registration still completes before any aircraft data flows.
queueMicrotask(() => {
  addAircraftRemovalListener((callsigns) => {
    for (const callsign of callsigns) {
      speedHistory.delete(callsign)
      groundStateHistory.delete(callsign)
    }
  })
})

/**
 * Initial-groundspeed fallback for the very first vNAS observation of an aircraft.
 * vNAS doesn't transmit groundspeed; we derive it from successive position deltas,
 * but the first sample has no prior to delta against. Look up the unified timeline
 * for the most recent observation (typically VATSIM at ~15s cadence) and use its
 * groundspeed so we don't report 0 kts for an in-flight airliner.
 */
function seedGroundspeedFromTimeline(callsign: string): number {
  const timeline = useAircraftTimelineStore.getState().getTimeline(callsign)
  if (!timeline || timeline.observations.length === 0) return 0
  const newest = timeline.observations[timeline.observations.length - 1]
  return Number.isFinite(newest.groundspeed) ? newest.groundspeed : 0
}

/**
 * Calculate windowed average speed for an aircraft.
 * Adds the new sample to the history and returns the average.
 */
function addSpeedSampleAndGetAverage(callsign: string, newSpeed: number): number {
  let history = speedHistory.get(callsign)
  if (!history) {
    history = []
    speedHistory.set(callsign, history)
  }

  // Add new sample
  history.push(newSpeed)

  // Keep only the most recent samples
  while (history.length > SPEED_WINDOW_SIZE) {
    history.shift()
  }

  // Calculate average
  const sum = history.reduce((acc, val) => acc + val, 0)
  return sum / history.length
}

/**
 * vNAS Store
 *
 * Manages vNAS (Virtual Network Air Traffic Control System) connection and aircraft data.
 * vNAS provides 1Hz real-time aircraft updates within ~30NM of subscribed facilities,
 * supplementing the 15-second VATSIM HTTP polling.
 *
 * ## Data Flow
 * 1. User initiates OAuth flow via startAuth()
 * 2. Browser opens auth.vfsp.net, user logs in with VATSIM
 * 3. After callback, completeAuth() is called
 * 4. connect() establishes SignalR WebSocket
 * 5. subscribeToFacility() registers for TowerCabAircraft updates
 * 6. Aircraft updates arrive via handleAircraftUpdate()
 */

/**
 * Calculate great circle distance between two points in meters.
 * Uses the Haversine formula.
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * Convert meters per second to knots.
 */
function metersPerSecondToKnots(mps: number): number {
  return mps * 1.94384
}

interface VnasStore {
  // Connection status
  status: VnasStatus

  // Aircraft data from vNAS (keyed by callsign)
  // Note: Only used for .has() checks to detect 1Hz vNAS coverage - timeline store handles interpolation
  aircraftStates: Map<string, AircraftState>

  // Session info (available facilities from CRC session)
  sessionFacilities: string[] // Facility IDs the user can subscribe to
  sessionArtccId: string | null // ARTCC ID for the current session

  // Timing
  lastUpdateTime: number // Local time of last aircraft update

  /** True when YAAT Local sign-in needs a CID: none was saved and no VATSIM login is stored */
  yaatLocalCidRequired: boolean

  // Actions
  tryRestoreSession: (environment: VnasEnvironment) => Promise<boolean>
  /**
   * Try to connect using stored tokens, returns true if successful, false if OAuth needed.
   * YAAT Local signs in with a dev login instead and always returns true.
   */
  tryConnectWithStoredTokens: (environment: VnasEnvironment) => Promise<boolean>
  /** Save the CID and sign in to YAAT Local with it */
  signInYaatLocalWithCid: (cid: string) => Promise<void>
  startAuth: (environment: VnasEnvironment) => Promise<string>
  completeAuth: () => Promise<void>
  handleOAuthCallback: (callbackUrl: string) => Promise<void>
  connect: () => Promise<void>
  /**
   * Subscribe to a facility (additive, supports multiple). While a joined session's follow
   * is pending, only the follow's own call (`fromFollow`) reaches the hub.
   */
  subscribeToFacility: (facilityId: string, options?: SubscribeOptions) => Promise<void>
  /** Unsubscribe from a facility */
  unsubscribeFromFacility: (facilityId: string) => Promise<void>
  /** Get currently subscribed facilities */
  getSubscribedFacilities: () => string[]
  /** Check if subscribed to a specific facility */
  isSubscribedTo: (facilityId: string) => boolean
  disconnect: () => Promise<void>
  handleAircraftUpdate: (aircraft: VnasAircraft) => void
  handleBatchUpdate: (aircraft: VnasAircraft[]) => void
  getStatus: () => Promise<VnasStatus>
  checkAvailability: () => Promise<boolean>
  isAvailable: () => boolean
  isConnected: () => boolean
  canSubscribe: () => boolean
  isAuthenticated: () => boolean
  getSessionFacilities: () => Promise<string[]>
  getSessionArtcc: () => Promise<string | null>
  getSessionAirports: () => Promise<string[]>
  canSubscribeTo: (facilityId: string) => boolean

  // Internal actions
  setStatus: (status: VnasStatus) => void
  setStateOnly: (state: VnasStatus['state']) => void
  setError: (error: string | null) => void
  setSubscribedFacilities: (facilities: string[]) => void
  setSessionFacilities: (facilities: string[]) => void
  removeAircraft: (callsign: string) => void
  // The notice that the joined YAAT room's airport has no tower view, while the room stays there
  roomAirportNotice: string | null
  setRoomAirportNotice: (notice: string | null) => void
  /**
   * Counts the sessions joined (each `subscribing`) and the disconnects, so work started
   * for one session can tell that a newer one, or none, has replaced it
   */
  joinSerial: number
  /** True from a session's `subscribing` until its follow starts; only the follow subscribes meanwhile */
  followPending: boolean
  /** The follow has started: subscribes from any caller reach the hub again */
  clearFollowPending: () => void
  // Apply a session state the host reported and re-read what goes with it
  followSessionState: (state: VnasStatus['state']) => Promise<void>
  /** Drop the ended session's aircraft state, facility lists and vNAS observations */
  handleSessionEnded: () => void
}

const DEFAULT_STATUS: VnasStatus = {
  state: 'disconnected',
  environment: 'live',
  subscribedFacilities: [],
  error: null,
  available: true, // Assume available until we check
  lastSessionEnd: null,
  sessionKind: null,
}

/** How a subscribe was asked for */
export interface SubscribeOptions {
  /** The joined session's follow is subscribing the airport in view; it alone may while the follow is pending */
  fromFollow?: boolean
}

/** The states in which the host drops the session's kind and subscriptions (a session ended or was replaced) */
const SESSION_CHANGE_STATES: readonly VnasStatus['state'][] = ['disconnected', 'waitingForSession', 'subscribing']

/**
 * The store fields a session state from the host changes, by the host's own rules
 * (`apply_session_change` in vnas.rs): a session that ends or is replaced takes its kind,
 * subscriptions and airports with it, and joining one clears the error and a non-forcible
 * end. A joined session (`subscribing`) also gets a new join serial and its follow pending.
 */
function sessionStateChange(store: VnasStore, state: VnasStatus['state']): Partial<VnasStore> {
  if (!SESSION_CHANGE_STATES.includes(state)) {
    return { status: { ...store.status, state } }
  }
  const status: VnasStatus = { ...store.status, state, subscribedFacilities: [], sessionKind: null }
  if (state !== 'subscribing') {
    return { status, sessionFacilities: [], followPending: false }
  }
  const forcibleEnd = store.status.lastSessionEnd?.forcible ? store.status.lastSessionEnd : null
  return {
    status: { ...status, error: null, lastSessionEnd: forcibleEnd },
    sessionFacilities: [],
    joinSerial: store.joinSerial + 1,
    followPending: true,
  }
}

/**
 * Write a host status read into the store, all but its `state`: the host publishes every
 * state as an event, and a snapshot that put `subscribing` in the store ahead of that event
 * would let subscribes through before the joined session's follow is pending. The one state a
 * snapshot does apply is a live session's while the store is `disconnected`: a frontend that
 * loaded while the host was already in a session missed those events, and a real connect has
 * already moved the store to `connecting`. It goes through `followSessionState`, so the host's
 * rules apply. A read started before a join or a disconnect moved `joinSerial` describes the old
 * session, all but the subscriptions and the error, which the host keeps current; only those are
 * taken from it then.
 */
function writeStatusSnapshot(
  set: StoreApi<VnasStore>['setState'],
  get: () => VnasStore,
  serial: number,
  status: VnasStatus,
): void {
  if (get().joinSerial === serial) {
    set((store) => ({ status: { ...status, state: store.status.state } }))
    if (get().status.state === 'disconnected' && status.state !== 'disconnected') {
      void get().followSessionState(status.state)
    }
    return
  }
  set((store) => ({
    status: { ...store.status, subscribedFacilities: status.subscribedFacilities, error: status.error },
  }))
}

/** The exact rejection vnas_yaat_local_sign_in sends when it has no CID to sign in with */
const YAAT_LOCAL_CID_REQUIRED = 'yaat_local_cid_required'

/**
 * Sign in to YAAT Local with a dev login, then connect and subscribe to the current airport.
 * Errors land in status.error; this never throws.
 *
 * @param cid - The VATSIM CID to sign in as, or null to use the stored VATSIM login's CID
 */
async function signInYaatLocal(cid: string | null, set: StoreApi<VnasStore>['setState'], get: () => VnasStore) {
  const { yaatLocalUrl } = useSettingsStore.getState().vnas

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('vnas_yaat_local_sign_in', { yaatLocalUrl, cid })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === YAAT_LOCAL_CID_REQUIRED) {
      set((state) => ({
        yaatLocalCidRequired: true,
        status: {
          ...state.status,
          state: 'disconnected',
          error: 'Enter your VATSIM CID to sign in to YAAT Local.',
          lastSessionEnd: null,
        },
      }))
    } else {
      console.warn('[vNAS] YAAT Local sign-in failed:', message)
      set((state) => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `YAAT Local sign-in failed: ${message}`,
          lastSessionEnd: null,
        },
      }))
    }
    return
  }

  set({ yaatLocalCidRequired: false })

  try {
    console.log('[vNAS] Signed in to YAAT Local, connecting...')
    await get().connect()

    const { useAirportStore } = await import('./airportStore')
    const currentAirport = useAirportStore.getState().currentAirport
    if (currentAirport?.icao) {
      console.log('[vNAS] Auto-subscribing to current airport:', currentAirport.icao)
      await get().subscribeToFacility(currentAirport.icao)
    }
  } catch (error) {
    // connect() and subscribeToFacility() have already set their own state; name YAAT Local in the error
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[vNAS] YAAT Local connection failed:', message)
    set((state) => ({ status: { ...state.status, error: `YAAT Local sign-in failed: ${message}` } }))
  }
}

export const useVnasStore = create<VnasStore>((set, get) => ({
  // Initial state
  status: DEFAULT_STATUS,
  aircraftStates: new Map(),
  sessionFacilities: [],
  sessionArtccId: null,
  lastUpdateTime: 0,
  yaatLocalCidRequired: false,
  roomAirportNotice: null,
  joinSerial: 0,
  followPending: false,

  /**
   * Try to restore a session from stored tokens.
   * Call this on app startup before showing OAuth UI.
   * Returns true if session was restored, false if user needs to authenticate.
   * YAAT Local has no stored tokens, so it always returns false.
   */
  tryRestoreSession: async (environment: VnasEnvironment): Promise<boolean> => {
    if (isRemoteMode()) {
      return false
    }

    if (environment === 'yaatlocal') {
      console.warn('[vNAS] YAAT Local has no stored session; sign in with tryConnectWithStoredTokens')
      return false
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const restored = await invoke<boolean>('vnas_try_restore_session', { environment })

      if (restored) {
        console.log('[vNAS] Session restored from stored tokens')
      }

      return restored
    } catch (error) {
      console.warn('[vNAS] Failed to restore session:', error)
      return false
    }
  },

  /**
   * Try to connect using stored tokens without OAuth.
   * Returns true if connection succeeded, false if OAuth is needed.
   * Use this when the user clicks "Connect" to avoid unnecessary OAuth flows.
   */
  tryConnectWithStoredTokens: async (environment: VnasEnvironment): Promise<boolean> => {
    if (isRemoteMode()) {
      return false
    }

    // Clear any previous error
    set((state) => ({
      status: {
        ...state.status,
        error: null,
      },
    }))

    // YAAT Local never falls back to OAuth, so it reports true whatever the outcome
    if (environment === 'yaatlocal') {
      const savedCid = useSettingsStore.getState().vnas.yaatLocalCid.trim()
      await signInYaatLocal(savedCid === '' ? null : savedCid, set, get)
      return true
    }

    try {
      // First try to restore the session from stored tokens
      const restored = await get().tryRestoreSession(environment)
      if (!restored) {
        console.log('[vNAS] No valid stored tokens, OAuth required')
        return false
      }

      // Session restored, now connect
      console.log('[vNAS] Connecting with restored tokens...')
      await get().connect()

      // Auto-subscribe to current airport if one is selected
      const { useAirportStore } = await import('./airportStore')
      const currentAirport = useAirportStore.getState().currentAirport
      if (currentAirport?.icao) {
        console.log('[vNAS] Auto-subscribing to current airport:', currentAirport.icao)
        await get().subscribeToFacility(currentAirport.icao)
      }

      return true
    } catch (error) {
      console.warn('[vNAS] Failed to connect with stored tokens:', error)
      // Don't set error state here - the caller will start OAuth flow
      return false
    }
  },

  /**
   * Save the CID the user typed and sign in to YAAT Local with it.
   */
  signInYaatLocalWithCid: async (cid: string) => {
    if (isRemoteMode()) {
      return
    }

    const trimmed = cid.trim()
    useSettingsStore.getState().updateVnasSettings({ yaatLocalCid: trimmed })
    set((state) => ({ yaatLocalCidRequired: false, status: { ...state.status, error: null } }))
    await signInYaatLocal(trimmed === '' ? null : trimmed, set, get)
  },

  /**
   * Start the OAuth authentication flow.
   * Returns the URL to open in the user's browser.
   */
  startAuth: async (environment: VnasEnvironment): Promise<string> => {
    if (isRemoteMode()) {
      // Remote clients don't authenticate - host handles vNAS connection
      console.log('[vNAS] Remote mode - authentication handled by host')
      return ''
    }

    if (environment === 'yaatlocal') {
      throw new Error('YAAT Local does not use OAuth; sign in with tryConnectWithStoredTokens')
    }

    // Reset frontend deduplication for new auth flow
    lastProcessedOAuthCallback = null

    // Clear any previous error when starting a new auth flow
    set((state) => ({
      status: {
        ...state.status,
        error: null,
      },
    }))

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const authUrl = await invoke<string>('vnas_start_auth', { environment })
      return authUrl
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Auth failed: ${message}`,
          lastSessionEnd: null,
        },
      }))
      throw error
    }
  },

  /**
   * Complete the OAuth flow after browser callback.
   */
  completeAuth: async () => {
    if (isRemoteMode()) {
      // Remote clients don't authenticate - host handles vNAS connection
      return
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_complete_auth')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Auth completion failed: ${message}`,
          lastSessionEnd: null,
        },
      }))
      throw error
    }
  },

  /**
   * Handle OAuth callback from deep link (tc3d://oauth/callback?code=...).
   * This is called when the app receives the OAuth redirect from the browser.
   */
  handleOAuthCallback: async (callbackUrl: string) => {
    if (isRemoteMode()) {
      // Remote clients don't authenticate - host handles vNAS connection
      return
    }

    // Frontend-side deduplication (complements backend deduplication)
    // This catches duplicates from React Strict Mode double-effect or duplicate events
    if (lastProcessedOAuthCallback === callbackUrl) {
      console.log('[vNAS] Ignoring duplicate OAuth callback (frontend dedup)')
      return
    }
    lastProcessedOAuthCallback = callbackUrl

    console.log('[vNAS] Handling OAuth callback:', urlWithoutQuery(callbackUrl))

    // Clear any previous error when processing new callback
    set((state) => ({
      status: {
        ...state.status,
        error: null,
      },
    }))

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_handle_oauth_callback', { callbackUrl })

      // After successful OAuth, automatically connect
      console.log('[vNAS] OAuth callback handled, connecting...')
      await get().connect()

      // Auto-subscribe to current airport if one is selected
      // Import dynamically to avoid circular dependencies
      const { useAirportStore } = await import('./airportStore')
      const currentAirport = useAirportStore.getState().currentAirport
      if (currentAirport?.icao) {
        console.log('[vNAS] Auto-subscribing to current airport:', currentAirport.icao)
        await get().subscribeToFacility(currentAirport.icao)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[vNAS] OAuth callback failed:', message)
      set((state) => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `OAuth callback failed: ${message}`,
          lastSessionEnd: null,
        },
      }))
      throw error
    }
  },

  /**
   * Connect to vNAS after successful authentication.
   */
  connect: async () => {
    if (isRemoteMode()) {
      // Remote clients don't connect - host handles vNAS connection
      return
    }

    const serial = get().joinSerial
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_connect')

      // Explicitly fetch and update status after connection.
      // This ensures UI updates even if event listeners have issues.
      const status = await invoke<VnasStatus>('vnas_get_status')
      writeStatusSnapshot(set, get, serial, status)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Connection failed: ${message}`,
          lastSessionEnd: null,
        },
      }))
      throw error
    }
  },

  /**
   * Subscribe to TowerCabAircraft updates for a facility (additive).
   * Supports multiple simultaneous subscriptions within the same CRC session.
   * Concurrent calls for one facility share a single hub subscribe.
   * @param icaoCode - ICAO code of the airport (e.g., "KSFO" or "SFO")
   *
   * Note: vNAS facility IDs don't include the K prefix for US airports.
   * This function automatically strips it (KSFO -> SFO).
   */
  subscribeToFacility: async (icaoCode: string, options: SubscribeOptions = {}) => {
    if (isRemoteMode()) {
      // In remote mode, vNAS subscriptions are handled by the host
      return
    }

    if (get().isSubscribedTo(icaoCode)) {
      return
    }

    // Only a joined session takes subscribes; the follow subscribes the airport in view once one is
    if (!get().canSubscribe()) {
      console.debug(`[vNAS] Not subscribing ${icaoCode}: no session joined (${get().status.state})`)
      return
    }

    // The joined session's follow ends by subscribing the airport in view, which may be
    // the room's rather than this one: nothing is lost by leaving it to the follow.
    if (get().followPending && !options.fromFollow) {
      console.log(`[vNAS] Leaving ${icaoCode} to the joined session's follow`)
      return
    }

    // vNAS facility IDs don't have K prefix for US airports (KSFO -> SFO)
    let facilityId = icaoCode
    if (icaoCode.startsWith('K') && icaoCode.length === 4) {
      facilityId = icaoCode.slice(1)
      console.log(`[vNAS] Stripped K prefix: ${icaoCode} -> ${facilityId}`)
    }

    const inFlight = inFlightSubscribes.get(facilityId)
    if (inFlight) {
      return inFlight
    }

    const subscribeOnHub = async () => {
      const serial = get().joinSerial
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('vnas_subscribe_facility', { facilityId })

        // Explicitly fetch and update status after subscription.
        const status = await invoke<VnasStatus>('vnas_get_status')
        writeStatusSnapshot(set, get, serial, status)

        // Broadcast updated subscriptions to remote browsers
        invoke('broadcast_subscriptions', { facilities: status.subscribedFacilities }).catch(() => {})
      } catch (error) {
        // A subscribe from a session that has since ended has no error to show
        if (inFlightSubscribes.get(facilityId) === subscription) {
          const message = error instanceof Error ? error.message : String(error)
          set((state) => ({
            status: {
              ...state.status,
              error: `Subscription failed: ${message}`,
            },
          }))
        }
        throw error
      }
    }

    const subscription: Promise<void> = subscribeOnHub().finally(() => {
      // A session that ended meanwhile cleared the map, and a newer subscribe may
      // own this facility's entry now; only remove the entry if it is still ours.
      if (inFlightSubscribes.get(facilityId) === subscription) {
        inFlightSubscribes.delete(facilityId)
      }
    })

    inFlightSubscribes.set(facilityId, subscription)
    return subscription
  },

  /**
   * Unsubscribe from a facility.
   * Called when switching away from an airport.
   * This drops the facility from the local subscribed list only — the hub-side
   * subscription stays for the life of the session (there is no hub unsubscribe).
   */
  unsubscribeFromFacility: async (icaoCode: string) => {
    if (isRemoteMode()) {
      // In remote mode, vNAS subscriptions are handled by the host
      return
    }

    // vNAS facility IDs don't have K prefix for US airports (KSFO -> SFO)
    let facilityId = icaoCode
    if (icaoCode.startsWith('K') && icaoCode.length === 4) {
      facilityId = icaoCode.slice(1)
    }

    const serial = get().joinSerial
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_unsubscribe_facility', { facilityId })

      // Explicitly fetch and update status after unsubscription
      const status = await invoke<VnasStatus>('vnas_get_status')
      writeStatusSnapshot(set, get, serial, status)

      // Broadcast updated subscriptions to remote browsers
      invoke('broadcast_subscriptions', { facilities: status.subscribedFacilities }).catch(() => {})
    } catch (error) {
      console.warn('[vNAS] Unsubscribe failed:', error)
      // Don't throw - unsubscribe failure is not critical
    }
  },

  /**
   * Get currently subscribed facilities.
   */
  getSubscribedFacilities: () => {
    return get().status.subscribedFacilities
  },

  /**
   * Check if subscribed to a specific facility.
   */
  isSubscribedTo: (facilityId: string) => {
    const { subscribedFacilities } = get().status
    // Also check without K prefix
    const strippedId = facilityId.startsWith('K') && facilityId.length === 4 ? facilityId.slice(1) : facilityId
    return subscribedFacilities.includes(facilityId) || subscribedFacilities.includes(strippedId)
  },

  /**
   * Disconnect from vNAS.
   */
  disconnect: async () => {
    if (isRemoteMode()) {
      // Remote clients don't disconnect - host handles vNAS connection
      return
    }

    // A follow still reading the joined session must not move the view after this
    set((store) => ({ joinSerial: store.joinSerial + 1, followPending: false }))
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_disconnect')
      speedHistory.clear()
      groundStateHistory.clear()
      set({
        status: DEFAULT_STATUS,
        aircraftStates: new Map(),
        lastUpdateTime: 0,
        yaatLocalCidRequired: false,
      })
    } catch (error) {
      console.error('vNAS disconnect failed:', error)
      // Still reset local state even if disconnect fails
      speedHistory.clear()
      groundStateHistory.clear()
      set({
        status: DEFAULT_STATUS,
        aircraftStates: new Map(),
        lastUpdateTime: 0,
        yaatLocalCidRequired: false,
      })
    }
  },

  /**
   * Handle a single aircraft update from vNAS.
   * Converts VnasAircraft to AircraftState for unified rendering.
   */
  handleAircraftUpdate: (aircraft: VnasAircraft) => {
    const now = Date.now()
    const { aircraftStates } = get()

    // Get existing state to calculate groundspeed from position change
    const oldState = aircraftStates.get(aircraft.callsign)

    // Use the Rust-side receive timestamp (more accurate than JS Date.now())
    // This is when the UDP packet was received on the backend
    const observationTime = aircraft.timestamp

    // Calculate groundspeed from position change (vNAS doesn't provide it directly).
    // Without a prior vNAS sample we fall back to the most recent observation in the
    // unified timeline (typically a VATSIM-reported groundspeed) — otherwise the first
    // vNAS sample for an in-flight airliner would emit gs=0, briefly tripping the
    // <40kt "on ground" classification in the interpolator.
    let calculatedGroundspeed = seedGroundspeedFromTimeline(aircraft.callsign)
    if (oldState?.vnasTimestamp) {
      const timeDeltaMs = observationTime - oldState.vnasTimestamp
      if (timeDeltaMs > 0 && timeDeltaMs < 5000) {
        // Sanity check: 0-5 seconds
        const distanceMeters = haversineDistance(oldState.latitude, oldState.longitude, aircraft.lat, aircraft.lon)
        const metersPerSecond = distanceMeters / (timeDeltaMs / 1000)
        const instantaneousSpeed = metersPerSecondToKnots(metersPerSecond)

        // Clamp to reasonable range (0-600 knots) to filter out noise/teleports
        if (instantaneousSpeed > 600) {
          // Keep previous average if unreasonable
          calculatedGroundspeed = oldState.groundspeed
        } else {
          // Use windowed average to smooth out GPS jitter
          calculatedGroundspeed = addSpeedSampleAndGetAverage(aircraft.callsign, instantaneousSpeed)
        }
      }
    }

    // Convert vNAS altitude from feet MSL to meters ellipsoidal (WGS84)
    // This matches how VATSIM and RealTraffic altitudes are processed
    const altitudeMetersEllipsoidal = geoidService.mslToEllipsoidal(
      aircraft.lat,
      aircraft.lon,
      aircraft.altitudeTrue * FEET_TO_METERS,
    )

    // Convert vNAS aircraft to AircraftState format
    // Use trueGroundTrack for interpolation/extrapolation when available.
    // Ground track represents actual direction of travel, while heading
    // may differ due to crosswind (crab angle).
    const newState: AircraftState = {
      callsign: aircraft.callsign,
      cid: 0, // vNAS doesn't provide CID
      latitude: aircraft.lat,
      longitude: aircraft.lon,
      altitude: altitudeMetersEllipsoidal, // Meters ellipsoidal (WGS84)
      groundspeed: calculatedGroundspeed,
      heading: aircraft.trueHeading,
      groundTrack: aircraft.trueGroundTrack, // Use for extrapolation if set
      transponder: '', // Not provided by vNAS
      aircraftType: aircraft.typeCode || null,
      departure: null, // Not provided by vNAS
      arrival: null, // Not provided by vNAS
      timestamp: now + 1000, // Target time (1 second from now for 1Hz updates)
      vnasTimestamp: observationTime, // Actual observation time for groundspeed calculation
    }

    // Update state map (used for .has() checks to detect vNAS coverage)
    const newAircraftStates = new Map(aircraftStates)
    newAircraftStates.set(aircraft.callsign, newState)

    set({
      aircraftStates: newAircraftStates,
      lastUpdateTime: now,
    })

    // Feed observation into the unified timeline store
    const timelineStore = useAircraftTimelineStore.getState()
    const observation: AircraftObservation = {
      latitude: aircraft.lat,
      longitude: aircraft.lon,
      altitude: altitudeMetersEllipsoidal, // Meters ellipsoidal (WGS84)
      heading: aircraft.trueHeading,
      groundspeed: calculatedGroundspeed, // Calculated from position changes
      groundTrack: aircraft.trueGroundTrack ?? null,
      headingIsTrue: true, // vNAS heading is always reliable (from simulator)
      // vNAS provides AGL directly from the simulator: the height for ground contact, plus the label flag
      ...vnasGroundFields(aircraft.callsign, aircraft.altitudeAgl),
      pitch: null,
      roll: null,
      verticalRate: null,
      observedAt: observationTime, // Use Rust-side receive time for accurate timeline
      receivedAt: now,
      source: 'vnas',
      displayDelay: SOURCE_DISPLAY_DELAYS.vnas,
    }

    const metadata: AircraftMetadata = {
      cid: 0, // vNAS doesn't provide CID
      aircraftType: aircraft.typeCode || null,
      transponder: '',
      departure: null,
      arrival: null,
    }

    timelineStore.addObservation(aircraft.callsign, observation, metadata)
  },

  /**
   * Handle a batch of aircraft updates from vNAS.
   * More efficient than individual updates for large batches.
   */
  handleBatchUpdate: (batchAircraft: VnasAircraft[]) => {
    const now = Date.now()
    const { aircraftStates } = get()

    const newAircraftStates = new Map(aircraftStates)

    // Track calculated values for the observation batch
    const calculatedSpeeds = new Map<string, number>()
    const calculatedAltitudes = new Map<string, number>()

    // Track vNAS timestamps for the observation batch
    const vnasTimestamps = new Map<string, number>()

    for (const ac of batchAircraft) {
      const oldState = aircraftStates.get(ac.callsign)

      // Use the Rust-side receive timestamp for accurate time delta
      const observationTime = ac.timestamp
      vnasTimestamps.set(ac.callsign, observationTime)

      // Calculate groundspeed from position change using actual time delta.
      // See handleAircraftUpdate for the rationale behind seeding from the timeline.
      let calculatedGroundspeed = seedGroundspeedFromTimeline(ac.callsign)
      if (oldState?.vnasTimestamp) {
        const timeDeltaMs = observationTime - oldState.vnasTimestamp
        if (timeDeltaMs > 0 && timeDeltaMs < 5000) {
          const distanceMeters = haversineDistance(oldState.latitude, oldState.longitude, ac.lat, ac.lon)
          const metersPerSecond = distanceMeters / (timeDeltaMs / 1000)
          const instantaneousSpeed = metersPerSecondToKnots(metersPerSecond)
          if (instantaneousSpeed > 600) {
            calculatedGroundspeed = oldState.groundspeed
          } else {
            // Use windowed average to smooth out GPS jitter
            calculatedGroundspeed = addSpeedSampleAndGetAverage(ac.callsign, instantaneousSpeed)
          }
        }
      }
      calculatedSpeeds.set(ac.callsign, calculatedGroundspeed)

      // Convert vNAS altitude from feet MSL to meters ellipsoidal (WGS84)
      const altitudeMetersEllipsoidal = geoidService.mslToEllipsoidal(ac.lat, ac.lon, ac.altitudeTrue * FEET_TO_METERS)
      calculatedAltitudes.set(ac.callsign, altitudeMetersEllipsoidal)

      const newState: AircraftState = {
        callsign: ac.callsign,
        cid: 0,
        latitude: ac.lat,
        longitude: ac.lon,
        altitude: altitudeMetersEllipsoidal, // Meters ellipsoidal (WGS84)
        groundspeed: calculatedGroundspeed,
        heading: ac.trueHeading,
        groundTrack: ac.trueGroundTrack, // Use for extrapolation if set
        transponder: '',
        aircraftType: ac.typeCode || null,
        departure: null,
        arrival: null,
        timestamp: now + 1000,
        vnasTimestamp: observationTime,
      }

      newAircraftStates.set(ac.callsign, newState)
    }

    set({
      aircraftStates: newAircraftStates,
      lastUpdateTime: now,
    })

    // Feed observations into the unified timeline store
    const timelineStore = useAircraftTimelineStore.getState()
    const observationBatch: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }> = []

    for (const ac of batchAircraft) {
      const observationTime = vnasTimestamps.get(ac.callsign) ?? now
      const observation: AircraftObservation = {
        latitude: ac.lat,
        longitude: ac.lon,
        altitude: calculatedAltitudes.get(ac.callsign) ?? 0, // Meters ellipsoidal (WGS84)
        heading: ac.trueHeading,
        groundspeed: calculatedSpeeds.get(ac.callsign) ?? 0,
        groundTrack: ac.trueGroundTrack ?? null,
        headingIsTrue: true, // vNAS heading is always reliable (from simulator)
        // vNAS provides AGL directly from the simulator: the height for ground contact, plus the label flag
        ...vnasGroundFields(ac.callsign, ac.altitudeAgl),
        pitch: null,
        roll: null,
        verticalRate: null,
        observedAt: observationTime, // Use Rust-side receive time for accurate timeline
        receivedAt: now,
        source: 'vnas',
        displayDelay: SOURCE_DISPLAY_DELAYS.vnas,
      }

      const metadata: AircraftMetadata = {
        cid: 0, // vNAS doesn't provide CID
        aircraftType: ac.typeCode || null,
        transponder: '',
        departure: null,
        arrival: null,
      }

      observationBatch.push({ callsign: ac.callsign, observation, metadata })
    }

    if (observationBatch.length > 0) {
      timelineStore.addObservationBatch(observationBatch)
    }
  },

  /**
   * Get current vNAS status from backend.
   */
  getStatus: async (): Promise<VnasStatus> => {
    if (isRemoteMode()) {
      return get().status
    }

    const serial = get().joinSerial
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const status = await invoke<VnasStatus>('vnas_get_status')
      writeStatusSnapshot(set, get, serial, status)
      return status
    } catch (error) {
      console.error('Failed to get vNAS status:', error)
      return get().status
    }
  },

  /**
   * Check if vNAS feature is available in the backend.
   */
  checkAvailability: async (): Promise<boolean> => {
    if (isRemoteMode()) {
      // In remote mode, vNAS availability is determined by the host's state
      const state = get().status.state
      return state !== 'disconnected' && state !== 'unavailable'
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const available = await invoke<boolean>('vnas_is_available')
      set((state) => ({
        status: {
          ...state.status,
          available,
        },
      }))
      return available
    } catch (error) {
      console.error('Failed to check vNAS availability:', error)
      return false
    }
  },

  /**
   * Check if vNAS feature is available (synchronous, uses cached value).
   */
  isAvailable: (): boolean => {
    return get().status.available
  },

  /**
   * Check if vNAS is currently connected (receiving updates).
   */
  isConnected: (): boolean => {
    return get().status.state === 'connected'
  },

  /**
   * Check if vNAS can subscribe to an airport.
   * True when connected to hub and ready to subscribe (or already subscribed).
   */
  canSubscribe: (): boolean => {
    const state = get().status.state
    return state === 'subscribing' || state === 'connected'
  },

  /**
   * Check if vNAS is authenticated.
   */
  isAuthenticated: (): boolean => {
    const state = get().status.state
    return state === 'connecting' || state === 'joiningSession' || state === 'subscribing' || state === 'connected'
  },

  /**
   * Get list of facility IDs available in the current CRC session.
   * These are the airports the user can subscribe to for 1Hz data.
   */
  getSessionFacilities: async (): Promise<string[]> => {
    if (isRemoteMode()) {
      // In remote mode, session facilities are synced from host via WebSocket init message
      return get().sessionFacilities
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const facilities = await invoke<string[]>('vnas_get_session_facilities')
      set({ sessionFacilities: facilities })
      console.log(`[vNAS] Session facilities: ${facilities.join(', ') || '(none)'}`)
      return facilities
    } catch (error) {
      console.error('[vNAS] Failed to get session facilities:', error)
      return []
    }
  },

  /**
   * Get the ARTCC ID for the current CRC session.
   * Note: Session facilities are broadcast to remote browsers via the init message
   * and through getSessionAirports() which resolves facilities to ICAOs.
   */
  getSessionArtcc: async (): Promise<string | null> => {
    if (isRemoteMode()) {
      return null
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const artccId = await invoke<string | null>('vnas_get_session_artcc')
      set({ sessionArtccId: artccId })
      if (artccId) {
        console.log(`[vNAS] Session ARTCC: ${artccId}`)
      }
      return artccId
    } catch (error) {
      console.error('[vNAS] Failed to get session ARTCC:', error)
      return null
    }
  },

  /**
   * Get the list of airport ICAOs that support 1Hz updates in the current session.
   * This resolves facilities (e.g., NCT TRACON) to their constituent airports. The list is
   * kept as `sessionFacilities` only while no join or disconnect has happened since the
   * read began (`joinSerial` unchanged); a later answer describes an ended session.
   */
  getSessionAirports: async (): Promise<string[]> => {
    if (isRemoteMode()) {
      return []
    }

    const serial = get().joinSerial
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const airports = await invoke<string[]>('vnas_get_session_airports')
      if (get().joinSerial === serial) {
        set({ sessionFacilities: airports })
      }
      console.log(`[vNAS] Session airports (1Hz): ${airports.join(', ') || '(none)'}`)
      return airports
    } catch (error) {
      console.error('[vNAS] Failed to get session airports:', error)
      return []
    }
  },

  /**
   * Check if a facility can be subscribed to in the current session.
   * Handles both ICAO (KSFO) and vNAS facility ID (SFO) formats.
   */
  canSubscribeTo: (icaoCode: string): boolean => {
    const { sessionFacilities } = get()
    // Session facilities use vNAS format (no K prefix), so check both
    const facilityId = icaoCode.startsWith('K') && icaoCode.length === 4 ? icaoCode.slice(1) : icaoCode
    return sessionFacilities.includes(facilityId) || sessionFacilities.includes(icaoCode)
  },

  /**
   * Update connection status (called from event listeners).
   */
  setStatus: (status: VnasStatus) => {
    set({ status })
  },

  /**
   * Update just the state field of the status (avoids race conditions with snapshots).
   */
  setStateOnly: (state: VnasStatus['state']) => {
    set((store) => ({
      status: {
        ...store.status,
        state,
      },
    }))
  },

  /**
   * Set error message.
   */
  setError: (error: string | null) => {
    set((state) => ({
      status: {
        ...state.status,
        error,
      },
    }))
  },

  /**
   * Set subscribed facilities (used by remote mode to sync from host).
   */
  setSubscribedFacilities: (facilities: string[]) => {
    set((state) => ({
      status: {
        ...state.status,
        subscribedFacilities: facilities,
      },
    }))
  },

  /**
   * Set session facilities (available facilities from host's CRC session).
   * Used by remote mode to know which facilities can be subscribed to.
   */
  setSessionFacilities: (facilities: string[]) => {
    set({ sessionFacilities: facilities })
  },

  /**
   * Remove an aircraft from the store.
   * Called when the SignalR hub sends an explicit disconnect message.
   * The aircraft's vNAS observations are dropped from the unified timeline, so it
   * falls back to VATSIM data when VATSIM also reports it.
   */
  removeAircraft: (callsign: string) => {
    // Drop the vNAS half of the timeline whether or not this store still holds the
    // aircraft: a hub disconnect means the 1Hz feed for it is over.
    useAircraftTimelineStore.getState().dropSourceObservations('vnas', [callsign])

    const { aircraftStates } = get()

    // Only remove if the aircraft exists
    if (!aircraftStates.has(callsign)) {
      return
    }

    const newAircraftStates = new Map(aircraftStates)
    newAircraftStates.delete(callsign)
    speedHistory.delete(callsign)
    groundStateHistory.delete(callsign)

    console.log(`[vNAS] Removed aircraft: ${callsign}`)

    set({
      aircraftStates: newAircraftStates,
    })
  },

  /**
   * Drop everything the ended session left behind.
   *
   * Called at each state that ends the session in progress (see `followSessionState`):
   * `disconnected` (the server ended it or the user disconnected), `waitingForSession` (a
   * room or CRC session ended and the connection stays) and `subscribing` (a new session
   * replaced it). The per-aircraft maps, the facility lists, the subscribes in flight and
   * the session's vNAS observations all go. Aircraft that VATSIM also reports carry on
   * from their VATSIM timeline.
   */
  handleSessionEnded: () => {
    // A subscribe still in flight belongs to the old session; the next one must reach the hub
    inFlightSubscribes.clear()
    speedHistory.clear()
    groundStateHistory.clear()
    useAircraftTimelineStore.getState().dropSourceObservations('vnas')
    set((state) => ({
      aircraftStates: new Map(),
      sessionFacilities: [],
      roomAirportNotice: null,
      status: { ...state.status, subscribedFacilities: [] },
    }))
  },

  setRoomAirportNotice: (notice: string | null) => {
    set({ roomAirportNotice: notice })
  },

  clearFollowPending: () => {
    set({ followPending: false })
  },

  /**
   * Apply a session state from `vnas-state-changed` by the host's rules (see
   * `sessionStateChange`), then re-read the host status that goes with it: how the last
   * session ended (`disconnected`, `waitingForSession`) and the joined session's kind and
   * airports (`subscribing`). Each of those three states ends the session in progress (a
   * disconnect, a room or CRC session ending with the connection kept, or a new session
   * replacing it), so `handleSessionEnded` drops what it left behind, its subscribes in
   * flight included, before the join's own follow work. The state is applied before the
   * first await, so a caller can read the new `joinSerial` as soon as this returns its promise.
   *
   * On `subscribing` the host already knows the session's kind (it comes with the join), so
   * the status is read first. A room session's airports need no lookup and are awaited, since
   * the room follow picks its airport from them; a CRC session's airports come from the Data
   * API, so they are not awaited: the airport in view is subscribed at once and
   * `sessionFacilities` fills in when the Data API answers.
   */
  followSessionState: async (state: VnasStatus['state']) => {
    set((store) => sessionStateChange(store, state))
    const sessionChanged = SESSION_CHANGE_STATES.includes(state)
    if (sessionChanged) {
      get().handleSessionEnded()
    }
    const serial = get().joinSerial
    if (isRemoteMode() || !sessionChanged) {
      return
    }
    await readStatusFor(state, serial, set, get)
    if (state !== 'subscribing' || get().joinSerial !== serial) {
      return
    }
    if (get().status.sessionKind === 'room') {
      await get().getSessionAirports()
    } else {
      void get().getSessionAirports()
    }
  },
}))

/**
 * Read what the host knows of the session `state` started, how the last one ended and
 * the joined one's kind, into the store; the store keeps every other field, which its own
 * events keep current. A join or a disconnect since (`joinSerial` moved past `serial`)
 * makes the read stale, and it is dropped.
 */
async function readStatusFor(
  state: VnasStatus['state'],
  serial: number,
  set: StoreApi<VnasStore>['setState'],
  get: () => VnasStore,
): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const status = await invoke<VnasStatus>('vnas_get_status')
    if (get().joinSerial === serial) {
      set((store) => ({
        status: { ...store.status, lastSessionEnd: status.lastSessionEnd, sessionKind: status.sessionKind },
      }))
    }
  } catch (error) {
    console.error(`[vNAS] Failed to read the status after ${state}:`, error)
  }
}
