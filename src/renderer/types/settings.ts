/**
 * Settings-related type definitions
 *
 * This file centralizes all application settings with a grouped structure
 * for better organization and discoverability.
 *
 * Settings are organized into domain-specific groups:
 * - Cesium: Globe, terrain, lighting, time
 * - Graphics: Shadows, anti-aliasing, post-processing
 * - Camera: FOV, speeds, sensitivity
 * - Weather: Fog, clouds, visibility effects
 * - Memory: Caching, data radius
 * - Aircraft: Display modes, orientation emulation
 * - UI: Theme, panel visibility
 *
 * **NOTE:** This is the NEW grouped structure defined in Phase 1.
 * The actual settingsStore.ts will be migrated to use this in Phase 5.
 *
 * @see settingsStore - Store that will use these types (after Phase 5 migration)
 * @see SettingsModal - UI component for editing settings
 */

/**
 * Terrain quality level (1-5 scale)
 *
 * Controls Cesium terrain tile detail and load priority:
 * - 1 = Low: Faster load, less detail, lower memory usage
 * - 2 = Medium-Low
 * - 3 = High (default): Balanced quality/performance
 * - 4 = Very High: More detail, higher memory usage
 * - 5 = Ultra: Maximum detail, highest memory usage, slower load
 *
 * Higher quality loads more terrain tiles and uses higher LOD (Level of Detail).
 */
export type TerrainQuality = 1 | 2 | 3 | 4 | 5

/**
 * Shadow quality preset
 *
 * Controls shadow map resolution and filtering:
 * - 'low': 1024x1024 shadow map, hard shadows
 * - 'medium': 2048x2048 shadow map, soft shadows
 * - 'high': 2048x2048 shadow map, soft shadows, normal offset (default)
 * - 'ultra': 4096x4096 shadow map, soft shadows, normal offset, fading
 */
export type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra'

/**
 * Datablock display mode for aircraft labels
 *
 * Controls what information is shown in aircraft labels:
 * - 'full': Show callsign, altitude, speed (full ATC datablock)
 * - 'airline': Show only callsign (ICAO code)
 * - 'none': No labels displayed
 */
export type DatablockMode = 'full' | 'airline' | 'none'

/**
 * Datablock position direction (numpad-style)
 *
 * Controls where aircraft labels appear relative to the aircraft:
 * - 7=top-left, 8=top-center, 9=top-right
 * - 4=left, 6=right
 * - 1=bottom-left, 2=bottom-center, 3=bottom-right
 *
 * Note: Position 5 is excluded as it represents the center reference point.
 */
export type DatablockDirection = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9

/**
 * Time mode for sun position and lighting
 *
 * - 'real': Use real-time based on current system clock
 * - 'fixed': Use user-specified fixed time (fixedTimeHour)
 */
export type TimeMode = 'real' | 'fixed'

/**
 * UI theme
 *
 * - 'dark': Dark mode (default)
 * - 'light': Light mode
 */
export type Theme = 'light' | 'dark'

/**
 * Aircraft tint color preset for built-in (FR24) models
 *
 * Controls the tint color applied to white built-in aircraft models
 * to improve visibility against various backgrounds:
 * - 'white': Pure white (default, blends with bright backgrounds)
 * - 'lightBlue': Light blue tint (contrasts with terrain)
 * - 'tan': Tan/beige tint (contrasts with sky)
 * - 'yellow': Yellow tint (high visibility)
 * - 'orange': Orange tint (very high visibility)
 * - 'lightGray': Light gray (subtle, neutral)
 */
export type AircraftTintColor = 'white' | 'lightBlue' | 'tan' | 'yellow' | 'orange' | 'lightGray'

/**
 * 3D Building quality preset
 *
 * Controls the Level of Detail (LOD) for OSM 3D Buildings:
 * - 'low': Buildings disappear quickly when zooming out (saves memory)
 * - 'medium': Balanced quality/performance (default Cesium behavior)
 * - 'high': Buildings stay visible longer when zoomed out (uses more memory)
 *
 * Technical: Controls Cesium3DTileset.maximumScreenSpaceError
 * - low: 24 (aggressive LOD reduction)
 * - medium: 16 (default)
 * - high: 8 (keeps high detail longer)
 */
export type BuildingQuality = 'low' | 'medium' | 'high'

/**
 * Ground traffic label display mode
 *
 * Controls which ground aircraft display labels to reduce gate clutter:
 * - 'all': Show labels for all ground aircraft (default, most cluttered)
 * - 'moving': Show labels only for aircraft with groundspeed > minSpeed
 * - 'activeOnly': Show labels only for aircraft that are actively taxiing (> 5 kts)
 * - 'none': Hide all ground aircraft labels (least cluttered)
 *
 * Note: This only affects labels, not the aircraft model visibility.
 * Use 'Show Ground Traffic' toggle to hide ground aircraft entirely.
 */
export type GroundLabelMode = 'all' | 'moving' | 'activeOnly' | 'none'

/**
 * Inset viewport datablock display mode
 *
 * Controls what information is shown in aircraft labels for inset viewports:
 * - 'callsign': Show only callsign (single line, minimal clutter)
 * - 'full': Show callsign, altitude, speed (full ATC datablock)
 * - 'match': Use same mode as main viewport
 */
export type InsetDatablockMode = 'callsign' | 'full' | 'match'

/**
 * Inset viewport ground label display mode
 *
 * Controls which ground aircraft display labels in inset viewports:
 * - 'crucialPhases': Only aircraft in crucial phases (holding short, lined up, departure/landing roll)
 * - 'moving': Show labels only for aircraft with groundspeed > minSpeed
 * - 'activeOnly': Show labels only for aircraft that are actively taxiing (> 5 kts)
 * - 'all': Show labels for all ground aircraft (most cluttered)
 * - 'none': Hide all ground aircraft labels
 * - 'match': Use same mode as main viewport
 *
 * Note: 'crucialPhases' is recommended for insets to focus on operationally important aircraft.
 */
export type InsetGroundLabelMode = 'crucialPhases' | 'moving' | 'activeOnly' | 'all' | 'none' | 'match'

/**
 * Imagery provider selection
 *
 * Controls which imagery provider is used for the globe:
 * - 'cesium': Cesium Ion default (Bing Maps satellite imagery)
 * - 'google': Google Maps 2D satellite imagery (requires user API key)
 */
export type ImageryProviderType = 'cesium' | 'google'

/**
 * Color adjustments for imagery layers
 *
 * These settings apply per-provider, allowing different adjustments
 * for Cesium Ion and Google Maps imagery.
 */
export interface ImageryAdjustments {
  /**
   * Hue shift in degrees (-180 to 180, default: 0)
   * Positive values shift towards warm colors (yellow/orange),
   * negative values shift towards cool colors (blue/purple).
   */
  hueShift: number

  /**
   * Saturation multiplier (0.0 to 2.0, default: 1.0)
   * Values below 1.0 reduce color intensity (more gray),
   * values above 1.0 increase color intensity.
   */
  saturation: number

  /**
   * Brightness multiplier (0.5 to 1.5, default: 1.0)
   * Controls overall brightness of the imagery.
   */
  brightness: number

