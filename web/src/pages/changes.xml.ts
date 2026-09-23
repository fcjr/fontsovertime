import type { APIRoute } from 'astro';
import { load, type Change } from '../lib/data';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const GET: APIRoute = ({ site }) => {
  const changes = load<Change[]>('changes.json').slice(0, 100);
  const base = site!.toString().replace(/\/$/, '');
  const items = changes
    .map((c) => {
      const title = `${c.domain} switched ${c.role === 'body' ? 'body text' : 'headings'} from ${c.from.name} to ${c.to.name}`;
      const link = `${base}/site/${c.domain}`;
      return `<item><title>${esc(title)}</title><link>${link}</link><guid isPermaLink="false">${esc(`${c.domain}-${c.role}-${c.date}-${c.to.slug}`)}</guid><pubDate>${new Date(c.date + 'T00:00:00Z').toUTCString()}</pubDate><category>${esc(c.category)}</category></item>`;
    })
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Fonts Over Time: switches</title><link>${base}/changes</link><description>Websites that changed their typeface.</description><language>en</language>${items}</channel></rss>`;
  return new Response(xml, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
};
