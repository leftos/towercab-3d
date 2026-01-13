# WASM Performance Architecture Plan

This document outlines a WebAssembly approach to move performance-critical calculations from TypeScript to Rust, achieving significant speedups while maintaining compatibility with both desktop (Tauri) and browser-only (`npm run serve`) modes.

## Executive Summary

**Goal:** Move 60Hz interpolation and culling logic to Rust/WASM for 5-10x performance improvement.

**Key Benefits:**
- Zero IPC overhead (WASM runs in the same JS context)
- Same Rust codebase works for both Tauri native and browser modes
- SharedArrayBuffer enables zero-copy data sharing
- SIMD instructions for batch calculations (supported in all modern browsers)

**Estimated Performance Gains:**
| Operation | Current (JS) | Target (WASM) | Improvement |
|-----------|-------------|---------------|-------------|
| Interpolation (500 aircraft) | 5-10ms | 0.5-1ms | 10x |
| Render culling | 2-5ms | <0.5ms | 5-10x |
| Distance calculations | 1-2ms | <0.2ms | 10x |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         React Application                                │
├─────────────────────────────────────────────────────────────────────────┤
│  useAircraftInterpolation.ts    useRenderCulling.ts                     │
│         ↓                              ↓                                 │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │              wasmInterpolation.ts (thin wrapper)             │       │
│  │  - Manages SharedArrayBuffer lifecycle                       │       │
│  │  - Converts Map<string, Aircraft> ↔ TypedArrays             │       │
│  │  - Handles WASM module loading and fallback                  │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                              ↓                                           │
├─────────────────────────────────────────────────────────────────────────┤
│                    WebAssembly Module (Rust)                             │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  towercab_wasm.wasm                                          │       │
│  │  - interpolate_all_aircraft(buffer_ptr, count, dt) → void    │       │
│  │  - cull_by_distance(buffer_ptr, count, camera, radius) → u32 │       │
│  │  - quickselect_closest(buffer_ptr, count, k) → void          │       │
│  │  - batch_haversine(positions_ptr, ref_lat, ref_lon) → void   │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                              ↓                                           │
│              Shared Memory (SharedArrayBuffer)                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │  Aircraft data laid out as Structure of Arrays (SoA):        │       │
│  │  [lat0, lat1, lat2, ...] [lon0, lon1, lon2, ...]             │       │
│  │  [alt0, alt1, alt2, ...] [hdg0, hdg1, hdg2, ...]             │       │
│  │  [spd0, spd1, spd2, ...] [pitch, roll, vrate, ...]           │       │
│  └──────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Layout Design

### Structure of Arrays (SoA) Format

For SIMD efficiency, we use Structure of Arrays instead of Array of Structures:

```rust
// Rust side - SoA layout enables SIMD vectorization
pub struct AircraftBuffer {
    // Input positions (from VATSIM/vNAS)
    pub prev_lat: Vec<f64>,
    pub prev_lon: Vec<f64>,
    pub prev_alt: Vec<f64>,
    pub prev_hdg: Vec<f64>,
    pub prev_spd: Vec<f64>,
    pub prev_timestamp: Vec<f64>,

    pub curr_lat: Vec<f64>,
    pub curr_lon: Vec<f64>,
    pub curr_alt: Vec<f64>,
    pub curr_hdg: Vec<f64>,
    pub curr_spd: Vec<f64>,
    pub curr_timestamp: Vec<f64>,

    // Output (interpolated values)
    pub interp_lat: Vec<f64>,
    pub interp_lon: Vec<f64>,
    pub interp_alt: Vec<f64>,
    pub interp_hdg: Vec<f64>,
    pub interp_spd: Vec<f64>,
    pub interp_pitch: Vec<f64>,
    pub interp_roll: Vec<f64>,

    // Per-aircraft state (persisted across frames)
    pub smoothed_terrain_height: Vec<f64>,
    pub smoothed_heading: Vec<f64>,
    pub smoothed_vertical_rate: Vec<f64>,
    pub smoothed_turn_rate: Vec<f64>,

    // Scratch space for culling
    pub distances: Vec<f64>,
    pub active_mask: Vec<u8>,  // 1 = render, 0 = culled

    // Metadata
    pub count: u32,
    pub capacity: u32,
}
```

