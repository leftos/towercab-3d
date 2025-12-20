import * as Cesium from 'cesium'

/**
 * Cesium Frustum Stereo Rendering Utilities
 *
 * Provides utilities for rendering Cesium scenes in stereo (VR) by applying
 * frustum offsets for left and right eye views.
 *
 * Based on the cesium-vr approach:
 * https://github.com/NICTA/cesium-vr
 *
 * The approach:
 * 1. Save the original camera state
 * 2. Apply VR rotation from head tracking
 * 3. For each eye:
 *    - Configure the camera with eye-specific offset and frustum
 *    - Render the scene
 *    - Capture to texture
 * 4. Restore the original camera
 */

// Store original frustum state for restoration
interface FrustumState {
  xOffset: number
  yOffset: number
}

// Store complete camera state for restoration
interface CameraState {
  position: Cesium.Cartesian3
  direction: Cesium.Cartesian3
  up: Cesium.Cartesian3
  right: Cesium.Cartesian3
  frustumXOffset: number
  frustumYOffset: number
}

const originalFrustumStates = new WeakMap<Cesium.Camera, FrustumState>()
const originalCameraStates = new WeakMap<Cesium.Camera, CameraState>()

/**
 * Calculate the frustum offset needed for stereo rendering
 *
 * @param ipd - Interpupillary distance in meters (default 0.063 = 63mm)
 * @param near - Near plane distance in meters
 * @param focalLength - Focal/convergence distance in meters (typically screen distance)
 * @returns The x-offset to apply to the frustum
 */
export function calculateStereoOffset(
  ipd: number,
  near: number,
  focalLength: number
): number {
  // Asymmetric projection formula: offset = (eye_separation / 2) * (near / focal_length)
  return (ipd / 2) * (near / focalLength)
}

/**
 * Save the current frustum state for later restoration
 */
export function saveFrustumState(camera: Cesium.Camera): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (frustum && 'xOffset' in frustum) {
    originalFrustumStates.set(camera, {
      xOffset: frustum.xOffset,
      yOffset: frustum.yOffset
    })
  }
}

/**
 * Save the complete camera state for later restoration
 */
export function saveCameraState(camera: Cesium.Camera): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  originalCameraStates.set(camera, {
    position: Cesium.Cartesian3.clone(camera.position),
    direction: Cesium.Cartesian3.clone(camera.direction),
    up: Cesium.Cartesian3.clone(camera.up),
    right: Cesium.Cartesian3.clone(camera.right),
    frustumXOffset: frustum?.xOffset ?? 0,
    frustumYOffset: frustum?.yOffset ?? 0
  })
}

/**
 * Restore the camera to its saved state
 */
export function restoreCameraState(camera: Cesium.Camera): void {
  const state = originalCameraStates.get(camera)
  if (!state) return

  Cesium.Cartesian3.clone(state.position, camera.position)
  Cesium.Cartesian3.clone(state.direction, camera.direction)
  Cesium.Cartesian3.clone(state.up, camera.up)
  Cesium.Cartesian3.clone(state.right, camera.right)

  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (frustum && 'xOffset' in frustum) {
    frustum.xOffset = state.frustumXOffset
    frustum.yOffset = state.frustumYOffset
  }
}

/**
 * Clear saved camera state
 */
export function clearCameraState(camera: Cesium.Camera): void {
  originalCameraStates.delete(camera)
}

/**
 * Configure camera for a specific eye in stereo rendering
 * This applies both camera position offset AND frustum offset for proper stereo convergence.
 *
 * @param camera - Cesium camera to configure
 * @param eye - Which eye ('left' or 'right')
 * @param ipd - Interpupillary distance in meters (default 0.063)
 * @param focalLength - Focal length for convergence calculation
 */
export function configureEyeCamera(
  camera: Cesium.Camera,
  eye: 'left' | 'right',
  ipd: number = 0.063,
  focalLength: number = 1.0
): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (!frustum || !('xOffset' in frustum)) {
    console.warn('Camera frustum does not support xOffset')
    return
  }

  const halfIPD = ipd / 2
  const eyeSign = eye === 'left' ? -1 : 1

  // Move camera position horizontally (perpendicular to look direction)
  const right = camera.right
  const offset = Cesium.Cartesian3.multiplyByScalar(
    right,
    eyeSign * halfIPD,
    new Cesium.Cartesian3()
  )
  camera.position = Cesium.Cartesian3.add(camera.position, offset, camera.position)

  // Apply frustum offset for proper convergence
  // The offset compensates for camera displacement so both eyes converge at focal length
  const near = frustum.near
  const frustumOffset = (halfIPD * near) / focalLength
  frustum.xOffset = eyeSign * frustumOffset * -1 // Opposite direction to camera movement
}

