# Coordinate Systems in TowerCab 3D

## Overview

TowerCab 3D uses three different coordinate systems depending on context:

1. **Geographic (Lat/Lon/Alt)** - VATSIM API data
2. **Cartesian3** - Cesium's 3D space
3. **ENU (East-North-Up)** - Babylon.js local coordinates

## 1. Geographic Coordinates

**Used by**: VATSIM API, airport database, weather API

**Format**:
- Latitude: -90 to 90 (degrees), positive = North
- Longitude: -180 to 180 (degrees), positive = East
- Altitude: meters (MSL - Mean Sea Level)

**Example**:
```typescript
const bostonTower = {
  lat: 42.3656,    // 42.3656°N
  lon: -71.0096,   // 71.0096°W
  elevation: 5.8   // 5.8 meters MSL
}
```

**When to use**:
- Reading VATSIM aircraft positions
- Airport database lookups
- Weather station locations
- User input for coordinates

## 2. Cesium Cartesian3

**Used by**: Cesium camera, entities, globe rendering

**Format**:
- ECEF (Earth-Centered, Earth-Fixed)
- Origin at Earth's center
- Units in meters
- X-axis through (0°N, 0°E)
- Z-axis through North Pole

**Conversion functions**:
```typescript
import { Cartesian3, Cartographic } from 'cesium'

// Geographic → Cartesian3
const position = Cartesian3.fromDegrees(lon, lat, alt)

// Cartesian3 → Geographic
const cartographic = Cartographic.fromCartesian(position)
const { latitude, longitude, height } = cartographic
```

**When to use**:
- Setting Cesium camera position
- Creating Cesium entities
- Distance calculations in Cesium
- Camera frustum calculations

## 3. ENU (East-North-Up)

**Used by**: Babylon.js overlay, 3D aircraft models, weather effects

**Format**:
- Local tangent plane at tower location
- Origin at tower position
- X-axis points East
- Y-axis points Up
- Z-axis points North (NOTE: different from typical Y-up!)

**Conversion functions** (see `utils/enuTransforms.ts`):
```typescript
import { createEnuToFixedFrameTransform, transformPositionToENU } from '@/utils/enuTransforms'

// Setup transform at tower location
const enuTransform = createEnuToFixedFrameTransform(
  towerLon,
  towerLat,
  towerElevation
)

// Convert aircraft position to ENU
const enuPosition = transformPositionToENU(
  aircraftLon,
  aircraftLat,
  aircraftAlt,
  enuTransform
)
// Returns: { x: meters east, y: meters up, z: meters north }
```

**When to use**:
- Positioning Babylon.js meshes
- Aircraft model placement
- Weather effect positioning (fog dome, clouds)
- Local distance calculations

**IMPORTANT**: Babylon.js uses Y-up but our ENU uses North for Z-axis!

## Altitude Systems

### MSL (Mean Sea Level)
- VATSIM reports altitude as MSL
- Standard aviation altitude reference
- **Does NOT account for local terrain**

### AGL (Above Ground Level)
- Used for ground aircraft positioning
- Calculated by: AGL = MSL - terrain_elevation
- See `useBabylonOverlay.ts` for terrain sampling

### Ellipsoidal Height
- Cesium's default altitude reference
- Measured from WGS84 ellipsoid
- **Different from MSL by ~30m** (geoid offset)
- Use `Cartographic.fromCartesian()` to get ellipsoidal height

### Geoid Offset Handling

To position aircraft accurately on terrain:
```typescript
// Sample terrain at tower location
const towerTerrainHeight = await sampleTerrainMostDetailed(
  viewer.terrainProvider,
  [Cartographic.fromDegrees(towerLon, towerLat)]
)

// Calculate geoid offset (ellipsoidal - MSL)
const geoidOffset = towerTerrainHeight[0].height - towerElevationMSL

// Position aircraft using offset
const aircraftY = (aircraftAltitudeMSL + geoidOffset) - terrainElevation
```

See `CesiumViewer.tsx` terrain offset calculation for implementation.

## Common Pitfalls

### ❌ Mixing coordinate systems
```typescript
// WRONG - using geographic coords in Babylon
mesh.position.set(aircraft.lon, aircraft.alt, aircraft.lat)
```