  /**
   * Contrast multiplier (0.5 to 1.5, default: 1.0)
   * Controls the contrast between light and dark areas.
   */
  contrast: number
}

/**
 * Default imagery adjustments (no modifications)
 */
export const DEFAULT_IMAGERY_ADJUSTMENTS: ImageryAdjustments = {
  hueShift: 0,
  saturation: 1.0,
  brightness: 1.0,
  contrast: 1.0
}

/**
 * Cesium-specific configuration
 *
 * Settings related to the Cesium globe, terrain, and lighting system.
 */
export interface CesiumSettings {
  /** Cesium Ion access token for terrain/imagery (user-provided, free tier available) */
  cesiumIonToken: string

  /** Terrain quality level (1-5, default: 3) */
  terrainQuality: TerrainQuality

  /** Enable globe lighting based on sun position (default: true) */
  enableLighting: boolean

  /** Show 3D building models (OSM Buildings tileset, default: false) */
  show3DBuildings: boolean

  /**
   * 3D building quality/LOD setting (default: 'low')
   *
   * Controls how long buildings stay visible when zooming out:
   * - 'low': Buildings disappear quickly (saves memory, current default)
   * - 'medium': Balanced quality/performance
   * - 'high': Buildings stay visible longer (uses more memory)
   */
  buildingQuality: BuildingQuality

  /** Time mode for sun position: real-time or fixed (default: 'real') */
  timeMode: TimeMode

  /**
   * Fixed time hour (0-24) when timeMode is 'fixed'
   * Represents local time at tower location
   * Default: 12 (noon)
   */
  fixedTimeHour: number

  /**
   * Enable terrain flattening for airport runways (default: true)
   *
   * When enabled, runway surfaces are flattened to their proper elevations,
   * eliminating terrain bumps and valleys that cause aircraft to bounce
   * unrealistically when taxiing or rolling.
   */
  enableTerrainFlattening: boolean

  /**
   * Terrain blend distance in meters (25-100, default: 50)
   *
   * Controls the transition zone between flattened runway surfaces and
   * natural terrain. Higher values create smoother transitions but may
   * flatten more of the surrounding area.
   */
  terrainBlendDistance: number
}

/**
 * MSAA (Multi-Sample Anti-Aliasing) preset for inset viewports
 *
 * - 'low': 2x MSAA (minimal quality, best performance)
 * - 'medium': 4x MSAA (balanced quality/performance)
 * - 'match': Use same MSAA level as main viewport
 */
export type InsetMsaaPreset = 'low' | 'medium' | 'match'

/**
 * Terrain detail preset for inset viewports
 *
 * Controls the screen-space error threshold for terrain tiles:
 * - 'low': SSE 16 (fastest loading, less detail)
 * - 'medium': SSE 12 (balanced)
 * - 'match': Use same terrain detail as main viewport
 */
export type InsetTerrainPreset = 'low' | 'medium' | 'match'

/**
 * Tile caching preset for inset viewports
 *
 * Controls in-memory tile cache size:
 * - 'minimal': 50 tiles (lowest memory, more reloading)
 * - 'standard': 200 tiles (balanced memory/performance)
 * - 'match': Use same cache size as main viewport
 */
export type InsetCachePreset = 'minimal' | 'standard' | 'match'

/**
 * Framerate preset for inset viewports
 *
 * Controls the maximum frame rate for inset rendering:
 * - 30, 60, 120, 144: Fixed frame rate limits
 * - 0: Unlimited (uses display refresh rate)
 * - 'match': Use same frame rate as main viewport
 */
export type InsetFrameratePreset = 30 | 60 | 120 | 144 | 0 | 'match'

/**
 * Inset viewport graphics settings
 *
 * Fine-grained control over rendering quality for inset (picture-in-picture) viewports.
 * Each setting allows trading off visual quality vs performance.
 *
 * NOTE: Each inset viewport is a separate WebGL context with its own GPU resources.
 * Enabling multiple high-quality features across multiple insets can significantly
 * impact performance on mid-range GPUs.
 */
export interface InsetGraphicsSettings {
  /**
   * Master toggle for enhanced inset rendering (default: false)
   *
   * When enabled, the individual settings below control inset quality.
   * When disabled, all insets use performance mode (all features off, 2x MSAA, minimal cache).
   *
   * TIP: Enable this first, then customize individual settings below.
   */
  enabled: boolean

  /**
   * Enable 3D buildings in insets (default: false)
   *
   * Shows OSM 3D buildings in inset viewports (requires global "Show 3D Buildings" to be enabled).
   * Performance impact: Medium (additional tile loading and rendering)
   */
  buildings: boolean

  /**
   * Enable shadows in insets (default: false)
   *
   * Renders shadows from aircraft and terrain in inset viewports.
   * Performance impact: High (shadow map generation per inset)
   */
  shadows: boolean

  /**
   * Enable aircraft silhouette outlines in insets (default: false)
   *
   * Adds edge detection outlines to built-in aircraft models for visibility.
   * Performance impact: Medium-High (full-screen post-processing shader)
   */
  silhouettes: boolean

  /**
   * MSAA quality for insets (default: 'low')
   *
   * Anti-aliasing level for inset viewports:
   * - 'low': 2x MSAA (fastest)
   * - 'medium': 4x MSAA (balanced)
   * - 'match': Same as main viewport setting
   */
  msaa: InsetMsaaPreset

  /**
   * Terrain detail level for insets (default: 'low')
   *
   * Controls terrain tile quality and loading priority:
   * - 'low': Load less detailed tiles (faster)
   * - 'medium': Balanced detail
   * - 'match': Same as main viewport setting
   */
  terrain: InsetTerrainPreset

  /**
   * Tile caching for insets (default: 'minimal')
   *
   * Controls how many terrain/imagery tiles are cached in memory:
   * - 'minimal': 50 tiles (lowest memory usage)
   * - 'standard': 200 tiles (smoother panning)
   * - 'match': Same as main viewport setting
   */
  cache: InsetCachePreset

  /**
   * Enable tile preloading for insets (default: false)
   *
   * Preloads ancestor and sibling tiles for smoother camera movement.
   * Performance impact: Low-Medium (uses more bandwidth and memory)
   */
  preloadTiles: boolean

  /**
   * Maximum frame rate for insets (default: 'match')
   *
   * Controls the rendering frame rate limit for inset viewports:
   * - 30, 60, 120, 144: Fixed frame rate limits
   * - 0: Unlimited (uses display refresh rate)
   * - 'match': Use same frame rate as main viewport setting
   */
  maxFramerate: InsetFrameratePreset
}

/**
 * Default inset graphics settings (performance mode)
 */
export const DEFAULT_INSET_GRAPHICS_SETTINGS: InsetGraphicsSettings = {
  enabled: false,
  buildings: false,
  shadows: false,
  silhouettes: false,
  msaa: 'low',
  terrain: 'low',
  cache: 'minimal',
  preloadTiles: false,
  maxFramerate: 'match'
}

