# Changelog

All notable changes to TowerCab 3D will be documented in this file.

## [Unreleased]

### Added
- App now ships with tower cab camera position defaults based on vNAS and FAA data
- Press Enter in airport picker to select the top result without tabbing
- Default datablock direction setting in Settings > Aircraft
  - Choose the default position (1-9 numpad style) for datablocks on new airports
  - Press 5+Enter to reset all datablocks to this default
  - Press 5+click on an aircraft to reset just that aircraft's datablock to the default
- Shareable tower positions with "Save/Load App Default" buttons
  - Hold Shift to see buttons change from "Save/Load My Default" to "Save/Load App Default"
  - Shift+click "Save App Default" saves current view to `mods/tower-positions/{ICAO}.json`
  - Shift+click "Load App Default" loads from tower-positions folder or built-in defaults
  - Normal click saves/loads your personal default (stored locally)
  - Prompts for confirmation when overwriting existing app default
- Separate 3D and 2D view defaults for tower positions
  - Each airport can have independent settings for 3D tower view and 2D topdown view
  - Save/Load My Default (normal click) is now view-mode-specific
  - Save/Load App Default (Shift+click) is also view-mode-specific
  - If only 3D is defined, 2D mode uses 3D heading with default altitude
- Easy GitHub contribution for tower positions
  - After saving an App Default, a dialog offers to contribute to the project
  - Click "Contribute to GitHub" to open browser with file content pre-filled
  - No Git knowledge required - GitHub handles fork and PR automatically
  - Click "Don't Ask Again" to disable the prompt (can re-enable in settings later)
- Visual feedback on Save/Load Default buttons
  - Buttons briefly turn green and show "Saved!" or "Loaded!" when triggered

### Changed
- Tower positions now stored as individual files per airport (`mods/tower-positions/KJFK.json`) instead of single `tower-positions.json`
  - Easier to share and accept contributions for specific airports
  - Legacy single-file format still supported for backward compatibility
- Default camera pitch changed from -15° to -10° for a more level view

### Fixed
- Fixed tower positions and mods not loading on app startup

## [0.0.15-alpha] - 2025-12-25

### Fixed
- Fixed numpy not being bundled properly in fsltl_converter.exe, leading to conversion failures

## [0.0.14-alpha] - 2025-12-25

### Added
- FSLTL Models toggle in Settings to enable/disable converted FSLTL aircraft models
  - Toggle only appears after models have been converted (not shown for new users)
  - Automatically enabled after a successful conversion
- "Distance (Camera)" sort option in aircraft panel - sorts by distance from your current camera position instead of the airport

### Changed
- Leader lines now have more separation from aircraft icons in 2D top-down view
- Increased terrain/imagery tile cache for smoother panning
  - Default cache raised from 500 to 2000 tiles (configurable up to 5000)
  - Tiles stay in memory longer when panning around the airport area

### Fixed
- Fixed camera zooming out when clicking follow on an aircraft
  - Camera now preserves your current zoom level when entering follow mode
- Fixed FR24 aircraft models floating above ground due to incorrect ground offset detection
- Fixed leader lines connecting from wrong corners on datablocks
- Fixed issue where FSLTL Converter would fail early with no indication that it failed and why
- Fixed flight phase detection for aircraft on runways
  - Aircraft crossing runways now show "Taxi" instead of incorrectly showing "Rolling"
  - Aircraft on early takeoff roll no longer incorrectly show "Pushback"
  - Go-arounds now correctly show "Rolling" (accelerating) instead of "Roll Out" (decelerating)
- Fixed aircraft jumping up in the air when accelerating past 40 knots on takeoff roll
  - Height offset now scales gradually from ground level to flying height based on actual altitude above ground
  - Transition now uses previous frame's corrected height as source for smooth animation

## [0.0.13-alpha] - 2025-12-25

### Added
- Datablock repositioning using numpad-style directions (1-9)
  - Press 1-9 then Enter to move all datablocks to that position (e.g., 9+Enter for top-right)
  - Press 1-9 then click an aircraft to move just that aircraft's datablock (SLEW mode)
  - Position 5 is excluded (center reference point only)
  - Global position saved per airport; per-aircraft overrides are session-only
- Leader Line Length setting (1-5) controls distance between datablocks and aircraft
- Auto-rearrange datablocks setting to prevent label overlaps (enabled by default)
- Setting to control whether followed aircraft is pinned to the top of the aircraft list (enabled by default)
- Smart sort for aircraft panel with flight phase detection
  - Automatically categorizes aircraft by phase: Short Final, Final, Rolling, Roll Out, Go Around, Lined Up, Hold Short, Pattern, Pushback, Taxi, Stopped, Climbing, Inbound
  - Shows associated runway when applicable (e.g., "Short Final 25L")
  - Distinguishes parallel runways (07L vs 07R) using lateral offset from centerline
  - Phase badges now display for all sort modes, not just Smart sort
