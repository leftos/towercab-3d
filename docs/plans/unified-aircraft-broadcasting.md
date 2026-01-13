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

### 3. Consumer-Driven Rate Control

Each consumer reports its processing capability; the broadcaster adjusts per-consumer.

**Consumer → Host feedback (every 500ms):**
```typescript
interface ConsumerFeedback {
  consumerId: string
  lastReceivedSeq: number      // Sequence number of last processed message
  bufferDepth: number          // Messages waiting to be processed
  avgProcessingMs: number      // Rolling average time to apply delta
}
```

**Host rate adjustment per consumer:**
```typescript
class ConsumerRateController {
  private consumers = new Map<string, ConsumerState>()

  // Called when feedback received from consumer
  onFeedback(feedback: ConsumerFeedback): void {
    const state = this.consumers.get(feedback.consumerId)
    if (!state) return

    // Calculate how far behind consumer is
    const lag = state.lastSentSeq - feedback.lastReceivedSeq

    // Adjust interval based on lag and buffer depth
    if (lag > 5 || feedback.bufferDepth > 3) {
      // Consumer falling behind - slow down
      state.interval = Math.min(state.interval * 1.5, 200) // Max 5Hz
    } else if (lag <= 1 && feedback.bufferDepth === 0) {
      // Consumer keeping up - can speed up
      state.interval = Math.max(state.interval * 0.8, 33)  // Max 30Hz
    }
  }

  // Check if we should send to this consumer now
  shouldSend(consumerId: string, now: number): boolean {
    const state = this.consumers.get(consumerId)
    if (!state) return false
    return now - state.lastSendTime >= state.interval
  }
}
```

**WebSocket backpressure (additional signal):**
```typescript
// Don't send if WebSocket buffer is backing up
if (ws.bufferedAmount > 50000) {
  // Skip this frame for this consumer
  return
}
```

**Benefits:**
- Fast consumers get 30Hz updates
- Slow consumers (weak tablets, poor WiFi) automatically get reduced rate
- No dropped frames - rate adapts instead of dropping
- Per-consumer optimization (insets fast, remote iPad slower)

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

### With Consumer-Driven Rate (slow consumer scenario)
- Tablet on weak WiFi adapts to 10Hz
- **29 KB/s** for that consumer, others stay at 30Hz

---

## Implementation

### Phase 1: Core Broadcast Service

**File: `src/renderer/services/AircraftBroadcastService.ts`**

