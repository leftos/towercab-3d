// Scan runways.csv and airport-surfaces.json.gz for inputs that break flattening.
import fs from 'node:fs'
import zlib from 'node:zlib'

const root = process.argv[2]
const csv = fs.readFileSync(`${root}/src-tauri/resources/runways.csv`, 'utf8')
const surfaces = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${root}/src-tauri/resources/airport-surfaces.json.gz`)).toString('utf8'))

function parseLine(line) {
  const out = []
  let cur = ''
  let q = false
  for (const ch of line) {
    if (ch === '"') q = !q
    else if (ch === ',' && !q) { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  out.push(cur.trim())
  return out
}
const lines = csv.split('\n')
const hdr = parseLine(lines[0])
const ix = Object.fromEntries(hdr.map((h, i) => [h, i]))
const byApt = new Map()
for (let i = 1; i < lines.length; i++) {
  if (!lines[i].trim()) continue
  const v = parseLine(lines[i])
  if (v[ix.closed] === '1') continue
  const r = {
    apt: v[ix.airport_ident].toUpperCase(),
    ident: `${v[ix.le_ident]}/${v[ix.he_ident]}`,
    leLat: parseFloat(v[ix.le_latitude_deg]) || 0, leLon: parseFloat(v[ix.le_longitude_deg]) || 0,
    heLat: parseFloat(v[ix.he_latitude_deg]) || 0, heLon: parseFloat(v[ix.he_longitude_deg]) || 0,
    leElevRaw: v[ix.le_elevation_ft], heElevRaw: v[ix.he_elevation_ft],
    leHdgRaw: v[ix.le_heading_degT], heHdgRaw: v[ix.he_heading_degT],
    width: parseFloat(v[ix.width_ft]) || 0, length: parseFloat(v[ix.length_ft]) || 0, surface: v[ix.surface],
  }
  if (!v[ix.le_ident] || !v[ix.he_ident]) continue
  if (!(r.leLat || r.leLon) || !(r.heLat || r.heLon)) continue // getRunwaysWithCoordinates
  if (!byApt.has(r.apt)) byApt.set(r.apt, [])
  byApt.get(r.apt).push(r)
}

let missingElevRunways = 0
const missingElevAirports = []
let missingHdg = 0
let zeroWidth = 0
for (const [apt, rws] of byApt) {
  const withSurf = apt in surfaces.airports
  for (const r of rws) {
    const leMissing = r.leElevRaw === '', heMissing = r.heElevRaw === ''
    if (leMissing || heMissing) {
      missingElevRunways++
      const other = leMissing ? parseFloat(r.heElevRaw) : parseFloat(r.leElevRaw)
      missingElevAirports.push({ apt, ident: r.ident, leMissing, heMissing, other, withSurf, aptElev: surfaces.airports[apt]?.e })
    }
    if (r.leHdgRaw === '' || r.heHdgRaw === '') missingHdg++
    if (r.width === 0) zeroWidth++
  }
}
const rwyCount = [...byApt.values()].reduce((a, b) => a + b.length, 0)
console.log(`airports with coord runways: ${byApt.size}, runways: ${rwyCount}`)
console.log(`runways with >=1 end elevation missing (parsed as 0 ft): ${missingElevRunways}`)
const withSurfMissing = missingElevAirports.filter((m) => m.withSurf)
console.log(`  of which at airports with apt.dat pavements: ${withSurfMissing.length}`)
const big = withSurfMissing
  .map((m) => ({ ...m, err: Number.isFinite(m.other) ? m.other : m.aptElev }))
  .filter((m) => Number.isFinite(m.err))
  .sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
console.log('  worst (end elevation forced to 0 ft vs other end / apt elevation, ft):')
for (const m of big.slice(0, 15)) console.log(`   ${m.apt} ${m.ident} leMissing=${m.leMissing} heMissing=${m.heMissing} other=${m.other} aptElev=${m.aptElev}`)
const icaoLike = withSurfMissing.filter((m) => /^[A-Z]{4}$/.test(m.apt) && /^(K|Y|E|L|C|R|Z|V|W|S|F|O|U|N|M|P|D|H|T|G|B|A)/.test(m.apt))
console.log(`  4-letter idents among them: ${icaoLike.length}; sample: ${icaoLike.slice(0, 25).map((m) => `${m.apt}(${m.ident})`).join(' ')}`)
console.log(`runways with a missing heading (falls back to ident*10, magnetic): ${missingHdg}`)
console.log(`runways with width 0: ${zeroWidth}`)

// Sloped airports: threshold spread among airports with pavements and >= 2000 m runway
const spreads = []
for (const [apt, rws] of byApt) {
  if (!(apt in surfaces.airports)) continue
  const el = []
  let maxLen = 0
  for (const r of rws) {
    if (r.leElevRaw !== '') el.push(parseFloat(r.leElevRaw))
    if (r.heElevRaw !== '') el.push(parseFloat(r.heElevRaw))
    maxLen = Math.max(maxLen, r.length)
  }
  if (el.length < 2 || maxLen < 6500) continue
  spreads.push({ apt, spreadFt: Math.max(...el) - Math.min(...el), nRwy: rws.length })
}
spreads.sort((a, b) => b.spreadFt - a.spreadFt)
console.log('largest threshold spread (ft) at airports with pavements, longest rwy >= 6500 ft:')
console.log('  ' + spreads.slice(0, 25).map((s) => `${s.apt}:${s.spreadFt}`).join(' '))
for (const a of ['YMML', 'YSSY', 'YBBN', 'YPPH', 'YBCS', 'YMHB', 'KSFO', 'KOAK', 'KATL', 'EGLL']) {
  const s = spreads.find((x) => x.apt === a)
  console.log(`  ${a}: spread ${s?.spreadFt ?? 'n/a'} ft, runways ${byApt.get(a)?.length}, pavements ${surfaces.airports[a]?.p.length}`)
}

// Surfaces: holes, self-intersections, antimeridian, tiny rings, bezier nodes
let pav = 0, withHoles = 0, holeRings = 0, antimer = 0, tiny = 0, unclosed = 0, dupConsecutive = 0
let selfX = 0
function segInt(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
}
const selfXSamples = []
for (const [apt, a] of Object.entries(surfaces.airports)) {
  for (const p of a.p) {
    pav++
    if (p.h?.length) { withHoles++; holeRings += p.h.length }
    const v = p.v
    let minLon = Infinity, maxLon = -Infinity
    for (const [lon] of v) { minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon) }
    if (maxLon - minLon > 180) antimer++
    if (v.length < 3) tiny++
    const f = v[0], l = v[v.length - 1]
    if (f[0] !== l[0] || f[1] !== l[1]) unclosed++
    for (let i = 1; i < v.length; i++) if (v[i][0] === v[i - 1][0] && v[i][1] === v[i - 1][1]) { dupConsecutive++; break }
    if (v.length <= 400 && (p.s === 'a' || p.s === 'c')) {
      const n = v.length
      let hit = false
      for (let i = 0; i < n - 1 && !hit; i++) for (let j = i + 2; j < n - 1 && !hit; j++) {
        if (i === 0 && j === n - 2) continue
        if (segInt(v[i], v[i + 1], v[j], v[j + 1])) hit = true
      }
      if (hit) { selfX++; if (selfXSamples.length < 12) selfXSamples.push(apt) }
    }
  }
}
console.log(`pavements: ${pav}, with holes: ${withHoles} (${holeRings} rings), antimeridian-spanning: ${antimer}, <3 verts: ${tiny}, unclosed exterior: ${unclosed}, with duplicate consecutive vertex: ${dupConsecutive}`)
console.log(`asphalt/concrete pavements whose exterior ring self-intersects (<=400 verts checked): ${selfX}; e.g. ${selfXSamples.join(' ')}`)
let antiAirports = 0
for (const [apt, rws] of byApt) for (const r of rws) if (Math.abs(r.leLon - r.heLon) > 180) { antiAirports++; console.log(`  runway spans antimeridian: ${apt} ${r.ident}`) }
// Airports whose runways/pavements sit near +-180
const nearAnti = Object.entries(surfaces.airports).filter(([, a]) => a.p.some((p) => p.v.some(([lon]) => Math.abs(lon) > 179.5))).map(([k]) => k)
console.log(`airports with pavement within 0.5 deg of the antimeridian: ${nearAnti.join(' ') || 'none'}`)
