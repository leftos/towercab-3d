# Remote Browser Access Architecture

This document explains how TowerCab 3D serves the React app to remote browsers (iPad, tablets, other PCs) via the built-in HTTP server, including the Rust backend, API abstraction layer, observation relay, and touch input handling.

## Overview

The Tauri desktop app runs an **HTTP server** (axum, port 8765) that serves the compiled React frontend and REST APIs to browsers on the local network. This enables multi-device scenarios where a controller can use an iPad at a remote location while the host PC handles all data fetching, model conversion, and settings storage.

```
┌─────────────────────────────────────────────────────────────────────┐
│ HOST (Desktop - Tauri)                                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐   │
│  │ VATSIM API      │   │ vNAS (optional) │   │ RealTraffic     │   │
│  │ (15s updates)   │   │ (1Hz updates)   │   │ (~2-3s updates) │   │
│  └────────┬────────┘   └────────┬────────┘   └────────┬────────┘   │
│           │                     │                     │            │
│           └─────────────────────┴─────────────────────┘            │
│                                 │                                   │
│                    broadcast_observations()                         │
│                                 │                                   │
│                    ┌────────────▼────────────┐                     │
│                    │ OBSERVATIONS_TX         │                     │
│                    │ (broadcast channel)     │                     │
│                    └────────────┬────────────┘                     │
│                                 │                                   │
│    ┌────────────────────────────▼─────────────────────────────┐    │
│    │ HTTP Server (axum, port 8765)                            │    │
│    │                                                          │    │
│    │  Static Files: /, /index.html, /assets/*                 │    │
│    │  Settings API: /api/global-settings                      │    │
│    │  Mods API: /api/mods/aircraft, /api/mods/towers          │    │
│    │  MSFS API: /api/msfs/models, /api/msfs/convert           │    │
│    │  Observations WS: /api/observations/ws                   │    │
│    │  Presence WS: /api/presence                              │    │
│    │  CORS Proxy: /api/proxy, /api/realtraffic/*              │    │
│    └──────────────────────────────────────────────────────────┘    │
│                                                                     │
└───────────────────────────────────┬─────────────────────────────────┘
                                    │
                           (HTTP/WebSocket)
                           (Local Network Only)
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │                                                       │
┌───────▼───────────────────────┐       ┌───────▼───────────────────────┐
│ REMOTE CLIENT 1 (iPad)        │       │ REMOTE CLIENT 2 (Browser)     │
├───────────────────────────────┤       ├───────────────────────────────┤
│                               │       │                               │
│ isRemoteMode() = true         │       │ isRemoteMode() = true         │
│ isTauri() = false             │       │ isTauri() = false             │
│                               │       │                               │
│ useRemoteObservations()       │       │ useRemoteObservations()       │
│ useTouchInput() (enabled)     │       │ (mouse input)                 │
│ RemoteStatusIndicator         │       │ RemoteStatusIndicator         │
│ DeviceOptimizationPrompt      │       │                               │
│                               │       │                               │
└───────────────────────────────┘       └───────────────────────────────┘
```

## Key Files

### Rust Backend

| File | Purpose |
|------|---------|
| `src-tauri/src/server.rs` | HTTP server implementation (axum) |
| `src-tauri/src/lib.rs` | Tauri commands for observation broadcasting |
| `src-tauri/src/settings.rs` | GlobalSettings struct and file I/O |
| `src-tauri/src/msfs.rs` | MSFS model detection, indexing, conversion |
| `src-tauri/src/mods.rs` | Mod directory scanning and tower positions |

### Frontend (Remote Mode Support)

| File | Purpose |
|------|---------|
| `utils/remoteMode.ts` | Remote vs Tauri mode detection |
| `utils/tauriApi.ts` | Unified API abstraction layer |
| `hooks/useRemoteObservations.ts` | WebSocket client for observations |
| `hooks/useRemoteVnasSubscription.ts` | Auto vNAS subscription management |
| `hooks/useTouchInput.ts` | Touch gestures for camera control |
| `stores/remoteStatusStore.ts` | Connection status tracking |
| `components/UI/RemoteStatusIndicator.tsx` | Live/Stale/Disconnected indicator |

## Mode Detection

The frontend detects whether it's running in Tauri (desktop) or remote (browser) mode:

