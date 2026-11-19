type Point = [number, number];
type Segment = { command: "L" | "Q" | "C"; points: Point[]; length: number };
type Move = { command: "M"; points: [Point]; length: 0 };
type Part = Segment | Move;

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function split(points: Point[], t: number): Point[] {
  const left = [points[0]!]; let row = points;
  while (row.length > 1) { row = row.slice(0, -1).map((point, i) => lerp(point, row[i + 1]!, t)); left.push(row[0]!); }
  return left;
}
function length(points: Point[]): number {
  if (points.length === 2) return Math.hypot(points[1]![0] - points[0]![0], points[1]![1] - points[0]![1]);
  let total = 0, previous = points[0]!;
  for (let i = 1; i <= 24; i++) {
    const point = split(points, i / 24).at(-1)!;
    total += Math.hypot(point[0] - previous[0], point[1] - previous[1]); previous = point;
  }
  return total;
}

const COMMANDS = "MLHVQCSTAZmlhvqcstaz";
const COORDINATE_LIMIT = 10000;
const SEGMENT_LIMIT = 512;

function bounded(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT) throw new Error("Path coordinate out of range");
  return value;
}

/**
 * SVG elliptical arc (F.6.5) flattened into cubic segments [c1, c2, end] — the
 * caller's segment() prepends the shared start point — so the length/split
 * pipeline below stays untouched. Zero radii degrade to a line; undersized
 * radii are scaled per the endpoint-to-center conversion.
 */
function arcSegments(from: Point, to: Point, rx: number, ry: number, rotationDeg: number, largeArc: boolean, sweep: boolean): Point[][] {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  if (!rx || !ry) return [[[from[0]! * 2 / 3 + to[0]! / 3, from[1]! * 2 / 3 + to[1]! / 3], [from[0]! / 3 + to[0]! * 2 / 3, from[1]! / 3 + to[1]! * 2 / 3], to]];
  const phi = (rotationDeg % 360) * Math.PI / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx = (from[0]! - to[0]!) / 2, dy = (from[1]! - to[1]!) / 2;
  const x1p = cosPhi * dx + sinPhi * dy, y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lambda > 1) { const scale = Math.sqrt(lambda); rx *= scale; ry *= scale; }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = factor * rx * y1p / ry, cyp = -factor * ry * x1p / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from[0]! + to[0]!) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from[1]! + to[1]!) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy, cross = ux * vy - uy * vx;
    return Math.sign(cross || 1) * Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
  };
  const px = (x1p - cxp) / rx, py = (y1p - cyp) / ry;
  const start = angle(1, 0, px, py);
  let delta = angle(px, py, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const point = (theta: number): Point => [cx + rx * cosPhi * Math.cos(theta) - ry * sinPhi * Math.sin(theta), cy + rx * sinPhi * Math.cos(theta) + ry * cosPhi * Math.sin(theta)];
  const derivative = (theta: number): Point => [-rx * cosPhi * Math.sin(theta) - ry * sinPhi * Math.cos(theta), -rx * sinPhi * Math.sin(theta) + ry * cosPhi * Math.cos(theta)];
  const segments: Point[][] = [];
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  if (!Number.isFinite(pieces)) throw new Error("Invalid arc geometry");
  let previous = start;
  for (let index = 1; index <= pieces; index++) {
    const theta = start + delta * index / pieces;
    const tangent = 4 / 3 * Math.tan((theta - previous) / 4);
    const first = point(previous), second = point(theta), dFirst = derivative(previous), dSecond = derivative(theta);
    segments.push([[first[0]! + tangent * dFirst[0]!, first[1]! + tangent * dFirst[1]!], [second[0]! - tangent * dSecond[0]!, second[1]! - tangent * dSecond[1]!], index === pieces ? to : second]);
    previous = theta;
  }
  return segments;
}

