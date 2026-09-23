export type Tile<T> = { item: T; x: number; y: number; w: number; h: number };

export function squarify<T>(items: T[], value: (t: T) => number, width: number, height: number): Tile<T>[] {
  const total = items.reduce((a, t) => a + value(t), 0) || 1;
  const scale = (width * height) / total;
  const nodes = items.map((item) => ({ item, area: value(item) * scale })).filter((n) => n.area > 0);
  const out: Tile<T>[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  const worst = (row: { area: number }[], side: number) => {
    const s = row.reduce((a, n) => a + n.area, 0);
    const max = Math.max(...row.map((n) => n.area));
    const min = Math.min(...row.map((n) => n.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  let row: typeof nodes = [];
  const layout = () => {
    const s = row.reduce((a, n) => a + n.area, 0);
    if (w >= h) {
      const cw = s / h;
      let cy = y;
      for (const n of row) {
        const nh = n.area / cw;
        out.push({ item: n.item, x, y: cy, w: cw, h: nh });
        cy += nh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let cx = x;
      for (const n of row) {
        const nw = n.area / rh;
        out.push({ item: n.item, x: cx, y, w: nw, h: rh });
        cx += nw;
      }
      y += rh;
      h -= rh;
    }
    row = [];
  };
  for (const n of nodes) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, n], side) <= worst(row, side)) row.push(n);
    else {
      layout();
      row.push(n);
    }
  }
  if (row.length) layout();
  return out;
}
