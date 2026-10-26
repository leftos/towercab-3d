//! MSFS (Microsoft Flight Simulator) model handling.
//!
//! This module handles:
//! - Detecting MSFS model sources (FSLTL, AIG)
//! - Listing available models from each source
//! - Converting models on-demand (GLTF -> GLB)
//! - Scanning converted models in output directories
//! - Model index caching for performance

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

use crate::conversion::{Caller, ConversionOwner, ConversionRequest};
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
    pub source: String,               // "fsltl" or "aig"
    pub model_name: String,           // Display name (from aircraft.cfg title)
    pub folder_name: String,          // Actual folder name (e.g., "FSLTL_A320_BAW_IAE")
    pub aircraft_folder_path: String, // Full path to the aircraft folder
    pub gltf_path: String,
    pub texture_dirs: Vec<String>,
    pub aircraft_type: String, // ICAO type designator (e.g., "CRJ2") - the only criterion for type matching
    pub airline_code: Option<String>, // ICAO airline code, "ZZZZ" for generic, None for private aircraft
    pub atc_id: Option<String>, // Aircraft registration (e.g., "N100VE") - for private aircraft matching
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
    /// Lower-case `model=` value of this entry (e.g., "200"): `Some("")` for an empty `model=` (the
    /// plain `model` folder), `None` only when the entry has no `model` key
    model_folder: Option<String>,
}

/// All parsed data from aircraft.cfg in a single read
/// This avoids reading the file multiple times per folder
#[derive(Debug, Clone, Default)]
struct ParsedAircraftCfg {
    /// ICAO type designator from [General] section (e.g., "CRJ2")
    icao_type: Option<String>,
    /// First non-empty `model=` value of any [fltsim] section (e.g., "200"), for entries naming none
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
        Ok(bytes) => decode_cfg_bytes(&bytes),
        Err(_) => return ParsedAircraftCfg::default(),
    };

    parse_aircraft_cfg_str(&content)
}

/// Windows-1252 code points of bytes 0x80-0x9F; the five bytes it leaves undefined map to U+FFFD
const WINDOWS_1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
    '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

/// Decode a cfg file: UTF-8 (a leading BOM dropped) when the bytes are valid UTF-8, else Windows-1252
fn decode_cfg_bytes(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes
            .iter()
            .map(|&byte| match byte {
                0x80..=0x9F => WINDOWS_1252_HIGH[usize::from(byte - 0x80)],
                _ => char::from(byte),
            })
            .collect(),
    }
}

/// Parse aircraft.cfg text once and extract all needed information
fn parse_aircraft_cfg_str(content: &str) -> ParsedAircraftCfg {
    let mut result = ParsedAircraftCfg::default();
    let mut in_general_section = false;
    let mut in_variation_section = false;
    let mut in_fltsim_section = false;
    let mut current_title: Option<String> = None;
    let mut current_texture: Option<String> = None;
    let mut current_icao_airline: Option<String> = None;
    let mut current_atc_id: Option<String> = None;
    let mut current_model: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        // Check for section headers
        if trimmed.starts_with('[') {
            // Save previous livery if complete
            if in_fltsim_section {
                if let (Some(title), Some(texture)) = (current_title.take(), current_texture.take())
                {
                    result.liveries.push(AircraftCfgLivery {
                        title,
                        texture_folder: texture,
                        icao_airline: current_icao_airline.take(),
                        atc_id: current_atc_id.take(),
                        model_folder: current_model.take(),
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
                current_model = None;
            }
            continue;
        }

        // Keys match exactly: `atc_id_enable` is not `atc_id`, `texture.0` is not `texture`
        let Some((key, _)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();

        // Parse [General] section - only need ICAO type designator
        if in_general_section && key == "icao_type_designator" {
            if let Some(val) = extract_cfg_value_inline(trimmed) {
                result.icao_type = Some(val.to_uppercase());
            }
        }

        // Parse [VARIATION] section - base_container specifies the base model folder
        if in_variation_section && key == "base_container" {
            if let Some(val) = extract_cfg_value_inline(trimmed) {
                // Store the raw value (e.g., "..\FSLTL_B77LF")
                result.base_container = Some(val);
            }
        }

        // Parse [fltsim] sections
        if in_fltsim_section {
            match key.as_str() {
                "title" => {
                    if let Some(val) = extract_cfg_value_inline(trimmed) {
                        current_title = Some(val);
                    }
                }
                "texture" => {
                    if let Some(val) = extract_cfg_value_inline(trimmed) {
                        current_texture = Some(val);
                    }
                }
                "icao_airline" => {
                    if let Some(val) = extract_cfg_value_inline(trimmed) {
                        current_icao_airline = Some(val.to_uppercase());
                    }
                }
                "atc_id" => {
                    if let Some(val) = extract_cfg_value_inline(trimmed) {
                        current_atc_id = Some(val.to_uppercase());
                    }
                }
                "model" => {
                    current_model = Some(read_model_value(trimmed, &mut result.model_folder))
                }
                _ => {}
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
                model_folder: current_model,
            });
        }
    }

    result
}

/// The lower-case value of an [fltsim] `model=` line, empty for `model=` or `model=""` (the plain
/// `model` folder); the first non-empty value is also kept in `first_named`
fn read_model_value(line: &str, first_named: &mut Option<String>) -> String {
    let model = extract_cfg_value_inline(line)
        .unwrap_or_default()
        .to_lowercase();
    if !model.is_empty() {
        first_named.get_or_insert_with(|| model.clone());
    }
    model
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
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
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

/// Bump when the cache format or the indexed contents change. v11: each livery lists only its own
/// texture folder, its `texture.cfg` fallbacks and the shared folders, and resolves its own `model=`.
const MODEL_CACHE_VERSION: u32 = 11;

/// Distinguishes the temp file of each save, so two saves in one process never share one
static CACHE_SAVE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    let Ok(content) = serde_json::to_string(&cache) else {
        tracing::info!("[MSFSDetection] Failed to serialize {} cache", source);
        return;
    };
    // Write beside the cache file, then rename into place, so a reader never
    // sees a half-written index
    let serial = CACHE_SAVE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp_path = cache_dir.join(format!(
        "{}_model_cache.json.{}.{}.tmp",
        source,
        std::process::id(),
        serial
    ));
    if let Err(e) = fs::write(&temp_path, content) {
        tracing::info!("[MSFSDetection] Failed to write {} cache: {}", source, e);
        let _ = fs::remove_file(&temp_path);
        return;
    }
    if let Err(e) = fs::rename(&temp_path, &cache_path) {
        tracing::info!("[MSFSDetection] Failed to replace {} cache: {}", source, e);
        let _ = fs::remove_file(&temp_path);
        return;
    }

    tracing::info!(
        "[MSFSDetection] Saved {} models to {} cache",
        models.len(),
        source
    );
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

    let bytes = fs::read(&cfg_path).ok()?;
    let content = decode_cfg_bytes(&bytes);

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
        let digit_str: String = after_lod
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
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
    lower.contains("cockpit") || lower.contains("interior") || lower.contains("cargo")
}

/// The best exterior glTF of the first `model*` folder (sorted by name, case-insensitive) that has one
fn find_gltf_in_dir(aircraft_dir: &std::path::Path) -> Option<String> {
    sorted_child_dirs(aircraft_dir)
        .into_iter()
        .filter(|(name, _)| name.starts_with("model"))
        .find_map(|(_, model_dir)| find_gltf_in_model_dir(&model_dir))
}

/// Collect texture directories from a folder
/// Returns directories starting with "texture" or "oci" (case-insensitive), sorted by name case-insensitively
fn collect_texture_dirs(dir: &std::path::Path) -> Vec<String> {
    sorted_child_dirs(dir)
        .into_iter()
        .filter(|(name, _)| name.starts_with("texture") || name.starts_with("oci"))
        .map(|(_, path)| normalize_path_string(&path))
        .collect()
}

/// How many `texture.cfg` files deep a fallback chain is followed, the texture folder's own cfg being depth 1
const TEXTURE_CFG_MAX_DEPTH: usize = 4;

/// The fallback texture folders a texture folder's `texture.cfg` names, in search order.
///
/// Each `fallback.N` of the cfg's `[fltsim]` section is resolved relative to the folder holding
/// the cfg, in N order; a fallback folder's own `texture.cfg` is followed depth-first, up to
/// `TEXTURE_CFG_MAX_DEPTH` cfgs deep. A folder already listed (or the start folder) is skipped,
/// and a fallback that does not exist or lies outside the package is dropped with a warning.
///
/// Args:
///     texture_dir: The texture folder whose `texture.cfg` (any case) starts the chain.
///     package_root: The canonical MSFS package root, the folder holding `SimObjects/Airplanes`.
///
/// Returns:
///     The fallback folders as joined paths (`..` resolved lexically), the start folder excluded.
fn texture_cfg_fallbacks(texture_dir: &Path, package_root: &Path) -> Vec<PathBuf> {
    let mut visited: HashSet<PathBuf> = texture_dir.canonicalize().into_iter().collect();
    let mut fallbacks = Vec::new();
    push_texture_cfg_fallbacks(texture_dir, package_root, 1, &mut visited, &mut fallbacks);
    fallbacks
}

/// Append the fallbacks of `dir`'s `texture.cfg`, each followed by its own fallbacks
fn push_texture_cfg_fallbacks(
    dir: &Path,
    root: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    fallbacks: &mut Vec<PathBuf>,
) {
    if depth > TEXTURE_CFG_MAX_DEPTH {
        return;
    }
    let Some(cfg_path) = find_child_file(dir, "texture.cfg") else {
        return;
    };
    let content = match fs::read(&cfg_path) {
        Ok(bytes) => decode_cfg_bytes(&bytes),
        Err(e) => {
            tracing::warn!("[MSFSDetection] Cannot read {}: {}", cfg_path.display(), e);
            return;
        }
    };
    for relative in parse_texture_cfg_fallbacks(&content) {
        let Some((target, canonical)) = resolve_fallback(dir, &relative, root, &cfg_path) else {
            continue;
        };
        if visited.insert(canonical) {
            fallbacks.push(target.clone());
            push_texture_cfg_fallbacks(&target, root, depth + 1, visited, fallbacks);
        }
    }
}

/// The file in `dir` named `file_name`, the name matched case-insensitively
fn find_child_file(dir: &Path, file_name: &str) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(file_name)
                && e.path().is_file()
        })
        .map(|e| e.path())
}

