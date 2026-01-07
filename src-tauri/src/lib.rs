use std::fs;
use std::path::PathBuf;
use std::process::{Command, Child};
use std::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

mod server;
mod vnas;

#[cfg(windows)]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Wrapper for a Windows HANDLE that is Send-safe
/// Job handles are thread-safe kernel objects, safe to send between threads
#[cfg(windows)]
struct SendableHandle(*mut std::ffi::c_void);

#[cfg(windows)]
unsafe impl Send for SendableHandle {}

/// Wrapper for a process and its associated job object (Windows)
/// The job object ensures all child processes are killed when we terminate
struct ProcessWithJob {
    child: Child,
    #[cfg(windows)]
    job_handle: SendableHandle,
}

impl Drop for ProcessWithJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            // Closing the job handle terminates all processes in the job
            // due to JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag
            if !self.job_handle.0.is_null() {
                unsafe { CloseHandle(self.job_handle.0) };
            }
        }
        #[cfg(not(windows))]
        {
            // On non-Windows, explicitly kill the child process
            let _ = self.child.kill();
        }
    }
}

// Global storage for the FSLTL converter process so we can cancel it
static FSLTL_CONVERTER_PROCESS: Mutex<Option<ProcessWithJob>> = Mutex::new(None);

// Global storage for the HTTP server shutdown channel
static HTTP_SERVER_SHUTDOWN: Mutex<Option<broadcast::Sender<()>>> = Mutex::new(None);

// Global storage for the running server port
static HTTP_SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

// Global storage for vNAS WebSocket broadcast channel (to relay updates to remote browsers)
static VNAS_WEBSOCKET_TX: Mutex<Option<broadcast::Sender<Vec<server::VnasAircraftBroadcast>>>> =
    Mutex::new(None);

/// Find the mods root directory, checking multiple locations
/// Returns the first path that exists, or the first candidate if none exist
fn find_mods_root(app: &tauri::AppHandle) -> PathBuf {
    let resource_path = app.path().resource_dir().unwrap_or_default();
    let mods_path = resource_path.join("mods");

    if mods_path.exists() {
        mods_path
    } else {
        // Fallback to resource path (will be created if needed)
        mods_path
    }
}

/// Get the path to a mod type directory (aircraft or towers)
#[tauri::command]
fn get_mods_path(app: tauri::AppHandle, mod_type: String) -> Result<String, String> {
    let mods_root = find_mods_root(&app);
    let mods_path = mods_root.join(&mod_type);
    Ok(mods_path.to_string_lossy().to_string())
}

/// List all mod directories for a given type (aircraft or towers)
#[tauri::command]
fn list_mod_directories(app: tauri::AppHandle, mod_type: String) -> Result<Vec<String>, String> {
    let mods_root = find_mods_root(&app);
    let mods_path = mods_root.join(&mod_type);

    if !mods_path.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&mods_path)
        .map_err(|e| format!("Failed to read mods directory: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    Ok(entries)
}

/// Read a mod manifest JSON file
#[tauri::command]
fn read_mod_manifest(path: String) -> Result<serde_json::Value, String> {
    let manifest_path = PathBuf::from(&path).join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest at {:?}: {}", manifest_path, e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse manifest JSON: {}", e))
}

/// List all VMR (Visual Model Rules) files in the mods directory
/// Scans both mods/ root and mods/aircraft/ for .vmr files
#[tauri::command]
fn list_vmr_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mods_root = find_mods_root(&app);

    let mut vmr_files = Vec::new();

    // Helper to scan a directory for .vmr files
    let scan_dir = |dir: &PathBuf, files: &mut Vec<String>| {
        if dir.exists() {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(ext) = path.extension() {
                            if ext.to_string_lossy().to_lowercase() == "vmr" {
                                files.push(path.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }
    };

    // Scan mods/ root
    scan_dir(&mods_root, &mut vmr_files);

    // Scan mods/aircraft/
    let aircraft_path = mods_root.join("aircraft");
    scan_dir(&aircraft_path, &mut vmr_files);

    // Sort for consistent load order
    vmr_files.sort();

    Ok(vmr_files)
}

/// Read custom tower positions from mods/tower-positions/*.json files
/// Each file is named {ICAO}.json (case-insensitive)
/// Also reads legacy mods/tower-positions.json for backward compatibility
/// Returns the merged JSON as a serde_json::Value
#[tauri::command]
fn read_tower_positions(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let mods_root = find_mods_root(&app);
    let mut positions: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

    // Read legacy tower-positions.json if it exists (lower priority)
    let legacy_path = mods_root.join("tower-positions.json");
    if legacy_path.exists() {
        if let Ok(content) = fs::read_to_string(&legacy_path) {
            if let Ok(legacy_positions) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content) {
                for (icao, pos) in legacy_positions {
                    positions.insert(icao.to_uppercase(), pos);
                }
            }
        }
    }

    // Read individual files from tower-positions/ folder (higher priority, overwrites legacy)
    let tower_positions_dir = mods_root.join("tower-positions");
    if tower_positions_dir.exists() && tower_positions_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&tower_positions_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("json")) {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(pos) = serde_json::from_str::<serde_json::Value>(&content) {
                                positions.insert(stem.to_uppercase(), pos);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(serde_json::Value::Object(positions))
}

/// 3D view position settings for tower-positions
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View3dPosition {
    pub lat: f64,
    pub lon: f64,
    pub agl_height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    /// Fine-tuning offset in meters (north positive)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat_offset_meters: Option<f64>,
    /// Fine-tuning offset in meters (east positive)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon_offset_meters: Option<f64>,
}

/// 2D topdown view position settings for tower-positions
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View2dPosition {
    /// Altitude above ground in meters (controls zoom level, 500-50000m)
    pub altitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f64>,
    /// Fine-tuning offset in meters (north positive)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat_offset_meters: Option<f64>,
    /// Fine-tuning offset in meters (east positive)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon_offset_meters: Option<f64>,
}

/// Tower position entry with separate 3D and 2D view settings
/// Both views are optional - if only one is provided, the other uses defaults
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerPositionEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_3d: Option<View3dPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_2d: Option<View2dPosition>,
}

/// Update a single tower position in mods/tower-positions/{ICAO}.json
/// Creates the directory and file if they don't exist
#[tauri::command]
fn update_tower_position(
    app: tauri::AppHandle,
    icao: String,
    position: TowerPositionEntry,
) -> Result<(), String> {
    let mods_root = find_mods_root(&app);
    let tower_positions_dir = mods_root.join("tower-positions");

    // Create tower-positions directory if it doesn't exist
    fs::create_dir_all(&tower_positions_dir)
        .map_err(|e| format!("Failed to create tower-positions directory: {}", e))?;

    // Write to individual file named {ICAO}.json
    let file_path = tower_positions_dir.join(format!("{}.json", icao.to_uppercase()));

    // If file exists, merge with existing data (preserve other view if only updating one)
    let mut entry = if file_path.exists() {
        let content = fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read existing position file: {}", e))?;
        serde_json::from_str::<TowerPositionEntry>(&content).unwrap_or(TowerPositionEntry {
            view_3d: None,
            view_2d: None,
        })
    } else {
        TowerPositionEntry {
            view_3d: None,
            view_2d: None,
        }
    };

    // Update only the views that are provided
    if position.view_3d.is_some() {
        entry.view_3d = position.view_3d;
    }
    if position.view_2d.is_some() {
        entry.view_2d = position.view_2d;
    }

    // Write to file with pretty formatting
    let output = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("Failed to serialize position: {}", e))?;
    fs::write(&file_path, output)
        .map_err(|e| format!("Failed to write position file: {}", e))?;

    Ok(())
}

