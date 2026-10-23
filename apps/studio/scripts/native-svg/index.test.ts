import { describe, expect, it } from "vitest";
import { parseProject, type SceneScriptProject, UnderstandingQuiz } from "@glintai/scenescript";
import { renderSceneSvg, sharedElementPositions, supportsNativeScene } from "./index";
import { wrapText, xml } from "./text";

const project = (scene: object): SceneScriptProject => parseProject({ schemaVersion: 1, id: "native-test", title: "测试", aspect: "16:9", theme: "hand-note", knowledgeSources: [], scenes: [{ id: "scene", narration: { text: "真实讲述文本", durationMs: 2000 }, ...scene }] });

describe("native SVG scene contract", () => {
  it.each([
    { kind: "title", title: "标题" },
    { kind: "bullets", items: ["甲", "乙"] },
    { kind: "definition", term: "术语", definition: "定义" },
    { kind: "quote", text: "引用", attribution: "出处" },
    { kind: "comparison", left: { label: "左", points: ["甲"] }, right: { label: "右", points: ["乙"] } },
    { kind: "diagram", steps: [{ label: "输入" }, { label: "输出" }] },
    { kind: "code", code: "a < b && c > d" },
  ])("renders $kind without React or Remotion", scene => {
    const p = project(scene), output = renderSceneSvg(p, p.scenes[0]!, 30);
    expect(output).toContain("<svg"); expect(output).not.toMatch(/NaN|undefined|Infinity/);
  });
  it.each(["bar", "line", "area", "pie", "scatter", "combo"])("renders %s chart with finite coordinates", chartType => {
    const p = project({ kind: "chart", chartType, data: [{ label: "甲", value: chartType === "pie" ? 3 : -3, value2: -2 }, { label: "乙", value: 0, value2: 0 }] });
    expect(renderSceneSvg(p, p.scenes[0]!, 30)).not.toMatch(/NaN|undefined|Infinity/);
  });
  it("escapes data instead of executing markup", () => {
    const p = project({ kind: "title", title: '</text><script>alert("X")</script>' });
    const svg = renderSceneSvg(p, p.scenes[0]!, 40);
    expect(svg).not.toContain("<script>"); expect(svg).toContain("&lt;");
  });
  it("does not omit pie data beyond the first six points", () => {
    const p = project({ kind: "chart", chartType: "pie", data: Array.from({ length: 12 }, (_, i) => ({ label: `类目${i}`, value: i + 1 })) });
    expect(renderSceneSvg(p, p.scenes[0]!, 59)).toContain("类目11");
  });
  it("preserves explicit dimensions for vertical delivery", () => {
    const p = { ...project({ kind: "title", title: "中文长句".repeat(10) }), aspect: "9:16" as const };
    const svg = renderSceneSvg(p, p.scenes[0]!, 30);
    expect(svg).toContain('width="1080" height="1920"'); expect(svg).not.toContain("NaN");
  });
  it("plate excludes narration captions", () => {
    const p = project({ kind: "title", title: "画面标题" });
    expect(renderSceneSvg(p, p.scenes[0]!, 30, { plate: true })).not.toContain("真实讲述文本");
    expect(renderSceneSvg(p, p.scenes[0]!, 30)).toContain("真实讲述文本");
  });
  it("rejects unsupported scenes instead of silently falling back", () => {
    const p = project({ kind: "html", html: "<b>html</b>" });
    expect(supportsNativeScene(p.scenes[0]!)).toBe(false);
    expect(() => renderSceneSvg(p, p.scenes[0]!, 0)).toThrow("browser backend");
  });
  it("interpolates matching shared elements with exact endpoints", () => {
    const a = project({ kind: "title", title: "甲", sharedElements: [{ key: "value", text: "18%", x: 0.1, y: 0.2, fontSize: 40 }] }).scenes[0]!;
    const b = project({ kind: "title", title: "乙", transition: { in: "magic-move" }, sharedElements: [{ key: "value", text: "18%", x: 0.7, y: 0.6, fontSize: 80 }] }).scenes[0]!;
    expect(sharedElementPositions(b, a, 0)[0]).toMatchObject({ x: 0.1, y: 0.2, fontSize: 40 });
    expect(sharedElementPositions(b, a, 1)[0]).toMatchObject({ x: 0.7, y: 0.6, fontSize: 80 });
    const mid = sharedElementPositions(b, a, 0.3)[0]!;
    expect(mid.x).toBeGreaterThan(0.1); expect(mid.x).toBeLessThan(0.7);
  });
  it("validates quiz answers against option count", () => {
    expect(UnderstandingQuiz.safeParse({ question: "哪项正确", options: ["甲", "乙"], answerIndex: 2, explanation: "原因" }).success).toBe(false);
  });
  it("wraps without losing characters and escapes XML metacharacters", () => {
    const value = "中文与emoji🌟混排ABC";
    expect(wrapText(value, 80, 20).join("")).toBe(value);
    expect(xml('<&"')).toBe("&lt;&amp;&quot;");
  });
});

