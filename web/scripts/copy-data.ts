import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../../data/', import.meta.url).pathname;
const out = new URL('../public/', import.meta.url).pathname;
for (const dir of ['data', 'agg']) rmSync(out + dir, { recursive: true, force: true });
mkdirSync(out + 'agg', { recursive: true });
if (existsSync(root + 'agg/series.json')) cpSync(root + 'agg/series.json', out + 'agg/series.json');