```typescript
// src/renderer/utils/remoteMode.ts

export function isRemoteMode(): boolean {
  return !('__TAURI__' in window) && !('__TAURI_INTERNALS__' in window)
}

export function isTauriMode(): boolean {
  return ('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window)
}

export function getApiBaseUrl(): string {
  if (isRemoteMode()) {
    return window.location.origin  // e.g., http://192.168.1.100:8765
  }
  return 'http://localhost:8765'   // Vite dev server on 5173, backend on 8765
}
```

**Why this works:**
- **Tauri desktop app**: Injects `__TAURI__` and `__TAURI_INTERNALS__` globals
- **Browser via HTTP**: Neither global exists when loaded from the HTTP server

## API Abstraction Layer

The `tauriApi.ts` module provides a unified interface that branches based on mode:

```
┌─────────────────────────────────────────────────────────────────────┐
│ tauriApi.ts - Unified API Layer                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  modApi                                                             │
│  ├─ getModsPath()        → Tauri: invoke() | Browser: /api/mods/   │
│  ├─ listModDirectories() → Tauri: invoke() | Browser: fetch()      │
│  ├─ readModManifest()    → Tauri: invoke() | Browser: fetch()      │
│  ├─ readTowerPositions() → Tauri: invoke() | Browser: fetch()      │
│  └─ updateTowerPosition()→ Tauri: invoke() | Browser: PUT          │
│                                                                     │
│  globalSettingsApi                                                  │
│  ├─ read()  → Tauri: invoke() | Browser: GET /api/global-settings  │
│  └─ write() → Tauri: invoke() | Browser: POST /api/global-settings │
│              (BLOCKED in inset iframes to prevent corruption)      │
│                                                                     │
│  httpServerApi (Tauri only)                                         │
│  ├─ start(port) → ServerStatus                                     │
│  ├─ stop()                                                          │
│  └─ getStatus() → ServerStatus                                     │
│                                                                     │
│  convertToAssetUrl(filePath, type)                                  │
│  ├─ Tauri: asset://localhost/path/to/file.glb                      │
│  └─ Browser: /api/msfs/modelname.glb or /api/mods/aircraft/...     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Inset Iframe Protection

Inset viewports (see `inset-architecture.md`) run in isolated iframes. These must NOT write to global settings:

```typescript
// src/renderer/utils/tauriApi.ts

export function isInsetContext(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.has('viewportId') && params.has('parentOrigin')
}

