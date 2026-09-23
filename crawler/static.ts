const SYSTEM = new Set(['system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif']);
const MAX_SHEETS = 12;

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export type Fetcher = (url: string) => Promise<{ status: number; url: string; text: string } | null>;

export const liveFetch: Fetcher = async (url) => {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, url: res.url, text: await res.text() };
  } catch {
    return null;
  }
};

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim();
const parseStack = (s: string) => s.split(',').map(unquote).filter(Boolean);

function attr(tag: string, name: string) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((v) => v !== undefined);
}

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function parseHtml(html: string, baseUrl: string) {
  const sheets: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      sheets.push(new URL(decode(href), baseUrl).href);
    } catch {}
  }
  const inline = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const styleAttrs = [...html.matchAll(/<(body|html|h1|h2|h3)\b[^>]*\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => `${m[1]}{${decode(m[2])}}`);
  const title = decode(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const lang = attr(html.match(/<html\b[^>]*>/i)?.[0] ?? '', 'lang') ?? null;
  const generator = attr(html.match(/<meta\b[^>]*name\s*=\s*["']?generator[^>]*>/i)?.[0] ?? '', 'content') ?? '';
  const platform =
    (/cdn\.shopify\.com|Shopify\.theme/.test(html) && 'shopify') ||
    (/data-wf-(site|page)/.test(html) && 'webflow') ||
    ((/framer/i.test(generator) || /framerusercontent\.com/.test(html)) && 'framer') ||
    (/squarespace/i.test(generator + html.slice(0, 5000)) && 'squarespace') ||
    (/wix\.com/i.test(generator) && 'wix') ||
    ((/wordpress/i.test(generator) || /\/wp-content\//.test(html)) && 'wordpress') ||
    ((/__NEXT_DATA__|\/_next\//.test(html)) && 'nextjs') ||
    ((/__NUXT__|id="__nuxt"/.test(html)) && 'nuxt') ||
    (/id="___gatsby"/.test(html) && 'gatsby') ||
    null;
  const preloads = (html.match(/<link\b[^>]*\bas\s*=\s*["']?font[^>]*>/gi) ?? []).filter((t) => /preload/i.test(t)).length;
  return { sheets, css: [...inline, ...styleAttrs], title, lang, platform, preloads };
}

type Rule = { selector: string; body: string };

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(clean)); ) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function prop(body: string, name: string) {
  const m = body.match(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+)`, 'i'));
  return m?.[1].replace(/!important/i, '').trim();
}

function shorthandFamily(value: string) {
  const m = value.match(/(?:\d[\w.%]*|larger|smaller|medium|small|large|x+-(?:small|large))(?:\s*\/\s*[\w.%]+)?\s+(.+)$/i);
  return m?.[1];
}

export function analyzeCss(cssTexts: string[]) {
  const all = cssTexts.flatMap(rules);
  const vars = new Map<string, string>();
  const faces = new Map<string, { family: string; weights: Set<string>; hosts: Set<string> }>();
  const imports: string[] = [];
  for (const css of cssTexts) for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) imports.push(m[1]);

  for (const r of all) {
    for (const m of r.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) if (!vars.has(m[1])) vars.set(m[1], m[2].trim());
    if (/@font-face/i.test(r.selector)) {
      const family = unquote(prop(r.body, 'font-family') ?? '');
      if (!family) continue;
      const key = family.toLowerCase();
      if (!faces.has(key)) faces.set(key, { family, weights: new Set(), hosts: new Set() });
      const f = faces.get(key)!;
      f.weights.add((prop(r.body, 'font-weight') ?? '400').replace('normal', '400').replace('bold', '700'));
      for (const u of r.body.matchAll(/url\(\s*["']?([^"')]+)/g)) {
        if (u[1].startsWith('data:')) f.hosts.add('inline');
        else if (/^https?:|^\/\//.test(u[1])) f.hosts.add(new URL(u[1], 'https://x/').hostname);
        else f.hosts.add('self');
      }
    }
  }

  const resolve = (value: string, depth = 0): string =>
    depth > 5 ? value : value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, v, fb) => resolve(vars.get(v) ?? fb ?? '', depth + 1));

  const stackFor = (test: (sel: string) => boolean) => {
    let found: string | undefined;
    for (const r of all) {
      if (/^@/.test(r.selector)) continue;
      if (!r.selector.split(',').some((s) => test(s.trim()))) continue;
      const v = prop(r.body, 'font-family') ?? (prop(r.body, 'font') && shorthandFamily(prop(r.body, 'font')!));
      if (!v || /^(inherit|initial|unset)$/i.test(v)) continue;
      let stack = resolve(v);
      if (/\d(px|rem|em|%|pt)\b/.test(stack)) stack = shorthandFamily(stack) ?? '';
      if (stack && !/var\(/.test(stack)) found = stack;
    }
    return found;
  };

  const effective = (stack?: string) => {
    if (!stack) return null;
    const fams = parseStack(stack);
    const lower = fams.map((f) => f.toLowerCase());
    const i = lower.findIndex((f) => faces.has(f));
    if (i >= 0) return fams[i];
    if (SYSTEM.has(lower[0])) return 'system-ui';
    return fams[0] ?? null;
  };

  const bodyStack = stackFor((s) => /^(html|body|:root)$/i.test(s)) ?? stackFor((s) => /^(p|main|\.body)$/i.test(s));
  const headingStack = stackFor((s) => /^h1$/i.test(s)) ?? bodyStack;
  return { bodyStack, headingStack, bodyFont: effective(bodyStack), headingFont: effective(headingStack), faces, imports };
}

export async function staticCrawl(url: string, fetcher: Fetcher = liveFetch) {
  const page = await fetcher(url);
  if (!page) return null;
  const html = parseHtml(page.text, page.url);
  const css = [...html.css];
  const fontHosts = new Set<string>();
  const queue = [...html.sheets];
  for (let i = 0; i < queue.length && i < MAX_SHEETS; i++) {
    const host = new URL(queue[i]).hostname;
    if (/fonts\.googleapis\.com|typekit\.net|fontshare\.com|fonts\.bunny\.net/.test(host)) fontHosts.add(host);
    const res = await fetcher(queue[i]);
    if (!res || res.status >= 400) continue;
    css.push(res.text);
    for (const m of res.text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) {
      try {
        queue.push(new URL(m[1], res.url).href);
      } catch {}
    }
  }
  const a = analyzeCss(css);
  for (const f of a.faces.values()) for (const h of f.hosts) if (h !== 'self') fontHosts.add(h);
  return {
    http_status: page.status,
    final_url: page.url,
    title: html.title,
    lang: html.lang,
    platform: html.platform,
    preloads: html.preloads,
    body_font: a.bodyFont,
    heading_font: a.headingFont,
    body_stack: a.bodyStack ?? null,
    heading_stack: a.headingStack ?? null,
    declared: [...a.faces.values()].map((f) => ({ family: f.family, weights: [...f.weights], variable: [...f.weights].some((w) => /\s/.test(w)) })),
    font_hosts: [...fontHosts].sort(),
  };
}
