//! HTTP server for remote browser access
//!
//! Serves the React app and REST APIs to remote browsers (e.g., iPad Safari)
//! when the server is enabled in global settings.

use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{ConnectInfo, Path, Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::{header, HeaderValue, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, put},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use url::Url;

use tauri::Manager;

use crate::{
    find_mods_root, get_global_settings_file, normalize_path_string, read_tower_positions,
    GlobalSettings, ScannedFSLTLModel, TowerPositionEntry,
};

/// vNAS aircraft update for WebSocket broadcast
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VnasAircraftBroadcast {
    pub callsign: String,
    pub lat: f64,
    pub lon: f64,
    pub altitude: f64,
    pub heading: f64,
    pub type_code: Option<String>,
    pub timestamp: u64,
}

/// Shared state for the HTTP server
pub struct ServerState {
    /// Tauri app handle for accessing app directories
    pub app_handle: tauri::AppHandle,
    /// Path to the frontend dist folder
    pub dist_path: PathBuf,
    /// Optional authentication token (if set, clients must provide Bearer token)
    pub auth_token: Option<String>,
    /// Whether to require connections from local network only
    pub require_local_network: bool,
    /// Broadcast channel for vNAS aircraft updates (to relay to WebSocket clients)
    pub vnas_tx: broadcast::Sender<Vec<VnasAircraftBroadcast>>,
}

/// Check if an IP address is from a local/private network
fn is_local_network_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            let octets = ipv4.octets();
            // 127.x.x.x (localhost)
            octets[0] == 127
            // 10.x.x.x (Class A private)
            || octets[0] == 10
            // 172.16.x.x - 172.31.x.x (Class B private)
            || (octets[0] == 172 && (16..=31).contains(&octets[1]))
            // 192.168.x.x (Class C private)
            || (octets[0] == 192 && octets[1] == 168)
            // 169.254.x.x (link-local)
            || (octets[0] == 169 && octets[1] == 254)
        }
        IpAddr::V6(ipv6) => {
            // ::1 (localhost)
            ipv6.is_loopback()
            // fe80::/10 (link-local)
            || (ipv6.segments()[0] & 0xffc0) == 0xfe80
            // fc00::/7 (unique local address)
            || (ipv6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Middleware to check authentication and local network requirements
async fn auth_middleware(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, (StatusCode, String)> {
    // Check local network requirement
    if state.require_local_network && !is_local_network_ip(&addr.ip()) {
        return Err((
            StatusCode::FORBIDDEN,
            format!("Access denied: connections only allowed from local network. Your IP: {}", addr.ip()),
        ));
    }

    // Check authentication token if configured
    if let Some(ref expected_token) = state.auth_token {
        let auth_header = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok());

        let is_authenticated = match auth_header {
            Some(header) if header.starts_with("Bearer ") => {
                let provided_token = &header[7..];
                provided_token == expected_token
            }
            _ => false,
        };

        if !is_authenticated {
            // Allow unauthenticated access to static files (the app itself)
            let path = request.uri().path();
            let is_api_route = path.starts_with("/api/");

            if is_api_route {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "Authentication required. Provide Bearer token in Authorization header.".to_string(),
                ));
            }
        }
    }

    Ok(next.run(request).await)
}

