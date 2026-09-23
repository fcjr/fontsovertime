export type Series = { label: string; values: (number | null)[]; family?: string | null; href?: string };
export type Payload = { dates: string[]; kinds: string[]; labels: string[]; series: Series[]; height: number };

const NS = 'http://www.w3.org/2000/svg';
const RANGES = [
  { key: 'all', label: 'All time', days: Infinity },
  { key: '2y', label: '2 years', days: 730 },
  { key: '1y', label: '1 year', days: 365 },
  { key: '3m', label: '3 months', days: 92 },
];
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const color = (i: number, single: boolean) => (single ? 'var(--ink)' : `var(--s${i + 1})`);
const fam = (s: Series) => (s.family ? `${s.family}, var(--sans)` : 'var(--display)');

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function niceMax(v: number) {
  for (const step of [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25]) if (v / step <= 5) return { max: Math.ceil(v / step) * step || step, step };
  return { max: 1, step: 0.25 };
}

const pctLabel = (v: number, step: number) => `${(v * 100).toFixed(step < 0.01 ? 1 : 0)}%`;

export function mountTrend(root: HTMLElement, data: Payload) {
  const single = data.series.length === 1;
  const hidden = new Set<number>();
  let focus: number | null = null;
  let range = 'all';
  let drawn = false;
  let hoverIndex: number | null = null;

  const times = data.dates.map((d) => Date.parse(d));
  const tMax = Math.max(...times);
  const available = RANGES.filter((r) => r.key === 'all' || tMax - Math.min(...times) > r.days * 864e5 * 0.9);

  root.replaceChildren();
  const controls = html('div', 'tc-controls');
  const legend = html('ul', 'tc-legend');
  const ranges = html('div', 'tc-ranges');
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Time range');
  if (!single) controls.append(legend);
  if (available.length > 1) controls.append(ranges);
  const stage = html('div', 'tc-stage');
  stage.style.height = `${data.height}px`;
  const tip = html('div', 'tc-tip');
  tip.hidden = true;
  root.append(controls, stage);

  const legendItems = data.series.map((s, i) => {
    const li = html('li');
    const btn = html('button', 'tc-key');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'true');
    const sw = html('span', 'sw');
    sw.style.background = color(i, single);
    const name = html('span', 'tc-key-name', s.label);
    name.style.fontFamily = fam(s);
    btn.append(sw, name);
    btn.addEventListener('click', () => {
      if (hidden.has(i)) hidden.delete(i);
      else if (hidden.size < data.series.length - 1) hidden.add(i);
      btn.setAttribute('aria-pressed', String(!hidden.has(i)));
      li.classList.toggle('off', hidden.has(i));
      render();
    });
    btn.addEventListener('pointerenter', () => setFocus(i));
    btn.addEventListener('pointerleave', () => setFocus(null));
    btn.addEventListener('focus', () => setFocus(i));
    btn.addEventListener('blur', () => setFocus(null));
    li.append(btn);
    legend.append(li);
    return li;
  });

  for (const r of available) {
    const b = html('button', 'tc-range', r.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(r.key === range));
    b.addEventListener('click', () => {
      range = r.key;
      ranges.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    });
    ranges.append(b);
  }

  let lines: SVGPathElement[] = [];
  let areas: SVGPathElement[] = [];
  let labels: SVGTextElement[] = [];

  function setFocus(i: number | null) {
    focus = i;
    lines.forEach((l, j) => l.classList.toggle('dim', focus !== null && focus !== j));
    areas.forEach((a, j) => a.classList.toggle('show', focus === j));
    labels.forEach((t) => t.classList.toggle('dim', focus !== null && Number(t.dataset.i) !== focus));
    legendItems.forEach((li, j) => li.classList.toggle('dim', focus !== null && focus !== j));
  }

  function render() {
    const width = stage.clientWidth;
    if (!width) return;
    const height = data.height;
    const narrow = width < 560;
    const visible = data.series.map((_, i) => i).filter((i) => !hidden.has(i));
    const direct = !narrow && !single && visible.length <= 4;
    const m = { top: 16, right: direct ? 140 : 16, bottom: 30, left: 48 };
    const r = RANGES.find((x) => x.key === range)!;
    const idx = times.map((t, j) => j).filter((j) => tMax - times[j] <= r.days * 864e5);
    const t0 = Math.min(...idx.map((j) => times[j]));
    const t1 = Math.max(...idx.map((j) => times[j]));
    const vals = visible.flatMap((i) => idx.map((j) => data.series[i].values[j]).filter((v): v is number => v !== null));
    const { max, step } = niceMax(Math.max(...vals, 0.005) * 1.1);
    const x = (t: number) => m.left + ((t - t0) / (t1 - t0 || 1)) * (width - m.left - m.right);
    const y = (v: number) => m.top + (1 - v / max) * (height - m.top - m.bottom);
    const plotBottom = height - m.bottom;

    stage.replaceChildren();
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` }, stage);
    stage.append(tip);

    const firstLive = data.kinds.findIndex((k) => k !== 'wayback');
    if (firstLive > 0 && times[firstLive] > t0) {
      const w = x(Math.min(times[firstLive], t1)) - m.left;
      el('rect', { x: m.left, y: m.top, width: w, height: plotBottom - m.top, class: 'archive' }, svg);
      if (w > 120) el('text', { x: m.left + 10, y: m.top + 18, class: 'archive-label' }, svg).textContent = 'Archive estimates';
    }

    for (let v = 0; v <= max + 1e-9; v += step) {
      el('line', { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'base' : 'grid' }, svg);
      el('text', { x: m.left - 10, y: y(v) + 4, class: 'ytick' }, svg).textContent = pctLabel(v, step);
    }

    const span = t1 - t0;
    const ticks: number[] = [];
    if (span > 500 * 864e5) for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) ticks.push(Date.UTC(yr, 0, 1));
    else if (span > 0) for (let i = 0; i <= (narrow ? 2 : 4); i++) ticks.push(t0 + (span * i) / (narrow ? 2 : 4));
    else ticks.push(t0);
    for (const t of ticks) {
      el('text', { x: x(t), y: height - 8, class: 'xtick' }, svg).textContent =
        span > 500 * 864e5 ? String(new Date(t).getUTCFullYear()) : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    lines = [];
    areas = [];
    labels = [];
    const ends: { y: number; i: number }[] = [];
    const gAreas = el('g', {}, svg);
    const gLines = el('g', {}, svg);
    data.series.forEach((s, i) => {
      if (hidden.has(i)) {
        lines.push(el('path', { d: '' }));
        areas.push(el('path', { d: '' }));
        return;
      }
      const pts = idx.filter((j) => s.values[j] !== null).map((j) => [x(times[j]), y(s.values[j]!)] as const);
      let d = '';
      let pen = false;
      for (const j of idx) {
        const v = s.values[j];
        if (v === null) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(times[j]).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      const area = pts.length > 1 ? `M${pts[0][0]},${plotBottom}` + pts.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('') + `L${pts.at(-1)![0]},${plotBottom}Z` : '';
      areas.push(el('path', { d: area, class: 'area', style: `fill:${color(i, single)}` }, gAreas));
      const line = el('path', { d, class: 'line', style: `stroke:${color(i, single)}` }, gLines);
      line.addEventListener('pointerenter', () => setFocus(i));
      line.addEventListener('pointerleave', () => setFocus(null));
      lines.push(line);
      if (pts.length) {
        el('circle', { cx: pts.at(-1)![0], cy: pts.at(-1)![1], r: 4, class: 'end', style: `fill:${color(i, single)}` }, gLines);
        ends.push({ y: pts.at(-1)![1], i });
      }
    });

    if (direct) {
      ends.sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 18) ends[k].y = ends[k - 1].y + 18;
      for (const e of ends) {
        const s = data.series[e.i];
        const t = el('text', { x: width - m.right + 12, y: e.y + 5, class: 'direct', 'data-i': e.i, style: `font-family:${fam(s)}` }, svg);
        t.textContent = s.label.length > 16 ? s.label.slice(0, 15) + '…' : s.label;
        labels.push(t);
      }
    }

    if (!drawn && !reduceMotion()) {
      drawn = true;
      for (const l of lines) {
        const len = l.getTotalLength?.() ?? 0;
        if (!len) continue;
        l.style.strokeDasharray = `${len}`;
        l.style.strokeDashoffset = `${len}`;
        l.getBoundingClientRect();
        l.style.transition = 'stroke-dashoffset 1100ms cubic-bezier(.2,.7,.2,1)';
        l.style.strokeDashoffset = '0';
        l.addEventListener('transitionend', () => {
          l.style.strokeDasharray = '';
          l.style.transition = '';
        });
      }
    }
    drawn = true;

    const cross = el('line', { y1: m.top, y2: plotBottom, class: 'cross', visibility: 'hidden' }, svg);
    const dots = data.series.map((s, i) => el('circle', { r: 5, class: 'hover-dot', style: `fill:${color(i, single)}`, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.left, y: 0, width: Math.max(width - m.left - m.right, 1), height, class: 'hit', tabindex: 0 }, svg);
    hit.setAttribute('aria-label', 'Chart. Use left and right arrow keys to move through time.');

    const show = (j: number) => {
      hoverIndex = j;
      const cx = x(times[j]);
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      cross.setAttribute('visibility', 'visible');
      const rows = visible
        .map((i) => ({ i, s: data.series[i], v: data.series[i].values[j] }))
        .filter((r) => r.v !== null)
        .sort((a, b) => b.v! - a.v!);
      dots.forEach((d, i) => {
        const v = data.series[i].values[j];
        const on = v !== null && !hidden.has(i);
        d.setAttribute('visibility', on ? 'visible' : 'hidden');
        if (on) {
          d.setAttribute('cx', String(cx));
          d.setAttribute('cy', String(y(v!)));
        }
      });
      tip.replaceChildren(html('div', 'tip-h', data.labels[j]));
      for (const r of rows) {
        const row = html('div', 'tip-r');
        const sw = html('span', 'sw');
        sw.style.background = color(r.i, single);
        const name = html('span', 'tip-name', r.s.label);
        name.style.fontFamily = fam(r.s);
        row.append(sw, name, html('b', undefined, `${(r.v! * 100).toFixed(1)}%`));
        tip.append(row);
      }
      if (!rows.length) tip.append(html('div', 'tip-empty', 'Too few sites sampled'));
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${cx + 16 + tw > width ? cx - tw - 16 : cx + 16}px`;
    };
    const hide = () => {
      hoverIndex = null;
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    };
    const nearest = (px: number) => idx.reduce((best, j) => (Math.abs(x(times[j]) - px) < Math.abs(x(times[best]) - px) ? j : best), idx[0]);
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX - svg.getBoundingClientRect().left)));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const pos = hoverIndex === null ? idx.length - 1 : idx.indexOf(hoverIndex) + (e.key === 'ArrowRight' ? 1 : -1);
      show(idx[Math.max(0, Math.min(idx.length - 1, pos))]);
    });
    setFocus(focus);
  }

  let last = 0;
  new ResizeObserver(() => {
    if (stage.clientWidth !== last) {
      last = stage.clientWidth;
      render();
    }
  }).observe(stage);
  return { render };
}

export const renderTrend = (root: HTMLElement, data: Payload) => mountTrend(root, data);
