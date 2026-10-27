//! HTTP server for remote browser access
//!
//! Serves the React app and REST APIs to remote browsers (e.g., iPad Safari)
//! when the server is enabled in global settings.

use std::fs;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Component, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use flate2::read::GzDecoder;

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, Path, Query, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderValue, Request, Response, StatusCode},
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
    conversion::{Caller, ConversionError, ConversionOwner},
    mods::{
        discover_all_mods, find_mods_root, read_tower_positions, DiscoveredMod, TowerPositionEntry,
    },
    msfs::{RemoteCachedModel, RemoteModelIndex, SourceModelInfo},
    normalize_path_string,
    settings::{
        apply_remote_write, get_global_settings_file, read_remote_view, read_settings_file,
        GlobalSettings, ALLOW_NON_LOCAL_CLIENTS,
    },
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
    /// Height above the ground in metres (vNAS), so remote screens run the host's ground-contact rule;
    /// absent on the wire for sources without one
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_above_ground: Option<f64>,
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
    /// Canonical path to the frontend dist folder, resolved once when the server starts
    pub dist_path: PathBuf,
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

/// Whether a `Host` header names this server the way a local client does (see
/// `is_local_host_name`), with an optional port. A DNS-rebound page arrives with its own
/// domain name and is refused, as is a request without `Host`.
fn is_allowed_host(host_header: Option<&str>) -> bool {
    host_header
        .and_then(strip_port)
        .is_some_and(is_local_host_name)
}

/// The host part of a `host[:port]` authority (IPv6 kept in brackets), or `None` when the
/// port is malformed.
fn strip_port(authority: &str) -> Option<&str> {
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        let (name, rest) = authority.split_at(end + 1);
        let port_ok = rest.is_empty() || rest.strip_prefix(':').is_some_and(is_port);
        return port_ok.then_some(name);
    }
    match authority.rsplit_once(':') {
        Some((name, port)) => is_port(port).then_some(name),
        None => Some(authority),
    }
}

/// Decimal digits only (`u16` parsing alone would accept a leading `+`)
fn is_port(port: &str) -> bool {
    port.bytes().all(|b| b.is_ascii_digit()) && port.parse::<u16>().is_ok()
}

/// Whether a host name (IPv6 in brackets) names this server from the local network: a
/// local-network IP literal, `localhost`, an mDNS `*.local` name, or a single-label name such
/// as a Windows computer name (`DESKTOP-ABC`), case-insensitive. The one rule for the `Host`
/// header, the WebSocket `Origin` and CORS origins.
fn is_local_host_name(name: &str) -> bool {
    if let Some(inner) = name
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return inner
            .parse::<Ipv6Addr>()
            .is_ok_and(|ip| is_local_network_ip(&IpAddr::V6(ip)));
    }
    if let Ok(ip) = name.parse::<Ipv4Addr>() {
        return is_local_network_ip(&IpAddr::V4(ip));
    }
    let name = name.to_ascii_lowercase();
    if name == "localhost" {
        return true;
    }
    match name.strip_suffix(".local") {
        Some(mdns_name) => !mdns_name.is_empty() && mdns_name.split('.').all(is_dns_label),
        None => is_dns_label(&name),
    }
}

/// One DNS label: letters, digits and inner hyphens
fn is_dns_label(label: &str) -> bool {
    !label.is_empty()
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Whether a WebSocket upgrade's `Origin` may connect: absent (a non-browser client), or an
/// `http`/`https` origin whose host is a local host name.
fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let is_bare_origin = url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    matches!(url.scheme(), "http" | "https")
        && is_bare_origin
        && url.host_str().is_some_and(is_local_host_name)
}

/// A 403 for a WebSocket upgrade from a page served by another site, else `None`.
fn refuse_foreign_origin(headers: &HeaderMap) -> Option<Response<Body>> {
    let origin = headers
        .get(header::ORIGIN)
        .map(|value| value.to_str().unwrap_or_default());
    if is_allowed_origin(origin) {
        return None;
    }
    tracing::warn!(
        "[Server] Refused WebSocket upgrade from origin {:?}",
        origin
    );
    Some((StatusCode::FORBIDDEN, "Access denied: unexpected Origin").into_response())
}

/// Whether a request asks to upgrade to a WebSocket
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::UPGRADE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| value.to_ascii_lowercase().contains("websocket"))
}

/// The 403 body for a request whose `Host` is not a local name
const REFUSED_HOST_MESSAGE: &str = "Access denied: connect using this PC's IP address, its \
    name, or name.local. To allow other addresses, turn on 'Allow devices outside the local \
    network' in Settings on the host.";

/// Whether `origin` is the same origin as the request's `Host`: an `http`/`https` scheme,
/// and its host and port, the port omitted for the scheme's default, compared
/// case-insensitively
fn is_same_origin(origin: &str, host_header: &str) -> bool {
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    authority.eq_ignore_ascii_case(host_header)
}

/// A 403 for a WebSocket upgrade whose `Origin` is neither a local host name nor the
/// request's own `Host`, else `None`
fn refuse_websocket_origin(headers: &HeaderMap, host: Option<&str>) -> Option<Response<Body>> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if let (Some(origin), Some(host)) = (origin, host) {
        if is_same_origin(origin, host) {
            return None;
        }
    }
    refuse_foreign_origin(headers)
}

