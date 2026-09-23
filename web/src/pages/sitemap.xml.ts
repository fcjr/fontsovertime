import type { APIRoute } from 'astro';
import { load, type CategorySummary, type FontIndexEntry, type SiteRow } from '../lib/data';

export const GET: APIRoute = ({ site }) => {
  const base = site!.toString().replace(/\/$/, '');
  const paths = [
    '/',
    '/fonts',
    '/trends',
    '/categories',
    '/changes',
    '/pairings',
    '/compare',
    '/methodology',
    '/data',
    ...load<CategorySummary[]>('categories.json').map((c) => `/category/${c.slug}`),
    ...load<FontIndexEntry[]>('fonts.json').map((f) => `/font/${f.slug}`),
    ...load<SiteRow[]>('sites.json').map((s) => `/site/${s.domain}`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((p) => `<url><loc>${base}${p}</loc></url>`).join('')}</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml' } });
};
