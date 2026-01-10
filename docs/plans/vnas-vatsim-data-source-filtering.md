# vNAS/VATSIM Data Source Filtering and 1Hz Interpolation Tuning

## Problem Statement

When both vNAS (1Hz real-time) and VATSIM (15-second polling) are providing data for the same aircraft, the interpolation system can become confused:

1. **Stale VATSIM data pollutes the timeline**: VATSIM's `last_updated` timestamp may be 15+ seconds old by the time we receive it, while vNAS provides real-time positions
2. **Interpolation artifacts**: Mixing stale and fresh data causes aircraft to appear to "jump back" or have erratic motion
3. **1Hz update rate**: The interpolation system was originally designed for 15-second updates; 1Hz may benefit from tuning

## Current Data Flow

### VATSIM Path
```
VATSIM API (every ~15s)
  → vatsimStore.fetchData()
  → Parse update_timestamp → vatsimTimestamp (Unix ms)
  → Create observation with observedAt: vatsimTimestamp
  → aircraftTimelineStore.addObservationBatch()
```

### vNAS Path
```
vNAS Backend (1Hz via SignalR/UDP)
  → vnasStore.handleAircraftUpdate()
  → Create observation with observedAt: now
  → aircraftTimelineStore.addObservation()
```

### Key Insight
Both paths independently push to `aircraftTimelineStore`. Even though `useAircraftDataSource` prefers vNAS in the merged state map, VATSIM observations still enter the timeline and can affect interpolation.

## Part 1: VATSIM Filtering When vNAS Active

### Proposed Solution

Filter VATSIM observations in `addObservationBatch()` when vNAS has recently provided data for the same aircraft.

**Why time-based instead of timestamp comparison:**
VATSIM's `last_updated` field has unknown per-aircraft latency. The data is aggregated network-wide from thousands of pilots, each with different update frequencies and network conditions. We can't trust that `last_updated = T` means the position was actually valid at time T.

Instead, we use a simple time-based buffer: if we've received vNAS data for an aircraft within the last N seconds, we ignore VATSIM position data for that aircraft.

**Logic:**
```typescript
const VNAS_ACTIVE_THRESHOLD_MS = 5000  // 5 seconds

For each incoming VATSIM observation:
  1. Check if aircraft has an existing timeline with lastSource === 'vnas'
  2. If yes, apply two checks:

     Check 1 (time-based): Is vNAS still active?
     - Calculate timeSinceVnasUpdate = now - timeline.lastReceivedAt
     - If timeSinceVnasUpdate < 5 seconds:
       → SKIP (vNAS is actively sending)

     Check 2 (timestamp-based): Is VATSIM data actually newer?
     - Compare VATSIM observedAt vs newest existing observation's observedAt
     - If VATSIM observedAt <= newest existing observedAt:
       → SKIP (would insert stale data into middle of timeline)

  3. If both checks pass: ACCEPT the observation
```

**Why two checks?**
- Check 1 handles the unknown latency in VATSIM's `last_updated` by using a time buffer
- Check 2 ensures we never insert observations that would go "backwards" in time, even after the buffer expires

### Implementation Location

**File:** `src/renderer/stores/aircraftTimelineStore.ts`
**Function:** `addObservationBatch()` (line 962)

### Proposed Code Change

```typescript
addObservationBatch: (batch) => {
  const { timelines } = get()
  const updated = new Map(timelines)

  for (const { callsign, observation, metadata } of batch) {
    const existing = updated.get(callsign)

    // === NEW: Skip VATSIM data when vNAS is/was active ===
    const VNAS_ACTIVE_THRESHOLD_MS = 5000  // 5 seconds
    if (observation.source === 'vatsim' && existing && existing.lastSource === 'vnas') {
      const timeSinceVnasUpdate = observation.receivedAt - existing.lastReceivedAt
      const newestExisting = existing.observations[existing.observations.length - 1]

      // Check 1: vNAS data is recent (within threshold)
      if (timeSinceVnasUpdate < VNAS_ACTIVE_THRESHOLD_MS) {
        updated.set(callsign, {
          ...existing,
          metadata: {
            ...existing.metadata,
            departure: metadata.departure ?? existing.metadata.departure,
            arrival: metadata.arrival ?? existing.metadata.arrival,
          }
        })
        continue
      }

      // Check 2: Even if threshold passed, don't insert stale data
      if (newestExisting && observation.observedAt <= newestExisting.observedAt) {
        updated.set(callsign, {
          ...existing,
          metadata: {
            ...existing.metadata,
            departure: metadata.departure ?? existing.metadata.departure,
            arrival: metadata.arrival ?? existing.metadata.arrival,
          }
        })
        continue
      }
    }
    // === END NEW ===

    // ... existing observation handling code ...
  }

  set({ timelines: updated })
}
```

