export function xml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

export function wrapText(value: string, width: number, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "", used = 0;
    for (const ch of Array.from(paragraph)) {
      const weight = /[\u2e80-\uffff]/u.test(ch) ? size : size * 0.6;
      if (used + weight > width && line) { lines.push(line); line = ""; used = 0; }
      line += ch; used += weight;
    }
    lines.push(line);
  }
  return lines;
}

export function textBlock(value: string, x: number, y: number, width: number, size: number, color: string, options: { height?: number; weight?: number; anchor?: string; family?: string } = {}): string {
  let lines = wrapText(value, width, size);
  while (options.height && lines.length * size * 1.45 > options.height && size > 14) {
    size -= 2; lines = wrapText(value, width, size);
  }
  return `<text fill="${xml(color)}" font-size="${size}" font-weight="${options.weight ?? 400}" text-anchor="${options.anchor ?? "start"}"${options.family ? ` font-family="${xml(options.family)}"` : ""}>${lines.map((line, i) => `<tspan x="${x}" y="${y + i * size * 1.45}">${xml(line)}</tspan>`).join("")}</text>`;
}

export const mix = (a: number, b: number, p: number) => a + (b - a) * p;
export const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const eased = (value: number) => 1 - Math.pow(1 - clamp(value), 3);
