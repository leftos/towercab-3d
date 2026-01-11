# macOS Support Implementation Plan

This document outlines the work required to add macOS support to TowerCab 3D.

## Current State

- **Platform:** Windows only (NSIS installer)
- **CI/CD:** GitHub Actions builds only for Windows (macOS/Linux commented out)
- **Rust backend:** Contains Windows-specific code for process management and console hiding
- **Python sidecar:** Built only as Windows `.exe`

## Overview

The codebase is well-structured for cross-platform support. The frontend (React/TypeScript) is 100% cross-platform. The main work involves:

1. Platform-aware Rust code changes
2. Python sidecar cross-platform builds
3. Tauri bundle configuration
4. Apple code signing infrastructure
5. CI/CD updates

## Major Consideration: MSFS Models

The FSLTL/AIG model conversion feature is **Windows-only by nature** since Microsoft Flight Simulator only runs on Windows. On macOS:

- **Option A (Recommended):** Disable the feature entirely, use built-in models only
- **Option B:** Allow manual import of pre-converted GLB models
- **Option C:** Explore alternative model sources (X-Plane libraries, etc.)

This plan assumes Option A - disabling MSFS model conversion on macOS.

---

## Phase 1: Tauri Configuration

### Files to Modify

**`tauri.conf.json`**

Add `dmg` to bundle targets:

```json
"bundle": {
  "targets": ["nsis", "dmg"],
  "macOS": {
    "minimumSystemVersion": "11.0",
    "signingIdentity": "-",
    "entitlements": null,
    "exceptionDomain": null,
    "frameworks": [],
    "providerShortName": null
  }
}
```

Notes:
- Raise minimum to macOS 11 (Big Sur, 2020) for better WebKit/WebGL support
- `signingIdentity: "-"` allows unsigned dev builds; production needs real identity

### Bundle Identifier

Already configured: `com.towercab.viewer` (line 5 of tauri.conf.json)

---

## Phase 2: Rust Backend Changes

### 2.1 Process Management (`src-tauri/src/lib.rs`)

**Current:** Windows Job Objects ensure child processes terminate with parent.

```rust
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{...};
```

**Change:** Add Unix equivalent using process groups.

```rust
#[cfg(unix)]
use std::os::unix::process::CommandExt;

// For Unix: set process group so children can be killed together
#[cfg(unix)]
fn spawn_with_cleanup(cmd: &mut Command) -> std::io::Result<Child> {
    unsafe {
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    cmd.spawn()
}

// Kill process group on drop
#[cfg(unix)]
impl Drop for ProcessWithJob {
    fn drop(&mut self) {
        if let Some(id) = self.child.id() {
            unsafe { libc::killpg(id as i32, libc::SIGTERM); }
        }
    }
}
```

### 2.2 Console Hiding Flags

**Files:** `lib.rs`, `msfs.rs`

**Current:**
```rust
#[cfg(windows)]
cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
```

**Change:** Wrap in `#[cfg(windows)]` blocks (already done in most places, verify all instances).

### 2.3 Executable Path Detection

**File:** `src-tauri/src/lib.rs` (lines 444-485)

**Current:**
```rust
let possible_paths = [
    resource_path.join("resources").join("fsltl_converter.exe"),
    // ...
];
```

**Change:**
```rust
#[cfg(target_os = "windows")]
const CONVERTER_NAME: &str = "fsltl_converter.exe";
#[cfg(target_os = "macos")]
const CONVERTER_NAME: &str = "fsltl_converter";

let possible_paths = [
    resource_path.join("resources").join(CONVERTER_NAME),
    // ...
];
```

**File:** `src-tauri/src/msfs.rs` (line 989)

Same pattern - use conditional constant for executable name.

### 2.4 WebView2 GPU Arguments

**File:** `src-tauri/src/lib.rs` (lines 649-667)

**Current:** Sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (Windows-only).

**Change:** Already wrapped in `#[cfg(target_os = "windows")]` - no changes needed.

### 2.5 MSFS Feature Gating

**File:** `src-tauri/src/msfs.rs`

Wrap MSFS-specific commands with platform checks:

```rust
#[tauri::command]
#[cfg(target_os = "windows")]
pub fn detect_msfs_installations() -> Result<...> { ... }

#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub fn detect_msfs_installations() -> Result<Vec<String>, String> {
    Ok(vec![]) // No MSFS on macOS
}
```

Or use a feature flag approach for cleaner separation.

### 2.6 Hostname Resolution

