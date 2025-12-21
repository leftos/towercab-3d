import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  LOW_ALTITUDE_AGL_THRESHOLD_M
} from '../constants/rendering'

/**
 * Continuously samples terrain height for ground and low-altitude aircraft (3x per second)
 *
 * Provides accurate terrain elevation at each aircraft's position for smooth
 * ground following as aircraft taxi across varying airport elevations.
 *
 * Also samples terrain for low-altitude aircraft (below LOW_ALTITUDE_AGL_THRESHOLD_M)
 * to ensure landing aircraft get terrain data before slowing below 40kts. This
 * prevents clipping through runways during landing roll.
 *
 * @param viewer - Cesium viewer instance
 * @param interpolatedAircraft - Map of interpolated aircraft states
 * @param groundElevationMeters - Airport/reference ground elevation in meters MSL
 * @returns Map of callsign -> terrain height in meters (ellipsoid)
 */
export function useGroundAircraftTerrain(
  viewer: Cesium.Viewer | null,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  groundElevationMeters: number = 0
): Map<string, number> {
  const [terrainHeights, setTerrainHeights] = useState<Map<string, number>>(new Map())
  const samplingInProgressRef = useRef<Set<string>>(new Set())

  // Extract terrainProvider as a separate dependency to detect when it becomes available
  const terrainProvider = viewer?.terrainProvider

  useEffect(() => {
    if (!viewer || !terrainProvider) return

    // Sample terrain for all ground aircraft every 333ms (3x per second)
    const intervalId = setInterval(() => {
      const groundAircraft: Array<{ callsign: string; lat: number; lon: number }> = []

      // Collect aircraft that need terrain sampling:
      // 1. Ground aircraft (groundspeed < 40kts) - definitely on the ground
      // 2. Low altitude aircraft (< 300m AGL) - likely landing/departing, need terrain
      //    data before they slow down to prevent clipping during landing roll
      for (const aircraft of interpolatedAircraft.values()) {
        if (samplingInProgressRef.current.has(aircraft.callsign)) continue

        const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
        const altitudeAgl = aircraft.interpolatedAltitude - groundElevationMeters
        const isLowAltitude = altitudeAgl < LOW_ALTITUDE_AGL_THRESHOLD_M

        if (isOnGround || isLowAltitude) {
          groundAircraft.push({
            callsign: aircraft.callsign,
            lat: aircraft.interpolatedLatitude,
            lon: aircraft.interpolatedLongitude
          })
        }
      }

      if (groundAircraft.length === 0) return

      // Mark all as sampling in progress
      groundAircraft.forEach(a => samplingInProgressRef.current.add(a.callsign))

      // Sample terrain for all ground aircraft in one batch (more efficient)
      const positions = groundAircraft.map(a =>
        Cesium.Cartographic.fromDegrees(a.lon, a.lat)
      )

      Cesium.sampleTerrainMostDetailed(terrainProvider, positions)
        .then((sampledPositions) => {
          setTerrainHeights(prev => {
            const updated = new Map(prev)
            groundAircraft.forEach((aircraft, index) => {
              updated.set(aircraft.callsign, sampledPositions[index].height)
              samplingInProgressRef.current.delete(aircraft.callsign)
            })
            return updated
          })
        })
        .catch((error) => {
          console.warn('[Terrain Sampling] Failed to sample terrain for ground aircraft:', error)
          // Clear sampling flags on error
          groundAircraft.forEach(a => samplingInProgressRef.current.delete(a.callsign))
        })
    }, 333) // 3x per second

    return () => clearInterval(intervalId)
  }, [viewer, terrainProvider, interpolatedAircraft, groundElevationMeters])

  // Clean up terrain heights for aircraft that are no longer present or have climbed away
  useEffect(() => {
    setTerrainHeights(prev => {
      const updated = new Map(prev)
      let changed = false

      for (const callsign of updated.keys()) {
        const aircraft = interpolatedAircraft.get(callsign)
        if (!aircraft) {
          // Aircraft no longer in data
          updated.delete(callsign)
          changed = true
          continue
        }

        const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
        const altitudeAgl = aircraft.interpolatedAltitude - groundElevationMeters
        const isLowAltitude = altitudeAgl < LOW_ALTITUDE_AGL_THRESHOLD_M

        // Only remove terrain height if aircraft is both fast AND high altitude
        if (!isOnGround && !isLowAltitude) {
          updated.delete(callsign)
          changed = true
        }
      }

      return changed ? updated : prev
    })
  }, [interpolatedAircraft, groundElevationMeters])

  return terrainHeights
}
