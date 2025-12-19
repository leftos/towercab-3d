// Coordinate conversion utilities for Cesium

import * as Cesium from 'cesium'

/**
 * Convert latitude/longitude/altitude to Cesium Cartesian3
 * @param latitude - Latitude in degrees
 * @param longitude - Longitude in degrees
 * @param altitude - Altitude in meters above sea level
 */
export function toCartesian3(
  latitude: number,
  longitude: number,
  altitude: number
): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude)
}

/**
 * Convert Cesium Cartesian3 to latitude/longitude/altitude
 */
export function fromCartesian3(
  cartesian: Cesium.Cartesian3
): { latitude: number; longitude: number; altitude: number } {
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
  return {
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    altitude: cartographic.height
  }
}

/**
 * Create a heading-pitch-roll quaternion for orienting an object
 * @param heading - Heading in degrees (0 = north, 90 = east)
 * @param pitch - Pitch in degrees (positive = nose up)
 * @param roll - Roll in degrees (positive = right wing down)
 * @param position - Cartesian3 position for orientation reference
 */
export function createOrientation(
  heading: number,
  pitch: number,
  roll: number,
  position: Cesium.Cartesian3
): Cesium.Quaternion {
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(heading),
    Cesium.Math.toRadians(pitch),
    Cesium.Math.toRadians(roll)
  )
  return Cesium.Transforms.headingPitchRollQuaternion(position, hpr)
}

/**
 * Create an aircraft orientation with the nose pointing in the heading direction
 * Aircraft are typically modeled pointing along +Y, so we need to adjust
 * @param heading - Heading in degrees
 * @param position - Cartesian3 position
 */
export function createAircraftOrientation(
  heading: number,
  position: Cesium.Cartesian3
): Cesium.Quaternion {
  // Cesium heading is from north, clockwise
  // Most aircraft models point along +Y (north) by default
  const hpr = new Cesium.HeadingPitchRoll(
    Cesium.Math.toRadians(heading),
    0,
    0
  )
  return Cesium.Transforms.headingPitchRollQuaternion(position, hpr)
}

/**
 * Calculate the point on the ground directly below a given position
 */
export function getGroundPosition(
  latitude: number,
  longitude: number,
  terrainProvider: Cesium.TerrainProvider
): Promise<Cesium.Cartographic | undefined> {
  const positions = [Cesium.Cartographic.fromDegrees(longitude, latitude)]
  return Cesium.sampleTerrainMostDetailed(terrainProvider, positions)
    .then((updatedPositions) => updatedPositions[0])
}

/**
 * Convert nautical miles to meters
 */
export function nmToMeters(nm: number): number {
  return nm * 1852
}

/**
 * Convert meters to nautical miles
 */
export function metersToNm(meters: number): number {
  return meters / 1852
}

/**
 * Convert knots to meters per second
 */
export function knotsToMps(knots: number): number {
  return knots * 0.514444
}

/**
 * Convert meters per second to knots
 */
export function mpsToKnots(mps: number): number {
  return mps / 0.514444
}
