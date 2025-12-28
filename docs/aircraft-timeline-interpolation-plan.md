# Aircraft Timeline Interpolation Plan

## Problem Statement

Currently, each data source (VATSIM HTTP, vNAS, RealTraffic) has its own interpolation logic with different timing assumptions. This causes issues:

1. **RealTraffic timing mismatch**: Poll interval (~2s) doesn't match ADS-B observation intervals (1.5-4.5s), causing speed-up/slow-down artifacts
2. **No unified model**: Each source handles timestamps differently, making it hard to blend data
3. **vNAS transitions**: Aircraft crossing vNAS range boundaries need smooth transitions between 1Hz and 15s data
4. **Source mixing**: An aircraft could have observations from multiple sources that need unified handling

## Solution: Per-Aircraft Observation Timeline

### Core Concept

Each aircraft maintains a timeline of observations from any source. At render time, we:
1. Determine the appropriate display delay based on the most recent source
2. Calculate `displayTime = now - delay`
3. Find observations bracketing `displayTime` and interpolate
4. If no bracketing data, extrapolate from most recent observation

### Display Delays by Source

| Source | Delay | Rationale |
|--------|-------|-----------|
| VATSIM HTTP | 15s | Snapshots are 15s apart |
| vNAS | 2s | 1Hz updates, need 2+ observations |
| RealTraffic | 5s | P90 apiDelta is ~4s |

## Data Structures

### New Types (in `types/aircraft-timeline.ts`)

```typescript
/**
 * Data source identifier
 */
export type AircraftDataSource = 'vatsim' | 'vnas' | 'realtraffic'

/**
 * Single position observation for an aircraft
 */
export interface AircraftObservation {
  // Position
  latitude: number
  longitude: number
  altitude: number  // meters

  // Movement
  heading: number
  groundspeed: number  // knots
  groundTrack: number | null  // For extrapolation direction

  // Timing
  observedAt: number  // When this position was TRUE (apiTimestamp, vnas timestamp, etc.) in ms
  receivedAt: number  // When we received this data (Date.now()) in ms

  // Source
  source: AircraftDataSource
}

/**
 * Complete timeline for a single aircraft
 */
export interface AircraftTimeline {
  callsign: string

  // Ring buffer of observations, newest last
  // Keep enough for the longest delay (VATSIM 15s) + buffer
  observations: AircraftObservation[]

  // Metadata (from most recent observation)
  cid: number
  aircraftType: string | null
  transponder: string
  departure: string | null
  arrival: string | null

  // Tracking
  lastSource: AircraftDataSource
  lastReceivedAt: number
}

/**
 * Interpolated state ready for rendering
 */
export interface InterpolatedAircraftState {
  callsign: string
  latitude: number
  longitude: number
  altitude: number
  heading: number
  groundspeed: number

  // Metadata
  cid: number
  aircraftType: string | null
  transponder: string
  departure: string | null
  arrival: string | null

  // Debug info
  source: AircraftDataSource
  displayDelay: number  // Current delay being used
  isExtrapolating: boolean  // True if beyond last observation
  observationAge: number  // How old is the observation we're using
}
```

### Constants (in `constants/aircraft-timeline.ts`)

```typescript
/** Display delays per source in milliseconds */
export const SOURCE_DISPLAY_DELAYS: Record<AircraftDataSource, number> = {
  vatsim: 15000,    // 15 seconds
  vnas: 2000,       // 2 seconds
  realtraffic: 5000 // 5 seconds
}

/** Maximum observations to keep per aircraft */
export const MAX_OBSERVATIONS_PER_AIRCRAFT = 30

/** Maximum extrapolation time before considering aircraft stale (ms) */
export const MAX_EXTRAPOLATION_TIME = 30000  // 30 seconds

/** Time without updates before removing aircraft (ms) */
export const AIRCRAFT_TIMEOUT = 60000  // 60 seconds
```

## New Store: `aircraftTimelineStore.ts`

