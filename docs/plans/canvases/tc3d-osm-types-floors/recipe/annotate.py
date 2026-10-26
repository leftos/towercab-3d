"""Draws the aerodrome outline, the radius circle and numbered markers on a shape-fallback map.

python annotate.py <name> [--radius]
Reads out/<name>.png, out/<name>.json (features), out/<name>-overlay.json; writes
out/<name>-annotated.png and out/<name>-labels.json (one row per numbered marker).
"""

import json
import sys

from PIL import Image, ImageDraw, ImageFont

name = sys.argv[1]
show_circle = "--radius" in sys.argv
img = Image.open(f"out/{name}.png").convert("RGB")
feats = json.load(open(f"out/{name}.json", encoding="utf-8"))
overlay = json.load(open(f"out/{name}-overlay.json", encoding="utf-8"))
draw = ImageDraw.Draw(img)
font = ImageFont.truetype("arialbd.ttf", 13)


def poly(points, colour, width):
    pts = [(p["x"], p["y"]) for p in points if p is not None]
    if len(pts) > 1:
        draw.line(pts, fill=colour, width=width)


for ring in overlay["rings"]:
    poly(ring, (255, 220, 0), 2)
if show_circle:
    poly(overlay["circle"], (255, 255, 255), 2)

seen = {}
for f in feats:
    if f["category"] in (3, 4) and f["name"] and f["screen"]:
        seen.setdefault(f["elementId"], f)
rows = []
visible = [f for f in seen.values() if 0 <= f["screen"]["x"] < img.width and 0 <= f["screen"]["y"] < img.height]
for n, f in enumerate(sorted(visible, key=lambda f: -f["area"]), start=1):
    x, y = f["screen"]["x"], f["screen"]["y"]
    draw.ellipse((x - 9, y - 9, x + 9, y + 9), fill=(0, 0, 0), outline=(255, 255, 255), width=2)
    draw.text((x, y), str(n), fill=(255, 255, 255), font=font, anchor="mm")
    rows.append(
        {
            "n": n,
            "name": f["name"],
            "type": "hangar" if f["category"] == 3 else "4-8 levels",
            "area": round(f["area"]),
            "height": round(f["top"], 1),
        }
    )
img.save(f"out/{name}-annotated.png")
json.dump(rows, open(f"out/{name}-labels.json", "w", encoding="utf-8", newline="\n"), indent=1, ensure_ascii=False)
counts = {3: set(), 4: set()}
for f in feats:
    if f["category"] in counts:
        counts[f["category"]].add(f["elementId"])
print(name, "hangar", len(counts[3]), "mid", len(counts[4]), "labelled", len(rows))
