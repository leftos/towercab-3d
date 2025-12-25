import { useCallback, useRef } from 'react'
import * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import {
  calculateBabylonCameraSync,
  setupEnuTransforms,
  type EnuTransformData
} from '../utils/enuTransforms'

interface Camera2DState {
  lat: number
  lon: number
  heading: number
}

interface CloudMeshData {
  plane: BABYLON.Mesh
  dome: BABYLON.Mesh
  material: BABYLON.StandardMaterial
  domeMaterial: BABYLON.StandardMaterial
}

interface UseBabylonCameraSyncOptions {
  cesiumViewer: Cesium.Viewer | null
  camera: BABYLON.FreeCamera | null
  fogDome: BABYLON.Mesh | null
  /** Getter function for cloud meshes - called each frame to get current meshes */
  getCloudMeshes: () => CloudMeshData[]
  /** Getter for fixed-to-ENU transformation matrix from useBabylonRootNode */
  getFixedToEnu: () => Cesium.Matrix4 | null
}

interface UseBabylonCameraSyncResult {
  /** Setup ENU transforms for a base position (tower location) */
  setupBasePosition: (lat: number, lon: number, height: number) => void
  /** Sync the Babylon camera with Cesium's camera */
  syncCamera: () => void
  /** Check if we're in top-down mode */
  isTopDownMode: () => boolean
  /** Get current 2D camera state (lat/lon/heading for aircraft positioning) */
  get2DState: () => Camera2DState
  /** Get the fixed-to-ENU transformation matrix */
  getFixedToEnuMatrix: () => Cesium.Matrix4 | null
  /** Get terrain offset for altitude correction */
  getTerrainOffset: () => number
  /** Set terrain offset (called after terrain sampling) */
  setTerrainOffset: (offset: number) => void
}

