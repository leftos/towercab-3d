# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scipy>=1.14", "matplotlib>=3.9"]
# ///
"""Analyse raw Cesium World Terrain samples taken by measure.js at airports.

Reads <src>/<ICAO>.json (and <ICAO>-after.json when present: the same sampling through the spike
provider), fits the airfield surface S of the recommended design, prints Markdown tables of the raw
noise, the real gradient and the effect of the cutoff wavelength, and writes profile and map PNGs.

Usage:
    uv run spikes/terrain-smoothing/analyze.py <src dir> <png dir> [cutoff m] [sweep cutoffs, comma separated]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.path import Path as MplPath
from scipy.fft import dctn, idctn
from scipy.ndimage import distance_transform_edt, map_coordinates

FT = 0.3048
R = 6378137.0
DEG = np.pi / 180
ICAO_ORDER = ["YMML", "YSSY", "YBBN", "YPPH", "YBCS", "YMHB", "YSCB", "YMLT", "KSFO", "KOAK"]
CLOSING_M = 250.0
BLEND_M = 300.0
OFF_PAVEMENT_WEIGHT = 0.02


# ---------- the fit ----------


def laplacian_eigen(ny: int, nx: int, cell: float) -> np.ndarray:
    ly = (2 - 2 * np.cos(np.pi * np.arange(ny) / ny))[:, None] / cell**2
    lx = (2 - 2 * np.cos(np.pi * np.arange(nx) / nx))[None, :] / cell**2
    return ly + lx


def weighted_plane(h: np.ndarray, w: np.ndarray) -> np.ndarray:
    ny, nx = h.shape
    yy, xx = np.mgrid[0:ny, 0:nx].astype(float)
    a = np.column_stack([np.ones(h.size), xx.ravel(), yy.ravel()]) * np.sqrt(w.ravel())[:, None]
    coef, *_ = np.linalg.lstsq(a, h.ravel() * np.sqrt(w.ravel()), rcond=None)
    return coef[0] + coef[1] * xx + coef[2] * yy


Constraint = tuple[np.ndarray, float]
CONSTRAINT_WEIGHT = 2000.0


def solve_weighted(h: np.ndarray, w: np.ndarray, cell: float, cutoff: float, x0: np.ndarray, constraints: list[Constraint]) -> tuple[np.ndarray, int]:
    """Minimise sum w (s - h)^2 + p |laplacian s|^2 + mu sum (g . s - delta)^2 by preconditioned conjugate gradients.

    Each constraint (g, delta) holds a published height difference between two runway thresholds; g is
    the bilinear stencil of the far threshold minus that of the near one.
    """
    k = (cutoff / (2 * np.pi)) ** 4 * laplacian_eigen(*h.shape, cell) ** 2

    def apply_a(x: np.ndarray) -> np.ndarray:
        out = w * x + idctn(k * dctn(x, norm="ortho"), norm="ortho")
        for g, _ in constraints:
            out += CONSTRAINT_WEIGHT * g * float(np.sum(g * x))
        return out

    pre = 1.0 / (max(float(w.mean()), 0.05) + k)

    def apply_m(r: np.ndarray) -> np.ndarray:
        return idctn(pre * dctn(r, norm="ortho"), norm="ortho")

    b = w * h
    for g, delta in constraints:
        b = b + CONSTRAINT_WEIGHT * delta * g
    x = x0.copy()
    r = b - apply_a(x)
    z = apply_m(r)
    p = z.copy()
    rz = float(np.sum(r * z))
    bnorm = float(np.linalg.norm(b)) + 1e-12
    for it in range(1, 400):
        ap = apply_a(p)
        alpha = rz / float(np.sum(p * ap))
        x += alpha * p
        r -= alpha * ap
        if float(np.linalg.norm(r)) / bnorm < 1e-7:
            return x, it
        z = apply_m(r)
        rz_new = float(np.sum(r * z))
        p = z + (rz_new / rz) * p
        rz = rz_new
    return x, 400


def fit_surface(
    h: np.ndarray, base_w: np.ndarray, cell: float, cutoff: float, anchors: list[Constraint] | None = None
) -> tuple[np.ndarray, np.ndarray, int]:
    """Robust (bisquare) weighted penalised fit; base_w is 1 on pavement and small elsewhere."""
    plane = weighted_plane(h, base_w)
    d = h - plane
    constraints = [(g, delta - float(np.sum(g * plane))) for g, delta in (anchors or [])]
    w = base_w.copy()
    s = np.zeros_like(d)
    iters = 0
    for _ in range(3):
        s, it = solve_weighted(d, w, cell, cutoff, s, constraints)
        iters += it
        r = d - s
        on = base_w >= 0.5
        mad = np.median(np.abs(r[on] - np.median(r[on]))) * 1.4826 + 1e-6
        u = r / (4.685 * mad)
        w = base_w * np.where(np.abs(u) < 1, (1 - u**2) ** 2, 0.0)
    s, it = solve_weighted(d, w, cell, cutoff, s, constraints)
    return s + plane, w, iters + it


# ---------- masks ----------


def runway_axes(apt: dict, lon0: float, lat0: float, cos_lat: float) -> list[dict]:
    out = []
    for rw in apt["runways"]:
        ax = (rw["le"]["lon"] - lon0) * DEG * R * cos_lat
        ay = (rw["le"]["lat"] - lat0) * DEG * R
        bx = (rw["he"]["lon"] - lon0) * DEG * R * cos_lat
        by = (rw["he"]["lat"] - lat0) * DEG * R
        length = float(np.hypot(bx - ax, by - ay))
        out.append({"ax": ax, "ay": ay, "ux": (bx - ax) / length, "uy": (by - ay) / length, "len": length, "half": rw["widthM"] / 2})
    return out


def masks(apt: dict, grid: dict) -> dict[str, np.ndarray]:
    """paved: polygons and runway surfaces; core: paved plus runway strips, closed; weight: the blend."""
    nx, ny = grid["nx"], grid["ny"]
    lon = grid["west"] + np.arange(nx) * grid["dLon"]
    lat = grid["south"] + np.arange(ny) * grid["dLat"]
    glon, glat = np.meshgrid(lon, lat)
    pts = np.column_stack([glon.ravel(), glat.ravel()])
    paved = np.zeros(nx * ny, dtype=bool)
    for p in apt["pavements"]:
        inside = MplPath(np.array(p["v"])).contains_points(pts)
        for hole in p.get("h") or []:
            inside &= ~MplPath(np.array(hole)).contains_points(pts)
        paved |= inside
    paved = paved.reshape(ny, nx)
    cos_lat = np.cos(lat.mean() * DEG)
    ex = (glon - lon[0]) * DEG * R * cos_lat
    ey = (glat - lat[0]) * DEG * R
    strips = np.zeros_like(paved)
    for a in runway_axes(apt, lon[0], lat[0], cos_lat):
        along = (ex - a["ax"]) * a["ux"] + (ey - a["ay"]) * a["uy"]
        across = -(ex - a["ax"]) * a["uy"] + (ey - a["ay"]) * a["ux"]
        paved |= (along >= 0) & (along <= a["len"]) & (np.abs(across) <= a["half"])
        strips |= (along >= -60) & (along <= a["len"] + 60) & (np.abs(across) <= 75)
    cell = grid["dLat"] * DEG * R
    base = paved | strips
    dilated = distance_transform_edt(~base) * cell <= CLOSING_M
    core = (distance_transform_edt(dilated) * cell > CLOSING_M) | base
    t = np.clip(distance_transform_edt(~core) * cell / BLEND_M, 0, 1)
    return {"paved": paved, "core": core, "weight": 1 - (3 * t**2 - 2 * t**3)}


# ---------- per runway ----------


def centreline_lonlat(rw: dict, s: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    cos_lat = np.cos(rw["le"]["lat"] * DEG)
    de = (rw["he"]["lon"] - rw["le"]["lon"]) * DEG * R * cos_lat
    dn = (rw["he"]["lat"] - rw["le"]["lat"]) * DEG * R
    length = np.hypot(de, dn)
    lat = rw["le"]["lat"] + (dn / length * s) / R / DEG
    lon = rw["le"]["lon"] + (de / length * s) / (R * cos_lat) / DEG
    return lon, lat


def grid_sample(field: np.ndarray, grid: dict, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    fx = (lon - grid["west"]) / grid["dLon"]
    fy = (lat - grid["south"]) / grid["dLat"]
    return map_coordinates(field, [fy, fx], order=1, mode="nearest")


def band_rms(profile: np.ndarray, spacing: float) -> dict[str, float]:
    """RMS amplitude of the linearly detrended profile in wavelength bands."""
    x = np.arange(len(profile))
    y = profile - np.polyval(np.polyfit(x, profile, 1), x)
    spec = np.fft.rfft(y)
    freqs = np.fft.rfftfreq(len(y), d=spacing)
    wl = 1 / np.maximum(freqs, 1e-12)
    out = {}
    for name, lo, hi in (("<100", 0, 100), ("100-300", 100, 300), ("300-1000", 300, 1000), (">1000", 1000, np.inf)):
        part = np.where((freqs > 0) & (wl >= lo) & (wl < hi), spec, 0)
        out[name] = float(np.sqrt(np.mean(np.fft.irfft(part, n=len(y)) ** 2)))
    return out


def dominant_wavelength(residual: np.ndarray, spacing: float) -> float:
    y = (residual - residual.mean()) * np.hanning(len(residual))
    spec = np.abs(np.fft.rfft(y)) ** 2
    spec[0] = 0
    return float(1 / np.fft.rfftfreq(len(y), d=spacing)[int(np.argmax(spec))])


def slope_over(profile: np.ndarray, spacing: float, base_m: float) -> np.ndarray:
    k = round(base_m / spacing)
    return (profile[k:] - profile[:-k]) / (k * spacing)


def min_radius(profile: np.ndarray, spacing: float, base_m: float = 100.0) -> float:
    """Smallest radius of curvature, from second differences over base_m (ignores grid-interpolation kinks)."""
    k = round(base_m / spacing)
    curv = (profile[2 * k :] - 2 * profile[k:-k] + profile[: -2 * k]) / (k * spacing) ** 2
    return float(1 / max(np.max(np.abs(curv)), 1e-9))


def runway_metrics(rw: dict, geoid: float, s_grid: np.ndarray, grid: dict) -> dict:
    s = np.array(rw["centre"]["s"], dtype=float)
    h = np.array(rw["centre"]["h"]) - geoid
    on = (s >= 0) & (s <= rw["lengthM"])
    s_on, h_on = s[on], h[on]
    spacing = float(s[1] - s[0])
    lon, lat = centreline_lonlat(rw, s_on)
    fit = grid_sample(s_grid, grid, lon, lat)
    resid = h_on - fit
    le_pub = rw["le"]["elevFt"] * FT if rw["le"]["elevFt"] is not None else None
    he_pub = rw["he"]["elevFt"] * FT if rw["he"]["elevFt"] is not None else None
    pub_delta = he_pub - le_pub if le_pub is not None and he_pub is not None else None
    cross = []
    for c in rw["cross"]:
        t = np.array(c["t"], dtype=float)
        hc = np.array(c["h"]) - geoid
        sel = np.abs(t) <= rw["widthM"] / 2
        cross.append(float(np.ptp(hc[sel] - np.polyval(np.polyfit(t[sel], hc[sel], 1), t[sel]))))
    return {
        "id": rw["id"],
        "length": rw["lengthM"],
        "raw_p2p": float(np.ptp(h_on)),
        "grade_pct": float((fit[-1] - fit[0]) / rw["lengthM"] * 100),
        "fit_delta": float(fit[-1] - fit[0]),
        "pub_delta": pub_delta,
        "delta_err": None if pub_delta is None else float(fit[-1] - fit[0] - pub_delta),
        "noise_rms": float(np.sqrt(np.mean(resid**2))),
        "noise_p2p": float(np.ptp(resid)),
        "wavelength": dominant_wavelength(resid, spacing),
        "bands": band_rms(h_on, spacing),
        "raw_slope50": float(np.max(np.abs(slope_over(h_on, spacing, 50))) * 100),
        "raw_radius": min_radius(h_on, spacing),
        "fit_slope50": float(np.max(np.abs(slope_over(fit, spacing, 50))) * 100),
        "fit_radius": min_radius(fit, spacing),
        "cross_p2p": float(np.max(cross)),
        "s": s_on,
        "h": h_on,
        "fit": fit,
    }


def stencil(grid: dict, lon: float, lat: float) -> np.ndarray:
    g = np.zeros((grid["ny"], grid["nx"]))
    fx = (lon - grid["west"]) / grid["dLon"]
    fy = (lat - grid["south"]) / grid["dLat"]
    i, j = int(fx), int(fy)
    tx, ty = fx - i, fy - j
    g[j, i], g[j, i + 1], g[j + 1, i], g[j + 1, i + 1] = (1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty
    return g


def threshold_anchors(apt: dict, grid: dict) -> list[Constraint]:
    """Published threshold height differences (OurAirports, feet) for runways that list both ends."""
    out = []
    for rw in apt["runways"]:
        if rw["le"]["elevFt"] is None or rw["he"]["elevFt"] is None:
            continue
        g = stencil(grid, rw["he"]["lon"], rw["he"]["lat"]) - stencil(grid, rw["le"]["lon"], rw["le"]["lat"])
        out.append((g, (rw["he"]["elevFt"] - rw["le"]["elevFt"]) * FT))
    return out


LADDER = [0.0, 300.0, 500.0, 800.0, 1200.0, 1800.0, 2500.0]
SLOPE_LIMIT_PCT = 1.5


def radius_limit(length_m: float) -> float:
    """Annex 14 minimum radius of curvature by code number (from runway length)."""
    if length_m >= 1800:
        return 30000.0
    if length_m >= 1200:
        return 15000.0
    return 7500.0


def passes(m: dict, use_fit: bool) -> bool:
    """Raw terrain passes when it is plausible for any runway (LiDAR-grade data has real 10-20 cm micro-relief
    that a code 4 curvature test over 100 m would reject); a fitted surface must meet its runway's code."""
    if not use_fit:
        return m["raw_radius"] >= 7500.0 and m["raw_slope50"] <= SLOPE_LIMIT_PCT
    return m["fit_radius"] >= radius_limit(m["length"]) and m["fit_slope50"] <= SLOPE_LIMIT_PCT


