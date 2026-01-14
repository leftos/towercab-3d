/**
 * SharedWorker for broadcasting data from main app to inset iframes
 *
 * This worker enables isolated Cesium viewers in iframes to receive:
 * - Interpolated aircraft positions (60 Hz)
 * - Settings snapshots (on change)
 * - Weather data (on change)
 * - Cesium Ion token (on init)
 *
 * Architecture:
 * - Main app connects and pushes data
 * - Inset iframes connect and receive broadcasts
 * - One-way data flow (main → insets) for most data
 * - Camera state can flow both directions via postMessage (not through SharedWorker)
 */

// SharedWorker type declarations for TypeScript
// These are not included in the default lib.dom.d.ts
interface SharedWorkerGlobalScopeEventMap {
  connect: MessageEvent
}

interface SharedWorkerGlobalScopeType {
  onconnect: ((this: SharedWorkerGlobalScopeType, ev: MessageEvent) => void) | null
  addEventListener<K extends keyof SharedWorkerGlobalScopeEventMap>(
    type: K,
    listener: (this: SharedWorkerGlobalScopeType, ev: SharedWorkerGlobalScopeEventMap[K]) => void
  ): void
  close(): void
}

// Cast self to SharedWorkerGlobalScope
const workerSelf = self as unknown as SharedWorkerGlobalScopeType

// Import shared types
// Note: In a SharedWorker context, we need to use inline types since imports
// from the main bundle may not work. Types are duplicated in types/shared-worker.ts
// for use by the main app hooks.

type SharedWorkerMessageType =
  | 'aircraft-update'
  | 'settings-update'
  | 'weather-update'
  | 'cesium-token'
  | 'imagery-update'
  | 'airport-update'
  | 'viewport-camera'
  | 'register-inset'
  | 'unregister-inset'

interface SharedWorkerInboundMessage {
  type: SharedWorkerMessageType
  payload: unknown
  viewportId?: string
  source?: 'main' | 'inset'
}

interface SharedWorkerOutboundMessage {
  type: SharedWorkerMessageType
  payload: unknown
  viewportId?: string
  timestamp: number
}

interface SerializedAircraftState {
  callsign: string
  [key: string]: unknown  // Allow other fields
}

interface SerializedSettings {
  [key: string]: unknown  // Settings structure
}

interface SerializedWeather {
  metar: string | null
  [key: string]: unknown  // Other weather fields
}

interface SerializedAirport {
  icao: string
  name: string
  latitude: number
  longitude: number
  elevation: number
  towerHeight: number
}

interface SerializedImagery {
  provider: string
  googleMapsApiKey: string
  cesiumAdjustments: unknown
  googleAdjustments: unknown
}

// ============================================================================
// SHARED WORKER STATE
// ============================================================================

/** Connected ports from main app and insets */
const connectedPorts: Set<MessagePort> = new Set()

/** Track which port is the main app (for routing) */
let mainAppPort: MessagePort | null = null

/** Track inset viewport IDs and their ports */
const insetPorts: Map<string, MessagePort> = new Map()

