# Aircraft Motion Review (TC3D-43)

How positions are interpolated and how that becomes visible motion: taxi, flight, control surfaces, flare and rotation, gear, and the flight-phase badge ("smart status") in the Nearby Aircraft panel. Every number marked *measured* comes from the scratch harness described under [Method](#method); numbers marked *computed* are arithmetic on code constants; everything else is code reading.

## Summary

| # | Area | Top finding | Severity | Fix size |
|---|------|-------------|----------|----------|
| 1 | Interpolation and source blending | The display-delay rate limit is bypassed because `lastUpdateTime` is only saved when the delay changes. A new VATSIM aircraft is drawn 575 m ahead, jumps 419 m back, then crawls at about 40 % speed for 12 s; a vNAS aircraft that stops and starts again jumps from 1.4 s to 11.2 s of delay at takeoff-roll start and plays the roll at 1.5x | visible bug | one-site (plus a design for vNAS gaps, D2) |
| 2 | Taxi | VATSIM taxi is straight chords between 15 s samples with heading lerped separately: a 90 deg turn cuts 17.5 m off the corner and the aircraft slides 55 deg sideways to its nose | unrealistic | multi-file |
| 3 | Airborne motion | `isOnGround` on the shared state is never updated after the first frame, so a vNAS-first departure stays glued to the runway through its whole climb (AGL error 1451 m, gear never retracts, no bank) | visible bug | one-site, but must land with 5's ground-contact redesign |
| 4 | Ailerons, elevators, rudder | No control surface is animated. Worse, every clip whose name contains `GEAR` is driven by gear progress, so nose-wheel steering clips sit at full lock: 88 deg on the A306, 69 deg on the E190, 44 deg on the B744, 64 deg on the MD11F | visible bug | one-site |
| 5 | Flare, touchdown, rotation | Arrivals are drawn on the runway early: 2.4 s (VATSIM) and 7.1 s (vNAS) before real touchdown, the vNAS ones nose-down (-2.9 deg) through the last 50 ft. Departures show no rotation before liftoff; VATSIM ones roll down the runway at +4.8 deg | visible bug | design |
| 6 | Gear | Gear AGL is ellipsoidal height minus MSL elevation, so the geoid offset moves the retract point: 0.4 s after liftoff at a +48 m geoid site, 7.8 s at a -32 m site (5.3 s with the right datum) | unrealistic | one-site |
| 7 | Smart status (phase badge) | "Go Around" is never shown: the sustained-approach flag is cleared the moment the aircraft leaves the approach phase. A FL350 overflight within 2 nm of a threshold is labelled "Short Final" | visible bug | one-site each |

### Suggested order of work

1. One-site fixes that change no design (each has a failing test to write first, TDD): 4.1 steering clips, 1.1 delay persistence, 1.2 per-source observation spacing, 7.1 go-around flag and 7.2 its unit error, 7.3 altitude gate on finals, 6.1 gear datum.
2. Ground-contact redesign (D1): fix 3.1 together with 5.1 and 5.2, because fixing 3.1 alone makes vNAS arrivals snap 50 ft to the runway.
3. vNAS silence for stationary aircraft (D2): 1.3, 1.4.
4. Orientation model: 3.2 coordinated-turn bank, 5.3 no AoA on the runway, 5.4 rotation, 5.5 flare from the flight path.
5. VATSIM path shape (D4): 2.1, 2.2, 1.5.
6. Animated parts beyond gear (D3), coordinated with E1 in [rendering-opportunities-design.md](./rendering-opportunities-design.md).

## Method

The measurements came from a scratch harness, since promoted to the regression suite `tests/motion/` (`sim.ts`, `harness.ts`, `motion.test.ts`, `spawn.test.ts`, `phase.test.ts`), where each finding a fix item owns is an `it.todo` that its fix turns into a red-first `it`. It drives the real code in node: `useAircraftInterpolation` (React mocked so its effects run, `requestAnimationFrame` stubbed, `Date` faked), `aircraftTimelineStore`, `smartSort`/`detectFlightPhase` at 1 Hz like `AircraftPanel.tsx:155-160`, and `gearAnimationController` called the way `useAircraftModels.ts:329-335,503-528` calls it. Terrain is flat and sampled with the same gate as `useGroundAircraftTerrain.ts:121-132`.

- `sim.ts` integrates three truth flights at 10 Hz: DEP1 (straight and curved pushback, two 90 deg taxi turns at 12 and 8 kt, line-up and 25 s hold, roll at 3.5 kt/s, liftoff at 150 kt, 2500 fpm climb, 3 deg/s climbing turn at 175-210 kt, level-off, 25 deg-bank cruise turn at 250 kt); ARR1 (2000 ft intercept, 3 deg glide at 140 kt with a 6 deg crosswind crab, exponential flare from 30 ft, de-crab, rollout at -4 kt/s, 90 deg exit, taxi-in); GA1 (same approach, go-around at 200 ft, 2000 fpm, 3 deg/s turn to downwind).
- `harness.ts` turns truth into a VATSIM feed (every 15 s, received 0.4-1.4 s later, no ground flag or track) and a vNAS feed (1 Hz, received 80 ms later, true track, the `vnasStore.ts:25-48` 50/80 ft ground hysteresis, and no samples while the aircraft stands still, as vNAS does).
- `motion.test.ts` runs three scenarios for 720 s: VATSIM only; vNAS+VATSIM with VATSIM seen first; vNAS+VATSIM with vNAS seen first. (The review also ran the second at 144 fps; the suite drops it.) Each frame is compared with truth at the frame's own `displayTime`, so the deliberate display delay is not counted as error. `spawn.test.ts` and `phase.test.ts` isolate single findings; the review's `anim_names.py` and `steer_keys.py` model-clip scans were not promoted. Rerun: `pwsh tools/gate.ps1 -Log .tmp/motion.log -TimeoutSeconds 300 -Slot light -- pnpm vitest run tests/motion`; with `MOTION_REPORT=1` the segment tables land in `.tmp/motion/report.txt` (the other variables are in `tests/motion/harness.ts`'s header).
- Site geoid: N = -32.0 m at the default site (37.72 N, 122.22 W), N = +48.2 m at EDDF (50.033 N, 8.570 E), both from `geoidService`.
- Not measured: RealTraffic (it supplies roll, vertical rate and a ground bit, none of which the harness feeds), sloped terrain, the Babylon label layer, and real network jitter on vNAS.

"Smart status" is taken to mean the phase badge in the Nearby Aircraft panel (`AircraftPanel.tsx:588-616`), produced by `calculateSmartSort` (`smartSort.ts:108-147`) through `detectFlightPhase` (`flightPhaseDetector.ts:786-805`) and `stabilizePhase` (`phaseStabilization.ts:475-582`), labels from `getPhaseLabel` (`smartSort.ts:152-170`). It also drives the "Smart" sort order.

## 1. Position interpolation and source blending

### How it works today

- Every source feeds `AircraftObservation`s into one timeline per callsign (`aircraftTimelineStore.ts:1254-1474`). VATSIM arrives in batches every 15 s with no track or ground flag (`vatsimStore.ts:166-182`); vNAS arrives at 1 Hz with true track and a 50/80 ft hysteresis ground flag (`vnasStore.ts:782-800`).
- When at least two vNAS samples are under 30 s old, interpolation uses vNAS only (`aircraftTimelineStore.ts:421-429`, `VNAS_PREFERENCE_THRESHOLD_MS`).
- Display time is anchored on the oldest observation: `displayTime = oldest.observedAt + (now - oldest.receivedAt) - delay` (`:739-740`). The delay is per aircraft: max of the last 5 receive intervals + 150 ms, clamped 150 ms-20 s (`:439-451`), moved toward its target at 500 ms/s either way (`:515-565`), plus a 200 ms bump while extrapolating.
- Between two observations, lat/lon are lerped linearly from a reconciliation start (the last rendered position) to the `after` sample (`:909-970`); altitude uses a linear/smoothstep blend weighted by how much the vertical rate changes between segments (`:978-1018`); heading is lerped separately between the two samples' headings (`:1168-1173`). Past the newest sample it extrapolates along `groundTrack ?? heading` for up to 30 s (`:311-342`, `:1076-1140`).
- The hook (`useAircraftInterpolation.ts:123-374`) rate-limits heading (6 deg/s air, 20 deg/s ground), derives vertical rate, turn rate and acceleration from frame-to-frame differences with a per-frame EMA (`RATE_SMOOTHING = 0.15`), then pitch and roll (area 3) and terrain blending (area 5).

### Findings

**1.1 The delay rate limit is bypassed after any steady period.** `getInterpolatedStates` writes the new `dynamicDelay` back only when `currentDelayMs` or the bump changed (`aircraftTimelineStore.ts:1698-1720`), so `lastUpdateTime` stays at the last change. When the target moves later, `applyDelayTransition` multiplies the whole stale interval by 500 ms/s (`:521`, `:548-553`) and the delay jumps in one frame.
- What a controller sees: a VATSIM aircraft appears, jumps back, then moves in slow motion. Measured (ARR1 at 140-160 kt, `spawn.txt`): first frame 575 m ahead of truth, next frame a 419 m backward jump, then 0.5 m/frame (30 m/s) against a true 72 m/s for 12 s while the delay ramps 9.4 s to 14.9 s. The same jump hits a vNAS aircraft that stopped and moved again (1.3).
- Fix: persist `lastUpdateTime` every frame (or make `applyDelayTransition` use the frame delta). One-site; test: two VATSIM observations 15 s apart, assert no frame-to-frame position step larger than speed x frame time.

**1.2 A VATSIM sample can delete a vNAS sample.** `MIN_OBSERVATION_INTERVAL` (100 ms) compares `receivedAt` against the last observation of any source (`:1272-1287`, `:1396-1408`). When a VATSIM batch arrives up to 100 ms before a vNAS packet and its `observedAt` is newer than the newest vNAS one (so it is inserted, `:1372-1386`), the vNAS packet is dropped; the vNAS-only list then has a 2 s hole, the display time runs past it, extrapolation adds its bump through 1.1, and the aircraft snaps back.
- Measured (`debug.txt`, GA1 on a 140 kt glide): the vNAS sample at 333.37 s is dropped, display time steps back 0.28 s and the aircraft 20 m (at 144 fps the backward snap is 22.6 m in one frame). In the harness every vNAS aircraft does it at the same instant; in the field the chance is about the 100 ms window over the 1 s vNAS period whenever the VATSIM sample is the newer one (unmeasured).
- Fix: apply the spacing check per source, and do not insert VATSIM samples into a timeline whose vNAS data is fresh (they are filtered out anyway). One-site.

**1.3 vNAS silence while stationary inflates the delay at every stop-and-go.** vNAS sends nothing for a parked aircraft, so the first interval after a hold equals the hold. The target delay becomes min(20 s, hold + 150 ms) and, through 1.1, is applied at once.
- Measured (DEP1, vNAS, 25 s line-up hold): delay 1.4 s, then 11.2 s at the first frame of the takeoff roll, falling at the 500 ms/s cap back to 1.1 s over about 20 s of wall time; meanwhile the roll is shown ~10 s late at 1.5x speed, so its acceleration looks 2.25x real. Same at the end of pushback (6.9 s). Moving frames with playback rate off by more than 10 %: 11.6 % for DEP1 under vNAS against 1.9 % under VATSIM only.
- Fix: see D2. Design.

**1.4 vNAS extrapolation creeps a stopped aircraft forward.** After the last vNAS sample (gs 0.4-2 kt as it stops) the timeline extrapolates at that speed for up to 30 s (`:1076-1081`, `MAX_EXTRAPOLATION_TIME`). Measured: up to 8.2 m drift on the line-up hold; the bracket `[last sample before the stop, first sample of the roll]` then interpolates position and groundspeed across the 21 s gap, which also feeds 7.4. Fix with D2.

**1.5 VATSIM climbs and descents begin up to one sample early.** Altitude is lerped across the whole 15 s segment, so a change that happens late in a segment is spread over all of it. Measured (GA1, VATSIM): the aircraft starts climbing about 5 s before the real go-around and is 116 ft high at the go-around point; gear starts retracting 4 s before it (6.2 shows the same mechanism for departures). Inherent to linear segments; see D4.

**1.6 VATSIM extrapolation runs along the nose, not the track.** `extrapolatePosition` uses `obs.groundTrack ?? obs.heading` (`:317`) and VATSIM has no track. With the 6 deg crab of the test approach, 15 s of extrapolation at 140 kt drifts 113 m sideways (computed: 72 m/s x 15 s x sin 6 deg). The track is available from the last two samples (the interpolation branch already computes it, `:1025-1049`); reuse it. One-site.

**1.7 Code quality.**
- Per-frame lerp factors make timings frame-rate dependent (computed from `rendering.ts:441-461`): nose-wheel lowering 0.98 s at 60 Hz, 0.41 s at 144 Hz; ground/air height transition 0.24 s and 0.10 s; `RATE_SMOOTHING` time constant 0.10 s and 0.04 s. Below 10 fps (`frameDelta >= 100`, `useAircraftInterpolation.ts:162,195`) heading is not rate-limited and rates freeze, which affects slow remote browsers. Convert to `1 - exp(-dt/tau)`.
- The hook's docblock (`useAircraftInterpolation.ts:942-961,1025`) still describes a lerp clamped to 1.2, "spherical" heading interpolation and an `interpolateAircraftState` that no longer exist. `TURN_RATE_DECAY_MS` (`rendering.ts:431`) is unused.

## 2. Taxi motion

### How it works today

Ground aircraft use the same timeline path; the hook rate-limits heading at 20 deg/s (`MAX_HEADING_RATE_DEG_PER_SEC_GROUND`), forces roll to 0 when terrain-clamped (`useAircraftInterpolation.ts:862-864`), adds terrain slope to pitch above 2 kt (`:848-853`), and clamps height to smoothed terrain samples taken at 10 Hz (`:586-601`, `useGroundAircraftTerrain.ts:117-140`). Pushback is detected from track vs heading (area 7).

### Findings

**2.1 VATSIM turns are chords, with heading turning independently of the path.** Measured (DEP1 90 deg left turn at 12 kt, 9 deg/s): VATSIM cross-track error 17.5 m, heading error 33 deg, direction of motion 55 deg off the true track, i.e. the aircraft slides sideways across the grass; line-up turn 8.3 m, 30 deg, 39 deg. vNAS on the same turn: 0.1 m, 1.8 deg, 4.7 deg. Reference: Boeing asks for 10 kt or less before any turn over 30 deg, so a 90 deg taxi turn takes about 10 s, shorter than one VATSIM interval.
- Fix: for ground aircraft, a cubic Hermite path between samples using each sample's position and velocity (gs along heading, reversed during pushback), with the rendered heading taken from the path tangent. Multi-file (`aircraftTimelineStore.ts` interpolation branch plus the hook's heading). D4.

**2.2 The nose leads the turn and lags the path.** Even straight-line VATSIM taxi shows heading error up to 34 deg on `taxi_straight1` because the heading lerp starts turning toward the next sample's heading while the position is still on the previous leg. Same fix as 2.1.

**2.3 The ground heading limit is adequate.** The 20 deg/s limit never engaged on the harness's 8-9 deg/s taxi turns (vNAS heading error 1.8 deg); no change proposed. Wheel rotation is not animated although 59-69 of 105 sampled FSLTL models carry a `*_WHEEL_ROTATION_ANGLE` clip (area 4).

## 3. Airborne motion

### How it works today

- Pitch = vertical rate x 5 deg per 1000 fpm (`PITCH_RATE_MULTIPLIER`) plus an AoA offset that falls from 5 deg at 120 kt to 2 deg at 350 kt of groundspeed (`useAircraftInterpolation.ts:264-283`), clamped to 20 deg and rate-limited to 5 deg/s.
- Roll = ADS-B roll when present (RealTraffic), else turn rate x 5 (`ROLL_RATE_MULTIPLIER`, `:290-299`), clamped to 35 deg and rate-limited to 10 deg/s. Turn rate is the frame derivative of the rate-limited heading, clamped to 6 deg/s.
- "On ground" for these purposes is `timeline.onGround === true || groundspeed < 40` (`:167`, `:259`): no AoA and no roll.
- Height: reported altitude plus a 5 m "flying offset" (`FLYING_AIRCRAFT_TERRAIN_OFFSET`), blended toward terrain near the ground (area 5).

### Findings

**3.1 `isOnGround` is frozen at its first value.** The in-place update of an existing entry (`useAircraftInterpolation.ts:497-518`) copies every field except `isOnGround`, which is set only when the entry is created (`:367`). Measured: in the vNAS scenario with VATSIM seen first, 23927 of 24270 DEP1 frames carry `null` while the timeline says `true`/`false`; with vNAS seen first the value stays `true`, so the terrain branch at `:620` clamps the aircraft to the runway. Because the terrain hook samples whatever is under 300 m of rendered AGL, the clamp feeds itself: DEP1 is drawn at 0.3 ft AGL through its climb, turn and cruise (AGL error 1451 m), with roll forced to 0 and gear never retracting.
- Who hits it: any pilot vNAS reports before the VATSIM feed lists them, e.g. one who connects at a gate during a session.
- Fix: copy `isOnGround` in the update block. One line, but do not land it alone: with the field live, the `true` branch clamps vNAS arrivals from 50 ft (the hysteresis threshold) and they drop 50 ft in 0.25 s. Land with D1.

**3.2 Bank is half of a coordinated turn at airliner speeds.** Roll = 5 x turn rate fits about 100 kt only. Measured: 3 deg/s climbing turn at 175-210 kt shows 15.0 deg where a coordinated turn needs 25.9-29.4 deg; the 250 kt cruise turn shows 10.2 deg against 25.0 deg. Physics: tan(bank) = V x omega / g; the FAA rule of thumb gives 25 deg at 180 kt.
- Fix: bank = atan(V x omega / g) with V from groundspeed (TAS when available), capped at 30 deg. One-site in the hook plus a constant.

**3.3 VATSIM bank lags and outlives the turn.** Because heading is lerped per 15 s segment, roll stays at 12.3 deg for ~4 s after the climbing turn ended and the cruise turn is drawn as two different constant bank angles (measured). Improves with D4.

**3.4 Pitch in the climb is plausible; on the approach it is low.** Measured: 16.8-17.0 deg at 2500 fpm and 175 kt (737 guidance: toward 15 deg after liftoff); 3.3 deg in level flight at 250 kt; +1.0 deg on the 3 deg glide at 140 kt, where an NTSB-recorded 737 held 2.8 deg until the flare. Raising the low-speed AoA offset to about 7 deg would put the approach near 2.5-3 deg; groundspeed stands in for airspeed, so headwind already raises it slightly as `rendering.ts:570-575` intends. One-site constant.

**3.5 Heading vs track in wind is right for vNAS, wrong only when extrapolating VATSIM.** With the 6 deg crab, vNAS heading error stayed at 0.2 deg and the direction of motion matched the true track; see 1.6 for VATSIM extrapolation.

**3.6 Every airborne aircraft is drawn 5 m above its reported altitude.** Measured: AGL error exactly 5.0 m in level flight in all scenarios. The comment ties it to a geoid offset, but altitudes are already converted to ellipsoidal heights (`vatsimStore.ts:170`). Cosmetic at distance; visible against a ceiling or a tower model. Drop or justify. One-site.

## 4. Ailerons, elevators, rudder

### How it works today

No control surface, flap, spoiler or reverser is animated. The FSLTL converter bakes the neutral (or frame-0) pose of every clip into the static model and keeps the clips (`convert_fsltl_batch.py:713-789`). At runtime only gear is driven: `applyGearAnimationsPercent` sets every clip whose name contains `GEAR` to the gear progress (`gltfAnimationParser.ts:484-507`), FSLTL models only (`useAircraftModels.ts:498-528`).

### Findings

**4.1 Steering clips are driven by gear progress.** Many MSFS nose-wheel steering clips have `GEAR` in their name. Measured (`steer_keys.py` over the 105 LOD0 models in the local `fsltl-traffic-base`): `GEAR_STEER` and similar in 27 models; with gear down (progress 1, last keyframe) the nose wheel is turned, relative to its neutral middle keyframe, by 88 deg (A306/A306F), 69 deg (E190), 44 deg (B744), 64 deg (MD11F), and by 176-180 deg on A320, B734, B738, B78X, AT75/76, CRJ7, P28A, where the wheel is reversed (hard to see on a symmetric wheel, visible on torque links).
- Fix: exclude steering clips (names containing `STEER`) from the gear set, both in `applyGearAnimationsPercent` and in the ground-data pass (`gltfAnimationParser.ts:825`). One-site. This also matters for E1: its proposal collects names containing `GEAR` for `activeAnimations` (rendering-opportunities-design.md, E1 step 1) and would carry the bug over; the filter belongs in both.

**4.2 What the models carry.** Measured (`anim_names.py`, 105 FSLTL LOD0 models): spoilers 71 with the standard `CUSTOM_ANIM_SPOILERS_*_POSITION` clip (more under other names); trailing-edge flaps 28 with the standard clip (more under `FLAPS*` names); reversers 12-14; wheel rotation 59-69; N1 fan blur 66-69; beacon 12; ailerons, elevators and rudder at most about 6, 10 and 3 models (counted by clip name, so models may overlap). Ailerons, elevators and rudder are rare on these traffic models, so animating them buys little; spoilers, flaps, reversers and wheels are common. Scope is D3.

**4.3 If surfaces are animated, drive them from motion the model already computes.** Ailerons from roll rate (the `prevRoll` delta in the hook), elevator from pitch rate, rudder from sideslip in a crab (heading minus track); ground spoilers on touchdown and reversers during rollout from the ground-contact signal of D1; flaps by phase. Unmeasured; design.

## 5. Landing flare, touchdown and takeoff rotation

### How it works today

- Height near the ground (`useAircraftInterpolation.ts:613-665`): weight 1 (on terrain) below 5 kt, when `isOnGround === true`, or when terrain is above the reported height; for descending aircraft without a ground flag a landing blend from 50 m (weight 0) to 10 m AGL (weight 1); a departure blend from 5 m to 35 m. A crossing of the 0.5 weight starts a 15-frame transition.
- Flare (`:740-806`, `geoMath.ts:81-125`): below 15 m reported AGL, descending faster than 150 m/min (490 fpm) and above 40 kt, pitch is lerped toward 6 deg x (sink / 300 m/min), max 12 deg, with smoothstep on height. The result is written after the pitch rate limiter.
- Touchdown: when the flare condition ends, a 60-frame smoothstep lowers pitch to 0 and locks out the flare until clearly airborne (`:793-836`).
- Takeoff: no rotation model; pitch comes from vertical rate once the reported altitude rises.

### Findings

**5.1 Arrivals touch down early.** The landing blend (50 m to 10 m) compresses the last 160 ft: drawn height is reported x (1 - weight), so the visual sink rate is 2.25x real at 50 m and the wheels meet the runway at 10 m (33 ft) reported. Measured: VATSIM arrival on the runway 2.4 s before real touchdown; vNAS arrival (VATSIM seen first) 7.1 s early, at 135 kt about 490 m short of the real touchdown point; vNAS seen first 5.5 s early. For vNAS this branch is reached only because of 3.1 (its frozen `null`); with 3.1 fixed alone, the `true` branch would clamp at 50 ft instead. The blend exists for VATSIM's poor height resolution; vNAS and RealTraffic altitudes do not need it.
- Fix: D1. Design.

**5.2 vNAS arrivals pitch nose-down through the flare.** vNAS reports `onGround` below 50 ft (`vnasStore.ts:35-41`), so the hook drops the AoA offset (`:259-283`) and pitch becomes the bare flight-path angle. Measured: -0.6 to -2.9 deg between 51 and 39 ft, then the flare term (computed from reported AGL, `:755`) lifts it to +1.8 deg, and when the sink falls below 490 fpm `calculateFlarePitch` returns the base pitch in one frame: +1.8 to -2.1 deg within 0.5 s. Touchdown is drawn at about 0 deg. Reference: Boeing flares at about 20 ft by raising pitch 2-3 deg; Airbus at about 30 ft by about 2 deg; flare lasts 4-8 s. Fix with D1 and 5.5.

**5.3 VATSIM departures roll down the runway nose-up.** VATSIM has no ground flag and the takeoff roll is above 40 kt, so the hook treats it as airborne and adds the 5 deg AoA offset; terrain clamping zeroes roll but not pitch (`:862-864`). Measured: +4.7 to +4.9 deg on the runway 2-6 s before liftoff (truth 0). The same happens on a VATSIM landing rollout: +3.2-3.3 deg for 6.4 s on the runway after the early touchdown of 5.1, then a ~1 s de-rotation. Fix: no AoA offset while the height blend weight is above 0.5. One-site.

**5.4 No rotation before liftoff.** Measured (vNAS): pitch 0.0 deg on the runway up to liftoff, then 2.2, 5.2, 8.2, 12.2, 17.0 deg over the next 4 s. A 737 rotates at 2-3 deg/s from VR, lifts off at 8-9 deg about 3-4 s later, and touches its tail at 11 deg. Fix: start rotation when an on-ground aircraft above ~120 kt is accelerating and the next observation (the timeline is delayed, so it is known) is airborne; ramp at 2.5 deg/s to 8 deg at liftoff. Needs the look-ahead of 5.5. Design.

**5.5 The flare and nose-wheel emulation predate 1 Hz data.** Both run off thresholds on reported AGL because VATSIM could not show a flare. vNAS observations contain the sim's own flare (the sink-rate reduction is in the data: measured rendered vertical rate -743, -628, -413, -271, -178, -125 fpm through the flare). With the display delay, the renderer already knows the next seconds of the path; pitch can be computed as flight-path angle plus AoA with touchdown at the first observation whose AGL is about 0, and de-rotation timed from that observation. Keep the threshold emulation for VATSIM only. Design; see "What newer data and models make possible".

**5.6 Main-gear-first contact is not modelled geometrically.** Pitch rotates the model about its origin (`useAircraftModels.ts:444-451`), and the ground offset (`:298-307`) is the unrotated lowest point. At +6 deg the main gear, aft of the origin on most models, sinks into the runway by its distance x sin 6 deg. Unmeasured (needs model geometry); measure in E1's spike session with one converted model.

## 6. Gear retraction and extension

### How it works today

`calculateTargetGearProgress` (`gearAnimationController.ts:161-193`): down on the ground (`groundspeed < 40`), down when below 2000 ft AGL and descending faster than 100 fpm, up when above 150 ft and climbing faster than 100 fpm, else hold; 12 s eased transition (`:51-57`). New aircraft start down unless above 3000 ft (`:112-144`). FSLTL models only; built-in models have no gear animation and keep their static pose. State is cleared when the model is culled (`useAircraftModels.ts:535-538`) and re-initialised when it comes back into view.

### Findings

**6.1 Gear AGL mixes datums.** `useAircraftModels.ts:509` (and `:332`) subtracts `groundElevationMeters` (MSL) from `interpolatedAltitude` (ellipsoidal); the comment at `:507-508` says both are MSL. The error equals the geoid height. Measured: retraction starts 7.8 s after liftoff at the -32 m site (5.3 s with the ellipsoidal ground), and 0.4 s after liftoff at EDDF (+48 m), where the rollout and taxi also read 158 ft "AGL" and only the 40 kt ground rule keeps the gear down. `useGroundAircraftTerrain.ts:123-128` already converts correctly. Fix: convert with `geoidService.mslToEllipsoidal`, or use the terrain-corrected AGL from the interpolation pass. One-site.

**6.2 VATSIM gear moves before the event.** Through 1.5, VATSIM vertical rate turns positive before liftoff (measured +1934 fpm one second before liftoff) and before a go-around (gear starting up 4 s early). The 150 ft threshold hides most of this on departures. Improves with D4.

**6.3 Timing against real procedure.** Real gear-up is called at positive rate of climb on the altimeter and VSI, a few seconds after liftoff; this code waits for 150 ft, which with the right datum is 5.3 s (VATSIM) to 6.9 s (vNAS) after liftoff at 2500 fpm (measured). Retraction takes 6-12 s on jets per a secondary source, 8-10 s on the 737-800; the 12 s transition is at the slow end, and since the measured "first visible movement" comes 1-2 s into the cubic ease, the gear looks late. Use 8 s with a linear or ease-out curve. One-site constant.

**6.4 Culling resets gear.** A climbing aircraft panned out of view and back below 2000 ft without enough vertical rate history re-initialises gear down. Keep gear state per callsign independent of pool slots. One-site.

**6.5 Wall clock in replay.** `updateGearAnimation` is called with `Date.now()` (`useAircraftModels.ts:521`), so in replay and scrubbing the 12 s transition runs on wall time, not replay time. Pass the data-source timestamp. One-site.

## 7. Smart status (flight-phase badge)

### How it works today

`detectRawFlightPhase` (`flightPhaseDetector.ts:478-764`) classifies from the interpolated (delayed) state: on a runway polygon below 100 ft and aligned it returns a roll phase by acceleration, then speed and flight plan; on the ground otherwise pushback (track vs heading over 90 deg), taxi, hold-short, stopped; airborne it checks final by track alignment and inbound bearing (2 and 6 nm), go-around, departure climb, base-to-final, pattern, inbound. `stabilizePhase` adds dwell times (0.5-2.5 s), sticky exits, distance hysteresis on finals, multi-signal roll classification and trajectory checks for go-arounds. It runs once a second while the panel is mounted.

### Findings (most visible first)

**7.1 "Go Around" is never shown.** `updateApproachTracking` (`phaseStabilization.ts:419-430`) measures "15 s after the sustained approach ended" from `approachStartTime + 8000`, i.e. from 8 s after the approach began. Any approach longer than 23 s loses `wasOnSustainedApproach` on the first frame off the approach, so `isValidGoAround` (`:240`) fails and the label falls back to "Climbing". Measured: GA1 in all four scenarios goes Short Final, then Climbing 12 s after the go-around; no scenario ever shows Go Around (score 550, the panel's highest). Fix: record the time the approach phase was last seen and expire 15 s after that. One-site.

**7.2 Unit error in the go-around fallback.** `phaseStabilization.ts:268` multiplies `verticalRate` by 3.28 x 60 as if it were m/s; it is m/min, so the 300 fpm check passes at 5 fpm. One-site.

**7.3 Finals have no altitude or glidepath gate.** `flightPhaseDetector.ts:658-678` returns short or long final for any aircraft aligned by track and pointing at a threshold. Measured (`phase.txt`): FL350 at 1.5 nm and 450 kt is "Short Final"; 12000 ft at 4 nm is "Final". Fix: require height within, say, 3 deg glidepath x distance + 1000 ft of threshold elevation. One-site.

**7.4 "Roll Out" and "Rolling" on the runway at the wrong times.** Measured: lining up at 8 kt shows "Rolling" (VATSIM) or "Roll Out" for 5 s (vNAS, decelerating to stop); under vNAS "Rolling" appears 8 s before the displayed aircraft moves (the 1.3 time jump plus the 1.4 bracket give it 3.5 kt while still standing); an arrival turns "Roll Out" as it crosses the threshold at about 50 ft, 9-10 s before touchdown, because the runway branch takes any aircraft below 100 ft over the runway (`:511-519`, `GROUND_ALTITUDE_AGL_FT`). Fixes: roll phases need the ground-contact signal of D1, not a 100 ft gate; a turn onto the runway below 15 kt is "Lined Up", not a roll. Multi-file.

**7.5 Go-around is masked by Short Final.** The final check comes before the go-around check (`:658` vs `:683`), and `short_final` has no "not climbing" condition, so a go-around keeps "Short Final" until it passes the threshold (measured: 12 s). Order the climb check first. One-site.

**7.6 Flapping and timing.** Measured transitions are clean (5-9 changes per flight), but every label lags the delayed display by at least one dwell and the 1 Hz tick. The window functions use `Date.now()` against `observedAt` (`phaseStabilization.ts:127-132,165-167`): with VATSIM's 15 s cadence the 4 s acceleration window holds at most one sample, so the windowed acceleration always has confidence 0 and roll classification rests on speed and flight plan alone. In replay the windows and dwell times run on wall time. Use the data-source time and a window of at least two samples.

**7.7 Code quality.** `flightPhaseDetector.ts:24-46` redeclares constants that `constants/flightPhase.ts` exports; `SPEED_HYSTERESIS`, `ALTITUDE_HYSTERESIS`, `VERTICAL_RATE_HYSTERESIS`, `DISTANCE_HYSTERESIS_FT`, `TAXI_MAX_SPEED_KTS`, `SUSTAINED_APPROACH_THRESHOLD_MS` and `DISTANCE_HYSTERESIS.goAround` are unused (the file header promises hysteresis it does not apply), and `state.accelState` is computed and never read (`phaseStabilization.ts:492`). The returned runway comes from the raw result even when the stabilized phase differs (`flightPhaseDetector.ts:800-804`). Phases are only computed while the panel is mounted, so a reopened panel starts from stale state.

## What newer data and models make possible

- **Predict from the timeline instead of easing.** The display delay means the renderer already holds the next 1-15 s of observations. Rotation (5.4), touchdown and de-rotation (5.5), gear-up at positive rate (6.3) and the go-around label (7.1) can all key off the next observation instead of thresholds on the present one. Same for curvature: a Hermite path through samples with known velocities replaces the chord-plus-heading-lerp (2.1).
- **Use vNAS AGL directly.** vNAS sends the sim's AGL (`aircraft.altitudeAgl`, `vnasStore.ts:792`) but only a 50/80 ft boolean reaches the timeline. Passing AGL through the observation gives a true contact signal and removes the need for the landing and departure blends for vNAS (D1).
- **Native glTF clips beyond gear.** FSLTL models carry spoilers (71 of 105 sampled models with the standard clip alone), flaps (28 with the standard clip), reversers, wheel rotation and fan blur. Spoilers deploying at touchdown, reversers during rollout and wheels rolling on taxi are what a tower sees at close range; ailerons, elevators and rudder are on under 10 % of these models. E1 in [rendering-opportunities-design.md](./rendering-opportunities-design.md) is settled as gear-only parity; any wider scope is D3 and should build on E1's `activeAnimations` path, not the matrix path.
- **Bank and pitch from physics.** The fixed multipliers were tuned when most traffic was seen at 15 s resolution; with 1 Hz tracks the turn rate is accurate enough that the coordinated-turn formula (3.2) and flight-path-plus-AoA pitch (5.5) are better than a tuned constant.

## Owner decisions

**D1. What decides "on the runway" for height and pitch?**
1. *Pass vNAS AGL through each observation; contact below ~3 ft with 1-2 ft hysteresis; keep the 50/80 ft flag only for labels; landing and departure blends only for sources without AGL* (recommended). Worst case: on runways where the sim's terrain and Cesium's disagree by more than the hysteresis, contact flickers during the roll; the KRNO case that motivated the 50/80 ft hysteresis needs a re-test.
2. *Stop using the vNAS flag for height; let reported altitude and terrain decide, as for VATSIM, without the landing blend for vNAS.* Worst case: vNAS aircraft float or sink by the sim-to-Cesium terrain difference on the runway (metres at high-elevation fields).
3. *Fix only the frozen field (3.1).* Worst case: every vNAS arrival drops 50 ft onto the runway in 0.25 s.

**Settled (owner ruling):** option 1, vNAS above-ground height decides contact.

**D2. How should the timeline treat vNAS silence for a stationary aircraft?**
1. *When the last vNAS sample is near 0 kt, treat the silence as parked: hold position, no extrapolation, and keep the gap out of the delay statistics* (recommended). Worst case: an aircraft that really drops out of vNAS while nearly stopped freezes until the 30 s VATSIM fallback.
2. *Exclude any interval over 3 s from the delay statistics regardless of speed.* Worst case: genuine vNAS outages in flight are bridged by extrapolation instead of a longer delay, so position errors grow after 1.5 s.
3. *Leave it.* Worst case: the measured 10 s late, 1.5x fast takeoff roll after every hold.

**Settled (owner ruling):** option 1, silence after a near-0 kt sample is treated as parked.

**D3. Animate more than gear?**
1. *After E1 lands, a separate item for spoilers on touchdown, reversers on rollout and wheel rotation, driven by the D1 contact signal* (recommended). Worst case: a mis-named or mis-keyed clip on some FSLTL models shows spoilers up on the ground or reversers deployed while taxiing; mitigate with a per-name allowlist checked against the converted model set.
2. *Also flaps by phase.* Worst case: wrong flap clips show flaps out at cruise on a few models.
3. *Gear only.* Worst case: no change from today, minus 4.1.

**Settled (owner ruling):** option 1, a separate item after E1.

**D4. Shape of the VATSIM path.**
1. *Cubic Hermite between samples using position and heading-plus-speed velocity, with heading from the tangent, on the ground and in the air* (recommended). Worst case: a sample with a wrong heading (reconnects, slews) bends the path into a visible S between two samples.
2. *Hermite on the ground only.* Worst case: airborne VATSIM turns keep the 140 m (measured, climbing turn) chord error and the lagging bank.
3. *Keep linear.* Worst case: today's 17.5 m corner cuts and sideways sliding.

**Settled (owner ruling):** option 1, splines on the ground and in the air.

**D5. Keep the harness?** The `.tmp/motion-review` harness exercised the real loop and found most of the above. 1) *Promote it to `tests/motion/` as a regression suite with assertions on the measured quantities* (recommended); worst case 10 s more test time and upkeep when the hook's internals change. 2) Leave it untracked; worst case regressions return unseen.

**Settled (owner ruling):** promote the harness to `tests/motion/` as a regression suite.

## Physics references

- Coordinated turn: tan(bank) = V x omega / g. FAA rule of thumb for a standard-rate (3 deg/s) turn: airspeed / 10 + half the result, e.g. 15 deg at 100 kt, 18 deg at 120 kt (FAA-H-8083-15B Instrument Flying Handbook, p. 7-20, <https://pubhtml5.com/xrzz/mvxt/FAA-H-8083-15B_Instrument_Flying_Handbook/181>); the variant TAS/10 + 7 gives 25 deg at 180 kt (<https://aviationtestprep.com/learn/standard-rate-turns-using-attitude-instruments>).
- Airline bank practice: "an average achieved bank angle of 25 degrees, or the bank angle giving a rate of turn of 3 degrees per second, whichever is less" (PANS-OPS as quoted in AFMAN 11-217 15.2.4, <https://johangithub.gitbooks.io/afman11-217v1/content/chp15.html>); FAA holding: 3 deg/s, 30 deg, or 25 deg with a flight director, whichever is least (AIP ENR 1.5, <https://www.faa.gov/air_traffic/publications/atpubs/aip_html/part2_enr_section_1.5.html>).
- Rotation and gear: 737 rotation at no more than 2-3 deg/s to 10 deg, liftoff at 8-9 deg, tail contact at 11 deg, then toward 15 deg; gear up "when a positive rate of climb is indicated on the Vertical Speed Indicator and Altimeter" (737 operating manual excerpt, NTSB docket, <https://data.ntsb.gov/Docket/Document/docBLOB?FileExtension=.PDF&FileName=Operations+2+-+Excerpts+from+737+Operating+Manual-Master.PDF&ID=40363842>); liftoff 3-4 s after rotation starts (737-8 FCTM as quoted by the AAIB, <https://assets.publishing.service.gov.uk/media/5f4681b1d3bf7f5d84a943c8/Boeing_737-8Q8_YR-BMF_06-19.pdf>).
- Flare: 737 "initiate the flare when the main gear is approximately 20 feet above the runway by increasing pitch attitude approximately 2-3 deg"; typical flare 4-8 s (737 FCTM quoted by NTSB DCA17IA020, <https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/94307/pdf>, and ATSB AO-2023-010, <https://www.atsb.gov.au/sites/default/files/2023-12/AO-2023-010%20Final.pdf>); the NTSB case shows 2.8 deg pitch at flare start. A320: flare at about 30 ft raising pitch about 2 deg; after touchdown "fly the nosewheel smoothly, but without delay, on to the runway" (A320 FCTM, NTSB docket attachment, <https://data.ntsb.gov/Docket/Document/docBLOB?FileExtension=pdf&FileName=Operational+Factors+Group+-+Attachment+10+-+Flight+Crew+Training+Manual+-+Flare+and+Touchdown-Rel.pdf&ID=7581601>).
- Taxi: turns of more than about 30 deg at 10 kt or less; nose-wheel steering wheel not above normal taxi speed (20 kt) (737 FCTM, <https://3ruk.ru/vehicles/prshecaneeck/gine/eve>; 737 operating manual excerpt above).
- Gear transit time: 6-12 s typical for jets, 8-10 s for the 737-800 (secondary source, <https://planefyi.com/systems/landing-gear-retraction/>); no manufacturer figure was found, so treat 6.3's 8 s as an estimate.
