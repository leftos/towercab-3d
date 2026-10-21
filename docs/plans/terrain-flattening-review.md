# Airport terrain flattening: adversarial review (TC3D-193)

Scope: `src/renderer/terrain/FlatteningTerrainProvider.ts`, `hooks/useTerrainFlattening.ts`, `services/AirportPolygonService.ts`, `services/AirportSurfacesService.ts`, `services/RunwayService.ts` (as the runway source), `utils/terrainCache.ts`, `hooks/useGroundAircraftTerrain.ts`, `scripts/shipping/data-generation/extract-airport-surfaces.py`, the three debugging scripts, and Cesium 1.140 (`@cesium/engine` 24.0.0) internals they depend on.

The data sources are OurAirports `runways.csv` (runways) and X-Plane `apt.dat` (taxiways and aprons), not OSM.

## How it was measured

- **Node harness** (`canvases/terrain-flattening-review/measure.test.ts`, run with `pnpm vitest run --config canvases/terrain-flattening-review/vitest.config.ts` through the gate): the shipping `AirportPolygonService`, `AirportSurfacesService`, `RunwayService` parser and `createFlatteningTerrainProvider`, against real Cesium World Terrain (ion asset 1), with the bundled `runways.csv` and `airport-surfaces.json.gz`.
  Two separate `CesiumTerrainProvider` instances: `raw` is never wrapped, the other is wrapped. Airports: YMML, YSSY, YBBN, YPPH, YBCS, YMHB (Australia), KSFO, KOAK (flat controls), KDEN (sloped), KORD, VILH, OPQT (missing runway elevations).
- "Rendered" below means the flattened mesh as `sampleTerrainMostDetailed` returns it through the wrapper (the most detailed level, linear inside each triangle). "Aircraft height" means `getHeightAndSlopeAtPosition`, the value `useGroundAircraftTerrain` places ground aircraft at when they are inside a polygon.
- Full numbers: `canvases/terrain-flattening-review/measure-summary.log`. Heatmaps (raw height, flattened minus raw, rendered minus aircraft, polygons overlaid): `canvases/terrain-flattening-review/heatmap-{YMML,KDEN,KORD,YMHB}.png`.
- Data scans: `canvases/terrain-flattening-review/scan-data.mjs`, `scan-missing.mjs`, `scan-holes.mjs`; extractor probe with a synthetic apt.dat: `canvases/terrain-flattening-review/extractor_probe.py`.
- In-app checks through the `tauri-app` MCP: see "In-app checks" below.

## Summary

