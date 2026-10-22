# Cesium cloud and fog stage: app captures

The spike's cases, driven in the dev desktop app at KOAK with `window.__tc3d`. Each case was shot twice. `-cesium.png` shows the Cesium post-process stage (`weatherStage.renderer = 'cesium'`, the branch default). `-babylon.png` shows the same weather and pose with the switch on `'babylon'` (Babylon fog dome and cloud meshes, stage out of the scene).

Weather was set with `stores.weather`: `setDebugOverriding(true)`, `setCloudLayers`, `currentMetar.visib` and a hand-computed `fogDensity`, then `triggerInstantUpdate()`. Time was fixed at 13:00 local (`cesium.timeMode = 'fixed'`). Tower camera at the KOAK tower, 75.9 m above the ground; FOV 60. The ENU anchor ground sampled at -28.49 m ellipsoid height. Heights below are above that ground (AGL) unless marked ellipsoid.

| Files | Weather | Pose | What it shows |
|---|---|---|---|
| `case1-bkn025-10sm-*` | BKN025, 10 SM | Tower camera, heading 300, pitch +6 | Broken deck at 2500 ft with blue gaps; terrain and San Francisco skyline unfogged. A light cyan clear-sky band shows between the deck edge and the horizon (the flat 40 km deck; TC3D-125's band). |
| `case2-ovc008-halfsm-*` | OVC008, 1/2 SM (`fogDensity` 0.0122) | Tower camera, heading 240, pitch -2; test B738 on the ground 400 m out, heading 150 | Grey fog: the aircraft at 400 m is visible but hazed, everything farther fades into fog colour; the overcast base is lost in the fog. |
| `case3a-ovc015-5000ft-acft3000-*` | OVC015, 10 SM | Camera override 3 km south of the tower at 5000 ft AGL, heading 0, pitch -11.5; B738 over the tower at 3000 ft AGL | The camera is above the deck, so the stage shows a white cloud top. The aircraft is hidden: at 3000 ft (914 m) it sits inside the OVC slab (base 457 m, 600 m thick, top 1057 m), not above it. |
| `case3c-ovc015-5000ft-acft4000-cesium.png` | OVC015, 10 SM | Camera override 1 km south at 5000 ft AGL, pitch -16; B738 over the tower at 4000 ft AGL (above the slab top) | Aircraft drawn on top of the cloud top: depth occlusion keeps an aircraft above the deck visible. Added because 3a's aircraft is inside the slab. |
| `case3b-ovc015-5000ft-acft1000-*` | OVC015, 10 SM | Camera override 3 km south at 5000 ft AGL, pitch -22.1; B738 over the tower at 1000 ft AGL | Cesium: the deck hides the airport and the aircraft below it. Babylon: the ground shows through a pale wash. |
| `case4-bkn012-hills-*` | BKN012, 10 SM | Tower camera, heading 55, pitch +4 (toward the Oakland hills) | Deck base at 1200 ft over the hills. From this pose the ridge stays below the base, so the hills-cut-the-base effect the spike saw is not visible here. |
| `inset-bkn025-10sm-cesium.png` | BKN025, 10 SM | Main tower camera heading 300 pitch +6, one inset opened with `addViewport()` | The inset iframe draws the same stage. Its `__tc3d.weatherStage.info()` returned `stageInScene: true`, `logDepth: true`, one frustum. |

## Review round 1 checks

| Files | Setup | What it shows |
|---|---|---|
| `reanchor-before.png`, `reanchor-after.png` | BKN025 10 SM. Camera override at the tower, 20 m ellipsoid height, heading 300, pitch 25. Between the shots the custom tower position moves 0.003° north (about 330 m), which re-anchors the deck within KOAK (log: `Anchored on airport:KOAK at 37.72246…`). | The cloud field stays in place across the re-anchor; only the slow wind drift moves it. The noise now follows a fixed world origin instead of the anchor. |
| `silhouette-fog400m-cesium.png`, `silhouette-clear400m-control.png` | Silhouettes on (viewer reloaded). Test B738 at 400 m, selected for edge detection, camera aimed with `lookAt` at FOV 30. Fog is OVC008 1/2 SM; the control is 10 SM with no clouds. | `info().stageNames` is `["czm_silhouette", "tc3dWeatherStage"]`: the weather stage runs after the silhouette stage, so the aircraft in fog is fogged with no outline drawn over it. The 0.5 px outline is faint even in the clear control. |
| `logdepth-off-babylon-fallback.png` | `enableLogDepth` off, viewer reloaded. BKN025 with 1 SM. | `info()`: `logDepth: false`, `stageInScene: false`; the Babylon `fog_dome` is visible, so Babylon draws the weather. The console shows the warning once. |

## Frame cost

`__tc3d.perf().window` was read after 9 s per shot, over 300 frames. Values are median / p95 in ms. "Stage off" is the Babylon switch, so `cesiumDraw` is Cesium without the stage. RTX 4090 desktop, 1600x900 CSS window. The app was otherwise idle, but the machine ran other builds through the gate.

| Case | cesiumDraw on | cesiumDraw off | frameInterval on | frameInterval off |
|---|---|---|---|---|
| 1 BKN025 10SM | 16.6 / 19.4 | 16.8 / 19.5 | 20.9 / 24.5 | 21.3 / 25.0 |
| 2 OVC008 1/2SM | 9.6 / 10.9 | 9.6 / 11.7 | 16.6 / 18.6 | 16.6 / 19.3 |
| 3a OVC015 5000 ft, acft 3000 ft | 19.6 / 22.9 | 18.2 / 21.4 | 24.1 / 28.3 | 22.5 / 26.5 |
| 3b OVC015 5000 ft, acft 1000 ft | 17.4 / 20.1 | 16.9 / 18.8 | 22.1 / 27.3 | 21.3 / 24.3 |
| 4 BKN012 hills | 18.0 / 20.8 | 18.2 / 21.2 | 22.3 / 26.1 | 22.9 / 26.8 |

The stage adds at most 1.4 ms median CPU `cesiumDraw` in these runs, against the spike's +9.7 ms at half resolution. `cesiumDraw` is CPU time; the GPU cost of the raymarch is not in it, and `gpuCesiumMs` was not read.
