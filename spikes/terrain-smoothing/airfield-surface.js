// Spike: airfield surface model + resampling terrain provider (greenfield design, TC3D-194).
//
// Injected into the running dev app after airports.js and measure.js. Adds to window.__tsSpike:
//   buildSurface(icao, opts)      samples raw Cesium World Terrain on a grid over the airfield, fits a
//                                 robust penalised (thin-plate) smooth surface S and a blend weight w
//   AirfieldTerrainProvider       wraps a terrain provider; tiles that touch the airfield are resampled
//                                 to a heightmap whose heights are (1 - w) * raw + w * S
//   install(icao) / uninstall()   swap viewer.terrainProvider between the wrapper and raw terrain
//   surfaceHeight(surface, lonDeg, latDeg)  the height aircraft would use (S where w = 1)
//
// Only public Cesium API is used: CesiumTerrainProvider, sampleTerrainMostDetailed,
// TerrainData.interpolateHeight / isChildAvailable / waterMask / credits, HeightmapTerrainData.
;(() => {
  const R = 6378137
  const DEG = Math.PI / 180

  // ---------- FFT-based DCT (unnormalised DCT-II and its exact inverse) ----------

  function fft(re, im, inverse) {
    const n = re.length
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1
      for (; j & bit; bit >>= 1) j ^= bit
      j ^= bit
      if (i < j) {
        ;[re[i], re[j]] = [re[j], re[i]]
        ;[im[i], im[j]] = [im[j], im[i]]
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len
      const wr = Math.cos(ang)
      const wi = Math.sin(ang)
      for (let i = 0; i < n; i += len) {
        let cr = 1
        let ci = 0
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
          const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
          re[i + k + len / 2] = re[i + k] - ar
          im[i + k + len / 2] = im[i + k] - ai
          re[i + k] += ar
          im[i + k] += ai
          const t = cr * wr - ci * wi
          ci = cr * wi + ci * wr
          cr = t
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n
        im[i] /= n
      }
    }
  }

  function makeDct(n) {
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    const c = new Float64Array(n)
    const s = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      c[k] = Math.cos((Math.PI * k) / (2 * n))
      s[k] = Math.sin((Math.PI * k) / (2 * n))
    }
    // X_k = 2 * sum x_m cos(pi k (2m + 1) / 2n)
    function forward(x, out) {
      for (let m = 0; m < n / 2; m++) {
        re[m] = x[2 * m]
        re[n - 1 - m] = x[2 * m + 1]
      }
      im.fill(0)
      fft(re, im, false)
      for (let k = 0; k < n; k++) out[k] = 2 * (re[k] * c[k] + im[k] * s[k])
    }
    function inverse(X, out) {
      re[0] = X[0] / 2
      im[0] = 0
      for (let k = 1; k < n; k++) {
        const zr = X[k] / 2
        const zi = -X[n - k] / 2
        // V_k = e^{+i pi k / 2n} * Z
        re[k] = zr * c[k] - zi * s[k]
        im[k] = zr * s[k] + zi * c[k]
      }
      fft(re, im, true)
      for (let m = 0; m < n / 2; m++) {
        out[2 * m] = re[m]
        out[2 * m + 1] = re[n - 1 - m]
      }
    }
    return { forward, inverse }
  }

  function dct2d(field, nx, ny, dx, dy, inverse) {
    const rowBuf = new Float64Array(nx)
    const rowOut = new Float64Array(nx)
    const colBuf = new Float64Array(ny)
    const colOut = new Float64Array(ny)
    const run = (d, a, b) => (inverse ? d.inverse(a, b) : d.forward(a, b))
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) rowBuf[i] = field[j * nx + i]
      run(dx, rowBuf, rowOut)
      for (let i = 0; i < nx; i++) field[j * nx + i] = rowOut[i]
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) colBuf[j] = field[j * nx + i]
      run(dy, colBuf, colOut)
      for (let j = 0; j < ny; j++) field[j * nx + i] = colOut[j]
    }
  }

  // Penalised least squares: minimise
  //   sum w (s - h)^2 + p |laplacian s|^2 + mu sum (g . s - delta)^2
  // with p set from a half-power cutoff wavelength (planes and constant-curvature surfaces pass), w the
  // data weight (1 on pavement, small elsewhere, times a bisquare robustness weight), and each (g, delta)
  // a published threshold height difference. Solved by conjugate gradients, preconditioned in the DCT
  // domain where the penalty is diagonal.
  const CONSTRAINT_WEIGHT = 2000

  function fitSurface(heights, baseW, nx, ny, cell, cutoff, anchors = []) {
    // The DCT reflects the field at the grid edge, which turns a regional slope into a kink there.
    // Removing the best-fit plane first keeps that edge bias small; the plane is added back at the end.
    const plane = weightedPlane(heights, baseW, nx, ny)
    const h = Float64Array.from(heights, (v, k) => v - plane[k])
    const constraints = anchors.map(({ idx, val, delta }) => {
      let planeDelta = 0
      for (let q = 0; q < idx.length; q++) planeDelta += val[q] * plane[idx[q]]
      return { idx, val, delta: delta - planeDelta }
    })
    const ops = makeOps(nx, ny, cell, cutoff)
    let w = Float64Array.from(baseW)
    let s = new Float64Array(h.length)
    let iterations = 0
    for (let pass = 0; pass < 4; pass++) {
      const result = solveWeighted(ops, h, w, s, constraints)
      s = result.x
      iterations += result.iterations
      if (pass === 3) break
      w = bisquare(h, s, baseW)
    }
    for (let k = 0; k < s.length; k++) s[k] += plane[k]
    return { s, w, iterations }
  }

  function bisquare(h, s, baseW) {
    const r = Float64Array.from(h, (v, k) => v - s[k])
    const onPaved = r.filter((_, k) => baseW[k] >= 0.5).sort()
    const med = onPaved[onPaved.length >> 1]
    const dev = Float64Array.from(onPaved, (v) => Math.abs(v - med)).sort()
    const mad = dev[dev.length >> 1] * 1.4826 + 1e-6
    return Float64Array.from(r, (v, k) => {
      const u = v / (4.685 * mad)
      return Math.abs(u) < 1 ? baseW[k] * (1 - u * u) ** 2 : 0
    })
  }

  function weightedPlane(h, w, nx, ny) {
    // Normal equations for a + b i + c j
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    const v = [0, 0, 0]
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i
        const basis = [1, i, j]
        for (let a = 0; a < 3; a++) {
          v[a] += w[k] * basis[a] * h[k]
          for (let b = 0; b < 3; b++) m[a * 3 + b] += w[k] * basis[a] * basis[b]
        }
      }
    }
    const [a, b, c] = solve3(m, v)
    return Float64Array.from({ length: nx * ny }, (_, k) => a + b * (k % nx) + c * Math.floor(k / nx))
  }

  function solve3(m, v) {
    const det = (q) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6])
    const d = det(m)
    return [0, 1, 2].map((col) => {
      const q = m.slice()
      for (let row = 0; row < 3; row++) q[row * 3 + col] = v[row]
      return det(q) / d
    })
  }

  function makeOps(nx, ny, cell, cutoff) {
    const dx = makeDct(nx)
    const dy = makeDct(ny)
    const k = new Float64Array(nx * ny)
    const p = (cutoff / (2 * Math.PI)) ** 4
    for (let j = 0; j < ny; j++) {
      const ly = (2 - 2 * Math.cos((Math.PI * j) / ny)) / cell ** 2
      for (let i = 0; i < nx; i++) {
        const lam = (2 - 2 * Math.cos((Math.PI * i) / nx)) / cell ** 2 + ly
        k[j * nx + i] = p * lam * lam
      }
    }
    const spectral = (x, scale) => {
      const f = Float64Array.from(x)
      dct2d(f, nx, ny, dx, dy, false)
      for (let q = 0; q < f.length; q++) f[q] *= scale(q)
      dct2d(f, nx, ny, dx, dy, true)
      return f
    }
    return { k, spectral }
  }

  function solveWeighted(ops, h, w, x0, constraints) {
    const n = h.length
    const dot = (a, b) => {
      let t = 0
      for (let q = 0; q < n; q++) t += a[q] * b[q]
      return t
    }
    const applyA = (x) => {
      const out = ops.spectral(x, (q) => ops.k[q])
      for (let q = 0; q < n; q++) out[q] += w[q] * x[q]
      for (const { idx, val } of constraints) {
        let gx = 0
        for (let t = 0; t < idx.length; t++) gx += val[t] * x[idx[t]]
        for (let t = 0; t < idx.length; t++) out[idx[t]] += CONSTRAINT_WEIGHT * val[t] * gx
      }
      return out
    }
    let wMean = 0
    for (let q = 0; q < n; q++) wMean += w[q] / n
    const c = Math.max(wMean, 0.05)
    const precond = (r) => ops.spectral(r, (q) => 1 / (c + ops.k[q]))
    const b = Float64Array.from(h, (v, q) => w[q] * v)
    for (const { idx, val, delta } of constraints) {
      for (let t = 0; t < idx.length; t++) b[idx[t]] += CONSTRAINT_WEIGHT * delta * val[t]
    }
    const x = Float64Array.from(x0)
    const ax = applyA(x)
    const r = Float64Array.from(b, (v, q) => v - ax[q])
    let z = precond(r)
    const p = Float64Array.from(z)
    let rz = dot(r, z)
    const bNorm = Math.sqrt(dot(b, b)) + 1e-12
    for (let it = 1; it <= 300; it++) {
      const ap = applyA(p)
      const alpha = rz / dot(p, ap)
      for (let q = 0; q < n; q++) {
        x[q] += alpha * p[q]
        r[q] -= alpha * ap[q]
      }
      if (Math.sqrt(dot(r, r)) / bNorm < 1e-6) return { x, iterations: it }
      z = precond(r)
      const rzNew = dot(r, z)
      for (let q = 0; q < n; q++) p[q] = z[q] + (rzNew / rz) * p[q]
      rz = rzNew
    }
    return { x, iterations: 300 }
  }

  // ---------- Airfield mask and blend weight ----------

  function pointInRing(ring, x, y) {
    let inside = false
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a]
      const [xb, yb] = ring[b]
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside
    }
    return inside
  }

  // Exact Euclidean distance transform (Felzenszwalb) in cells, to the nearest true cell
  function edt(mask, nx, ny) {
    const INF = 1e20
    const f = new Float64Array(Math.max(nx, ny))
    const d = new Float64Array(Math.max(nx, ny))
    const v = new Int32Array(Math.max(nx, ny))
    const z = new Float64Array(Math.max(nx, ny) + 1)
    const out = new Float64Array(nx * ny)
    const pass = (n) => {
      let k = 0
      v[0] = 0
      z[0] = -INF
      z[1] = INF
      for (let q = 1; q < n; q++) {
        let sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        while (sv <= z[k]) {
          k--
          sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
        }
        k++
        v[k] = q
        z[k] = sv
        z[k + 1] = INF
      }
      k = 0
      for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) k++
        d[q] = (q - v[k]) ** 2 + f[v[k]]
      }
    }
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) f[j] = mask[j * nx + i] ? 0 : INF
      pass(ny)
      for (let j = 0; j < ny; j++) out[j * nx + i] = d[j]
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) f[i] = out[j * nx + i]
      pass(nx)
      for (let i = 0; i < nx; i++) out[j * nx + i] = Math.sqrt(d[i])
    }
    return out
  }

  function airfieldWeight(apt, grid, closing, blend) {
    const { nx, ny, west, south, dLon, dLat, cell } = grid
    const mask = new Uint8Array(nx * ny)
    const paved = new Uint8Array(nx * ny)
    const cosLat = Math.cos(((apt.bbox.south + apt.bbox.north) / 2) * DEG)
    const toXY = (lon, lat) => [((lon - west) * DEG * R * cosLat), ((lat - south) * DEG * R)]
    const polys = apt.pavements.map((p) => ({ v: p.v.map(([lo, la]) => toXY(lo, la)), h: (p.h ?? []).map((r) => r.map(([lo, la]) => toXY(lo, la))) }))
    const strips = apt.runways.map((rw) => {
      const [ax, ay] = toXY(rw.le.lon, rw.le.lat)
      const [bx, by] = toXY(rw.he.lon, rw.he.lat)
      const len = Math.hypot(bx - ax, by - ay)
      return { ax, ay, ux: (bx - ax) / len, uy: (by - ay) / len, len, half: rw.widthM / 2 }
    })
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = i * cell
        const y = j * cell
        let onStrip = false
        let onRunway = false
        for (const s of strips) {
          const along = (x - s.ax) * s.ux + (y - s.ay) * s.uy
          const across = Math.abs(-(x - s.ax) * s.uy + (y - s.ay) * s.ux)
          onStrip ||= along >= -60 && along <= s.len + 60 && across <= 75
          onRunway ||= along >= 0 && along <= s.len && across <= s.half
        }
        const onPolygon = polys.some((p) => pointInRing(p.v, x, y) && !p.h.some((hole) => pointInRing(hole, x, y)))
        paved[j * nx + i] = onRunway || onPolygon ? 1 : 0
        mask[j * nx + i] = onStrip || onPolygon ? 1 : 0
      }
    }
    // Morphological closing fills the infields between runways and taxiways
    const dOut = edt(mask, nx, ny)
    const dilated = Uint8Array.from(dOut, (d) => (d * cell <= closing ? 1 : 0))
    const dIn = edt(Uint8Array.from(dilated, (m) => 1 - m), nx, ny)
    const core = Uint8Array.from(dIn, (d, k) => (d * cell > closing || mask[k] ? 1 : 0))
    const dCore = edt(core, nx, ny)
    const w = Float64Array.from(dCore, (d) => {
      const t = Math.min(1, (d * cell) / blend)
      return 1 - (3 * t * t - 2 * t * t * t)
    })
    void dLon
    void dLat
    return { paved, core, w }
  }

  // ---------- Published threshold anchors and the choice of cutoff ----------

  const OFF_PAVEMENT_WEIGHT = 0.02
  const LADDER = [300, 500, 800, 1200, 1800, 2500]
  const SLOPE_LIMIT = 0.015

  function stencil(grid, lon, lat) {
    const fx = (lon - grid.west) / grid.dLon
    const fy = (lat - grid.south) / grid.dLat
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const k = j * grid.nx + i
    return { idx: [k, k + 1, k + grid.nx, k + grid.nx + 1], val: [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty] }
  }

  // Published threshold height differences (OurAirports, feet) for runways that list both ends
  function thresholdAnchors(apt, grid) {
    return apt.runways
      .filter((rw) => rw.le.elevFt !== null && rw.he.elevFt !== null)
      .map((rw) => {
        const he = stencil(grid, rw.he.lon, rw.he.lat)
        const le = stencil(grid, rw.le.lon, rw.le.lat)
        return { idx: [...he.idx, ...le.idx], val: [...he.val, ...le.val.map((v) => -v)], delta: (rw.he.elevFt - rw.le.elevFt) * 0.3048 }
      })
  }

  function radiusLimit(lengthM) {
    if (lengthM >= 1800) return 30000
    if (lengthM >= 1200) return 15000
    return 7500
  }

  // Smallest radius of curvature (second differences over 100 m) and steepest 50 m slope along each centreline
  function runwayShape(apt, grid, field) {
    return apt.runways.map((rw) => {
      const cosLat = Math.cos(rw.le.lat * DEG)
      const de = (rw.he.lon - rw.le.lon) * DEG * R * cosLat
      const dn = (rw.he.lat - rw.le.lat) * DEG * R
      const length = Math.hypot(de, dn)
      const profile = []
      for (let s = 0; s <= length; s += 5) {
        const lat = rw.le.lat + ((dn / length) * s) / R / DEG
        const lon = rw.le.lon + ((de / length) * s) / (R * cosLat) / DEG
        const { idx, val } = stencil(grid, lon, lat)
        profile.push(idx.reduce((a, k, q) => a + val[q] * field[k], 0))
      }
      let maxCurv = 0
      let maxSlope = 0
      for (let q = 20; q < profile.length - 20; q++) maxCurv = Math.max(maxCurv, Math.abs(profile[q + 20] - 2 * profile[q] + profile[q - 20]) / 100 ** 2)
      for (let q = 10; q < profile.length; q++) maxSlope = Math.max(maxSlope, Math.abs(profile[q] - profile[q - 10]) / 50)
      return { id: rw.id, length, radius: 1 / Math.max(maxCurv, 1e-9), slope: maxSlope }
    })
  }

  // Smallest cutoff on the ladder whose surface meets Annex 14 on every runway; 0 leaves raw terrain alone.
  // Raw terrain passes when plausible for any runway: LiDAR-grade data carries real 10-20 cm micro-relief.
  function chooseCutoff(apt, grid, h, baseW, anchors) {
    if (runwayShape(apt, grid, h).every((r) => r.radius >= 7500 && r.slope <= SLOPE_LIMIT)) return { cutoff: 0, fit: null }
    let fit = null
    for (const cutoff of LADDER) {
      fit = fitSurface(h, baseW, grid.nx, grid.ny, grid.cell, cutoff, anchors)
      if (runwayShape(apt, grid, fit.s).every((r) => r.radius >= radiusLimit(r.length) && r.slope <= SLOPE_LIMIT)) return { cutoff, fit }
    }
    return { cutoff: LADDER[LADDER.length - 1], fit }
  }

  // ---------- Surface build ----------

  function nextPow2(n) {
    let p = 1
    while (p < n) p <<= 1
    return p
  }

  async function buildSurface(icao, opts = {}) {
    const C = await window.__tsSpike.cesium()
    const source = opts.source ?? (await window.__tsSpike.rawProvider())
    const apt = window.__tsAirports[icao]
    const closing = opts.closingM ?? 250
    const blend = opts.blendM ?? 300
    const margin = blend + (opts.paddingM ?? 1000)
    const t0 = performance.now()
    const midLat = (apt.bbox.south + apt.bbox.north) / 2
    const cosLat = Math.cos(midLat * DEG)
    const spanX = (apt.bbox.east - apt.bbox.west) * DEG * R * cosLat + 2 * margin
    const spanY = (apt.bbox.north - apt.bbox.south) * DEG * R + 2 * margin
    // Power-of-two grid for the FFT; S is smooth at the cutoff wavelength, so a coarser cell
    // on a large airfield costs no accuracy
    const maxCells = opts.maxCells ?? 256
    const cell = Math.max(opts.cellM ?? 20, Math.max(spanX, spanY) / maxCells)
    const dLat = cell / R / DEG
    const dLon = cell / (R * cosLat) / DEG
    const nx = nextPow2(Math.ceil(spanX / cell))
    const ny = nextPow2(Math.ceil(spanY / cell))
    const west = (apt.bbox.west + apt.bbox.east) / 2 - ((nx - 1) / 2) * dLon
    const south = (apt.bbox.south + apt.bbox.north) / 2 - ((ny - 1) / 2) * dLat
    const cartos = []
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cartos.push(C.Cartographic.fromDegrees(west + i * dLon, south + j * dLat))
    await C.sampleTerrainMostDetailed(source, cartos)
    const tSample = performance.now()
    const h = Float64Array.from(cartos, (c) => c.height)
    const grid = { nx, ny, west, south, dLon, dLat, cell }
    const { paved, core, w } = airfieldWeight(apt, grid, closing, blend)
    const tMask = performance.now()
    const baseW = Float64Array.from(paved, (m) => (m ? 1 : OFF_PAVEMENT_WEIGHT))
    const anchors = thresholdAnchors(apt, grid)
    let cutoff = opts.cutoffM ?? 'auto'
    let fit
    if (cutoff === 'auto') ({ cutoff, fit } = chooseCutoff(apt, grid, h, baseW, anchors))
    else fit = fitSurface(h, baseW, nx, ny, cell, cutoff, anchors)
    // Cutoff 0: the raw terrain already looks like a runway, so the airfield is left alone
    const s = fit ? fit.s : h
    const robustW = fit ? fit.w : baseW
    const tSmooth = performance.now()
    let wMinLon = Infinity
    let wMaxLon = -Infinity
    let wMinLat = Infinity
    let wMaxLat = -Infinity
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (w[j * nx + i] <= 0) continue
        wMinLon = Math.min(wMinLon, west + i * dLon)
        wMaxLon = Math.max(wMaxLon, west + i * dLon)
        wMinLat = Math.min(wMinLat, south + j * dLat)
        wMaxLat = Math.max(wMaxLat, south + j * dLat)
      }
    }
    return {
      icao,
      grid,
      h,
      s,
      w,
      core,
      robustW,
      influence: C.Rectangle.fromDegrees(wMinLon - dLon, wMinLat - dLat, wMaxLon + dLon, wMaxLat + dLat),
      timings: { sampleMs: Math.round(tSample - t0), maskMs: Math.round(tMask - tSample), fitMs: Math.round(tSmooth - tMask) },
      params: { cell, cutoff, closing, blend, margin, cgIterations: fit ? fit.iterations : 0 },
    }
  }

  // Bilinear lookup of S and w at a position; w = 0 outside the grid
  function surfaceAt(surface, lonDeg, latDeg) {
    const { nx, ny, west, south, dLon, dLat } = surface.grid
    const fx = (lonDeg - west) / dLon
    const fy = (latDeg - south) / dLat
    if (fx < 0 || fy < 0 || fx >= nx - 1 || fy >= ny - 1) return { s: 0, w: 0 }
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = fx - i
    const ty = fy - j
    const k = j * nx + i
    const lerp = (a) => (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + nx] * (1 - tx) + a[k + nx + 1] * tx) * ty
    return { s: lerp(surface.s), w: lerp(surface.w) }
  }

  // Height an aircraft should stand on: S inside the airfield, null where raw terrain must be sampled
  function surfaceHeight(surface, lonDeg, latDeg) {
    const { s, w } = surfaceAt(surface, lonDeg, latDeg)
    return w >= 1 ? s : null
  }

  // ---------- Terrain provider ----------

  class AirfieldTerrainProvider {
    constructor(C, source, surface, opts = {}) {
      this._C = C
      this._source = source
      this._surface = surface
      this._minLevel = opts.minLevel ?? 11
      this._samples = opts.samples ?? 65
      this.stats = { resampled: 0, passedThrough: 0, ms: 0 }
    }
    get tilingScheme() {
      return this._source.tilingScheme
    }
    get availability() {
      return this._source.availability
    }
    get credit() {
      return this._source.credit
    }
    get errorEvent() {
      return this._source.errorEvent
    }
    get hasWaterMask() {
      return this._source.hasWaterMask
    }
    get hasVertexNormals() {
      // Resampled tiles are heightmaps, which carry no normals; mixing them with normal-bearing
      // quantized-mesh tiles would feed garbage normals to the globe shader.
      return false
    }
    get ready() {
      return true
    }
    getLevelMaximumGeometricError(level) {
      return this._source.getLevelMaximumGeometricError(level)
    }
    getTileDataAvailable(x, y, level) {
      return this._source.getTileDataAvailable(x, y, level)
    }
    loadTileDataAvailability(x, y, level) {
      return this._source.loadTileDataAvailability(x, y, level)
    }
    requestTileGeometry(x, y, level, request) {
      const rect = this._source.tilingScheme.tileXYToRectangle(x, y, level)
      const touches = this._C.Rectangle.intersection(rect, this._surface.influence) !== undefined
      const promise = this._source.requestTileGeometry(x, y, level, request)
      if (!promise) return undefined
      if (level < this._minLevel || !touches) {
        this.stats.passedThrough++
        return promise
      }
      return promise.then((data) => this._resample(data, rect, x, y))
    }
    _resample(data, rect, x, y) {
      const t0 = performance.now()
      const n = this._samples
      const heights = new Float32Array(n * n)
      for (let row = 0; row < n; row++) {
        // HeightmapTerrainData rows run from north to south
        const lat = rect.north - (row / (n - 1)) * (rect.north - rect.south)
        for (let col = 0; col < n; col++) {
          const lon = rect.west + (col / (n - 1)) * (rect.east - rect.west)
          const { s, w } = surfaceAt(this._surface, lon / DEG, lat / DEG)
          let height = s
          if (w < 1) {
            const raw = data.interpolateHeight(rect, lon, lat)
            height = (1 - w) * raw + w * s
          }
          heights[row * n + col] = height
        }
      }
      let childTileMask = 0
      if (data.isChildAvailable(x, y, 2 * x, 2 * y + 1)) childTileMask |= 1
      if (data.isChildAvailable(x, y, 2 * x + 1, 2 * y + 1)) childTileMask |= 2
      if (data.isChildAvailable(x, y, 2 * x, 2 * y)) childTileMask |= 4
      if (data.isChildAvailable(x, y, 2 * x + 1, 2 * y)) childTileMask |= 8
      this.stats.resampled++
      this.stats.ms += performance.now() - t0
      return new this._C.HeightmapTerrainData({
        buffer: heights,
        width: n,
        height: n,
        childTileMask,
        waterMask: data.waterMask,
        credits: data.credits,
      })
    }
  }

  async function install(icao, opts = {}) {
    const C = await window.__tsSpike.cesium()
    const source = await window.__tsSpike.rawProvider()
    const surface = await buildSurface(icao, { ...opts, source })
    const provider = new AirfieldTerrainProvider(C, source, surface, opts)
    window.__tc3d.viewer.terrainProvider = provider
    window.__tsSpike.current = { surface, provider }
    return { timings: surface.timings, grid: { nx: surface.grid.nx, ny: surface.grid.ny, cell: surface.grid.cell }, params: surface.params }
  }

  async function useRaw() {
    window.__tc3d.viewer.terrainProvider = await window.__tsSpike.rawProvider()
  }

  // Capture aid: elevation contours every `spacing` metres on the globe, plus vertical exaggeration
  async function contours(spacing, exaggeration = 1) {
    const C = await window.__tsSpike.cesium()
    const scene = window.__tc3d.viewer.scene
    scene.globe.material = spacing
      ? C.Material.fromType('ElevationContour', { spacing, width: 2, color: C.Color.YELLOW.withAlpha(0.9) })
      : undefined
    scene.verticalExaggeration = exaggeration
  }

  // Heights of the wrapped provider and of the drawn globe against S at points across the core
  async function consistency(count = 400) {
    const C = await window.__tsSpike.cesium()
    const { surface, provider } = window.__tsSpike.current
    const { nx, ny, west, south, dLon, dLat } = surface.grid
    // Random points where the blend weight is 1, i.e. where aircraft would read S directly
    const pts = []
    for (let k = 0; pts.length < count && k < count * 50; k++) {
      const lon = west + Math.random() * (nx - 1) * dLon
      const lat = south + Math.random() * (ny - 1) * dLat
      const at = surfaceAt(surface, lon, lat)
      if (at.w >= 0.999) pts.push({ lon, lat, s: at.s })
    }
    const cartos = pts.map((q) => C.Cartographic.fromDegrees(q.lon, q.lat))
    await C.sampleTerrainMostDetailed(provider, cartos)
    const globe = window.__tc3d.viewer.scene.globe
    let maxSampled = 0
    let sumSq = 0
    let maxDrawn = 0
    let drawn = 0
    pts.forEach((q, k) => {
      const d = Math.abs(cartos[k].height - q.s)
      maxSampled = Math.max(maxSampled, d)
      sumSq += d * d
      const g = globe.getHeight(C.Cartographic.fromDegrees(q.lon, q.lat))
      if (g !== undefined) {
        drawn++
        maxDrawn = Math.max(maxDrawn, Math.abs(g - q.s))
      }
    })
    return {
      points: pts.length,
      maxSampledVsS: maxSampled,
      rmsSampledVsS: Math.sqrt(sumSq / Math.max(pts.length, 1)),
      drawnPoints: drawn,
      maxDrawnVsS: maxDrawn,
      stats: provider.stats,
    }
  }

  window.__tsSpike = Object.assign(window.__tsSpike ?? {}, {
    makeDct,
    fitSurface,
    runwayShape,
    airfieldWeight,
    buildSurface,
    surfaceAt,
    surfaceHeight,
    AirfieldTerrainProvider,
    install,
    useRaw,
    contours,
    consistency,
  })
})()