/// Start the HTTP server on a background thread
/// Returns a shutdown channel sender that can be used to stop the server
pub async fn start_server(
    app_handle: tauri::AppHandle,
    port: u16,
) -> Result<broadcast::Sender<()>, String> {
    // Find the dist folder (frontend build output)
    let dist_path = find_dist_path(&app_handle)?;

    // Read auth settings from global settings
    let (auth_token, require_local_network) = {
        let settings_file = get_global_settings_file(&app_handle)?;
        if settings_file.exists() {
            let content = fs::read_to_string(&settings_file)
                .map_err(|e| format!("Failed to read settings: {}", e))?;
            let settings: GlobalSettings = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse settings: {}", e))?;
            (settings.server.auth_token, settings.server.require_local_network)
        } else {
            (None, false)
        }
    };

    println!(
        "[Server] Starting HTTP server on port {} (serving from {:?})",
        port, dist_path
    );
    if auth_token.is_some() {
        println!("[Server] Authentication enabled");
    }
    if require_local_network {
        println!("[Server] Restricted to local network only");
    }

    // Create vNAS broadcast channel for relaying aircraft updates to WebSocket clients
    let (vnas_tx, _) = broadcast::channel::<Vec<VnasAircraftBroadcast>>(256);

    let state = Arc::new(ServerState {
        app_handle,
        dist_path,
        auth_token,
        require_local_network,
        vnas_tx,
    });

    // Build the router
    let app = create_router(state);

    // Create shutdown channel
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(1);

    // Bind to the port
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    println!("[Server] Listening on http://0.0.0.0:{}", port);

    // Spawn the server task
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.recv().await;
                println!("[Server] Shutting down...");
            })
            .await
            .unwrap_or_else(|e| eprintln!("[Server] Error: {}", e));
    });

    Ok(shutdown_tx)
}

/// Find the frontend dist folder
fn find_dist_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // In production, the dist folder should be next to the executable
    // In dev mode, it's relative to src-tauri (CARGO_MANIFEST_DIR)

    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    // Check if we're running in dev mode (exe is in target/debug or target/release)
    let is_dev_mode = exe_dir
        .as_ref()
        .map(|p| {
            let path_str = p.to_string_lossy();
            path_str.contains("target/debug") || path_str.contains("target\\debug")
                || path_str.contains("target/release") || path_str.contains("target\\release")
        })
        .unwrap_or(false);

    let mut candidates: Vec<PathBuf> = Vec::new();

    // In dev mode, prioritize project root dist folder (where Vite outputs)
    if is_dev_mode {
        // CARGO_MANIFEST_DIR is src-tauri, so ../dist is project root dist
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    }

    // Add exe-relative paths (for production builds)
    if let Some(ref exe) = exe_dir {
        candidates.push(exe.join("dist"));
        candidates.push(exe.join("_up_/dist")); // Tauri might nest resources
    }

    // Try resource directory
    if let Ok(resource_path) = app.path().resource_dir() {
        candidates.push(resource_path.join("dist"));
    }

    // Fallback: relative to CARGO_MANIFEST_DIR (if not already added)
    if !is_dev_mode {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    }

    // Current working directory
    candidates.push(PathBuf::from("dist"));

    for candidate in &candidates {
        if candidate.exists() && candidate.join("index.html").exists() {
            println!("[Server] Found dist folder at: {:?}", candidate);
            return Ok(candidate.clone());
        }
    }

    Err(format!(
        "Frontend dist folder not found. The HTTP server requires the frontend to be built.\n\
         Run 'npm run vite:build' first.\n\
         Searched: {:?}",
        candidates
    ))
}

/// Validate CORS origin - only allow local network origins
fn validate_cors_origin(origin: &HeaderValue, _request_parts: &axum::http::request::Parts) -> bool {
    let origin_str = match origin.to_str() {
        Ok(s) => s,
        Err(_) => return false,
    };

    // Parse the origin URL to extract the host
    if let Ok(url) = Url::parse(origin_str) {
        if let Some(host) = url.host_str() {
            // Allow localhost variations
            if host == "localhost" || host == "127.0.0.1" || host == "::1" {
                return true;
            }

            // Check if host is an IP and is local network
            if let Ok(ip) = host.parse::<IpAddr>() {
                return is_local_network_ip(&ip);
            }

            // Allow .local domains (mDNS)
            if host.ends_with(".local") {
                return true;
            }
        }
    }

    false
}

