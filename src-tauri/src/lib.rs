use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use serde::{Deserialize, Serialize};

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

/// FSLTL conversion progress status
#[derive(Debug, Serialize, Deserialize)]
pub struct FSLTLProgress {
    pub status: String,         // "idle" | "scanning" | "converting" | "complete" | "error"
    pub total: u32,
    pub completed: u32,
    pub current: Option<String>,
    pub errors: Vec<String>,
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

/// Get the FSLTL models output path
#[tauri::command]
fn get_fsltl_output_path(app: tauri::AppHandle) -> Result<String, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let fsltl_path = resource_path.join("mods").join("aircraft").join("fsltl");

    // Create the directory if it doesn't exist
    fs::create_dir_all(&fsltl_path)
        .map_err(|e| format!("Failed to create FSLTL directory: {}", e))?;

    Ok(fsltl_path.to_string_lossy().to_string())
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

    let converter_path = resource_path.join("fsltl_converter.exe");

    if converter_path.exists() {
        Ok(converter_path.to_string_lossy().to_string())
    } else {
        Err("Converter executable not found".to_string())
    }
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
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    let converter_path = resource_path.join("fsltl_converter.exe");

    if !converter_path.exists() {
        return Err("Converter executable not found".to_string());
    }

    // Build command arguments
    let models_str = models.join(",");

    Command::new(converter_path)
        .args([
            "--source", &source_path,
            "--output", &output_path,
            "--texture-scale", &texture_scale,
            "--progress-file", &progress_file,
            "--models", &models_str,
        ])
        .spawn()
        .map_err(|e| format!("Failed to start converter: {}", e))?;

    Ok(())
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
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
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
            validate_fsltl_source,
            list_fsltl_aircraft,
            get_converter_path,
            start_fsltl_conversion,
            read_conversion_progress,
            check_fsltl_model_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
