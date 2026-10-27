"""Builds the TC3D-369 R-hat drop mock page: drawn height of an unlearned B77L on takeoff under three options.

Usage: uv run --no-project python -I rhat_mock.py <out index.html>
"""

import sys

R = 13.6  # provisional resting height, ft (B77L)
DT = 0.02  # s


def raw_height(t: float) -> float:
    """Raw vNAS height (ft) of a constructed heavy takeoff: roll, rotation hump, liftoff at t=10, climb to ~30 ft/s."""
    if t < 7.0:
        return R
    if t < 10.0:
        return R + 2.9 * (t - 7.0) / 3.0
    dt = t - 10.0
    climb = 8.0 * dt + 2.2 * dt * dt if dt < 5 else 8.0 * 5 + 2.2 * 25 + 30.0 * (dt - 5)
    return R + 2.9 + climb


def option_a(t: float, state: dict) -> float:
    """Today's rule: R-hat dropped once raw > 25 ft, offset eased out over 250 ms."""
    h = raw_height(t)
    if state.get("drop_t") is None and h > 25.0:
        state["drop_t"] = t
    if state.get("drop_t") is None:
        return h - R
    k = min(1.0, (t - state["drop_t"]) / 0.25)
    return h - R * (1.0 - k)


def option_b(t: float, _state: dict) -> float:
    """Fade: the offset falls linearly from full at 25 ft raw to zero at 100 ft raw."""
    h = raw_height(t)
    k = min(1.0, max(0.0, (h - 25.0) / 75.0))
    return h - R * (1.0 - k)


def option_c(t: float, _state: dict) -> float:
    """Keep R-hat while airborne (as a learned R), dropped only on seek, a learned R, or above 1,000 ft."""
    return raw_height(t) - R


def series(fn) -> list[tuple[float, float]]:
    state: dict = {}
    pts = []
    t = 0.0
    while t <= 16.0:
        pts.append((t, fn(t, state)))
        t += DT
    return pts


W, H, PAD = 560, 300, 44
T0, T1, Y0, Y1 = 6.0, 14.0, -2.0, 90.0


def sx(t: float) -> float:
    return PAD + (t - T0) / (T1 - T0) * (W - 2 * PAD)


def sy(y: float) -> float:
    return H - PAD - (y - Y0) / (Y1 - Y0) * (H - 2 * PAD)


def path(pts) -> str:
    shown = [(t, y) for t, y in pts if T0 <= t <= T1]
    return " ".join(f"{'M' if i == 0 else 'L'}{sx(t):.1f},{sy(y):.1f}" for i, (t, y) in enumerate(shown))


def chart(pts) -> str:
    truth = [(t, raw_height(t) - R) for t, _ in pts]
    grid = "".join(
        f'<line x1="{PAD}" x2="{W - PAD}" y1="{sy(y):.1f}" y2="{sy(y):.1f}" class="g"/>'
        f'<text x="{PAD - 6}" y="{sy(y) + 4:.1f}" class="ax" text-anchor="end">{y}</text>'
        for y in (0, 25, 50, 75)
    )
    ticks = "".join(
        f'<text x="{sx(t):.1f}" y="{H - PAD + 16}" class="ax" text-anchor="middle">{t:.0f}</text>' for t in range(6, 15, 2)
    )
    lift = f'<line x1="{sx(10):.1f}" x2="{sx(10):.1f}" y1="{PAD}" y2="{H - PAD}" class="lo"/>'
    lift += f'<text x="{sx(10) + 4:.1f}" y="{PAD + 12}" class="ax">liftoff</text>'
    return (
        f'<svg viewBox="0 0 {W} {H}" role="img">{grid}{ticks}{lift}'
        f'<path d="{path(truth)}" class="truth"/><path d="{path(pts)}" class="drawn"/>'
        f'<text x="{W / 2}" y="{H - 6}" class="ax" text-anchor="middle">seconds</text>'
        f'<text x="12" y="{H / 2}" class="ax" transform="rotate(-90 12 {H / 2})" text-anchor="middle">wheel height drawn, ft</text></svg>'
    )


