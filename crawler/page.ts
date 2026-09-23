import { chromium, type Browser } from 'playwright';
import { readFile } from 'node:fs/promises';

type FontShare = { family: string; share: number; stack: string; weights: Record<string, number> };
type Extracted = {
  title: string;
  description: string | null;
  lang: string | null;
  platform: string | null;
  preloads: number;
  broken_css: number;
  text_chars: number;
  text_nodes: number;
  dominant: FontShare[];
  heading: FontShare[];
  declared: unknown[];
};

export type Measurement = Record<string, unknown> & { status: string; error?: string; body_font?: string | null };

const LOAD_TIMEOUT = 10_000;
const FONTS_TIMEOUT = 10_000;

const BLOCKED_TYPES = new Set(['image', 'media']);
const ARCHIVE_BLOCKED_TYPES = new Set(['image', 'media', 'script', 'font', 'xhr', 'fetch', 'websocket', 'eventsource', 'manifest', 'other']);
const BLOCKED_HOSTS =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|hotjar\.com|clarity\.ms|segment\.(com|io)|amplitude\.com|mixpanel\.com|fullstory\.com|nr-data\.net|adsrvr\.org|criteo\.(com|net)|taboola\.com|outbrain\.com|chartbeat\.(com|net)|scorecardresearch\.com|quantserve\.com|optimizely\.com|intercom\.io|intercomcdn\.com)$/;
const CHALLENGE =
  /just a moment|attention required|access denied|are you a robot|verify you are human|pardon our interruption|request unsuccessful|security check|captcha/i;
const PROVIDERS: [RegExp, string][] = [
  [/(^|\.)(fonts\.gstatic\.com|fonts\.googleapis\.com)$/, 'google'],
  [/(^|\.)typekit\.(net|com)$/, 'adobe'],
  [/(^|\.)fontshare\.com$/, 'fontshare'],
  [/(^|\.)fonts\.bunny\.net$/, 'bunny'],
  [/(^|\.)cdnfonts\.com$/, 'cdnfonts'],
  [/(^|\.)typography\.com$/, 'hoefler'],
  [/(^|\.)fonts\.(net|com)$/, 'monotype'],
];
const ARCHIVED = /^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(.+)$/;

export const unwrap = (url: string) => {
  const m = url.match(ARCHIVED);
  if (!m) return url;
  return m[1].startsWith('//') ? `https:${m[1]}` : /^https?:\/\//.test(m[1]) ? m[1] : `https://${m[1]}`;
};

export const hostname = (url: string) => {
  try {
    return new URL(unwrap(url)).hostname;
  } catch {
    return '';
  }
};

export function sourceOf(url: string) {
  if (url.startsWith('data:')) return 'inline';
  const host = hostname(url);
  return PROVIDERS.find(([re]) => re.test(host))?.[1] ?? 'self';
}

