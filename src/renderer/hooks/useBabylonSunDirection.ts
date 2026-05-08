/**
 * useBabylonSunDirection Hook
 *
 * Keeps the Babylon directional light (named `dirLight`) pointing in the same
 * direction as the real sun, so that opaque Babylon-side geometry (the modded
 * tower cab) is lit and self-shadows realistically as the day progresses.
 *
 * The sun position is computed in ECEF using Cesium's planetary-position model,
 * transformed into the current ENU root frame, swapped into Babylon's Y-up
 * coordinate system, and negated to give the light's "from sun toward ground"
 * direction vector.
 *
 * Throttled to ~1 Hz (sun moves <0.005°/sec; per-frame is wasted work) but with
 * an immediate re-run when the ENU root origin changes (airport switch).
 *
 * Note: weather meshes (fog dome, cloud planes) use StandardMaterial without
 * directional lighting — only the cab cares about dirLight direction today.
 */

import type * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import { useEffect, useRef } from 'react'
import type { TimeMode } from '@/types/settings'
import { ecefToEnuDirection } from '../utils/enuTransforms'

interface UseBabylonSunDirectionOptions {
  scene: BABYLON.Scene | null
  cesiumViewer: Cesium.Viewer | null
  getFixedToEnu: () => Cesium.Matrix4 | null
  enabled?: boolean
  timeMode?: TimeMode
  fixedTimeHour?: number
}

const SUN_DIRECTION_UPDATE_INTERVAL_MS = 1000

/**
 * Compute the unit vector pointing from Earth's center toward the sun, in ECEF.
 * Uses the same Simon-1994 model as useSunElevation but returns a direction
 * (not a scalar elevation).
 */
function computeSunDirectionEcef(time: Cesium.JulianDate): Cesium.Cartesian3 | null {
  const sunEci = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time)

  const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(time)
  if (icrfToFixed) {
    Cesium.Matrix3.multiplyByVector(icrfToFixed, sunEci, sunEci)
  } else {
    const temeToFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time)
    if (!temeToFixed) return null
    Cesium.Matrix3.multiplyByVector(temeToFixed, sunEci, sunEci)
  }

  return Cesium.Cartesian3.normalize(sunEci, new Cesium.Cartesian3())
}

/**
 * Compute the JulianDate to evaluate the sun position at. Mirrors useSunElevation's
 * fixed-time-mode logic so day/night appearance stays consistent across hooks.
 */
function resolveTime(
  cesiumViewer: Cesium.Viewer,
  timeMode: TimeMode | undefined,
  fixedTimeHour: number | undefined,
): Cesium.JulianDate {
  if (timeMode === 'fixed' && fixedTimeHour !== undefined) {
    const cartographic = Cesium.Cartographic.fromCartesian(cesiumViewer.camera.positionWC)
    const longitudeDegrees = Cesium.Math.toDegrees(cartographic.longitude)
    const longitudeOffsetHours = longitudeDegrees / 15

    const now = new Date()
    const targetTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0))
    const utcHour = fixedTimeHour - longitudeOffsetHours
    targetTime.setTime(targetTime.getTime() + utcHour * 60 * 60 * 1000)
    return Cesium.JulianDate.fromDate(targetTime)
  }
  return Cesium.JulianDate.now()
}

export function useBabylonSunDirection(options: UseBabylonSunDirectionOptions): void {
  const { scene, cesiumViewer, getFixedToEnu, enabled = true, timeMode, fixedTimeHour } = options

  const lastUpdateMsRef = useRef<number>(0)
  const lastFixedToEnuRef = useRef<Cesium.Matrix4 | null>(null)

  useEffect(() => {
    if (!enabled || !scene || scene.isDisposed) return
    if (!cesiumViewer || cesiumViewer.isDestroyed()) return

    const dirLight = scene.getLightByName('dirLight') as BABYLON.DirectionalLight | null
    if (!dirLight) return

    const updateDirection = (force: boolean): void => {
      const fixedToEnu = getFixedToEnu()
      if (!fixedToEnu) return

      const now = Date.now()
      const enuChanged = fixedToEnu !== lastFixedToEnuRef.current
      if (!force && !enuChanged && now - lastUpdateMsRef.current < SUN_DIRECTION_UPDATE_INTERVAL_MS) {
        return
      }

      const sunEcef = computeSunDirectionEcef(resolveTime(cesiumViewer, timeMode, fixedTimeHour))
      if (!sunEcef) return

      const sunEnu = ecefToEnuDirection(sunEcef, fixedToEnu)
      // ENU x=East, y=North, z=Up; Babylon x=East, y=Up, z=North.
      // Light direction points FROM sun TO ground, so negate the toward-sun vector.
      dirLight.direction.set(-sunEnu.x, -sunEnu.z, -sunEnu.y)

      lastUpdateMsRef.current = now
      lastFixedToEnuRef.current = fixedToEnu
    }

    // Initial compute.
    updateDirection(true)

    // Throttled re-compute on every Cesium post-render.
    const removeListener = cesiumViewer.scene.postRender.addEventListener(() => {
      updateDirection(false)
    })

    return () => {
      removeListener()
    }
  }, [scene, cesiumViewer, getFixedToEnu, enabled, timeMode, fixedTimeHour])
}

export default useBabylonSunDirection