### TypeScript Wrapper

```typescript
// wasmInterpolation.ts

interface WasmAircraftBuffer {
  // Pointers into SharedArrayBuffer
  prevLat: Float64Array
  prevLon: Float64Array
  prevAlt: Float64Array
  prevHdg: Float64Array
  prevSpd: Float64Array
  prevTimestamp: Float64Array

  currLat: Float64Array
  currLon: Float64Array
  currAlt: Float64Array
  currHdg: Float64Array
  currSpd: Float64Array
  currTimestamp: Float64Array

  interpLat: Float64Array
  interpLon: Float64Array
  interpAlt: Float64Array
  interpHdg: Float64Array
  interpSpd: Float64Array
  interpPitch: Float64Array
  interpRoll: Float64Array

  distances: Float64Array
  activeMask: Uint8Array

  // Callsign index for mapping back to JS objects
  callsignIndex: Map<string, number>
  indexToCallsign: string[]
}

// Singleton buffer manager
class WasmBufferManager {
  private buffer: SharedArrayBuffer | null = null
  private arrays: WasmAircraftBuffer | null = null
  private capacity = 0

  ensureCapacity(count: number): WasmAircraftBuffer {
    const requiredCapacity = Math.max(512, nextPowerOf2(count))

    if (this.capacity < requiredCapacity) {
      this.allocateBuffer(requiredCapacity)
    }

    return this.arrays!
  }

  private allocateBuffer(capacity: number) {
    // Calculate total bytes needed
    // 18 Float64Arrays + 1 Uint8Array
    const f64ArrayCount = 18
    const bytesPerAircraft = f64ArrayCount * 8 + 1
    const totalBytes = capacity * bytesPerAircraft + 64 // 64 bytes header

    this.buffer = new SharedArrayBuffer(totalBytes)
    this.arrays = this.createArrayViews(this.buffer, capacity)
    this.capacity = capacity
  }

  private createArrayViews(buffer: SharedArrayBuffer, capacity: number): WasmAircraftBuffer {
    let offset = 64 // Skip header
    const createF64 = () => {
      const arr = new Float64Array(buffer, offset, capacity)
      offset += capacity * 8
      return arr
    }

    return {
      prevLat: createF64(),
      prevLon: createF64(),
      prevAlt: createF64(),
      prevHdg: createF64(),
      prevSpd: createF64(),
      prevTimestamp: createF64(),

      currLat: createF64(),
      currLon: createF64(),
      currAlt: createF64(),
      currHdg: createF64(),
      currSpd: createF64(),
      currTimestamp: createF64(),

      interpLat: createF64(),
      interpLon: createF64(),
      interpAlt: createF64(),
      interpHdg: createF64(),
      interpSpd: createF64(),
      interpPitch: createF64(),
      interpRoll: createF64(),

      distances: createF64(),
      activeMask: new Uint8Array(buffer, offset, capacity),

      callsignIndex: new Map(),
      indexToCallsign: []
    }
  }
}
```

## WASM Module Implementation

### Rust Crate Structure

```
src-wasm/
├── Cargo.toml
├── src/
│   ├── lib.rs              # WASM entry points
│   ├── interpolation.rs    # Position/heading interpolation
│   ├── orientation.rs      # Pitch/roll calculation
│   ├── culling.rs          # Distance culling & quickselect
│   ├── geo_math.rs         # Haversine, bearing, etc.
│   └── simd.rs             # SIMD-optimized batch operations
```

### Core Interpolation (Rust)

