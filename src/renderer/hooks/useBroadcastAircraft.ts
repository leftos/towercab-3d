/**
 * useBroadcastAircraft Hook
 *
 * Consumer hook for inset iframes to receive aircraft position broadcasts
 * from the main TowerCab app via SharedWorker. Handles:
 * - Connection to SharedWorker
 * - Applying delta updates to maintain local aircraft state
 * - Sending feedback for consumer-driven rate control
 * - Cleanup on unmount
 *
 * IMPORTANT: Aircraft data is stored in a module-level variable and updated
 * directly when broadcasts arrive. This bypasses React state batching to ensure
 * immediate updates at 30Hz. The interpolation system reads this data directly
 * via getBroadcastAircraftData() - no React re-render cycle needed.
 *
 * @see docs/plans/unified-aircraft-broadcasting.md
 */

import { useEffect, useRef, useState } from 'react'
import { decode } from '@msgpack/msgpack'
import type {
  AircraftFull,
  AircraftDelta,
  BroadcastMessage,
  ConsumerFeedback,
} from '../types/broadcast'
import { RATE_CONTROL } from '../types/broadcast'
import type { InterpolatedAircraftState } from '../types/vatsim'

// ============================================================================
// MODULE-LEVEL AIRCRAFT DATA
// ============================================================================
// Aircraft data is stored here and updated directly when broadcasts arrive.
// This bypasses React state batching for immediate 30Hz updates.
// The rendering system reads this via getBroadcastAircraftData().

let broadcastAircraftData: Map<string, InterpolatedAircraftState> = new Map()
let broadcastLastUpdateTime = 0
let broadcastLastSeq = 0

// Track worker port for log forwarding
let workerPort: MessagePort | null = null
let loggedConsumerId: string | null = null

/**
 * Forward a log message from inset to main app via SharedWorker.
 * Can be called from any code running in an inset context.
 * If not connected to SharedWorker yet, just logs locally.
 */
export function insetLog(message: string): void {
  // Also log locally for iframe devtools
  console.log(message)

  // Forward to main app if we have a port
  if (workerPort && loggedConsumerId) {
    workerPort.postMessage({
      type: 'inset-log',
      consumerId: loggedConsumerId,
      logMessage: message,
    })
  }
}

// Callback to update shared interpolated states (registered by useAircraftInterpolation)
// This avoids circular dependencies while allowing direct updates to the rendering system
type SharedStatesUpdater = (aircraft: Map<string, InterpolatedAircraftState>) => void
let sharedStatesUpdater: SharedStatesUpdater | null = null

// Callback to request a Cesium render (registered by CesiumViewer)
// This forces Cesium to render a frame, bypassing browser RAF throttling in iframes
type RenderRequestCallback = () => void
let renderRequestCallback: RenderRequestCallback | null = null

/**
 * Register a callback to update shared interpolated states when broadcasts arrive.
 * Called by useAircraftInterpolation to connect the broadcast receiver to the rendering system.
 */
export function registerSharedStatesUpdater(updater: SharedStatesUpdater | null): void {
  sharedStatesUpdater = updater
}

/**
 * Register a callback to request a Cesium render when broadcasts arrive.
 * This forces Cesium to render even when browser throttles iframe RAF callbacks.
 * Called by CesiumViewer to connect the broadcast receiver to the rendering system.
 */
export function registerRenderRequestCallback(callback: RenderRequestCallback | null): void {
  renderRequestCallback = callback
}

/**
 * Get current broadcast aircraft data (for use by rendering/interpolation system)
 * This is the primary way to access aircraft data - no React state involved.
 */
export function getBroadcastAircraftData(): {
  aircraft: Map<string, InterpolatedAircraftState>
  timestamp: number
  seq: number
} {
  return {
    aircraft: broadcastAircraftData,
    timestamp: broadcastLastUpdateTime,
    seq: broadcastLastSeq,
  }
}

/** Local aircraft state maintained from broadcasts */
export interface BroadcastAircraftState {
  /** Map of callsign to interpolated aircraft state */
  aircraft: Map<string, InterpolatedAircraftState>
  /** Whether connected to the broadcast service */
  isConnected: boolean
  /** Last received sequence number */
  lastSeq: number
  /** Consumer ID assigned by the SharedWorker */
  consumerId: string | null
}

/**
 * Convert full broadcast format to InterpolatedAircraftState
 */