/// Create the axum router with all routes
fn create_router(state: Arc<ServerState>) -> Router {
    // CORS layer with origin validation
    // Only allow origins from local network addresses
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(validate_cors_origin))
        .allow_methods(Any)
        .allow_headers(Any);

    let state_clone = state.clone();

    Router::new()
        // API routes
        .route("/api/global-settings", get(get_global_settings).post(update_global_settings))
        .route("/api/mods/aircraft", get(list_aircraft_mods))
        .route("/api/mods/towers", get(list_tower_mods))
        .route("/api/mods/aircraft/*path", get(serve_aircraft_mod))
        .route("/api/mods/towers/*path", get(serve_tower_mod))
        .route("/api/fsltl/models", get(list_fsltl_models))
        .route("/api/fsltl/*path", get(serve_fsltl_model))
        .route("/api/tower-positions", get(get_tower_positions))
        .route("/api/tower-positions/{icao}", put(update_tower_position))
        .route("/api/vmr-rules", get(get_vmr_rules))
        .route("/api/proxy", get(proxy_request))
        // vNAS WebSocket endpoint for real-time aircraft updates
        .route("/api/vnas/ws", get(vnas_websocket_handler))
        // Static file serving (must be last - catches all other routes)
        .fallback(get(serve_static))
        // Apply auth middleware (checks auth token and local network requirement)
        .layer(middleware::from_fn_with_state(state_clone, auth_middleware))
        .layer(cors)
        .with_state(state)
}

// =============================================================================
// API Handlers
// =============================================================================

/// GET /api/global-settings - Return global settings JSON
async fn get_global_settings(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if !settings_file.exists() {
        return Ok(Json(GlobalSettings::default()));
    }

    let content = fs::read_to_string(&settings_file)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read settings: {}", e)))?;

    let settings: GlobalSettings = serde_json::from_str(&content)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse settings: {}", e)))?;

    Ok(Json(settings))
}

/// POST /api/global-settings - Update global settings
async fn update_global_settings(
    State(state): State<Arc<ServerState>>,
    Json(settings): Json<GlobalSettings>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Ensure parent directory exists
    if let Some(parent) = settings_file.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create directory: {}", e)))?;
    }

    // Write settings to file
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to serialize settings: {}", e)))?;

    fs::write(&settings_file, content)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write settings: {}", e)))?;

    println!("[Server] Updated global settings via API");
    Ok(Json(settings))
}

/// Mod directory info for API response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModInfo {
    name: String,
    path: String,
    manifest: Option<serde_json::Value>,
}

/// GET /api/mods/aircraft - List aircraft mods with manifests
async fn list_aircraft_mods(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<ModInfo>>, (StatusCode, String)> {
    list_mods(&state, "aircraft").await
}

/// GET /api/mods/towers - List tower mods with manifests
async fn list_tower_mods(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<ModInfo>>, (StatusCode, String)> {
    list_mods(&state, "towers").await
}

/// Common function to list mods of a given type
async fn list_mods(
    state: &ServerState,
    mod_type: &str,
) -> Result<Json<Vec<ModInfo>>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let mods_path = mods_root.join(mod_type);

    if !mods_path.exists() {
        return Ok(Json(Vec::new()));
    }

    let entries = fs::read_dir(&mods_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read mods: {}", e)))?;

    let mut mods = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };

        // Try to read manifest
        let manifest_path = path.join("manifest.json");
        let manifest = if manifest_path.exists() {
            fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|c| serde_json::from_str(&c).ok())
        } else {
            None
        };

        mods.push(ModInfo {
            name,
            path: normalize_path_string(&path),
            manifest,
        });
    }

    Ok(Json(mods))
}

/// GET /api/mods/aircraft/*path - Serve aircraft model file
async fn serve_aircraft_mod(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    serve_mod_file(&state, "aircraft", &path).await
}

/// GET /api/mods/towers/*path - Serve tower model file
async fn serve_tower_mod(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    serve_mod_file(&state, "towers", &path).await
}

