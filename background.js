// Gloss — background service worker / event page.
// Works as both a Chrome MV3 service worker and a Firefox MV3 event page.

const api = globalThis.browser ?? globalThis.chrome;

const MENU_ID = "gloss-define";
const AI_MENU_ID = "gloss-define-ai";
const SETTINGS_KEY = "gloss:settings";
const AI_STATE_KEY = "gloss:ai";
const AI_HINT_KEY = "gloss:aiHint";
const REQUEST_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MISS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — outages shouldn't stick

// Bump CACHE_VERSION to invalidate previously cached results after a fix.
const CACHE_VERSION = "v2";
const BASE_CACHE_PREFIX = `gloss:${CACHE_VERSION}:base:`;
const SEARCH_CACHE_PREFIX = `gloss:${CACHE_VERSION}:search:`;
const PRON_CACHE_PREFIX = `gloss:${CACHE_VERSION}:pron:`;
const WIKT_AUDIO_CACHE_PREFIX = `gloss:${CACHE_VERSION}:wiktaudio:`;

// Minimum context-overlap score before we override the default meaning.
const CONTEXT_MIN_SCORE = 3;

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

api.runtime.onInstalled.addListener(async () => {
  try {
    await api.contextMenus.removeAll();
  } catch {
    // ignore
  }
  api.contextMenus.create({
    id: MENU_ID,
    title: 'What is "%s"?',
    contexts: ["selection"],
  });
  await refreshAiMenu(await getAiAvailability());
});

// Keep the AI menu item in sync with the model's availability across restarts.
api.runtime.onStartup.addListener(async () => {
  await refreshAiMenu(await getAiAvailability());
});

// The AI menu item only exists while the on-device model is actually ready, so
// users who never download it never see a dead option.
async function refreshAiMenu(availability) {
  try {
    await api.contextMenus.remove(AI_MENU_ID);
  } catch {
    // didn't exist
  }
  if (availability !== "available") return;
  try {
    api.contextMenus.create({
      id: AI_MENU_ID,
      title: 'Explain "%s" with on-device AI',
      contexts: ["selection"],
    });
  } catch {
    // already exists
  }
}

async function getAiAvailability() {
  try {
    const stored = await api.storage.local.get(AI_STATE_KEY);
    return stored?.[AI_STATE_KEY]?.availability ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function setAiAvailability(availability) {
  try {
    await api.storage.local.set({
      [AI_STATE_KEY]: { availability, checkedAt: Date.now() },
    });
  } catch {
    // best effort
  }
}

// The one-time hint is shown at most once, ever.
async function shouldShowAiHint() {
  if (await aiEnabled()) return false;

  const availability = await getAiAvailability();
  if (availability !== "downloadable" && availability !== "available") return false;

  try {
    const stored = await api.storage.local.get(AI_HINT_KEY);
    return !stored?.[AI_HINT_KEY];
  } catch {
    return false;
  }
}

async function markHintShown() {
  try {
    await api.storage.local.set({ [AI_HINT_KEY]: true });
  } catch {
    // best effort
  }
}

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId !== MENU_ID && info.menuItemId !== AI_MENU_ID) return;

  const word = normalizeWord(info.selectionText);
  if (!word) return;

  const context = await getSelectionContext(tab.id);
  await lookupAndShow(tab.id, word, context, { aiOnly: info.menuItemId === AI_MENU_ID });
});

// Bubble links re-look-up in place; the options page reports AI availability.
api.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "gloss:openOptions") {
    api.runtime.openOptionsPage();
    return;
  }

  if (message?.type === "gloss:aiAvailability" && typeof message.availability === "string") {
    setAiAvailability(message.availability).then(() => refreshAiMenu(message.availability));
    return;
  }

  if (message?.type !== "gloss:lookup" || !sender.tab?.id || !message.word) return;

  const tabId = sender.tab.id;
  const word = normalizeWord(String(message.word));
  if (!word) return;

  const options = { wiki: message.wiki === true };
  getSelectionContext(tabId).then((context) => lookupAndShow(tabId, word, context, options));
});

// ---------------------------------------------------------------------------
// Lookup: base cascade, then optional context-based sense selection
// ---------------------------------------------------------------------------

async function define(word, context) {
  let payload = await baseDefine(word);

  if (payload.ok && context) {
    try {
      payload = await applyContext(payload, word, context);
    } catch {
      // Keep the base result if context handling fails.
    }
  }

  return payload;
}