// =============================================================================
// GLOBAL SETTINGS (shared across all browsers/devices)
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

/// Airport configuration within global settings
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalAirportSettings {
    pub default_icao: String,
    #[serde(default)]
    pub recent_airports: Vec<String>,
}

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

fn default_data_source() -> String {
    "vatsim".to_string()
}

fn default_radius_nm() -> u32 {
    100
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

fn default_msfs_priority() -> Vec<String> {
    vec!["fsltl".to_string(), "aig".to_string()]
}

fn default_cache_limit() -> Option<u32> {
    Some(5120) // 5GB default
}

fn default_texture_scale() -> String {
    "1k".to_string()
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

/// Get the path to the global settings file
fn get_global_settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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
fn get_global_settings_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = get_global_settings_file(&app)?;
    Ok(normalize_path_string(&path))
}

/// Read global settings from disk
/// Returns default settings if file doesn't exist
#[tauri::command]
fn read_global_settings(app: tauri::AppHandle) -> Result<GlobalSettings, String> {
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
fn write_global_settings(app: tauri::AppHandle, settings: GlobalSettings) -> Result<(), String> {
    let settings_file = get_global_settings_file(&app)?;

    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize global settings: {}", e))?;

    fs::write(&settings_file, content)
        .map_err(|e| format!("Failed to write global settings: {}", e))?;

    println!("[Settings] Global settings saved to {:?}", settings_file);
    Ok(())
}

// =============================================================================
// HTTP SERVER FOR REMOTE BROWSER ACCESS
// =============================================================================

/// Server status info
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub local_url: Option<String>,
    pub lan_url: Option<String>,
}

/// Get the LAN IP address for display
fn get_lan_ip() -> Option<String> {
    // Try to get the local IP address
    #[cfg(windows)]
    {
        use std::process::Command;
        // Use hostname command to get IP
        if let Ok(output) = Command::new("hostname")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
        {
            let hostname = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Try to resolve hostname to IP
            use std::net::ToSocketAddrs;
            if let Ok(mut addrs) = format!("{}:0", hostname).to_socket_addrs() {
                while let Some(addr) = addrs.next() {
                    if let std::net::SocketAddr::V4(v4) = addr {
                        let ip = v4.ip().to_string();
                        if !ip.starts_with("127.") {
                            return Some(ip);
                        }
                    }
                }
            }
        }
    }

    // Fallback: try to connect to a public DNS and get the local address
    use std::net::UdpSocket;
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return Some(addr.ip().to_string());
            }
        }
    }

    None
}

/// Start the HTTP server for remote browser access
#[tauri::command]
async fn start_http_server(app: tauri::AppHandle, port: u16) -> Result<ServerStatus, String> {
    // Check if server is already running
    {
        let guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("Server is already running".to_string());
        }
    }

    // Start the server
    let handles = server::start_server(app, port).await?;

    // Store the shutdown channel, vNAS sender, and port
    {
        let mut guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;
        *guard = Some(handles.shutdown_tx);
    }
    {
        let mut vnas_guard = VNAS_WEBSOCKET_TX.lock().map_err(|e| e.to_string())?;
        *vnas_guard = Some(handles.vnas_tx);
    }
    {
        let mut port_guard = HTTP_SERVER_PORT.lock().map_err(|e| e.to_string())?;
        *port_guard = Some(port);
    }

    let lan_ip = get_lan_ip();
    Ok(ServerStatus {
        running: true,
        port,
        local_url: Some(format!("http://localhost:{}", port)),
        lan_url: lan_ip.map(|ip| format!("http://{}:{}", ip, port)),
    })
}

/// Broadcast vNAS aircraft updates to WebSocket clients (for remote browser access)
/// This is called from the vNAS event loop when aircraft updates are received
pub fn broadcast_vnas_to_websocket(updates: Vec<server::VnasAircraftBroadcast>) {
    if let Ok(guard) = VNAS_WEBSOCKET_TX.lock() {
        if let Some(ref tx) = *guard {
            let _ = tx.send(updates);
        }
    }
}

/// Stop the HTTP server
#[tauri::command]
fn stop_http_server() -> Result<(), String> {
    let mut guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;

    if let Some(shutdown_tx) = guard.take() {
        let _ = shutdown_tx.send(());
        // Clear the stored port
        if let Ok(mut port_guard) = HTTP_SERVER_PORT.lock() {
            *port_guard = None;
        }
        println!("[Server] Shutdown signal sent");
        Ok(())
    } else {
        Err("Server is not running".to_string())
    }
}

/// Get the current HTTP server status
#[tauri::command]
fn get_http_server_status() -> ServerStatus {
    let is_running = HTTP_SERVER_SHUTDOWN
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);

    // Get the actual running port (or default if not stored)
    let port = HTTP_SERVER_PORT
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .unwrap_or(8765);

    if is_running {
        let lan_ip = get_lan_ip();
        ServerStatus {
            running: true,
            port,
            local_url: Some(format!("http://localhost:{}", port)),
            lan_url: lan_ip.map(|ip| format!("http://{}:{}", ip, port)),
        }
    } else {
        ServerStatus {
            running: false,
            port,
            local_url: None,
            lan_url: None,
        }
    }
}

// =============================================================================
// URL FETCHING (CORS bypass)
// =============================================================================

/// Fetch a URL and return the response as text (bypasses CORS)
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

// =============================================================================
// REALTRAFFIC API (CORS bypass for RealTraffic)
// =============================================================================

const REALTRAFFIC_API_URL: &str = "https://rtwa.flyrealtraffic.com/v5";

/// RealTraffic authentication request/response
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficAuthResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_pro: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic_rate_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather_rate_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Authenticate with RealTraffic API
#[tauri::command]
async fn realtraffic_auth(license_key: String) -> Result<RealTrafficAuthResult, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("license", license_key.as_str());
    form_data.insert("software", "TowerCab3D");

    let response = client
        .post(format!("{}/auth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic auth request failed: {}", e))?;

    // Read response as text first for better error messages
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))?;

    // Parse as JSON
    let data: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse RealTraffic JSON: {} - Response was: {}", e, response_text))?;

    // Check API status code (200 = success)
    let status = data.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
    if status != 200 {
        let message = data.get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Authentication failed");
        return Ok(RealTrafficAuthResult {
            success: false,
            guid: None,
            is_pro: None,
            traffic_rate_limit: None,
            weather_rate_limit: None,
            error: Some(message.to_string()),
        });
    }

    // type 0 = Standard, type 2 = Pro
    let license_type = data.get("type").and_then(|v| v.as_i64()).unwrap_or(0);
    let is_pro = license_type == 2;

    Ok(RealTrafficAuthResult {
        success: true,
        guid: data.get("GUID").and_then(|v| v.as_str()).map(|s| s.to_string()),
        is_pro: Some(is_pro),
        traffic_rate_limit: data.get("rrl").and_then(|v| v.as_u64()).map(|n| n as u32),
        weather_rate_limit: data.get("wrrl").and_then(|v| v.as_u64()).map(|n| n as u32),
        error: None,
    })
}

/// RealTraffic traffic request parameters
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficTrafficParams {
    pub guid: String,
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
    #[serde(default)]
    pub time_offset: Option<i32>,
}

/// Fetch traffic data from RealTraffic API
#[tauri::command]
async fn realtraffic_traffic(params: RealTrafficTrafficParams) -> Result<String, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype, top/bottom/left/right for bbox
    let mut form_data: Vec<(&str, String)> = vec![
        ("GUID", params.guid.clone()),
        ("querytype", "locationtraffic".to_string()),
        ("top", params.lat_max.to_string()),
        ("bottom", params.lat_min.to_string()),
        ("left", params.lon_min.to_string()),
        ("right", params.lon_max.to_string()),
    ];

    if let Some(toffset) = params.time_offset {
        form_data.push(("toffset", toffset.to_string()));
    }

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic traffic request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))
}

