# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy>=2.1", "scipy>=1.14", "matplotlib>=3.9"]
# ///
"""Analyse raw Cesium World Terrain samples taken by measure.js at airports.

Reads .tmp/terrain-measure/<ICAO>.json (written by browser_evaluate in the running app),
prints per-runway noise and gradient figures as a Markdown table, and writes profile,
cross-section and residual-map PNGs to the given output folder.

Usage:
    uv run spikes/terrain-smoothing/analyze.py .tmp/terrain-measure docs/plans/canvases/terrain-smoothing-greenfield
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.fft import dctn, idctn
from scipy.ndimage import distance_transform_edt
from matplotlib.path import Path as MplPath

FT = 0.3048
R = 6378137.0
ICAO_ORDER = ["YMML", "YSSY", "YBBN", "YPPH", "YBCS", "YMHB", "YSCB", "YMLT", "KSFO", "KOAK"]


def penalised_smooth_1d(y: np.ndarray, spacing: float, cutoff: float) -> np.ndarray:
    """Second-derivative-penalised smoothing (1D thin plate) with a half-power cutoff wavelength."""
    return penalised_smooth(y[None, :], spacing, cutoff)[0]


def penalised_smooth(h: np.ndarray, spacing: float, cutoff: float, weights: np.ndarray | None = None, iterations: int = 1) -> np.ndarray:
    """Penalised least squares smoothing on a grid via the DCT (Garcia 2010, smoothn).

    Minimises sum w (s - h)^2 + p * |laplacian s|^2. With a half-power cutoff wavelength L, the
    filter is 1 / (1 + (L f)^4) in the continuous limit, which passes planes and quadratics.
    """
    ny, nx = h.shape
    lam = np.zeros((ny, nx))
    if ny > 1:
        lam = lam + (2 - 2 * np.cos(np.pi * np.arange(ny) / ny))[:, None] / spacing**2
    if nx > 1:
        lam = lam + (2 - 2 * np.cos(np.pi * np.arange(nx) / nx))[None, :] / spacing**2
    # (2 pi f)^2 ~ lam, so (L f)^4 = (L / 2pi)^4 lam^2
    gamma = 1.0 / (1.0 + (cutoff / (2 * np.pi)) ** 4 * lam**2)
    if weights is None:
        return idctn(gamma * dctn(h, norm="ortho"), norm="ortho")
    s = h.copy()
    for _ in range(iterations):
        s = idctn(gamma * dctn(weights * (h - s) + s, norm="ortho"), norm="ortho")
    return s


def robust_smooth(h: np.ndarray, spacing: float, cutoff: float) -> tuple[np.ndarray, np.ndarray]:
    """Robust penalised smoothing: bisquare reweighting against outliers such as buildings and trees."""
    w = np.ones_like(h)
    s = penalised_smooth(h, spacing, cutoff)
    for _ in range(4):
        r = h - s
        mad = np.median(np.abs(r - np.median(r))) * 1.4826 + 1e-6
        u = r / (4.685 * mad)
        w = np.where(np.abs(u) < 1, (1 - u**2) ** 2, 0.0)
        s = penalised_smooth(h, spacing, cutoff, weights=w, iterations=40)
    return s, w


def band_rms(residual: np.ndarray, spacing: float) -> dict[str, float]:
    """RMS amplitude of the detrended profile in wavelength bands."""
    y = residual - np.polyval(np.polyfit(np.arange(len(residual)), residual, 1), np.arange(len(residual)))
    spec = np.fft.rfft(y)
    freqs = np.fft.rfftfreq(len(y), d=spacing)
    out = {}
    bands = [("<100", 100, 0), ("100-300", 300, 100), ("300-1000", 1000, 300), (">1000", np.inf, 1000)]
    for name, hi, lo in bands:
        sel = (freqs > 0) & (1 / np.maximum(freqs, 1e-12) < hi) & (1 / np.maximum(freqs, 1e-12) >= lo)
        part = np.zeros_like(spec)
        part[sel] = spec[sel]
        out[name] = float(np.sqrt(np.mean(np.fft.irfft(part, n=len(y)) ** 2)))
    return out


def dominant_wavelength(residual: np.ndarray, spacing: float) -> float:
    y = (residual - residual.mean()) * np.hanning(len(residual))
    spec = np.abs(np.fft.rfft(y)) ** 2
    freqs = np.fft.rfftfreq(len(y), d=spacing)
    spec[0] = 0
    return float(1 / freqs[int(np.argmax(spec))])


def analyse_runway(rw: dict, geoid: float, cutoff: float) -> dict:
    s = np.array(rw["centre"]["s"])
    h = np.array(rw["centre"]["h"]) - geoid
    length = rw["lengthM"]
    on = (s >= 0) & (s <= length)
    s_on, h_on = s[on], h[on]
    spacing = float(s[1] - s[0])
    smooth = penalised_smooth_1d(h, spacing, cutoff)[on]
    resid = h_on - smooth
    line = np.polyfit(s_on, h_on, 1)
    # Local slope seen by a taxiing aircraft over 50 m, minus the smooth profile's slope
    k = int(round(50 / spacing))
    raw_slope = (h_on[k:] - h_on[:-k]) / (k * spacing)
    smooth_slope = (smooth[k:] - smooth[:-k]) / (k * spacing)
    curv = np.gradient(np.gradient(smooth, spacing), spacing)
    le_pub = rw["le"]["elevFt"] * FT if rw["le"]["elevFt"] is not None else None
    he_pub = rw["he"]["elevFt"] * FT if rw["he"]["elevFt"] is not None else None
    cross_p2p = []
    cross_strip_p2p = []
    for c in rw["cross"]:
        t = np.array(c["t"], dtype=float)
        hc = np.array(c["h"]) - geoid
        half = rw["widthM"] / 2
        for lim, store in ((half, cross_p2p), (75.0, cross_strip_p2p)):
            sel = np.abs(t) <= lim
            fit = np.polyval(np.polyfit(t[sel], hc[sel], 1), t[sel])
            store.append(float(np.ptp(hc[sel] - fit)))
    return {
        "id": rw["id"],
        "length": length,
        "raw_p2p": float(np.ptp(h_on)),
        "grade_pct": float(line[0] * 100),
        "end_to_end": float(smooth[-1] - smooth[0]),
        "pub_delta": (he_pub - le_pub) if le_pub is not None and he_pub is not None else None,
        "le_err": (smooth[0] - le_pub) if le_pub is not None else None,
        "he_err": (smooth[-1] - he_pub) if he_pub is not None else None,
        "noise_rms": float(np.sqrt(np.mean(resid**2))),
        "noise_p2p": float(np.ptp(resid)),
        "wavelength": dominant_wavelength(resid, spacing),
        "bands": band_rms(h_on, spacing),
        "max_slope_dev_pct": float(np.max(np.abs(raw_slope - smooth_slope)) * 100),
        "max_raw_slope_pct": float(np.max(np.abs(raw_slope)) * 100),
        "min_radius_m": float(1 / max(np.max(np.abs(curv)), 1e-9)),
        "cross_p2p_max": float(np.max(cross_p2p)),
        "cross_strip_p2p_max": float(np.max(cross_strip_p2p)),
        "s": s_on,
        "h": h_on,
        "smooth": smooth,
    }


def airfield_mask(apt: dict, grid: dict, closing_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Paved polygons plus runway strips, closed by closing_m; returns (mask, distance outside it in m)."""
    nx, ny = grid["nx"], grid["ny"]
    lon = grid["west"] + np.arange(nx) * grid["dLon"]
    lat = grid["south"] + np.arange(ny) * grid["dLat"]
    glon, glat = np.meshgrid(lon, lat)
    pts = np.column_stack([glon.ravel(), glat.ravel()])
    mask = np.zeros(nx * ny, dtype=bool)
    for p in apt["pavements"]:
        inside = MplPath(np.array(p["v"])).contains_points(pts)
        for hole in p.get("h") or []:
            inside &= ~MplPath(np.array(hole)).contains_points(pts)
        mask |= inside
    mid_lat = np.radians(lat.mean())
    ex = (glon - lon[0]) * np.pi / 180 * R * np.cos(mid_lat)
    ny_m = (glat - lat[0]) * np.pi / 180 * R
    for rw in apt["runways"]:
        ax = (rw["le"]["lon"] - lon[0]) * np.pi / 180 * R * np.cos(mid_lat)
        ay = (rw["le"]["lat"] - lat[0]) * np.pi / 180 * R
        bx = (rw["he"]["lon"] - lon[0]) * np.pi / 180 * R * np.cos(mid_lat)
        by = (rw["he"]["lat"] - lat[0]) * np.pi / 180 * R
        length = np.hypot(bx - ax, by - ay)
        ux, uy = (bx - ax) / length, (by - ay) / length
        along = (ex - ax) * ux + (ny_m - ay) * uy
        across = -(ex - ax) * uy + (ny_m - ay) * ux
        strip = (along >= -60) & (along <= length + 60) & (np.abs(across) <= 75)
        mask |= strip.ravel()
    mask = mask.reshape(ny, nx)
    cell = grid["dLat"] * np.pi / 180 * R
    dilated = distance_transform_edt(~mask) * cell <= closing_m
    closed = distance_transform_edt(dilated) * cell > closing_m
    closed |= mask
    outside = distance_transform_edt(~closed) * cell
    return closed, outside


