# TowerCab 3D Architecture

## Overview

TowerCab 3D is a React-based desktop application using Tauri 2, featuring dual 3D rendering engines (CesiumJS for globe/terrain/aircraft, Babylon.js for screen-space labels and weather effects) and real-time VATSIM data integration.

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
                ├─ Datablock labels in screen space
                ├─ Leader lines from aircraft to labels
                └─ Weather effects (fog dome, cloud layers)

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
           ├─ Renders datablock labels, leader lines, weather effects
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

fsltlConversionStore
├─ conversionProgress: ConversionProgress
├─ selectedAirlines: Set<string>
├─ selectedAircraftTypes: Set<string>
└─ Used by:
     ├─ FSLTLConversionPanel (conversion UI)
     └─ AircraftModelService (model loading)

updateStore
├─ updateAvailable: boolean
├─ downloadProgress: number
├─ updateInfo: UpdateInfo | null
└─ Used by:
     ├─ UpdateNotification (update banner)
     └─ Settings Help tab (manual update check)

uiFeedbackStore
├─ toasts: Toast[]
├─ notifications: Notification[]
└─ Used by:
     ├─ ToastContainer (toast display)
     └─ Various components (show feedback)

vrStore
├─ isVRSupported: boolean
├─ isVRActive: boolean
├─ ipd: number
└─ Used by:
     ├─ VRButton (show/hide, session control)
     └─ VRScene (WebXR session management)

replayStore
├─ snapshots: VatsimSnapshot[] (circular buffer, 15s intervals)
├─ playbackMode: 'live' | 'replay' | 'imported'
├─ currentIndex, segmentProgress, isPlaying, playbackSpeed
└─ Used by:
     ├─ useAircraftDataSource (provides unified data for live/replay)
     ├─ useReplayPlayback (playback engine)
     ├─ ControlsBar (replay controls UI)
     └─ vatsimStore (adds snapshots on VATSIM updates)

datablockPositionStore
├─ globalPosition: number (1-9 numpad-style, default 9 = top-right)
├─ perAircraftPositions: Map<callsign, number>
├─ autoRearrange: boolean
└─ Used by:
     ├─ useBabylonLabels (datablock positioning)
     ├─ useCesiumLabels (label positioning)
     └─ CommandInput (numpad position commands)

runwayStore
├─ runways: Runway[]
├─ currentAirport: string | null
└─ Used by:
     ├─ useAircraftFiltering (flight phase detection, runway association)
     └─ AircraftPanel (smart sort, runway badges)
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
    │    ├─ Renders datablock labels in screen space
    │    ├─ Renders leader lines from aircraft to labels
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
         │   Aircraft model/Camera positioning in Cesium
         │
         └──→ Babylon Screen Space Path
                ↓
             viewer.scene.cartesianToCanvasCoordinates()
                ↓
             Screen Coordinates {x, y}
                ↓
             Label/leader line positioning in screen space

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
├─ ControlsBar (bottom HUD, ~530 LOC)
│   ├─ Mode toggle (Main Controls / Replay Controls)
│   ├─ Main Controls Mode
│   │   ├─ Camera info (HDG/PIT/FOV or ALT)
│   │   ├─ View mode toggle (3D/TopDown)
│   │   ├─ Follow status display
│   │   ├─ Set/Reset default buttons
│   │   └─ Add inset viewport button
│   ├─ Replay Controls Mode (imported from ReplayControls.tsx)
│   │   ├─ Playback controls (play/pause/step)
│   │   ├─ Timeline scrubber
│   │   └─ Speed selector
│   ├─ Settings button (opens SettingsModal)
│   ├─ Measure button
│   └─ VR button (when available)
│
├─ SettingsModal (tabbed modal container)
│   ├─ SettingsGeneralTab
│   │   ├─ Cesium Ion token
│   │   ├─ Theme, FOV, camera/mouse speed
│   │   └─ Import/Export settings
│   ├─ SettingsDisplayTab
│   │   ├─ Label visibility distance
│   │   ├─ Datablock display mode
│   │   ├─ Aircraft panel toggles
│   │   └─ Orientation emulation settings
│   ├─ SettingsGraphicsTab (container, delegates to specialized components)
│   │   ├─ TerrainSettings (terrain quality, 3D buildings)
│   │   ├─ LightingSettings (time of day mode)
│   │   ├─ WeatherSettings (fog, clouds, precipitation)
│   │   └─ AdvancedGraphicsSettings (MSAA, shadows, ambient occlusion)
│   ├─ SettingsPerformanceTab
│   │   ├─ Tile cache sizes
│   │   ├─ Aircraft data radius
│   │   └─ Replay buffer settings
│   └─ SettingsHelpTab
│       └─ Keyboard shortcuts reference
│
├─ ContributeDialog (tower position contribution prompt)
│   └─ GitHub integration for sharing custom positions
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
├─ MeasuringTool (overlay when active)
│   └─ Distance measurements on terrain
│
└─ VRScene (only when VR active)
    ├─ Babylon WebXR session
    └─ Stereo Cesium background planes (left/right eye)
