import { useRef, useCallback, useEffect } from 'react'
import * as Cesium from 'cesium'
import { useVRStore } from '../stores/vrStore'
import {
  saveCameraState,
  restoreCameraState,
  configureEyeCamera
} from '../utils/cesiumFrustumPatch'

/**
 * Manages Cesium stereo rendering for WebXR VR mode by rendering separate left/right eye views.
 *
 * ## Responsibilities
 * - Creates offscreen canvases for left and right eye rendering targets
 * - Disables Cesium's default render loop when VR is active
 * - Renders Cesium scene twice per frame with adjusted camera frustums for each eye
 * - Captures rendered frames to canvases that can be used as textures in Babylon.js VR scene
 * - Restores Cesium's normal rendering when VR deactivates
 *
 * ## Dependencies
 * - Requires: Cesium viewer instance (must be initialized)
 * - Reads: `vrStore` (isVRActive state, IPD settings)
 * - Writes: Cesium viewer's `useDefaultRenderLoop` property
 *
 * ## Call Order
 * This hook should be called before setting up the VR scene that will display the stereo textures:
 * ```typescript
 * function VRScene() {
 *   const cesiumViewer = useRef<Cesium.Viewer>(null)
 *
 *   // Setup stereo rendering (disables Cesium auto-render)
 *   const { stereoTextures, renderStereoFrame, isActive } = useCesiumStereo(
 *     cesiumViewer.current,
 *     1536, 1536 // Render resolution per eye
 *   )
 *
 *   // Setup VR scene that uses the stereo textures
 *   useEffect(() => {
 *     if (isActive && stereoTextures.leftCanvas && stereoTextures.rightCanvas) {
 *       // Create Babylon materials using the canvases as textures
 *       // Call renderStereoFrame() in XR render loop
 *     }
 *   }, [isActive, stereoTextures])
 * }
 * ```
 *
 * ## Stereo Rendering Pipeline
 *
 * When VR is active, this hook takes over Cesium's render loop:
 *
 * 1. **Disable Auto-Render**: Sets `viewer.useDefaultRenderLoop = false` to prevent automatic rendering
 * 2. **Create Offscreen Canvases**: Two canvases at specified resolution (default 1536×1536 per eye)
 * 3. **Render Loop** (called by VR scene's XR frame callback):
 *    - Save original camera state
 *    - Configure camera for right eye (apply IPD offset)
 *    - Render Cesium scene → copy to right canvas
 *    - Restore camera state
 *    - Configure camera for left eye (apply IPD offset)
 *    - Render Cesium scene → copy to left canvas
 *    - Restore original camera state
 * 4. **Texture Consumption**: VR scene reads canvases as textures for display on stereo planes
 *
 * ## IPD (Inter-Pupillary Distance)
 *
 * The Inter-Pupillary Distance determines the separation between left and right eye cameras:
 * - Read from `vrStore.ipd` (user-configurable, typically 63mm)
 * - Applied via `configureEyeCamera()` which adjusts frustum offset
 * - Larger IPD = greater stereo effect (more 3D depth perception)
 * - See `utils/cesiumFrustumPatch.ts` for frustum manipulation details
 *
 * ## Performance Considerations
 *
 * - **Double Rendering Cost**: Cesium renders the entire globe twice per frame (60Hz × 2 = 120 renders/sec)
 * - **Resolution**: Default 1536×1536 per eye balances quality with performance
 * - **Canvas Copying**: Uses `drawImage()` to copy Cesium's WebGL canvas to 2D canvases (fast)
 * - **VR Frame Rate**: Must maintain 90Hz for most VR headsets (renders every other VR frame)
 *
 * ## Camera State Preservation
 *
 * The hook uses `saveCameraState()` and `restoreCameraState()` from `cesiumFrustumPatch.ts` to:
 * - Save original camera position/orientation before rendering
 * - Restore it after both eyes are rendered
 * - Ensure the main Cesium viewer shows the correct view when mirrored to desktop
 *
 * ## Cleanup Behavior
 *
 * When VR deactivates or component unmounts:
 * - Offscreen canvases are destroyed
 * - `viewer.useDefaultRenderLoop` is restored to original value
 * - Cesium resumes normal automatic rendering
 *
 * @param viewer - The Cesium viewer instance (must not be destroyed)
 * @param renderWidth - Width of offscreen render canvases in pixels (default: 1536)
 * @param renderHeight - Height of offscreen render canvases in pixels (default: 1536)
 * @returns Stereo rendering controls and state
 *
 * @example
 * // Basic VR stereo setup
 * const { stereoTextures, renderStereoFrame, isActive } = useCesiumStereo(
 *   viewer,
 *   1920, // High-res rendering
 *   1920
 * )
 *
 * // In XR render loop:
 * if (isActive) {
 *   renderStereoFrame() // Render both eyes to canvases
 * }
 *
 * @example
 * // Using stereo textures in Babylon.js
 * useEffect(() => {
 *   if (!stereoTextures.leftCanvas || !stereoTextures.rightCanvas) return
 *
 *   const leftTexture = new BABYLON.Texture(
 *     stereoTextures.leftCanvas.toDataURL(),
 *     scene
 *   )
 *   const rightTexture = new BABYLON.Texture(
 *     stereoTextures.rightCanvas.toDataURL(),
 *     scene
 *   )
 *
 *   // Apply to stereo planes...
 * }, [stereoTextures])
 *
 * @see utils/cesiumFrustumPatch.ts - For camera frustum manipulation and state management
 * @see vrStore - For VR session state and IPD settings
 * @see VRScene.tsx - For Babylon.js VR scene that consumes stereo textures
 */