def analyse_grid(apt: dict, data: dict, cutoff: float, blend: float) -> dict:
    g = data["grid"]
    h = np.array(g["h"], dtype=float).reshape(g["ny"], g["nx"]) - apt["geoidM"]
    cell = g["dLat"] * np.pi / 180 * R
    smooth, w = robust_smooth(h, cell, cutoff)
    core, outside = airfield_mask(apt, g, 250.0)
    t = np.clip(outside / blend, 0, 1)
    weight = 1 - (3 * t**2 - 2 * t**3)
    result = (1 - weight) * h + weight * smooth
    resid = (h - smooth)[core]
    return {
        "h": h,
        "smooth": smooth,
        "result": result,
        "core": core,
        "weight": weight,
        "robust_w": w,
        "cell": cell,
        "core_rms": float(np.sqrt(np.mean(resid**2))),
        "core_p99": float(np.percentile(np.abs(resid), 99)),
        "core_p2p": float(np.ptp(resid)),
        "outliers_pct": float(np.mean(w[core] < 0.05) * 100),
    }


def plot_runway(icao: str, r: dict, out: Path, after: dict | None = None) -> None:
    fig, ax = plt.subplots(figsize=(10, 3.2), dpi=110)
    ax.plot(r["s"], r["h"], lw=0.9, color="#c0392b", label="raw Cesium World Terrain")
    if after is None:
        ax.plot(r["s"], r["smooth"], lw=1.6, color="#2c3e50", label="1D smooth of the centreline (cutoff wavelength)")
    else:
        ax.plot(after["s"], after["h"], lw=1.6, color="#2c3e50", label="spike provider (airfield surface)")
    ax.set_xlabel("distance from threshold (m)")
    ax.set_ylabel("height MSL (m)")
    ax.set_title(f"{icao} runway {r['id']} centreline: noise RMS {r['noise_rms']:.2f} m, grade {r['grade_pct']:.2f}%")
    ax.grid(alpha=0.3)
    ax.legend(loc="best", fontsize=8)
    fig.tight_layout()
    fig.savefig(out / f"profile-{icao}-{r['id'].replace('/', '-')}.png")
    plt.close(fig)


