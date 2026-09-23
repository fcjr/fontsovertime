import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './snapshots.ts';

const PATH = join(ROOT, 'pipeline/public_suffix_list.dat');

export async function updatePsl() {
  const res = await fetch('https://publicsuffix.org/list/public_suffix_list.dat');
  if (!res.ok) throw new Error(`public suffix list: ${res.status}`);
  writeFileSync(PATH, await res.text());
}

let rules: { exact: Set<string>; wild: Set<string>; except: Set<string> } | null = null;

function load() {
  if (rules) return rules;
  rules = { exact: new Set(), wild: new Set(), except: new Set() };
  if (!existsSync(PATH)) return rules;
  for (const raw of readFileSync(PATH, 'utf8').split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) rules.except.add(line.slice(1));
    else if (line.startsWith('*.')) rules.wild.add(line.slice(2));
    else rules.exact.add(line);
  }
  return rules;
}

export function registrable(host: string) {
  const r = load();
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (r.except.has(suffix)) return labels.slice(i).join('.');
    const parent = labels.slice(i + 1).join('.');
    if (r.exact.has(suffix) || (parent && r.wild.has(parent))) return i === 0 ? null : labels.slice(i - 1).join('.');
  }
  return labels.slice(-2).join('.');
}

export function hostOf(url: string) {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
