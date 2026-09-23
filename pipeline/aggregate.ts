import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeFamily, unaliased } from './normalize.ts';
import { listSnapshots, readJsonl, ROOT, type Kind, type Row } from './snapshots.ts';
import { hostOf, registrable } from './psl.ts';

const OUT = join(ROOT, 'data/agg');
const catalogPath = join(ROOT, 'pipeline/catalog.json');
const catalog: Record<string, { source: string; family: string; category: string; wght?: number[]; id?: string }> = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, 'utf8'))
  : {};
const specimen = (slug: string) => catalog[slug] ?? null;
const TOP = 24;
const CATEGORIES: Record<string, { name: string; blurb: string }> = {
  startups: { name: 'Startups', blurb: 'Y Combinator companies and unicorns that don’t belong to another category.' },
  saas: { name: 'SaaS', blurb: 'Business software, where the neo-grotesque has held the line for a decade.' },
  devtools: { name: 'Developer tools', blurb: 'Languages, frameworks and the platforms developers ship on.' },
  news: { name: 'News', blurb: 'Newspapers and news sites, the last stronghold of the custom serif.' },
  ecommerce: { name: 'E-commerce', blurb: 'Retailers and direct-to-consumer brands.' },
  enterprise: { name: 'Enterprise', blurb: 'Fortune 500 and the largest companies in the world.' },
  government: { name: 'Government', blurb: 'Federal, state and national government sites.' },
  universities: { name: 'Universities', blurb: 'Research universities and colleges.' },
  indie: { name: 'Indie blogs', blurb: 'Personal sites and one-person publications, ranked by how often they reach the Hacker News front page.' },
  popular: { name: 'Popular sites', blurb: 'Heavily visited sites that don’t fit another category: media, tools, forums and portals.' },
};
const COHORTS: Record<string, { name: string; blurb: string }> = {
  'top-1k': { name: 'Top 1,000', blurb: 'The thousand most visited sites on the web, ranked by Chrome’s own traffic data.' },
  'top-5k': { name: 'Top 5,000', blurb: 'The five thousand most visited sites, one entry per company.' },
  yc: { name: 'Y Combinator', blurb: 'Every active, public and acquired Y Combinator company with a website.' },
  unicorns: { name: 'Unicorns', blurb: 'Private companies valued at a billion dollars or more.' },
};
const PARKED = /domain (name )?(is |may be )?for sale|buy this domain|this domain (is|has been|may be) (parked|for sale|registered)|parked (free|domain)|hugedomains|sedo domain|afternic|dan\.com|website (is )?coming soon|under construction|account (has been )?suspended|future home of/i;

type Font = { name: string; slug: string; generic: boolean };
type Obs = {
  domain: string;
  kind: Kind;
  period: string;
  date: string;
  method: string;
  body: Font | null;
  heading: Font | null;
  sources: string[];
  platform: string | null;
  raw: Row;
};
type Period = { id: string; date: string; kind: Kind; n: number };

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const fontRef = (f: Font | null) => (f ? { name: f.name, slug: f.slug, specimen: specimen(f.slug) } : null);

function loadSites() {
  const sites = new Map<string, { category: string; subcategory: string }>();
  const dir = join(ROOT, 'sites');
  if (!existsSync(dir)) return sites;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()) {
    const category = basename(file, '.csv');
    const [header, ...rows] = readFileSync(join(dir, file), 'utf8').trim().split('\n');
    const cols = header.split(',');
    for (const row of rows) {
      const f = row.split(',');
      const domain = f[cols.indexOf('domain')]?.trim().toLowerCase();
      if (domain && !sites.has(domain)) sites.set(domain, { category, subcategory: f[cols.indexOf('subcategory')]?.trim() ?? '' });
    }
  }
  return sites;
}

function quarterDate(id: string) {
  const [y, q] = id.split('-Q').map(Number);
  return `${y}-${String((q - 1) * 3 + 2).padStart(2, '0')}-15`;
}

