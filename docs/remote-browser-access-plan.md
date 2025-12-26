# Remote Browser Access for TowerCab 3D

**Goal**: Enable TowerCab 3D to be used remotely from iPad Safari while maintaining settings and mods from the host PC.

**Status**: Phase 1 & 2 complete, Phase 3 next

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  HOST PC (Windows + Tauri)                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  HTTP Server (axum)  :8765                               │   │
│  │  - Serves React app (Vite build)                         │   │
│  │  - REST API for settings, mods, models                   │   │
│  │  - CORS proxy for VATSIM/METAR                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Global Settings File  (global-settings.json)            │   │
│  │  - Cesium Ion token                                      │   │
│  │  - FSLTL source/output paths                             │   │
│  │  - Airport defaults                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Mods Directory  (mods/)                                 │   │
│  │  - Aircraft models (.glb)                                │   │
│  │  - Tower models (.glb)                                   │   │
│  │  - VMR rules (.xml)                                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP / WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  REMOTE CLIENT (iPad Safari)                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  React App (same codebase, remote mode)                  │   │
│  │  - Full CesiumJS + Babylon.js rendering                  │   │
│  │  - Independent camera control                            │   │
│  │  - Touch gestures for camera                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Local Settings (localStorage)                           │   │
│  │  - Graphics quality (per-device)                         │   │
│  │  - Camera sensitivity                                    │   │
│  │  - UI preferences                                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Design Decisions

1. **Full WebGL rendering on iPad** (not video streaming) - lower latency, works with touch, existing code works
2. **Independent camera per client** - each device controls its own view
3. **Split settings**: Global (host file) + Local (browser localStorage)
4. **Per-device graphics settings** - iPad can tune its own quality/performance

---

## Phase 1: Split Settings Architecture ✅ COMPLETE

### 1.1 Create Global Settings Type ✅

**File**: `src/renderer/types/settings.ts`

Added `GlobalSettings` interface for settings shared across browsers:
- `cesiumIonToken` - Cesium Ion API token
- `fsltl` - FSLTL source/output paths, texture scale, enable flag
- `airports` - Default airport ICAO
- `server` - HTTP server port and enabled flag

### 1.2 Add Rust Commands for Global Settings ✅

**File**: `src-tauri/src/lib.rs`

New commands:
- `read_global_settings()` - Read from `global-settings.json` in app data dir
- `write_global_settings(settings)` - Write global settings to disk
- `get_global_settings_path()` - Return path for diagnostics

### 1.3 Create Global Settings Store ✅

**File**: `src/renderer/stores/globalSettingsStore.ts`

- Zustand store for global settings management
- Auto-migrates cesiumIonToken and FSLTL settings from localStorage on first run
- Async save operations to host file system via Tauri commands

### 1.4 Update Components ✅

Updated to use globalSettingsStore:
- `App.tsx` - Initializes global settings on startup
- `CesiumViewer.tsx` - Uses global cesiumIonToken
- `SettingsGeneralTab.tsx` - Saves token to global settings
- `FSLTLImportPanel.tsx` - Uses global FSLTL settings

---

## Phase 2: HTTP Server in Tauri Backend ✅ COMPLETE

### 2.1 Add Dependencies ✅

**File**: `src-tauri/Cargo.toml`

Added:
- `axum = "0.7"` - HTTP web framework
- `tower-http = { version = "0.5", features = ["cors", "fs", "trace"] }` - CORS and static file serving
- `tokio = { version = "1", features = ["rt-multi-thread", "net", "sync"] }` - Async runtime
- `mime_guess = "2"` - MIME type detection

### 2.2 Create Server Module ✅

**File**: `src-tauri/src/server.rs` (new)

REST API endpoints implemented:
```
GET  /                           - Serve index.html (SPA fallback)
GET  /assets/*                   - Serve static assets (JS, CSS, Cesium)
GET  /api/global-settings        - Return global settings JSON
GET  /api/mods/aircraft          - List aircraft mods with manifests
GET  /api/mods/towers            - List tower mods with manifests
GET  /api/mods/aircraft/*path    - Serve aircraft model file
GET  /api/mods/towers/*path      - Serve tower model file
GET  /api/fsltl/models           - List converted FSLTL models
GET  /api/fsltl/*path            - Serve FSLTL model file
GET  /api/tower-positions        - Custom tower positions JSON
GET  /api/vmr-rules              - Parsed VMR rules as JSON
GET  /api/proxy?url=...          - CORS proxy for VATSIM/METAR (allowlist enforced)
```

