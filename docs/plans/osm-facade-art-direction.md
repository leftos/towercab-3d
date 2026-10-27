# OSM building facades: art direction (TC3D-386)

The look the facade shader (`utils/facadeShader.ts`) is held to, for the implementer who prototypes it and the reviewer who judges stills against it. Status: **proposed**; nothing here is owner-approved until the owner signs a still that follows it. Window fitting itself is TC3D-385; its rule is fixed here.

The owner's verdict on the TC3D-376 mock (`.tmp/mocks/tc3d-376-facade-types/`): today's looks are "really basic, and not beautiful / detailed enough", and windows cut off at the top or bottom of a building are "very ugly". Every rule below answers one of those two.

## 1. Viewing context: where detail reads

The default main view is 60° horizontal FOV (`FOV_DEFAULT`; Cesium's `fov` is the horizontal angle on a landscape window). At 1920 px wide that is 1663 px per radian, so one metre of wall at distance `d` covers `1663 / d` px. Controllers zoom in often; at 15° FOV every figure below is 4x.

| Distance from cab | px per m | 3 m storey | 1.5 m window | 0.1 m frame | What it is in the view |
|---|---|---|---|---|---|
| 100 m | 16.6 | 50 px | 25 px | 1.7 px | buildings at the tower's foot, fill the lower view |
| 300 m | 5.5 | 17 px | 8 px | 0.6 px | ramp-side hangars, garages, terminal piers |
| 1 km | 1.7 | 5 px | 2.5 px | none | the airport ring: hotels, warehouses, offices |
| 3 km | 0.55 | 1.7 px | under 1 px | none | the town: a band of tone 0.5 to 4 degrees under the horizon |

The detail budget is set by pixels per metre (`1 / fwidth(metres along the wall)`), never by distance, so zoom spends detail correctly. Three tiers:

- **Tier A, near (8 px/m or more; about 200 m at 60°, 800 m at 15°):** frames, sills, mullions, blinds, door slats, panel joints, PTAC grilles, rain streaks, sign letters. Box-filtered, never stepped.
- **Tier B, mid (2 to 8 px/m):** whole window rectangles with a frame tone, storey and parapet bands, piers, bay and dock doors, sign bands, glass reflection, lit-window colour. This tier is what most of a tower view shows and gets the most care.
- **Tier C, far (under 2 px/m):** the flat tint, the area-weighted mean of every material above in linear light, including the parapet and base bands. At night it glows by the class's lit share times its mean lit colour. A tier change must not shift the mean: a reviewer flicking between a 1 km and a 3 km still sees the same tone. Real facades at this range are pale and low in contrast (Gatwick reference, section 6), so no palette entry may be saturated enough to pop out of the band.

Day and night split the budget differently. By day, glass against wall carries the read (contrast, reflection, the parapet line). At night walls fall to near black and only emissive reads, so a lit window's colour, brightness spread and clustering are the whole look of the town at 1 to 3 km.

## 2. Shared rules for every class

### 2.1 Window fitting (TC3D-385)

**Whole windows only.** No window, door or band is ever cut by the roof line, the ground, a building part's seam or a face's end. A wall reads from the bottom up as:

1. **Base band** 0.45 m (plinth, kerb, wainscot), class colour times 0.78. Never glazed.
2. **Ground storey** of the class's ground height (below), its openings sitting on the base band.
3. **n whole storeys**: `n = floor((wallTop - base - ground - parapetMin) / storeyNominal)`, then the storey is stretched to `(wallTop - base - ground - parapetMin) / n`, clamped to 2.7 to 4.2 m (5.0 m for offices and terminals). Rounding left over goes to the parapet.
4. **Parapet band**, at least `parapetMin` = 0.9 m (1.2 m while the top comes from the 2 m packed bucket, whose error is up to 1 m), at most 3 m; beyond 3 m the extra becomes a plain attic band with a 0.15 m reveal line, never another row of windows.

If `n` comes out 0 the wall shows only its ground storey, and if even that does not fit, a plain wall with base band and coping. A tile with no lookup (no ground) shows the Tier C tint, as today.

The exact top must come from geometry, not the packed bucket: the lookup build in `buildingBaseLookup.ts` already scans each feature's vertices for its lowest point and can store the highest beside it. **Horizontally** the same rule needs each wall face's ends, which the shader does not have today (`s` is a coordinate along the face, with no start or end). Until TC3D-385 supplies face extents, a pier of at least 0.6 m must cover each face end, and no rule here may centre anything on a face.

### 2.2 Framed and recessed windows

Fractions are of the bay width `b` unless stated. Tier A unless marked.

- **Frame**: 0.035b on all four sides (6 to 10 cm on real bays). Colour by building hash: dark bronze `#3B3631`, clear anodised `#A9ACAE`, white `#E9E7E1`, black `#1E1F21`. Tier B keeps the frame as a 0.85x darkening of the pane's edge mean.
- **Recess**: the pane sits 0.12 m behind the wall. Draw it as a shadow strip inside the frame on the top (0.06 of the window height, wall times 0.55) and on the side away from the sun (0.04b, times 0.7; the sign of `dot(sun, tangent)` picks the side). Tier B.
- **Sill**: under each punched window, 0.05 storey tall, overhanging the opening by 0.04b each side, wall times 1.12 (precast or metal). Tier B for hotel and generic, Tier A otherwise.
- **Mullion**: one vertical at the centre of any pane wider than 1.3 m, 0.022b, frame colour; office and terminal grids per their sections. Tier A.
- **Rain streak** under each sill: 0.8 of the window width, 0.6 m long, wall times 0.92 fading to 1. Tier A only.

### 2.3 Glass

Glass is an **interior behind a reflection**, never a flat navy tile.

- **Interior** per window by hash: sRGB `#15181C` to `#2A2E33` (linear 0.008 to 0.027). 25% of windows outside offices and terminals show blinds: `#B4AEA2` times 0.6 across a band from 0.55 to 0.95 of the pane height (some blinds half down, some fully: the hash picks the lower edge between 0.2 and 0.6).
- **Reflection**: Schlick Fresnel `F = F0 + (1 - F0)(1 - cos theta)^5` with F0 0.08 for clear glass (houses, hotels, generic, retail) and 0.22 for coated glass (offices, terminals, skybridges). The colour reflected is an analytic sky by the reflected vector's elevation `e`: ground `#5C5D58` below `e = -0.08`, horizon haze `#C6D1DB` around 0, sky `#7FA2C6` from `e = 0.25`.

  From the cab, `e` is near zero at 1 to 3 km (bright haze: distant glass reads lighter than the wall's shadow side) and negative within 300 m (ground reflected: near glass reads dark grey-blue, with the top of a tall pane lighter than its foot).
- **Time of day**: scale the sky by the sun: noon as above; at sun elevation under 8° the haze warms toward `#E3B48C` on faces turned toward the sun; after dusk the reflection is `#0E1219` and the interior or its lit colour takes over.
- Write the reflection as `material.emissive += reflection * F * (1 - night)` and the interior as `diffuse * (1 - F)`, and raise the glass roughness to 0.6 so Cesium's IBL does not add a second, sun-overhead reflection (its environment map is sun-overhead at every hour, plan idea 5).
- **Targets a reviewer measures** (CIE L*, sRGB stills, noon): coated glass at 1 km L* 45 to 62 with b* -4 to -12; any glass within 300 m L* 15 to 32; a hotel or house pane never darker than L* 10 by day.

### 2.4 Wall materials and per-building variation

Each class has a palette of material families (below). On top of the palette entry:

- **Tint jitter** per building: L* plus or minus 4, b* plus or minus 3, from a continuous per-building hash. The packed hash has 4 states; the jitter needs more, so draw it from a hash of the lookup's ground point or widen the packing (the six new classes already overflow the red channel's 28 codes: 13 classes times 4 hashes is 52).
- **Grime toward the base**: wall times `mix(0.84, 1.0, smoothstep(0.0, 1.4, h))`, plus contact darkening times 0.7 in the bottom 0.15 m (plan idea 8, read from the same lookup). Tier B, cheap, and the one change that stops boxes floating on the imagery.
- **Coping**: the top 0.12 m of the parapet times 1.12 (metal flashing), and a 0.08 m line under it times 0.72. Tier B; it is what gives a roof edge a crisp silhouette at 1 km.
- **Panel and joint scale**: tilt-up concrete panels 7.5 to 9 m wide with 3 cm joints; precast panels one bay by one storey; ribbed metal 0.3 m rib pitch; EIFS and stucco control joints at each floor line only. Joints are box-filtered lines at 0.85x and vanish under Tier A. **Brick is never patterned** (a 7.5 cm course is one pixel at 100 m and aliases): brick is colour plus a soldier course 0.2 m tall at 0.9x over each opening and at each floor line.
- **Material families** (sRGB): stucco and EIFS `#D9CDB8` `#CFC6B6` `#E3DCCD` `#C8B79C`; precast `#C9C5BC` `#BDB8AE` `#D4CFC4`; painted tilt-up `#D2CBBE` `#C4BDB0` `#B7B4AC` with accent band `#8E8A82`; brick `#8C5442` `#9A6A55` `#7A4B3E`; split-face block `#A39A8C`; ribbed metal `#D8DADB` `#BFC4C8` `#9EA6AD` `#C9C2B3`; spandrel `#3C4248`.

### 2.5 Corner piers

Every face end gets a solid pier 0.6 m wide (1.0 m on hotels and offices over 4 storeys) in wall material, full height between the base and parapet bands. Offices and terminals add an intermediate pier or column every 4 to 6 bays (0.4 m). Piers are what keep a partial bay from ever showing, and depend on face extents (2.1).

### 2.6 Night

- **Unlit glass** is `#0B0E14` plus the night reflection, never pure black. **Walls** keep the scene's night lighting; add a warm wash at the base of retail, hotel, terminal and fire-station walls (emissive 0.04 times wall colour, fading out by 3 m) for street and entrance light.
- **Lit windows vary** in three ways. Colour by hash: warm 2700 K linear `(1.0, 0.70, 0.40)` 55%, neutral 3500 K `(1.0, 0.84, 0.64)` 30%, cool 4500 K `(0.82, 0.88, 1.0)` 15% (offices and terminals: 20/40/40). Intensity 0.5 to 1.3 times the class base (base 1.3 linear). A vertical gradient in each pane, 1.0 at the top to 0.65 at the sill, for ceiling light.
- **Clustering**: a floor or a 4-bay group is first picked lit or dark by the class share, then 80% of the windows in a lit group glow and 8% of those in a dark group do. No salt-and-pepper.
- **Lit shares** (local evening; the time-of-night schedule is the owner's open question 1 in `osm-buildings.md`): terminal 0.85, hotel 0.5, house 0.35, generic 0.25, office 0.15, retail storefronts 0.7, school and civic (generic) 0.1 after 20:00, fire-station crew 0.4.
- 30% of lit hotel and house windows are curtained: intensity 0.3, warmer by one step.

## 3. Classes

Each class must read in **one glance** from the cab, at Tier B. A class's ground height is the ground storey in 2.1. "Hash n" is the building's packed hash state (0 to 3), which picks the palette entry and the variant together, so a variant always wears the same colour.

**GENERIC** (untagged, plus apartments, schools and civic, forced). Reads as: an ordinary stucco or block building of one to four storeys. Material: stucco, precast, split-face; hash 3 a brick wainscot 1.0 m tall with stucco above (schools, civic).

Windows: punched, bay 3.0 m, pane 0.45b wide by 0.5 storey, sill at 0.3 storey; hash 2 pairs windows (two panes, 0.15b apart). Ground height 3.4 m. One ground bay in 10 (by hash) is a glazed entry, 2.4 m tall, with a 0.3 m canopy line above it. Night: generic shares; schools nearly dark.

**OFFICE**. Reads as: horizontal bands of glass and solid. Spandrel 0.42 storey (precast or metal panel), vision glass 0.58 storey, mullions every 1.5 m (0.03b, frame colour); hash 1 is a full curtain wall: vision glass to 0.75 storey, spandrel glass `#2B3138` below. Coated glass, tinted by hash: neutral, blue-green `#1E3A3E`, bronze `#3A2E24` interiors. Ground height 4.5 m, fully glazed. Corner piers 1.0 m. Night: cool-neutral, whole floors on or off.

**TERMINAL** (plus skybridges, forced). Reads as: the biggest, most continuous glass on the field. Full-height curtain wall from the base band to a 1.5 to 2.5 m metal roof fascia `#C9CDD0`, mullions every 1.5 m, transoms every 2.0 m, structural columns or fins every 9 to 12 m (0.5 m, white).

Coated, low-tint glass. Skybridge: a glass band between two white fascia beams of 0.7 m each; hash 2 is opaque vertical-ribbed panels with a thin glass strip (Perth reference). Night: even and bright, 0.85 lit at intensity 0.7, neutral-cool: a glowing ribbon, not a checkerboard.

**HANGAR**. Reads as: a big ribbed shed with one huge door. Ribbed metal walls, 0.3 m pitch, over a 1.0 m concrete wainscot. Door: the full face width less two 1.5 m piers, height to 0.8 of the wall, made of ribbed leaves 4 to 6 m wide, each leaf plus or minus 3% in tone, with a 2 to 4 m header band above it; hash 1 adds a strip of glazing low on each leaf, hash 2 paints the leaves (`#3C5F8C` blue or `#E6E6E2` white) against grey cladding, as GA hangars are.

One row of small windows (1.2 by 0.9 m) at 2.5 m on other faces. The door belongs on one face only, which needs face data; until then, header band and ribs everywhere, no door. Night: door glazing lit cool, plus an apron flood wash on the lower 6 m (emissive 0.06 times wall).

**HOUSE** (plus static caravans, forced). Reads as: small residential. Stucco in pastel and cream, or lap siding (lines every 0.2 m, Tier A); hash 3 is the caravan look: white siding `#E6E4DE`, a trim stripe 0.1 m at 1.6 m `#7A8088`, a dark skirting 0.6 m `#6D6A63`. Windows 1.2 by 1.2 m in white frames, one per 3.4 m bay, 40% of bays blank. Ground height 2.8 m. Night: warm only, 0.35 lit, a third curtained, and one porch light (a 0.2 m warm spot at 2.2 m) per face.

**GARAGE** (parking decks, plus staircases, forced). Reads as: horizontal concrete upstands over dark open decks. Upstand 1.05 m `#BDB8AE`, opening the rest of the storey: slab underside `#5A5A57` in the top 18%, falling to `#121212` deeper in. Columns 0.6 m every 8.5 m. Three cable lines across the opening (Tier A).

Stair core (staircase class or a garage's end, by hash): a solid aggregate panel tower or a 1.5 m full-height glass strip. Night: every deck lit, a continuous LED line in the top 8% of each opening, linear `(0.9, 0.95, 1.0)` times 1.2; 1 in 4 garages sodium `(1.0, 0.62, 0.25)`.

**PLAIN** (domestic garages, utility sheds, forced). Reads as: a small blank structure. Split-face block or painted metal; base band and coping only; hash 1 adds one roll-up door 2.4 by 2.1 m per face once face data exists. Night: dark.

**CANOPY** (fuel canopies, plus carports, forced). Reads as: a roof floating on posts. Fuel: fascia 0.9 m, white or a brand colour by hash (`#B5251D`, `#1F4E9A`, `#E8B520`, white), on a 0.08 m dark drip line. Under the fascia is **not black**: the underside, light grey `#9A9B98` in shade (times 0.55), in the top 15%, then the far side seen through, `#3E3F3C`, to the ground.

Posts 0.45 m white every 7 to 9 m. Carport: no fascia, a 0.3 m steel edge, PV underside `#2C3440`, posts 0.25 m galvanised `#9EA3A6` every 8 m. Night: the fuel canopy's underside is the brightest thing in its block (emissive 2.0, 5000 K) and the fascia's brand colour glows at 0.6; carports show sparse dim downlights.

**RETAIL**. Reads as: a strip of shopfronts under a tall sign band. Storefront on the ground storey only: 0.5 m split-face bulkhead, glass from there to 3.0 m with aluminium mullions every 1.5 m and a transom at 2.4 m, clear glass with a lit-shop interior `#3A3833` by day. Tenant piers 0.6 m every 6, 7.5, 9 or 12 m (hash per tenant).

Sign band above, 1.2 m to the parapet, EIFS; each tenant a sign block 60% of its width, 0.6 m tall, in a muted colour by hash. Upper walls blank, no ghost grid. Night: storefronts lit warm-white with per-tenant intensity (30% closed and dark), signs glowing at 0.8 times their colour.

**WAREHOUSE**. Reads as: a long tilt-up box with a row of dock doors. Painted tilt-up panels 7.5 to 9 m with joints and two horizontal reveals at 1/3 and 2/3 height, or (hash 1) ribbed metal with a horizontal joint at 2/3. Hash 2 adds a clerestory band 0.8 m tall at 0.75 of the wall.

Docks: doors 2.7 wide by 3.0 m, sill at 1.2 m, every 3.7 to 4.3 m in runs of 6 to 16, a black shelter `#1C1C1C` 0.35 m around each, slats `#B7BCC0`, yellow guides `#E3B320` at the foot (Tier A), a lamp above each. Docks on one face only once face data exists. Night: dock lamps warm at 2.4, a wall pack every 15 m at 6 m height, everything else dark.

**FIRE_STATION** (fire stations and ARFF). Reads as: a row of tall bay doors framed in red. Apparatus bays on the ground storey only: 4 to 6 doors, 4.3 m wide by 4.3 m (ARFF 5.5 by 5.0 m), 0.8 m piers, a red surround `#B22222` 0.25 m; doors glazed sectional `#C9CCCE` with a glass band at 0.55 to 0.70 of their height, or (hash 1) solid red doors.

A header band of 1 to 2 m above, brick or metal. Crew wing at one end with punched windows, its storey 3.2 m. Never doors above the ground storey. Night: the apparatus floor is lit all night (door glass emissive 1.6, cool white), crew wing 0.4 lit.

**HOTEL**. Reads as: a tall, very regular room grid. Bay 3.8 m, one window per room 1.5 by 1.5 m with sill at 0.3 storey, adjacent rooms mirrored so windows pair across the party wall. PTAC grille 1.0 by 0.4 m under each window, wall times 0.75 (Tier A only: at Tier B it was the stills' floating dashes).

Two-tone body by hash: brick lower two storeys with EIFS above, or brick vertical panels between EIFS end bays. Ground height 4.8 m with lobby glass on a third of the bays, a 1.5 to 2.5 m lighter cornice band on top, a glazed or solid core tower at one end. Night: 0.5 lit, warm, 30% curtained, lobby bright.

**TANK**. Reads as: white cylinders with faint rings. Shell `#EDEDE9`, aged `#D9DBD7`, hash 3 a green-beige `#B9B79F`. Shell-course lines every 2.4 m at 0.95, a wind girder 0.6 m below the top (a 0.15 m band at 1.08 over a shadow line at 0.75), a 0.1 m rim at the top. Faint vertical grime streaks from the top, Tier A. The spiral stair needs a coordinate around the shell, which faceted tiles do not give; leave it out. Night: dark, with a red obstruction lamp at the rim on tanks over 15 m.

## 4. What not to do (seen in the TC3D-376 stills)

- **Windows cut by the roof line or by a face end**: `fire-vny-12-proposed.jpg` (top row half windows, sliver windows at every corner and at part seams), `apt-sfo-12-generic.jpg` (grid broken where parts meet).
- **Window rows running into the roof edge with no parapet**: `hotel-sjc-12-hotel.jpg`, `school-oak-12-today.jpg`; there is no coping line, so roofs have no edge.
- **Glass as a flat navy tile**: every still; no reflection, no interior, no blinds, so a 1 km facade reads as a printed pattern (`hotel-sjc-12-hotel.jpg`, `bridge-sfo-12-proposed.jpg`).
- **Uniform lit windows**: `hotel-sjc-22-hotel.jpg` and `school-oak-22-proposed.jpg` show identical flat peach squares in a salt-and-pepper checkerboard; `retail-sjc-22-proposed.jpg` a storefront as one blown-out white sheet.
- **A canopy as a black box**: `canopy-sjc-12-proposed.jpg` fills the space under the fascia with near-black, so it reads solid.
- **Doors and trims placed by a wall-length modulo**: `fire-vny-12-proposed.jpg` puts bay doors on narrow returns, under windows on a three-storey wall, and floats the red trim mid-facade.
- **Tiny details at mid distance**: the hotel PTAC grilles in `hotel-sjc-12-hotel.jpg` read as dark dashes floating under windows; Tier A only.
- **Ghost grids on blank walls**: `retail-sjc-12-proposed.jpg` shows faint storey rectangles on the upper wall.
- **Flat walls with no base**: every still; the walls meet the imagery with no plinth, grime or contact darkening.
- **Dock doors framed like windows**: `wh-vny1-12-proposed.jpg`, the heavy even black outline reads as glazing; the shelter must be wider at the sides and top than at the foot, and the door must sit at dock height.

## 5. Cost and the order to prototype

GPU cost is unmeasured (the GPU timer reads 0 on this desktop); every figure below is an ALU estimate per wall fragment, to be measured with the harness in `osm-buildings.md` (KSFO and KOAK cab views, noon and 22:00, `__tc3d.perf()` median and p95, `resolutionScale = 2`). The whole bundle's bar is +1.5 ms p50. A busy field is mostly Tier C fragments, so **nothing may be added to the far path** except constants folded into the flat tint; near work stays behind the existing `detail` early-out.

Ranked by value for cost, prototype top down:

1. **Vertical fitting, base band and parapet with coping** (2.1, 2.4): about 15 ALU, no texture; the exact top is one more float in the lookup texture (CPU, at tile load). Fixes the owner's second complaint. Highest value.
2. **Lit-window variation and clustering** (2.6): 2 hashes, about 12 ALU, night only. The whole night look.
3. **Grime and contact darkening** (2.4): 3 ALU. Grounds every building.
4. **Glass interior, blinds and analytic reflection** (2.3): about 25 ALU (Fresnel, one reflect, a 3-stop gradient). The largest daytime gain.
5. **Tint jitter** (2.4): 2 ALU, plus the hash source decision.
6. **Frames, recess shadow, sills** (2.2): 3 to 4 more `facadeBox` calls, about 40 ALU, Tier A and B only. Do these per class after 1 to 5 are judged.
7. **Per-class details** (section 3: doors, docks, sign bands, cables, PTAC): each a few boxes behind the class select; cost scales with the busiest class in view, so keep each class under 8 boxes.
8. **Horizontal fitting and corner piers** (2.1, 2.5): near zero per fragment, but needs face extents in the lookup, more CPU at tile load and more texture memory per tile, on private Cesium paths (`buildingBaseLookup.ts` footgun). Most build risk; needed before any door is placed on one face.
9. **Noise-based stains or texture variation**: a value-noise call is 30 to 60 ALU and shimmers in motion; avoid, or Tier A only and box-filtered.

Avoid: extra texture fetches beyond the lookup, loops over bays, Cesium's bloom stage for window glow (a full-screen pass), and any detail drawn on roofs, which the tiles draw and this guide does not cover.

## 6. References

Freely licensed photographs from Wikimedia Commons, gathered for this guide (local copies in `.tmp/facade-refs/<class>/`, not committed). What to take from each:

| Class | Source (licence) | Take from it |
|---|---|---|
| Far field | [Gatwick apron and South Terminal](https://commons.wikimedia.org/wiki/File:Gatwick_Airport_apron_and_South_Terminal_-_geograph.org.uk_-_1232748.jpg) (CC BY-SA 2.0, Chris Gunns) | At 1 to 2 km facades are pale, low-contrast blocks lifted by haze; only roof edges and glass bands read. Tier C palettes must stay muted. |
| Terminal | [St. Louis T1, glass](https://commons.wikimedia.org/wiki/File:Terminal_1,_St._Louis_Lambert_International_Airport,_St._Louis,_MO.jpg) and [T1, side](https://commons.wikimedia.org/wiki/File:Terminal_1,_St._Louis_Lambert_International_Airport,_St._Louis,_MO_-_52832606749.jpg) (CC BY-SA 2.0, w_lemay) | Curtain wall reflecting the sky, brighter than the wall; a mullion and transom grid; a heavy fascia band; solid louvred bays at the base. |
| Skybridge | [Perth Airport Central skybridge](https://commons.wikimedia.org/wiki/File:Airport_Central_Station_Skybridge_exterior,_Western_Australia,_11_October_2022_07.jpg) (CC BY-SA 4.0, Steelkamp) | White top and bottom beams with opaque ribbed panels between: a skybridge need not be all glass (hash 2). |
| Fire station / ARFF | [Geneva Airport fire station](https://commons.wikimedia.org/wiki/File:Fire_station,_Geneva_Airport,_Le_Grand-Saconnex_(BL7C0547-Pano).jpg) (CC BY-SA 4.0, Matti Blume) | Six wide bays in one row, red frames and header, white roller door at one end, a crew block beside. |
| | [Edinburgh Airport fire station](https://commons.wikimedia.org/wiki/File:Edinburgh_Airport_fire_station_-_geograph.org.uk_-_3468582.jpg) (CC BY-SA 2.0, Thomas Nugent) and [airport fire station](https://commons.wikimedia.org/wiki/File:Airport_fire_station_and_training_ground_-_geograph.org.uk_-_3517097.jpg) (CC BY-SA 2.0, M J Richardson) | The view from the field: a dark low block, red-framed glazed doors, a lower crew wing at one end; reads in one glance at 300 m. |
| | [Tallahassee ARFF Station 5](https://commons.wikimedia.org/wiki/File:Tallahassee_Fire_Department_Aircraft_Rescue_and_Firefighting_Station_No_5.jpg) (CC BY-SA 4.0, The Bushranger); [Braunton fire station](https://commons.wikimedia.org/wiki/File:Braunton_(Devon,_UK),_Fire_Station_--_2013_--_00156.jpg) (CC BY-SA 4.0, Dietmar Rabich) | US brick variant with a covered apron; the small-town case of one red door, so a 1-bay station still reads. |
| Generic, school, civic | [Manchester Elementary](https://commons.wikimedia.org/wiki/File:Manchester_Elementary_School_-_April_2023_-_Sarah_Stierch.jpg) (CC BY 4.0, Missvain); [Yosemite High classroom building](https://commons.wikimedia.org/wiki/File:Yosemite_High_School_classroom_building_Oakhurst_CA_2023-07-17_15-07-45.jpg) (CC BY 4.0, G. Edward Johnson) | Sparse windows, one glazed entry; stucco over a brick wainscot with an accent stripe at door head (generic hash 3). |
| | [Moores Park School](https://commons.wikimedia.org/wiki/File:Moores_Park_School,_Moores_River_Drive,_Moores_Park,_Lansing,_MI_-_54382484095.jpg) (CC BY-SA 2.0, w_lemay); [Redwood High campus](https://commons.wikimedia.org/wiki/File:Redwood_High_School_campus.jpg) (CC BY-SA 4.0, E bailey) | Brick with high-sill window groups and white mullions; from the air, schools are long low flat-roofed ranges, not office blocks. |
| Apartments | [1916 apartment block](https://commons.wikimedia.org/wiki/File:The_Architect_and_engineer_of_California_and_the_Pacific_Coast_(1916)_(14577072229).jpg) (no known restrictions) | Paired punched windows in a strict grid, a glazed ground floor and a cornice: the generic grammar with pairing. |
| Office | [Rohm and Haas building](https://commons.wikimedia.org/wiki/File:Exterior_views_of_Rohm_and_Haas_home_office_building_-_DPLA_-_723c956334595b75862f1e5813ad23df_(page_2).jpg) (no known restrictions); [Cincinnati, ribbon block at right](https://commons.wikimedia.org/wiki/File:Cincinnati_Bell_Building,_Cincinnati,_OH_(46630212994).jpg) (CC0, Warren LeMay) | Ribbon glass over precast spandrels, roughly 55/45; a recessed, taller, columned ground floor; a solid roof band. |
| Hotel | [DoubleTree O'Hare](https://commons.wikimedia.org/wiki/File:Doubletree_By_Hilton_Hotel_Chicago_O%27Hare_Airport-Rosemont.jpg) (CC0, SimLibrarian) | The airport hotel: one window per room in a strict grid, a glazed core tower, a taller base, a cornice. |
| | [Hampton Inn Tulsa](https://commons.wikimedia.org/wiki/File:Hampton_Inn_hotel_building_Tulsa_OK_2025-10-23_15-05-09.jpg) (CC BY 4.0, G. Edward Johnson); [Hampton Inn Tallahassee](https://commons.wikimedia.org/wiki/File:Hampton_Inn_%26_Suites,_Lonnbladh_Rd,_Tallahassee_(North_face).JPG) (CC BY-SA 3.0, Michael Rivera) | Two-tone blocks (brick panel between EIFS), a brick base storey, a light cornice; the low-rise version with an entry tower. |
| Warehouse | [Modern loading dock](https://commons.wikimedia.org/wiki/File:Modern_loading_dock.jpg) (CC BY-SA 4.0, Mark LS) | Ribbed panels with horizontal joints, a high clerestory strip, dock doors at dock height with black shelters, yellow guides and a lamp above each. |
| Retail | [Strip-mall storefront](https://commons.wikimedia.org/wiki/File:Waterbeds_%27n%27_Stuff_Storefront,_Lewis_Center,_Ohio.jpg) (CC BY-SA 4.0, WaterbedsRobbie) | A sign band as tall as the glass, split-face piers and bulkhead, a 4-by-2 mullion grid with transom. |
| Canopy | [Shell station at night](https://commons.wikimedia.org/wiki/File:DZ6_2617_Empty_Shell_station_at_night_-_bright_lights_and_clean_pumps_ready_for_early-morning_customers._(55017570203).jpg) (CC BY-SA 4.0, PattayaPatrol); [Stuckey's, night](https://commons.wikimedia.org/wiki/File:Stuckey%27s_of_Pelham,_P66,_night.jpg) (CC BY-SA 4.0, Xnatedawgx) | The underside is white and the brightest thing at night; the fascia is a brand-coloured band; posts are few. Never a black void. |
| Carport | [PV solar parking](https://commons.wikimedia.org/wiki/File:PV_solar_parking.jpg) (CC BY-SA 3.0, Hanjin); [solar carport](https://commons.wikimedia.org/wiki/File:American_Public_University_solar_carport_2022-08-07_13-40-16.jpg) (CC BY 4.0, G. Edward Johnson) | Thin posts 8 m apart, a dark blue panel underside, an open view through. |
| Tank | [HKIA fuel farm](https://commons.wikimedia.org/wiki/File:HKIA_fuel.jpg) (CC BY-SA 2.5, Tksteven); [HKIA tank farm, oblique](https://commons.wikimedia.org/wiki/File:HONG_KONG_INTERNATIONAL_AIRPORT.jpg) (CC BY-SA 4.0, Dinkun Chen) | From above: white shells with faint course rings, a top girder line and a dark rim; grime faint. |
| | [BNSF diesel tanks](https://commons.wikimedia.org/wiki/File:Two_BNSF_Railway_diesel_fuel_storage_tanks.jpg) (CC0, Mr. Satterly) | Up close: rim handrail, spiral stair, stencilled marks (out of scope). |
| Hangar | [AMSL hangar, Nairobi](https://commons.wikimedia.org/wiki/File:AMSL_Hangar_Nairobi_2025_(01).jpg) (CC BY-SA 4.0, Bahnfrend) | Tower's-eye view: the door face reads as a dark full-width panel under a header, the side as plain cladding. |
| | [Fornebu Hangar 2](https://commons.wikimedia.org/wiki/File:Fornebu_International_Airport,_FBU,_Oslo._Exterior_of_Hangar_2_and_maintenance_building_at_Fornebu.jpg) (public domain, SAS); [Borkenberge hangar](https://commons.wikimedia.org/wiki/File:L%C3%BCdinghausen,_Flugplatz_Borkenberge,_Hangar_--_2014_--_7954.jpg) (CC BY-SA 4.0, Dietmar Rabich) | Ribbed door leaves with a low window strip and a tall header; GA door leaves are often coloured (blue) or glazed. |
| Garage | [Rishworth Street car park](https://commons.wikimedia.org/wiki/File:Rishworth_Street_multi-storey_carpark_-_geograph.org.uk_-_1046348.jpg) (CC BY-SA 2.0, SMJ) | Concrete upstands about 1.1 m, columns, the slab underside lighter at the top of each opening, a solid stair core. |
| House | [Bay Farm Island](https://commons.wikimedia.org/wiki/File:03-bay-farm-island.jpg) (CC0, Alfred Twu) | Next to KOAK: at 2 to 3 km houses are cream walls under roofs; walls are a thin light edge, so house detail is Tier B at most. |
| Static caravan | [Meadowbrook Acres](https://commons.wikimedia.org/wiki/File:Meadowbrook_Acres_Mobile_Home_park_Leominster.JPG) (CC BY-SA 4.0, Nick Allen) | Rows of long white low boxes: white siding and a dark skirting carry it. |
| Night | [Office at Banani](https://commons.wikimedia.org/wiki/File:Office_building_at_Banani.jpg) (CC BY-SA 4.0, Hassanrakib04); [office building at night](https://commons.wikimedia.org/wiki/File:Office_building_at_night_(13346726533).jpg) (CC BY 2.0, Thomas Quine) | Whole floors on or off, ceiling fixtures making the top of each pane brightest, warm and cool mixed in one block. |

No Commons result showed a California tilt-up warehouse or an airport-side apartment block worth keeping; the values in section 3 for those come from the dock and 1916 references and need an owner check.
