// Geoid conversion service
// Handles MSL <-> ellipsoidal height conversions using the EGM96 geoid model
// Works at any location on Earth without needing terrain sampling

import * as egm96 from 'egm96-universal'

/**
 * GeoidService provides conversion between MSL (Mean Sea Level) and WGS84 ellipsoidal heights
 * using the EGM96 (Earth Gravitational Model 1996) geoid model.
 *
 * Unlike terrain-based approaches, this uses the actual geoid model data from NGA,
 * providing accurate conversions at any location on Earth.
 *
 * The geoid height (N) is the difference between ellipsoidal and MSL heights:
 *   ellipsoidal = msl + N
 *   msl = ellipsoidal - N
 *
 * Typical geoid heights:
 *   - KBOS (Boston): N ≈ -29m (ellipsoidal is lower than MSL)
 *   - KDEN (Denver): N ≈ -16m
 *   - WSSS (Singapore): N ≈ +8m (ellipsoidal is higher than MSL)
 *   - Range worldwide: approximately -106m to +85m
 */
class GeoidService {
  /**
   * Get the geoid height (undulation) at a given location.
   * This is the height of the geoid above the WGS84 ellipsoid.
   *
   * @param lat Latitude in degrees
   * @param lon Longitude in degrees
   * @returns Geoid height in meters (positive = geoid above ellipsoid)
   */
  getGeoidHeight(lat: number, lon: number): number {
    return egm96.meanSeaLevel(lat, lon)
  }

  /**
   * Convert MSL height to ellipsoidal height at a given location.
   *
   * @param lat Latitude in degrees
   * @param lon Longitude in degrees
   * @param mslMeters Height in meters above Mean Sea Level
   * @returns Height in meters above WGS84 ellipsoid
   */
  mslToEllipsoidal(lat: number, lon: number, mslMeters: number): number {
    return egm96.egm96ToEllipsoid(lat, lon, mslMeters)
  }

  /**
   * Convert ellipsoidal height to MSL height at a given location.
   *
   * @param lat Latitude in degrees
   * @param lon Longitude in degrees
   * @param ellipsoidalMeters Height in meters above WGS84 ellipsoid
   * @returns Height in meters above Mean Sea Level
   */
  ellipsoidalToMsl(lat: number, lon: number, ellipsoidalMeters: number): number {
    return egm96.ellipsoidToEgm96(lat, lon, ellipsoidalMeters)
  }
}

// Export singleton instance
export const geoidService = new GeoidService()
export default geoidService
