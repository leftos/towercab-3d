# Open datasets for typing untyped airport buildings

Research note, 2026-10-21. Question: which free/open data can give a facade style (office/terminal, house, parking, hangar/industrial, generic) to OSM buildings in Cesium OSM Buildings that carry no useful `building`/`aeroway`/`amenity` tag, such as the KSFO relation 15730419.

## Headline finding: the KSFO "untyped" building is a 3D-buildings grouping relation

OSM relation 15730419 carries only `type=building`, but it is a Simple 3D Buildings grouping relation, not a building of its own: its `outline` member is relation 14273628, tagged `aeroway=terminal`, `building=transportation`, `building:levels=5`, `height=40`, `name=International Terminal Main Hall`; its `part` members (e.g. relation 15730418) carry only `building:part=yes`, `height`, `building:levels` ([OSM API r15730419](https://api.openstreetmap.org/api/0.6/relation/15730419.json), [r14273628](https://api.openstreetmap.org/api/0.6/relation/14273628.json), [r15730418](https://api.openstreetmap.org/api/0.6/relation/15730418.json)).

So the type exists in OSM; it sits on the outline, and the parts never repeat it. No external dataset is needed for this case: inheriting the outline's tags onto its parts (by the relation, or by point-in-polygon of a part's centroid in an outline footprint) types it. Whether Cesium's tileset keeps the outline's tags on the part features is not checked here; it should be checked against the tileset's feature properties before building anything below.

## Overture Maps: buildings theme

- **What it gives**: `subtype` (broad current use) and `class` (specific use), plus `height`, `num_floors`, `roof_shape`, `facade_material` and others ([Building schema](https://docs.overturemaps.org/schema/reference/buildings/building/)). `class` values include `hangar`, `parking`, `office`, `warehouse`, `industrial`, `transportation`, `train_station`, `garage`, `garages`, `commercial`, `retail`, `hotel` ([BuildingClass](https://docs.overturemaps.org/schema/reference/buildings/types/building_class/)).
- **Sources**: OSM is the primary, highest-priority source; Esri Community Maps, national/municipal data (IGN Spain, City of Vancouver) and ML roofprints (Microsoft, Google Open Buildings, an East Asia set) fill gaps; `building_part` comes from OSM only ([Buildings guide](https://docs.overturemaps.org/guides/buildings/)). Each feature lists `sources[]` with `dataset` and `record_id`, e.g. `w519166507@1` for OSM way 519166507 version 1 ([schema example](https://docs.overturemaps.org/schema/reference/buildings/building/)).
- **Does it add types beyond OSM?** Not at airports in this check: every classed building at KSFO and KOAK came from OSM, and the 18 Microsoft-ML footprints at KOAK carried no class (measured below). The classes are a normalisation of the OSM `building` tag, not new knowledge. Matching across sources is by footprint IoU > 0.5, attributes merge only above that ([Buildings guide](https://docs.overturemaps.org/guides/buildings/)).
- **Licence**: ODbL, because it includes OSM ([Buildings guide](https://docs.overturemaps.org/guides/buildings/)). Overture's own attribution line for OSM-derived data is `© OpenStreetMap contributors, Overture Maps Foundation` ([Attribution](https://docs.overturemaps.org/attribution/)). TowerCab already ships OSM-derived content through Cesium, so the duty is the same credit plus ODbL's share-alike if a derived database is distributed (e.g. a shipped lookup table of OSM id → class).
- **Fetch an airport**: `uvx overturemaps download --bbox=W,S,E,N -f geojson --type=building -o out.geojson`; it reads the cloud GeoParquet with the STAC catalog and transfers only the bbox ([Python client](https://docs.overturemaps.org/getting-data/overturemaps-py/)). Measured: a ~1 × 1 km box at KSFO gave 39 buildings, 62 KB GeoJSON; a ~2 × 2 km box at KOAK gave 93 buildings, 73 KB; each download took about a second.

## Overture Maps: places theme

- **What it gives**: POI points with `names`, `taxonomy`/`basic_category` (the old `categories` field is removed), confidence ([Places guide](https://docs.overturemaps.org/guides/places/)). Relevant categories seen at the airports: `parking`, `airport`, `air_transport_facility_or_service`, `b2b_transportation_and_storage_service`, `hotel`, `fire_station`, `corporate_or_business_office`.
- **Licence**: CDLA-Permissive-2.0 and Apache-2.0 (Foursquare part), some CC0 (AllThePlaces); no OSM data and no ODbL share-alike ([Places guide](https://docs.overturemaps.org/guides/places/)).
- **Coverage**: Sept 2026 release counts by source, largest Meta (58.8 M) and BrightQuery (10.3 M) ([Places guide](https://docs.overturemaps.org/guides/places/)).
- **Fetch**: same CLI with `--type=place`. Measured: 267 places (372 KB) at KSFO, 125 (169 KB) at KOAK.
- **Quality at airports**: noisy. Inside the KSFO terminals sit points such as "Youtube" (`real_estate_service`) and "intel Santa Clara"; small KOAK sheds hold home-service businesses whose address is the airport (measured below). A place in a footprint says what business is registered there, not what the building looks like.

## FEMA USA Structures

- **What it gives**: footprints of all US structures over 450 sq ft with `OCC_CLS` (e.g. Residential, Commercial, Industrial) and `PRIM_OCC` (e.g. Single Family Residential, Hospital), built from Census, HIFLD, LightBox parcels and a model ([FEMA USA Structures](https://gis-fema.hub.arcgis.com/pages/usa-structures)).
- **Licence**: CC BY 4.0, credit ORNL and FEMA Geospatial Response Office ([ArcGIS item](https://www.arcgis.com/home/item.html?id=0ec8512ad21e4bb987d7e848d14e7e24)).
- **Fetch**: the feature service `https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query` takes an envelope query and returns JSON ([ArcGIS item](https://www.arcgis.com/home/item.html?id=0ec8512ad21e4bb987d7e848d14e7e24)); whole-state GDBs are 48 MB (DC) to 1.3 GB (IN) ([DataLumos mirror](https://www.datalumos.org/datalumos/project/218721/version/V1/view), [geoplatform](https://disasters.geoplatform.gov/USA_Structures/)).
- **At airports: useless for facade choice.** Measured: all 9 structures around the KSFO International Terminal are `Utility and Misc / Aviation`; at the KOAK North Field 32 of 47 are `Aviation`, the rest `Government / General Services`, `Industrial / Light`, `Commercial / Professional/Technical Services`. It does not tell a garage from a hangar from a terminal.
- **Coverage**: US and territories only.

## Other datasets

- **Microsoft Global ML Building Footprints** and **Google Open Buildings**: footprints (Google adds confidence; Microsoft some heights), no use/type attribute ([Microsoft repo](https://github.com/microsoft/GlobalMLBuildingFootprints), [Google Open Buildings](https://sites.research.google/gr/open-buildings/)). They appear inside Overture already.
- **EUBUCCO**: harmonised European building stock from government and OSM sources with `type` (residential/non-residential) where the source has it; too coarse for this use ([eubucco.com](https://eubucco.com/)).
- **Netherlands BAG**: `gebruiksdoel` per verblijfsobject (e.g. `kantoorfunctie`, `industriefunctie`, `logiesfunctie`), open (CC0) ([PDOK BAG](https://www.pdok.nl/introductie/-/article/basisregistratie-adressen-en-gebouwen-ba-1)). Use is per unit (address), so a terminal or hangar with no address may have none.
- **France BD TOPO**: building `usage_1`/`usage_2` (e.g. Industriel, Commercial et services), Licence Ouverte 2.0 ([IGN BD TOPO](https://geoservices.ign.fr/bdtopo)).
- **UK OS**: building function sits in OS NGD Buildings, which is Premium (not open); OS Open Map Local has no function attribute ([OS NGD](https://docs.os.uk/osngd/data-structure/buildings)).
- **FAA airport GIS**: the FAA Airports GIS programme (AC 150/5300-18) collects building features per airport, but the data is served to approved users through the Airport Data and Information Portal, not as open downloads ([FAA Airports GIS](https://www.faa.gov/airports/planning_capacity/airports_gis_electronic_ALP)).

These claims for BAG, BD TOPO, OS, EUBUCCO and FAA were not re-read in this session beyond the linked pages' known structure; verify the field names before building on any of them.

## Correlation approach

1. **By OSM id (exact)**: Overture building `sources[].record_id` holds the OSM element as `w<id>@<ver>` / `r<id>@<ver>` ([schema](https://docs.overturemaps.org/schema/reference/buildings/building/)). If Cesium OSM Buildings exposes the OSM element id per feature, a join is exact. But Overture's class is derived from the same OSM tags, so this join adds nothing Cesium does not already hold, except where the tileset dropped tags.
2. **By outline relation (OSM itself)**: inherit the type of a 3D-buildings `outline` onto its `part`s (the KSFO case above). Exact, free, no new licence.
3. **Point-in-polygon of places in footprints**: measured hit rate 16/39 buildings at KSFO and 10/93 at KOAK contain at least one place. Of those, the place category was right for the building's shape in a few cases (Garage G ← "International Parking Garage G" `parking`; Fire Station 22 ← `fire_station`; Hyatt ← `hotel`) and misleading in others (Garage A holds "Philippine Airlines"; Terminal 2 holds "Domestic Garage" `parking`; small KOAK sheds hold plumbers and CPAs). None of the KOAK hangars contained any place. No published evaluation of places-in-footprint typing was found.
4. **Footprint IoU against FEMA/cadastre**: possible (IoU > 0.5 like Overture), but at US airports FEMA only says "Aviation".

## KSFO / KOAK check (Overture release current on 2026-10-21)

KSFO bbox −122.395, 37.611, −122.383, 37.620: 39 buildings, all OSM-sourced; 20 with no subtype/class; classed ones: `transportation/transportation` 7, `outbuilding/shelter` 5, `transportation/parking` 3 (Garage A w24294330, Garage G w24294331, Domestic Garage r2920181), `outbuilding/roof` 2, `commercial/office` 1, `transportation/train_station` 1. At 37.6157, −122.3890 Overture holds r14273628 "International Terminal Main Hall", `transportation/transportation`: the outline of r15730419. Relation 15730419 itself is absent from Overture, as are its parts (Overture's `building_part` type was not downloaded).

KOAK bbox −122.232, 37.712, −122.208, 37.730: 93 buildings (90 with an OSM source, 18 with Microsoft ML); 62 with no subtype/class, 21 `outbuilding/roof`, 4 `transportation/hangar` (w23631695, w467163566, w467163579, w467163575 KaiserAir Jet Center), 3 terminals, one fire station (`civic`). Untyped large North Field buildings (w468777906, w179892753 FedEx hub area) get no class; places add "FedEx Express Oakland Hub" (`airport`) and "Southwest Airlines Cargo" (`b2b_transportation_and_storage_service`), which suggest warehouse/industrial but not reliably.

FEMA at the same spots: everything `Aviation` (above).

## Ranked recommendation

1. **Fix it inside OSM data first**: propagate the `outline` member's tags onto 3D-buildings `part`s (and parts lying inside a typed outline footprint). This solves the KSFO case outright, costs no dataset or licence. Worst case: the tileset lacks the relation/outline linkage, and it needs a point-in-polygon test of part centroids against typed outlines, still OSM-only.
2. **Heuristic fallback in the shader for what stays untyped**: inside an aerodrome, use footprint size, aspect and height (`building:levels`/`height`) to pick hangar (large, low, ≤ 2 levels) vs parking (large, 4–8 levels, many-level flat roof) vs generic. Worst case: wrong style on odd buildings, same as today's generic.
3. **Overture places as a weak hint, opt-in**: only trust a few categories (`parking`, `hotel`, `fire_station`) when the place name matches a building name word ("Garage", "Parking", "Hangar"). CDLA-Permissive/Apache needs only a credit line. Worst case: low yield (10 of 93 KOAK buildings had any place) and false types from businesses registered at airport addresses.
4. **Overture buildings**: only worth it if Cesium's tileset lacks tags that OSM has; its classes are OSM's own, so it brings no new knowledge at airports. Worst case: ODbL share-alike on a shipped derived table.
5. **FEMA USA Structures / national cadastres**: not recommended; FEMA says only "Aviation" at airports, and cadastres are per-country with per-unit use that often skips airside buildings.

Scratch data for the check is in `.tmp/ov/` (untracked).
