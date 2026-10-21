// Checks the spike's FFT-based DCT against the naive sum and the smoother's behaviour on a
// sloped, curved surface with noise. Run: node spikes/terrain-smoothing/check-dct.mjs
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ctx = { window: {}, performance, Math, Float64Array, Float32Array, Uint8Array, Int32Array, console }
vm.createContext(ctx)
vm.runInContext(readFileSync(new URL('./airfield-surface.js', import.meta.url), 'utf8'), ctx)
const spike = ctx.window.__tsSpike

const n = 16
const x = Float64Array.from({ length: n }, () => Math.random())
const X = new Float64Array(n)
spike.makeDct(n).forward(x, X)
let err = 0
for (let k = 0; k < n; k++) {
  let ref = 0
  for (let m = 0; m < n; m++) ref += 2 * x[m] * Math.cos((Math.PI * k * (2 * m + 1)) / (2 * n))
  err = Math.max(err, Math.abs(ref - X[k]))
}
const back = new Float64Array(n)
spike.makeDct(n).inverse(X, back)
let rt = 0
for (let m = 0; m < n; m++) rt = Math.max(rt, Math.abs(back[m] - x[m]))
console.log(`DCT forward max error ${err.toExponential(2)}, round trip ${rt.toExponential(2)}`)

// 256 x 256 grid at 20 m: 1% slope east, a 30 km radius vertical curve north, 2 m noise at 300 m
const nx = 256
const ny = 256
const cell = 20
const truth = new Float64Array(nx * ny)
const h = new Float64Array(nx * ny)
for (let j = 0; j < ny; j++) {
  for (let i = 0; i < nx; i++) {
    const xm = i * cell
    const ym = (j - ny / 2) * cell
    truth[j * nx + i] = 100 + 0.01 * xm + (ym * ym) / (2 * 30000)
    h[j * nx + i] = truth[j * nx + i] + 2 * Math.sin((2 * Math.PI * xm) / 300) * Math.cos((2 * Math.PI * ym) / 420)
  }
}
// A few building outliers
for (let k = 0; k < 200; k++) h[Math.floor(Math.random() * h.length)] += 15
const t0 = performance.now()
const { s } = spike.robustSmooth(h, nx, ny, cell, 800)
const ms = performance.now() - t0
let maxErr = 0
for (let j = 60; j < ny - 60; j++) for (let i = 60; i < nx - 60; i++) maxErr = Math.max(maxErr, Math.abs(s[j * nx + i] - truth[j * nx + i]))
console.log(`robust smooth ${nx}x${ny} in ${ms.toFixed(0)} ms; interior max error vs truth ${maxErr.toFixed(3)} m (noise amplitude 2 m)`)
// Airfield mask at YMML on a 256 x 256 grid
{
  const apt = JSON.parse(readFileSync(new URL('./airports.json', import.meta.url), 'utf8')).YMML
  const R = 6378137
  const DEG = Math.PI / 180
  const c = 27
  const cosLat = Math.cos(((apt.bbox.south + apt.bbox.north) / 2) * DEG)
  const grid = {
    nx: 256,
    ny: 256,
    cell: c,
    dLon: c / (R * cosLat) / DEG,
    dLat: c / R / DEG,
    west: (apt.bbox.west + apt.bbox.east) / 2 - (127.5 * c) / (R * cosLat) / DEG,
    south: (apt.bbox.south + apt.bbox.north) / 2 - (127.5 * c) / R / DEG,
  }
  const t1 = performance.now()
  const { core, w } = spike.airfieldWeight(apt, grid, 250, 300)
  const coreKm2 = (core.reduce((a, b) => a + b, 0) * c * c) / 1e6
  const blendKm2 = (w.reduce((a, v) => a + (v > 0 && v < 1 ? 1 : 0), 0) * c * c) / 1e6
  console.log(`YMML mask in ${(performance.now() - t1).toFixed(0)} ms: core ${coreKm2.toFixed(2)} km2, blend band ${blendKm2.toFixed(2)} km2`)
}
// Edge bias of the reflective (DCT) boundary, by distance from the grid edge
for (const [lo, hi] of [[0, 10], [10, 25], [25, 50], [50, 75]]) {
  let e = 0
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const d = Math.min(i, j, nx - 1 - i, ny - 1 - j)
      if (d >= lo && d < hi) e = Math.max(e, Math.abs(s[j * nx + i] - truth[j * nx + i]))
    }
  }
  console.log(`  ${lo * cell}-${hi * cell} m from the edge: max error ${e.toFixed(2)} m`)
}
