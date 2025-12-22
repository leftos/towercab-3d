# Changelog

All notable changes to TowerCab 3D will be documented in this file.

## [Unreleased]

### Added
- Camera terrain collision: camera now stays at least 5 meters above terrain, preventing clipping through the ground
- Cloud layers now have soft fading edges that blend into the sky instead of hard square borders
- METAR overlay display (Ctrl+M): shows raw METAR at top of screen, color-coded by flight category (green=VFR, blue=MVFR, red=IFR, purple=LIFR)

### Fixed
- Cloud layers now render correctly as horizontal layers at their METAR-reported altitudes (previously invisible due to camera sync issue)

## v0.0.7-alpha (2025-12-21)

### Added
- "Aircraft Shadows Only" graphics setting: renders only shadows cast by aircraft onto the ground, disabling expensive terrain and building self-shadowing for better performance
- Advanced shadow tuning settings: Shadow Depth Bias, Polygon Offset Factor, and Polygon Offset Units sliders for fine-tuning shadow quality
- Replay controls integrated into bottom bar: toggle between main controls and replay controls using the button on the far left
- Replay scrubbing: step backward/forward through 15-second snapshots, play at 0.5x/1x/2x/4x speed, or scrub the timeline
- Replays can be viewed from any airport location (aircraft are filtered by distance from current view)

### Fixed
- Reduced shadow banding artifacts with improved default bias values and OpenGL graphics backend
- Aircraft now smoothly transition from ground to airborne during takeoff instead of warping/jumping
- Datablock leader lines now correctly point to the aircraft's visual position on screen
- Switching to 2D mode while tower following no longer breaks aircraft centering (auto-switches to orbit follow)
- Switching to tower follow while in 2D mode now works correctly (auto-switches to 3D view)

### Changed
- Shadow sub-settings now shown as disabled (greyed out) instead of hidden when shadows are off
- Graphics settings tab no longer dims the viewport, allowing you to see changes in real-time
- Orbit follow mode now works in 2D top-down view: aircraft stays centered on screen while you can still rotate heading and adjust altitude
- Orbit camera settings (distance, heading, pitch) now persist when switching between followed aircraft
- Replay snapshots now use ~50% less memory (removed redundant previous state storage)

## v0.0.6-alpha (2025-12-21)

### Fixed
- Fixed infinite loop crash when using orbit follow mode or dragging inset viewports
- Aircraft list now shows the same aircraft as datablocks on the map
- Ground/airborne traffic toggles now affect both aircraft list and datablocks
- Shadow banding artifacts no longer visible (ambient occlusion disabled by default)
- Aircraft models now update smoothly at 60Hz instead of jerking once per second
- Aircraft models now render for all aircraft within the sphere radius, while datablocks are filtered separately (fixes missing aircraft models)
- Camera lag in orbit follow mode eliminated (removed smoothing that was causing 217ms delay)
- Aircraft banking direction now correct (left turn drops left wing, right turn drops right wing)
- Aircraft on the ground no longer bank when turning (yaw only below 40 knots groundspeed)
- Aircraft models no longer jitter when multiple viewports are active
- Landing aircraft no longer clip through the runway during rollout (terrain clamping now applies even at high speeds)

### Changed
- Panel filters (search, airport traffic, weather visibility) now affect both list and datablocks on the map
- Aircraft panel filters now persist across sessions
- Followed aircraft now pinned to the top of the Nearby Aircraft list for easier tracking
- Improved shadow quality at longer distances (default max range increased from 2km to 10km)
- Improved shadow rendering performance (reduced default shadow map resolution from 4096 to 2048)
- Shadow max distance can now be configured up to 20km for advanced users
- Aircraft pitch and roll now smoothly interpolated at 60Hz (prevents jumps when VATSIM data updates)
- Improved performance at busy airports by removing unused propeller animation code
- Datablock labels positioned closer to aircraft for better visibility

### Removed
- Removed "Shadow Cascades" setting from graphics options (not user-configurable)

### Added
- Landing flare emulation: aircraft now pitch nose-up when approaching the runway, simulating the flare maneuver pilots perform before touchdown
- Compass direction indicator in top bar showing current camera heading (N/NE/E/SE/S/SW/W/NW)
- Ambient occlusion (HBAO) is now a configurable graphics setting (disabled by default to prevent banding)
- Aircraft pitch and roll emulation: aircraft now tilt nose up/down during climbs and descents, and bank into turns based on physics
- New Display settings for orientation emulation with adjustable intensity (25%-150%)
- Performance monitoring HUD: Press F1 to show real-time FPS and frame timing diagnostics

## v0.0.5-alpha (2025-12-20)

### Fixed
- Save/Load Bookmark and Set Default/To Default buttons now work correctly (camera state was not being saved/restored properly due to internal store mismatch)

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