const bare = (d: string) => d.toLowerCase().replace(/^www\./, '');
const siteMeta = loadSites();
const excludePath = join(ROOT, 'sites', 'exclude.txt');
if (existsSync(excludePath))
  for (const line of readFileSync(excludePath, 'utf8').split('\n')) {
    const d = bare(line.trim());
    if (d && !d.startsWith('#')) {
      siteMeta.delete(d);
      siteMeta.delete(`www.${d}`);
    }
  }
const cohortMembers = new Map<string, Set<string>>();
function loadCohorts() {
  const dir = join(ROOT, 'sites', 'cohorts');
  if (!existsSync(dir)) return;
  const read = (file: string) => {
    const path = join(dir, file);
    if (!existsSync(path)) return [];
    const [header, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
    const cols = header.split(',');
    return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v.trim()])));
  };
  const add = (slug: string, domain: string) => {
    const set = cohortMembers.get(slug) ?? new Set();
    set.add(bare(domain));
    cohortMembers.set(slug, set);
  };
  for (const r of read('top-sites.csv')) {
    add('top-5k', r.domain);
    if (Number(r.rank) <= 1000) add('top-1k', r.domain);
  }
  for (const r of read('yc.csv')) add('yc', r.domain);
  for (const r of read('unicorns.csv')) add('unicorns', r.domain);
}
loadCohorts();
const cohortsOf = (domain: string) => [...cohortMembers].filter(([, set]) => set.has(bare(domain))).map(([slug]) => slug);
const observations: Obs[] = [];
const periods: Period[] = [];
const blocked = new Map<string, { total: number; blocked: number }>();

for (const kind of ['wayback', 'weekly', 'daily'] as Kind[]) {
  for (const snap of listSnapshots(kind)) {
    const rows = readJsonl(snap.path);
    const ok = rows.filter((r) => r.status === 'ok' && r.body_font);
    const dates = rows.map((r) => r.crawled_at?.slice(0, 10)).filter(Boolean).sort();
    const date = kind === 'wayback' ? quarterDate(snap.id) : kind === 'daily' ? snap.id : (dates[0] ?? snap.id);
    if (kind !== 'daily') periods.push({ id: snap.id, date, kind, n: 0 });
    if (kind === 'weekly') {
      for (const r of rows) {
        for (const cat of [siteMeta.get(r.domain)?.category ?? r.category, ...cohortsOf(r.domain)]) {
          const b = blocked.get(cat) ?? { total: 0, blocked: 0 };
          b.total++;
          if (r.status !== 'ok') b.blocked++;
          blocked.set(cat, b);
        }
      }
    }
    for (const r of ok) {
      if (siteMeta.size && !siteMeta.has(r.domain)) continue;
      if (PARKED.test(r.title ?? '')) continue;
      const landed = r.final_url && hostOf(r.final_url);
      if (landed && registrable(landed) !== registrable(bare(r.domain)) && (siteMeta.has(landed) || siteMeta.has(`www.${landed}`))) continue;
      const body = normalizeFamily(r.body_font);
      if (!body || body.name === 'Unknown') continue;
      observations.push({
        domain: r.domain,
        kind,
        period: snap.id,
        date: kind === 'wayback' ? date : r.crawled_at.slice(0, 10),
        method: r.method ?? 'browser',
        body,
        heading: ((h) => (h && h.slug !== 'unknown' ? h : body))(normalizeFamily(r.heading_font)),
        sources: r.sources ?? [],
        platform: r.platform ?? null,
        raw: r,
      });
    }
  }
}

const PANEL_MIN = 40;
const panel = new Set(observations.filter((o) => o.kind === 'wayback').map((o) => o.domain));
const usePanel = panel.size >= PANEL_MIN;
const firstWeekly = periods.find((p) => p.kind === 'weekly')?.date ?? '9999';
const trendPeriods = periods
  .filter((p) => p.kind === 'weekly' || (usePanel && p.date < firstWeekly))
  .sort((a, b) => a.date.localeCompare(b.date));
const periodIndex = new Map(trendPeriods.map((p, i) => [p.id, i]));
const trendObs = observations.filter((o) => o.kind !== 'daily' && periodIndex.has(o.period) && (!usePanel || panel.has(o.domain)));
const weeklyObs = observations.filter((o) => o.kind === 'weekly');
for (const o of trendObs) trendPeriods[periodIndex.get(o.period)!].n++;

