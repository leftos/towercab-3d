# Single-engine rendering: assessment (TC3D-62)

Researched 2026-10-20 against CesiumJS 1.146, Babylon.js 9.31, three.js r186, 3DTilesRendererJS 0.5.3. The app pins Cesium ^1.140 and Babylon ^9.28. Facts marked *(inferred)* were reasoned, not read in a source; everything else cites code or a primary source.

## Answer in brief

- **Two engines on two canvases can never be depth-correct.** Every occlusion bug between weather, the cab and aircraft comes from that, and each fix moves the bug somewhere else.
- **Cesium alone can do it.** Its post-process stages get the scene's depth texture, and its translucent primitives depth-test against terrain, 3D Tiles and models. Clouds, fog and rain built that way are hidden by buildings, the cab and terrain.
- **Dropping Cesium does not mean losing ion data.** 3DTilesRendererJS streams Cesium World Terrain, ion imagery and Cesium OSM Buildings with the user's own ion token. So three.js is a real option, but it is a rewrite of every rendering line in the app.
- **Recommendation:** move everything Babylon draws into Cesium, starting with a spike that proves depth-aware clouds and fog look right and run on an iPad. three.js with takram's volumetric clouds is the fallback if that spike fails. Sharing one WebGL context between Babylon and Cesium, Babylon alone, and native engines are ruled out below.

## What the split costs today

The Babylon canvas is transparent, stacked over Cesium's at `z-index: 10`, and clears its own depth every frame (`components/CesiumViewer/CesiumViewer.tsx:515-542`, `hooks/useBabylonScene.ts:271-288`). Babylon never sees Cesium's depth, so a Babylon pixel always draws over a Cesium pixel, whatever their distances. Paths below are under `src/renderer/`.

| Workaround | Where | What is still wrong |
|---|---|---|
| Tower cab moved from Cesium into Babylon so clouds and fog depth-test against it | `hooks/useBabylonTowerModel.ts:1-25` | Aircraft draw over the cab; terrain and OSM buildings never hide it; it casts no shadow on the tarmac and Cesium shadows don't fall on it |
| Cloud tops kept semi-transparent so aircraft show through | `hooks/useBabylonWeather.ts:1207-1216` | Aircraft above or below a layer are washed out by a plane that is not between them and the camera |
| Labels hidden by arithmetic against cloud altitude and METAR visibility | `hooks/useBabylonWeather.ts:1370-1401` | Aircraft in a cloud gap lose their label; labels are never hidden by terrain or buildings |
| Cesium sky, sun and moon hidden when a layer is overcast | `CesiumViewer.tsx:318-343` | Below 95 % coverage the sky draws through the clouds; TC3D-125 (clear-sky band at the horizon) |
| Fog drawn twice, by Cesium `scene.fog` and a Babylon fog dome, with separate formulas | `hooks/useCesiumWeather.ts:59-88`, `useBabylonWeather.ts:864-926` | The two agree only by hand-tuning; TC3D-125 (dense fog renders dark teal) |
| Two lighting models, both derived from the sun elevation | `hooks/useBabylonNightLighting.ts`, `hooks/useCesiumNightDarkening.ts` | TC3D-126 (cab stays lit at night) |
| Rain, snow and lightning over everything | `hooks/useBabylonPrecipitation.ts:557-577` | Rain falls inside the cab and in front of buildings it should be behind |
| Camera copied from Cesium to Babylon in `postRender` | `CesiumViewer.tsx:862-893`, `hooks/useBabylonOverlay.ts:238-242` | Runs twice a frame (audit B2); clouds re-centred in 10 km steps (`hooks/useBabylonCameraSync.ts:15`) |
| Two canvases at different resolutions | `useBabylonScene.ts:271-276`, `hooks/useBabylonLabels.ts:383-418` | Labels scaled by device pixel ratio by hand; two MSAA settings |

Each inset is an iframe that builds both engines again (`docs/inset-architecture.md:7`).

**Size.** 16 files import Babylon (6,135 lines); 40 import Cesium (15,548 lines); 9 import both. Measured with `rg -l` and `wc -l` over `src/renderer`.

## Options

### A. Cesium only (recommended)

