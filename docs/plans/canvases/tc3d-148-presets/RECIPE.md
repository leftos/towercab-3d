# TC3D-148 preset comparison: rebuild recipe

`index.html` compares three weather-stage quality presets (High, Medium, Low) at four KOAK tower-cab shots. Its 21 WebP images total about 1.2 MB, so they are not committed: the page names them as `img/<row>-<lane>.webp` and `img/<row>-<lane>-crop.webp`, and they live only in the untracked `.tmp/mocks/tc3d-148-presets-src/img/`. These steps rebuild them.

## Source

- Code: branch `feat/cesium-weather` at 2042739, worktree `X:\dev\towercab-3d.wt\feat-cesium-weather\towercab-3d`. No tracked file is edited; the knobs are changed at runtime.
- Data: the desktop dev build's settings file (the default of `vite:headless`) with a Cesium ion token loaded. No tower mod is needed.

## Knob values per lane

| Lane | steps | resolutionScale | radius (m) | densityScale | fogExtinction | fogHeightScale (m) |
|---|---|---|---|---|---|---|
| A High | 120 | 0.5 | 100000 | 0.04 | 1.0 | 400 |
| B Medium | 72 | 0.375 | 60000 | 0.04 | 1.0 | 400 |
| C Low | 48 | 0.25 | 40000 | 0.04 | 1.0 | 400 |

## Rows

| Row id | Weather (`helper.js` key) | Pose (heading, pitch, FOV) |
|---|---|---|
| `bkn10` | BKN025, 10 SM (`bkn10`) | 300, +6, 60 |
| `ovc3` | OVC015, 3 SM (`ovc3`) | 300, +6, 60 |
| `few10` | FEW040, 10 SM (`few10`) | 300, +6, 60 |
| `horizon-bkn10` | BKN025, 10 SM (`bkn10`) | 160, +1, 40 |

## Steps

1. Start the dev server from the feature worktree, in the background, and check it: `pnpm --dir X:\dev\towercab-3d.wt\feat-cesium-weather\towercab-3d run vite:headless`, then `curl -s http://localhost:5174/api/dev-health` must show `"settings":"found","ionToken":true`.
2. In the `playwright-headless` MCP server: `browser_navigate` to `http://localhost:5174/`, then `browser_run_code_unsafe` with `async (page) => { await page.bringToFront() }` (headless Edge renders at 1 fps until then).
3. Select KOAK with `browser_evaluate`: `async () => { const m = await import('/stores/airportStore.ts'); await m.useAirportStore.getState().selectAirport('KOAK') }`, and wait about 10 s for the airport-switch stall to pass.
4. `browser_evaluate` with the whole of `shoot/helper.js` as the function. It fixes the time at 13:00 local, turns weather interpolation off and installs `window.__shoot`.
5. For each row in the table, write a copy of `shoot/shoot-row.js` with `__ROW__` replaced, for example `sed "s|__ROW__|{ id: 'horizon-bkn10', weather: 'bkn10', pose: { heading: 160, pitch: 1, fov: 40 } }|" shoot/shoot-row.js > .tmp/mocks/row-horizon.js`, and run it with `browser_run_code_unsafe` and `filename` set to that copy. Each run measures the stage off, then each lane, and writes `<row>-<lane>.png` (the 1596x800 canvas, aircraft panel and hints hidden) to `X:/dev/towercab-3d/.tmp/mocks/tc3d-148-presets-png/`. It returns the perf numbers the page's tables hold.
6. Convert and crop: `uv run --no-project --with pillow python -I docs/plans/canvases/tc3d-148-presets/shoot/to_webp.py .tmp/mocks/tc3d-148-presets-png .tmp/mocks/tc3d-148-presets-src/img` (WebP quality 90; 2x nearest-neighbour crops of the `bkn10`, `horizon-bkn10` and `few10` rows).
7. Copy the page beside the images: `cp docs/plans/canvases/tc3d-148-presets/index.html .tmp/mocks/tc3d-148-presets-src/index.html`.
8. Make the review copy: `uv run --no-project python ~/.claude/tools/mock-embed/embed_media.py .tmp/mocks/tc3d-148-presets-src/index.html .tmp/mocks/tc3d-148-presets`. Open `.tmp/mocks/tc3d-148-presets/index.html`.
9. Close the page (`browser_close`) before stopping the dev server.

## Notes

- `textureScale` is read once when the stage is created. `setLane` recreates the stage by turning `showClouds` and `showBabylonFog` off and on; turning `showWeatherEffects` off instead makes `App.tsx` clear the weather store.
- Clouds drift with the wind, so cloud shapes move slightly between lanes of one row.
- `frameInterval` sits on the 60 Hz cap (`viewer.targetFrameRate` 60) in every cell on the RTX desktop. Headless Edge returns GPU timer results, so `gpuCesiumMs` is the column that separates the lanes.
