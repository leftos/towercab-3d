//! HTTP server for remote browser access
//!
//! Serves the React app and REST APIs to remote browsers (e.g., iPad Safari)
//! when the server is enabled in global settings.

use std::fs;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use flate2::read::GzDecoder;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, Path, Query, State, WebSocketUpgrade,
    },
    http::{header, HeaderValue, Request, Response, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use url::Url;

use tauri::{Emitter, Manager};

use crate::{
    mods::{discover_all_mods, find_mods_root, read_tower_positions, DiscoveredMod, TowerPositionEntry},
    msfs::CachedGlbInfo,
    normalize_path_string,
    settings::{get_global_settings_file, GlobalSettings},
};

// =============================================================================
// Unified Observation Types (for remote browser broadcast)
// =============================================================================

/// Observation data broadcast to remote clients
/// Contains position data from any source (VATSIM, vNAS, RealTraffic)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationData {
    pub callsign: String,
    pub latitude: f64,
    pub longitude: f64,
    pub altitude: f64,
    pub heading: f64,
    pub groundspeed: f64,
    pub ground_track: f64,
    pub vertical_rate: f64,
    pub on_ground: bool,
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    /// Data source: "vatsim", "vnas", or "realtraffic"
    pub source: String,
    /// When the observation was made (Unix timestamp in ms)
    pub observed_at: u64,
    /// When the observation was received locally (Unix timestamp in ms)
    pub received_at: u64,
    // Metadata
    pub type_code: Option<String>,
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub flight_rules: Option<String>,
}

/// Messages sent over the observations WebSocket
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ObservationMessage {
    /// Batch of aircraft observations
    #[serde(rename = "observations")]
    Observations { data: Vec<ObservationData> },

    /// Aircraft removals (disconnected from network)
    #[serde(rename = "removals")]
    Removals { callsigns: Vec<String> },

    /// Current vNAS subscriptions (sent on connect and when changed)
    #[serde(rename = "subscriptions")]
    Subscriptions { facilities: Vec<String> },

    /// Initial state sent on WebSocket connect
    #[serde(rename = "init")]
    Init {
        session_facilities: Vec<String>,
        subscribed_facilities: Vec<String>,
        vnas_state: String,
    },

    /// vNAS connection state change (broadcast to remote clients)
    #[serde(rename = "vnas_state")]
    VnasState { state: String },

    /// Airport synchronization for RealTraffic mode
    /// When using RealTraffic, all clients must be synced to the same airport
    #[serde(rename = "airport_sync")]
    AirportSync {
        /// The ICAO code of the synced airport (null if no airport selected)
        icao: Option<String>,
        /// Whether RealTraffic mode is active (airport sync only applies in RT mode)
        realtraffic_active: bool,
    },
}

/// Request from remote client (vNAS subscription or airport change)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRequest {
    /// Action type: "subscribe" | "unsubscribe" | "set_airport"
    pub action: String,
    /// Facility ID for subscribe/unsubscribe actions
    #[serde(default)]
    pub facility_id: Option<String>,
    /// Airport ICAO for set_airport action
    #[serde(default)]
    pub icao: Option<String>,
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
    /// Broadcast channel for unified observations (all data sources)
    pub observations_tx: broadcast::Sender<ObservationMessage>,
    /// Count of currently connected remote clients (WebSocket connections)
    pub connected_clients: AtomicUsize,
    /// Current synced airport ICAO for RealTraffic mode (None = not set)
    pub synced_airport: std::sync::RwLock<Option<String>>,
    /// Whether RealTraffic data source is currently active
    pub realtraffic_active: std::sync::RwLock<bool>,
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
            format!(
                "Access denied: connections only allowed from local network. Your IP: {}",
                addr.ip()
            ),
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
                    "Authentication required. Provide Bearer token in Authorization header."
                        .to_string(),
                ));
            }
        }
    }

    Ok(next.run(request).await)
}