Re-home each Babylon feature:

| Feature | In Cesium | Depth-correct? |
|---|---|---|
| Tower cab | `Model`, as before commit 05d0611 | Yes, against aircraft, terrain and buildings |
| Cloud layers | A `PostProcessStage` that raymarches each METAR layer as a slab with noise and stops at the scene depth (`depthTexture` uniform, `Scene/PostProcessStage.js`). Cesium 1.130 added 3D textures and a "Volume Cloud" Sandcastle that is a starting point | Yes |
| Fog and visibility | A depth-based post-process, `exp(-distance / visibility)`, replacing both `scene.fog` tuning and the Babylon dome. This is also the base TC3D-70 (METAR-accurate visibility) needs | Yes, for everything that writes depth |
| Rain and snow | A depth-aware screen-space post-process, or a custom instanced primitive animated on the GPU. Cesium's own `ParticleSystem` is CPU-updated billboards, too slow for 50,000 particles *(inferred)* | Yes |
| Labels and leader lines | A plain 2D canvas or HTML overlay. Labels need no depth, and they are already projected by Cesium (`hooks/useCesiumLabels.ts:502, 536`); Babylon only draws the rectangles, text and lines | Not needed |
| Night lighting | Cesium's own lighting, already designed as E3 (TC3D-59) | n/a |

What it fixes: every row of the table above. The OVC sky hack, the second fog, the label arithmetic, the camera sync, the resolution split and the second lighting model all go.

What it costs:
- **No point or spot lights.** Cesium has only directional and sun lights (`Scene/` at 1.146). Airport lights (TC3D-71) would be emissive point primitives or billboards, which is how most sims draw distant lights anyway *(inferred)*.
- **No WebXR.** Cesium's `useWebVR` is a cardboard split screen (`Scene.js` 1520-1545). VR is already broken (TC3D-46) and its planned rebuild assumes Babylon. Under this option VR is either dropped, kept as a Babylon-only mode, or rebuilt by driving WebXR into Cesium's context by hand, which nobody has shown working *(inferred)*.
- **Cloud quality is unproven.** Cesium ships no weather clouds; the look depends on our shader. This is what the spike decides.
- **Babylon items in the plan become moot:** TC3D-10, TC3D-11, TC3D-60 (GPU rain in Babylon), TC3D-61 (MSDF labels in Babylon) and the VR design TC3D-46.

Migration size: the 6,135 Babylon lines are replaced, about 3,000 of them weather (`useBabylonWeather.ts` with `hooks/weather/*`, `useBabylonPrecipitation.ts`). The 15,548 Cesium lines stay.

### B. three.js + 3DTilesRendererJS + takram (fallback)