/**
 * Synchronizes Babylon.js camera with Cesium camera using ENU coordinate transforms.
 *
 * ## Responsibilities
 * - Converts Cesium's ECEF (Earth-Centered Earth-Fixed) camera to Babylon's local ENU coordinate system
 * - Handles both 3D perspective view and 2D top-down orthographic view
 * - Synchronizes camera position, rotation (Euler angles), and FOV each frame
 * - Manages terrain offset calculations for accurate altitude positioning
 * - Positions fog dome at camera location for weather effects
 *
 * ## Dependencies
 * - Requires: Cesium viewer and Babylon FreeCamera instances (must be initialized)
 * - Reads: Cesium camera's position, orientation, and FOV
 * - Writes: Babylon camera's position, rotation, FOV, and fog dome position
 * - Uses: ENU transform data from `setupEnuTransforms()` utility
 *
 * ## Call Order
 * This hook should be called in the Babylon overlay setup, before rendering aircraft:
 * ```typescript
 * function BabylonOverlay() {
 *   const cesiumViewer = useRef<Cesium.Viewer>(null)
 *   const babylonCamera = useRef<BABYLON.FreeCamera>(null)
 *   const fogDome = useRef<BABYLON.Mesh>(null)
 *
 *   // Setup camera sync
 *   const { setupBasePosition, syncCamera } = useBabylonCameraSync({
 *     cesiumViewer: cesiumViewer.current,
 *     camera: babylonCamera.current,
 *     fogDome: fogDome.current
 *   })
 *
 *   // Initialize base position when airport changes
 *   useEffect(() => {
 *     if (airport) {
 *       setupBasePosition(airport.latitude, airport.longitude, elevationMeters)
 *     }
 *   }, [airport])
 *
 *   // Sync camera each frame
 *   useEffect(() => {
 *     const interval = setInterval(() => syncCamera(), 16) // 60Hz
 *     return () => clearInterval(interval)
 *   }, [])
 * }
 * ```
 *
 * ## Coordinate System Transform
 *
 * This hook bridges two coordinate systems:
 *
 * ### Cesium (ECEF - Earth-Centered Earth-Fixed)
 * - Origin: Earth's center
 * - X-axis: Equator at prime meridian
 * - Y-axis: Equator at 90°E
 * - Z-axis: North pole
 * - Units: Meters
 *
 * ### Babylon (ENU - East-North-Up)
 * - Origin: Tower/airport location
 * - X-axis: East
 * - Y-axis: Up (away from Earth's center)
 * - Z-axis: North
 * - Units: Meters
 *
 * The conversion uses a transformation matrix (`fixedToEnu`) that rotates and translates
 * from ECEF to ENU. See `docs/coordinate-systems.md` for detailed explanation.
 *
 * ## View Mode Handling
 *
 * The hook automatically detects view mode based on Cesium camera pitch:
 * - **Pitch < -80°** (approx -1.4 radians): Top-down mode
 * - **Pitch >= -80°**: 3D perspective mode
 *
 * ### 3D Perspective Mode
 * 1. Transform Cesium camera position from ECEF → ENU using `fixedToEnu` matrix
 * 2. Extract camera direction and up vectors
 * 3. Convert to Babylon Euler angles (rotationX, rotationY, rotationZ)
 * 4. Apply position and rotation to Babylon camera
 * 5. Sync FOV from Cesium's frustum
 *
 * ### Top-Down Mode
 * 1. Get Cesium camera's geographic position (lat/lon/height)
 * 2. Store as 2D state for aircraft positioning
 * 3. Position Babylon camera at origin (0, height, 0)
 * 4. Set rotation to look straight down (Math.PI / 2, 0, 0)
 * 5. No coordinate transform needed (simplified positioning)
 *
 * ## Terrain Offset
 *
 * The terrain offset accounts for the difference between:
 * - **MSL elevation** (mean sea level, from airport database)
 * - **Actual terrain height** (from Cesium's terrain provider)
 *
 * This offset is used to position aircraft models at the correct altitude above terrain:
 * ```typescript
 * aircraftAltitudeAboveTerrain = aircraftAltitudeMSL - terrainOffset
 * ```
 *
 * The offset is calculated by sampling Cesium terrain at the base position:
 * - Called automatically when `setupBasePosition()` is invoked
 * - Asynchronously fetches terrain height via `sampleTerrainMostDetailed()`
 * - Falls back to 0 if terrain sampling fails
 *
 * ## 2D State for Aircraft Positioning
 *
 * In top-down mode, aircraft positions are calculated differently:
 * - Normal mode: Use ENU transforms to convert lat/lon → local X/Z
 * - Top-down mode: Use simple lat/lon deltas from camera position
 *
 * The `get2DState()` function provides camera's current lat/lon/heading for this calculation.
 *
 * ## Fog Dome Positioning
 *
 * The fog dome (weather visibility sphere) is positioned at the camera location:
 * - Follows camera movement in both 3D and top-down modes
 * - Uses `fogDome.position.copyFrom(camera.position)` for direct copy
 * - Updated every frame during `syncCamera()`
 *
 * ## Performance Considerations
 *
 * - **Matrix multiplication**: One 4×4 matrix transform per frame (~60Hz)
 * - **Euler angle extraction**: Trigonometric calculations for rotation conversion
 * - **Terrain sampling**: Asynchronous, only called when base position changes (rare)
 * - **Overall cost**: <0.1ms per frame on typical hardware
 *
 * ## Rotation Convention
 *
 * Babylon.js uses **right-handed** Euler angles with **YXZ** rotation order:
 * - rotationX: Pitch (looking up/down)
 * - rotationY: Yaw (turning left/right)
 * - rotationZ: Roll (tilting side-to-side)
 *
 * The conversion from direction/up vectors to Euler angles is handled by `calculateBabylonCameraSync()`
 * in `utils/enuTransforms.ts`.
 *
 * @param options - Configuration options
 * @param options.cesiumViewer - The Cesium viewer instance (must not be destroyed)
 * @param options.camera - The Babylon FreeCamera to synchronize (must not be disposed)
 * @param options.fogDome - Optional fog dome mesh to position at camera (can be null)
 * @returns Camera sync controls and state accessors
 *
 * @example
 * // Basic usage with camera sync
 * const { setupBasePosition, syncCamera } = useBabylonCameraSync({
 *   cesiumViewer: viewer,
 *   camera: babylonCamera,
 *   fogDome: fogDomeMesh
 * })
 *
 * // Setup ENU origin at tower
 * setupBasePosition(37.619, -122.375, 4) // KSFO tower
 *
 * // Sync every frame
 * scene.onBeforeRenderObservable.add(() => {
 *   syncCamera()
 * })
 *
 * @example
 * // Using 2D state for aircraft positioning
 * const { get2DState, isTopDownMode } = useBabylonCameraSync({
 *   cesiumViewer: viewer,
 *   camera: babylonCamera,
 *   fogDome: null
 * })
 *
 * if (isTopDownMode()) {
 *   const { lat, lon, heading } = get2DState()
 *   // Position aircraft relative to camera lat/lon
 * }
 *
 * @example
 * // Reading terrain offset for altitude correction
 * const { getTerrainOffset } = useBabylonCameraSync({
 *   cesiumViewer: viewer,
 *   camera: babylonCamera,
 *   fogDome: null
 * })
 *
 * const aircraftHeightAboveTerrain = aircraftAltitudeMSL - getTerrainOffset()
 *
 * @see utils/enuTransforms.ts - For ENU coordinate transformation utilities
 * @see docs/coordinate-systems.md - For detailed coordinate system explanation
 * @see useBabylonOverlay - Primary consumer of this hook for aircraft rendering
 */