### 2.3 Integrate with Tauri ✅

**File**: `src-tauri/src/lib.rs`

New Tauri commands:
- `start_http_server(port)` - Start server, returns ServerStatus with URLs
- `stop_http_server()` - Stop the server gracefully
- `get_http_server_status()` - Get current server status and URLs

Features:
- Server runs on background tokio task with graceful shutdown
- Automatic LAN IP detection for remote access URL
- Port configurable via global settings (default 8765)
- Server status persisted in global settings

### 2.4 Add Frontend Controls ✅

**File**: `src/renderer/utils/tauriApi.ts`

Added `httpServerApi`:
- `start(port)` - Start server
- `stop()` - Stop server
- `getStatus()` - Get current status

**File**: `src/renderer/components/UI/SettingsGeneralTab.tsx`

Added "Remote Browser Access" section:
- Server port input (disabled when running)
- Start/Stop server button with loading state
- Copy-to-clipboard buttons for local and LAN URLs
- Error display for failed starts

**Note**: Server requires `npm run vite:build` to be run first (frontend must be built). In dev mode, it serves from the `dist/` folder relative to `src-tauri/`.

---

## Phase 3: Remote Mode Detection & API Layer

### 3.1 Remote Mode Utilities

**File**: `src/renderer/utils/remoteMode.ts` (new)
```typescript
export function isRemoteMode(): boolean {
  return !('__TAURI__' in window);
}

export function getApiBaseUrl(): string {
  return isRemoteMode() ? window.location.origin : '';
}
```

### 3.2 Unified API Service

**File**: `src/renderer/services/ApiService.ts` (new)

Abstracts Tauri commands vs HTTP fetch:
- `getGlobalSettings()` - Tauri command or GET /api/global-settings
- `listAircraftMods()` - Tauri command or GET /api/mods/aircraft
- `fetchUrl(url)` - Tauri CORS proxy or GET /api/proxy?url=
- `getModelUrl(path)` - Convert file path to HTTP URL in remote mode

### 3.3 Update Services to Use ApiService

**Files to modify**:
- `src/renderer/services/ModService.ts` - Use ApiService for mod discovery
- `src/renderer/services/FSLTLService.ts` - Use ApiService for FSLTL models
- `src/renderer/services/VatsimService.ts` - Use ApiService.fetchUrl() for CORS
- `src/renderer/services/MetarService.ts` - Use ApiService.fetchUrl() for CORS
- `src/renderer/services/AircraftModelService.ts` - Rewrite model URLs

### 3.4 Update tauriApi.ts

**File**: `src/renderer/utils/tauriApi.ts`

Add HTTP fallbacks for all mod-related functions when `isRemoteMode()`.

---

## Phase 4: Touch Input Support

### 4.1 Touch Gesture Hook

**File**: `src/renderer/hooks/useTouchInput.ts` (new)

Implement touch gestures using Cesium's ScreenSpaceEventHandler:
- **Single-finger drag**: Pan camera (heading/pitch in tower mode)
- **Two-finger pinch**: Zoom (FOV adjustment)
- **Two-finger rotate**: Orbit heading
- **Two-finger vertical**: Orbit pitch

### 4.2 Integrate Touch Input

**File**: `src/renderer/hooks/useCameraInput.ts`

- Import and call `useTouchInput()` hook
- Detect touch device and adjust sensitivity
- Share velocity/momentum system with mouse input

### 4.3 Touch-Friendly UI

**File**: `src/renderer/components/UI/ControlsBar.tsx`

- Increase button sizes on touch devices (44x44px minimum)
- Add hamburger menu for settings on narrow screens
- Hide keyboard shortcut hints on touch devices

---

## Phase 5: iPad Performance Optimizations

### 5.1 Device Detection

**File**: `src/renderer/utils/deviceDetection.ts` (new)
```typescript
export function isIPad(): boolean;
export function isTouchDevice(): boolean;
export function getDevicePerformanceTier(): 'high' | 'medium' | 'low';
```

### 5.2 Reduced Resource Limits

