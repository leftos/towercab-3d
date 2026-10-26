# Rebuilding the tc3d-218-part-height stills

The page's 18 PNG stills total about 14 MB, so only the page, this recipe and `recipe/` are committed; the stills live in the review copy `.tmp/mocks/tc3d-218-part-height/`. Everything needed to rebuild them is in `recipe/`.

## The three lanes

- **A** is `src/renderer/utils/buildingStyle.ts` at ca4d7fc (`feat/osm-facades`) as it stands.
- **B** is `recipe/lane-B.patch`: `isPart = isBuildingPart(feature)`, and a part reads only its own `part#building:levels` and `part#height`.
- **C** is `recipe/lane-C.patch`: `isPart = isBuildingPart(feature)`, and a part reads its own `part#` value for each of levels and height when present, else the parent's unprefixed value for that tag (its `building:min_level`, `min_height` and roof keys follow the same source). The early "wall unknown" return applies when the part has its own levels and no height from either source, so a part with neither own tag gets exactly what A gives it.

Each patch applies alone to ca4d7fc. For shooting, `recipe/lane-switch.patch` puts all three bodies side by side in `buildingStyle.ts` (exported as `LANES_218`) behind `globalThis.__lane218`, so one page session shoots every lane; `tileset.makeStyleDirty()` re-evaluates the style after a switch.

## 1. Scratch worktree

```powershell
git -C X:\dev\towercab-3d worktree add X:\dev\towercab-3d.wt\mock-218-parts -b mock-218-parts ca4d7fc
cd X:\dev\towercab-3d.wt\mock-218-parts
git apply X:\dev\towercab-3d\docs\plans\canvases\tc3d-218-part-height\recipe\lane-switch.patch
Copy-Item X:\dev\towercab-3d\docs\plans\canvases\tc3d-218-part-height\recipe\mock218.ts src\renderer\utils\
pwsh -NoProfile -File X:/dev/towercab-3d/tools/gate.ps1 run --cd X:/dev/towercab-3d.wt/mock-218-parts --log X:/dev/towercab-3d.wt/mock-218-parts/.tmp/install.log --timeout 600 --slot heavy -- pnpm install --frozen-lockfile
```

`mock218.ts` is the harness, imported from the page with `await import('/utils/mock218.ts')`: `setup` (3D buildings on, quality high, fixed time 12:00), `selectAirport`, `pose` (tower-relative offsets, or an absolute lat/lon/ellipsoid height reached through the viewport offsets), `settle` (tileset and globe loaded for 3 s), `setLane`, `onScreen` (a 16 px pick grid over the canvas: each feature hit, its tags and each lane's storeys and wall) and `scan` (a census over every selected tile, with the storey height the shader would draw per lane).

## 2. Dev API and page

```powershell
pnpm run vite:headless          # port 5174, from the scratch tree
curl http://localhost:5174/api/dev-health   # needs ionToken: true
```

Follow CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules. Drive it with the `playwright-headless` MCP server; the run-code tool reads a script from a file only under `X:\dev\towercab-3d`, so copy `recipe/init218.js`, `recipe/shoot218.js` and `recipe/scan218.js` to `X:\dev\towercab-3d\.playwright-mcp\` (gitignored), and create `.playwright-mcp\shots218\`.

1. `browser_navigate` to `http://localhost:5174/?airport=KSFO` (or `KOAK`).
2. `browser_run_code_unsafe` with `filename` set to `init218.js` (loads the harness, sets noon and buildings, selects the airport from the URL, waits 12 s for the airport switch).
3. Census: `browser_run_code_unsafe` with `scan218.js` (top-down 5,000 m, tileset SSE 2).
4. Each view: set the job with `browser_run_code_unsafe` code `async (page) => page.evaluate(() => { window.__job218 = { name, pose, lanes: ['A','B','C'], sse: 4 } })`, then run `shoot218.js`. It hides every element but the canvases, poses, waits for tiles, and per lane switches, waits, and saves `shots218/<name>-<lane>.png` clipped to the 1596×800 Cesium canvas (viewport 1600×900). Its return value is the parts table.
5. The tables on the page come from `browser_evaluate` of `window.__m.onScreen(16)` with the result saved to `shots218/<name>.json`; the four are in `recipe/`.

Editing `mock218.ts` while the page is open reloads the page (it has no HMR boundary); run `init218.js` again.

## Poses (all at 12:00 local, quality high, tileset SSE 4)

| View | Airport | Pose |
|------|---------|------|
| `ksfo-intl` | KSFO | tower eye (offsets 0), heading 262, pitch −5, FOV 32 |
| `ksfo-t2` | KSFO | 37.6168 N 122.3795 W, ellipsoid height 5 m, heading 268, pitch −4, FOV 40 |
| `ksfo-aluxor` | KSFO | 37.62330 N 122.41150 W, ellipsoid height −12 m, heading 285, pitch −4, FOV 45 |
| `koak` | KOAK | 37.71325 N 122.21605 W, ellipsoid height −20 m, heading 140, pitch −3, FOV 50 |

## 3. Media and review copy

```bash
D=X:/dev/towercab-3d/docs/plans/canvases/tc3d-218-part-height
uv run --no-project --with pillow python -I $D/recipe/make_media.py X:/dev/towercab-3d/.playwright-mcp/shots218 $D
uv run --no-project --with pillow python -I $D/recipe/diff.py <view>-A.png <view>-B.png   # changed-pixel count per lane pair
uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py $D/index.html X:/dev/towercab-3d/.tmp/mocks/tc3d-218-part-height
```

`make_media.py` copies the 12 lane stills beside the page and cuts the zoomed detail crops (Terminal 2 at 1×, Aluxor at 2×). After the review copy is built, move the PNGs out of the committed folder (`trash $D/*.png`).
