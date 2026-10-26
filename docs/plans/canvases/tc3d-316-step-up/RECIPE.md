# TC3D-316 resting-height step: rebuild recipe

`index.html` compares three ways to handle the vNAS resting height R (2.75 m for an A320) when ground contact begins and ends: A smooths the step as built, B fades R out over the first 50 ft, C subtracts R whenever it is known. All three lanes run on one 26 s clock showing a takeoff and, after a cut at 17 s, an approach and landing. The page needs `mock-three.js` and `a320.glb` beside it (about 2 MB together), so neither is committed; these steps rebuild them.

## Source

- Model: `src/renderer/public/a320.glb`. It is glTF 1.0, which three.js cannot load, so it is upgraded to glTF 2.0 with gltf-pipeline. It has no landing gear; the gear, wheels and struts in the mock are proxies sized to the A320 (wheelbase 12.64 m, main gear 17.7 m aft of the nose, track 7.6 m, tyre radius 0.58 m main and 0.38 m nose, nacelle 0.56 m above the runway).
- Page library: `~/.claude/tools/mock-three` (its `README.md` has the flow and the page API).

## Steps

Run from the repository root (`X:\dev\towercab-3d`).

1. Scaffold the source folder. This writes `mock-three.js`, a placeholder `index.html` and a copy of the model:

   ```
   node C:/Users/lefto/.claude/tools/mock-three/cli.ts new .tmp/mocks/tc3d-316-step-up-src --model src/renderer/public/a320.glb
   ```

2. Replace the model copy with its glTF 2.0 upgrade:

   ```
   pnpm dlx gltf-pipeline@4.3.1 -i src/renderer/public/a320.glb -o .tmp/mocks/tc3d-316-step-up-src/a320.glb
   ```

3. Put the committed page beside them: `cp docs/plans/canvases/tc3d-316-step-up/index.html .tmp/mocks/tc3d-316-step-up-src/index.html`.
4. Shoot stills through the gate (light slot), one per time. The checked times are 2, 11.2, 11.3, 11.5, 15, 19.6, 22.4 and 23.1:

   ```
   pwsh -NoProfile -File tools/gate.ps1 run --log .tmp/shoot-316.log --timeout 300 --slot light -- node C:/Users/lefto/.claude/tools/mock-three/cli.ts shoot .tmp/mocks/tc3d-316-step-up-src/index.html .tmp/mocks/tc3d-316-stills/t11.3.png --t 11.3
   ```

5. Make the review copy, one file with the model and library embedded:

   ```
   uv run --no-project python C:/Users/lefto/.claude/tools/mock-embed/embed_media.py .tmp/mocks/tc3d-316-step-up-src/index.html .tmp/mocks/tc3d-316-step-up
   ```

   Open `.tmp/mocks/tc3d-316-step-up/index.html`.

## What the stills show

| t (s) | Moment |
|---|---|
| 2 | Parked: wheels on the runway in every lane. |
| 11.2 | Contact is about to leave (true wheels at 5.0 ft); every lane is still on the runway. |
| 11.3 | Mid-catch-up after contact leaves: A closes a 4.2 m step to reported height over 0.25 s, B a 1.7 m step and C a 1.4 m step. |
| 11.5 | Catch-up done: A is 2.75 m above the true wheels, B 0.7 m above them, C on them. |
| 15 | Climbing through 100 ft: A and B 2.75 m high, C on the true height. |
| 19.6 | C mid-drop as R is learned at 19.5 s (worst case of C); A is 2.75 m high, B is fading. |
| 22.4 | Contact entered at 22.3 s (true wheels below 3 ft): A mid-drop, B and C nearly down. |
| 23.1 | Just after touchdown: every lane on the runway. |

## Notes

- Contact uses the decided thresholds on true wheel height (reported − R): it enters below 3 ft and leaves above 5 ft. While in contact the aircraft is drawn at runway + 0.1 m in every lane, so even B and C hold the wheels on the runway until the true wheels pass 5 ft and then catch up over 0.25 s; on the landing they settle 0.7 s before the true touchdown.
- The 0.25 s transition is the linear blend of `useAircraftInterpolation.ts` (source height at the switch, live target), started on each contact change and, in C, when R becomes known.
- The approach starts at about 63 ft rather than 80 ft, so that 700 ft/min with a 1.5 s flare from 21.5 s puts the touchdown at 23 s.