/// The `fallback.N` values of a `texture.cfg`'s `[fltsim]` section, ordered by N
fn parse_texture_cfg_fallbacks(content: &str) -> Vec<String> {
    let mut in_fltsim_section = false;
    let mut numbered: Vec<(u32, String)> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_fltsim_section = trimmed.eq_ignore_ascii_case("[fltsim]");
            continue;
        }
        let Some((key, _)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let Some(index) = key
            .strip_prefix("fallback.")
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if let (true, Some(value)) = (in_fltsim_section, extract_cfg_value_inline(trimmed)) {
            numbered.push((index, value));
        }
    }
    numbered.sort_by_key(|(index, _)| *index);
    numbered.into_iter().map(|(_, value)| value).collect()
}

/// Join a cfg-relative path (backslash or slash separated) onto `base`, resolving `.` and `..` by name
fn join_lexically(base: &Path, relative: &str) -> PathBuf {
    let mut joined = base.to_path_buf();
    for part in relative.split(['\\', '/']) {
        match part {
            "" | "." => {}
            ".." => {
                joined.pop();
            }
            name => joined.push(name),
        }
    }
    joined
}

/// Resolve one fallback of the cfg in `cfg_dir`: relative to `cfg_dir`, else (when that folder does
/// not exist) relative to its parent, the aircraft folder. Returns the joined and the canonical path,
/// or `None` after a warning when neither exists or the folder lies outside the package.
fn resolve_fallback(
    cfg_dir: &Path,
    relative: &str,
    root: &Path,
    cfg_path: &Path,
) -> Option<(PathBuf, PathBuf)> {
    let from_cfg_dir = join_lexically(cfg_dir, relative);
    let target = if from_cfg_dir.is_dir() {
        from_cfg_dir
    } else {
        match cfg_dir
            .parent()
            .map(|parent| join_lexically(parent, relative))
        {
            Some(from_parent) if from_parent.is_dir() => from_parent,
            _ => {
                tracing::warn!(
                    "[MSFSDetection] {} names fallback {} which is not a folder; skipping it",
                    cfg_path.display(),
                    from_cfg_dir.display()
                );
                return None;
            }
        }
    };
    let canonical = fallback_inside_package(&target, root, cfg_path)?;
    Some((target, canonical))
}

/// The canonical path of an existing fallback folder inside the package, else `None` after a warning
fn fallback_inside_package(target: &Path, root: &Path, cfg_path: &Path) -> Option<PathBuf> {
    let canonical = match target.canonicalize() {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                "[MSFSDetection] {} names fallback {} which cannot be resolved ({}); skipping it",
                cfg_path.display(),
                target.display(),
                e
            );
            return None;
        }
    };
    if !canonical.starts_with(root) {
        tracing::warn!(
            "[MSFSDetection] {} names fallback {} outside the package {}; skipping it",
            cfg_path.display(),
            target.display(),
            root.display()
        );
        return None;
    }
    Some(canonical)
}

/// A texture folder followed by its `texture.cfg` fallbacks, as index strings
fn texture_dirs_with_fallbacks(texture_dir: &Path, package_root: &Path) -> Vec<String> {
    std::iter::once(texture_dir.to_path_buf())
        .chain(texture_cfg_fallbacks(texture_dir, package_root))
        .map(|dir| normalize_path_string(&dir))
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
    sorted_child_dirs(aircraft_dir)
        .into_iter()
        .filter(|(name, _)| name.starts_with("model"))
        .find_map(|(_, model_dir)| resolve_gltf_via_model_dir_cfg(&model_dir))
}

/// Resolve the glTF one model folder's `model.cfg` (any case) references, with its base model folder
fn resolve_gltf_via_model_dir_cfg(model_dir: &Path) -> Option<(String, PathBuf)> {
    let model_cfg = find_child_file(model_dir, "model.cfg")?;
    let gltf_path = parse_model_cfg(&model_cfg)?;
    // The base model directory is two levels up from the GLTF file: model.xxx/file.gltf -> aircraft folder
    let base_dir = Path::new(&gltf_path).parent()?.parent()?.to_path_buf();
    Some((gltf_path, base_dir))
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

/// Child folders of `dir` as (lower-case name, path), sorted by name
fn sorted_child_dirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut dirs: Vec<(String, PathBuf)> = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path()))
        .collect();
    dirs.sort();
    dirs
}

/// Append each of `more` not already in `dirs` (compared case-insensitively, as Windows paths are)
fn push_unique(dirs: &mut Vec<String>, more: impl IntoIterator<Item = String>) {
    for dir in more {
        if !dirs.iter().any(|known| known.eq_ignore_ascii_case(&dir)) {
            dirs.push(dir);
        }
    }
}

/// Whether two paths name the same existing folder once junctions, symlinks and `..` are resolved.
/// A path that cannot be resolved (it does not exist) never matches.
fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Airline code from a texture folder suffix (`ASA-Alaska` -> `ASA`), if it looks like one
fn airline_from_texture_name(texture_name: &str) -> Option<String> {
    texture_name
        .split('-')
        .next()
        .map(|s| s.to_uppercase())
        .filter(|s| s.len() == 3 || s.len() == 4)
}

/// Shared prefix length of two folder names, compared case-insensitively
fn shared_prefix_len(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(x, y)| x.eq_ignore_ascii_case(y))
        .count()
}

/// One aircraft folder's cfg and child folders, read once and shared by its liveries
struct AircraftFolder {
    dir: PathBuf,
    name: String,
    aircraft_type: String,
    cfg: ParsedAircraftCfg,
    /// Child folders as (lower-case name, path), sorted by name
    child_dirs: Vec<(String, PathBuf)>,
    /// The `base_container` folder the cfg names, when it exists
    base_container: Option<PathBuf>,
}

impl AircraftFolder {
    fn scan(dir: &Path, folder_prefix: &str) -> Self {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let cfg = parse_aircraft_cfg_unified(dir);
        let aircraft_type = cfg
            .icao_type
            .clone()
            .unwrap_or_else(|| parse_aircraft_type(&name, folder_prefix));
        // base_container is a relative path like "..\FSLTL_B77LF"
        let base_container = cfg.base_container.as_ref().and_then(|bc| {
            let resolved = dir.join(bc);
            resolved
                .is_dir()
                .then(|| resolved.canonicalize().unwrap_or(resolved))
        });
        Self {
            dir: dir.to_path_buf(),
            name,
            aircraft_type,
            cfg,
            child_dirs: sorted_child_dirs(dir),
            base_container,
        }
    }

    fn child_dir(&self, lower_name: &str) -> Option<&Path> {
        self.child_dirs
            .iter()
            .find(|(name, _)| name == lower_name)
            .map(|(_, path)| path.as_path())
    }

    /// A livery's own texture folder: `texture.<value>` (any case), or `texture` for an empty value
    fn own_texture_dir(&self, texture_value: &str) -> Option<&Path> {
        if texture_value.is_empty() {
            self.child_dir("texture")
        } else {
            self.child_dir(&format!("texture.{}", texture_value.to_lowercase()))
        }
    }

    fn oci_dirs(&self) -> Vec<String> {
        self.child_dirs
            .iter()
            .filter(|(name, _)| name.starts_with("oci"))
            .map(|(_, path)| normalize_path_string(path))
            .collect()
    }

    /// The folder's own `texture` folder with its fallbacks, then its `oci*` folders
    fn base_texture_dirs(&self, package_root: &Path) -> Vec<String> {
        let mut dirs = self
            .own_texture_dir("")
            .map(|dir| texture_dirs_with_fallbacks(dir, package_root))
            .unwrap_or_default();
        push_unique(&mut dirs, self.oci_dirs());
        dirs
    }

    /// A livery's own model folder: `model.<value>` (any case), or `model` for an empty value
    fn own_model_dir(&self, model_value: Option<&str>) -> Option<&Path> {
        match model_value? {
            "" => self.child_dir("model"),
            model => self.child_dir(&format!("model.{model}")),
        }
    }