/// RealTraffic parked traffic request parameters
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficParkedParams {
    pub guid: String,
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
}

/// Fetch parked aircraft data from RealTraffic API
/// Returns aircraft with zero groundspeed that haven't moved for 10min-24h
#[tauri::command]
async fn realtraffic_parked_traffic(params: RealTrafficParkedParams) -> Result<String, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype, top/bottom/left/right for bbox
    let form_data: Vec<(&str, String)> = vec![
        ("GUID", params.guid.clone()),
        ("querytype", "parkedtraffic".to_string()),
        ("top", params.lat_max.to_string()),
        ("bottom", params.lat_min.to_string()),
        ("left", params.lon_min.to_string()),
        ("right", params.lon_max.to_string()),
    ];

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic parked traffic request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))
}

/// Deauthenticate from RealTraffic API
/// Releases the session on the server, allowing immediate reconnection
#[tauri::command]
async fn realtraffic_deauth(guid: String) -> Result<(), String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("GUID", guid.as_str());

    let response = client
        .post(format!("{}/deauth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic deauth request failed: {}", e))?;

    // Read response for logging purposes
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))?;

    // Parse to check status (optional - deauth is fire-and-forget)
    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&response_text) {
        let status = data.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
        if status == 200 {
            println!("[RealTraffic] Deauth successful");
        } else {
            println!("[RealTraffic] Deauth returned status {}: {}", status, response_text);
        }
    }

    Ok(())
}

// =============================================================================
// FSLTL (FS Live Traffic Liveries) COMMANDS
// =============================================================================

/// FSLTL converted model info
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FSLTLConvertedModel {
    pub model_name: String,
    pub model_path: String,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
    pub texture_size: String,
    pub has_animations: bool,
    pub file_size: u64,
    pub converted_at: u64,
}

/// FSLTL conversion progress status
#[derive(Debug, Serialize, Deserialize)]
pub struct FSLTLProgress {
    pub status: String,         // "idle" | "scanning" | "converting" | "complete" | "error"
    pub total: u32,
    pub completed: u32,
    pub current: Option<String>,
    pub errors: Vec<String>,
    #[serde(default)]
    pub converted: Vec<FSLTLConvertedModel>,
}

/// Pick a folder using native dialog
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog()
        .file()
        .blocking_pick_folder();

    match folder {
        Some(file_path) => Ok(Some(file_path.to_string())),
        None => Ok(None),
    }
}

/// Pick one or more files with optional extension filter
#[tauri::command]
async fn pick_files(app: tauri::AppHandle, filter_name: Option<String>, extensions: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let mut dialog = app.dialog().file();

    // Add file filter if provided
    if let (Some(name), Some(exts)) = (&filter_name, &extensions) {
        let ext_strs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        dialog = dialog.add_filter(name, &ext_strs);
    }

    let files = dialog.blocking_pick_files();

    match files {
        Some(paths) => Ok(paths.iter().map(|p| p.to_string()).collect()),
        None => Ok(vec![]),
    }
}

/// Read a text file from disk
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file {}: {}", path, e))
}

/// Load and parse a model manifest.json file from a model directory
/// Returns the manifest JSON or null if file doesn't exist
#[tauri::command]
fn load_model_manifest(model_path: String) -> Result<Option<serde_json::Value>, String> {
    let manifest_file = PathBuf::from(&model_path).join("manifest.json");

    if !manifest_file.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&manifest_file)
        .map_err(|e| format!("Failed to read manifest at {:?}: {}", manifest_file, e))?;

    serde_json::from_str(&content)
        .map(Some)
        .map_err(|e| format!("Failed to parse manifest JSON: {}", e))
}

/// Write a text file to disk
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write file {}: {}", path, e))
}

/// List all VMR files in a specific directory (non-recursive)
/// Unlike list_vmr_files which scans the mods directory, this scans an arbitrary path
/// Returns absolute paths to all .vmr files found
#[tauri::command]
fn list_vmr_files_in_dir(directory: String) -> Result<Vec<String>, String> {
    let dir_path = PathBuf::from(&directory);
    if !dir_path.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory {}: {}", directory, e))?;

    let mut vmr_files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.eq_ignore_ascii_case("vmr") {
                    vmr_files.push(normalize_path_string(&path));
                }
            }
        }
    }

    // Sort for consistent ordering
    vmr_files.sort();
    Ok(vmr_files)
}

/// Info about a cached GLB model file
#[derive(Debug, Serialize)]
struct CachedGlbInfo {
    /// Full path to the GLB file
    path: String,
    /// Model key extracted from filename (e.g., "fsltl_FSLTL_FAIB_B738_American")
    model_key: String,
    /// File size in bytes
    file_size: u64,
}

/// Scan cache directory for existing GLB files
/// Returns info about each cached model for loading into memory cache
#[tauri::command]
fn scan_cache_directory(cache_dir: String) -> Result<Vec<CachedGlbInfo>, String> {
    let dir_path = PathBuf::from(&cache_dir);
    if !dir_path.exists() {
        return Ok(vec![]);
    }

    let entries = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read cache directory {}: {}", cache_dir, e))?;

    let mut cached_models = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.eq_ignore_ascii_case("glb") {
                    // Extract model key from filename (remove .glb extension)
                    if let Some(stem) = path.file_stem() {
                        let model_key = stem.to_string_lossy().to_string();
                        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        cached_models.push(CachedGlbInfo {
                            path: normalize_path_string(&path),
                            model_key,
                            file_size,
                        });
                    }
                }
            }
        }
    }

    Ok(cached_models)
}

/// Check if a directory path is writable
fn is_path_writable(path: &PathBuf) -> bool {
    // Try to create a test file
    let test_file = path.join(".write_test");
    match fs::write(&test_file, "test") {
        Ok(_) => {
            let _ = fs::remove_file(&test_file);
            true
        }
        Err(_) => false
    }
}

/// Normalize path string by removing Windows extended path prefix (\\?\)
fn normalize_path_string(path: &PathBuf) -> String {
    let s = path.to_string_lossy().to_string();
    // Remove \\?\ prefix that Windows uses for long paths
    if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s
    }
}

/// Get smart default output path for FSLTL models
/// Returns (default_path, is_writable)
#[tauri::command]
fn get_fsltl_default_output_path(app: tauri::AppHandle) -> Result<(String, bool), String> {
    let mods_root = find_mods_root(&app);
    let mods_path = mods_root.join("aircraft").join("fsltl");

    // Try to create and check if mods path is writable
    if let Ok(_) = fs::create_dir_all(&mods_path) {
        if is_path_writable(&mods_path) {
            return Ok((normalize_path_string(&mods_path), true));
        }
    }

    // Fall back to APPDATA
    let appdata_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("fsltl_models");

    fs::create_dir_all(&appdata_path)
        .map_err(|e| format!("Failed to create APPDATA FSLTL directory: {}", e))?;

    Ok((normalize_path_string(&appdata_path), true))
}

/// Get the FSLTL models output path (legacy - always returns mods path)
#[tauri::command]
fn get_fsltl_output_path(app: tauri::AppHandle) -> Result<String, String> {
    let (path, _) = get_fsltl_default_output_path(app)?;
    Ok(path)
}

/// Check if FSLTL source path is valid (contains FSLTL_Rules.vmr)
#[tauri::command]
fn validate_fsltl_source(source_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&source_path);
    let vmr_path = path.join("FSLTL_Rules.vmr");
    let airplanes_path = path.join("SimObjects").join("Airplanes");

    Ok(vmr_path.exists() && airplanes_path.exists())
}