/**
 * Inset viewport display settings
 *
 * Controls datablock appearance and filtering for inset (picture-in-picture) viewports.
 * These settings allow insets to have less cluttered displays than the main viewport.
 *
 * NOTE: These settings are designed to reduce visual clutter in insets while
 * maintaining situational awareness for critical aircraft phases.
 */
export interface InsetDisplaySettings {
  /**
   * Datablock display mode for insets (default: 'callsign')
   *
   * - 'callsign': Show only callsign (minimal, single-line display)
   * - 'full': Show full datablock (callsign, type, altitude, speed)
   * - 'match': Use same mode as main viewport
   */
  datablockMode: InsetDatablockMode

  /**
   * Ground label filter mode for insets (default: 'crucialPhases')
   *
   * - 'crucialPhases': Only show labels for aircraft in crucial phases:
   *   holding_short, lined_up, departure_roll, landing_roll, go_around, short_final
   * - 'moving': Show labels for moving aircraft only
   * - 'activeOnly': Show labels for actively taxiing aircraft (> 5 kts)
   * - 'all': Show all ground labels
   * - 'none': Hide all ground labels
   * - 'match': Use same mode as main viewport
   */
  groundLabelMode: InsetGroundLabelMode

  /**
   * Visibility margin for datablocks (default: 0.15)
   *
   * Fraction of viewport edge to use as margin. Aircraft screen positions
   * closer to the edge than this margin won't show datablocks.
   * Range: 0.0 (no margin, show all) to 0.3 (30% margin, very restrictive)
   *
   * This prevents datablocks from appearing for aircraft that are barely
   * visible at the edge of the inset viewport.
   */
  visibilityMargin: number
}

/**
 * Default inset display settings (reduced clutter mode)
 */
export const DEFAULT_INSET_DISPLAY_SETTINGS: InsetDisplaySettings = {
  datablockMode: 'callsign',
  groundLabelMode: 'crucialPhases',
  visibilityMargin: 0.15
}

/**
 * Graphics and rendering settings
 *
 * Settings for shadows, anti-aliasing, and post-processing effects.
 */
export interface GraphicsSettings {
  // Anti-aliasing
  /** MSAA (Multi-Sample Anti-Aliasing) samples: 1, 2, 4, or 8 (default: 4) */
  msaaSamples: 1 | 2 | 4 | 8

  /** Enable FXAA (Fast Approximate Anti-Aliasing) for smoother edges (default: true) */
  enableFxaa: boolean

  // Post-processing
  /**
   * Enable HDR (High Dynamic Range) rendering
   * Can cause color banding on some displays (default: false)
   */
  enableHdr: boolean

  /** Enable logarithmic depth buffer for better z-fighting prevention (default: true) */
  enableLogDepth: boolean

  /** Enable ground atmosphere effect (atmospheric scattering, default: true) */
  enableGroundAtmosphere: boolean

  /**
   * Enable SSAO (Screen-Space Ambient Occlusion)
   * Adds contact shadows but can cause visible banding artifacts (default: false)
   */
  enableAmbientOcclusion: boolean

  /**
   * Enable silhouette outlines for built-in (FR24) aircraft models (default: false)
   * Adds black edge outlines to white aircraft models to improve visibility
   * against bright terrain and sky backgrounds.
   * Note: Only affects built-in models; FSLTL models with liveries are not outlined.
   * Warning: Significant GPU performance impact (~20% on high-end GPUs) due to
   * full-screen post-processing shader.
   */
  enableAircraftSilhouettes: boolean

  // Shadows
  /** Enable terrain and model shadows (default: true) */
  enableShadows: boolean

  /** Shadow map resolution: 1024, 2048, 4096, or 8192 (default: 2048) */
  shadowMapSize: 1024 | 2048 | 4096 | 8192

  /** Maximum shadow rendering distance in meters (default: 10000) */
  shadowMaxDistance: number

  /** Shadow darkness: 0.0 (invisible) to 1.0 (black) (default: 0.3) */
  shadowDarkness: number

  /** Enable soft shadows vs hard shadows (PCF filtering, default: true) */
  shadowSoftness: boolean

  /** Enable shadow fading at cascade boundaries (can show banding, default: false) */
  shadowFadingEnabled: boolean

  /** Use normal offset to reduce shadow acne artifacts (default: true) */
  shadowNormalOffset: boolean

  /** Only render shadows from aircraft models, not terrain self-shadowing (default: false) */
  aircraftShadowsOnly: boolean

  // Advanced shadow bias settings (for reducing shadow banding)
  /**
   * Shadow depth bias for terrain (default: 0.0001)
   * Increase to reduce shadow banding artifacts (try 0.001 or higher)
   */
  shadowDepthBias: number

  /**
   * Shadow polygon offset factor (default: 1.1)
   * Multiplier for depth offset based on polygon slope
   */
  shadowPolygonOffsetFactor: number

  /**
   * Shadow polygon offset units (default: 4.0)
   * Constant depth offset added to shadow depth
   */
  shadowPolygonOffsetUnits: number

  /**
   * Camera near plane distance in meters (default: 0.1)
   * Higher values improve shadow/depth precision but clip nearby objects
   */
  cameraNearPlane: number

  // Model rendering
  /**
   * Brightness multiplier for built-in (FR24) models (0.5-3.0, default: 1.7)
   * Controls how bright the default aircraft models appear:
   * - 0.5 = 50% darker (darker gray tint)
   * - 1.0 = Default texture brightness
   * - 1.7 = 170% brighter (default for built-in models)
   * - 3.0 = 300% brighter (white tint, maximum brightness)
   * Values above 1.0 brighten textures; values above ~1.1 approach white
   */
  builtinModelBrightness: number

  /**
   * Tint color for built-in (FR24) models (default: 'lightBlue')
   * Controls the color tint applied to white aircraft models to improve
   * visibility against various backgrounds. Works in combination with
   * builtinModelBrightness.
   */
  builtinModelTintColor: AircraftTintColor

  /**
   * Brightness multiplier for FSLTL models (0.5-3.0, default: 1.0)
   * Controls how bright imported FSLTL aircraft models appear:
   * - 0.5 = 50% darker (darker gray tint)
   * - 1.0 = Default texture brightness (preserves livery colors)
   * - 3.0 = 300% brighter (white tint, maximum brightness)
   * Values above 1.0 brighten textures; values above ~1.1 approach white
   */
  fsltlModelBrightness: number

  // Night-time effects
  /**
   * Enable night-time imagery darkening based on sun position (default: true)
   * When enabled, satellite imagery is automatically darkened at night with
   * smooth transitions through civil, nautical, and astronomical twilight.
   */
  enableNightDarkening: boolean

  /**
   * Night darkening intensity (0.0-1.0, default: 0.7)
   * Controls how much to darken the imagery at night:
   * - 0.0 = No darkening (imagery stays bright at night)
   * - 0.5 = Moderate darkening
   * - 0.7 = Realistic darkening (default)
   * - 1.0 = Maximum darkening (very dark nights)
   */
  nightDarkeningIntensity: number

