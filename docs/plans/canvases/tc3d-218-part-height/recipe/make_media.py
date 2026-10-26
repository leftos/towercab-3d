"""Copy the lane stills next to the page and cut the zoomed crops of the areas that change.

Usage: uv run --no-project --with pillow python -I make_media.py <shots dir> <page dir>
"""

import shutil
import sys
from pathlib import Path

from PIL import Image

VIEWS = ("ksfo-intl", "ksfo-t2", "ksfo-aluxor", "koak")
LANES = ("A", "B", "C")
# Crop box (left, top, right, bottom) in canvas pixels and the scale it is shown at.
ZOOMS = {
    "ksfo-t2": ((240, 40, 1440, 500), 1),
    "ksfo-aluxor": ((380, 230, 780, 480), 2),
}


def main() -> None:
    shots, out = Path(sys.argv[1]), Path(sys.argv[2])
    for view in VIEWS:
        for lane in LANES:
            name = f"{view}-{lane}.png"
            shutil.copyfile(shots / name, out / name)
    for view, (box, scale) in ZOOMS.items():
        for lane in LANES:
            crop = Image.open(shots / f"{view}-{lane}.png").convert("RGB").crop(box)
            if scale != 1:
                crop = crop.resize((crop.width * scale, crop.height * scale), Image.Resampling.LANCZOS)
            crop.save(out / f"{view}-zoom-{lane}.png", optimize=True)


if __name__ == "__main__":
    main()
