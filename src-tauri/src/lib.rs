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

/// Global settings stored on host file system (shared across all browsers)
/// These settings are persisted to global-settings.json in the app data directory
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    pub cesium_ion_token: String,
    pub fsltl: GlobalFsltlSettings,
    pub airports: GlobalAirportSettings,
    pub server: GlobalServerSettings,
    #[serde(default)]
    pub viewports: GlobalViewportSettings,
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
            airports: GlobalAirportSettings {
                default_icao: String::new(),
                recent_airports: Vec::new(),
            },
            server: GlobalServerSettings {
                port: 8765,
                enabled: false,
            },
            viewports: GlobalViewportSettings::default(),
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
    let shutdown_tx = server::start_server(app, port).await?;

    // Store the shutdown channel
    {
        let mut guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;
        *guard = Some(shutdown_tx);
    }

    let lan_ip = get_lan_ip();
    Ok(ServerStatus {
        running: true,
        port,
        local_url: Some(format!("http://localhost:{}", port)),
        lan_url: lan_ip.map(|ip| format!("http://{}:{}", ip, port)),
    })
}

/// Stop the HTTP server
#[tauri::command]
fn stop_http_server() -> Result<(), String> {
    let mut guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;

    if let Some(shutdown_tx) = guard.take() {
        let _ = shutdown_tx.send(());
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

    if is_running {
        let lan_ip = get_lan_ip();
        ServerStatus {
            running: true,
            port: 8765, // Default port - TODO: read from settings
            local_url: Some("http://localhost:8765".to_string()),
            lan_url: lan_ip.map(|ip| format!("http://{}:8765", ip)),
        }
    } else {
        ServerStatus {
            running: false,
            port: 8765,
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
                        Ok(shutdown_tx) => {
                            if let Ok(mut guard) = HTTP_SERVER_SHUTDOWN.lock() {
                                *guard = Some(shutdown_tx);
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
            // FSLTL commands
            pick_folder,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