**File:** `src-tauri/src/lib.rs` (lines 240-275)

**Current:** Uses `creation_flags(0x08000000)` for console hiding.

**Change:**
```rust
let mut cmd = Command::new("hostname");
#[cfg(windows)]
{
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}
if let Ok(output) = cmd.output() { ... }
```

---

## Phase 3: Python Sidecar

### 3.1 Build Script Updates

**File:** `scripts/shipping/build/build_converter.py`

**Current:** Outputs `fsltl_converter.exe` only.

**Change:**
```python
import platform

if platform.system() == "Windows":
    exe_name = "fsltl_converter.exe"
elif platform.system() == "Darwin":
    exe_name = "fsltl_converter"
else:
    exe_name = "fsltl_converter"

output_exe = output_dir / exe_name
```

### 3.2 PyInstaller Spec

**File:** `scripts/shipping/build/fsltl_converter.spec`

Update to be platform-aware:

```python
import platform

exe_name = 'fsltl_converter.exe' if platform.system() == 'Windows' else 'fsltl_converter'

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    name=exe_name,
    console=True,  # Keep console for debugging
    # ...
)
```

### 3.3 Resource Bundling

**File:** `tauri.conf.json`

Tauri will bundle resources from `src-tauri/resources/`. Need to:
1. Build both Windows and macOS binaries
2. Include only the relevant one per platform, OR
3. Include both and detect at runtime (increases bundle size)

**Recommended approach:** CI builds platform-specific converter before Tauri build.

### 3.4 Alternative: Skip Bundling on macOS

Since MSFS models don't exist on macOS anyway, consider:
- Don't bundle converter on macOS
- Show "MSFS models not available on macOS" in settings
- Simplifies the build significantly

---

## Phase 4: GitHub Actions CI/CD

### 4.1 Build Workflow

**File:** `.github/workflows/build.yml`

Uncomment macOS matrix entries:

```yaml
strategy:
  matrix:
    include:
      - platform: windows-latest
        target: x86_64-pc-windows-msvc
        bundle_type: nsis
        file_ext: exe
      - platform: macos-latest
        target: x86_64-apple-darwin
        bundle_type: dmg
        file_ext: dmg
      - platform: macos-latest
        target: aarch64-apple-darwin
        bundle_type: dmg
        file_ext: dmg
```

Add macOS-specific steps:

```yaml
- name: Install Rust target (macOS ARM)
  if: matrix.target == 'aarch64-apple-darwin'
  run: rustup target add aarch64-apple-darwin

- name: Build converter (macOS)
  if: runner.os == 'macOS'
  run: |
    python3 -m pip install pyinstaller pillow
    python3 scripts/shipping/build/build_converter.py
```

### 4.2 Release Workflow

**File:** `.github/workflows/release.yml`

Same matrix changes, plus signing steps:

```yaml
- name: Import Apple certificates
  if: runner.os == 'macOS'
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
  run: |
    echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
    security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
    security default-keychain -s build.keychain
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
    security import certificate.p12 -k build.keychain -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" build.keychain

- name: Notarize app
  if: runner.os == 'macOS'
  env:
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
  run: |
    xcrun notarytool submit target/release/bundle/dmg/*.dmg \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_PASSWORD" \
      --wait
```

### 4.3 Universal Binary (Optional)

For Apple Silicon + Intel support:

```yaml
- name: Build universal binary
  if: runner.os == 'macOS'
  run: |
    # Build for both architectures
    cargo build --release --target x86_64-apple-darwin
    cargo build --release --target aarch64-apple-darwin

    # Combine with lipo
    lipo -create \
      target/x86_64-apple-darwin/release/towercab-3d \
      target/aarch64-apple-darwin/release/towercab-3d \
      -output target/release/towercab-3d
```

---

## Phase 5: Frontend Changes

### 5.1 MSFS Settings UI

**File:** `src/renderer/components/settings/MSFSSettingsTab.tsx` (or similar)

Add platform detection:

```typescript
import { platform } from '@tauri-apps/plugin-os';

const isMacOS = platform() === 'macos';

// In component:
if (isMacOS) {
  return (
    <div className="text-muted">
      MSFS model conversion is not available on macOS.
      Microsoft Flight Simulator only runs on Windows.
    </div>
  );
}
```

### 5.2 Service Layer

**File:** `src/renderer/services/MSFSModelConversionService.ts`

Add early return for non-Windows:

```typescript
async initialize(): Promise<void> {
  if (!window.__TAURI__ || (await platform()) !== 'windows') {
    this.initialized = true;
    return; // Skip MSFS detection on non-Windows
  }
  // ... existing initialization
}
```