```

## UI Component Decomposition

### ControlsBar Refactoring

ControlsBar was refactored from a monolithic 2,308-line component into a modular system (~530 LOC orchestrator):

```
ControlsBar.tsx (530 LOC - main orchestrator)
    ├─ Imports specialized components based on mode
    ├─ Mode toggle state management
    └─ Delegates rendering to:
         ├─ ReplayControls.tsx (208 LOC)
         │    ├─ Playback controls (play/pause/step)
         │    ├─ Timeline scrubber with time display
         │    └─ Speed selector and LIVE button
         │
         ├─ SettingsModal.tsx (89 LOC - tab container)
         │    ├─ Modal wrapper with tab navigation
         │    └─ Renders active tab component
         │
         ├─ SettingsGeneralTab.tsx (203 LOC)
         │    ├─ Cesium Ion token input
         │    ├─ Theme, camera, mouse settings
         │    └─ Import/Export functionality
         │
         ├─ SettingsDisplayTab.tsx (209 LOC)
         │    ├─ Label visibility controls
         │    ├─ Datablock display options
         │    ├─ Aircraft panel toggles
         │    └─ Orientation emulation settings
         │
         ├─ SettingsGraphicsTab.tsx (18 LOC - container)
         │    └─ Composes specialized graphics components:
         │         ├─ TerrainSettings.tsx (44 LOC)
         │         ├─ LightingSettings.tsx (52 LOC)
         │         ├─ WeatherSettings.tsx (213 LOC)
         │         └─ AdvancedGraphicsSettings.tsx (412 LOC)
         │
         ├─ SettingsPerformanceTab.tsx (180 LOC)
         │    ├─ Tile cache configuration
         │    ├─ Data radius settings
         │    └─ Replay buffer management
         │
         ├─ SettingsHelpTab.tsx (130 LOC)
         │    └─ Keyboard shortcuts reference table
         │
         └─ ContributeDialog.tsx (73 LOC)
              └─ GitHub contribution prompt for tower positions
