import * as BABYLON from '@babylonjs/core'
// Side-effect import: registers the glTF SceneLoader plugin so LoadAssetContainerAsync
// can load .glb / .gltf models for tower cabs and any future Babylon-side mod content.
import '@babylonjs/loaders/glTF'
import * as GUI from '@babylonjs/gui'
import { useEffect, useRef, useState } from 'react'
import {
  CAMERA_MAX_Z,
  CAMERA_MIN_Z,
  DIRECTIONAL_LIGHT_INTENSITY,
  HEMISPHERIC_LIGHT_GROUND_COLOR,
  HEMISPHERIC_LIGHT_INTENSITY,
} from '@/constants'
import type { BabylonSceneOptions, UseBabylonSceneResult } from '@/types'

// Static path served from src/renderer/public/. If the file is absent the texture
// load fails silently and the scene falls back to hemispheric+directional lighting only.
const IBL_ENV_URL = '/cab-environment.env'

// Shadow map size in texels. 2048 gives crisp self-shadows on cab interior fixtures
// without measurable frame-time impact at airport scale.
const SHADOW_MAP_SIZE = 2048

// Tight near/far range for the directional light's shadow camera. Cab interiors are
// a few tens of meters across; the shadow camera doesn't need globe-scale distances.
const SHADOW_LIGHT_MIN_Z = 1
const SHADOW_LIGHT_MAX_Z = 5000