LANES = [
    (
        "A. Drop at 25 ft (as built)",
        option_a,
        "The provisional height leaves the drawing over 0.25 s once the raw height passes 25 ft: the aircraft jumps up "
        "13.6 ft (4.1 m) at about 11 ft above the runway, just after liftoff, in full view of the tower. From then on it is "
        "drawn 13.6 ft above its true height, as every unlearned aircraft is drawn in the air today.",
    ),
    (
        "B. Fade out from 25 to 100 ft (recommended)",
        option_b,
        "The offset shrinks in step with the climb, so the jump is spread over the first 75 ft of climb: the drawn climb is "
        "a little steeper for about 2 s and never jumps. Above 100 ft it is drawn 13.6 ft above its true height, as in A. A "
        "wrong provisional height (one learned on a level pass) is gone by 100 ft, before the next approach.",
    ),
    (
        "C. Keep it while airborne",
        option_c,
        "The aircraft is drawn at its true height all the way up, as one with a learned resting height is. Worst case: a "
        "provisional height entered wrongly (a level pass under 16 ft) stays, and the aircraft is drawn up to 3.6 m low "
        "for the rest of the flight and enters contact early on its next approach.",
    ),
]


def main() -> None:
    lanes = "".join(
        f'<section class="lane"><h2>{title}</h2>{chart(series(fn))}<p>{note}</p></section>' for title, fn, note in LANES
    )
    html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Provisional height drop</title>
<style>
:root {{ --bg:#f7f6f2; --fg:#1d1d1b; --muted:#6b6a64; --line:#d9d6cc; --truth:#8a8a8a; --drawn:#c2410c; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#16161a; --fg:#ecebe6; --muted:#a3a29c; --line:#34343a; --truth:#8f8f96; --drawn:#fb923c; }} }}
:root[data-theme="dark"] {{ --bg:#16161a; --fg:#ecebe6; --muted:#a3a29c; --line:#34343a; --truth:#8f8f96; --drawn:#fb923c; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }}
main {{ max-width:1800px; margin:0 auto; padding:24px 16px; }}
h1 {{ font-size:20px; margin:0 0 6px; }} .lede {{ color:var(--muted); max-width:900px; margin:0 0 20px; }}
.lanes {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; }}
.lane h2 {{ font-size:15px; margin:0 0 8px; }} .lane p {{ color:var(--muted); font-size:14px; margin:8px 0 0; }}
svg {{ width:100%; height:auto; display:block; }}
.g {{ stroke:var(--line); }} .ax {{ fill:var(--muted); font-size:11px; }} .lo {{ stroke:var(--muted); stroke-dasharray:3 3; }}
.truth {{ fill:none; stroke:var(--truth); stroke-width:1.5; stroke-dasharray:5 4; }} .drawn {{ fill:none; stroke:var(--drawn); stroke-width:2.5; }}
.key span {{ margin-right:16px; }} .key i {{ display:inline-block; width:22px; height:0; vertical-align:middle; margin-right:6px; border-top:3px solid var(--drawn); }}
.key i.t {{ border-top:2px dashed var(--truth); }}
</style></head><body><main>
<h1>TC3D-369: when does an unlearned aircraft's provisional resting height leave the drawing?</h1>
<p class="lede">A B77L with no learned resting height lands, gets a provisional height of 13.6 ft from its settled samples, and is drawn that much lower. On takeoff (constructed: roll at 13.6 ft raw, a 2.9 ft rotation hump, liftoff at 10 s, a heavy's climb to about 30 ft/s) the offset has to go at some point. Each lane plots the wheel height drawn against the true wheel height.</p>
<p class="key"><span><i></i>drawn</span><span><i class="t"></i>true</span></p>
<div class="lanes">{lanes}</div>
<p class="lede">Rebuild: <code>uv run --no-project python -I rhat_mock.py index.html</code> (the script is kept beside this page).</p>
</main></body></html>
"""
    with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
        f.write(html)


if __name__ == "__main__":
    main()
