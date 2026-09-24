import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostOf } from './psl.ts';
import { isoWeek, ROOT, weekStart } from './snapshots.ts';

// The week's top stories by points, as a crawl list of article URLs. Prints the week id.
const { values } = parseArgs({
  options: { week: { type: 'string' }, top: { type: 'string', default: '1000' }, out: { type: 'string', default: 'out/hn-list.json' } },
});

const DAY = 86400_000;
const week = values.week ?? isoWeek(new Date(Date.now() - 7 * DAY));
const start = weekStart(week);
const end = start + 7 * DAY;

const SKIP_HOSTS = /^(news\.ycombinator\.com)$/;
const NOT_A_PAGE = /\.(pdf|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|zip|gz|tar|txt|csv|json|xml)(\?|#|$)/i;
const excludePath = join(ROOT, 'sites', 'exclude.txt');
const excluded = new Set(
  (existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '')
    .split('\n')
    .map((l) => l.trim().toLowerCase().replace(/^www\./, ''))
    .filter((l) => l && !l.startsWith('#')),
);

type Hit = { objectID: string; url?: string; title: string; points: number };
const hits = new Map<string, Hit>();

// Algolia returns at most 1,000 hits per query, so split any window that has more.
async function collect(from: number, to: number) {
  const params = new URLSearchParams({
    tags: 'story',
    hitsPerPage: '1000',
    numericFilters: `points>=2,created_at_i>=${Math.floor(from / 1000)},created_at_i<${Math.floor(to / 1000)}`,
    attributesToRetrieve: 'objectID,url,title,points',
  });
  const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`, { headers: { 'user-agent': 'fontsovertime-hn/1.0' } });
  if (!res.ok) throw new Error(`hn: ${res.status}`);
  const data = (await res.json()) as { hits: Hit[]; nbHits: number };
  if (data.nbHits > data.hits.length && to - from > 60_000) {
    const mid = from + Math.floor((to - from) / 2);
    await collect(from, mid);
    await collect(mid, to);
    return;
  }
  for (const h of data.hits) hits.set(h.objectID, h);
  await new Promise((r) => setTimeout(r, 250));
}

for (let t = start; t < end; t += DAY) await collect(t, t + DAY);

const list = [...hits.values()]
  .filter((h) => h.url && /^https?:\/\//.test(h.url) && !NOT_A_PAGE.test(h.url))
  .map((h) => ({ h, domain: hostOf(h.url!) }))
  .filter(({ domain }) => domain && !SKIP_HOSTS.test(domain) && !excluded.has(domain))
  .sort((a, b) => b.h.points - a.h.points)
  .slice(0, Number(values.top))
  .map(({ h, domain }) => ({ domain: domain!, category: 'hacker-news', url: h.url!, hn_id: Number(h.objectID), hn_points: h.points, hn_title: h.title }));

mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, JSON.stringify(list, null, 1) + '\n');
console.error(`${week}: ${hits.size} stories, ${list.length} articles listed (lowest ${list.at(-1)?.hn_points ?? 0} points)`);
console.log(week);