/// Common function to serve mod files
async fn serve_mod_file(
    state: &ServerState,
    mod_type: &str,
    path: &str,
) -> Result<Response<Body>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let file_path = mods_root.join(mod_type).join(path);

    // Security: ensure the path is within mods directory
    let canonical = file_path.canonicalize().map_err(|_| {
        (StatusCode::NOT_FOUND, "File not found".to_string())
    })?;

    let mods_canonical = mods_root.canonicalize().unwrap_or(mods_root.clone());
    if !canonical.starts_with(&mods_canonical) {
        return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
    }

    serve_file(&canonical).await
}

/// GET /api/fsltl/models - List converted FSLTL models
async fn list_fsltl_models(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<ScannedFSLTLModel>>, (StatusCode, String)> {
    // Get FSLTL output path from global settings
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let output_path = if settings_file.exists() {
        let content = fs::read_to_string(&settings_file)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read settings: {}", e)))?;

        let settings: GlobalSettings = serde_json::from_str(&content)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse settings: {}", e)))?;

        settings.fsltl.output_path
    } else {
        None
    };

    let Some(output_path) = output_path else {
        return Ok(Json(Vec::new()));
    };

    // Use the existing scan_fsltl_models logic
    let models = crate::scan_fsltl_models(output_path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(models))
}

/// GET /api/fsltl/*path - Serve FSLTL model file
async fn serve_fsltl_model(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    // Get FSLTL output path from global settings
    let settings_file = match get_global_settings_file(&state.app_handle) {
        Ok(f) => f,
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    };

    let output_path = if settings_file.exists() {
        let content = fs::read_to_string(&settings_file)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read settings: {}", e)))?;

        let settings: GlobalSettings = serde_json::from_str(&content)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse settings: {}", e)))?;

        settings.fsltl.output_path
    } else {
        None
    };

    let Some(output_path) = output_path else {
        return Err((StatusCode::NOT_FOUND, "FSLTL output path not configured".to_string()));
    };

    let file_path = PathBuf::from(&output_path).join(&path);

    // Security: ensure the path is within output directory
    let canonical = file_path.canonicalize().map_err(|_| {
        (StatusCode::NOT_FOUND, "File not found".to_string())
    })?;

    let output_canonical = PathBuf::from(&output_path).canonicalize().unwrap_or(PathBuf::from(&output_path));
    if !canonical.starts_with(&output_canonical) {
        return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
    }

    serve_file(&canonical).await
}

/// GET /api/tower-positions - Custom tower positions JSON
async fn get_tower_positions(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let positions = read_tower_positions(state.app_handle.clone())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(positions))
}

/// PUT /api/tower-positions/{icao} - Update a single tower position
async fn update_tower_position(
    State(state): State<Arc<ServerState>>,
    Path(icao): Path<String>,
    Json(position): Json<TowerPositionEntry>,
) -> Result<Json<TowerPositionEntry>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let tower_positions_dir = mods_root.join("tower-positions");

    // Create tower-positions directory if it doesn't exist
    fs::create_dir_all(&tower_positions_dir)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create tower-positions directory: {}", e)))?;

    // Write to individual file named {ICAO}.json
    let file_path = tower_positions_dir.join(format!("{}.json", icao.to_uppercase()));

    // If file exists, merge with existing data (preserve other view if only updating one)
    let mut entry = if file_path.exists() {
        let content = fs::read_to_string(&file_path)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read existing position file: {}", e)))?;
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
        entry.view_3d = position.view_3d.clone();
    }
    if position.view_2d.is_some() {
        entry.view_2d = position.view_2d.clone();
    }

    // Serialize and write
    let content = serde_json::to_string_pretty(&entry)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to serialize position: {}", e)))?;

    fs::write(&file_path, content)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write position file: {}", e)))?;

    println!("[Server] Updated tower position for {} via API", icao.to_uppercase());
    Ok(Json(entry))
}

/// VMR rule entry for API response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VmrRule {
    type_code: String,
    model_name: String,
    callsign_prefix: Option<String>,
}