---

## Phase 6: Code Signing Setup

### Requirements

1. **Apple Developer Account** ($99/year)
2. **Developer ID Application certificate** (for distribution outside App Store)
3. **App-specific password** for notarization

### GitHub Secrets to Add

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for .p12 |
| `KEYCHAIN_PASSWORD` | Temporary keychain password |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_TEAM_ID` | Team ID from Apple Developer portal |
| `APPLE_PASSWORD` | App-specific password |

### Tauri Signing Configuration

**File:** `tauri.conf.json`

```json
"macOS": {
  "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
  "entitlements": "entitlements.plist"
}
```

**File:** `src-tauri/entitlements.plist` (new file)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
</dict>
</plist>
```

---

## Testing Checklist

### Core Functionality
- [ ] App launches without errors
- [ ] Cesium globe renders correctly
- [ ] Babylon.js overlay (labels, weather) works
- [ ] Camera controls (orbit, pan, zoom)
- [ ] Keyboard shortcuts
- [ ] Aircraft rendering with built-in models

### Network Features
- [ ] VATSIM data fetching
- [ ] Weather (METAR) updates
- [ ] HTTP server starts on port 8765
- [ ] Remote browser access from other devices

### Settings
- [ ] Settings persist across restarts
- [ ] Global settings sync works
- [ ] MSFS settings show "not available" message

### Platform-Specific
- [ ] Window controls (minimize, maximize, close)
- [ ] Menu bar integration
- [ ] Dock icon
- [ ] Notifications (if used)
- [ ] Auto-updater (if enabled)

### Performance
- [ ] Smooth 60fps rendering
- [ ] Memory usage reasonable
- [ ] No WebGL errors in console

### Distribution
- [ ] DMG opens correctly
- [ ] App runs after drag-to-Applications
- [ ] No Gatekeeper warnings (signed build)
- [ ] Auto-update works (if enabled)

---

## File Modification Checklist

| File | Changes | Priority |
|------|---------|----------|
| `tauri.conf.json` | Add dmg target, macOS config | P0 |
| `src-tauri/src/lib.rs` | Platform conditionals for process mgmt | P0 |
| `src-tauri/src/msfs.rs` | Platform conditionals, exe paths | P0 |
| `scripts/shipping/build/build_converter.py` | Platform-aware output | P1 |
| `scripts/shipping/build/fsltl_converter.spec` | Platform-aware config | P1 |
| `.github/workflows/build.yml` | Add macOS matrix | P0 |
| `.github/workflows/release.yml` | Add macOS matrix + signing | P0 |
| `src-tauri/entitlements.plist` | New file for macOS entitlements | P1 |
| `src/renderer/services/MSFSModelConversionService.ts` | Platform check | P2 |
| MSFS settings UI component | Platform check, disabled state | P2 |

---

## Estimated Effort

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1: Tauri config | 2-4 hours | Straightforward config changes |
| Phase 2: Rust changes | 1-2 days | Conditional compilation, testing |
| Phase 3: Python sidecar | 4-8 hours | If keeping converter on macOS |
| Phase 4: CI/CD | 4-8 hours | Workflow updates, testing |
| Phase 5: Frontend | 2-4 hours | UI messaging |
| Phase 6: Code signing | 1-2 days | Apple account setup, secrets |
| Testing | 1-2 days | Need macOS hardware |
| **Total** | **~1-2 weeks** | For one developer |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| No macOS hardware for testing | High | Use GitHub Actions macOS runners, borrow/rent Mac |
| Apple signing complexity | Medium | Follow Tauri docs, allocate extra time |
| WebGL differences on Safari | Medium | Test early, have fallbacks |
| PyInstaller macOS issues | Low | Can skip converter, disable MSFS feature |
| vNAS compatibility | Low | Pure Rust, should work cross-platform |

---

## Future Considerations

1. **Linux Support:** Similar effort, no code signing required
2. **Apple Silicon native:** Consider universal binary for best performance
3. **App Store distribution:** Requires additional sandboxing, different cert type
4. **Alternative model sources:** X-Plane libraries, custom model packs

---

## References

- [Tauri 2 macOS Bundle Configuration](https://v2.tauri.app/distribute/macos/)
- [Tauri Code Signing Guide](https://v2.tauri.app/distribute/sign/macos/)
- [Apple Developer Program](https://developer.apple.com/programs/)
- [Notarization Documentation](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