def plot_grid(icao: str, g: dict, out: Path) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(15, 5), dpi=100)
    extent = [0, g["h"].shape[1] * g["cell"] / 1000, 0, g["h"].shape[0] * g["cell"] / 1000]
    lo, hi = np.percentile(g["h"][g["core"]], [1, 99])
    for ax, field, title in ((axes[0], g["h"], "raw height MSL (m)"), (axes[1], g["result"], "smoothed + blended (m)")):
        im = ax.imshow(field, origin="lower", extent=extent, cmap="terrain", vmin=lo - 2, vmax=hi + 2)
        ax.contour(g["core"], levels=[0.5], origin="lower", extent=extent, colors="k", linewidths=0.6)
        ax.set_title(f"{icao} {title}")
        ax.set_xlabel("km east")
        fig.colorbar(im, ax=ax, shrink=0.8)
    diff = g["h"] - g["smooth"]
    im = axes[2].imshow(np.where(g["weight"] > 0, diff, np.nan), origin="lower", extent=extent, cmap="RdBu_r", vmin=-3, vmax=3)
    axes[2].contour(g["core"], levels=[0.5], origin="lower", extent=extent, colors="k", linewidths=0.6)
    axes[2].set_title(f"{icao} raw minus smooth (m), core RMS {g['core_rms']:.2f}")
    fig.colorbar(im, ax=axes[2], shrink=0.8)
    for ax in axes:
        ax.set_ylabel("km north")
    fig.tight_layout()
    fig.savefig(out / f"grid-{icao}.png")
    plt.close(fig)