const latestWeekly = [...trendPeriods].reverse().find((p) => p.kind === 'weekly') ?? trendPeriods.at(-1);
const byDomain = new Map<string, Obs[]>();
for (const o of observations) {
  const list = byDomain.get(o.domain) ?? [];
  list.push(o);
  byDomain.set(o.domain, list);
}
for (const list of byDomain.values()) list.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'daily' ? 1 : -1));

const current = new Map<string, Obs>();
for (const [domain, list] of byDomain) {
  const live = list.filter((o) => o.kind !== 'wayback');
  const last = live.at(-1) ?? list.at(-1)!;
  current.set(domain, last);
}

const categoryOf = (domain: string, o?: Obs) => siteMeta.get(domain)?.category ?? o?.raw.category ?? 'other';
const inGroup = (domain: string, slug: string, o?: Obs) => (COHORTS[slug] ? !!cohortMembers.get(slug)?.has(bare(domain)) : categoryOf(domain, o) === slug);

type Change = { date: string; domain: string; category: string; role: 'body' | 'heading'; from: { name: string; slug: string }; to: { name: string; slug: string } };
const changes: Change[] = [];
const eligible = (f: Font | null) => !!f && (!f.generic || f.slug === 'system-ui');
for (const [domain, list] of byDomain) {
  const live = list.filter((o) => o.kind !== 'wayback' && o.method === 'browser');
  for (const role of ['body', 'heading'] as const) {
    let stable: Font | null = null;
    let candidate: Font | null = null;
    let seen = 0;
    let since = '';
    let lastDate = '';
    for (const o of live) {
      if (o.date === lastDate) continue;
      lastDate = o.date;
      const v = o[role];
      if (!eligible(v)) continue;
      if (!stable) stable = v;
      else if (v!.slug === stable.slug) candidate = null;
      else {
        if (candidate?.slug === v!.slug) seen++;
        else {
          candidate = v;
          seen = 1;
          since = o.date;
        }
        if (seen >= 2) {
          changes.push({ date: since, domain, category: categoryOf(domain, o), role, from: fontRef(stable)!, to: fontRef(v)! });
          stable = v;
          candidate = null;
        }
      }
    }
  }
}
changes.sort((a, b) => b.date.localeCompare(a.date) || a.domain.localeCompare(b.domain));

function tally(obs: Obs[], role: 'body' | 'heading') {
  const counts = new Map<string, { font: Font; count: number }>();
  for (const o of obs) {
    const f = o[role];
    if (!f) continue;
    const e = counts.get(f.slug) ?? { font: f, count: 0 };
    e.count++;
    counts.set(f.slug, e);
  }
  return counts;
}

function series(obs: Obs[], role: 'body' | 'heading', slugs: string[]) {
  const perPeriod = trendPeriods.map(() => ({ n: 0, counts: new Map<string, number>() }));
  for (const o of obs) {
    const i = periodIndex.get(o.period);
    if (i === undefined || o.kind === 'daily') continue;
    perPeriod[i].n++;
    const f = o[role];
    if (f) perPeriod[i].counts.set(f.slug, (perPeriod[i].counts.get(f.slug) ?? 0) + 1);
  }
  const result: Record<string, (number | null)[]> = {};
  for (const slug of slugs) result[slug] = perPeriod.map((p, i) => (p.n >= (trendPeriods[i].kind === 'wayback' ? 30 : 5) ? round((p.counts.get(slug) ?? 0) / p.n) : null));
  return result;
}

function ranking(currentObs: Obs[], historyObs: Obs[], role: 'body' | 'heading', limit = TOP) {
  const counts = [...tally(currentObs, role).values()].sort((a, b) => b.count - a.count || a.font.name.localeCompare(b.font.name));
  const top = counts.slice(0, limit);
  const s = series(historyObs, role, top.map((c) => c.font.slug));
  const domains = new Set(currentObs.map((o) => o.domain));
  const w = series(weeklyObs.filter((o) => domains.has(o.domain)), role, top.map((c) => c.font.slug));
  return top.map((c) => {
    const pts = s[c.font.slug];
    const weekly = w[c.font.slug].filter((p, i): p is number => p !== null && trendPeriods[i].kind === 'weekly');
    const prev = weekly.length > 1 ? weekly[Math.max(0, weekly.length - 5)] : null;
    const share = round(c.count / currentObs.length);
    return { name: c.font.name, slug: c.font.slug, specimen: specimen(c.font.slug), generic: c.font.generic, count: c.count, share, delta: prev === null ? null : round(share - prev), series: pts };
  });
}

