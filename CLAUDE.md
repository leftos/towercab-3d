# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TowerCab 3D is an Electron desktop application that provides a 3D tower cab view for VATSIM air traffic controllers. It displays real-time aircraft positions on a 3D globe with satellite imagery and terrain.

## Development Commands

```bash
npm install        # Install dependencies
npm run dev        # Start development mode with hot reload
npm run build      # Build for production (outputs to dist/)
npm run preview    # Preview production build
```

## Architecture

### Dual Rendering System
The application uses two 3D rendering engines simultaneously:
- **CesiumJS**: Renders the globe, terrain, satellite imagery, and text labels
- **Babylon.js**: Renders 3D aircraft cone meshes as an overlay on top of Cesium

The `useBabylonOverlay` hook synchronizes the Babylon.js camera with Cesium's camera each frame. Aircraft positions are converted from geographic coordinates (lat/lon/alt) to Babylon's coordinate system relative to a root node positioned at the tower location.

### Process Architecture (Electron)
- **Main process** (`src/main/`): Window management, uses `@electron-toolkit/utils`
- **Preload** (`src/preload/`): Context bridge (minimal currently)
- **Renderer** (`src/renderer/`): React application with Cesium/Babylon visualization

### State Management (Zustand)
- `vatsimStore`: Polls VATSIM API every 15 seconds, stores pilot data and aircraft states for interpolation
- `airportStore`: Airport database loaded from mwgg/Airports GitHub repo
- `cameraStore`: Camera orientation, FOV, position offsets, follow mode, view mode (3D/top-down)
- `settingsStore`: Cesium Ion token, display settings (persisted to localStorage)

### Aircraft Rendering Pipeline
1. `VatsimService` fetches pilot data from VATSIM API
2. `useAircraftInterpolation` hook smoothly interpolates positions between API updates
3. `CesiumViewer` filters/sorts aircraft by distance from tower
4. Cesium entities display text labels
5. Babylon.js overlay renders 3D cone meshes at interpolated positions

### Key Hooks
- `useAircraftInterpolation`: Smooth position interpolation between 15-second API updates
- `useCesiumCamera`: Manages tower-based camera controls, follow mode, top-down view
- `useBabylonOverlay`: Syncs Babylon camera with Cesium, manages 3D aircraft meshes

## Path Alias

`@/` maps to `src/renderer/` (configured in electron.vite.config.ts)

## External Dependencies

- **Cesium Ion**: Requires user-provided access token for terrain/imagery
- **VATSIM API**: `https://data.vatsim.net/v3/vatsim-data.json` (polled every 15s)
- **Airport Database**: Fetched from `mwgg/Airports` GitHub repo on startup

## Modding System

Aircraft and tower 3D models can be loaded from the `mods/` directory:
- `mods/aircraft/{TYPE}/manifest.json` + `model.glb`
- `mods/towers/{ICAO}/manifest.json` + `model.glb`

See MODDING.md for manifest format and model requirements.