- **Data:** `CesiumIonAuthPlugin` (user's ion token), `QuantizedMeshPlugin` (Cesium World Terrain), `CesiumIonOverlay` (ion imagery, including the Bing and Google imagery ion proxies), and OSM Buildings as a plain 3D Tiles asset. Terrarium, terrain-RGB, Esri and MapTiler work without ion. `TileFlatteningPlugin` covers runway flattening. Source: the 3DTilesRendererJS README and `src/three/plugins/API.md` at 0.5.3.
- **Weather:** takram's `three-clouds` gives volumetric clouds, cloud shadows, haze and light shafts, and works with 3DTilesRendererJS. Its author measured 60 fps on an iPad Pro M4 at Medium and 30 fps on a first-generation iPad Pro at Low. WebGL only, mostly one author, no release since 2026-05-06. No rain or snow; ours would be ported.
- **Precision:** float32 at Earth radius jitters by about half a metre *(inferred)*; `ReorientationPlugin` re-centres the world on the airport, which suits a tower view.
- **What it costs:** every rendering line: the 15,548 Cesium lines (camera and input, 2,130 lines in `useCesiumCamera.ts` and `useCameraInput.ts`; the 1,387-line `FlatteningTerrainProvider.ts`; the aircraft model pool, gear animation and silhouettes; picking; the measuring tool; the sun and time model) and the 6,135 Babylon lines.
- **When to choose it:** if the Cesium cloud spike can't reach an acceptable look, or if the owner wants the best weather and accepts the rewrite.

### C. Babylon alone + 3DTilesRendererJS (not now)

3DTilesRendererJS has a Babylon build, and Babylon's docs recommend it (with `useLargeWorldRendering` for precision). It would keep the 6,135 Babylon lines. But its Babylon build has no terrain or imagery plugins (only `TilesFadePlugin` under `src/babylonjs/plugins`), uses box-based culling, and can't read `boundingRegion` volumes. Those would need porting before it can show terrain with satellite imagery, and the 15,548 Cesium lines are still replaced.

Worth a look again if the Babylon build catches up.

### D. Babylon drawing into Cesium's WebGL context (ruled out)

Possible only through private API: depth from `scene.context.uniformState.globeDepthTexture`, rescaled every frame by `uniformState.currentFrustum`, and logarithmic because `Scene.defaultLogDepthBuffer` is on. Babylon materials leak GL state into Cesium, and Cesium has no reset-state call (Cesium forum, "Integrate CesiumJS with other WebGL renderers into same canvas"). Any monthly Cesium release can break it. Babylon's own Cesium integration uses two canvases, as we do.

### E. Native engines (ruled out)

Cesium for Unreal or Unity would serve iPads only through Pixel Streaming: one GPU video encode per viewer on the host, added latency, and a rewrite of the whole app outside the web stack *(inferred)*.

## Proposed spike: depth-aware clouds and fog in Cesium

1. Put the tower cab back into Cesium as a `Model`.
2. Write one `PostProcessStage` that draws a METAR cloud layer (base, top, coverage) as a raymarched slab and a visibility fog, both stopping at the scene depth.
3. Check in the dev app at KOAK with the tower mod: the cab, aircraft, buildings and terrain hide the clouds and fog where they should, and aircraft in or behind a layer look right from the cab and from orbit.
4. Measure the stage's frame time on the owner's desktop and on an iPad, with the harness's GPU timers (`CesiumViewer.tsx:808-899`).

Exit: the owner judges the look against today's clouds, and the numbers say whether it fits an iPad. A pass makes option A the plan; a fail opens option B's spike (3DTilesRendererJS with ion terrain, imagery and OSM Buildings at KOAK, plus takram clouds).

## Decisions

- **Direction (owner):** spike options A and B in parallel, then compare: TC3D-135 (depth-aware clouds and fog drawn by Cesium) and TC3D-136 (tower view in three.js with ion data and takram clouds). Option B's spike is a standalone page with ion terrain, imagery and OSM Buildings at KOAK, the tower mod, a few aircraft and takram clouds, measured on the desktop and an iPad.
- **VR (owner):** if option A wins, VR is dropped and TC3D-46 is cancelled.
- **Babylon items already planned** (TC3D-10, TC3D-11, TC3D-46, TC3D-60, TC3D-61) wait for the spikes, since either winner makes them moot.

## Sources

- Codebase map: file and line references above, from the current tree.
- CesiumJS 1.146 source (`packages/engine/Source/Scene/CloudCollection.js`, `PostProcessStage.js`, `Fog.js`, `ParticleSystem.js`, `LabelCollection.js`, `Scene.js`) and CHANGES.md 1.114-1.146.
- Cesium forum: [same-canvas integration](https://community.cesium.com/t/integrate-cesiumjs-with-other-webgl-renderers-into-same-canvas/32080), [depth texture](https://community.cesium.com/t/how-to-get-depth-texture-properly/32282), [Babylon single context](https://community.cesium.com/t/accomplished-rendering-with-babylonjs-single-webgl-context/44464).
- [Babylon.js and CesiumJS](https://doc.babylonjs.com/communityExtensions/Babylon.js+ExternalLibraries/BabylonJS_and_CesiumJS); [Babylon 3D Tiles](https://doc.babylonjs.com/features/featuresDeepDive/geospatial/loading3dTiles/).
- [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) 0.5.3: README, `src/three/plugins/API.md`, `src/babylonjs/renderer/README.md`.
- [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial): atmosphere 0.19.1, clouds 0.7.6.
- [Google Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies); [Cesium ion pricing](https://cesium.com/platform/cesium-ion/pricing/).
