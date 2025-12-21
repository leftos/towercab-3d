import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import * as Cesium from 'cesium'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useViewportStore } from '../../stores/viewportStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useMeasureStore } from '../../stores/measureStore'
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
import { aircraftModelService } from '../../services/AircraftModelService'
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

// Model pool size - pre-create this many Model primitives at init time
const CONE_POOL_SIZE = 100

// Model rendering constants
const MODEL_HEIGHT_OFFSET = 1       // Meters to raise models above ground to prevent clipping
const MODEL_DEFAULT_COLOR = new Cesium.Color(0.9, 0.9, 0.9, 1.0)  // Light gray tint for MIX mode
const MODEL_COLOR_BLEND_AMOUNT = 0.15  // Subtle blend to preserve original textures (0=original, 1=full tint)

interface CesiumViewerProps {
  viewportId?: string
  /** Whether this is an inset viewport (uses reduced quality settings for performance) */
  isInset?: boolean
  onViewerReady?: (viewer: Cesium.Viewer | null) => void
}

function CesiumViewer({ viewportId = 'main', isInset = false, onViewerReady }: CesiumViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const babylonCanvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const rootNodeSetupRef = useRef(false)

  // Terrain offset: difference between ellipsoidal height and MSL elevation
  // This corrects for geoid undulation (varies by location, e.g., -30m at Boston)
  const terrainOffsetRef = useRef<number>(0)
  const terrainOffsetReadyRef = useRef<boolean>(false)

  // Track last reference position to prevent redundant setReferencePosition calls
  // which would otherwise cause infinite render loops
  const lastRefPositionRef = useRef<{ lat: number; lon: number } | null>(null)

  // Model primitive pool: maps pool index to Model primitive (or undefined if not loaded)
  const modelPoolRef = useRef<Map<number, Cesium.Model>>(new Map())
  // Pool assignments: maps pool index to callsign (or null if unused)
  const modelPoolAssignmentsRef = useRef<Map<number, string | null>>(new Map())
  // Track which model URL each pool slot is currently using
  const modelPoolUrlsRef = useRef<Map<number, string>>(new Map())
  // Track which pool slots are currently loading a new model (to avoid duplicate loads)
  const modelPoolLoadingRef = useRef<Set<number>>(new Set())
  const modelPoolReadyRef = useRef<boolean>(false)

  // Propeller animation state: maps callsign to propeller state
  const propellerStatesRef = useRef<Map<string, PropellerState>>(new Map())
  // Track which pool models have been configured for manual animation control
  const modelAnimationsConfiguredRef = useRef<Set<number>>(new Set())

  // Use state for viewer and canvas to trigger re-renders when they're ready
  const [cesiumViewer, setCesiumViewer] = useState<Cesium.Viewer | null>(null)
  const [babylonCanvas, setBabylonCanvas] = useState<HTMLCanvasElement | null>(null)
  const [_buildingsTileset, setBuildingsTileset] = useState<Cesium.Cesium3DTileset | null>(null)
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
  const showCesiumFog = useSettingsStore((state) => state.showCesiumFog)
  // Experimental graphics settings
  const msaaSamples = useSettingsStore((state) => state.msaaSamples)
  const enableFxaa = useSettingsStore((state) => state.enableFxaa)
  const enableHdr = useSettingsStore((state) => state.enableHdr)
  const enableLogDepth = useSettingsStore((state) => state.enableLogDepth)
  const enableGroundAtmosphere = useSettingsStore((state) => state.enableGroundAtmosphere)
  const enableLighting = useSettingsStore((state) => state.enableLighting)
  const enableShadows = useSettingsStore((state) => state.enableShadows)
  const shadowMapSize = useSettingsStore((state) => state.shadowMapSize)
  const shadowCascades = useSettingsStore((state) => state.shadowCascades)
  const shadowMaxDistance = useSettingsStore((state) => state.shadowMaxDistance)
  const shadowDarkness = useSettingsStore((state) => state.shadowDarkness)
  const shadowSoftness = useSettingsStore((state) => state.shadowSoftness)
  const shadowFadingEnabled = useSettingsStore((state) => state.shadowFadingEnabled)
  const shadowNormalOffset = useSettingsStore((state) => state.shadowNormalOffset)

  // Weather store for fog effects and camera position updates
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const updateCameraPosition = useWeatherStore((state) => state.updateCameraPosition)

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
  const topdownAltitude = cameraState?.topdownAltitude ?? 5000

  // VATSIM store for setting reference position
  const setReferencePosition = useVatsimStore((state) => state.setReferencePosition)
  // Note: aircraftStates is read directly from store via getState() to avoid infinite loops
  const totalPilotsFromApi = useVatsimStore((state) => state.totalPilotsFromApi)
  const pilotsFilteredByDistance = useVatsimStore((state) => state.pilotsFilteredByDistance)

  // Get interpolated aircraft states
  const interpolatedAircraft = useAircraftInterpolation()

  // Initialize camera controls (this hook manages all camera behavior)
  // Pass interpolated aircraft for smooth follow tracking
  useCesiumCamera(cesiumViewer, viewportId, interpolatedAircraft)

  // Initialize Babylon.js overlay for labels and leader lines
  // Uses state variables to ensure re-render when viewer/canvas are ready
  const babylonOverlay = useBabylonOverlay({
    cesiumViewer,
    canvas: babylonCanvas
  })

  // Notify parent when viewer is ready (for VR integration)
  useEffect(() => {
    if (onViewerReady) {
      onViewerReady(cesiumViewer)
    }
  }, [cesiumViewer, onViewerReady])

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
  // This effect re-runs when MSAA changes, recreating the viewer with new settings
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    // Log MSAA setting for debugging
    const effectiveMsaa = isInset ? 2 : msaaSamples
    console.log(`Creating Cesium viewer with MSAA=${effectiveMsaa}x (viewport: ${viewportId})`)

    // Set Ion access token
    if (cesiumIonToken) {
      Cesium.Ion.defaultAccessToken = cesiumIonToken
    }

    // Create viewer with default terrain and imagery
    // Insets use reduced quality for performance
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
      msaaSamples: isInset ? 2 : msaaSamples  // Use settings, reduced for insets
    })

    // Configure scene - use settings from store
    viewer.scene.globe.enableLighting = enableLighting
    viewer.scene.fog.enabled = true
    viewer.scene.globe.depthTestAgainstTerrain = true

    // Rendering quality improvements - from settings
    viewer.scene.logarithmicDepthBuffer = enableLogDepth
    viewer.scene.highDynamicRange = enableHdr
    viewer.scene.fxaa = enableFxaa

    // Improve texture quality - helps reduce mipmap banding
    viewer.scene.globe.showGroundAtmosphere = enableGroundAtmosphere
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a2e')

    // Try to enable maximum anisotropic filtering for better texture quality at oblique angles
    const gl = viewer.scene.context._gl as WebGL2RenderingContext | null
    if (gl) {
      const ext = gl.getExtension('EXT_texture_filter_anisotropic') ||
                  gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
                  gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
      if (ext) {
        const maxAnisotropy = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
        console.log(`Anisotropic filtering available, max level: ${maxAnisotropy}`)
      }
    }

    // Shadows - from settings, but disabled for insets for performance
    // Uses cascaded shadow maps with configurable settings
    if (isInset) {
      viewer.shadows = false
      viewer.terrainShadows = Cesium.ShadowMode.DISABLED
    } else {
      viewer.shadows = enableShadows
      if (enableShadows) {
        viewer.shadowMap.softShadows = shadowSoftness
        viewer.shadowMap.size = shadowMapSize
        viewer.shadowMap.numberOfCascades = shadowCascades
        viewer.shadowMap.maximumDistance = shadowMaxDistance
        viewer.shadowMap.darkness = shadowDarkness
        viewer.shadowMap.fadingEnabled = shadowFadingEnabled
        viewer.shadowMap.normalOffset = shadowNormalOffset
        viewer.terrainShadows = Cesium.ShadowMode.ENABLED
      } else {
        viewer.terrainShadows = Cesium.ShadowMode.DISABLED
      }
    }

    // Enable clock animation for model animations (propellers, etc.)
    viewer.clock.shouldAnimate = true

    // In-memory tile cache - reduced for insets (50 vs user setting)
    viewer.scene.globe.tileCacheSize = isInset ? 50 : useSettingsStore.getState().inMemoryTileCacheSize

    // Tile quality - insets use higher screen space error (lower quality) for performance
    if (isInset) {
      viewer.scene.globe.maximumScreenSpaceError = 16  // Lower quality tiles
    }

    // Preload nearby tiles for smoother camera movement (disabled for insets)
    viewer.scene.globe.preloadAncestors = !isInset
    viewer.scene.globe.preloadSiblings = !isInset

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

    // Create aircraft model pool using Cesium.Model primitives for non-uniform scaling
    // Models from Flightradar24/fr24-3d-models (GPL-2.0, originally from FlightGear)
    // Default to B738, will be updated dynamically based on aircraft type
    const defaultModelUrl = './b738.glb'

    // Load models asynchronously into the pool
    let modelsLoaded = 0
    for (let i = 0; i < CONE_POOL_SIZE; i++) {
      modelPoolAssignmentsRef.current.set(i, null)
      modelPoolUrlsRef.current.set(i, defaultModelUrl)

      Cesium.Model.fromGltfAsync({
        url: defaultModelUrl,
        show: false,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        shadows: Cesium.ShadowMode.ENABLED,
        color: MODEL_DEFAULT_COLOR,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: MODEL_COLOR_BLEND_AMOUNT
      }).then(model => {
        if (viewer.isDestroyed()) return
        viewer.scene.primitives.add(model)
        modelPoolRef.current.set(i, model)
        modelsLoaded++
        if (modelsLoaded === CONE_POOL_SIZE) {
          modelPoolReadyRef.current = true
          console.log(`Created aircraft model pool with ${CONE_POOL_SIZE} primitives`)
        }
      }).catch(err => {
        console.error(`Failed to load model for pool slot ${i}:`, err)
      })
    }

    // Cleanup on unmount or when MSAA changes
    // Capture refs at effect time for cleanup (intentionally clearing them)
    const modelPool = modelPoolRef.current
    const modelPoolAssignments = modelPoolAssignmentsRef.current
    const modelPoolUrls = modelPoolUrlsRef.current
    const modelPoolLoading = modelPoolLoadingRef.current
    const modelAnimationsConfigured = modelAnimationsConfiguredRef.current
    const propellerStates = propellerStatesRef.current
    const babylonCanvas = babylonCanvasRef.current

    return () => {
      viewer.destroy()
      viewerRef.current = null
      setCesiumViewer(null)

      // Reset model pool state so it can be recreated
      modelPool.clear()
      modelPoolAssignments.clear()
      modelPoolUrls.clear()
      modelPoolLoading.clear()
      modelPoolReadyRef.current = false
      modelAnimationsConfigured.clear()
      propellerStates.clear()

      // Reset other state
      rootNodeSetupRef.current = false
      terrainOffsetReadyRef.current = false

      // Remove Babylon canvas so it can be recreated
      if (babylonCanvas && babylonCanvas.parentNode) {
        babylonCanvas.parentNode.removeChild(babylonCanvas)
      }
      babylonCanvasRef.current = null
      babylonCanvasCreatedRef.current = false
      setBabylonCanvas(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- graphics settings used at init only; runtime updates handled by separate useEffect
  }, [cesiumIonToken, isInset, msaaSamples])

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

  // Update Cesium fog based on weather effects and METAR visibility
  // Cesium fog primarily reduces draw distance and fades terrain/imagery
  useEffect(() => {
    if (!cesiumViewer) return

    const shouldShowFog = showWeatherEffects && showCesiumFog
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
  }, [cesiumViewer, showWeatherEffects, showCesiumFog, fogDensity])

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

  // Update experimental graphics settings at runtime
  // Note: MSAA samples cannot be changed at runtime (requires viewer recreation)
  useEffect(() => {
    if (!cesiumViewer || isInset) return

    // Update FXAA
    cesiumViewer.scene.fxaa = enableFxaa

    // Update HDR
    cesiumViewer.scene.highDynamicRange = enableHdr

    // Update logarithmic depth buffer
    cesiumViewer.scene.logarithmicDepthBuffer = enableLogDepth

    // Update ground atmosphere
    cesiumViewer.scene.globe.showGroundAtmosphere = enableGroundAtmosphere

    // Update lighting
    cesiumViewer.scene.globe.enableLighting = enableLighting

    // Update shadows - use cascaded shadow maps with configurable settings
    cesiumViewer.shadows = enableShadows
    if (enableShadows) {
      cesiumViewer.shadowMap.softShadows = shadowSoftness
      cesiumViewer.shadowMap.size = shadowMapSize
      cesiumViewer.shadowMap.numberOfCascades = shadowCascades
      cesiumViewer.shadowMap.maximumDistance = shadowMaxDistance
      cesiumViewer.shadowMap.darkness = shadowDarkness
      cesiumViewer.shadowMap.fadingEnabled = shadowFadingEnabled
      cesiumViewer.shadowMap.normalOffset = shadowNormalOffset
      cesiumViewer.terrainShadows = Cesium.ShadowMode.ENABLED
    } else {
      cesiumViewer.terrainShadows = Cesium.ShadowMode.DISABLED
    }

    console.log(`Graphics settings updated: FXAA=${enableFxaa}, HDR=${enableHdr}, LogDepth=${enableLogDepth}, GroundAtmo=${enableGroundAtmosphere}, Lighting=${enableLighting}, Shadows=${enableShadows}`)
  }, [cesiumViewer, isInset, enableFxaa, enableHdr, enableLogDepth, enableGroundAtmosphere, enableLighting, enableShadows, shadowMapSize, shadowCascades, shadowMaxDistance, shadowDarkness, shadowSoftness, shadowFadingEnabled, shadowNormalOffset])

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
  // Skip loading buildings for inset viewports to reduce memory usage and prevent WebGL context issues
  useEffect(() => {
    if (!cesiumViewer) return
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
  }, [cesiumViewer, show3DBuildings, isInset])

  // Calculate terrain offset when airport changes or when in orbit mode without airport
  // This corrects for the difference between MSL and ellipsoidal height
  useEffect(() => {
    if (!cesiumViewer) {
      terrainOffsetReadyRef.current = false
      return
    }

    // For airport mode, calculate terrain offset at tower position
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      const groundElevationMsl = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0

      // Sample terrain to calculate offset between MSL and actual terrain height
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
      return
    }

    // For orbit mode without airport, use default offset (will be recalculated per-aircraft as needed)
    if (followMode === 'orbit' && followingCallsign) {
      terrainOffsetRef.current = 0
      terrainOffsetReadyRef.current = true
      return
    }

    // No airport and not in orbit mode - reset
    terrainOffsetReadyRef.current = false
  }, [cesiumViewer, currentAirport, towerHeight, followMode, followingCallsign])

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
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      babylonOverlay.setupRootNode(towerPos.latitude, towerPos.longitude, towerPos.height)
      rootNodeSetupRef.current = true

      // Set reference position for VATSIM filtering - only store aircraft near tower
      setRefPosIfChanged(towerPos.latitude, towerPos.longitude)
      return
    }

    // If in orbit mode following an aircraft without airport, use aircraft position as root
    if (followMode === 'orbit' && followingCallsign) {
      // Try interpolated data first, fall back to raw store data (read directly to avoid reactive dependency)
      const interpolated = interpolatedAircraft.get(followingCallsign)
      const rawAircraft = useVatsimStore.getState().aircraftStates.get(followingCallsign)

      // Use interpolated if available, otherwise use raw store data
      const lat = interpolated?.interpolatedLatitude ?? rawAircraft?.latitude
      const lon = interpolated?.interpolatedLongitude ?? rawAircraft?.longitude
      const alt = interpolated?.interpolatedAltitude ?? rawAircraft?.altitude

      if (lat !== undefined && lon !== undefined && alt !== undefined) {
        const altitudeMeters = alt * 0.3048
        babylonOverlay.setupRootNode(lat, lon, altitudeMeters)
        rootNodeSetupRef.current = true

        // Set reference position to followed aircraft for VATSIM filtering
        setRefPosIfChanged(lat, lon)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally using specific babylonOverlay properties
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
    let refAltitudeFeet = 0  // Reference altitude for 3D slant range calculation
    let isOrbitModeWithoutAirport = false

    if (followMode === 'orbit' && followingCallsign) {
      // Try interpolated data first, fall back to raw store data
      const followedAircraft = interpolatedAircraft.get(followingCallsign)
      const rawAircraft = useVatsimStore.getState().aircraftStates.get(followingCallsign)

      if (followedAircraft) {
        refLat = followedAircraft.interpolatedLatitude
        refLon = followedAircraft.interpolatedLongitude
        refElevationMeters = followedAircraft.interpolatedAltitude * 0.3048
        refAltitudeFeet = followedAircraft.interpolatedAltitude
        isOrbitModeWithoutAirport = !currentAirport
      } else if (rawAircraft) {
        // Fallback to raw store data if interpolated not yet available
        refLat = rawAircraft.latitude
        refLon = rawAircraft.longitude
        refElevationMeters = rawAircraft.altitude * 0.3048
        refAltitudeFeet = rawAircraft.altitude
        isOrbitModeWithoutAirport = !currentAirport
      } else if (currentAirport) {
        const towerPos = getTowerPosition(currentAirport, towerHeight)
        refLat = towerPos.latitude
        refLon = towerPos.longitude
        refElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
        // Tower altitude = ground elevation + tower height (convert tower height from meters to feet)
        refAltitudeFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)
      } else {
        return // No reference point available
      }
    } else if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      refLat = towerPos.latitude
      refLon = towerPos.longitude
      refElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
      // Tower altitude = ground elevation + tower height (convert tower height from meters to feet)
      refAltitudeFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)
    } else {
      return // Need either an airport or orbit mode with a followed aircraft
    }

    const seenCallsigns = new Set<string>()

    // Sort aircraft by distance and limit count (using 3D slant range)
    const sortedAircraft = [...interpolatedAircraft.values()]
      .map((aircraft) => ({
        ...aircraft,
        distance: calculateDistanceNM(
          refLat,
          refLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          refAltitudeFeet,
          aircraft.interpolatedAltitude
        )
      }))
      .filter((aircraft) => {
        // Always include the followed aircraft regardless of distance
        if (aircraft.callsign === followingCallsign) return true

        // Filter by distance
        if (aircraft.distance > labelVisibilityDistance) return false

        // Filter by traffic type - use altitude above ground level (AGL) for accurate ground detection
        // In orbit mode without airport, show all traffic types
        if (!isOrbitModeWithoutAirport) {
          // Calculate AGL in feet - use 200ft threshold to account for pressure altitude variations
          // At high-elevation airports (e.g., KRNO at 4,517ft), absolute altitude would misclassify ground traffic
          const airportElevationFeet = currentAirport?.elevation || 0
          const aglFeet = aircraft.interpolatedAltitude - airportElevationFeet
          const isAirborne = aglFeet > 200
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
      altitudeMetersAGL: number
      distanceMeters: number
    }> = []

    for (const aircraft of sortedAircraft) {
      seenCallsigns.add(aircraft.callsign)

      // Calculate altitude in meters
      const altitudeMeters = aircraft.interpolatedAltitude * 0.3048

      // Use altitude above ground level (AGL) for airborne detection
      // 60m (~200ft) threshold accounts for pressure altitude variations at high-elevation airports
      const aglMeters = altitudeMeters - groundElevationMeters
      const isAirborne = aglMeters > 60
      const isFollowed = followingCallsign === aircraft.callsign

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

      // Top-down view scaling: keep real scale when zoomed in, scale up when zoomed out
      // This preserves relative aircraft sizes for conflict detection while ensuring visibility
      const referenceAltitude = 6000
      const altitudeBasedScale = topdownAltitude / referenceAltitude
      const viewModeScale = viewMode === 'topdown'
        ? Math.max(1.0, altitudeBasedScale)  // Never shrink below real size
        : 1.0

      // Use model from pool - find or assign a pool slot for this aircraft
      if (modelPoolReadyRef.current && terrainOffsetReadyRef.current) {
        // Calculate model position with terrain offset correction and height offset to prevent ground clipping
        const modelHeight = heightAboveEllipsoid + terrainOffsetRef.current + MODEL_HEIGHT_OFFSET

        // Find existing pool slot for this callsign, or get an unused one
        let poolIndex = -1
        for (const [idx, assignedCallsign] of modelPoolAssignmentsRef.current.entries()) {
          if (assignedCallsign === aircraft.callsign) {
            poolIndex = idx
            break
          }
        }
        if (poolIndex === -1) {
          // Find an unused slot
          for (const [idx, assignedCallsign] of modelPoolAssignmentsRef.current.entries()) {
            if (assignedCallsign === null) {
              poolIndex = idx
              modelPoolAssignmentsRef.current.set(idx, aircraft.callsign)
              break
            }
          }
        }

        if (poolIndex !== -1) {
          const model = modelPoolRef.current.get(poolIndex)
          if (model) {
            // Get the correct model info for this aircraft type
            const modelInfo = aircraftModelService.getModelInfo(aircraft.aircraftType)
            const currentModelUrl = modelPoolUrlsRef.current.get(poolIndex)

            // If model URL changed, load the new model asynchronously
            if (currentModelUrl !== modelInfo.modelUrl && !modelPoolLoadingRef.current.has(poolIndex)) {
              modelPoolLoadingRef.current.add(poolIndex)
              modelPoolUrlsRef.current.set(poolIndex, modelInfo.modelUrl)

              // Load new model in background
              Cesium.Model.fromGltfAsync({
                url: modelInfo.modelUrl,
                show: false,
                modelMatrix: model.modelMatrix,  // Copy current transform
                shadows: Cesium.ShadowMode.ENABLED,
                color: model.color,
                colorBlendMode: Cesium.ColorBlendMode.MIX,
                colorBlendAmount: MODEL_COLOR_BLEND_AMOUNT
              }).then(newModel => {
                if (viewer.isDestroyed()) return

                // Remove old model from scene
                const oldModel = modelPoolRef.current.get(poolIndex)
                if (oldModel) {
                  viewer.scene.primitives.remove(oldModel)
                }

                // Add new model to scene and update pool
                viewer.scene.primitives.add(newModel)
                modelPoolRef.current.set(poolIndex, newModel)
                modelAnimationsConfiguredRef.current.delete(poolIndex)
                modelPoolLoadingRef.current.delete(poolIndex)
              }).catch(err => {
                console.error(`Failed to load model ${modelInfo.modelUrl}:`, err)
                modelPoolLoadingRef.current.delete(poolIndex)
                // Reset URL to trigger retry on next frame
                modelPoolUrlsRef.current.set(poolIndex, './b738.glb')
              })
            }

            // Build modelMatrix with position, rotation, and non-uniform scale
            const position = Cesium.Cartesian3.fromDegrees(
              aircraft.interpolatedLongitude,
              aircraft.interpolatedLatitude,
              modelHeight
            )

            // Model heading: Cesium models typically face +X, so heading=0 means east
            // Subtract 90 to convert from compass heading (north=0) to model heading
            // Add 180° to flip models that face backwards
            // Pitch: Cesium uses positive pitch for nose-down, so negate for intuitive behavior
            // Roll: Applied directly from interpolated value
            const hpr = new Cesium.HeadingPitchRoll(
              Cesium.Math.toRadians(aircraft.interpolatedHeading - 90 + 180),
              Cesium.Math.toRadians(-aircraft.interpolatedPitch),
              Cesium.Math.toRadians(aircraft.interpolatedRoll)
            )

            // Create base transformation matrix (translation + rotation)
            const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)

            // Apply non-uniform scale (viewModeScale is uniform, modelInfo.scale is per-axis)
            const totalScaleX = viewModeScale * modelInfo.scale.x
            const totalScaleY = viewModeScale * modelInfo.scale.y
            const totalScaleZ = viewModeScale * modelInfo.scale.z
            const scaleMatrix = Cesium.Matrix4.fromScale(
              new Cesium.Cartesian3(totalScaleX, totalScaleY, totalScaleZ)
            )
            Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, modelMatrix)

            // Apply the transformation
            model.modelMatrix = modelMatrix

            // Apply color blend - full white in topdown, subtle tint in 3D to preserve textures
            if (viewMode === 'topdown') {
              model.color = Cesium.Color.WHITE
              model.colorBlendAmount = 1.0  // Full white for 2D visibility
            } else {
              model.color = MODEL_DEFAULT_COLOR
              model.colorBlendAmount = MODEL_COLOR_BLEND_AMOUNT  // Subtle blend preserves textures
            }

            // Update propeller animation based on groundspeed
            let propState = propellerStatesRef.current.get(aircraft.callsign)
            if (!propState) {
              propState = createPropellerState()
              propellerStatesRef.current.set(aircraft.callsign, propState)
            }

            const newPropState = updatePropellerState(
              propState,
              aircraft.interpolatedGroundspeed,
              !isAirborne
            )
            propellerStatesRef.current.set(aircraft.callsign, newPropState)

            // Configure animation on the Model primitive if not already done
            if (!modelAnimationsConfiguredRef.current.has(poolIndex) && model.ready) {
              const animations = model.activeAnimations
              if (animations.length === 0) {
                // Store propeller state reference on the model for the callback
                const modelWithState = model as Cesium.Model & { _propStateRef?: { current: PropellerState } }
                modelWithState._propStateRef = { current: newPropState }

                animations.addAll({
                  loop: Cesium.ModelAnimationLoop.REPEAT,
                  animationTime: (duration: number) => {
                    const state = modelWithState._propStateRef?.current
                    if (state) {
                      return getPropellerAnimationTime(state, duration)
                    }
                    return 0
                  }
                })
                modelAnimationsConfiguredRef.current.add(poolIndex)
              }
            } else {
              // Update the propeller state reference for the animation callback
              const modelWithState = model as Cesium.Model & { _propStateRef?: { current: PropellerState } }
              if (modelWithState._propStateRef) {
                modelWithState._propStateRef.current = newPropState
              }
            }

            // Show the model
            model.show = true
          }
        }
      }

      // Update Babylon overlay for labels (Cesium handles 3D aircraft models)
      babylonOverlay.updateAircraftLabel(
        aircraft.callsign,
        babylonColor,
        isFollowed,
        labelText
      )

      // Store the Cesium position for screen projection
      const cesiumPosition = modelPoolReadyRef.current && terrainOffsetReadyRef.current
        ? Cesium.Cartesian3.fromDegrees(
            aircraft.interpolatedLongitude,
            aircraft.interpolatedLatitude,
            heightAboveEllipsoid + terrainOffsetRef.current
          )
        : null

      // Calculate aircraft altitude AGL (above ground level) in meters
      const altitudeMetersAGL = altitudeMeters - groundElevationMeters

      // Distance in meters (aircraft.distance is in NM, 1 NM = 1852 meters)
      const distanceMeters = aircraft.distance * 1852

      aircraftData.push({
        callsign: aircraft.callsign,
        isAirborne,
        isFollowed,
        labelText,
        color: babylonColor,
        cesiumPosition,
        altitudeMetersAGL,
        distanceMeters
      })
    }

    // Hide all labels first, then show only visible ones
    babylonOverlay.hideAllLabels()

    // Get camera altitude for weather visibility checks
    // Camera position in cartographic coordinates gives us altitude above ellipsoid
    const cameraCartographic = viewer.camera.positionCartographic
    // Convert camera altitude to AGL (approximate - subtract ground elevation at reference point)
    const cameraAltitudeAGL = cameraCartographic
      ? cameraCartographic.height - groundElevationMeters
      : towerHeight // Fallback to tower height if camera position unavailable

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

      // Check weather visibility - hide datablocks obscured by clouds or beyond visibility range
      // Always show the followed aircraft's datablock regardless of weather
      if (!data.isFollowed && !babylonOverlay.isDatablockVisibleByWeather(
        cameraAltitudeAGL,
        data.altitudeMetersAGL,
        data.distanceMeters
      )) {
        continue // Skip this aircraft - datablock hidden by weather
      }

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

    // Clean up any Babylon labels that are no longer in the visible set
    const babylonCallsigns = babylonOverlay.getAircraftCallsigns()
    for (const callsign of babylonCallsigns) {
      if (!seenCallsigns.has(callsign)) {
        babylonOverlay.removeAircraftLabel(callsign)
      }
    }

    // Clean up propeller states for aircraft no longer visible
    for (const callsign of propellerStatesRef.current.keys()) {
      if (!seenCallsigns.has(callsign)) {
        propellerStatesRef.current.delete(callsign)
      }
    }

    // Hide unused pool models and clean up references to prevent memory leaks
    for (const [idx, assignedCallsign] of modelPoolAssignmentsRef.current.entries()) {
      if (assignedCallsign !== null && !seenCallsigns.has(assignedCallsign)) {
        // Release this slot and hide the model
        modelPoolAssignmentsRef.current.set(idx, null)
        const model = modelPoolRef.current.get(idx)
        if (model) {
          model.show = false

          // CRITICAL: Clear the propeller state reference to break closure memory leak
          const modelWithRef = model as Cesium.Model & { _propStateRef?: { current: PropellerState } }
          if (modelWithRef._propStateRef) {
            modelWithRef._propStateRef = undefined
          }

          // Clear animation configured flag so animations can be reconfigured for next aircraft
          modelAnimationsConfiguredRef.current.delete(idx)

          // Reset model URL tracking (next aircraft may need different model)
          modelPoolUrlsRef.current.set(idx, './b738.glb')
        }
      }
    }
  }, [
    interpolatedAircraft,
    // Note: aircraftStates read via getState() - not included to avoid render loops
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
    topdownAltitude,
    datablockMode
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

      // Update camera position for nearest METAR mode when in orbit mode without airport
      // This enables weather to update based on camera location when flying around freely
      if (showWeatherEffects && followMode === 'orbit' && followingCallsign && !currentAirport) {
        const cameraCartographic = viewer.camera.positionCartographic
        if (cameraCartographic) {
          const lat = Cesium.Math.toDegrees(cameraCartographic.latitude)
          const lon = Cesium.Math.toDegrees(cameraCartographic.longitude)
          updateCameraPosition(lat, lon)
        }
      }
    })

    return () => {
      removePostRender()
    }
  }, [cesiumViewer, babylonOverlay, updateAircraftEntities, showWeatherEffects, followMode, followingCallsign, currentAirport, updateCameraPosition])

  // Memory diagnostic logging - logs counters every 5 seconds
  useEffect(() => {
    let swCacheStats = { count: 0, sizeBytes: 0 }

    const logMemoryCounters = async () => {
      const counters = getMemoryCounters()
      const babylonMeshes = babylonOverlay.getAircraftCallsigns().length
      const poolUsed = [...modelPoolAssignmentsRef.current.values()].filter(v => v !== null).length

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

  // Measuring mode event handlers
  useEffect(() => {
    if (!cesiumViewer || !isMeasuring) {
      // Clear preview when not measuring
      setPreviewPoint(null)
      return
    }

    const handler = new Cesium.ScreenSpaceEventHandler(cesiumViewer.scene.canvas)

    // Helper to pick terrain position
    const pickTerrainPosition = (position: Cesium.Cartesian2) => {
      const cartesian = cesiumViewer.scene.pickPosition(position)
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
        const p1Screen = Cesium.SceneTransforms.worldToWindowCoordinates(cesiumViewer.scene, m.point1.cartesian)
        if (p1Screen) {
          const dx = p1Screen.x - screenPos.x
          const dy = p1Screen.y - screenPos.y
          if (Math.sqrt(dx * dx + dy * dy) < threshold) {
            return m.id
          }
        }
        // Check point2
        const p2Screen = Cesium.SceneTransforms.worldToWindowCoordinates(cesiumViewer.scene, m.point2.cartesian)
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
  }, [cesiumViewer, isMeasuring, measurements, pendingPoint, setPendingPoint, setPreviewPoint, completeMeasurement, cancelPendingMeasurement, removeMeasurement])

  return (
    <div className={`cesium-viewer-container ${isInset ? 'inset' : ''}`} ref={containerRef} />
  )
}

export default CesiumViewer