/** Latest data cache (for new connections) */
const dataCache = {
  aircraft: null as SerializedAircraftState[] | null,
  settings: null as SerializedSettings | null,
  weather: null as SerializedWeather | null,
  cesiumToken: null as string | null,
  imagery: null as SerializedImagery | null,
  airport: null as SerializedAirport | null,
  timestamp: 0
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handle incoming messages from connected ports
 */
function handleMessage(port: MessagePort, event: MessageEvent<SharedWorkerInboundMessage>) {
  const { type, payload, viewportId, source } = event.data

  // If this message is from 'main' source, update mainAppPort to handle reconnection (e.g., F5 reload)
  // SharedWorkers persist across page reloads, so the main app may reconnect with a new port
  if (source === 'main' && port !== mainAppPort) {
    mainAppPort = port
  }

  switch (type) {
    case 'register-inset':
      // Register an inset viewport
      if (viewportId) {
        insetPorts.set(viewportId, port)
        // Send cached data to newly connected inset
        sendCachedDataToPort(port)
      }
      break

    case 'unregister-inset':
      // Unregister an inset viewport
      if (viewportId) {
        insetPorts.delete(viewportId)
      }
      break

    case 'aircraft-update':
      // Only accept aircraft updates from main app
      if (source === 'main' || port === mainAppPort) {
        const aircraftPayload = payload as SerializedAircraftState[]
        dataCache.aircraft = aircraftPayload
        dataCache.timestamp = Date.now()
        broadcastToInsets({ type, payload, timestamp: dataCache.timestamp })
      }
      break

    case 'settings-update':
      // Only accept settings updates from main app
      if (source === 'main' || port === mainAppPort) {
        dataCache.settings = payload as SerializedSettings
        broadcastToInsets({ type, payload, timestamp: Date.now() })
      }
      break

    case 'weather-update':
      // Only accept weather updates from main app
      if (source === 'main' || port === mainAppPort) {
        dataCache.weather = payload as SerializedWeather
        broadcastToInsets({ type, payload, timestamp: Date.now() })
      }
      break

    case 'cesium-token':
      // Only accept token from main app
      if (source === 'main' || port === mainAppPort) {
        dataCache.cesiumToken = payload as string
        broadcastToInsets({ type, payload, timestamp: Date.now() })
      }
      break

    case 'imagery-update':
      // Only accept imagery settings from main app
      if (source === 'main' || port === mainAppPort) {
        dataCache.imagery = payload as SerializedImagery
        broadcastToInsets({ type, payload, timestamp: Date.now() })
      }
      break

    case 'airport-update':
      // Only accept airport updates from main app
      if (source === 'main' || port === mainAppPort) {
        dataCache.airport = payload as SerializedAirport | null
        broadcastToInsets({ type, payload, timestamp: Date.now() })
      }
      break

    case 'viewport-camera':
      // Camera updates can come from insets - forward to main app
      if (source === 'inset' && mainAppPort) {
        mainAppPort.postMessage({ type, payload, viewportId, timestamp: Date.now() })
      }
      break
  }
}

/**
 * Send cached data to a newly connected port
 */
function sendCachedDataToPort(port: MessagePort) {
  if (dataCache.cesiumToken) {
    port.postMessage({
      type: 'cesium-token',
      payload: dataCache.cesiumToken,
      timestamp: Date.now()
    })
  }

  if (dataCache.settings) {
    port.postMessage({
      type: 'settings-update',
      payload: dataCache.settings,
      timestamp: Date.now()
    })
  }

  if (dataCache.weather) {
    port.postMessage({
      type: 'weather-update',
      payload: dataCache.weather,
      timestamp: Date.now()
    })
  }

  if (dataCache.imagery) {
    port.postMessage({
      type: 'imagery-update',
      payload: dataCache.imagery,
      timestamp: Date.now()
    })
  }

  if (dataCache.airport) {
    port.postMessage({
      type: 'airport-update',
      payload: dataCache.airport,
      timestamp: Date.now()
    })
  }

  if (dataCache.aircraft) {
    port.postMessage({
      type: 'aircraft-update',
      payload: dataCache.aircraft,
      timestamp: dataCache.timestamp
    })
  }
}

/**
 * Broadcast a message to all connected inset ports
 */
function broadcastToInsets(message: SharedWorkerOutboundMessage) {
  if (insetPorts.size === 0) {
    return
  }

  for (const [viewportId, port] of insetPorts.entries()) {
    try {
      port.postMessage(message)
    } catch {
      // Port may have been disconnected - remove it
      insetPorts.delete(viewportId)
    }
  }
}

// ============================================================================
// CONNECTION HANDLING
// ============================================================================

/**
 * Handle new connections to the SharedWorker
 */
workerSelf.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]
  connectedPorts.add(port)

  // First connection is assumed to be main app
  if (!mainAppPort) {
    mainAppPort = port
  }

  port.onmessage = (messageEvent: MessageEvent<SharedWorkerInboundMessage>) => {
    handleMessage(port, messageEvent)
  }

  port.onmessageerror = (errorEvent) => {
    console.error('[SharedWorker] Message error:', errorEvent)
  }

  // Handle port close (if supported)
  // Note: MessagePort doesn't have onclose, we rely on error handling
  port.start()
}
