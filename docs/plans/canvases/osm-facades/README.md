# Type-aware facades and per-building palette: regression captures

Real desktop app (dev build), 1596×800 Cesium canvas, OSM Buildings on at quality high, the packed building style plus the facade shader (`u_fade` 0). Time through the app's fixed-time mode: noon = 12:00 local, night = 22:00 local. Heading, pitch and FOV in degrees; poses match `../facade-fade-ab/` so the two sets compare frame for frame.

Cesium documents a custom shader together with a `Cesium3DTileStyle` as undefined behaviour; these frames pin that the combination renders in Cesium 1.146.

The tileset's colour blend is MIX at amount 0, so the packed colour never tints the lit result (diffuse, specular or image-based light). `building=garage`, `garages` and `carport` get a plain wall with no openings; only `building=parking`, `amenity=parking` and `parking=multi-storey` get the slab-band garage grammar.

| File | Pose | What it shows |
|------|------|---------------|
| `ksfo-garage-noon.png` | KSFO tower eye, heading 235, pitch −14, FOV 35 | The curved central garage below the tower. It is OSM relation 15730419, tagged only `type=building`, so it gets the generic window grid; the terminal behind it gets office bands. |
| `ksfo-garage-night.png` | same, 22:00 | Lit share 0.28 on the glass classes; garages tagged `amenity=parking` have no lit windows. |
| `ksfo-tower-noon.png` | KSFO tower eye, heading 290, pitch −4, FOV 60 (wide) | Terminals and boarding areas (tagged `aeroway=terminal`, so the office grammar and the terminal palette) in front, the central garage's ring at the bottom, San Bruno 2–5 km behind. |
| `ksfo-tower-night.png` | same, 22:00 | Night look of the wide view. |
| `koak-tower-noon.png` | KOAK tower eye +25 m, heading 70, pitch −6, FOV 60 (wide) | Cargo ramp, Oakland behind. The large ramp buildings in front show a window row, so they are not in the hangar class (their tags were not read in this run). |
| `koak-tower-night.png` | same, 22:00 | Night look of the wide view. |
| `koak-hangar-noon.png` | KOAK tower eye +25 m, heading 182.8, pitch −9.9, FOV 12 | The long building on the south field. It still shows windows, so its tag is not one the hangar class reads (it was not picked in this run). |
| `koak-hangar-night.png` | same, 22:00 | Night look of the same building. |

Palette values are a proposal for the owner to judge from these frames.
