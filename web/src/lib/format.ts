export const pct = (n: number | null | undefined, digits = 1) => (n == null ? '–' : `${(n * 100).toFixed(n * 100 >= 10 || digits === 0 ? 0 : digits)}%`);

export const points = (n: number | null | undefined) => {
  if (n == null) return null;
  const v = n * 100;
  if (Math.abs(v) < 0.05) return 'no change';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} pts`;
};

export const date = (iso: string) => new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export const kb = (bytes: number | null | undefined) => (bytes == null ? '–' : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`);

export const SOURCE_LABELS: Record<string, string> = {
  self: 'Self-hosted',
  google: 'Google Fonts',
  adobe: 'Adobe Fonts',
  system: 'System fonts',
  'foundry-cdn': 'Other font CDNs',
  none: 'None',
};

export const PLATFORM_LABELS: Record<string, string> = {
  nextjs: 'Next.js',
  wordpress: 'WordPress',
  shopify: 'Shopify',
  webflow: 'Webflow',
  framer: 'Framer',
  squarespace: 'Squarespace',
  wix: 'Wix',
  nuxt: 'Nuxt',
  gatsby: 'Gatsby',
  none: 'Other or custom',
};

export function trendText(periods: { kind: string; date: string }[], panel: number | null, subject: string) {
  const archive = periods.filter((p) => p.kind === 'wayback');
  const live = periods.find((p) => p.kind !== 'wayback');
  const since = live ? new Date(live.date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : null;
  if (!panel || !archive.length) {
    return { title: `Share of ${subject} over time`, caption: since ? `From our weekly crawl, which started in ${since}.` : '' };
  }
  const from = archive[0].date.slice(0, 4);
  return {
    title: `Share among the ${panel} sites we can trace back to ${from}`,
    caption: `Dashed lines before ${since} are estimates from web archive copies of these homepages; the solid part is our own weekly crawl. Because this follows a fixed set of ${panel} sites, its numbers differ from the rankings above, which cover every site we crawl.`,
  };
}