  /**
   * Aircraft night visibility boost (1.0-3.0, default: 1.5)
   * Increases aircraft model brightness at night to improve visibility
   * when imagery is darkened. Uses model light color override to boost
   * perceived lighting without washing out textures.
   * - 1.0 = No boost (aircraft darken with scene)
   * - 1.5 = Moderate boost (default, good visibility)
   * - 2.0 = Strong boost (very visible)
   * - 3.0 = Maximum boost (aircraft appear lit)
   */
  aircraftNightVisibility: number

  // Performance
  /**
   * Maximum frame rate limit (default: 60)
   * Limits the rendering frame rate to reduce GPU usage and heat.
   * Set to 0 for unlimited (uses display refresh rate).
   * Common values: 30, 60, 120, 144, 0 (unlimited)
   */
  maxFramerate: number

  /**
   * Inset viewport graphics settings
   *
   * Fine-grained control over rendering quality for inset (picture-in-picture) viewports.
   * @see InsetGraphicsSettings for individual setting descriptions
   */
  insetGraphics: InsetGraphicsSettings

}

/**
 * Camera behavior settings
 *
 * Settings for camera movement speed and input sensitivity.
 */
export interface CameraSettings {
  /** Default field of view in degrees (10-120, default: 60) */
  defaultFov: number

  /** Camera movement speed (1-10 scale, default: 5) */
  cameraSpeed: number

  /** Mouse sensitivity (0.1-2.0 scale, 1.0 = default) */
  mouseSensitivity: number

  /**
   * Virtual joystick sensitivity for touch devices (1-10 scale, default: 5)
   * Controls movement speed when using the on-screen joystick on iPad/tablets
   */
  joystickSensitivity: number

  /**
   * Enable automatic airport switching when camera moves (default: false)
   *
   * When enabled, the application automatically switches to the nearest
   * airport as the camera moves. This triggers:
   * - Airport selection change
   * - VATSIM aircraft reload for the new area
   * - Weather data update
   *
   * Uses hysteresis to prevent rapid switching when near airport boundaries.
   */
  enableAutoAirportSwitch: boolean
}

/**
 * Weather visualization settings
 *
 * Settings for METAR-based fog, clouds, and visibility effects.
 */
export interface WeatherSettings {
  /** Master toggle for all weather effects (default: true) */
  showWeatherEffects: boolean

  /** Show Cesium fog (reduces terrain draw distance, default: true) */
  showCesiumFog: boolean

  /** Show Babylon fog dome (visual fog atmosphere, default: true) */
  showBabylonFog: boolean

  /** Show cloud layer planes based on METAR (default: true) */
  showClouds: boolean

  /** Cloud plane opacity (0.3-0.8, default: 0.5) */
  cloudOpacity: number

  /**
   * Fog dome opacity multiplier (0.5-2.0, default: 1.0)
   * 0.5 = half opacity, 1.0 = default, 2.0 = double opacity
   */
  fogIntensity: number

  /**
   * Fog dome radius multiplier (0.5-2.0, default: 1.0)
   * 0.5 = half METAR visibility, 1.0 = match METAR, 2.0 = double METAR visibility
   */
  visibilityScale: number

  /** Show rain/snow particle effects based on METAR (default: true) */
  showPrecipitation: boolean

  /**
   * Precipitation particle density multiplier (0.5-2.0, default: 1.0)
   * 0.5 = half density, 1.0 = default, 2.0 = double density
   */
  precipitationIntensity: number

  /** Show lightning flashes during thunderstorms (default: true) */
  showLightning: boolean

  /**
   * Enable weather interpolation from multiple METAR stations (default: true)
   *
   * When enabled, weather values (visibility, fog, clouds, wind) are
   * interpolated from the 3 nearest METAR stations to the camera position
   * using inverse distance weighting.
   *
   * When disabled, weather uses only the current airport's METAR.
   */
  enableWeatherInterpolation: boolean
}

/**
 * Memory and caching settings
 *
 * Settings for tile caching and data radius filtering.
 */
export interface MemorySettings {
  /**
   * In-memory tile cache size (50-5000 tiles, default: 2000)
   * Higher values = smoother panning but more RAM usage
   * With trimTiles patch, effective cache is 10x this value
   */
  inMemoryTileCacheSize: number

  /**
   * IndexedDB disk cache size in GB (0.1-10, default: 2)
   * Stores terrain/imagery tiles for offline access
   */
  diskCacheSizeGB: number

  /**
   * Aircraft data radius in nautical miles (10-500, default: 100)
   * Only aircraft within this radius are kept in memory
   * Reduces memory usage at busy airports
   */
  aircraftDataRadiusNM: number

  /**
   * Maximum replay buffer duration in minutes (1-60, default: 15)
   * Controls how far back you can scrub in time
   * Each minute uses ~160KB memory (at 100 aircraft)
   */
  maxReplayDurationMinutes: number
}

/**
 * Aircraft display settings
 *
 * Settings for how aircraft are displayed and filtered.
 */
export interface AircraftSettings {
  /** Label visibility distance in nautical miles (1-100, default: 30) */
  labelVisibilityDistance: number

  /** Maximum aircraft to display simultaneously (10-1000, default: 200) */
  maxAircraftDisplay: number

  /** Show ground traffic (on taxiways/apron, default: true) */
  showGroundTraffic: boolean

  /** Show airborne traffic (in flight, default: true) */
  showAirborneTraffic: boolean

  /** Datablock display mode for aircraft labels (default: 'full') */
  datablockMode: DatablockMode

  /**
   * Enable aircraft pitch/roll orientation emulation
   * Calculates realistic pitch/roll based on turn rate and climb rate (default: true)
   */
  orientationEmulation: boolean

  /**
   * Orientation emulation intensity (0.25-1.5, default: 1.0)
   * 1.0 = realistic physics, <1.0 = reduced, >1.0 = exaggerated
   */
  orientationIntensity: number

  /**
   * Pin followed aircraft to the top of the nearby aircraft list (default: true)
   *
   * When enabled, the aircraft you're currently following will always appear
   * at the top of the list regardless of the sort order.
   */
  pinFollowedAircraftToTop: boolean

  /**
   * Automatically rearrange datablocks to avoid overlaps (default: true)
   *
   * When enabled, labels that would overlap are automatically repositioned
   * to alternative positions to prevent text from overlapping.
   *
   * When disabled, labels use their exact position (numpad position or default)
   * and may overlap each other.
   */
  autoAvoidOverlaps: boolean

  /**
   * Leader line distance (0.5-5 in 0.5 increments, default: 2)
   *
   * Controls the length of the leader lines connecting datablocks to aircraft.
   * Higher values = longer lines, more separation between label and aircraft.
   * Multiplied by 3 to get pixel gap (e.g., 2 = 6px gap).
   */
  leaderDistance: number

  /**
   * Default datablock direction (numpad-style position, default: 7)
   *
   * Sets the default position for aircraft labels for all new airports
   * and when using the "5" key to reset to default.
   *
   * Position mapping:
   * - 7=top-left, 8=top-center, 9=top-right
   * - 4=left, 6=right
   * - 1=bottom-left, 2=bottom-center, 3=bottom-right
   *
   * Press 5+Enter to reset all datablocks to this default.
   * Press 5+click to reset a specific aircraft's datablock to this default.
   */
  defaultDatablockDirection: DatablockDirection

