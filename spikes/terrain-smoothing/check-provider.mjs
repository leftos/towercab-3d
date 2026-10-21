// Offline check of AirfieldTerrainProvider's tile resampling against a fake source provider:
// a heightmap tile inside the airfield must equal S exactly, one outside must equal the source.
// Run: node spikes/terrain-smoothing/check-provider.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import * as C from 'cesium'

const ctx = { window: {}, performance, Math, Float64Array, Float32Array, Uint8Array, Int32Array, console }
vm.createContext(ctx)
vm.runInContext(readFileSync(new URL('./airfield-surface.js', import.meta.url), 'utf8'), ctx)
const spike = ctx.window.__tsSpike

// A tiny synthetic surface: 64 x 64 cells of 25 m around (144.84, -37.67), S = 100 + slope, w = 1 inside a disc
const nx = 64
const ny = 64
const cell = 25
const DEG = Math.PI / 180
const R = 6378137
const grid = { nx, ny, cell, dLat: cell / R / DEG, dLon: cell / (R * Math.cos(-37.67 * DEG)) / DEG, west: 144.83, south: -37.68 }
const s = new Float64Array(nx * ny)
const w = new Float64Array(nx * ny)
for (let j = 0; j < ny; j++) {
  for (let i = 0; i < nx; i++) {
    s[j * nx + i] = 100 + 0.01 * i * cell
    const d = Math.hypot(i - 32, j - 32) * cell
    w[j * nx + i] = d < 400 ? 1 : d > 700 ? 0 : 1 - (d - 400) / 300
  }
}
const surface = {
  grid,
  s,
  w,
  influence: C.Rectangle.fromDegrees(grid.west, grid.south, grid.west + nx * grid.dLon, grid.south + ny * grid.dLat),
}
const tilingScheme = new C.GeographicTilingScheme()
const source = {
  tilingScheme,
  requestTileGeometry(x, y, level) {
    const raw = new Float32Array(65 * 65).fill(50)
    return Promise.resolve(new C.HeightmapTerrainData({ buffer: raw, width: 65, height: 65, childTileMask: 15 }))
  },
  getLevelMaximumGeometricError: () => 1,
}
const provider = new spike.AirfieldTerrainProvider(C, source, surface, { minLevel: 11 })
const centre = C.Cartographic.fromDegrees(grid.west + 32 * grid.dLon, grid.south + 32 * grid.dLat)
for (const level of [10, 14, 16]) {
  const xy = tilingScheme.positionToTileXY(centre, level)
  const data = await provider.requestTileGeometry(xy.x, xy.y, level)
  const rect = tilingScheme.tileXYToRectangle(xy.x, xy.y, level)
  const got = data.interpolateHeight(rect, centre.longitude, centre.latitude)
  const want = spike.surfaceAt(surface, centre.longitude / DEG, centre.latitude / DEG).s
  console.log(`level ${level}: height at centre ${got.toFixed(3)} (S ${want.toFixed(3)}, raw 50)`)
}
console.log(JSON.stringify(provider.stats))
