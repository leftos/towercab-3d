# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TowerCab 3D is a Tauri 2 desktop application that provides a 3D tower cab view for VATSIM air traffic controllers. It displays real-time aircraft positions on a 3D globe with satellite imagery and terrain, featuring smooth camera controls, aircraft following modes, and extensive customization options.

**Remote Browser Access:** The desktop app runs an HTTP server (port 8765) allowing access from browsers on the local network (iPad, tablets, other PCs). All mods, models, and settings are served from the host. Global settings (Cesium token, bookmarks, datablock positions) are shared across devices.

## Documentation Lookup

When looking up documentation for libraries (Cesium, Babylon.js, React, etc.), always use the Context7 MCP tool first:
1. Call `mcp__context7__resolve-library-id` to find the library ID
2. Call `mcp__context7__get-library-docs` with a topic to get relevant docs

Only resort to WebSearch/WebFetch if Context7 doesn't have the information needed.

## Logs

When told to "check the logs", read temp/console.log. It's likely it's quite big, so try not to read it all into context.

## Development Commands

```bash
pnpm install          # Install dependencies
pnpm run dev          # Start desktop app (without vNAS)
pnpm run dev:vnas     # Start desktop app with vNAS 1Hz updates (requires private repo access)
pnpm run serve        # Development: frontend only in browser (no Tauri, no mods)
pnpm run build        # Build for production without vNAS
pnpm run build:vnas   # Build for production with vNAS (requires private repo access)
pnpm run build:converter  # Build FSLTL converter executable (requires Python + PyInstaller)
pnpm run vite:dev     # Frontend only (internal, used by Tauri)
pnpm run vite:build   # Build frontend only (internal, used by Tauri)
```

### Rust Documentation

```bash
cd src-tauri && cargo doc --open   # Generate and view Rust API docs
```

Generated docs are output to `src-tauri/target/doc/`. These provide detailed documentation for the Tauri backend modules (msfs, server, settings, etc.). Consult these when working on Rust code.

### vNAS Integration

The optional `vnas` feature enables 1Hz real-time aircraft updates via the private `towercab-3d-vnas` crate. Without it, the app uses 15-second VATSIM HTTP polling.

- **Public contributors:** Use `pnpm run dev` and `pnpm run build` - no private repo access needed
- **With vNAS access:** Use `pnpm run dev:vnas` and `pnpm run build:vnas`
- **Signed builds:** `.\build-signed.ps1` (with vNAS) or `.\build-signed.ps1 -NoVnas`

**Dependency updates:** The `pnpm run dev:vnas` and `pnpm run build:vnas` commands automatically run `cargo update -p towercab-3d-vnas` before building to fetch the latest commits from the private repo's master branch. This is also configured in the private repo's CI workflow, so builds always use the latest implementation.

**Private vNAS Crate Repository:**
- **GitHub:** https://github.com/leftos/towercab-3d-vnas
- **Location (local):** `../towercab-3d-vnas/` (sibling directory)
- **Documentation:** `docs/vnas-udp-integration-plan.md` in the private repo
- **Build:** `cargo build` or `cargo check`
- **CI:** GitHub Actions runs on push (check, test, fmt, clippy, doc)

**vNAS Implementation Details:**
- SignalR WebSocket client for real-time aircraft updates
- UDP connection for 1Hz data streaming
- Server-initiated callbacks (HandleSessionStarted) for session management
- Ground track field for accurate aircraft extrapolation
- WaitingForSession state when TC3D connects before CRC

**Note:** The `pnpm run build` command automatically runs `build:converter` to create the FSLTL model converter executable. This requires Python 3 with Pillow installed. PyInstaller is auto-installed if missing.

**Note for Claude:** Only the user can run `pnpm run dev` as it launches the Tauri app with a GUI. Ask the user to run this command and report back any errors.

**Windows Warning:** Never use `2>nul` to suppress stderr in terminal commands. On Windows, this creates a file literally named `nul` which is extremely difficult to delete (requires special tools or booting from Linux). Use `2>$null` in PowerShell or simply omit stderr redirection.

## File Editing on Windows

