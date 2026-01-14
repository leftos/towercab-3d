/**
 * Hook for inset iframes to consume data from SharedWorker
 *
 * This hook:
 * - Connects to the SharedWorker as an inset
 * - Receives settings updates
 * - Receives weather updates
 * - Receives Cesium Ion token
 * - Provides state for the inset app to render
 *
 * NOTE: Aircraft data is handled separately by useBroadcastAircraft hook
 * which uses delta-compressed broadcasts via aircraft-broadcast.worker.ts
 *
 * @see useSharedWorkerProvider - Provider hook for main app
 * @see shared-data.worker.ts - SharedWorker implementation
 * @see useBroadcastAircraft - Hook for receiving aircraft broadcasts
 */

import { useEffect, useState, useRef } from 'react'
import type {
  SharedWorkerInboundMessage,
  SharedWorkerOutboundMessage,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport,
  SerializedImagery,
  SerializedModelInfo,
  ModelInfoUpdatePayload
} from '../types/shared-worker'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'

/**
 * Batch of observations received from the main app
 */
export type ObservationsBatch = Array<{
  callsign: string
  observation: AircraftObservation
  metadata: AircraftMetadata
}>

/**
 * Whether this hook should automatically feed observations to the timeline store.
 * Set to true when used in inset context.
 */
let autoFeedToTimeline = false

/**
 * Enable automatic feeding of observations to timeline store.
 * Call this once in inset context before using useSharedWorkerConsumer.
 */
export function enableObservationAutoFeed(): void {
  autoFeedToTimeline = true
}

/**
 * Default handler that feeds observations to the timeline store
 */
function handleObservationsForTimeline(observations: ObservationsBatch): void {
  if (!autoFeedToTimeline) return
  const timelineStore = useAircraftTimelineStore.getState()
  timelineStore.addObservationBatch(observations)
}

/**
 * Default handler that removes aircraft from the timeline store
 */
function handleRemovalsForTimeline(callsigns: string[]): void {
  if (!autoFeedToTimeline) return
  const timelineStore = useAircraftTimelineStore.getState()
  for (const callsign of callsigns) {
    timelineStore.removeAircraft(callsign)
  }
}

// Singleton SharedWorker instance for insets
let sharedWorker: SharedWorker | null = null
let sharedWorkerPort: MessagePort | null = null

// Callbacks registered by consumer instances
const settingsCallbacks = new Set<(settings: SerializedSettings) => void>()
const imageryCallbacks = new Set<(imagery: SerializedImagery) => void>()
const weatherCallbacks = new Set<(weather: SerializedWeather) => void>()
const tokenCallbacks = new Set<(token: string) => void>()
const airportCallbacks = new Set<(airport: SerializedAirport | null) => void>()
const observationsCallbacks = new Set<(observations: ObservationsBatch) => void>()
const removalsCallbacks = new Set<(callsigns: string[]) => void>()
const modelInfoCallbacks = new Set<(models: SerializedModelInfo[]) => void>()

// ============================================================================
// MODEL INFO STORAGE (for insets)
// ============================================================================
// Model info received from main app, keyed by callsign.
// This allows useAircraftModels to look up model info for rendering.
const modelInfoCache = new Map<string, SerializedModelInfo>()

/**
 * Get model info for a callsign (for inset rendering).
 * Returns null if no model info has been received from the main app.
 */
export function getModelInfoForCallsign(callsign: string): SerializedModelInfo | null {
  return modelInfoCache.get(callsign) ?? null
}

/**
 * Default handler that stores model info in the cache
 */
function handleModelInfoForCache(models: SerializedModelInfo[]): void {
  if (!autoFeedToTimeline) return // Only active in inset context
  for (const model of models) {
    modelInfoCache.set(model.callsign, model)
  }
}

/**
 * Default handler that removes model info when aircraft are removed
 */
function handleRemovalsForModelCache(callsigns: string[]): void {
  if (!autoFeedToTimeline) return
  for (const callsign of callsigns) {
    modelInfoCache.delete(callsign)
  }
}

// Register the default handlers (always active, will check autoFeedToTimeline flag)
observationsCallbacks.add(handleObservationsForTimeline)
removalsCallbacks.add(handleRemovalsForTimeline)
removalsCallbacks.add(handleRemovalsForModelCache)
modelInfoCallbacks.add(handleModelInfoForCache)