  /**
   * Datablock font size in pixels (8-20, default: 12)
   *
   * Controls the font size of aircraft datablock labels. Larger sizes are
   * easier to read but take more screen space and may overlap more.
   */
  datablockFontSize: number
}

/**
 * UI settings
 *
 * Settings for user interface appearance and visibility.
 */
export interface UISettings {
  /** UI theme: light or dark mode (default: 'dark') */
  theme: Theme

  /** Show aircraft panel on right side of screen (default: true) */
  showAircraftPanel: boolean

  /** Show METAR overlay at top of main viewport (default: false, toggle: Ctrl+M) */
  showMetarOverlay: boolean

  /** Prompt to contribute tower positions to GitHub after saving (default: true) */
  askToContributePositions: boolean

  /**
   * Whether the device optimization prompt has been dismissed (default: false)
   *
   * When a touch device (iPad/tablet) is detected for the first time, the user
   * is prompted to apply optimized settings. This flag tracks whether the prompt
   * was dismissed so it doesn't show again.
   */
  deviceOptimizationPromptDismissed: boolean

  /**
   * Aircraft panel width in pixels (180-500, default: 280)
   *
   * The width of the nearby aircraft list panel on the right side of the screen.
   * Users can resize by dragging the left edge of the panel.
   */
  aircraftPanelWidth: number

  /**
   * Aircraft panel height in pixels (200-1200, default: 0 = auto)
   *
   * The height of the nearby aircraft list panel.
   * Users can resize by dragging the bottom edge of the panel.
   * 0 means auto height (fills available space up to max-height).
   */
  aircraftPanelHeight: number
}

/**
 * Advanced/debug settings for troubleshooting and diagnostics
 *
 * These settings are intended for power users and developers to diagnose
 * issues with aircraft interpolation and rendering.
 */
export interface AdvancedSettings {
  /**
   * Enable interpolation debug logging (default: false)
   *
   * When enabled, logs detailed interpolation information to the browser console
   * for the currently followed aircraft. Useful for diagnosing position snapping,
   * extrapolation issues, and data source timing problems.
   *
   * Log format: [Interp] HH:MM:SS.mmm CALLSIGN MODE t=X obs=N interval=Xs ...
   */
  enableInterpolationDebugLogs: boolean

  /**
   * Enable debug coordinate overlay (default: false)
   *
   * When enabled, shows a small panel with the current camera coordinates.
   * Clicking anywhere on the terrain copies the clicked coordinates to clipboard.
   * Useful for debugging terrain flattening issues and reporting exact locations.
   */
  enableDebugCoordinateOverlay: boolean
}

/**
 * Texture downscaling options for MSFS model conversion
 *
 * Controls the maximum texture resolution when converting FSLTL/AIG models:
 * - 'full': Original 4K textures (largest file size, ~40+ GB total)
 * - '2k': 2048px max dimension (high quality, ~10-15 GB)
 * - '1k': 1024px max dimension (balanced, ~3-5 GB, recommended)
 * - '512': 512px max dimension (smallest, ~1-2 GB)
 */
export type FSLTLTextureScale = 'full' | '2k' | '1k' | '512'

/**
 * MSFS model source type for priority ordering
 */
export type MSFSModelSource = 'fsltl' | 'aig'

/**
 * Cache limit constants for MSFS model conversion
 */
export const MSFS_CACHE_LIMIT = {
  /** Minimum cache size in MB (500 MB) */
  MIN_MB: 500,
  /** Maximum cache size in MB (20 GB) */
  MAX_MB: 20480,
  /** Default cache size in MB (5 GB) */
  DEFAULT_MB: 5120
} as const

/**
 * MSFS Model conversion settings
 *
 * Settings for on-the-fly conversion of FSLTL and AIG aircraft models.
 * These settings replace the old FSLTL-specific batch conversion settings.
 */
export interface MSFSModelSettings {
  /**
   * Path to MSFS Community folder on host
   * Used to auto-detect FSLTL and AIG installations
   */
  communityPath: string | null

  /**
   * Enable FSLTL model conversion and usage (default: true)
   */
  enableFsltl: boolean

  /**
   * Enable AIG model conversion and usage (default: true)
   */
  enableAig: boolean

  /**
   * Priority order for model sources (first = highest priority)
   * Models from higher-priority sources are preferred when matching
   * Default: ['fsltl', 'aig']
   */
  priority: MSFSModelSource[]

  /**
   * Paths to user-selected VMR files for custom model matching rules
   * These VMRs are parsed and used for model matching (not copied)
   */
  vmrFiles: string[]

  /**
   * Optional directory for caching converted GLB models
   * null = cache in app's temp directory (cleared on app close)
   * When set, converted models persist across app restarts
   */
  cacheDirectory: string | null

  /**
   * Cache size limit in MB (null = unlimited)
   * Range: 500-20480 (500MB to 20GB)
   * Default: 5120 (5GB)
   * When limit is reached, least-recently-used models are evicted
   */
  cacheLimitMB: number | null

  /**
   * Texture downscaling preference for conversion
   * Lower values = smaller files but less detail
   * Default: '1k' (balanced quality/size)
   */
  textureScale: FSLTLTextureScale

  /**
   * Skip VMR rules that only map to generic/base livery models (default: false)
   *
   * When enabled, VMR rules that map to models with "_ZZZZ" in the name
   * (indicating a generic/base livery) are ignored. This allows the system
   * to fall through to dimension-based matching, which can find an actual
   * airline-liveried aircraft and scale it appropriately.
   *
   * Example: AFR+B738 with this disabled → FSLTL_B738_ZZZZ (generic white 737)
   *          AFR+B738 with this enabled → FSLTL_A319_AFR scaled (actual Air France livery)
   *
   * Useful when you prefer seeing the actual airline livery (even scaled)
   * over a perfectly-sized generic white aircraft.
   */
  skipGenericVmrMatches: boolean
}

/**
 * Default MSFS model settings
 */
export const DEFAULT_MSFS_MODEL_SETTINGS: MSFSModelSettings = {
  communityPath: null,
  enableFsltl: true,
  enableAig: true,
  priority: ['fsltl', 'aig'],
  vmrFiles: [],
  cacheDirectory: null,
  cacheLimitMB: MSFS_CACHE_LIMIT.DEFAULT_MB,
  textureScale: '1k',
  skipGenericVmrMatches: false
}

// ============================================================================
// Global Settings (stored on host file system, shared across all browsers)
// ============================================================================

// ============================================================================
// Global Viewport Settings (shared across all browsers)
// ============================================================================

/**
 * View-mode-specific camera defaults (what the user saved)
 */
export interface GlobalViewModeDefaults {
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude?: number  // Only for 2D
}

/**
 * Camera bookmark (saved camera position)
 */
export interface GlobalCameraBookmark {
  name?: string
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  viewMode: '3d' | 'topdown'
  topdownAltitude?: number
}

/**
 * Datablock position (1-9 numpad style)
 * 7=top-left, 8=top, 9=top-right
 * 4=left, 6=right
 * 1=bottom-left, 2=bottom, 3=bottom-right
 */
export type GlobalDatablockPosition = 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9