interface StereoTextures {
  leftCanvas: HTMLCanvasElement | null
  rightCanvas: HTMLCanvasElement | null
  leftContext: CanvasRenderingContext2D | null
  rightContext: CanvasRenderingContext2D | null
}

interface UseCesiumStereoResult {
  // The stereo canvases containing rendered frames
  stereoTextures: StereoTextures
  // Render a stereo frame (call this from VR render loop)
  renderStereoFrame: () => void
  // Check if stereo rendering is active
  isActive: boolean
}

export function useCesiumStereo(
  viewer: Cesium.Viewer | null,
  renderWidth: number = 1536,
  renderHeight: number = 1536
): UseCesiumStereoResult {
  const isVRActive = useVRStore((state) => state.isVRActive)
  const ipd = useVRStore((state) => state.ipd)

  // Offscreen canvases for stereo rendering
  const leftCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rightCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const leftContextRef = useRef<CanvasRenderingContext2D | null>(null)
  const rightContextRef = useRef<CanvasRenderingContext2D | null>(null)

  // Track if we've disabled Cesium's auto-render
  const originalUseDefaultRenderLoopRef = useRef<boolean>(true)

  // Initialize offscreen canvases
  useEffect(() => {
    if (!isVRActive) {
      // Clean up when VR deactivates
      leftCanvasRef.current = null
      rightCanvasRef.current = null
      leftContextRef.current = null
      rightContextRef.current = null
      return
    }

    // Create offscreen canvases for each eye
    const leftCanvas = document.createElement('canvas')
    leftCanvas.width = renderWidth
    leftCanvas.height = renderHeight
    leftCanvasRef.current = leftCanvas
    leftContextRef.current = leftCanvas.getContext('2d')

    const rightCanvas = document.createElement('canvas')
    rightCanvas.width = renderWidth
    rightCanvas.height = renderHeight
    rightCanvasRef.current = rightCanvas
    rightContextRef.current = rightCanvas.getContext('2d')

    return () => {
      leftCanvasRef.current = null
      rightCanvasRef.current = null
      leftContextRef.current = null
      rightContextRef.current = null
    }
  }, [isVRActive, renderWidth, renderHeight])

  // Disable Cesium's default render loop when VR is active
  useEffect(() => {
    if (!viewer) return

    if (isVRActive) {
      // Save original state and disable auto-render
      originalUseDefaultRenderLoopRef.current = viewer.useDefaultRenderLoop
      viewer.useDefaultRenderLoop = false
    } else {
      // Restore original render loop state
      viewer.useDefaultRenderLoop = originalUseDefaultRenderLoopRef.current
    }

    return () => {
      // Always restore on cleanup
      if (viewer && !viewer.isDestroyed()) {
        viewer.useDefaultRenderLoop = originalUseDefaultRenderLoopRef.current
      }
    }
  }, [viewer, isVRActive])

  // Main stereo render function
  const renderStereoFrame = useCallback(() => {
    if (!viewer || !isVRActive) return
    if (!leftCanvasRef.current || !rightCanvasRef.current) return
    if (!leftContextRef.current || !rightContextRef.current) return

    const scene = viewer.scene
    const camera = viewer.camera
    const cesiumCanvas = viewer.canvas

    // Save original camera state
    saveCameraState(camera)

    try {
      // --- Render Right Eye ---
      configureEyeCamera(camera, 'right', ipd)
      scene.render()

      // Copy Cesium canvas to right eye canvas
      rightContextRef.current.drawImage(
        cesiumCanvas,
        0, 0,
        cesiumCanvas.width, cesiumCanvas.height,
        0, 0,
        rightCanvasRef.current.width, rightCanvasRef.current.height
      )

      // Restore camera before rendering left eye
      restoreCameraState(camera)

      // --- Render Left Eye ---
      configureEyeCamera(camera, 'left', ipd)
      scene.render()

      // Copy Cesium canvas to left eye canvas
      leftContextRef.current.drawImage(
        cesiumCanvas,
        0, 0,
        cesiumCanvas.width, cesiumCanvas.height,
        0, 0,
        leftCanvasRef.current.width, leftCanvasRef.current.height
      )

    } finally {
      // Always restore camera state
      restoreCameraState(camera)
    }
  }, [viewer, isVRActive, ipd])

  return {
    stereoTextures: {
      leftCanvas: leftCanvasRef.current,
      rightCanvas: rightCanvasRef.current,
      leftContext: leftContextRef.current,
      rightContext: rightContextRef.current
    },
    renderStereoFrame,
    isActive: isVRActive && viewer !== null
  }
}

