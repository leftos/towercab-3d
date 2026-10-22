//! Global settings management.
//!
//! This module handles:
//! - GlobalSettings types and defaults
//! - Reading/writing settings to disk
//! - Settings shared across all browsers/devices

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::normalize_path_string;

// =============================================================================
// FSLTL SETTINGS
// =============================================================================

/// FSLTL configuration within global settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalFsltlSettings {
    pub source_path: Option<String>,
    pub output_path: Option<String>,
    pub texture_scale: String,
    pub enable_fsltl_models: bool,
}

// =============================================================================
// AIRPORT SETTINGS
// =============================================================================

/// Airport configuration within global settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalAirportSettings {
    pub default_icao: String,
    #[serde(default)]
    pub recent_airports: Vec<String>,
    #[serde(default)]
    pub vatsim_favorites: Vec<String>,
    #[serde(default)]
    pub realtraffic_favorites: Vec<String>,
}

// =============================================================================
// SERVER SETTINGS
// =============================================================================

/// Server configuration within global settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalServerSettings {
    pub port: u16,
    pub enabled: bool,
    /// If true, clients outside the local network may connect; by default only loopback,
    /// private and link-local addresses (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
    /// ::1, fe80::/10, fc00::/7) are served
    #[serde(default)]
    pub allow_non_local_clients: bool,
    /// If true, minimize to system tray instead of quitting when the window is closed
    /// while the HTTP server is running (default: true)
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
}

// =============================================================================
// REALTRAFFIC SETTINGS
// =============================================================================

fn default_data_source() -> String {
    "vatsim".to_string()
}

fn default_radius_nm() -> u32 {
    100
}

fn default_max_parked_aircraft() -> u32 {
    50
}

/// RealTraffic data source settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalRealTrafficSettings {
    /// Data source: "vatsim" or "realtraffic"
    #[serde(default = "default_data_source")]
    pub data_source: String,
    /// RealTraffic license key
    #[serde(default)]
    pub license_key: String,
    /// Query radius in nautical miles
    #[serde(default = "default_radius_nm")]
    pub radius_nm: u32,
    /// Maximum parked aircraft to fetch (0-200, default: 50)
    #[serde(default = "default_max_parked_aircraft")]
    pub max_parked_aircraft: u32,
}

impl Default for GlobalRealTrafficSettings {
    fn default() -> Self {
        GlobalRealTrafficSettings {
            data_source: "vatsim".to_string(),
            license_key: String::new(),
            radius_nm: 100,
            max_parked_aircraft: 50,
        }
    }
}

// =============================================================================
// IMAGERY SETTINGS
// =============================================================================

fn default_imagery_provider() -> String {
    "cesium".to_string()
}

fn default_saturation() -> f64 {
    1.0
}

fn default_brightness() -> f64 {
    1.0
}

fn default_contrast() -> f64 {
    1.0
}

/// Per-provider color adjustment settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageryAdjustments {
    /// Hue shift in degrees (-180 to 180)
    #[serde(default)]
    pub hue_shift: f64,
    /// Saturation multiplier (0.0 to 2.0)
    #[serde(default = "default_saturation")]
    pub saturation: f64,
    /// Brightness multiplier (0.5 to 1.5)
    #[serde(default = "default_brightness")]
    pub brightness: f64,
    /// Contrast multiplier (0.5 to 1.5)
    #[serde(default = "default_contrast")]
    pub contrast: f64,
}

impl Default for ImageryAdjustments {
    fn default() -> Self {
        ImageryAdjustments {
            hue_shift: 0.0,
            saturation: 1.0,
            brightness: 1.0,
            contrast: 1.0,
        }
    }
}

/// Imagery provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalImagerySettings {
    /// Selected imagery provider: "cesium" or "google"
    #[serde(default = "default_imagery_provider")]
    pub provider: String,
    /// Google Maps API key (required when provider is "google")
    #[serde(default)]
    pub google_maps_api_key: String,
    /// Color adjustments for Cesium Ion (Bing Maps) imagery
    #[serde(default)]
    pub cesium_adjustments: ImageryAdjustments,
    /// Color adjustments for Google Maps imagery
    #[serde(default)]
    pub google_adjustments: ImageryAdjustments,
}

impl Default for GlobalImagerySettings {
    fn default() -> Self {
        GlobalImagerySettings {
            provider: "cesium".to_string(),
            google_maps_api_key: String::new(),
            cesium_adjustments: ImageryAdjustments::default(),
            google_adjustments: ImageryAdjustments::default(),
        }
    }
}

// =============================================================================
// VIEWPORT SETTINGS (per-airport camera positions, bookmarks)
// =============================================================================

/// View mode defaults (camera position for 3D or 2D mode)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalViewModeDefaults {
    pub heading: f64,
    pub pitch: f64,
    pub fov: f64,
    pub position_offset_x: f64,
    pub position_offset_y: f64,
    pub position_offset_z: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topdown_altitude: Option<f64>,
}

/// Camera bookmark (saved camera position with optional name)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCameraBookmark {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub heading: f64,
    pub pitch: f64,
    pub fov: f64,
    pub position_offset_x: f64,
    pub position_offset_y: f64,
    pub position_offset_z: f64,
    pub view_mode: String, // "3d" or "topdown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topdown_altitude: Option<f64>,
}

/// Inset viewport layout
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInsetLayout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i32,
}

/// Inset viewport camera state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInsetCameraState {
    pub view_mode: String, // "3d" or "topdown"
    pub heading: f64,
    pub pitch: f64,
    pub fov: f64,
    pub position_offset_x: f64,
    pub position_offset_y: f64,
    pub position_offset_z: f64,
    pub topdown_altitude: f64,
    pub follow_mode: String, // "tower" or "orbit"
    pub follow_zoom: f64,
    pub orbit_distance: f64,
    pub orbit_heading: f64,
    pub orbit_pitch: f64,
}

/// Inset viewport configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalInsetViewport {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub layout: GlobalInsetLayout,
    pub camera_state: GlobalInsetCameraState,
}

/// Per-airport viewport configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalAirportViewportConfig {
    /// Main viewport camera state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_camera: Option<GlobalInsetCameraState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_3d: Option<GlobalViewModeDefaults>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_2d: Option<GlobalViewModeDefaults>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub bookmarks: std::collections::HashMap<String, GlobalCameraBookmark>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub datablock_position: Option<u8>, // 1-9 numpad position
    /// Inset viewport configurations (geometry and camera state)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub insets: Vec<GlobalInsetViewport>,
}

/// Global orbit camera settings (persisted across airports)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalOrbitSettings {
    pub distance: f64,
    pub heading: f64,
    pub pitch: f64,
}

