import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser } from 'playwright';
import { staticCrawl, USER_AGENT, type Fetcher } from '../crawler/static.ts';
import { launch, loadExtract, measurePage, withTimeout } from '../crawler/page.ts';
import { listSnapshots, readJsonl, ROOT, writeSnapshot, type Row } from './snapshots.ts';
import { normalizeFamily } from './normalize.ts';

const { values } = parseArgs({
  options: {
    years: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '3' },
    rpm: { type: 'string', default: '30' },
    'max-rpm': { type: 'string', default: '60' },
    limit: { type: 'string' },
    only: { type: 'string' },
    shard: { type: 'string', default: '0/1' },
    budget: { type: 'string', default: '0' },
    out: { type: 'string' },
    status: { type: 'string' },
    archives: { type: 'string', default: 'ia,arquivo' },
    'redo-old': { type: 'boolean', default: false },
  },
});

const started = Date.now();
const budgetMs = Number(values.budget) * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quarterOf = (ts: string) => `${ts.slice(0, 4)}-Q${Math.floor((Number(ts.slice(4, 6)) - 1) / 3) + 1}`;
const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|inherit|initial)$/i;
const TRANSIENT = /timeout|ECONN|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_HTTP2|\b5\d\d\b|site timeout/i;
const MAX_ATTEMPTS = 3;
const CACHE = join(ROOT, 'out', 'cache');
const stats = { measured: 0, inferred: 0, browser: 0, static: 0, failed: 0, alternates: 0, cssHits: 0, cssMisses: 0 };

// Request budget per archive: additive increase while healthy, halve on 429, long pause on refusal.
class Limiter {
  rpm: number;
  requests = 0;
  throttled = 0;
  refusals = 0;
  private next = 0;
  private paused = 0;
  private streak = 0;
  name: string;
  max: number;
  min: number;
  constructor(name: string, start: number, max: number, min = 6) {
    this.name = name;
    this.max = max;
    this.min = min;
    this.rpm = Math.min(start, max);
  }
  waitMs() {
    return Math.max(this.paused, this.next) - Date.now();
  }
  take = async () => {
    for (;;) {
      const now = Date.now();
      if (now < this.paused) {
        await sleep(this.paused - now);
        continue;
      }
      const slot = Math.max(this.next, now);
      this.next = slot + 60_000 / this.rpm;
      if (slot > now) await sleep(slot - now);
      this.requests++;
      if (++this.streak >= 100 && this.rpm < this.max) {
        this.rpm = Math.min(this.max, this.rpm + 2);
        this.streak = 0;
      }
      return;
    }
  };
  onThrottled = () => {
    this.throttled++;
    this.streak = 0;
    this.rpm = Math.max(this.min, Math.floor(this.rpm / 2));
    this.paused = Math.max(this.paused, Date.now() + 60_000);
    console.error(`${this.name}: 429, slowing to ${this.rpm}/min`);
  };
  onRefused = (what = '') => {
    this.refusals++;
    this.streak = 0;
    this.rpm = Math.max(this.min, Math.floor(this.rpm / 2));
    this.paused = Math.max(this.paused, Date.now() + 15 * 60_000);
    console.error(`${this.name}: connection refused${what ? ` (${what.slice(0, 160)})` : ''}, pausing 15 minutes, then ${this.rpm}/min`);
  };
}

const isRefusal = (e: unknown) =>
  /ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(String((e as Error)?.message ?? e) + String((e as { cause?: { code?: string } })?.cause?.code ?? ''));

async function get(limiter: Limiter, url: string, attempt = 0, redirect: RequestRedirect = 'follow'): Promise<Response | null> {
  await limiter.take();
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect, signal: AbortSignal.timeout(45_000) });
    if (res.status === 429 && attempt < 4) {
      limiter.onThrottled();
      return get(limiter, url, attempt + 1, redirect);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(5_000 * 2 ** attempt);
      return get(limiter, url, attempt + 1, redirect);
    }
    return res;
  } catch (e) {
    if (isRefusal(e) && attempt < 6) {
      limiter.onRefused(url);
      return get(limiter, url, attempt + 1, redirect);
    }
    if (attempt < 2) {
      await sleep(3_000);
      return get(limiter, url, attempt + 1, redirect);
    }
    return null;
  }
}

type Capture = { archive: Archive; ts: string; url: string; status: number; quarter: string };
type Archive = {
  name: string;
  host: RegExp;
  replay: Limiter;
  index: Limiter;
  cdx(domain: string, fromYear: number): Promise<{ ts: string; url: string; status: number }[] | null>;
  replayUrl(ts: string, url: string): string;
  raw?(ts: string): Fetcher;
};

