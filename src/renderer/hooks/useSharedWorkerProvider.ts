/**
 * Hook for main app to push data to SharedWorker for inset iframes
 *
 * This hook:
 * - Initializes the SharedWorker connection
 * - Pushes settings changes (debounced)
 * - Pushes weather updates
 * - Pushes Cesium Ion token on init
 *
 * NOTE: Aircraft broadcasting is now handled by AircraftBroadcastService
 * with delta compression and consumer-driven rate control.
 *
 * @see useSharedWorkerConsumer - Consumer hook for inset iframes
 * @see shared-data.worker.ts - SharedWorker implementation
 * @see AircraftBroadcastService - Delta-compressed aircraft broadcasting
 */

import { useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useWeatherStore } from '../stores/weatherStore'
import { useViewportStore } from '../stores/viewportStore'
import { useAirportStore } from '../stores/airportStore'
import type {
  SharedWorkerInboundMessage,
  SharedWorkerOutboundMessage,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport,
  SerializedImagery
} from '../types/shared-worker'

// Singleton SharedWorker instance (shared across all hook calls)
let sharedWorker: SharedWorker | null = null
let sharedWorkerPort: MessagePort | null = null
let providerInstanceCount = 0

// Debounce timer for settings updates
let settingsDebounceTimer: ReturnType<typeof setTimeout> | null = null
const SETTINGS_DEBOUNCE_MS = 100

/**
 * Get or create the singleton SharedWorker instance
 */
function getSharedWorker(): { worker: SharedWorker; port: MessagePort } | null {
  if (!sharedWorker) {
    try {
      const workerUrl = new URL('../workers/shared-data.worker.ts', import.meta.url)

      // Create SharedWorker with module type
      sharedWorker = new SharedWorker(
        workerUrl,
        { type: 'module', name: 'towercab-shared' }
      )

      // Handle worker-level errors
      sharedWorker.onerror = (error) => {
        console.error('[SharedWorkerProvider] SharedWorker error:', error)
      }

      sharedWorkerPort = sharedWorker.port

      sharedWorkerPort.onmessageerror = (error) => {
        console.error('[SharedWorkerProvider] Message error:', error)
      }

      sharedWorkerPort.start()
    } catch (error) {
      console.error('[SharedWorkerProvider] Failed to create SharedWorker:', error)
      return null
    }
  }

  return sharedWorker && sharedWorkerPort
    ? { worker: sharedWorker, port: sharedWorkerPort }
    : null
}

/**
 * Serialize settings for SharedWorker transfer
 * Passes the actual settings objects directly to avoid type mismatches
 */
function serializeSettings(): SerializedSettings {
  const settings = useSettingsStore.getState()

  return {
    cesium: settings.cesium,
    graphics: settings.graphics,
    camera: settings.camera,
    weather: settings.weather,
    memory: settings.memory,
    aircraft: settings.aircraft,
    ui: settings.ui
  }
}

/**
 * Serialize weather data for SharedWorker transfer
 */
function serializeWeather(): SerializedWeather {
  const weather = useWeatherStore.getState()

  return {
    fogDensity: weather.fogDensity,
    // Get visibility from METAR (default to 10SM if no METAR)
    visibility: weather.currentMetar?.visib ?? 10,
    cloudLayers: weather.cloudLayers?.map(c => ({
      altitude: c.altitude,
      coverage: c.coverage,
      type: c.type
    })) ?? []
  }
}

/**
 * Serialize airport data for SharedWorker transfer
 */
function serializeAirport(): SerializedAirport | null {
  const airportState = useAirportStore.getState()
  const airport = airportState.currentAirport

  if (!airport) return null

  return {
    icao: airport.icao,
    name: airport.name,
    latitude: airport.lat,
    longitude: airport.lon,
    elevation: airport.elevation ?? 0,
    towerHeight: airportState.towerHeight
  }
}

/**
 * Serialize imagery settings for SharedWorker transfer
 */
function serializeImagery(): SerializedImagery {
  const globalSettings = useGlobalSettingsStore.getState()
  const imagery = globalSettings.imagery

  return {
    provider: imagery.provider,
    googleMapsApiKey: imagery.googleMapsApiKey,
    cesiumAdjustments: imagery.cesiumAdjustments,
    googleAdjustments: imagery.googleAdjustments
  }
}

/**
 * Post a message to the SharedWorker
 */
function postToWorker(message: SharedWorkerInboundMessage) {
  const worker = getSharedWorker()
  if (worker) {
    try {
      worker.port.postMessage(message)
    } catch (error) {
      console.error('[SharedWorkerProvider] Failed to post message:', error)
    }
  }
}

/**
 * Hook for main app to provide data to inset iframes via SharedWorker
 *
 * This should be called once in the main app (e.g., in App.tsx).
 * It sets up the SharedWorker connection and subscribes to store changes
 * to push updates to connected insets.
 *
 * NOTE: Aircraft broadcasting is now handled separately by AircraftBroadcastService
 * with delta compression and consumer-driven rate control.
 *
 * @param enabled - Whether to enable SharedWorker communication (default: true)
 */