impl Default for GlobalOrbitSettings {
    fn default() -> Self {
        GlobalOrbitSettings {
            distance: 500.0, // ORBIT_DISTANCE_DEFAULT
            heading: 0.0,    // ORBIT_HEADING_DEFAULT
            pitch: 20.0,     // ORBIT_PITCH_DEFAULT
        }
    }
}

/// Viewport settings (camera positions, bookmarks per airport)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct GlobalViewportSettings {
    #[serde(default)]
    pub airport_configs: std::collections::HashMap<String, GlobalAirportViewportConfig>,
    #[serde(default)]
    pub orbit_settings: GlobalOrbitSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_airport_icao: Option<String>,
}

// =============================================================================
// DISPLAY SETTINGS
// =============================================================================

fn default_leader_distance() -> u8 {
    2
}
fn default_datablock_direction() -> u8 {
    7
}
fn default_datablock_mode() -> String {
    "full".to_string()
}
fn default_label_visibility_distance() -> f64 {
    30.0
}
fn default_true() -> bool {
    true
}
fn default_ground_label_mode() -> String {
    "all".to_string()
}
fn default_ground_label_min_speed() -> f64 {
    2.0
}

/// Inset viewport display settings
/// These control datablock appearance for inset (picture-in-picture) viewports
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsetDisplaySettings {
    /// Datablock mode for insets: "callsign", "full", or "match" (default: "callsign")
    #[serde(default = "default_inset_datablock_mode")]
    pub datablock_mode: String,
    /// Ground label mode for insets: "crucialPhases", "moving", "activeOnly", "all", "none", "match" (default: "crucialPhases")
    #[serde(default = "default_inset_ground_label_mode")]
    pub ground_label_mode: String,
    /// Visibility margin (0.0-0.3, default: 0.15)
    #[serde(default = "default_inset_visibility_margin")]
    pub visibility_margin: f64,
}

fn default_inset_datablock_mode() -> String {
    "callsign".to_string()
}

fn default_inset_ground_label_mode() -> String {
    "crucialPhases".to_string()
}

fn default_inset_visibility_margin() -> f64 {
    0.15
}

impl Default for InsetDisplaySettings {
    fn default() -> Self {
        InsetDisplaySettings {
            datablock_mode: "callsign".to_string(),
            ground_label_mode: "crucialPhases".to_string(),
            visibility_margin: 0.15,
        }
    }
}

/// Display settings shared across all browsers for consistent appearance
/// These control datablock labels, leader lines, and filtering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDisplaySettings {
    /// Leader line distance (1-5, default: 2)
    #[serde(default = "default_leader_distance")]
    pub leader_distance: u8,
    /// Default datablock direction (numpad-style position 1-9, default: 7)
    #[serde(default = "default_datablock_direction")]
    pub default_datablock_direction: u8,
    /// Datablock mode: "full", "airline", or "none"
    #[serde(default = "default_datablock_mode")]
    pub datablock_mode: String,
    /// Label visibility distance in nautical miles (1-100, default: 30)
    #[serde(default = "default_label_visibility_distance")]
    pub label_visibility_distance: f64,
    /// Show ground traffic (default: true)
    #[serde(default = "default_true")]
    pub show_ground_traffic: bool,
    /// Show airborne traffic (default: true)
    #[serde(default = "default_true")]
    pub show_airborne_traffic: bool,
    /// Auto-avoid datablock overlaps (default: true)
    #[serde(default = "default_true")]
    pub auto_avoid_overlaps: bool,
    /// Ground traffic label mode: "all", "moving", "activeOnly", "none" (default: "all")
    #[serde(default = "default_ground_label_mode")]
    pub ground_label_mode: String,
    /// Minimum groundspeed (kts) for ground labels when mode is "moving" (default: 2)
    #[serde(default = "default_ground_label_min_speed")]
    pub ground_label_min_speed: f64,
    /// Inset viewport display settings
    #[serde(default)]
    pub inset: InsetDisplaySettings,
}

impl Default for GlobalDisplaySettings {
    fn default() -> Self {
        GlobalDisplaySettings {
            leader_distance: 2,
            default_datablock_direction: 7,
            datablock_mode: "full".to_string(),
            label_visibility_distance: 30.0,
            show_ground_traffic: true,
            show_airborne_traffic: true,
            auto_avoid_overlaps: true,
            ground_label_mode: "all".to_string(),
            ground_label_min_speed: 2.0,
            inset: InsetDisplaySettings::default(),
        }
    }
}

// =============================================================================
// MSFS MODEL SETTINGS
// =============================================================================

fn default_msfs_priority() -> Vec<String> {
    vec!["fsltl".to_string(), "aig".to_string()]
}

fn default_cache_limit() -> Option<u32> {
    Some(5120) // 5GB default
}

fn default_texture_scale() -> String {
    "1k".to_string()
}

/// MSFS model conversion settings (on-the-fly model conversion)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsfsModelSettings {
    /// Path to MSFS Community folder
    #[serde(default)]
    pub community_path: Option<String>,
    /// Enable FSLTL model conversion
    #[serde(default = "default_true")]
    pub enable_fsltl: bool,
    /// Enable AIG model conversion
    #[serde(default = "default_true")]
    pub enable_aig: bool,
    /// Priority order for model sources
    #[serde(default = "default_msfs_priority")]
    pub priority: Vec<String>,
    /// Paths to user-selected VMR files
    #[serde(default)]
    pub vmr_files: Vec<String>,
    /// Optional directory for caching converted GLB models
    #[serde(default)]
    pub cache_directory: Option<String>,
    /// Cache size limit in MB (None = unlimited)
    #[serde(rename = "cacheLimitMB", default = "default_cache_limit")]
    pub cache_limit_mb: Option<u32>,
    /// Texture downscaling preference
    #[serde(default = "default_texture_scale")]
    pub texture_scale: String,
    /// Skip VMR rules that map to generic/base livery models (e.g., _ZZZZ)
    #[serde(default)]
    pub skip_generic_vmr_matches: bool,
}

impl Default for MsfsModelSettings {
    fn default() -> Self {
        MsfsModelSettings {
            community_path: None,
            enable_fsltl: true,
            enable_aig: true,
            priority: default_msfs_priority(),
            vmr_files: Vec::new(),
            cache_directory: None,
            cache_limit_mb: default_cache_limit(),
            texture_scale: "1k".to_string(),
            skip_generic_vmr_matches: false,
        }
    }
}

// =============================================================================
// GLOBAL SETTINGS (main struct)
// =============================================================================

