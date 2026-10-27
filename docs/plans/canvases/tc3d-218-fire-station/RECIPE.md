# TC3D-218 step 4 mock: which facade does a fire station get?

`amenity=fire_station` (and `building=fire_station`) becomes a class rule in `CLASS_RULES` (`src/renderer/utils/buildingStyle.ts`). The page beside this file shows the four candidate classes, one lane each, on the same three fire stations from the same camera per building: SFO Fire Station 1 (way 25373259), SFO Fire Station 2 (way 157225049) and Oakland Fire Station No. 22 (way 468777914), at 12:00, plus SFO Fire Station 1 at 22:00 for the lit windows.

- **HANGAR**: ribbed grey cladding in wide panels, no windows; dark at night.
- **OFFICE**: continuous dark window bands with mullions; several bays lit at night.
- **PLAIN**: a flat tan wall with no openings; dark brown at night, no lights.
- **GENERIC**: one row of punched square windows, today's look for an untagged building; some windows lit at night.

## Media

The page's 16 stills (JPEG, 1,200 px wide) total 1.4 MB, so only the page and this recipe are committed. The stills live in the review copy, built from the untracked source folder `.tmp/mocks/tc3d-218-fire-station-src/` of the `feat/osm-facades` worktree. Every script the steps below run is reproduced at the end of this file; save each under the name its heading gives.

Nothing is patched: each class is forced from the page by wrapping the tileset style's colour (`fire-init.js`), against `feat/osm-facades` at 0fc2ea1.

## 1. Dev API

```powershell
cd X:\dev\towercab-3d.wt\feat-osm-facades\towercab-3d
pnpm run vite:headless                        # port 5174, run in the background, stop it when done
curl http://localhost:5174/api/dev-health     # needs ionToken: true
```

