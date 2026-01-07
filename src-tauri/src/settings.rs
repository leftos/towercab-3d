//! Global settings management.
//!
//! This module handles:
//! - GlobalSettings types and defaults
//! - Reading/writing settings to disk
//! - Settings shared across all browsers/devices

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
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
    /// Optional authentication token for API access
    /// When set, clients must send this as Bearer token in Authorization header
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
    /// If true, only allow connections from local network (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    #[serde(default)]
    pub require_local_network: bool,
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
}

impl Default for GlobalRealTrafficSettings {
    fn default() -> Self {
        GlobalRealTrafficSettings {
            data_source: "vatsim".to_string(),
            license_key: String::new(),
            radius_nm: 100,
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
    pub view_mode: String,  // "3d" or "topdown"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topdown_altitude: Option<f64>,
}

/// Per-airport viewport configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalAirportViewportConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_3d: Option<GlobalViewModeDefaults>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_2d: Option<GlobalViewModeDefaults>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub bookmarks: std::collections::HashMap<String, GlobalCameraBookmark>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub datablock_position: Option<u8>,  // 1-9 numpad position
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
            distance: 500.0,  // ORBIT_DISTANCE_DEFAULT
            heading: 0.0,     // ORBIT_HEADING_DEFAULT
            pitch: 20.0,      // ORBIT_PITCH_DEFAULT
        }
    }
}

/// Viewport settings (camera positions, bookmarks per airport)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalViewportSettings {
    #[serde(default)]
    pub airport_configs: std::collections::HashMap<String, GlobalAirportViewportConfig>,
    #[serde(default)]
    pub orbit_settings: GlobalOrbitSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_airport_icao: Option<String>,
}

impl Default for GlobalViewportSettings {
    fn default() -> Self {
        GlobalViewportSettings {
            airport_configs: std::collections::HashMap::new(),
            orbit_settings: GlobalOrbitSettings::default(),
            last_airport_icao: None,
        }
    }
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
    #[serde(default = "default_cache_limit")]
    pub cache_limit_mb: Option<u32>,
    /// Texture downscaling preference
    #[serde(default = "default_texture_scale")]
    pub texture_scale: String,
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
}

impl Default for GlobalSettings {
    fn default() -> Self {
        GlobalSettings {
            cesium_ion_token: String::new(),
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
            },
            server: GlobalServerSettings {
                port: 8765,
                enabled: false,
                auth_token: None,
                require_local_network: false,
            },
            realtraffic: GlobalRealTrafficSettings::default(),
            viewports: GlobalViewportSettings::default(),
            display: GlobalDisplaySettings::default(),
        }
    }
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
#[tauri::command]
pub fn read_global_settings(app: tauri::AppHandle) -> Result<GlobalSettings, String> {
    let settings_file = get_global_settings_file(&app)?;

    if !settings_file.exists() {
        // Return defaults if file doesn't exist yet
        return Ok(GlobalSettings::default());
    }

    let content = fs::read_to_string(&settings_file)
        .map_err(|e| format!("Failed to read global settings: {}", e))?;

    // Parse with defaults for missing fields (for forward compatibility)
    let settings: GlobalSettings = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse global settings: {}", e))?;

    Ok(settings)
}

/// Write global settings to disk
#[tauri::command]
pub fn write_global_settings(app: tauri::AppHandle, settings: GlobalSettings) -> Result<(), String> {
    let settings_file = get_global_settings_file(&app)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize global settings: {}", e))?;

    fs::write(&settings_file, content)
        .map_err(|e| format!("Failed to write global settings: {}", e))?;

    println!("[Settings] Global settings saved to {:?}", settings_file);
    Ok(())
}
