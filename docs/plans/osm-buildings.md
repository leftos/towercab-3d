# Buildings brainstorm: realism without frame cost (TC3D-139)

Inputs: the TC3D-140 spike report (`docs/plans/canvases/spike-osm-buildings/`), spike commit 0f8539d (`facadeShader.ts`, `main.ts`, `gen/gen.py`), and the installed Cesium 1.140 engine source (`@cesium/engine` 24.0.0). Context7's quota was exhausted, so every API name below was checked against that source, with file references.

**View geometry.** From a cab 30–70 m up, a building 1–5 km away sits 0.5–4° below the horizon. Walls fill the view, roofs are foreshortened to slivers, and a 3 m floor at 3 km is about 1–2 px. Roofs matter only near the field, in orbit and in top-down. So wall tone, wall-level detail that survives distance, and night lights carry most of the gain.

## Shared measurement method

The spike measured no frame cost: every mode hit the 240 Hz cap on the RTX 4090. The weather spike found the GPU timer reads 0 on this desktop's backend, and iPad Safari exposes no WebGL timer query. So:

- **Harness.** A fixed `window.__tc3d` script: KSFO and KOAK cab views at noon and 22:00 local, plus one orbit, 600 frames each, `scene.requestRenderMode = false`, frame cap off. A/B one idea at a time and report the median and p95 frame interval.
  `performanceMonitor.getMetrics()` (`utils/performanceMonitor.ts:279`) has the phase timings, and `__tc3d.perf()` exposes it with median and p95 over 300 frames (TC3D-55).
- **Desktop GPU-bound pass.** Also set `scene.resolutionScale = 2` so the GPU, not the CPU, sets the frame time; shader cost then shows up in the frame interval even without timer queries.
- **iPad.** Use Safari Web Inspector from the MacBook (Timelines → Rendering Frames). Record frame interval p95, the dropped-frame share at 60 Hz, and a 10-minute soak for thermal throttling (compare minutes 0–1 with 9–10). Also record the tab's memory.
- **Bar.** All building work together costs at most +1.5 ms p50 on the desktop GPU-bound pass over plain ion buildings. On the iPad, at most +2 percentage points of dropped frames after the soak, and no crash from memory. Each idea's own bar is a share of that.

## Ideas

### 1. Neutral environment-map ground colour (fixes the olive cast) — own idea, rank 1
- **Look.** The walls lose the olive tint the spike saw in every mode, including plain, and concrete reads as concrete.
- **Build.** Both levels. Every `Cesium3DTileset` and `Model` gets a `DynamicEnvironmentMapManager` by default (`Cesium3DTileset.js:849`, `Model.js:399`). Its `groundColor` defaults to `AVERAGE_EARTH_GROUND_COLOR` = `#717145`, an olive (`DynamicEnvironmentMapManager.js:1010`), and walls take half their IBL from that ground hemisphere.
  Pass the colour as `environmentMapOptions` at creation (setting `environmentMapManager.groundColor` afterwards does not rebuild an already computed map). TC3D-161 did this with a neutral grey `#6E6E6E`; deriving the colour from the imagery around the field remains open.
- **Cost.** Zero per frame; the map is rebuilt only when its position moves 1 km (`maximumPositionEpsilon`), and on clock changes (`maximumSecondsDifference`) only when `scene.atmosphere.dynamicLighting` is `SUNLIGHT` (`DynamicEnvironmentMapManager.js:876-884`). The app leaves it at the default `NONE` (`Atmosphere.js:124`), so the reflected sky is a sun-overhead sky at every hour; changing that is TC3D-185's to decide.
- **Measure.** Screenshot A/B only; no frame cost is expected.