Follow CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules. Drive the page with the `playwright-headless` MCP server. Its run-code tool reads a script from a file only under `X:\dev\towercab-3d`, so save the three `fire-*.js` scripts in `X:\dev\towercab-3d\.playwright-mcp\` (gitignored) and create `.playwright-mcp\fireshots\`.

The app logs `[GPU] Cesium renderer=...` on every frame in this build; over a long session the MCP server stopped answering after an airport switch. Before each navigation, filter that line out with `browser_run_code_unsafe`:

```js
async (page) => { await page.addInitScript(() => { const orig = console.log.bind(console); console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[GPU] Cesium renderer')) return; orig(...a); }; }); await page.goto('http://localhost:5174/?airport=KSFO'); return page.url(); }
```

## 2. Shoot KSFO, then KOAK

1. Navigate to `http://localhost:5174/?airport=KSFO` (with the filter above).
2. `browser_run_code_unsafe` with `filename` `.playwright-mcp/fire-init.js`: buildings on (quality high), fixed 12:00, clouds off, the style colour wrapped, the airport from the URL selected, then 12 s for the airport switch.
3. `browser_run_code_unsafe` with `.playwright-mcp/fire-aim.js`: installs `window.__fireAim`.
4. `browser_evaluate`:

   ```js
   () => { window.__fire.ids = new Set(['25373259','157225049','468777914']); window.__fireShots = [ { name: 'sfo1', lat: 37.62406, lon: -122.39312, distM: 140, heightM: 26, aimM: 4, fov: 35, hours: [12, 22] }, { name: 'sfo2', lat: 37.62545, lon: -122.37709, distM: 85, heightM: 14, aimM: 3, fov: 50, turnDeg: 30, hours: [12] } ]; return 2; }
   ```

5. `browser_run_code_unsafe` with `.playwright-mcp/fire-shoot.js`. It writes `fireshots/{shot}-{hour}-{hangar,office,plain,generic}.png` (1596×800 canvas clip).
6. Repeat 1-5 with `KOAK` and `window.__fireShots = [ { name: 'oak22', lat: 37.71428, lon: -122.22221, distM: 130, heightM: 14, aimM: 2, fov: 50, turnDeg: 35, hours: [12] } ]` (the ids line as in step 4).

The camera poses the run returned: SFO Fire Station 1 heading 318.4, pitch −8.9, FOV 35; SFO Fire Station 2 heading 59.2, pitch −7.4, FOV 50; Oakland Fire Station No. 22 heading 217.3, pitch −5.3, FOV 50.

## 3. Stills and review copy

```bash
WT=X:/dev/towercab-3d.wt/feat-osm-facades/towercab-3d
SRC=$WT/.tmp/mocks/tc3d-218-fire-station-src
mkdir -p $SRC && cp $WT/docs/plans/canvases/tc3d-218-fire-station/index.html $SRC/
uv run --no-project --with pillow python -I build_media.py X:/dev/towercab-3d/.playwright-mcp/fireshots $SRC
uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py $SRC/index.html $WT/.tmp/mocks/tc3d-218-fire-station
```

`build_media.py` crops each shot to x 20-1460, y 160-800 and scales it to 1,200 px wide.

## Scripts

### `fire-init.js`

```js
async (page) => {
  // TC3D-218 fire-station mock: buildings on (quality high), fixed 12:00, airport from the URL, and the
  // building style's colour wrapped so window.__fire.ids get the facade class in window.__fire.cls
  // (null = as tagged). Hash, storeys and wall height stay as packed.
  await page.bringToFront();
  await page.waitForFunction(() => window.__tc3d !== undefined, null, { timeout: 120000 });
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
    // METAR cloud layers drew across the buildings; the mock compares walls, so clouds are off.
    t.stores.settings.getState().updateWeatherSettings({ showClouds: false });
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
    window.__fire = { ids: new Set(), cls: null, findTileset };
    window.__fireWrap = () => {
      const tileset = findTileset();
      const col = tileset.style.color;
      if (!col.__fireWrapped) {
        const orig = col.evaluateColor.bind(col);
        col.evaluateColor = (f, result) => {
          const c = orig(f, result);
          const force = window.__fire;
          if (f !== undefined && force.cls !== null && force.ids.has(String(f.getProperty('elementId')))) {
            const red = Math.round(c.red * 255);
            const hash = (255 - red) % 4;
            c.red = (255 - (force.cls * 4 + hash)) / 255;
          }
          return c;
        };
        col.evaluate = col.evaluateColor;
        col.__fireWrapped = true;
      }
      return tileset;
    };
    window.__fireSet = async (cls, frames = 10) => {
      window.__fire.cls = cls;
      window.__fireWrap().makeStyleDirty();
      for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    };
    const { useAirportStore } = await import('/stores/airportStore.ts');
    for (let i = 0; i < 120 && useAirportStore.getState().airports.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    useAirportStore.getState().selectAirport(icao);
    return { ok: true, icao };
  }, icao);
  await page.waitForTimeout(12000);
  await page.evaluate(() => window.__fireWrap());
  return out;
}
```

### `fire-aim.js`

```js
async (page) => {
  // Installs window.__fireAim(spec): moves the main camera (WASD offsets from the tower eye) to `distM`
  // from the building on the bearing from the building toward the tower (plus `turnDeg`), at `heightM`
  // above the building's ground, then aims it (lookAt for the heading) at `aimM` above that ground.
  return await page.evaluate(() => {
    const t = window.__tc3d;
    const R = 6371008.8;
    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    window.__fireAim = async ({ lat, lon, distM, heightM, turnDeg = 0, aimM = 4, fov }) => {
      const aimFt = 0;
      const vs = t.stores.viewport.getState();
      vs.resetPosition();
      await new Promise((r) => setTimeout(r, 800));
      const eye = t.viewer.camera.positionCartographic;
      const eyeLat = deg(eye.latitude);
      const eyeLon = deg(eye.longitude);
      // Bearing building -> tower.
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
      t.lookAt(lat, lon, aimFt);
      await new Promise((r) => setTimeout(r, 2500));
      // lookAt sets the heading; the pitch is taken from the rendered camera so it aims aimM above the ground.
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

### `fire-shoot.js`

```js
async (page) => {
  // Shoots each building of the current airport in the four lanes: HANGAR (2), OFFICE (4), PLAIN (6), GENERIC (0).
  // window.__fireShots = [{ name, lat, lon, distM, heightM, fov, hours: [12, 22] }] picks the buildings, poses and hours.
  const dir = 'X:/dev/towercab-3d/.playwright-mcp/fireshots/';
  const clip = { x: 2, y: 50, width: 1596, height: 800 };
  const lanes = [['hangar', 2], ['office', 4], ['plain', 6], ['generic', 0]];
  const settle = () =>
    page.evaluate(async () => {
      const ts = window.__fire.findTileset();
      const globe = window.__tc3d.viewer.scene.globe;
      let stable = 0;
      for (let i = 0; i < 180 && stable < 6; i++) {
        stable = ts.tilesLoaded && globe.tilesLoaded ? stable + 1 : 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      return stable >= 6;
    });
  const shots = await page.evaluate(() => window.__fireShots);
  const out = [];
  for (const shot of shots) {
    for (const hour of shot.hours) {
      await page.evaluate((hour) => window.__tc3d.stores.settings.getState().updateCesiumSettings({ fixedTimeHour: hour }), hour);
      const pose = await page.evaluate((s) => window.__fireAim(s), shot);
      await page.waitForTimeout(2500);
      const settled = await settle();
      for (const [lane, cls] of lanes) {
        await page.evaluate((cls) => window.__fireSet(cls, 10), cls);
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${dir}${shot.name}-${hour}-${lane}.png`, clip });
      }
      await page.evaluate(() => window.__fireSet(null, 10));
      out.push({ name: shot.name, hour, settled, pose });
    }
  }
  return out;
}
```

### `build_media.py`

```python
"""Crops the TC3D-218 fire-station shots into the page's stills.

Usage: uv run --no-project --with pillow python -I build_media.py <shots dir> <out dir>

The shots dir holds {sfo1,sfo2,oak22}-12-{lane}.png and sfo1-22-{lane}.png (1596x800 canvas clips from
fire-shoot.js), lane one of hangar, office, plain, generic. Writes {shot}-{lane}.jpg beside the page.
"""

import sys
from pathlib import Path

from PIL import Image

CROP = (20, 160, 1460, 800)
WIDTH = 1200
LANES = ("hangar", "office", "plain", "generic")
SHOTS = ("sfo1-12", "sfo2-12", "oak22-12", "sfo1-22")


def main() -> None:
    shots, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for shot in SHOTS:
        for lane in LANES:
            img = Image.open(shots / f"{shot}-{lane}.png").convert("RGB").crop(CROP)
            img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
            target = out_dir / f"{shot}-{lane}.jpg"
            img.save(target, quality=85, optimize=True, progressive=True)
            total += target.stat().st_size
    print(f"{len(SHOTS) * len(LANES)} stills, {total} bytes")


if __name__ == "__main__":
    main()
```
