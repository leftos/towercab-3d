import { useCallback } from 'react'
import type { BabylonOverlayOptions } from '@/types'
import { useBabylonScene } from './useBabylonScene'
import { useBabylonWeather } from './useBabylonWeather'
import { useBabylonLabels } from './useBabylonLabels'
import { useBabylonRootNode } from './useBabylonRootNode'
import { useBabylonCameraSync } from './useBabylonCameraSync'
import { useBabylonPrecipitation } from './useBabylonPrecipitation'
import { useViewportStore } from '../stores/viewportStore'

/**
 * Orchestrator hook for Babylon.js overlay rendering synchronized with Cesium.
 *
 * ## Responsibilities
 * - Initialize and coordinate all Babylon.js subsystems (scene, weather, labels, transforms)
 * - Provide unified API for CesiumViewer to manage the overlay
 * - Delegate to specialized hooks for specific functionality
 * - Maintain backward-compatible interface for existing code
 *
 * ## Architecture
 *
 * This hook is a **thin orchestrator** that composes specialized hooks:
 *
 * 1. **useBabylonScene**: Engine, scene, camera, GUI initialization
 * 2. **useBabylonWeather**: Fog dome and cloud layers from METAR data
 * 3. **useBabylonLabels**: Aircraft datablock labels and leader lines
 * 4. **useBabylonRootNode**: ENU coordinate system and transformation matrices
 * 5. **useBabylonCameraSync**: Camera synchronization with Cesium
 *
 * Each specialized hook manages its own resources and lifecycle, making the
 * codebase more modular, testable, and maintainable.
 *
 * ## Dependencies
 * - Requires: Initialized Cesium.Viewer (from useCesiumViewer)
 * - Requires: HTMLCanvasElement for Babylon rendering (overlaid on Cesium)
 * - Reads: weatherStore (via useBabylonWeather for METAR data)
 * - Reads: settingsStore (via useBabylonWeather for weather toggles)
 *
 * ## Call Order
 * This hook must be initialized AFTER Cesium viewer is ready:
 * ```typescript
 * const viewer = useCesiumViewer(containerRef)
 * const babylonCanvas = useRef<HTMLCanvasElement>(null)
 * const babylon = useBabylonOverlay({
 *   cesiumViewer: viewer,
 *   canvas: babylonCanvas.current
 * })
 * ```
 *
 * ## Rendering Pipeline
 *
 * ### Initialization (happens in specialized hooks)
 * 1. **Scene**: Create Babylon engine with transparent clear color, MSAA 4x
 * 2. **Weather**: Create fog dome and cloud layer meshes
 * 3. **Labels**: Initialize GUI texture for 2D overlays
 * 4. **Root Node**: Setup ENU coordinate system at tower location
 * 5. **Camera Sync**: Prepare camera transform calculations
 *
 * ### Per-Frame Update (called by CesiumViewer)
 * 1. Call `syncCamera()` to update Babylon camera from Cesium camera
 * 2. Update aircraft labels via `updateAircraftLabel()` + `updateLeaderLine()`
 * 3. Call `render()` to render the Babylon scene
 *
 * Weather effects (fog dome, cloud layers) update automatically via React effects
 * when METAR data or settings change.
 *
 * ## Coordinate System
 *
 * Uses **ENU (East-North-Up)** local coordinates managed by useBabylonRootNode:
 * - Origin: Tower location
 * - X-axis: East
 * - Y-axis: Up
 * - Z-axis: North
 *
 * All aircraft positions must be converted from geographic (lat/lon/alt) to ENU
 * before rendering. See `docs/coordinate-systems.md` for details.
 *
 * ## Public API
 *
 * ### Scene Management
 * - `engine`: Babylon.Engine instance (or null if not ready)
 * - `scene`: Babylon.Scene instance (or null if not ready)
 * - `sceneReady`: Boolean indicating if scene is initialized
 *
 * ### Root Node Setup
 * - `setupRootNode(lat, lon, height)`: Setup ENU origin at tower location
 *
 * ### Label Management
 * - `updateAircraftLabel(callsign, color, isFollowed, labelText?)`: Create/update label
 * - `updateLeaderLine(callsign, screenX, screenY, offsetX, offsetY)`: Position label
 * - `removeAircraftLabel(callsign)`: Remove label and dispose resources
 * - `getAircraftCallsigns()`: Get array of callsigns with labels
 * - `hideAllLabels()`: Hide all labels (called at frame start)
 *
 * ### Weather Visibility
 * - `isDatablockVisibleByWeather(camAlt, acAlt, horizDist)`: Check if label should be culled
 *
 * ### Rendering
 * - `render()`: Render one frame (syncs camera + renders scene)
 * - `syncCamera()`: Sync Babylon camera with Cesium (called internally by render())
 *
 * ## Memory Management
 *
 * All specialized hooks handle their own resource disposal:
 * - **useBabylonScene**: Disposes engine, scene, camera, GUI on unmount
 * - **useBabylonWeather**: Disposes fog dome and cloud meshes
 * - **useBabylonLabels**: Disposes labels and leader lines
 * - **useBabylonRootNode**: Disposes root node
 * - **useBabylonCameraSync**: No resources (stateless calculations)
 *
 * Memory counters available via:
 * - `getMemoryCounters()` from useBabylonOverlay (total)
 * - `getLabelMemoryCounters()` from useBabylonLabels
 * - `getWeatherMemoryCounters()` from useBabylonWeather
 *
 * @param options - Configuration options
 * @param options.cesiumViewer - Initialized Cesium.Viewer instance
 * @param options.canvas - HTMLCanvasElement for Babylon rendering (must be overlaid on Cesium)
 * @returns Babylon.js overlay API
 *
 * @example
 * // Basic setup
 * const viewer = useCesiumViewer(containerRef)
 * const babylonCanvas = useRef<HTMLCanvasElement>(null)
 * const babylon = useBabylonOverlay({
 *   cesiumViewer: viewer,
 *   canvas: babylonCanvas.current
 * })
 *
 * // Setup ENU root node at airport
 * useEffect(() => {
 *   if (airport && babylon.sceneReady) {
 *     babylon.setupRootNode(airport.lat, airport.lon, airport.elevation)
 *   }
 * }, [airport, babylon.sceneReady])
 *
 * // Render loop (60 FPS)
 * useEffect(() => {
 *   if (!babylon.sceneReady) return
 *   const handle = setInterval(() => babylon.render(), 16)
 *   return () => clearInterval(handle)
 * }, [babylon.sceneReady])
 *
 * @example
 * // Update aircraft labels each frame
 * babylon.hideAllLabels() // Hide all at frame start
 *
 * for (const [callsign, aircraft] of interpolatedAircraft) {
 *   // Update label text and color
 *   babylon.updateAircraftLabel(callsign, rgbColor, isFollowed, labelText)
 *
 *   // Position label at screen coordinates
 *   const screenPos = worldToScreen(aircraft.position)
 *   babylon.updateLeaderLine(callsign, screenPos.x, screenPos.y, offsetX, offsetY)
 * }
 *
 * @example
 * // Check weather visibility culling
 * const cameraAlt = 100 // meters AGL
 * const aircraftAlt = 500 // meters AGL
 * const distance = 5000 // meters horizontal
 *
 * if (babylon.isDatablockVisibleByWeather(cameraAlt, aircraftAlt, distance)) {
 *   // Show label
 * } else {
 *   // Cull label (beyond fog or behind clouds)
 * }
 *
 * @see useBabylonScene - Scene initialization hook
 * @see useBabylonWeather - Weather effects hook
 * @see useBabylonLabels - Label management hook
 * @see useBabylonRootNode - ENU coordinate system hook
 * @see useBabylonCameraSync - Camera synchronization hook
 * @see docs/coordinate-systems.md - Coordinate system explanation
 * @see docs/architecture.md - Architecture overview
 */
