# Ellipsoidal Height System Migration Plan

## Overview

Convert TowerCab 3D from mixed MSL/ellipsoidal height handling to a consistent **ellipsoidal-based internal system**. All heights/altitudes will be ellipsoidal internally, with MSL conversion only at input/output boundaries.

## Problem Statement

### Current State (Mixed Systems)

| Data Source | Current Format |
|-------------|----------------|
| VATSIM aircraft altitudes | MSL (feet) → meters MSL internally |
| RealTraffic altitudes | MSL (feet) |
| Airport elevations (OurAirports) | MSL (feet) |
| Runway elevations (OurAirports) | MSL (feet) |
| X-Plane apt.dat elevations | MSL (feet) |
| Cesium World Terrain | **Ellipsoidal (WGS84)** |
| OSM Buildings | **Ellipsoidal** |
| Terrain mesh vertices | **Ellipsoidal** |

### Current Hacks Due to Mismatch

1. **`terrainOffsetRef`** in CesiumViewer.tsx - bridges MSL aircraft altitudes to Cesium's ellipsoidal terrain
2. **`GROUND_AIRCRAFT_TERRAIN_OFFSET`** (0.1m) and **`FLYING_AIRCRAFT_TERRAIN_OFFSET`** (5m) - positioning hacks
3. **Building height offset** - compensates for terrain being at wrong height
4. **Terrain boundary "cliffs"** - where flattened terrain (MSL) meets original CWT (ellipsoidal)
5. **Complex ground clamping logic** - in useAircraftInterpolation.ts (~250 lines)

### The Core Bug

`FlatteningTerrainProvider` uses `polygon.elevation` (MSL meters) directly in terrain mesh (ellipsoidal coordinates), causing **15-40m height errors** depending on location's geoid separation.

---

## Solution Architecture

### Target State

```
┌─────────────────────────────────────────────────────────────┐
│ INPUT BOUNDARY (MSL → Ellipsoidal)                          │
├─────────────────────────────────────────────────────────────┤
│ VATSIM feet MSL ──→ GeoidService.mslToEllipsoidal() ──→ m  │
│ Airport elev ft  ──→ GeoidService.mslToEllipsoidal() ──→ m  │
│ Runway elev ft   ──→ GeoidService.mslToEllipsoidal() ──→ m  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ INTERNAL (All Ellipsoidal)                                  │
├─────────────────────────────────────────────────────────────┤
│ AircraftState.altitude      → meters ellipsoidal           │
│ FlatteningPolygon.elevation → meters ellipsoidal           │
│ Terrain mesh vertices       → meters ellipsoidal           │
│ All height comparisons      → ellipsoidal vs ellipsoidal   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ OUTPUT BOUNDARY (Ellipsoidal → MSL)                         │
├─────────────────────────────────────────────────────────────┤
│ Datablock altitude ──→ GeoidService.ellipsoidalToMsl() ──→ │
│ Debug displays     ──→ Show both (ellipsoidal + MSL)       │
└─────────────────────────────────────────────────────────────┘
```

### Geoid Conversion Strategy

Sample Cesium World Terrain at airport center to derive local geoid offset:

```typescript
// At airport initialization:
const sampledEllipsoidal = await sampleTerrain(lat, lon)  // CWT returns ellipsoidal
const knownMsl = airport.elevation * 0.3048               // Database has MSL
const geoidOffset = sampledEllipsoidal - knownMsl

// Conversion functions:
ellipsoidal = msl + geoidOffset
msl = ellipsoidal - geoidOffset
```

---

## Implementation Phases

### Phase 1: Create GeoidService

**Goal**: Establish geoid conversion infrastructure.

**New File**: `src/renderer/services/GeoidService.ts`

```typescript
class GeoidService {
  private geoidOffset: number = 0
  private referencePoint: { lat: number, lon: number } | null = null
  private initialized: boolean = false

  async initialize(
    lat: number,
    lon: number,
    mslElevationMeters: number,
    terrainProvider: Cesium.TerrainProvider
  ): Promise<void>

  mslToEllipsoidal(mslMeters: number): number
  ellipsoidalToMsl(ellipsoidalMeters: number): number
  getGeoidOffset(): number
  isInitialized(): boolean
}

export const geoidService = new GeoidService()
```