```typescript
import { encode } from '@msgpack/msgpack'

interface ConsumerState {
  id: string
  lastSentSeq: number
  lastSendTime: number
  interval: number              // ms between sends (adapts based on feedback)
  transport: 'sharedworker' | 'websocket'
  port?: MessagePort            // For SharedWorker consumers
  ws?: WebSocket                // For WebSocket consumers
}

interface BroadcastState {
  lastBroadcast: Map<string, AircraftSnapshot>
  sequence: number
}

class AircraftBroadcastService {
  private state: BroadcastState = {
    lastBroadcast: new Map(),
    sequence: 0,
  }

  private consumers = new Map<string, ConsumerState>()

  /**
   * Called from interpolation loop at 60Hz.
   * Sends to each consumer based on their individual rate.
   */
  broadcast(
    aircraft: Map<string, InterpolatedAircraftState>,
    now: number
  ): void {
    // Build delta message once (shared across all consumers)
    const message = this.buildDeltaMessage(aircraft, now)
    const encoded = encode(message)

    this.state.sequence++

    // Send to each consumer if their interval has elapsed
    for (const [id, consumer] of this.consumers) {
      if (now - consumer.lastSendTime < consumer.interval) continue

      // Check backpressure for WebSocket consumers
      if (consumer.ws && consumer.ws.bufferedAmount > 50000) continue

      this.sendToConsumer(consumer, encoded)
      consumer.lastSendTime = now
      consumer.lastSentSeq = this.state.sequence
    }

    this.updateLastBroadcast(aircraft)
  }

  /**
   * Handle feedback from a consumer to adjust their rate.
   */
  onConsumerFeedback(feedback: ConsumerFeedback): void {
    const consumer = this.consumers.get(feedback.consumerId)
    if (!consumer) return

    const lag = consumer.lastSentSeq - feedback.lastReceivedSeq

    if (lag > 5 || feedback.bufferDepth > 3) {
      // Consumer falling behind - slow down (min 5Hz)
      consumer.interval = Math.min(consumer.interval * 1.5, 200)
    } else if (lag <= 1 && feedback.bufferDepth === 0 && feedback.avgProcessingMs < 10) {
      // Consumer keeping up easily - speed up (max 30Hz)
      consumer.interval = Math.max(consumer.interval * 0.8, 33)
    }
  }

  /**
   * Register a new consumer (inset or remote browser).
   */
  registerConsumer(
    id: string,
    transport: 'sharedworker' | 'websocket',
    connection: MessagePort | WebSocket
  ): void {
    this.consumers.set(id, {
      id,
      lastSentSeq: 0,
      lastSendTime: 0,
      interval: 33, // Start at 30Hz
      transport,
      port: transport === 'sharedworker' ? connection as MessagePort : undefined,
      ws: transport === 'websocket' ? connection as WebSocket : undefined,
    })
  }

  unregisterConsumer(id: string): void {
    this.consumers.delete(id)
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
// SharedWorker bridges main app ↔ inset iframes
// Main app sends broadcasts, insets send feedback

interface PortState {
  port: MessagePort
  consumerId: string
}

const insetPorts = new Map<string, PortState>()
let mainPort: MessagePort | null = null

self.onconnect = (e: MessageEvent) => {
  const port = e.ports[0]

  port.onmessage = (event) => {
    const { type, consumerId, data } = event.data

    switch (type) {
      case 'register-main':
        // Main app registers to send broadcasts
        mainPort = port
        break

      case 'register-inset':
        // Inset registers to receive broadcasts
        insetPorts.set(consumerId, { port, consumerId })
        // Notify main app of new consumer
        mainPort?.postMessage({ type: 'consumer-connected', consumerId })
        break

      case 'broadcast':
        // Main app sending broadcast - forward to all insets
        for (const { port: insetPort } of insetPorts.values()) {
          insetPort.postMessage({ type: 'aircraft', data })
        }
        break

      case 'feedback':
        // Inset sending feedback - forward to main app
        mainPort?.postMessage({ type: 'feedback', consumerId, data })
        break
    }
  }

  port.start()
}
```

### Phase 3: WebSocket Transport (Remote)

**File: `src-tauri/src/server.rs`**

The WebSocket is bidirectional: host sends aircraft data, remote sends feedback.

```rust
/// Per-consumer state tracked by the server
struct RemoteConsumer {
    id: String,
    tx: mpsc::Sender<Vec<u8>>,  // Channel to send data to this consumer
}

/// Handle aircraft WebSocket - bidirectional for data + feedback
async fn handle_aircraft_ws(
    socket: WebSocket,
    state: Arc<ServerState>,
    app_handle: AppHandle,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Generate unique consumer ID
    let consumer_id = Uuid::new_v4().to_string();

    // Create channel for this consumer's outbound messages
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);

    // Register consumer with frontend via Tauri event
    app_handle.emit("consumer-connected", &consumer_id).ok();

    // Task: Forward messages from channel to WebSocket
    let send_task = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if ws_sender.send(Message::Binary(data)).await.is_err() {
                break;
            }
        }
    });

    // Task: Receive feedback from WebSocket, forward to frontend
    let consumer_id_clone = consumer_id.clone();
    let app_handle_clone = app_handle.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_receiver.next().await {
            if let Message::Binary(data) = msg {
                // Forward feedback to frontend
                app_handle_clone.emit("consumer-feedback", (&consumer_id_clone, data)).ok();
            }
        }
    });

    // Store consumer for broadcasting
    state.remote_consumers.lock().await.insert(consumer_id.clone(), tx);

    // Wait for either task to complete (disconnect)
    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }

    // Cleanup
    state.remote_consumers.lock().await.remove(&consumer_id);
    app_handle.emit("consumer-disconnected", &consumer_id).ok();
}

/// Called by frontend to send data to a specific remote consumer
#[tauri::command]
async fn send_to_remote_consumer(
    state: State<'_, Arc<ServerState>>,
    consumer_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let consumers = state.remote_consumers.lock().await;
    if let Some(tx) = consumers.get(&consumer_id) {
        tx.send(data).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

### Phase 4: Consumer Hooks

**File: `src/renderer/hooks/useBroadcastAircraft.ts`**

```typescript
import { decode, encode } from '@msgpack/msgpack'