def choose_cutoff(
    data: dict, apt: dict, h: np.ndarray, base_w: np.ndarray, cell: float, anchors: list[Constraint]
) -> tuple[float, np.ndarray | None, list[dict]]:
    """Smallest cutoff on the ladder whose surface meets Annex 14 on every runway; 0 means leave raw terrain alone."""
    g = data["grid"]
    raw_metrics = [runway_metrics(rw, apt["geoidM"], h, g) for rw in data["runways"]]
    if all(passes(m, use_fit=False) for m in raw_metrics):
        return 0.0, None, raw_metrics
    for cutoff in LADDER[1:]:
        s, _, _ = fit_surface(h, base_w, cell, cutoff, anchors)
        ms = [runway_metrics(rw, apt["geoidM"], s, g) for rw in data["runways"]]
        if all(passes(m, use_fit=True) for m in ms):
            return cutoff, s, ms
    return LADDER[-1], s, ms


# ---------- output ----------


def plot_runway(icao: str, m: dict, out: Path, cutoff: float, after: dict | None) -> None:
    fig, ax = plt.subplots(figsize=(10, 3.2), dpi=110)
    ax.plot(m["s"], m["h"], lw=0.9, color="#c0392b", label="raw Cesium World Terrain")
    ax.plot(m["s"], m["fit"], lw=1.6, color="#2c3e50", label=f"airfield surface S (cutoff {cutoff:.0f} m)")
    if after is not None:
        ax.plot(after["s"], after["h"], lw=1.0, ls="--", color="#27ae60", label="spike provider, sampled in the app")
    ax.set_xlabel("distance from threshold (m)")
    ax.set_ylabel("height MSL (m)")
    ax.set_title(f"{icao} runway {m['id']} centreline: raw minus S RMS {m['noise_rms']:.2f} m, grade {m['grade_pct']:.2f}%")
    ax.grid(alpha=0.3)
    ax.legend(loc="best", fontsize=8)
    fig.tight_layout()
    fig.savefig(out / f"profile-{icao}-{m['id'].replace('/', '-')}.png")
    plt.close(fig)


