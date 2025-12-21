import { useAircraftFilterStore } from '@/stores/aircraftFilterStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useViewportStore } from '@/stores/viewportStore'
import { useAirportStore } from '@/stores/airportStore'
import { useWeatherStore } from '@/stores/weatherStore'
import { useAircraftInterpolation } from './useAircraftInterpolation'
import { calculateDistanceNM } from '@/utils/interpolation'
import { getTowerPosition } from '@/utils/towerHeight'
import type { InterpolatedAircraftState } from '@/types/vatsim'

interface FilteredAircraftWithDistance extends InterpolatedAircraftState {
  distance: number
}

interface FilteredAircraftResult {
  filtered: FilteredAircraftWithDistance[]
  referencePoint: {
    lat: number
    lon: number
    altitudeFeet: number
    elevationMeters: number
  } | null
  isOrbitModeWithoutAirport: boolean
  stats: {
    total: number
    afterDistance: number
    afterTrafficType: number
    afterWeather: number
    afterSearch: number
    afterAirport: number
  }
}

interface UseAircraftFilteringOptions {
  /**
   * If true, the followed aircraft will be included regardless of distance filter
   * Used by CesiumViewer to always show the followed aircraft datablock
   */
  includeFollowedRegardlessOfDistance?: boolean

  /**
   * Viewport ID to use for determining the active viewport's follow target
   * Defaults to the active viewport if not specified
   */
  viewportId?: string
}

/**
 * Shared aircraft filtering hook used by AircraftPanel for UI list updates.
 *
 * NOTE: This hook is NOT used by CesiumViewer for rendering because it only
 * re-executes when React re-renders (typically 1Hz due to refresh tick).
 * CesiumViewer reads directly from the interpolatedAircraft Map to achieve
 * 60Hz position updates while applying the same filter settings from stores.
 *
 * This hook is perfect for UI components that don't need frame-rate updates.
 *
 * Filtering order:
 * 1. Calculate reference position (tower or followed aircraft)
 * 2. Calculate distance for each aircraft (3D slant range)
 * 3. Filter by distance (labelVisibilityDistance)
 * 4. Filter by traffic type (showGroundTraffic, showAirborneTraffic)
 * 5. Filter by weather visibility (if filterWeatherVisibility enabled)
 * 6. Filter by search query (if searchQuery not empty)
 * 7. Filter by airport traffic (if filterAirportTraffic enabled)
 * 8. Sort by distance
 */