```rust
// src-wasm/src/interpolation.rs

use std::f64::consts::PI;

const DEG_TO_RAD: f64 = PI / 180.0;
const RAD_TO_DEG: f64 = 180.0 / PI;
const NM_TO_DEGREES_LAT: f64 = 1.0 / 60.0;
const KNOTS_TO_NM_PER_MS: f64 = 1.0 / 3_600_000.0;

/// Hermite spline interpolation coefficient
#[inline]
fn hermite_basis(t: f64) -> (f64, f64, f64, f64) {
    let t2 = t * t;
    let t3 = t2 * t;
    (
        2.0 * t3 - 3.0 * t2 + 1.0,  // h00
        t3 - 2.0 * t2 + t,          // h10
        -2.0 * t3 + 3.0 * t2,       // h01
        t3 - t2                      // h11
    )
}

/// Interpolate position using Hermite splines
#[inline]
pub fn hermite_interpolate(
    p0: f64, m0: f64,
    p1: f64, m1: f64,
    t: f64
) -> f64 {
    let (h00, h10, h01, h11) = hermite_basis(t);
    h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

/// Calculate velocity in degrees/ms from heading and groundspeed
#[inline]
fn heading_to_velocity(heading_deg: f64, groundspeed_knots: f64, lat: f64) -> (f64, f64) {
    let speed_deg_per_ms = groundspeed_knots * KNOTS_TO_NM_PER_MS * NM_TO_DEGREES_LAT;
    let heading_rad = heading_deg * DEG_TO_RAD;
    let cos_lat = (lat * DEG_TO_RAD).cos();

    let d_lat = speed_deg_per_ms * heading_rad.cos();
    let d_lon = if cos_lat > 0.001 {
        (speed_deg_per_ms * heading_rad.sin()) / cos_lat
    } else {
        0.0
    };

    (d_lat, d_lon)
}

/// Interpolate all aircraft positions in batch
///
/// # Safety
/// Caller must ensure all slices have at least `count` elements
pub fn interpolate_positions_batch(
    prev_lat: &[f64], prev_lon: &[f64], prev_hdg: &[f64], prev_spd: &[f64], prev_ts: &[f64],
    curr_lat: &[f64], curr_lon: &[f64], curr_hdg: &[f64], curr_spd: &[f64], curr_ts: &[f64],
    out_lat: &mut [f64], out_lon: &mut [f64], out_hdg: &mut [f64],
    now: f64,
    count: usize
) {
    for i in 0..count {
        let interval = curr_ts[i] - prev_ts[i];
        if interval <= 0.0 {
            // No interpolation possible
            out_lat[i] = curr_lat[i];
            out_lon[i] = curr_lon[i];
            out_hdg[i] = curr_hdg[i];
            continue;
        }

        let t = (now - prev_ts[i]) / interval;

        if t <= 1.0 {
            // Hermite interpolation
            let (prev_dlat, prev_dlon) = heading_to_velocity(prev_hdg[i], prev_spd[i], prev_lat[i]);
            let (curr_dlat, curr_dlon) = heading_to_velocity(curr_hdg[i], curr_spd[i], curr_lat[i]);

            let m0_lat = prev_dlat * interval;
            let m0_lon = prev_dlon * interval;
            let m1_lat = curr_dlat * interval;
            let m1_lon = curr_dlon * interval;

            out_lat[i] = hermite_interpolate(prev_lat[i], m0_lat, curr_lat[i], m1_lat, t);
            out_lon[i] = hermite_interpolate(prev_lon[i], m0_lon, curr_lon[i], m1_lon, t);
            out_hdg[i] = lerp_angle(prev_hdg[i], curr_hdg[i], t);
        } else {
            // Dead reckoning extrapolation
            let extrap_ms = (t - 1.0) * interval;
            let (d_lat, d_lon) = heading_to_velocity(curr_hdg[i], curr_spd[i], curr_lat[i]);

            out_lat[i] = curr_lat[i] + d_lat * extrap_ms;
            out_lon[i] = curr_lon[i] + d_lon * extrap_ms;
            out_hdg[i] = curr_hdg[i]; // Hold heading during extrapolation
        }
    }
}

/// Angle interpolation handling 0-360 wraparound
#[inline]
fn lerp_angle(a: f64, b: f64, t: f64) -> f64 {
    let mut diff = b - a;
    if diff > 180.0 { diff -= 360.0; }
    if diff < -180.0 { diff += 360.0; }

    let result = a + diff * t;
    ((result % 360.0) + 360.0) % 360.0
}
```