**CRITICAL:** When using Edit or Write tools on Windows, you MUST use absolute paths with backslashes:

```
✅ CORRECT:  X:\dev\towercab-3d\package.json
❌ WRONG:    package.json
❌ WRONG:    X:/dev/towercab-3d/package.json
```

Using relative paths or forward slashes causes "File has been unexpectedly modified" errors and other failures. Always construct the full absolute path with backslashes before calling Edit or Write.

**Important:** Always run Biome and TypeScript checks before committing changes:

```bash
pnpm biome check src/        # Check for linting errors
pnpm biome check src/ --fix  # Auto-fix fixable issues
pnpm run typecheck           # Run TypeScript type checking (CRITICAL)
```

Fix all Biome and TypeScript errors before committing. Do not disable rules without a justified reason.

### Why Type Checking Matters

**CRITICAL:** Vite does not perform type checking during builds - it only transpiles TypeScript to JavaScript using esbuild. This means type errors can slip through if you don't explicitly run `tsc`.

**TypeScript errors were previously missed because:**
1. `vite build` uses esbuild for transpilation, which skips type checking for performance
2. Biome checks code style/patterns, not type correctness
3. `skipLibCheck: true` in tsconfig.json skips checking node_modules types (for performance)
4. There was no explicit `tsc --noEmit` check in the build workflow

**The `pnpm run typecheck` script is now part of the build process to prevent this in the future.**

Always run `pnpm run typecheck` before:
- Creating a commit
- Opening a pull request
- Before `pnpm run build`

The build script now automatically runs typecheck first, so production builds will fail if there are type errors.

## Architecture

See `docs/architecture.md` for detailed documentation including:
- Data flow diagrams (VATSIM, weather, settings)
- Store relationships (18 Zustand stores)
- Hook dependencies and call order
- Rendering pipeline (Cesium + Babylon.js)
- Component hierarchy
- Coordinate system transformations (see also `coordinate-systems.md`)

**Quick reference:** Tauri 2 desktop app with React 19 frontend. Dual rendering: CesiumJS (globe/terrain/aircraft) + Babylon.js overlay (labels/weather). Use `viewportStore` for camera state (not deprecated `cameraStore`). HTTP server (axum, port 8765) serves frontend to remote browsers. Use `remoteMode.ts` utilities to detect Tauri vs browser mode.

## Path Alias

`@/` maps to `src/renderer/` (configured in vite.config.ts)

## Design Tokens

All shared colours, spacing, and typography live as CSS custom properties in the `:root` block of `src/renderer/assets/styles/global.css`. When adding or editing CSS, prefer tokens over literals:

- **Colours:** `--accent`, `--accent-warn`, `--accent-danger`, `--accent-ok`, `--accent-pending`
- **Surfaces:** `--bg-app`, `--bg-panel`, `--bg-panel-strong`, `--bg-overlay`
- **White-alpha (borders, hover states, subtle backgrounds):** `--white-a05`, `--white-a08`, `--white-a10`, `--white-a15`, `--white-a20`, `--white-a30`
- **Text:** `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-muted`
- **Layout:** `--topbar-h`, `--controls-h` (and `-compact`/`-mobile` responsive variants)
- **Radii / effects:** `--radius-sm/md/lg`, `--blur`, `--blur-strong`
- **Fonts:** `--font-sans`, `--font-mono`

Component-specific one-off colours (e.g. the bespoke palette in `SettingsModsTab.css`) may stay as literals when they don't match a semantic token. Do not re-introduce orphan `var(--xxx)` references that aren't defined in `:root` — they silently resolve to inherited or unset values. Do not put inline `<style>{...}</style>` blocks in `.tsx` files; create a sibling `.css` file and import it.

## Code Organization

### Types (`types/`)

All TypeScript types centralized by domain. Import via `import type { ... } from '@/types'`:

