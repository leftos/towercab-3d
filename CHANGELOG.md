# Changelog

All notable changes to TowerCab 3D will be documented in this file.

## v0.0.2-alpha

### Added
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