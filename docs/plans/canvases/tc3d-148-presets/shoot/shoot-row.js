async (page) => {
  // Run through playwright-headless `browser_run_code_unsafe` (filename) after helper.js.
  // RECIPE.md replaces __ROW__ with { id, weather, pose } for each row. Shoots stage off, then High, Medium, Low.
  const ROW = __ROW__;
  const DIR = 'X:/dev/towercab-3d/.tmp/mocks/tc3d-148-presets-png';
  const rect = { x: 2, y: 50, width: 1596, height: 800 };
  await page.bringToFront();
  await page.addStyleTag({
    content: '.aircraft-panel,.magnification-indicator,.command-idle-hint{display:none !important}',
  });
  const results = {};
  // Baseline: stage off (clouds and fog gates off), same weather and pose
  results.off = await page.evaluate(async (row) => {
    const s = window.__shoot;
    const upd = window.__tc3d.stores.settings.getState().updateWeatherSettings;
    s.setWeather(row.weather);
    s.pose(row.pose);
    upd({ showClouds: false, showBabylonFog: false });
    const m = await s.measure();
    upd({ showClouds: true, showBabylonFog: true });
    return m;
  }, ROW);
  for (const lane of ['high', 'medium', 'low']) {
    results[lane] = await page.evaluate(
      async ({ row, lane }) => {
        const s = window.__shoot;
        await s.setLane(lane);
        s.setWeather(row.weather);
        s.pose(row.pose);
        return await s.measure();
      },
      { row: ROW, lane },
    );
    await page.screenshot({ path: `${DIR}/${ROW.id}-${lane}.png`, clip: rect });
  }
  const fmt = (s) => (s ? `${s.median}/${s.p95}` : null);
  const out = {};
  for (const [k, m] of Object.entries(results)) {
    out[k] = {
      frames: m.frames,
      tiles: m.tilesLoaded,
      frameInterval: fmt(m.frameInterval),
      totalFrame: fmt(m.totalFrame),
      cesiumDraw: fmt(m.cesiumDraw),
      gpuCesiumMs: fmt(m.gpuCesiumMs),
      stageEnabled: m.info.stageEnabled,
      textureScale: m.textureScale,
      q: `${m.q.steps}/${m.q.resolutionScale}/${m.q.radius}/${m.q.densityScale}/${m.q.fogExtinction}/${m.q.fogHeightScale}`,
      weather: `${m.weather.layers.join(',')} ${m.weather.visib}SM interp=${m.weather.interp}`,
      cam: `${m.cam.heading}/${m.cam.pitch}/${m.cam.fov}`,
    };
  }
  return out;
}
