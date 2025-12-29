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

## Development Commands

```bash
npm install           # Install dependencies
npm run dev           # Start desktop app (without vNAS)
npm run dev:vnas      # Start desktop app with vNAS 1Hz updates (requires private repo access)
npm run serve         # Development: frontend only in browser (no Tauri, no mods)
npm run build         # Build for production without vNAS
npm run build:vnas    # Build for production with vNAS (requires private repo access)
npm run build:converter  # Build FSLTL converter executable (requires Python + PyInstaller)
npm run vite:dev      # Frontend only (internal, used by Tauri)
npm run vite:build    # Build frontend only (internal, used by Tauri)
```

### vNAS Integration

The optional `vnas` feature enables 1Hz real-time aircraft updates via the private `towercab-3d-vnas` crate. Without it, the app uses 15-second VATSIM HTTP polling.

- **Public contributors:** Use `npm run dev` and `npm run build` - no private repo access needed
- **With vNAS access:** Use `npm run dev:vnas` and `npm run build:vnas`
- **Signed builds:** `.\build-signed.ps1` (with vNAS) or `.\build-signed.ps1 -NoVnas`

**Dependency updates:** The `npm run dev:vnas` and `npm run build:vnas` commands automatically run `cargo update -p towercab-3d-vnas` before building to fetch the latest commits from the private repo's master branch. This is also configured in the private repo's CI workflow, so builds always use the latest implementation.

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

**Note:** The `npm run build` command automatically runs `build:converter` to create the FSLTL model converter executable. This requires Python 3 with Pillow installed. PyInstaller is auto-installed if missing.

**Note for Claude:** Only the user can run `npm run dev` as it launches the Tauri app with a GUI. Ask the user to run this command and report back any errors.

**Windows Warning:** Never use `2>nul` to suppress stderr in terminal commands. On Windows, this creates a file literally named `nul` which is extremely difficult to delete (requires special tools or booting from Linux). Use `2>$null` in PowerShell or simply omit stderr redirection.

**Important:** Always run ESLint and TypeScript checks before committing changes:

```bash
npx eslint src/         # Check for linting errors
npx eslint src/ --fix   # Auto-fix fixable issues
npm run typecheck       # Run TypeScript type checking (CRITICAL)
```

Fix all ESLint and TypeScript errors before committing. Do not disable rules without a justified reason.

### Why Type Checking Matters

**CRITICAL:** Vite does not perform type checking during builds - it only transpiles TypeScript to JavaScript using esbuild. This means type errors can slip through if you don't explicitly run `tsc`.

**TypeScript errors were previously missed because:**
1. `vite build` uses esbuild for transpilation, which skips type checking for performance
2. ESLint checks code style/patterns, not type correctness
3. `skipLibCheck: true` in tsconfig.json skips checking node_modules types (for performance)
4. There was no explicit `tsc --noEmit` check in the build workflow

**The `npm run typecheck` script is now part of the build process to prevent this in the future.**

Always run `npm run typecheck` before:
- Creating a commit
- Opening a pull request
- Before `npm run build`

The build script now automatically runs typecheck first, so production builds will fail if there are type errors.

## Architecture

See `src/renderer/docs/architecture.md` for detailed documentation including:
- Data flow diagrams (VATSIM, weather, settings)
- Store relationships (15 Zustand stores)
- Hook dependencies and call order
- Rendering pipeline (Cesium + Babylon.js)
- Component hierarchy
- Coordinate system transformations (see also `coordinate-systems.md`)

**Quick reference:** Tauri 2 desktop app with React 19 frontend. Dual rendering: CesiumJS (globe/terrain/aircraft) + Babylon.js overlay (labels/weather). Use `viewportStore` for camera state (not deprecated `cameraStore`). HTTP server (axum, port 8765) serves frontend to remote browsers. Use `remoteMode.ts` utilities to detect Tauri vs browser mode.

## Path Alias

`@/` maps to `src/renderer/` (configured in vite.config.ts)

## Code Organization

### Types (`types/`)

All TypeScript types centralized by domain. Import via `import type { ... } from '@/types'`:

| File | Purpose |
|------|---------|
| `airport.ts` | Airport data, tower height |
| `babylon.ts` | Labels, weather meshes, ENU transforms |
| `camera.ts` | Camera state, view/follow modes, bookmarks |
| `fsltl.ts` | FSLTL conversion, airline mapping |
| `mod.ts` | Modding manifest formats |
| `replay.ts` | Replay snapshots, playback state |
| `settings.ts` | App settings (cesium, graphics, camera, weather, memory, aircraft, ui) + GlobalSettings (cesiumIonToken, FSLTL paths, viewport data shared across devices) |
| `vatsim.ts` | VATSIM and RealTraffic API structures, ADS-B fields |
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

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery (free tier available)
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 1 second)
- **RealTraffic API**: Optional real-world ADS-B traffic with ~2-3s updates (requires license key subscription)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub raw JSON on startup
- **Aviation Weather API**: `https://aviationweather.gov/api/data/metar` for METAR weather data (5-minute refresh)

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

## Build Configuration

- **Tauri 2**: Native desktop wrapper with Rust backend
- **Vite 7**: Frontend build tool
- **TypeScript**: Strict mode with path aliases
- **React 19**: Latest React with concurrent features
- **vite-plugin-static-copy**: Cesium assets copied to output

## Common Development Tasks

### Adding a New Setting

**Local Settings (per-browser):**
1. Add to `types/settings.ts` grouped interface (cesium, graphics, camera, weather, memory, aircraft, or ui)
2. Update `DEFAULT_SETTINGS` in `types/settings.ts`
3. Add corresponding update function in `settingsStore.ts` (if needed)
4. **IMPORTANT: Increment the `version` number in `settingsStore.ts` and add a migration** that merges the new defaults with existing user settings. Without this, existing users won't get the new settings and values will be `undefined`. Example migration:
   ```typescript
   if (version < NEW_VERSION) {
     const state = persistedState as Partial<typeof DEFAULT_SETTINGS>
     return {
       ...state,
       GROUP_NAME: { ...DEFAULT_SETTINGS.GROUP_NAME, ...state.GROUP_NAME }
     }
   }
   ```
5. Add UI control in appropriate settings tab

**Global Settings (shared across devices):**
1. Add to `GlobalSettings` interface in `types/settings.ts`
2. Update `DEFAULT_GLOBAL_SETTINGS` in `types/settings.ts`
3. Add corresponding update function in `globalSettingsStore.ts`
4. Settings auto-sync via HTTP endpoints in remote mode

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
3. Run `npm run typecheck` to verify no type errors
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
