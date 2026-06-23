# macOS Redistributable — Release Plan

Scope decisions (locked in):

- **Architecture:** Apple Silicon only (`aarch64-apple-darwin`). Intel/Rosetta and universal binaries out of scope.
- **Signing:** Unsigned / ad-hoc. No Apple Developer Program, no notarization, no entitlements. The quarantined `.dmg` trips Gatekeeper's "damaged and can't be opened" message on first launch; users clear it with `xattr -dr com.apple.quarantine "/Applications/TowerCab 3D.app"`. (Right-click → Open only bypasses the "unidentified developer" gate, not "damaged".)
- **Testing:** Done locally on real Apple Silicon hardware.

Guiding principle (updated): **MSFS model conversion is now cross-platform.** Modern Pillow (≥11.3) decodes the BC7/DX10 DDS formats that previously needed Windows-only `texconv.exe`, so texconv was removed entirely and the converter (Python + Pillow) builds natively on macOS. MSFS itself still doesn't run on macOS — there's no local Community folder — so Mac users point the MSFS panel at FSLTL/AIG folders copied from a Windows install. (Earlier this plan disabled MSFS on macOS; that was reverted once the Pillow-BC7 path was proven.)

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

- [x] README: document macOS build (Apple Silicon only) and the unsigned first-launch step (`xattr -dr com.apple.quarantine`, explaining the "damaged" Gatekeeper message). Release bodies carry the same note via `release.yml` + the `prepare-release` skill.
- [ ] CHANGELOG entry under `[Unreleased]` → Added: "macOS (Apple Silicon) build".

## F. Testing (on Apple Silicon hardware)

The desktop app renders through **WKWebView on macOS, not Chromium/WebView2** — the dual Cesium + Babylon.js WebGL2 pipeline was the biggest unknown.

- [x] Build locally on Apple Silicon: `pnpm run dev` and `pnpm tauri build --target aarch64-apple-darwin` both succeeded.
- [x] WKWebView rendering confirmed working (Cesium globe + Babylon overlay).
- [ ] (Optional spot-checks) `tc3d://` deep link, auto-updater install, window-state persistence, tray menu, remote browser access from another device — not individually exercised yet.

---

## Update — native MSFS conversion on macOS (supersedes the disabling above)

After the initial Mac build shipped with MSFS disabled, we enabled **native MSFS model conversion on macOS**. This supersedes the "disabled/compiled-out on macOS" items in sections A–D.

Key change: **texconv.exe removed entirely.** Pillow ≥11.3 decodes BC1/BC3/BC5/BC7 and DX10 DDS natively (verified empirically), which is all MSFS liveries use. The converter is now pure Python + Pillow and builds on every platform.

- [x] Converter: removed `get_texconv_path`/`convert_dds_with_texconv` + `subprocess`/`tempfile` imports; unsupported formats fall back to a neutral placeholder. Bumped `pillow>=11.3`.
- [x] `build_converter.py`: builds on all platforms; per-OS output name (`fsltl_converter[.exe]`); no texconv copy.
- [x] Rust: `CONVERTER_BIN` const (`fsltl_converter[.exe]`) used at all 4 lookup sites; reverted the "Windows-only" converter messages.
- [x] Frontend: reverted the macOS MSFS gating (panel shown, init runs); `MSFSModelSettingsPanel` hint is macOS-aware (point at a copied FSLTL/AIG folder). `isMacDesktopApp` removed; `isMacOS` kept for the hint.
- [x] Config: `tauri.conf.json` drops `resources/texconv.exe`; `tauri.macos.conf.json` bundles `resources/fsltl_converter`.
- [x] CI: `release-macos.yml` now runs Setup Python + `build:converter`.
- [x] Removed committed `scripts/shipping/conversion/texconv.exe`; `.gitignore` tracks `fsltl_converter` (no ext).
- [ ] Validate on macOS hardware: convert a real FSLTL/AIG livery (copied from Windows) and confirm textures look correct without texconv.
- [x] Release coordination: `release-macos.yml` resolves the release by **ID** (the list API sees drafts) and uploads via `tauri-action`'s `releaseId`, not `tagName`. The get-by-tag API 404s on the draft `release.yml` creates, so a tag lookup during that window would spawn a duplicate release. (Supersedes the "by tag" note in section A.)
