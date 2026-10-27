# Rebuilding the tc3d-218-d5-fallback-timing media

The page's 26 media files (8 state stills and 6 key-frame strips as WebP, 12 MP4 clips) total about 1.9 MB, so only the page and this recipe are committed. The media live in the review copy, built from the untracked source folder `.tmp/mocks/tc3d-218-d5-fallback-timing-src/`. Every script the steps below run is reproduced at the end of this file; save each under the name its heading gives.

Nothing is patched: the measurement and the forced classes go through `window.__tc3d` and `browser_evaluate` / `browser_run_code_unsafe` against `feat/osm-facades` as it stands.

## 1. Tree and dev API

```powershell
git -C X:\dev\towercab-3d worktree add X:\dev\towercab-3d.wt\mock-d5 --detach e479e3d
pwsh -NoProfile -File X:/dev/towercab-3d/tools/gate.ps1 run --cd X:/dev/towercab-3d.wt/mock-d5 --log X:/dev/towercab-3d.wt/mock-d5/.tmp/install.log --timeout 900 --slot heavy -- pnpm install --frozen-lockfile
cd X:\dev\towercab-3d.wt\mock-d5
pnpm run vite:headless                        # port 5174, run in the background, stop it when done
curl http://localhost:5174/api/dev-health     # needs ionToken: true
```

e479e3d is `feat/osm-facades` when the media were made. Follow CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules (never read the settings route, the token or the dev settings file). Drive the page with the `playwright-headless` MCP server. Its run-code tool reads a script from a file only under `X:\dev\towercab-3d`, so save the five `d5-*.js` scripts below in `X:\dev\towercab-3d\.playwright-mcp\` (gitignored) and create `.playwright-mcp\d5shots\`.

## 2. Measure the lookup delay (per airport, KOAK then KSFO)

1. `browser_navigate` to `http://localhost:5174/?airport=KOAK`.
2. `browser_run_code_unsafe` with `filename` `d5-init.js`. It sets 3D buildings on, quality high and a fixed 12:00, attaches the listeners to the tileset, selects the airport from the URL and waits 12 s, the airport-switch stall. Tiles loaded so far are phase `load`.
3. `browser_run_code_unsafe` with `d5-pan.js`: 12 heading steps of 30° at FOV 60, then 12 at FOV 25, 2.5 s apart, from the tower eye (phase `pan`).
4. `browser_evaluate` with `filename` `.playwright-mcp/d5-koak-delays.json` and this function:

   ```js
   () => { const s = window.__d5.summary(); return JSON.stringify({ airport: 'KOAK', all: s.all, load: s.load, pan: s.pan, frameMs: [s.frameIntervalMedianMs, s.frameIntervalP95Ms], rows: s.rows.map(r => ({...r, delayMs: r.delayMs === null ? null : Math.round(r.delayMs*10)/10, loadToVisMs: Math.round(r.loadToVisMs)})) }); }
   ```

5. Repeat 1-4 with `KSFO`, then `uv run --no-project python -I summarise.py .playwright-mcp/d5-koak-delays.json .playwright-mcp/d5-ksfo-delays.json` prints the page's table.

A tile's delay is from its first `tileVisible` (the frame it is first drawn) to the `postRender` in which `getTileFeatureStats(tile.content)` first returns stats. That listener is added after `attachBuildingLookup`'s, so it runs after the drain.

## 3. Counts for lane B

After `d5-init.js` at each airport (no panning), `browser_run_code_unsafe` with `d5-count.js` returns the buildings inside the aerodrome boundary in the selected tiles, how many of them are GENERIC, and how many of those set B would type HANGAR (KSFO 135 / 83 / 12, KOAK 127 / 104 / 10).

## 4. Shoot the four states

