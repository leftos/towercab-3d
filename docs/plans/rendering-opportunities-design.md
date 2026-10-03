# Rendering Opportunities: Design (E1–E3, F1–F3)

Design for the six "need design" items in [rendering-engine-audit.md](./rendering-engine-audit.md) (`E1`–`E3`, `F1`–`F3`), tracked as TC3D-35. Each section gives what the code does today, the proposed design, the engine facts it relies on (quoted from engine source or docs, with the version checked), whether a spike must come first, the owner's open decisions, and size and dependencies.

Wave names used below, from [MAIN.md](./MAIN.md): **TC3D-9** Cesium 1.145 and shadow darkness (`A1`, `B1`); **TC3D-10** Babylon overlay fixes and dead hooks (`B2`–`B4`, `G5`–`G7`, `G10`); **TC3D-11** Babylon quick wins (`D1`–`D6`); **TC3D-12** render resolution and Cesium quick wins (`C1`–`C6`, `D7`); **TC3D-13** Cesium-side dead code (`G1`–`G4`, `G8`, `G9`).

## Summary

| Item | Recommendation | Spike first? | Size | Depends on |
|---|---|---|---|---|
| E1 Native glTF animations | Drive gear through `model.activeAnimations` with an `animationTime` callback that returns gear progress; set `animateWhilePaused`; delete the matrix-writing path | Yes, short: pose parity and fixed-time mode | multi-file | none on the engine (code is identical in 1.140 and 1.145); file order after TC3D-12 (`C1`) and TC3D-13 (`G8`) |
| E2 `customShader` tint and night boost | Two shared `CustomShader`s (built-in, FSLTL) applying tint before lighting and the night boost as `material.emissive`; keep `model.color` only for top-down white | Yes: night-boost effect and shader-assign hitch | multi-file | E3's night-approach decision; TC3D-12 (`C1` same file) |
| E3 Cesium's own night lighting | Animate `scene.light` (a `SunLight`) by sun elevation and bring Cesium's globe day/night shading down to tower range; retire the imagery brightness/gamma fake if the A/B holds | Yes: dusk-to-night A/B, plus per-model environment-map cost | multi-wave | TC3D-9 (`B1` touches `useCesiumLighting.ts`); E2 follows it |
| F1 GPU rain and snow | `GPUParticleSystem` with `emitRateControl: true`, CPU fallback through one factory; keep the per-frame wind (it becomes uniforms) | Yes: measure CPU rain cost, then a `fromParticleSystem` prototype | one hook + constants | TC3D-10 (`B4` vendors the texture in the same file) |
| F2 Overlay in VR | Rebuild VR with the overlay scene (owner ruling, F2-a option 3); today the eye planes are never drawn and head tracking is not wired | Yes: a headset session to see what renders, run by the owner | multi-wave, needs its own design | overlaps TC3D-13 (`G3`) |
| F3 MSDF labels | Measure only; build nothing unless labels cross the agreed threshold | Yes: it is the whole item until a number says otherwise | one-site (measure) | TC3D-11 (`D3`–`D5` change the labels being measured) |

**Suggested order:** spike S0 (harness `perf()`) → E1 spike and build → F1 spike and build → E3 spike, then E3 and E2 built together → F3 measurement after TC3D-11.

**Spike S0 (shared prerequisite).** `window.__tc3d` exposes no frame timings; `performanceMonitor` (`src/renderer/utils/performanceMonitor.ts:6-37`) already records `aircraftUpdate`, `babylonRender`, `gpuCesiumMs`, `gpuBabylonMs` and `fps`. Add `perf: () => PerformanceMetrics` to `AgentHarness` (`src/renderer/types/harness.ts`) and install it in `useAgentHarness.ts`, dev-only like the rest. Every spike below samples it over 300 frames (`requestAnimationFrame` loop inside one `browser_evaluate`) and reports median and p95.

**Terms.** *Spike*: a measurement or throwaway prototype whose result decides a design question; it lands no product code. *Pool slot*: one of the 100 pre-created `Cesium.Model` instances aircraft are assigned to (`AIRCRAFT_POOL_SIZE`, `useCesiumViewer.ts:442-469`). *IBL*: image-based lighting, lighting a model from an environment map. *MSDF*: multi-channel signed distance field font rendering.

**Versions checked.** Shipped: `cesium` 1.140.0 (`@cesium/engine` 24.0.0, read from `node_modules`), `@babylonjs/*` 9.28.0. Cesium facts were also read at tag `1.145` on GitHub: `ModelAnimationCollection.js`, `ModelNode.js`, `CustomShader.js`, `Atmosphere.js`, `DynamicEnvironmentMapManager.js`, `LightingStageFS.glsl`, `ModelColorStageFS.glsl` and `SunLight.js` are byte-identical to 1.140; the quoted lines of `Model.js`, `Globe.js`, `GlobeFS.glsl`, `ModelFS.glsl`, `UniformState.js`, `GlobeSurfaceShaderSet.js` and `GlobeSurfaceTileProvider.js` are unchanged at 1.145. npm `latest` is `cesium` 1.146.0 and `@babylonjs/core` 9.29.0; neither was checked.

**Audit references.** Re-resolved against the current tree: E1 `gearAnimationController.ts:21-27` (the note runs to :28, repeated at :257-258), E2 `useAircraftModels.ts:465-491` (the block is :463-492), E3 `useCesiumNightDarkening.ts:150-179` (writes at :150-151 and :173-174), F1 `useBabylonPrecipitation.ts:250-328` and `:496-552`, F2 `VRScene.tsx:15-18`: all current.

---

## E1. Native glTF animations

### Today

