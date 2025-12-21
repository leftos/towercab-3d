# Changelog

All notable changes to TowerCab 3D will be documented in this file.

## [Unreleased]

### Changed
- Windows installer now upgrades existing installations with fewer prompts (no scope or language dialogs)
- Nearby aircraft distance now uses 3D slant range (includes altitude difference from tower/camera) instead of surface distance only
- Renamed "Label Visibility Distance" setting to "Max Nearby Aircraft Range" for clarity
- Moved "Add Inset" button from floating position to the bottom controls bar (next to Measure)

## v0.0.4-alpha (2025-12-20)

### Added
- Browser mode: run `npm run serve` to launch the app in your default browser instead of as a desktop application (mods not supported in browser mode)
- Experimental Graphics settings in Settings modal:
  - MSAA samples (1x, 2x, 4x, 8x)
  - FXAA toggle
  - HDR toggle
  - Logarithmic depth buffer toggle
  - Ground atmosphere toggle
  - Globe lighting toggle
  - Shadow settings: enable/disable, map resolution (1K-8K), cascades, max distance, darkness, softness
- Automatic settings migration from previous Electron version on first launch
- Comprehensive Export/Import in Settings modal:
  - Exports global settings, per-airport camera bookmarks, default views, and viewport layouts
  - Import wizard lets you select which airports and settings to import
  - Merge or replace modes for combining with existing data
- GitHub Actions CI/CD for automated builds and releases

### Changed
- Migrated from Electron to Tauri 2 for smaller bundle size and better performance
- Application now uses native WebView2 on Windows instead of bundled Chromium

### Fixed
- Graphics settings now apply immediately without requiring app restart
- Changing MSAA samples no longer causes crash

## v0.0.3-alpha

### Added
- Non-uniform aircraft scaling: aircraft now scale separately for wingspan and length instead of using an averaged ratio, better representing relative sizes of different aircraft types
- Dynamic model switching: aircraft models now update in real-time when switching between aircraft types (e.g., following a B738 then switching to follow an A380)
- Multi-viewport system with inset viewports:
  - Click "Add Inset" button to create additional viewports overlaid on the main view
  - Each viewport has independent camera controls (heading, pitch, FOV, follow mode)
  - Click-to-activate system: cyan border indicates active viewport, keyboard/mouse controls affect only the active viewport
  - Inset viewports are draggable (via title bar) and resizable (via edges/corners)
  - Close button (×) to remove inset viewports
  - Performance warning at 3+ insets, severe warning at 6+ insets
  - Per-airport viewport layout persistence (inset positions/sizes saved per airport)
  - Each viewport can follow different aircraft independently
- Measuring tool for measuring distances on the terrain:
  - Click the Measure button in the controls bar to activate measuring mode
  - Click to set the first point, then see a live preview of the distance as you move your mouse
  - Click again to lock in the measurement; the line and distance label remain on screen
  - Add multiple measurements by clicking additional points while in measuring mode
  - Right-click on any measurement endpoint to remove that measurement
  - Distance shown in meters/feet for short distances, kilometers/nautical miles for longer distances
  - Dashed line visualization connects measurement points with distance labels at midpoints
- WebXR VR support foundation:
  - VR button appears in controls bar when a VR headset is detected (via Quest Link, SteamVR, or similar)
  - Dual-pass Cesium stereo rendering captures left/right eye views with proper frustum offsets
  - Babylon.js WebXR session displays Cesium terrain as background textures in VR
  - UI automatically hides when VR mode is active for immersive experience
  - Configurable IPD (interpupillary distance) for stereo separation

### Changed
- Top-down view scaling redesigned: aircraft stay at real-world scale when zoomed in (for accurate conflict assessment), only scaling up when zoomed out far enough that they'd become too small to see
- Aircraft rendering switched from Entity pool to Model primitives for improved performance and non-uniform scale support
- Status bar now displays total pilots on VATSIM network (previously showed only nearby aircraft)
- Global search (Ctrl+K) now searches all pilots on the network, not just nearby aircraft