    /// The glTF the folder itself supplies, with the base folder when a model.cfg referenced it.
    ///
    /// When the livery's own model folder exists, only it is searched: its direct glTF, then its
    /// model.cfg. Otherwise every `model*` folder is, in name order: direct glTFs, then model.cfgs.
    fn own_model_gltf(&self, model_value: Option<&str>) -> Option<(String, Option<PathBuf>)> {
        let with_base = |(gltf, base_dir): (String, PathBuf)| (gltf, Some(base_dir));
        match self.own_model_dir(model_value) {
            Some(model_dir) => find_gltf_in_model_dir(model_dir)
                .map(|gltf| (gltf, None))
                .or_else(|| resolve_gltf_via_model_dir_cfg(model_dir).map(with_base)),
            None => find_gltf_in_dir(&self.dir)
                .map(|gltf| (gltf, None))
                .or_else(|| resolve_gltf_via_model_cfg(&self.dir).map(with_base)),
        }
    }

    fn model_info(
        &self,
        source: &str,
        model_name: String,
        gltf_path: String,
        texture_dirs: Vec<String>,
    ) -> SourceModelInfo {
        SourceModelInfo {
            source: source.to_string(),
            model_name,
            folder_name: self.name.clone(),
            aircraft_folder_path: normalize_path_string(&self.dir),
            gltf_path,
            texture_dirs,
            aircraft_type: self.aircraft_type.clone(),
            airline_code: None,
            atc_id: None,
        }
    }
}

/// A folder offering its model to liveries of other folders
struct ModelCandidate {
    folder_name: String,
    gltf_path: String,
    /// Texture folders a borrowing livery falls back to (empty for AIG shared models)
    texture_dirs: Vec<String>,
}

/// Pick the candidate whose folder name shares the longest prefix with `folder_name`, then the
/// smallest folder name (case-insensitive), so the choice never depends on directory order
fn closest_candidate<'a>(
    candidates: &'a [ModelCandidate],
    folder_name: &str,
) -> Option<&'a ModelCandidate> {
    candidates.iter().max_by(|a, b| {
        shared_prefix_len(&a.folder_name, folder_name)
            .cmp(&shared_prefix_len(&b.folder_name, folder_name))
            .then_with(|| {
                b.folder_name
                    .to_lowercase()
                    .cmp(&a.folder_name.to_lowercase())
            })
    })
}

/// Models offered across folders, keeping every candidate folder per key
#[derive(Default)]
struct ModelRegistry {
    /// AIG: (ICAO type, model suffix) -> folders owning `model.<suffix>`
    aig_shared: HashMap<(String, String), Vec<ModelCandidate>>,
    /// ICAO type -> base model folders
    base: HashMap<String, Vec<ModelCandidate>>,
    /// ICAO type -> (folder name, its sorted `oci*` folders) of every folder with any
    type_oci: HashMap<String, Vec<(String, Vec<String>)>>,
}

impl ModelRegistry {
    fn register(&mut self, folder: &AircraftFolder, config: &SourceConfig, package_root: &Path) {
        self.register_type_oci(folder);
        let is_base_model = if config.folder_prefix == "FSLTL_" {
            let parts: Vec<&str> = folder.name.split('_').collect();
            parts.len() == 2 || (parts.len() >= 3 && parts[2] == "ZZZZ")
        } else {
            true // AIG folders are always potential base models
        };
        if !is_base_model {
            return;
        }
        if config.folder_prefix == "AIGAIM_" {
            self.register_aig_shared(folder);
        }
        if let Some(gltf_path) = find_gltf_in_dir(&folder.dir) {
            self.base
                .entry(folder.aircraft_type.clone())
                .or_default()
                .push(ModelCandidate {
                    folder_name: folder.name.clone(),
                    gltf_path,
                    texture_dirs: folder.base_texture_dirs(package_root),
                });
        }
    }

    /// Record the folder's `oci*` folders under its ICAO type, when it has a type and any oci folder
    fn register_type_oci(&mut self, folder: &AircraftFolder) {
        let oci_dirs = folder.oci_dirs();
        if !folder.aircraft_type.is_empty() && !oci_dirs.is_empty() {
            self.type_oci
                .entry(folder.aircraft_type.clone())
                .or_default()
                .push((folder.name.clone(), oci_dirs));
        }
    }

    fn register_aig_shared(&mut self, folder: &AircraftFolder) {
        for (name, path) in &folder.child_dirs {
            let Some(suffix) = name.strip_prefix("model.") else {
                continue;
            };
            if let Some(gltf_path) = find_gltf_in_model_dir(path) {
                let key = (folder.aircraft_type.clone(), suffix.to_string());
                self.aig_shared
                    .entry(key)
                    .or_default()
                    .push(ModelCandidate {
                        folder_name: folder.name.clone(),
                        gltf_path,
                        texture_dirs: Vec::new(),
                    });
            }
        }
    }

    fn closest_base(&self, folder: &AircraftFolder) -> Option<&ModelCandidate> {
        let candidates = self.base.get(&folder.aircraft_type)?;
        closest_candidate(candidates, &folder.name)
    }

    /// The `oci*` folders of the other folders of `folder`'s ICAO type, closest folder name first
    /// (longest shared prefix, then lower-case name)
    fn same_type_oci_dirs(&self, folder: &AircraftFolder) -> Vec<String> {
        let Some(siblings) = self.type_oci.get(&folder.aircraft_type) else {
            return Vec::new();
        };
        let mut others: Vec<&(String, Vec<String>)> = siblings
            .iter()
            .filter(|(name, _)| *name != folder.name)
            .collect();
        others.sort_by_key(|(name, _)| {
            (
                std::cmp::Reverse(shared_prefix_len(name, &folder.name)),
                name.to_lowercase(),
            )
        });
        others
            .into_iter()
            .flat_map(|(_, dirs)| dirs.iter().cloned())
            .collect()
    }

    fn closest_aig_shared(
        &self,
        folder: &AircraftFolder,
        model_value: Option<&str>,
    ) -> Option<&ModelCandidate> {
        let key = (folder.aircraft_type.clone(), model_value?.to_string());
        closest_candidate(self.aig_shared.get(&key)?, &folder.name)
    }
}

/// The glTF a livery resolves to and the shared texture folders that come with it
struct ResolvedModel {
    gltf_path: String,
    shared_texture_dirs: Vec<String>,
}

/// What every folder of one listing run shares
struct IndexContext<'a> {
    registry: &'a ModelRegistry,
    config: &'a SourceConfig,
    package_root: &'a Path,
}

