# Plan: Unified Aircraft Broadcasting

## Problem

Aircraft position data needs to flow from the main interpolation loop to multiple consumers:
1. **Remote browsers** - Access via network WebSocket
2. **Inset iframes** - Access via SharedWorker/postMessage

Currently, both systems are planned separately with different data paths. This leads to:
- Duplicate serialization logic
- Inconsistent update rates
- No shared optimization infrastructure
- postMessage calls on every interpolation frame (60Hz) for insets

## Proposed Solution

**Single broadcast system** that serves both remote clients and inset iframes with optimized, batched updates.

```
Main App (60Hz interpolation)
│
├─ AircraftBroadcastService (30Hz throttled)
│   │
│   ├─ Binary encoding (MessagePack)
│   ├─ Delta compression
│   ├─ Adaptive rate control
│   │
│   └─ Broadcast Channels
│       ├─ SharedWorker → Inset iframes (same-origin)
│       └─ WebSocket → Remote browsers (network)
│
├─ Inset iframes
│   └─ SharedWorker consumer → Direct render
│
└─ Remote browsers
    └─ WebSocket consumer → Direct render
```

## Benefits

1. **Single optimization point** - All consumers benefit from the same compression
2. **Reduced postMessage overhead** - 30Hz instead of 60Hz, smaller payloads
3. **Consistent behavior** - Insets and remote clients use identical data path
4. **Simpler architecture** - One broadcast service, multiple transports

---

## Bandwidth Optimizations

### 1. Binary Encoding (MessagePack)

Replace JSON with MessagePack for ~50% size reduction.

**JSON (current):**
```json
{"callsign":"AAL123","latitude":33.9425,"longitude":-118.4081,"altitude":1500.5,"heading":270.5,"groundspeed":145.2,"pitch":2.1,"roll":-5.3}
```
~150 bytes per aircraft

**MessagePack:**
- Same data: ~80 bytes per aircraft
- Use `@msgpack/msgpack` (browser) and `rmp-serde` (Rust)

### 2. Delta Compression

Only send fields that changed since last broadcast.

```typescript
interface AircraftDelta {
  c: string           // callsign (always present, used as key)
  la?: number         // latitude (if changed > threshold)
  lo?: number         // longitude (if changed > threshold)
  al?: number         // altitude (if changed > 1m)
  hd?: number         // heading (if changed > 0.5°)
  gs?: number         // groundspeed (if changed > 0.5kt)
  pi?: number         // pitch (if changed > 0.5°)
  ro?: number         // roll (if changed > 0.5°)
}

interface BroadcastMessage {
  t: number                    // timestamp
  f: AircraftFull[]           // full state for new aircraft
  d: AircraftDelta[]          // deltas for existing aircraft
  r: string[]                 // removed callsigns
}
```

**Thresholds for "changed":**
- Position: > 0.00001° (~1m)
- Altitude: > 1m
- Heading/pitch/roll: > 0.5°
- Groundspeed: > 0.5 knots

**Estimated savings:**
- Stationary aircraft: 90% reduction (only callsign sent)
- Cruising aircraft: 60% reduction (position changes, orientation stable)
- Maneuvering aircraft: 30% reduction (most fields change)

### 3. Adaptive Rate Control

Reduce broadcast frequency based on aircraft count and network conditions.

```typescript
function calculateBroadcastInterval(aircraftCount: number): number {
  if (aircraftCount < 50) return 33    // 30Hz
  if (aircraftCount < 100) return 50   // 20Hz
  if (aircraftCount < 200) return 66   // 15Hz
  return 100                           // 10Hz
}
```

### 4. Quantization

Reduce precision for fields that don't need full f64:

```typescript
// Before sending
const encoded = {
  la: Math.round(latitude * 1e6) / 1e6,      // 6 decimal places (~0.1m)
  lo: Math.round(longitude * 1e6) / 1e6,
  al: Math.round(altitude),                   // 1m precision
  hd: Math.round(heading * 10) / 10,         // 0.1° precision
  gs: Math.round(groundspeed * 10) / 10,     // 0.1kt precision
  pi: Math.round(pitch * 10) / 10,           // 0.1° precision
  ro: Math.round(roll * 10) / 10,            // 0.1° precision
}
```

### 5. Viewport Culling (Optional, Phase 2)

For insets with different camera views, only send aircraft visible to each viewport.

```typescript
// Main app tracks each inset's view frustum
// Only broadcasts aircraft within that frustum + margin
// Reduces data for zoomed-in tower views significantly
```

---

## Bandwidth Estimates

### Worst Case (no optimizations, JSON, 30Hz)
- 100 aircraft × 150 bytes × 30Hz = **450 KB/s**

