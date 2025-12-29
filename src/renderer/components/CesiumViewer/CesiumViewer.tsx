import { useEffect, useRef, useState, useMemo } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useMeasureStore } from '../../stores/measureStore'
import { useAircraftFilterStore } from '../../stores/aircraftFilterStore'
import { useDatablockPositionStore } from '../../stores/datablockPositionStore'
import { useUIFeedbackStore } from '../../stores/uiFeedbackStore'
import { useAircraftInterpolation, setInterpolationTerrainData } from '../../hooks/useAircraftInterpolation'
import { useCesiumCamera } from '../../hooks/useCesiumCamera'
import { useBabylonOverlay } from '../../hooks/useBabylonOverlay'
import { useCesiumViewer } from '../../hooks/useCesiumViewer'
import { useTerrainQuality } from '../../hooks/useTerrainQuality'
import { useCesiumLighting } from '../../hooks/useCesiumLighting'
import { useSunElevation } from '../../hooks/useSunElevation'
import { useCesiumNightDarkening } from '../../hooks/useCesiumNightDarkening'
import { useBabylonNightLighting } from '../../hooks/useBabylonNightLighting'
import { useCesiumWeather } from '../../hooks/useCesiumWeather'
import { useAircraftModels } from '../../hooks/useAircraftModels'
import { useCesiumLabels } from '../../hooks/useCesiumLabels'
import { useGroundAircraftTerrain } from '../../hooks/useGroundAircraftTerrain'
import { useAutoAirportSwitch } from '../../hooks/useAutoAirportSwitch'
import { getTowerPosition } from '../../utils/towerHeight'
import { performanceMonitor } from '../../utils/performanceMonitor'
import { hasViewingContext, isOrbitFollowing, isOrbitWithoutAirport } from '../../utils/viewingContext'
import { getServiceWorkerCacheStats } from '../../utils/serviceWorkerRegistration'
import { getMemoryCounters } from '../../hooks/useBabylonOverlay'
import './CesiumViewer.css'

// Import Cesium CSS
import 'cesium/Build/Cesium/Widgets/widgets.css'

interface CesiumViewerProps {
  viewportId?: string
  /** Whether this is an inset viewport (uses reduced quality settings for performance) */
  isInset?: boolean
  onViewerReady?: (viewer: Cesium.Viewer | null) => void
}

/**
 * Main Cesium 3D viewer component
 *
 * Orchestrates Cesium initialization and coordinates with Babylon overlay.
 * Most rendering logic has been extracted to specialized hooks.
 *
 * Hook call order (CRITICAL):
 * 1. useCesiumViewer - core viewer initialization
 * 2. useTerrainQuality - terrain setup
 * 3. useCesiumLighting - lighting/shadows
 * 4. useCesiumWeather - weather effects
 * 5. useAircraftModels - aircraft model pool
 * 6. useCesiumLabels - datablock labels
 * 7. useBabylonOverlay - screen-space labels, leader lines, weather effects (requires viewer fully initialized)
 */
