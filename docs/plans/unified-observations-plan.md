# Unified Observation Broadcasting & Multi-Subscription vNAS

## Overview

This plan unifies the data flow architecture so that:
1. Remote browsers receive observations from the host (not polling independently)
2. Insets and remote clients use the same observation format
3. vNAS supports multiple simultaneous facility subscriptions
4. Remote clients can trigger vNAS subscriptions for their viewed airports

## Current State

| Client Type | VATSIM | vNAS | RealTraffic |
|-------------|--------|------|-------------|
| Main app | Direct poll (15s) | Tauri events | Direct WebSocket |
| Insets | SharedWorker broadcast | SharedWorker broadcast | SharedWorker broadcast |
| Remote browser | Polls via CORS proxy | ❌ Unavailable | ❌ Unavailable |

## Target State

| Client Type | All Data Sources |
|-------------|------------------|
| Main app | Collects from all sources → Timeline Store |
| Insets | SharedWorker broadcast from main |
| Remote browser | WebSocket broadcast from host |
| Remote browser insets | SharedWorker broadcast from remote main |

---

## Phase 1: Multi-Subscription vNAS Support

### 1.1 Update VnasStatus (Rust)

**File: `src-tauri/src/vnas.rs`**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VnasStatus {
    pub state: SessionState,
    pub environment: Environment,
    pub subscribed_facilities: Vec<String>,  // Changed from Option<String>
    pub error: Option<String>,
    pub available: bool,
}
```

### 1.2 Update VnasState Methods (Rust)

```rust
impl VnasState {
    pub fn add_facility(&self, facility_id: String) {
        let mut status = self.status.write();
        if !status.subscribed_facilities.contains(&facility_id) {
            status.subscribed_facilities.push(facility_id);
        }
    }

    pub fn remove_facility(&self, facility_id: &str) {
        let mut status = self.status.write();
        status.subscribed_facilities.retain(|f| f != facility_id);
    }

    pub fn clear_facilities(&self) {
        self.status.write().subscribed_facilities.clear();
    }
}
```

### 1.3 New Tauri Commands (Rust)

**File: `src-tauri/src/vnas.rs`**

```rust
/// Subscribe to an additional facility (additive, doesn't replace existing)
#[tauri::command]
pub async fn vnas_subscribe_facility(
    app: AppHandle,
    state: State<'_, VnasState>,
    facility_id: String,
) -> Result<(), String> {
    // Check if already subscribed
    if state.status().subscribed_facilities.contains(&facility_id) {
        return Ok(());
    }

    let service_guard = state.service.read().await;
    let service = service_guard
        .as_ref()
        .ok_or("Not connected")?;

    service
        .subscribe_towercab(&facility_id)
        .await
        .map_err(|e| format!("Subscription failed: {}", e))?;

    state.add_facility(facility_id.clone());

    // Emit updated status
    let _ = app.emit("vnas-subscriptions-changed", state.status().subscribed_facilities.clone());

    Ok(())
}

/// Get currently subscribed facilities
#[tauri::command]
pub fn vnas_get_subscribed_facilities(state: State<'_, VnasState>) -> Vec<String> {
    state.status().subscribed_facilities.clone()
}
```

### 1.4 Update Existing vnas_subscribe

Keep for backwards compatibility but document it subscribes to a single facility:

```rust
/// Subscribe to TowerCabAircraft updates for a facility.
/// Note: For multiple subscriptions, use vnas_subscribe_facility instead.
#[tauri::command]
pub async fn vnas_subscribe(
    app: AppHandle,
    state: State<'_, VnasState>,
    facility_id: String,
) -> Result<(), String> {
    // Clear existing and subscribe to new
    state.clear_facilities();
    vnas_subscribe_facility(app, state, facility_id).await
}
```

### 1.5 Frontend vnasStore Updates

**File: `src/renderer/stores/vnasStore.ts`**

```typescript
interface VnasStore {
  // ... existing fields

  // Change from single facility to list
  subscribedFacilities: string[]