export function useBabylonCameraSync({
  cesiumViewer,
  camera,
  fogDome,
  getCloudMeshes,
  getFixedToEnu
}: UseBabylonCameraSyncOptions): UseBabylonCameraSyncResult {
  // ENU transformation data
  const enuDataRef = useRef<EnuTransformData | null>(null)

  // For 2D view: simple lat/lon based positioning
  const camera2DStateRef = useRef<Camera2DState>({ lat: 0, lon: 0, heading: 0 })
  const isTopDownModeRef = useRef(false)

  // Terrain offset: difference between MSL elevation and actual Cesium terrain height
  const terrainOffsetRef = useRef<number>(0)

  // Setup ENU transforms for a given base position
  const setupBasePosition = useCallback((lat: number, lon: number, height: number) => {
    enuDataRef.current = setupEnuTransforms(lat, lon, height)

    // Sample terrain to calculate offset
    if (cesiumViewer?.terrainProvider) {
      const positions = [Cesium.Cartographic.fromDegrees(lon, lat)]
      Cesium.sampleTerrainMostDetailed(cesiumViewer.terrainProvider, positions).then((updatedPositions) => {
        const terrainHeight = updatedPositions[0].height
        terrainOffsetRef.current = terrainHeight - height
      }).catch((err) => {
        console.warn('Failed to sample terrain, using default offset:', err)
        terrainOffsetRef.current = 0
      })
    }
  }, [cesiumViewer])

  // Sync Babylon camera for 2D topdown view
  const syncCamera2D = useCallback(() => {
    if (!cesiumViewer || cesiumViewer.isDestroyed() || !camera) return

    camera.rotationQuaternion = null
    isTopDownModeRef.current = true

    // Get Cesium camera's geographic position
    const cartographic = Cesium.Cartographic.fromCartesian(cesiumViewer.camera.positionWC)
    const camLat = Cesium.Math.toDegrees(cartographic.latitude)
    const camLon = Cesium.Math.toDegrees(cartographic.longitude)
    const camHeight = cartographic.height

    // Store camera state for aircraft positioning
    camera2DStateRef.current = {
      lat: camLat,
      lon: camLon,
      heading: cesiumViewer.camera.heading
    }

    // Position Babylon camera at origin, at the same height as Cesium camera
    camera.position.set(0, camHeight, 0)

    // Set FOV from Cesium
    const frustum = cesiumViewer.camera.frustum
    if (frustum instanceof Cesium.PerspectiveFrustum && frustum.fovy !== undefined) {
      camera.fov = frustum.fovy
    }

    // Look straight down with no rotation
    camera.rotation.set(Math.PI / 2, 0, 0)

    // Position fog dome at camera position
    if (fogDome) {
      fogDome.position.copyFrom(camera.position)
    }

    // Hide cloud planes in top-down mode (they would obscure the view)
    const cloudMeshes = getCloudMeshes()
    for (const meshData of cloudMeshes) {
      meshData.plane.isVisible = false
    }
  }, [cesiumViewer, camera, fogDome, getCloudMeshes])

  // Sync Babylon camera for 3D view
  const syncCamera3D = useCallback((): boolean => {
    const fixedToEnu = getFixedToEnu()
    if (!cesiumViewer || cesiumViewer.isDestroyed() || !camera || !fixedToEnu) return false

    // Clear any quaternion so Euler angles work
    camera.rotationQuaternion = null
    isTopDownModeRef.current = false

    // Use the utility function for camera sync calculation
    const syncData = calculateBabylonCameraSync(cesiumViewer, fixedToEnu)
    if (!syncData) return false

    // Apply position, rotation, and FOV
    camera.position.copyFrom(syncData.position)
    camera.rotation.set(
      syncData.rotation.rotationX,
      syncData.rotation.rotationY,
      syncData.rotation.rotationZ
    )
    camera.fov = syncData.fov

    // Position fog dome at camera position
    if (fogDome) {
      fogDome.position.copyFrom(camera.position)
    }

    // Position cloud planes at camera X/Z position (clouds follow camera horizontally)
    // Y position is already set by useBabylonWeather based on cloud altitude AGL
    const cloudMeshes = getCloudMeshes()
    for (const meshData of cloudMeshes) {
      if (meshData.plane.isVisible) {
        meshData.plane.position.x = camera.position.x
        meshData.plane.position.z = camera.position.z
      }
    }

    return true
  }, [cesiumViewer, camera, fogDome, getCloudMeshes, getFixedToEnu])

  // Main sync camera function - dispatches to 2D or 3D based on view
  const syncCamera = useCallback(() => {
    if (!cesiumViewer || cesiumViewer.isDestroyed()) return

    // Check if we're in topdown view by looking at the camera pitch
    // Cesium pitch: -PI/2 = looking straight down
    const isTopDown = cesiumViewer.camera.pitch < -1.4  // roughly -80 degrees or more

    if (isTopDown) {
      syncCamera2D()
    } else {
      syncCamera3D()
    }
  }, [cesiumViewer, syncCamera2D, syncCamera3D])

  // Getters for state access
  const isTopDownMode = useCallback(() => isTopDownModeRef.current, [])
  const get2DState = useCallback(() => camera2DStateRef.current, [])
  const getFixedToEnuMatrix = useCallback(() => enuDataRef.current?.fixedToEnu ?? null, [])
  const getTerrainOffset = useCallback(() => terrainOffsetRef.current, [])
  const setTerrainOffset = useCallback((offset: number) => {
    terrainOffsetRef.current = offset
  }, [])

  return {
    setupBasePosition,
    syncCamera,
    isTopDownMode,
    get2DState,
    getFixedToEnuMatrix,
    getTerrainOffset,
    setTerrainOffset
  }
}

export default useBabylonCameraSync
