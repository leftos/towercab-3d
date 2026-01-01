# Changelog

All notable changes to TowerCab 3D will be documented in this file.

## [0.0.26-alpha] - 2026-01-01

### Changed
- Aircraft now removed from display after 30 seconds without updates (was 60 seconds)
- GA aircraft (N-numbers, registrations like C-XXXX, G-XXXX) now use Cessna 172 as fallback model instead of Boeing 737
  - Much more realistic representation for small private aircraft
  - Falls back to C172, C152, DA40, or TBM930 from FSLTL if available, otherwise built-in PA28

### Fixed
- More work to smooth out aircraft interpolation and reduce snapping
  - Reworked algorithm to use present position as starting point towards new target when new observation arrives
  - Increased display delay buffer for VATSIM to 17s to reduce extrapolation frequency
- Camera no longer gets stuck panning if right-click release is missed during low framerate
- Aircraft no longer bounce pitch up and down after landing
  - Nosewheel lowering transition now blends to level instead of noisy vertical rate data
- Rain no longer stops after a few seconds when loading an airport with precipitation
- Rain intensity now properly reflects METAR light/moderate/heavy codes
  - Light rain (-RA) is now a gentle drizzle instead of a downpour

## [0.0.25-alpha] - 2025-12-30

### Fixed
- Reduced aircraft position snapping when VATSIM data updates

## [0.0.24-alpha] - 2025-12-30

### Added
- Smarter datablock layout algorithm that places labels at any angle and distance
  - Labels automatically find non-overlapping positions using a spiral search
  - Distance extends automatically when needed to avoid overlaps
  - Priority-based placement: followed aircraft > custom positions > closer aircraft > airborne

### Changed
- Tower follow mode max zoom increased from 5x to 10x
- Leader Line Length setting now supports 0.5 increments (0.5, 1.0, 1.5, 2.0, etc.)

### Fixed
- Auto-rearrange datablocks now respects your chosen leader line length setting
  - Previously added extra spacing on top of your setting, causing datablocks to spread too far apart

## [0.0.23-alpha] - 2025-12-30

### Added
- Mobile zoom buttons for touch devices
  - Plus/minus buttons appear next to the virtual joystick on mobile browsers
  - Works with all camera modes: zoom level (tower), distance (orbit), and FOV (free camera)
- Ground label filtering to reduce gate clutter
  - All: Show labels for all ground aircraft (default)
  - Moving Only: Show labels for aircraft above custom speed threshold
  - Active Only: Show labels for aircraft above 5 knots
  - None: Hide all ground traffic labels
  - Access via Settings > Display > Ground Labels
- Building quality setting for 3D OSM buildings
  - Low: Aggressive LOD reduction, minimal caching (saves memory on older devices)
  - Medium: Default Cesium behavior with 256MB cache
  - High: Keep detail longer with 512MB cache
  - Access via Settings > Graphics > Terrain

### Changed
- Display settings now sync across all connected devices
  - Datablock mode, label visibility distance, ground/airborne traffic toggles, leader distance, and default datablock direction are now shared
  - Provides consistent controller view when accessing from iPad or other browsers

### Fixed
- Aircraft no longer jump backward when switching data sources (e.g., vNAS → VATSIM after landing)
  - Previously, aircraft would teleport ~30 seconds back along their path when the data source changed
  - Each observation now stores its own display delay, preventing sudden position jumps during transitions

## [0.0.22-alpha] - 2025-12-29

### Added
- Responsive mobile-friendly UI for smaller screens and tablets
  - Controls bar adapts to screen size, hiding less-used buttons into flyout menus at narrower widths
  - Mobile tools flyout shows connectivity status and quick access to debug tools
  - Flyout menus for Search, Measure, Bookmarks, and other controls on compact layouts
- Remote client presence indicator
  - Desktop app shows monitor icon with count when browsers/tablets are connected via remote access
  - Helps track how many devices are viewing the tower

### Changed
- Global aircraft search (Ctrl+K) now sorts results by distance from camera when an airport is selected
  - Closest aircraft appear first, with distance shown in results (e.g., "12.3nm")
  - Selecting an aircraft within render range automatically uses tower follow mode
  - Aircraft beyond render range still use orbit follow mode
- Touch controls simplified to virtual joystick only; other tools now accessible via mobile flyout menu

### Fixed
- Fixed pinch-to-zoom breaking tower follow mode on mobile devices
  - Two-finger gestures no longer accidentally trigger camera rotation that breaks follow
- Fixed Babylon overlay not initializing on freshly connected remote browsers

## [0.0.21-alpha] - 2025-12-28