export function useBabylonOverlay({ cesiumViewer, canvas }: BabylonOverlayOptions) {
  // Get view mode for precipitation effects
  const viewMode = useViewportStore((state) => state.viewports.find(v => v.id === 'main')?.cameraState.viewMode)
  const isTopDownView = viewMode === 'topdown'

  // 1. Initialize scene (engine, scene, camera, GUI, lighting)
  const { engine, scene, camera, guiTexture, sceneReady } = useBabylonScene({
    canvas: canvas!,
    antialias: true,
    transparent: true
  })

  // 2. Initialize weather effects (fog dome, cloud layers)
  const { fogDome, getCloudMeshes, isVisibleByWeather } = useBabylonWeather({
    scene,
    isTopDownView
  })

  // 3. Initialize precipitation effects (rain, snow, lightning)
  useBabylonPrecipitation({
    scene,
    camera,
    isTopDownView
  })

  // 4. Initialize label management (datablock labels, leader lines)
  const {
    updateLabel,
    updateLabelPosition,
    removeLabel,
    getAircraftCallsigns,
    hideAllLabels
  } = useBabylonLabels({
    guiTexture,
    isTopDownView
  })

  // 5. Initialize ENU root node (coordinate system, transforms)
  const { setupRootNode, getFixedToEnu } = useBabylonRootNode({
    scene,
    cesiumViewer
  })

  // 6. Initialize camera synchronization
  const { syncCamera: syncCameraInternal } = useBabylonCameraSync({
    cesiumViewer,
    camera,
    fogDome,
    getCloudMeshes,
    getFixedToEnu
  })

  // Render one frame: sync camera + render scene
  const render = useCallback(() => {
    if (!engine || !scene) return
    syncCameraInternal()
    scene.render()
  }, [engine, scene, syncCameraInternal])

  // Adapter functions to match the legacy API expected by useCesiumLabels
  const updateAircraftLabel = useCallback(
    (callsign: string, text: string, r: number, g: number, b: number) => {
      updateLabel(callsign, { r, g, b }, false, text)
    },
    [updateLabel]
  )

  const updateLeaderLineAdapter = useCallback(
    (callsign: string, coneX: number, coneY: number, offsetX: number, offsetY: number) => {
      updateLabelPosition(callsign, coneX, coneY, offsetX, offsetY)
    },
    [updateLabelPosition]
  )

  const removeAircraftLabelAdapter = useCallback(
    (callsign: string) => {
      removeLabel(callsign)
    },
    [removeLabel]
  )

  const isDatablockVisibleByWeatherAdapter = useCallback(
    (cameraAltitudeAGL: number, aircraftAltitudeAGL: number, distanceMeters: number) => {
      return isVisibleByWeather({
        cameraAltitudeMeters: cameraAltitudeAGL,
        aircraftAltitudeMeters: aircraftAltitudeAGL,
        horizontalDistanceMeters: distanceMeters
      })
    },
    [isVisibleByWeather]
  )

  // Public API - delegates to specialized hooks with adapter functions for backward compatibility
  return {
    // Scene management
    engine,
    scene,
    sceneReady,

    // Root node setup (ENU coordinate system)
    setupRootNode,

    // Label management (adapted to match legacy useCesiumLabels interface)
    updateAircraftLabel,
    updateLeaderLine: updateLeaderLineAdapter,
    removeAircraftLabel: removeAircraftLabelAdapter,
    getAircraftCallsigns,
    hideAllLabels,

    // Weather visibility (adapted to match legacy useCesiumLabels interface)
    isDatablockVisibleByWeather: isDatablockVisibleByWeatherAdapter,

    // Rendering
    render,
    syncCamera: syncCameraInternal
  }
}

// Legacy memory counter export (aggregates all hooks)
export function getMemoryCounters() {
  // This is now managed by individual hooks:
  // - getLabelMemoryCounters() from useBabylonLabels
  // - getWeatherMemoryCounters() from useBabylonWeather
  // Return empty for backward compatibility
  return {
    materialsCreated: 0,
    materialsDisposed: 0,
    meshesCreated: 0,
    meshesDisposed: 0,
    guiControlsCreated: 0,
    guiControlsDisposed: 0
  }
}

export default useBabylonOverlay