### 2. Distance LOD: window grid fades to the facade's mean tint — rank 2
- **Look.** No moiré or "khaki blur" on distant houses (spike view 3), and no shimmer as the camera pans; at 3–5 km facades read as a calm tint that matches the near ones.
- **Build.** Both levels, in the `CustomShader` (`CustomShaderMode.MODIFY_MATERIAL`). The spike already fades on `fwidth(cell)`. Fade to the *area-weighted average* of wall and glass (and lit-window share at night), not to bare wall. Early-out of the window math when `detail == 0` skips the hash and noise for most far fragments. At level 3, the facade textures get proper mips (`KHR_texture_basisu`, supported via `GltfLoaderUtil.js:53`).
- **Cost.** Saves ALU at distance; one branch per fragment. iPad: a branch that's coherent across a tile is cheap on a TBDR GPU.
- **Measure.** GPU-bound pass with the shader on and the fade off, against the fade on; expect ≤0 ms. Shimmer is judged on a slow pan recorded as a clip.

### 3. Per-building colour variation from a stable hash — rank 3
- **Look.** Neighbouring buildings differ in wall tone, brick against render against concrete, and roof tile shade, so a district stops looking like one material.
- **Build.** Level 3: bake `stable_hash(osm_id)` into `COLOR_0` (gen.py already writes a tint). Use a curated palette per class (as OSM2World and streets-gl do), not random RGB.
  Level 2: the spike hashes `featureId_0`, a per-tile batch index, stable only if the ion tileset never moves a building between tiles across LODs. Verify that, or hash an id packed into the style colour (idea 4).
- **Cost.** A few ALU per fragment.
- **Measure.** It sits under the noise floor; check that colour doesn't pop during tile refinement on a dolly-in clip.

### 4. Type-aware facades — rank 4
- **Look.** Garages get open slab bands and dark gaps with no windows; hangars get a tall door panel and corrugated ribs; terminals get curtain wall (idea 5); houses get small punched windows; offices get bands. The central KSFO garage, the largest thing under the cab, stops wearing office windows.
- **Build.** Level 3: write a class per vertex at build time (gen.py has `plain`, `facade`, `facade_res`). Add a spatial join of `amenity=parking` + `parking=multi-storey` polygons onto footprints, since KSFO's garage is tagged only `building=yes`.
  Level 2: text tags never reach the shader (spike: `parseBatchTable.js:94/110`), so pack class, `building:levels` and a height bucket into the style colour's three channels via `Cesium3DTileStyle` `color` expressions, read with `selectedFeatureIdStage()`. Floors then come from height/levels, not a fixed 3 m.
- **Cost.** Level 2 adds style evaluation per feature on tile load (CPU, on the main thread) and does nothing per frame. The shader branches on class.
- **Measure.** Tile-load CPU time over a 30 s flyover with the style on and off; GPU-bound pass.
- **Risk.** `Model.js:2936` documents "custom shaders with a Cesium3DTileStyle may lead to undefined behavior". It works in 1.140, but it isn't a contract, so pin a regression screenshot.

### 5. Curtain-wall glass with sky reflection on terminals — rank 5
- **Look.** Terminal and tower-adjacent glass shows the sky gradient and the sun's glint, brightest at the cab's grazing angles (Fresnel). That's the single biggest "this is an airport" cue in a tower view.
- **Build.** Both levels. No new reflection system: Cesium's PBR path already samples the dynamic environment map's specular mips (`ImageBasedLightingStageFS.glsl`, `LightingStageFS.glsl` `computeIBL`).
  In the `CustomShader`, set `material.specular` (f0 ≈ 0.04–0.08) and `material.roughness` ≈ 0.05–0.15 on glass cells, with full-height mullion grids and spandrel bands. The map is sky plus a flat ground colour, with no neighbouring buildings or aircraft, which is right at 1–5 km. Planar or screen-space reflections cost too much.
- **Cost.** Near zero extra per fragment, since IBL is already evaluated. On an iPad, the dynamic map needs half-float or float colour buffers (`isDynamicUpdateSupported`, `DynamicEnvironmentMapManager.js:1000`), so verify it there, and keep a fallback of an analytic sky gradient from `czm_sunDirectionEC`.
- **Measure.** GPU-bound A/B; on the iPad, check that `isDynamicUpdateSupported` is true in the console.

