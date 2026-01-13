/**
 * Hook for inset iframes to consume data from SharedWorker
 *
 * This hook:
 * - Connects to the SharedWorker as an inset
 * - Receives interpolated aircraft state
 * - Receives settings updates
 * - Receives weather updates
 * - Receives Cesium Ion token
 * - Provides state for the inset app to render
 *
 * @see useSharedWorkerProvider - Provider hook for main app
 * @see shared-data.worker.ts - SharedWorker implementation
 */

import { useEffect, useState, useRef } from 'react'
import type {
  SharedWorkerInboundMessage,
  SharedWorkerOutboundMessage,
  SerializedAircraftState,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport
} from '../types/shared-worker'

// Singleton SharedWorker instance for insets
let sharedWorker: SharedWorker | null = null
let sharedWorkerPort: MessagePort | null = null
let consumerInstanceCount = 0

// Callbacks registered by consumer instances
const aircraftCallbacks = new Set<(aircraft: SerializedAircraftState[]) => void>()
const settingsCallbacks = new Set<(settings: SerializedSettings) => void>()
const weatherCallbacks = new Set<(weather: SerializedWeather) => void>()
const tokenCallbacks = new Set<(token: string) => void>()
const airportCallbacks = new Set<(airport: SerializedAirport | null) => void>()

/**
 * Get or create the singleton SharedWorker connection for insets
 */
