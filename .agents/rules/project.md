---
trigger: always_on
---

# Rule: Gloss — project instructions

**Gloss** is a cross-browser extension (Chrome/Edge + Firefox) that lets the user
highlight a word, right-click, and see what it means in a popup.

**`README.md` and all bubble/UI copy are user-facing only.** Architecture, cascades,
heuristics, caching, timeouts, permissions and test commands belong in this file, not
in the README or the popup. UI errors state what happened and what to do next — never
a raw exception, HTTP status or internal reason.

Firefox needs **128+** for `optional_host_permissions`; Chrome/Edge need 102+.

## Core behavior

- Context menu item: `What is "%s"?` (contexts: `selection`).
- On click, look up the selected text with a **4-tier fallback cascade** — try each
  in order and **stop at the first hit**:
  1. **Datamuse** (`api.datamuse.com`) — cleaned Wiktionary definitions with part
     of speech. Reliable, free, no key (key required from 2027-02-01).
  2. **Wiktionary REST definition** (`/api/rest_v1/page/definition/{term}`) —
     structured definitions Datamuse lacks (multiword phrases, omitted senses).
     Filter to `language === "English"`, strip HTML, cap at 4 senses.
  3. **dictionaryapi.dev** — fallback dictionary with phonetics and audio.
  4. **Wikipedia REST summary** — concepts, jargon, entities
     (e.g. `CNAME` → "CNAME record", a DNS record type).
- Do **not** use Wiktionary's raw wikitext extract API: its "intro" section is empty
  and its plain-text output is full of section headers and non-English senses. The
  parsed **REST definition** endpoint is allowed and is tier 2.
- **Capitalise the first letter for display** (e.g. `only` → `Only`), but leave
  acronyms/mixed case untouched (`CNAME` stays `CNAME`). This is display-only.
- Try the selection **as typed, then lowercased** (case-folded retry) — otherwise
  `NEWS` misses Wiktionary's `news` and lands on a Wikipedia disambiguation page.
- **Disambiguate using the selection's sentence** (never the page title or the
  whole page). Reorder the dictionary's own senses by sentence overlap first, then
  score Wikipedia's candidate senses against it, preferring the matching sense
  (e.g. `Chromium` on a browser page → "Chromium (web browser)"). Free
  keyword-overlap heuristic — no model, no download.
- A candidate only counts if its **title shares a word with the query**, so the
  extension can't "disambiguate" to an article merely mentioned on the page
  (searching `MV3` on a uBlock Origin page must not resolve to "UBlock Origin").
- Override only when the chosen article is a **genuinely different term** and the
  overlap score is strong; otherwise keep the cascade's answer.
- **Names are resolved as entities before the word cascade**, so `Albert Einstein`
  can't come back as "a clever person" from Wiktionary. Detection: a multi-word
  selection containing a capital, or a single capitalised word that is **not** the
  sentence's first word. Acronyms (`CNAME`, `NASA`) skip this path.
- The entity card is used **only** when the Wikipedia summary's Wikidata item (P31)
  classifies as **Person**, **Place**, **Organisation** or **Work**. Otherwise
  discard the entity result and run the normal cascade (`April` stays the month,
  `Musk` stays the substance).
- Entity card content: kind badge, Wikipedia thumbnail, and up to three facts —
  born / occupation / citizenship (people); country / located in / population
  (places); founded / headquarters / industry (organisations); author / published
  (works). Paint the summary from Wikipedia and label facts as Wikidata-derived.
  When P625 coordinates exist, add a **Map** link to OpenStreetMap (no extra call).
- If **every tier misses**, the popup shows a short "no definition found" message
  plus a **"Search the web"** link — never a dead end.
- **Topic sources are the last resort before "not found"** and are **opt-in**.
  After the word cascade misses, query only the enabled sources: Stack Overflow tags,
  Open Library books, Crossref papers, Art Institute of Chicago artwork, PubChem
  chemicals and GBIF species. Fuzzy search results are discarded — the normalised
  title/name must equal the selection.
- Topic results show a kind badge (**Book**, **Paper**, **Artwork**, **Chemical**,
  **Species**, **Code**) and link to the source record. Priority is specificity:
  species/chemical > artwork > book/paper > code tag (a tag needs ≥50 questions;
  ≥500 ranks it with books). Context sense selection does not run on a topic card.
- **Other meanings carry a coarse category** from Wikipedia's short description, e.g.
  `Bristol (place)`, `Bristol City F.C. (football club)`, `Bristol Palin (person)`.
  Fetch descriptions in one batched `prop=description` request and cache them with
  the search results.
