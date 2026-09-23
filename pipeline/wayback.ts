import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { staticCrawl, USER_AGENT, type Fetcher } from '../crawler/static.ts';
import { launch, loadExtract, measurePage, withTimeout } from '../crawler/page.ts';
import { listSnapshots, readJsonl, ROOT, writeSnapshot, type Row } from './snapshots.ts';
import { normalizeFamily } from './normalize.ts';

const { values } = parseArgs({
  options: {
    years: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '2' },
    rpm: { type: 'string', default: '30' },
    limit: { type: 'string' },
    only: { type: 'string' },
    shard: { type: 'string', default: '0/1' },
    budget: { type: 'string', default: '0' },
    out: { type: 'string' },
    browser: { type: 'string', default: 'auto' },
    'redo-old': { type: 'boolean', default: false },
  },
});

const started = Date.now();
const budgetMs = Number(values.budget) * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quarterOf = (ts: string) => `${ts.slice(0, 4)}-Q${Math.floor((Number(ts.slice(4, 6)) - 1) / 3) + 1}`;
const JS_PLATFORMS = new Set(['nextjs', 'gatsby', 'framer', 'webflow', 'wix', 'nuxt']);
const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|inherit|initial)$/i;
const stats = { captures: 0, measured: 0, inferred: 0, static: 0, browser: 0, failed: 0, throttled: 0, blocked: 0 };

// Shared request budget for everything this process asks the archive for.
let rpm = Number(values.rpm);
let nextSlot = 0;
let pausedUntil = 0;
async function take() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await sleep(pausedUntil - now);
      continue;
    }
    const slot = Math.max(nextSlot, now);
    nextSlot = slot + 60_000 / rpm;
    if (slot > now) await sleep(slot - now);
    return;
  }
}
function throttled() {
  stats.throttled++;
  rpm = Math.max(6, Math.floor(rpm / 2));
  pausedUntil = Math.max(pausedUntil, Date.now() + 60_000);
  console.error(`429 from archive; slowing to ${rpm} requests/min`);
}
function refused() {
  stats.blocked++;
  rpm = Math.max(6, Math.floor(rpm / 2));
  pausedUntil = Math.max(pausedUntil, Date.now() + 15 * 60_000);
  console.error(`archive refused connections; pausing 15 minutes, then ${rpm} requests/min`);
}
const isRefusal = (e: unknown) => /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String((e as Error)?.message ?? e) + String((e as any)?.cause?.code ?? ''));

async function get(url: string, attempt = 0): Promise<Response | null> {
  await take();
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < 4) {
      throttled();
      return get(url, attempt + 1);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(5_000 * 2 ** attempt);
      return get(url, attempt + 1);
    }
    return res;
  } catch (e) {
    if (isRefusal(e) && attempt < 6) {
      refused();
      return get(url, attempt + 1);
    }
    if (attempt < 2) {
      await sleep(3_000);
      return get(url, attempt + 1);
    }
    return null;
  }
}

const waybackFetcher =
  (ts: string): Fetcher =>
  async (url) => {
    const res = await get(`https://web.archive.org/web/${ts}id_/${url}`);
    if (!res) return null;
    return { status: res.status, url, text: await res.text() };
  };

