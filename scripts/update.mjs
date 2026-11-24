// Hourly updater: finds AnimeGG pages for AniList titles that are unmapped or
// due for a retry, verifies them, and appends verified mappings.
// Data only. The scrape proxy comes from SCRAPE_PROXY_URL and is never logged.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// One entry per line so the map stays readable and diffable; values compact.
function stringifyMap(map) {
  const rows = Object.entries(map).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return rows.length ? `{\n${rows.join(",\n")}\n}\n` : "{}\n";
}

const ROOT = new URL("..", import.meta.url);
const MAP_PATH = process.env.GGMAP_MAP ? pathToFileURL(process.env.GGMAP_MAP) : new URL("data/animegg-map.json", ROOT);
const STATE_PATH = process.env.GGMAP_STATE ? pathToFileURL(process.env.GGMAP_STATE) : new URL("data/state.json", ROOT);
const INDEX_URL = "https://raw.githubusercontent.com/sanilili/media-index/main/data/index.json";
const MANAMI_URL =
  "https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json";
const BASE = "https://www.animegg.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PROXY = process.env.SCRAPE_PROXY_URL || "";
const CONCURRENCY = 3;
const TIMEOUT = 45_000;
const SPACING = 350;
const BUDGET_MINUTES = Number(process.env.GGMAP_BUDGET_MINUTES) || 15;
const MAX_ATTEMPTS = 7;
const BACKOFF_DAYS = [1, 2, 3, 7, 14, 30];
const DAY = 24 * 60 * 60 * 1000;
const DUB_RE = /-dub$/i;
const AIRING_URL = process.env.GGMAP_AIRING_URL || "https://graphql.anilist.co";
const AIRING_QUERY =
  "query { Page(perPage: 25) { media(type: ANIME, status: RELEASING, sort: START_DATE_DESC) { id status format episodes seasonYear title { romaji english } startDate { year month day } } } }";

const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const ROMAN = { i: 1, v: 5, x: 10, l: 50, c: 100 };
function romanNumber(value) {
  let total = 0;
  let previous = 0;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const digit = ROMAN[value[i]];
    if (!digit) return null;
    if (digit < previous) total -= digit;
    else {
      total += digit;
      previous = digit;
    }
  }
  return total > 0 && total < 100 ? total : null;
}
const ROMAN_WORD = "i{1,3}|iv|v|vi{0,3}|ix|x{1,3}";
const MARKER_VALUE = `(\\d{1,2}|${ROMAN_WORD})`;
// Season/part/cour signature: titles only compare when base and all three
// ordinals agree, so "Part 2" pages cannot absorb a "Part 1" entry.
export function signature(title) {
  let text = norm(title);
  text = text.replace(/\b(english|eng)?\s*(subbed|dubbed|sub|dub)\b$/, "").replace(/\s+/g, " ").trim();
  const found = { season: null, part: null, cour: null };
  const mark = (kind, value) => {
    const number = /^\d+$/.test(value) ? Number(value) : romanNumber(value);
    if (number && found[kind] == null) found[kind] = number;
  };
  text = text.replace(new RegExp(`\\b(season|part|cour)\\s+${MARKER_VALUE}\\b`, "g"), (match, kind, value) => {
    mark(kind, value);
    return " ";
  });
  text = text.replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+(season|part|cour)\b/g, (match, value, kind) => {
    mark(kind, value);
    return " ";
  });
  text = text.replace(/\b(\d{1,2})\s+cour\b/g, (match, value) => {
    mark("cour", value);
    return " ";
  });
  text = text.replace(/\bs\s*(\d{1,2})$/g, (match, value) => {
    mark("season", value);
    return " ";
  });
  let bareSeason = null;
  const bare = text.match(/\b([ivxlcdm]{1,7})$/);
  if (bare && !found.season && !found.part && !found.cour) {
    const number = romanNumber(bare[1]);
    if (number) {
      bareSeason = number;
      text = text.slice(0, bare.index);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return {
    base: text,
    season: found.season ?? bareSeason ?? 1,
    part: found.part ?? 1,
    cour: found.cour ?? 1,
  };
}
const sameTitle = (left, right) => {
  const a = norm(left);
  if (a && a === norm(right)) return true;
  const x = signature(left);
  const y = signature(right);
  return Boolean(x.base && y.base) && x.base === y.base && x.season === y.season && x.part === y.part && x.cour === y.cour;
};
const usableAlias = (alias) => {
  const text = norm(alias);
  if (!text) return false;
  return /[a-z]/.test(text) || /^\d+$/.test(String(alias).trim());
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[]\\]/g, "\\$&");
const cleanTitle = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function viaProxy(url) {
  if (!PROXY) return url;
  const payload = Buffer.from(`${url}\u0000${BASE}/`).toString("base64url");
  return `${PROXY.replace(/\/$/, "")}/p/${payload}`;
}

