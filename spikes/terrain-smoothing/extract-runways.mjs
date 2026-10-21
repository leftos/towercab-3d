// Builds spikes/terrain-smoothing/airports.json (and airports.js): the runways (OurAirports CSV),
// the paved-area bounding box (apt.dat pavements) and the EGM96 geoid height of
// each airport the measurement covers. Run from the repo root:
//   node spikes/terrain-smoothing/extract-runways.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import * as egm96 from 'egm96-universal'

const AIRPORTS = ['YMML', 'YSSY', 'YBBN', 'YPPH', 'YBCS', 'YMHB', 'YSCB', 'YMLT', 'KSFO', 'KOAK']
const FT = 0.3048

function parseCsvLine(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const csv = readFileSync('src-tauri/resources/runways.csv', 'utf8').split('\n')
const header = parseCsvLine(csv[0])
const col = Object.fromEntries(header.map((h, i) => [h, i]))
const surfaces = JSON.parse(gunzipSync(readFileSync('src-tauri/resources/airport-surfaces.json.gz')).toString())

const result = {}
for (const icao of AIRPORTS) {
  const runways = []
  for (const line of csv.slice(1)) {
    const v = parseCsvLine(line)
    if (v[col.airport_ident] !== icao || v[col.closed] === '1') continue
    const num = (k) => (v[col[k]] === '' ? null : Number(v[col[k]]))
    if (num('le_latitude_deg') === null || num('he_latitude_deg') === null) continue
    runways.push({
      id: `${v[col.le_ident]}/${v[col.he_ident]}`,
      widthM: num('width_ft') * FT,
      lengthM: num('length_ft') * FT,
      le: { ident: v[col.le_ident], lat: num('le_latitude_deg'), lon: num('le_longitude_deg'), elevFt: num('le_elevation_ft') },
      he: { ident: v[col.he_ident], lat: num('he_latitude_deg'), lon: num('he_longitude_deg'), elevFt: num('he_elevation_ft') },
    })
  }
  const apt = surfaces.airports[icao]
  let west = Infinity
  let south = Infinity
  let east = -Infinity
  let north = -Infinity
  for (const p of apt.p) {
    for (const [lon, lat] of p.v) {
      west = Math.min(west, lon)
      east = Math.max(east, lon)
      south = Math.min(south, lat)
      north = Math.max(north, lat)
    }
  }
  const lat = (south + north) / 2
  const lon = (west + east) / 2
  result[icao] = {
    name: apt.n,
    elevFt: apt.e,
    geoidM: egm96.meanSeaLevel(lat, lon),
    bbox: { west, south, east, north },
    pavements: apt.p.map((p) => ({ s: p.s, v: p.v, h: p.h })),
    runways,
  }
}
writeFileSync('spikes/terrain-smoothing/airports.json', `${JSON.stringify(result)}\n`)
// The same data as a classic script, for page.addScriptTag({ path }) in the running app
writeFileSync('spikes/terrain-smoothing/airports.js', `window.__tsAirports = ${JSON.stringify(result)}\n`)
for (const [icao, a] of Object.entries(result)) {
  console.log(icao, a.runways.map((r) => r.id).join(' '), `geoid ${a.geoidM.toFixed(2)} m`)
}
