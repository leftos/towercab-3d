// Builds a canvas: the stage-off scene with depth-1.0 pixels tinted red, shown as a fixed overlay for page.screenshot.
window.__overlay = async ({ y0 = null, h = 160, scale = 2, composite = false } = {}) => {
  const t = window.__tc3d
  const sc = t.viewer.scene
  const fx = sc.postProcessStages.fxaa.enabled
  sc.postProcessStages.fxaa.enabled = false
  window.__tc3dMock = { debug: 1 }
  await window.__m.frames(3)
  const raw = window.__m.grab()
  window.__tc3dMock = {}
  sc.postProcessStages.fxaa.enabled = fx
  const upd = t.stores.settings.getState().updateWeatherSettings
  let plain
  if (composite) {
    await window.__m.frames(3)
    plain = window.__m.grab()
  } else {
    upd({ showClouds: false, showBabylonFog: false })
    await window.__m.frames(5)
    plain = window.__m.grab()
    upd({ showClouds: true, showBabylonFog: true })
    await window.__m.frames(5)
  }
  const { hr } = window.__m.horizonRow(raw)
  const top = y0 ?? hr - 60
  const W = raw.width
  const out = document.createElement('canvas')
  out.width = W
  out.height = h
  const ctx = out.getContext('2d')
  const img = ctx.createImageData(W, h)
  let skyPx = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((y + top) * W + x) * 4
      const o = (y * W + x) * 4
      const isSky = raw.data[i] === 255 && raw.data[i + 1] === 0 && raw.data[i + 2] === 0
      const r = plain.data[i]
      const g = plain.data[i + 1]
      const b = plain.data[i + 2]
      if (isSky) skyPx++
      img.data[o] = isSky ? Math.min(255, r * 0.5 + 128) : r
      img.data[o + 1] = isSky ? g * 0.5 : g
      img.data[o + 2] = isSky ? b * 0.5 : b
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  const crop = document.createElement('canvas')
  const cw = Math.min(W, 640)
  crop.width = cw * scale
  crop.height = h * scale
  const cctx = crop.getContext('2d')
  cctx.imageSmoothingEnabled = false
  cctx.drawImage(out, (W - cw) / 2, 0, cw, h, 0, 0, cw * scale, h * scale)
  let el = document.getElementById('__ov')
  if (!el) {
    el = document.createElement('div')
    el.id = '__ov'
    el.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#000'
    document.body.appendChild(el)
  }
  el.innerHTML = ''
  el.appendChild(crop)
  return { hr, top, skyPx, size: [crop.width, crop.height] }
}
window.__overlayOff = () => document.getElementById('__ov')?.remove()