- `useAircraftModels.ts:494-528`: for FSLTL models only, each frame calls `updateGearAnimation` (hysteresis and 12 s eased transition, `gearAnimationController.ts:207-248`) and then `applyGearAnimation(model, progress, …)`.
- `applyGearAnimation` (`gearAnimationController.ts:272-313`) fetches the GLB a second time with `fetch()` and parses it (`gltfAnimationParser.ts:106-189`), then `applyGearAnimationsPercent` (`:455-511`) interpolates every animation whose name contains `GEAR`, snaps to 2 % steps, caches per URL, and writes `model.getNode(name).matrix` for each animated node (`:436`, `:555`, `:684`), storing the original on a private `_originalMatrix` field.
- The header (`gearAnimationController.ts:21-27`) says Cesium's system "has issues with animationTime callbacks"; no repro is recorded.
- Gear progress also feeds the ground offset: `useAircraftModels.ts:298-307` mixes `gearUpMinY`/`gearDownMinY` from `parseGroundDataFromUrl`, which parses the same GLB again (`gltfAnimationParser.ts:732-836`). That path stays.
- The FSLTL converter bakes frame 0 (or the near-identity frame for steering) into node TRS but keeps the animations in the GLB (`scripts/shipping/conversion/convert_fsltl_batch.py:713-789`).
- `useAircraftModels.ts:381-385` already passes a `gltfCallback` that records the animation count per URL; `_knownAnimationCount` is passed and ignored (`gearAnimationController.ts:277`, audit `G8`).
- In fixed-time mode the clock is frozen: `CesiumViewer.tsx:675-676` sets `viewer.clock.shouldAnimate = false`.

### Proposal

1. In the `gltfCallback` (`useAircraftModels.ts:381`), collect the names of animations whose name contains `GEAR` into a per-URL map (replaces `modelAnimationCountsRef`).
2. When a pool slot's new model resolves (`.then` at `:387`), and on `model.readyEvent` if not yet ready, call `model.activeAnimations.add({ name, animationTime })` once per gear animation, and set `model.activeAnimations.animateWhilePaused = true`. The callback closes over the pool index and returns `getCurrentGearProgress(modelPoolAssignments.current.get(poolIndex))`, ignoring Cesium's `duration`/`seconds` arguments. Pool reassignment then needs no re-registration: the callback reads whichever callsign holds the slot.
3. Keep `updateGearAnimation` per frame (it advances the hysteresis state); delete `applyGearAnimation`, `applyGearAnimationsPercent`, `applyAnimationPercent`, `applyCachedGearTransforms`, `applyAnimationPercentWithCache`, the transform cache and `parseAnimationSetFromUrl` with its caches. Keep `parseAnimations` (ground data uses it). This also removes `G8`'s parameter.
4. Rewrite the header docblock of `gearAnimationController.ts` to describe the native path.

Insets: they run the same hook in their own iframe with `requestRenderMode: true` (`useCesiumViewer.ts:243`); the callback is evaluated whenever the inset renders, which is when it renders aircraft anyway. Remote browsers: no difference; one fewer GLB fetch per model. No settings.

### Engine facts

