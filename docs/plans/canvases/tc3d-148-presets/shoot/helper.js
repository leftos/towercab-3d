// Paste as the `function` of a playwright-headless `browser_evaluate` call once KOAK is selected.
// Installs window.__shoot: setWeather(key), setLane(key), pose({ heading, pitch, fov }), measure(), frames(n).
async () => {
  const t = window.__tc3d;
  const wm = await import('/constants/weather.ts');
  // The same object useCesiumWeatherStages reads; `as const` does not freeze it.
  const Q = wm.WEATHER_STAGE_QUALITY;
  const FT = 0.3048;
  const WEATHERS = {
    bkn10: { layers: [{ type: 'BKN', coverage: 0.6875, altitude: 2500 * FT }], visib: 10 },
    ovc3: { layers: [{ type: 'OVC', coverage: 1.0, altitude: 1500 * FT }], visib: 3 },
    few10: { layers: [{ type: 'FEW', coverage: 0.1875, altitude: 4000 * FT }], visib: 10 },
  };
  const LANES = {
    high: { steps: 120, resolutionScale: 0.5, radius: 100000 },
    medium: { steps: 72, resolutionScale: 0.375, radius: 60000 },
    low: { steps: 48, resolutionScale: 0.25, radius: 40000 },
  };
  const st = t.viewer.scene.postProcessStages;
  const frames = (n) =>
    new Promise((resolve) => {
      let count = 0;
      const off = t.viewer.scene.postRender.addEventListener(() => {
        count += 1;
        if (count >= n) {
          off();
          resolve(count);
        }
      });
    });
  const tilesLoaded = async (max) => {
    for (let i = 0; i < max; i += 1) {
      if (t.viewer.scene.globe.tilesLoaded) return true;
      await frames(10);
    }
    return false;
  };
  const stageTex = () => {
    const n = st.length;
    if (!n) return null;
    const last = st.get(n - 1);
    return last.name === 'tc3dWeatherStage' ? last.get(0).textureScale : null;
  };
  const setWeather = (key) => {
    const w = WEATHERS[key];
    const ws = t.stores.weather.getState();
    ws.setDebugOverriding(true);
    ws.setPrecipitation({ active: false, types: [], hasThunderstorm: false, visibilityFactor: 1 });
    ws.setCloudLayers(w.layers.map((l) => ({ ...l })));
    t.stores.weather.setState({
      useInterpolation: false,
      interpolatedWeather: null,
      currentMetar: { ...ws.currentMetar, visib: w.visib },
    });
  };
  // textureScale is read once at stage creation: turning both stage gates off and on recreates the stage.
  // (Do not toggle showWeatherEffects: App.tsx clears the weather store when it goes off.)
  const setLane = async (key) => {
    Object.assign(Q, LANES[key]);
    const upd = t.stores.settings.getState().updateWeatherSettings;
    upd({ showClouds: false, showBabylonFog: false });
    await frames(5);
    upd({ showClouds: true, showBabylonFog: true });
    await frames(30);
    return { q: { ...Q }, textureScale: stageTex() };
  };
  const pose = (p) => t.camera.set(p);
  const measure = async () => {
    const loaded = await tilesLoaded(120);
    await frames(320);
    const w = t.perf().window;
    const pick = (x) => (x ? { median: +x.median.toFixed(2), p95: +x.p95.toFixed(2) } : null);
    const ws = t.stores.weather.getState();
    return {
      tilesLoaded: loaded,
      frames: w.frames,
      frameInterval: pick(w.frameInterval),
      totalFrame: pick(w.totalFrame),
      cesiumDraw: pick(w.cesiumDraw),
      gpuCesiumMs: pick(w.gpuCesiumMs),
      info: t.weatherStage.info(),
      textureScale: stageTex(),
      q: { ...Q },
      cam: t.camera.get(),
      weather: {
        layers: ws.cloudLayers.map((l) => `${l.type}@${Math.round(l.altitude / FT)}ft`),
        visib: ws.currentMetar?.visib,
        interp: ws.useInterpolation,
      },
    };
  };
  t.stores.settings.getState().updateCesiumSettings({ timeMode: 'fixed', fixedTimeHour: 13 });
  t.stores.settings.getState().updateWeatherSettings({ enableWeatherInterpolation: false });
  window.__shoot = { setWeather, setLane, pose, measure, frames, LANES, WEATHERS };
  return { installed: true, q: { ...Q } };
}