async function captures(domain: string, fromYear: number) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${domain}/&output=json&fl=timestamp,original,digest&filter=statuscode:200&filter=mimetype:text/html&from=${fromYear}&collapse=timestamp:6`;
  const res = await get(url);
  if (res?.status === 403) return [];
  if (!res || !res.ok) return null;
  const rows = ((await res.json().catch(() => [])) as string[][]).slice(1);
  const byQuarter = new Map<string, { ts: string; original: string; digest: string }>();
  for (const [ts, original, digest] of rows) if (!byQuarter.has(quarterOf(ts))) byQuarter.set(quarterOf(ts), { ts, original, digest });
  return [...byQuarter].map(([quarter, c]) => ({ quarter, ...c }));
}

const sites: { domain: string; category: string }[] = [];
const seen = new Set<string>();
for (const file of readdirSync(join(ROOT, 'sites')).filter((f) => f.endsWith('.csv')).sort()) {
  const [header, ...rows] = readFileSync(join(ROOT, 'sites', file), 'utf8').trim().split('\n');
  const di = header.split(',').indexOf('domain');
  for (const row of rows) {
    const domain = row.split(',')[di]?.trim().toLowerCase();
    if (domain && !seen.has(domain)) {
      seen.add(domain);
      sites.push({ domain, category: basename(file, '.csv') });
    }
  }
}
let queue = sites.sort((a, b) => a.domain.localeCompare(b.domain));
if (values.only) {
  const only = new Set(readFileSync(values.only, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  queue = queue.filter((s) => only.has(s.domain));
}
const [shardIndex, shardCount] = values.shard.split('/').map(Number);
queue = queue.filter((_, i) => i % shardCount === shardIndex);

const done = new Map<string, Row>();
for (const snap of listSnapshots('wayback'))
  for (const r of readJsonl(snap.path)) if (!values['redo-old'] || r.v === 2) done.set(`${snap.id}|${r.domain}`, r);
const nowQuarter = quarterOf(new Date().toISOString().replace(/-/g, '').slice(0, 8));
const fromYear = new Date().getUTCFullYear() - Number(values.years);
queue = queue.filter((s) => {
  for (let y = fromYear; y <= new Date().getUTCFullYear(); y++)
    for (let q = 1; q <= 4; q++) {
      const id = `${y}-Q${q}`;
      if (id < nowQuarter && !done.has(`${id}|${s.domain}`)) return true;
    }
  return false;
});
if (values.limit) queue = queue.slice(0, Number(values.limit));
const total = queue.length;

const pending = new Map<string, Row[]>();
function record(quarter: string, row: Row) {
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    appendFileSync(values.out, JSON.stringify({ ...row, quarter }) + '\n');
    return;
  }
  const list = pending.get(quarter) ?? [];
  list.push(row);
  pending.set(quarter, list);
}
function flush() {
  for (const [quarter, rows] of pending) if (rows.length) writeSnapshot('wayback', quarter, rows);
  pending.clear();
}

const usableStatic = (s: Awaited<ReturnType<typeof staticCrawl>>) => !!s && s.http_status < 400 && !!s.body_font && !GENERIC.test(s.body_font);

const extract = await loadExtract();

const replay = (browser: Browser, ts: string, original: string) =>
  measurePage(browser, extract, [`https://web.archive.org/web/${ts}if_/${original}`], { step: '' }, { navTimeout: 120_000, archived: true, throttle: take, onThrottled: throttled });

