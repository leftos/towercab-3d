# Release plan

The owner's plan for the next four releases. Linear's release placeholders (`vNext`, `vNext+1`, …) are the record; this file holds the slots the `linear` CLI cannot place yet and the reasoning for each cut. Once a slot exists in Linear, its list here is replaced by a pointer to it.

| Release | Theme | Contents |
|---|---|---|
| `vNext` | Land the four branches and the converter | `feat/cesium-weather` (TC3D-213 with 148, 150, 141, 224, 294, 295, merge 221); `feat/aircraft-motion` (TC3D-241, gated by 246, merge 252); `feat/vnas-session-lifecycle` with the room join (TC3D-6, 45, 227, 228, 302, 303, merge 214); `feat/osm-facades` (TC3D-211 with 218, 220, merge 226); MSFS converter TC3D-263, 264, 265, 269, 256 |
| `vNext+1` | Babylon labels and precipitation, OSM shader | Babylon M3 and M4 (TC3D-151, 152, 153, 154, 31, 137); OSM B1 (TC3D-165, 166, 167); review findings booked during vNext (TC3D-296 to 301, 304, 306, 131) |
| `vNext+2` | Drop Babylon, harden the remote server | Babylon M5 and M6 (TC3D-155, 156, 157, 158); project `Remote server hardening` (TC3D-175, 176, 178, 187, 216, 217, 223, 231, 232, 233, 243) |
| `vNext+3` | Generated buildings and the settings drawer | OSM B2 (TC3D-168, 169, 170); project `Settings drawer` (`feat/settings-drawer`, TC3D-76 to 94, 106, 215) |
| unplaced | Everything else | OSM B3 (TC3D-171 to 174), the design track, cameras, docs, tooling, dependency PRs and singles, until a slot frees |

`vNext+2` and `vNext+3` move into Linear when the `linear` CLI's release slots land (`linear release add <repo> --slot 2`); until then their issues sit in no release.

## Rules

- A review finding booked while an item is built joins `vNext+1`, unless it blocks a `vNext` item's merge or is a security or data-loss bug; those join `vNext`.
- Urgent and High issues still join `vNext` through `linear sync-priority`, as `docs/plan-operations.md` gives it.
- A release cut moves every slot down one (`vNext+1` becomes `vNext`, and so on), so the plan above shifts with it.
