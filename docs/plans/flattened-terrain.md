# Airport Terrain Flattening Implementation Plan

## Problem
Free Cesium World Terrain has sharp peaks and valleys on airport surfaces, causing aircraft clamped to the ground to bounce up and down unrealistically.

## Solution
Create a custom terrain provider wrapper that flattens runway surfaces to their proper elevations with smooth edge blending.

## Scope
- **Phase 1 (this plan)**: Flatten runways using existing runway data
- **Phase 2 (future)**: Add taxiways/aprons via OSM or X-Plane apt.dat data

---

## Implementation Overview

### New Files
```
src/renderer/
├── types/terrain.ts                        # Flattening polygon types
├── services/AirportPolygonService.ts       # Generate runway polygons
├── terrain/FlatteningTerrainProvider.ts    # Custom terrain provider wrapper
├── utils/spatialIndex.ts                   # R-tree for polygon lookup
└── hooks/useTerrainFlattening.ts           # Integration hook
```

### Modified Files
- `src/renderer/types/settings.ts` - Add flattening settings
- `src/renderer/stores/settingsStore.ts` - Add defaults + migration
- `src/renderer/components/CesiumViewer/CesiumViewer.tsx` - Integrate hook
- `package.json` - Add `@turf/turf` and `rbush` dependencies

---

## Step-by-Step Implementation

### Step 1: Add Dependencies
```bash
npm install @turf/turf rbush
npm install -D @types/rbush
```

### Step 2: Create Types (`src/renderer/types/terrain.ts`)

```typescript
/** Polygon representing a flattened surface */
export interface FlatteningPolygon {
  id: string
  vertices: [number, number][]  // [lon, lat][] closed ring
  elevation: number             // meters MSL
  blendDistance: number         // meters for edge gradient
  source: 'runway' | 'taxiway' | 'apron' | 'custom'
}

/** Airport flattening configuration */
export interface AirportFlatteningConfig {
  icao: string
  polygons: FlatteningPolygon[]
  bounds: [number, number, number, number]  // [west, south, east, north]
}
```

### Step 3: Create AirportPolygonService (`src/renderer/services/AirportPolygonService.ts`)

**Purpose**: Generate runway rectangle polygons from RunwayService data

**Algorithm**:
1. Get runways for airport from RunwayService
2. For each runway with valid coordinates:
   - Calculate rectangle corners from threshold coords + width + heading
   - Extend 50m beyond thresholds (for overruns)
   - Use average of threshold elevations as target height
3. Return array of FlatteningPolygon

**Key functions**:
- `generateRunwayPolygons(icao: string): FlatteningPolygon[]`
- `createRunwayRectangle(runway: Runway): FlatteningPolygon`
- `calculateRectangleVertices(...)` - geodesic corner calculation

### Step 4: Create Spatial Index (`src/renderer/utils/spatialIndex.ts`)

Use `rbush` library for R-tree spatial indexing:

```typescript
import RBush from 'rbush'

interface PolygonBBox {
  minX: number  // west
  minY: number  // south
  maxX: number  // east
  maxY: number  // north
  polygon: FlatteningPolygon
}

export function createSpatialIndex(): RBush<PolygonBBox>
export function insertPolygons(index: RBush<PolygonBBox>, polygons: FlatteningPolygon[]): void
export function searchTile(index: RBush<PolygonBBox>, tileBounds: Rectangle): FlatteningPolygon[]
```

### Step 5: Create FlatteningTerrainProvider (`src/renderer/terrain/FlatteningTerrainProvider.ts`)

**Strategy**: Use `CustomHeightmapTerrainProvider` for tiles containing airport polygons, delegate to original provider for other tiles.

**Key components**:

1. **Wrapper class** that implements TerrainProvider interface
2. **`requestTileGeometry()` override**:
   - Check if tile intersects any flattening polygon (via spatial index)
   - If no intersection: delegate to base provider
   - If intersection: generate flattened heightmap

