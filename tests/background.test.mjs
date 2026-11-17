import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function hasTopicCache(store, word) {
  return [...store.keys()].some((key) => key.startsWith(`gloss:v5:topic:${word}|`));
}

function harness() {
  const store = new Map();
  let bytes = 0;
  let grantedOrigins = [
    "https://api.stackexchange.com/*",
    "https://openlibrary.org/*",
    "https://api.crossref.org/*",
    "https://api.artic.edu/*",
    "https://pubchem.ncbi.nlm.nih.gov/*",
    "https://api.gbif.org/*",
  ];
  let fetchImpl = async (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  };

  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      openOptionsPage() {},
    },
    contextMenus: {
      removeAll: async () => {},
      remove: async () => {},
      create() {},
      onClicked: event(),
    },
    permissions: {
      async getAll() {
        return { origins: [...grantedOrigins] };
      },
      async contains({ origins }) {
        return origins.every((origin) => grantedOrigins.includes(origin));
      },
      async request({ origins }) {
        grantedOrigins = [...new Set([...grantedOrigins, ...origins])];
        return true;
      },
      async remove({ origins }) {
        grantedOrigins = grantedOrigins.filter((origin) => !origins.includes(origin));
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return Object.fromEntries(store);
          const keys = typeof key === "string" ? [key] : key;
          const out = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(keys) {
          for (const k of [].concat(keys)) store.delete(k);
        },
        async getBytesInUse() {
          return bytes;
        },
      },
    },
    scripting: { async executeScript() { return [{ result: null }]; } },
  };

  const context = vm.createContext({
    console,
    fetch: (...args) => fetchImpl(...args),
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
    Intl,
    Date,
    Math,
    JSON,
    chrome,
  });

  vm.runInContext(source, context, { filename: "background.js" });

  return {
    context,
    store,
    setBytes(value) {
      bytes = value;
    },
    setFetch(fn) {
      fetchImpl = fn;
    },
    setOrigins(origins) {
      grantedOrigins = origins;
    },
  };
}

test("normalizeWord strips punctuation, possessives and whitespace", () => {
  const { context } = harness();
  assert.equal(context.normalizeWord("Einstein\u2019s"), "Einstein");
  assert.equal(context.normalizeWord("James's"), "James");
  assert.equal(context.normalizeWord("(Paris)"), "Paris");
  assert.equal(context.normalizeWord("  Albert   Einstein  "), "Albert Einstein");
  assert.equal(context.normalizeWord("rock'n'roll"), "rock'n'roll");
  assert.equal(context.normalizeWord("x".repeat(100)).length, 64);
});

test("entity detection keeps acronyms and sentence-initial words on the cascade", () => {
  const { context } = harness();
  assert.equal(context.shouldTreatAsEntity("Albert Einstein", { atSentenceStart: true }), true);
  assert.equal(context.shouldTreatAsEntity("Paris", { atSentenceStart: false }), true);
  assert.equal(context.shouldTreatAsEntity("Paris", { atSentenceStart: true }), false);
  assert.equal(context.shouldTreatAsEntity("CNAME", { atSentenceStart: false }), false);
  assert.equal(context.shouldTreatAsEntity("news", { atSentenceStart: false }), false);
});

test("htmlToText strips markup and decodes entities", () => {
  const { context } = harness();
  assert.equal(
    context.htmlToText('The <a href="/x">thing</a> &amp; <i>more</i>'),
    "The thing & more",
  );
  assert.equal(context.htmlToText("A&nbsp;b &#8212; c &#x2014; d"), "A b — c — d");
});

test("lookupWiktionaryRest keeps English senses and drops Translingual ones", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    en: [
      {
        partOfSpeech: "Symbol",
        language: "Translingual",
        definitions: [{ definition: "not English" }],
      },
      {
        partOfSpeech: "Noun",
        language: "English",
        definitions: [{ definition: "The <a>thing</a> &amp; more" }],
      },
    ],
  }));

  const result = await context.lookupWiktionaryRest("thing");
  assert.equal(result.source, "Wiktionary");
  assert.equal(result.definitions.length, 1);
  assert.equal(result.definitions[0].text, "The thing & more");
  assert.equal(result.definitions[0].partOfSpeech, "noun");
});