/// Server handles returned from start_server
pub struct ServerHandles {
    /// Send to this channel to shut down the server
    pub shutdown_tx: broadcast::Sender<()>,
    /// Send unified observations to this channel for WebSocket relay
    pub observations_tx: broadcast::Sender<ObservationMessage>,
}

/// Start the HTTP server on a background thread
/// Returns handles for shutdown and vNAS broadcast
pub async fn start_server(
    app_handle: tauri::AppHandle,
    port: u16,
) -> Result<ServerHandles, String> {
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
            (
                settings.server.auth_token,
                settings.server.require_local_network,
            )
        } else {
            (None, false)
        }
    };

    tracing::info!(
        "[Server] Starting HTTP server on port {} (serving from {:?})",
        port,
        dist_path
    );
    if auth_token.is_some() {
        tracing::info!("[Server] Authentication enabled");
    }
    if require_local_network {
        tracing::info!("[Server] Restricted to local network only");
    }

    // Create unified observations broadcast channel for all data sources
    let (observations_tx, _) = broadcast::channel::<ObservationMessage>(256);
    let observations_tx_return = observations_tx.clone();

    let state = Arc::new(ServerState {
        app_handle,
        dist_path,
        auth_token,
        require_local_network,
        observations_tx,
        connected_clients: AtomicUsize::new(0),
        synced_airport: std::sync::RwLock::new(None),
        realtraffic_active: std::sync::RwLock::new(false),
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

    tracing::info!("[Server] Listening on http://0.0.0.0:{}", port);

    // Spawn the server task
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.recv().await;
            tracing::info!("[Server] Shutting down...");
        })
        .await
        .unwrap_or_else(|e| tracing::error!("[Server] Error: {}", e));
    });

    Ok(ServerHandles {
        shutdown_tx,
        observations_tx: observations_tx_return,
    })
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
            path_str.contains("target/debug")
                || path_str.contains("target\\debug")
                || path_str.contains("target/release")
                || path_str.contains("target\\release")
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
            tracing::info!("[Server] Found dist folder at: {:?}", candidate);
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
        .route("/api/airport-surfaces", get(get_airport_surfaces))
        .route(
            "/api/global-settings",
            get(get_global_settings).post(update_global_settings),
        )
        .route("/api/mods/discover", get(discover_mods))
        .route("/api/mods/aircraft", get(list_aircraft_mods))
        .route("/api/mods/towers", get(list_tower_mods))
        .route("/api/mods/aircraft/*path", get(serve_aircraft_mod))
        .route("/api/mods/towers/*path", get(serve_tower_mod))
        .route("/api/mods/file/*path", get(serve_any_mod_file))
        // MSFS model endpoints (for remote browser access to converted models)
        .route("/api/msfs/models", get(list_msfs_converted_models))
        .route("/api/msfs/index", get(get_msfs_model_index))
        .route("/api/msfs/convert", post(request_msfs_conversion))
        .route("/api/msfs/*path", get(serve_msfs_model))
        .route("/api/tower-positions", get(get_tower_positions))
        .route("/api/tower-positions/{icao}", put(update_tower_position))
        .route("/api/vmr-rules", get(get_vmr_rules))
        .route("/api/proxy", get(proxy_request))
        // RealTraffic proxy endpoints (to bypass CORS)
        .route("/api/realtraffic/auth", post(realtraffic_auth))
        .route("/api/realtraffic/traffic", post(realtraffic_traffic))
        .route(
            "/api/realtraffic/parked-traffic",
            post(realtraffic_parked_traffic),
        )
        .route("/api/realtraffic/deauth", post(realtraffic_deauth))
        // Unified observations WebSocket for all data sources (VATSIM, vNAS, RealTraffic)
        .route("/api/observations/ws", get(observations_websocket_handler))
        // Presence WebSocket for tracking connected remote clients
        .route("/api/presence", get(presence_websocket_handler))
        // Remote client logging endpoint
        .route("/api/log", post(remote_log))
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