- `ModelAnimationCollection.update` skips all animations when scene time has not changed unless `animateWhilePaused` is set: `if (!this.animateWhilePaused && JulianDate.equals(frameState.time, this._previousTime)) { return false; }` (`Scene/Model/ModelAnimationCollection.js:412-417`, 1.140 = 1.145). The property doc: "When true, the animation will play even when the scene time is paused. However, whether animation takes place will depend on the animationTime functions assigned to the model's animations" (`:53-62`). This alone breaks a time-based callback in fixed-time mode and is the most likely past issue.
- The callback's return value is a normalized delta, not seconds: `// [0.0, 1.0] normalized local animation time` … `delta = defined(runtimeAnimation._animationTime) ? runtimeAnimation._animationTime(duration, seconds) : seconds / duration;` (`:448-457`), then `localAnimationTime = delta * duration * runtimeAnimation.multiplier` clamped to the keyframe range (`:509-515`). A callback returning seconds would pin the pose at the last keyframe; returning gear progress (0–1) maps straight onto the clip.
- A non-repeating animation plays only while `delta <= 1.0` (`:469-472`), and an unchanged delta is skipped: `if (delta === runtimeAnimation._prevAnimationDelta) { … continue; }` (`:474-482`). A parked gear costs one callback call per animation per frame.
- `add` throws before the model is ready: "Animations are not loaded. Wait for the {@link Model#ready} to return true" (`:126`).
- Writing `node.matrix` locks the node out of animation: `this._runtimeNode.userAnimated = true` on assignment; "Setting the matrix to undefined will restore the node's original transform, and allow the node to be animated by any animations in the model again" (`Scene/Model/ModelNode.js:81-107`). The two paths cannot share a node.
- `gltfCallback` receives the parsed glTF JSON; the Cesium reference example reads `gltf.animations` from it ([Model.html](https://cesium.com/learn/cesiumjs/ref-doc/Model.html), via Context7 `/websites/cesium_learn_cesiumjs_ref-doc`).
- `AnimationTimeCallback(duration, seconds)`: "duration — The animation's original duration in seconds; seconds — The seconds since the animation started, in scene time" ([ModelAnimation.html](https://cesium.com/learn/cesiumjs/ref-doc/ModelAnimation.html), via Context7).

### Spike first?

Yes, short, and it can run on 1.140 today because the animation code is identical at 1.145. Through `browser_evaluate` on the `tauri-app` server (FSLTL models come from the host): load one converted FSLTL GLB twice with `Cesium.Model.fromGltfAsync` at a spot from `__tc3d.lookAt`, outside the pool so the live loop does not touch it. Drive model A with the current `applyGearAnimationsPercent` and model B with `activeAnimations.add({ name, animationTime: () => window.__p })`. For `__p` in 0, 0.25, 0.5, 1: compare `getNode(n).matrix` for every gear node; pass is equal within 1e-4. Repeat B with `viewer.clock.shouldAnimate = false`, with and without `animateWhilePaused`. Then, with ~60 FSLTL aircraft in view, compare `perf().aircraftUpdate` median before and after a local patch. If the callback still misbehaves, record the repro in the `gearAnimationController.ts` header and in Linear.

### Open decisions

- **E1-a Scope.** (1) *Gear only, behaviour parity* (recommended): same visuals, less code, one fewer fetch; worst case a model whose gear animation also moves doors looks as it does today. (2) *Gear plus flaps/spoilers by flight phase*: needs a phase-to-progress map and per-type naming rules; worst case wrong or mis-named FSLTL clips show flaps deployed at cruise. (3) *All clips including looping props*: worst case steering and other baked clips snap from their converter-chosen neutral frame to frame 0 (`convert_fsltl_batch.py:742-762`) on every model.
- **Steering clips (from `aircraft-motion-review.md`):** the gear filter matches every clip with "GEAR" in its name, so nose-wheel steering clips follow gear progress and sit at full lock with the gear down (27 of 105 sampled FSLTL models). Both the matrix path and the native path exclude clips with "STEER" in the name.
- **Settled (owner ruling):** E1-a option 1, gear only, behaviour parity.
- **E1-b If the spike fails.** (1) *Keep the matrix path and document the repro* (recommended); worst case the code stays as heavy as today. (2) *Keep matrices but source keyframes from the already-loaded model instead of a second fetch*: not verified that Cesium exposes the sampler data publicly; worst case it reads private loader fields, a new private-API site for `A1.5` to watch.
- **Settled (owner ruling):** E1-b option 1, keep the matrix path and document the repro.

### Size and dependencies

Multi-file: `hooks/useAircraftModels.ts`, `utils/gearAnimationController.ts`, `utils/gltfAnimationParser.ts`. No hotspot file. No engine dependency; land after TC3D-12 (`C1` edits `useAircraftModels.ts:556-570`) and fold in or follow TC3D-13 (`G8`).

---

## E2. `Model.customShader` for tint and night boost

### Today

- Per frame for every visible aircraft, `useAircraftModels.ts:463-492` allocates a new `Cesium.Color` and sets `model.color`, `model.colorBlendAmount` (`ColorBlendMode.MIX` from load, `:378-380`), and a new `model.lightColor` (boost `1 + (aircraftNightVisibility − 1) × nightProgress`, `:233-245`).
- Top-down forces white with blend 1.0 (`:466-469`). Built-in models blend 0.5 for coloured tints, 0.15 for white, rising to 1.0 as brightness passes 1.1; FSLTL blends 0 up to 1.1, then up to 1.0 (`constants/rendering.ts:213-291`).
- The pool is created with the same triple (`useCesiumViewer.ts:437-456`), and a second effect rewrites colour on brightness change (`:496-510`).

### Proposal

New `utils/aircraftModelShader.ts` exporting `createAircraftShader()` → a `CustomShader` with `mode: MODIFY_MATERIAL`, uniforms `u_tint` (vec3), `u_tintAmount` (float), `u_emissive` (float), and a `fragmentMain` that does `material.diffuse = mix(material.diffuse, u_tint, u_tintAmount); material.emissive += material.diffuse * u_emissive;`.

- Two instances owned by `useAircraftModels`: built-in and FSLTL. Assign `model.customShader` once when a slot's model resolves (`:387`) and on pool creation. Update uniforms with `setUniform` only when brightness, tint, `aircraftNightVisibility` or the sun-elevation bucket changes (sun elevation updates every 30 s, `constants/lighting.ts:98`), not per frame.
- `u_tintAmount` takes today's blend values below 1.1. The "glow" above 1.1 and the night boost move into `u_emissive`, so the livery stays visible and the boost no longer depends on sun direction.
- Top-down keeps `model.color = WHITE`, `colorBlendAmount = 1.0` (post-lighting, flat); 3D sets `colorBlendAmount = 0`. Assign only when `viewMode` changes, not per frame.
- Delete `model.lightColor` writes and the per-frame `Color` allocation. `getModelColorRgb`/`get*BlendAmount` become uniform calculators.
- Delete the brightness effect at `useCesiumViewer.ts:496-510` (the shader owns it).

Settings: none added; existing sliders keep their keys and ranges, their look changes above 1.1 (changelog "Changed" bullet). Insets: same hook, same shaders, per iframe. Remote browsers: shader compiled per browser; nothing server-side.

### Engine facts

- Stage order in the model fragment shader: `materialStage` → `customShaderStage` → `lightingStage` → `modelColorStage` (`Shaders/Model/ModelFS.glsl`, 1.140 :85-100; 1.145 :137-147). The custom shader edits the material before lighting; `model.color` is applied after lighting: `material.diffuse = mix(material.diffuse, model_color.rgb, model_colorBlend);` (`ModelColorStageFS.glsl`). This is why blend 1.0 renders flat and why a pre-lighting tint keeps shading.
- Emissive is added after direct light, not scaled by it: `vec3 color = directColor + material.emissive;` (`LightingStageFS.glsl:69-70`). `czm_modelMaterial.emissive`: "Light emitted by the material equally in all directions. The default is vec3(0.0)" (`Shaders/Builtin/Structs/modelMaterial.glsl:20`).
- `model.lightColor` replaces the light colour in the direct term only: `#ifdef USE_CUSTOM_LIGHT_COLOR vec3 lightColorHdr = model_lightColorHdr;` then `directColor = lightColorHdr * directLighting` (`LightingStageFS.glsl`). With the sun below the horizon the direct term is near zero, so the boost likely does little at night; the spike checks this.
- Assigning a different `customShader` rebuilds draw commands: `if (value !== this._customShader) { this.resetDrawCommands(); }` (`Scene/Model/Model.js:806-816`). `model.color` rebuilds only when alpha crosses opaque/translucent (`isColorAlphaDirty`, `:1017-1027`); `lightColor` only when it toggles defined/undefined (`:1419-1430`).
- `CustomShader` options: "`mode` [MODIFY_MATERIAL] … `lightingModel` … If present, this overrides the default lighting … `uniforms` A dictionary for user-defined uniforms"; it is marked `@experimental` (`Scene/Model/CustomShader.js:77-89`). `setUniform(uniformName, value)` exists (`:413`).

### Spike first?

Yes. (a) At a night fixed time (`stores.settings` → `cesium.timeMode = 'fixed'`, `fixedTimeHour = 23`), screenshot a built-in and an FSLTL aircraft with `aircraftNightVisibility` 1.0 and 3.0; if the two match, the current boost is inert and E2 fixes a user-visible bug. (b) Assign one prototype `CustomShader` to all pool models in `browser_evaluate` and log `perf().fps` and `totalFrame` across the assignment frame, to size the compile hitch and confirm 100 models sharing one instance do not stall. Cesium pixels are read from page screenshots (`readPixels` covers only the Babylon canvas).

### Open decisions

- **E2-a Shader granularity.** (1) *Two shared instances, built-in and FSLTL* (recommended): matches today's per-category settings, uniforms set a few times a minute; worst case no per-aircraft effect (e.g. highlighting the followed aircraft) without more work. (2) *One instance per pool slot*: per-aircraft control; worst case 100 instances re-uploading uniforms and a longer hitch if programs are not shared (unmeasured).
- **Settled (owner ruling):** E2-a option 1, two shared instances (built-in, FSLTL).
- **E2-b Brightness above 1.1.** (1) *Emissive glow that keeps the livery* (recommended); worst case users who tuned the slider for a solid-colour look see a different result. (2) *Keep the post-lighting MIX glow* for that range; worst case two mechanisms for one slider.
- **Settled (owner ruling):** E2-b option 1, emissive glow that keeps the livery.
- **E2-c Nav lights.** (1) *Out of scope* (recommended): converted models' light geometry is not identified (not checked); worst case nobody gets nav lights. (2) *Spike the converter output for light meshes/emissive maps first*; worst case a converter change and model-cache rebuild for every user.
- **Settled (owner ruling):** E2-c option 2, spike the converter output for light meshes first (the owner's MSFS models under `X:\games` may be converted for it, TC3D-35).

### Size and dependencies

Multi-file: `hooks/useAircraftModels.ts`, `hooks/useCesiumViewer.ts`, `constants/rendering.ts`, new `utils/aircraftModelShader.ts`. No hotspot file (no settings change). Waits on E3-a (the night boost belongs to whichever night model wins) and on TC3D-12 (`C1` silhouettes edit the same files).

---

## E3. Atmosphere and lighting on the main viewer

### Today

- Night is faked on the base imagery layer only: `useCesiumNightDarkening.ts:143-180` sets `imageryLayers.get(0).brightness` (1.0 → 0.15 at full intensity through civil, nautical and astronomical twilight) and `gamma` (warm boost around sunset).
- Gated by `enableNightDarkening && enableLighting` (`CesiumViewer.tsx:313-316`); `enableNightDarkening` defaults to `false` (`types/settings.ts:1942`).
- The Babylon lights dim in step (`useBabylonNightLighting.ts:93-130`); aircraft get `model.lightColor` (E2).
- `globe.enableLighting` and `showGroundAtmosphere` are set (`useCesiumLighting.ts:105-109`, `useCesiumViewer.ts:257,328`). Nothing sets `scene.light`, `scene.atmosphere`, `skyAtmosphere.*Shift`, globe lighting fade distances, or any model's `environmentMapManager`.
- `useSunElevation.ts:62-126` computes elevation from `Simon1994PlanetaryPositions` every 30 s or on a >500 m camera jump.
- Terrain is `Terrain.fromWorldTerrain()` with no vertex normals (`useCesiumViewer.ts:226`). Flattened tiles are rebuilt without `encodedNormals` (`terrain/FlatteningTerrainProvider.ts:1135-1153`).

### Proposal

Replace the imagery fake with Cesium's own lighting, in one hook `useCesiumSceneLighting` (renamed from `useCesiumNightDarkening`):

1. **Globe shading at tower range.** Set `globe.lightingFadeOutDistance` and `lightingFadeInDistance` small (e.g. 1 and 2 m) so `ENABLE_DAYNIGHT_SHADING` applies near the ground (see facts: at default distances the globe is fully lit below ~6,500 km).
2. **Light level.** `viewer.scene.light = new Cesium.SunLight()` and drive `intensity` and `color` from sun elevation with the existing twilight curve (`calculateTargetBrightness`), so `czm_lightColor` (clamped to luminance ≤ 1) dims terrain, OSM buildings and aircraft together; `nightDarkeningIntensity` maps to the night floor.
3. **Sky and haze colour.** At dusk, set `scene.skyAtmosphere.hueShift/saturationShift/brightnessShift`, `globe.atmosphereBrightnessShift` and `scene.atmosphere.brightnessShift` (fog and models) for the dusk tint the gamma boost fakes today.
4. **Per-model environment maps.** Per E3-b, pass `environmentMapOptions: { enabled: false }` to the pool's `fromGltfAsync` calls if the spike shows cost.
5. Keep `useBabylonNightLighting` driven by the same curve. Delete the imagery brightness/gamma writes.

Settings: keep `graphics.enableNightDarkening` and `nightDarkeningIntensity` with the same keys, so no migration; a default change (E3-d) needs a `settingsStore` version bump (currently 38, `settingsStore.ts:446`) and a migration step. Insets: the hook runs per viewer; insets render on demand, so a light change shows on their next render. Remote browsers: per-browser settings; dynamic environment maps need `EXT_color_buffer_float` or `_half_float` and switch themselves off where missing (iPad: not checked).

### Engine facts

- Globe day/night shading fades out near the camera: `float fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.0, 1.0);` and `diffuseIntensity = mix(1.0, diffuseIntensity, fade);` (`Shaders/GlobeFS.glsl`, 1.140 :391,442; 1.145 :385,434). The tile provider defaults are `lightingFadeOutDistance = 6500000.0; lightingFadeInDistance = 9000000.0;` (`GlobeSurfaceTileProvider.js`, 1.145 :100-101), and `Globe.lightingFadeOutDistance` is documented as "The distance where everything becomes lit" (`Globe.js:249-256`). At tower range `fade` is 0, so `enableLighting` alone never darkens nearby terrain, which is why the imagery fake exists.
- Shading branch: `if (enableLighting) { if (hasVertexNormals) { … "ENABLE_VERTEX_LIGHTING" } else { … "ENABLE_DAYNIGHT_SHADING" } }` (`GlobeSurfaceShaderSet.js`, 1.145 :327-335). Day/night: `clamp(czm_getLambertDiffuse(…) * 5.0 + 0.3, 0.0, 1.0)` times `czm_lightColor`. Vertex lighting: `* u_lambertDiffuseMultiplier + u_vertexShadowDarkness` with no fade (`GlobeFS.glsl`, 1.145 :431-437); `vertexShadowDarkness` defaults to 0.3 (`Globe.js:365-372`). Both floors are 0.3 × light colour.
- `czm_lightColor` is "the light color multiplied by the light intensity limited to a maximum luminance of 1.0" (`Renderer/UniformState.js:854-860`; the clamp `if (maximumComponent > 1.0)` is at 1.145 :1542). `SunLight` defaults `intensity = 2.0`, `color = WHITE` (`Scene/SunLight.js:17-28`); `scene.light` defaults to `new SunLight()` (`Scene.js:758-762`).
- `createWorldTerrainAsync`: "`requestVertexNormals=false` Flag that indicates if the client should request additional lighting information" (`Core/createWorldTerrainAsync.js:11,45`).
- `Atmosphere` holds "Common atmosphere settings used by 3D Tiles and models for rendering sky atmosphere, ground atmosphere, and fog": `lightIntensity` 10, `hueShift`, `saturationShift`, `brightnessShift` 0, `dynamicLighting` `NONE` (`Scene/Atmosphere.js:1-125`). With a globe, the sky follows the globe flags: `skyAtmosphere.setDynamicLighting(DynamicAtmosphereLightingType.fromGlobeFlags(globe))` (`Scene.js`, 1.140 :3520-3524); `fromGlobeFlags` returns `SCENE_LIGHT` when `enableLighting && dynamicAtmosphereLighting` (`DynamicAtmosphereLightingType.js`), and `globe.dynamicAtmosphereLighting` defaults to `true` (`Globe.js:171-178`).
- Every `Model` builds its own environment-map manager: `const environmentMapManager = new DynamicEnvironmentMapManager(options.environmentMapOptions);` (`Model.js:398-405`). Each frame it is re-centred on the model (`environmentMapManager.position = model._boundingSphere.center`, `:2051-2060`), and a move past `maximumPositionEpsilon` (default 1000 m) resets it (`DynamicEnvironmentMapManager.js:145-152, 236-255`). With `SUNLIGHT` lighting it also regenerates after `maximumSecondsDifference` (3600 s) (`:871-886`). It does nothing unless "dynamic updates are supported … requires the EXT_color_buffer_float or EXT_color_buffer_half_float extension" (`:993-999`). So 100 moving aircraft each regenerate an environment map every kilometre today; the cost is unmeasured.

### Spike first?

Yes, two parts, in the real app (`tauri-app`):

- **(a) Dusk-to-night A/B.** For `fixedTimeHour` stepped through sun elevations of +5°, 0°, −6°, −12° and −18° at one airport, take paired screenshots. A is the current path (`enableNightDarkening` on). B is that off, plus in `browser_evaluate`: `globe.lightingFadeOutDistance = 1; globe.lightingFadeInDistance = 2;` and `scene.light.intensity` set from the twilight curve. Check terrain, OSM buildings, aircraft and sky. Repeat B over a flattened runway, and once with a vertex-normals terrain provider swapped in by hand (`viewer.scene.terrainProvider = await Cesium.createWorldTerrainAsync({ requestVertexNormals: true })`) with flattening off. The owner judges the image pairs.
- **(b) Environment-map cost.** With 60+ aircraft moving, compare `perf()` median `totalFrame` and `gpuCesiumMs` with the default managers against `model.environmentMapManager.enabled = false` on every pool model.

### Open decisions

- **E3-a Night model.** (1) *Scene light plus globe fade distances shrunk* (recommended if the A/B passes): one light dims terrain, buildings and models together, no imagery hack; worst case the 0.3 day/night floor is not dark enough and the night floor has to come from light intensity alone, making models darker than the user wants. (2) *Vertex-normal terrain lighting*: real slope shading and a tunable `vertexShadowDarkness`; worst case flattened runway tiles lose their normals (`FlatteningTerrainProvider.ts:1135-1153` drops `encodedNormals`) and render wrong or fail to shade, plus larger terrain downloads. (3) *Keep the imagery fake, add sky/atmosphere shifts only*: smallest change; worst case buildings and aircraft stay daylit over dark ground, as today.
- **Settled (owner ruling):** E3-a option 1, scene light plus shrunk globe fade distances, subject to the A/B.
- **E3-b Per-model environment maps.** (1) *Disable on pool models* if spike (b) shows a cost (recommended): worst case aircraft lose sky-tinted reflections and look flatter at dusk. (2) *Keep the defaults*: worst case frame hitches as aircraft cross 1 km boundaries at busy airports.
- **E3-c Settings shape.** (1) *Same keys, new implementation* (recommended): no new UI, no migration; worst case an existing intensity value looks different. (2) *A mode switch (imagery vs scene light)*: lets users pick; worst case two night paths to maintain, against "replace, don't deprecate".
- **E3-d Default.** (1) *Leave `enableNightDarkening` off by default* (recommended until the new path has shipped once): worst case most users never see the night work. (2) *Turn it on by default with a migration*: worst case users who chose bright nights are switched over.
- **Settled (owner ruling):** E3-d option 2, on by default with a settings migration once the scene-light model lands.

### Size and dependencies

Multi-wave: spike, then build. Files: `hooks/useCesiumNightDarkening.ts` (replaced), `hooks/useCesiumLighting.ts`, `hooks/useCesiumViewer.ts`, `hooks/useBabylonNightLighting.ts`, `components/CesiumViewer/CesiumViewer.tsx` (hotspot: hook wiring at :307-316, :433-436), `components/UI/SettingsGraphicsWeatherTab.tsx` (labels), and `types/settings.ts` + `stores/settingsStore.ts` (hotspots) only if E3-d changes a default. Waits on TC3D-9 (`B1` edits `useCesiumLighting.ts:125,142`). E2 is built with or after it.

---

## F1. GPU particles for rain and snow

### Today

- `useBabylonPrecipitation.ts:250-328` builds a CPU `ParticleSystem` for rain: capacity `RAIN_PARTICLE_CAPACITY` 50,000, emit rate `RAIN_EMIT_RATE_BASE` 100,000/s scaled by intensity, visibility and the user's `precipitationIntensity`, `BILLBOARDMODE_STRETCHED`, additive blend, `preWarmCycles` 150. Snow is the same shape (`:333-397`, 50,000 capacity, 1,500/s).
- Every frame `updatePrecipitation` (`:655-791`) moves the emitter to the camera, rewrites `direction1`/`direction2`/`gravity` with fresh `Vector3`s for wind and gusts (`applyWindToSystem`, `:496-552`), and fades `emitRate` by the smoothed intensity (`:778`).
- A camera jump past `PARTICLE_PREWARM_JUMP_THRESHOLD` disposes and recreates the systems to pre-warm again (`:660-667`, `:840-852`).
- The texture is fetched from the Babylon CDN (`:9`, audit `B4`).

### Proposal

- Add `createPrecipitationSystem(kind, scene)` in the same file. When `GPUParticleSystem.IsSupported`, it returns a `GPUParticleSystem` built with `{ capacity, emitRateControl: true }` and the same properties; otherwise it returns the CPU system with capacity cut to 10,000 and emit rate scaled to match (per F1-a).
- Keep the wind logic but mutate `direction1`/`direction2`/`gravity` in place instead of allocating (they are uniforms on the GPU path, so per-frame updates stay cheap). Try `noiseTexture` (`NoiseProceduralTexture`) with a small `noiseStrength` for turbulence only if the spike shows it adds something.
- Fade with `emitRate` as today; that is why `emitRateControl` is on.
- On disposal call `dispose()`, since `stop()` keeps rendering live particles on the GPU path; the camera-jump recreate already disposes.
- Constants: add `RAIN_PARTICLE_CAPACITY_GPU` / `_CPU` in `constants/precipitation.ts`.

Settings: none; `weather.precipitationIntensity` keeps its meaning. Insets: each iframe has its own Babylon engine and runs the same hook. Remote browsers: Safari and Chromium with WebGL2 take the GPU path; others take the CPU fallback.

### Engine facts

- "You can use `BABYLON.GPUParticleSystem.IsSupported` to detect if GPU particles can be used"; "Sub emitters are not supported in GPU particles"; unsupported: "ManualEmitCount, disposeOnStop, Dual values per gradient …, Emit rate gradients …, Start size gradients …, Mesh emitter"; "Calling `system.stop()` on a `GPUParticleSystem` … particles will still be rendered … To completely stop a `GPUParticleSystem`, you have to call `dispose()`" (Babylon docs, `content/features/featuresDeepDive/particles/particle_system/gpu_particles.md`, Documentation repo `master`).
- `IsSupported` reads the last created engine: `const caps = EngineStore.LastCreatedEngine.getCaps(); return caps.supportTransformFeedbacks || caps.supportComputeShaders;` (`Particles/gpuParticleSystem.pure.js:46-52`, 9.28.0). Check it after the overlay engine exists, not at module load.
- `emitRateControl`: "When true, the GPU particle system limits the number of active particles to approximately emitRate * maxLifeTime (matching CPU particle behavior) … When false (default), all dead particles are recycled immediately" (`gpuParticleSystem.pure.d.ts:113-122`, 9.28.0). Without it, an `emitRate` fade does not thin the rain.
- `GPUParticleSystem.fromParticleSystem(source, sceneOrEngine, options)` copies a CPU system's properties; "`emitRateControl` defaults to `true` here"; a custom `updateFunction` "will be silently dropped" (`:600-625`, 9.28.0). Usable for the spike.
- Stretched billboards are supported on GPU: `case ParticleSystem.BILLBOARDMODE_STRETCHED: defines.push("#define BILLBOARDSTRETCHED");` (`gpuParticleSystem.pure.js:1409-1411`). `preWarmCycles` runs on GPU (`:1888-1893`).
- `gravity`, `direction1`, `direction2` and `noiseStrength` are update-shader uniforms: `this._updateBuffer.setVector3("gravity", this.gravity);` (`:1810`, `:1821`; uniform list `webgl2ParticleSystem.pure.js:40-62`).
- `noiseTexture`: "Gets or sets a texture used to add random noise to particle positions"; `noiseStrength` "(default is (10, 10, 10))" (`baseParticleSystem.pure.d.ts:196-201`, 9.28.0).
- The audit's version gate (`9.26.1` GPU quad-offset fix) is met: the shipped Babylon is 9.28.0 (`package.json:71-73`).

### Spike first?

Yes. (1) Baseline: force heavy rain with `WeatherDebugPanel` (or `stores.weather.setState`) and record `perf()` `babylonRender` (CPU ms) and `gpuBabylonMs`, rain on vs off, at the default and at 4× `precipitationIntensity`. (2) Prototype in `browser_evaluate`: take the rain system from `__tc3d.babylon.scene.particleSystems`, `BABYLON.GPUParticleSystem.fromParticleSystem(cpu, scene)`, `start()` it, `dispose()` the CPU one, and measure again. The hook's per-frame wind updates still target the old object, so the prototype measures cost, not wind. (3) Check visibility with `__tc3d.readPixels` over a sky rectangle: rain is additive with alpha 0 and invisible to screenshots (CLAUDE.md). Build only if (2) cuts CPU time measurably at the default intensity.

### Open decisions

- **F1-a Fallback without GPU particles.** (1) *One factory, CPU fallback at reduced capacity* (recommended): rain everywhere; worst case thinner rain on old remote browsers and two configurations to tune. (2) *GPU only*: one path; worst case no precipitation at all on browsers without WebGL2.
- **Settled (owner ruling):** F1-a option 2, GPU only: no precipitation without WebGL2.
- **F1-b Turbulence.** (1) *Keep the wind uniforms, add noise only if the spike shows a visible gain* (recommended): worst case no change in look. (2) *Adopt `noiseTexture` now*: worst case swirling, unrealistic rain at the 900 m/s streak speeds the constants use (`RAIN_VELOCITY = -900`, `constants/precipitation.ts:37`).
- **F1-c Snow too.** (1) *Rain and snow* (recommended): one factory, one pattern; worst case snow's 12–18 s lifetimes interact badly with `emitRateControl` (unmeasured). (2) *Rain only*: worst case two particle paths in one hook.
- **Settled (owner ruling):** F1-c option 1, rain and snow.

### Size and dependencies

One hook plus constants: `hooks/useBabylonPrecipitation.ts`, `constants/precipitation.ts`. No hotspot file. Waits on TC3D-10 (`B4` changes the texture source in the same file); independent of the Cesium bump.

---

## F2. Overlay in VR

### Today

- `VRScene.tsx` (mounted from `App.tsx:618`, button in `ControlsBar.tsx:791`, shown when `navigator.xr.isSessionSupported('immersive-vr')`, `vrStore.ts:65-78`) creates a second Babylon `Engine` and `Scene` with a `HemisphericLight` and two 1000 m planes 500 m ahead carrying `DynamicTexture`s.
- Each frame `useCesiumStereo.renderStereoFrame` renders Cesium twice with an eye offset and `drawImage`s the canvas into 1536² 2D canvases (`useCesiumStereo.ts:215-268`), which are copied into the textures (`VRScene.tsx:202-220`).
- The planes use `layerMask` `0x10000000` (left) and `0x20000000` (right) (`:189`, `:197`); the XR camera's mask is never set.
- The Cesium camera does not follow the headset: `useCesiumVRRotation` exists but has no caller (`useCesiumStereo.ts:289-317`, audit `G3`).
- No labels, weather or cab, against the docblock (`VRScene.tsx:15-18`). `vrStore.renderScale` and `maxAircraftInVR` are never read.
- USER_GUIDE.md:799-803 promises "Look around naturally with head tracking"; README.md:112-113 and CHANGELOG.md:1000-1004 list VR support.

### Proposal

Rebuild VR with the overlay scene (owner ruling, F2-a option 3): render Cesium per eye into textures shared with the overlay engine, drive both from the XR pose, and draw labels, weather and the cab in the headset. This is multi-wave and needs a design of its own before any building (TC3D-46), starting from a headset session the owner runs to see what renders today. Until it ships, the USER_GUIDE and README claims stay wrong; the design decides whether they are corrected now. The two defects below are where the rebuild starts. Adopting 9.25 dynamic viewport scaling belongs in that design. Inset and remote implications: none (VR is main-window only).

### Engine facts

- Babylon renders a mesh only when masks overlap: "A camera with a layerMask of 1 will render mesh.layerMask & camera.layerMask!== 0" (`Cameras/camera.pure.d.ts:202-205`, 9.28.0); the default camera mask is `0x0fffffff` (`Cameras/camera.pure.js:264`, `scene.pure.js:1535`). `0x10000000 & 0x0fffffff` and `0x20000000 & 0x0fffffff` are both 0, so neither eye plane is drawn.
- WebXR eye cameras copy one mask from the XR camera: `// Replicate parent rig camera behavior` `currentRig.layerMask = this.layerMask;` (`XR/webXRCamera.js:329-330`, 9.28.0). Per-eye planes cannot be split by `layerMask` this way.
- Dynamic viewport scaling (9.25): `isViewportScaleSupported(viewIndex)`, `getRecommendedViewportScale(viewIndex)`, `requestViewportScale(viewIndex, scale)`; "This method must be called during an active XR frame" (`XR/webXRSessionManager.d.ts:148-179`, 9.28.0).

### Spike first?

No for the retire decision: the two defects are established from source. Keeping VR needs a headset session (Quest Link or SteamVR into WebView2) to see what renders before any design, which this machine's agents cannot run.

### Open decisions

- **F2-a VR's future.** (1) *Retire VR mode* (recommended): removes 1,023 lines across the six VR/stereo files (`wc -l`) and three phantom features from the docs; worst case a user who relies on the experimental button loses it (it shows at most a static stereo image today, by the analysis above). (2) *Keep, fix docs and the two defects, Cesium-only*: worst case a stereo-from-2D-canvas pipeline (two full Cesium renders plus two CPU `drawImage` copies per frame) that will not hold headset frame rates. (3) *Rebuild VR with the overlay scene*: render Cesium per eye into textures shared with the overlay engine and drive both from the XR pose; worst case a multi-wave project on hardware no agent can test.
- **Settled (owner ruling):** option 3, rebuild VR with the overlay scene.

### Size and dependencies

Multi-wave, designed in TC3D-46. Touches the VR/stereo files above, `utils/cesiumFrustumPatch.ts`, `App.tsx`, the overlay engine setup and the docs that describe VR. Overlaps TC3D-13 (`G3` edits `cesiumFrustumPatch.ts` and `useCesiumStereo.ts`): `G3` waits for the VR design, which may absorb it.

---

## F3. MSDF text renderer

### Today

- Each aircraft label is a `GUI.Rectangle` with a `GUI.TextBlock` and a `GUI.Line` leader on one fullscreen `AdvancedDynamicTexture` (`useBabylonScene.ts:297`, `useBabylonLabels.ts:338-381`).
- Every update re-sets text, colours, DPR-scaled font size, paddings, corner radius, thickness and scale (`:383-400`), and repositions the label and line (`:405-` onward).
- Per-frame cost is timed only as part of `babylonRender` (`CesiumViewer.tsx:888-893`). TC3D-11 changes this code: `D3` outline, `D4` skip no-op updates, `D5` measure `useInvalidateRectOptimization`.

### Proposal

Measurement only (F3-a option 1). After TC3D-11 lands, measure label cost; open a build item only if it crosses the F3-b threshold. If a build is approved, its shape would be:

- add `@babylonjs/addons`, ship one MSDF font atlas (Geist Mono, generated with msdf-bmfont) under `src/renderer/public/`;
- create one `TextRenderer` per label colour, rebuilt with `clearParagraphs()` + `addParagraph(text, options, worldMatrix)` when label text or position changes, rendered after the scene with a screen-space orthographic projection;
- keep the background boxes and leader lines as GUI controls or thin meshes.

That touches `useBabylonLabels.ts`, `useBabylonScene.ts` and `useBabylonOverlay.ts` (hotspot) and adds a dependency.

### Engine facts

- `@babylonjs/addons` `TextRenderer`: "Two assets are needed …: 1. A texture that contains the MSDF glyphs. 2. A JSON file that describes the bounds of each glyph"; "creating a TextRenderer is async: `await ADDONS.TextRenderer.CreateTextRendererAsync(fontAsset, engine)`"; properties "color: Color4 used to define the color of the text", "strokeColor", "strokeOutsetWidth", "isBillboardScreenProjected … keeps a constant on-screen size" "control all rendering for a TextRenderer" (Babylon docs `content/addons/msdfText.md`, Documentation repo `master`).
- In source, `color` is one field per renderer (`public color: IColor4Like`), paragraphs carry no colour, and the per-glyph matrices and UVs are rebuilt on `addParagraph`/`clearParagraphs` (`packages/dev/addons/src/msdfText/textRenderer.ts:72, 236-293`, Babylon.js `master`; npm `@babylonjs/addons` latest is 9.29.0, not pinned to the shipped 9.28.0).
- `AdvancedDynamicTexture extends DynamicTexture` (`@babylonjs/gui/2D/advancedDynamicTexture.d.ts:31`, 9.28.0), "A class extending Texture allowing drawing on a texture" (`dynamicTexture.pure.d.ts:17-21`): labels are drawn on a 2D canvas and uploaded as a texture.

### Spike first?

Yes, and it is the whole item until it says otherwise. On the `tauri-app` server, at a busy airport with about 100 labelled aircraft (live traffic or a replay):

- record `perf()` `babylonRender` and `gpuBabylonMs` medians with datablocks shown and hidden (same camera, `datablockMode` toggled through `stores.settings`), at DPR 1 and DPR 2;
- for DPR, set `Emulation.setDeviceMetricsOverride` inside a single `browser_run_code_unsafe` call, since CDP overrides last only for that call;
- repeat on an iPad remote browser if one is at hand (manual, reading the Performance HUD).

The label share is the difference between the shown and hidden runs.

### Open decisions

- **F3-a Pursue MSDF?** (1) *Measure only; close F3 unless the threshold is crossed* (recommended): worst case a real bottleneck on a device not measured. (2) *Build MSDF labels*: worst case per-colour renderers multiply draw calls, boxes and lines stay on the canvas texture so the saving is partial, and a font-atlas pipeline is added.
- **Settled (owner ruling):** F3-a option 2, build MSDF labels; F3-b's threshold no longer gates the build (the measurement still runs, as the before/after baseline).
- **F3-b Threshold.** (1) *Label share above 2 ms CPU or GPU at 100 labels on the owner's desktop, or above 4 ms on an iPad* (recommended): worst case a borderline machine just under the line. (2) *Any visible frame drop with labels on*: worst case noise in a subjective test.

### Size and dependencies

One-site for the measurement (harness only, after S0). Waits on TC3D-11 (`D3`–`D5` change what is measured). A build, if approved, is multi-file with one hotspot (`hooks/useBabylonOverlay.ts`) and a new dependency.

---

## Open decisions (index)

| ID | Question | Options, recommended first |
|---|---|---|
| E1-a | Animation scope | Gear only, parity · gear + flaps/spoilers by phase · all clips |
| E1-b | If the native callback still fails | Keep matrix path and document the repro · matrices from loaded model data |
| E2-a | Shader granularity | Two shared instances (built-in, FSLTL) · one per pool slot |
| E2-b | Brightness above 1.1 | Emissive glow keeping the livery · keep post-lighting MIX glow |
| E2-c | Nav lights | Out of scope · spike converter output first |
| E3-a | Night model | Scene light + shrunk globe fade distances · vertex-normal terrain lighting · keep imagery fake + sky shifts |
| E3-b | Per-model environment maps | Disable on pool models if costly · keep defaults |
| E3-c | Settings shape | Same keys, new implementation · mode switch |
| E3-d | Night darkening default | Leave off · turn on with migration |
| F1-a | No-WebGL2 fallback | CPU fallback via one factory · GPU only |
| F1-b | Turbulence | Keep wind uniforms, noise only if it helps · adopt noise now |
| F1-c | Snow too | Rain and snow · rain only |
| F2-a | VR's future | Retire VR · keep, fix docs and defects · rebuild with overlay |
| F3-a | Pursue MSDF | Measure only · build MSDF labels |
| F3-b | Threshold | >2 ms desktop or >4 ms iPad at 100 labels · any visible drop |
