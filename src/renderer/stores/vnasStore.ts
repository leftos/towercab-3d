import { create } from 'zustand'
import type { VnasAircraft, VnasStatus, VnasEnvironment } from '../types/vnas'
import type { AircraftState } from '../types/vatsim'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'
import { isRemoteMode } from '../utils/remoteMode'
import { useAircraftTimelineStore } from './aircraftTimelineStore'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'
import { geoidService } from '../services/GeoidService'

/** Feet to meters conversion factor */
const FEET_TO_METERS = 0.3048

/** Last processed OAuth callback URL (for frontend-side deduplication) */
let lastProcessedOAuthCallback: string | null = null

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
 * 5. subscribe() registers for TowerCabAircraft updates
 * 6. Aircraft updates arrive via handleAircraftUpdate()
 */

/**
 * Calculate great circle distance between two points in meters.
 * Uses the Haversine formula.
 */
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
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
  aircraftStates: Map<string, AircraftState>
  previousStates: Map<string, AircraftState>

  // Session info (available facilities from CRC session)
  sessionFacilities: string[]  // Facility IDs the user can subscribe to
  sessionArtccId: string | null  // ARTCC ID for the current session

  // Timing
  lastUpdateTime: number  // Local time of last aircraft update

  // Actions
  tryRestoreSession: (environment: VnasEnvironment) => Promise<boolean>
  /** Try to connect using stored tokens, returns true if successful, false if OAuth needed */
  tryConnectWithStoredTokens: (environment: VnasEnvironment) => Promise<boolean>
  startAuth: (environment: VnasEnvironment) => Promise<string>
  completeAuth: () => Promise<void>
  handleOAuthCallback: (callbackUrl: string) => Promise<void>
  connect: () => Promise<void>
  subscribe: (facilityId: string) => Promise<void>
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
}

const DEFAULT_STATUS: VnasStatus = {
  state: 'disconnected',
  environment: 'live',
  facilityId: null,
  error: null,
  available: true  // Assume available until we check
}

