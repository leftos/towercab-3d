//! MSFS (Microsoft Flight Simulator) model handling.
//!
//! This module handles:
//! - Detecting MSFS model sources (FSLTL, AIG)
//! - Listing available models from each source
//! - Converting models on-demand (GLTF -> GLB)
//! - Scanning converted models in output directories
//! - Model index caching for performance

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::{Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::{normalize_path_string, to_extended_length_path};

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
    pub source: String,               // "fsltl" or "aig"
    pub model_name: String,           // Display name (from aircraft.cfg title)
    pub folder_name: String,          // Actual folder name (e.g., "FSLTL_A320_BAW_IAE")
    pub aircraft_folder_path: String, // Full path to the aircraft folder
    pub gltf_path: String,
    pub texture_dirs: Vec<String>,
    pub aircraft_type: String,        // ICAO type designator (e.g., "CRJ2") - the only criterion for type matching
    pub airline_code: Option<String>, // ICAO airline code, "ZZZZ" for generic, None for private aircraft
    pub atc_id: Option<String>,       // Aircraft registration (e.g., "N100VE") - for private aircraft matching
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
#[derive(Debug, Clone)]
struct AircraftCfgLivery {
    title: String,
    texture_folder: String,
    icao_airline: Option<String>,
    atc_id: Option<String>, // Aircraft registration (e.g., "N100VE") for private aircraft matching
}

/// All parsed data from aircraft.cfg in a single read
/// This avoids reading the file multiple times per folder
#[derive(Debug, Clone, Default)]
struct ParsedAircraftCfg {
    /// ICAO type designator from [General] section (e.g., "CRJ2")
    icao_type: Option<String>,
    /// Model folder name from first [fltsim] section (e.g., "200")
    model_folder: Option<String>,
    /// Base container from [VARIATION] section (e.g., "..\FSLTL_B77LF")
    /// This is used by FSLTL to specify a different base model folder
    base_container: Option<String>,
    /// All liveries from [fltsim] sections
    liveries: Vec<AircraftCfgLivery>,
}

/// Parse aircraft.cfg once and extract all needed information
fn parse_aircraft_cfg_unified(aircraft_dir: &std::path::Path) -> ParsedAircraftCfg {
    let cfg_path = aircraft_dir.join("aircraft.cfg");
    if !cfg_path.exists() {
        return ParsedAircraftCfg::default();
    }

    let content = match fs::read(&cfg_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return ParsedAircraftCfg::default(),
    };

    let mut result = ParsedAircraftCfg::default();
    let mut in_general_section = false;
    let mut in_variation_section = false;
    let mut in_fltsim_section = false;
    let mut first_fltsim_seen = false;
    let mut current_title: Option<String> = None;
    let mut current_texture: Option<String> = None;
    let mut current_icao_airline: Option<String> = None;
    let mut current_atc_id: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            // Save previous livery if complete
            if in_fltsim_section {
                if let (Some(title), Some(texture)) = (current_title.take(), current_texture.take()) {
                    result.liveries.push(AircraftCfgLivery {
                        title,
                        texture_folder: texture,
                        icao_airline: current_icao_airline.take(),
                        atc_id: current_atc_id.take(),
                    });
                }
            }

            let section_lower = trimmed.to_lowercase();
            in_general_section = section_lower == "[general]";
            in_variation_section = section_lower == "[variation]";
            in_fltsim_section = section_lower.starts_with("[fltsim");

            if in_fltsim_section {
                current_title = None;
                current_texture = Some(String::new()); // Default empty for FSLTL generic
                current_icao_airline = None;
                current_atc_id = None;
            }
            continue;
        }

        let lower = trimmed.to_lowercase();

        // Parse [General] section - only need ICAO type designator
        if in_general_section && lower.starts_with("icao_type_designator") {
            if let Some(val) = extract_cfg_value_inline(trimmed) {
                result.icao_type = Some(val.to_uppercase());
            }
        }

        // Parse [VARIATION] section - base_container specifies the base model folder
        if in_variation_section && lower.starts_with("base_container") {
            if let Some(val) = extract_cfg_value_inline(trimmed) {
                // Store the raw value (e.g., "..\FSLTL_B77LF")
                result.base_container = Some(val);
            }
        }

        // Parse [fltsim] sections
        if in_fltsim_section {
            if lower.starts_with("title") {
                if let Some(val) = extract_cfg_value_inline(trimmed) {
                    current_title = Some(val);
                }
            } else if lower.starts_with("texture") && !lower.starts_with("texture.") {
                if let Some(val) = extract_cfg_value_inline(trimmed) {
                    current_texture = Some(val);
                }
            } else if lower.starts_with("icao_airline") {
                if let Some(val) = extract_cfg_value_inline(trimmed) {
                    current_icao_airline = Some(val.to_uppercase());
                }
            } else if lower.starts_with("atc_id") {
                if let Some(val) = extract_cfg_value_inline(trimmed) {
                    current_atc_id = Some(val.to_uppercase());
                }
            } else if lower.starts_with("model=") && !first_fltsim_seen {
                // Only capture model folder from FIRST fltsim section
                if let Some(val) = extract_cfg_value_inline(trimmed) {
                    if !val.is_empty() {
                        result.model_folder = Some(val.to_lowercase());
                        first_fltsim_seen = true;
                    }
                }
            }
        }
    }

    // Don't forget last livery
    if in_fltsim_section {
        if let (Some(title), Some(texture)) = (current_title, current_texture) {
            result.liveries.push(AircraftCfgLivery {
                title,
                texture_folder: texture,
                icao_airline: current_icao_airline,
                atc_id: current_atc_id,
            });
        }
    }

    result
}

