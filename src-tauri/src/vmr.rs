//! VMR (Visual Model Rules) file parsing and caching.
//!
//! This module handles:
//! - Parsing VMR XML files for aircraft model rules
//! - Caching parsed rules for performance
//! - Extracting type codes, model names, and airline prefixes

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

use crate::normalize_path_string;

// =============================================================================
// TYPES
// =============================================================================

/// Parsed VMR rule (from XML file)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedVmrRule {
    /// Aircraft ICAO type code (e.g., "B738")
    pub type_code: String,
    /// Model name or path (may contain // for alternatives)
    pub model_name: String,
    /// Optional airline ICAO code for airline-specific rules
    pub callsign_prefix: Option<String>,
    /// Source file path
    pub source_vmr: String,
}

/// Cached VMR file parse result
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VmrFileCache {
    /// File modification time (Unix timestamp)
    file_mtime: u64,
    /// Cache format version
    version: u32,
    /// Parsed rules from this file
    rules: Vec<ParsedVmrRule>,
}

const VMR_CACHE_VERSION: u32 = 1;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/// Get file modification time as Unix timestamp
fn get_file_mtime(path: &std::path::Path) -> Option<u64> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata.modified().ok()?;
    Some(mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs())
}

/// Get cache file path for a VMR file
fn get_vmr_cache_path(vmr_path: &std::path::Path) -> PathBuf {
    let file_name = vmr_path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let parent = vmr_path.parent().unwrap_or(vmr_path);
    parent.join(format!(".tc3d_{}.cache.json", file_name))
}

/// Load cached VMR parse result if valid
fn load_vmr_cache(vmr_path: &std::path::Path) -> Option<Vec<ParsedVmrRule>> {
    let cache_path = get_vmr_cache_path(vmr_path);
    if !cache_path.exists() {
        return None;
    }

    let cache_content = fs::read_to_string(&cache_path).ok()?;
    let cache: VmrFileCache = serde_json::from_str(&cache_content).ok()?;

    // Check version
    if cache.version != VMR_CACHE_VERSION {
        return None;
    }

    // Check if source file mtime matches
    let current_mtime = get_file_mtime(vmr_path)?;
    if cache.file_mtime != current_mtime {
        return None;
    }

    Some(cache.rules)
}

/// Save parsed VMR rules to cache
fn save_vmr_cache(vmr_path: &std::path::Path, rules: &[ParsedVmrRule]) {
    let Some(file_mtime) = get_file_mtime(vmr_path) else { return };

    let cache = VmrFileCache {
        file_mtime,
        version: VMR_CACHE_VERSION,
        rules: rules.to_vec(),
    };

    let cache_path = get_vmr_cache_path(vmr_path);
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = fs::write(&cache_path, json);
    }
}

/// Extract an attribute value from an XML element string
fn extract_vmr_attr(line: &str, attr: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr);
    let start = line.find(&pattern)? + pattern.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// Parse a single VMR file and return rules
/// Uses simple line-by-line parsing (same as server.rs)
fn parse_vmr_file(path: &std::path::Path) -> Vec<ParsedVmrRule> {
    let source_path = normalize_path_string(&path.to_path_buf());
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut rules = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if !line.contains("ModelMatchRule") {
            continue;
        }

        // Extract TypeCode attribute
        let type_code = match extract_vmr_attr(line, "TypeCode") {
            Some(tc) => tc.to_uppercase(),
            None => continue,
        };

        // Extract ModelName attribute
        let model_name = match extract_vmr_attr(line, "ModelName") {
            Some(mn) => mn,
            None => continue,
        };

        // Extract optional CallsignPrefix
        let callsign_prefix = extract_vmr_attr(line, "CallsignPrefix")
            .map(|cp| cp.to_uppercase());

        rules.push(ParsedVmrRule {
            type_code,
            model_name,
            callsign_prefix,
            source_vmr: source_path.clone(),
        });
    }

    rules
}

// =============================================================================
// TAURI COMMANDS
// =============================================================================

/// Parse multiple VMR files and return all rules with caching
/// This is the main Tauri command for VMR parsing
#[tauri::command]
pub fn parse_vmr_files(file_paths: Vec<String>) -> Result<Vec<ParsedVmrRule>, String> {
    let start_time = std::time::Instant::now();
    let mut all_rules = Vec::new();
    let mut cached_count = 0;
    let mut parsed_count = 0;

    for file_path in &file_paths {
        let path = PathBuf::from(file_path);
        if !path.exists() {
            continue;
        }

        // Try to load from cache first
        if let Some(cached_rules) = load_vmr_cache(&path) {
            all_rules.extend(cached_rules);
            cached_count += 1;
        } else {
            // Parse the file and cache the result
            let rules = parse_vmr_file(&path);
            if !rules.is_empty() {
                save_vmr_cache(&path, &rules);
                all_rules.extend(rules);
            }
            parsed_count += 1;
        }
    }

    let elapsed = start_time.elapsed();
    if !file_paths.is_empty() {
        println!(
            "[VMR] Loaded {} rules from {} file(s) ({} cached, {} parsed) in {:?}",
            all_rules.len(),
            file_paths.len(),
            cached_count,
            parsed_count,
            elapsed
        );
    }

    Ok(all_rules)
}