Central store that:
1. Receives observations from all sources
2. Maintains per-aircraft timelines
3. Provides interpolated states for rendering

### Interface

```typescript
interface AircraftTimelineStore {
  // State
  timelines: Map<string, AircraftTimeline>

  // Actions - called by data sources
  addObservation: (callsign: string, observation: AircraftObservation, metadata: AircraftMetadata) => void
  addObservationBatch: (observations: Array<{callsign: string, observation: AircraftObservation, metadata: AircraftMetadata}>) => void
  removeAircraft: (callsign: string) => void
  pruneStaleAircraft: () => void

  // Getters - called by rendering
  getInterpolatedStates: (now: number) => Map<string, InterpolatedAircraftState>
  getInterpolatedState: (callsign: string, now: number) => InterpolatedAircraftState | null
}
```

## Interpolation Logic

### `getInterpolatedState(callsign, now)`

```
1. Get timeline for callsign
2. If no timeline, return null

3. Determine display delay:
   - delay = SOURCE_DISPLAY_DELAYS[timeline.lastSource]
   - displayTime = now - delay

4. Find bracketing observations:
   - Search observations for obs1.observedAt <= displayTime <= obs2.observedAt

5. If bracketing found (INTERPOLATION):
   - t = (displayTime - obs1.observedAt) / (obs2.observedAt - obs1.observedAt)
   - Interpolate all values using t
   - isExtrapolating = false

6. If displayTime > all observations (EXTRAPOLATION):
   - Use most recent observation
   - extrapolationTime = displayTime - mostRecent.observedAt
   - If extrapolationTime > MAX_EXTRAPOLATION_TIME, clamp or mark stale
   - Extrapolate position using groundspeed and groundTrack
   - isExtrapolating = true

7. If displayTime < all observations (CATCHING UP):
   - Use oldest observation as-is (rare edge case during transitions)

8. Return InterpolatedAircraftState
```

### Position Extrapolation

```typescript
function extrapolatePosition(
  obs: AircraftObservation,
  extrapolationTimeMs: number
): { latitude: number, longitude: number } {
  const seconds = extrapolationTimeMs / 1000
  const track = obs.groundTrack ?? obs.heading
  const speedMps = obs.groundspeed * 0.514444  // knots to m/s
  const distance = speedMps * seconds

  // Simple flat-earth approximation (good enough for short extrapolations)
  const trackRad = track * Math.PI / 180
  const latOffset = (distance * Math.cos(trackRad)) / 111320
  const lonOffset = (distance * Math.sin(trackRad)) / (111320 * Math.cos(obs.latitude * Math.PI / 180))

  return {
    latitude: obs.latitude + latOffset,
    longitude: obs.longitude + lonOffset
  }
}
```

## Source Integration

### VATSIM HTTP (`vatsimStore.ts`)

On each poll:
```typescript
for (const pilot of pilots) {
  const observation: AircraftObservation = {
    latitude: pilot.latitude,
    longitude: pilot.longitude,
    altitude: pilot.altitude * 0.3048,
    heading: pilot.heading,
    groundspeed: pilot.groundspeed,
    groundTrack: null,  // VATSIM doesn't provide this
    observedAt: vatsimTimestamp * 1000,  // From VATSIM API
    receivedAt: Date.now(),
    source: 'vatsim'
  }

  aircraftTimelineStore.addObservation(pilot.callsign, observation, metadata)
}
```

### vNAS (`vnasStore.ts`)

On each aircraft update:
```typescript
const observation: AircraftObservation = {
  latitude: aircraft.lat,
  longitude: aircraft.lon,
  altitude: aircraft.altitudeTrue,
  heading: aircraft.trueHeading,
  groundspeed: 0,  // Calculate from position delta if needed
  groundTrack: aircraft.trueGroundTrack,
  observedAt: aircraft.timestamp,  // vNAS provides this
  receivedAt: Date.now(),
  source: 'vnas'
}

aircraftTimelineStore.addObservation(aircraft.callsign, observation, metadata)
```