1. `browser_navigate` to `http://localhost:5174/?airport=KSFO`, then run `d5-init.js`.
2. Run `d5-force.js`. It hides everything but the canvases and wraps the building style's colour so `window.__d5force.ids` get the class in `window.__d5force.cls`.
3. `browser_evaluate`:

   ```js
   async () => { const t = window.__tc3d; window.__d5force.ids = new Set(['25373264']); t.lookAt(37.62289, -122.39315, 25); await new Promise(r=>setTimeout(r,500)); const c = t.camera.get(); t.camera.set({ heading: c.heading, pitch: c.pitch, fov: 9 }); await new Promise(r=>setTimeout(r,6000)); return t.camera.get(); }
   ```

   It returns heading 313.92, pitch −1.95, FOV 9, at the KSFO tower eye (37.615781 N 122.383828 W, ellipsoid height 46.4 m).
4. Run `d5-shoot.js`. It writes `d5shots/{noon,night}-{absent,generic,plain,hangar}.png` (1596×800 canvas clip; 12:00 and 22:00).

## 5. Media and review copy

```bash
SRC=X:/dev/towercab-3d/.tmp/mocks/tc3d-218-d5-fallback-timing-src
mkdir -p $SRC/recipe && cp X:/dev/towercab-3d/docs/plans/canvases/tc3d-218-d5-fallback-timing/index.html $SRC/
pwsh -NoProfile -File X:/dev/towercab-3d/tools/gate.ps1 run --log X:/dev/towercab-3d/.tmp/d5-media.log --timeout 900 --slot heavy -- uv run --no-project --with pillow python -I $SRC/recipe/build_media.py X:/dev/towercab-3d/.playwright-mcp/d5shots $SRC
uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py $SRC/index.html X:/dev/towercab-3d/.tmp/mocks/tc3d-218-d5-fallback-timing
```

