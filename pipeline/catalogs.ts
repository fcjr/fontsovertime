import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './normalize.ts';
import { ROOT } from './snapshots.ts';

const catalog: Record<string, { source: 'google' | 'fontshare' | 'local'; family: string; category: string; wght?: [number, number]; variable?: boolean; id?: string }> = {};

const google = (await (await fetch('https://fonts.google.com/metadata/fonts')).json()) as {
  familyMetadataList: { family: string; category: string; axes: { tag: string; min: number; max: number }[]; fonts: Record<string, unknown> }[];
};
for (const f of google.familyMetadataList) {
  const axis = f.axes.find((a) => a.tag === 'wght');
  const weights = Object.keys(f.fonts).filter((k) => !k.endsWith('i')).map(Number);
  catalog[slugify(f.family)] = {
    source: 'google',
    family: f.family,
    category: f.category.toLowerCase().replace(' ', '-'),
    wght: axis ? [axis.min, axis.max] : [Math.min(...weights), Math.max(...weights)],
    variable: !!axis,
  };
}

for (let page = 1; page < 20; page++) {
  const res = (await (await fetch(`https://api.fontshare.com/v2/fonts?limit=100&page=${page}`)).json()) as {
    fonts: { name: string; slug: string; category: string }[];
  };
  if (!res.fonts?.length) break;
  for (const f of res.fonts) {
    const slug = slugify(f.name);
    if (!catalog[slug]) catalog[slug] = { source: 'fontshare', family: f.name, id: f.slug, category: (f.category ?? '').toLowerCase() };
  }
}

const renamed: Record<string, string> = { 'source-sans': 'Source Sans 3', 'source-serif': 'Source Serif 4', 'franklin-gothic': 'Libre Franklin' };
for (const [slug, family] of Object.entries(renamed)) if (catalog[slugify(family)] && slug !== 'franklin-gothic') catalog[slug] = catalog[slugify(family)];
for (const family of ['Arial', 'Helvetica', 'Helvetica Neue', 'Georgia', 'Times New Roman', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Courier New', 'system-ui', 'sans-serif', 'serif', 'monospace', 'ui-monospace', 'ui-serif', 'ui-sans-serif', 'ui-rounded', 'cursive', 'fantasy'])
  catalog[slugify(family)] = { source: 'local', family, category: 'system' };

writeFileSync(join(ROOT, 'pipeline/catalog.json'), JSON.stringify(catalog));
console.error(`catalog: ${Object.keys(catalog).length} families`);