/**
 * Inset viewport layout stored globally
 */
export interface GlobalInsetLayout {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

/**
 * Inset viewport camera state stored globally
 * Subset of ViewportCameraState - only the fields we need to restore
 */
export interface GlobalInsetCameraState {
  viewMode: '3d' | 'topdown'
  heading: number
  pitch: number
  fov: number
  positionOffsetX: number
  positionOffsetY: number
  positionOffsetZ: number
  topdownAltitude: number
  followMode: 'tower' | 'orbit'
  followZoom: number
  orbitDistance: number
  orbitHeading: number
  orbitPitch: number
}

/**
 * Inset viewport configuration stored globally
 */
export interface GlobalInsetViewport {
  id: string
  label?: string
  layout: GlobalInsetLayout
  cameraState: GlobalInsetCameraState
}

/**
 * Per-airport viewport configuration stored globally
 * Contains camera defaults and bookmarks shared across all devices
 */
export interface GlobalAirportViewportConfig {
  /** Main viewport camera state */
  mainCamera?: GlobalInsetCameraState
  /** Camera defaults for 3D view mode */
  default3d?: GlobalViewModeDefaults
  /** Camera defaults for 2D/top-down view mode */
  default2d?: GlobalViewModeDefaults
  /** Camera bookmarks (0-99) */
  bookmarks?: Record<number, GlobalCameraBookmark>
  /** Global datablock position for this airport */
  datablockPosition?: GlobalDatablockPosition
  /** Inset viewport configurations (excluding main viewport) */
  insets?: GlobalInsetViewport[]
}

/**
 * Global orbit camera settings (persist across all airports)
 */
export interface GlobalOrbitSettings {
  distance: number
  heading: number
  pitch: number
}

/**
 * All global viewport settings
 */
export interface GlobalViewportSettings {
  /** Per-airport viewport configurations */
  airportConfigs: Record<string, GlobalAirportViewportConfig>
  /** Last used orbit settings (shared across airports) */
  orbitSettings: GlobalOrbitSettings
  /** Last visited airport ICAO */
  lastAirportIcao: string | null
}

/**
 * Default global viewport settings
 */
export const DEFAULT_GLOBAL_VIEWPORT_SETTINGS: GlobalViewportSettings = {
  airportConfigs: {},
  orbitSettings: {
    distance: 500,
    heading: 0,
    pitch: -30
  },
  lastAirportIcao: null
}

/**
 * Display settings that are shared across all devices
 *
 * These settings control how aircraft datablocks and labels appear,
 * and are synced across all connected browsers/devices for a consistent
 * controller experience.
 */
export interface GlobalDisplaySettings {
  /**
   * Leader line distance (0.5-5 in 0.5 increments, default: 2)
   * Same across all devices for consistent datablock appearance.
   * Multiplied by 3 to get pixel gap.
   */
  leaderDistance: number

  /**
   * Default datablock direction (numpad-style position, default: 7)
   * Same across all devices for consistent layout.
   */
  defaultDatablockDirection: DatablockDirection

  /**
   * Datablock display mode ('full', 'airline', 'none')
   * Same across all devices so all controllers see the same info.
   */
  datablockMode: DatablockMode

  /**
   * Label visibility distance in nautical miles (1-100, default: 30)
   * Same across all devices so all controllers see the same aircraft.
   */
  labelVisibilityDistance: number

  /**
   * Show ground traffic (default: true)
   * Same across all devices for consistent filtering.
   */
  showGroundTraffic: boolean

  /**
   * Show airborne traffic (default: true)
   * Same across all devices for consistent filtering.
   */
  showAirborneTraffic: boolean

  /**
   * Auto-avoid datablock overlaps (default: true)
   * Same across all devices for consistent layout behavior.
   */
  autoAvoidOverlaps: boolean

  /**
   * Ground traffic label display mode (default: 'all')
   *
   * Controls which ground aircraft show labels to reduce gate clutter:
   * - 'all': Show labels for all ground aircraft (most cluttered)
   * - 'moving': Show labels only for aircraft above minimum speed
   * - 'activeOnly': Show labels only for actively taxiing aircraft (> 5 kts)
   * - 'none': Hide all ground traffic labels (least cluttered)
   *
   * Note: This only affects labels, not aircraft model visibility.
   */
  groundLabelMode: GroundLabelMode

  /**
   * Minimum groundspeed (kts) for ground labels when mode is 'moving' (default: 2)
   *
   * Aircraft below this speed are considered "parked" and won't show labels
   * when groundLabelMode is 'moving'. Range: 1-10 kts.
   */
  groundLabelMinSpeed: number

  /**
   * Inset viewport display settings
   *
   * Controls how datablocks appear in inset (picture-in-picture) viewports.
   * Insets default to reduced clutter settings for better visibility.
   */
  inset: InsetDisplaySettings
}

/**
 * Default global display settings
 */
export const DEFAULT_GLOBAL_DISPLAY_SETTINGS: GlobalDisplaySettings = {
  leaderDistance: 2,
  defaultDatablockDirection: 7,
  datablockMode: 'full',
  labelVisibilityDistance: 30,
  showGroundTraffic: true,
  showAirborneTraffic: true,
  autoAvoidOverlaps: true,
  groundLabelMode: 'all',
  groundLabelMinSpeed: 2,
  inset: DEFAULT_INSET_DISPLAY_SETTINGS
}

/**
 * Type for updating display settings with support for partial inset updates.
 * Used by updateDisplay() to allow individual inset property changes without
 * requiring the full InsetDisplaySettings object.
 */
export type GlobalDisplaySettingsUpdate = Omit<Partial<GlobalDisplaySettings>, 'inset'> & {
  inset?: Partial<InsetDisplaySettings>
}

/**
 * Global settings stored on the host file system
 *
 * These settings are persisted to a JSON file on the host PC and are
 * shared across all browsers/devices that connect to the app. This enables
 * remote browser access (e.g., iPad) to use the same Cesium token and
 * FSLTL configuration as the host.
 *
 * Unlike local settings (stored in browser localStorage), global settings:
 * - Are available immediately when connecting from any browser
 * - Don't require re-entering Cesium token on new devices
 * - Reference file paths that only make sense on the host PC
 *
 * @see globalSettingsStore - Store that manages these settings
 * @see settingsStore - Local settings that complement global settings
 */
export interface GlobalSettings {
  /**
   * Cesium Ion access token for terrain/imagery
   * User-provided, free tier available at https://cesium.com/ion/
   */
  cesiumIonToken: string

  /**
   * Imagery provider configuration
   * Controls which satellite imagery is displayed on the globe
   */
  imagery: {
    /**
     * Selected imagery provider (default: 'cesium')
     * - 'cesium': Cesium Ion default (Bing Maps satellite)
     * - 'google': Google Maps 2D satellite imagery
     */
    provider: ImageryProviderType

    /**
     * Google Maps API key (required when provider is 'google')
     * Get a key at https://console.cloud.google.com/apis/credentials
     */
    googleMapsApiKey: string

    /**
     * Color adjustments for Cesium Ion (Bing Maps) imagery
     */
    cesiumAdjustments: ImageryAdjustments

    /**
     * Color adjustments for Google Maps imagery
     */
    googleAdjustments: ImageryAdjustments
  }