/// GET /api/airport-surfaces - Return airport pavement data (decompressed JSON)
///
/// This endpoint reads the compressed airport-surfaces.json.gz file from
/// bundled resources and serves the decompressed JSON. The data contains
/// taxiway and apron polygons from X-Plane apt.dat for terrain flattening.
async fn get_airport_surfaces(
    State(state): State<Arc<ServerState>>,
) -> Result<Response<Body>, (StatusCode, String)> {
    // Find the airport-surfaces.json.gz file in bundled resources
    // Check dev path first (CARGO_MANIFEST_DIR/resources/), then production path
    let dev_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/airport-surfaces.json.gz");

    let resource_path = if dev_path.exists() {
        dev_path
    } else {
        let prod_path = state
            .app_handle
            .path()
            .resource_dir()
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Failed to get resource dir: {}", e),
                )
            })?
            .join("airport-surfaces.json.gz");

        if !prod_path.exists() {
            return Err((
                StatusCode::NOT_FOUND,
                "Airport surfaces data not found. The airport-surfaces.json.gz file is missing from resources.".to_string(),
            ));
        }
        prod_path
    };

    // Read and decompress the gzip file
    let compressed_data = fs::read(&resource_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read airport surfaces file: {}", e),
        )
    })?;

    let mut decoder = GzDecoder::new(&compressed_data[..]);
    let mut decompressed = String::new();
    decoder.read_to_string(&mut decompressed).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to decompress airport surfaces: {}", e),
        )
    })?;

    // Build response with JSON content type
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(decompressed))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    // Cache for 24 hours since this data rarely changes
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );

    Ok(resp)
}

/// GET /api/global-settings - Return global settings JSON
async fn get_global_settings(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    if !settings_file.exists() {
        return Ok(Json(GlobalSettings::default()));
    }

    let content = fs::read_to_string(&settings_file).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read settings: {}", e),
        )
    })?;

    let settings: GlobalSettings = serde_json::from_str(&content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to parse settings: {}", e),
        )
    })?;

    Ok(Json(settings))
}

/// POST /api/global-settings - Update global settings
async fn update_global_settings(
    State(state): State<Arc<ServerState>>,
    Json(mut settings): Json<GlobalSettings>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    // Ensure parent directory exists
    if let Some(parent) = settings_file.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to create directory: {}", e),
            )
        })?;
    }

    // Preserve vnas_tokens if incoming settings don't have it but existing file does
    if settings.vnas_tokens.is_none() && settings_file.exists() {
        if let Ok(content) = fs::read_to_string(&settings_file) {
            if let Ok(existing) = serde_json::from_str::<GlobalSettings>(&content) {
                if existing.vnas_tokens.is_some() {
                    tracing::debug!("[Server] Preserving existing vnas_tokens");
                    settings.vnas_tokens = existing.vnas_tokens;
                }
            }
        }
    }

    // Write settings to file
    let content = serde_json::to_string_pretty(&settings).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize settings: {}", e),
        )
    })?;

    fs::write(&settings_file, content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write settings: {}", e),
        )
    })?;

    tracing::info!("[Server] Updated global settings via API");
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

/// GET /api/mods/discover - Recursively discover all mods (supports git repos)
async fn discover_mods(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<DiscoveredMod>>, (StatusCode, String)> {
    let mods = discover_all_mods(state.app_handle.clone()).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to discover mods: {}", e),
        )
    })?;
    Ok(Json(mods))
}

/// GET /api/mods/file/*path - Serve any file within the mods directory
/// Supports serving files from git repo subfolders
async fn serve_any_mod_file(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let file_path = mods_root.join(&path);

    // Security: ensure the path is within mods directory
    let canonical = file_path
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "File not found".to_string()))?;

    let mods_canonical = mods_root.canonicalize().unwrap_or(mods_root.clone());
    if !canonical.starts_with(&mods_canonical) {
        return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
    }

    serve_file(&canonical).await
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

    let entries = fs::read_dir(&mods_path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read mods: {}", e),
        )
    })?;

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
    let canonical = file_path
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "File not found".to_string()))?;

    let mods_canonical = mods_root.canonicalize().unwrap_or(mods_root.clone());
    if !canonical.starts_with(&mods_canonical) {
        return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
    }

    serve_file(&canonical).await
}