`build_media.py` needs `ffmpeg` on the path. It crops each state to x 100-1500, y 470-800, burns in the lane, airport, time of day and the time since the tile first rendered, and builds each clip on a 60 fps timeline. The median clips switch at frame 1 (+17 ms, since the stats exist by the end of the tile's first frame and the restyle draws the next) and the worst clips at +662 ms (the KSFO airport-switch p95). Lane C blends GENERIC into HANGAR over 30 frames.

## Scripts

### `d5-init.js`

```js
async (page) => {
  // TC3D-218 D5 mock: noon, buildings on (quality high), lookup-delay instrumentation, airport from the URL.
  await page.bringToFront();
  await page.waitForFunction(() => window.__tc3d !== undefined, null, { timeout: 120000 });
  const icao = await page.evaluate(() => new URL(location.href).searchParams.get('airport') || 'KOAK');
  const out = await page.evaluate(async (icao) => {
    const t = window.__tc3d;
    t.stores.settings.getState().updateCesiumSettings({
      show3DBuildings: true,
      buildingQuality: 'high',
      timeMode: 'fixed',
      fixedTimeHour: 12,
    });
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
    const lookup = await import('/utils/buildingBaseLookup.ts');
    const scene = t.viewer.scene;
    const meas = { tiles: new Map(), frame: 0, frameTimes: [], phase: 'load', tileset: ts };
    window.__d5 = meas;
    const rec = (tile) => {
      let r = meas.tiles.get(tile);
      if (!r) {
        r = { phase: meas.phase };
        meas.tiles.set(tile, r);
      }
      return r;
    };
    ts.tileLoad.addEventListener((tile) => {
      const r = rec(tile);
      r.load = performance.now();
      r.loadFrame = meas.frame;
      r.features = tile.content?.featuresLength ?? 0;
      r.phase = meas.phase;
    });
    ts.tileVisible.addEventListener((tile) => {
      const r = meas.tiles.get(tile);
      if (!r || r.load === undefined || r.vis !== undefined) return;
      r.vis = performance.now();
      r.visFrame = meas.frame;
      r.statsAtVis = lookup.getTileFeatureStats(tile.content) !== undefined;
    });
    // Registered after attachBuildingLookup's drain, so it runs after the drain in the same postRender.
    scene.postRender.addEventListener(() => {
      const now = performance.now();
      meas.frameTimes.push(now);
      if (meas.frameTimes.length > 2000) meas.frameTimes.shift();
      for (const [tile, r] of meas.tiles) {
        if (r.load === undefined || r.stats !== undefined) continue;
        if (lookup.getTileFeatureStats(tile.content) !== undefined) {
          r.stats = now;
          r.statsFrame = meas.frame;
        }
      }
      meas.frame++;
    });
    meas.summary = () => {
      const rows = [];
      for (const r of meas.tiles.values()) {
        if (r.load === undefined || !(r.features > 0) || r.vis === undefined) continue;
        rows.push({
          phase: r.phase,
          features: r.features,
          delayMs: r.stats === undefined ? null : r.stats - r.vis,
          delayFrames: r.stats === undefined ? null : r.statsFrame - r.visFrame,
          loadToVisMs: r.vis - r.load,
          statsAtVis: r.statsAtVis,
        });
      }
      const pct = (a, p) => {
        if (a.length === 0) return null;
        const s = [...a].sort((x, y) => x - y);
        return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
      };
      const stat = (sel) => {
        const built = sel.filter((r) => r.delayMs !== null);
        const d = built.map((r) => Math.max(r.delayMs, 0));
        const f = built.map((r) => Math.max(r.delayFrames, 0));
        return {
          visibleTiles: sel.length,
          built: built.length,
          neverBuilt: sel.length - built.length,
          medianMs: pct(d, 50),
          p95Ms: pct(d, 95),
          maxMs: d.length ? Math.max(...d) : null,
          over100ms: d.filter((x) => x > 100).length,
          medianFrames: pct(f, 50),
          p95Frames: pct(f, 95),
          builtBeforeVisible: built.filter((r) => r.delayMs <= 0).length,
        };
      };
      const ft = meas.frameTimes;
      const dts = [];
      for (let i = 1; i < ft.length; i++) dts.push(ft[i] - ft[i - 1]);
      return {
        all: stat(rows),
        load: stat(rows.filter((r) => r.phase === 'load')),
        pan: stat(rows.filter((r) => r.phase === 'pan')),
        frameIntervalMedianMs: pct(dts, 50),
        frameIntervalP95Ms: pct(dts, 95),
        rows,
      };
    };
    const { useAirportStore } = await import('/stores/airportStore.ts');
    for (let i = 0; i < 120 && useAirportStore.getState().airports.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    useAirportStore.getState().selectAirport(icao);
    return { ok: true, icao };
  }, icao);
  await page.waitForTimeout(12000);
  return out;
}
```

### `d5-pan.js`

```js
async (page) => {
  // Pans the tower view through 360 degrees at two FOVs, so new building tiles load while the controller looks around.
  return await page.evaluate(async () => {
    const m = window.__d5;
    const cam = window.__tc3d.camera;
    m.phase = 'pan';
    const start = cam.get().heading;
    for (const fov of [60, 25]) {
      for (let step = 1; step <= 12; step++) {
        cam.set({ heading: (start + step * 30) % 360, pitch: fov === 60 ? -8 : -3, fov });
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    cam.set({ heading: start, pitch: -10, fov: 60 });
    await new Promise((r) => setTimeout(r, 3000));
    const s = m.summary();
    return { all: s.all, load: s.load, pan: s.pan, frameMs: [s.frameIntervalMedianMs, s.frameIntervalP95Ms] };
  });
}
```

### `d5-force.js`

```js
async (page) => {
  // Wraps the building style's colour so the target elements get a forced facade class
  // (window.__d5force.cls: null = as tagged, 0 GENERIC, 2 HANGAR, 6 PLAIN); hash, storeys and wall stay as packed.
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
  return await page.evaluate(() => {
    const ts = window.__d5.tileset;
    const col = ts.style.color;
    if (!col.__d5wrapped) {
      const orig = col.evaluateColor.bind(col);
      col.evaluateColor = (f, result) => {
        const c = orig(f, result);
        const force = window.__d5force;
        if (f !== undefined && force && force.cls !== null && force.ids.has(String(f.getProperty('elementId')))) {
          const red = Math.round(c.red * 255);
          const hash = (255 - red) % 4;
          c.red = (255 - (force.cls * 4 + hash)) / 255;
        }
        return c;
      };
      col.evaluate = col.evaluateColor;
      col.__d5wrapped = true;
    }
    window.__d5force = { ids: new Set(['468777906']), cls: null };
    window.__d5set = async (cls, frames = 3) => {
      window.__d5force.cls = cls;
      ts.makeStyleDirty();
      for (let i = 0; i < frames; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
    };
    const c = window.__tc3d.viewer.canvas.getBoundingClientRect();
    return { clip: { x: c.x, y: c.y, width: c.width, height: c.height } };
  });
}
```

### `d5-shoot.js`

```js
async (page) => {
  // Captures the target building (window.__d5force.ids) in four states at each hour:
  // absent (its features hidden, as before its tile renders), GENERIC (0), PLAIN (6), HANGAR (2).
  const dir = 'X:/dev/towercab-3d/.playwright-mcp/d5shots/';
  const clip = { x: 2, y: 50, width: 1596, height: 800 };
  const settle = () =>
    page.evaluate(async () => {
      const ts = window.__d5.tileset;
      const globe = window.__tc3d.viewer.scene.globe;
      let stable = 0;
      for (let i = 0; i < 180 && stable < 6; i++) {
        stable = ts.tilesLoaded && globe.tilesLoaded ? stable + 1 : 0;
        await new Promise((r) => setTimeout(r, 500));
      }
      return stable >= 6;
    });
  const hide = (show) =>
    page.evaluate(async (show) => {
      const ids = window.__d5force.ids;
      let n = 0;
      for (const tile of window.__d5.tileset._selectedTiles ?? []) {
        const c = tile.content;
        for (let i = 0; i < (c?.featuresLength ?? 0); i++) {
          const f = c.getFeature(i);
          if (ids.has(String(f.getProperty('elementId')))) {
            f.show = show;
            n++;
          }
        }
      }
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(() => r(null)));
      return n;
    }, show);
  const out = {};
  for (const hour of [12, 22]) {
    await page.evaluate((hour) => window.__tc3d.stores.settings.getState().updateCesiumSettings({ fixedTimeHour: hour }), hour);
    await page.waitForTimeout(2500);
    await settle();
    const tag = hour === 12 ? 'noon' : 'night';
    for (const [name, cls] of [['generic', 0], ['plain', 6], ['hangar', 2]]) {
      await page.evaluate((cls) => window.__d5set(cls, 10), cls);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${dir}${tag}-${name}.png`, clip });
    }
    await page.evaluate(() => window.__d5set(0, 10));
    out[tag] = await hide(false);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}${tag}-absent.png`, clip });
    await page.evaluate(() => window.__d5set(0, 10));
  }
  out.cam = await page.evaluate(() => {
    const c = window.__tc3d.viewer.camera.positionCartographic;
    return { lat: (c.latitude * 180) / Math.PI, lon: (c.longitude * 180) / Math.PI, h: c.height, ...window.__tc3d.camera.get() };
  });
  return out;
}
```

