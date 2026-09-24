(() => {
  const MAX_NODES = 3000;
  const SYSTEM = new Set(['system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'CANVAS', 'TEXTAREA', 'SELECT', 'OPTION']);

  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  const parseStack = (s) => s.split(',').map(unquote).filter(Boolean);
  const round = (n) => Math.round(n * 1000) / 1000;
  const weightOf = (w) => (w === 'normal' ? '400' : w === 'bold' ? '700' : w.trim());

  const declared = new Map();
  const loaded = new Set();
  for (const face of document.fonts) {
    const family = unquote(face.family);
    const key = family.toLowerCase();
    let d = declared.get(key);
    if (!d) {
      d = { family, faces: 0, weights: new Set(), styles: new Set(), display: new Set(), status: new Set(), variable: false };
      declared.set(key, d);
    }
    const weight = weightOf(face.weight);
    d.faces++;
    d.weights.add(weight);
    d.styles.add(face.style);
    d.display.add(face.display);
    d.status.add(face.status);
    if (/\s/.test(weight)) d.variable = true;
    if (face.status === 'loaded') loaded.add(key);
  }

  const effectiveCache = new Map();
  const effective = (stack) => {
    if (effectiveCache.has(stack)) return effectiveCache.get(stack);
    const fams = parseStack(stack);
    const lower = fams.map((f) => f.toLowerCase());
    let r;
    const sys = lower.findIndex((f) => SYSTEM.has(f));
    const first = (has) => {
      const j = lower.findIndex((f) => has(f));
      return j >= 0 && (sys < 0 || j < sys) ? j : -1;
    };
    let i = first((f) => loaded.has(f));
    if (i < 0 && window.__fotIntended) i = first((f) => declared.has(f));
    if (i >= 0) r = fams[i];
    else if (sys === 0) r = 'system-ui';
    else {
      i = lower.findIndex((f) => !declared.has(f));
      r = i < 0 ? fams[0] : SYSTEM.has(lower[i]) ? 'system-ui' : fams[i];
    }
    r ??= 'unknown';
    effectiveCache.set(stack, r);
    return r;
  };

  const newTally = () => ({ chars: 0, by: new Map() });
  // Code samples are content, not the page's type, so body text leaves them out unless there's little else.
  const all = newTally();
  const withCode = newTally();
  const headings = newTally();
  const bump = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const add = (t, family, info, n) => {
    t.chars += n;
    let e = t.by.get(family);
    if (!e) t.by.set(family, (e = { chars: 0, stacks: new Map(), weights: new Map() }));
    e.chars += n;
    bump(e.stacks, info.stack, n);
    bump(e.weights, info.weight, n);
  };

  const styleCache = new Map();
  const range = document.createRange();
  let nodes = 0;
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && nodes < MAX_NODES; node = walker.nextNode()) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || SKIP.has(el.tagName)) continue;
      let info = styleCache.get(el);
      if (info === undefined) {
        info = null;
        if (
          el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          !el.closest('[role=dialog],[aria-modal=true]')
        ) {
          const cs = getComputedStyle(el);
          info = { stack: cs.fontFamily, weight: weightOf(cs.fontWeight), heading: !!el.closest('h1,h2,h3'), code: !!el.closest('pre,code,kbd,samp') };
        }
        styleCache.set(el, info);
      }
      if (!info) continue;
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      nodes++;
      const family = effective(info.stack);
      add(withCode, family, info, text.length);
      if (!info.code) add(all, family, info, text.length);
      if (info.heading) add(headings, family, info, text.length);
    }
  }

  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
  const summarize = (t) =>
    [...t.by]
      .map(([family, e]) => ({
        family,
        share: round(e.chars / t.chars),
        stack: top(e.stacks),
        weights: Object.fromEntries([...e.weights].sort((a, b) => b[1] - a[1]).map(([w, c]) => [w, round(c / e.chars)])),
      }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 8);

  const generator = document.querySelector('meta[name=generator]')?.content || '';
  const has = (sel) => !!document.querySelector(sel);
  const platform =
    (window.Shopify && 'shopify') ||
    ((has('html[data-wf-site]') || has('html[data-wf-page]')) && 'webflow') ||
    ((/framer/i.test(generator) || has('script[src*="framerusercontent.com"]')) && 'framer') ||
    ((window.Static?.SQUARESPACE_CONTEXT || /squarespace/i.test(generator)) && 'squarespace') ||
    ((/wix\.com/i.test(generator) || window.wixBiSession) && 'wix') ||
    ((/wordpress/i.test(generator) || has('link[href*="/wp-content/"],script[src*="/wp-content/"],script[src*="/wp-includes/"]')) && 'wordpress') ||
    ((window.__NEXT_DATA__ || window.next || has('script[src*="/_next/"]')) && 'nextjs') ||
    ((window.__NUXT__ || window.$nuxt || has('#__nuxt')) && 'nuxt') ||
    (has('#___gatsby') && 'gatsby') ||
    null;

  return {
    title: document.title.trim(),
    description: document.querySelector('meta[name=description]')?.content?.trim() || null,
    lang: document.documentElement.lang || null,
    platform,
    preloads: document.querySelectorAll('link[rel~=preload][as=font]').length,
    broken_css: [...document.querySelectorAll('link[rel~=stylesheet]')].filter((l) => !l.sheet).length,
    stylesheets: document.querySelectorAll('link[rel~=stylesheet], style').length,
    empty_css: [...document.querySelectorAll('link[rel~=stylesheet]')].filter((l) => {
      if (!l.sheet) return true;
      try {
        return l.sheet.cssRules.length === 0;
      } catch {
        return false;
      }
    }).length,
    text_chars: withCode.chars,
    text_nodes: nodes,
    dominant: summarize(all.chars >= 200 || all.chars >= withCode.chars / 2 ? all : withCode),
    heading: summarize(headings),
    declared: [...declared.values()].map((d) => ({
      family: d.family,
      faces: d.faces,
      weights: [...d.weights],
      styles: [...d.styles],
      display: [...d.display],
      status: [...d.status],
      variable: d.variable,
    })),
  };
})()