/**
 * Get or create the singleton SharedWorker connection for insets
 */
function getSharedWorkerConnection(): { worker: SharedWorker; port: MessagePort } | null {
  if (!sharedWorker) {
    try {
      const workerUrl = new URL('../workers/shared-data.worker.ts', import.meta.url)
      console.log('[SharedWorkerConsumer] Creating SharedWorker:', workerUrl.href)

      // Connect to existing SharedWorker
      sharedWorker = new SharedWorker(
        workerUrl,
        { type: 'module', name: 'towercab-shared' }
      )

      // Handle worker-level errors (e.g., script load failures)
      sharedWorker.onerror = (error) => {
        console.error('[SharedWorkerConsumer] SharedWorker error:', error)
      }

      sharedWorkerPort = sharedWorker.port

      // Handle incoming messages
      sharedWorkerPort.onmessage = (event: MessageEvent<SharedWorkerOutboundMessage>) => {
        const { type, payload } = event.data
        console.log('[SharedWorkerConsumer] Received message:', type)

        switch (type) {
          // NOTE: 'aircraft-update' removed - aircraft data now comes from useBroadcastAircraft

          case 'settings-update':
            for (const callback of settingsCallbacks) {
              callback(payload as SerializedSettings)
            }
            break

          case 'weather-update':
            for (const callback of weatherCallbacks) {
              callback(payload as SerializedWeather)
            }
            break

          case 'cesium-token':
            console.log('[SharedWorkerConsumer] Got cesium-token, callbacks:', tokenCallbacks.size)
            for (const callback of tokenCallbacks) {
              callback(payload as string)
            }
            break

          case 'imagery-update':
            for (const callback of imageryCallbacks) {
              callback(payload as SerializedImagery)
            }
            break

          case 'airport-update':
            for (const callback of airportCallbacks) {
              callback(payload as SerializedAirport | null)
            }
            break

          case 'observations-update':
            // Raw observations for timeline-based interpolation
            for (const callback of observationsCallbacks) {
              callback(payload as ObservationsBatch)
            }
            break

          case 'aircraft-removals':
            // Aircraft removal notifications
            for (const callback of removalsCallbacks) {
              callback(payload as string[])
            }
            break

          case 'model-info-update':
            // Model info updates from main app
            {
              const modelPayload = payload as ModelInfoUpdatePayload
              for (const callback of modelInfoCallbacks) {
                callback(modelPayload.models)
              }
            }
            break
        }
      }

      sharedWorkerPort.onmessageerror = (error) => {
        console.error('[SharedWorkerConsumer] Message error:', error)
      }

      sharedWorkerPort.start()
    } catch (error) {
      console.error('[SharedWorkerConsumer] Failed to connect to SharedWorker:', error)
      return null
    }
  }

  return sharedWorker && sharedWorkerPort
    ? { worker: sharedWorker, port: sharedWorkerPort }
    : null
}

/**
 * Post a message to the SharedWorker
 */
function postToWorker(message: SharedWorkerInboundMessage) {
  if (sharedWorkerPort) {
    try {
      sharedWorkerPort.postMessage(message)
    } catch (error) {
      console.error('[SharedWorkerConsumer] Failed to post message:', error)
    }
  }
}

/**
 * Forward a log message from inset to main app via SharedWorker.
 * Also logs locally for iframe devtools.
 */
export function insetLog(message: string, viewportId?: string): void {
  console.log(message)
  postToWorker({
    type: 'inset-log',
    payload: message,
    viewportId,
    source: 'inset'
  })
}

/**
 * State provided to inset consumers
 * NOTE: Aircraft data comes from useBroadcastAircraft hook, not here
 */
export interface SharedWorkerConsumerState {
  /** Settings snapshot from main app */
  settings: SerializedSettings | null
  /** Weather data from main app */
  weather: SerializedWeather | null
  /** Cesium Ion token from main app */
  cesiumToken: string | null
  /** Imagery provider settings from main app */
  imagery: SerializedImagery | null
  /** Airport data from main app */
  airport: SerializedAirport | null
  /** Whether connected to SharedWorker */
  connected: boolean
  /** Last update timestamp */
  lastUpdate: number
}

