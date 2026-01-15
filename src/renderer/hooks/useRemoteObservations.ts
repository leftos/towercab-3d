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
 *
 * ## Sending Messages
 * Remote clients can request vNAS subscriptions:
 * - `subscribe`: Subscribe to a facility
 * - `unsubscribe`: Unsubscribe from a facility
 */

import { useEffect, useRef, useCallback } from 'react'
import { isRemoteMode, getApiBaseUrl } from '../utils/remoteMode'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useVnasStore } from '../stores/vnasStore'
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
  sessionFacilities: string[]
  subscribedFacilities: string[]
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

type WebSocketMessage = InitMessage | ObservationsMessage | RemovalsMessage | SubscriptionsMessage

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
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as WebSocketMessage

        switch (message.type) {
          case 'init': {
            console.log('[RemoteObservations] Received init:', message)
            setSessionFacilities(message.sessionFacilities)
            setSubscribedFacilities(message.subscribedFacilities)
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
        }
      } catch (error) {
        console.error('[RemoteObservations] Failed to parse message:', error)
      }
    }

    ws.onclose = (event) => {
      console.log('[RemoteObservations] WebSocket closed:', event.code, event.reason)
      wsRef.current = null
      moduleWsRef = null

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
  }, [addObservationBatch, removeAircraft, setSubscribedFacilities, setSessionFacilities])

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