### ✅ Correct approach
```typescript
// Convert to ENU first
const enu = transformPositionToENU(
  aircraft.lon,
  aircraft.lat,
  aircraft.alt,
  enuTransform
)
mesh.position.set(enu.x, enu.y, enu.z)
```

### ❌ Ignoring geoid offset
```typescript
// WRONG - aircraft will be ~30m off
const height = aircraftAltitude - airportElevation
```

### ✅ Correct approach
```typescript
// Account for ellipsoid vs MSL difference
const height = (aircraftAltitude + geoidOffset) - terrainElevation
```

## Reference Files

- **Geographic ↔ Cartesian3**: Cesium built-in functions
- **Cartesian3 ↔ ENU**: `utils/enuTransforms.ts`
- **Terrain sampling**: `CesiumViewer.tsx` (geoid offset calculation)
- **Camera transforms**: `useBabylonCameraSync.ts`

## Conversion Cheat Sheet

| From | To | Function/Method |
|------|-----|----------------|
| Geographic | Cartesian3 | `Cartesian3.fromDegrees(lon, lat, alt)` |
| Cartesian3 | Geographic | `Cartographic.fromCartesian(cartesian3)` |
| Geographic | ENU | `transformPositionToENU(lon, lat, alt, transform)` |
| ENU | Geographic | `transformENUToPosition(x, y, z, transform)` |
| MSL | Ellipsoidal | `msl + geoidOffset` |
| Ellipsoidal | MSL | `ellipsoidal - geoidOffset` |

## Axis Orientation Summary

```
Geographic:
  Latitude: -90 (South) to +90 (North)
  Longitude: -180 (West) to +180 (East)
  Altitude: meters MSL

Cesium Cartesian3 (ECEF):
  X: through (0°N, 0°E)
  Y: through (0°N, 90°E)
  Z: through North Pole

Babylon ENU:
  X: East
  Y: Up
  Z: North
```

## Implementation Notes

### Aircraft Positioning
1. VATSIM provides: `lat`, `lon`, `altitude` (MSL)
2. Calculate geoid offset at airport location (once)
3. Convert to Cartesian3 for Cesium rendering
4. Convert to ENU for Babylon.js 3D models
5. Apply terrain offset for ground aircraft

### Camera Synchronization
1. Cesium camera updates based on user input
2. Extract camera position, rotation from Cesium
3. Convert camera position to ENU coordinates
4. Sync Babylon camera matrix with ENU transform
5. Render Babylon overlay aligned with Cesium view

See `useBabylonCameraSync.ts:21` for detailed implementation.

### Distance Calculations
Always use great-circle distance for geographic coords:

```typescript
import { calculateDistanceNM } from '@/utils/interpolation'

const distance = calculateDistanceNM(
  lat1, lon1, alt1,
  lat2, lon2, alt2
)
// Returns nautical miles with altitude component
```

## Troubleshooting

**Problem**: Aircraft appear 30 meters above/below terrain
- **Cause**: Geoid offset not applied
- **Fix**: Calculate `geoidOffset = terrainHeight - airportElevationMSL`

**Problem**: Babylon meshes don't align with Cesium terrain
- **Cause**: Root node not set up at correct location
- **Fix**: Call `babylonOverlay.setupRootNode(lat, lon, elevation)` after airport change

**Problem**: Camera jumps when switching viewports
- **Cause**: Viewport camera state not preserved
- **Fix**: Each viewport maintains independent camera state in `viewportStore`

**Problem**: Labels appear at screen center incorrectly
- **Cause**: Babylon camera not synced before projection
- **Fix**: Ensure `babylonOverlay.syncCamera()` called before label positioning

See `useCesiumLabels.ts:128` for camera sync check.

## Performance Considerations

- **ENU Transform**: Create once per airport, reuse for all aircraft
- **Terrain Sampling**: Sample once at airport load, cache geoid offset
- **Distance Calculations**: Use cached reference position for filtering
- **Coordinate Conversion**: Minimize conversions in render loop

## Further Reading

- [Cesium Coordinate Systems](https://cesium.com/docs/cesiumjs-ref-doc/Cartesian3.html)
- [WGS84 Ellipsoid](https://en.wikipedia.org/wiki/World_Geodetic_System)
- [ENU Coordinate System](https://en.wikipedia.org/wiki/Local_tangent_plane_coordinates)
- [Geoid vs Ellipsoid](https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/geoidal-vs-ellipsoidal-height/)