test("cascade prefers Wiktionary REST when Datamuse misses", async () => {
  const { context, setFetch } = harness();
  const urls = [];

  setFetch(async (url) => {
    urls.push(url);
    if (url.includes("api.datamuse.com")) return jsonResponse([]);
    if (url.includes("/page/definition/")) {
      return jsonResponse({
        en: [{
          partOfSpeech: "Noun",
          language: "English",
          definitions: [{ definition: "A <b>happy</b> accident." }],
        }],
      });
    }
    throw new Error(`should not reach ${url}`);
  });

  const payload = await context.baseDefine("serendipity");
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "Wiktionary");
  assert.equal(payload.definitions[0].text, "A happy accident.");
  assert.equal(urls.length, 2);
});

test("cascade falls through to dictionaryapi.dev when both Wiktionary sources miss", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("api.datamuse.com")) return jsonResponse([]);
    if (url.includes("/page/definition/")) return jsonResponse({}, 404);
    if (url.includes("dictionaryapi.dev")) {
      return jsonResponse([{
        word: "serendipity",
        meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A lucky find." }] }],
      }]);
    }
    return jsonResponse({}, 404);
  });

  const payload = await context.baseDefine("serendipity");
  assert.equal(payload.source, "Free Dictionary");
  assert.equal(payload.definitions[0].text, "A lucky find.");
});

test("Datamuse surfaces a different defHeadword but ignores redundant ones", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("sp=einsteins")) {
      return jsonResponse([{ word: "einsteins", defHeadword: "einstein", defs: ["n\tA physicist."] }]);
    }
    return jsonResponse([{ word: "geese", defHeadword: "Geese", defs: ["N\tA band."] }]);
  });

  const einsteins = await context.lookupDatamuse("einsteins");
  assert.equal(einsteins.headword, "einstein");

  const geese = await context.lookupDatamuse("geese");
  assert.equal(geese.headword, null);
});

test("rankDefinitionsByContext moves the matching sense first without mutating input", () => {
  const { context } = harness();
  const payload = {
    definitions: [
      { text: "A pleasant city in France." },
      { text: "A unit of pressure in physics." },
    ],
  };

  const ranked = context.rankDefinitionsByContext(
    payload,
    new Set(["nice"]),
    new Set(["pressure", "physics"]),
  );

  assert.equal(ranked.definitions[0].text, "A unit of pressure in physics.");
  assert.equal(payload.definitions[0].text, "A pleasant city in France.");
});

test("define() re-ranks senses using the selection's sentence", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("api.datamuse.com") && url.includes("md=d")) {
      return jsonResponse([{
        word: "nice",
        defs: ["adj\tPleasant and satisfactory.", "n\tA city on the French Riviera."],
      }]);
    }
    if (url.includes("dictionaryapi.dev")) return jsonResponse({}, 404);
    if (url.includes("wikipedia.org/w/api.php")) return jsonResponse({ query: { search: [] } });
    throw new Error(`unexpected ${url}`);
  });

  const payload = await context.define("Nice", {
    text: "The city on the French Riviera is nice this time of year.",
    atSentenceStart: false,
  });

  assert.match(payload.definitions[0].text, /city/i);
});

test("formatWikidataTime handles years, months, days and BC", () => {
  const { context } = harness();
  assert.equal(context.formatWikidataTime({ time: "-0458-00-00T00:00:00Z", precision: 9 }), "458 BC");
  assert.equal(context.formatWikidataTime({ time: "+1879-03-14T00:00:00Z", precision: 11 }), "14 March 1879");
  assert.equal(context.formatWikidataTime({ time: "+2015-12-00T00:00:00Z", precision: 10 }), "December 2015");
});