export const useVnasStore = create<VnasStore>((set, get) => ({
  // Initial state
  status: DEFAULT_STATUS,
  aircraftStates: new Map(),
  previousStates: new Map(),
  sessionFacilities: [],
  sessionArtccId: null,
  lastUpdateTime: 0,

  /**
   * Try to restore a session from stored tokens.
   * Call this on app startup before showing OAuth UI.
   * Returns true if session was restored, false if user needs to authenticate.
   */
  tryRestoreSession: async (environment: VnasEnvironment): Promise<boolean> => {
    if (isRemoteMode()) {
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
    set(state => ({
      status: {
        ...state.status,
        error: null
      }
    }))

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
        await get().subscribe(currentAirport.icao)
      }

      return true
    } catch (error) {
      console.warn('[vNAS] Failed to connect with stored tokens:', error)
      // Don't set error state here - the caller will start OAuth flow
      return false
    }
  },

  /**
   * Start the OAuth authentication flow.
   * Returns the URL to open in the user's browser.
   */
  startAuth: async (environment: VnasEnvironment): Promise<string> => {
    if (isRemoteMode()) {
      // In remote mode, call host API
      // TODO: Implement remote mode vNAS proxy
      throw new Error('vNAS not yet available in remote browser mode')
    }

    // Reset frontend deduplication for new auth flow
    lastProcessedOAuthCallback = null

    // Clear any previous error when starting a new auth flow
    set(state => ({
      status: {
        ...state.status,
        error: null
      }
    }))

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const authUrl = await invoke<string>('vnas_start_auth', { environment })
      return authUrl
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(state => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Auth failed: ${message}`
        }
      }))
      throw error
    }
  },

  /**
   * Complete the OAuth flow after browser callback.
   */
  completeAuth: async () => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_complete_auth')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(state => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Auth completion failed: ${message}`
        }
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
      throw new Error('vNAS not yet available in remote browser mode')
    }

    // Frontend-side deduplication (complements backend deduplication)
    // This catches duplicates from React Strict Mode double-effect or duplicate events
    if (lastProcessedOAuthCallback === callbackUrl) {
      console.log('[vNAS] Ignoring duplicate OAuth callback (frontend dedup)')
      return
    }
    lastProcessedOAuthCallback = callbackUrl

    console.log('[vNAS] Handling OAuth callback:', callbackUrl)

    // Clear any previous error when processing new callback
    set(state => ({
      status: {
        ...state.status,
        error: null
      }
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
        await get().subscribe(currentAirport.icao)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[vNAS] OAuth callback failed:', message)
      set(state => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `OAuth callback failed: ${message}`
        }
      }))
      throw error
    }
  },

  /**
   * Connect to vNAS after successful authentication.
   */
  connect: async () => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_connect')

      // Explicitly fetch and update status after connection.
      // This ensures UI updates even if event listeners have issues.
      const status = await invoke<VnasStatus>('vnas_get_status')
      set({ status })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(state => ({
        status: {
          ...state.status,
          state: 'disconnected',
          error: `Connection failed: ${message}`
        }
      }))
      throw error
    }
  },

  /**
   * Subscribe to TowerCabAircraft updates for a facility.
   * @param icaoCode - ICAO code of the airport (e.g., "KSFO" or "SFO")
   *
   * Note: vNAS facility IDs don't include the K prefix for US airports.
   * This function automatically strips it (KSFO -> SFO).
   */
  subscribe: async (icaoCode: string) => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    // vNAS facility IDs don't have K prefix for US airports (KSFO -> SFO)
    let facilityId = icaoCode
    if (icaoCode.startsWith('K') && icaoCode.length === 4) {
      facilityId = icaoCode.slice(1)
      console.log(`[vNAS] Stripped K prefix: ${icaoCode} -> ${facilityId}`)
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_subscribe', { facilityId })

      // Explicitly fetch and update status after subscription.
      // This ensures UI updates even if event listeners have issues.
      const status = await invoke<VnasStatus>('vnas_get_status')
      // Override facilityId with original ICAO for UI display (backend uses stripped version)
      set({ status: { ...status, facilityId: icaoCode } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set(state => ({
        status: {
          ...state.status,
          error: `Subscription failed: ${message}`
        }
      }))
      throw error
    }
  },

  /**
   * Disconnect from vNAS.
   */
  disconnect: async () => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_disconnect')
      set({
        status: DEFAULT_STATUS,
        aircraftStates: new Map(),
        previousStates: new Map(),
        lastUpdateTime: 0
      })
    } catch (error) {
      console.error('vNAS disconnect failed:', error)
      // Still reset local state even if disconnect fails
      set({
        status: DEFAULT_STATUS,
        aircraftStates: new Map(),
        previousStates: new Map(),
        lastUpdateTime: 0
      })
    }
  },

  /**
   * Handle a single aircraft update from vNAS.
   * Converts VnasAircraft to AircraftState for unified rendering.
   */
  handleAircraftUpdate: (aircraft: VnasAircraft) => {
    const now = Date.now()
    const { aircraftStates, previousStates } = get()

    // Get existing state to calculate groundspeed from position change
    const oldState = aircraftStates.get(aircraft.callsign)

    // Calculate groundspeed from position change (vNAS doesn't provide it directly)
    let calculatedGroundspeed = 0
    if (oldState) {
      const timeDeltaMs = now - (oldState.timestamp - 1000) // oldState.timestamp was set to now+1000
      if (timeDeltaMs > 0 && timeDeltaMs < 5000) { // Sanity check: 0-5 seconds
        const distanceMeters = haversineDistance(
          oldState.latitude, oldState.longitude,
          aircraft.lat, aircraft.lon
        )
        const metersPerSecond = distanceMeters / (timeDeltaMs / 1000)
        calculatedGroundspeed = metersPerSecondToKnots(metersPerSecond)

        // Clamp to reasonable range (0-600 knots) to filter out noise/teleports
        if (calculatedGroundspeed > 600) {
          calculatedGroundspeed = oldState.groundspeed // Keep previous if unreasonable
        }
      }
    }

    // Convert vNAS altitude from feet MSL to meters ellipsoidal (WGS84)
    // This matches how VATSIM and RealTraffic altitudes are processed
    const altitudeMetersEllipsoidal = geoidService.mslToEllipsoidal(
      aircraft.lat,
      aircraft.lon,
      aircraft.altitudeTrue * FEET_TO_METERS
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
      altitude: altitudeMetersEllipsoidal,  // Meters ellipsoidal (WGS84)
      groundspeed: calculatedGroundspeed,
      heading: aircraft.trueHeading,
      groundTrack: aircraft.trueGroundTrack, // Use for extrapolation if set
      transponder: '', // Not provided by vNAS
      aircraftType: aircraft.typeCode || null,
      departure: null, // Not provided by vNAS
      arrival: null,   // Not provided by vNAS
      timestamp: now + 1000 // Target time (1 second from now for 1Hz updates)
    }

    // Update state maps
    const newAircraftStates = new Map(aircraftStates)
    const newPreviousStates = new Map(previousStates)

    newAircraftStates.set(aircraft.callsign, newState)

    if (oldState) {
      // Preserve previous state for interpolation
      newPreviousStates.set(aircraft.callsign, {
        ...oldState,
        timestamp: now
      })
    } else {
      // New aircraft - start from current position
      newPreviousStates.set(aircraft.callsign, {
        ...newState,
        timestamp: now
      })
    }

    set({
      aircraftStates: newAircraftStates,
      previousStates: newPreviousStates,
      lastUpdateTime: now
    })

    // Feed observation into the unified timeline store
    const timelineStore = useAircraftTimelineStore.getState()
    const observation: AircraftObservation = {
      latitude: aircraft.lat,
      longitude: aircraft.lon,
      altitude: altitudeMetersEllipsoidal,  // Meters ellipsoidal (WGS84)
      heading: aircraft.trueHeading,
      groundspeed: calculatedGroundspeed,  // Calculated from position changes
      groundTrack: aircraft.trueGroundTrack ?? null,
      headingIsTrue: true,  // vNAS heading is always reliable (from simulator)
      // Extended ADS-B data (not available from vNAS)
      onGround: null,
      roll: null,
      verticalRate: null,
      observedAt: now,  // vNAS data is real-time
      receivedAt: now,
      source: 'vnas',
      displayDelay: SOURCE_DISPLAY_DELAYS.vnas
    }

    const metadata: AircraftMetadata = {
      cid: 0,  // vNAS doesn't provide CID
      aircraftType: aircraft.typeCode || null,
      transponder: '',
      departure: null,
      arrival: null
    }

    timelineStore.addObservation(aircraft.callsign, observation, metadata)
  },

  /**
   * Handle a batch of aircraft updates from vNAS.
   * More efficient than individual updates for large batches.
   */
  handleBatchUpdate: (batchAircraft: VnasAircraft[]) => {
    const now = Date.now()
    const { aircraftStates, previousStates } = get()

    const newAircraftStates = new Map(aircraftStates)
    const newPreviousStates = new Map(previousStates)

    // Track calculated values for the observation batch
    const calculatedSpeeds = new Map<string, number>()
    const calculatedAltitudes = new Map<string, number>()

    for (const ac of batchAircraft) {
      const oldState = aircraftStates.get(ac.callsign)

      // Calculate groundspeed from position change
      let calculatedGroundspeed = 0
      if (oldState) {
        const timeDeltaMs = now - (oldState.timestamp - 1000)
        if (timeDeltaMs > 0 && timeDeltaMs < 5000) {
          const distanceMeters = haversineDistance(
            oldState.latitude, oldState.longitude,
            ac.lat, ac.lon
          )
          const metersPerSecond = distanceMeters / (timeDeltaMs / 1000)
          calculatedGroundspeed = metersPerSecondToKnots(metersPerSecond)
          if (calculatedGroundspeed > 600) {
            calculatedGroundspeed = oldState.groundspeed
          }
        }
      }
      calculatedSpeeds.set(ac.callsign, calculatedGroundspeed)

      // Convert vNAS altitude from feet MSL to meters ellipsoidal (WGS84)
      const altitudeMetersEllipsoidal = geoidService.mslToEllipsoidal(
        ac.lat,
        ac.lon,
        ac.altitudeTrue * FEET_TO_METERS
      )
      calculatedAltitudes.set(ac.callsign, altitudeMetersEllipsoidal)

      const newState: AircraftState = {
        callsign: ac.callsign,
        cid: 0,
        latitude: ac.lat,
        longitude: ac.lon,
        altitude: altitudeMetersEllipsoidal,  // Meters ellipsoidal (WGS84)
        groundspeed: calculatedGroundspeed,
        heading: ac.trueHeading,
        groundTrack: ac.trueGroundTrack, // Use for extrapolation if set
        transponder: '',
        aircraftType: ac.typeCode || null,
        departure: null,
        arrival: null,
        timestamp: now + 1000
      }

      newAircraftStates.set(ac.callsign, newState)

      if (oldState) {
        newPreviousStates.set(ac.callsign, {
          ...oldState,
          timestamp: now
        })
      } else {
        newPreviousStates.set(ac.callsign, {
          ...newState,
          timestamp: now
        })
      }
    }

    set({
      aircraftStates: newAircraftStates,
      previousStates: newPreviousStates,
      lastUpdateTime: now
    })

    // Feed observations into the unified timeline store
    const timelineStore = useAircraftTimelineStore.getState()
    const observationBatch: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }> = []

    for (const ac of batchAircraft) {
      const observation: AircraftObservation = {
        latitude: ac.lat,
        longitude: ac.lon,
        altitude: calculatedAltitudes.get(ac.callsign) ?? 0,  // Meters ellipsoidal (WGS84)
        heading: ac.trueHeading,
        groundspeed: calculatedSpeeds.get(ac.callsign) ?? 0,
        groundTrack: ac.trueGroundTrack ?? null,
        headingIsTrue: true,  // vNAS heading is always reliable (from simulator)
        // Extended ADS-B data (not available from vNAS)
        onGround: null,
        roll: null,
        verticalRate: null,
        observedAt: now,  // vNAS data is real-time
        receivedAt: now,
        source: 'vnas',
        displayDelay: SOURCE_DISPLAY_DELAYS.vnas
      }

      const metadata: AircraftMetadata = {
        cid: 0,  // vNAS doesn't provide CID
        aircraftType: ac.typeCode || null,
        transponder: '',
        departure: null,
        arrival: null
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

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const status = await invoke<VnasStatus>('vnas_get_status')
      set({ status })
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
      return false // vNAS not available in remote mode yet
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const available = await invoke<boolean>('vnas_is_available')
      set(state => ({
        status: {
          ...state.status,
          available
        }
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
    return state === 'connecting' ||
           state === 'joiningSession' ||
           state === 'subscribing' ||
           state === 'connected'
  },

  /**
   * Get list of facility IDs available in the current CRC session.
   * These are the airports the user can subscribe to for 1Hz data.
   */
  getSessionFacilities: async (): Promise<string[]> => {
    if (isRemoteMode()) {
      // TODO: Implement remote mode API
      return []
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
   * This resolves facilities (e.g., NCT TRACON) to their constituent airports.
   */
  getSessionAirports: async (): Promise<string[]> => {
    if (isRemoteMode()) {
      return []
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const airports = await invoke<string[]>('vnas_get_session_airports')
      set({ sessionFacilities: airports })
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
    const facilityId = icaoCode.startsWith('K') && icaoCode.length === 4
      ? icaoCode.slice(1)
      : icaoCode
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
    set(store => ({
      status: {
        ...store.status,
        state
      }
    }))
  },

  /**
   * Set error message.
   */
  setError: (error: string | null) => {
    set(state => ({
      status: {
        ...state.status,
        error
      }
    }))
  }
}))
