"""Build the Gloss wordmark and lockups by outlining a font (no live text in the output).

Font: DejaVu Sans Bold (Bitstream Vera / DejaVu licence - permissive, allows embedding
and modification). The wordmark is exported as outlines so it is a real, self-contained
vector; swap in a commissioned typeface later if desired.
"""
import os
import math
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(
    os.environ["LOCALAPPDATA"], "Programs", "Python", "Python314", "Lib",
    "site-packages", "matplotlib", "mpl-data", "fonts", "ttf", "DejaVuSans-Bold.ttf",
)
TEXT = "Gloss"
INK = "#16181D"
TRACK = -0.02  # tighten tracking slightly

# Symbol geometry (matches gloss-symbol.svg)
SYM = {
    "x0": 34, "y0": 53, "x1": 222, "y1": 203, "bar_cy": 180,
    "paths": [
        "M57 157 H163 A23 23 0 0 1 186 180 A23 23 0 0 1 163 203 H57 "
        "A23 23 0 0 1 34 180 A23 23 0 0 1 57 157 Z",
        "M178 53 Q192 83 222 97 Q192 111 178 141 Q164 111 134 97 Q164 83 178 53 Z",
    ],
}
SYM_W = SYM["x1"] - SYM["x0"]
SYM_H = SYM["y1"] - SYM["y0"]

font = TTFont(FONT)
upm = font["head"].unitsPerEm
gs = font.getGlyphSet()
cmap = font.getBestCmap()
hmtx = font["hmtx"]

placements = []
x = 0.0
for ch in TEXT:
    gname = cmap[ord(ch)]
    placements.append((gname, x))
    x += hmtx[gname][0] + TRACK * upm

bp = BoundsPen(gs)
for gname, gx in placements:
    gs[gname].draw(TransformPen(bp, Transform(1, 0, 0, 1, gx, 0)))
wx0, wy0, wx1, wy1 = bp.bounds
WM_W, WM_H = wx1 - wx0, wy1 - wy0

def fmt(v):
    return f"{v:.1f}"


wm_paths = []
for gname, gx in placements:
    pen = SVGPathPen(gs, ntos=fmt)
    gs[gname].draw(pen)
    d = pen.getCommands()
    if d:
        wm_paths.append(f'<path transform="translate({gx:.1f} 0)" d="{d}"/>')
WM_BODY = "".join(wm_paths)


def svg(w, h, body, label="Gloss"):
    w, h = math.ceil(w), math.ceil(h)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
        f'width="{w}" height="{h}" role="img" aria-label="{label}">\n'
        f'  <title>{label}</title>\n{body}\n</svg>\n'
    )


def num(v, nd=3):
    s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0", "-") else "0"


def symbol_group(tx, ty, scale=1.0):
    inner = "".join(f'<path d="{d}"/>' for d in SYM["paths"])
    return (
        f'<g transform="translate({num(tx)} {num(ty)}) scale({num(scale)}) '
        f'translate({num(-SYM["x0"])} {num(-SYM["y0"])})" fill="{INK}">{inner}</g>'
    )


def wordmark_group(px, py, s):
    return (
        f'<g transform="translate({num(px)} {num(py)}) scale({num(s)} {num(-s)}) '
        f'translate({num(-wx0)} 0)" fill="{INK}">{WM_BODY}</g>'
    )


# --- wordmark alone ---
os.makedirs(HERE, exist_ok=True)
with open(os.path.join(HERE, "gloss-wordmark.svg"), "w", encoding="utf-8") as f:
    f.write(svg(WM_W, WM_H,
                f'  <g transform="translate({num(-wx0)} {num(wy1)}) scale(1 -1)" fill="{INK}">{WM_BODY}</g>'))

# --- horizontal lockup ---
target_h = SYM_H * 0.46
s = target_h / WM_H
wm_w = WM_W * s
gap = SYM_H * 0.16
pad = SYM_H * 0.12
h_w = SYM_W + gap + wm_w
h_h = SYM_H
py = pad + (SYM["bar_cy"] - SYM["y0"]) + s * (wy1 + wy0) / 2
body = (
    f'  {symbol_group(pad, pad)}\n'
    f'  {wordmark_group(pad + SYM_W + gap, py, s)}'
)
with open(os.path.join(HERE, "gloss-horizontal.svg"), "w", encoding="utf-8") as f:
    f.write(svg(h_w + pad * 2, h_h + pad * 2, body))

# --- stacked lockup ---
s_w = max(SYM_W, wm_w)
gap2 = SYM_H * 0.14
st_h = SYM_H + gap2 + target_h
sx = (s_w - SYM_W) / 2
wmx = (s_w - wm_w) / 2
py2 = SYM_H + gap2 + s * wy1
body = (
    f'  {symbol_group(pad + sx, pad)}\n'
    f'  {wordmark_group(pad + wmx, pad + py2, s)}'
)
with open(os.path.join(HERE, "gloss-stacked.svg"), "w", encoding="utf-8") as f:
    f.write(svg(s_w + pad * 2, st_h + pad * 2, body))

print("wordmark", round(WM_W), "x", round(WM_H))
print("wrote gloss-wordmark.svg, gloss-horizontal.svg, gloss-stacked.svg")
