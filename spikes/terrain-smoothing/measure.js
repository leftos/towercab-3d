// In-page sampler for raw Cesium World Terrain at airports.
//
// Injected into the running dev app with Playwright's page.addScriptTag({ path }),
// after airports.js has set window.__tsAirports. Defines window.__tsSpike.measure(icao),
// which samples a fresh Cesium World Terrain provider (ion asset 1, the app's own ion
// token) at the most detailed level along and across every runway and on a grid over
// the airport, and returns plain JSON for analyze.py.
;(() => {
  const R = 6378137
  const DEG = Math.PI / 180

  async function cesium() {
    if (window.__tsCesium) return window.__tsCesium
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /\/\.vite\/deps\/cesium\.js/.test(n))
    if (!url) throw new Error('Cesium dep URL not found in resource timing; is this the Vite dev server?')
    window.__tsCesium = await import(url)
    return window.__tsCesium
  }

  async function rawProvider() {
    if (window.__tsRawProvider) return window.__tsRawProvider
    const C = await cesium()
    window.__tsRawProvider = await C.CesiumTerrainProvider.fromIonAssetId(1)
    return window.__tsRawProvider
  }

  function offset(lat, lon, de, dn) {
    return { lat: lat + (dn / R) / DEG, lon: lon + (de / (R * Math.cos(lat * DEG))) / DEG }
  }

  function runwayFrame(rw) {
    const de = (rw.he.lon - rw.le.lon) * DEG * R * Math.cos(rw.le.lat * DEG)
    const dn = (rw.he.lat - rw.le.lat) * DEG * R
    const length = Math.hypot(de, dn)
    const u = { e: de / length, n: dn / length }
    // Right of the direction of travel from le to he
    const p = { e: u.n, n: -u.e }
    const at = (s, t) => offset(rw.le.lat, rw.le.lon, u.e * s + p.e * t, u.n * s + p.n * t)
    return { length, at }
  }

  async function sample(C, provider, points) {
    const cartos = points.map((q) => C.Cartographic.fromDegrees(q.lon, q.lat))
    await C.sampleTerrainMostDetailed(provider, cartos)
    return cartos.map((c) => Math.round(c.height * 100) / 100)
  }

  // Private-field read (_quantizedVertices, _minimumHeight, _maximumHeight): measurement only,
  // to show how many TIN vertices the source mesh has over the airfield.
  async function tinVertices(C, provider, bbox, level) {
    const ts = provider.tilingScheme
    const sw = ts.positionToTileXY(C.Cartographic.fromDegrees(bbox.west, bbox.south), level)
    const ne = ts.positionToTileXY(C.Cartographic.fromDegrees(bbox.east, bbox.north), level)
    const verts = []
    const tiles = []
    for (let x = Math.min(sw.x, ne.x); x <= Math.max(sw.x, ne.x); x++) {
      for (let y = Math.min(sw.y, ne.y); y <= Math.max(sw.y, ne.y); y++) {
        let data = provider.requestTileGeometry(x, y, level)
        if (!data) continue
        data = await data
        const rect = ts.tileXYToRectangle(x, y, level)
        const q = data._quantizedVertices
        const n = q.length / 3
        tiles.push({ x, y, level, vertices: n })
        for (let i = 0; i < n; i++) {
          const lon = (rect.west + (q[i] / 32767) * (rect.east - rect.west)) / DEG
          const lat = (rect.south + (q[n + i] / 32767) * (rect.north - rect.south)) / DEG
          if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue
          const h = data._minimumHeight + (q[2 * n + i] / 32767) * (data._maximumHeight - data._minimumHeight)
          verts.push([Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7, Math.round(h * 100) / 100])
        }
      }
    }
    return { tiles, verts }
  }

  async function measure(icao, opts = {}) {
    const C = await cesium()
    const provider = opts.provider ?? (await rawProvider())
    const apt = window.__tsAirports[icao]
    if (!apt) throw new Error(`No airport ${icao} in window.__tsAirports`)
    const t0 = performance.now()
    const centre = C.Cartographic.fromDegrees((apt.bbox.west + apt.bbox.east) / 2, (apt.bbox.south + apt.bbox.north) / 2)
    const maxLevel = provider.availability ? provider.availability.computeMaximumLevelAtPosition(centre) : null

    const runways = []
    for (const rw of apt.runways) {
      const { length, at } = runwayFrame(rw)
      const sValues = []
      for (let s = -300; s <= length + 300; s += 5) sValues.push(Math.round(s * 10) / 10)
      const centreH = await sample(C, provider, sValues.map((s) => at(s, 0)))
      const cross = []
      for (let s = 0; s <= length; s += 200) {
        const tValues = []
        for (let t = -150; t <= 150; t += 5) tValues.push(t)
        cross.push({ s, t: tValues, h: await sample(C, provider, tValues.map((t) => at(s, t))) })
      }
      runways.push({ id: rw.id, lengthM: length, widthM: rw.widthM, le: rw.le, he: rw.he, centre: { s: sValues, h: centreH }, cross })
    }

    const margin = 500
    const midLat = (apt.bbox.south + apt.bbox.north) / 2
    const dLat = (opts.gridM ?? 20) / R / DEG
    const dLon = (opts.gridM ?? 20) / (R * Math.cos(midLat * DEG)) / DEG
    const west = apt.bbox.west - margin / (R * Math.cos(midLat * DEG)) / DEG
    const south = apt.bbox.south - margin / R / DEG
    const nx = Math.ceil((apt.bbox.east - apt.bbox.west + (2 * margin) / (R * Math.cos(midLat * DEG)) / DEG) / dLon) + 1
    const ny = Math.ceil((apt.bbox.north - apt.bbox.south + (2 * margin) / R / DEG) / dLat) + 1
    const gridPts = []
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) gridPts.push({ lon: west + i * dLon, lat: south + j * dLat })
    const gridH = await sample(C, provider, gridPts)

    const tin = maxLevel === null || opts.skipTin ? null : await tinVertices(C, provider, apt.bbox, maxLevel)
    return {
      icao,
      maxLevel,
      ms: Math.round(performance.now() - t0),
      runways,
      grid: { west, south, dLon, dLat, nx, ny, h: gridH },
      tin,
    }
  }

  window.__tsSpike = Object.assign(window.__tsSpike ?? {}, { cesium, rawProvider, measure })
})()
