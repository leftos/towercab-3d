import { useRef, useCallback, useEffect } from 'react'
import * as Cesium from 'cesium'
import { useVRStore } from '../stores/vrStore'
import {
  saveCameraState,
  restoreCameraState,
  configureEyeCamera
} from '../utils/cesiumFrustumPatch'

/**
 * Hook for managing Cesium stereo rendering for VR
 *
 * When VR is active, this hook:
 * 1. Takes control of Cesium's render loop
 * 2. Renders each frame twice (left and right eye)
 * 3. Captures each eye's render to a canvas/texture
 * 4. Provides the textures to the VR scene for display
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
      // Initialize the frame
      scene.initializeFrame()

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