/// Global settings stored on host file system (shared across all browsers)
/// These settings are persisted to global-settings.json in the app data directory
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub cesium_ion_token: String,
    /// GPU rendering backend (ANGLE) for WebView2. Read at startup in lib.rs to build the
    /// `--use-angle` flag. One of: auto | d3d11 | d3d9 | gl | vulkan.
    #[serde(default = "default_rendering_backend")]
    pub rendering_backend: String,
    #[serde(default)]
    pub imagery: GlobalImagerySettings,
    pub fsltl: GlobalFsltlSettings,
    #[serde(default)]
    pub msfs_models: MsfsModelSettings,
    pub airports: GlobalAirportSettings,
    pub server: GlobalServerSettings,
    #[serde(default)]
    pub realtraffic: GlobalRealTrafficSettings,
    #[serde(default)]
    pub viewports: GlobalViewportSettings,
    #[serde(default)]
    pub display: GlobalDisplaySettings,
    /// List of disabled mod paths (relative to mods folder)
    /// Mods in this list will not be loaded on startup
    #[serde(default)]
    pub disabled_mods: Vec<String>,
    /// vNAS authentication tokens (stored as JSON string for feature-flag compatibility)
    /// Contains serialized StoredTokens from towercab-3d-vnas crate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vnas_tokens: Option<String>,
}

/// Default ANGLE backend: Direct3D 11 is the robust hardware path on Windows.
/// Forcing OpenGL can fall back to the WARP software rasterizer on GPUs with weak GL drivers.
fn default_rendering_backend() -> String {
    "d3d11".to_string()
}

impl Default for GlobalSettings {
    fn default() -> Self {
        GlobalSettings {
            cesium_ion_token: String::new(),
            rendering_backend: default_rendering_backend(),
            imagery: GlobalImagerySettings::default(),
            fsltl: GlobalFsltlSettings {
                source_path: None,
                output_path: None,
                texture_scale: "1k".to_string(),
                enable_fsltl_models: true,
            },
            msfs_models: MsfsModelSettings::default(),
            airports: GlobalAirportSettings {
                default_icao: String::new(),
                recent_airports: Vec::new(),
                vatsim_favorites: Vec::new(),
                realtraffic_favorites: Vec::new(),
            },
            server: GlobalServerSettings {
                port: 8765,
                enabled: false,
                allow_non_local_clients: false,
                minimize_to_tray: true,
            },
            realtraffic: GlobalRealTrafficSettings::default(),
            viewports: GlobalViewportSettings::default(),
            display: GlobalDisplaySettings::default(),
            disabled_mods: Vec::new(),
            vnas_tokens: None,
        }
    }
}

// =============================================================================
// REMOTE ACCESS (what an HTTP client may read and write)
// =============================================================================

/// Who may see and change a settings field over the HTTP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldClass {
    /// Shared with remote clients, which may change it.
    Public,
    /// Belongs to the host machine: remote clients see it but never change it.
    HostOwned,
    /// A credential: hidden from remote clients unless they need it, never changed by them
    /// (the Cesium ion token may be set remotely while the host's is empty).
    Secret,
}

/// Every leaf JSON path of a serialised `GlobalSettings` and its class. `*` stands for one
/// map key, `[]` for each element of an array of objects. The settings tests fail on a
/// serialised path missing here, so a new field stays out of remote reach until classified.
pub const FIELD_CLASSES: &[(&str, FieldClass)] = &[
    ("cesiumIonToken", FieldClass::Secret),
    ("renderingBackend", FieldClass::HostOwned),
    ("imagery.provider", FieldClass::HostOwned),
    ("imagery.googleMapsApiKey", FieldClass::Secret),
    ("imagery.cesiumAdjustments.hueShift", FieldClass::Public),
    ("imagery.cesiumAdjustments.saturation", FieldClass::Public),
    ("imagery.cesiumAdjustments.brightness", FieldClass::Public),
    ("imagery.cesiumAdjustments.contrast", FieldClass::Public),
    ("imagery.googleAdjustments.hueShift", FieldClass::Public),
    ("imagery.googleAdjustments.saturation", FieldClass::Public),
    ("imagery.googleAdjustments.brightness", FieldClass::Public),
    ("imagery.googleAdjustments.contrast", FieldClass::Public),
    ("fsltl.sourcePath", FieldClass::HostOwned),
    ("fsltl.outputPath", FieldClass::HostOwned),
    ("fsltl.textureScale", FieldClass::Public),
    ("fsltl.enableFsltlModels", FieldClass::Public),
    ("msfsModels.communityPath", FieldClass::HostOwned),
    ("msfsModels.enableFsltl", FieldClass::Public),
    ("msfsModels.enableAig", FieldClass::Public),
    ("msfsModels.priority", FieldClass::Public),
    ("msfsModels.vmrFiles", FieldClass::HostOwned),
    ("msfsModels.cacheDirectory", FieldClass::HostOwned),
    ("msfsModels.cacheLimitMB", FieldClass::Public),
    ("msfsModels.textureScale", FieldClass::Public),
    ("msfsModels.skipGenericVmrMatches", FieldClass::Public),
    ("airports.defaultIcao", FieldClass::Public),
    ("airports.recentAirports", FieldClass::Public),
    ("airports.vatsimFavorites", FieldClass::Public),
    ("airports.realtrafficFavorites", FieldClass::Public),
    ("server.port", FieldClass::HostOwned),
    ("server.enabled", FieldClass::HostOwned),
    ("server.allowNonLocalClients", FieldClass::HostOwned),
    ("server.minimizeToTray", FieldClass::HostOwned),
    ("realtraffic.dataSource", FieldClass::Public),
    ("realtraffic.licenseKey", FieldClass::Secret),
    ("realtraffic.radiusNm", FieldClass::Public),
    ("realtraffic.maxParkedAircraft", FieldClass::Public),
    (
        "viewports.airportConfigs.*.mainCamera.viewMode",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.heading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.pitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.fov",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.positionOffsetX",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.positionOffsetY",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.positionOffsetZ",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.topdownAltitude",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.followMode",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.followZoom",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.orbitDistance",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.orbitHeading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.mainCamera.orbitPitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.heading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.pitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.fov",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.positionOffsetX",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.positionOffsetY",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.positionOffsetZ",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default3d.topdownAltitude",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.heading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.pitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.fov",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.positionOffsetX",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.positionOffsetY",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.positionOffsetZ",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.default2d.topdownAltitude",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.name",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.heading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.pitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.fov",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.positionOffsetX",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.positionOffsetY",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.positionOffsetZ",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.viewMode",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.bookmarks.*.topdownAltitude",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.datablockPosition",
        FieldClass::Public,
    ),
    ("viewports.airportConfigs.*.insets[].id", FieldClass::Public),
    (
        "viewports.airportConfigs.*.insets[].label",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].layout.x",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].layout.y",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].layout.width",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].layout.height",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].layout.zIndex",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.viewMode",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.heading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.pitch",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.fov",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.positionOffsetX",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.positionOffsetY",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.positionOffsetZ",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.topdownAltitude",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.followMode",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.followZoom",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.orbitDistance",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.orbitHeading",
        FieldClass::Public,
    ),
    (
        "viewports.airportConfigs.*.insets[].cameraState.orbitPitch",
        FieldClass::Public,
    ),
    ("viewports.orbitSettings.distance", FieldClass::Public),
    ("viewports.orbitSettings.heading", FieldClass::Public),
    ("viewports.orbitSettings.pitch", FieldClass::Public),
    ("viewports.lastAirportIcao", FieldClass::Public),
    ("display.leaderDistance", FieldClass::Public),
    ("display.defaultDatablockDirection", FieldClass::Public),
    ("display.datablockMode", FieldClass::Public),
    ("display.labelVisibilityDistance", FieldClass::Public),
    ("display.showGroundTraffic", FieldClass::Public),
    ("display.showAirborneTraffic", FieldClass::Public),
    ("display.autoAvoidOverlaps", FieldClass::Public),
    ("display.groundLabelMode", FieldClass::Public),
    ("display.groundLabelMinSpeed", FieldClass::Public),
    ("display.inset.datablockMode", FieldClass::Public),
    ("display.inset.groundLabelMode", FieldClass::Public),
    ("display.inset.visibilityMargin", FieldClass::Public),
    ("disabledMods", FieldClass::Public),
    ("vnasTokens", FieldClass::Secret),
];

