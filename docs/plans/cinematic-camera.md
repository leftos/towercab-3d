# Cinematic camera

Status: design agreed, not started. Linear project `Cinematic camera`, queued after `On-plane cameras` (`on-plane-cameras.md`). A director that picks aircraft at the current airport and shots of them on its own, in the main view (a showcase or screensaver, with the UI hidden and a caption) or in an inset (keeping the most eventful aircraft in view while the user works the main view).

## Where it stands

- Flight phases come from `detectFlightPhase` (`utils/aircraft/flightPhaseDetector.ts:786`), stabilised by `phaseStabilization.ts`. The phases are in `utils/aircraft/types.ts:10-24`: `short_final`, `long_final`, `departure_roll`, `landing_roll`, `go_around`, `lined_up`, `holding_short`, `pattern`, `pushback`, `active_taxi`, `stopped_taxi`, `departing_climb`, `distant_arrival`, `unknown`. The result carries the runway end ident and the distance to its threshold.
- Detection runs only inside the aircraft panel: `calculateSmartSort` (`utils/smartSort.ts:108`), called from a `useMemo` on a 1 s tick (`AircraftPanel.tsx:157-161, 236`), for the filtered aircraft only. The result is not in any store.
- The detector and the stabiliser read `Date.now()` (`flightPhaseDetector.ts:64, 85`; `phaseStabilization.ts`). TC3D-65 (phase badge labels at the wrong times) moves the windows to display time, and TC3D-49 changes the same two files.
- `RunwayProximity` (`types.ts:63-72`) has `lateralOffsetFt` and `isInbound`, but `detectFlightPhase` does not return them. Runway ends have position, true heading and elevation (`types/airport.ts:13-48`). There is no taxiway centreline or hold-line data; airport surfaces are pavement polygons only.
- Interpolated states live in a module-level `Map` updated in place each frame (`useAircraftInterpolation.ts:42, 385`). Replay drives the same loop with virtual time (:393-451), so anything reading the map works under replay.
- Camera actions the director can drive exist per viewport in `viewportStore` (`followAircraft`, `followAircraftInOrbit`, `setFollowMode`, `setOrbitHeading`/`Pitch`/`Distance`, `setFov`, …). There is no fixed-world-point camera other than the tower's position offsets, and no pose blend: switching aircraft or follow mode snaps; only follow start and stop use a 0.5 s `flyTo` (`useCesiumCamera.ts:726-768, 896-935`).
- Ground height under a point: `globe.getHeight` (undefined until the tile loads), used by the camera clamps (`useCesiumCamera.ts:283-307`). Aircraft altitudes are ellipsoidal; runway elevations are MSL.
- Insets take camera state from the main app over `camera-update` (`InsetCesiumViewer.tsx:239-255`).

## Decisions

