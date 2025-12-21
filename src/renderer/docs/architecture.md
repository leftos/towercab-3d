# TowerCab 3D Architecture

## Overview

TowerCab 3D is a React-based desktop application using Tauri 2, featuring dual 3D rendering engines (CesiumJS for globe/terrain, Babylon.js for aircraft models) and real-time VATSIM data integration.

## Data Flow

### VATSIM Aircraft Data Flow

```
VATSIM API (15s updates)
    ↓ [fetch every 3s via polling]
VatsimService.fetchVatsimData()
    ↓
vatsimStore.setVatsimData()
    ├─ pilots: Map<callsign, Pilot>
    ├─ aircraftStates: Map<callsign, AircraftState>
    └─ lastUpdate: timestamp
         ↓
useAircraftInterpolation() [60 Hz singleton]
    ├─ Reads aircraftStates every frame
    ├─ Applies physics-based interpolation
    └─ Returns: interpolatedAircraft Map
         ↓
         ├──→ CesiumViewer (60Hz rendering)
         │      ├─ useAircraftModels
         │      │    └─ Updates Cesium.Model pool positions
         │      └─ useCesiumLabels
         │           └─ Projects labels with overlap detection
         │
         └──→ useBabylonOverlay (60Hz rendering)
                ├─ Aircraft 3D models at ENU coordinates
                ├─ Shadow discs at ground level
                └─ Leader lines from cones to labels

Note: AircraftPanel uses useAircraftFiltering for 1Hz UI updates
```

### Weather Data Flow

```
Aviation Weather API (METAR)
    ↓ [fetch every 5 minutes]
WeatherService.fetchMetar(icao)
    ↓
weatherStore.setWeather()
    ├─ visibility (statute miles)
    ├─ cloudLayers: Array<{type, altitude}>
    └─ ceiling (feet AGL)
         ↓
         ├──→ useCesiumWeather
         │      └─ Applies fog density to Cesium scene
         │
         └──→ useBabylonOverlay
                ├─ Fog dome mesh at visibility boundary
                ├─ Cloud layer plane meshes
                └─ Datablock weather visibility culling
```

### Settings Persistence Flow

```
User changes setting in SettingsModal
    ↓
settingsStore.updateSetting()
    ↓ [Zustand persist middleware]
localStorage.setItem('settings-store', ...)
    ↓ [on page reload]
localStorage.getItem('settings-store')
    ↓
settingsStore (rehydrated)
    ↓
Hooks observe changes via useSettingsStore()
    ↓
Apply settings to Cesium/Babylon
```

## Camera State Flow

### Per-Viewport Camera Management

```
User Input (keyboard/mouse)
    ↓
useCameraInput(activeViewportId)
    ├─ Reads current viewport camera state
    ├─ Calculates delta based on input
    └─ Calls updateCameraState()
         ↓
viewportStore.updateCameraState(viewportId, delta)
    ↓ [per-viewport state in Map]
    ├─ Main viewport: { id: 'main', cameraState: {...} }
    ├─ Inset 1: { id: 'uuid-1', cameraState: {...} }
    └─ Inset 2: { id: 'uuid-2', cameraState: {...} }
         ↓
useCesiumCamera(viewer, viewportId)
    ├─ Reads cameraState for this viewport
    ├─ Applies heading/pitch/FOV to Cesium camera
    └─ Handles follow modes (tower/orbit)
         ↓
viewer.camera.setView()
    ↓ [sync every frame]
useBabylonCameraSync()
    ├─ Reads Cesium camera position/rotation
    ├─ Converts to ENU coordinates
    └─ Updates Babylon camera matrix

Camera State Structure:
{
  viewMode: '3d' | 'topdown',
  heading: 0-360,
  pitch: -90 to 90,
  fov: 10-120,
  positionOffset: {x, y, z},
  topdownAltitude: meters,
  followingCallsign: string | null,
  followMode: 'tower' | 'orbit',
  orbitDistance: 50-5000 meters,
  orbitHeading: 0-360,
  orbitPitch: -89 to 89,
  preFollowState: {...} | null  // Saved state before following
}
```

### Bookmark System