test("entity coordinates become an OpenStreetMap link", () => {
  const { context } = harness();
  const coords = context.extractCoordinates([{
    rank: "preferred",
    mainsnak: { datavalue: { value: { latitude: 48.8566, longitude: 2.3522 } } },
  }]);

  assert.equal(coords.latitude, 48.8566);
  assert.equal(coords.longitude, 2.3522);
  assert.equal(
    context.mapsUrl(coords),
    "https://www.openstreetmap.org/?mlat=48.85660&mlon=2.35220#map=13/48.85660/2.35220",
  );
  assert.equal(context.extractCoordinates([]), null);
});

test("Datamuse IPA is cached and returned in slashes", async () => {
  const { context, setFetch } = harness();
  let calls = 0;

  setFetch(async () => {
    calls += 1;
    return jsonResponse([{ word: "serendipity", tags: ["pron:S EH0", "ipa_pron:sɛrʌndˈɪpɪti"] }]);
  });

  const first = await context.lookupDatamusePronunciation("serendipity");
  assert.equal(first.phonetic, "/sɛrʌndˈɪpɪti/");

  setFetch(async () => {
    throw new Error("should be cached");
  });
  const second = await context.lookupDatamusePronunciation("serendipity");
  assert.equal(second.phonetic, first.phonetic);
  assert.equal(calls, 1);
});

test("pronunciation falls back to Datamuse IPA when only Wiktionary has audio", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("dictionaryapi.dev")) return jsonResponse({}, 404);
    if (url.includes("action=parse")) {
      return jsonResponse({
        parse: { text: { "*": '<audio src="//upload.wikimedia.org/wikipedia/commons/en-us-word.mp3">' } },
      });
    }
    if (url.includes("api.datamuse.com")) {
      return jsonResponse([{ tags: ["ipa_pron:wɜːd"] }]);
    }
    throw new Error(`unexpected ${url}`);
  });

  const pron = await context.resolvePronunciation("word");
  assert.equal(pron.phonetic, "/wɜːd/");
  assert.equal(pron.audio, "https://upload.wikimedia.org/wikipedia/commons/en-us-word.mp3");
});

test("pruneCache removes the oldest 30% when storage is near quota", async () => {
  const { context, store, setBytes } = harness();
  const now = Date.now();
  for (let index = 0; index < 10; index += 1) {
    store.set(`gloss:v5:base:word${index}`, {
      ts: now - 10_000 + index,
      ttl: 10 ** 9,
      payload: {},
    });
  }
  store.set("unrelated:key", { value: 1 });

  setBytes(9 * 1024 * 1024);
  await context.pruneCache();

  assert.equal(store.has("gloss:v5:base:word0"), false);
  assert.equal(store.has("gloss:v5:base:word2"), false);
  assert.equal(store.has("gloss:v5:base:word3"), true);
  assert.equal(store.has("unrelated:key"), true);
});

test("pruneCache drops expired entries before touching fresh ones", async () => {
  const { context, store, setBytes } = harness();
  store.set("gloss:v5:base:old", { ts: 1, ttl: 1, payload: {} });
  store.set("gloss:v5:base:fresh", { ts: Date.now(), ttl: 10 ** 9, payload: {} });

  setBytes(9 * 1024 * 1024);
  await context.pruneCache();

  assert.equal(store.has("gloss:v5:base:old"), false);
  assert.equal(store.has("gloss:v5:base:fresh"), true);
});

test("normalizeTitle ignores accents, punctuation and case", () => {
  const { context } = harness();
  assert.equal(context.normalizeTitle("Amélie!"), "amelie");
  assert.equal(context.normalizeTitle("  The   Great Gatsby "), "the great gatsby");
  assert.equal(context.normalizeTitle("C++"), "c");
});

test("Open Library book lookup requires an exact title match", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    docs: [
      { key: "/works/OL1W", title: "Dune Messiah", author_name: ["Frank Herbert"] },
      {
        key: "/works/OL2W",
        title: "Dune",
        author_name: ["Frank Herbert"],
        first_publish_year: 1965,
        subject: ["Science fiction"],
        cover_i: 123,
        first_sentence: ["In the week before their departure."],
      },
    ],
  }));

  const book = await context.lookupOpenLibraryBook("Dune");
  assert.equal(book.kind, "Book");
  assert.equal(book.title, "Dune");
  assert.equal(book.sourceUrl, "https://openlibrary.org/works/OL2W");
  assert.equal(book.image, "https://covers.openlibrary.org/b/id/123-M.jpg");
  assert.equal(book.facts[0].value, "Frank Herbert");
});

