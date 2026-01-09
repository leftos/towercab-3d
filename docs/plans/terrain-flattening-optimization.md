# FlatteningTerrainProvider Optimization Plan

## Problem

The terrain flattening process is noticeably slower than standard Cesium terrain loading due to expensive per-vertex computations in `modifyTerrain()`.

## Bottleneck Analysis

### Critical Hotspots (ordered by impact)

| Issue | Impact | Location |
|-------|--------|----------|
| `turf.pointToPolygonDistance()` | **CRITICAL** | Line 383 - very expensive edge distance calc |
| `turf.point()` allocation | **HIGH** | Line 367 - creates GeoJSON object per vertex |
| `turf.booleanPointInPolygon()` | **HIGH** | Line 377 - general-purpose, slow |
| No bbox pre-filtering | **MEDIUM** | Every vertex tests every floor polygon |
| LRU cache uses O(n) indexOf | **MEDIUM** | Lines 93, 118 - scales badly |
| Per-vertex array allocations | **LOW** | Lines 373-374 - insideFloors[], blendFloors[] |

### Numbers

- A terrain tile can have **65k+ vertices**
- With 10 flattening polygons, that's **650k+ point-in-polygon tests** per tile
- `pointToPolygonDistance` checks all polygon edges for every vertex in blend zone

## Optimization Strategy

### 1. Replace turf operations with inline implementations

**1a. Inline ray-casting point-in-polygon** (replaces `turf.booleanPointInPolygon`)
- Classic ray-casting algorithm is O(n) where n = polygon vertices
- Eliminate GeoJSON object overhead entirely
- Work directly with coordinate arrays

**1b. Inline distance-to-edge calculation** (replaces `turf.pointToPolygonDistance`)
- For each polygon, compute distance to nearest edge segment
- Use squared distances to avoid sqrt() until final result
- Early exit if distance exceeds blend threshold

**1c. Eliminate turf.point() allocations**
- Pass raw lon/lat numbers to inline functions
- No object creation in hot loop

### 2. Add bounding box pre-filtering

Before expensive polygon tests:
```typescript
// Quick reject - is vertex even close to this floor's bbox?
if (lon < floor.minLon - blendDeg || lon > floor.maxLon + blendDeg ||
    lat < floor.minLat - blendDeg || lat > floor.maxLat + blendDeg) {
  continue; // Skip this floor entirely
}
```

Pre-compute expanded bboxes (with blend distance) during `setFlatteningPolygons()`.

### 3. Fix LRU cache data structure

Replace:
```typescript
const tileCacheOrder: string[] = []
const existingIndex = tileCacheOrder.indexOf(key)  // O(n)
tileCacheOrder.splice(existingIndex, 1)  // O(n)
```

With:
```typescript
// Use Map for O(1) timestamp-based LRU
const tileCacheTimestamps = new Map<string, number>()
```

### 4. Pre-compute polygon data for fast access

Store flat arrays in FloorData during setup:
```typescript
interface FloorData {
  // ... existing fields
  // Pre-computed for fast iteration
  coordsX: Float64Array  // Polygon X coordinates
  coordsY: Float64Array  // Polygon Y coordinates
  minLon: number  // Bounding box (degrees)
  maxLon: number
  minLat: number
  maxLat: number
  expandedMinLon: number  // Bbox + blend distance
  expandedMaxLon: number
  expandedMinLat: number
  expandedMaxLat: number
}
```

### 5. Reuse arrays to reduce allocations (optional)

Pool arrays for insideFloors/blendFloors across vertices instead of creating new arrays per vertex.

## Implementation Changes

### File: `src/renderer/terrain/FlatteningTerrainProvider.ts`

1. **Add inline geometry functions** (new helper functions ~50 lines)
   - `pointInPolygonRayCast(x, y, coordsX, coordsY)` - ray casting algo
   - `distanceToPolygonEdge(x, y, coordsX, coordsY)` - nearest edge distance
   - `distanceToSegmentSquared(px, py, x1, y1, x2, y2)` - point-to-segment

2. **Modify FloorData interface** (~10 lines)
   - Add pre-computed flat arrays and bounding boxes

3. **Modify setFlatteningPolygons()** (~20 lines)
   - Pre-compute flat coordinate arrays
   - Pre-compute expanded bounding boxes

4. **Modify modifyTerrain()** (~30 lines changed)
   - Replace turf calls with inline functions
   - Add bbox pre-filtering before polygon tests
   - Remove turf.point() allocations

5. **Fix LRU cache** (~15 lines)
   - Replace array with Map-based approach

## Expected Performance Improvement

- **Point-in-polygon**: ~5-10x faster (no GeoJSON overhead, native operations)
- **Distance calculation**: ~3-5x faster (early exit, squared distances)
- **Bbox pre-filtering**: Skip 80%+ of polygon tests for vertices outside area
- **Overall**: Expect **3-5x speedup** for tile processing

## Verification

1. Run terrain-grid-sampler.ts on KBOS/KDEN before and after
2. Compare sampled heights (should be identical)
3. Time the tile processing with console.time() around modifyTerrain()
4. Visually verify flattening still works correctly in the app

## Files to Modify

- `src/renderer/terrain/FlatteningTerrainProvider.ts` (main changes)

## Risks

- Low risk: Inline algorithms are well-established (ray casting, point-to-segment)
- Edge case: Ensure polygon winding order is handled correctly in ray casting
- Testing: Verify blend zones still work correctly at polygon edges
