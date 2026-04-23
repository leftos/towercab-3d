//! VMR (Visual Model Rules) file parsing.
//!
//! VMR files are XML files that define aircraft model matching rules.
//! Uses quick-xml for robust parsing that handles various XML formats.
//! Files are parsed in parallel using rayon for better performance with multiple files.

use quick_xml::events::Event;
use quick_xml::Reader;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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

// =============================================================================
// PARSING
// =============================================================================

/// Parse a single VMR file using quick-xml
fn parse_vmr_file(path: &std::path::Path) -> Vec<ParsedVmrRule> {
    let source_path = normalize_path_string(path);
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("[VMR] Failed to read {}: {}", path.display(), e);
            return Vec::new();
        }
    };

    // Pre-allocate based on rough estimate (average ~50 bytes per rule in XML)
    let estimated_rules = content.len() / 50;
    let mut rules = Vec::with_capacity(estimated_rules.max(100));
    let mut reader = Reader::from_str(&content);

    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e))
                if e.name().as_ref() == b"ModelMatchRule" =>
            {
                let mut type_code: Option<String> = None;
                let mut model_name: Option<String> = None;
                let mut callsign_prefix: Option<String> = None;

                for attr in e.attributes().filter_map(|a| a.ok()) {
                    let key = String::from_utf8_lossy(attr.key.as_ref());
                    let value = String::from_utf8_lossy(&attr.value);

                    match key.as_ref() {
                        "TypeCode" => type_code = Some(value.to_uppercase()),
                        "ModelName" => model_name = Some(value.to_string()),
                        "CallsignPrefix" => callsign_prefix = Some(value.to_uppercase()),
                        _ => {}
                    }
                }

                if let (Some(tc), Some(mn)) = (type_code, model_name) {
                    rules.push(ParsedVmrRule {
                        type_code: tc,
                        model_name: mn,
                        callsign_prefix,
                        source_vmr: source_path.clone(),
                    });
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                tracing::error!("[VMR] XML parse error in {}: {}", path.display(), e);
                break;
            }
            _ => {}
        }
    }

    rules
}

// =============================================================================
// TAURI COMMANDS
// =============================================================================

/// Parse multiple VMR files in parallel and return all rules
#[tauri::command]
pub fn parse_vmr_files(file_paths: Vec<String>) -> Result<Vec<ParsedVmrRule>, String> {
    let start_time = std::time::Instant::now();

    // Convert paths and filter out non-existent files
    let valid_paths: Vec<PathBuf> = file_paths
        .iter()
        .filter_map(|file_path| {
            let path = PathBuf::from(file_path);
            if path.exists() {
                Some(path)
            } else {
                tracing::error!("[VMR] File not found: {}", file_path);
                None
            }
        })
        .collect();

    // Parse files in parallel using rayon
    let all_rules: Vec<ParsedVmrRule> = valid_paths
        .par_iter()
        .flat_map(|path| {
            let rules = parse_vmr_file(path);
            tracing::info!(
                "[VMR] Parsed {} rules from {}",
                rules.len(),
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            rules
        })
        .collect();

    let elapsed = start_time.elapsed();
    tracing::info!(
        "[VMR] Total: {} rules from {} file(s) in {:?}",
        all_rules.len(),
        file_paths.len(),
        elapsed
    );

    Ok(all_rules)
}
