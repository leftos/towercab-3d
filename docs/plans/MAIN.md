# TowerCab 3D — Main Plan
<!-- plan-doc-hygiene: 2026-09-27 0275468 towercab-3d-vnas@1145753 -->

Entry point for all in-flight work. Each task is a checkbox; detail lives in the linked subplan. Completed subplans move to `docs/plans/archive/`.

Open work is grouped into **waves**: release-sized bundles that share owning files, so one pass reads those files once and one review covers the bundle. Work the waves in order unless a wave says it is independent. Item IDs (`A2.3`, `G5`, …) point at lines in the linked subplan. The private vNAS crate is the sibling repo `../towercab-3d-vnas`.

**Verification, every wave:** `pnpm run check` (Biome, TypeScript, Rust). App checks run in the desktop app through the `tauri-app` MCP (launch recipe in `CLAUDE.md`, "E2E testing via Playwright MCP"); particles and other additive effects need a video or `engine.readPixels`, not a screenshot.

## Current focus

Work these in order: the harness first, since the DPR fix is verified with it.

- [x] **Agent test harness for the `tauri-app` MCP** (shipped 2026-09-28: `useAgentHarness.ts`, documented in CLAUDE.md's E2E section; checked live at KSFO): a dev-only (`import.meta.env.DEV`) `window.__tc3d` exposing the Cesium viewer, Babylon scene and engine, and the viewport and weather stores; `camera.get()` / `camera.set({ heading, pitch, fov })` / `lookAt(lat, lon, height)` over `viewportStore`; and `project(lat, lon, height)` → page coordinates. Friction it removes, from the Wave 1 run:
  - Babylon was reachable only by `import()` of `engineStore.js` at its exact Vite URL, `?v=<hash>` included; the hash changes on every dependency re-optimize, and `performance.getEntriesByType('resource')` caps at 250 entries, so the URL had to be read from the console log.
  - No handle on the Cesium camera: heading was scraped from the `HDG` status-bar text, and aiming meant timed arrow-key presses in a loop.
  - Finding an object on screen took hand-written `Vector3.Project` math; Babylon's `camera.isInFrustum` reported the on-screen tower as not visible, so it is not evidence of visibility.
  - Add a `readPixels` helper: rain is drawn additively with alpha 0, so CDP screenshots and canvas `drawImage` alpha both miss it.
  - Document in `CLAUDE.md` (E2E section): Shift+Home resets the camera to the app default ("Defaults" is the user default); the dev mods folder is `src-tauri/target/debug/mods` (clone `github.com/leftos/tc3d-mod-koak-tower` there for a tower); the weather debug panel's Apply replaces all weather, clouds included; CDP `Emulation.*` overrides last only for the `browser_run_code_unsafe` call that sets them; an airport switch stalls page timers ~10 s; say "hands off" to the user before driving the window.
- [ ] **Datablocks at DPR 2 draw at half size and half position** (iPad and high-DPI remote browsers). `useBabylonScene.ts:268-272, 350-361` sizes the canvas to `clientWidth × devicePixelRatio` by hand, but `engine.resize()` on an engine created without `adaptToDeviceRatio` resets it to CSS size, while `guiTexture.scaleTo` keeps the GUI at DPR size (measured: canvas 1596×800, GUI 3192×1600). Same on Babylon 9.5 and 9.28. Fix via `D2`; verify by launching under CDP `Emulation.setDeviceMetricsOverride` `deviceScaleFactor: 2` and checking a label sits on its aircraft.
- [ ] **YAAT Local and YAAT1 vNAS environments** (user 2026-09-30): join a CRC session on a YAAT training server as a direct connection (no negotiate, no UDP). YAAT1 signs in with VATSIM through yaat-server's `/vnas/auth/refresh` fallback. YAAT Local appears only when a dev server answers the configurable URL, and signs in with `/vnas/auth/dev-login` using the stored login's CID or a typed one. Status: TowerCab and crate (`92dfaa8`, `ddcacae`) committed; yaat-server + yaat docs committed on the `towercab-yaat` pair (`X:/dev/yaat.wt/towercab-yaat`), not landed. E2E against a local yaat-server passed 2026-09-30 (CRC OAK_GND session, TowerCab joined, OAK traffic rendered at 1 s, `HandleSessionEnded` on CRC exit, YAAT Local hidden once the server stopped). Left: land the pair, deploy yaat-server to yaat1.leftos.dev, then check YAAT1 sign-in with a real VATSIM login.
- [ ] vNAS facility subscribe races: at KOAK, `useVnasSubscription` sent `Subscribe` for OAK three times before `subscribedFacilities` updated (`vnas_subscribe_facility`'s `is_subscribed` guard runs before the first call finishes), and yaat-server keeps each copy, so every Tower Cab update arrived three times (seen in the YAAT Local E2E, 2026-09-30). Guard the in-flight subscribe in `vnas.rs`/`vnasStore.ts`; YAAT's side is filed in `yaat/docs/plans/MAIN.md`.
- [ ] After a vNAS session ends (`HandleSessionEnded`), the last aircraft stayed in the Nearby Aircraft list (PCM8702 in the YAAT Local E2E, 2026-09-30); check whether they age out or should be cleared on session end.
- [ ] Follow-up to the YAAT environments: if yaat-server adds Tower Cab over UDP with negotiated joiners (`yaat/docs/plans/towercab-udp.md`, option 4(a)), shrink the crate's `Environment::is_yaat()` special case to URLs and token source only.
- [ ] `TowerPositioningOverlay` triggers a React DOM-nesting error ("In HTML, … cannot be a descendant of …") when an airport loads. Find the nested element and fix it.
- [x] **Wave 1 — Babylon 9.28 landing** (PR #116), checked in the desktop app 2026-09-27: `A2.2`–`A2.8` all resolved in [rendering-engine-audit.md](./rendering-engine-audit.md). Found the DPR 2 label bug above (pre-existing) and dead OVC code (`G10`). Getting `main` green on Tauri 2.12 also took PR #117 (plugin minors pinned on both sides, NSIS template merged with upstream 2.12).

## Next up

- [ ] **Wave 2 — Cesium 1.145 and shadow darkness**: `A1.1`–`A1.6`, `B1`.
  - Shared: `package.json`, `CesiumViewer.tsx`, `ModelPreviewModal.tsx`, `useCesiumViewer.ts`, `useCesiumLighting.ts`, `terrain/FlatteningTerrainProvider.ts`, `useRenderCulling.ts`.
  - Gate: rendering review.
  - Command: `pnpm run check`.
  - App check (`tauri-app` MCP): terrain flattening, the private-API sites, worker and imagery loading, and shadow darkness at load versus after a slider change.
- [ ] **Wave 3 — Babylon overlay fixes and dead hooks**: `B2`, `B3`, `B4`, `G5`, `G6`, `G7`, `G10`.
  - Shared: `useBabylonOverlay.ts`, `useBabylonCameraSync.ts`, `useBabylonRootNode.ts`, `useBabylonLabels.ts`, `useBabylonPrecipitation.ts`, `CesiumViewer.tsx`, `types/babylon.ts`.
  - Gate: code review.
  - Command: `pnpm run check`.
  - App check (`tauri-app` MCP): rain renders with the network off (`B4`); labels and fog still track the camera (`B2`).
- [ ] **Wave 4 — Babylon quick wins**: `D1`–`D6`. Needs Wave 1.
  - Shared: the 9 `import * as BABYLON` files, `useBabylonScene.ts`, `useBabylonLabels.ts`.
  - Gate: rendering review.
  - Command: `pnpm run check`; `pnpm run vite:build` for the chunk size before and after `D1`.
  - App check (`tauri-app` MCP): label legibility over bright imagery (`D3`); frame time with and without the invalidate-rect optimization (`D5`).
- [ ] **Wave 5 — Render resolution and Cesium quick wins**: `C1`–`C6`, `D7` (one slider drives `resolutionScale` and Babylon hardware scaling).
  - Shared: `useCesiumViewer.ts`, `CesiumViewer.tsx`, `useAircraftModels.ts`, `useGroundAircraftTerrain.ts`, `useRenderCulling.ts`, settings (via the `add-setting` skill).
  - Gate: rendering review, UI review for the new setting.
  - Command: `pnpm run check`.
  - App check (`tauri-app` MCP): silhouettes, pick-based slew, and the resolution slider; the user checks it on an iPad.
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
  - Command: `pnpm run check`; in the crate, `cargo test` (its prek hook runs fmt and clippy on commit).
  - Human: the user runs `pnpm run dev:vnas` against a live session and follows an aircraft across the 30 NM boundary.
- [ ] **Wave 9 — macOS runtime checks**: [macos-release.md](./macos-release.md), all five. Human checks only, on Apple Silicon hardware with the released `.dmg`.

- [ ] **Wave 10 — Cleanup singles** (pre-existing; independent, any order):
  - [x] actionlint SC2086: unquoted `$GITHUB_OUTPUT` in the "Check vNAS repo access" and signing-check steps of `.github/workflows/build.yml` and `release.yml`. Shipped 2026-09-28 in `77d3551`; actionlint is clean on every workflow.
  - [ ] Vite `INEFFECTIVE_DYNAMIC_IMPORT` warnings: `stores/airportStore.ts` (dynamic in `vnasStore.ts`), `utils/terrainCache.ts` (dynamic in `CesiumViewer.tsx`), `services/MigrationService.ts` (dynamic in `ControlsBar.tsx`) are also imported statically. Make each import static or truly lazy.
  - [ ] pnpm skips protobufjs's build script ("Ignored build scripts: protobufjs@8.0.0"). Decide with `pnpm approve-builds` whether it needs to run.
  - [ ] `src-tauri/src/lib.rs` has 72 rustfmt differences. Run `cargo fmt` over `src-tauri` in its own commit, then add `cargo fmt --check` to CI and a fmt hook to `.pre-commit-config.yaml`.
  - [x] A clone without the untracked `src-tauri/.cargo/config.toml` (the local vNAS `[patch]`) resolves `towercab-3d-vnas` from git and rewrites `Cargo.lock`, so `cargo build` and the clippy hook dirty the lockfile. Decide how public contributors should build. Shipped 2026-09-28: the manifest depends on the in-repo `vnas-stub`, and vNAS builds patch in the private crate through `scripts/shipping/build/vnas.js`; a build with no repo access was verified.
  - [ ] `towercab-3d-vnas` `main` has no branch protection. Rulesets on a private repo need a paid plan; check the plan, then add the same force-push and deletion block `main` has here (ruleset "Protect main").

- [ ] Reshape `docs/architecture.md` (982 lines of data flows) to the user-level architecture entry point (`~/.claude/docs/templates/ARCHITECTURE.md`): add a Task Index and a Layers section, keep "Hook Call Order (Critical!)" as Integration Footguns, and move each flow's detail into its own subsystem doc.
- [ ] `src-tauri/src/msfs.rs:~2012` `test_aig_crj200_indexing_with_shared_model` reads the real MSFS Community folder on the machine (`X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci`) and fails where the CRJ-200 GLTF resolves under `AIGAIM_RFSL_Challenger850\model.200\`; make it fixture-based or `#[ignore]` it with a reason (seen 2026-09-30).
- [ ] `cargo fmt --check` fails at HEAD on `src-tauri/src/lib.rs` (~:23, :125, :910), `mods.rs`, `msfs.rs` and `server.rs` with the pinned rustfmt; no hook runs fmt. Format those files in one commit and add `cargo fmt --check` to the prek hooks (seen 2026-09-30).
- [ ] Every cargo gate (`check`, `clippy`, `test`) on a fresh clone fails in the Tauri build script until `dist/` exists (`glob pattern ../dist/**/* path not found`); document `pnpm run vite:build` as a prerequisite or make the build script tolerate a missing `dist/` for non-bundle builds (seen 2026-09-30).
- [ ] The repo has no `docs/README.md` start page or glossary: terms like vNAS environment, sweatbox, YAAT and direct connection (the YAAT environments' no-negotiate hub connection, `../towercab-3d-vnas/CLAUDE.md` "Environment URLs") have no entry. Add both, and link the architecture doc from the README.
- [ ] `.claude/skills/prepare-release/SKILL.md` step 7.3 runs the fixers `pnpm biome check src/ --fix` and `cargo fmt` outside the gate; wrap them in `pwsh tools/gate.ps1` as steps 101 and 108 now are.

## First release after 2026-09-27

- [ ] The next `v*` tag is the first run of: `tauri-action` v1 in `release.yml` and `release-macos.yml` (v1 now overwrites the name and body of an existing release, so check the notes the `prepare-release` skill writes survive), and the pinned-toolchain step (`rustup toolchain install` + `rustup target add`) in both release workflows. Watch both runs and fix forward.

## Design track

- [ ] Larger Cesium and Babylon opportunities that need a design before they take a wave slot: `E1`–`E3`, `F1`–`F3` in [rendering-engine-audit.md](./rendering-engine-audit.md).

## Blockers

_(none)_
