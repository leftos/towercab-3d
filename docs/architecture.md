# TowerCab 3D Architecture

## Overview

TowerCab 3D is a React-based desktop application using Tauri 2, featuring dual 3D rendering engines (CesiumJS for globe/terrain/aircraft, Babylon.js for screen-space labels and weather effects) and real-time VATSIM data integration.

**Remote Browser Access:** The Tauri app runs an HTTP server (Rust axum, port 8765) serving the React app to browsers on the local network (other addresses only when `server.allowNonLocalClients` is on). Remote mode enables iPad/tablet access with touch controls while sharing global settings (minus host-only secrets) and mods from the host PC; see `remote-access-architecture.md`.

## Data Flow

### Remote Mode Architecture

```
Desktop App (Tauri + React)
├─ Rust Backend (src-tauri/src/)
│   ├─ main.rs - App initialization, Tauri commands
│   └─ server.rs - axum HTTP server (port 8765)
│        ├─ Static file serving (/assets/, /index.html)
│        ├─ Mods API (/api/mods/*)
│        │    ├─ GET /api/mods/discover - List mod folders (relative path + id)
│        │    ├─ GET /api/mods/aircraft - List aircraft mods
│        │    ├─ GET /api/mods/towers - List tower mods
│        │    └─ GET /api/mods/file/* - Serve mod files
│        ├─ Settings API (/api/global-settings)
│        │    ├─ GET /api/global-settings - Get global settings (remote view, no host-only secrets)
│        │    └─ POST /api/global-settings - Update global settings (host-owned fields kept)
│        └─ Tower Positions API (/api/tower-positions/*)
│             └─ GET /api/tower-positions/{icao} - Get tower position
│
└─ React Frontend (src/renderer/)
    ├─ Desktop Mode (isTauri() = true)
    │   ├─ Direct Tauri command invocations
    │   ├─ File system access via Tauri
    │   └─ Local settings in localStorage
    │
    └─ Remote Mode (isRemoteMode() = true)
        ├─ HTTP API calls to host PC
        ├─ Touch controls (useTouchInput.ts)
        │    ├─ Single-finger drag: rotate camera
        │    ├─ Two-finger pinch: zoom
        │    ├─ Two-finger rotate: heading
        │    └─ Virtual joystick: WASD movement
        ├─ DeviceOptimizationPrompt (suggest optimized settings)
        └─ RemoteIndicator (show connection status)

Detection: remoteMode.ts
├─ isRemoteMode(): !('__TAURI__' in window)
├─ getApiBaseUrl(): window.location.origin in remote mode
└─ getHostname(): window.location.hostname in remote mode
```

### Aircraft Data Flow (VATSIM & RealTraffic)

```
Data Source (VATSIM: 15s updates | RealTraffic: ~2-3s updates)
    ↓ [VATSIM: fetch every 1s | RealTraffic: WebSocket push]
VatsimService.fetchVatsimData() OR RealTrafficService
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

**Local Settings (graphics, UI preferences - per browser/device):**
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

**Global Settings (cesiumIonToken, FSLTL paths, bookmarks - shared across devices):**
```
Tauri Mode (Desktop):
  User changes Cesium token → globalSettingsStore.updateCesiumIonToken()
      ↓
  Tauri command: save_global_settings()
      ↓
  File write: global-settings.json (app data dir)
      ↓ [on next app start or remote client connect]
  File read: load_global_settings()
      ↓
  globalSettingsStore initialized

Remote Mode (Browser):
  User changes Cesium token → globalSettingsStore.updateCesiumIonToken()
      ↓
  HTTP POST: /api/global-settings
      ↓
  Host PC Tauri backend merges it (host-owned fields kept) into global-settings.json
      ↓ [HTTP response]
  Browser globalSettingsStore updates
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
    └─ Calls globalSettingsStore.saveViewportBookmark()
         ↓ [Tauri mode]
         Tauri command saves to global-settings.json
         ↓ [Remote mode]
         HTTP PUT /api/settings/viewport-bookmarks
         ↓
         Bookmarks shared across all devices

User types ".42" (no trailing dot)
    ↓