### `d5-count.js`

```js
async (page) => {
  // Counts, over the selected tiles, the GENERIC buildings inside the aerodrome boundary (lane B draws all of
  // them plain until their stats exist) and those set B would type HANGAR (>= 1,500 m2, <= 20 m).
  return await page.evaluate(async () => {
    const icao = new URL(location.href).searchParams.get('airport');
    const lookup = await import('/utils/buildingBaseLookup.ts');
    const m = await import('/services/AerodromeService.ts');
    await m.aerodromeService.load();
    const seen = new Set();
    let generic = 0;
    let hangar = 0;
    let all = 0;
    for (const tile of window.__d5.tileset._selectedTiles ?? []) {
      const c = tile.content;
      const st = lookup.getTileFeatureStats(c);
      if (!st) continue;
      for (let i = 0; i < c.featuresLength; i++) {
        const f = c.getFeature(i);
        const key = `${f.getProperty('elementId')}/${f.getProperty('part#elementId') ?? ''}`;
        if (seen.has(key) || !st.hasGeometry[i]) continue;
        seen.add(key);
        const lat = Number(f.getProperty('cesium#latitude'));
        const lon = Number(f.getProperty('cesium#longitude'));
        if (!m.aerodromeService.contains(icao, lon, lat)) continue;
        all++;
        if (Math.floor((255 - Math.round(f.color.red * 255)) / 4) !== 0) continue;
        generic++;
        if (st.area[i] >= 1500 && Number(f.getProperty('cesium#estimatedHeight')) <= 20) hangar++;
      }
    }
    return { icao, insideBoundary: all, generic, setBHangar: hangar };
  });
}
```

