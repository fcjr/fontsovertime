import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { staticCrawl } from './static.ts';
import { launch, loadExtract, measurePage, sourceOf, withTimeout } from './page.ts';

type Site = { domain: string; category: string };
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shard: { type: 'string', default: '0/1' },
    out: { type: 'string', default: 'out/crawl.jsonl' },
    concurrency: { type: 'string', default: '5' },
    limit: { type: 'string' },
    only: { type: 'string' },
  },
});

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
  const s = await staticCrawl(`https://${site.domain}/`).catch(() => null);
  if (!s || s.http_status >= 400 || !s.body_font || GENERIC.test(s.body_font)) return null;
  return {
    domain: site.domain,
    category: site.category,
    crawled_at: new Date().toISOString(),
    method: 'static',
    status: 'ok',
    browser_status: failed.status,
    browser_error: failed.error,
    ...s,
    sources: [...new Set(s.font_hosts.map((h) => (h === 'inline' ? 'inline' : sourceOf(`https://${h}/`))))].sort(),
  };
}

async function crawlSite(browser: Awaited<ReturnType<typeof launch>>, extract: string, site: Site, progress: { step: string }) {
  const base = { domain: site.domain, category: site.category, crawled_at: new Date().toISOString(), method: 'browser' };
  const urls = [`https://${site.domain}/`];
  if (!site.domain.startsWith('www.')) urls.push(`https://www.${site.domain}/`);
  return { ...base, ...(await measurePage(browser, extract, urls, progress)) };
}

const [shardIndex, shardCount] = values.shard.split('/').map(Number);
const files = positionals.length ? positionals : ['sites'];
let sites = await loadSites(files);
if (values.only) {
  const only = new Set((await readFile(values.only, 'utf8')).split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean));
  sites = sites.filter((s) => only.has(s.domain));
}
if (values.limit) sites = sites.slice(0, Number(values.limit));
sites = sites.filter((_, i) => i % shardCount === shardIndex);

const extract = await loadExtract();

await mkdir(dirname(values.out), { recursive: true });
const out = createWriteStream(values.out);
const counts: Record<string, number> = {};
const queue = [...sites];
let done = 0;

async function worker() {
  let browser = await launch();
  for (let site = queue.shift(); site; site = queue.shift()) {
    const progress = { step: 'start' };
    let result: { status: string; error?: string } = await withTimeout(crawlSite(browser, extract, site, progress), SITE_TIMEOUT).catch(async (e) => {
      const timedOut = String(e.message).startsWith('site timeout');
      if (timedOut || !browser.isConnected()) {
        await withTimeout(browser.close(), 10_000).catch(() => {});
        browser = await launch();
      }
      return {
        domain: site.domain,
        category: site.category,
        crawled_at: new Date().toISOString(),
        method: 'browser',
        status: timedOut ? 'timeout' : 'error',
        error: `${String(e.message ?? e).split('\n')[0]} (during ${progress.step})`,
      };
    });
    if (result.status !== 'ok') result = (await staticFallback(site, result)) ?? result;
    out.write(JSON.stringify(result) + '\n');
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    done++;
    const font = 'body_font' in result ? result.body_font : '';
    console.error(`[${done}/${sites.length}] ${result.status.padEnd(10)} ${site.domain.padEnd(28)} ${font ?? ''}`);
  }
  await browser.close();
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
out.end();
console.error(`done in ${Math.round((Date.now() - t0) / 1000)}s`, counts);