async function cached<T>(key: string, maxAgeDays: number, load: () => Promise<T | null>): Promise<T | null> {
  const path = join(CACHE, 'cdx', `${key.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  if (existsSync(path)) {
    const hit = JSON.parse(readFileSync(path, 'utf8')) as { at: number; data: T };
    if (Date.now() - hit.at < maxAgeDays * 864e5) return hit.data;
  }
  const data = await load();
  if (data !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: Date.now(), data }));
  }
  return data;
}

const iaLimiter = new Limiter('ia', Number(values.rpm), Number(values['max-rpm']));
const ia: Archive = {
  name: 'ia',
  host: /^https:\/\/web\.archive\.org\//,
  replay: iaLimiter,
  index: iaLimiter,
  async cdx(domain, fromYear) {
    const res = await get(
      iaLimiter,
      `https://web.archive.org/cdx/search/cdx?url=${domain}/&output=json&fl=timestamp,original,statuscode&filter=statuscode:[23]..&filter=mimetype:text/html&from=${fromYear}&collapse=timestamp:8`,
    );
    if (res?.status === 403) return [];
    if (!res || !res.ok) return null;
    const rows = ((await res.json().catch(() => [])) as string[][]).slice(1);
    return rows.map(([ts, url, status]) => ({ ts, url, status: Number(status) }));
  },
  replayUrl: (ts, url) => `https://web.archive.org/web/${ts}if_/${url}`,
  // Follow redirects by hand and only inside the archive: an archived redirect to a live site is an unusable capture.
  raw: (ts) => async (url) => {
    let target = `https://web.archive.org/web/${ts}id_/${url}`;
    for (let hops = 0; hops < 6; hops++) {
      const res = await get(iaLimiter, target, 0, 'manual');
      if (!res) return null;
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).href;
        if (!target.startsWith('https://web.archive.org/')) return null;
        continue;
      }
      return { status: res.status, url, text: await res.text() };
    }
    return null;
  },
};

// Arquivo.pt publishes 250/min for its CDX API and 4000/min for replay, with a permanent block above that.
const arquivoIndex = new Limiter('arquivo-cdx', 30, 60);
const arquivo: Archive = {
  name: 'arquivo',
  host: /^https:\/\/arquivo\.pt\//,
  replay: new Limiter('arquivo', 120, 200),
  index: arquivoIndex,
  async cdx(domain, fromYear) {
    const res = await get(arquivoIndex, `https://arquivo.pt/wayback/cdx?url=${domain}/&output=json&from=${fromYear}&filter=status:[23]..&filter=mime:text/html`);
    if (!res) return null;
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const out: { ts: string; url: string; status: number }[] = [];
    for (const line of (await res.text()).split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const r = JSON.parse(line) as { timestamp: string; url: string; status: string };
        out.push({ ts: r.timestamp, url: r.url, status: Number(r.status) });
      } catch {}
    }
    return out;
  },
  replayUrl: (ts, url) => `https://arquivo.pt/wayback/${ts}mp_/${url}`,
};

const archives = [ia, arquivo].filter((a) => values.archives.split(',').includes(a.name));

// Content-hashed stylesheet names are shared across quarters; others only within one quarter.
const styleCache = (quarter: string) => {
  const path = (url: string) => {
    const key = /[.-][0-9a-f]{8,}\.css|[?&](v|ver|version|h|hash)=/i.test(url) ? url : `${url}@${quarter}`;
    return join(CACHE, 'css', createHash('sha1').update(key).digest('hex') + '.css');
  };
  return {
    get(url: string) {
      const p = path(url);
      if (!existsSync(p)) {
        stats.cssMisses++;
        return null;
      }
      stats.cssHits++;
      return readFileSync(p, 'utf8');
    },
    put(url: string, css: string) {
      const p = path(url);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, css);
    },
  };
};

