# TC3D-386 mock: the facade art direction, prototyped

The page beside this file renders the art-direction guide (`docs/plans/osm-facade-art-direction.md`) on the TC3D-376 buildings and cameras: section 5 items 1-6 (vertical fitting with base band and parapet, clustered lit windows, grime, glass interior and reflection, tint jitter, frames, recesses and sills), then each class's section-3 read, for the seven existing classes, the six TC3D-376 prototypes and two additions: CARPORT 13 (the carport look) and the static-caravan variant on HOUSE hash 3.

Each section has three lanes: **Today** and **TC3D-376 proposed** reuse that mock's stills, and **Art direction** is new. A close-up set shows the near tier at about 100 m, Today against Art direction, day and night.

## Media

The 39 new stills (JPEG, 1,200 px wide) and the 66 reused TC3D-376 stills total 6.6 MB, so only `index.html`, this recipe and `prototype.patch` are committed. The stills live in the untracked source folder `X:\dev\towercab-3d\.tmp\mocks\tc3d-386-facade-detail-src\` of the main checkout, and in the review copy built from it. Every script below is reproduced at the end of this file; save each under the name its heading gives.

## 1. Prototype and dev API

`prototype.patch` is `git diff -- src/` taken with the TC3D-376 patch applied, so it holds both. From the worktree root (`X:\dev\towercab-3d.wt\tc3d-386\towercab-3d`, branch `tc3d-386` from `feat/osm-facades` a36d2fd):

```powershell
pnpm install --frozen-lockfile                                           # through tools/gate.ps1, --slot light
pnpm run vite:headless                                                    # port 5174, in the background; stop it when done
curl http://localhost:5174/api/dev-health                                 # needs ionToken: true
```

Follow CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules. Never return a live engine object from a `page.evaluate` (`docs/DRIVING_CONVENTIONS.md`, evaluate-returns-plain-values).

## 2. Shoot

The drivers are copies of TC3D-376's (`ft-run.cjs`, `ft-init.js`, `ft-shoot.js`) under `ft386-*` names, plus `ft386-perf.js`; `ft-aim.js` is TC3D-376's unchanged. `ft386-init.js` also takes `[class, hash]` to force a hash state (the caravan), and `ft386-shoot.js` writes into `.playwright-mcp\ftshots386\`. Save the scripts in `X:\dev\towercab-3d\.playwright-mcp\` (gitignored) and create `ftshots386\`; save the JSON files in the source folder.

Order matters, since Vite serves whatever `src/` holds (stop no run mid-edit):

1. **Today close-ups and the baseline frame time**, with `src/` at a36d2fd (no patch): `node .playwright-mcp/ft386-run.cjs <PW> <src>/closeups-today.json KSFO perf` through the gate, as below.
2. `git apply docs/plans/canvases/tc3d-386-facade-detail/prototype.patch`.
3. **Art-direction stills and the prototype's frame time**: `ft386-run.cjs <PW> <src>/shots.json KSFO perf`, then `bash .playwright-mcp/ft386-fields.sh <src>/shots.json KVNY KSJC KOAK KSMF`.
4. `git apply -R docs/plans/canvases/tc3d-386-facade-detail/prototype.patch` and check that `git status --short -- src/` prints nothing.

```bash
WT=X:/dev/towercab-3d.wt/tc3d-386/towercab-3d
PW=<a playwright-core 1.64.1 folder, e.g. from the npx cache of @playwright/mcp>
SRC=X:/dev/towercab-3d/.tmp/mocks/tc3d-386-facade-detail-src
pwsh -NoProfile -File $WT/tools/gate.ps1 run --cd "$WT" --log "$WT/.tmp/ft386-art-KSFO.log" --timeout 1800 --slot light -- \
  node X:/dev/towercab-3d/.playwright-mcp/ft386-run.cjs "$PW" "$SRC/shots.json" KSFO perf