def plot_grid(icao: str, h: np.ndarray, s: np.ndarray, mk: dict, cell: float, out: Path) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(15, 5), dpi=100)
    extent = [0, h.shape[1] * cell / 1000, 0, h.shape[0] * cell / 1000]
    lo, hi = np.percentile(h[mk["paved"]], [1, 99])
    result = (1 - mk["weight"]) * h + mk["weight"] * s
    for ax, field, title in ((axes[0], h, "raw height MSL (m)"), (axes[1], result, "after: blended airfield surface (m)")):
        im = ax.imshow(field, origin="lower", extent=extent, cmap="terrain", vmin=lo - 2, vmax=hi + 2)
        ax.contour(mk["core"], levels=[0.5], origin="lower", extent=extent, colors="k", linewidths=0.6)
        ax.set_title(f"{icao} {title}")
        fig.colorbar(im, ax=ax, shrink=0.8)
    diff = np.where(mk["weight"] > 0, h - s, np.nan)
    im = axes[2].imshow(diff, origin="lower", extent=extent, cmap="RdBu_r", vmin=-3, vmax=3)
    axes[2].contour(mk["paved"], levels=[0.5], origin="lower", extent=extent, colors="k", linewidths=0.4)
    axes[2].set_title(f"{icao} raw minus S (m), paved outlined")
    fig.colorbar(im, ax=axes[2], shrink=0.8)
    for ax in axes:
        ax.set_xlabel("km east")
        ax.set_ylabel("km north")
    fig.tight_layout()
    fig.savefig(out / f"grid-{icao}.png")
    plt.close(fig)


