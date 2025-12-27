import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { SUN_POSITION_UPDATE_INTERVAL } from '@/constants'
import type { TimeMode } from '@/types/settings'

export interface SunElevationOptions {
  /** Current time mode setting - changes trigger immediate recalculation */
  timeMode?: TimeMode
  /** Fixed time hour setting - changes trigger immediate recalculation */
  fixedTimeHour?: number
}

/**
 * Calculates the sun elevation angle at the camera position
 *
 * The sun elevation angle determines how high the sun is above the horizon:
 * - +90 degrees: Sun directly overhead (solar noon at tropics)
 * - 0 degrees: Sun at horizon (sunrise/sunset)
 * - -6 degrees: End of civil twilight
 * - -12 degrees: End of nautical twilight
 * - -18 degrees: End of astronomical twilight (full night)
 * - -90 degrees: Sun directly below (solar midnight at poles)
 *
 * This hook uses Cesium's built-in sun position calculation which accounts for:
 * - Current time from the Cesium clock
 * - Earth's orbital position
 * - Camera/viewer position on the globe
 *
 * ## Performance
 * Sun position is only recalculated every 30 seconds since the sun moves slowly.
 * However, when timeMode or fixedTimeHour changes, an immediate recalculation
 * is triggered to provide responsive feedback when adjusting time settings.
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param options - Optional time settings that trigger immediate recalculation when changed
 * @returns Sun elevation angle in degrees (-90 to +90), or null if unavailable
 *
 * @example
 * ```tsx
 * const sunElevation = useSunElevation(viewer, { timeMode, fixedTimeHour })
 * if (sunElevation !== null && sunElevation < 0) {
 *   // It's after sunset
 * }
 * ```
 */
export function useSunElevation(
  viewer: Cesium.Viewer | null,
  options?: SunElevationOptions
): number | null {
  const { timeMode, fixedTimeHour } = options ?? {}
  const [sunElevation, setSunElevation] = useState<number | null>(null)
  const lastUpdateRef = useRef<number>(0)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      setSunElevation(null)
      return
    }

    /**
     * Calculate sun elevation angle at the camera position
     */
    const calculateSunElevation = (): number | null => {
      if (!viewer || viewer.isDestroyed()) return null

      const scene = viewer.scene
      const camera = scene.camera

      // Get camera position in Cartesian3 (ECEF coordinates)
      const cameraPosition = camera.positionWC
      if (!cameraPosition || Cesium.Cartesian3.equals(cameraPosition, Cesium.Cartesian3.ZERO)) {
        return null
      }

      // Calculate the time to use for sun position
      // When time settings are provided, calculate time directly to avoid waiting for clock update
      let currentTime: Cesium.JulianDate
      if (timeMode === 'fixed' && fixedTimeHour !== undefined) {
        // Calculate fixed time based on camera longitude
        const cartographic = Cesium.Cartographic.fromCartesian(cameraPosition)
        const longitudeDegrees = Cesium.Math.toDegrees(cartographic.longitude)
        const longitudeOffsetHours = longitudeDegrees / 15

        const now = new Date()
        const targetTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0))
        const utcHour = fixedTimeHour - longitudeOffsetHours
        targetTime.setTime(targetTime.getTime() + utcHour * 60 * 60 * 1000)

        currentTime = Cesium.JulianDate.fromDate(targetTime)
      } else {
        // Real time mode - use current system time
        currentTime = Cesium.JulianDate.now()
      }

      // Calculate sun position in Earth-Centered Inertial (ECI) frame
      // This uses the Simon 1994 planetary positions model
      const sunPositionEci = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(currentTime)

      // Transform sun position from ECI to Earth-Centered Earth-Fixed (ECEF) frame
      // This accounts for Earth's rotation
      const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(currentTime)
      if (!icrfToFixed) {
        // Fallback to TEME to Fixed if ICRF data unavailable
        const temeToFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(currentTime)
        if (!temeToFixed) return null
        Cesium.Matrix3.multiplyByVector(temeToFixed, sunPositionEci, sunPositionEci)
      } else {
        Cesium.Matrix3.multiplyByVector(icrfToFixed, sunPositionEci, sunPositionEci)
      }

      // Normalize camera and sun positions to unit vectors
      const cameraNormalized = Cesium.Cartesian3.normalize(cameraPosition, new Cesium.Cartesian3())
      const sunNormalized = Cesium.Cartesian3.normalize(sunPositionEci, new Cesium.Cartesian3())

      // Calculate the angle between the "up" direction at camera and direction to sun
      // Dot product gives cosine of angle; we want angle from horizon, not from zenith
      // Up vector at camera position is just the normalized position (on sphere)
      const dotProduct = Cesium.Cartesian3.dot(cameraNormalized, sunNormalized)

      // Convert from angle-from-zenith to angle-from-horizon
      // asin of dot product gives elevation angle directly
      // (because dot product of up and sun direction = sin(elevation))
      const elevationRadians = Math.asin(dotProduct)
      const elevationDegrees = Cesium.Math.toDegrees(elevationRadians)

      return elevationDegrees
    }

    // Initial calculation
    const initialElevation = calculateSunElevation()
    setSunElevation(initialElevation)
    lastUpdateRef.current = Date.now()

    // Set up periodic recalculation
    // Using postRender to check if enough time has passed
    const removeListener = viewer.scene.postRender.addEventListener(() => {
      const now = Date.now()
      if (now - lastUpdateRef.current >= SUN_POSITION_UPDATE_INTERVAL) {
        const elevation = calculateSunElevation()
        setSunElevation(elevation)
        lastUpdateRef.current = now
      }
    })

    return () => {
      removeListener()
    }
  // Re-run effect when time settings change to trigger immediate recalculation
  }, [viewer, timeMode, fixedTimeHour])

  return sunElevation
}
