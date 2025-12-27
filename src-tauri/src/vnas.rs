//! vNAS integration for real-time aircraft position updates.
//!
//! This module provides Tauri commands for connecting to the vNAS
//! system and receiving 1Hz aircraft updates to supplement the
//! 15-second VATSIM HTTP polling.
//!
//! ## Feature Flag
//! The vNAS integration requires the `vnas` feature to be enabled.
//! Without it, stub implementations return "vNAS not available" errors.
//! This allows the public repo to build without access to the private
//! towercab-3d-vnas crate.
//!
//! ## Note: OAuth Testing
//! The OAuth flow uses auth.vfsp.net and requires credentials from
//! the VATSIM tech team. Until those are available, authentication
//! will fail at the token exchange step.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

// =============================================================================
// FRONTEND TYPES (JSON-serializable for Tauri commands)
// These types are always available regardless of the vnas feature
// =============================================================================

/// vNAS environment for frontend
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Live,
    Sweatbox1,
    Sweatbox2,
}

/// Session state for frontend
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
    /// vNAS feature not compiled in
    Unavailable,
}

/// Aircraft position from vNAS (simplified for frontend)
/// Note: Only used when `vnas` feature is enabled, but kept public for API consistency
#[allow(dead_code)]
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
    /// Whether vNAS feature is compiled in
    pub available: bool,
}

impl Default for VnasStatus {
    fn default() -> Self {
        Self {
            #[cfg(feature = "vnas")]
            state: SessionState::Disconnected,
            #[cfg(not(feature = "vnas"))]
            state: SessionState::Unavailable,
            environment: Environment::Live,
            facility_id: None,
            #[cfg(feature = "vnas")]
            error: None,
            #[cfg(not(feature = "vnas"))]
            error: Some("vNAS feature not enabled - using VATSIM HTTP polling".to_string()),
            #[cfg(feature = "vnas")]
            available: true,
            #[cfg(not(feature = "vnas"))]
            available: false,
        }
    }
}

// =============================================================================
// REAL IMPLEMENTATION (when vnas feature is enabled)
// =============================================================================

#[cfg(feature = "vnas")]
mod real_impl {
    use super::*;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Emitter;
    use tokio::sync::{broadcast, RwLock as TokioRwLock};

    // Import types from the vNAS crate
    use towercab_3d_vnas::{
        Environment as VnasEnvironment, SessionState as VnasSessionState, TowerCabAircraftDto,
        VnasConfig, VnasEvent, VnasService,
    };

    impl From<Environment> for VnasEnvironment {
        fn from(env: Environment) -> Self {
            match env {
                Environment::Live => VnasEnvironment::Live,
                Environment::Sweatbox1 => VnasEnvironment::Sweatbox1,
                Environment::Sweatbox2 => VnasEnvironment::Sweatbox2,
            }
        }
    }

    impl From<VnasSessionState> for SessionState {
        fn from(state: VnasSessionState) -> Self {
            match state {
                VnasSessionState::Disconnected => SessionState::Disconnected,
                VnasSessionState::Authenticating => SessionState::Authenticating,
                VnasSessionState::Connecting => SessionState::Connecting,
                VnasSessionState::JoiningSession => SessionState::JoiningSession,
                VnasSessionState::Subscribing => SessionState::Subscribing,
                VnasSessionState::Connected => SessionState::Connected,
            }
        }
    }

