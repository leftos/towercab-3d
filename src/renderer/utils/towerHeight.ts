// Tower height estimation utilities

import type { Airport } from '../types/airport'
import { KNOWN_TOWER_HEIGHTS, classifyAirport } from '../types/airport'

// Height estimates by airport type (in meters)
const HEIGHT_BY_TYPE = {
  major_international: 75,
  large_domestic: 50,
  regional: 30,
  small: 15,
  unknown: 35
}

/**
 * Get tower height for an airport
 * Returns height in meters above airport elevation
 */
export function getTowerHeight(airport: Airport): number {
  // Check known heights first
  const knownHeight = KNOWN_TOWER_HEIGHTS[airport.icao.toUpperCase()]
  if (knownHeight !== undefined) {
    return knownHeight
  }

  // Classify and estimate
  const airportType = classifyAirport(airport)
  return HEIGHT_BY_TYPE[airportType]
}

/**
 * Get tower position (lat, lon, height in meters MSL) for 3D view
 * @param airport - Airport data
 * @param customHeight - Optional height in meters above ground level (AGL). If provided, used instead of estimated height.
 * @param view3dPosition - Optional custom 3D view position from tower-positions file
 * @returns Tower position in {latitude, longitude, height} where height is MSL (meters)
 */
export function getTowerPosition(
  airport: Airport,
  customHeight?: number,
  view3dPosition?: {
    lat: number
    lon: number
    aglHeight: number
    latOffsetMeters?: number
    lonOffsetMeters?: number
  }
): { latitude: number; longitude: number; height: number } {
  // Use custom position if provided, otherwise use airport center
  let latitude = view3dPosition?.lat ?? airport.lat
  let longitude = view3dPosition?.lon ?? airport.lon

  // Apply meter-based position offset if provided
  const latOffsetMeters = view3dPosition?.latOffsetMeters ?? 0
  const lonOffsetMeters = view3dPosition?.lonOffsetMeters ?? 0

  if (latOffsetMeters !== 0 || lonOffsetMeters !== 0) {
    // Convert meter offset to degrees (1 degree of latitude ≈ 111,320 meters)
    const metersPerDegreeLat = 111320
    latitude += latOffsetMeters / metersPerDegreeLat

    // For longitude, account for latitude (cos factor)
    const metersPerDegreeLon = metersPerDegreeLat * Math.cos(latitude * (Math.PI / 180))
    longitude += lonOffsetMeters / metersPerDegreeLon
  }

  // Determine AGL height: custom position's aglHeight, custom height param, or estimated
  let aglHeight: number
  if (view3dPosition?.aglHeight !== undefined) {
    aglHeight = view3dPosition.aglHeight
  } else if (customHeight !== undefined) {
    aglHeight = customHeight
  } else {
    aglHeight = getTowerHeight(airport)
  }

  // Convert airport elevation from feet to meters and add AGL height
  const elevationMeters = airport.elevation * 0.3048
  const totalHeight = elevationMeters + aglHeight

  return {
    latitude,
    longitude,
    height: totalHeight
  }
}

/**
 * Convert feet to meters
 */
export function feetToMeters(feet: number): number {
  return feet * 0.3048
}

/**
 * Convert meters to feet
 */
export function metersToFeet(meters: number): number {
  return meters / 0.3048
}

/**
 * Format altitude for display
 * @param altitudeMeters - Altitude in METERS (internal storage)
 * @returns Formatted string in feet/flight level
 */
export function formatAltitude(altitudeMeters: number): string {
  const altitudeFeet = metersToFeet(altitudeMeters)
  if (altitudeFeet >= 18000) {
    // Flight level
    return `FL${Math.round(altitudeFeet / 100)}`
  }
  return `${Math.round(altitudeFeet).toLocaleString()} ft`
}

/**
 * Format groundspeed for display
 */
export function formatGroundspeed(groundspeedKnots: number): string {
  return `${Math.round(groundspeedKnots)} kts`
}

/**
 * Format heading for display
 */
export function formatHeading(heading: number): string {
  const normalized = Math.round(((heading % 360) + 360) % 360)
  return normalized.toString().padStart(3, '0') + '°'
}
