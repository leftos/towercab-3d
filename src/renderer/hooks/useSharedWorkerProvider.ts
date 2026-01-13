/**
 * Hook for main app to push data to SharedWorker for inset iframes
 *
 * This hook:
 * - Initializes the SharedWorker connection
 * - Pushes interpolated aircraft state on each frame
 * - Pushes settings changes (debounced)
 * - Pushes weather updates
 * - Pushes Cesium Ion token on init
 *
 * @see useSharedWorkerConsumer - Consumer hook for inset iframes
 * @see shared-data.worker.ts - SharedWorker implementation
 */

import { useEffect, useRef, useCallback } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useWeatherStore } from '../stores/weatherStore'
import { useViewportStore } from '../stores/viewportStore'
import { useAirportStore } from '../stores/airportStore'
import type {
  SharedWorkerInboundMessage,
  SharedWorkerOutboundMessage,
  SerializedAircraftState,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport
} from '../types/shared-worker'
import type { InterpolatedAircraftState } from '../types/vatsim'

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
      // Log the SharedWorker URL for debugging
      const workerUrl = new URL('../workers/shared-data.worker.ts', import.meta.url)
      console.log('[SharedWorkerProvider] Creating SharedWorker with URL:', workerUrl.href)

      // Create SharedWorker with module type
      // Note: The worker URL needs to be handled by Vite
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
      console.log('[SharedWorkerProvider] SharedWorker initialized')
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
 * Serialize interpolated aircraft states for SharedWorker transfer
 */
function serializeAircraftStates(
  states: Map<string, InterpolatedAircraftState>
): SerializedAircraftState[] {
  const serialized: SerializedAircraftState[] = []

  for (const [, aircraft] of states) {
    serialized.push({
      callsign: aircraft.callsign,
      cid: aircraft.cid,
      latitude: aircraft.latitude,
      longitude: aircraft.longitude,
      altitude: aircraft.altitude,
      groundspeed: aircraft.groundspeed,
      heading: aircraft.heading,
      groundTrack: aircraft.groundTrack ?? null,
      transponder: aircraft.transponder,
      aircraftType: aircraft.aircraftType ?? '',
      departure: aircraft.departure ?? '',
      arrival: aircraft.arrival ?? '',
      timestamp: aircraft.timestamp,

      interpolatedLatitude: aircraft.interpolatedLatitude,
      interpolatedLongitude: aircraft.interpolatedLongitude,
      interpolatedAltitude: aircraft.interpolatedAltitude,
      interpolatedHeading: aircraft.interpolatedHeading,
      interpolatedGroundspeed: aircraft.interpolatedGroundspeed,
      interpolatedPitch: aircraft.interpolatedPitch,
      interpolatedRoll: aircraft.interpolatedRoll,

      verticalRate: aircraft.verticalRate,
      turnRate: aircraft.turnRate,
      acceleration: aircraft.acceleration,
      track: aircraft.track,

      isInterpolated: aircraft.isInterpolated
    })
  }

  return serialized
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
 * @param interpolatedAircraft - Map of interpolated aircraft states (from useAircraftInterpolation)
 * @param enabled - Whether to enable SharedWorker communication (default: true)
 */
export function useSharedWorkerProvider(
  interpolatedAircraft: Map<string, InterpolatedAircraftState> | null,
  enabled: boolean = true
) {
  const lastAircraftCountRef = useRef(0)
  const lastPushTimeRef = useRef(0)
  const animationFrameRef = useRef<number | null>(null)

  // Get inset viewport count to determine if we should push data
  const insetCount = useViewportStore(state => state.viewports.length - 1)
  const hasInsets = insetCount > 0

  // Debug logging for inset count
  useEffect(() => {
    console.log(`[SharedWorkerProvider] Inset count changed: ${insetCount}, hasInsets: ${hasInsets}`)
  }, [insetCount, hasInsets])

  // Initialize SharedWorker and push initial data
  useEffect(() => {
    if (!enabled || !hasInsets) return

    providerInstanceCount++

    const worker = getSharedWorker()
    if (!worker) return

    // Listen for messages from SharedWorker (camera updates from insets)
    // Note: Currently we just log these for debugging. Bidirectional camera sync
    // is complex because setHeading/setPitch operate on the active viewport,
    // not a specific viewport ID. For now, insets manage their own camera state.
    worker.port.onmessage = (event: MessageEvent<SharedWorkerOutboundMessage>) => {
      const { type, viewportId, payload } = event.data

      if (type === 'viewport-camera' && viewportId) {
        // Camera updates from insets are received but not applied to main app's viewportStore
        // The inset manages its own camera state independently
        // Future: Could store this for bookmarking or viewport state persistence
      }

      if (type === 'debug-info' && payload && typeof payload === 'object' && 'message' in payload) {
        // Log debug info from SharedWorker
        console.log(`[SharedWorkerProvider] ${(payload as { message: string }).message}`)
      }
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

  // Track last log time for throttled logging
  const lastPushLogTimeRef = useRef(0)

  // Push aircraft updates on animation frame
  const pushAircraftUpdate = useCallback(() => {
    if (!enabled || !hasInsets || !interpolatedAircraft) {
      animationFrameRef.current = requestAnimationFrame(pushAircraftUpdate)
      return
    }

    const now = performance.now()
    const aircraftCount = interpolatedAircraft.size

    // Throttle to ~30 Hz to reduce SharedWorker overhead
    // Only push if aircraft count changed or 33ms elapsed
    const shouldPush =
      aircraftCount !== lastAircraftCountRef.current ||
      now - lastPushTimeRef.current > 33

    if (shouldPush && aircraftCount > 0) {
      postToWorker({
        type: 'aircraft-update',
        payload: serializeAircraftStates(interpolatedAircraft),
        source: 'main'
      })
      lastAircraftCountRef.current = aircraftCount
      lastPushTimeRef.current = now
      // Log occasionally to confirm data is flowing
      if (now - lastPushLogTimeRef.current > 2000) {
        console.log(`[SharedWorkerProvider] Pushed ${aircraftCount} aircraft to SharedWorker`)
        lastPushLogTimeRef.current = now
      }
    }

    animationFrameRef.current = requestAnimationFrame(pushAircraftUpdate)
  }, [enabled, hasInsets, interpolatedAircraft])

  // Start aircraft push loop
  useEffect(() => {
    if (!enabled || !hasInsets) {
      console.log(`[SharedWorkerProvider] Not starting aircraft loop: enabled=${enabled}, hasInsets=${hasInsets}`)
      return
    }

    console.log(`[SharedWorkerProvider] Starting aircraft push loop`)
    animationFrameRef.current = requestAnimationFrame(pushAircraftUpdate)

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
    }
  }, [enabled, hasInsets, pushAircraftUpdate])
}

export default useSharedWorkerProvider