### `summarise.py`

```python
"""Summarises the per-tile lookup delays saved by d5-init.js / d5-pan.js (one JSON per airport)."""

import json
import math
import sys


def pct(values, p):
    return values[min(len(values) - 1, math.ceil(p / 100 * len(values)) - 1)]


def stats(rows):
    ms = sorted(max(r["delayMs"], 0) for r in rows if r["delayMs"] is not None)
    frames = sorted(max(r["delayFrames"], 0) for r in rows if r["delayFrames"] is not None)
    return {
        "tiles": len(ms),
        "never_built": sum(r["delayMs"] is None for r in rows),
        "median_ms": round(pct(ms, 50), 1),
        "p95_ms": round(pct(ms, 95), 1),
        "max_ms": round(ms[-1], 1),
        "over_100ms": sum(v > 100 for v in ms),
        "frames_median": pct(frames, 50),
        "frames_p95": pct(frames, 95),
        "same_frame": sum(v == 0 for v in frames),
        "next_frame": sum(v == 1 for v in frames),
        "two_plus": sum(v >= 2 for v in frames),
    }


for path in sys.argv[1:]:
    raw = json.load(open(path, encoding="utf-8"))
    data = json.loads(raw) if isinstance(raw, str) else raw
    rows = data["rows"]
    print(data["airport"], "frame interval median/p95 ms", [round(v, 1) for v in data["frameMs"]])
    for phase in ("all", "load", "pan"):
        sel = rows if phase == "all" else [r for r in rows if r["phase"] == phase]
        print(" ", phase, stats(sel))
```

### `build_media.py`