viewportStore.loadBookmark(airportIcao, slot=42, viewportId)
    ├─ Reads from globalSettingsStore.viewportSettings.bookmarks
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
    ├─ 3. useSunElevation(viewer) (sun from Cesium's clock, geodetic up), then useCesiumLighting(viewer, lightingSettings)
    │      ├─ Sun elevation is computed first and passed in as lightingSettings.sunElevationDeg (null until known)
    │      ├─ Configures sun position and lighting
    │      ├─ Sets up shadow maps (size, distance, darkness)
    │      ├─ Sun shadows are off while sunElevationDeg is below the horizon (null keeps them on)
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

18 Zustand stores manage application state.

### Store Relationships

```
globalSettingsStore (shared across devices)
├─ cesiumIonToken: string
├─ msfsModels: { communityPath, enableFsltl, enableAig, priority, textureScale, cacheDirectory, cacheLimitMB }
├─ airports: { defaultIcao, recentAirports }
├─ viewportSettings: { bookmarks, datablockPositions, viewportLayouts }
├─ Persisted in: Tauri file system (global-settings.json)
├─ Synced via: HTTP API in remote mode
└─ Used by:
     ├─ CesiumViewer (Ion token)
     ├─ viewportStore (bookmarks, viewport layouts)
     ├─ datablockPositionStore (datablock positions)
     ├─ MSFSModelConversionService (MSFS paths, cache settings)
     └─ ModelMatchingPanel (model settings UI)

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
├─ Bookmarks now in globalSettingsStore (shared across devices)
├─ Viewport layouts now in globalSettingsStore (shared across devices)
└─ Used by:
     ├─ useCesiumCamera (read/write camera state)
     ├─ useCameraInput (write camera deltas, touch controls in remote mode)
     ├─ ViewportManager (render viewports)
     └─ ControlsBar (display camera state, bookmark buttons)

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
├─ dataSource: 'vatsim' | 'realtraffic'
└─ Used by:
     ├─ useAircraftInterpolation (read aircraftStates)
     ├─ AircraftPanel (pilot information, data source indicators)
     └─ RealTrafficService (populate aircraftStates)

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

indexingStore
├─ fsltlProgress: number (0-100)
├─ aigProgress: number (0-100)
├─ status: string
└─ Used by:
     └─ InitializationOverlay (show MSFS indexing progress)

realTrafficStore
├─ isConnected: boolean
├─ connectionError: string | null
├─ lastUpdate: timestamp
└─ Used by:
     ├─ RealTrafficService (connection management)
     └─ ControlsBar (connection status)

vnasStore
├─ sessionState: 'disconnected' | 'connecting' | 'connected' | 'waiting'
├─ sessionId: string | null
├─ lastUpdate: timestamp
└─ Used by:
     ├─ VnasService (session management)
     └─ TopBar (connection status)

aircraftTimelineStore
├─ isOpen: boolean
├─ selectedCallsign: string | null
├─ snapshots: AircraftSnapshot[]
└─ Used by:
     └─ AircraftTimelineModal (debug visualization)

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
├─ Per-aircraft positions now in globalSettingsStore (shared across devices)
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

### Environment-Map Lighting

Cesium lights OSM buildings and aircraft models from a dynamic environment map whose ground hemisphere defaults to an olive. TowerCab 3D passes a neutral grey instead, as `environmentMapOptions` at creation (setting `groundColor` afterwards does not rebuild a computed map). The colour is `ENVIRONMENT_MAP_GROUND_COLOR` in `constants/lighting.ts`, wrapped by `neutralEnvironmentMapOptions()` in `utils/environmentMap.ts`. Creation sites: `createOsmBuildingsAsync` in `CesiumViewer.tsx`, `Model.fromGltfAsync` in `useCesiumViewer.ts` and `useAircraftModels.ts`, and `ModelPreviewModal.tsx`. A new tileset or model creation site must pass the same options.

### OSM Buildings Facades

To change how a building is typed, read `utils/buildingStyle.ts` (`classify`, `storeysAndWall`, the shape rules), `utils/buildingTags.ts`, `utils/buildingBaseLookup.ts` (`getTileFeatureStats`, the drain), `utils/buildingFaces.ts` (the face table), the tileset and airport effects in `CesiumViewer.tsx`, `services/AerodromeService.ts`, and the tests `utils/buildingStyle.test.ts`, `utils/buildingBaseLookup.test.ts` and `utils/buildingFaces.test.ts`; for how windows are fitted to a wall, `utils/facadeFit.ts` and `utils/facadeShader.ts`.

With `show3DBuildings` on, the buildings effect in `CesiumViewer.tsx` creates the OSM Buildings tileset (`createOsmBuildingsAsync`) and sets both `tileset.customShader = createFacadeShader()` and the building style through `applyBuildingStyle(tileset)`. No separate setting; the facades ride `show3DBuildings`. OSM `building:colour` tints (Cesium's default `cesium#color` style) no longer show.

`utils/buildingStyle.ts` builds a `Cesium3DTileStyle` whose colour (a `StyleExpression` subclass reading each tag once per feature) packs the building's facade class (from `building`, `amenity`, `aeroway` and `parking` tags; red holds the class alone), storeys and a wall-height bucket into the RGB channels, each 228-255 with alpha 1 (near white, so no feature turns translucent). Styled content with no feature evaluates to white. `utils/facadeShader.ts` reads the colour back in the custom shader through `selectedFeatureIdStage()` and decodes it. `applyBuildingStyle` sets the tileset's colour blend to MIX at amount 0, so the packed colour itself is not multiplied into the lit result. The class picks the facade grammar and a wall palette; the hash (`featureHash`, a fraction of the building's latitude and longitude) is not packed but read from the tile's lookup texture (below) and picks one of four palette entries, so neighbours differ. A tile with no lookup yet draws its buildings in colour variant 0.

Outline fallback: when a feature's own tags classify as GENERIC and its unprefixed `type` is `building` (a part of a multipolygon building relation), `classifyFeature` takes the class from the bundled outline table `data/buildingOutlines.json`, keyed by the feature's `elementId`; a way never reaches the table, since ways share the relation number space.

Shape fallback: a building whose own tags and outline-table lookup both leave GENERIC, and whose point (`cesium#latitude`/`cesium#longitude`) lies inside the selected airport's aerodrome boundary (`AerodromeService.contains`), is typed by footprint shape from its tile's stats (`getTileFeatureStats`). The hangar rule runs first: area at least `SHAPE_HANGAR_MIN_AREA_M2` (1,500 m²), `cesium#estimatedHeight` at most 20 m, and storeys of 2 or fewer or untagged (a negative storey count counts as 0) gives HANGAR. Then area at least 1,000 m² with 4-8 storeys gives GARAGE, the storeys being tagged levels less `min_level`, or (tagged height less tagged `min_height`) / 3 m. The thresholds are the `SHAPE_*` constants in `buildingStyle.ts`. The class order is therefore own tags, outline table, shape, GENERIC.

A shape-typed hangar or garage is a guess: a fire station inside the fence gets hangar walls (Oakland Fire Station No. 22, KSFO's United Cargo shed). Headless, KSFO had 9 and KOAK 10 buildings typed HANGAR and none GARAGE, nearly all untagged buildings of 1,500 m² or more at the 3 m default height.

The area test is set by `setShapeFallbackArea(contains | null)` in `buildingStyle.ts`, which the airport effect in `CesiumViewer.tsx` calls from the selected airport (only the main viewer clears it). An airport change and the boundaries finishing loading restyle the whole tileset (`makeStyleDirty`). A building draws generic until its tile's stats exist; `attachBuildingLookup`'s drain then restyles each tile a pass built, through the private `content.applyStyle(tileset.style)` (guarded, one console error per failing tile), while the fallback is on. `attachBuildingLookup` takes a required `restyleWhen` predicate for this (`isShapeFallbackOn`). `tagValueNumber` and `isBuildingPart` live in the leaf module `utils/buildingTags.ts`, so `buildingBaseLookup.ts` does not import `buildingStyle.ts`.

`services/AerodromeService.ts` loads the bundled aerodrome boundaries once (the Tauri resource `resources/aerodromes.json.gz`, or `/api/aerodromes` in a remote browser; a failed load rethrows and the next call retries) and answers `contains(icao, lon, lat)`: inside when the point lies in some polygon's outer ring and in none of that polygon's holes (each hole belongs to its own outer ring, so an island inside another polygon's hole counts as inside).

A feature is a building part when it carries its own `part#elementId` (`isBuildingPart`); a part reads only its own `part#` tags for levels and height, never its parent building's. Height: a tagged `height` (the `part#` forms for a building part) less `min_height` and less a tagged roof; else, for a non-part, `cesium#estimatedHeight` less `min_height`. A building part with no tagged `part#height` has an unknown height (code 0) and uses the grammar's default storey. Tag numbers accept only a whole or decimal number with an optional `m` (one decimal comma allowed); `4;5` and `30 ft` count as absent. A tagged `roof:height` that is negative or at or above the total is ignored, and one leaving less than one 3 m storey is capped. Storeys are `building:levels` less `building:min_level`; the wall height packs in 2 m buckets, saturating at 54 m.

Classes: terminals (`building=terminal`/`transportation`/`train_station`, `aeroway=terminal`) and offices (office, commercial, retail, hotel, hospital, clinic, public, civic, government, school, college, university, mixed_use) get continuous window bands; houses (house, residential, detached, semidetached_house, terrace, apartments, bungalow, dormitory, cabin) small punched windows; parking garages (`building=parking`, `amenity=parking`, `parking=multi-storey`) open slab bands with no lit windows; hangars (hangar, industrial, warehouse, manufacture, factory, `aeroway=hangar`) door panels and ribbed cladding with no windows, their panel seams and ribs box-filtered over the pixel footprint; domestic garages (`building=garage`/`garages`/`carport`) a plain wall; everything else the generic window grid. When tags name two classes, the earlier rule in `CLASS_RULES` wins. Live shader uniforms are `u_fade`, `u_fadeStart`, `u_fadeEnd` and `u_glassMean`. Grid, fade and lit-share constants are `FACADE_*` in `constants/rendering.ts`; ground-hemisphere lighting is `utils/environmentMap.ts` with `constants/lighting.ts` (see above). Tests: `utils/buildingStyle.test.ts`, `utils/buildingTags.test.ts`, `utils/facadeShader.test.ts`, `utils/buildingBaseLookup.test.ts`, `utils/environmentMap.test.ts`. Design and options: `docs/plans/osm-buildings.md`; regression captures: `docs/plans/canvases/osm-facades/`.

Floor lines start at each building's own ground. The ion tiles carry no base height, and a tile's model origin can sit on the ellipsoid tens of kilometres away, so `utils/buildingBaseLookup.ts` measures it: when a tile loads (`attachBuildingLookup`, called beside `applyBuildingStyle`), it reads the tile's vertex and index buffers back once (WebGL2 only; a primitive's vertex count is the largest of its position and feature-id `count`s and its largest index plus one, since a Draco-decoded attribute keeps its glTF accessor's shorter `count`, and a primitive whose attribute would run past its buffer is skipped as unreadable), takes each feature's lowest vertex along local up, and builds a per-tile two-row float lookup texture keyed by feature id (`LOOKUP_ROW_GROUND`, `LOOKUP_ROW_TOP`; the shader reads a row through `glslBuildingLookupRead(id, row)`). Row 0 holds the lowest vertex in model coordinates and the metres from the building's ground to it (a raised part's `min_height`). Row 1 holds the metres from the ground to the wall top (the eave: the lowest vertex of the feature's roof faces, those within cosine 0.6 of up as in the shader's roof test, else its highest vertex; -1 for a vertex-less feature with no twin) and the hash (`featureHash`, also `TileFeatureStats.hash`), the feature's first face index and its face count in the tile's face table (0, 0 when it has none).

The face table is a second per-tile float texture, built by `utils/buildingFaces.ts`: three RGBA32F texels per face (plane n,d; s0,s1,u0,L; the run's highest h0, the run's lowest h1, the run's first face index, 0), in rows whose width is a multiple of 3. Faces come per feature from its wall triangles, sorted strong first then largest first and grouped into planes within 0.05 m; runs chain faces across turns of 25 degrees or less. A building keeps at most 256 faces (whole runs, longest first) and a tile 65,536 (features in id order). `TileFeatureStats` carries `up`, `north`, `faceFirst` and `faceCount` for them.

A custom shader has no per-tile uniform, so `installBuildingLookupStage()` wraps Cesium's private `BatchTexturePipelineStage.process`, which adds the `tc3d_buildingLookup` sampler and the `TC3D_BUILDING_LOOKUP` define to each tile's fragment shader and binds that tile's texture. The same stage binds the face table as the fragment sampler `tc3d_buildingFaces` (WebGL2; a tile with no table gets a shared 3 by 1 zero texture); the facade shader reads it (below). Builds run in `scene.postRender` under a per-frame budget (`BUILDING_LOOKUP_BUILD_BUDGET_MS`, 4 ms), and a tile builds across frames in steps: read-back; collect wall triangles (1,000 source triangles per step); group them into planes (1,000 wall triangles or 16,000 plane tests per step); link runs and caps (ending after the feature that passes 4,000 face pairs); publish. The budget is checked before every step, on the clock passed to `attachBuildingLookup` as its required fifth argument `now` (`CesiumViewer.tsx` passes `() => performance.now()`), and a tile's stats and textures appear only on its publishing render. The building lookup's build budget runs on that clock; tests pass a fixed or hand-advanced clock, never a `performance.now` spy. Textures are released as tiles unload. A tile whose lookup is not built yet, or is skipped (too many features for the texture limit, unreadable geometry, a build error, WebGL1), binds a 1 by 2 texture of `emptyLookupTexels()`, made by the same texture factory as built tiles (ground offset -1, wall top -1, hash 0) and shows the flat far tint with no floor lines, in colour variant 0. Base, roof and footprint area stay on the CPU, through `getTileFeatureStats`.

Window fitting: the shader matches each wall fragment to its face in the building's slice of the face table (`facadeFace`: the stored face normal gives the along-wall coordinate, the first match wins, the loop is bounded by the 256-face cap) and fits whole windows to the face's run (`facadeFit`). A wall fragment that matches no face, or a tile whose table has no faces, draws plain wall: no windows, slab lines or hangar seams. Across the run, bays n = max(1, round(span / class bay)), with a `FACADE_PIER_M` (0.6 m) pier at each end of an open run and none on a closed loop (periodic), so windows cross creases of up to 25 degrees inside a run. Rows lie between the run's highest face bottom plus `FACADE_BASE_BAND_M` (0.4 m) and its lowest face top minus `FACADE_PARAPET_M` (0.8 m): from the packed level count when the class uses levels, at least ceil(usable / 6 m) and at most floor(usable / 2.4 m) (`STOREY_MAX_M`, `STOREY_MIN_M`), at least 1; a wall under 2.4 m usable gets one row, one with no usable height none. Each run fits on its own, so rows do not continue across stacked building parts. Slab lines and hangar seams follow the fitted grid and draw only inside it. The lit and glass pattern hashes the cell and the run's identity (its first face index), so walls do not repeat each other's pattern. `utils/facadeFit.ts` holds the TypeScript twins (`matchFace`, `fitOpening`, `windowHashes`) that the shader's GLSL mirrors line for line; `utils/facadeFit.test.ts` runs them and `utils/facadeShader.test.ts` pins the GLSL bodies.

Console lines from `[buildingBaseLookup]`: `a building tile has no readable triangle primitive (...)` (once per tileset; it fires for the tileset's geometry-free root tile, so seeing it once is normal), `a tile has N features, more than the texture limit`, `WebGL1 cannot read buffers back; building facades show no floor lines`, `a building tile has more wall faces than the face table holds; N of its features keep none, and their walls show no windows` (once per tileset), and an error naming the tile when a build throws (`the building lookup or face table build failed for tile <url>; its facades show no floor lines`).

Footgun: the lookup depends on private Cesium names (`BatchTexturePipelineStage.process`, `ShaderDestination`, `Texture`, `Sampler`, and the model's `_sceneGraph._runtimeNodes` and GPU buffer fields). The bind side is checked at startup: `installBuildingLookupStage()` throws, naming the Cesium version, when a name is missing. The read side (buffers and scene graph) is not checked (TC3D-338), so a Cesium upgrade that renames one shows no floor lines, with at most the warnings above. Re-check `utils/buildingBaseLookup.ts` on every Cesium upgrade.

Footgun: a resource the app bundles (such as `aerodromes.json.gz`) goes into `bundle.resources` of both `src-tauri/tauri.conf.json` and `src-tauri/tauri.macos.conf.json`. The macOS config's array replaces the base one (JSON Merge Patch), so a resource listed only in the base file is missing from the macOS bundle.

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
│   └─ Measure button
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
└─ MeasuringTool (overlay when active)
    └─ Distance measurements on terrain
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
    │      ├─ Creates Babylon.Engine with transparent background and adaptToDeviceRatio
    │      │  (the engine sizes the canvas to CSS size × devicePixelRatio)
    │      ├─ Creates Babylon.Scene with MSAA 4x anti-aliasing
    │      ├─ Creates FreeCamera (synchronized with Cesium)
    │      ├─ Creates GUI AdvancedDynamicTexture for 2D overlays, in device pixels
    │      │  (useBabylonLabels scales label positions and sizes by devicePixelRatio)
    │      ├─ Adds hemispheric and directional lighting
    │      └─ Handles canvas resizing and resource disposal
    │
    ├─ 2. useBabylonWeather({ scene })
    │      ├─ Creates fog dome mesh (hemisphere, BACKSIDE rendering)
    │      ├─ Creates cloud layer mesh pool (4 planes, 50km diameter)
    │      ├─ Updates fog scale/opacity based on METAR visibility
    │      ├─ Updates cloud positions based on METAR ceiling data
    │      └─ Provides isVisibleByWeather() for label culling, delegating to isVisibleThroughWeather() in utils/weatherVisibility.ts (shared with useAircraftFiltering)
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
VATSIM API: 15s actual updates, 1s poll interval
RealTraffic API: ~2-3s updates via WebSocket
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
│   ├─ aircraftTimelineStore.ts (debug timeline modal)
│   ├─ airportStore.ts
│   ├─ datablockPositionStore.ts
│   ├─ globalSettingsStore.ts (shared across devices)
│   ├─ indexingStore.ts (MSFS model indexing progress)
│   ├─ measureStore.ts
│   ├─ realTrafficStore.ts (RealTraffic connection state)
│   ├─ replayStore.ts
│   ├─ runwayStore.ts
│   ├─ settingsStore.ts (local per-browser settings)
│   ├─ uiFeedbackStore.ts
│   ├─ updateStore.ts
│   ├─ vatsimStore.ts
│   ├─ viewportStore.ts (PRIMARY CAMERA STORE)
│   ├─ vnasStore.ts (vNAS connection state)
│   └─ weatherStore.ts
│
├─ services/
│   ├─ VatsimService.ts (VATSIM API client)
│   ├─ MetarService.ts (METAR weather parsing)
│   ├─ RealTrafficService.ts (RealTraffic WebSocket client)
│   ├─ AircraftModelService.ts (model lookup and matching)
│   ├─ MSFSModelConversionService.ts (FSLTL/AIG model conversion)
│   ├─ AircraftDimensionsService.ts (aircraft size data for scaling)
│   ├─ ModService.ts (custom model loading)
│   ├─ RunwayService.ts (runway data for flight phase)
│   └─ UpdateService.ts (app update checking)
│
├─ utils/
│   ├─ enuTransforms.ts (coordinate conversions)
│   ├─ formatting.ts (time/angle formatting utilities)
│   ├─ interpolation.ts (physics-based aircraft movement)
│   ├─ remoteMode.ts (Tauri vs browser detection, API base URL)
│   ├─ tauriApi.ts (unified API for Tauri commands and HTTP)
│   ├─ towerHeight.ts (tower position calculation)
│   ├─ frameStats.ts (median/p95 over a rolling sample window)
│   └─ performanceMonitor.ts (phase timers, GPU timers, longtask attribution, 300-frame window in dev builds)
│
├─ types/
│   ├─ aircraft-timeline.ts (debug timeline snapshots)
│   ├─ airport.ts (Airport data structures, tower height)
│   ├─ babylon.ts (labels, weather meshes, scene options, ENU transforms)
│   ├─ camera.ts (ViewMode, FollowMode, CameraState, etc.)
│   ├─ exportImport.ts (settings backup/restore)
│   ├─ fsltl.ts (MSFS model types, MSFSModelSettings)
│   ├─ mod.ts (modding system types, manifest formats)
│   ├─ performance.ts (PerformanceMetrics, FrameWindowSummary)
│   ├─ realtraffic.ts (RealTraffic API types)
│   ├─ replay.ts (replay snapshots, playback state)
│   ├─ settings.ts (grouped settings interfaces)
│   ├─ vatsim.ts (Pilot, AircraftState, InterpolatedAircraftState)
│   ├─ viewport.ts (Viewport, ViewportLayout, etc.)
│   ├─ vnas.ts (vNAS session types)
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