/// Extract value from cfg line (inline version to avoid function call overhead)
#[inline]
fn extract_cfg_value_inline(line: &str) -> Option<String> {
    let eq_pos = line.find('=')?;
    let mut value = line[eq_pos + 1..].trim();
    if let Some(semi_pos) = value.find(';') {
        value = &value[..semi_pos];
    }
    let value = value.trim().trim_matches('"').trim();
    if value.is_empty() { None } else { Some(value.to_string()) }
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

const MODEL_CACHE_VERSION: u32 = 9; // Bump when cache format changes (v9: exclude cargo/attachment GTLFs, fix single-digit LOD matching)

/// Get the modification time of a folder (recursive max mtime would be too slow)
fn get_folder_mtime(path: &std::path::Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
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
fn load_model_cache(
    cache_dir: &std::path::Path,
    base_path: &std::path::Path,
    source: &str,
) -> Option<Vec<SourceModelInfo>> {
    let cache_path = get_cache_path(cache_dir, source);
    if !cache_path.exists() {
        return None;
    }

    let cache_content = fs::read_to_string(&cache_path).ok()?;
    let cache: ModelIndexCache = serde_json::from_str(&cache_content).ok()?;

    // Check version
    if cache.version != MODEL_CACHE_VERSION {
        tracing::info!(
            "[MSFSDetection] {} cache version mismatch (have {}, need {}), will rebuild",
            source,
            cache.version,
            MODEL_CACHE_VERSION
        );
        return None;
    }

    // Check if folder mtime has changed
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    let current_mtime = get_folder_mtime(&airplanes)?;

    if cache.folder_mtime != current_mtime {
        tracing::info!("[MSFSDetection] {} folder modified, cache invalid", source);
        return None;
    }

    tracing::info!(
        "[MSFSDetection] Loaded {} models from {} cache",
        cache.models.len(),
        source
    );
    Some(cache.models)
}

/// Save model index to cache
/// cache_dir: app data directory for storing cache files
/// base_path: source folder path (for mtime)
fn save_model_cache(
    cache_dir: &std::path::Path,
    base_path: &std::path::Path,
    source: &str,
    models: &[SourceModelInfo],
) {
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    let Some(folder_mtime) = get_folder_mtime(&airplanes) else {
        return;
    };

    let cache = ModelIndexCache {
        folder_mtime,
        version: MODEL_CACHE_VERSION,
        models: models.to_vec(),
    };

    // Ensure cache directory exists
    if let Err(e) = fs::create_dir_all(cache_dir) {
        tracing::info!("[MSFSDetection] Failed to create cache directory: {}", e);
        return;
    }

    let cache_path = get_cache_path(cache_dir, source);
    if let Ok(content) = serde_json::to_string(&cache) {
        if let Err(e) = fs::write(&cache_path, content) {
            tracing::info!("[MSFSDetection] Failed to write {} cache: {}", source, e);
        } else {
            tracing::info!(
                "[MSFSDetection] Saved {} models to {} cache",
                models.len(),
                source
            );
        }
    }
}

// =============================================================================
// AIRCRAFT.CFG PARSING
// =============================================================================

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
/// Extract LOD number from a filename for priority sorting.
/// Handles both single-digit (LOD0) and double-digit (LOD00) patterns.
/// Returns the LOD number, or 100 for non-LOD files (lowest priority).
fn gltf_lod_priority(filename: &str) -> i32 {
    let lower = filename.to_lowercase();
    // Find "lod" followed by digits - extract the number
    if let Some(lod_pos) = lower.find("lod") {
        let after_lod = &lower[lod_pos + 3..];
        let digit_str: String = after_lod.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digit_str.parse::<i32>() {
            return n;
        }
    }
    100 // No LOD number found - lowest priority
}

/// Check if a GLTF filename is an attachment/sub-model (not the main aircraft).
/// MSFS uses separate GLTF files for cargo doors, cockpit, interior, etc.
fn is_attachment_gltf(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.contains("cockpit")
        || lower.contains("interior")
        || lower.contains("cargo")
}

fn find_gltf_in_dir(aircraft_dir: &std::path::Path) -> Option<String> {
    let model_dirs: Vec<_> = fs::read_dir(aircraft_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir()
                && e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with("model")
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
                e.path()
                    .extension()
                    .map(|ext| ext.to_string_lossy().to_lowercase() == "gltf")
                    .unwrap_or(false)
            })
            .collect();

        // Prefer exterior model: exclude attachments, prefer lower LOD numbers
        let exterior_gltf = gltf_files
            .iter()
            .filter(|e| {
                let fname = e.file_name();
                let name = fname.to_string_lossy();
                !is_attachment_gltf(&name)
            })
            .min_by_key(|e| {
                let fname = e.file_name();
                let name = fname.to_string_lossy();
                gltf_lod_priority(&name)
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

/// Find GLTF file inside a model.XXX directory
/// Prefers exterior models (excludes cockpit/interior), prefers lower LOD numbers
fn find_gltf_in_model_dir(model_dir: &std::path::Path) -> Option<String> {
    let gltf_files: Vec<_> = fs::read_dir(model_dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext.to_string_lossy().to_lowercase() == "gltf")
                .unwrap_or(false)
        })
        .collect();

    // Prefer exterior model: exclude attachments, prefer lower LOD numbers
    let exterior_gltf = gltf_files
        .iter()
        .filter(|e| {
            let fname = e.file_name();
            let name = fname.to_string_lossy();
            !is_attachment_gltf(&name)
        })
        .min_by_key(|e| {
            let fname = e.file_name();
            let name = fname.to_string_lossy();
            gltf_lod_priority(&name)
        });

    exterior_gltf.map(|e| normalize_path_string(&e.path()))
}

/// Parse an MSFS model XML file to find the GLTF filename.
///
/// MSFS model XMLs have a LODS section listing the model files:
/// ```xml
/// <LODS>
///   <LOD minSize="8" ModelFile="B772_PW_LOD0.gltf"/>
///   <LOD minSize="1" ModelFile="B772_PW_LOD1.gltf"/>
/// </LODS>
/// ```
///
/// Returns the path to the highest-quality LOD (highest minSize), or None.
fn parse_model_xml(xml_path: &std::path::Path) -> Option<String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let content = fs::read_to_string(xml_path).ok()?;
    let mut reader = Reader::from_str(&content);

    let mut best_lod: Option<(i32, String)> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) if e.name().as_ref() == b"LOD" => {
                let mut min_size = 0i32;
                let mut model_file = String::new();

                for attr in e.attributes().filter_map(|a| a.ok()) {
                    match attr.key.as_ref() {
                        b"minSize" => {
                            if let Ok(s) = std::str::from_utf8(&attr.value) {
                                min_size = s.parse().unwrap_or(0);
                            }
                        }
                        b"ModelFile" => {
                            if let Ok(s) = std::str::from_utf8(&attr.value) {
                                model_file = s.to_string();
                            }
                        }
                        _ => {}
                    }
                }

                if !model_file.is_empty()
                    && (best_lod.is_none() || min_size > best_lod.as_ref().unwrap().0)
                {
                    best_lod = Some((min_size, model_file));
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    if let Some((_, model_file)) = best_lod {
        let gltf_path = xml_path.parent()?.join(&model_file);
        if gltf_path.exists() {
            return Some(normalize_path_string(&gltf_path));
        }
    }

    None
}

/// Parse a model.cfg file to find the referenced base GLTF.
///
/// MSFS livery folders have a model.XXX/model.cfg that points to the base model:
/// ```ini
/// [models]
/// normal=..\..\FSLTL_A320\model.iae\FAIB_A320_IAE.xml
/// ```
///
/// This function:
/// 1. Parses model.cfg to find the `normal=` line
/// 2. Resolves the relative path to find the XML file
/// 3. Parses the XML to get the actual GLTF filename
///
/// Returns the resolved GLTF path, or None.
fn parse_model_cfg(model_cfg_path: &std::path::Path) -> Option<String> {
    let content = fs::read_to_string(model_cfg_path).ok()?;
    let parent_dir = model_cfg_path.parent()?;

    for line in content.lines() {
        let line = line.trim();
        let lower = line.to_lowercase();

        if lower.starts_with("normal=") {
            // Extract the path after "normal="
            let rel_path = line.split_once('=')?.1.trim();
            if rel_path.is_empty() {
                continue;
            }

            // Convert backslashes to forward slashes for path joining
            let rel_path = rel_path.replace('\\', "/");

            // The path should point to an .xml file
            if rel_path.to_lowercase().ends_with(".xml") {
                // Resolve relative to model.cfg's parent directory
                let xml_path = parent_dir.join(&rel_path);
                let xml_path = match xml_path.canonicalize() {
                    Ok(p) => p,
                    Err(_) => xml_path, // Try non-canonicalized if it fails
                };

                if xml_path.exists() {
                    // Parse the XML to get the actual GLTF filename
                    if let Some(gltf_path) = parse_model_xml(&xml_path) {
                        return Some(gltf_path);
                    }
                }

                // Fallback: derive GLTF name from XML name
                // e.g., model.iae/FAIB_A320_IAE.xml -> model.iae/FAIB_A320_IAE_LOD0.gltf
                let gltf_base = rel_path.trim_end_matches(".xml").trim_end_matches(".XML");
                let abs_path = parent_dir.join(gltf_base);
                if let Some(gltf_dir) = abs_path.parent() {
                    if let Some(gltf_stem) = abs_path.file_name() {
                        let gltf_stem = gltf_stem.to_string_lossy();
                        // Look for LOD0 first (highest quality), then any LOD
                        for suffix in ["_LOD0.gltf", "_LOD0.GLTF", "_LOD1.gltf", "_LOD1.GLTF"] {
                            let candidate = gltf_dir.join(format!("{}{}", gltf_stem, suffix));
                            if candidate.exists() {
                                return Some(normalize_path_string(&candidate));
                            }
                        }
                        // Fall back to any GLTF with matching prefix
                        if let Ok(entries) = fs::read_dir(gltf_dir) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                let name = entry.file_name().to_string_lossy().to_string();
                                if name.starts_with(&*gltf_stem)
                                    && (name.to_lowercase().ends_with(".gltf"))
                                {
                                    return Some(normalize_path_string(&entry.path()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

/// Resolve GLTF path by checking model.cfg files in an aircraft directory.
///
/// This is used for livery-only folders that don't contain GLTF files directly,
/// but have a model.XXX/model.cfg that references a base model's XML file.
///
/// Returns (gltf_path, base_model_dir) where base_model_dir is the parent folder
/// of the resolved GLTF (useful for texture fallback).
fn resolve_gltf_via_model_cfg(aircraft_dir: &std::path::Path) -> Option<(String, PathBuf)> {
    // Find all model.* directories
    let model_dirs: Vec<_> = fs::read_dir(aircraft_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir()
                && e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with("model")
        })
        .collect();

    for model_dir_entry in model_dirs {
        let model_dir = model_dir_entry.path();

        // Look for model.cfg (case-insensitive)
        let model_cfg = if model_dir.join("model.cfg").exists() {
            model_dir.join("model.cfg")
        } else if model_dir.join("model.CFG").exists() {
            model_dir.join("model.CFG")
        } else {
            continue;
        };

        if let Some(gltf_path) = parse_model_cfg(&model_cfg) {
            // The base model directory is two levels up from the GLTF file:
            // model.xxx/file.gltf -> aircraft folder
            let gltf_path_buf = PathBuf::from(&gltf_path);
            if let Some(model_subdir) = gltf_path_buf.parent() {
                if let Some(base_dir) = model_subdir.parent() {
                    return Some((gltf_path, base_dir.to_path_buf()));
                }
            }
        }
    }

    None
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
            without_prefix
                .split('-')
                .next()
                .unwrap_or(without_prefix)
                .to_string()
        }
    }
}

/// Unified model listing for MSFS traffic sources (FSLTL and AIG)
///
/// This function handles both source types with a unified approach:
/// 1. Build base model index (for FSLTL's base model fallback pattern)
/// 2. For each aircraft folder, parse ALL FLTSIM sections from aircraft.cfg
/// 3. Create a SourceModelInfo for each livery with correct texture directories
fn list_models_unified(
    base_path: &std::path::Path,
    config: &SourceConfig,
    app: Option<&tauri::AppHandle>,
    event_name: &str,
) -> Vec<SourceModelInfo> {
    let total_start = std::time::Instant::now();
    let airplanes = base_path.join("SimObjects").join("Airplanes");
    if !airplanes.exists() {
        return Vec::new();
    }

    // SINGLE PASS: Parse each aircraft.cfg once and extract all needed data
    // This avoids reading the same file 4+ times per folder
    //
    // We collect:
    // - parsed_cfgs: folder_path -> ParsedAircraftCfg (all cfg data)
    // - base_models: aircraft_type -> (gltf_path, texture_dirs) for FSLTL fallback
    // - aig_shared_models: (icao_type, model_folder) -> gltf_path for AIG

    let parse_start = std::time::Instant::now();

    // Collect all folder paths first
    let folder_paths: Vec<_> = fs::read_dir(&airplanes)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_dir() &&
            e.file_name().to_string_lossy().starts_with(config.folder_prefix)
        })
        .map(|e| e.path())
        .collect();

    let total_folders = folder_paths.len();
    println!("[TIMING] Found {} folders to process", total_folders);

    // Parse all aircraft.cfg files and build indexes
    let mut parsed_cfgs: std::collections::HashMap<PathBuf, ParsedAircraftCfg> =
        std::collections::HashMap::with_capacity(total_folders);
    let mut base_models: std::collections::HashMap<String, (String, Vec<String>)> =
        std::collections::HashMap::new();
    // AIG shared models: (icao_type, model_folder) -> gltf_path
    let mut aig_shared_models: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();

    for aircraft_dir in &folder_paths {
        let folder_name = aircraft_dir.file_name().unwrap().to_string_lossy().to_string();

        // Parse aircraft.cfg ONCE
        let cfg = parse_aircraft_cfg_unified(aircraft_dir);

        // Get aircraft type (from cfg or folder name)
        let aircraft_type = cfg.icao_type.clone()
            .unwrap_or_else(|| parse_aircraft_type(&folder_name, config.folder_prefix));

        // Check if this looks like a base model
        let parts: Vec<&str> = folder_name.split('_').collect();
        let is_base_model = if config.folder_prefix == "FSLTL_" {
            parts.len() == 2 || (parts.len() >= 3 && parts[2] == "ZZZZ")
        } else {
            true // AIG folders are always potential base models
        };

        if is_base_model {
            let texture_dirs = collect_texture_dirs(aircraft_dir);

            // For AIG: Index all model.XXX folders by ICAO type
            if config.folder_prefix == "AIGAIM_" {
                if let Ok(dir_entries) = fs::read_dir(aircraft_dir) {
                    for dir_entry in dir_entries.filter_map(|e| e.ok()) {
                        let subdir = dir_entry.path();
                        if !subdir.is_dir() {
                            continue;
                        }
                        let subdir_name = dir_entry.file_name().to_string_lossy().to_lowercase();
                        if let Some(model_suffix) = subdir_name.strip_prefix("model.") {
                            if let Some(gltf) = find_gltf_in_model_dir(&subdir) {
                                let key = (aircraft_type.clone(), model_suffix.to_string());
                                aig_shared_models.entry(key).or_insert(gltf);
                            }
                        }
                    }
                }
            }

            // Standard base model registration by ICAO type
            if let Some(gltf_path) = find_gltf_in_dir(aircraft_dir) {
                base_models
                    .entry(aircraft_type.clone())
                    .or_insert((gltf_path, texture_dirs));
            }
        }

        // Store parsed cfg for reuse
        parsed_cfgs.insert(aircraft_dir.clone(), cfg);
    }

    let parse_duration = parse_start.elapsed();

    // Now create livery entries using cached parse results
    let livery_start = std::time::Instant::now();
    let mut models = Vec::new();
    let mut processed = 0;
    let mut last_reported_pct = 0;

    for aircraft_dir in &folder_paths {
        let folder_name = aircraft_dir.file_name().unwrap().to_string_lossy().to_string();

        // Get cached parse result (already parsed above)
        let cfg = match parsed_cfgs.get(aircraft_dir) {
            Some(c) => c,
            None => continue,
        };

        let aircraft_type = cfg.icao_type.clone()
            .unwrap_or_else(|| parse_aircraft_type(&folder_name, config.folder_prefix));

        // Resolve base_container if present (e.g., "..\FSLTL_B77LF" -> full path)
        let base_container_path: Option<PathBuf> = cfg.base_container.as_ref().and_then(|bc| {
            // base_container is a relative path like "..\FSLTL_B77LF"
            let resolved = aircraft_dir.join(bc);
            if resolved.exists() && resolved.is_dir() {
                Some(resolved.canonicalize().unwrap_or(resolved))
            } else {
                None
            }
        });

        // Find GLTF - check multiple sources in priority order:
        // 1. Direct GLTF in this folder (base models have GLTF directly)
        // 2. model.cfg reference (livery folders reference base model via model.cfg)
        // 3. FSLTL base_container (e.g., B77LF_FDX -> FSLTL_B77LF for freighter model)
        // 4. For AIG: Pre-built shared model index (by icao_type + model_folder)
        // 5. Base models registry by ICAO type (FSLTL pattern, last resort)
        //
        // Also track if we resolved via model.cfg, as this gives us the base model
        // directory for texture fallback.
        let mut model_cfg_base_dir: Option<PathBuf> = None;

        let gltf_path = find_gltf_in_dir(aircraft_dir)
            .or_else(|| {
                // Check model.cfg files in model.* directories
                // This handles livery-only folders that reference a base model
                if let Some((gltf, base_dir)) = resolve_gltf_via_model_cfg(aircraft_dir) {
                    model_cfg_base_dir = Some(base_dir);
                    return Some(gltf);
                }
                None
            })
            .or_else(|| {
                // Check base_container's model folder (FSLTL variation pattern)
                if let Some(ref bc_path) = base_container_path {
                    return find_gltf_in_dir(bc_path);
                }
                None
            })
            .or_else(|| {
                if config.folder_prefix == "AIGAIM_" {
                    let model_folder = cfg.model_folder.as_ref()?;
                    let key = (aircraft_type.clone(), model_folder.clone());
                    aig_shared_models.get(&key).cloned()
                } else {
                    None
                }
            })
            .or_else(|| base_models.get(&aircraft_type).map(|(p, _)| p.clone()));

        let gltf_path = match gltf_path {
            Some(p) => p,
            None => continue, // Skip if no GLTF found
        };

        // Collect shared texture directories (oci.* folders, base_container textures, base model textures)
        let shared_texture_dirs: Vec<String> = {
            let mut dirs: Vec<String> = fs::read_dir(aircraft_dir)
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

            // Add base_container texture directories as higher priority fallback
            // (e.g., FSLTL_B77LF/TEXTURE for freighter models)
            if let Some(ref bc_path) = base_container_path {
                let bc_texture_dirs = collect_texture_dirs(bc_path);
                for bc_dir in bc_texture_dirs {
                    if !dirs.contains(&bc_dir) {
                        dirs.push(bc_dir);
                    }
                }
            }

            // Add model.cfg base directory texture directories
            // (e.g., FSLTL_A321/TEXTURE when A321_DAL references it via model.cfg)
            if let Some(ref cfg_base) = model_cfg_base_dir {
                let cfg_texture_dirs = collect_texture_dirs(cfg_base);
                for cfg_dir in cfg_texture_dirs {
                    if !dirs.contains(&cfg_dir) {
                        dirs.push(cfg_dir);
                    }
                }
            }

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

        // Use cached liveries from parsed cfg (no re-parsing!)
        let liveries = &cfg.liveries;

        if !liveries.is_empty() {
            // Scan texture directories ONCE for this folder (not per-livery!)
            let mut folder_texture_dirs: Vec<String> = fs::read_dir(aircraft_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    e.path().is_dir() && name.starts_with("texture")
                })
                .map(|e| normalize_path_string(&e.path()))
                .collect();

            // Add shared texture directories as fallback
            folder_texture_dirs.extend(shared_texture_dirs.clone());

            // Create entry for each livery defined in aircraft.cfg
            for livery in liveries.iter() {
                // Use icao_airline from aircraft.cfg (fall back to texture folder parsing if not present)
                let airline_code = livery.icao_airline.clone().or_else(|| {
                    livery
                        .texture_folder
                        .split('-')
                        .next()
                        .map(|s| s.to_uppercase())
                        .filter(|s| s.len() == 3 || s.len() == 4)
                });

                // Build livery-specific texture_dirs:
                // 1. The livery's specific texture folder (e.g., "texture.ASA") - FIRST/PRIMARY
                // 2. Shared texture directories as fallback
                // This ensures the correct livery textures are used, not just alphabetically first
                let mut livery_texture_dirs: Vec<String> = Vec::new();

                // Add the livery-specific texture folder first (highest priority)
                if !livery.texture_folder.is_empty() {
                    // Try both "texture.{name}" and "Texture.{name}" patterns
                    let specific_texture_dir = aircraft_dir.join(format!("texture.{}", livery.texture_folder));
                    let specific_texture_dir_cap = aircraft_dir.join(format!("Texture.{}", livery.texture_folder));

                    if specific_texture_dir.exists() {
                        livery_texture_dirs.push(normalize_path_string(&specific_texture_dir));
                    } else if specific_texture_dir_cap.exists() {
                        livery_texture_dirs.push(normalize_path_string(&specific_texture_dir_cap));
                    }
                }

                // Add other texture directories as fallback (for shared textures like portholes)
                for dir in &folder_texture_dirs {
                    if !livery_texture_dirs.contains(dir) {
                        livery_texture_dirs.push(dir.clone());
                    }
                }

                models.push(SourceModelInfo {
                    source: config.source.to_string(),
                    model_name: livery.title.clone(),
                    folder_name: folder_name.clone(),
                    aircraft_folder_path: normalize_path_string(aircraft_dir),
                    gltf_path: gltf_path.clone(),
                    texture_dirs: livery_texture_dirs,
                    aircraft_type: aircraft_type.clone(),
                    airline_code,
                    atc_id: livery.atc_id.clone(),
                });
            }
        } else {
            // Fallback: No aircraft.cfg liveries found
            // Scan texture.* folders and create entries for each
            let livery_folders: Vec<_> = fs::read_dir(aircraft_dir)
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
                        aircraft_folder_path: normalize_path_string(aircraft_dir),
                        gltf_path: gltf_path.clone(),
                        texture_dirs,
                        aircraft_type: aircraft_type.clone(),
                        airline_code,
                        atc_id: None, // No atc_id available in fallback mode
                    });
                }
            } else {
                // No texture.* folders - create single entry with all textures
                let all_texture_dirs = collect_texture_dirs(aircraft_dir);

                // Try to get title from aircraft.cfg, fall back to folder name
                let model_name = parse_aircraft_cfg_title(aircraft_dir)
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
                    aircraft_folder_path: normalize_path_string(aircraft_dir),
                    gltf_path: gltf_path.clone(),
                    texture_dirs: all_texture_dirs,
                    aircraft_type: aircraft_type.clone(),
                    airline_code,
                    atc_id: None, // No atc_id available in fallback mode
                });
            }
        }

        // Update progress tracking
        processed += 1;
        if total_folders > 0 {
            let pct = (processed * 100 / total_folders) as u32;
            // Only emit every 5% to avoid flooding events
            if pct >= last_reported_pct + 5 || processed == total_folders {
                last_reported_pct = pct;
                if let Some(app_handle) = app {
                    let _ = app_handle.emit(
                        event_name,
                        serde_json::json!({
                            "progress": pct,
                            "processed": processed,
                            "total": total_folders
                        }),
                    );
                }
            }
        }
    }

    println!(
        "[TIMING] list_models_unified: {} models in {:?} (parse={:?}, liveries={:?})",
        models.len(),
        total_start.elapsed(),
        parse_duration,
        livery_start.elapsed()
    );

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
        return Err(format!(
            "Community folder does not exist: {}",
            community_path
        ));
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

    tracing::info!(
        "[MSFSDetection] FSLTL: {} ({:?}), AIG: {} ({:?})",
        result.fsltl_found,
        result.fsltl_model_count,
        result.aig_found,
        result.aig_model_count
    );

    Ok(result)
}