**File**: `src/renderer/hooks/useCesiumViewer.ts`

In remote mode or on detected mobile:
- Reduce model pool: 100 → 50
- Reduce tile cache: 2000 → 500
- Default shadows off
- Default MSAA to 2x

### 5.3 Suggested Defaults for iPad

When iPad is detected on first load:
- Prompt user to apply "iPad optimized" preset
- Settings: shadows off, 2x MSAA, terrain quality 2, buildings off
- User can override in local settings

---

## Phase 6: UI Adaptations for Remote

### 6.1 Remote-Only UI Elements

**File**: `src/renderer/components/UI/RemoteIndicator.tsx` (new)

- Show "Connected to [hostname]" badge
- Connection status indicator
- Reconnect button if connection lost

### 6.2 Disable Host-Only Features

**File**: `src/renderer/components/UI/ControlsBar.tsx`

In remote mode, hide/disable:
- FSLTL conversion panel (folder picker won't work)
- Update notifications (host handles updates)
- Settings that modify host files (tower position editor)

Show read-only versions where appropriate.

### 6.3 Connection Screen

**File**: `src/renderer/components/UI/ConnectionScreen.tsx` (new)

For remote clients:
- Auto-discover hosts via mDNS (if supported)
- Manual IP:port entry
- Recent connections list (localStorage)
- Host can display QR code for easy connection

---

## Implementation Order

1. **Phase 1**: Split settings (global file vs local storage) ✅ COMPLETE
2. **Phase 2**: HTTP server in Rust - enables remote access 🔄 IN PROGRESS
3. **Phase 3**: API layer - makes frontend work in remote mode
4. **Phase 4**: Touch input - makes iPad usable
5. **Phase 5**: Performance optimizations - makes iPad smooth
6. **Phase 6**: UI polish - improves remote experience

---

## Critical Files Summary

### New Files
| Path | Purpose | Status |
|------|---------|--------|
| `src-tauri/src/server.rs` | HTTP server module | ✅ Done |
| `src/renderer/utils/remoteMode.ts` | Remote mode detection | Pending |
| `src/renderer/services/ApiService.ts` | Unified Tauri/HTTP API | Pending |
| `src/renderer/hooks/useTouchInput.ts` | Touch gesture handling | Pending |
| `src/renderer/stores/globalSettingsStore.ts` | Global settings management | ✅ Done |
| `src/renderer/utils/deviceDetection.ts` | Device/platform detection | Pending |
| `src/renderer/components/UI/ConnectionScreen.tsx` | Remote connection UI | Pending |
| `src/renderer/components/UI/RemoteIndicator.tsx` | Connection status | Pending |

### Files Modified
| Path | Changes | Status |
|------|---------|--------|
| `src-tauri/Cargo.toml` | Add axum, tower-http, tokio, mime_guess | ✅ Done |
| `src-tauri/src/lib.rs` | HTTP server commands, global settings commands | ✅ Done |
| `src/renderer/types/settings.ts` | Add GlobalSettings type | ✅ Done |
| `src/renderer/stores/settingsStore.ts` | Remove global settings, add migration | Partial |
| `src/renderer/utils/tauriApi.ts` | Add httpServerApi and global settings API | ✅ Done |
| `src/renderer/components/UI/SettingsGeneralTab.tsx` | Server control UI | ✅ Done |
| `src/renderer/services/ModService.ts` | Use ApiService | Pending |
| `src/renderer/services/FSLTLService.ts` | Use ApiService | Pending |
| `src/renderer/services/VatsimService.ts` | Use ApiService.fetchUrl | Pending |
| `src/renderer/services/MetarService.ts` | Use ApiService.fetchUrl | Pending |
| `src/renderer/hooks/useCameraInput.ts` | Integrate touch input | Pending |
| `src/renderer/hooks/useCesiumViewer.ts` | Remote mode pool limits | Pending |
| `src/renderer/components/UI/ControlsBar.tsx` | Touch UI, disable host-only features | Pending |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| WebGL context limits on iPad | Reduce model pool, single viewport recommended |
| Safari WebGL quirks | Test early on real iPad hardware |
| Large asset downloads (Cesium ~100MB) | Service worker caching, show loading progress |
| Network latency for models | Aggressive caching, load on-demand |
| Settings migration breaks existing users | Version-gated migration with fallback |
