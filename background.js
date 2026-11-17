// Gloss — background service worker / event page.
// Works as both a Chrome MV3 service worker and a Firefox MV3 event page.

const api = globalThis.browser ?? globalThis.chrome;

const MENU_ID = "gloss-define";
const LEGACY_AI_KEYS = ["gloss:settings", "gloss:ai", "gloss:aiHint"];
const REQUEST_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MISS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — outages shouldn't stick

// Bump CACHE_VERSION to invalidate previously cached results after a fix.
const CACHE_VERSION = "v4";
const BASE_CACHE_PREFIX = `gloss:${CACHE_VERSION}:base:`;
const SEARCH_CACHE_PREFIX = `gloss:${CACHE_VERSION}:search:`;
const PRON_CACHE_PREFIX = `gloss:${CACHE_VERSION}:pron:`;
const WIKT_AUDIO_CACHE_PREFIX = `gloss:${CACHE_VERSION}:wiktaudio:`;
const ENTITY_CACHE_PREFIX = `gloss:${CACHE_VERSION}:entity:`;
const TOPIC_CACHE_PREFIX = `gloss:${CACHE_VERSION}:topic:`;

const TOPIC_TIMEOUT_MS = 2500;

// Minimum context-overlap score before we override the default meaning.
const CONTEXT_MIN_SCORE = 3;
// Minimum overlap before we reorder dictionary senses by the page's sentence.
const DEFINITION_MIN_SCORE = 2;

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

  // Drop state left behind by the removed on-device AI feature.
  try {
    await api.storage.local.remove(LEGACY_AI_KEYS);
  } catch {
    // best effort
  }
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || info.menuItemId !== MENU_ID) return;

  const word = normalizeWord(info.selectionText);
  if (!word) return;

  const context = await getSelectionContext(tab.id);
  await lookupAndShow(tab.id, word, context);
});

