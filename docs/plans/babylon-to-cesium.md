# Babylon to Cesium migration

The design for the Linear project "Babylon to Cesium migration": the owner's ruling on TC3D-62 (Babylon deprecated, all rendering moves into Cesium, VR dropped), turned into an inventory of what Babylon does today, milestones, a verdict per affected issue and the decisions still open.

The decision record is `single-engine-assessment.md`; the proven approach is spike A (`canvases/spike-cesium-weather/`, code on branch `spike-cesium-weather`, 715e42a: `useTowerModel.ts`, `useCesiumSpikeWeather.ts`, `spikeWeatherShaders.ts`, `spikeWeatherStore.ts`).

Written against `d470aa6`; line numbers are hints, re-resolve them with `rg -n` before a brief.

VR revival: if VR comes back later, start from the last commit that holds `hooks/useCesiumStereo.ts` and `utils/cesiumFrustumPatch.ts` (Cesium already renders each eye with a patched frustum; Babylon only owned the WebXR session), record that sha here when M1 lands, and replace Babylon's XR helper with a plain WebXR session.

# 1. Babylon inventory

Counts below come from `git grep -l "@babylonjs"` (16 files in `src/`, plus `package.json`, `vite.config.ts`, `.github/dependabot.yml`) and `wc -l`. The assessment's "16 files, 6,135 lines" matches the file count; my per-group line totals are summed from `wc -l` and not re-derived to its figure. No file under `tests/` mentions Babylon (`rg` over `tests`: 0 hits), so nothing pins Babylon behaviour; the only Babylon "test" is the dev harness.

## 1a. Labels and leader lines
| File | Lines | Role |
|---|---|---|
| `src/renderer/hooks/useBabylonLabels.ts` | 576 | GUI `Rectangle` + `TextBlock` + `Line` per aircraft on one fullscreen `AdvancedDynamicTexture`; DPR scaling by hand (:383-418); ray-rectangle leader endpoint; writes label rectangles to `datablockPositionStore.setLabelBounds` (:508) |
| `src/renderer/hooks/useBabylonScene.ts` | 393 | owns the GUI texture (:297), engine, scene, camera, lights, shadow generator, IBL load (:324-343) |
| `src/renderer/hooks/useBabylonOverlay.ts` | 320 | orchestrator; adapter API `updateAircraftLabel` / `updateLeaderLine` / `removeAircraftLabel` / `getAircraftCallsigns` / `hideAllLabels` / `isDatablockVisibleByWeather` that `useCesiumLabels` consumes |
| `src/renderer/stores/datablockPositionStore.ts` | 114 | `labelBounds` map filled by Babylon, read by `findLabelAtPosition` (:105) |
| `src/renderer/hooks/useCesiumLabels.ts` (consumer) | 640 | Cesium-side projection, overlap layout, filtering; calls the overlay adapter at :458, :463, :496, :587, :591-594; colours are `{r,g,b}` 0..1 built for Babylon (:409-417) |
| `src/renderer/components/CesiumViewer/CesiumViewer.tsx` (consumer) | 1205 | click hit-test uses `findLabelAtPosition(x*dpr, y*dpr)` (:1145); creates the canvas (:515-542); `.babylon-overlay-canvas` in `CesiumViewer.css:28-37` |

Replaces it in Cesium: no engine; a plain 2D layer (assessment option A table, "Labels and leader lines": canvas or HTML overlay, no depth needed). Labels are already projected by Cesium (`useCesiumLabels.ts` ~502, ~536).
Read by: `useCesiumLabels` (everything above), `CesiumViewer.tsx` click path (label bounds), TC3D-31 (`useCesiumLabels.ts:476` uses `window.innerWidth`), TC3D-105 (dead `flightPhase` branch in `useCesiumLabels.ts:42-43`), TC3D-97/98 on-plane cameras (hide followed datablock, `useCesiumLabels.ts:253-255`; `docs/plans/on-plane-cameras.md:14-15` names `useBabylonLabels.ts:344`), TC3D-79 drawer (stacking over the label layer), TC3D-83 (Traffic & Labels settings: `datablockFontSize`, leader length).

## 1b. Clouds
| File | Lines | Role |
|---|---|---|
| `src/renderer/hooks/useBabylonWeather.ts` | 1415 | fog dome + 4-slot cloud pool (planes, domes, above-planes), METAR smoothing reads, rotation animation (:1220-1359), label culling `isVisibleByWeather` (now in `useBabylonOverlay.ts:258-272`), per-type materials, night emissive |
| `src/renderer/hooks/weather/cloudDomeMesh.ts` | 118 | dome mesh builder (Babylon import) |
| `src/renderer/hooks/weather/cloudTextureGenerator.ts` | 323 | procedural cloud textures (Babylon import) |
| `src/renderer/hooks/weather/cloudNoiseGenerator.ts` | 58 | noise (no Babylon import, serves the textures) |
| `src/renderer/hooks/weather/index.ts` | 11 | barrel |
| `src/renderer/constants/weather.ts` | n/a | cloud and fog geometry/animation constants (not read; unmeasured) |

Replaces it: a `PostProcessStage` composite that raymarches each METAR layer as a noise slab and stops at the scene depth (spike: `useCesiumSpikeWeather.ts`, `spikeWeatherShaders.ts`; `czm_windowToEyeCoordinates` on the stage `depthTexture` under log depth; 4 layers max; clouds at half res then composite at full res).