// In globalSettingsApi.write():
if (isInsetContext()) {
  console.log('[globalSettingsApi] Blocked write from inset context')
  return  // Silently fail - insets receive settings via SharedWorker
}
```

## HTTP Server (Rust)

The server is implemented in `src-tauri/src/server.rs` using **axum**.

### Server State

```rust
pub struct ServerState {
    pub app_handle: tauri::AppHandle,
    pub dist_path: PathBuf,
    pub auth_token: Option<String>,
    pub require_local_network: bool,
    pub observations_tx: broadcast::Sender<ObservationMessage>,
    pub connected_clients: AtomicUsize,
    pub synced_airport: RwLock<Option<String>>,
    pub realtraffic_active: RwLock<bool>,
}
```

### API Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Serve React app (index.html) |
| `/assets/*` | GET | Static assets (JS, CSS, images) |
| `/api/global-settings` | GET | Read global settings |
| `/api/global-settings` | POST | Write global settings |
| `/api/mods/aircraft` | GET | List aircraft mods |
| `/api/mods/towers` | GET | List tower mods |
| `/api/mods/*path` | GET | Serve mod files (GLB models) |
| `/api/msfs/models` | GET | List converted MSFS models |
| `/api/msfs/*path` | GET | Serve converted GLB files |
| `/api/msfs/convert` | POST | Request on-the-fly conversion |
| `/api/tower-positions` | GET | Read custom tower positions |
| `/api/tower-positions/:icao` | PUT | Update tower position |
| `/api/vmr-rules` | GET | Parse and serve VMR rules |
| `/api/observations/ws` | WS | Observations WebSocket |
| `/api/presence` | WS | Remote client presence tracking |
| `/api/realtraffic/*` | POST | CORS proxy for RealTraffic API |
| `/api/proxy` | GET | CORS proxy (VATSIM, Aviation Weather) |
| `/api/log` | POST | Remote client logging endpoint |

### Security

**Local Network Restriction:**
```rust
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
            ipv6.is_loopback()
            || (ipv6.segments()[0] & 0xffc0) == 0xfe80  // fe80::/10 link-local
            || (ipv6.segments()[0] & 0xfe00) == 0xfc00  // fc00::/7 ULA
        }
    }
}
```

**Authentication Middleware:**
- Optional Bearer token validation
- API routes require token if configured
- Static files served without authentication

## Observations Broadcasting

All data sources (VATSIM, vNAS, RealTraffic) are unified into a single broadcast channel.

### Unified Observation Format

```rust
#[derive(Serialize, Deserialize)]
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
    pub source: String,       // "vatsim" | "vnas" | "realtraffic"
    pub observed_at: u64,     // Unix timestamp (ms)
    pub received_at: u64,
    pub type_code: Option<String>,
    pub origin: Option<String>,
    pub destination: Option<String>,
    pub flight_rules: Option<String>,
}
```

### WebSocket Message Types

```rust
pub enum ObservationMessage {
    Observations { data: Vec<ObservationData> },
    Removals { callsigns: Vec<String> },
    Subscriptions { facilities: Vec<String> },
    Init { session_facilities: Vec<String>, subscribed_facilities: Vec<String> },
    AirportSync { icao: Option<String>, realtraffic_active: bool },
}
```

### Data Flow

```
Host Frontend                  Rust Backend               Remote Client
      │                             │                          │
      │ VATSIM/vNAS/RealTraffic    │                          │
      │ data received              │                          │
      │                             │                          │
      │ broadcast_observations() ──>│                          │
      │ (Tauri command)            │                          │
      │                             │                          │
      │                    ┌────────▼────────┐                 │
      │                    │ OBSERVATIONS_TX │                 │
      │                    │ (256 msg buffer)│                 │
      │                    └────────┬────────┘                 │
      │                             │                          │
      │                             │<── /api/observations/ws  │
      │                             │    (WebSocket connect)   │
      │                             │                          │
      │                             │───── init ──────────────>│
      │                             │  (session_facilities,    │
      │                             │   subscribed_facilities) │
      │                             │                          │
      │                             │───── observations ──────>│
      │                             │  (batch of aircraft)     │
      │                             │                          │
      │                             │───── removals ──────────>│
      │                             │  (disconnected aircraft) │
      │                             │                          │
      │                             │<──── subscribe ──────────│
      │                             │  (facilityId: "JFK")     │
      │                             │                          │
```

### Client-Side Reception

```typescript
// src/renderer/hooks/useRemoteObservations.ts

export function useRemoteObservations(): void {
  useEffect(() => {
    if (!isRemoteMode()) return

    const wsUrl = getApiBaseUrl().replace(/^http/, 'ws') + '/api/observations/ws'
    const ws = new WebSocket(wsUrl)

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data)

      switch (message.type) {
        case 'init':
          setSessionFacilities(message.session_facilities)
          setSubscribedFacilities(message.subscribed_facilities)
          break

        case 'observations':
          // Convert to AircraftObservation format, add to timeline store
          addObservationBatch(message.data.map(convertObservation))
          break

        case 'removals':
          message.callsigns.forEach(removeAircraft)
          break

        case 'subscriptions':
          setSubscribedFacilities(message.facilities)
          break

        case 'airport_sync':
          setAirportSync(message.icao, message.realtraffic_active)
          break
      }
    }
  }, [])
}
```

## vNAS Subscription Management

Remote clients can request vNAS facility subscriptions:

```typescript
// src/renderer/hooks/useRemoteVnasSubscription.ts

// Auto-subscribe when user selects an airport
useEffect(() => {
  if (!isRemoteMode()) return
  if (!currentAirport) return

  const facilityId = normalizeIcao(currentAirport)  // "KJFK" → "JFK"

  if (sessionFacilities.includes(facilityId) && !subscribedFacilities.includes(facilityId)) {
    requestRemoteSubscription(facilityId)
  }
}, [currentAirport, sessionFacilities, subscribedFacilities])

function normalizeIcao(icao: string): string {
  // vNAS uses ICAO codes without K-prefix for US airports
  if (icao.length === 4 && icao.startsWith('K')) {
    return icao.slice(1)  // "KJFK" → "JFK"
  }
  return icao
}
```

## Touch Input Handling

The `useTouchInput` hook enables camera control on touch devices:

### Gesture Mapping

| Gesture | 3D/Tower View | Top-Down View | Orbit Follow |
|---------|---------------|---------------|--------------|
| Single-finger drag | Rotate camera | Pan map | Rotate orbit |
| Two-finger pinch | Zoom (FOV) | Altitude adjust | Distance adjust |
| Two-finger twist | Rotate heading | Rotate heading | Rotate heading |

### Implementation

```typescript
// src/renderer/hooks/useTouchInput.ts

export function useTouchInput(
  viewer: Cesium.Viewer | null,
  viewportId: string,
  options: UseTouchInputOptions = {}
): void {
  useEffect(() => {
    if (!isInputEnabled) return
    if (!viewer || viewer.isDestroyed()) return
    if (!isTouchDevice()) return  // Only enable on touch devices

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas)

    // Single-finger drag → camera rotation
    handler.setInputAction((movement) => {
      const deltaX = movement.endPosition.x - movement.startPosition.x
      const deltaY = movement.endPosition.y - movement.startPosition.y

      adjustHeading(viewportId, -deltaX * sensitivity)
      adjustPitch(viewportId, -deltaY * sensitivity)
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)

    // Cesium's PINCH_MOVE format (different from documented TwoPointMotionEvent)
    handler.setInputAction((pinch: CesiumPinchMoveEvent) => {
      const prevDist = pinch.distance.startPosition.y
      const currDist = pinch.distance.endPosition.y
      const zoomDelta = (currDist - prevDist) * 0.5

      adjustFov(viewportId, -zoomDelta)
    }, Cesium.ScreenSpaceEventType.PINCH_MOVE)
  }, [viewer, viewportId, isInputEnabled])
}
```

### Smart Follow-Break Logic

```typescript
// Prevent accidental follow-break during pinch-to-zoom
const accumulatedMovementRef = useRef(0)

// On drag
accumulatedMovementRef.current += Math.sqrt(deltaX * deltaX + deltaY * deltaY)

// Only break follow after significant intentional movement
if (accumulatedMovementRef.current > 15 && !pinchStateRef.current.wasMultiTouch) {
  onBreakTowerFollow?.()
}
```

## Remote Status Indicator

A compact status indicator shows connection health in the TopBar:

```typescript
// src/renderer/components/UI/RemoteStatusIndicator.tsx

function RemoteStatusIndicator() {
  const wsConnected = useRemoteStatusStore(state => state.wsConnected)
  const lastObservationTime = useRemoteStatusStore(state => state.lastObservationTime)
  const lastSource = useRemoteStatusStore(state => state.lastSource)

  // Don't render in Tauri mode
  if (!isRemoteMode()) return null

  // Use source-specific stale threshold
  const threshold = lastSource
    ? SOURCE_STALE_THRESHOLDS[lastSource]
    : SOURCE_STALE_THRESHOLDS.vatsim

  // Determine status
  let status: 'connected' | 'stale' | 'disconnected'

  if (!wsConnected) {
    status = 'disconnected'  // Red dot, "Disconnected"
  } else if (Date.now() - lastObservationTime > threshold) {
    status = 'stale'         // Yellow dot, "No data", "Xs ago"
  } else {
    status = 'connected'     // Green dot, "Live"
  }
}
```

### Source-Aware Stale Thresholds

Different data sources have different expected update intervals:

| Source | Update Interval | Stale Threshold |
|--------|-----------------|-----------------|
| vNAS | 1 second | 5 seconds |
| RealTraffic | ~3 seconds | 8 seconds |
| VATSIM | 15 seconds | 25 seconds |

The indicator tracks the most recent data source and applies the appropriate threshold.

### Status Store

```typescript
// src/renderer/stores/remoteStatusStore.ts

interface RemoteStatusState {
  wsConnected: boolean
  lastObservationTime: number
  observationCount: number        // For rate calculation
  countStartTime: number          // Reset every 10s
  lastSource: 'vatsim' | 'vnas' | 'realtraffic' | null
  realtrafficActive: boolean      // RealTraffic mode on host
  syncedAirport: string | null    // Current synced airport
}
```

## Global Settings Sync

Settings are stored on the host and synced to remote clients:

### Settings Storage

**Host (Tauri):**
```
~/.config/towercab-3d/global-settings.json
```

**Remote (Browser):**
- Reads via `GET /api/global-settings`
- Writes via `POST /api/global-settings`
- Local per-browser settings in `localStorage` (not synced)

### Settings Flow

```
Host (Tauri)                            Remote (Browser)
     │                                        │
     │ User changes Cesium token              │
     │        ↓                               │
     │ globalSettingsStore.update()           │
     │        ↓                               │
     │ invoke('write_global_settings')        │
     │        ↓                               │
     │ File: global-settings.json             │
     │                                        │
     │                                        │ User changes Cesium token
     │                                        │        ↓
     │                                        │ globalSettingsStore.update()
     │                                        │        ↓
     │                                        │ POST /api/global-settings
     │                                        │        ↓
     │<─────────────────────────────────────────────────│
     │        ↓                               │
     │ Server writes global-settings.json    │
```

### Secret Preservation

vNAS tokens are never sent to browsers:

```rust
// server.rs - POST /api/global-settings handler

// Preserve existing vnas_tokens (secrets should not come from browser)
if let Ok(existing_content) = fs::read_to_string(&settings_file) {
    if let Ok(existing_settings) = serde_json::from_str::<GlobalSettings>(&existing_content) {
        settings.vnas_tokens = existing_settings.vnas_tokens;
    }
}
```

## Device Optimization

Remote clients auto-detect device capabilities and suggest optimized settings:

```typescript
// Device tier detection
function getDevicePerformanceTier(): 'high' | 'medium' | 'low' {
  const memory = navigator.deviceMemory ?? 4  // GB
  const cores = navigator.hardwareConcurrency ?? 4

  if (memory < 4 || cores < 4) return 'low'
  if (memory >= 8 && cores >= 8) return 'high'
  return 'medium'
}

// Presets
const MOBILE_PRESET = {
  shadows: false,
  msaa: 1,
  terrainQuality: 'low',
  tileCache: 200
}

const IPAD_PRESET = {
  shadows: false,
  msaa: 2,
  terrainQuality: 'medium',
  tileCache: 500
}
```

## Presence Tracking

The host tracks connected remote clients via a separate WebSocket:

```
Remote Client                    Host Server
      │                              │
      │──── /api/presence WS ────────>│
      │                              │ connected_clients++
      │                              │ emit 'remote-clients-changed'
      │                              │
      │                              │ (displayed in settings UI:
      │                              │  "2 remote clients connected")
      │                              │
      │<──── (disconnect) ───────────│
                                     │ connected_clients--
                                     │ emit 'remote-clients-changed'
```

## CORS Proxy

Browser security prevents direct cross-origin requests. The server provides proxy endpoints:

| Endpoint | Proxies To |
|----------|------------|
| `/api/proxy?url=...` | VATSIM data API, Aviation Weather API, GitHub raw |
| `/api/realtraffic/auth` | RealTraffic authentication |
| `/api/realtraffic/traffic` | RealTraffic position data |
| `/api/realtraffic/deauth` | RealTraffic logout |

The proxy validates that URLs are on an allowed list before forwarding.

## Initialization Sequence

### Host Startup

1. App launches, React frontend mounts
2. Settings store loads from `localStorage` (local) and Tauri commands (global)
3. User enables "Remote Browser Access" in settings
4. `httpServerApi.start(8765)` invokes Rust backend
5. Server binds to `0.0.0.0:8765`, begins serving

### Remote Client Connection

1. User navigates to `http://<host-ip>:8765`
2. Server serves `index.html` and assets
3. React app mounts, `isRemoteMode()` returns `true`
4. `useRemoteObservations` connects to `/api/observations/ws`
5. Server sends `init` message with vNAS session info
6. `globalSettingsStore` fetches settings via `GET /api/global-settings`
7. Cesium viewer initializes with host's Ion token
8. Observations begin flowing, aircraft appear
9. If touch device, `DeviceOptimizationPrompt` suggests presets

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ HOST (Desktop - Tauri App)                                                  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ React Frontend                                                        │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ VatsimService   │  │ VnasService     │  │ RealTrafficSvc  │       │  │
│  │  │ (fetch 15s)     │  │ (SignalR+UDP)   │  │ (WebSocket)     │       │  │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘       │  │
│  │           │                    │                    │                 │  │
│  │           └────────────────────┴────────────────────┘                 │  │
│  │                                │                                      │  │
│  │              useAircraftDataSource (unified adapter)                  │  │
│  │                                │                                      │  │
│  │                  broadcast_observations() ──┐                         │  │
│  │                       (Tauri command)       │                         │  │
│  └─────────────────────────────────────────────┼────────────────────────┘  │
│                                                │                            │
│  ┌─────────────────────────────────────────────▼────────────────────────┐  │
│  │ Rust Backend (src-tauri/)                                            │  │
│  │                                                                       │  │
│  │  lib.rs                          server.rs                           │  │
│  │  ├─ broadcast_observations()     ├─ OBSERVATIONS_TX channel          │  │
│  │  ├─ broadcast_aircraft_removals()├─ REST API handlers                │  │
│  │  ├─ broadcast_subscriptions()    ├─ WebSocket handlers               │  │
│  │  └─ broadcast_airport_sync()     └─ Auth middleware                  │  │
│  │                                                                       │  │
│  │  settings.rs                     msfs.rs                             │  │
│  │  ├─ GlobalSettings struct        ├─ Model detection                  │  │
│  │  └─ File I/O                     ├─ Index caching                    │  │
│  │                                   └─ Conversion pipeline              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                           │                                 │
└───────────────────────────────────────────┼─────────────────────────────────┘
                                            │
                                   HTTP/WS (port 8765)
                                   Local Network Only
                                            │
           ┌────────────────────────────────┴────────────────────────────────┐
           │                                                                 │
┌──────────▼──────────────────────────┐   ┌──────────▼──────────────────────────┐
│ REMOTE CLIENT (iPad Safari)          │   │ REMOTE CLIENT (Chrome on PC)        │
│                                      │   │                                      │
│  remoteMode.ts                       │   │  remoteMode.ts                       │
│  ├─ isRemoteMode() = true           │   │  ├─ isRemoteMode() = true           │
│  └─ getApiBaseUrl() = http://...    │   │  └─ getApiBaseUrl() = http://...    │
│                                      │   │                                      │
│  tauriApi.ts                         │   │  tauriApi.ts                         │
│  ├─ modApi → HTTP GET /api/mods/    │   │  ├─ modApi → HTTP GET /api/mods/    │
│  ├─ globalSettingsApi → HTTP        │   │  ├─ globalSettingsApi → HTTP        │
│  └─ convertToAssetUrl → /api/msfs/  │   │  └─ convertToAssetUrl → /api/msfs/  │
│                                      │   │                                      │
│  useRemoteObservations.ts            │   │  useRemoteObservations.ts            │
│  └─ WebSocket /api/observations/ws  │   │  └─ WebSocket /api/observations/ws  │
│                                      │   │                                      │
│  useTouchInput.ts                    │   │  useCameraInput.ts                   │
│  ├─ Single-finger drag → rotate     │   │  └─ Mouse/keyboard input             │
│  ├─ Two-finger pinch → zoom         │   │                                      │
│  └─ Two-finger twist → heading      │   │                                      │
│                                      │   │                                      │
│  RemoteStatusIndicator               │   │  RemoteStatusIndicator               │
│  └─ Live/Stale/Disconnected         │   │  └─ Live/Stale/Disconnected         │
│                                      │   │                                      │
│  DeviceOptimizationPrompt            │   │  (not shown - desktop device)        │
│  └─ Apply iPad preset               │   │                                      │
│                                      │   │                                      │
└──────────────────────────────────────┘   └──────────────────────────────────────┘
```

## Design Principles

### 1. Single Source of Truth
Global settings live only on the host's file system. Remote browsers read via API, never store locally.

### 2. Unified Data Format
All observation sources (VATSIM, vNAS, RealTraffic) convert to the same `ObservationData` struct before broadcast.

### 3. Conditional Branching
Every API call checks `isTauri()` and branches to either Tauri commands or HTTP requests.

### 4. Local Network Isolation
The server only accepts connections from private IP ranges (10.x, 172.16-31.x, 192.168.x, localhost).

### 5. Lazy Subscription
Remote clients request vNAS subscriptions only when viewing an airport, not pre-subscribing to all facilities.

### 6. Touch-First Mobile
Touch input is detected automatically and gesture handling is optimized for tablet use.

## Further Reading

- [Inset Viewport Architecture](./inset-architecture.md) - SharedWorker-based inset communication
- [Main Architecture](./architecture.md) - Overall application architecture
- [CLAUDE.md](../CLAUDE.md) - Development guide
