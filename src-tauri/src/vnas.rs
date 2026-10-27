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
    Test,
    /// A local YAAT development server; signs in with a dev login, never OAuth
    #[serde(rename = "yaatlocal")]
    YaatLocal,
    /// The public YAAT training server; signs in through VATSIM like Live
    #[serde(rename = "yaat1")]
    Yaat1,
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
    /// TC3D connected before CRC - waiting for CRC to create session
    WaitingForSession,
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
    /// Currently subscribed facilities (supports multiple simultaneous subscriptions)
    pub subscribed_facilities: Vec<String>,
    pub error: Option<String>,
    /// Whether vNAS feature is compiled in
    pub available: bool,
    /// How the last joined session ended, when the server ended it. A non-forcible end
    /// (e.g. a YAAT room closing) is cleared when the next session is joined; a forcible
    /// one (a kick from the room) only at the next connect.
    pub last_session_end: Option<SessionEndInfo>,
    /// Where the joined session comes from, as its join reported it; `None` while no
    /// session is joined. `VnasState::status` fills it from the session cell, so a value
    /// written here through `update_status` is never reported.
    pub session_kind: Option<SessionKind>,
}

/// Where the joined session comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    /// A controller's CRC session, on vNAS or YAAT
    Crc,
    /// A YAAT room session, joined with no CRC session
    Room,
}

/// Why the server ended the joined session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndInfo {
    /// The server's reason, e.g. "Room closed" or "Removed from the room"
    pub reason: String,
    /// Whether the server forced the end (YAAT: a kick from the room), which disconnects
    pub forcible: bool,
}

/// Why a hub subscribe failed, as far as showing it to the user goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vNAS build subscribes
enum SubscribeFailure {
    /// The session the subscribe named is no longer the joined one; the next session's
    /// `Subscribing` subscribes again
    StaleSession,
    /// The service has no connection: torn down meanwhile (a kick, or a disconnect)
    NotConnected,
    /// Any other failure
    Failed,
}

/// What the host does about a failed hub subscribe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // only the vNAS build subscribes
enum SubscribeOutcome {
    /// The failure was written as the status error and is returned to the caller
    ShowError,
    /// The token was stale: forget it, so the next subscribe reads the joined session's
    ForgetToken,
    /// Not a failure worth showing; nothing changes
    Ignore,
}

/// Write a session state the service reported into `status`.
///
/// The hub drops a connection's subscriptions whenever its session changes, so
/// `Disconnected`, `WaitingForSession` and `Subscribing` (a new session) clear them; the
/// caller (`StatusCell::apply_session_state`) then drops its subscribes in flight, and
/// `apply_session_change_with_cell` ends the joined session too. Reaching `Subscribing` also clears the
/// error (a refused room join leaves one behind while waiting) and a non-forcible session
/// end. Returns whether the subscriptions were cleared.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
fn apply_session_change(status: &mut VnasStatus, new_state: SessionState) -> bool {
    status.state = new_state;
    let dropped = matches!(
        new_state,
        SessionState::Disconnected | SessionState::WaitingForSession | SessionState::Subscribing
    );
    if dropped {
        status.subscribed_facilities.clear();
    }
    if new_state == SessionState::Subscribing {
        status.error = None;
        if status
            .last_session_end
            .as_ref()
            .is_some_and(|end| !end.forcible)
        {
            status.last_session_end = None;
        }
    }
    dropped
}

/// One frontend event announcing a session state change.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's events, tested in both builds
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionChangeEvent {
    /// `vnas-state-changed` with the new state
    State(SessionState),
    /// `vnas-subscriptions-changed` with an empty list
    SubscriptionsCleared,
}

/// The events announcing `new_state`, in emit order; `dropped` says the change cleared the
/// subscriptions. The state goes first: the frontend drops the old session's airports and
/// holds its subscribes for the joined session's follow on the state, so the subscribe
/// effects the cleared list then re-runs find nothing of the old session to subscribe.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
fn session_change_events(new_state: SessionState, dropped: bool) -> Vec<SessionChangeEvent> {
    let mut events = vec![SessionChangeEvent::State(new_state)];
    if dropped {
        events.push(SessionChangeEvent::SubscriptionsCleared);
    }
    events
}

/// A host cache of what the joined session offers remote browsers.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's caches, tested in both builds
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionCache {
    /// The subscribed facilities
    Subscribed,
    /// The session's airports, the remote browsers' allowed subscribes
    SessionFacilities,
}

/// The caches a session change empties; `dropped` says the change cleared the
/// subscriptions. A dropping change ends the joined session, so its airports go with its
/// subscriptions.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
fn caches_cleared_by(dropped: bool) -> &'static [SessionCache] {
    if dropped {
        &[SessionCache::Subscribed, SessionCache::SessionFacilities]
    } else {
        &[]
    }
}

/// What the host knows of the joined session: the token naming it for subscribes (`T`),
/// its kind and its airports, and a generation that moves on every session change.
///
/// A value read before a session change is stored only if the generation it was read
/// under is still the current one, so nothing of an ended session outlives its change.
#[cfg(any(feature = "vnas", test))]
#[derive(Debug)]
struct SessionCell<T> {
    token: Option<T>,
    kind: Option<SessionKind>,
    airports: Vec<String>,
    generation: u64,
}

#[cfg(any(feature = "vnas", test))]
impl<T> Default for SessionCell<T> {
    fn default() -> Self {
        Self {
            token: None,
            kind: None,
            airports: Vec::new(),
            generation: 0,
        }
    }
}

#[cfg(any(feature = "vnas", test))]
impl<T: Copy + Eq> SessionCell<T> {
    /// The current generation; read it before reading what to store.
    fn generation(&self) -> u64 {
        self.generation
    }

    fn token(&self) -> Option<T> {
        self.token
    }

    fn kind(&self) -> Option<SessionKind> {
        self.kind
    }

    fn airports(&self) -> &[String] {
        &self.airports
    }

    /// Keep the joined session's token and kind, unless the generation moved since
    /// `generation` was read. Returns whether they were stored.
    fn store_joined(&mut self, generation: u64, token: T, kind: SessionKind) -> bool {
        if self.generation != generation {
            return false;
        }
        self.token = Some(token);
        self.kind = Some(kind);
        true
    }

    /// Keep the joined session's airports, unless the generation moved since
    /// `generation` was read. Returns whether they were stored.
    fn store_airports(&mut self, generation: u64, airports: Vec<String>) -> bool {
        if self.generation != generation {
            return false;
        }
        self.airports = airports;
        true
    }

    /// Whether `token` names the joined session this cell holds.
    fn holds(&self, token: T) -> bool {
        self.token == Some(token)
    }

    /// Keep `airports` as the joined session's, only while `token` names the joined
    /// session: airports read from a session that has since changed are not kept. Returns
    /// whether they were stored.
    fn store_airports_of(&mut self, token: T, airports: Vec<String>) -> bool {
        if !self.holds(token) {
            return false;
        }
        self.airports = airports;
        true
    }

    /// Keep `airports` as the joined session's, only while the generation is still
    /// `generation` and `token` names the joined session: the service's current session
    /// can be newer than the one the host has applied. Returns whether they were stored.
    fn store_airports_of_session(
        &mut self,
        generation: u64,
        token: T,
        airports: Vec<String>,
    ) -> bool {
        self.holds(token) && self.store_airports(generation, airports)
    }

    /// Forget the token, the kind and the airports.
    fn forget(&mut self) {
        self.token = None;
        self.kind = None;
        self.airports.clear();
    }

    /// Move the generation on: whatever was read before is not stored.
    fn bump(&mut self) {
        self.generation += 1;
    }

    /// End the joined session: forget it and move the generation on, so nothing read of
    /// it before is stored.
    fn end(&mut self) {
        self.forget();
        self.bump();
    }

    /// Join a new session: end the one stored, then keep the new session's token and kind
    /// under the generation that moved to. Returns that generation.
    fn join(&mut self, token: T, kind: SessionKind) -> u64 {
        self.end();
        self.store_joined(self.generation, token, kind);
        self.generation
    }
}

/// Write a session state the service reported into `status` (`apply_session_change`)
/// and, when the session changed, end the joined session in `session`. Returns whether
/// the session changed.
#[cfg(any(feature = "vnas", test))]
fn apply_session_change_with_cell<T: Copy + Eq>(
    status: &mut VnasStatus,
    session: &mut SessionCell<T>,
    new_state: SessionState,
) -> bool {
    let dropped = apply_session_change(status, new_state);
    if dropped {
        session.end();
    }
    dropped
}

/// The status reported to the frontend, plus the facilities whose hub subscribe is in
/// flight, the joined session (`T` is its token) and the connect epoch. One lock guards
/// them all, so checking and claiming a facility is one step, and so is checking the
/// connect epoch and writing under it.
#[cfg(any(feature = "vnas", test))]
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the claim counter is read only by the vNAS build
#[derive(Debug)]
struct StatusCell<T> {
    status: VnasStatus,
    /// Facility id → the token of the claim that owns its in-flight subscribe.
    pending_subscribes: std::collections::HashMap<String, u64>,
    /// The last claim token handed out; each claim takes the next one.
    last_claim_token: u64,
    /// The joined session's token for `subscribe_towercab` (never leaves the host), its
    /// kind (reported as the status's `session_kind`) and its airports.
    session: SessionCell<T>,
    /// Bumped by every connect's start (`begin_connect`) and every disconnect's reset; a
    /// writer holding an older value (a connect a newer one or a disconnect overtook, or
    /// its event forwarder) writes nothing.
    connect_epoch: u64,
}

#[cfg(any(feature = "vnas", test))]
impl<T> Default for StatusCell<T> {
    fn default() -> Self {
        Self {
            status: VnasStatus::default(),
            pending_subscribes: std::collections::HashMap::new(),
            last_claim_token: 0,
            session: SessionCell::default(),
            connect_epoch: 0,
        }
    }
}

#[cfg(any(feature = "vnas", test))]
impl<T: Copy + Eq> StatusCell<T> {
    /// Forget the joined session; anything read of it before this is not stored.
    fn forget_joined_session(&mut self) {
        self.session.end();
    }

    /// Apply a session state the service reported (`apply_session_change_with_cell`);
    /// when the session changed, also drop every subscribe in flight. Returns whether
    /// the session changed.
    fn apply_session_state(&mut self, new_state: SessionState) -> bool {
        let dropped =
            apply_session_change_with_cell(&mut self.status, &mut self.session, new_state);
        if dropped {
            self.pending_subscribes.clear();
        }
        dropped
    }

    /// Start a connect: refused (`None`) while a session is connecting or active,
    /// otherwise writes `Connecting` (`apply_connect_state`), bumps the connect epoch and
    /// returns it. Every later write of that connect and of its event forwarder goes
    /// through `if_epoch` with it, so a connect or a forwarder a newer connect or a
    /// disconnect overtook writes nothing.
    fn begin_connect(&mut self) -> Option<u64> {
        let active = matches!(
            self.status.state,
            SessionState::Connecting
                | SessionState::JoiningSession
                | SessionState::WaitingForSession
                | SessionState::Subscribing
                | SessionState::Connected
        );
        if active {
            return None;
        }
        apply_connect_state(&mut self.status, SessionState::Connecting, None);
        self.connect_epoch += 1;
        Some(self.connect_epoch)
    }

    /// Run `f` on the cell unless the connect epoch moved since `epoch` was read; returns
    /// what `f` returned, or `None` when it did not run.
    fn if_epoch<R>(&mut self, epoch: u64, f: impl FnOnce(&mut Self) -> R) -> Option<R> {
        (self.connect_epoch == epoch).then(|| f(self))
    }

    /// Reset the status after a disconnect: state `Disconnected`, no subscriptions or
    /// subscribes in flight, no error, no joined session. Bumps the connect epoch, so a
    /// connect's or a forwarder's write lands before this reset or not at all.
    fn reset_for_disconnect(&mut self) {
        self.connect_epoch += 1;
        self.status.state = SessionState::Disconnected;
        self.status.subscribed_facilities.clear();
        self.status.error = None;
        self.pending_subscribes.clear();
        self.forget_joined_session();
    }

    /// Apply a re-sync (`resync_action`) and return what it wrote, for the caller to
    /// cache and emit.
    fn apply_resync(&mut self, resync: Resync<T>) -> ResyncWrites {
        let mut writes = ResyncWrites::default();
        match resync.change {
            ResyncChange::Keep => {}
            ResyncChange::Advance(new_state) => {
                let dropped = self.apply_session_state(new_state);
                writes.record(new_state, dropped);
            }
            ResyncChange::Rejoin { state, session } => {
                apply_session_change(&mut self.status, state);
                self.status.subscribed_facilities.clear();
                self.pending_subscribes.clear();
                self.session.end();
                if let Some((token, kind)) = session {
                    let generation = self.session.generation();
                    self.session.store_joined(generation, token, kind);
                    writes.joined_generation = Some(generation);
                }
                writes.record(state, true);
            }
        }
        if let Some(reason) = resync.forced_end {
            writes.forced_error = self.restore_forced_end(reason);
        }
        writes
    }

    /// Record a forcible end with `reason` and show it as the status error, unless it is
    /// already the error shown. Returns the reason when it was newly shown.
    fn restore_forced_end(&mut self, reason: String) -> Option<String> {
        if self.status.error.as_deref() == Some(reason.as_str()) {
            return None;
        }
        self.status.last_session_end = Some(SessionEndInfo {
            reason: reason.clone(),
            forcible: true,
        });
        apply_forced_end_error(&mut self.status, Some(reason.clone())).then_some(reason)
    }
}

/// What a re-sync wrote: the state with the events announcing it, whether the session
/// changed, the generation a newly stored session was stored under, and a forcible end's
/// reason newly shown as the error.
#[cfg(any(feature = "vnas", test))]
#[derive(Debug, Default)]
struct ResyncWrites {
    new_state: Option<SessionState>,
    events: Vec<SessionChangeEvent>,
    dropped: bool,
    joined_generation: Option<u64>,
    forced_error: Option<String>,
}

