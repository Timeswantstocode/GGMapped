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

`.github/workflows/update.yml` runs hourly. It reads the current AniList catalogue and airing feed, scrapes AnimeGG autocomplete and series pages for titles that are not mapped yet, and commits only mappings that pass the verification rules.

Hourly runs map new releases first and the rest of the budget drains older unmapped ids; a title gets seven attempts on a 1/2/3/7/14/30 day schedule after a miss. Each run has a 15-minute scrape budget (`GGMAP_BUDGET_MINUTES` to override); the workflow itself times out after 45 minutes. `GGMAP_IDS=287,141` restricts a manual run to those AniList ids, and `GGMAP_AIRING_URL` overrides the airing feed endpoint.

The ids scanned once by the old updater are frozen in `seen`, so hourly runs only cover new, airing and due-retry ids. A manual **update** dispatch with the `backfill` input (or `GGMAP_BACKFILL=1`) revisits those ids one attempt each, records misses in `exhausted`, and may try two title-derived slug guesses. Slug guesses are backfill-only.

The optional scrape proxy is provided through the repository secret `SCRAPE_PROXY_URL`. It is never written to the repository or to logs.