/// GET /api/msfs/models - List converted MSFS models (FSLTL/AIG)
/// Returns flat list of cached GLB files with their model keys for remote browser clients
async fn list_msfs_converted_models(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<CachedGlbInfo>>, (StatusCode, String)> {
    // Get MSFS model cache directory from global settings
    let settings_file = get_global_settings_file(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let cache_dir = if settings_file.exists() {
        let content = fs::read_to_string(&settings_file).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read settings: {}", e),
            )
        })?;

        let settings: GlobalSettings = serde_json::from_str(&content).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to parse settings: {}", e),
            )
        })?;

        settings.msfs_models.cache_directory.clone()
    } else {
        None
    };

    let Some(cache_dir) = cache_dir else {
        return Ok(Json(Vec::new()));
    };

    // Use scan_cache_directory which correctly scans flat GLB files (same as host initialization)
    let models = crate::msfs::scan_cache_directory(cache_dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(models))
}

/// GET /api/msfs/*path - Serve converted MSFS model file (FSLTL/AIG)
async fn serve_msfs_model(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    // Get MSFS model cache directory from global settings
    let settings_file = match get_global_settings_file(&state.app_handle) {
        Ok(f) => f,
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e)),
    };

    let cache_dir = if settings_file.exists() {
        let content = fs::read_to_string(&settings_file).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read settings: {}", e),
            )
        })?;

        let settings: GlobalSettings = serde_json::from_str(&content).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to parse settings: {}", e),
            )
        })?;

        settings.msfs_models.cache_directory.clone()
    } else {
        None
    };

    let Some(cache_dir) = cache_dir else {
        return Err((
            StatusCode::NOT_FOUND,
            "MSFS model cache directory not configured".to_string(),
        ));
    };

    let file_path = PathBuf::from(&cache_dir).join(&path);

    // Security: ensure the path is within cache directory
    let canonical = file_path
        .canonicalize()
        .map_err(|_| (StatusCode::NOT_FOUND, "File not found".to_string()))?;

    let cache_canonical = PathBuf::from(&cache_dir)
        .canonicalize()
        .unwrap_or(PathBuf::from(&cache_dir));
    if !canonical.starts_with(&cache_canonical) {
        return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
    }

    serve_file(&canonical).await
}

/// GET /api/msfs/index - Get the MSFS model index for remote clients
async fn get_msfs_model_index(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Get the model index from the MSFS module
    let index = crate::msfs::get_model_index(&state.app_handle)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get model index: {}", e)))?;

    Ok(Json(index))
}

/// Request body for model conversion
#[derive(Debug, serde::Deserialize)]
struct ConversionRequest {
    /// Model name to convert (e.g., "FSLTL_B738_Southwest")
    model_name: String,
    /// Texture scale: "full", "2k", "1k", or "512"
    #[serde(default = "default_texture_scale")]
    texture_scale: String,
}

fn default_texture_scale() -> String {
    "1k".to_string()
}

/// Conversion response
#[derive(Debug, serde::Serialize)]
struct ConversionResponse {
    success: bool,
    /// Path to the converted GLB file (relative to cache directory)
    output_path: Option<String>,
    error: Option<String>,
}

