# Rendering Engine Audit — Cesium & Babylon.js

Audit date: 2026-09-08. Findings from an inventory of every Cesium/Babylon API the frontend uses, cross-checked against upstream changelogs.

| Library | Shipped | Latest | Notes |
|---|---|---|---|
| `cesium` | 1.140.0 | 1.145.0 (2026-09-02) | No package-layout, worker, or asset changes. Node ≥ 22 for build tooling (CI already on 22). |
| `@babylonjs/core`, `gui`, `loaders` | 9.5.0 | 9.25.0 (2026-09-03) | No 10.x planned. Babylon Lite is a separate WebGPU-only engine, not an upgrade path. |

Ordering: A → B → C are sequential (upgrade, then the fixes that depend on it, then quick wins). D onward are independent and can be picked in any order.

---

## A. Dependency upgrades

### A1. Cesium 1.140 → 1.145

- [ ] Bump `cesium` to `^1.145.0`, `pnpm install`, `pnpm run typecheck`, `pnpm biome check src/`.
- [ ] Remove the two `@ts-expect-error` comments for `SkyBox.show` (`CesiumViewer.tsx:330`, `ModelPreviewModal.tsx:53`) — typings fixed in 1.141.
- [ ] Confirm `dompurify` resolves to ≥ 3.4.5 in `pnpm-lock.yaml` (CVE-2026-49458; lockfile currently has 3.3.3).
- [ ] Smoke-test terrain flattening. `terrain/FlatteningTerrainProvider.ts:1060-1152` reads private `QuantizedMeshTerrainData` fields with no public replacement; re-verify on every Cesium bump.
- [ ] Smoke-test the other private-API sites: `globe._surface._tileReplacementQueue.trimTiles` patch (`useCesiumViewer.ts:377-389`), `shadowMap._terrainBias` / `_primitiveBias` (`useCesiumLighting.ts:148-172`), `scene.frameState.cullingVolume` (`useRenderCulling.ts:148-158`), perf HUD counters (`CesiumViewer.tsx:862-865`).
- [ ] Verify Cesium workers still resolve (`Build/Cesium/Workers/*`) and imagery decodes — silent 404s are the known failure mode with `vite-plugin-static-copy`.

Upstream fixes gained by this bump that touch code we run:
- 1.144 — one-frame black flash from stale framebuffer binding cache (post-process stages + shadow maps trigger it).
- 1.144 — post-process stage no longer crashes when the selected-feature list exceeds max texture width (our silhouette stage feeds up to 100 models).
- 1.143 — invalid glTF sampler wrap modes fall back to REPEAT instead of throwing (FSLTL/AIG converted models).
- 1.142 — multiple key modifiers on one `ScreenSpaceEventHandler.setInputAction`.

### A2. Babylon 9.5 → 9.25

Jump straight to 9.25.0. Releases 9.8–9.18 carried the tree-shaking "pure barrel" migration with weekly regress/fix cycles (glTF loader auto-registration broke in 9.15/9.16, restored 9.16.2 and 9.19).

- [ ] Bump `@babylonjs/core`, `@babylonjs/gui`, `@babylonjs/loaders` to `^9.25.0`, `pnpm install`, `pnpm run typecheck`, `pnpm biome check src/`.
- [ ] Test whether `optimizeDeps.exclude: ['@babylonjs/core']` in `vite.config.ts:92-96` (AudioV2 circular-import workaround) is still needed. Remove it if `pnpm run vite:dev` boots cleanly without it.
- [ ] Verify tower cab loads through the side-effect import `@babylonjs/loaders/glTF` (`useBabylonScene.ts:4`) and that the +90° handedness composition in `useBabylonTowerModel.ts:200-221` still lines up with Cesium (check a known mod, e.g. OAK).
- [ ] Verify rain/snow still render and survive a camera teleport (dispose + recreate path, `useBabylonPrecipitation.ts:660-668, 840-852`).
- [ ] Verify datablock labels and leader lines at DPR 1 and DPR 2 after `engine.resize()`.
- [ ] Measure the `babylon` chunk size before/after (`vite.config.ts:129` chunk group). The pure barrel only pays off with tree-shakeable imports — see D1.

Upstream fixes gained:
- 9.9 — `adaptToDeviceRatio` option state fixed (enables D2).
- 9.16 — `ParticleSystem.clone()` texture bug; `emitRateControl` on `GPUParticleSystem`.
- 9.19.1 — one-frame render flash when recreating a mesh in the same tick (our teleport path).
- 9.22.2 — 43 correctness fixes from a systematic core scan.
- 9.25 — dynamic WebXR viewport scaling (VR frame rate).

---

## B. Bugs found during the audit

