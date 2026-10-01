# TowerCab 3D — Main Plan
<!-- plan-doc-hygiene: 2026-09-30 f4a7bd9 towercab-3d-vnas@fd35095 -->

Entry point for all in-flight work. Each task is a checkbox; detail lives in the linked subplan. Completed subplans move to `docs/plans/archive/`.

Open work is grouped into **waves**: release-sized bundles that share owning files, so one pass reads those files once and one review covers the bundle. Work the waves in order unless a wave says it is independent. Item IDs (`A1.3`, `G5`, …) point at lines in the linked subplan. The private vNAS crate is the sibling repo `../towercab-3d-vnas`.

**Verification, every wave:** `pnpm run check` (Biome, TypeScript, Rust). App checks run in the desktop app through the `tauri-app` MCP (launch recipe and the `window.__tc3d` harness in `CLAUDE.md`, "E2E testing via Playwright MCP"); particles and other additive effects need a video or `__tc3d.readPixels`, not a screenshot.

## Current focus

- [ ] **YAAT Local and YAAT1 vNAS environments** (user 2026-09-30): join a CRC session on a YAAT training server as a direct connection (no negotiate, no UDP). YAAT1 signs in with VATSIM through yaat-server's `/vnas/auth/refresh` fallback. YAAT Local appears only when a dev server answers the configurable URL, and signs in with `/vnas/auth/dev-login` using the stored login's CID or a typed one. Status: TowerCab (`128784d`) and crate (`92dfaa8`, `ddcacae`) landed; yaat-server + yaat docs committed on the `towercab-yaat` pair (`X:/dev/yaat.wt/towercab-yaat`, 2 commits ahead of yaat `main`), not landed. E2E against a local yaat-server passed 2026-09-30 (CRC OAK_GND session, TowerCab joined, OAK traffic rendered at 1 s, `HandleSessionEnded` on CRC exit, YAAT Local hidden once the server stopped). Left: land the pair, deploy yaat-server to yaat1.leftos.dev, then check YAAT1 sign-in with a real VATSIM login.
- [ ] **vNAS session lifecycle** — branch: feat/vnas-session-lifecycle (towercab-3d + crate). Rulings (user 2026-09-30): the in-flight guard lives in `vnas.rs` (authoritative, covers the remote-browser path) with a frontend in-flight map to cut redundant invokes; the replace-variant `vnas_subscribe` goes; on session end vNAS-only aircraft are dropped at once and vNAS points stripped from aircraft VATSIM also reports; the crate stops UDP and drops the session on `HandleSessionEnded`.
  - [ ] vNAS facility subscribe races: at KOAK, `useVnasSubscription` sent `Subscribe` for OAK three times before `subscribedFacilities` updated (`vnas_subscribe_facility`'s `is_subscribed` guard runs before the first call finishes), and yaat-server keeps each copy, so every Tower Cab update arrived three times (seen in the YAAT Local E2E, 2026-09-30). Guard the in-flight subscribe in `vnas.rs`/`vnasStore.ts`; YAAT's side is filed in `yaat/docs/plans/MAIN.md`.
  - [ ] After a vNAS session ends (`HandleSessionEnded`, crate `src/lib.rs:876`), the last aircraft stayed in the Nearby Aircraft list (PCM8702 in the YAAT Local E2E, 2026-09-30). The timeline prunes after 30–40 s (`AIRCRAFT_TIMEOUT`), so something kept it alive; `vnas.rs:811-819` also writes the session state to a detached status copy, leaving Rust's status and `subscribed_facilities` stale. Clear on session end per the rulings above.
- [ ] Follow-up to the YAAT environments: if yaat-server adds Tower Cab over UDP with negotiated joiners (`yaat/docs/plans/towercab-udp.md` on the `towercab-yaat` branch, option 4(a)), shrink the crate's `Environment::is_yaat()` special case to URLs and token source only.
- [ ] `TowerPositioningOverlay` triggers a React DOM-nesting error ("In HTML, … cannot be a descendant of …") when an airport loads. Find the nested element and fix it.

## Next up

- [ ] **Wave 2 — Cesium 1.145 and shadow darkness** — branch: feat/cesium-1.145: `A1.1`–`A1.6`, `B1`.
  - Shared: `package.json`, `CesiumViewer.tsx`, `ModelPreviewModal.tsx`, `useCesiumViewer.ts`, `useCesiumLighting.ts`, `terrain/FlatteningTerrainProvider.ts`, `useRenderCulling.ts`.
  - Gate: rendering review.
  - Command: `pnpm run check`.
  - App check (`tauri-app` MCP): terrain flattening, the private-API sites, worker and imagery loading, and shadow darkness at load versus after a slider change.
- [ ] **Wave 3 — Babylon overlay fixes and dead hooks**: `B2`, `B3`, `B4`, `G5`, `G6`, `G7`, `G10`.
  - Shared: `useBabylonOverlay.ts`, `useBabylonCameraSync.ts`, `useBabylonRootNode.ts`, `useBabylonLabels.ts`, `useBabylonPrecipitation.ts`, `CesiumViewer.tsx`, `types/babylon.ts`.
  - Gate: code review.
  - Command: `pnpm run check`.
  - App check (`tauri-app` MCP): rain renders with the network off (`B4`); labels and fog still track the camera (`B2`).
- [ ] **Wave 4 — Babylon quick wins**: `D1`–`D6`.
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
- [ ] **Wave 7 — Documentation**: `H1`–`H6` wait for Waves 3 and 6 (they remove hooks the docs describe); the other lines can go first.
  - [ ] Reshape `docs/architecture.md` (982 lines of data flows) to the user-level architecture entry point (`~/.claude/docs/templates/ARCHITECTURE.md`): add a Task Index and a Layers section, keep "Hook Call Order (Critical!)" as Integration Footguns, and move each flow's detail into its own subsystem doc. Task Index rows explorers asked for: "Babylon overlay DPR or label screen size" → `useBabylonScene.ts`, `useBabylonLabels.ts`, `useCesiumLabels.ts`, `CesiumViewer.tsx` (click hit-test × DPR), `stores/datablockPositionStore.ts`, `hooks/useAgentHarness.ts`.
  - [ ] The repo has no `docs/README.md` start page or glossary: terms like vNAS environment, sweatbox, YAAT and direct connection (the YAAT environments' no-negotiate hub connection, `../towercab-3d-vnas/CLAUDE.md` "Environment URLs") have no entry. Add both, and link the architecture doc from the README.
  - [ ] Re-read `docs/inset-architecture.md` against the 31 commits on its 9 named files since 2026-01-14; the broadcast files it names (`AircraftBroadcastService.ts`, `aircraft-broadcast.worker.ts`, `broadcast-encoder.worker.ts`, `useBroadcastAircraft.ts`, `types/broadcast.ts`) were removed in `bf5cf13`.
  - [ ] Re-read `docs/remote-access-architecture.md` against the 26 commits on its 12 named files since 2026-01-15.
  - Shared: `docs/architecture.md`, `docs/coordinate-systems.md`, `docs/inset-architecture.md`, `docs/remote-access-architecture.md`, `docs/README.md`.
  - Gate: docs review.
  - Command: re-run the doc-drift scan (`plan-doc-hygiene` skill, step 5) and confirm both rows clear.
- [ ] **Wave 8 — vNAS dual-source and reconnect** — branch: feat/vnas-reconnect: the six open lines of the Testing Checklist in `../towercab-3d-vnas/docs/vnas-udp-integration-plan.md` (reconnect backoff, clean reconnect, boundary transition, stale-VATSIM "jarring" rejection, per-aircraft source indicator, Sweatbox). Independent of the rendering waves.
  - [ ] Re-read `../towercab-3d-vnas/docs/vnas-udp-integration-plan.md` against the 6 commits on its 8 named files since 2026-09-27 (the YAAT environments and their direct connection). Its 18 unresolved tokens are upstream reference sources (`messaging-master/…`, `vnas-printer-master/…`) and crate-prefixed paths, not removed files.
  - [ ] The crate has no `Unsubscribe`: `vnas_unsubscribe_facility` (`src-tauri/src/vnas.rs:907-922`) only edits the local list, so the server keeps every Tower Cab subscription across an airport switch and back. Add one if the hub offers it. Starts after feat/vnas-session-lifecycle merges.
  - Shared: `stores/aircraftTimelineStore.ts`, `constants/aircraft-timeline.ts`, `stores/vnasStore.ts`, `src-tauri/src/vnas.rs`, and the crate's `src/lib.rs`.
  - Gate: code review; aviation review for the boundary behaviour.
  - Command: `pnpm run check`; in the crate, `cargo test` (its prek hook runs fmt and clippy on commit).
  - Human: the user runs `pnpm run dev:vnas` against a live session and follows an aircraft across the 30 NM boundary.
- [ ] **Wave 9 — macOS signing and runtime checks**: [macos-release.md](./macos-release.md): the four signing lines (secrets, `release-macos.yml`, first signed release, workaround notes; guide from PR #112 in [macos-code-signing.md](../macos-code-signing.md)) and the five runtime checks. Mostly human: the secrets need the Mac keychain export, the checks need Apple Silicon hardware with the released `.dmg`.
- [ ] **Wave 10 — Cleanup singles** (pre-existing; independent, any order):
  - [ ] Vite `INEFFECTIVE_DYNAMIC_IMPORT` warnings: `stores/airportStore.ts` (dynamic in `vnasStore.ts`), `utils/terrainCache.ts` (dynamic in `CesiumViewer.tsx`), `services/MigrationService.ts` (dynamic in `ControlsBar.tsx`) are also imported statically. Make each import static or truly lazy.
  - [ ] pnpm skips protobufjs's build script ("Ignored build scripts: protobufjs@8.0.0"). Decide with `pnpm approve-builds` whether it needs to run.
  - [ ] `cargo fmt --check` fails at HEAD on `src-tauri/src/lib.rs` (~:23, :125, :910), `mods.rs`, `msfs.rs` and `server.rs` with the pinned rustfmt; no hook or CI step runs fmt. Format those files in one commit, then add `cargo fmt --check` to CI and to the prek hooks.
  - [ ] `src-tauri/src/msfs.rs:~2012` `test_aig_crj200_indexing_with_shared_model` reads the real MSFS Community folder on the machine (`X:\Games\MSFlightSimPackages2024\Community\aig-aitraffic-oci`) and fails where the CRJ-200 GLTF resolves under `AIGAIM_RFSL_Challenger850\model.200\`; make it fixture-based or `#[ignore]` it with a reason (seen 2026-09-30).
  - [ ] Every cargo gate (`check`, `clippy`, `test`) on a fresh clone fails in the Tauri build script until `dist/` exists (`glob pattern ../dist/**/* path not found`); document `pnpm run vite:build` as a prerequisite in `CLAUDE.md` or make the build script tolerate a missing `dist/` for non-bundle builds (seen 2026-09-30).
  - [ ] `.claude/skills/prepare-release/SKILL.md:103` runs the fixers `pnpm biome check src/ --fix` and `cargo fmt` outside the gate; wrap them in `pwsh tools/gate.ps1` as its other check steps are.
  - [ ] `useCesiumLabels.ts:476` lays labels out against `window.innerWidth`, which is wrong for inset viewports (their own width is smaller).
  - [ ] `towercab-3d-vnas` `main` has no branch protection. Rulesets on a private repo need a paid plan; check the plan, then add the same force-push and deletion block `main` has here (ruleset "Protect main").

## First release after 2026-09-27

- [ ] The next `v*` tag is the first run of: `tauri-action` v1 in `release.yml` and `release-macos.yml` (v1 now overwrites the name and body of an existing release, so check the notes the `prepare-release` skill writes survive), and the pinned-toolchain step (`rustup toolchain install` + `rustup target add`) in both release workflows. Watch both runs and fix forward.

## Design track

- [ ] Larger Cesium and Babylon opportunities that need a design before they take a wave slot: `E1`–`E3`, `F1`–`F3` in [rendering-engine-audit.md](./rendering-engine-audit.md).

## Blockers

_(none)_
