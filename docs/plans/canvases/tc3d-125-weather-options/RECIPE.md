# TC3D-125 weather options: rebuild recipe

`index.html` here links 22 JPEG shots and 23 PNG crops by relative path (`a1-10.jpg`, `crops/a1-10-horizon.png`, …). They total about 7 MB, so they are not committed. They live in the scratch tree's `.tmp/mocks/tc3d-125-weather-options/`, beside a copy of this page. This file rebuilds them.

## Source

- Tree: `feat/cesium-weather` at 3ac96df (`ref: delete the Babylon fog dome, cloud meshes and night lighting`), checked out in a scratch worktree with `pnpm install --frozen-lockfile`.
- The prototype diff below applied on top. It adds runtime switches read every frame from `window.__tc3dMock`; with the object empty every uniform keeps today's value, and A1/C1/D1 measured the same as the unedited tree.
- An ion token in the desktop dev settings (`/api/dev-health` answers `ionToken: true`).

| `__tc3dMock` field | Meaning | Today |
|---|---|---|
| `radius` | deck radius, m (`u_radius`) | 40000 |
| `steps` | march steps per layer (`u_steps`, clamp 4–256; `MAX_STEPS` raised to 256) | 48 |
| `curve` | 1 = slab follows the earth down by d²/2R, R = 6,371 km, exact ray entry/exit | 0 |
| `relief` | top rises by up to this share of the slab thickness (2D value noise, 5 km + 2 km cells) | 0 |
| `dark` | 1 = cloud underside `dark` becomes the fog grey | 0 |
| `fogDarken` | fog grey (and the retuned `dark`) darkened by this × the highest layer coverage | 0 |
| `haze` | visibility, m, of a haze on sky pixels fading out by ~4° above level (composite only) | 0 (off) |

## Steps

1. `pnpm --dir <scratch tree> run vite:headless` in the background; check `http://localhost:5174/api/dev-health`.
2. With the `playwright-headless` MCP server, `browser_navigate` to `http://localhost:5174/`.
3. Set up (`browser_run_code_unsafe`): wait for `window.__tc3d.viewer`; `(await import('/stores/airportStore.ts')).useAirportStore.getState().selectAirport('EGLL')`; `__tc3d.stores.settings.getState().updateCesiumSettings({ timeMode: 'fixed', fixedTimeHour: 13 })` (the hour is UTC); wait 12 s.
4. For each batch: `browser_evaluate` sets `window.__jobs` (lists below), then `browser_run_code_unsafe` with `filename` pointing at the shoot script below (the MCP server reads scripts only under the main checkout, so it was copied to `X:\dev\towercab-3d\.playwright-mcp\tc3d125-shoot.js`). The shoot script injects the helpers, sets weather, mock and pose per job, waits 6 s, hides the app panels by opacity, screenshots the Cesium canvas and reads the metrics.
5. Run every tower-pose batch before any above-deck job. Clearing the camera override leaves the camera where the override put it; reload the page (step 2–3) to get the tower camera back.
6. Frame cost: `browser_evaluate` with the perf snippet below at each pose.
7. Convert and crop (from the shots folder): every `*.png` saved as `*.jpg` at quality 90; tower shots cropped to columns 400–1200, rows 200–330 and scaled ×2 into `crops/<name>-horizon.png`; the pitch −6 B shots cropped to columns 300–1300, rows 246–496 into `crops/<name>-tops.png`. Pillow, `uv run --no-project --with pillow python`.

Layers in every job: `[{ type: 'BKN', altitude: 274.3, coverage: 0.7 }, { type: 'OVC', altitude: 609.6, coverage: 1 }]`. Tower pose: the app's EGLL tower camera (88.8 m above the anchor ground, 158.6 m ellipsoid), `camera.set({ heading: 274, pitch: -3, fov: 45 })`. The baseline `base-*` shots were taken before the diff with the same weather and pose.

### Job lists

