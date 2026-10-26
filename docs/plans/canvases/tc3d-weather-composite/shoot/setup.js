async (page) => {
  await page.bringToFront()
  await page.waitForFunction(() => window.__tc3d?.viewer, null, { timeout: 60000 })
  await page.evaluate(async () => {
    const m = await import('/stores/airportStore.ts')
    await m.useAirportStore.getState().selectAirport('EGLL')
    const s = window.__tc3d.stores.settings.getState()
    s.updateCesiumSettings({ timeMode: 'fixed', fixedTimeHour: 13 })
    s.updateWeatherSettings({ enableWeatherInterpolation: false, stageQuality: 'high' })
  })
  await page.waitForTimeout(12000)
  await page.addScriptTag({ path: 'X:/dev/towercab-3d/.tmp/mock-weather/helpers.js' })
  return await page.evaluate(async () => {
    window.__tc3dMock = {}
    window.__m.weather({ vis: 5 })
    window.__m.towerPose()
    await window.__m.tilesLoaded(200)
    return { info: window.__tc3d.weatherStage.info(), cam: window.__tc3d.camera.get(), g: window.__m.groundUnderCamera() }
  })
}