```

In the run the stills were made from, the canopy look was then changed (the day "seen-through" emissive under the roof), and `reshoot.json` reshot the three canopy and carport stills and the office close-up with `ft386-fields.sh "$SRC/reshoot.json" KOAK KSJC KSFO`. With the committed patch, step 3 alone gives the same stills.

Every run reported its tiles settled. One gate run took 34 s to 258 s.

### Cameras and source buildings

The cameras and buildings are TC3D-376's (its `RECIPE.md`, "Source buildings and camera poses"): each camera sits `distM` from the building on the bearing from the building toward the tower eye (plus `turnDeg`), `heightM` above its ground, aimed at `aimM` above it. The close-ups add two cameras on the San Francisco Airport Marriott (way 24334778): `close-hotel-sfo` (HOTEL 11; Today is its OFFICE class) and `close-office-sfo` (forced OFFICE 4), both at 100 / 30 / 18 m, FOV 50. The fire-station close-up reuses LAFD Fire Station 114's TC3D-376 camera (70 m), since SFO Fire Station 1 is a 3 m box with no room for a door.

| Shot | Field | OSM way | Art-direction class |
|---|---|---|---|
| stair-smf | KSMF | 759869617 | GARAGE 1 |
| canopy-oak | KOAK | 468786430 | CARPORT 13 |
| tank-oak | KOAK | 1029079160 | TANK 12 |
| school-oak | KOAK | 348819789 | GENERIC 0 |
| wh-vny1, wh-vny2 | KVNY | 312880006, 312880003 | WAREHOUSE 9 |
| school-vny | KVNY | 430735535 | GENERIC 0 |
| fire-vny | KVNY | 430735719 | FIRE_STATION 10 |
| caravan-vny | KVNY | 429852462 | HOUSE 3, hash 3 |
| retail-sjc, retail-sjc2 | KSJC | 225010616, 225010615 | RETAIL 8 |
| apt-sjc | KSJC | 1257695492 | GENERIC 0 |
| carport-sjc | KSJC | 697249583 | CARPORT 13 |
| canopy-sjc | KSJC | 225007882 | CANOPY 7 |
| hotel-sjc | KSJC | 360669524 | HOTEL 11 |
| tank-sjc | KSJC | 219121137 | TANK 12 |
| util-sfo, util-sfo2 | KSFO | 586738087, 1155684933 | PLAIN 6 |
| apt-sfo | KSFO | 1041758863 | GENERIC 0 |
| hotel-sfo | KSFO | 24334778 | HOTEL 11 |
| bridge-sfo, bridge-sfo2 | KSFO | 933656604, 933656603 | TERMINAL 5 |
| fire-sfo | KSFO | 25373259 | FIRE_STATION 10 |
| close-hotel-sfo, close-office-sfo | KSFO | 24334778 | HOTEL 11, OFFICE 4 |

## 3. Stills, page and review copy

```bash
WT=X:/dev/towercab-3d.wt/tc3d-386/towercab-3d
SRC=X:/dev/towercab-3d/.tmp/mocks/tc3d-386-facade-detail-src
cd $SRC
uv run --no-project --with pillow python -I build_media.py $SRC X:/dev/towercab-3d/.playwright-mcp/ftshots386 X:/dev/towercab-3d/.tmp/mocks/tc3d-376-facade-types-src
uv run --no-project python -I gen_page.py shots.json $WT/docs/plans/canvases/tc3d-386-facade-detail/index.html
cp $WT/docs/plans/canvases/tc3d-386-facade-detail/index.html $SRC/
uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py $SRC/index.html X:/dev/towercab-3d/.tmp/mocks/tc3d-386-facade-detail
```

`build_media.py` crops each shot to x 80-1516, y 100-740 and scales it to 1,200 px wide, as TC3D-376's did, and copies the TC3D-376 Today and proposed stills the page reuses. `sheet.py` tiles stills into a contact sheet for review. The frame-time table on the page is typed from the `perf` lines of the two KSFO runs.

## Scripts

### `ft386-run.cjs`

```js
// TC3D-386 facade-detail mock driver (a copy of TC3D-376's ft-run.cjs): launches headless Edge (1600x900,
// --disable-extensions), filters the per-frame GPU console line, opens the airport, then runs ft386-init.js,
// ft-aim.js and ft386-shoot.js with the shots in <shots.json> under the airport's key, and, when the fourth
// argument is `perf`, ft386-perf.js for the frame-time readings at the tower's default view.
// Usage: node ft386-run.cjs <playwright-core dir> <shots.json> <ICAO> [perf]
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [pwDir, shotsFile, icao, perf] = process.argv.slice(2);
  const { chromium } = require(pwDir);
  const here = __dirname;
  const load = (name) => eval(fs.readFileSync(path.join(here, name), 'utf8'));
  const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'))[icao] ?? [];
  if (shots.length === 0 && perf !== 'perf') throw new Error(`no shots for ${icao} in ${shotsFile}`);
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-extensions'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.setDefaultTimeout(180000);
    await page.addInitScript(() => {
      const orig = console.log.bind(console);
      console.log = (...a) => {
        if (typeof a[0] === 'string' && a[0].startsWith('[GPU] Cesium renderer')) return;
        orig(...a);
      };
    });
    page.on('console', (m) => {
      // Query strings are cut, since a failed ion URL can carry a token.
      const text = m.text().replace(/\?\S*/g, '?…');
      if (text.startsWith('[ft]') || m.type() === 'error') console.log(`page ${m.type()}: ${text.slice(0, 200)}`);
    });
    page.on('pageerror', (e) => console.log(`pageerror: ${String(e.message).slice(0, 200)}`));
    let step = 'goto';
    const beat = setInterval(() => console.log(`still in ${step}`), 30000);
    const bounded = (name, ms, promise) => {
      step = name;
      console.log(`step ${name}`);
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} hung past ${ms} ms`)), ms)),
      ]);
    };
    try {
      await bounded('goto', 120000, page.goto(`http://localhost:5174/?airport=${icao}`, { waitUntil: 'domcontentloaded' }));
      console.log('init', JSON.stringify(await bounded('init', 300000, load('ft386-init.js')(page))));
      console.log('aim', JSON.stringify(await bounded('aim', 60000, load('ft-aim.js')(page))));
    } finally {
      clearInterval(beat);
    }
    await page.evaluate((s) => {
      window.__ftShots = s;
    }, shots);
    const out = await load('ft386-shoot.js')(page);
    for (const row of out) console.log('shot', JSON.stringify(row));
    if (perf === 'perf') console.log('perf', JSON.stringify(await load('ft386-perf.js')(page)));
  } finally {
    await browser.close();
  }
}

