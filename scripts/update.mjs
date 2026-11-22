// Daily updater: finds AnimeGG pages for AniList titles that were not in the
// index on the previous run, verifies them, and appends verified mappings.
// Data only. The scrape proxy comes from SCRAPE_PROXY_URL and is never logged.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
const stripTags = (s) => norm(s).replace(/\b(english|eng)?\s*(subbed|dubbed|sub|dub)\b$/, "").trim();
const baseTitle = (s) =>
  stripTags(s)
    .replace(/\b(?:season|part)\s*\d+\b/g, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\s*season\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function episodeTolerance(pageEpisodes, candidateEpisodes) {
  return Math.max(2, Math.ceil(0.1 * Math.max(pageEpisodes, candidateEpisodes)));
}

function matches(page, entry, aliases) {
  const pageTitles = [page.title, ...(page.altTitles ?? [])].flatMap((t) => [stripTags(t), baseTitle(t)]);
  const wanted = new Set(aliases.flatMap((t) => [stripTags(t), baseTitle(t)]).filter(Boolean));
  if (!pageTitles.some((t) => wanted.has(t))) return false;
  if (page.year != null && entry.year != null && Math.abs(page.year - entry.year) > 1) return false;
  const pageEpisodes = Math.max(Number(page.episodes) || 0, Number(page.maxEp) || 0) || null;
  if (pageEpisodes != null && entry.episodes != null) {
    if (Math.abs(pageEpisodes - entry.episodes) > episodeTolerance(pageEpisodes, entry.episodes)) return false;
  }
  if (String(entry.format ?? "").toLowerCase() === "movie" && (pageEpisodes ?? 0) > 1) return false;
  return true;
}

async function main() {
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { seen: [] };
  const seen = new Set(state.seen ?? []);
  const index = await get(INDEX_URL, { json: true });
  const mappedIds = new Set();
  for (const entry of Object.values(map)) {
    mappedIds.add(entry.id);
    for (const season of entry.seasons ?? []) mappedIds.add(season.id);
  }
  const newIds = index.filter((entry) => !seen.has(entry.id));
  log(`index ${index.length}; new ${newIds.length}; mapped ids ${mappedIds.size}`);
  if (!newIds.length) {
    writeFileSync(STATE_PATH, `${JSON.stringify({ seen: index.map((e) => e.id).sort((a, b) => a - b) })}\n`);
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

  const work = newIds.filter((entry) => !mappedIds.has(entry.id) && entry.format !== "MUSIC");
  const queue = [...work];
  const claimed = new Set(mappedIds);
  let added = 0;
  let failed = 0;

  async function processEntry(entry) {
    const manami = dataset.get(entry.id);
    const aliases = [
      ...(manami?.synonyms ?? []),
      ...(manami?.title ? [manami.title] : []),
      entry.title,
    ].filter(Boolean);
    if (!aliases.length) return;
    const queries = [...new Set([entry.title, manami?.title, ...(manami?.synonyms ?? [])].filter(Boolean))].slice(0, 2);
    const candidateSlugs = new Set();
    for (const query of queries) {
      try {
        const results = await get(`${BASE}/search/auto/?q=${encodeURIComponent(query)}`, { json: true });
        for (const item of Array.isArray(results) ? results : []) {
          const slug = String(item.url ?? "").split("/series/")[1];
          if (slug) candidateSlugs.add(slug);
        }
      } catch {
        // autocomplete failures are common under throttling; try the next query
      }
      await sleep(SPACING);
    }
    for (const slug of [...candidateSlugs].slice(0, 8)) {
      if (map[slug] || claimed.has(entry.id)) continue;
      let page;
      try {
        page = parseSeriesPage(await get(`${BASE}/series/${slug}`), slug);
      } catch {
        continue;
      }
      if (page.error || !matches(page, entry, aliases)) continue;
      map[slug] = { title: page.title, id: entry.id, source: "auto" };
      claimed.add(entry.id);
      added += 1;
      log(`mapped ${slug} -> ${entry.id} (${page.title})`);
      break;
    }
  }

  async function loop() {
    while (queue.length) {
      const entry = queue.shift();
      try {
        await processEntry(entry);
      } catch {
        failed += 1;
      }
      await sleep(SPACING);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, loop));
  writeFileSync(MAP_PATH, `${JSON.stringify(map)}\n`);
  writeFileSync(STATE_PATH, `${JSON.stringify({ seen: index.map((e) => e.id).sort((a, b) => a - b) })}\n`);
  log(`done: added ${added}, errors ${failed}, map ${Object.keys(map).length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`update failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
