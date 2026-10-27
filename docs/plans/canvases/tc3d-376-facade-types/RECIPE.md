# TC3D-376 phase 2 mock: facade looks for more OSM building types

The page beside this file shows, for each candidate of the phase-1 survey (ranks 1-10: canopy, warehouse, retail, utility shed, apartments, hotel, school/civic, skybridge, fire station/ARFF, storage tank) and the three small rule additions (static_caravan to HOUSE, carports to canopy, staircase to GARAGE), two real buildings in lanes: Today, and the proposed look.

Hotels get OFFICE, GENERIC and a HOTEL prototype beside Today; apartments get GENERIC beside Today (HOUSE, the survey's proposal). Day stills at 12:00, night stills at 22:00 for hotel, retail, fire station, apartments and school.

- **Forced classes** (an existing class forced on one element through the tileset style's colour, the TC3D-218 fire-station method): utility PLAIN, apartments GENERIC, hotel OFFICE and GENERIC, school GENERIC, skybridge TERMINAL, static_caravan HOUSE, staircase GARAGE.
- **Prototypes** (a new class id and a shader branch, in `prototype.patch`): CANOPY 7 (canopy and carport), RETAIL 8, WAREHOUSE 9, FIRE_STATION 10, HOTEL 11, TANK 12.

## Media

The 74 stills (JPEG, 1,200 px wide) total 5.1 MB, so only `index.html`, this recipe and `prototype.patch` are committed. The stills live in the untracked source folder `.tmp/mocks/tc3d-376-facade-types-src/` of the `tc3d-376` worktree, and in the review copy built from it. Every script the steps below run is reproduced at the end of this file; save each under the name its heading gives.

## 1. Prototype and dev API

From the worktree root (`X:\dev\towercab-3d.wt\tc3d-376\towercab-3d`, branch `tc3d-376`):

```powershell
git apply docs/plans/canvases/tc3d-376-facade-types/prototype.patch   # adds class ids 7-12 and their shader branch
pnpm run vite:headless                                                  # port 5174, in the background; stop it when done
curl http://localhost:5174/api/dev-health                               # needs ionToken: true
```

Follow CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules. When done: stop Vite, then `git apply -R docs/plans/canvases/tc3d-376-facade-types/prototype.patch` and check that `git status --short -- src/` prints nothing.

## 2. Shoot

The stills were shot with `ft-run.cjs`, a Node driver that stands in for the `playwright-headless` MCP server: it launches headless Edge (playwright-core 1.64.1, `channel: 'msedge'`, 1600×900, `--disable-extensions`), filters the per-frame `[GPU] Cesium renderer` console line and runs `ft-init.js`, `ft-aim.js` and `ft-shoot.js`, the same page functions the MCP's run-code tool takes.

Save the four scripts in `X:\dev\towercab-3d\.playwright-mcp\` (gitignored) and create `.playwright-mcp\ftshots\`; save `shots.json` in the source folder. One field per gate run:

```bash
WT=X:/dev/towercab-3d.wt/tc3d-376/towercab-3d
PW=<a playwright-core 1.64.1 folder, e.g. from the npx cache of @playwright/mcp>
for icao in KVNY KOAK KSJC KSFO KSMF; do
  pwsh -NoProfile -File X:/dev/towercab-3d/tools/gate.ps1 run --cd "$WT" --log "$WT/.tmp/ft-$icao.log" --timeout 1500 --slot light -- \
    node X:/dev/towercab-3d/.playwright-mcp/ft-run.cjs "$PW" "$WT/.tmp/mocks/tc3d-376-facade-types-src/shots.json" "$icao"
done
```

Each run writes `ftshots/{name}-{hour}-{lane}.png` (1596×800 canvas clip) for that field's shots. `ft-init.js` turns clouds, precipitation and weather effects off: live METAR weather drew clouds across the walls. Never return a live engine object (tileset, viewer, scene, store state) from a `page.evaluate`: copying the OSM tileset out of the page ran the page out of memory (rule `evaluate-returns-plain-values` in `docs/DRIVING_CONVENTIONS.md`).

### Source buildings and camera poses

Each camera sits `distM` from the building on the bearing from the building toward the tower eye (plus `turnDeg`), `heightM` above the building's ground, aimed (heading from `lookAt`) at `aimM` above that ground. Heading and pitch are what the runs returned; every run reported its tiles settled.

| Shot | Field | OSM way | Building | distM / heightM / aimM / turnDeg | Heading | Pitch | FOV |
|---|---|---|---|---|---:|---:|---:|
| stair-smf | KSMF | 759869617 | building=staircase | 35 / 12 / 1.5 / 180 | 241.3 | -16.7 | 50 |
| canopy-oak | KOAK | 468786430 | solar roof at the tower's foot | 50 / 12 / 1.5 / 180 | 313.3 | -11.9 | 50 |
| tank-oak | KOAK | 1029079160 | storage tank | 70 / 16 / 1.5 / 0 | 111.3 | -11.7 | 40 |
| school-oak | KOAK | 348819789 | school | 55 / 12 / 3 / 0 | 301.8 | -9.3 | 50 |
| wh-vny1 | KVNY | 312880006 | building=industrial | 110 / 18 / 3 / 0 | 335.8 | -7.8 | 50 |
| wh-vny2 | KVNY | 312880003 | building=warehouse | 80 / 16 / 5 / 0 | 305.8 | -7.8 | 50 |
| school-vny | KVNY | 430735535 | NVOC Aviation Mechanic School | 50 / 12 / 4 / 0 | 289.7 | -9.1 | 50 |
| fire-vny | KVNY | 430735719 | LAFD Fire Station 114 | 70 / 14 / 4 / 0 | 347.2 | -8.1 | 50 |
| caravan-vny | KVNY | 429852462 | building=static_caravan | 30 / 8 / 2 / 0 | 288.7 | -11.3 | 45 |
| retail-sjc | KSJC | 225010616 | Lexus of Stevens Creek | 90 / 14 / 3 / 0 | 271.5 | -7 | 50 |
| apt-sjc | KSJC | 1257695492 | Orlo Apartments | 90 / 20 / 9 / 0 | 209.3 | -7 | 50 |
| carport-sjc | KSJC | 697249583 | carport | 45 / 10 / 1.5 / 0 | 69.6 | -10.7 | 50 |
| canopy-sjc | KSJC | 225007882 | Costco Gasoline | 55 / 12 / 1.5 / 0 | 237.9 | -10.8 | 50 |
| retail-sjc2 | KSJC | 225010615 | retail | 60 / 12 / 2.5 / 0 | 264.9 | -9 | 50 |
| hotel-sjc | KSJC | 360669524 | hotel | 150 / 30 / 10 / 0 | 65.7 | -7.6 | 50 |
| tank-sjc | KSJC | 219121137 | storage tank | 45 / 14 / 5 / 0 | 350 | -11.3 | 45 |
| util-sfo | KSFO | 586738087 | building=service | 45 / 10 / 1.5 / 0 | 30.7 | -10.7 | 50 |
| apt-sfo | KSFO | 1041758863 | Station 16 | 110 / 25 / 10 / 0 | 184.3 | -7.8 | 50 |
| hotel-sfo | KSFO | 24334778 | San Francisco Airport Marriott | 220 / 40 / 25 / 0 | 141.4 | -3.9 | 50 |
| bridge-sfo | KSFO | 933656604 | skybridge | 50 / 15 / 2 / 0 | 356.7 | -14.6 | 50 |
| fire-sfo | KSFO | 25373259 | SFO Fire Station 1 | 140 / 26 / 4 / 0 | 318.4 | -8.9 | 35 |
| util-sfo2 | KSFO | 1155684933 | building=service | 70 / 14 / 1.5 / 0 | 241.4 | -10.1 | 50 |
| bridge-sfo2 | KSFO | 933656603 | skybridge | 35 / 12 / 2 / 0 | 15.9 | -15.9 | 50 |

## 3. Stills and review copy

```bash
WT=X:/dev/towercab-3d.wt/tc3d-376/towercab-3d
SRC=$WT/.tmp/mocks/tc3d-376-facade-types-src
cp $WT/docs/plans/canvases/tc3d-376-facade-types/index.html $SRC/
cd $SRC && uv run --no-project --with pillow python -I build_media.py shots.json X:/dev/towercab-3d/.playwright-mcp/ftshots $SRC
uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py $SRC/index.html $WT/.tmp/mocks/tc3d-376-facade-types
```

`build_media.py` crops each shot to x 80-1516, y 100-740 and scales it to 1,200 px wide. The page itself was generated by `gen_page.py` from `page_template.html` in the source folder; the committed `index.html` is its output, so a rebuild of the stills does not need them.

## Scripts

### `ft-run.cjs`

```js
// TC3D-376 facade-types mock driver, standing in for the playwright-headless MCP server: launches headless
// Edge (1600x900, --disable-extensions), filters the per-frame GPU console line, opens the airport, then runs
// ft-init.js, ft-aim.js and ft-shoot.js (the same page functions the MCP's run-code tool takes) with the
// shots in <shots.json> under the airport's key.
// Usage: node ft-run.cjs <playwright-core dir> <shots.json> <ICAO>
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [pwDir, shotsFile, icao] = process.argv.slice(2);
  const { chromium } = require(pwDir);
  const here = __dirname;
  const load = (name) => eval(fs.readFileSync(path.join(here, name), 'utf8'));
  const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf8'))[icao];
  if (!shots) throw new Error(`no shots for ${icao} in ${shotsFile}`);
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
      console.log('init', JSON.stringify(await bounded('init', 300000, load('ft-init.js')(page))));
      console.log('aim', JSON.stringify(await bounded('aim', 60000, load('ft-aim.js')(page))));
    } finally {
      clearInterval(beat);
    }
    await page.evaluate((s) => {
      window.__ftShots = s;
    }, shots);
    const out = await load('ft-shoot.js')(page);
    for (const row of out) console.log('shot', JSON.stringify(row));
  } finally {
    await browser.close();
  }
}