// Bubble suggestion links re-look-up in place.
api.runtime.onMessage.addListener((message, sender) => {
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
  let payload = null;

  // Names are looked up as entities before the dictionary: Datamuse happily
  // defines "Albert Einstein" as "a clever person", which is never what a
  // selection of a person or place is asking for.
  if (shouldTreatAsEntity(word, context)) {
    payload = await lookupEntity(word).catch(() => null);
  }

  if (!payload) payload = await baseDefine(word);

  // Last resort before "not found": topic sources that only accept an exact
  // title/name match (books, papers, artwork, chemicals, species, code tags).
  if (!payload.ok) {
    const topic = await lookupTopic(word).catch(() => null);
    if (topic) payload = topic;
  }

  if (payload.ok && context?.text && !payload.entity && !payload.topic) {
    try {
      payload = await applyContext(payload, word, context.text);
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

  if (!payload) payload = await define(word, context);

  await showBubble(tabId, payload, context?.rect ?? null);

  if (payload.ok && !/\s/.test(word)) {
    resolvePronunciation(word)
      .then((pron) => {
        if (pron) addAudioToBubble(tabId, word, pron);
      })
      .catch(() => {});
  }
}

// Best-effort pronunciation. dictionaryapi.dev is flaky, so Wiktionary audio and
// Datamuse's IPA metadata fill the gaps.
async function resolvePronunciation(word) {
  const dict = await safe(() => lookupPronunciation(word));
  if (dict?.audio) return dict;

  const wikt = await safe(() => lookupWiktionaryAudio(word));
  if (wikt?.audio) {
    const phonetic = dict?.phonetic ?? (await safe(() => lookupDatamusePronunciation(word)))?.phonetic ?? null;
    return { phonetic, audio: wikt.audio };
  }

  return dict ?? (await safe(() => lookupDatamusePronunciation(word))) ?? null;
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

// Datamuse metadata carries IPA when asked for it (md=r&ipa=1).
async function lookupDatamusePronunciation(word) {
  const cacheKey = `dm:${word}`;
  const cached = await cacheGet(PRON_CACHE_PREFIX, cacheKey);
  if (cached) return cached;

  const data = await fetchJson(
    `https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=r&ipa=1&max=1`,
    1500,
  );
  const tags = Array.isArray(data) ? data[0]?.tags ?? [] : [];
  const ipa = tags.find((tag) => tag.startsWith("ipa_pron:"))?.slice("ipa_pron:".length);
  if (!ipa) return null;

  const result = { phonetic: `/${ipa}/`, audio: null };
  await cacheSet(PRON_CACHE_PREFIX, cacheKey, result);
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

  const sources = [lookupDatamuse, lookupWiktionaryRest, lookupDictionary, lookupWikipedia];

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

  // defHeadword appears for some inflected forms ("einsteins" -> "einstein"),
  // but not reliably ("geese" -> "Geese"), so only keep a real base form.
  const headword =
    data[0]?.defHeadword &&
    data[0].defHeadword.toLowerCase() !== (data[0].word ?? word).toLowerCase()
      ? data[0].defHeadword
      : null;

  return {
    source: "Wiktionary",
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(data[0].word ?? word)}`,
    headword,
    definitions,
  };
}

// Tier 2 — Wiktionary REST: structured definitions with HTML markup. Used when
// Datamuse has no entry (multiword phrases, senses Datamuse omits). Unlike the
// rejected raw wikitext extract, this endpoint returns parsed definitions.
async function lookupWiktionaryRest(word) {
  const data = await fetchJson(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
  );
  const groups = Array.isArray(data?.en) ? data.en : [];
  const definitions = [];

  for (const group of groups) {
    // The "en" payload also carries Translingual/symbol sections (e.g. "run");
    // only English senses belong in an English definition card.
    if (group?.language !== "English") continue;

    for (const def of group?.definitions ?? []) {
      const text = htmlToText(def?.definition);
      if (!text) continue;
      definitions.push({
        partOfSpeech: (group.partOfSpeech ?? "").toLowerCase() || null,
        text,
        example: null,
      });
      if (definitions.length >= 4) break;
    }

    if (definitions.length >= 4) break;
  }

  if (definitions.length === 0) return null;

  return {
    source: "Wiktionary",
    sourceUrl: `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    definitions,
  };
}

const HTML_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
};

function htmlToText(html) {
  const stripped = (html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:p|li|div|span|i|b)>/gi, " ")
    .replace(/<[^>]*>/g, "");

  return decodeHtmlEntities(stripped).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointText(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => codePointText(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function codePointText(code) {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function posLabel(code) {
  const labels = {
    n: "noun", v: "verb", adj: "adjective", adv: "adverb", prop: "proper noun",
    interj: "interjection", prep: "preposition", conj: "conjunction",
    pron: "pronoun", num: "numeral", art: "article", phrase: "phrase",
  };
  return labels[(code ?? "").trim().toLowerCase()] ?? null;
}

// Tier 3 — dictionaryapi.dev: fallback dictionary with phonetics and audio.
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

// Tier 4 — Wikipedia: concepts, jargon and entities (e.g. CNAME -> CNAME record).
async function lookupWikipedia(word) {
  const data = await fetchJson(wikipediaSummaryUrl(word));
  return wikiSummary(data, word);
}

function wikipediaSummaryUrl(word) {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
}

function wikiSummary(data, word) {
  if (!data || !data.extract) return null;
  if (data.type === "disambiguation") return null; // too ambiguous to be useful

  return {
    source: "Wikipedia",
    sourceUrl:
      data.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title ?? word)}`,
    title: data.title ?? null,
    description: data.description ?? null,
    wikibaseItem: data.wikibase_item ?? null,
    // Wikimedia returns thumb.wikimedia.org URLs with tracking query strings.
    image: (data.thumbnail?.source ?? data.originalimage?.source ?? "").split("?")[0] || null,
    definitions: [{ partOfSpeech: null, text: clampText(data.extract, 500), example: null }],
  };
}

// ---------------------------------------------------------------------------
// Entity lookups (people, places, organisations, works)
// ---------------------------------------------------------------------------

// A selection is a name when it is capitalised and is not just the first word
// of a sentence. Acronyms (CNAME, NASA) stay on the word cascade.
function shouldTreatAsEntity(word, context) {
  const tokens = word.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // Multi-word names always count: "Albert Einstein", "Buckingham Palace".
  if (tokens.length > 1) return tokens.some((token) => /^\p{Lu}/u.test(token));

  if (word.length < 2 || word === word.toUpperCase()) return false;
  if (!/^\p{Lu}/u.test(word)) return false;

  // "Nice" / "Gates" opening a sentence are most likely ordinary words.
  return !context?.atSentenceStart;
}

// Entity result, or null when Wikipedia/Wikidata don't recognise it as one.
// Definitive misses are cached; timeouts and rate limits are not, so the next
// lookup retries instead of serving "not an entity" for six hours.
async function lookupEntity(word) {
  const cached = await cacheGet(ENTITY_CACHE_PREFIX, word);
  if (cached) return cached.ok ? cached : null;

  let summary;
  try {
    summary = wikiSummary(await fetchJsonOrThrow(wikipediaSummaryUrl(word)), word);
  } catch (error) {
    if (error?.status === 404) await cacheEntityMiss(word);
    return null;
  }

  if (!summary) {
    await cacheEntityMiss(word);
    return null;
  }

  let facts = null;
  if (summary.wikibaseItem) {
    try {
      facts = await lookupEntityFacts(summary.wikibaseItem);
    } catch {
      return null; // Wikidata hiccup: answer from the cascade and retry later
    }
  }

  // Only treat the selection as an entity when Wikidata can name its kind.
  // Otherwise "April" or "Musk" would lose a perfectly good word definition.
  if (!facts?.kind) {
    await cacheEntityMiss(word);
    return null;
  }

  const payload = {
    ok: true,
    entity: true,
    word,
    source: summary.source,
    sourceUrl: summary.sourceUrl,
    title: summary.title,
    description: summary.description,
    image: summary.image ?? null,
    kind: facts.kind,
    facts: facts.facts,
    coords: facts.coords ?? null,
    mapsUrl: facts.coords ? mapsUrl(facts.coords) : null,
    definitions: summary.definitions,
    note: facts.facts.length > 0 ? "Summary from Wikipedia, facts from Wikidata." : null,
  };

  await cacheSet(ENTITY_CACHE_PREFIX, word, payload);
  return payload;
}

async function cacheEntityMiss(word) {
  await cacheSet(ENTITY_CACHE_PREFIX, word, { ok: false }, MISS_CACHE_TTL_MS);
}

const KIND_RULES = [
  ["Person", /^human$/i],
  [
    "Place",
    /\b(city|town|village|commune|municipality|country|capital|region|province|district|county|state|prefecture|department|continent|island|mountain|river|lake|sea|ocean|desert|park|palace|castle|tower|building|monument|landmark|museum|stadium|bridge|airport|station|neighborhood|neighbourhood|settlement|locality|administrative territorial entity)\b/i,
  ],
  [
    "Organisation",
    /\b(company|business|organization|organisation|enterprise|university|college|school|institute|agency|political party|club|association|foundation|bank|airline|government)\b/i,
  ],
  [
    "Work",
    /\b(film|novel|book|song|album|video game|television series|painting|sculpture|opera|play|written work)\b/i,
  ],
];

const FACT_PROPS = {
  Person: [["P569", "Born"], ["P106", "Occupation"], ["P27", "Citizenship"]],
  Place: [["P17", "Country"], ["P131", "Located in"], ["P1082", "Population"]],
  Organisation: [["P571", "Founded"], ["P159", "Headquarters"], ["P452", "Industry"]],
  Work: [["P50", "Author"], ["P571", "Published"], ["P495", "Country of origin"]],
};

const FACT_PROP_IDS = [
  "P31", "P569", "P106", "P27", "P17", "P131", "P1082", "P571", "P159", "P452", "P50", "P495",
];

const WIKIDATA_UNITS = {
  Q712226: "km²",
  Q35852: "ha",
  Q25343: "m²",
};

async function lookupEntityFacts(qid) {
  const data = await fetchJsonOrThrow(
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*" +
      `&props=claims&languages=en&ids=${encodeURIComponent(qid)}`,
  );
  const claims = data?.entities?.[qid]?.claims;
  if (!claims) return null;

  // One label request covers P31 and every value we may print.
  const ids = new Set();
  for (const prop of FACT_PROP_IDS) {
    for (const statement of claims[prop] ?? []) {
      const id = statement.mainsnak?.datavalue?.value?.id;
      if (id) ids.add(id);
    }
  }
  const labels = await fetchItemLabels([...ids]);

  const kind = classifyKind(claims.P31 ?? [], labels);
  if (!kind) return null;

  return { kind, facts: collectFacts(kind, claims, labels), coords: extractCoordinates(claims.P625 ?? []) };
}

function extractCoordinates(statements) {
  const value = bestStatements(statements)[0]?.mainsnak?.datavalue?.value;
  if (typeof value?.latitude !== "number" || typeof value?.longitude !== "number") return null;
  return { latitude: value.latitude, longitude: value.longitude };
}

function mapsUrl({ latitude, longitude }) {
  const lat = latitude.toFixed(5);
  const lon = longitude.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=13/${lat}/${lon}`;
}

async function fetchItemLabels(ids) {
  const labels = new Map();
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const data = await fetchJsonOrThrow(
      "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&origin=*" +
        `&props=labels&languages=en&ids=${batch.map(encodeURIComponent).join("|")}`,
    );
    for (const [id, entity] of Object.entries(data?.entities ?? {})) {
      const label = entity?.labels?.en?.value;
      if (label) labels.set(id, label);
    }
  }
  return labels;
}

function classifyKind(statements, labels) {
  const types = bestStatements(statements)
    .map((statement) => labels.get(statement.mainsnak?.datavalue?.value?.id) ?? "")
    .filter(Boolean);

  for (const [kind, pattern] of KIND_RULES) {
    if (types.some((type) => pattern.test(type))) return kind;
  }
  return null;
}

function bestStatements(statements) {
  const usable = statements.filter(
    (statement) => statement.rank !== "deprecated" && statement.mainsnak?.datavalue,
  );
  const preferred = usable.filter((statement) => statement.rank === "preferred");
  return preferred.length > 0 ? preferred : usable;
}

function collectFacts(kind, claims, labels) {
  const rows = [];

  for (const [prop, label] of FACT_PROPS[kind] ?? []) {
    let statements = bestStatements(claims[prop] ?? []);
    if (prop === "P1082") statements = latestPopulation(statements);

    const values = [];
    for (const statement of statements) {
      const formatted = formatClaimValue(prop, statement, labels);
      if (!formatted || values.includes(formatted)) continue;
      values.push(formatted);
      if (values.length >= 3) break;
    }

    if (values.length > 0) rows.push({ label, value: values.join(", ") });
    if (rows.length >= 3) break;
  }

  return rows;
}

// Population is published per year; show the most recent value.
function latestPopulation(statements) {
  if (statements.length <= 1) return statements;

  const timed = statements.map((statement) => ({
    statement,
    time: statement.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? "",
  }));

  return [timed.sort((a, b) => b.time.localeCompare(a.time))[0].statement];
}

function formatClaimValue(prop, statement, labels) {
  const value = statement.mainsnak?.datavalue?.value;
  if (!value) return null;

  if (prop === "P1082" && value.amount) return formatQuantity(value);
  if (value.id) return labels.get(value.id) ?? null;
  if (value.time) return formatWikidataTime(value);
  if (value.amount) return formatQuantity(value);
  if (typeof value === "string") return value;

  return null;
}

function formatWikidataTime(value) {
  const match = /^([+-])(\d{4,})-(\d{2})-(\d{2})/.exec(value.time ?? "");
  if (!match) return null;

  const year = Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const suffix = match[1] === "-" ? " BC" : "";
  const precision = value.precision ?? 9;

  // Wikidata's JSON time is ISO 8601:1988-style: -0458 is 458 BC, not 459 BC.
  if (precision >= 11 && month > 0 && day > 0) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return `${date.toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    })}${suffix}`;
  }

  if (precision === 10 && month > 0) {
    const date = new Date(Date.UTC(year, month - 1, 1));
    return `${date.toLocaleDateString("en-GB", {
      month: "long", year: "numeric", timeZone: "UTC",
    })}${suffix}`;
  }

  return `${year}${suffix}`;
}

function formatQuantity(value) {
  const amount = Number(value.amount);
  if (!Number.isFinite(amount)) return null;

  const unitId = (value.unit ?? "").split("/").pop();
  const unit = WIKIDATA_UNITS[unitId] ?? "";
  const number = amount.toLocaleString("en-US", { maximumFractionDigits: 1 });

  return unit ? `${number} ${unit}` : number;
}

// ---------------------------------------------------------------------------
// Topic lookups (books, papers, artwork, chemicals, species, code tags)
// ---------------------------------------------------------------------------

// Only consulted when the word cascade misses. Every source must return an
// exact title/name match; fuzzy search results are discarded.
const TOPIC_SOURCES = [
  lookupStackTag,
  lookupOpenLibraryBook,
  lookupCrossrefPaper,
  lookupArtInstituteArtwork,
  lookupPubChemCompound,
  lookupGbifSpecies,
];

async function lookupTopic(word) {
  const cached = await cacheGet(TOPIC_CACHE_PREFIX, word);
  if (cached) return cached.ok ? cached : null;

  const settled = await Promise.allSettled(TOPIC_SOURCES.map((source) => source(word)));
  const candidates = settled
    .filter((entry) => entry.status === "fulfilled" && entry.value)
    .map((entry) => entry.value);

  if (candidates.length === 0) {
    // Cache a definitive "no match"; retry when a source failed transiently.
    const failed = settled.some((entry) => entry.status === "rejected");
    if (!failed) await cacheSet(TOPIC_CACHE_PREFIX, word, { ok: false }, MISS_CACHE_TTL_MS);
    return null;
  }

  // Prefer the most specific kind of match: species/chemical > artwork > book/paper
  // > code tag. A 39-question tag must not beat a novel called "Dune".
  const best = candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  const { priority, ...result } = best;
  const payload = { ok: true, word, topic: true, ...result };
  await cacheSet(TOPIC_CACHE_PREFIX, word, payload);
  return payload;
}

async function topicJson(url) {
  try {
    return await fetchJsonOrThrow(url, TOPIC_TIMEOUT_MS);
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function normalizeTitle(value) {
  return stripTags(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function topicPayload({
  source,
  sourceUrl,
  title,
  description,
  kind,
  image,
  facts,
  definitions,
  priority = 0,
}) {
  return {
    source,
    sourceUrl,
    title: title ?? null,
    description: description || null,
    kind,
    image: image ?? null,
    facts: (facts ?? []).filter((fact) => fact?.value),
    definitions: [{ partOfSpeech: null, text: definitions, example: null }],
    priority,
  };
}

async function lookupStackTag(word) {
  const tag = encodeURIComponent(word);
  const info = await topicJson(
    `https://api.stackexchange.com/2.3/tags/${tag}/info?site=stackoverflow`,
  );
  const item = (info?.items ?? []).find(
    (entry) => normalizeTitle(entry.name) === normalizeTitle(word),
  );
  if (!item) return null;

  const count = Number(item.count) || 0;
  if (count < 50) return null; // too obscure to be a useful answer for prose
  const questions = count.toLocaleString("en-US");

  let excerpt = "";
  try {
    const wiki = await topicJson(
      `https://api.stackexchange.com/2.3/tags/${tag}/wikis?site=stackoverflow`,
    );
    excerpt = htmlToText(wiki?.items?.[0]?.excerpt ?? "");
  } catch {
    // Keep the tag even when its wiki excerpt can't be loaded.
  }

  return topicPayload({
    source: "Stack Overflow",
    sourceUrl: `https://stackoverflow.com/questions/tagged/${tag}`,
    title: item.name,
    description: `${questions} questions on Stack Overflow`,
    kind: "Code",
    definitions: excerpt || `Programming tag with ${questions} questions.`,
    priority: count >= 500 ? 2 : 1,
  });
}

async function lookupOpenLibraryBook(word) {
  const fields = "key,title,author_name,first_publish_year,subject,cover_i,first_sentence";
  const data = await topicJson(
    `https://openlibrary.org/search.json?title=${encodeURIComponent(word)}` +
      `&limit=5&fields=${fields}`,
  );
  const doc = (data?.docs ?? []).find(
    (entry) => entry.key && normalizeTitle(entry.title) === normalizeTitle(word),
  );
  if (!doc) return null;

  const authors = (doc.author_name ?? []).slice(0, 3);
  const subjects = (doc.subject ?? []).slice(0, 3);
  const year = doc.first_publish_year;
  const sentence = clampText((doc.first_sentence?.[0] ?? "").replace(/\s+/g, " ").trim(), 300);

  return topicPayload({
    source: "Open Library",
    sourceUrl: `https://openlibrary.org${doc.key}`,
    title: doc.title,
    description: [authors.join(", "), year].filter(Boolean).join(" · "),
    kind: "Book",
    image: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    facts: [
      { label: "Author", value: authors.join(", ") },
      { label: "First published", value: year ? String(year) : null },
      { label: "Subjects", value: subjects.join(", ") },
    ],
    definitions:
      sentence ||
      `Book${authors.length ? ` by ${authors.join(", ")}` : ""}` +
        `${year ? `, first published in ${year}` : ""}.`,
    priority: 2,
  });
}

async function lookupCrossrefPaper(word) {
  const select = "DOI,title,author,issued,container-title,abstract,is-referenced-by-count";
  const data = await topicJson(
    `https://api.crossref.org/works?rows=5&select=${select}` +
      `&query.bibliographic=${encodeURIComponent(word)}`,
  );
  const item = (data?.message?.items ?? []).find(
    (entry) => entry.DOI && normalizeTitle(entry.title?.[0]) === normalizeTitle(word),
  );
  if (!item) return null;

  const authors = (item.author ?? [])
    .slice(0, 3)
    .map((author) => [author.given, author.family].filter(Boolean).join(" "))
    .filter(Boolean);
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  const venue = item["container-title"]?.[0] ?? null;
  const citations = Number(item["is-referenced-by-count"]);
  const abstract = htmlToText(item.abstract ?? "");

  return topicPayload({
    source: "Crossref",
    sourceUrl: `https://doi.org/${item.DOI}`,
    title: item.title[0],
    description: [venue, year].filter(Boolean).join(" · "),
    kind: "Paper",
    facts: [
      { label: "Authors", value: authors.join(", ") },
      { label: "Published", value: year ? String(year) : null },
      { label: "Cited by", value: Number.isFinite(citations) ? citations.toLocaleString("en-US") : null },
    ],
    definitions:
      clampText(abstract, 400) ||
      `Paper${venue ? ` in ${venue}` : ""}${year ? ` (${year})` : ""}.`,
    priority: 2,
  });
}

async function lookupArtInstituteArtwork(word) {
  const fields =
    "id,title,artist_title,date_display,medium_display,image_id,place_of_origin,short_description";
  const data = await topicJson(
    `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(word)}` +
      `&fields=${fields}&limit=5`,
  );
  const item = (data?.data ?? []).find(
    (entry) => entry.id && normalizeTitle(entry.title) === normalizeTitle(word),
  );
  if (!item) return null;

  return topicPayload({
    source: "Art Institute of Chicago",
    sourceUrl: `https://www.artic.edu/artworks/${item.id}`,
    title: item.title,
    description: [item.artist_title, item.date_display].filter(Boolean).join(" · "),
    kind: "Artwork",
    image: item.image_id
      ? `https://www.artic.edu/iiif/2/${item.image_id}/full/400,/0/default.jpg`
      : null,
    facts: [
      { label: "Artist", value: item.artist_title },
      { label: "Date", value: item.date_display },
      { label: "Medium", value: item.medium_display },
    ],
    definitions:
      clampText(htmlToText(item.short_description ?? ""), 400) ||
      "Artwork in the Art Institute of Chicago collection.",
    priority: 3,
  });
}

async function lookupPubChemCompound(word) {
  const data = await topicJson(
    "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/" +
      `${encodeURIComponent(word)}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`,
  );
  const compound = data?.PropertyTable?.Properties?.[0];
  if (!compound?.CID) return null;

  const formula = compound.MolecularFormula ?? null;
  const weight = compound.MolecularWeight ? `${compound.MolecularWeight} g/mol` : null;
  const iupac = compound.IUPACName ?? null;

  return topicPayload({
    source: "PubChem",
    sourceUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${compound.CID}`,
    title: word,
    description: iupac,
    kind: "Chemical",
    facts: [
      { label: "Formula", value: formula },
      { label: "Molecular weight", value: weight },
      { label: "IUPAC name", value: iupac },
    ],
    definitions:
      `Chemical compound${formula ? ` with the formula ${formula}` : ""}` +
      `${weight ? ` and a molecular weight of ${weight}` : ""}.`,
    priority: 4,
  });
}

async function lookupGbifSpecies(word) {
  const data = await topicJson(
    `https://api.gbif.org/v1/species/match?name=${encodeURIComponent(word)}`,
  );
  const rank = data?.rank ?? "";

  if (data?.matchType !== "EXACT" || !["SPECIES", "SUBSPECIES", "GENUS"].includes(rank)) {
    return null;
  }

  const name = data.canonicalName ?? data.scientificName;
  if (!name) return null;

  return topicPayload({
    source: "GBIF",
    sourceUrl: `https://www.gbif.org/species/${data.usageKey}`,
    title: name,
    description: [rankLabel(rank), data.family ? `family ${data.family}` : data.kingdom]
      .filter(Boolean)
      .join(" · "),
    kind: "Species",
    facts: [
      { label: "Rank", value: rankLabel(rank) },
      { label: "Kingdom", value: data.kingdom },
      { label: "Family", value: data.family },
    ],
    definitions: `Scientific name: ${data.scientificName ?? name}.`,
    priority: 4,
  });
}

function rankLabel(rank) {
  const text = String(rank ?? "").toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

// ---------------------------------------------------------------------------
// Context-based sense selection
// ---------------------------------------------------------------------------

async function applyContext(base, word, context) {
  const contextTokens = tokenize(context);
  if (contextTokens.length === 0) return base;

  const queryTokens = new Set(tokenize(word));
  if (queryTokens.size === 0) return base;

  const contextSet = new Set(contextTokens);

  // Even when no different Wikipedia sense wins, prefer the dictionary sense
  // that best matches the sentence the word was selected in.
  base = rankDefinitionsByContext(base, queryTokens, contextSet);

  // Only consider articles that are plausibly a *sense of this word* — the title
  // must share a word with the query. This stops us from "disambiguating" to an
  // article that merely happens to be mentioned on the page (e.g. searching
  // "MV3" on a uBlock Origin page must not resolve to "UBlock Origin").
  const candidates = (await wikipediaSearch(word))
    .filter((hit) => !isDisambiguation(hit))
    .filter((hit) => isSenseOf(hit, queryTokens));

  if (candidates.length === 0) return base;

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
function isSenseOf(hit, queryTokens) {  const titleTokens = new Set(tokenize(hit.title));
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

// Put the sense whose wording overlaps the selection's sentence first. This is
// how a polysemous word gets a useful default before Wikipedia is consulted.
function rankDefinitionsByContext(payload, queryTokens, contextSet) {
  const definitions = payload.definitions ?? [];
  if (definitions.length < 2) return payload;

  const scored = definitions.map((definition, index) => ({
    definition,
    index,
    score:
      textOverlap(definition.text, queryTokens, contextSet) * 2 +
      textOverlap(definition.example, queryTokens, contextSet),
  }));

  const best = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  if (best < DEFINITION_MIN_SCORE) return payload;

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return { ...payload, definitions: scored.map((entry) => entry.definition) };
}

function textOverlap(text, queryTokens, contextSet) {
  const tokens = new Set(tokenize(text));
  let score = 0;

  for (const token of contextSet) {
    if (queryTokens.has(token)) continue;
    if (tokens.has(token)) score += 1;
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
        if (!selection || selection.rangeCount === 0) {
          return { text: "", atSentenceStart: false, rect: null };
        }

        const range = selection.getRangeAt(0);
        const selectedText = selection.toString().replace(/\s+/g, " ").trim();

        // Capture the anchor now: entity lookups can take a few seconds, and the
        // caret may have moved by the time the bubble renders.
        const rangeRect = range.getBoundingClientRect();
        const rect =
          rangeRect && (rangeRect.width || rangeRect.height)
            ? {
                left: rangeRect.left,
                top: rangeRect.top,
                right: rangeRect.right,
                bottom: rangeRect.bottom,
                width: rangeRect.width,
                height: rangeRect.height,
              }
            : null;

        let node = range.startContainer;
        while (node && node.nodeType !== 1) node = node.parentNode;

        const element = node instanceof Element ? node : node?.parentElement ?? null;
        const block =
          element?.closest(
            "p, li, dd, blockquote, figcaption, td, th, article, section, main, div",
          ) ?? element;

        const full = (block?.innerText ?? "").replace(/\s+/g, " ").trim();
        if (!full) return { text: "", atSentenceStart: false, rect };

        // Exact text before the selection, so a repeated word can't be mistaken
        // for the sentence's first word.
        let beforeSelection = "";
        try {
          if (block) {
            const preceding = document.createRange();
            preceding.selectNodeContents(block);
            preceding.setEnd(range.startContainer, range.startOffset);
            beforeSelection = preceding.toString().replace(/\s+/g, " ").trimEnd();
          }
        } catch {
          // Ranges across shadow boundaries; fall back to no position signal.
        }
        const atSentenceStart =
          !beforeSelection || /[.!?;:]["'”’)\]]*$/.test(beforeSelection);

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
            return { text: full.slice(start, end).trim().slice(0, 400), atSentenceStart, rect };
          }
        }

        return { text: full.slice(0, 400), atSentenceStart, rect };
      },
    });

    return {
      text: typeof result?.text === "string" ? result.text : "",
      atSentenceStart: result?.atSentenceStart === true,
      rect: typeof result?.rect?.top === "number" ? result.rect : null,
    };
  } catch {
    // Restricted pages (chrome://, PDF viewer) have no context or anchor.
    return { text: "", atSentenceStart: false, rect: null };
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

// Same request, but failures throw so callers can tell "no such page" (404)
// from "try again later" (timeout, 429, network error).
async function fetchJsonOrThrow(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cache (hits and misses), keyed by prefix + lowercased key
// ---------------------------------------------------------------------------

const CACHE_BYTE_BUDGET = 8 * 1024 * 1024; // prune before Chrome's 10 MB local quota
const PRUNE_EVERY_WRITES = 25;
let cacheWrites = 0;

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
    cacheWrites += 1;
    if (cacheWrites % PRUNE_EVERY_WRITES === 0) {
      pruneCache().catch(() => {});
    }
  } catch {
    // Caching is best-effort.
  }
}

// Drop expired entries, then the oldest ones when storage approaches its quota.
// chrome.storage.local is ~10 MB; without this the cache grows forever.
async function pruneCache() {
  if (typeof api.storage.local.getBytesInUse !== "function") return;
  if ((await api.storage.local.getBytesInUse(null)) < CACHE_BYTE_BUDGET) return;

  const all = await api.storage.local.get(null);
  const entries = Object.entries(all ?? {}).filter(
    ([key, value]) => key.startsWith("gloss:") && typeof value?.ts === "number",
  );
  if (entries.length === 0) return;

  const now = Date.now();
  const expired = entries
    .filter(([, value]) => now - value.ts > (value.ttl ?? CACHE_TTL_MS))
    .map(([key]) => key);

  if (expired.length > 0) {
    await api.storage.local.remove(expired);
    return; // re-check on the next prune; don't over-delete in one pass
  }

  entries.sort((a, b) => a[1].ts - b[1].ts);
  const oldest = entries
    .slice(0, Math.max(1, Math.ceil(entries.length * 0.3)))
    .map(([key]) => key);

  await api.storage.local.remove(oldest);
}

// ---------------------------------------------------------------------------
// Bubble (injected into the page)
// ---------------------------------------------------------------------------

async function showBubble(tabId, payload, selectionRect = null) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: renderGlossBubble,
      args: [payload, selectionRect],
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
function renderGlossBubble(payload, selectionRect) {
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
    .kind {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: #2563eb;
      background: rgba(37, 99, 235, 0.12);
      border-radius: 999px; padding: 2px 7px;
    }
    .phon { color: #6b7280; font-size: 13px; }
    .play {
      display: inline-flex; align-items: center; justify-content: center;
      border: 0; background: transparent; cursor: pointer;
      color: #2563eb; padding: 3px; margin-left: -2px; border-radius: 6px;
    }
    .play:hover { color: #1d4ed8; background: rgba(37, 99, 235, 0.12); }
    .play svg { display: block; }
    .desc { color: #4b5563; font-size: 13px; margin: 4px 0 0; }
    .thumb {
      float: right; width: 76px; height: 76px; object-fit: cover;
      border-radius: 8px; margin: 2px 0 8px 12px;
      background: rgba(0, 0, 0, 0.06);
    }
    .headword { color: #6b7280; font-size: 12.5px; margin: 4px 0 0; }
    ul { margin: 8px 0 0; padding: 0; list-style: none; }
    li { margin: 0 0 8px; }
    li:last-child { margin-bottom: 0; }
    .pos { font-style: italic; color: #6b7280; margin-right: 4px; }
    .eg { color: #6b7280; font-size: 13px; margin-top: 2px; }
    .facts {
      margin: 10px 0 0; display: grid;
      grid-template-columns: max-content 1fr; gap: 3px 10px;
      font-size: 13px;
    }
    .facts dt { color: #6b7280; }
    .facts dd { margin: 0; }
    .empty { color: #374151; margin: 6px 0 0; }
    .note { color: #6b7280; font-size: 12px; font-style: italic; margin: 8px 0 0; }
    .foot {
      margin-top: 10px; padding-top: 8px;
      border-top: 1px solid rgba(0, 0, 0, 0.08);
      display: flex; justify-content: space-between; align-items: center; gap: 8px;
    }
    .foot a, .empty a { color: #2563eb; text-decoration: none; font-size: 12px; }
    .foot a:hover, .empty a:hover { text-decoration: underline; }
    .foot-links { display: inline-flex; gap: 10px; align-items: center; }
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
    @media (prefers-color-scheme: dark) {
      .card { background: #1f1f23; color: #e8e8ea; border-color: rgba(255, 255, 255, 0.14); }
      .phon, .desc, .pos, .eg, .badge, .note, .alts, .alts-label, .facts dt { color: #a1a1aa; }
      .kind { color: #93c5fd; background: rgba(96, 165, 250, 0.16); }
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

  // Entity card image from the Wikipedia summary (thumb.wikimedia.org).
  if (payload.image) {
    const thumb = document.createElement("img");
    thumb.className = "thumb";
    thumb.src = payload.image;
    thumb.alt = "";
    thumb.loading = "lazy";
    thumb.referrerPolicy = "no-referrer";
    card.appendChild(thumb);
  }

  const word = document.createElement("span");
  word.className = "word";
  word.textContent = displayWord(payload.word);
  head.appendChild(word);

  if (payload.kind) {
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = payload.kind;
    head.appendChild(kind);
  }

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

  if (payload.headword) {
    const headword = document.createElement("p");
    headword.className = "headword";
    headword.textContent = `Inflected form of ${payload.headword}`;
    card.appendChild(headword);
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

  if (Array.isArray(payload.facts) && payload.facts.length > 0) {
    const facts = document.createElement("dl");
    facts.className = "facts";

    for (const fact of payload.facts) {
      const term = document.createElement("dt");
      term.textContent = fact.label;
      const value = document.createElement("dd");
      value.textContent = fact.value;
      facts.append(term, value);
    }

    card.appendChild(facts);
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

  if (payload.source) {
    const foot = document.createElement("div");
    foot.className = "foot";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `Source: ${payload.source}`;
    foot.appendChild(badge);

    const links = document.createElement("span");
    links.className = "foot-links";

    if (payload.mapsUrl) {
      const map = document.createElement("a");
      map.href = payload.mapsUrl;
      map.target = "_blank";
      map.rel = "noopener noreferrer";
      map.textContent = "Map \u2197";
      links.appendChild(map);
    }

    if (payload.sourceUrl) {
      const link = document.createElement("a");
      link.href = payload.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open \u2197";
      links.appendChild(link);
    }

    if (links.childElementCount > 0) foot.appendChild(links);

    card.appendChild(foot);
  }

  shadow.appendChild(card);

  // --- positioning near the selection ---
  const RECT_MARGIN = 8;
  const anchor =
    selectionRect && (selectionRect.width || selectionRect.height) ? selectionRect : null;

  let left = RECT_MARGIN;
  let top = 80;
  let anchorTop = top;

  if (anchor) {
    left = anchor.left;
    top = anchor.bottom + RECT_MARGIN;
    anchorTop = anchor.top;
  } else {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        left = rect.left;
        top = rect.bottom + RECT_MARGIN;
        anchorTop = rect.top;
      }
    }
  }

  document.documentElement.appendChild(host);

  const cardRect = card.getBoundingClientRect();
  const maxLeft = window.innerWidth - cardRect.width - RECT_MARGIN;
  left = Math.max(RECT_MARGIN, Math.min(left, maxLeft));

  if (top + cardRect.height > window.innerHeight - RECT_MARGIN) {
    top = Math.max(RECT_MARGIN, anchorTop - cardRect.height - RECT_MARGIN);
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
  // "Einstein's" must look up Einstein, not the plural "Einsteins".
  const depossessive = trimmed.replace(/['\u2019]s$/i, "");
  // Strip surrounding punctuation, keep the meaningful characters.
  const cleaned = depossessive.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
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
