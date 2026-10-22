# Release plan

The owner's plan for the next four releases. Linear's release placeholders (`vNext`, `vNext+1`, `vNext+2`, `vNext+3`) are the record of each release's issues (`linear release status towercab-3d`); this file holds each cut's theme and reasoning, and the lists below are the issues each slot held when the plan was made.

| Release | Theme | Contents |
|---|---|---|
| `vNext` | Land the four branches and the converter | `feat/cesium-weather` (TC3D-213 with 148, 150, 141, 224, 294, 295, merge 221); `feat/aircraft-motion` (TC3D-241, gated by 246, merge 252); `feat/vnas-session-lifecycle` with the room join (TC3D-6, 45, 227, 228, 302, 303, merge 214); `feat/osm-facades` (TC3D-211 with 218, 220, merge 226); MSFS converter TC3D-263, 264, 265, 269, 256 |
| `vNext+1` | Babylon labels and precipitation, OSM shader | Babylon M3 and M4 (TC3D-151, 152, 153, 154, 31, 137); OSM B1 (TC3D-165, 166, 167); review findings booked during vNext (TC3D-296 to 301, 304, 306, 131) |
| `vNext+2` | Drop Babylon, harden the remote server | Babylon M5 and M6 (TC3D-155, 156, 157, 158); project `Remote server hardening` (TC3D-175, 176, 178, 187, 216, 217, 223, 231, 232, 233, 243) |
| `vNext+3` | Generated buildings and the settings drawer | OSM B2 (TC3D-168, 169, 170); project `Settings drawer` (`feat/settings-drawer`, TC3D-76 to 94, 106, 215) |
| unplaced | Everything else | OSM B3 (TC3D-171 to 174), the design track, cameras, docs, tooling, dependency PRs and singles, until a slot frees |

An issue joins a later slot with `linear release add towercab-3d --slot K <ID>`, and leaves every release with `linear release remove`.

## Rules

- A review finding booked while an item is built joins `vNext+1`, unless it blocks a `vNext` item's merge or is a security or data-loss bug; those join `vNext`.
- Urgent and High issues still join `vNext` through `linear sync-priority`, as `docs/plan-operations.md` gives it.
- A release cut moves every slot down one (`vNext+1` becomes `vNext`, and so on), so the plan above shifts with it.