export function useAircraftFiltering(options?: UseAircraftFilteringOptions): FilteredAircraftResult {
  const includeFollowedRegardlessOfDistance = options?.includeFollowedRegardlessOfDistance ?? false

  // Get interpolated aircraft data
  const interpolatedAircraft = useAircraftInterpolation()

  // Get global settings
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)
  const showGroundTraffic = useSettingsStore((state) => state.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.showAirborneTraffic)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.showCesiumFog)
  const showClouds = useSettingsStore((state) => state.showClouds)
  const visibilityScale = useSettingsStore((state) => state.visibilityScale)
  const maxAircraftDisplay = useSettingsStore((state) => state.maxAircraftDisplay)

  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Get panel filter states
  const searchQuery = useAircraftFilterStore((state) => state.searchQuery)
  const filterAirportTraffic = useAircraftFilterStore((state) => state.filterAirportTraffic)
  const filterWeatherVisibility = useAircraftFilterStore((state) => state.filterWeatherVisibility)

  // Get viewport and airport data
  const viewports = useViewportStore((state) => state.viewports)
  const activeViewportId = useViewportStore((state) => state.activeViewportId)
  const viewportId = options?.viewportId ?? activeViewportId
  const viewport = viewports.find((v) => v.id === viewportId)
  const followingCallsign = viewport?.cameraState.followingCallsign ?? null

  const currentAirport = useAirportStore((state) => state.currentAirport)

  // Get weather data
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)

  // Get top-down mode status for cloud culling logic
  const isTopDown = viewport?.cameraState.viewMode === 'topdown'

  // Calculate filtered aircraft on every call to use fresh interpolated positions (60Hz)
  // This is intentional - no useMemo - to ensure smooth aircraft movement
  // The interpolatedAircraft Map is mutated every frame, so we read from it directly
  // Determine reference point for distance calculations
    let refLat: number | undefined
    let refLon: number | undefined
    let refElevationMeters = 0
    let refAltitudeFeet: number | undefined
    let isOrbitModeWithoutAirport = false

    // Check if in orbit mode without airport (use followed aircraft as reference)
    if (followingCallsign && !currentAirport && interpolatedAircraft.has(followingCallsign)) {
      const followedAircraft = interpolatedAircraft.get(followingCallsign)!
      refLat = followedAircraft.interpolatedLatitude
      refLon = followedAircraft.interpolatedLongitude
      refElevationMeters = followedAircraft.interpolatedAltitude * 0.3048
      refAltitudeFeet = followedAircraft.interpolatedAltitude
      isOrbitModeWithoutAirport = true
    } else if (currentAirport) {
      // Normal mode: use tower position
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      refLat = towerPos.latitude
      refLon = towerPos.longitude
      refElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
      // Tower altitude = ground elevation + tower height (convert tower height from meters to feet)
      refAltitudeFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)
    }

    // If no reference point available, return empty result
    if (refLat === undefined || refLon === undefined || refAltitudeFeet === undefined) {
      return {
        filtered: [],
        referencePoint: null,
        isOrbitModeWithoutAirport: false,
        stats: {
          total: 0,
          afterDistance: 0,
          afterTrafficType: 0,
          afterWeather: 0,
          afterSearch: 0,
          afterAirport: 0
        }
      }
    }

    const cameraAltitudeMeters = refElevationMeters + towerHeight
    const airportElevationFeet = currentAirport?.elevation || 0
    const airportIcao = currentAirport?.icao?.toUpperCase()
    const query = searchQuery.toLowerCase().trim()

    // Stats tracking
    const stats = {
      total: interpolatedAircraft.size,
      afterDistance: 0,
      afterTrafficType: 0,
      afterWeather: 0,
      afterSearch: 0,
      afterAirport: 0
    }

    // Calculate distance for all aircraft
    const withDistance: FilteredAircraftWithDistance[] = Array.from(interpolatedAircraft.values()).map(
      (aircraft) => ({
        ...aircraft,
        distance: calculateDistanceNM(
          refLat!,
          refLon!,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          refAltitudeFeet!,
          aircraft.interpolatedAltitude
        )
      })
    )

    // Filter 1: Distance
    let filtered = withDistance.filter((aircraft) => {
      // Always include followed aircraft if option enabled
      if (includeFollowedRegardlessOfDistance && aircraft.callsign === followingCallsign) {
        return true
      }
      return aircraft.distance <= labelVisibilityDistance
    })
    stats.afterDistance = filtered.length

    // Filter 2: Ground/Airborne traffic type
    // In orbit mode without airport, show all traffic types
    if (!isOrbitModeWithoutAirport) {
      filtered = filtered.filter((aircraft) => {
        // Calculate AGL in feet - use 200ft threshold to account for pressure altitude variations
        // At high-elevation airports (e.g., KRNO at 4,517ft), absolute altitude would misclassify ground traffic
        const aglFeet = aircraft.interpolatedAltitude - airportElevationFeet
        const isAirborne = aglFeet > 200
        if (isAirborne && !showAirborneTraffic) return false
        if (!isAirborne && !showGroundTraffic) return false
        return true
      })
    }
    stats.afterTrafficType = filtered.length

    // Filter 3: Weather visibility (if enabled)
    if (filterWeatherVisibility && showWeatherEffects) {
      filtered = filtered.filter((aircraft) => {
        const aircraftAltitudeMeters = aircraft.interpolatedAltitude * 0.3048
        const horizontalDistanceMeters = aircraft.distance * 1852 // NM to meters

        // Check visibility range (surface visibility culling)
        if (currentMetar && showCesiumFog) {
          // Apply visibilityScale: 1.0 = match METAR, 2.0 = see twice as far
          const visibilityMeters = currentMetar.visib * 1609.34 * visibilityScale // SM to meters, scaled
          if (horizontalDistanceMeters > visibilityMeters) {
            return false
          }
        }

        // Check cloud ceiling culling
        // Only cull if clouds are enabled and we have cloud data
        // Skip cloud culling in top-down view - clouds don't visually obscure in this mode
        if (showClouds && cloudLayers.length > 0 && !isTopDown) {
          const lowerAlt = Math.min(cameraAltitudeMeters, aircraftAltitudeMeters)
          const higherAlt = Math.max(cameraAltitudeMeters, aircraftAltitudeMeters)

          // Check if any BKN (0.75) or OVC (1.0) layer is between camera and aircraft
          for (const layer of cloudLayers) {
            // BKN = 0.75, OVC = 1.0 - these are "ceilings" that block visibility
            if (layer.coverage >= 0.75) {
              // Check if this ceiling is between camera and aircraft
              if (layer.altitude > lowerAlt && layer.altitude < higherAlt) {
                return false
              }
            }
          }
        }

        return true
      })
    }
    stats.afterWeather = filtered.length

    // Filter 4: Search query (if not empty)
    if (query) {
      filtered = filtered.filter(
        (aircraft) =>
          aircraft.callsign.toLowerCase().includes(query) ||
          aircraft.aircraftType?.toLowerCase().includes(query) ||
          aircraft.departure?.toLowerCase().includes(query) ||
          aircraft.arrival?.toLowerCase().includes(query)
      )
    }
    stats.afterSearch = filtered.length

    // Filter 5: Airport traffic (if enabled)
    if (filterAirportTraffic && airportIcao) {
      filtered = filtered.filter(
        (aircraft) =>
          aircraft.departure?.toUpperCase() === airportIcao ||
          aircraft.arrival?.toUpperCase() === airportIcao
      )
    }
    stats.afterAirport = filtered.length

    // Sort by distance and limit count
    const sorted = filtered.sort((a, b) => a.distance - b.distance).slice(0, maxAircraftDisplay)

    return {
      filtered: sorted,
      referencePoint: {
        lat: refLat,
        lon: refLon,
        altitudeFeet: refAltitudeFeet,
        elevationMeters: refElevationMeters
      },
      isOrbitModeWithoutAirport,
      stats
    }
}
