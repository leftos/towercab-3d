# Plan: Unified Aircraft Broadcasting for Remote Clients

## Problem

Remote browsers accessing TowerCab 3D over the network currently cannot use vNAS features. The original approach was to proxy all vNAS operations (auth, subscribe, etc.) to remote clients - but this is unnecessarily complex.

## Insight

The host already interpolates aircraft positions at 60Hz for its own rendering. Remote clients don't need to know about data sources (VATSIM, vNAS, RealTraffic) at all - they just need the final interpolated positions.

## Proposed Solution

**Broadcast interpolated aircraft state from host to remote clients.**

```
Desktop Host
├─ Data Sources (transparent to remote clients)
│   ├─ VATSIM (15s polling)
│   ├─ vNAS (1Hz, if connected)
│   └─ RealTraffic (2-3s, if configured)
│
├─ Timeline Store
│   └─ Unified observation storage
│
├─ useAircraftInterpolation (60Hz)
│   └─ sharedInterpolatedStates Map
│
└─ WebSocket Broadcast (30Hz)
    └─ /api/aircraft-ws
        └─ Serialized interpolated positions

Remote Browser
├─ WebSocket Connection
│   └─ Receives interpolated positions
│
└─ Rendering (no interpolation needed)
    └─ Direct display of received positions
```

## Benefits

1. **Simpler remote client** - No timeline store, no interpolation, no data source logic
2. **Data source agnostic** - Remote clients don't care if it's VATSIM, vNAS, or RealTraffic
3. **Eliminates vNAS proxy** - No need to proxy auth, subscriptions, or session management
4. **Consistent positions** - All clients see exactly the same aircraft positions
5. **Less bandwidth** - 30Hz updates vs. raw observations + client-side interpolation

## Implementation

### Phase 1: Backend WebSocket Broadcast

**File: `src-tauri/src/server.rs`**

Add a broadcast channel for interpolated aircraft state:

```rust
// In ServerState
pub struct ServerState {
    // ... existing fields
    aircraft_tx: broadcast::Sender<AircraftBroadcast>,
}

// Broadcast message format
#[derive(Serialize)]
struct AircraftBroadcast {
    timestamp: u64,
    aircraft: Vec<InterpolatedAircraft>,
}

#[derive(Serialize)]
struct InterpolatedAircraft {
    callsign: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,  // meters, ellipsoidal
    heading: f64,
    groundspeed: f64,
    pitch: f64,
    roll: f64,
    aircraft_type: Option<String>,
    departure: Option<String>,
    arrival: Option<String>,
}
```

Add WebSocket endpoint:

```rust
.route("/api/aircraft-ws", get(aircraft_websocket_handler))
```

### Phase 2: Frontend Broadcast from Interpolation Loop

**File: `src/renderer/hooks/useAircraftInterpolation.ts`**

Add broadcast to the interpolation loop (throttled to 30Hz):

```typescript
// At end of updateInterpolation()
if (isTauriMode() && shouldBroadcast(now)) {
  broadcastInterpolatedStates(sharedInterpolatedStates)
}
```

**File: `src/renderer/services/AircraftBroadcastService.ts`** (new)

```typescript
class AircraftBroadcastService {
  private lastBroadcast = 0
  private readonly BROADCAST_INTERVAL = 33 // ~30Hz

  async broadcast(states: Map<string, InterpolatedAircraftState>) {
    const now = Date.now()
    if (now - this.lastBroadcast < this.BROADCAST_INTERVAL) return
    this.lastBroadcast = now

    const payload = {
      timestamp: now,
      aircraft: Array.from(states.values()).map(s => ({
        callsign: s.callsign,
        latitude: s.interpolatedLatitude,
        longitude: s.interpolatedLongitude,
        altitude: s.interpolatedAltitude,
        heading: s.interpolatedHeading,
        groundspeed: s.interpolatedGroundspeed,
        pitch: s.interpolatedPitch,
        roll: s.interpolatedRoll,
        aircraftType: s.aircraftType,
        departure: s.departure,
        arrival: s.arrival,
      }))
    }

    await invoke('broadcast_aircraft', { payload })
  }
}
```

### Phase 3: Remote Client Receiver

**File: `src/renderer/hooks/useRemoteAircraftStream.ts`** (new)

```typescript
export function useRemoteAircraftStream(): Map<string, InterpolatedAircraftState> {
  const [aircraft, setAircraft] = useState(new Map())

  useEffect(() => {
    if (!isRemoteMode()) return

    const ws = new WebSocket(`ws://${getHostAddress()}/api/aircraft-ws`)

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      const newMap = new Map()
      for (const a of data.aircraft) {
        newMap.set(a.callsign, a)
      }
      setAircraft(newMap)
    }

    return () => ws.close()
  }, [])

  return aircraft
}
```

### Phase 4: Simplify Remote Mode

**File: `src/renderer/hooks/useAircraftInterpolation.ts`**

Update to use remote stream in remote mode:

```typescript
export function useAircraftInterpolation(): Map<string, InterpolatedAircraftState> {
  // In remote mode, receive pre-interpolated data
  if (isRemoteMode()) {
    return useRemoteAircraftStream()
  }

  // Desktop mode: run local interpolation
  // ... existing code
}
```

This makes the switch transparent to all consumers of `useAircraftInterpolation`.

---

## What This Eliminates

The following become unnecessary for remote mode:

- ❌ vNAS proxy endpoints (auth, subscribe, facilities, etc.)
- ❌ Timeline store in remote clients
- ❌ Data source detection/switching in remote mode
- ❌ Local interpolation in remote clients
- ❌ The original vNAS remote mode TODOs

The existing TODOs in vnasStore.ts can simply return early or throw in remote mode - remote clients don't need vNAS access because they receive unified interpolated data.

---

## Files to Modify

### Backend (Rust)
- `src-tauri/src/server.rs` - Add broadcast channel and WebSocket endpoint
- `src-tauri/src/lib.rs` - Add broadcast command

### Frontend (TypeScript)
- `src/renderer/services/AircraftBroadcastService.ts` (new) - Broadcast from host
- `src/renderer/hooks/useRemoteAircraftStream.ts` (new) - Receive on remote
- `src/renderer/hooks/useAircraftInterpolation.ts` - Switch based on mode

---

## Bandwidth Estimate

Per aircraft at 30Hz:
- ~200 bytes JSON per aircraft
- 100 aircraft × 200 bytes × 30Hz = 600 KB/s

This is reasonable for local network. Could add:
- Binary encoding (MessagePack) to reduce by ~50%
- Delta compression for stationary aircraft
- Adaptive rate based on aircraft count

---

## Estimated Effort

- Phase 1 (Backend broadcast): 2-3 hours
- Phase 2 (Frontend broadcast): 1-2 hours
- Phase 3 (Remote receiver): 1-2 hours
- Phase 4 (Mode switching): 1 hour
- Testing: 2 hours

**Total: ~8-10 hours** (down from 12-17 hours for the proxy approach)