#[cfg(any(feature = "vnas", test))]
impl ResyncWrites {
    fn record(&mut self, new_state: SessionState, dropped: bool) {
        self.new_state = Some(new_state);
        self.events = session_change_events(new_state, dropped);
        self.dropped = dropped;
    }
}

/// How a connect (`VnasService::connect`) ended, as far as the status goes.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS connect's rule, tested in both builds
#[derive(Debug, Clone, PartialEq, Eq)]
enum ConnectOutcome {
    /// The connect joined or is waiting for a session
    Connected,
    /// A teardown cancelled the connect
    Cancelled,
    /// The connect failed, with the error to show
    Failed(String),
}

/// What a connect's result writes into the status, if anything: the event forwarder
/// owns every state a connect that succeeded went through, and a cancelled connect's
/// teardown reports its own `Disconnected`, so only a failure writes (`Disconnected`
/// with its error).
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS connect's rule, tested in both builds
fn connect_result_write(outcome: ConnectOutcome) -> Option<(SessionState, Option<String>)> {
    match outcome {
        ConnectOutcome::Connected | ConnectOutcome::Cancelled => None,
        ConnectOutcome::Failed(error) => Some((SessionState::Disconnected, Some(error))),
    }
}

/// Pass every event from `events` to `handle` until the channel closes.
///
/// A receiver that falls more than the channel's capacity behind loses the oldest events.
/// The forwarder then applies every event it still holds, runs `resync` once, inline on
/// this task, so it reads the service's state after everything it applied and before
/// anything newer, and carries on.
#[cfg(any(feature = "vnas", test))]
async fn forward_events<E, F, R, Fut>(
    mut events: tokio::sync::broadcast::Receiver<E>,
    mut handle: F,
    mut resync: R,
) where
    E: Clone,
    F: FnMut(E),
    R: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    use tokio::sync::broadcast::error::{RecvError, TryRecvError};
    loop {
        match events.recv().await {
            Ok(event) => handle(event),
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("[vNAS] event forwarder lagged, skipped {n} events; re-syncing");
                loop {
                    match events.try_recv() {
                        Ok(event) => handle(event),
                        Err(TryRecvError::Lagged(n)) => {
                            tracing::warn!(
                                "[vNAS] event forwarder lagged again, skipped {n} events"
                            );
                        }
                        Err(TryRecvError::Empty | TryRecvError::Closed) => break,
                    }
                }
                resync().await;
            }
            Err(RecvError::Closed) => return,
        }
    }
}

/// What a re-sync after lost events changes in the host's session state.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResyncChange<T> {
    /// The host is up to date with the service's session
    Keep,
    /// Same session, further on: write the state
    Advance(SessionState),
    /// The session the host holds is gone: a dropping change to `state` (subscriptions,
    /// subscribes in flight and the joined session cleared), then `session`'s token and
    /// kind stored when the service has joined one
    Rejoin {
        state: SessionState,
        session: Option<(T, SessionKind)>,
    },
}

/// A re-sync after lost events: the session change, and the reason of a forcible end the
/// service still holds, to show unless the host already shows it.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
#[derive(Debug, Clone, PartialEq, Eq)]
struct Resync<T> {
    change: ResyncChange<T>,
    forced_end: Option<String>,
}

/// Bring the host up to date with the service after the forwarder lost events.
///
/// The token decides: a service session other than the host's, or none, is a dropping
/// change to the service's state, then the service's session is stored. The same session
/// never moves backwards: only `Connected` the host has not reached yet is written. The
/// service's forcible end reason (kept until its next connect) comes along to be shown.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
fn resync_action<T: Copy + Eq>(
    host_state: SessionState,
    host_token: Option<T>,
    service_state: SessionState,
    service_session: Option<(T, SessionKind)>,
    forced_reason: Option<String>,
) -> Resync<T> {
    let change = match service_session {
        Some((token, _)) if host_token == Some(token) => {
            let ahead =
                service_state == SessionState::Connected && host_state != SessionState::Connected;
            if ahead {
                ResyncChange::Advance(SessionState::Connected)
            } else {
                ResyncChange::Keep
            }
        }
        session => ResyncChange::Rejoin {
            state: service_state,
            session,
        },
    };
    Resync {
        change,
        forced_end: forced_reason,
    }
}

/// Write a state a connect publishes into `status`, with `error` when given. Starting a
/// connect (`Connecting`) clears the previous error and session end, a kick's included.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS connect's rule, tested in both builds
fn apply_connect_state(status: &mut VnasStatus, new_state: SessionState, error: Option<String>) {
    if new_state == SessionState::Connecting {
        status.error = None;
        status.last_session_end = None;
    }
    status.state = new_state;
    if error.is_some() {
        status.error = error;
    }
}

/// Show a forcible end's `reason` as the status error, unless a connect has started since
/// (it cleared the forcible session end). Returns whether the error was set.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS forwarder's rule, tested in both builds
fn apply_forced_end_error(status: &mut VnasStatus, reason: Option<String>) -> bool {
    let forced = status
        .last_session_end
        .as_ref()
        .is_some_and(|end| end.forcible);
    match reason {
        Some(reason) if forced => {
            status.error = Some(reason);
            true
        }
        _ => false,
    }
}

/// Settle a failed subscribe against `status`, writing `error` as the status error only
/// when it is shown.
///
/// A stale session is not a failure (the token is forgotten), and neither is a service
/// with no connection (a kick's reason must stay the shown error) or a subscribe the
/// host's own disconnect cut off; anything else is shown.
#[cfg_attr(not(feature = "vnas"), allow(dead_code))] // the vNAS subscribe's rule, tested in both builds
fn settle_subscribe_failure(
    status: &mut VnasStatus,
    failure: SubscribeFailure,
    disconnecting: bool,
    error: &str,
) -> SubscribeOutcome {
    match failure {
        SubscribeFailure::StaleSession => SubscribeOutcome::ForgetToken,
        SubscribeFailure::NotConnected => SubscribeOutcome::Ignore,
        _ if disconnecting => SubscribeOutcome::Ignore,
        SubscribeFailure::Failed => {
            status.error = Some(error.to_string());
            SubscribeOutcome::ShowError
        }
    }
}

impl Default for VnasStatus {
    fn default() -> Self {
        Self {
            #[cfg(feature = "vnas")]
            state: SessionState::Disconnected,
            #[cfg(not(feature = "vnas"))]
            state: SessionState::Unavailable,
            environment: Environment::Live,
            subscribed_facilities: Vec::new(),
            #[cfg(feature = "vnas")]
            error: None,
            #[cfg(not(feature = "vnas"))]
            error: Some("vNAS feature not enabled - using VATSIM HTTP polling".to_string()),
            #[cfg(feature = "vnas")]
            available: true,
            #[cfg(not(feature = "vnas"))]
            available: false,
            last_session_end: None,
            session_kind: None,
        }
    }
}

// =============================================================================
// YAAT LOCAL PROBE (both builds)
// =============================================================================

/// Whether a local YAAT server answers at a base URL and accepts dev logins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YaatLocalProbe {
    available: bool,
}

/// How long each probe request may take; the frontend polls, so a dead server must not stall it.
const YAAT_LOCAL_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// The probe's base URL: `url` without a trailing `/`, or why it cannot be probed.
fn yaat_local_probe_base(url: &str) -> Result<String, String> {
    let base = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(base).map_err(|e| format!("invalid URL {base:?}: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(base.to_string()),
        scheme => Err(format!("unsupported scheme {scheme:?} in {base:?}")),
    }
}

/// Whether an `/auth/required` body says the server accepts dev logins (`required` is `false`).
fn yaat_local_auth_not_required(body: &str) -> Result<(), String> {
    let json: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("/auth/required body is not JSON: {e}"))?;
    match json.get("required") {
        Some(serde_json::Value::Bool(false)) => Ok(()),
        Some(other) => Err(format!("/auth/required says required = {other}")),
        None => Err("/auth/required body has no `required` field".to_string()),
    }
}

/// GET `{base}{path}` and return the body when the server answers 2xx.
async fn yaat_local_probe_get(
    client: &reqwest::Client,
    base: &str,
    path: &str,
) -> Result<String, String> {
    let response = client
        .get(format!("{base}{path}"))
        .send()
        .await
        .map_err(|e| format!("GET {path} failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GET {path} answered {status}"));
    }
    response
        .text()
        .await
        .map_err(|e| format!("GET {path} body unreadable: {e}"))
}