```

**Utilities Created:**
- `utils/formatting.ts` (42 LOC): Shared time/angle formatting functions (`formatTime`, `formatAngle`)

**Key Changes:**
- FOV slider removed from controls bar (users use mouse wheel)
- Heading display no longer shows degree symbol (aviation convention)
- Settings organized into logical tabs matching user mental models

**Benefits:**
- 77% reduction in main file size (2,308 → 530 LOC)
- Settings grouped by category for better UX
- Easier to locate and modify specific settings
- Reduced cognitive load for developers and AI agents
- Reusable formatting utilities

## Babylon.js Hook Decomposition

### Orchestrator Pattern

useBabylonOverlay was refactored from a monolithic 889-line hook into a thin orchestrator (265 LOC) that composes specialized hooks:

```
useBabylonOverlay (Orchestrator - 265 LOC)
    ├─ 1. useBabylonScene({ canvas })
    │      ├─ Creates Babylon.Engine with transparent background
    │      ├─ Creates Babylon.Scene with MSAA 4x anti-aliasing
    │      ├─ Creates FreeCamera (synchronized with Cesium)
    │      ├─ Creates GUI AdvancedDynamicTexture for 2D overlays
    │      ├─ Adds hemispheric and directional lighting
    │      └─ Handles canvas resizing and resource disposal
    │
    ├─ 2. useBabylonWeather({ scene })
    │      ├─ Creates fog dome mesh (hemisphere, BACKSIDE rendering)
    │      ├─ Creates cloud layer mesh pool (4 planes, 50km diameter)
    │      ├─ Updates fog scale/opacity based on METAR visibility
    │      ├─ Updates cloud positions based on METAR ceiling data
    │      └─ Provides isVisibleByWeather() for label culling
    │
    ├─ 3. useBabylonLabels({ guiTexture })
    │      ├─ Creates aircraft datablock labels (Rectangle + TextBlock)
    │      ├─ Creates leader lines (Line connecting label to aircraft)
    │      ├─ Updates label colors and followed aircraft highlighting
    │      ├─ Positions labels with screen-space coordinates
    │      ├─ Calculates leader line endpoints (ray-rectangle intersection)
    │      └─ Disposes labels when aircraft disappear
    │
    ├─ 4. useBabylonRootNode({ scene, cesiumViewer })
    │      ├─ Creates root TransformNode at ENU origin (tower location)
    │      ├─ Setups ENU transformation matrices (enuToFixed, fixedToEnu)
    │      ├─ Samples Cesium terrain for geoid offset calculation
    │      ├─ Provides getters for matrices and terrain offset
    │      └─ Disposes root node on unmount or airport change
    │
    └─ 5. useBabylonCameraSync({ cesiumViewer, camera, fogDome })
           ├─ Reads Cesium camera position/rotation/FOV
           ├─ Converts ECEF → ENU using fixedToEnu matrix
           ├─ Extracts Euler angles from direction/up vectors
           ├─ Updates Babylon camera position/rotation/FOV
           ├─ Positions fog dome at camera location
           └─ Handles both 3D perspective and top-down modes
```

### Hook Call Order (Critical!)

```typescript
// Correct order - each hook depends on previous ones
const { engine, scene, camera, guiTexture, sceneReady } = useBabylonScene({ canvas })
const { fogDome, isVisibleByWeather } = useBabylonWeather({ scene })
const { updateLabel, updateLabelPosition, removeLabel } = useBabylonLabels({ guiTexture })
const { setupRootNode } = useBabylonRootNode({ scene, cesiumViewer })
const { syncCamera } = useBabylonCameraSync({ cesiumViewer, camera, fogDome })

