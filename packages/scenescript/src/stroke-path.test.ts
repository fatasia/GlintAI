import { expect, it } from "vitest";
import { isStrokePath, strokePathAt, strokeProgress } from "./stroke-path";
import { SceneElement, parseProject } from "./index";

it("accepts bounded curves in every supported command and rejects markup, incomplete paths and stray syntax", () => {
  for (const d of [
    "M0 0 L100 20 200 30 Z", "M.5 0 Q20 100 50 0 C60 0 70 20 90 10", "M1e2 -1e2 L200 0",
    "M0 0 H100 V50 Z", "M0 0 h10 v5 h-10 z", "M0 0 L10 0 l10 0",
    "M0 0 Q10 10 20 0 T40 0", "M0 0 q10 10 20 0 t20 0",
    "M0 0 C10 10 20 10 30 0 S50 -10 60 0", "M0 0 c5 5 10 5 15 0 s10 -5 15 0",
    "M0 0 A50 50 0 0 1 100 0", "M0 0 a50 50 0 1 0 100 0", "M0 0 A0 0 0 0 0 100 0",
  ]) expect(isStrokePath(d), d).toBe(true);
  for (const d of ["M0 0", "L0 0 L100 0", "M0 0 C1 2", "M0 0 L", "M0 0 LInfinity 1", "M0 0 L10001 1", "M0 0 A50 50 0 0 0 1", 'M0 0 L1 1" onload="alert(1)', "<svg/>", "M0 0 L0 0", "M0 0 A50 50 0 0 0 1e99 1e99", "M0 0 L100 0 M200 200 l 50001 0"]) expect(isStrokePath(d), d).toBe(false);
});

it("reveals line distance rather than segment count and does not bridge subpaths", () => {
  const d = "M0 0 L100 0 L100 300";
  expect(strokePathAt(d, 0)).toBe("");
  expect(strokePathAt(d, 0.25)).toBe("M0 0 L100 0");
  expect(strokePathAt(d, 0.5)).toMatch(/^M0 0 L100 0 L100 100/);
  expect(strokePathAt(d, 1)).toBe(d);
  expect(strokePathAt("M0 0 L10 0 M30 0 L40 0", 0.75)).toMatch(/^M0 0 L10 0 M30 0 L35/);
});

it("rejects non-finite sampling inputs instead of emitting invalid SVG geometry", () => {
  for (const path of ["M0 0 L100 0", "M0 0 Q50 100 100 0", "M0 0 A50 50 0 0 1 100 0"]) {
    for (const progress of [NaN, Infinity, -Infinity]) {
      expect(() => strokePathAt(path, progress)).toThrow(/progress.*finite/i);
    }
    expect(strokePathAt(path, -1)).toBe("");
    expect(strokePathAt(path, 2)).toBe(strokePathAt(path, 1));
    expect(strokePathAt(path, 0.5)).not.toMatch(/NaN|Infinity/);
  }
  for (const time of [NaN, Infinity, -Infinity]) {
    expect(() => strokeProgress({}, time)).toThrow(/time.*finite/i);
    expect(() => strokeProgress({ drawDurationMs: 100 }, time)).toThrow(/time.*finite/i);
  }
  for (const duration of [0, -1, NaN, Infinity, -Infinity]) {
    expect(() => strokeProgress({ drawDurationMs: duration }, 0)).toThrow(/duration/i);
  }
  for (const start of [NaN, Infinity, -Infinity]) {
    expect(() => strokeProgress({ drawStartMs: start, drawDurationMs: 100 }, 0)).toThrow(/start/i);
  }
  expect(strokeProgress({ drawStartMs: 100, drawDurationMs: 100 }, 150)).toBe(0.5);
});

it("splits bezier curves deterministically and preserves full endpoints and closing segments", () => {
  const d = "M0 0 Q50 100 100 0 C110 10 120 10 130 0 Z";
  const half = strokePathAt(d, 0.5);
  expect(half).toContain("Q"); expect(half).not.toContain("NaN");
  expect(strokePathAt(d, 0.5)).toBe(half);
  expect(strokePathAt(d, 1)).toBe("M0 0 Q50 100 100 0 C110 10 120 10 130 0 L0 0");
  expect(strokeProgress({ drawStartMs: 400, drawDurationMs: 800 }, 200)).toBe(0);
  expect(strokeProgress({ drawStartMs: 400, drawDurationMs: 800 }, 800)).toBe(0.5);
  expect(strokeProgress({}, 0)).toBe(1);
});

