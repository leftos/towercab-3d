//! MSFS (Microsoft Flight Simulator) model handling.
//!
//! This module handles:
//! - Detecting MSFS model sources (FSLTL, AIG)
//! - Listing available models from each source
//! - Converting models on-demand (GLTF -> GLB)
//! - Scanning converted models in output directories
//! - Model index caching for performance

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::normalize_path_string;

// =============================================================================
// TYPES
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
    pub aircraft_folder_path: String, // Full path to the aircraft folder
    pub gltf_path: String,
    pub texture_dirs: Vec<String>,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
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

/// Scanned model info from converted output directory
/// (renamed from ScannedFSLTLModel since it scans any converted models)
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedConvertedModel {
    pub model_name: String,
    pub model_path: String,
    /// Relative path usable with /api/fsltl/* endpoint (e.g., "B738/AAL/model.glb")
    pub relative_path: String,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
    pub has_animations: bool,
    pub file_size: u64,
}

/// Info about a cached GLB model file
#[derive(Debug, Serialize)]
pub struct CachedGlbInfo {
    /// Full path to the GLB file
    pub path: String,
    /// Model key extracted from filename (e.g., "fsltl_FSLTL_FAIB_B738_American")
    pub model_key: String,
    /// File size in bytes
    pub file_size: u64,
    /// Converter version used to create this GLB (from asset.extras.towercab3d.converterVersion)
    pub converter_version: Option<u32>,
}

/// Livery info from aircraft.cfg FLTSIM section
struct AircraftCfgLivery {
    title: String,
    texture_folder: String,
    icao_airline: Option<String>,
}

// =============================================================================
// MODEL INDEX CACHING
// =============================================================================

/// Cached model index with folder modification time for invalidation
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelIndexCache {
    /// Unix timestamp when the source folder was last modified
    folder_mtime: u64,
    /// Version number for cache format - bump to invalidate old caches
    version: u32,
    /// The cached model list
    models: Vec<SourceModelInfo>,
}

const MODEL_CACHE_VERSION: u32 = 5; // Bump when cache format changes (v5: fixed UTF-8 parsing for AIG)

/// Get the modification time of a folder (recursive max mtime would be too slow)
fn get_folder_mtime(path: &std::path::Path) -> Option<u64> {
    fs::metadata(path).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Get the cache file path for a model source
/// cache_dir should be the app data directory (e.g., %APPDATA%/com.towercab.viewer)
fn get_cache_path(cache_dir: &std::path::Path, source: &str) -> PathBuf {
    cache_dir.join(format!("{}_model_cache.json", source))
}

/// Load model index from cache if valid
/// cache_dir: app data directory for storing cache files
/// base_path: source folder path (for mtime validation)
fn load_model_cache(cache_dir: &std::path::Path, base_path: &std::path::Path, source: &str) -> Option<Vec<SourceModelInfo>> {
    let cache_path = get_cache_path(cache_dir, source);
    if !cache_path.exists() {
        return None;
    }

    let cache_content = fs::read_to_string(&cache_path).ok()?;
    let cache: ModelIndexCache = serde_json::from_str(&cache_content).ok()?;

    // Check version
    if cache.version != MODEL_CACHE_VERSION {
        println!("[MSFSDetection] {} cache version mismatch (have {}, need {}), will rebuild",
            source, cache.version, MODEL_CACHE_VERSION);
        return None;
    }

    // Check if folder mtime has changed
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    let current_mtime = get_folder_mtime(&airplanes)?;

    if cache.folder_mtime != current_mtime {
        println!("[MSFSDetection] {} folder modified, cache invalid", source);
        return None;
    }

    println!("[MSFSDetection] Loaded {} models from {} cache", cache.models.len(), source);
    Some(cache.models)
}

/// Save model index to cache
/// cache_dir: app data directory for storing cache files
/// base_path: source folder path (for mtime)
fn save_model_cache(cache_dir: &std::path::Path, base_path: &std::path::Path, source: &str, models: &[SourceModelInfo]) {
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    let Some(folder_mtime) = get_folder_mtime(&airplanes) else { return };

    let cache = ModelIndexCache {
        folder_mtime,
        version: MODEL_CACHE_VERSION,
        models: models.to_vec(),
    };

    // Ensure cache directory exists
    if let Err(e) = fs::create_dir_all(cache_dir) {
        println!("[MSFSDetection] Failed to create cache directory: {}", e);
        return;
    }

    let cache_path = get_cache_path(cache_dir, source);
    if let Ok(content) = serde_json::to_string(&cache) {
        if let Err(e) = fs::write(&cache_path, content) {
            println!("[MSFSDetection] Failed to write {} cache: {}", source, e);
        } else {
            println!("[MSFSDetection] Saved {} models to {} cache", models.len(), source);
        }
    }
}

// =============================================================================
// AIRCRAFT.CFG PARSING
// =============================================================================

/// Parse aircraft.cfg to extract icao_type_designator from [General] section
/// Returns the ICAO type code (e.g., "B77W", "A320") or None if not found
fn parse_aircraft_cfg_icao_type(aircraft_dir: &std::path::Path) -> Option<String> {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return None;
    }

    // Use lossy UTF-8 conversion for AIG files with Windows-1252 encoding
    let bytes = fs::read(&cfg_path).ok()?;
    let content = String::from_utf8_lossy(&bytes);

    let mut in_general_section = false;
    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            in_general_section = trimmed.to_uppercase() == "[GENERAL]";
            continue;
        }

        // Look for icao_type_designator in [General] section
        if in_general_section && trimmed.to_lowercase().starts_with("icao_type_designator") {
            if let Some(eq_pos) = trimmed.find('=') {
                let value = trimmed[eq_pos + 1..]
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !value.is_empty() {
                    return Some(value.to_uppercase());
                }
            }
        }
    }

    None
}

