// Check whether hole rings in airport-surfaces look like real holes or like linear features / boundaries.
import fs from 'node:fs'
import zlib from 'node:zlib'

const root = process.argv[2]
const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${root}/src-tauri/resources/airport-surfaces.json.gz`)).toString('utf8'))
function pip(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function area(r) {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1])
  return Math.abs(a / 2)
}
let holes = 0, outsideHoles = 0, biggerThanExterior = 0, sliver = 0
const ex = []
for (const [apt, a] of Object.entries(s.airports)) {
  for (const p of a.p) {
    for (const h of p.h ?? []) {
      holes++
      const out = h.filter(([x, y]) => !pip(x, y, p.v)).length
      if (out > 0) { outsideHoles++; if (ex.length < 15) ex.push(`${apt}(${out}/${h.length} outside)`) }
      if (area(h) > area(p.v)) biggerThanExterior++
      // perimeter^2 / area: a closed linear feature (centerline) is a sliver
      let per = 0
      for (let i = 1; i < h.length; i++) per += Math.hypot(h[i][0] - h[i - 1][0], h[i][1] - h[i - 1][1])
      if (area(h) === 0 || (per * per) / area(h) > 400) sliver++
    }
  }
}
console.log(`hole rings: ${holes}`)
console.log(`hole rings with >=1 vertex outside their exterior ring: ${outsideHoles}; e.g. ${ex.join(' ')}`)
console.log(`hole rings larger than their exterior: ${biggerThanExterior}`)
console.log(`hole rings that are slivers (perimeter^2/area > 400, i.e. look like a line, not an area): ${sliver}`)
const counts = Object.values(s.airports).map((a) => a.p.length)
console.log(`airports in file: ${counts.length}; airports with exactly 1 pavement: ${counts.filter((c) => c === 1).length}`)
for (const icao of ['YMML', 'YSSY', 'KSFO', 'KOAK', 'EGLL', 'KATL', 'KJFK', 'YBBN', 'YPPH', 'YBCS', 'YMHB']) {
  const a = s.airports[icao]
  if (!a) { console.log(`${icao}: absent`); continue }
  const hs = a.p.flatMap((p) => (p.h ?? []).map((h) => ({ p, h })))
  const bad = hs.filter(({ p, h }) => h.some(([x, y]) => !pip(x, y, p.v))).length
  console.log(`${icao}: pavements ${a.p.length}, holes ${hs.length}, holes poking outside exterior ${bad}`)
}
