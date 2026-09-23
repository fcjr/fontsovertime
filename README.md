# Fonts Over Time

Which typefaces the web's homepages use, tracked weekly: [fontsovertime.com](https://fontsovertime.com).

Every Sunday a GitHub Actions workflow opens about 10,000 homepages in headless Chromium, records the font doing the work for body text and headings, commits the results to this repo, and redeploys the static site to Cloudflare Pages. A smaller list of well-known sites is crawled daily to catch switches quickly.

## Layout

```
sites/            one CSV per industry category, cohorts/ (top sites, YC, unicorns), marquee.txt for the daily crawl
crawler/          Playwright crawler (crawl.ts), in-page extractor (extract.js), static CSS fallback (static.ts)
pipeline/         merge shards, normalize names (aliases.json), aggregate, Wayback backfill
data/snapshots/   weekly/, daily/ and wayback/ crawls as gzipped JSON Lines
data/exports/     latest.csv, one row per site (linked from the site's data page)
data/agg/         precomputed JSON the site is built from
web/              Astro site
```

## Running it

Needs Node 24+ and pnpm.

```sh
pnpm install
pnpm exec playwright install chromium

pnpm crawl sites --out out/crawl.jsonl         # crawl every list (about 20 minutes)
pnpm crawl crawler/test-sites.csv --out out/t.jsonl
pnpm merge --kind weekly out/crawl.jsonl       # write data/snapshots/weekly/<ISO week>.jsonl.gz
pnpm aggregate                                 # rebuild data/agg
pnpm backfill --only sites/marquee.txt         # Wayback history, resumable
node pipeline/catalogs.ts                      # refresh the Google Fonts / Fontshare catalog

pnpm dev                                       # site at localhost:4321
pnpm build
pnpm test
```

## Site lists

- `sites/cohorts/top-sites.csv`: the top 5,000 origins in the Chrome UX Report ([crux-top-lists](https://github.com/zakird/crux-top-lists)), folded to one registrable domain per company, adult sites removed.
- `sites/cohorts/yc.csv`: active, public and acquired Y Combinator companies ([yc-oss](https://github.com/yc-oss/api)).
- `sites/cohorts/unicorns.csv`: Wikipedia's list of unicorn startups, websites from Wikidata, plus hand additions (the `source` column says which). Not regenerated automatically; edit by hand.
- `sites/cohorts/indie.csv`: personal blogs pooled from [Kagi Small Web](https://github.com/kagisearch/smallweb), [HN Popularity Contest](https://github.com/mtlynch/hn-popularity-contest-data) and [Hacker News personal blogs](https://github.com/outcoldman/hackernews-personal-blogs), ranked by 100+ point HN stories since 2023 (via the HN Algolia API); top 1,000.
- `sites/<category>.csv`: one industry category per site. `startups.csv`, `indie.csv` and `popular.csv` are generated; the rest are hand-curated.

`pnpm lists` rebuilds the cohorts and the generated category files. A monthly workflow runs it.

## Adding sites or aliases

Add a row to a hand-curated `sites/<category>.csv` (`domain,subcategory,source,added`). If a font shows up under an odd name, add it to `pipeline/aliases.json`. `pnpm aggregate` prints the most common names that have no alias.

## Opting out

[Open an opt-out request](https://github.com/fcjr/fontsovertime/issues/new?template=opt-out.yml). To show you run the site, add a DNS TXT record containing `fontsovertime-opt-out`, or serve a plain text file at `/.well-known/fontsovertime-opt-out` containing the same text. The `opt-out` workflow checks automatically. Once verified it adds the domain to `sites/exclude.txt`, removes its rows from every published snapshot and the CSV export, and closes the issue. Earlier versions stay in git history. If neither check is possible, a maintainer can add the `approved` label instead.

## Deploying

The site is a Cloudflare Worker serving static assets (`wrangler.jsonc`), deployed by Cloudflare's GitHub integration on every push to `main`, including the crawl bot's commits. Build command: `pnpm build` (aggregates `data/snapshots` into `data/agg`, then builds `web/dist`). Deploy command: `npx wrangler deploy`. `pnpm preview` serves the built site locally with Wrangler.