// WRONG - camera sync before scene initialization
const { syncCamera } = useBabylonCameraSync({ cesiumViewer, camera, fogDome })  // ❌ camera is null!
const { camera } = useBabylonScene({ canvas })
```

### Benefits of Decomposition

**For LLM Agents:**
- 70% reduction in file size (889 → 265 LOC for orchestrator)
- Clear hook boundaries with single responsibilities
- Easier to locate specific functionality (search for "fog" → useBabylonWeather)
- Better code search results (specialized files vs monolith)

**For Developers:**
- Modular architecture (test hooks independently)
- Reusable hooks (use useBabylonScene alone for non-overlay cases)
- Clear separation of concerns (scene vs weather vs labels)
- Easier to add features (modify one hook, not monolith)
- Simpler debugging (smaller scope per hook)

**Memory Management:**
Each hook manages its own resource disposal:
- useBabylonScene → engine, scene, camera, GUI
- useBabylonWeather → fog dome, cloud meshes
- useBabylonLabels → labels, leader lines
- useBabylonRootNode → root transform node
- useBabylonCameraSync → no resources (stateless calculations)

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
│   ├─ UI/
│   │   ├─ ControlsBar.tsx (530 LOC, main controls orchestrator)
│   │   ├─ ReplayControls.tsx (208 LOC, replay UI mode)
│   │   ├─ SettingsModal.tsx (89 LOC, tabbed modal container)
│   │   ├─ SettingsGeneralTab.tsx (203 LOC)
│   │   ├─ SettingsDisplayTab.tsx (209 LOC)
│   │   ├─ SettingsGraphicsTab.tsx (18 LOC, delegates to settings/ components)
│   │   ├─ SettingsPerformanceTab.tsx (180 LOC)
│   │   ├─ SettingsHelpTab.tsx (130 LOC)
│   │   ├─ ContributeDialog.tsx (73 LOC)
│   │   ├─ settings/
│   │   │   ├─ TerrainSettings.tsx (44 LOC)
│   │   │   ├─ LightingSettings.tsx (52 LOC)
│   │   │   ├─ WeatherSettings.tsx (213 LOC)
│   │   │   └─ AdvancedGraphicsSettings.tsx (412 LOC)
│   │   └─ ... (other UI components)
│   └─ Viewport/ (ViewportManager, ViewportContainer, InsetCesiumViewer)
│
├─ hooks/
│   ├─ Core Cesium hooks (useCesiumViewer, useTerrainQuality, etc.)
│   ├─ Aircraft hooks (useAircraftInterpolation, useAircraftModels, etc.)
│   ├─ Camera hooks (useCesiumCamera, useCameraInput, etc.)
│   └─ Babylon hooks (useBabylonOverlay, useBabylonCameraSync, etc.)
│
├─ stores/
│   ├─ aircraftFilterStore.ts
│   ├─ airportStore.ts
│   ├─ cameraStore.ts (DEPRECATED)
│   ├─ datablockPositionStore.ts
│   ├─ fsltlConversionStore.ts
│   ├─ measureStore.ts
│   ├─ replayStore.ts
│   ├─ runwayStore.ts
│   ├─ settingsStore.ts
│   ├─ uiFeedbackStore.ts
│   ├─ updateStore.ts
│   ├─ vatsimStore.ts
│   ├─ viewportStore.ts (PRIMARY CAMERA STORE)
│   ├─ vrStore.ts
│   └─ weatherStore.ts
│
├─ services/
│   ├─ VatsimService.ts (API client)
│   ├─ WeatherService.ts (METAR parsing)
│   └─ AircraftModelService.ts (model metadata)
│
├─ utils/
│   ├─ enuTransforms.ts (coordinate conversions)
│   ├─ formatting.ts (time/angle formatting utilities)
│   ├─ interpolation.ts (physics-based aircraft movement)
│   ├─ towerHeight.ts (tower position calculation)
│   └─ performanceMonitor.ts (FPS tracking)
│
├─ types/
│   ├─ airport.ts (Airport data structures, tower height)
│   ├─ babylon.ts (labels, weather meshes, scene options, hook return types, ENU transforms)
│   ├─ camera.ts (ViewMode, FollowMode, CameraState, etc.)
│   ├─ fsltl.ts (FSLTL conversion types, airline mapping)
│   ├─ mod.ts (modding system types, manifest formats)
│   ├─ replay.ts (replay snapshots, playback state)
│   ├─ settings.ts (grouped settings interfaces)
│   ├─ vatsim.ts (Pilot, AircraftState, InterpolatedAircraftState)
│   ├─ viewport.ts (Viewport, ViewportLayout, etc.)
│   └─ weather.ts (CloudLayer, FlightCategory, precipitation, etc.)
│
├─ constants/
│   ├─ api.ts (endpoints, poll intervals)
│   ├─ babylon.ts (scene/camera settings, visibility thresholds, lighting)
│   ├─ camera.ts (FOV/pitch limits, speeds)
│   ├─ precipitation.ts (rain/snow particles, wind effects)
│   ├─ rendering.ts (model pool, shadows, colors)
│   ├─ replay.ts (buffer size, snapshot interval)
│   └─ weather.ts (cloud/fog params, layer geometry, animation)
│
└─ docs/
    ├─ coordinate-systems.md (detailed coordinate system documentation)
    └─ architecture.md (you are here)
```

## Further Reading

- [Coordinate Systems](./coordinate-systems.md) - Geographic, Cartesian3, ENU conversions
- [CLAUDE.md](../../CLAUDE.md) - Development guide for LLM agents
- [Cesium Documentation](https://cesium.com/docs/)
- [Babylon.js Documentation](https://doc.babylonjs.com/)
- [VATSIM Data API](https://data.vatsim.net/)