### RealTraffic (`realTrafficStore.ts`)

On each poll:
```typescript
for (const aircraft of result.aircraft) {
  const observation: AircraftObservation = {
    latitude: aircraft.latitude,
    longitude: aircraft.longitude,
    altitude: aircraft.altitude,
    heading: aircraft.heading,
    groundspeed: aircraft.groundspeed,
    groundTrack: aircraft.groundTrack,
    observedAt: aircraft.apiTimestamp * 1000,  // Convert to ms
    receivedAt: Date.now(),
    source: 'realtraffic'
  }

  aircraftTimelineStore.addObservation(aircraft.callsign, observation, metadata)
}
```

## Rendering Integration

### `useAircraftInterpolation.ts`

Replace current interpolation logic with:

```typescript
function updateInterpolation() {
  const now = Date.now()
  const interpolatedStates = aircraftTimelineStore.getState().getInterpolatedStates(now)

  // Convert to render format and update refs
  // ...
}
```

### `useAircraftDataSource.ts`

This hook currently unifies VATSIM/vNAS/RealTraffic stores. It will change to:
1. Return `aircraftTimelineStore` data instead of individual stores
2. Or be simplified since the timeline store handles unification

## Transition Behavior

### VATSIM → vNAS Transition

1. Aircraft starts with only VATSIM observations (15s apart)
2. Displayed with 15s delay
3. First vNAS observation arrives
4. `lastSource` becomes `'vnas'`, delay drops to 2s
5. `displayTime` jumps forward by 13s
6. We interpolate from last VATSIM position toward current vNAS position
7. Aircraft visually "catches up" smoothly

### vNAS → VATSIM Transition

1. Aircraft has vNAS observations (1Hz), displayed with 2s delay
2. vNAS updates stop (aircraft left range)
3. We extrapolate from last vNAS observation
4. Eventually VATSIM HTTP provides new observation
5. `lastSource` becomes `'vatsim'`, delay increases to 15s
6. We're now extrapolating heavily, but that's okay since VATSIM is inherently delayed
7. Next VATSIM snapshot provides correction

## Implementation Steps

### Phase 1: Core Infrastructure
1. [ ] Create `types/aircraft-timeline.ts` with new types
2. [ ] Create `constants/aircraft-timeline.ts` with delay constants
3. [ ] Create `stores/aircraftTimelineStore.ts` with basic structure
4. [ ] Implement `addObservation` and observation ring buffer management
5. [ ] Implement `getInterpolatedState` with bracketing search and interpolation

### Phase 2: Source Integration
6. [ ] Modify `realTrafficStore.ts` to feed observations into timeline store
7. [ ] Test RealTraffic in isolation - verify smooth interpolation
8. [ ] Modify `vatsimStore.ts` to feed observations into timeline store
9. [ ] Modify `vnasStore.ts` to feed observations into timeline store

### Phase 3: Rendering Integration
10. [ ] Modify `useAircraftInterpolation.ts` to use timeline store
11. [ ] Modify `useAircraftDataSource.ts` to expose timeline store data
12. [ ] Update any components that access aircraft state directly

### Phase 4: Cleanup
13. [ ] Remove old interpolation logic from individual stores
14. [ ] Remove `previousStates` and `aircraftStates` from individual stores (or keep for legacy)
15. [ ] Add debug overlay to visualize delays and extrapolation status
16. [ ] Performance testing with many aircraft

## Open Questions

1. **Groundspeed for vNAS**: vNAS doesn't provide groundspeed directly. Calculate from position deltas, or use a default for extrapolation?

2. **VATSIM timestamp accuracy**: Does VATSIM's timestamp represent observation time or server time? Need to verify.

3. **Smooth delay transitions**: Should we smoothly transition the delay when source changes, or is the interpolation "catch-up" sufficient?

4. **Memory management**: With 30 observations per aircraft and potentially 100+ aircraft, need to ensure efficient memory usage.

5. **Render culling**: Should the timeline store handle distance-based culling, or leave that to the rendering layer?
