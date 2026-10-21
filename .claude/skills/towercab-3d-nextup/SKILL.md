---
name: towercab-3d-nextup
description: Profile for the user-level `nextup` skill in the towercab-3d repo (with its sibling towercab-3d-vnas) — loaded by `nextup` at its step 0 for this project's plan convention, agents, gates, docs map and landing path. Not a loop of its own; invoke `/nextup`.
---

# towercab-3d profile for `nextup`

The generic loop is the user-level `nextup` skill; this file supplies only what is towercab-3d-specific.

siblings: ../towercab-3d-vnas
linear: towercab-3d

## Plan and tracker

- The plan lives in Linear: every task is a Linear issue in team TC3D, per `~/.claude/docs/plan-operations.md`; `docs/plans/MAIN.md` is its generated snapshot, never edited by hand. Project order, which is the order the queue is worked: `Current focus`, `Babylon to Cesium migration` (the owner's #1, design `docs/plans/babylon-to-cesium.md`; M2 on `feat/cesium-weather`), `OSM buildings` (#2, design `docs/plans/osm-buildings.md`), `vNAS session lifecycle`, then the waves (`Cesium 1.145 and shadow darkness` through `Cleanup singles`; a wave's item IDs point into its linked subplan, e.g. `rendering-engine-audit.md`), then `Settings drawer` (on `feat/settings-drawer`, design `docs/plans/settings-drawer.md`), then `First release after 2026-09-27`, then `Design track` (items that need a design before they take a project slot). Blocked issues are read before dispatching anything.
- `../towercab-3d-vnas` (the private vNAS crate, default branch `main`) has no plan or changelog of its own: team TC3D plans it, and its open work is the Testing Checklist at the end of its `docs/vnas-udp-integration-plan.md`, the project `vNAS dual-source and reconnect`.
- Pre-loop hook: **trade app-driving lessons with the other projects.** Run the user-level `conventions-sync` skill once with `--stack driving`, before the queue is read. When it changed anything, `docs/DRIVING_CONVENTIONS.md` and `docs/.conventions-sync-driving.json` land on main as their own `docs:` commit, staged by name, before the first worktree is cut; the skill commits its side of `~/.claude` itself.
- An item **land**s after its commit; a finished subplan moves to `docs/plans/archive/`. Review findings the item does not fix get an **add**, in the project that shares their files, else in `Cleanup singles`.
- Tracker: **triage** as plan-operations says (GitHub issues reach the team through Linear's sync; an untriaged one is top-level with no project), each placed in the project that shares its files, else in `Cleanup singles`. Crate work cites towercab-3d issues with `Refs https://github.com/leftos/towercab-3d/issues/N`, never a closing word: GitHub closes a cross-repo issue a pushed commit names with one, and here an issue closes only when it is **land**ed (Done, closed on GitHub through the sync).
- Releases: the pipeline `towercab-3d` keeps two placeholders, `vNext` (the release being prepared) and `vNext+1` (the one after); an issue joins with `linear release add towercab-3d <ID>...`, or `--next` for `vNext+1`. Release membership is the record of what the cut waits on, as plan-operations' "Release fence" says: work the owner authorizes joins `vNext` the moment it is authorized, an authorized project with every open issue it holds.
- Release blockers: whenever an **add**, a **split** or a ruling makes an open issue wait on another (a sub-issue of an issue in the open release, or a fix that issue needs first), the blocker joins `vNext` too, and the relation is recorded with `linear edit <blocker ID> --blocks <release issue ID>`.
- Pull requests: `gh pr list --repo leftos/towercab-3d --state open --json number,title,author`, and the same with `--repo leftos/towercab-3d-vnas`.
- Hotspots (two items touching one wait on each other): `src/renderer/types/settings.ts` (every setting, and `DEFAULT_SETTINGS`), `src/renderer/stores/settingsStore.ts` (the persisted `version` and the migration repair list), `src/renderer/stores/viewportStore.ts`, `src/renderer/stores/vnasStore.ts`, `src-tauri/src/vnas.rs`, `src-tauri/src/lib.rs` (the `generate_handler!` list), `src/renderer/hooks/useBabylonOverlay.ts`, `src/renderer/components/CesiumViewer/CesiumViewer.tsx`.

## Agents and gates

- Explore: the user-level `Explore` (docs-first: `CLAUDE.md`, then `docs/architecture.md`, then the crate's `docs/ARCHITECTURE.md` for vNAS work). Rust second opinion: `rust-engineer`.
- Reviewers: `code-review` for every item, plus `tauri-settings-bridge-reviewer` whenever `GlobalSettings` in `src/renderer/types/settings.ts` or `src-tauri/src/settings.rs` changes, and `css-token-auditor` whenever a `.css` file or a `.tsx` with styling changes.
- A new setting follows the project skill `add-setting` (version bump, `DEFAULT_SETTINGS`, and the Rust struct for a global one); a release follows `prepare-release`.
- Gates, each through the repo's gate wrapper as `pwsh -NoProfile -File tools/gate.ps1 run --log .tmp/<name>.log --timeout <n> --slot <slot> -- <command>` (`~/.claude/docs/gate.md`; the wrapper hands every word to the installed gate, which a machine without one installs from the gate repo with `pwsh tools/install.ps1`; usage: `gate --help`). In a worktree, add `--cd <worktree root>` and give `--log` as an absolute path under that root: a relative `--log` resolves against the shell's folder, not `--cd`:
  - `pnpm biome check src/ tests/` (`light`, 300), `pnpm run typecheck` (`heavy`, 300), `pnpm vitest run` (`heavy`, 300; scoped to the item's test file during a step, whole suite once at the end)
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo test --manifest-path src-tauri/Cargo.toml --release` (`heavy`, 900), each gated with `--env TC3D_CHECK_BUILD=1`: the gate routes `cargo clippy` to its builder without `dist/` or the converter exe, and without the switch a routed clippy fails in the Tauri build script. `cargo test` stays local (the MSFS-folder test below).
  - vNAS build of any change to `src-tauri/src/vnas.rs` or the crate: `node scripts/shipping/build/vnas.js cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features vnas -- -D warnings` (`heavy`, 900), with `TC3D_VNAS_CRATE_PATH` set to the pair's crate checkout while the crate change is unpushed (`CLAUDE.md`, "vNAS Integration")
  - Crate changes, in the crate root through its own `tools/gate.ps1`: `cargo test --release`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check`, `cargo doc --no-deps` with no warnings
  - A commit (prek runs Biome, `tsc` and clippy on staged files) as `pwsh -NoProfile -File tools/gate.ps1 run --log .tmp/commit.log --timeout 1200 --slot heavy -- git commit -F .tmp/msg-<slug>.txt` (the hooks build, so the commit takes a heavy slot), the message written with the Write tool to that file, new to this commit (the slug from the subject), and committed in a later turn than the Write
- App checks: a user-visible change is proved in the running desktop app through the `tauri-app` MCP (launch recipe and `window.__tc3d` in `CLAUDE.md`, "E2E testing via Playwright MCP"), launched with `pnpm --dir <tree> run dev -- --agent` so no window shows; a visible run (without `--agent`) tells the user "hands off" first. Stop the app when done. vNAS work against a local YAAT server and CRC runs through the `yaat-client-driver` MCP (`yaat/docs/client-driver-mcp.md`).
- Parent-side gate: `git -C <wt> status --short` in each half of the pair, and the same in both main checkouts.

## Traps

- A cargo check, clippy or test in a fresh checkout or worktree runs with `TC3D_CHECK_BUILD=1` (gate: `--env TC3D_CHECK_BUILD=1`), which skips the Tauri build script's need for `dist/` and `src-tauri/resources/fsltl_converter.exe` (`CLAUDE.md`, "Cargo checks without a frontend build"). A build that runs the app (`pnpm run dev`, `cargo build` for the dev app) still needs both: run `pnpm run vite:build` once per fresh tree, after `pnpm install --frozen-lockfile`, and copy the exe from the main checkout's `src-tauri/resources/`.
- The host's `cargo test --features vnas` binary does not start on this machine (`0xc0000139`, TC3D-240): host tests under `cfg(feature = "vnas")` cannot be run locally until that is fixed; say so in the report rather than retrying.
- A `vnas.js` run that is killed (a stopped `pnpm run dev:vnas`) skips its `Cargo.lock` restore: check the diff is only the crate's dependencies, then `git checkout -- src-tauri/Cargo.lock`. `Cargo.lock` never lands carrying the private crate.
- `cargo fmt` over the whole crate rewrites `lib.rs`, `mods.rs`, `msfs.rs` and `server.rs`, which are unformatted at HEAD (backlogged): format only the files the item touches (`rustfmt --edition 2021 <file>`).
- `msfs::tests::test_aig_crj200_indexing_with_shared_model` reads the machine's MSFS Community folder and fails on this machine (backlogged); a red result there alone is not the item's.
- Windows: never `2>nul` in a command (it creates a file named `nul`); Edit/Write paths are absolute with backslashes (`CLAUDE.md`, "File Editing on Windows"). The crate's `CLAUDE.md` is CRLF; a script that rewrites it keeps CRLF.

## Concurrency

- Worktrees: a towercab-only item gets `../towercab-3d.wt/<slug>/towercab-3d` (`git worktree add ../towercab-3d.wt/<slug>/towercab-3d -b <slug> <base>`); an item that touches the crate gets the pair, adding `git -C ../towercab-3d-vnas worktree add "$(cd .. && pwd)/towercab-3d.wt/<slug>/towercab-3d-vnas" -b <slug> <crate base>` (the crate's `main` when it has no `<base>`), with `TC3D_VNAS_CRATE_PATH` pointing at that half. Record `branch.<slug>.base` / `branch.<slug>.landOn` in each half as the user-level `nextup` §3 **Base and target** says.
- Ceiling: **three** implementers, as two main slots plus one rotating (owner, TC3D-62): the main slots go to the `Babylon to Cesium migration` and `OSM buildings` projects, the rotating slot to every other queued item in turn. A main slot whose project has no item ready takes the next queued item. Each worktree compiles the Tauri app into its own `target/` (minutes cold), and most items share a hotspot above.
- Context: read `bash ~/.claude/tools/context-usage/context-usage.sh` at every landing; past 400K the loop stops refilling, per the user-level `nextup`.
- Depends on, where file lists hide it: a crate API one item adds and a host (`src-tauri/src/vnas.rs`) item consumes; a Tauri command one item adds and a frontend item invokes; two items that each bump the settings `version` (the second rebases its bump).

## Docs map

| What changed | Owning docs |
|---|---|
| Anything a user sees or does | `CHANGELOG.md` (rules below), `USER_GUIDE.md` |
| A keyboard shortcut | `src/renderer/components/UI/KeyboardCheatsheet.tsx`, `USER_GUIDE.md` shortcuts section |
| A dev command, workflow, convention or trap | `CLAUDE.md` |
| An app-driving lesson (the `window.__tc3d` hook, driving through the Playwright MCP servers) | `CLAUDE.md` "E2E testing via Playwright MCP", and the rule in `docs/DRIVING_CONVENTIONS.md` |
| A store, hook, data flow or rendering stage | `docs/architecture.md` (and `docs/coordinate-systems.md` for transforms) |
| A mod manifest field or model requirement | `MODDING.md` |
| Remote-browser behaviour or an HTTP endpoint | `docs/remote-access-architecture.md` |
| A vNAS environment, URL or connection step | the crate's `CLAUDE.md` "Environment URLs" and `docs/ARCHITECTURE.md` |
| A term used in a project-specific sense | the glossary in `docs/README.md` once it exists (an open issue); until then, a comment on that issue |
| An item finished | its issue **land**ed after the commit |

## Landing

- Non-feature items: the orchestrator writes docs and the changelog bullet in the worktree, commits there (a `Refs: TC3D-<n>` trailer per issue), then `/ship` (with `## Ship` below): land onto the recorded `landOn`, gate on `main`, push as `## Ship` "Push" says, **land** the issue (Done; `land` posts the GitHub comment and the sync closes the issue), remove each half of the pair and its branch once landed by the user-level `nextup` §4 step 6 check.
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
- Push (Phase 4): towercab-3d is public and pushes at each landing. The crate is metered (private, with workflows), so it is pushed only at the `/nextup` checkpoint, a release, or when the owner asks. `vnas.js` builds every vNAS build (CI included) against the crate's GitHub `main`, so a host change pushed before the crate API it calls breaks those builds.

  Once a landing that needs unpushed crate commits is on towercab-3d's `main`, towercab-3d stops pushing too until the checkpoint, where the crate is pushed first, then towercab-3d.
- Gate (Phase 3), in towercab-3d's main checkout after a real cherry-pick: `pwsh -NoProfile -File tools/gate.ps1 run --log .tmp/check.log --timeout 900 --slot heavy -- pnpm run check`; a crate change also its gates above in the crate's main checkout.
- Additive conflict files (Phase 2): `CHANGELOG.md`, `USER_GUIDE.md`. A conflict on the snapshot `docs/plans/MAIN.md` takes either side and runs **snapshot** again.
- Issues (Phase 5): the issue repository is always `leftos/towercab-3d`, also for a crate-only fix. Ship **land**s the issue: it goes to Done and joins `vNext`, `land` posts the comment naming the landing sha, and the sync closes it on GitHub. `linear release complete` later files it under the version without changing its state.