function toInterpolatedState(full: AircraftFull): InterpolatedAircraftState {
  return {
    callsign: full.c,
    cid: 0, // Not transmitted in broadcasts
    latitude: full.la,
    longitude: full.lo,
    altitude: full.al,
    heading: full.hd,
    groundspeed: full.gs,
    transponder: '', // Not transmitted in broadcasts
    interpolatedLatitude: full.la,
    interpolatedLongitude: full.lo,
    interpolatedAltitude: full.al,
    interpolatedHeading: full.hd,
    interpolatedGroundspeed: full.gs,
    interpolatedPitch: full.pi,
    interpolatedRoll: full.ro,
    verticalRate: full.vr,
    turnRate: full.tr,
    acceleration: full.ac,
    track: full.tk,
    aircraftType: full.ty ?? null,
    departure: full.dp ?? null,
    arrival: full.ar ?? null,
    timestamp: Date.now(),
    isInterpolated: true,
    // Model info from broadcast - allows insets to render MSFS models
    broadcastModelUrl: full.mu ?? null,
    broadcastModelScale: full.sc ?? null,
    broadcastRotationOffset: full.ro_off ?? null,
    broadcastIsFsltl: full.fsltl ?? null,
  }
}

/**
 * Apply delta update to existing aircraft state
 */
function applyDelta(
  existing: InterpolatedAircraftState,
  delta: AircraftDelta
): InterpolatedAircraftState {
  return {
    ...existing,
    latitude: delta.la ?? existing.latitude,
    longitude: delta.lo ?? existing.longitude,
    altitude: delta.al ?? existing.altitude,
    heading: delta.hd ?? existing.heading,
    groundspeed: delta.gs ?? existing.groundspeed,
    interpolatedLatitude: delta.la ?? existing.interpolatedLatitude,
    interpolatedLongitude: delta.lo ?? existing.interpolatedLongitude,
    interpolatedAltitude: delta.al ?? existing.interpolatedAltitude,
    interpolatedHeading: delta.hd ?? existing.interpolatedHeading,
    interpolatedGroundspeed: delta.gs ?? existing.interpolatedGroundspeed,
    interpolatedPitch: delta.pi ?? existing.interpolatedPitch,
    interpolatedRoll: delta.ro ?? existing.interpolatedRoll,
    verticalRate: delta.vr ?? existing.verticalRate,
    turnRate: delta.tr ?? existing.turnRate,
    acceleration: delta.ac ?? existing.acceleration,
    track: delta.tk ?? existing.track,
    // Delta fields use null for "no value", preserve that
    aircraftType: delta.ty !== undefined ? (delta.ty ?? null) : existing.aircraftType,
    departure: delta.dp !== undefined ? (delta.dp ?? null) : existing.departure,
    arrival: delta.ar !== undefined ? (delta.ar ?? null) : existing.arrival,
    // Model info from broadcast - only update if changed
    broadcastModelUrl: delta.mu !== undefined ? (delta.mu ?? null) : existing.broadcastModelUrl,
    broadcastModelScale: delta.sc !== undefined ? (delta.sc ?? null) : existing.broadcastModelScale,
    broadcastRotationOffset: delta.ro_off !== undefined ? (delta.ro_off ?? null) : existing.broadcastRotationOffset,
    broadcastIsFsltl: delta.fsltl !== undefined ? (delta.fsltl ?? null) : existing.broadcastIsFsltl,
    timestamp: Date.now(),
    isInterpolated: true,
  }
}

/**
 * Hook for inset iframes to receive aircraft position broadcasts.
 *
 * @returns Current aircraft state and connection status
 */