3. **Height calculation with blending**:
```typescript
function calculateHeight(lon: number, lat: number, originalHeight: number, polygons: FlatteningPolygon[]): number {
  for (const polygon of polygons) {
    if (isInsidePolygon(lon, lat, polygon)) {
      return polygon.elevation
    }
    const distanceToEdge = distanceToPolygonEdge(lon, lat, polygon)
    if (distanceToEdge < polygon.blendDistance) {
      // Linear interpolation from polygon elevation to original terrain
      const t = distanceToEdge / polygon.blendDistance
      return lerp(polygon.elevation, originalHeight, t)
    }
  }
  return originalHeight
}
```

4. **Heightmap generation** for flattened tiles:
   - Sample original terrain at grid points
   - Apply flattening calculation to each point
   - Return Float32Array heightmap

### Step 6: Create useTerrainFlattening Hook (`src/renderer/hooks/useTerrainFlattening.ts`)

```typescript
export function useTerrainFlattening(
  viewer: Cesium.Viewer | null,
  currentAirport: Airport | null,
  runways: Runway[],
  enabled: boolean,
  blendDistance: number
): void {
  // 1. Generate polygons when airport/runways change
  // 2. Create FlatteningTerrainProvider wrapper
  // 3. Replace viewer.terrainProvider
  // 4. Update config when airport changes
  // 5. Restore original provider on cleanup/disable
}
```

### Step 7: Add Settings

**In `types/settings.ts`** (CesiumSettings):
```typescript
enableTerrainFlattening: boolean  // default: true
terrainBlendDistance: number      // default: 50 (meters)
```

**In `settingsStore.ts`**:
- Add to DEFAULT_SETTINGS
- Add migration to merge new defaults

### Step 8: Integrate in CesiumViewer

In `CesiumViewer.tsx`, add hook call after viewer creation:

```typescript
// After useCesiumViewer, useTerrainQuality
useTerrainFlattening(
  viewer,
  currentAirport,
  runways,
  settings.cesium.enableTerrainFlattening,
  settings.cesium.terrainBlendDistance
)
```

---

## Technical Details

### Runway Polygon Generation Math

Given runway with:
- `lowEnd`: { lat, lon, heading }
- `highEnd`: { lat, lon, heading }
- `widthFt`: runway width

Calculate 4 corners:
1. Perpendicular offset = width / 2
2. For each threshold, calculate left/right points using heading +/- 90°
3. Use geodesic calculations (Cesium.Cartesian3 or Turf.js)

### Edge Blending

Linear gradient over `blendDistance` (default 50m):
- Inside polygon: Use polygon.elevation
- 0-50m from edge: Interpolate between polygon.elevation and original terrain
- Beyond 50m: Use original terrain

This prevents cliff walls at runway edges.

### Performance Considerations

1. **Spatial index**: O(log n) polygon lookup per tile
2. **Only current airport**: Clear index when airport changes
3. **Tile caching**: Cesium caches terrain tiles; flattened tiles get cached normally
4. **Heightmap resolution**: 32x32 or 65x65 grid per tile (match Cesium defaults)

---

## Testing

### Visual Verification
1. Select airport with known terrain issues (KMIA, YMML, hilly airports)
2. Verify runways appear flat
3. Check edge blending looks natural (no cliff walls)
4. Verify surrounding terrain unchanged

### Aircraft Verification
1. Place/watch aircraft taxi on runways
2. Verify no bouncing up/down
3. Check takeoff/landing roll is smooth

### Performance Verification
1. Monitor tile load times with flattening enabled vs disabled
2. Test camera movement at 60fps
3. Check memory usage doesn't grow unbounded

---

## Settings UI (Optional)

Add toggle in Settings > Graphics or Settings > Cesium:
- "Flatten airport terrain" checkbox
- "Blend distance" slider (25-100m)

---

## Future Phase 2: Taxiways & Aprons

To add taxiway/apron flattening later:
1. Create OSM data fetcher (Overpass API query for `aeroway=taxiway|apron`)
2. Parse OSM ways/polygons into FlatteningPolygon format
3. Add to spatial index alongside runway polygons
4. Consider caching OSM data per airport