def fmt(v: float | None, spec: str) -> str:
    return "n/a" if v is None else format(v, spec)


def main() -> None:
    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    cutoff = float(sys.argv[3]) if len(sys.argv) > 3 else 800.0
    out.mkdir(parents=True, exist_ok=True)
    sys.stdout.reconfigure(encoding="utf-8")
    airports = json.loads(Path("spikes/terrain-smoothing/airports.json").read_text(encoding="utf-8"))
    print(f"cutoff wavelength {cutoff:.0f} m\n")
    print("| Airport | Runway | Length m | Max level | Raw P2P m | Grade % | Smooth Δh m | Published Δh m | Noise RMS m | Noise P2P m | Dominant λ m | RMS <100 / 100-300 / 300-1000 / >1000 m | Max 50 m slope error % | Min radius m | Cross P2P runway / strip m |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    grid_rows = []
    after_rows: list[str] = []
    for icao in ICAO_ORDER:
        path = src / f"{icao}.json"
        if not path.exists():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        apt = airports[icao]
        after_path = src / f"{icao}-after.json"
        after_data = json.loads(after_path.read_text(encoding="utf-8")) if after_path.exists() else None
        for idx, rw in enumerate(data["runways"]):
            r = analyse_runway(rw, apt["geoidM"], cutoff)
            a = None
            if after_data is not None:
                a = analyse_runway(after_data["runways"][idx], apt["geoidM"], cutoff)
                after_rows.append(
                    f"| {icao} | {r['id']} | {r['noise_rms']:.2f} | {a['noise_rms']:.3f} | {r['max_slope_dev_pct']:.2f} | {a['max_slope_dev_pct']:.2f} | "
                    f"{r['max_raw_slope_pct']:.2f} | {a['max_raw_slope_pct']:.2f} | {r['grade_pct']:.2f} | {a['grade_pct']:.2f} | "
                    f"{a['h'][0] - r['smooth'][0]:+.2f} / {a['h'][-1] - r['smooth'][-1]:+.2f} | {a['min_radius_m']:.0f} |"
                )
            b = r["bands"]
            print(
                f"| {icao} | {r['id']} | {r['length']:.0f} | {data['maxLevel']} | {r['raw_p2p']:.1f} | {r['grade_pct']:.2f} | {r['end_to_end']:.1f} | "
                f"{fmt(r['pub_delta'], '.1f')} | {r['noise_rms']:.2f} | {r['noise_p2p']:.1f} | {r['wavelength']:.0f} | "
                f"{b['<100']:.2f} / {b['100-300']:.2f} / {b['300-1000']:.2f} / {b['>1000']:.2f} | {r['max_slope_dev_pct']:.1f} | "
                f"{r['min_radius_m']:.0f} | {r['cross_p2p_max']:.1f} / {r['cross_strip_p2p_max']:.1f} |"
            )
            plot_runway(icao, r, out, a)
        g = analyse_grid(apt, data, cutoff, 300.0)
        tin = data.get("tin") or {}
        verts = len(tin.get("verts", []))
        area = (apt["bbox"]["east"] - apt["bbox"]["west"]) * np.pi / 180 * R * np.cos(np.radians(apt["bbox"]["south"])) * (
            apt["bbox"]["north"] - apt["bbox"]["south"]
        ) * np.pi / 180 * R
        grid_rows.append(
            f"| {icao} | {g['core_rms']:.2f} | {g['core_p99']:.2f} | {g['core_p2p']:.1f} | {g['outliers_pct']:.1f} | {verts} | "
            f"{np.sqrt(area / max(verts, 1)):.0f} | {data['ms']} |"
        )
        plot_grid(icao, g, out)
    print("\n| Airport | Airfield residual RMS m | p99 m | P2P m | Outlier cells % | TIN vertices in paved bbox | Mean vertex spacing m | Sampling ms |")
    print("|---|---|---|---|---|---|---|---|")
    print("\n".join(grid_rows))
    if after_rows:
        print("\n| Airport | Runway | Noise RMS raw m | Noise RMS after m | Max 50 m slope error raw % | after % | Max 50 m slope raw % | after % | Grade raw % | after % | After minus raw 1D trend at le / he thresholds m | Min radius after m |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|")
        print("\n".join(after_rows))


if __name__ == "__main__":
    main()
