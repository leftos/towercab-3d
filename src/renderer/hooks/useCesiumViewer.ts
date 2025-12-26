import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import {
  CONE_POOL_SIZE,
  getModelColorRgb,
  getModelColorBlendAmount
} from '../constants/rendering'

export interface CesiumViewerSettings {
  /** Cesium Ion access token for terrain/imagery */
  cesiumIonToken: string
  /** Whether this is an inset viewport (uses reduced settings for performance) */
  isInset: boolean
  /** MSAA samples (2, 4, 8, etc.) */
  msaaSamples: number
  /** Enable sun-based lighting */
  enableLighting: boolean
  /** Enable logarithmic depth buffer */
  enableLogDepth: boolean
  /** Enable high dynamic range rendering */
  enableHdr: boolean
  /** Enable FXAA anti-aliasing */
  enableFxaa: boolean
  /** Enable ambient occlusion */
  enableAmbientOcclusion: boolean
  /** Enable silhouette outlines for built-in aircraft models */
  enableAircraftSilhouettes: boolean
  /** Enable ground atmosphere effects */
  enableGroundAtmosphere: boolean
  /** Enable shadows */
  enableShadows: boolean
  /** Shadow map size */
  shadowMapSize: number
  /** Shadow maximum distance */
  shadowMaxDistance: number
  /** Shadow darkness */
  shadowDarkness: number
  /** Shadow softness */
  shadowSoftness: boolean
  /** Shadow fading enabled */
  shadowFadingEnabled: boolean
  /** Shadow normal offset */
  shadowNormalOffset: boolean
  /** In-memory tile cache size */
  inMemoryTileCacheSize: number
  /** Model brightness multiplier (0.5-1.5) */
  modelBrightness: number
}

export interface ModelPoolRefs {
  /** Map of pool index to Cesium.Model primitive */
  modelPool: React.MutableRefObject<Map<number, Cesium.Model>>
  /** Map of pool index to callsign (null if unused) */
  modelPoolAssignments: React.MutableRefObject<Map<number, string | null>>
  /** Map of pool index to current model URL */
  modelPoolUrls: React.MutableRefObject<Map<number, string>>
  /** Set of pool indices currently loading a new model */
  modelPoolLoading: React.MutableRefObject<Set<number>>
  /** Flag indicating all pool models are loaded */
  modelPoolReady: React.MutableRefObject<boolean>
}

export interface SilhouetteRefs {
  /** Edge detection stage for aircraft silhouettes (update .selected array with models) */
  edgeDetection: React.MutableRefObject<Cesium.PostProcessStage | null>
  /** Silhouette composite stage (toggle .enabled to show/hide) */
  silhouetteStage: React.MutableRefObject<Cesium.PostProcessStageComposite | null>
}

/**
 * Creates and configures a Cesium.Viewer instance with aircraft model pool
 *
 * ## Responsibilities
 * - Create Cesium.Viewer with terrain and imagery providers
 * - Configure scene rendering quality (HDR, FXAA, AO, etc.)
 * - Initialize shadow maps with quality settings
 * - Create aircraft model pool (100 pre-loaded B738 models)
 * - Handle viewer cleanup and pool destruction
 *
 * ## Model Pool
 * Pre-creates 100 Cesium.Model primitives to avoid per-aircraft load overhead.
 * Models use:
 * - Default: B738 (Boeing 737-800) from Flightradar24/fr24-3d-models (GPL-2.0)
 * - MIX color blend mode for subtle tinting
 * - Non-uniform scaling support via Cesium.Model primitives
 * - Shadow casting enabled
 *
 * ## Performance Optimizations
 * Inset viewports use reduced settings:
 * - MSAA: 2x instead of user setting
 * - Shadows: Disabled
 * - Tile cache: 50 tiles instead of user setting
 * - Screen space error: 16 (lower quality)
 * - Tile preloading: Disabled
 *
 * ## Initialization Order
 * 1. Set Cesium Ion token
 * 2. Create viewer with UI disabled
 * 3. Configure scene (lighting, fog, depth test)
 * 4. Apply rendering quality settings
 * 5. Configure shadows (if enabled)
 * 6. Set tile cache size
 * 7. Initialize model pool asynchronously
 *
 * @param containerRef - React ref to the container div element
 * @param viewportId - Unique identifier for this viewport
 * @param settings - Viewer configuration settings
 *
 * @returns Object containing viewer instance and model pool refs
 *
 * @example
 * ```tsx
 * const containerRef = useRef<HTMLDivElement>(null)
 * const { viewer, modelPoolRefs } = useCesiumViewer(containerRef, 'main', {
 *   cesiumIonToken: 'your-token',
 *   isInset: false,
 *   msaaSamples: 4,
 *   enableLighting: true,
 *   // ... other settings
 * })
 * ```
 */