export const launch = () => chromium.launch({ channel: 'chromium' });
export const loadExtract = () => readFile(new URL('./extract.js', import.meta.url), 'utf8');

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`site timeout ${ms}ms`)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function userAgentFor(browser: Browser) {
  const major = browser.version().split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function measurePage(
  browser: Browser,
  extract: string,
  urls: string[],
  progress: { step: string },
  opts: {
    navTimeout?: number;
    archived?: boolean;
    throttle?: () => Promise<void>;
    onThrottled?: () => void;
    proxy?: { server: string; username?: string; password?: string };
  } = {},
): Promise<Measurement> {
  const started = Date.now();
  progress.step = 'context';
  const context = await browser.newContext({
    javaScriptEnabled: !opts.archived,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    userAgent: userAgentFor(browser),
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });
  try {
    const blockedTypes = opts.archived ? ARCHIVE_BLOCKED_TYPES : BLOCKED_TYPES;
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (blockedTypes.has(req.resourceType()) || BLOCKED_HOSTS.test(hostname(req.url()))) return route.abort().catch(() => {});
      if (opts.throttle && /^https?:\/\/web\.archive\.org\//.test(req.url())) await opts.throttle();
      return route.continue().catch(() => {});
    });
    const page = await context.newPage();
    if (opts.onThrottled) page.on('response', (res) => res.status() === 429 && opts.onThrottled!());
    const fontRequests: Promise<{ url: string; bytes: number }>[] = [];
    const transfers: Promise<number>[] = [];
    page.on('requestfinished', (req) => {
      if (opts.proxy)
        transfers.push(
          req
            .sizes()
            .then((s) => s.requestHeadersSize + s.requestBodySize + s.responseHeadersSize + s.responseBodySize)
            .catch(() => 0),
        );
      if (req.resourceType() !== 'font') return;
      fontRequests.push(
        req
          .sizes()
          .then((s) => ({ url: req.url(), bytes: s.responseBodySize }))
          .catch(() => ({ url: req.url(), bytes: 0 })),
      );
    });

    progress.step = 'goto';
    let response = null;
    let navError: unknown;
    for (const url of urls) {
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeout ?? 30_000 });
        navError = undefined;
        break;
      } catch (e) {
        navError = e;
      }
    }
    if (navError) {
      const message = String((navError as Error).message ?? navError).split('\n')[0];
      return { status: /timeout/i.test(message) ? 'timeout' : 'error', error: message, ms: Date.now() - started };
    }

    progress.step = 'load';
    await page.waitForLoadState('load', { timeout: LOAD_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(1000);
    progress.step = 'fonts';
    const fontsReady = await page.evaluate(
      (ms) => Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]),
      FONTS_TIMEOUT,
    );
    progress.step = 'extract';
    if (opts.archived) await page.evaluate('window.__fotIntended = true').catch(() => {});
    let data: Extracted | undefined;
    for (let attempt = 0; !data; attempt++) {
      try {
        data = (await page.evaluate(extract)) as Extracted;
      } catch (e) {
        if (attempt === 2) throw e;
        await page.waitForTimeout(1500);
        await page.waitForLoadState('load', { timeout: LOAD_TIMEOUT }).catch(() => {});
      }
    }
    progress.step = 'sizes';
    const fonts = await Promise.all(fontRequests);

    const finalUrl = unwrap(page.url());
    const httpStatus = response?.status() ?? null;
    const unstyled = data.broken_css > 0 && /^("?times new roman"?|serif)$/i.test(data.dominant[0]?.stack ?? '');
    const leftArchive = opts.archived && !/^https:\/\/web\.archive\.org\//.test(page.url());
    const archiveMiss = opts.archived && (leftArchive || /wayback machine/i.test(data.title) || !data.text_chars || unstyled);
    const status =
      archiveMiss ? 'error'
      : (httpStatus && [401, 403, 429, 503].includes(httpStatus)) || CHALLENGE.test(data.title) ? 'blocked'
      : httpStatus && httpStatus >= 400 ? 'http_error'
      : 'ok';

    return {
      status,
      ...(archiveMiss ? { error: 'archive capture unusable' } : {}),
      http_status: httpStatus,
      final_url: finalUrl,
      title: data.title,
      description: data.description,
      lang: data.lang,
      body_font: data.dominant[0]?.family ?? null,
      heading_font: data.heading[0]?.family ?? null,
      dominant: data.dominant,
      heading: data.heading,
      declared: data.declared,
      sources: [...new Set(fonts.map((f) => sourceOf(f.url)))].sort(),
      font_hosts: [...new Set(fonts.filter((f) => !f.url.startsWith('data:')).map((f) => hostname(f.url)).filter(Boolean))].sort(),
      platform: data.platform,
      font_requests: fonts.length,
      font_bytes: fonts.reduce((n, f) => n + f.bytes, 0),
      preloads: data.preloads,
      fonts_ready: fontsReady,
      text_chars: data.text_chars,
      text_nodes: data.text_nodes,
      ...(opts.proxy ? { via: 'proxy', transfer_bytes: (await Promise.all(transfers)).reduce((n, b) => n + b, 0) } : {}),
      ms: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}
