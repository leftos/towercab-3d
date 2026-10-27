# Credits

## Third-party assets

### `cab-environment.env`

Prefiltered environment cubemap kept for image-based lighting (IBL) of the modded tower cab interior. Nothing loads it today; it stays on disk until the Babylon removal decides whether the Cesium cab needs it.

- **File:** `src/renderer/public/cab-environment.env`
- **Source:** [BabylonJS/Assets — `environments/studio.env`](https://github.com/BabylonJS/Assets/blob/master/environments/studio.env)
- **Copyright:** © Microsoft Corporation and the Babylon.js authors
- **License:** [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- **Modifications:** Renamed from `studio.env` to `cab-environment.env`. File bytes are unchanged.

## Map data

Every data source the globe shows. The full per-provider attributions, including those Cesium collects for the terrain and imagery in use, are in Settings > About.

- **3D buildings:** [OpenStreetMap](https://www.openstreetmap.org/copyright) data through Cesium OSM Buildings. © OpenStreetMap contributors, licensed under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
- **Terrain and imagery:** Cesium World Terrain and Bing Maps Aerial imagery (Cesium ion asset 2), served by [Cesium ion](https://cesium.com/ion) under the [Cesium ion terms of service](https://cesium.com/legal/terms-of-service/). Bing imagery is © Microsoft and its data providers.
- **Google Maps imagery:** shown only when Google is the selected imagery provider, under the [Google Maps Platform terms of service](https://cloud.google.com/maps-platform/terms).
