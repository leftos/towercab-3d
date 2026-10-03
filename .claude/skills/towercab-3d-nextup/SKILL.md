---
name: towercab-3d-nextup
description: Profile for the user-level `nextup` skill in the towercab-3d repo (with its sibling towercab-3d-vnas) — loaded by `nextup` at its step 0 for this project's plan convention, agents, gates, docs map and landing path. Not a loop of its own; invoke `/nextup`.
---

# towercab-3d profile for `nextup`

The generic loop is the user-level `nextup` skill; this file supplies only what is towercab-3d-specific.

siblings: ../towercab-3d-vnas
linear: towercab-3d

## Plan and tracker

- The plan lives in Linear: every task is a Linear issue in team TC3D, per `~/.claude/docs/plan-operations.md`; `docs/plans/MAIN.md` is its generated snapshot, never edited by hand. Project order, which is the order the queue is worked: `Current focus`, `vNAS session lifecycle`, then the waves (`Cesium 1.145 and shadow darkness` through `Cleanup singles`; a wave's item IDs point into its linked subplan, e.g. `rendering-engine-audit.md`), then `First release after 2026-09-27`, then `Design track` (items that need a design before they take a project slot). Blocked issues are read before dispatching anything.
- `../towercab-3d-vnas` (the private vNAS crate, default branch `main`) has no plan or changelog of its own: team TC3D plans it, and its open work is the Testing Checklist at the end of its `docs/vnas-udp-integration-plan.md`, the project `vNAS dual-source and reconnect`.
- Pre-loop hooks: none.
- An item **land**s after its commit; a finished subplan moves to `docs/plans/archive/`. Review findings the item does not fix get an **add**, in the project that shares their files, else in `Cleanup singles`.
- Tracker: **triage** as plan-operations says (GitHub issues reach the team through Linear's sync; an untriaged one is top-level with no project), each placed in the project that shares its files, else in `Cleanup singles`. Crate work cites towercab-3d issues with `Refs https://github.com/leftos/towercab-3d/issues/N`, never a closing word: GitHub closes a cross-repo issue a pushed commit names with one, and only the release closes an issue here.
- Release blockers: whenever an **add**, a **split** or a ruling makes an open issue wait on another (a sub-issue of an issue in the open release, or a fix that issue needs first), the blocker joins the open release too, and the relation is recorded with the Linear MCP `save_issue` and `blocks: ["<the release issue>"]`. Every pipeline's open release is named `vNext`, so look its id up each time with `list_releases` (`pipeline: "towercab-3d"`, `query: "vNext"`) and pass that id in `addReleases`; never the name, and never a stored id, since each release cut opens a new `vNext`.
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
  - A commit (prek runs Biome, `tsc` and clippy on staged files) as `pwsh tools/gate.ps1 -Log .tmp/commit.log -TimeoutSeconds 300 -Slot heavy -- git commit -F .tmp/msg-<slug>.txt`, the message written with the Write tool to that file, new to this commit (the slug from the subject), and committed in a later turn than the Write
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
| A term used in a project-specific sense | the glossary in `docs/README.md` once it exists (an open issue); until then, a comment on that issue |
| An item finished | its issue **land**ed after the commit |

## Landing

- Non-feature items: the orchestrator writes docs and the changelog bullet in the worktree, commits there (a `Refs: TC3D-<n>` trailer per issue), then `/ship` (with `## Ship` below): land onto the recorded `landOn`, gate on `main`, push, post the audit comment on the issue and leave it open (the release closes it: `prepare-release` moves it to Done), remove each half of the pair and its branch once landed by the user-level `nextup` §4 step 6 check.
- An item under a feature marker (`branch: feat/<name>`) lands the same way onto the feature worktree, whose `landOn` is `feat/<name>`; `/ship` pushes the feature branch and watches its draft PR without merging it; the item is **land**ed with the note `on feat/<name>, ships with #N`.
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
- Gate (Phase 3), in towercab-3d's main checkout after a real cherry-pick: `pwsh tools/gate.ps1 -Log .tmp/check.log -TimeoutSeconds 600 -Slot heavy -- pnpm run check`; a crate change also its gates above in the crate's main checkout.
- Additive conflict files (Phase 2): `CHANGELOG.md`, `USER_GUIDE.md`. A conflict on the snapshot `docs/plans/MAIN.md` takes either side and runs **snapshot** again.
- Issues (Phase 5): the issue repository is always `leftos/towercab-3d`, also for a crate-only fix. This repo has a release pipeline, so ship posts the audit comment and never closes the issue: it stays Landed until `linear release complete` moves it to Done, which closes it on GitHub through the sync.
