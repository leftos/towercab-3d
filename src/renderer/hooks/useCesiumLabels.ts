import { useEffect, useCallback } from 'react'
import * as Cesium from 'cesium'
import type { InterpolatedAircraftState } from '../types/vatsim'
import type { ViewMode } from '../types'
import { aircraftModelService } from '../services/AircraftModelService'
import { calculateDistanceNM } from '../utils/interpolation'
import { useDatablockPositionStore } from '../stores/datablockPositionStore'
import { useViewportStore } from '../stores/viewportStore'
import { useGlobalSettingsStore } from '../stores/globalSettingsStore'
import { GROUNDSPEED_THRESHOLD_KNOTS, DATABLOCK_LEADER_LINE_HEIGHT_MULTIPLIER } from '../constants/rendering'
import { filterAircraftForRendering } from './useRenderCulling'
import { layoutLabels, layoutLabelsSimple, type LabelAircraftData, type LayoutConfig } from '../utils/labelLayout'

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
      isAirborne: boolean
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

        // Ground label mode filter (gate clutter reduction)
        // Only applies to ground aircraft, not airborne
        if (showDatablock && !isAirborne) {
          const displaySettings = useGlobalSettingsStore.getState().display
          const groundLabelMode = displaySettings.groundLabelMode ?? 'all'
          const groundLabelMinSpeed = displaySettings.groundLabelMinSpeed ?? 2

          switch (groundLabelMode) {
            case 'none':
              // Hide all ground labels
              showDatablock = false
              break
            case 'activeOnly':
              // Only show actively taxiing aircraft (> 5 kts)
              if (aircraft.interpolatedGroundspeed < 5) {
                showDatablock = false
              }
              break
            case 'moving':
              // Only show aircraft above minimum speed
              if (aircraft.interpolatedGroundspeed < groundLabelMinSpeed) {
                showDatablock = false
              }
              break
            // 'all' - show all ground labels (default behavior)
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
        isAirborne,
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

    // Second pass: Project aircraft to screen and prepare for layout algorithm
    const labelWidth = 90
    const labelHeight = 36
    const modelRadius = viewMode === 'topdown' ? 15 : 15
    // Leader distance setting: 4px per unit distance
    // On mobile (< 1200px width), scale down leader lines to appear proportional
    const leaderDistance = useGlobalSettingsStore.getState().display.leaderDistance ?? 2
    const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 1920
    const screenHeight = typeof window !== 'undefined' ? window.innerHeight : 1080
    const mobileScale = screenWidth < 1200 ? 0.6 : 1.0  // 60% on mobile for proportional appearance
    const labelGap = Math.round(leaderDistance * 10 * mobileScale)

    const autoAvoidOverlaps = useGlobalSettingsStore.getState().display.autoAvoidOverlaps ?? true
    const datablockPositionStore = useDatablockPositionStore.getState()
    const viewportStore = useViewportStore.getState()
    const globalPos = viewportStore.getDatablockPosition()

    // Build data for layout algorithm
    const labelAircraftData: LabelAircraftData[] = []

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

      // Get custom position (per-aircraft override → global default)
      const perAircraftPos = datablockPositionStore.getAircraftPosition(data.callsign)
      const preferredPosition = perAircraftPos ?? globalPos

      // Calculate leader line Y attachment point based on position row
      const positionRow = Math.floor((preferredPosition - 1) / 3)
      let aircraftScreenY: number
      if (positionRow === 2) {
        // Top row - use top of aircraft bounding box
        aircraftScreenY = aircraftTopWindowPos.y
      } else if (positionRow === 1) {
        // Middle row - use center
        aircraftScreenY = (aircraftTopWindowPos.y + aircraftWindowPos.y) / 2
      } else {
        // Bottom row - use base
        aircraftScreenY = aircraftWindowPos.y
      }

      labelAircraftData.push({
        callsign: data.callsign,
        aircraftScreenX: aircraftWindowPos.x,
        aircraftScreenY,
        modelRadius,
        preferredPosition,
        hasCustomPosition: perAircraftPos !== undefined,
        isFollowed: data.isFollowed,
        isAirborne: data.isAirborne,
        distanceMeters: data.distanceMeters
      })
    }

    // Layout configuration
    const layoutConfig: LayoutConfig = {
      labelWidth,
      labelHeight,
      labelGap,
      labelMargin: 3, // Small margin between labels
      screenWidth,
      screenHeight
    }

    // Run layout algorithm
    const labelPositions = autoAvoidOverlaps
      ? layoutLabels(labelAircraftData, layoutConfig)
      : layoutLabelsSimple(labelAircraftData, layoutConfig)

    // Update leader lines with calculated offsets
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
