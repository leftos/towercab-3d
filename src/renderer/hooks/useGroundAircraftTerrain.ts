import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  LOW_ALTITUDE_AGL_THRESHOLD_M
} from '../constants/rendering'
import { isTerrainCacheClearing } from './useTerrainFlattening'
import { getHeightAndSlopeFromPolygons } from '../terrain/FlatteningTerrainProvider'
import { geoidService } from '../services/GeoidService'

/** Terrain data for a single aircraft including height and slope */
export interface TerrainData {
  /** Terrain height at aircraft position in meters (ellipsoid) */
  height: number
  /** Terrain slope angle in degrees (positive = uphill in direction of travel) */
  slopeDegrees: number
}

/** Distance in meters to sample ahead/behind for slope calculation */
const SLOPE_SAMPLE_DISTANCE_M = 15

/** Minimum distance in meters an aircraft must move before re-sampling terrain */
const MIN_MOVEMENT_FOR_RESAMPLE_M = 2

/** Last sampled positions for each aircraft (to avoid redundant sampling) */
const lastSampledPositions = new Map<string, { lat: number; lon: number; heading: number }>()

/**
 * Calculate approximate distance in meters between two lat/lon points
 * Uses equirectangular approximation (fast, accurate enough for small distances)
 */
function approxDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const avgLat = (lat1 + lat2) / 2 * Math.PI / 180
  const x = dLon * Math.cos(avgLat)
  return R * Math.sqrt(dLat * dLat + x * x)
}

/**
 * Check if aircraft has moved enough to warrant re-sampling terrain
 */