### Fixed
- Cloud layers now hidden in 2D top-down view (prevents clouds from obscuring the entire view when looking straight down)
- Cloud ceiling culling disabled in 2D view (datablocks no longer hidden by cloud layers when in top-down mode)
- Aircraft now refilter immediately when changing airports (previously waited up to 3 seconds for next API poll)
- WASD diagonal movement now works correctly (e.g., W+A moves forward-left at proper speed)

## v0.0.2-alpha

### Added
- Version number now displayed in window title bar
- 39 aircraft 3D models from Flightradar24/fr24-3d-models (GPL-2.0, originally from FlightGear):
  - Airbus: A318, A319, A320, A321, A330-200/300, A340-300/600, A350, A380
  - Boeing: 737-600/700/800/900, 747-400/8, 757-200/300, 767-200/300/400, 777-200/300, 787-8/9
  - Regional: ATR 42, BAe 146, CRJ-700/900, A220-100/300, E170, E190, Q400
  - Other: Beluga, Citation, helicopter, PA-28, ASK-21 glider
- Aircraft type-based model selection - uses correct 3D model when available (e.g., B738 uses b738.glb)
- Dimension-based model matching for unknown aircraft types:
  - Finds closest matching model by FAA wingspan/length data
  - Applies calculated scale factor to match actual aircraft dimensions
  - Falls back to B738 at 1:1 scale only when no FAA dimension data available
- AircraftDimensionsService for FAA aircraft dimension lookups
- AircraftModelService for managing model selection and scaling logic
- Tabbed settings modal with 5 tabs: General, Display, Graphics, Performance, and Help
- Datablock display mode setting with three options:
  - Full: shows callsign, aircraft type, altitude, and speed
  - Airline Codes Only: shows only the airline ICAO code (e.g., "UAL" instead of "UAL123") for airline flights
  - None: hides labels entirely, showing only aircraft cones
- New settings now accessible in the UI:
  - Theme (light/dark)
  - Default FOV and camera speed
  - Mouse sensitivity for right-click drag camera rotation
  - Max aircraft display limit
  - Show/hide ground and airborne traffic separately
  - In-memory tile cache size
  - Disk cache size
  - Aircraft data radius
- Weather effects section in Graphics tab with fog and cloud controls
- METAR-based weather visualization:
  - Cesium fog (reduces terrain/imagery draw distance based on visibility)
  - Babylon fog dome (visual fog wall at visibility distance with fresnel edge effect)
  - Cloud layer planes positioned at METAR-reported ceiling altitudes
  - Automatic 5-minute weather refresh from Aviation Weather API
- Weather-based datablock culling:
  - Datablocks hidden when aircraft is beyond reported visibility range
  - Datablocks hidden when BKN/OVC cloud layer is between camera and aircraft
  - Followed aircraft always visible regardless of weather
- Aircraft panel filters:
  - "Visible" filter to show only weather-visible aircraft
  - Airport traffic filter to show only aircraft departing/arriving at current airport
- Tunable weather settings:
  - Fog Intensity (0.5x-2.0x): controls fog dome opacity
  - Visibility Scale (0.5x-2.0x): multiplier for fog distance (2.0 = see twice as far as METAR)
- Settings modal removes blur on Graphics tab for real-time weather preview
- Nearest METAR mode for orbit following without airport:
  - When orbit-following aircraft without an airport selected, weather updates based on camera position
  - Automatically finds nearest METAR station within 100nm of current location
  - Position-based throttling to avoid excessive API requests (refetches when moving ~3nm)
  - Enables realistic weather when flying around globally

### Changed
- Aircraft rendering now uses type-specific 3D models instead of generic cones/sample model
- Settings modal reorganized into tabs to reduce vertical scrolling
- Keyboard shortcuts moved to dedicated Help tab

### Fixed
- Aircraft models and datablocks now render correctly when using global search (Ctrl+K) to orbit an aircraft without an airport selected
- Ground aircraft at high-elevation airports (e.g., KRNO at 4,517ft) no longer appear floating; now uses altitude above ground level (AGL) instead of absolute altitude for ground detection
- Aircraft 3D models now face the correct direction (fixed 180° rotation issue from Flightradar24 models)
- Aircraft models no longer clip through ground (added 1m height offset)
- Applied muted gray color to aircraft models to hide UV test textures until airline liveries are implemented

## v0.0.1-alpha

- Initial Release