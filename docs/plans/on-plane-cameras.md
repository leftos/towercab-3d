# On-plane cameras

Status: design agreed, not started. Linear project `On-plane cameras`, queued after `Aircraft motion model` and `Settings drawer`. Four camera views fixed to the followed aircraft's airframe (cockpit, wing, chase, belly), picked by a cycle key or the aircraft panel, with free look relative to the airframe. The `Cinematic camera` project (`cinematic-camera.md`) builds on them.

## Where it stands

- The camera has four effective states, from `viewMode` × `followMode` (`types/camera.ts:18, 26`): free 3D from the tower, top-down, tower follow, and orbit follow. All per-viewport camera state is `ViewportCameraState` (`types/camera.ts:129-228`) in `viewportStore`.
- Every frame's pose is set in one `preRender` closure, `useCesiumCamera.ts:347-628`, through `viewer.camera.setView` with `roll: 0` hard-coded (:427, :543, :610). It reads only the interpolated latitude, longitude, altitude and heading (:403-406).
- The interpolation already produces `interpolatedPitch` and `interpolatedRoll` every frame (`useAircraftInterpolation.ts:245-327, 776-863`). On VATSIM-only data both are emulated; TC3D-52 (the bank, rotation and flare orientation model) corrects the worst of it.
- The model's orientation is built in `useAircraftModels.ts:438-461`: `HeadingPitchRoll` from heading, pitch and roll plus the model's `rotationOffset`, then `Transforms.headingPitchRollToFixedFrame`, then the per-axis scale.
- No model carries anchor points. Converted FSLTL/AIG models have their interior and cockpit meshes dropped (`scripts/shipping/conversion/convert_fsltl_batch.py:915-916`). The only geometry extracted from a glTF is the gear-up and gear-down minimum Y (`utils/gltfAnimationParser.ts:724, 828`); the bounds computed in `computeMinYAtGearState` are not exported. Per-type wingspan and length are in `public/aircraft-dimensions.json` (`AircraftDimensionsService.ts`).
- Mod manifests (`types/mod.ts:21-35`) have `modelFile`, `aircraftTypes`, `scale` and `rotationOffset`; no camera fields.
- The camera is clamped to terrain + `CAMERA_MIN_AGL` = 5 m (`constants/camera.ts:244`) in every branch.
- The followed aircraft's datablock is always shown, cyan and 1.2× (`useCesiumLabels.ts:253-255`, `useBabylonLabels.ts:344`).
- Babylon follows the Cesium camera from `positionWC`, `direction` and `up` (`utils/enuTransforms.ts:210-237`), so a rolled Cesium camera carries its roll to the overlay.
- Insets are iframes, each with its own `useCesiumCamera`; camera fields cross in `camera-update` (`components/Viewport/InsetCesiumViewer.tsx:239-255`) and `camera-change` (`components/InsetApp.tsx:214-243`). `camera-change` puts `followMode` in its change-detection key but never sends it.
- No test covers camera math. `utils/cameraGeometry.ts` and `utils/geoMath.ts` are pure and testable.

## Decisions

| Question | Decision |
|---|---|
| Views | Cockpit, wing, chase and belly. |
| Cockpit with no interior | A *nose camera*: just ahead of the nose at flight-deck height, outside the shell, so nothing is hidden. |
| Attitude | Locked to the airframe (pitch and bank) by default. A per-device setting, `camera.onboardHorizonLevel`, takes yaw only and keeps the horizon level. |
| Picking a view | `V` cycles orbit → tower → cockpit → wing → chase → belly while following; `Shift+V` cycles backwards; `O` keeps its tower↔orbit toggle. The aircraft panel gets view buttons beside its follow-mode button (`AircraftPanel.tsx:569`). |
| Free look | Mouse drag, Q/E/Z/C, arrows and one-finger touch drag look around relative to the airframe; wheel and pinch change FOV. None of them breaks follow. Esc stops following; W/A/S/D drops to orbit follow, as it escapes orbit today. A per-device setting, `camera.onboardLookSnapBack`, snaps the look back to the view's default angle when the drag ends. |
| Own datablock | Hidden in on-plane views. |
| Anchors | Manifest `cameras` block first, then glTF bounds, then wingspan and length; all scaled by the model's scale. |
| Transitions | Entering a view or cycling to the next one cuts. |

## Design

### State

- `FollowMode` gains `'onboard'`. `ViewportCameraState` gains `onboardView: 'cockpit' | 'wing' | 'chase' | 'belly'` and `onboardLookHeading` / `onboardLookPitch`, the free-look offsets in degrees, relative to the view's default look.
- `viewportStore` actions beside `setFollowMode` (:865): `setOnboardView(view)`, `cycleCameraView(direction)` over the six-step list in the decisions table, and `setOnboardLook(heading, pitch)`. `cycleCameraView` resets the look offsets.
- The two settings are per-device `Settings.camera` fields, added as registry entries in the Camera & Input category (`settings-drawer.md`).

### The airframe frame

