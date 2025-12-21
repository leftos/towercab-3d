import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'

// Model rendering constants
const MODEL_DEFAULT_COLOR = new Cesium.Color(0.9, 0.9, 0.9, 1.0)  // Light gray tint for MIX mode
const MODEL_COLOR_BLEND_AMOUNT = 0.15  // Subtle blend to preserve original textures (0=original, 1=full tint)

// Model pool size - pre-create this many Model primitives at init time
const CONE_POOL_SIZE = 100

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
    enableGroundAtmosphere,
    enableShadows,
    shadowMapSize,
    shadowMaxDistance,
    shadowDarkness,
    shadowSoftness,
    shadowFadingEnabled,
    shadowNormalOffset,
    inMemoryTileCacheSize
  } = settings

  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const [viewer, setViewer] = useState<Cesium.Viewer | null>(null)

  // Model pool refs
  const modelPoolRef = useRef<Map<number, Cesium.Model>>(new Map())
  const modelPoolAssignmentsRef = useRef<Map<number, string | null>>(new Map())
  const modelPoolUrlsRef = useRef<Map<number, string>>(new Map())
  const modelPoolLoadingRef = useRef<Set<number>>(new Set())
  const modelPoolReadyRef = useRef<boolean>(false)

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

    // Improve texture quality - helps reduce mipmap banding
    newViewer.scene.globe.showGroundAtmosphere = enableGroundAtmosphere
    newViewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a2e')

    // Try to enable maximum anisotropic filtering for better texture quality at oblique angles
    // Note: context is private, using type assertion to access WebGL context
    const gl = (newViewer.scene as { context?: { _gl?: WebGL2RenderingContext } }).context?._gl ?? null
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
        if (newViewer.isDestroyed()) return
        newViewer.scene.primitives.add(model)
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
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- graphics settings used at init only; runtime updates handled by separate hooks
  }, [cesiumIonToken, isInset, msaaSamples, viewportId])

  return {
    viewer,
    modelPoolRefs: {
      modelPool: modelPoolRef,
      modelPoolAssignments: modelPoolAssignmentsRef,
      modelPoolUrls: modelPoolUrlsRef,
      modelPoolLoading: modelPoolLoadingRef,
      modelPoolReady: modelPoolReadyRef
    }
  }
}