### Fixed
- Datablocks now display at correct positions on 4K and other high-DPI displays
  - Labels were appearing far from aircraft due to coordinate system mismatch
  - Cesium returns CSS pixels but Babylon GUI operates in device pixels
  - All screen coordinates now properly scaled by devicePixelRatio

## [0.0.20-alpha] - 2025-12-28

### Fixed
- Settings now automatically recovered on startup if lost during upgrade
  - Cesium token, FSLTL paths, and camera bookmarks are restored from browser storage
  - Only recovers missing settings; existing settings are not overwritten
  - Manual "Repair Settings" button available in Settings > Help if needed

## [0.0.19-alpha] - 2025-12-28

### Added
- RealTraffic API integration for real-world ADS-B traffic
  - See real aircraft at any airport worldwide
  - Switch between VATSIM and RealTraffic in Settings > General > Data Source
  - Requires a RealTraffic license key (subscription service)
  - ~2-3 second update intervals with ADS-B ground track for accurate taxi/pushback direction
  - Configurable query radius (10-200 NM)
  - Max Parked Aircraft setting (0-200) to include stationary aircraft at gates
    - Active aircraft get display priority; parked fill remaining slots
    - Set to 0 to disable parked aircraft
  - Auto-connects when switching to RealTraffic if license key is saved
- "Waiting for data updates..." overlay with spinner while loading initial aircraft data
  - Aircraft now spawn in individually once they have enough data to interpolate smoothly
  - Prevents jerky initial appearance when aircraft only have one data point
- Aircraft Timeline Debug Modal (F4) for visualizing observation data
  - DAW-style timeline showing when each aircraft position update was received
  - Color-coded markers by source: VATSIM (blue), vNAS (green), RealTraffic (orange), Replay (purple)
  - Latency lines showing delay between observation time and receipt time
  - Hover tooltips with detailed observation info including RealTraffic-specific fields
  - Filter dropdown to show all aircraft or only those within range
  - Zoom slider and auto-scroll toggle
  - Replay position indicator: purple playhead and "REPLAY" label show current position during playback
  - Display time line: dashed white vertical line shows where interpolated positions are rendered from
- Export/Import Settings Wizard with selective export
  - Tree view lets you choose exactly which settings and airports to export
  - Select individual categories (Graphics, Camera, Weather, etc.) or specific airports
  - Import wizard shows what's available in the file before importing
  - Merge mode preserves existing bookmarks while adding new ones

### Changed
- VATSIM data now polled every 1 second (down from 15 seconds) for lower latency
- Default shadow mode is now "Aircraft Shadows Only" for better performance
- Shadow Darkness slider now works intuitively: 0% = invisible, 100% = black
- Night darkening disabled by default (can be enabled in Settings > Graphics > Lighting)
- Follow mode zoom level no longer displayed in aircraft panel header
- Cesium Ion token is no longer included in exports (security improvement)
- Datablock leader lines now scale with aircraft wingspan for more proportional positioning
  - Small aircraft (GA planes) have shorter leader lines for better visual balance
  - Large aircraft (widebodies) have longer leader lines matching their size
- Replay mode now uses the unified timeline interpolation system
  - Smoother scrubbing through recorded data
  - Consistent interpolation behavior between live and replay modes
  - Buffer replay (Enter key) scrubs through existing timeline without reloading
- Replay exports now include extended ADS-B data when available
  - Ground track, on-ground status, roll angle, and vertical rate are preserved
  - Imported replays use this data for more accurate playback

### Fixed
- Orbit follow mode now remembers zoom distance and camera angle across app restarts
  - Previously reset to 500m default on every app launch
- Ground aircraft no longer bank/roll during turns
  - Aircraft on the ground now only yaw (rudder steering) as in real life
- Aircraft on takeoff or landing roll now correctly show "Rolling" or "Roll Out" phase
  - Previously showed "Taxi" because alignment was checked against the wrong runway threshold
  - Now properly detects alignment with either runway direction
- Crosswind approaches now correctly detected as "Final" even when aircraft is crabbing
  - Uses ground track instead of heading for approach detection
- Go-around detection now catches rejected landings during runway acceleration
  - Previously only detected once aircraft was airborne and climbing

## v0.0.18-alpha - 2025-12-28

### Fixed
- Remote browser access server now starts correctly on installed versions
  - The HTTP server was failing to find frontend assets in production builds
  - Settings > Server > Start Server now works as expected

## v0.0.17-alpha - 2025-12-27

