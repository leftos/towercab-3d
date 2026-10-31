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
                └─ Rain, snow and lightning (clouds and METAR fog are the Cesium weather stage's)

Note: AircraftPanel uses useAircraftFiltering for 1Hz UI updates
```

**Ground contact and gear.** vNAS observations carry the simulator's height above ground (`heightAboveGround`, metres, 1 Hz; built in `vnasStore.ts`, carried to remote browsers by the observation messages). `aircraftTimelineStore.ts` interpolates it to the displayed instant, between the two samples bracketing it, so after a parked silence the height is interpolated across the whole gap, from the held sample to the first one after it. `useAircraftInterpolation.ts` turns it into `inContact` per frame.

vNAS reports the height of a reference point, not of the wheels, so an aircraft standing still reads a steady height, its resting height R, which varies by type and by simulator: `utils/aircraft/restingHeight.ts` learns R per aircraft (by normalized callsign) and per normalized aircraft type, each as the median of the last 9 vNAS samples of a fixed-wing type (a rotorcraft never learns one) under 5 kt and from -3 to 16 ft, or to 25 ft for a very tall type (`VERY_TALL_TYPES`: MD11, B744, B748, A388, A124, C5M; `RESTING_HEIGHT_MAX_TALL_SAMPLE_METERS`), 3 samples to learn. An aircraft's R is its own, else its type's until it has learned its own (`restingHeightSourceFor` says which; `restingHeightFor` returns the value, which the parked test and the flare take as it is).

The type table is kept for the session; an aircraft's own R is forgotten (`forgetCallsign`) when the store removes the aircraft, when the timelines are cleared, and when a source's named type changes from one real type to another (`isRestingTypeChange`: a case or whitespace difference, a placeholder, or a type named for the first time is no change).

The store remembers the last real type each source named (`reportedTypesByCallsign`; `namesType` skips missing and placeholder types, so a placeholder or null type keeps a source's remembered type and does not prevent a later forget).

Each source is compared with its own last type only. A new vNAS type (a simulator swap) always forgets. A VATSIM or RealTraffic type (a flight-plan refile) never forgets the R of an aircraft vNAS has named, and for an aircraft vNAS never named it forgets only when the same source names a new type, so alternating VATSIM and RealTraffic types forget nothing.

Every removal path, including dropping a source's last observations when the vNAS feed is dropped (hub disconnect, `dropSourceObservations`), forgets the aircraft's own R and its remembered types (`forgetAircraftRest`).

The aircraft's type, which picks the drawn model, the datablock type and the resting-height key, is the last type vNAS named, until vNAS names another type or the aircraft is removed.

The VATSIM or RealTraffic flight-plan type is drawn only for an aircraft vNAS has never named, so a parked aircraft does not flip after vNAS goes quiet. Insets and remote browsers receive, on the single vNAS path, the type vNAS sent rather than the drawn type.

Contact and the drawn height take its own R, or its type's R only once confirmed: two consecutive samples of the aircraft's own sit within 1 ft of the type's R and no more than 0.5 ft apart (`TYPE_REST_CONFIRM_MAX_OFFSET_METERS`, `TYPE_REST_CONFIRM_MAX_STEP_METERS`; `typeRestConfirmed` in `useAircraftInterpolation.ts`, over `TimelineInterpolationResult.lastTwoHeights`, which the store fills with `lastTwoHeightsEndingAt` for aircraft without an own R). The confirmation is per callsign, type and height: it clears on a null height, a seek of more than 2 s, a playback mode change, removal, a type change, or the type's R moving more than 1 ft from the confirmed value. Until then nothing is taken off the drawn height and lane B decides contact; the flare still uses the type's R before confirmation. An arrival whose only R is its type's enters contact about 0.2 s after touchdown, when its first two samples at rest confirm it.

Once contact has an R (own or confirmed type), it is entered within 3 ft over R and left above 5 ft over R, and lane B's memory ends.

With neither, lane B decides (`DROP_CONTACT_*` in `constants/aircraft-timeline.ts`; `laneBContact` in `useAircraftInterpolation.ts`; tests in `tests/motion/laneB.test.ts`). Entry needs a run of at least 3 vNAS height samples (`DROP_CONTACT_SETTLE_MIN_SAMPLES`) spanning at least 2.5 s (`DROP_CONTACT_SETTLE_SPAN_MS`) and ending at the bracket's `after` sample, that moves 3 ft or less, at or below 16 ft, after a descent; the descent memory flips at a 3 ft move, and an aircraft first seen counts as after a descent. The store computes the run (`settleRunEndingAt`, delivered as `TimelineInterpolationResult.settleRun`) only for aircraft with no own R. The entry cap of 16 ft stays for every type.

On entry the aircraft gets a provisional resting height (R-hat), the second-lowest sample of the run, which follows the height down while in contact. Contact is left above R-hat + 5 ft and re-entered below R-hat + 3 ft, with no rate exit, so a bounce under 5 ft stays in contact. Out of contact the aircraft is drawn R-hat lower, a share that fades linearly from all of it at 25 ft raw to none at 100 ft (`DROP_CONTACT_REST_DROP_HEIGHT_METERS`), where R-hat is dropped. A discrete change of what is taken off (an R learned, R-hat taken or dropped, a switch to a source without height) eases over 0.25 s (`RESTING_HEIGHT_EASE_MS`) from what the old R took off on that frame, so a change between 25 and 100 ft does not jump the drawn height; the ease runs on accumulated forward frame time (a step back holds it), and a change of share regime starts it even when the value is unchanged.

The rule's per-aircraft memory (`sharedLaneBStateRef`) restarts as at first sight when the display time steps more than 2 s either way (`DROP_CONTACT_SEEK_MS`, e.g. a seek or a paused frame loop; the same step, less any part a change of the anchor's offset explains, also clears the contact hold below, with or without a learned R) and on any switch into or out of replay or imported mode; the drawn resting offset (`sharedRestOffsetStateRef`) restarts with it, so an aircraft with no learned R is drawn at its raw height at once rather than easing a stale offset out. While an aircraft has no R, or only an unconfirmed type R, a change of contact eases the drawn height by a smoothstep over 1 s of elapsed display time (`DROP_CONTACT_EASE_MS`, `transitionProgress`); with an own or confirmed type R it eases by a fixed step per frame. `updateContact` is exported for tests.

Contact hold (`contactHoldAt`, `startsHold`, `heldOrRuledContact`, `startsInContact` in `useAircraftInterpolation.ts`, for an aircraft with a height, learned R or not): when an aircraft in contact first has its height go over the contact exit height, it stays in contact if the bracket's earlier sample is a still vNAS sample and the bracket moved under 500 m (`CONTACT_HOLD_MAX_ARM_STEP_M`; `TimelineInterpolationResult.bracketStartStopped`, `bracketStartsStopped` in `aircraftTimelineStore.ts`). A sample is still when its last step and the 3 s before it are under `STOPPED_SPEED_KTS`, or when its step from the previous vNAS sample is under that speed over any gap and that sample was still, so stillness carries across a vNAS silence. A burst of high vNAS heights (a simulator reposition or reload) then does not lift a parked aircraft, unless VATSIM reports during a long silence put the burst behind a lerped bracket (TC3D-390). A single repeated position on a takeoff roll follows a moving sample, so it never arms the hold. A display-time move that the anchor sample's change of `observedAt - receivedAt` explains (`displayAnchorOffsetMs`, when the drawn list switches source) is not a seek and carries the hold. After a null height, an aircraft that was in contact at its last height and comes back on a stopped bracket start resumes in contact. It leaves contact once its height has stayed over the exit for 5 s of display time (`CONTACT_HOLD_MS`), then eases up as usual; a height back under the exit ends the hold. While held, lane B's memory is frozen but for its frame time, so the burst neither drops nor sets a provisional resting height.

A rotorcraft type (`isRotorcraftType`, the generated `constants/rotorcraftTypes.ts`) is never held. A seek, a null height, a playback mode change and removal clear the hold. `tests/motion/contactHold.test.ts` covers it.

In contact the aircraft sits on the sampled terrain; airborne it is drawn at the reported height. Lane C draws a vNAS aircraft R lower whenever it has an own or confirmed type R, on the ground and in the air, easing in over 0.25 s (`RESTING_HEIGHT_EASE_MS`) when R is first learned. `InterpolatedAircraftState.reportedAltitude` (also on the shared-worker DTO) keeps the source's altitude, which datablocks and the Aircraft panel show; `interpolatedAltitude` is the drawn height.

The vNAS 50/80 ft `onGround` flag stays on the observation for labels only: a vNAS observation without a height (old replays, the brief mixed VATSIM/vNAS window) gives no drawing ground flag (`drawingGroundFlag`), so the landing and departure blends apply. A source without a height takes `inContact` from the drawn result of those blends.

**Stopped vNAS aircraft.** vNAS sends nothing for an aircraft that stands still, so `aircraftTimelineStore.ts` treats the silence after a stopped vNAS sample as parking (`isStoppedVnasSample`). A sample is stopped when the aircraft is on the ground (height above ground at most 5 ft over the aircraft's resting height, the contact exit height, or at most 5 ft raw while it has none; a sample without a height is never held) and its last step is under `STOPPED_SPEED_KTS` (2 kt), and either the step before it or its speed over `VNAS_STOP_WINDOW_MS` (3 s) is too. Speeds are measured between vNAS samples, never taken from the reported groundspeed. The newest observation, if stopped, is held through the silence: no extrapolation, groundspeed 0, no ground track, vertical rate 0. A receive interval counts toward the display-delay statistics (`calculateObservationIntervals`, `carriesCadence`) only when both its samples are from one source, it is at most `VNAS_PREFERENCE_THRESHOLD_MS` (30 s), and it is at most `CADENCE_ANY_MOTION_MAX_MS` (3 s) or the aircraft moved across it: at least `STOPPED_SPEED_KTS` (2 kt) for vNAS and the other sources, `VATSIM_MOVING_MIN_SPEED_KTS` (5 kt) for two VATSIM reports, measured from the two positions and never from a reported groundspeed. An interval between two sources never counts, and the statistics do not depend on the aircraft's type or height. So a line-up wait, a stop the stop test misses, a keyboard stop, a crawl, a hold-short or stale VATSIM reports of a parked aircraft neither raise the delay toward its cap nor play the takeoff roll fast. With no interval counting, the target delay stays at its last value, or at the source delay from first sight. The restart needs no special case: reconciliation moves the aircraft from the held spot to the first moving sample. After 30 s of vNAS silence the timeline falls back to the mixed VATSIM list. Moving vNAS aircraft that go quiet and all VATSIM and RealTraffic aircraft still extrapolate. `tests/motion/` covers it (`vnasSilence`).

`useAircraftModels.ts` feeds `inContact` and the data-source time to `updateGearAnimation` (`utils/gearAnimationController.ts`; inputs typed in `types/gear.ts`). In contact the gear is down. After contact ends, the gear retracts on positive climb once the aircraft has been out of contact 2 s of data time, over 8 s with an ease-out; that retract fires once per contact, after which the gear holds and extends only when descending below 2000 ft. The 150 ft climb rule takes over once the aircraft passes 150 ft out of contact or after a backward seek in replay. An aircraft not in contact since it was drawn (an airborne spawn, a go-around without touchdown) uses the 150 ft rule. `tests/motion/` covers it (`contact`, `gearRule`, `heightAboveGround`, `heightlessVnas`, `restingHeight`).

Right after the gear, `useAircraftModels.ts` feeds `updateSurfaceAnimation` (`utils/surfaceAnimationController.ts`) and applies the pose with `applySurfaceAnimation` (`gearAnimationController.ts`), for FSLTL/AIG models only. The controller runs on the data-source time of the frame (`aircraft.timestamp`), so a paused replay stops the wheels and holds a reverser mid-travel; the gear's own transition stays on the wall clock.

`surfaceFrameFor` builds the controller's frame from the aircraft state alone (its data time, `isReplay` and contact inputs), so the replay flag always matches the frame's data. A source with a height above ground (vNAS) uses the shared `inContact`. A source without one (VATSIM, RealTraffic) is in contact when the shared contact holds and either the blend weight did not come from the landing blend (`InterpolatedAircraftState.groundBlendDescending` false: the departure blend or the ground cases) or it is at or above `SURFACE_HEIGHTLESS_CONTACT_BLEND_WEIGHT` (0.99). The landing case needs the stricter weight because the shared contact passes about 30 m up on a landing; the other cases do not, because on the rollout and taxi the weight falls below 0.99 whenever the reported altitude sits more than about 5 m above the sampled terrain. The rule keeps no state between frames, so first sight and a seek onto a rollout or taxi keep contact. The gear keeps the shared contact.

Spoilers deploy at a touchdown above 60 kt (`SURFACE_DEPLOY_MIN_GROUNDSPEED_KTS`) on every landing and stay out through the rollout. Reversers deploy 1.5 s after touchdown while the aircraft is above 60 kt and decelerating, and latch out until the rollout ends. Deceleration is the groundspeed change over a window of at least 0.5 s of data time (`SURFACE_DECELERATION_WINDOW_SECONDS`) measured by the controller itself, so it holds at low frame rates and in fast replay.

The rollout ends at 60 kt or when the groundspeed rises 10 kt above its minimum since touchdown (a touch-and-go). A touchdown is a contact after at least 2 s out of contact, so a contact flicker is not a second one. Wheels spin at groundspeed over a radius set by the type's wingspan (`wheelRadiusForWingspan`), backwards in a pushback, and coast linearly to zero over 5 s after liftoff. The pushback rule (`isPushingBack`, `utils/aircraft/pushback.ts`) is shared with the phase detector.

A seek snaps the spoilers and reversers to their targets and keeps the wheel phase. A step back in data time is a seek; so is a step forward of more than 5 s (`SURFACE_SEEK_SECONDS`) in replay, and a switch between replay and live; live, a longer forward gap just continues.

After a seek, or on first sight, an aircraft in contact deploys nothing for that rollout; one first seen out of contact is armed, so its next contact is a touchdown. `tests/motion/` covers it (`surfaceRule`, `surfaceScenario`, `surfaceClips`, `surfaceClipPlayback`).

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
         │      └─ Applies fog density to Cesium scene (tuned from METAR visibility only while the stage draws no fog; otherwise held at Cesium's clear-weather values so terrain is not fogged twice)
         │
         ├──→ useCesiumWeatherStages
         │      └─ Post-process stage drawing clouds and fog against scene depth at the Low/Medium/High quality preset (also in insets, which pick a preset by size; nothing in top-down, nor in a view with no logarithmic depth buffer, which shows only the globe's distance fog)
         │
         └──→ useBabylonOverlay
                ├─ Rain, snow and lightning
                └─ Datablock weather visibility culling (always on)
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
    ├─ 3. useCesiumLighting(viewer, lightingSettings)
    │      ├─ Configures sun position and lighting
    │      ├─ Sets up shadow maps (size, distance, darkness)
    │      └─ Updates runtime when settings change
    │
    ├─ 4. useCesiumWeatherStages(viewer, { airportIcao, refLat, refLon, viewMode, isInset }), returning its gates
    │      ├─ Adds the cloud and fog post-process stage (GLSL in hooks/weather/cloudStage.glsl.ts; pure helpers in utils/weatherStage.ts), kept after the silhouette stage so aircraft in cloud get no outline
    │      ├─ Knobs come from a quality preset (WEATHER_STAGE_PRESETS in constants/weather.ts, resolved by weatherStageQuality): the `weather.stageQuality` setting in the main view, `insetStageQuality` in an inset (its area against the main window's: at least 50% the main preset, at least 15% one step down, else Low; re-read 300 ms after a resize stops). A preset change rebuilds the stage only when resolutionScale changes, since Cesium reads textureScale at creation; steps, radius and the look knobs are read live
    │      ├─ At High the cloud deck reaches 100 km (the preset's radius; Medium 60 km, Low 40 km) and curves down with the earth (d²/2R); layers are marched by base height relative to the camera on that curved datum, not by ray slope; undersides use the fog grey so the deck meets the distant haze; tops stay flat; a layer under a BKN or OVC layer (`layerSunShade`, `u_layerShade`) gets no direct sun on its tops, which light to the underside grey; CLOUD_STAGE_MAX_STEPS caps the shader's MAX_STEPS and the u_steps clamp; utils/cloudDeckGeometry.ts mirrors the shader geometry for tests
    │      ├─ Fog density fades in linearly between 10 and 8 SM of visibility (`stageFogFade`); a change of the visibility input, METAR or interpolated, eases the drawn density over 6 s with smoothstep (`nextFogEase`, `easedFogDensity`, stepped in the stage's `preRender`), while a visibilityScale, fog toggle or top-down/3-D change applies at once
    │      ├─ Split in one file into useWeatherAnchor, useWeatherStageFrame and useWeatherStageComposite
    │      ├─ Reads showWeatherEffects, showClouds, showBabylonFog, stageQuality, visibilityScale, fogIntensity (scales the fog's optical depth), weatherStore.useInterpolation / interpolatedWeather.visibility; disabled when there is nothing to draw (no layers, no fog, no anchor frame)
    │      ├─ Reads the live scene.logarithmicDepthBuffer, not graphics.enableLogDepth: without it the stage is hidden, one warning is logged and the view shows only the globe's distance fog, with no clouds or METAR fog
    │      ├─ Cloud frame anchored on the airport (re-anchors past 100 m within it), or on the followed aircraft every 5 km in orbit-follow; terrain is resampled when the provider changes and retried each second on failure; ground changes between samples slide over 5 s; cloud noise is world-stable (origin resets past 50 km)
    │      └─ useWeatherStageDriveAids runs after useCesiumCamera (dev camera and test-aircraft aids)
    │
    ├─ 4b. useCesiumWeather(viewer, showWeatherEffects, showCesiumFog, fogDensity, stageDrawsFog)
    │      ├─ Runs after the stage hook and takes its stageDrawsFog (its `gates.fog` with an anchor frame); scene.fog.enabled follows showWeatherEffects && showCesiumFog
    │      ├─ Stage draws fog: scene.fog held at Cesium's clear-weather values (density 0.0006, visualDensityScalar 0.15, screenSpaceErrorFactor 2.0, minimumBrightness 0.03)
    │      └─ Stage draws no fog (Babylon overlay draws the weather, or no log depth): applies fog density from METAR visibility, with the visual density scalar and screen space error adjusted (pure helper sceneFogValues in utils/weatherStage.ts)
    │
    ├─ 4c. useTowerModel(viewer, { sunElevation, nightDarkeningEnabled, nightDarkeningIntensity }), returning a getter for the dev harness' `towerModel`
    │      ├─ Draws the tower mod's cab as a Cesium model, so it writes scene depth (the weather stage's clouds and fog stop at it) and casts and receives Cesium shadows; insets mount it but draw no cab, since inset windows never load mods
    │      ├─ Placement from modService.getTowerPlacement; base on resolveGroundHeight (utils/towerHeight.ts: terrain sample, globe tile, else field elevation), re-placed on terrainProviderChanged; orientation through utils/modelOrientation.ts (shared with aircraft)
    │      ├─ Darkens at night with the imagery: light colour and image-based lighting scale by cabNightFactor from the curve in utils/nightBrightness.ts, shared with useCesiumNightDarkening
    │      └─ While the positioning wizard's model step is open for the airport, its offsets rewrite the model matrix without reloading the glTF
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
├─ subscribeToFacility(icao): the only subscribe (additive, no replace variant). Concurrent callers for one facility share one in-flight promise (`inFlightSubscribes`), so airport load, session restore and the auto-subscribe effect send one hub subscribe
├─ handleSessionEnded(): clears the in-flight map, the per-aircraft maps, the facility lists and the session's vNAS timeline observations
└─ Used by:
     ├─ VnasService (session management)
     ├─ useVnasEvents (Tauri event listeners; each state goes through followSessionState, which calls handleSessionEnded at every state that ends the session in progress: disconnected, waitingForSession and subscribing; it also mirrors the host's `vnas-subscriptions-changed` list)
     └─ TopBar (connection status)

vNAS backend (src-tauri/src/vnas.rs, `vnas` feature)
├─ Subscribe claims: `try_begin_subscribe` hands out a token per facility, `finish_subscribe` releases only the claim that still owns it, so a subscribe from an ended session cannot clear a newer one's claim
├─ One event forwarder per `vnas_connect`, started before the connect so no event is missed; a reconnect aborts and awaits the previous forwarder before the new receiver subscribes, so no event is emitted twice. The forwarder owns every status write after a successful connect. Each connect fences older writers: `begin_connect` checks the active-session guard, writes `Connecting` and bumps a connect epoch under the status lock, and that connect's later writes and its forwarder's carry the epoch (`if_epoch`), so a losing concurrent connect or a forwarder outliving a disconnect writes nothing (a disconnect's reset bumps the epoch too). When the receiver lags, the forwarder applies the events it still holds, then re-syncs once inline from the crate's current `state()` and `joined_session()` (`resync_action`): the session token decides same session or new, a new one is a dropping change that stores the crate's session, the same session never moves backwards (only `Connected` not yet reached is written), and a crate forced-end reason is shown once. A bare `SessionStateChanged(Subscribing)` (a join announces itself with `SessionJoined`) logs a warning. A failed connect before the install writes `Disconnected` with its error from the connect's own result
├─ The joined session's airports are cached in the host, so remote browsers may subscribe only to them: every session change clears the remote allowed list, and a session's airports are cached only while its token is the host's joined session
├─ Status is written by read-modify-write under one lock (`update_status`); a `Disconnected`, `WaitingForSession` or `Subscribing` state (the hub drops a connection's subscriptions when its session changes) drops every subscription, in-flight claim and the stored session token and kind that `subscribe_towercab` names. The join step (`VnasEvent::SessionJoined`) stores the token and kind with `Subscribing`, so a subscribe uses the stored token with no Data API lookup (`joined_session_token` reads `joined_session()` only when none is stored). A CRC join subscribes at once and its airports are filled in later from the Data API (`remember_session`, `sessionFacilities` in `vnasStore`); a room join awaits them, since its airports need no lookup
├─ `VnasStatus.lastSessionEnd` (`{ reason, forcible }`) records a server-ended session: a non-forcible end (a YAAT room closing) clears when the next session is joined, a forcible one (a kick) at the next connect, and a kick's reason is also shown as the status error. A subscribe that fails with a stale session (token forgotten) or with no connection (a kick tore it down) is ignored, so it never overwrites that reason (`settle_subscribe_failure`)
├─ On a session change the host emits `vnas-state-changed` first, then the cleared `vnas-subscriptions-changed` list (`session_change_events`), so the frontend has dropped the old session's airports and holds its subscribes (`canSubscribe`, until the joined session is followed) before the cleared list re-runs the subscribe effects. A `vnas_get_status` snapshot never overwrites the frontend's state, except when the frontend is still `disconnected` and the host reports a live session (a webview reload): it adopts the host's state and resubscribes the airport in view
└─ Session end (server `HandleSessionEnded` or user disconnect) reaches the frontend as the disconnected state, or as waitingForSession when the connection stays (a YAAT room ending), or as subscribing when a room switch joins the next session at once; the crate has already torn the session down (see the crate's docs/ARCHITECTURE.md "Session teardown")

aircraftTimelineStore
├─ isOpen: boolean
├─ selectedCallsign: string | null
├─ snapshots: AircraftSnapshot[]
├─ dropSourceObservations(source, callsigns?): live playback only. An aircraft the latest VATSIM pilot list still reports (VATSIM polling, list younger than AIRCRAFT_TIMEOUT in constants/aircraft-timeline.ts) keeps its timeline, seeded with a VATSIM observation from that list (`pilotToTimelineEntry` in vatsimStore); otherwise a timeline left empty is removed like removeAircraft, and one holding other sources keeps them
└─ Used by:
     ├─ vnasStore (handleSessionEnded drops 'vnas' for all timelines; removeAircraft on a hub disconnect drops it for one)
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
     └─ AircraftPanel (smart sort via calculateSmartSort, which runs detectFlightPhase; runway badges)
```

Flight phase detection (`utils/aircraft/flightPhaseDetector.ts` raw phase, `phaseStabilization.ts` dwell and sticky exits) runs on the aircraft's displayed time (`InterpolatedAircraftState.displayTime`), not the wall clock, so a label follows the drawn aircraft live and in replay. The phase clock holds through the small backward steps of live display time; a step back larger than `DISPLAY_TIME_REGRESSION_TOLERANCE_MS` (a replay scrubbed back) drops the aircraft's phase state and history. Touchdown over the runway after an approach is read from the source: vNAS ground contact (`inContact`, when it reports a height above ground), the ground flag (RealTraffic), or for VATSIM a height above the field under `TOUCHDOWN_AGL_FT`, or level flight under `LEVEL_TOUCHDOWN_MAX_AGL_FT`. Until then the aircraft reads Short Final; after it, Roll Out. An aligned aircraft below `ROLL_MIN_SPEED_KTS` reads Lined Up, and a confirmed landing roll keeps Roll Out at any speed until the aircraft turns off or taxis.

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
    │    ├─ Renders weather effects (rain, snow, lightning)
    │    └─ Renders measuring tool lines
    │
    └─ performanceMonitor.endFrame()
```

### Environment-Map Lighting

Cesium lights OSM buildings and aircraft models from a dynamic environment map whose ground hemisphere defaults to an olive. TowerCab 3D passes a neutral grey instead, as `environmentMapOptions` at creation (setting `groundColor` afterwards does not rebuild a computed map). The colour is `ENVIRONMENT_MAP_GROUND_COLOR` in `constants/lighting.ts`, wrapped by `neutralEnvironmentMapOptions()` in `utils/environmentMap.ts`. Creation sites: `createOsmBuildingsAsync` in `CesiumViewer.tsx`, `Model.fromGltfAsync` in `useCesiumViewer.ts`, `useAircraftModels.ts` and `useTowerModel.ts`, and `ModelPreviewModal.tsx`. A new tileset or model creation site must pass the same options.

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
│   ├─ SettingsHelpTab
│   │   └─ Keyboard shortcuts reference
│   └─ SettingsAboutTab (last tab)
│       ├─ App version
│       └─ Map data credits (utils/mapCredits.ts)
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
         ├─ SettingsModal.tsx (314 LOC - tab container)
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
         ├─ SettingsAboutTab.tsx (99 LOC)
         │    ├─ App version
         │    └─ Map data credits: Cesium ion logo, © OpenStreetMap contributors, and the credits Cesium collected for the terrain and imagery in use when the tab opened (read once through utils/mapCredits.ts; the main viewer registers its CreditDisplay with setMapCreditSource in useCesiumViewer.ts)
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
    ├─ 2. isVisibleByWeather() (a callback inside useBabylonOverlay, no hook of its own)
    │      └─ Label culling, delegating to isVisibleThroughWeather() in utils/weatherVisibility.ts (shared with useAircraftFiltering)
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
    └─ 5. useBabylonCameraSync({ cesiumViewer, camera, getFixedToEnu })
           ├─ Reads Cesium camera position/rotation/FOV
           ├─ Converts ECEF → ENU using fixedToEnu matrix
           ├─ Extracts Euler angles from direction/up vectors
           ├─ Updates Babylon camera position/rotation/FOV
           └─ Handles both 3D perspective and top-down modes
```

### Hook Call Order (Critical!)

```typescript
// Correct order - each hook depends on previous ones
const { engine, scene, camera, guiTexture, sceneReady } = useBabylonScene({ canvas })
const { updateLabel, updateLabelPosition, removeLabel } = useBabylonLabels({ guiTexture })
const { setupRootNode } = useBabylonRootNode({ scene, cesiumViewer })
const { syncCamera } = useBabylonCameraSync({ cesiumViewer, camera, getFixedToEnu })

// WRONG - camera sync before scene initialization
const { syncCamera } = useBabylonCameraSync({ cesiumViewer, camera, getFixedToEnu })  // ❌ camera is null!
const { camera } = useBabylonScene({ canvas })
```

### Benefits of Decomposition

**For LLM Agents:**
- 70% reduction in file size (889 → 265 LOC for orchestrator)
- Clear hook boundaries with single responsibilities
- Easier to locate specific functionality (search for "label" → useBabylonLabels)
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
│   │   ├─ SettingsModal.tsx (314 LOC, tabbed modal container)
│   │   ├─ SettingsGeneralTab.tsx (203 LOC)
│   │   ├─ SettingsDisplayTab.tsx (209 LOC)
│   │   ├─ SettingsGraphicsTab.tsx (18 LOC, delegates to settings/ components)
│   │   ├─ SettingsPerformanceTab.tsx (180 LOC)
│   │   ├─ SettingsHelpTab.tsx (130 LOC)
│   │   ├─ SettingsAboutTab.tsx (99 LOC, version and map data credits)
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
│   ├─ weatherStageStore.ts (dev-only drive aids of the cloud and fog stage, not persisted)
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
