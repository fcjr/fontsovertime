export const REPO_URL = 'https://github.com/fcjr/fontsovertime';

export const rawUrl = (path: string) => `${REPO_URL}/raw/main/${path}`;

export function optOutUrl(domain?: string) {
  const params = new URLSearchParams({ template: 'opt-out.yml', title: `Opt out: ${domain ?? ''}`.trim() });
  if (domain) params.set('domain', domain.replace(/^www\./, ''));
  return `${REPO_URL}/issues/new?${params}`;
}