/// Parse aircraft.cfg to extract the title field from first FLTSIM section
/// Returns the title from [FLTSIM.0] section, or None if not found
fn parse_aircraft_cfg_title(aircraft_dir: &std::path::Path) -> Option<String> {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return None;
    }

    // Use lossy UTF-8 conversion for AIG files with Windows-1252 encoding
    let bytes = fs::read(&cfg_path).ok()?;
    let content = String::from_utf8_lossy(&bytes);

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

/// Parse all FLTSIM sections from aircraft.cfg
/// Returns list of (title, texture_folder, icao_airline) for each livery
fn parse_aircraft_cfg_all_liveries(aircraft_dir: &std::path::Path) -> Vec<AircraftCfgLivery> {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return Vec::new();
    }

    // Read as bytes and convert to string with lossy UTF-8 conversion
    // AIG aircraft.cfg files often contain Windows-1252 encoded characters
    let content = match fs::read(&cfg_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return Vec::new(),
    };

    let mut liveries = Vec::new();
    let mut in_fltsim_section = false;
    let mut current_title: Option<String> = None;
    let mut current_texture: Option<String> = None;
    let mut current_icao_airline: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            // Save previous livery if complete
            if in_fltsim_section {
                if let (Some(title), Some(texture)) = (current_title.take(), current_texture.take()) {
                    liveries.push(AircraftCfgLivery {
                        title,
                        texture_folder: texture,
                        icao_airline: current_icao_airline.take(),
                    });
                }
            }
            in_fltsim_section = trimmed.to_uppercase().starts_with("[FLTSIM");
            current_title = None;
            // Default to empty texture (for FSLTL generic models)
            current_texture = if in_fltsim_section { Some(String::new()) } else { None };
            current_icao_airline = None;
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
                // Allow empty texture folders (for FSLTL generic models like FSLTL_BCS3_ZZZZ)
                current_texture = Some(value.to_string());
            }
        } else if lower.starts_with("icao_airline") {
            if let Some(eq_pos) = trimmed.find('=') {
                let value = trimmed[eq_pos + 1..]
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim();
                if !value.is_empty() {
                    current_icao_airline = Some(value.to_uppercase());
                }
            }
        }
    }

    // Don't forget the last section
    if in_fltsim_section {
        if let (Some(title), Some(texture)) = (current_title, current_texture) {
            liveries.push(AircraftCfgLivery {
                title,
                texture_folder: texture,
                icao_airline: current_icao_airline,
            });
        }
    }

    liveries
}