/**
 * Initializes Babylon.js engine, scene, camera, and lighting for transparent overlay rendering.
 *
 * ## Responsibilities
 * - Create and configure Babylon.js engine with transparent background
 * - Create scene with MSAA 4x anti-aliasing and transparent clear color
 * - Create FreeCamera synchronized with Cesium (not user-controlled)
 * - Setup hemispheric and directional lighting for realistic shading
 * - Create GUI AdvancedDynamicTexture for 2D label overlays
 * - Handle canvas resizing and maintain correct aspect ratio
 * - Dispose all resources on unmount
 *
 * ## Dependencies
 * - Requires: HTMLCanvasElement for rendering (must be valid and visible)
 * - Writes: Creates and manages Babylon.js engine, scene, camera, GUI texture
 *
 * ## Call Order
 * This hook should be called early in the Babylon overlay setup, before any hooks
 * that create meshes or materials:
 * ```typescript
 * function BabylonOverlay({ canvas }) {
 *   // 1. Initialize scene first
 *   const { engine, scene, camera, guiTexture, sceneReady } = useBabylonScene({ canvas })
 *
 *   // 2. Setup camera synchronization (needs camera from scene)
 *   const cameraSync = useBabylonCameraSync({ cesiumViewer, camera })
 *
 *   // 3. Create weather effects (needs scene for meshes)
 *   const weather = useBabylonWeather({ scene })
 *
 *   // 4. Setup labels (needs guiTexture and scene)
 *   const labels = useBabylonLabels({ guiTexture, scene })
 * }
 * ```
 *
 * ## Engine Configuration
 *
 * The Babylon engine is created with these options:
 * - `preserveDrawingBuffer: true` - Required for screenshot/video capture
 * - `stencil: true` - Enables stencil buffer for advanced rendering
 * - `alpha: true` - Enables transparent canvas for overlay mode
 *
 * ## Scene Configuration
 *
 * The scene is configured for transparent overlay rendering:
 * - **Clear color**: `Color4(0, 0, 0, 0)` - Fully transparent
 * - **autoClear**: `true` - Clears depth buffer each frame
 * - **autoClearDepthAndStencil**: `true` - Prevents depth conflicts with Cesium
 *
 * This configuration allows Babylon to render 2D/3D elements on top of Cesium's
 * globe without occluding the terrain.
 *
 * ## Camera Setup
 *
 * The FreeCamera is created with default position (0, 0, -10) but will be
 * synchronized with Cesium camera each frame via useBabylonCameraSync.
 *
 * **Important camera settings:**
 * - `minZ = 1` - Near clipping plane (prevents z-fighting with globe)
 * - `maxZ = 1e10` - Far clipping plane (handles globe-scale distances)
 *
 * **Note:** This camera is NOT controlled by user input. It mirrors the Cesium
 * camera's position and orientation using ENU coordinate transforms.
 *
 * ## Lighting Setup
 *
 * Two lights provide realistic shading for 3D meshes:
 *
 * ### Hemispheric Light
 * - **Direction**: (0, 1, 0) pointing up
 * - **Intensity**: 1.0 (configurable via HEMISPHERIC_LIGHT_INTENSITY)
 * - **Ground color**: [0.5, 0.5, 0.5] (simulates light reflected from ground)
 *
 * ### Directional Light
 * - **Direction**: (-1, -2, -1) pointing down and southwest
 * - **Intensity**: 0.6 (configurable via DIRECTIONAL_LIGHT_INTENSITY)
 * - Simulates sunlight for shadows and highlights
 *
 * ## GUI Texture
 *
 * Creates a fullscreen GUI AdvancedDynamicTexture for rendering 2D labels:
 * - Covers entire canvas
 * - Adapts to canvas size automatically
 * - Used by useBabylonLabels for aircraft datablock labels
 *
 * ## Resize Handling
 *
 * The hook automatically handles canvas resizing:
 * 1. Listens to window 'resize' events
 * 2. Updates canvas dimensions to match container (accounting for devicePixelRatio)
 * 3. Calls `engine.resize()` to update Babylon viewport
 *
 * This ensures crisp rendering on high-DPI displays and maintains correct aspect ratio.
 *
 * ## Resource Cleanup
 *
 * All Babylon resources are properly disposed on unmount:
 * 1. Remove resize event listener
 * 2. Dispose GUI texture
 * 3. Dispose scene (automatically disposes lights, camera, materials, meshes)
 * 4. Dispose engine
 * 5. Clear all refs
 *
 * **Note:** Scene disposal automatically handles child resources (lights, cameras),
 * but external hooks (useBabylonWeather, useBabylonLabels) are responsible for
 * disposing their own resources before scene disposal.
 *
 * ## Scene Ready State
 *
 * The `sceneReady` boolean indicates when the scene is fully initialized:
 * - `false` during initialization
 * - `true` after engine, scene, camera, and GUI texture are created
 * - `false` again on unmount
 *
 * Other hooks should check `sceneReady` before creating meshes:
 * ```typescript
 * useEffect(() => {
 *   if (!sceneReady || !scene) return
 *   // Safe to create meshes now
 *   const mesh = BABYLON.MeshBuilder.CreateBox('myBox', {}, scene)
 * }, [sceneReady, scene])
 * ```
 *
 * ## Performance Considerations
 *
 * - **Transparent rendering**: Slight overhead compared to opaque rendering
 * - **MSAA 4x**: ~20% performance cost, but significantly improves visual quality
 * - **Resize throttling**: Resize handler is called frequently; consider debouncing for heavy scenes
 * - **Auto-clear**: Depth buffer clearing each frame is necessary for correct overlay rendering
 *
 * @param options - Scene initialization options
 * @param options.canvas - HTML canvas element for rendering (required, must be visible)
 * @param options.antialias - Enable MSAA 4x anti-aliasing (default: true)
 * @param options.transparent - Enable transparent background (default: true, required for overlay)
 * @param options.devicePixelRatio - Device pixel ratio multiplier (default: window.devicePixelRatio)
 * @returns Babylon scene state and resources
 *
 * @example
 * // Basic overlay scene setup
 * function BabylonOverlay() {
 *   const canvasRef = useRef<HTMLCanvasElement>(null)
 *
 *   const { engine, scene, camera, guiTexture, sceneReady } = useBabylonScene({
 *     canvas: canvasRef.current
 *   })
 *
 *   // Wait for scene to be ready before using it
 *   useEffect(() => {
 *     if (!sceneReady) return
 *     console.log('Babylon scene ready for rendering!')
 *   }, [sceneReady])
 *
 *   return <canvas ref={canvasRef} className="babylon-overlay" />
 * }
 *
 * @example
 * // Custom anti-aliasing and pixel ratio
 * const { scene } = useBabylonScene({
 *   canvas: canvasRef.current,
 *   antialias: false,  // Disable for performance
 *   devicePixelRatio: 1  // Force 1x (non-retina) rendering
 * })
 *
 * @example
 * // Using scene with other hooks
 * const { scene, camera, guiTexture, sceneReady } = useBabylonScene({ canvas })
 *
 * // Camera sync (requires camera)
 * const cameraSync = useBabylonCameraSync({
 *   cesiumViewer: viewer,
 *   camera: camera
 * })
 *
 * // Weather effects (requires scene)
 * const weather = useBabylonWeather({ scene })
 *
 * // Labels (requires guiTexture and scene)
 * const labels = useBabylonLabels({ guiTexture, scene })
 *
 * @see useBabylonCameraSync - For camera synchronization with Cesium
 * @see useBabylonWeather - For fog and cloud effects
 * @see useBabylonLabels - For aircraft datablock labels
 */
