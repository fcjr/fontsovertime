# Development

## Layout

```
deploy/           crawl server setup, job runner and systemd timers
sites/            one CSV per industry category, cohorts/ (top sites, YC, unicorns), marquee.txt for the daily crawl
crawler/          Playwright crawler (crawl.ts), in-page extractor (extract.js), static CSS fallback (static.ts)
pipeline/         merge shards, normalize names (aliases.json), aggregate, Wayback backfill
data/snapshots/   weekly/, daily/, hn/ and wayback/ crawls as gzipped JSON Lines
data/exports/     latest.csv, one row per site (linked from the site's data page)
data/runs/        a summary of every crawl and the backfill's progress
data/agg/         precomputed JSON the site is built from (not committed)
web/              Astro site
```

## Running it

You need Node 24 or newer and pnpm.

```sh
pnpm install
pnpm exec playwright install chromium

pnpm crawl sites --out out/crawl.jsonl         # crawl every list
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

- `sites/cohorts/top-sites.csv` holds the top 5,000 origins in the Chrome UX Report ([crux-top-lists](https://github.com/zakird/crux-top-lists)), folded to one registrable domain per company, with adult sites removed.
- `sites/cohorts/yc.csv` holds active, public and acquired Y Combinator companies from [yc-oss](https://github.com/yc-oss/api).
- `sites/cohorts/unicorns.csv` comes from Wikipedia's list of unicorn startups, with websites from Wikidata, plus hand additions. The `source` column says which. Nothing regenerates it, so edit it by hand.
- `sites/cohorts/indie.csv` pools personal blogs from [Kagi Small Web](https://github.com/kagisearch/smallweb), [HN Popularity Contest](https://github.com/mtlynch/hn-popularity-contest-data) and [Hacker News personal blogs](https://github.com/outcoldman/hackernews-personal-blogs). It keeps the top 1,000, ranked by Hacker News stories with 100+ points since 2023 (from the HN Algolia API).
- `sites/<category>.csv` assigns each site one industry category. The scripts generate `startups.csv`, `indie.csv` and `popular.csv`. People curate the rest by hand.

`pnpm lists` rebuilds the cohorts and the generated category files. The `lists` workflow runs it on the first of each month.

To add a site, add a row (`domain,subcategory,source,added`) to a hand-curated `sites/<category>.csv`. If a font shows up under an odd name, add it to `pipeline/aliases.json`. `pnpm aggregate` prints the most common names that have no alias yet.

## Opt-outs

The `opt-out` workflow handles opt-out issues. Once it verifies the DNS record or the `.well-known` file, it adds the domain to `sites/exclude.txt`, removes the domain's rows from every published snapshot and from the CSV export, and closes the issue. If the owner can't do either check, a maintainer adds the `approved` label to the issue instead.

## Crawl server

The weekly, daily, Hacker News and archive backfill jobs run on one small Linux server. Ubuntu 24.04 or newer with 4 vCPUs and 8 GB is plenty. On x86-64 it uses Google Chrome, and Playwright's Chromium elsewhere.

1. As root, run `DEPLOY_PUBKEY="ssh-ed25519 ..." bash deploy/setup.sh`, or pipe it from GitHub. The first run prints the server's own deploy key. Add it to the repo with write access and run the script again.
2. Settings live in `/etc/fontsovertime.env`. They cover the residential proxy URL, the proxy bandwidth cap per run, crawl concurrency and optional healthchecks.io URLs.
3. The weekly crawl runs on Sundays and the daily one Monday to Saturday, both at 03:00 UTC. The Hacker News crawl runs on Tuesdays at 12:00 UTC, and the backfill every six hours until it runs out of work. `systemctl list-timers 'fontsovertime-*'` lists the timers and `journalctl -u 'fontsovertime@*'` shows the logs.

Each crawl visits every site directly and retries timeouts. Then it retries sites that blocked the server, this time through the proxy. It skips the proxy for sites whose robots.txt disallows all crawlers, and stops using it once it reaches `PROXY_MAX_MB`. The backfill never uses the proxy.

The backfill reads quarterly copies of each homepage from the Internet Archive and Arquivo.pt, going back 10 years by default. Each archive gets its own request budget. The Internet Archive's starts at 30 requests a minute and rises to at most 60 while it returns no errors. Arquivo.pt's stays far below its published limits. The backfill measures only the quarters it needs to find when fonts changed. It caches capture lists and stylesheets on disk, tries other copies from the same quarter when one is unusable, and retries temporary failures on later runs. It writes progress and an estimated finish time to `data/runs/backfill-status.json`.

## How crawl data reaches main

The server can't push to `main`. A ruleset lets only the repository admin update it. Each job pushes its data to its own `crawl/<time>-<job>` branch instead. `crawl-pushed.yml` notices the push and wakes `promote-data.yml`, which also runs hourly in case it missed one. Because it always runs `main`'s copy of `.github/promote-data.sh`, the server can't change what it does.

The script replays each branch onto `main`. It rejects a branch that changes anything other than regular files under `data/`, deletes a file, contains a merge or conflicts with `main`. `pipeline/check-data.ts` then parses every changed JSON and JSON Lines file. Rejected branches stay where they are and the workflow fails, so check them by hand.

`promote-data`, `lists` and `opt-out` push to `main` with `MAIN_PUSH_TOKEN`. That's a fine-grained token with contents write access to this repo only, stored in the `main-writer` environment, which only `main` can use.

## Deploys

Pushes that touch the crawler, pipeline or deploy files run the tests, then `deploy-scraper.yml`. It connects to the server as the `deploy` user, whose key can only run `deploy/deploy.sh`. That script updates the checkouts, Chrome, Playwright's browser and the systemd units. A job already running picks up new code on its next run. The repository secrets are `SCRAPER_SSH_KEY`, `SCRAPER_KNOWN_HOSTS` and `SCRAPER_HOST`.

The site is a Cloudflare Worker serving static assets (`wrangler.jsonc`). `deploy-site.yml` deploys it on every push to `main`, which includes promoted crawl data, site list refreshes and opt-outs. It runs `pnpm build`, which aggregates `data/snapshots` into `data/agg` and builds `web/dist`, then `wrangler deploy`. Its secrets live in the `production` environment, which only `main` can deploy to:

- `CLOUDFLARE_API_TOKEN`, with Workers Scripts edit, Account Settings read, and Workers Routes edit, DNS edit and Zone read for the site's zone
- `CLOUDFLARE_ACCOUNT_ID`

`pnpm preview` serves the built site locally with Wrangler.