// =============================================================================
// UNIFIED MODEL LISTING
// =============================================================================

/// Configuration for listing models from an MSFS traffic source
struct SourceConfig {
    /// Source identifier ("fsltl" or "aig")
    source: &'static str,
    /// Folder prefix to filter (e.g., "FSLTL_" or "AIGAIM_")
    folder_prefix: &'static str,
}

/// Find GLTF file in an aircraft directory
/// Returns the path to the best exterior GLTF file, or None if not found
fn find_gltf_in_dir(aircraft_dir: &std::path::Path) -> Option<String> {
    let model_dirs: Vec<_> = fs::read_dir(aircraft_dir)
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

        // Prefer exterior model: exclude cockpit/interior files, prefer lower LOD numbers
        let exterior_gltf = gltf_files.iter()
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                !name.contains("cockpit") && !name.contains("interior")
            })
            .min_by_key(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.contains("lod00") { 0 }
                else if name.contains("lod01") { 1 }
                else if name.contains("lod02") { 2 }
                else if name.contains("lod03") { 3 }
                else if name.contains("lod04") { 4 }
                else { 5 }
            });

        if let Some(gltf_file) = exterior_gltf {
            return Some(normalize_path_string(&gltf_file.path()));
        }
    }

    None
}

/// Collect texture directories from a folder
/// Returns directories starting with "texture" or "oci" (case-insensitive)
fn collect_texture_dirs(dir: &std::path::Path) -> Vec<String> {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            e.path().is_dir() && (name.starts_with("texture") || name.starts_with("oci"))
        })
        .map(|e| normalize_path_string(&e.path()))
        .collect()
}

/// Parse aircraft type from folder name
/// Handles both FSLTL (FSLTL_B738_AAL) and AIG (AIGAIM_TFS_B777-200ER_GE) patterns
fn parse_aircraft_type(folder_name: &str, prefix: &str) -> String {
    let without_prefix = folder_name.strip_prefix(prefix).unwrap_or(folder_name);
    let parts: Vec<&str> = without_prefix.split('_').collect();

    if prefix == "FSLTL_" {
        // FSLTL: FSLTL_{TYPE}_{AIRLINE} -> TYPE is first part
        parts.first().map(|s| s.to_string()).unwrap_or_default()
    } else {
        // AIG: AIGAIM_{SOURCE}_{TYPE} -> TYPE is second part, before any hyphen
        if parts.len() >= 2 {
            parts[1].split('-').next().unwrap_or(parts[1]).to_string()
        } else {
            without_prefix.split('-').next().unwrap_or(without_prefix).to_string()
        }
    }
}