main().then(
  () => {
    console.log('ft-run: done');
    // A leftover browser-connection handle kept node alive after close; exit explicitly.
    process.exit(0);
  },
  (e) => {
    console.log(`ft-run: FAILED ${e && e.stack ? e.stack.slice(0, 600) : e}`);
    process.exit(1);
  },
);
```

### `ft-init.js`

```js
async (page) => {
  // TC3D-376 facade-types mock: console filter for the per-frame GPU line, buildings on (quality high),
  // fixed 12:00, clouds off, the building style's colour wrapped so window.__ft.ids get the facade class
  // in window.__ft.cls (null = as tagged), the airport from the URL selected, then 12 s for the switch.
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
    // Live METAR weather froze the page at some fields (KSMF, KHWD, KLAX) and clouds drew across walls;
    // the mock compares walls, so all weather effects are off.
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
            const red = Math.round(c.red * 255);
            const hash = (255 - red) % 4;
            c.red = (255 - (force.cls * 4 + hash)) / 255;
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

### `ft-shoot.js`

```js
async (page) => {
  // Shoots each building of window.__ftShots = [{ name, id, lat, lon, distM, heightM, aimM, fov, turnDeg, hours,
  // lanes: [[lane, cls]] }] (cls null = today's class) and writes ftshots/{name}-{hour}-{lane}.png
  // (1596x800 canvas clip). Only the shot's own element is forced.
  const dir = 'X:/dev/towercab-3d/.playwright-mcp/ftshots/';
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
      await page.evaluate((hour) => window.__tc3d.stores.settings.getState().updateCesiumSettings({ fixedTimeHour: hour }), hour);
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

### `shots.json`

```json
{
 "KSMF": [
  {"name": "stair-smf", "id": "759869617", "lat": 38.69182, "lon": -121.58815, "distM": 35, "heightM": 12, "aimM": 1.5, "turnDeg": 180, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 1]]}
 ],
 "KOAK": [
  {"name": "canopy-oak", "id": "468786430", "lat": 37.71921, "lon": -122.22162, "distM": 50, "heightM": 12, "aimM": 1.5, "fov": 50, "turnDeg": 180, "hours": [12], "lanes": [["today", null], ["proposed", 7]]},
  {"name": "tank-oak", "id": "1029079160", "lat": 37.71368, "lon": -122.20316, "distM": 70, "heightM": 16, "aimM": 1.5, "fov": 40, "hours": [12], "lanes": [["today", null], ["proposed", 12]]},
  {"name": "school-oak", "id": "348819789", "lat": 37.72761, "lon": -122.23855, "distM": 55, "heightM": 12, "aimM": 3, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["proposed", 0]]}
 ],
 "KVNY": [
  {"name": "wh-vny1", "id": "312880006", "lat": 34.20967, "lon": -118.49299, "distM": 110, "heightM": 18, "aimM": 3, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 9]]},
  {"name": "wh-vny2", "id": "312880003", "lat": 34.20931, "lon": -118.49465, "distM": 80, "heightM": 16, "aimM": 5, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 9]]},
  {"name": "school-vny", "id": "430735535", "lat": 34.20808, "lon": -118.49328, "distM": 50, "heightM": 12, "aimM": 4, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["proposed", 0]]},
  {"name": "fire-vny", "id": "430735719", "lat": 34.21603, "lon": -118.49419, "distM": 70, "heightM": 14, "aimM": 4, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["proposed", 10]]},
  {"name": "caravan-vny", "id": "429852462", "lat": 34.20942, "lon": -118.49815, "distM": 30, "heightM": 8, "aimM": 2, "fov": 45, "hours": [12], "lanes": [["today", null], ["proposed", 3]]}
 ],
 "KSJC": [
  {"name": "retail-sjc", "id": "225010616", "lat": 37.35974, "lon": -121.93539, "distM": 90, "heightM": 14, "aimM": 3, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["proposed", 8]]},
  {"name": "apt-sjc", "id": "1257695492", "lat": 37.35614, "lon": -121.93412, "distM": 90, "heightM": 20, "aimM": 9, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["generic", 0]]},
  {"name": "carport-sjc", "id": "697249583", "lat": 37.36393, "lon": -121.91717, "distM": 45, "heightM": 10, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 7]]},
  {"name": "canopy-sjc", "id": "225007882", "lat": 37.35622, "lon": -121.93853, "distM": 55, "heightM": 12, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 7]]},
  {"name": "retail-sjc2", "id": "225010615", "lat": 37.35944, "lon": -121.93477, "distM": 60, "heightM": 12, "aimM": 2.5, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["proposed", 8]]},
  {"name": "hotel-sjc", "id": "360669524", "lat": 37.36617, "lon": -121.91351, "distM": 150, "heightM": 30, "aimM": 10, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["office", 4], ["generic", 0], ["hotel", 11]]},
  {"name": "tank-sjc", "id": "219121137", "lat": 37.38207, "lon": -121.9366, "distM": 45, "heightM": 14, "aimM": 5, "fov": 45, "hours": [12], "lanes": [["today", null], ["proposed", 12]]}
 ],
 "KSFO": [
  {"name": "util-sfo", "id": "586738087", "lat": 37.62576, "lon": -122.37634, "distM": 45, "heightM": 10, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 6]]},
  {"name": "apt-sfo", "id": "1041758863", "lat": 37.60034, "lon": -122.38528, "distM": 110, "heightM": 25, "aimM": 10, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["generic", 0]]},
  {"name": "hotel-sfo", "id": "24334778", "lat": 37.60222, "lon": -122.37017, "distM": 220, "heightM": 40, "aimM": 25, "fov": 50, "hours": [12, 22], "lanes": [["today", null], ["office", 4], ["generic", 0], ["hotel", 11]]},
  {"name": "bridge-sfo", "id": "933656604", "lat": 37.61774, "lon": -122.38397, "distM": 50, "heightM": 15, "aimM": 2, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 5]]},
  {"name": "fire-sfo", "id": "25373259", "lat": 37.62406, "lon": -122.39312, "distM": 140, "heightM": 26, "aimM": 4, "fov": 35, "hours": [12, 22], "lanes": [["today", null], ["proposed", 10]]},
  {"name": "util-sfo2", "id": "1155684933", "lat": 37.61013, "lon": -122.39694, "distM": 70, "heightM": 14, "aimM": 1.5, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 6]]},
  {"name": "bridge-sfo2", "id": "933656603", "lat": 37.61747, "lon": -122.38322, "distM": 35, "heightM": 12, "aimM": 2, "fov": 50, "hours": [12], "lanes": [["today", null], ["proposed", 5]]}
 ]
}
```

### `build_media.py`

```python
"""Crops the TC3D-376 facade-types shots into the page's stills.

Usage: uv run --no-project --with pillow python -I build_media.py <shots.json> <shots dir> <out dir>

For every shot, hour and lane in shots.json it reads {name}-{hour}-{lane}.png (a 1596x800 canvas clip from
ft-shoot.js), crops it to x 80-1516, y 100-740, scales it to 1,200 px wide and writes {name}-{hour}-{lane}.jpg.
"""

import json
import sys
from pathlib import Path

from PIL import Image

CROP = (80, 100, 1516, 740)
WIDTH = 1200


def main() -> None:
    shots_file, shots_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    count = total = 0
    for shots in json.loads(shots_file.read_text(encoding="utf-8")).values():
        for shot in shots:
            for hour in shot["hours"]:
                for lane, _cls in shot["lanes"]:
                    stem = f"{shot['name']}-{hour}-{lane}"
                    img = Image.open(shots_dir / f"{stem}.png").convert("RGB").crop(CROP)
                    img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
                    target = out_dir / f"{stem}.jpg"
                    img.save(target, quality=82, optimize=True, progressive=True)
                    count += 1
                    total += target.stat().st_size
    print(f"{count} stills, {total} bytes")


if __name__ == "__main__":
    main()
```
