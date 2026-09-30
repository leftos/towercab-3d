---
name: towercab-3d-nextup
description: Profile for the user-level `nextup` skill in the towercab-3d repo (with its sibling towercab-3d-vnas) — loaded by `nextup` at its step 0 for this project's plan convention, agents, gates, docs map and landing path. Not a loop of its own; invoke `/nextup`.
---

# towercab-3d profile for `nextup`

The generic loop is the user-level `nextup` skill; this file supplies only what is towercab-3d-specific.

## Plan and tracker

- Index: `docs/plans/MAIN.md`. Sections in priority order: `## Current focus`, then `## Next up` (waves, top to bottom; a wave is a release-sized bundle sharing owning files, its item IDs pointing into the linked subplan, e.g. `rendering-engine-audit.md`), then `## First release after …`, then `## Design track` (items that need a design before they take a wave slot). `## Blockers` is read before dispatching anything.
- siblings: ../towercab-3d-vnas
- `../towercab-3d-vnas` (the private vNAS crate, default branch `main`) has no plan index or changelog of its own: this index plans it, and its open work is the Testing Checklist at the end of its `docs/vnas-udp-integration-plan.md`, indexed here as a wave.
- Pre-loop hooks: none.
- Finished-item convention: the landing commit **deletes the line** (git history keeps the item); a finished subplan moves to `docs/plans/archive/`. Review findings the item does not fix become lines in the same commit, in the wave that shares their files or under `## Next up`'s cleanup wave.
- Tracker: `gh issue list --repo leftos/towercab-3d --state open --json number,title,createdAt`. No triage skill; place issues by the user-level step-0 rule. Crate work cites towercab-3d issues (`Closes https://github.com/leftos/towercab-3d/issues/N`).
- Pull requests: `gh pr list --repo leftos/towercab-3d --state open --json number,title,author`, and the same with `--repo leftos/towercab-3d-vnas`.
- Hotspots (two items touching one wait on each other): `src/renderer/types/settings.ts` (every setting, and `DEFAULT_SETTINGS`), `src/renderer/stores/settingsStore.ts` (the persisted `version` and the migration repair list), `src/renderer/stores/viewportStore.ts`, `src/renderer/stores/vnasStore.ts`, `src-tauri/src/vnas.rs`, `src-tauri/src/lib.rs` (the `generate_handler!` list), `src/renderer/hooks/useBabylonOverlay.ts`, `src/renderer/components/CesiumViewer/CesiumViewer.tsx`.

## Agents and gates

