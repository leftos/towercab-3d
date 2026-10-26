async (page) => {
  await page.addScriptTag({ path: 'X:/dev/towercab-3d/.tmp/mock-weather/overlay.js' })
  const out = {}
  for (const heading of [274, 0, 90, 180]) {
    await page.evaluate((heading) => {
      window.__m.weather({ vis: 10 })
      window.__tc3d.camera.set({ heading, pitch: -3, fov: 45 })
    }, heading)
    await page.evaluate(() => window.__m.tilesLoaded(200))
    await page.waitForTimeout(2000)
    const r = await page.evaluate(() => window.__overlay({ h: 140, scale: 2, composite: true }))
    await page.screenshot({ path: `X:/dev/towercab-3d/.tmp/mock-weather/ovc-h${heading}.png`, clip: { x: 0, y: 0, width: r.size[0], height: r.size[1] } })
    await page.evaluate(() => window.__overlayOff())
    const p = await page.evaluate(async () => {
      const W = window.__tc3d.viewer.canvas.width
      const res = []
      for (const x of [Math.round(W * 0.2), Math.round(W * 0.5), Math.round(W * 0.8)]) {
        const d = await window.__m.depthProbe({ x })
        const pairs = d.rows.filter((o) => o.terrainPickM !== null && o.shaderM < 1e6)
        const errs = pairs.map((o) => Math.abs(o.shaderM - o.terrainPickM) / o.terrainPickM)
        errs.sort((a, b) => a - b)
        const skyWithPick = d.rows.filter((o) => o.shaderM >= 1e6 && o.terrainPickM !== null).length
        const firstTerrain = d.rows.find((o) => o.shaderM < 1e6)
        res.push({
          x,
          hr: d.horizonRow,
          pairs: pairs.length,
          medErrPct: errs.length ? +(100 * errs[Math.floor(errs.length / 2)]).toFixed(2) : null,
          maxErrPct: errs.length ? +(100 * errs[errs.length - 1]).toFixed(2) : null,
          skyWithPick,
          firstTerrain: firstTerrain ? { rel: firstTerrain.belowHorizonRows, elev: firstTerrain.elevDeg, raw: firstTerrain.rawDepth, m: firstTerrain.shaderM, pick: firstTerrain.terrainPickM } : null,
        })
      }
      return res
    })
    out[heading] = { overlay: r, probe: p }
  }
  return out
}