// Sites, most visible first.
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
const readList = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : []);
const priority = new Map<string, number>();
for (const d of readList(join(ROOT, 'sites', 'marquee.txt'))) priority.set(d.trim(), 0);
for (const row of readList(join(ROOT, 'sites', 'cohorts', 'top-sites.csv')).slice(1)) {
  const [d, rank] = row.split(',');
  if (!priority.has(d)) priority.set(d, Number(rank) <= 1000 ? 1 : 2);
}
let queue = sites.sort((a, b) => (priority.get(a.domain) ?? 3) - (priority.get(b.domain) ?? 3) || a.domain.localeCompare(b.domain));
if (values.only) {
  const only = new Set(readFileSync(values.only, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  queue = queue.filter((s) => only.has(s.domain));
}
const [shardIndex, shardCount] = values.shard.split('/').map(Number);
queue = queue.filter((_, i) => i % shardCount === shardIndex);

// Done unless from the old method (with --redo-old) or a transient failure with attempts left.
const done = new Map<string, Row>();
const previousAttempts = new Map<string, number>();
for (const snap of listSnapshots('wayback'))
  for (const r of readJsonl(snap.path)) {
    const key = `${snap.id}|${r.domain}`;
    if (r.status === 'error' && r.retryable) previousAttempts.set(key, r.attempts ?? 1);
    if (values['redo-old'] && r.v !== 2) continue;
    if (r.status === 'error' && r.retryable && (r.attempts ?? 1) < MAX_ATTEMPTS) continue;
    done.set(key, r);
  }

const nowQuarter = quarterOf(new Date().toISOString().replace(/-/g, '').slice(0, 8));
const fromYear = new Date().getUTCFullYear() - Number(values.years);
const quarters: string[] = [];
for (let y = fromYear; y <= new Date().getUTCFullYear(); y++) for (let q = 1; q <= 4; q++) if (`${y}-Q${q}` < nowQuarter) quarters.push(`${y}-Q${q}`);
queue = queue.filter((s) => quarters.some((q) => !done.has(`${q}|${s.domain}`)));
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

// Up to three Internet Archive and two Arquivo.pt captures per quarter, spread across it, 200s before redirects.
function candidates(caps: Capture[]) {
  const byQuarter = new Map<string, Capture[]>();
  for (const c of caps) byQuarter.set(c.quarter, [...(byQuarter.get(c.quarter) ?? []), c]);
  const out = new Map<string, Capture[]>();
  for (const [q, list] of byQuarter) {
    const picked: Capture[] = [];
    for (const a of archives) {
      const mine = list.filter((c) => c.archive === a).sort((x, y) => Number(x.status !== 200) - Number(y.status !== 200) || x.ts.localeCompare(y.ts));
      const spread = [mine[0], mine[Math.floor(mine.length / 2)], mine.at(-1)].filter((c, i, arr): c is Capture => !!c && arr.indexOf(c) === i);
      picked.push(...spread.slice(0, a === ia ? 3 : 2));
    }
    if (picked.length) out.set(q, picked);
  }
  return out;
}

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
      queue.unshift(site);
      stop = true;
      break;
    }
    const lists = await Promise.all(archives.map(async (a) => ({ a, rows: await cached(`${a.name}/${site.domain}/${fromYear}`, 30, () => a.cdx(site.domain, fromYear)) })));
    const indexFailed = lists.some((l) => l.rows === null);
    if (indexFailed) {
      const tries = (retries.get(site.domain) ?? 0) + 1;
      retries.set(site.domain, tries);
      if (tries < 3) {
        queue.push(site);
        await sleep(30_000);
        continue;
      }
      if (lists.every((l) => l.rows === null)) {
        console.error(`giving up on ${site.domain} for now: capture index lookups failed`);
        continue;
      }
    }
    const caps: Capture[] = lists.flatMap(({ a, rows }) =>
      (rows ?? []).filter((r) => r.ts.length >= 8).map((r) => ({ archive: a, ts: r.ts, url: r.url, status: r.status, quarter: quarterOf(r.ts) })),
    );
    const byQuarter = candidates(caps);
    const baseFor = (quarter: string, c?: Capture) => ({
      v: 2,
      domain: site.domain,
      category: site.category,
      crawled_at: c
        ? `${c.ts.slice(0, 4)}-${c.ts.slice(4, 6)}-${c.ts.slice(6, 8)}T00:00:00Z`
        : `${quarter.slice(0, 4)}-${String((Number(quarter.slice(6)) - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00Z`,
      ...(c ? { wayback_ts: c.ts, archive: c.archive.name } : {}),
    });

    const todo = quarters.filter((q) => !done.has(`${q}|${site.domain}`));
    const withCaptures = todo.filter((q) => byQuarter.has(q));
    if (!indexFailed) for (const q of todo) if (!byQuarter.has(q)) record(q, { ...baseFor(q), method: 'wayback', status: 'no_capture' });

    const results = new Map<number, Row>();
    const measure = async (i: number) => {
      if (results.has(i)) return results.get(i)!;
      const q = withCaptures[i];
      const options = [...byQuarter.get(q)!].sort((a, b) => a.archive.replay.waitMs() - b.archive.replay.waitMs());
      stats.measured++;
      let row: Row | null = null;
      let lastError = '';
      for (const [k, c] of options.slice(0, MAX_ATTEMPTS).entries()) {
        if (k > 0) stats.alternates++;
        const a = c.archive;
        const m = (await withTimeout(
          getBrowser().then((b) =>
            measurePage(b, extract, [a.replayUrl(c.ts, c.url)], { step: '' }, {
              navTimeout: 90_000,
              archived: true,
              archiveHost: a.host,
              throttle: a.replay.take,
              onThrottled: a.replay.onThrottled,
              styleCache: styleCache(q),
            }),
          ),
          240_000,
        ).catch(async (e) => {
          if (isRefusal(e)) a.replay.onRefused(String((e as Error).message ?? e));
          await (browser as Browser | null)?.close().catch(() => {});
          browser = null;
          return { status: 'error', error: String((e as Error).message ?? e).split('\n')[0] };
        })) as Row;
        const defaultOnly = m.status === 'ok' && /^(times-new-roman|serif)$/.test(normalizeFamily(m.body_font)?.slug ?? '');
        if (m.status === 'ok' && !defaultOnly) {
          stats.browser++;
          row = { ...baseFor(q, c), method: 'wayback-browser', ...m };
          break;
        }
        if (a.raw) {
          const s = await staticCrawl(c.url, a.raw(c.ts)).catch(() => null);
          if (usableStatic(s) && !/^times/i.test(s!.body_font!)) {
            stats.static++;
            row = { ...baseFor(q, c), method: 'wayback', status: 'ok', ...s!, browser_error: m.error ?? (defaultOnly ? 'browser default only' : undefined) };
            break;
          }
        }
        if (defaultOnly) {
          row = { ...baseFor(q, c), method: 'wayback-browser', ...m };
          break;
        }
        if (/ERR_CONNECTION_REFUSED/.test(String(m.error))) a.replay.onRefused(String(m.error));
        lastError = String(m.error ?? (defaultOnly ? 'browser default only' : 'unusable capture'));
      }
      if (!row) {
        stats.failed++;
        const retryable = TRANSIENT.test(lastError);
        row = {
          ...baseFor(q, options[0]),
          method: 'wayback-browser',
          status: 'error',
          error: lastError,
          ...(retryable ? { retryable: true, attempts: (previousAttempts.get(`${q}|${site.domain}`) ?? 0) + 1 } : {}),
        };
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
          const c = byQuarter.get(withCaptures[i])![0];
          results.set(i, { ...source, ...baseFor(withCaptures[i], c), inferred: true, inferred_from: [source.wayback_ts, results.get(hi)!.wayback_ts] });
        }
        return;
      }
      const mid = Math.floor((lo + hi) / 2);
      await bisect(lo, mid);
      await bisect(mid, hi);
    };
    if (withCaptures.length) {
      await measure(0);
      if (withCaptures.length > 1) {
        await measure(withCaptures.length - 1);
        await bisect(0, withCaptures.length - 1);
      }
    }
    let ok = 0;
    for (const [i, row] of results) {
      if (row.status === 'ok') ok++;
      record(withCaptures[i], row);
    }
    processed++;
    const rates = archives.map((a) => `${a.name} ${a.replay.rpm}/min`).join(', ');
    console.error(`[${processed}/${total}] ${site.domain.padEnd(28)} ${ok}/${withCaptures.length} quarters  (${rates})`);
    if (processed % 10 === 0) flush();
  }
  await (browser as Browser | null)?.close().catch(() => {});
}