```js
const a2 = { curve: 1, radius: 100000, steps: 120 }
const a3 = { curve: 1, radius: 121800, steps: 146 } // horizon radius for 88.8 m and a 609.6 m base
// Batch 1 (tower)
window.__jobs = [
  { name: 'a1-596', vis: 5.96 }, { name: 'a2-596', vis: 5.96, mock: a2 }, { name: 'a3-596', vis: 5.96, mock: a3 },
  { name: 'a1-10', vis: 10 }, { name: 'a2-10', vis: 10, mock: a2 }, { name: 'a3-10', vis: 10, mock: a3 },
  { name: 'a3c2-596', vis: 5.96, mock: { ...a3, dark: 1 } },
  { name: 'c1-13', vis: 1.3 }, { name: 'c2-13', vis: 1.3, mock: { dark: 1 } },
  { name: 'c3-13', vis: 1.3, mock: { dark: 1, fogDarken: 0.15 } }, { name: 'c4-13', vis: 1.3, mock: { dark: 1 }, sceneFog: false },
  { name: 'd1-10', vis: 10 }, { name: 'd2-10', vis: 10, mock: { haze: 16093 } }, { name: 'd2a3-10', vis: 10, mock: { ...a3, haze: 16093 } },
]
// Batch 2 (above deck): camera 1 km east of the tower at 1,524 m AGL; test B738 over the tower at 1,219 m AGL
const lat = 51.47060012819999, lon = -0.46194100379999997, camLon = -0.4475199424157619, ground = 69.8
__tc3d.weatherStage.set({ testAircraft: { lat, lon, heightM: ground + 1219.2, heading: 0 } })
const pose = (pitch) => ({ lat, lon: camLon, heightM: ground + 1524, heading: 274, pitch })
window.__jobs = [['b1', 0], ['b2', 0.2], ['b3', 0.4]].flatMap(([n, relief]) => [
  { name: n + '-p16', vis: 10, mock: { ...a3, relief }, pose: pose(-16) },
  { name: n + '-p6', vis: 10, mock: { ...a3, relief }, pose: pose(-6) },
])
// Batch 3: same as batch 2's -p6 jobs, names suffixed '-lowsun', after updateCesiumSettings({ fixedTimeHour: 16.5 })
```

Metric gotcha: `scene.render()` without a time renders at the wall clock, not the app's fixed clock; the helpers pass `viewer.clock.currentTime`.

## Prototype diff