/// Middleware that refuses, before any handler or CORS answer: clients outside the local
/// network and requests whose `Host` is not a local name (both unless the host allows
/// non-local clients, when any `Host` is served), and WebSocket upgrades whose `Origin` is
/// neither a local name nor the request's own `Host` (always). `allow_non_local_clients` is
/// read on every request, so a host settings change applies without a restart.
async fn auth_middleware(
    State(allow_non_local_clients): State<&'static AtomicBool>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Result<Response<Body>, (StatusCode, String)> {
    let allow_non_local_clients = allow_non_local_clients.load(Ordering::SeqCst);
    if !allow_non_local_clients && !is_local_network_ip(&addr.ip()) {
        return Err((
            StatusCode::FORBIDDEN,
            format!(
                "Access denied: connections only allowed from local network. Your IP: {}",
                addr.ip()
            ),
        ));
    }

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let host_allowed = if allow_non_local_clients {
        host.is_some()
    } else {
        is_allowed_host(host)
    };
    if !host_allowed {
        tracing::warn!("[Server] Refused request for host {:?}", host);
        return Err((StatusCode::FORBIDDEN, REFUSED_HOST_MESSAGE.to_string()));
    }

    if is_websocket_upgrade(request.headers()) {
        if let Some(refused) = refuse_websocket_origin(request.headers(), host) {
            return Ok(refused);
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
    let dist_path = dist_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve dist folder {:?}: {}", dist_path, e))?;

    let allow_non_local_clients = {
        let settings_file = get_global_settings_file(&app_handle)?;
        read_settings_file(&settings_file)?
            .server
            .allow_non_local_clients
    };
    ALLOW_NON_LOCAL_CLIENTS.store(allow_non_local_clients, Ordering::SeqCst);

    tracing::info!(
        "[Server] Starting HTTP server on port {} (serving from {:?})",
        port,
        dist_path
    );
    if allow_non_local_clients {
        tracing::warn!("[Server] Clients outside the local network are allowed");
    } else {
        tracing::info!("[Server] Restricted to local network only");
    }

    // Create unified observations broadcast channel for all data sources
    let (observations_tx, _) = broadcast::channel::<ObservationMessage>(256);
    let observations_tx_return = observations_tx.clone();

    let state = Arc::new(ServerState {
        app_handle,
        dist_path,
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
    origin
        .to_str()
        .is_ok_and(|origin| is_allowed_origin(Some(origin)))
}

/// Wrap `routes` in CORS and, outside it, the access checks, so a refused client gets a 403
/// and never a CORS answer
fn guard(routes: Router, allow_non_local_clients: &'static AtomicBool) -> Router {
    // CORS layer with origin validation
    // Only allow origins from local network addresses
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(validate_cors_origin))
        .allow_methods(Any)
        .allow_headers(Any);

    routes.layer(cors).layer(middleware::from_fn_with_state(
        allow_non_local_clients,
        auth_middleware,
    ))
}

/// Create the axum router with all routes
fn create_router(state: Arc<ServerState>) -> Router {
    let routes = Router::new()
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
        // Diagnostic export endpoint
        .route("/api/diagnostic", post(save_diagnostic_handler))
        // Remote client logging endpoint
        .route("/api/log", post(remote_log))
        // Static file serving (must be last - catches all other routes)
        .fallback(get(serve_static))
        .with_state(state);
    guard(routes, &ALLOW_NON_LOCAL_CLIENTS)
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
                remote_error(
                    AIRPORT_SURFACES_ERROR,
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
        remote_error(
            AIRPORT_SURFACES_ERROR,
            format!("Failed to read airport surfaces file: {}", e),
        )
    })?;

    let mut decoder = GzDecoder::new(&compressed_data[..]);
    let mut decompressed = String::new();
    decoder.read_to_string(&mut decompressed).map_err(|e| {
        remote_error(
            AIRPORT_SURFACES_ERROR,
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

/// Which settings route an error came from: `GET` reads the settings file, `POST` writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettingsRoute {
    Read,
    Write,
}

/// The 500 a remote client gets when `/api/airport-surfaces` fails.
const AIRPORT_SURFACES_ERROR: &str = "Could not load airport surfaces";
/// The 500 a remote client gets when `/api/mods/discover` or a mod list route fails.
const LIST_MODS_ERROR: &str = "Could not list mods";
/// The 500 a remote client gets when `GET /api/tower-positions` fails.
const READ_TOWER_POSITIONS_ERROR: &str = "Could not read tower positions";
/// The 500 a remote client gets when `PUT /api/tower-positions/{icao}` fails.
const SAVE_TOWER_POSITION_ERROR: &str = "Could not save the tower position";
/// The 500 a remote client gets when `/api/vmr-rules` fails.
const VMR_RULES_ERROR: &str = "Could not read VMR rules";
/// The 500 a remote client gets when `/api/diagnostic` fails.
const DIAGNOSTIC_ERROR: &str = "Could not save the diagnostic";
/// The 500 a remote client gets when a file it asked for could not be read or checked.
const READ_FILE_ERROR: &str = "Could not read the file";

/// The error a route sends a remote client: `message`, fixed text, with `detail`, which may name
/// a host path, kept in the host log.
fn remote_error(message: &'static str, detail: impl std::fmt::Display) -> (StatusCode, String) {
    tracing::error!("[Server] {}: {}", message, detail);
    (StatusCode::INTERNAL_SERVER_ERROR, message.to_string())
}

/// The error a settings route sends a remote client: fixed text, with the detail, which names the
/// settings file, kept in the host log.
fn settings_error(route: SettingsRoute, detail: String) -> (StatusCode, String) {
    let message = match route {
        SettingsRoute::Read => "Could not read the settings",
        SettingsRoute::Write => "Could not save the settings",
    };
    remote_error(message, detail)
}

/// GET /api/global-settings - Return the remote view of the global settings
async fn get_global_settings(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let failed = |e: String| settings_error(SettingsRoute::Read, e);
    let settings_file = get_global_settings_file(&state.app_handle).map_err(failed)?;
    let view = run_settings_io(move || read_remote_view(&settings_file))
        .await
        .map_err(failed)?;
    Ok(Json(view))
}

/// Run settings file I/O, which blocks on the settings lock and the disk, off the async
/// workers. The error is the detail for the route's error body.
async fn run_settings_io<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| format!("Settings file task failed: {}", e))?
}

/// POST /api/global-settings - Store a remote client's settings, keeping every host-owned
/// and secret field, and return the remote view of the result
async fn update_global_settings(
    State(state): State<Arc<ServerState>>,
    Json(incoming): Json<GlobalSettings>,
) -> Result<Json<GlobalSettings>, (StatusCode, String)> {
    let failed = |e: String| settings_error(SettingsRoute::Write, e);
    let settings_file = get_global_settings_file(&state.app_handle).map_err(failed)?;

    let view = run_settings_io(move || apply_remote_write(&settings_file, incoming))
        .await
        .map_err(failed)?;

    tracing::info!("[Server] Updated global settings via API");
    Ok(Json(view))
}

/// Mod directory info for API response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModInfo {
    name: String,
    manifest: Option<serde_json::Value>,
}

/// A discovered mod as a remote client sees it: `path` is `mods/` and the folder's path under
/// the mods root (`/`-separated, case kept), the shape the dev server's `scripts/dev/mods.ts`
/// serves too, and `id` is that lowercased.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDiscoveredMod {
    id: String,
    path: String,
    mod_type: String,
    is_git_repo: bool,
    repo_name: Option<String>,
}

/// The `/api/mods/discover` reply for `mods`: each mod with its path under the mods root in
/// place of the host path.
fn remote_discovered_mods(mods: Vec<DiscoveredMod>) -> Vec<RemoteDiscoveredMod> {
    mods.into_iter()
        .map(|found| RemoteDiscoveredMod {
            id: found.id,
            path: found.mods_path,
            mod_type: found.mod_type,
            is_git_repo: found.is_git_repo,
            repo_name: found.repo_name,
        })
        .collect()
}

/// GET /api/mods/discover - Recursively discover all mods (supports git repos)
async fn discover_mods(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<RemoteDiscoveredMod>>, (StatusCode, String)> {
    let mods = discover_all_mods(state.app_handle.clone())
        .map_err(|e| remote_error(LIST_MODS_ERROR, format!("Failed to discover mods: {}", e)))?;
    Ok(Json(remote_discovered_mods(mods)))
}

/// GET /api/mods/file/*path - Serve any file within the mods directory
/// Supports serving files from git repo subfolders
async fn serve_any_mod_file(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> Result<Response<Body>, (StatusCode, String)> {
    let mods_root = find_mods_root(&state.app_handle);
    let file_path = mod_file_path(&mods_root, &path)?;
    serve_file(&file_path).await
}

/// Resolves the file a mod-file route serves under the mods folder.
///
/// Returns 403 for a path outside the mods folder, 404 when no file is there, and 500 when the
/// file system could not be read.
fn mod_file_path(mods_root: &std::path::Path, path: &str) -> Result<PathBuf, (StatusCode, String)> {
    let file_path = resolve_within(mods_root, path).map_err(|e| {
        e.into_response(
            (StatusCode::FORBIDDEN, "Access denied".to_string()),
            "Checking the mod file path",
        )
    })?;
    if !file_path.is_file() {
        return Err((StatusCode::NOT_FOUND, "File not found".to_string()));
    }
    Ok(file_path)
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
        .map_err(|e| remote_error(LIST_MODS_ERROR, format!("Failed to read mods: {}", e)))?;

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

        mods.push(ModInfo { name, manifest });
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
    let file_path = mod_file_path(&mods_root, &format!("{}/{}", mod_type, path))?;
    serve_file(&file_path).await
}

/// GET /api/msfs/models - List converted MSFS models (FSLTL/AIG)
/// Returns flat list of cached GLB files with their model keys for remote browser clients
async fn list_msfs_converted_models(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<Vec<RemoteCachedModel>>, (StatusCode, String)> {
    // The detail names host paths, so it stays in the host log.
    let failed = |e: String| {
        tracing::error!("[Server] Listing converted MSFS models failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to list converted models".to_string(),
        )
    };

    // Get MSFS model cache directory from global settings
    let settings_file = get_global_settings_file(&state.app_handle).map_err(failed)?;

    let cache_dir = read_settings_file(&settings_file)
        .map_err(failed)?
        .msfs_models
        .cache_directory;

    let Some(cache_dir) = cache_dir else {
        return Ok(Json(Vec::new()));
    };

    // Use scan_cache_directory which correctly scans flat GLB files (same as host initialization)
    let models = crate::msfs::scan_cache_directory(cache_dir)
        .await
        .map_err(failed)?;

    Ok(Json(crate::msfs::remote_cached_models(models)))
}

/// GET /api/msfs/*path - Serve converted MSFS model file (FSLTL/AIG)
async fn serve_msfs_model(
    State(state): State<Arc<ServerState>>,
    Path(path): Path<String>,
) -> impl IntoResponse {
    if !is_servable_model_name(&path) {
        return Err((StatusCode::NOT_FOUND, "File not found".to_string()));
    }

    // The detail names host paths, so it stays in the host log.
    let failed = |e: String| {
        tracing::error!(
            "[Server] Reading the MSFS model cache setting failed: {}",
            e
        );
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read the MSFS model settings".to_string(),
        )
    };

    // Get MSFS model cache directory from global settings
    let settings_file = get_global_settings_file(&state.app_handle).map_err(failed)?;

    let cache_dir = read_settings_file(&settings_file)
        .map_err(failed)?
        .msfs_models
        .cache_directory;

    let Some(cache_dir) = cache_dir else {
        return Err((
            StatusCode::NOT_FOUND,
            "MSFS model cache directory not configured".to_string(),
        ));
    };

    let file_path = match resolve_within(std::path::Path::new(&cache_dir), &path) {
        Ok(file_path) => file_path,
        Err(ResolveError::Outside) => {
            tracing::warn!(
                "[Server] Refused MSFS model path outside the cache: {}",
                path
            );
            return Err((StatusCode::FORBIDDEN, "Access denied".to_string()));
        }
        Err(e) => {
            return Err(e.into_response(
                (StatusCode::FORBIDDEN, "Access denied".to_string()),
                "Checking the MSFS model path",
            ))
        }
    };

    if !file_path.is_file() {
        return Err((StatusCode::NOT_FOUND, "File not found".to_string()));
    }

    serve_file(&file_path).await
}

/// Whether `/api/msfs/{name}` may serve `name`: a top-level `.glb` (any case) not starting with
/// `.`, so a converter's `.{name}.{pid}.tmp` file or anything in a subfolder is never served.
fn is_servable_model_name(name: &str) -> bool {
    let name = name.strip_prefix('/').unwrap_or(name);
    !name.contains(['/', '\\'])
        && !name.starts_with('.')
        && name.len() > ".glb".len()
        && name.to_ascii_lowercase().ends_with(".glb")
}

/// GET /api/msfs/index - Get the MSFS model index for remote clients
async fn get_msfs_model_index(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<RemoteModelIndex>, (StatusCode, String)> {
    // Get the model index from the MSFS module
    let index = crate::msfs::get_model_index(&state.app_handle).map_err(|e| {
        tracing::error!("[Server] Reading the MSFS model index failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to get model index".to_string(),
        )
    })?;

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

/// The texture scales the converter offers, the only ones `POST /api/msfs/convert` passes on.
const TEXTURE_SCALES: [&str; 4] = ["full", "2k", "1k", "512"];

/// Refuses a texture scale the converter does not offer before it reaches the converter's arguments.
fn check_texture_scale(scale: &str) -> Result<(), (StatusCode, String)> {
    if TEXTURE_SCALES.contains(&scale) {
        Ok(())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "Unknown texture scale: expected full, 2k, 1k or 512".to_string(),
        ))
    }
}

/// Conversion response
#[derive(Debug, serde::Serialize)]
struct ConversionResponse {
    success: bool,
    /// Path to the converted GLB file (relative to cache directory)
    output_path: Option<String>,
    error: Option<String>,
}

/// How long a refused remote conversion asks the browser to wait before it asks again, in seconds.
const CONVERSION_RETRY_AFTER_SECS: &str = "30";

/// POST /api/msfs/convert - Request conversion of an MSFS model. The model is looked up in the
/// host's index before anything waits, and converted at the host's texture scale.
async fn request_msfs_conversion(
    State(state): State<Arc<ServerState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(request): Json<ConversionRequest>,
) -> Result<Response<Body>, (StatusCode, String)> {
    check_texture_scale(&request.texture_scale)?;
    let model_name = request.model_name.as_str();

    let settings = match get_global_settings_file(&state.app_handle)
        .and_then(|file| read_settings_file(&file))
    {
        Ok(settings) => settings.msfs_models,
        Err(e) => return Ok(conversion_failed(model_name, &e)),
    };
    let entry = match crate::msfs::find_index_entry(&state.app_handle, &settings, model_name) {
        Ok(Some(entry)) => entry,
        Ok(None) => {
            return Ok(conversion_failed(
                model_name,
                &format!("Model not found: {}", model_name),
            ))
        }
        Err(e) => return Ok(conversion_failed(model_name, &e)),
    };
    let Some(cache_dir) = settings.cache_directory.clone() else {
        return Ok(conversion_failed(
            model_name,
            "MSFS model cache directory not configured",
        ));
    };

    let owner = state.app_handle.state::<ConversionOwner>();
    let result = convert_for_remote(
        &owner,
        &entry,
        PathBuf::from(cache_dir),
        &settings.texture_scale,
        addr.ip(),
    )
    .await;
    Ok(conversion_response(model_name, result))
}

/// Converts `entry` into `cache_dir` for the remote client at `ip`, answering at once with the
/// GLB already there when it passes the cache scan's check. Returns the GLB's file name.
async fn convert_for_remote(
    owner: &ConversionOwner,
    entry: &SourceModelInfo,
    cache_dir: PathBuf,
    texture_scale: &str,
    ip: IpAddr,
) -> Result<String, ConversionError> {
    let request =
        crate::conversion::ConversionRequest::from_index_entry(entry, cache_dir, texture_scale);
    let file_name = request.output_file_name();
    if crate::msfs::is_accepted_glb(&request.output_dir.join(&file_name)) {
        return Ok(file_name);
    }
    owner
        .convert(request, Caller::Remote(ip))
        .await
        .map(|converted| converted.file_name)
}

/// The reply to a remote conversion: the GLB's name, a 503 asking the client to come back after
/// `Retry-After` when the host refused for load, or a fixed failure.
fn conversion_response(
    model_name: &str,
    result: Result<String, ConversionError>,
) -> Response<Body> {
    match result {
        Ok(file_name) => Json(ConversionResponse {
            success: true,
            output_path: Some(file_name),
            error: None,
        })
        .into_response(),
        Err(ConversionError::Refused(refusal)) => {
            tracing::info!(
                "[Server] Refused converting MSFS model {:?}: {:?}",
                model_name,
                refusal
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, CONVERSION_RETRY_AFTER_SECS)],
                Json(serde_json::json!({ "success": false, "error": "busy" })),
            )
                .into_response()
        }
        Err(e) => conversion_failed(model_name, &e.to_string()),
    }
}

/// A failed remote conversion's fixed reply; the detail (the converter's stderr included) names
/// host paths, so it stays in the host log.
fn conversion_failed(model_name: &str, detail: &str) -> Response<Body> {
    tracing::error!(
        "[Server] Converting MSFS model {:?} failed: {}",
        model_name,
        detail
    );
    Json(ConversionResponse {
        success: false,
        output_path: None,
        error: Some("Model conversion failed".to_string()),
    })
    .into_response()
}

/// GET /api/tower-positions - Custom tower positions JSON
async fn get_tower_positions(
    State(state): State<Arc<ServerState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let positions = read_tower_positions(state.app_handle.clone())
        .map_err(|e| remote_error(READ_TOWER_POSITIONS_ERROR, e))?;

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

    // Write to individual file named {ICAO}.json
    let file_path = tower_position_file_path(&tower_positions_dir, &icao).map_err(|e| {
        e.into_response(
            (
                StatusCode::BAD_REQUEST,
                format!(
                    "Invalid ICAO code {:?}: expected 3-4 letters or digits",
                    icao
                ),
            ),
            "Checking the tower position path",
        )
    })?;

    // Create tower-positions directory if it doesn't exist
    fs::create_dir_all(&tower_positions_dir).map_err(|e| {
        remote_error(
            SAVE_TOWER_POSITION_ERROR,
            format!("Failed to create tower-positions directory: {}", e),
        )
    })?;

    // If file exists, merge with existing data (preserve other view if only updating one)
    let mut entry = if file_path.exists() {
        let content = fs::read_to_string(&file_path).map_err(|e| {
            remote_error(
                SAVE_TOWER_POSITION_ERROR,
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
        remote_error(
            SAVE_TOWER_POSITION_ERROR,
            format!("Failed to serialize position: {}", e),
        )
    })?;

    fs::write(&file_path, content).map_err(|e| {
        remote_error(
            SAVE_TOWER_POSITION_ERROR,
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

        let entries = fs::read_dir(dir)
            .map_err(|e| remote_error(VMR_RULES_ERROR, format!("Failed to read dir: {}", e)))?;

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

// =============================================================================
// DIAGNOSTIC EXPORT
// =============================================================================

#[derive(Deserialize)]
struct DiagnosticSaveRequest {
    filename: String,
    content: String,
}

/// The `/api/diagnostic` reply: the saved file's name, never its host path.
#[derive(Serialize)]
struct DiagnosticSaveResponse {
    filename: String,
}

/// The reply for a diagnostic saved at `file_path`.
fn diagnostic_response(file_path: &std::path::Path) -> DiagnosticSaveResponse {
    let filename = file_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    DiagnosticSaveResponse { filename }
}

/// POST /api/diagnostic - Save diagnostic package to host filesystem
async fn save_diagnostic_handler(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<DiagnosticSaveRequest>,
) -> Result<Json<DiagnosticSaveResponse>, (StatusCode, String)> {
    let diag_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| {
            remote_error(
                DIAGNOSTIC_ERROR,
                format!("Failed to get app data directory: {}", e),
            )
        })?
        .join("diagnostics");

    fs::create_dir_all(&diag_dir).map_err(|e| {
        remote_error(
            DIAGNOSTIC_ERROR,
            format!("Failed to create diagnostics directory: {}", e),
        )
    })?;

    let file_path = diagnostic_file_path(&diag_dir, &req.filename).map_err(|e| {
        e.into_response(
            (
                StatusCode::BAD_REQUEST,
                format!(
                    "Invalid diagnostic filename {:?}: expected tc3d-diag-<name>.tc3d-diag.json, the name made of letters, digits, '-', '_' or '.'",
                    req.filename
                ),
            ),
            "Checking the diagnostic file path",
        )
    })?;
    fs::write(&file_path, &req.content).map_err(|e| {
        remote_error(
            DIAGNOSTIC_ERROR,
            format!("Failed to write diagnostic file: {}", e),
        )
    })?;

    tracing::info!(
        "[Diagnostic] Saved to {}",
        normalize_path_string(&file_path)
    );

    Ok(Json(diagnostic_response(&file_path)))
}

// =============================================================================
// REMOTE LOGGING
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
            _ => {
                tracing::info!(target: "frontend", "[{}] [{}] {}", client_prefix, entry.level, entry.message)
            }
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
) -> Response<Body> {
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
        let active = state
            .realtraffic_active
            .read()
            .ok()
            .map(|g| *g)
            .unwrap_or(false);
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
            tracing::warn!("[Observations WS] Unknown action: {}", request.action);
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
) -> Response<Body> {
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

    // A path that could leave dist is refused, never answered with the SPA's HTML
    let file_path = match resolve_static_path(&state.dist_path, path) {
        Ok(file_path) => file_path,
        Err(ResolveError::Outside) => {
            tracing::warn!("[Server] Refused static path outside dist: {}", path);
            return Err((StatusCode::NOT_FOUND, "Not found".to_string()));
        }
        Err(e) => {
            return Err(e.into_response(
                (StatusCode::NOT_FOUND, "Not found".to_string()),
                "Checking the static file path",
            ))
        }
    };

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
    let has_extension = file_path.extension().is_some_and(|ext| {
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
    let content = fs::read(path)
        .map_err(|e| remote_error(READ_FILE_ERROR, format!("Failed to read {:?}: {}", path, e)))?;

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

// =============================================================================
// Request Path Containment
// =============================================================================

/// Why a path built from a request was refused.
#[derive(Debug)]
enum ResolveError {
    /// The path leaves its root, could step out of it, or does not have the form the route accepts.
    Outside,
    /// The file system could not answer while the path was checked.
    Io(std::io::Error),
}

impl ResolveError {
    /// The response for this refusal: `outside` when the path is outside its root, else a 500
    /// with fixed text, the I/O error logged with `operation`.
    fn into_response(self, outside: (StatusCode, String), operation: &str) -> (StatusCode, String) {
        match self {
            Self::Outside => outside,
            Self::Io(e) => remote_error(READ_FILE_ERROR, format!("{} failed: {}", operation, e)),
        }
    }
}

/// Joins an untrusted relative path from a request onto `root`, refusing any path that could leave it.
///
/// One leading `/` is ignored; after it, both `/` and `\` separate components, and every component
/// must be a plain name: not empty, not `.` or `..`, free of NUL and `:` (a drive prefix or an NTFS
/// stream), and a single `Component::Normal` on this platform. The target, or its deepest existing
/// ancestor when it does not exist yet, is canonicalised and must stay under the canonical root,
/// which refuses an escape through a symlink or junction; a dangling link is refused. A root that
/// does not exist holds nothing a link could lead out of, so the plain join is returned.
///
/// Args:
///     root: The folder the result must stay inside.
///     untrusted: A relative path taken from a request.
///
/// Returns:
///     The joined path (canonical when the target exists), `ResolveError::Outside` when the path is
///     refused, or `ResolveError::Io` when the file system could not be read.
fn resolve_within(root: &std::path::Path, untrusted: &str) -> Result<PathBuf, ResolveError> {
    match root.canonicalize() {
        Ok(canonical_root) => resolve_within_canonical(root, &canonical_root, untrusted),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => join_plain_names(root, untrusted),
        Err(e) => Err(ResolveError::Io(e)),
    }
}

/// `resolve_within` for a root whose canonical form the caller already holds.
fn resolve_within_canonical(
    root: &std::path::Path,
    canonical_root: &std::path::Path,
    untrusted: &str,
) -> Result<PathBuf, ResolveError> {
    let joined = join_plain_names(root, untrusted)?;
    match fs::symlink_metadata(&joined) {
        Ok(_) => {
            let canonical = canonicalize_existing(&joined)?;
            if canonical.starts_with(canonical_root) {
                Ok(canonical)
            } else {
                Err(ResolveError::Outside)
            }
        }
        Err(e) if is_missing_entry(&e) => {
            let existing = canonicalize_existing(deepest_existing_ancestor(&joined)?)?;
            if existing.starts_with(canonical_root) {
                Ok(joined)
            } else {
                Err(ResolveError::Outside)
            }
        }
        Err(e) => Err(ResolveError::Io(e)),
    }
}

/// Joins `untrusted` onto `root` component by component, refusing any component that is not a plain name.
fn join_plain_names(root: &std::path::Path, untrusted: &str) -> Result<PathBuf, ResolveError> {
    let relative = untrusted.strip_prefix('/').unwrap_or(untrusted);
    if relative.is_empty() {
        return Err(ResolveError::Outside);
    }

    let mut joined = root.to_path_buf();
    for segment in relative.split(['/', '\\']) {
        if !is_plain_name(segment) {
            return Err(ResolveError::Outside);
        }
        joined.push(segment);
    }
    Ok(joined)
}

/// Canonicalises a path whose entry exists; an entry whose target is missing (a dangling link) is
/// refused as `Outside`.
fn canonicalize_existing(path: &std::path::Path) -> Result<PathBuf, ResolveError> {
    path.canonicalize().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ResolveError::Outside,
        _ => ResolveError::Io(e),
    })
}

/// The nearest ancestor of `path` that exists as an entry (a link counts as one).
fn deepest_existing_ancestor(path: &std::path::Path) -> Result<&std::path::Path, ResolveError> {
    for ancestor in path.ancestors().skip(1) {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => return Ok(ancestor),
            Err(e) if is_missing_entry(&e) => continue,
            Err(e) => return Err(ResolveError::Io(e)),
        }
    }
    Err(ResolveError::Outside)
}

/// Whether a `symlink_metadata` error means no entry is at that path: none there, a file where a
/// folder was expected, or a name the file system cannot hold.
fn is_missing_entry(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound
            | std::io::ErrorKind::NotADirectory
            | std::io::ErrorKind::InvalidFilename
    )
}

/// Whether `segment` is one plain file or folder name that cannot step out of its parent.
///
/// Characters Windows refuses in a name (`< > " | ? *` and ASCII controls) are refused on every
/// platform, so such a request is answered as refused rather than as a file system error.
fn is_plain_name(segment: &str) -> bool {
    let has_reserved_char = segment
        .chars()
        .any(|c| c.is_ascii_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'));
    if segment.is_empty() || has_reserved_char {
        return false;
    }
    let mut components = std::path::Path::new(segment).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    )
}

/// Resolves a static-file URL path under the canonical dist folder; the root URL maps to `index.html`.
///
/// Empty segments between `/` are dropped, as a browser's `/foo/` or `/assets//app.js` mean the same
/// route or file without them; every remaining segment is checked by `resolve_within_canonical`.
fn resolve_static_path(
    canonical_dist: &std::path::Path,
    url_path: &str,
) -> Result<PathBuf, ResolveError> {
    let segments: Vec<&str> = url_path.split('/').filter(|s| !s.is_empty()).collect();
    let path = if segments.is_empty() {
        "index.html".to_string()
    } else {
        segments.join("/")
    };
    resolve_within_canonical(canonical_dist, canonical_dist, &path)
}

/// The start of every diagnostic file name the client builds (`DiagnosticService.buildFilename`).
const DIAGNOSTIC_FILE_PREFIX: &str = "tc3d-diag-";
/// The end of every diagnostic file name the client builds.
const DIAGNOSTIC_FILE_SUFFIX: &str = ".tc3d-diag.json";

/// Whether `filename` has the form the client builds: `tc3d-diag-<middle>.tc3d-diag.json`, the middle
/// non-empty and made of ASCII letters, digits, `-`, `_` and `.` only.
///
/// The fixed prefix and suffix rule out Windows device names (`COM1`, `NUL`) and a trailing dot or
/// space, which Windows strips and so would write over another file.
fn is_diagnostic_file_name(filename: &str) -> bool {
    let middle = filename
        .strip_prefix(DIAGNOSTIC_FILE_PREFIX)
        .and_then(|rest| rest.strip_suffix(DIAGNOSTIC_FILE_SUFFIX));
    middle.is_some_and(|middle| {
        !middle.is_empty()
            && middle
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    })
}

/// Resolves the file a diagnostic upload is written to inside the diagnostics folder.
///
/// The filename must have the form the client builds (see `is_diagnostic_file_name`).
fn diagnostic_file_path(
    diag_dir: &std::path::Path,
    filename: &str,
) -> Result<PathBuf, ResolveError> {
    if !is_diagnostic_file_name(filename) {
        return Err(ResolveError::Outside);
    }
    resolve_within(diag_dir, filename)
}

/// Resolves the `{ICAO}.json` file a tower position update writes.
///
/// The code must be 3-4 ASCII letters, digits or `_` (the bundled airport list has `EK_2` and
/// `EK_4`); it is upper-cased for the file name.
fn tower_position_file_path(dir: &std::path::Path, icao: &str) -> Result<PathBuf, ResolveError> {
    let is_code_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let is_icao = (3..=4).contains(&icao.len()) && icao.chars().all(is_code_char);
    if !is_icao {
        return Err(ResolveError::Outside);
    }
    resolve_within(dir, &format!("{}.json", icao.to_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::host_path_walk::{assert_holds_no_host_path, HOST_PATHS};

    #[test]
    fn settings_errors_send_fixed_text_holding_no_host_path() {
        for path in HOST_PATHS {
            let detail = format!("Failed to read global settings \"{path}\": access denied");
            for (route, expected) in [
                (SettingsRoute::Read, "Could not read the settings"),
                (SettingsRoute::Write, "Could not save the settings"),
            ] {
                let (status, body) = settings_error(route, detail.clone());
                assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(
                    body, expected,
                    "{route:?} sent a body naming the settings file"
                );
                assert_holds_no_host_path(&serde_json::Value::String(body));
            }
        }
    }

    /// Every key the objects of the JSON array `entries` hold.
    fn entry_keys(entries: &serde_json::Value) -> std::collections::BTreeSet<String> {
        let entries = entries.as_array().expect("entries are an array");
        assert!(!entries.is_empty(), "no entries to check");
        entries
            .iter()
            .flat_map(|entry| entry.as_object().expect("entry is an object").keys())
            .cloned()
            .collect()
    }

    fn key_set(keys: &[&str]) -> std::collections::BTreeSet<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    /// A mod as `discover_all_mods` finds it in `mods_root`, at `parts` under it.
    fn discovered_mod(
        mods_root: &std::path::Path,
        parts: &[&str],
        mod_type: &str,
    ) -> DiscoveredMod {
        let dir = parts
            .iter()
            .fold(mods_root.to_path_buf(), |dir, part| dir.join(part));
        let mods_path =
            crate::mods::mods_relative_path(&dir, mods_root).expect("mod is under the root");
        DiscoveredMod {
            path: normalize_path_string(&dir),
            id: mods_path.to_lowercase(),
            mods_path,
            mod_type: mod_type.to_string(),
            is_git_repo: false,
            repo_name: None,
        }
    }

    #[test]
    fn remote_discovered_mods_hold_no_host_path() {
        for host in HOST_PATHS {
            let mods_root = PathBuf::from(host).join("mods");
            let mods = vec![
                discovered_mod(&mods_root, &["Aircraft", "B738"], "aircraft"),
                discovered_mod(&mods_root, &["towers", "KOAK", "KOAK"], "tower"),
            ];
            let reply = serde_json::to_value(remote_discovered_mods(mods)).expect("serialise");
            assert_holds_no_host_path(&reply);
            assert_eq!(
                entry_keys(&reply),
                key_set(&["id", "path", "modType", "isGitRepo", "repoName"]),
                "a new discover field needs a decision on whether a remote may see it"
            );
            assert_eq!(reply[0]["id"], "mods/aircraft/b738");
            assert_eq!(reply[0]["path"], "mods/Aircraft/B738");
            assert_eq!(reply[1]["id"], "mods/towers/koak/koak");
            assert_eq!(reply[1]["path"], "mods/towers/KOAK/KOAK");
        }
    }

    #[test]
    fn remote_errors_send_fixed_text_holding_no_host_path() {
        let messages = [
            (AIRPORT_SURFACES_ERROR, "Could not load airport surfaces"),
            (LIST_MODS_ERROR, "Could not list mods"),
            (READ_TOWER_POSITIONS_ERROR, "Could not read tower positions"),
            (
                SAVE_TOWER_POSITION_ERROR,
                "Could not save the tower position",
            ),
            (VMR_RULES_ERROR, "Could not read VMR rules"),
            (DIAGNOSTIC_ERROR, "Could not save the diagnostic"),
            (READ_FILE_ERROR, "Could not read the file"),
        ];
        for path in HOST_PATHS {
            let detail = format!("Failed to read \"{path}\": access denied");
            for (message, expected) in messages {
                assert_eq!(message, expected, "a remote error text changed");
                let (status, body) = remote_error(message, &detail);
                assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
                assert_eq!(body, expected, "{expected:?} sent the error detail");
                assert_holds_no_host_path(&serde_json::Value::String(body));
            }

            let io = std::io::Error::other(format!("cannot open \"{path}\""));
            let (status, body) = ResolveError::Io(io).into_response(
                (StatusCode::FORBIDDEN, "Access denied".to_string()),
                "Checking the mod file path",
            );
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(body, "Could not read the file");
            assert_holds_no_host_path(&serde_json::Value::String(body));
        }
    }

    #[test]
    fn diagnostic_reply_holds_only_the_file_name() {
        for host in HOST_PATHS {
            let file = PathBuf::from(host)
                .join("diagnostics")
                .join("tc3d-diag-KOAK.tc3d-diag.json");
            let reply = serde_json::to_value(diagnostic_response(&file)).expect("serialise");
            assert_holds_no_host_path(&reply);
            assert_eq!(
                entry_keys(&serde_json::json!([reply.clone()])),
                key_set(&["filename"])
            );
            assert_eq!(reply["filename"], "tc3d-diag-KOAK.tc3d-diag.json");
        }
    }

    #[test]
    fn mod_list_entries_hold_only_name_and_manifest() {
        let entry = ModInfo {
            name: "B738".to_string(),
            manifest: Some(serde_json::json!({ "type": "aircraft" })),
        };
        let reply = serde_json::to_value(vec![entry]).expect("serialise");
        assert_holds_no_host_path(&reply);
        assert_eq!(entry_keys(&reply), key_set(&["name", "manifest"]));
    }

    /// The index entry of livery `title` of the FSLTL Boeing 737 `conversion::test_support` uses.
    fn index_entry(title: &str) -> SourceModelInfo {
        let folder = "C:/Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B738_ZZZZ";
        SourceModelInfo {
            source: "fsltl".to_string(),
            model_name: title.to_string(),
            folder_name: "FSLTL_B738_ZZZZ".to_string(),
            aircraft_folder_path: folder.to_string(),
            gltf_path: format!("{folder}/model/B738.gltf"),
            texture_dirs: vec![format!("{folder}/texture.AAL")],
            aircraft_type: "B738".to_string(),
            airline_code: Some("AAL".to_string()),
            atc_id: None,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_remote_conversion_answers_503_with_retry_after() {
        use crate::conversion::test_support::{remote, request, start, FakeRunner, TempDir};

        let dir = TempDir::new("server-refused");
        let (runner, mut control) = FakeRunner::new();
        let owner = ConversionOwner::new(runner);
        let _running = start(&owner, request(&dir.0, "Running"), remote(7));
        control.next_spawn().await;

        let ip = IpAddr::from([192, 168, 1, 7]);
        let refused =
            convert_for_remote(&owner, &index_entry("Second"), dir.0.clone(), "1k", ip).await;
        let response = conversion_response("Second", refused);

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "30");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        let body: serde_json::Value = serde_json::from_slice(&body).expect("JSON body");
        assert_eq!(
            body,
            serde_json::json!({ "success": false, "error": "busy" })
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_accepted_glb_already_cached_is_answered_without_converting() {
        use crate::conversion::test_support::{write_glb, FakeRunner, TempDir};

        let dir = TempDir::new("server-cached");
        let cached = crate::conversion::ConversionRequest::from_index_entry(
            &index_entry("Cached"),
            dir.0.clone(),
            "1k",
        )
        .output_file_name();
        write_glb(&dir.0.join(&cached));
        let (runner, control) = FakeRunner::new();
        let owner = ConversionOwner::new(runner);

        let ip = IpAddr::from([192, 168, 1, 8]);
        let answer =
            convert_for_remote(&owner, &index_entry("Cached"), dir.0.clone(), "1k", ip).await;

        assert_eq!(answer, Ok(cached));
        assert_eq!(control.spawn_count(), 0, "the converter was started");
    }

    #[test]
    fn only_top_level_glb_files_are_served_from_the_model_cache() {
        for served in ["fsltl_A.glb", "/fsltl_A.glb", "aig_B C.GLB"] {
            assert!(is_servable_model_name(served), "{served:?} refused");
        }
        for refused in [
            ".x.123.tmp",
            ".fsltl_A.glb.123.tmp",
            ".hidden.glb",
            "sub/fsltl_A.glb",
            "sub\\fsltl_A.glb",
            "fsltl_A.gltf",
            ".glb",
            "",
        ] {
            assert!(!is_servable_model_name(refused), "{refused:?} served");
        }
    }

    #[test]
    fn a_listed_converted_model_is_served_by_its_file_name() {
        use crate::conversion::test_support::{write_livery_glb, TempDir};

        let dir = TempDir::new("server-listed");
        let title = "Listed: A320 (D-AINA)";
        let name = crate::conversion::ConversionRequest::from_index_entry(
            &index_entry(title),
            dir.0.clone(),
            "1k",
        )
        .output_file_name();
        write_livery_glb(&dir.0.join(&name), title);

        let scanned = crate::msfs::scan_cache_dir_sync(&dir.0).expect("scan the cache");
        let listed = serde_json::to_value(crate::msfs::remote_cached_models(scanned))
            .expect("serialise models");

        assert_eq!(listed[0]["file_name"], name.as_str());
        assert_eq!(listed[0]["model_key"], "fsltl_Listed: A320 (D-AINA)");
        assert!(is_servable_model_name(&name), "{name:?} refused");
        let served = resolve_within(&dir.0, &name).expect("resolve the listed name");
        assert!(
            served.is_file(),
            "{} is not the cached GLB",
            served.display()
        );
    }

    #[test]
    fn texture_scale_outside_the_allowed_values_is_refused() {
        for allowed in ["full", "2k", "1k", "512"] {
            assert!(
                check_texture_scale(allowed).is_ok(),
                "{allowed:?} should be accepted"
            );
        }
        for refused in [
            "",
            "4k",
            "FULL",
            "1K",
            " 1k",
            "1k ",
            "--output",
            "1k,--source",
            "512\0",
        ] {
            let (status, body) =
                check_texture_scale(refused).expect_err("an unknown texture scale is refused");
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused:?}");
            assert_eq!(body, "Unknown texture scale: expected full, 2k, 1k or 512");
        }
    }

    #[test]
    fn host_check_accepts_ip_literals_localhost_and_mdns_names() {
        for good in [
            "192.168.1.5:8765",
            "192.168.1.5",
            "[::1]:8765",
            "[fe80::1]",
            "localhost",
            "localhost:8765",
            "pc.local",
            "PC.LOCAL:8765",
        ] {
            assert!(is_allowed_host(Some(good)), "{good:?} should be accepted");
        }
    }

    #[test]
    fn host_check_refuses_other_names_and_a_missing_host() {
        for bad in [
            "evil.example",
            "evil.example:8765",
            "127.0.0.1.evil.example",
            "localhost.evil.example",
            ".local",
            "pc.local:notaport",
            "[::1",
            "::1",
            "",
        ] {
            assert!(!is_allowed_host(Some(bad)), "{bad:?} should be refused");
        }
        assert!(!is_allowed_host(None), "a missing Host should be refused");
    }

    #[test]
    fn origin_check_allows_absent_and_local_origins() {
        for good in [
            None,
            Some("http://192.168.1.5:8765"),
            Some("https://localhost"),
            Some("http://[::1]:8765"),
            Some("http://pc.local:8765"),
        ] {
            assert!(is_allowed_origin(good), "{good:?} should be allowed");
        }
    }

    #[test]
    fn origin_check_refuses_foreign_and_opaque_origins() {
        for bad in [
            "http://evil.example",
            "http://127.0.0.1.evil.example:8765",
            "null",
            "file:///C:/x.html",
            "ws://localhost:8765",
            "not a url",
        ] {
            assert!(!is_allowed_origin(Some(bad)), "{bad:?} should be refused");
        }
    }

    #[test]
    fn local_network_ip_table() {
        let cases = [
            ("127.0.0.1", true),
            ("127.255.0.9", true),
            ("10.0.0.1", true),
            ("172.16.0.1", true),
            ("172.31.255.255", true),
            ("172.15.0.1", false),
            ("172.32.0.1", false),
            ("192.168.1.5", true),
            ("192.169.0.1", false),
            ("169.254.1.1", true),
            ("8.8.8.8", false),
            ("100.64.0.1", false),
            ("::1", true),
            ("fe80::1", true),
            ("febf::1", true),
            ("fec0::1", false),
            ("fc00::1", true),
            ("fd12:3456::1", true),
            ("2001:db8::1", false),
        ];
        for (ip, local) in cases {
            let parsed: IpAddr = ip.parse().expect("test address parses");
            assert_eq!(is_local_network_ip(&parsed), local, "{ip}");
        }
    }

    #[test]
    fn origin_check_refuses_public_ip_origin() {
        assert!(!is_allowed_origin(Some("http://203.0.113.5")));
    }

    #[test]
    fn host_check_accepts_single_label_names() {
        for good in ["DESKTOP-ABC:8765", "desktop-abc", "mypc"] {
            assert!(is_allowed_host(Some(good)), "{good:?} should be accepted");
        }
        for bad in [
            "8.8.8.8",
            "203.0.113.5:8765",
            "[2001:db8::1]:8765",
            "-pc",
            "my_pc",
        ] {
            assert!(!is_allowed_host(Some(bad)), "{bad:?} should be refused");
        }
    }

    /// Bounds a wait that only a broken server reaches.
    const HANG_GUARD: std::time::Duration = std::time::Duration::from_secs(300);

    /// A flag private to one test, as the server reads `ALLOW_NON_LOCAL_CLIENTS`.
    fn test_flag(value: bool) -> &'static AtomicBool {
        Box::leak(Box::new(AtomicBool::new(value)))
    }

    /// Serves the access checks around a route that always answers 200 "ok", on a free
    /// loopback port. The server stops when the returned runtime is dropped.
    fn serve_guarded(
        allow_non_local_clients: &'static AtomicBool,
    ) -> (tokio::runtime::Runtime, SocketAddr) {
        let runtime = tokio::runtime::Runtime::new().expect("start runtime");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind free port");
        listener
            .set_nonblocking(true)
            .expect("non-blocking listener");
        let addr = listener.local_addr().expect("listener address");
        let app = guard(
            Router::new().fallback(|| async { "ok" }),
            allow_non_local_clients,
        );
        runtime.spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("serve");
        });
        (runtime, addr)
    }

    /// Sends one raw HTTP/1.1 request and returns the status code and body.
    fn send(addr: SocketAddr, request: &str) -> (u16, String) {
        let (status, _, body) = send_for_head(addr, request);
        (status, body)
    }

    /// Sends one raw HTTP/1.1 request and returns the status code, the head and the body.
    fn send_for_head(addr: SocketAddr, request: &str) -> (u16, String, String) {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect(addr).expect("connect");
        stream
            .set_read_timeout(Some(HANG_GUARD))
            .expect("set read timeout");
        stream.write_all(request.as_bytes()).expect("send request");

        let mut response = Vec::new();
        let mut chunk = [0u8; 4096];
        let header_end = loop {
            let read = stream.read(&mut chunk).expect("read response");
            assert!(read > 0, "connection closed before the response headers");
            response.extend_from_slice(&chunk[..read]);
            if let Some(end) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let head = String::from_utf8_lossy(&response[..header_end]).to_string();
        let status = head
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("status code");
        let length: usize = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().ok())?
            })
            .unwrap_or(0);
        while response.len() < header_end + length {
            let read = stream.read(&mut chunk).expect("read body");
            assert!(read > 0, "connection closed before the response body");
            response.extend_from_slice(&chunk[..read]);
        }
        let body = String::from_utf8_lossy(&response[header_end..header_end + length]).to_string();
        (status, head, body)
    }

    /// A WebSocket upgrade request for `path` with the given `Host` and `Origin`.
    fn upgrade_request(path: &str, host: &str, origin: &str) -> String {
        format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\
             Origin: {origin}\r\n\r\n"
        )
    }

    #[test]
    fn same_origin_websocket_upgrade_is_allowed_for_non_local_hosts() {
        let (_runtime, addr) = serve_guarded(test_flag(true));
        let host = "home.example.com:8765";
        let (status, _) = send(
            addr,
            &upgrade_request("/api/presence", host, "http://home.example.com:8765"),
        );
        assert_eq!(status, 200, "same-origin upgrade through a DNS name");
        for origin in ["ws://home.example.com:8765", "ftp://home.example.com:8765"] {
            let (status, _) = send(addr, &upgrade_request("/api/presence", host, origin));
            assert_eq!(status, 403, "non-http same-host origin {origin}");
        }
        let (status, _) = send(
            addr,
            &upgrade_request("/api/presence", host, "http://other.example.com:8765"),
        );
        assert_eq!(status, 403, "cross-origin upgrade through a DNS name");
    }

    #[test]
    fn cors_and_websocket_agree_on_origins() {
        let (_runtime, addr) = serve_guarded(test_flag(false));
        let host = "192.168.1.5:8765";
        for origin in [
            "http://8.8.8.8",
            "http://203.0.113.5:8765",
            "http://evil.example",
            "http://192.168.1.6:8765",
            "http://localhost:5173",
            "http://pc.local",
            "http://desktop-abc:8765",
        ] {
            let (_, head, _) = send_for_head(
                addr,
                &format!(
                    "OPTIONS /api/global-settings HTTP/1.1\r\nHost: {host}\r\nOrigin: {origin}\r\n\
                     Access-Control-Request-Method: POST\r\nConnection: close\r\n\r\n"
                ),
            );
            let cors_allows = head
                .to_ascii_lowercase()
                .contains("access-control-allow-origin");
            let (status, _) = send(addr, &upgrade_request("/api/presence", host, origin));
            assert_eq!(
                cors_allows,
                status == 200,
                "CORS and WebSocket disagree on {origin}"
            );
            if origin == "http://8.8.8.8" {
                assert!(!cors_allows, "{origin} should be refused");
            }
        }
    }

    fn get(addr: SocketAddr, host: &str) -> (u16, String) {
        send(
            addr,
            &format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        )
    }

    const REFUSED_HOST_TEXT: &str = "Access denied: connect using this PC's IP address, its \
        name, or name.local. To allow other addresses, turn on 'Allow devices outside the local \
        network' in Settings on the host.";

    #[test]
    fn refused_host_gets_403_with_guidance() {
        let (_runtime, addr) = serve_guarded(test_flag(false));
        assert_eq!(get(addr, "DESKTOP-ABC:8765"), (200, "ok".to_string()));
        assert_eq!(
            get(addr, "evil.example:8765"),
            (403, REFUSED_HOST_TEXT.to_string())
        );
    }

    #[test]
    fn foreign_origin_websocket_upgrade_is_refused_on_every_socket_route() {
        let (_runtime, addr) = serve_guarded(test_flag(false));
        for path in ["/api/observations/ws", "/api/presence"] {
            let upgrade = |origin: &str| {
                format!(
                    "GET {path} HTTP/1.1\r\nHost: 192.168.1.5:8765\r\nUpgrade: websocket\r\n\
                     Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                     Sec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n"
                )
            };
            let (status, _) = send(addr, &upgrade("http://evil.example"));
            assert_eq!(status, 403, "foreign-Origin upgrade to {path}");
            let (status, _) = send(addr, &upgrade("http://192.168.1.5:8765"));
            assert_eq!(
                status, 200,
                "local-Origin upgrade to {path} reaches the route"
            );
        }
    }

    #[test]
    fn preflight_from_refused_host_gets_403_not_a_cors_answer() {
        let (_runtime, addr) = serve_guarded(test_flag(false));
        let (status, _) = send(
            addr,
            "OPTIONS /api/global-settings HTTP/1.1\r\nHost: evil.example\r\n\
             Origin: http://192.168.1.5:8765\r\nAccess-Control-Request-Method: POST\r\n\
             Connection: close\r\n\r\n",
        );
        assert_eq!(status, 403);
    }

    #[test]
    fn allow_non_local_clients_applies_to_the_next_request() {
        let settings_dir = TempDir::new("allow-non-local");
        let settings_file = settings_dir.0.join("global-settings.json");
        let flag = test_flag(false);
        let (_runtime, addr) = serve_guarded(flag);
        assert_eq!(
            get(addr, "mypc.lan:8765").0,
            403,
            "off: a DNS name is refused"
        );

        let mut settings = GlobalSettings::default();
        settings.server.allow_non_local_clients = true;
        crate::settings::write_host_settings_file(&settings_file, settings.clone(), flag)
            .expect("host write");
        assert_eq!(
            get(addr, "mypc.lan:8765").0,
            200,
            "on: any host name is served"
        );

        settings.server.allow_non_local_clients = false;
        crate::settings::write_host_settings_file(&settings_file, settings, flag)
            .expect("host write");
        assert_eq!(get(addr, "mypc.lan:8765").0, 403, "off again: refused");
    }

    /// A fresh, empty folder under the system temp folder, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("tc3d-server-{}-{}", name, std::process::id()));
            if dir.exists() {
                fs::remove_dir_all(&dir).expect("clear stale temp dir");
            }
            fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        /// The folder's canonical path, as the server state holds the dist folder.
        fn canonical(&self) -> PathBuf {
            self.0.canonicalize().expect("canonicalise temp dir")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            if let Err(e) = fs::remove_dir_all(&self.0) {
                eprintln!("failed to remove temp dir {:?}: {}", self.0, e);
            }
        }
    }

    /// Asserts `resolved` was accepted and names a path under `root`, canonically when it exists.
    fn assert_inside(resolved: Result<PathBuf, ResolveError>, root: &std::path::Path) {
        let resolved = resolved.expect("path should be accepted");
        let inside = match resolved.canonicalize() {
            Ok(canonical) => canonical.starts_with(root.canonicalize().expect("canonicalise root")),
            Err(_) => resolved.starts_with(root),
        };
        assert!(inside, "{:?} is not inside {:?}", resolved, root);
    }

    /// Asserts `resolved` was refused as outside its root, naming `input` on failure.
    fn assert_refused(resolved: Result<PathBuf, ResolveError>, input: &str) {
        assert!(
            matches!(resolved, Err(ResolveError::Outside)),
            "{:?} should be refused, got {:?}",
            input,
            resolved
        );
    }

    #[test]
    fn static_path_refuses_absolute_drive_path() {
        let dist = TempDir::new("static-abs");
        for bad in [
            "/C:/Users/x/global-settings.json",
            "C:/Users/x/global-settings.json",
        ] {
            assert_refused(resolve_static_path(&dist.canonical(), bad), bad);
        }
    }

    #[test]
    fn static_path_refuses_parent_segments() {
        let dist = TempDir::new("static-parent");
        for bad in ["/../x", "../x", "..\\x", "assets/../../x"] {
            assert_refused(resolve_static_path(&dist.canonical(), bad), bad);
        }
    }

    #[test]
    fn static_path_refuses_unc_and_drive_relative_paths() {
        let dist = TempDir::new("static-unc");
        for bad in ["/\\\\server\\share\\x", "\\\\server\\share\\x", "C:x"] {
            assert_refused(resolve_static_path(&dist.canonical(), bad), bad);
        }
    }

    #[test]
    fn static_path_keeps_existing_asset_inside_dist() {
        let dist = TempDir::new("static-asset");
        fs::create_dir_all(dist.0.join("assets")).unwrap();
        fs::write(dist.0.join("assets").join("app.js"), "x").unwrap();
        let resolved = resolve_static_path(&dist.canonical(), "/assets/app.js");
        assert!(resolved.as_ref().is_ok_and(|p| p.is_file()));
        assert_inside(resolved, &dist.canonical());
    }

    #[test]
    fn static_path_ignores_empty_segments() {
        let dist = TempDir::new("static-empty");
        fs::create_dir_all(dist.0.join("assets")).unwrap();
        fs::write(dist.0.join("assets").join("x.js"), "x").unwrap();

        // A trailing slash names the SPA route, which the handler answers with index.html.
        let route = resolve_static_path(&dist.canonical(), "/foo/").expect("route accepted");
        assert!(route.ends_with("foo"), "{:?}", route);

        let asset =
            resolve_static_path(&dist.canonical(), "/assets//x.js").expect("asset accepted");
        assert!(asset.is_file(), "{:?}", asset);
        assert_inside(Ok(asset), &dist.canonical());
    }

    #[test]
    fn static_path_refuses_names_windows_cannot_hold() {
        let dist = TempDir::new("static-invalid");
        for bad in ["/a*b", "/a|b", "/a?b", "/a<b", "/a>b", "/a\"b", "/a\u{1}b"] {
            assert_refused(resolve_static_path(&dist.canonical(), bad), bad);
        }
    }

    #[test]
    fn static_path_through_existing_file_is_not_an_io_error() {
        let dist = TempDir::new("static-through-file");
        fs::write(dist.0.join("index.html"), "x").unwrap();
        // The handler answers a missing path without an extension with the SPA index.
        let resolved = resolve_static_path(&dist.canonical(), "/index.html/x")
            .expect("path under a file is accepted as missing");
        assert!(!resolved.exists(), "{:?}", resolved);
    }

    #[test]
    fn mod_file_path_refuses_invalid_names_and_paths_through_files() {
        let mods = TempDir::new("mods-invalid");
        fs::create_dir_all(mods.0.join("towers").join("KSFO")).unwrap();
        fs::write(mods.0.join("towers").join("KSFO").join("model.glb"), "x").unwrap();

        for bad in ["towers/x*y", "towers/x|y", "towers/x?y"] {
            let refused = mod_file_path(&mods.0, bad).expect_err("refused");
            assert_eq!(refused.0, StatusCode::FORBIDDEN, "{:?}: {:?}", bad, refused);
        }
        let through_file = mod_file_path(&mods.0, "towers/KSFO/model.glb/x").expect_err("missing");
        assert_eq!(through_file.0, StatusCode::NOT_FOUND, "{:?}", through_file);
    }

    #[test]
    fn static_path_maps_root_to_index() {
        let dist = TempDir::new("static-root");
        let resolved = resolve_static_path(&dist.canonical(), "/").expect("root accepted");
        assert!(resolved.ends_with("index.html"));
    }

    #[test]
    fn static_path_keeps_percent_encoding_literal() {
        // The fallback handler reads the raw URI path, which is never percent-decoded,
        // so `%2e%2e` is a literal folder name inside dist.
        let dist = TempDir::new("static-pct");
        assert_inside(
            resolve_static_path(&dist.canonical(), "/%2e%2e/x"),
            &dist.canonical(),
        );
    }

    #[test]
    fn diagnostic_filename_refuses_paths() {
        let dir = TempDir::new("diag-refuse");
        for bad in ["../x", "C:/x", "C:x", "a/b", "a\\b", "/x", ""] {
            assert_refused(diagnostic_file_path(&dir.0, bad), bad);
        }
    }

    #[test]
    fn diagnostic_filename_refuses_names_the_client_never_builds() {
        let dir = TempDir::new("diag-form");
        for bad in [
            "COM1",
            "AUX.json",
            "nul",
            "x.json.",
            "x.json ",
            "report.txt",
            "tc3d-diag-COM1.json",
            "tc3d-diag-.tc3d-diag.json",
            "tc3d-diag-a b.tc3d-diag.json",
            "tc3d-diag-KSFO.tc3d-diag.json.",
            "tc3d-diag-KSFO.tc3d-diag.json ",
        ] {
            assert_refused(diagnostic_file_path(&dir.0, bad), bad);
        }
    }

    #[test]
    fn diagnostic_filename_accepts_client_name() {
        let dir = TempDir::new("diag-accept");
        for good in [
            "tc3d-diag-KSFO-2026-10-21-1430.tc3d-diag.json",
            "tc3d-diag-unknown-2026-10-21-0905.tc3d-diag.json",
        ] {
            assert_eq!(
                diagnostic_file_path(&dir.0, good).expect("client name accepted"),
                dir.0.join(good)
            );
        }
    }

    #[test]
    fn tower_position_refuses_non_icao() {
        let dir = TempDir::new("tower-refuse");
        let refused = [
            "../KSFO",
            "..%2FKSFO",
            "KS/FO",
            "KSFOX",
            "KS",
            "",
            "..",
            "E/K",
            "_..",
            "E\\K",
            "EK.2",
        ];
        for bad in refused {
            assert_refused(tower_position_file_path(&dir.0, bad), bad);
        }
    }

    #[test]
    fn tower_position_accepts_icao() {
        let dir = TempDir::new("tower-accept");
        assert_eq!(
            tower_position_file_path(&dir.0, "ksfo").expect("ICAO accepted"),
            dir.0.join("KSFO.json")
        );
        assert_eq!(
            tower_position_file_path(&dir.0, "0S9").expect("ICAO accepted"),
            dir.0.join("0S9.json")
        );
        for underscored in ["EK_2", "EK_4"] {
            assert_eq!(
                tower_position_file_path(&dir.0, underscored).expect("code with '_' accepted"),
                dir.0.join(format!("{}.json", underscored))
            );
        }
    }

    #[test]
    fn msfs_path_stays_in_cache() {
        // axum's `Path` extractor percent-decodes, so `%2e%2e/%2e%2e/x` arrives as `../../x`.
        let cache = TempDir::new("msfs");
        for bad in ["../../x", "/../../x", "C:/Windows/win.ini"] {
            assert_refused(resolve_within(&cache.0, bad), bad);
        }
        assert_inside(resolve_within(&cache.0, "fsltl/model.glb"), &cache.0);
    }

    #[test]
    fn mod_file_path_refuses_parent_segments() {
        let mods = TempDir::new("mods-parent");
        let refused = mod_file_path(&mods.0, "towers/../../x.json").expect_err("refused");
        assert_eq!(refused.0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn mod_file_path_serves_plain_file() {
        let mods = TempDir::new("mods-file");
        fs::create_dir_all(mods.0.join("towers").join("KSFO")).unwrap();
        fs::write(mods.0.join("towers").join("KSFO").join("model.glb"), "x").unwrap();
        let served = mod_file_path(&mods.0, "towers/KSFO/model.glb").expect("file served");
        assert!(served.is_file(), "{:?}", served);

        let missing = mod_file_path(&mods.0, "towers/KSFO/none.glb").expect_err("missing");
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn resolve_error_tells_outside_from_io() {
        let root = TempDir::new("resolve-error");
        assert_refused(resolve_within(&root.0, "../x"), "../x");

        // A NUL in the root cannot be handed to the OS, so checking it is an I/O error on every platform.
        let unreadable_root = root.0.join("bad\0root");
        let io = resolve_within(&unreadable_root, "x.json");
        assert!(matches!(io, Err(ResolveError::Io(_))), "got {:?}", io);

        let outside = (StatusCode::FORBIDDEN, "Access denied".to_string());
        assert_eq!(
            ResolveError::Outside
                .into_response(outside.clone(), "test")
                .0,
            StatusCode::FORBIDDEN
        );
        let io_error = ResolveError::Io(std::io::Error::other("disk gone"));
        assert_eq!(
            io_error.into_response(outside, "test").0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn resolve_within_accepts_path_under_missing_root() {
        let parent = TempDir::new("missing-root");
        let root = parent.0.join("not-yet");
        assert_eq!(
            resolve_within(&root, "a/b.json").expect("plain path accepted"),
            root.join("a").join("b.json")
        );
        assert_refused(resolve_within(&root, "../b.json"), "../b.json");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_within_refuses_missing_target_through_junction() {
        let root = TempDir::new("junction-root");
        let outside = TempDir::new("junction-outside");
        let link = root.0.join("link");
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&outside.0)
            .status()
            .expect("run mklink");
        assert!(status.success(), "mklink /J failed: {}", status);

        for bad in ["link/new.json", "link/sub/new.json", "link"] {
            assert_refused(resolve_within(&root.0, bad), bad);
        }
        assert_inside(resolve_within(&root.0, "new.json"), &root.0);
    }

    #[cfg(windows)]
    #[test]
    fn resolve_within_refuses_dangling_junction() {
        let root = TempDir::new("dangling-root");
        let outside = TempDir::new("dangling-outside");
        let target = outside.0.join("gone");
        fs::create_dir(&target).expect("create junction target");
        let link = root.0.join("link");
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(&link)
            .arg(&target)
            .status()
            .expect("run mklink");
        assert!(status.success(), "mklink /J failed: {}", status);
        fs::remove_dir(&target).expect("delete junction target");

        for bad in ["link/new.json", "link/sub/new.json", "link"] {
            assert_refused(resolve_within(&root.0, bad), bad);
        }
    }

    #[test]
    fn resolve_within_refuses_odd_components() {
        let root = TempDir::new("odd");
        for bad in ["", "/", "./x", "a//b", "a/./b", "a\0b", "file.txt:stream"] {
            assert_refused(resolve_within(&root.0, bad), bad);
        }
    }

    fn observation(height_above_ground: Option<f64>) -> ObservationData {
        ObservationData {
            callsign: "DAL123".to_string(),
            latitude: 37.72,
            longitude: -122.22,
            altitude: 10.0,
            heading: 90.0,
            groundspeed: 140.0,
            ground_track: 90.0,
            vertical_rate: 0.0,
            on_ground: false,
            height_above_ground,
            pitch: None,
            roll: None,
            source: "vnas".to_string(),
            observed_at: 1,
            received_at: 2,
            type_code: None,
            origin: None,
            destination: None,
            flight_rules: None,
        }
    }

    #[test]
    fn observation_height_above_ground_is_camel_case_when_present() {
        let json = serde_json::to_value(observation(Some(1.25))).unwrap();
        assert_eq!(json["heightAboveGround"], serde_json::json!(1.25));
    }

    #[test]
    fn observation_without_height_above_ground_omits_the_key() {
        let json = serde_json::to_value(observation(None)).unwrap();
        assert!(json.get("heightAboveGround").is_none(), "{json}");
        assert!(json.get("height_above_ground").is_none(), "{json}");
    }

    #[test]
    fn observation_from_a_payload_without_height_above_ground_has_none() {
        let mut json = serde_json::to_value(observation(Some(1.25))).unwrap();
        json.as_object_mut().unwrap().remove("heightAboveGround");
        let parsed: ObservationData = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.height_above_ground, None);
    }
}
