"""Count changed pixels between two stills and print the change's bounding box."""

import sys

from PIL import Image, ImageChops

a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
print(sys.argv[1], sys.argv[2], "changed px", d.histogram()[255], "bbox", d.getbbox())
if len(sys.argv) > 3:
    d.save(sys.argv[3])
