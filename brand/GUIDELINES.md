# Gloss — brand & logo guidelines

## The mark

**Glint** — a highlighter stroke that lights up. It depicts exactly what the
extension does: you select a word, it gets highlighted, and the meaning lights up.
It also carries the name's second meaning — *gloss* (a note explaining a word) and
*gloss* (shine).

The mark is built from two primitives only: a rounded **highlight bar** and a
four‑point **glint**. That economy is what keeps it working at 16 px.

## Files

| File | Use |
| --- | --- |
| `gloss-symbol.svg` | Primary symbol, ink on light |
| `gloss-symbol-small.svg` | Simplified cut for favicons / app icons (thicker bar, larger glint) |
| `gloss-symbol-brand.svg` | Colour symbol (ink bar + amber glint) |
| `gloss-symbol-brand-small.svg` | Colour small cut |
| `gloss-icon.svg` | Tight‑viewBox master for raster icon export |
| `gloss-wordmark.svg` | "Gloss" wordmark, outlined |
| `gloss-horizontal.svg` | Horizontal lockup (symbol + wordmark) |
| `gloss-stacked.svg` | Stacked lockup |
| `dist/` | One‑colour, reversed, square, favicon, app‑icon, web icon set, `site.webmanifest`, `head-snippet.html` |
| `explore/` | Round‑1 exploration (kept for reference, not for use) |

Extension icons live at the repo root in `icons/` and are wired into `manifest.json`.

## Colour

| Name | HEX | RGB | Use |
| --- | --- | --- | --- |
| Ink | `#16181D` | 22, 24, 29 | The highlight bar, wordmark, body text |
| Gloss Amber | `#F5A623` | 245, 166, 35 | The glint, the app‑icon tile, accents |
| Paper | `#FFFFFF` | 255, 255, 255 | Backgrounds |

One accent only. Amber is the brand colour because it is the colour of a
highlighter — and because blue is the default in this category, it helps Gloss
stand apart. The one‑colour and reversed versions must still work; check them
before any new use.

## Clear space & minimum sizes

- **Clear space:** keep at least **half the mark's height** free on all sides.
- **Symbol:** minimum 16 px (digital) / 6 mm (print). Below 24 px use the small cut.
- **Horizontal lockup:** minimum 96 px wide.
- **Stacked lockup:** minimum 64 px wide.
- Do not redraw or re‑proportion the bar and glint.

## Approved backgrounds

The **tile** version (amber tile, ink mark) is the default for app icons and works
on any background — use it wherever the surface may be light *or* dark (browser
toolbars, favicons).

The **transparent symbol** is for surfaces you control: on white/paper use the ink
or colour version; on dark use the white version. Never place the ink symbol on a
dark background — the bar disappears.

## Misuse

- Don't recolour outside the palette, add gradients, shadows, bevels or outlines.
- Don't rotate, skew, stretch or condense the mark or the wordmark.
- Don't place the glint anywhere but above the right end of the bar.
- Don't put the ink symbol on dark, or the white symbol on light.
- Don't rebuild the lockups with a different font or spacing.

## Typography

The wordmark is **outlined** from DejaVu Sans Bold (Bitstream Vera / DejaVu
licence — permissive, allows embedding and modification), so the files are
self‑contained and carry no font‑licensing obligation. It is a placeholder in
spirit: for a paid identity, commission or license a display face and re‑outline
`gloss-wordmark.svg`. UI copy uses the platform UI stack; no brand webfont is
required.

## Notes & open items

- Trademark clearance has **not** been checked. Run a professional search
  (trademark databases + reverse image search) before commercial use.
- The glint is a common form in current tech branding; the distinctive part is the
  pairing with the highlight bar. If it ever reads as an "AI sparkle", swap the
  glint for the lens cut in `explore/`.
