async (page) => {
  // TC3D-224 frame captures. Jobs come from window.__jobs224:
  // { id, fade, easeS, start, end, glide: false | { dur }, t0, t1, dt }
  // fade: 0 today, 1 extinction fade + ease, 2 visibility fade + ease, 3 time ease only.
  // The ease runs on window.__tc3dMock.clock, stepped by dt per frame; fog only (no cloud layers).
  const ROOT = 'X:/dev/towercab-3d/.tmp/mock-weather/frames/'
  const hideUi = (hide) =>
    page.evaluate((hide) => {
      const canvas = document.querySelector('.cesium-widget canvas')
      if (hide) {
        window.__hidden = []
        let el = canvas
        while (el && el !== document.body) {
          for (const sib of el.parentElement.children) {
            if (sib !== el) {
              window.__hidden.push([sib, sib.style.opacity])
              sib.style.setProperty('opacity', '0', 'important')
            }
          }
          el = el.parentElement
        }
      } else {
        for (const [e, o] of window.__hidden) e.style.opacity = o
      }
    }, hide)
  await page.bringToFront()
  const box = await page.locator('.cesium-widget canvas').first().boundingBox()
  const jobs = await page.evaluate(() => window.__jobs224)
  const log = {}
  await hideUi(true)
  for (const job of jobs) {
    await page.evaluate(async (job) => {
      const m = window.__m
      window.__tc3dMock = { fade: job.fade, easeS: job.easeS, clock: -100, drift: 0 }
      m.weather({ vis: job.start, layers: [] })
      m.towerPose()
      await m.frames(15)
      window.__tc3dMock.clock = -50
      await m.frames(10)
      window.__tc3dMock.clock = 0
      await m.frames(5)
      // An eased lane takes its new target at clock 0; today's lane steps when the loop reaches t = 0.
      if (!job.glide && job.fade !== 0) m.setVis(job.end)
      await m.frames(8)
    }, job)
    const rows = []
    let n = 0
    for (let t = job.t0; t <= job.t1 + 1e-9; t += job.dt) {
      const d = await page.evaluate(async ({ job, t }) => {
        const m = window.__m
        if (job.glide) {
          const x = Math.min(Math.max(t / job.glide.dur, 0), 1)
          m.setVis(job.start + (job.end - job.start) * x)
        } else if (t >= -1e-9) {
          m.setVis(job.end)
        }
        window.__tc3dMock.clock = t
        await m.frames(3)
        return { vis: window.__tc3d.stores.weather.getState().currentMetar?.visib, density: window.__tc3dMockDensity ?? 0 }
      }, { job, t })
      await page.screenshot({ path: `${ROOT}${job.id}/${String(n).padStart(3, '0')}.jpg`, clip: box, type: 'jpeg', quality: 90 })
      rows.push([+t.toFixed(2), +(d.vis ?? 0).toFixed(3), d.density])
      n += 1
    }
    log[job.id] = rows
  }
  await hideUi(false)
  await page.evaluate((log) => {
    window.__tc3dMock = {}
    window.__log224 = { ...(window.__log224 ?? {}), ...log }
  }, log)
  return Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length]))
}