/// List available aircraft folders in FSLTL source
#[tauri::command]
fn list_fsltl_aircraft(source_path: String) -> Result<Vec<String>, String> {
    let airplanes_path = PathBuf::from(&source_path)
        .join("SimObjects")
        .join("Airplanes");

    if !airplanes_path.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&airplanes_path)
        .map_err(|e| format!("Failed to read airplanes directory: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            // Only include FSLTL folders (start with FSLTL_)
            if name.starts_with("FSLTL_") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

/// Get the bundled converter executable path
#[tauri::command]
fn get_converter_path(app: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    // In dev mode, CARGO_MANIFEST_DIR points to src-tauri/
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fsltl_converter.exe");

    let possible_paths = [
        // Production: bundled resources preserve directory structure
        resource_path.join("resources").join("fsltl_converter.exe"),
        // Dev mode: relative to src-tauri/
        dev_path,
    ];

    possible_paths
        .iter()
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Converter executable not found".to_string())
}

/// Start FSLTL conversion process in background
#[tauri::command]
fn start_fsltl_conversion(
    app: tauri::AppHandle,
    source_path: String,
    output_path: String,
    texture_scale: String,
    models: Vec<String>,
    progress_file: String,
) -> Result<(), String> {
    // Try multiple locations for the converter:
    // 1. Resource directory (production build - bundled resources preserve directory structure)
    // 2. src-tauri/resources (dev mode)
    // 3. Fallback paths
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    // In dev mode, CARGO_MANIFEST_DIR points to src-tauri/
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fsltl_converter.exe");

    let possible_paths = [
        // Production: bundled resources preserve directory structure
        resource_path.join("resources").join("fsltl_converter.exe"),
        // Dev mode: relative to src-tauri/
        dev_path,
        // Fallback paths
        PathBuf::from("src-tauri/resources/fsltl_converter.exe"),
        PathBuf::from("fsltl_converter.exe"),
    ];

    let converter_path = possible_paths
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| {
            format!(
                "Converter executable not found. Tried: {:?}. Run 'npm run build:converter' first.",
                possible_paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
            )
        })?
        .clone();

    // Build command arguments
    let mut cmd = Command::new(&converter_path);
    cmd.args([
        "--source", &source_path,
        "--output", &output_path,
        "--texture-scale", &texture_scale,
        "--progress-file", &progress_file,
    ]);

    // Only pass --models if specific models are requested (not "convert all")
    // If models list is empty, converter will auto-discover all FSLTL models
    if !models.is_empty() {
        // Write models to a temp file to avoid command line length limits
        let models_file = PathBuf::from(&output_path).join("_models_list.txt");
        fs::write(&models_file, models.join("\n"))
            .map_err(|e| format!("Failed to write models list: {}", e))?;
        cmd.args(["--models-file", &models_file.to_string_lossy()]);
    }

    // Hide console window on Windows (CREATE_NO_WINDOW = 0x08000000)
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    // Kill any existing converter process first
    if let Ok(mut guard) = FSLTL_CONVERTER_PROCESS.lock() {
        if let Some(proc) = guard.take() {
            drop(proc); // Drop closes the job handle, killing all processes
        }
    }

    // Start the new process
    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start converter: {}", e))?;

    // On Windows, create a job object and assign the process to it
    // This ensures all child processes (gltf-transform, etc.) are killed together
    #[cfg(windows)]
    let process_with_job = {
        let job_handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job_handle.is_null() {
            return Err("Failed to create job object".to_string());
        }

        // Configure job to kill all processes when the job handle is closed
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let success = unsafe {
            SetInformationJobObject(
                job_handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if success == 0 {
            unsafe { CloseHandle(job_handle) };
            return Err("Failed to configure job object".to_string());
        }

        // Assign the process to the job
        let process_handle = child.as_raw_handle();
        let success = unsafe { AssignProcessToJobObject(job_handle, process_handle) };

        if success == 0 {
            unsafe { CloseHandle(job_handle) };
            return Err("Failed to assign process to job object".to_string());
        }

        ProcessWithJob { child, job_handle: SendableHandle(job_handle) }
    };

    #[cfg(not(windows))]
    let process_with_job = ProcessWithJob { child };

    if let Ok(mut guard) = FSLTL_CONVERTER_PROCESS.lock() {
        *guard = Some(process_with_job);
    }

    Ok(())
}

/// Cancel the running FSLTL conversion process
/// On Windows, closes the job object which terminates all child processes
#[tauri::command]
fn cancel_fsltl_conversion() -> Result<(), String> {
    if let Ok(mut guard) = FSLTL_CONVERTER_PROCESS.lock() {
        if let Some(mut proc) = guard.take() {
            let pid = proc.child.id();

            // Close job handle FIRST to kill all processes in the job
            // The JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag terminates all processes
            // when the handle is closed
            #[cfg(windows)]
            {
                if !proc.job_handle.0.is_null() {
                    unsafe { CloseHandle(proc.job_handle.0) };
                    proc.job_handle.0 = std::ptr::null_mut(); // Prevent double-close in Drop
                }
            }

            // On non-Windows, explicitly kill the parent process
            #[cfg(not(windows))]
            {
                let _ = proc.child.kill();
            }

            // Now wait for the child process to fully exit (should be quick since we killed it)
            let _ = proc.child.wait();

            println!("[FSLTL] Converter process tree terminated (PID {})", pid);
            return Ok(());
        }
    }
    Err("No conversion process running".to_string())
}

/// Read conversion progress from JSON file
#[tauri::command]
fn read_conversion_progress(progress_file: String) -> Result<FSLTLProgress, String> {
    let content = fs::read_to_string(&progress_file)
        .map_err(|e| format!("Failed to read progress file: {}", e))?;

    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse progress JSON: {}", e))
}

/// Check if a model GLB file exists in the output directory
#[tauri::command]
fn check_fsltl_model_exists(output_path: String, model_name: String) -> Result<bool, String> {
    // FSLTL models are stored as: output_path/TYPE/AIRLINE/model.glb or output_path/TYPE/base/model.glb
    // For now, check if any matching GLB exists
    let path = PathBuf::from(&output_path);

    // Extract type and airline from model name (e.g., FSLTL_B738_AAL -> B738, AAL)
    let parts: Vec<&str> = model_name.split('_').collect();
    if parts.len() >= 2 {
        let type_code = parts.get(1).unwrap_or(&"");
        let airline_code = parts.get(2);

        let model_path = if let Some(airline) = airline_code {
            path.join(type_code).join(airline).join("model.glb")
        } else {
            path.join(type_code).join("base").join("model.glb")
        };

        Ok(model_path.exists())
    } else {
        Ok(false)
    }
}

/// Delete a file from disk
#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete file {}: {}", path, e))
}

/// Scanned model info from existing FSLTL output directory
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFSLTLModel {
    pub model_name: String,
    pub model_path: String,
    /// Relative path usable with /api/fsltl/* endpoint (e.g., "B738/AAL/model.glb")
    pub relative_path: String,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
    pub has_animations: bool,
    pub file_size: u64,
}

// =============================================================================
// MSFS MODEL CONVERSION (On-the-fly conversion for FSLTL and AIG)
// =============================================================================

/// Result of detecting MSFS model installations
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MSFSDetectionResult {
    pub fsltl_found: bool,
    pub fsltl_path: Option<String>,
    pub fsltl_model_count: Option<u32>,
    pub aig_found: bool,
    pub aig_path: Option<String>,
    pub aig_model_count: Option<u32>,
}

/// Source model info for conversion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceModelInfo {
    pub source: String,         // "fsltl" or "aig"
    pub model_name: String,     // Display name (from aircraft.cfg title)
    pub folder_name: String,    // Actual folder name (e.g., "FSLTL_A320_BAW_IAE")
    pub gltf_path: String,
    pub texture_dirs: Vec<String>,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
}

/// Detect FSLTL and AIG installations in Community folder
#[tauri::command]
fn detect_msfs_installations(community_path: String) -> Result<MSFSDetectionResult, String> {
    let base = PathBuf::from(&community_path);

    if !base.exists() {
        return Err(format!("Community folder does not exist: {}", community_path));
    }

    let mut result = MSFSDetectionResult {
        fsltl_found: false,
        fsltl_path: None,
        fsltl_model_count: None,
        aig_found: false,
        aig_path: None,
        aig_model_count: None,
    };

    // Check for FSLTL (fsltl-traffic-base folder with FSLTL_Rules.vmr)
    let fsltl_path = base.join("fsltl-traffic-base");
    if fsltl_path.exists() && fsltl_path.join("FSLTL_Rules.vmr").exists() {
        result.fsltl_found = true;
        result.fsltl_path = Some(normalize_path_string(&fsltl_path));
        // Don't count here - actual count comes from list_fsltl_models
    }

    // Check for AIG (aig-aitraffic-oci folder)
    let aig_path = base.join("aig-aitraffic-oci");
    if aig_path.exists() {
        let airplanes = aig_path.join("SimObjects").join("Airplanes");
        if airplanes.exists() {
            result.aig_found = true;
            result.aig_path = Some(normalize_path_string(&aig_path));
            // Don't count here - actual count comes from list_aig_models
        }
    }

    println!("[MSFSDetection] FSLTL: {} ({:?}), AIG: {} ({:?})",
        result.fsltl_found, result.fsltl_model_count,
        result.aig_found, result.aig_model_count);

    Ok(result)
}

/// Parse aircraft.cfg to extract the title field from first FLTSIM section
/// Returns the title from [FLTSIM.0] section, or None if not found
fn parse_aircraft_cfg_title(aircraft_dir: &std::path::Path) -> Option<String> {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return None;
    }

    let content = fs::read_to_string(&cfg_path).ok()?;

    // Look for title = "..." in the [FLTSIM.0] section
    let mut in_fltsim_section = false;
    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            in_fltsim_section = trimmed.to_uppercase().starts_with("[FLTSIM");
            continue;
        }

        // Look for title in FLTSIM section
        if in_fltsim_section && trimmed.to_lowercase().starts_with("title") {
            // Parse: title = "FSLTL_FAIB_B738_American" ; comment
            if let Some(eq_pos) = trimmed.find('=') {
                let value_part = trimmed[eq_pos + 1..].trim();
                // Remove quotes and everything after semicolon (comment)
                let value = value_part
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }

    None
}