/// The settings a remote client may see: every field, with the secrets it has no use for
/// blanked (`realtraffic.licenseKey`, `vnasTokens`, and `imagery.googleMapsApiKey` unless
/// Google is the imagery provider). The Cesium ion token is kept: remote viewers need it.
pub fn remote_view(settings: &GlobalSettings) -> GlobalSettings {
    let mut view = settings.clone();
    if view.imagery.provider != "google" {
        view.imagery.google_maps_api_key.clear();
    }
    view.realtraffic.license_key.clear();
    view.vnas_tokens = None;
    view
}

/// The settings to store after a remote client posts `incoming`: its public fields, with
/// every host-owned and secret field of `FIELD_CLASSES` kept from `existing`. The one
/// exception is the Cesium ion token, taken from `incoming` while the host has none.
pub fn merge_remote_write(existing: &GlobalSettings, incoming: GlobalSettings) -> GlobalSettings {
    let mut merged = incoming;
    if !existing.cesium_ion_token.is_empty() {
        merged.cesium_ion_token = existing.cesium_ion_token.clone();
    }
    merged.rendering_backend = existing.rendering_backend.clone();
    merged.imagery.provider = existing.imagery.provider.clone();
    merged.imagery.google_maps_api_key = existing.imagery.google_maps_api_key.clone();
    merged.fsltl.source_path = existing.fsltl.source_path.clone();
    merged.fsltl.output_path = existing.fsltl.output_path.clone();
    merged.msfs_models.community_path = existing.msfs_models.community_path.clone();
    merged.msfs_models.vmr_files = existing.msfs_models.vmr_files.clone();
    merged.msfs_models.cache_directory = existing.msfs_models.cache_directory.clone();
    merged.server = existing.server.clone();
    merged.realtraffic.license_key = existing.realtraffic.license_key.clone();
    merged.vnas_tokens = existing.vnas_tokens.clone();
    merged
}

// =============================================================================
// PERSISTENCE FUNCTIONS
// =============================================================================

/// Get the path to the global settings file
pub fn get_global_settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Ensure directory exists
    fs::create_dir_all(&app_data)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(app_data.join("global-settings.json"))
}

/// Get the path to the global settings file (for diagnostics)
#[tauri::command]
pub fn get_global_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = get_global_settings_file(&app)?;
    Ok(normalize_path_string(&path))
}

/// Read global settings from disk
/// Returns default settings if file doesn't exist
/// The vNAS tokens stay in Rust: the host webview never receives them.
#[tauri::command]
pub fn read_global_settings(app: tauri::AppHandle) -> Result<GlobalSettings, String> {
    read_host_settings_file(&get_global_settings_file(&app)?)
}

/// The host webview's view of the settings file: everything but the vNAS tokens
fn read_host_settings_file(settings_file: &Path) -> Result<GlobalSettings, String> {
    let settings = read_settings_file(settings_file)?;
    Ok(GlobalSettings {
        vnas_tokens: None,
        ..settings
    })
}

/// The settings an HTTP client reads: the remote view of the settings file
pub fn read_remote_view(settings_file: &Path) -> Result<GlobalSettings, String> {
    Ok(remote_view(&read_settings_file(settings_file)?))
}

/// Store a remote client's settings through `merge_remote_write` and return the remote view
/// of what was stored
pub fn apply_remote_write(
    settings_file: &Path,
    incoming: GlobalSettings,
) -> Result<GlobalSettings, String> {
    let stored = update_settings_file(settings_file, |existing| {
        merge_remote_write(&existing, incoming)
    })?;
    Ok(remote_view(&stored))
}

/// Held across every read-modify-write of the settings file, so no write in this process
/// lands between another's read and its write
static SETTINGS_FILE_LOCK: Mutex<()> = Mutex::new(());

/// Whether the HTTP server serves clients outside the local network. The server loads it
/// from the settings file when it starts and every host settings write updates it, so a
/// change applies to the next request without a restart.
pub static ALLOW_NON_LOCAL_CLIENTS: AtomicBool = AtomicBool::new(false);

/// Read the settings file, apply `change`, and write the result back, as one step no other
/// settings write in this process can land inside
fn update_settings_file(
    settings_file: &Path,
    change: impl FnOnce(GlobalSettings) -> GlobalSettings,
) -> Result<GlobalSettings, String> {
    update_settings_file_with(settings_file, read_settings_file, change)
}

/// `update_settings_file`, reading the existing settings with `read`
fn update_settings_file_with(
    settings_file: &Path,
    read: fn(&Path) -> Result<GlobalSettings, String>,
    change: impl FnOnce(GlobalSettings) -> GlobalSettings,
) -> Result<GlobalSettings, String> {
    // The lock guards no data, so a holder's panic leaves nothing inconsistent behind
    let _guard = SETTINGS_FILE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let updated = change(read(settings_file)?);
    write_settings_file(settings_file, &updated)?;
    Ok(updated)
}

/// Read the settings file exactly as stored, or the defaults when it does not exist yet
pub fn read_settings_file(settings_file: &Path) -> Result<GlobalSettings, String> {
    if !settings_file.exists() {
        return Ok(GlobalSettings::default());
    }

    let content = fs::read_to_string(settings_file)
        .map_err(|e| format!("Failed to read global settings {:?}: {}", settings_file, e))?;

    // Parse with defaults for missing fields (for forward compatibility)
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse global settings {:?}: {}", settings_file, e))
}

