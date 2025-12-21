import { useEffect, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { calculateDistanceNM } from '../utils/interpolation'
import {
  GROUNDSPEED_THRESHOLD_KNOTS,
  DATABLOCK_HEIGHT_MULTIPLIER,
  DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER,
  GROUND_AIRCRAFT_TERRAIN_OFFSET
} from '../constants/rendering'

export type DatablockMode = 'none' | 'full' | 'airline'

interface BabylonOverlay {
  updateAircraftLabel: (callsign: string, text: string, r: number, g: number, b: number) => void
  hideAllLabels: () => void
  updateLeaderLine: (callsign: string, coneX: number, coneY: number, offsetX: number, offsetY: number) => void
  getAircraftCallsigns: () => string[]
  removeAircraftLabel: (callsign: string) => void
  isDatablockVisibleByWeather: (cameraAltitudeAGL: number, aircraftAltitudeAGL: number, distanceMeters: number) => boolean
}

interface UseCesiumLabelsParams {
  viewer: Cesium.Viewer | null
  babylonOverlay: BabylonOverlay | null
  interpolatedAircraft: Map<string, InterpolatedAircraftState>
  datablockMode: DatablockMode
  viewMode: ViewMode
  followingCallsign: string | null
  currentAirportIcao: string | null
  airportElevationFeet: number
  groundElevationMeters: number
  terrainOffset: number  // Geoid offset for MSL → ellipsoid conversion
  towerHeight: number
  // Reference position for distance calculation
  refLat: number | null
  refLon: number | null
  refAltitudeFeet: number | null
  // Filter settings
  labelVisibilityDistance: number
  showGroundTraffic: boolean
  showAirborneTraffic: boolean
  searchQuery: string
  filterAirportTraffic: boolean
  isOrbitModeWithoutAirport: boolean
  // Ground aircraft terrain heights (sampled 3x per second)
  groundAircraftTerrain: Map<string, number>
}

/**
 * Manages aircraft label rendering with filtering and overlap detection
 *
 * ## Responsibilities
 * - Generate datablock text (callsign, type, altitude, speed)
 * - Filter labels by distance, ground/airborne, search query, airport traffic
 * - Calculate label positions with overlap avoidance
 * - Apply weather-based visibility culling (clouds, fog)
 * - Coordinate with Babylon overlay for label rendering and leader lines
 *
 * ## Label Filtering System
 * Labels are filtered through multiple passes:
 * 1. **Followed aircraft**: Always shown, bypasses all filters
 * 2. **Distance filter**: Based on labelVisibilityDistance setting
 * 3. **Ground/airborne filter**: showGroundTraffic, showAirborneTraffic settings
 * 4. **Search filter**: Matches callsign, aircraft type, departure, arrival
 * 5. **Airport traffic filter**: Only show aircraft to/from current airport
 * 6. **Weather visibility**: Hide aircraft obscured by clouds or beyond visibility
 *
 * ## Label Positioning
 * Uses intelligent overlap detection:
 * - **Default position**: Top-left of aircraft cone
 * - **Cone overlap check**: Move label further if it overlaps cone
 * - **Label overlap check**: Try 5 alternative positions (top-right, bottom-left, etc.)
 * - **Leader lines**: Drawn from cone center to label corner
 *
 * ## Datablock Modes
 * - **none**: No labels shown
 * - **full**: Full callsign + type + altitude/speed
 * - **airline**: 3-letter airline code (AAL123 → AAL) + type + altitude/speed
 *
 * ## Weather Visibility Culling
 * Labels hidden when:
 * - Aircraft is behind cloud layer (camera below cloud, aircraft above)
 * - Aircraft is beyond visibility range from METAR
 * - Always show followed aircraft regardless of weather
 *
 * ## Dependencies
 * - Requires: useBabylonOverlay for label rendering
 * - Requires: useAircraftInterpolation for aircraft positions
 * - Reads: weatherStore for visibility and cloud data
 * - Reads: settingsStore for label filter settings
 *
 * @example
 * ```tsx
 * const viewer = useCesiumViewer(...)
 * const babylonOverlay = useBabylonOverlay(...)
 * const interpolatedAircraft = useAircraftInterpolation()
 *
 * useCesiumLabels({
 *   viewer,
 *   babylonOverlay,
 *   interpolatedAircraft,
 *   datablockMode: 'full',
 *   viewMode: '3d',
 *   followingCallsign: null,
 *   currentAirportIcao: 'KBOS',
 *   airportElevationFeet: 20,
 *   groundElevationMeters: 6,
 *   towerHeight: 50,
 *   labelVisibilityDistance: 15,
 *   showGroundTraffic: true,
 *   showAirborneTraffic: true,
 *   searchQuery: '',
 *   filterAirportTraffic: false,
 *   isOrbitModeWithoutAirport: false
 * })
 * ```
 */
export function useCesiumLabels(params: UseCesiumLabelsParams) {
  const {
    viewer,
    babylonOverlay,
    interpolatedAircraft,
    datablockMode,
    viewMode,
    followingCallsign,
    currentAirportIcao,
    groundElevationMeters,
    terrainOffset,
    towerHeight,
    refLat,
    refLon,
    refAltitudeFeet,
    labelVisibilityDistance,
    showGroundTraffic,
    showAirborneTraffic,
    searchQuery,
    filterAirportTraffic,
    isOrbitModeWithoutAirport,
    groundAircraftTerrain
  } = params

  // Update labels
  const updateLabels = useCallback(() => {
    if (!viewer || !babylonOverlay || !refLat || !refLon || !refAltitudeFeet) return

    const query = searchQuery.toLowerCase()
    const airportIcao = currentAirportIcao

    // First pass: Build aircraft data with filtering
    const aircraftData: Array<{
      callsign: string
      labelText: string
      labelColor: { r: number; g: number; b: number }
      cesiumPosition: Cesium.Cartesian3 | null
      wingspanMeters: number
      heightAboveEllipsoid: number
      latitude: number
      longitude: number
      altitudeMetersAGL: number
      distanceMeters: number
      isFollowed: boolean
      showDatablock: boolean
    }> = []

    const seenCallsigns = new Set<string>()

    for (const aircraft of interpolatedAircraft.values()) {
      seenCallsigns.add(aircraft.callsign)

      // Calculate distance from reference position
      const distance = calculateDistanceNM(
        refLat,
        refLon,
        aircraft.interpolatedLatitude,
        aircraft.interpolatedLongitude,
        refAltitudeFeet,
        aircraft.interpolatedAltitude
      )

      const isFollowed = aircraft.callsign === followingCallsign
      const altitudeMeters = aircraft.interpolatedAltitude  // Altitude is in METERS
      // Aircraft is on ground if groundspeed < threshold (40 knots)
      const isAirborne = aircraft.interpolatedGroundspeed >= GROUNDSPEED_THRESHOLD_KNOTS

      // Determine if this aircraft should have a datablock shown
      let showDatablock = false

      if (isFollowed) {
        // Always show followed aircraft datablock
        showDatablock = true
      } else {
        // Apply datablock filters
        showDatablock = true

        // Distance filter
        if (distance > labelVisibilityDistance) {
          showDatablock = false
        }

        // Ground/airborne filter (skip in orbit mode without airport)
        if (showDatablock && !isOrbitModeWithoutAirport) {
          // Use groundspeed-based check (already defined on line 178)
          if (isAirborne && !showAirborneTraffic) {
            showDatablock = false
          }
          if (!isAirborne && !showGroundTraffic) {
            showDatablock = false
          }
        }

        // Search filter (from panel)
        if (showDatablock && query) {
          if (!aircraft.callsign.toLowerCase().includes(query) &&
              !aircraft.aircraftType?.toLowerCase().includes(query) &&
              !aircraft.departure?.toLowerCase().includes(query) &&
              !aircraft.arrival?.toLowerCase().includes(query)) {
            showDatablock = false
          }
        }

        // Airport traffic filter (from panel)
        if (showDatablock && filterAirportTraffic && airportIcao) {
          if (aircraft.departure?.toUpperCase() !== airportIcao &&
              aircraft.arrival?.toUpperCase() !== airportIcao) {
            showDatablock = false
          }
        }
      }

      // Format datablock text based on datablockMode setting
      let labelText = ''
      if (datablockMode !== 'none' && showDatablock) {
        const type = aircraft.aircraftType || '????'
        const speedTens = Math.round(aircraft.interpolatedGroundspeed / 10).toString().padStart(2, '0')
        // Convert altitude to feet for FL display (METERS → FEET)
        const altitudeFeet = aircraft.interpolatedAltitude / 0.3048
        const dataLine = isAirborne
          ? `${Math.round(altitudeFeet / 100).toString().padStart(3, '0')} ${speedTens}`
          : speedTens

        // Format callsign based on mode
        let displayCallsign = aircraft.callsign
        if (datablockMode === 'airline') {
          // Check if callsign matches airline pattern: exactly 3 letters followed by 1-4 digits
          const airlinePattern = /^([A-Z]{3})\d{1,4}$/
          const match = aircraft.callsign.match(airlinePattern)
          if (match) {
            // Show only the airline ICAO code (first 3 letters)
            displayCallsign = match[1]
          }
          // If doesn't match pattern, show full callsign (e.g., N12345)
        }

        labelText = `${displayCallsign}\n${type} ${dataLine}`
      }

      // Get color
      let babylonColor: { r: number; g: number; b: number }
      if (isFollowed) {
        babylonColor = { r: 0, g: 1, b: 1 } // Cyan for followed
      } else if (!aircraft.isInterpolated) {
        babylonColor = { r: 1, g: 1, b: 0 } // Yellow for not interpolated (new/stale)
      } else if (isAirborne) {
        babylonColor = { r: 0, g: 1, b: 0 } // Green for airborne
      } else {
        babylonColor = { r: 1, g: 0.5, b: 0 } // Orange for ground
      }

      // Calculate positions (altitude is in MSL METERS, convert to ellipsoid height)
      // ellipsoidHeight = mslAltitude + geoidOffset
      let heightAboveEllipsoid = altitudeMeters + terrainOffset

      // For ground aircraft, use terrain-sampled height if available
      if (!isAirborne) {
        const sampledTerrainHeight = groundAircraftTerrain.get(aircraft.callsign)
        if (sampledTerrainHeight !== undefined) {
          // Use sampled terrain height + small offset (matches model positioning)
          heightAboveEllipsoid = sampledTerrainHeight + GROUND_AIRCRAFT_TERRAIN_OFFSET
        } else {
          // Fallback: use MAX of (reported altitude, ground elevation) + terrain offset
          const reportedEllipsoidHeight = altitudeMeters + terrainOffset
          const groundEllipsoidHeight = groundElevationMeters + terrainOffset
          heightAboveEllipsoid = Math.max(reportedEllipsoidHeight, groundEllipsoidHeight) + GROUND_AIRCRAFT_TERRAIN_OFFSET
        }
      }

      const cesiumPosition = Cesium.Cartesian3.fromDegrees(
        aircraft.interpolatedLongitude,
        aircraft.interpolatedLatitude,
        heightAboveEllipsoid
      )

      // Labels are positioned in screen-space relative to the model position
      // No separate labelPosition - all offsets applied in screen coordinates
      // This ensures labels are always positioned relative to where the model actually renders
      const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType)
      const wingspanMeters = modelInfo.dimensions.wingspan

      // Calculate AGL in meters (both altitudeMeters and groundElevationMeters are in meters)
      const altitudeMetersAGL = altitudeMeters - groundElevationMeters
      const distanceMeters = distance * 1852 // NM to meters

      aircraftData.push({
        callsign: aircraft.callsign,
        labelText,
        labelColor: babylonColor,
        cesiumPosition,
        wingspanMeters,
        heightAboveEllipsoid,
        latitude: aircraft.interpolatedLatitude,
        longitude: aircraft.interpolatedLongitude,
        altitudeMetersAGL,
        distanceMeters,
        isFollowed,
        showDatablock
      })

      // Update or create label in Babylon
      if (showDatablock && labelText) {
        babylonOverlay.updateAircraftLabel(
          aircraft.callsign,
          labelText,
          babylonColor.r,
          babylonColor.g,
          babylonColor.b
        )
      }
    }

    // Hide all labels first, then show only visible ones
    babylonOverlay.hideAllLabels()

    // Get camera altitude for weather visibility checks
    const cameraCartographic = viewer.camera.positionCartographic
    const cameraAltitudeAGL = cameraCartographic
      ? cameraCartographic.height - groundElevationMeters
      : towerHeight

    // Second pass: Calculate label offsets with overlap detection
    const labelWidth = 90
    const labelHeight = 36
    const coneRadius = viewMode === 'topdown' ? 15 : 15
    const labelGap = viewMode === 'topdown' ? 3 : 10

    const labelPositions: Array<{
      callsign: string
      coneX: number
      coneY: number
      labelX: number
      labelY: number
      offsetX: number
      offsetY: number
    }> = []

    for (const data of aircraftData) {
      if (!data.showDatablock || !data.labelText) continue
      if (!data.cesiumPosition) continue

      // Check weather visibility - hide datablocks obscured by clouds or beyond visibility range
      if (!data.isFollowed && !babylonOverlay.isDatablockVisibleByWeather(
        cameraAltitudeAGL,
        data.altitudeMetersAGL,
        data.distanceMeters
      )) {
        continue // Skip this aircraft - datablock hidden by weather
      }

      // Project aircraft position to screen
      const aircraftWindowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, data.cesiumPosition)
      if (!aircraftWindowPos) continue

      // Calculate wingspan in screen-space pixels for proportional label offset
      // Project a point offset by wingspan meters to get screen-space wingspan
      const wingspanOffset = Cesium.Cartesian3.fromDegrees(
        data.longitude + (data.wingspanMeters * 0.000009), // ~wingspan meters east
        data.latitude,
        data.heightAboveEllipsoid
      )
      const wingspanWindowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, wingspanOffset)
      const wingspanPixels = wingspanWindowPos
        ? Math.abs(wingspanWindowPos.x - aircraftWindowPos.x)
        : 30 // Fallback if projection fails

      // Apply screen-space offsets:
      // - Vertical: Move up by wingspan * DATABLOCK_HEIGHT_MULTIPLIER
      // - Horizontal: Move left by 30 pixels (closer to aircraft for better visibility)
      const viewModeScale = viewMode === 'topdown' ? 0.5 : 1.0
      const verticalOffsetPixels = wingspanPixels * DATABLOCK_HEIGHT_MULTIPLIER * viewModeScale
      const horizontalOffsetPixels = 30 // Reduced from 50px to bring datablock closer

      // Leader line endpoint offset (where line connects to aircraft)
      // Smaller than label offset to position above fuselage but below label
      const leaderLineOffsetPixels = wingspanPixels * DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER * viewModeScale

      const aircraftScreenPos = { x: aircraftWindowPos.x, y: aircraftWindowPos.y }

      // Default offset: top-left of cone + height multiplier for vertical separation
      let offsetX = -labelWidth - labelGap - horizontalOffsetPixels
      let offsetY = -labelHeight - labelGap - verticalOffsetPixels

      // Screen position for overlap detection (includes base offsets)
      const screenPos = {
        x: aircraftScreenPos.x + offsetX,
        y: aircraftScreenPos.y + offsetY
      }

      // Check for overlap with cone itself (cone is at aircraft position, not label attachment point)
      const labelLeft = screenPos.x
      const labelTop = screenPos.y
      const labelRight = labelLeft + labelWidth
      const labelBottom = labelTop + labelHeight

      if (labelRight > aircraftScreenPos.x - coneRadius && labelLeft < aircraftScreenPos.x + coneRadius &&
          labelBottom > aircraftScreenPos.y - coneRadius && labelTop < aircraftScreenPos.y + coneRadius) {
        // Adjust offsets to avoid cone overlap
        offsetX = -labelWidth - coneRadius - labelGap - horizontalOffsetPixels
        offsetY = -labelHeight - coneRadius - labelGap - verticalOffsetPixels
        // Recalculate screenPos with new offsets
        screenPos.x = aircraftScreenPos.x + offsetX
        screenPos.y = aircraftScreenPos.y + offsetY
      }

      // Check for overlap with other labels
      for (const existing of labelPositions) {
        const existingLeft = existing.labelX
        const existingTop = existing.labelY
        const existingRight = existingLeft + labelWidth
        const existingBottom = existingTop + labelHeight

        if (screenPos.x < existingRight + 5 && screenPos.x + labelWidth > existingLeft - 5 &&
            screenPos.y < existingBottom + 5 && screenPos.y + labelHeight > existingTop - 5) {
          // Try alternative positions relative to aircraft (including height offset)
          const alternatives = [
            { x: labelGap, y: -labelHeight - labelGap - verticalOffsetPixels },
            { x: -labelWidth - labelGap - horizontalOffsetPixels, y: labelGap },
            { x: labelGap, y: labelGap },
            { x: -labelWidth - labelGap - horizontalOffsetPixels, y: -labelHeight - labelGap - 30 - verticalOffsetPixels },
            { x: labelGap + 30, y: -labelHeight - labelGap - verticalOffsetPixels },
          ]

          for (const alt of alternatives) {
            const testX = aircraftScreenPos.x + alt.x
            const testY = aircraftScreenPos.y + alt.y
            let overlaps = false

            for (const check of labelPositions) {
              if (testX < check.labelX + labelWidth + 5 && testX + labelWidth > check.labelX - 5 &&
                  testY < check.labelY + labelHeight + 5 && testY + labelHeight > check.labelY - 5) {
                overlaps = true
                break
              }
            }

            if (!overlaps) {
              offsetX = alt.x
              offsetY = alt.y
              screenPos.x = aircraftScreenPos.x + offsetX
              screenPos.y = aircraftScreenPos.y + offsetY
              break
            }
          }
        }
      }

      labelPositions.push({
        callsign: data.callsign,
        coneX: aircraftScreenPos.x,
        coneY: aircraftScreenPos.y - leaderLineOffsetPixels, // Offset upward (negative Y = up in screen coords)
        labelX: screenPos.x,
        labelY: screenPos.y,
        offsetX,
        offsetY
      })
    }

    // Third pass: Update leader lines with calculated offsets
    for (const pos of labelPositions) {
      babylonOverlay.updateLeaderLine(pos.callsign, pos.coneX, pos.coneY, pos.offsetX, pos.offsetY)
    }

    // Clean up any Babylon labels that are no longer in the visible set
    const babylonCallsigns = babylonOverlay.getAircraftCallsigns()
    for (const callsign of babylonCallsigns) {
      if (!seenCallsigns.has(callsign)) {
        babylonOverlay.removeAircraftLabel(callsign)
      }
    }
  }, [
    viewer,
    babylonOverlay,
    interpolatedAircraft,
    datablockMode,
    viewMode,
    followingCallsign,
    currentAirportIcao,
    groundElevationMeters,
    groundAircraftTerrain,
    terrainOffset,
    towerHeight,
    refLat,
    refLon,
    refAltitudeFeet,
    labelVisibilityDistance,
    showGroundTraffic,
    showAirborneTraffic,
    searchQuery,
    filterAirportTraffic,
    isOrbitModeWithoutAirport
  ])

  // Set up render loop to update labels every frame
  useEffect(() => {
    if (!viewer) return

    const removeListener = viewer.scene.postRender.addEventListener(updateLabels)

    return () => {
      removeListener()
    }
  }, [viewer, updateLabels])
}
