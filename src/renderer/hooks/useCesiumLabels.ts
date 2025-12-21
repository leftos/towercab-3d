import { useEffect, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { calculateDistanceNM } from '../utils/interpolation'

export type DatablockMode = 'none' | 'full' | 'airline'

interface UseCesiumLabelsParams {
  viewer: Cesium.Viewer | null
  babylonOverlay: any | null  // BabylonOverlay instance
  interpolatedAircraft: Map<string, InterpolatedAircraftState>
  datablockMode: DatablockMode
  viewMode: ViewMode
  followingCallsign: string | null
  currentAirportIcao: string | null
  airportElevationFeet: number
  groundElevationMeters: number
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
    airportElevationFeet,
    groundElevationMeters,
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
      labelPosition: Cesium.Cartesian3 | null
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
      const altitudeMeters = aircraft.interpolatedAltitude
      const isAirborne = altitudeMeters > groundElevationMeters + 5

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
          const aglFeet = aircraft.interpolatedAltitude - airportElevationFeet
          const isAirborneCheck = aglFeet > 200
          if (isAirborneCheck && !showAirborneTraffic) {
            showDatablock = false
          }
          if (!isAirborneCheck && !showGroundTraffic) {
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
        const dataLine = isAirborne
          ? `${Math.round(aircraft.interpolatedAltitude / 100).toString().padStart(3, '0')} ${speedTens}`
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

      // Calculate positions
      const groundLevel = groundElevationMeters + 0.5
      const heightAboveEllipsoid = isAirborne
        ? altitudeMeters
        : Math.max(groundLevel, altitudeMeters)

      const cesiumPosition = Cesium.Cartesian3.fromDegrees(
        aircraft.interpolatedLongitude,
        aircraft.interpolatedLatitude,
        heightAboveEllipsoid
      )

      // Calculate label attachment point (top of aircraft model bounding box)
      const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType)
      const baseModelHeight = modelInfo.dimensions.wingspan / 3
      const viewModeScale = viewMode === 'topdown' ? 0.5 : 1.0
      const labelAttachmentHeight = heightAboveEllipsoid + (baseModelHeight * viewModeScale)

      const labelPosition = Cesium.Cartesian3.fromDegrees(
        aircraft.interpolatedLongitude,
        aircraft.interpolatedLatitude,
        labelAttachmentHeight
      )

      const altitudeMetersAGL = aircraft.interpolatedAltitude - groundElevationMeters
      const distanceMeters = distance * 1852 // NM to meters

      aircraftData.push({
        callsign: aircraft.callsign,
        labelText,
        labelColor: babylonColor,
        cesiumPosition,
        labelPosition,
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
      if (!data.cesiumPosition || !data.labelPosition) continue

      // Check weather visibility - hide datablocks obscured by clouds or beyond visibility range
      if (!data.isFollowed && !babylonOverlay.isDatablockVisibleByWeather(
        cameraAltitudeAGL,
        data.altitudeMetersAGL,
        data.distanceMeters
      )) {
        continue // Skip this aircraft - datablock hidden by weather
      }

      const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, data.labelPosition)
      if (!windowPos) continue

      const screenPos = { x: windowPos.x, y: windowPos.y }

      // Default offset: top-left of cone
      let offsetX = -labelWidth - labelGap
      let offsetY = -labelHeight - labelGap

      // Check for overlap with cone itself
      const labelLeft = screenPos.x + offsetX
      const labelTop = screenPos.y + offsetY
      const labelRight = labelLeft + labelWidth
      const labelBottom = labelTop + labelHeight

      if (labelRight > screenPos.x - coneRadius && labelLeft < screenPos.x + coneRadius &&
          labelBottom > screenPos.y - coneRadius && labelTop < screenPos.y + coneRadius) {
        offsetX = -labelWidth - coneRadius - labelGap
        offsetY = -labelHeight - coneRadius - labelGap
      }

      // Check for overlap with other labels
      for (const existing of labelPositions) {
        const existingLeft = existing.labelX
        const existingTop = existing.labelY
        const existingRight = existingLeft + labelWidth
        const existingBottom = existingTop + labelHeight

        const newLabelX = screenPos.x + offsetX
        const newLabelY = screenPos.y + offsetY

        if (newLabelX < existingRight + 5 && newLabelX + labelWidth > existingLeft - 5 &&
            newLabelY < existingBottom + 5 && newLabelY + labelHeight > existingTop - 5) {
          // Try alternative positions
          const alternatives = [
            { x: labelGap, y: -labelHeight - labelGap },
            { x: -labelWidth - labelGap, y: labelGap },
            { x: labelGap, y: labelGap },
            { x: -labelWidth - labelGap, y: -labelHeight - labelGap - 30 },
            { x: labelGap + 30, y: -labelHeight - labelGap },
          ]

          for (const alt of alternatives) {
            const testX = screenPos.x + alt.x
            const testY = screenPos.y + alt.y
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
              break
            }
          }
        }
      }

      labelPositions.push({
        callsign: data.callsign,
        coneX: screenPos.x,
        coneY: screenPos.y,
        labelX: screenPos.x + offsetX,
        labelY: screenPos.y + offsetY,
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
    airportElevationFeet,
    groundElevationMeters,
    towerHeight,
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
