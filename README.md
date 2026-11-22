# GGMapped

AnimeGG ↔ AniList id map. Data only.

miruapi uses this map to resolve an AnimeGG series page straight from an AniList id, instead of searching AnimeGG on every request.

## Layout

`data/animegg-map.json` is keyed by AnimeGG slug:

- `id` — AniList id (required; exactly one id per slug)
- `title` — page title
- `seasons` — optional `[{ id, start, end }]` when one page covers several AniList seasons
- `dubSlug` — optional separate dub page

A missing mapping is better than a wrong one. Every entry was checked against the series page title, aliases, year, episode count and format.

## Updates

`.github/workflows/update.yml` runs daily. It reads the current AniList catalogue, scrapes AnimeGG autocomplete and series pages for titles that are not mapped yet, and commits only mappings that pass the verification rules.

The optional scrape proxy is provided through the repository secret `SCRAPE_PROXY_URL`. It is never written to the repository or to logs.