  // New actions
  subscribeToFacility: (facilityId: string) => Promise<void>
  unsubscribeFromFacility: (facilityId: string) => Promise<void>
  getSubscribedFacilities: () => string[]
}
```

### 1.6 Update VnasStatus Type

**File: `src/renderer/types/vnas.ts`**

```typescript
export interface VnasStatus {
  state: VnasSessionState
  environment: VnasEnvironment
  subscribedFacilities: string[]  // Changed from facilityId?: string
  error: string | null
  available: boolean
}
```

---

## Phase 2: Unified Observation WebSocket

### 2.1 Observation Message Types (Rust)

**File: `src-tauri/src/server.rs`**

```rust
/// Observation data broadcast to remote clients
#[derive(Debug, Clone, Serialize)]
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
    pub source: String,  // "vatsim" | "vnas" | "realtraffic"
    pub observed_at: u64,
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
    #[serde(rename = "observations")]
    Observations { data: Vec<ObservationData> },

    #[serde(rename = "removals")]
    Removals { callsigns: Vec<String> },

    #[serde(rename = "subscriptions")]
    Subscriptions { facilities: Vec<String> },
}
```

### 2.2 Observation Broadcast Channel (Rust)

**File: `src-tauri/src/lib.rs`**

```rust
static OBSERVATIONS_TX: Mutex<Option<broadcast::Sender<ObservationMessage>>> = Mutex::new(None);

pub fn broadcast_observations(message: ObservationMessage) {
    if let Ok(guard) = OBSERVATIONS_TX.lock() {
        if let Some(ref tx) = *guard {
            let _ = tx.send(message);
        }
    }
}
```

### 2.3 WebSocket Endpoint (Rust)

**File: `src-tauri/src/server.rs`**

```rust
// Add route
.route("/api/observations/ws", get(observations_websocket_handler))

async fn observations_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_observations_websocket(socket, state))
}

async fn handle_observations_websocket(socket: WebSocket, state: Arc<ServerState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut obs_rx = state.observations_tx.subscribe();

    tracing::info!("[Observations WS] Client connected");

    // Send current vNAS subscriptions on connect
    let subscriptions = get_vnas_subscribed_facilities();
    if !subscriptions.is_empty() {
        let msg = ObservationMessage::Subscriptions { facilities: subscriptions };
        let _ = sender.send(Message::Text(serde_json::to_string(&msg).unwrap())).await;
    }

    // Forward observations to WebSocket
    let send_task = tokio::spawn(async move {
        while let Ok(message) = obs_rx.recv().await {
            match serde_json::to_string(&message) {
                Ok(json) => {
                    if sender.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Err(e) => tracing::error!("[Observations WS] Serialize error: {}", e),
            }
        }
    });

    // Handle incoming messages (subscription requests from remote clients)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Handle subscription requests from remote clients
                if let Ok(request) = serde_json::from_str::<SubscriptionRequest>(&text) {
                    handle_subscription_request(request).await;
                }
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }

    send_task.abort();
    tracing::info!("[Observations WS] Client disconnected");
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionRequest {
    action: String,  // "subscribe" | "unsubscribe"
    facility_id: String,
}

async fn handle_subscription_request(request: SubscriptionRequest) {
    match request.action.as_str() {
        "subscribe" => {
            // Subscribe if within allowed facilities
            let allowed = vnas_get_session_facilities().await.unwrap_or_default();
            if allowed.contains(&request.facility_id) {
                let _ = vnas_subscribe_facility_internal(&request.facility_id).await;
            }
        }
        "unsubscribe" => {
            // Could implement unsubscribe if needed
        }
        _ => {}
    }
}
```

### 2.4 Connect Timeline Store to Broadcast (Rust-side)

**File: `src-tauri/src/lib.rs`**

Add Tauri command for frontend to relay observations:

```rust
#[tauri::command]
pub fn broadcast_observation_batch(observations: Vec<ObservationData>) {
    broadcast_observations(ObservationMessage::Observations { data: observations });
}

#[tauri::command]
pub fn broadcast_aircraft_removals(callsigns: Vec<String>) {
    broadcast_observations(ObservationMessage::Removals { callsigns });
}
```

---

## Phase 3: Frontend Integration

### 3.1 Host-Side: Relay Observations to Backend

**File: `src/renderer/services/SettingsSharedWorkerService.ts`**

```typescript
import { invoke } from '@tauri-apps/api/core'
import { isTauriMode } from '../utils/remoteMode'

// In initialize():
registerBroadcastCallbacks(
  (observations) => {
    this.broadcastObservations(observations)      // SharedWorker (insets)
    this.relayObservationsToBackend(observations) // WebSocket (remote clients)
  },
  (callsigns) => {
    this.broadcastRemovals(callsigns)
    this.relayRemovalsToBackend(callsigns)
  }
)

private async relayObservationsToBackend(
  observations: Array<{ callsign: string; observation: AircraftObservation; metadata: AircraftMetadata }>
): Promise<void> {
  if (!isTauriMode()) return

  const data = observations.map(({ callsign, observation, metadata }) => ({
    callsign,
    latitude: observation.latitude,
    longitude: observation.longitude,
    altitude: observation.altitude,
    heading: observation.heading,
    groundspeed: observation.groundspeed,
    groundTrack: observation.groundTrack ?? observation.heading,
    verticalRate: observation.verticalRate ?? 0,
    onGround: observation.onGround ?? false,
    pitch: observation.pitch,
    roll: observation.roll,
    source: observation.source,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    typeCode: metadata.typeCode,
    origin: metadata.origin,
    destination: metadata.destination,
    flightRules: metadata.flightRules,
  }))

  try {
    await invoke('broadcast_observation_batch', { observations: data })
  } catch (e) {
    // Ignore errors (no remote clients connected)
  }
}

private async relayRemovalsToBackend(callsigns: string[]): Promise<void> {
  if (!isTauriMode()) return

  try {
    await invoke('broadcast_aircraft_removals', { callsigns })
  } catch (e) {
    // Ignore errors
  }
}
```

### 3.2 Remote Client: Receive Observations via WebSocket

**New file: `src/renderer/hooks/useHostObservations.ts`**

```typescript
import { useEffect, useRef } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useVnasStore } from '../stores/vnasStore'
import type { AircraftObservation, AircraftMetadata } from '../types/aircraft-timeline'

