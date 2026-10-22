import * as Cesium from 'cesium'
import { useEffect, useRef, useState } from 'react'
import { PARTICLE_PREWARM_JUMP_THRESHOLD, SUN_POSITION_UPDATE_INTERVAL } from '@/constants'

/**
 * Clock jumps larger than this (seconds) recompute the sun at once.
 *
 * A time-mode or fixed-hour change moves Cesium's clock by hours in one assignment; the sun moves too little
 * in ordinary animated time to reach this between frames.
 */
const SUN_CLOCK_JUMP_THRESHOLD_SECONDS = 60

/**
 * Calculates the sun elevation angle (degrees) above the horizon for a position and time
 *
 * The elevation determines how high the sun is above the horizon:
 * - +90 degrees: Sun directly overhead (solar noon at tropics)
 * - 0 degrees: Sun at horizon (sunrise/sunset)
 * - -6 degrees: End of civil twilight
 * - -12 degrees: End of nautical twilight
 * - -18 degrees: End of astronomical twilight (full night)
 * - -90 degrees: Sun directly below (solar midnight at poles)
 *
 * Elevation is measured against the geodetic surface normal, the same up vector Cesium's shadow map uses
 * to decide the sun is below the horizon.
 *
 * @param position - Camera position in Earth-Centered Earth-Fixed coordinates
 * @param time - Time to compute the sun position at
 * @returns Sun elevation angle in degrees (-90 to +90), or null if unavailable
 */
export function computeSunElevationDeg(position: Cesium.Cartesian3, time: Cesium.JulianDate): number | null {
  if (Cesium.Cartesian3.equals(position, Cesium.Cartesian3.ZERO)) return null

  // Sun position in Earth-Centered Inertial (ECI) frame, from the Simon 1994 planetary positions model
  const sunPositionEci = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    new Cesium.Cartesian3(),
  )

  // Transform sun position from ECI to Earth-Centered Earth-Fixed (ECEF) frame
  // This accounts for Earth's rotation
  const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time)
  if (icrfToFixed) {
    Cesium.Matrix3.multiplyByVector(icrfToFixed, sunPositionEci, sunPositionEci)
  } else {
    // Fallback to TEME to Fixed if ICRF data unavailable
    const temeToFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time)
    if (!temeToFixed) return null
    Cesium.Matrix3.multiplyByVector(temeToFixed, sunPositionEci, sunPositionEci)
  }

  // Dot product of up and the sun direction is sin(elevation), i.e. the angle from the horizon
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(position, new Cesium.Cartesian3())
  const sunDirection = Cesium.Cartesian3.normalize(sunPositionEci, new Cesium.Cartesian3())
  const sinElevation = Cesium.Math.clamp(Cesium.Cartesian3.dot(up, sunDirection), -1, 1)
  return Cesium.Math.toDegrees(Math.asin(sinElevation))
}

/**
 * Tracks the sun elevation angle at the camera position
 *
 * The sun is computed from Cesium's clock, so the sun this hook reports is the sun Cesium draws, whichever
 * time set the clock (fixed time at the tower, real time, or an inset's clock).
 *
 * ## Performance
 * Sun position is only recalculated every 30 seconds since the sun moves slowly.
 * However, immediate recalculation is triggered when:
 * - Cesium's clock jumps (time mode or fixed time hour changed)
 * - Camera position jumps significantly (>500m, e.g., airport switch)
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @returns Sun elevation angle in degrees (-90 to +90), or null if unavailable
 *
 * @example
 * ```tsx
 * const sunElevation = useSunElevation(viewer)
 * if (sunElevation !== null && sunElevation < 0) {
 *   // It's after sunset
 * }
 * ```
 */
export function useSunElevation(viewer: Cesium.Viewer | null): number | null {
  const [sunElevation, setSunElevation] = useState<number | null>(null)
  const lastUpdateRef = useRef<number>(0)
  const lastCameraPositionRef = useRef<Cesium.Cartesian3 | null>(null)
  const lastClockTimeRef = useRef<Cesium.JulianDate | null>(null)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      setSunElevation(null)
      return
    }

    const calculateSunElevation = (time: Cesium.JulianDate): number | null => {
      if (viewer.isDestroyed()) return null
      return computeSunElevationDeg(viewer.scene.camera.positionWC, time)
    }

    // Initial calculation
    setSunElevation(calculateSunElevation(viewer.clock.currentTime))
    lastUpdateRef.current = Date.now()
    lastCameraPositionRef.current = Cesium.Cartesian3.clone(viewer.scene.camera.positionWC)
    lastClockTimeRef.current = Cesium.JulianDate.clone(viewer.clock.currentTime)

    // Set up periodic recalculation
    // Using postRender to check if enough time has passed, the camera jumped, or the clock jumped
    const removeListener = viewer.scene.postRender.addEventListener(() => {
      const now = Date.now()
      const currentCameraPosition = viewer.scene.camera.positionWC
      const currentClockTime = viewer.clock.currentTime

      // Check if camera jumped significantly (e.g., airport switch)
      const cameraJumped =
        lastCameraPositionRef.current !== null &&
        Cesium.Cartesian3.distance(lastCameraPositionRef.current, currentCameraPosition) >
          PARTICLE_PREWARM_JUMP_THRESHOLD

      // Check if the clock jumped (e.g., time mode or fixed time hour changed)
      const clockJumped =
        lastClockTimeRef.current !== null &&
        Math.abs(Cesium.JulianDate.secondsDifference(currentClockTime, lastClockTimeRef.current)) >
          SUN_CLOCK_JUMP_THRESHOLD_SECONDS

      // Recalculate if time elapsed, the camera jumped, or the clock jumped
      if (clockJumped || cameraJumped || now - lastUpdateRef.current >= SUN_POSITION_UPDATE_INTERVAL) {
        setSunElevation(calculateSunElevation(currentClockTime))
        lastUpdateRef.current = now
        lastCameraPositionRef.current = Cesium.Cartesian3.clone(currentCameraPosition)
        lastClockTimeRef.current = Cesium.JulianDate.clone(currentClockTime)
      }
    })

    return () => {
      removeListener()
    }
  }, [viewer])

  return sunElevation
}
