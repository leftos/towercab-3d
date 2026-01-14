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
  SerializedImagery
} from '../types/shared-worker'

// Singleton SharedWorker instance for insets
let sharedWorker: SharedWorker | null = null
let sharedWorkerPort: MessagePort | null = null

// Callbacks registered by consumer instances
// NOTE: Aircraft callbacks removed - aircraft data now comes from useBroadcastAircraft
const settingsCallbacks = new Set<(settings: SerializedSettings) => void>()
const imageryCallbacks = new Set<(imagery: SerializedImagery) => void>()
const weatherCallbacks = new Set<(weather: SerializedWeather) => void>()
const tokenCallbacks = new Set<(token: string) => void>()
const airportCallbacks = new Set<(airport: SerializedAirport | null) => void>()

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

          case 'debug-info':
            // Debug messages from SharedWorker are silently ignored
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
