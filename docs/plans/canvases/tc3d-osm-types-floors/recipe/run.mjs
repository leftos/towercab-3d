// Runs a shot plan: node run.mjs plans/<plan>.json
// Plan: { airport, hour, shots: [{ name, pose?, uniforms?, category?, cls?, features? }] }
import fs from 'node:fs'
import { launch, close, setup, settle, grab, pose } from './lib.mjs'

const DEFAULT_UNIFORMS = { u_mockFloor: 0, u_mockGround: 0, u_mockHash: 4, u_mockStoreyBucket: 1, u_mockDebug: 0, u_mockClass: 0 }
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const only = process.argv[3] ? new RegExp(process.argv[3]) : null
const { ctx, page } = await launch()
try {
  if (plan.viewport) await page.setViewportSize(plan.viewport)
  await setup(page, plan.airport, plan.hour ?? 12)
  for (const s of plan.shots) {
    if (only && !only.test(s.name)) continue
    if (s.pose) await pose(page, s.pose)
    await page.evaluate(
      ({ u, category, cls }) => {
        window.__mock.uniforms(u)
        window.__mock.setCategory(category ?? null)
        window.__mock.setClass(cls ?? null)
      },
      { u: { sse: 8, ...DEFAULT_UNIFORMS, ...(s.uniforms ?? {}) }, category: s.category, cls: s.cls },
    )
    await settle(page)
    const cam = await page.evaluate(() => window.__mock.camera())
    console.log('cam', s.name, cam.lat.toFixed(6), cam.lon.toFixed(6), cam.h.toFixed(2), cam.heading.toFixed(2), cam.pitch.toFixed(2))
    await grab(page, `out/${s.name}.png`)
    if (s.overlay) {
      const o = s.overlay
      const ground = o.ground ?? -30
      const rings = (o.rings ?? []).map((r) => r.map(([lon, lat]) => [lon, lat, ground]))
      const circle = []
      if (o.circle) {
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * 2 * Math.PI
          const dLat = (Math.cos(a) * o.circle.r) / 111320
          const dLon = (Math.sin(a) * o.circle.r) / (111320 * Math.cos((o.circle.lat * Math.PI) / 180))
          circle.push([o.circle.lon + dLon, o.circle.lat + dLat, ground])
        }
      }
      const projected = await page.evaluate(
        ({ rings, circle }) => ({ rings: rings.map((r) => window.__mock.project(r)), circle: window.__mock.project(circle) }),
        { rings, circle },
      )
      fs.writeFileSync(`out/${s.name}-overlay.json`, JSON.stringify(projected))
    }
    if (s.features) fs.writeFileSync(`out/${s.name}.json`, JSON.stringify(await page.evaluate(() => window.__mock.features())))
  }
  console.log('totals', JSON.stringify(await page.evaluate(() => window.__mock.totals())))
  console.log('camera', JSON.stringify(await page.evaluate(() => window.__mock.camera())))
} finally {
  await close(ctx)
}