/** Supported subset: absolute or relative M/L/H/V/Q/C/S/T/A/Z; arc flags must be separate tokens (compact flags are unsupported). No SVG markup, attributes, links or expressions. */
const cache = new Map<string, Part[]>();
function parsePath(d: string): Part[] {
  const cached = cache.get(d); if (cached) return cached;
  if (!d || d.length > 8192) throw new Error("Path is empty or too long");
  const tokens: string[] = []; const matcher = new RegExp(`[${COMMANDS}]|[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?`, "g");
  let end = 0;
  for (const match of d.matchAll(matcher)) {
    if (!/^[\s,]*$/.test(d.slice(end, match.index))) throw new Error("Unsupported path syntax");
    tokens.push(match[0]); end = match.index! + match[0].length;
  }
  if (!/^[\s,]*$/.test(d.slice(end)) || !/^[Mm]$/.test(tokens[0]!)) throw new Error("Path must start with M");
  let cursor = 0, current: Point = [0, 0], origin: Point = current, command = "";
  // Only a preceding cubic or quadratic command may supply its respective reflection.
  let lastCubicControl: Point | null = null, lastQuadraticControl: Point | null = null;
  const parts: Part[] = [];
  const number = (): number => {
    const token = tokens[cursor++];
    if (token === undefined || new RegExp(`^[${COMMANDS}]$`).test(token)) throw new Error("Incomplete path command");
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("Path coordinate out of range");
    return value;
  };
  const flag = (): boolean => {
    const token = tokens[cursor++];
    if (token !== "0" && token !== "1") throw new Error("Arc flag must be 0 or 1 as a separate token");
    return token === "1";
  };
  const point = (relative: boolean): Point => {
    const x = number(), y = number();
    return [bounded(relative ? current[0]! + x : x), bounded(relative ? current[1]! + y : y)];
  };
  const segment = (kind: Segment["command"], controls: Point[]) => {
    if (parts.length >= SEGMENT_LIMIT) throw new Error("Too many path segments");
    for (const control of controls) { bounded(control[0]); bounded(control[1]); }
    const points = [current, ...controls]; parts.push({ command: kind, points, length: length(points) }); current = points.at(-1)!;
  };
  while (cursor < tokens.length) {
    if (parts.length >= SEGMENT_LIMIT) throw new Error("Too many path segments");
    if (new RegExp(`^[${COMMANDS}]$`).test(tokens[cursor]!)) command = tokens[cursor++]!;
    const relative = command >= "a" && command <= "z";
    switch (command) {
      case "Z": case "z": {
        segment("L", [origin]); current = origin; command = ""; lastCubicControl = lastQuadraticControl = null; continue;
      }
      case "M": case "m": {
        current = point(relative); origin = current; parts.push({ command: "M", points: [current], length: 0 }); command = relative ? "l" : "L"; lastCubicControl = lastQuadraticControl = null; continue;
      }
      case "L": case "l": {
        segment("L", [point(relative)]); lastCubicControl = lastQuadraticControl = null; continue;
      }
      case "H": case "h": {
        const x = bounded(relative ? current[0]! + number() : number());
        segment("L", [[x, current[1]!]]); lastCubicControl = lastQuadraticControl = null; continue;
      }
      case "V": case "v": {
        const y = bounded(relative ? current[1]! + number() : number());
        segment("L", [[current[0]!, y]]); lastCubicControl = lastQuadraticControl = null; continue;
      }
      case "Q": case "q": {
        const control = point(relative), end_ = point(relative);
        segment("Q", [control, end_]); lastQuadraticControl = control; lastCubicControl = null; continue;
      }
      case "T": case "t": {
        const control: Point = lastQuadraticControl ? ([2 * current[0]! - lastQuadraticControl[0]!, 2 * current[1]! - lastQuadraticControl[1]!]) : current;
        const end_ = point(relative);
        segment("Q", [control, end_]); lastQuadraticControl = control; lastCubicControl = null; continue;
      }
      case "C": case "c": {
        const first = point(relative), second = point(relative), end_ = point(relative);
        segment("C", [first, second, end_]); lastCubicControl = second; lastQuadraticControl = null; continue;
      }
      case "S": case "s": {
        const first: Point = lastCubicControl ? ([2 * current[0]! - lastCubicControl[0]!, 2 * current[1]! - lastCubicControl[1]!]) : current;
        const second = point(relative), end_ = point(relative);
        segment("C", [first, second, end_]); lastCubicControl = second; lastQuadraticControl = null; continue;
      }
      case "A": case "a": {
        const rx = Math.abs(bounded(number())), ry = Math.abs(bounded(number())), rotation = bounded(number());
        const largeArc = flag(), sweep = flag();
        const target = point(relative);
        for (const controls of arcSegments(current, target, rx, ry, rotation, largeArc, sweep)) segment("C", controls);
        lastCubicControl = lastQuadraticControl = null; continue;
      }
      default: throw new Error("Path command required");
    }
  }
  if (!parts.some(part => part.length > 0)) throw new Error("Path needs a visible segment");
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(d, parts);
  return parts;
}