### With MessagePack only
- 100 aircraft × 80 bytes × 30Hz = **240 KB/s**

### With MessagePack + Delta Compression (typical)
- 10 new/removed + 30 maneuvering + 60 stable
- (10 × 80) + (30 × 50) + (60 × 10) = 2,900 bytes per frame
- 2,900 × 30Hz = **87 KB/s**

### With Adaptive Rate (200 aircraft scenario)
- 10Hz instead of 30Hz
- **29 KB/s**

---

## Implementation

### Phase 1: Core Broadcast Service

**File: `src/renderer/services/AircraftBroadcastService.ts`**

```typescript
import { encode } from '@msgpack/msgpack'

interface BroadcastState {
  lastBroadcast: Map<string, AircraftSnapshot>
  lastBroadcastTime: number
}

class AircraftBroadcastService {
  private state: BroadcastState = {
    lastBroadcast: new Map(),
    lastBroadcastTime: 0,
  }

  private sharedWorker: SharedWorker | null = null
  private wsConnections: Set<WebSocket> = new Set()

  /**
   * Called from interpolation loop at 60Hz.
   * Throttles and optimizes before broadcasting.
   */
  broadcast(
    aircraft: Map<string, InterpolatedAircraftState>,
    now: number
  ): void {
    // Adaptive rate control
    const interval = this.calculateInterval(aircraft.size)
    if (now - this.state.lastBroadcastTime < interval) return

    // Build delta message
    const message = this.buildDeltaMessage(aircraft, now)

    // Encode to MessagePack
    const encoded = encode(message)

    // Broadcast to all channels
    this.broadcastToSharedWorker(encoded)
    this.broadcastToWebSockets(encoded)

    // Update state
    this.state.lastBroadcastTime = now
    this.updateLastBroadcast(aircraft)
  }

  private buildDeltaMessage(
    aircraft: Map<string, InterpolatedAircraftState>,
    now: number
  ): BroadcastMessage {
    const full: AircraftFull[] = []
    const deltas: AircraftDelta[] = []
    const removed: string[] = []

    // Find new and changed aircraft
    for (const [callsign, state] of aircraft) {
      const last = this.state.lastBroadcast.get(callsign)
      if (!last) {
        // New aircraft - send full state
        full.push(this.toFull(state))
      } else {
        // Existing aircraft - send delta
        const delta = this.toDelta(state, last)
        if (delta) deltas.push(delta)
      }
    }

    // Find removed aircraft
    for (const callsign of this.state.lastBroadcast.keys()) {
      if (!aircraft.has(callsign)) {
        removed.push(callsign)
      }
    }

    return { t: now, f: full, d: deltas, r: removed }
  }

  private toDelta(
    current: InterpolatedAircraftState,
    last: AircraftSnapshot
  ): AircraftDelta | null {
    const delta: AircraftDelta = { c: current.callsign }
    let hasChanges = false

    if (Math.abs(current.interpolatedLatitude - last.la) > 0.00001) {
      delta.la = this.quantize(current.interpolatedLatitude, 6)
      hasChanges = true
    }
    // ... similar for other fields

    return hasChanges ? delta : null
  }
}

export const aircraftBroadcastService = new AircraftBroadcastService()
```

### Phase 2: SharedWorker Transport (Insets)

**File: `src/renderer/workers/aircraft-broadcast.worker.ts`**

```typescript
// SharedWorker that receives broadcasts and fans out to insets
const ports: Set<MessagePort> = new Set()

self.onconnect = (e: MessageEvent) => {
  const port = e.ports[0]
  ports.add(port)

  port.onmessage = (event) => {
    if (event.data.type === 'broadcast') {
      // Forward to all connected insets
      for (const p of ports) {
        if (p !== port) p.postMessage(event.data)
      }
    }
  }

  port.start()
}
```

### Phase 3: WebSocket Transport (Remote)

**File: `src-tauri/src/server.rs`**

```rust
// Receives MessagePack from frontend, broadcasts to WebSocket clients
async fn aircraft_broadcast_handler(
    State(state): State<Arc<ServerState>>,
    body: Bytes,
) -> StatusCode {
    // Forward raw MessagePack to all connected WebSocket clients
    let _ = state.aircraft_tx.send(body.to_vec());
    StatusCode::OK
}

async fn aircraft_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_aircraft_ws(socket, state))
}

async fn handle_aircraft_ws(socket: WebSocket, state: Arc<ServerState>) {
    let (mut sender, _) = socket.split();
    let mut rx = state.aircraft_tx.subscribe();

    while let Ok(data) = rx.recv().await {
        if sender.send(Message::Binary(data)).await.is_err() {
            break;
        }
    }
}
```