/**
 * In remote mode, receives observations from host via WebSocket.
 * Observations are fed to the timeline store, which then broadcasts
 * to any local insets via SharedWorker.
 */
export function useHostObservations() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!isRemoteMode()) return

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = `${protocol}//${window.location.host}/api/observations/ws`

      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[HostObservations] Connected to observation stream')
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          handleMessage(message)
        } catch (e) {
          console.error('[HostObservations] Parse error:', e)
        }
      }

      ws.onclose = () => {
        console.log('[HostObservations] Disconnected, reconnecting...')
        wsRef.current = null
        reconnectTimeoutRef.current = setTimeout(connect, 2000)
      }

      ws.onerror = (error) => {
        console.error('[HostObservations] WebSocket error:', error)
      }
    }

    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      wsRef.current?.close()
    }
  }, [])

  /**
   * Request the host to subscribe to a facility for vNAS data.
   * Only works if facility is within the host's CRC session.
   */
  const requestFacilitySubscription = (facilityId: string) => {
    wsRef.current?.send(JSON.stringify({
      action: 'subscribe',
      facilityId,
    }))
  }

  return { requestFacilitySubscription }
}

function handleMessage(message: { type: string; data?: unknown; callsigns?: string[]; facilities?: string[] }) {
  const timeline = useAircraftTimelineStore.getState()

  switch (message.type) {
    case 'observations': {
      const observations = (message.data as ObservationData[]).map(convertToTimelineFormat)
      timeline.addObservationBatch(observations)
      break
    }

    case 'removals': {
      const callsigns = message.callsigns as string[]
      callsigns.forEach(cs => timeline.removeAircraft(cs))
      break
    }

    case 'subscriptions': {
      // Update local store with host's vNAS subscriptions
      const facilities = message.facilities as string[]
      useVnasStore.getState().setSubscribedFacilities(facilities)
      break
    }
  }
}

interface ObservationData {
  callsign: string
  latitude: number
  longitude: number
  altitude: number
  heading: number
  groundspeed: number
  groundTrack: number
  verticalRate: number
  onGround: boolean
  pitch?: number
  roll?: number
  source: string
  observedAt: number
  receivedAt: number
  typeCode?: string
  origin?: string
  destination?: string
  flightRules?: string
}

function convertToTimelineFormat(data: ObservationData): {
  callsign: string
  observation: AircraftObservation
  metadata: AircraftMetadata
} {
  return {
    callsign: data.callsign,
    observation: {
      latitude: data.latitude,
      longitude: data.longitude,
      altitude: data.altitude,
      heading: data.heading,
      groundspeed: data.groundspeed,
      groundTrack: data.groundTrack,
      verticalRate: data.verticalRate,
      onGround: data.onGround,
      pitch: data.pitch ?? null,
      roll: data.roll ?? null,
      source: data.source as 'vatsim' | 'vnas' | 'realtraffic',
      observedAt: data.observedAt,
      receivedAt: data.receivedAt,
      displayDelay: getDisplayDelayForSource(data.source),
    },
    metadata: {
      typeCode: data.typeCode ?? null,
      origin: data.origin ?? null,
      destination: data.destination ?? null,
      flightRules: data.flightRules ?? null,
    },
  }
}

