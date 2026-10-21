// Small SVG bar chart: grouped or stacked, with hover tooltip. No dependencies.

export interface BarSeries {
  name: string;
  color: string; // CSS color, may be var(--x)
  values: (number | null)[];
}

export interface BarOptions {
  labels: string[]; // one per group, e.g. YYYY-MM-DD
  series: BarSeries[];
  stacked?: boolean;
  unit?: string;
  height?: number;
}

const M = { top: 10, right: 8, bottom: 26, left: 44 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
  return 10 * p;
}

export function barChart(el: HTMLElement, opts: BarOptions): void {
  const render = () => draw(el, opts);
  render();
  if (!(el as any).__ro) {
    const ro = new ResizeObserver(() => draw(el, (el as any).__opts));
    ro.observe(el);
    (el as any).__ro = ro;
  }
  (el as any).__opts = opts;
}

function draw(el: HTMLElement, o: BarOptions): void {
  const W = Math.max(el.clientWidth, 320);
  const H = o.height ?? 240;
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const n = o.labels.length;
  const unit = o.unit ?? "";

  const tops = o.labels.map((_, i) =>
    o.stacked ? o.series.reduce((s, x) => s + (x.values[i] ?? 0), 0) : Math.max(...o.series.map((x) => x.values[i] ?? 0)),
  );
  const ymax = niceMax(Math.max(0, ...tops));
  const y = (v: number) => M.top + ph - (v / ymax) * ph;

  const gw = n ? pw / n : pw;
  const inner = gw * 0.72;
  const bw = o.stacked ? inner : (inner - 2 * (o.series.length - 1)) / o.series.length;

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
  // grid + y labels
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = (ymax / ticks) * t;
    const yy = y(v);
    s += `<line x1="${M.left}" x2="${W - M.right}" y1="${yy}" y2="${yy}" stroke="var(--border)" stroke-width="1"/>`;
    s += `<text x="${M.left - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--text-3)">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`;
  }
  // bars
  for (let i = 0; i < n; i++) {
    const gx = M.left + i * gw + (gw - inner) / 2;
    let acc = 0;
    o.series.forEach((ser, k) => {
      const v = ser.values[i];
      if (v == null || v <= 0) return;
      const x = o.stacked ? gx : gx + k * (bw + 2);
      const y0 = o.stacked ? y(acc + v) : y(v);
      const y1 = o.stacked ? y(acc) - (acc > 0 ? 2 : 0) : y(0);
      const h = Math.max(0, y1 - y0);
      s += `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${ser.color}"/>`;
      if (o.stacked) acc += v;
    });
  }
  // x labels: day number, thinned to avoid collisions
  const every = Math.max(1, Math.ceil((n * 26) / pw));
  for (let i = 0; i < n; i++) {
    if (i % every) continue;
    const lab = o.labels[i];
    s += `<text x="${M.left + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-3)">${lab.slice(-2)}</text>`;
  }
  // hover targets
  for (let i = 0; i < n; i++) {
    s += `<rect data-i="${i}" x="${M.left + i * gw}" y="${M.top}" width="${gw}" height="${ph}" fill="transparent"/>`;
  }
  s += "</svg>";

  el.classList.add("chart");
  el.innerHTML = s + `<div class="tooltip"></div>`;
  const tip = el.querySelector<HTMLDivElement>(".tooltip")!;
  const svg = el.querySelector("svg")!;
  svg.addEventListener("mousemove", (e) => {
    const t = e.target as SVGElement;
    const i = Number(t.dataset?.i);
    if (!t.dataset?.i) {
      tip.style.display = "none";
      return;
    }
    const lines = o.series.map((ser) => `${ser.name}: <b>${fmt(ser.values[i])} ${unit}</b>`);
    if (o.stacked) lines.push(`Total: <b>${fmt(tops[i])} ${unit}</b>`);
    tip.innerHTML = `<div>${o.labels[i]}</div>${lines.join("<br>")}`;
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left;
    tip.style.left = `${Math.min(px + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${e.clientY - r.top - tip.offsetHeight - 10}px`;
  });
  svg.addEventListener("mouseleave", () => (tip.style.display = "none"));
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "–";
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}