// Look up, show the bubble immediately, then stream in pronunciation/audio.
async function lookupAndShow(tabId, word, context, options = {}) {
  let payload = null;

  // Suggestions come from Wikipedia search, so fetch that article directly
  // instead of re-running the cascade (which can miss disambiguation titles).
  if (options.wiki) {
    const chosen = await lookupWikipedia(word).catch(() => null);
    if (chosen) payload = { ok: true, word, ...chosen };
  }

  if (!payload && !options.aiOnly) payload = await define(word, context);

  // On-device AI: an explicit request, or the final tier when the cascade missed.
  if (options.aiOnly || (!payload.ok && (await aiEnabled()))) {
    const ai = await aiDefine(tabId, word, context);
    if (ai?.ok) {
      payload = ai;
    } else if (!payload || !payload.ok) {
      payload = {
        ok: false,
        word,
        note: `On-device AI didn't answer — ${ai?.error ?? "unknown reason"}.`,
        searchUrl: `https://www.google.com/search?q=define+${encodeURIComponent(word)}`,
      };
    }
  }

  // One-time nudge: only when a lookup genuinely fails, the model could actually
  // help, and we have never shown the hint before.
  if (!payload.ok && !options.aiOnly) {
    await maybeProbeAvailability(tabId);
    if (await shouldShowAiHint()) {
      payload.aiHint = true;
      await markHintShown();
    }
  }

  await showBubble(tabId, payload);

  if (payload.ok && !/\s/.test(word)) {
    resolvePronunciation(word)
      .then((pron) => {
        if (pron) addAudioToBubble(tabId, word, pron);
      })
      .catch(() => {});
  }

  // Learn whether the on-device model is ready (uses the activeTab we already have).
  maybeProbeAvailability(tabId).catch(() => {});
}

async function aiEnabled() {
  try {
    const stored = await api.storage.local.get(SETTINGS_KEY);
    return Boolean(stored?.[SETTINGS_KEY]?.aiEnabled);
  } catch {
    return false;
  }
}

// Best-effort probe so the AI menu item appears as soon as the model is ready.
async function maybeProbeAvailability(tabId) {
  if ((await getAiAvailability()) === "available") return;

  const availability = await probeAvailability(tabId);
  if (!availability || availability === (await getAiAvailability())) return;

  await setAiAvailability(availability);
  await refreshAiMenu(availability);
}

async function probeAvailability(tabId) {
  for (const world of ["ISOLATED", "MAIN"]) {
    try {
      const [{ result }] = await api.scripting.executeScript({
        target: { tabId },
        world,
        func: async () => {
          const LM = globalThis.LanguageModel;
          if (!LM || typeof LM.availability !== "function") return "unsupported";
          try {
            return await LM.availability();
          } catch {
            return "unsupported";
          }
        },
      });
      if (typeof result === "string" && result !== "unsupported") return result;
    } catch {
      // world unsupported, or page not scriptable
    }
  }
  return "unsupported";
}

// On-device definition via the W3C Prompt API (Gemini Nano / Phi-4-mini).
// Returns { ok, text } or { error } with a human-readable reason.
async function aiDefine(tabId, word, context) {
  const attempts = [];

  for (const world of ["ISOLATED", "MAIN"]) {
    const res = await runOnDevice(tabId, word, context, world);
    if (res?.ok && res.text) {
      return {
        ok: true,
        word,
        source: "On-device AI",
        sourceUrl: "",
        definitions: [{ partOfSpeech: null, text: res.text, example: null }],
        note: "Generated on-device by your browser's built-in model.",
      };
    }
    attempts.push(`${world} → ${res?.reason ?? "no result"}`);
  }

  return { error: attempts.join("  |  ") };
}

async function runOnDevice(tabId, word, context, world) {
  try {
    const [{ result }] = await api.scripting.executeScript({
      target: { tabId },
      world,
      func: onDeviceExplain,
      args: [word, context],
    });
    return result ?? { ok: false, reason: "empty result" };
  } catch (e) {
    return { ok: false, reason: `injection failed (${e?.message ?? e})` };
  }
}