export function useCesiumViewer(
  containerRef: React.RefObject<HTMLDivElement>,
  viewportId: string,
  settings: CesiumViewerSettings
): {
  viewer: Cesium.Viewer | null
  modelPoolRefs: ModelPoolRefs
  silhouetteRefs: SilhouetteRefs
} {
  const {
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
    modelBrightness
  } = settings

  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null)

  // Model pool refs
  const modelPoolRef = useRef<Map<number, Cesium.Model>>(new Map())
  const modelPoolAssignmentsRef = useRef<Map<number, string | null>>(new Map())
  const modelPoolUrlsRef = useRef<Map<number, string>>(new Map())
  const modelPoolLoadingRef = useRef<Set<number>>(new Set())
  const modelPoolReadyRef = useRef<boolean>(false)

  // Silhouette refs for aircraft outline rendering
  const edgeDetectionRef = useRef<Cesium.PostProcessStage | null>(null)
  const silhouetteStageRef = useRef<Cesium.PostProcessStageComposite | null>(null)

  // Initialize Cesium viewer
  // This effect re-runs when MSAA changes, recreating the viewer with new settings
  useEffect(() => {
    // Require a valid Cesium Ion token before creating the viewer
    // Without a token, terrain and imagery loading will fail
    if (!containerRef.current || !cesiumIonToken) return

    // If viewer already exists, destroy it before recreating
    // This handles token changes (e.g., user entering token after first launch)
    if (viewerRef.current) {
      viewerRef.current.destroy()
      viewerRef.current = null
      setViewer(null)
      modelPoolRef.current.clear()
      modelPoolAssignmentsRef.current.clear()
      modelPoolUrlsRef.current.clear()
      modelPoolLoadingRef.current.clear()
      modelPoolReadyRef.current = false
      edgeDetectionRef.current = null
      silhouetteStageRef.current = null
    }

    // Log MSAA setting for debugging
    const effectiveMsaa = isInset ? 2 : msaaSamples

    // Set Ion access token
    Cesium.Ion.defaultAccessToken = cesiumIonToken

    // Create viewer with default terrain and imagery
    // Insets use reduced quality for performance
    const newViewer = new Cesium.Viewer(containerRef.current, {
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
      msaaSamples: effectiveMsaa
    })

    // Configure scene - use settings from store
    newViewer.scene.globe.enableLighting = enableLighting
    newViewer.scene.fog.enabled = true
    newViewer.scene.globe.depthTestAgainstTerrain = true

    // Rendering quality improvements - from settings
    newViewer.scene.logarithmicDepthBuffer = enableLogDepth
    newViewer.scene.highDynamicRange = enableHdr
    newViewer.scene.postProcessStages.fxaa.enabled = enableFxaa
    newViewer.scene.postProcessStages.ambientOcclusion.enabled = enableAmbientOcclusion

    // Aircraft silhouette outlines - creates edge detection for built-in models
    // The selected array will be populated by useAircraftModels with built-in models only
    if (!isInset) {
      const edgeDetection = Cesium.PostProcessStageLibrary.createEdgeDetectionStage()
      edgeDetection.uniforms.color = Cesium.Color.BLACK
      edgeDetection.uniforms.length = 0.5  // Outline width in pixels
      edgeDetection.selected = []  // Will be populated by useAircraftModels

      const silhouetteStage = newViewer.scene.postProcessStages.add(
        Cesium.PostProcessStageLibrary.createSilhouetteStage([edgeDetection])
      ) as Cesium.PostProcessStageComposite
      silhouetteStage.enabled = enableAircraftSilhouettes

      edgeDetectionRef.current = edgeDetection
      silhouetteStageRef.current = silhouetteStage
    }

    // Improve texture quality - helps reduce mipmap banding
    newViewer.scene.globe.showGroundAtmosphere = enableGroundAtmosphere
    newViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a2e')

    // Shadows - from settings, but disabled for insets for performance
    // Uses cascaded shadow maps with configurable settings
    if (isInset) {
      newViewer.shadows = false
      newViewer.terrainShadows = Cesium.ShadowMode.DISABLED
    } else {
      newViewer.shadows = enableShadows
      if (enableShadows) {
        newViewer.shadowMap.softShadows = shadowSoftness
        newViewer.shadowMap.size = shadowMapSize
        // Note: numberOfCascades is not configurable in Cesium API (only 1 or 4 cascades supported internally)
        newViewer.shadowMap.maximumDistance = shadowMaxDistance
        newViewer.shadowMap.darkness = shadowDarkness
        newViewer.shadowMap.fadingEnabled = shadowFadingEnabled
        newViewer.shadowMap.normalOffset = shadowNormalOffset
        newViewer.terrainShadows = Cesium.ShadowMode.ENABLED
      } else {
        newViewer.terrainShadows = Cesium.ShadowMode.DISABLED
      }
    }

    // In-memory tile cache - reduced for insets (50 vs user setting)
    newViewer.scene.globe.tileCacheSize = isInset ? 50 : inMemoryTileCacheSize

    // Patch Cesium's tile eviction to be less aggressive (main viewport only)
    // Cesium's TileReplacementQueue.trimTiles() evicts tiles every frame when
    // the count exceeds tileCacheSize. By overriding it to use 10x the limit,
    // we dramatically reduce eviction frequency and keep more tiles in memory.
    if (!isInset) {
      const surface = (newViewer.scene.globe as unknown as { _surface?: { _tileReplacementQueue?: { trimTiles: (max: number) => void } } })._surface
      if (surface?._tileReplacementQueue) {
        const queue = surface._tileReplacementQueue
        const originalTrimTiles = queue.trimTiles.bind(queue)
        queue.trimTiles = function(maximumTiles: number) {
          // Use 10x the limit to dramatically reduce eviction
          originalTrimTiles(maximumTiles * 10)
        }
      }
    }

    // Tile quality - insets use higher screen space error (lower quality) for performance
    if (isInset) {
      newViewer.scene.globe.maximumScreenSpaceError = 16  // Lower quality tiles
    }

    // Preload nearby tiles for smoother camera movement (disabled for insets)
    newViewer.scene.globe.preloadAncestors = !isInset
    newViewer.scene.globe.preloadSiblings = !isInset

    // Suppress verbose tile loading errors (transient, Cesium retries automatically)
    const imageryLayers = newViewer.imageryLayers
    if (imageryLayers.length > 0) {
      const baseLayer = imageryLayers.get(0)
      const removeListener = baseLayer.readyEvent.addEventListener((provider) => {
        removeListener()
        if (!newViewer.isDestroyed() && provider.errorEvent) {
          provider.errorEvent.addEventListener(() => {
            // Silently ignore - these are usually transient network issues
          })
        }
      })
    }

    viewerRef.current = newViewer
    setViewer(newViewer)

    // Create aircraft model pool using Cesium.Model primitives for non-uniform scaling
    // Models from Flightradar24/fr24-3d-models (GPL-2.0, originally from FlightGear)
    // Default to B738, will be updated dynamically based on aircraft type
    const defaultModelUrl = './b738.glb'

    // Calculate model color and blend amount based on brightness setting
    const modelColorRgb = getModelColorRgb(modelBrightness)
    const modelColor = new Cesium.Color(...modelColorRgb, 1.0)
    const blendAmount = getModelColorBlendAmount(modelBrightness)

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
        color: modelColor,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: blendAmount
      }).then(model => {
        if (newViewer.isDestroyed()) return
        newViewer.scene.primitives.add(model)
        modelPoolRef.current.set(i, model)
        modelsLoaded++
        if (modelsLoaded === CONE_POOL_SIZE) {
          modelPoolReadyRef.current = true
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

    return () => {
      newViewer.destroy()
      viewerRef.current = null
      setViewer(null)

      // Reset model pool state so it can be recreated
      modelPool.clear()
      modelPoolAssignments.clear()
      modelPoolUrls.clear()
      modelPoolLoading.clear()
      modelPoolReadyRef.current = false

      // Reset silhouette refs
      edgeDetectionRef.current = null
      silhouetteStageRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- graphics settings used at init only; runtime updates handled by separate hooks
  }, [cesiumIonToken, isInset, msaaSamples, viewportId])

  // Update model colors and blend amount when brightness setting changes
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Calculate new color and blend amount based on brightness
    const modelColorRgb = getModelColorRgb(modelBrightness)
    const newModelColor = new Cesium.Color(...modelColorRgb, 1.0)
    const newBlendAmount = getModelColorBlendAmount(modelBrightness)

    // Update all models in the pool with new color and blend amount
    modelPoolRef.current.forEach((model) => {
      model.color = newModelColor
      model.colorBlendAmount = newBlendAmount
    })
  }, [viewer, modelBrightness])

  // Update silhouette enabled state when setting changes
  useEffect(() => {
    if (silhouetteStageRef.current) {
      silhouetteStageRef.current.enabled = enableAircraftSilhouettes
    }
  }, [enableAircraftSilhouettes])

  return {
    viewer,
    modelPoolRefs: {
      modelPool: modelPoolRef,
      modelPoolAssignments: modelPoolAssignmentsRef,
      modelPoolUrls: modelPoolUrlsRef,
      modelPoolLoading: modelPoolLoadingRef,
      modelPoolReady: modelPoolReadyRef
    },
    silhouetteRefs: {
      edgeDetection: edgeDetectionRef,
      silhouetteStage: silhouetteStageRef
    }
  }
}