/// POST /api/msfs/convert - Request conversion of an MSFS model
async fn request_msfs_conversion(
    State(state): State<Arc<ServerState>>,
    Json(request): Json<ConversionRequest>,
) -> Result<Json<ConversionResponse>, (StatusCode, String)> {
    // Call the MSFS conversion function
    match crate::msfs::convert_model_by_name(
        &state.app_handle,
        &request.model_name,
        &request.texture_scale,
    ) {
        Ok(output_path) => Ok(Json(ConversionResponse {
            success: true,
            output_path: Some(output_path),
            error: None,
        })),
        Err(e) => Ok(Json(ConversionResponse {
            success: false,
            output_path: None,
            error: Some(e),
        })),
    }
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
    fs::create_dir_all(&tower_positions_dir).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to create tower-positions directory: {}", e),
        )
    })?;

    // Write to individual file named {ICAO}.json
    let file_path = tower_positions_dir.join(format!("{}.json", icao.to_uppercase()));

    // If file exists, merge with existing data (preserve other view if only updating one)
    let mut entry = if file_path.exists() {
        let content = fs::read_to_string(&file_path).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read existing position file: {}", e),
            )
        })?;
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
    let content = serde_json::to_string_pretty(&entry).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to serialize position: {}", e),
        )
    })?;

    fs::write(&file_path, content).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to write position file: {}", e),
        )
    })?;

    tracing::info!(
        "[Server] Updated tower position for {} via API",
        icao.to_uppercase()
    );
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

        let entries = fs::read_dir(dir).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read dir: {}", e),
            )
        })?;

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("vmr"))
            {
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

// =============================================================================
// Remote Client Logging
// =============================================================================

/// Log entry sent from remote clients
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLogEntry {
    level: String,
    message: String,
    #[serde(default)]
    client_id: Option<String>,
}

/// Batch of log entries from remote client
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteLogBatch {
    entries: Vec<RemoteLogEntry>,
}

/// POST /api/log - Receive log entries from remote clients
async fn remote_log(Json(batch): Json<RemoteLogBatch>) -> StatusCode {
    let client_prefix = batch
        .entries
        .first()
        .and_then(|e| e.client_id.as_ref())
        .map(|id| format!("Remote:{}", id))
        .unwrap_or_else(|| "Remote".to_string());

    for entry in batch.entries {
        match entry.level.as_str() {
            "ERROR" => tracing::error!(target: "frontend", "[{}] {}", client_prefix, entry.message),
            "WARN" => tracing::warn!(target: "frontend", "[{}] {}", client_prefix, entry.message),
            "INFO" => tracing::info!(target: "frontend", "[{}] {}", client_prefix, entry.message),
            "DEBUG" => tracing::debug!(target: "frontend", "[{}] {}", client_prefix, entry.message),
            _ => tracing::info!(target: "frontend", "[{}] [{}] {}", client_prefix, entry.level, entry.message),
        }
    }

    StatusCode::OK
}

// =============================================================================
// RealTraffic Proxy Endpoints
// =============================================================================

/// RealTraffic auth request body
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealTrafficAuthRequest {
    license_key: String,
}

/// RealTraffic traffic request body
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealTrafficTrafficRequest {
    guid: String,
    lat1: f64,
    lon1: f64,
    lat2: f64,
    lon2: f64,
    toffset: Option<i32>,
}

const REALTRAFFIC_API_URL: &str = "https://rtwa.flyrealtraffic.com/v5";

/// POST /api/realtraffic/auth - Proxy RealTraffic authentication
async fn realtraffic_auth(
    Json(request): Json<RealTrafficAuthRequest>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("license", request.license_key.as_str());
    form_data.insert("software", "TowerCab3D");

    let response = client
        .post(format!("{}/auth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("RealTraffic auth request failed: {}", e),
            )
        })?;

    let body = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read RealTraffic response: {}", e),
        )
    })?;

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    Ok(resp)
}

/// POST /api/realtraffic/traffic - Proxy RealTraffic traffic data
async fn realtraffic_traffic(
    Json(request): Json<RealTrafficTrafficRequest>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype, top/bottom/left/right for bbox
    let mut form_data: Vec<(&str, String)> = vec![
        ("GUID", request.guid.clone()),
        ("querytype", "locationtraffic".to_string()),
        ("top", request.lat2.to_string()),
        ("bottom", request.lat1.to_string()),
        ("left", request.lon1.to_string()),
        ("right", request.lon2.to_string()),
    ];

    // Add toffset if provided (for Pro license historical data)
    if let Some(toffset) = request.toffset {
        form_data.push(("toffset", toffset.to_string()));
    }

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("RealTraffic traffic request failed: {}", e),
            )
        })?;

    let body = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read RealTraffic response: {}", e),
        )
    })?;

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    Ok(resp)
}

