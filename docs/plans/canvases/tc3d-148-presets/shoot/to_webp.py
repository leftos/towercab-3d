"""Convert the TC3D-148 lane captures to WebP and cut 2x detail crops."""

import sys
from pathlib import Path

from PIL import Image

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)

# Detail crops (x, y, w, h) in capture pixels, shown at 2x nearest-neighbour
CROPS = {
    "bkn10": (420, 400, 520, 160),
    "horizon-bkn10": (0, 300, 520, 160),
    "few10": (420, 420, 520, 140),
}

total = 0
for png in sorted(src.glob("*.png")):
    img = Image.open(png).convert("RGB")
    out = dst / f"{png.stem}.webp"
    img.save(out, "WEBP", quality=90, method=6)
    total += out.stat().st_size
    row = png.stem.rsplit("-", 1)[0]
    if row in CROPS:
        x, y, w, h = CROPS[row]
        crop = img.crop((x, y, x + w, y + h)).resize((w * 2, h * 2), Image.NEAREST)
        cout = dst / f"{png.stem}-crop.webp"
        crop.save(cout, "WEBP", quality=92, method=6)
        total += cout.stat().st_size
print(f"total bytes: {total}")
