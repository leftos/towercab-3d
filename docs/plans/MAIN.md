# TowerCab 3D — Main Plan
<!-- plan-doc-hygiene: 2026-09-27 0275468 towercab-3d-vnas@1145753 -->

Entry point for all in-flight work. Each task is a checkbox; detail lives in the linked subplan. Completed subplans move to `docs/plans/archive/`.

Open work is grouped into **waves**: release-sized bundles that share owning files, so one pass reads those files once and one review covers the bundle. Work the waves in order unless a wave says it is independent. Item IDs (`A2.3`, `G5`, …) point at lines in the linked subplan. The private vNAS crate is the sibling repo `../towercab-3d-vnas`.

**Verification, every wave:** `pnpm run check` (Biome, TypeScript, Rust). App checks run in the desktop app through the `tauri-app` MCP (launch recipe in `CLAUDE.md`, "E2E testing via Playwright MCP"); particles and other additive effects need a video or `engine.readPixels`, not a screenshot.

## Current focus

- [ ] **Agent test harness for the `tauri-app` MCP**: a dev-only `window.__tc3d` with the Cesium viewer, Babylon scene and stores; `camera.get()` / `camera.set({ heading, pitch, fov })` / `lookAt(lat, lon, height)`; and `project(lat, lon, height)` → page coordinates. Removes the DOM scraping, arrow-key steering and hash-pinned `engineStore.js` imports the Wave 1 run needed. Also document in `CLAUDE.md`: Shift+Home resets to the app default, and the dev mods folder is `src-tauri/target/debug/mods` (clone `github.com/leftos/tc3d-mod-koak-tower` there for a tower).
- [ ] `TowerPositioningOverlay` triggers a React DOM-nesting error ("In HTML, … cannot be a descendant of …") when an airport loads. Find the nested element and fix it.
- [ ] **Datablocks at DPR 2 draw at half size and half position** (iPad and high-DPI remote browsers). `useBabylonScene.ts:268-272, 350-361` sizes the canvas to `clientWidth × devicePixelRatio` by hand, but `engine.resize()` on an engine created without `adaptToDeviceRatio` resets it to CSS size, while `guiTexture.scaleTo` keeps the GUI at DPR size (measured: canvas 1596×800, GUI 3192×1600). Same on Babylon 9.5 and 9.28. Fix via `D2`; verify by launching under CDP `Emulation.setDeviceMetricsOverride` `deviceScaleFactor: 2` and checking a label sits on its aircraft.
- [x] **Wave 1 — Babylon 9.28 landing** (PR #116), checked in the desktop app 2026-09-27: `A2.2`–`A2.8` all resolved in [rendering-engine-audit.md](./rendering-engine-audit.md). Found the DPR 2 label bug above (pre-existing) and dead OVC code (`G10`).

## Next up

- [ ] **Wave 2 — Cesium 1.145 and shadow darkness**: `A1.1`–`A1.6`, `B1`.
  - Shared: `package.json`, `CesiumViewer.tsx`, `ModelPreviewModal.tsx`, `useCesiumViewer.ts`, `useCesiumLighting.ts`, `terrain/FlatteningTerrainProvider.ts`, `useRenderCulling.ts`.
  - Gate: rendering review.
  - Command: `pnpm run check`.
  - Human: the user runs `pnpm run dev` for terrain flattening, the private-API sites, worker and imagery loading, and shadow darkness at load versus after a slider change.
- [ ] **Wave 3 — Babylon overlay fixes and dead hooks**: `B2`, `B3`, `B4`, `G5`, `G6`, `G7`, `G10`.
  - Shared: `useBabylonOverlay.ts`, `useBabylonCameraSync.ts`, `useBabylonRootNode.ts`, `useBabylonLabels.ts`, `useBabylonPrecipitation.ts`, `CesiumViewer.tsx`, `types/babylon.ts`.
  - Gate: code review.
  - Command: `pnpm run check`.
  - Human: rain renders with the network off (`B4`); labels and fog still track the camera (`B2`).
- [ ] **Wave 4 — Babylon quick wins**: `D1`–`D6`. Needs Wave 1.
  - Shared: the 9 `import * as BABYLON` files, `useBabylonScene.ts`, `useBabylonLabels.ts`.
  - Gate: rendering review.
  - Command: `pnpm run check`; `pnpm run vite:build` for the chunk size before and after `D1`.
  - Human: label legibility over bright imagery (`D3`); frame time with and without the invalidate-rect optimization (`D5`).
- [ ] **Wave 5 — Render resolution and Cesium quick wins**: `C1`–`C6`, `D7` (one slider drives `resolutionScale` and Babylon hardware scaling).
  - Shared: `useCesiumViewer.ts`, `CesiumViewer.tsx`, `useAircraftModels.ts`, `useGroundAircraftTerrain.ts`, `useRenderCulling.ts`, settings (via the `add-setting` skill).
  - Gate: rendering review, UI review for the new setting.
  - Command: `pnpm run check`.
  - Human: silhouettes, pick-based slew, and the resolution slider on desktop and iPad.
- [ ] **Wave 6 — Cesium-side dead code**: `G1`, `G2`, `G3`, `G4`, `G8`, `G9`.
  - Shared: `package.json`, `utils/tileCache.ts`, `utils/cesiumFrustumPatch.ts`, `hooks/useCesiumStereo.ts`, `CesiumViewer.tsx`, `utils/gearAnimationController.ts`, `constants/realtraffic.ts`.
  - Gate: code review.
  - Command: `pnpm run check`.
- [ ] **Wave 7 — Documentation drift**: `H1`–`H6`, after Waves 3 and 6 (they remove hooks the docs describe), plus:
  - [ ] Re-read `docs/inset-architecture.md` against the 31 commits on its 9 named files since 2026-01-14; the broadcast files it names (`AircraftBroadcastService.ts`, `aircraft-broadcast.worker.ts`, `broadcast-encoder.worker.ts`, `useBroadcastAircraft.ts`, `types/broadcast.ts`) were removed in `bf5cf13`.
  - [ ] Re-read `docs/remote-access-architecture.md` against the 24 commits on its 12 named files since 2026-01-15.
  - Shared: `docs/architecture.md`, `docs/coordinate-systems.md`, `docs/inset-architecture.md`, `docs/remote-access-architecture.md`.
  - Gate: docs review.
  - Command: re-run the doc-drift scan (`plan-doc-hygiene` skill, step 5) and confirm both rows clear.
- [ ] **Wave 8 — vNAS dual-source and reconnect**: the six open lines of the Testing Checklist in `../towercab-3d-vnas/docs/vnas-udp-integration-plan.md` (reconnect backoff, clean reconnect, boundary transition, stale-VATSIM "jarring" rejection, per-aircraft source indicator, Sweatbox). Independent of the rendering waves.
  - Shared: `stores/aircraftTimelineStore.ts`, `constants/aircraft-timeline.ts`, `stores/vnasStore.ts`, `src-tauri/src/vnas.rs`, and the crate's `src/lib.rs`.
  - Gate: code review; aviation review for the boundary behaviour.
  - Command: `pnpm run check`; in the crate, `cargo fmt`, `cargo clippy`, `cargo test`.
  - Human: the user runs `pnpm run dev:vnas` against a live session and follows an aircraft across the 30 NM boundary.
- [ ] **Wave 9 — macOS runtime checks**: [macos-release.md](./macos-release.md), all five. Human checks only, on Apple Silicon hardware with the released `.dmg`.

## Design track

- [ ] Larger Cesium and Babylon opportunities that need a design before they take a wave slot: `E1`–`E3`, `F1`–`F3` in [rendering-engine-audit.md](./rendering-engine-audit.md).

## Blockers

_(none)_