```python
"""Builds the D5 fallback-timing media from the eight captured states.

Usage: uv run --no-project --with pillow python -I build_media.py <shots dir> <out dir>

The shots dir holds {noon,night}-{absent,generic,plain,hangar}.png (1596x800, from d5-shoot.js).
Writes, beside the page: the labelled state crops, a key-frame strip per lane and time of day,
and a real-time 60 fps clip per lane, time of day and delay case (median, worst).
"""

import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CROP = (100, 470, 1500, 800)
FPS = 60
FRAME_MS = 1000 / FPS
LEAD_FRAMES = 30  # 0.5 s before the tile first renders
CLIP_FRAMES = 150  # 2.5 s in all
FADE_FRAMES = 30  # lane C: 0.5 s crossfade
AIRPORT = "KSFO, way 25373264 (untagged, 3,891 m2, 2 levels), tower eye"

# When the typed facade is first drawn. Median: the drain builds the stats in the postRender of the
# tile's first frame (0 frames late at both airports), and makeStyleDirty restyles the next frame.
# Worst: the KSFO airport-switch p95, 662 ms of stalled frames before the stats exist.
CASES = {
    "median": {"switch_ms": FRAME_MS, "label": "median: stats in the first frame, typed in the next"},
    "worst": {"switch_ms": 662.0, "label": "worst: KSFO airport-switch p95, 662 ms"},
}
LANES = {
    "a": {"name": "A  Swap on arrival", "first": "generic", "fade": False},
    "b": {"name": "B  Plain until typed", "first": "plain", "fade": False},
    "c": {"name": "C  Fade (0.5 s)", "first": "generic", "fade": True},
}
TIMES = {"noon": "12:00", "night": "22:00"}
STATE_NAMES = {"absent": "tile not rendered yet", "generic": "GENERIC facade", "plain": "plain wall", "hangar": "HANGAR facade"}


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "arial.ttf"):
        path = Path("C:/Windows/Fonts") / name
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


FONT_BIG = font(24)
FONT_SMALL = font(20)


def label(img, line1, line2):
    out = img.convert("RGBA")
    band = Image.new("RGBA", (out.width, 66), (0, 0, 0, 165))
    out.alpha_composite(band, (0, 0))
    draw = ImageDraw.Draw(out)
    draw.text((12, 6), line1, font=FONT_BIG, fill=(255, 255, 255, 255))
    draw.text((12, 38), line2, font=FONT_SMALL, fill=(255, 225, 140, 255))
    return out.convert("RGB")


def switch_frame(switch_ms):
    """Frames after the first render at which the typed facade is drawn."""
    return max(1, round(switch_ms / FRAME_MS))


def lane_frame(states, lane, k, switch):
    """The image lane draws k frames after its tile first renders, and what it shows."""
    spec = LANES[lane]
    if k < switch:
        return states[spec["first"]], STATE_NAMES[spec["first"]]
    if not spec["fade"]:
        return states["hangar"], STATE_NAMES["hangar"]
    alpha = min((k - switch + 1) / FADE_FRAMES, 1.0)
    if alpha >= 1.0:
        return states["hangar"], STATE_NAMES["hangar"]
    blend = Image.blend(states["generic"], states["hangar"], alpha)
    return blend, f"crossfade GENERIC -> HANGAR, {round(alpha * 100)} %"


def head(lane, time):
    return f"{LANES[lane]['name']}   |   {AIRPORT}   |   {TIMES[time]}"


def clip(states, lane, time, case, out_dir, tmp):
    switch = switch_frame(CASES[case]["switch_ms"])
    frames = tmp / f"{lane}-{time}-{case}"
    frames.mkdir(parents=True)
    for n in range(CLIP_FRAMES):
        k = n - LEAD_FRAMES
        if k < 0:
            img, what = states["absent"], STATE_NAMES["absent"]
            when = f"t = {round(k * FRAME_MS)} ms"
        else:
            img, what = lane_frame(states, lane, k, switch)
            when = f"t = +{round(k * FRAME_MS)} ms since the tile first rendered"
        line2 = f"{when}   |   {what}   |   {CASES[case]['label']}"
        label(img, head(lane, time), line2).save(frames / f"{n:04d}.png")
    target = out_dir / f"lane-{lane}-{time}-{case}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(frames / "%04d.png"),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", str(target)],
        check=True,
    )


def strip(states, lane, time, out_dir):
    """Key frames at the median delay, stacked: the first frame, the next one, and the fade's middle and end."""
    switch = switch_frame(CASES["median"]["switch_ms"])
    keys = [0, switch]
    if LANES[lane]["fade"]:
        keys += [switch + FADE_FRAMES // 2 - 1, switch + FADE_FRAMES - 1]
    tiles = []
    for k in keys:
        img, what = lane_frame(states, lane, k, switch)
        tiles.append(label(img, head(lane, time), f"t = +{round(k * FRAME_MS)} ms since the tile first rendered   |   {what}"))
    sheet = Image.new("RGB", (tiles[0].width, sum(t.height for t in tiles) + 6 * (len(tiles) - 1)), (255, 255, 255))
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 6
    sheet.save(out_dir / f"lane-{lane}-{time}-frames.webp", quality=82)


def main():
    shots, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_dir / "_frames"
    if tmp.exists():
        shutil.rmtree(tmp)
    for time in TIMES:
        states = {s: Image.open(shots / f"{time}-{s}.png").convert("RGB").crop(CROP) for s in STATE_NAMES}
        for s, img in states.items():
            label(img, f"State: {STATE_NAMES[s]}   |   {AIRPORT}   |   {TIMES[time]}", "forced through the tileset style; same pose").save(
                out_dir / f"state-{time}-{s}.webp", quality=82
            )
        for lane in LANES:
            strip(states, lane, time, out_dir)
            for case in CASES:
                clip(states, lane, time, case, out_dir, tmp)
    shutil.rmtree(tmp)


if __name__ == "__main__":
    main()
```