| File | Purpose |
|------|---------|
| `aircraft-timeline.ts` | Timeline debug modal state and snapshot types |
| `airport.ts` | Airport data, tower height |
| `babylon.ts` | Labels, weather meshes, ENU transforms |
| `camera.ts` | Camera state, view/follow modes, bookmarks |
| `exportImport.ts` | Settings export/import data structures |
| `fsltl.ts` | FSLTL/AIG conversion, airline mapping, MSFSModelSettings |
| `mod.ts` | Modding manifest formats |
| `realtraffic.ts` | RealTraffic API structures, ADS-B position data |
| `replay.ts` | Replay snapshots, playback state |
| `settings.ts` | App settings (cesium, graphics, camera, weather, memory, aircraft, ui) + GlobalSettings (cesiumIonToken, MSFS paths, viewport data shared across devices) |
| `vatsim.ts` | VATSIM API structures, pilot/aircraft state |
| `vnas.ts` | vNAS integration types (session, aircraft updates) |
| `viewport.ts` | Viewport layout, multi-viewport config |
| `weather.ts` | METAR, clouds, fog, precipitation |

### Constants (`constants/`)

Configuration values and limits. Import via `import { ... } from '@/constants'`:

| File | Purpose |
|------|---------|
| `aircraft-timeline.ts` | Timeline debug modal settings |
| `api.ts` | Endpoints, poll intervals, cache TTL |
| `babylon.ts` | Scene settings, visibility thresholds |
| `camera.ts` | FOV/pitch limits, orbit defaults |
| `lighting.ts` | Sun position, shadow configuration |
| `precipitation.ts` | Rain/snow particles, wind effects |
| `realtraffic.ts` | RealTraffic API configuration |
| `rendering.ts` | Model pool, shadows, colors |
| `replay.ts` | Buffer size, playback speeds |
| `weather.ts` | Cloud/fog parameters |

Use `SCREAMING_SNAKE_CASE` (e.g., `FOV_DEFAULT`, `ORBIT_DISTANCE_MAX`).

### Services (`services/`)

Business logic and external API integrations:

| Service | Purpose |
|---------|---------|
| `AircraftDimensionsService.ts` | Aircraft wingspan/length data for model scaling |
| `AircraftModelService.ts` | Model lookup, matching, and loading coordination |
| `AirportService.ts` | Airport data fetching and caching |
| `CustomVMRService.ts` | User-defined VMR (model matching) rules |
| `ExportImportService.ts` | Settings backup and restore |
| `FSLTLService.ts` | Legacy FSLTL service (being replaced by MSFS conversion) |
| `MetarService.ts` | METAR weather data parsing and fetching |
| `MigrationService.ts` | Settings migration between versions |
| `ModService.ts` | Custom aircraft/tower model loading |
| `MSFSModelConversionService.ts` | FSLTL/AIG model conversion orchestration |
| `RealTrafficService.ts` | RealTraffic API WebSocket client |
| `RunwayService.ts` | Runway data fetching for flight phase detection |
| `SettingsTreeBuilder.ts` | Hierarchical settings organization |
| `UpdateService.ts` | App update checking and installation |
| `UserVMRService.ts` | User VMR rule management |
| `VatsimService.ts` | VATSIM API data fetching |

### Stores (`stores/`)

Zustand state management (18 stores):

| Store | Purpose |
|-------|---------|
| `aircraftFilterStore.ts` | Search query, airport traffic filter |
| `aircraftTimelineStore.ts` | Debug timeline modal state |
| `airportStore.ts` | Current airport, tower height |
| `datablockPositionStore.ts` | Label positioning (global + per-aircraft) |
| `globalSettingsStore.ts` | Shared settings (Cesium token, MSFS paths, bookmarks) |
| `indexingStore.ts` | MSFS model indexing progress |
| `measureStore.ts` | Measuring tool state |
| `realTrafficStore.ts` | RealTraffic connection state |
| `replayStore.ts` | Replay buffer and playback state |
| `runwayStore.ts` | Runway data for current airport |
| `settingsStore.ts` | Local per-browser settings |
| `uiFeedbackStore.ts` | Toasts and notifications |
| `updateStore.ts` | App update availability |
| `vatsimStore.ts` | VATSIM pilots, aircraft states |
| `viewportStore.ts` | Viewport layout, camera state (primary camera store) |
| `vnasStore.ts` | vNAS connection state |
| `vrStore.ts` | WebXR VR session state |
| `weatherStore.ts` | METAR data, fog density |

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery (free tier available)
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 1 second)
- **RealTraffic API**: Optional real-world ADS-B traffic with ~2-3s updates (requires license key subscription)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub raw JSON on startup
- **Aviation Weather API**: `https://aviationweather.gov/api/data/metar` for METAR weather data (5-minute refresh)
- **FSLTL/AIG Models**: Optional MSFS aircraft models from Community folder (on-the-fly conversion)

