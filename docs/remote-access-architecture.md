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
                           (Local Network by default)
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
| `/api/global-settings` | GET | Read the remote view of the global settings (see "Settings exposed to remote clients") |
| `/api/global-settings` | POST | Write global settings through `merge_remote_write`; answers with the remote view of what was stored |
| `/api/mods/discover` | GET | List every mod folder: `[{id, path, modType, isGitRepo, repoName}]`; `path` is relative to the mods root (case kept, e.g. `mods/towers/KOAK/KOAK`), `id` is that path lowercased and is how `disabledMods` names the mod |
| `/api/mods/aircraft` | GET | List aircraft mods: `[{name, manifest}]` (no `path`) |
| `/api/mods/towers` | GET | List tower mods: `[{name, manifest}]` (no `path`) |
| `/api/mods/file/*path` | GET | Serve any file under the mods root by its relative path (GLB models, manifests) |
| `/api/mods/aircraft/*path`, `/api/mods/towers/*path` | GET | Serve a file from one aircraft or tower mod |
| `/api/msfs/index` | GET | List the host's FSLTL and AIG source models: `{fsltl, aig, totalCount}`, each model only `{source, modelName, aircraftType, airlineCode, atcId}` (no folder or file paths); a failure answers `Failed to get model index`, with the detail in the host log |
| `/api/msfs/models` | GET | List converted MSFS models: each only `{model_key, file_size, converter_version}` (no file path); the GLB is `/api/msfs/{model_key}.glb`; a failure answers `Failed to list converted models`, with the detail in the host log |
| `/api/msfs/*path` | GET | Serve converted GLB files |
| `/api/msfs/convert` | POST | Request on-the-fly conversion of a model by `model_name`, looked up in the host's model index; `texture_scale` must be `full`, `2k`, `1k` or `512` (anything else is 400). A failure answers `error: "Model conversion failed"`, with the detail in the host log |
| `/api/tower-positions` | GET | Read custom tower positions |
| `/api/tower-positions/:icao` | PUT | Update tower position |
| `/api/vmr-rules` | GET | Parse and serve VMR rules |
| `/api/aerodromes` | GET | The bundled OSM aerodrome boundaries of towered airports, decompressed from `aerodromes.json.gz`; a missing file answers 404, a read failure `Could not load aerodromes` |
| `/api/observations/ws` | WS | Observations WebSocket |
| `/api/presence` | WS | Remote client presence tracking |
| `/api/realtraffic/*` | POST | CORS proxy for RealTraffic API |
| `/api/proxy` | GET | CORS proxy (VATSIM, Aviation Weather) |
| `/api/log` | POST | Remote client logging endpoint |
| `/api/diagnostic` | POST | Save a diagnostic file on the host; answers `{filename}` only. A remote browser's Export Diagnostic dialog reads "Saved on the host as:" and the file name |

Dev builds only: under `pnpm run vite:headless` (port 5174; never `pnpm run dev`, `vite preview` or a build) the Vite dev server answers a read-only subset of this table itself, for headless agent checks (`scripts/dev/devApi.ts`; recipe in `CLAUDE.md`, "E2E testing via Playwright MCP"). It serves `/api/global-settings` GET, the mod routes, `/api/tower-positions` GET, `/api/airport-surfaces`, `/api/aerodromes`, `/api/proxy` and `/api/dev-health`, and passes `/api/realtraffic/*` to Vite's proxy.

It differs from the desktop server: loopback sockets only (no private LAN ranges) with its own `Host` and `Origin` check, a 403 for `Sec-Fetch-Mode: navigate` and cross-site requests, `/api/proxy` limited to the METAR URL, `POST /api/global-settings` and `/api/log` answered 204 and dropped, other writes 405, WebSocket upgrades under `/api/` closed, and the ion token replaced by a placeholder with `/api/ion/v1/assets/<id>/endpoint` forwarding to Cesium ion.

The desktop server is unchanged.

### Request path containment

