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
 * Get tower position (lat, lon, height in meters MSL)
 */
export function getTowerPosition(
  airport: Airport,
  customHeight?: number
): { latitude: number; longitude: number; height: number } {
  const towerHeight = customHeight ?? getTowerHeight(airport)

  // Convert airport elevation from feet to meters and add tower height
  const elevationMeters = airport.elevation * 0.3048
  const totalHeight = elevationMeters + towerHeight

  return {
    latitude: airport.lat,
    longitude: airport.lon,
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
