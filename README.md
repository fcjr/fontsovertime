# Fonts Over Time

[fontsovertime.com](https://fontsovertime.com) tracks which typefaces the web's homepages use.

Every Sunday we open about 11,000 homepages in a real browser and record the font that sets each one's body text and headings. A few hundred well-known sites get checked every day, so when one of them switches fonts it shows up within two days. Each week we also crawl the pages behind that week's top 1,000 Hacker News stories.

## What's on the site

- The most used body and heading fonts, and how their share has moved over time.
- Rising and falling fonts, and a log of sites that switched, also available as an [RSS feed](https://fontsovertime.com/changes.xml).
- A page for every font we've found, listing the sites that use it.
- A page for every site, with its font history.
- Breakdowns by kind of site (startups, SaaS, developer tools, news, government, universities, personal blogs and more), and for groups like the most visited sites, Y Combinator companies and unicorns.
- The heading and body pairings sites use most.
- A chart comparing up to four fonts at once.

Our crawl started in September 2026. Anything on the site dated earlier is an estimate from archived copies of the same homepages, saved by the Internet Archive and Arquivo.pt. [How it works](https://fontsovertime.com/methodology) explains what we measure and where the numbers are weak.

## Getting the data

Everything is free to download from the [data page](https://fontsovertime.com/data). `data/exports/latest.csv` has one row per site with its body font, heading font, platform and how the fonts are served. The full crawls live in `data/snapshots/` as gzipped JSON Lines. They include every font on each page, its share of the text, and the font files and their sizes.

### Data license

Copyright © 2026 Frank Chiarulli Jr.

Frank Chiarulli Jr. licenses the collected font-usage dataset (crawl snapshots in `data/snapshots/`, CSV exports in `data/exports/`, and generated font-usage aggregates in `data/agg/`) under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/), to the extent he holds the relevant rights. This permits reuse and adaptation, including commercially, under the license terms. Other contributors retain their own rights and existing notices.

See [LICENSE-DATA.md](LICENSE-DATA.md) for the exact scope, exclusions and an attribution example, and [LICENSES/CC-BY-4.0.txt](LICENSES/CC-BY-4.0.txt) for the full legal text. When attribution is required, credit Frank Chiarulli Jr. (Fonts Over Time), retain the supplied copyright and other notices, link to the project and license, and indicate changes. The license does not impose conditions on uses that do not require permission under the licensor's rights.

This data license does not cover fonts themselves, third-party website content, upstream site lists or catalogs, or the repository's source code. Existing third-party licenses and notices are unchanged; no software license is added by this notice.

## Opting out

If you run a site and don't want it tracked, [open an opt-out request](https://github.com/fcjr/fontsovertime/issues/new?template=opt-out.yml). To prove the site is yours, add a DNS TXT record containing `fontsovertime-opt-out`, or serve that same text at `/.well-known/fontsovertime-opt-out`. A workflow checks for it, removes the site from future crawls and from every published snapshot, and closes the issue. Older copies remain in git history.

If you can't do either, say so in the issue and a maintainer can approve it by hand.

## Suggesting a site or fixing a font name

Add a row to the right `sites/<category>.csv` and open a pull request. If a font shows up under an odd name, like `__Inter_a1b2c3`, add an alias to `pipeline/aliases.json`.

## Running it yourself

[docs/development.md](docs/development.md) covers running the crawler and site locally, the crawl server and how deploys work.