/// GET /api/vmr-rules - Parsed VMR rules as JSON
async fn get_vmr_rules(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<VmrRule>>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let mut rules = Vec::new();

    // Scan for .vmr files
    for dir in [&mods_root, &mods_root.join("aircraft")] {
        if !dir.exists() {
            continue;
        }

        let entries = fs::read_dir(dir)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read dir: {}", e)))?;

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext.eq_ignore_ascii_case("vmr")) {
                if let Ok(content) = fs::read_to_string(&path) {
                    // Simple VMR XML parsing (just extract ModelMatchRule entries)
                    parse_vmr_content(&content, &mut rules);
                }
            }
        }
    }

    Ok(Json(rules))
}

/// Parse VMR XML content and extract rules
fn parse_vmr_content(content: &str, rules: &mut Vec<VmrRule>) {
    // Simple regex-free parsing for ModelMatchRule entries
    // Format: <ModelMatchRule TypeCode="..." ModelName="..." CallsignPrefix="..." />
    for line in content.lines() {
        let line = line.trim();
        if !line.contains("ModelMatchRule") {
            continue;
        }

        let type_code = extract_attr(line, "TypeCode");
        let model_name = extract_attr(line, "ModelName");

        if let (Some(type_code), Some(model_name)) = (type_code, model_name) {
            let callsign_prefix = extract_attr(line, "CallsignPrefix");
            rules.push(VmrRule {
                type_code,
                model_name,
                callsign_prefix,
            });
        }
    }
}

/// Extract an attribute value from an XML element string
fn extract_attr(line: &str, attr: &str) -> Option<String> {
    let pattern = format!("{}=\"", attr);
    let start = line.find(&pattern)? + pattern.len();
    let end = line[start..].find('"')? + start;
    Some(line[start..end].to_string())
}

/// Query parameters for proxy endpoint
#[derive(Deserialize)]
struct ProxyQuery {
    url: String,
}

/// GET /api/proxy?url=... - CORS proxy for external APIs
async fn proxy_request(
    Query(query): Query<ProxyQuery>,
) -> Result<Response<Body>, (StatusCode, String)> {
    // Only allow specific trusted domains
    let allowed_domains = [
        "data.vatsim.net",
        "aviationweather.gov",
        "raw.githubusercontent.com",
    ];

    let url_str = &query.url;

    // Parse the URL properly to extract the host
    let parsed_url = Url::parse(url_str).map_err(|e| {
        (StatusCode::BAD_REQUEST, format!("Invalid URL: {}", e))
    })?;

    // Get the host from the parsed URL
    let host = parsed_url.host_str().ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "URL has no host".to_string())
    })?;

    // Check if the host matches any allowed domain (exact match or subdomain)
    let is_allowed = allowed_domains.iter().any(|domain| {
        host == *domain || host.ends_with(&format!(".{}", domain))
    });

    if !is_allowed {
        return Err((
            StatusCode::FORBIDDEN,
            format!("Domain '{}' not allowed. Allowed: {:?}", host, allowed_domains),
        ));
    }

    // Make the request
    let client = reqwest::Client::new();
    let response = client
        .get(url_str)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Proxy request failed: {}", e)))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let body = response
        .bytes()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("Failed to read response: {}", e)))?;

    let mut resp = Response::builder()
        .status(status)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );

    Ok(resp)
}

// =============================================================================
// vNAS WebSocket Handler
// =============================================================================

/// WebSocket handler for vNAS aircraft updates
///
/// Remote browsers connect to this WebSocket to receive real-time aircraft
/// position updates from vNAS. The Tauri backend broadcasts updates to this
/// endpoint, which then relays them to all connected WebSocket clients.
///
/// ## Message Format
/// Server sends JSON arrays of VnasAircraftBroadcast objects at 1Hz:
/// ```json
/// [{"callsign":"DAL123","lat":42.0,"lon":-71.0,"altitude":10000,"heading":90,"typeCode":"B738","timestamp":1234567890}]
/// ```
///
/// ## TODO
/// This is a placeholder implementation. The actual vNAS data flow requires:
/// 1. vNAS OAuth credentials from VATSIM tech team
/// 2. Wiring up towercab-3d-vnas crate
/// 3. Broadcasting updates from vnas.rs to server.rs
async fn vnas_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_vnas_websocket(socket, state))
}

