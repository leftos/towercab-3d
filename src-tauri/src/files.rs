//! File utilities and operations.
//!
//! This module handles:
//! - File/folder pickers (native dialogs)
//! - Reading/writing text files
//! - File existence and size checks
//! - Cache directory management

use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_dialog::DialogExt;

use crate::normalize_path_string;

// =============================================================================
// DIALOG FUNCTIONS
// =============================================================================

/// Pick a folder using native dialog
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();

    match folder {
        Some(file_path) => Ok(Some(file_path.to_string())),
        None => Ok(None),
    }
}

/// Pick one or more files with optional extension filter
#[tauri::command]
pub async fn pick_files(
    app: tauri::AppHandle,
    filter_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
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

// =============================================================================
// TEXT FILE OPERATIONS
// =============================================================================

/// Read a text file from disk
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file {}: {}", path, e))
}

/// Write a text file to disk
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = PathBuf::from(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::write(&path, content).map_err(|e| format!("Failed to write file {}: {}", path, e))
}

/// Load and parse a model manifest.json file from a model directory
/// Returns the manifest JSON or null if file doesn't exist
#[tauri::command]
pub fn load_model_manifest(model_path: String) -> Result<Option<serde_json::Value>, String> {
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

// =============================================================================
// DIAGNOSTIC EXPORT
// =============================================================================

/// Save diagnostic JSON to the app data diagnostics directory.
/// Returns the full path of the saved file.
#[tauri::command]
pub fn save_diagnostic(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    use tauri::Manager;

    let diag_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("diagnostics");

    fs::create_dir_all(&diag_dir)
        .map_err(|e| format!("Failed to create diagnostics directory: {}", e))?;

    let file_path = diag_dir.join(&filename);
    fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to write diagnostic file: {}", e))?;

    Ok(crate::normalize_path_string(&file_path))
}

// =============================================================================
// FILE UTILITIES
// =============================================================================

/// Check if a file exists
#[tauri::command]
pub fn file_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

/// Get file size in bytes
#[tauri::command]
pub fn get_file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to get file size: {}", e))
}

/// Delete a file from disk
#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete file {}: {}", path, e))
}

/// Delete a cache file
#[tauri::command]
pub fn delete_cache_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete cache file: {}", e))
}

/// Clear all GLB files in a cache directory
#[tauri::command]
pub fn clear_cache_directory(path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Ok(());
    }

    for entry in
        (fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?).flatten()
    {
        let path = entry.path();
        if path.is_file() && path.extension().map(|e| e == "glb").unwrap_or(false) {
            let _ = fs::remove_file(&path);
        }
    }

    tracing::info!("[Cache] Cleared cache directory: {}", path);
    Ok(())
}

// =============================================================================
// PATH UTILITIES
// =============================================================================

/// Check if a directory path is writable
pub fn is_path_writable(path: &Path) -> bool {
    // Try to create a test file
    let test_file = path.join(".write_test");
    match fs::write(&test_file, "test") {
        Ok(_) => {
            let _ = fs::remove_file(&test_file);
            true
        }
        Err(_) => false,
    }
}

/// Check if a path is writable (Tauri command wrapper)
#[tauri::command]
pub fn check_path_writable(path: String) -> bool {
    is_path_writable(&PathBuf::from(&path))
}

// =============================================================================
// FSLTL LEGACY COMMANDS (kept for backward compatibility)
// =============================================================================

/// FSLTL converted model info
#[derive(Debug, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct FSLTLProgress {
    pub status: String, // "idle" | "scanning" | "converting" | "complete" | "error"
    pub total: u32,
    pub completed: u32,
    pub current: Option<String>,
    pub errors: Vec<String>,
    #[serde(default)]
    pub converted: Vec<FSLTLConvertedModel>,
}

/// Get smart default output path for converted MSFS models
/// Returns (default_path, is_writable)
#[tauri::command]
pub fn get_converted_models_default_path(app: tauri::AppHandle) -> Result<(String, bool), String> {
    use crate::mods::find_mods_root;
    use tauri::Manager;

    let mods_root = find_mods_root(&app);
    let mods_path = mods_root.join("aircraft").join("fsltl");

    // Try to create and check if mods path is writable
    if fs::create_dir_all(&mods_path).is_ok() && is_path_writable(&mods_path) {
        return Ok((normalize_path_string(&mods_path), true));
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

/// Get the converted models output path (legacy - always returns mods path)
#[tauri::command]
pub fn get_converted_models_path(app: tauri::AppHandle) -> Result<String, String> {
    let (path, _) = get_converted_models_default_path(app)?;
    Ok(path)
}

/// Check if FSLTL source path is valid (contains FSLTL_Rules.vmr)
#[tauri::command]
pub fn validate_fsltl_source(source_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&source_path);
    let vmr_path = path.join("FSLTL_Rules.vmr");
    let airplanes_path = path.join("SimObjects").join("Airplanes");

    Ok(vmr_path.exists() && airplanes_path.exists())
}

/// List available aircraft folders in FSLTL source
#[tauri::command]
pub fn list_fsltl_aircraft(source_path: String) -> Result<Vec<String>, String> {
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

/// Check if a converted model GLB file exists in the output directory
#[tauri::command]
pub fn check_converted_model_exists(
    output_path: String,
    model_name: String,
) -> Result<bool, String> {
    // Models are stored as: output_path/TYPE/AIRLINE/model.glb or output_path/TYPE/base/model.glb
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

/// Read conversion progress from JSON file
#[tauri::command]
pub fn read_conversion_progress(progress_file: String) -> Result<FSLTLProgress, String> {
    let content = fs::read_to_string(&progress_file)
        .map_err(|e| format!("Failed to read progress file: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse progress JSON: {}", e))
}

/// Get the bundled converter executable path
#[tauri::command]
pub fn get_converter_path(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

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