it("treats relative commands, H/V and S/T as their absolute equivalents", () => {
  expect(strokePathAt("M10 10 l20 5 h10 v5", 1)).toBe(strokePathAt("M10 10 L30 15 H40 V20", 1));
  expect(strokePathAt("M0 0 Q10 10 20 0 T40 0 T60 0", 1)).toBe(strokePathAt("M0 0 Q10 10 20 0 Q30 -10 40 0 Q50 10 60 0", 1));
  expect(strokePathAt("M0 0 C10 10 20 10 30 0 S50 -10 60 0", 1)).toBe(strokePathAt("M0 0 C10 10 20 10 30 0 C40 -10 50 -10 60 0", 1));
  // After M/L the smooth reflection falls back to the current point.
  expect(strokePathAt("M0 0 S10 10 20 0 T30 0", 1)).toBe(strokePathAt("M0 0 C0 0 10 10 20 0 Q20 0 30 0", 1));
  expect(strokePathAt("M0 0 L10 0 z M20 0 L30 0 z", 1)).toBe("M0 0 L10 0 L0 0 M20 0 L30 0 L20 0");
  // A closepath back to the origin adds no visible length on its own.
  expect(isStrokePath("M0 0 z M10 0 z")).toBe(false);
});

it("flattens elliptical arcs onto their circle within sampling error and draws by arc length", () => {
  // Endpoint distance equals the diameter: an exact half circle on r=50 around (50,0).
  // Control points sit on the tangents, so sample each cubic's midpoint instead.
  const halfCircle = strokePathAt("M0 0 A50 50 0 0 1 100 0", 1);
  let cursor: [number, number] = [0, 0];
  for (const match of halfCircle.matchAll(/[C]((?:\s*[-\d.]+){6})/g)) {
    const v = match[1]!.trim().split(/\s+/).map(Number);
    const mid = [(cursor[0]! + 3 * v[0]! + 3 * v[2]! + v[4]!) / 8, (cursor[1]! + 3 * v[1]! + 3 * v[3]! + v[5]!) / 8];
    for (const [x, y] of [cursor, mid, [v[4]!, v[5]!]] as [number, number][]) {
      const radius = Math.hypot(x - 50, y - 0);
      expect(Math.abs(radius - 50), `${x},${y}`).toBeLessThan(0.05);
    }
    cursor = [v[4]!, v[5]!];
  }
  expect(halfCircle.startsWith("M0 0")).toBe(true);
  expect(halfCircle.endsWith("100 0")).toBe(true);
  // Halfway through the draw, roughly half the arc is visible.
  const half = strokePathAt("M0 0 A50 50 0 0 1 100 0", 0.5);
  expect(half).toContain("C");
  expect(half.length).toBeLessThan(halfCircle.length);
  // Oversized endpoints scale radii up per the SVG endpoint-to-center rule.
  const grown = strokePathAt("M0 0 A50 50 0 0 1 100 100", 1);
  expect(grown.startsWith("M0 0")).toBe(true);
  expect(grown.endsWith("100 100")).toBe(true);
  // Zero radii degrade to a straight line; rotated ellipse keeps its endpoints.
  expect(strokePathAt("M0 0 A0 0 0 0 0 100 50", 1)).toBe("M0 0 C33.3333 16.6667 66.6667 33.3333 100 50");
  const rotated = strokePathAt("M0 0 A50 50 30 0 1 100 0", 1);
  expect(rotated.startsWith("M0 0")).toBe(true);
  expect(rotated.endsWith("100 0")).toBe(true);
  // Large-arc flag selects the long way round; both stay on the same circle.
  const small = strokePathAt("M0 0 A50 50 0 0 1 60 0", 1);
  const large = strokePathAt("M0 0 A50 50 0 1 1 60 0", 1);
  expect(large.length).toBeGreaterThan(small.length);
});

