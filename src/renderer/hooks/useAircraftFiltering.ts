import { useAircraftFilterStore } from '@/stores/aircraftFilterStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useGlobalSettingsStore } from '@/stores/globalSettingsStore'
import { useViewportStore } from '@/stores/viewportStore'
import { useAirportStore } from '@/stores/airportStore'
import { useWeatherStore } from '@/stores/weatherStore'
import { calculateDistanceNM } from '@/utils/interpolation'
import { getTowerPosition } from '@/utils/towerHeight'
import { GROUNDSPEED_THRESHOLD_KNOTS } from '@/constants/rendering'
import { isOrbitWithoutAirport } from '@/utils/viewingContext'
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
 * Filters interpolated aircraft data for UI display with multi-stage filtering pipeline.
 *
 * ## Responsibilities
 * - Calculates reference point for distance filtering (tower or followed aircraft in orbit mode)
 * - Filters aircraft by distance, traffic type, weather visibility, search query, and airport
 * - Sorts aircraft by 3D slant range distance
 * - Provides filtering statistics for UI feedback
 * - Returns reference point data for additional calculations (e.g., AGL altitude)
 *
 * ## Dependencies
 * - Requires: `useAircraftInterpolation` hook to provide `interpolatedAircraft` Map
 * - Reads: `settingsStore` (distance limits, traffic type toggles, weather settings)
 * - Reads: `aircraftFilterStore` (search query, airport filter, weather filter toggles)
 * - Reads: `viewportStore` (active viewport, following callsign, camera state)
 * - Reads: `airportStore` (current airport, tower height)
 * - Reads: `weatherStore` (METAR data, cloud layers)
 *
 * ## Call Order
 * This hook is designed for UI components that update at 1Hz, not frame-rate rendering:
 * ```typescript
 * function AircraftPanel() {
 *   // Get interpolated aircraft (updated 60Hz)
 *   const { interpolatedAircraft } = useAircraftInterpolation()
 *
 *   // Filter for UI display (evaluated ~1Hz due to refresh tick)
 *   const { filtered, stats } = useAircraftFiltering(interpolatedAircraft)
 *
 *   return (
 *     <div>
 *       {filtered.map(aircraft => (
 *         <AircraftListItem key={aircraft.callsign} aircraft={aircraft} />
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 *
 * **IMPORTANT:** This hook is **NOT** used by `CesiumViewer` for aircraft rendering because:
 * - The hook only re-executes when React re-renders (typically 1Hz due to refresh tick)
 * - `CesiumViewer` needs 60Hz position updates for smooth aircraft movement
 * - `CesiumViewer` reads directly from the `interpolatedAircraft` Map and applies filtering inline
 * - Both implementations use the same filter settings from stores for consistency
 *
 * ## Filtering Pipeline
 *
 * Aircraft are filtered through 5 sequential stages (order matters):
 *
 * ### 1. Distance Filter
 * - Calculate 3D slant range distance from reference point to each aircraft
 * - Reference point: Tower position (normal mode) or followed aircraft (orbit mode without airport)
 * - Filter by `settingsStore.aircraft.labelVisibilityDistance` (default: 10 NM)
 * - Option: Include followed aircraft regardless of distance (`includeFollowedRegardlessOfDistance`)
 *
 * ### 2. Traffic Type Filter
 * - Determine if aircraft is airborne (>200ft AGL) or on ground
 * - Filter by `settingsStore.aircraft.showGroundTraffic` and `showAirborneTraffic`
 * - **Note:** Uses 200ft AGL threshold to account for pressure altitude variations at high-elevation airports
 * - **Skipped** in orbit mode without airport (show all traffic types)
 *
 * ### 3. Weather Visibility Filter (if enabled)
 * - **Surface Visibility**: Hide aircraft beyond METAR visibility range (scaled by `visibilityScale`)
 * - **Cloud Ceiling**: Hide aircraft obscured by BKN/OVC cloud layers between camera and aircraft
 * - **Top-Down Mode**: Cloud culling is disabled (clouds don't visually obscure in this view)
 * - Requires: `aircraftFilterStore.filterWeatherVisibility = true` and `settingsStore.weather.showWeatherEffects = true`
 *
 * ### 4. Search Query Filter (if not empty)
 * - Match against: callsign, aircraft type, departure airport, arrival airport
 * - Case-insensitive substring search
 * - Requires: `aircraftFilterStore.searchQuery` to be non-empty
 *
 * ### 5. Airport Traffic Filter (if enabled)
 * - Show only aircraft with departure or arrival matching current airport ICAO
 * - Requires: `aircraftFilterStore.filterAirportTraffic = true` and current airport selected
 *
 * ### 6. Sort and Limit
 * - Sort by distance (closest first)
 * - Limit to `settingsStore.aircraft.maxAircraftDisplay` (default: 100)
 *
 * ## Distance Calculation
 *
 * Uses 3D slant range (Haversine formula with altitude delta):
 * ```typescript
 * distance = sqrt(
 *   haversineDistance(lat1, lon1, lat2, lon2)^2 +
 *   (alt1 - alt2)^2
 * )
 * ```
 *
 * This provides true Euclidean distance, accounting for altitude differences.
 * See `utils/interpolation.ts` → `calculateDistanceNM()` for implementation.
 *
 * ## Reference Point Selection
 *
 * The reference point for distance calculations depends on mode:
 *
 * - **Normal mode** (airport selected): Tower position + tower height
 * - **Orbit mode without airport**: Followed aircraft's current interpolated position
 * - **No reference available**: Return empty result
 *
 * ## Weather Visibility Culling
 *
 * ### Surface Visibility
 * ```typescript
 * visibilityMeters = metar.visibility * 1609.34 * visibilityScale
 * if (horizontalDistance > visibilityMeters) {
 *   // Hide aircraft (beyond visibility range)
 * }
 * ```
 *
 * ### Cloud Ceiling
 * ```typescript
 * // Check if any BKN/OVC layer is between camera and aircraft
 * if (layer.coverage >= 0.75 && layer.altitude between [cameraAlt, aircraftAlt]) {
 *   // Hide aircraft (obscured by clouds)
 * }
 * ```
 *
 * Cloud culling is skipped in top-down view because clouds don't visually block line-of-sight.
 *
 * ## Filtering Statistics
 *
 * The hook returns statistics showing how many aircraft passed each filter stage:
 * ```typescript
 * stats = {
 *   total: 450,           // Total aircraft in interpolatedAircraft Map
 *   afterDistance: 85,    // After distance filter
 *   afterTrafficType: 72, // After traffic type filter
 *   afterWeather: 65,     // After weather visibility filter
 *   afterSearch: 65,      // After search query filter
 *   afterAirport: 18      // After airport traffic filter (final count)
 * }
 * ```
 *
 * This helps users understand why aircraft are hidden and diagnose filter issues.
 *
 * ## Echo Loop Prevention
 *
 * This hook intentionally does **NOT** use `useMemo` to cache results because:
 * - The `interpolatedAircraft` Map is mutated every frame (60Hz)
 * - We want to read the latest interpolated positions each time the hook executes
 * - UI components control update rate via refresh tick (1Hz), not this hook
 *
 * ## Performance Considerations
 *
 * - **Array.from()**: Converts Map to array once per filter execution (~1Hz for UI)
 * - **Filter passes**: Each filter pass iterates the remaining aircraft (sequential reduction)
 * - **Distance calculation**: Haversine formula for all aircraft (typically <500 iterations)
 * - **Sorting**: O(n log n) sort on filtered list (typically <100 aircraft after filtering)
 * - **Total cost**: ~0.1-1ms per filter execution on typical hardware
 *
 * @param interpolatedAircraft - Map of callsign → InterpolatedAircraftState from `useAircraftInterpolation`
 * @param options - Optional filtering configuration
 * @param options.includeFollowedRegardlessOfDistance - If true, followed aircraft bypasses distance filter (default: false)
 * @param options.viewportId - Viewport ID for determining follow target (default: active viewport)
 * @returns Filtered aircraft list, reference point, orbit mode flag, and statistics
 *
 * @example
 * // Basic usage in aircraft list panel
 * const { interpolatedAircraft } = useAircraftInterpolation()
 * const { filtered, stats } = useAircraftFiltering(interpolatedAircraft)
 *
 * return (
 *   <div>
 *     <div>Showing {filtered.length} of {stats.total} aircraft</div>
 *     {filtered.map(aircraft => (
 *       <div key={aircraft.callsign}>
 *         {aircraft.callsign} - {aircraft.distance.toFixed(1)} NM
 *       </div>
 *     ))}
 *   </div>
 * )
 *
 * @example
 * // Usage with followed aircraft always visible
 * const { filtered } = useAircraftFiltering(interpolatedAircraft, {
 *   includeFollowedRegardlessOfDistance: true
 * })
 * // Followed aircraft will appear even if beyond labelVisibilityDistance
 *
 * @example
 * // Display filtering statistics
 * const { filtered, stats } = useAircraftFiltering(interpolatedAircraft)
 *
 * return (
 *   <div>
 *     <h3>Filter Pipeline</h3>
 *     <div>Total aircraft: {stats.total}</div>
 *     <div>Within distance: {stats.afterDistance}</div>
 *     <div>Correct traffic type: {stats.afterTrafficType}</div>
 *     <div>Weather visible: {stats.afterWeather}</div>
 *     <div>Search match: {stats.afterSearch}</div>
 *     <div>Airport traffic: {stats.afterAirport}</div>
 *   </div>
 * )
 *
 * @see useAircraftInterpolation - Provides the interpolated aircraft Map
 * @see utils/interpolation.ts - For distance calculation implementation
 * @see CesiumViewer.tsx - For 60Hz rendering that doesn't use this hook
 */
export function useAircraftFiltering(
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  options?: UseAircraftFilteringOptions
): FilteredAircraftResult {
  const includeFollowedRegardlessOfDistance = options?.includeFollowedRegardlessOfDistance ?? false

  // Get global display settings (synced across devices)
  const labelVisibilityDistance = useGlobalSettingsStore((state) => state.display.labelVisibilityDistance)
  const showGroundTraffic = useGlobalSettingsStore((state) => state.display.showGroundTraffic)
  const showAirborneTraffic = useGlobalSettingsStore((state) => state.display.showAirborneTraffic)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const showClouds = useSettingsStore((state) => state.weather.showClouds)
  const visibilityScale = useSettingsStore((state) => state.weather.visibilityScale)
  const maxAircraftDisplay = useSettingsStore((state) => state.aircraft.maxAircraftDisplay)

  const towerHeight = useAirportStore((state) => state.towerHeight)
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)

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
  const followMode = viewport?.cameraState.followMode ?? 'tower'

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
    if (isOrbitWithoutAirport(currentAirport, followMode, followingCallsign) && interpolatedAircraft.has(followingCallsign!)) {
      const followedAircraft = interpolatedAircraft.get(followingCallsign!)!
      refLat = followedAircraft.interpolatedLatitude
      refLon = followedAircraft.interpolatedLongitude
      refElevationMeters = followedAircraft.interpolatedAltitude  // Already in METERS
      refAltitudeFeet = followedAircraft.interpolatedAltitude
      isOrbitModeWithoutAirport = true
    } else if (currentAirport) {
      // Normal mode: use tower position
      const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
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
        // Use groundspeed to determine airborne status (consistent with positioning logic)
        const isAirborne = aircraft.interpolatedGroundspeed >= GROUNDSPEED_THRESHOLD_KNOTS
        if (isAirborne && !showAirborneTraffic) return false
        if (!isAirborne && !showGroundTraffic) return false
        return true
      })
    }
    stats.afterTrafficType = filtered.length

    // Filter 3: Weather visibility (if enabled)
    if (filterWeatherVisibility && showWeatherEffects) {
      filtered = filtered.filter((aircraft) => {
        const aircraftAltitudeMeters = aircraft.interpolatedAltitude  // Already in METERS
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

    // Sort by: active aircraft first (by distance), then parked aircraft (by distance)
    // This ensures active aircraft get priority when hitting maxAircraftDisplay limit
    const sorted = filtered
      .sort((a, b) => {
        // Active aircraft come before parked
        const aParked = a.isParked ?? false
        const bParked = b.isParked ?? false
        if (aParked !== bParked) {
          return aParked ? 1 : -1  // Non-parked first
        }
        // Within same category, sort by distance
        return a.distance - b.distance
      })
      .slice(0, maxAircraftDisplay)

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
