# Gloss

Right-click any word on a page to see what it means — in a small popup, without
leaving the page.

Works in **Chrome / Edge** and **Firefox** from a single Manifest V3 codebase.

## How it works

Highlight a word → right-click → **What is "…"?** → a bubble appears near the
selection with the meaning and its source.

Lookups use a **3-tier fallback cascade**, tried in order, stopping at the first
hit:

| Tier | Source | Best at |
| ---- | ------ | ------- |
| 1 | [Datamuse](https://www.datamuse.com/api/) | Word definitions (cleaned Wiktionary data) with part of speech |
| 2 | [dictionaryapi.dev](https://dictionaryapi.dev) | Fallback definitions, phonetics, audio |
| 3 | [Wikipedia](https://en.wikipedia.org) | Concepts, jargon and entities (e.g. `CNAME`) |

Datamuse is the primary source because it's reliable and free with no key;
`dictionaryapi.dev` is kept as a fallback but is flaky (frequent `522`s). The raw
Wiktionary extract API is deliberately **not** used — its "intro" section is empty
and its output is full of section headers and non-English senses; Datamuse serves
the same data, already clean.

If all three miss, the bubble shows a short "no definition found" message and a
**Search the web** link. Every result is cached locally (hits *and* misses), so
repeated lookups are instant. No API keys — all sources are free.

### Two things matching alone can't solve

- **Case.** Uppercase selections retry lowercased, so `NEWS` resolves to `news`
  instead of a Wikipedia disambiguation page.
- **Ambiguous senses.** `Chromium` is both a chemical element and a web browser.
  Gloss reads the **sentence around your selection** and scores Wikipedia's
  candidate senses against it, picking the one that fits — then says it did and
  lists the alternatives. A candidate only counts if its title shares a word with
  your selection, so it can't resolve to an article merely *mentioned* on the page.
  This is a free keyword-overlap heuristic, **not AI**.

Notable details:

- Any non-200 response or thrown error is treated as a *miss* and the cascade
  falls through to the next tier.
- Each request has a 3-second timeout so a slow API can't stall the bubble.
- All network requests run in the background worker, never in the page.
- Any successful lookup is enriched **after the bubble appears** with a
  pronunciation — and audio where a recording exists — shown as a speaker icon
  beside the word. Sources: `dictionaryapi.dev`, falling back to Wiktionary's
  audio files (`.mp3`/`.ogg` on Wikimedia Commons).
- Audio plays via the **extension's own context** if the page blocks the direct
  request (e.g. Brave Shields or a strict `media-src` CSP): the clip is fetched
  and played as a local blob.

## Optional on-device AI (Chrome & Edge)

A fourth, **opt-in** tier uses the standardized W3C **Prompt API** — the browser's
own built-in model (Gemini Nano in Chrome, Phi-4-mini in Edge). Free, no API key,
and nothing leaves the device.

- **Explicit:** right-click → **Explain "…" with on-device AI**.
- **Automatic:** enable it in the extension's settings (options page) to use it as
  the final tier whenever the free cascade finds nothing.

Because it targets the W3C API rather than a browser brand, it works in **any
browser that implements `LanguageModel`** — currently Chrome 138+ and Edge (Canary/
Dev with the Prompt API flag enabled). It does **not** work in Firefox, Brave, or
Opera: their branded assistants (Leo, Copilot, Aria) are UI features with no public
extension API, and scraping them would be fragile and against their terms.

Hardware: a one-time multi-GB model download, a decent GPU (or enough RAM), and
~20 GB free disk.

### Discoverability & opt-in

AI is a **bonus tier, never a dependency** — Gloss is fully useful without it.

- **Default off.** Nothing is ever downloaded unless the user asks.
- The **options page is the control panel**: it reports the real model state
  (`unsupported` / `unavailable` / `downloadable` / `downloading` / `available`)
  and offers a single **Download** button, with plain copy about size, privacy and
  the one-time cost.
- The **AI context-menu item only exists while the model is `available`**, so users
  who never download it never see a dead option. The background learns availability
  from the options page and from a silent probe during normal lookups.
- A **one-time, dismissible hint** appears in the bubble the first time a lookup
  finds nothing *and* the model is downloadable or ready — the exact moment it would
  help. It never appears again, and never appears to users who turned AI off.

## Files

```
manifest.json   MV3 manifest (both background keys -> Chrome + Firefox)
background.js   Context menu, lookup cascade, cache, bubble renderer
options.html    AI control panel (availability, download, opt-in)
options.js      Settings persistence + model download/test
icons/          Extension icon set (16/32/48/128), wired into the manifest
brand/          Logo, lockups and the full brand kit (see brand/GUIDELINES.md)
```

## Branding

The mark is **Glint** — a highlighter stroke that lights up. Full kit, palette,
clear space and approved variants are documented in
[`brand/GUIDELINES.md`](brand/GUIDELINES.md); source SVGs and exports live in
[`brand/`](brand/).

## Install (development)

### Chrome / Edge

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this folder.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → select `manifest.json`.

## Roadmap

- Options page (choose tier order, languages, cache TTL).
- Tests.

## Conventions

Project instructions live in `.agents/rules/`. The `install-anti-slop` skill is
vendored under `.agents/skills/`.
