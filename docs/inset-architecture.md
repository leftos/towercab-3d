# Inset Viewport Architecture

This document explains how inset viewports work in TowerCab 3D, including the iframe isolation, SharedWorker communication, and data flow patterns.

## Overview

Inset viewports are additional Cesium/Babylon viewers that run in **isolated iframes**. This isolation is required because Cesium has internal resource sharing bugs that prevent 3D buildings from rendering correctly when multiple viewers exist in the same browsing context.

```
┌─────────────────────────────────────────────────────────────┐
│ Main App (index.html)                                       │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Main CesiumViewer                                       │ │
│ │ - Full interpolation loop (60 Hz)                       │ │
│ │ - Broadcasts aircraft data to insets                    │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────┐ ┌─────────────┐                             │
│ │ Inset iframe│ │ Inset iframe│  (isolated browsing ctx)   │
│ │ (inset.html)│ │ (inset.html)│                             │
│ └─────────────┘ └─────────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

## Key Files

### Main App Side

| File | Purpose |
|------|---------|
| `components/Viewport/InsetCesiumViewer.tsx` | Wrapper that creates iframe, handles postMessage communication |
| `services/AircraftBroadcastService.ts` | Broadcasts aircraft positions to insets via SharedWorker |
| `services/SettingsSharedWorkerService.ts` | Broadcasts settings/weather/token to insets via SharedWorker |
| `workers/aircraft-broadcast.worker.ts` | SharedWorker that routes aircraft broadcasts to consumers |
| `workers/broadcast-encoder.worker.ts` | Dedicated Worker for MessagePack encoding (offloads main thread) |
| `workers/shared-data.worker.ts` | SharedWorker for settings/weather/token/imagery/airport data |

### Inset Side (runs inside iframe)

| File | Purpose |
|------|---------|
| `components/InsetApp.tsx` | Root component for inset, orchestrates data reception |
| `hooks/useBroadcastAircraft.ts` | Receives aircraft broadcasts, updates module-level state |
| `hooks/useSharedWorkerConsumer.ts` | Receives settings/weather/token from SharedWorker |
| `hooks/useInsetStoreSync.ts` | Syncs received data to local Zustand stores |
| `hooks/useAircraftInterpolation.ts` | In insets: registers callback to receive broadcast data (NO interpolation loop) |

### Shared Types

| File | Purpose |
|------|---------|
| `types/broadcast.ts` | Aircraft broadcast message types, delta compression types |
| `types/shared-worker.ts` | Settings/weather/camera SharedWorker message types |

## Communication Channels

There are **two separate SharedWorker channels**:

### 1. Aircraft Broadcast Channel (`aircraft-broadcast.worker.ts`)

High-frequency aircraft position updates (~30 Hz per consumer).

```
Main App                    SharedWorker                 Inset
   │                            │                          │
   │ register-main ────────────>│                          │
   │                            │<──────── register-inset  │
   │                            │ consumer-connected ─────>│
   │                            │                          │
   │ broadcast (encoded) ──────>│                          │
   │                            │───── aircraft-update ───>│
   │                            │                          │
   │                            │<──────── feedback        │
   │<─────── feedback ──────────│                          │
```

**Message Types:**
- `register-main`: Main app registers itself (singleton)
- `register-inset`: Inset registers as consumer, gets assigned ID (e.g., `inset-1`)
- `broadcast`: Main app sends encoded aircraft data to specific consumer or all
- `aircraft-update`: Worker forwards broadcast to consumer
- `feedback`: Consumer sends rate control feedback (lag, buffer depth, processing time)
- `disconnect`: Consumer disconnecting (cleanup)
- `inset-log`: Forward log messages from inset to main app (for debugging)

### 2. Settings/Data Channel (`shared-data.worker.ts`)

Low-frequency settings, weather, and configuration updates.

```
Main App                    SharedWorker                 Inset
   │                            │                          │
   │ cesium-token ─────────────>│                          │
   │ settings-update ──────────>│                          │
   │ weather-update ───────────>│                          │
   │                            │<──────── register-inset  │
   │                            │ (sends cached data) ────>│
   │                            │                          │
   │ imagery-update ───────────>│───── imagery-update ────>│
   │ airport-update ───────────>│───── airport-update ────>│
```

**Message Types:**
- `cesium-token`: Cesium Ion access token
- `settings-update`: Graphics, camera, aircraft settings
- `weather-update`: Fog density, visibility, cloud layers
- `imagery-update`: Imagery provider settings
- `airport-update`: Current airport ICAO, tower height
- `register-inset`: Inset registers with viewportId
- `viewport-camera`: Camera state updates (inset → main)

## Aircraft Data Flow

### Main App (Producer)

```
useAircraftInterpolation (60 Hz animation loop)
       │
       ▼
aircraftBroadcastService.broadcast(aircraft, timestamp)
       │
       ▼