| # | Finding | Severity | Airport that shows it | Confidence |
|---|---------|----------|-----------------------|------------|
| 1 | A runway end with no elevation in OurAirports is flattened to 0 ft MSL, digging a trench hundreds to thousands of metres deep and dragging the whole airport's taxiway field down with it | wrong-on-screen, wrong-height-for-aircraft | KORD (09C/27C, 200 m), VILH (3,300 m), OPQT (1,600 m); 1,589 runways at airports with pavement data | measured |
| 2 | The taxiway-to-runway ramp never runs: `distanceToPolygonEdge(..., Infinity)` stops after the first edge, so ground beside a sloped runway jumps straight to the threshold-IDW height, leaving a cliff at the runway polygon edge | wrong-on-screen, wrong-height-for-aircraft | KDEN 17R/35L (11 m), YMML 16/34 (4.6 m) | measured |
| 3 | The airport fill polygon (convex hull + 100 m) flattens all land inside it, pavement or not, to an IDW of runway thresholds; valleys are filled and hills cut by tens of metres, with cliffs at the hull edge | wrong-on-screen | KDEN (+40 m / -18 m), YMML (+35 m / -21 m), YMHB (-21 m) | measured |
| 4 | Ground aircraft height and rendered ground disagree: aircraft use the analytic surface, the mesh only matches it at vertices, crossings disagree by rule, and coarser LODs drift further | wrong-height-for-aircraft | YMML (runway max 4 m, fill max 9 m), YSSY/YPPH crossings (~1 m), all airports at L12 (2-9 m) | measured |
| 5 | The processed-tile cache hands Cesium the same `TerrainData` object again after Cesium has freed its buffers in `createMesh`, so the second mesh build fails and the tile falls back to an upsampled parent | wrong-on-screen (lost detail) | every airport; seen at YMML | measured (in app) |
| 6 | Modified tiles keep the server's oriented bounding box and horizon point; the recomputed bounding sphere is not what Cesium culls with | latent (culling) | KDEN (+28 m), KORD (-198 m), VILH (-3,236 m) outside the original box | measured (out-of-box amount); culling effect read |
| 7 | Polygons change without reloading the globe's tiles: wrap happens after tiles may have loaded, blend-distance changes and late runway data never regenerate polygons | wrong-on-screen | app startup (log), YMML (blend slider) | blend slider measured in app; startup race and late runways read + log |
| 8 | The apt.dat extractor drops the last pavement of every airport, drops single-pavement airports entirely, and turns linear-feature nodes into holes | wrong-on-screen (missing flattening) | all airports | measured (synthetic apt.dat) |
| 9 | Runways are forced to a straight line between threshold elevations; where CWT shows a crowned runway the runway is sunk below its surroundings | wrong-on-screen | YMML 09/27 (5.7 m below CWT mid-runway), KORD 10C/28C (13.6 m) | suspected (truth unknown; CWT agrees with published thresholds) |
| 10 | `childTileMask` forced to 15 on every rewritten tile | latent | YMML 48/76 tiles, YSSY 53/77 | measured |
| 11 | In-flight tile requests across an airport switch mix the old airport's floors with the new runway list and land in the new cache | latent | airport switch | read |
| 12 | Hole rings get no blend; `degreesToMeters` uses a geometric-mean scale, so blend zones are anisotropic | latent | high latitude airports | read (math) |
| 13 | Taxiway/fill slope comes from the "closest" runway (found with finding 2's broken distance), not from the surface the aircraft is on | wrong-height-for-aircraft (pitch) | sloped airports | read |
| 14 | `terrain-flattening-e2e.ts` compares the flattened provider with itself (it wraps the instance it calls "original") | latent (tooling) | - | read |
| 15 | No subsystem doc for flattening; `docs/architecture.md` does not mention it | latent (docs) | - | read |

## Confirmed findings

### 1. Missing runway-end elevation becomes a 0 ft MSL runway

- `RunwayService.ts:245` parses `elevationFt: parseFloat(elevation) || 0`, so an empty `le_elevation_ft` / `he_elevation_ft` is 0.
- `AirportPolygonService.ts:201-204` converts each end's `elevationFt` to an ellipsoidal threshold height with no check, and `:138-140` averages them for the fallback. `calculateFieldElevation` (`:59-66`) does skip zeros, so the inconsistency is local to the runway polygon.
- `FlatteningTerrainProvider.ts:676-723` (`computeFieldElevation`) then uses those 0 ft thresholds as IDW anchors for every taxiway and fill vertex at the airport.
- Input: OurAirports rows with an empty end elevation. The bundled CSV has 3,575 such runways with coordinates, 1,589 of them at airports with apt.dat pavements (`scan-data.log`). The live CSV the app fetches (`RUNWAYS_DB_URL`) still has KORD 09C/27C, VILH 07L/25R, OPQT 13R/31L, RKSI 16L/34R and VTBS 02L/20R empty (checked against `canvases/terrain-flattening-review/runways-live.csv`).
- What happens (measured, `measure-summary.log`):
  - KORD 09C/27C: target -34.05 m ellipsoidal against CWT 162-167 m; flattened ground down to -203 m below raw on the runway, taxiways down to -193 m. The 0 ft thresholds pull the IDW field under the middle of the airport down by 20+ m (`heatmap-KORD.png`, middle panel). Grid points where rendered and aircraft heights differ by more than 3 m: 6,758 of 48,158. Steepest added step: 121 m over 25 m.
  - VILH (Leh, 10,682 ft): all three runways have no elevations, so the runways sit at about -24 m against 3,200-3,300 m terrain, a 3,300 m pit; no fill polygon is made because the field elevation is null.
  - OPQT 13R/31L: 1,600 m below its parallel, which is flattened correctly.
  - YBBN 01L/19R is listed as 0/0 ft (a real value is about 13 ft): flattened 3 m below CWT along its length.
- What should happen: a missing end elevation takes the other end's value, else the apt.dat field elevation (`airport.e`), else the CWT height sampled at the threshold; it is never 0. A 0 that disagrees with the other end or the field elevation by more than a few metres is treated as missing. Thresholds that are missing are left out of the IDW anchors.

### 2. The taxiway ramp is dead code; cliffs at the runway polygon edge

- `FlatteningTerrainProvider.ts:151`: `if (minDistSq < maxDistSq * 0.01) break`. The callers at `:772` (`computeTaxiwayElevation`) and `:1235` (`getHeightAndSlopeAtPosition`, fill branch) pass `maxDistSq = Infinity`, so `Infinity * 0.01` is `Infinity` and the loop breaks after the first segment: the "distance to runway" is the distance to the polygon's closing segment (the low-end cap), not to the nearest edge.
- For any point beside the middle of a runway that distance is about half the runway length, far more than `TAXIWAY_RAMP_DISTANCE_METERS = 200` (`:275`), so the ramp at `:792-798` never applies and the height jumps from the runway gradient to the threshold IDW at the runway polygon edge.
- Measured cross-sections (rendered = aircraft on both sides; `cross.mjs`):
  - KDEN 17R/35L at mid-length: runway 1628.35 m, ground beside the 75 m buffer 1617.4 m, CWT about 1627-1629 m on both sides. An 11 m deep trench either side of the runway, discontinuous in the aircraft height, steeper than 1:3 in the mesh.
  - YMML 16/34 at mid-length: runway 121.3 m, beside it 125.3 m (west) and 125.9 m (east). A 4.6 m wall.
- Ground aircraft taxiing across the runway polygon edge step by the same amount (aircraft height is discontinuous there).
- What should happen: the nearest-edge distance (no early exit for an `Infinity` limit, or a separate function), so the ramp blends taxiway heights into the runway gradient over 200 m as the comments at `:726-734` describe.

### 3. The fill polygon flattens non-airport land

- `AirportPolygonService.ts:252-306` builds the fill as the convex hull of every runway end and pavement vertex, buffered by 100 m; `FlatteningTerrainProvider.ts:878-888` and `:950-954` then set every vertex inside it to the threshold IDW (`computeFieldElevation`), with a 50 m blend at the hull edge.
- The hull of a large airport contains creek valleys, hills, roads and terminal precincts that are not pavement.
- Measured flattened minus raw inside the fill but outside any pavement or runway (`grid` "fill-only"):
  - YMML: +34.8 m at -37.67344,144.82948 (a creek valley inside the hull raised from 87.5 m to 122.3 m), -21.3 m at -37.65593,144.82863. Steepest step added: 20.9 m over 25 m at -37.67457,144.82977 (raw 3.3 m).
  - KDEN: +40.0 m at 39.87448,-104.71061, -18.3 m at 39.88548,-104.67901; steepest step 26.6 m over 25 m (raw 0.26 m) at 39.87403,-104.71178.
  - YMHB: -20.9 m at -42.83607,147.50137 (a rise inside the hull cut flat).
  - Flat controls: KSFO 5.7 m, KOAK 8.6 m, YBCS 3.9 m worst.
- Anything placed on real terrain heights (3D buildings, the tower model's surroundings, roads in imagery) floats or sinks by these amounts, and the hull edge shows a cliff up to the full difference over the 50 m blend.
- What should happen: the fill should only fill gaps between pavement (for example the union of pavements buffered by a few tens of metres, or the apt.dat airport boundary, row 130), not the hull, and its target should follow the terrain (smoothed CWT) where no pavement drives it.

### 4. Aircraft height versus rendered ground

- Aircraft inside a polygon get `getHeightAndSlopeAtPosition` (`useGroundAircraftTerrain.ts:147-162`); the rendered mesh only takes the target height at its existing vertices (`modifyTerrain`, `FlatteningTerrainProvider.ts:849-997`). No vertices are added at polygon edges, so a triangle with one vertex inside and one outside interpolates across the edge. Max-level CWT tiles here have a median of 13-452 vertices per tile (`H` lines), so triangles are large on flat ground.
- Measured |rendered - aircraft| at the most detailed level, 25 m grid:
  - YMML runway p95 1.05 m, max 3.99 m; taxiway max 2.87 m; fill max 9.35 m (at -37.65727,144.82551, fill edge).
  - YSSY runway max 2.10 m; YPPH 1.93 m; KDEN runway max 7.47 m, fill max 7.28 m; KSFO 0.47 m; KOAK 0.58 m.
  - The mismatch sits in strips along every polygon edge (`heatmap-YMML.png`, right panel).
- Crossing runways: the mesh averages all runways containing the vertex (`:938-948`) but the aircraft takes the first runway the R-tree returns (`:1209-1212`). YSSY 07/25 x 16R/34L: gradients 27.57 / 25.23 m, mesh 26.18 m, aircraft 25.23 m (0.95 m). YPPH 03/21 x 06/24: 1.18 m. YMML: 0.59 m. KSFO: 0.02-0.18 m.
- LOD: flattening only rewrites vertices that exist at each level, so coarser tiles carry the target surface only approximately. Runway centreline, |rendered - aircraft| p95 by level: YMML 16/34 L12 8.9 m, L13 0.74 m, L14 0.83 m (max 3.85 m); YSSY 07/25 L12 3.8 m, L13 1.9 m; KSFO 01R/19L L12 3.5 m, L13 3.0 m. Distant runway tiles in a tower view are drawn at these levels, so aircraft far down the runway float or sink by metres.
- What should happen: the aircraft height should come from the same source the screen shows (`globe.getHeight`, or sampling the flattened provider), or the mesh should be re-triangulated so polygon edges carry vertices; crossings should use one rule for both.

### 5. The tile cache returns objects Cesium has already consumed

- `FlatteningTerrainProvider.ts:1037-1041` returns the cached `TerrainData` itself on a hit, and `:1055` and `:1101` cache unmodified tiles the same way. `QuantizedMeshTerrainData.createMesh` frees `_quantizedVertices`, `_indices` and the edge index arrays once the mesh is built (`QuantizedMeshTerrainData.js:362-374`) and has no early return when `_mesh` already exists.
- Input: Cesium evicts a tile from its replacement queue (camera turns, zoom, a small `tileCacheSize`) and later requests it again while the wrapper's LRU (`setTileCacheSize`, same size as the globe's) still holds it.
- What happens: the second `createMesh` throws in the worker, `GlobeSurfaceTile.transform` sets the tile to `FAILED` (`GlobeSurfaceTile.js:760-765`), and the tile is drawn from its upsampled parent until it leaves the globe again. Every later request hits the same freed object. Node: every airport returned the same object for a repeated request; app: see "In-app checks" (TypeError from the worker, a level-15 YMML tile drawn from upsampled level-14 data).
- What should happen: cache the inputs (or a fresh `QuantizedMeshTerrainData` built from copied buffers per request), never the object handed to Cesium.

### 6. Stale oriented bounding box and horizon point

- `FlatteningTerrainProvider.ts:1124-1142` recomputes only the bounding sphere and passes the original `_orientedBoundingBox` and `_horizonOcclusionPoint` (the `TODO` at `:1141`).
- Cesium culls and measures tile distance with the OBB (`GlobeSurfaceTileProvider.js:1342-1355` copies `mesh.orientedBoundingBox` into `tileBoundingRegion`, `:763-766` culls with `tileBoundingRegion.boundingVolume`, `:1049` uses the OBB for distance), and horizon-culls with the occludee point (`:864-872`). `QuantizedMeshTerrainData.createMesh` hands both through unchanged (`QuantizedMeshTerrainData.js:334-338`). The comment at `:1120-1123` claiming the sphere fixes culling is wrong for 3D.
- Every rewritten tile kept the server OBB (YMML 76/76, KDEN 303/303, KORD 60/60). Flattened heights outside the original range: KDEN up to 27.9 m above the original max, YMML 10.9 m, KORD 197.6 m below the original min, VILH 3,236 m below.
- The visible effect is tiles culled while part of them is on screen (edges of the view, low tower angles) and wrong LOD distance. Not observed directly; read.

### 8. apt.dat extractor loses pavements

- `extract-airport-surfaces.py:159-163` saves the previous airport on a new airport header without appending the pavement still being built; pavements are only appended on the next row 110 (`:181-185`) or on row 99 (`:235-240`).
- `:203-232` appends rows 111-116 to the current pavement whatever header they follow, so nodes of a row 120 linear feature or row 130 boundary that follow a pavement become a hole ring (after a 113/114 the parser is `in_hole`).
- Synthetic apt.dat (`extractor_probe.py`): airport TST1 with pavement A, a taxi line, pavement B and a boundary came out with only A, and A had the taxi line as a hole; TST2 with one pavement was missing from the output entirely.
- Real data: 2,998 airports have exactly one pavement in the output; 496 hole rings stick outside their exterior ring and 32 are line-like slivers (`scan-holes.log`), consistent with the line-as-hole path being rare and the last-pavement loss being universal (it cannot be counted without the source apt.dat, which is not on this machine).
- Bezier nodes (112/114/116) keep only the node point, so curved fillets become chords and are not flattened except by the fill polygon.

### 10. `childTileMask` forced to 15

- `FlatteningTerrainProvider.ts:1151` replaces the server mask with 15 for every rewritten tile. Cesium falls back to the parent's mask when availability is not yet known (`GlobeSurfaceTile.js:463-474`), so it will request children the server said do not exist. Changed on 48/76 rewritten tiles at YMML, 53/77 at YSSY, 35/60 at KORD.

### 13, 14, 15

- Slope (`FlatteningTerrainProvider.ts:1251-1291`): for taxiway and fill points the pitch is the closest runway's gradient times the heading alignment, with "closest" picked by the broken distance of finding 2, and it ignores the IDW surface the aircraft is actually on.
- `scripts/debugging/terrain-flattening-e2e.ts:296-316` wraps `baseProvider` and then samples `baseProvider` as "original"; since the wrapper patches the instance in place, both columns are flattened. `terrain-grid-sampler.ts:849-853` does it correctly with two instances.
- `docs/architecture.md` and `docs/coordinate-systems.md` (one line at `:111`) are the only docs; there is no subsystem doc for flattening.

## Suspected findings

### 7. Polygon changes do not reach tiles already on the globe (blend-slider part confirmed in the app)

- `useTerrainFlattening.ts:217-221` deliberately does not reload terrain when polygons are set; only disabling does (`:150-155`). Cesium keeps loaded tiles until its replacement queue evicts them, and the tiles under a tower view stay in view.
- Startup order from `temp/console.log`: `[TerrainFlattening] Terrain provider is not CesiumTerrainProvider, cannot wrap` at 09:36:35.528, `Wrapped terrain provider` at 09:36:37.464, polygons set for KSFO at 09:36:48.9. Tiles requested before the wrap, or between the wrap and the polygons, are raw.
- `needsRegeneration` (`:180-182`) ignores `runways` and `blendDistance`: the blend slider (`SettingsGraphicsWeatherTab.tsx:436-445`) does nothing until the airport changes; if the airport is restored before the runway CSV arrives, polygons are built without runways (taxiways at the apt.dat field elevation, no fill) and are never rebuilt once the runways load, at airports that have pavement data.
- In-app check result: see "In-app checks".

### 9. Linear runway profile

- `getGradientElevation` (`FlatteningTerrainProvider.ts:629-661`) makes every runway a straight line between published threshold elevations. CWT agrees with the published thresholds within -0.7 to +2.6 m at the Australian fields (`A` lines), yet mid-runway CWT sits above the line: YMML 09/27 by up to 7.3 m (flattened 5.7 m below CWT at mid-length), 16/34 7.2 m, KORD 10C/28C 13.6 m, YBBN 01L/19R 4.8 m.
- Either CWT has a hump the real runway lacks, or the runway is crowned and the straight line sinks it. Published TDZ or survey data would settle which.

### 11. Airport switch race

- The promise chain (`FlatteningTerrainProvider.ts:1051-1156`) uses `floors` captured at request time (old airport) and `runwayFloors` read at resolve time (new airport), and caches the result in the cache that `setFlatteningPolygons` just cleared. Only matters for neighbouring airports (KSFO/KOAK) or quick switches back.

### 12. Holes and anisotropic blend

- Blend distance is measured to the exterior ring only (`:900`); a vertex in a hole is raw with no blend. The fill polygon covers most holes.
- `degreesToMeters` (`:162-169`) scales by the geometric mean of the latitude and longitude scales after a Euclidean distance in raw degrees. A 50 m blend is about 44 m east-west and 56 m north-south at YMML, 33 m and 75 m at 64° latitude.
- Antimeridian: the bounding box is plain min/max longitude (`:416-425`); no pavement in the data spans it, three Fijian airports sit within 0.5°. Self-intersecting pavement rings: 354 (even-odd ray casting drops the crossed lobes).

## In-app checks

Dev build (`pnpm run dev` with the CDP port), driven through the `tauri-app` MCP; snippets in `canvases/terrain-flattening-review/app-snippets.md`, page console in `.playwright-mcp/console-2026-10-21T10-45-25-757Z.log`. Globe `maximumScreenSpaceError` was 1 and `tileCacheSize` 2000 (the user's settings).

- **Finding 5 confirmed in the app.** At YMML, `viewer.terrainProvider.requestTileGeometry` for the tiles under 16/34 (levels 13-15) returned the object Cesium was already drawing: `_quantizedVertices` undefined, `_mesh` defined, the same object on a second request. `createMesh` on it rejects with `TypeError: Cannot read properties of undefined (reading 'length')` from `Workers/createVerticesFromQuantizedTerrainMesh.js`.

  A level-14 tile that had only been sampled built once and failed on the second build.
  After shrinking `globe.tileCacheSize` to 20, turning the camera through 90/180/270° and back, and restoring the cache size, one level-15 tile at YMML (x 59132, y 23238, 144.8218-144.8273 E, 37.6501-37.6556 S, the north-west corner by the 09 threshold) that the server has (`getTileDataAvailable` true) was drawn from upsampled level-14 data, and the wrapper returned a freed object for it. Every other rendered level-15 tile had its own data.
- **Finding 7, startup:** the page console shows `[TerrainFlattening] Terrain provider is not CesiumTerrainProvider, cannot wrap` at 15.1 s and `Wrapped terrain provider` at 17.95 s, only because the surfaces load re-ran the effect. With no airport selected nothing was lost this time; an airport restored at startup would have its first tiles requested unwrapped.
- **Finding 7, blend slider confirmed:** setting `terrainBlendDistance` 50 to 100 m at YMML produced no `[TerrainFlattening] Set` or `[FlatteningTerrainProvider] Set` line (console lines 4888-5278); the polygons kept the 50 m blend.
- **Finding 1 on screen:** KORD selected through the UI. At 09C/27C (41.98832,-87.9066) the drawn ground is at 65.3 m and at 41.98832,-87.92 at 22.7 m (CWT about 165 m), while a ground aircraft there would be placed at -34.05 m, 100 m below the drawn ground.

  At 41.9926,-87.9066 (taxiway north of 09C/27C) the drawn ground is 155.4 m and the aircraft height 135.1 m. Screenshot: `canvases/terrain-flattening-review/kord-09c27c-trench.png` (looking north from the tower; the pavement drops into a trench in the middle of the field).
- **Rendered LOD:** within 5 km of the YMML tower the globe drew levels 11 (2 tiles), 12 (14), 13 (14), 14 (15), 15 (20) and 16-19 (upsampled from 15, no server data). The coarse levels in finding 4 are on screen in a tower view.
- **Runway centreline at YMML (42 points):** drawn ground versus aircraft height p50 0.006 m, p95 0.63 m, max 1.22 m, matching the Node numbers.
- **Insets held up:** an inset iframe reports `__TAURI_INTERNALS__` and its own wrapped provider, so it loads the bundled surfaces and flattens the same way (in its own JS context, with its own 15 MB decompress).
- `canvases/terrain-flattening-review/ymml-fill-sw.png` (YMML at night towards the south-west fill edge) is too dark to show the cliff; the heatmap is the evidence there.

The app was left with KORD as the selected airport; the time-of-day, blend distance and the test inset were restored.

## What held up

- Datum: EGM96 to ellipsoid conversion of published threshold elevations matches CWT within about 1 m at most thresholds (KSFO, KOAK, YSSY, YPPH, YBCS, KDEN), so the ellipsoidal-height design is sound.
- Flat airports: at KSFO, KOAK and YBCS the runway mesh is within 0.6 m of the aircraft height, crossings disagree by under 0.2 m, and flattening moves runway ground by at most 1.9-3.4 m (p95 1.4-1.9 m).
- Insets: the inset iframe is a Tauri context with its own wrapped provider and the same polygons.
- Same-level tile edges: neighbouring tiles at one level share edge vertices and compute the same target from the same lon/lat, so no new cracks appear between tiles of one level; skirts are passed through unchanged (read, not measured).
- Degree-space gradient projection: the error from projecting in raw lon/lat is under 0.07 m at the polygon edge on every runway tried (`J` lines).
- CPU: per-tile flattening, replayed on the main thread, p50 0.13-0.96 ms, p95 0.27-5.5 ms, max 18 ms (YBBN); `setFlatteningPolygons` 0.2-2.3 ms warm (660 ms on the first call of the process); `generateRunwayPolygons` 0.4-45 ms; `getHeightAndSlopeAtPosition` 0.4-30 µs per call (KORD with 522 pavements is the slow end).
- NaN guards at `setFlatteningPolygons` and `modifyTerrain` (`:397-414`, `:982-992`) catch bad elevations; none fired.
- Quantization: re-quantizing every vertex into the widened range loses at most range/32767 (under 1 cm for these tiles except the trench cases).