### Edge Cases Handled

1. **Aircraft enters vNAS coverage**: vNAS starts sending, immediately suppresses VATSIM
2. **Aircraft leaves vNAS coverage**: vNAS stops, after a few seconds VATSIM observations become "newer" and take over
3. **vNAS connection drops**: vNAS observations stop arriving, VATSIM naturally becomes primary again
4. **Aircraft only on VATSIM**: No vNAS data exists, VATSIM works normally
5. **Metadata preservation**: Flight plan info from VATSIM is preserved even when position data is skipped

### Graceful Fallback Timing

With this approach, fallback to VATSIM happens automatically when:
- vNAS stops sending data for an aircraft
- 5 seconds pass without vNAS updates
- Next VATSIM poll arrives and is accepted

Since VATSIM polls every ~15 seconds, worst-case fallback is ~20 seconds after vNAS stops (5s threshold + up to 15s until next VATSIM poll).

---

## Part 2: Interpolation Tuning for 1Hz Updates

### Current Constants Analysis

| Constant | Value | At 15s updates | At 1Hz updates |
|----------|-------|----------------|----------------|
| `MAX_OBSERVATIONS_PER_AIRCRAFT` | 30 | 7.5 min history | **30 sec history** |
| `SOURCE_DISPLAY_DELAYS.vnas` | 1500ms | N/A | 1.5 sec behind |
| `SOURCE_DISPLAY_DELAYS.vatsim` | 17000ms | 17 sec behind | N/A |
| `MAX_EXTRAPOLATION_TIME` | 30000ms | 2 updates | **30 updates** |
| `MIN_OBSERVATION_INTERVAL` | 100ms | No effect | No effect |

### Potential Issues at 1Hz

#### 1. Anchor Shift Frequency

**Current behavior:**
- Observations are stored in a ring buffer (max 30)
- The oldest observation is the "anchor" for `displayTime` calculation
- When buffer is full, oldest observation is pruned on each new addition
- At 1Hz: anchor shifts every second (vs every 15s for VATSIM)

**Analysis:**
The `displayTime` formula is designed to be anchor-independent:
```typescript
displayTime = oldestObs.observedAt + (now - oldestObs.receivedAt) - displayDelay
```

Since vNAS sets `observedAt = receivedAt = now`, the formula simplifies to:
```typescript
displayTime = now - displayDelay
```

This means anchor shifts don't cause displayTime jumps. **No issue here.**

However, the reconciliation system detects anchor changes and triggers re-reconciliation:
```typescript
const anchorChanged = reconciliation && reconciliation.anchorObservedAt !== oldestObs.observedAt
const isNewTarget = !reconciliation || reconciliation.targetObservedAt !== after.observedAt || anchorChanged
```

At 1Hz with a full buffer, this creates a new reconciliation every second. While visually correct (uses `lastRenderedPos`), it's unnecessary overhead.

**Recommendation:** Consider skipping anchor-change reconciliation when the displayTime delta is below a threshold (e.g., < 100ms).

#### 2. Altitude Smoothing Thresholds

**Current behavior:**
```typescript
const RATE_CHANGE_THRESHOLD = 100  // m/min - significant change threshold
```

At 15s intervals, altitude changes between observations can be significant (aircraft climbs ~750m in 15s at 3000 fpm).

At 1Hz, altitude changes are ~50m per observation (at 3000 fpm), making rate calculations noisier due to floating-point precision.

**Recommendation:** No change needed - the threshold is for detecting phase transitions (level → climb), not for smoothing individual samples. The 100 m/min threshold works at both rates.

