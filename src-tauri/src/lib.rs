//! TowerCab 3D - Tauri backend
//!
//! This is the main entry point for the Tauri application.
//! Core functionality is organized into modules:
//!
//! - `mods`: Mod system (aircraft/tower models, tower positions)
//! - `settings`: Global settings persistence
//! - `realtraffic`: RealTraffic API integration
//! - `vmr`: VMR file parsing and caching
//! - `msfs`: MSFS model detection, listing, and conversion
//! - `files`: File utilities and dialogs
//! - `server`: HTTP server for remote browser access
//! - `vnas`: vNAS WebSocket/UDP integration

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::Serialize;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tokio::sync::broadcast;

// Module declarations
pub mod files;
pub mod mods;
pub mod msfs;
pub mod realtraffic;
mod server;
pub mod settings;
pub mod vmr;
mod vnas;

// Re-export types used by other modules and server
pub use msfs::SourceModelInfo;
pub use settings::GlobalSettings;

#[cfg(windows)]
use windows_sys::Win32::Foundation::CloseHandle;
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

// =============================================================================
// PROCESS MANAGEMENT (for FSLTL converter)
// =============================================================================

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

// =============================================================================
// GLOBAL STATE
// =============================================================================

// Global storage for the FSLTL converter process so we can cancel it
static FSLTL_CONVERTER_PROCESS: Mutex<Option<ProcessWithJob>> = Mutex::new(None);

// Global storage for the HTTP server shutdown channel
static HTTP_SERVER_SHUTDOWN: Mutex<Option<broadcast::Sender<()>>> = Mutex::new(None);

// Global log file path (set from TOWERCAB_LOG_FILE env var)
static LOG_FILE_PATH: Mutex<Option<String>> = Mutex::new(None);

// Whether to minimize to system tray instead of quitting (when HTTP server is running)
static MINIMIZE_TO_TRAY: Mutex<bool> = Mutex::new(false);

// =============================================================================
// UNIFIED LOGGING (tracing-based)
// =============================================================================

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

// Keep the non-blocking writer guard alive for the lifetime of the app
static LOG_GUARD: Mutex<Option<WorkerGuard>> = Mutex::new(None);

/// Initialize tracing subscriber with optional file logging.
/// If TOWERCAB_LOG_FILE env var is set, logs go to both stdout and the file.
fn init_logging() {
    // In release builds, disable logs from the private vNAS crate to keep implementation private.
    // In debug builds, enable debug logging for both the main app and vNAS crate.
    #[cfg(debug_assertions)]
    let default_filter = "info,towercab_3d=debug,towercab_3d_vnas=debug";
    #[cfg(not(debug_assertions))]
    let default_filter = "info,towercab_3d=debug,towercab_3d_vnas=off";

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_filter));

    if let Ok(path) = std::env::var("TOWERCAB_LOG_FILE") {
        // Create parent directories if needed
        if let Some(parent) = std::path::Path::new(&path).parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Store path for frontend logging
        *LOG_FILE_PATH.lock().unwrap() = Some(path.clone());

        // Create file appender
        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path);

        match file {
            Ok(file) => {
                // Non-blocking writer for the file
                let (non_blocking, guard) = tracing_appender::non_blocking(file);
                *LOG_GUARD.lock().unwrap() = Some(guard);

                // Create layers for both stdout and file
                let stdout_layer = fmt::layer()
                    .with_target(true)
                    .with_thread_ids(false)
                    .with_file(false);

                let file_layer = fmt::layer()
                    .with_target(true)
                    .with_thread_ids(false)
                    .with_file(false)
                    .with_ansi(false)
                    .with_writer(non_blocking);

                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(stdout_layer)
                    .with(file_layer)
                    .init();

                tracing::info!("Logging initialized to file: {}", path);
            }
            Err(e) => {
                // Fall back to stdout only
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(fmt::layer())
                    .init();
                tracing::warn!("Failed to open log file {}: {}", path, e);
            }
        }
    } else {
        // No log file configured, stdout only
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt::layer())
            .init();
    }
}