impl IndexContext<'_> {
    /// Find the glTF for `model_value` in priority order: the folder's own model folder, a model.cfg
    /// reference, the FSLTL `base_container`, the AIG shared model by (ICAO type, model), the base
    /// model by ICAO type. Shared texture folders: own `oci*`, base_container's and the model.cfg
    /// base folder's texture folders, the base model's own texture folders, then the `oci*` folders
    /// of the other folders of the same ICAO type.
    fn resolve(&self, folder: &AircraftFolder, model_value: Option<&str>) -> Option<ResolvedModel> {
        let base_model = self.registry.closest_base(folder);
        let (gltf_path, model_cfg_base_dir) = folder
            .own_model_gltf(model_value)
            .or_else(|| {
                let gltf = folder
                    .base_container
                    .as_deref()
                    .and_then(find_gltf_in_dir)?;
                Some((gltf, None))
            })
            .or_else(|| {
                if self.config.folder_prefix != "AIGAIM_" {
                    return None;
                }
                self.registry
                    .closest_aig_shared(folder, model_value)
                    .map(|c| (c.gltf_path.clone(), None))
            })
            .or_else(|| base_model.map(|c| (c.gltf_path.clone(), None)))?;

        let mut shared_texture_dirs = folder.oci_dirs();
        if let Some(bc_path) = &folder.base_container {
            push_unique(&mut shared_texture_dirs, collect_texture_dirs(bc_path));
        }
        if let Some(cfg_base) = &model_cfg_base_dir {
            if same_folder(cfg_base, &folder.dir) {
                // The livery's own folder: its plain texture chain and oci, never the other liveries' folders
                push_unique(
                    &mut shared_texture_dirs,
                    folder.base_texture_dirs(self.package_root),
                );
            } else {
                push_unique(&mut shared_texture_dirs, collect_texture_dirs(cfg_base));
            }
        }
        if let Some(base) = base_model {
            push_unique(&mut shared_texture_dirs, base.texture_dirs.iter().cloned());
        }
        // Last resort: shared oci folders of same-type aircraft folders, never their livery folders
        push_unique(
            &mut shared_texture_dirs,
            self.registry.same_type_oci_dirs(folder),
        );
        Some(ResolvedModel {
            gltf_path,
            shared_texture_dirs,
        })
    }

    fn folder_models(&self, folder: &AircraftFolder) -> Vec<SourceModelInfo> {
        if !folder.cfg.liveries.is_empty() {
            self.livery_models(folder)
        } else if folder
            .child_dirs
            .iter()
            .any(|(name, _)| name.starts_with("texture."))
        {
            self.texture_folder_models(folder)
        } else {
            self.single_folder_model(folder).into_iter().collect()
        }
    }

    /// One entry per [fltsim] livery: its own texture folder and fallbacks, then the shared folders
    fn livery_models(&self, folder: &AircraftFolder) -> Vec<SourceModelInfo> {
        let mut resolved_by_model: HashMap<Option<&str>, Option<ResolvedModel>> = HashMap::new();
        let mut models = Vec::new();
        for livery in &folder.cfg.liveries {
            let model_value = livery
                .model_folder
                .as_deref()
                .or(folder.cfg.model_folder.as_deref());
            let resolved = resolved_by_model
                .entry(model_value)
                .or_insert_with(|| self.resolve(folder, model_value));
            let Some(resolved) = resolved else {
                continue;
            };
            let mut texture_dirs = folder
                .own_texture_dir(&livery.texture_folder)
                .map(|dir| texture_dirs_with_fallbacks(dir, self.package_root))
                .unwrap_or_default();
            push_unique(
                &mut texture_dirs,
                resolved.shared_texture_dirs.iter().cloned(),
            );
            let mut info = folder.model_info(
                self.config.source,
                livery.title.clone(),
                resolved.gltf_path.clone(),
                texture_dirs,
            );
            info.airline_code = livery
                .icao_airline
                .clone()
                .or_else(|| airline_from_texture_name(&livery.texture_folder));
            info.atc_id = livery.atc_id.clone();
            models.push(info);
        }
        models
    }

    /// No [fltsim] liveries: one entry per `texture.*` folder, named folder + suffix
    fn texture_folder_models(&self, folder: &AircraftFolder) -> Vec<SourceModelInfo> {
        let Some(resolved) = self.resolve(folder, folder.cfg.model_folder.as_deref()) else {
            return Vec::new();
        };
        folder
            .child_dirs
            .iter()
            .filter(|(name, _)| name.starts_with("texture."))
            .map(|(_, dir)| {
                let dir_name = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let suffix = dir_name.get("texture.".len()..).unwrap_or(&dir_name);
                let mut texture_dirs = texture_dirs_with_fallbacks(dir, self.package_root);
                push_unique(
                    &mut texture_dirs,
                    resolved.shared_texture_dirs.iter().cloned(),
                );
                let model_name = format!("{}_{}", folder.name, suffix);
                let mut info = folder.model_info(
                    self.config.source,
                    model_name,
                    resolved.gltf_path.clone(),
                    texture_dirs,
                );
                info.airline_code = airline_from_texture_name(suffix);
                info
            })
            .collect()
    }

    /// No liveries and no `texture.*` folders: one entry with the folder's own texture folders
    fn single_folder_model(&self, folder: &AircraftFolder) -> Option<SourceModelInfo> {
        let resolved = self.resolve(folder, folder.cfg.model_folder.as_deref())?;
        // Try to get title from aircraft.cfg, fall back to folder name
        let model_name =
            parse_aircraft_cfg_title(&folder.dir).unwrap_or_else(|| folder.name.clone());
        let texture_dirs = folder.base_texture_dirs(self.package_root);
        let mut info = folder.model_info(
            self.config.source,
            model_name,
            resolved.gltf_path,
            texture_dirs,
        );
        // Try to extract airline from folder name (FSLTL_B738_AAL -> AAL)
        if self.config.folder_prefix == "FSLTL_" {
            let parts: Vec<&str> = folder.name.split('_').collect();
            if parts.len() > 2 && parts[2] != "ZZZZ" {
                info.airline_code = Some(parts[2].to_uppercase());
            }
        }
        Some(info)
    }
}

/// Aircraft folders under `airplanes` whose name starts with `folder_prefix`, sorted case-insensitively
fn sorted_aircraft_folders(airplanes: &Path, folder_prefix: &str) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = fs::read_dir(airplanes)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy().starts_with(folder_prefix))
        .map(|e| e.path())
        .collect();
    folders.sort_by_key(|path| path.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    folders
}

/// Emit indexing progress every 5% (and at the end) so the events do not flood the frontend
fn report_index_progress(
    app: Option<&tauri::AppHandle>,
    event_name: &str,
    processed: usize,
    total: usize,
    last_reported_pct: &mut u32,
) {
    let Some(pct) = (processed * 100).checked_div(total).map(|p| p as u32) else {
        return;
    };
    if pct < *last_reported_pct + 5 && processed != total {
        return;
    }
    *last_reported_pct = pct;
    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            event_name,
            serde_json::json!({
                "progress": pct,
                "processed": processed,
                "total": total
            }),
        );
    }
}

/// Unified model listing for MSFS traffic sources (FSLTL and AIG)
///
/// 1. Read every aircraft folder once (aircraft.cfg and child folders) and register the models
///    each offers to other folders (AIG shared models, base models)
/// 2. Create a SourceModelInfo per livery, each resolving its own glTF and texture folders
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
    let package_root = base_path
        .canonicalize()
        .unwrap_or_else(|_| base_path.to_path_buf());

    let parse_start = std::time::Instant::now();
    let folders: Vec<AircraftFolder> = sorted_aircraft_folders(&airplanes, config.folder_prefix)
        .iter()
        .map(|dir| AircraftFolder::scan(dir, config.folder_prefix))
        .collect();
    println!("[TIMING] Found {} folders to process", folders.len());
    let mut registry = ModelRegistry::default();
    for folder in &folders {
        registry.register(folder, config, &package_root);
    }
    let parse_duration = parse_start.elapsed();

    let livery_start = std::time::Instant::now();
    let context = IndexContext {
        registry: &registry,
        config,
        package_root: &package_root,
    };
    let mut models = Vec::new();
    let mut last_reported_pct = 0;
    for (index, folder) in folders.iter().enumerate() {
        models.extend(context.folder_models(folder));
        report_index_progress(
            app,
            event_name,
            index + 1,
            folders.len(),
            &mut last_reported_pct,
        );
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
    owner: tauri::State<'_, ConversionOwner>,
    source_path: String,
    folder_name: String,
    output_dir: String,
    texture_scale: String,
    livery_title: String,
    gltf_path: Option<String>,
    texture_dirs: Option<Vec<String>>,
) -> Result<MSFSConversionResult, String> {
    let start_time = std::time::Instant::now();
    let request = ConversionRequest {
        source_path,
        livery_title,
        gltf_path: gltf_path.unwrap_or_default(),
        texture_dirs: texture_dirs.unwrap_or_default(),
        texture_scale,
        output_dir: PathBuf::from(output_dir),
    };
    let result = owner.convert(request, Caller::Host).await;
    let duration_ms = start_time.elapsed().as_millis() as u64;

    match result {
        Ok(converted) => {
            let output_path_str = normalize_path_string(&converted.output_path);
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
        }
        Err(e) => {
            tracing::info!("[MSFSConvert] Failed to convert {}: {}", folder_name, e);
            Ok(MSFSConversionResult {
                success: false,
                output_path: None,
                error: Some(e.to_string()),
                duration_ms,
            })
        }
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

/// The total length the GLB header declares (bytes 8..12), or None when it cannot be read
fn read_glb_declared_length(glb_path: &std::path::Path) -> Option<u64> {
    use std::io::Read;

    let mut file = fs::File::open(glb_path).ok()?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header).ok()?;
    let declared = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    Some(u64::from(declared))
}

/// Why a GLB fails the cache scan's check.
pub(crate) enum GlbDefect {
    /// The header could not be read
    Unreadable,
    /// The header declares a length other than the file's size
    LengthMismatch { declared: u64 },
}

/// The cache scan's check of a GLB of `file_size` bytes: a readable header declaring that size.
pub(crate) fn check_glb_length(glb_path: &Path, file_size: u64) -> Result<(), GlbDefect> {
    match read_glb_declared_length(glb_path) {
        None => Err(GlbDefect::Unreadable),
        Some(declared) if declared != file_size => Err(GlbDefect::LengthMismatch { declared }),
        Some(_) => Ok(()),
    }
}

/// Whether `glb_path` is a file the cache scan accepts: a `.glb` passing `check_glb_length`.
pub(crate) fn is_accepted_glb(glb_path: &Path) -> bool {
    let is_glb = glb_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("glb"));
    let Ok(metadata) = fs::metadata(glb_path) else {
        return false;
    };
    is_glb && metadata.is_file() && check_glb_length(glb_path, metadata.len()).is_ok()
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

        scan_cache_dir_sync(&dir_path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// List the cached GLBs in a folder, one entry per readable `*.glb` file
fn scan_cache_dir_sync(cache_dir: &std::path::Path) -> Result<Vec<CachedGlbInfo>, String> {
    let entries = fs::read_dir(cache_dir).map_err(|e| {
        format!(
            "Failed to read cache directory {}: {}",
            cache_dir.display(),
            e
        )
    })?;

    let mut cached_models = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(ext) = path.extension() else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("glb") {
            continue;
        }
        // Extract model key from filename (remove .glb extension)
        let Some(stem) = path.file_stem() else {
            continue;
        };
        let model_key = stem.to_string_lossy().to_string();
        let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        // A GLB that cannot be validated is listed without a version, which the app
        // treats as outdated: it deletes the file and converts the model again
        let converter_version = match check_glb_length(&path, file_size) {
            Err(GlbDefect::Unreadable) => {
                tracing::warn!(
                    "[MSFSDetection] Could not read the GLB header, reconverting: {}",
                    path.display()
                );
                None
            }
            Err(GlbDefect::LengthMismatch { declared }) => {
                tracing::warn!(
                    "[MSFSDetection] GLB header length {} does not match file size {}, \
                     reconverting: {}",
                    declared,
                    file_size,
                    path.display()
                );
                None
            }
            Ok(()) => get_glb_converter_version(&path),
        };
        cached_models.push(CachedGlbInfo {
            path: normalize_path_string(&path),
            model_key,
            file_size,
            converter_version,
        });
    }

    Ok(cached_models)
}

// =============================================================================
// SERVER API HELPERS - For remote browser access
// =============================================================================

/// Get the combined model index for remote clients: the fsltl and aig model arrays, without host paths
pub fn get_model_index(app: &tauri::AppHandle) -> Result<RemoteModelIndex, String> {
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

    Ok(remote_model_index(&fsltl_models, &aig_models))
}

/// What a remote client learns about one source model: the name it converts the model by and the
/// fields it matches aircraft with. The host paths stay in `SourceModelInfo`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelInfo {
    pub source: String,
    pub model_name: String,
    pub aircraft_type: String,
    pub airline_code: Option<String>,
    pub atc_id: Option<String>,
}

