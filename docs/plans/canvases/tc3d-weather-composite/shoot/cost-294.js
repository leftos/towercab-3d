async (page) => {
  // Extra TC3D-294 shots (shade 0.6 lane, upward pose) and interleaved GPU cost over 4 rounds at the High preset.
  const DIR = 'X:/dev/towercab-3d/.tmp/mock-weather/png294/'
  const LANES = { a: {}, b: { lod: 1 }, c: { graze: 150 }, d: { jitter: 1 }, e: { shade: 1 }, f: { shade: 0.6 } }
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
  const out = { steps: {}, cost: {}, render: {} }
  await page.evaluate(() => {
    window.__m.weather({ vis: 10 })
    window.__m.towerPose()
  })
  // f lane at the tower pose, pinned drift 0, plus its row step at 3 drifts
  for (const drift of [0, 300, 600]) {
    await page.evaluate(async (m) => {
      window.__tc3dMock = m
      await window.__m.frames(10)
    }, { ...LANES.f, drift })
    if (drift === 0) {
      await hideUi(true)
      await page.screenshot({ path: `${DIR}f.png`, clip: box })
      await hideUi(false)
    }
    ;(out.steps.f ??= []).push(await page.evaluate(async () => (await window.__m.rowStep(4)).maxRowStep))
  }
  // upward pose: heading 274, pitch +12, same weather, lanes a/e/f
  await page.evaluate(async () => {
    window.__tc3d.camera.set({ heading: 274, pitch: 12, fov: 45 })
    await window.__m.frames(30)
  })
  for (const k of ['a', 'e', 'f']) {
    await page.evaluate(async (m) => {
      window.__tc3dMock = m
      await window.__m.frames(10)
    }, { ...LANES[k], drift: 0 })
    await hideUi(true)
    await page.screenshot({ path: `${DIR}up-${k}.png`, clip: box })
    await hideUi(false)
  }
  await page.evaluate(async () => {
    window.__m.towerPose()
    await window.__m.frames(30)
  })
  const run = async (mk, off) =>
    page.evaluate(
      async ({ mk, off }) => {
        const t = window.__tc3d
        const upd = t.stores.settings.getState().updateWeatherSettings
        upd({ showClouds: !off, showBabylonFog: !off })
        window.__tc3dMock = mk
        await window.__m.frames(330)
        const p = window.__m.perf()
        // forced render + 1-pixel readPixels: wall time of one full frame including the GPU
        const v = t.viewer
        const gl = v.scene.context._gl
        const px = new Uint8Array(4)
        const s = []
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => requestAnimationFrame(() => r()))
          const t0 = performance.now()
          v.scene.render(v.clock.currentTime)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
          s.push(performance.now() - t0)
        }
        upd({ showClouds: true, showBabylonFog: true })
        s.sort((a, b) => a - b)
        return { gpu: p.gpuCesiumMs, render: { median: +s[20].toFixed(2), p95: +s[37].toFixed(2) } }
      },
      { mk, off },
    )
  for (let round = 0; round < 4; round++) {
    const r0 = await run({}, true)
    ;(out.cost.off ??= []).push(r0.gpu)
    ;(out.render.off ??= []).push(r0.render)
    for (const [k, mk] of Object.entries(LANES)) {
      const r = await run(mk, false)
      ;(out.cost[k] ??= []).push(r.gpu)
      ;(out.render[k] ??= []).push(r.render)
    }
  }
  await page.evaluate(() => {
    window.__tc3dMock = {}
  })
  return out
}
