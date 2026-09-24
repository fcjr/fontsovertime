import { createWriteStream, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { staticCrawl } from './static.ts';
import { launch, loadExtract, measurePage, sourceOf, withTimeout } from './page.ts';
import { robotsAllows } from './robots.ts';

type Site = { domain: string; category: string; url?: string };
const keyOf = (s: { domain: string; url?: string }) => s.url ?? s.domain;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    shard: { type: 'string', default: '0/1' },
    out: { type: 'string', default: 'out/crawl.jsonl' },
    concurrency: { type: 'string', default: '5' },
    limit: { type: 'string' },
    only: { type: 'string' },
    list: { type: 'string' },
    retry: { type: 'boolean', default: true },
  },
});

// PROXY_URL may contain {session}; each site gets its own value so a page and its assets share one exit IP.
const proxy = (() => {
  if (!process.env.PROXY_URL) return null;
  const u = new URL(process.env.PROXY_URL);
  return {
    server: `${u.protocol}//${u.host}`,
    ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
  };
})();
const stickyProxy = (p: NonNullable<typeof proxy>) => {
  const session = Math.random().toString(36).slice(2, 12);
  return {
    ...p,
    ...(p.username ? { username: p.username.replaceAll('{session}', session) } : {}),
    ...(p.password ? { password: p.password.replaceAll('{session}', session) } : {}),
  };
};
const respectRobots = process.env.PROXY_RESPECT_ROBOTS !== '0';