function CesiumViewer({ viewportId = 'main', isInset = false, onViewerReady }: CesiumViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null!)
  const babylonCanvasRef = useRef<HTMLCanvasElement>(null)
  const rootNodeSetupRef = useRef(false)

  // Terrain offset: difference between ellipsoidal height and MSL elevation
  // This corrects for geoid undulation (varies by location, e.g., -30m at Boston)
  const terrainOffsetRef = useRef<number>(0)
  const [_terrainOffsetReady, setTerrainOffsetReady] = useState(false)

  // Track last reference position to prevent redundant setReferencePosition calls
  // which would otherwise cause infinite render loops
  const lastRefPositionRef = useRef<{ lat: number; lon: number } | null>(null)

  // Use state for viewer and canvas to trigger re-renders when they're ready
  const [babylonCanvas, setBabylonCanvas] = useState<HTMLCanvasElement | null>(null)
  const [buildingsTileset, setBuildingsTileset] = useState<Cesium.Cesium3DTileset | null>(null)
  const babylonCanvasCreatedRef = useRef(false)

  // Store state
  // Cesium token from global settings (shared across browsers)
  const cesiumIonToken = useGlobalSettingsStore((state) => state.cesiumIonToken)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)
  const datablockMode = useSettingsStore((state) => state.aircraft.datablockMode)
  const terrainQuality = useSettingsStore((state) => state.cesium.terrainQuality)
  const show3DBuildings = useSettingsStore((state) => state.cesium.show3DBuildings)
  const timeMode = useSettingsStore((state) => state.cesium.timeMode)
  const fixedTimeHour = useSettingsStore((state) => state.cesium.fixedTimeHour)
  const inMemoryTileCacheSize = useSettingsStore((state) => state.memory.inMemoryTileCacheSize)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.weather.showCesiumFog)
  const enableWeatherInterpolation = useSettingsStore((state) => state.weather.enableWeatherInterpolation)
  const enableAutoAirportSwitch = useSettingsStore((state) => state.camera.enableAutoAirportSwitch)

  // Experimental graphics settings
  const msaaSamples = useSettingsStore((state) => state.graphics.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.graphics.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.graphics.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.graphics.enableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.graphics.enableGroundAtmosphere)
  const enableLighting = useSettingsStore((state) => state.cesium.enableLighting)
  const enableShadows = useSettingsStore((state) => state.graphics.enableShadows)
  const shadowMapSize = useSettingsStore((state) => state.graphics.shadowMapSize)
  const shadowMaxDistance = useSettingsStore((state) => state.graphics.shadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.graphics.shadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.graphics.shadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.graphics.shadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.graphics.shadowNormalOffset)
  const aircraftShadowsOnly = useSettingsStore((state) => state.graphics.aircraftShadowsOnly)
  const enableAmbientOcclusion = useSettingsStore((state) => state.graphics.enableAmbientOcclusion)
  const enableAircraftSilhouettes = useSettingsStore((state) => state.graphics.enableAircraftSilhouettes)
  // New shadow bias settings - use defaults if not yet migrated in localStorage
  const shadowDepthBias = useSettingsStore((state) => state.graphics.shadowDepthBias) ?? 0.0004
  const shadowPolygonOffsetFactor = useSettingsStore((state) => state.graphics.shadowPolygonOffsetFactor) ?? 1.1
  const shadowPolygonOffsetUnits = useSettingsStore((state) => state.graphics.shadowPolygonOffsetUnits) ?? 4.0
  // NOTE: cameraNearPlane effect is disabled (see section 3b below)
  const _cameraNearPlane = useSettingsStore((state) => state.graphics.cameraNearPlane) ?? 0.1
  // Model rendering - separate brightness for built-in and FSLTL models
  const builtinModelBrightness = useSettingsStore((state) => state.graphics.builtinModelBrightness) ?? 1.7
  // Night darkening settings
  const enableNightDarkening = useSettingsStore((state) => state.graphics.enableNightDarkening) ?? true
  const nightDarkeningIntensity = useSettingsStore((state) => state.graphics.nightDarkeningIntensity) ?? 0.7
  // Performance settings
  const maxFramerate = useSettingsStore((state) => state.graphics.maxFramerate) ?? 60

  // Weather store for fog effects, camera position updates, and cloud layers
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const updateCameraPosition = useWeatherStore((state) => state.updateCameraPosition)
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const setUseInterpolation = useWeatherStore((state) => state.setUseInterpolation)
  const startInterpolatedAutoRefresh = useWeatherStore((state) => state.startInterpolatedAutoRefresh)

  // Camera geo position state (for auto-airport switching and weather interpolation)
  const [cameraGeoPosition, setCameraGeoPosition] = useState<{ lat: number; lon: number } | null>(null)

  // Measure store for measuring mode
  const isMeasuring = useMeasureStore((state) => state.isActive)
  const measurements = useMeasureStore((state) => state.measurements)
  const pendingPoint = useMeasureStore((state) => state.pendingPoint)
  const setPendingPoint = useMeasureStore((state) => state.setPendingPoint)
  const setPreviewPoint = useMeasureStore((state) => state.setPreviewPoint)
  const completeMeasurement = useMeasureStore((state) => state.completeMeasurement)
  const cancelPendingMeasurement = useMeasureStore((state) => state.cancelPendingMeasurement)
  const removeMeasurement = useMeasureStore((state) => state.removeMeasurement)

  // Viewport store for follow highlighting and view mode (read from this viewport)
  const viewports = useViewportStore((state) => state.viewports)
  const thisViewport = useMemo(
    () => viewports.find(v => v.id === viewportId),
    [viewports, viewportId]
  )
  const cameraState = thisViewport?.cameraState
  const followingCallsign = cameraState?.followingCallsign ?? null
  const followMode = cameraState?.followMode ?? 'tower'
  const viewMode = cameraState?.viewMode ?? '3d'

  // VATSIM store for setting reference position
  const setReferencePosition = useVatsimStore((state) => state.setReferencePosition)
  const totalPilotsFromApi = useVatsimStore((state) => state.totalPilotsFromApi)
  const pilotsFilteredByDistance = useVatsimStore((state) => state.pilotsFilteredByDistance)

  // Get interpolated aircraft states (all aircraft, unfiltered)
  const interpolatedAircraft = useAircraftInterpolation()

  // Get filter settings from stores (for inline filtering at 60Hz)
  const searchQuery = useAircraftFilterStore((state) => state.searchQuery)
  const filterAirportTraffic = useAircraftFilterStore((state) => state.filterAirportTraffic)
  const labelVisibilityDistance = useSettingsStore((state) => state.aircraft.labelVisibilityDistance)
  const showGroundTraffic = useSettingsStore((state) => state.aircraft.showGroundTraffic)
  const showAirborneTraffic = useSettingsStore((state) => state.aircraft.showAirborneTraffic)

  // =========================================================================
  // Calculate reference position and ground elevation (used by hooks below)
  // =========================================================================
  let refLat: number | null = null
  let refLon: number | null = null
  let refAltitudeFeet: number | null = null
  let groundElevationMeters = 0
  let airportElevationFeet = 0
  let isOrbitModeWithoutAirport = false

  // Check if in orbit mode without airport (use followed aircraft as reference)
  if (isOrbitWithoutAirport(currentAirport, followMode, followingCallsign) && interpolatedAircraft.has(followingCallsign!)) {
    const followedAircraft = interpolatedAircraft.get(followingCallsign!)!
    refLat = followedAircraft.interpolatedLatitude
    refLon = followedAircraft.interpolatedLongitude
    groundElevationMeters = followedAircraft.interpolatedAltitude
    refAltitudeFeet = followedAircraft.interpolatedAltitude
    isOrbitModeWithoutAirport = true
  } else if (currentAirport) {
    // Normal mode: use tower position
    const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
    refLat = towerPos.latitude
    refLon = towerPos.longitude
    groundElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
    airportElevationFeet = currentAirport.elevation || 0
    // Tower altitude = ground elevation + tower height (convert tower height from meters to feet)
    refAltitudeFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)
  }

  // =========================================================================
  // 1. Core Cesium Viewer Initialization
  // =========================================================================
  const { viewer, modelPoolRefs, silhouetteRefs } = useCesiumViewer(containerRef, viewportId, {
    cesiumIonToken,
    isInset,
    msaaSamples,
    enableLighting,
    enableLogDepth,
    enableHdr,
    enableFxaa,
    enableAmbientOcclusion,
    enableAircraftSilhouettes,
    enableGroundAtmosphere,
    enableShadows,
    shadowMapSize,
    shadowMaxDistance,
    shadowDarkness,
    shadowSoftness,
    shadowFadingEnabled,
    shadowNormalOffset,
    inMemoryTileCacheSize,
    modelBrightness: builtinModelBrightness  // Initial pool uses built-in brightness
  })

  // =========================================================================
  // 2. Terrain Quality Management
  // =========================================================================
  useTerrainQuality(viewer, terrainQuality, inMemoryTileCacheSize)

  // =========================================================================
  // 3. Lighting and Shadow Configuration
  // =========================================================================
  useCesiumLighting(viewer, {
    isInset,
    viewMode,
    enableLighting,
    enableGroundAtmosphere,
    enableShadows,
    shadowMapSize,
    shadowMaxDistance,
    shadowDarkness,
    shadowSoftness,
    shadowFadingEnabled,
    shadowNormalOffset,
    aircraftShadowsOnly,
    shadowDepthBias,
    shadowPolygonOffsetFactor,
    shadowPolygonOffsetUnits
  })

  // =========================================================================
  // 3a. Night-Time Darkening (requires enableLighting)
  // =========================================================================
  // Calculate sun elevation angle at camera position
  const sunElevation = useSunElevation(viewer, { timeMode, fixedTimeHour })

  // Darken satellite imagery based on sun position
  useCesiumNightDarkening(viewer, sunElevation, {
    enabled: enableNightDarkening && enableLighting, // Only works with lighting enabled
    intensity: nightDarkeningIntensity
  })

  // =========================================================================
  // 3c. Hide Stars When OVC Cloud Layer Present
  // =========================================================================
  // Babylon.js clouds render on a transparent canvas overlay, so they can't
  // truly block Cesium's stars. Instead, we hide Cesium's skyBox when there's
  // an OVC (overcast) cloud layer that would obscure the sky.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Check if any cloud layer is OVC (coverage >= 0.95)
    const hasOvcLayer = cloudLayers.some(layer => layer.coverage >= 0.95)

    // Toggle Cesium's star rendering
    if (viewer.scene.skyBox) {
      viewer.scene.skyBox.show = !hasOvcLayer
    }
    // Also toggle sun/moon for consistency
    if (viewer.scene.sun) {
      viewer.scene.sun.show = !hasOvcLayer
    }
    if (viewer.scene.moon) {
      viewer.scene.moon.show = !hasOvcLayer
    }
  }, [viewer, cloudLayers])

  // =========================================================================
  // 3b. Camera Near Plane (for depth precision)
  // =========================================================================
  // NOTE: Disabled for now - Cesium's frustum needs special handling
  // The default near plane (0.1m) is already good for most cases
  // Setting it requires the frustum to be fully initialized with fov/aspectRatio/far
  // which doesn't happen reliably in all scenarios
  /*
  useEffect(() => {
    if (!viewer) return
    // Update camera near plane for better depth/shadow precision
    // Higher values improve precision but clip nearby objects
    // Defer until after first render when frustum is fully initialized
    const removeListener = viewer.scene.postRender.addEventListener(() => {
      removeListener() // Only run once
      try {
        const frustum = viewer.camera.frustum
        if (
          frustum instanceof Cesium.PerspectiveFrustum &&
          frustum.fov !== undefined &&
          frustum.aspectRatio !== undefined &&
          frustum.far !== undefined
        ) {
          frustum.near = cameraNearPlane
        }
      } catch (e) {
        // Frustum not fully initialized yet, ignore
        console.warn('[Camera Near Plane] Frustum not ready, skipping:', e)
      }
    })
    return () => {
      removeListener()
    }
  }, [viewer, cameraNearPlane])
  */

  // =========================================================================
  // 4. Weather Effects (Fog)
  // =========================================================================
  useCesiumWeather(viewer, showWeatherEffects, showCesiumFog, fogDensity)

  // =========================================================================
  // 5. Ground Aircraft Terrain Sampling (3x per second)
  // =========================================================================
  const groundAircraftTerrain = useGroundAircraftTerrain(viewer, interpolatedAircraft, groundElevationMeters)

  // Inject terrain data into interpolation system for terrain correction
  useEffect(() => {
    setInterpolationTerrainData(
      groundAircraftTerrain,
      terrainOffsetRef.current,
      groundElevationMeters
    )
  }, [groundAircraftTerrain, groundElevationMeters])

  // =========================================================================
  // 6. Aircraft Model Pool Rendering
  // =========================================================================
  // Note: Render culling (distance + max count filtering) happens inside
  // useAircraftModels on every frame, not here. This is because the animation
  // loop runs outside React's render cycle.
  useAircraftModels(
    viewer,
    modelPoolRefs,
    interpolatedAircraft,
    viewMode,
    followingCallsign,
    groundElevationMeters,
    silhouetteRefs,
    sunElevation
  )

  // =========================================================================
  // 7. Datablock Label Rendering
  // =========================================================================
  // (Reference position calculated above before hook initialization)

  // =========================================================================
  // 8. Babylon.js Overlay Initialization (before labels - labels need babylonOverlay)
  // =========================================================================
  const babylonOverlay = useBabylonOverlay({
    cesiumViewer: viewer,
    canvas: babylonCanvas
  })

  // Adjust Babylon.js lighting based on sun position
  useBabylonNightLighting(babylonOverlay?.scene ?? null, sunElevation, {
    enabled: enableNightDarkening && enableLighting
  })

  useCesiumLabels({
    viewer,
    babylonOverlay, // Now passes actual babylonOverlay (may be null initially, but will update)
    interpolatedAircraft, // Culling happens inside the hook on every frame
    datablockMode,
    viewMode,
    followingCallsign,
    currentAirportIcao: currentAirport?.icao?.toUpperCase() ?? null,
    airportElevationFeet,
    groundElevationMeters,
    terrainOffset: terrainOffsetRef.current,
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
    groundAircraftTerrain  // Pass terrain heights for correct label attachment
  })

  // =========================================================================
  // 9. Camera Controls
  // =========================================================================
  useCesiumCamera(viewer, viewportId, interpolatedAircraft)

  // =========================================================================
  // 10. Auto-Airport Switching (only on main viewport)
  // =========================================================================
  useAutoAirportSwitch({
    cameraPosition: viewportId === 'main' ? cameraGeoPosition : null,
    enabled: viewportId === 'main' && enableAutoAirportSwitch
  })

  // Enable weather interpolation when setting is on
  useEffect(() => {
    if (enableWeatherInterpolation && showWeatherEffects) {
      setUseInterpolation(true)
      startInterpolatedAutoRefresh()
    }
  }, [enableWeatherInterpolation, showWeatherEffects, setUseInterpolation, startInterpolatedAutoRefresh])

  // Notify parent when viewer is ready (for VR integration)
  useEffect(() => {
    if (onViewerReady) {
      onViewerReady(viewer)
    }
  }, [viewer, onViewerReady])

  // Create Babylon canvas after Cesium viewer is ready
  useEffect(() => {
    if (!viewer || !containerRef.current || babylonCanvasCreatedRef.current) return

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
  }, [viewer])

  // =========================================================================
  // Orchestration Logic (remains in component)
  // =========================================================================

  // Clear old IndexedDB tile cache on startup (we now use Service Worker caching)
  useEffect(() => {
    // Clear any residual data from the old IndexedDB cache
    if ('indexedDB' in window) {
      indexedDB.deleteDatabase('cesium-tile-cache')
    }
  }, [])

  // Update in-memory tile cache size when setting changes
  useEffect(() => {
    if (!viewer) return
    viewer.scene.globe.tileCacheSize = inMemoryTileCacheSize
  }, [viewer, inMemoryTileCacheSize])

  // Apply target frame rate limit (0 = unlimited)
  useEffect(() => {
    if (!viewer) return
    // Cesium's targetFrameRate: undefined means unlimited (uses requestAnimationFrame)
    // A number limits the frame rate to that value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(viewer as any).targetFrameRate = maxFramerate > 0 ? maxFramerate : undefined
  }, [viewer, maxFramerate])

  // Time of day control (real time vs fixed time)
  useEffect(() => {
    if (!viewer) return

    if (timeMode === 'fixed' && currentAirport) {
      // Calculate the specified local time at the tower location
      const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
      const now = new Date()

      // Start with UTC midnight of today
      const targetTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0))

      // Add the fixed hour in UTC, then adjust for longitude to get local time
      // Longitude / 15 gives hours offset from UTC (east is positive)
      const longitudeOffsetHours = towerPos.longitude / 15
      const utcHour = fixedTimeHour - longitudeOffsetHours
      targetTime.setTime(targetTime.getTime() + utcHour * 60 * 60 * 1000)

      viewer.clock.currentTime = Cesium.JulianDate.fromDate(targetTime)
      viewer.clock.shouldAnimate = false
    } else {
      // Real time mode - use current time and animate
      viewer.clock.currentTime = Cesium.JulianDate.now()
      viewer.clock.shouldAnimate = true
    }
  }, [viewer, timeMode, fixedTimeHour, currentAirport, towerHeight, customTowerPosition])

  // Manage OSM 3D Buildings tileset
  // Skip loading buildings for inset viewports to reduce memory usage and prevent WebGL context issues
  useEffect(() => {
    if (!viewer) return
    // Skip buildings for insets - they use reduced quality and don't need buildings
    if (isInset) return

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

          // Disable building shadows when aircraftShadowsOnly is enabled
          tileset.shadows = aircraftShadowsOnly
            ? Cesium.ShadowMode.DISABLED
            : Cesium.ShadowMode.ENABLED

          viewer.scene.primitives.add(tileset)
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
      if (currentTileset && viewer && !viewer.isDestroyed()) {
        viewer.scene.primitives.remove(currentTileset)
        setBuildingsTileset(null)
      }
    }
  }, [viewer, show3DBuildings, isInset, aircraftShadowsOnly])

  // Update building shadows when aircraftShadowsOnly changes
  useEffect(() => {
    if (!buildingsTileset) return
    buildingsTileset.shadows = aircraftShadowsOnly
      ? Cesium.ShadowMode.DISABLED
      : Cesium.ShadowMode.ENABLED
  }, [buildingsTileset, aircraftShadowsOnly])

  // Calculate terrain offset when airport changes or when in orbit mode without airport
  // This corrects for the difference between MSL and ellipsoidal height
  useEffect(() => {
    if (!viewer) {
      setTerrainOffsetReady(false)
      return
    }

    // For airport mode, calculate terrain offset at tower position
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
      const groundElevationMsl = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0

      // Sample terrain to calculate offset between MSL and actual terrain height
      if (viewer.terrainProvider) {
        const positions = [Cesium.Cartographic.fromDegrees(towerPos.longitude, towerPos.latitude)]
        Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions).then((updatedPositions) => {
          const terrainHeight = updatedPositions[0].height
          terrainOffsetRef.current = terrainHeight - groundElevationMsl
          setTerrainOffsetReady(true)
        }).catch(() => {
          terrainOffsetRef.current = 0
          console.warn('[Terrain Offset] Failed to sample terrain, using 0m offset')
          setTerrainOffsetReady(true)
        })
      } else {
        console.warn('[Terrain Offset] No terrain provider, using 0m offset')
        setTerrainOffsetReady(true)
      }
      return
    }

    // For orbit mode without airport, use default offset (will be recalculated per-aircraft as needed)
    if (isOrbitFollowing(followMode, followingCallsign)) {
      terrainOffsetRef.current = 0
      setTerrainOffsetReady(true)
      return
    }

    // No airport and not in orbit mode - reset
    setTerrainOffsetReady(false)
  }, [viewer, currentAirport, towerHeight, customTowerPosition, followMode, followingCallsign])

  // Setup Babylon root node when airport changes OR when in orbit mode without airport
  // Also set reference position for VATSIM distance filtering
  // Note: We avoid including aircraftStates in dependencies to prevent infinite loops
  // (setReferencePosition -> refilterPilots -> updates aircraftStates -> re-triggers effect)
  useEffect(() => {
    if (!babylonOverlay.sceneReady) return

    // Helper to set reference position only if it changed (prevents infinite loops)
    const setRefPosIfChanged = (lat: number, lon: number) => {
      const last = lastRefPositionRef.current
      if (!last || Math.abs(last.lat - lat) > 0.0001 || Math.abs(last.lon - lon) > 0.0001) {
        lastRefPositionRef.current = { lat, lon }
        setReferencePosition(lat, lon)
      }
    }

    // If we have an airport, use tower position as root
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
      babylonOverlay.setupRootNode(towerPos.latitude, towerPos.longitude, towerPos.height)
      rootNodeSetupRef.current = true

      // Set reference position for VATSIM filtering - only store aircraft near tower
      setRefPosIfChanged(towerPos.latitude, towerPos.longitude)
      return
    }

    // If in orbit mode following an aircraft without airport, use aircraft position as root
    if (isOrbitFollowing(followMode, followingCallsign) && followingCallsign) {
      // Try interpolated data first, fall back to raw store data (read directly to avoid reactive dependency)
      const interpolated = interpolatedAircraft.get(followingCallsign)
      const rawAircraft = useVatsimStore.getState().aircraftStates.get(followingCallsign)

      // Use interpolated if available, otherwise use raw store data
      const lat = interpolated?.interpolatedLatitude ?? rawAircraft?.latitude
      const lon = interpolated?.interpolatedLongitude ?? rawAircraft?.longitude
      const alt = interpolated?.interpolatedAltitude ?? rawAircraft?.altitude

      if (lat !== undefined && lon !== undefined && alt !== undefined) {
        const altitudeMeters = alt  // Already in METERS
        babylonOverlay.setupRootNode(lat, lon, altitudeMeters)
        rootNodeSetupRef.current = true

        // Set reference position to followed aircraft for VATSIM filtering
        setRefPosIfChanged(lat, lon)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally using specific babylonOverlay properties
  }, [currentAirport, towerHeight, babylonOverlay.sceneReady, babylonOverlay.setupRootNode, followMode, followingCallsign, interpolatedAircraft, setReferencePosition])

  // Sync Babylon overlay and update aircraft on each render frame
  useEffect(() => {
    if (!viewer) return

    // Mark preRender for accurate Cesium render timing
    const removePreRender = viewer.scene.preRender.addEventListener(() => {
      performanceMonitor.markCesiumPreRender()
    })

    // Update aircraft and sync Babylon overlay AFTER render when camera position is finalized
    // This runs every frame (~60fps) to ensure smooth interpolated aircraft movement
    const removePostRender = viewer.scene.postRender.addEventListener(() => {
      // Record Cesium render time and scene statistics
      const primitiveCount = viewer.scene.primitives.length
      const globe = viewer.scene.globe
      // Access tile loading stats via internal surface (may not be available in all Cesium versions)
      const surface = (globe as unknown as { _surface?: { tileProvider?: { _tilesToRenderByTextureCount?: unknown[] } } })._surface
      const tilesLoaded = surface?.tileProvider?._tilesToRenderByTextureCount?.length ?? 0
      const tilesLoading = (globe as unknown as { _tilesLoading?: number })._tilesLoading ?? 0
      performanceMonitor.markCesiumPostRender(primitiveCount, tilesLoaded, tilesLoading)

      performanceMonitor.startFrame()

      performanceMonitor.startTimer('babylonSync')
      babylonOverlay.syncCamera()
      performanceMonitor.endTimer('babylonSync')

      performanceMonitor.startTimer('babylonRender')
      babylonOverlay.render()
      performanceMonitor.endTimer('babylonRender')

      // Update camera position for weather interpolation and auto-airport switching
      // Track position when:
      // 1. Weather interpolation is enabled (camera-based weather)
      // 2. Orbit mode without airport (legacy nearest METAR mode)
      // 3. Auto-airport switching is enabled
      const shouldTrackCamera =
        (showWeatherEffects && enableWeatherInterpolation) ||
        (showWeatherEffects && isOrbitWithoutAirport(currentAirport, followMode, followingCallsign)) ||
        enableAutoAirportSwitch

      if (shouldTrackCamera) {
        const cameraCartographic = viewer.camera.positionCartographic
        if (cameraCartographic) {
          const lat = Cesium.Math.toDegrees(cameraCartographic.latitude)
          const lon = Cesium.Math.toDegrees(cameraCartographic.longitude)

          // Only update state if position changed significantly (~100m threshold)
          // This prevents React re-renders every frame
          const POSITION_THRESHOLD_DEG = 0.001
          const positionChanged = !cameraGeoPosition ||
            Math.abs(lat - cameraGeoPosition.lat) > POSITION_THRESHOLD_DEG ||
            Math.abs(lon - cameraGeoPosition.lon) > POSITION_THRESHOLD_DEG

          if (positionChanged) {
            // Update local state for auto-airport switching
            setCameraGeoPosition({ lat, lon })
          }

          // Update weather store for interpolation/nearest METAR
          // (has its own internal throttling)
          // Only fetch weather when viewing a specific location (not globe from space)
          if (showWeatherEffects && hasViewingContext(currentAirport, followMode, followingCallsign)) {
            updateCameraPosition(lat, lon)
          }
        }
      }

      performanceMonitor.endFrame()
    })

    return () => {
      removePreRender()
      removePostRender()
    }
  }, [viewer, babylonOverlay, showWeatherEffects, enableWeatherInterpolation, enableAutoAirportSwitch, followMode, followingCallsign, currentAirport, updateCameraPosition, cameraGeoPosition])

  // Memory diagnostic logging - logs counters every 5 seconds
  useEffect(() => {
    let swCacheStats = { count: 0, sizeBytes: 0 }

    const logMemoryCounters = async () => {
      const counters = getMemoryCounters()
      const babylonMeshes = babylonOverlay.getAircraftCallsigns().length
      const poolUsed = [...modelPoolRefs.modelPoolAssignments.current.values()].filter(v => v !== null).length

      // Get Cesium tile cache size if viewer is available
      const cesiumTileCache = viewer?.scene?.globe?.tileCacheSize ?? 0

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

      // Suppress verbose memory logging - only log when leak is significant
      if (estimatedLeakMB > 50) {
        console.warn(
          `[Memory] Potential leak detected: ${estimatedLeakMB.toFixed(2)}MB | ` +
          `Babylon - Mat: ${counters.materialsCreated - counters.materialsDisposed} Mesh: ${counters.meshesCreated - counters.meshesDisposed} GUI: ${counters.guiControlsCreated - counters.guiControlsDisposed} AC: ${babylonMeshes} | ` +
          `Cesium - Pool: ${poolUsed}/100 TileCache: ${cesiumTileCache} | ` +
          `VATSIM: ${pilotsFilteredByDistance}/${totalPilotsFromApi} | ` +
          `SW Cache: ${swCacheStats.count} tiles ${cacheSizeMB}MB`
        )
      }
    }

    const intervalId = setInterval(logMemoryCounters, 5000)
    return () => clearInterval(intervalId)
  }, [babylonOverlay, totalPilotsFromApi, pilotsFilteredByDistance, modelPoolRefs, viewer])

  // Measuring mode event handlers
  useEffect(() => {
    if (!viewer || !isMeasuring) {
      // Clear preview when not measuring
      setPreviewPoint(null)
      return
    }

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    // Helper to pick terrain position
    const pickTerrainPosition = (position: Cesium.Cartesian2) => {
      const cartesian = viewer.scene.pickPosition(position)
      if (!cartesian) return null

      const cartographic = Cesium.Cartographic.fromCartesian(cartesian)
      return {
        cartesian,
        cartographic: {
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
          height: cartographic.height
        }
      }
    }

    // Helper to check if click is near a measurement endpoint
    const findNearbyMeasurementEndpoint = (screenPos: Cesium.Cartesian2): string | null => {
      const threshold = 15 // pixels
      for (const m of measurements) {
        // Check point1
        const p1Screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, m.point1.cartesian)
        if (p1Screen) {
          const dx = p1Screen.x - screenPos.x
          const dy = p1Screen.y - screenPos.y
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            return m.id
          }
        }
        // Check point2
        const p2Screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, m.point2.cartesian)
        if (p2Screen) {
          const dx = p2Screen.x - screenPos.x
          const dy = p2Screen.y - screenPos.y
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            return m.id
          }
        }
      }
      return null
    }

    // Left-click: Set pending point or complete measurement
    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const point = pickTerrainPosition(click.position)
      if (!point) return

      if (!pendingPoint) {
        // First click - set pending point
        setPendingPoint(point)
      } else {
        // Second click - complete the measurement
        completeMeasurement(point)
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    // Mouse move: Update preview when we have a pending point
    handler.setInputAction((movement: { endPosition: Cesium.Cartesian2 }) => {
      if (!pendingPoint) {
        setPreviewPoint(null)
        return
      }

      const point = pickTerrainPosition(movement.endPosition)
      setPreviewPoint(point)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Right-click: Remove measurement if clicking near an endpoint
    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const measurementId = findNearbyMeasurementEndpoint(click.position)
      if (measurementId) {
        removeMeasurement(measurementId)
      }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK)

    // Escape key: Cancel pending measurement
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pendingPoint) {
        cancelPendingMeasurement()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      handler.destroy()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [viewer, isMeasuring, measurements, pendingPoint, setPendingPoint, setPreviewPoint, completeMeasurement, cancelPendingMeasurement, removeMeasurement])

  // Datablock SLEW mode - click on aircraft to move its label position
  const pendingDirection = useDatablockPositionStore((state) => state.pendingDirection)

  useEffect(() => {
    if (!viewer || !pendingDirection) return

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)

    // Helper to find aircraft near click position (checks both datablocks and aircraft models)
    const findAircraftAtPosition = (screenPos: Cesium.Cartesian2): string | null => {
      // First, check if clicking on a datablock label
      // Label bounds are stored in device pixels, so scale click coordinates for high-DPI displays
      const datablockStore = useDatablockPositionStore.getState()
      const dpr = window.devicePixelRatio || 1
      const labelCallsign = datablockStore.findLabelAtPosition(screenPos.x * dpr, screenPos.y * dpr)
      if (labelCallsign) {
        return labelCallsign
      }

      // Otherwise, check if clicking near an aircraft position
      const threshold = 30 // pixels

      for (const [callsign, aircraft] of interpolatedAircraft) {
        const position = Cesium.Cartesian3.fromDegrees(
          aircraft.interpolatedLongitude,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedAltitude
        )
        const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, position)
        if (!windowPos) continue

        const dx = windowPos.x - screenPos.x
        const dy = windowPos.y - screenPos.y
        if (Math.sqrt(dx * dx + dy * dy) < threshold) {
          return callsign
        }
      }
      return null
    }

    handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
      const datablockStore = useDatablockPositionStore.getState()
      if (!datablockStore.pendingDirection) return

      const callsign = findAircraftAtPosition(click.position)
      if (callsign) {
        // Key 5 means "reset to default" - clear per-aircraft override
        if (datablockStore.pendingDirection === 5) {
          datablockStore.clearAircraftOverride(callsign)
          const appDefault = useSettingsStore.getState().aircraft.defaultDatablockDirection
          useUIFeedbackStore.getState().showFeedback(
            `${callsign} datablock reset to default (${appDefault})`,
            'success'
          )
        } else {
          datablockStore.setAircraftPosition(callsign, datablockStore.pendingDirection)
          useUIFeedbackStore.getState().showFeedback(
            `${callsign} datablock → position ${datablockStore.pendingDirection}`,
            'success'
          )
        }
      }
      // Clear pending direction whether we found an aircraft or not
      datablockStore.setPendingDirection(null)
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

    return () => handler.destroy()
  }, [viewer, pendingDirection, interpolatedAircraft])

  return (
    <div className={`cesium-viewer-container ${isInset ? 'inset' : ''}`} ref={containerRef} />
  )
}

export default CesiumViewer