Every route that builds a file path from a request resolves it with `resolve_within` in `server.rs` and refuses a path that leaves its root: through `..`, a drive prefix, a UNC path, an NTFS stream (`:`), a symlink or junction (a dangling one included), or a name Windows cannot hold (`< > " | ? *`, control characters). `\` separates components like `/`. The static root (`dist`) is canonicalised once when the server starts; a missing `dist` fails the start.

- **Static files** (`/`, `/assets/*`, other paths): a refused path answers 404, never the SPA page. A missing file without a known asset extension still falls back to `index.html`.
- **Mod files** (`/api/mods/file/*`, `/api/mods/aircraft/*`, `/api/mods/towers/*`) and **MSFS models** (`/api/msfs/*path`): 403 for a refused path, 404 for a missing file.
- **`PUT /api/tower-positions/{icao}`**: the code must be 3-4 ASCII letters, digits or `_` (e.g. `EK_2`), upper-cased to `<CODE>.json` in `tower-positions`; anything else is 400.
- **`POST /api/diagnostic`**: the filename must match `tc3d-diag-<middle>.tc3d-diag.json`, the middle made of ASCII letters, digits, `-`, `_` and `.`; anything else is 400.
- An I/O error while resolving a root or path answers 500 with the fixed text `Could not read the file` on every route above; the detail goes to the host log.

### Security

**Local Network Restriction:**

`auth_middleware` in `server.rs` runs before every handler and CORS answer. With `server.allowNonLocalClients` off (the default, `allow_non_local_clients` in Rust, read on every request so a change applies without a restart) it refuses with 403:
- a source IP that is not local (`is_local_network_ip`, below);
- a `Host` that is not a local name (`is_allowed_host`): a local-network IP literal, `localhost`, `*.local`, or a bare single-label name such as a Windows PC name (`DESKTOP-ABC`), with an optional port. A DNS-rebound page arrives under its own domain and is refused, as is a request without `Host`.

With `allowNonLocalClients` on (Settings > Configuration > "Allow devices outside the local network"), any source IP and any `Host` that is present are served; this is for VPN or internet access. The field defaults to off in both Rust and TypeScript, so existing settings files that held the old `requireLocalNetwork` value restrict by default and drop that key on the next host save.

**WebSocket Origin:** an upgrade (`/api/observations/ws`, `/api/presence`) is refused with 403 unless it has no `Origin` (a non-browser client), or an `http`/`https` `Origin` that is a local name (`is_local_host_name`) or equals the request's own `Host` (`is_same_origin`, the same-origin case that lets a VPN or internet client connect once non-local clients are allowed). This check applies whatever `allowNonLocalClients` says.

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

There is no bearer token or other credential: access is decided by the network rules above.

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

The dev build keeps its own file in the `com.towercab.viewer.dev` app data folder (`%APPDATA%\com.towercab.viewer.dev\global-settings.json` on Windows), which `vite:headless` reads per request, never writes, and overrides with `TC3D_SETTINGS_FILE`.

**Remote (Browser):**
- Reads via `GET /api/global-settings`
- Writes via `POST /api/global-settings`
- Local per-browser settings in `localStorage` (not synced)
- Loading sends no write: in remote mode `initializeGlobalSettings()` and the viewport and display migrations skip their writes, so an iPad opening the page never changes the host's settings

A host save that finds `global-settings.json` unparseable first copies it to `global-settings.json.corrupt-{unix seconds}` beside it, then replaces the file with the settings being saved (the vNAS tokens it held are lost).

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
     │                                        │ User changes a shared setting (e.g. bookmark)
     │                                        │        ↓
     │                                        │ globalSettingsStore.update()
     │                                        │        ↓
     │                                        │ POST /api/global-settings
     │                                        │        ↓
     │<─────────────────────────────────────────────────│
     │        ↓                               │
     │ Server merges, writes global-settings.json │
```

### Settings exposed to remote clients

Both directions go through two functions in `settings.rs`, so a remote browser never reads or changes what only the host should hold, and no remote response body carries a host path: not the shared settings, the MSFS model routes (`/api/msfs/index`, `/api/msfs/models`, `/api/msfs/convert`), the mod routes (`/api/mods/*`), `/api/diagnostic`, `/api/airport-surfaces` or `/api/aerodromes`, nor any error body:

- **Read** (`remote_view`, used by the GET and by the POST's response): the settings with `realtraffic.licenseKey` and `vnasTokens` blanked, and `imagery.googleMapsApiKey` blanked unless `imagery.provider` is `google`. The Cesium ion token is kept: the remote viewer cannot start without it.

  The host-private paths are blanked too: `fsltl.sourcePath`/`outputPath` and `msfsModels.communityPath`/`cacheDirectory` are `null` and `msfsModels.vmrFiles` is `[]`, so the shared settings carry no folder or file path on the host. Fields are blanked, not removed, because several have no serde default.
- **Write** (`merge_remote_write`): the incoming object with every host-owned, host-private and secret field copied back from the stored file: `server`, `renderingBackend`, `imagery.provider` and `imagery.googleMapsApiKey`, `fsltl.sourcePath`/`outputPath`, `msfsModels.communityPath`/`vmrFiles`/`cacheDirectory`, `realtraffic.licenseKey` and `vnasTokens`. The Cesium ion token is the one exception: a remote client may set it only while the host's is empty, and never overwrites one.
- Every field has a class in `FIELD_CLASSES`: **public** (remote clients see and change it), **host-owned** (they see it but never change it), **host-private** (a path on the host: they neither see nor change it) or **secret** (hidden unless they need it, never changed). A test in `settings.rs` walks every JSON path of a fully populated `GlobalSettings` and requires each to be classed, so a new field fails it until classified.
- `GET /api/global-settings` answers a 500 with exactly `Could not read the settings`, and `POST` with exactly `Could not save the settings`; the host log gets `[Server] Could not read the global settings: <detail>` (or `Could not save ...`) at error level, since the detail can name the settings file's path.
- Every other remote-reachable 500 body is fixed text too, with the detail in the host log as `[Server] <message>: <detail>`: `/api/airport-surfaces` "Could not load airport surfaces"; `/api/aerodromes` "Could not load aerodromes"; the mod routes "Could not list mods"; `GET /api/tower-positions` "Could not read tower positions" and `PUT` "Could not save the tower position"; `/api/vmr-rules` "Could not read VMR rules"; `/api/diagnostic` "Could not save the diagnostic" (a remote browser shows it as the toast "Could not save the diagnostic"); file serving and path checks "Could not read the file". The settings routes' host log lines read `[Server] Could not read the settings: <detail>`.
- `disabledMods` is a shared setting holding mod ids (`DiscoveredMod.id`, e.g. `mods/aircraft/b738`), never host paths. Saved absolute entries (a Windows drive, `\\?\`, UNC, or a macOS `/…` path) are rewritten to ids when the settings file is read and on a remote write; an entry with no `mods` folder or with `.`/`..` is dropped, logged once per process as `[Settings] Dropped <n> disabled-mod entries that name no mod folder`. The Mods tab stores and compares ids. The desktop's `discover_all_mods` result gains `id` while its `path` stays absolute.
- A second test fills every path field with host paths and requires no string of the remote view to hold one or to look like an absolute path (a drive letter, `\\` or `/`); the `/api/msfs/index` and `/api/msfs/models` responses are checked the same way.

The host webview reads every field except `vnasTokens` (`read_global_settings` never returns them). Only Rust writes the tokens (`read_vnas_tokens` / `write_vnas_tokens`, used by `vnas.rs`): a host write keeps the tokens already in the file, and an empty ion token from the host keeps the stored one. `vnasTokens` is not in the TypeScript `GlobalSettings` type.

A settings export (`getSettings()`) holds no tokens, and importing one applies only `port`, `enabled` and `minimizeToTray` from its `server` block, so an imported file cannot open the server to other networks.

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
│  │  └─ broadcast_airport_sync()     └─ Access middleware                │  │
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
                                   Local Network by default
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
Global settings live only on the host's file system. Remote browsers read via API (minus host-only secrets), never store locally, and cannot change host-owned fields.

### 2. Unified Data Format
All observation sources (VATSIM, vNAS, RealTraffic) convert to the same `ObservationData` struct before broadcast.

### 3. Conditional Branching
Every API call checks `isTauri()` and branches to either Tauri commands or HTTP requests.

### 4. Local Network Isolation
By default the server only accepts connections from private IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost) that name this PC by IP address, `localhost`, `name.local` or its bare PC name. `server.allowNonLocalClients` lifts both checks; WebSocket `Origin` is checked either way.

### 5. Lazy Subscription
Remote clients request vNAS subscriptions only when viewing an airport, not pre-subscribing to all facilities.

### 6. Touch-First Mobile
Touch input is detected automatically and gesture handling is optimized for tablet use.

## Further Reading

- [Inset Viewport Architecture](./inset-architecture.md) - SharedWorker-based inset communication
- [Main Architecture](./architecture.md) - Overall application architecture
- [CLAUDE.md](../CLAUDE.md) - Development guide
