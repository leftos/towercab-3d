/**
 * SettingsSharedWorkerService
 *
 * Service for broadcasting settings, weather, airport, and Cesium token to inset iframes
 * via SharedWorker. Uses the same pattern as AircraftBroadcastService which works correctly.
 *
 * @see AircraftBroadcastService - The working pattern this is based on
 * @see shared-data.worker.ts - SharedWorker implementation
 */

import { useSettingsStore } from '../stores/settingsStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useWeatherStore } from '../stores/weatherStore'
import { useAirportStore } from '../stores/airportStore'
import { useViewportStore } from '../stores/viewportStore'
import type {
  SharedWorkerInboundMessage,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport,
  SerializedImagery
} from '../types/shared-worker'

const SETTINGS_DEBOUNCE_MS = 100

class SettingsSharedWorkerService {
  private worker: SharedWorker | null = null
  private port: MessagePort | null = null
  private isInitialized = false
  private settingsDebounceTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribers: (() => void)[] = []

  /**
   * Initialize the service - creates SharedWorker and sets up subscriptions
   * Call this once from App.tsx on mount
   */
  initialize(): void {
    if (this.isInitialized) {
      console.log('[SettingsSharedWorkerService] Already initialized')
      return
    }

    console.log('[SettingsSharedWorkerService] Initializing...')

    try {
      // Create SharedWorker
      const workerUrl = new URL('../workers/shared-data.worker.ts', import.meta.url)
      console.log('[SettingsSharedWorkerService] Creating SharedWorker:', workerUrl.href)

      this.worker = new SharedWorker(
        workerUrl,
        { type: 'module', name: 'towercab-shared' }
      )

      this.worker.onerror = (error) => {
        console.error('[SettingsSharedWorkerService] SharedWorker error:', error)
      }

      this.port = this.worker.port

      this.port.onmessageerror = (error) => {
        console.error('[SettingsSharedWorkerService] Message error:', error)
      }

      // Set up message handler (we don't process incoming messages, but need handler for start())
      this.port.onmessage = () => {
        // Camera updates from insets are received but not applied to main app
      }

      // Start the port
      this.port.start()
      console.log('[SettingsSharedWorkerService] Port started')

      // Push Cesium Ion token immediately
      const cesiumToken = useGlobalSettingsStore.getState().cesiumIonToken
      console.log('[SettingsSharedWorkerService] Pushing token:', cesiumToken ? 'yes' : 'no')
      if (cesiumToken) {
        this.postMessage({
          type: 'cesium-token',
          payload: cesiumToken,
          source: 'main'
        })
      }

      // Push initial imagery settings
      this.postMessage({
        type: 'imagery-update',
        payload: this.serializeImagery(),
        source: 'main'
      })

      // Subscribe to viewport changes to push data when insets are added
      this.subscribeToViewportChanges()

      // Subscribe to settings/weather/airport changes
      this.subscribeToStoreChanges()

      this.isInitialized = true
      console.log('[SettingsSharedWorkerService] Initialization complete')

    } catch (error) {
      console.error('[SettingsSharedWorkerService] Failed to initialize:', error)
    }
  }

  /**
   * Subscribe to viewport changes - push initial data when insets are added
   */
  private subscribeToViewportChanges(): void {
    let prevInsetCount = useViewportStore.getState().viewports.length - 1

    const unsubscribe = useViewportStore.subscribe((state) => {
      const insetCount = state.viewports.length - 1

      // Push initial data when first inset is added
      if (prevInsetCount === 0 && insetCount > 0) {
        console.log('[SettingsSharedWorkerService] First inset added, pushing initial data')
        this.pushInitialData()
      }

      prevInsetCount = insetCount
    })

    this.unsubscribers.push(unsubscribe)
  }