export function useBabylonScene(options: BabylonSceneOptions): UseBabylonSceneResult {
  const { canvas, antialias = true, transparent = true, devicePixelRatio = window.devicePixelRatio } = options

  const engineRef = useRef<BABYLON.Engine | null>(null)
  const sceneRef = useRef<BABYLON.Scene | null>(null)
  const cameraRef = useRef<BABYLON.FreeCamera | null>(null)
  const guiTextureRef = useRef<GUI.AdvancedDynamicTexture | null>(null)
  const shadowGeneratorRef = useRef<BABYLON.ShadowGenerator | null>(null)
  const environmentTextureRef = useRef<BABYLON.CubeTexture | null>(null)
  const [sceneReady, setSceneReady] = useState(false)
  // Track when canvas has valid dimensions (needed for freshly created canvases)
  const [canvasReady, setCanvasReady] = useState(false)

  // Wait for canvas to have valid dimensions before initializing Babylon.
  // This is necessary because a freshly appended canvas might have 0x0 dimensions
  // for one render cycle before the browser computes layout.
  useEffect(() => {
    if (!canvas) {
      setCanvasReady(false)
      return
    }

    // Reset canvasReady when canvas changes (new canvas object)
    setCanvasReady(false)

    let cancelled = false
    const checkDimensions = () => {
      if (cancelled) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setCanvasReady(true)
      } else {
        // Canvas not ready yet - wait for valid dimensions via animation frame
        requestAnimationFrame(checkDimensions)
      }
    }

    checkDimensions()

    return () => {
      cancelled = true
      setCanvasReady(false)
    }
  }, [canvas])

  // Initialize Babylon engine and scene once canvas has valid dimensions
  useEffect(() => {
    if (!canvas || !canvasReady) return

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      // Shouldn't happen if canvasReady is true, but guard anyway
      return
    }

    canvas.width = rect.width * devicePixelRatio
    canvas.height = rect.height * devicePixelRatio

    // Create Babylon engine
    const engine = new BABYLON.Engine(canvas, antialias, {
      preserveDrawingBuffer: true,
      stencil: true,
      alpha: transparent,
    })
    engineRef.current = engine

    // Create scene
    const scene = new BABYLON.Scene(engine)
    if (transparent) {
      scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)
    }
    // autoClear = true with transparent clearColor allows depth buffer to clear
    // while keeping the background transparent for Cesium to show through
    scene.autoClear = true
    scene.autoClearDepthAndStencil = true
    sceneRef.current = scene

    // Create camera (will be synced with Cesium by useBabylonCameraSync)
    const camera = new BABYLON.FreeCamera('camera', new BABYLON.Vector3(0, 0, -10), scene)
    camera.minZ = CAMERA_MIN_Z
    camera.maxZ = CAMERA_MAX_Z
    cameraRef.current = camera

    // Create fullscreen GUI texture for labels
    const guiTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI('UI', true, scene)
    guiTextureRef.current = guiTexture

    setSceneReady(true)

    // Add hemispheric ambient light
    const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene)
    light.intensity = HEMISPHERIC_LIGHT_INTENSITY
    light.groundColor = new BABYLON.Color3(
      HEMISPHERIC_LIGHT_GROUND_COLOR[0],
      HEMISPHERIC_LIGHT_GROUND_COLOR[1],
      HEMISPHERIC_LIGHT_GROUND_COLOR[2],
    )

    // Add directional light
    const dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-1, -2, -1), scene)
    dirLight.intensity = DIRECTIONAL_LIGHT_INTENSITY
    dirLight.shadowMinZ = SHADOW_LIGHT_MIN_Z
    dirLight.shadowMaxZ = SHADOW_LIGHT_MAX_Z

    // Shadow generator on the directional light. Tower cab meshes (added by useBabylonTowerModel)
    // register themselves as casters and set receiveShadows = true so cab geometry self-shadows
    // (e.g. desks shadow the floor). useExponentialShadowMap is cheap and produces soft edges
    // without acne, which matters since the cab is the only Babylon-side opaque geometry today.
    const shadowGenerator = new BABYLON.ShadowGenerator(SHADOW_MAP_SIZE, dirLight)
    shadowGenerator.useExponentialShadowMap = true
    shadowGeneratorRef.current = shadowGenerator

    // Best-effort IBL load. If the .env file isn't bundled (e.g. dev workspace without the asset),
    // CubeTexture's onError fires and we leave environmentTexture unset — PBR materials in the cab
    // will look flatter but everything still renders. StandardMaterial (fog/clouds) ignores
    // environmentTexture so weather effects are unaffected either way.
    const envTexture = new BABYLON.CubeTexture(
      IBL_ENV_URL,
      scene,
      undefined,
      undefined,
      undefined,
      () => {
        scene.environmentTexture = envTexture
      },
      () => {
        envTexture.dispose()
        environmentTextureRef.current = null
      },
    )
    environmentTextureRef.current = envTexture

    // Handle resize - update canvas dimensions and trigger engine resize
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return

      const newWidth = rect.width * devicePixelRatio
      const newHeight = rect.height * devicePixelRatio

      // Only resize if dimensions actually changed
      if (canvas.width !== newWidth || canvas.height !== newHeight) {
        canvas.width = newWidth
        canvas.height = newHeight
        engine.resize()

        // Force the GUI texture to update its internal dimensions to match the new canvas size
        // This prevents label stretching and leader line misalignment after window resize
        guiTexture.scaleTo(newWidth, newHeight)
      }
    }

    // Use ResizeObserver for more reliable detection of container size changes
    // This catches cases where the container resizes without triggering window resize
    const resizeObserver = new ResizeObserver(() => {
      handleResize()
    })
    resizeObserver.observe(canvas)

    // Also listen to window resize as a fallback
    window.addEventListener('resize', handleResize)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)

      shadowGeneratorRef.current?.dispose()
      shadowGeneratorRef.current = null
      environmentTextureRef.current?.dispose()
      environmentTextureRef.current = null
      guiTexture.dispose()
      scene.dispose()
      engine.dispose()
      engineRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      guiTextureRef.current = null
      setSceneReady(false)
    }
  }, [canvas, canvasReady, antialias, transparent, devicePixelRatio])

  return {
    engine: engineRef.current,
    scene: sceneRef.current,
    camera: cameraRef.current,
    guiTexture: guiTextureRef.current,
    shadowGenerator: shadowGeneratorRef.current,
    sceneReady,
  }
}

export default useBabylonScene