The camera has to ride the model it is attached to, frame for frame. The HPR → fixed-frame math in `useAircraftModels.ts:438-461` moves into a pure `aircraftBodyFrame(state, modelInfo)` in `utils/`, returning the body-to-world matrix without the scale, and both the model and the camera call it. The first issue measures whether the model update and the camera branch read the same frame's interpolated state: a one-frame mismatch at 150 kt is about 1.3 m, which a nose camera shows as shake. If they differ, the ordering is fixed there.

### Pose

- `utils/onboardCamera.ts`: `computeOnboardPose(bodyFrame, anchor, look, horizonLevel)` returns `{ position, direction, up }` in world coordinates. With `horizonLevel` it rebuilds the frame from heading alone before applying the anchor and look.
- The `preRender` closure gets an `onboard` branch that calls `camera.setView({ destination: position, orientation: { direction, up } })`. Babylon picks the roll up from `up` with no change.
- The onboard branch does not use `CAMERA_MIN_AGL`, which would lift a belly camera off the runway. It keeps the camera at least 0.5 m above terrain, applied only when the anchor would be underground.
- FOV comes from the existing `fov` field; each view sets a default FOV when entered.

### Anchors

`AircraftCameraAnchors` holds, per view, a position in model-local metres (x right, y up, z forward) and a default look (heading and pitch relative to the nose). Resolution order:

1. A mod manifest's optional `cameras` block, any subset of the four views, documented in `MODDING.md`.
2. The glTF bounds: `gltfAnimationParser.ts` exports the min/max it already computes. Cockpit = just forward of max Z at about 70% of the fuselage height; wing = above and behind the max-X tip; chase = behind min Z and above max Y; belly = under min Y (gear-up), forward of the centre.
3. Wingspan and length from `aircraft-dimensions.json`, with the same fractions, for models whose bounds cannot be read.

Each tier is scaled by `modelInfo.scale` and corrected by the model's `rotationOffset`. Anchors reach inset iframes on `InterpolatedAircraftState`, the way `broadcastModelUrl` and `broadcastModelScale` do (`types/vatsim.ts:244-254`).

### Input

- `useCameraInput.ts`: `V` / `Shift+V` call `cycleCameraView`; in onboard mode, mouse drag, Q/E/Z/C and arrows drive `setOnboardLook` instead of breaking follow (:363, :383, :787); W/A/S/D switch to orbit follow; the wheel changes FOV.
- `useTouchInput.ts`: in onboard mode a one-finger drag drives the look and the 15 px follow-break threshold does not apply; pinch changes FOV.
- `KeyboardCheatsheet.tsx`, `USER_GUIDE.md` and the touch table in `CLAUDE.md` gain the onboard rows.

### Insets and the agent handle

- `camera-update`, `camera-change`, `CameraStateUpdate` and `types/shared-worker.ts` carry `onboardView` and the look offsets. `camera-change` starts sending `followMode`.
- `window.__tc3d.camera.get()` adds `followMode`, `onboardView` and the look offsets; `camera.follow(callsign, mode, view?)` starts following in any mode (`hooks/useAgentHarness.ts`, `types/harness.ts`).

## Steps

1. TC3D-95. Share the airframe frame between model and camera: extract `aircraftBodyFrame`, no behaviour change, a unit test against today's model matrix, and the frame-sync measurement.
2. TC3D-96. Camera anchors from the manifest, glTF bounds and dimensions: the three tiers, scale and rotation offset, broadcast to insets, the `MODDING.md` block, a test per tier.
3. TC3D-97. Onboard follow mode and its four views: state, store actions, the `preRender` branch, the onboard terrain clamp, the two settings, the hidden own datablock. Tests in `tests/camera/`: heading 90° puts the cockpit anchor east of the aircraft; a 30° bank tilts `up` by 30° and `horizonLevel` gives local up; the wing anchor sits on the side its sign says. Blocked by 1 and 2.
4. TC3D-98. View cycling, free look and panel buttons, with the cheatsheet, user guide and touch table. Blocked by 3.
5. TC3D-99. Onboard views in insets and the agent handle, including the missing `followMode` in `camera-change`. Blocked by 3.

Each step that a user can see lands with its `CHANGELOG.md` bullet. The Task Index row "add or change a camera mode" waits in a comment on TC3D-15 (reshape `docs/architecture.md` to the entry-point template); step 3 adds it to `docs/architecture.md` if the Task Index exists by then. The terms below wait in a comment on TC3D-16 (add `docs/README.md` with a glossary).

## Risks

- Orientation on VATSIM-only data is emulated; locked attitude shows every artifact. The project is queued after `Aircraft motion model` for that reason, and the horizon-level setting is the user's escape.
- Near plane: the `cameraNearPlane` effect is commented out (`CesiumViewer.tsx:346-379`), so Cesium's default applies. Step 3 checks the wing and belly cameras for clipping against the nearby airframe.
- Derived anchors will sit wrong on some models (an odd glTF origin, a mis-scaled model). The manifest override is the fix for mods; the model-matching modal (F3) is where a bad FSLTL match shows.

## Terms

- *On-plane view*: a camera fixed to the followed aircraft's airframe (cockpit, wing, chase or belly); `followMode: 'onboard'` in code.
- *Nose camera*: the cockpit view's camera, just ahead of the nose, used because converted models have no interior.
- *Anchor*: a view's camera position and default look in model-local metres.