// Self-contained (serialized + injected). Runs in the page, where the Prompt API lives.
async function onDeviceExplain(word, context) {
  const LM = globalThis.LanguageModel;
  if (!LM || typeof LM.availability !== "function") {
    return { ok: false, reason: "no LanguageModel in this context" };
  }

  let availability;
  try {
    availability = await LM.availability();
  } catch (e) {
    return { ok: false, reason: `availability() threw: ${e?.name}: ${e?.message}` };
  }

  if (availability === "unavailable") {
    return { ok: false, reason: "model reports 'unavailable' on this device" };
  }

  try {
    const session = await LM.create({
      initialPrompts: [
        {
          role: "system",
          content:
            "You explain what a word or term means, using at most two short sentences. Be concrete, plain and specific.",
        },
      ],
    });

    const prompt = context
      ? `Term: "${word}"\nContext: ${context}\n\nWhat does "${word}" mean here?`
      : `What does "${word}" mean?`;

    const answer = await session.prompt(prompt);
    if (typeof session.destroy === "function") session.destroy();

    const text = (answer ?? "").trim();
    return text
      ? { ok: true, text }
      : { ok: false, reason: `empty answer (availability=${availability})` };
  } catch (e) {
    return {
      ok: false,
      reason: `create/prompt failed (availability=${availability}): ${e?.name}: ${e?.message}`,
    };
  }
}

// Best-effort pronunciation. dictionaryapi.dev is flaky, so Wiktionary — whose
// audio is reliable — is the fallback.
async function resolvePronunciation(word) {
  const dict = await safe(() => lookupPronunciation(word));
  if (dict?.audio) return dict;

  const wikt = await safe(() => lookupWiktionaryAudio(word));
  if (wikt?.audio) return { phonetic: dict?.phonetic ?? null, audio: wikt.audio };

  return dict ?? null;
}

async function safe(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function lookupPronunciation(word) {
  const cached = await cacheGet(PRON_CACHE_PREFIX, word);
  if (cached) return cached;

  const data = await fetchJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
    1500,
  );
  if (!Array.isArray(data) || data.length === 0) return null;

  const entry = data[0];
  const phonetic = entry.phonetic ?? entry.phonetics?.find((p) => p.text)?.text ?? null;
  const rawAudio = entry.phonetics?.find((p) => p.audio)?.audio ?? null;
  const audio = rawAudio ? (rawAudio.startsWith("//") ? `https:${rawAudio}` : rawAudio) : null;

  if (!phonetic && !audio) return null; // don't cache misses; the API is flaky

  const result = { phonetic, audio };
  await cacheSet(PRON_CACHE_PREFIX, word, result);
  return result;
}