  /**
   * Subscribe to store changes to push updates
   */
  private subscribeToStoreChanges(): void {
    // Settings changes (debounced)
    const unsubSettings = useSettingsStore.subscribe(() => {
      if (!this.hasInsets()) return

      if (this.settingsDebounceTimer) {
        clearTimeout(this.settingsDebounceTimer)
      }
      this.settingsDebounceTimer = setTimeout(() => {
        this.postMessage({
          type: 'settings-update',
          payload: this.serializeSettings(),
          source: 'main'
        })
      }, SETTINGS_DEBOUNCE_MS)
    })
    this.unsubscribers.push(unsubSettings)

    // Global settings changes (token, imagery, display)
    const unsubGlobal = useGlobalSettingsStore.subscribe((state, prevState) => {
      // Token changes
      if (state.cesiumIonToken !== prevState.cesiumIonToken) {
        this.postMessage({
          type: 'cesium-token',
          payload: state.cesiumIonToken,
          source: 'main'
        })
      }

      // Imagery changes
      if (state.imagery !== prevState.imagery) {
        this.postMessage({
          type: 'imagery-update',
          payload: this.serializeImagery(),
          source: 'main'
        })
      }

      // Display settings changes
      if (state.display !== prevState.display && this.hasInsets()) {
        if (this.settingsDebounceTimer) {
          clearTimeout(this.settingsDebounceTimer)
        }
        this.settingsDebounceTimer = setTimeout(() => {
          this.postMessage({
            type: 'settings-update',
            payload: this.serializeSettings(),
            source: 'main'
          })
        }, SETTINGS_DEBOUNCE_MS)
      }
    })
    this.unsubscribers.push(unsubGlobal)

    // Weather changes
    const unsubWeather = useWeatherStore.subscribe(() => {
      if (!this.hasInsets()) return

      this.postMessage({
        type: 'weather-update',
        payload: this.serializeWeather(),
        source: 'main'
      })
    })
    this.unsubscribers.push(unsubWeather)

    // Airport changes
    const unsubAirport = useAirportStore.subscribe((state, prevState) => {
      if (!this.hasInsets()) return

      if (state.currentAirport !== prevState.currentAirport ||
          state.towerHeight !== prevState.towerHeight) {
        this.postMessage({
          type: 'airport-update',
          payload: this.serializeAirport(),
          source: 'main'
        })
      }
    })
    this.unsubscribers.push(unsubAirport)
  }

  /**
   * Push initial settings/weather/airport data
   */
  private pushInitialData(): void {
    this.postMessage({
      type: 'settings-update',
      payload: this.serializeSettings(),
      source: 'main'
    })

    this.postMessage({
      type: 'weather-update',
      payload: this.serializeWeather(),
      source: 'main'
    })

    const airport = this.serializeAirport()
    if (airport) {
      this.postMessage({
        type: 'airport-update',
        payload: airport,
        source: 'main'
      })
    }
  }

  /**
   * Check if there are any inset viewports
   */
  private hasInsets(): boolean {
    return useViewportStore.getState().viewports.length > 1
  }

  /**
   * Post a message to the SharedWorker
   */
  private postMessage(message: SharedWorkerInboundMessage): void {
    if (this.port) {
      try {
        this.port.postMessage(message)
      } catch (error) {
        console.error('[SettingsSharedWorkerService] Failed to post message:', error)
      }
    }
  }

  // Serialization helpers

  private serializeSettings(): SerializedSettings {
    const settings = useSettingsStore.getState()
    const globalSettings = useGlobalSettingsStore.getState()
    return {
      cesium: settings.cesium,
      graphics: settings.graphics,
      camera: settings.camera,
      weather: settings.weather,
      memory: settings.memory,
      aircraft: settings.aircraft,
      ui: settings.ui,
      display: globalSettings.display
    }
  }

  private serializeWeather(): SerializedWeather {
    const weather = useWeatherStore.getState()
    return {
      fogDensity: weather.fogDensity,
      visibility: weather.currentMetar?.visib ?? 10,
      cloudLayers: weather.cloudLayers?.map(c => ({
        altitude: c.altitude,
        coverage: c.coverage,
        type: c.type
      })) ?? []
    }
  }

  private serializeAirport(): SerializedAirport | null {
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

  private serializeImagery(): SerializedImagery {
    const globalSettings = useGlobalSettingsStore.getState()
    const imagery = globalSettings.imagery
    return {
      provider: imagery.provider,
      googleMapsApiKey: imagery.googleMapsApiKey,
      cesiumAdjustments: imagery.cesiumAdjustments,
      googleAdjustments: imagery.googleAdjustments
    }
  }
}

// Export singleton instance
export const settingsSharedWorkerService = new SettingsSharedWorkerService()