- [ ] `shadowMap.darkness` is inverted (`1 - x`) at `useCesiumLighting.ts:125,142` but not at `useCesiumViewer.ts:344`. Initial and updated shadow darkness disagree. Pick one convention.
- [ ] `syncCamera` runs twice per frame: once from the `postRender` handler (`CesiumViewer.tsx:856-887`) and again inside `render()` (`useBabylonOverlay.ts:238-242`). Drop one call.
- [ ] Memory-leak warning at `CesiumViewer.tsx:978-993` can never fire: `getMemoryCounters()` in `useBabylonOverlay.ts:305-318` returns hardcoded zeros. Either wire `getLabelMemoryCounters()` (exists, never called) plus a real weather counter, or delete the warning.
- [ ] Precipitation texture is fetched from `https://assets.babylonjs.com/textures/flare.png` at runtime (`useBabylonPrecipitation.ts:9`). Vendor it under `src/renderer/public/` so rain works offline / first run.

---

## C. Cesium quick wins (small, self-contained)

- [ ] **Native model silhouettes.** Replace the edge-detection `PostProcessStageComposite` (`useCesiumViewer.ts:284-325`, five-frame deferral + `_shaderCache` guard + per-frame `selected` refresh at `useAircraftModels.ts:559-570`) with `Model.silhouetteColor` / `Model.silhouetteSize` on each pooled model. Keep the setting toggle; delete the stage.
- [ ] **Expose `viewer.resolutionScale`** as a graphics setting (cheapest perf knob for iPad / remote browsers). Follow the `add-setting` skill. Consider also `useBrowserRecommendedResolution`.
- [ ] **Try `scene.pick` for datablock slew and measuring-tool endpoint deletion.** The hand-rolled screen-space O(n) loop (`CesiumViewer.tsx:1147-1161`, `:1043-1066`) avoided picking because of a click-flicker bug, but that came from the Viewer's default `LEFT_CLICK` / `LEFT_DOUBLE_CLICK` handlers, which are already removed (`useCesiumViewer.ts:273-274`). If `scene.pick` is flicker-free, switch and delete the loop.
- [ ] **Synchronous ground heights near the camera.** `useGroundAircraftTerrain.ts:310` runs a 333 ms interval batching `sampleTerrainMostDetailed`. For aircraft inside the loaded high-detail tile radius, `globe.getHeight(cartographic)` is synchronous and per-frame capable. Keep the async path as fallback for far aircraft.
- [ ] **Check whether `useRenderCulling` is redundant.** Cesium already frustum-culls `Model` primitives by bounding sphere. If the hook only saves the CPU-side `modelMatrix` update, measure that saving before keeping the private `frameState.cullingVolume` access.
- [ ] **OSM Buildings tileset knobs.** `dynamicScreenSpaceError` and `foveatedScreenSpaceError` are unset on the `createOsmBuildingsAsync` tileset (`CesiumViewer.tsx:693-709`). Try them at the lower quality tiers.

---

## D. Babylon quick wins

- [ ] **D1. Tree-shakeable imports.** Every file does `import * as BABYLON from '@babylonjs/core'` (9 files) / `import * as GUI from '@babylonjs/gui'` (2 files). After A2, convert to named imports (`import { Engine, Scene, ... } from '@babylonjs/core'`) and re-measure the chunk. Depends on A2.
- [ ] **D2. Replace manual DPR sizing with `adaptToDeviceRatio`.** `useBabylonScene.ts:268-269, 350-356` writes `canvas.width/height` by hand and then calls `guiTexture.scaleTo()` (`:361`) to un-stretch labels. With the 9.9 fix, the engine option should make both redundant. Re-test the `dpr` multiplications in `useBabylonLabels.ts:406-413`. Depends on A2.
- [ ] **Text legibility.** `TextBlock` labels have no `outlineWidth` / `outlineColor` or `shadowBlur` (`useBabylonLabels.ts:352-365`). A 1–2 px outline is the cheap fix for labels over bright imagery.
- [ ] **Skip no-op label updates.** `updateLabel` (`useBabylonLabels.ts:387-395`) reassigns `text`, `color`, `fontSize`, `background`, `scaleX/Y` every call. Early-out when unchanged; `rgbToHex` allocates three strings per aircraft per frame.
- [ ] **Measure `useInvalidateRectOptimization`.** Default is on; with ~100 controls all moving every frame the dirty-rect union approaches a full invalidate anyway. Compare frame time with it off.
- [ ] **Context-lost handling.** `useBabylonScene.ts` sets no `onContextLostObservable` / `onContextRestoredObservable`. A GPU reset in WebView2/WKWebView kills the overlay silently. At minimum log and mark the overlay unhealthy.
- [ ] **Hardware scaling level.** `engine.setHardwareScalingLevel()` is never called. Pair with the Cesium `resolutionScale` setting (C) so one slider drives both canvases.

---

## E. Larger Cesium opportunities (need design)

