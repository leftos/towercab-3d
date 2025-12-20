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

interface UseBabylonCameraSyncOptions {
  cesiumViewer: Cesium.Viewer | null
  camera: BABYLON.FreeCamera | null
  fogDome: BABYLON.Mesh | null
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
 * Hook for synchronizing Babylon.js camera with Cesium camera
 * Handles both 2D (top-down) and 3D view modes
 */
export function useBabylonCameraSync({
  cesiumViewer,
  camera,
  fogDome
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
    if (!cesiumViewer || !camera) return

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
  }, [cesiumViewer, camera, fogDome])

  // Sync Babylon camera for 3D view
  const syncCamera3D = useCallback((): boolean => {
    const fixedToEnu = enuDataRef.current?.fixedToEnu
    if (!cesiumViewer || !camera || !fixedToEnu) return false

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

    return true
  }, [cesiumViewer, camera, fogDome])

  // Main sync camera function - dispatches to 2D or 3D based on view
  const syncCamera = useCallback(() => {
    if (!cesiumViewer) return

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