    impl From<&TowerCabAircraftDto> for VnasAircraft {
        fn from(dto: &TowerCabAircraftDto) -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            Self {
                callsign: dto.aircraft_id.clone(),
                type_code: dto.type_code.clone(),
                is_heavy: dto.is_heavy,
                lat: dto.location.lat,
                lon: dto.location.lon,
                true_heading: dto.true_heading,
                true_ground_track: dto.true_ground_track,
                altitude_true: dto.altitude_true,
                altitude_agl: dto.altitude_agl,
                voice_type: dto.voice_type as u8,
                timestamp,
            }
        }
    }

    /// vNAS state managed by Tauri (real implementation)
    pub struct VnasState {
        status: RwLock<VnasStatus>,
        /// The vNAS service instance (uses tokio RwLock for async access)
        service: TokioRwLock<Option<VnasService>>,
        /// Channel for broadcasting aircraft updates to frontend/WebSocket
        event_tx: broadcast::Sender<VnasAircraft>,
        /// App handle for emitting events
        app_handle: RwLock<Option<AppHandle>>,
    }

    impl VnasState {
        pub fn new() -> Self {
            let (event_tx, _) = broadcast::channel(1024);
            Self {
                status: RwLock::new(VnasStatus::default()),
                service: TokioRwLock::new(None),
                event_tx,
                app_handle: RwLock::new(None),
            }
        }

        pub fn status(&self) -> VnasStatus {
            self.status.read().clone()
        }

        pub fn set_status(&self, status: VnasStatus) {
            *self.status.write() = status;
        }

        pub fn update_state(&self, state: SessionState) {
            self.status.write().state = state;
        }

        pub fn set_error(&self, error: Option<String>) {
            self.status.write().error = error;
        }

        pub fn set_facility(&self, facility_id: Option<String>) {
            self.status.write().facility_id = facility_id;
        }
    }

    impl Default for VnasState {
        fn default() -> Self {
            Self::new()
        }
    }

    // =========================================================================
    // TAURI COMMANDS (real implementation)
    // =========================================================================

    /// Get the current vNAS connection status
    #[tauri::command]
    pub fn vnas_get_status(state: State<'_, VnasState>) -> VnasStatus {
        state.status()
    }

    /// Check if vNAS feature is available
    #[tauri::command]
    pub fn vnas_is_available() -> bool {
        true
    }

    /// Start the vNAS OAuth authentication flow.
    /// Returns the URL to open in the user's browser.
    #[tauri::command]
    pub async fn vnas_start_auth(
        app: AppHandle,
        state: State<'_, VnasState>,
        environment: Environment,
    ) -> Result<String, String> {
        // Update status
        let mut status = state.status();
        status.state = SessionState::Authenticating;
        status.environment = environment;
        status.error = None;
        state.set_status(status);

        // Store app handle for later event emission
        *state.app_handle.write() = Some(app.clone());

        // Create VnasService with the selected environment
        let config = VnasConfig::new(environment.into());
        let service = VnasService::new(config);

        // Start OAuth flow
        let auth_url = service.start_oauth().await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            e.to_string()
        })?;

        // Store service for later use
        *state.service.write().await = Some(service);

        println!(
            "[vNAS] OAuth flow started for {:?} environment",
            environment
        );
        println!("[vNAS] Auth URL: {}", auth_url);

        Ok(auth_url)
    }

    /// Complete the OAuth flow after browser callback.
    /// This waits for the SSE callback from auth.vfsp.net.
    #[tauri::command]
    pub async fn vnas_complete_auth(state: State<'_, VnasState>) -> Result<(), String> {
        // Get service reference
        let service_guard = state.service.read().await;
        let service = service_guard
            .as_ref()
            .ok_or("OAuth not started - call vnas_start_auth first")?;

        // Wait for OAuth callback (this blocks until user completes browser auth)
        println!("[vNAS] Waiting for OAuth callback from browser...");

        service.complete_oauth().await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            format!("OAuth failed: {}", e)
        })?;

        println!("[vNAS] OAuth completed successfully");
        state.update_state(SessionState::Connecting);

        Ok(())
    }

    /// Connect to vNAS after successful authentication.
    /// This establishes the SignalR WebSocket connection.
    #[tauri::command]
    pub async fn vnas_connect(state: State<'_, VnasState>) -> Result<(), String> {
        // Check if authenticated
        let service_guard = state.service.read().await;
        let service = service_guard
            .as_ref()
            .ok_or("Not authenticated - complete OAuth first")?;

        if !service.is_authenticated().await {
            return Err("Not authenticated - complete OAuth first".into());
        }

        state.update_state(SessionState::Connecting);

        // Connect to SignalR hub
        service.connect().await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            format!("Connection failed: {}", e)
        })?;

        println!("[vNAS] Connected to SignalR hub");
        state.update_state(SessionState::JoiningSession);

        // Start listening for events
        let event_tx = state.event_tx.clone();
        let status_lock = Arc::new(RwLock::new(state.status()));
        let app_handle = state.app_handle.read().clone();

        let mut events = service.events();
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                match event {
                    VnasEvent::AircraftUpdate(aircraft_list) => {
                        // Batch aircraft for WebSocket broadcast to remote browsers
                        let mut ws_batch = Vec::with_capacity(aircraft_list.len());

                        for dto in aircraft_list {
                            let aircraft = VnasAircraft::from(&dto);
                            let _ = event_tx.send(aircraft.clone());

                            // Emit to frontend via Tauri event
                            if let Some(ref app) = app_handle {
                                let _ = app.emit("vnas-aircraft-update", &aircraft);
                            }

                            // Add to WebSocket batch
                            ws_batch.push(crate::server::VnasAircraftBroadcast {
                                callsign: aircraft.callsign,
                                lat: aircraft.lat,
                                lon: aircraft.lon,
                                altitude: aircraft.altitude_true,
                                heading: aircraft.true_heading,
                                type_code: Some(aircraft.type_code),
                                timestamp: aircraft.timestamp,
                            });
                        }

                        // Broadcast to WebSocket clients (remote browsers)
                        crate::broadcast_vnas_to_websocket(ws_batch);
                    }
                    VnasEvent::AircraftDisconnected(callsign) => {
                        println!("[vNAS] Aircraft disconnected: {}", callsign);
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("vnas-aircraft-disconnected", &callsign);
                        }
                    }
                    VnasEvent::SessionStateChanged(new_state) => {
                        let frontend_state: SessionState = new_state.into();
                        status_lock.write().state = frontend_state;
                        println!("[vNAS] Session state changed: {:?}", frontend_state);
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("vnas-state-changed", &frontend_state);
                        }
                    }
                    VnasEvent::Error(error) => {
                        println!("[vNAS] Error: {}", error);
                        status_lock.write().error = Some(error.to_string());
                        if let Some(ref app) = app_handle {
                            let _ = app.emit("vnas-error", error.to_string());
                        }
                    }
                }
            }
        });

        Ok(())
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
        let service_guard = state.service.read().await;
        let service = service_guard
            .as_ref()
            .ok_or("Not connected - call vnas_connect first")?;

        state.update_state(SessionState::Subscribing);

        // Subscribe to TowerCabAircraft topic
        service
            .subscribe_towercab(&facility_id)
            .await
            .map_err(|e| {
                state.set_error(Some(e.to_string()));
                format!("Subscription failed: {}", e)
            })?;

        state.set_facility(Some(facility_id.clone()));
        state.update_state(SessionState::Connected);

        println!("[vNAS] Subscribed to TowerCabAircraft for {}", facility_id);

        Ok(())
    }

    /// Disconnect from vNAS.
    #[tauri::command]
    pub async fn vnas_disconnect(state: State<'_, VnasState>) -> Result<(), String> {
        // Disconnect service if connected
        if let Some(service) = state.service.write().await.take() {
            service.disconnect().await.map_err(|e| e.to_string())?;
        }

        // Reset status
        let mut status = state.status();
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
        matches!(
            state.status().state,
            SessionState::Connecting
                | SessionState::JoiningSession
                | SessionState::Subscribing
                | SessionState::Connected
        )
    }

    /// Initialize vNAS state for Tauri app.
    /// Call this in the Tauri setup closure.
    pub fn init_vnas_state(app: &AppHandle) {
        app.manage(VnasState::new());
        println!("[vNAS] State initialized (real implementation)");
    }
}

