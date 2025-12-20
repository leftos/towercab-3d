import { useEffect, useRef, useCallback, useState } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCameraStore } from '../../stores/cameraStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useCesiumCamera } from '../../hooks/useCesiumCamera'
import { useBabylonOverlay, getMemoryCounters } from '../../hooks/useBabylonOverlay'
import { getTowerPosition } from '../../utils/towerHeight'
import {
  calculateDistanceNM,
  createPropellerState,
  updatePropellerState,
  getPropellerAnimationTime,
  type PropellerState
} from '../../utils/interpolation'
import { getServiceWorkerCacheStats } from '../../utils/serviceWorkerRegistration'
import './CesiumViewer.css'

// Import Cesium CSS
import 'cesium/Build/Cesium/Widgets/widgets.css'

// Maps terrain quality (1-5) to Cesium's maximumScreenSpaceError
// Lower error = higher quality but more tiles to load
function getScreenSpaceError(quality: number): number {
  const qualityMap: Record<number, number> = {
    1: 16,  // Low - fast loading, blurry at distance
    2: 8,   // Medium - balanced
    3: 4,   // High - good quality
    4: 2,   // Very High - excellent quality (Cesium default)
    5: 1    // Ultra - maximum quality, slower
  }
  return qualityMap[quality] ?? 4
}

// Cone pool size - pre-create this many cone entities at init time
const CONE_POOL_SIZE = 100

