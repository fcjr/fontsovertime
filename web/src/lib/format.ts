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
