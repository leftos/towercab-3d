# Weather rendering prior art (TC3D-318)

Sources checked: 41 URLs opened on 2026-10-26; 9 claims corrected (1 URL given a readable copy beside it), 4 URLs replaced with live copies, 1 citation cut (the lightning midpoint-displacement claim, now stated as unsourced practice).

Research note, 2026-10-26. Survey of open-source and published techniques for precipitation, fog and haze, volumetric clouds and lightning, judged for TowerCab 3D: CesiumJS 1.146, WebGL2, desktop GPUs and iPads in Safari, weather from METAR.

Repo figures (licence, last push, stars) were read from the GitHub API on 2026-10-26 (`gh api repos/<owner>/<repo>`). Stars are a rough maintenance signal only.

## Where we stand

- Clouds and fog: a homebrew Cesium post-process "cloud stage" raymarching noise slabs per METAR layer, depth-aware, with quality presets.
- Rain and snow: a Babylon.js particle overlay, being moved into Cesium.
- Lightning: a screen flash.

Cesium's own tooling for this is thin: its global cloud rendering roadmap issue (billboards, then raymarched volumes, then real weather data) has been open since 2017 with no shipped volumetric work ([CesiumGS/cesium#5962](https://github.com/CesiumGS/cesium/issues/5962)).

