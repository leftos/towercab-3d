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
  CameraBookmark,
  FollowMode,
  ModeSpecificState,
  PreFollowState,
  // Camera view modes
  ViewMode,
  // Camera state
  ViewportCameraState,
} from './camera'

export type {
  AirportViewportConfig,
  ViewModeDefaults,
  Viewport,
  // Viewport layout
  ViewportLayout,
} from './viewport'

// ============================================================================
// VATSIM & AIRCRAFT TYPES
// ============================================================================

export type {
  // Aircraft state types
  AircraftState,
  AtisData,
  ControllerData,
  FacilityData,
  FlightPlan,
  InterpolatedAircraftState,
  PilotData,
  PilotRatingData,
  PrefileData,
  RatingData,
  ServerData,
  // VATSIM API response types
  VatsimData,
  VatsimGeneral,
} from './vatsim'

// ============================================================================
// vNAS (Virtual Network ATC System) TYPES
// ============================================================================

export type {
  // vNAS aircraft data (1Hz real-time updates)
  VnasAircraft,
  // vNAS connection types
  VnasEnvironment,
  VnasSessionState,
  VnasStatus,
} from './vnas'

// ============================================================================
// AIRPORT TYPES
// ============================================================================

export type {
  // Airport database
  Airport,
  AirportDatabase,
  AirportType,
  RawRunwayCSV,
  Runway,
  // Runway data (for smart sort)
  RunwayEnd,
  // Tower configuration
  TowerConfig,
} from './airport'

export {
  classifyAirport,
  getEstimatedTowerHeight,
  // Airport tower heights and utilities
  KNOWN_TOWER_HEIGHTS,
} from './airport'

// ============================================================================
// WEATHER TYPES
// ============================================================================

export type {
  Ceiling,
  // Cloud layers
  CloudLayer,
  // Weather interpolation
  DistancedMetar,
  // Weather classification
  FlightCategory,
  FogDensity,
  InterpolatedWeather,
  InterpolationSource,
  Precipitation,
  PrecipitationIntensity,
  PrecipitationState,
  // Precipitation
  PrecipitationType,
  // Wind
  WindState,
} from './weather'

// ============================================================================
// SETTINGS TYPES (Phase 5 - New Grouped Structure)
// ============================================================================

export type {
  AircraftSettings,
  AxisInvertSettings,
  BuildingQuality,
  CameraSettings,
  // Settings groups
  CesiumSettings,
  DatablockDirection,
  DatablockMode,
  DataSourceType,
  FSLTLSettings,
  FSLTLTextureScale,
  GlobalAirportViewportConfig,
  GlobalCameraBookmark,
  GlobalDatablockPosition,
  // Global display settings (shared across browsers for consistent appearance)
  GlobalDisplaySettings,
  GlobalDisplaySettingsUpdate,
  GlobalInsetCameraState,
  GlobalInsetLayout,
  GlobalInsetViewport,
  GlobalOrbitSettings,
  // Global settings (stored on host file system, shared across browsers)
  GlobalSettings,
  // Global viewport settings (stored on host, shared across browsers)
  GlobalViewModeDefaults,
  GlobalViewportSettings,
  GraphicsSettings,
  GroundLabelMode,
  ImageryAdjustments,
  ImageryProviderType,
  InsetCachePreset,
  InsetDatablockMode,
  // Inset display settings (datablock/label visibility)
  InsetDisplaySettings,
  InsetFrameratePreset,
  InsetGraphicsSettings,
  InsetGroundLabelMode,
  // Inset graphics settings (fine-grained control)
  InsetMsaaPreset,
  InsetTerrainPreset,
  MemorySettings,
  MSFSModelSettings,
  // MSFS model types (on-the-fly conversion)
  MSFSModelSource,
  RealTrafficSettings,
  // GPU rendering backend (ANGLE) selection
  RenderingBackend,
  // Main settings store (NEW grouped structure for Phase 5)
  SettingsStore,
  ShadowQuality,
  // Quality/mode enums
  TerrainQuality,
  Theme,
  TimeMode,
  UISettings,
  WeatherSettings,
} from './settings'

export {
  // Default global display settings values
  DEFAULT_GLOBAL_DISPLAY_SETTINGS,
  // Default global settings values
  DEFAULT_GLOBAL_SETTINGS,
  // Default global viewport settings values
  DEFAULT_GLOBAL_VIEWPORT_SETTINGS,
  // Default imagery adjustments
  DEFAULT_IMAGERY_ADJUSTMENTS,
  // Default inset display settings
  DEFAULT_INSET_DISPLAY_SETTINGS,
  // Default inset graphics settings
  DEFAULT_INSET_GRAPHICS_SETTINGS,
  // Default MSFS model settings
  DEFAULT_MSFS_MODEL_SETTINGS,
  // Default settings values
  DEFAULT_SETTINGS,
  // MSFS model cache limits
  MSFS_CACHE_LIMIT,
} from './settings'

