//! vNAS integration for real-time aircraft position updates.
//!
//! This module provides Tauri commands for connecting to the vNAS
//! system and receiving 1Hz aircraft updates to supplement the
//! 15-second VATSIM HTTP polling.
//!
//! ## TODO: OAuth Testing
//! The OAuth flow uses auth.vfsp.net and requires credentials from
//! the VATSIM tech team. Until those are available, authentication
//! will fail. See towercab-3d-vnas/todo.md for details.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::broadcast;

// Re-export types for use in Tauri commands
// TODO: Uncomment when towercab-3d-vnas dependency is added
// use towercab_3d_vnas::{
//     Environment, SessionState, TowerCabAircraftDto, VnasConfig, VnasError, VnasEvent,
//     VnasService,
// };

// =============================================================================
// PLACEHOLDER TYPES (until towercab-3d-vnas is wired up)
// =============================================================================

/// vNAS environment (matches towercab_3d_vnas::Environment)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Live,
    Sweatbox1,
    Sweatbox2,
}

/// Session state (matches towercab_3d_vnas::SessionState)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    #[default]
    Disconnected,
    Authenticating,
    Connecting,
    JoiningSession,
    Subscribing,
    Connected,
}

/// Aircraft position from vNAS (simplified for frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VnasAircraft {
    pub callsign: String,
    pub type_code: String,
    pub is_heavy: bool,
    pub lat: f64,
    pub lon: f64,
    pub true_heading: f64,
    pub true_ground_track: Option<f64>,
    pub altitude_true: f64,
    pub altitude_agl: f64,
    pub voice_type: u8, // 0=Unknown, 1=Full, 2=ReceiveOnly, 3=TextOnly
    pub timestamp: u64, // Unix timestamp ms
}

/// vNAS connection status for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VnasStatus {
    pub state: SessionState,
    pub environment: Environment,
    pub facility_id: Option<String>,
    pub error: Option<String>,
}

impl Default for VnasStatus {
    fn default() -> Self {
        Self {
            state: SessionState::Disconnected,
            environment: Environment::Live,
            facility_id: None,
            error: None,
        }
    }
}

// =============================================================================
// TAURI STATE
// =============================================================================

/// vNAS state managed by Tauri
pub struct VnasState {
    status: RwLock<VnasStatus>,
    /// Channel for broadcasting aircraft updates to frontend
    event_tx: broadcast::Sender<VnasAircraft>,
    // TODO: Add VnasService when wiring up real implementation
    // service: RwLock<Option<VnasService>>,
}

impl VnasState {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            status: RwLock::new(VnasStatus::default()),
            event_tx,
        }
    }

    pub fn status(&self) -> VnasStatus {
        self.status.read().clone()
    }

    pub fn set_status(&self, status: VnasStatus) {
        *self.status.write() = status;
    }

    pub fn subscribe(&self) -> broadcast::Receiver<VnasAircraft> {
        self.event_tx.subscribe()
    }
}

impl Default for VnasState {
    fn default() -> Self {
        Self::new()
    }
}

// =============================================================================
// TAURI COMMANDS
// =============================================================================

/// Get the current vNAS connection status
#[tauri::command]
pub fn vnas_get_status(state: State<'_, VnasState>) -> VnasStatus {
    state.status()
}

/// Start the vNAS OAuth authentication flow.
/// Returns the URL to open in the user's browser.
///
/// ## TODO
/// This currently returns a placeholder URL. Real implementation requires:
/// 1. OAuth credentials from VATSIM tech team
/// 2. Testing the auth.vfsp.net SSE callback flow
#[tauri::command]
pub async fn vnas_start_auth(
    _app: AppHandle,
    state: State<'_, VnasState>,
    environment: Environment,
) -> Result<String, String> {
    // Update status to authenticating
    let mut status = state.status();
    status.state = SessionState::Authenticating;
    status.environment = environment;
    state.set_status(status);

    // TODO: Replace with real VnasService.start_oauth() call
    // For now, return a placeholder that explains the situation
    //
    // Real implementation:
    // let config = VnasConfig::new(environment.into());
    // let service = VnasService::new(config);
    // let auth_url = service.start_oauth().await.map_err(|e| e.to_string())?;

    let env_name = match environment {
        Environment::Live => "live",
        Environment::Sweatbox1 => "sweatbox1",
        Environment::Sweatbox2 => "sweatbox2",
    };

    // TODO: This is a placeholder URL - the real flow uses auth.vfsp.net
    let auth_url = format!(
        "https://auth.vfsp.net/login?state=placeholder&env={}",
        env_name
    );

    println!("[vNAS] OAuth flow started for {} environment", env_name);
    println!("[vNAS] TODO: Awaiting OAuth credentials from VATSIM tech team");

    Ok(auth_url)
}