### SIMD-Optimized Distance Calculations

```rust
// src-wasm/src/simd.rs

#[cfg(target_arch = "wasm32")]
use std::arch::wasm32::*;

const EARTH_RADIUS_NM: f64 = 3440.065;

/// Batch calculate Haversine distances using SIMD
/// Processes 4 aircraft at a time using WASM SIMD
#[cfg(target_arch = "wasm32")]
pub fn batch_haversine_simd(
    ref_lat: f64, ref_lon: f64,
    lats: &[f64], lons: &[f64],
    distances: &mut [f64],
    count: usize
) {
    let ref_lat_rad = ref_lat * DEG_TO_RAD;
    let ref_lon_rad = ref_lon * DEG_TO_RAD;
    let cos_ref_lat = ref_lat_rad.cos();

    // Process 4 at a time with SIMD
    let chunks = count / 4;
    for chunk in 0..chunks {
        let base = chunk * 4;

        // Load 4 lat/lon pairs
        let lat_vec = f64x2_make(lats[base], lats[base + 1]);
        let lat_vec2 = f64x2_make(lats[base + 2], lats[base + 3]);
        // ... SIMD Haversine implementation
    }

    // Handle remainder with scalar
    for i in (chunks * 4)..count {
        distances[i] = haversine_scalar(ref_lat, ref_lon, lats[i], lons[i]);
    }
}

/// Scalar Haversine for fallback/remainder
#[inline]
fn haversine_scalar(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let d_lat = (lat2 - lat1) * DEG_TO_RAD;
    let d_lon = (lon2 - lon1) * DEG_TO_RAD;

    let lat1_rad = lat1 * DEG_TO_RAD;
    let lat2_rad = lat2 * DEG_TO_RAD;

    let a = (d_lat / 2.0).sin().powi(2)
          + lat1_rad.cos() * lat2_rad.cos() * (d_lon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();

    EARTH_RADIUS_NM * c
}
```

### WASM Bindings