/// Write global settings from the host webview to disk
///
/// The stored vNAS tokens are kept whatever `settings` holds: only Rust writes them.
#[tauri::command]
pub fn write_global_settings(
    app: tauri::AppHandle,
    settings: GlobalSettings,
) -> Result<(), String> {
    write_host_settings_file(
        &get_global_settings_file(&app)?,
        settings,
        &ALLOW_NON_LOCAL_CLIENTS,
    )
}

/// Write the host's settings, keeping the vNAS tokens already in the file, and publish
/// `server.allowNonLocalClients` to `allow_non_local_clients`. An empty incoming Cesium ion
/// token keeps the stored one; an existing file that does not parse is set aside first.
pub fn write_host_settings_file(
    settings_file: &Path,
    settings: GlobalSettings,
    allow_non_local_clients: &AtomicBool,
) -> Result<(), String> {
    let stored = update_settings_file_with(settings_file, read_or_set_aside, |existing| {
        let mut stored = GlobalSettings {
            vnas_tokens: existing.vnas_tokens,
            ..settings
        };
        // An ion token a remote client set while the host had none survives a host webview
        // that still holds the empty token it loaded
        if stored.cesium_ion_token.is_empty() {
            stored.cesium_ion_token = existing.cesium_ion_token;
        }
        stored
    })?;
    allow_non_local_clients.store(stored.server.allow_non_local_clients, Ordering::SeqCst);
    Ok(())
}

/// Read the settings file for a host write. A file that does not parse is copied aside to
/// `<name>.corrupt-<unix seconds>` and the defaults returned, so the host can save again;
/// the vNAS tokens it held are lost. The original stays until the write replaces it. Writes
/// go through a rename, so a file that does not parse is corrupt, not half-written.
fn read_or_set_aside(settings_file: &Path) -> Result<GlobalSettings, String> {
    if !settings_file.exists() {
        return Ok(GlobalSettings::default());
    }
    let content = fs::read_to_string(settings_file)
        .map_err(|e| format!("Failed to read global settings {:?}: {}", settings_file, e))?;
    match serde_json::from_str(&content) {
        Ok(settings) => Ok(settings),
        Err(parse_error) => {
            let aside = set_aside(settings_file)?;
            tracing::warn!(
                "[Settings] Copied unreadable settings file to {:?} ({}); its vNAS tokens are lost",
                aside,
                parse_error
            );
            Ok(GlobalSettings::default())
        }
    }
}

/// Copy the settings file to `<name>.corrupt-<unix seconds>` beside it, leaving the original
/// where it is so a write that then fails cannot leave no settings file behind
fn set_aside(settings_file: &Path) -> Result<PathBuf, String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("System clock is before 1970: {}", e))?
        .as_secs();
    let mut aside = settings_file.as_os_str().to_owned();
    aside.push(format!(".corrupt-{seconds}"));
    let aside = PathBuf::from(aside);
    fs::copy(settings_file, &aside).map_err(|e| {
        format!(
            "Failed to copy unreadable global settings {:?} to {:?}: {}",
            settings_file, aside, e
        )
    })?;
    Ok(aside)
}

/// Write the settings file exactly as given, through a temporary file in the same folder
/// renamed over it, so a reader never sees a half-written file
fn write_settings_file(settings_file: &Path, settings: &GlobalSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize global settings: {}", e))?;

    let mut temp_file = settings_file.as_os_str().to_owned();
    temp_file.push(".tmp");
    let temp_file = PathBuf::from(temp_file);
    fs::write(&temp_file, content)
        .map_err(|e| format!("Failed to write global settings {:?}: {}", temp_file, e))?;
    fs::rename(&temp_file, settings_file).map_err(|e| {
        format!(
            "Failed to replace global settings {:?} with {:?}: {}",
            settings_file, temp_file, e
        )
    })?;

    tracing::info!("[Settings] Global settings saved to {:?}", settings_file);
    Ok(())
}

/// Read the stored vNAS tokens (serialised `StoredTokens`), for `vnas.rs` only
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vnas feature signs in
pub(crate) fn read_vnas_tokens(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    read_vnas_tokens_at(&get_global_settings_file(app)?)
}

/// Store the vNAS tokens, or remove them from the file with `None`, for `vnas.rs` only
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vnas feature signs in
pub(crate) fn write_vnas_tokens(
    app: &tauri::AppHandle,
    tokens: Option<String>,
) -> Result<(), String> {
    write_vnas_tokens_at(&get_global_settings_file(app)?, tokens)
}

#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vnas feature signs in
fn read_vnas_tokens_at(settings_file: &Path) -> Result<Option<String>, String> {
    Ok(read_settings_file(settings_file)?.vnas_tokens)
}