/// Complete the OAuth flow after browser callback.
/// This is called after the user authenticates in their browser.
///
/// ## TODO
/// Currently fails with a placeholder error until OAuth is tested.
#[tauri::command]
pub async fn vnas_complete_auth(state: State<'_, VnasState>) -> Result<(), String> {
    // TODO: Replace with real VnasService.complete_oauth() call
    //
    // Real implementation:
    // let service = ... (get from state)
    // service.complete_oauth().await.map_err(|e| e.to_string())?;

    // For now, return an error explaining the situation
    let mut status = state.status();
    status.state = SessionState::Disconnected;
    status.error = Some("OAuth not yet implemented - awaiting VATSIM tech team credentials".into());
    state.set_status(status);

    Err("vNAS OAuth not yet available. See todo.md for details.".into())
}

/// Connect to vNAS after successful authentication.
/// This establishes the SignalR WebSocket connection.
#[tauri::command]
pub async fn vnas_connect(state: State<'_, VnasState>) -> Result<(), String> {
    let mut status = state.status();

    // Check if we're authenticated (placeholder check)
    if status.state != SessionState::Authenticating {
        return Err("Must authenticate before connecting".into());
    }

    status.state = SessionState::Connecting;
    state.set_status(status.clone());

    // TODO: Replace with real VnasService.connect() call
    //
    // Real implementation:
    // let service = ... (get from state)
    // service.connect().await.map_err(|e| e.to_string())?;

    status.state = SessionState::Disconnected;
    status.error = Some("Connection not yet implemented".into());
    state.set_status(status);

    Err("vNAS connection not yet implemented".into())
}

/// Subscribe to TowerCabAircraft updates for a facility.
///
/// # Arguments
/// * `facility_id` - ICAO code of the airport (e.g., "KBOS")
#[tauri::command]
pub async fn vnas_subscribe(
    state: State<'_, VnasState>,
    facility_id: String,
) -> Result<(), String> {
    let mut status = state.status();

    // Check if we're connected
    if status.state != SessionState::Connected && status.state != SessionState::JoiningSession {
        return Err("Must be connected before subscribing".into());
    }

    status.state = SessionState::Subscribing;
    state.set_status(status.clone());

    // TODO: Replace with real VnasService.subscribe_towercab() call
    //
    // Real implementation:
    // let service = ... (get from state)
    // service.subscribe_towercab(&facility_id).await.map_err(|e| e.to_string())?;

    status.state = SessionState::Disconnected;
    status.error = Some("Subscription not yet implemented".into());
    state.set_status(status);

    Err(format!(
        "vNAS subscription to {} not yet implemented",
        facility_id
    ))
}

/// Disconnect from vNAS.
#[tauri::command]
pub async fn vnas_disconnect(state: State<'_, VnasState>) -> Result<(), String> {
    let mut status = state.status();

    // TODO: Replace with real VnasService.disconnect() call
    //
    // Real implementation:
    // let service = ... (get from state)
    // service.disconnect().await.map_err(|e| e.to_string())?;

    status.state = SessionState::Disconnected;
    status.facility_id = None;
    status.error = None;
    state.set_status(status);

    println!("[vNAS] Disconnected");
    Ok(())
}

/// Check if vNAS is currently connected.
#[tauri::command]
pub fn vnas_is_connected(state: State<'_, VnasState>) -> bool {
    state.status().state == SessionState::Connected
}

/// Check if vNAS is authenticated.
#[tauri::command]
pub fn vnas_is_authenticated(state: State<'_, VnasState>) -> bool {
    // TODO: Check actual token state
    // For now, check if we're past authentication state
    matches!(
        state.status().state,
        SessionState::Connecting
            | SessionState::JoiningSession
            | SessionState::Subscribing
            | SessionState::Connected
    )
}

// =============================================================================
// STATE INITIALIZATION
// =============================================================================

/// Initialize vNAS state for Tauri app.
/// Call this in the Tauri setup closure.
pub fn init_vnas_state(app: &AppHandle) {
    app.manage(VnasState::new());
    println!("[vNAS] State initialized");
}
