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

**Important:** Always run ESLint before committing changes:

```bash
npx eslint src/        # Check for linting errors
npx eslint src/ --fix  # Auto-fix fixable issues
```

Fix all ESLint errors before committing. Do not disable ESLint rules without a justified reason.

## Architecture

### Dual Rendering System

The application uses two 3D rendering engines simultaneously:

- **CesiumJS** (`cesium ^1.136.0`): Renders the globe, terrain, satellite imagery via Cesium Ion
- **Babylon.js** (`@babylonjs/core ^8.42.0`): Renders 3D aircraft models, weather effects (fog dome, cloud layers), measuring tool visualizations, and VR stereo display as a transparent overlay on top of Cesium

The `useBabylonOverlay` hook synchronizes the Babylon.js camera with Cesium's camera each frame using ENU (East-North-Up) coordinate transformations. Aircraft positions are converted from geographic coordinates (lat/lon/alt) to Babylon's local coordinate system relative to a root node positioned at the tower location.

### Process Architecture (Tauri)

- **Rust backend** (`src-tauri/`): Window management, native OS integration via Tauri 2
- **Frontend** (`src/renderer/`): React 19 application with Cesium/Babylon visualization

### State Management (Zustand)

Eight stores manage application state:

| Store | File | Responsibility |
|-------|------|----------------|
| `vatsimStore` | `stores/vatsimStore.ts` | Polls VATSIM API every 3s, stores pilot data, manages interpolation states |
| `airportStore` | `stores/airportStore.ts` | Airport database (28,000+ airports) from mwgg/Airports GitHub repo |
| `viewportStore` | `stores/viewportStore.ts` | **Primary camera store.** Multi-viewport management, per-viewport camera state, bookmarks, defaults, inset positions/sizes |
| `cameraStore` | `stores/cameraStore.ts` | **DEPRECATED.** Legacy store kept only for export/import backward compatibility. Do not use for new features. |
| `settingsStore` | `stores/settingsStore.ts` | Cesium Ion token, display settings, terrain quality, weather settings (persisted to localStorage) |
| `weatherStore` | `stores/weatherStore.ts` | METAR data fetching, weather state (visibility, clouds, ceiling) |
| `measureStore` | `stores/measureStore.ts` | Active measurement points, measurement mode state |
| `vrStore` | `stores/vrStore.ts` | VR session state, WebXR availability, IPD settings |

> **Important:** All camera-related functionality (heading, pitch, fov, follow mode, bookmarks, defaults) should use `viewportStore`, not `cameraStore`. The `cameraStore` is deprecated and only exists for backward compatibility with the export/import service.

### Aircraft Data Flow

1. **Fetch**: `VatsimService` fetches pilot data from VATSIM API (every 3s poll, 15s actual update interval)
2. **Store**: `vatsimStore` stores raw pilot data and creates aircraft state records for interpolation
3. **Interpolate**: `useAircraftInterpolation` hook smoothly interpolates positions between API updates
4. **Filter**: `CesiumViewer` filters aircraft by distance from tower and sorts by proximity
5. **Render Labels**: Cesium entities display HTML text labels with callsign, altitude, speed
6. **Render 3D**: Babylon.js overlay renders cone meshes with shadows at interpolated positions

### Key Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useAircraftInterpolation` | `hooks/useAircraftInterpolation.ts` | Smooth position/heading interpolation between 15s API updates |
| `useCesiumCamera` | `hooks/useCesiumCamera.ts` | Tower-based camera controls, follow modes, top-down view (per-viewport) |
| `useCameraInput` | `hooks/useCameraInput.ts` | Keyboard/mouse input handling for camera (WASD, arrows, mouse drag) |
| `useActiveViewportCamera` | `hooks/useActiveViewportCamera.ts` | Returns camera state for the currently active viewport |
| `useBabylonOverlay` | `hooks/useBabylonOverlay.ts` | Syncs Babylon camera with Cesium, manages 3D aircraft meshes and shadows |
| `useBabylonCameraSync` | `hooks/useBabylonCameraSync.ts` | Synchronizes Babylon.js camera matrix with Cesium's view |
| `useCesiumStereo` | `hooks/useCesiumStereo.ts` | Dual-pass Cesium stereo rendering for VR (left/right eye frustums) |
| `useDragResize` | `hooks/useDragResize.ts` | Drag and resize functionality for inset viewports |
| `useVatsimData` | `hooks/useVatsimData.ts` | Wrapper for accessing VATSIM store with auto-polling |

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `CesiumViewer` | `components/CesiumViewer/CesiumViewer.tsx` | 3D globe with aircraft entities, camera setup, weather effects |
| `ViewportManager` | `components/Viewport/ViewportManager.tsx` | Manages main viewport and inset viewports |
| `ViewportContainer` | `components/Viewport/ViewportContainer.tsx` | Container for a single viewport (main or inset) |
| `InsetCesiumViewer` | `components/Viewport/InsetCesiumViewer.tsx` | Delayed-init wrapper for inset Cesium viewers |
| `ControlsBar` | `components/UI/ControlsBar.tsx` | Bottom HUD with camera controls, FOV slider, following status |
| `TopBar` | `components/UI/TopBar.tsx` | Airport selector, Zulu time, connection status |
| `AircraftPanel` | `components/UI/AircraftPanel.tsx` | Right-side nearby aircraft list with sorting/filtering |
| `AirportSelector` | `components/UI/AirportSelector.tsx` | Airport search modal with recent/popular airports |
| `GlobalSearchPanel` | `components/UI/GlobalSearchPanel.tsx` | Ctrl+K search across all VATSIM aircraft |
| `CommandInput` | `components/UI/CommandInput.tsx` | Terminal-style input for bookmark save/load (.XX. syntax) |
| `MeasuringTool` | `components/UI/MeasuringTool.tsx` | Distance measurement visualization on terrain |
| `VRButton` | `components/VR/VRButton.tsx` | WebXR session entry button (shows when VR available) |
| `VRScene` | `components/VR/VRScene.tsx` | Babylon.js WebXR scene with stereo background planes |

