/**
 * Remote Observations WebSocket Hook
 *
 * Connects to the host's /api/observations/ws endpoint to receive unified
 * aircraft observations from all data sources (VATSIM, vNAS, RealTraffic).
 *
 * This hook is only active in remote mode (browser clients connecting to
 * the Tauri host). In host mode, observations are received directly from
 * the data sources.
 *
 * ## Message Types Received
 * - `init`: Initial state with session/subscription info
 * - `observations`: Batch of aircraft position updates
 * - `removals`: Aircraft that have disconnected
 * - `subscriptions`: Current vNAS subscriptions (when changed)
 * - `airport_sync`: Airport synchronization for RealTraffic mode
 *
 * ## Sending Messages
 * Remote clients can request:
 * - `subscribe`: Subscribe to a vNAS facility
 * - `unsubscribe`: Unsubscribe from a vNAS facility
 * - `set_airport`: Change the synced airport (RealTraffic mode only)
 */

import { useEffect, useRef, useCallback } from 'react'
import { isRemoteMode, getApiBaseUrl } from '../utils/remoteMode'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useVnasStore } from '../stores/vnasStore'
import { useRemoteStatusStore } from '../stores/remoteStatusStore'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'

// Types for WebSocket messages (match Rust types in server.rs)
interface ObservationData {
  callsign: string
  latitude: number
  longitude: number
  altitude: number
  heading: number
  groundspeed: number
  groundTrack: number
  verticalRate: number
  onGround: boolean
  pitch: number | null
  roll: number | null
  source: string
  observedAt: number
  receivedAt: number
  typeCode: string | null
  origin: string | null
  destination: string | null
  flightRules: string | null
}

interface InitMessage {
  type: 'init'
  session_facilities: string[]
  subscribed_facilities: string[]
  vnas_state: string
}

interface ObservationsMessage {
  type: 'observations'
  data: ObservationData[]
}

interface RemovalsMessage {
  type: 'removals'
  callsigns: string[]
}

interface SubscriptionsMessage {
  type: 'subscriptions'
  facilities: string[]
}

interface AirportSyncMessage {
  type: 'airport_sync'
  icao: string | null
  realtraffic_active: boolean
}

interface VnasStateMessage {
  type: 'vnas_state'
  state: string
}

type WebSocketMessage = InitMessage | ObservationsMessage | RemovalsMessage | SubscriptionsMessage | AirportSyncMessage | VnasStateMessage

// Module-level WebSocket reference for requestRemoteSubscription()
let moduleWsRef: WebSocket | null = null

/**
 * Hook to receive observations from the host app via WebSocket.
 * Only active in remote mode.
 */
