/**
 * Babylon.js-specific type definitions
 *
 * These types define interfaces for Babylon.js rendering, including scene
 * management, weather effects, aircraft labels, and camera synchronization.
 */

import type * as BABYLON from '@babylonjs/core'
import type * as GUI from '@babylonjs/gui'
import type * as Cesium from 'cesium'

// ============================================================================
// Aircraft Label Types
// ============================================================================

/**
 * Aircraft datablock label with leader line in Babylon.js GUI.
 *
 * Labels are rendered as 2D GUI elements positioned at the 3D aircraft location
 * using screen-space projection. Each label consists of:
 * - Rectangle container with background color
 * - TextBlock with aircraft info (callsign, type, altitude, speed)
 * - Line connecting label to aircraft position (leader line)
 */
export interface AircraftLabel {
  /** Rectangle container for the label */
  label: GUI.Rectangle
  /** Text block displaying aircraft information */
  labelText: GUI.TextBlock
  /** Leader line connecting label to aircraft */
  leaderLine: GUI.Line
}

// ============================================================================
// Weather Effect Types
// ============================================================================

/**
 * Cloud layer mesh and material data for weather visualization.
 *
 * Each cloud layer is represented as a large horizontal plane mesh positioned
 * at the METAR-reported cloud altitude. The material controls opacity based on
 * cloud coverage (SCT/BKN/OVC).
 */
export interface CloudMeshData {
  /** Horizontal plane mesh representing the cloud layer */
  plane: BABYLON.Mesh
  /** Semi-transparent material with configurable opacity */
  material: BABYLON.StandardMaterial
}

// ============================================================================
// Scene Initialization Types
// ============================================================================

/**
 * Options for initializing Babylon.js overlay.
 *
 * The Babylon overlay is a transparent canvas positioned above the Cesium viewer,
 * synchronized via camera transforms. It renders screen-space elements (labels,
 * leader lines) and weather effects (fog dome, cloud layers).
 */
export interface BabylonOverlayOptions {
  /** Cesium viewer instance to synchronize with */
  cesiumViewer: Cesium.Viewer | null
  /** HTML canvas element for Babylon rendering (must be overlaid on Cesium) */
  canvas: HTMLCanvasElement | null
}

/**
 * Options for initializing a Babylon.js scene.
 *
 * Used by useBabylonScene hook to configure engine and scene parameters.
 */
export interface BabylonSceneOptions {
  /** HTML canvas element for rendering */
  canvas: HTMLCanvasElement
  /** Enable anti-aliasing (default: true, uses MSAA 4x) */
  antialias?: boolean
  /** Enable transparent background (default: true for overlay mode) */
  transparent?: boolean
  /** Device pixel ratio multiplier (default: window.devicePixelRatio) */
  devicePixelRatio?: number
}

// ============================================================================
// Camera Synchronization Types
// ============================================================================

/**
 * Options for Babylon camera synchronization with Cesium.
 *
 * Used by useBabylonCameraSync to configure ENU coordinate transforms and
 * camera matrix updates.
 */
export interface BabylonCameraSyncOptions {
  /** Cesium viewer to read camera state from */
  cesiumViewer: Cesium.Viewer | null
  /** Babylon camera to update */
  camera: BABYLON.FreeCamera | null
  /** Optional fog dome mesh to position at camera location */
  fogDome?: BABYLON.Mesh | null
}

// ============================================================================
// ENU Transform Types
// ============================================================================

/**
 * ENU (East-North-Up) coordinate system transform data.
 *
 * Defines the transformation from Cesium's ECEF (Earth-Centered Earth-Fixed)
 * coordinate system to Babylon's local ENU coordinate system centered at a
 * reference point (typically the tower location).
 *
 * @see docs/coordinate-systems.md for detailed explanation
 */
export interface EnuTransformData {
  /** Base position in Cesium Cartesian3 (ECEF coordinates) */
  baseCartesian: Cesium.Cartesian3
  /** Transformation matrix from ENU to ECEF */
  enuToFixed: Cesium.Matrix4
  /** Transformation matrix from ECEF to ENU */
  fixedToEnu: Cesium.Matrix4
  /** Base position in Babylon Vector3 (ENU coordinates, always origin) */
  basePoint: BABYLON.Vector3
  /** Up vector at base position in Babylon coordinates */
  basePointUp: BABYLON.Vector3
}

// ============================================================================
// Weather Visibility Types
// ============================================================================

/**
 * Parameters for weather-based visibility culling.
 *
 * Used to determine if aircraft labels should be visible based on METAR
 * weather conditions (fog, clouds).
 */
export interface WeatherVisibilityParams {
  /** Camera altitude above ground in meters (AGL) */
  cameraAltitudeMeters: number
  /** Aircraft altitude above ground in meters (AGL) */
  aircraftAltitudeMeters: number
  /** Horizontal distance from camera to aircraft in meters */
  horizontalDistanceMeters: number
}