/**
 * Hook for inset iframes to consume data from SharedWorker
 *
 * @param viewportId - Unique ID for this inset viewport
 * @returns Consumer state with settings, weather, and cesium token
 */
export function useSharedWorkerConsumer(viewportId: string): SharedWorkerConsumerState {
  const [settings, setSettings] = useState<SerializedSettings | null>(null)
  const [weather, setWeather] = useState<SerializedWeather | null>(null)
  const [cesiumToken, setCesiumToken] = useState<string | null>(null)
  const [imagery, setImagery] = useState<SerializedImagery | null>(null)
  const [airport, setAirport] = useState<SerializedAirport | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState(0)

  // Track if we've registered with the worker
  const registeredRef = useRef(false)

  // Initialize connection and register as inset
  useEffect(() => {
    console.log('[SharedWorkerConsumer] Effect running for viewport:', viewportId)
    // Set up callbacks FIRST, before connecting
    // This ensures callbacks are registered before any messages arrive from the SharedWorker
    // (e.g., cached data sent immediately on registration)
    const handleSettings = (data: SerializedSettings) => {
      setSettings(data)
      setLastUpdate(Date.now())
    }

    const handleWeather = (data: SerializedWeather) => {
      setWeather(data)
      setLastUpdate(Date.now())
    }

    const handleToken = (token: string) => {
      console.log('[SharedWorkerConsumer] Received token:', token ? 'exists' : 'missing')
      setCesiumToken(token)
    }

    const handleImagery = (data: SerializedImagery) => {
      setImagery(data)
    }

    const handleAirport = (data: SerializedAirport | null) => {
      setAirport(data)
    }

    settingsCallbacks.add(handleSettings)
    weatherCallbacks.add(handleWeather)
    tokenCallbacks.add(handleToken)
    imageryCallbacks.add(handleImagery)
    airportCallbacks.add(handleAirport)

    // Now connect to the SharedWorker
    console.log('[SharedWorkerConsumer] Connecting to SharedWorker...')
    const worker = getSharedWorkerConnection()
    if (!worker) {
      console.error('[SharedWorkerConsumer] Could not connect to SharedWorker')
      return
    }

    console.log('[SharedWorkerConsumer] Connected to SharedWorker')
    setConnected(true)

    // Register this inset with the worker
    // The SharedWorker will send cached data (including token) in response
    if (!registeredRef.current) {
      console.log('[SharedWorkerConsumer] Registering inset:', viewportId)
      postToWorker({
        type: 'register-inset',
        viewportId,
        source: 'inset'
      })
      registeredRef.current = true
    }

    return () => {
      // Remove callbacks specific to this effect invocation
      settingsCallbacks.delete(handleSettings)
      weatherCallbacks.delete(handleWeather)
      tokenCallbacks.delete(handleToken)
      imageryCallbacks.delete(handleImagery)
      airportCallbacks.delete(handleAirport)

      // Don't unregister or close SharedWorker connection during cleanup
      // SharedWorkers are long-lived browser resources that persist across
      // React Strict Mode's double-mount cycle. Closing the port here would
      // break the connection when React re-mounts the component.
      // The SharedWorker will clean up stale ports automatically when they
      // fail to receive messages.
    }
  }, [viewportId])

  return {
    settings,
    weather,
    cesiumToken,
    imagery,
    airport,
    connected,
    lastUpdate
  }
}

/**
 * Send camera state changes from inset back to main app via SharedWorker
 *
 * @param viewportId - The inset viewport ID
 * @param cameraState - Partial camera state to update
 */
export function sendCameraUpdate(
  viewportId: string,
  cameraState: {
    heading?: number
    pitch?: number
    fov?: number
    positionOffsetX?: number
    positionOffsetY?: number
    positionOffsetZ?: number
    followingCallsign?: string | null
    orbitDistance?: number
    orbitHeading?: number
    orbitPitch?: number
  }
) {
  postToWorker({
    type: 'viewport-camera',
    payload: cameraState,
    viewportId,
    source: 'inset'
  })
}

export default useSharedWorkerConsumer
