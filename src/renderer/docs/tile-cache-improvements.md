# Tile Cache Improvements

## Current Implementation (v0.0.14)

- `tileCacheSize` default raised from 500 to 2000 (max 5000)
- Monkey-patch on `TileReplacementQueue.trimTiles()` multiplies effective limit by 10x
- Effective cache: ~20,000 tiles before aggressive eviction kicks in

## Cesium Internals Reference

Key internal structures for future work:

- `viewer.scene.globe._surface._tileReplacementQueue` - LRU queue for tile eviction
- `TileReplacementQueue.trimTiles(max)` - Called every frame, evicts oldest tiles
- `QuadtreeTile.eligibleForUnloading` - Getter that returns false during active loading
- `GlobeSurfaceTile.freeResources()` - Called when tile is evicted

## Potential Future Improvements

### 1. Geographic Priority Caching
**Effort:** High | **Impact:** High

Protect tiles near the current airport from eviction:

```typescript
// Hook into tile load events
viewer.scene.globe.tileLoadProgressEvent.addEventListener(() => {
  // Calculate which tiles are within X km of tower
  // Patch their eligibleForUnloading to return false
})
```

This would require:
- Tracking loaded tiles and their geographic bounds
- Maintaining a "protected tiles" set based on distance from tower
- Patching `eligibleForUnloading` on QuadtreeTile instances

### 2. Secondary In-Memory Cache
**Effort:** Very High | **Impact:** Very High

Maintain our own tile cache outside Cesium:

1. Create custom `ImageryProvider` wrapper that intercepts tile requests
2. Store decoded tiles in a Map/LRU cache we control
3. Serve from our cache before hitting network/service worker

This gives complete control but is invasive and complex.

### 3. Periodic Cache Warming
**Effort:** Medium | **Impact:** Moderate

Force Cesium to load/render important tiles periodically:

```typescript
// Store tile coordinates for airport area
const importantTiles = calculateAirportTiles(airport, zoomLevels)

// On interval, force load these tiles
setInterval(() => {
  importantTiles.forEach(tile => {
    scene.globe.pick(rayForTile(tile), scene)
  })
}, 30000)
```

Less invasive but doesn't prevent eviction, just re-loads faster.

### 4. Memory Pressure Monitoring
**Effort:** Low | **Impact:** Low (safety feature)

Add memory monitoring to detect when tile cache is consuming too much RAM:

```typescript
// Chrome only - performance.memory API
if ((performance as any).memory?.usedJSHeapSize) {
  const heapMB = (performance as any).memory.usedJSHeapSize / (1024 * 1024)
  if (heapMB > 2000) {
    console.warn(`[Memory] High heap usage: ${heapMB.toFixed(0)}MB`)
    // Could auto-reduce tileCacheSize here
  }
}
```

### 5. Custom Resource Subclass
**Effort:** High | **Impact:** High

Override Cesium's `Resource` class to implement custom caching:

```typescript
class CachingResource extends Cesium.Resource {
  private cache = new LRUCache<string, ArrayBuffer>(1000)

  async fetchArrayBuffer(): Promise<ArrayBuffer> {
    const cached = this.cache.get(this.url)
    if (cached) return cached

    const data = await super.fetchArrayBuffer()
    this.cache.set(this.url, data)
    return data
  }
}
```

This intercepts at the fetch level rather than tile level.

## References

- [Cesium tile cache discussions](https://community.cesium.com/t/terrain-tiles-are-not-cached/12518)
- [Prevent tile reload thread](https://community.cesium.com/t/prevent-3d-tile-re-load-when-entering-camera-view/18948)
- Cesium source: `packages/engine/Source/Scene/TileReplacementQueue.js`
- Cesium source: `packages/engine/Source/Scene/QuadtreePrimitive.js`