/// RealTraffic parked traffic request body
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealTrafficParkedRequest {
    guid: String,
    lat1: f64,
    lon1: f64,
    lat2: f64,
    lon2: f64,
}

/// POST /api/realtraffic/parked-traffic - Proxy RealTraffic parked aircraft data
async fn realtraffic_parked_traffic(
    Json(request): Json<RealTrafficParkedRequest>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    // Field names: GUID (uppercase), querytype=parkedtraffic, top/bottom/left/right for bbox
    let form_data: Vec<(&str, String)> = vec![
        ("GUID", request.guid.clone()),
        ("querytype", "parkedtraffic".to_string()),
        ("top", request.lat2.to_string()),
        ("bottom", request.lat1.to_string()),
        ("left", request.lon1.to_string()),
        ("right", request.lon2.to_string()),
    ];

    let response = client
        .post(format!("{}/traffic", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("RealTraffic parked traffic request failed: {}", e),
            )
        })?;

    let body = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read RealTraffic response: {}", e),
        )
    })?;

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    Ok(resp)
}

/// RealTraffic deauth request body
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealTrafficDeauthRequest {
    guid: String,
}

/// POST /api/realtraffic/deauth - Proxy RealTraffic deauthentication
async fn realtraffic_deauth(
    Json(request): Json<RealTrafficDeauthRequest>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let client = reqwest::Client::new();

    // RealTraffic API expects form data, not JSON
    let mut form_data = std::collections::HashMap::new();
    form_data.insert("GUID", request.guid.as_str());

    let response = client
        .post(format!("{}/deauth", REALTRAFFIC_API_URL))
        .header("Accept-Encoding", "gzip")
        .form(&form_data)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                format!("RealTraffic deauth request failed: {}", e),
            )
        })?;

    let body = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read RealTraffic response: {}", e),
        )
    })?;

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );

    Ok(resp)
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
    let parsed_url = Url::parse(url_str)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid URL: {}", e)))?;

    // Get the host from the parsed URL
    let host = parsed_url
        .host_str()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, "URL has no host".to_string()))?;

    // Check if the host matches any allowed domain (exact match or subdomain)
    let is_allowed = allowed_domains
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{}", domain)));

    if !is_allowed {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Domain '{}' not allowed. Allowed: {:?}",
                host, allowed_domains
            ),
        ));
    }

    // Make the request
    let client = reqwest::Client::new();
    let response = client.get(url_str).send().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Proxy request failed: {}", e),
        )
    })?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let body = response.bytes().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Failed to read response: {}", e),
        )
    })?;

    let mut resp = Response::builder()
        .status(status)
        .body(Body::from(body))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );

    Ok(resp)
}

// =============================================================================
// Unified Observations WebSocket Handler
// =============================================================================

/// WebSocket handler for unified observations from all data sources
///
/// Remote browsers connect to this WebSocket to receive real-time aircraft
/// position updates from all sources (VATSIM, vNAS, RealTraffic). The host
/// app relays observations to this endpoint via Tauri commands.
///
/// ## Message Types
/// - `init`: Sent on connect with session/subscription state
/// - `observations`: Batch of aircraft position updates
/// - `removals`: Aircraft that have disconnected
/// - `subscriptions`: Current vNAS subscriptions (when changed)
///
/// ## Client Messages
/// Clients can send subscription requests:
/// ```json
/// {"action": "subscribe", "facilityId": "SFO"}
/// ```
async fn observations_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    tracing::info!("[Observations WS] Upgrade request received");
    ws.on_upgrade(move |socket| handle_observations_websocket(socket, state))
}