// ============================================================================
// Memory Diagnostic Types
// ============================================================================

/**
 * Memory diagnostic counters for Babylon.js resource management.
 *
 * Tracks creation and disposal of Babylon resources to detect memory leaks.
 * All counters should increment during normal operation. Disposal counters
 * should match creation counters after cleanup.
 */
export interface BabylonMemoryCounters {
  /** Number of materials created */
  materialsCreated: number
  /** Number of materials disposed */
  materialsDisposed: number
  /** Number of meshes created */
  meshesCreated: number
  /** Number of meshes disposed */
  meshesDisposed: number
  /** Number of GUI controls created */
  guiControlsCreated: number
  /** Number of GUI controls disposed */
  guiControlsDisposed: number
}

// ============================================================================
// Hook Return Types
// ============================================================================

/**
 * Return type for useBabylonScene hook.
 *
 * Provides access to the initialized Babylon.js engine, scene, and camera.
 */
export interface UseBabylonSceneResult {
  /** Babylon engine instance (or null if not initialized) */
  engine: BABYLON.Engine | null
  /** Babylon scene instance (or null if not initialized) */
  scene: BABYLON.Scene | null
  /** Babylon camera instance (or null if not initialized) */
  camera: BABYLON.FreeCamera | null
  /** GUI texture for 2D overlays (or null if not initialized) */
  guiTexture: GUI.AdvancedDynamicTexture | null
  /** Whether the scene is ready for rendering */
  sceneReady: boolean
}

/**
 * Return type for useBabylonWeather hook.
 *
 * Provides access to weather effect meshes and visibility culling function.
 */
export interface UseBabylonWeatherResult {
  /** Fog dome mesh (or null if not created) */
  fogDome: BABYLON.Mesh | null
  /** Array of cloud layer mesh data (0-4 layers) */
  cloudLayers: CloudMeshData[]
  /** Function to check if aircraft label should be visible based on weather */
  isVisibleByWeather: (params: WeatherVisibilityParams) => boolean
}

/**
 * Return type for useBabylonLabels hook.
 *
 * Provides functions to manage aircraft datablock labels and leader lines.
 */
export interface UseBabylonLabelsResult {
  /** Create or update an aircraft label with text and colors */
  updateLabel: (
    callsign: string,
    color: { r: number; g: number; b: number },
    isFollowed: boolean,
    labelText?: string
  ) => void
  /** Update label position and leader line using screen coordinates */
  updateLabelPosition: (
    callsign: string,
    screenX: number,
    screenY: number,
    labelOffsetX: number,
    labelOffsetY: number
  ) => void
  /** Remove an aircraft label and dispose resources */
  removeLabel: (callsign: string) => void
  /** Remove all aircraft labels and dispose all resources */
  clearAllLabels: () => void
  /** Get label data for a specific aircraft (or undefined if not exists) */
  getLabel: (callsign: string) => AircraftLabel | undefined
  /** Get array of all current aircraft callsigns with labels */
  getAircraftCallsigns: () => string[]
  /** Hide all labels (called at frame start before updating visible ones) */
  hideAllLabels: () => void
}

/**
 * Return type for useBabylonRootNode hook.
 *
 * Provides access to the ENU transform root node and coordinate conversion functions.
 */
export interface UseBabylonRootNodeResult {
  /** Root transform node at ENU origin (tower location) */
  rootNode: BABYLON.TransformNode | null
  /** Setup root node at a geographic position */
  setupRootNode: (lat: number, lon: number, height: number) => void
  /** Get the ENU to ECEF transformation matrix */
  getEnuToFixed: () => Cesium.Matrix4 | null
  /** Get the ECEF to ENU transformation matrix */
  getFixedToEnu: () => Cesium.Matrix4 | null
  /** Get terrain offset (actual terrain height - MSL elevation) */
  getTerrainOffset: () => number
}

/**
 * Return type for useBabylonCameraSync hook.
 *
 * Provides functions to synchronize Babylon camera with Cesium camera.
 */
export interface UseBabylonCameraSyncResult {
  /** Setup ENU transforms for a base position (tower location) */
  setupBasePosition: (lat: number, lon: number, height: number) => void
  /** Sync the Babylon camera with Cesium's camera */
  syncCamera: () => void
  /** Check if we're in top-down mode */
  isTopDownMode: () => boolean
  /** Get current 2D camera state (lat/lon/heading for aircraft positioning) */
  get2DState: () => { lat: number; lon: number; heading: number }
  /** Get the fixed-to-ENU transformation matrix */
  getFixedToEnuMatrix: () => Cesium.Matrix4 | null
  /** Get terrain offset for altitude correction */
  getTerrainOffset: () => number
  /** Set terrain offset (called after terrain sampling) */
  setTerrainOffset: (offset: number) => void
}
