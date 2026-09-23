import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { hostOf, registrable, updatePsl } from './psl.ts';
import { ROOT } from './snapshots.ts';

const { values } = parseArgs({ options: { top: { type: 'string', default: '5000' }, 'skip-psl': { type: 'boolean', default: false } } });

const SITES = join(ROOT, 'sites');
const COHORTS = join(SITES, 'cohorts');
const GENERATED = new Set(['startups', 'popular', 'indie']);
const today = new Date().toISOString().slice(0, 10);
const ADULT = /(porn|xxx|sex|hentai|nsfw|(?<!jeu)xvideo|xnxx|xhamster|redtube|youporn|onlyfans|chaturbate|stripchat|livejasmin|bongacams|camsoda|cam4|erotic|nude|fetish|milf|escort|brazzers|spankbang|eporner|rule34|javhd|fap)/;
const clean = (s: string) => s.replace(/[,\r\n]+/g, ' ').trim();
const bare = (d: string) => d.toLowerCase().replace(/^www\./, '');

async function fetchText(url: string, gz = false) {
  const res = await fetch(url, { headers: { 'user-agent': 'fontsovertime-sitelist/1.0' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return gz ? gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8') : res.text();
}

function writeCsv(path: string, header: string, rows: string[][]) {
  writeFileSync(path, [header, ...rows.map((r) => r.map(clean).join(','))].join('\n') + '\n');
}

if (!values['skip-psl']) await updatePsl();

const excludePath = join(SITES, 'exclude.txt');
const excluded = new Set(
  existsSync(excludePath)
    ? readFileSync(excludePath, 'utf8')
        .split('\n')
        .map((l) => bare(l.trim()))
        .filter((l) => l && !l.startsWith('#'))
    : [],
);

const curated = new Map<string, string>();
for (const file of readdirSync(SITES).filter((f) => f.endsWith('.csv')).sort()) {
  const category = basename(file, '.csv');
  if (GENERATED.has(category)) continue;
  const [header, ...rows] = readFileSync(join(SITES, file), 'utf8').trim().split('\n');
  const di = header.split(',').indexOf('domain');
  for (const row of rows) {
    const d = row.split(',')[di]?.trim();
    if (d && !curated.has(bare(d))) curated.set(bare(d), category);
  }
}

const adultHosts = new Set(
  (await fetchText('https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts').catch(() => ''))
    .split('\n')
    .filter((l) => l.startsWith('0.0.0.0 '))
    .map((l) => bare(l.split(/\s+/)[1] ?? '')),
);
const isAdult = (d: string, host = d) => !/\.(gov|edu|mil)(\.[a-z]{2})?$/.test(d) && (ADULT.test(d) || adultHosts.has(d) || adultHosts.has(host));

const crux = (await fetchText('https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz', true)).trim().split('\n').slice(1);
const limit = Number(values.top);
const bestByDomain = new Map<string, number>();
let adultDropped = 0;
for (const line of crux) {
  const [origin, rankStr] = line.split(',');
  const rank = Number(rankStr);
  if (rank > limit) continue;
  const host = hostOf(origin);
  const domain = host && registrable(host);
  if (!domain) continue;
  if (isAdult(domain, host!)) {
    adultDropped++;
    continue;
  }
  if (!bestByDomain.has(domain) || rank < bestByDomain.get(domain)!) bestByDomain.set(domain, rank);
}

const suffixOf = (d: string) => d.split('.').slice(1).join('.');
const labelOf = (d: string) => d.split('.')[0];
const byLabel = new Map<string, string[]>();
for (const d of bestByDomain.keys()) {
  const list = byLabel.get(labelOf(d)) ?? [];
  list.push(d);
  byLabel.set(labelOf(d), list);
}
const top: [string, number][] = [];
let collapsed = 0;
for (const [label, domains] of byLabel) {
  if (label.length < 4 || domains.length === 1) {
    for (const d of domains) top.push([d, bestByDomain.get(d)!]);
    continue;
  }
  domains.sort((a, b) => bestByDomain.get(a)! - bestByDomain.get(b)! || Number(suffixOf(b) === 'com') - Number(suffixOf(a) === 'com'));
  top.push([domains[0], bestByDomain.get(domains[0])!]);
  collapsed += domains.length - 1;
}
top.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

const yc = JSON.parse(await fetchText('https://yc-oss.github.io/api/companies/all.json')) as {
  name: string;
  website?: string;
  batch?: string;
  status?: string;
}[];
const ycRows = new Map<string, string[]>();
for (const c of yc) {
  if (!['Active', 'Public', 'Acquired'].includes(c.status ?? '')) continue;
  const host = c.website && hostOf(c.website);
  const domain = host && registrable(host);
  if (!domain || ycRows.has(domain) || /^(ycombinator|google|apple|github|linkedin|facebook|twitter|x|medium|notion|substack)\.com$/.test(domain)) continue;
  ycRows.set(domain, [domain, c.name, (c.batch ?? '').toLowerCase().replace(/\s+/g, '-'), (c.status ?? '').toLowerCase()]);
}

const unicornPath = join(COHORTS, 'unicorns.csv');
const unicorns = new Map<string, string>();
if (existsSync(unicornPath)) {
  const [header, ...rows] = readFileSync(unicornPath, 'utf8').trim().split('\n');
  const cols = header.split(',');
  for (const row of rows) {
    const f = row.split(',');
    const d = bare(f[cols.indexOf('domain')] ?? '');
    if (d) unicorns.set(d, f[cols.indexOf('name')] ?? '');
  }
}

mkdirSync(COHORTS, { recursive: true });
writeCsv(
  join(COHORTS, 'top-sites.csv'),
  'domain,rank',
  top.map(([d, r]) => [d, String(r)]),
);
writeCsv(join(COHORTS, 'yc.csv'), 'domain,name,batch,status', [...ycRows.values()]);

const startups: string[][] = [];
const taken = new Set([...curated.keys(), ...excluded]);
for (const [d, [, , batch, status]] of ycRows) {
  if (taken.has(d)) continue;
  taken.add(d);
  startups.push([d, status === 'acquired' ? `${batch} acquired` : batch, 'yc', today]);
}
for (const [d] of unicorns) {
  if (taken.has(d)) continue;
  taken.add(d);
  startups.push([d, 'unicorn', 'unicorn', today]);
}
const indiePath = join(COHORTS, 'indie.csv');
const indie: string[][] = [];
if (existsSync(indiePath)) {
  const [header, ...rows] = readFileSync(indiePath, 'utf8').trim().split('\n');
  const cols = header.split(',');
  for (const row of rows) {
    const f = row.split(',');
    const d = bare(f[cols.indexOf('domain')] ?? '');
    if (!d || taken.has(d)) continue;
    taken.add(d);
    indie.push([d, `hn-${f[cols.indexOf('hn_stories')]}`, 'indie', today]);
  }
}
const popular: string[][] = [];
for (const [d, rank] of top) {
  if (taken.has(d)) continue;
  taken.add(d);
  popular.push([d, rank <= 1000 ? 'top-1k' : 'top-5k', 'crux', today]);
}
writeCsv(join(SITES, 'startups.csv'), 'domain,subcategory,source,added', startups);
writeCsv(join(SITES, 'popular.csv'), 'domain,subcategory,source,added', popular);
writeCsv(join(SITES, 'indie.csv'), 'domain,subcategory,source,added', indie);

console.error(
  [
    `top sites: ${top.length} (${top.filter(([, r]) => r <= 1000).length} in top 1k), ${adultDropped} adult origins dropped, ${collapsed} country duplicates collapsed`,
    `yc: ${ycRows.size} companies with domains`,
    `unicorns: ${unicorns.size}`,
    `startups.csv: ${startups.length}, indie.csv: ${indie.length}, popular.csv: ${popular.length}, curated: ${curated.size}`,
    `total sites: ${taken.size}`,
  ].join('\n'),
);
