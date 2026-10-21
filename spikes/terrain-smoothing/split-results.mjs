// Splits a browser_evaluate result holding { ICAO: measurement } (a JSON string of JSON) into one
// file per airport for analyze.py. Usage: node split-results.mjs <all.json> <out dir> [suffix]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [src, outDir, suffix = ''] = process.argv.slice(2)
let data = JSON.parse(readFileSync(src, 'utf8'))
if (typeof data === 'string') data = JSON.parse(data)
mkdirSync(outDir, { recursive: true })
for (const [icao, m] of Object.entries(data)) {
  if (m.error) {
    console.log(`${icao}: ${m.error}`)
    continue
  }
  writeFileSync(join(outDir, `${icao}${suffix}.json`), JSON.stringify(m))
  const tiles = m.tin ? m.tin.tiles.map((t) => t.vertices).join('+') : '-'
  console.log(`${icao}: level ${m.maxLevel}, ${m.ms} ms, grid ${m.grid.nx}x${m.grid.ny}, tile vertices ${tiles}, TIN vertices in bbox ${m.tin ? m.tin.verts.length : '-'}`)
}
