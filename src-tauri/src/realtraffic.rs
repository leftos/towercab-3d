//! RealTraffic API integration.
//!
//! This module handles:
//! - Authentication with RealTraffic API
//! - Fetching traffic data (live and parked)
//! - Deauthentication

use serde::{Deserialize, Serialize};

const REALTRAFFIC_API_URL: &str = "https://rtwa.flyrealtraffic.com/v5";

// =============================================================================
// TYPES
// =============================================================================

/// RealTraffic authentication request/response
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficAuthResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_pro: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic_rate_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weather_rate_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// RealTraffic traffic request parameters
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficTrafficParams {
    pub guid: String,
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
    #[serde(default)]
    pub time_offset: Option<i32>,
}

/// RealTraffic parked traffic request parameters
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RealTrafficParkedParams {
    pub guid: String,
    pub lat_min: f64,
    pub lat_max: f64,
    pub lon_min: f64,
    pub lon_max: f64,
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/// Authenticate with RealTraffic API
#[tauri::command]
pub async fn realtraffic_auth(license_key: String) -> Result<RealTrafficAuthResult, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("license", license_key.as_str());
    form_data.insert("software", "TowerCab3D");

    let response = client
        .post(format!("{}/auth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic auth request failed: {}", e))?;

    // Read response as text first for better error messages
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))?;

    // Parse as JSON
    let data: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse RealTraffic JSON: {} - Response was: {}", e, response_text))?;

    // Check API status code (200 = success)
    let status = data.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
    if status != 200 {
        let message = data.get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Authentication failed");
        return Ok(RealTrafficAuthResult {
            success: false,
            guid: None,
            is_pro: None,
            traffic_rate_limit: None,
            weather_rate_limit: None,
            error: Some(message.to_string()),
        });
    }

    // type 0 = Standard, type 2 = Pro
    let license_type = data.get("type").and_then(|v| v.as_i64()).unwrap_or(0);
    let is_pro = license_type == 2;

    Ok(RealTrafficAuthResult {
        success: true,
        guid: data.get("GUID").and_then(|v| v.as_str()).map(|s| s.to_string()),
        is_pro: Some(is_pro),
        traffic_rate_limit: data.get("rrl").and_then(|v| v.as_u64()).map(|n| n as u32),
        weather_rate_limit: data.get("wrrl").and_then(|v| v.as_u64()).map(|n| n as u32),
        error: None,
    })
}

/// Fetch traffic data from RealTraffic API
#[tauri::command]
pub async fn realtraffic_traffic(params: RealTrafficTrafficParams) -> Result<String, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype, top/bottom/left/right for bbox
    let mut form_data: Vec<(&str, String)> = vec![
        ("GUID", params.guid.clone()),
        ("querytype", "locationtraffic".to_string()),
        ("top", params.lat_max.to_string()),
        ("bottom", params.lat_min.to_string()),
        ("left", params.lon_min.to_string()),
        ("right", params.lon_max.to_string()),
    ];

    if let Some(toffset) = params.time_offset {
        form_data.push(("toffset", toffset.to_string()));
    }

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic traffic request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))
}

/// Fetch parked aircraft data from RealTraffic API
/// Returns aircraft with zero groundspeed that haven't moved for 10min-24h
#[tauri::command]
pub async fn realtraffic_parked_traffic(params: RealTrafficParkedParams) -> Result<String, String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype, top/bottom/left/right for bbox
    let form_data: Vec<(&str, String)> = vec![
        ("GUID", params.guid.clone()),
        ("querytype", "parkedtraffic".to_string()),
        ("top", params.lat_max.to_string()),
        ("bottom", params.lat_min.to_string()),
        ("left", params.lon_min.to_string()),
        ("right", params.lon_max.to_string()),
    ];

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic parked traffic request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))
}

/// Deauthenticate from RealTraffic API
/// Releases the session on the server, allowing immediate reconnection
#[tauri::command]
pub async fn realtraffic_deauth(guid: String) -> Result<(), String> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("GUID", guid.as_str());

    let response = client
        .post(format!("{}/deauth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| format!("RealTraffic deauth request failed: {}", e))?;

    // Read response for logging purposes
    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read RealTraffic response: {}", e))?;

    // Parse to check status (optional - deauth is fire-and-forget)
    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&response_text) {
        let status = data.get("status").and_then(|v| v.as_i64()).unwrap_or(0);
        if status == 200 {
            tracing::info!("[RealTraffic] Deauth successful");
        } else {
            tracing::info!("[RealTraffic] Deauth returned status {}: {}", status, response_text);
        }
    }

    Ok(())
}