#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vnas feature signs in
fn write_vnas_tokens_at(settings_file: &Path, tokens: Option<String>) -> Result<(), String> {
    update_settings_file(settings_file, |existing| GlobalSettings {
        vnas_tokens: tokens,
        ..existing
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    fn camera_state() -> GlobalInsetCameraState {
        GlobalInsetCameraState {
            view_mode: "3d".to_string(),
            heading: 1.0,
            pitch: 2.0,
            fov: 3.0,
            position_offset_x: 4.0,
            position_offset_y: 5.0,
            position_offset_z: 6.0,
            topdown_altitude: 7.0,
            follow_mode: "tower".to_string(),
            follow_zoom: 1.5,
            orbit_distance: 500.0,
            orbit_heading: 10.0,
            orbit_pitch: 20.0,
        }
    }

    fn view_mode_defaults() -> GlobalViewModeDefaults {
        GlobalViewModeDefaults {
            heading: 1.0,
            pitch: 2.0,
            fov: 3.0,
            position_offset_x: 4.0,
            position_offset_y: 5.0,
            position_offset_z: 6.0,
            topdown_altitude: Some(7.0),
        }
    }

    fn airport_viewport_config() -> GlobalAirportViewportConfig {
        let bookmark = GlobalCameraBookmark {
            name: Some("Runway 28".to_string()),
            heading: 1.0,
            pitch: 2.0,
            fov: 3.0,
            position_offset_x: 4.0,
            position_offset_y: 5.0,
            position_offset_z: 6.0,
            view_mode: "3d".to_string(),
            topdown_altitude: Some(7.0),
        };
        let inset = GlobalInsetViewport {
            id: "inset-1".to_string(),
            label: Some("Ramp".to_string()),
            layout: GlobalInsetLayout {
                x: 1.0,
                y: 2.0,
                width: 300.0,
                height: 200.0,
                z_index: 1,
            },
            camera_state: camera_state(),
        };
        GlobalAirportViewportConfig {
            main_camera: Some(camera_state()),
            default_3d: Some(view_mode_defaults()),
            default_2d: Some(view_mode_defaults()),
            bookmarks: HashMap::from([("1".to_string(), bookmark)]),
            datablock_position: Some(7),
            insets: vec![inset],
        }
    }

    /// Settings with every optional field and collection populated and a sentinel in every secret.
    fn populated() -> GlobalSettings {
        GlobalSettings {
            cesium_ion_token: "SECRET-ion".to_string(),
            rendering_backend: "vulkan".to_string(),
            imagery: GlobalImagerySettings {
                google_maps_api_key: "SECRET-google".to_string(),
                ..GlobalImagerySettings::default()
            },
            fsltl: GlobalFsltlSettings {
                source_path: Some("D:/fsltl".to_string()),
                output_path: Some("D:/fsltl-out".to_string()),
                texture_scale: "2k".to_string(),
                enable_fsltl_models: true,
            },
            msfs_models: MsfsModelSettings {
                community_path: Some("D:/Community".to_string()),
                vmr_files: vec!["D:/rules.vmr".to_string()],
                cache_directory: Some("D:/cache".to_string()),
                ..MsfsModelSettings::default()
            },
            airports: GlobalAirportSettings {
                default_icao: "KSFO".to_string(),
                recent_airports: vec!["KSFO".to_string()],
                vatsim_favorites: vec!["KOAK".to_string()],
                realtraffic_favorites: vec!["KSJC".to_string()],
            },
            server: GlobalServerSettings {
                port: 9000,
                enabled: true,
                allow_non_local_clients: false,
                minimize_to_tray: false,
            },
            realtraffic: GlobalRealTrafficSettings {
                license_key: "SECRET-licence".to_string(),
                ..GlobalRealTrafficSettings::default()
            },
            viewports: GlobalViewportSettings {
                airport_configs: HashMap::from([("KSFO".to_string(), airport_viewport_config())]),
                orbit_settings: GlobalOrbitSettings::default(),
                last_airport_icao: Some("KSFO".to_string()),
            },
            display: GlobalDisplaySettings::default(),
            disabled_mods: vec!["aircraft/B738".to_string()],
            vnas_tokens: Some("SECRET-vnas".to_string()),
        }
    }

    /// Collects every leaf path: object keys joined by `.`, `[]` after an array of objects.
    fn collect_leaf_paths(value: &Value, path: &str, out: &mut Vec<String>) {
        let join = |key: &str| {
            if path.is_empty() {
                key.to_string()
            } else {
                format!("{path}.{key}")
            }
        };
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    collect_leaf_paths(child, &join(key), out);
                }
            }
            Value::Array(items) if items.iter().any(Value::is_object) => {
                for item in items {
                    collect_leaf_paths(item, &format!("{path}[]"), out);
                }
            }
            _ => out.push(path.to_string()),
        }
    }

    /// Whether a classification pattern names a leaf path; `*` stands for one map key.
    fn path_matches(pattern: &str, path: &str) -> bool {
        let pattern: Vec<&str> = pattern.split('.').collect();
        let path: Vec<&str> = path.split('.').collect();
        pattern.len() == path.len()
            && pattern
                .iter()
                .zip(&path)
                .all(|(want, got)| want == got || *want == "*")
    }

    fn value_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
        path.split('.').try_fold(value, |node, key| node.get(key))
    }

    #[test]
    fn default_server_settings_refuse_non_local_clients() {
        assert!(!GlobalSettings::default().server.allow_non_local_clients);
    }

    #[test]
    fn old_require_local_network_key_deserialises_restricted() {
        let server: GlobalServerSettings =
            serde_json::from_str(r#"{"port":8765,"enabled":true,"requireLocalNetwork":false}"#)
                .expect("old server settings should still parse");
        assert!(!server.allow_non_local_clients);
    }

    #[test]
    fn msfs_cache_limit_round_trips_frontend_key() {
        for (stored, expected) in [(serde_json::json!(4096), Some(4096)), (Value::Null, None)] {
            let mut json =
                serde_json::to_value(GlobalSettings::default()).expect("serialise settings");
            let msfs = json["msfsModels"]
                .as_object_mut()
                .expect("msfsModels is an object");
            msfs.insert("cacheLimitMB".to_string(), stored.clone());

            let settings: GlobalSettings =
                serde_json::from_value(json).expect("frontend settings deserialise");
            assert_eq!(settings.msfs_models.cache_limit_mb, expected);

            let written = serde_json::to_value(&settings).expect("serialise settings");
            assert_eq!(written["msfsModels"].get("cacheLimitMB"), Some(&stored));
            assert!(
                written["msfsModels"].get("cacheLimitMb").is_none(),
                "settings still write the old cacheLimitMb key: {written}"
            );
        }
    }

    #[test]
    fn every_serialised_path_is_classified() {
        let value = serde_json::to_value(populated()).expect("serialise settings");
        let mut paths = Vec::new();
        collect_leaf_paths(&value, "", &mut paths);

        let unclassified: Vec<&String> = paths
            .iter()
            .filter(|path| {
                !FIELD_CLASSES
                    .iter()
                    .any(|(pattern, _)| path_matches(pattern, path))
            })
            .collect();
        assert!(
            unclassified.is_empty(),
            "settings paths missing from FIELD_CLASSES: {unclassified:?}"
        );

        let stale: Vec<&str> = FIELD_CLASSES
            .iter()
            .filter(|(pattern, _)| !paths.iter().any(|path| path_matches(pattern, path)))
            .map(|(pattern, _)| *pattern)
            .collect();
        assert!(
            stale.is_empty(),
            "FIELD_CLASSES entries naming no field: {stale:?}"
        );
    }

    #[test]
    fn remote_view_holds_no_secret_but_keeps_ion_token() {
        let view = remote_view(&populated());
        let json = serde_json::to_string(&view).expect("serialise view");
        for secret in ["SECRET-licence", "SECRET-google", "SECRET-vnas"] {
            assert!(!json.contains(secret), "remote view leaks {secret}: {json}");
        }
        assert_eq!(view.cesium_ion_token, "SECRET-ion");
        assert_eq!(view.realtraffic.license_key, "");
        assert_eq!(view.imagery.google_maps_api_key, "");
        assert!(view.vnas_tokens.is_none());
    }

    #[test]
    fn remote_view_keeps_google_key_when_provider_is_google() {
        let mut host = populated();
        host.imagery.provider = "google".to_string();
        let view = remote_view(&host);
        assert_eq!(view.imagery.google_maps_api_key, "SECRET-google");
        assert!(!serde_json::to_string(&view)
            .expect("serialise view")
            .contains("SECRET-licence"));
    }

    /// The fixture the dev server's Node port of `remote_view` (scripts/dev/settingsView.ts) is
    /// tested against, committed at the repo root.
    const REMOTE_VIEW_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/remote-view.json"
    );

    /// Every `FieldClass::Secret` path of `FIELD_CLASSES`, in table order.
    fn secret_paths() -> Vec<String> {
        FIELD_CLASSES
            .iter()
            .filter(|(_, class)| *class == FieldClass::Secret)
            .map(|(path, _)| (*path).to_string())
            .collect()
    }

    /// The fixture's content: the secret paths, and `populated()` with its remote view for
    /// each imagery provider rule.
    fn remote_view_fixture() -> Value {
        let mut google = populated();
        google.imagery.provider = "google".to_string();
        let case = |name: &str, input: GlobalSettings| {
            serde_json::json!({
                "name": name,
                "input": serde_json::to_value(&input).expect("serialise settings"),
                "expected": serde_json::to_value(remote_view(&input)).expect("serialise view"),
            })
        };
        serde_json::json!({
            "secretPaths": secret_paths(),
            "cases": [
                case("imagery provider is not google", populated()),
                case("imagery provider is google", google),
            ],
        })
    }

    fn read_remote_view_fixture() -> Value {
        let text = fs::read_to_string(REMOTE_VIEW_FIXTURE).unwrap_or_else(|e| {
            panic!(
                "read {REMOTE_VIEW_FIXTURE}: {e}; write it by running this test with TC3D_UPDATE_FIXTURES=1"
            )
        });
        serde_json::from_str(&text).expect("parse the remote view fixture")
    }

    #[test]
    fn populated_fixture_matches() {
        let generated = remote_view_fixture();
        if std::env::var_os("TC3D_UPDATE_FIXTURES").is_some() {
            let text = serde_json::to_string_pretty(&generated).expect("serialise fixture");
            fs::write(REMOTE_VIEW_FIXTURE, text + "\n").expect("write the remote view fixture");
        }
        assert_eq!(
            read_remote_view_fixture(),
            generated,
            "tests/fixtures/remote-view.json is stale: rerun with TC3D_UPDATE_FIXTURES=1, then make \
             scripts/dev/settingsView.ts produce the new expected views"
        );
    }

    #[test]
    fn fixture_secret_paths_match_field_classes() {
        let fixture = read_remote_view_fixture();
        let listed: Vec<String> = fixture["secretPaths"]
            .as_array()
            .expect("secretPaths is an array")
            .iter()
            .map(|path| path.as_str().expect("secret path is a string").to_string())
            .collect();
        assert_eq!(listed, secret_paths());
    }

    #[test]
    fn merge_keeps_host_fields_across_remote_round_trip() {
        let host = populated();
        let mut incoming = remote_view(&host);
        incoming.display.leader_distance = 4;
        incoming.vnas_tokens = Some("REMOTE-vnas".to_string());
        incoming.realtraffic.license_key = "REMOTE-licence".to_string();
        incoming.msfs_models.cache_directory = Some("C:/".to_string());
        incoming.server.allow_non_local_clients = true;
        incoming.cesium_ion_token = "REMOTE-ion".to_string();

        let merged = merge_remote_write(&host, incoming);

        assert_eq!(merged.display.leader_distance, 4);
        assert_eq!(merged.cesium_ion_token, "SECRET-ion");
        assert_eq!(merged.vnas_tokens.as_deref(), Some("SECRET-vnas"));
        assert_eq!(merged.realtraffic.license_key, "SECRET-licence");
        assert_eq!(
            merged.msfs_models.cache_directory.as_deref(),
            Some("D:/cache")
        );
        assert!(!merged.server.allow_non_local_clients);

        let host_json = serde_json::to_value(&host).expect("serialise host");
        let merged_json = serde_json::to_value(&merged).expect("serialise merged");
        for (path, class) in FIELD_CLASSES {
            if *class != FieldClass::Public {
                assert_eq!(
                    value_at(&merged_json, path),
                    value_at(&host_json, path),
                    "remote write changed host-owned {path}"
                );
            }
        }
    }

    #[test]
    fn merge_takes_remote_ion_token_only_when_host_has_none() {
        let host = GlobalSettings {
            cesium_ion_token: String::new(),
            ..populated()
        };
        let incoming = GlobalSettings {
            cesium_ion_token: "REMOTE-ion".to_string(),
            ..remote_view(&host)
        };
        assert_eq!(
            merge_remote_write(&host, incoming).cesium_ion_token,
            "REMOTE-ion"
        );
    }

    /// A settings file path in a fresh, empty folder under the system temp folder, removed
    /// when dropped.
    struct TempSettingsFile(PathBuf);

    impl TempSettingsFile {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("tc3d-settings-{}-{}", name, std::process::id()));
            if dir.exists() {
                fs::remove_dir_all(&dir).expect("clear stale temp dir");
            }
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir.join("global-settings.json"))
        }
    }

    impl Drop for TempSettingsFile {
        fn drop(&mut self) {
            let dir = self.0.parent().expect("temp settings file has a folder");
            if let Err(e) = fs::remove_dir_all(dir) {
                eprintln!("failed to remove temp dir {:?}: {}", dir, e);
            }
        }
    }

    #[test]
    fn host_write_without_tokens_keeps_file_tokens() {
        let file = TempSettingsFile::new("host-write-none");
        write_settings_file(&file.0, &populated()).expect("seed settings file");

        let incoming = GlobalSettings {
            vnas_tokens: None,
            ..populated()
        };
        write_host_settings_file(&file.0, incoming, &AtomicBool::new(false)).expect("host write");

        let stored = read_settings_file(&file.0).expect("read back");
        assert_eq!(stored.vnas_tokens.as_deref(), Some("SECRET-vnas"));
    }

    #[test]
    fn host_write_with_other_tokens_keeps_file_tokens() {
        let file = TempSettingsFile::new("host-write-stale");
        write_settings_file(&file.0, &populated()).expect("seed settings file");

        let incoming = GlobalSettings {
            vnas_tokens: Some("STALE-vnas".to_string()),
            ..populated()
        };
        write_host_settings_file(&file.0, incoming, &AtomicBool::new(false)).expect("host write");

        let stored = read_settings_file(&file.0).expect("read back");
        assert_eq!(stored.vnas_tokens.as_deref(), Some("SECRET-vnas"));
    }

    #[test]
    fn clearing_tokens_removes_them_from_file() {
        let file = TempSettingsFile::new("clear-tokens");
        write_settings_file(&file.0, &populated()).expect("seed settings file");

        write_vnas_tokens_at(&file.0, None).expect("clear tokens");

        let content = fs::read_to_string(&file.0).expect("read settings file");
        assert!(
            !content.contains("vnasTokens"),
            "tokens still stored: {content}"
        );
        assert_eq!(read_vnas_tokens_at(&file.0).expect("read tokens"), None);
    }

    /// A different value of the same JSON type, so a remote write that changes it is visible.
    fn changed(value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(format!("REMOTE-{text}")),
            Value::Bool(flag) => Value::Bool(!flag),
            Value::Number(number) => {
                Value::from(number.as_u64().expect("test numbers are u64") + 1)
            }
            Value::Array(_) => Value::Array(vec![Value::String("REMOTE".to_string())]),
            other => panic!("no changed value for {other}"),
        }
    }

    #[test]
    fn merge_keeps_every_host_owned_field_a_remote_client_changes() {
        let host = populated();
        let mut incoming = serde_json::to_value(&host).expect("serialise host");
        let host_owned: Vec<&str> = FIELD_CLASSES
            .iter()
            .filter(|(_, class)| *class != FieldClass::Public)
            .map(|(path, _)| *path)
            .collect();
        for path in &host_owned {
            let (parent, key) = path.rsplit_once('.').unwrap_or(("", path));
            let node = if parent.is_empty() {
                &mut incoming
            } else {
                parent
                    .split('.')
                    .try_fold(&mut incoming, |node, key| node.get_mut(key))
                    .expect("host-owned path exists")
            };
            let value = changed(&node[key]);
            node[key] = value;
        }
        let incoming: GlobalSettings =
            serde_json::from_value(incoming).expect("changed settings deserialise");

        let merged =
            serde_json::to_value(merge_remote_write(&host, incoming)).expect("serialise merged");
        let host_json = serde_json::to_value(&host).expect("serialise host");
        for path in host_owned {
            assert_eq!(
                value_at(&merged, path),
                value_at(&host_json, path),
                "remote write changed host-owned {path}"
            );
        }
    }

    #[test]
    fn remote_write_cannot_switch_imagery_provider_to_reveal_google_key() {
        let file = TempSettingsFile::new("remote-provider");
        let mut host = populated();
        host.imagery.provider = "cesium".to_string();
        write_settings_file(&file.0, &host).expect("seed settings file");

        let mut incoming = remote_view(&host);
        incoming.imagery.provider = "google".to_string();
        let echo = apply_remote_write(&file.0, incoming).expect("remote write");
        let get = read_remote_view(&file.0).expect("remote read");

        for (label, view) in [("POST echo", &echo), ("GET", &get)] {
            assert_eq!(view.imagery.provider, "cesium", "{label} provider");
            assert_eq!(view.imagery.google_maps_api_key, "", "{label} Google key");
        }
    }

    /// Bounds a wait that only a broken product reaches.
    const HANG_GUARD: Duration = Duration::from_secs(300);

    #[test]
    fn token_write_between_remote_read_and_write_is_kept() {
        let file = TempSettingsFile::new("token-during-remote");
        write_settings_file(&file.0, &populated()).expect("seed settings file");

        let (read_tx, read_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let incoming = remote_view(&populated());
        let path = file.0.clone();
        let remote = thread::spawn(move || {
            update_settings_file(&path, |existing| {
                read_tx.send(()).expect("signal read");
                release_rx.recv().expect("wait for release");
                merge_remote_write(&existing, incoming)
            })
        });
        read_rx
            .recv_timeout(HANG_GUARD)
            .expect("remote write read the file");

        let (done_tx, done_rx) = mpsc::channel();
        let path = file.0.clone();
        let token_write = thread::spawn(move || {
            let result = write_vnas_tokens_at(&path, Some("ROTATED-vnas".to_string()));
            done_tx.send(()).expect("signal token write done");
            result
        });
        // While the remote write holds the lock, the token write cannot finish before it; with
        // no lock held, let the token write finish first, landing between the read and write.
        let lock_free = SETTINGS_FILE_LOCK.try_lock().is_ok();
        if lock_free {
            done_rx
                .recv_timeout(HANG_GUARD)
                .expect("token write finished");
        }
        release_tx.send(()).expect("release remote write");

        remote
            .join()
            .expect("remote write thread")
            .expect("remote write");
        token_write
            .join()
            .expect("token write thread")
            .expect("token write");
        assert_eq!(
            read_vnas_tokens_at(&file.0)
                .expect("read tokens")
                .as_deref(),
            Some("ROTATED-vnas")
        );
    }

    #[test]
    fn host_write_over_corrupt_file_sets_it_aside() {
        let file = TempSettingsFile::new("host-write-corrupt");
        fs::write(&file.0, "{ not json").expect("seed corrupt file");

        write_host_settings_file(&file.0, populated(), &AtomicBool::new(false))
            .expect("host write over a corrupt file");

        let stored = read_settings_file(&file.0).expect("read back");
        assert_eq!(stored.cesium_ion_token, "SECRET-ion");
        let folder = file.0.parent().expect("settings folder");
        let set_aside: Vec<String> = fs::read_dir(folder)
            .expect("list settings folder")
            .map(|entry| entry.expect("folder entry").path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("global-settings.json.corrupt-"))
            })
            .map(|path| fs::read_to_string(path).expect("read set-aside file"))
            .collect();
        assert_eq!(set_aside, vec!["{ not json".to_string()]);
    }

    #[test]
    fn host_write_that_cannot_be_stored_keeps_the_corrupt_file() {
        let file = TempSettingsFile::new("host-write-corrupt-kept");
        fs::write(&file.0, "{ not json").expect("seed corrupt file");
        let mut temp = file.0.as_os_str().to_owned();
        temp.push(".tmp");
        fs::create_dir(&temp).expect("make the temp path a directory");

        let error = write_host_settings_file(&file.0, populated(), &AtomicBool::new(false))
            .expect_err("a write whose temp file cannot be written");

        assert!(error.contains("global-settings.json.tmp"), "{error}");
        assert_eq!(
            fs::read_to_string(&file.0).expect("read the corrupt original"),
            "{ not json",
            "the corrupt settings file must still be there"
        );
    }

    #[test]
    fn host_write_with_empty_ion_token_keeps_stored_token() {
        let file = TempSettingsFile::new("host-write-empty-ion");
        let mut stored = populated();
        stored.cesium_ion_token = "REMOTE-ion".to_string();
        write_settings_file(&file.0, &stored).expect("seed settings file");

        let incoming = GlobalSettings {
            cesium_ion_token: String::new(),
            ..populated()
        };
        write_host_settings_file(&file.0, incoming, &AtomicBool::new(false)).expect("host write");

        let stored = read_settings_file(&file.0).expect("read back");
        assert_eq!(stored.cesium_ion_token, "REMOTE-ion");
    }

    #[test]
    fn host_read_never_returns_vnas_tokens() {
        let file = TempSettingsFile::new("host-read");
        write_settings_file(&file.0, &populated()).expect("seed settings file");

        let settings = read_host_settings_file(&file.0).expect("host read");

        assert_eq!(settings.vnas_tokens, None);
        assert_eq!(settings.cesium_ion_token, "SECRET-ion");
    }
}