/// Why the YAAT Local server at `url` is not usable, or `Ok` when it is.
async fn yaat_local_probe(url: &str) -> Result<(), String> {
    let base = yaat_local_probe_base(url)?;
    let client = reqwest::Client::builder()
        .timeout(YAAT_LOCAL_PROBE_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP client unavailable: {e}"))?;
    yaat_local_probe_get(&client, &base, "/api/version").await?;
    let body = yaat_local_probe_get(&client, &base, "/auth/required").await?;
    yaat_local_auth_not_required(&body)
}

/// Check whether a local YAAT server is running at `url` and accepts dev logins.
#[tauri::command]
pub async fn vnas_probe_yaat_local(url: String) -> YaatLocalProbe {
    match yaat_local_probe(&url).await {
        Ok(()) => YaatLocalProbe { available: true },
        Err(reason) => {
            tracing::debug!("YAAT Local not available at {url}: {reason}");
            YaatLocalProbe { available: false }
        }
    }
}

/// `url` with everything from its first `?` or `#` to the end removed.
///
/// A vNAS OAuth callback carries a one-time authorization code in its query, so a URL
/// logged with this keeps its scheme, host and path and nothing that can be exchanged.
pub(crate) fn url_without_query(url: &str) -> &str {
    match url.find(['?', '#']) {
        Some(end) => &url[..end],
        None => url,
    }
}

// =============================================================================
// REAL IMPLEMENTATION (when vnas feature is enabled)
// =============================================================================

#[cfg(feature = "vnas")]
mod real_impl {
    use super::*;
    use crate::settings::{read_vnas_tokens, write_vnas_tokens};
    use parking_lot::Mutex;
    use std::sync::Arc;
    use std::sync::Mutex as StdMutex;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::Emitter;
    use tokio::sync::{broadcast, RwLock as TokioRwLock};
    use tokio::task::{AbortHandle, Id as TaskId, JoinHandle};

    // =========================================================================
    // MODULE-LEVEL CACHES (for sync access from server.rs WebSocket handler)
    // =========================================================================
    // These mirror the Tauri-managed VnasState so that the sync helper functions
    // (get_state_sync, get_session_facilities_sync, get_subscribed_facilities_sync)
    // can return real data without needing async access to Tauri managed state.

    static CACHED_VNAS_STATE: StdMutex<Option<String>> = StdMutex::new(None);
    static CACHED_SESSION_FACILITIES: StdMutex<Vec<String>> = StdMutex::new(Vec::new());
    static CACHED_SUBSCRIBED_FACILITIES: StdMutex<Vec<String>> = StdMutex::new(Vec::new());

    /// Update the cached vNAS state string (for sync access from server.rs)
    fn cache_state(state: SessionState) {
        let state_str = serde_json::to_string(&state)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        if let Ok(mut guard) = CACHED_VNAS_STATE.lock() {
            *guard = Some(state_str);
        }
    }

    /// Update the cached session facilities (for sync access from server.rs)
    fn cache_session_facilities(facilities: &[String]) {
        if let Ok(mut guard) = CACHED_SESSION_FACILITIES.lock() {
            *guard = facilities.to_vec();
        }
    }

    /// Update the cached subscribed facilities (for sync access from server.rs)
    fn cache_subscribed_facilities(facilities: &[String]) {
        if let Ok(mut guard) = CACHED_SUBSCRIBED_FACILITIES.lock() {
            *guard = facilities.to_vec();
        }
    }

    // Import types from the vNAS crate
    use towercab_3d_vnas::{
        Environment as VnasEnvironment, JoinedSession, SessionKind as VnasSessionKind,
        SessionState as VnasSessionState, SessionToken, StoredTokens, TowerCabAircraftDto,
        VnasConfig, VnasError, VnasEvent, VnasService,
    };

    impl From<VnasSessionKind> for SessionKind {
        fn from(kind: VnasSessionKind) -> Self {
            match kind {
                VnasSessionKind::Crc => SessionKind::Crc,
                VnasSessionKind::Room => SessionKind::Room,
            }
        }
    }

    impl From<Environment> for VnasEnvironment {
        fn from(env: Environment) -> Self {
            match env {
                Environment::Live => VnasEnvironment::Live,
                Environment::Sweatbox1 => VnasEnvironment::Sweatbox1,
                Environment::Sweatbox2 => VnasEnvironment::Sweatbox2,
                Environment::Test => VnasEnvironment::Test,
                Environment::YaatLocal => VnasEnvironment::YaatLocal,
                Environment::Yaat1 => VnasEnvironment::Yaat1,
            }
        }
    }

    /// Error for the OAuth commands when asked for YAAT Local, which has no OAuth.
    const YAAT_LOCAL_NO_OAUTH: &str = "YAAT Local signs in with vnas_yaat_local_sign_in";

    /// Error for `vnas_yaat_local_sign_in` when no CID was typed and no VATSIM login is
    /// stored; the frontend matches this string exactly and asks the user for a CID.
    const YAAT_LOCAL_CID_REQUIRED: &str = "yaat_local_cid_required";

    /// Build the service config for an environment, with the YAAT Local base URL when given.
    fn service_config(environment: Environment, yaat_local_url: Option<String>) -> VnasConfig {
        let config = VnasConfig::new(environment.into());
        match yaat_local_url {
            Some(url) => config.with_yaat_local_base_url(url),
            None => config,
        }
    }

    /// Whether a service is connected or on its way there, so a new one must not replace it.
    async fn is_session_active(service: &VnasService) -> bool {
        matches!(
            service.state().await,
            VnasSessionState::Connected
                | VnasSessionState::Connecting
                | VnasSessionState::JoiningSession
                | VnasSessionState::Subscribing
                | VnasSessionState::WaitingForSession
        )
    }

    impl From<VnasSessionState> for SessionState {
        fn from(state: VnasSessionState) -> Self {
            match state {
                VnasSessionState::Disconnected => SessionState::Disconnected,
                VnasSessionState::Authenticating => SessionState::Authenticating,
                VnasSessionState::Connecting => SessionState::Connecting,
                VnasSessionState::JoiningSession => SessionState::JoiningSession,
                VnasSessionState::WaitingForSession => SessionState::WaitingForSession,
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

    impl StatusCell<SessionToken> {
        /// Apply a join the service reported: `Subscribing` (`apply_session_change`), every
        /// subscribe in flight dropped, then the joined session's token and kind stored
        /// under the generation the join moved to (`SessionCell::join`). Returns whether the
        /// subscriptions were cleared and that generation.
        fn apply_join(&mut self, joined: JoinedSession) -> (bool, u64) {
            let dropped = apply_session_change(&mut self.status, SessionState::Subscribing);
            self.pending_subscribes.clear();
            let generation = self.session.join(joined.session, joined.kind.into());
            (dropped, generation)
        }
    }

    /// A claimed in-flight subscribe; dropping it releases the claim.
    ///
    /// Release on drop covers every way out of a subscribe: success, an error, an early
    /// return, or a caller that drops the future mid-await.
    pub struct PendingSubscribe<'a> {
        state: &'a VnasState,
        facility_id: String,
        token: u64,
        finished: bool,
    }

    impl PendingSubscribe<'_> {
        /// Release the claim after a successful hub subscribe.
        ///
        /// Returns whether the facility was recorded as subscribed (false when an
        /// unsubscribe or a disconnect cancelled it while the subscribe was in flight).
        pub fn succeed(mut self) -> bool {
            self.finished = true;
            self.state
                .finish_subscribe(&self.facility_id, self.token, true)
        }
    }

    impl Drop for PendingSubscribe<'_> {
        fn drop(&mut self) {
            if !self.finished {
                self.state
                    .finish_subscribe(&self.facility_id, self.token, false);
            }
        }
    }

    /// vNAS state managed by Tauri (real implementation)
    pub struct VnasState {
        status: RwLock<StatusCell<SessionToken>>,
        /// The vNAS service instance (uses tokio RwLock for async access). Callers clone
        /// the `Arc` out with `current_service` and hold no guard across a call on it.
        service: TokioRwLock<Option<Arc<VnasService>>>,
        /// The task forwarding the service's events to the frontend
        event_forwarder: Mutex<Option<JoinHandle<()>>>,
        /// Channel for broadcasting aircraft updates to frontend/WebSocket
        event_tx: broadcast::Sender<VnasAircraft>,
        /// App handle for emitting events
        app_handle: RwLock<Option<AppHandle>>,
        /// Last processed OAuth callback URL (for deduplication)
        last_oauth_callback: RwLock<Option<String>>,
    }

    impl VnasState {
        pub fn new() -> Self {
            let (event_tx, _) = broadcast::channel(1024);
            Self {
                status: RwLock::new(StatusCell::default()),
                service: TokioRwLock::new(None),
                event_forwarder: Mutex::new(None),
                event_tx,
                app_handle: RwLock::new(None),
                last_oauth_callback: RwLock::new(None),
            }
        }

        pub fn status(&self) -> VnasStatus {
            let cell = self.status.read();
            VnasStatus {
                session_kind: cell.session.kind(),
                ..cell.status.clone()
            }
        }

        /// Apply `f` to the status under one write lock, so a change any other status
        /// writer makes between a separate read and write is never overwritten.
        pub fn update_status(&self, f: impl FnOnce(&mut VnasStatus)) {
            f(&mut self.status.write().status);
        }

        /// The connect epoch: the one the newest connect started under, or the last
        /// disconnect's reset moved to.
        fn connect_epoch(&self) -> u64 {
            self.status.read().connect_epoch
        }

        /// Apply `f` to the status unless a newer connect or a disconnect's reset has
        /// bumped the connect epoch since `epoch` was read. The compare and `f` run under
        /// one status write lock, the lock every bump happens under. Returns whether `f`
        /// ran.
        fn update_status_if_epoch(&self, epoch: u64, f: impl FnOnce(&mut VnasStatus)) -> bool {
            self.status
                .write()
                .if_epoch(epoch, |cell| f(&mut cell.status))
                .is_some()
        }

        /// Run `f` on the status cell under one write lock, unless the connect epoch moved
        /// since `epoch` was read; returns what `f` returned, or `None` when it did not run.
        fn with_cell_if_epoch<R>(
            &self,
            epoch: u64,
            f: impl FnOnce(&mut StatusCell<SessionToken>) -> R,
        ) -> Option<R> {
            self.status.write().if_epoch(epoch, f)
        }

        /// Reset the status after a disconnect (`StatusCell::reset_for_disconnect`), so a
        /// connect's or a forwarder's status write lands before this reset or not at all.
        fn reset_for_disconnect(&self) {
            self.status.write().reset_for_disconnect();
        }

        /// Forget everything about the previous service's sessions: its token, its kind
        /// and how its last session ended. Called whenever a new service replaces the
        /// stored one.
        fn forget_session(&self) {
            let mut cell = self.status.write();
            cell.forget_joined_session();
            cell.status.last_session_end = None;
        }

        /// The session generation; read it before reading the joined session from the
        /// service and pass it to `store_joined` or `store_airports`.
        fn session_generation(&self) -> u64 {
            self.status.read().session.generation()
        }

        /// The stored token of the joined session, if it has been read.
        fn session_token(&self) -> Option<SessionToken> {
            self.status.read().session.token()
        }

        /// Forget the joined session (token, kind and airports) if its token is still
        /// `token`, which the service refused as stale, so the next subscribe reads the
        /// joined session's token afresh. A newer token stored meanwhile is kept. The kind
        /// reads `None` until the newer session's join stores it again.
        fn forget_stale_session_token(&self, token: SessionToken) {
            let mut cell = self.status.write();
            if cell.session.token() == Some(token) {
                cell.forget_joined_session();
            }
        }

        /// Keep the joined session's token and kind, unless the session changed since
        /// `generation` was read. Returns whether it stored them.
        fn store_joined(&self, generation: u64, joined: JoinedSession) -> bool {
            self.status
                .write()
                .session
                .store_joined(generation, joined.session, joined.kind.into())
        }

        /// Keep the joined session's airports and cache them as the session facilities
        /// (what remote clients see in the airport selector), unless the session changed
        /// since `generation` was read or `token` (the session the airports were read
        /// from) is not the joined session the host holds. The checks, the store and the
        /// cache write run under one status write lock. Returns whether it stored them.
        fn store_airports(
            &self,
            generation: u64,
            token: SessionToken,
            airports: Vec<String>,
        ) -> bool {
            let mut cell = self.status.write();
            if !cell
                .session
                .store_airports_of_session(generation, token, airports)
            {
                return false;
            }
            cache_session_facilities(cell.session.airports());
            true
        }

        /// Keep the airports of the session `token` names and cache them as the session
        /// facilities, only while it is the joined session the host holds. The check, the
        /// store and the cache write run under one status write lock. Returns whether it
        /// stored them.
        fn store_session_airports(&self, token: SessionToken, airports: Vec<String>) -> bool {
            let mut cell = self.status.write();
            if !cell.session.store_airports_of(token, airports) {
                return false;
            }
            cache_session_facilities(cell.session.airports());
            true
        }

        pub fn update_state(&self, state: SessionState) {
            self.status.write().status.state = state;
        }

        pub fn set_error(&self, error: Option<String>) {
            self.status.write().status.error = error;
        }

        /// Claim a facility for a hub subscribe.
        ///
        /// Returns `None` when the facility is already subscribed or a subscribe for it is
        /// in flight; otherwise marks it pending and returns the claim's token. Every token
        /// must be passed to one `finish_subscribe`.
        pub fn try_begin_subscribe(&self, facility_id: &str) -> Option<u64> {
            let mut cell = self.status.write();
            let subscribed = cell
                .status
                .subscribed_facilities
                .iter()
                .any(|f| f == facility_id);
            if subscribed || cell.pending_subscribes.contains_key(facility_id) {
                return None;
            }
            cell.last_claim_token += 1;
            let token = cell.last_claim_token;
            cell.pending_subscribes
                .insert(facility_id.to_string(), token);
            Some(token)
        }

        /// Release the claim `token` from `try_begin_subscribe`.
        ///
        /// Acts only while that claim still owns the facility: once an unsubscribe or a
        /// disconnect cancelled it, a newer claim for the facility is left alone. On success
        /// the facility is added to the subscriptions. Returns whether the facility is now
        /// recorded as subscribed by this call.
        pub fn finish_subscribe(&self, facility_id: &str, token: u64, success: bool) -> bool {
            let mut cell = self.status.write();
            if cell.pending_subscribes.get(facility_id) != Some(&token) {
                return false;
            }
            cell.pending_subscribes.remove(facility_id);
            let subscribed = &mut cell.status.subscribed_facilities;
            let record = success && !subscribed.iter().any(|f| f == facility_id);
            if record {
                subscribed.push(facility_id.to_string());
            }
            record
        }

        /// `try_begin_subscribe` as a guard that releases the claim when dropped.
        pub fn begin_subscribe(&self, facility_id: &str) -> Option<PendingSubscribe<'_>> {
            self.try_begin_subscribe(facility_id)
                .map(|token| PendingSubscribe {
                    state: self,
                    facility_id: facility_id.to_string(),
                    token,
                    finished: false,
                })
        }

        /// Remove a facility from the subscriptions and cancel any subscribe in flight for it.
        ///
        /// Returns whether the facility was subscribed or pending.
        pub fn remove_facility(&self, facility_id: &str) -> bool {
            let mut cell = self.status.write();
            let was_pending = cell.pending_subscribes.remove(facility_id).is_some();
            let subscribed = &mut cell.status.subscribed_facilities;
            let count = subscribed.len();
            subscribed.retain(|f| f != facility_id);
            was_pending || subscribed.len() != count
        }

        /// Keep `handle` as the event forwarder, aborting the forwarder it replaces.
        ///
        /// Every `vnas_connect` on the same service spawns a forwarder; without the abort
        /// each earlier one would keep emitting every update again.
        fn replace_event_forwarder(&self, handle: JoinHandle<()>) {
            if let Some(previous) = self.event_forwarder.lock().replace(handle) {
                previous.abort();
            }
        }

        /// Drop the stored event forwarder's handle if it is the task `id`, leaving a
        /// newer connect's forwarder in place.
        fn clear_event_forwarder_if(&self, id: TaskId) {
            let mut stored = self.event_forwarder.lock();
            if stored
                .as_ref()
                .is_some_and(|forwarder| forwarder.id() == id)
            {
                *stored = None;
            }
        }

        /// Abort the event forwarder, if one is running, and return its handle so the
        /// caller can wait for it to stop.
        fn abort_event_forwarder(&self) -> Option<JoinHandle<()>> {
            let forwarder = self.event_forwarder.lock().take();
            if let Some(forwarder) = &forwarder {
                forwarder.abort();
            }
            forwarder
        }

        /// Clone the current service out of its lock, so no guard is held while a call on
        /// it awaits: a disconnect's write lock then never waits on one.
        async fn current_service(&self) -> Option<Arc<VnasService>> {
            self.service.read().await.clone()
        }
    }

    /// Abort the event forwarder and wait until it has stopped, so no event it was still
    /// draining is applied or emitted afterwards.
    async fn stop_event_forwarder(state: &VnasState) {
        let Some(forwarder) = state.abort_event_forwarder() else {
            return;
        };
        if let Err(e) = forwarder.await {
            if !e.is_cancelled() {
                tracing::warn!("[vNAS] event forwarder failed: {e}");
            }
        }
    }

    /// Bring the status up to date with `service` after the forwarder lost events: read
    /// its state, its joined session and its forcible end reason, then apply the re-sync
    /// (`resync_action`) through the forwarder's connect epoch `epoch`, refresh the caches
    /// and emit what it wrote. Runs inline on the forwarder's task, after the events it
    /// still held.
    async fn resync_with_service(app: AppHandle, service: Arc<VnasService>, epoch: u64) {
        let service_state = SessionState::from(service.state().await);
        let joined = service
            .joined_session()
            .await
            .map(|joined| (joined.session, SessionKind::from(joined.kind)));
        let forced_reason = service.forced_end_reason().await;
        let state = app.state::<VnasState>();
        let writes = state.with_cell_if_epoch(epoch, |cell| {
            let resync = resync_action(
                cell.status.state,
                cell.session.token(),
                service_state,
                joined,
                forced_reason,
            );
            cell.apply_resync(resync)
        });
        let Some(writes) = writes else {
            tracing::debug!("[vNAS] A newer connect or a disconnect owns the status; no re-sync");
            return;
        };
        if let Some(new_state) = writes.new_state {
            tracing::info!("[vNAS] Re-synced the session state: {new_state:?}");
            cache_state(new_state);
        }
        clear_session_caches(writes.dropped);
        for event in writes.events {
            emit_session_change(&app, event);
        }
        if let Some(generation) = writes.joined_generation {
            tokio::spawn(remember_session(
                Arc::clone(&service),
                app.clone(),
                generation,
            ));
        }
        if let Some(reason) = writes.forced_error {
            tracing::info!("[vNAS] Removed from the session: {reason}");
            let _ = app.emit("vnas-error", &reason);
        }
    }

    /// A session change the service reported: a bare state, or a join carrying the joined
    /// session (its state is `Subscribing`).
    enum ReportedSessionChange {
        State(SessionState),
        Joined(JoinedSession),
    }

    impl Default for VnasState {
        fn default() -> Self {
            Self::new()
        }
    }

    // =========================================================================
    // TOKEN PERSISTENCE HELPERS (uses global settings)
    // =========================================================================

    /// Save tokens to global settings
    fn save_tokens(app: &AppHandle, tokens: &StoredTokens) -> Result<(), String> {
        let json = serde_json::to_string(tokens)
            .map_err(|e| format!("Failed to serialize tokens: {e}"))?;

        write_vnas_tokens(app, Some(json))?;

        tracing::debug!("vNAS tokens saved");
        Ok(())
    }

    /// Load tokens from global settings
    fn load_tokens(app: &AppHandle) -> Result<Option<StoredTokens>, String> {
        let Some(json) = read_vnas_tokens(app)? else {
            return Ok(None);
        };

        let tokens: StoredTokens = serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse stored tokens: {e}"))?;

        tracing::debug!("vNAS tokens loaded");
        Ok(Some(tokens))
    }

    /// Clear stored tokens from global settings
    fn clear_tokens(app: &AppHandle) -> Result<(), String> {
        write_vnas_tokens(app, None)?;
        tracing::debug!("vNAS tokens cleared");
        Ok(())
    }

    // =========================================================================
    // TAURI COMMANDS (real implementation)
    // =========================================================================

    /// Get the current vNAS connection status
    #[tauri::command]
    pub fn vnas_get_status(state: State<'_, VnasState>) -> VnasStatus {
        let status = state.status();
        // Update caches so sync functions return current data
        cache_state(status.state);
        cache_subscribed_facilities(&status.subscribed_facilities);
        status
    }

    /// Check if vNAS feature is available
    #[tauri::command]
    pub fn vnas_is_available() -> bool {
        true
    }

    /// Try to restore a vNAS session from stored tokens.
    ///
    /// Returns true if session was restored successfully, false if user needs to re-authenticate.
    /// Call this on app startup before showing the OAuth UI.
    #[tauri::command]
    pub async fn vnas_try_restore_session(
        app: AppHandle,
        state: State<'_, VnasState>,
        environment: Environment,
    ) -> Result<bool, String> {
        if environment == Environment::YaatLocal {
            return Err(YAAT_LOCAL_NO_OAUTH.to_string());
        }

        // If already connected or connecting, don't create a new service
        if let Some(service) = state.current_service().await {
            if is_session_active(&service).await {
                tracing::debug!("vNAS session already active, skipping restore");
                return Ok(true);
            }
        }

        // Load stored tokens
        let Some(tokens) = load_tokens(&app)? else {
            return Ok(false);
        };

        // Store app handle
        *state.app_handle.write() = Some(app.clone());

        let service = VnasService::new(service_config(environment, None));

        // Try to restore session
        match service.restore_session(tokens).await {
            Ok(true) => {
                tracing::info!("vNAS session restored");

                // Update status
                state.update_status(|status| {
                    status.environment = environment;
                    status.error = None;
                });

                // Store service
                let service = Arc::new(service);
                *state.service.write().await = Some(Arc::clone(&service));
                state.forget_session();

                // Save potentially refreshed tokens
                if let Some(tokens) = service.get_stored_tokens().await {
                    save_tokens(&app, &tokens)?;
                }

                Ok(true)
            }
            Ok(false) => {
                tracing::debug!("vNAS tokens expired, re-authentication required");
                clear_tokens(&app)?;
                Ok(false)
            }
            Err(e) => {
                tracing::warn!("vNAS session restore failed: {}", e);
                clear_tokens(&app)?;
                Err(e.to_string())
            }
        }
    }

    /// Start the vNAS OAuth authentication flow.
    /// Returns the URL to open in the user's browser.
    #[tauri::command]
    pub async fn vnas_start_auth(
        app: AppHandle,
        state: State<'_, VnasState>,
        environment: Environment,
    ) -> Result<String, String> {
        if environment == Environment::YaatLocal {
            return Err(YAAT_LOCAL_NO_OAUTH.to_string());
        }

        // Update status
        state.update_status(|status| {
            status.state = SessionState::Authenticating;
            status.environment = environment;
            status.error = None;
        });

        // Store app handle for later event emission
        *state.app_handle.write() = Some(app.clone());

        let service = VnasService::new(service_config(environment, None));

        // Start OAuth flow
        let auth_url = service.start_oauth().await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            e.to_string()
        })?;

        // Store service for later use
        *state.service.write().await = Some(Arc::new(service));
        state.forget_session();

        tracing::info!("vNAS OAuth flow started for {:?}", environment);
        Ok(auth_url)
    }

    /// The CID to sign in to YAAT Local as: the typed CID when there is one, otherwise the CID
    /// of the stored VATSIM login, whose refreshed tokens are saved on the way.
    async fn resolve_yaat_local_cid(
        app: &AppHandle,
        cid: Option<String>,
    ) -> Result<String, String> {
        if let Some(typed) = cid.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
            if !typed.chars().all(|c| c.is_ascii_digit()) {
                return Err("Invalid CID".to_string());
            }
            return Ok(typed);
        }

        if let Some(tokens) = load_tokens(app)? {
            match VnasService::resolve_vatsim_cid(tokens).await {
                Ok(Some(resolved)) => {
                    save_tokens(app, &resolved.tokens)?;
                    return Ok(resolved.cid);
                }
                Ok(None) => {
                    tracing::debug!("Stored VATSIM login expired, YAAT Local needs a typed CID");
                    clear_tokens(app)?;
                }
                Err(e) => return Err(e.to_string()),
            }
        }

        Err(YAAT_LOCAL_CID_REQUIRED.to_string())
    }

    /// Sign in to a local YAAT development server with its dev login.
    ///
    /// The CID is the typed `cid` when given, otherwise the stored VATSIM login's CID; with
    /// neither, returns `yaat_local_cid_required`. Call `vnas_connect` afterwards.
    #[tauri::command]
    pub async fn vnas_yaat_local_sign_in(
        app: AppHandle,
        state: State<'_, VnasState>,
        yaat_local_url: String,
        cid: Option<String>,
    ) -> Result<(), String> {
        if let Some(service) = state.current_service().await {
            if is_session_active(&service).await {
                tracing::debug!("vNAS session already active, skipping YAAT Local sign-in");
                return Ok(());
            }
        }

        let cid = resolve_yaat_local_cid(&app, cid).await?;

        let service =
            VnasService::new(service_config(Environment::YaatLocal, Some(yaat_local_url)));
        if let Err(e) = service.dev_login(&cid).await {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            return Err(e.to_string());
        }

        tracing::info!("YAAT Local dev login as CID {cid}");
        *state.app_handle.write() = Some(app);
        *state.service.write().await = Some(Arc::new(service));
        state.forget_session();

        state.update_status(|status| {
            status.environment = Environment::YaatLocal;
            status.error = None;
        });

        Ok(())
    }

    /// Complete the OAuth flow after browser callback.
    /// This waits for the SSE callback from auth.vfsp.net.
    #[tauri::command]
    pub async fn vnas_complete_auth(state: State<'_, VnasState>) -> Result<(), String> {
        // Get service reference
        let service = state
            .current_service()
            .await
            .ok_or("OAuth not started - call vnas_start_auth first")?;

        // Wait for OAuth callback (this blocks until user completes browser auth)
        service.complete_oauth().await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            format!("OAuth failed: {}", e)
        })?;

        tracing::info!("vNAS OAuth completed");
        state.update_state(SessionState::Connecting);

        Ok(())
    }

    /// Handle OAuth callback from deep link (tc3d://oauth/callback?code=...).
    /// This is called when the app receives the OAuth redirect.
    #[tauri::command]
    pub async fn vnas_handle_oauth_callback(
        app: AppHandle,
        state: State<'_, VnasState>,
        callback_url: String,
    ) -> Result<(), String> {
        tracing::info!(
            "vNAS OAuth callback received: {}",
            url_without_query(&callback_url)
        );

        // Deduplication: Check if we've already processed this callback URL.
        // With single-instance as the first plugin, duplicates should be rare,
        // but we keep this as a safety net.
        {
            let mut last_callback = state.last_oauth_callback.write();
            if last_callback.as_ref() == Some(&callback_url) {
                tracing::debug!("Ignoring duplicate OAuth callback");
                return Ok(());
            }
            *last_callback = Some(callback_url.clone());
        }

        // Guard: Only process callback if we're in authenticating state.
        let current_state = state.status().state;
        if current_state != SessionState::Authenticating {
            tracing::debug!(
                "OAuth callback skipped - not in authenticating state (current: {:?})",
                current_state
            );
            return Ok(());
        }

        // Parse the callback URL to extract the authorization code
        let url =
            url::Url::parse(&callback_url).map_err(|e| format!("Invalid callback URL: {}", e))?;

        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.to_string())
            .ok_or("No authorization code in callback URL")?;

        // Get service reference
        let service = state
            .current_service()
            .await
            .ok_or("OAuth not started - call vnas_start_auth first")?;

        // Complete OAuth with the authorization code from the deep link
        service.complete_oauth_with_code(&code).await.map_err(|e| {
            state.set_error(Some(e.to_string()));
            state.update_state(SessionState::Disconnected);
            format!("OAuth failed: {}", e)
        })?;

        tracing::info!("vNAS OAuth completed via deep link");

        // Save tokens for future sessions
        if let Some(tokens) = service.get_stored_tokens().await {
            save_tokens(&app, &tokens)?;
        } else {
            tracing::warn!("vNAS tokens not available after OAuth");
        }

        // Note: We don't set state to Connecting here - that's connect()'s job.
        // The state remains Authenticating until connect() is explicitly called.
        // This ensures the connect() guard doesn't skip the actual connection.
        Ok(())
    }

    /// Connect to vNAS after successful authentication.
    /// This establishes the SignalR WebSocket connection.
    #[tauri::command]
    pub async fn vnas_connect(app: AppHandle, state: State<'_, VnasState>) -> Result<(), String> {
        // Check if authenticated
        let service = state
            .current_service()
            .await
            .ok_or("Not authenticated - complete OAuth first")?;

        if !service.is_authenticated().await {
            return Err("Not authenticated - complete OAuth first".into());
        }

        // Guard against double-connect (can happen with React Strict Mode). A newer
        // connect or a disconnect from here on makes every status write below a no-op.
        let Some(epoch) = begin_connect(&app, &state) else {
            return Ok(());
        };
        if !is_current_service(&state, &service).await {
            // A disconnect took the service out before `Connecting` was written over its
            // reset: put the reset's state back.
            publish_connect_state(&app, &state, epoch, SessionState::Disconnected, None);
            abandon_detached_connect(&state, &service, None).await;
            return Ok(());
        }

        // Start forwarding events before connecting, so no event the connect triggers
        // (such as a background session join) is missed. The previous forwarder is
        // stopped before the new receiver subscribes, so no event reaches both and is
        // emitted twice.
        stop_event_forwarder(&state).await;
        let event_tx = state.event_tx.clone();
        let app_for_events = app.clone();
        let service_for_events = Arc::clone(&service);
        let app_for_resync = app.clone();
        let service_for_resync = Arc::clone(&service);
        let events = service.events();
        let forwarder = tokio::spawn(forward_events(
            events,
            move |event| {
                forward_event(
                    &app_for_events,
                    &service_for_events,
                    &event_tx,
                    epoch,
                    event,
                );
            },
            move || {
                resync_with_service(
                    app_for_resync.clone(),
                    Arc::clone(&service_for_resync),
                    epoch,
                )
            },
        ));
        let forwarder_abort = forwarder.abort_handle();
        state.replace_event_forwarder(forwarder);

        // Connect to SignalR hub
        let connected = service.connect().await;
        if !publish_connect_result(&app, &state, &service, epoch, connected).await? {
            abandon_detached_connect(&state, &service, Some(&forwarder_abort)).await;
        }
        Ok(())
    }

    /// Start a connect (`StatusCell::begin_connect`) and, when it started, refresh the
    /// cached state and emit `Connecting` under the same status write lock. Returns the
    /// connect's epoch, or `None` while a session is connecting or active.
    fn begin_connect(app: &AppHandle, state: &VnasState) -> Option<u64> {
        let mut cell = state.status.write();
        let epoch = cell.begin_connect()?;
        cache_state(SessionState::Connecting);
        let _ = app.emit("vnas-state-changed", SessionState::Connecting);
        drop(cell);
        Some(epoch)
    }

    /// Apply one service event to the managed status and pass it on to the frontend.
    ///
    /// Status writes go through the connect epoch `epoch` of the connect that started this
    /// forwarder: once a newer connect or a disconnect moved it, they write and emit
    /// nothing.
    fn forward_event(
        app: &AppHandle,
        service: &Arc<VnasService>,
        event_tx: &broadcast::Sender<VnasAircraft>,
        epoch: u64,
        event: VnasEvent,
    ) {
        match event {
            VnasEvent::AircraftUpdate(aircraft_list) => {
                for dto in aircraft_list {
                    let aircraft = VnasAircraft::from(&dto);
                    let _ = event_tx.send(aircraft.clone());

                    // Emit to frontend via Tauri event
                    let _ = app.emit("vnas-aircraft-update", &aircraft);
                }
            }
            VnasEvent::AircraftDisconnected(callsign) => {
                tracing::info!("[vNAS] Aircraft disconnected: {}", callsign);
                let _ = app.emit("vnas-aircraft-disconnected", &callsign);
            }
            VnasEvent::SessionStateChanged(new_state) => {
                if new_state == VnasSessionState::Subscribing {
                    tracing::warn!(
                        "vNAS: SessionStateChanged(Subscribing) without SessionJoined; the join token is unknown"
                    );
                }
                let change = ReportedSessionChange::State(new_state.into());
                forward_session_state(app, service, epoch, change);
            }
            VnasEvent::SessionJoined(joined) => {
                let change = ReportedSessionChange::Joined(joined);
                forward_session_state(app, service, epoch, change);
            }
            VnasEvent::SessionEnded { reason, forcible } => {
                tracing::info!(forcible, "[vNAS] Session ended: {reason}");
                app.state::<VnasState>()
                    .update_status_if_epoch(epoch, |status| {
                        status.last_session_end = Some(SessionEndInfo { reason, forcible });
                    });
            }
            VnasEvent::Error(error) => {
                tracing::info!("[vNAS] Error: {}", error);
                let shown = app
                    .state::<VnasState>()
                    .update_status_if_epoch(epoch, |status| {
                        status.error = Some(error.to_string());
                    });
                if shown {
                    let _ = app.emit("vnas-error", error.to_string());
                }
            }
        }
    }

    /// Apply a session state the service reported, refresh the caches and emit it.
    ///
    /// A join stores the joined session's token and kind with the state and looks its
    /// airports up in the background, under the generation the join moved to; on
    /// `Disconnected` after a forcible end it shows the end's reason. Writes, refreshes and
    /// emits nothing once the connect epoch moved past `epoch`.
    ///
    /// A join is applied as `Subscribing`, a session change, then the joined session's
    /// token and kind, all under one status write lock, so they are stored under the
    /// generation the change moved to and a claim never meets the change without them.
    fn forward_session_state(
        app: &AppHandle,
        service: &Arc<VnasService>,
        epoch: u64,
        change: ReportedSessionChange,
    ) {
        let state = app.state::<VnasState>();
        let applied = state.with_cell_if_epoch(epoch, |cell| match change {
            ReportedSessionChange::State(new_state) => {
                (new_state, cell.apply_session_state(new_state), None)
            }
            ReportedSessionChange::Joined(joined) => {
                let (dropped, generation) = cell.apply_join(joined);
                (SessionState::Subscribing, dropped, Some(generation))
            }
        });
        let Some((new_state, dropped, joined_generation)) = applied else {
            tracing::debug!(
                "[vNAS] A newer connect or a disconnect owns the status; state ignored"
            );
            return;
        };
        cache_state(new_state);
        tracing::info!("[vNAS] Session state changed: {:?}", new_state);
        clear_session_caches(dropped);
        for event in session_change_events(new_state, dropped) {
            emit_session_change(app, event);
        }

        let forced_end = state
            .status()
            .last_session_end
            .is_some_and(|end| end.forcible);
        match (new_state, joined_generation) {
            (_, Some(generation)) => {
                tokio::spawn(remember_session(
                    Arc::clone(service),
                    app.clone(),
                    generation,
                ));
            }
            (SessionState::Disconnected, None) if forced_end => {
                tokio::spawn(show_forced_end_reason(
                    Arc::clone(service),
                    app.clone(),
                    epoch,
                ));
            }
            _ => {}
        }
    }

    /// Empty the host caches a session change empties (`caches_cleared_by`).
    fn clear_session_caches(dropped: bool) {
        for cache in caches_cleared_by(dropped) {
            match cache {
                SessionCache::Subscribed => cache_subscribed_facilities(&[]),
                SessionCache::SessionFacilities => cache_session_facilities(&[]),
            }
        }
    }

    /// Emit one session change event to the frontend.
    fn emit_session_change(app: &AppHandle, event: SessionChangeEvent) {
        match event {
            SessionChangeEvent::State(new_state) => {
                let _ = app.emit("vnas-state-changed", new_state);
            }
            SessionChangeEvent::SubscriptionsCleared => {
                let _ = app.emit("vnas-subscriptions-changed", Vec::<String>::new());
            }
        }
    }

    /// Look the joined session's airports up and keep them, unless the session changed
    /// again since `generation` was read or the service's current session (whose airports
    /// it returns) is not the one the host holds. Its token and kind came with the join.
    async fn remember_session(service: Arc<VnasService>, app: AppHandle, generation: u64) {
        let Some(session) = service.session_airports().await else {
            tracing::debug!("[vNAS] Session ended before its airports were read");
            return;
        };
        if !app
            .state::<VnasState>()
            .store_airports(generation, session.session, session.airports)
        {
            tracing::debug!("[vNAS] Session changed while its airports were read");
        }
    }

    /// Show the reason of the forcible end that disconnected the service as the status
    /// error, unless a connect has started since (the connect epoch moved past `epoch`,
    /// or it cleared the forcible session end).
    async fn show_forced_end_reason(service: Arc<VnasService>, app: AppHandle, epoch: u64) {
        let Some(reason) = service.forced_end_reason().await else {
            return;
        };
        let mut shown = false;
        app.state::<VnasState>()
            .update_status_if_epoch(epoch, |status| {
                shown = apply_forced_end_error(status, Some(reason.clone()));
            });
        if shown {
            tracing::info!("[vNAS] Removed from the session: {reason}");
            let _ = app.emit("vnas-error", &reason);
        }
    }

    /// Write a connect's `new_state` (and `error`, when given) into the status, refresh
    /// the cached state and emit it, unless a newer connect or a disconnect has bumped the
    /// connect epoch since `epoch` was read. Returns whether it published.
    ///
    /// The cache write and the emit also run under the status write lock, so a
    /// disconnect's reset, cache write and `Disconnected` emit always land after them.
    fn publish_connect_state(
        app: &AppHandle,
        state: &VnasState,
        epoch: u64,
        new_state: SessionState,
        error: Option<String>,
    ) -> bool {
        state.update_status_if_epoch(epoch, |status| {
            apply_connect_state(status, new_state, error);
            cache_state(new_state);
            let _ = app.emit("vnas-state-changed", new_state);
        })
    }

    /// How `service.connect()` ended, as far as the status goes.
    fn connect_outcome(connected: &Result<(), VnasError>) -> ConnectOutcome {
        match connected {
            Ok(()) => ConnectOutcome::Connected,
            Err(VnasError::ConnectCancelled) => ConnectOutcome::Cancelled,
            Err(e) => ConnectOutcome::Failed(e.to_string()),
        }
    }

    /// Publish what `service.connect()` returned (`connect_result_write`): only a failure
    /// writes, through the connect's epoch. The event forwarder, started before the
    /// connect, has published every state a connect that succeeded went through
    /// (publishing it again would announce one join twice), and a cancelled connect's
    /// teardown reports its own `Disconnected` through the forwarder.
    ///
    /// Returns `Ok(false)`, having written nothing, when a disconnect took the service out:
    /// the disconnect owns the status and the frontend, and an error would show
    /// "Connection failed" after the user's own disconnect. A failure a newer connect
    /// overtook writes nothing and is not returned either, so it never shows over the
    /// newer connect's status.
    async fn publish_connect_result(
        app: &AppHandle,
        state: &VnasState,
        service: &Arc<VnasService>,
        epoch: u64,
        connected: Result<(), VnasError>,
    ) -> Result<bool, String> {
        if !is_current_service(state, service).await {
            return Ok(false);
        }
        let written = match connect_result_write(connect_outcome(&connected)) {
            Some((new_state, error)) => publish_connect_state(app, state, epoch, new_state, error),
            None => false,
        };
        match connected {
            Ok(()) => tracing::info!("vNAS connected to SignalR hub"),
            Err(VnasError::ConnectCancelled) => {
                tracing::info!("[vNAS] Connect cancelled by a server-side teardown");
            }
            Err(e) if written => return Err(format!("Connection failed: {}", e)),
            Err(e) => tracing::info!("[vNAS] Connect failed after a newer connect began: {e}"),
        }
        Ok(true)
    }

    /// Whether `service` is still the service in `state`, i.e. no disconnect took it out.
    async fn is_current_service(state: &VnasState, service: &Arc<VnasService>) -> bool {
        state
            .current_service()
            .await
            .is_some_and(|current| Arc::ptr_eq(&current, service))
    }

    /// Wind down a connect that a disconnect overtook: tear the detached service down
    /// and stop this connect's event forwarder, if it started one, clearing the stored
    /// one only if it is still this connect's. Writes no status and emits nothing: the
    /// disconnect did both.
    async fn abandon_detached_connect(
        state: &VnasState,
        service: &VnasService,
        forwarder: Option<&AbortHandle>,
    ) {
        tracing::info!("[vNAS] Disconnected while connecting; discarding the connection");
        if let Err(e) = service.disconnect().await {
            tracing::warn!("[vNAS] Disconnecting the discarded connection failed: {e}");
        }
        if let Some(forwarder) = forwarder {
            forwarder.abort();
            state.clear_event_forwarder_if(forwarder.id());
        }
    }

    /// Subscribe to a facility's TowerCabAircraft topic once, however many callers race.
    ///
    /// A caller that finds the facility subscribed or its subscribe in flight returns
    /// `Ok(false)` without contacting the hub, as does one with no session joined. The
    /// subscribe names the joined session; on success it records the facility, refreshes
    /// the cache and emits the new subscription list (the service reports `Connected`).
    async fn subscribe_once(
        app: &AppHandle,
        state: &VnasState,
        facility_id: &str,
    ) -> Result<bool, String> {
        let epoch = state.connect_epoch();
        let generation = state.session_generation();
        let Some(pending) = state.begin_subscribe(facility_id) else {
            tracing::debug!(facility_id, "Already subscribed or subscribing to facility");
            return Ok(false);
        };

        let service = state
            .current_service()
            .await
            .ok_or("Not connected - call vnas_connect first")?;
        let Some(session) = joined_session_token(state, &service, generation).await else {
            tracing::debug!(facility_id, "No session joined; subscribe skipped");
            return Ok(false);
        };
        if let Err(e) = service.subscribe_towercab(facility_id, session).await {
            let attempt = SubscribeAttempt {
                facility_id,
                session,
                epoch,
            };
            return subscribe_failed(state, &service, attempt, e).await;
        }
        if !pending.succeed() {
            tracing::debug!(facility_id, "Subscribe finished after it was cancelled");
            return Ok(false);
        }

        // Emit updated subscriptions list
        let subscriptions = state.status().subscribed_facilities;
        cache_subscribed_facilities(&subscriptions);
        let _ = app.emit("vnas-subscriptions-changed", &subscriptions);

        Ok(true)
    }

    /// The joined session's token: the stored one, else read from the service (no Data API
    /// lookup) and stored with its kind under `generation`, the one read with the claim.
    /// `None` while no session is joined.
    async fn joined_session_token(
        state: &VnasState,
        service: &VnasService,
        generation: u64,
    ) -> Option<SessionToken> {
        if let Some(token) = state.session_token() {
            return Some(token);
        }
        let joined = service.joined_session().await?;
        state.store_joined(generation, joined);
        Some(joined.session)
    }

    /// One hub subscribe: the facility, the session token it named, and the connect epoch
    /// read when it began.
    struct SubscribeAttempt<'a> {
        facility_id: &'a str,
        session: SessionToken,
        epoch: u64,
    }

    /// Settle a failed hub subscribe (`settle_subscribe_failure`).
    ///
    /// A stale session token (the session changed meanwhile), a service with no connection
    /// (a kick tore it down, whose reason must stay shown) and a subscribe cut off by the
    /// host's own disconnect are not failures: they set no error and return `Ok(false)`;
    /// a stale token is also forgotten. Anything else is shown as the status error and
    /// returned.
    async fn subscribe_failed(
        state: &VnasState,
        service: &Arc<VnasService>,
        attempt: SubscribeAttempt<'_>,
        error: VnasError,
    ) -> Result<bool, String> {
        let failure = match error {
            VnasError::InvalidState(_) => SubscribeFailure::StaleSession,
            VnasError::NotConnected => SubscribeFailure::NotConnected,
            _ => SubscribeFailure::Failed,
        };
        let disconnecting =
            state.connect_epoch() != attempt.epoch || !is_current_service(state, service).await;
        let message = error.to_string();
        let mut outcome = SubscribeOutcome::Ignore;
        state.update_status(|status| {
            outcome = settle_subscribe_failure(status, failure, disconnecting, &message);
        });
        if outcome == SubscribeOutcome::ForgetToken {
            state.forget_stale_session_token(attempt.session);
        }
        if outcome != SubscribeOutcome::ShowError {
            let facility_id = attempt.facility_id;
            tracing::debug!(
                facility_id,
                ?failure,
                disconnecting,
                "Subscribe dropped: {message}"
            );
            return Ok(false);
        }
        Err(format!("Subscription failed: {error}"))
    }

    /// Subscribe to TowerCabAircraft updates for an additional facility (additive).
    ///
    /// Supports multiple simultaneous subscriptions within the same CRC session.
    /// Does nothing if the facility is already subscribed or being subscribed.
    ///
    /// # Arguments
    /// * `facility_id` - ICAO code of the airport (e.g., "KBOS")
    #[tauri::command]
    pub async fn vnas_subscribe_facility(
        app: AppHandle,
        state: State<'_, VnasState>,
        facility_id: String,
    ) -> Result<(), String> {
        if subscribe_once(&app, &state, &facility_id).await? {
            tracing::info!(facility_id, "Subscribed to TowerCabAircraft");
        }
        Ok(())
    }

    /// Unsubscribe from a facility.
    ///
    /// Removes the facility from the subscribed list. Note that the SignalR
    /// subscription may still be active until the session is refreshed.
    ///
    /// # Arguments
    /// * `facility_id` - ICAO code of the airport (e.g., "KBOS")
    #[tauri::command]
    pub async fn vnas_unsubscribe_facility(
        app: AppHandle,
        state: State<'_, VnasState>,
        facility_id: String,
    ) -> Result<(), String> {
        let _ = state.remove_facility(&facility_id);

        // Emit updated subscriptions list
        let subscriptions = state.status().subscribed_facilities;
        cache_subscribed_facilities(&subscriptions);
        let _ = app.emit("vnas-subscriptions-changed", &subscriptions);

        tracing::info!(facility_id, "Unsubscribed from facility");

        Ok(())
    }

    /// Get currently subscribed facilities
    #[tauri::command]
    pub fn vnas_get_subscribed_facilities(state: State<'_, VnasState>) -> Vec<String> {
        state.status().subscribed_facilities
    }

    /// Disconnect from vNAS.
    #[tauri::command]
    pub async fn vnas_disconnect(
        app: AppHandle,
        state: State<'_, VnasState>,
    ) -> Result<(), String> {
        // Disconnect service if connected. The write guard is released before the
        // disconnect awaits, so no command queues behind it meanwhile. A failure is only
        // logged: the reset and the emits below run regardless.
        let service = state.service.write().await.take();
        if let Some(service) = service {
            if let Err(e) = service.disconnect().await {
                tracing::warn!("[vNAS] Disconnect failed: {e}");
            }
        }

        // The forwarder may not have emitted the service's final `Disconnected` yet, and
        // may still be draining queued events. Stop it before the reset, so no late state
        // lands after it, and announce the end of the session here instead.
        stop_event_forwarder(&state).await;

        // Reset status, dropping subscriptions and subscribes in flight; a connect still
        // in flight writes no status after this
        state.reset_for_disconnect();

        // Clear caches
        cache_state(SessionState::Disconnected);
        cache_subscribed_facilities(&[]);
        cache_session_facilities(&[]);

        // The forwarder may already have emitted the service's own `Disconnected`, so the
        // frontend can see it twice; both events are idempotent there.
        for event in session_change_events(SessionState::Disconnected, true) {
            emit_session_change(&app, event);
        }

        tracing::debug!("vNAS disconnected");
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

    /// Get the facility IDs available in the current session.
    ///
    /// These are the airports the user can subscribe to for 1Hz data,
    /// based on their CRC session's ARTCC and positions.
    /// Returns an empty list if not connected to a session.
    #[tauri::command]
    pub async fn vnas_get_session_facilities(
        state: State<'_, VnasState>,
    ) -> Result<Vec<String>, String> {
        let service = state
            .current_service()
            .await
            .ok_or_else(|| "vNAS service not initialized".to_string())?;

        let facilities = service.available_facilities().await;
        cache_session_facilities(&facilities);
        Ok(facilities)
    }

    /// Get the ARTCC ID for the current session.
    /// Returns None if not connected to a session.
    #[tauri::command]
    pub async fn vnas_get_session_artcc(
        state: State<'_, VnasState>,
    ) -> Result<Option<String>, String> {
        let service = state
            .current_service()
            .await
            .ok_or_else(|| "vNAS service not initialized".to_string())?;

        Ok(service.artcc_id().await)
    }

    /// Get the list of airport ICAOs that support 1Hz updates in the current session.
    ///
    /// This resolves the session's facilities (e.g., "NCT" TRACON) into their
    /// constituent airports (e.g., KSFO, KOAK, KSJC) using the vNAS Data API. A YAAT room
    /// session's airports are its position ids as given (e.g. "OAK"), with no lookup.
    /// Returns an empty list while no session is joined.
    #[tauri::command]
    pub async fn vnas_get_session_airports(
        state: State<'_, VnasState>,
    ) -> Result<Vec<String>, String> {
        let service = state
            .current_service()
            .await
            .ok_or_else(|| "vNAS service not initialized".to_string())?;

        // Only the airports are kept, and only while they belong to the session the host
        // holds: the join stored the token and kind, and the crate's current session may
        // already be newer than the one the host has applied.
        let Some(session) = service.session_airports().await else {
            cache_session_facilities(&[]);
            return Ok(Vec::new());
        };
        if !state.store_session_airports(session.session, session.airports.clone()) {
            tracing::debug!("[vNAS] Airports of a session the host does not hold; not cached");
        }
        Ok(session.airports)
    }

    /// Initialize vNAS state for Tauri app.
    /// Call this in the Tauri setup closure.
    pub fn init_vnas_state(app: &AppHandle) {
        app.manage(VnasState::new());
    }

    // =========================================================================
    // HELPER FUNCTIONS (for server.rs WebSocket handler)
    // =========================================================================

    /// Get the current vNAS state string synchronously (for WebSocket init message).
    /// Returns "disconnected" if not set.
    pub fn get_state_sync() -> String {
        CACHED_VNAS_STATE
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| "disconnected".to_string())
    }

    /// Get session facilities synchronously (for WebSocket init message).
    /// Returns the cached session facilities from the most recent fetch.
    pub fn get_session_facilities_sync() -> Vec<String> {
        CACHED_SESSION_FACILITIES
            .lock()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Get subscribed facilities synchronously (for WebSocket init message).
    /// Returns the cached subscribed facilities from the most recent state update.
    pub fn get_subscribed_facilities_sync() -> Vec<String> {
        CACHED_SUBSCRIBED_FACILITIES
            .lock()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    /// Subscribe to a facility internally (for WebSocket subscription requests).
    /// This is the async version that can be called from the WebSocket handler.
    pub async fn subscribe_facility_internal(
        app: &AppHandle,
        facility_id: &str,
    ) -> Result<(), String> {
        // Get the VnasState from Tauri's managed state
        let state = app.state::<VnasState>();

        if subscribe_once(app, &state, facility_id).await? {
            tracing::info!(
                facility_id,
                "Subscribed to TowerCabAircraft via remote request"
            );
        }

        Ok(())
    }

    /// Unsubscribe from a facility internally (for WebSocket unsubscription requests).
    /// This is the async version that can be called from the WebSocket handler.
    pub async fn unsubscribe_facility_internal(
        app: &AppHandle,
        facility_id: &str,
    ) -> Result<(), String> {
        // Get the VnasState from Tauri's managed state
        let state = app.state::<VnasState>();

        // Drop the subscription, or cancel a subscribe in flight
        if !state.remove_facility(facility_id) {
            tracing::debug!(
                facility_id,
                "Not subscribed to facility, nothing to unsubscribe"
            );
            return Ok(());
        }

        // Emit updated subscriptions list
        let subscriptions = state.status().subscribed_facilities;
        cache_subscribed_facilities(&subscriptions);
        let _ = app.emit("vnas-subscriptions-changed", &subscriptions);

        tracing::info!(facility_id, "Unsubscribed from facility via remote request");

        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn subscribed(state: &VnasState) -> Vec<String> {
            state.status().subscribed_facilities
        }

        fn claim(state: &VnasState, facility_id: &str) -> u64 {
            state
                .try_begin_subscribe(facility_id)
                .expect("facility should be claimable")
        }

        #[test]
        fn try_begin_subscribe_claims_a_facility_once() {
            let state = VnasState::new();
            assert!(state.try_begin_subscribe("OAK").is_some());
            assert!(state.try_begin_subscribe("OAK").is_none());
            assert!(state.try_begin_subscribe("SFO").is_some());
        }

        #[test]
        fn successful_subscribe_is_recorded_and_not_claimed_again() {
            let state = VnasState::new();
            let token = claim(&state, "OAK");
            assert!(state.finish_subscribe("OAK", token, true));
            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
            assert!(state.try_begin_subscribe("OAK").is_none());
        }

        #[test]
        fn failed_subscribe_releases_the_claim() {
            let state = VnasState::new();
            let token = claim(&state, "OAK");
            assert!(!state.finish_subscribe("OAK", token, false));
            assert!(subscribed(&state).is_empty());
            assert!(state.try_begin_subscribe("OAK").is_some());
        }

        #[test]
        fn unsubscribe_while_pending_wins_over_a_late_success() {
            let state = VnasState::new();
            let token = claim(&state, "OAK");
            assert!(state.remove_facility("OAK"));
            assert!(!state.finish_subscribe("OAK", token, true));
            assert!(subscribed(&state).is_empty());
            assert!(state.try_begin_subscribe("OAK").is_some());
        }

        #[test]
        fn pending_guard_releases_on_drop_and_records_on_succeed() {
            let state = VnasState::new();
            {
                let _pending = state.begin_subscribe("OAK").expect("first claim");
                assert!(state.begin_subscribe("OAK").is_none());
            }
            assert!(subscribed(&state).is_empty());

            let pending = state.begin_subscribe("OAK").expect("claim after release");
            assert!(pending.succeed());
            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
            assert!(state.begin_subscribe("OAK").is_none());
        }

        #[test]
        fn session_end_drops_subscriptions_and_subscribes_in_flight() {
            let state = VnasState::new();
            state.update_state(SessionState::Connected);
            let oak = claim(&state, "OAK");
            assert!(state.finish_subscribe("OAK", oak, true));
            let sfo = claim(&state, "SFO");

            assert!(state
                .status
                .write()
                .apply_session_state(SessionState::Disconnected));

            assert_eq!(state.status().state, SessionState::Disconnected);
            assert!(subscribed(&state).is_empty());
            assert!(!state.finish_subscribe("SFO", sfo, true));
            assert!(subscribed(&state).is_empty());
            assert!(state.try_begin_subscribe("OAK").is_some());
        }

        #[test]
        fn session_change_drops_subscribes_in_flight_and_the_session_token() {
            for new_state in [SessionState::Subscribing, SessionState::WaitingForSession] {
                let state = VnasState::new();
                let oak = claim(&state, "OAK");
                let generation = state.session_generation();

                assert!(
                    state.status.write().apply_session_state(new_state),
                    "{new_state:?}"
                );

                assert!(!state.finish_subscribe("OAK", oak, true));
                assert!(subscribed(&state).is_empty());
                assert_ne!(state.session_generation(), generation);
                assert_eq!(state.session_token(), None);
            }
        }

        #[test]
        fn new_service_forgets_the_session_kind() {
            let state = VnasState::new();
            state.status.write().session.kind = Some(SessionKind::Room);

            state.forget_session();

            assert_eq!(state.status().session_kind, None);
        }

        #[test]
        fn disconnect_forgets_the_session_kind() {
            let state = VnasState::new();
            state.status.write().session.kind = Some(SessionKind::Crc);

            state.reset_for_disconnect();

            assert_eq!(state.status().session_kind, None);
        }

        #[test]
        fn new_service_forgets_the_last_session_end() {
            let state = VnasState::new();
            state.update_status(|status| {
                status.last_session_end = Some(SessionEndInfo {
                    reason: "Removed from the room".to_string(),
                    forcible: true,
                });
            });
            let generation = state.session_generation();

            state.forget_session();

            assert_eq!(state.status().last_session_end, None);
            assert_ne!(state.session_generation(), generation);
        }

        #[test]
        fn other_session_states_keep_subscriptions() {
            let state = VnasState::new();
            let token = claim(&state, "OAK");
            assert!(state.finish_subscribe("OAK", token, true));

            assert!(!state
                .status
                .write()
                .apply_session_state(SessionState::Connected));

            assert_eq!(state.status().state, SessionState::Connected);
            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
        }

        #[test]
        fn dropping_a_cancelled_claim_keeps_the_newer_claim() {
            let state = VnasState::new();
            let stale = state.begin_subscribe("OAK").expect("claim A");
            assert!(state.remove_facility("OAK"));
            let current = state.begin_subscribe("OAK").expect("claim B");

            drop(stale);

            assert!(state.begin_subscribe("OAK").is_none());
            assert!(current.succeed());
            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
        }

        #[test]
        fn late_success_of_a_cancelled_claim_keeps_the_newer_claim() {
            let state = VnasState::new();
            let stale = state.begin_subscribe("OAK").expect("claim A");
            assert!(state.remove_facility("OAK"));
            let current = state.begin_subscribe("OAK").expect("claim B");

            assert!(!stale.succeed());

            assert!(subscribed(&state).is_empty());
            assert!(state.begin_subscribe("OAK").is_none());
            assert!(current.succeed());
            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
        }

        #[tokio::test]
        async fn replacing_the_event_forwarder_aborts_the_previous_one() {
            let state = VnasState::new();
            let (alive_tx, alive_rx) = tokio::sync::oneshot::channel::<()>();
            state.replace_event_forwarder(tokio::spawn(async move {
                let _alive = alive_tx;
                std::future::pending::<()>().await;
            }));

            state.replace_event_forwarder(tokio::spawn(std::future::pending::<()>()));

            // The aborted task drops its future, and with it the sender.
            let ended = tokio::time::timeout(std::time::Duration::from_secs(5), alive_rx).await;
            assert!(
                matches!(ended, Ok(Err(_))),
                "previous forwarder still running"
            );
        }

        #[tokio::test]
        async fn event_forwarder_continues_after_lag() {
            let (tx, events) = broadcast::channel(2);
            for i in 0..5 {
                tx.send(VnasEvent::AircraftDisconnected(format!("LAG{i}")))
                    .expect("send");
            }
            let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
            let forwarder = tokio::spawn(forward_events(
                events,
                move |event| {
                    if let VnasEvent::AircraftDisconnected(callsign) = event {
                        let _ = seen_tx.send(callsign);
                    }
                },
                || async {},
            ));

            let limit = std::time::Duration::from_secs(2);
            for expected in ["LAG3", "LAG4"] {
                let callsign = tokio::time::timeout(limit, seen.recv()).await;
                assert_eq!(callsign, Ok(Some(expected.to_string())));
            }
            tx.send(VnasEvent::AircraftDisconnected("AFTER".to_string()))
                .expect("the forwarder should still be receiving after the lag");
            let callsign = tokio::time::timeout(limit, seen.recv()).await;
            assert_eq!(callsign, Ok(Some("AFTER".to_string())));

            drop(tx);
            tokio::time::timeout(limit, forwarder)
                .await
                .expect("the forwarder should return once the sender is dropped")
                .expect("forwarder task");
        }

        #[test]
        fn update_status_applies_changes() {
            let state = VnasState::new();
            state.set_error(Some("old".to_string()));

            state.update_status(|status| {
                status.subscribed_facilities.push("OAK".to_string());
                status.error = None;
            });

            assert_eq!(subscribed(&state), vec!["OAK".to_string()]);
            assert_eq!(state.status().error, None);
        }

        #[test]
        fn update_status_if_epoch_refuses_after_disconnect_reset() {
            let state = VnasState::new();
            let epoch = state.connect_epoch();
            let connecting = |status: &mut VnasStatus| status.state = SessionState::Connecting;
            assert!(state.update_status_if_epoch(epoch, connecting));

            state.reset_for_disconnect();

            assert!(!state.update_status_if_epoch(epoch, connecting));
            assert_eq!(state.status().state, SessionState::Disconnected);
            assert!(state.update_status_if_epoch(state.connect_epoch(), connecting));
        }
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

    /// Try to restore a vNAS session from stored tokens (stub)
    #[tauri::command]
    pub async fn vnas_try_restore_session(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _environment: Environment,
    ) -> Result<bool, String> {
        // Feature not available, no tokens to restore
        Ok(false)
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

    /// Sign in to a local YAAT development server (stub)
    #[tauri::command]
    pub async fn vnas_yaat_local_sign_in(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _yaat_local_url: String,
        _cid: Option<String>,
    ) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Complete the OAuth flow (stub)
    #[tauri::command]
    pub async fn vnas_complete_auth(_state: State<'_, VnasState>) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Handle OAuth callback from deep link (stub)
    #[tauri::command]
    pub async fn vnas_handle_oauth_callback(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _callback_url: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Connect to vNAS (stub)
    #[tauri::command]
    pub async fn vnas_connect(_state: State<'_, VnasState>) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Subscribe to additional facility (stub)
    #[tauri::command]
    pub async fn vnas_subscribe_facility(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _facility_id: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Unsubscribe from a facility (stub)
    #[tauri::command]
    pub async fn vnas_unsubscribe_facility(
        _app: AppHandle,
        _state: State<'_, VnasState>,
        _facility_id: String,
    ) -> Result<(), String> {
        Ok(()) // No-op, always succeeds
    }

    /// Get currently subscribed facilities (stub)
    #[tauri::command]
    pub fn vnas_get_subscribed_facilities(_state: State<'_, VnasState>) -> Vec<String> {
        Vec::new()
    }

    /// Disconnect from vNAS (stub)
    #[tauri::command]
    pub async fn vnas_disconnect(
        _app: AppHandle,
        _state: State<'_, VnasState>,
    ) -> Result<(), String> {
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

    /// Get the facility IDs available in the current session (stub)
    #[tauri::command]
    pub async fn vnas_get_session_facilities(
        _state: State<'_, VnasState>,
    ) -> Result<Vec<String>, String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Get the ARTCC ID for the current session (stub)
    #[tauri::command]
    pub async fn vnas_get_session_artcc(
        _state: State<'_, VnasState>,
    ) -> Result<Option<String>, String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Get the session airports (stub)
    #[tauri::command]
    pub async fn vnas_get_session_airports(
        _state: State<'_, VnasState>,
    ) -> Result<Vec<String>, String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Initialize vNAS state for Tauri app (stub)
    pub fn init_vnas_state(app: &AppHandle) {
        app.manage(VnasState::new());
        tracing::info!("[vNAS] State initialized (stub - feature not enabled)");
    }

    // =========================================================================
    // HELPER FUNCTIONS (stubs for server.rs WebSocket handler)
    // =========================================================================

    /// Get the current vNAS state string synchronously (stub).
    pub fn get_state_sync() -> String {
        "disconnected".to_string()
    }

    /// Get session facilities synchronously (stub).
    pub fn get_session_facilities_sync() -> Vec<String> {
        Vec::new()
    }

    /// Get subscribed facilities synchronously (stub).
    pub fn get_subscribed_facilities_sync() -> Vec<String> {
        Vec::new()
    }

    /// Subscribe to a facility internally (stub).
    pub async fn subscribe_facility_internal(
        _app: &AppHandle,
        _facility_id: &str,
    ) -> Result<(), String> {
        Err(UNAVAILABLE_MSG.to_string())
    }

    /// Unsubscribe from a facility internally (stub).
    pub async fn unsubscribe_facility_internal(
        _app: &AppHandle,
        _facility_id: &str,
    ) -> Result<(), String> {
        Ok(()) // No-op, always succeeds
    }
}

// =============================================================================
// RE-EXPORTS (use the appropriate implementation based on feature)
// =============================================================================

#[cfg(feature = "vnas")]
pub use real_impl::*;

#[cfg(not(feature = "vnas"))]
pub use stub_impl::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_required_false_means_available() {
        assert!(yaat_local_auth_not_required(r#"{"required":false}"#).is_ok());
    }

    #[test]
    fn auth_required_true_missing_or_bad_json_means_unavailable() {
        assert!(yaat_local_auth_not_required(r#"{"required":true}"#).is_err());
        assert!(yaat_local_auth_not_required(r#"{"other":false}"#).is_err());
        assert!(yaat_local_auth_not_required(r#"{"required":"false"}"#).is_err());
        assert!(yaat_local_auth_not_required("not json").is_err());
        assert!(yaat_local_auth_not_required("").is_err());
    }

    #[test]
    fn probe_base_accepts_http_and_https_and_trims_trailing_slash() {
        assert_eq!(
            yaat_local_probe_base("http://localhost:5000/"),
            Ok("http://localhost:5000".to_string())
        );
        assert_eq!(
            yaat_local_probe_base("https://yaat.example"),
            Ok("https://yaat.example".to_string())
        );
    }

    #[test]
    fn probe_base_rejects_other_schemes_and_garbage() {
        assert!(yaat_local_probe_base("ftp://localhost:5000").is_err());
        assert!(yaat_local_probe_base("not a url").is_err());
        assert!(yaat_local_probe_base("").is_err());
    }

    #[test]
    fn url_without_query_drops_the_code() {
        let redacted = url_without_query("tc3d://oauth/callback?code=SECRET123&state=s");
        assert_eq!(redacted, "tc3d://oauth/callback");
        assert!(!redacted.contains("SECRET123"));

        let query_then_fragment = url_without_query("tc3d://oauth/callback?code=SECRET#frag");
        assert_eq!(query_then_fragment, "tc3d://oauth/callback");
        assert!(!query_then_fragment.contains("SECRET"));

        let fragment_then_query = url_without_query("tc3d://oauth/callback#a?code=SECRET");
        assert_eq!(fragment_then_query, "tc3d://oauth/callback");
        assert!(!fragment_then_query.contains("SECRET"));
    }

    #[test]
    fn url_without_query_drops_a_fragment() {
        assert_eq!(
            url_without_query("tc3d://oauth/callback#code=X"),
            "tc3d://oauth/callback"
        );
    }

    #[test]
    fn url_without_query_keeps_a_plain_url() {
        assert_eq!(
            url_without_query("tc3d://oauth/callback"),
            "tc3d://oauth/callback"
        );
        assert_eq!(url_without_query(""), "");
    }

    fn subscribed_status(facilities: &[&str]) -> VnasStatus {
        VnasStatus {
            state: SessionState::Connected,
            subscribed_facilities: facilities.iter().map(|f| f.to_string()).collect(),
            error: None,
            ..VnasStatus::default()
        }
    }

    fn session_end(reason: &str, forcible: bool) -> Option<SessionEndInfo> {
        Some(SessionEndInfo {
            reason: reason.to_string(),
            forcible,
        })
    }

    #[test]
    fn session_change_clears_subscriptions_on_subscribing_and_waiting() {
        for new_state in [
            SessionState::Subscribing,
            SessionState::WaitingForSession,
            SessionState::Disconnected,
        ] {
            let mut status = subscribed_status(&["OAK"]);
            assert!(
                apply_session_change(&mut status, new_state),
                "{new_state:?}"
            );
            assert_eq!(status.state, new_state);
            assert!(status.subscribed_facilities.is_empty(), "{new_state:?}");
        }
        for new_state in [SessionState::Connected, SessionState::JoiningSession] {
            let mut status = subscribed_status(&["OAK"]);
            assert!(
                !apply_session_change(&mut status, new_state),
                "{new_state:?}"
            );
            assert_eq!(status.subscribed_facilities, vec!["OAK".to_string()]);
        }
    }

    #[test]
    fn stale_token_or_own_disconnect_sets_no_error() {
        let cases = [
            (
                SubscribeFailure::StaleSession,
                false,
                SubscribeOutcome::ForgetToken,
            ),
            (
                SubscribeFailure::StaleSession,
                true,
                SubscribeOutcome::ForgetToken,
            ),
            (SubscribeFailure::Failed, true, SubscribeOutcome::Ignore),
            (
                SubscribeFailure::NotConnected,
                true,
                SubscribeOutcome::Ignore,
            ),
        ];
        for (failure, disconnecting, outcome) in cases {
            let mut status = subscribed_status(&["OAK"]);
            let settled = settle_subscribe_failure(&mut status, failure, disconnecting, "boom");
            assert_eq!(
                settled, outcome,
                "{failure:?}, disconnecting {disconnecting}"
            );
            assert_eq!(
                status.error, None,
                "{failure:?}, disconnecting {disconnecting}"
            );
        }

        let mut status = subscribed_status(&["OAK"]);
        let settled =
            settle_subscribe_failure(&mut status, SubscribeFailure::Failed, false, "boom");
        assert_eq!(settled, SubscribeOutcome::ShowError);
        assert_eq!(status.error, Some("boom".to_string()));
    }

    #[test]
    fn not_connected_after_forced_end_keeps_the_kick_reason() {
        let mut status = subscribed_status(&["OAK"]);
        status.last_session_end = session_end("Removed from the room", true);
        apply_session_change(&mut status, SessionState::Disconnected);
        assert!(apply_forced_end_error(
            &mut status,
            Some("Removed from the room".to_string())
        ));

        let settled = settle_subscribe_failure(
            &mut status,
            SubscribeFailure::NotConnected,
            false,
            "Not connected",
        );

        assert_eq!(settled, SubscribeOutcome::Ignore);
        assert_eq!(status.error, Some("Removed from the room".to_string()));
    }

    #[test]
    fn forcible_end_reason_kept_until_next_connect() {
        let mut status = subscribed_status(&["OAK"]);
        status.last_session_end = session_end("Removed from the room", true);
        apply_session_change(&mut status, SessionState::Disconnected);
        assert!(apply_forced_end_error(
            &mut status,
            Some("Removed from the room".to_string())
        ));

        apply_session_change(&mut status, SessionState::WaitingForSession);
        apply_session_change(&mut status, SessionState::Subscribing);
        assert_eq!(
            status.last_session_end,
            session_end("Removed from the room", true)
        );

        apply_connect_state(&mut status, SessionState::Connecting, None);
        assert_eq!(status.last_session_end, None);
        assert_eq!(status.error, None);
        assert!(!apply_forced_end_error(
            &mut status,
            Some("Removed from the room".to_string())
        ));
        assert_eq!(status.error, None);
    }

    #[test]
    fn forced_end_error_needs_a_forcible_end_and_a_reason() {
        let mut status = subscribed_status(&[]);
        status.last_session_end = session_end("Room closed", false);
        assert!(!apply_forced_end_error(
            &mut status,
            Some("Room closed".to_string())
        ));
        status.last_session_end = session_end("Removed from the room", true);
        assert!(!apply_forced_end_error(&mut status, None));
        assert_eq!(status.error, None);
    }

    #[test]
    fn room_end_reason_cleared_on_next_subscribing() {
        let mut status = subscribed_status(&["OAK"]);
        status.last_session_end = session_end("Room closed", false);
        status.error = Some("SignalR connection error: join refused".to_string());

        apply_session_change(&mut status, SessionState::WaitingForSession);
        assert_eq!(status.last_session_end, session_end("Room closed", false));

        apply_session_change(&mut status, SessionState::Subscribing);
        assert_eq!(status.last_session_end, None);
        assert_eq!(status.error, None);
    }

    #[test]
    fn connect_failure_keeps_its_error() {
        let mut status = subscribed_status(&[]);
        apply_connect_state(
            &mut status,
            SessionState::Disconnected,
            Some("boom".to_string()),
        );
        assert_eq!(status.error, Some("boom".to_string()));
        apply_connect_state(&mut status, SessionState::Subscribing, None);
        assert_eq!(status.error, Some("boom".to_string()));
    }

    #[test]
    fn session_change_announces_the_state_before_the_cleared_subscriptions() {
        // The frontend clears its session airports and raises the follow on the state, so
        // the subscribe effects the cleared list re-runs find nothing of the old session
        assert_eq!(
            session_change_events(SessionState::Subscribing, true),
            vec![
                SessionChangeEvent::State(SessionState::Subscribing),
                SessionChangeEvent::SubscriptionsCleared,
            ]
        );
        assert_eq!(
            session_change_events(SessionState::Disconnected, true),
            vec![
                SessionChangeEvent::State(SessionState::Disconnected),
                SessionChangeEvent::SubscriptionsCleared,
            ]
        );
        assert_eq!(
            session_change_events(SessionState::Connected, false),
            vec![SessionChangeEvent::State(SessionState::Connected)]
        );
    }

    #[test]
    fn session_kind_reaches_the_frontend_as_crc_room_or_null() {
        let mut status = subscribed_status(&["OAK"]);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["sessionKind"], serde_json::Value::Null);

        status.session_kind = Some(SessionKind::Room);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["sessionKind"], "room");

        status.session_kind = Some(SessionKind::Crc);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["sessionKind"], "crc");
    }

    #[test]
    fn session_kind_cleared_whenever_the_session_changes() {
        for new_state in [
            SessionState::Subscribing,
            SessionState::WaitingForSession,
            SessionState::Disconnected,
        ] {
            let mut status = subscribed_status(&["OAK"]);
            let mut cell = SessionCell::<u64>::default();
            cell.join(7, SessionKind::Room);
            apply_session_change_with_cell(&mut status, &mut cell, new_state);
            assert_eq!(cell.kind(), None, "{new_state:?}");
        }
        for new_state in [SessionState::Connected, SessionState::JoiningSession] {
            let mut status = subscribed_status(&["OAK"]);
            let mut cell = SessionCell::<u64>::default();
            cell.join(7, SessionKind::Room);
            apply_session_change_with_cell(&mut status, &mut cell, new_state);
            assert_eq!(cell.kind(), Some(SessionKind::Room), "{new_state:?}");
        }
    }

    #[test]
    fn session_cell_join_replaces_the_older_session() {
        let mut cell = SessionCell::<u64>::default();
        let before = cell.join(7, SessionKind::Room);
        assert!(cell.store_airports(before, vec!["OAK".to_string()]));

        let after = cell.join(8, SessionKind::Crc);

        assert_eq!(cell.token(), Some(8));
        assert_eq!(cell.kind(), Some(SessionKind::Crc));
        assert!(cell.airports().is_empty());
        assert!(!cell.store_joined(before, 7, SessionKind::Room));
        assert!(!cell.store_airports(before, vec!["OAK".to_string()]));
        assert_eq!(cell.token(), Some(8));
        assert!(cell.airports().is_empty());
        assert_eq!(after, cell.generation());
    }

    #[test]
    fn session_cell_refuses_a_join_stored_after_a_bump() {
        let mut cell = SessionCell::<u64>::default();
        let generation = cell.generation();

        cell.bump();

        assert!(!cell.store_joined(generation, 7, SessionKind::Room));
        assert_eq!(cell.token(), None);
        assert_eq!(cell.kind(), None);
        assert!(cell.store_joined(cell.generation(), 8, SessionKind::Crc));
        assert_eq!(cell.token(), Some(8));
        assert_eq!(cell.kind(), Some(SessionKind::Crc));
    }

    #[test]
    fn session_cell_refuses_airports_from_an_older_generation() {
        let mut cell = SessionCell::<u64>::default();
        let generation = cell.generation();
        assert!(cell.store_joined(generation, 7, SessionKind::Crc));

        cell.forget();
        cell.bump();

        assert!(!cell.store_airports(generation, vec!["KOAK".to_string()]));
        assert!(cell.airports().is_empty());
        assert!(cell.store_airports(cell.generation(), vec!["KSFO".to_string()]));
        assert_eq!(cell.airports(), ["KSFO".to_string()]);
    }

    #[test]
    fn begin_connect_refuses_a_second_connect() {
        let mut cell = StatusCell::<u64>::default();
        let first = cell.begin_connect().expect("the first connect starts");
        assert_eq!(cell.status.state, SessionState::Connecting);

        assert_eq!(cell.begin_connect(), None);

        assert_eq!(cell.connect_epoch, first);
        assert_eq!(cell.status.state, SessionState::Connecting);
    }

    #[test]
    fn old_epoch_write_is_refused_after_a_newer_connect() {
        let mut cell = StatusCell::<u64>::default();
        let old = cell.begin_connect().expect("the first connect starts");
        let failed = |c: &mut StatusCell<u64>| {
            apply_connect_state(
                &mut c.status,
                SessionState::Disconnected,
                Some("boom".to_string()),
            );
        };
        assert!(cell.if_epoch(old, failed).is_some());
        let new = cell
            .begin_connect()
            .expect("a connect after the failure starts");

        // The first connect's forwarder, still draining, reports a join.
        let joined = cell.if_epoch(old, |c| c.apply_session_state(SessionState::Subscribing));

        assert_eq!(joined, None);
        assert_eq!(cell.status.state, SessionState::Connecting);
        let joined = cell.if_epoch(new, |c| c.apply_session_state(SessionState::Subscribing));
        assert_eq!(joined, Some(true));
        assert_eq!(cell.status.state, SessionState::Subscribing);
    }

    #[test]
    fn old_epoch_write_is_refused_after_disconnect() {
        let mut cell = StatusCell::<u64>::default();
        let epoch = cell.begin_connect().expect("the connect starts");

        cell.reset_for_disconnect();

        let joined = cell.if_epoch(epoch, |c| c.apply_session_state(SessionState::Subscribing));
        assert_eq!(joined, None);
        assert_eq!(cell.status.state, SessionState::Disconnected);
    }

    /// Write what a connect's result writes (`connect_result_write`) into `status`.
    fn write_connect_result(status: &mut VnasStatus, outcome: ConnectOutcome) {
        if let Some((new_state, error)) = connect_result_write(outcome) {
            apply_connect_state(status, new_state, error);
        }
    }

    #[test]
    fn connect_result_never_writes_over_connected() {
        // The forwarder applied the join and the subscribe before the connect returned.
        let mut status = subscribed_status(&[]);
        status.state = SessionState::Connecting;
        apply_session_change(&mut status, SessionState::Subscribing);
        apply_session_change(&mut status, SessionState::Connected);
        write_connect_result(&mut status, ConnectOutcome::Connected);
        assert_eq!(status.state, SessionState::Connected);

        // The connect returned between the join and the subscribe.
        let mut status = subscribed_status(&[]);
        status.state = SessionState::Connecting;
        apply_session_change(&mut status, SessionState::Subscribing);
        write_connect_result(&mut status, ConnectOutcome::Connected);
        apply_session_change(&mut status, SessionState::Connected);
        assert_eq!(status.state, SessionState::Connected);
    }

    #[test]
    fn connect_result_writes_only_a_failure() {
        assert_eq!(connect_result_write(ConnectOutcome::Cancelled), None);
        assert_eq!(
            connect_result_write(ConnectOutcome::Failed("boom".to_string())),
            Some((SessionState::Disconnected, Some("boom".to_string())))
        );
    }

    #[tokio::test]
    async fn lag_applies_retained_events_then_resyncs_once_then_continues() {
        let (tx, events) = tokio::sync::broadcast::channel::<u32>(2);
        for event in 0..5 {
            tx.send(event).expect("send");
        }
        let log = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let handled = std::sync::Arc::clone(&log);
        let resynced = std::sync::Arc::clone(&log);
        // The re-sync sends one more event and drops the last sender, so the forwarder
        // returns once it has applied that event.
        let mut late = Some(tx);
        let forwarder = forward_events(
            events,
            move |event| handled.lock().push(format!("event {event}")),
            move || {
                let log = std::sync::Arc::clone(&resynced);
                let sender = late.take();
                async move {
                    log.lock().push("resync".to_string());
                    if let Some(sender) = sender {
                        sender
                            .send(5)
                            .expect("the forwarder should still be receiving");
                    }
                }
            },
        );

        tokio::time::timeout(std::time::Duration::from_secs(10), forwarder)
            .await
            .expect("the forwarder hung instead of returning once the sender was dropped");

        assert_eq!(
            *log.lock(),
            ["event 3", "event 4", "resync", "event 5"].map(String::from)
        );
    }

    #[test]
    fn resync_rejoins_when_the_crate_joined_another_session() {
        let resync = resync_action(
            SessionState::Connected,
            Some(7_u64),
            SessionState::Subscribing,
            Some((8, SessionKind::Room)),
            None,
        );
        let rejoin = ResyncChange::Rejoin {
            state: SessionState::Subscribing,
            session: Some((8, SessionKind::Room)),
        };
        assert_eq!(resync.change, rejoin);
        assert_eq!(resync.forced_end, None);
    }

    #[test]
    fn resync_drops_the_session_the_crate_no_longer_has() {
        let resync = resync_action(
            SessionState::Connected,
            Some(7_u64),
            SessionState::WaitingForSession,
            None,
            None,
        );
        let rejoin = ResyncChange::Rejoin {
            state: SessionState::WaitingForSession,
            session: None,
        };
        assert_eq!(resync.change, rejoin);
    }

    #[test]
    fn resync_never_moves_the_same_session_backwards() {
        let joined = Some((7_u64, SessionKind::Crc));
        let behind = resync_action(
            SessionState::Connected,
            Some(7),
            SessionState::Subscribing,
            joined,
            None,
        );
        assert_eq!(behind.change, ResyncChange::Keep);

        let ahead = resync_action(
            SessionState::Subscribing,
            Some(7),
            SessionState::Connected,
            joined,
            None,
        );
        assert_eq!(ahead.change, ResyncChange::Advance(SessionState::Connected));
    }

    #[test]
    fn resync_restores_a_missed_kick_reason() {
        let reason = "Removed from the room".to_string();
        let resync = resync_action(
            SessionState::Connected,
            Some(7_u64),
            SessionState::Disconnected,
            None,
            Some(reason.clone()),
        );
        let rejoin = ResyncChange::Rejoin {
            state: SessionState::Disconnected,
            session: None,
        };
        assert_eq!(resync.change, rejoin);
        assert_eq!(resync.forced_end, Some(reason));
    }

    #[test]
    fn airports_of_an_older_session_are_not_cached() {
        let mut cell = SessionCell::<u64>::default();
        cell.join(7, SessionKind::Crc);
        cell.join(8, SessionKind::Room);

        assert!(!cell.store_airports_of(7, vec!["KOAK".to_string()]));
        assert!(cell.airports().is_empty());
        assert!(cell.store_airports_of(8, vec!["OAK".to_string()]));
        assert_eq!(cell.airports(), ["OAK".to_string()]);

        cell.end();
        assert!(!cell.store_airports_of(8, vec!["OAK".to_string()]));
        assert!(cell.airports().is_empty());
    }

    #[test]
    fn airports_of_another_session_under_the_same_generation_are_not_cached() {
        let mut cell = SessionCell::<u64>::default();
        let generation = cell.join(7, SessionKind::Crc);

        // The service has joined session 8 already; the host has not applied it yet.
        assert!(!cell.store_airports_of_session(generation, 8, vec!["KSFO".to_string()]));

        assert!(cell.airports().is_empty());
        assert!(cell.store_airports_of_session(generation, 7, vec!["KOAK".to_string()]));
        assert_eq!(cell.airports(), ["KOAK".to_string()]);
    }

    /// A status cell in `state` holding session 7, with `facilities` subscribed and a
    /// subscribe for KSFO in flight; also returns the generation session 7 was joined under.
    fn cell_in_session(state: SessionState, facilities: &[&str]) -> (StatusCell<u64>, u64) {
        let mut cell = StatusCell::<u64> {
            status: VnasStatus {
                state,
                ..subscribed_status(facilities)
            },
            ..StatusCell::default()
        };
        let generation = cell.session.join(7, SessionKind::Crc);
        cell.pending_subscribes.insert("KSFO".to_string(), 1);
        (cell, generation)
    }

    #[test]
    fn resync_to_a_new_session_clears_the_old_one_and_stores_the_new_one() {
        let (mut cell, old_generation) = cell_in_session(SessionState::Connected, &["KOAK"]);
        let resync = resync_action(
            cell.status.state,
            cell.session.token(),
            SessionState::Subscribing,
            Some((8, SessionKind::Room)),
            None,
        );

        let writes = cell.apply_resync(resync);

        assert!(cell.status.subscribed_facilities.is_empty());
        assert!(cell.pending_subscribes.is_empty());
        assert_eq!(cell.status.state, SessionState::Subscribing);
        assert_eq!(cell.session.token(), Some(8));
        assert_eq!(cell.session.kind(), Some(SessionKind::Room));
        let generation = writes
            .joined_generation
            .expect("the new session's generation");
        let airports = vec!["OAK".to_string()];
        assert!(!cell
            .session
            .store_airports_of_session(old_generation, 8, airports.clone()));
        assert!(cell
            .session
            .store_airports_of_session(generation, 8, airports));
        assert_eq!(writes.new_state, Some(SessionState::Subscribing));
        assert!(writes.dropped);
        assert_eq!(
            writes.events,
            vec![
                SessionChangeEvent::State(SessionState::Subscribing),
                SessionChangeEvent::SubscriptionsCleared,
            ]
        );
        assert_eq!(writes.forced_error, None);
    }

    #[test]
    fn resync_within_the_same_session_never_moves_backwards() {
        let joined = Some((7_u64, SessionKind::Crc));
        let (mut cell, _) = cell_in_session(SessionState::Connected, &["KOAK"]);
        let behind = resync_action(
            cell.status.state,
            cell.session.token(),
            SessionState::Subscribing,
            joined,
            None,
        );

        let writes = cell.apply_resync(behind);

        assert_eq!(cell.status.state, SessionState::Connected);
        assert_eq!(cell.status.subscribed_facilities, ["KOAK".to_string()]);
        assert_eq!(writes.new_state, None);
        assert!(writes.events.is_empty());

        let (mut cell, _) = cell_in_session(SessionState::Subscribing, &["KOAK"]);
        let ahead = resync_action(
            cell.status.state,
            cell.session.token(),
            SessionState::Connected,
            joined,
            None,
        );

        let writes = cell.apply_resync(ahead);

        assert_eq!(cell.status.state, SessionState::Connected);
        assert_eq!(cell.status.subscribed_facilities, ["KOAK".to_string()]);
        assert_eq!(cell.session.token(), Some(7));
        assert!(!writes.dropped);
        assert_eq!(
            writes.events,
            vec![SessionChangeEvent::State(SessionState::Connected)]
        );
    }

    #[test]
    fn resync_shows_a_forced_end_reason_once() {
        let reason = "Removed from the room".to_string();
        let (mut cell, _) = cell_in_session(SessionState::Connected, &["KOAK"]);
        let kicked = |cell: &StatusCell<u64>| {
            resync_action(
                cell.status.state,
                cell.session.token(),
                SessionState::Disconnected,
                None,
                Some(reason.clone()),
            )
        };

        let first = cell.apply_resync(kicked(&cell));

        assert_eq!(first.forced_error, Some(reason.clone()));
        assert_eq!(cell.status.error, Some(reason.clone()));
        assert_eq!(cell.status.last_session_end, session_end(&reason, true));

        let second = cell.apply_resync(kicked(&cell));

        assert_eq!(second.forced_error, None);
        assert_eq!(cell.status.error, Some(reason.clone()));
    }

    #[test]
    fn dropping_change_clears_session_facilities() {
        assert_eq!(
            caches_cleared_by(true),
            [SessionCache::Subscribed, SessionCache::SessionFacilities]
        );
        assert!(caches_cleared_by(false).is_empty());
    }

    #[test]
    fn session_cell_forget_clears_token_kind_and_airports() {
        let mut cell = SessionCell::<u64>::default();
        let generation = cell.generation();
        assert!(cell.store_joined(generation, 7, SessionKind::Room));
        assert!(cell.store_airports(generation, vec!["OAK".to_string()]));

        cell.forget();

        assert_eq!(cell.token(), None);
        assert_eq!(cell.kind(), None);
        assert!(cell.airports().is_empty());
    }
}