// Stop cleanly on SIGTERM/SIGINT (systemd stop, timeouts): save what's measured and exit.
let exiting = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (exiting) return;
    exiting = true;
    console.error(`${signal}: saving progress and exiting`);
    stop = true;
    flush();
    process.exit(0);
  });

await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
flush();

const minutes = (Date.now() - started) / 60_000;
const perHour = processed / Math.max(minutes / 60, 1 / 60);
const remaining = total - processed;
const report = {
  updated: new Date().toISOString(),
  from: `${fromYear}-Q1`,
  sites_remaining: remaining,
  eta_hours: processed ? Math.round(remaining / perHour) : null,
  run: {
    minutes: Math.round(minutes),
    sites: processed,
    sites_per_hour: Math.round(perHour),
    ...stats,
    css_cache_hit_rate: stats.cssHits + stats.cssMisses ? Math.round((stats.cssHits / (stats.cssHits + stats.cssMisses)) * 100) / 100 : null,
  },
  archives: Object.fromEntries(
    [...new Set(archives.flatMap((a) => [a.replay, a.index]))].map((l) => [l.name, { rpm: l.rpm, requests: l.requests, throttled: l.throttled, refusals: l.refusals }]),
  ),
};
if (values.status) {
  mkdirSync(dirname(values.status), { recursive: true });
  writeFileSync(values.status, JSON.stringify(report, null, 2) + '\n');
}
console.error('done', report);
