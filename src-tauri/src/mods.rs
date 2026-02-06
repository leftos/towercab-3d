//! Mod system for loading custom aircraft and tower models.
//!
//! This module handles:
//! - Finding and listing mod directories (supports recursive discovery for git repos)
//! - Reading mod manifests (manifest.json)
//! - Reading tower position files (mods/tower-positions/*.json)
//! - Listing VMR files in the mods directory

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::normalize_path_string;

/// A discovered mod with its path and detected type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMod {
    /// Absolute path to the directory containing manifest.json
    pub path: String,
    /// Detected mod type: "aircraft" or "tower"
    pub mod_type: String,
    /// Whether this is inside a git repository
    pub is_git_repo: bool,
    /// Name of the git repo folder (if applicable)
    pub repo_name: Option<String>,
}

/// Find the mods root directory (user-modifiable content)
/// Returns the first path that exists, or the first candidate if none exist
pub fn find_mods_root(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let resource_path = app.path().resource_dir().unwrap_or_default();
    let mods_path = resource_path.join("mods");

    if mods_path.exists() {
        mods_path
    } else {
        // Fallback to resource path (will be created if needed)
        mods_path
    }
}

/// Find the bundled resources directory (read-only, shipped with app)
/// Contains preset data like bundled tower positions
pub fn find_resources_root(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let resource_path = app.path().resource_dir().unwrap_or_default();
    resource_path.join("resources")
}

/// Get the path to a mod type directory (aircraft or towers)
#[tauri::command]
pub fn get_mods_path(app: tauri::AppHandle, mod_type: String) -> Result<String, String> {
    let mods_root = find_mods_root(&app);
    let mods_path = mods_root.join(&mod_type);
    Ok(mods_path.to_string_lossy().to_string())
}

/// List all mod directories for a given type (aircraft or towers)
#[tauri::command]
pub fn list_mod_directories(
    app: tauri::AppHandle,
    mod_type: String,
) -> Result<Vec<String>, String> {
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
pub fn read_mod_manifest(path: String) -> Result<serde_json::Value, String> {
    let manifest_path = PathBuf::from(&path).join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest at {:?}: {}", manifest_path, e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse manifest JSON: {}", e))
}

/// List all VMR (Visual Model Rules) files in the mods directory
/// Scans both mods/ root and mods/aircraft/ for .vmr files
#[tauri::command]
pub fn list_vmr_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
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

// =============================================================================
// TOWER POSITIONS
// =============================================================================

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

/// Helper to read tower position files from a directory
/// Returns a map of ICAO codes to position data
fn read_tower_positions_from_dir(
    dir: &PathBuf,
) -> serde_json::Map<String, serde_json::Value> {
    let mut positions = serde_json::Map::new();

    if dir.exists() && dir.is_dir() {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                {
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

    positions
}

/// Read tower positions from multiple sources with layered priority:
/// 1. Bundled positions from resources/tower-positions/*.json (lowest priority)
/// 2. Legacy mods/tower-positions.json (backward compatibility)
/// 3. User positions from mods/tower-positions/*.json (highest priority, overwrites others)
///
/// Each file is named {ICAO}.json (case-insensitive)
/// Returns the merged JSON as a serde_json::Value
#[tauri::command]
pub fn read_tower_positions(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let mods_root = find_mods_root(&app);
    let resources_root = find_resources_root(&app);
    let mut positions: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

    // 1. Read bundled tower positions from resources/ (lowest priority)
    let bundled_dir = resources_root.join("tower-positions");
    for (icao, pos) in read_tower_positions_from_dir(&bundled_dir) {
        positions.insert(icao, pos);
    }

    // 2. Read legacy tower-positions.json if it exists (overwrites bundled)
    let legacy_path = mods_root.join("tower-positions.json");
    if legacy_path.exists() {
        if let Ok(content) = fs::read_to_string(&legacy_path) {
            if let Ok(legacy_positions) =
                serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content)
            {
                for (icao, pos) in legacy_positions {
                    positions.insert(icao.to_uppercase(), pos);
                }
            }
        }
    }

    // 3. Read user positions from mods/tower-positions/ (highest priority, overwrites all)
    let user_dir = mods_root.join("tower-positions");
    for (icao, pos) in read_tower_positions_from_dir(&user_dir) {
        positions.insert(icao, pos);
    }

    Ok(serde_json::Value::Object(positions))
}

/// Get list of user-custom tower position ICAOs (from mods/tower-positions/)
/// These are positions the user has added/modified, not bundled ones
#[tauri::command]
pub fn get_custom_tower_position_icaos(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mods_root = find_mods_root(&app);
    let user_dir = mods_root.join("tower-positions");

    let mut icaos = Vec::new();

    if user_dir.exists() && user_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&user_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        icaos.push(stem.to_uppercase());
                    }
                }
            }
        }
    }

    icaos.sort();
    Ok(icaos)
}