- Go-around and missed approach detection
  - Detects aircraft that were recently on approach or landing roll and are now climbing aggressively
  - Highest priority in the list since it's an unexpected event requiring controller attention
- Click-to-look feature for aircraft panel
  - Click any aircraft in the list to smoothly pan the camera to center on it
  - Correctly calculates bearing from actual camera position (including WASD offsets)
- Aircraft with unknown type but known airline now show airline-specific liveries
  - Searches B738, A320, B739, A321, A319, B737, A20N, A21N, A19N, B38M, B39M, B73X for matching airline livery
  - Example: JetBlue flight with N/A type shows JBU A320 livery instead of generic white B738
- Added C400 (Cessna 400/Corvalis TT) to aircraft dimensions database
  - Now matches to similar-sized GA aircraft (P28A) instead of falling back to B738
- Improved aircraft model matching for airlines with limited liveries
  - Airlines now use their closest available aircraft type when an exact match doesn't exist (e.g., FedEx B738 uses FedEx B738F with scaling)
  - Freighter variant dimensions now resolve correctly (B738F uses B738 dimensions)
  - GA aircraft now match to similar-sized models with scaling instead of falling back to B738
- Follow mode UI now displays current zoom level (tower mode) or distance (orbit mode)
  - Shows numeric value with valid range for quick reference
  - Updated hints show "O to switch" between follow modes
- Orbit follow mode now remembers zoom distance and camera angle globally
  - Settings persist across aircraft, airports, and app restarts
  - New viewports automatically use your last-used orbit settings
- Dynamic ground clamping for aircraft models based on actual geometry
  - Aircraft now sit at the correct height on the ground based on their 3D model bounds
  - Accounts for landing gear animation state (gear up vs gear down)
  - Different aircraft types (A380 vs CRJ200) automatically get correct positioning
- FSLTL models are now auto-discovered from the output folder on startup
  - Point to any folder containing converted models and they'll be loaded automatically
  - No need to re-convert models when changing the output path
  - Changing the output folder in Settings immediately scans for existing models
- Custom tower cab positions: Define default camera positions for airports via mods/tower-positions.json
  - Specify latitude, longitude, height above ground, and initial heading per airport
  - Tower-positions.json provides "app default" positions (used on first airport visit or Shift+Home reset)
  - Optional meter-level position fine-tuning with positionOffset (latMeters/lonMeters)
- Tower mod manifest enhancements (cabPosition and cabHeading fields)
  - Tower mods can now specify camera position independently of 3D model placement
  - Meter-level position offset support (latMeters/lonMeters) for precision adjustments
  - cabPosition and cabHeading become the default when set (higher priority than tower-positions.json)
- Tower mod manifest position field improvements
  - Added absolute position field for 3D model placement (more intuitive than offset-only)
  - positionOffset now uses meter units (latMeters/lonMeters) instead of degrees for fine-tuning precision
