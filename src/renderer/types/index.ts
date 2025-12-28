/**
 * Central type definitions barrel export
 *
 * This file provides a single entry point for importing types from across the application.
 * All type definitions are organized into domain-specific files for better maintainability.
 *
 * @example
 * // Import multiple types from different domains
 * import type { ViewportCameraState, Viewport, Airport, CloudLayer } from '@/types'
 *
 * // Or import everything
 * import type * as Types from '@/types'
 */

// ============================================================================
// CAMERA & VIEWPORT TYPES
// ============================================================================

export type {
  // Camera view modes
  ViewMode,
  FollowMode,

  // Camera state
  ViewportCameraState,
  PreFollowState,
  CameraBookmark
} from './camera'

export type {
  // Viewport layout
  ViewportLayout,
  Viewport,
  AirportViewportConfig,
  ViewModeDefaults
} from './viewport'

// ============================================================================
// VATSIM & AIRCRAFT TYPES
// ============================================================================

export type {
  // VATSIM API response types
  VatsimData,
  VatsimGeneral,
  PilotData,
  FlightPlan,
  ControllerData,
  AtisData,
  ServerData,
  PrefileData,
  FacilityData,
  RatingData,
  PilotRatingData,

  // Aircraft state types
  AircraftState,
  InterpolatedAircraftState
} from './vatsim'

// ============================================================================
// vNAS (Virtual Network ATC System) TYPES
// ============================================================================

export type {
  // vNAS connection types
  VnasEnvironment,
  VnasSessionState,
  VnasStatus,

  // vNAS aircraft data (1Hz real-time updates)
  VnasAircraft
} from './vnas'

// ============================================================================
// AIRPORT TYPES
// ============================================================================

export type {
  // Airport database
  Airport,
  AirportDatabase,

  // Tower configuration
  TowerConfig,
  AirportType,

  // Runway data (for smart sort)
  RunwayEnd,
  Runway,
  RawRunwayCSV
} from './airport'

export {
  // Airport tower heights and utilities
  KNOWN_TOWER_HEIGHTS,
  classifyAirport,
  getEstimatedTowerHeight
} from './airport'

// ============================================================================
// WEATHER TYPES
// ============================================================================

export type {
  // Cloud layers
  CloudLayer,

  // Weather classification
  FlightCategory,
  FogDensity,
  Ceiling,

  // Precipitation
  PrecipitationType,
  PrecipitationIntensity,
  Precipitation,
  PrecipitationState,

  // Wind
  WindState,

  // Weather interpolation
  DistancedMetar,
  InterpolationSource,
  InterpolatedWeather
} from './weather'

// ============================================================================
// SETTINGS TYPES (Phase 5 - New Grouped Structure)
// ============================================================================

export type {
  // Quality/mode enums
  TerrainQuality,
  ShadowQuality,
  DatablockMode,
  DatablockDirection,
  TimeMode,
  Theme,
  FSLTLTextureScale,
  DataSourceType,

  // Settings groups
  CesiumSettings,
  GraphicsSettings,
  CameraSettings,
  WeatherSettings,
  MemorySettings,
  AircraftSettings,
  UISettings,
  FSLTLSettings,
  RealTrafficSettings,

  // Main settings store (NEW grouped structure for Phase 5)
  SettingsStore,

  // Global settings (stored on host file system, shared across browsers)
  GlobalSettings,

  // Global viewport settings (stored on host, shared across browsers)
  GlobalViewModeDefaults,
  GlobalCameraBookmark,
  GlobalDatablockPosition,
  GlobalAirportViewportConfig,
  GlobalOrbitSettings,
  GlobalViewportSettings
} from './settings'

export {
  // Default settings values
  DEFAULT_SETTINGS,

  // Default global settings values
  DEFAULT_GLOBAL_SETTINGS,

  // Default global viewport settings values
  DEFAULT_GLOBAL_VIEWPORT_SETTINGS
} from './settings'

// ============================================================================
// AIRCRAFT TIMELINE TYPES (Unified Interpolation)
// ============================================================================

export type {
  // Data source identifier
  AircraftDataSource,

  // Observation types
  AircraftObservation,
  AircraftMetadata,
  AircraftTimeline,

  // Interpolation result
  TimelineInterpolationResult
} from './aircraft-timeline'

// ============================================================================
// REALTRAFFIC API TYPES
// ============================================================================

export type {
  // API request/response types
  RTAuthRequest,
  RTAuthResponse,
  RTTrafficRequest,
  RTTrafficResponse,
  RTTrafficRecord,
  RTErrorResponse,

  // Store types
  RTConnectionStatus,
  RealTrafficStoreState
} from './realtraffic'

export {
  // Error codes
  RT_ERROR_CODES,

  // Default settings
  DEFAULT_REALTRAFFIC_SETTINGS
} from './realtraffic'

// ============================================================================
// FSLTL (FS Live Traffic Liveries) TYPES
// ============================================================================

