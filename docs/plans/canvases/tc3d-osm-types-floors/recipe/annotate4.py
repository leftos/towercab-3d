"""Labels the KSFO terminal-complex still: out/m4-ksfo.png -> out/m4-ksfo-annotated.png."""

import json

from PIL import Image, ImageDraw, ImageFont

LABELS = {
    "15730419": "International Terminal Main Hall: 12 parts of relation 15730419, typed TERMINAL from outline 14273628",
    "2920181": "Domestic Garage: relation 2920181, amenity=parking, already GARAGE",
}
img = Image.open("out/m4-ksfo.png").convert("RGB")
feats = json.load(open("out/m4-ksfo.json", encoding="utf-8"))
draw = ImageDraw.Draw(img)
font = ImageFont.truetype("arialbd.ttf", 15)
points = {}
for f in feats:
    s = f["screen"]
    if f["elementId"] in LABELS and s and 0 <= s["x"] < img.width and 0 <= s["y"] < img.height:
        points.setdefault(f["elementId"], []).append((s["x"], s["y"]))
for element, text in LABELS.items():
    pts = points.get(element)
    if not pts:
        print("not on screen", element)
        continue
    x = sum(p[0] for p in pts) / len(pts)
    y = min(p[1] for p in pts) - 30
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x0 = max(8, min(img.width - w - 18, x - w / 2))
    y0 = max(8, y - h)
    draw.rectangle((x0 - 6, y0 - 5, x0 + w + 6, y0 + h + 7), fill=(0, 0, 0))
    draw.text((x0, y0), text, fill=(255, 255, 255), font=font)
    draw.line((x, y0 + h + 7, x, y + 30), fill=(255, 255, 0), width=2)
    print(element, round(x), round(y))
img.save("out/m4-ksfo-annotated.png")