- Explore: the user-level `Explore` (docs-first: `CLAUDE.md`, then `docs/architecture.md`, then the crate's `docs/ARCHITECTURE.md` for vNAS work). Rust second opinion: `rust-engineer`.
- Reviewers: `code-review` for every item, plus `tauri-settings-bridge-reviewer` whenever `GlobalSettings` in `src/renderer/types/settings.ts` or `src-tauri/src/settings.rs` changes, and `css-token-auditor` whenever a `.css` file or a `.tsx` with styling changes.
- A new setting follows the project skill `add-setting` (version bump, `DEFAULT_SETTINGS`, and the Rust struct for a global one); a release follows `prepare-release`.
- Gates, each through the repo's gate from the worktree root as `pwsh tools/gate.ps1 -Log .tmp/<name>.log -TimeoutSeconds <n> -Slot <slot> -- <command>`:
  - `pnpm biome check src/ tests/` (`light`, 300), `pnpm run typecheck` (`heavy`, 300), `pnpm vitest run` (`heavy`, 300; scoped to the item's test file during a step, whole suite once at the end)
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --release` (`heavy`, 900)
  - vNAS build of any change to `src-tauri/src/vnas.rs` or the crate: `node scripts/shipping/build/vnas.js cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features vnas -- -D warnings` (`heavy`, 900), with `TC3D_VNAS_CRATE_PATH` set to the pair's crate checkout while the crate change is unpushed (`CLAUDE.md`, "vNAS Integration")
  - Crate changes, in the crate root through its own `tools/gate.ps1`: `cargo test --release`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `cargo doc --no-deps` with no warnings
  - A commit (prek runs Biome, `tsc` and clippy on staged files) as `pwsh tools/gate.ps1 -Log .tmp/commit.log -TimeoutSeconds 900 -Slot heavy -- git commit -F .tmp/msg.txt`
- App checks: a user-visible change is proved in the running desktop app through the `tauri-app` MCP (launch recipe and `window.__tc3d` in `CLAUDE.md`, "E2E testing via Playwright MCP"), after telling the user "hands off"; stop the app when done. vNAS work against a local YAAT server and CRC runs through the `yaat-client-driver` MCP (`yaat/docs/client-driver-mcp.md`).
- Parent-side gate: `git -C <wt> status --short` in each half of the pair, and the same in both main checkouts.

## Traps

- Every cargo command fails in the Tauri build script until `dist/` exists (`glob pattern ../dist/**/* path not found`): run `pnpm run vite:build` once per fresh checkout or worktree, after `pnpm install --frozen-lockfile`.
- A `vnas.js` run that is killed (a stopped `pnpm run dev:vnas`) skips its `Cargo.lock` restore: check the diff is only the crate's dependencies, then `git checkout -- src-tauri/Cargo.lock`. `Cargo.lock` never lands carrying the private crate.
- `cargo fmt` over the whole crate rewrites `lib.rs`, `mods.rs`, `msfs.rs` and `server.rs`, which are unformatted at HEAD (backlogged): format only the files the item touches (`rustfmt --edition 2021 <file>`).
- `msfs::tests::test_aig_crj200_indexing_with_shared_model` reads the machine's MSFS Community folder and fails on this machine (backlogged); a red result there alone is not the item's.
- Windows: never `2>nul` in a command (it creates a file named `nul`); Edit/Write paths are absolute with backslashes (`CLAUDE.md`, "File Editing on Windows"). The crate's `CLAUDE.md` is CRLF; a script that rewrites it keeps CRLF.

## Concurrency

- Worktrees: a towercab-only item gets `../towercab-3d.wt/<slug>/towercab-3d` (`git worktree add ../towercab-3d.wt/<slug>/towercab-3d -b <slug> <base>`); an item that touches the crate gets the pair, adding `git -C ../towercab-3d-vnas worktree add "$(cd .. && pwd)/towercab-3d.wt/<slug>/towercab-3d-vnas" -b <slug> <crate base>` (the crate's `main` when it has no `<base>`), with `TC3D_VNAS_CRATE_PATH` pointing at that half. Record `branch.<slug>.base` / `branch.<slug>.landOn` in each half as the user-level `nextup` §3 **Base and target** says.
- Ceiling: **two** implementers. Each worktree compiles the Tauri app into its own `target/` (minutes cold), and most items share a hotspot above.
- Context: read the status bar's figure at every landing (`jq .context_window.used_percentage <scratchpad>/statusline.json`); past 40% the loop stops refilling, per the user-level `nextup`.
- Depends on, where file lists hide it: a crate API one item adds and a host (`src-tauri/src/vnas.rs`) item consumes; a Tauri command one item adds and a frontend item invokes; two items that each bump the settings `version` (the second rebases its bump).

## Docs map

| What changed | Owning docs |
|---|---|
| Anything a user sees or does | `CHANGELOG.md` (rules below), `USER_GUIDE.md` |
| A keyboard shortcut | `src/renderer/components/UI/KeyboardCheatsheet.tsx`, `USER_GUIDE.md` shortcuts section |
| A dev command, workflow, convention or trap | `CLAUDE.md` |
| A store, hook, data flow or rendering stage | `docs/architecture.md` (and `docs/coordinate-systems.md` for transforms) |
| A mod manifest field or model requirement | `MODDING.md` |
| Remote-browser behaviour or an HTTP endpoint | `docs/remote-access-architecture.md` |
| A vNAS environment, URL or connection step | the crate's `CLAUDE.md` "Environment URLs" and `docs/ARCHITECTURE.md` |
| A term used in a project-specific sense | the glossary in `docs/README.md` once it exists (backlogged); until then, the plan's backlog line for it |
| An item finished | its line deleted from `docs/plans/MAIN.md` |

## Landing

- Non-feature items: the orchestrator writes docs, the changelog bullet and the MAIN.md line deletion in the worktree, commits there, then `/ship` (with `## Ship` below): land onto the recorded `landOn`, gate on `main`, push, close the issue, remove each half of the pair and its branch once landed by the user-level `nextup` §4 step 6 check.
- An item under a feature marker (`branch: feat/<name>`) lands the same way onto the feature worktree, whose `landOn` is `feat/<name>`; `/ship` pushes the feature branch and watches its draft PR without merging it.
- Plan and docs-only commits go straight to `main` and are pushed.
- The main checkout hosts at most one implementer, and none while a gate runs there.

## Changelog

Read by the user-level `changelog-and-commit`; each rule names the step it adds to or overrides.

- Home: one `CHANGELOG.md` at the towercab-3d root, under `## [Unreleased]` with `### Added` / `### Changed` / `### Fixed` / `### Removed`. The crate has none; its user-visible effects are bulleted here.
- What belongs (Step 2): only what a user notices (`CLAUDE.md`, "Changelog Maintenance"). A fix to something unreleased folds into its Added bullet; `### Fixed` is only for a bug in a published release.
- Audience (Step 4): VATSIM tower controllers. No framework or crate names (Tauri, Cesium, Babylon, SignalR, Zustand); UI vocabulary stays (Settings → Graphics, the vNAS popover).
- Sibling (Step 0, Step 1): towercab-3d-vnas, snapshotted and scoped like towercab-3d: the `towercab-3d-vnas` beside the current checkout when it is on the same branch (a pair), else the main checkout's sibling.
- Commit order (Step 8): the crate first (its code and tests), then towercab-3d with the changelog, plan and host/frontend changes.

## Ship

Read by the user-level `ship`; each rule names the phase it adds to or overrides.

- Sibling (Phase 0): towercab-3d-vnas, shipped by the same phases. Source: the `towercab-3d-vnas` beside the worktree when on the same branch, else the main checkout's sibling. Target: always the main checkout's sibling, landing on its `main`.
- Push order (Phase 4): the crate first, then towercab-3d. `vnas.js` builds every vNAS build (CI included) against the crate's GitHub `main`, so a host change pushed before the crate API it calls breaks those builds.
- Gate (Phase 3), in towercab-3d's main checkout after a real cherry-pick: `pwsh tools/gate.ps1 -Log .tmp/check.log -TimeoutSeconds 900 -Slot heavy -- pnpm run check`; a crate change also its gates above in the crate's main checkout.
- Additive conflict files (Phase 2): `CHANGELOG.md`, `docs/plans/MAIN.md`, `USER_GUIDE.md`.
- Issues (Phase 5): the issue repository is always `leftos/towercab-3d`, also for a crate-only fix.
