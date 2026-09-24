import type { FontRef, Specimen } from './data';

const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|ui-serif|ui-sans-serif|ui-monospace|ui-rounded)$/;

export function fontStack(f: { specimen: Specimen } | null | undefined) {
  const s = f?.specimen;
  if (!s) return null;
  if (s.source === 'local') return s.family === 'system-ui' ? 'system-ui, -apple-system, sans-serif' : GENERIC.test(s.family) ? s.family : `"${s.family}"`;
  return `"${s.family}"`;
}

// free: shown in the font itself. system: shown in the viewer's installed copy. licensed: shown in our typeface.
export function fontKind(f: { specimen: Specimen } | null | undefined) {
  return !f?.specimen ? 'licensed' : f.specimen.source === 'local' ? 'system' : 'free';
}

export function fontLinks(fonts: (FontRef | null | undefined)[], opts: { text?: string; full?: boolean } = {}) {
  const google = new Map<string, Specimen>();
  const fontshare = new Set<string>();
  for (const f of fonts) {
    const s = f?.specimen;
    if (!s) continue;
    if (s.source === 'google') google.set(s.family, s);
    if (s.source === 'fontshare' && s.id) fontshare.add(s.id);
  }
  const links: string[] = [];
  const families = [...google.values()];
  for (let i = 0; i < families.length; i += 20) {
    const params = families
      .slice(i, i + 20)
      .map((s) => {
        const name = encodeURIComponent(s!.family).replace(/%20/g, '+');
        if (!opts.full || !s!.wght) return `family=${name}`;
        const [lo, hi] = s!.wght;
        return lo === hi ? `family=${name}` : `family=${name}:wght@${lo}${s!.variable ? '..' : ';'}${hi}`;
      })
      .join('&');
    const text = opts.text ? `&text=${encodeURIComponent(opts.text)}` : '';
    links.push(`https://fonts.googleapis.com/css2?${params}${text}&display=swap`);
  }
  if (fontshare.size) links.push(`https://api.fontshare.com/v2/css?${[...fontshare].map((id) => `f[]=${id}@400,700`).join('&')}&display=swap`);
  return links;
}

export function glyphs(...strings: string[]) {
  return [...new Set(strings.join('') + '0123456789')].sort().join('');
}

export const LICENSED_TIP = 'Commercial font. We can’t license it for this site, so the name is shown in our own typeface.';
export const SYSTEM_TIP = 'System font. It comes with your device, so the name is shown in your copy, which may differ from other devices.';
export const tipFor = (kind: string) => (kind === 'licensed' ? LICENSED_TIP : kind === 'system' ? SYSTEM_TIP : undefined);