```diff
diff --git a/src/renderer/hooks/useCesiumWeatherStages.ts b/src/renderer/hooks/useCesiumWeatherStages.ts
index a004938..d92d7d3 100644
--- a/src/renderer/hooks/useCesiumWeatherStages.ts
+++ b/src/renderer/hooks/useCesiumWeatherStages.ts
@@ -142,7 +142,14 @@ function createStage(viewer: Cesium.Viewer, refs: StageRefs, startMs: number): C
     return frameRef.current
   }
 
+  // MOCK (TC3D-125): lane switches read every frame from window.__tc3dMock; absent fields keep today's values.
+  const mock = (): Record<string, number> => (window as unknown as { __tc3dMock?: Record<string, number> }).__tc3dMock ?? {}
+  const maxCoverage = () => Math.max(0, ...inputsRef.current.layers.map((l) => (l.w > 0 ? l.z : 0)))
+
   const shared = {
+    u_mockDark: () => mock().dark ?? 0,
+    u_mockFogDarken: () => (mock().fogDarken ?? 0) * maxCoverage(),
+    u_mockHaze: () => mock().haze ?? 0,
     // The deck shift is added to the camera, which moves the whole field (noise included) relative to it.
     u_camPosEnu: () => {
       const current = frame()
@@ -167,9 +174,11 @@ function createStage(viewer: Cesium.Viewer, refs: StageRefs, startMs: number): C
       u_layer2: layerUniform(2),
       u_layer3: layerUniform(3),
       u_layerCount: () => inputsRef.current.layerCount,
-      u_steps: () => Cesium.Math.clamp(Math.round(quality.steps), 4, 128),
+      u_steps: () => Cesium.Math.clamp(Math.round(mock().steps ?? quality.steps), 4, 256),
       u_densityScale: () => quality.densityScale,
-      u_radius: () => quality.radius,
+      u_radius: () => mock().radius ?? quality.radius,
+      u_mockCurve: () => mock().curve ?? 0,
+      u_mockRelief: () => mock().relief ?? 0,
       u_time: () => (performance.now() - startMs) / 1000,
       u_noiseOffset: () => frame().noiseOffset,
     },
diff --git a/src/renderer/hooks/weather/cloudStage.glsl.ts b/src/renderer/hooks/weather/cloudStage.glsl.ts
index e07a82f..9ead20b 100644
--- a/src/renderer/hooks/weather/cloudStage.glsl.ts
+++ b/src/renderer/hooks/weather/cloudStage.glsl.ts
@@ -51,8 +51,14 @@ float daylight() {
   return smoothstep(-0.1, 0.25, sunEnu().z);
 }
 
+uniform float u_mockDark;
+uniform float u_mockFogDarken;
+uniform float u_mockHaze;
+
+const vec3 FOG_GREY = vec3(0.62, 0.66, 0.70);
+
 vec3 fogColor() {
-  return vec3(0.62, 0.66, 0.70) * (0.08 + 0.92 * daylight());
+  return FOG_GREY * (1.0 - u_mockFogDarken) * (0.08 + 0.92 * daylight());
 }
 
 // Length of the segment from ro over distance d along rd that lies below the anchor ground (z < 0).
@@ -72,14 +78,14 @@ float fogBelowGroundLength(vec3 ro, vec3 rd, float d) {
 // Density is (1 / visibility) * exp(-max(height, 0) / u_fogHeightScale): never denser than at
 // the anchor ground, so terrain below it is not drowned. Below the ground the density is
 // constant; above it the integral is analytic, starting at the camera or at the ground.
-float fogTransmittance(vec3 ro, vec3 rd, float d) {
-  if (u_visibility <= 0.0) {
+float fogTransmittanceVis(vec3 ro, vec3 rd, float d, float visibility) {
+  if (visibility <= 0.0) {
     return 1.0;
   }
   float below = fogBelowGroundLength(ro, rd, d);
   float above = d - below;
-  float integral = below / u_visibility;
-  float base = exp(-max(ro.z, 0.0) / u_fogHeightScale) / u_visibility;
+  float integral = below / visibility;
+  float base = exp(-max(ro.z, 0.0) / u_fogHeightScale) / visibility;
   float k = rd.z / u_fogHeightScale;
   if (abs(k * above) < 1.0e-4) {
     integral += base * above;
@@ -88,6 +94,10 @@ float fogTransmittance(vec3 ro, vec3 rd, float d) {
   }
   return exp(-u_fogExtinction * integral);
 }
+
+float fogTransmittance(vec3 ro, vec3 rd, float d) {
+  return fogTransmittanceVis(ro, rd, d, u_visibility);
+}
 `
 
 export const CLOUD_STAGE_FS = /* glsl */ `
@@ -104,8 +114,11 @@ uniform float u_time;
 // Horizontal position of this frame's origin from a fixed noise origin, in this frame's axes,
 // so the noise field stays put horizontally when the anchor moves; vertically it follows the deck.
 uniform vec3 u_noiseOffset;
+uniform float u_mockCurve;
+uniform float u_mockRelief;
 
-const int MAX_STEPS = 128;
+const int MAX_STEPS = 256;
+const float EARTH_R = 6371000.0;
 
 float hash13(vec3 p3) {
   p3 = fract(p3 * 0.1031);
@@ -143,9 +156,26 @@ float fbm(vec3 p) {
   return sum / 0.9375;
 }
 
+// Height above the curved deck datum: the earth falls away by d^2/2R at horizontal distance d.
+float deckZ(vec3 p) {
+  return p.z + u_mockCurve * dot(p.xy, p.xy) / (2.0 * EARTH_R);
+}
+
+// Local slab top: the flat top plus low-frequency billows rising up to u_mockRelief of the thickness.
+float localTop(vec3 p, vec4 layer) {
+  float top = layer.x + layer.y;
+  if (u_mockRelief <= 0.0) {
+    return top;
+  }
+  vec2 w = p.xy + u_noiseOffset.xy + vec2(u_time * 7.2, u_time * 3.6);
+  float n = 0.65 * valueNoise(vec3(w / 5000.0, 7.0)) + 0.35 * valueNoise(vec3(w / 2000.0, 13.0));
+  return top + u_mockRelief * layer.y * clamp((n - 0.25) / 0.5, 0.0, 1.0);
+}
+
 // Layer: x = base (m above airport), y = thickness (m), z = coverage (0..1), w = active.
 float cloudDensity(vec3 p, vec4 layer) {
-  float hf = (p.z - layer.x) / layer.y;
+  float z = deckZ(p);
+  float hf = (z - layer.x) / (localTop(p, layer) - layer.x);
   if (hf < 0.0 || hf > 1.0) {
     return 0.0;
   }
@@ -154,7 +184,7 @@ float cloudDensity(vec3 p, vec4 layer) {
     return 0.0;
   }
   float shape = smoothstep(0.0, 0.12, hf) * (1.0 - smoothstep(0.5, 1.0, hf));
-  vec3 world = p + u_noiseOffset;
+  vec3 world = vec3(p.xy, z) + u_noiseOffset;
   vec3 q = vec3(world.xy / 1800.0, world.z / 600.0) + vec3(u_time * 0.004, u_time * 0.002, 0.0);
   // fbm of value noise clusters around 0.5; stretch it so the coverage threshold
   // leaves roughly the reported fraction of sky covered.
@@ -168,8 +198,8 @@ vec3 cloudLight(vec3 p, vec4 layer, vec3 sun) {
   float lightStep = layer.y * 0.3;
   float occluder = cloudDensity(p + sun * lightStep, layer);
   float lightT = exp(-occluder * u_densityScale * lightStep * 0.5);
-  float hf = clamp((p.z - layer.x) / layer.y, 0.0, 1.0);
-  vec3 dark = vec3(0.40, 0.43, 0.50);
+  float hf = clamp((deckZ(p) - layer.x) / (localTop(p, layer) - layer.x), 0.0, 1.0);
+  vec3 dark = mix(vec3(0.40, 0.43, 0.50), FOG_GREY * (1.0 - u_mockFogDarken), u_mockDark);
   vec3 bright = vec3(1.0, 0.98, 0.95);
   return mix(dark, bright, clamp(0.35 * hf + 0.65 * lightT, 0.0, 1.0)) * (0.08 + 0.92 * daylight());
 }
@@ -198,24 +228,44 @@ float cylinderExit(vec3 ro, vec3 rd) {
   return (-b + sqrt(disc)) / a;
 }
 
+// Interval of t where deckZ(ro + rd * t) <= h, as (lo, hi); lo > hi when empty.
+// deckZ along the ray is a + b t + c t^2 with c >= 0, so the set is one interval.
+vec2 belowLevel(vec3 ro, vec3 rd, float h) {
+  const float BIG = 1.0e9;
+  float qa = u_mockCurve * dot(rd.xy, rd.xy) / (2.0 * EARTH_R);
+  float qb = rd.z + u_mockCurve * dot(ro.xy, rd.xy) / EARTH_R;
+  float qc = deckZ(ro) - h;
+  if (qa < 1.0e-14) {
+    if (abs(qb) < 1.0e-7) {
+      return qc <= 0.0 ? vec2(-BIG, BIG) : vec2(1.0, -1.0);
+    }
+    float r = -qc / qb;
+    return qb > 0.0 ? vec2(-BIG, r) : vec2(r, BIG);
+  }
+  float disc = qb * qb - 4.0 * qa * qc;
+  if (disc < 0.0) {
+    return vec2(1.0, -1.0);
+  }
+  float s = sqrt(disc);
+  float q = -0.5 * (qb + (qb >= 0.0 ? s : -s));
+  float r0 = q / qa;
+  float r1 = qc / q;
+  return vec2(min(r0, r1), max(r0, r1));
+}
+
 void marchLayer(vec3 ro, vec3 rd, float tScene, vec4 layer, float jitter, vec3 sun,
                 inout float transmittance, inout vec3 color, inout float weightedT, inout float weightSum) {
-  float top = layer.x + layer.y;
-  float t0;
-  float t1;
-  if (abs(rd.z) < 1.0e-5) {
-    if (ro.z < layer.x || ro.z > top) {
-      return;
+  vec2 inTop = belowLevel(ro, rd, layer.x + layer.y * (1.0 + u_mockRelief));
+  float t0 = max(inTop.x, 0.0);
+  float t1 = min(inTop.y, min(tScene, cylinderExit(ro, rd)));
+  vec2 under = belowLevel(ro, rd, layer.x);
+  if (under.x <= under.y) {
+    if (under.x <= t0 && under.y > t0) {
+      t0 = under.y;
+    } else if (under.x > t0 && under.x < t1) {
+      t1 = under.x;
     }
-    t0 = 0.0;
-    t1 = SKY_DISTANCE;
-  } else {
-    float ta = (layer.x - ro.z) / rd.z;
-    float tb = (top - ro.z) / rd.z;
-    t0 = max(min(ta, tb), 0.0);
-    t1 = max(ta, tb);
   }
-  t1 = min(t1, min(tScene, cylinderExit(ro, rd)));
   if (t1 <= t0) {
     return;
   }
@@ -278,8 +328,16 @@ void main() {
   vec2 uv = v_textureCoordinates;
   vec4 scene = texture(colorTexture, uv);
   vec4 cloud = texture(cloudTexture, uv);
-  float fogT = fogTransmittance(u_camPosEnu, viewRayEnu(uv), sceneDistance(uv));
+  vec3 rd = viewRayEnu(uv);
+  float dist = sceneDistance(uv);
+  float fogT = fogTransmittance(u_camPosEnu, rd, dist);
   vec3 fogged = mix(fogColor(), scene.rgb, fogT);
+  // Horizon haze on sky pixels only, at u_mockHaze visibility, gone by about 4 deg above level.
+  if (u_mockHaze > 0.0 && dist >= SKY_DISTANCE) {
+    float hazeT = fogTransmittanceVis(u_camPosEnu, rd, dist, u_mockHaze);
+    hazeT = mix(hazeT, 1.0, smoothstep(0.0, 0.07, rd.z));
+    fogged = mix(fogColor(), fogged, hazeT);
+  }
   out_FragColor = vec4(fogged * (1.0 - cloud.a) + cloud.rgb, scene.a);
 }
 `