function getSharedWorkerConnection(): { worker: SharedWorker; port: MessagePort } | null {
  if (!sharedWorker) {
    try {
      // Log the SharedWorker URL for debugging
      const workerUrl = new URL('../workers/shared-data.worker.ts', import.meta.url)
      console.log('[SharedWorkerConsumer] Creating SharedWorker with URL:', workerUrl.href)

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

      // Track message count for debugging
      let messageCount = 0
      let lastMessageLogTime = 0

      // Handle incoming messages
      sharedWorkerPort.onmessage = (event: MessageEvent<SharedWorkerOutboundMessage>) => {
        const { type, payload } = event.data
        messageCount++

        // Log message receipt occasionally
        const now = Date.now()
        if (now - lastMessageLogTime > 5000) {
          console.log(`[SharedWorkerConsumer] Message #${messageCount} received: ${type}`)
          lastMessageLogTime = now
        }

        switch (type) {
          case 'aircraft-update':
            for (const callback of aircraftCallbacks) {
              callback(payload as SerializedAircraftState[])
            }
            break

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
            for (const callback of tokenCallbacks) {
              callback(payload as string)
            }
            break

          case 'airport-update':
            for (const callback of airportCallbacks) {
              callback(payload as SerializedAirport | null)
            }
            break

          case 'debug-info':
            // Debug message from SharedWorker - log it and relay to parent
            if (payload && typeof payload === 'object' && 'message' in payload) {
              const msg = (payload as { message: string }).message
              console.log('[SharedWorkerConsumer] Debug from worker:', msg)
              try {
                window.parent?.postMessage(
                  { type: 'debug-log', message: `[SharedWorker] ${msg}` },
                  '*'
                )
              } catch {
                // Ignore if parent is same-origin blocked
              }
            }
            break
        }
      }

      sharedWorkerPort.onmessageerror = (error) => {
        console.error('[SharedWorkerConsumer] Message error:', error)
      }

      sharedWorkerPort.start()
      console.log('[SharedWorkerConsumer] Connected to SharedWorker')

      // Report to parent window for visibility in Tauri logs
      try {
        window.parent?.postMessage(
          { type: 'debug-log', message: '[SharedWorkerConsumer] Connected to SharedWorker' },
          '*'
        )
      } catch {
        // Ignore if parent is same-origin blocked
      }
    } catch (error) {
      console.error('[SharedWorkerConsumer] Failed to connect to SharedWorker:', error)
      // Report error to parent window
      try {
        window.parent?.postMessage(
          { type: 'debug-log', message: `[SharedWorkerConsumer] Error: ${error}` },
          '*'
        )
      } catch {
        // Ignore
      }
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
 */
export interface SharedWorkerConsumerState {
  /** Interpolated aircraft states from main app */
  aircraft: Map<string, SerializedAircraftState>
  /** Settings snapshot from main app */
  settings: SerializedSettings | null
  /** Weather data from main app */
  weather: SerializedWeather | null
  /** Cesium Ion token from main app */
  cesiumToken: string | null
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
 * @returns Consumer state with aircraft, settings, weather, and cesium token
 */
export function useSharedWorkerConsumer(viewportId: string): SharedWorkerConsumerState {
  const [aircraft, setAircraft] = useState<Map<string, SerializedAircraftState>>(new Map())
  const [settings, setSettings] = useState<SerializedSettings | null>(null)
  const [weather, setWeather] = useState<SerializedWeather | null>(null)
  const [cesiumToken, setCesiumToken] = useState<string | null>(null)
  const [airport, setAirport] = useState<SerializedAirport | null>(null)
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState(0)

  // Track if we've registered with the worker
  const registeredRef = useRef(false)

  // Initialize connection and register as inset
  useEffect(() => {
    consumerInstanceCount++

    const worker = getSharedWorkerConnection()
    if (!worker) {
      console.error('[SharedWorkerConsumer] Could not connect to SharedWorker')
      return
    }

    setConnected(true)

    // Register this inset with the worker
    if (!registeredRef.current) {
      postToWorker({
        type: 'register-inset',
        viewportId,
        source: 'inset'
      })
      registeredRef.current = true
    }

    // Track last log time to avoid spam
    let lastAircraftLogTime = 0
    let aircraftUpdateCount = 0

    // Set up callbacks
    const handleAircraft = (data: SerializedAircraftState[]) => {
      const newMap = new Map<string, SerializedAircraftState>()
      for (const ac of data) {
        newMap.set(ac.callsign, ac)
      }
      setAircraft(newMap)
      setLastUpdate(Date.now())
      aircraftUpdateCount++

      // Log occasionally (every ~2 seconds) to confirm data is flowing
      const now = Date.now()
      if (now - lastAircraftLogTime > 2000) {
        const msg = `Received ${data.length} aircraft (update #${aircraftUpdateCount})`
        console.log(`[SharedWorkerConsumer] ${msg}`)
        // Relay to parent window so it appears in Tauri logs
        try {
          window.parent?.postMessage(
            { type: 'debug-log', message: `[SharedWorkerConsumer] ${msg}` },
            '*'
          )
        } catch {
          // Ignore if blocked
        }
        lastAircraftLogTime = now
      }
    }

    const handleSettings = (data: SerializedSettings) => {
      setSettings(data)
    }

    const handleWeather = (data: SerializedWeather) => {
      setWeather(data)
    }

    const handleToken = (token: string) => {
      setCesiumToken(token)
    }

    const handleAirport = (data: SerializedAirport | null) => {
      setAirport(data)
    }

    aircraftCallbacks.add(handleAircraft)
    settingsCallbacks.add(handleSettings)
    weatherCallbacks.add(handleWeather)
    tokenCallbacks.add(handleToken)
    airportCallbacks.add(handleAirport)

    return () => {
      consumerInstanceCount--

      // Remove callbacks
      aircraftCallbacks.delete(handleAircraft)
      settingsCallbacks.delete(handleSettings)
      weatherCallbacks.delete(handleWeather)
      tokenCallbacks.delete(handleToken)
      airportCallbacks.delete(handleAirport)

      // Unregister from worker
      if (registeredRef.current) {
        postToWorker({
          type: 'unregister-inset',
          viewportId,
          source: 'inset'
        })
        registeredRef.current = false
      }

      // Clean up SharedWorker when last consumer unmounts
      if (consumerInstanceCount === 0 && sharedWorker) {
        sharedWorkerPort?.close()
        sharedWorker = null
        sharedWorkerPort = null
      }
    }
  }, [viewportId])

  return {
    aircraft,
    settings,
    weather,
    cesiumToken,
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