broadcast-encoder.worker.ts (background thread)
  - Delta compression (only changed fields)
  - MessagePack encoding
  - Sequence numbering
       │
       ▼
aircraft-broadcast.worker.ts (SharedWorker)
  - Routes to registered consumers
  - Per-consumer rate control
       │
       ▼
Consumer (Inset iframe)
```

### Inset (Consumer)

```
useBroadcastAircraft hook
  - Connects to aircraft-broadcast SharedWorker
  - Registers as consumer, receives ID
  - Decodes MessagePack messages
  - Applies delta updates to local state
       │
       ▼
Module-level variable: broadcastAircraftData
  - Map<string, InterpolatedAircraftState>
  - Updated directly (bypasses React state batching)
       │
       ▼
registerSharedStatesUpdater callback
  - Registered by useAircraftInterpolation
  - Updates sharedInterpolatedStates directly
       │
       ▼
useCesiumLabels (postRender callback)
  - Reads sharedInterpolatedStates each frame
  - Updates Babylon labels
```

### Why No Interpolation in Insets?

Insets receive **pre-interpolated** aircraft positions from the main app at ~30 Hz. Running a second interpolation loop would:

1. Add latency (extrapolating already-extrapolated data)
2. Cause "drift and snap" behavior when new data arrives
3. Waste CPU cycles

Instead, insets pass through the broadcast data directly to the rendering system.

## Delta Compression

Aircraft broadcasts use delta compression to minimize bandwidth:

```typescript
// Full aircraft state (sent for new aircraft or full sync)
interface AircraftFull {
  c: string      // callsign
  la: number     // latitude
  lo: number     // longitude
  al: number     // altitude
  hd: number     // heading
  gs: number     // groundspeed
  pi: number     // pitch
  ro: number     // roll
  vr: number     // vertical rate
  tr: number     // turn rate
  ac: number     // acceleration
  tk: number     // track
  ty?: string    // aircraft type
  dp?: string    // departure
  ar?: string    // arrival
  mu?: string    // model URL
  sc?: [n,n,n]   // model scale
  ro_off?: number // rotation offset
  fsltl?: boolean // is FSLTL model
}

// Delta update (only changed fields)
interface AircraftDelta {
  c: string      // callsign (always required)
  la?: number    // only if changed beyond threshold
  lo?: number
  // ... other fields optional
}

// Broadcast message
interface BroadcastMessage {
  seq: number           // sequence number
  ts: number            // timestamp
  f: AircraftFull[]     // new aircraft (full state)
  d: AircraftDelta[]    // updates (delta only)
  r: string[]           // removed callsigns
}
```

## Consumer-Driven Rate Control

Each consumer can have a different update rate based on their processing capability:

```typescript
// Consumer sends feedback periodically
interface ConsumerFeedback {
  consumerId: string
  lastReceivedSeq: number  // for lag detection
  bufferDepth: number      // pending messages
  avgProcessingMs: number  // processing time
}

// Rate control constants
const RATE_CONTROL = {
  defaultInterval: 33,     // ~30 Hz default
  minInterval: 16,         // ~60 Hz max
  maxInterval: 100,        // 10 Hz min
  feedbackInterval: 1000,  // feedback every 1s
  lagThreshold: 5,         // sequences behind
  bufferThreshold: 3,      // pending messages
  processingThreshold: 10, // ms processing time
  slowdownFactor: 1.5,     // rate reduction
  speedupFactor: 0.9,      // rate increase
}
```

## Iframe Communication (postMessage)

In addition to SharedWorkers, iframes use `postMessage` for direct communication:

### Inset → Main (via postMessage)

- `inset-ready`: Cesium viewer initialized
- `inset-focus`: User clicked in inset (for activation)
- `camera-change`: Camera state changed
- `aircraft-select`: User selected an aircraft
- `follow-request`: User requested to follow aircraft
- `error`: Error occurred in inset

### Main → Inset (via postMessage)

- `camera-update`: Parent updating inset camera
- `follow-aircraft`: Start following an aircraft
- `stop-following`: Stop following
- `set-activated`: Whether this inset is the active viewport
- `request-focus`: Request iframe to take keyboard focus

## Inset Detection

Code can detect if it's running in an inset context:

```typescript
// src/renderer/utils/tauriApi.ts
export function isInsetContext(): boolean {
  const params = new URLSearchParams(window.location.search)
  return params.has('viewportId') && params.has('parentOrigin')
}
```

Inset URLs look like: `/inset.html?viewportId=abc123&parentOrigin=http://localhost:1420`

## Debugging Insets

### Log Forwarding

Inset logs are forwarded to the main app via the `inset-log` message type:

```typescript
// In useBroadcastAircraft.ts
function insetLog(message: string): void {
  console.log(message)  // Local iframe devtools
  if (workerPort && loggedConsumerId) {
    workerPort.postMessage({
      type: 'inset-log',
      consumerId: loggedConsumerId,
      logMessage: message,
    })
  }
}
```