Spike verdict (`canvases/spike-cesium-weather/index.html`): occlusion correct in all five cases; look "first draft" (value noise, flat deck tops, horizon band from a flat 40 km deck, fringe at half res); cost "+9.7 ms CPU draw time half res, +14.1 ms full res, GPU timer read 0 on this machine, iPad unmeasured"; estimate for the rest of the route 2.5-3.5 weeks (implementer's guess).
Read by: `useCesiumLabels` through `isVisibleByWeather` (label culling), `useBabylonCameraSync` (cloud recentering in 10 km steps), `SettingsGraphicsWeatherTab.tsx`, `useInsetStoreSync.ts:116-126` and `SettingsSharedWorkerService.ts:302-305` (they ship `fogDensity`, `cloudLayers`, `visib` to insets/remote clients; the Cesium stage reads the same `weatherStore`).

## 1c. Fog
Same files as clouds (`useBabylonWeather.ts` fog dome effect :864-926, scale = `visibilityMeters * visibilityScale`) plus Cesium's own fog `useCesiumWeather.ts` (89 lines; `scene.fog` density from `fogDensity`, gated on `showWeatherEffects && showCesiumFog`) and `weatherStore.visibilityToFogDensity` (the spike exports it).
Replaces it: fog in the same post-process composite, `exp(-distance/visibility)` with a height falloff (spike: 400 m scale, none at 10 SM+), replacing both the dome and the `scene.fog` tuning; also the base TC3D-70 needs.
Read by (second copy of the culling rule): `useAircraftFiltering.ts:382-395` (Nearby Aircraft panel "weather visibility" filter reads `showCesiumFog`, `showClouds`, `visibilityScale` and calls the shared `isVisibleThroughWeather`). `useBabylonOverlay.ts:263` gates label culling on `showCesiumFog`, not `showBabylonFog` (TC3D-137).

## 1d. Precipitation (rain, snow, lightning)
| File | Lines | Role |
|---|---|---|
| `src/renderer/hooks/useBabylonPrecipitation.ts` | 1019 | CPU `ParticleSystem` 50k capacity (rain 100k/s emit, snow 1.5k/s), stretched billboards, additive, per-frame wind rewrites (:496-552), lightning flash; texture fetched from `assets.babylonjs.com/.../flare.png` (:9, audit B4) |
| `src/renderer/constants/precipitation.ts` | 221 | rates, capacities, wind constants |

Replaces it: depth-aware screen-space post-process or a GPU-animated instanced primitive (assessment: Cesium's `ParticleSystem` is CPU billboards, "too slow for 50,000 particles (inferred)"); spike estimate 3-5 days.

Reads: `weatherStore` (`precipitation`, `wind`, `cameraPosition`), `airportStore`, settings `showWeatherEffects/showPrecipitation/precipitationIntensity/showLightning` (:177-180). Nothing else reads it; `__tc3d.readPixels` exists because this additive alpha-0 rain is invisible to screenshots (`CLAUDE.md` harness section, `docs/DRIVING_CONVENTIONS.md:124-126`).

## 1e. Tower cab
| File | Lines | Role |
|---|---|---|
| `src/renderer/hooks/useBabylonTowerModel.ts` | 351 | loads the mod glTF into the Babylon scene; manifest fallback chain; wizard live edit via `towerPositioningStore`; adds an extra +90 degrees heading (:199-221); casts to the Babylon shadow generator (:226) |
| `src/renderer/hooks/useBabylonScene.ts` | (above) | IBL environment `IBL_ENV_URL` = `src/renderer/public/cab-environment.env` (Babylon `studio.env`, `CREDITS.md:7-11`), `ShadowGenerator` 2048 |
| `src/renderer/hooks/useBabylonRootNode.ts` | 289 | ENU `TransformNode`, geoid/terrain sampling for the cab and weather placement |

Replaces it: Cesium `Model` as before commit 05d0611; `hooks/useTowerModel.ts` now draws the cab in the main view (shadow, night darkening, one axis convention in `utils/modelOrientation.ts`), and `useBabylonTowerModel.ts`, `useBabylonSunDirection.ts` and the Babylon shadow generator and IBL load are deleted.

Read by: `SettingsModsTab.tsx:137` (comment only: the positioning store starts at 0 and `useBabylonTowerModel` caches the terrain), `towerPositioningStore` wizard, TC3D-126 (cab unlit at night), TC3D-138 (axis convention: the Babylon path adds +90 degrees, the Cesium path would use `gltfForwardAxis = X`). Important coupling: the cab only lives in Babylon so Babylon clouds depth-test against it. The cab and the Babylon weather must leave Babylon together (see M2).

## 1f. VR
| File | Lines |
|---|---|
| `src/renderer/components/VR/VRScene.tsx` (Babylon WebXR, second `Engine`) | 245 |
| `src/renderer/components/VR/VRButton.tsx` | 51 |
| `src/renderer/components/VR/VRScene.css` | n/a |
| `src/renderer/stores/vrStore.ts` | 80 |
| `src/renderer/hooks/useCesiumStereo.ts` (Cesium stereo canvases for VR) | 319 |
| mounts: `src/renderer/App.tsx:30,92-93,618`; `src/renderer/components/UI/ControlsBar.tsx:15,791` | |
Plus the unused half of `utils/cesiumFrustumPatch.ts` and `useCesiumVRRotation` (audit G3 / TC3D-13). Docs: `README.md:112-113,299`, `USER_GUIDE.md` (TOC :21, :220, section :782-808), `docs/architecture.md` (vrStore, VRScene, stereo mentions). No VR key exists in `types/settings.ts`, `settingsStore.ts`, `SettingsTreeBuilder.ts` or the Rust settings (`rg` 0 hits), so removal needs no settings migration. Replaces it: nothing (dropped, TC3D-46 cancelled).

## 1g. Camera sync and ENU
| File | Lines | Role |
|---|---|---|
| `src/renderer/hooks/useBabylonCameraSync.ts` | 418 | copies Cesium camera to Babylon (ECEF to ENU, Euler extraction, 2D top-down mode), recenters fog dome and clouds; runs in `postRender` (`CesiumViewer.tsx:877-879`) and again in `render()` (`useBabylonOverlay.ts:238-242`, audit B2) |
| `src/renderer/hooks/useBabylonRootNode.ts` | 289 | (above) |
| `src/renderer/utils/enuTransforms.ts` | 237 | ENU helpers; `cesiumToBabylon`, `enuToBabylonPosition`, `calculateBabylonCameraRotation` are Babylon-typed; the pure `ecefToEnu`/matrix helpers are used by the cab hook and the spike's stage |
| `src/renderer/hooks/useBabylonSunDirection.ts` | 129 | aims the Babylon directional light at the real sun (`CesiumViewer.tsx:440`) |
| `src/renderer/hooks/useBabylonNightLighting.ts` | 148 | dims the Babylon scene lights named `light` and `dirLight` by sun elevation (`CesiumViewer.tsx:434`); the fog dome is unlit, and the fallback cloud planes dim only through those lights. Constants `BABYLON_NIGHT_*` in `constants/lighting.ts:62-87` (the two `*_EMISSIVE_MULT` ones have no reader), re-exported at `constants/index.ts:315-319`. Deleted in TC3D-149 |
| `src/renderer/types/babylon.ts` | 295 | types for all of the above (re-exported `types/index.ts:311-336`) |
| `src/renderer/constants/babylon.ts` | 426 | scene, camera, visibility thresholds, lighting (re-exported `constants/index.ts:104-182`) |

Replaces it: nothing needed (one camera). Night look: Cesium's own lighting (TC3D-59, `useCesiumNightDarkening.ts` 195 lines stays) plus the weather stage, which already dims cloud and fog by sun elevation (`daylight()` in `hooks/weather/cloudStage.glsl.ts`, on its own curve). One curve shared by every layer is TC3D-185's design.

## 1h. Harness, perf HUD, tests
| File | Lines | What |
|---|---|---|
| `src/renderer/hooks/useAgentHarness.ts` | 91 | `window.__tc3d.babylon = { engine, scene }`, `readPixels` (throws "Babylon engine or canvas is not available", :69); on the spike branch it also gained a `spike` handle (+64 lines) |
| `src/renderer/types/harness.ts` | 88 | `AgentHarness.babylon` typed `BABYLON.Engine/Scene` (:13, :33-36), `readPixels` doc (:72-78) |
| `src/renderer/components/UI/PerformanceHUD.tsx` | 233 | "GPU Babylon", "Babylon Sync", "Babylon Render" rows (:40-54, :134, :182-193) |
| `src/renderer/utils/performanceMonitor.ts` | 321 | `babylonSync`, `babylonRender`, `gpuBabylonMs` metrics |
| `CesiumViewer.tsx:808-899, 960-1020` | | Babylon GPU timer, memory counter warning (audit B3: counters are hardcoded zeros) |
Docs/skills that mention the handle: `CLAUDE.md` ("E2E testing" section), `docs/DRIVING_CONVENTIONS.md:110-126, 222-246`, `.claude/skills/towercab-3d-nextup/SKILL.md`, `.claude/skills/prepare-release/SKILL.md`.
Replaces it: `readPixels` repoints at the Cesium canvas or is deleted, since rain and clouds become part of the Cesium frame and show in screenshots (open decision below); TC3D-55 (`perf()` on the harness) is the measurement base.

## 1i. Babylon-only settings and config
- `types/settings.ts:742-743` `showBabylonFog` (default `:1967`); `settingsStore.ts:695` (migration repair copy; store `version: 38` at :446); `SettingsGraphicsWeatherTab.tsx:89, 860-863, 904, 921` (the checkbox, and it disables the intensity/scale sliders); `SettingsTreeBuilder.ts:113` (`fog` group lists it).
- Babylon-semantics settings that survive with new meaning: `cloudOpacity` (:748, "cloud plane opacity", plane meshes only), `fogIntensity` (:755, dome opacity multiplier), `visibilityScale` (:761, dome radius; also read by `useAircraftFiltering.ts:263`), `showClouds`, `showPrecipitation`, `precipitationIntensity`, `showLightning`, `showWeatherEffects`, `showCesiumFog` (also gates label culling), `enableWeatherInterpolation`. `aircraft.datablockFontSize` is read by `useBabylonOverlay.ts:185`.
- `package.json:71-73` `@babylonjs/core`, `gui`, `loaders` (^9.28.0); no `@babylonjs/addons` yet (TC3D-61 would add it).
- `vite.config.ts:90-95` (`optimizeDeps.exclude: ['@babylonjs/core']`), `:127-133` (`babylon` manual chunk; audit D1 baseline 8,108 kB / 1,791 kB gzip), `.github/dependabot.yml:12-14` (`babylonjs` group).
- Asset: `src/renderer/public/cab-environment.env` and `CREDITS.md:5-11`.
- Docs naming Babylon: `docs/architecture.md` (Babylon hook section :723-808 plus overview, flows, hook order, component tree), `docs/coordinate-systems.md` (13 mentions), `docs/inset-architecture.md:7,158,390`, `docs/msfs-model-conversion.md` (3), `README.md:299,460`, `USER_GUIDE.md` (15 incl. VR), `CLAUDE.md` (Quick reference, Modifying Aircraft Rendering/Camera/Weather, harness), `scripts/shipping/conversion/convert_fsltl_batch.py` (1, not read).

# 2. Milestones for "Babylon to Cesium migration"

Rules assumed: two main slots plus one rotating (TC3D-62 priorities).

Where a hotspot is named, it is a file that other open projects also edit: `CesiumViewer.tsx` (TC3D-9, TC3D-12, TC3D-13 and this), `useBabylonOverlay.ts` (only this and the Babylon projects), `useCesiumLabels.ts` (TC3D-31, TC3D-105, on-plane TC3D-97).

Also `types/settings.ts` + `settingsStore.ts` + `SettingsGraphicsWeatherTab.tsx` + `SettingsTreeBuilder.ts` (Settings drawer, branch `feat/settings-drawer`), `useAgentHarness.ts`/`types/harness.ts` (TC3D-92, TC3D-55), `ControlsBar.tsx`/`App.tsx` (VR button; drawer).

Hard ordering fact: moving the cab to Cesium before Babylon clouds are gone undoes the reason for commit 05d0611 (Babylon weather paints over a Cesium cab). So cab and weather are one shippable stage (M2), not two.

## M0 Groundwork (main, no branch)
BRANCH: no (each issue is one-site or additive; nothing changes what the user sees).
- Land Cesium 1.145 (TC3D-9, project "Cesium 1.145 and shadow darkness", `feat/cesium-1.145`) before M2: audit A1 says 1.144 fixes a one-frame black flash from the stale framebuffer cache "post-process stages + shadow maps trigger it" and a post-process crash on large selected-feature lists. Dependency, not a new issue.
- "Expose frame timings on the harness and fix the GPU timer" (TC3D-55 widened): `useAgentHarness.ts`, `types/harness.ts`, `performanceMonitor.ts`. Proving check: `__tc3d.perf()` returns median and p95 over 300 frames; GPU ms nonzero on the owner's desktop (spike: timer read 0 on this backend, GPU cost unmeasured, iPad unmeasured). Gate for M2's exit.
- "Extract label weather culling into one pure module" (imperative: *Move `isVisibleByWeather` and the `useAircraftFiltering` copy into one weather-visibility function*): `isVisibleByWeather` (now `useBabylonOverlay.ts:258-272`), `useAircraftFiltering.ts:382-395`, new `utils/weatherVisibility.ts`. Proving: unit test under `tests/`; app check that labels cull the same as before. Hotspot: none. Unblocks M2 and M4 to run in parallel and absorbs TC3D-137.
Parallel with: M1 (VR). Hotspots: none (harness only overlaps TC3D-92).

## M1 Remove VR (main)
BRANCH: no. Evidence: self-contained, the only shared files are the two mount sites (`App.tsx:30,92-93,618`, `ControlsBar.tsx:15,791`), no settings, no tests, and it deletes one of 16 Babylon importers; the owner already ruled VR dropped.
Issues:
- Remove the VR mode (`components/VR/*`, `stores/vrStore.ts`, `hooks/useCesiumStereo.ts`, `ControlsBar.tsx` button, `App.tsx` mount; fold audit G3's VR half from TC3D-13: unused `cesiumFrustumPatch.ts` exports). Proving: `pnpm run check` green; app check: no VR button, Cesium renders, `rg "vrStore|useCesiumStereo|webxr"` empty.
- Remove VR from user docs (`README.md:112-113`, `USER_GUIDE.md` section and TOC, CHANGELOG "Removed" bullet since users saw an experimental VR button).
Hotspots: `ControlsBar.tsx` (drawer project edits `ControlsBar.css` and the modal opener; low overlap), `App.tsx`. Depends on: nothing. Parallel: yes with M0, M2, M3, M4.

## M2 Cab, clouds and fog in Cesium (feature branch)
BRANCH: `feat/cesium-weather` (owner ruling, 2026-10-21), for four reasons. (a) The spike look is "first draft" and the owner judges it against today's clouds before it replaces them (spike report, TC3D-62 exit criterion). (b) The spike ran only behind a `spikeWeatherStore.enabled` switch, so landing it item by item on main means dead code or two weather systems for weeks.

(c) It touches `CesiumViewer.tsx`, `useBabylonOverlay.ts` and `useBabylonWeather.ts` in one stage and the cab/weather coupling above makes any half-landed state wrong, (d) the settings semantics change (see M6) and the stage cost on iPad is unmeasured.

Draft PR opens at first landing per the repo convention.
Issues (order):
1. Port the spike's stage into production: `useCesiumWeather.ts` (or a new `useCesiumWeatherStages.ts`), `hooks/weather/cloudStage.glsl.ts` (from `spikeWeatherShaders.ts`), reads `weatherStore` + settings instead of `spikeWeatherStore`; mounts once, main viewport and insets decided (open decision).

   Proving: `__tc3d` camera poses of the spike's five cases (BKN025 10SM from the cab; OVC008 1/2SM; OVC015 from 5000 ft with an aircraft at 3000/1000 ft; BKN012 toward hills) match the spike's occlusion results; frame cost via `perf()`.
2. Curve the deck with the earth, widen to ~100 km, add top relief; fold TC3D-125 (clear-sky band under OVC; dense-fog colour). Proving: EGLL case from TC3D-125 (camera ~80 m, heading 274, pitch -3, FOV 45; BKN900 + OVC2000; `fogDensity` 0.0083) shows grey horizon and grey haze. Done (TC3D-125) for the deck and the fog colour: the deck reaches 100 km and drops with the earth (`utils/cloudDeckGeometry.ts`), undersides use the fog grey, and the render check shows no band at 10 SM and one grey for deck and fog at 5.96 SM. Tops are still flat, so top relief stays open here.
3. Fog in the composite replacing `scene.fog` tuning; map `fogIntensity` and `visibilityScale`; hide Cesium sky/sun/moon hack (`src/renderer/components/CesiumViewer/CesiumViewer.tsx` ~:322-346, a plain `skyBox.show` assignment that hides sky box, sun and moon under an OVC layer) only if overcast pixels now cover the sky.
4. Restore the cab as a Cesium model: bring back `useTowerModel.ts` from the spike, delete `useBabylonTowerModel.ts`; light it with Cesium (fold the "cab stays lit at night" half of TC3D-126); resolve TC3D-138's axis convention in this step (one Cesium convention for aircraft and cab, no +90 degrees special case). Proving: KOAK mod loaded, wizard live edit still moves the cab, cab hides clouds and is hidden by aircraft/terrain correctly, shadow on the tarmac.
5. Night: already done by the weather stage, which dims cloud and fog by sun elevation itself (`daylight()` in `hooks/weather/cloudStage.glsl.ts`); `useBabylonNightLighting` never touched cloud or fog colours. Its deletion, with the dead `BABYLON_NIGHT_*` constants, goes with TC3D-149; one sun curve for every layer (the stage, the imagery, the cab) is TC3D-185's design.
6. Quality presets and resolution: spike knobs (`steps`, `densityScale`, `radius`, `resolutionScale`, `fogExtinction`, `fogHeightScale`) become presets; ties to TC3D-12 C2 (`viewer.resolutionScale`).
7. Delete Babylon fog dome and cloud meshes and `hooks/weather/*` (this empties `useBabylonWeather.ts` apart from `isVisibleByWeather`, which M0 already moved) and recentering in `useBabylonCameraSync.ts`. Done (TC3D-149): `hooks/weather/cloudStage.glsl.ts` stays, `isVisibleByWeather` lives in `useBabylonOverlay.ts`, `useBabylonNightLighting.ts` and `BABYLON_NIGHT_*` went with it, and with the logarithmic depth buffer off the Cesium stage stays hidden (no clouds or METAR fog, only the globe's distance fog).
8. iPad exit measurement (remote browser) at FEW/BKN/OVC and 1/4, 3, 10 SM; owner look sign-off.
Hotspots: `CesiumViewer.tsx`, `useBabylonOverlay.ts`, `useBabylonCameraSync.ts`, `useCesiumWeather.ts`, `weatherStore.ts`; settings files only if a semantic changes (defer the key changes to M6).
Depends on: M0 (1.145, perf harness, culling module). TC3D-141 (re-shoot "before" images) should land before the sign-off. Parallel with: M1 and M4, not with M3.

## M3 Rain, snow and lightning in Cesium (main after M2 lands)
BRANCH: no. Evidence: one new hook and one deletion (`useBabylonPrecipitation.ts` + `constants/precipitation.ts`), no hotspot. It needs M2's stage plumbing, so it starts after M2 has merged (or stacks on `feat/cesium-weather` if the owner wants it earlier).
Issues:
- Draw rain and snow as a depth-aware stage or GPU-animated instanced primitive (spike first, 1-2 days: rain cost, tile/building occlusion, cab interior free of rain). Proving: rain hidden behind a building and not inside the cab; `rg` pixel read or screenshot now shows rain (screenshots work, since rain is in the Cesium frame); `perf()` delta.
- Lightning flash as a post-process uniform or full-screen flash that does not need Babylon.
- Delete `useBabylonPrecipitation.ts`, `constants/precipitation.ts` (keep the numbers in the new hook), remove `flare.png` CDN fetch (audit B4 disappears).
Hotspots: none besides mounting in `CesiumViewer.tsx`. Depends on: M2 stage plumbing (ENU frame, shared weather uniforms, wind). Parallel with: M4 (different files).

## M4 Labels and leader lines on a 2D layer (main)
BRANCH: no. Evidence: independent of the weather stages, `useCesiumLabels` already owns projection and layout and only talks to the overlay through a 6-function adapter (`useBabylonOverlay.ts:244-275`, `useCesiumLabels.ts:63-70`), so the layer swaps behind that adapter and each step leaves the app working; visible regression risk is bounded by a toggle back to Babylon labels until M6.
Issues:
- Add a 2D label layer behind the existing adapter (DOM or canvas per open decision), including DPR handling, the datablock font size, followed highlight, outline for legibility (carries audit D3), and label bounds into `datablockPositionStore`. Proving: app check at a busy field (labels, leader lines, overlap layout, follow highlight, click-to-slew via `findLabelAtPosition` at `CesiumViewer.tsx:1145`, inset iframes); `readPixels`-free check by screenshot.
- Replace `isDatablockVisibleByWeather` with M0's module and fix TC3D-137 (one fog toggle gates culling, same formula as the shader). Fold TC3D-31 (inset width) since the layer needs the viewer's own size.
- Delete `useBabylonLabels.ts`, GUI texture from `useBabylonScene.ts`.
Hotspots: `useCesiumLabels.ts` (TC3D-31, TC3D-105, TC3D-97/98), `CesiumViewer.tsx`, `useBabylonOverlay.ts`, `datablockPositionStore.ts`. Depends on: M0 culling module only. Parallel with: M2 and M3 in a second worktree, but both edit `useBabylonOverlay.ts` and the Babylon section of `CesiumViewer.tsx` (:417-460, :800-900); rebase M2 on M4's merges, or land M4's adapter swap first (small).

## M5 Remove Babylon (main, after M1-M4)
BRANCH: no. Evidence: the milestone is deletion plus a settings migration, no new behaviour; it cannot land earlier than M1-M4 but then is mechanical. The only coordination is with `feat/settings-drawer`, see DEPENDS ON.
Issues:
- Delete `useBabylon*.ts` (overlay, scene, root node, camera sync, night lighting, sun direction), `types/babylon.ts`, `constants/babylon.ts`, `BABYLON_NIGHT_*` in `constants/lighting.ts:62-87`, Babylon half of `utils/enuTransforms.ts`, `babylon-overlay-canvas` CSS and canvas creation (`CesiumViewer.tsx:515-542`), `CesiumViewer.tsx` Babylon GPU timer and counters (:808-899, :960-1020), and the `babylon` rows in `PerformanceHUD.tsx` and `performanceMonitor.ts`.
- Remove deps and config: `package.json:71-73`, `vite.config.ts:90-95,127-133`, `.github/dependabot.yml:12-14`, `src/renderer/public/cab-environment.env` and `CREDITS.md:5-11`; re-measure `pnpm run vite:build` (baseline babylon chunk 8,108 kB / 1,791 kB gzip).
- Settings migration: remove `showBabylonFog`, decide `cloudOpacity`/`fogIntensity`/`visibilityScale` mapping (bump `settingsStore.ts` version 38 to 39; follow the "Adding a New Setting" migration rules in `CLAUDE.md`); update `SettingsGraphicsWeatherTab.tsx` (or the registry entries if TC3D-86 landed), `SettingsTreeBuilder.ts:113`.
- Harness: drop `__tc3d.babylon`, repoint or remove `readPixels` (`useAgentHarness.ts`, `types/harness.ts`), update `CLAUDE.md` and `docs/DRIVING_CONVENTIONS.md`.
Proving: `rg -i "babylon" src package.json vite.config.ts` returns nothing; `pnpm run check`; full app check; build size delta. Depends on: M1-M4 and the settings-drawer decisions.

## M6 Docs (main, last)
Rewrite the rendering sections of `docs/architecture.md` (lines :723-808 and all hook-order/flow mentions), `docs/coordinate-systems.md`, `docs/inset-architecture.md:7,158,390`, `docs/msfs-model-conversion.md`, `README.md:299,460`, `USER_GUIDE.md`, `CLAUDE.md` (Quick reference, Modifying sections, harness), `docs/DRIVING_CONVENTIONS.md`; add Task Index rows (TC3D-15/123): "change weather rendering", "change datablock labels". Replaces TC3D-14. Depends on M5.

Parallelism summary: wave 1 = M0 then {M2 on `feat/cesium-weather` || M4 on main} with M1 as the rotating third slot; wave 2 = M3 after M2; wave 3 = M5 then M6. M2 and M4 conflict on `useBabylonOverlay.ts`/`CesiumViewer.tsx`, so land M4's adapter swap early.

# 3. Verdict per open issue

| ID | Title | Verdict | Why |
|---|---|---|---|
| TC3D-10 | Babylon overlay fixes and dead hooks (B2-B4, G5-G7, G10) | cancel: superseded by migration (and cancel its project "Babylon overlay fixes and dead hooks") | Every item fixes a file deleted by M2-M5: B2 `syncCamera` twice (`useBabylonOverlay.ts:238`, `CesiumViewer.tsx:877`), B3 zero counters, B4 rain texture CDN (the file goes in M3), G5-G7 dead hook parts, G10 OVC branch of `useBabylonWeather`. B4 stays a user-visible offline-rain gap until M3; accepted by the assessment ("moot"). |
| TC3D-11 | Babylon quick wins (D1-D6) | cancel: superseded by migration | D1 tree-shaking, D2 GUI units, D4/D5 label update cost, D6 context-lost all target Babylon code. Carry D3 (text outline) into M4 as an acceptance line; D6 survives only as optional Cesium `renderError` handling, not worth an issue. |
| TC3D-12 | Render resolution slider and Cesium quick wins (C1-C6, D7) | keep but rewrite | C1-C6 are Cesium-only and stay; drop D7 (hardware scaling for the Babylon canvas) and its sentence "drives resolutionScale and Babylon hardware scaling". C2 `viewer.resolutionScale` should land with or before M2 step 6 because the cloud stage's `textureScale` and the slider interact; C1 silhouettes use a `PostProcessStageComposite`, so check stage order with the weather stages. Hotspots `CesiumViewer.tsx`, `useCesiumViewer.ts`. |
| TC3D-14 | Rendering docs H1-H6 | cancel: superseded by migration (fold H1 into M6) | H2-H5 describe Babylon hooks that M5 deletes; H6 documents the two-canvas depth split that M2 removes. H1 (measuring tool is Cesium `Entity`, not Babylon; `architecture.md:321,548`, `coordinate-systems.md:66`) is subsumed when M6 rewrites those sections. |
| TC3D-15 | Reshape docs/architecture.md to the entry-point template | keep but rewrite | Still wanted (no Task Index, no README), but reshape once after M5 or reshape now with a stub for rendering; its Task Index row "Babylon overlay DPR or label screen size" becomes "datablock labels" (2D layer files). It overlaps TC3D-123, TC3D-122, TC3D-16, TC3D-109 and TC3D-77; sequence them as one docs pass. |
| TC3D-125 | Overcast clear-sky band; dense fog dark teal | fold into milestone M2 (step 2) | The band was the flat 40 km cloud deck of the weather stage; the dark teal fog was not reproduced on the Cesium stage. Curving the deck and widening it to ~100 km fixed the band (done, M2 step 2; measured in the render check). Use the EGLL repro as the acceptance test. |
| TC3D-126 | KOAK mod: camera 220 m outside cab; cab lit at night | keep but rewrite (split) | Half 1 (manifest `cameraPosition` vs `modelPosition`, or `getCameraPositionFromManifest` / `airportStore.selectAirport` at `airportStore.ts:88-125`) is engine-independent: keep as a single. Half 2 (cab stays lit at night, `useBabylonTowerModel.ts`) folds into M2 step 4/5 (Cesium model lighting). |
| TC3D-137 | Label fog culling follows the Cesium fog toggle | fold into milestone M4 (via M0 module) | The issue says it folds into the single-engine work. With one fog, `showBabylonFog` disappears and the toggle question is moot; the shared pure function must also replace the `useAircraftFiltering.ts:390-410` copy. |
| TC3D-138 | MODDING.md axes | keep as is | Pure doc-vs-code question, engine-independent, but its trace is simpler after M2 step 4 (one Cesium convention, no +90 degrees Babylon path). Do it with or just before M2 step 4; related to TC3D-95 (body frame). |
| TC3D-60 | GPU particles for rain and snow (F1) | cancel: superseded by migration (replaced by M3) | F1 is `GPUParticleSystem` inside Babylon. Carry its findings into M3's brief: CPU cost spike first, GPU-only/no WebGL2 fallback decision (F1-a), wind as uniforms (F1-b), remote Safari/Chromium WebGL2 path, insets each run the effect. |
| TC3D-61 | MSDF datablock labels (F3) | cancel: superseded by migration (replaced by M4) | F3 uses `@babylonjs/addons`. Re-open only if the 2D layer's label cost measures badly at high DPR (the F3 measurement recipe applies to the new layer). |
| TC3D-57 | Spike: converted models keep nav/strobe meshes (E2-c) | keep as is | Inspects converted GLBs; "Babylon.js sandbox" is only a viewer suggestion. Feeds TC3D-58 (Cesium `CustomShader`), not Babylon. |
| TC3D-69 | Binoculars key | keep but rewrite | Open question "Babylon overlay mask or CSS vignette" collapses to CSS vignette or a Cesium post-process; the zoom is a temporary layer over `viewportStore`. No dependency. |
| TC3D-71 | Airport lighting | keep but rewrite | Drop the "vs Babylon instanced sprites" option; Cesium has no point/spot lights (assessment option A "costs"), so lights are emissive point primitives or billboards. Must be ordered before the M2 fog composite so lights attenuate in fog and read depth; depends on M2 and TC3D-59/70. |
| TC3D-72 | Replay clips | keep but rewrite | Video via `canvas.captureStream()` captures only the Cesium canvas after migration; a DOM label layer would be missed, a canvas label layer needs compositing. This feeds the label-layer decision. |
| TC3D-79 | Settings drawer shell | keep as is (edit one sentence) | "Check the Babylon label layer ... against the drawer" becomes "the label layer"; the drawer must stack above the 2D layer and not intercept labels' click-to-slew. Not blocked by the migration. |
| TC3D-141 | Re-shoot spike A's before images on v0.2.0-alpha | keep as is | Independent worktree at the tag; it gives the owner a fair "today" for M2's look sign-off, so finish before that sign-off. |

Other open issues that name a Babylon file or feature (from `.tmp/linear-list.json`; line refs are to that file):
- TC3D-62 (Design track, In Progress, :1382) and TC3D-135 (:1396): close when the project exists; TC3D-135's branch "will not be merged" so M2 ports it. TC3D-136 (three.js) stops: not in the JSON, cancel in Linear. TC3D-46 (VR rebuild) appears only in text (:174, :1392), not as an issue in the JSON: cancel and verify its state in Linear (unmeasured here).
- TC3D-55 (frame timings on `__tc3d`, :1368): folds into M0; its HUD references `babylonRender`.
- TC3D-59 (Cesium night lighting E3, :1312): keep; the design doc E3 step 5 "keep `useBabylonNightLighting` driven by the same curve" (`rendering-opportunities-design.md:145`) is obsolete; M2 step 5 and TC3D-59 should share the sun curve.
- TC3D-56, TC3D-58: Cesium-only; unaffected. TC3D-12 C1 lands before TC3D-56 (existing order).
- TC3D-70 (METAR-accurate visibility, :1438): depends on M2 (calibrate the post-process fog curve).
- TC3D-31 (`useCesiumLabels.ts:476` uses `window.innerWidth`, :711): fold into M4.
- TC3D-105 (dead `flightPhase` branch in `useCesiumLabels.ts:42-43`, :780): same file as M4; sequence after or do within M4.
- TC3D-86 (Weather settings category migration, :1004), TC3D-83 (Traffic & Labels), TC3D-93 (delete old tabs), TC3D-92 (`__tc3d.settings`, same harness file): drawer project, see DEPENDS ON.
- TC3D-97/98 (on-plane views hide the followed datablock via `useCesiumLabels.ts:253-255`; `on-plane-cameras.md:14-15` cites `useBabylonLabels.ts:344` and Babylon's camera sync from `positionWC/direction/up`): the doc lines go stale at M4/M5; no issue text change needed beyond the plan doc.
- TC3D-9 (Cesium 1.145, :304): prerequisite of M2 (see M0).
- TC3D-13 (Cesium-side dead code, G3 includes `useCesiumVRRotation`): G3's VR half folds into M1.
- TC3D-127 (remote browsers draw built-in models) and TC3D-129 are unrelated.

# 4. The two design docs

- `docs/plans/rendering-engine-audit.md` (117 lines): refresh, then archive. Survive: A1 (Cesium 1.145, keep in TC3D-9), all of C (C1-C6), E1, E2, E3 (Cesium), G1-G4, G8, G9 (Cesium-side dead code), H1 (as docs work in M6). Die with Babylon: A2, B2-B4, D1-D7, F1-F3, G5-G7, G10, H2-H6 (and B1/shadow darkness is Cesium and survives).

  Action: mark the Babylon rows "superseded by TC3D-62 migration" and keep the file as the live checklist for the surviving items until TC3D-9/12/13 land, then archive. MAIN.md is generated, so regenerating it from Linear after the cancels is enough.
- `docs/plans/rendering-opportunities-design.md` (331 lines): refresh. Survive: E1 (native gear), E2 (custom shaders; E2-c spike TC3D-57), E3 (Cesium lighting; delete step 5 about `useBabylonNightLighting`, :145, and the "Babylon lights dim in step" line :132), the S0 harness spike (TC3D-55), the terms (TC3D-16 glossary: spike, pool slot).

  Dead: F1 (GPU particles in Babylon) and F3 (MSDF in Babylon); F2 (overlay in VR) is moot. Add a pointer: F1's rain findings become the M3 brief, F3's label-cost recipe feeds M4. Better: create `docs/plans/babylon-to-cesium.md` (milestones above, stage design, open decisions) linked from the Linear project, and cut F1-F3 from the opportunities doc.
- `docs/plans/single-engine-assessment.md`: keep as the decision record; add the 2026-10-21 decision and an "Outcome" link, and note the spike's measured numbers.

# OPEN DECISIONS

1. 2D label layer technology: DOM elements (native hit-testing, CSS transforms, easy outline text; risk: 100+ moving nodes on iPad, missed by video capture TC3D-72) against one 2D `<canvas>` (single draw, DPR control, hit-testing via the existing `labelBounds` map, composited in recordings) against Cesium `LabelCollection` (depth-aware, but the assessment says labels need no depth and hides them badly).

   Neither docs nor code settle it; the existing `labelBounds` + `findLabelAtPosition` contract favours a canvas.
2. Babylon-semantics settings: drop or remap `showBabylonFog` (dropping merges into `showCesiumFog`; users who had Cesium fog off and Babylon on get different looks), `cloudOpacity` (plane opacity; remap to cloud density or drop), `fogIntensity`, `visibilityScale` (also drives label/panel culling). Migration at `settingsStore.ts` version 38, interplay with the registry. Not settled by docs.
3. Inset and remote-browser clients: the spike disabled the stage for insets (`isInset ? null : viewer`). Each inset is its own iframe viewer (`docs/inset-architecture.md:7`) already receiving `fogDensity`/`cloudLayers`/`visib` (`useInsetStoreSync.ts:116-126`).

   Do insets get the post-process (second stage cost) or reduced/no weather? iPad/remote browsers run Cesium in the browser: need the exit measurement, a quality preset per device, and the existing `DeviceOptimizationPrompt` to pick it. WebGL2 availability on older Safari decides whether rain has a fallback.
4. Rain and snow: depth-aware post-process (no geometry, cheap, but no parallax per drop) against GPU-animated instanced primitive (real streaks, depth test, more code). Needs the 1-2 day spike (assessment marks Cesium `ParticleSystem` slow as inferred, not measured).
5. Harness: delete `readPixels` or point it at the Cesium canvas (needs `preserveDrawingBuffer` or a read inside the render tick). Screenshots now capture rain, so the `CLAUDE.md` / `DRIVING_CONVENTIONS.md:124-126` justification disappears.
6. Cesium sky/sun/moon: keep the overcast hide hack or let the cloud composite cover them (TC3D-125).
7. Where the cab sits in the frame order relative to the composite and the silhouette stage (TC3D-12 C1 uses a `PostProcessStageComposite`); and shadows: Cesium shadow map for the cab (cab "no longer casts a shadow on the tarmac" today).
8. Whether to land M2 behind a settings switch on main instead of a feature branch (the spike's flag pattern); the BRANCH line argues for the branch because the flag leaves two weather systems alive.
9. Cost budget: spike measured only CPU draw time with another spike running (+9.7 ms half res); no GPU time on desktop, nothing on iPad. A go/no-go threshold is not set anywhere.
10. Cab IBL: the Babylon cab used an environment cubemap for PBR; Cesium models use the scene's `environmentMapManager`/sun lighting. Whether the interior needs a custom environment map is not settled (`cab-environment.env` deletion in M5 depends on it).

# DEPENDS ON

- Settings drawer (TC3D-76..94, `feat/settings-drawer`, all marked In Progress in the JSON): it edits `types/settings.ts`, `settingsStore.ts`, `SettingsGraphicsWeatherTab.tsx`, `SettingsTreeBuilder.ts`. TC3D-86 migrates the Weather category (fog/clouds/precipitation/lightning) to the registry and TC3D-93 deletes the old tabs.

  M5's settings removal and any semantic change in M2 step 3/6 must land after TC3D-86/93 merge, or be written as registry entries on that branch; the settings `version` bump will conflict otherwise. M0, M1, M3 and M4 do not need the drawer. TC3D-79 text needs the sentence update about the label layer; TC3D-92 and TC3D-55 both edit `useAgentHarness.ts`.
- Cesium 1.145 (TC3D-9, `feat/cesium-1.145`): prerequisite of M2 (post-process fixes), shares `CesiumViewer.tsx`, `useCesiumViewer.ts`, `useCesiumLighting.ts`.
- TC3D-12 (resolution slider, silhouettes): edits `CesiumViewer.tsx`, `useCesiumViewer.ts`; C2 interacts with M2 step 6.
- On-plane cameras (`feat/on-plane-cameras`, TC3D-95..99) and Cinematic camera (TC3D-100..104): they edit `useCesiumCamera.ts`, `useAircraftModels.ts`, `viewportStore.ts`, `useCesiumLabels.ts` (hide followed datablock, spotter shots) and insets.

  Camera sync for Babylon goes away with M5, so the on-plane plan's claim that Babylon picks up roll from `up` becomes irrelevant; the cinematic "UI hidden" mode (TC3D-104) must hide the 2D label layer too, so M4 must expose a show/hide hook for it. No code in this migration touches `useCesiumCamera.ts`.
- Aircraft motion project (`feat/aircraft-motion`): shares `useCesiumLabels.ts` only through phase labels (TC3D-65, TC3D-100); sequence M4 before the cinematic/phase label work or rebase.
- TC3D-59 (Cesium night lighting) and TC3D-126 (cab night lighting) share the sun-elevation curve with M2.
- TC3D-70 and TC3D-71 are blocked by M2.
- TC3D-141 should land before the M2 look review; TC3D-55 before the M2 exit.

# DOC DRIFT

- `docs/architecture.md:730-767` lists 5 Babylon sub-hooks; `useBabylonOverlay.ts:188-235` composes 7 (precipitation, tower model, shadow generator, IBL) plus `useBabylonNightLighting` and `useBabylonSunDirection` mounted in `CesiumViewer.tsx:434-443`. Doc side wrong; fix owner: M6 (it already tracks it as TC3D-14 H2, which this report proposes cancelling).
- `docs/architecture.md:733` "MSAA 4x": code `antialias: true` at `useBabylonOverlay.ts:190`. Doc side wrong; M6.
- `docs/architecture.md:321,548` and `docs/coordinate-systems.md:66`: Babylon renders the measuring tool; code is Cesium Entities (`MeasuringTool.tsx`). Doc wrong; M6 (H1).
- `docs/architecture.md:754` `useBabylonRootNode({ scene, cesiumViewer })`; code is `{ scene }` (`useBabylonOverlay.ts:215-217`). Doc wrong; M6.
- `docs/architecture.md:881,727` LOC counts (659, 265); code is 1205 and 320. Doc wrong; M6.
- `docs/architecture.md:612-631,674-701,887-892` settings tabs; stale (TC3D-77), owned by the drawer docs TC3D-94.
- `docs/architecture.md:499-509` (`datablockPositionStore` "Used by useBabylonLabels") and `:75-78,98-102` (weather flows) describe Babylon as the weather and label renderer; consistent with today's code but will be wrong after M2/M4.
- `CLAUDE.md` "Modifying Aircraft Rendering" item 3 and "Modifying Camera Behavior" item 3 point at `useBabylonOverlay.ts` for labels and camera sync: right today, wrong after M4/M5; owner CLAUDE.md.
- `docs/plans/single-engine-assessment.md:30` "16 files import Babylon (6,135 lines)": file count confirmed (16), line total not re-derived here.
- `docs/plans/rendering-opportunities-design.md:132,145` say `useBabylonNightLighting` stays in step with the E3 curve; obsolete under the ruling; owner is that design doc (see section 4).
- `CLAUDE.md` harness section says `readPixels` returns the Babylon canvas bytes; true today, false after M5.
- `docs/inset-architecture.md:7,158,390` ("Cesium/Babylon viewers", "Updates Babylon labels"); TC3D-17 already notes this doc's broadcast files are gone.
- The `towercab-3d-nextup` profile skill's project order and implementer ceiling need the update that TC3D-62's "Next session" lists (not read; unmeasured).

# TASK INDEX GAP

The answer took ~20 doc reads, ~25 searches and the `git show` of the spike branch beyond a Task Index row (there is no Task Index). Rows that should exist:
- "Change how weather is drawn (clouds, fog, rain)": `hooks/useBabylonWeather.ts` + `hooks/weather/*` + `useBabylonPrecipitation.ts` (today); `useCesiumWeather.ts`, the weather stage hooks (after M2); `stores/weatherStore.ts`, `useSmoothedWeather.ts`, `types/settings.ts` `WeatherSettings` (:735).
- "Change datablock labels or leader lines": `useCesiumLabels.ts` (layout, culling) -> `useBabylonOverlay.ts` adapter -> `useBabylonLabels.ts` -> `stores/datablockPositionStore.ts` -> `CesiumViewer.tsx:1145` (click hit-test).
- "Change the tower cab model": `hooks/useTowerModel.ts` -> `services/ModService.ts` (`getTowerPlacement`) -> `stores/towerPositioningStore.ts` -> `utils/modelOrientation.ts` -> `hooks/useAircraftModels.ts` -> `utils/nightBrightness.ts` -> `hooks/useCesiumLighting.ts` -> `MODDING.md` -> `stores/airportStore.ts` (camera default).
- "Add or change an `__tc3d` harness call": `useAgentHarness.ts`, `types/harness.ts`, `CLAUDE.md` harness list, `docs/DRIVING_CONVENTIONS.md` (TC3D-123 notes the harness is in no doc).

# MISSING ENTRY POINT

- No `docs/README.md` (TC3D-16, TC3D-123) and `docs/architecture.md` is lowercase with no Task Index and no glossary; terms used in a project sense with no entry: "fog dome", "cloud pool", "pool slot" (TC3D-16 lists it), "spike", "datablock" (TC3D-77 lists it), "inset", "overlay", "ENU root node".
- No `docs/agents/explore.md` overlay; this run relied on `CLAUDE.md` alone.