/// Handle a unified observations WebSocket connection
async fn handle_observations_websocket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to observations broadcast channel
    let mut obs_rx = state.observations_tx.subscribe();

    tracing::info!("[Observations WS] Client connected");

    // Send initial state (vNAS session and subscription info)
    let init_msg = ObservationMessage::Init {
        session_facilities: crate::vnas::get_session_facilities_sync(),
        subscribed_facilities: crate::vnas::get_subscribed_facilities_sync(),
        vnas_state: crate::vnas::get_state_sync(),
    };
    if let Ok(json) = serde_json::to_string(&init_msg) {
        if sender.send(Message::Text(json)).await.is_err() {
            tracing::warn!("[Observations WS] Failed to send init message");
            return;
        }
    }

    // Send current airport sync state (for RealTraffic mode)
    let (synced_airport, rt_active) = {
        let airport = state.synced_airport.read().ok().and_then(|g| g.clone());
        let active = state.realtraffic_active.read().ok().map(|g| *g).unwrap_or(false);
        (airport, active)
    };
    let airport_sync_msg = ObservationMessage::AirportSync {
        icao: synced_airport,
        realtraffic_active: rt_active,
    };
    if let Ok(json) = serde_json::to_string(&airport_sync_msg) {
        if sender.send(Message::Text(json)).await.is_err() {
            tracing::warn!("[Observations WS] Failed to send airport sync message");
            return;
        }
    }

    // Clone state for request handling
    let state_for_requests = state.clone();

    // Spawn a task to forward observations to the WebSocket
    let send_task = tokio::spawn(async move {
        while let Ok(message) = obs_rx.recv().await {
            match serde_json::to_string(&message) {
                Ok(json) => {
                    if sender.send(Message::Text(json)).await.is_err() {
                        break; // Client disconnected
                    }
                }
                Err(e) => {
                    tracing::error!("[Observations WS] Serialization error: {}", e);
                }
            }
        }
    });

    // Handle incoming messages (subscription/airport requests from remote clients)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Try to parse as client request
                if let Ok(request) = serde_json::from_str::<ClientRequest>(&text) {
                    handle_client_request(&state_for_requests, request).await;
                }
            }
            Ok(Message::Close(_)) => {
                tracing::info!("[Observations WS] Client requested close");
                break;
            }
            Ok(_) => {
                // Ignore other message types
            }
            Err(e) => {
                tracing::error!("[Observations WS] Error: {}", e);
                break;
            }
        }
    }

    // Clean up
    send_task.abort();
    tracing::info!("[Observations WS] Client disconnected");
}

/// Handle a client request (vNAS subscription or airport change)
async fn handle_client_request(state: &Arc<ServerState>, request: ClientRequest) {
    let app_handle = &state.app_handle;

    match request.action.as_str() {
        "subscribe" => {
            let facility_id = match request.facility_id {
                Some(id) => id,
                None => {
                    tracing::warn!("[Observations WS] subscribe action missing facility_id");
                    return;
                }
            };
            // Check if facility is within allowed session facilities
            let allowed = crate::vnas::get_session_facilities_sync();
            if allowed.contains(&facility_id) {
                // Subscribe to the facility
                tracing::info!(
                    "[Observations WS] Remote client requesting subscription to {}",
                    facility_id
                );
                if let Err(e) =
                    crate::vnas::subscribe_facility_internal(app_handle, &facility_id).await
                {
                    tracing::warn!(
                        "[Observations WS] Failed to subscribe to {}: {}",
                        facility_id,
                        e
                    );
                }
            } else {
                tracing::warn!(
                    "[Observations WS] Subscription denied for {} - not in session facilities",
                    facility_id
                );
            }
        }
        "unsubscribe" => {
            let facility_id = match request.facility_id {
                Some(id) => id,
                None => {
                    tracing::warn!("[Observations WS] unsubscribe action missing facility_id");
                    return;
                }
            };
            tracing::info!(
                "[Observations WS] Remote client requesting unsubscription from {}",
                facility_id
            );
            if let Err(e) =
                crate::vnas::unsubscribe_facility_internal(app_handle, &facility_id).await
            {
                tracing::warn!(
                    "[Observations WS] Failed to unsubscribe from {}: {}",
                    facility_id,
                    e
                );
            }
        }
        "set_airport" => {
            // Remote client is requesting to change the synced airport
            // This only applies in RealTraffic mode
            let rt_active = state
                .realtraffic_active
                .read()
                .ok()
                .map(|g| *g)
                .unwrap_or(false);

            if !rt_active {
                tracing::debug!("[Observations WS] set_airport ignored - RealTraffic not active");
                return;
            }

            let icao = request.icao;
            tracing::info!(
                "[Observations WS] Remote client requesting airport change to {:?}",
                icao
            );

            // Update the synced airport
            if let Ok(mut guard) = state.synced_airport.write() {
                *guard = icao.clone();
            }

            // Broadcast the airport change to all clients (including the host)
            let msg = ObservationMessage::AirportSync {
                icao,
                realtraffic_active: true,
            };
            let _ = state.observations_tx.send(msg);

            // Emit event to notify the host app
            let _ = app_handle.emit("remote-airport-changed", ());
        }
        _ => {
            tracing::warn!(
                "[Observations WS] Unknown action: {}",
                request.action
            );
        }
    }
}