```
User types ".42." in CommandInput
    ↓
viewportStore.saveBookmark(airportIcao, slot=42, viewportId)
    ├─ Reads current cameraState for viewportId
    └─ Saves to: bookmarks[airportIcao][42] = cameraState
         ↓ [persisted to localStorage]

User types ".42" (no trailing dot)
    ↓
viewportStore.loadBookmark(airportIcao, slot=42, viewportId)
    ├─ Reads: bookmarks[airportIcao][42]
    └─ Applies to: viewports[viewportId].cameraState
         ↓
useCesiumCamera detects change
    ↓
Animates camera to bookmarked position
```

## Multi-Viewport Architecture

### Viewport Lifecycle

```
viewportStore
├─ viewports: Viewport[]
│   ├─ { id: 'main', isInset: false, cameraState: {...}, layout: {...} }
│   ├─ { id: 'uuid-1', isInset: true, position: {...}, size: {...}, cameraState: {...} }
│   └─ { id: 'uuid-2', isInset: true, position: {...}, size: {...}, cameraState: {...} }
├─ activeViewportId: 'main' | 'uuid-X'
└─ bookmarks: Map<airport_icao, Map<slot_number, CameraState>>

ViewportManager (renders all viewports)
├─ Main Viewport (always visible)
│   ├─ Full screen, z-index: 0
│   └─ <CesiumViewer viewportId="main" isInset={false} />
│
└─ Inset Viewports (overlay, draggable/resizable)
    ├─ Inset 1: z-index: 1001
    │   └─ <InsetCesiumViewer viewportId="uuid-1" />
    │        └─ <CesiumViewer viewportId="uuid-1" isInset={true} />
    │
    └─ Inset 2: z-index: 1002
        └─ <InsetCesiumViewer viewportId="uuid-2" />
             └─ <CesiumViewer viewportId="uuid-2" isInset={true} />

Performance Optimizations for Insets:
- MSAA: 2x (vs user setting for main)
- Shadows: Disabled
- 3D Buildings: Disabled
- Tile cache: 50 tiles (vs user setting)
- Screen space error: 16 (lower quality tiles)
```

### Viewport Activation

```
User clicks on inset viewport
    ↓
ViewportContainer onClick handler
    ↓
viewportStore.setActiveViewport(viewportId)
    ↓
activeViewportId updated
    ↓
    ├──→ useCameraInput reads activeViewportId
    │      └─ Only processes input for active viewport
    │
    ├──→ ViewportContainer applies cyan border to active
    │
    └──→ ControlsBar shows active viewport's camera state
```

## Hook Call Order (Critical!)

### CesiumViewer Component Initialization

```
CesiumViewer Component Mount
    │
    ├─ 1. useCesiumViewer(containerRef, viewportId, settings)
    │      ├─ Creates Cesium.Viewer instance
    │      ├─ Configures scene (lighting, fog, terrain)
    │      ├─ Initializes model pool (100 Cesium.Model primitives)
    │      └─ Returns: { viewer, modelPoolRefs }
    │
    ├─ 2. useTerrainQuality(viewer, terrainQuality, inMemoryTileCacheSize)
    │      ├─ Sets maximumScreenSpaceError based on quality (1-5)
    │      └─ Handles runtime quality changes with cache eviction
    │
    ├─ 3. useCesiumLighting(viewer, lightingSettings)
    │      ├─ Configures sun position and lighting
    │      ├─ Sets up shadow maps (size, distance, darkness)
    │      └─ Updates runtime when settings change
    │
    ├─ 4. useCesiumWeather(viewer, showWeatherEffects, showCesiumFog, fogDensity)
    │      ├─ Applies fog density from METAR visibility
    │      └─ Adjusts visual density scalar and screen space error
    │
    ├─ 5. useAircraftModels(viewer, modelPoolRefs, interpolatedAircraft, ...)
    │      ├─ Assigns aircraft to model pool slots
    │      ├─ Updates model positions/rotations every frame
    │      ├─ Dynamically loads aircraft-specific models
    │      └─ Applies non-uniform scaling per aircraft type
    │
    ├─ 6. useCesiumLabels(viewer, babylonOverlay, interpolatedAircraft, ...)
    │      ├─ Generates datablock text (callsign, type, alt, speed)
    │      ├─ Filters labels by distance/weather/search
    │      ├─ Calculates label positions with overlap detection
    │      └─ Coordinates with Babylon for label rendering
    │
    ├─ 7. useCesiumCamera(viewer, viewportId, interpolatedAircraft)
    │      ├─ Syncs Cesium camera with viewport camera state
    │      ├─ Implements tower-based camera positioning
    │      ├─ Handles aircraft following (tower/orbit modes)
    │      └─ Manages smooth camera transitions
    │
    └─ 8. useBabylonOverlay({ cesiumViewer: viewer, canvas })
           ├─ Creates Babylon.js scene on top of Cesium
           ├─ Syncs Babylon camera with Cesium camera (ENU transform)
           ├─ Renders 3D aircraft models, shadows, weather effects
           └─ Handles measuring tool visualizations

IMPORTANT: Babylon overlay MUST be initialized AFTER Cesium viewer
is fully set up, as it depends on viewer camera for synchronization.
```