Logs appear in `temp/console.log` as: `[Inset:inset-2] [BroadcastConsumer] Updated 345 aircraft, seq=1234`

### Common Issues

1. **Duplicate consumers**: React StrictMode causes double-mount. Fixed by port-based disconnect lookup.

2. **Out-of-order sequences**: May indicate multiple encoder workers (hot reload issue). Restart app.

3. **Delayed updates**: Check if `sharedStatesUpdater` callback is registered. Look for `[Interpolation] Inset context detected` log.

4. **Static datablocks**: The `useCesiumLabels` hook reads `interpolatedAircraft` in a postRender callback. Ensure the Map is being updated.

## Initialization Sequence

### Main App

1. `App.tsx` renders, initializes `AircraftBroadcastService` and `SettingsSharedWorkerService`
2. User creates inset viewport via UI
3. `ViewportManager` renders `InsetCesiumViewer` wrapper
4. Wrapper creates iframe with `inset.html?viewportId=...&parentOrigin=...`

### Inset

1. `inset.html` loads, renders `InsetApp` component
2. `useSharedWorkerConsumer` connects to settings SharedWorker, registers with viewportId
3. `useBroadcastAircraft` connects to aircraft SharedWorker, registers as consumer
4. `useInsetStoreSync` populates local Zustand stores from received data
5. Once `cesiumToken` is received and stores ready, `CesiumViewer` renders
6. `useAircraftInterpolation` detects inset context, registers `updateSharedStatesFromBroadcast` callback
7. `useCesiumLabels` sets up postRender callback to update labels each frame
8. Inset sends `inset-ready` to parent via postMessage

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ MAIN APP                                                                    │
│                                                                             │
│  ┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────┐   │
│  │ useAircraft-     │───>│ AircraftBroadcast-  │───>│ broadcast-       │   │
│  │ Interpolation    │    │ Service             │    │ encoder.worker   │   │
│  │ (60Hz loop)      │    │ (singleton)         │    │ (encoding)       │   │
│  └──────────────────┘    └─────────────────────┘    └────────┬─────────┘   │
│                                                               │             │
│  ┌──────────────────┐    ┌─────────────────────┐              │             │
│  │ Settings-        │───>│ shared-data.worker  │◄─────────────┼──────┐      │
│  │ SharedWorker-    │    │ (settings channel)  │              │      │      │
│  │ Service          │    └─────────────────────┘              │      │      │
│  └──────────────────┘                                         │      │      │
│                                                               ▼      │      │
│  ┌──────────────────┐                          ┌──────────────────┐  │      │
│  │ InsetCesium-     │◄─────postMessage────────>│ aircraft-        │  │      │
│  │ Viewer (wrapper) │                          │ broadcast.worker │  │      │
│  └────────┬─────────┘                          │ (routing)        │  │      │
│           │                                    └────────┬─────────┘  │      │
└───────────┼─────────────────────────────────────────────┼────────────┼──────┘
            │ iframe                                      │            │
┌───────────▼─────────────────────────────────────────────┼────────────┼──────┐
│ INSET (inset.html)                                      │            │      │
│                                                         │            │      │
│  ┌──────────────────┐    ┌─────────────────────┐        │            │      │
│  │ InsetApp         │    │ useBroadcast-       │◄───────┘            │      │
│  │                  │───>│ Aircraft            │                     │      │
│  └──────────────────┘    │ (consumer)          │                     │      │
│           │              └──────────┬──────────┘                     │      │
│           │                         │ callback                       │      │
│           │              ┌──────────▼──────────┐                     │      │
│           │              │ useAircraft-        │                     │      │
│           │              │ Interpolation       │                     │      │
│           │              │ (NO loop, just      │                     │      │
│           │              │  receives data)     │                     │      │
│           │              └──────────┬──────────┘                     │      │
│           │                         │                                │      │
│           │              ┌──────────▼──────────┐    ┌──────────────┐ │      │
│           │              │ sharedInterpolated- │───>│ useCesium-   │ │      │
│           │              │ States (Map)        │    │ Labels       │ │      │
│           │              └─────────────────────┘    │ (60Hz render)│ │      │
│           │                                         └──────────────┘ │      │
│           │              ┌─────────────────────┐                     │      │
│           └─────────────>│ useSharedWorker-    │◄────────────────────┘      │
│                          │ Consumer            │                            │
│                          │ (settings/weather)  │                            │
│                          └──────────┬──────────┘                            │
│                                     │                                       │
│                          ┌──────────▼──────────┐                            │
│                          │ useInsetStoreSync   │                            │
│                          │ (populates stores)  │                            │
│                          └─────────────────────┘                            │
│                                                                             │
│  ┌──────────────────┐                                                       │
│  │ CesiumViewer     │  (same component as main, with isInset=true)          │
│  │ + Babylon labels │                                                       │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