## Modding System

Aircraft and tower 3D models can be loaded from the `mods/` directory:

```
mods/
├── aircraft/{TYPE}/
│   ├── manifest.json
│   └── model.glb
└── towers/{ICAO}/
    ├── manifest.json
    └── model.glb
```

See MODDING.md for manifest format and model requirements. Models are loaded on app startup; restart required for new mods.

## MSFS Model Conversion

TowerCab 3D can use aircraft models from FSLTL and AIG (AI traffic add-ons for Microsoft Flight Simulator) by converting them on-the-fly from MSFS GLTF format to GLB.

### Architecture

```
MSFSModelConversionService (TypeScript)
├─ initialize() - Detect FSLTL/AIG in Community folder, build model indexes
├─ resolveSourceModel() - Find model by name, respects source priority
├─ findModelByTypeAndAirline() - Match by aircraft type + airline code
├─ findClosestModel() - Dimension-based fallback matching with scale factors
├─ convertModel() - Queue conversion via Rust backend
└─ Cache management - Memory + disk cache with LRU eviction

msfs.rs (Rust backend)
├─ detect_msfs_installations() - Find FSLTL/AIG folders
├─ list_fsltl_models() / list_aig_models() - Parse aircraft.cfg, index liveries
├─ convert_msfs_model() - Execute Python converter sidecar
├─ Model index caching - JSON cache files for fast re-indexing
└─ scan_cache_directory() - Load pre-converted models on startup

fsltl_converter.exe (Python sidecar)
├─ Converts GLTF + DDS textures to GLB
├─ Texture scaling options (full/2k/1k/512)
├─ Handles multiple liveries per aircraft folder
└─ Built via PyInstaller (pnpm run build:converter)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/renderer/services/MSFSModelConversionService.ts` | Frontend conversion service |
| `src-tauri/src/msfs.rs` | Rust backend for detection, indexing, conversion |
| `scripts/shipping/conversion/convert_fsltl_batch.py` | Python converter (source) |
| `src-tauri/resources/fsltl_converter.exe` | Bundled converter executable |
| `scripts/shipping/build/build_converter.py` | Builds the Python converter |

### Model Matching Flow

1. **Exact match**: Aircraft type + airline code → specific livery
2. **Airline fallback**: Find any model for the airline (common narrowbody types)
3. **Dimension matching**: Find closest model by wingspan/length, apply scale factors
4. **Generic fallback**: Use built-in b738.glb model

### Settings (GlobalSettings.msfsModels)

- `communityPath`: MSFS Community folder location
- `enableFsltl` / `enableAig`: Toggle each source
- `priority`: Source priority order (`['fsltl', 'aig']`)
- `textureScale`: Texture downscaling (`'full'` | `'2k'` | `'1k'` | `'512'`)
- `cacheDirectory`: Where to store converted GLB files
- `cacheLimitMB`: Max cache size (LRU eviction when exceeded)

## Build Configuration

- **Tauri 2**: Native desktop wrapper with Rust backend
- **Vite 7**: Frontend build tool
- **TypeScript**: Strict mode with path aliases
- **React 19**: Latest React with concurrent features
- **vite-plugin-static-copy**: Cesium assets copied to output

## Scripts Organization

Scripts are organized under `scripts/` in two main categories:

```
scripts/
├── shipping/           # Production and build scripts
│   ├── build/          # Build tooling (converter, check, dev-wrapper)
│   ├── conversion/     # Model conversion (convert_fsltl_batch.py, texconv.exe)
│   └── data-generation/# One-off data scripts (aircraft data, airport surfaces, tower positions)
└── debugging/          # Development and debugging utilities
```