function needsResample(callsign: string, lat: number, lon: number, heading: number): boolean {
  const last = lastSampledPositions.get(callsign)
  if (!last) return true // Never sampled, needs sample

  // Check if position changed significantly
  const distance = approxDistanceMeters(last.lat, last.lon, lat, lon)
  if (distance >= MIN_MOVEMENT_FOR_RESAMPLE_M) return true

  // Check if heading changed significantly (affects slope sample points)
  const headingDiff = Math.abs(heading - last.heading)
  const normalizedHeadingDiff = headingDiff > 180 ? 360 - headingDiff : headingDiff
  if (normalizedHeadingDiff >= 5) return true // 5 degree threshold

  return false
}

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
      // Skip terrain sampling while terrain cache is being cleared
      // (provider swap in progress - sampling would return invalid data)
      if (isTerrainCacheClearing()) return

      // Aircraft that need terrain sampling (outside flattening polygons)
      const needsTerrainSampling: Array<{
        callsign: string
        lat: number
        lon: number
        heading: number
      }> = []

      // Updates to apply from polygon cache hits
      const polygonCacheHits: Array<{
        callsign: string
        lat: number
        lon: number
        heading: number
        height: number
        slopeDegrees: number
      }> = []

      // Collect aircraft that need terrain data:
      // 1. Ground aircraft (groundspeed < 40kts) - definitely on the ground
      // 2. Low altitude aircraft (< 300m AGL) - likely landing/departing
      // 3. Only re-sample if aircraft has moved significantly
      for (const aircraft of interpolatedAircraft.values()) {
        if (samplingInProgressRef.current.has(aircraft.callsign)) continue

        const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
        // Convert MSL ground elevation to ellipsoidal for accurate AGL calculation
        // (aircraft.interpolatedAltitude is in ellipsoidal coordinates)
        const groundElevationEllipsoidal = geoidService.mslToEllipsoidal(
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          groundElevationMeters
        )
        const altitudeAgl = aircraft.interpolatedAltitude - groundElevationEllipsoidal
        const isLowAltitude = altitudeAgl < LOW_ALTITUDE_AGL_THRESHOLD_M

        if (isOnGround || isLowAltitude) {
          // Skip if aircraft hasn't moved enough since last sample
          if (!needsResample(
            aircraft.callsign,
            aircraft.interpolatedLatitude,
            aircraft.interpolatedLongitude,
            aircraft.interpolatedHeading
          )) {
            continue
          }

          // OPTIMIZATION: First try to get height/slope from flattening polygon cache
          // This avoids expensive terrain sampling for aircraft on runways/taxiways/aprons
          const cachedData = getHeightAndSlopeFromPolygons(
            aircraft.interpolatedLongitude,
            aircraft.interpolatedLatitude,
            aircraft.interpolatedHeading
          )

          if (cachedData) {
            // Cache hit! Use polygon data directly
            polygonCacheHits.push({
              callsign: aircraft.callsign,
              lat: aircraft.interpolatedLatitude,
              lon: aircraft.interpolatedLongitude,
              heading: aircraft.interpolatedHeading,
              height: cachedData.height,
              slopeDegrees: cachedData.slopeDegrees
            })
          } else {
            // Cache miss - needs actual terrain sampling (aircraft in non-flattened area)
            needsTerrainSampling.push({
              callsign: aircraft.callsign,
              lat: aircraft.interpolatedLatitude,
              lon: aircraft.interpolatedLongitude,
              heading: aircraft.interpolatedHeading
            })
          }
        }
      }

      // Apply polygon cache hits immediately (no async terrain sampling needed)
      if (polygonCacheHits.length > 0) {
        setTerrainData(prev => {
          const updated = new Map(prev)
          for (const hit of polygonCacheHits) {
            updated.set(hit.callsign, {
              height: hit.height,
              slopeDegrees: hit.slopeDegrees
            })
            // Update last sampled position
            lastSampledPositions.set(hit.callsign, {
              lat: hit.lat,
              lon: hit.lon,
              heading: hit.heading
            })
          }
          return updated
        })
      }

      // Only proceed with terrain sampling if there are aircraft outside flattening polygons
      if (needsTerrainSampling.length === 0) return

      // Mark as sampling in progress (only for terrain-sampled aircraft)
      needsTerrainSampling.forEach(a => samplingInProgressRef.current.add(a.callsign))

      // Sample terrain for aircraft outside flattening polygons in one batch
      // For each aircraft, sample 3 points: position, ahead, and behind (for slope)
      const positions: Cesium.Cartographic[] = []
      const positionIndexMap: Array<{ callsign: string; centerIdx: number; aheadIdx: number; behindIdx: number }> = []

      for (const aircraft of needsTerrainSampling) {
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

              // Skip aircraft with undefined heights (terrain provider throttled)
              // Keep using their previous terrain data instead of corrupting with NaN
              if (centerHeight === undefined || aheadHeight === undefined || behindHeight === undefined) {
                const centerPos = positions[mapping.centerIdx]
                console.warn(`[Terrain Sampling] Throttled for ${mapping.callsign} - keeping previous data`, {
                  centerLon: Cesium.Math.toDegrees(centerPos.longitude),
                  centerLat: Cesium.Math.toDegrees(centerPos.latitude)
                })
                samplingInProgressRef.current.delete(mapping.callsign)
                continue // Don't update terrain data or last position
              }

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

              // Update last sampled position on successful sample
              const aircraft = needsTerrainSampling.find(a => a.callsign === mapping.callsign)
              if (aircraft) {
                lastSampledPositions.set(mapping.callsign, {
                  lat: aircraft.lat,
                  lon: aircraft.lon,
                  heading: aircraft.heading
                })
              }

              samplingInProgressRef.current.delete(mapping.callsign)
            }

            return updated
          })
        })
        .catch((error) => {
          console.warn('[Terrain Sampling] Failed to sample terrain:', error)
          // Clear sampling flags on error
          needsTerrainSampling.forEach(a => samplingInProgressRef.current.delete(a.callsign))
        })
    }, 333) // 3x per second - balanced for responsiveness vs terrain provider load

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
          // Aircraft no longer in data - clean up both terrain data and position cache
          updated.delete(callsign)
          lastSampledPositions.delete(callsign)
          changed = true
          continue
        }

        const isOnGround = aircraft.interpolatedGroundspeed < GROUNDSPEED_THRESHOLD_KNOTS
        // Convert MSL ground elevation to ellipsoidal for accurate AGL calculation
        const groundElevationEllipsoidal = geoidService.mslToEllipsoidal(
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          groundElevationMeters
        )
        const altitudeAgl = aircraft.interpolatedAltitude - groundElevationEllipsoidal
        const isLowAltitude = altitudeAgl < LOW_ALTITUDE_AGL_THRESHOLD_M

        // Only remove terrain data if aircraft is both fast AND high altitude
        if (!isOnGround && !isLowAltitude) {
          updated.delete(callsign)
          lastSampledPositions.delete(callsign)
          changed = true
        }
      }

      return changed ? updated : prev
    })
  }, [interpolatedAircraft, groundElevationMeters])

  return terrainData
}