async function get(url, { json = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(viaProxy(url), {
        headers: { "user-agent": UA, accept: json ? "application/json" : "text/html" },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return json ? response.json() : response.text();
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw new Error("unreachable");
}

export function parseSeriesPage(html, slug) {
  const source = String(html ?? "");
  const headings = [...source.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => cleanTitle(m[1])).filter(Boolean);
  const title = headings.filter((value) => !/watch anime|animegg/i.test(value)).pop() ?? null;
  const info = [...source.matchAll(/<p[^>]*class="[^"]*infoami[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => cleanTitle(m[1])).join(" | ");
  const episodes = Number(info.match(/\bEpisodes:\s*(\d+)/i)?.[1]) || null;
  const year =
    Number(
      info.match(/\b(?:Year|Released|Premiered|Aired|Start(?:ed)?)\s*:?\s*(?:[A-Za-z]+\s+)?(\d{4})/i)?.[1] ??
        info.match(/\bSeason\s*:\s*[A-Za-z]+\s+(\d{4})/i)?.[1],
    ) || null;
  const alternate = info.match(/Alternate Titles:\s*([^|]+)/i)?.[1] ?? "";
  const altTitles = alternate.split(/[;,]/).map(cleanTitle).filter(Boolean);
  const scoped = [...source.matchAll(new RegExp(`/${escapeRegex(slug)}-episode-(\\d+)`, "gi"))].map((m) => Number(m[1]));
  const dataEp = [...source.matchAll(/\bdata-ep\s*=\s*["'](\d+)["']/gi)].map((m) => Number(m[1]));
  const maxEp = Math.max(0, ...scoped, ...dataEp) || null;
  if (!title) return { slug, error: "parse" };
  return { slug, title, year, episodes, maxEp, altTitles };
}

const isDubPage = (slug, title) => DUB_RE.test(slug) || /\(dub\)/i.test(String(title ?? ""));

function episodeTolerance(pageEpisodes, candidateEpisodes) {
  return Math.max(2, Math.ceil(0.1 * Math.max(pageEpisodes, candidateEpisodes)));
}

// Returns the matched title signature plus the page episode count, or null.
// A page needs at least one episode link; a page may have fewer episodes than
// the entry (currently airing) and may count up to 2x+12 as a superset.
// A superset match must come from a core alias (entry title or feed title),
// never from a manami synonym alone.
function matchInfo(page, entry, aliases, coreAliases = []) {
  const wanted = aliases.filter(usableAlias);
  const core = coreAliases.filter(usableAlias);
  if (!wanted.length) return null;
  let matched = null;
  let coreMatch = false;
  for (const title of [page.title, ...(page.altTitles ?? [])]) {
    if (!title) continue;
    for (const alias of wanted) {
      if (sameTitle(title, alias)) {
        matched = signature(title);
        coreMatch = core.some((candidate) => sameTitle(title, candidate));
        break;
      }
    }
    if (matched) break;
  }
  if (!matched) return null;
  const primaryTitle = norm(page.title);
  const format = String(entry.format ?? "").toUpperCase();
  if (/\b(?:movie|film|gekijouban)\b/.test(primaryTitle) && format !== "MOVIE") return null;
  if (/\b(?:ova|oav|specials?)\b/.test(primaryTitle) && ["TV", "TV_SHORT", "ONA"].includes(format)) return null;
  if (page.year != null && entry.year != null && Math.abs(page.year - entry.year) > 1) return null;
  if (page.maxEp == null) return null;
  const pageEpisodes = Math.max(Number(page.episodes) || 0, Number(page.maxEp) || 0) || null;
  if (pageEpisodes == null) return null;
  if (String(entry.format ?? "").toLowerCase() === "movie" && pageEpisodes > 1) return null;
  const entryEpisodes = Number(entry.episodes) || null;
  const status = String(entry.status ?? "").toUpperCase();
  if ((status === "FINISHED" || status === "CANCELLED") && entryEpisodes != null) {
    const floor = Math.max(2, Math.floor(entryEpisodes * 0.5));
    if (pageEpisodes < floor) return null;
  }
  let superset = false;
  if (entryEpisodes != null) {
    const tolerance = episodeTolerance(pageEpisodes, entryEpisodes);
    if (pageEpisodes > entryEpisodes + tolerance) {
      if (!coreMatch) return null;
      if (pageEpisodes > entryEpisodes * 2 + 12) return null;
      superset = true;
    }
  }
  return { ...matched, pageEpisodes, superset, core: coreMatch };
}

const FAMILY_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const SIBLING_SLUG = [/-\d+$/, /-season-\d+$/, /-part-\d+$/, /-\d+(?:st|nd|rd|th)-season$/, /-\d+nd-cour$/, /-s\d+$/];

// AniList's airing feed is a second work source so just-started shows get a
// page as soon as AnimeGG lists them. Failures fall back to the index only.
async function fetchAiring() {
  try {
    const response = await fetch(AIRING_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": UA },
      body: JSON.stringify({ query: AIRING_QUERY }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const media = payload?.data?.Page?.media;
    if (!Array.isArray(media)) throw new Error("unexpected payload");
    return media
      .filter((item) => Number(item?.id))
      .map((item) => ({
        id: Number(item.id),
        title: item.title?.romaji || item.title?.english || "",
        year: item.seasonYear ?? null,
        format: item.format ?? null,
        episodes: item.episodes ?? null,
        status: item.status ?? null,
        aliases: [item.title?.english, item.title?.romaji].filter(Boolean),
      }));
  } catch (error) {
    log(`airing feed unavailable (${error?.message ?? error}); using index only`);
    return [];
  }
}

async function main() {
  const deadline = Date.now() + BUDGET_MINUTES * 60_000;
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { seen: [] };
  const seen = new Set(Array.isArray(state.seen) ? state.seen.map(Number).filter(Number.isFinite) : []);
  const attempts = state.attempts && typeof state.attempts === "object" ? state.attempts : {};
  const exhausted = new Set(
    Array.isArray(state.exhausted) ? state.exhausted.map(Number).filter(Number.isFinite) : [],
  );
  const backfill = process.env.GGMAP_BACKFILL === "1";
  const index = await get(INDEX_URL, { json: true });
  const airing = await fetchAiring();
  const airingIds = new Set(airing.map((entry) => entry.id));
  const entries = new Map(index.map((entry) => [entry.id, entry]));
  for (const candidate of airing) {
    const entry = entries.get(candidate.id);
    if (!entry) {
      entries.set(candidate.id, candidate);
      continue;
    }
    // The catalogue stays canonical; the feed only fills gaps and adds aliases.
    for (const key of ["title", "year", "format", "episodes", "status"]) {
      if (entry[key] == null) entry[key] = candidate[key];
    }
    entry.aliases = [...new Set([...(entry.aliases ?? []), ...candidate.aliases])];
  }
  const mappedIds = new Set();
  for (const entry of Object.values(map)) {
    mappedIds.add(entry.id);
    for (const season of entry.seasons ?? []) mappedIds.add(season.id);
  }
  const claimed = new Set(mappedIds);
  const dubSlugs = new Set(Object.values(map).map((entry) => entry.dubSlug).filter(Boolean));
  const familyIndex = new Map();
  for (const item of index) {
    if (!FAMILY_FORMATS.has(item.format)) continue;
    if (item.status === "NOT_YET_RELEASED") continue;
    if (!(Number(item.episodes) > 1)) continue;
    const { base } = signature(item.title);
    if (!base) continue;
    if (!familyIndex.has(base)) familyIndex.set(base, []);
    familyIndex.get(base).push(item);
  }
  for (const list of familyIndex.values()) {
    list.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id - b.id);
  }
  const saveState = () => {
    const kept = {};
    for (const id of Object.keys(attempts).map(Number).sort((a, b) => a - b)) {
      if (!claimed.has(id)) kept[id] = attempts[id];
    }
    const output = {};
    if (seen.size) output.seen = [...seen];
    output.attempts = kept;
    output.exhausted = [...exhausted].sort((a, b) => a - b);
    writeFileSync(STATE_PATH, `${JSON.stringify(output)}\n`);
  };
  // A backfill prunes every legacy id that is mapped or exhausted.
  const pruneSeen = () => {
    if (!backfill) return;
    for (const id of claimed) seen.delete(id);
    for (const id of exhausted) seen.delete(id);
  };
  // GGMAP_IDS restricts one run to a few AniList ids (comma separated) for repair.
  const restrict = new Set(
    String(process.env.GGMAP_IDS ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const now = Date.now();
  const work = [];
  for (const entry of entries.values()) {
    if (entry.format === "MUSIC" || mappedIds.has(entry.id) || exhausted.has(entry.id)) continue;
    if (restrict.size && !restrict.has(entry.id)) continue;
    const previous = attempts[entry.id];
    const legacy = !previous && seen.has(entry.id);
    if (legacy && !backfill) continue;
    // A status change (e.g. NOT_YET_RELEASED -> RELEASING) earns fresh attempts.
    const transitioned = previous?.s != null && previous.s !== entry.status;
    const n = previous ? (transitioned ? 0 : Number(previous.n) || 0) : legacy ? 1 : 0;
    const t = previous ? Date.parse(previous.t) || 0 : 0;
    if (n >= MAX_ATTEMPTS) continue;
    if (n > 0 && now - t < BACKOFF_DAYS[Math.min(n, BACKOFF_DAYS.length) - 1] * DAY) continue;
    let tier = 4;
    if (transitioned) tier = 0;
    else if (!previous && airingIds.has(entry.id)) tier = 1;
    else if (!previous && !seen.has(entry.id)) tier = 2;
    else if (legacy) tier = 3;
    work.push({ entry, n, t, tier, legacy });
  }
  work.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier < 4) return a.entry.id - b.entry.id;
    return a.n - b.n || a.t - b.t || a.entry.id - b.entry.id;
  });
  log(
    `index ${index.length}; airing ${airingIds.size}; work ${work.length}; legacy ${work.filter((item) => item.legacy).length}; exhausted ${exhausted.size}; mapped ids ${mappedIds.size}; attempts due ${work.filter((item) => item.n > 0).length}; priority ${work.filter((item) => item.tier < 3).length}`,
  );
  if (!work.length) {
    pruneSeen();
    saveState();
    return;
  }

  const dataset = new Map();
  try {
    const manami = await get(MANAMI_URL, { json: true });
    for (const entry of manami.data ?? []) {
      const al = (entry.sources ?? []).find((s) => s.includes("anilist.co/anime/"));
      const id = Number(al?.match(/anime\/(\d+)/)?.[1]);
      if (id) dataset.set(id, entry);
    }
    log(`manami ${dataset.size}`);
  } catch {
    log("manami unavailable; using index titles only");
  }

  const queue = [...work];
  let added = 0;
  let failed = 0;
  let guessHits = 0;
  let guessMisses = 0;

  async function processEntry({ entry }) {
    const manami = dataset.get(entry.id);
    const coreAliases = [entry.title, ...(entry.aliases ?? [])].filter(Boolean);
    const extendedAliases = [
      ...(manami?.synonyms ?? []),
      ...(manami?.title ? [manami.title] : []),
    ].filter(Boolean);
    const aliases = [...coreAliases, ...extendedAliases];
    if (!aliases.length) return;
    const queries = [
      ...new Set([entry.title, ...(entry.aliases ?? []), manami?.title, ...(manami?.synonyms ?? [])].filter(Boolean)),
    ].slice(0, 2);
    const candidateSlugs = new Set();
    const candidateNames = new Map();
    for (const query of queries) {
      try {
        const results = await get(`${BASE}/search/auto/?q=${encodeURIComponent(query)}`, { json: true });
        for (const item of Array.isArray(results) ? results : []) {
          const slug = String(item.url ?? "").split("/series/")[1];
          if (!slug) continue;
          candidateSlugs.add(slug);
          if (!candidateNames.has(slug)) candidateNames.set(slug, String(item.name ?? ""));
        }
      } catch {
        // autocomplete failures are common under throttling; try the next query
      }
      await sleep(SPACING);
    }

    const pages = new Map();
    const fetchPage = async (slug) => {
      if (!pages.has(slug)) {
        let page = null;
        try {
          const parsed = parseSeriesPage(await get(`${BASE}/series/${slug}`), slug);
          if (!parsed.error) page = parsed;
        } catch {
          // a missing or throttled series page is a miss
        }
        pages.set(slug, page);
      }
      return pages.get(slug);
    };
    const inspect = async (slug) => {
      const page = await fetchPage(slug);
      if (!page) return null;
      const info = matchInfo(page, entry, aliases, coreAliases);
      return info ? { page, info } : null;
    };
    const attachDub = async (value, slug) => {
      const dubSlug = `${slug}-dub`;
      if (!candidateSlugs.has(dubSlug) || map[dubSlug] || dubSlugs.has(dubSlug)) return;
      const dub = await inspect(dubSlug);
      if (!dub || !isDubPage(dubSlug, dub.page.title)) return;
      value.dubSlug = dubSlug;
      dubSlugs.add(dubSlug);
    };
    const buildSeasons = (info, slug) => {
      const family = (familyIndex.get(info.base) ?? []).filter(
        (item) => entry.year == null || item.year == null || Math.abs(item.year - entry.year) <= 3,
      );
      // A dedicated page for any family member wins over a combined page.
      if (family.length < 2 || !family.some((item) => item.id === entry.id)) return null;
      if (family.some((item) => claimed.has(item.id))) return null;
      for (const candidate of candidateSlugs) {
        if (candidate === slug) continue;
        const sig = signature(candidateNames.get(candidate) || candidate);
        const same =
          sig.base === info.base && sig.season === info.season && sig.part === info.part && sig.cour === info.cour;
        if (!same && SIBLING_SLUG.some((pattern) => pattern.test(candidate))) return null;
        if (
          sig.base === info.base &&
          (sig.season !== info.season || sig.part !== info.part || sig.cour !== info.cour)
        ) {
          return null;
        }
      }
      let total = 0;
      const seasons = family.map((item) => {
        const range = { id: item.id, start: total + 1, end: total + Number(item.episodes) };
        total = range.end;
        return range;
      });
      const tolerance = Math.max(2, Math.ceil(0.02 * total));
      const exact = Math.abs(info.pageEpisodes - total) <= tolerance;
      const last = family[family.length - 1];
      const growing =
        last.status === "RELEASING" &&
        info.pageEpisodes > total - Number(last.episodes) &&
        info.pageEpisodes <= total + tolerance;
      return exact || growing ? seasons : null;
    };
    const commit = async (slug, result, { guess = false } = {}) => {
      const value = { title: result.page.title };
      if (result.info.superset) {
        const seasons = buildSeasons(result.info, slug);
        if (seasons) {
          value.seasons = seasons;
          for (const season of seasons) claimed.add(season.id);
          await attachDub(value, slug);
          map[slug] = value;
          added += 1;
          log(
            `mapped ${slug} (${result.page.title}) seasons ${seasons.map((season) => season.id).join(",")}${value.dubSlug ? ` + ${value.dubSlug}` : ""}${guess ? " [guess]" : ""}`,
          );
          return true;
        }
      }
      value.id = entry.id;
      if (!result.info.superset) await attachDub(value, slug);
      map[slug] = value;
      claimed.add(entry.id);
      added += 1;
      log(`mapped ${slug} -> ${entry.id} (${result.page.title})${value.dubSlug ? ` + ${value.dubSlug}` : ""}${guess ? " [guess]" : ""}`);
      return true;
    };

    // Sub pages first; a dub page only becomes the primary when no sub page
    // verified (dub-only titles such as jinkiextend-dub).
    const candidates = [...candidateSlugs];
    const ordered = [
      ...candidates.filter((slug) => !DUB_RE.test(slug)),
      ...candidates.filter((slug) => DUB_RE.test(slug)),
    ];
    const entryOrdinal = signature(entry.title);
    const preferPart = entryOrdinal.part > 1;
    const preferCour = entryOrdinal.cour > 1;
    const preferOrdinal = preferPart || preferCour;
    const verified = [];
    let dubFallback = null;
    for (const slug of ordered) {
      if (dubFallback && DUB_RE.test(slug)) break;
      if (map[slug] || dubSlugs.has(slug) || claimed.has(entry.id)) continue;
      const result = await inspect(slug);
      if (!result) continue;
      if (isDubPage(slug, result.page.title)) {
        dubFallback ??= { slug, page: result.page };
        continue;
      }
      if (preferOrdinal) {
        verified.push({ slug, result });
        continue;
      }
      if (await commit(slug, result)) return;
    }
    if (preferOrdinal && verified.length) {
      const preferred = verified.filter(({ result }) =>
        [result.page.title, ...(result.page.altTitles ?? [])].some((title) => {
          const sig = signature(title);
          return (preferPart && sig.part === entryOrdinal.part) || (preferCour && sig.cour === entryOrdinal.cour);
        }),
      );
      const chosen = (preferred.length ? preferred : verified)[0];
      if (await commit(chosen.slug, chosen.result)) return;
    }
    if (dubFallback && !claimed.has(entry.id)) {
      const { slug, page } = dubFallback;
      map[slug] = { title: page.title, id: entry.id };
      claimed.add(entry.id);
      added += 1;
      log(`mapped ${slug} -> ${entry.id} (${page.title})`);
      return;
    }
    // Backfill-only: two title-derived guesses when autocomplete found nothing.
    if (backfill) {
      const guesses = [];
      for (const title of [entry.title, manami?.title, ...(entry.aliases ?? [])]) {
        const slug = norm(title).replace(/ /g, "-");
        if (!slug || guesses.includes(slug)) continue;
        guesses.push(slug);
        if (guesses.length === 2) break;
      }
      for (const slug of guesses) {
        if (candidateSlugs.has(slug) || map[slug] || dubSlugs.has(slug) || claimed.has(entry.id)) continue;
        const result = await inspect(slug);
        if (!result) {
          guessMisses += 1;
          continue;
        }
        guessHits += 1;
        log(`guess ${slug} hit`);
        if (isDubPage(slug, result.page.title)) {
          map[slug] = { title: result.page.title, id: entry.id };
          claimed.add(entry.id);
          added += 1;
          log(`mapped ${slug} -> ${entry.id} (${result.page.title}) [guess]`);
          return;
        }
        if (await commit(slug, result, { guess: true })) return;
      }
    }
  }

  async function loop() {
    while (queue.length && Date.now() < deadline) {
      const item = queue.shift();
      if (claimed.has(item.entry.id) || exhausted.has(item.entry.id)) continue;
      try {
        await processEntry(item);
      } catch {
        failed += 1;
      }
      if (item.legacy) {
        seen.delete(item.entry.id);
        if (!claimed.has(item.entry.id)) exhausted.add(item.entry.id);
      } else if (claimed.has(item.entry.id)) {
        delete attempts[item.entry.id];
      } else {
        attempts[item.entry.id] = { n: item.n + 1, t: new Date().toISOString(), s: item.entry.status };
      }
      await sleep(SPACING);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, loop));
  pruneSeen();
  writeFileSync(MAP_PATH, stringifyMap(map));
  saveState();
  log(`done: added ${added}, errors ${failed}, left ${queue.length}, map ${Object.keys(map).length}, guesses ${guessHits}/${guessHits + guessMisses}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`update failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