#### 3. Memory Usage

**Current:** 30 observations × N aircraft
**At 1Hz:** Only 30 seconds of history (vs 7.5 minutes for VATSIM)

This is actually fine - we only need 2-3 observations for interpolation. 30 seconds is plenty for vNAS.

**Recommendation:** No change needed. Could reduce to 15 for vNAS-only scenarios but not worth the complexity.

#### 4. Extrapolation Behavior

**Current:** `MAX_EXTRAPOLATION_TIME = 30000ms`

At 1Hz, if we miss 30 updates, something is seriously wrong. At 15s, missing 2 updates triggers max extrapolation.

**Recommendation:** Consider source-aware extrapolation limits:
- vNAS: 5-10 seconds (5-10 missed updates = connection issue)
- VATSIM: 30 seconds (2 missed updates = normal variance)

This would require tracking `lastSource` and applying different limits.

### Recommended Changes

#### Change 1: Source-Aware Max Extrapolation (Optional Enhancement)

```typescript
// In constants/aircraft-timeline.ts
export const SOURCE_MAX_EXTRAPOLATION: Record<AircraftDataSource, number> = {
  vatsim: 30000,      // 30 seconds (2 missed updates)
  vnas: 10000,        // 10 seconds (10 missed updates)
  realtraffic: 15000, // 15 seconds
  replay: 30000       // 30 seconds
}
```

Then in `interpolateTimeline()`:
```typescript
const maxExtrapolation = SOURCE_MAX_EXTRAPOLATION[lastSource] ?? MAX_EXTRAPOLATION_TIME
const clampedExtrapolation = Math.min(extrapolationTime, maxExtrapolation)
```

**Priority:** Low - current behavior works, this is a polish item.

#### Change 2: Skip Trivial Anchor Reconciliations (Optional Enhancement)

```typescript
// In interpolateTimeline(), modify the anchorChanged check:
const anchorChanged = reconciliation && reconciliation.anchorObservedAt !== oldestObs.observedAt

// Only trigger reconciliation for significant anchor shifts
const anchorShiftMs = anchorChanged
  ? Math.abs(oldestObs.observedAt - reconciliation.anchorObservedAt)
  : 0
const significantAnchorShift = anchorShiftMs > 500  // More than 500ms

const isNewTarget = !reconciliation
  || reconciliation.targetObservedAt !== after.observedAt
  || significantAnchorShift  // Changed from anchorChanged
```

**Priority:** Low - current behavior is correct, this reduces unnecessary object allocation.

---

## Implementation Priority

### Phase 1: Critical (Implement Now)
1. **VATSIM filtering in `addObservationBatch()`** - Prevents data conflicts

### Phase 2: Nice to Have (Future Polish)
2. Source-aware max extrapolation - Better behavior when vNAS drops
3. Skip trivial anchor reconciliations - Performance optimization

---

## Testing Plan

### Manual Testing
1. Connect to VATSIM with active airport traffic
2. Enable vNAS connection
3. Verify aircraft on the surface use vNAS (check `source` in debug overlay)
4. Verify aircraft outside vNAS coverage use VATSIM
5. Disconnect vNAS, verify graceful fallback to VATSIM within ~15 seconds
6. Reconnect vNAS, verify smooth transition back

### Automated Testing
- Unit test for `addObservationBatch` filtering logic
- Test case: vNAS received 2s ago, VATSIM arrives → VATSIM skipped (within 5s threshold)
- Test case: vNAS received 6s ago, VATSIM observedAt is newer → VATSIM accepted
- Test case: vNAS received 6s ago, VATSIM observedAt is older than newest vNAS → VATSIM skipped (stale data)
- Test case: No vNAS data (lastSource !== 'vnas'), VATSIM arrives → accepted
- Test case: vNAS received 4s ago, VATSIM arrives with metadata → position skipped, metadata preserved

---

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/stores/aircraftTimelineStore.ts` | Add filtering in `addObservationBatch()` |
| `src/renderer/constants/aircraft-timeline.ts` | (Optional) Add `SOURCE_MAX_EXTRAPOLATION` |
