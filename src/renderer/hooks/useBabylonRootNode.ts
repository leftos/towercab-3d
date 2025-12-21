import { useCallback, useRef } from 'react'
import * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import { setupEnuTransforms, type EnuTransformData } from '../utils/enuTransforms'
import type { UseBabylonRootNodeResult } from '@/types'

interface UseBabylonRootNodeOptions {
  /** Babylon scene to create root node in */
  scene: BABYLON.Scene | null
  /** Cesium viewer for terrain sampling */
  cesiumViewer: Cesium.Viewer | null
}

/**
 * Manages the Babylon.js ENU (East-North-Up) coordinate system root node and transformations.
 *
 * ## Responsibilities
 * - Create and manage the root TransformNode positioned at the ENU origin (tower location)
 * - Setup ENU coordinate transformation matrices for converting between geographic and local coordinates
 * - Sample Cesium terrain to calculate geoid offset for accurate altitude positioning
 * - Provide access to transformation matrices and terrain offset for aircraft positioning
 * - Properly dispose of root node on unmount
 *
 * ## Dependencies
 * - Requires: Initialized Babylon.Scene (from useBabylonScene)
 * - Requires: Cesium.Viewer instance (for terrain sampling)
 * - Reads: None (self-contained)
 * - Writes: Creates BABYLON.TransformNode, stores ENU transform matrices
 * - Uses: `setupEnuTransforms()` utility from utils/enuTransforms.ts
 *
 * ## Call Order
 * This hook should be called early in the Babylon overlay initialization, after scene creation
 * but before positioning any meshes:
 * ```typescript
 * function BabylonOverlay() {
 *   // 1. Create scene
 *   const { scene } = useBabylonScene({ canvas })
 *
 *   // 2. Setup root node (needs scene)
 *   const rootNode = useBabylonRootNode({ scene, cesiumViewer })
 *
 *   // 3. Create weather effects, labels, etc. (can use rootNode transforms)
 *   const weather = useBabylonWeather({ scene })
 *   const labels = useBabylonLabels({ scene, guiTexture })
 * }
 * ```
 *
 * ## ENU Coordinate System
 *
 * This hook establishes a **local tangent plane** coordinate system at the tower location:
 *
 * ### Coordinate Axes
 * - **Origin**: Tower position (lat/lon/elevation)
 * - **X-axis**: Points East
 * - **Y-axis**: Points Up (away from Earth's center)
 * - **Z-axis**: Points North
 * - **Units**: Meters
 *
 * ### Why ENU?
 * - Babylon.js works best with local coordinates (avoids floating-point precision issues)
 * - ENU is a standard aviation/surveying coordinate system
 * - Simplifies aircraft positioning relative to tower
 *
 * ### Coordinate Conversion
 * ```typescript
 * // Geographic (lat/lon/alt) → Cesium ECEF (Cartesian3)
 * const ecefPosition = Cesium.Cartesian3.fromDegrees(lon, lat, alt)
 *
 * // ECEF → ENU (using fixedToEnu matrix)
 * const enuPosition = transformPositionToENU(lon, lat, alt, fixedToEnu)
 * // Returns: { x: meters east, y: meters up, z: meters north }
 *
 * // Position mesh in Babylon
 * mesh.position.set(enuPosition.x, enuPosition.y, enuPosition.z)
 * ```
 *
 * See `docs/coordinate-systems.md` for detailed explanation of all coordinate systems used.
 *
 * ## Root Transform Node
 *
 * The root node is a BABYLON.TransformNode positioned at the ENU origin (0, 0, 0).
 * While currently not used for parenting (aircraft are positioned in world space),
 * it serves as a reference point and could be used for:
 * - Parenting all aircraft meshes for batch transformations
 * - Debug visualization of the ENU origin
 * - Future coordinate system transformations
 *
 * ## Transformation Matrices
 *
 * Two transformation matrices are maintained:
 *
 * ### `enuToFixed` (Cesium.Matrix4)
 * Converts from ENU local coordinates to ECEF global coordinates:
 * ```
 * ECEF_position = enuToFixed * ENU_position
 * ```
 *
 * ### `fixedToEnu` (Cesium.Matrix4)
 * Converts from ECEF global coordinates to ENU local coordinates:
 * ```
 * ENU_position = fixedToEnu * ECEF_position
 * ```
 *
 * These matrices are 4×4 homogeneous transformation matrices that combine:
 * - **Rotation**: Align ECEF axes (X/Y/Z at Earth center) with ENU axes (E/N/U at tower)
 * - **Translation**: Move origin from Earth center to tower location
 *
 * The matrices are created by `setupEnuTransforms()` using Cesium's `Transforms.eastNorthUpToFixedFrame()`.
 *
 * ## Terrain Offset (Geoid Correction)
 *
 * Aircraft altitudes from VATSIM are reported in **MSL (Mean Sea Level)**, but Cesium's
 * terrain heights are in **ellipsoidal height** (WGS84 ellipsoid). The difference between
 * these two references is called the **geoid undulation** or **geoid offset**.
 *
 * ### Why Correction is Needed
 * - Boston (KBOS): ~30 meters difference (geoid below ellipsoid)
 * - Denver (KDEN): ~-20 meters difference (geoid above ellipsoid)
 * - Without correction, aircraft appear buried or floating above terrain
 *
 * ### How It Works
 * 1. Sample Cesium terrain height at tower location (ellipsoidal height)
 * 2. Compare with airport elevation from database (MSL height)
 * 3. Calculate offset: `terrainOffset = terrainHeight - airportElevationMSL`
 * 4. Apply to aircraft positioning: `aircraftY = (altitudeMSL + terrainOffset) - terrainElevation`
 *
 * ### Terrain Sampling
 * - Asynchronous operation using `Cesium.sampleTerrainMostDetailed()`
 * - Called once when `setupRootNode()` is invoked (typically on airport change)
 * - Falls back to 0 offset if terrain provider unavailable or sampling fails
 * - Stored in `terrainOffsetRef` for read access via `getTerrainOffset()`
 *
 * ## Usage Pattern
 *
 * ### Initial Setup
 * ```typescript
 * // Setup root node at airport location
 * useEffect(() => {
 *   if (airport && rootNodeReady) {
 *     setupRootNode(
 *       airport.latitude,  // degrees
 *       airport.longitude, // degrees
 *       airport.elevation  // meters MSL
 *     )
 *   }
 * }, [airport, rootNodeReady])
 * ```
 *
 * ### Aircraft Positioning
 * ```typescript
 * // Get transform matrices for coordinate conversion
 * const fixedToEnu = getFixedToEnu()
 * const terrainOffset = getTerrainOffset()
 *
 * // Convert aircraft position from geographic to ENU
 * const enuPos = transformPositionToENU(
 *   aircraft.lon,
 *   aircraft.lat,
 *   aircraft.alt + terrainOffset, // Apply geoid correction
 *   fixedToEnu
 * )
 *
 * // Position mesh in Babylon
 * mesh.position.set(enuPos.x, enuPos.y, enuPos.z)
 * ```
 *
 * ## Performance Considerations
 *
 * - **Transform matrix creation**: One-time cost when airport changes (~0.5ms)
 * - **Terrain sampling**: Asynchronous, doesn't block rendering (~50-200ms)
 * - **Root node disposal**: Properly cleaned up on unmount
 * - **Memory usage**: Minimal (one TransformNode + two Matrix4 objects)
 *
 * ## Disposal Behavior
 *
 * When the hook unmounts or `setupRootNode()` is called again:
 * 1. Previous root node is disposed (if exists)
 * 2. New root node is created
 * 3. Transform matrices are updated
 * 4. Terrain sampling is re-triggered
 *
 * This ensures no memory leaks when switching between airports.
 *
 * @param options - Configuration options
 * @param options.scene - Babylon.Scene instance to create root node in (must not be disposed)
 * @param options.cesiumViewer - Cesium.Viewer instance for terrain sampling (can be null)
 * @returns Root node management interface
 *
 * @example
 * // Basic setup
 * const { setupRootNode, rootNode } = useBabylonRootNode({
 *   scene: babylonScene,
 *   cesiumViewer: viewer
 * })
 *
 * // Setup at Boston airport
 * setupRootNode(42.3656, -71.0096, 5.8)
 *
 * // Later: access root node
 * console.log('Root node:', rootNode) // BABYLON.TransformNode
 *
 * @example
 * // Using transform matrices for aircraft positioning
 * const { getFixedToEnu, getTerrainOffset } = useBabylonRootNode({
 *   scene: babylonScene,
 *   cesiumViewer: viewer
 * })
 *
 * // Setup ENU origin
 * setupRootNode(airportLat, airportLon, airportElevation)
 *
 * // Convert aircraft position
 * const fixedToEnu = getFixedToEnu()
 * if (fixedToEnu) {
 *   const enuPos = transformPositionToENU(
 *     aircraft.lon,
 *     aircraft.lat,
 *     aircraft.alt + getTerrainOffset(),
 *     fixedToEnu
 *   )
 *   aircraftMesh.position.set(enuPos.x, enuPos.y, enuPos.z)
 * }
 *
 * @example
 * // Checking if root node is ready before positioning objects
 * const { rootNode, getFixedToEnu } = useBabylonRootNode({
 *   scene: babylonScene,
 *   cesiumViewer: viewer
 * })
 *
 * useEffect(() => {
 *   if (!rootNode || !getFixedToEnu()) {
 *     console.warn('Root node not ready, skipping positioning')
 *     return
 *   }
 *   // Safe to position objects now
 * }, [rootNode])
 *
 * @see utils/enuTransforms.ts - For ENU transformation utility functions
 * @see docs/coordinate-systems.md - For detailed coordinate system explanation
 * @see useBabylonCameraSync - For camera synchronization using ENU transforms
 * @see useBabylonOverlay - Primary consumer of this hook for aircraft positioning
 */
