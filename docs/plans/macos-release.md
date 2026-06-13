# macOS Redistributable — Release Plan

Scope decisions (locked in):

- **Architecture:** Apple Silicon only (`aarch64-apple-darwin`). Intel/Rosetta and universal binaries out of scope.
- **Signing:** Unsigned / ad-hoc. No Apple Developer Program, no notarization, no entitlements. Users right-click → Open (or `xattr -dr com.apple.quarantine`) on first launch.
- **Testing:** Done locally on real Apple Silicon hardware.

Guiding principle: **MSFS is Windows-only — there is no Community folder, FSLTL, or AIG on a Mac.** The MSFS model-conversion pipeline (`fsltl_converter.exe`, `texconv.exe`) is disabled/compiled-out on macOS, NOT ported. Aircraft still render from the bundled `.glb` models.

Auto-updater keeps working on macOS: it uses minisign (`TAURI_SIGNING_PRIVATE_KEY`), which is independent of Apple code-signing. `tauri-action` merges a `darwin-aarch64` entry into the same `latest.json`.

---

## A. CI / build pipeline

Decision: macOS builds **only at release time, in a separate workflow** from Windows. Rationale: future notarization is asynchronous (can take hours–days), so it must not gate the Windows release. `release.yml` and `build.yml` stay Windows-only and untouched.

- [x] New `.github/workflows/release-macos.yml`: triggers on `v*` tags, `runs-on: macos-latest` (arm64, native), target `aarch64-apple-darwin`, uploads to the same GitHub release by tag (`tauri-action` with `tagName`). No converter/Python steps (MSFS is Windows-only; `tauri.macos.conf.json` drops `.exe` resources from the bundle). Portable `sed -i.bak` so the token-less vnas/updater-disable paths work on BSD sed too.
- [x] `tauri-action` merges the `darwin-aarch64` entry into the existing release's `latest.json` (reads + merges `platforms` before re-upload), so Windows auto-update isn't clobbered. Verify at first real macOS release.
- [ ] (Future) Notarization slots into `release-macos.yml` as additional `tauri-action` env (`APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) — out of scope while unsigned/ad-hoc.

## B. Tauri bundle config

- [ ] Make the macOS bundle not require Windows-only resources. `tauri.conf.json:44-47` lists `fsltl_converter.exe`, `texconv.exe`, `update-mods.ps1`. A `tauri build` on macOS will fail if these paths are absent. Fix via a macOS config overlay (e.g. `tauri.macos.conf.json` passed in the mac CI/build args) that overrides `bundle.resources` to drop the Windows files, OR restructure resources to be platform-specific.
- [ ] Handle bundle targets per platform: `targets` is `["nsis"]` (invalid on mac). Either pass `--bundles app,dmg` in the macOS build args, or set targets to include dmg/app and rely on Tauri filtering out inapplicable ones.
- [x] Bump `bundle.macOS.minimumSystemVersion` from `10.13` to `11.0` (Apple Silicon requires macOS 11+).
- [x] `scripts/shipping/build/build_converter.py` early-returns on non-Windows, so `pnpm run build` (which chains `build:converter`) works on macOS without PyInstaller/texconv.

## C. Rust backend

- [ ] `#[cfg(target_os = "windows")]`-guard the MSFS detection/conversion commands and the converter-path lookups (`msfs.rs`, `lib.rs`, `files.rs`) so non-Windows compiles to clean "not available on this platform" stubs instead of searching for `fsltl_converter.exe`.
- [ ] Verify the `tc3d://` deep link registers on macOS via the app bundle (`Info.plist`). The runtime `register_all()` is `#[cfg(any(windows, linux))]` — correct, macOS registers via the bundle, not at runtime.
- [ ] Confirm tray-icon, single-instance, window-state plugins behave on macOS (all supported; verify at runtime).

## D. Frontend / UX

- [ ] Add platform detection (`@tauri-apps/plugin-os`, or a backend `get_platform` command).
- [ ] Hide `<MSFSModelSettingsPanel />` on macOS (`SettingsConfigurationTab.tsx:818`).
- [ ] Skip `MSFSModelConversionService.initialize()` on macOS (`App.tsx:238-244`) so startup doesn't run "Detecting MSFS installations…".
- [x] RealTraffic license path: no work needed — `REALTRAFFIC_LICENSE_PATH_WIN/MAC` constants (`realtraffic.ts:46,53`) are dead code, referenced nowhere. RealTraffic uses an API key, not `.lic` detection. (Flagged as optional cleanup.)
- [x] Modifier-key labels: **decided to leave as "Ctrl"**. Ctrl works for every shortcut on macOS (the ⌘-capable ones accept `ctrlKey || metaKey`; the rest are `ctrlKey`-only). A blanket ⌘ relabel would be *wrong* for Ctrl+M (⌘M = minimize), Ctrl+0–9 (⌘1–9 = browser tabs in remote mode), and the Ctrl-only camera fine-control modifiers. So labels stay accurate as-is; no change.

## E. Docs / distribution

- [ ] README: document macOS build (Apple Silicon only) and the unsigned first-launch step (right-click → Open / `xattr -dr com.apple.quarantine`).
- [ ] CHANGELOG entry under `[Unreleased]` → Added: "macOS (Apple Silicon) build".

## F. Testing (on Apple Silicon hardware)

The desktop app renders through **WKWebView on macOS, not Chromium/WebView2** — the dual Cesium + Babylon.js WebGL2 pipeline is the biggest unknown.

- [ ] Build locally: `pnpm tauri build --target aarch64-apple-darwin --bundles app,dmg`.
- [ ] Validate WKWebView rendering: Cesium globe + terrain + imagery, Babylon overlay (labels/leader lines/weather), WebGL2, frame rate.
- [ ] Validate trackpad/touch gestures, camera modes, datablock positioning.
- [ ] Validate HTTP server (port 8765) + remote browser access from another device.
- [ ] Validate `tc3d://` deep link, auto-updater install, window-state persistence, tray menu.
