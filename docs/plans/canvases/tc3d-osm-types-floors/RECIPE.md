# Rebuilding the tc3d-osm-types-floors stills

The page's 22 WebP stills total about 1.6 MB. Everything needed to rebuild them is in `recipe/`: the prototype as a patch (`recipe/scratch.patch`), the headless driver, the shot plans and the two OSM aerodrome polygons.

## 1. Scratch worktree with the prototype

```powershell
git -C X:\dev\towercab-3d worktree add X:\dev\towercab-3d.wt\mock-osm\towercab-3d --detach 4b888e2
cd X:\dev\towercab-3d.wt\mock-osm\towercab-3d
git apply X:\dev\towercab-3d\docs\plans\canvases\tc3d-osm-types-floors\recipe\scratch.patch
pnpm install --frozen-lockfile
```

4b888e2 is `feat/osm-facades` when the stills were made. The patch adds `src/renderer/utils/mockFloors.ts` (the `window.__mock` handle: the per-tile lookup texture bound through a patched `BatchTexturePipelineStage.process`, the vertex readback, poses, grabs), imports it from `CesiumViewer.tsx`, and adds the `u_mock*` uniforms and modes to `facadeShader.ts`.

## 2. Dev API on its own port

```powershell
pnpm exec vite --mode headless --port 5175 --strictPort
curl http://localhost:5175/api/dev-health   # needs ionToken: true
```

It reads the desktop dev build's settings (the Cesium ion token is required for terrain and imagery); see CLAUDE.md "E2E testing via Playwright MCP" for the transcript rules.

## 3. Driver

```bash
mkdir -p .tmp/driver && cp -r X:/dev/towercab-3d/docs/plans/canvases/tc3d-osm-types-floors/recipe/* .tmp/driver/
cd .tmp/driver && npm i && mkdir -p out
node mkplan3.mjs          # writes plans/m3-KSFO.json, plans/m3-KOAK.json, plans/m1-koak.json
bash render-all.sh        # headless Edge (msedge channel, --disable-extensions), then annotate.py / annotate4.py
uv run --no-project --with pillow python build_media.py X:/dev/towercab-3d/docs/plans/canvases/tc3d-osm-types-floors
```

`render-all.sh` prints each plan's `totals` line (tiles, features, readback and compute ms, texture and vertex bytes): the cost table on the page comes from those lines. `build_media.py` holds the crop boxes and writes the WebP files (quality 82).

## Poses (all at 12:00 local, building quality high, `u_fade` 0)

| Still | Pose |
|-------|------|
| `m1-koak-*` | KOAK, 37.71046 N 122.21022 W, ellipsoid height −25.7 m, heading 255, pitch 1, FOV 16; crop y 300-620 |
| `m1-ksfo-*` | KSFO, 37.6045 N 122.3985 W, 5 m, heading 200, pitch −12, FOV 35; crop 500,200-1276,620 |
| `m1-raised-*` | KSFO tower eye (no offset), heading 262, pitch −7, FOV 18; crop 0,180-640,600 |
| `m2-street-*` | KSFO, 37.6050 N 122.3990 W, 25 m, heading 195, pitch −18, FOV 45; crop 150,100-750,450 |
| `m2-term-*` | KSFO tower eye, heading 262, pitch −7, FOV 30; crop 150,150-1276,560 |
| `m3-*` | top-down 6,500 m over the ARP (KSFO 37.6189 N 122.375 W, KOAK 37.7213 N 122.2208 W), viewport 1280×1000, tileset SSE 2, globe SSE 0.5 |
| `m4-ksfo` | KSFO tower eye, heading 274, pitch −7, FOV 45 |

The aerodrome polygons are OSM ways 545819287 (KSFO) and 54363486 (KOAK), fetched from Overpass (`way[aeroway=aerodrome][icao=…]; out geom;`).