/// Livery info from aircraft.cfg FLTSIM section
struct AircraftCfgLivery {
    title: String,
    texture_folder: String,
}

/// Parse all FLTSIM sections from aircraft.cfg
/// Returns list of (title, texture_folder) for each livery
fn parse_aircraft_cfg_all_liveries(aircraft_dir: &std::path::Path) -> Vec<AircraftCfgLivery> {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return Vec::new();
    }

    let content = match fs::read_to_string(&cfg_path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut liveries = Vec::new();
    let mut in_fltsim_section = false;
    let mut current_title: Option<String> = None;
    let mut current_texture: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            // Save previous livery if complete
            if in_fltsim_section {
                if let (Some(title), Some(texture)) = (current_title.take(), current_texture.take()) {
                    liveries.push(AircraftCfgLivery { title, texture_folder: texture });
                }
            }
            in_fltsim_section = trimmed.to_uppercase().starts_with("[FLTSIM");
            current_title = None;
            current_texture = None;
            continue;
        }

        if !in_fltsim_section {
            continue;
        }

        let lower = trimmed.to_lowercase();
        if lower.starts_with("title") {
            if let Some(eq_pos) = trimmed.find('=') {
                let value = trimmed[eq_pos + 1..]
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !value.is_empty() {
                    current_title = Some(value.to_string());
                }
            }
        } else if lower.starts_with("texture") && !lower.starts_with("texture.") {
            if let Some(eq_pos) = trimmed.find('=') {
                let value = trimmed[eq_pos + 1..]
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !value.is_empty() {
                    current_texture = Some(value.to_string());
                }
            }
        }
    }

    // Don't forget the last section
    if in_fltsim_section {
        if let (Some(title), Some(texture)) = (current_title, current_texture) {
            liveries.push(AircraftCfgLivery { title, texture_folder: texture });
        }
    }

    liveries
}