- [ ] **Native glTF animations.** `utils/gearAnimationController.ts` + `utils/gltfAnimationParser.ts` re-parse the glTF and write `model.getNode(name).matrix` directly, bypassing `model.activeAnimations` because of a past issue with the `animationTime` callback (`gearAnimationController.ts:21-27`). Re-test `activeAnimations.add({ animationTime })` on 1.145. Native animation would also unlock flaps, props, and control surfaces. If the callback still misbehaves, document the repro.
- [ ] **`Model.customShader` for tint and night boost.** Currently the legacy `color` + `colorBlendMode: MIX` + `colorBlendAmount` + `lightColor` triple (`useAircraftModels.ts:465-491`). A custom shader gives per-aircraft control (emissive nav lights, night brightness) without fighting the lighting model.
- [ ] **Atmosphere and lighting on the main viewer.** Night look is faked by imagery `brightness`/`gamma` (`useCesiumNightDarkening.ts:150-179`) and `model.lightColor`. Never touched: `scene.atmosphere` (`lightIntensity`, hue/saturation/brightness shifts, `dynamicLighting`), `globe.dynamicAtmosphereLighting`, `skyAtmosphere.*Shift`, `scene.light`, and the per-model `environmentMapManager` (sky-lit IBL, shipped 2025). Prototype a dusk-to-night transition on top of Cesium's own lighting and compare.

---

## F. Larger Babylon opportunities (need design)

- [ ] **GPU particles for rain.** `useBabylonPrecipitation.ts:250-328` runs a CPU `ParticleSystem` with 50 k capacity and 100 k/s emit rate, updating every particle on the main thread. `GPUParticleSystem` works on WebGL2. Use `noiseTexture` + `noiseStrength` for wind turbulence instead of rewriting `direction1/direction2/gravity` every frame (`:496-552`), and colour/size gradients for fade.
- [ ] **Overlay in VR.** `VRScene.tsx` builds a second, independent engine; labels, weather, and the cab are absent in VR despite the docblock (`:15-18`). Decide whether VR should render the overlay scene or stay Cesium-only, and fix the docblock either way. If staying, adopt 9.25 dynamic viewport scaling.
- [ ] **MSDF text renderer** (`@babylonjs/addons`) as the GPU alternative to canvas-2D GUI text if label counts or DPR make the ADT the bottleneck. Measure first (D).

---

## G. Dead code and dead dependencies

- [ ] Remove `resium` from `package.json` — declared, zero imports.
- [ ] Delete `src/renderer/utils/tileCache.ts` — IndexedDB caching providers, imported nowhere; the old DB is explicitly deleted at startup (`CesiumViewer.tsx:546`).
- [ ] Delete the unused half of `utils/cesiumFrustumPatch.ts` (`applyEyeOffset`, `applyFrustumXOffset`, `resetFrustumOffset`, `applyCameraPositionOffset`, `renderStereoFrame`, `renderStereo`, `calculateStereoOffset`, `clearFrustumState`, `clearCameraState`) and `useCesiumVRRotation` (`useCesiumStereo.ts:289`).
- [ ] Delete or wire the 27-line commented-out near-plane block at `CesiumViewer.tsx:343-376` (setting still read as `_cameraNearPlane` at `:131`).
- [ ] `useBabylonRootNode.ts` creates a `TransformNode` nothing is parented to (`:77-83`). Remove the hook or parent the weather meshes to it.
- [ ] `useBabylonCameraSync.ts` exports a duplicate terrain-sampling path (`setupBasePosition`, `getTerrainOffset`, `setTerrainOffset`, …) that `useBabylonOverlay.ts:229-235` never destructures. Remove.
- [ ] `useBabylonLabels.ts:529-545` — `clearAllLabels` / `getLabel` returned, never called.
- [ ] `gearAnimationController.ts:277` — `_knownAnimationCount` parameter is passed and ignored.

---

## H. Documentation drift

- [ ] `docs/architecture.md:321,548` and `docs/coordinate-systems.md:66` say Babylon renders the measuring tool. It is pure Cesium `Entity` (`MeasuringTool.tsx`).
- [ ] `docs/architecture.md:730-767` lists 5 Babylon sub-hooks; `useBabylonOverlay.ts:188-235` composes 7, plus `useBabylonNightLighting` and `useBabylonSunDirection` attached in `CesiumViewer.tsx:428-441`. Precipitation, lightning, tower cab, shadow generator, and IBL are undocumented.
- [ ] `docs/architecture.md:733` — "MSAA 4x"; the code passes `antialias: true` (browser-chosen sample count). The `graphics.msaaSamples` setting drives Cesium only.
- [ ] `docs/architecture.md:754` — `useBabylonRootNode({ scene, cesiumViewer })`; actual signature is `{ scene }`.
- [ ] `docs/architecture.md:881` — `CesiumViewer.tsx` "659 LOC"; now 1199. `:727-730, 788` — orchestrator "265 LOC"; now 320.
- [ ] Add a "Known limitations" section to `docs/architecture.md` covering the two-canvas depth split (labels/clouds can't depth-test against Cesium; cab can't shadow terrain; Cesium sky/sun/moon are hidden to fake OVC), currently only in source comments (`useBabylonTowerModel.ts:19-25`, `useBabylonWeather.ts:1207-1208`, `CesiumViewer.tsx:319-321`).