```rust
// src-wasm/src/lib.rs

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct InterpolationEngine {
    // Persistent state across frames
    smoothed_terrain: Vec<f64>,
    smoothed_heading: Vec<f64>,
    smoothed_vrate: Vec<f64>,
    smoothed_turn_rate: Vec<f64>,
    capacity: usize,
}

#[wasm_bindgen]
impl InterpolationEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(initial_capacity: usize) -> Self {
        Self {
            smoothed_terrain: vec![0.0; initial_capacity],
            smoothed_heading: vec![0.0; initial_capacity],
            smoothed_vrate: vec![0.0; initial_capacity],
            smoothed_turn_rate: vec![0.0; initial_capacity],
            capacity: initial_capacity,
        }
    }

    /// Main interpolation entry point
    /// Called once per frame with all aircraft data
    #[wasm_bindgen]
    pub fn interpolate_all(
        &mut self,
        // Previous frame positions
        prev_lat: &[f64], prev_lon: &[f64], prev_alt: &[f64],
        prev_hdg: &[f64], prev_spd: &[f64], prev_ts: &[f64],
        // Current frame positions
        curr_lat: &[f64], curr_lon: &[f64], curr_alt: &[f64],
        curr_hdg: &[f64], curr_spd: &[f64], curr_ts: &[f64],
        // Output arrays (mutated in place)
        out_lat: &mut [f64], out_lon: &mut [f64], out_alt: &mut [f64],
        out_hdg: &mut [f64], out_spd: &mut [f64],
        out_pitch: &mut [f64], out_roll: &mut [f64],
        // Parameters
        now: f64,
        count: usize,
        orientation_enabled: bool,
        orientation_intensity: f64,
    ) {
        self.ensure_capacity(count);

        // Position interpolation
        interpolation::interpolate_positions_batch(
            prev_lat, prev_lon, prev_hdg, prev_spd, prev_ts,
            curr_lat, curr_lon, curr_hdg, curr_spd, curr_ts,
            out_lat, out_lon, out_hdg,
            now, count
        );

        // Altitude interpolation (linear)
        for i in 0..count {
            let interval = curr_ts[i] - prev_ts[i];
            let t = if interval > 0.0 {
                ((now - prev_ts[i]) / interval).min(1.5)
            } else {
                1.0
            };
            out_alt[i] = prev_alt[i] + (curr_alt[i] - prev_alt[i]) * t.min(1.0);
            out_spd[i] = prev_spd[i] + (curr_spd[i] - prev_spd[i]) * t.min(1.0);
        }

        // Orientation calculation
        if orientation_enabled {
            orientation::calculate_orientation_batch(
                prev_alt, curr_alt,
                prev_hdg, curr_hdg,
                curr_spd, prev_ts, curr_ts,
                out_pitch, out_roll,
                &mut self.smoothed_vrate,
                &mut self.smoothed_turn_rate,
                now, count, orientation_intensity
            );
        }
    }

    /// Cull aircraft by distance and return count of visible
    #[wasm_bindgen]
    pub fn cull_by_distance(
        &self,
        lats: &[f64], lons: &[f64],
        ref_lat: f64, ref_lon: f64,
        max_distance_nm: f64,
        distances_out: &mut [f64],
        active_mask: &mut [u8],
        count: usize,
    ) -> usize {
        simd::batch_haversine_simd(ref_lat, ref_lon, lats, lons, distances_out, count);

        let mut visible_count = 0;
        for i in 0..count {
            if distances_out[i] <= max_distance_nm {
                active_mask[i] = 1;
                visible_count += 1;
            } else {
                active_mask[i] = 0;
            }
        }
        visible_count
    }

    /// In-place quickselect to find k closest aircraft
    #[wasm_bindgen]
    pub fn quickselect_closest(
        &self,
        distances: &mut [f64],
        indices: &mut [u32],
        k: usize,
        count: usize,
    ) {
        culling::quickselect_with_indices(distances, indices, k, count);
    }

    fn ensure_capacity(&mut self, count: usize) {
        if count > self.capacity {
            let new_capacity = count.next_power_of_two();
            self.smoothed_terrain.resize(new_capacity, 0.0);
            self.smoothed_heading.resize(new_capacity, 0.0);
            self.smoothed_vrate.resize(new_capacity, 0.0);
            self.smoothed_turn_rate.resize(new_capacity, 0.0);
            self.capacity = new_capacity;
        }
    }
}
```

## TypeScript Integration

### WASM Module Loader

```typescript
// src/renderer/wasm/wasmLoader.ts

import init, { InterpolationEngine } from '../../../src-wasm/pkg/towercab_wasm'

let wasmModule: typeof import('../../../src-wasm/pkg/towercab_wasm') | null = null
let engine: InterpolationEngine | null = null
let wasmSupported = true

export async function initWasm(): Promise<boolean> {
  try {
    // Check for required features
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('SharedArrayBuffer not available, falling back to JS interpolation')
      wasmSupported = false
      return false
    }

    // Load WASM module
    wasmModule = await init()
    engine = new InterpolationEngine(512)

    console.log('WASM interpolation engine initialized')
    return true
  } catch (error) {
    console.warn('Failed to initialize WASM, falling back to JS:', error)
    wasmSupported = false
    return false
  }
}

export function isWasmAvailable(): boolean {
  return wasmSupported && engine !== null
}

export function getEngine(): InterpolationEngine | null {
  return engine
}
```

### Integration with useAircraftInterpolation