export function useRemoteObservations(): void {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const addObservationBatch = useAircraftTimelineStore(state => state.addObservationBatch)
  const removeAircraft = useAircraftTimelineStore(state => state.removeAircraft)
  const setSubscribedFacilities = useVnasStore(state => state.setSubscribedFacilities)
  const setSessionFacilities = useVnasStore(state => state.setSessionFacilities)
  const setStateOnly = useVnasStore(state => state.setStateOnly)
  const setWsConnected = useRemoteStatusStore(state => state.setWsConnected)
  const recordObservation = useRemoteStatusStore(state => state.recordObservation)
  const setAirportSync = useRemoteStatusStore(state => state.setAirportSync)

  const connect = useCallback(() => {
    if (!isRemoteMode()) return

    const baseUrl = getApiBaseUrl()
    // Convert http:// to ws:// for WebSocket
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/api/observations/ws'

    console.log('[RemoteObservations] Connecting to:', wsUrl)

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    moduleWsRef = ws

    ws.onopen = () => {
      console.log('[RemoteObservations] WebSocket connected')
      setWsConnected(true)
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage

        switch (message.type) {
          case 'init': {
            console.log('[RemoteObservations] Received init:', message)
            setSessionFacilities(message.session_facilities)
            setSubscribedFacilities(message.subscribed_facilities)
            // Set vNAS state from init message so remote clients show correct indicators
            if (message.vnas_state && message.vnas_state !== 'disconnected') {
              setStateOnly(message.vnas_state as ReturnType<typeof useVnasStore.getState>['status']['state'])
            }
            break
          }

          case 'observations': {
            // Convert to timeline store format
            const now = Date.now()
            const batch = message.data.map(obs => {
              const observation: AircraftObservation = {
                latitude: obs.latitude,
                longitude: obs.longitude,
                altitude: obs.altitude,
                heading: obs.heading,
                groundspeed: obs.groundspeed,
                groundTrack: obs.groundTrack,
                verticalRate: obs.verticalRate,
                onGround: obs.onGround,
                pitch: obs.pitch,
                roll: obs.roll,
                headingIsTrue: obs.source === 'vnas' || obs.source === 'vatsim',
                source: obs.source as 'vatsim' | 'vnas' | 'realtraffic',
                observedAt: obs.observedAt,
                receivedAt: now, // Use local time for reconciliation
                displayDelay: SOURCE_DISPLAY_DELAYS[obs.source as keyof typeof SOURCE_DISPLAY_DELAYS] ?? SOURCE_DISPLAY_DELAYS.vatsim
              }

              const metadata: AircraftMetadata = {
                cid: 0, // Unknown CID for remote observations
                aircraftType: obs.typeCode ?? 'UNKN',
                transponder: '', // Unknown transponder for remote observations
                departure: obs.origin,
                arrival: obs.destination
              }

              return { callsign: obs.callsign, observation, metadata }
            })

            if (batch.length > 0) {
              addObservationBatch(batch)
              // Determine the primary source for stale threshold calculation
              // Priority: vnas > realtraffic > vatsim (fastest update rate wins)
              const sources = message.data.map(obs => obs.source)
              const primarySource = sources.includes('vnas') ? 'vnas'
                : sources.includes('realtraffic') ? 'realtraffic'
                : 'vatsim'
              recordObservation(batch.length, primarySource as 'vatsim' | 'vnas' | 'realtraffic')
            }
            break
          }

          case 'removals': {
            for (const callsign of message.callsigns) {
              removeAircraft(callsign)
            }
            break
          }

          case 'subscriptions': {
            console.log('[RemoteObservations] Subscriptions updated:', message.facilities)
            setSubscribedFacilities(message.facilities)
            break
          }

          case 'airport_sync': {
            console.log('[RemoteObservations] Airport sync:', message.icao, 'RT active:', message.realtraffic_active)
            setAirportSync(message.icao, message.realtraffic_active)
            break
          }

          case 'vnas_state': {
            console.log('[RemoteObservations] vNAS state changed:', message.state)
            setStateOnly(message.state as ReturnType<typeof useVnasStore.getState>['status']['state'])
            break
          }
        }
      } catch (error) {
        console.error('[RemoteObservations] Failed to parse message:', error)
      }
    }

    ws.onclose = (event) => {
      console.log('[RemoteObservations] WebSocket closed:', event.code, event.reason)
      wsRef.current = null
      moduleWsRef = null
      setWsConnected(false)

      // Reconnect after a delay
      if (!reconnectTimeoutRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null
          connect()
        }, 3000)
      }
    }

    ws.onerror = (error) => {
      console.error('[RemoteObservations] WebSocket error:', error)
    }
  }, [addObservationBatch, removeAircraft, setSubscribedFacilities, setSessionFacilities, setStateOnly, setWsConnected, recordObservation, setAirportSync])

  useEffect(() => {
    if (!isRemoteMode()) return

    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
        moduleWsRef = null
      }
    }
  }, [connect])
}

/**
 * Request a vNAS subscription from the host.
 * Call this when a remote client wants to subscribe to a different airport.
 * Only works in remote mode when the WebSocket is connected.
 *
 * @param facilityId - The facility ICAO code (e.g., "KJFK")
 */
export function requestRemoteSubscription(facilityId: string): void {
  if (!isRemoteMode()) {
    console.log('[RemoteObservations] Not in remote mode, ignoring subscription request')
    return
  }

  if (!moduleWsRef || moduleWsRef.readyState !== WebSocket.OPEN) {
    console.log('[RemoteObservations] WebSocket not connected, cannot request subscription')
    return
  }

  const message = JSON.stringify({
    action: 'subscribe',
    facilityId
  })

  console.log('[RemoteObservations] Requesting subscription for:', facilityId)
  moduleWsRef.send(message)
}

/**
 * Request vNAS unsubscription from the host.
 * Call this when a remote client switches away from an airport.
 *
 * @param facilityId - The facility ICAO code (e.g., "KJFK")
 */
export function requestRemoteUnsubscription(facilityId: string): void {
  if (!isRemoteMode()) {
    return
  }

  if (!moduleWsRef || moduleWsRef.readyState !== WebSocket.OPEN) {
    return
  }

  const message = JSON.stringify({
    action: 'unsubscribe',
    facilityId
  })

  console.log('[RemoteObservations] Requesting unsubscription for:', facilityId)
  moduleWsRef.send(message)
}

/**
 * Request airport change for RealTraffic mode.
 * When RealTraffic is active, all clients must be synced to the same airport
 * because RealTraffic uses a bounding box query.
 *
 * This sends the request to the host, which broadcasts the change to all clients.
 *
 * @param icao - The airport ICAO code (e.g., "KJFK") or null to clear
 */
export function requestRemoteAirportChange(icao: string | null): void {
  if (!isRemoteMode()) {
    console.log('[RemoteObservations] Not in remote mode, ignoring airport change request')
    return
  }

  if (!moduleWsRef || moduleWsRef.readyState !== WebSocket.OPEN) {
    console.log('[RemoteObservations] WebSocket not connected, cannot request airport change')
    return
  }

  const message = JSON.stringify({
    action: 'set_airport',
    icao
  })

  console.log('[RemoteObservations] Requesting airport change to:', icao)
  moduleWsRef.send(message)
}
