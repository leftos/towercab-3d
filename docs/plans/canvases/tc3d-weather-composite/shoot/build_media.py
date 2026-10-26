"""Build the tc3d-weather-composite mock's media from the raw captures.

Usage: uv run --no-project --with pillow python -I build_media.py <captures dir> <page dir>

<captures dir> holds what the shoot scripts wrote: ovc-h*.png, strip-*.png (TC3D-295),
png294/*.png (TC3D-294), frames/<job>/NNN.jpg and log224.json (TC3D-224).
Writes img/*.webp, clip/*.mp4 and chart/*.svg under <page dir>, and prints the bytes per folder.
Needs ffmpeg on PATH.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
IMG = OUT / "img"
CLIP = OUT / "clip"
CHART = OUT / "chart"
for d in (IMG, CLIP, CHART):
    d.mkdir(parents=True, exist_ok=True)

FONT = ImageFont.truetype("arial.ttf", 18)
FONT_S = ImageFont.truetype("arial.ttf", 13)

LANES_224 = {
    "a": "A · today (step)",
    "b": "B · extinction fade 10→8 SM + 6 s ease",
    "c": "C · visibility fade 10→8 SM + 6 s ease",
    "d": "D · time ease only (6 s)",
}
LANES_SHAPE = {
    "a": "A · today (step at 10 SM)",
    "b": "B · extinction fade 10→8 SM",
    "c": "C · visibility fade 10→8 SM",
}
LANES_EASE = {"2": "2 s smoothstep", "6": "6 s smoothstep", "15": "15 s smoothstep"}
COLORS = {"a": "#c0392b", "b": "#2e86c1", "c": "#27ae60", "d": "#8e44ad", "2": "#d35400", "6": "#2e86c1", "15": "#16a085"}


def webp(img: Image.Image, name: str, quality: int = 88) -> None:
    img.save(IMG / f"{name}.webp", "WEBP", quality=quality, method=6)


def stills_295() -> None:
    for h in (274, 180):
        webp(Image.open(SRC / f"ovc-h{h}.png").convert("RGB"), f"295-depth-h{h}")
    for vis in ("5.96", "10"):
        webp(Image.open(SRC / f"strip-{vis}.png").convert("RGB"), f"295-strip-{vis.replace('.', '')}")


def stills_294() -> None:
    for k in "abcdef":
        full = Image.open(SRC / "png294" / f"{k}.png").convert("RGB")
        webp(full.resize((1280, 642), Image.LANCZOS), f"294-{k}")
        crop = full.crop((400, 170, 1040, 330)).resize((1280, 320), Image.NEAREST)
        webp(crop, f"294-{k}-crop", quality=90)
    for k in "aef":
        up = Image.open(SRC / "png294" / f"up-{k}.png").convert("RGB")
        webp(up.resize((1280, 642), Image.LANCZOS), f"294-up-{k}")


def frame_paths(job: str) -> list[Path]:
    return sorted((SRC / "frames" / job).glob("*.jpg"))


def label(img: Image.Image, text: str, t: float | None) -> None:
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, img.width, 26), fill=(0, 0, 0))
    d.text((8, 4), text, fill=(255, 255, 255), font=FONT)
    if t is not None:
        d.text((img.width - 92, 4), f"t = {t:+.1f} s", fill=(255, 220, 120), font=FONT)


def grid_clip(row: str, jobs: dict[str, str], log: dict, fps: int, note: str) -> None:
    lists = {k: frame_paths(f"{row}-{k}") for k in jobs}
    n = min(len(v) for v in lists.values())
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(n):
            canvas = Image.new("RGB", (1280, 640), (20, 20, 20))
            for j, (k, title) in enumerate(jobs.items()):
                cell = Image.open(lists[k][i]).convert("RGB").resize((640, 320), Image.LANCZOS)
                label(cell, title, log[f"{row}-{k}"][i][0])
                canvas.paste(cell, ((j % 2) * 640, (j // 2) * 320))
            if len(jobs) == 3:
                d = ImageDraw.Draw(canvas)
                d.text((660, 340), note, fill=(230, 230, 230), font=FONT)
                vis = log[f"{row}-{next(iter(jobs))}"][i][1]
                d.text((660, 370), f"METAR visibility now: {vis:.2f} SM", fill=(255, 220, 120), font=FONT)
            canvas.save(Path(tmp) / f"{i:03d}.png")
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(Path(tmp) / "%03d.png"),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "slow", "-movflags", "+faststart",
            str(CLIP / f"224-{row}.mp4"),
        ]
        subprocess.run(cmd, check=True)


def strip(row: str, jobs: dict[str, str], log: dict, picks: int = 9) -> None:
    lists = {k: frame_paths(f"{row}-{k}") for k in jobs}
    n = min(len(v) for v in lists.values())
    idx = [round(i * (n - 1) / (picks - 1)) for i in range(picks)]
    tw, th, lw, hh = 128, 64, 128, 22
    out = Image.new("RGB", (lw + tw * picks, hh + th * len(jobs)), (255, 255, 255))
    d = ImageDraw.Draw(out)
    first = f"{row}-{next(iter(jobs))}"
    for c, i in enumerate(idx):
        d.text((lw + c * tw + 4, 4), f"t = {log[first][i][0]:+.1f} s", fill=(0, 0, 0), font=FONT_S)
    for r, (k, title) in enumerate(jobs.items()):
        d.text((4, hh + r * th + 24), title.split(" · ")[0] if " · " in title else title, fill=(0, 0, 0), font=FONT_S)
        for c, i in enumerate(idx):
            thumb = Image.open(lists[k][i]).convert("RGB").crop((600, 210, 1000, 410)).resize((tw, th), Image.LANCZOS)
            out.paste(thumb, (lw + c * tw, hh + r * th))
    webp(out, f"224-{row}-strip", quality=90)


def patch_lum(path: Path) -> float:
    img = Image.open(path).convert("RGB").crop((500, 300, 1100, 340))
    r, g, b = ImageStat.Stat(img).mean
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def chart(row: str, jobs: dict[str, str], log: dict, title: str) -> dict:
    series = {}
    for k in jobs:
        ts = [r[0] for r in log[f"{row}-{k}"]]
        lum = [patch_lum(p) for p in frame_paths(f"{row}-{k}")]
        series[k] = list(zip(ts, lum))
    allv = [v for s in series.values() for _, v in s]
    allt = [t for s in series.values() for t, _ in s]
    lo, hi = min(allv) - 2, max(allv) + 2
    t0, t1 = min(allt), max(allt)
    w, h, ml, mr, mt, mb = 640, 260, 48, 12, 28, 34

    def x(t: float) -> float:
        return ml + (t - t0) / (t1 - t0) * (w - ml - mr)

    def y(v: float) -> float:
        return mt + (hi - v) / (hi - lo) * (h - mt - mb)

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="Arial" font-size="11">',
        f'<rect width="{w}" height="{h}" fill="#ffffff"/>',
        f'<text x="{ml}" y="16" font-size="12" fill="#222">{title}</text>',
    ]
    step = 1 if t1 - t0 <= 12 else 2
    t = float(round(t0))
    while t <= t1:
        parts.append(f'<line x1="{x(t):.1f}" y1="{mt}" x2="{x(t):.1f}" y2="{h - mb}" stroke="#e6e6e6"/>')
        parts.append(f'<text x="{x(t):.1f}" y="{h - mb + 14}" text-anchor="middle" fill="#555">{t:g}</text>')
        t += step
    for v in range(int(lo) + 1, int(hi) + 1):
        if v % 5 == 0:
            parts.append(f'<line x1="{ml}" y1="{y(v):.1f}" x2="{w - mr}" y2="{y(v):.1f}" stroke="#eeeeee"/>')
            parts.append(f'<text x="{ml - 6}" y="{y(v) + 4:.1f}" text-anchor="end" fill="#555">{v}</text>')
    parts.append(f'<text x="{(ml + w - mr) / 2}" y="{h - 4}" text-anchor="middle" fill="#555">seconds since the METAR change</text>')
    for k, pts in series.items():
        path = " ".join(f"{x(tt):.1f},{y(vv):.1f}" for tt, vv in pts)
        parts.append(f'<polyline points="{path}" fill="none" stroke="{COLORS[k]}" stroke-width="2"/>')
    lx = ml + 8
    for k, label_text in jobs.items():
        parts.append(f'<rect x="{lx}" y="{mt + 4}" width="10" height="10" fill="{COLORS[k]}"/>')
        short = label_text.split(" · ")[0] if " · " in label_text else label_text
        parts.append(f'<text x="{lx + 14}" y="{mt + 13}" fill="#222">{short}</text>')
        lx += 70 if " · " in label_text else 110
    parts.append("</svg>")
    (CHART / f"224-{row}.svg").write_text("\n".join(parts) + "\n", encoding="utf-8", newline="\n")
    return {k: (round(pts[0][1], 1), round(pts[-1][1], 1)) for k, pts in series.items()}


def main() -> None:
    raw = json.loads((SRC / "log224.json").read_text(encoding="utf-8"))
    log = json.loads(raw) if isinstance(raw, str) else raw
    stills_295()
    stills_294()
    ranges = {}
    for row in ("r1", "r2", "r3"):
        grid_clip(row, LANES_224, log, 10, "")
        strip(row, LANES_224, log)
        ranges[row] = chart(row, LANES_224, log, "Mean luminance of the horizon patch (canvas rows 300-340)")
    grid_clip("r4", LANES_SHAPE, log, 10, "No time ease; visibility glides 10.5 → 8.5 SM over 8 s")
    strip("r4", LANES_SHAPE, log)
    ranges["r4"] = chart("r4", LANES_SHAPE, log, "Mean luminance of the horizon patch (canvas rows 300-340)")
    grid_clip("r5", LANES_EASE, log, 5, "Time ease only, 10 → 6 SM at t = 0")
    strip("r5", LANES_EASE, log)
    ranges["r5"] = chart("r5", LANES_EASE, log, "Mean luminance of the horizon patch (canvas rows 300-340)")
    print(json.dumps(ranges))
    total = 0
    for d in (IMG, CLIP, CHART):
        size = sum(p.stat().st_size for p in d.iterdir())
        total += size
        print(f"{d.name}: {size} bytes")
    print(f"total: {total} bytes")


if __name__ == "__main__":
    main()
