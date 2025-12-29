import { useEffect, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { calculateDistanceNM } from '../utils/interpolation'
import { calculateDatablockOffset } from '../utils/screenProjection'
import { useDatablockPositionStore } from '../stores/datablockPositionStore'
import { useViewportStore } from '../stores/viewportStore'
import { useSettingsStore } from '../stores/settingsStore'
import { GROUNDSPEED_THRESHOLD_KNOTS, DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER } from '../constants/rendering'
import { filterAircraftForRendering } from './useRenderCulling'

export type DatablockMode = 'none' | 'full' | 'airline'

interface BabylonOverlay {
  updateAircraftLabel: (callsign: string, text: string, r: number, g: number, b: number) => void
  hideAllLabels: () => void
  updateLeaderLine: (callsign: string, aircraftX: number, aircraftY: number, offsetX: number, offsetY: number) => void
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
 * - **Default position**: Top-left of aircraft model
 * - **Model overlap check**: Move label further if it overlaps aircraft
 * - **Label overlap check**: Try 5 alternative positions (top-right, bottom-left, etc.)
 * - **Leader lines**: Drawn from aircraft position to label corner
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
    terrainOffset: _terrainOffset,
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
    groundAircraftTerrain: _groundAircraftTerrain
  } = params

  // Update labels
  const updateLabels = useCallback(() => {
    if (!viewer || !babylonOverlay || !refLat || !refLon || !refAltitudeFeet) return

    // Apply render culling: filter by distance from camera and max aircraft limit
    // This runs every frame to keep the closest aircraft visible as camera moves
    const { filteredAircraft } = filterAircraftForRendering({
      viewer,
      interpolatedAircraft,
      alwaysInclude: followingCallsign
    })

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

    // Iterate over culled/filtered aircraft (closest to camera, up to max limit)
    for (const aircraft of filteredAircraft.values()) {
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
        // Convert altitude to feet for FL display (METERS → FEET), clamp to 0 minimum
        const altitudeFeet = Math.max(0, aircraft.interpolatedAltitude / 0.3048)
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

      // Calculate positions using interpolated altitude (already terrain-corrected)
      // This ensures labels point to the same position where models are rendered
      const heightAboveEllipsoid = aircraft.interpolatedAltitude

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
    const modelRadius = viewMode === 'topdown' ? 15 : 15
    // Leader distance setting: 1=short, 2=normal (default), 3=medium, 4=long, 5=very long
    const leaderDistance = useSettingsStore.getState().aircraft.leaderDistance ?? 2
    const labelGap = viewMode === 'topdown' ? leaderDistance * 10 : leaderDistance * 10

    const labelPositions: Array<{
      callsign: string
      aircraftX: number
      aircraftY: number
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

      // Project aircraft position to screen (base/center of aircraft)
      const aircraftWindowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, data.cesiumPosition)
      if (!aircraftWindowPos) continue

      // Project a point slightly above the aircraft for leader line attachment
      // Scale height based on wingspan so small aircraft get shorter leader lines
      const leaderAttachHeightMeters = data.wingspanMeters * DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER
      const aircraftTopPosition = Cesium.Cartesian3.fromDegrees(
        data.longitude,
        data.latitude,
        data.heightAboveEllipsoid + leaderAttachHeightMeters
      )
      const aircraftTopWindowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, aircraftTopPosition)
      if (!aircraftTopWindowPos) continue

      // Fixed screen-space offsets for label positioning
      // These provide consistent label distance regardless of zoom level
      const viewModeScale = viewMode === 'topdown' ? 0.5 : 1.0
      const verticalOffsetPixels = 25 * viewModeScale
      const horizontalOffsetPixels = 25

      const aircraftScreenPos = { x: aircraftWindowPos.x, y: aircraftWindowPos.y }

      // Get custom position (per-aircraft override → global default)
      const datablockPositionStore = useDatablockPositionStore.getState()
      const viewportStore = useViewportStore.getState()
      const autoAvoidOverlaps = useSettingsStore.getState().aircraft.autoAvoidOverlaps ?? true

      const perAircraftPos = datablockPositionStore.getAircraftPosition(data.callsign)
      const globalPos = viewportStore.getDatablockPosition()
      const customPosition = perAircraftPos ?? globalPos

      // Calculate offset based on numpad-style position (1-9)
      const baseOffset = calculateDatablockOffset(customPosition, labelWidth, labelHeight, labelGap)
      let offsetX = baseOffset.offsetX
      let offsetY = baseOffset.offsetY

      // Determine row (0=bottom, 1=middle, 2=top) and column (0=left, 1=center, 2=right)
      const positionRow = Math.floor((customPosition - 1) / 3)
      const positionCol = (customPosition - 1) % 3

      // Calculate leader line endpoint based on position row
      // Top row (7,8,9): connect to top of aircraft
      // Middle row (4,6): connect to center of aircraft
      // Bottom row (1,2,3): connect to bottom of aircraft
      let leaderEndpointY: number
      if (positionRow === 2) {
        // Top - use top of aircraft bounding box
        leaderEndpointY = aircraftTopWindowPos.y
      } else if (positionRow === 1) {
        // Middle - use center between top and base
        leaderEndpointY = (aircraftTopWindowPos.y + aircraftWindowPos.y) / 2
      } else {
        // Bottom - use base of aircraft
        leaderEndpointY = aircraftWindowPos.y
      }

      // Screen position for label (includes base offsets)
      // Use leaderEndpointY as the reference Y so label offset is relative to
      // the same point the leader line connects to (top/middle/bottom of aircraft)
      const screenPos = {
        x: aircraftScreenPos.x + offsetX,
        y: leaderEndpointY + offsetY
      }

      // Only apply overlap detection if the setting is enabled
      if (autoAvoidOverlaps) {
        // Check for overlap with aircraft model (model is at aircraft position, not label attachment point)
        const labelLeft = screenPos.x
        const labelTop = screenPos.y
        const labelRight = labelLeft + labelWidth
        const labelBottom = labelTop + labelHeight

        if (labelRight > aircraftScreenPos.x - modelRadius && labelLeft < aircraftScreenPos.x + modelRadius &&
            labelBottom > aircraftScreenPos.y - modelRadius && labelTop < aircraftScreenPos.y + modelRadius) {
          // Adjust offsets to avoid model overlap while respecting user's chosen direction
          // Use position column/row to determine direction, not offset sign
          // col: 0=left, 1=center, 2=right; row: 0=bottom, 1=middle, 2=top

          // For horizontal adjustment based on column
          if (positionCol === 2) {
            // Right column - push right
            offsetX = modelRadius + labelGap
          } else if (positionCol === 0) {
            // Left column - push left
            offsetX = -labelWidth - modelRadius - labelGap - horizontalOffsetPixels
          } else {
            // Center column - maintain horizontal centering, just push out minimally
            offsetX = -labelWidth / 2
          }

          // For vertical adjustment based on row
          if (positionRow === 0) {
            // Bottom row - push down
            offsetY = modelRadius + labelGap
          } else if (positionRow === 2) {
            // Top row - push up
            offsetY = -labelHeight - modelRadius - labelGap - verticalOffsetPixels
          } else {
            // Middle row - maintain vertical centering
            offsetY = -labelHeight / 2
          }

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
            // Try alternative positions, prioritizing the user's chosen direction
            // Use position column/row: col 2=right, row 2=top
            const pushRight = positionCol === 2
            const pushUp = positionRow === 2

            // Build alternatives list based on user's preferred direction
            const rightX = labelGap
            const leftX = -labelWidth - labelGap - horizontalOffsetPixels
            const upY = -labelHeight - labelGap - verticalOffsetPixels
            const downY = labelGap
            const centerX = -labelWidth / 2
            const centerY = -labelHeight / 2

            // For centered positions, try to maintain centering in that axis
            let alternatives: Array<{ x: number; y: number }>
            if (positionCol === 1) {
              // Horizontally centered - prioritize maintaining centerX
              alternatives = [
                { x: centerX, y: pushUp ? upY - 30 : downY + 30 },
                { x: centerX, y: pushUp ? downY : upY },
                { x: rightX, y: pushUp ? upY : downY },
                { x: leftX, y: pushUp ? upY : downY },
              ]
            } else if (positionRow === 1) {
              // Vertically centered - prioritize maintaining centerY
              alternatives = [
                { x: pushRight ? rightX + 30 : leftX - 30, y: centerY },
                { x: pushRight ? leftX : rightX, y: centerY },
                { x: pushRight ? rightX : leftX, y: upY },
                { x: pushRight ? rightX : leftX, y: downY },
              ]
            } else {
              // Corner positions
              alternatives = pushRight
                ? [
                    { x: rightX, y: pushUp ? upY : downY },
                    { x: rightX + 30, y: pushUp ? upY : downY },
                    { x: rightX, y: pushUp ? downY : upY },
                    { x: leftX, y: pushUp ? upY : downY },
                    { x: leftX, y: pushUp ? downY : upY },
                  ]
                : [
                    { x: leftX, y: pushUp ? upY : downY },
                    { x: leftX - 30, y: pushUp ? upY : downY },
                    { x: leftX, y: pushUp ? downY : upY },
                    { x: rightX, y: pushUp ? upY : downY },
                    { x: rightX, y: pushUp ? downY : upY },
                  ]
            }

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
      }

      labelPositions.push({
        callsign: data.callsign,
        aircraftX: aircraftWindowPos.x, // Center X of aircraft
        aircraftY: leaderEndpointY, // Y based on position row (top/middle/bottom)
        labelX: screenPos.x,
        labelY: screenPos.y,
        offsetX,
        offsetY
      })
    }

    // Third pass: Update leader lines with calculated offsets
    for (const pos of labelPositions) {
      babylonOverlay.updateLeaderLine(pos.callsign, pos.aircraftX, pos.aircraftY, pos.offsetX, pos.offsetY)
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