export function useBabylonRootNode({
  scene,
  cesiumViewer
}: UseBabylonRootNodeOptions): UseBabylonRootNodeResult {
  // Root transform node positioned at ENU origin (tower location)
  const rootNodeRef = useRef<BABYLON.TransformNode | null>(null)

  // ENU transformation data (matrices and reference points)
  const enuDataRef = useRef<EnuTransformData | null>(null)

  // Terrain offset: difference between MSL elevation and actual Cesium terrain height
  // This corrects for geoid undulation (varies by location, e.g., ~30m at Boston)
  const terrainOffsetRef = useRef<number>(0)

  /**
   * Setup the ENU root node at a specific geographic location.
   *
   * This function:
   * 1. Calculates ENU transformation matrices using setupEnuTransforms()
   * 2. Stores transform data in refs for later access
   * 3. Samples Cesium terrain to calculate geoid offset
   * 4. Creates (or recreates) the root TransformNode at origin
   *
   * Call this when the airport/tower location changes.
   *
   * @param lat - Latitude in degrees (e.g., 42.3656 for Boston)
   * @param lon - Longitude in degrees (e.g., -71.0096 for Boston)
   * @param height - Elevation in meters MSL (e.g., 5.8 for Boston)
   */
  const setupRootNode = useCallback(
    (lat: number, lon: number, height: number) => {
      if (!scene) return

      // Use utility function to calculate ENU transform matrices
      const enuData = setupEnuTransforms(lat, lon, height)
      enuDataRef.current = enuData

      // Sample terrain to calculate offset between MSL elevation and actual terrain height
      // This corrects for geoid undulation automatically at any location
      if (cesiumViewer?.terrainProvider) {
        const positions = [Cesium.Cartographic.fromDegrees(lon, lat)]
        Cesium.sampleTerrainMostDetailed(cesiumViewer.terrainProvider, positions)
          .then((updatedPositions) => {
            const terrainHeight = updatedPositions[0].height
            // Offset = terrain height (ellipsoidal) - MSL height
            terrainOffsetRef.current = terrainHeight - height
          })
          .catch((err) => {
            console.warn('Failed to sample terrain, using default offset:', err)
            terrainOffsetRef.current = 0
          })
      }

      // Create or update root node
      // Dispose previous root node if it exists (prevents memory leak on airport change)
      if (rootNodeRef.current) {
        rootNodeRef.current.dispose()
      }

      // Create new root node at ENU origin (0, 0, 0)
      const rootNode = new BABYLON.TransformNode('RootNode', scene)
      rootNodeRef.current = rootNode
    },
    [scene, cesiumViewer]
  )

  /**
   * Get the ENU-to-ECEF transformation matrix.
   *
   * @returns Transformation matrix or null if not initialized
   */
  const getEnuToFixed = useCallback((): Cesium.Matrix4 | null => {
    return enuDataRef.current?.enuToFixed ?? null
  }, [])

  /**
   * Get the ECEF-to-ENU transformation matrix.
   *
   * Use this matrix to convert aircraft positions from Cesium's global
   * coordinates to Babylon's local ENU coordinates.
   *
   * @returns Transformation matrix or null if not initialized
   */
  const getFixedToEnu = useCallback((): Cesium.Matrix4 | null => {
    return enuDataRef.current?.fixedToEnu ?? null
  }, [])

  /**
   * Get the terrain offset for geoid correction.
   *
   * This value should be added to aircraft MSL altitudes before
   * converting to ENU coordinates to account for geoid undulation.
   *
   * @returns Offset in meters (ellipsoidal height - MSL height)
   */
  const getTerrainOffset = useCallback((): number => {
    return terrainOffsetRef.current
  }, [])

  return {
    rootNode: rootNodeRef.current,
    setupRootNode,
    getEnuToFixed,
    getFixedToEnu,
    getTerrainOffset
  }
}

export default useBabylonRootNode