// =============================================================================
// TAURI COMMANDS - SOURCE LISTING
// =============================================================================

/// List available FSLTL models from source
/// Uses unified listing logic that parses ALL FLTSIM sections from aircraft.cfg
#[tauri::command]
pub async fn list_fsltl_models(
    app: tauri::AppHandle,
    base_path: String,
) -> Result<Vec<SourceModelInfo>, String> {
    // Run on background thread to avoid blocking UI
    tokio::task::spawn_blocking(move || {
        let base = PathBuf::from(&base_path);
        let cache_dir = app
            .path()
            .app_data_dir()
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

        let models = list_models_unified(&base, &config, Some(&app), "msfs-indexing-progress");

        let elapsed = start_time.elapsed();
        tracing::info!(
            "[MSFSDetection] Indexed {} FSLTL liveries in {:?}",
            models.len(),
            elapsed
        );

        // Save to cache for faster subsequent launches
        save_model_cache(&cache_dir, &base, "fsltl", &models);

        Ok(models)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// List available AIG models from source
/// Uses unified listing logic that parses ALL FLTSIM sections from aircraft.cfg
#[tauri::command]
pub async fn list_aig_models(
    app: tauri::AppHandle,
    base_path: String,
) -> Result<Vec<SourceModelInfo>, String> {
    // Run on background thread to avoid blocking UI
    tokio::task::spawn_blocking(move || {
        let base = PathBuf::from(&base_path);
        let cache_dir = app
            .path()
            .app_data_dir()
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

        let models = list_models_unified(&base, &config, Some(&app), "msfs-indexing-progress");

        let elapsed = start_time.elapsed();
        tracing::info!(
            "[MSFSDetection] Indexed {} AIG liveries in {:?}",
            models.len(),
            elapsed
        );

        // Save to cache for faster subsequent launches
        save_model_cache(&cache_dir, &base, "aig", &models);

        Ok(models)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
/// - gltf_path: Explicit GLTF path (for AIG shared models where GLTF is in a different folder)
/// - texture_dirs: Pre-computed texture directories from model indexing
// Each argument is part of the Tauri IPC contract deserialized from the
// frontend; grouping them into a struct would break that surface.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn convert_msfs_model(
    app: tauri::AppHandle,
    source_path: String,
    folder_name: String,
    output_dir: String,
    texture_scale: String,
    livery_title: String,
    gltf_path: Option<String>,
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
            "Converter executable not found. Ensure fsltl_converter.exe is in resources/"
                .to_string()
        })?
        .clone();

    // Create output directory if needed
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Build command arguments with extended-length paths to support paths > 260 chars on Windows
    let ext_source = to_extended_length_path(&source_path);
    let ext_output = to_extended_length_path(&output_dir);

    let mut cmd = Command::new(&converter_path);
    cmd.args([
        "--source",
        &ext_source,
        "--output",
        &ext_output,
        "--texture-scale",
        &texture_scale,
    ]);

    // Pass the specific livery title to convert only that livery
    if !livery_title.is_empty() {
        cmd.args(["--liveries", &livery_title]);
    }

    // Use --no-discovery mode: Rust has already resolved all paths via model.cfg parsing,
    // so we skip Python's discovery and pass all required data directly.
    // This ensures consistent behavior - Rust is the single source of truth for path resolution.
    let use_no_discovery = gltf_path.as_ref().is_some_and(|p| !p.is_empty())
        && texture_dirs.as_ref().is_some_and(|t| !t.is_empty())
        && !livery_title.is_empty();

    if use_no_discovery {
        cmd.arg("--no-discovery");
    }

    // Pass GLTF path (required for --no-discovery, optional otherwise)
    if let Some(gltf) = &gltf_path {
        if !gltf.is_empty() {
            let ext_gltf = to_extended_length_path(gltf);
            cmd.args(["--gltf-path", &ext_gltf]);
        }
    }

    // Pass texture directories (required for --no-discovery, optional otherwise)
    if let Some(tex_dirs) = &texture_dirs {
        if !tex_dirs.is_empty() {
            // Convert each texture directory to extended-length path
            let ext_tex_dirs: Vec<String> = tex_dirs
                .iter()
                .map(|d| to_extended_length_path(d))
                .collect();
            let tex_dirs_str = ext_tex_dirs.join(",");
            cmd.args(["--texture-dirs", &tex_dirs_str]);
        }
    }

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
        tracing::info!("[MSFSConvert] stderr: {}", stderr);
    }
    if !stdout.is_empty() {
        tracing::info!("[MSFSConvert] stdout: {}", stdout);
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

        tracing::info!(
            "[MSFSConvert] Converted {} in {}ms -> {}",
            folder_name,
            duration_ms,
            output_path_str
        );
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
            format!(
                "Conversion failed with exit code: {:?}",
                output.status.code()
            )
        };

        tracing::info!(
            "[MSFSConvert] Failed to convert {}: {}",
            folder_name,
            error_msg
        );

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

    let json_length = u32::from_le_bytes([
        chunk_header[0],
        chunk_header[1],
        chunk_header[2],
        chunk_header[3],
    ]);
    let chunk_type = u32::from_le_bytes([
        chunk_header[4],
        chunk_header[5],
        chunk_header[6],
        chunk_header[7],
    ]);

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
pub async fn scan_cache_directory(cache_dir: String) -> Result<Vec<CachedGlbInfo>, String> {
    // Run on background thread to avoid blocking UI
    tokio::task::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// =============================================================================
// SERVER API HELPERS - For remote browser access
// =============================================================================

/// Get the combined model index for remote clients
/// Returns a JSON object with fsltl and aig model arrays
pub fn get_model_index(app: &tauri::AppHandle) -> Result<serde_json::Value, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Read the cached model indexes
    let fsltl_cache_path = cache_dir.join("fsltl_model_cache.json");
    let aig_cache_path = cache_dir.join("aig_model_cache.json");

    let fsltl_models: Vec<SourceModelInfo> = if fsltl_cache_path.exists() {
        let content = fs::read_to_string(&fsltl_cache_path)
            .map_err(|e| format!("Failed to read FSLTL cache: {}", e))?;
        let cache: ModelIndexCache = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse FSLTL cache: {}", e))?;
        cache.models
    } else {
        Vec::new()
    };

    let aig_models: Vec<SourceModelInfo> = if aig_cache_path.exists() {
        let content = fs::read_to_string(&aig_cache_path)
            .map_err(|e| format!("Failed to read AIG cache: {}", e))?;
        let cache: ModelIndexCache = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse AIG cache: {}", e))?;
        cache.models
    } else {
        Vec::new()
    };

    Ok(serde_json::json!({
        "fsltl": fsltl_models,
        "aig": aig_models,
        "totalCount": fsltl_models.len() + aig_models.len()
    }))
}

/// Convert a model by name - looks up the model in the index and triggers conversion
/// Returns the relative path to the converted GLB file
pub fn convert_model_by_name(
    app: &tauri::AppHandle,
    model_name: &str,
    texture_scale: &str,
) -> Result<String, String> {
    // First, find the model in the index
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Search in both FSLTL and AIG caches
    let mut found_model: Option<SourceModelInfo> = None;

    for source in ["fsltl", "aig"] {
        let cache_path = cache_dir.join(format!("{}_model_cache.json", source));
        if cache_path.exists() {
            if let Ok(content) = fs::read_to_string(&cache_path) {
                if let Ok(cache) = serde_json::from_str::<ModelIndexCache>(&content) {
                    // Search by model_name (display name from aircraft.cfg title)
                    if let Some(model) = cache.models.iter().find(|m| m.model_name == model_name) {
                        found_model = Some(model.clone());
                        break;
                    }
                }
            }
        }
    }

    let model = found_model.ok_or_else(|| format!("Model not found: {}", model_name))?;

    // Get the cache directory from settings
    let settings_file = crate::settings::get_global_settings_file(app)
        .map_err(|e| format!("Failed to get settings file: {}", e))?;

    let output_dir = if settings_file.exists() {
        let content = fs::read_to_string(&settings_file)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        let settings: crate::settings::GlobalSettings = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))?;
        settings.msfs_models.cache_directory.clone()
    } else {
        None
    };

    let output_dir = output_dir.ok_or("MSFS model cache directory not configured")?;

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
        .ok_or_else(|| "Converter executable not found".to_string())?
        .clone();

    // Create output directory if needed
    fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;

    // Build command arguments with extended-length paths to support paths > 260 chars on Windows
    let ext_source = to_extended_length_path(&model.aircraft_folder_path);
    let ext_output = to_extended_length_path(&output_dir);

    let mut cmd = Command::new(&converter_path);
    cmd.args([
        "--source",
        &ext_source,
        "--output",
        &ext_output,
        "--texture-scale",
        texture_scale,
        "--liveries",
        &model.model_name,
    ]);

    // Pass explicit GLTF path if available
    if !model.gltf_path.is_empty() {
        let ext_gltf = to_extended_length_path(&model.gltf_path);
        cmd.args(["--gltf-path", &ext_gltf]);
    }

    // Pass texture directories if available
    if !model.texture_dirs.is_empty() {
        // Convert each texture directory to extended-length path
        let ext_tex_dirs: Vec<String> = model
            .texture_dirs
            .iter()
            .map(|d| to_extended_length_path(d))
            .collect();
        let tex_dirs_str = ext_tex_dirs.join(",");
        cmd.args(["--texture-dirs", &tex_dirs_str]);
    }

    // Hide console window on Windows
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    // Execute and wait for completion
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute converter: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Conversion failed: {}", stderr));
    }

    // Return the relative path to the GLB file
    // The converter outputs files as {source}_{model_name}.glb (e.g., fsltl_FSLTL_FAIB_B738_American.glb)
    let glb_filename = format!("{}_{}.glb", model.source, model.model_name);
    Ok(glb_filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_parse_aig_aircraft_cfg() {
        // Test parsing AIG aircraft.cfg files which use Windows-1252 encoding
        let path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci\SimObjects\Airplanes\AIGAIM_FAIB_A320-200_IAE",
        );
        if !path.exists() {
            tracing::info!("Skipping test - AIG path not found");
            return;
        }

        let cfg = parse_aircraft_cfg_unified(&path);
        let liveries = &cfg.liveries;
        tracing::info!("Found {} liveries", liveries.len());
        assert!(!liveries.is_empty(), "Should have parsed some liveries");

        // Verify United Airlines is found with correct title format
        let united = liveries
            .iter()
            .find(|l| l.title.contains("United Airlines"));
        assert!(united.is_some(), "Should find United Airlines livery");

        let u = united.unwrap();
        assert_eq!(u.title, "AIGAIM_United Airlines Airbus A320-200");
        assert_eq!(u.icao_airline.as_deref(), Some("UAL"));
        tracing::info!(
            "Found United: title='{}', icao_airline={:?}",
            u.title,
            u.icao_airline
        );
    }

    #[test]
    fn test_parse_fsltl_generic_model() {
        // Test parsing FSLTL generic models with empty texture fields
        let path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\fsltl-traffic-base\SimObjects\Airplanes\FSLTL_BCS3",
        );
        if !path.exists() {
            tracing::info!("Skipping test - FSLTL BCS3 path not found");
            return;
        }

        let cfg = parse_aircraft_cfg_unified(&path);
        let liveries = &cfg.liveries;
        tracing::info!("Found {} liveries", liveries.len());
        assert!(!liveries.is_empty(), "Should have parsed some liveries");

        // Verify ZZZZ generic model is found
        let generic = liveries.iter().find(|l| l.title.contains("ZZZZ"));
        assert!(generic.is_some(), "Should find ZZZZ generic livery");

        let g = generic.unwrap();
        assert_eq!(g.title, "FSLTL_BCS3_ZZZZ");
        assert_eq!(g.texture_folder, ""); // Empty texture field
        tracing::info!(
            "Found generic: title='{}', texture_folder='{}', icao_airline={:?}",
            g.title,
            g.texture_folder,
            g.icao_airline
        );

        // Verify texture folders are found
        let texture_dirs: Vec<String> = fs::read_dir(&path)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                e.path().is_dir() && name.starts_with("texture")
            })
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        tracing::info!("Texture folders: {:?}", texture_dirs);
        assert!(
            !texture_dirs.is_empty(),
            "Should find at least one texture folder"
        );
    }

    #[test]
    fn test_fsltl_indexing_end_to_end() {
        // Test that FSLTL_BCS3_ZZZZ is properly indexed with correct model_name
        let base_path =
            PathBuf::from(r"X:\Games\MSFlightSimPackages2024\Community\fsltl-traffic-base");
        if !base_path.exists() {
            tracing::info!("Skipping test - FSLTL base path not found");
            return;
        }

        let config = SourceConfig {
            source: "fsltl",
            folder_prefix: "FSLTL_",
        };

        let models = list_models_unified(&base_path, &config, None, "");

        // Find FSLTL_BCS3_ZZZZ
        let bcs3_zzzz = models.iter().find(|m| m.model_name == "FSLTL_BCS3_ZZZZ");
        assert!(
            bcs3_zzzz.is_some(),
            "Should find FSLTL_BCS3_ZZZZ in indexed models"
        );

        let model = bcs3_zzzz.unwrap();
        tracing::info!("Found model:");
        tracing::info!("  model_name: {}", model.model_name);
        tracing::info!("  folder_name: {}", model.folder_name);
        tracing::info!("  aircraft_folder_path: {}", model.aircraft_folder_path);
        tracing::info!("  texture_dirs: {} directories", model.texture_dirs.len());
        for td in &model.texture_dirs {
            let path = PathBuf::from(td);
            tracing::info!("    - {}", path.file_name().unwrap().to_string_lossy());
        }

        assert_eq!(model.model_name, "FSLTL_BCS3_ZZZZ");
        assert!(model.aircraft_folder_path.contains("FSLTL_BCS3"));
        assert!(
            !model.texture_dirs.is_empty(),
            "Should have texture directories"
        );
    }

    #[test]
    fn test_parse_icao_type() {
        // Test parsing ICAO type designator from aircraft.cfg using unified parser
        let crj200_path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci\SimObjects\Airplanes\AIGAIM_RFSL_CRJ-200",
        );
        if !crj200_path.exists() {
            println!("Skipping test - AIGAIM_RFSL_CRJ-200 path not found");
            return;
        }

        let cfg = parse_aircraft_cfg_unified(&crj200_path);
        assert!(cfg.icao_type.is_some(), "Should parse ICAO type for CRJ-200");
        println!("CRJ-200 ICAO type: {:?}", cfg.icao_type);
        assert_eq!(cfg.icao_type.as_deref(), Some("CRJ2"));

        // Verify Challenger850 has the same ICAO type (both are CRJ2)
        let challenger_path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci\SimObjects\Airplanes\AIGAIM_RFSL_Challenger850",
        );
        if challenger_path.exists() {
            let challenger_cfg = parse_aircraft_cfg_unified(&challenger_path);
            assert!(challenger_cfg.icao_type.is_some(), "Should parse ICAO type for Challenger850");
            println!("Challenger850 ICAO type: {:?}", challenger_cfg.icao_type);
            assert_eq!(challenger_cfg.icao_type.as_deref(), Some("CRJ2")); // Same as CRJ-200
        }
    }

    #[test]
    fn test_aig_shared_model_crj200_via_unified_indexing() {
        // Test that CRJ-200 (livery-only folder with model=200) finds a valid GLTF
        // from any folder with the same ICAO type (CRJ2) that has a model.200 folder
        let base_path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci",
        );
        if !base_path.exists() {
            println!("Skipping test - AIG path not found");
            return;
        }

        let config = SourceConfig {
            source: "aig",
            folder_prefix: "AIGAIM_",
        };

        let models = list_models_unified(&base_path, &config, None, "");

        // Find the SkyWest Charter CRJ-200 model
        let crj200_model = models.iter().find(|m| m.model_name.contains("SkyWest Charter") && m.model_name.contains("CRJ-200"));
        assert!(
            crj200_model.is_some(),
            "Should find SkyWest Charter CRJ-200 in indexed models"
        );

        let model = crj200_model.unwrap();
        println!("Found CRJ-200 model:");
        println!("  model_name: {}", model.model_name);
        println!("  folder_name: {}", model.folder_name);
        println!("  gltf_path: {}", model.gltf_path);

        // Verify the GLTF path contains model.200 folder (shared model reference)
        assert!(
            model.gltf_path.contains("model.200") || model.gltf_path.to_lowercase().contains("model.200"),
            "GLTF should be in a model.200 folder, got: {}",
            model.gltf_path
        );

        // Verify the file actually exists
        assert!(
            PathBuf::from(&model.gltf_path).exists(),
            "GLTF file should exist at: {}",
            model.gltf_path
        );
    }

    #[test]
    fn test_aig_crj200_indexing_with_shared_model() {
        // Test that CRJ-200 liveries are indexed with correct gltfPath from shared model
        let base_path =
            PathBuf::from(r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci");
        if !base_path.exists() {
            println!("Skipping test - AIG OCI path not found");
            return;
        }

        let config = SourceConfig {
            source: "aig",
            folder_prefix: "AIGAIM_",
        };

        let models = list_models_unified(&base_path, &config, None, "");

        // Find SkyWest Charter CRJ-200
        let crj200_scw = models.iter().find(|m| {
            m.model_name.contains("SkyWest Charter") && m.model_name.contains("CRJ-200")
        });

        assert!(
            crj200_scw.is_some(),
            "Should find SkyWest Charter CRJ-200 in indexed models"
        );

        let model = crj200_scw.unwrap();
        println!("Found model:");
        println!("  model_name: {}", model.model_name);
        println!("  folder_name: {}", model.folder_name);
        println!("  aircraft_type: {}", model.aircraft_type);
        println!("  airline_code: {:?}", model.airline_code);
        println!("  gltf_path: {}", model.gltf_path);

        // The GLTF path should point to a CRJ family shared model (CRJ-100's model.200)
        // NOT Challenger850's model.200 (even though both have CRJ2 ICAO type)
        assert!(
            !model.gltf_path.is_empty(),
            "Should have a gltf_path"
        );
        assert!(
            model.gltf_path.contains("AIGAIM_RFSL_CRJ-"),
            "GLTF path should be from CRJ family (same aircraft family), not Challenger850. Got: {}",
            model.gltf_path
        );

        // Verify the file exists
        assert!(
            PathBuf::from(&model.gltf_path).exists(),
            "GLTF file should exist at: {}",
            model.gltf_path
        );

        // Verify texture directories were found
        assert!(
            !model.texture_dirs.is_empty(),
            "Should have texture directories"
        );
        println!("  texture_dirs: {} directories", model.texture_dirs.len());
        for td in &model.texture_dirs {
            println!("    - {}", td);
        }
    }
}
