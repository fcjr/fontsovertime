// Checks data files pushed by the crawl server before they are promoted to main.
import { readFileSync } from 'node:fs';
import { readJsonl } from './snapshots.ts';

const problems: string[] = [];
for (const path of process.argv.slice(2)) {
  try {
    if (path.endsWith('.jsonl.gz') || path.endsWith('.jsonl')) {
      for (const r of readJsonl(path)) if (typeof r.domain !== 'string' || !r.domain) throw new Error('row without a domain');
    } else if (path.endsWith('.json')) {
      JSON.parse(readFileSync(path, 'utf8'));
    } else if (!path.endsWith('.csv')) {
      throw new Error('unexpected file type');
    }
  } catch (e) {
    problems.push(`${path}: ${(e as Error).message}`);
  }
}
for (const p of problems) console.error(p);
process.exit(problems.length ? 1 : 0);