/// Tauri command for frontend to log messages to the unified log file.
/// Called by the frontend fileLogger instead of writing directly.
#[tauri::command]
fn log_from_frontend(level: String, message: String) {
    // Use tracing macros so it goes through the same subscriber
    match level.as_str() {
        "ERROR" => tracing::error!(target: "frontend", "{}", message),
        "WARN" => tracing::warn!(target: "frontend", "{}", message),
        "INFO" => tracing::info!(target: "frontend", "{}", message),
        "DEBUG" => tracing::debug!(target: "frontend", "{}", message),
        _ => tracing::info!(target: "frontend", "[{}] {}", level, message),
    }
}

// Global storage for the running server port
static HTTP_SERVER_PORT: Mutex<Option<u16>> = Mutex::new(None);

// Global storage for unified observations WebSocket broadcast channel
static OBSERVATIONS_TX: Mutex<Option<broadcast::Sender<server::ObservationMessage>>> =
    Mutex::new(None);

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/// Normalize path string by removing Windows extended path prefix (\\?\)
pub fn normalize_path_string(path: &PathBuf) -> String {
    let s = path.to_string_lossy().to_string();
    // Remove \\?\ prefix that Windows uses for long paths
    if s.starts_with(r"\\?\") {
        s[4..].to_string()
    } else {
        s
    }
}

/// Convert a path to Windows extended-length format (\\?\) to support paths > 260 chars.
/// Returns the original string if not on Windows or if already prefixed.
#[cfg(windows)]
pub fn to_extended_length_path(path: &str) -> String {
    // Already has prefix
    if path.starts_with(r"\\?\") {
        return path.to_string();
    }
    // UNC paths need different handling (\\server\share -> \\?\UNC\server\share)
    if path.starts_with(r"\\") {
        return format!(r"\\?\UNC\{}", &path[2..]);
    }
    // Regular absolute paths (C:\... -> \\?\C:\...)
    if path.len() >= 2 && path.chars().nth(1) == Some(':') {
        // Ensure backslashes for extended-length paths
        let normalized = path.replace('/', r"\");
        return format!(r"\\?\{}", normalized);
    }
    // Relative paths can't use extended-length format
    path.to_string()
}

#[cfg(not(windows))]
pub fn to_extended_length_path(path: &str) -> String {
    path.to_string()
}

// =============================================================================
// HTTP SERVER
// =============================================================================

/// Server status info
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub local_url: Option<String>,
    pub lan_urls: Vec<String>,
}

