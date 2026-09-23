import { parseArgs } from 'node:util';
import { isoWeek, readJsonl, writeSnapshot, type Kind } from './snapshots.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { kind: { type: 'string', default: 'weekly' }, id: { type: 'string' } },
});

const kind = values.kind as Kind;
const now = new Date();
const id = values.id ?? (kind === 'daily' ? now.toISOString().slice(0, 10) : isoWeek(now));
const rows = positionals.flatMap(readJsonl);
if (kind === 'wayback') {
  const byQuarter = new Map<string, typeof rows>();
  for (const { quarter, ...r } of rows) byQuarter.set(quarter, [...(byQuarter.get(quarter) ?? []), r as (typeof rows)[number]]);
  for (const [quarter, list] of byQuarter) {
    const { path, count } = writeSnapshot('wayback', quarter, list);
    console.error(`wrote ${count} rows (${list.length} new) to ${path}`);
  }
} else {
  const { path, count } = writeSnapshot(kind, id, rows);
  console.error(`wrote ${count} rows (${rows.length} new) to ${path}`);
}