describe("scene-local narration caption timing", () => {
  const words = Array.from({ length: 50 }, (_, i) => ({
    text: String.fromCharCode(0x4e00 + i),
    startMs: i * 100 + (i >= 24 ? 300 : 0) + (i >= 30 ? 200 : 0),
    endMs: (i + 1) * 100 + (i >= 24 ? 300 : 0) + (i >= 30 ? 200 : 0),
  }));
  const p = project({ kind: "title", title: "Visual title", narration: {
    text: "Fallback caption", durationMs: 7000, segments: [{ text: "Provider caption", words }],
  } });
  const render = (frame: number, audioOffsetMs?: number, plate = false) => renderSceneSvg(p, {
    ...p.scenes[0]!, narration: { ...p.scenes[0]!.narration, audioOffsetMs },
  }, frame, { plate });
  const pageText = (start: number) => words.slice(start, start + 24).map(word => word.text).join("");
  const withoutCaption = (svg: string) => svg.replace(/<text[^>]*><tspan x="192" y="972">.*?<\/text>/g, "");

  it("hides captions before delayed speech and shows them at the millisecond origin", () => {
    expect(render(0, 500)).not.toContain(pageText(0));
    expect(render(14, 500)).not.toContain(pageText(0));
    expect(render(15, 500)).toContain(pageText(0));
    expect(render(1, 51)).not.toContain(pageText(0));
    expect(render(2, 51)).toContain(pageText(0));
  });
  it.each([[87, 500], [57, -500]])("advances provider-word pages at frame %s with offset %s", (frame, offset) => {
    const svg = render(frame, offset); // caption clock is exactly 2400 ms, page one's end.
    expect(svg).toContain(pageText(24));
    expect(svg).not.toContain(pageText(0));
    expect(svg).not.toContain("Fallback caption");
  });
  it("does not quantize native offsets to frames", () => {
    expect(render(70, -51)).toContain(pageText(0)); // 2333.33 + 51 < 2400.
    expect(render(71, -51)).toContain(pageText(24));
  });
  it("keeps the appropriate page in inter-page and intra-page gaps, and the last page after speech", () => {
    for (const frame of [75, 100]) { // 2500 and 3333 ms are gaps without an active word.
      expect(render(frame, 0)).toContain(pageText(24));
      expect(render(frame, 0)).not.toContain(pageText(0));
    }
    expect(render(180, 0)).toContain(pageText(48));
    expect(render(180, 0)).not.toContain(pageText(0));
  });
  it("preserves zero-offset output, defaults nonfinite offsets to zero, and keeps plates caption-free", () => {
    const original = render(30);
    expect(render(30, 0)).toBe(original);
    for (const offset of [NaN, Infinity, -Infinity]) expect(render(30, offset)).toBe(original);
    for (const offset of [-500, 0, 500]) expect(render(30, offset, true)).not.toContain(pageText(0));
  });
  it("hides the text-only fallback before delayed speech without changing other visuals", () => {
    const fallback = project({ kind: "title", title: "Visual title", narration: { text: "Fallback caption", durationMs: 7000, audioOffsetMs: 500 } });
    expect(renderSceneSvg(fallback, fallback.scenes[0]!, 14)).not.toContain("Fallback caption");
    expect(renderSceneSvg(fallback, fallback.scenes[0]!, 15)).toContain("Fallback caption");
    expect(withoutCaption(render(14, 500))).toBe(withoutCaption(render(14, 0)));
  });
  it("leaves camera, transitions, beat pulse and element animation on the visual clock", () => {
    const animated = project({
      kind: "title", title: "Visual title", camera: { type: "push", intensity: 0.8 },
      transition: { in: "slide-left", durationMs: 1200 }, beatPulse: { beatsMs: [1000], amount: 0.1 },
      elements: [{ id: "moving", kind: "text", text: "Moving element", x: 0.5, y: 0.7 }],
      tracks: [{ elementId: "moving", property: "x", keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 0.8 }] }],
      narration: p.scenes[0]!.narration,
    });
    const at = (offset: number, frame = 30) => renderSceneSvg(animated, {
      ...animated.scenes[0]!, narration: { ...animated.scenes[0]!.narration, audioOffsetMs: offset },
    }, frame);
    const original = withoutCaption(at(0));
    expect(original).toContain("translate(1536 756)");
    for (const offset of [-500, 500, 1500]) expect(withoutCaption(at(offset))).toBe(original);
    expect(withoutCaption(at(0, 29))).not.toBe(original);
  });
});

describe("renderer determinism", () => {
  it("produces byte-identical SVG across repeated renders and equal inputs", () => {
    const scene = { kind: "chart" as const, chartType: "bar" as const, data: [{ label: "甲", value: 3 }, { label: "乙", value: 5 }] };
    const a = project(scene), b = project(scene);
    const first = renderSceneSvg(a, a.scenes[0]!, 42);
    const second = renderSceneSvg(a, a.scenes[0]!, 42);
    const third = renderSceneSvg(b, b.scenes[0]!, 42);
    expect(first).toBe(second);
    expect(first).toBe(third);
    expect(first).not.toBe(renderSceneSvg(a, a.scenes[0]!, 43));
  });
});
describe("editable element layer", () => {
  const scene = {
    kind: "title" as const, title: "标题",
    elements: [
      { id: "price", kind: "text" as const, text: "¥199", x: 0.5, y: 0.7, fontSize: 64 },
      { id: "card", kind: "rect" as const, x: 0.2, y: 0.2, w: 0.3, h: 0.2, fill: "#112233" },
    ],
    tracks: [
      { elementId: "price", property: "x" as const, keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 0.8 }] },
      { elementId: "price", property: "opacity" as const, keyframes: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] },
    ],
  };
  it("renders elements at their animated position and opacity", () => {
    const p = project(scene);
    const start = renderSceneSvg(p, p.scenes[0]!, 0);
    const later = renderSceneSvg(p, p.scenes[0]!, 30);
    expect(start).toContain("¥199");
    expect(start).toContain("translate(960 756)");
    expect(start).toContain("opacity=\"0\"");
    expect(later).toContain("translate(1536 756)");
    expect(later).toContain("opacity=\"1\"");
    expect(start).toContain("#112233");
  });
  it("drops the object layer from clean plates", () => {
    const p = project(scene);
    const plate = renderSceneSvg(p, p.scenes[0]!, 30, { plate: true });
    expect(plate).not.toContain("¥199");
  });
});