type MorphPart = { command: string; values: number[] };
const morphCache = new Map<string, MorphPart[]>();

/** Strict explicit commands preserve subpaths and closures; no topology inference or executable SVG. */
function parseMorphPath(d: string): MorphPart[] {
  const cached = morphCache.get(d); if (cached) return cached;
  if (d.length > 4096 || !isStrokePath(d)) throw new Error("Invalid morph path");
  const matcher = /[MLQCZ]|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
  const tokens: string[] = []; let end = 0;
  for (const match of d.matchAll(matcher)) {
    if (!/^[\s,]*$/.test(d.slice(end, match.index))) throw new Error("Unsupported morph command");
    tokens.push(match[0]); end = match.index! + match[0].length;
  }
  if (!/^[\s,]*$/.test(d.slice(end))) throw new Error("Unsupported morph command");
  const arity: Record<string, number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const parts: MorphPart[] = []; let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++]!, count = arity[command];
    if (count === undefined || (!parts.length && command !== "M") || parts.length >= 128) throw new Error("Unsupported morph topology");
    const values = tokens.slice(i, i + count).map(Number);
    if (values.length !== count || values.some(value => !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT)) throw new Error("Invalid morph coordinates");
    i += count; parts.push({ command, values });
  }
  if (morphCache.size >= 64) morphCache.delete(morphCache.keys().next().value!);
  morphCache.set(d, parts); return parts;
}

export function compatibleMorphPaths(from: string, to: string): boolean {
  try {
    const a = parseMorphPath(from), b = parseMorphPath(to);
    return a.length === b.length && a.every((part, i) => part.command === b[i]!.command);
  } catch { return false; }
}

export function interpolateMorphPath(from: string, to: string, progress: number): string {
  if (!Number.isFinite(progress) || !compatibleMorphPaths(from, to)) throw new Error("Incompatible morph paths");
  const t = Math.max(0, Math.min(1, progress));
  if (t === 0) return from;
  if (t === 1) return to;
  const a = parseMorphPath(from), b = parseMorphPath(to);
  return a.map((part, i) => `${part.command}${part.values.map((value, j) => Number((value + (b[i]!.values[j]! - value) * t).toFixed(4))).join(" ")}`).join(" ");
}

export function isStrokePath(d: string): boolean { try { parsePath(d); return true; } catch { return false; } }

const coordinate = (value: number) => Number(value.toFixed(4));
const format = (point: Point) => `${coordinate(point[0])} ${coordinate(point[1])}`;

/** Frame-driven draw-on; shared curve splitting avoids browser/SVG dash differences. */
export function strokePathAt(d: string, progress: number): string {
  if (!Number.isFinite(progress)) throw new Error("Stroke progress must be finite");
  const parts = parsePath(d);
  let remaining = parts.reduce((sum, part) => sum + part.length, 0) * Math.max(0, Math.min(1, progress));
  if (remaining <= 0) return "";
  const result: string[] = [];
  for (const part of parts) {
    if (part.command === "M") { result.push(`M${format(part.points[0])}`); continue; }
    if (!part.length) continue;
    if (remaining >= part.length - 1e-8) {
      result.push(`${part.command}${part.points.slice(1).map(format).join(" ")}`); remaining -= part.length;
    } else {
      if (part.command === "L") { result.push(`L${format(lerp(part.points[0]!, part.points[1]!, remaining / part.length))}`); break; }
      let low = 0, high = 1;
      for (let i = 0; i < 16; i++) {
        const middle = (low + high) / 2;
        if (length(split(part.points, middle)) < remaining) low = middle; else high = middle;
      }
      result.push(`${part.command}${split(part.points, (low + high) / 2).slice(1).map(format).join(" ")}`); break;
    }
    if (remaining <= 1e-8) break;
  }
  return result.join(" ");
}

export function strokeProgress(element: { drawStartMs?: number; drawDurationMs?: number }, timeMs: number): number {
  if (!Number.isFinite(timeMs)) throw new Error("Stroke time must be finite");
  if (element.drawStartMs !== undefined && !Number.isFinite(element.drawStartMs)) throw new Error("Stroke start must be finite");
  if (element.drawDurationMs !== undefined && (!Number.isFinite(element.drawDurationMs) || element.drawDurationMs <= 0)) throw new Error("Stroke duration must be finite and positive");
  return element.drawDurationMs === undefined ? 1 : Math.max(0, Math.min(1, (timeMs - (element.drawStartMs ?? 0)) / element.drawDurationMs));
}
