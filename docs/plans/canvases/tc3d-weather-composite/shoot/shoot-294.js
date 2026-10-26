async (page) => {
  // TC3D-294 lanes at the EGLL tower pose, 10 SM, BKN 274.3 m cov 0.7 + OVC 609.6 m cov 1, High preset.
  const DIR = 'X:/dev/towercab-3d/.tmp/mock-weather/png294/'
  const LANES = {
    a: {},
    b: { lod: 1 },
    c: { graze: 150 },
    d: { jitter: 1 },
    e: { shade: 1 },
  }
  const DRIFTS = [0, 300, 600]
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
  await page.evaluate(async () => {
    window.__m.weather({ vis: 10 })
    window.__m.towerPose()
    await window.__m.tilesLoaded(200)
    await window.__m.frames(60)
  })
  const box = await page.locator('.cesium-widget canvas').first().boundingBox()
  const out = { box, lanes: {} }
  for (const [k, mk] of Object.entries(LANES)) {
    const steps = []
    for (const drift of DRIFTS) {
      await page.evaluate(async (m) => {
        window.__tc3dMock = m
        await window.__m.frames(10)
      }, { ...mk, drift })
      if (drift === 0) {
        await hideUi(true)
        await page.screenshot({ path: `${DIR}${k}.png`, clip: box })
        await hideUi(false)
      }
      steps.push(await page.evaluate(async () => (await window.__m.rowStep(4)).maxRowStep))
    }
    out.lanes[k] = { rowStep: steps }
  }
  // GPU cost: free-running clouds (drift unpinned), two rounds, 360 frames per reading.
  const cost = async (mk, off) =>
    page.evaluate(
      async ({ mk, off }) => {
        const upd = window.__tc3d.stores.settings.getState().updateWeatherSettings
        upd({ showClouds: !off, showBabylonFog: !off })
        window.__tc3dMock = mk
        await window.__m.frames(360)
        const p = window.__m.perf()
        upd({ showClouds: true, showBabylonFog: true })
        return p
      },
      { mk, off },
    )
  out.cost = {}
  for (let round = 0; round < 2; round++) {
    ;(out.cost.off ??= []).push(await cost({}, true))
    for (const [k, mk] of Object.entries(LANES)) (out.cost[k] ??= []).push(await cost(mk, false))
  }
  await page.evaluate(() => {
    window.__tc3dMock = {}
  })
  return out
}
