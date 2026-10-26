async (page) => {
  await page.bringToFront();
  await page.waitForFunction(() => window.__tc3d !== undefined, null, { timeout: 120000 });
  const icao = await page.evaluate(() => new URL(location.href).searchParams.get('airport') || 'KSFO');
  await page.evaluate(async (icao) => {
    const m = await import('/utils/mock218.ts');
    window.__m = m;
    m.setup(12);
    await m.selectAirport(icao);
  }, icao);
  await page.waitForTimeout(12000);
  return await page.evaluate(() => ({ ok: !!window.__m.tileset(), cam: window.__m.camera() }));
}