### Hook Dependencies

```
useAircraftInterpolation (singleton, runs independently)
    └─ Provides interpolatedAircraft to:
         ├─ useAircraftModels
         ├─ useCesiumLabels
         ├─ useCesiumCamera (for follow mode)
         └─ useBabylonOverlay

useCesiumViewer
    └─ Provides viewer to:
         ├─ useTerrainQuality
         ├─ useCesiumLighting
         ├─ useCesiumWeather
         ├─ useAircraftModels (also needs modelPoolRefs)
         ├─ useCesiumLabels
         └─ useCesiumCamera

useBabylonOverlay
    ├─ Depends on: cesiumViewer (must be initialized first)
    └─ Provides babylonOverlay to:
         └─ useCesiumLabels (for label rendering and leader lines)
```

## State Management (Zustand Stores)

### Store Relationships

```
airportStore
├─ currentAirport: Airport | null
├─ towerHeight: number
└─ Used by:
     ├─ CesiumViewer (terrain offset calculation)
     ├─ useCesiumCamera (tower position)
     └─ useBabylonOverlay (root node setup)

viewportStore (PRIMARY CAMERA STORE)
├─ viewports: Viewport[]
├─ activeViewportId: string
├─ bookmarks: Map<string, Map<number, CameraState>>
└─ Used by:
     ├─ useCesiumCamera (read/write camera state)
     ├─ useCameraInput (write camera deltas)
     ├─ ViewportManager (render viewports)
     └─ ControlsBar (display camera state, bookmark buttons)

cameraStore (DEPRECATED)
├─ Only used for export/import backward compatibility
└─ DO NOT use for new features

settingsStore
├─ Cesium Ion token
├─ Terrain quality (1-5)
├─ Graphics settings (shadows, fog, MSAA, etc.)
├─ Display settings (datablock mode, label distance, etc.)
└─ Used by:
     ├─ useCesiumViewer (viewer initialization)
     ├─ useTerrainQuality (quality setting)
     ├─ useCesiumLighting (shadow settings)
     ├─ useCesiumWeather (weather effect toggles)
     └─ All components (various display settings)

vatsimStore
├─ pilots: Map<callsign, Pilot>
├─ aircraftStates: Map<callsign, AircraftState>
├─ referencePosition: {lat, lon} (for distance filtering)
└─ Used by:
     ├─ useAircraftInterpolation (read aircraftStates)
     └─ AircraftPanel (pilot information)

weatherStore
├─ visibility: number (statute miles)
├─ cloudLayers: CloudLayer[]
├─ ceiling: number | null (feet AGL)
├─ fogDensity: number (0-0.015)
└─ Used by:
     ├─ useCesiumWeather (fog effects)
     └─ useBabylonOverlay (weather visualization)

measureStore
├─ isActive: boolean
├─ measurements: Measurement[]
├─ pendingPoint: Point | null
└─ Used by:
     ├─ CesiumViewer (measuring mode handlers)
     └─ MeasuringTool (UI display)

aircraftFilterStore
├─ searchQuery: string
├─ filterAirportTraffic: boolean
└─ Used by:
     ├─ useCesiumLabels (label filtering)
     ├─ useAircraftFiltering (list filtering for UI)
     └─ AircraftPanel (filter controls)

vrStore
├─ isVRSupported: boolean
├─ isVRActive: boolean
├─ ipd: number
└─ Used by:
     ├─ VRButton (show/hide, session control)
     └─ VRScene (WebXR session management)
```