- **No AI, no models, no downloads.** Gloss must not ship an on-device AI tier,
  request model storage or add an AI settings page; the extension is fully useful
  with the free, keyless cascade. This is a deliberate product decision, not a
  missing feature.
- Always show the **source** (name + link) in the popup.

## Technical rules

- Manifest V3. Core permissions: `contextMenus`, `activeTab`, `scripting`,
  `storage`. Core hosts: Datamuse, dictionaryapi.dev, Wiktionary, Wikipedia,
  Wikidata, Wikimedia uploads.
- **Extra sources are optional host permissions**, requested from the settings page
  on a user gesture and removable at any time. Gate every topic lookup with
  `permissions.getAll()`; when no extra source is enabled, skip the tier entirely
  (no request, no cached miss).
- **All network fetches run in the background service worker**, never the content script.
- Treat **any** non-200 response or thrown error as a *miss* and fall through to the next tier.
- Give each source a short timeout (~3s) via `AbortController` so a hanging API can't stall the popup.
- **Normalise the selection** before lookup: collapse whitespace, strip surrounding
  punctuation, and strip a possessive suffix (`Einstein's` → `Einstein`). Cap length.
- Capture page context with `scripting.executeScript` (read-only); it returns
  `{ text, atSentenceStart, rect }` — the sentence around the selection, an exact
  range-based flag used by entity detection, and the selection's rectangle captured
  *before* the network call so a slow lookup still anchors the bubble correctly.
  The bubble is rendered the same way.
- **Cache every result** (hit *or* miss), keyed by word, so repeat lookups are instant.
  Base results are cached word-only; context-based overrides are recomputed per page.
  Entity results and *definitive* misses use their own prefix; timeouts, `429`s and
  network errors are never cached as "not an entity" — fall back and retry later.
- **Prune the cache**: `chrome.storage.local` is ~10 MB. Drop expired entries, then
  the oldest ~30% when usage exceeds the internal budget. Never prune non-cache keys.
- Topic lookups run **in parallel** with a 2.5s per-source timeout, and only when the
  word cascade misses. Cache hits for 7 days; cache a miss only when every enabled
  source answered definitively (a timeout, `429` or network error means retry later).
  Key the topic cache by the **enabled source set** so turning a new source on isn't
  blocked by an old miss.
- Topic host permissions are **optional**: `openlibrary.org`, `api.crossref.org`,
  `pubchem.ncbi.nlm.nih.gov`, `api.gbif.org`, `api.artic.edu`,
  `api.stackexchange.com`. Images are page-rendered from `covers.openlibrary.org`
  and `www.artic.edu` and need no host permission.
- Permission for entity facts: `https://www.wikidata.org/*` (in addition to
  Wikipedia). Still no API keys.
- Cache keys are **versioned** (`CACHE_VERSION`) so a code fix invalidates stale
  entries. Misses expire far sooner (6h) than hits (7d), so a temporary API outage
  never sticks.
- Clicking a suggestion fetches **that Wikipedia article directly** (`message.wiki`),
  not a full re-cascade, so valid suggestions never dead-end.
- **Show the bubble immediately**, then stream in pronunciation/audio afterwards —
  never block the popup on the audio lookup.
- Pronunciation sources, in order: **dictionaryapi.dev** (short 1.5s timeout), then
  **Datamuse IPA** (`md=r&ipa=1`, tag `ipa_pron:`), then **Wiktionary** audio files
  on Wikimedia Commons (parse API, prefer English `.mp3`). Audio wins; phonetic text
  fills in when the dictionary has none. Cache hits; misses are *not* cached because
  the dictionary API is flaky.
- The play control is a **speaker icon beside the word**, not a text button.
- Play audio **from the extension context**: try the direct URL first, and if the
  page blocks it (Brave Shields, strict CSP), `fetch` it from the content script
  and play a local blob URL. Keep a reference so the element isn't collected.
- Wikimedia etiquette: cache results, avoid bursts, and stay within the documented
  rate limits. Do **not** rely on a custom `User-Agent`: Chrome silently drops it
  from `fetch()` (MDN, Chromium bug 571722), so avoid APIs that *require* a
  contactable UA (e.g. MusicBrainz, Nominatim). Default browser UA + polite volume
  is the ceiling for a client-side extension.
- **No API keys and no model downloads** — every source is free and remote; added
  permissions must be justified by a data need (e.g. `wikidata.org` for entity facts).
- Tests live in `tests/` and run with `node --test tests/` — no dependencies, mocked
  `fetch`, offline. Add a test for any parsing, scoring or fallback change.
