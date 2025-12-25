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

/// Get the path to a mod type directory (aircraft or towers)
#[tauri::command]
fn get_mods_path(app: tauri::AppHandle, mod_type: String) -> Result<String, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let mods_path = resource_path.join("mods").join(&mod_type);
    Ok(mods_path.to_string_lossy().to_string())
}

/// List all mod directories for a given type (aircraft or towers)
#[tauri::command]
fn list_mod_directories(app: tauri::AppHandle, mod_type: String) -> Result<Vec<String>, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let mods_path = resource_path.join("mods").join(&mod_type);

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
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let mods_path = resource_path.join("mods").join("aircraft").join("fsltl");

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

            // On Windows, closing the job handle (via Drop) terminates all processes in the job
            // On other platforms, we just kill the parent process
            #[cfg(not(windows))]
            {
                let _ = proc.child.kill();
            }

            // Wait for the child process to fully exit
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
            fetch_url,
            // FSLTL commands
            pick_folder,
            read_text_file,
            write_text_file,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