export function useSharedWorkerProvider(enabled: boolean = true) {

  // Get inset viewport count to determine if we should push data
  const insetCount = useViewportStore(state => state.viewports.length - 1)
  const hasInsets = insetCount > 0

  // Initialize SharedWorker and push initial data
  useEffect(() => {
    if (!enabled || !hasInsets) return

    providerInstanceCount++

    const worker = getSharedWorker()
    if (!worker) return

    // Listen for messages from SharedWorker (camera updates from insets)
    // Note: Bidirectional camera sync is complex because setHeading/setPitch operate
    // on the active viewport, not a specific viewport ID. For now, insets manage
    // their own camera state. Future: Could store this for bookmarking or viewport
    // state persistence.
    worker.port.onmessage = (_event: MessageEvent<SharedWorkerOutboundMessage>) => {
      // Camera updates from insets are received but not applied to main app's viewportStore
      // The inset manages its own camera state independently
    }

    // Push Cesium Ion token immediately
    const cesiumToken = useGlobalSettingsStore.getState().cesiumIonToken
    if (cesiumToken) {
      postToWorker({
        type: 'cesium-token',
        payload: cesiumToken,
        source: 'main'
      })
    }

    // Push initial imagery settings
    postToWorker({
      type: 'imagery-update',
      payload: serializeImagery(),
      source: 'main'
    })

    // Push initial settings
    postToWorker({
      type: 'settings-update',
      payload: serializeSettings(),
      source: 'main'
    })

    // Push initial weather
    postToWorker({
      type: 'weather-update',
      payload: serializeWeather(),
      source: 'main'
    })

    // Push initial airport
    const airport = serializeAirport()
    if (airport) {
      postToWorker({
        type: 'airport-update',
        payload: airport,
        source: 'main'
      })
    }

    return () => {
      providerInstanceCount--

      // Clean up SharedWorker when last provider unmounts
      if (providerInstanceCount === 0 && sharedWorker) {
        sharedWorkerPort?.close()
        sharedWorker = null
        sharedWorkerPort = null
      }
    }
  }, [enabled, hasInsets])

  // Subscribe to settings changes
  useEffect(() => {
    if (!enabled || !hasInsets) return

    const unsubscribeSettings = useSettingsStore.subscribe(() => {
      // Debounce settings updates
      if (settingsDebounceTimer) {
        clearTimeout(settingsDebounceTimer)
      }
      settingsDebounceTimer = setTimeout(() => {
        postToWorker({
          type: 'settings-update',
          payload: serializeSettings(),
          source: 'main'
        })
      }, SETTINGS_DEBOUNCE_MS)
    })

    const unsubscribeGlobalSettings = useGlobalSettingsStore.subscribe((state, prevState) => {
      // Push Cesium token changes
      if (state.cesiumIonToken !== prevState.cesiumIonToken) {
        postToWorker({
          type: 'cesium-token',
          payload: state.cesiumIonToken,
          source: 'main'
        })
      }

      // Push imagery settings changes
      if (state.imagery !== prevState.imagery) {
        postToWorker({
          type: 'imagery-update',
          payload: serializeImagery(),
          source: 'main'
        })
      }

      // Push display settings changes
      if (state.display !== prevState.display) {
        if (settingsDebounceTimer) {
          clearTimeout(settingsDebounceTimer)
        }
        settingsDebounceTimer = setTimeout(() => {
          postToWorker({
            type: 'settings-update',
            payload: serializeSettings(),
            source: 'main'
          })
        }, SETTINGS_DEBOUNCE_MS)
      }
    })

    return () => {
      unsubscribeSettings()
      unsubscribeGlobalSettings()
      if (settingsDebounceTimer) {
        clearTimeout(settingsDebounceTimer)
        settingsDebounceTimer = null
      }
    }
  }, [enabled, hasInsets])

  // Subscribe to weather changes
  useEffect(() => {
    if (!enabled || !hasInsets) return

    const unsubscribeWeather = useWeatherStore.subscribe(() => {
      postToWorker({
        type: 'weather-update',
        payload: serializeWeather(),
        source: 'main'
      })
    })

    return () => {
      unsubscribeWeather()
    }
  }, [enabled, hasInsets])

  // Subscribe to airport changes
  useEffect(() => {
    if (!enabled || !hasInsets) return

    const unsubscribeAirport = useAirportStore.subscribe((state, prevState) => {
      // Push airport update when airport or tower height changes
      if (state.currentAirport !== prevState.currentAirport ||
          state.towerHeight !== prevState.towerHeight) {
        postToWorker({
          type: 'airport-update',
          payload: serializeAirport(),
          source: 'main'
        })
      }
    })

    return () => {
      unsubscribeAirport()
    }
  }, [enabled, hasInsets])

  // NOTE: Aircraft updates are now handled by AircraftBroadcastService
  // with delta compression and consumer-driven rate control.
  // See: src/renderer/services/AircraftBroadcastService.ts
}

export default useSharedWorkerProvider