```typescript
// Modified useAircraftInterpolation.ts

import { isWasmAvailable, getEngine } from '../wasm/wasmLoader'
import { WasmBufferManager } from '../wasm/wasmBuffer'

const bufferManager = new WasmBufferManager()

function updateInterpolationWasm(
  aircraftStates: Map<string, AircraftState>,
  previousStates: Map<string, AircraftState>,
  now: number,
  orientationEnabled: boolean,
  orientationIntensity: number
): void {
  const engine = getEngine()
  if (!engine) return

  const count = aircraftStates.size
  const buffer = bufferManager.ensureCapacity(count)

  // Sync JS Map to TypedArrays
  let idx = 0
  buffer.callsignIndex.clear()
  buffer.indexToCallsign.length = 0

  for (const [callsign, curr] of aircraftStates) {
    const prev = previousStates.get(callsign)

    buffer.callsignIndex.set(callsign, idx)
    buffer.indexToCallsign.push(callsign)

    // Previous state
    buffer.prevLat[idx] = prev?.latitude ?? curr.latitude
    buffer.prevLon[idx] = prev?.longitude ?? curr.longitude
    buffer.prevAlt[idx] = prev?.altitude ?? curr.altitude
    buffer.prevHdg[idx] = prev?.heading ?? curr.heading
    buffer.prevSpd[idx] = prev?.groundspeed ?? curr.groundspeed
    buffer.prevTimestamp[idx] = prev?.timestamp ?? curr.timestamp

    // Current state
    buffer.currLat[idx] = curr.latitude
    buffer.currLon[idx] = curr.longitude
    buffer.currAlt[idx] = curr.altitude
    buffer.currHdg[idx] = curr.heading
    buffer.currSpd[idx] = curr.groundspeed
    buffer.currTimestamp[idx] = curr.timestamp

    idx++
  }

  // Call WASM interpolation (operates on TypedArrays directly)
  engine.interpolate_all(
    buffer.prevLat, buffer.prevLon, buffer.prevAlt,
    buffer.prevHdg, buffer.prevSpd, buffer.prevTimestamp,
    buffer.currLat, buffer.currLon, buffer.currAlt,
    buffer.currHdg, buffer.currSpd, buffer.currTimestamp,
    buffer.interpLat, buffer.interpLon, buffer.interpAlt,
    buffer.interpHdg, buffer.interpSpd,
    buffer.interpPitch, buffer.interpRoll,
    now, count,
    orientationEnabled, orientationIntensity
  )

  // Sync results back to sharedInterpolatedStates Map
  for (let i = 0; i < count; i++) {
    const callsign = buffer.indexToCallsign[i]
    const curr = aircraftStates.get(callsign)!

    let entry = sharedInterpolatedStates.get(callsign)
    if (!entry) {
      entry = { ...curr } as InterpolatedAircraftState
      sharedInterpolatedStates.set(callsign, entry)
    }

    entry.interpolatedLatitude = buffer.interpLat[i]
    entry.interpolatedLongitude = buffer.interpLon[i]
    entry.interpolatedAltitude = buffer.interpAlt[i]
    entry.interpolatedHeading = buffer.interpHdg[i]
    entry.interpolatedGroundspeed = buffer.interpSpd[i]
    entry.interpolatedPitch = buffer.interpPitch[i]
    entry.interpolatedRoll = buffer.interpRoll[i]
  }
}

// In the animation loop:
function updateInterpolation() {
  performanceMonitor.startTimer('interpolation')

  // ... get source data ...

  if (isWasmAvailable()) {
    updateInterpolationWasm(
      source.aircraftStates,
      source.previousStates,
      now,
      orientationEnabled,
      orientationIntensity
    )
  } else {
    // Fallback to existing JS implementation
    updateInterpolationJS(/* ... */)
  }

  performanceMonitor.endTimer('interpolation')
  animationFrameId = requestAnimationFrame(updateInterpolation)
}
```

## Build Configuration

### Cargo.toml for WASM Crate

```toml
# src-wasm/Cargo.toml
[package]
name = "towercab-wasm"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"

[profile.release]
opt-level = 3
lto = true

[package.metadata.wasm-pack.profile.release]
wasm-opt = ["-O4", "--enable-simd"]
```

### Build Script Integration

```json
// package.json additions
{
  "scripts": {
    "wasm:build": "cd src-wasm && wasm-pack build --target web --out-dir ../src/renderer/wasm/pkg",
    "wasm:build:dev": "cd src-wasm && wasm-pack build --target web --dev --out-dir ../src/renderer/wasm/pkg",
    "dev": "npm run wasm:build:dev && tauri dev",
    "build": "npm run wasm:build && tauri build"
  }
}
```

### Vite Configuration

