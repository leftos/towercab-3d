/**
 * Hook to synchronize SharedWorker data to local stores in inset iframes
 *
 * This hook populates the inset's local Zustand stores with data received
 * from the main app via SharedWorker. Since iframes have their own JavaScript
 * context, they have their own store instances that need to be populated.
 *
 * Syncs:
 * - globalSettingsStore: Cesium Ion token, imagery provider settings
 * - settingsStore: Graphics, cesium, aircraft, weather settings
 * - weatherStore: METAR and fog data
 *
 * Note: Aircraft observations are handled by useSharedWorkerConsumer which
 * feeds them to the timeline store (via enableObservationAutoFeed) for
 * interpolation by useAircraftInterpolation.
 */

import { useEffect, useRef } from 'react'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWeatherStore } from '../stores/weatherStore'
import { useAirportStore } from '../stores/airportStore'
import type {
  SerializedSettings,
  SerializedWeather,
  SerializedAirport,
  SerializedImagery,
} from '../types/shared-worker'
// Re-export isInsetContext from tauriApi for backward compatibility
export { isInsetContext } from '../utils/tauriApi'

interface UseInsetStoreSyncOptions {
  settings: SerializedSettings | null
  weather: SerializedWeather | null
  cesiumToken: string | null
  imagery: SerializedImagery | null
  airport: SerializedAirport | null
}

/**
 * Synchronize SharedWorker data to local stores
 *
 * @param options - Data received from SharedWorker via useSharedWorkerConsumer
 */
export function useInsetStoreSync({ settings, weather, cesiumToken, imagery, airport }: UseInsetStoreSyncOptions) {
  const initializedRef = useRef(false)

  // Sync Cesium Ion token to globalSettingsStore
  useEffect(() => {
    if (cesiumToken) {
      const store = useGlobalSettingsStore.getState()
      if (store.cesiumIonToken !== cesiumToken) {
        // Directly set the token without calling the async setter
        useGlobalSettingsStore.setState({ cesiumIonToken: cesiumToken })
      }
    }
  }, [cesiumToken])

  // Sync imagery settings to globalSettingsStore
  // This ensures insets use the same imagery provider as the main app
  useEffect(() => {
    if (!imagery) return

    const currentImagery = useGlobalSettingsStore.getState().imagery
    // Only update if imagery settings have changed
    if (
      currentImagery.provider !== imagery.provider ||
      currentImagery.googleMapsApiKey !== imagery.googleMapsApiKey ||
      currentImagery.cesiumAdjustments !== imagery.cesiumAdjustments ||
      currentImagery.googleAdjustments !== imagery.googleAdjustments
    ) {
      useGlobalSettingsStore.setState({
        imagery: {
          provider: imagery.provider,
          googleMapsApiKey: imagery.googleMapsApiKey,
          cesiumAdjustments: imagery.cesiumAdjustments,
          googleAdjustments: imagery.googleAdjustments,
        },
      })
    }
  }, [imagery])

  // Sync settings to settingsStore
  useEffect(() => {
    if (!settings) return

    const store = useSettingsStore.getState()

    // Update settings groups directly since they match the store types
    store.updateGraphicsSettings(settings.graphics)
    store.updateCesiumSettings(settings.cesium)
    store.updateAircraftSettings(settings.aircraft)
    store.updateWeatherSettings(settings.weather)
    store.updateCameraSettings(settings.camera)
    store.updateMemorySettings(settings.memory)
    store.updateUISettings(settings.ui)

    // Sync global display settings (datablocks, labels, inset settings)
    if (settings.display) {
      const currentDisplay = useGlobalSettingsStore.getState().display
      // Only update if display settings have changed
      if (JSON.stringify(currentDisplay) !== JSON.stringify(settings.display)) {
        useGlobalSettingsStore.setState({ display: settings.display })
      }
    }
  }, [settings])

  // Sync weather to weatherStore
  useEffect(() => {
    if (!weather) return

    // Update fog density, cloud layers, and minimal METAR for visibility culling
    // The visibility check in isDatablockVisibleByWeather requires currentMetar.visib
    useWeatherStore.setState({
      fogDensity: weather.fogDensity,
      cloudLayers: weather.cloudLayers.map((layer) => ({
        altitude: layer.altitude,
        coverage: layer.coverage,
        type: layer.type,
      })),
      // Set minimal METAR with visibility for weather-based datablock culling
      // Only the visib field is needed for the visibility check
      currentMetar: {
        icaoId: '',
        visib: weather.visibility,
        clouds: [],
        fltCat: 'VFR',
        obsTime: Date.now(),
        rawOb: '',
        precipitation: [],
        hasThunderstorm: false,
        wind: { direction: 0, speed: 0, gustSpeed: null, isVariable: false },
      },
    })
  }, [weather])

  // Sync airport to airportStore
  useEffect(() => {
    if (!airport) return

    // Create airport object matching Airport interface
    // Non-essential fields (iata, city, state, country, tz) use defaults since
    // they're not needed for the inset's rendering - only position/elevation matter
    const airportData = {
      icao: airport.icao,
      iata: '',
      name: airport.name,
      city: '',
      state: '',
      country: '',
      lat: airport.latitude,
      lon: airport.longitude,
      elevation: airport.elevation,
      tz: '',
    }

    // Update airport store with received airport
    useAirportStore.setState({
      currentAirport: airportData,
      towerHeight: airport.towerHeight,
    })
  }, [airport])

  // Mark as initialized once we have essential data
  useEffect(() => {
    if (cesiumToken && !initializedRef.current) {
      initializedRef.current = true

      // Initialize the globalSettingsStore as if it loaded from disk
      // This prevents the "not initialized" checks from blocking
      useGlobalSettingsStore.setState({ initialized: true })
    }
  }, [cesiumToken])

  return {
    isReady: !!cesiumToken && initializedRef.current,
  }
}

export default useInsetStoreSync