def fmt(v: float | None, spec: str) -> str:
    return "n/a" if v is None else format(v, spec)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    fixed = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
    sweep = [float(c) for c in sys.argv[4].split(",")] if len(sys.argv) > 4 and sys.argv[4] != "-" else []
    use_anchors = not (len(sys.argv) > 5 and sys.argv[5] == "noanchor")
    out.mkdir(parents=True, exist_ok=True)
    airports = json.loads(Path("spikes/terrain-smoothing/airports.json").read_text(encoding="utf-8"))
    raw_rows, sweep_rows, after_rows, airport_rows = [], [], [], []
    for icao in ICAO_ORDER:
        path = src / f"{icao}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        apt = airports[icao]
        g = data["grid"]
        h = np.array(g["h"], dtype=float).reshape(g["ny"], g["nx"]) - apt["geoidM"]
        cell = g["dLat"] * DEG * R
        mk = masks(apt, g)
        base_w = np.where(mk["paved"], 1.0, OFF_PAVEMENT_WEIGHT)
        anchors = [] if use_anchors is False else threshold_anchors(apt, g)
        if fixed is None:
            cutoff, _, _ = choose_cutoff(data, apt, h, base_w, cell, anchors)
        else:
            cutoff = fixed
        if cutoff > 0:
            s, w, iters = fit_surface(h, base_w, cell, cutoff, anchors)
        else:
            s, w, iters = h, base_w, 0
        after_path = src / f"{icao}-after.json"
        after = json.loads(after_path.read_text(encoding="utf-8")) if after_path.exists() else None
        for idx, rw in enumerate(data["runways"]):
            m = runway_metrics(rw, apt["geoidM"], s, g)
            b = m["bands"]
            raw_rows.append(
                f"| {icao} | {m['id']} | {m['length']:.0f} | {m['raw_p2p']:.1f} | {fmt(m['pub_delta'], '+.1f')} | {m['fit_delta']:+.1f} | {m['grade_pct']:+.2f} | "
                f"{m['noise_rms']:.2f} | {m['noise_p2p']:.1f} | {m['wavelength']:.0f} | {b['<100']:.2f} / {b['100-300']:.2f} / {b['300-1000']:.2f} / {b['>1000']:.2f} | "
                f"{m['raw_slope50']:.1f} | {m['fit_slope50']:.2f} | {m['raw_radius'] / 1000:.0f} | {m['fit_radius'] / 1000:.0f} | {m['cross_p2p']:.1f} |"
            )
            cells = []
            for c in sweep:
                sc, _, _ = fit_surface(h, base_w, cell, c, anchors)
                mc = runway_metrics(rw, apt["geoidM"], sc, g)
                cells.append(f"{mc['noise_rms']:.2f} / {mc['fit_radius'] / 1000:.0f} / {fmt(mc['delta_err'], '+.1f')}")
            if sweep:
                sweep_rows.append(f"| {icao} | {m['id']} | " + " | ".join(cells) + " |")
            a = None
            if after is not None:
                ar = after["runways"][idx]
                a_h = np.array(ar["centre"]["h"]) - apt["geoidM"]
                a_s = np.array(ar["centre"]["s"], dtype=float)
                on = (a_s >= 0) & (a_s <= ar["lengthM"])
                a = {"s": a_s[on], "h": a_h[on]}
                dev = a["h"] - m["fit"]
                spacing = float(a_s[1] - a_s[0])
                after_rows.append(
                    f"| {icao} | {m['id']} | {m['noise_rms']:.2f} | {float(np.sqrt(np.mean(dev**2))):.3f} | {float(np.max(np.abs(dev))):.3f} | "
                    f"{m['raw_slope50']:.1f} | {float(np.max(np.abs(slope_over(a['h'], spacing, 50))) * 100):.2f} | "
                    f"{min_radius(a['h'], spacing) / 1000:.0f} |"
                )
            plot_runway(icao, m, out, cutoff, a)
        resid = (h - s)[mk["paved"]]
        tin = data.get("tin") or {}
        verts = len(tin.get("verts", []))
        bbox = apt["bbox"]
        area = (bbox["east"] - bbox["west"]) * DEG * R * np.cos(bbox["south"] * DEG) * (bbox["north"] - bbox["south"]) * DEG * R
        airport_rows.append(
            f"| {icao} | {cutoff:.0f} | {data['maxLevel']} | {verts} | {np.sqrt(area / max(verts, 1)):.0f} | {float(np.sqrt(np.mean(resid**2))):.2f} | "
            f"{float(np.percentile(np.abs(resid), 99)):.2f} | {float(np.mean(w[mk['paved']] < 0.05) * 100):.1f} | {iters} |"
        )
        plot_grid(icao, h, s, mk, cell, out)
    print("Cutoff wavelength: " + ("chosen per airport" if fixed is None else f"{fixed:.0f} m") + "\n")
    print(
        "| Airport | Runway | Length m | Raw P2P m | Published Δh m | S Δh m | S grade % | Raw − S RMS m | Raw − S P2P m | Dominant λ m | Raw RMS by λ <100 / 100–300 / 300–1000 / >1000 m | Raw max 50 m slope % | S max 50 m slope % | Raw min radius km | S min radius km | Raw cross P2P m |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    print("\n".join(raw_rows))
    print(
        "\n| Airport | Chosen cutoff m | CWT level | TIN vertices over paved bbox | Mean vertex spacing m | Paved raw − S RMS m | p99 m | Outlier cells % | CG iterations |"
    )
    print("|---|---|---|---|---|---|---|---|---|")
    print("\n".join(airport_rows))
    if sweep:
        print("\nCutoff sweep, each cell: raw − S RMS m / S min radius km / S Δh minus published Δh m\n")
        print("| Airport | Runway | " + " | ".join(f"{c:.0f} m" for c in sweep) + " |")
        print("|---|---|" + "---|" * len(sweep))
        print("\n".join(sweep_rows))
    if after_rows:
        print(
            "\n| Airport | Runway | Raw − S RMS m | Provider − S RMS m | Provider − S max m | Raw max 50 m slope % | Provider max 50 m slope % | Provider min radius km |"
        )
        print("|---|---|---|---|---|---|---|---|")
        print("\n".join(after_rows))


if __name__ == "__main__":
    main()