// Wiktionary audio lives on Wikimedia Commons as .ogg/.mp3 files.
async function lookupWiktionaryAudio(word) {
  const cached = await cacheGet(WIKT_AUDIO_CACHE_PREFIX, word);
  if (cached) return cached;

  const data = await fetchJson(
    "https://en.wiktionary.org/w/api.php?action=parse&format=json&origin=*" +
      `&prop=text&page=${encodeURIComponent(word)}`,
  );

  const html = data?.parse?.text?.["*"];
  if (!html) return null;

  const raw =
    html.match(/(?:https?:)?\/\/upload\.wikimedia\.org\/[^"'\s)]+\.(?:ogg|oga|mp3|wav)/gi) ?? [];
  const urls = raw.map((u) => (u.startsWith("//") ? `https:${u}` : u));

  const english = urls.filter((u) => /en-|\(eng\)|english/i.test(decodeURIComponent(u)));
  const pool = english.length > 0 ? english : urls;

  // Prefer mp3 (plays everywhere), then ogg.
  const audio =
    pool.find((u) => /\.mp3$/i.test(u)) ?? pool.find((u) => /\.ogg$/i.test(u)) ?? pool[0] ?? null;
  if (!audio) return null;

  const result = { audio };
  await cacheSet(WIKT_AUDIO_CACHE_PREFIX, word, result);
  return result;
}

// Cascade: try each source in order; first hit wins. Any error = miss.
async function baseDefine(word) {
  const cached = await cacheGet(BASE_CACHE_PREFIX, word);
  if (cached) return cached;

  const sources = [lookupDatamuse, lookupDictionary, lookupWikipedia];

  // Case matters to these APIs: "NEWS" misses Wiktionary's "news" and lands on
  // a Wikipedia disambiguation page. Try the word as typed, then lowercased.
  for (const candidate of caseVariants(word)) {
    for (const source of sources) {
      try {
        const result = await source(candidate);
        if (result) {
          const payload = { ok: true, word, ...result };
          await cacheSet(BASE_CACHE_PREFIX, word, payload);
          return payload;
        }
      } catch {
        // Treat any failure as a miss and try the next source.
      }
    }
  }

  const payload = {
    ok: false,
    word,
    searchUrl: `https://www.google.com/search?q=define+${encodeURIComponent(word)}`,
    alternatives: await findAlternatives(word, null),
  };
  await cacheSet(BASE_CACHE_PREFIX, word, payload, MISS_CACHE_TTL_MS);
  return payload;
}

function caseVariants(word) {
  return [...new Set([word, word.toLowerCase()])];
}

// Tier 1 — Datamuse: reliable, cleaned Wiktionary definitions (free, no key).
// Replaces the raw Wiktionary extract API, whose "intro" section is empty and
// whose plain-text output is full of section headers and non-English senses.
async function lookupDatamuse(word) {
  const data = await fetchJson(
    `https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=d&max=1`,
  );
  if (!Array.isArray(data) || data.length === 0) return null;

  const definitions = [];
  for (const entry of data[0]?.defs ?? []) {
    const tab = entry.indexOf("\t");
    const code = tab > -1 ? entry.slice(0, tab) : "";
    const text = (tab > -1 ? entry.slice(tab + 1) : entry).trim();
    if (!text) continue;
    definitions.push({ partOfSpeech: posLabel(code), text, example: null });
    if (definitions.length >= 4) break;
  }

  if (definitions.length === 0) return null;

  return {
    source: "Wiktionary",
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(data[0].word ?? word)}`,
    definitions,
  };
}

function posLabel(code) {
  const labels = {
    n: "noun", v: "verb", adj: "adjective", adv: "adverb", prop: "proper noun",
    interj: "interjection", prep: "preposition", conj: "conjunction",
    pron: "pronoun", num: "numeral", art: "article", phrase: "phrase",
  };
  return labels[(code ?? "").trim().toLowerCase()] ?? null;
}

// Tier 2 — dictionaryapi.dev: fallback dictionary with phonetics and audio.
async function lookupDictionary(word) {
  if (/\s/.test(word)) return null; // single words only

  const data = await fetchJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  );
  if (!Array.isArray(data) || data.length === 0) return null;

  const entry = data[0];
  const definitions = [];

  for (const meaning of entry.meanings ?? []) {
    for (const def of meaning.definitions ?? []) {
      definitions.push({
        partOfSpeech: meaning.partOfSpeech ?? null,
        text: def.definition,
        example: def.example ?? null,
      });
      if (definitions.length >= 4) break;
    }
    if (definitions.length >= 4) break;
  }

  if (definitions.length === 0) return null;

  return {
    source: "Free Dictionary",
    sourceUrl: "https://dictionaryapi.dev/",
    phonetic: entry.phonetic ?? entry.phonetics?.find((p) => p.text)?.text ?? null,
    audio: entry.phonetics?.find((p) => p.audio)?.audio ?? null,
    definitions,
  };
}

// Tier 3 — Wikipedia: concepts, jargon and entities (e.g. CNAME -> CNAME record).
async function lookupWikipedia(word) {
  const data = await fetchJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`,
  );
  if (!data || !data.extract) return null;
  if (data.type === "disambiguation") return null; // too ambiguous to be useful

  return {
    source: "Wikipedia",
    sourceUrl:
      data.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title ?? word)}`,
    title: data.title ?? null,
    description: data.description ?? null,
    definitions: [{ partOfSpeech: null, text: clampText(data.extract, 500), example: null }],
  };
}

// ---------------------------------------------------------------------------
// Context-based sense selection
// ---------------------------------------------------------------------------

async function applyContext(base, word, context) {
  const contextTokens = tokenize(context);
  if (contextTokens.length === 0) return base;

  const queryTokens = new Set(tokenize(word));
  if (queryTokens.size === 0) return base;

  // Only consider articles that are plausibly a *sense of this word* — the title
  // must share a word with the query. This stops us from "disambiguating" to an
  // article that merely happens to be mentioned on the page (e.g. searching
  // "MV3" on a uBlock Origin page must not resolve to "UBlock Origin").
  const candidates = (await wikipediaSearch(word))
    .filter((hit) => !isDisambiguation(hit))
    .filter((hit) => isSenseOf(hit, queryTokens));

  if (candidates.length === 0) return base;

  const contextSet = new Set(contextTokens);
  const scored = candidates
    .map((hit) => ({ hit, score: scoreHit(hit, queryTokens, contextSet) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < CONTEXT_MIN_SCORE) return base;

  // Same term as the query = not a distinct sense; keep the cascade's answer.
  if (best.hit.title.trim().toLowerCase() === word.trim().toLowerCase()) return base;

  const chosen = await lookupWikipedia(best.hit.title);
  if (!chosen) return base;

  return {
    ok: true,
    word,
    ...chosen,
    note: "Meaning chosen based on this page's context.",
    alternatives: buildAlternatives(scored, best.hit.title, base),
  };
}

// A candidate counts as a sense of the query only if their titles share a word.
function isSenseOf(hit, queryTokens) {
  const titleTokens = new Set(tokenize(hit.title));
  for (const token of queryTokens) {
    if (titleTokens.has(token)) return true;
  }
  return false;
}

function scoreHit(hit, queryTokens, contextSet) {
  const titleTokens = new Set(tokenize(hit.title));
  const bodyTokens = new Set([...titleTokens, ...tokenize(stripTags(hit.snippet ?? ""))]);

  let score = 0;
  for (const token of contextSet) {
    if (queryTokens.has(token)) continue; // the word itself is in every candidate
    if (titleTokens.has(token)) score += 3;
    else if (bodyTokens.has(token)) score += 1;
  }
  return score;
}

function buildAlternatives(scored, chosenTitle, base) {
  const out = [];
  const seen = new Set([chosenTitle.toLowerCase()]);

  // The meaning we're overriding, so the user can get back to it.
  if (base?.sourceUrl && base.title && !seen.has(base.title.toLowerCase())) {
    seen.add(base.title.toLowerCase());
    out.push({ title: `${base.title} (${base.source})`, url: base.sourceUrl });
  }

  for (const { hit } of scored) {
    const key = hit.title.toLowerCase();
    if (seen.has(key) || isDisambiguation(hit)) continue;
    seen.add(key);
    out.push({ title: hit.title, url: wikiUrl(hit.title) });
    if (out.length >= 4) break;
  }

  return out;
}

async function findAlternatives(word, excludeTitle) {
  const hits = await wikipediaSearch(word);
  const seen = new Set([excludeTitle?.toLowerCase()]);
  const out = [];

  for (const hit of hits) {
    const key = hit.title.toLowerCase();
    if (seen.has(key) || isDisambiguation(hit)) continue;
    seen.add(key);
    out.push({ title: hit.title, url: wikiUrl(hit.title) });
    if (out.length >= 4) break;
  }

  return out;
}

// Cached Wikipedia search (candidates + short snippets for scoring).
async function wikipediaSearch(word) {
  const cached = await cacheGet(SEARCH_CACHE_PREFIX, word);
  if (cached) return cached;

  const data = await fetchJson(
    "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
      `&list=search&srlimit=6&srsearch=${encodeURIComponent(word)}`,
  );

  const hits = (data?.query?.search ?? []).map((hit) => ({
    title: hit.title,
    snippet: hit.snippet ?? "",
  }));

  await cacheSet(SEARCH_CACHE_PREFIX, word, hits);
  return hits;
}

function isDisambiguation(hit) {
  return (
    /\(disambiguation\)/i.test(hit.title) ||
    /refer to the same term|topics referred to/i.test(stripTags(hit.snippet ?? ""))
  );
}

function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
}

// ---------------------------------------------------------------------------
// Page context capture
// ---------------------------------------------------------------------------

async function getSelectionContext(tabId) {
  try {
    const [{ result }] = await api.scripting.executeScript({
      target: { tabId },
      func: () => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return "";

        const selectedText = selection.toString().replace(/\s+/g, " ").trim();

        let node = selection.getRangeAt(0).startContainer;
        while (node && node.nodeType !== 1) node = node.parentNode;

        const element = node instanceof Element ? node : node?.parentElement ?? null;
        const block =
          element?.closest(
            "p, li, dd, blockquote, figcaption, td, th, article, section, main, div",
          ) ?? element;

        const full = (block?.innerText ?? "").replace(/\s+/g, " ").trim();
        if (!full) return "";

        // Use only the sentence around the selection (never the page title), so
        // the page's main topic can't dominate the sense scoring.
        if (selectedText) {
          const at = full.indexOf(selectedText);
          if (at >= 0) {
            const before = full.slice(0, at);
            const start =
              Math.max(
                before.lastIndexOf("."),
                before.lastIndexOf("!"),
                before.lastIndexOf("?"),
                before.lastIndexOf(";"),
              ) + 1;
            const after = full.slice(at + selectedText.length);
            const endRel = after.search(/[.!?;]/);
            const end = endRel >= 0 ? at + selectedText.length + endRel + 1 : full.length;
            return full.slice(start, end).trim().slice(0, 400);
          }
        }

        return full.slice(0, 400);
      },
    });
    return result ?? "";
  } catch {
    return ""; // Restricted pages (chrome://, PDF viewer) have no context.
  }
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null; // non-200 = miss
    return await res.json();
  } catch {
    return null; // network error, abort/timeout, or bad JSON = miss
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cache (hits and misses), keyed by prefix + lowercased key
// ---------------------------------------------------------------------------

async function cacheGet(prefix, key) {
  try {
    const storageKey = prefix + key.toLowerCase();
    const stored = await api.storage.local.get(storageKey);
    const hit = stored?.[storageKey];
    if (!hit) return null;
    if (Date.now() - hit.ts > (hit.ttl ?? CACHE_TTL_MS)) return null;
    return hit.payload;
  } catch {
    return null;
  }
}

async function cacheSet(prefix, key, payload, ttl = CACHE_TTL_MS) {
  try {
    const storageKey = prefix + key.toLowerCase();
    await api.storage.local.set({ [storageKey]: { ts: Date.now(), ttl, payload } });
  } catch {
    // Caching is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Bubble (injected into the page)
// ---------------------------------------------------------------------------

async function showBubble(tabId, payload) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: renderGlossBubble,
      args: [payload],
    });
  } catch {
    // Pages like chrome:// or the PDF viewer can't be scripted.
  }
}

// Streams pronunciation into an already-visible bubble.
async function addAudioToBubble(tabId, word, pron) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: attachPronunciation,
      args: [word, pron],
    });
  } catch {
    // Bubble may already be dismissed, or the page is not scriptable.
  }
}

// Self-contained (serialized + injected).
function attachPronunciation(word, pron) {
  const host = document.getElementById("__gloss_bubble_host__");
  if (!host || host.dataset.word !== word) return; // stale bubble

  const root = host.shadowRoot;
  const head = root?.querySelector(".head");
  const wordEl = root?.querySelector(".word");
  if (!head || !wordEl) return;

  if (pron.audio && !head.querySelector(".play")) {
    const play = document.createElement("button");
    play.className = "play";
    play.type = "button";
    play.title = "Play pronunciation";
    play.setAttribute("aria-label", "Play pronunciation");
    play.appendChild(speakerIcon());
    play.addEventListener("click", () => playAudio(pron.audio));
    wordEl.after(play);
  }

  if (pron.phonetic && !head.querySelector(".phon")) {
    const phon = document.createElement("span");
    phon.className = "phon";
    phon.textContent = pron.phonetic;
    (head.querySelector(".play") ?? wordEl).after(phon);
  }

  // Try the direct URL first; if the page blocks it (Brave Shields, strict CSP),
  // fetch it from the extension's own context and play a local blob instead.
  async function playAudio(url) {
    try {
      const direct = new Audio(url);
      globalThis.__glossAudio = direct;
      await direct.play();
      return;
    } catch {
      // fall through to the extension-context fetch
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const objectUrl = URL.createObjectURL(await res.blob());
      const audio = new Audio(objectUrl);
      globalThis.__glossAudio = audio;
      audio.addEventListener("ended", () => URL.revokeObjectURL(objectUrl), { once: true });
      await audio.play();
    } catch {
      // Give up silently.
    }
  }

  // Local copy: injected functions can't share the renderer's scope.
  function speakerIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ["M11 5 6 9H3v6h3l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"]) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }
}

// Self-contained: it is serialized and injected, so it must not reference
// anything from this file's scope. Everything arrives via `payload`.
function renderGlossBubble(payload) {
  const HOST_ID = "__gloss_bubble_host__";
  const prior = document.getElementById(HOST_ID);
  if (prior) prior.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.word = payload.word;
  host.style.position = "fixed";
  host.style.top = "0px";
  host.style.left = "0px";
  host.style.zIndex = "2147483647";

  const shadow = host.attachShadow({ mode: "open" });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    .card {
      position: relative;
      box-sizing: border-box;
      width: 340px;
      max-width: calc(100vw - 16px);
      max-height: 60vh;
      overflow-y: auto;
      padding: 14px 36px 12px 16px;
      background: #ffffff;
      color: #1a1a1a;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .word { font-size: 18px; font-weight: 650; }
    .phon { color: #6b7280; font-size: 13px; }
    .play {
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; background: transparent; cursor: pointer;
      color: #2563eb; padding: 3px; margin-left: -2px; border-radius: 6px;
    }
    .play:hover { color: #1d4ed8; background: rgba(37, 99, 235, 0.12); }
    .play svg { display: block; }
    .desc { color: #4b5563; font-size: 13px; margin: 4px 0 0; }
    ul { margin: 8px 0 0; padding: 0; list-style: none; }
    li { margin: 0 0 8px; }
    li:last-child { margin-bottom: 0; }
    .pos { font-style: italic; color: #6b7280; margin-right: 4px; }
    .eg { color: #6b7280; font-size: 13px; margin-top: 2px; }
    .empty { color: #374151; margin: 6px 0 0; }
    .note { color: #6b7280; font-size: 12px; font-style: italic; margin: 8px 0 0; }
    .foot {
      margin-top: 10px; padding-top: 8px;
      border-top: 1px solid rgba(0, 0, 0, 0.08);
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    .foot a, .empty a { color: #2563eb; text-decoration: none; font-size: 12px; }
    .foot a:hover, .empty a:hover { text-decoration: underline; }
    .close {
      position: absolute; top: 6px; right: 8px;
      border: 0; background: transparent; cursor: pointer;
      font-size: 18px; line-height: 1; color: #9ca3af; padding: 2px 4px;
    }
    .close:hover { color: #111827; }
    .badge {
      font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
      text-transform: uppercase; color: #6b7280;
    }
    .alts { margin-top: 10px; font-size: 12.5px; line-height: 1.6; color: #6b7280; }
    .alts a { color: #2563eb; text-decoration: none; }
    .alts a:hover { text-decoration: underline; }
    .alts-label { color: #6b7280; }
    .hint {
      position: relative;
      margin-top: 10px;
      padding: 8px 26px 8px 10px;
      background: rgba(37, 99, 235, 0.08);
      border-radius: 8px;
      font-size: 12px;
      color: #374151;
    }
    .hint a { color: #2563eb; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .hint-close {
      position: absolute; top: 3px; right: 5px;
      border: 0; background: transparent; cursor: pointer;
      color: #9ca3af; font-size: 15px; line-height: 1; padding: 2px 4px;
    }
    .hint-close:hover { color: #111827; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f1f23; color: #e8e8ea; border-color: rgba(255, 255, 255, 0.14); }
      .phon, .desc, .pos, .eg, .badge, .note, .alts, .alts-label { color: #a1a1aa; }
      .hint { background: rgba(96, 165, 250, 0.14); color: #d4d4d8; }
      .hint-close:hover { color: #ffffff; }
      .empty { color: #d4d4d8; }
      .foot { border-top-color: rgba(255, 255, 255, 0.12); }
      .close:hover { color: #ffffff; }
    }
  `);
  shadow.adoptedStyleSheets = [sheet];

  function displayWord(value) {
    const text = value ?? "";
    if (!text) return text;
    const first = text[0];
    if (first !== first.toLowerCase()) return text; // already capitalised / acronym
    return first.toUpperCase() + text.slice(1);
  }

  const card = document.createElement("div");
  card.className = "card";

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "\u00d7";
  card.appendChild(close);

  const head = document.createElement("div");
  head.className = "head";

  const word = document.createElement("span");
  word.className = "word";
  word.textContent = displayWord(payload.word);
  head.appendChild(word);

  if (payload.phonetic) {
    const phon = document.createElement("span");
    phon.className = "phon";
    phon.textContent = payload.phonetic;
    head.appendChild(phon);
  }

  card.appendChild(head);

  if (payload.title && payload.title.toLowerCase() !== payload.word.toLowerCase()) {
    const title = document.createElement("p");
    title.className = "desc";
    title.textContent = payload.description
      ? `${payload.title} \u2014 ${payload.description}`
      : payload.title;
    card.appendChild(title);
  } else if (payload.description) {
    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = payload.description;
    card.appendChild(desc);
  }

  if (payload.ok) {
    const list = document.createElement("ul");
    for (const def of payload.definitions) {
      const item = document.createElement("li");

      const text = document.createElement("span");
      if (def.partOfSpeech) {
        const pos = document.createElement("span");
        pos.className = "pos";
        pos.textContent = def.partOfSpeech;
        text.appendChild(pos);
      }
      text.appendChild(document.createTextNode(def.text));
      item.appendChild(text);

      if (def.example) {
        const eg = document.createElement("div");
        eg.className = "eg";
        eg.textContent = `\u201c${def.example}\u201d`;
        item.appendChild(eg);
      }

      list.appendChild(item);
    }
    card.appendChild(list);
  } else {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.appendChild(document.createTextNode(`No definition found for \u201c${displayWord(payload.word)}\u201d. `));
    const search = document.createElement("a");
    search.href = payload.searchUrl;
    search.target = "_blank";
    search.rel = "noopener noreferrer";
    search.textContent = "Search the web";
    empty.appendChild(search);
    card.appendChild(empty);
  }

  if (payload.note) {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = payload.note;
    card.appendChild(note);
  }

  if (Array.isArray(payload.alternatives) && payload.alternatives.length > 0) {
    const alts = document.createElement("div");
    alts.className = "alts";

    const label = document.createElement("span");
    label.className = "alts-label";
    label.textContent = payload.ok ? "Other meanings: " : "Did you mean: ";
    alts.appendChild(label);

    payload.alternatives.forEach((alt, index) => {
      if (index > 0) alts.appendChild(document.createTextNode(" \u00b7 "));

      const link = document.createElement("a");
      link.href = alt.url;
      link.textContent = alt.title;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const rt = globalThis.browser ?? globalThis.chrome;
        try {
          rt.runtime.sendMessage({ type: "gloss:lookup", word: alt.title, wiki: true });
        } catch {
          window.open(alt.url, "_blank", "noopener");
        }
      });
      alts.appendChild(link);
    });

    card.appendChild(alts);
  }

  if (payload.aiHint) {
    const hint = document.createElement("div");
    hint.className = "hint";

    const text = document.createElement("span");
    text.textContent =
      "On-device AI can explain words like this — free, private, no account. ";
    hint.appendChild(text);

    const enable = document.createElement("a");
    enable.href = "#";
    enable.textContent = "Enable in settings";
    enable.addEventListener("click", (event) => {
      event.preventDefault();
      const rt = globalThis.browser ?? globalThis.chrome;
      try {
        rt.runtime.sendMessage({ type: "gloss:openOptions" });
      } catch {
        // ignore
      }
    });
    hint.appendChild(enable);

    const dismiss = document.createElement("button");
    dismiss.className = "hint-close";
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "\u00d7";
    dismiss.addEventListener("click", () => hint.remove());
    hint.appendChild(dismiss);

    card.appendChild(hint);
  }

  if (payload.source) {
    const foot = document.createElement("div");
    foot.className = "foot";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `Source: ${payload.source}`;
    foot.appendChild(badge);

    if (payload.sourceUrl) {
      const link = document.createElement("a");
      link.href = payload.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open \u2197";
      foot.appendChild(link);
    }

    card.appendChild(foot);
  }

  shadow.appendChild(card);

  // --- positioning near the selection ---
  const RECT_MARGIN = 8;
  let left = RECT_MARGIN;
  let top = 80;

  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect && (rect.width || rect.height)) {
      left = rect.left;
      top = rect.bottom + RECT_MARGIN;
    }
  }

  document.documentElement.appendChild(host);

  const cardRect = card.getBoundingClientRect();
  const maxLeft = window.innerWidth - cardRect.width - RECT_MARGIN;
  left = Math.max(RECT_MARGIN, Math.min(left, maxLeft));

  if (top + cardRect.height > window.innerHeight - RECT_MARGIN) {
    const above = cardRect.top - cardRect.height - RECT_MARGIN;
    top = Math.max(RECT_MARGIN, above);
  }

  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;

  // --- dismissal ---
  function teardown() {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    host.remove();
  }

  function onPointerDown(event) {
    if (!event.composedPath().includes(host)) teardown();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") teardown();
  }

  close.addEventListener("click", teardown);
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeWord(raw) {
  const trimmed = (raw ?? "").replace(/\s+/g, " ").trim();
  // Strip surrounding punctuation, keep the meaningful characters.
  const cleaned = trimmed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return cleaned.slice(0, 64);
}

function clampText(text, maxLength) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) return flat;
  return flat.slice(0, maxLength).trimEnd() + "\u2026";
}

function stripTags(html) {
  return (html ?? "").replace(/<[^>]*>/g, " ");
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "these", "those",
  "from", "have", "has", "had", "its", "not", "you", "your", "his", "her", "they",
  "them", "their", "which", "what", "when", "where", "while", "into", "over", "than",
  "then", "there", "here", "also", "such", "can", "may", "more", "most", "other",
  "some", "any", "all", "one", "two", "new", "used", "using", "use", "first",
  "second", "known", "often", "many", "much", "less", "like", "just", "about", "been",
  "being", "does", "did", "but", "who", "whom", "how", "why", "will", "would", "could",
  "should", "out", "own", "same", "only", "very", "each", "both", "between", "through",
]);

function tokenize(text) {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}