### Added
- WASD keys now exit orbit mode while keeping camera pointed at the aircraft
  - Pressing any WASD key in orbit mode calculates heading/pitch from tower to aircraft
  - Camera remains at tower position looking at where the aircraft was
  - Provides a quick way to break out of orbit without snapping back to pre-follow view
- METAR overlay now displays interpolated weather in orbit follow mode without an airport selected
  - Shows blended weather data from nearby stations with flight category color coding
  - Displays source stations and their contribution weights
- Data source indicators in aircraft panels (pending vNAS integration)
  - Nearby Aircraft panel header shows "1s" (green) when receiving vNAS live updates, or "15s" when using standard VATSIM polling
  - Individual aircraft show a green dot next to their callsign when receiving 1Hz live updates
  - Flight Search panel (Ctrl+K) shows the same indicators in the footer and per-result
- Weather particle pre-warming for instant visibility
  - Rain/snow effects now appear immediately when switching from 2D to 3D view
  - Also pre-warms when camera jumps to a new location (flyTo, following new aircraft)
- Max framerate limiter in Settings > Graphics > Rendering
  - Limit rendering to 30, 60, 120, 144 FPS or unlimited
  - Reduces GPU usage and heat on high-refresh-rate displays
- Aircraft night visibility boost in Settings > Graphics > Lighting
  - Increases aircraft brightness at night to stay visible against darkened terrain
  - Adjustable from 1.0x (no boost) to 3.0x (very bright)
- Performance HUD improvements (F1)
  - Shows Cesium primitive count and tile loading status
  - More accurate Cesium render timing measurement
- Weather smoothing for gradual transitions
  - Fog and cloud layers now fade smoothly when METAR updates
  - Prevents abrupt weather changes when switching airports
- Clouds visible from above when flying above cloud layer
  - Camera flying above clouds sees white cloud tops instead of looking through them
  - Smooth transition between below-cloud and above-cloud views

### Changed
- FSLTL models now always preferred over built-in FR24 models
  - Previously, airlines without FSLTL liveries would fall back to built-in B738 instead of FSLTL generic B738
  - All FSLTL matching (exact, scaled, base livery) now happens before built-in model matching
- FSLTL VMR rules file now copied to output folder during conversion
  - Enables type aliasing (B38M→B738) and better matching without keeping source folder configured
  - App loads VMR from output folder first, falls back to source folder if not found
- Aircraft panel now hidden when no airport is selected and no flight is being followed
- 2D top-down view improvements
  - Aircraft models now display at full size (previously scaled to 50%)
  - Only aircraft cast shadows in top-down view (terrain shadows disabled for cleaner look)
- FSLTL settings panel reorganized to show converted models location first
  - Can now browse for a folder with previously converted models without setting up a source path
  - Conversion-related options (source folder, texture quality) shown below for new conversions
- Longer airport transition animation (5 seconds) for smoother terrain streaming
- Graphics settings reorganized into collapsible sections (Rendering, Model Appearance, Shadows)

### Fixed
- Fixed mouse wheel zoom being sluggish at low frame rates
  - Wheel impulse decay is now time-based instead of frame-based
  - Scrolling now feels equally responsive at 30 FPS as at 60 FPS
- Fixed follow mode not working for aircraft outside the current 200nm filter range
  - Now uses all pilots list instead of filtered aircraft states
- Fixed pushback detection being too restrictive
  - Aircraft moving sideways or backward now correctly detected regardless of speed
- Fixed aircraft orientation interpolation causing delayed pitch/roll response
  - Now uses smoothstep instead of smootherstep for more responsive transitions
- Fixed ground detection relying only on groundspeed
  - Now also considers altitude above ground (below 10m = on ground)
  - Fixes edge cases during takeoff roll and landing
- Fixed certain data not loading when the remote server functionality wasn't active

## [0.0.16-alpha] - 2025-12-27

### Added
- Collapsible settings sections
  - Each section in the Settings panel can now be expanded/collapsed
  - All sections collapsed by default for a cleaner overview of each tab
  - Click section header to expand and see the settings within
- Night-time imagery darkening
  - Satellite imagery automatically darkens at night based on sun position
  - Smooth transitions through civil, nautical, and astronomical twilight
  - Adjustable darkening intensity (0-100%) in Settings > Graphics > Lighting
  - Works in both real-time and fixed time modes
  - Babylon.js overlay lighting also dims for consistent weather appearance
- Back to Menu button in the control bar (arrow icon, next to Settings)
  - Returns to the airport selection screen with a confirmation prompt
  - Your camera position and settings for the current airport are saved automatically
