import { create } from 'zustand'
import type { VnasAircraft, VnasStatus, VnasEnvironment } from '../types/vnas'
import type { AircraftState } from '../types/vatsim'
import { isRemoteMode } from '../utils/remoteMode'

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

interface VnasStore {
  // Connection status
  status: VnasStatus

  // Aircraft data from vNAS (keyed by callsign)
  aircraftStates: Map<string, AircraftState>
  previousStates: Map<string, AircraftState>

  // Timing
  lastUpdateTime: number  // Local time of last aircraft update

  // Actions
  startAuth: (environment: VnasEnvironment) => Promise<string>
  completeAuth: () => Promise<void>
  connect: () => Promise<void>
  subscribe: (facilityId: string) => Promise<void>
  disconnect: () => Promise<void>
  handleAircraftUpdate: (aircraft: VnasAircraft) => void
  handleBatchUpdate: (aircraft: VnasAircraft[]) => void
  getStatus: () => Promise<VnasStatus>
  checkAvailability: () => Promise<boolean>
  isAvailable: () => boolean
  isConnected: () => boolean
  isAuthenticated: () => boolean

  // Internal actions
  setStatus: (status: VnasStatus) => void
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
  lastUpdateTime: 0,

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
   * Connect to vNAS after successful authentication.
   */
  connect: async () => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_connect')
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
   * @param facilityId - ICAO code of the airport (e.g., "KBOS")
   */
  subscribe: async (facilityId: string) => {
    if (isRemoteMode()) {
      throw new Error('vNAS not yet available in remote browser mode')
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('vnas_subscribe', { facilityId })
      set(state => ({
        status: {
          ...state.status,
          facilityId
        }
      }))
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

    // Convert vNAS aircraft to AircraftState format
    const newState: AircraftState = {
      callsign: aircraft.callsign,
      cid: 0, // vNAS doesn't provide CID
      latitude: aircraft.lat,
      longitude: aircraft.lon,
      altitude: aircraft.altitudeTrue,
      groundspeed: 0, // Calculated from position changes or not available
      heading: aircraft.trueHeading,
      transponder: '', // Not provided by vNAS
      aircraftType: aircraft.typeCode || null,
      departure: null, // Not provided by vNAS
      arrival: null,   // Not provided by vNAS
      timestamp: now + 1000 // Target time (1 second from now for 1Hz updates)
    }

    // Get existing state for interpolation continuity
    const oldState = aircraftStates.get(aircraft.callsign)

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
  },

  /**
   * Handle a batch of aircraft updates from vNAS.
   * More efficient than individual updates for large batches.
   */
  handleBatchUpdate: (aircraft: VnasAircraft[]) => {
    const now = Date.now()
    const { aircraftStates, previousStates } = get()

    const newAircraftStates = new Map(aircraftStates)
    const newPreviousStates = new Map(previousStates)

    for (const ac of aircraft) {
      const newState: AircraftState = {
        callsign: ac.callsign,
        cid: 0,
        latitude: ac.lat,
        longitude: ac.lon,
        altitude: ac.altitudeTrue,
        groundspeed: 0,
        heading: ac.trueHeading,
        transponder: '',
        aircraftType: ac.typeCode || null,
        departure: null,
        arrival: null,
        timestamp: now + 1000
      }

      const oldState = aircraftStates.get(ac.callsign)

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
   * Check if vNAS is currently connected.
   */
  isConnected: (): boolean => {
    return get().status.state === 'connected'
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
   * Update connection status (called from event listeners).
   */
  setStatus: (status: VnasStatus) => {
    set({ status })
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