/// List available FSLTL models from source
#[tauri::command]
fn list_fsltl_models(base_path: String) -> Result<Vec<SourceModelInfo>, String> {
    let base = PathBuf::from(&base_path);
    let airplanes = base.join("SimObjects").join("Airplanes");

    if !airplanes.exists() {
        return Ok(Vec::new());
    }

    // FSLTL uses shared models: most livery folders (FSLTL_B738_AAL) reference a base model
    // (FSLTL_B738_ZZZZ). We need two passes:
    // 1. Find all base models with actual GLTF files
    // 2. Create entries for all livery folders, pointing to their base model's GLTF

    // Pass 1: Build index of base models (aircraft_type -> gltf_path)
    // Also track base model texture directories for shared textures (portholes, etc.)
    let mut base_models: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut base_textures: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();

    if let Ok(entries) = fs::read_dir(&airplanes) {
        for entry in entries.filter_map(|e| e.ok()) {
            let aircraft_dir = entry.path();
            if !aircraft_dir.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with("FSLTL_") {
                continue;
            }

            // Parse folder name: FSLTL_{TYPE}_{AIRLINE}
            let parts: Vec<&str> = folder_name.split('_').collect();
            if parts.len() < 2 {
                continue;
            }
            let aircraft_type = parts[1].to_string();

            // Find the model directory with GLTF
            let model_dirs: Vec<_> = fs::read_dir(&aircraft_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().is_dir() &&
                    e.file_name().to_string_lossy().to_lowercase().starts_with("model")
                })
                .collect();

            for model_dir_entry in model_dirs {
                let model_dir = model_dir_entry.path();

                // Find all GLTF files in this directory
                let gltf_files: Vec<_> = fs::read_dir(&model_dir)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path().extension()
                            .map(|ext| ext.to_string_lossy().to_lowercase() == "gltf")
                            .unwrap_or(false)
                    })
                    .collect();

                // Prefer exterior model: exclude cockpit/interior files, prefer LOD00/LOD04
                let exterior_gltf = gltf_files.iter()
                    .filter(|e| {
                        let name = e.file_name().to_string_lossy().to_lowercase();
                        !name.contains("cockpit") && !name.contains("interior")
                    })
                    .min_by_key(|e| {
                        // Prefer lower LOD numbers (higher detail)
                        let name = e.file_name().to_string_lossy().to_lowercase();
                        if name.contains("lod00") { 0 }
                        else if name.contains("lod01") { 1 }
                        else if name.contains("lod02") { 2 }
                        else if name.contains("lod03") { 3 }
                        else if name.contains("lod04") { 4 }
                        else { 5 }
                    });

                if let Some(gltf_file) = exterior_gltf {
                    // Found exterior GLTF - add to base models index
                    let gltf_path = normalize_path_string(&gltf_file.path());
                    base_models.entry(aircraft_type.clone()).or_insert(gltf_path);

                    // Also collect base texture directories for shared textures
                    // Base models (FSLTL_{TYPE} or FSLTL_{TYPE}_ZZZZ) have shared textures like portholes
                    let is_base_model = parts.len() == 2 || (parts.len() == 3 && parts[2] == "ZZZZ");
                    if is_base_model {
                        let texture_dirs: Vec<String> = fs::read_dir(&aircraft_dir)
                            .ok()
                            .into_iter()
                            .flatten()
                            .filter_map(|e| e.ok())
                            .filter(|e| {
                                e.path().is_dir() &&
                                e.file_name().to_string_lossy().to_lowercase().starts_with("texture")
                            })
                            .map(|e| normalize_path_string(&e.path()))
                            .collect();
                        if !texture_dirs.is_empty() {
                            base_textures.insert(aircraft_type.clone(), texture_dirs);
                        }
                    }
                    break;
                }
            }
        }
    }

    println!("[MSFSDetection] Found {} FSLTL base models with GLTF files", base_models.len());

    // Pass 2: Create entries for ALL livery folders
    let mut models = Vec::new();

    if let Ok(entries) = fs::read_dir(&airplanes) {
        for entry in entries.filter_map(|e| e.ok()) {
            let aircraft_dir = entry.path();
            if !aircraft_dir.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with("FSLTL_") {
                continue;
            }

            // Parse folder name: FSLTL_{TYPE}_{AIRLINE} or FSLTL_{TYPE}
            let parts: Vec<&str> = folder_name.split('_').collect();
            if parts.len() < 2 {
                continue;
            }

            let aircraft_type = parts[1].to_string();
            let airline_code = if parts.len() > 2 && parts[2] != "ZZZZ" {
                Some(parts[2..].join("_"))
            } else {
                None
            };

            // Find GLTF path - either in this folder or from base model
            let gltf_path = {
                // First try to find GLTF in this folder's model directory
                let model_dirs: Vec<_> = fs::read_dir(&aircraft_dir)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .filter(|e| {
                        e.path().is_dir() &&
                        e.file_name().to_string_lossy().to_lowercase().starts_with("model")
                    })
                    .collect();

                let mut found_gltf: Option<String> = None;
                for model_dir_entry in model_dirs {
                    let model_dir = model_dir_entry.path();
                    // Find all GLTF files in this directory
                    let gltf_files: Vec<_> = fs::read_dir(&model_dir)
                        .ok()
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e.ok())
                        .filter(|e| {
                            e.path().extension()
                                .map(|ext| ext.to_string_lossy().to_lowercase() == "gltf")
                                .unwrap_or(false)
                        })
                        .collect();

                    // Prefer exterior model: exclude cockpit/interior files, prefer LOD00/LOD04
                    let exterior_gltf = gltf_files.iter()
                        .filter(|e| {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            !name.contains("cockpit") && !name.contains("interior")
                        })
                        .min_by_key(|e| {
                            // Prefer lower LOD numbers (higher detail)
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            if name.contains("lod00") { 0 }
                            else if name.contains("lod01") { 1 }
                            else if name.contains("lod02") { 2 }
                            else if name.contains("lod03") { 3 }
                            else if name.contains("lod04") { 4 }
                            else { 5 }
                        });

                    if let Some(gltf_file) = exterior_gltf {
                        found_gltf = Some(normalize_path_string(&gltf_file.path()));
                        break;
                    }
                }

                // Fall back to base model if not found locally
                found_gltf.or_else(|| base_models.get(&aircraft_type).cloned())
            };

            // Skip if no GLTF found anywhere
            let gltf_path = match gltf_path {
                Some(p) => p,
                None => continue,
            };

            // Collect texture directories from this livery folder
            let mut texture_dirs: Vec<String> = fs::read_dir(&aircraft_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().is_dir() &&
                    e.file_name().to_string_lossy().to_lowercase().starts_with("texture")
                })
                .map(|e| normalize_path_string(&e.path()))
                .collect();

            // Also include base model texture directories for shared textures (portholes, etc.)
            // Base textures are searched AFTER livery textures, so livery-specific textures take priority
            if let Some(base_tex_dirs) = base_textures.get(&aircraft_type) {
                for base_dir in base_tex_dirs {
                    if !texture_dirs.contains(base_dir) {
                        texture_dirs.push(base_dir.clone());
                    }
                }
            }

            // Use title from aircraft.cfg as model_name (this matches VMR rules)
            // Fall back to folder name if title not found
            let model_name = parse_aircraft_cfg_title(&aircraft_dir)
                .unwrap_or_else(|| folder_name.clone());

            models.push(SourceModelInfo {
                source: "fsltl".to_string(),
                model_name,
                folder_name: folder_name.clone(),
                gltf_path,
                texture_dirs,
                aircraft_type: aircraft_type.clone(),
                airline_code,
            });
        }
    }

    println!("[MSFSDetection] Found {} FSLTL liveries", models.len());
    Ok(models)
}

