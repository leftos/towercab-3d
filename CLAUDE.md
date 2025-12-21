# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TowerCab 3D is a Tauri 2 desktop application that provides a 3D tower cab view for VATSIM air traffic controllers. It displays real-time aircraft positions on a 3D globe with satellite imagery and terrain, featuring smooth camera controls, aircraft following modes, and extensive customization options.

## Development Commands

```bash
npm install        # Install dependencies
npm run dev        # Start development mode with hot reload (Tauri desktop app)
npm run serve      # Run in browser mode (opens http://localhost:5173 in default browser)
npm run build      # Build for production (outputs Windows installer to src-tauri/target/release/bundle/)
npm run vite:dev   # Frontend only (internal, used by Tauri)
npm run vite:build # Build frontend only (internal, used by Tauri)
```

**Note for Claude:** Only the user can run `npm run dev` as it launches the Tauri app with a GUI. Ask the user to run this command and report back any errors.

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

> **📖 Detailed Documentation:** See `src/renderer/docs/architecture.md` for comprehensive diagrams of data flow, rendering pipeline, multi-viewport system, and hook dependencies.

> **📐 Coordinate Systems:** See `src/renderer/docs/coordinate-systems.md` for detailed explanation of geographic, Cartesian3, and ENU coordinate transformations.

### Dual Rendering System

The application uses two 3D rendering engines simultaneously:

- **CesiumJS** (`cesium ^1.136.0`): Renders the globe, terrain, satellite imagery, and aircraft 3D models via Cesium Ion
- **Babylon.js** (`@babylonjs/core ^8.42.0`): Renders screen-space datablock labels, leader lines, weather effects (fog dome, cloud layers), measuring tool visualizations, and VR stereo display as a transparent overlay on top of Cesium

The `useBabylonOverlay` hook synchronizes the Babylon.js camera with Cesium's camera each frame for correct screen-space label positioning. Weather effects use ENU (East-North-Up) coordinate transformations relative to a root node positioned at the tower location.

### Process Architecture (Tauri)

- **Rust backend** (`src-tauri/`): Window management, native OS integration via Tauri 2
- **Frontend** (`src/renderer/`): React 19 application with Cesium/Babylon visualization

### State Management (Zustand)

Nine stores manage application state:

| Store | File | Responsibility |
|-------|------|----------------|
| `vatsimStore` | `stores/vatsimStore.ts` | Polls VATSIM API every 3s, stores pilot data, manages interpolation states |
| `airportStore` | `stores/airportStore.ts` | Airport database (28,000+ airports) from mwgg/Airports GitHub repo |
| `viewportStore` | `stores/viewportStore.ts` | **Primary camera store.** Multi-viewport management, per-viewport camera state, bookmarks, defaults, inset positions/sizes |
| `cameraStore` | `stores/cameraStore.ts` | **DEPRECATED.** Legacy store kept only for export/import backward compatibility. Do not use for new features. |
| `settingsStore` | `stores/settingsStore.ts` | **Grouped settings** organized by domain (cesium, graphics, camera, weather, memory, aircraft, ui). Persisted to localStorage with auto-migration from v1 (flat) to v2 (grouped). |
| `weatherStore` | `stores/weatherStore.ts` | METAR data fetching, weather state (visibility, clouds, ceiling) |
| `measureStore` | `stores/measureStore.ts` | Active measurement points, measurement mode state |
| `aircraftFilterStore` | `stores/aircraftFilterStore.ts` | Panel filter state (search query, airport traffic filter, weather visibility filter) affecting both list and datablocks |
| `vrStore` | `stores/vrStore.ts` | VR session state, WebXR availability, IPD settings |

> **Important:** All camera-related functionality (heading, pitch, fov, follow mode, bookmarks, defaults) should use `viewportStore`, not `cameraStore`. The `cameraStore` is deprecated and only exists for backward compatibility with the export/import service.

### Key Directories

- **`hooks/`**: React hooks for Cesium, Babylon, camera, aircraft interpolation, and input handling
- **`components/`**: UI components (TopBar, ControlsBar, panels) and viewers (CesiumViewer, ViewportManager)
- **`stores/`**: Zustand state management (see table above)
- **`services/`**: API clients (VatsimService, WeatherService, AircraftModelService)
- **`types/`**: Centralized TypeScript interfaces organized by domain
- **`constants/`**: Configuration values and magic numbers

> **📖 For detailed hook dependencies, data flows, and component hierarchy:** See `src/renderer/docs/architecture.md`

## Path Alias

`@/` maps to `src/renderer/` (configured in vite.config.ts)

## Type System Organization

All TypeScript types are centralized in the `types/` directory, organized by domain:

| File | Purpose |
|------|---------|
| `types/camera.ts` | Camera state, view modes, follow modes, bookmarks |
| `types/viewport.ts` | Viewport layout, multi-viewport configuration, inset positioning |
| `types/weather.ts` | METAR data, cloud layers, fog density, flight categories |
| `types/settings.ts` | Application settings (grouped by domain: cesium, graphics, camera, weather, memory) |
| `types/vatsim.ts` | VATSIM API data structures, pilot/controller data |
| `types/babylon.ts` | Babylon.js types (labels, weather meshes, scene options, hook return types, ENU transforms) |
| `types/index.ts` | Barrel export for all types |

