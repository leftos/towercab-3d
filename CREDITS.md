# Credits

## Third-party data

### `buildingOutlines.json` and `aerodromes.json.gz`

Databases derived from OpenStreetMap: the rule tags of building-relation outlines near towered airports, and the aerodrome boundaries of towered airports.

- **Files:** `src/renderer/data/buildingOutlines.json`, `src-tauri/resources/aerodromes.json.gz`
- **Source:** [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors
- **License:** [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
- **Recreate:** `scripts/shipping/data-generation/extract-airport-buildings.py` regenerates both files from an OSM planet extract (ODbL 4.6).

## Third-party assets

### `cab-environment.env`

Prefiltered environment cubemap used as the Babylon.js scene `environmentTexture` for image-based lighting (IBL) on the modded tower cab interior.

- **File:** `src/renderer/public/cab-environment.env`
- **Source:** [BabylonJS/Assets — `environments/studio.env`](https://github.com/BabylonJS/Assets/blob/master/environments/studio.env)
- **Copyright:** © Microsoft Corporation and the Babylon.js authors
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- **Modifications:** Renamed from `studio.env` to `cab-environment.env`. File bytes are unchanged.