export function useBroadcastAircraft(): BroadcastAircraftState {
  const [state, setState] = useState<BroadcastAircraftState>({
    aircraft: new Map(),
    isConnected: false,
    lastSeq: 0,
    consumerId: null,
  })

  // Refs for tracking - these don't trigger re-renders
  const workerRef = useRef<SharedWorker | null>(null)
  const processTimeBuffer = useRef<number[]>([])
  const pendingMessagesRef = useRef<number>(0)
  const lastFeedbackTimeRef = useRef<number>(0)
  const consumerIdRef = useRef<string | null>(null)
  const lastSeqRef = useRef<number>(0)

  // Connect to SharedWorker on mount - empty deps = run once
  useEffect(() => {
    try {
      const worker = new SharedWorker(
        new URL('../workers/aircraft-broadcast.worker.ts', import.meta.url),
        { type: 'module', name: 'aircraft-broadcast' }
      )

      // Send feedback to the host (uses refs, not state)
      const sendFeedback = () => {
        if (!worker || !consumerIdRef.current) return

        const avgProcessingMs =
          processTimeBuffer.current.length > 0
            ? processTimeBuffer.current.reduce((a, b) => a + b, 0) / processTimeBuffer.current.length
            : 0

        const feedback: ConsumerFeedback = {
          consumerId: consumerIdRef.current,
          lastReceivedSeq: lastSeqRef.current,
          bufferDepth: pendingMessagesRef.current,
          avgProcessingMs,
        }

        worker.port.postMessage({
          type: 'feedback',
          consumerId: consumerIdRef.current,
          data: feedback,
        })

        // Clear buffer after sending
        processTimeBuffer.current = []
        lastFeedbackTimeRef.current = Date.now()
      }

      // Process incoming broadcast message
      // Updates module-level variable directly for immediate access by rendering system
      const processMessage = (message: BroadcastMessage) => {
        const startTime = performance.now()
        pendingMessagesRef.current++

        // Update module-level variable directly (bypasses React batching)
        const newAircraft = new Map(broadcastAircraftData)

        // Add new aircraft (full state)
        for (const full of message.f) {
          newAircraft.set(full.c, toInterpolatedState(full))
        }

        // Apply delta updates
        for (const delta of message.d) {
          const existing = newAircraft.get(delta.c)
          if (existing) {
            newAircraft.set(delta.c, applyDelta(existing, delta))
          } else {
            // Shouldn't happen, but handle gracefully
            insetLog(`[BroadcastConsumer] Delta for unknown aircraft: ${delta.c}`)
          }
        }

        // Remove aircraft
        for (const callsign of message.r) {
          newAircraft.delete(callsign)
        }

        // Update module-level state immediately (no React batching delay)
        broadcastAircraftData = newAircraft
        broadcastLastUpdateTime = Date.now()
        broadcastLastSeq = message.seq
        lastSeqRef.current = message.seq

        // Update shared interpolated states for rendering system (if registered)
        if (sharedStatesUpdater) {
          sharedStatesUpdater(newAircraft)
        }

        // Request Cesium render to bypass browser RAF throttling in iframes
        // This forces Cesium to render even when the browser throttles the iframe's RAF
        if (renderRequestCallback) {
          renderRequestCallback()
        }

        // Track processing time
        const processTime = performance.now() - startTime
        processTimeBuffer.current.push(processTime)
        if (processTimeBuffer.current.length > 20) {
          processTimeBuffer.current.shift()
        }
        pendingMessagesRef.current--

        // Send feedback periodically
        const now = Date.now()
        if (now - lastFeedbackTimeRef.current >= RATE_CONTROL.feedbackInterval) {
          sendFeedback()
        }
      }

      worker.port.onmessage = (event: MessageEvent) => {
        const message = event.data

        switch (message.type) {
          case 'registered':
            // We've been assigned a consumer ID
            consumerIdRef.current = message.consumerId
            loggedConsumerId = message.consumerId  // Store for log forwarding
            setState((prev) => ({
              ...prev,
              isConnected: true,
              consumerId: message.consumerId,
            }))
            break

          case 'aircraft-update':
            // Decode MessagePack data and process
            try {
              const decoded = decode(message.data) as BroadcastMessage
              processMessage(decoded)
            } catch (error) {
              insetLog(`[BroadcastConsumer] Failed to decode message: ${error}`)
            }
            break
        }
      }

      // Register as an inset consumer
      worker.port.postMessage({ type: 'register-inset' })
      worker.port.start()

      // Store port reference for log forwarding
      workerPort = worker.port
      workerRef.current = worker

      return () => {
        // Notify worker we're disconnecting
        // Always send disconnect - worker can look up by port if consumerId not yet assigned
        worker.port.postMessage({
          type: 'disconnect',
          consumerId: consumerIdRef.current, // May be null if cleanup races registration
        })
        worker.port.close()
        workerRef.current = null
        workerPort = null
        loggedConsumerId = null
      }
    } catch (error) {
      // Can't use insetLog here since worker failed to connect
      console.warn('[BroadcastConsumer] SharedWorker not available:', error)
    }
  }, []) // Empty deps - run once on mount

  // Return combined state: connection info from React state, aircraft from module-level
  // This ensures aircraft data is always current (not delayed by React batching)
  return {
    aircraft: broadcastAircraftData,
    isConnected: state.isConnected,
    lastSeq: broadcastLastSeq,
    consumerId: state.consumerId,
  }
}