  /**
   * MSFS model configuration (on-the-fly conversion)
   * Replaces the old fsltl settings with support for FSLTL + AIG
   */
  msfsModels: MSFSModelSettings

  /**
   * @deprecated Use msfsModels instead. Kept for migration compatibility.
   * FSLTL model configuration (old pre-conversion system)
   * Paths reference the host file system
   */
  fsltl: {
    /**
     * Path to fsltl-traffic-base package folder on host
     * Typically in MSFS Community folder
     */
    sourcePath: string | null

    /**
     * Custom output path for converted models on host
     * null = use app's mods folder
     */
    outputPath: string | null

    /**
     * Texture downscaling preference for conversion
     */
    textureScale: FSLTLTextureScale

    /**
     * Enable use of converted FSLTL models
     */
    enableFsltlModels: boolean
  }

  /**
   * Default airport configuration
   */
  airports: {
    /**
     * Default airport ICAO code to load on startup
     * Empty string = no default (user selects)
     */
    defaultIcao: string

    /**
     * Recently visited airports (ICAO codes)
     * Shared across all browser sessions
     */
    recentAirports: string[]

    /**
     * Favorite airports for VATSIM/vNAS mode (ICAO codes)
     * Shared across all browser sessions
     */
    vatsimFavorites: string[]

    /**
     * Favorite airports for RealTraffic mode (ICAO codes)
     * Shared across all browser sessions
     */
    realtrafficFavorites: string[]
  }

  /**
   * Remote access server configuration
   */
  server: {
    /**
     * HTTP server port for remote access (default: 8765)
     */
    port: number

    /**
     * Enable remote access server on startup (default: false)
     */
    enabled: boolean

    /**
     * Optional authentication token for API access
     * When set, remote clients must include this token as Bearer token in Authorization header
     */
    authToken?: string

    /**
     * If true, only allow connections from local network (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
     */
    requireLocalNetwork: boolean
  }

  /**
   * RealTraffic data source settings
   * Shared across all browsers/devices so all sessions use same data source
   */
  realtraffic: {
    /**
     * Selected data source for aircraft traffic (default: 'vatsim')
     */
    dataSource: DataSourceType

    /**
     * License key for RealTraffic API
     */
    licenseKey: string

    /**
     * Query radius in nautical miles (10-200, default: 100)
     */
    radiusNm: number

    /**
     * Maximum parked aircraft to fetch (0-200, default: 50)
     *
     * Set to 0 to disable parked aircraft entirely.
     * Parked aircraft are culled first if total exceeds maxAircraftDisplay.
     */
    maxParkedAircraft: number
  }

  /**
   * Viewport settings (camera positions, bookmarks, orbit settings)
   * Shared across all browsers/devices
   */
  viewports: GlobalViewportSettings

  /**
   * Display settings (datablocks, labels, filtering)
   * Shared across all browsers/devices for consistent appearance
   */
  display: GlobalDisplaySettings

  /**
   * vNAS authentication tokens (opaque to frontend, managed by Rust)
   * Stored as JSON string for feature-flag compatibility with the vnas crate
   */
  vnasTokens?: string
}

/**
 * Default global settings values
 */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  cesiumIonToken: '',
  imagery: {
    provider: 'cesium',
    googleMapsApiKey: '',
    cesiumAdjustments: DEFAULT_IMAGERY_ADJUSTMENTS,
    googleAdjustments: DEFAULT_IMAGERY_ADJUSTMENTS
  },
  msfsModels: DEFAULT_MSFS_MODEL_SETTINGS,
  // @deprecated - kept for migration only
  fsltl: {
    sourcePath: null,
    outputPath: null,
    textureScale: '1k',
    enableFsltlModels: true
  },
  airports: {
    defaultIcao: '',
    recentAirports: [],
    vatsimFavorites: [],
    realtrafficFavorites: []
  },
  server: {
    port: 8765,
    enabled: false,
    authToken: undefined,
    requireLocalNetwork: false
  },
  realtraffic: {
    dataSource: 'vatsim',
    licenseKey: '',
    radiusNm: 100,
    maxParkedAircraft: 50
  },
  viewports: DEFAULT_GLOBAL_VIEWPORT_SETTINGS,
  display: DEFAULT_GLOBAL_DISPLAY_SETTINGS
}

/**
 * Data source selection for aircraft traffic
 *
 * Controls which source provides aircraft position data:
 * - 'vatsim': VATSIM network (virtual ATC, 15s updates)
 * - 'realtraffic': RealTraffic API (real-world ADS-B, ~3s updates)
 */
export type DataSourceType = 'vatsim' | 'realtraffic'

/**
 * RealTraffic settings
 *
 * Settings for the RealTraffic (RTAPI) integration, providing real-world ADS-B
 * aircraft data as an alternative to VATSIM network data.
 *
 * @see RealTrafficService - Service that handles API communication
 * @see realTrafficStore - Store that manages RealTraffic data
 */
export interface RealTrafficSettings {
  /**
   * Selected data source for aircraft traffic (default: 'vatsim')
   *
   * Controls whether aircraft data comes from VATSIM (virtual traffic)
   * or RealTraffic (real-world ADS-B data).
   */
  dataSource: DataSourceType

  /**
   * License key for RealTraffic API
   *
   * User can enter manually, or auto-detected from RealTraffic.lic file.
   * Empty string means no license configured.
   */
  licenseKey: string

  /**
   * Attempt to auto-detect license from RealTraffic.lic file (default: true)
   *
   * File location: %APPDATA%/InsideSystems/RealTraffic.lic (Windows)
   * Only works in Tauri desktop mode (not remote browser).
   */
  autoDetectLicense: boolean

  /**
   * Query radius in nautical miles (10-200, default: 100)
   *
   * Aircraft within this radius of the reference position will be fetched.
   * Larger radius = more aircraft but higher data usage.
   */
  radiusNm: number
}

/**
 * FSLTL (FS Live Traffic Liveries) settings
 *
 * Settings for importing and managing FSLTL aircraft models with airline liveries.
 * FSLTL provides high-quality aircraft models with real-world airline liveries
 * that can be converted for use in TowerCab 3D.
 */
export interface FSLTLSettings {
  /**
   * Path to fsltl-traffic-base package folder
   * User must select this folder containing the FSLTL package
   * (typically in MSFS Community folder)
   */
  sourcePath: string | null

  /**
   * Custom output path for converted models
   * null = use app's mods folder (recommended)
   * Custom path useful when app is in Program Files without write permission
   */
  outputPath: string | null

  /**
   * Texture downscaling preference for conversion
   * Lower values = smaller files but less detail
   * Default: '1k' (balanced quality/size)
   */
  textureScale: FSLTLTextureScale

  /**
   * Enable use of converted FSLTL models (default: true)
   *
   * When enabled, the app uses converted FSLTL models with airline liveries
   * when available. When disabled, falls back to built-in (FR24) models only.
   *
   * Useful for testing or comparing model appearance without having to
   * remove or rename the converted model files.
   */
  enableFsltlModels: boolean
}