function CesiumViewer() {
  const containerRef = useRef<HTMLDivElement>(null)
  const babylonCanvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const rootNodeSetupRef = useRef(false)

  // Terrain offset: difference between ellipsoidal height and MSL elevation
  // This corrects for geoid undulation (varies by location, e.g., -30m at Boston)
  const terrainOffsetRef = useRef<number>(0)
  const terrainOffsetReadyRef = useRef<boolean>(false)

  // Cone pool: maps pool index to callsign (or null if unused)
  const conePoolAssignmentsRef = useRef<Map<number, string | null>>(new Map())
  const conePoolReadyRef = useRef<boolean>(false)

  // Propeller animation state: maps callsign to propeller state
  const propellerStatesRef = useRef<Map<string, PropellerState>>(new Map())
  // Track which pool models have been configured for manual animation control
  const modelAnimationsConfiguredRef = useRef<Set<number>>(new Set())

  // Use state for viewer and canvas to trigger re-renders when they're ready
  const [cesiumViewer, setCesiumViewer] = useState<Cesium.Viewer | null>(null)
  const [babylonCanvas, setBabylonCanvas] = useState<HTMLCanvasElement | null>(null)
  const [buildingsTileset, setBuildingsTileset] = useState<Cesium.Cesium3DTileset | null>(null)
  const babylonCanvasCreatedRef = useRef(false)

  // Store state
  const cesiumIonToken = useSettingsStore((state) => state.cesiumIonToken)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)
  const maxAircraftDisplay = useSettingsStore((state) => state.maxAircraftDisplay)
  const showGroundTraffic = useSettingsStore((state) => state.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.showAirborneTraffic)
  const datablockMode = useSettingsStore((state) => state.datablockMode)
  const terrainQuality = useSettingsStore((state) => state.terrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.show3DBuildings)
  const timeMode = useSettingsStore((state) => state.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.fixedTimeHour)
  const inMemoryTileCacheSize = useSettingsStore((state) => state.inMemoryTileCacheSize)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const showFog = useSettingsStore((state) => state.showFog)

  // Weather store for fog effects
  const fogDensity = useWeatherStore((state) => state.fogDensity)

  // Camera store for follow highlighting and view mode
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const followMode = useCameraStore((state) => state.followMode)
  const viewMode = useCameraStore((state) => state.viewMode)
  const topdownAltitude = useCameraStore((state) => state.topdownAltitude)

  // VATSIM store for setting reference position
  const setReferencePosition = useVatsimStore((state) => state.setReferencePosition)
  const totalPilotsFromApi = useVatsimStore((state) => state.totalPilotsFromApi)
  const pilotsFilteredByDistance = useVatsimStore((state) => state.pilotsFilteredByDistance)

  // Get interpolated aircraft states
  const interpolatedAircraft = useAircraftInterpolation()

  // Initialize camera controls (this hook manages all camera behavior)
  // Pass interpolated aircraft for smooth follow tracking
  useCesiumCamera(cesiumViewer, interpolatedAircraft)

  // Initialize Babylon.js overlay for labels and leader lines
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


    // Enable shadows
    viewer.shadows = true
    viewer.shadowMap.softShadows = true
    viewer.shadowMap.size = 2048  // Higher resolution shadows
    viewer.shadowMap.maximumDistance = 10000.0  // Shadow distance in meters
    viewer.terrainShadows = Cesium.ShadowMode.ENABLED  // Terrain casts and receives shadows

    // Enable clock animation for model animations (propellers, etc.)
    viewer.clock.shouldAnimate = true

    // In-memory tile cache - configurable via settings
    // Lower = less RAM usage, higher = smoother panning
    viewer.scene.globe.tileCacheSize = useSettingsStore.getState().inMemoryTileCacheSize

    // Preload nearby tiles for smoother camera movement
    viewer.scene.globe.preloadAncestors = true
    viewer.scene.globe.preloadSiblings = true

    // NOTE: Custom tile caching disabled - it breaks Cesium's request throttling
    // by always returning Promises instead of undefined for deferred requests.
    // This caused runaway tile loading and memory exhaustion.
    // Cesium's built-in tile caching (tileCacheSize) is sufficient for in-memory caching.
    // For persistent disk caching, a Service Worker approach would be needed.

    // Suppress verbose tile loading errors (transient, Cesium retries automatically)
    const imageryLayers = viewer.imageryLayers
    if (imageryLayers.length > 0) {
      const baseLayer = imageryLayers.get(0)
      const removeListener = baseLayer.readyEvent.addEventListener((provider) => {
        removeListener()
        if (!viewer.isDestroyed() && provider.errorEvent) {
          provider.errorEvent.addEventListener(() => {
            // Silently ignore - these are usually transient network issues
          })
        }
      })
    }

    viewerRef.current = viewer
    setCesiumViewer(viewer)

    // Create aircraft model pool - all models start hidden
    // Using Cesium's sample aircraft model from GitHub
    const aircraftModelUrl = 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/CesiumAir/Cesium_Air.glb'
    const defaultPos = Cesium.Cartesian3.fromDegrees(0, 0, 0)
    const defaultHpr = new Cesium.HeadingPitchRoll(0, 0, 0)
    const defaultOrientation = Cesium.Transforms.headingPitchRollQuaternion(defaultPos, defaultHpr)

    for (let i = 0; i < CONE_POOL_SIZE; i++) {
      viewer.entities.add({
        id: `cone_pool_${i}`,
        show: false, // Start hidden
        position: defaultPos,
        orientation: defaultOrientation,
        model: {
          uri: aircraftModelUrl,
          minimumPixelSize: 24,
          maximumScale: 50,
          scale: 2,
          runAnimations: false, // Disabled - we manually control animation via animationTime callback
          shadows: Cesium.ShadowMode.ENABLED
        }
      })
      conePoolAssignmentsRef.current.set(i, null)
    }
    conePoolReadyRef.current = true
    console.log(`Created aircraft model pool with ${CONE_POOL_SIZE} entities`)

    // Cleanup on unmount
    return () => {
      viewer.destroy()
      viewerRef.current = null
      setCesiumViewer(null)
    }
  }, [cesiumIonToken])

  // Clear old IndexedDB tile cache on startup (we now use Service Worker caching)
  useEffect(() => {
    // Clear any residual data from the old IndexedDB cache
    if ('indexedDB' in window) {
      indexedDB.deleteDatabase('cesium-tile-cache')
      console.log('Old IndexedDB tile cache deleted')
    }
  }, [])

  // Update in-memory tile cache size when setting changes
  useEffect(() => {
    if (!cesiumViewer) return
    cesiumViewer.scene.globe.tileCacheSize = inMemoryTileCacheSize
  }, [cesiumViewer, inMemoryTileCacheSize])

  // Update fog based on weather effects and METAR visibility
  useEffect(() => {
    if (!cesiumViewer) return

    const shouldShowFog = showWeatherEffects && showFog
    cesiumViewer.scene.fog.enabled = shouldShowFog

    if (shouldShowFog && fogDensity > 0) {
      // Apply fog density from METAR visibility
      // fogDensity ranges from ~0.015 (1/4 SM) to ~0 (10+ SM)
      cesiumViewer.scene.fog.density = fogDensity

      // visualDensityScalar controls the visual appearance of fog (default 0.15)
      // Scale it based on fog density for more dramatic effect in low visibility
      // Range from 0.15 (light fog) to 1.0 (very dense fog)
      const visualScalar = Math.min(1.0, 0.15 + (fogDensity / 0.015) * 0.85)
      cesiumViewer.scene.fog.visualDensityScalar = visualScalar

      // Increase screen space error factor in fog for better performance
      cesiumViewer.scene.fog.screenSpaceErrorFactor = 2.0

      // Prevent fog from being too dark
      cesiumViewer.scene.fog.minimumBrightness = 0.1
    } else {
      // Reset to default fog settings when no weather effects
      cesiumViewer.scene.fog.density = 0.0006 // Cesium default
      cesiumViewer.scene.fog.visualDensityScalar = 0.15 // Cesium default
      cesiumViewer.scene.fog.screenSpaceErrorFactor = 2.0
      cesiumViewer.scene.fog.minimumBrightness = 0.03 // Cesium default
    }
  }, [cesiumViewer, showWeatherEffects, showFog, fogDensity])

  // Track the last terrain quality to detect actual user changes vs initial mount
  const lastTerrainQualityRef = useRef<number | null>(null)
  const qualityChangeInProgressRef = useRef(false)

  // Update terrain quality when setting changes - only flush cache on actual user changes
  useEffect(() => {
    if (!cesiumViewer || qualityChangeInProgressRef.current) return

    const newError = getScreenSpaceError(terrainQuality)

    // On first mount, just set the quality without flushing
    if (lastTerrainQualityRef.current === null) {
      cesiumViewer.scene.globe.maximumScreenSpaceError = newError
      lastTerrainQualityRef.current = terrainQuality
      return
    }

    // Only flush cache if the user actually changed the terrain quality setting
    if (lastTerrainQualityRef.current !== terrainQuality) {
      const oldError = getScreenSpaceError(lastTerrainQualityRef.current)
      const originalCacheSize = cesiumViewer.scene.globe.tileCacheSize

      qualityChangeInProgressRef.current = true
      console.log(`Terrain quality changing: SSE ${oldError} -> ${newError}, flushing tiles first...`)

      // CRITICAL: Evict tiles BEFORE changing quality to prevent memory spike
      // Step 1: Hide globe to stop new tile requests
      cesiumViewer.scene.globe.show = false

      // Step 2: Aggressively reduce cache to force eviction
      cesiumViewer.scene.globe.tileCacheSize = 1

      // Step 3: Force multiple render cycles to actually evict tiles
      // Cesium only evicts tiles during render cycles, so we must render
      let renderCount = 0
      const forceEviction = () => {
        if (cesiumViewer.isDestroyed()) return

        // Force a render to trigger tile eviction
        cesiumViewer.scene.render()
        renderCount++

        if (renderCount < 10) {
          // Continue forcing renders to ensure tiles are evicted
          requestAnimationFrame(forceEviction)
        } else {
          // Step 4: After eviction, change quality and restore
          // Now change the quality setting (no old tiles to compete with)
          cesiumViewer.scene.globe.maximumScreenSpaceError = newError
          lastTerrainQualityRef.current = terrainQuality

          // Restore cache size
          cesiumViewer.scene.globe.tileCacheSize = originalCacheSize

          // Show globe again - will load fresh tiles at new quality
          cesiumViewer.scene.globe.show = true

          qualityChangeInProgressRef.current = false
          console.log(`Terrain quality changed to SSE ${newError}, cache restored after ${renderCount} eviction cycles`)
        }
      }

      // Start the eviction process
      requestAnimationFrame(forceEviction)
    }
  }, [cesiumViewer, terrainQuality])

  // Time of day control (real time vs fixed time)
  useEffect(() => {
    if (!cesiumViewer) return

    if (timeMode === 'fixed' && currentAirport) {
      // Calculate the specified local time at the tower location
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      const now = new Date()

      // Start with UTC midnight of today
      const targetTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0))

      // Add the fixed hour in UTC, then adjust for longitude to get local time
      // Longitude / 15 gives hours offset from UTC (east is positive)
      const longitudeOffsetHours = towerPos.longitude / 15
      const utcHour = fixedTimeHour - longitudeOffsetHours
      targetTime.setTime(targetTime.getTime() + utcHour * 60 * 60 * 1000)

      cesiumViewer.clock.currentTime = Cesium.JulianDate.fromDate(targetTime)
      cesiumViewer.clock.shouldAnimate = false
    } else {
      // Real time mode - use current time and animate
      cesiumViewer.clock.currentTime = Cesium.JulianDate.now()
      cesiumViewer.clock.shouldAnimate = true
    }
  }, [cesiumViewer, timeMode, fixedTimeHour, currentAirport, towerHeight])

  // Manage OSM 3D Buildings tileset
  useEffect(() => {
    if (!cesiumViewer) return

    let currentTileset: Cesium.Cesium3DTileset | null = null
    let isCancelled = false

    const loadBuildings = async () => {
      if (show3DBuildings) {
        try {
          const tileset = await Cesium.createOsmBuildingsAsync()
          if (isCancelled) return

          // Memory optimization: minimize tile caching to reduce RAM usage
          tileset.cacheBytes = 0  // Don't cache tiles in memory (new API, replaces maximumMemoryUsage)
          tileset.maximumScreenSpaceError = 24  // Use lower quality tiles (default is 16)

          cesiumViewer.scene.primitives.add(tileset)
          currentTileset = tileset
          setBuildingsTileset(tileset)
        } catch (error) {
          console.error('Error loading OSM Buildings:', error)
        }
      }
    }

    loadBuildings()

    return () => {
      isCancelled = true
      if (currentTileset && cesiumViewer && !cesiumViewer.isDestroyed()) {
        cesiumViewer.scene.primitives.remove(currentTileset)
        setBuildingsTileset(null)
      }
    }
  }, [cesiumViewer, show3DBuildings])

  // Calculate terrain offset when airport changes
  // This corrects for the difference between MSL and ellipsoidal height
  useEffect(() => {
    if (!cesiumViewer || !currentAirport) {
      terrainOffsetReadyRef.current = false
      return
    }

    const towerPos = getTowerPosition(currentAirport, towerHeight)
    const groundElevationMsl = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0

    // Sample terrain to calculate offset between MSL elevation and actual terrain height
    if (cesiumViewer.terrainProvider) {
      const positions = [Cesium.Cartographic.fromDegrees(towerPos.longitude, towerPos.latitude)]
      Cesium.sampleTerrainMostDetailed(cesiumViewer.terrainProvider, positions).then((updatedPositions) => {
        const terrainHeight = updatedPositions[0].height
        terrainOffsetRef.current = terrainHeight - groundElevationMsl
        terrainOffsetReadyRef.current = true
      }).catch(() => {
        terrainOffsetRef.current = 0
        terrainOffsetReadyRef.current = true
      })
    } else {
      terrainOffsetReadyRef.current = true
    }
  }, [cesiumViewer, currentAirport, towerHeight])

  // Setup Babylon root node when airport changes OR when in orbit mode without airport
  // Also set reference position for VATSIM distance filtering
  useEffect(() => {
    if (!babylonOverlay.sceneReady) return

    // If we have an airport, use tower position as root
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      babylonOverlay.setupRootNode(towerPos.latitude, towerPos.longitude, towerPos.height)
      rootNodeSetupRef.current = true

      // Set reference position for VATSIM filtering - only store aircraft near tower
      setReferencePosition(towerPos.latitude, towerPos.longitude)
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

        // Set reference position to followed aircraft for VATSIM filtering
        setReferencePosition(followedAircraft.interpolatedLatitude, followedAircraft.interpolatedLongitude)
      }
    }
  }, [currentAirport, towerHeight, babylonOverlay.sceneReady, babylonOverlay.setupRootNode, followMode, followingCallsign, interpolatedAircraft, setReferencePosition])

  // Update aircraft entities
  const updateAircraftEntities = useCallback(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

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
        // Always include the followed aircraft regardless of distance
        if (aircraft.callsign === followingCallsign) return true

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
      cesiumPosition: Cesium.Cartesian3 | null
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

      // Format datablock text based on datablockMode setting
      let labelText = ''
      if (datablockMode !== 'none') {
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
        babylonColor = { r: 0, g: 1, b: 1 }
      } else if (!aircraft.isInterpolated) {
        babylonColor = { r: 1, g: 1, b: 0 }
      } else if (isAirborne) {
        babylonColor = { r: 0, g: 1, b: 0 }
      } else {
        babylonColor = { r: 1, g: 0.65, b: 0 }
      }

      // Update mesh position - scale cones dynamically in topdown view based on altitude
      // Scale proportionally with altitude to maintain visibility when zoomed out
      const referenceAltitude = 6000
      const baseTopdownScale = 1.0
      const viewModeScale = viewMode === 'topdown'
        ? baseTopdownScale * (topdownAltitude / referenceAltitude)
        : 1.0

      // Use model from pool - find or assign a pool slot for this aircraft
      if (conePoolReadyRef.current && terrainOffsetReadyRef.current) {
        // Calculate model position with terrain offset correction
        const modelHeight = heightAboveEllipsoid + terrainOffsetRef.current

        // Find existing pool slot for this callsign, or get an unused one
        let poolIndex = -1
        for (const [idx, assignedCallsign] of conePoolAssignmentsRef.current.entries()) {
          if (assignedCallsign === aircraft.callsign) {
            poolIndex = idx
            break
          }
        }
        if (poolIndex === -1) {
          // Find an unused slot
          for (const [idx, assignedCallsign] of conePoolAssignmentsRef.current.entries()) {
            if (assignedCallsign === null) {
              poolIndex = idx
              conePoolAssignmentsRef.current.set(idx, aircraft.callsign)
              break
            }
          }
        }

        if (poolIndex !== -1) {
          const modelEntity = viewer.entities.getById(`cone_pool_${poolIndex}`)
          if (modelEntity) {
            const position = Cesium.Cartesian3.fromDegrees(
              aircraft.interpolatedLongitude,
              aircraft.interpolatedLatitude,
              modelHeight
            )
            // Model heading: Cesium models typically face +X, so heading=0 means east
            // Subtract 90 to convert from compass heading (north=0) to model heading
            const hpr = new Cesium.HeadingPitchRoll(
              Cesium.Math.toRadians(aircraft.interpolatedHeading - 90),
              0,
              0
            )
            modelEntity.position = new Cesium.ConstantPositionProperty(position)
            modelEntity.orientation = new Cesium.ConstantProperty(
              Cesium.Transforms.headingPitchRollQuaternion(position, hpr)
            )

            // Update model scale and color based on view mode
            if (modelEntity.model) {
              modelEntity.model.scale = new Cesium.ConstantProperty(2 * viewModeScale)
              // White in topdown view for visibility, normal color in 3D
              if (viewMode === 'topdown') {
                modelEntity.model.color = new Cesium.ConstantProperty(Cesium.Color.WHITE)
                modelEntity.model.colorBlendMode = new Cesium.ConstantProperty(Cesium.ColorBlendMode.REPLACE)
              } else {
                modelEntity.model.color = undefined
                modelEntity.model.colorBlendMode = undefined
              }
            }

            // Update propeller animation based on groundspeed
            // Get or create propeller state for this aircraft
            let propState = propellerStatesRef.current.get(aircraft.callsign)
            if (!propState) {
              propState = createPropellerState()
              propellerStatesRef.current.set(aircraft.callsign, propState)
            }

            // Update propeller physics with inertia
            const newPropState = updatePropellerState(
              propState,
              aircraft.interpolatedGroundspeed,
              !isAirborne
            )
            propellerStatesRef.current.set(aircraft.callsign, newPropState)

            // Configure animation on the Model primitive if not already done
            // We need to access the underlying Model to control animation timing
            if (!modelAnimationsConfiguredRef.current.has(poolIndex)) {
              // Try multiple approaches to get the Model primitive
              // Approach 1: Internal _modelPrimitive property (common in recent Cesium versions)
              let modelPrimitive = (modelEntity as { _modelPrimitive?: Cesium.Model })._modelPrimitive

              // Approach 2: Search in scene primitives if approach 1 fails
              if (!modelPrimitive) {
                const primitives = viewer.scene.primitives
                for (let i = 0; i < primitives.length; i++) {
                  const primitive = primitives.get(i)
                  if (primitive instanceof Cesium.Model && (primitive as { id?: { id?: string } }).id?.id === modelEntity.id) {
                    modelPrimitive = primitive
                    break
                  }
                }
              }

              if (modelPrimitive && modelPrimitive.ready) {
                // Add animations with manual control via animationTime callback
                const animations = modelPrimitive.activeAnimations
                if (animations.length === 0) {
                  const propStateRef = { current: newPropState }
                  // Store reference for the callback to access
                  ;(modelEntity as { _propStateRef?: { current: PropellerState } })._propStateRef = propStateRef

                  animations.addAll({
                    loop: Cesium.ModelAnimationLoop.REPEAT,
                    animationTime: (duration: number) => {
                      // Get the current propeller state from the entity
                      const entity = modelEntity as { _propStateRef?: { current: PropellerState } }
                      const state = entity._propStateRef?.current
                      if (state) {
                        return getPropellerAnimationTime(state, duration)
                      }
                      return 0
                    }
                  })
                  modelAnimationsConfiguredRef.current.add(poolIndex)
                }
              }
            } else {
              // Update the propeller state reference for the animation callback
              const entity = modelEntity as { _propStateRef?: { current: PropellerState } }
              if (entity._propStateRef) {
                entity._propStateRef.current = newPropState
              }
            }

            // Show the model
            modelEntity.show = true
          }
        }
      }

      // Update Babylon overlay (for labels - cones will be hidden)
      // This depends on Babylon root node being set up
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

      // Store the Cesium position for screen projection
      const cesiumPosition = conePoolReadyRef.current && terrainOffsetReadyRef.current
        ? Cesium.Cartesian3.fromDegrees(
            aircraft.interpolatedLongitude,
            aircraft.interpolatedLatitude,
            heightAboveEllipsoid + terrainOffsetRef.current
          )
        : null

      aircraftData.push({ callsign: aircraft.callsign, isAirborne, isFollowed, labelText, color: babylonColor, cesiumPosition })
    }

    // Hide all labels first, then show only visible ones
    babylonOverlay.hideAllLabels()

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
      // Use Cesium's projection to get screen position (matches where model is rendered)
      if (!data.cesiumPosition) continue
      const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, data.cesiumPosition)
      if (!windowPos) continue

      // windowPos is in CSS pixels, use it directly as screen position
      const screenPos = { x: windowPos.x, y: windowPos.y }

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
      babylonOverlay.updateLeaderLine(pos.callsign, pos.coneX, pos.coneY, pos.offsetX, pos.offsetY)
    }

    // Clean up any Babylon meshes that are no longer in the visible set
    const babylonCallsigns = babylonOverlay.getAircraftCallsigns()
    for (const callsign of babylonCallsigns) {
      if (!seenCallsigns.has(callsign)) {
        babylonOverlay.removeAircraftMesh(callsign)
      }
    }

    // Clean up propeller states for aircraft no longer visible
    for (const callsign of propellerStatesRef.current.keys()) {
      if (!seenCallsigns.has(callsign)) {
        propellerStatesRef.current.delete(callsign)
      }
    }

    // Hide unused pool models and clean up references to prevent memory leaks
    for (const [idx, assignedCallsign] of conePoolAssignmentsRef.current.entries()) {
      if (assignedCallsign !== null && !seenCallsigns.has(assignedCallsign)) {
        // Release this slot and hide the model
        conePoolAssignmentsRef.current.set(idx, null)
        const modelEntity = viewer.entities.getById(`cone_pool_${idx}`)
        if (modelEntity) {
          modelEntity.show = false

          // CRITICAL: Clear the propeller state reference to break closure memory leak
          // The animation callback closure captures this reference
          const entityWithRef = modelEntity as { _propStateRef?: { current: PropellerState } }
          if (entityWithRef._propStateRef) {
            entityWithRef._propStateRef = undefined
          }

          // Clear animation configured flag so animations can be reconfigured for next aircraft
          // This allows the pool slot to be properly reused with fresh animation state
          modelAnimationsConfiguredRef.current.delete(idx)
        }
      }
    }
  }, [
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
    viewMode,
    topdownAltitude
  ])

  // Update aircraft entities when data changes (outside of Cesium's render loop)
  // This ensures entities are added before Cesium's next render cycle processes them
  useEffect(() => {
    updateAircraftEntities()
  }, [updateAircraftEntities])

  // Sync Babylon overlay and update aircraft on each render frame
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    // Update aircraft and sync Babylon overlay AFTER render when camera position is finalized
    // This runs every frame (~60fps) to ensure smooth interpolated aircraft movement
    const removePostRender = viewer.scene.postRender.addEventListener(() => {
      // Update aircraft positions from interpolated data (mutated every frame by useAircraftInterpolation)
      updateAircraftEntities()
      babylonOverlay.syncCamera()
      babylonOverlay.render()
    })

    return () => {
      removePostRender()
    }
  }, [cesiumViewer, babylonOverlay, updateAircraftEntities])

  // Memory diagnostic logging - logs counters every 5 seconds
  useEffect(() => {
    let swCacheStats = { count: 0, sizeBytes: 0 }

    const logMemoryCounters = async () => {
      const counters = getMemoryCounters()
      const babylonMeshes = babylonOverlay.getAircraftCallsigns().length
      const poolUsed = [...conePoolAssignmentsRef.current.values()].filter(v => v !== null).length

      // Get Cesium tile cache size if viewer is available
      const cesiumTileCache = viewerRef.current?.scene?.globe?.tileCacheSize ?? 0

      // Get service worker cache stats (async but we use last known value to avoid blocking)
      getServiceWorkerCacheStats().then(stats => { swCacheStats = stats })
      const cacheSizeMB = (swCacheStats.sizeBytes / (1024 * 1024)).toFixed(1)

      // Calculate memory estimate (rough)
      // StandardMaterial: ~2KB, Mesh: ~5KB, GUI Control: ~1KB
      const estimatedLeakMB = (
        (counters.materialsCreated - counters.materialsDisposed) * 2 +
        (counters.meshesCreated - counters.meshesDisposed) * 5 +
        (counters.guiControlsCreated - counters.guiControlsDisposed) * 1
      ) / 1024

      console.log(
        `[Memory] Babylon - Mat: ${counters.materialsCreated - counters.materialsDisposed} Mesh: ${counters.meshesCreated - counters.meshesDisposed} GUI: ${counters.guiControlsCreated - counters.guiControlsDisposed} AC: ${babylonMeshes} | ` +
        `Cesium - Pool: ${poolUsed}/100 TileCache: ${cesiumTileCache} | ` +
        `VATSIM: ${pilotsFilteredByDistance}/${totalPilotsFromApi} | ` +
        `SW Cache: ${swCacheStats.count} tiles ${cacheSizeMB}MB | ` +
        `Leak: ${estimatedLeakMB.toFixed(2)}MB`
      )
    }

    const intervalId = setInterval(logMemoryCounters, 5000)
    return () => clearInterval(intervalId)
  }, [babylonOverlay, totalPilotsFromApi, pilotsFilteredByDistance])

  return (
    <div className="cesium-viewer-container" ref={containerRef} />
  )
}

export default CesiumViewer
