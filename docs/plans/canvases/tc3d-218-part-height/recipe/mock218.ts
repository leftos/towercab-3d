// Scratch-tree mock harness for TC3D-218 (never shipped). Imported from browser_evaluate.
import * as C from 'cesium'
import { LANES_218 } from '@/utils/buildingStyle'

type Lane = 'A' | 'B' | 'C'
// biome-ignore lint/suspicious/noExplicitAny: scratch harness
type Any = any

const M_PER_DEG = 111320

function t(): Any {
  return (window as Any).__tc3d
}

export function tileset(): Any {
  const prims = t().viewer.scene.primitives
  for (let i = 0; i < prims.length; i++) {
    const p = prims.get(i)
    if (p instanceof C.Cesium3DTileset) return p
  }
  return undefined
}

async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(null)))
}

export function setLane(lane: Lane): void {
  ;(globalThis as Any).__lane218 = lane
  tileset().makeStyleDirty()
}

export function setup(hour = 12): void {
  t().stores.settings.getState().updateCesiumSettings({
    show3DBuildings: true,
    buildingQuality: 'high',
    timeMode: 'fixed',
    fixedTimeHour: hour,
  })
}

export async function selectAirport(icao: string): Promise<number> {
  const { useAirportStore } = await import('@/stores/airportStore')
  for (let i = 0; i < 120 && useAirportStore.getState().airports.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 500))
  }
  useAirportStore.getState().selectAirport(icao)
  return useAirportStore.getState().airports.size
}

/** Tower-relative pose (dx/dy/dz offsets) or absolute lat/lon/h (ellipsoid metres). */
export async function pose(p: Any): Promise<number> {
  const vs = t().stores.viewport.getState()
  vs.setPositionOffsetX(0)
  vs.setPositionOffsetY(0)
  vs.setPositionOffsetZ(0)
  await frames(4)
  if (p.lat === undefined) {
    vs.setPositionOffsetX(p.dx ?? 0)
    vs.setPositionOffsetY(p.dy ?? 0)
    vs.setPositionOffsetZ(p.dz ?? 0)
    t().camera.set({ heading: p.heading, pitch: p.pitch, fov: p.fov })
    await frames(30)
    return 0
  }
  const c = t().viewer.camera.positionCartographic
  const baseLat = C.Math.toDegrees(c.latitude)
  const baseLon = C.Math.toDegrees(c.longitude)
  vs.setPositionOffsetX((p.lon - baseLon) * M_PER_DEG * Math.cos((baseLat * Math.PI) / 180))
  vs.setPositionOffsetY((p.lat - baseLat) * M_PER_DEG)
  vs.setPositionOffsetZ(p.h - c.height)
  t().camera.set({ heading: p.heading, pitch: p.pitch, fov: p.fov })
  const target = C.Cartesian3.fromDegrees(p.lon, p.lat, p.h)
  for (let round = 0; round < 4; round++) {
    let last = new C.Cartesian3()
    for (let i = 0; i < 120; i++) {
      await frames(2)
      const now = t().viewer.camera.positionWC
      if (C.Cartesian3.distance(now, target) < 0.5 || C.Cartesian3.distance(now, last) < 0.01) break
      last = C.Cartesian3.clone(now)
    }
    const a = t().viewer.camera.positionCartographic
    const s = vs.getActiveCameraState()
    const errY = (p.lat - C.Math.toDegrees(a.latitude)) * M_PER_DEG
    const errX = (p.lon - C.Math.toDegrees(a.longitude)) * M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)
    const errZ = p.h - a.height
    if (Math.hypot(errX, errY, errZ) < 0.5) break
    vs.setPositionOffsetX(s.positionOffsetX + errX)
    vs.setPositionOffsetY(s.positionOffsetY + errY)
    vs.setPositionOffsetZ(s.positionOffsetZ + errZ)
  }
  return C.Cartesian3.distance(t().viewer.camera.positionWC, target)
}

export function camera(): Any {
  const cam = t().viewer.camera
  const c = cam.positionCartographic
  return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude), h: c.height, ...t().camera.get() }
}