**Usage:**
```typescript
// Import types from centralized location
import type { ViewportCameraState, FollowMode, ViewMode } from '@/types'

// Or use path alias
import type { CloudLayer, FogDensity } from '@/types'

// All types include comprehensive JSDoc with examples
const camera: ViewportCameraState = {
  heading: 0,
  pitch: -15,
  fov: 60,
  // ...
}
```

**When to add a type:**
- Data structures shared across multiple files
- Complex interfaces with reusable properties
- Enums or union types for state machines
- API response/request shapes

**Best practices:**
- Use `import type` for type-only imports (better tree-shaking)
- Add JSDoc documentation for complex types
- Include state machine diagrams for modes/states
- Document units (degrees, meters, etc.) in comments

## Constants Organization

Configuration values and magic numbers are centralized in the `constants/` directory for easy discovery and maintenance:

| File | Purpose |
|------|---------|
| `constants/rendering.ts` | Aircraft model pool sizes, shadow configuration, positioning offsets, colors |
| `constants/camera.ts` | FOV/pitch/heading limits, orbit mode defaults, follow mode settings, top-down view settings |
| `constants/api.ts` | External API endpoints (VATSIM, weather, airports), polling intervals, cache TTL |
| `constants/babylon.ts` | Babylon.js scene/camera settings, cloud/fog parameters, visibility thresholds, lighting values |
| `constants/index.ts` | Barrel export for all constants |

**Usage:**
```typescript
// Import specific constants
import { FOV_DEFAULT, VATSIM_POLL_INTERVAL } from '@/constants'

// Or import from domain-specific file
import { ORBIT_DISTANCE_MIN, ORBIT_DISTANCE_MAX } from '@/constants/camera'

// All constants are documented with JSDoc
const distance = Math.max(ORBIT_DISTANCE_MIN, Math.min(ORBIT_DISTANCE_MAX, value))
```

**When to add a constant:**
- Configuration values used in multiple places
- Numeric limits or thresholds
- API endpoints or URLs
- Timing intervals (polling, refresh, throttle)
- Default values for settings

**Naming convention:**
- Use `SCREAMING_SNAKE_CASE` for constants
- Suffix pattern: `FEATURE_PROPERTY_QUALIFIER` (e.g., `FOV_DEFAULT`, `ORBIT_DISTANCE_MAX`)
- Group related constants with common prefixes

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery (free tier available)
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 3 seconds)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub raw JSON on startup
- **Aviation Weather API**: `https://aviationweather.gov/api/data/metar` for METAR weather data (5-minute refresh)

## Key Systems

### Multi-Viewport
- **Main Viewport**: Full-screen Cesium viewer (always present)
- **Inset Viewports**: Draggable/resizable overlay windows with independent cameras
- **Active Viewport**: Cyan border indicates which viewport receives input

### Weather (METAR-based)
- Cesium fog reduces terrain draw distance based on visibility
- Babylon.js renders fog dome and cloud layer meshes
- Labels hidden beyond visibility or behind clouds

### Camera
- **View Modes**: 3D Tower View (heading/pitch/FOV) or Top-Down View (altitude adjustable)
- **Follow Modes**: Tower (camera at tower, rotates to track) or Orbit (camera orbits aircraft)
- **Bookmarks**: 99 slots per airport (`.00`-`.99`). Save: `.XX.` + Enter. Load: `.XX` + Enter.

> **📖 For detailed camera state, data flows, and coordinate transforms:** See `src/renderer/docs/architecture.md`

## Performance Features

- **Service Worker Caching**: Tile caching with configurable disk size (0.1-10 GB)
- **In-Memory Tile Cache**: Configurable 50-500 tiles
- **Distance-Based Filtering**: Aircraft data filtered by radius from airport
- **Terrain Quality Levels**: 5 levels (Low to Ultra) affecting tile detail
- **MSAA 4x**: Anti-aliasing on Babylon overlay

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

1. Add to `types/settings.ts` grouped interface (cesium, graphics, camera, weather, memory, aircraft, or ui)
2. Update `DEFAULT_SETTINGS` in `settingsStore.ts`
3. Add corresponding update function validation (if needed)
4. Add UI control in `ControlsBar.tsx` under the appropriate tab
5. Settings are auto-persisted to localStorage with migration support

### Adding a New Keyboard Shortcut

1. Add key handler in `useCameraInput.ts` (for camera-related) or `App.tsx` (for global shortcuts)
2. Update keyboard reference in Settings Help tab

### Modifying Aircraft Rendering

1. Interpolation logic (60 Hz smooth motion): `useAircraftInterpolation.ts`
2. 3D model rendering (aircraft cones/models): `CesiumViewer.tsx` (Cesium entities)
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
3. Commit: `git commit -m "Release vX.X.X-alpha"`
4. Tag: `git tag vX.X.X-alpha`
5. Push: `git push && git push --tags`

The `release.yml` workflow will automatically build and upload the installer to the GitHub release.

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