main().then(
  () => {
    console.log('ft386-run: done');
    // A leftover browser-connection handle kept node alive after close; exit explicitly.
    process.exit(0);
  },
  (e) => {
    console.log(`ft386-run: FAILED ${e && e.stack ? e.stack.slice(0, 600) : e}`);
    process.exit(1);
  },
);
```

### `ft386-init.js`

```js
async (page) => {
  // TC3D-386 facade-detail mock (a copy of TC3D-376's ft-init.js): buildings on (quality high), fixed 12:00,
  // clouds off, the building style's colour wrapped so window.__ft.ids get the facade class in window.__ft.cls
  // (null = as tagged, a number = that class, [class, hash] = that class and hash state), the airport from the
  // URL selected, then 12 s for the switch.
  console.log('[ft] bringToFront');
  await page.bringToFront();
  console.log('[ft] wait for __tc3d');
  await page.waitForFunction(() => window.__tc3d !== undefined, null, { timeout: 120000 });
  console.log('[ft] page ready');
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
  const icao = await page.evaluate(() => new URL(location.href).searchParams.get('airport') || 'KSFO');
  const out = await page.evaluate(async (icao) => {
    const t = window.__tc3d;
    t.stores.settings.getState().updateCesiumSettings({
      show3DBuildings: true,
      buildingQuality: 'high',
      timeMode: 'fixed',
      fixedTimeHour: 12,
    });
    // Live METAR weather froze the page at some fields and clouds drew across walls; all weather effects are off.
    t.stores.settings.getState().updateWeatherSettings({ showClouds: false, showWeatherEffects: false, showPrecipitation: false });
    const findTileset = () => {
      const prims = t.viewer.scene.primitives;
      for (let i = 0; i < prims.length; i++) {
        const p = prims.get(i);
        if (p && typeof p.makeStyleDirty === 'function' && p.tileLoad) return p;
      }
      return undefined;
    };
    let ts;
    for (let i = 0; i < 120 && !(ts = findTileset()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!ts) return { error: 'no tileset' };
    console.log('[ft] tileset found');
    window.__ft = { ids: new Set(), cls: null, findTileset };
    window.__ftWrap = () => {
      const tileset = findTileset();
      const col = tileset.style.color;
      if (!col.__ftWrapped) {
        const orig = col.evaluateColor.bind(col);
        col.evaluateColor = (f, result) => {
          const c = orig(f, result);
          const force = window.__ft;
          if (f !== undefined && force.cls !== null && force.ids.has(String(f.getProperty('elementId')))) {
            const [cls, forcedHash] = Array.isArray(force.cls) ? force.cls : [force.cls, null];
            const red = Math.round(c.red * 255);
            const hash = forcedHash ?? (255 - red) % 4;
            c.red = (255 - (cls * 4 + hash)) / 255;
          }
          return c;
        };
        col.evaluate = col.evaluateColor;
        col.__ftWrapped = true;
      }
      return tileset;
    };
    window.__ftSet = async (cls, frames = 10) => {
      window.__ft.cls = cls;
      window.__ftWrap().makeStyleDirty();
      for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    };
    const { useAirportStore } = await import('/stores/airportStore.ts');
    for (let i = 0; i < 120 && useAirportStore.getState().airports.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    useAirportStore.getState().selectAirport(icao);
    return { ok: true, icao };
  }, icao);
  console.log('[ft] selected', JSON.stringify(out));
  await page.waitForTimeout(12000);
  // A block, never `() => window.__ftWrap()`: returning the tileset froze the page (evaluate-returns-plain-values).
  await page.evaluate(() => {
    window.__ftWrap();
  });
  return out;
}
```

### `ft-aim.js`

```js
async (page) => {
  // Installs window.__ftAim(spec): moves the main camera (WASD offsets from the tower eye) to `distM`
  // from the building on the bearing from the building toward the tower (plus `turnDeg`), at `heightM`
  // above the building's ground, then aims it (lookAt for the heading) at `aimM` above that ground.
  return await page.evaluate(() => {
    const t = window.__tc3d;
    const R = 6371008.8;
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    window.__ftAim = async ({ lat, lon, distM, heightM, turnDeg = 0, aimM = 4, fov }) => {
      const vs = t.stores.viewport.getState();
      vs.resetPosition();
      await new Promise((r) => setTimeout(r, 800));
      const eye = t.viewer.camera.positionCartographic;
      const eyeLat = deg(eye.latitude);
      const eyeLon = deg(eye.longitude);
      const y = Math.sin(rad(eyeLon - lon)) * Math.cos(rad(eyeLat));
      const x = Math.cos(rad(lat)) * Math.sin(rad(eyeLat)) - Math.sin(rad(lat)) * Math.cos(rad(eyeLat)) * Math.cos(rad(eyeLon - lon));
      const bearing = (deg(Math.atan2(y, x)) + 360 + turnDeg) % 360;
      const camLat = lat + deg((distM * Math.cos(rad(bearing))) / R);
      const camLon = lon + deg((distM * Math.sin(rad(bearing))) / (R * Math.cos(rad(lat))));
      const north = rad(camLat - eyeLat) * R;
      const east = rad(camLon - eyeLon) * R * Math.cos(rad(eyeLat));
      const probe = eye.clone();
      probe.latitude = rad(lat);
      probe.longitude = rad(lon);
      probe.height = 0;
      const ground = t.viewer.scene.globe.getHeight(probe) ?? 0;
      vs.setPositionOffsetX(east);
      vs.setPositionOffsetY(north);
      vs.setPositionOffsetZ(ground + heightM - eye.height);
      await new Promise((r) => setTimeout(r, 800));
      t.lookAt(lat, lon, 0);
      await new Promise((r) => setTimeout(r, 2500));
      const cam = t.viewer.camera.positionCartographic;
      const pitch = deg(Math.atan2(ground + aimM - cam.height, distM));
      const c = t.camera.get();
      t.camera.set({ heading: c.heading, pitch, fov });
      await new Promise((r) => setTimeout(r, 1500));
      const p = t.viewer.camera.positionCartographic;
      return { bearing, ground, cam: { lat: deg(p.latitude), lon: deg(p.longitude), h: p.height }, ...t.camera.get() };
    };
    return { ok: true };
  });
}
```

### `ft386-shoot.js`

```js
async (page) => {
  // Shoots each building of window.__ftShots = [{ name, id, lat, lon, distM, heightM, aimM, fov, turnDeg, hours,
  // lanes: [[lane, cls]] }] (cls null = today's class, a number forces the class, [class, hash] forces both) and
  // writes ftshots386/{name}-{hour}-{lane}.png (1596x800 canvas clip). Only the shot's own element is forced.
  const dir = 'X:/dev/towercab-3d/.playwright-mcp/ftshots386/';
  const clip = { x: 2, y: 50, width: 1596, height: 800 };
  const settle = () =>
    page.evaluate(async () => {
      const ts = window.__ft.findTileset();
      const globe = window.__tc3d.viewer.scene.globe;
      let stable = 0;
      for (let i = 0; i < 180 && stable < 6; i++) {
        stable = ts.tilesLoaded && globe.tilesLoaded ? stable + 1 : 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      return stable >= 6;
    });
  const shots = await page.evaluate(() => window.__ftShots);
  const out = [];
  for (const shot of shots) {
    await page.evaluate((id) => {
      window.__ft.ids = new Set([id]);
    }, shot.id);
    for (const hour of shot.hours) {
      await page.evaluate((hour) => {
        window.__tc3d.stores.settings.getState().updateCesiumSettings({ fixedTimeHour: hour });
      }, hour);
      const pose = await page.evaluate((s) => window.__ftAim(s), shot);
      await page.waitForTimeout(2500);
      const settled = await settle();
      for (const [lane, cls] of shot.lanes) {
        await page.evaluate((cls) => window.__ftSet(cls, 10), cls);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${dir}${shot.name}-${hour}-${lane}.png`, clip });
      }
      await page.evaluate(() => window.__ftSet(null, 10));
      out.push({ name: shot.name, hour, settled, heading: +pose.heading.toFixed(1), pitch: +pose.pitch.toFixed(1), fov: pose.fov });
    }
  }
  return out;
}
```

### `ft386-perf.js`

```js
async (page) => {
  // Frame-time readings at the tower's default view: for 12:00 and 22:00, resets the camera, waits for the tiles
  // to settle and 300 more frames, then returns the median and p95 of totalFrame and cesiumDraw from
  // __tc3d.perf().window (CPU-side timings; the GPU timer reads 0 on this desktop). Plain numbers only.
  const out = [];
  for (const hour of [12, 22]) {
    const row = await page.evaluate(async (hour) => {
      const t = window.__tc3d;
      window.__ft.cls = null;
      t.stores.settings.getState().updateCesiumSettings({ fixedTimeHour: hour });
      t.stores.viewport.getState().resetPosition();
      const ts = window.__ft.findTileset();
      const globe = t.viewer.scene.globe;
      let stable = 0;
      for (let i = 0; i < 180 && stable < 6; i++) {
        stable = ts.tilesLoaded && globe.tilesLoaded ? stable + 1 : 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      for (let i = 0; i < 330; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      const w = t.perf().window;
      const pick = (k) => (w && w[k] ? { median: +w[k].median.toFixed(2), p95: +w[k].p95.toFixed(2) } : null);
      return { hour, settled: stable >= 6, totalFrame: pick('totalFrame'), cesiumDraw: pick('cesiumDraw'), frameInterval: pick('frameInterval') };
    }, hour);
    out.push(row);
  }
  return out;
}
```

### `ft386-fields.sh`

```bash
#!/bin/bash
# Shoots the given fields, one gate run each: ft386-fields.sh <shots.json> <ICAO>...
WT=X:/dev/towercab-3d.wt/tc3d-386/towercab-3d
PW=C:/Users/lefto/AppData/Local/npm-cache/_npx/13ab0715f9f30c2e/node_modules/playwright-core
SHOTS=$1
shift
for icao in "$@"; do
  pwsh -NoProfile -File "$WT/tools/gate.ps1" run --cd "$WT" --log "$WT/.tmp/ft386-art-$icao.log" --timeout 1800 --slot light -- \
    node X:/dev/towercab-3d/.playwright-mcp/ft386-run.cjs "$PW" "$SHOTS" "$icao" > "$WT/.tmp/gate-art-$icao.out" 2>&1
  echo "$icao rc=$? $(tail -n 1 "$WT/.tmp/gate-art-$icao.out")"
done
```

### `shots.json`

```json
{
 "KSMF": [
  {"name": "stair-smf", "id": "759869617", "lat": 38.69182, "lon": -121.58815, "distM": 35, "heightM": 12, "aimM": 1.5, "turnDeg": 180, "fov": 50, "hours": [12], "lanes": [["art", 1]]}
 ],
 "KOAK": [
  {"name": "canopy-oak", "id": "468786430", "lat": 37.71921, "lon": -122.22162, "distM": 50, "heightM": 12, "aimM": 1.5, "fov": 50, "turnDeg": 180, "hours": [12], "lanes": [["art", 13]]},
  {"name": "tank-oak", "id": "1029079160", "lat": 37.71368, "lon": -122.20316, "distM": 70, "heightM": 16, "aimM": 1.5, "fov": 40, "hours": [12], "lanes": [["art", 12]]},
  {"name": "school-oak", "id": "348819789", "lat": 37.72761, "lon": -122.23855, "distM": 55, "heightM": 12, "aimM": 3, "fov": 50, "hours": [12, 22], "lanes": [["art", 0]]}
 ],
 "KVNY": [
  {"name": "wh-vny1", "id": "312880006", "lat": 34.20967, "lon": -118.49299, "distM": 110, "heightM": 18, "aimM": 3, "fov": 50, "hours": [12], "lanes": [["art", 9]]},
  {"name": "wh-vny2", "id": "312880003", "lat": 34.20931, "lon": -118.49465, "distM": 80, "heightM": 16, "aimM": 5, "fov": 50, "hours": [12], "lanes": [["art", 9]]},
  {"name": "school-vny", "id": "430735535", "lat": 34.20808, "lon": -118.49328, "distM": 50, "heightM": 12, "aimM": 4, "fov": 50, "hours": [12, 22], "lanes": [["art", 0]]},
  {"name": "fire-vny", "id": "430735719", "lat": 34.21603, "lon": -118.49419, "distM": 70, "heightM": 14, "aimM": 4, "fov": 50, "hours": [12, 22], "lanes": [["art", 10]]},
  {"name": "caravan-vny", "id": "429852462", "lat": 34.20942, "lon": -118.49815, "distM": 30, "heightM": 8, "aimM": 2, "fov": 45, "hours": [12], "lanes": [["art", [3, 3]]]}
 ],
 "KSJC": [
  {"name": "retail-sjc", "id": "225010616", "lat": 37.35974, "lon": -121.93539, "distM": 90, "heightM": 14, "aimM": 3, "fov": 50, "hours": [12, 22], "lanes": [["art", 8]]},
  {"name": "apt-sjc", "id": "1257695492", "lat": 37.35614, "lon": -121.93412, "distM": 90, "heightM": 20, "aimM": 9, "fov": 50, "hours": [12, 22], "lanes": [["art", 0]]},
  {"name": "carport-sjc", "id": "697249583", "lat": 37.36393, "lon": -121.91717, "distM": 45, "heightM": 10, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 13]]},
  {"name": "canopy-sjc", "id": "225007882", "lat": 37.35622, "lon": -121.93853, "distM": 55, "heightM": 12, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 7]]},
  {"name": "retail-sjc2", "id": "225010615", "lat": 37.35944, "lon": -121.93477, "distM": 60, "heightM": 12, "aimM": 2.5, "fov": 50, "hours": [12, 22], "lanes": [["art", 8]]},
  {"name": "hotel-sjc", "id": "360669524", "lat": 37.36617, "lon": -121.91351, "distM": 150, "heightM": 30, "aimM": 10, "fov": 50, "hours": [12, 22], "lanes": [["art", 11]]},
  {"name": "tank-sjc", "id": "219121137", "lat": 37.38207, "lon": -121.9366, "distM": 45, "heightM": 14, "aimM": 5, "fov": 45, "hours": [12], "lanes": [["art", 12]]}
 ],
 "KSFO": [
  {"name": "util-sfo", "id": "586738087", "lat": 37.62576, "lon": -122.37634, "distM": 45, "heightM": 10, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 6]]},
  {"name": "apt-sfo", "id": "1041758863", "lat": 37.60034, "lon": -122.38528, "distM": 110, "heightM": 25, "aimM": 10, "fov": 50, "hours": [12, 22], "lanes": [["art", 0]]},
  {"name": "hotel-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 220, "heightM": 40, "aimM": 25, "fov": 50, "hours": [12, 22], "lanes": [["art", 11]]},
  {"name": "bridge-sfo", "id": "933656604", "lat": 37.61774, "lon": -122.38397, "distM": 50, "heightM": 15, "aimM": 2, "fov": 50, "hours": [12], "lanes": [["art", 5]]},
  {"name": "fire-sfo", "id": "25373259", "lat": 37.62406, "lon": -122.39312, "distM": 140, "heightM": 26, "aimM": 4, "fov": 35, "hours": [12, 22], "lanes": [["art", 10]]},
  {"name": "util-sfo2", "id": "1155684933", "lat": 37.61013, "lon": -122.39694, "distM": 70, "heightM": 14, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 6]]},
  {"name": "bridge-sfo2", "id": "933656603", "lat": 37.61747, "lon": -122.38322, "distM": 35, "heightM": 12, "aimM": 2, "fov": 50, "hours": [12], "lanes": [["art", 5]]},
  {"name": "close-hotel-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 100, "heightM": 30, "aimM": 18, "fov": 50, "hours": [12, 22], "lanes": [["art", 11]]},
  {"name": "close-office-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 100, "heightM": 30, "aimM": 18, "fov": 50, "hours": [12, 22], "lanes": [["art", 4]]}
 ]
}
```

### `closeups-today.json`

```json
{
 "KSFO": [
  {"name": "close-hotel-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 100, "heightM": 30, "aimM": 18, "fov": 50, "hours": [12, 22], "lanes": [["today", null]]}
 ]
}
```

### `reshoot.json`

```json
{
 "KOAK": [
  {"name": "canopy-oak", "id": "468786430", "lat": 37.71921, "lon": -122.22162, "distM": 50, "heightM": 12, "aimM": 1.5, "fov": 50, "turnDeg": 180, "hours": [12], "lanes": [["art", 13]]}
 ],
 "KSJC": [
  {"name": "carport-sjc", "id": "697249583", "lat": 37.36393, "lon": -121.91717, "distM": 45, "heightM": 10, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 13]]},
  {"name": "canopy-sjc", "id": "225007882", "lat": 37.35622, "lon": -121.93853, "distM": 55, "heightM": 12, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["art", 7]]}
 ],
 "KSFO": [
  {"name": "close-office-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 100, "heightM": 30, "aimM": 18, "fov": 50, "hours": [12, 22], "lanes": [["art", 4]]}
 ]
}
```

### `build_media.py`

```python
"""Builds the TC3D-386 facade-detail mock's stills.

Usage: uv run --no-project --with pillow python -I build_media.py <src dir> <shots dir> <tc3d-376 stills dir>

Crops every new shot named in <src dir>/shots.json and closeups-today.json ({name}-{hour}-{lane}.png, a
1596x800 canvas clip from ft386-shoot.js) to x 80-1516, y 100-740, scales it to 1,200 px wide and writes
{name}-{hour}-{lane}.jpg into <src dir>; then copies the TC3D-376 Today and proposed stills the page reuses.
"""

import json
import shutil
import sys
from pathlib import Path

from PIL import Image

CROP = (80, 100, 1516, 740)
WIDTH = 1200
# The TC3D-376 lane each section's "TC3D-376 proposed" column shows.
REUSED_LANES = {"apt-sjc": "generic", "apt-sfo": "generic", "hotel-sjc": "hotel", "hotel-sfo": "hotel"}


def shots_in(path: Path) -> list[dict]:
    return [shot for field in json.loads(path.read_text(encoding="utf-8")).values() for shot in field]


def main() -> None:
    src, shots_dir, old = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    count = total = 0
    for shot in shots_in(src / "shots.json") + shots_in(src / "closeups-today.json"):
        for hour in shot["hours"]:
            for lane, _cls in shot["lanes"]:
                stem = f"{shot['name']}-{hour}-{lane}"
                img = Image.open(shots_dir / f"{stem}.png").convert("RGB").crop(CROP)
                img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
                target = src / f"{stem}.jpg"
                img.save(target, quality=82, optimize=True, progressive=True)
                count += 1
                total += target.stat().st_size
    reused = 0
    for shot in shots_in(src / "shots.json"):
        if shot["name"].startswith("close-"):
            continue
        for hour in shot["hours"]:
            for lane in ("today", REUSED_LANES.get(shot["name"], "proposed")):
                shutil.copy2(old / f"{shot['name']}-{hour}-{lane}.jpg", src)
                reused += 1
    print(f"{count} new stills, {total} bytes; {reused} TC3D-376 stills copied")


if __name__ == "__main__":
    main()
```

### `sheet.py`

```python
"""Review aid: tiles the given shots (PNG canvas clips or cropped JPEGs) two across, 600 px wide each, into one JPEG.

Usage: uv run --no-project --with pillow python -I sheet.py <out.jpg> <shot>...
"""

import sys
from pathlib import Path

from PIL import Image

CROP = (80, 100, 1516, 740)
TILE_W = 600


def main() -> None:
    out, shots = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    tiles = []
    for shot in shots:
        img = Image.open(shot).convert("RGB")
        if shot.suffix == ".png":
            img = img.crop(CROP)
        tiles.append(img.resize((TILE_W, round(img.height * TILE_W / img.width)), Image.LANCZOS))
    cols = min(len(tiles), 2)
    rows = (len(tiles) + cols - 1) // cols
    th = tiles[0].height
    sheet = Image.new("RGB", (cols * TILE_W, rows * th), "black")
    for i, tile in enumerate(tiles):
        sheet.paste(tile, ((i % cols) * TILE_W, (i // cols) * th))
    sheet.save(out, quality=80)


if __name__ == "__main__":
    main()
```

### `gen_page.py`

```python
"""Writes the TC3D-386 facade-detail mock page from shots.json and the text below.

Usage: uv run --no-project python -I gen_page.py <shots.json> <out index.html>
"""

import html
import json
import sys
from pathlib import Path

GUIDE = "docs/plans/osm-facade-art-direction.md"

# (section id, title, buildings, TC3D-376 lane name, art-direction class, one line on the art lane)
SECTIONS = [
    ("canopy", "1. Canopy and carport", ["canopy-oak", "canopy-sjc"], "proposed", "CARPORT 13 (solar roof) / CANOPY 7 (fuel)",
     "Fuel canopy: a 0.9 m brand fascia (white, red, blue or yellow by hash) on a dark drip line, a light soffit in the top 15% and the far side seen through below, white posts every 8 m; the solar roof takes the carport look, a 0.3 m steel edge over a PV underside and thin galvanised posts (guide section 3, CANOPY; section 4, not a black box)."),
    ("warehouse", "2. Warehouse / industrial", ["wh-vny1", "wh-vny2"], "proposed", "WAREHOUSE 9",
     "Tilt-up panels with joints and reveals at 1/3 and 2/3, or ribbed metal (hash 1); dock doors 2.7 by 3.0 m at a 1.2 m sill in black shelters wider at the sides and top than the foot, a lamp over each, on walls of 6.1 m or more (section 3, WAREHOUSE; section 4, dock doors)."),
    ("retail", "3. Retail", ["retail-sjc", "retail-sjc2"], "proposed", "RETAIL 8",
     "Storefront on the ground storey only: split-face bulkhead, glass to 3.0 m with mullions and a transom at 2.4 m, 0.6 m tenant piers, one muted sign per tenant in a 1.2 m band, blank wall above; at night 70% of tenants lit warm-white at their own intensity and the signs glow (section 3, RETAIL; 2.6)."),
    ("utility", "4. Utility / service shed", ["util-sfo", "util-sfo2"], "proposed", "PLAIN 6",
     "Split-face block or painted metal with only a base band, coping and grime: a small blank structure (section 3, PLAIN; 2.4)."),
    ("apartments", "5. Apartments", ["apt-sjc", "apt-sfo"], "generic", "GENERIC 0",
     "The GENERIC grammar: 3.0 m bays, panes 0.45 of the bay by half a storey on a 0.3-storey sill, paired on hash 2, storeys fitted under a parapet (2.1, section 3, GENERIC)."),
    ("hotel", "6. Hotel", ["hotel-sjc", "hotel-sfo"], "hotel", "HOTEL 11",
     "One 1.5 m window per 3.8 m room, mirrored in pairs across the party walls, on a fitted storey grid; brick on the lower two storeys, a 4.8 m ground storey with lobby glass on a third of its bays, a lighter cornice; at night 50% lit in clusters, warm, 30% curtained (section 3, HOTEL; 2.1; 2.6)."),
    ("school", "7. School / civic", ["school-oak", "school-vny"], "proposed", "GENERIC 0",
     "GENERIC as above with a glazed entry in one ground bay in ten; schools are mostly one or two storeys, so the 3.4 m ground storey and 1.2 m parapet often leave one row (2.1, section 3, GENERIC)."),
    ("skybridge", "8. Skybridge", ["bridge-sfo", "bridge-sfo2"], "proposed", "TERMINAL 5",
     "A low box takes the skybridge form of TERMINAL: a glass band between two white 0.7 m beams, mullions every 1.5 m, coated glass with a Fresnel reflection (section 3, TERMINAL; 2.3)."),
    ("fire", "9. Fire station / ARFF", ["fire-vny", "fire-sfo"], "proposed", "FIRE_STATION 10",
     "4.3 m bay doors in a 0.25 m red surround between 0.8 m piers on the ground storey only, glazed sectional with a glass band (or solid red on hash 1), a header band above; a wall under 6.25 m has no room for a door and stays plain (section 3, FIRE_STATION)."),
    ("tank", "10. Storage tank", ["tank-oak", "tank-sjc"], "proposed", "TANK 12",
     "Shell-course lines every 2.4 m, a wind girder 0.6 m under the top over a shadow line, a darker rim, faint grime streaks from the top up close (section 3, TANK)."),
    ("rules", "Small rule additions", ["caravan-vny", "carport-sjc", "stair-smf"], "proposed", "HOUSE 3 hash 3, CARPORT 13, GARAGE 1",
     "The static-caravan variant on HOUSE hash 3 (white lap siding, a 0.1 m trim stripe at 1.6 m, a 0.6 m dark skirting), the carport look, and GARAGE decks fitted to the stair tower (section 3, HOUSE, CANOPY, GARAGE)."),
]

LABELS = {
    "canopy-oak": "KOAK solar roof", "canopy-sjc": "Costco Gasoline, KSJC", "wh-vny1": "KVNY industrial block",
    "wh-vny2": "KVNY warehouse", "retail-sjc": "Lexus of Stevens Creek, KSJC", "retail-sjc2": "KSJC retail",
    "util-sfo": "KSFO service building", "util-sfo2": "KSFO service building 2", "apt-sjc": "Orlo Apartments, KSJC",
    "apt-sfo": "Station 16, KSFO", "hotel-sjc": "KSJC airport hotel", "hotel-sfo": "SFO Airport Marriott",
    "school-oak": "KOAK school", "school-vny": "NVOC school, KVNY", "bridge-sfo": "KSFO skybridge",
    "bridge-sfo2": "KSFO skybridge 2", "fire-vny": "LAFD Fire Station 114, KVNY", "fire-sfo": "SFO Fire Station 1",
    "tank-oak": "KOAK storage tank", "tank-sjc": "KSJC storage tank", "caravan-vny": "KVNY static caravans",
    "carport-sjc": "KSJC carport", "stair-smf": "KSMF stair tower",
}

# (title, Today still stem, art still stem, note)
CLOSEUPS = [
    ("Hotel: SFO Airport Marriott at 100 m", "close-hotel-sfo-{h}-today", "close-hotel-sfo-{h}-art",
     "Today draws OFFICE ribbons on it; the art lane is HOTEL with frames, recesses, sills, rain streaks and PTAC grilles (Tier A at this range)."),
    ("Office: the Marriott forced OFFICE at 100 m", "close-hotel-sfo-{h}-today", "close-office-sfo-{h}-art",
     "Today is OFFICE (the Marriott's class today). Art direction: precast spandrels 0.42 of the storey, vision glass with mullions every 1.5 m, coated glass reflecting the ground and haze, whole floors lit or dark at night, cool-neutral."),
    ("Fire station: LAFD 114 at 70 m (the TC3D-376 camera)", "fire-vny-{h}-today", "fire-vny-{h}-art",
     "SFO Fire Station 1 is a 3 m box with no room for a door, so the KVNY station stands in. Today draws GARAGE by shape."),
]


def fig(stem: str, caption: str) -> str:
    return (f'<figure><img src="{stem}.jpg" alt="{html.escape(caption)}">'
            f"<figcaption>{html.escape(caption)}</figcaption></figure>")


def section(sec_id, title, names, old_lane, art_class, line, shots) -> str:
    rows = [f'<section id="{sec_id}">', f"<h2>{html.escape(title)}</h2>"]
    lanes = [("Today", "today", "What the app draws now (TC3D-376 still)."),
             (f"TC3D-376 proposed ({old_lane})", old_lane, "The TC3D-376 look (TC3D-376 still)."),
             (f"Art direction: {art_class}", "art", line)]
    for heading, lane, text in lanes:
        figs = []
        for n in names:
            lane_n = "proposed" if lane == "generic" and n not in ("apt-sjc", "apt-sfo") else lane
            lane_n = "proposed" if lane == "hotel" and n not in ("hotel-sjc", "hotel-sfo") else lane_n
            for hour in shots[n]["hours"]:
                figs.append(fig(f"{n}-{hour}-{lane_n}", f"{LABELS[n]}, {hour}:00"))
        grid = "four" if len(figs) >= 4 else ("three" if len(figs) == 3 else "two")
        rows += [f"<h3>{html.escape(heading)}</h3>", f'<p class="cap">{html.escape(text)}</p>',
                 f'<div class="{grid}">' + "".join(figs) + "</div>"]
    rows.append("</section>")
    return "\n".join(rows)


def closeups() -> str:
    rows = ['<section id="close">', "<h2>Close-ups: near-tier detail (Tier A, about 16 px per metre)</h2>",
            '<p class="cap">Today against Art direction, day and night, so frames, recess shadows, sills, blinds, rain streaks and PTAC grilles can be judged.</p>']
    for title, today, art, note in CLOSEUPS:
        figs = [fig(today.format(h=h), f"Today, {h}:00") for h in (12, 22)] + [fig(art.format(h=h), f"Art direction, {h}:00") for h in (12, 22)]
        rows += [f"<h3>{html.escape(title)}</h3>", f'<p class="cap">{html.escape(note)}</p>', '<div class="four">' + "".join(figs) + "</div>"]
    rows.append("</section>")
    return "\n".join(rows)


def main() -> None:
    shots_file, out = Path(sys.argv[1]), Path(sys.argv[2])
    shots = {s["name"]: s for field in json.loads(shots_file.read_text(encoding="utf-8")).values() for s in field}
    template = (Path(__file__).parent / "page_template.html").read_text(encoding="utf-8")
    toc = "\n".join(f'<li><a href="#{s[0]}">{html.escape(s[1])}</a></li>' for s in SECTIONS)
    body = closeups() + "\n\n" + "\n\n".join(section(*s, shots) for s in SECTIONS)
    page = template.replace("{{TOC}}", toc).replace("{{SECTIONS}}", body).replace("{{GUIDE}}", GUIDE)
    out.write_text(page, encoding="utf-8", newline="\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
```

### `page_template.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TC3D-386: facade art direction prototype</title>
<style>
  :root {
    --bg: #f6f6f3;
    --panel: #ffffff;
    --text: #1d1f22;
    --muted: #5d636b;
    --rule: #d9dbdf;
    --accent: #0b6bcb;
    --note-bg: #fff6dc;
    --note-rule: #e8c766;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #131518;
      --panel: #1b1e22;
      --text: #e7e9ec;
      --muted: #9aa1aa;
      --rule: #30353b;
      --accent: #6cb4ff;
      --note-bg: #2b2616;
      --note-rule: #7a6420;
    }
  }
  :root[data-theme="dark"] {
    --bg: #131518;
    --panel: #1b1e22;
    --text: #e7e9ec;
    --muted: #9aa1aa;
    --rule: #30353b;
    --accent: #6cb4ff;
    --note-bg: #2b2616;
    --note-rule: #7a6420;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1800px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.25rem; margin: 0 0 6px; }
  h3 { font-size: 1rem; margin: 18px 0 2px; }
  p, li { max-width: 1150px; }
  .sub { color: var(--muted); margin: 0 0 16px; }
  .note { background: var(--note-bg); border-left: 4px solid var(--note-rule); border-radius: 4px; padding: 10px 14px; margin: 0 0 16px; max-width: 1200px; }
  a { color: var(--accent); }
  .toc { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 24px; padding: 0; list-style: none; }
  .toc a { text-decoration: none; }
  section { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 16px; margin: 0 0 22px; }
  .cap { color: var(--muted); margin: 0 0 8px; font-size: 0.92rem; }
  .bld { font-size: 0.88rem; margin: 0 0 6px; }
  .two, .three, .four { display: grid; gap: 12px; align-items: start; }
  .two { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 1300px; }
  .three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  figure { margin: 0; }
  figure img { display: block; width: 100%; height: auto; border-radius: 4px; border: 1px solid var(--rule); background: #000; }
  figcaption { font-size: 0.88rem; margin: 6px 0 0; }
  figcaption b { display: block; font-size: 0.95rem; }
  table { border-collapse: collapse; font-size: 0.9rem; }
  td, th { border: 1px solid var(--rule); padding: 4px 10px; text-align: left; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 0.9em; }
  @media (max-width: 1100px) {
    .three, .four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .two, .three, .four { grid-template-columns: minmax(0, 1fr); }
  }
</style>
</head>
<body>
<main>
<h1>TC3D-386: the facade art direction, prototyped</h1>
<p class="sub">OSM Buildings facades, branch <code>tc3d-386</code> from <code>feat/osm-facades</code> a36d2fd, with the TC3D-376 prototype applied under this one. Headless Edge, Vite dev server (<code>vite:headless</code>), 1596×800 canvas, building quality high, weather effects and clouds off. Day stills at 12:00, night stills at 22:00 local. The spec is the art-direction guide, <code>{{GUIDE}}</code>.</p>

<div class="note">
<p><b>The question.</b> Does the guide's look answer "really basic, and not beautiful / detailed enough" and "windows cut off at the bottom or top of the building"? Every section shows the TC3D-376 buildings from the TC3D-376 cameras in three lanes:</p>
<ul>
<li><b>Today</b>: what the app draws now (the TC3D-376 still).</li>
<li><b>TC3D-376 proposed</b>: that mock's look for the building (the TC3D-376 still).</li>
<li><b>Art direction</b>: new. A throwaway shader (<code>prototype.patch</code> beside this page, not code that will land) draws the guide's section 5 items 1-6 for every class, then each class's one-glance read from section 3, forced on the shot's one building as in TC3D-376.</li>
</ul>
<p>What every Art-direction still carries: <b>vertical fitting</b> (a 0.45 m base band, a ground storey, whole storeys stretched to fit, a parapet of at least 1.2 m, so no window is cut by the roof line or the ground; 2.1), <b>clustered, varied lit windows</b> at night (2.6), <b>grime and contact darkening</b> at the foot (2.4), <b>glass as an interior behind a Fresnel sky reflection</b> with blinds (2.3), <b>tint jitter</b> per building (2.4), and <b>frames, recess shadows and sills</b>, with mullions, rain streaks and PTAC grilles only up close (2.2).</p>
<p><b>The wall top is approximate.</b> The shader still reads the wall height from the packed 2 m bucket, so storeys are fitted under the bucket's lower bound with the guide's 1.2 m parapet, and the coping is drawn at the bucket's centre, up to 1 m off the true roof edge. The exact top from geometry is TC3D-388's work.</p>
</div>

<ul class="toc">
<li><a href="#close">Close-ups</a></li>
{{TOC}}
<li><a href="#perf">Frame time</a></li>
<li><a href="#approx">What is approximate, and guide values not hit</a></li>
</ul>

{{SECTIONS}}

<section id="perf">
<h2>Frame time (CPU-side, not a GPU measurement)</h2>
<p class="cap">The GPU timer reads 0 on this desktop, so these are <code>__tc3d.perf().window</code> medians and p95 over 300 frames of <code>totalFrame</code> and <code>cesiumDraw</code>, in ms, at the KSFO tower's default view after the tiles settled, in headless Edge with the frame interval capped at 16.7 ms. They time the CPU side of each frame (command submission), not the fragment work this prototype adds; one reading each, so treat a 1 ms difference as noise until the harness in <code>osm-buildings.md</code> measures it on a GPU timer.</p>
<table>
<tr><th>Build</th><th>Hour</th><th>totalFrame median / p95</th><th>cesiumDraw median / p95</th></tr>
<tr><td>Without the prototype (feat/osm-facades a36d2fd)</td><td>12:00</td><td>6.5 / 8.0</td><td>6.2 / 7.7</td></tr>
<tr><td>Without the prototype</td><td>22:00</td><td>7.1 / 8.3</td><td>6.8 / 7.9</td></tr>
<tr><td>With the prototype (TC3D-376 + art direction)</td><td>12:00</td><td>7.9 / 9.0</td><td>7.6 / 8.7</td></tr>
<tr><td>With the prototype</td><td>22:00</td><td>7.6 / 8.5</td><td>7.3 / 8.2</td></tr>
</table>
</section>

<section id="approx">
<h2>What is approximate, and guide values not hit</h2>
<ul>
<li><b>Face ends are not known</b> (2.1, 2.5, section 5 item 8, TC3D-385). Windows, bays and doors still run along each face from an arbitrary origin, so a face end can show a partial bay at a corner or a part seam, the fire-station doors run round every face including narrow returns, and there are no corner piers, no crew wing at one end, no hangar door, no docks on one face only, no house porch light per face.</li>
<li><b>Short walls lose rows.</b> With the bucket's lower bound, a 0.45 m base, the class's ground storey and a 1.2 m parapet, a two-storey school or office often fits only its ground storey; a wall under 4.2 m (most 3 m boxes) shows no windows at all, and a fire station under 6.25 m no doors (SFO Fire Station 1).</li>
<li><b>Darker walls are the guide's palette.</b> Split-face block <code>#A39A8C</code> and brick read far darker than the TC3D-376 tones; the walls in these cameras also face away from the noon sun.</li>
<li><b>Glass targets are not measured</b> (2.3: L* 45-62 at 1 km, 15-32 within 300 m): the cameras are 30-220 m away and no L* was read from the stills.</li>
<li><b>Tint jitter</b> is drawn from a hash of the lookup's ground point, so it changes when a tile reloads at another level of detail, and the parts of one building jitter apart.</li>
<li><b>The far tint</b> folds base band, grime and coping in as one constant (0.95); lit-window clustering lowers the near lit share below the far tint's, so a tier change at night is not yet mean-preserving. The far path is unchanged otherwise.</li>
<li><b>Left out:</b> the skybridge's ribbed-panel variant (hash 2), the hangar's small windows on other faces, the tank's obstruction lamp, the hotel's brick-panel variant and core tower, the garage stair core, generic schools' near-dark night share, and the low-sun warm haze is only sketched.</li>
<li><b>Canopy undersides by day</b> add a small emissive for the lit ground seen through and the soffit's bounce, a value the guide does not give.</li>
<li><b>No rule exists yet.</b> Each lane forces its class on the shot's one element; the cameras are 30-220 m from each building, not the tower view; geometry is the tileset's (canopies and skybridges are solid boxes); at 22:00 the imagery stays bright.</li>
<li><b>Flat walls with no lookup.</b> A tile without the base lookup draws the far tint (Orlo Apartments in these cameras), as today.</li>
</ul>
</section>

<p class="sub">Rebuild: <code>RECIPE.md</code> beside this page. The stills live only in the review copy.</p>
</main>
</body>
</html>
```
