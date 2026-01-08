import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  LOW_ALTITUDE_AGL_THRESHOLD_M
} from '../constants/rendering'

/** Terrain data for a single aircraft including height and slope */
export interface TerrainData {
  /** Terrain height at aircraft position in meters (ellipsoid) */
  height: number
  /** Terrain slope angle in degrees (positive = uphill in direction of travel) */
  slopeDegrees: number
}

/** Distance in meters to sample ahead/behind for slope calculation */
const SLOPE_SAMPLE_DISTANCE_M = 15

/**
 * Continuously samples terrain height and slope for ground and low-altitude aircraft (3x per second)
 *
 * Provides accurate terrain elevation at each aircraft's position for smooth
 * ground following as aircraft taxi across varying airport elevations.
 *
 * Also calculates terrain slope by sampling points ahead/behind the aircraft
 * along its heading, enabling realistic pitch orientation on sloped runways.
 *
 * Also samples terrain for low-altitude aircraft (below LOW_ALTITUDE_AGL_THRESHOLD_M)
 * to ensure landing aircraft get terrain data before slowing below 40kts. This
 * prevents clipping through runways during landing roll.
 *
 * @param viewer - Cesium viewer instance
 * @param interpolatedAircraft - Map of interpolated aircraft states
 * @param groundElevationMeters - Airport/reference ground elevation in meters MSL
 * @returns Map of callsign -> terrain data (height and slope)
 */
export function useGroundAircraftTerrain(
  viewer: Cesium.Viewer | null,
  interpolatedAircraft: Map<string, InterpolatedAircraftState>,
  groundElevationMeters: number = 0
): Map<string, TerrainData> {
  const [terrainData, setTerrainData] = useState<Map<string, TerrainData>>(new Map())
  const samplingInProgressRef = useRef<Set<string>>(new Set())

  // Extract terrainProvider as a separate dependency to detect when it becomes available
  const terrainProvider = viewer?.terrainProvider

  useEffect(() => {
    if (!viewer || !terrainProvider) return

    // Sample terrain for all ground aircraft every 333ms (3x per second)
    const intervalId = setInterval(() => {
      const groundAircraft: Array<{
        callsign: string
        lat: number
        lon: number
        heading: number
      }> = []

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
            lon: aircraft.interpolatedLongitude,
            heading: aircraft.interpolatedHeading
          })
        }
      }

      if (groundAircraft.length === 0) return

      // Mark all as sampling in progress
      groundAircraft.forEach(a => samplingInProgressRef.current.add(a.callsign))

      // Sample terrain for all ground aircraft in one batch (more efficient)
      // For each aircraft, sample 3 points: position, ahead, and behind (for slope)
      const positions: Cesium.Cartographic[] = []
      const positionIndexMap: Array<{ callsign: string; centerIdx: number; aheadIdx: number; behindIdx: number }> = []

      for (const aircraft of groundAircraft) {
        const centerIdx = positions.length

        // Center position (aircraft location)
        positions.push(Cesium.Cartographic.fromDegrees(aircraft.lon, aircraft.lat))

        // Calculate points ahead and behind along aircraft heading
        // heading is in degrees clockwise from north
        const headingRad = Cesium.Math.toRadians(aircraft.heading)
        const centerCart = Cesium.Cartesian3.fromDegrees(aircraft.lon, aircraft.lat, 0)

        // Get local east-north-up transform at this location
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(centerCart)

        // Ahead point: move forward in heading direction
        // In ENU: heading 0 = north (+Y), heading 90 = east (+X)
        const aheadOffsetENU = new Cesium.Cartesian3(
          Math.sin(headingRad) * SLOPE_SAMPLE_DISTANCE_M,  // East component
          Math.cos(headingRad) * SLOPE_SAMPLE_DISTANCE_M,  // North component
          0  // Up component
        )
        const aheadCartesian = Cesium.Matrix4.multiplyByPoint(transform, aheadOffsetENU, new Cesium.Cartesian3())
        const aheadCarto = Cesium.Cartographic.fromCartesian(aheadCartesian)
        const aheadIdx = positions.length
        positions.push(aheadCarto)

        // Behind point: move backward
        const behindOffsetENU = new Cesium.Cartesian3(
          -Math.sin(headingRad) * SLOPE_SAMPLE_DISTANCE_M,
          -Math.cos(headingRad) * SLOPE_SAMPLE_DISTANCE_M,
          0
        )
        const behindCartesian = Cesium.Matrix4.multiplyByPoint(transform, behindOffsetENU, new Cesium.Cartesian3())
        const behindCarto = Cesium.Cartographic.fromCartesian(behindCartesian)
        const behindIdx = positions.length
        positions.push(behindCarto)

        positionIndexMap.push({
          callsign: aircraft.callsign,
          centerIdx,
          aheadIdx,
          behindIdx
        })
      }

      Cesium.sampleTerrainMostDetailed(terrainProvider, positions)
        .then((sampledPositions) => {
          setTerrainData(prev => {
            const updated = new Map(prev)

            for (const mapping of positionIndexMap) {
              const centerHeight = sampledPositions[mapping.centerIdx].height
              const aheadHeight = sampledPositions[mapping.aheadIdx].height
              const behindHeight = sampledPositions[mapping.behindIdx].height

              // Calculate slope from behind to ahead (total distance = 2 * SLOPE_SAMPLE_DISTANCE_M)
              // Positive slope means uphill in direction of travel
              const heightDiff = aheadHeight - behindHeight
              const horizontalDist = 2 * SLOPE_SAMPLE_DISTANCE_M
              const slopeRadians = Math.atan2(heightDiff, horizontalDist)
              const slopeDegrees = Cesium.Math.toDegrees(slopeRadians)

              updated.set(mapping.callsign, {
                height: centerHeight,
                slopeDegrees
              })

              samplingInProgressRef.current.delete(mapping.callsign)
            }

            return updated
          })
        })
        .catch((error) => {
          console.warn('[Terrain Sampling] Failed to sample terrain for ground aircraft:', error)
          // Clear sampling flags on error
          groundAircraft.forEach(a => samplingInProgressRef.current.delete(a.callsign))
        })
    }, 100) // 10x per second for responsive slope updates

    return () => clearInterval(intervalId)
  }, [viewer, terrainProvider, interpolatedAircraft, groundElevationMeters])

  // Clean up terrain data for aircraft that are no longer present or have climbed away
  useEffect(() => {
    setTerrainData(prev => {
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

        // Only remove terrain data if aircraft is both fast AND high altitude
        if (!isOnGround && !isLowAltitude) {
          updated.delete(callsign)
          changed = true
        }
      }

      return changed ? updated : prev
    })
  }, [interpolatedAircraft, groundElevationMeters])

  return terrainData
}
