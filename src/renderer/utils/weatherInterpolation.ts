/**
 * Weather interpolation utilities
 *
 * Implements inverse distance weighting (IDW) for blending weather data
 * from multiple METAR stations based on distance from camera position.
 */

import type {
  DistancedMetar,
  InterpolatedWeather,
  InterpolationSource,
  CloudLayer,
  PrecipitationState,
  WindState
} from '@/types'
import {
  INTERPOLATION_DISTANCE_POWER,
  INTERPOLATION_MIN_WEIGHT,
  CLOUD_ALTITUDE_BAND_FEET
} from '@/constants'

const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

/**
 * Calculate inverse distance weighting weights
 *
 * Uses the formula: weight_i = (1/d_i^p) / sum(1/d_j^p)
 * where d is distance and p is the power parameter.
 *
 * @param distances Array of distances in nautical miles
 * @param power Exponent for distance (default: 2 = inverse square)
 * @returns Normalized weights that sum to 1
 */
export function calculateIDWWeights(
  distances: number[],
  power: number = INTERPOLATION_DISTANCE_POWER
): number[] {
  if (distances.length === 0) return []
  if (distances.length === 1) return [1]

  // Handle zero distance (camera exactly at station)
  const zeroIndex = distances.findIndex(d => d === 0)
  if (zeroIndex !== -1) {
    return distances.map((_, i) => i === zeroIndex ? 1 : 0)
  }

  // Calculate raw weights: 1/d^p
  const rawWeights = distances.map(d => 1 / Math.pow(d, power))
  const totalWeight = rawWeights.reduce((sum, w) => sum + w, 0)

  // Normalize to sum to 1
  return rawWeights.map(w => w / totalWeight)
}

/**
 * Interpolate weather from multiple METAR stations
 *
 * Uses inverse distance weighting for all numeric values:
 * - Visibility: weighted average
 * - Fog density: weighted average
 * - Cloud layers: grouped by altitude band, coverage averaged
 * - Wind: vector average for direction, scalar average for speed
 * - Precipitation: from nearest station with active precipitation
 *
 * @param metars Array of METAR data with distances
 * @param options Optional configuration
 * @returns Interpolated weather values
 */
export function interpolateWeather(
  metars: DistancedMetar[],
  options?: {
    power?: number
    minWeight?: number
  }
): InterpolatedWeather | null {
  if (metars.length === 0) return null

  const power = options?.power ?? INTERPOLATION_DISTANCE_POWER
  const minWeight = options?.minWeight ?? INTERPOLATION_MIN_WEIGHT

  // Calculate weights
  const distances = metars.map(m => m.distanceNM)
  const weights = calculateIDWWeights(distances, power)

  // Filter out stations with negligible weight
  const significantStations = metars.filter((_, i) => weights[i] >= minWeight)
  const significantWeights = weights.filter(w => w >= minWeight)

  // Re-normalize filtered weights
  const weightSum = significantWeights.reduce((sum, w) => sum + w, 0)
  const normalizedWeights = significantWeights.map(w => w / weightSum)

  // Build source station info
  const sourceStations: InterpolationSource[] = significantStations.map((m, i) => ({
    icao: m.icao,
    distanceNM: m.distanceNM,
    weight: normalizedWeights[i]
  }))

  // Interpolate visibility (weighted average)
  const visibility = significantStations.reduce(
    (sum, m, i) => sum + m.visibility * normalizedWeights[i],
    0
  )

  // Interpolate fog density (weighted average)
  const fogDensity = significantStations.reduce(
    (sum, m, i) => sum + m.fogDensity * normalizedWeights[i],
    0
  )

  // Interpolate cloud layers
  const cloudLayers = interpolateCloudLayers(significantStations, normalizedWeights)

  // Select precipitation (from nearest station with active precip)
  const precipitation = selectPrecipitation(significantStations)

  // Interpolate wind (vector average for direction)
  const wind = interpolateWind(significantStations, normalizedWeights)

  return {
    visibility,
    fogDensity,
    cloudLayers,
    precipitation,
    wind,
    sourceStations,
    calculatedAt: Date.now()
  }
}

/**
 * Interpolate cloud layers from multiple stations
 *
 * Groups cloud layers by altitude bands, then averages coverage within each band.
 * This handles the case where different stations report clouds at slightly different altitudes.
 */
