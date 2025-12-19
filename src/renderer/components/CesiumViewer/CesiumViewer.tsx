import { useEffect, useRef, useCallback, useState } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCameraStore } from '../../stores/cameraStore'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useCesiumCamera } from '../../hooks/useCesiumCamera'
import { useBabylonOverlay } from '../../hooks/useBabylonOverlay'
import { getTowerPosition } from '../../utils/towerHeight'
import { calculateDistanceNM } from '../../utils/interpolation'
import './CesiumViewer.css'

// Import Cesium CSS
import 'cesium/Build/Cesium/Widgets/widgets.css'

function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const babylonCanvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const rootNodeSetupRef = useRef(false)

  // Use state for viewer and canvas to trigger re-renders when they're ready
  const [cesiumViewer, setCesiumViewer] = useState<Cesium.Viewer | null>(null)
  const [babylonCanvas, setBabylonCanvas] = useState<HTMLCanvasElement | null>(null)
  const babylonCanvasCreatedRef = useRef(false)

  // Store state
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)
  const maxAircraftDisplay = useSettingsStore((state) => state.maxAircraftDisplay)
  const showGroundTraffic = useSettingsStore((state) => state.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.showAirborneTraffic)

  // Camera store for follow highlighting and view mode
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const followMode = useCameraStore((state) => state.followMode)
  const viewMode = useCameraStore((state) => state.viewMode)

  // Get interpolated aircraft states
  const interpolatedAircraft = useAircraftInterpolation()

  // Initialize camera controls (this hook manages all camera behavior)
  // Pass interpolated aircraft for smooth follow tracking
  useCesiumCamera(cesiumViewer, interpolatedAircraft)

  // Initialize Babylon.js overlay for 3D aircraft rendering
  // Uses state variables to ensure re-render when viewer/canvas are ready
  const babylonOverlay = useBabylonOverlay({
    cesiumViewer,
    canvas: babylonCanvas
  })

  // Create Babylon canvas after Cesium viewer is ready
  useEffect(() => {
    if (!cesiumViewer || !containerRef.current || babylonCanvasCreatedRef.current) return

    // Create canvas element programmatically
    const canvas = document.createElement('canvas')
    canvas.className = 'babylon-overlay-canvas'
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.pointerEvents = 'none'
    canvas.style.zIndex = '10'

    // Add canvas to the Cesium viewer's container
    containerRef.current.appendChild(canvas)
    babylonCanvasCreatedRef.current = true
    babylonCanvasRef.current = canvas
    setBabylonCanvas(canvas)

    return () => {
      if (canvas.parentNode) {
        canvas.parentNode.removeChild(canvas)
      }
      babylonCanvasCreatedRef.current = false
    }
  }, [cesiumViewer])

  // Initialize Cesium viewer
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    // Set Ion access token
    if (cesiumIonToken) {
      Cesium.Ion.defaultAccessToken = cesiumIonToken
    }

    // Create viewer with default terrain and imagery
    const viewer = new Cesium.Viewer(containerRef.current, {
      terrain: Cesium.Terrain.fromWorldTerrain(),
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      navigationInstructionsInitiallyVisible: false,
      creditContainer: document.createElement('div'), // Hide credits
      msaaSamples: 4
    })

    // Configure scene
    viewer.scene.globe.enableLighting = true
    viewer.scene.fog.enabled = true
    viewer.scene.globe.depthTestAgainstTerrain = true

    viewerRef.current = viewer
    setCesiumViewer(viewer)

    // Cleanup on unmount
    return () => {
      viewer.destroy()
      viewerRef.current = null
      setCesiumViewer(null)
    }
  }, [cesiumIonToken])

  // Setup Babylon root node when airport changes OR when in orbit mode without airport
  useEffect(() => {
    if (!babylonOverlay.sceneReady) return

    // If we have an airport, use tower position as root
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      babylonOverlay.setupRootNode(towerPos.latitude, towerPos.longitude, towerPos.height)
      rootNodeSetupRef.current = true
      return
    }

    // If in orbit mode following an aircraft without airport, use aircraft position as root
    if (followMode === 'orbit' && followingCallsign && interpolatedAircraft.size > 0) {
      const followedAircraft = interpolatedAircraft.get(followingCallsign)
      if (followedAircraft) {
        const altitudeMeters = followedAircraft.interpolatedAltitude * 0.3048
        babylonOverlay.setupRootNode(
          followedAircraft.interpolatedLatitude,
          followedAircraft.interpolatedLongitude,
          altitudeMeters
        )
        rootNodeSetupRef.current = true
      }
    }
  }, [currentAirport, towerHeight, babylonOverlay.sceneReady, babylonOverlay.setupRootNode, followMode, followingCallsign, interpolatedAircraft])

  // Update aircraft entities
  const updateAircraftEntities = useCallback(() => {
    if (!cesiumViewer) return

    // Determine the reference point for distance calculations
    // In orbit mode, use the followed aircraft; otherwise use the tower
    let refLat: number
    let refLon: number
    let refElevationMeters = 0
    let isOrbitModeWithoutAirport = false

    if (followMode === 'orbit' && followingCallsign) {
      const followedAircraft = interpolatedAircraft.get(followingCallsign)
      if (followedAircraft) {
        refLat = followedAircraft.interpolatedLatitude
        refLon = followedAircraft.interpolatedLongitude
        refElevationMeters = followedAircraft.interpolatedAltitude * 0.3048
        isOrbitModeWithoutAirport = !currentAirport
      } else if (currentAirport) {
        const towerPos = getTowerPosition(currentAirport, towerHeight)
        refLat = towerPos.latitude
        refLon = towerPos.longitude
        refElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
      } else {
        return // No reference point available
      }
    } else if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      refLat = towerPos.latitude
      refLon = towerPos.longitude
      refElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
    } else {
      return // Need either an airport or orbit mode with a followed aircraft
    }

    const seenCallsigns = new Set<string>()

    // Sort aircraft by distance and limit count
    const sortedAircraft = [...interpolatedAircraft.values()]
      .map((aircraft) => ({
        ...aircraft,
        distance: calculateDistanceNM(
          refLat,
          refLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude
        )
      }))
      .filter((aircraft) => {
        // Filter by distance
        if (aircraft.distance > labelVisibilityDistance) return false

        // Filter by traffic type - use interpolated altitude for smooth transitions
        // In orbit mode without airport, show all traffic types
        if (!isOrbitModeWithoutAirport) {
          const isAirborne = aircraft.interpolatedAltitude > 500
          if (isAirborne && !showAirborneTraffic) return false
          if (!isAirborne && !showGroundTraffic) return false
        }

        return true
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, maxAircraftDisplay)

    // Get ground elevation for aircraft positioning
    const groundElevationMeters = currentAirport?.elevation
      ? currentAirport.elevation * 0.3048
      : (isOrbitModeWithoutAirport ? 0 : refElevationMeters)

    // First pass: Update all aircraft mesh positions
    const aircraftData: Array<{
      callsign: string
      isAirborne: boolean
      isFollowed: boolean
      labelText: string
      color: { r: number; g: number; b: number }
    }> = []

    for (const aircraft of sortedAircraft) {
      seenCallsigns.add(aircraft.callsign)

      // Use INTERPOLATED altitude for airborne check to ensure smooth transitions
      const isAirborne = aircraft.interpolatedAltitude > 500
      const isFollowed = followingCallsign === aircraft.callsign

      // Calculate altitude in meters
      const altitudeMeters = aircraft.interpolatedAltitude * 0.3048

      // Calculate height above ellipsoid
      // Use Math.max to ensure aircraft never go below ground, but can smoothly climb
      // This prevents jumps when transitioning from ground to airborne
      const groundLevel = groundElevationMeters + 0.5
      const heightAboveEllipsoid = isAirborne
        ? altitudeMeters
        : Math.max(groundLevel, altitudeMeters)

      // Format datablock text
      const type = aircraft.aircraftType || '????'
      const speedTens = Math.round(aircraft.interpolatedGroundspeed / 10).toString().padStart(2, '0')
      const dataLine = isAirborne
        ? `${Math.round(aircraft.interpolatedAltitude / 100).toString().padStart(3, '0')} ${speedTens}`
        : speedTens
      const labelText = `${aircraft.callsign}\n${type} ${dataLine}`

      // Get color
      let babylonColor: { r: number; g: number; b: number }
      if (isFollowed) {
        babylonColor = { r: 0, g: 1, b: 1 }
      } else if (!aircraft.isInterpolated) {
        babylonColor = { r: 1, g: 1, b: 0 }
      } else if (isAirborne) {
        babylonColor = { r: 0, g: 1, b: 0 }
      } else {
        babylonColor = { r: 1, g: 0.65, b: 0 }
      }

      // Update mesh position - scale cones 3.5x bigger in topdown view
      const viewModeScale = viewMode === 'topdown' ? 3.5 : 1.0
      if (rootNodeSetupRef.current) {
        babylonOverlay.updateAircraftMesh(
          aircraft.callsign,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          heightAboveEllipsoid,
          groundElevationMeters,
          aircraft.interpolatedHeading, // Use interpolated heading for smooth cone rotation
          babylonColor,
          isFollowed,
          labelText,
          viewModeScale
        )
      }

      aircraftData.push({ callsign: aircraft.callsign, isAirborne, isFollowed, labelText, color: babylonColor })
    }

    // Second pass: Calculate label offsets with overlap detection
    const labelWidth = 90  // Approximate label width
    const labelHeight = 36 // Approximate label height
    // In topdown view, cones are bigger so they have a larger screen radius
    const coneRadius = viewMode === 'topdown' ? 15 : 15
    // Use smaller gaps in topdown view for tighter positioning
    const labelGap = viewMode === 'topdown' ? 3 : 10

    // Collect screen positions and calculate offsets
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
      const screenPos = babylonOverlay.getConeScreenPosition(data.callsign)
      if (!screenPos || !screenPos.visible) continue

      // Default offset: top-left of cone
      let offsetX = -labelWidth - labelGap
      let offsetY = -labelHeight - labelGap

      // Check for overlap with cone itself - if label would overlap cone, move it further
      const labelLeft = screenPos.x + offsetX
      const labelTop = screenPos.y + offsetY
      const labelRight = labelLeft + labelWidth
      const labelBottom = labelTop + labelHeight

      // If label overlaps cone area, push it further out
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

        // Check if labels overlap
        if (newLabelX < existingRight + 5 && newLabelX + labelWidth > existingLeft - 5 &&
            newLabelY < existingBottom + 5 && newLabelY + labelHeight > existingTop - 5) {
          // Try different positions: top-right, bottom-left, bottom-right
          const alternatives = [
            { x: labelGap, y: -labelHeight - labelGap },                    // top-right
            { x: -labelWidth - labelGap, y: labelGap },                     // bottom-left
            { x: labelGap, y: labelGap },                                   // bottom-right
            { x: -labelWidth - labelGap, y: -labelHeight - labelGap - 30 }, // further top-left
            { x: labelGap + 30, y: -labelHeight - labelGap },               // further top-right
          ]

          for (const alt of alternatives) {
            const testX = screenPos.x + alt.x
            const testY = screenPos.y + alt.y
            let overlaps = false

            // Check against all existing labels
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
      babylonOverlay.updateLeaderLine(pos.callsign, pos.offsetX, pos.offsetY)
    }

    // Clean up any Babylon meshes that are no longer in the visible set
    const babylonCallsigns = babylonOverlay.getAircraftCallsigns()
    for (const callsign of babylonCallsigns) {
      if (!seenCallsigns.has(callsign)) {
        babylonOverlay.removeAircraftMesh(callsign)
      }
    }
  }, [
    cesiumViewer,
    interpolatedAircraft,
    currentAirport,
    towerHeight,
    labelVisibilityDistance,
    maxAircraftDisplay,
    showGroundTraffic,
    showAirborneTraffic,
    followingCallsign,
    followMode,
    babylonOverlay,
    viewMode
  ])

  // Update aircraft on each render frame
  useEffect(() => {
    if (!cesiumViewer) return

    const removeListener = cesiumViewer.scene.postRender.addEventListener(() => {
      // IMPORTANT: Sync camera FIRST so label projections use current camera position
      babylonOverlay.syncCamera()
      // Then update aircraft positions and labels
      updateAircraftEntities()
      // Finally render the Babylon scene
      babylonOverlay.render()
    })

    return () => {
      removeListener()
    }
  }, [cesiumViewer, updateAircraftEntities, babylonOverlay])

  return (
    <div className="cesium-viewer-container" ref={containerRef} />
  )
}

export default CesiumViewer