impl From<&SourceModelInfo> for RemoteModelInfo {
    fn from(model: &SourceModelInfo) -> Self {
        RemoteModelInfo {
            source: model.source.clone(),
            model_name: model.model_name.clone(),
            aircraft_type: model.aircraft_type.clone(),
            airline_code: model.airline_code.clone(),
            atc_id: model.atc_id.clone(),
        }
    }
}

/// The model index `GET /api/msfs/index` sends a remote client.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelIndex {
    pub fsltl: Vec<RemoteModelInfo>,
    pub aig: Vec<RemoteModelInfo>,
    pub total_count: usize,
}

/// The model index a remote client receives for the host's FSLTL and AIG models.
pub fn remote_model_index(fsltl: &[SourceModelInfo], aig: &[SourceModelInfo]) -> RemoteModelIndex {
    RemoteModelIndex {
        fsltl: fsltl.iter().map(RemoteModelInfo::from).collect(),
        aig: aig.iter().map(RemoteModelInfo::from).collect(),
        total_count: fsltl.len() + aig.len(),
    }
}

/// What a remote client learns about one converted model: its key (the GLB is served as
/// `/api/msfs/{model_key}.glb`), its size and the converter version that wrote it. The keys are
/// snake_case, as the remote reader expects.
#[derive(Debug, Serialize)]
pub struct RemoteCachedModel {
    pub model_key: String,
    pub file_size: u64,
    pub converter_version: Option<u32>,
}

/// The converted-model list a remote client receives for the host's cached GLBs.
pub fn remote_cached_models(models: Vec<CachedGlbInfo>) -> Vec<RemoteCachedModel> {
    models
        .into_iter()
        .map(|model| RemoteCachedModel {
            model_key: model.model_key,
            file_size: model.file_size,
            converter_version: model.converter_version,
        })
        .collect()
}