- VMR (Visual Model Rules) file support for custom aircraft model matching
  - Define custom model rules in XML format (.vmr files) placed in mods/ folder
  - Support for airline-specific liveries using CallsignPrefix attribute
  - Support for model alternatives (fallback models with // separator)
  - Manifest.json support in model folders for scale and rotation offset customization
  - Pre-loading of manifests during startup for fast synchronous lookups

### Changed
- VMR rules now take highest priority in model matching (before FSLTL and built-in models)
- Model matching now validates file existence before returning model paths

### Fixed
- Aircraft no longer drift sideways during taxi and pushback
  - Ground movement now interpolates along actual direction of travel, not heading
  - Fixes unrealistic lateral sliding during pushback and turning taxi
  - Airborne aircraft still show realistic crosswind crab
- Weather effects (clouds, fog) now instantly hide/show when switching between 3D and 2D view modes
- FSLTL converter now reads model.CFG to find the correct base model variant
  - Fixes airline livery textures not loading (e.g., DAL A321 appearing white)
  - Sharklet vs non-sharklet variants now use correct texture filenames
- Camera no longer rubberbands or builds up momentum when hitting limits (pitch, zoom, distance, altitude)
- Orbit camera no longer clips through terrain when close to the ground
  - Camera automatically stays above terrain with minimum altitude
  - Pitch recalculates to keep aircraft in view when height-constrained
- Scroll wheel now responds immediately when changing direction (cancels existing momentum)
- VMR XML parsing now handles both self-closing tags and open/close tag formats

## [0.0.12-alpha] - 2025-12-24

### Added
- Shift+Home keyboard shortcut resets to app default view, ignoring any saved user default
- Named bookmarks: save bookmarks with custom names using `.XX.NAME.` format (e.g., `.01.1L/1R FINAL.`)
- Quick bookmark recall: Ctrl+0-9 instantly loads bookmarks 0-9
- Bookmark Manager (Ctrl+B): modal to view all 100 bookmarks, load, rename, and delete them with full keyboard navigation (arrow keys, Enter to load, R to rename, Del to delete)
- Auto-update support: app now checks for updates on startup and every 4 hours, with notification bar showing download progress and restart prompt
- Manual update check button in Settings > Help > Updates
- Version number now displayed in window title

### Changed
- Modals (Settings, Import, Model Matching) no longer close when clicking outside; use the X button or Escape key to close

## [0.0.11-alpha] - 2025-12-24

### Changed
- Shift+R and Home keys now reset to your saved default view for the airport instead of hardcoded app defaults

### Fixed
- FSLTL converter not found in installed builds (was looking in wrong directory)

## [0.0.10-alpha] - 2025-12-24

### Changed
- Overcast (OVC) cloud layers now use curved dome geometry instead of flat planes, creating a more realistic sky appearance with gradual darkening toward the horizon
- Model Matching panel: VMR-mapped matches (e.g., B753 mapped to B739/UAL) now show "vmr" instead of "exact"
- Model Matching panel: Scale column now only shows values for closest matches where scaling was applied

### Fixed
- Aircraft with unknown type (N/A) now use FSLTL B738 base model as fallback instead of built-in model

## [0.0.9-alpha] - 2025-12-24

### Added
- FSLTL aircraft model support: import airline-specific liveries from the FSLTL (FS Live Traffic Liveries) package
  - In-app conversion panel in Settings > General > FSLTL Aircraft Models
  - Select specific airlines and aircraft types to convert (saves disk space)
  - Texture quality options: Full 4K, 2K, 1K (recommended), 512px
  - Automatic model matching by airline ICAO code from callsign (e.g., UAL123 → United livery)
  - Fallback to base/generic liveries when airline-specific model unavailable
  - Converted models persist in IndexedDB registry for instant loading
  - Landing gear animations for FSLTL models: gear extends when descending below 2,000ft AGL, retracts when climbing above 500ft AGL

### Fixed
- Camera jitter when following aircraft in tower or orbit mode
- Weather interpolation no longer updates every 2 seconds with a stationary camera (fixed throttle logic that was causing cloud flickering)

## [0.0.8-alpha] - 2025-12-22

### Added
- Model brightness control: new Graphics > Model Brightness slider (50-300%) lets you brighten or darken aircraft models without overexposure. Values above 110% create a smooth glow/emissive effect
- Weather interpolation: weather effects now blend from the 3 nearest METAR stations based on camera position using inverse distance weighting, providing smoother weather transitions as you move between airports
- Auto-airport switching: optional setting to automatically switch to the nearest airport as you move the camera (disabled by default, enable in Settings > General > Camera)
- Weather effects
  - Rain and snow particle effects based on METAR precipitation codes (RA, SN, DZ, etc.)
  - Lightning flashes during thunderstorms (TS code in METAR)
  - Wind affects precipitation particles based on METAR wind direction and speed
  - Gusty conditions (G in METAR) cause periodic wind speed variations
  - Show Precipitation toggle, Precipitation Intensity slider, Show Lightning toggle
- Camera terrain collision: camera now stays at least 5 meters above terrain, preventing clipping through the ground
- Cloud layers now have soft fading edges that blend into the sky instead of hard square borders, and use noise to create distinct clouds dependent on cloud coverage
- Cloud layers slowly rotate to simulate wind drift, with different layers moving at slightly different speeds based on altitude
- Cloud layers transition smoothly when METAR updates: altitude changes animate gradually, coverage changes morph existing cloud patterns (FEW becoming SCT adds clouds to existing patches rather than regenerating), and unrelated layers crossfade elegantly
- METAR overlay display (Ctrl+M): shows raw METAR at top of screen, color-coded by flight category (green=VFR, blue=MVFR, red=IFR, purple=LIFR)
- Model matching debug modal (F3): shows all aircraft in data radius with their matched 3D model, match type (exact/mapped/closest/fallback), and scaling applied

### Changed
- Weather debug panel: Apply button now applies both precipitation and cloud settings together
- Weather debug panel: overridden settings are now protected from METAR auto-refresh until cleared

### Fixed
- Cloud layers now render correctly as horizontal layers at their METAR-reported altitudes (previously invisible due to camera sync issue)
- Fixed small dot appearing at center of screen (uninitialized leader line coordinates)
- Landing aircraft now smoothly lower nose after touchdown instead of snapping horizontal (nosewheel lowering transition over ~1 second)

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