/**
 * Apply eye-specific offset to the camera frustum only (no position change)
 * Use this for simpler stereo where only frustum offset is needed.
 *
 * @param camera - Cesium camera to modify
 * @param eye - Which eye to render ('left' or 'right')
 * @param ipd - Interpupillary distance in meters (default 0.063)
 * @param focalLength - Focal/convergence distance in meters (default 1.0)
 */
export function applyEyeOffset(
  camera: Cesium.Camera,
  eye: 'left' | 'right',
  ipd: number = 0.063,
  focalLength: number = 1.0
): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (!frustum || !('xOffset' in frustum)) {
    console.warn('Camera frustum does not support xOffset')
    return
  }

  // Save original state if not already saved
  if (!originalFrustumStates.has(camera)) {
    saveFrustumState(camera)
  }

  // Calculate the offset based on IPD and focal length
  const near = frustum.near
  const offset = calculateStereoOffset(ipd, near, focalLength)

  // Apply offset based on eye
  // Left eye: positive offset (shift frustum right, scene appears shifted left)
  // Right eye: negative offset (shift frustum left, scene appears shifted right)
  frustum.xOffset = eye === 'left' ? offset : -offset
}

/**
 * Apply a direct x-offset to the frustum (for manual control)
 */
export function applyFrustumXOffset(
  camera: Cesium.Camera,
  xOffset: number
): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (!frustum || !('xOffset' in frustum)) {
    console.warn('Camera frustum does not support xOffset')
    return
  }

  if (!originalFrustumStates.has(camera)) {
    saveFrustumState(camera)
  }

  frustum.xOffset = xOffset
}

/**
 * Reset the frustum to its original state
 */
export function resetFrustumOffset(camera: Cesium.Camera): void {
  const frustum = camera.frustum as Cesium.PerspectiveFrustum
  if (!frustum || !('xOffset' in frustum)) {
    return
  }

  const originalState = originalFrustumStates.get(camera)
  if (originalState) {
    frustum.xOffset = originalState.xOffset
    frustum.yOffset = originalState.yOffset
  } else {
    frustum.xOffset = 0
    frustum.yOffset = 0
  }
}

/**
 * Clear the saved frustum state for a camera
 */
export function clearFrustumState(camera: Cesium.Camera): void {
  originalFrustumStates.delete(camera)
}

/**
 * Apply camera position offset for stereo rendering (alternative approach)
 * Moves camera position left/right without frustum offset.
 *
 * @param camera - Cesium camera to modify
 * @param eye - Which eye to render
 * @param ipd - Interpupillary distance in meters
 * @returns The position delta applied (for manual restoration)
 */
export function applyCameraPositionOffset(
  camera: Cesium.Camera,
  eye: 'left' | 'right',
  ipd: number = 0.063
): Cesium.Cartesian3 {
  // Calculate the offset direction (perpendicular to look direction and up)
  const direction = camera.direction
  const up = camera.up
  const right = Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3())
  Cesium.Cartesian3.normalize(right, right)

  // Calculate offset amount (half IPD for each eye)
  const offsetAmount = ipd / 2
  const offset = Cesium.Cartesian3.multiplyByScalar(
    right,
    eye === 'left' ? -offsetAmount : offsetAmount,
    new Cesium.Cartesian3()
  )

  // Apply offset to camera position
  camera.position = Cesium.Cartesian3.add(camera.position, offset, camera.position)

  return offset
}

/**
 * Stereo render helper - renders the scene for both eyes
 * Saves camera state, renders each eye, and restores state.
 *
 * @param scene - Cesium scene to render
 * @param camera - Cesium camera to modify
 * @param ipd - Interpupillary distance
 * @param renderCallback - Callback to execute after each eye render (for texture capture)
 */
export function renderStereoFrame(
  scene: Cesium.Scene,
  camera: Cesium.Camera,
  ipd: number,
  renderCallback: (eye: 'left' | 'right') => void
): void {
  // Save original camera state
  saveCameraState(camera)

  try {
    // Render right eye first (cesium-vr approach: render right, copy, render left)
    configureEyeCamera(camera, 'right', ipd)
    scene.render()
    renderCallback('right')

    // Restore and render left eye
    restoreCameraState(camera)
    configureEyeCamera(camera, 'left', ipd)
    scene.render()
    renderCallback('left')
  } finally {
    // Always restore original camera state
    restoreCameraState(camera)
  }
}

/**
 * Async version of stereo render helper
 */
export async function renderStereo(
  viewer: Cesium.Viewer,
  ipd: number,
  renderCallback: (eye: 'left' | 'right') => void | Promise<void>
): Promise<void> {
  const camera = viewer.camera
  const scene = viewer.scene

  saveCameraState(camera)

  try {
    // Render right eye
    configureEyeCamera(camera, 'right', ipd)
    scene.render()
    await renderCallback('right')

    // Restore and render left eye
    restoreCameraState(camera)
    configureEyeCamera(camera, 'left', ipd)
    scene.render()
    await renderCallback('left')
  } finally {
    restoreCameraState(camera)
  }
}
