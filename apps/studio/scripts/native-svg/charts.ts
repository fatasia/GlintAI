import type { ChartScene } from "@glintai/scenescript";
import type { DesignTokens } from "@glintai/design-tokens";
import { textBlock, xml, eased } from "./text";

const number = (v: number) => Number(v.toPrecision(4));

export function renderChart(scene: ChartScene, frame: number, fps: number, w: number, h: number, theme: DesignTokens): string {
  const c = theme.colors;
  const all = scene.data;
  const pie = scene.chartType === "pie";
  const pageCount = pie ? 1 : Math.ceil(all.length / 6);
  const duration = scene.narration.durationMs ?? 6000;
  const pageFrames = Math.max(1, Math.round(duration * fps / 1000 / pageCount));
  const page = Math.min(pageCount - 1, Math.floor(frame / pageFrames));
  const data = pie ? all : all.slice(page * 6, page * 6 + 6);
  const p = eased((frame - page * pageFrames) / Math.min(fps * 1.2, pageFrames * 0.6));
  const top = h * 0.28, bottom = h * 0.71, left = w * 0.16, right = w * 0.84;
  const size = Math.max(16, Math.min(w, h) * 0.025);
  const label = (s: string, x: number, y: number, anchor = "middle", fill = c.text) =>
    textBlock(s, x, y, w * 0.2, size, fill, { anchor, height: h * 0.09 });
  if (pie) {
    const total = all.reduce((sum, d) => sum + Math.max(0, d.value), 0);
    if (total === 0) return label("暂无正值数据", w / 2, h / 2);
    const cx = w * (w < h ? 0.5 : 0.38), cy = h * 0.5, radius = Math.min(w * 0.22, h * 0.22);
    let angle = -Math.PI / 2;
    let svg = "";
    for (const [i, d] of all.entries()) {
      const share = Math.max(0, d.value) / total;
      const sweep = Math.min(Math.PI * 2 - 0.00001, share * Math.PI * 2 * p);
      const end = angle + sweep, inner = radius * 0.58;
      const point = (r: number, a: number) => `${cx + Math.cos(a) * r},${cy + Math.sin(a) * r}`;
      const color = i % 2 ? c.accent2 : c.accent;
      if (share > 0) svg += `<path d="M ${point(radius, angle)} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${sweep > Math.PI ? 1 : 0} 0 ${point(inner, angle)} Z" fill="${xml(color)}" opacity="${0.55 + (i % 3) * 0.2}"/>`;
      angle += share * Math.PI * 2;
    }
    const legendX = w < h ? w * 0.16 : w * 0.66, legendY = w < h ? h * 0.77 : top;
    const available = w < h ? h * 0.13 : h * 0.45;
    const columns = Math.ceil(all.length / (w < h ? 4 : 8));
    const rows = Math.ceil(all.length / columns);
    const rowSize = Math.min(size, available / rows / 1.5);
    return svg + all.map((d, i) => textBlock(`${d.label} · ${number(Math.max(0, d.value) / total * 100)}%`, legendX + Math.floor(i / rows) * w * (w < h ? 0.36 : 0.15), legendY + (i % rows) * rowSize * 1.5, w * 0.28, rowSize, i % 2 ? c.accent2 : c.accent)).join("");
  }
  const domain = (values: number[]) => {
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    return { min, max: max === min ? max + 1 : max };
  };
  const primary = domain(all.map(d => scene.chartType === "scatter" ? d.value2! : d.value));
  const y = (v: number) => bottom - (v - primary.min) / (primary.max - primary.min) * (bottom - top);
  const x = (i: number) => left + (right - left) * (i + 0.5) / data.length;
  let svg = [primary.min, (primary.min + primary.max) / 2, primary.max].map(v => `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="${c.border}"/>${label(`${number(v)}${scene.unit ?? ""}`, left - 16, y(v) + size / 3, "end")}`).join("");
  if (scene.chartType === "scatter") {
    const xs = all.map(d => d.value), min = Math.min(...xs), max = Math.max(...xs), span = max - min || 1;
    const sx = (v: number) => left + (v - min) / span * (right - left);
    svg += [min, (min + max) / 2, max].map(v => label(String(number(v)), sx(v), bottom + size * 1.7)).join("");
    svg += data.map((d, i) => `<g opacity="${eased(p * data.length - i)}"><circle cx="${sx(d.value)}" cy="${y(d.value2!)}" r="${size * 0.3}" fill="${c.accent}"/>${label(d.label, sx(d.value), y(d.value2!) - size)}</g>`).join("");
  } else {
    const points = data.map((d, i) => `${x(i)},${y(d.value * p)}`).join(" ");
    if (scene.chartType === "area") svg += `<polygon points="${x(0)},${y(0)} ${points} ${x(data.length - 1)},${y(0)}" fill="${c.accent}" opacity="0.18"/>`;
    if (scene.chartType === "line" || scene.chartType === "area") svg += `<polyline points="${points}" fill="none" stroke="${c.accent}" stroke-width="5" stroke-linejoin="round"/>`;
    svg += data.map((d, i) => {
      const yy = y(d.value * p), zero = y(0), bw = Math.min(w * 0.085, (right - left) / data.length * 0.55);
      const shape = scene.chartType === "bar" || scene.chartType === "combo"
        ? `<rect x="${x(i) - bw / 2}" y="${Math.min(yy, zero)}" width="${bw}" height="${Math.abs(yy - zero)}" rx="6" fill="${c.accent}"/>`
        : `<circle cx="${x(i)}" cy="${yy}" r="5" fill="${c.accent}"/>`;
      return shape + label(d.label, x(i), bottom + size * 1.7) + (scene.chartType === "combo" ? "" : label(String(number(d.value)), x(i), yy + (d.value < 0 ? size * 1.5 : -size * 0.7)));
    }).join("");
    if (scene.chartType === "combo") {
      const d2 = domain(all.map(d => d.value2!));
      const y2 = (v: number) => bottom - (v - d2.min) / (d2.max - d2.min) * (bottom - top);
      svg += `<polyline points="${data.map((d, i) => `${x(i)},${y2(d.value2! * p)}`).join(" ")}" fill="none" stroke="${c.accent2}" stroke-width="5"/>`;
      svg += [d2.min, (d2.min + d2.max) / 2, d2.max].map(v => label(String(number(v)), right + 12, y2(v) + size / 3, "start", c.accent2)).join("");
    }
  }
  if (pageCount > 1) svg += label(`${page + 1} / ${pageCount}`, right, h * 0.84, "end", c.textMuted);
  if (scene.seriesLabel2) svg += label(scene.seriesLabel2, left, top - size * 1.7, "start", c.accent2);
  return svg;
}
