import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { listSnapshots, readJsonl, ROOT, type Kind } from './snapshots.ts';

const MARKER = 'fontsovertime-opt-out';
const bare = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');

export function parseDomain(body: string) {
  const m = body.match(/###\s*Domain\s*\n+([^\n]+)/i);
  const d = m ? bare(m[1]) : '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 253 ? d : null;
}

async function hasTxt(domain: string) {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return false;
  const data = (await res.json().catch(() => ({}))) as { Answer?: { data: string }[] };
  return (data.Answer ?? []).some((a) => a.data.includes(MARKER));
}

async function hasWellKnown(domain: string) {
  for (const host of [domain, `www.${domain}`]) {
    const res = await fetch(`https://${host}/.well-known/${MARKER}`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res?.ok) continue;
    const text = (await res.text().catch(() => '')).trim();
    if (text.length < 500 && text.includes(MARKER)) return true;
  }
  return false;
}

export function exclude(domain: string) {
  const path = join(ROOT, 'sites', 'exclude.txt');
  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim());
  if (!lines.includes(domain)) appendFileSync(path, `${domain}\n`);
  let removed = 0;
  for (const kind of ['weekly', 'daily', 'wayback'] as Kind[]) {
    for (const snap of listSnapshots(kind)) {
      const rows = readJsonl(snap.path);
      const kept = rows.filter((r) => bare(r.domain) !== domain);
      if (kept.length === rows.length) continue;
      removed += rows.length - kept.length;
      writeFileSync(snap.path, gzipSync(kept.map((r) => JSON.stringify(r)).join('\n') + '\n', { level: 9 }));
    }
  }
  return removed;
}

if (import.meta.main) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
  const issue = event.issue;
  const labels: string[] = (issue.labels ?? []).map((l: { name: string }) => l.name);
  const out = (key: string, value: string) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}<<EOF_${key}\n${value}\nEOF_${key}\n`);
  const domain = parseDomain(issue.body ?? '');
  if (!domain) {
    out('status', 'invalid');
    out('message', 'We couldn’t read a domain from this issue. Please edit it so the **Domain** field has just the domain, like `example.com`.');
  } else {
    const approved = labels.includes('approved');
    const txt = approved ? false : await hasTxt(domain);
    const file = approved || txt ? false : await hasWellKnown(domain);
    if (approved || txt || file) {
      const removed = exclude(domain);
      const how = approved ? 'a maintainer approved it' : txt ? 'found the DNS TXT record' : 'found the `.well-known` file';
      out('status', 'done');
      out('domain', domain);
      out(
        'message',
        `Verified (${how}). \`${domain}\` is now on the exclusion list: it won’t be crawled again, and ${removed} stored observation${removed === 1 ? ' was' : 's were'} removed from the published data files. The site updates on the next deploy. Earlier versions of those files remain in the repository’s git history. You can remove the verification record now.`,
      );
    } else {
      out('status', 'unverified');
      out('domain', domain);
      out(
        'message',
        [
          `Thanks. We couldn’t confirm you run \`${domain}\` yet. Do either of these, then edit this issue (any small change) and we’ll check again:`,
          '',
          `- Add a DNS TXT record on \`${domain}\` containing \`${MARKER}\``,
          `- Serve a plain text file at \`https://${domain}/.well-known/${MARKER}\` containing \`${MARKER}\``,
          '',
          'If neither is possible, say so here and a maintainer will follow up.',
        ].join('\n'),
      );
    }
  }
}
