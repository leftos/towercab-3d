# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TowerCab 3D is an Electron desktop application that provides a 3D tower cab view for VATSIM air traffic controllers. It displays real-time aircraft positions on a 3D globe with satellite imagery and terrain, featuring smooth camera controls, aircraft following modes, and extensive customization options.

## Development Commands

```bash
npm install        # Install dependencies
npm run dev        # Start development mode with hot reload
npm run build      # Build for production (outputs to out/)
npm run preview    # Preview production build
npm run dist       # Build and package for Windows (outputs to dist/)
```

**Note for Claude:** Only the user can run `npm run dev` and `npm run preview` as these launch the Electron app with a GUI. Ask the user to run these commands and report back any errors.

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
- **Babylon.js** (`@babylonjs/core ^8.42.0`): Renders 3D aircraft cone meshes as a transparent overlay on top of Cesium

The `useBabylonOverlay` hook synchronizes the Babylon.js camera with Cesium's camera each frame using ENU (East-North-Up) coordinate transformations. Aircraft positions are converted from geographic coordinates (lat/lon/alt) to Babylon's local coordinate system relative to a root node positioned at the tower location.

### Process Architecture (Electron)

- **Main process** (`src/main/`): Window management, uses `@electron-toolkit/utils`
- **Preload** (`src/preload/`): Context bridge with electronAPI exposure
- **Renderer** (`src/renderer/`): React 19 application with Cesium/Babylon visualization

### State Management (Zustand)

Five stores manage application state:

| Store | File | Responsibility |
|-------|------|----------------|
| `vatsimStore` | `stores/vatsimStore.ts` | Polls VATSIM API every 3s, stores pilot data, manages interpolation states |
| `airportStore` | `stores/airportStore.ts` | Airport database (28,000+ airports) from mwgg/Airports GitHub repo |
| `cameraStore` | `stores/cameraStore.ts` | Camera orientation, FOV, position offsets, follow mode, view mode, bookmarks |
| `settingsStore` | `stores/settingsStore.ts` | Cesium Ion token, display settings, terrain quality (persisted to localStorage) |
| `labelStore` | `stores/labelStore.ts` | Label visibility, positions, and rendering state |

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
| `useCesiumCamera` | `hooks/useCesiumCamera.ts` | Tower-based camera controls, WASD movement, follow modes, top-down view |
| `useBabylonOverlay` | `hooks/useBabylonOverlay.ts` | Syncs Babylon camera with Cesium, manages 3D aircraft meshes and shadows |
| `useVatsimData` | `hooks/useVatsimData.ts` | Wrapper for accessing VATSIM store with auto-polling |
| `useKeyboardControls` | `hooks/useKeyboardControls.ts` | All keyboard input handling (WASD, arrows, shortcuts) |

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `CesiumViewer` | `components/CesiumViewer.tsx` | Main 3D globe with aircraft entities and camera setup |
| `BabylonOverlay` | `components/BabylonOverlay.tsx` | Transparent Babylon.js canvas overlay |
| `ControlsBar` | `components/ControlsBar.tsx` | Bottom HUD with camera controls, FOV slider, following status |
| `TopBar` | `components/TopBar.tsx` | Airport selector, Zulu time, connection status |
| `AircraftPanel` | `components/AircraftPanel.tsx` | Right-side nearby aircraft list with sorting/filtering |
| `SettingsModal` | `components/SettingsModal.tsx` | Configuration UI for all settings |
| `AirportSelector` | `components/AirportSelector.tsx` | Airport search modal with recent/popular airports |
| `GlobalSearch` | `components/GlobalSearch.tsx` | Ctrl+K search across all VATSIM aircraft |
| `CommandInput` | `components/CommandInput.tsx` | Terminal-style input for bookmark save/load (.XX. syntax) |

## Path Alias

`@/` maps to `src/renderer/` (configured in electron.vite.config.ts)

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery (free tier available)
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 3 seconds)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub raw JSON on startup

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

- **Vite**: Build tool with electron-vite plugin
- **TypeScript**: Strict mode with path aliases
- **React 19**: Latest React with concurrent features
- **Cesium Build Plugin**: `vite-plugin-cesium-build` for Cesium asset handling
- **Static Copy**: Cesium workers copied to output

## Common Development Tasks

### Adding a New Setting

1. Add to `settingsStore.ts` state interface and initial state
2. Add persistence in the store's `persist` middleware config
3. Add UI control in `SettingsModal.tsx`

### Adding a New Keyboard Shortcut

1. Add key handler in `useKeyboardControls.ts`
2. Update keyboard reference in `SettingsModal.tsx`

### Modifying Aircraft Rendering

1. Interpolation logic: `useAircraftInterpolation.ts`
2. 3D mesh creation: `useBabylonOverlay.ts`
3. Label rendering: `CesiumViewer.tsx` (HTML entities)

### Modifying Camera Behavior

1. Camera math: `useCesiumCamera.ts`
2. Babylon sync: `useBabylonOverlay.ts`
3. State management: `cameraStore.ts`

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
