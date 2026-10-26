// Headless Edge driver for the TC3D-218/220 mocks (scratch tree only).
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

export const BASE = 'http://localhost:5175/'
const PROFILE = path.resolve('profile-' + process.pid)

export async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 720 },
    args: ['--disable-extensions', '--enable-gpu', '--ignore-gpu-blocklist'],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !/ion|token|key/i.test(t)) console.log('[page error]', t.slice(0, 200))
    if (t.startsWith('[mock]')) console.log(t.slice(0, 400))
  })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  return { ctx, page }
}

export async function close(ctx) {
  await ctx.close()
  fs.rmSync(PROFILE, { recursive: true, force: true })
}

export async function setup(page, icao, hour = 12) {
  await page.goto(BASE)
  await page.bringToFront()
  await page.waitForFunction(() => window.__tc3d !== undefined && window.__mock !== undefined, null, { timeout: 120000 })
  await page.evaluate(
    async ({ icao, hour }) => {
      const s = window.__tc3d.stores.settings.getState()
      s.updateCesiumSettings({ show3DBuildings: true, buildingQuality: 'high', timeMode: 'fixed', fixedTimeHour: hour })
      const { useAirportStore } = await import('/stores/airportStore.ts')
      for (let i = 0; i < 120 && useAirportStore.getState().airports.size === 0; i++) await new Promise((r) => setTimeout(r, 500))
      useAirportStore.getState().selectAirport(icao)
    },
    { icao, hour },
  )
  // An airport switch stalls page timers for about 10 s.
  await page.waitForTimeout(12000)
}

/** Places the camera at lat/lon/height (m, ellipsoid) through the app's tower offsets. */
export async function pose(page, p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const error = await page.evaluate((p) => window.__mock.pose(p), p)
    if (!(error > 1)) break
    await page.waitForTimeout(3000)
  }
  await settle(page)
}

export async function settle(page, timeout = 90000) {
  const t0 = Date.now()
  let stable = 0
  while (Date.now() - t0 < timeout) {
    const done = await page.evaluate(() => window.__mock.loaded())
    stable = done ? stable + 1 : 0
    if (stable >= 4) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(800)
}

export async function grab(page, file) {
  const url = await page.evaluate(() => window.__mock.grab())
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'))
  console.log('grab', file)
}

export async function uniforms(page, u) {
  await page.evaluate((u) => window.__mock.uniforms(u), u)
  await page.waitForTimeout(300)
}

export async function shot(page, file) {
  await page.screenshot({ path: file, type: 'png' })
  console.log('shot', file)
}
