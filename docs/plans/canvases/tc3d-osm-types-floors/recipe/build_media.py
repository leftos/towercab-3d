"""Crops the rendered stills and writes them as WebP beside the canvas page.

python build_media.py <canvas folder>
"""

import os
import sys

from PIL import Image

dest = sys.argv[1]
os.makedirs(dest, exist_ok=True)

CROPS = {
    "m1-koak": ((0, 300, 1276, 620), ["today", "base", "roof"]),
    "m1-ksfo": ((500, 200, 1276, 620), ["today", "base", "roof"]),
    "m1-raised": ((0, 180, 640, 600), ["today", "own", "ground"]),
}
jobs = []
for prefix, (box, lanes) in CROPS.items():
    jobs += [(f"out/{prefix}-{lane}.png", f"{prefix}-{lane}.webp", box) for lane in lanes]
jobs += [(f"out/m2-{lane}.png", f"m2-street-{lane}.webp", (150, 100, 750, 450)) for lane in ["today", "hash2"]]
jobs += [(f"out/m2-term-{lane}.png", f"m2-term-{lane}.webp", (150, 150, 1276, 560)) for lane in ["today", "storey2"]]
for icao in ["KSFO", "KOAK"]:
    for lane in ["A-poly", "B-poly", "C-poly", "B-radius"]:
        jobs.append((f"out/m3-{icao}-{lane}-annotated.png", f"m3-{icao.lower()}-{lane.lower()}.webp", None))
jobs.append(("out/m4-ksfo-annotated.png", "m4-ksfo.webp", None))

total = 0
for src, name, box in jobs:
    im = Image.open(src).convert("RGB")
    if box:
        im = im.crop(box)
    if im.width > 1280:
        im = im.resize((1280, round(im.height * 1280 / im.width)))
    path = os.path.join(dest, name)
    im.save(path, "WEBP", quality=82, method=6)
    total += os.path.getsize(path)
    print(name, im.size, os.path.getsize(path))
print("total bytes", total)