// ============================================================================
// AIRCRAFT TIMELINE TYPES (Unified Interpolation)
// ============================================================================

export type {
  // Data source identifier
  AircraftDataSource,
  AircraftMetadata,
  // Observation types
  AircraftObservation,
  AircraftTimeline,
  // Interpolation result
  TimelineInterpolationResult,
} from './aircraft-timeline'

// ============================================================================
// REALTRAFFIC API TYPES
// ============================================================================

export type {
  RealTrafficStoreState,
  // API request/response types
  RTAuthRequest,
  RTAuthResponse,
  // Store types
  RTConnectionStatus,
  RTErrorResponse,
  RTTrafficRecord,
  RTTrafficRequest,
  RTTrafficResponse,
} from './realtraffic'

export {
  // Default settings
  DEFAULT_REALTRAFFIC_SETTINGS,
  // Error codes
  RT_ERROR_CODES,
} from './realtraffic'

// ============================================================================
// FSLTL (FS Live Traffic Liveries) TYPES
// ============================================================================

export type {
  // Conversion progress
  ConversionProgress,
  ConvertedModelInfo,
  FSLTLAircraftInfo,
  FSLTLAirlineInfo,
  // Model types
  FSLTLModel,
  // Registry
  FSLTLRegistry,
  FSLTLRegistryJSON,
  FSLTLTypeInfo,
  // Texture scaling
  TextureScale,
  // VMR parsing
  VMRRule,
} from './fsltl'

export {
  createEmptyRegistry,
  DEFAULT_CONVERSION_PROGRESS,
  // Default values
  DEFAULT_FSLTL_SETTINGS,
  parseModelName,
  registryFromJSON,
  // Registry utilities
  registryToJSON,
  // Texture scale mapping
  TEXTURE_SCALE_PIXELS,
} from './fsltl'

// ============================================================================
// MODDING TYPES
// ============================================================================

export type {
  // Mod manifests
  AircraftModManifest,
  CustomVMRMatch,
  // Custom VMR (Visual Model Rules)
  CustomVMRRule,
  // Mod registry
  LoadedMod,
  ModRegistry,
  ResolvedView2dPosition,
  // Model formats
  SupportedModelFormat,
  TowerModManifest,
  // Tower position types
  View3dPosition,
} from './mod'

export {
  // Default mod manifests
  DEFAULT_AIRCRAFT_MOD,
  DEFAULT_TOWER_MOD,
  getModelFormat,
  isSupportedModelFormat,
  // Model format utilities
  SUPPORTED_MODEL_FORMATS,
} from './mod'

// ============================================================================
// BABYLON.JS TYPES
// ============================================================================

export type {
  // Aircraft labels
  AircraftLabel,
  // Camera synchronization
  BabylonCameraSyncOptions,
  // Memory diagnostics
  BabylonMemoryCounters,
  // Scene initialization
  BabylonOverlayOptions,
  BabylonSceneOptions,
  // Weather effects
  CloudMeshData,
  // ENU transforms
  EnuTransformData,
  UseBabylonCameraSyncResult,
  UseBabylonLabelsResult,
  UseBabylonRootNodeResult,
  // Hook return types
  UseBabylonSceneResult,
  UseBabylonWeatherResult,
  // Weather visibility
  WeatherVisibilityParams,
} from './babylon'

// ============================================================================
// REPLAY TYPES
// ============================================================================

export type {
  // Playback state
  PlaybackMode,
  PlaybackSpeed,
  // Export format
  ReplayExportData,
  // Snapshot types
  SerializedAircraftState,
  VatsimSnapshot,
} from './replay'

export {
  deserializeAircraftStates,
  // Serialization utilities
  serializeAircraftStates,
} from './replay'

// ============================================================================
// DIAGNOSTIC TYPES
// ============================================================================

export type {
  DiagnosticAppState,
  DiagnosticPackage,
  // Diagnostic package
  SerializedTimeline,
} from './diagnostic'

// ============================================================================
// EXPORT/IMPORT TYPES
// ============================================================================

export type {
  // Tree view types
  CheckState,
  SelectiveExportData,
  SettingMapping,
  TreeNodeData,
} from './exportImport'

// ============================================================================
// TERRAIN FLATTENING TYPES
// ============================================================================

export type {
  AirportFlatteningConfig,
  // Flattening polygon types
  FlatteningPolygon,
  PolygonBBox,
} from './terrain'

// ============================================================================
// AIRPORT SURFACES TYPES (X-Plane apt.dat pavement data)
// ============================================================================

export type {
  AirportSurfacesData,
  AirportSurfacesMeta,
  AptDatAirport,
  AptDatPavement,
  // Pavement data types
  SurfaceTypeCode,
} from './airportSurfaces'

export {
  // Surface type name mapping
  SURFACE_TYPE_NAMES,
} from './airportSurfaces'

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
