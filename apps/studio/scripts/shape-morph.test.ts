import { describe, expect, it } from "vitest";
import { compatibleMorphPaths, evaluateMorphElements, interpolateMorphPath, parseProject } from "@glintai/scenescript";
import { renderSceneSvg } from "./native-svg";
import { graphForProject } from "./build";

const rect = (x: number, y: number, w: number, h: number, fill: string, radius: number) => ({ id: "card", kind: "rect", x, y, w, h, fill, radius });
const data = () => ({ schemaVersion: 1, id: "shape-morph", title: "shape", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [
  { id: "one", kind: "title", title: " ", narration: { text: "one", durationMs: 1400 }, elements: [rect(.25, .35, .2, .3, "#ff0000", 12)] },
  { id: "two", kind: "title", title: " ", narration: { text: "two", durationMs: 2600 }, transition: { in: "shape-morph", durationMs: 1000 }, elements: [rect(.7, .65, .5, .15, "#0000ff", 48)] },
] });

describe("shape morph contract", () => {
  it("samples different source and target geometry deterministically including the first and last frames", () => {
    const p = parseProject(data()), [a, b] = p.scenes;
    const at = (time: number) => evaluateMorphElements(b!, a, time)[0]!;
    expect(at(0)).toMatchObject({ x: .25, y: .35, element: { w: .2, h: .3, fill: "#ff0000", radius: 12 } });
    expect(at(500)).toMatchObject({ x: .475, y: .5, element: { w: .35, h: .22499999999999998, fill: "#800080", radius: 30 } });
    expect(at(1000)).toMatchObject({ x: .7, y: .65, element: { w: .5, h: .15, fill: "#0000ff", radius: 48 } });
    const mid = JSON.stringify(at(500)); at(900); at(0); expect(JSON.stringify(at(500))).toBe(mid);
    expect(() => evaluateMorphElements(b!, undefined, 0)).toThrow(/requires its previous scene/);
    expect(() => renderSceneSvg(p, b!, 0)).toThrow(/requires its previous scene/);
    const svg = renderSceneSvg(p, b!, 0, { width: 320, height: 180, previousScene: a });
    expect(svg).toContain('width="64" height="54"');
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('opacity="1"');
  });
  it("rejects ambiguous ids, missing matches, tracks, moving cameras, overlap, and a first-scene morph", () => {
    const cases: ((d: any) => void)[] = [
      d => d.scenes[0].elements.push({ ...d.scenes[0].elements[0] }),
      d => d.scenes[1].elements[0].id = "other",
      d => d.scenes[1].tracks = [{ elementId: "card", property: "x", keyframes: [{ atMs: 0, value: .2 }] }],
      d => d.scenes[0].camera = { type: "push" },
      d => d.scenes[1].transition.overlapMs = 100,
      d => d.scenes.shift(),
      d => d.scenes[0].transition = { in: "fade" },
    ];
    for (const edit of cases) { const d = data(); edit(d); expect(() => parseProject(d)).toThrow(); }
  });
  it("interpolates explicit path topology and preserves closures across random seeks", () => {
    const a = "M0 0 L80 0 Q90 30 80 80 C60 90 20 90 0 80 Z", b = "M10 10 L70 10 Q80 40 70 70 C50 80 30 80 10 70 Z";
    const path = { id: "line", kind: "path", x: .5, y: .5, w: .5, h: .5, d: a, viewBox: [100, 100], stroke: "#ff0000", strokeWidth: 4 };
    const d = data(); (d.scenes[0] as any).elements = [path]; (d.scenes[1] as any).elements = [{ ...path, d: b, stroke: "#0000ff", strokeWidth: 8 }];
    const p = parseProject(d), [first, second] = p.scenes;
    const at = (ms: number) => evaluateMorphElements(second!, first, ms)[0]!.element as typeof path;
    expect(at(0).d).toBe(a); expect(at(1000).d).toBe(b);
    expect(at(500)).toMatchObject({ d: "M5 5 L75 5 Q85 35 75 75 C55 85 25 85 5 75 Z", stroke: "#800080", strokeWidth: 6 });
    const middle = at(500).d; at(900); at(0); expect(at(500).d).toBe(middle);
    expect(renderSceneSvg(p, second!, 15, { width: 320, height: 180, previousScene: first })).toContain(middle);
    for (const invalid of ["M0 0 L80 0 Z", "m0 0 l80 0", "M0 0 H80", "M0 0 L80 0 <script>", "M0 0 L999999 0"]) expect(compatibleMorphPaths(a, invalid)).toBe(false);
    expect(() => interpolateMorphPath(a, b, NaN)).toThrow();
    for (const change of [
      (target: any) => { target.d = "M0 0 L80 0"; },
      (target: any) => { target.viewBox = [200, 100]; },
      (target: any) => { target.drawDurationMs = 500; },
    ]) { const bad = structuredClone(d); change((bad.scenes[1] as any).elements[0]); expect(() => parseProject(bad)).toThrow(/shape-morph/); }
    for (const kind of ["html", "three"]) { const bad = structuredClone(d); (bad.scenes[1] as any) = kind === "html" ? { id: "two", kind, html: "<p>x</p>", narration: { text: "x" }, transition: { in: "shape-morph" }, elements: [path] } : { id: "two", kind, model: "cube", narration: { text: "x" }, transition: { in: "shape-morph" }, elements: [path] }; expect(() => parseProject(bad)).toThrow(); }
  });
  it("invalidates only the dependent scene cache when the previous geometry changes", () => {
    const a = data(), b = data(); b.scenes[0]!.elements[0]!.w = .4;
    const first = graphForProject(parseProject(a), "project.json", {}), second = graphForProject(parseProject(b), "project.json", {});
    expect(first.sceneKeys["scene:two"]).not.toBe(second.sceneKeys["scene:two"]);
  });
});