**Modify**: `src/renderer/components/CesiumViewer/CesiumViewer.tsx`
- Initialize GeoidService when airport changes (before other initialization)

**Testing**:
- At KBOS (geoid ~-30m): verify `mslToEllipsoidal(10) ≈ -20`
- At KDEN (geoid ~+15m): verify `mslToEllipsoidal(1600) ≈ 1615`

---

### Phase 2: Convert Terrain Flattening to Ellipsoidal

**Goal**: Flattened terrain heights match surrounding CWT (no "cliffs").

**Modify**: `src/renderer/services/AirportPolygonService.ts`
- `createRunwayPolygon()` line ~139: Convert elevation to ellipsoidal
- `calculateFieldElevation()` lines 53-78: Return ellipsoidal
- `createAirportFillPolygon()` line ~253: Use ellipsoidal elevation

**Modify**: `src/renderer/services/AirportSurfacesService.ts`
- `getPavementPolygons()` lines 199-211: Convert to ellipsoidal

**Modify**: `src/renderer/types/terrain.ts`
- Line 18-19: Update doc from "meters MSL" to "meters ellipsoidal (WGS84)"

**Modify**: `src/renderer/hooks/useTerrainFlattening.ts`
- Ensure GeoidService initialized before generating polygons

**Testing**:
- Sample terrain at runway threshold with flattening off vs on
- Heights should match (within 1m tolerance)
- No visible "cliff" at polygon boundary

---

### Phase 3: Convert Aircraft Data Ingestion to Ellipsoidal

**Goal**: All aircraft altitudes enter system as ellipsoidal.

**Modify**: `src/renderer/stores/vatsimStore.ts`
- Line 141: `altitude: geoidService.mslToEllipsoidal(pilot.altitude * 0.3048)`
- Lines 215-216: Timeline observations
- Line 256: Replay states
- Lines 385, 405: refilterPilots

**Modify**: `src/renderer/services/RealTrafficService.ts`
- Line ~395: Convert baro_alt to ellipsoidal

**Modify**: `src/renderer/types/vatsim.ts`
- Line 134: Update comment to "meters ellipsoidal"
- Line 205: Update `interpolatedAltitude` comment

**Handle Edge Case**: Data arriving before GeoidService initialized
- Buffer incoming data OR use 0 offset with warning log

**Testing**:
- Aircraft at FL100 should appear at correct height above terrain
- Ground aircraft should sit on terrain without clamping hacks

---

### Phase 4: Simplify Aircraft Interpolation

**Goal**: Remove terrain offset hacks since data is now ellipsoidal.

**Modify**: `src/renderer/hooks/useAircraftInterpolation.ts`

**Remove/Simplify** (lines 398-643):
- Remove `terrainOffsetRef` usage
- Remove `reportedEllipsoidHeight = heightAboveEllipsoid + terrainOffset` conversion
- Simplify ground clamping: just compare ellipsoidal altitude to terrain sample

**New Logic**:
```typescript
// Before (complex):
const heightAboveEllipsoid = entry.interpolatedAltitude  // MSL
const reportedEllipsoidHeight = heightAboveEllipsoid + terrainOffset  // Convert
const altitudeAGL = reportedEllipsoidHeight - sampledTerrainHeight

// After (simple):
const altitudeEllipsoidal = entry.interpolatedAltitude  // Already ellipsoidal
const altitudeAGL = altitudeEllipsoidal - sampledTerrainHeight

// Ground clamping:
if (isOnGround) {
  targetHeight = sampledTerrainHeight + 0.1  // Just z-fighting offset
}
```

**Modify**: `src/renderer/hooks/useGroundAircraftTerrain.ts`
- Lines 124-125: Simplify AGL calculation (both values now ellipsoidal)

**Modify**: `src/renderer/constants/rendering.ts`
- `FLYING_AIRCRAFT_TERRAIN_OFFSET`: Can be reduced (was geoid compensation, now just visual)
- Update comments to reflect new purpose

**Testing**:
- Ground aircraft sit correctly on terrain
- Takeoff/landing transitions smooth
- No "popping" when aircraft cross terrain sample boundaries

---

### Phase 5: Remove Hacks from CesiumViewer

**Goal**: Clean up workarounds that are no longer needed.