function breakdown(values: (string | null)[]) {
  const m = new Map<string, number>();
  for (const v of values) m.set(v ?? 'none', (m.get(v ?? 'none') ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count, share: round(count / values.length) }));
}

function sourceClass(o: Obs) {
  const s = o.sources;
  if (o.body?.slug === 'system-ui') return 'system';
  if (s.includes('google')) return 'google';
  if (s.includes('adobe')) return 'adobe';
  if (s.some((x) => ['fontshare', 'bunny', 'cdnfonts', 'hoefler', 'monotype'].includes(x))) return 'foundry-cdn';
  if (s.includes('self') || s.includes('inline')) return 'self';
  return o.body?.generic || !s.length ? 'system' : 'self';
}

function pairings(obs: Obs[], limit = 20) {
  const m = new Map<string, { heading: Font; body: Font; count: number; examples: string[] }>();
  for (const o of obs) {
    if (!o.heading || !o.body || o.heading.slug === o.body.slug) continue;
    const key = `${o.heading.slug}|${o.body.slug}`;
    const e = m.get(key) ?? { heading: o.heading, body: o.body, count: 0, examples: [] };
    e.count++;
    if (e.examples.length < 6) e.examples.push(o.domain);
    m.set(key, e);
  }
  return [...m.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((e) => ({ heading: fontRef(e.heading), body: fontRef(e.body), count: e.count, share: round(e.count / obs.length), examples: e.examples }));
}

function siteRow(o: Obs) {
  return { domain: o.domain, category: categoryOf(o.domain, o), body: fontRef(o.body), heading: fontRef(o.heading), platform: o.platform, method: o.method, date: o.date };
}

function write(path: string, data: unknown) {
  const full = join(OUT, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(data));
}

rmSync(OUT, { recursive: true, force: true });
const currentObs = [...current.values()];
const liveCurrent = currentObs.filter((o) => o.kind !== 'wayback');
const baseObs = liveCurrent.length ? liveCurrent : currentObs;
const categories = [
  ...Object.keys(COHORTS).filter((slug) => cohortMembers.get(slug)?.size),
  ...[...new Set(baseObs.map((o) => categoryOf(o.domain, o)))].sort(
    (a, b) => Object.keys(CATEGORIES).indexOf(a) - Object.keys(CATEGORIES).indexOf(b),
  ),
];
const periodsOut = trendPeriods.map((p) => ({ id: p.id, date: p.date, kind: p.kind, n: p.n }));

const categoryList = categories.map((slug) => {
  const obs = baseObs.filter((o) => inGroup(o.domain, slug, o));
  const meta = COHORTS[slug] ?? CATEGORIES[slug];
  const top = [...tally(obs, 'body').values()].sort((a, b) => b.count - a.count).slice(0, 5);
  return {
    slug,
    kind: COHORTS[slug] ? 'cohort' : 'category',
    name: meta?.name ?? slug,
    blurb: meta?.blurb ?? '',
    n: obs.length,
    top: top.map((t) => ({ name: t.font.name, slug: t.font.slug, specimen: specimen(t.font.slug), share: round(t.count / obs.length) })),
    blocked: blocked.get(slug) ? round(blocked.get(slug)!.blocked / blocked.get(slug)!.total) : null,
  };
});

const allFonts = new Map<string, Font>();
for (const o of baseObs) for (const f of [o.body, o.heading]) if (f && f.slug !== 'unknown') allFonts.set(f.slug, f);

write('overview.json', {
  generated_at: new Date().toISOString(),
  latest: latestWeekly ? { id: latestWeekly.id, date: latestWeekly.date } : null,
  n_sites: baseObs.length,
  n_fonts: allFonts.size,
  n_changes: changes.length,
  periods: periodsOut,
  trend_panel: usePanel ? panel.size : null,
  body: ranking(baseObs, trendObs, 'body'),
  heading: ranking(baseObs, trendObs, 'heading', 12),
  sources: breakdown(baseObs.map(sourceClass)),
  platforms: breakdown(baseObs.map((o) => o.platform)),
  variable: round(baseObs.filter((o) => (o.raw.declared ?? []).some((d: any) => d.variable)).length / baseObs.length),
  median_font_bytes: (() => {
    const b = baseObs.map((o) => o.raw.font_bytes).filter((n) => typeof n === 'number').sort((x, y) => x - y);
    return b.length ? b[Math.floor(b.length / 2)] : null;
  })(),
  categories: categoryList,
  matrix: (() => {
    const fonts = [...tally(baseObs, 'body').values()]
      .filter((c) => !c.font.generic || c.font.slug === 'system-ui')
      .sort((a, b) => b.count - a.count)
      .slice(0, 18);
    return {
      fonts: fonts.map((c) => fontRef(c.font)),
      categories: categoryList.map((c) => ({ slug: c.slug, name: c.name })),
      values: fonts.map((c) =>
        categoryList.map((cat) => {
          const obs = baseObs.filter((o) => inGroup(o.domain, cat.slug, o));
          const n = obs.filter((o) => o.body?.slug === c.font.slug).length;
          return { share: obs.length ? round(n / obs.length) : 0, count: n };
        }),
      ),
    };
  })(),
  changes: changes.slice(0, 20),
  pairings: pairings(baseObs, 8),
});

for (const cat of categoryList) {
  const obs = baseObs.filter((o) => inGroup(o.domain, cat.slug, o));
  const catPanel = [...panel].filter((d) => inGroup(d, cat.slug)).length;
  const hist = (catPanel >= PANEL_MIN ? trendObs : weeklyObs).filter((o) => inGroup(o.domain, cat.slug, o));
  write(`category/${cat.slug}.json`, {
    ...cat,
    periods: periodsOut,
    body: ranking(obs, hist, 'body', 16),
    heading: ranking(obs, hist, 'heading', 10),
    sources: breakdown(obs.map(sourceClass)),
    platforms: breakdown(obs.map((o) => o.platform)),
    pairings: pairings(obs, 10),
    changes: changes.filter((c) => inGroup(c.domain, cat.slug)).slice(0, 30),
    sites: obs.map(siteRow).sort((a, b) => a.domain.localeCompare(b.domain)),
  });
}

const fontIndex = [];
for (const font of allFonts.values()) {
  const bodySites = baseObs.filter((o) => o.body?.slug === font.slug);
  const headingSites = baseObs.filter((o) => o.heading?.slug === font.slug);
  const using = baseObs.filter((o) => o.body?.slug === font.slug || o.heading?.slug === font.slug);
  const s = series(trendObs, 'body', [font.slug])[font.slug];
  const sh = series(trendObs, 'heading', [font.slug])[font.slug];
  const byCategory = categoryList
    .map((cat) => {
      const obs = baseObs.filter((o) => inGroup(o.domain, cat.slug, o));
      const count = obs.filter((o) => o.body?.slug === font.slug || o.heading?.slug === font.slug).length;
      return { slug: cat.slug, name: cat.name, count, share: obs.length ? round(count / obs.length) : 0 };
    })
    .filter((c) => c.count);
  const partners = new Map<string, { font: Font; count: number }>();
  for (const o of using) {
    const other = o.body?.slug === font.slug ? o.heading : o.body;
    if (!other || other.slug === font.slug) continue;
    const e = partners.get(other.slug) ?? { font: other, count: 0 };
    e.count++;
    partners.set(other.slug, e);
  }
  const firstSeen = observations.filter((o) => o.body?.slug === font.slug || o.heading?.slug === font.slug).map((o) => o.date).sort()[0];
  const entry = {
    name: font.name,
    slug: font.slug,
    generic: font.generic,
    specimen: specimen(font.slug),
    body_count: bodySites.length,
    heading_count: headingSites.length,
    sites: using.length,
    share: round(using.length / baseObs.length),
    categories: byCategory.map((c) => c.slug),
  };
  fontIndex.push(entry);
  write(`font/${font.slug}.json`, {
    ...entry,
    first_seen: firstSeen,
    periods: periodsOut,
    series: { body: s, heading: sh },
    by_category: byCategory,
    sources: breakdown(using.map(sourceClass)),
    pairs: [...partners.values()].sort((a, b) => b.count - a.count).slice(0, 10).map((p) => ({ ...fontRef(p.font), count: p.count })),
    using: using
      .map((o) => ({ ...siteRow(o), roles: [o.body?.slug === font.slug && 'body', o.heading?.slug === font.slug && 'heading'].filter(Boolean) }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
    switched_to: changes.filter((c) => c.to.slug === font.slug).slice(0, 30),
    switched_from: changes.filter((c) => c.from.slug === font.slug).slice(0, 30),
  });
}
fontIndex.sort((a, b) => b.sites - a.sites || a.name.localeCompare(b.name));
{
  const slugs = fontIndex.map((f) => f.slug);
  const body = series(trendObs, 'body', slugs);
  const heading = series(trendObs, 'heading', slugs);
  write('series.json', Object.fromEntries(slugs.map((slug) => [slug, [body[slug], heading[slug]]])));
}
write('fonts.json', fontIndex);

const unknown = [...unaliased].sort((a, b) => b[1] - a[1]).slice(0, 40);
const siteIndex = [];
for (const [domain, list] of byDomain) {
  const cur = current.get(domain)!;
  const meta = siteMeta.get(domain);
  const spans: { from: string; to: string; body: unknown; heading: unknown; method: string }[] = [];
  for (const o of list.filter((x) => x.kind !== 'daily' || x.method === 'browser')) {
    const last = spans.at(-1);
    const method = o.kind === 'wayback' ? 'wayback' : o.method;
    if (last && last.method === method && (last.body as any)?.slug === o.body?.slug && (last.heading as any)?.slug === o.heading?.slug) last.to = o.date;
    else spans.push({ from: o.date, to: o.date, body: fontRef(o.body), heading: fontRef(o.heading), method });
  }
  const r = cur.raw;
  siteIndex.push(siteRow(cur));
  write(`site/${domain}.json`, {
    ...siteRow(cur),
    subcategory: meta?.subcategory ?? null,
    cohorts: cohortsOf(domain).map((slug) => ({ slug, name: COHORTS[slug].name })),
    title: r.title ?? null,
    final_url: r.final_url ?? null,
    sources: r.sources ?? [],
    font_hosts: r.font_hosts ?? [],
    font_bytes: r.font_bytes ?? null,
    preloads: r.preloads ?? null,
    dominant: (r.dominant ?? []).map((d: any) => ({ ...d, font: fontRef(normalizeFamily(d.family)) })),
    heading_detail: (r.heading ?? []).map((d: any) => ({ ...d, font: fontRef(normalizeFamily(d.family)) })),
    declared: (r.declared ?? []).map((d: any) => ({ ...d, font: fontRef(normalizeFamily(d.family)) })),
    history: spans,
    changes: changes.filter((c) => c.domain === domain),
  });
}
siteIndex.sort((a, b) => a.domain.localeCompare(b.domain));
write('sites.json', siteIndex);
write('changes.json', changes.slice(0, 500));
write('pairings.json', { body_heading: pairings(baseObs, 60) });
write('categories.json', categoryList);

const csvEscape = (v: unknown) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = [
  'domain,category,body_font,heading_font,platform,sources,method,observed',
  ...siteIndex.map((s) => {
    const o = current.get(s.domain)!;
    return [s.domain, s.category, s.body?.name, s.heading?.name, s.platform, o.sources.join(' '), s.method, s.date].map(csvEscape).join(',');
  }),
].join('\n');
mkdirSync(join(ROOT, 'data/exports'), { recursive: true });
writeFileSync(join(ROOT, 'data/exports/latest.csv'), csv + '\n');

console.error(`aggregated ${observations.length} observations, ${byDomain.size} sites, ${allFonts.size} fonts, ${changes.length} changes`);
if (unknown.length) console.error('unaliased:', unknown.map(([n, c]) => `${n} (${c})`).join(', '));
