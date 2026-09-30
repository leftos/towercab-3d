# macOS Redistributable — Remaining Checks

The Apple Silicon build shipped in v0.2.0-alpha (`.dmg`, `.app.tar.gz` + `.sig`, and a `darwin-aarch64` entry in `latest.json`). Build, bundle, CI, and native MSFS conversion work is done; the rationale lives where the work does: `.github/workflows/release-macos.yml` (separate workflow, release resolved by ID), `README.md` (install and Gatekeeper step), `docs/msfs-model-conversion.md` (Pillow decodes DDS, no texconv).

Scope decisions (locked in):

- **Architecture:** Apple Silicon only (`aarch64-apple-darwin`). Intel/Rosetta and universal binaries out of scope.
- **Signing:** Developer ID signed and notarized, reusing `leftos/yaat`'s Developer ID Application certificate and App Store Connect notary key (Tauri ships a `.dmg`, so no Installer cert). Setup and the workflow change: [macos-code-signing.md](../macos-code-signing.md). Until it is wired in, `release-macos.yml` builds unsigned and the README's `xattr` workaround stands.

## Signing and notarization

- [ ] Add the seven `APPLE_*` / `KEYCHAIN_PASSWORD` secrets to `leftos/towercab-3d` (guide Steps 1–4). Human: needs the Mac keychain export and the `.p8`.
- [ ] Wire the certificate import and the `APPLE_*` env into `.github/workflows/release-macos.yml` (guide Step 5), gated on `APPLE_CERTIFICATE` so forks still build unsigned. Needs the secrets first.
- [ ] On the first signed release, check `spctl --assess` and `xcrun stapler validate` on a Mac (guide Step 7); if the FSLTL converter fails under the hardened runtime, add the entitlements (Step 6).
- [ ] Once a notarized build is verified, drop the "damaged" / `xattr -dr com.apple.quarantine` notes from `README.md:138-140`, `.github/workflows/release.yml:35-38` and `.claude/skills/prepare-release/SKILL.md:164-167` (guide Step 8).

## Runtime checks on Apple Silicon hardware

Each is a human check: run the released `.dmg` build on a Mac.

- [ ] `tc3d://` deep link opens the app. macOS registers the scheme from the bundle's `Info.plist` (the runtime `register_all()` is `#[cfg(any(windows, linux))]`).
- [ ] Tray icon, single-instance, and window-state persistence behave.
- [ ] Auto-updater installs an update from `latest.json`.
- [ ] Remote browser access from another device reaches the Mac host.
- [ ] Convert a real FSLTL/AIG livery copied from a Windows install; textures look correct.