```typescript
// vite.config.ts additions
export default defineConfig({
  // ...existing config...

  optimizeDeps: {
    exclude: ['towercab-wasm']  // Don't pre-bundle WASM
  },

  build: {
    target: 'esnext',  // Required for top-level await
  },

  server: {
    headers: {
      // Required for SharedArrayBuffer
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
```

## Fallback Strategy

The architecture supports graceful degradation:

```typescript
// Automatic fallback flow
async function initializeInterpolation() {
  // Try WASM first
  const wasmAvailable = await initWasm()

  if (wasmAvailable) {
    console.log('Using WASM interpolation (10x faster)')
  } else {
    console.log('Using JavaScript interpolation (fallback)')
  }
}

// In animation loop - transparent switching
function updateInterpolation() {
  if (isWasmAvailable()) {
    updateInterpolationWasm(/* ... */)
  } else {
    updateInterpolationJS(/* ... */)  // Existing implementation
  }
}
```

**Fallback triggers:**
- SharedArrayBuffer unavailable (older browsers, non-secure contexts)
- WASM module fails to load
- SIMD not supported (graceful degradation to scalar WASM)

## Performance Benchmarks (Expected)

Based on similar WASM migrations:

| Scenario | JS (current) | WASM | WASM+SIMD |
|----------|-------------|------|-----------|
| 100 aircraft | 1-2ms | 0.2ms | 0.1ms |
| 300 aircraft | 3-5ms | 0.5ms | 0.3ms |
| 500 aircraft | 5-10ms | 0.8ms | 0.5ms |
| 1000 aircraft | 12-20ms | 1.5ms | 1.0ms |

**Key wins:**
- No GC pressure (TypedArrays are fixed-size, no object allocation per frame)
- SIMD processes 4 distance calculations simultaneously
- Tight loops compile to efficient machine code
- No JIT warm-up issues

## Implementation Phases

### Phase 1: Core Infrastructure (1-2 days)
- [ ] Create `src-wasm/` crate with wasm-pack
- [ ] Implement `WasmBufferManager` and TypedArray management
- [ ] Add build scripts to package.json
- [ ] Configure Vite for WASM + SharedArrayBuffer

### Phase 2: Position Interpolation (2-3 days)
- [ ] Port Hermite interpolation to Rust
- [ ] Port dead reckoning extrapolation
- [ ] Port heading interpolation with wraparound
- [ ] Integration tests comparing JS vs WASM output

### Phase 3: Orientation Calculation (1-2 days)
- [ ] Port pitch/roll calculation
- [ ] Port rate smoothing logic
- [ ] Port flare pitch calculation

### Phase 4: Distance & Culling (1-2 days)
- [ ] Port Haversine distance calculation
- [ ] Add SIMD batch distance calculation
- [ ] Port quickselect algorithm
- [ ] Integrate with useRenderCulling

### Phase 5: Terrain Correction (1 day)
- [ ] Port terrain height smoothing
- [ ] Port landing/departure blending
- [ ] Port terrain slope application

### Phase 6: Testing & Optimization (2-3 days)
- [ ] Comprehensive comparison tests
- [ ] Performance benchmarking
- [ ] Edge case handling (empty data, single aircraft, etc.)
- [ ] Memory leak testing

## Security Considerations

- **SharedArrayBuffer**: Requires secure context (HTTPS) and COOP/COEP headers
- **WASM Sandbox**: WASM runs in browser sandbox, no file system access
- **Memory Safety**: Rust's borrow checker prevents buffer overflows
- **No eval()**: WASM doesn't use eval, safe for CSP

## Design Decisions

1. **Timeline store integration**: Yes - timeline interpolation moves to WASM for consistency and performance.

2. **Terrain data**: Yes - terrain heights passed to WASM. Terrain correction runs entirely in WASM.

3. **No JS fallback**: WASM is the only implementation. No fallback code to maintain. This requires:
   - SharedArrayBuffer support (all modern browsers since 2020)
   - COOP/COEP headers configured
   - Build must include WASM compilation

4. **Inset viewports**: Insets receive pre-interpolated data via SharedWorker. WASM runs in main app only; insets consume the results.