it("resets smooth reflection across curve types and bounds reflected controls", () => {
  const pairs = [
    ["M0 0 C1 2 3 4 5 6 Q7 8 9 10 S11 12 13 14", "M0 0 C1 2 3 4 5 6 Q7 8 9 10 C9 10 11 12 13 14"],
    ["M0 0 Q1 2 3 4 C5 6 7 8 9 10 T11 12", "M0 0 Q1 2 3 4 C5 6 7 8 9 10 Q9 10 11 12"],
    ["M0 0 C1 2 3 4 5 6 T7 8 S9 10 11 12", "M0 0 C1 2 3 4 5 6 Q5 6 7 8 C7 8 9 10 11 12"],
    ["M0 0 Q1 2 3 4 S5 6 7 8 T9 10", "M0 0 Q1 2 3 4 C3 4 5 6 7 8 Q7 8 9 10"],
  ];
  for (const [smooth, explicit] of pairs) expect(strokePathAt(smooth!, 1)).toBe(strokePathAt(explicit!, 1));
  for (const d of ["M0 0 Q-10000 0 10000 0 T0 0", "M0 0 C0 0 -10000 0 10000 0 S0 0 1 1"]) {
    expect(isStrokePath(d), d).toBe(false);
    expect(() => strokePathAt(d, 1)).toThrow(/range/);
  }
});

it("validates arc flags and parameters, including numeric extremes and generated controls", () => {
  for (const d of [
    "M0 0 A50 50 0 2 1 100 0", "M0 0 A50 50 0 0 -1 100 0", "M0 0 A50 50 0 1.0 1 100 0",
    "M0 0 A50 50 0 01 100 0", "M0 0 A50 50 0 0 1e0 100 0",
    "M0 0 A10001 50 0 0 1 100 0", "M0 0 A50 10001 0 0 1 100 0", "M0 0 A50 50 10001 0 1 100 0",
    "M0 0 A1e309 50 0 0 1 100 0", "M0 0 A50 50 1e309 0 1 100 0",
    "M0 0 A1e-300 1e-300 0 0 1 100 0", "M-10000 10000 A10000 10000 0 0 0 10000 10000",
  ]) {
    expect(isStrokePath(d), d).toBe(false);
    expect(() => strokePathAt(d, 1), d).toThrow();
  }
  expect(isStrokePath("M0 0 A10000 10000 10000 0 1 1 0")).toBe(true);
});

it("omits coincident endpoint arcs without corrupting later drawing or reflection", () => {
  for (const arc of ["A50 50 0 0 1 10 0", "A0 50 0 1 0 10 0", "a50 50 0 1 1 0 0"]) {
    const d = `M0 0 L10 0 ${arc} S20 10 30 0`;
    expect(strokePathAt(d, 1), d).toBe("M0 0 L10 0 C10 0 20 10 30 0");
    expect(strokePathAt(d, 0.5), d).not.toMatch(/NaN|Infinity/);
  }
  expect(isStrokePath("M0 0 A50 50 0 0 1 0 0")).toBe(false);
  expect(strokePathAt("M0 0 C1 1 2 2 10 0 A50 50 0 0 1 10 0 S20 10 30 0", 1))
    .toBe("M0 0 C1 1 2 2 10 0 C10 0 20 10 30 0");
});

it("enforces the part limit after arc expansion, including the final command", () => {
  const prefix = `M0 0 ${"L1 0 ".repeat(509)}`;
  expect(isStrokePath(`${prefix} A1 1 0 0 1 -1 0`)).toBe(true);
  expect(isStrokePath(`${prefix} L1 0 A1 1 0 0 1 -1 0`)).toBe(false);
  expect(() => strokePathAt(`${prefix} L1 0 A1 1 0 0 1 -1 0`, 1)).toThrow(/segments/);
});

it("limits segment count and validates the serialized element and scene boundary", () => {
  expect(isStrokePath(`M0 0 ${"L1 1 ".repeat(513)}`)).toBe(false);
  expect(isStrokePath(`M0 0 ${"a1 1 0 1 1 2 2 ".repeat(260)}`)).toBe(false);
  const element = { id: "stroke-one", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M100 100 Q200 300 400 200", stroke: "#dbc6a0", strokeWidth: 8, drawDurationMs: 1500 };
  expect(SceneElement.parse(element)).toEqual(element);
  const arcElement = { ...element, id: "stroke-arc", d: "M200 100 A100 100 0 0 1 400 300" };
  expect(SceneElement.parse(arcElement)).toEqual(arcElement);
  const project = { schemaVersion: 1, id: "stroke", title: "Stroke", aspect: "16:9", knowledgeSources: [], scenes: [{ id: "one", kind: "title", title: "Hand drawn", narration: { text: "Hand drawn", durationMs: 2000 }, elements: [element] }] };
  expect(parseProject(project).scenes[0]?.elements?.[0]).toEqual(element);
  expect(() => parseProject({ ...project, scenes: [{ ...project.scenes[0], kind: "image", src: "assets/photo.png" }] })).toThrow(/built-in/);
  expect(() => SceneElement.parse({ ...element, drawDurationMs: 0 })).toThrow();
});