| Question | Decision |
|---|---|
| Purpose | Both: the director runs in the main view or in any inset. |
| Start and stop | `F` (for "film", unbound today) and a button (controls bar; an inset's header controls) toggle it. A per-device setting, `camera.cinematicIdleMinutes` (0 = off, the default), starts it in the main view after that long with no input. Any camera input hands control back and leaves the camera where it is. |
| Pacing | Event-driven. Aircraft are scored by phase; the director holds one aircraft through its event (a takeoff from roll to climb-out, a landing from short final to roll-out) within a minimum and a maximum shot length, and cuts early only when a higher-scoring event starts. |
| Range | The current airport: aircraft on its surface, or within about 10 nm on approach or departure. |
| Shots | Spotter shots, on-plane views, orbit follow with a slow heading drift, and the tower view. |
| Transitions | Mixed: a hard cut when the aircraft changes or the camera jumps far; a ~1.5 s eased blend when re-framing the same aircraft. |
| Main-view screen | Panels and controls bar hidden; a lower-third caption (callsign, type, route, phase label) for a few seconds after each cut. Datablocks follow the user's label settings. |
| Nothing happening | An orbit drift on the best taxiing or parked aircraft; with no aircraft at all, a slow pan from the tower. |

## Design

### Shared flight phases

Phase detection moves out of the panel into a service that runs at 1 Hz for the aircraft in the director's range and in the panel's list, and publishes `Map<callsign, PhaseDetectionResult>` to a small store. Smart sort reads the store. The result also returns `lateralOffsetFt`, `isInbound` and an along-track distance from the threshold, for spotter placement. The time the windows use comes from the aircraft data source (`getAircraftDataSource()`), so phases confirm at the right moment at 2× and 4× replay; TC3D-65 makes that change for display time, and this step adds a 4× replay test and removes any `Date.now()` that remains.

### Spotter mode

- `FollowMode` gains `'spotter'`, with `spotterPosition: { lat, lon, heightM }` (height above ground). The camera sits at that point and looks at the followed aircraft: the tower-follow look-at (`calculateTowerLookAt`, `cameraGeometry.ts:153`) from a different origin.
- Ground height comes from `globe.getHeight`. A point whose tile has not loaded is rejected and the planner picks another shot; it is never placed at height 0. Heights convert MSL ↔ ellipsoid through `GeoidService`, as the aircraft do.
- Spotter mode has no manual entry point; only the director sets it.

### Pose blend

`useCesiumCamera.ts` gains a generic blend: when a camera request carries `transition: 'blend'`, the last rendered pose is kept and the camera eases from it to the new target pose, recomputed each frame, over ~1.5 s with `easeInOutQuad` (`cameraGeometry.ts`). A cut sets the pose at once.

### Director core

Pure TypeScript in `services/cinematic/`, with no React and no Cesium, so the `tests/motion` sim harness can drive it:

- `scoreCandidates(states, phases, airport)`: in-range aircraft scored by phase. Departure roll and short final score highest, then line-up and landing roll, then climb-out, pushback and taxi; parked aircraft score lowest.
- An event state machine: the current aircraft and event, the shot's start time, the minimum and maximum shot lengths, and the margin a new event needs to interrupt.
- `planShot(event, aircraft, runways, heightAt)` returns a camera request `{ callsign, followMode, onboardView?, spotterPosition?, orbitDrift?, transition }` from a phase → shot table in `constants/cinematic.ts`:

| Phase | Shots, in preference order |
|---|---|
| `departure_roll` | spotter beside the runway ahead of the aircraft, belly, cockpit |
| `departing_climb` | chase, wing, spotter holding its roll position, tower |
| `long_final` | chase, cockpit, tower |
| `short_final` | spotter behind or beside the threshold under the approach, cockpit, wing |
| `landing_roll` | spotter beside the runway, belly, wing |
| `lined_up`, `holding_short` | orbit drift, wing, tower |
| `pushback`, `active_taxi` | spotter low beside the projected path, orbit drift, chase |
| anything else | orbit drift |

- Spotter placement: runway-side points sit about 150-250 m from the centreline, ahead of the aircraft along the runway, 2-10 m above ground; threshold points sit behind or beside the threshold under the extended centreline; taxi points sit about 60 m to the side of the path predicted from heading and groundspeed, 1.5 m above ground.

### Director runtime

- `useCinematicDirector` runs in the main app at about 2 Hz, makes the discrete decisions, and writes the target viewport's camera state through store actions; `useCesiumCamera` computes the poses each frame. Insets receive the state through the existing `camera-update` relay, so nothing new runs inside an iframe.
- `cinematicActive` is per viewport in `viewportStore`. `useCameraInput` and `useTouchInput` clear it on any camera input in that viewport.
- `window.__tc3d.cinematic`: `start(viewportId?)`, `stop()`, and `state()` returning the current aircraft, shot, reason and the top scores.

### Clean screen and caption

While the director runs in the main view, the panels and the controls bar hide and `CinematicCaption.tsx` (with its own CSS file, using the design tokens) shows the caption for a few seconds after each cut; the phase label comes from `getPhaseLabel` (`smartSort.ts`). Esc or any input stops the director and brings the UI back.

## Steps

1. TC3D-100. Shared flight-phase service: detection out of the panel into a store, smart sort reading it, runway-relative geometry returned, data-source time with a 4× replay test. Blocked by TC3D-49 and TC3D-65, which change the same files.
2. TC3D-101. Spotter camera mode and the pose blend: state, store, inset payloads, the `preRender` branch, the unloaded-tile rejection, the blend; geometry tests. Blocked by TC3D-99 (step 5 of `On-plane cameras`), which changes the same payloads.
3. TC3D-102. Director core: scoring, the event state machine, shot planning and `constants/cinematic.ts`. Sim tests: a synthetic departure is picked at roll start and held to climb-out; a landing that starts during a taxi shot interrupts it; the minimum shot length holds; spotter points lie at the planned offset from the centreline, ahead of the aircraft. Blocked by step 1.
4. TC3D-103. Director runtime: the `F` toggle and buttons, input hand-back, the idle start setting, insets, the agent handle. Blocked by steps 2 and 3.
5. TC3D-104. Clean screen and caption in the main view. Blocked by step 4.

Each step that a user can see lands with its `CHANGELOG.md` bullet, `USER_GUIDE.md` and cheatsheet rows. The Task Index row "feed a flight-phase or shot director" waits in a comment on TC3D-15; step 1 adds it to `docs/architecture.md` if the Task Index exists by then. The terms below wait in a comment on TC3D-16.

## Risks

- Phase calls on VATSIM's 15 s data are late and coarse, so the director can miss the start of a roll. It is at its best with vNAS or RealTraffic data.
- Spotter shots have no building data, so a camera can end up behind a hangar. Placement prefers points on open ground (on or near pavement), and the shot table always offers a non-spotter alternative.
- The director hides the UI in the main view; the way back (Esc, any input) has to be obvious. The caption's first showing names the key.

## Terms

- *Director*: the logic that picks the aircraft and the shot while the cinematic camera runs.
- *Event hold*: the director staying with one aircraft through its event (a takeoff, a landing) instead of cutting on a timer.
- *Spotter shot*: a ground-fixed camera the director places from runway geometry, which stays put and pans to track the aircraft; `followMode: 'spotter'` in code.
- *Orbit drift*: orbit follow with the orbit heading sweeping slowly.