/// Get all LAN IP addresses for display (filters out loopback and link-local)
fn get_lan_ips() -> Vec<String> {
    let mut ips = Vec::new();

    #[cfg(windows)]
    {
        use std::process::Command;
        // Use hostname command to get all IPs associated with the hostname
        if let Ok(output) = Command::new("hostname")
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
        {
            let hostname = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Try to resolve hostname to IPs
            use std::net::ToSocketAddrs;
            if let Ok(addrs) = format!("{}:0", hostname).to_socket_addrs() {
                for addr in addrs {
                    if let std::net::SocketAddr::V4(v4) = addr {
                        let ip = v4.ip().to_string();
                        // Skip loopback and link-local addresses
                        if !ip.starts_with("127.") && !ip.starts_with("169.254.") {
                            if !ips.contains(&ip) {
                                ips.push(ip);
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: try to connect to a public DNS and get the local address
    // This gets the "primary" outbound interface IP
    if ips.is_empty() {
        use std::net::UdpSocket;
        if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
            if socket.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = socket.local_addr() {
                    let ip = addr.ip().to_string();
                    if !ips.contains(&ip) {
                        ips.push(ip);
                    }
                }
            }
        }
    }

    ips
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

    // Store the shutdown channel, observations sender, and port
    {
        let mut guard = HTTP_SERVER_SHUTDOWN.lock().map_err(|e| e.to_string())?;
        *guard = Some(handles.shutdown_tx);
    }
    {
        let mut obs_guard = OBSERVATIONS_TX.lock().map_err(|e| e.to_string())?;
        *obs_guard = Some(handles.observations_tx);
    }
    {
        let mut port_guard = HTTP_SERVER_PORT.lock().map_err(|e| e.to_string())?;
        *port_guard = Some(port);
    }

    let lan_ips = get_lan_ips();
    let lan_urls = lan_ips
        .into_iter()
        .map(|ip| format!("http://{}:{}", ip, port))
        .collect();
    Ok(ServerStatus {
        running: true,
        port,
        local_url: Some(format!("http://localhost:{}", port)),
        lan_urls,
    })
}

/// Broadcast observations to WebSocket clients (for remote browser access)
/// This is called from the frontend (host app) to relay observations to remote browsers
fn broadcast_observation_message(message: server::ObservationMessage) {
    if let Ok(guard) = OBSERVATIONS_TX.lock() {
        if let Some(ref tx) = *guard {
            let _ = tx.send(message);
        }
    }
}

/// Tauri command to broadcast a batch of observations to remote clients
#[tauri::command]
fn broadcast_observations(observations: Vec<server::ObservationData>) {
    if observations.is_empty() {
        return;
    }
    let message = server::ObservationMessage::Observations { data: observations };
    broadcast_observation_message(message);
}

/// Tauri command to broadcast aircraft removals to remote clients
#[tauri::command]
fn broadcast_aircraft_removals(callsigns: Vec<String>) {
    if callsigns.is_empty() {
        return;
    }
    let message = server::ObservationMessage::Removals { callsigns };
    broadcast_observation_message(message);
}

/// Tauri command to broadcast subscription changes to remote clients
#[tauri::command]
fn broadcast_subscriptions(facilities: Vec<String>) {
    let message = server::ObservationMessage::Subscriptions { facilities };
    broadcast_observation_message(message);
}

/// Tauri command to broadcast vNAS connection state to remote clients
/// Called by the host when vNAS state changes (e.g., connected, disconnected)
#[tauri::command]
fn broadcast_vnas_state(state: String) {
    let message = server::ObservationMessage::VnasState { state };
    broadcast_observation_message(message);
}

/// Tauri command to broadcast airport sync to remote clients
/// Called by the host when the airport changes in RealTraffic mode
#[tauri::command]
fn broadcast_airport_sync(icao: Option<String>, realtraffic_active: bool) {
    let message = server::ObservationMessage::AirportSync {
        icao,
        realtraffic_active,
    };
    broadcast_observation_message(message);
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
        tracing::info!("Server shutdown signal sent");
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
        let lan_ips = get_lan_ips();
        let lan_urls = lan_ips
            .into_iter()
            .map(|ip| format!("http://{}:{}", ip, port))
            .collect();
        ServerStatus {
            running: true,
            port,
            local_url: Some(format!("http://localhost:{}", port)),
            lan_urls,
        }
    } else {
        ServerStatus {
            running: false,
            port,
            local_url: None,
            lan_urls: Vec::new(),
        }
    }
}

/// Get the log file path from environment variable (if set via --log flag)
#[tauri::command]
fn get_log_file_path() -> Option<String> {
    std::env::var("TOWERCAB_LOG_FILE").ok()
}

/// Set whether the app should minimize to tray instead of quitting.
/// Called by the frontend when the HTTP server starts/stops.
/// Also shows/hides the tray icon accordingly.
#[tauri::command]
fn set_minimize_to_tray(app: tauri::AppHandle, enabled: bool) {
    if let Ok(mut guard) = MINIMIZE_TO_TRAY.lock() {
        *guard = enabled;
    }
    // Show/hide tray icon
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(enabled);
    }
}

/// Create a fresh text file (overwrites if exists)
#[tauri::command]
fn create_text_file(path: String, content: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Append to a text file (creates if doesn't exist)
/// Uses append mode for efficiency - seeks to end and writes without reading entire file
#[tauri::command]
fn append_to_text_file(path: String, content: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    // Open file in append mode (creates if doesn't exist, seeks to end)
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open file: {}", e))?;

    // Write content to end of file
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write to file: {}", e))?;

    Ok(())
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
// FSLTL BATCH CONVERSION
// =============================================================================

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

    let converter_path =
        possible_paths
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
        "--source",
        &source_path,
        "--output",
        &output_path,
        "--texture-scale",
        &texture_scale,
        "--progress-file",
        &progress_file,
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
    let child = cmd
        .spawn()
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

        ProcessWithJob {
            child,
            job_handle: SendableHandle(job_handle),
        }
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

            tracing::info!("FSLTL converter process tree terminated (PID {})", pid);
            return Ok(());
        }
    }
    Err("No conversion process running".to_string())
}

// =============================================================================
// BACKWARD-COMPATIBLE COMMAND ALIASES
// =============================================================================

// These aliases maintain backward compatibility with existing frontend code
// that uses the old command names. They simply delegate to the new names.

/// Alias for get_converted_models_path (backward compatibility)
#[tauri::command]
fn get_fsltl_output_path(app: tauri::AppHandle) -> Result<String, String> {
    files::get_converted_models_path(app)
}

/// Alias for get_converted_models_default_path (backward compatibility)
#[tauri::command]
fn get_fsltl_default_output_path(app: tauri::AppHandle) -> Result<(String, bool), String> {
    files::get_converted_models_default_path(app)
}

/// Alias for check_converted_model_exists (backward compatibility)
#[tauri::command]
fn check_fsltl_model_exists(output_path: String, model_name: String) -> Result<bool, String> {
    files::check_converted_model_exists(output_path, model_name)
}

// =============================================================================
// WEBVIEW CONFIGURATION
// =============================================================================

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
            "--use-angle=gl", // Use OpenGL instead of D3D11 for better shadow depth precision
        ]
        .join(" ");

        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
    }
}

