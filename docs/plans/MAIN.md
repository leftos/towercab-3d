# TowerCab 3D — Main Plan

Entry point for all in-flight work. Each task is a checkbox; detail lives in the linked subplan. Completed subplans move to `docs/plans/archive/`.

## Current focus

- [ ] Rendering engine audit (Cesium 1.140 → 1.145, Babylon 9.5 → 9.25, underused features, dead code, doc drift) — see [rendering-engine-audit.md](./rendering-engine-audit.md). Start with section A (upgrades), then B (bugs found).

## Backlog

- [ ] macOS hardware spot-checks — see [macos-release.md](./macos-release.md). The build shipped in v0.2.0-alpha; what remains is runtime verification on Apple Silicon (deep link, tray/single-instance/window-state, auto-updater install, FSLTL/AIG conversion without texconv) and notarization, which is out of scope while builds are unsigned. Archive the plan once the spot-checks are done.

## Blockers

_(none)_
