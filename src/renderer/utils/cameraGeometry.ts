// Camera geometry utilities for orbit and tower mode calculations

import { calculateBearing } from './interpolation'

// Constants for coordinate conversion
const METERS_PER_DEGREE_LAT = 111111

/**
 * Convert meters to degrees latitude (constant everywhere)
 */
export function metersToDegreesLat(meters: number): number {
  return meters / METERS_PER_DEGREE_LAT
}

/**
 * Convert meters to degrees longitude (varies with latitude)
 * @param meters - Distance in meters
 * @param latitude - Latitude in degrees (for cosine correction)
 */
export function metersToDegreesLon(meters: number, latitude: number): number {
  return meters / (METERS_PER_DEGREE_LAT * Math.cos(latitude * Math.PI / 180))
}

/**
 * Calculate horizontal distance in meters between two lat/lon points
 * Uses simple Euclidean approximation (accurate for short distances)
 */
export function calculateHorizontalDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const latDiff = (lat2 - lat1) * METERS_PER_DEGREE_LAT
  const lonDiff = (lon2 - lon1) * METERS_PER_DEGREE_LAT * Math.cos(lat1 * Math.PI / 180)
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff)
}

/**
 * Calculate pitch angle from observer to target based on altitude difference and distance
 */
export function calculatePitchToTarget(
  observerLat: number,
  observerLon: number,
  observerAlt: number,
  targetLat: number,
  targetLon: number,
  targetAlt: number
): number {
  const horizontalDistance = calculateHorizontalDistance(observerLat, observerLon, targetLat, targetLon)
  const altitudeDiff = targetAlt - observerAlt
  return Math.atan2(altitudeDiff, horizontalDistance) * 180 / Math.PI
}

export interface PositionOffset {
  x: number  // East-West offset in meters (positive = east)
  y: number  // North-South offset in meters (positive = north)
  z: number  // Vertical offset in meters (positive = up)
}

export interface GeoPosition {
  latitude: number   // Degrees
  longitude: number  // Degrees
  height: number     // Meters
}

/**
 * Apply position offsets to a base geographic position
 */
export function applyPositionOffsets(
  base: GeoPosition,
  offset: PositionOffset
): GeoPosition {
  return {
    latitude: base.latitude + metersToDegreesLat(offset.y),
    longitude: base.longitude + metersToDegreesLon(offset.x, base.latitude),
    height: base.height + offset.z
  }
}

export interface OrbitCameraResult {
  cameraLat: number
  cameraLon: number
  cameraHeight: number
  heading: number  // Heading to look at aircraft
  pitch: number    // Pitch to look at aircraft
}

/**
 * Calculate camera position and orientation for orbit mode
 * Camera orbits around the aircraft at a given distance, heading, and pitch
 *
 * @param aircraftLat - Aircraft latitude in degrees
 * @param aircraftLon - Aircraft longitude in degrees
 * @param aircraftAltMeters - Aircraft altitude in meters
 * @param aircraftHeading - Aircraft heading in degrees
 * @param orbitHeading - Relative orbit heading (0 = behind aircraft, 90 = left side)
 * @param orbitPitch - Orbit pitch angle in degrees (positive = above aircraft)
 * @param orbitDistance - Distance from aircraft in meters
 * @param minCameraHeight - Minimum camera height above ground (default 10m)
 */
export function calculateOrbitCameraPosition(
  aircraftLat: number,
  aircraftLon: number,
  aircraftAltMeters: number,
  aircraftHeading: number,
  orbitHeading: number,
  orbitPitch: number,
  orbitDistance: number,
  minCameraHeight: number = 10
): OrbitCameraResult {
  // Calculate absolute orbit angle (behind aircraft + relative offset)
  const absoluteOrbitAngle = aircraftHeading + 180 + orbitHeading
  const orbitAngleRad = absoluteOrbitAngle * Math.PI / 180
  const orbitPitchRad = orbitPitch * Math.PI / 180

  // Calculate camera position using spherical coordinates relative to aircraft
  const horizontalDistance = orbitDistance * Math.cos(orbitPitchRad)
  const verticalOffset = orbitDistance * Math.sin(orbitPitchRad)

  // Camera position: aircraft position + spherical offset
  const cameraLat = aircraftLat + horizontalDistance * Math.cos(orbitAngleRad) * metersToDegreesLat(1)
  const cameraLon = aircraftLon + horizontalDistance * Math.sin(orbitAngleRad) * metersToDegreesLon(1, aircraftLat)
  let cameraHeight = aircraftAltMeters + verticalOffset

  // Ensure camera doesn't go below minimum height
  cameraHeight = Math.max(minCameraHeight, cameraHeight)

  // Calculate heading to look at aircraft from camera position
  const heading = calculateBearing(cameraLat, cameraLon, aircraftLat, aircraftLon)

  // Calculate pitch to look at aircraft
  const pitch = calculatePitchToTarget(
    cameraLat,
    cameraLon,
    cameraHeight,
    aircraftLat,
    aircraftLon,
    aircraftAltMeters
  )

  return {
    cameraLat,
    cameraLon,
    cameraHeight,
    heading,
    pitch
  }
}

export interface TowerLookAtResult {
  heading: number  // Bearing to aircraft in degrees
  pitch: number    // Pitch angle to aircraft in degrees
}

/**
 * Calculate heading and pitch from tower position to aircraft
 * Used in tower follow mode where camera stays at tower position
 *
 * @param towerLat - Tower latitude in degrees
 * @param towerLon - Tower longitude in degrees
 * @param towerAltMeters - Tower altitude in meters
 * @param aircraftLat - Aircraft latitude in degrees
 * @param aircraftLon - Aircraft longitude in degrees
 * @param aircraftAltMeters - Aircraft altitude in meters
 */
export function calculateTowerLookAt(
  towerLat: number,
  towerLon: number,
  towerAltMeters: number,
  aircraftLat: number,
  aircraftLon: number,
  aircraftAltMeters: number
): TowerLookAtResult {
  const heading = calculateBearing(towerLat, towerLon, aircraftLat, aircraftLon)
  const pitch = calculatePitchToTarget(
    towerLat,
    towerLon,
    towerAltMeters,
    aircraftLat,
    aircraftLon,
    aircraftAltMeters
  )

  return { heading, pitch }
}

/**
 * Calculate FOV for follow mode based on base FOV and zoom level
 * Higher zoom = narrower FOV (more zoomed in)
 *
 * @param baseFov - Base FOV in degrees (typically 60)
 * @param followZoom - Zoom multiplier (1 = normal, 2 = 2x zoom)
 * @param minFov - Minimum FOV (default 10)
 * @param maxFov - Maximum FOV (default 120)
 */
export function calculateFollowFov(
  baseFov: number,
  followZoom: number,
  minFov: number = 10,
  maxFov: number = 120
): number {
  return Math.max(minFov, Math.min(maxFov, baseFov / followZoom))
}

/**
 * Quadratic ease-in-out function for smooth animations
 * @param t - Progress from 0 to 1
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
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