/// Update a single tower position in mods/tower-positions/{ICAO}.json
/// Creates the directory and file if they don't exist
#[tauri::command]
pub fn update_tower_position(
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
    fs::write(&file_path, output).map_err(|e| format!("Failed to write position file: {}", e))?;

    Ok(())
}

/// List all VMR files in a specific directory (non-recursive)
/// Unlike list_vmr_files which scans the mods directory, this scans an arbitrary path
/// Returns absolute paths to all .vmr files found
#[tauri::command]
pub fn list_vmr_files_in_dir(directory: String) -> Result<Vec<String>, String> {
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

// =============================================================================
// RECURSIVE MOD DISCOVERY (for git repo support)
// =============================================================================

/// Recursively discover all mods in the mods directory
/// Finds manifest.json files at any depth and determines mod type from content
/// Supports git repos cloned directly into the mods folder
#[tauri::command]
pub fn discover_all_mods(app: tauri::AppHandle) -> Result<Vec<DiscoveredMod>, String> {
    let mods_root = find_mods_root(&app);

    if !mods_root.exists() {
        return Ok(Vec::new());
    }

    let mut discovered = Vec::new();
    discover_mods_recursive(&mods_root, &mods_root, &mut discovered)?;

    // Sort by path for consistent ordering
    discovered.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(discovered)
}

/// Recursively search for manifest.json files
fn discover_mods_recursive(
    dir: &PathBuf,
    mods_root: &PathBuf,
    discovered: &mut Vec<DiscoveredMod>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()), // Skip directories we can't read
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip hidden directories (like .git)
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }

        // Skip tower-positions directory (not a mod, contains position JSON files)
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == "tower-positions" {
                continue;
            }
        }

        if path.is_dir() {
            // Check if this directory contains a manifest.json
            let manifest_path = path.join("manifest.json");
            if manifest_path.exists() {
                // Try to determine mod type from manifest content
                if let Ok(mod_info) = parse_manifest_for_discovery(&path, mods_root) {
                    discovered.push(mod_info);
                }
            }

            // Continue searching subdirectories
            discover_mods_recursive(&path, mods_root, discovered)?;
        }
    }

    Ok(())
}

/// Parse a manifest.json to determine mod type and extract discovery info
fn parse_manifest_for_discovery(
    mod_dir: &PathBuf,
    mods_root: &PathBuf,
) -> Result<DiscoveredMod, String> {
    let manifest_path = mod_dir.join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;

    let manifest: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse manifest: {}", e))?;

    // Determine mod type based on manifest fields
    let mod_type = if manifest.get("aircraftTypes").is_some() {
        "aircraft"
    } else if manifest.get("airports").is_some() {
        "tower"
    } else {
        return Err("Unknown mod type: missing aircraftTypes or airports field".to_string());
    };

    // Check if this is inside a git repo by looking for .git in parent directories
    let (is_git_repo, repo_name) = find_git_repo_info(mod_dir, mods_root);

    Ok(DiscoveredMod {
        path: normalize_path_string(mod_dir),
        mod_type: mod_type.to_string(),
        is_git_repo,
        repo_name,
    })
}

/// Check if a directory is inside a git repo and get the repo folder name
fn find_git_repo_info(dir: &PathBuf, mods_root: &PathBuf) -> (bool, Option<String>) {
    let mut current = dir.clone();

    while current.starts_with(mods_root) && current != *mods_root {
        let git_dir = current.join(".git");
        if git_dir.exists() {
            let repo_name = current
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            return (true, repo_name);
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    (false, None)
}