// =============================================================================
// STUB IMPLEMENTATION (when vnas feature is disabled)
// =============================================================================

#[cfg(not(feature = "vnas"))]
mod stub_impl {
    use super::*;

    /// Stub vNAS state managed by Tauri
    pub struct VnasState {
        status: RwLock<VnasStatus>,
    }

    impl VnasState {
        pub fn new() -> Self {
            Self {
                status: RwLock::new(VnasStatus::default()),
            }
        }

        pub fn status(&self) -> VnasStatus {
            self.status.read().clone()
        }
    }

    impl Default for VnasState {
        fn default() -> Self {
            Self::new()
        }
    }

    const UNAVAILABLE_MSG: &str =
        "vNAS feature not enabled. Build with --features vnas for real-time updates.";

    /// Get the current vNAS connection status
    #[tauri::command]
    pub fn vnas_get_status(state: State<'_, VnasState>) -> VnasStatus {
        state.status()
    }

    /// Check if vNAS feature is available
    #[tauri::command]
    pub fn vnas_is_available() -> bool {
        false
    }

    /// Start the vNAS OAuth authentication flow (stub)
    #[tauri::command]
    pub async fn vnas_start_auth(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _environment: Environment,
    ) -> Result<String, String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Complete the OAuth flow (stub)
    #[tauri::command]
    pub async fn vnas_complete_auth(_state: State<'_, VnasState>) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Connect to vNAS (stub)
    #[tauri::command]
    pub async fn vnas_connect(_state: State<'_, VnasState>) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Subscribe to updates (stub)
    #[tauri::command]
    pub async fn vnas_subscribe(
        _state: State<'_, VnasState>,
        _facility_id: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Disconnect from vNAS (stub)
    #[tauri::command]
    pub async fn vnas_disconnect(_state: State<'_, VnasState>) -> Result<(), String> {
        Ok(()) // No-op, always succeeds
    }

    /// Check if vNAS is currently connected (stub)
    #[tauri::command]
    pub fn vnas_is_connected(_state: State<'_, VnasState>) -> bool {
        false
    }

    /// Check if vNAS is authenticated (stub)
    #[tauri::command]
    pub fn vnas_is_authenticated(_state: State<'_, VnasState>) -> bool {
        false
    }

    /// Initialize vNAS state for Tauri app (stub)
    pub fn init_vnas_state(app: &AppHandle) {
        app.manage(VnasState::new());
        println!("[vNAS] State initialized (stub - feature not enabled)");
    }
}

// =============================================================================
// RE-EXPORTS (use the appropriate implementation based on feature)
// =============================================================================

#[cfg(feature = "vnas")]
pub use real_impl::*;

#[cfg(not(feature = "vnas"))]
pub use stub_impl::*;