**Shipping scripts** are used for building, development, and data generation:
- `shipping/build/` - Build tools: check.js, build_converter.py, dev-wrapper.js
- `shipping/conversion/` - Runtime conversion: convert_fsltl_batch.py, texconv.exe
- `shipping/data-generation/` - One-off scripts: convert-aircraft-data.py, extract-airport-surfaces.py, scrape-tower-positions.py

**Debugging scripts** are utilities for development and troubleshooting:
- `analyze_animations.py` - GLB animation analysis
- `debug-rt-interpolation.cjs` - RealTraffic debugging
- `denoise-logs.cjs` - Log file cleanup
- `lookup_glb_source.py` - Find MSFS source for converted GLB
- `test-terrain-flattening.ts` - Terrain flattening tests

## Common Development Tasks

### Adding a New Setting

**Local Settings (per-browser) - Simple Case:**

For adding a new setting with a default value (most common):
1. Add field to the interface in `types/settings.ts` (e.g., `CesiumSettings`, `GraphicsSettings`)
2. Add default value to `DEFAULT_SETTINGS` in `types/settings.ts`
3. Increment the `version` number in `settingsStore.ts`
4. Add UI control in appropriate settings tab

That's it! The migration system has a "repair step" that automatically merges `DEFAULT_SETTINGS` with existing user settings, so new fields get their defaults automatically.

**When you DO need a custom migration:**
- Renaming a field (e.g., `modelBrightness` → `builtinModelBrightness`)
- Changing defaults for existing users (e.g., disabling a feature they had enabled)
- Conditional updates (e.g., only increase cache size if user never lowered it)

```typescript
// Example: Renaming a field (v6 → v7)
if (version < 7) {
  const oldValue = state.graphics?.oldFieldName ?? 1.0
  state = { ...state, graphics: { ...state.graphics, newFieldName: oldValue } }
}
```

**Global Settings (shared across devices):**
1. Add to `GlobalSettings` interface in `types/settings.ts`
2. Update `DEFAULT_GLOBAL_SETTINGS` in `types/settings.ts`
3. Add corresponding update function in `globalSettingsStore.ts`
4. **IMPORTANT:** Update the corresponding Rust struct in `src-tauri/src/settings.rs`
   - The Rust backend deserializes/serializes settings to disk
   - Fields not in the Rust struct will be silently dropped when saving
   - Add `#[serde(default)]` for new optional fields
5. Settings auto-sync via HTTP endpoints in remote mode

### Adding a New Keyboard Shortcut

1. Add key handler in `useCameraInput.ts` (for camera-related) or `App.tsx` (for global shortcuts)
2. Update keyboard reference in `SettingsHelpTab.tsx`
3. Update USER_GUIDE.md keyboard shortcuts section if user-facing

### Modifying Aircraft Rendering

1. Interpolation logic (60 Hz smooth motion): `useAircraftInterpolation.ts`
2. 3D model rendering: `CesiumViewer.tsx` (Cesium entities)
3. Datablock labels and leader lines: `useBabylonOverlay.ts` (Babylon.js GUI)

### Modifying Camera Behavior

1. Camera math: `useCesiumCamera.ts`
2. Input handling: `useCameraInput.ts`
3. Babylon sync: `useBabylonOverlay.ts`
4. State management: `viewportStore.ts` (all camera state, bookmarks, defaults)

### Modifying Weather Effects

1. METAR fetching: `weatherStore.ts`
2. Weather service: `services/WeatherService.ts`
3. Fog/cloud rendering: `useBabylonOverlay.ts`
4. Settings: `settingsStore.ts` (fog/cloud toggles, intensity)

### Modifying Viewport System

1. Viewport creation: `viewportStore.ts`
2. Viewport UI: `ViewportManager.tsx`, `ViewportContainer.tsx`
3. Inset initialization: `InsetCesiumViewer.tsx`
4. Drag/resize: `useDragResize.ts`

## Release Process

