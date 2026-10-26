async (page) => {
  // Reads the job from window.__job218 = { name, pose, lanes: ['A','B','C'], sse }.
  const job = await page.evaluate(() => window.__job218);
  const dir = 'X:/dev/towercab-3d/.playwright-mcp/shots218/';
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas { visibility: visible !important; }' });
  const info = await page.evaluate(async (job) => {
    const m = window.__m;
    const vs = window.__tc3d.stores.viewport.getState();
    if (vs.getActiveCameraState().viewMode !== '3d') {
      vs.setViewMode('3d');
      await new Promise((r) => setTimeout(r, 1500));
    }
    m.tileset().maximumScreenSpaceError = job.sse ?? 4;
    const err = await m.pose(job.pose);
    await m.settle();
    const c = window.__tc3d.viewer.canvas.getBoundingClientRect();
    return { err, cam: m.camera(), clip: { x: c.x, y: c.y, width: c.width, height: c.height } };
  }, job);
  const tables = {};
  for (const lane of job.lanes ?? ['A', 'B', 'C']) {
    await page.evaluate(async (lane) => {
      window.__m.setLane(lane);
      await new Promise((r) => setTimeout(r, 1500));
      await window.__m.settle();
    }, lane);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}${job.name}-${lane}.png`, clip: info.clip });
  }
  await page.evaluate(() => window.__m.setLane('A'));
  const rows = await page.evaluate(() => window.__m.onScreen(16));
  return { info, rows: rows.filter((r) => r['part#elementId'] !== undefined || r.cells > 200).slice(0, 30) };
}
