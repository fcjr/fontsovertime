import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFamily, slugify } from './normalize.ts';
import { isoWeek } from './snapshots.ts';
import { analyzeCss } from '../crawler/static.ts';
import { squarify } from '../web/src/lib/treemap.ts';

test('normalizes next/font, variable and weight-suffixed names', () => {
  const cases: [string, string][] = [
    ['__Inter_a1b2c3', 'Inter'],
    ['__Inter_Fallback_a1b2c3', 'Inter'],
    ['InterVariable', 'Inter'],
    ['Inter var', 'Inter'],
    ['sohne-var', 'Söhne'],
    ['__geistSansFont_8289af', 'Geist'],
    ['SourceSansProRegular', 'Source Sans'],
    ['Source Sans 3', 'Source Sans'],
    ['GT America Standard Regular', 'GT America'],
    ['wix-madefor-text-v2', 'Wix Madefor'],
    ['Playfair Display', 'Playfair Display'],
    ['neue-haas-grotesk-text', 'Neue Haas Grotesk'],
  ];
  for (const [raw, name] of cases) assert.equal(normalizeFamily(raw)?.name, name, raw);
});

test('keeps generic families generic and hashes unknown', () => {
  assert.deepEqual(normalizeFamily('system-ui'), { name: 'system-ui', slug: 'system-ui', generic: true });
  assert.equal(normalizeFamily('font-4f2a1c9')?.name, 'Unknown');
  assert.equal(normalizeFamily('wf_02a27d28277f4e898b9c9227b')?.name, 'Unknown');
  assert.equal(normalizeFamily(null), null);
});

test('slugify never returns an empty slug', () => {
  assert.equal(slugify('Söhne'), 'sohne');
  assert.match(slugify('微软雅黑'), /^u-/);
});

test('iso weeks', () => {
  assert.equal(isoWeek(new Date('2026-09-23T00:00:00Z')), '2026-W39');
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  assert.equal(isoWeek(new Date('2025-12-29T00:00:00Z')), '2026-W01');
});

test('static css analysis resolves variables and @font-face', () => {
  const a = analyzeCss([
    ':root{--font-sans:"Brand Sans", system-ui}',
    '@font-face{font-family:"Brand Sans";src:url(/f.woff2);font-weight:100 900}',
    'body{font-family:var(--font-sans)}',
    'h1{font:700 3rem/1.1 Georgia, serif}',
  ]);
  assert.equal(a.bodyFont, 'Brand Sans');
  assert.equal(a.headingFont, 'Georgia');
});

test('treemap tiles fill the area without overlap', () => {
  const items = [30, 20, 15, 10, 10, 5, 5, 3, 2];
  const tiles = squarify(items, (v) => v, 100, 56);
  assert.equal(tiles.length, items.length);
  const area = tiles.reduce((a, t) => a + t.w * t.h, 0);
  assert.ok(Math.abs(area - 5600) < 1e-6);
  for (const t of tiles) assert.ok(t.x >= -1e-9 && t.y >= -1e-9 && t.x + t.w <= 100 + 1e-9 && t.y + t.h <= 56 + 1e-9);
});

test('folds hosts to one registrable domain', async () => {
  const { registrable, hostOf } = await import('./psl.ts');
  assert.equal(registrable('sellercentral.amazon.com'), 'amazon.com');
  assert.equal(registrable('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrable('someone.github.io'), 'someone.github.io');
  assert.equal(hostOf('https://www.Example.com/path'), 'example.com');
});

test('reads the domain from an opt-out issue form', async () => {
  const { parseDomain } = await import('./optout.ts');
  assert.equal(parseDomain('### Domain\n\nhttps://www.Example.com/about\n\n### Your relationship'), 'example.com');
  assert.equal(parseDomain('### Domain\n\n_No response_'), null);
  assert.equal(parseDomain('### Domain\n\nexample.com; rm -rf /'), null);
});

test('garbled, minified and CJK font names', () => {
  assert.equal(normalizeFamily('\u03a2\ufffd\ufffd\ufffd\u017a\ufffd')?.slug, 'unknown');
  assert.equal(normalizeFamily('M')?.slug, 'unknown');
  assert.equal(normalizeFamily('ヒラギノ角ゴ Pro W3')?.name, 'Hiragino Kaku Gothic');
  assert.equal(normalizeFamily('ＭＳ Ｐゴシック')?.name, 'MS PGothic');
  assert.equal(normalizeFamily('맑은 고딕')?.name, 'Malgun Gothic');
  assert.equal(normalizeFamily('微软雅黑')?.slug, 'microsoft-yahei');
  assert.match(slugify('デザイン書体'), /^u-30c7-/);
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
});

test('unescapes CSS escapes in family names', () => {
  assert.equal(normalizeFamily('Hurme Geometric Sans\\ 3')?.name, 'Hurme Geometric Sans 3');
  assert.equal(normalizeFamily('\\31 0x Sans')?.name, '10x Sans');
});