### 6. Night lighting by building use — rank 6
- **Look.** Terminals stay brightly and evenly lit; offices thin out after 20:00; houses show a few warm windows; garages show cool LED strips at every slab; hangars show a door glow. The lit share falls through the night by local time.
- **Build.** Both levels, extending the spike's `emissive` path using the class from idea 4. Add a uniform for the local hour. At distance, scale emissive by a small "bloom-less glow" boost so lit windows survive sub-pixel size, instead of adding Cesium's bloom stage (`PostProcessStageLibrary.createBloomStage`), which is a full-screen pass.
- **Cost.** Same as the spike's night path, with one more uniform.
- **Measure.** Night A/B on the GPU-bound pass, and the iPad night soak.

### 7. Blending the generated area's edge — rank 7 (the spike's visible problem)
- **Look.** No ring where red pitched roofs and detailed walls turn into grey boxes 1.75 km out.
- **Build.** Mostly by making the two levels agree, not with a blend pass:
  - The same palette, hash, class rules and window grammar on both levels (ideas 3–4).
  - The same membership rule on both sides. gen.py keeps a building if its `representative_point()` is in the box (`gen.py:194`); the ion hide style tests `cesium#latitude/longitude`. Different points mean duplicated or missing buildings at the edge, so use one rule.
  - Shape the box by content. Residential pitched roofs are the giveaway, so extend generation only for small residential buildings in a wider ring (cheap triangles).
  - Fade the generated roof colour toward the ion roof tone with distance from the field (a uniform for centre and radius).
- **Alternatives.** `ClippingPolygonCollection` (`Cesium3DTileset` `clippingPolygons`; WebGL2 only per `isSupported`) cuts exactly but leaves straddling buildings hollow, and adds a per-fragment lookup. Not recommended.
- **Measure.** Screenshot review from the cab at four headings; there's no frame impact.