**Important:** Before creating a release tag, update version numbers in these files:

1. `package.json` - line 3: `"version": "X.X.X-alpha"`
2. `src-tauri/tauri.conf.json` - line 4: `"version": "X.X.X-alpha"`
3. `src-tauri/Cargo.toml` - line 3: `version = "X.X.X-alpha"`

All three files must have matching version numbers. The Tauri build uses these to name the installer.

### Release Steps

1. Update version in all three files above
2. Move `[Unreleased]` entries in CHANGELOG.md to new version header
3. Run `pnpm run check` to run all validation checks (Biome, TypeScript, Rust)
4. Commit: `git commit -m "Release vX.X.X-alpha"`
5. Tag: `git tag vX.X.X-alpha`
6. Push: `git push && git push --tags`

The `release.yml` workflow will automatically build and upload the installer to the GitHub release.

### Using the Release Manager Agent

When the user requests a release, use the `release-manager` agent with clear instructions to complete the entire process without stopping for confirmation:

```
Release vX.X.X-alpha. Complete the entire release process without stopping for confirmation - the user has already approved this release.
```

Do not stop to ask "Would you like me to proceed?" - the user's request to release is the approval.

## Preserving Agent Output

When invoking agents (Plan, Explore, code-reviewer, etc.) that produce plans, analysis, or recommendations you intend to act on, **save the results to a temporary `.md` file** (e.g., `agent-plan.md`, `review-notes.md`). This prevents loss during "compact conversation" operations that summarize older messages.

Delete the temporary file once you've completed the work addressing the agent's output.

## Changelog Maintenance

**Important:** Maintain `CHANGELOG.md` whenever committing changes. This file informs end users about updates between releases.

### What Belongs in CHANGELOG

**DO include:**
- ✅ New features users can see/use
- ✅ Bug fixes that affect user experience
- ✅ Changes to existing features/behavior
- ✅ Removed features or settings
- ✅ Performance improvements users will notice

**DO NOT include:**
- ❌ Internal refactoring or code improvements
- ❌ TypeScript/compilation fixes (unless they fix a user-visible bug)
- ❌ Developer tooling changes (build scripts, CI/CD, etc.)
- ❌ Dependency updates (unless they add user-facing features)
- ❌ Code quality improvements (linting, type safety, etc.)

**Key principle:** If a user wouldn't notice or care about the change, don't add it to CHANGELOG.

**Important:** Don't list "fixes" for features that haven't been released yet. If you're developing a new feature and fix bugs during development, those fixes are just part of the feature - they go under "Added", not "Fixed". The "Fixed" category is only for bugs that existed in a published release.

### Guidelines

1. **Update only for user-facing changes**: Not every commit needs a changelog entry
2. **Use simple language**: Write for end users, not developers. Avoid technical jargon
3. **Group by version**: Use `## [Unreleased]` for pending changes, move to version headers on release
4. **Categorize changes**: Use these section headers within each version:
   - `### Added` - New features
   - `### Changed` - Changes to existing features
   - `### Fixed` - Bug fixes
   - `### Removed` - Removed features

### Writing Style

- Focus on what users will notice, not implementation details
- Use active voice: "Added dark mode" not "Dark mode was added"
- Be specific but concise: "Fixed aircraft labels disappearing when zooming out" not "Fixed label bug"
- Explain the user benefit, not the technical solution

### Examples

**Good (user-friendly):**
```markdown
### Added
- Weather effects now show fog and clouds based on real METAR data
- New settings panel with tabs for easier navigation

### Fixed
- Aircraft no longer appear in the wrong position when first loading an airport
- Shadow banding artifacts no longer visible (ambient occlusion disabled by default)

### Changed
- Improved shadow quality at longer distances (increased max range to 10km)
```

**Avoid (too technical):**
```markdown
### Fixed
- Fixed TypeScript compilation errors in CesiumViewer
- Added type assertion for scene.context._gl access
- Exported PreFollowState interface from viewportStore

### Changed
- Refactored useBabylonOverlay to use ENU transforms
- Added cameraSyncedRef to prevent race condition in label projection
```
