/**
 * TC3D-193 adversarial measurements of airport terrain flattening against real Cesium World Terrain.
 * Two separate CesiumTerrainProvider instances: `raw` is never wrapped, `flatBase` is wrapped in place.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import * as Cesium from 'cesium'
import { it } from 'vitest'
import { airportPolygonService } from '../../src/renderer/services/AirportPolygonService'
import { airportSurfacesService } from '../../src/renderer/services/AirportSurfacesService'
import { geoidService } from '../../src/renderer/services/GeoidService'
import { runwayService } from '../../src/renderer/services/RunwayService'
import { createFlatteningTerrainProvider } from '../../src/renderer/terrain/FlatteningTerrainProvider'
import type { Runway } from '../../src/renderer/types/airport'
import type { FlatteningPolygon } from '../../src/renderer/types/terrain'

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, '.tmp', 'tc3d-193')
const AIRPORTS = (process.env.TC3D_AIRPORTS ?? 'YMML,YSSY,YBBN,YPPH,YBCS,YMHB,KSFO,KOAK,VILH,KDEN').split(',')
const GRID_M = Number(process.env.TC3D_GRID_M ?? 25)

function loadToken(): void {
  const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*CESIUM_ION_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?/)
    if (m) Cesium.Ion.defaultAccessToken = m[1].trim()
  }
}

const log: string[] = []
function out(s: string): void {
  log.push(s)
  console.log(s)
}

// ---------- geometry helpers ----------
const M_PER_DEG_LAT = 111320
function enu(lon: number, lat: number, lon0: number, lat0: number): [number, number] {
  return [(lon - lon0) * M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180), (lat - lat0) * M_PER_DEG_LAT]
}
function fromEnu(x: number, y: number, lon0: number, lat0: number): [number, number] {
  return [lon0 + x / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)), lat0 + y / M_PER_DEG_LAT]
}
function rayCast(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
interface PolyIdx {
  p: FlatteningPolygon
  minX: number
  maxX: number
  minY: number
  maxY: number
}
function indexPolys(polys: FlatteningPolygon[]): PolyIdx[] {
  return polys.map((p) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of p.vertices) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    return { p, minX, maxX, minY, maxY }
  })
}
function membership(lon: number, lat: number, idx: PolyIdx[]): Set<string> {
  const s = new Set<string>()
  for (const q of idx) {
    if (lon < q.minX || lon > q.maxX || lat < q.minY || lat > q.maxY) continue
    if (!rayCast(lon, lat, q.p.vertices)) continue
    if (q.p.holes?.some((h) => rayCast(lon, lat, h))) continue
    s.add(q.p.source)
  }
  return s
}
function stats(a: number[]): { n: number; p50: number; p95: number; max: number; mean: number } {
  if (a.length === 0) return { n: 0, p50: NaN, p95: NaN, max: NaN, mean: NaN }
  const s = [...a].sort((x, y) => x - y)
  const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  return { n: a.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: a.reduce((x, y) => x + y, 0) / a.length }
}
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : String(n))
const fs1 = (s: ReturnType<typeof stats>) => `n=${s.n} p50=${f1(s.p50)} p95=${f1(s.p95)} max=${f1(s.max)} mean=${f1(s.mean)}`

async function sampleMost(provider: Cesium.TerrainProvider, pts: [number, number][]): Promise<number[]> {
  const carts = pts.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat))
  const chunk = 4000
  for (let i = 0; i < carts.length; i += chunk) {
    await Cesium.sampleTerrainMostDetailed(provider, carts.slice(i, i + chunk))
  }
  return carts.map((c) => c.height)
}
async function sampleLevel(provider: Cesium.TerrainProvider, level: number, pts: [number, number][]): Promise<number[]> {
  const carts = pts.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat))
  await Cesium.sampleTerrain(provider, level, carts)
  return carts.map((c) => c.height)
}

type Flat = ReturnType<typeof createFlatteningTerrainProvider>

async function measureAirport(icao: string, raw: Cesium.CesiumTerrainProvider, flat: Flat, stubFlat: Flat, stubBase: { tiles: Map<string, Cesium.TerrainData> }): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { icao }
  const runways: Runway[] = runwayService.getRunwaysWithCoordinates(icao)
  out(`\n==================== ${icao} ====================`)
  out(`runways: ${runways.map((r) => `${r.ident}(${r.lowEnd.elevationFt}/${r.highEnd.elevationFt} ft, w=${r.widthFt})`).join(' ')}`)
  let t0 = performance.now()
  const config = airportPolygonService.generateRunwayPolygons(icao, runways, 50)
  const genMs = performance.now() - t0
  const polys = config.polygons
  flat.setFlatteningPolygons(polys)
  t0 = performance.now()
  flat.setFlatteningPolygons(polys)
  const setMs = performance.now() - t0
  const counts = polys.reduce<Record<string, number>>((a, p) => ({ ...a, [p.source]: (a[p.source] ?? 0) + 1 }), {})
  const fill = polys.find((p) => p.source === 'fill')
  out(`polygons: ${JSON.stringify(counts)} fill.useFieldElevation=${fill?.useFieldElevation} generate=${genMs.toFixed(1)}ms setFlatteningPolygons=${setMs.toFixed(1)}ms`)
  result.polygonCounts = counts
  result.generateMs = genMs
  result.setMs = setMs
  if (polys.length === 0) return result
  const idx = indexPolys(polys)
  const [w, s, e, n] = config.bounds
  const lon0 = (w + e) / 2
  const lat0 = (s + n) / 2

  // ---- A. threshold datum: published elevation (EGM96 -> ellipsoid) vs raw CWT ----
  const thr: [number, number][] = []
  const thrElev: number[] = []
  const thrName: string[] = []
  for (const r of runways) {
    for (const end of [r.lowEnd, r.highEnd]) {
      thr.push([end.lon, end.lat])
      thrElev.push(geoidService.mslToEllipsoidal(end.lat, end.lon, end.elevationFt * 0.3048))
      thrName.push(end.ident)
    }
  }
  const thrRaw = await sampleMost(raw, thr)
  const thrRows = thr.map((_, i) => `${thrName[i]}: published=${f1(thrElev[i])} rawCWT=${f1(thrRaw[i])} diff(raw-pub)=${f1(thrRaw[i] - thrElev[i])}`)
  out(`A thresholds (ellipsoidal m): ${thrRows.join(' | ')}`)
  result.thresholds = thr.map((_, i) => ({ end: thrName[i], published: thrElev[i], raw: thrRaw[i] }))

  // ---- B/C. per-runway longitudinal + cross profiles ----
  const runwayProfiles: Record<string, unknown>[] = []
  for (const r of runways) {
    const a = r.lowEnd
    const b = r.highEnd
    const [bx, by] = enu(b.lon, b.lat, a.lon, a.lat)
    const len = Math.hypot(bx, by)
    const ux = bx / len
    const uy = by / len
    // Longitudinal: 101 points on the centerline
    const cl: [number, number][] = []
    for (let i = 0; i <= 100; i++) cl.push(fromEnu(ux * len * (i / 100), uy * len * (i / 100), a.lon, a.lat))
    const clRaw = await sampleMost(raw, cl)
    const clFlat = await sampleMost(flat, cl)
    const hdg = (Math.atan2(ux, uy) * 180) / Math.PI
    const clAna = cl.map(([lon, lat]) => flat.getHeightAndSlopeAtPosition(lon, lat, hdg)?.height ?? NaN)
    const za = geoidService.mslToEllipsoidal(a.lat, a.lon, a.elevationFt * 0.3048)
    const zb = geoidService.mslToEllipsoidal(b.lat, b.lon, b.elevationFt * 0.3048)
    const linear = cl.map((_, i) => za + (zb - za) * (i / 100))
    const meshVsAna = stats(clFlat.map((h, i) => Math.abs(h - clAna[i])).filter(Number.isFinite))
    const meshVsLinear = stats(clFlat.map((h, i) => Math.abs(h - linear[i])))
    const rawVsLinear = clRaw.map((h, i) => h - linear[i])
    const rawDev = stats(rawVsLinear.map(Math.abs))
    out(`B ${r.ident} len=${len.toFixed(0)}m published ${f1(za)}->${f1(zb)} (delta ${f1(zb - za)}m) | centerline |mesh-analytic| ${fs1(meshVsAna)} | |mesh-linear| ${fs1(meshVsLinear)} | raw-linear: min=${f1(Math.min(...rawVsLinear))} max=${f1(Math.max(...rawVsLinear))}`)

    // Cross sections at 25/50/75 %: offsets -300..+300 m step 5 m
    const cross: Record<string, unknown>[] = []
    for (const frac of [0.25, 0.5, 0.75]) {
      const pts: [number, number][] = []
      const offs: number[] = []
      for (let o = -300; o <= 300; o += 5) {
        offs.push(o)
        pts.push(fromEnu(ux * len * frac + -uy * o, uy * len * frac + ux * o, a.lon, a.lat))
      }
      const hr = await sampleMost(raw, pts)
      const hf = await sampleMost(flat, pts)
      const ha = pts.map(([lon, lat]) => flat.getHeightAndSlopeAtPosition(lon, lat, hdg)?.height ?? NaN)
      let maxStep = 0
      let maxStepAt = 0
      let maxRawStep = 0
      for (let i = 1; i < hf.length; i++) {
        const d = Math.abs(hf[i] - hf[i - 1])
        if (d > maxStep) { maxStep = d; maxStepAt = offs[i] }
        maxRawStep = Math.max(maxRawStep, Math.abs(hr[i] - hr[i - 1]))
      }
      const meshAna = stats(hf.map((h, i) => Math.abs(h - ha[i])).filter(Number.isFinite))
      const centreIdx = offs.indexOf(0)
      out(`C ${r.ident} @${frac * 100}%: centre raw=${f1(hr[centreIdx])} flat=${f1(hf[centreIdx])} | max 5m-step flat=${f1(maxStep)}m at offset ${maxStepAt}m (raw max 5m-step ${f1(maxRawStep)}) | |mesh-analytic| ${fs1(meshAna)}`)
      cross.push({ frac, offs, raw: hr, flat: hf, analytic: ha })
    }

    // J. degree-space projection error (getGradientElevation projects in raw lon/lat degrees)
    const half = (r.widthFt * 0.3048) / 2 + 75
    const projErr: number[] = []
    for (const frac of [0.1, 0.5, 0.9]) {
      for (const lat of [r.widthFt * 0.3048 / 2, half]) {
        const [lon, la] = fromEnu(ux * len * frac - uy * lat, uy * len * frac + ux * lat, a.lon, a.lat)
        const dx = b.lon - a.lon
        const dy = b.lat - a.lat
        const tDeg = Math.max(0, Math.min(1, ((lon - a.lon) * dx + (la - a.lat) * dy) / (dx * dx + dy * dy)))
        projErr.push((tDeg - frac) * (zb - za))
      }
    }
    out(`J ${r.ident} degree-space gradient error (frac 0.1/0.5/0.9 x runway edge/polygon edge): ${projErr.map(f1).join(', ')} m`)

    // E. LOD: centerline heights at coarse levels vs most-detailed
    const lodRows: string[] = []
    const lods: Record<string, unknown> = {}
    for (const level of [10, 11, 12, 13, 14]) {
      try {
        const lf = await sampleLevel(flat, level, cl)
        const lr = await sampleLevel(raw, level, cl)
        const devFlat = stats(lf.map((h, i) => Math.abs(h - clAna[i])).filter(Number.isFinite))
        const devRaw = stats(lr.map((h, i) => Math.abs(h - clRaw[i])).filter(Number.isFinite))
        lodRows.push(`L${level}: flat|h-analytic| p95=${f1(devFlat.p95)} max=${f1(devFlat.max)}; raw|hL-hMax| p95=${f1(devRaw.p95)} max=${f1(devRaw.max)}`)
        lods[level] = { devFlat, devRaw }
      } catch (err) {
        lodRows.push(`L${level}: ${String(err).slice(0, 80)}`)
      }
    }
    out(`E ${r.ident} centerline by LOD: ${lodRows.join(' | ')}`)
    runwayProfiles.push({ ident: r.ident, len, za, zb, clRaw, clFlat, clAna, cross, projErr, lods })
  }
  result.runways = runwayProfiles

  // ---- G. crossing runways: analytic (first runway) vs mesh (average of both) ----
  for (let i = 0; i < runways.length; i++) {
    for (let j = i + 1; j < runways.length; j++) {
      const r1 = runways[i]
      const r2 = runways[j]
      const p = [r1.lowEnd, r1.highEnd, r2.lowEnd, r2.highEnd].map((q) => enu(q.lon, q.lat, lon0, lat0))
      const d1 = [p[1][0] - p[0][0], p[1][1] - p[0][1]]
      const d2 = [p[3][0] - p[2][0], p[3][1] - p[2][1]]
      const den = d1[0] * d2[1] - d1[1] * d2[0]
      if (Math.abs(den) < 1e-9) continue
      const t = ((p[2][0] - p[0][0]) * d2[1] - (p[2][1] - p[0][1]) * d2[0]) / den
      const u = ((p[2][0] - p[0][0]) * d1[1] - (p[2][1] - p[0][1]) * d1[0]) / den
      if (t < 0 || t > 1 || u < 0 || u > 1) continue
      const [lon, lat] = fromEnu(p[0][0] + t * d1[0], p[0][1] + t * d1[1], lon0, lat0)
      const z1a = geoidService.mslToEllipsoidal(r1.lowEnd.lat, r1.lowEnd.lon, r1.lowEnd.elevationFt * 0.3048)
      const z1b = geoidService.mslToEllipsoidal(r1.highEnd.lat, r1.highEnd.lon, r1.highEnd.elevationFt * 0.3048)
      const z2a = geoidService.mslToEllipsoidal(r2.lowEnd.lat, r2.lowEnd.lon, r2.lowEnd.elevationFt * 0.3048)
      const z2b = geoidService.mslToEllipsoidal(r2.highEnd.lat, r2.highEnd.lon, r2.highEnd.elevationFt * 0.3048)
      const h1 = z1a + t * (z1b - z1a)
      const h2 = z2a + u * (z2b - z2a)
      const [mesh] = await sampleMost(flat, [[lon, lat]])
      const ana0 = flat.getHeightAndSlopeAtPosition(lon, lat, 0)?.height
      // Walk along runway 2 through the crossing to find the step at the edge of runway 1's polygon
      const walk: [number, number][] = []
      const [cx, cy] = enu(lon, lat, lon0, lat0)
      const L2 = Math.hypot(d2[0], d2[1])
      for (let o = -400; o <= 400; o += 5) walk.push(fromEnu(cx + (d2[0] / L2) * o, cy + (d2[1] / L2) * o, lon0, lat0))
      const hw = await sampleMost(flat, walk)
      let maxStep = 0
      for (let k = 1; k < hw.length; k++) maxStep = Math.max(maxStep, Math.abs(hw[k] - hw[k - 1]))
      const anaWalk = walk.map(([lo, la]) => flat.getHeightAndSlopeAtPosition(lo, la, 0)?.height ?? NaN)
      const worstAna = stats(hw.map((h, k) => Math.abs(h - anaWalk[k])).filter(Number.isFinite))
      out(`G crossing ${r1.ident} x ${r2.ident} at ${lat.toFixed(5)},${lon.toFixed(5)}: rwy1 gradient=${f1(h1)} rwy2 gradient=${f1(h2)} (diff ${f1(h1 - h2)}) mesh=${f1(mesh)} analytic(aircraft)=${f1(ana0 ?? NaN)} | walk along ${r2.ident}: max 5m step ${f1(maxStep)} m, |mesh-analytic| ${fs1(worstAna)}`)
    }
  }

  // ---- D. grid over the airport ----
  const [gx0, gy0] = enu(w, s, lon0, lat0)
  const [gx1, gy1] = enu(e, n, lon0, lat0)
  const grid: [number, number][] = []
  const gxN = Math.ceil((gx1 - gx0 + 300) / GRID_M)
  const gyN = Math.ceil((gy1 - gy0 + 300) / GRID_M)
  for (let iy = 0; iy <= gyN; iy++) for (let ix = 0; ix <= gxN; ix++) grid.push(fromEnu(gx0 - 150 + ix * GRID_M, gy0 - 150 + iy * GRID_M, lon0, lat0))
  out(`D grid ${gxN + 1}x${gyN + 1} = ${grid.length} points @${GRID_M}m`)
  const gRaw = await sampleMost(raw, grid)
  const gFlat = await sampleMost(flat, grid)
  t0 = performance.now()
  const gAna = grid.map(([lon, lat]) => flat.getHeightAndSlopeAtPosition(lon, lat, 0)?.height ?? NaN)
  const anaMs = performance.now() - t0
  const cats: Record<string, { meshAna: number[]; flatRaw: number[]; worst: { d: number; lon: number; lat: number } }> = {}
  const add = (c: string, meshAna: number, flatRaw: number, lon: number, lat: number) => {
    cats[c] ??= { meshAna: [], flatRaw: [], worst: { d: 0, lon: 0, lat: 0 } }
    if (Number.isFinite(meshAna)) {
      cats[c].meshAna.push(meshAna)
      if (meshAna > cats[c].worst.d) cats[c].worst = { d: meshAna, lon, lat }
    }
    cats[c].flatRaw.push(flatRaw)
  }
  for (let i = 0; i < grid.length; i++) {
    const [lon, lat] = grid[i]
    const m = membership(lon, lat, idx)
    const c = m.has('runway') ? 'runway' : m.has('taxiway') ? 'taxiway' : m.has('fill') ? 'fill-only' : 'outside'
    add(c, Math.abs(gFlat[i] - gAna[i]), gFlat[i] - gRaw[i], lon, lat)
  }
  const gridOut: Record<string, unknown> = {}
  for (const [c, v] of Object.entries(cats)) {
    const fr = stats(v.flatRaw.map(Math.abs))
    const cut = Math.min(...v.flatRaw)
    const raise = Math.max(...v.flatRaw)
    out(`D ${c}: |mesh-analytic| ${fs1(stats(v.meshAna))} worst at ${v.worst.lat.toFixed(5)},${v.worst.lon.toFixed(5)} | flat-raw: |.| ${fs1(fr)} most cut ${f1(cut)} most raised ${f1(raise)}`)
    gridOut[c] = { meshAna: stats(v.meshAna), flatRawAbs: fr, cut, raise, worst: v.worst }
  }
  // steepest grid step introduced by flattening
  let worstStep = { d: 0, rawD: 0, lon: 0, lat: 0 }
  const W = gxN + 1
  for (let i = 0; i < grid.length; i++) {
    for (const j of [i + 1, i + W]) {
      if (j >= grid.length || (j === i + 1 && (i + 1) % W === 0)) continue
      const d = Math.abs(gFlat[j] - gFlat[i])
      const rd = Math.abs(gRaw[j] - gRaw[i])
      if (d - rd > worstStep.d - worstStep.rawD) worstStep = { d, rawD: rd, lon: grid[i][0], lat: grid[i][1] }
    }
  }
  out(`D steepest added step over ${GRID_M}m: flat ${f1(worstStep.d)} m vs raw ${f1(worstStep.rawD)} m at ${worstStep.lat.toFixed(5)},${worstStep.lon.toFixed(5)}`)
  out(`D getHeightAndSlopeAtPosition: ${(anaMs / grid.length * 1000).toFixed(1)} us/call over ${grid.length} calls`)
  result.grid = gridOut
  result.worstStep = worstStep
  fs.writeFileSync(path.join(OUT, `grid-${icao}.json`), JSON.stringify({ gxN, gyN, step: GRID_M, grid, gRaw, gFlat, gAna, polys, runways }))

  // ---- F. bounding volumes / childTileMask on processed tiles ----
  const ts = raw.tilingScheme
  const bvRows: string[] = []
  let maskChanged = 0
  let tilesSeen = 0
  let worstAbove = 0
  let worstBelow = 0
  let sameObb = 0
  let modifiedTiles = 0
  const cpu: number[] = []
  const cpuVerts: number[] = []
  for (const level of [10, 11, 12, 13, 14, 15]) {
    const nw = ts.positionToTileXY(Cesium.Cartographic.fromDegrees(w, n), level)
    const se = ts.positionToTileXY(Cesium.Cartographic.fromDegrees(e, s), level)
    if (!nw || !se) continue
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        if (raw.getTileDataAvailable(x, y, level) === false) continue
        let rd: Cesium.TerrainData | undefined
        let fd: Cesium.TerrainData | undefined
        try {
          rd = await raw.requestTileGeometry(x, y, level)
          fd = await flat.requestTileGeometry(x, y, level)
        } catch {
          continue
        }
        if (!rd || !fd) continue
        tilesSeen++
        const R = rd as unknown as Record<string, unknown>
        const F = fd as unknown as Record<string, unknown>
        const qf = F._quantizedVertices as Uint16Array
        const qr = R._quantizedVertices as Uint16Array
        let same = F._minimumHeight === R._minimumHeight && F._maximumHeight === R._maximumHeight && qf.length === qr.length
        for (let k = 0; same && k < qf.length; k++) if (qf[k] !== qr[k]) same = false
        if (same) continue
        modifiedTiles++
        const above = (F._maximumHeight as number) - (R._maximumHeight as number)
        const below = (R._minimumHeight as number) - (F._minimumHeight as number)
        worstAbove = Math.max(worstAbove, above)
        worstBelow = Math.max(worstBelow, below)
        if (Cesium.OrientedBoundingBox.equals(F._orientedBoundingBox as Cesium.OrientedBoundingBox, R._orientedBoundingBox as Cesium.OrientedBoundingBox)) sameObb++
        if (F._childTileMask !== R._childTileMask) maskChanged++
        // CPU cost: replay this raw tile through a stub-backed wrapper with the same polygons
        stubBase.tiles.set(`${x}/${y}/${level}`, rd)
        stubFlat.setFlatteningPolygons(polys)
        const c0 = performance.now()
        await stubFlat.requestTileGeometry(x, y, level)
        cpu.push(performance.now() - c0)
        cpuVerts.push((R._quantizedVertices as Uint16Array).length / 3)
      }
    }
    bvRows.push(`L${level}`)
  }
  out(`F tiles seen ${tilesSeen} (levels 10-15), rewritten by flattening ${modifiedTiles}; flattened max above original max: ${f1(worstAbove)} m; below original min: ${f1(worstBelow)} m; rewritten tiles that kept the original OBB: ${sameObb}/${modifiedTiles}; childTileMask changed: ${maskChanged}/${modifiedTiles}`)
  const cs = stats(cpu)
  out(`H per-tile flattening CPU (main thread, replayed): ${fs1(cs)} ms; vertices/tile p50=${stats(cpuVerts).p50} max=${stats(cpuVerts).max}`)
  result.bv = { tilesSeen, modifiedTiles, worstAbove, worstBelow, sameObb, maskChanged }
  result.cpu = cs

  // ---- I. processed-tile cache hands back the same object ----
  const probe = ts.positionToTileXY(Cesium.Cartographic.fromDegrees(lon0, lat0), 13)
  if (probe) {
    const a1 = await flat.requestTileGeometry(probe.x, probe.y, 13)
    const a2 = await flat.requestTileGeometry(probe.x, probe.y, 13)
    out(`I same tile requested twice through the wrapper returns the same object: ${a1 === a2}`)
    result.sameObject = a1 === a2
  }
  return result
}

it('measures flattening', async () => {
  loadToken()
  const csv = fs.readFileSync(path.join(ROOT, 'src-tauri', 'resources', 'runways.csv'), 'utf8')
  ;(runwayService as unknown as { parseCSV: (t: string) => unknown }).parseCSV(csv)
  airportSurfacesService.loadFromData(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src-tauri', 'resources', 'airport-surfaces.json.gz'))).toString('utf8')))
  const raw = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  const flatBase = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  const flat = createFlatteningTerrainProvider(flatBase)
  const stubProv = await Cesium.CesiumTerrainProvider.fromIonAssetId(1)
  const stubBase = { tiles: new Map<string, Cesium.TerrainData>() }
  stubProv.requestTileGeometry = (x: number, y: number, level: number) => Promise.resolve(stubBase.tiles.get(`${x}/${y}/${level}`) as Cesium.TerrainData)
  const stubFlat = createFlatteningTerrainProvider(stubProv)
  const results: Record<string, unknown>[] = []
  for (const icao of AIRPORTS) {
    try {
      results.push(await measureAirport(icao, raw, flat, stubFlat, stubBase))
    } catch (err) {
      out(`${icao}: FAILED ${String((err as Error).stack ?? err)}`)
    }
    fs.writeFileSync(path.join(OUT, 'measure-summary.log'), log.join('\n'))
  }
  fs.writeFileSync(path.join(OUT, 'measure-results.json'), JSON.stringify(results))
})
