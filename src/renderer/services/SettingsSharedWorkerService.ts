/**
 * SettingsSharedWorkerService
 *
 * Service for broadcasting settings, weather, airport, Cesium token, and aircraft observations
 * to inset iframes via SharedWorker.
 *
 * This service acts as the main app's connection to the SharedWorker, enabling one-way
 * data flow to insets for:
 * - Settings (Cesium, graphics, camera, etc.)
 * - Weather data (fog, clouds)
 * - Airport info
 * - Aircraft observations (for inset-local interpolation)
 *
 * @see shared-data.worker.ts - SharedWorker implementation
 * @see useSharedWorkerConsumer - Inset consumer hook
 */

import { useSettingsStore } from '../stores/settingsStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useWeatherStore } from '../stores/weatherStore'
import { useAirportStore } from '../stores/airportStore'
import { useViewportStore } from '../stores/viewportStore'
import { registerBroadcastCallbacks } from '../stores/aircraftTimelineStore'
import { isRemoteMode } from '../utils/remoteMode'

// Import worker URL using Vite's worker query - this ensures proper bundling
import SharedDataWorkerUrl from '../workers/shared-data.worker.ts?sharedworker&url'
import type {
  SharedWorkerInboundMessage,
  SerializedSettings,
  SerializedWeather,
  SerializedAirport,
  SerializedImagery,
  SerializedModelInfo
} from '../types/shared-worker'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'

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
      // Create SharedWorker using Vite-bundled worker URL
      console.log('[SettingsSharedWorkerService] Creating SharedWorker:', SharedDataWorkerUrl)

      this.worker = new SharedWorker(
        SharedDataWorkerUrl,
        { type: 'module', name: 'towercab-shared' }
      )

      this.worker.onerror = (error) => {
        console.error('[SettingsSharedWorkerService] SharedWorker error:', error)
      }

      this.port = this.worker.port

      this.port.onmessageerror = (error) => {
        console.error('[SettingsSharedWorkerService] Message error:', error)
      }

      // Set up message handler for messages from insets
      this.port.onmessage = (event: MessageEvent) => {
        const { type, payload, viewportId } = event.data || {}

        switch (type) {
          case 'inset-log':
            // Log messages forwarded from insets
            if (viewportId && payload) {
              this.handleInsetLog(viewportId, payload as string)
            }
            break
          // Camera updates from insets could be handled here if needed
        }
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

      // Register broadcast callbacks with timeline store
      // This enables automatic broadcasting of observations/removals to insets
      registerBroadcastCallbacks(
        (observations) => this.broadcastObservations(observations),
        (callsigns) => this.broadcastRemovals(callsigns)
      )

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

  // ============================================================================
  // OBSERVATION BROADCASTING
  // ============================================================================
  // These methods are called by the timeline store when observations are added.
  // Observations are broadcast to insets which maintain their own timelines.

  /**
   * Broadcast a batch of observations to all insets.
   * Called by the timeline store when new observations arrive.
   *
   * Also relays to remote browsers via Tauri commands (in host mode).
   */
  broadcastObservations(
    observations: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }>
  ): void {
    if (observations.length === 0) return

    // Broadcast to insets via SharedWorker
    if (this.hasInsets()) {
      this.postMessage({
        type: 'observations-update',
        payload: observations,
        source: 'main'
      })
    }

    // Relay to remote browsers via Tauri commands (only in host mode)
    if (!isRemoteMode()) {
      this.relayObservationsToRemote(observations)
    }
  }

  /**
   * Broadcast aircraft removals to all insets.
   * Called by the timeline store when aircraft are removed.
   *
   * Also relays to remote browsers via Tauri commands (in host mode).
   */
  broadcastRemovals(callsigns: string[]): void {
    if (callsigns.length === 0) return

    // Broadcast to insets via SharedWorker
    if (this.hasInsets()) {
      this.postMessage({
        type: 'aircraft-removals',
        payload: callsigns,
        source: 'main'
      })
    }

    // Relay to remote browsers via Tauri commands (only in host mode)
    if (!isRemoteMode()) {
      this.relayRemovalsToRemote(callsigns)
    }
  }

  /**
   * Relay observations to remote browsers via Tauri command.
   * Converts to the ObservationData format expected by the backend.
   */
  private async relayObservationsToRemote(
    observations: Array<{
      callsign: string
      observation: AircraftObservation
      metadata: AircraftMetadata
    }>
  ): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')

      // Convert to ObservationData format
      const data = observations.map(({ callsign, observation, metadata }) => ({
        callsign,
        latitude: observation.latitude,
        longitude: observation.longitude,
        altitude: observation.altitude,
        heading: observation.heading,
        groundspeed: observation.groundspeed,
        groundTrack: observation.groundTrack ?? observation.heading,
        verticalRate: observation.verticalRate ?? 0,
        onGround: observation.onGround ?? false,
        pitch: observation.pitch,
        roll: observation.roll,
        source: observation.source,
        observedAt: observation.observedAt,
        receivedAt: observation.receivedAt,
        typeCode: metadata.aircraftType,
        origin: metadata.departure,
        destination: metadata.arrival,
        flightRules: null
      }))

      await invoke('broadcast_observations', { observations: data })
    } catch (error) {
      // Silently ignore - Tauri may not be available or command may fail
      console.debug('[SettingsSharedWorkerService] Failed to relay observations:', error)
    }
  }

  /**
   * Relay aircraft removals to remote browsers via Tauri command.
   */
  private async relayRemovalsToRemote(callsigns: string[]): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('broadcast_aircraft_removals', { callsigns })
    } catch (error) {
      // Silently ignore
      console.debug('[SettingsSharedWorkerService] Failed to relay removals:', error)
    }
  }

  /**
   * Broadcast model info updates to all insets.
   * Called when model assignments change for aircraft (new model resolved, conversion complete).
   */
  broadcastModelInfo(models: SerializedModelInfo[]): void {
    if (!this.hasInsets() || models.length === 0) return

    this.postMessage({
      type: 'model-info-update',
      payload: {
        models,
        timestamp: Date.now()
      },
      source: 'main'
    })
  }

  /**
   * Handle log messages from insets (forwarded via SharedWorker).
   */
  private handleInsetLog(viewportId: string, message: string): void {
    console.log(`[Inset:${viewportId}] ${message}`)
  }
}

// Export singleton instance
export const settingsSharedWorkerService = new SettingsSharedWorkerService()