function getDisplayDelayForSource(source: string): number {
  switch (source) {
    case 'vnas': return 2000
    case 'realtraffic': return 5000
    case 'vatsim':
    default: return 15000
  }
}
```

### 3.3 Use Hook in App.tsx

**File: `src/renderer/App.tsx`**

```typescript
import { useHostObservations } from './hooks/useHostObservations'

function App() {
  // ... existing code

  // In remote mode, receive observations from host
  const { requestFacilitySubscription } = useHostObservations()

  // ... rest of component
}
```

### 3.4 Disable Direct Polling in Remote Mode

**File: `src/renderer/stores/vatsimStore.ts`**

```typescript
startPolling: () => {
  if (isRemoteMode()) {
    console.log('[VatsimStore] Remote mode - observations come from host')
    return
  }
  // ... existing polling logic
}
```

**File: `src/renderer/services/RealTrafficService.ts`**

```typescript
connect(): void {
  if (isRemoteMode()) {
    console.log('[RealTraffic] Remote mode - data comes from host')
    return
  }
  // ... existing connection logic
}
```

---

## Phase 4: Auto-Subscribe on Airport Change

### 4.1 Hook: Request vNAS Subscription When Viewing Airport

**New file: `src/renderer/hooks/useRemoteVnasSubscription.ts`**

```typescript
import { useEffect } from 'react'
import { isRemoteMode } from '../utils/remoteMode'
import { useAirportStore } from '../stores/airportStore'
import { useVnasStore } from '../stores/vnasStore'

/**
 * In remote mode, request vNAS subscription when viewing an airport
 * that's within the host's available facilities.
 */
export function useRemoteVnasSubscription(
  requestSubscription: (facilityId: string) => void
) {
  const currentAirport = useAirportStore(s => s.currentAirport)
  const sessionFacilities = useVnasStore(s => s.sessionFacilities)
  const subscribedFacilities = useVnasStore(s => s.subscribedFacilities)

  useEffect(() => {
    if (!isRemoteMode()) return
    if (!currentAirport) return

    const icao = currentAirport.icao

    // Check if this airport is available for vNAS and not already subscribed
    if (sessionFacilities.includes(icao) && !subscribedFacilities.includes(icao)) {
      console.log(`[RemoteVnas] Requesting subscription for ${icao}`)
      requestSubscription(icao)
    }
  }, [currentAirport, sessionFacilities, subscribedFacilities, requestSubscription])
}
```

### 4.2 Sync Session Facilities to Remote Clients

The host should broadcast available facilities so remote clients know what they can request:

**Add to observations WebSocket initial message:**

```rust
// On WebSocket connect, send current state
let initial_state = json!({
    "type": "init",
    "sessionFacilities": get_vnas_session_facilities(),
    "subscribedFacilities": get_vnas_subscribed_facilities(),
});
sender.send(Message::Text(initial_state.to_string())).await;
```

---

## Phase 5: Cleanup

### 5.1 Remove Deprecated Code

- Remove `/api/vnas/ws` endpoint (replaced by `/api/observations/ws`)
- Remove `VnasAircraftBroadcast` struct
- Remove `broadcast_vnas_to_websocket()` function
- Remove CORS proxy usage for VATSIM in VatsimService (remote mode)

### 5.2 Update vnasStore for Remote Mode

Remove error throwing, just no-op gracefully:

```typescript
startAuth: async (environment: VnasEnvironment): Promise<string> => {
  if (isRemoteMode()) {
    // Remote clients don't authenticate - host handles this
    return ''
  }
  // ... existing code
}
```

### 5.3 Hide Data Source Controls in Remote Mode

Update settings UI to hide vNAS auth, RealTraffic connection, etc. when in remote mode since these are host-controlled.

---

## Testing Checklist

- [ ] Main app receives VATSIM observations
- [ ] Main app receives vNAS observations (single facility)
- [ ] Main app receives vNAS observations (multiple facilities)
- [ ] Main app insets receive observations via SharedWorker
- [ ] Remote browser connects to `/api/observations/ws`
- [ ] Remote browser receives observations
- [ ] Remote browser timeline interpolates correctly
- [ ] Remote browser insets receive observations via SharedWorker
- [ ] Remote browser can request vNAS facility subscription
- [ ] Host auto-subscribes when remote requests valid facility
- [ ] Aircraft removals propagate to remote browsers
- [ ] Reconnection works after WebSocket disconnect

---

## Migration Notes

1. Frontend `VnasStatus.facilityId` changes to `subscribedFacilities: string[]`
2. Backend `facility_id: Option<String>` changes to `subscribed_facilities: Vec<String>`
3. Remove any UI that displays single facility assumption
4. Update any code that checks `facilityId` to check `subscribedFacilities.length > 0`
