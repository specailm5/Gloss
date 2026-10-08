---
trigger: always_on
---

# Rule: Gloss — project instructions

**Gloss** is a cross-browser extension (Chrome/Edge + Firefox) that lets the user
highlight a word, right-click, and see what it means in a popup.

## Core behavior

- Context menu item: `What is "%s"?` (contexts: `selection`).
- On click, look up the selected text with a **3-tier fallback cascade** — try each
  in order and **stop at the first hit**:
  1. **Datamuse** (`api.datamuse.com`) — cleaned Wiktionary definitions with part
     of speech. Reliable, free, no key.
  2. **dictionaryapi.dev** — fallback dictionary with phonetics and audio.
  3. **Wikipedia REST summary** — concepts, jargon, entities
     (e.g. `CNAME` → "CNAME record", a DNS record type).
- Do **not** use Wiktionary's raw extract API: its "intro" section is empty and its
  plain-text output is full of section headers and non-English senses. Datamuse
  serves the same Wiktionary data, already cleaned.
- **Capitalise the first letter for display** (e.g. `only` → `Only`), but leave
  acronyms/mixed case untouched (`CNAME` stays `CNAME`). This is display-only.
- Try the selection **as typed, then lowercased** (case-folded retry) — otherwise
  `NEWS` misses Wiktionary's `news` and lands on a Wikipedia disambiguation page.
- **Disambiguate using the selection's sentence** (never the page title or the
  whole page) and score Wikipedia's candidate senses against it, preferring the
  matching sense (e.g. `Chromium` on a browser page → "Chromium (web browser)").
  Free keyword-overlap heuristic — **no AI**.
- A candidate only counts if its **title shares a word with the query**, so the
  extension can't "disambiguate" to an article merely mentioned on the page
  (searching `MV3` on a uBlock Origin page must not resolve to "UBlock Origin").
- Override only when the chosen article is a **genuinely different term** and the
  overlap score is strong; otherwise keep the cascade's answer.
- If **all three miss**, the popup shows a short "no definition found" message plus
  a **"Search the web"** link — never a dead end.
- Optional **on-device AI tier**: the context menu item
  `Explain "…" with on-device AI` runs the browser's built-in model via the
  standardized W3C Prompt API (`LanguageModel`), and an options toggle makes it the
  automatic final tier when the cascade misses. Free, no key, nothing leaves the
  device. Works in any browser implementing the API (Chrome, Edge); **not** Brave,
  Firefox or Opera — their assistants (Leo/Copilot/Aria) expose no extension API.
- AI is **optional and off by default**: never download anything unless the user
  asks. The options page is the control panel (reports real availability, offers the
  one-click download). The AI context-menu item is only created while the model is
  `available`, so users who decline never see a dead option.
- A **one-time, dismissible hint** shows in the bubble on the first lookup that finds
  nothing (only when the model is downloadable/ready and AI is off), then never again.
- Always show the **source** (name + link) in the popup.

## Technical rules

- Manifest V3. Permissions: `contextMenus` + `activeTab` (host permissions as needed).
- **All network fetches run in the background service worker**, never the content script.
- Treat **any** non-200 response or thrown error as a *miss* and fall through to the next tier.
- Give each source a short timeout (~3s) via `AbortController` so a hanging API can't stall the popup.
- Capture page context with `scripting.executeScript` (read-only); the bubble is rendered the same way.
- **Cache every result** (hit *or* miss), keyed by word, so repeat lookups are instant.
  Base results are cached word-only; context-based overrides are recomputed per page.
- Cache keys are **versioned** (`CACHE_VERSION`) so a code fix invalidates stale
  entries. Misses expire far sooner (6h) than hits (7d), so a temporary API outage
  never sticks.
- Clicking a suggestion fetches **that Wikipedia article directly** (`preferWiki`),
  not a full re-cascade, so valid suggestions never dead-end.
- **Show the bubble immediately**, then stream in pronunciation/audio afterwards —
  never block the popup on the audio lookup.
- Pronunciation sources, in order: **dictionaryapi.dev** (short 1.5s timeout) then
  **Wiktionary** audio files on Wikimedia Commons (parse API, prefer English `.mp3`).
  Both cached; misses are *not* cached because the dictionary API is flaky.
- The play control is a **speaker icon beside the word**, not a text button.
- Play audio **from the extension context**: try the direct URL first, and if the
  page blocks it (Brave Shields, strict CSP), `fetch` it from the content script
  and play a local blob URL. Keep a reference so the element isn't collected.
- Send a descriptive `User-Agent` to Wikimedia and stay a polite API citizen.
- **No API keys** — every source is free.
