import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export const ROOT = new URL('..', import.meta.url).pathname;
export const SNAPSHOTS = join(ROOT, 'data/snapshots');

export type Kind = 'weekly' | 'daily' | 'wayback' | 'hn';
export type Row = Record<string, any> & { domain: string; status: string; crawled_at: string };

export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function weekStart(id: string) {
  const [y, w] = id.split('-W').map(Number);
  const jan4 = Date.UTC(y, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * 86400000 + (w - 1) * 7 * 86400000;
}

export function readJsonl(path: string): Row[] {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function writeSnapshot(kind: Kind, id: string, rows: Row[]) {
  const path = join(SNAPSHOTS, kind, `${id}.jsonl.gz`);
  mkdirSync(dirname(path), { recursive: true });
  const key = (r: Row) => (r.hn_id ? String(r.hn_id) : r.domain);
  const byKey = new Map<string, Row>();
  if (existsSync(path)) for (const r of readJsonl(path)) byKey.set(key(r), r);
  for (const r of rows) byKey.set(key(r), r);
  const sorted = [...byKey.values()].sort((a, b) => a.domain.localeCompare(b.domain) || key(a).localeCompare(key(b)));
  writeFileSync(path, gzipSync(sorted.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 }));
  return { path, count: sorted.length };
}

export function listSnapshots(kind: Kind) {
  const dir = join(SNAPSHOTS, kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl.gz'))
    .sort()
    .map((f) => ({ kind, id: f.replace('.jsonl.gz', ''), path: join(dir, f) }));
}