### 8. Baked ambient occlusion and contact darkening — rank 8
- **Look.** Building bases darken where they meet the ground, inner corners and parapets read, and roof clutter sits *on* the roof. Buildings stop floating on the imagery.
- **Build.** Level 3 only. Cesium applies `material.occlusion` only to the IBL term, not to direct sun (`LightingStageFS.glsl`, `computePbrLighting`), so multiply `diffuse` in the shader or bake into `COLOR_0`.
  Cheapest: store height above the base per vertex (a spare `TEXCOORD_1` channel) and darken analytically in the bottom 1–2 m, under parapets and in corners, with no added triangles; ray-cast per-vertex AO would need subdivided walls. Level 2 doesn't know a building's base height (the spike's floor-alignment gap).
- **Cost.** A few ALU per fragment and one vertex attribute; build time is seconds.
- **Measure.** GPU-bound A/B; GLB size change.

### 9. Trees from ESA WorldCover (plus OSM trees) — rank 9
- **Look.** Tree clumps along streets and parks break the "boxes on a carpet" look at mid distance, and hide building bases and terrain-imagery seams.
- **Build.** Level 3. Scatter thinned, jittered instances on WorldCover v200 class 10 (tree cover) from the local cache, plus OSM `natural=tree` and `natural=tree_row`. Draw them as one GLB with `EXT_mesh_gpu_instancing` (`GltfLoader.js:2567`) loaded as a `Model`; 1.140 has no public `ModelInstanceCollection`.
  Use opaque low-poly crowns (20–40 triangles), not alpha-tested cards: `discard` defeats the iPad's hidden-surface removal.
- **Cost.** One draw call per tree type; the instance count is unmeasured for KSFO and KOAK, so measure it first (a budget of about 20k instances is a guess). Shadows from trees double their vertex cost if `shadows` is on.
- **Measure.** Instance count, GPU-bound A/B, and iPad dropped frames over the soak.

### 10. Facade grammar: ground floor, top band, corner piers — own idea, rank 10
- **Look.** A taller ground floor with storefront glass, a cornice or top band, solid corners and slight irregularity in window columns. These are the cues streets-gl and OSM2World use, and they give the eye a sense of scale.
- **Build.** Level 3 easily, since height above the base is known (idea 8's attribute). Level 2 only partly, because the base is unknown; do the top band from the packed height (idea 4) only if the base can be inferred.
- **Cost.** A few ALU per fragment.
- **Measure.** Folded into idea 4's A/B.

### 11. Roof props: HVAC boxes, parapets, solar — rank 11
- **Look.** Commercial and terminal roofs gain units and panels. From the cab they're mostly foreshortened, so they matter in orbit and top-down, and for buildings right under the cab (the KSFO garage roof fills half the noon view).
- **Build.** Level 3. Parapets are already generated. Place props by footprint area and class with a stable hash, plus OSM `generator:source=solar` areas where tagged (count unmeasured). Draw instanced through `EXT_mesh_gpu_instancing`, one draw per prop type, near the field only.
- **Cost.** Thousands of instances of 12–50 triangles each; shadows add a pass.
- **Measure.** Orbit-view GPU-bound A/B.

### 12. Curated landmark overrides through mods — own idea, rank 12
- **Look.** Terminals, hangars and the cab's neighbours as hand-modelled GLBs, Flight Simulator's approach of hand-made airport buildings over autogen.
- **Build.** Mod overrides keyed by OSM way id (beside `mods/towers/{ICAO}`); the generator skips those ids and the ion hide style lists them.
- **Cost.** Per model, within the tower-mod budget; authoring is community work.

### 13. Photorealistic 3D Tiles near the field — own idea, rank 13 (a decision, not work)
- **Look and build.** Google's tiles (an ion asset, a `Cesium3DTileset`) replace levels 2 and 3 inside a radius where coverage exists.
- **Cost.** Heavy streaming and memory (the iPad is the risk), quota, attribution, and a melted look at the cab's low angles. Measure iPad memory and a soak first; it's likely desktop-only.

## Recommended first bundle

1. **Neutral environment-map ground colour** (idea 1): a one-line fix, if the A/B confirms it.
2. **Distance LOD fade to mean tint** (idea 2): fixes the far-field shimmer and saves cost.
3. **Per-building colour variation** (idea 3).
4. **Type-aware facades with packed class and levels** (idea 4): the base that ideas 5, 6 and 10 build on.
5. **Curtain-wall glass via the existing IBL** (idea 5): the biggest airport cue for near-zero cost.

All five fit the level 2 shader, so they ship before the level 3 pipeline and improve every airport. Ideas 6–8 follow with level 3.

## Open questions for the owner

1. **Night schedule:** (a) a fixed lit share by building class; (b) a share that follows local time through the night; (c) user-tunable.
2. **The generated area's extent:** (a) a fixed 3.5 km box; (b) a box shaped by content (wide for small residential buildings, tight for the rest); (c) a user-set radius by quality tier.
3. **Trees:** (a) none; (b) the generated box only; (c) the box plus OSM-tagged trees beyond it.
4. **Landmark overrides through mods:** (a) in scope now; (b) later; (c) no.
5. **Photorealistic tiles:** (a) out of scope; (b) an optional desktop-only mode; (c) evaluate in a spike.
6. **iPad parity:** (a) the iPad gets every effect; (b) a reduced tier without trees, props or AO; (c) the iPad uses the level 2 shader only.

## Where the spike report contradicts or constrains an idea

- **Frame cost is unmeasured** ("all modes hit the 240 Hz cap"), and the GPU timer reads 0 on this desktop. Every rank above is a judgement until the shared method runs.
- **Text tags never reach the level 2 shader** (spike, `parseBatchTable.js:94/110`). Type awareness on ion tiles depends on style-colour packing, which Cesium documents as undefined behaviour alongside custom shaders (`Model.js:2936`).
- **Floors don't line up with each building's base on ion tiles** (spike "What shipping each would take"). Ground-floor grammar, slab bands on garages and contact darkening are reliable only at level 3.
- **The spike hashes `featureId_0`**, a per-tile batch index. It's stable per building only if buildings never move between tiles; verify that before idea 3 relies on it at level 2.
- **The garage has windows because OSM tags it only as a building.** Type-aware facades need a build-time join with parking polygons, which level 2 can't do.
- **The olive cast is attributed to "the tileset's own lighting"**: idea 1 names a likely source (`#717145` default ground colour), still to be confirmed.
