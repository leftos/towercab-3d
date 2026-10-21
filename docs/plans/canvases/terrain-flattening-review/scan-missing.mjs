// Airports with apt.dat pavements whose runway ends lack an elevation, ranked by pavement count.
import fs from 'node:fs'
import zlib from 'node:zlib'

const root = process.argv[2]
const surfaces = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${root}/src-tauri/resources/airport-surfaces.json.gz`)).toString('utf8'))
const lines = fs.readFileSync(`${root}/src-tauri/resources/runways.csv`, 'utf8').split('\n')
const split = (l) => l.match(/("([^"]*)"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, ''))
const h = split(lines[0])
const ix = Object.fromEntries(h.map((k, i) => [k, i]))
const rows = []
for (const l of lines.slice(1)) {
  if (!l.trim()) continue
  const v = split(l)
  if (v[ix.closed] === '1') continue
  const apt = v[ix.airport_ident]
  const a = surfaces.airports[apt]
  if (!a) continue
  const hasCoords = v[ix.le_latitude_deg] && v[ix.he_latitude_deg]
  if (!hasCoords) continue
  if (v[ix.le_elevation_ft] === '' || v[ix.he_elevation_ft] === '') {
    rows.push({ apt, rwy: `${v[ix.le_ident]}/${v[ix.he_ident]}`, le: v[ix.le_elevation_ft], he: v[ix.he_elevation_ft], aptFt: a.e, pav: a.p.length, len: v[ix.length_ft] })
  }
}
rows.sort((x, y) => y.pav - x.pav)
console.log(`runways with coords and a missing end elevation at airports with pavements: ${rows.length}`)
for (const r of rows.slice(0, 40)) console.log(`${r.apt} ${r.rwy} le=${r.le || '-'} he=${r.he || '-'} aptElev=${r.aptFt}ft pavements=${r.pav} len=${r.len}`)