## Path Alias

`@/` maps to `src/renderer/` (configured in vite.config.ts)

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery (free tier available)
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 3 seconds)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub raw JSON on startup
- **Aviation Weather API**: `https://aviationweather.gov/api/data/metar` for METAR weather data (5-minute refresh)

## Multi-Viewport Architecture

The application supports multiple simultaneous views through the viewport system:

- **Main Viewport**: Always present, full-screen Cesium viewer
- **Inset Viewports**: Overlay windows with independent Cesium viewers
- **Active Viewport**: Only one viewport receives keyboard/mouse input at a time (cyan border)
- Each viewport maintains independent camera state (heading, pitch, FOV, follow target)
- Inset positions and sizes are persisted per-airport in localStorage

## Weather System

METAR-based weather visualization:

1. **Fetch**: `weatherStore` fetches METAR data from Aviation Weather API
2. **Parse**: Extracts visibility, cloud layers (SCT/BKN/OVC), and ceiling
3. **Cesium Fog**: Reduces terrain draw distance based on visibility
4. **Babylon Fog Dome**: Semi-transparent dome mesh at visibility boundary with fresnel effect
5. **Cloud Layers**: Plane meshes positioned at METAR-reported ceiling altitudes
6. **Datablock Culling**: Hides aircraft labels beyond visibility or behind cloud layers

## Camera System

### View Modes

1. **3D Tower View**: Camera at tower position with heading/pitch/FOV controls
2. **Top-Down View**: Orthographic-style view looking straight down, altitude adjustable

### Follow Modes

1. **Tower Mode**: Camera stays at tower, rotates to track aircraft, zoom adjusts FOV
2. **Orbit Mode**: Camera orbits around aircraft at configurable distance/heading/pitch

### Camera State

```typescript
interface CameraState {
  heading: number           // 0-360 degrees
  pitch: number             // -90 to 90 degrees
  fov: number               // 10-120 degrees (default 60)
  positionOffset: { x, y, z } // Meters from tower center
  topDownAltitude: number   // Meters above airport (top-down mode)
  isTopDown: boolean        // View mode toggle
  followTarget: string | null // Aircraft callsign or null
  followMode: 'tower' | 'orbit'
  orbitDistance: number     // 50-5000 meters
  orbitHeading: number      // 0-360 degrees around aircraft
  orbitPitch: number        // -89 to 89 degrees
}
```

### Bookmark System

- 99 slots per airport (`.00` through `.99`)
- Save: Type `.XX.` (e.g., `.00.`) and press Enter
- Load: Type `.XX` (e.g., `.00`) and press Enter
- Stores: heading, pitch, FOV, position offsets, view mode

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

1. Add to `settingsStore.ts` state interface and initial state
2. Add persistence in the store's `persist` middleware config
3. Add UI control in `SettingsModal.tsx`

### Adding a New Keyboard Shortcut

1. Add key handler in `useCameraInput.ts` (for camera-related) or `App.tsx` (for global shortcuts)
2. Update keyboard reference in Settings Help tab

### Modifying Aircraft Rendering

1. Interpolation logic: `useAircraftInterpolation.ts`
2. 3D mesh creation: `useBabylonOverlay.ts`
3. Label rendering: `CesiumViewer.tsx` (HTML entities)

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

### Guidelines

1. **Update on every commit**: Add an entry describing what changed in user-friendly terms
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

### Examples

**Good (user-friendly):**
```markdown
### Added
- Weather effects now show fog and clouds based on real METAR data
- New settings panel with tabs for easier navigation

### Fixed
- Aircraft no longer appear in the wrong position when first loading an airport
```

**Avoid (too technical):**
```markdown
### Changed
- Refactored useBabylonOverlay to use ENU transforms
- Added cameraSyncedRef to prevent race condition in label projection
```
