// Page-side helpers for the tc3d-weather-composite mock (TC3D-295/294/224). Injected with page.addScriptTag.
window.__m = (() => {
  const R = 6371000
  const deg = Math.PI / 180
  const t = () => window.__tc3d
  const LAYERS = [
    { type: 'BKN', altitude: 274.3, coverage: 0.7 },
    { type: 'OVC', altitude: 609.6, coverage: 1 },
  ]

  function weather({ vis, layers = LAYERS }) {
    const ws = t().stores.weather
    ws.getState().setDebugOverriding(true)
    ws.getState().setCloudLayers(layers.map((l) => ({ ...l })))
    const metar = ws.getState().currentMetar
    ws.setState({ useInterpolation: false, interpolatedWeather: null, currentMetar: { ...metar, visib: vis } })
  }

  function setVis(vis) {
    const ws = t().stores.weather
    ws.setState({ currentMetar: { ...ws.getState().currentMetar, visib: vis } })
  }

  function towerPose() {
    t().weatherStage.set({ camera: null })
    t().camera.set({ heading: 274, pitch: -3, fov: 45 })
  }

  const frames = (n) =>
    new Promise((resolve) => {
      let count = 0
      const off = t().viewer.scene.postRender.addEventListener(() => {
        count += 1
        if (count >= n) {
          off()
          resolve(count)
        }
      })
    })

  async function tilesLoaded(max = 120) {
    for (let i = 0; i < max; i += 1) {
      if (t().viewer.scene.globe.tilesLoaded) return true
      await frames(10)
    }
    return false
  }

  function groundUnderCamera() {
    const v = t().viewer
    const c = v.camera.positionCartographic
    const g = v.scene.globe.getHeight(c)
    return { camH: c.height, ground: g, agl: g === undefined ? null : c.height - g }
  }

  function grab() {
    const v = t().viewer
    // scene.render() without a time renders at the wall clock; pass the app's (fixed) clock time.
    v.scene.render(v.clock.currentTime)
    const c = v.canvas
    const g = document.createElement('canvas')
    g.width = c.width
    g.height = c.height
    const x = g.getContext('2d', { willReadFrequently: true })
    x.drawImage(c, 0, 0)
    return x.getImageData(0, 0, c.width, c.height)
  }

  function horizonRow(img) {
    const v = t().viewer
    const { agl } = groundUnderCamera()
    const dip = Math.sqrt((2 * Math.max(agl ?? 0, 0)) / R)
    const pitch = v.camera.pitch
    const fovy = v.camera.frustum.fovy
    const H = img.height
    const rowAt = (elev) => H / 2 - (Math.tan(elev - pitch) / Math.tan(fovy / 2)) * (H / 2)
    return { hr: Math.round(rowAt(-dip)), rowAt, dipDeg: dip / deg }
  }

  function rowLum(img, y, c0, c1) {
    let s = 0
    for (let xx = c0; xx <= c1; xx++) {
      const i = (y * img.width + xx) * 4
      s += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
    }
    return s / (c1 - c0 + 1)
  }

  async function nextFrame() {
    await new Promise((r) => requestAnimationFrame(() => r()))
  }

  // Largest adjacent-row luminance step from 2 deg above the horizon down to 8 rows above it,
  // over the 200 centre columns, averaged over n frames (the deck drifts and the march jitters).
  async function rowStep(n = 5) {
    const out = []
    for (let k = 0; k < n; k++) {
      await nextFrame()
      const img = grab()
      const { hr, rowAt, dipDeg } = horizonRow(img)
      const cx = Math.round(img.width / 2)
      const c0 = cx - 100
      const c1 = cx + 99
      const top = Math.round(rowAt(-dipDeg * deg + 2 * deg))
      let maxStep = 0
      let maxRow = null
      let prev = rowLum(img, top, c0, c1)
      for (let y = top + 1; y <= hr - 8; y++) {
        const l = rowLum(img, y, c0, c1)
        if (Math.abs(l - prev) > maxStep) {
          maxStep = Math.abs(l - prev)
          maxRow = y
        }
        prev = l
      }
      out.push({ maxStep, rowsAboveHorizon: maxRow === null ? null : hr - maxRow, hr, top })
    }
    const mean = out.reduce((s, a) => s + a.maxStep, 0) / out.length
    return { maxRowStep: +mean.toFixed(1), perFrame: out.map((a) => +a.maxStep.toFixed(1)), rowsAbove: out.map((a) => a.rowsAboveHorizon), hr: out[0].hr, top: out[0].top }
  }

  function decode24(img, x, y) {
    const i = (y * img.width + x) * 4
    return (img.data[i] * 65536 + img.data[i + 1] * 256 + img.data[i + 2]) / 16777215
  }

  // Raw depth and decoded distance per row at column x, against the CPU terrain pick and the ellipsoid.
  async function depthProbe({ x = null, rows = null } = {}) {
    const v = t().viewer
    const sc = v.scene
    const prevFxaa = sc.postProcessStages.fxaa.enabled
    sc.postProcessStages.fxaa.enabled = false
    window.__tc3dMock = { ...(window.__tc3dMock ?? {}), debug: 1 }
    await frames(3)
    const raw = grab()
    window.__tc3dMock = { ...window.__tc3dMock, debug: 2 }
    await frames(3)
    const dist = grab()
    window.__tc3dMock = { ...window.__tc3dMock, debug: 0 }
    sc.postProcessStages.fxaa.enabled = prevFxaa
    const cx = x ?? Math.round(raw.width / 2)
    const { hr, rowAt, dipDeg } = horizonRow(raw)
    const list = rows ?? Array.from({ length: 41 }, (_, i) => hr - 12 + i * 3)
    const cssScale = v.canvas.clientWidth / v.canvas.width
    const out = []
    for (const y of list) {
      const rawDepth = decode24(raw, cx, y)
      const dShader = decode24(dist, cx, y) * 16777215
      const wp = new window.__Cesium.Cartesian2(cx * cssScale, y * cssScale)
      const ray = v.camera.getPickRay(wp)
      const hit = sc.globe.pick(ray, sc)
      const terrainM = hit ? window.__Cesium.Cartesian3.distance(hit, v.camera.positionWC) : null
      const iv = window.__Cesium.IntersectionTests.rayEllipsoid(ray, window.__Cesium.Ellipsoid.WGS84)
      const ellipsoidM = iv ? iv.start : null
      const elevDeg = Math.atan((raw.height / 2 - y) / (raw.height / 2) * Math.tan(v.camera.frustum.fovy / 2)) / deg + v.camera.pitch / deg
      out.push({
        row: y,
        belowHorizonRows: y - hr,
        elevDeg: +elevDeg.toFixed(3),
        rawDepth: +rawDepth.toFixed(7),
        shaderM: Math.round(dShader),
        terrainPickM: terrainM === null ? null : Math.round(terrainM),
        ellipsoidM: ellipsoidM === null ? null : Math.round(ellipsoidM),
      })
    }
    const cam = v.camera.positionCartographic
    return {
      canvas: [raw.width, raw.height],
      column: cx,
      horizonRow: hr,
      dipDeg: +dipDeg.toFixed(3),
      cam: { lat: +(cam.latitude / deg).toFixed(5), lon: +(cam.longitude / deg).toFixed(5), h: +cam.height.toFixed(1), ...t().camera.get() },
      frustum: { near: v.camera.frustum.near, far: v.camera.frustum.far, numberOfFrustums: sc.numberOfFrustums ?? null, logDepth: sc.logarithmicDepthBuffer },
      rows: out,
    }
  }

  function perf() {
    const w = t().perf().window
    const pick = (k) => (w && w[k] ? { median: +w[k].median.toFixed(2), p95: +w[k].p95.toFixed(2) } : null)
    return { frames: w?.frames ?? null, frameInterval: pick('frameInterval'), cesiumDraw: pick('cesiumDraw'), gpuCesiumMs: pick('gpuCesiumMs') }
  }

  return { weather, setVis, towerPose, frames, tilesLoaded, groundUnderCamera, grab, horizonRow, rowStep, depthProbe, perf, LAYERS }
})()