- Controls are now disabled when no airport is selected
  - Reset View, Toggle 3D/2D, Set Default, To Default, Bookmarks, and Add Inset are disabled
  - Camera info shows "--" instead of values when no reference point exists
  - Keyboard shortcuts (T, r, R, Home) also respect these conditions
- Datablock font size setting in Settings > Display > Aircraft Display
  - Adjust font size from 8px to 20px (default: 12px)
  - Larger sizes are easier to read but may overlap more
- Datablock repositioning now works by clicking on the datablock label itself
  - Previously only clicking near the aircraft worked
  - Now you can press a direction key (1-9) and click directly on the datablock text
- Remote browser access (optional)
  - Access TowerCab from iPad or any browser on your local network
  - HTTP server can be started on port 8765 via the desktop app settings
  - All mods, models, and settings served from the host PC
  - Camera bookmarks and datablock positions now shared across all connected devices
- Touch controls for iPad Safari and mobile browsers
  - Single-finger drag rotates camera (3D/Tower mode) or pans map (top-down mode)
  - Two-finger pinch zooms in/out
  - Two-finger rotate twists the heading
  - Virtual joystick for WASD movement on touch devices
- Joystick Sensitivity setting in Settings > General > Camera
  - Controls virtual joystick movement speed on touch devices
  - Range 1-10, default 5
- Device optimization presets for touch devices
  - On first load, touch devices are prompted to apply optimized graphics settings
  - iPad/tablet preset reduces shadows, MSAA, and tile cache for smoother performance
  - Desktop preset keeps full quality settings
- Remote mode UI indicators
  - "Connected to [host]" badge shows connection status when accessing remotely
  - Reconnect button if connection is lost
  - FSLTL conversion panel shows read-only notice (conversion requires desktop app)
  - Update notifications hidden in remote mode (updates handled on host)
- Built-in Model Tint setting in Graphics options
  - Choose from White (original), Light Blue, Tan, Yellow, Orange, or Light Gray
  - Colored tints help built-in (FR24) aircraft stand out against satellite imagery
  - Default: Light Blue for better terrain contrast
- Aircraft Outlines option in Graphics settings (disabled by default)
  - Adds black edge outlines to built-in models using Cesium silhouette post-processing
  - High GPU cost (~20%) - use tint color instead for better performance
- App now ships with tower cab camera position defaults based on vNAS and FAA data
- Press Enter in airport picker to select the top result without tabbing
- Default datablock direction setting in Settings > Aircraft
  - Choose the default position (1-9 numpad style) for datablocks on new airports
  - Press 5+Enter to reset all datablocks to this default
  - Press 5+click on an aircraft to reset just that aircraft's datablock to the default
- Resizable aircraft panel
  - Drag the left edge to adjust width (180-500px)
  - Drag the bottom edge to adjust height (200-1200px)
  - Drag the corner to resize both dimensions
  - Touch-friendly handles with larger hit areas on tablets
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
- Model brightness and tint settings moved out of Shadows section in Advanced Graphics
  - Now always accessible even with shadows disabled
- Tower positions now stored as individual files per airport (`mods/tower-positions/KJFK.json`) instead of single `tower-positions.json`
  - Easier to share and accept contributions for specific airports
  - Legacy single-file format still supported for backward compatibility
- Default camera pitch changed from -15° to -10° for a more level view

### Fixed
- Fixed datablocks and leader lines stretching when resizing the window horizontally
- Fixed FSLTL models not matching when airline+type combination exists but VMR rule is missing
- Fixed aircraft with invalid/unknown type codes (e.g., A32N instead of A20N) now showing airline-specific livery instead of generic white B738
- Fixed tower positions not fully applying on first visit to an airport
  - 3D view now uses custom lat/lon/height from tower-positions
  - 2D view now uses custom center point and altitude from tower-positions
  - Previously only heading was applied; other settings required manual reset (Shift+Home)
- Fixed tower positions and mods not loading on app startup
- Fixed aircraft on takeoff roll showing no phase (yellow) instead of "Rolling"
  - Runway surface detection now works regardless of speed (V1/VR can exceed 150 kts)
- Fixed pushback aircraft incorrectly showing as "Taxi"
  - Lowered track-heading threshold from 120° to 90° to catch curved pushbacks
  - Fixed track calculation for very slow movement (was defaulting to heading)
- Fixed click-to-look not adjusting camera pitch to center the aircraft
  - Clicking on an aircraft in the panel now tilts the camera up/down to point at the aircraft
  - Previously only heading was adjusted; pitch stayed unchanged

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
  - None: hides labels entirely, showing only aircraft models
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
- Aircraft rendering now uses type-specific 3D models instead of a generic fallback model
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