let processed = 0;
let stop = false;
const retries = new Map<string, number>();
async function worker() {
  let browser: Browser | null = null;
  const getBrowser = async () => (browser ??= await launch());
  while (!stop) {
    const site = queue.shift();
    if (!site) break;
    if (budgetMs && Date.now() - started > budgetMs) {
      stop = true;
      break;
    }
    const caps = await captures(site.domain, fromYear);
    if (!caps) {
      const tries = (retries.get(site.domain) ?? 0) + 1;
      retries.set(site.domain, tries);
      if (tries < 3) queue.push(site);
      else console.error(`giving up on ${site.domain}: capture index lookups failed`);
      await sleep(30_000);
      continue;
    }
    if (!caps.length) {
      for (let y = fromYear; y <= new Date().getUTCFullYear(); y++)
        for (let q = 1; q <= 4; q++) {
          const quarter = `${y}-Q${q}`;
          if (quarter < nowQuarter && !done.has(`${quarter}|${site.domain}`))
            record(quarter, { v: 2, domain: site.domain, category: site.category, crawled_at: `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00Z`, method: 'wayback', status: 'no_capture' });
        }
      processed++;
      console.error(`[${processed}/${total}] ${site.domain.padEnd(28)} not in the archive`);
      continue;
    }
    const todo = caps.filter((c) => c.quarter < nowQuarter && !done.has(`${c.quarter}|${site.domain}`)).sort((a, b) => a.ts.localeCompare(b.ts));
    stats.captures += todo.length;
    const results = new Map<number, Row>();
    const baseFor = (c: (typeof todo)[number]) => ({
      v: 2,
      domain: site.domain,
      category: site.category,
      crawled_at: `${c.ts.slice(0, 4)}-${c.ts.slice(4, 6)}-${c.ts.slice(6, 8)}T00:00:00Z`,
      wayback_ts: c.ts,
    });
    const measure = async (i: number) => {
      if (results.has(i)) return results.get(i)!;
      const c = todo[i];
      stats.measured++;
      let row: Row;
      const m =
        values.browser === 'never'
          ? { status: 'skipped' }
          : await withTimeout(getBrowser().then((b) => replay(b, c.ts, c.original)), 200_000).catch(async (e) => {
              if (isRefusal(e)) refused();
              await (browser as Browser | null)?.close().catch(() => {});
              browser = null;
              return { status: 'error', error: String(e.message ?? e).split('\n')[0] };
            });
      const defaultOnly = m.status === 'ok' && /^(times-new-roman|serif)$/.test(normalizeFamily((m as Row).body_font)?.slug ?? '');
      const cross = defaultOnly ? await staticCrawl(c.original, waybackFetcher(c.ts)).catch(() => null) : null;
      if (defaultOnly && usableStatic(cross) && !/^times/i.test(cross!.body_font!)) {
        stats.static++;
        row = { ...baseFor(c), method: 'wayback', status: 'ok', ...cross!, browser_note: 'replay showed browser default' };
      } else if (m.status === 'ok') {
        stats.browser++;
        row = { ...baseFor(c), method: 'wayback-browser', ...m };
      } else {
        if (/ERR_CONNECTION_REFUSED/.test(String((m as { error?: string }).error))) refused();
        const st = await staticCrawl(c.original, waybackFetcher(c.ts)).catch(() => null);
        if (usableStatic(st)) {
          stats.static++;
          row = { ...baseFor(c), method: 'wayback', status: 'ok', ...st!, browser_error: (m as { error?: string }).error };
        } else {
          stats.failed++;
          row = { ...baseFor(c), method: 'wayback-browser', ...m, status: 'error' };
        }
      }
      results.set(i, row);
      return row;
    };
    const key = (r: Row) => (r.status === 'ok' ? `${normalizeFamily(r.body_font)?.slug}|${normalizeFamily(r.heading_font)?.slug}` : null);
    const bisect = async (lo: number, hi: number): Promise<void> => {
      if (hi - lo < 2) return;
      const a = key(await measure(lo));
      const b = key(await measure(hi));
      if (a && a === b) {
        const source = results.get(lo)!;
        for (let i = lo + 1; i < hi; i++) {
          if (results.has(i)) continue;
          stats.inferred++;
          results.set(i, { ...source, ...baseFor(todo[i]), inferred: true, inferred_from: [todo[lo].ts, todo[hi].ts] });
        }
        return;
      }
      const mid = Math.floor((lo + hi) / 2);
      await bisect(lo, mid);
      await bisect(mid, hi);
    };
    if (todo.length) {
      await measure(0);
      if (todo.length > 1) {
        await measure(todo.length - 1);
        await bisect(0, todo.length - 1);
      }
    }
    let ok = 0;
    for (const [i, row] of results) {
      if (row.status === 'ok') ok++;
      record(todo[i].quarter, row);
    }
    processed++;
    console.error(`[${processed}/${total}] ${site.domain.padEnd(28)} ${ok}/${caps.length} quarters  (${rpm} rpm)`);
    if (processed % 10 === 0) flush();
  }
  await (browser as Browser | null)?.close().catch(() => {});
}

await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
flush();
console.error(`done: ${processed} sites in ${Math.round((Date.now() - started) / 1000)}s, ${queue.length} remaining`, stats);
