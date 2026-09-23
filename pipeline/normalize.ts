import { readFileSync } from 'node:fs';

const aliases: Record<string, string> = JSON.parse(readFileSync(new URL('./aliases.json', import.meta.url), 'utf8'));
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji']);
const SUFFIX = /(variable|var|vf|webfont|web|regular|roman|book|normal|light|medium|semibold|bold|italic|v\d)$/;
const SUFFIX_WORD = /^(variable|var|vf|webfont|web|regular|book|normal|light|medium|semibold|bold|italic|v\d|[0-9a-f]{6,})$/i;

const cache = new Map<string, { name: string; slug: string; generic: boolean }>();
export const unaliased = new Map<string, number>();

export function slugify(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'u-' + [...name].map((c) => c.codePointAt(0)!.toString(16)).join('-');
}

function keyOf(s: string) {
  let k = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let prev = ''; prev !== k && k.length > 4; ) {
    prev = k;
    if (!aliases[k]) k = k.replace(SUFFIX, '');
  }
  return k;
}

function pretty(raw: string) {
  const words = (/[\s_-]/.test(raw) ? raw : raw.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .split(/[\s_-]+/)
    .filter(Boolean);
  while (words.length > 1 && SUFFIX_WORD.test(words.at(-1)!)) words.pop();
  const lower = raw === raw.toLowerCase();
  return words.map((w) => (lower ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function normalizeFamily(raw: string | null | undefined) {
  if (!raw) return null;
  const hit = cache.get(raw);
  if (hit) return hit;
  let s = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ');
  const nextFont = s.match(/^__(.+?)_(?:Fallback_)?[0-9a-f]{5,}$/i);
  if (nextFont) s = nextFont[1].replace(/_/g, ' ');
  s = s.replace(/[-_ ][0-9a-f]{6,}$/i, '');
  if (/^(font|ff|f)$/i.test(s) || /^wf_[0-9a-f]{12,}$/i.test(raw.trim())) return { name: 'Unknown', slug: 'unknown', generic: true };
  let result;
  if (GENERIC.has(s.toLowerCase())) result = { name: s.toLowerCase(), slug: slugify(s), generic: true };
  else {
    const name = aliases[keyOf(s)] ?? pretty(s);
    if (!aliases[keyOf(s)]) unaliased.set(name, (unaliased.get(name) ?? 0) + 1);
    result = { name, slug: slugify(name), generic: false };
  }
  cache.set(raw, result);
  return result;
}