/**
 * Hook for consuming broadcast aircraft data.
 * Used by both insets (SharedWorker) and remote clients (WebSocket).
 * Sends periodic feedback to host for rate adaptation.
 */
export function useBroadcastAircraft(): Map<string, InterpolatedAircraftState> {
  const [aircraft, setAircraft] = useState(new Map())
  const stateRef = useRef(new Map())
  const statsRef = useRef({
    lastReceivedSeq: 0,
    bufferDepth: 0,
    processingTimes: [] as number[],
  })

  useEffect(() => {
    const isInset = isInsetContext()
    const isRemote = isRemoteMode()

    if (!isInset && !isRemote) return

    const consumerId = crypto.randomUUID()
    let sendFeedback: (feedback: ConsumerFeedback) => void
    let cleanup: () => void

    if (isInset) {
      // Connect to SharedWorker
      const worker = new SharedWorker('/workers/aircraft-broadcast.worker.js')
      worker.port.postMessage({ type: 'register-inset', consumerId })
      worker.port.onmessage = (e) => {
        if (e.data.type === 'aircraft') handleMessage(e.data.data)
      }
      worker.port.start()

      sendFeedback = (fb) => worker.port.postMessage({ type: 'feedback', consumerId, data: fb })
      cleanup = () => worker.port.close()
    } else {
      // Connect to WebSocket
      const ws = new WebSocket(`ws://${getHostAddress()}/api/aircraft-ws`)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = (e) => handleMessage(new Uint8Array(e.data))

      sendFeedback = (fb) => ws.send(encode(fb))
      cleanup = () => ws.close()
    }

    function handleMessage(data: Uint8Array) {
      const startTime = performance.now()

      const msg = decode(data) as BroadcastMessage
      statsRef.current.lastReceivedSeq = msg.seq
      applyDelta(stateRef.current, msg)
      setAircraft(new Map(stateRef.current))

      // Track processing time (rolling window of 10)
      const processingTime = performance.now() - startTime
      statsRef.current.processingTimes.push(processingTime)
      if (statsRef.current.processingTimes.length > 10) {
        statsRef.current.processingTimes.shift()
      }
    }

    // Send feedback every 500ms
    const feedbackInterval = setInterval(() => {
      const times = statsRef.current.processingTimes
      const avgProcessingMs = times.length > 0
        ? times.reduce((a, b) => a + b, 0) / times.length
        : 0

      sendFeedback({
        consumerId,
        lastReceivedSeq: statsRef.current.lastReceivedSeq,
        bufferDepth: 0, // Could track if using a queue
        avgProcessingMs,
      })
    }, 500)

    return () => {
      clearInterval(feedbackInterval)
      cleanup()
    }
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
| Posts every frame (60Hz) | Consumer-driven (5-30Hz) |
| Full JSON objects | Delta + MessagePack |
| Inset-only SharedWorker | Unified for insets + remote |
| Separate from remote plan | Single broadcast service |
| Fixed rate for all | Per-consumer adaptive rate |

---

## Estimated Effort

- Phase 1 (Core service + delta compression + rate control): 4-5 hours
- Phase 2 (SharedWorker transport + feedback): 2-3 hours
- Phase 3 (WebSocket transport + feedback): 3-4 hours
- Phase 4 (Consumer hooks + feedback): 2-3 hours
- Phase 5 (Integration): 1-2 hours
- Testing: 3-4 hours

**Total: ~15-21 hours**

---

## Future Optimizations

1. **Viewport culling** - Only send aircraft visible to each consumer's camera frustum
2. **Priority tiers** - Higher update rate for followed/selected aircraft
3. **Compression** - Apply zlib/brotli on top of MessagePack for very large fleets
4. **Binary protocol** - Custom binary format for maximum efficiency
5. **Predictive sending** - Send fuller updates when consumer rate is low to enable client-side extrapolation