process.on('uncaughtException', (e) => console.error('uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e instanceof Error ? e.message : e));

const SITE_TIMEOUT = 75_000;

async function loadSites(files: string[]): Promise<Site[]> {
  const sites = new Map<string, Site>();
  const expanded: string[] = [];
  for (const f of files) {
    if (!(await stat(f)).isDirectory()) expanded.push(f);
    else expanded.push(...(await readdir(f)).filter((n) => n.endsWith('.csv')).sort().map((n) => join(f, n)));
  }
  for (const file of expanded) {
    const [header, ...rows] = (await readFile(file, 'utf8')).trim().split('\n');
    const cols = header.split(',').map((s) => s.trim());
    const di = cols.indexOf('domain');
    const ci = cols.indexOf('category');
    for (const row of rows) {
      const f = row.split(',').map((s) => s.trim());
      const domain = f[di]?.toLowerCase();
      if (!domain || domain.startsWith('#') || sites.has(domain)) continue;
      sites.set(domain, { domain, category: ci >= 0 ? f[ci] : basename(file, '.csv') });
    }
  }
  const excludePath = join(dirname(expanded[0] ?? 'sites/x'), 'exclude.txt');
  const excluded = new Set(
    (await readFile(excludePath, 'utf8').catch(() => ''))
      .split('\n')
      .map((l) => l.trim().toLowerCase().replace(/^www\./, ''))
      .filter((l) => l && !l.startsWith('#')),
  );
  return [...sites.values()].filter((s) => !excluded.has(s.domain.replace(/^www\./, ''))).sort((a, b) => a.domain.localeCompare(b.domain));
}

const GENERIC = /^(serif|sans-serif|monospace|system-ui|cursive|fantasy)$/i;

async function staticFallback(site: Site, failed: { status: string; error?: string }) {
  const s = await staticCrawl(site.url ?? `https://${site.domain}/`).catch(() => null);
  if (!s || s.http_status >= 400 || !s.body_font || GENERIC.test(s.body_font)) return null;
  return {
    ...site,
    crawled_at: new Date().toISOString(),
    method: 'static',
    status: 'ok',
    browser_status: failed.status,
    browser_error: failed.error,
    ...s,
    sources: [...new Set(s.font_hosts.map((h) => (h === 'inline' ? 'inline' : sourceOf(`https://${h}/`))))].sort(),
  };
}

type Opts = { proxy?: NonNullable<typeof proxy>; navTimeout?: number };

async function crawlSite(browser: Awaited<ReturnType<typeof launch>>, extract: string, site: Site, progress: { step: string }, opts: Opts) {
  const base = { ...site, crawled_at: new Date().toISOString(), method: 'browser' };
  const urls = site.url ? [site.url] : [`https://${site.domain}/`];
  if (!site.url && !site.domain.startsWith('www.')) urls.push(`https://www.${site.domain}/`);
  if (!site.url) urls.push(`http://${site.domain}/`);
  return { ...base, ...(await measurePage(browser, extract, urls, progress, opts.proxy ? { ...opts, proxy: stickyProxy(opts.proxy) } : opts)) };
}

const [shardIndex, shardCount] = values.shard.split('/').map(Number);
const files = positionals.length ? positionals : ['sites'];
let sites: Site[] = values.list ? JSON.parse(await readFile(values.list, 'utf8')) : await loadSites(files);
if (values.only) {
  const only = new Set((await readFile(values.only, 'utf8')).split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
  sites = sites.filter((s) => only.has(s.domain));
}
if (values.limit) sites = sites.slice(0, Number(values.limit));
sites = sites.filter((_, i) => i % shardCount === shardIndex);

const extract = await loadExtract();

await mkdir(dirname(values.out), { recursive: true });
const out = createWriteStream(values.out);
type Result = { domain: string; url?: string; status: string; error?: string; http_status?: number | null; body_font?: string | null; transfer_bytes?: number };

async function runPass(label: string, list: Site[], concurrency: number, opts: Opts) {
  const results = new Map<string, Result>();
  const queue = [...list];
  let done = 0;
  const worker = async () => {
    let browser = await launch();
    for (let site = queue.shift(); site; site = queue.shift()) {
      const progress = { step: 'start' };
      const result = (await withTimeout(crawlSite(browser, extract, site, progress, opts), SITE_TIMEOUT + (opts.navTimeout ?? 0)).catch(async (e) => {
        const timedOut = String(e.message).startsWith('site timeout');
        if (timedOut || !browser.isConnected()) {
          await withTimeout(browser.close(), 10_000).catch(() => {});
          browser = await launch();
        }
        return {
          ...site,
          crawled_at: new Date().toISOString(),
          method: 'browser',
          status: timedOut ? 'timeout' : 'error',
          error: `${String(e.message ?? e).split('\n')[0]} (during ${progress.step})`,
        };
      })) as Result;
      results.set(keyOf(site), result);
      out.write(JSON.stringify(result) + '\n');
      done++;
      console.error(`${label} [${done}/${list.length}] ${result.status.padEnd(10)} ${keyOf(site).slice(0, 60).padEnd(28)} ${result.body_font ?? ''}`);
    }
    await browser.close();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return results;
}

const DEAD = /ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_CERT_/;
const BOT_WALL = /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_HTTP2_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE/;
const bySite = new Map(sites.map((s) => [keyOf(s), s]));
const final = new Map<string, Result>();
const summary: Record<string, unknown> = { sites: sites.length, started: new Date().toISOString() };
const t0 = Date.now();

for (const [d, r] of await runPass('direct', sites, Number(values.concurrency), {})) final.set(d, r);

if (values.retry) {
  const retry = [...final.values()].filter((r) => (r.status === 'timeout' || r.status === 'error') && !DEAD.test(r.error ?? '')).map((r) => bySite.get(keyOf(r))!);
  summary.retried = retry.length;
  let recovered = 0;
  for (const [d, r] of await runPass('retry', retry, Math.max(1, Math.floor(Number(values.concurrency) / 2)), { navTimeout: 45_000 })) {
    if (r.status === 'ok') recovered++;
    final.set(d, r);
  }
  summary.retry_recovered = recovered;
}

if (proxy) {
  const candidates = [...final.values()].filter(
    (r) => r.status === 'blocked' || r.status === 'timeout' || (r.status === 'error' && BOT_WALL.test(r.error ?? '')),
  );
  const allowed: Site[] = [];
  let robotsSkipped = 0;
  for (const r of candidates) {
    if (respectRobots && !(await robotsAllows(r.domain))) {
      robotsSkipped++;
      final.set(keyOf(r), { ...r, error: `${r.error ?? r.status}; robots.txt disallows crawling, not retried through proxy` });
      continue;
    }
    allowed.push(bySite.get(keyOf(r))!);
  }
  const maxBytes = Number(process.env.PROXY_MAX_MB ?? 2000) * 1e6;
  let recovered = 0;
  let bytes = 0;
  let tried = 0;
  for (let i = 0; i < allowed.length && bytes < maxBytes; i += 20) {
    const batch = allowed.slice(i, i + 20);
    tried += batch.length;
    for (const [d, r] of await runPass('proxy', batch, Math.min(4, Number(values.concurrency)), { proxy, navTimeout: 45_000 })) {
      bytes += r.transfer_bytes ?? 0;
      if (r.status === 'ok') {
        recovered++;
        final.set(d, r);
      }
    }
  }
  Object.assign(summary, {
    proxy_candidates: candidates.length,
    proxy_robots_skipped: robotsSkipped,
    proxy_tried: tried,
    proxy_skipped_budget: allowed.length - tried,
    proxy_recovered: recovered,
    proxy_mb: Math.round(bytes / 1e5) / 10,
  });
}

let staticRecovered = 0;
for (const r of [...final.values()].filter((r) => r.status !== 'ok')) {
  const fallback = await staticFallback(bySite.get(keyOf(r))!, r);
  if (fallback) {
    staticRecovered++;
    final.set(keyOf(r), fallback as Result);
    out.write(JSON.stringify(fallback) + '\n');
  }
}
summary.static_recovered = staticRecovered;

out.end();
const counts: Record<string, number> = {};
for (const r of final.values()) counts[r.status] = (counts[r.status] ?? 0) + 1;
Object.assign(summary, { counts, seconds: Math.round((Date.now() - t0) / 1000), finished: new Date().toISOString() });
writeFileSync(values.out.replace(/\.jsonl$/, '') + '.summary.json', JSON.stringify(summary, null, 2) + '\n');
console.error(`done in ${summary.seconds}s`, summary);