/**
 * Main settings store interface (NEW grouped structure)
 *
 * This is the target structure for Phase 5 migration.
 * Currently, settingsStore.ts still uses the old flat structure.
 *
 * Migration plan (Phase 5):
 * 1. Refactor settingsStore.ts to use this grouped structure
 * 2. Add migration logic to convert old flat localStorage to grouped
 * 3. Update all consumers (~15 files) to access nested properties
 * 4. Update SettingsModal to use grouped update functions
 *
 * @example
 * // OLD (current flat structure):
 * const quality = useSettingsStore().terrainQuality
 * const enableShadows = useSettingsStore().enableShadows
 *
 * // NEW (Phase 5 grouped structure):
 * const quality = useSettingsStore().cesium.terrainQuality
 * const enableShadows = useSettingsStore().graphics.enableShadows
 *
 * @see settingsStore - Will be refactored to use this structure in Phase 5
 */
export interface SettingsStore {
  /** Cesium globe, terrain, and lighting settings */
  cesium: CesiumSettings

  /** Graphics rendering and post-processing settings */
  graphics: GraphicsSettings

  /** Camera behavior settings */
  camera: CameraSettings

  /** Weather visualization settings */
  weather: WeatherSettings

  /** Memory management and caching settings */
  memory: MemorySettings

  /** Aircraft display and filtering settings */
  aircraft: AircraftSettings

  /** UI appearance settings */
  ui: UISettings

  /** FSLTL aircraft model settings */
  fsltl: FSLTLSettings

  /** RealTraffic data source settings */
  realtraffic: RealTrafficSettings

  /** Advanced/debug settings */
  advanced: AdvancedSettings

  // Actions (will be added in Phase 5)
  /** Update Cesium settings (partial update) */
  updateCesiumSettings: (updates: Partial<CesiumSettings>) => void

  /** Update graphics settings (partial update) */
  updateGraphicsSettings: (updates: Partial<GraphicsSettings>) => void

  /** Update camera settings (partial update) */
  updateCameraSettings: (updates: Partial<CameraSettings>) => void

  /** Update weather settings (partial update) */
  updateWeatherSettings: (updates: Partial<WeatherSettings>) => void

  /** Update memory settings (partial update) */
  updateMemorySettings: (updates: Partial<MemorySettings>) => void

  /** Update aircraft settings (partial update) */
  updateAircraftSettings: (updates: Partial<AircraftSettings>) => void

  /** Update UI settings (partial update) */
  updateUISettings: (updates: Partial<UISettings>) => void

  /** Update FSLTL settings (partial update) */
  updateFSLTLSettings: (updates: Partial<FSLTLSettings>) => void

  /** Update RealTraffic settings (partial update) */
  updateRealTrafficSettings: (updates: Partial<RealTrafficSettings>) => void

  /** Update advanced/debug settings (partial update) */
  updateAdvancedSettings: (updates: Partial<AdvancedSettings>) => void

  /** Reset all settings to defaults */
  resetToDefaults: () => void

  /** Export settings as JSON string */
  exportSettings: () => string

  /** Import settings from JSON string, returns true if successful */
  importSettings: (json: string) => boolean
}

/**
 * Default settings values
 *
 * Used for initialization and reset-to-defaults functionality.
 * Will be referenced by settingsStore in Phase 5.
 */
export const DEFAULT_SETTINGS: Omit<SettingsStore, keyof {
  updateCesiumSettings: unknown
  updateGraphicsSettings: unknown
  updateCameraSettings: unknown
  updateWeatherSettings: unknown
  updateMemorySettings: unknown
  updateAircraftSettings: unknown
  updateUISettings: unknown
  updateFSLTLSettings: unknown
  updateRealTrafficSettings: unknown
  updateAdvancedSettings: unknown
  resetToDefaults: unknown
  exportSettings: unknown
  importSettings: unknown
}> = {
  cesium: {
    cesiumIonToken: '',
    terrainQuality: 3,
    enableLighting: true,
    show3DBuildings: false,
    buildingQuality: 'low',
    timeMode: 'real',
    fixedTimeHour: 12,
    enableTerrainFlattening: true,
    terrainBlendDistance: 50
  },
  graphics: {
    msaaSamples: 4,
    enableFxaa: true,
    enableHdr: false,
    enableLogDepth: true,
    enableGroundAtmosphere: true,
    enableAmbientOcclusion: false,
    enableAircraftSilhouettes: false,
    enableShadows: true,
    shadowMapSize: 2048,
    shadowMaxDistance: 10000,
    shadowDarkness: 0.3,
    shadowSoftness: true,
    shadowFadingEnabled: false,
    shadowNormalOffset: true,
    aircraftShadowsOnly: true,
    shadowDepthBias: 0.0004,
    shadowPolygonOffsetFactor: 1.1,
    shadowPolygonOffsetUnits: 4.0,
    cameraNearPlane: 0.1,
    builtinModelBrightness: 1.7,
    builtinModelTintColor: 'lightBlue',
    fsltlModelBrightness: 1.0,
    enableNightDarkening: false,
    nightDarkeningIntensity: 0.7,
    aircraftNightVisibility: 1.5,
    maxFramerate: 60,
    insetGraphics: DEFAULT_INSET_GRAPHICS_SETTINGS
  },
  camera: {
    defaultFov: 60,
    cameraSpeed: 5,
    mouseSensitivity: 1.0,
    joystickSensitivity: 5,
    enableAutoAirportSwitch: false
  },
  weather: {
    showWeatherEffects: true,
    showCesiumFog: true,
    showBabylonFog: true,
    showClouds: true,
    cloudOpacity: 0.5,
    fogIntensity: 1.0,
    visibilityScale: 1.0,
    showPrecipitation: true,
    precipitationIntensity: 1.0,
    showLightning: true,
    enableWeatherInterpolation: true
  },
  memory: {
    inMemoryTileCacheSize: 2000,
    diskCacheSizeGB: 2,
    aircraftDataRadiusNM: 100,
    maxReplayDurationMinutes: 15
  },
  aircraft: {
    labelVisibilityDistance: 30,
    maxAircraftDisplay: 200,
    showGroundTraffic: true,
    showAirborneTraffic: true,
    datablockMode: 'full',
    orientationEmulation: true,
    orientationIntensity: 1.0,
    pinFollowedAircraftToTop: true,
    autoAvoidOverlaps: true,
    leaderDistance: 2,
    defaultDatablockDirection: 7,
    datablockFontSize: 12
  },
  ui: {
    theme: 'dark',
    showAircraftPanel: true,
    showMetarOverlay: false,
    askToContributePositions: true,
    deviceOptimizationPromptDismissed: false,
    aircraftPanelWidth: 280,
    aircraftPanelHeight: 0
  },
  fsltl: {
    sourcePath: null,
    outputPath: null,
    textureScale: '1k',
    enableFsltlModels: true
  },
  realtraffic: {
    dataSource: 'vatsim',
    licenseKey: '',
    autoDetectLicense: true,
    radiusNm: 100
  },
  advanced: {
    enableInterpolationDebugLogs: false,
    enableDebugCoordinateOverlay: false
  }
}