// =============================================================================
// APP ENTRY POINT
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing subscriber (logs to file if --log flag was passed)
    init_logging();

    // Set WebView2 GPU flags before creating the window
    set_webview2_args();

    tauri::Builder::default()
        // IMPORTANT: Single-instance MUST be the first plugin registered.
        // See: https://v2.tauri.app/plugin/deep-linking/
        // With the deep-link feature, it intercepts CLI args containing tc3d:// URLs,
        // forwards them to the existing instance, and exits before other plugins initialize.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Focus the main window when another instance tries to launch
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            tracing::info!("Single instance triggered with args: {:?}", argv);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Register updater plugin (desktop only)
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Set window title with version from config
            if let Some(window) = app.get_webview_window("main") {
                let version = app
                    .config()
                    .version
                    .clone()
                    .unwrap_or_else(|| "dev".to_string());
                let title = format!("TowerCab 3D v{}", version);
                let _ = window.set_title(&title);
            }

            // Register tc3d:// deep link protocol at runtime
            // On Windows, NSIS installer doesn't register deep links properly (tauri#10095)
            // On Linux, AppImage requires runtime registration
            // See: https://v2.tauri.app/plugin/deep-linking/
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    tracing::warn!("Failed to register deep link protocol: {}", e);
                }
            }

            // Initialize vNAS state
            vnas::init_vnas_state(app.handle());

            // Create system tray icon (hidden initially, shown when server starts with minimize-to-tray)
            let show_item = MenuItem::with_id(app, "show", "Show TowerCab 3D", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("TowerCab 3D")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Hide tray icon initially - it will be shown when minimize-to-tray is enabled
            let _ = tray.set_visible(false);

            // Auto-start HTTP server if enabled in global settings or via env var
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Check for TOWERCAB_AUTO_SERVER env var (used by npm run dev:server)
                let force_start = std::env::var("TOWERCAB_AUTO_SERVER").is_ok();

                // Load settings to get port (and check enabled flag if not force-starting)
                let (should_start, port) =
                    if let Ok(settings_file) = settings::get_global_settings_file(&app_handle) {
                        if settings_file.exists() {
                            if let Ok(content) = std::fs::read_to_string(&settings_file) {
                                if let Ok(settings) =
                                    serde_json::from_str::<settings::GlobalSettings>(&content)
                                {
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
                    tracing::info!(
                        "Auto-starting HTTP server on port {}{}",
                        port,
                        if force_start {
                            " (via TOWERCAB_AUTO_SERVER)"
                        } else {
                            ""
                        }
                    );
                    match server::start_server(app_handle.clone(), port).await {
                        Ok(handles) => {
                            if let Ok(mut guard) = HTTP_SERVER_SHUTDOWN.lock() {
                                *guard = Some(handles.shutdown_tx);
                            }
                            if let Ok(mut obs_guard) = OBSERVATIONS_TX.lock() {
                                *obs_guard = Some(handles.observations_tx);
                            }
                            tracing::info!("HTTP server auto-started successfully");
                        }
                        Err(e) => {
                            tracing::error!("HTTP server auto-start failed: {}", e);
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Check if minimize-to-tray is active
                    if let Ok(guard) = MINIMIZE_TO_TRAY.lock() {
                        if *guard {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    // Kill FSLTL converter process when app window is closed
                    if let Ok(mut guard) = FSLTL_CONVERTER_PROCESS.lock() {
                        // Taking and dropping the ProcessWithJob terminates all child processes:
                        // - Windows: closes job handle (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
                        // - Other: Drop impl calls child.kill()
                        let _ = guard.take();
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // Mods commands
            mods::get_mods_path,
            mods::list_mod_directories,
            mods::read_mod_manifest,
            mods::list_vmr_files,
            mods::list_vmr_files_in_dir,
            mods::read_tower_positions,
            mods::get_custom_tower_position_icaos,
            mods::update_tower_position,
            mods::discover_all_mods,
            mods::update_mod_repos,
            // VMR parsing commands
            vmr::parse_vmr_files,
            // Global settings commands
            settings::get_global_settings_path,
            settings::read_global_settings,
            settings::write_global_settings,
            // HTTP server commands
            start_http_server,
            stop_http_server,
            get_http_server_status,
            get_log_file_path,
            set_minimize_to_tray,
            // Observation broadcast commands (for remote browser relay)
            broadcast_observations,
            broadcast_aircraft_removals,
            broadcast_subscriptions,
            broadcast_vnas_state,
            broadcast_airport_sync,
            // File commands
            create_text_file,
            append_to_text_file,
            fetch_url,
            // RealTraffic commands
            realtraffic::realtraffic_auth,
            realtraffic::realtraffic_traffic,
            realtraffic::realtraffic_parked_traffic,
            realtraffic::realtraffic_deauth,
            // File commands
            files::pick_folder,
            files::pick_files,
            files::read_text_file,
            files::write_text_file,
            files::load_model_manifest,
            files::file_exists,
            files::get_file_size,
            files::delete_file,
            files::delete_cache_file,
            files::clear_cache_directory,
            files::check_path_writable,
            files::validate_fsltl_source,
            files::list_fsltl_aircraft,
            files::get_converter_path,
            files::read_conversion_progress,
            // FSLTL batch conversion commands
            start_fsltl_conversion,
            cancel_fsltl_conversion,
            // MSFS model commands
            msfs::detect_msfs_installations,
            msfs::list_fsltl_models,
            msfs::list_aig_models,
            msfs::convert_msfs_model,
            msfs::scan_cache_directory,
            // Backward-compatible aliases (old names -> new implementations)
            get_fsltl_output_path,
            get_fsltl_default_output_path,
            check_fsltl_model_exists,
            // vNAS commands
            vnas::vnas_get_status,
            vnas::vnas_is_available,
            vnas::vnas_try_restore_session,
            vnas::vnas_start_auth,
            vnas::vnas_complete_auth,
            vnas::vnas_handle_oauth_callback,
            vnas::vnas_connect,
            vnas::vnas_subscribe,
            vnas::vnas_subscribe_facility,
            vnas::vnas_unsubscribe_facility,
            vnas::vnas_get_subscribed_facilities,
            vnas::vnas_disconnect,
            vnas::vnas_is_connected,
            vnas::vnas_is_authenticated,
            vnas::vnas_get_session_facilities,
            vnas::vnas_get_session_artcc,
            vnas::vnas_get_session_airports,
            // Logging
            log_from_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
