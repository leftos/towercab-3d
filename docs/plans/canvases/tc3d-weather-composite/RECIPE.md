# Weather composite mock (TC3D-295, TC3D-294, TC3D-224): rebuild recipe

`index.html` links 23 WebP stills (`img/`), 5 MP4 clips (`clip/`) and 5 SVG charts (`chart/`) by relative path. Together they come to about 2.1 MB. The `shoot/` folder holds every script that made them, and `shoot/mock.diff` holds the prototype switches. These steps rebuild the media from nothing.

## Source

- Code: `feat/cesium-weather` at 1d69463, in a scratch worktree: `git -C X:\dev\towercab-3d worktree add X:\dev\towercab-3d.wt\mock-weather\towercab-3d --detach 1d69463`, then `pnpm install --frozen-lockfile` in it.
- Apply `shoot/mock.diff` there: `git -C X:\dev\towercab-3d.wt\mock-weather\towercab-3d apply X:\dev\towercab-3d\docs\plans\canvases\tc3d-weather-composite\shoot\mock.diff`. It adds runtime switches read every frame from `window.__tc3dMock`; with the object empty, every uniform keeps today's value.
- Data: the desktop dev build's settings file with an ion token (`/api/dev-health` answers `"ionToken":true`). No mods are needed.

| `__tc3dMock` field | Meaning |
|---|---|
| `debug` | 1: the composite writes the raw depth as 24-bit RGB; 2: it writes `sceneDistance()` in metres as 24-bit RGB |
| `lod` | 1: noise octaves fade to their mean as the sample footprint nears the octave's cell (TC3D-294 lane B) |
| `graze` | maximum step length in metres; the step count grows to keep under it, up to 256 (lane C) |
| `jitter` | 1: interleaved gradient noise rotated per frame, replacing the hash jitter (lane D) |
| `shade` | 0–1: a layer's lit colour moves toward the fog grey by this times the largest coverage above it (lanes E = 1, F = 0.6) |
| `drift` | pins the noise drift time in seconds, so lanes see the same cloud field |
| `fade` | TC3D-224: 0 today, 1 extinction fade 10→8 SM + ease, 2 visibility fade (log space from 100 SM-equivalent) + ease, 3 time ease only |
| `easeS`, `clock` | ease time in seconds (smoothstep), and the pinned clock the ease reads (seconds) |

## Steps

1. Copy `shoot/*.js` to `X:\dev\towercab-3d\.tmp\mock-weather\`: the `playwright-headless` MCP server reads scripts only under the main checkout, and `setup.js` injects `helpers.js` from there. Create `png294\` there.
2. Start the dev server from the scratch tree in the background: `pnpm --dir X:\dev\towercab-3d.wt\mock-weather\towercab-3d run vite:headless`. Check `curl -s http://localhost:5174/api/dev-health`.
3. `browser_navigate` to `http://localhost:5174/`, then `browser_run_code_unsafe` with `filename` `.tmp\mock-weather\setup.js`. It brings the page to front, selects EGLL, fixes the time at 13:00 UTC, turns weather interpolation off, picks the High preset and sets the tower pose: heading 274, pitch −3, FOV 45, camera 88.8 m above the ground.
4. **TC3D-295**: `browser_run_code_unsafe` with `filename` `probe-poses.js`. It writes `ovc-h{274,0,90,180}.png` (the composite with depth-1.0 pixels tinted red, rows hr−60 to hr+80, centre 640 columns at 2×) and returns the per-row depth table. The page's table rows come from `__m.depthProbe()` at heading 274 (`browser_evaluate`). The composite strips: at 5.96 SM and then 10 SM (`__m.weather({ vis })`, wait 3 s), `page.screenshot({ clip: { x: 160, y: 290, width: 1280, height: 140 } })` to `strip-5.96.png` and `strip-10.png`.
5. **TC3D-294**: `browser_run_code_unsafe` with `shoot-294.js` (lanes A–E, row steps at drift 0/300/600, PNGs of the canvas at drift 0), then with `cost-294.js` (lane F, the pitch +12 shots `up-{a,e,f}.png`, and four interleaved rounds of `gpuCesiumMs` at 330 frames per reading). Reload the page and rerun `setup.js` first if the GLSL changed: hot reload does not rebuild a running stage.
6. **TC3D-224**: set `window.__jobs224` with `browser_evaluate`, then run `shoot-224.js` once per batch. It writes `frames/<job>/NNN.jpg` and keeps the clock and density per frame in `window.__log224`.
   - `r1-{a,b,c,d}`: fade 0/1/2/3, easeS 6, 10 → 6 SM, t −0.5..7.5, dt 0.1
   - `r2-{a,b,c,d}`: the same, 3 → 1 SM
   - `r3-{a,b,c,d}`: fade 0/1/2/3, easeS 6, glide `{ dur: 8 }` 10.5 → 8.5 SM, t −0.5..10, dt 0.1
   - `r4-{a,b,c}`: fade 0/1/2, easeS 0.001 (no ease), the same glide
   - `r5-{2,6,15}`: fade 3, easeS 2/6/15, 10 → 6 SM, t −0.5..16.5, dt 0.2
   Then `browser_evaluate` `() => JSON.stringify(window.__log224)` with `filename` `.tmp\mock-weather\log224.json`.
7. Build the media into the page folder: `uv run --no-project --with pillow python -I docs/plans/canvases/tc3d-weather-composite/shoot/build_media.py .tmp/mock-weather docs/plans/canvases/tc3d-weather-composite`. This needs ffmpeg on PATH; the clips are H.264, CRF 24.
8. Review copy: `uv run --no-project python ~/.claude/tools/mock-embed/embed_media.py docs/plans/canvases/tc3d-weather-composite .tmp/mocks/tc3d-weather-composite`.
9. Close the page (`browser_close`) before stopping the dev server.

## Notes

- `__m.grab()` renders with `viewer.clock.currentTime`; `scene.render()` without a time renders at the wall clock.
- `gpuCesiumMs` lags after a stage rebuild: the first round's readings sit near the stage-off value, so the page uses rounds 2–4. Another headless browser shared the GPU during the run, so expect ±0.3 ms between rounds.
- The 224 ease is restarted on every target change (`mockVisibility` in the diff). That is why the eased glide (`r3`) stalls; the page reports it as a finding.