/// The index entry a remote client converts by `model_name` (its `aircraft.cfg` title): the first
/// match in the FSLTL index, then the AIG one, each read only while its source is enabled, as the
/// host indexes them.
pub fn find_index_entry(
    app: &tauri::AppHandle,
    settings: &crate::settings::MsfsModelSettings,
    model_name: &str,
) -> Result<Option<SourceModelInfo>, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    for (source, enabled) in [
        ("fsltl", settings.enable_fsltl),
        ("aig", settings.enable_aig),
    ] {
        if !enabled {
            continue;
        }
        let cache_path = cache_dir.join(format!("{}_model_cache.json", source));
        if !cache_path.exists() {
            continue;
        }
        let content = match fs::read_to_string(&cache_path) {
            Ok(content) => content,
            Err(e) => {
                tracing::warn!(
                    "[MSFSConvert] Could not read the {} model index {}: {}",
                    source,
                    cache_path.display(),
                    e
                );
                continue;
            }
        };
        let cache = match serde_json::from_str::<ModelIndexCache>(&content) {
            Ok(cache) => cache,
            Err(e) => {
                tracing::warn!(
                    "[MSFSConvert] Could not parse the {} model index {}: {}",
                    source,
                    cache_path.display(),
                    e
                );
                continue;
            }
        };
        if let Some(model) = cache
            .models
            .into_iter()
            .find(|m| m.model_name == model_name)
        {
            return Ok(Some(model));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::host_path_walk::{assert_holds_no_host_path, HOST_PATHS};
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    /// A source model with a host path in every path field.
    fn host_model(source: &str) -> SourceModelInfo {
        let [drive, extended, unc] = HOST_PATHS;
        SourceModelInfo {
            source: source.to_string(),
            model_name: "FSLTL_B738_Southwest".to_string(),
            folder_name: "FSLTL_B738_SWA".to_string(),
            aircraft_folder_path: drive.to_string(),
            gltf_path: extended.to_string(),
            texture_dirs: vec![drive.to_string(), extended.to_string(), unc.to_string()],
            aircraft_type: "B738".to_string(),
            airline_code: Some("SWA".to_string()),
            atc_id: Some("N8301J".to_string()),
        }
    }

    /// Cached GLBs, one per host path shape.
    fn host_cached_models() -> Vec<CachedGlbInfo> {
        HOST_PATHS
            .iter()
            .map(|path| CachedGlbInfo {
                path: path.to_string(),
                model_key: "fsltl_FSLTL_B738_Southwest".to_string(),
                file_size: 1024,
                converter_version: Some(7),
            })
            .collect()
    }

    /// The keys of every object in `entries`, which must be a non-empty JSON array of objects.
    fn entry_keys(entries: &serde_json::Value) -> BTreeSet<String> {
        let entries = entries.as_array().expect("entries are an array");
        assert!(!entries.is_empty(), "no entries to check");
        entries
            .iter()
            .flat_map(|entry| entry.as_object().expect("entry is an object").keys())
            .cloned()
            .collect()
    }

    fn key_set(keys: &[&str]) -> BTreeSet<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    #[test]
    fn cfg_atc_id_is_not_overwritten_by_atc_id_enable_or_color() {
        let cfg = "[fltsim.0]\ntitle=Private One\ntexture=PRIV1\natc_id = \"\"\natc_id_enable = 1\n\
                   atc_id_color = 0xFF000000\n\
                   [fltsim.1]\ntitle=Private Two\ntexture=PRIV2\natc_id = \"N100VE\"\natc_id_enable = 1\n";
        let parsed = parse_aircraft_cfg_str(cfg);
        assert_eq!(parsed.liveries.len(), 2);
        assert_eq!(parsed.liveries[0].atc_id, None);
        assert_eq!(parsed.liveries[1].atc_id.as_deref(), Some("N100VE"));
    }

    #[test]
    fn cfg_spaced_model_key_sets_model_folder() {
        let spaced =
            "[fltsim.0]\ntitle=FSLTL_A20N_AIC\ntexture=AIC\nmodel = \"AIC\" ; model folder\n";
        let unspaced = "[fltsim.0]\ntitle=FSLTL_A20N_AIC\ntexture=AIC\nmodel=\"AIC\"\n";
        assert_eq!(
            parse_aircraft_cfg_str(spaced).model_folder,
            Some("aic".to_string())
        );
        assert_eq!(
            parse_aircraft_cfg_str(unspaced).model_folder,
            Some("aic".to_string())
        );
    }

    #[test]
    fn cfg_texture_dot_keys_are_not_texture() {
        // `texture.0` comes last, so reading it as `texture` would replace REAL
        let cfg = "[fltsim.0]\ntitle=Tex\ntexture=REAL\ntexture.0 = x\n";
        let parsed = parse_aircraft_cfg_str(cfg);
        assert_eq!(parsed.liveries.len(), 1);
        assert_eq!(parsed.liveries[0].texture_folder, "REAL");
    }

    #[test]
    fn cfg_bytes_decode_windows_1252_high_range() {
        let high: Vec<u8> = (0x80..=0x9F).collect();
        let decoded: Vec<char> = decode_cfg_bytes(&high).chars().collect();
        assert_eq!(decoded.len(), 32);
        assert_eq!(decoded[0x00], '\u{20AC}', "0x80 is the euro sign");
        assert_eq!(decoded[0x16], '\u{2013}', "0x96 is the en dash");
        assert_eq!(decoded[0x1F], '\u{0178}', "0x9F is Y with diaeresis");
        for undefined in [0x81, 0x8D, 0x8F, 0x90, 0x9D] {
            assert_eq!(
                decoded[undefined - 0x80],
                '\u{FFFD}',
                "byte {undefined:#X} is undefined"
            );
        }
        assert_eq!(decoded.iter().filter(|&&c| c == '\u{FFFD}').count(), 5);
        assert!(
            decoded.iter().all(|&c| !('\u{80}'..='\u{9F}').contains(&c)),
            "no C1 control survives"
        );
        assert_eq!(decode_cfg_bytes(b"caf\xE9"), "caf\u{E9}");
        assert_eq!(
            decode_cfg_bytes("\u{FEFF}caf\u{E9} \u{2013}".as_bytes()),
            "caf\u{E9} \u{2013}"
        );
    }

    /// A unique folder under the system temp dir, removed when the test ends.
    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let serial = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "tc3d-msfs-test-{}-{}",
                std::process::id(),
                serial
            ));
            fs::create_dir_all(&path).expect("create test folder");
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A minimal valid GLB: header, JSON chunk carrying the converter version, BIN chunk.
    fn minimal_glb(converter_version: u32, bin_bytes: usize) -> Vec<u8> {
        let json = format!(
            "{{\"asset\":{{\"version\":\"2.0\",\"extras\":{{\"towercab3d\":{{\"converterVersion\":{}}}}}}}}}",
            converter_version
        );
        let mut json_bytes = json.into_bytes();
        while json_bytes.len() % 4 != 0 {
            json_bytes.push(b' ');
        }
        let bin = vec![0u8; bin_bytes];
        let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
        let mut glb = Vec::with_capacity(total);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total as u32).to_le_bytes());
        glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4E4F_534Au32.to_le_bytes());
        glb.extend_from_slice(&json_bytes);
        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x004E_4942u32.to_le_bytes());
        glb.extend_from_slice(&bin);
        glb
    }

    #[test]
    fn scan_lists_truncated_glb_as_outdated() {
        let folder = TempFolder::new();
        let glb = minimal_glb(8, 64);
        let truncated = &glb[..glb.len() - 16];
        let path = folder.path().join("fsltl_truncated.glb");
        fs::write(&path, truncated).expect("write truncated GLB");
        let scanned = scan_cache_dir_sync(folder.path()).expect("scan cache folder");
        assert_eq!(scanned.len(), 1, "the truncated GLB must stay in the list");
        assert_eq!(scanned[0].model_key, "fsltl_truncated");
        assert_eq!(scanned[0].converter_version, None);
    }

    #[test]
    fn scan_lists_empty_glb_as_outdated() {
        let folder = TempFolder::new();
        fs::write(folder.path().join("fsltl_empty.glb"), b"").expect("write empty GLB");
        let scanned = scan_cache_dir_sync(folder.path()).expect("scan cache folder");
        assert_eq!(scanned.len(), 1, "the empty GLB must stay in the list");
        assert_eq!(scanned[0].model_key, "fsltl_empty");
        assert_eq!(scanned[0].converter_version, None);
    }

    #[test]
    fn scan_lists_intact_glb() {
        let folder = TempFolder::new();
        let path = folder.path().join("fsltl_intact.glb");
        fs::write(&path, minimal_glb(8, 64)).expect("write GLB");
        let scanned = scan_cache_dir_sync(folder.path()).expect("scan cache folder");
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].model_key, "fsltl_intact");
        assert_eq!(scanned[0].converter_version, Some(8));
    }

    #[test]
    fn save_model_cache_replaces_existing_and_leaves_no_temp() {
        let folder = TempFolder::new();
        fs::create_dir_all(folder.path().join("SimObjects").join("Airplanes"))
            .expect("create Airplanes folder");
        let cache_dir = folder.path().join("cache");

        save_model_cache(&cache_dir, folder.path(), "fsltl", &[host_model("fsltl")]);
        let cache_path = cache_dir.join("fsltl_model_cache.json");
        let first = fs::read_to_string(&cache_path).expect("read first cache");
        assert!(first.contains("FSLTL_B738_Southwest"));

        save_model_cache(&cache_dir, folder.path(), "fsltl", &[]);
        let names: Vec<String> = fs::read_dir(&cache_dir)
            .expect("read cache folder")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["fsltl_model_cache.json".to_string()]);
        let second = fs::read_to_string(&cache_path).expect("read second cache");
        assert!(!second.contains("FSLTL_B738_Southwest"));
    }

    #[test]
    fn msfs_index_response_holds_no_host_path() {
        let index = remote_model_index(&[host_model("fsltl")], &[host_model("aig")]);
        assert_holds_no_host_path(&serde_json::to_value(index).expect("serialise index"));
    }

    #[test]
    fn msfs_index_response_sends_only_the_remote_fields() {
        let index = serde_json::to_value(remote_model_index(
            &[host_model("fsltl")],
            &[host_model("aig")],
        ))
        .expect("serialise index");
        let top: BTreeSet<String> = index
            .as_object()
            .expect("index is an object")
            .keys()
            .cloned()
            .collect();
        assert_eq!(top, key_set(&["aig", "fsltl", "totalCount"]));
        assert_eq!(index["totalCount"], 2);
        let remote_fields = key_set(&[
            "source",
            "modelName",
            "aircraftType",
            "airlineCode",
            "atcId",
        ]);
        assert_eq!(entry_keys(&index["fsltl"]), remote_fields);
        assert_eq!(entry_keys(&index["aig"]), remote_fields);
    }

    #[test]
    fn msfs_models_response_holds_no_host_path() {
        let models = remote_cached_models(host_cached_models());
        assert_holds_no_host_path(&serde_json::to_value(models).expect("serialise models"));
    }

    #[test]
    fn msfs_models_response_sends_only_the_remote_fields() {
        let models = serde_json::to_value(remote_cached_models(host_cached_models()))
            .expect("serialise models");
        assert_eq!(
            entry_keys(&models),
            key_set(&["model_key", "file_size", "converter_version"])
        );
    }

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
        assert!(
            cfg.icao_type.is_some(),
            "Should parse ICAO type for CRJ-200"
        );
        println!("CRJ-200 ICAO type: {:?}", cfg.icao_type);
        assert_eq!(cfg.icao_type.as_deref(), Some("CRJ2"));

        // Verify Challenger850 has the same ICAO type (both are CRJ2)
        let challenger_path = PathBuf::from(
            r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci\SimObjects\Airplanes\AIGAIM_RFSL_Challenger850",
        );
        if challenger_path.exists() {
            let challenger_cfg = parse_aircraft_cfg_unified(&challenger_path);
            assert!(
                challenger_cfg.icao_type.is_some(),
                "Should parse ICAO type for Challenger850"
            );
            println!("Challenger850 ICAO type: {:?}", challenger_cfg.icao_type);
            assert_eq!(challenger_cfg.icao_type.as_deref(), Some("CRJ2")); // Same as CRJ-200
        }
    }

    #[test]
    fn test_aig_shared_model_crj200_via_unified_indexing() {
        // Test that CRJ-200 (livery-only folder with model=200) finds a valid GLTF
        // from any folder with the same ICAO type (CRJ2) that has a model.200 folder
        let base_path =
            PathBuf::from(r"X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci");
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
        let crj200_model = models
            .iter()
            .find(|m| m.model_name.contains("SkyWest Charter") && m.model_name.contains("CRJ-200"));
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
            model.gltf_path.contains("model.200")
                || model.gltf_path.to_lowercase().contains("model.200"),
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

    fn aig_config() -> SourceConfig {
        SourceConfig {
            source: "aig",
            folder_prefix: "AIGAIM_",
        }
    }

    /// Write `content` to `path`, creating its parent folders.
    fn write_fixture(path: &std::path::Path, content: &str) {
        fs::create_dir_all(path.parent().expect("fixture has a parent"))
            .expect("create fixture folder");
        fs::write(path, content).expect("write fixture file");
    }

    /// The canonical form of an existing fixture path, as `list_models_unified` passes the package root.
    fn canonical(path: &std::path::Path) -> PathBuf {
        path.canonicalize().expect("canonicalize fixture path")
    }

    /// The `SimObjects/Airplanes` folder of a package rooted at `package`.
    fn airplanes(package: &std::path::Path) -> PathBuf {
        package.join("SimObjects").join("Airplanes")
    }

    fn model_named<'a>(models: &'a [SourceModelInfo], name: &str) -> &'a SourceModelInfo {
        models
            .iter()
            .find(|m| m.model_name == name)
            .unwrap_or_else(|| {
                panic!(
                    "no model named {name} in {:?}",
                    models.iter().map(|m| &m.model_name).collect::<Vec<_>>()
                )
            })
    }

    #[test]
    fn texture_cfg_fallbacks_resolve_relative_to_cfg_folder() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_CRJ-200");
        let texture = aircraft.join("texture.X");
        write_fixture(
            &texture.join("texture.cfg"),
            "[fltsim]\nfallback.1=..\\oci.texture_Y\nfallback.2=..\\..\\..\\texture\n",
        );
        fs::create_dir_all(aircraft.join("oci.texture_Y")).expect("create oci folder");

        let fallbacks = texture_cfg_fallbacks(&texture, &canonical(tmp.path()));

        assert_eq!(fallbacks, vec![aircraft.join("oci.texture_Y")]);
    }

    #[test]
    fn texture_cfg_nested_chain_followed_with_cycle_guard() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_E145");
        let [a, b, c] = ["texture.A", "texture.B", "texture.C"].map(|name| aircraft.join(name));
        write_fixture(
            &a.join("texture.cfg"),
            "[fltsim]\nfallback.1=..\\texture.B\n",
        );
        write_fixture(
            &b.join("texture.CFG"),
            "[FLTSIM]\nfallback.2=..\\texture.A\nfallback.1=..\\texture.C\n",
        );
        fs::create_dir_all(&c).expect("create texture.C");

        let root = canonical(tmp.path());
        assert_eq!(texture_cfg_fallbacks(&a, &root), vec![b.clone(), c.clone()]);
        assert_eq!(
            texture_dirs_with_fallbacks(&a, &root),
            [a, b, c]
                .iter()
                .map(|dir| normalize_path_string(dir))
                .collect::<Vec<_>>()
        );

        let chain: Vec<PathBuf> = (0..=6)
            .map(|i| aircraft.join(format!("texture.T{i}")))
            .collect();
        for (i, dir) in chain.iter().take(6).enumerate() {
            write_fixture(
                &dir.join("texture.cfg"),
                &format!("[fltsim]\nfallback.1=..\\texture.T{}\n", i + 1),
            );
        }
        fs::create_dir_all(&chain[6]).expect("create the chain's last folder");

        assert_eq!(
            texture_cfg_fallbacks(&chain[0], &root),
            chain[1..=4].to_vec()
        );
    }

    #[test]
    fn texture_cfg_fallback_outside_package_dropped() {
        let tmp = TempFolder::new();
        let package = tmp.path().join("pkg");
        let texture = airplanes(&package).join("AIGAIM_T_A320").join("texture.X");
        write_fixture(
            &texture.join("texture.cfg"),
            "[fltsim]\nfallback.1=..\\..\\..\\..\\..\\outside\nfallback.2=..\\..\\..\\..\\texture\n",
        );
        fs::create_dir_all(tmp.path().join("outside")).expect("create folder outside the package");
        fs::create_dir_all(package.join("texture")).expect("create package texture folder");

        assert_eq!(
            texture_cfg_fallbacks(&texture, &canonical(&package)),
            vec![package.join("texture")]
        );
    }

    #[test]
    fn livery_texture_dirs_exclude_sibling_liveries() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_B738");
        write_fixture(
            &aircraft.join("aircraft.cfg"),
            "[General]\nicao_type_designator=B738\n\
             [fltsim.0]\ntitle=T American\ntexture=AAL\n\
             [fltsim.1]\ntitle=T Alaska\ntexture=ASA\n",
        );
        write_fixture(&aircraft.join("model").join("B738_LOD0.gltf"), "");
        for dir in ["texture.AAL", "texture.ASA", "oci.texture_B738"] {
            fs::create_dir_all(aircraft.join(dir)).expect("create texture folder");
        }

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        for (title, own, other) in [
            ("T American", "texture.AAL", "texture.ASA"),
            ("T Alaska", "texture.ASA", "texture.AAL"),
        ] {
            let dirs = &model_named(&models, title).texture_dirs;
            assert!(
                dirs[0].ends_with(own),
                "{title}: own folder first, got {dirs:?}"
            );
            assert!(
                dirs.iter().any(|d| d.ends_with("oci.texture_B738")),
                "{title}: oci folder kept, got {dirs:?}"
            );
            assert!(
                !dirs.iter().any(|d| d.ends_with(other)),
                "{title}: sibling livery leaked, got {dirs:?}"
            );
        }
    }

    #[test]
    fn livery_texture_dirs_exclude_base_model_texture_folders() {
        let tmp = TempFolder::new();
        let base = airplanes(tmp.path()).join("AIGAIM_T_A320");
        write_fixture(
            &base.join("aircraft.cfg"),
            "[General]\nicao_type_designator=A320\n[fltsim.0]\ntitle=T Base Livery\ntexture=AAA\n",
        );
        write_fixture(&base.join("model").join("A320_LOD0.gltf"), "");
        fs::create_dir_all(base.join("texture.AAA")).expect("create base livery folder");
        let livery_only = airplanes(tmp.path()).join("AIGAIM_T_A320X");
        write_fixture(
            &livery_only.join("aircraft.cfg"),
            "[General]\nicao_type_designator=A320\n[fltsim.0]\ntitle=T Other Livery\ntexture=BBB\n",
        );
        fs::create_dir_all(livery_only.join("texture.BBB")).expect("create livery folder");

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        let livery = model_named(&models, "T Other Livery");
        assert!(
            has_component(&livery.gltf_path, "AIGAIM_T_A320"),
            "borrows the base model, got {}",
            livery.gltf_path
        );
        assert!(
            livery.texture_dirs[0].ends_with("texture.BBB"),
            "own folder first, got {:?}",
            livery.texture_dirs
        );
        assert!(
            !livery
                .texture_dirs
                .iter()
                .any(|d| d.ends_with("texture.AAA")),
            "base model's livery folder leaked, got {:?}",
            livery.texture_dirs
        );
    }

    #[test]
    fn texture_cfg_fallback_retried_from_aircraft_folder() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_SU95");
        write_fixture(
            &aircraft.join("aircraft.cfg"),
            "[General]\nicao_type_designator=SU95\n[fltsim.0]\ntitle=T Red Wings\ntexture=A\n",
        );
        write_fixture(&aircraft.join("model").join("SU95_LOD0.gltf"), "");
        write_fixture(
            &aircraft.join("texture.A").join("texture.cfg"),
            "[fltsim]\nfallback.1=..\\..\\..\\texture\n",
        );
        write_fixture(&tmp.path().join("Texture").join("file.dds"), "");

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        let dirs = &model_named(&models, "T Red Wings").texture_dirs;
        let package_texture = normalize_path_string(&tmp.path().join("Texture")).to_lowercase();
        assert!(
            dirs.iter().any(|d| d.to_lowercase() == package_texture),
            "expected {package_texture} in {dirs:?}"
        );
    }

    #[test]
    fn aircraft_cfg_windows_1252_texture_name_finds_its_folder() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_ATR42");
        let mut cfg =
            b"[General]\nicao_type_designator=AT45\n[fltsim.0]\ntitle=T Coast Guard\ntexture=GCI "
                .to_vec();
        cfg.extend_from_slice(b"\x96 Guardia\n");
        fs::create_dir_all(&aircraft).expect("create aircraft folder");
        fs::write(aircraft.join("aircraft.cfg"), cfg).expect("write aircraft.cfg");
        write_fixture(&aircraft.join("model").join("AT45_LOD0.gltf"), "");
        for dir in ["texture.AAA", "texture.GCI \u{2013} Guardia"] {
            fs::create_dir_all(aircraft.join(dir)).expect("create texture folder");
        }

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        let dirs = &model_named(&models, "T Coast Guard").texture_dirs;
        assert!(
            dirs[0].ends_with("texture.GCI \u{2013} Guardia"),
            "own folder first, got {dirs:?}"
        );
    }

    /// An AIG package with two CRJ2 folders owning `model.200` and one livery-only CRJ-200 folder.
    fn crj_fixture(package: &std::path::Path, challenger_first: bool) {
        let owners = if challenger_first {
            ["AIGAIM_T_Challenger850", "AIGAIM_T_CRJ-100"]
        } else {
            ["AIGAIM_T_CRJ-100", "AIGAIM_T_Challenger850"]
        };
        for owner in owners {
            let dir = airplanes(package).join(owner);
            write_fixture(
                &dir.join("aircraft.cfg"),
                &format!("[General]\nicao_type_designator=CRJ2\n[fltsim.0]\ntitle={owner} Livery\ntexture=OWN\nmodel=200\n"),
            );
            write_fixture(&dir.join("model.200").join("X_LOD0.gltf"), "");
        }
        let crj200 = airplanes(package).join("AIGAIM_T_CRJ-200");
        write_fixture(
            &crj200.join("aircraft.cfg"),
            "[General]\nicao_type_designator=CRJ2\n[fltsim.0]\ntitle=SkyWest Charter CRJ-200\ntexture=SCW\nmodel=200\n",
        );
        fs::create_dir_all(crj200.join("texture.SCW")).expect("create livery folder");
    }

    #[test]
    fn test_aig_crj200_indexing_with_shared_model() {
        for challenger_first in [true, false] {
            let tmp = TempFolder::new();
            crj_fixture(tmp.path(), challenger_first);

            let models = list_models_unified(tmp.path(), &aig_config(), None, "");

            let crj200 = model_named(&models, "SkyWest Charter CRJ-200");
            assert!(
                crj200.gltf_path.contains("AIGAIM_T_CRJ-100")
                    && crj200.gltf_path.contains("model.200"),
                "challenger_first={challenger_first}: expected CRJ-100's model.200, got {}",
                crj200.gltf_path
            );
        }
    }

    #[test]
    fn per_livery_model_entry_picks_its_own_gltf() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_E170");
        write_fixture(
            &aircraft.join("aircraft.cfg"),
            "[General]\nicao_type_designator=E170\n\
             [fltsim.0]\ntitle=T Two Hundred\ntexture=TWO\nmodel=200\n\
             [fltsim.1]\ntitle=T One Hundred\ntexture=ONE\nmodel=100\n",
        );
        write_fixture(&aircraft.join("model.100").join("E170_100_LOD0.gltf"), "");
        write_fixture(&aircraft.join("model.200").join("E170_200_LOD0.gltf"), "");

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        assert!(model_named(&models, "T Two Hundred")
            .gltf_path
            .contains("model.200"));
        assert!(model_named(&models, "T One Hundred")
            .gltf_path
            .contains("model.100"));
    }

    /// Whether `path` has a component equal to `name`.
    fn has_component(path: &str, name: &str) -> bool {
        std::path::Path::new(path)
            .components()
            .any(|c| c.as_os_str() == name)
    }

    #[test]
    fn empty_model_entry_uses_plain_model_folder() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_E190");
        write_fixture(
            &aircraft.join("aircraft.cfg"),
            "[General]\nicao_type_designator=E190\n\
             [fltsim.0]\ntitle=T Plain\ntexture=PLN\nmodel=\"\"\n\
             [fltsim.1]\ntitle=T Dome\ntexture=DOM\nmodel=dome\n",
        );
        write_fixture(&aircraft.join("model").join("E190_LOD0.gltf"), "");
        write_fixture(&aircraft.join("model.dome").join("E190_Dome_LOD0.gltf"), "");

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        let plain = &model_named(&models, "T Plain").gltf_path;
        assert!(
            has_component(plain, "model"),
            "model=\"\" uses the plain model folder, got {plain}"
        );
        let dome = &model_named(&models, "T Dome").gltf_path;
        assert!(
            has_component(dome, "model.dome"),
            "model=dome uses model.dome, got {dome}"
        );
    }

    #[test]
    fn own_model_folder_resolves_its_model_cfg_first() {
        let tmp = TempFolder::new();
        let aircraft = airplanes(tmp.path()).join("AIGAIM_T_C208");
        write_fixture(
            &aircraft.join("aircraft.cfg"),
            "[General]\nicao_type_designator=C208\n[fltsim.0]\ntitle=T Pod\ntexture=POD\nmodel=cp\n",
        );
        write_fixture(&aircraft.join("model").join("C208_LOD0.gltf"), "");
        write_fixture(
            &aircraft.join("model.cp").join("model.cfg"),
            "[models]\nnormal=..\\pod\\Pod.xml\n",
        );
        write_fixture(
            &aircraft.join("pod").join("Pod.xml"),
            "<ModelInfo><LODS><LOD minSize=\"0\" ModelFile=\"Pod_LOD0.gltf\"/></LODS></ModelInfo>",
        );
        write_fixture(&aircraft.join("pod").join("Pod_LOD0.gltf"), "");
        for dir in ["texture.POD", "texture.OTHER"] {
            fs::create_dir_all(aircraft.join(dir)).expect("create texture folder");
        }

        let models = list_models_unified(tmp.path(), &aig_config(), None, "");

        let pod = model_named(&models, "T Pod");
        let gltf = &pod.gltf_path;
        assert!(
            has_component(gltf, "pod") && gltf.ends_with("Pod_LOD0.gltf"),
            "model.cp's model.cfg target expected, got {gltf}"
        );
        let dirs = &pod.texture_dirs;
        assert!(
            !dirs.iter().any(|d| d.ends_with("texture.OTHER")),
            "another livery's folder leaked: {dirs:?}"
        );
        assert_eq!(
            dirs.iter().filter(|d| d.ends_with("texture.POD")).count(),
            1,
            "own folder listed once: {dirs:?}"
        );
    }

    #[test]
    fn same_folder_compares_canonical_paths() {
        let tmp = TempFolder::new();
        let own = tmp.path().join("AIGAIM_T_C208");
        let other = tmp.path().join("AIGAIM_T_C208B");
        for dir in [&own, &other] {
            fs::create_dir_all(dir).expect("create aircraft folder");
        }
        let canonical = own.canonicalize().expect("canonicalize aircraft folder");

        assert!(
            same_folder(&own, &canonical),
            "lexical and canonical forms of one folder"
        );
        assert!(
            same_folder(&other.join("..").join("AIGAIM_T_C208"), &own),
            "a path through `..`"
        );
        assert!(!same_folder(&other, &canonical), "different folders");
        let missing = tmp.path().join("missing");
        assert!(
            !same_folder(&missing, &missing),
            "a missing folder is never the livery's own"
        );
    }

    #[test]
    fn collect_texture_dirs_sorted_case_insensitively() {
        let names = ["texture.B", "texture.AB", "texture.a_x", "texture.a"];
        for reversed in [false, true] {
            let tmp = TempFolder::new();
            let mut creation_order = names.to_vec();
            if reversed {
                creation_order.reverse();
            }
            for name in creation_order {
                fs::create_dir_all(tmp.path().join(name)).expect("create texture folder");
            }

            let dirs = collect_texture_dirs(tmp.path());

            let expected: Vec<String> = ["texture.a", "texture.a_x", "texture.AB", "texture.B"]
                .iter()
                .map(|name| normalize_path_string(&tmp.path().join(name)))
                .collect();
            assert_eq!(dirs, expected, "reversed={reversed}");
        }
    }

    /// Three GLF4 folders, each with a livery folder and an oci folder. G350 has no model and borrows
    /// G400's (the closest base by name), whose plain `texture` folder it falls back to; G450's oci
    /// holds the shared image.
    fn gulfstream_fixture(package: &std::path::Path) -> SourceModelInfo {
        for own in ["G350", "G400", "G450"] {
            let dir = airplanes(package).join(format!("AIGAIM_T_{own}"));
            write_fixture(
                &dir.join("aircraft.cfg"),
                &format!("[General]\nicao_type_designator=GLF4\n[fltsim.0]\ntitle=T {own}\ntexture={own}\n"),
            );
            if own != "G350" {
                write_fixture(&dir.join("model").join(format!("{own}_LOD0.gltf")), "");
            }
            fs::create_dir_all(dir.join(format!("texture.{own}"))).expect("create livery folder");
            fs::create_dir_all(dir.join(format!("oci.texture_{own}"))).expect("create oci folder");
        }
        fs::create_dir_all(airplanes(package).join("AIGAIM_T_G400").join("texture"))
            .expect("create base texture folder");
        write_fixture(
            &airplanes(package)
                .join("AIGAIM_T_G450")
                .join("oci.texture_G450")
                .join("AIGIV_B.PNG.DDS"),
            "",
        );
        let models = list_models_unified(package, &aig_config(), None, "");
        model_named(&models, "T G350").clone()
    }

    #[test]
    fn same_type_sibling_oci_is_last_resort() {
        let tmp = TempFolder::new();
        let livery = gulfstream_fixture(tmp.path());

        let own_folder =
            normalize_path_string(&airplanes(tmp.path()).join("AIGAIM_T_G350")).to_lowercase();
        let base_texture =
            normalize_path_string(&airplanes(tmp.path()).join("AIGAIM_T_G400").join("texture"));
        let dirs = &livery.texture_dirs;
        let sibling_oci = dirs.iter().position(|d| d.ends_with("oci.texture_G450"));
        let last_own = dirs
            .iter()
            .rposition(|d| d.to_lowercase().starts_with(&own_folder));
        let base = dirs
            .iter()
            .position(|d| d.eq_ignore_ascii_case(&base_texture));
        assert!(sibling_oci.is_some(), "sibling oci expected in {dirs:?}");
        assert!(
            base.is_some(),
            "base model's texture folder expected in {dirs:?}"
        );
        assert!(
            sibling_oci > last_own,
            "sibling oci must come after the livery's own dirs: {dirs:?}"
        );
        assert!(
            sibling_oci > base,
            "sibling oci must come after the base model's dirs: {dirs:?}"
        );
    }

    #[test]
    fn same_type_sibling_livery_folders_not_included() {
        let tmp = TempFolder::new();
        let livery = gulfstream_fixture(tmp.path());

        assert!(
            !livery
                .texture_dirs
                .iter()
                .any(|d| d.ends_with("texture.G400") || d.ends_with("texture.G450")),
            "sibling livery folder leaked: {:?}",
            livery.texture_dirs
        );
    }

    #[test]
    fn closest_candidate_ties_go_to_smallest_name() {
        let candidate = |name: &str| ModelCandidate {
            folder_name: name.to_string(),
            gltf_path: format!("{name}.gltf"),
            texture_dirs: Vec::new(),
        };
        // (candidate names, livery folder, expected pick, why)
        let cases = [
            (
                ["FSLTL_B738F", "FSLTL_B738"],
                "FSLTL_B738_AAL",
                "FSLTL_B738",
                "equal prefix: smallest name",
            ),
            (
                ["FSLTL_B738F", "FSLTL_B738"],
                "FSLTL_B738F_FDX",
                "FSLTL_B738F",
                "longest prefix wins",
            ),
            (
                ["FSLTL_A332", "FSLTL_a332F"],
                "FSLTL_A332_AAL",
                "FSLTL_A332",
                "mixed case: smallest name",
            ),
            (
                ["FSLTL_a332", "FSLTL_A332F"],
                "FSLTL_A332_AAL",
                "FSLTL_a332",
                "names compared lower-case",
            ),
        ];
        for (names, folder, expected, why) in cases {
            for reversed in [false, true] {
                let mut candidates: Vec<ModelCandidate> =
                    names.iter().map(|name| candidate(name)).collect();
                if reversed {
                    candidates.reverse();
                }

                let picked = closest_candidate(&candidates, folder).map(|c| c.folder_name.clone());

                assert_eq!(
                    picked.as_deref(),
                    Some(expected),
                    "{why} ({folder}, reversed={reversed})"
                );
            }
        }
    }
}