/// Handle a vNAS WebSocket connection
async fn handle_vnas_websocket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to vNAS broadcast channel
    let mut vnas_rx = state.vnas_tx.subscribe();

    println!("[vNAS WS] Client connected");

    // Spawn a task to forward vNAS updates to the WebSocket
    let send_task = tokio::spawn(async move {
        while let Ok(aircraft) = vnas_rx.recv().await {
            // Serialize and send to WebSocket
            match serde_json::to_string(&aircraft) {
                Ok(json) => {
                    if sender.send(Message::Text(json)).await.is_err() {
                        break; // Client disconnected
                    }
                }
                Err(e) => {
                    eprintln!("[vNAS WS] Serialization error: {}", e);
                }
            }
        }
    });

    // Handle incoming messages (mostly for keepalive/ping-pong)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Ping(data)) => {
                // Ping/pong handled automatically by axum
                println!("[vNAS WS] Received ping: {:?}", data);
            }
            Ok(Message::Close(_)) => {
                println!("[vNAS WS] Client requested close");
                break;
            }
            Ok(_) => {
                // Ignore other message types (we don't expect client messages)
            }
            Err(e) => {
                eprintln!("[vNAS WS] Error: {}", e);
                break;
            }
        }
    }

    // Clean up
    send_task.abort();
    println!("[vNAS WS] Client disconnected");
}

// =============================================================================
// Static File Serving
// =============================================================================

/// Serve static files from the dist folder
async fn serve_static(
    State(state): State<Arc<ServerState>>,
    request: axum::extract::Request,
) -> impl IntoResponse {
    let path = request.uri().path();

    // Remove leading slash and handle root
    let path = path.trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    let file_path = state.dist_path.join(path);

    // Debug: log what we're looking for
    println!("[Server] Request: {} -> {:?} (exists: {})", path, file_path, file_path.exists());

    // Try the exact path first
    if file_path.exists() && file_path.is_file() {
        return serve_file(&file_path).await;
    }

    // Check if this looks like a static asset request (has a file extension)
    // If so, don't serve index.html - return 404 instead
    let has_extension = std::path::Path::new(path)
        .extension()
        .map_or(false, |ext| {
            // Common static asset extensions that should NOT fall back to index.html
            let ext = ext.to_string_lossy().to_lowercase();
            matches!(
                ext.as_str(),
                "js" | "mjs" | "css" | "json" | "png" | "jpg" | "jpeg" | "gif" | "svg" | "ico"
                    | "woff" | "woff2" | "ttf" | "eot" | "map" | "glb" | "gltf" | "bin"
                    | "wasm" | "mp3" | "ogg" | "webp" | "avif" | "ktx2"
            )
        });

    if has_extension {
        // Static asset not found - return 404, don't serve index.html
        println!("[Server] Static file not found: {}", path);
        return Err((StatusCode::NOT_FOUND, format!("File not found: {}", path)));
    }

    // For SPA routing, serve index.html for non-file paths (e.g., /settings, /about)
    let index_path = state.dist_path.join("index.html");
    if index_path.exists() {
        return serve_file(&index_path).await;
    }

    Err((StatusCode::NOT_FOUND, "Not found".to_string()))
}

/// Serve a single file with correct MIME type
async fn serve_file(path: &PathBuf) -> Result<Response<Body>, (StatusCode, String)> {
    let content = fs::read(path)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read file: {}", e)))?;

    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(content))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );

    // Cache static assets for better performance
    if mime.starts_with("image/") || mime.contains("javascript") || mime.contains("css") || mime.contains("font") {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }

    Ok(resp)
}
