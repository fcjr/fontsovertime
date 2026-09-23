import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGG = join(process.cwd(), '..', 'data', 'agg');

export type Specimen = { source: 'google' | 'fontshare' | 'local'; family: string; category: string; wght?: number[]; variable?: boolean; id?: string } | null;
export type FontRef = { name: string; slug: string; specimen: Specimen };
export type Ranked = FontRef & { generic: boolean; count: number; share: number; delta: number | null; series: (number | null)[] };
export type Period = { id: string; date: string; kind: string; n: number };
export type Change = { date: string; domain: string; category: string; role: 'body' | 'heading'; from: FontRef; to: FontRef };
export type Breakdown = { key: string; count: number; share: number }[];
export type Pairing = { heading: FontRef; body: FontRef; count: number; share: number; examples: string[] };
export type SiteRow = { domain: string; category: string; body: FontRef | null; heading: FontRef | null; platform: string | null; method: string; date: string };
export type CategorySummary = { slug: string; kind: 'cohort' | 'category'; name: string; blurb: string; n: number; top: (FontRef & { share: number })[]; blocked: number | null };

const cache = new Map<string, unknown>();
export function load<T>(path: string): T {
  if (!cache.has(path)) {
    const full = join(AGG, path);
    cache.set(path, existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : null);
  }
  return cache.get(path) as T;
}

export type Overview = {
  generated_at: string;
  latest: { id: string; date: string } | null;
  n_sites: number;
  n_fonts: number;
  n_changes: number;
  periods: Period[];
  trend_panel: number | null;
  body: Ranked[];
  heading: Ranked[];
  sources: Breakdown;
  platforms: Breakdown;
  variable: number;
  median_font_bytes: number | null;
  categories: CategorySummary[];
  matrix: { fonts: FontRef[]; categories: { slug: string; name: string }[]; values: { share: number; count: number }[][] };
  changes: Change[];
  pairings: Pairing[];
};

export type FontIndexEntry = FontRef & { generic: boolean; body_count: number; heading_count: number; sites: number; share: number; categories: string[] };