## Rendering Pipeline

### Frame Rendering Sequence (60 FPS)

```
requestAnimationFrame
    ↓
1. useAircraftInterpolation
    ├─ Reads aircraftStates from store
    ├─ Calculates interpolated positions (physics-based)
    └─ Updates interpolatedAircraft Map (mutated in place)
         ↓
2. Cesium Scene Render
    ├─ Applies camera from viewport camera state
    ├─ Renders terrain, imagery, 3D buildings
    └─ Renders aircraft models from model pool
         ↓
3. Cesium postRender Event
    ├─ useAircraftModels updates (already done in preRender)
    ├─ useBabylonOverlay.syncCamera()
    │    ├─ Reads Cesium camera matrix
    │    ├─ Converts to ENU coordinates
    │    └─ Updates Babylon camera
    │
    ├─ useBabylonOverlay.render()
    │    ├─ Renders 3D aircraft models
    │    ├─ Renders shadow discs
    │    ├─ Renders weather effects (fog dome, clouds)
    │    └─ Renders measuring tool lines
    │
    └─ performanceMonitor.endFrame()
```

### Coordinate Transform Pipeline

```
VATSIM Data (Geographic)
    lat/lon (degrees), altitude (feet MSL)
         ↓
         ├──→ Cesium Rendering Path
         │      ↓
         │   Cartesian3.fromDegrees(lon, lat, alt)
         │      ↓
         │   Cesium Cartesian3 (ECEF)
         │      ↓
         │   Model/Camera positioning in Cesium
         │
         └──→ Babylon Rendering Path
                ↓
             transformPositionToENU(lon, lat, alt, enuTransform)
                ↓
             ENU Coordinates {x: east, y: up, z: north}
                ↓
             mesh.position.set(enu.x, enu.y, enu.z)

See: docs/coordinate-systems.md for detailed explanation
```

## Component Hierarchy

```
App.tsx (root)
├─ TopBar
│   ├─ AirportSelector (modal)
│   ├─ Zulu time display
│   └─ Connection status
│
├─ ViewportManager
│   ├─ Main CesiumViewer (always visible, full screen)
│   │   ├─ Cesium container
│   │   └─ Babylon canvas overlay
│   │
│   └─ Inset viewports (array, draggable/resizable)
│        └─ InsetCesiumViewer (delayed initialization)
│             └─ CesiumViewer (isInset=true)
│
├─ ControlsBar (bottom HUD)
│   ├─ Camera controls (heading/pitch indicators)
│   ├─ FOV slider
│   ├─ View mode toggle (3D/TopDown)
│   ├─ Follow status display
│   └─ Bookmark buttons (.00-.99)
│
├─ AircraftPanel (right sidebar, collapsible)
│   ├─ Filter controls (search, airport traffic, distance)
│   └─ Aircraft list (sorted by distance)
│        └─ AircraftCard (click to follow, show route)
│
├─ GlobalSearchPanel (Ctrl+K, modal)
│   ├─ Search all VATSIM aircraft
│   └─ Teleport to aircraft or coordinates
│
├─ CommandInput (bottom, terminal-style)
│   ├─ Bookmark save/load (.XX syntax)
│   └─ Command history
│
├─ SettingsModal
│   ├─ Cesium Ion token
│   ├─ Graphics settings (shadows, fog, MSAA, etc.)
│   ├─ Display settings (datablock mode, label distance)
│   └─ Memory settings (tile cache sizes)
│
├─ MeasuringTool (overlay when active)
│   └─ Distance measurements on terrain
│
└─ VRScene (only when VR active)
    ├─ Babylon WebXR session
    └─ Stereo Cesium background planes (left/right eye)
```

## Performance Optimizations

### Memory Management

```
Aircraft Model Pool (100 pre-loaded models)
    ├─ Avoids per-aircraft Model.fromGltfAsync() calls
    ├─ Dynamic model swapping when aircraft type changes
    └─ Cleanup: Hides unused pool slots, resets URL tracking

Tile Caching Strategy
    ├─ In-memory: 50-500 tiles (user configurable)
    ├─ Service Worker: 0.1-10 GB disk cache
    └─ Terrain quality changes: Evict cache before loading new tiles

Viewport Optimizations for Insets
    ├─ Lower MSAA (2x vs user setting)
    ├─ Shadows disabled
    ├─ 3D Buildings disabled
    ├─ Smaller tile cache (50 tiles)
    └─ Higher screen space error (16 vs user setting)

Distance-Based Filtering
    ├─ VATSIM store filters pilots by distance from reference position
    ├─ Labels filtered by labelVisibilityDistance setting
    └─ Weather visibility culling hides labels beyond METAR visibility
```

