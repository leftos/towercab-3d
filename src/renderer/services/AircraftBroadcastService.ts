/**
 * Aircraft Broadcast Service
 *
 * Central service for broadcasting interpolated aircraft positions to consumers
 * (inset iframes via SharedWorker, remote browsers via WebSocket).
 *
 * Features:
 * - Delta compression: Only send fields that changed (in background worker)
 * - Consumer-driven rate control: Each consumer gets individualized rates
 * - MessagePack encoding: ~50% smaller than JSON (in background worker)
 * - Per-consumer state tracking: Handles slow consumers gracefully
 * - **Non-blocking encoding**: Heavy encoding work happens in a dedicated worker
 *
 * @see docs/plans/unified-aircraft-broadcasting.md
 */

import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ConsumerFeedback, ConsumerState } from '../types/broadcast'
import { RATE_CONTROL } from '../types/broadcast'
import { isTauriMode } from '../utils/remoteMode'
import { aircraftModelService } from './AircraftModelService'

/**
 * Aircraft data sent to encoding worker.
 */
interface AircraftData {
  callsign: string
  interpolatedLatitude: number
  interpolatedLongitude: number
  interpolatedAltitude: number
  interpolatedHeading: number
  interpolatedGroundspeed: number
  interpolatedPitch: number
  interpolatedRoll: number
  verticalRate: number
  turnRate: number
  acceleration: number
  track: number
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  // Model info for insets to render MSFS models
  modelUrl: string | null
  modelScale: [number, number, number] | null
  rotationOffset: number | null
  isFsltl: boolean | null
}

/**
 * Extended consumer state with transport-specific data.
 */
interface ConsumerStateInternal extends ConsumerState {
  /** MessagePort for SharedWorker consumers */
  port?: MessagePort
  /** For tracking WebSocket consumers (actual WS is on Rust side) */
  wsId?: string
  /** Whether this consumer needs a full state sync (newly connected) */
  needsFullSync: boolean
}

/**
 * Pending broadcast request waiting for encoding.
 */
interface PendingBroadcast {
  requestId: number
  timestamp: number
  consumersToSend: Array<{
    consumer: ConsumerStateInternal
    needsFullSync: boolean
  }>
}

class AircraftBroadcastService {
  /** Current sequence number (updated by worker) */
  private sequence = 0

  /** Registered consumers */
  private consumers = new Map<string, ConsumerStateInternal>()

  /** SharedWorker for inset communication */
  private sharedWorker: SharedWorker | null = null

  /** Dedicated worker for encoding (offloads MessagePack from main thread) */
  private encoderWorker: Worker | null = null

  /** Whether the service has been initialized */
  private initialized = false

  /** Request ID counter for matching responses */
  private nextRequestId = 0

  /** Pending broadcast requests */
  private pendingBroadcasts = new Map<number, PendingBroadcast>()

  /**
   * Initialize the broadcast service.
   * Call once when the main app starts.
   */
  initialize(): void {
    if (this.initialized) return
    if (!isTauriMode()) return // Only host app broadcasts

    // Initialize dedicated encoding worker (offloads MessagePack from main thread)
    try {
      this.encoderWorker = new Worker(
        new URL('../workers/broadcast-encoder.worker.ts', import.meta.url),
        { type: 'module', name: 'broadcast-encoder' }
      )

      this.encoderWorker.onmessage = (event) => {
        this.handleEncoderResponse(event.data)
      }

      this.encoderWorker.onerror = (error) => {
        console.error('[Broadcast] Encoder worker error:', error)
      }
    } catch (error) {
      console.warn('[Broadcast] Encoder worker not available:', error)
    }

    // Initialize SharedWorker for inset communication
    try {
      this.sharedWorker = new SharedWorker(
        new URL('../workers/aircraft-broadcast.worker.ts', import.meta.url),
        { type: 'module', name: 'aircraft-broadcast' }
      )

      this.sharedWorker.port.onmessage = (event) => {
        this.handleSharedWorkerMessage(event.data)
      }

      // Register as the main app
      this.sharedWorker.port.postMessage({ type: 'register-main' })
      this.sharedWorker.port.start()
    } catch (error) {
      console.warn('[Broadcast] SharedWorker not available:', error)
    }

    // Listen for WebSocket consumer events from Tauri
    this.setupTauriListeners()

    this.initialized = true
    console.log('[Broadcast] Service initialized with background encoder')
  }