/// Unified model listing for MSFS traffic sources (FSLTL and AIG)
///
/// This function handles both source types with a unified approach:
/// 1. Build base model index (for FSLTL's base model fallback pattern)
/// 2. For each aircraft folder, parse ALL FLTSIM sections from aircraft.cfg
/// 3. Create a SourceModelInfo for each livery with correct texture directories
fn list_models_unified(base_path: &std::path::Path, config: &SourceConfig) -> Vec<SourceModelInfo> {
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    if !airplanes.exists() {
        return Vec::new();
    }

    // PASS 1: Build base model index
    // Maps aircraft_type -> (gltf_path, texture_dirs)
    // This is needed for FSLTL where livery folders reference a base model
    // For AIG, this is mostly unused but harmless
    let mut base_models: std::collections::HashMap<String, (String, Vec<String>)> = std::collections::HashMap::new();

    if let Ok(entries) = fs::read_dir(&airplanes) {
        for entry in entries.filter_map(|e| e.ok()) {
            let aircraft_dir = entry.path();
            if !aircraft_dir.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with(config.folder_prefix) {
                continue;
            }

            // Check if this looks like a base model (FSLTL_B738 or FSLTL_B738_ZZZZ)
            let parts: Vec<&str> = folder_name.split('_').collect();
            let is_base_model = if config.folder_prefix == "FSLTL_" {
                parts.len() == 2 || (parts.len() >= 3 && parts[2] == "ZZZZ")
            } else {
                // AIG folders are always "base models" (they contain their own GLTF)
                true
            };

            if is_base_model {
                if let Some(gltf_path) = find_gltf_in_dir(&aircraft_dir) {
                    // Get ICAO type from aircraft.cfg, fall back to folder name parsing
                    let aircraft_type = parse_aircraft_cfg_icao_type(&aircraft_dir)
                        .unwrap_or_else(|| parse_aircraft_type(&folder_name, config.folder_prefix));
                    let texture_dirs = collect_texture_dirs(&aircraft_dir);
                    base_models.entry(aircraft_type).or_insert((gltf_path, texture_dirs));
                }
            }
        }
    }

    // PASS 2: Create entries for all liveries
    let mut models = Vec::new();

    if let Ok(entries) = fs::read_dir(&airplanes) {
        for entry in entries.filter_map(|e| e.ok()) {
            let aircraft_dir = entry.path();
            if !aircraft_dir.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if !folder_name.starts_with(config.folder_prefix) {
                continue;
            }

            // Get ICAO type from aircraft.cfg, fall back to folder name parsing
            let aircraft_type = parse_aircraft_cfg_icao_type(&aircraft_dir)
                .unwrap_or_else(|| parse_aircraft_type(&folder_name, config.folder_prefix));

            // Find GLTF - either in this folder or from base model
            let gltf_path = find_gltf_in_dir(&aircraft_dir)
                .or_else(|| base_models.get(&aircraft_type).map(|(p, _)| p.clone()));

            let gltf_path = match gltf_path {
                Some(p) => p,
                None => continue, // Skip if no GLTF found
            };

            // Collect shared texture directories (oci.* folders, base model textures)
            let shared_texture_dirs: Vec<String> = {
                let mut dirs: Vec<String> = fs::read_dir(&aircraft_dir)
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

                // Add base model texture directories as fallback (for shared textures like portholes)
                if let Some((_, base_tex_dirs)) = base_models.get(&aircraft_type) {
                    for base_dir in base_tex_dirs {
                        if !dirs.contains(base_dir) {
                            dirs.push(base_dir.clone());
                        }
                    }
                }

                dirs
            };

            // Parse ALL FLTSIM sections from aircraft.cfg
            let liveries = parse_aircraft_cfg_all_liveries(&aircraft_dir);

            if !liveries.is_empty() {
                // Create entry for each livery defined in aircraft.cfg
                for livery in liveries {
                    let mut texture_dirs: Vec<String> = Vec::new();

                    // Find the texture folder for this livery
                    if livery.texture_folder.is_empty() {
                        // For generic models with empty texture field, use bare "texture" folder
                        let texture_folder_path = aircraft_dir.join("texture");
                        let texture_folder_path_alt = aircraft_dir.join("Texture");

                        if texture_folder_path.exists() {
                            texture_dirs.push(normalize_path_string(&texture_folder_path));
                        } else if texture_folder_path_alt.exists() {
                            texture_dirs.push(normalize_path_string(&texture_folder_path_alt));
                        }
                    } else {
                        // For liveries with specific texture folders
                        let texture_folder_path = aircraft_dir.join(format!("texture.{}", livery.texture_folder));
                        let texture_folder_path_alt = aircraft_dir.join(format!("Texture.{}", livery.texture_folder));

                        if texture_folder_path.exists() {
                            texture_dirs.push(normalize_path_string(&texture_folder_path));
                        } else if texture_folder_path_alt.exists() {
                            texture_dirs.push(normalize_path_string(&texture_folder_path_alt));
                        }
                    }

                    // Add shared texture directories as fallback
                    texture_dirs.extend(shared_texture_dirs.clone());

                    // Use icao_airline from aircraft.cfg (fall back to texture folder parsing if not present)
                    let airline_code = livery.icao_airline.clone().or_else(|| {
                        livery.texture_folder
                            .split('-')
                            .next()
                            .map(|s| s.to_uppercase())
                            .filter(|s| s.len() == 3 || s.len() == 4)
                    });

                    models.push(SourceModelInfo {
                        source: config.source.to_string(),
                        model_name: livery.title,
                        folder_name: folder_name.clone(),
                        aircraft_folder_path: normalize_path_string(&aircraft_dir),
                        gltf_path: gltf_path.clone(),
                        texture_dirs,
                        aircraft_type: aircraft_type.clone(),
                        airline_code,
                    });
                }
            } else {
                // Fallback: No aircraft.cfg liveries found
                // Scan texture.* folders and create entries for each
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

                if !livery_folders.is_empty() {
                    for livery_entry in &livery_folders {
                        let livery_name = livery_entry.file_name().to_string_lossy().to_string();
                        let texture_suffix = livery_name
                            .strip_prefix("texture.")
                            .or_else(|| livery_name.strip_prefix("Texture."))
                            .unwrap_or(&livery_name);

                        let airline_code = texture_suffix
                            .split('-')
                            .next()
                            .map(|s| s.to_uppercase())
                            .filter(|s| s.len() == 3 || s.len() == 4);

                        // Use folder name + texture suffix as model name
                        let model_name = format!("{}_{}", folder_name, texture_suffix);

                        let mut texture_dirs = vec![normalize_path_string(&livery_entry.path())];
                        texture_dirs.extend(shared_texture_dirs.clone());

                        models.push(SourceModelInfo {
                            source: config.source.to_string(),
                            model_name,
                            folder_name: folder_name.clone(),
                            aircraft_folder_path: normalize_path_string(&aircraft_dir),
                            gltf_path: gltf_path.clone(),
                            texture_dirs,
                            aircraft_type: aircraft_type.clone(),
                            airline_code,
                        });
                    }
                } else {
                    // No texture.* folders - create single entry with all textures
                    let all_texture_dirs = collect_texture_dirs(&aircraft_dir);

                    // Try to get title from aircraft.cfg, fall back to folder name
                    let model_name = parse_aircraft_cfg_title(&aircraft_dir)
                        .unwrap_or_else(|| folder_name.clone());

                    // Try to extract airline from folder name (FSLTL_B738_AAL -> AAL)
                    let airline_code = if config.folder_prefix == "FSLTL_" {
                        let parts: Vec<&str> = folder_name.split('_').collect();
                        if parts.len() > 2 && parts[2] != "ZZZZ" {
                            Some(parts[2].to_uppercase())
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    models.push(SourceModelInfo {
                        source: config.source.to_string(),
                        model_name,
                        folder_name: folder_name.clone(),
                        aircraft_folder_path: normalize_path_string(&aircraft_dir),
                        gltf_path: gltf_path.clone(),
                        texture_dirs: all_texture_dirs,
                        aircraft_type: aircraft_type.clone(),
                        airline_code,
                    });
                }
            }
        }
    }

    models
}

// =============================================================================
// TAURI COMMANDS - DETECTION
// =============================================================================

/// Detect FSLTL and AIG installations in Community folder
#[tauri::command]
pub fn detect_msfs_installations(community_path: String) -> Result<MSFSDetectionResult, String> {
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

// =============================================================================
// TAURI COMMANDS - SOURCE LISTING
// =============================================================================

/// List available FSLTL models from source
/// Uses unified listing logic that parses ALL FLTSIM sections from aircraft.cfg
#[tauri::command]
pub fn list_fsltl_models(app: tauri::AppHandle, base_path: String) -> Result<Vec<SourceModelInfo>, String> {
    let base = PathBuf::from(&base_path);
    let cache_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Try to load from cache first (much faster on subsequent launches)
    if let Some(cached) = load_model_cache(&cache_dir, &base, "fsltl") {
        return Ok(cached);
    }

    let start_time = std::time::Instant::now();

    let config = SourceConfig {
        source: "fsltl",
        folder_prefix: "FSLTL_",
    };

    let models = list_models_unified(&base, &config);

    let elapsed = start_time.elapsed();
    println!("[MSFSDetection] Indexed {} FSLTL liveries in {:?}", models.len(), elapsed);

    // Save to cache for faster subsequent launches
    save_model_cache(&cache_dir, &base, "fsltl", &models);

    Ok(models)
}

/// List available AIG models from source
/// Uses unified listing logic that parses ALL FLTSIM sections from aircraft.cfg
#[tauri::command]
pub fn list_aig_models(app: tauri::AppHandle, base_path: String) -> Result<Vec<SourceModelInfo>, String> {
    let base = PathBuf::from(&base_path);
    let cache_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Try to load from cache first
    if let Some(cached) = load_model_cache(&cache_dir, &base, "aig") {
        return Ok(cached);
    }

    let start_time = std::time::Instant::now();

    let config = SourceConfig {
        source: "aig",
        folder_prefix: "AIGAIM_",
    };

    let models = list_models_unified(&base, &config);

    let elapsed = start_time.elapsed();
    println!("[MSFSDetection] Indexed {} AIG liveries in {:?}", models.len(), elapsed);

    // Save to cache for faster subsequent launches
    save_model_cache(&cache_dir, &base, "aig", &models);

    Ok(models)
}

// =============================================================================
// TAURI COMMANDS - CONVERSION
// =============================================================================

/// Convert one or more MSFS model liveries to GLB format
/// This is used for on-the-fly conversion when an aircraft first appears
///
/// Arguments:
/// - source_path: Path to aircraft folder (source/SimObjects/Airplanes/FSLTL_B738_AAL).
///                Converter auto-detects this and skips global scan for fast conversion.
/// - folder_name: Aircraft folder name (used for logging, e.g., "FSLTL_B738_AAL")
/// - output_dir: Output directory for converted models (converter creates {source}_{liveryTitle}.glb)
/// - texture_scale: Texture scaling ("full", "2k", "1k", "512")
/// - livery_title: Livery title from aircraft.cfg to convert (only this livery)
/// - texture_dirs: Pre-computed texture directories from model indexing (for reference/debugging)
#[tauri::command]
pub async fn convert_msfs_model(
    app: tauri::AppHandle,
    source_path: String,
    folder_name: String,
    output_dir: String,
    texture_scale: String,
    livery_title: String,
    texture_dirs: Option<Vec<String>>,
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
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Build command arguments
    let mut cmd = Command::new(&converter_path);
    cmd.args([
        "--source", &source_path,
        "--output", &output_dir,
        "--texture-scale", &texture_scale,
    ]);

    // Pass the specific livery title to convert only that livery
    if !livery_title.is_empty() {
        cmd.args(["--liveries", &livery_title]);
    }

    // Note: texture_dirs are pre-computed during indexing but not passed to converter
    // (converter auto-detects textures in source directory tree)
    let _ = texture_dirs;

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
        // Construct expected output path (matches Python converter naming)
        // Python creates: {outputDir}/{source}_{liveryTitle}.glb
        let source_type = if folder_name.to_lowercase().starts_with("fsltl") {
            "fsltl"
        } else {
            "aig"
        };
        let output_file = format!("{}_{}.glb", source_type, livery_title);
        let output_path = PathBuf::from(&output_dir).join(&output_file);
        let output_path_str = normalize_path_string(&output_path);

        println!("[MSFSConvert] Converted {} in {}ms -> {}",
            folder_name,
            duration_ms,
            output_path_str);
        Ok(MSFSConversionResult {
            success: true,
            output_path: Some(output_path_str),
            error: None,
            duration_ms,
        })
    } else {
        let error_msg = if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else {
            format!("Conversion failed with exit code: {:?}", output.status.code())
        };

        println!("[MSFSConvert] Failed to convert {}: {}", folder_name, error_msg);

        Ok(MSFSConversionResult {
            success: false,
            output_path: None,
            error: Some(error_msg),
            duration_ms,
        })
    }
}

// =============================================================================
// TAURI COMMANDS - SCANNING
// =============================================================================

/// Scan a converted models output directory for existing models
/// Returns info about all model.glb files found
/// Directory structure: outputPath/TYPE/AIRLINE/model.glb or outputPath/TYPE/base/model.glb
///
/// Note: This function was renamed from scan_fsltl_models since it scans any
/// converted models, regardless of source (FSLTL, AIG, or future sources).
#[tauri::command]
pub fn scan_converted_models(output_path: String) -> Result<Vec<ScannedConvertedModel>, String> {
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

            models.push(ScannedConvertedModel {
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

    println!("[MSFS] Scanned {} existing models from {}", models.len(), output_path);
    Ok(models)
}

/// Extract converter version from a GLB file's metadata
fn get_glb_converter_version(glb_path: &std::path::Path) -> Option<u32> {
    use std::io::Read;

    let mut file = fs::File::open(glb_path).ok()?;

    // Read GLB header (12 bytes)
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;

    // Verify magic number "glTF" (0x46546C67)
    if &header[0..4] != b"glTF" {
        return None;
    }

    // Read JSON chunk header (8 bytes)
    let mut chunk_header = [0u8; 8];
    file.read_exact(&mut chunk_header).ok()?;

    let json_length = u32::from_le_bytes([chunk_header[0], chunk_header[1], chunk_header[2], chunk_header[3]]);
    let chunk_type = u32::from_le_bytes([chunk_header[4], chunk_header[5], chunk_header[6], chunk_header[7]]);

    // Verify JSON chunk type (0x4E4F534A "JSON")
    if chunk_type != 0x4E4F534A {
        return None;
    }

    // Read JSON data (limit to 1MB to avoid huge allocations)
    let json_length = json_length.min(1024 * 1024) as usize;
    let mut json_bytes = vec![0u8; json_length];
    file.read_exact(&mut json_bytes).ok()?;

    // Parse JSON
    let json_str = String::from_utf8(json_bytes).ok()?;
    let gltf: serde_json::Value = serde_json::from_str(&json_str).ok()?;

    // Extract asset.extras.towercab3d.converterVersion
    gltf.get("asset")?
        .get("extras")?
        .get("towercab3d")?
        .get("converterVersion")?
        .as_u64()
        .map(|v| v as u32)
}

/// Scan cache directory for existing GLB files
/// Returns info about each cached model for loading into memory cache
#[tauri::command]
pub fn scan_cache_directory(cache_dir: String) -> Result<Vec<CachedGlbInfo>, String> {
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
                        let converter_version = get_glb_converter_version(&path);
                        cached_models.push(CachedGlbInfo {
                            path: normalize_path_string(&path),
                            model_key,
                            file_size,
                            converter_version,
                        });
                    }
                }
            }
        }
    }

    Ok(cached_models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_parse_aig_aircraft_cfg() {
        // Test parsing AIG aircraft.cfg files which use Windows-1252 encoding
        let path = PathBuf::from(r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci\SimObjects\Airplanes\AIGAIM_FAIB_A320-200_IAE");
        if !path.exists() {
            println!("Skipping test - AIG path not found");
            return;
        }

        let liveries = parse_aircraft_cfg_all_liveries(&path);
        println!("Found {} liveries", liveries.len());
        assert!(!liveries.is_empty(), "Should have parsed some liveries");

        // Verify United Airlines is found with correct title format
        let united = liveries.iter().find(|l| l.title.contains("United Airlines"));
        assert!(united.is_some(), "Should find United Airlines livery");

        let u = united.unwrap();
        assert_eq!(u.title, "AIGAIM_United Airlines Airbus A320-200");
        assert_eq!(u.icao_airline.as_deref(), Some("UAL"));
        println!("Found United: title='{}', icao_airline={:?}", u.title, u.icao_airline);
    }
}
