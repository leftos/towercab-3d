import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import { GROUNDSPEED_THRESHOLD_KNOTS } from '../constants/rendering'

/**
 * Continuously samples terrain height for ground aircraft (3x per second)
 *
 * Provides accurate terrain elevation at each aircraft's position for smooth
 * ground following as aircraft taxi across varying airport elevations.
 *
 * @param viewer - Cesium viewer instance
 * @param interpolatedAircraft - Map of interpolated aircraft states
 * @returns Map of callsign -> terrain height in meters (ellipsoid)
 */
export function useGroundAircraftTerrain(
  viewer: Cesium.Viewer | null,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>
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

      // Collect all ground aircraft positions
      for (const aircraft of interpolatedAircraft.values()) {
        const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
        if (isOnGround && !samplingInProgressRef.current.has(aircraft.callsign)) {
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
  }, [viewer, terrainProvider])

  // Clean up terrain heights for aircraft that are no longer present or airborne
  useEffect(() => {
    setTerrainHeights(prev => {
      const updated = new Map(prev)
      let changed = false

      for (const callsign of updated.keys()) {
        const aircraft = interpolatedAircraft.get(callsign)
        const isStillGround = aircraft && aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS

        if (!isStillGround) {
          updated.delete(callsign)
          changed = true
        }
      }

      return changed ? updated : prev
    })
  }, [interpolatedAircraft])

  return terrainHeights
}