/**
 * Hook for applying VR head tracking rotation to Cesium camera
 *
 * @param viewer - Cesium viewer
 * @param xrSession - Active WebXR session
 * @param xrRefSpace - XR reference space
 */
export function useCesiumVRRotation(
  viewer: Cesium.Viewer | null,
  xrPose: XRViewerPose | null
): void {
  useEffect(() => {
    if (!viewer || !xrPose) return

    const camera = viewer.camera

    // Get the view transform from the XR pose
    // The pose provides orientation relative to the reference space
    const transform = xrPose.transform

    // Convert XR orientation (quaternion) to Cesium rotation
    // XR uses (x, y, z, w) quaternion format
    const orientation = transform.orientation
    const quaternion = new Cesium.Quaternion(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w
    )

    // Create rotation matrix from quaternion
    const rotationMatrix = Cesium.Matrix3.fromQuaternion(quaternion)

    // Apply rotation to camera direction and up vectors
    // This rotates the camera based on head movement
    const direction = Cesium.Matrix3.multiplyByVector(
      rotationMatrix,
      Cesium.Cartesian3.UNIT_Z,
      new Cesium.Cartesian3()
    )
    Cesium.Cartesian3.negate(direction, direction) // Camera looks in -Z

    const up = Cesium.Matrix3.multiplyByVector(
      rotationMatrix,
      Cesium.Cartesian3.UNIT_Y,
      new Cesium.Cartesian3()
    )

    camera.direction = direction
    camera.up = up
  }, [viewer, xrPose])
}

export default useCesiumStereo