**Modify**: `src/renderer/components/CesiumViewer/CesiumViewer.tsx`
- Remove `terrainOffsetRef` (line 70)
- Remove terrain offset calculation effect (lines 707-763)
- Remove building height offset effect (lines 647-705)
- Simplify `setInterpolationTerrainData` call (lines 369-375)

**Modify**: `src/renderer/hooks/useBabylonRootNode.ts`
- Lines 254-256, 281-295: Use GeoidService instead of manual terrain sampling

**Modify**: `src/renderer/hooks/useCesiumLabels.ts`
- Remove `terrainOffset` parameter if present

**Testing**:
- Full integration at KBOS, KLAX, KDEN (various geoid offsets)
- Buildings sit correctly on flattened terrain
- All aircraft positioning correct

---

### Phase 6: Update Display Formatting

**Goal**: User-facing displays show MSL (what pilots expect).

**Modify**: `src/renderer/hooks/useCesiumLabels.ts`
- Datablock altitude: `geoidService.ellipsoidalToMsl(altitude)` then format

**Modify**: Debug overlays
- Show both ellipsoidal and MSL for debugging

**Testing**:
- Datablock altitude matches what pilot sees in simulator
- Compare with FlightRadar24/FlightAware

---

### Phase 7: Documentation and Cleanup

**Modify**: `docs/coordinate-systems.md`
- Update altitude systems section
- Add GeoidService usage examples

**Modify**: Type documentation
- `src/renderer/types/terrain.ts`
- `src/renderer/types/vatsim.ts`

**Search and Remove**:
- Any remaining `terrainOffset` references
- Unused MSL conversion constants

---

## Critical Files Summary

| File | Changes |
|------|---------|
| `src/renderer/services/GeoidService.ts` | **NEW** - Core conversion service |
| `src/renderer/services/AirportPolygonService.ts` | Convert elevations to ellipsoidal |
| `src/renderer/services/AirportSurfacesService.ts` | Convert elevations to ellipsoidal |
| `src/renderer/stores/vatsimStore.ts` | Convert altitudes on ingestion |
| `src/renderer/hooks/useAircraftInterpolation.ts` | Simplify ~250 lines of terrain correction |
| `src/renderer/hooks/useGroundAircraftTerrain.ts` | Simplify AGL calculations |
| `src/renderer/components/CesiumViewer/CesiumViewer.tsx` | Remove terrainOffsetRef and building hack |
| `src/renderer/hooks/useBabylonRootNode.ts` | Use GeoidService |
| `src/renderer/types/terrain.ts` | Update documentation |
| `src/renderer/types/vatsim.ts` | Update documentation |

---

## Risks and Mitigations

### Risk 1: Geoid offset varies with distance
**Mitigation**: Recalculate when airport changes. For orbit mode without airport, use followed aircraft's position.

### Risk 2: Race condition - data arrives before GeoidService ready
**Mitigation**:
- GeoidService must complete initialization before processing VATSIM data
- Add `isInitialized()` check, buffer or warn if not ready

### Risk 3: Replay mode stores MSL values
**Mitigation**: Replay snapshots may need version flag, or always re-convert on playback.

### Risk 4: vNAS already provides some ellipsoidal data
**Mitigation**: Check vNAS types - `altitudeTrue` may already be correct. Only convert if needed.

---

## Verification Strategy

### Per-Phase Testing
Each phase has specific tests listed above.

### End-to-End Testing
1. **KBOS** (geoid ~-30m): Airport with significant negative offset
2. **KLAX** (geoid ~-33m): Large airport, OSM buildings present
3. **KDEN** (geoid ~+15m): Airport with positive offset
4. **YMML** (geoid ~+20m): Southern hemisphere test

### Test Scenarios
1. Aircraft on ground at airport - should sit on terrain
2. Aircraft taking off - smooth transition
3. Aircraft landing - smooth descent to terrain
4. OSM buildings - should sit on flattened terrain correctly
5. Terrain flattening boundary - no visible cliff
6. Datablock altitude - matches expected MSL value

---

## Rollback Strategy

If issues arise during rollout:
1. GeoidService can return 0 offset to disable conversion
2. Add feature flag: `useEllipsoidalInternal: boolean`
3. Keep old code commented during initial implementation
4. Gradual rollout via alpha releases