### Update Frequencies

```
VATSIM API: 15s actual updates, 3s poll interval
Weather API: 5 minute refresh interval
Aircraft Interpolation: 60 Hz (every frame)
Aircraft Models: 60 Hz position updates
Aircraft Labels: 60 Hz projection updates
AircraftPanel List: 1 Hz refresh tick (UI only)
Memory Diagnostics: 5 second interval
```

## Error Handling

### Graceful Degradation

```
Cesium Ion Token Missing
    └─ Shows error in TopBar, viewer still functions with default imagery

VATSIM API Failure
    ├─ Retries on next poll interval (3s)
    └─ Shows connection status in TopBar

Weather API Failure
    ├─ Retries on next refresh (5 min)
    └─ Continues with last known weather data

Model Loading Failure
    ├─ Logs error to console
    ├─ Resets pool slot URL to default (b738.glb)
    └─ Retries on next aircraft type change

Terrain Sampling Failure
    ├─ Falls back to geoidOffset = 0
    └─ Aircraft positioning slightly off (~30m) but functional
```

## File Organization

```
src/renderer/
├─ components/
│   ├─ CesiumViewer/
│   │   └─ CesiumViewer.tsx (659 LOC, orchestrates hooks)
│   ├─ UI/ (TopBar, ControlsBar, panels, modals)
│   └─ Viewport/ (ViewportManager, ViewportContainer, InsetCesiumViewer)
│
├─ hooks/
│   ├─ Core Cesium hooks (useCesiumViewer, useTerrainQuality, etc.)
│   ├─ Aircraft hooks (useAircraftInterpolation, useAircraftModels, etc.)
│   ├─ Camera hooks (useCesiumCamera, useCameraInput, etc.)
│   └─ Babylon hooks (useBabylonOverlay, useBabylonCameraSync, etc.)
│
├─ stores/
│   ├─ airportStore.ts
│   ├─ viewportStore.ts (PRIMARY CAMERA STORE)
│   ├─ settingsStore.ts
│   ├─ vatsimStore.ts
│   ├─ weatherStore.ts
│   ├─ measureStore.ts
│   ├─ aircraftFilterStore.ts
│   ├─ vrStore.ts
│   └─ cameraStore.ts (DEPRECATED)
│
├─ services/
│   ├─ VatsimService.ts (API client)
│   ├─ WeatherService.ts (METAR parsing)
│   └─ AircraftModelService.ts (model metadata)
│
├─ utils/
│   ├─ enuTransforms.ts (coordinate conversions)
│   ├─ interpolation.ts (physics-based aircraft movement)
│   ├─ towerHeight.ts (tower position calculation)
│   └─ performanceMonitor.ts (FPS tracking)
│
├─ types/
│   ├─ camera.ts (ViewMode, FollowMode, CameraState, etc.)
│   ├─ viewport.ts (Viewport, ViewportLayout, etc.)
│   ├─ vatsim.ts (Pilot, AircraftState, InterpolatedAircraftState)
│   ├─ weather.ts (CloudLayer, FlightCategory, etc.)
│   └─ settings.ts (grouped settings interfaces)
│
├─ constants/
│   ├─ rendering.ts (model pool, shadows, colors)
│   ├─ camera.ts (FOV/pitch limits, speeds)
│   └─ api.ts (endpoints, poll intervals)
│
└─ docs/
    ├─ coordinate-systems.md (this helped you!)
    └─ architecture.md (you are here)
```

## Further Reading

- [Coordinate Systems](./coordinate-systems.md) - Geographic, Cartesian3, ENU conversions
- [CLAUDE.md](../../CLAUDE.md) - Development guide for LLM agents
- [Cesium Documentation](https://cesium.com/docs/)
- [Babylon.js Documentation](https://doc.babylonjs.com/)
- [VATSIM Data API](https://data.vatsim.net/)
