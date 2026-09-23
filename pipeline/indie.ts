import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hostOf } from './psl.ts';
import { ROOT } from './snapshots.ts';

const { values } = parseArgs({ options: { top: { type: 'string', default: '1000' }, since: { type: 'string', default: '2023-01-01' } } });

const UA = { 'user-agent': 'fontsovertime-sitelist/1.0' };
const SHARED = /^(medium\.com|substack\.com|github\.com|twitter\.com|x\.com|youtube\.com|wordpress\.com|blogspot\.com|tumblr\.com|linkedin\.com|dev\.to|hashnode\.dev|notion\.site|reddit\.com)$/;

async function text(url: string) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

const sources = new Map<string, Set<string>>();
const add = (host: string | null, source: string) => {
  if (!host || SHARED.test(host) || !host.includes('.')) return;
  const set = sources.get(host) ?? new Set();
  set.add(source);
  sources.set(host, set);
};

const userDirs = new Set<string>();
for (const line of (await text('https://raw.githubusercontent.com/kagisearch/smallweb/main/smallweb.txt')).split('\n')) {
  const url = line.trim();
  if (/\/~/.test(url)) userDirs.add(hostOf(url)!);
  else add(hostOf(url), 'kagi-smallweb');
}

const meta = (await text('https://raw.githubusercontent.com/mtlynch/hn-popularity-contest-data/master/data/domains-meta.csv')).split('\n').slice(1);
for (const line of meta) add(hostOf(line.split(',')[0]?.trim() ?? ''), 'hn-popularity');

const opml = await text('https://raw.githubusercontent.com/outcoldman/hackernews-personal-blogs/master/list.opml');
for (const m of opml.matchAll(/htmlUrl="([^"]+)"/g)) add(hostOf(m[1]), 'hn-personal-blogs');

const excludes = new Set(
  (await text('https://raw.githubusercontent.com/mtlynch/hn-popularity-contest-data/master/data/excludes.txt'))
    .split('\n')
    .map((l) => hostOf(l.trim()))
    .filter(Boolean),
);
for (const host of [...excludes, ...userDirs]) sources.delete(host!);

const stories = new Map<string, { count: number; points: number }>();
const DAY = 86400;
const start = Math.floor(Date.parse(values.since) / 1000);
const end = Math.floor(Date.now() / 1000);
let fetched = 0;
for (let t = start; t < end; t += 14 * DAY) {
  const params = new URLSearchParams({
    tags: 'story',
    hitsPerPage: '1000',
    numericFilters: `points>=100,created_at_i>=${t},created_at_i<${Math.min(t + 14 * DAY, end)}`,
    attributesToRetrieve: 'url,points',
  });
  const res = await fetch(`https://hn.algolia.com/api/v1/search_by_date?${params}`, { headers: UA });
  if (!res.ok) throw new Error(`hn: ${res.status}`);
  const data = (await res.json()) as { hits: { url?: string; points: number }[]; nbHits: number };
  if (data.nbHits > 1000) console.error(`warning: window ${new Date(t * 1000).toISOString().slice(0, 10)} truncated (${data.nbHits})`);
  for (const h of data.hits) {
    const host = h.url && hostOf(h.url);
    if (!host || !sources.has(host)) continue;
    const s = stories.get(host) ?? { count: 0, points: 0 };
    s.count++;
    s.points += h.points;
    stories.set(host, s);
  }
  fetched += data.hits.length;
  await new Promise((r) => setTimeout(r, 250));
}

const ranked = [...stories]
  .sort((a, b) => b[1].count - a[1].count || b[1].points - a[1].points)
  .slice(0, Number(values.top));

mkdirSync(join(ROOT, 'sites', 'cohorts'), { recursive: true });
writeFileSync(
  join(ROOT, 'sites', 'cohorts', 'indie.csv'),
  ['domain,hn_stories,hn_points,source', ...ranked.map(([host, s]) => [host, s.count, s.points, [...sources.get(host)!].join(' ')].join(','))].join('\n') + '\n',
);
console.error(
  `indie: ${sources.size} blogs in the pool, ${stories.size} with a 100+ point HN story since ${values.since} (${fetched} stories scanned); wrote ${ranked.length}, cutoff ${ranked.at(-1)?.[1].count ?? 0} stories`,
);