`Cesium.CloudCollection` draws procedural cumulus billboards only ([API docs](https://cesium.com/learn/cesiumjs/ref-doc/CloudCollection.html)). Cesium's built-in `scene.fog` is a camera-height density fade for culling distant tiles, not a visibility model ([Fog docs](https://cesium.com/learn/cesiumjs/ref-doc/Fog.html)).

## 1. Rain and snow

### Cesium particle-system weather Sandcastle

- What: the official "Particle System Weather" Sandcastle uses `Cesium.ParticleSystem` billboards around the camera for rain and snow, plus `scene.fog.density`/`minimumBrightness` and `skyAtmosphere` hue, saturation and brightness shifts (read from its source, `packages/sandcastle/gallery/particle-system-weather/main.js`) ([Sandcastle](https://sandcastle.cesium.com/?id=particle-system-weather)).
- Licence/engine: Apache-2.0, CesiumJS ([CesiumGS/cesium](https://github.com/CesiumGS/cesium), pushed 2026-10-26, 15.9k stars).
- Fit: native, depth-tested by Cesium. Known weakness: particles are CPU-updated billboards in world space, so they pop, thin out or disappear as the camera moves, which a Chinese write-up gives as its reason to switch to a shader ([aayu.today](https://blog.aayu.today/gis/cesium/learning-notes/20201030-1/)).
- Tablet cost: not measured by anyone found; CPU-updated billboards scale badly past a few thousand particles.
- Reuse: technique only (camera-anchored emitter); not good enough for a tower view where rain sits metres from the lens.

### Full-screen shader precipitation as a Cesium PostProcessStage

- What: a full-screen fragment shader (Shadertoy-derived, e.g. by Catzpaw) drawing procedural rain streaks or snow flakes, added as a `PostProcessStage` ([aayu.today](https://blog.aayu.today/gis/cesium/learning-notes/20201030-1/)).

  A refinement raymarches SDF rain so streak direction follows camera pitch, and adds a rain-ripple water surface ([Cesium forum, "Raindrop effect in CesiumJS"](https://community.cesium.com/t/raindrop-effect-in-cesiumjs/28849); code at [HapDragon/demos](https://github.com/HapDragon/demos), no licence file per GitHub API, last push 2024-02-01, 3 stars).

  An older CIS 565 project did snowfall as a ray-marched post-process stage (after a Shadertoy) plus a slope-based snow-accumulation globe material ([HuYuxin/CIS565FinalProjectCesiumSnow](https://github.com/HuYuxin/CIS565FinalProjectCesiumSnow/blob/master/CIS565FinalProjectREADME.md); Apache-2.0, last push 2018, 18 stars).
- Fit: runs in Cesium today as `PostProcessStage`; can read `depthTexture` to stop streaks behind buildings and aircraft. Cost is one full-screen pass, cheap on tablets.
- Weakness: no true parallax unless layered at several depths; Shadertoy code is often unlicensed (CC BY-NC-SA default), so reuse the technique, not the code.
- Reuse: technique; this is a fallback "low" tier.

### Layered camera-relative rain (Tatarchuk / NVIDIA rain)

- What: Tatarchuk's ATI "Toy Shop" system draws rainfall as an image-space effect that "simulates multiple layers of falling raindrops in a single compositing pass over the rendered scene", lit by an engine-driven lightning system, plus splashes, puddles, droplets on glass, mist and wet reflections.

  It cites the older approach of hand-drawn rain textures "mapped on a double-cone which is dynamically aligned to match the camera orientation" (Wang & Wade 2004) as related work ([Tatarchuk, "Artist-Directable Real-Time Rain Rendering in City Environments", SIGGRAPH 2006 course](https://advances.realtimerendering.com/s2006/Tatarchuk-Rain.pdf)).
- NVIDIA's DX10 sample states that rain "is traditionally rendered in one of two ways; either as a particle system or as camera-centered geometry with scrolling textures".

  It takes the particle route on the GPU: Stream Out animation, Geometry Shader billboards, and a texture array of precomputed drop appearance under varying viewpoint and light direction, after Garg & Nayar 2006 ([Tariq, "Rain", NVIDIA whitepaper 2007](https://developer.download.nvidia.com/whitepapers/2007/SDK10/RainSDKWhitePaper.pdf)).
- Fit: engine-agnostic. In Cesium as a custom primitive (`Primitive` with `Appearance` and our own shader) drawn in the translucent pass, camera-anchored in ENU; depth test against the scene comes for free.
- Tablet cost: a few hundred to a few thousand quads, cheap; no published tablet measurement.
- Reuse: technique. This is the best fit for the tower view (close range, static camera, need for parallax).

### GPU particles: Babylon.js GPUParticleSystem and three.js

- What: Babylon's `GPUParticleSystem` simulates particles with transform feedback on WebGL2 ([Babylon docs](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/gpu_particles); [BabylonJS/Babylon.js](https://github.com/BabylonJS/Babylon.js), Apache-2.0, pushed 2026-10-26, 26.2k stars).

  three.js has no rain package. Its official examples include `webgpu_compute_particles_rain` and `webgpu_compute_particles_snow`, which use WebGPU compute rather than WebGL2. They are listed in the examples index `files.json` ([three.js examples](https://threejs.org/examples/); [mrdoob/three.js](https://github.com/mrdoob/three.js), MIT, pushed 2026-10-26, 117.0k stars).

  The instanced-quad wraparound box is common practice; no single source for it was opened.
- Fit: Babylon is what we are moving off; the wraparound-box technique ports directly to a Cesium custom primitive with an instanced vertex shader (position = `mod(seed + wind*t, box) - box/2` around the camera), needing no simulation state at all.
- Reuse: technique.

### Lens and windshield effects

- What: Codrops "Rain & Water Effect" draws droplets on glass with refraction via WebGL ([codrops/RainEffect](https://github.com/codrops/RainEffect); no licence file per GitHub API, last push 2022, 1.8k stars).
- Fit: overlay canvas or post-process. Tower glass droplets would be a strong cue for a cab view.
- Reuse: technique only (no licence).

### Density from METAR

No surveyed library maps METAR intensity to particle density. The physical basis is the Marshall-Palmer drop-size distribution.

The paper gives N_D = N_0·e^(-ΛD) with "N_0 = 0.08 cm⁻⁴ for any intensity of rainfall, and Λ = 41 R^-0.21 cm⁻¹, where R is the rate of rainfall in mm hr⁻¹". That is N0 = 8000 m⁻³mm⁻¹ and Λ = 4.1·R^-0.21 mm⁻¹ in SI-style units, and the paper notes observations fall short of the curve below about 1.5 mm ([Marshall & Palmer 1948, J. Meteorology 5, 165–166](https://journals.ametsoc.org/view/journals/atsc/5/4/1520-0469_1948_005_0165_tdorws_2_0_co_2.xml)).

The AMS page refuses scripted fetches, so the text was read from the reproduction at [radartutorial.eu](https://www.radartutorial.eu/15.weather/pubs/marshall-palmer-1948.pdf)).

With -RA/RA/+RA mapped to roughly 1/4/12 mm/h, number density and the visibility it implies can be derived instead of hand-tuned.

## 2. Fog and haze

### Visibility to extinction (Koschmieder)

- WMO defines meteorological optical range (MOR) as the path that reduces a collimated beam "to 5 per cent of its original value", and with T = e^(-σx) derives "P = (1/σ) · ln (1/0.05) ≈ 3/σ" (eq. 9.6).

  It records that Koschmieder proposed a contrast threshold of 0.02 in 1924, while aviation takes 0.05; the 2% threshold gives V = ln(50)/σ = 3.912/σ ([WMO-No. 8, Guide to Meteorological Instruments and Methods of Observation, 7th ed. 2008, Part I ch. 9](https://www.weather.gov/media/epz/mesonet/CWOP-WMO8.pdf), copy hosted by NWS).

  METAR visibility in SM converts to metres (×1609.34) and then to β, so transmittance at distance d is exp(-β·d). This is the one formula our fog must honour; it is engine-agnostic and needs only scene depth.

### Exponential height fog (Unreal, Frostbite)

- What: fog density ρ(h)=ρ0·exp(-falloff·(h-h0)), integrated analytically along the view ray, so cost is one pass ([Wenzel, "Real-time Atmospheric Effects in Games Revisited", GDC 2007](https://www.gamedevs.org/uploads/real-time-atmospheric-effects-in-games-revisited.pdf)).

  Wenzel's "Global Volumetric Fog" shader ends in `fogInt *= (1.0 - exp(-t)) / t; return exp(-cGlobalDensity * fogInt);` ([Unreal Exponential Height Fog docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/exponential-height-fog-in-unreal-engine)).

  Frostbite adds froxel volumetric fog for lit, heterogeneous media, citing Wenzel's analytic fog as prior work ([Hillaire, "Physically Based and Unified Volumetric Rendering in Frostbite", SIGGRAPH 2015 slides](https://www.slideshare.net/slideshow/physically-based-and-unified-volumetric-rendering-in-frostbite/51840934)).
- Fit: analytic height fog is a few lines in a Cesium `PostProcessStage` reading depth; tablet cost negligible. A commercial Cesium-based engine advertises "dual-layer exponential height fog" with colour from atmospheric scattering, plus an aerial-perspective LUT and Perlin-Worley clouds with temporal reprojection ([Wings Engine Cesium](https://www.wingsengine.com/cesium), closed source).
- Reuse: technique; combine with Koschmieder so ground-level β matches METAR visibility and falloff covers the layer under a ceiling.

### Aerial perspective and sky: Bruneton and Hillaire

- Bruneton precomputed atmospheric scattering: LUTs for transmittance, scattering and irradiance, giving sky colour and aerial perspective for any view ([ebruneton/precomputed_atmospheric_scattering](https://github.com/ebruneton/precomputed_atmospheric_scattering); BSD-3-Clause, pushed 2025-10-05, 1.1k stars; has a WebGL2 demo).
- Hillaire 2020: cheaper LUT set (transmittance, multi-scattering, sky-view, aerial-perspective froxel volume) designed for runtime parameter changes and mobile ([Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf); [sebh/UnrealEngineSkyAtmosphere](https://github.com/sebh/UnrealEngineSkyAtmosphere), MIT, last push 2022, 864 stars).

  The paper states the technique "scales from power-efficient mobile platforms up to PCs" and compares an iPhone 6s against an NVIDIA 1080.
- @takram/three-atmosphere implements Bruneton for three.js with aerial perspective as a post-process ([three-geospatial](https://github.com/takram-design-engineering/three-geospatial); MIT, pushed 2026-05-27, 1.8k stars).
- Fit: Cesium already has its own sky atmosphere and ground atmosphere ([SkyAtmosphere](https://cesium.com/learn/cesiumjs/ref-doc/SkyAtmosphere.html), [Atmosphere](https://cesium.com/learn/cesiumjs/ref-doc/Atmosphere.html)); replacing it is a large job for a tower view whose horizon is a few km away. Haze/fog matter far more than accurate Rayleigh at this scale.

## 3. Volumetric clouds and lightning

### Nubis (Horizon Zero Dawn, Decima) and successors

- What: raymarched clouds from a 2D weather map (coverage, type, precipitation per texel), Perlin-Worley 3D shape noise plus Worley detail, and height gradients per cloud type (stratus, stratocumulus, cumulus).

  Lighting is Beer-Powder with a Henyey-Greenstein phase, and temporal reprojection rendering 1/16 of pixels per frame ([Schneider & Vos, "The Real-Time Volumetric Cloudscapes of Horizon Zero Dawn", SIGGRAPH 2015](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf)).

  The 2015 notes say they "update 1 out of 16 pixels for each 4x4 pixel block" and reproject the previous frame. Follow-ups: ([Schneider, "Nubis: Authoring Real-Time Volumetric Cloudscapes with the Decima Engine", SIGGRAPH 2017 course page](https://advances.realtimerendering.com/s2017/index.html); [Schneider, "Nubis 3: Methods (and madness) to model and render immersive real-time voxel-based clouds", SIGGRAPH 2023 course page](https://advances.realtimerendering.com/s2023/index.html)).
- Relevance: the "cloud type → height gradient + coverage" model maps directly onto METAR: each FEW/SCT/BKN/OVC layer becomes coverage ≈ 1/8–2/8, 3/8–4/8, 5/8–7/8, 8/8 at its base, with type (CB, TCU, stratus under low ceilings) choosing the gradient.
- Reuse: technique; it is the reference our homebrew should be compared with.

### Frostbite and Unreal volumetric clouds

- Frostbite: physically based cloud lighting with energy-conserving analytical integration (section 5.6.3) and the multiple-scattering approximation of Wrenninge et al., which "integrate[s] multiple octave[s] of scattering and sum[s] them" (section 5.8) ([Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite", SIGGRAPH 2016 course](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf)).

  Unreal's Volumetric Cloud component has a layer height parameter and sample-count and shadow-resolution scale settings for quality scalability ([Unreal Volumetric Cloud docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-cloud-component-properties-in-unreal-engine)).
- Reuse: the energy-conserving integration step and multi-scattering octaves are drop-in shader math for our raymarcher.

### @takram/three-clouds (three-geospatial)

- What: geospatial volumetric clouds for three.js/R3F: up to four layers (all layers' coverage packed into one texture and computed as a `vec4`) each with `altitude`, `height`, `densityScale`, `shapeAmount` and `coverageFilterWidth`; weather texture; Beer shadow maps casting on scene objects; temporal upscaling; light shafts; haze; four quality presets (Low, Medium, High, Ultra).

  The README lists its own limits: temporal upscaling "prone to ghosting and smearing", and cloud bases of a layer lining up at one altitude ([packages/clouds README](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds)). MIT, pushed 2026-05-27, 1.8k stars.
- Measured cost (author, v0.0.1, Tokyo scene, temporal upscaling on): iPad Pro 1st gen 30-32 fps at Low, 2388×1520; iPad Pro M4 60 fps at Medium and 43-55 at High; iPhone 13 36-53 fps at Low; without temporal upscaling an M3 Max drops from 92-95 to 31 fps at High, 4K (same README, "Performance tweaks"; the author notes these were "relatively new devices as of this writing"). This is the only tablet measurement found for any web volumetric cloud renderer.
- Fit: its per-layer `CloudLayer` API (altitude, height, coverage) is close to a METAR layer list. It is three.js, but has already been ported to pure Cesium (below).
- Reuse: shader code (MIT) and the temporal-upscaling design.

### cesium-clouds-atmosphere (Cesium port of three-geospatial)

- What: a port of three-geospatial's clouds and Bruneton atmosphere to Cesium 1.132: clouds raymarched in a `PostProcessStage`, sky and aerial perspective as further stages, Beer shadow map cascades and TAA in raw WebGL hooked to `preRender`/`postRender` ([yuwoniu03/cesium-clouds-atmosphere](https://github.com/yuwoniu03/cesium-clouds-atmosphere); pushed 2026-09-16, 64 stars).

  GitHub reports the licence as NOASSERTION, but the repo's `LICENSE` file is the MIT text ("Copyright (c) 2026 cesium-clouds-atmosphere contributors") followed by a Chinese note that the code is adapted from three-geospatial; the README credits three-geospatial's MIT licence. Its README pins Cesium 1.132 and uses three only to parse `.bin` textures into `Data3DTexture`.
- Fit: proves the pipeline runs inside Cesium's post-process chain. Raw-WebGL side passes reach into Cesium internals and will break on Cesium upgrades; one-person project; Chinese docs; three.js is still pulled in to parse textures.
- Reuse: as a working reference for wiring, not as a dependency.

### Smaller references

- Sebastian Lague's Unity clouds: clear teaching implementation of Nubis-style raymarching ([SebLague/Clouds](https://github.com/SebLague/Clouds); MIT, last push 2024, 965 stars).
- three.js `webgl_volume_cloud` example: a single 3D-texture cloud volume, not a sky ([example](https://threejs.org/examples/webgl_volume_cloud.html)).
- FlightGear Advanced Weather and ALS: METAR-driven placement of 3D cloud billboards/impostors by type, plus fog, haze and precipitation shaders, documented on the wiki ([Advanced Weather](https://wiki.flightgear.org/Advanced_weather), sections "Connection with the METAR system" and "Selection of tile type"; [ALS](https://wiki.flightgear.org/ALS_technical_notes)).

  The ALS glass effect covers rain on glass, frost and fogging. FlightGear is GPL-2.0 ([FlightGear/flightgear](https://github.com/FlightGear/flightgear), pushed 2025-03-04, 817 stars), so technique only.

  Its METAR-to-cloud-type rules are the most directly applicable published mapping.
- Outerra publishes blog notes on atmosphere and cloud rendering in a planetary engine ([outerra.blogspot.com](https://outerra.blogspot.com/)); closed source, technique only.

### Lightning

No open-source lightning renderer suited to a web globe was found. Tatarchuk's rain system treats a flash as "a strong directional light that has to affect every object in the scene" and feeds its brightness and direction to the rain shader so drops light up with the strike ([Tatarchuk 2006](https://advances.realtimerendering.com/s2006/Tatarchuk-Rain.pdf), "Lightning System").

For bolt shape, Kim & Lin grow the branching path with the dielectric breakdown model and render its glow with a convolution kernel ([Kim & Lin, "Physically Based Animation and Rendering of Lightning", Pacific Graphics 2004](https://gamma.cs.unc.edu/LIGHTNING/)).

Cheaper bolts by midpoint displacement and in-cloud flashes by lighting the cloud raymarch for a few frames are common practice, but no source for them was opened in this run. An in-cloud flash would be a small change if our clouds already raymarch.

## Ranked options

### Rain and snow

1. Camera-anchored instanced wraparound box as a Cesium custom primitive (the "camera-centered geometry" family NVIDIA names; Tatarchuk's image-space layers are the alternative), density from Marshall-Palmer by METAR intensity. Effort: medium (1-2 weeks). Risk: low; uses public Cesium `Primitive` API, depth-tested, cheap on tablets.
2. Add splashes on runway/apron and wet-surface darkening as a post-process using depth and normals. Effort: medium. Risk: medium (normals in Cesium post-process need `scene.postProcessStages` normal access or reconstruction from depth).
3. Full-screen depth-aware shader precipitation as the low-quality tier. Effort: low. Risk: low; looks flat.
4. Tower-glass droplet overlay (Codrops technique). Effort: medium. Risk: low; technique only (no licence).

Verdict: keep ours, but rebuild it on a technique, not a library. Nothing open source does better than a camera-anchored GPU streak/flake primitive, which is what the Babylon overlay approximates; port that idea into a Cesium primitive with instanced vertex-shader motion (no CPU simulation), drive density and visibility from METAR via Marshall-Palmer, and add splashes and glass droplets later as separate tiers.

### Fog and haze

1. Analytic exponential height fog in a `PostProcessStage`, ground extinction from METAR visibility by the WMO MOR relation (β = ln 20/V ≈ 3.0/V), falloff tied to the lowest ceiling. Effort: low (days). Risk: low.
2. Tint the fog colour from Cesium's existing atmosphere/sun so it matches sky lighting. Effort: low. Risk: low.
3. Bruneton or Hillaire aerial perspective replacing Cesium's atmosphere. Effort: high. Risk: high (conflicts with Cesium's sky/ground atmosphere; little gain at tower distances).

Verdict: keep ours and make it exact. The state of the art for this scale is analytic height fog; the gap to close is calibration, so a METAR of 1/2 SM gives the documented 2-5% contrast at 805 m. Defer atmosphere replacement.

### Volumetric clouds

1. Upgrade our raymarcher with Nubis/three-clouds techniques: per-layer type gradients from METAR (FEW-OVC coverage, CB/TCU type), Perlin-Worley shape and detail 3D textures, Beer-Powder and multi-scattering lighting, temporal upscaling. Borrow MIT shader code from @takram/three-clouds. Effort: medium-high (2-4 weeks). Risk: medium; temporal upscaling needs reprojection with Cesium's camera matrices.
2. Port @takram/three-clouds wholesale into Cesium following cesium-clouds-atmosphere's wiring. Effort: high. Risk: high (raw WebGL hooks into Cesium internals, Beer shadow maps outside Cesium's pipeline, upgrade fragility; the port's LICENSE file is MIT though GitHub cannot classify it).
3. `Cesium.CloudCollection` billboards for FEW/SCT cumulus as a low tier. Effort: low. Risk: low; looks dated and cannot do overcast.
4. Lightning: branching bolt geometry plus a flash light injected into the cloud raymarch. Effort: low-medium. Risk: low.

Verdict: port techniques, not the library. @takram/three-clouds is the only web implementation with tablet numbers, and they show it is viable on an M-series iPad only with temporal upscaling and Medium quality; older iPads hold 30 fps at Low.

Our homebrew already sits in the right slot (a depth-aware Cesium `PostProcessStage`), so the step up is to adopt its layer model, noise, lighting and temporal upscaling into our stage under its MIT licence, and to benchmark against its Tokyo scene numbers.

## What our code does today

Taken from the read-only code review for TC3D-318 (`.tmp/map-tc3d-318-weather-review.md`), not re-verified here. Paths are under `src/renderer/` on the `feat/cesium-weather` branch (1d69463) unless marked "main"; the review notes `MetarService.ts`, `weatherVisibility.ts`, `useBabylonPrecipitation.ts` and `constants/precipitation.ts` are identical on main.

On main, clouds and fog are still the Babylon dome and cloud planes (`useBabylonWeather.ts`); the branch replaces them with a Cesium post-process stage.

### Rain and snow

- Babylon CPU `ParticleSystem`s on the overlay canvas, one for rain and one for snow, 50,000 capacity each (`constants/precipitation.ts:58,98`), additive blend, with the `flare.png` texture fetched from `assets.babylonjs.com` (`hooks/useBabylonPrecipitation.ts:9,258,341`). The emitter follows the camera 50 m (rain) or 30 m (snow) above it (`useBabylonPrecipitation.ts:764-771`).
- Emit rate = base × intensity (light 0.02, moderate 0.3, heavy 1.0; `constants/precipitation.ts:127-133`) × `visibilityFactor` (0.5 at ≥ 6 SM to 2.0 at ≤ 1 SM; `stores/weatherStore.ts:145-153`) × the user's slider (`useBabylonPrecipitation.ts:919-938`). Rain falls at 900 m/s ("visual speed, not realistic", `constants/precipitation.ts:36-37`) with 0.3–0.6 m streaks in a 200 × 200 m box, so a drop moves about 15 m per frame at 60 fps (inferred from constants).
- No depth or occlusion: rain falls in front of buildings and inside the tower cab, the case TC3D-151's proving test names. Intensity changes only emit rate, not drop size, speed, visibility or sky darkness. Snow is additive white, so it nearly vanishes against a bright overcast sky.
- Types collapse: DZ, GR, GS and FZRA draw as rain, PL, SG and IC as snow (`useBabylonPrecipitation.ts:876-879`). No splashes, wet ground or glass droplets.
- Insets get no precipitation or wind: `hooks/useInsetStoreSync.ts:115-135` ships only `fogDensity`, `cloudLayers` and `visib` and writes `precipitation: []`.
- Cost: never measured; about 6,000 live particles for moderate rain and the 50,000 cap for heavy rain at low visibility, all updated on the main thread (estimated from constants). No precipitation quality preset exists, only the 0.5–2.0 slider (`types/settings.ts:781-784`).

### Fog

- Stage fog: visibility in metres × `visibilityScale`, zero at ≥ 10 SM (`utils/weatherStage.ts:67-72`), transmittance from density (1/V) × exp(−h/400 m) integrated analytically (`hooks/weather/cloudStage.glsl.ts:80-95`), k = 1.0 × `fogIntensity` (`utils/weatherStage.ts:202-204`), composited per pixel with scene depth, sky taken as 1,000 km (`cloudStage.glsl.ts:28-39,325-337`).
- Calibration: exp(−d/V) leaves 37% transmittance at the METAR visibility, where WMO MOR is 5% (β ≈ 3/V, section 2 above), so our fog is about 3× too thin at the stated distance (TC3D-70). The step at 10 SM is TC3D-224 (In Progress). Haze between 6 and 10 SM never shows.
- One flat grey colour (0.62, 0.66, 0.70) × a daylight factor (`cloudStage.glsl.ts:56-61`): no sun-side glow, no horizon blend, no FG/BR/HZ/FU difference (these codes are not parsed). Vertical visibility `VV` maps to coverage 0, so an obscured sky draws no low deck.
- Fog vanishes above about 32 km camera height (TC3D-219; `cloudStage.glsl.ts:87-92`). Cesium's own `scene.fog` stays at defaults under the stage (`utils/weatherStage.ts:179-184,221-241`), so two fogs draw at once (effect unmeasured). `visibilityToFogDensity` is duplicated in `services/MetarService.ts:85-103` and `stores/weatherStore.ts:78-102`.
- The stage fog is gated by `showBabylonFog` (`utils/weatherStage.ts:274-278`), a setting named for the deleted dome; scene fog and culling read `showCesiumFog`.

### Lightning

- `hasThunderstorm` is true when the raw METAR has `TS` as a word or `TS` plus two letters (`services/MetarService.ts:464`); `VCTS` does not trigger it (inferred from the regex).
- A 1000-unit white plane 50 units in front of the Babylon camera at alpha 0.3 for 100 ms, a 30% chance of up to 3 flashes, then 30–90 s until the next (`constants/precipitation.ts:155-174`, `useBabylonPrecipitation.ts:557-650`), timed with `setTimeout`. No bolt, direction, cloud illumination or thunder; the wash covers the cab too, and real cells flash every few seconds. The cloud pass already has `cloudLight(p, layer, sun)` (`cloudStage.glsl.ts:183-191`) where an in-cloud flash could go.

### Clouds

- METAR cover to coverage FEW 0.1875, SCT 0.4375, BKN 0.6875, OVC 1.0, at most 4 layers (`stores/weatherStore.ts:105-139`); slab thickness 250/350/450/600 m (`constants/weather.ts:223-228`). Each layer is a curved slab of 4-octave value-noise fbm (1800 m × 600 m cells), coverage as a threshold (`cloudStage.glsl.ts:162-181`).
- Raymarch at 48/72/120 steps, 40/60/100 km radius and 0.25/0.375/0.5 resolution for Low/Medium/High (`constants/weather.ts:186-211`), one sun-direction sample for light, a grey-to-white height ramp and a `daylight()` floor of 0.08. The result is upsampled bilinearly with per-frame hash jitter (`cloudStage.glsl.ts:297`) and no depth-aware upsample.
- All clouds look alike: no cloud type, and `CB`/`TCU` in the raw METAR are never read (`services/MetarService.ts:432-444`). No phase function, ambient term, multiple scattering, sunset colour or cloud shadows. Noise drifts at a fixed ~7 m/s on a fixed bearing, not the METAR wind (`cloudStage.glsl.ts:174`). Low and Medium leave a clear band below the horizon.
- Cost (desktop, RTX 4090, 1600×900): at most +1.4 ms median CPU `cesiumDraw`; GPU High +1.2 to +2.7 ms, Medium +0.9 to +1.5, Low +0.7 to +0.9 (`docs/plans/canvases/cesium-weather-stage/README.md`). iPad unmeasured (TC3D-150).

### METAR parsing

- `parsePrecipitation` splits any 2–8 letter word into 2-letter codes (`services/MetarService.ts:471-509`), so a station identifier such as `KMSN` could read as snow if the raw string has it as a space-led token; to be checked with a live fetch before filing.
- Not mapped: FG, BR, HZ, FU, DU, SA, VA, SQ, FC, DS, SS; qualifiers SH, FZ, BL, DR, MI, BC, PR, VC and RE are dropped or misread (`RERA` becomes current rain).
- Two `visibilityFactor` formulas: the store's 0.5–2.0 (`stores/weatherStore.ts:145-153`) and the interpolation path's `visibility < 3 ? max(1, 4 - visibility) : 1` (`services/MetarService.ts:387`), so rain density jumps when interpolation turns on.
- Two cover tables: the store's 0.1875/0.4375/0.6875/1.0 (`stores/weatherStore.ts:112-121`) and the service's 0.25/0.5/0.75/1.0 (`services/MetarService.ts:108-121`, interpolation path).
- Visibility `10+` parses to 10 with no "unlimited" state (`services/MetarService.ts:416-427`). Wind `VRB` becomes 0° and `250V310` groups are ignored (`MetarService.ts:540`). No RVR, temperature, dewpoint, TAF or trend.
- Interpolation blends up to 3 stations within 100 NM by IDW (`utils/weatherInterpolation.ts`), but precipitation comes from the nearest station that has any, so it flips rather than blends.
- No test exists for `MetarService`, `weatherStore` or `weatherInterpolation`.

### Culling of labels and aircraft

- `utils/weatherVisibility.ts:23-51` hides a label beyond METAR visibility × `visibilityScale` (horizontal distance, hard step, only with `showCesiumFog`) or behind a layer with coverage ≥ 0.75 (`constants/babylon.ts:31`) between camera and aircraft. Callers: `hooks/useCesiumLabels.ts:496` and `hooks/useAircraftFiltering.ts:380-395`. Aircraft models are not culled, only fogged, so label and aircraft can disagree.
- BKN never counts as a ceiling on the direct path (0.6875 < 0.75), though the docstring says "at or above BKN" (`utils/weatherVisibility.ts:10`); the unit test passes a hand-made 0.75 layer (`tests/weatherVisibility.test.ts:106-108`).
- In clear air, labels are hidden beyond 10 SM × `visibilityScale` (about 16 km) because visibility caps at 10, while the stage draws no fog at all at 10 SM.
- Culling reads `currentMetar.visib` (`hooks/useBabylonOverlay.ts:266`) while the fog uses the interpolated visibility, and culling measures horizontal distance where fog uses 3D distance.

### Open decisions from the review

1. Replace or patch the cloud stage: port @takram/three-clouds techniques into our stage, decided after TC3D-150's iPad numbers.
2. Rain and snow technique: post-process, instanced streak primitive or layered image-space rain (TC3D-151 spike), and whether a CPU fallback exists without WebGL2 (`docs/plans/rendering-opportunities-design.md:218`).
3. Whether insets draw rain, snow and lightning.
4. One fog toggle or two, and whether Cesium's `scene.fog` stays on under the stage.
5. Fog calibration target: exp(−d/V) (today) or the WMO 5% threshold (TC3D-70).
6. Culling: hide at 10 SM in clear air or not, BKN as a ceiling or not, interpolated visibility or the station's.
7. Precipitation intensity: keep the hand-tuned multipliers or derive density from rain rate (Marshall-Palmer).
8. Whether `CB`/`TCU` are parsed and drawn.

## Proposed plan

Ranked by what a controller notices first per unit of work. Issue overlaps come from the review's issue map (open TC3D issues listed through `linear-ro`); comments on those issues were not read.

### 1. METAR parser fixes and a parser test suite

Fix the station-identifier misread (after confirming it with a live `rawOb`), map FG/BR/HZ/FU/DU/SA and the SH/FZ/VC/RE qualifiers, parse `CB`/`TCU`, `VV`, an "unlimited" visibility for `10SM`/`9999`, and variable wind, all against a table of real METAR strings in a new `MetarService` test file.

Every effect below reads this parser, so it goes first. Cost: low (days). Risk: low. Overlaps TC3D-70 (vertical visibility, RVR) only in part. Needs new issues: "METAR parser gaps" and "no METAR parser tests".

### 2. One source of truth for cover and visibility factor

Delete the service's 0.25/0.5/0.75/1.0 table and the interpolation path's `visibilityFactor`, keeping one of each in the store, so turning interpolation on no longer changes rain density or makes BKN a ceiling. Cost: low (hours to a day). Risk: low, but it changes what BKN does to culling, so decide open decision 6 with it. No issue covers it; needs new issues "two cover tables" and "two visibilityFactor formulas" (or one issue for both).

### 3. Fog calibrated to METAR visibility

Set ground extinction to β = ln 20 / V ≈ 3.0/V (WMO MOR, WMO-No. 8 eq. 9.6) so contrast reaches 5% at the reported visibility, keep the analytic height fog (Wenzel 2007's integral is what the stage already does), tie the height scale to the lowest ceiling or `VV`, tint the colour from Cesium's sun and atmosphere, and decide whether `scene.fog` is turned off under the stage.

Cost: low (days). Risk: low; the fog gets about 3× thicker at the stated visibility, which users will notice. Overlaps TC3D-70 (calibrated fog), TC3D-224 (10 SM fade and 6 s ease, landed on `feat/cesium-weather`), TC3D-185 (sun curve), TC3D-156 (toggle and setting semantics), TC3D-219 (fog above 32 km).

### 4. Weather culling that matches the fog

Hide labels only where the fog really hides the aircraft: no visibility cull in clear air (≥ 10 SM, or the new "unlimited" state from item 1), the same interpolated visibility and 3D distance the fog uses, and a ceiling rule that includes or excludes BKN on purpose. Cost: low. Risk: low. Overlaps TC3D-137 (cull gate follows the wrong toggle) and TC3D-177 (height reference). Needs a new issue: "labels hidden beyond 10 SM in clear air".

### 5. Depth-aware rain and snow in Cesium

A Cesium custom primitive with instanced streaks or flakes in a camera-anchored wraparound box (positions from `mod(seed + wind·t, box)` in the vertex shader, no CPU state), depth-tested so rain stops at buildings and stays out of the cab, with Tatarchuk-style image-space layers or a full-screen shader as the Low tier.

Density from rain rate via Marshall-Palmer (−RA/RA/+RA ≈ 1/4/12 mm/h), with fall speed and streak length tied to drop size, and snow drawn with alpha blending so it shows against bright sky. Cost: medium (1–2 weeks after the spike). Risk: low to medium; the cost on iPad is unknown. Overlaps TC3D-151 (the spike and port; Marshall-Palmer and a quality preset are not in its text). Needs new issues: "insets get no precipitation" (or a line in TC3D-151) and "precipitation quality preset".

### 6. Lightning as scene light and in-cloud flash

Replace the white plane with a short flash uniform that lights the cloud raymarch from inside (`cloudLight`) and brightens the scene as a directional light, as Tatarchuk's system does, with a cadence of seconds rather than 30–90 s, `VCTS` handled, and optional bolt geometry later. Cost: low to medium. Risk: low. Overlaps TC3D-152 (flash without Babylon); cadence and cloud lighting are not in its text.

### 7. Cloud stage upgrade from Nubis and @takram/three-clouds

Per-layer type gradients from METAR cover and `CB`/`TCU` (Nubis), Perlin-Worley shape and Worley detail noise in place of value noise, Henyey-Greenstein phase with Beer-Powder and Wrenninge multi-scattering octaves (Frostbite 2016), METAR wind drift, and temporal upscaling with a depth-aware upsample, borrowing MIT shader code from @takram/three-clouds.

Cost: medium-high (2–4 weeks). Risk: medium; reprojection with Cesium's camera matrices and the iPad budget are unknown until TC3D-150 reports. Overlaps TC3D-213 (feature parent), TC3D-150 (iPad measurement), TC3D-294, TC3D-314, TC3D-310, TC3D-309, TC3D-185. Needs new issues for cloud types, wind drift and noise/lighting, which the review found in no issue.

### 8. Wet surfaces, splashes and glass droplets

Splashes on the apron, wet-surface darkening and droplets on the tower glass (Tatarchuk; Codrops technique only, as it has no licence). Cost: medium. Risk: medium (normals in a Cesium post-process must be reconstructed from depth). No issue covers it.