export type {
  // Texture scaling
  TextureScale,

  // Model types
  FSLTLModel,
  FSLTLAircraftInfo,
  FSLTLAirlineInfo,
  FSLTLTypeInfo,

  // VMR parsing
  VMRRule,

  // Conversion progress
  ConversionProgress,
  ConvertedModelInfo,

  // Registry
  FSLTLRegistry,
  FSLTLRegistryJSON
} from './fsltl'

export {
  // Texture scale mapping
  TEXTURE_SCALE_PIXELS,

  // Default values
  DEFAULT_FSLTL_SETTINGS,
  DEFAULT_CONVERSION_PROGRESS,

  // Registry utilities
  registryToJSON,
  registryFromJSON,
  createEmptyRegistry,
  parseModelName
} from './fsltl'

// ============================================================================
// MODDING TYPES
// ============================================================================

export type {
  // Model formats
  SupportedModelFormat,

  // Mod manifests
  AircraftModManifest,
  TowerModManifest,

  // Mod registry
  LoadedMod,
  ModRegistry,

  // Custom VMR (Visual Model Rules)
  CustomVMRRule,
  CustomVMRMatch,

  // Tower position types
  View3dPosition,
  ResolvedView2dPosition
} from './mod'

export {
  // Model format utilities
  SUPPORTED_MODEL_FORMATS,
  isSupportedModelFormat,
  getModelFormat,

  // Default mod manifests
  DEFAULT_AIRCRAFT_MOD,
  DEFAULT_TOWER_MOD
} from './mod'

// ============================================================================
// BABYLON.JS TYPES
// ============================================================================

export type {
  // Aircraft labels
  AircraftLabel,

  // Weather effects
  CloudMeshData,

  // Scene initialization
  BabylonOverlayOptions,
  BabylonSceneOptions,

  // Camera synchronization
  BabylonCameraSyncOptions,

  // ENU transforms
  EnuTransformData,

  // Weather visibility
  WeatherVisibilityParams,

  // Memory diagnostics
  BabylonMemoryCounters,

  // Hook return types
  UseBabylonSceneResult,
  UseBabylonWeatherResult,
  UseBabylonLabelsResult,
  UseBabylonRootNodeResult,
  UseBabylonCameraSyncResult
} from './babylon'

// ============================================================================
// REPLAY TYPES
// ============================================================================

export type {
  // Snapshot types
  SerializedAircraftState,
  VatsimSnapshot,

  // Export format
  ReplayExportData,

  // Playback state
  PlaybackMode,
  PlaybackSpeed
} from './replay'

export {
  // Serialization utilities
  serializeAircraftStates,
  deserializeAircraftStates
} from './replay'

// ============================================================================
// EXPORT/IMPORT TYPES
// ============================================================================

export type {
  // Tree view types
  CheckState,
  TreeNodeData,
  SettingMapping,
  SelectiveExportData
} from './exportImport'

// ============================================================================
// TYPE ORGANIZATION NOTES
// ============================================================================

/**
 * Type Organization Guidelines
 *
 * When adding new types, follow these guidelines:
 *
 * 1. **Camera-related types** → `camera.ts`
 *    - View modes, camera state, follow modes
 *    - Used by: viewportStore, useCesiumCamera, useCameraInput
 *
 * 2. **Viewport-related types** → `viewport.ts`
 *    - Layout, viewports, multi-viewport configuration
 *    - Used by: viewportStore, ViewportManager, useDragResize
 *
 * 3. **VATSIM/Aircraft types** → `vatsim.ts`
 *    - API response types, aircraft state, interpolation
 *    - Used by: vatsimStore, useAircraftInterpolation, VatsimService
 *
 * 4. **Airport types** → `airport.ts`
 *    - Airport database, tower configuration
 *    - Used by: airportStore, AirportService
 *
 * 5. **Weather types** → `weather.ts`
 *    - METAR data, cloud layers, fog
 *    - Used by: weatherStore, MetarService, useBabylonOverlay
 *
 * 6. **Settings types** → `settings.ts`
 *    - Application settings (grouped structure)
 *    - Used by: settingsStore, SettingsModal
 *
 * 7. **Modding types** → `mod.ts`
 *    - Custom aircraft/tower models
 *    - Used by: AircraftModelService, TowerModelService
 *
 * 8. **Babylon.js types** → `babylon.ts`
 *    - Babylon rendering, labels, weather effects, ENU transforms
 *    - Used by: useBabylonOverlay, useBabylonScene, useBabylonWeather, useBabylonLabels
 *
 * 9. **FSLTL types** → `fsltl.ts`
 *    - FSLTL model conversion, registry, VMR parsing
 *    - Used by: FSLTLService, AircraftModelService, FSLTLImportPanel
 *
 * Always add comprehensive JSDoc comments with:
 * - Purpose and description
 * - Example usage
 * - Related types/components
 * - Any important constraints or validation rules
 */
