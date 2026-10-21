# TC3D-193 browser_evaluate snippets (tauri-app MCP)

Each is a `function` argument for `browser_evaluate`. Replace ICAO where marked.

## S1 cache reuse: second createMesh on the cached tile

```js
async () => {
  const v = window.__tc3d.viewer, tp = v.terrainProvider, ts = tp.tilingScheme
  const C = v.camera.positionCartographic.constructor
  const rw = (await import('/stores/runwayStore.ts')).useRunwayStore.getState().getRunwaysWithCoordinates('YMML')[0]
  const c = C.fromDegrees((rw.lowEnd.lon + rw.highEnd.lon) / 2, (rw.lowEnd.lat + rw.highEnd.lat) / 2)
  const out = []
  for (const lvl of [12, 13, 14]) {
    const xy = ts.positionToTileXY(c, lvl)
    const d1 = await tp.requestTileGeometry(xy.x, xy.y, lvl)
    const opts = { tilingScheme: ts, x: xy.x, y: xy.y, level: lvl, throttle: false }
    let e1 = null; try { await d1.createMesh(opts) } catch (e) { e1 = String(e).slice(0, 160) }
    const d2 = await tp.requestTileGeometry(xy.x, xy.y, lvl)
    let e2 = null; try { await d2.createMesh(opts) } catch (e) { e2 = String(e).slice(0, 160) }
    out.push({ lvl, same: d1 === d2, firstErr: e1, secondErr: e2, buffersFreed: d2._quantizedVertices === undefined })
  }
  return out
}
```

## S2 globe tiles in the airport that failed or were upsampled

```js
() => {
  const v = window.__tc3d.viewer, g = v.scene.globe, s = g._surface
  const C = v.camera.positionCartographic.constructor
  const ap = window.__tc3d.stores.viewport.getState()
  const pos = v.camera.positionCartographic
  const lon = pos.longitude, lat = pos.latitude, R = 0.0008 // ~5 km in radians
  const res = { failed: 0, upsampledOnly: 0, total: 0, byLevel: {} }
  const walk = (t) => {
    if (!t) return
    const r = t.rectangle
    if (r.east < lon - R || r.west > lon + R || r.north < lat - R || r.south > lat + R) return
    res.total++
    if (t.data && t.data.terrainState === 0) { res.failed++; res.byLevel[t.level] = (res.byLevel[t.level] ?? 0) + 1 }
    if (t.upsampledFromParent) res.upsampledOnly++
    walk(t._southwestChild); walk(t._southeastChild); walk(t._northwestChild); walk(t._northeastChild)
  }
  for (const t of s._levelZeroTiles) walk(t)
  const rendered = s._tilesToRender.filter((t) => !(t.rectangle.east < lon - R || t.rectangle.west > lon + R || t.rectangle.north < lat - R || t.rectangle.south > lat + R))
  res.renderedLevels = rendered.reduce((a, t) => ((a[t.level] = (a[t.level] ?? 0) + 1), a), {})
  return res
}
```

## S3 rendered vs aircraft vs provider along each runway centreline and 60 m off it

```js
async () => {
  const icao = 'YMML'
  const v = window.__tc3d.viewer, g = v.scene.globe, tp = v.terrainProvider, ts = tp.tilingScheme
  const C = v.camera.positionCartographic.constructor
  const ftp = await import('/terrain/FlatteningTerrainProvider.ts')
  const rws = (await import('/stores/runwayStore.ts')).useRunwayStore.getState().getRunwaysWithCoordinates(icao)
  const rendered = g._surface._tilesToRender
  const rows = []
  for (const rw of rws) {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      const lon = rw.lowEnd.lon + t * (rw.highEnd.lon - rw.lowEnd.lon)
      const lat = rw.lowEnd.lat + t * (rw.highEnd.lat - rw.lowEnd.lat)
      const c = C.fromDegrees(lon, lat)
      const lvlMax = tp.availability.computeMaximumLevelAtPosition(c)
      const xy = ts.positionToTileXY(c, lvlMax)
      const d = await tp.requestTileGeometry(xy.x, xy.y, lvlMax)
      const prov = d ? d.interpolateHeight(ts.tileXYToRectangle(xy.x, xy.y, lvlMax), c.longitude, c.latitude) : undefined
      const tile = rendered.find((q) => q.rectangle.west <= c.longitude && q.rectangle.east >= c.longitude && q.rectangle.south <= c.latitude && q.rectangle.north >= c.latitude)
      rows.push({ rw: rw.ident, t, rendered: g.getHeight(c), renderedLevel: tile?.level, provider: prov, providerLevel: lvlMax, aircraft: ftp.getHeightAndSlopeFromPolygons(lon, lat, 0)?.height })
    }
  }
  const d = rows.filter((r) => r.rendered !== undefined && r.aircraft !== undefined).map((r) => Math.abs(r.rendered - r.aircraft))
  d.sort((a, b) => a - b)
  return { n: d.length, p50: d[Math.floor(d.length / 2)], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1], rows: rows.filter((r, i) => i % 4 === 0) }
}
```

## S4 inset iframe: does it think it is in Tauri?

```js
() => [...document.querySelectorAll('iframe')].map((f) => { try { const w = f.contentWindow; return { src: f.src, tauri: '__TAURI_INTERNALS__' in w || '__TAURI__' in w } } catch (e) { return { src: f.src, err: String(e) } } })
```

## S5 blend slider: set 100 m and check for a regeneration log line

```js
() => { const s = window.__tc3d.stores.settings; s.getState().updateCesiumSettings({ terrainBlendDistance: 100 }); return s.getState().cesium.terrainBlendDistance }
```
Then `browser_console_messages` and look for `[TerrainFlattening] Set`.
