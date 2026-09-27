# macOS Redistributable — Remaining Checks

The Apple Silicon build shipped in v0.2.0-alpha (`.dmg`, `.app.tar.gz` + `.sig`, and a `darwin-aarch64` entry in `latest.json`). Build, bundle, CI, and native MSFS conversion work is done; the rationale lives where the work does: `.github/workflows/release-macos.yml` (separate workflow, release resolved by ID), `README.md` (install and Gatekeeper step), `docs/msfs-model-conversion.md` (Pillow decodes DDS, no texconv).

Scope decisions (locked in):

- **Architecture:** Apple Silicon only (`aarch64-apple-darwin`). Intel/Rosetta and universal binaries out of scope.
- **Signing:** Unsigned / ad-hoc. No Apple Developer Program, no notarization. If that changes, notarization slots into `release-macos.yml` as `tauri-action` env (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).

## Runtime checks on Apple Silicon hardware

Each is a human check: run the released `.dmg` build on a Mac.

- [ ] `tc3d://` deep link opens the app. macOS registers the scheme from the bundle's `Info.plist` (the runtime `register_all()` is `#[cfg(any(windows, linux))]`).
- [ ] Tray icon, single-instance, and window-state persistence behave.
- [ ] Auto-updater installs an update from `latest.json`.
- [ ] Remote browser access from another device reaches the Mac host.
- [ ] Convert a real FSLTL/AIG livery copied from a Windows install; textures look correct.