/// List available AIG models from source
/// Uses aircraft.cfg titles as model names to match VMR rules
#[tauri::command]
fn list_aig_models(base_path: String) -> Result<Vec<SourceModelInfo>, String> {
    let base = PathBuf::from(&base_path);
    let airplanes = base.join("SimObjects").join("Airplanes");

    if !airplanes.exists() {
        return Ok(Vec::new());
    }

    let mut models = Vec::new();

    if let Ok(entries) = fs::read_dir(&airplanes) {
        for entry in entries.filter_map(|e| e.ok()) {
            let aircraft_dir = entry.path();
            if !aircraft_dir.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with("AIGAIM_") {
                continue;
            }

            // Parse folder name for aircraft type: AIGAIM_{SOURCE}_{TYPE} or AIGAIM_{SOURCE}_{TYPE}-{VARIANT}
            // Examples: AIGAIM_AIA_B737-MAX8, AIGAIM_ACAI_C525B_CitationJetCJ3
            let without_prefix = folder_name.strip_prefix("AIGAIM_").unwrap_or(&folder_name);
            // Skip the source prefix (AIA_, ACAI_, etc.) and extract type
            let parts: Vec<&str> = without_prefix.split('_').collect();
            let aircraft_type = if parts.len() >= 2 {
                // Take second part and extract type before any hyphen
                parts[1].split('-').next().unwrap_or(parts[1]).to_string()
            } else {
                without_prefix.split('-').next().unwrap_or(without_prefix).to_string()
            };

            // Find the model directory with GLTF
            let model_dirs: Vec<_> = fs::read_dir(&aircraft_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.path().is_dir() &&
                    e.file_name().to_string_lossy().to_lowercase().starts_with("model")
                })
                .collect();

            for model_dir_entry in model_dirs {
                let model_dir = model_dir_entry.path();

                // Find .gltf file
                if let Some(gltf_file) = fs::read_dir(&model_dir)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e.ok())
                    .find(|e| {
                        e.path().extension()
                            .map(|ext| ext.to_string_lossy().to_lowercase() == "gltf")
                            .unwrap_or(false)
                    })
                {
                    let gltf_path = normalize_path_string(&gltf_file.path());

                    // Collect shared texture directories (oci.* folders)
                    let shared_texture_dirs: Vec<String> = fs::read_dir(&aircraft_dir)
                        .ok()
                        .into_iter()
                        .flatten()
                        .filter_map(|e| e.ok())
                        .filter(|e| {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            e.path().is_dir() && name.starts_with("oci")
                        })
                        .map(|e| normalize_path_string(&e.path()))
                        .collect();

                    // Parse aircraft.cfg to get all liveries with their titles
                    let liveries = parse_aircraft_cfg_all_liveries(&aircraft_dir);

                    if !liveries.is_empty() {
                        // Create a model entry for each livery using the title from aircraft.cfg
                        for livery in liveries {
                            // Find the texture folder that matches this livery
                            let texture_folder_path = aircraft_dir.join(format!("texture.{}", livery.texture_folder));
                            let texture_folder_path_alt = aircraft_dir.join(format!("Texture.{}", livery.texture_folder));

                            let texture_path = if texture_folder_path.exists() {
                                Some(normalize_path_string(&texture_folder_path))
                            } else if texture_folder_path_alt.exists() {
                                Some(normalize_path_string(&texture_folder_path_alt))
                            } else {
                                None
                            };

                            // Build texture dirs: specific livery folder + shared oci folders
                            let mut texture_dirs: Vec<String> = Vec::new();
                            if let Some(tp) = texture_path {
                                texture_dirs.push(tp);
                            }
                            texture_dirs.extend(shared_texture_dirs.clone());

                            // Extract airline code from texture folder name for filtering
                            let airline_code = livery.texture_folder
                                .split('-')
                                .next()
                                .map(|s| s.to_uppercase())
                                .filter(|s| s.len() == 3); // Only 3-letter ICAO codes

                            models.push(SourceModelInfo {
                                source: "aig".to_string(),
                                model_name: livery.title.clone(),
                                folder_name: folder_name.clone(),
                                gltf_path: gltf_path.clone(),
                                texture_dirs,
                                aircraft_type: aircraft_type.clone(),
                                airline_code,
                            });
                        }
                    } else {
                        // Fallback: no aircraft.cfg or no liveries found
                        // Create entries for each texture.* folder using folder-based naming
                        let livery_folders: Vec<_> = fs::read_dir(&aircraft_dir)
                            .ok()
                            .into_iter()
                            .flatten()
                            .filter_map(|e| e.ok())
                            .filter(|e| {
                                let name = e.file_name().to_string_lossy().to_lowercase();
                                e.path().is_dir() && name.starts_with("texture.")
                            })
                            .collect();

                        for livery_entry in &livery_folders {
                            let livery_name = livery_entry.file_name().to_string_lossy().to_string();
                            let airline_code = livery_name
                                .strip_prefix("texture.")
                                .or_else(|| livery_name.strip_prefix("Texture."))
                                .map(|s| s.split('-').next().unwrap_or(s).to_uppercase())
                                .filter(|s| s.len() == 3);

                            let model_name = format!("{}_{}", folder_name,
                                livery_name.strip_prefix("texture.").or_else(|| livery_name.strip_prefix("Texture.")).unwrap_or(&livery_name));

                            let mut texture_dirs = vec![normalize_path_string(&livery_entry.path())];
                            texture_dirs.extend(shared_texture_dirs.clone());

                            models.push(SourceModelInfo {
                                source: "aig".to_string(),
                                model_name,
                                folder_name: folder_name.clone(),
                                gltf_path: gltf_path.clone(),
                                texture_dirs,
                                aircraft_type: aircraft_type.clone(),
                                airline_code,
                            });
                        }

                        // If no livery folders at all, create single entry
                        if livery_folders.is_empty() {
                            let all_texture_dirs: Vec<String> = fs::read_dir(&aircraft_dir)
                                .ok()
                                .into_iter()
                                .flatten()
                                .filter_map(|e| e.ok())
                                .filter(|e| {
                                    let name = e.file_name().to_string_lossy().to_lowercase();
                                    e.path().is_dir() &&
                                    (name.starts_with("texture") || name.starts_with("oci"))
                                })
                                .map(|e| normalize_path_string(&e.path()))
                                .collect();

                            models.push(SourceModelInfo {
                                source: "aig".to_string(),
                                model_name: folder_name.clone(),
                                folder_name: folder_name.clone(),
                                gltf_path: gltf_path.clone(),
                                texture_dirs: all_texture_dirs,
                                aircraft_type: aircraft_type.clone(),
                                airline_code: None,
                            });
                        }
                    }

                    break; // Only use first model folder
                }
            }
        }
    }

    println!("[MSFSDetection] Found {} AIG liveries", models.len());
    Ok(models)
}

/// Check if a file exists
#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// Get file size in bytes
#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to get file size: {}", e))
}

/// Delete a cache file
#[tauri::command]
fn delete_cache_file(path: String) -> Result<(), String> {
    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete cache file: {}", e))
}

/// Clear all files in a cache directory
#[tauri::command]
fn clear_cache_directory(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))? {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() && path.extension().map(|e| e == "glb").unwrap_or(false) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    println!("[MSFSCache] Cleared cache directory: {}", path);
    Ok(())
}

/// Result of a single model conversion
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MSFSConversionResult {
    pub success: bool,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// Convert a single MSFS model (FSLTL or AIG) to GLB format
/// This is used for on-the-fly conversion when an aircraft first appears
///
/// Arguments:
/// - source_path: Path to the traffic base folder (fsltl-traffic-base or AIG equivalent)
/// - folder_name: Model folder name (e.g., "FSLTL_A320_BAW_IAE")
/// - output_path: Where to write the converted GLB
/// - texture_scale: Texture scaling ("full", "2k", "1k", "512")
#[tauri::command]
async fn convert_msfs_model(
    app: tauri::AppHandle,
    source_path: String,
    folder_name: String,
    output_path: String,
    texture_scale: String,
) -> Result<MSFSConversionResult, String> {
    let start_time = std::time::Instant::now();

    // Find the converter executable
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/fsltl_converter.exe");

    let possible_paths = [
        resource_path.join("resources").join("fsltl_converter.exe"),
        dev_path,
        PathBuf::from("src-tauri/resources/fsltl_converter.exe"),
        PathBuf::from("fsltl_converter.exe"),
    ];

    let converter_path = possible_paths
        .iter()
        .find(|p| p.exists())
        .ok_or_else(|| {
            "Converter executable not found. Ensure fsltl_converter.exe is in resources/".to_string()
        })?
        .clone();

    // Create output directory if needed
    if let Some(parent) = PathBuf::from(&output_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {}", e))?;
    }

    // Build command arguments for single model conversion
    // --single mode uses the same texture resolution logic as batch mode
    let cmd = Command::new(&converter_path);
    let mut cmd = cmd;
    cmd.args([
        "--single",
        "--source", &source_path,
        "--model", &folder_name,
        "--output", &output_path,
        "--texture-scale", &texture_scale,
    ]);

    // Hide console window on Windows
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    // Execute and wait for completion
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute converter: {}", e))?;

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // Log command output for debugging
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stderr.is_empty() {
        println!("[MSFSConvert] stderr: {}", stderr);
    }
    if !stdout.is_empty() {
        println!("[MSFSConvert] stdout: {}", stdout);
    }

    if output.status.success() {
        // Verify output file exists
        if PathBuf::from(&output_path).exists() {
            println!("[MSFSConvert] Converted {} in {}ms -> {}",
                folder_name,
                duration_ms,
                output_path);
            Ok(MSFSConversionResult {
                success: true,
                output_path: Some(output_path),
                error: None,
                duration_ms,
            })
        } else {
            println!("[MSFSConvert] Output file not found: {}", output_path);
            Ok(MSFSConversionResult {
                success: false,
                output_path: None,
                error: Some(format!("Output file not found at: {}. Stderr: {}", output_path, stderr)),
                duration_ms,
            })
        }
    } else {
        let error_msg = if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else {
            format!("Conversion failed with exit code: {:?}", output.status.code())
        };

        println!("[MSFSConvert] Failed to convert {}: {}",
            folder_name,
            error_msg);

        Ok(MSFSConversionResult {
            success: false,
            output_path: None,
            error: Some(error_msg),
            duration_ms,
        })
    }
}

/// Scan an FSLTL output directory for existing converted models
/// Returns info about all model.glb files found
/// Directory structure: outputPath/TYPE/AIRLINE/model.glb or outputPath/TYPE/base/model.glb
#[tauri::command]
fn scan_fsltl_models(output_path: String) -> Result<Vec<ScannedFSLTLModel>, String> {
    let base_path = PathBuf::from(&output_path);

    if !base_path.exists() {
        return Ok(Vec::new());
    }

    let mut models = Vec::new();

    // Iterate through aircraft type directories (e.g., B738, A320)
    let type_dirs = fs::read_dir(&base_path)
        .map_err(|e| format!("Failed to read output directory: {}", e))?;

    for type_entry in type_dirs.filter_map(|e| e.ok()) {
        let type_path = type_entry.path();
        if !type_path.is_dir() {
            continue;
        }

        let aircraft_type = match type_entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };

        // Skip hidden/system directories
        if aircraft_type.starts_with('.') || aircraft_type.starts_with('_') {
            continue;
        }

        // Iterate through airline directories (e.g., UAL, SWA, base)
        let airline_dirs = match fs::read_dir(&type_path) {
            Ok(dirs) => dirs,
            Err(_) => continue,
        };

        for airline_entry in airline_dirs.filter_map(|e| e.ok()) {
            let airline_path = airline_entry.path();
            if !airline_path.is_dir() {
                continue;
            }

            let airline_folder = match airline_entry.file_name().into_string() {
                Ok(name) => name,
                Err(_) => continue,
            };

            // Check for model.glb
            let model_file = airline_path.join("model.glb");
            if !model_file.exists() {
                continue;
            }

            // Get file size
            let file_size = fs::metadata(&model_file)
                .map(|m| m.len())
                .unwrap_or(0);

            // Determine airline code (None if "base" folder)
            let airline_code = if airline_folder.to_lowercase() == "base" {
                None
            } else {
                Some(airline_folder.clone())
            };

            // Build model name like FSLTL_B738_AAL or FSLTL_B738_ZZZZ
            let model_name = if let Some(ref code) = airline_code {
                format!("FSLTL_{}_{}", aircraft_type, code)
            } else {
                format!("FSLTL_{}_ZZZZ", aircraft_type)
            };

            // Check for animations by reading manifest.json if it exists
            let has_animations = {
                let manifest_path = airline_path.join("manifest.json");
                if manifest_path.exists() {
                    if let Ok(content) = fs::read_to_string(&manifest_path) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                            json.get("hasAnimations")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false)
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                }
            };

            // Relative path for HTTP API access (e.g., "B738/AAL/model.glb")
            let relative_path = format!("{}/{}/model.glb", aircraft_type, airline_folder);

            models.push(ScannedFSLTLModel {
                model_name,
                model_path: normalize_path_string(&model_file),
                relative_path,
                aircraft_type: aircraft_type.clone(),
                airline_code,
                has_animations,
                file_size,
            });
        }
    }

    println!("[FSLTL] Scanned {} existing models from {}", models.len(), output_path);
    Ok(models)
}