test("Crossref paper lookup requires an exact title match", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    message: {
      items: [
        { DOI: "10.1/near", title: ["Attention Is Almost All You Need"] },
        {
          DOI: "10.1/exact",
          title: ["Attention Is All You Need"],
          author: [{ given: "Ashish", family: "Vaswani" }],
          issued: { "date-parts": [[2017]] },
          "container-title": ["NeurIPS"],
          "is-referenced-by-count": 1000,
        },
      ],
    },
  }));

  const paper = await context.lookupCrossrefPaper("Attention Is All You Need");
  assert.equal(paper.kind, "Paper");
  assert.equal(paper.sourceUrl, "https://doi.org/10.1/exact");
  assert.equal(paper.facts[2].value, "1,000");
});

test("Art Institute lookup requires an exact artwork title", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    data: [
      { id: 2, title: "American Gothic '93" },
      {
        id: 1,
        title: "American Gothic",
        artist_title: "Grant Wood",
        date_display: "1930",
        medium_display: "Oil on Beaver Board",
        image_id: "abc",
        short_description: "One of America's most famous paintings.",
      },
    ],
  }));

  const artwork = await context.lookupArtInstituteArtwork("American Gothic");
  assert.equal(artwork.kind, "Artwork");
  assert.equal(artwork.sourceUrl, "https://www.artic.edu/artworks/1");
  assert.equal(artwork.facts[0].value, "Grant Wood");
  assert.match(artwork.image, /iiif\/2\/abc/);
});

test("PubChem lookup returns formula and molecular weight", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    PropertyTable: {
      Properties: [{
        CID: 2519,
        MolecularFormula: "C8H10N4O2",
        MolecularWeight: "194.19",
        IUPACName: "1,3,7-trimethylpurine-2,6-dione",
      }],
    },
  }));

  const chemical = await context.lookupPubChemCompound("caffeine");
  assert.equal(chemical.kind, "Chemical");
  assert.equal(chemical.sourceUrl, "https://pubchem.ncbi.nlm.nih.gov/compound/2519");
  assert.equal(chemical.facts[0].value, "C8H10N4O2");
  assert.equal(chemical.facts[1].value, "194.19 g/mol");
});

test("GBIF lookup accepts only exact species-level matches", async () => {
  const { context, setFetch } = harness();
  setFetch(async () => jsonResponse({
    matchType: "EXACT",
    rank: "SPECIES",
    canonicalName: "Panthera leo",
    scientificName: "Panthera leo (Linnaeus, 1758)",
    kingdom: "Animalia",
    family: "Felidae",
    usageKey: 5219404,
  }));

  const species = await context.lookupGbifSpecies("Panthera leo");
  assert.equal(species.kind, "Species");
  assert.equal(species.title, "Panthera leo");
  assert.equal(species.facts[2].value, "Felidae");

  setFetch(async () => jsonResponse({ matchType: "NONE" }));
  assert.equal(await context.lookupGbifSpecies("Zxqv Plorb"), null);

  setFetch(async () => jsonResponse({
    matchType: "EXACT",
    rank: "KINGDOM",
    canonicalName: "Animalia",
  }));
  assert.equal(await context.lookupGbifSpecies("Animalia"), null);
});