### Phase 4: Consumer Hooks

**File: `src/renderer/hooks/useBroadcastAircraft.ts`**

```typescript
import { decode } from '@msgpack/msgpack'

/**
 * Hook for consuming broadcast aircraft data.
 * Used by both insets (SharedWorker) and remote clients (WebSocket).
 */
export function useBroadcastAircraft(): Map<string, InterpolatedAircraftState> {
  const [aircraft, setAircraft] = useState(new Map())
  const stateRef = useRef(new Map())

  useEffect(() => {
    const isInset = isInsetContext()
    const isRemote = isRemoteMode()

    if (!isInset && !isRemote) return // Main app doesn't consume

    let cleanup: () => void

    if (isInset) {
      // Connect to SharedWorker
      const worker = new SharedWorker('/workers/aircraft-broadcast.worker.js')
      worker.port.onmessage = (e) => handleMessage(e.data)
      worker.port.start()
      cleanup = () => worker.port.close()
    } else {
      // Connect to WebSocket
      const ws = new WebSocket(`ws://${getHostAddress()}/api/aircraft-ws`)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (e) => handleMessage(new Uint8Array(e.data))
      cleanup = () => ws.close()
    }

    function handleMessage(data: Uint8Array) {
      const msg = decode(data) as BroadcastMessage
      applyDelta(stateRef.current, msg)
      setAircraft(new Map(stateRef.current))
    }

    return cleanup
  }, [])

  return aircraft
}

function applyDelta(
  state: Map<string, InterpolatedAircraftState>,
  msg: BroadcastMessage
): void {
  // Apply full states (new aircraft)
  for (const full of msg.f) {
    state.set(full.c, fromFull(full))
  }

  // Apply deltas (changed aircraft)
  for (const delta of msg.d) {
    const existing = state.get(delta.c)
    if (existing) {
      state.set(delta.c, applyDeltaToState(existing, delta))
    }
  }

  // Remove departed aircraft
  for (const callsign of msg.r) {
    state.delete(callsign)
  }
}
```

### Phase 5: Integration with useAircraftInterpolation

**File: `src/renderer/hooks/useAircraftInterpolation.ts`**

```typescript
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  // Consumers (insets, remote) receive broadcast data
  if (isInsetContext() || isRemoteMode()) {
    return useBroadcastAircraft()
  }

  // Main app runs interpolation and broadcasts
  // ... existing interpolation code ...

  // At end of interpolation loop:
  if (isTauriMode()) {
    aircraftBroadcastService.broadcast(sharedInterpolatedStates, now)
  }

  return sharedInterpolatedStates
}
```

---

## Files Summary

### New Files
- `src/renderer/services/AircraftBroadcastService.ts` - Core broadcast logic
- `src/renderer/workers/aircraft-broadcast.worker.ts` - SharedWorker for insets
- `src/renderer/hooks/useBroadcastAircraft.ts` - Consumer hook
- `src/renderer/types/broadcast.ts` - Message types

### Modified Files
- `src/renderer/hooks/useAircraftInterpolation.ts` - Add broadcast calls
- `src-tauri/src/server.rs` - Add WebSocket endpoint
- `src-tauri/src/lib.rs` - Add broadcast command
- `package.json` - Add `@msgpack/msgpack` dependency
- `src-tauri/Cargo.toml` - Add `rmp-serde` dependency

---

## Migration from Current Inset Plan

The iframe-inset-isolation plan's SharedWorker data broadcasting is superseded by this unified approach:

| iframe-inset-isolation.md | This Plan |
|---------------------------|-----------|
| Posts every frame (60Hz) | Throttled (30Hz adaptive) |
| Full JSON objects | Delta + MessagePack |
| Inset-only SharedWorker | Unified for insets + remote |
| Separate from remote plan | Single broadcast service |

---

## Estimated Effort

- Phase 1 (Core service + delta compression): 3-4 hours
- Phase 2 (SharedWorker transport): 2 hours
- Phase 3 (WebSocket transport): 2 hours
- Phase 4 (Consumer hooks): 2 hours
- Phase 5 (Integration): 1 hour
- Testing: 2-3 hours

**Total: ~12-15 hours**

---

## Future Optimizations (Phase 2)

1. **Viewport culling** - Only send aircraft visible to each consumer
2. **Priority tiers** - Higher update rate for followed/selected aircraft
3. **Compression** - Apply zlib/brotli on top of MessagePack for very large fleets
4. **Binary protocol** - Custom binary format for maximum efficiency
