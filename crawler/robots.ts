import { USER_AGENT } from './static.ts';

export function disallowsAll(robots: string) {
  let applies = false;
  let inRules = false;
  let disallowed = false;
  let allowedRoot = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const key = field.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (inRules) {
        applies = false;
        inRules = false;
      }
      if (value === '*') applies = true;
    } else if (key === 'allow' || key === 'disallow') {
      inRules = true;
      if (!applies) continue;
      if (key === 'disallow' && value === '/') disallowed = true;
      if (key === 'allow' && (value === '/' || value === '/$')) allowedRoot = true;
    }
  }
  return disallowed && !allowedRoot;
}

export async function robotsAllows(domain: string) {
  const res = await fetch(`https://${domain}/robots.txt`, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return false;
  if (res.status >= 500) return false;
  if (res.status >= 400) return true;
  return !disallowsAll(await res.text().catch(() => ''));
}