  /**
   * Set up Tauri event listeners for WebSocket consumer management.
   */
  private async setupTauriListeners(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event')

      // Consumer connected via WebSocket
      await listen<string>('consumer-connected', (event) => {
        const consumerId = event.payload
        this.registerConsumer(consumerId, 'websocket')
        console.log(`[Broadcast] WebSocket consumer connected: ${consumerId}`)
      })

      // Consumer disconnected
      await listen<string>('consumer-disconnected', (event) => {
        const consumerId = event.payload
        this.unregisterConsumer(consumerId)
        console.log(`[Broadcast] WebSocket consumer disconnected: ${consumerId}`)
      })

      // Consumer feedback received
      await listen<[string, Uint8Array]>('consumer-feedback', async (event) => {
        const [consumerId, data] = event.payload
        try {
          const { decode } = await import('@msgpack/msgpack')
          const feedback = decode(data) as ConsumerFeedback
          this.onConsumerFeedback({ ...feedback, consumerId })
        } catch (error) {
          console.warn('[Broadcast] Failed to decode feedback:', error)
        }
      })
    } catch (error) {
      console.warn('[Broadcast] Failed to setup Tauri listeners:', error)
    }
  }

  /**
   * Handle messages from the SharedWorker.
   */
  private handleSharedWorkerMessage(message: { type: string; consumerId?: string; data?: unknown }): void {
    switch (message.type) {
      case 'consumer-connected':
        if (message.consumerId) {
          this.registerConsumer(message.consumerId, 'sharedworker')
          console.log(`[Broadcast] SharedWorker consumer connected: ${message.consumerId}`)
        }
        break

      case 'consumer-disconnected':
        if (message.consumerId) {
          this.unregisterConsumer(message.consumerId)
          console.log(`[Broadcast] SharedWorker consumer disconnected: ${message.consumerId}`)
        }
        break

      case 'feedback':
        if (message.consumerId && message.data) {
          this.onConsumerFeedback({
            ...(message.data as ConsumerFeedback),
            consumerId: message.consumerId,
          })
        }
        break
    }
  }

  /**
   * Handle encoded response from the encoder worker.
   */
  private handleEncoderResponse(response: {
    type: string
    requestId: number
    deltaEncoded: Uint8Array | null
    fullSyncEncoded: Uint8Array | null
    sequence: number
  }): void {
    if (response.type !== 'broadcast-encoded') return

    const pending = this.pendingBroadcasts.get(response.requestId)
    if (!pending) return

    this.pendingBroadcasts.delete(response.requestId)
    this.sequence = response.sequence

    // Dispatch to consumers
    for (const { consumer, needsFullSync } of pending.consumersToSend) {
      if (needsFullSync && response.fullSyncEncoded) {
        this.sendToConsumer(consumer, response.fullSyncEncoded)
        consumer.needsFullSync = false
        console.log(`[Broadcast] Sent full sync to ${consumer.id}`)
      } else if (response.deltaEncoded) {
        this.sendToConsumer(consumer, response.deltaEncoded)
      }

      consumer.lastSendTime = pending.timestamp
      consumer.lastSentSeq = response.sequence
    }
  }

  /**
   * Register a new consumer.
   */
  registerConsumer(
    id: string,
    transport: 'sharedworker' | 'websocket',
    port?: MessagePort
  ): void {
    this.consumers.set(id, {
      id,
      lastSentSeq: 0,
      lastSendTime: 0,
      interval: RATE_CONTROL.defaultInterval,
      transport,
      port,
      needsFullSync: true, // New consumers need full state on first broadcast
    })
  }

  /**
   * Unregister a consumer.
   */
  unregisterConsumer(id: string): void {
    this.consumers.delete(id)
  }

  /**
   * Handle feedback from a consumer to adjust their rate.
   */
  onConsumerFeedback(feedback: ConsumerFeedback): void {
    const consumer = this.consumers.get(feedback.consumerId)
    if (!consumer) return

    const lag = consumer.lastSentSeq - feedback.lastReceivedSeq

    if (lag > RATE_CONTROL.lagThreshold || feedback.bufferDepth > RATE_CONTROL.bufferThreshold) {
      // Consumer falling behind - slow down
      consumer.interval = Math.min(
        consumer.interval * RATE_CONTROL.slowdownFactor,
        RATE_CONTROL.maxInterval
      )
    } else if (
      lag <= 1 &&
      feedback.bufferDepth === 0 &&
      feedback.avgProcessingMs < RATE_CONTROL.processingThreshold
    ) {
      // Consumer keeping up easily - speed up
      consumer.interval = Math.max(
        consumer.interval * RATE_CONTROL.speedupFactor,
        RATE_CONTROL.minInterval
      )
    }
  }

  /**
   * Broadcast aircraft state to all consumers.
   * Called from the interpolation loop at 60Hz.
   *
   * This method is non-blocking - encoding happens in a background worker.
   */
  broadcast(
    aircraft: Map<string, InterpolatedAircraftState>,
    now: number
  ): void {
    if (!this.initialized || this.consumers.size === 0) return
    if (!this.encoderWorker) return

    // Determine which consumers need updates this frame
    const consumersToSend: Array<{ consumer: ConsumerStateInternal; needsFullSync: boolean }> = []
    const consumersNeedingFullSync: string[] = []

    for (const consumer of this.consumers.values()) {
      if (now - consumer.lastSendTime < consumer.interval) continue

      consumersToSend.push({
        consumer,
        needsFullSync: consumer.needsFullSync,
      })

      if (consumer.needsFullSync) {
        consumersNeedingFullSync.push(consumer.id)
      }
    }

    // No consumers need updates this frame
    if (consumersToSend.length === 0) return

    // Convert Map to array for transfer to worker
    const aircraftArray: AircraftData[] = []
    for (const state of aircraft.values()) {
      // Get model info for this aircraft (cached internally for performance)
      const modelInfo = aircraftModelService.getModelInfo(state.aircraftType, state.callsign)

      aircraftArray.push({
        callsign: state.callsign,
        interpolatedLatitude: state.interpolatedLatitude,
        interpolatedLongitude: state.interpolatedLongitude,
        interpolatedAltitude: state.interpolatedAltitude,
        interpolatedHeading: state.interpolatedHeading,
        interpolatedGroundspeed: state.interpolatedGroundspeed,
        interpolatedPitch: state.interpolatedPitch,
        interpolatedRoll: state.interpolatedRoll,
        verticalRate: state.verticalRate,
        turnRate: state.turnRate,
        acceleration: state.acceleration,
        track: state.track,
        aircraftType: state.aircraftType ?? null,
        departure: state.departure ?? null,
        arrival: state.arrival ?? null,
        // Include model info so insets can render MSFS models
        modelUrl: modelInfo.modelUrl || null,
        modelScale: [modelInfo.scale.x, modelInfo.scale.y, modelInfo.scale.z],
        rotationOffset: modelInfo.rotationOffset ?? null,
        isFsltl: modelInfo.isFsltl ?? null,
      })
    }

    // Store pending request
    const requestId = this.nextRequestId++
    this.pendingBroadcasts.set(requestId, {
      requestId,
      timestamp: now,
      consumersToSend,
    })

    // Send to encoder worker (non-blocking)
    this.encoderWorker.postMessage({
      type: 'encode-broadcast',
      requestId,
      aircraft: aircraftArray,
      timestamp: now,
      consumersNeedingFullSync,
    })
  }

  /**
   * Send encoded message to a consumer.
   */
  private sendToConsumer(consumer: ConsumerStateInternal, encoded: Uint8Array): void {
    if (consumer.transport === 'sharedworker') {
      // Send via SharedWorker
      this.sharedWorker?.port.postMessage({
        type: 'broadcast',
        consumerId: consumer.id,
        data: encoded,
      })
    } else {
      // Send via Tauri to WebSocket
      this.sendToWebSocket(consumer.id, encoded)
    }
  }

  /**
   * Send data to a WebSocket consumer via Tauri.
   */
  private async sendToWebSocket(consumerId: string, data: Uint8Array): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('send_to_remote_consumer', {
        consumerId,
        data: Array.from(data), // Convert to array for Tauri serialization
      })
    } catch (error) {
      // Consumer may have disconnected
      console.warn(`[Broadcast] Failed to send to ${consumerId}:`, error)
    }
  }

  /**
   * Get the number of connected consumers.
   */
  getConsumerCount(): number {
    return this.consumers.size
  }

  /**
   * Get consumer statistics for debugging.
   */
  getConsumerStats(): Array<{ id: string; interval: number; transport: string }> {
    return Array.from(this.consumers.values()).map((c) => ({
      id: c.id,
      interval: c.interval,
      transport: c.transport,
    }))
  }
}

// Singleton instance
export const aircraftBroadcastService = new AircraftBroadcastService()