test("Stack Overflow lookup uses the tag wiki and ignores unknown tags", async () => {
  const { context, setFetch } = harness();
  const urls = [];

  setFetch(async (url) => {
    urls.push(url);
    const lower = url.toLowerCase();
    if (lower.includes("/tags/cname/info")) {
      return jsonResponse({ items: [{ name: "cname", count: 905 }] });
    }
    if (lower.includes("/tags/cname/wikis")) {
      return jsonResponse({ items: [{ excerpt: "A <b>CNAME</b> record is a DNS alias." }] });
    }
    throw new Error(`unexpected ${url}`);
  });

  const tag = await context.lookupStackTag("CNAME");
  assert.equal(tag.kind, "Code");
  assert.equal(tag.sourceUrl, "https://stackoverflow.com/questions/tagged/CNAME");
  assert.match(tag.definitions[0].text, /DNS alias/);

  setFetch(async (url) => {
    urls.push(url);
    return jsonResponse({ items: [] });
  });
  assert.equal(await context.lookupStackTag("zxqvplorb"), null);

  setFetch(async (url) => {
    urls.push(url);
    const lower = url.toLowerCase();
    if (lower.includes("/tags/dune/info")) {
      return jsonResponse({ items: [{ name: "dune", count: 39 }] });
    }
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(await context.lookupStackTag("dune"), null); // too few questions
});

test("lookupTopic prefers the most specific match and caches the result", async () => {
  const { context, setFetch, store } = harness();
  let requests = 0;

  setFetch(async (url) => {
    requests += 1;
    if (url.includes("api.stackexchange.com")) return jsonResponse({ items: [] });
    if (url.includes("openlibrary.org")) {
      return jsonResponse({ docs: [{ key: "/works/OL2W", title: "Dune", author_name: ["Frank Herbert"] }] });
    }
    if (url.includes("api.crossref.org")) return jsonResponse({ message: { items: [] } });
    if (url.includes("api.artic.edu")) return jsonResponse({ data: [] });
    if (url.includes("pubchem")) return jsonResponse({}, 404);
    if (url.includes("api.gbif.org")) return jsonResponse({ matchType: "NONE" });
    throw new Error(`unexpected ${url}`);
  });

  const first = await context.lookupTopic("Dune");
  assert.equal(first.kind, "Book");
  assert.equal(requests, 6);
  assert.ok(hasTopicCache(store, "dune"));

  setFetch(async () => {
    throw new Error("should be cached");
  });
  const second = await context.lookupTopic("Dune");
  assert.equal(second.kind, "Book");
});

test("lookupTopic prefers an exact species over a book with the same title", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("api.stackexchange.com")) return jsonResponse({ items: [] });
    if (url.includes("openlibrary.org")) {
      return jsonResponse({ docs: [{ key: "/works/OL1W", title: "Panthera Leo", author_name: ["Cat Mad"] }] });
    }
    if (url.includes("api.crossref.org")) return jsonResponse({ message: { items: [] } });
    if (url.includes("api.artic.edu")) return jsonResponse({ data: [] });
    if (url.includes("pubchem")) return jsonResponse({}, 404);
    if (url.includes("api.gbif.org")) {
      return jsonResponse({
        matchType: "EXACT",
        rank: "SPECIES",
        canonicalName: "Panthera leo",
        scientificName: "Panthera leo (Linnaeus, 1758)",
        family: "Felidae",
        kingdom: "Animalia",
        usageKey: 5219404,
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const payload = await context.lookupTopic("Panthera Leo");
  assert.equal(payload.kind, "Species");
  assert.equal(payload.title, "Panthera leo");
});

test("lookupTopic does not cache a miss when a source fails transiently", async () => {
  const { context, setFetch, store } = harness();

  const miss = (url) => {
    if (url.includes("api.stackexchange.com")) return jsonResponse({ items: [] });
    if (url.includes("openlibrary.org")) return jsonResponse({ docs: [] });
    if (url.includes("api.crossref.org")) return jsonResponse({ message: { items: [] } });
    if (url.includes("api.artic.edu")) return jsonResponse({ data: [] });
    if (url.includes("pubchem")) return jsonResponse({}, 500);
    if (url.includes("api.gbif.org")) return jsonResponse({ matchType: "NONE" });
    throw new Error(`unexpected ${url}`);
  };

  setFetch(async (url) => miss(url));
  assert.equal(await context.lookupTopic("Zxqv Plorb"), null);
  assert.equal(hasTopicCache(store, "zxqv plorb"), false);

  setFetch(async (url) => {
    if (url.includes("pubchem")) {
      return jsonResponse({ Fault: { Code: "PUGREST.NotFound" } }, 404);
    }
    return miss(url);
  });
  assert.equal(await context.lookupTopic("Zxqv Plorb"), null);
  assert.ok(hasTopicCache(store, "zxqv plorb"));
});

test("topic lookups are skipped when no extra source is enabled", async () => {
  const { context, setFetch, setOrigins, store } = harness();
  setOrigins([]);
  setFetch(async () => {
    throw new Error("should not fetch");
  });

  assert.equal(await context.lookupTopic("Dune"), null);
  assert.equal(hasTopicCache(store, "dune"), false);
});

test("topic lookups query only the enabled sources", async () => {
  const { context, setFetch, setOrigins } = harness();
  setOrigins(["https://openlibrary.org/*"]);
  let requests = 0;

  setFetch(async (url) => {
    requests += 1;
    if (!url.includes("openlibrary.org")) throw new Error(`unexpected ${url}`);
    return jsonResponse({
      docs: [{ key: "/works/OL2W", title: "Dune", author_name: ["Frank Herbert"] }],
    });
  });

  const payload = await context.lookupTopic("Dune");
  assert.equal(payload.kind, "Book");
  assert.equal(requests, 1);
});

test("categoryForDescription gives coarse labels for Other meanings", () => {
  const { context } = harness();
  assert.equal(context.categoryForDescription("City and county in England"), "place");
  assert.equal(context.categoryForDescription("Association football club in England"), "football club");
  assert.equal(context.categoryForDescription("American public speaker (born 1990)"), "person");
  assert.equal(context.categoryForDescription("Research university in England"), "organisation");
  assert.equal(context.categoryForDescription(""), null);
  assert.equal(
    context.categoryForDescription("British medium bomber in World War II"),
    "British medium bomber in World War II",
  );
});

test("wikipediaSearch attaches descriptions used for category labels", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("list=search")) {
      return jsonResponse({
        query: {
          search: [
            { title: "Bristol", snippet: "city in England" },
            { title: "Bristol City F.C.", snippet: "football club" },
          ],
        },
      });
    }
    if (url.includes("prop=description")) {
      return jsonResponse({
        query: {
          pages: {
            1: { title: "Bristol", description: "City and county in England" },
            2: { title: "Bristol City F.C.", description: "Association football club in England" },
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const hits = await context.wikipediaSearch("Bristol");
  assert.equal(hits[0].description, "City and county in England");
  assert.equal(context.categoryForDescription(hits[0].description), "place");
  assert.equal(context.categoryForDescription(hits[1].description), "football club");
});

test("alternatives carry their category labels", async () => {
  const { context, setFetch } = harness();

  setFetch(async (url) => {
    if (url.includes("list=search")) {
      return jsonResponse({
        query: {
          search: [
            { title: "Bristol", snippet: "city in England" },
            { title: "Bristol City F.C.", snippet: "football club" },
          ],
        },
      });
    }
    if (url.includes("prop=description")) {
      return jsonResponse({
        query: {
          pages: {
            1: { title: "Bristol", description: "City and county in England" },
            2: { title: "Bristol City F.C.", description: "Association football club in England" },
          },
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  });

  const alternatives = await context.findAlternatives("Bristol", null);
  const city = alternatives.find((alt) => alt.title === "Bristol");
  const club = alternatives.find((alt) => alt.title === "Bristol City F.C.");

  assert.equal(city.category, "place");
  assert.equal(club.category, "football club");
});

test("enabling a new source does not reuse an old topic miss", async () => {
  const { context, setFetch, setOrigins, store } = harness();
  setOrigins(["https://openlibrary.org/*"]);
  setFetch(async () => jsonResponse({ docs: [] }));

  assert.equal(await context.lookupTopic("Panthera Leo"), null);
  assert.ok(hasTopicCache(store, "panthera leo"));

  setOrigins(["https://openlibrary.org/*", "https://api.gbif.org/*"]);
  let gbifCalls = 0;
  setFetch(async (url) => {
    if (url.includes("openlibrary.org")) return jsonResponse({ docs: [] });
    if (url.includes("api.gbif.org")) {
      gbifCalls += 1;
      return jsonResponse({ matchType: "NONE" });
    }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(await context.lookupTopic("Panthera Leo"), null);
  assert.equal(gbifCalls, 1);
});
