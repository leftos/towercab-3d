// Writes plans/m3-<icao>.json (shape-fallback colour maps) and plans/m1-koak.json (KOAK floor lanes).
import fs from 'node:fs'

const ARP = { KSFO: [37.6189, -122.375], KOAK: [37.7213, -122.2208] }
const SETS = {
  A: { hangar: { minArea: 3000, maxHeight: 15 }, mid: { minArea: 2000, minLevels: 4, maxLevels: 8 } },
  B: { hangar: { minArea: 1500, maxHeight: 20 }, mid: { minArea: 1000, minLevels: 4, maxLevels: 8 } },
  C: { hangar: { minArea: 600, maxHeight: 25 }, mid: { minArea: 500, minLevels: 4, maxLevels: 8 } },
}
const RADIUS_M = 3000
for (const icao of ['KSFO', 'KOAK']) {
  const osm = JSON.parse(fs.readFileSync(`aerodrome-${icao}.json`, 'utf8'))
  const rings = osm.elements.filter((e) => e.geometry).map((e) => e.geometry.map((g) => [g.lon, g.lat]))
  const [lat, lon] = ARP[icao]
  const polygon = { kind: 'polygon', rings }
  const radius = { kind: 'radius', lat, lon, radiusM: RADIUS_M }
  const overlay = { rings, circle: { lat, lon, r: RADIUS_M } }
  const cat = (set, inside) => ({ inside, ...SETS[set], lookupParents: ['15730419'] })
  const u = { u_mockDebug: 1, sse: 2, globeSse: 0.5 }
  const pose = { topdown: 6500, lat, lon, heading: 0 }
  const shots = ['A', 'B', 'C'].map((set) => ({ name: `m3-${icao}-${set}-poly`, uniforms: u, category: cat(set, polygon), features: true, overlay }))
  shots[0].pose = pose
  shots.push({ name: `m3-${icao}-B-radius`, uniforms: u, category: cat('B', radius), features: true, overlay })
  fs.writeFileSync(`plans/m3-${icao}.json`, JSON.stringify({ airport: icao, hour: 12, viewport: { width: 1280, height: 1000 }, shots }, null, 1))
}
const koak = [
  { name: 'm1-koak-today', pose: { lat: 37.71046, lon: -122.21022, h: -25.7, heading: 255, pitch: 1, fov: 16 } },
  { name: 'm1-koak-base', uniforms: { u_mockFloor: 1 } },
  { name: 'm1-koak-roof', uniforms: { u_mockFloor: 2 } },
]
fs.writeFileSync('plans/m1-koak.json', JSON.stringify({ airport: 'KOAK', hour: 12, shots: koak }, null, 1))