function interpolateCloudLayers(
  metars: DistancedMetar[],
  weights: number[]
): CloudLayer[] {
  // Collect all cloud layers with their weights
  const allLayers: Array<{ layer: CloudLayer; weight: number }> = []

  metars.forEach((m, i) => {
    m.cloudLayers.forEach(layer => {
      allLayers.push({ layer, weight: weights[i] })
    })
  })

  if (allLayers.length === 0) return []

  // Group layers by altitude band
  const bandSizeMeters = CLOUD_ALTITUDE_BAND_FEET * 0.3048
  const bands = new Map<number, Array<{ layer: CloudLayer; weight: number }>>()

  allLayers.forEach(({ layer, weight }) => {
    const bandKey = Math.round(layer.altitude / bandSizeMeters) * bandSizeMeters
    if (!bands.has(bandKey)) {
      bands.set(bandKey, [])
    }
    bands.get(bandKey)!.push({ layer, weight })
  })

  // For each band, calculate weighted average altitude and coverage
  const interpolatedLayers: CloudLayer[] = []

  bands.forEach((layersInBand, _bandAltitude) => {
    // Sum weights for this band to normalize
    const bandWeightSum = layersInBand.reduce((sum, l) => sum + l.weight, 0)

    // Weighted average altitude
    const avgAltitude = layersInBand.reduce(
      (sum, l) => sum + l.layer.altitude * l.weight,
      0
    ) / bandWeightSum

    // Weighted average coverage
    const avgCoverage = layersInBand.reduce(
      (sum, l) => sum + l.layer.coverage * l.weight,
      0
    ) / bandWeightSum

    // Determine type based on coverage (rounded to standard METAR codes)
    let type: string
    if (avgCoverage >= 0.875) type = 'OVC'
    else if (avgCoverage >= 0.625) type = 'BKN'
    else if (avgCoverage >= 0.375) type = 'SCT'
    else type = 'FEW'

    interpolatedLayers.push({
      altitude: avgAltitude,
      coverage: Math.min(1, Math.max(0, avgCoverage)),
      type
    })
  })

  // Sort by altitude
  interpolatedLayers.sort((a, b) => a.altitude - b.altitude)

  return interpolatedLayers
}

/**
 * Select precipitation from nearest station with active precipitation
 *
 * Precipitation types don't interpolate well (you can't have "half rain"),
 * so we use the precipitation from the nearest station that has any.
 */
function selectPrecipitation(metars: DistancedMetar[]): PrecipitationState {
  // Find nearest station with active precipitation
  const withPrecip = metars.filter(m => m.precipitation.active)

  if (withPrecip.length > 0) {
    // Already sorted by distance
    return withPrecip[0].precipitation
  }

  // Check for thunderstorm even without precipitation
  const withThunderstorm = metars.find(m => m.precipitation.hasThunderstorm)
  if (withThunderstorm) {
    return withThunderstorm.precipitation
  }

  // No precipitation at any station
  return {
    active: false,
    types: [],
    visibilityFactor: 1,
    hasThunderstorm: false
  }
}

/**
 * Interpolate wind direction and speed
 *
 * Uses vector averaging for direction to properly handle wrap-around
 * (e.g., 350° and 10° should average to 0°, not 180°).
 *
 * Speed and gust are simple weighted averages.
 */
function interpolateWind(
  metars: DistancedMetar[],
  weights: number[]
): WindState {
  if (metars.length === 0) {
    return { direction: 0, speed: 0, gustSpeed: null, isVariable: false }
  }

  // Check if any/all stations report variable wind
  const anyVariable = metars.some(m => m.wind.isVariable)
  const allVariable = metars.every(m => m.wind.isVariable)

  // Vector average for direction
  // Convert to unit vectors, weight, sum, convert back
  let xSum = 0
  let ySum = 0

  metars.forEach((m, i) => {
    // Skip variable winds in direction calculation
    if (!m.wind.isVariable) {
      const rad = m.wind.direction * DEG_TO_RAD
      xSum += weights[i] * Math.sin(rad)
      ySum += weights[i] * Math.cos(rad)
    }
  })

  // If all stations have variable winds, use nearest station's direction as fallback
  // (or 0 if truly undefined) and mark as variable
  let direction: number
  if (allVariable) {
    // Use the nearest station's reported direction (even if variable)
    direction = metars[0].wind.direction
  } else {
    direction = Math.atan2(xSum, ySum) * RAD_TO_DEG
    if (direction < 0) direction += 360
  }

  // Weighted average for speed
  const speed = metars.reduce(
    (sum, m, i) => sum + m.wind.speed * weights[i],
    0
  )

  // Weighted average for gust (only from stations with gusts)
  // Preserve original indices while filtering for cleaner weight lookup
  const gustData = metars
    .map((m, i) => ({ station: m, weight: weights[i] }))
    .filter(d => d.station.wind.gustSpeed !== null)

  let gustSpeed: number | null = null
  if (gustData.length > 0) {
    const gustWeightSum = gustData.reduce((sum, d) => sum + d.weight, 0)
    gustSpeed = gustData.reduce(
      (sum, d) => sum + (d.station.wind.gustSpeed ?? 0) * d.weight,
      0
    ) / gustWeightSum
  }

  return {
    direction: Math.round(direction),
    speed: Math.round(speed),
    gustSpeed: gustSpeed !== null ? Math.round(gustSpeed) : null,
    isVariable: anyVariable
  }
}