```

## Helpers (`mock-helpers.js`, injected with `page.addScriptTag`)

```js
// Page-side helpers for the TC3D-125 mock captures; injected with page.evaluate.
window.__m = (() => {
  const R = 6371000
  const deg = Math.PI / 180
  const t = () => window.__tc3d

  async function weather({ vis, layers }) {
    const ws = t().stores.weather
    ws.getState().setDebugOverriding(true)
    ws.getState().setCloudLayers(layers)
    const metar = ws.getState().currentMetar
    // fogDensity mirrors visibilityToFogDensity's inverse figures from the map (scene.fog only).
    const fogBySM = { 10: 0, 5.96: 0.0021, 1.3: 0.0083 }
    ws.setState({ useInterpolation: false, currentMetar: { ...metar, visib: vis }, fogDensity: fogBySM[vis] ?? 0 })
    ws.getState().triggerInstantUpdate?.()
  }

  function groundUnderCamera() {
    const v = t().viewer
    const c = v.camera.positionCartographic
    const g = v.scene.globe.getHeight(c)
    return { camH: c.height, ground: g, agl: g === undefined ? null : c.height - g }
  }

  function grab() {
    const v = t().viewer
    // scene.render() without a time renders at the wall clock; pass the app's (fixed) clock time.
    v.scene.render(v.clock.currentTime)
    const c = v.canvas
    const g = document.createElement('canvas')
    g.width = c.width
    g.height = c.height
    const x = g.getContext('2d', { willReadFrequently: true })
    x.drawImage(c, 0, 0)
    return x.getImageData(0, 0, c.width, c.height)
  }

  function horizonRow(img) {
    const v = t().viewer
    const { agl } = groundUnderCamera()
    const dip = Math.sqrt((2 * Math.max(agl ?? 0, 0)) / R)
    const pitch = v.camera.pitch
    const fovy = v.camera.frustum.fovy
    const H = img.height
    const rowAt = (elev) => H / 2 - (Math.tan(elev - pitch) / Math.tan(fovy / 2)) * (H / 2)
    return { hr: Math.round(rowAt(-dip)), rowAt, dipDeg: dip / deg }
  }

  function stats(img, r0, r1, c0, c1) {
    let n = 0, chroma = 0, br = 0, lum = 0, rs = 0, gs = 0, bs = 0
    for (let y = Math.max(0, r0); y <= Math.min(img.height - 1, r1); y++) {
      for (let xx = c0; xx <= c1; xx++) {
        const i = (y * img.width + xx) * 4
        const r = img.data[i], gg = img.data[i + 1], b = img.data[i + 2]
        chroma += Math.max(r, gg, b) - Math.min(r, gg, b)
        br += b - r
        lum += 0.2126 * r + 0.7152 * gg + 0.0722 * b
        rs += r; gs += gg; bs += b
        n++
      }
    }
    const f = (v) => +(v / n).toFixed(1)
    return { chroma: f(chroma), bMinusR: f(br), lum: f(lum), rgb: [f(rs), f(gs), f(bs)] }
  }

  function rowLum(img, y, c0, c1) {
    let s = 0
    for (let xx = c0; xx <= c1; xx++) {
      const i = (y * img.width + xx) * 4
      s += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
    }
    return s / (c1 - c0 + 1)
  }

  async function nextFrame() {
    await new Promise((r) => requestAnimationFrame(() => r()))
  }

  // Metrics averaged over three frames (the deck drifts and the march jitters).
  async function metrics() {
    const acc = []
    for (let k = 0; k < 3; k++) {
      await nextFrame()
      const img = grab()
      const { hr, rowAt, dipDeg } = horizonRow(img)
      const cx = Math.round(img.width / 2)
      const c0 = cx - 100, c1 = cx + 99
      const band = stats(img, hr - 20, hr + 20, c0, c1)
      const top = Math.round(rowAt(-dipDeg * deg + 2 * deg))
      let maxStep = 0, maxStepRow = null
      let prev = rowLum(img, top, c0, c1)
      // Stops 8 rows above the computed horizon: the terrain's own edge sits about 6 rows above it.
      for (let y = top + 1; y <= hr - 8; y++) {
        const l = rowLum(img, y, c0, c1)
        if (Math.abs(l - prev) > maxStep) { maxStep = Math.abs(l - prev); maxStepRow = y }
        prev = l
      }
      const haze = stats(img, hr + 10, hr + 109, cx - 50, cx + 49)
      const sky = stats(img, Math.max(0, top - 60), Math.max(0, top - 20), c0, c1)
      const strip = stats(img, hr - 20, hr - 8, c0, c1)
      acc.push({ hr, top, band, strip, maxStep, maxStepRowsAboveHorizon: maxStepRow === null ? null : hr - maxStepRow, haze, sky })
    }
    const avg = (fn) => +(acc.reduce((s, a) => s + fn(a), 0) / acc.length).toFixed(1)
    return {
      horizonRow: acc[0].hr,
      twoDegRow: acc[0].top,
      band: { chroma: avg((a) => a.band.chroma), bMinusR: avg((a) => a.band.bMinusR), lum: avg((a) => a.band.lum), rgb: acc[0].band.rgb },
      strip: { chroma: avg((a) => a.strip.chroma), bMinusR: avg((a) => a.strip.bMinusR), lum: avg((a) => a.strip.lum), rgb: acc[0].strip.rgb },
      maxRowStep: avg((a) => a.maxStep),
      maxStepRowsAboveHorizon: acc.map((a) => a.maxStepRowsAboveHorizon),
      haze: { chroma: avg((a) => a.haze.chroma), lum: avg((a) => a.haze.lum), rgb: acc[0].haze.rgb },
      skyAbove: { chroma: avg((a) => a.sky.chroma), bMinusR: avg((a) => a.sky.bMinusR), lum: avg((a) => a.sky.lum) },
    }
  }

  function perf() {
    const w = t().perf().window
    const pick = (k) => (w && w[k] ? { median: +w[k].median.toFixed(2), p95: +w[k].p95.toFixed(2) } : null)
    return { frameInterval: pick('frameInterval'), cesiumDraw: pick('cesiumDraw'), gpuCesiumMs: pick('gpuCesiumMs') }
  }

  // Wall time of one full scene.render() including the GPU (a 1-pixel readPixels waits for it), in ms.
  async function renderCost(n = 90) {
    const v = t().viewer
    const gl = v.scene.context._gl
    const px = new Uint8Array(4)
    const samples = []
    for (let i = 0; i < n; i++) {
      await nextFrame()
      const t0 = performance.now()
      v.scene.render(v.clock.currentTime)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const q = (f) => +samples[Math.min(samples.length - 1, Math.floor(f * samples.length))].toFixed(2)
    return { median: q(0.5), p95: q(0.95) }
  }

  return { weather, groundUnderCamera, metrics, perf, grab, renderCost }
})()
```

## Shoot script (`browser_run_code_unsafe` `filename`)

```js
async (page) => {
  const dir = 'X:/dev/towercab-3d.wt/tc3d-125-mock/towercab-3d/.tmp/mocks/tc3d-125-weather-options/'
  const defaultLayers = [
    { type: 'BKN', altitude: 274.3, coverage: 0.7 },
    { type: 'OVC', altitude: 609.6, coverage: 1 },
  ]
  const hideUi = (hide) =>
    page.evaluate((hide) => {
      const canvas = document.querySelector('.cesium-widget canvas')
      if (hide) {
        window.__hidden = []
        let el = canvas
        while (el && el !== document.body) {
          for (const sib of el.parentElement.children) {
            if (sib !== el) {
              window.__hidden.push([sib, sib.style.opacity])
              sib.style.setProperty('opacity', '0', 'important')
            }
          }
          el = el.parentElement
        }
      } else {
        for (const [e, o] of window.__hidden) e.style.opacity = o
      }
    }, hide)
  await page.addScriptTag({ path: 'X:/dev/towercab-3d.wt/tc3d-125-mock/towercab-3d/.tmp/mock-helpers.js' })
  const jobs = await page.evaluate(() => window.__jobs)
  const out = []
  for (const job of jobs) {
    const { name, vis, mock = {}, pose = null, wait = 6000, perf = false, sceneFog = true } = job
    const layers = job.layers ?? defaultLayers
    await page.evaluate(
      async ({ vis, layers, mock, pose, sceneFog }) => {
        window.__tc3dMock = mock
        await window.__m.weather({ vis, layers })
        const t = window.__tc3d
        if (pose) {
          t.weatherStage.set({ camera: pose })
          t.camera.set({ fov: 45 })
        } else {
          t.weatherStage.set({ camera: null })
          t.camera.set({ heading: 274, pitch: -3, fov: 45 })
        }
        t.viewer.scene.fog.enabled = sceneFog
      },
      { vis, layers, mock, pose, sceneFog },
    )
    await page.waitForTimeout(perf ? Math.max(wait, 11000) : wait)
    await page.evaluate((sceneFog) => {
      window.__tc3d.viewer.scene.fog.enabled = sceneFog
    }, sceneFog)
    const p = perf
      ? await page.evaluate(async () => ({ ...window.__m.perf(), renderCost: await window.__m.renderCost() }))
      : null
    await hideUi(true)
    const box = await page.locator('.cesium-widget canvas').first().boundingBox()
    await page.screenshot({ path: dir + name + '.png', clip: box })
    await hideUi(false)
    const m = await page.evaluate(() => window.__m.metrics())
    out.push({ name, m, perf: p })
  }
  return out
}
```

## Frame cost snippet (`browser_evaluate`)

```js
// browser_evaluate body: interleaved render cost per lane at the current pose.
// Tower pose: lanes { noMarch: { radius: 1 }, a1: {}, a2, a3, a3relief40: { ...a3, relief: 0.4 } } after weather({ vis: 5.96 }).
// Above-deck pose: weatherStage.set({ camera: { lat: 51.4706, lon: -0.44752, heightM: 69.8 + 1524, heading: 274, pitch: -6 } }),
// weather({ vis: 10 }), lanes { b1: { ...a3, relief: 0 }, b2: { ...a3, relief: 0.2 }, b3: { ...a3, relief: 0.4 }, a1flat: {} }.
async () => {
  const t = window.__tc3d; const v = t.viewer; const gl = v.scene.context._gl; const px = new Uint8Array(4)
  const a3 = { curve: 1, radius: 121800, steps: 146 }
  const lanes = { noMarch: { radius: 1 }, a1: {}, a2: { curve: 1, radius: 100000, steps: 120 }, a3, a3relief40: { ...a3, relief: 0.4 } }
  const s = Object.fromEntries(Object.keys(lanes).map((k) => [k, []]))
  for (let round = 0; round < 8; round++) {
    for (const [k, mock] of Object.entries(lanes)) {
      window.__tc3dMock = mock
      for (let w = 0; w < 3; w++) { v.scene.render(v.clock.currentTime); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) }
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        v.scene.render(v.clock.currentTime)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        s[k].push(performance.now() - t0)
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  window.__tc3dMock = {}
  const q = (a, f) => { const b = [...a].sort((x, y) => x - y); return +b[Math.floor(f * (b.length - 1))].toFixed(2) }
  return Object.fromEntries(Object.entries(s).map(([k, a]) => [k, { median: q(a, 0.5), p95: q(a, 0.95) }]))
}
```