// =============================================================================
// Presence WebSocket (Remote Client Tracking)
// =============================================================================

/// WebSocket handler for remote client presence tracking.
///
/// Remote browsers connect to this endpoint when they load the app.
/// The server tracks connected clients and emits events to notify the
/// desktop app UI of changes.
async fn presence_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_presence_websocket(socket, state))
}

/// Handle a presence WebSocket connection
async fn handle_presence_websocket(socket: WebSocket, state: Arc<ServerState>) {
    let (_sender, mut receiver) = socket.split();

    // Increment connected client count and emit event
    let count = state.connected_clients.fetch_add(1, Ordering::SeqCst) + 1;
    tracing::info!("[Presence] Remote client connected (total: {})", count);
    let _ = state.app_handle.emit("remote-clients-changed", count);

    // Keep connection alive until client disconnects
    // We just listen for close/disconnect, no messages expected
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {} // Ignore other messages
        }
    }

    // Decrement connected client count and emit event
    let count = state.connected_clients.fetch_sub(1, Ordering::SeqCst) - 1;
    tracing::info!("[Presence] Remote client disconnected (total: {})", count);
    let _ = state.app_handle.emit("remote-clients-changed", count);
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
    tracing::info!(
        "[Server] Request: {} -> {:?} (exists: {})",
        path,
        file_path,
        file_path.exists()
    );

    // Try the exact path first
    if file_path.exists() && file_path.is_file() {
        return serve_file(&file_path).await;
    }

    // Check if this looks like a static asset request (has a file extension)
    // If so, don't serve index.html - return 404 instead
    let has_extension = std::path::Path::new(path).extension().is_some_and(|ext| {
        // Common static asset extensions that should NOT fall back to index.html
        let ext = ext.to_string_lossy().to_lowercase();
        matches!(
            ext.as_str(),
            "js" | "mjs"
                | "css"
                | "json"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "svg"
                | "ico"
                | "woff"
                | "woff2"
                | "ttf"
                | "eot"
                | "map"
                | "glb"
                | "gltf"
                | "bin"
                | "wasm"
                | "mp3"
                | "ogg"
                | "webp"
                | "avif"
                | "ktx2"
        )
    });

    if has_extension {
        // Static asset not found - return 404, don't serve index.html
        tracing::info!("[Server] Static file not found: {}", path);
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
    let content = fs::read(path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to read file: {}", e),
        )
    })?;

    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();

    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from(content))
        .unwrap();

    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );

    // Cache static assets for better performance
    if mime.starts_with("image/")
        || mime.contains("javascript")
        || mime.contains("css")
        || mime.contains("font")
    {
        resp.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }

    Ok(resp)
}