/// Set WebView2 browser arguments for GPU optimization
fn set_webview2_args() {
    #[cfg(target_os = "windows")]
    {
        // GPU and rendering optimizations (same as Electron had)
        let args = [
            "--enable-gpu-rasterization",
            "--enable-zero-copy",
            "--ignore-gpu-blocklist",
            "--enable-webgl2-compute-context",
            "--force_high_performance_gpu",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--use-angle=gl",  // Use OpenGL instead of D3D11 for better shadow depth precision
        ].join(" ");

        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set WebView2 GPU flags before creating the window
    set_webview2_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Register updater plugin (desktop only)
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

            // Set window title with version from config
            if let Some(window) = app.get_webview_window("main") {
                let version = app.config().version.clone().unwrap_or_else(|| "dev".to_string());
                let title = format!("TowerCab 3D v{}", version);
                let _ = window.set_title(&title);
            }

            // Initialize vNAS state
            vnas::init_vnas_state(app.handle());

            // Auto-start HTTP server if enabled in global settings or via env var
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Check for TOWERCAB_AUTO_SERVER env var (used by npm run dev:server)
                let force_start = std::env::var("TOWERCAB_AUTO_SERVER").is_ok();

                // Load settings to get port (and check enabled flag if not force-starting)
                let (should_start, port) = if let Ok(settings_file) = get_global_settings_file(&app_handle) {
                    if settings_file.exists() {
                        if let Ok(content) = std::fs::read_to_string(&settings_file) {
                            if let Ok(settings) = serde_json::from_str::<GlobalSettings>(&content) {
                                (force_start || settings.server.enabled, settings.server.port)
                            } else {
                                (force_start, 8765) // Default port
                            }
                        } else {
                            (force_start, 8765)
                        }
                    } else {
                        (force_start, 8765)
                    }
                } else {
                    (force_start, 8765)
                };

                if should_start {
                    println!("[Server] Auto-starting HTTP server on port {}{}", port,
                        if force_start { " (via TOWERCAB_AUTO_SERVER)" } else { "" });
                    match server::start_server(app_handle.clone(), port).await {
                        Ok(handles) => {
                            if let Ok(mut guard) = HTTP_SERVER_SHUTDOWN.lock() {
                                *guard = Some(handles.shutdown_tx);
                            }
                            if let Ok(mut vnas_guard) = VNAS_WEBSOCKET_TX.lock() {
                                *vnas_guard = Some(handles.vnas_tx);
                            }
                            println!("[Server] Auto-started successfully");
                        }
                        Err(e) => {
                            eprintln!("[Server] Auto-start failed: {}", e);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|_window, event| {
            // Kill FSLTL converter process when app window is closed
            if let tauri::WindowEvent::Destroyed = event {
                if let Ok(mut guard) = FSLTL_CONVERTER_PROCESS.lock() {
                    // Taking and dropping the ProcessWithJob terminates all child processes:
                    // - Windows: closes job handle (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
                    // - Other: Drop impl calls child.kill()
                    let _ = guard.take();
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_mods_path,
            list_mod_directories,
            read_mod_manifest,
            list_vmr_files,
            list_vmr_files_in_dir,
            read_tower_positions,
            update_tower_position,
            // Global settings commands
            get_global_settings_path,
            read_global_settings,
            write_global_settings,
            // HTTP server commands
            start_http_server,
            stop_http_server,
            get_http_server_status,
            fetch_url,
            // RealTraffic commands
            realtraffic_auth,
            realtraffic_traffic,
            realtraffic_parked_traffic,
            realtraffic_deauth,
            // FSLTL commands
            pick_folder,
            pick_files,
            read_text_file,
            write_text_file,
            load_model_manifest,
            get_fsltl_output_path,
            get_fsltl_default_output_path,
            validate_fsltl_source,
            list_fsltl_aircraft,
            get_converter_path,
            start_fsltl_conversion,
            cancel_fsltl_conversion,
            read_conversion_progress,
            check_fsltl_model_exists,
            delete_file,
            scan_fsltl_models,
            // MSFS model conversion commands
            detect_msfs_installations,
            list_fsltl_models,
            list_aig_models,
            convert_msfs_model,
            file_exists,
            get_file_size,
            delete_cache_file,
            clear_cache_directory,
            scan_cache_directory,
            // vNAS commands
            vnas::vnas_get_status,
            vnas::vnas_is_available,
            vnas::vnas_start_auth,
            vnas::vnas_complete_auth,
            vnas::vnas_handle_oauth_callback,
            vnas::vnas_connect,
            vnas::vnas_subscribe,
            vnas::vnas_disconnect,
            vnas::vnas_is_connected,
            vnas::vnas_is_authenticated,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