export async function settle(timeoutMs = 90000): Promise<boolean> {
  const t0 = performance.now()
  let stable = 0
  while (performance.now() - t0 < timeoutMs) {
    const ts = tileset()
    const done = ts?.tilesLoaded && t().viewer.scene.globe.tilesLoaded
    stable = done ? stable + 1 : 0
    if (stable >= 6) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const TAGS = [
  'elementId',
  'part#elementId',
  'name',
  'building',
  'building:part',
  'part#building:part',
  'part#building:levels',
  'part#height',
  'part#min_height',
  'part#building:min_level',
  'part#roof:height',
  'building:levels',
  'height',
  'min_height',
  'roof:height',
  'cesium#estimatedHeight',
]

function round(v: number): number | null {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null
}

/** Features of the selected tiles whose element or part id is in `ids` (all with `ids` empty and inView). */
export function features(ids: string[] = [], inView = false): Any[] {
  const viewer = t().viewer
  const ts = tileset()
  const want = new Set(ids.map(String))
  const seen = new Set<string>()
  const out: Any[] = []
  for (const tile of ts._selectedTiles ?? []) {
    const content = tile.content
    for (let i = 0; i < (content?.featuresLength ?? 0); i++) {
      const f = content.getFeature(i)
      const el = String(f.getProperty('elementId'))
      const part = f.getProperty('part#elementId')
      const key = `${el}/${part ?? ''}`
      if (seen.has(key)) continue
      if (want.size > 0 && !want.has(el) && !want.has(String(part))) continue
      const lat = Number(f.getProperty('cesium#latitude'))
      const lon = Number(f.getProperty('cesium#longitude'))
      const ground = Number(f.getProperty('cesium#estimatedHeight')) / 2
      const w = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, C.Cartesian3.fromDegrees(lon, lat, ground))
      const onScreen =
        w !== undefined && w.x >= 0 && w.y >= 0 && w.x <= viewer.canvas.clientWidth && w.y <= viewer.canvas.clientHeight
      if (inView && !onScreen) continue
      seen.add(key)
      const row: Any = { onScreen, x: w ? Math.round(w.x) : null, y: w ? Math.round(w.y) : null }
      for (const tag of TAGS) {
        const v = f.getProperty(tag)
        if (v !== undefined && v !== null && v !== '') row[tag] = v
      }
      for (const lane of ['A', 'B', 'C'] as const) {
        const r = LANES_218[lane](f)
        row[lane] = { storeys: r.storeys, wallM: round(r.wallM) }
      }
      out.push(row)
    }
  }
  return out
}

function rowOf(f: Any): Any {
  const row: Any = {}
  for (const tag of TAGS) {
    const v = f.getProperty(tag)
    if (v !== undefined && v !== null && v !== '') row[tag] = v
  }
  for (const lane of ['A', 'B', 'C'] as const) {
    const r = LANES_218[lane](f)
    row[lane] = { storeys: r.storeys, wallM: round(r.wallM) }
  }
  return row
}

/** Features under a pick grid over the canvas, with how many grid cells each covers. */
export function onScreen(step = 24): Any[] {
  const viewer = t().viewer
  const w = viewer.canvas.clientWidth
  const h = viewer.canvas.clientHeight
  const byKey = new Map<string, Any>()
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const f = viewer.scene.pick(new C.Cartesian2(x, y))
      if (!(f instanceof C.Cesium3DTileFeature)) continue
      const key = `${f.getProperty('elementId')}/${f.getProperty('part#elementId') ?? ''}`
      const hit = byKey.get(key)
      if (hit) {
        hit.cells++
        hit.sx += x
        hit.sy += y
      } else byKey.set(key, { f, cells: 1, sx: x, sy: y })
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.cells - a.cells)
    .map((e) => ({ cells: e.cells, x: Math.round(e.sx / e.cells), y: Math.round(e.sy / e.cells), ...rowOf(e.f) }))
}

function same(a: Any, b: Any): boolean {
  return a.storeys === b.storeys && a.wallM === b.wallM
}

/** The storey height the shader draws from packed storeys and wall, or 'default' (grammar storey). */
function drawnStorey(r: Any): number | string {
  const code = (v: number | null): number => (v === null || !Number.isFinite(v) ? 0 : Math.min(Math.max(Math.round(v), 0), 27))
  const storeys = code(r.storeys)
  const wall = code(r.wallM === null ? null : r.wallM / 2) * 2
  if (storeys < 1 || wall < 1 || wall > 53) return 'default'
  return Math.round(Math.min(Math.max(wall / storeys, 2.4), 6) * 100) / 100
}

/** Over every selected tile: part tag census and the features where the lanes disagree. */
export function scan(near?: { lat: number; lon: number; r: number }): Any {
  const ts = tileset()
  const census = {
    features: 0,
    parts: 0,
    both: 0,
    levelsOnly: 0,
    heightOnly: 0,
    neither: 0,
    nonPartWithPartTags: 0,
    diffAB: 0,
    diffAC: 0,
    diffBC: 0,
    drawnAB: 0,
    drawnAC: 0,
  }
  const diffs: Any[] = []
  const seen = new Set<string>()
  for (const tile of ts._selectedTiles ?? []) {
    const content = tile.content
    for (let i = 0; i < (content?.featuresLength ?? 0); i++) {
      const f = content.getFeature(i)
      const key = `${f.getProperty('elementId')}/${f.getProperty('part#elementId') ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      if (near) {
        const dy = (Number(f.getProperty('cesium#latitude')) - near.lat) * M_PER_DEG
        const dx = (Number(f.getProperty('cesium#longitude')) - near.lon) * M_PER_DEG * Math.cos((near.lat * Math.PI) / 180)
        if (!(Math.hypot(dx, dy) <= near.r)) continue
      }
      census.features++
      const part = f.getProperty('part#elementId')
      const ownTag = f.getProperty('part#building:levels') ?? f.getProperty('part#height')
      if ((part === undefined || part === null) && ownTag !== undefined && ownTag !== null) census.nonPartWithPartTags++
      if (part !== undefined && part !== null) {
        census.parts++
        const l = Number.isFinite(Number.parseFloat(f.getProperty('part#building:levels')))
        const hh = Number.isFinite(Number.parseFloat(f.getProperty('part#height')))
        if (l && hh) census.both++
        else if (l) census.levelsOnly++
        else if (hh) census.heightOnly++
        else census.neither++
      }
      const row = rowOf(f)
      for (const lane of ['A', 'B', 'C'] as const) row[lane].drawn = drawnStorey(row[lane])
      if (row.A.drawn !== row.B.drawn) census.drawnAB++
      if (row.A.drawn !== row.C.drawn) census.drawnAC++
      const ab = !same(row.A, row.B)
      const ac = !same(row.A, row.C)
      const bc = !same(row.B, row.C)
      if (ab) census.diffAB++
      if (ac) census.diffAC++
      if (bc) census.diffBC++
      if (ab || ac || bc) diffs.push(row)
    }
  }
  return { census, diffs }
}

export function pick(x: number, y: number): Any {
  const picked = t().viewer.scene.pick(new C.Cartesian2(x, y))
  if (!picked || !(picked instanceof C.Cesium3DTileFeature)) return null
  return { elementId: picked.getProperty('elementId'), part: picked.getProperty('part#elementId') }
}
