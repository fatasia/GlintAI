import { describe, expect, it } from "vitest";
import { parseProject } from "./parse";
import { cubicBezier, easeValue, evaluateElements, sampleTrack } from "./elements";

const project = (overrides: Record<string, unknown> = {}) => parseProject({
  schemaVersion: 1, id: "elements-fixture", title: "Elements", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 2000 },
    elements: [
      { id: "price", kind: "text", text: "¥199", x: 0.5, y: 0.7, fontSize: 64 },
      { id: "card", kind: "rect", x: 0.1, y: 0.1, w: 0.3, h: 0.2, fill: "#112233" },
    ],
    tracks: [
      { elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 0.8 }] },
      { elementId: "price", property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] },
    ],
    ...overrides,
  }],
});

describe("object animation evaluation", () => {
  it("interpolates linearly between keyframes and clamps outside the range", () => {
    const track = { keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 10 }] };
    expect(sampleTrack(track, -5)).toBe(0);
    expect(sampleTrack(track, 0)).toBe(0);
    expect(sampleTrack(track, 500)).toBeCloseTo(5, 9);
    expect(sampleTrack(track, 1000)).toBe(10);
    expect(sampleTrack(track, 5000)).toBe(10);
  });
  it("sorts out-of-order keyframes instead of depending on array order", () => {
    const track = { keyframes: [{ atMs: 1000, value: 10 }, { atMs: 0, value: 0 }] };
    expect(sampleTrack(track, 500)).toBeCloseTo(5, 9);
  });
  it("applies easing from the segment's ending keyframe", () => {
    const track = { keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 10, easing: "ease-in" as const }] };
    expect(sampleTrack(track, 500)).toBeLessThan(5);
    expect(sampleTrack(track, 0)).toBe(0);
    expect(sampleTrack(track, 1000)).toBe(10);
  });
  it("supports cubic-bezier easing with exact endpoints", () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0)).toBeCloseTo(0, 6);
    expect(cubicBezier(0.42, 0, 0.58, 1, 1)).toBeCloseTo(1, 6);
    expect(easeValue(0.5, { bezier: [0.42, 0, 0.58, 1] })).toBeCloseTo(0.5, 2);
    expect(easeValue(0.5, "ease-in")).toBeLessThan(0.5);
    expect(easeValue(0.5, "ease-out")).toBeGreaterThan(0.5);
  });
  it("evaluates every element with base values and per-property overrides", () => {
    const p = project();
    const atZero = evaluateElements(p.scenes[0]!, 0);
    const price = atZero.find(state => state.element.id === "price")!;
    const card = atZero.find(state => state.element.id === "card")!;
    expect(price).toMatchObject({ x: 0.5, y: 0.7, opacity: 0, scale: 1, rotate: 0 });
    expect(card).toMatchObject({ x: 0.1, y: 0.1, opacity: 1 });
    const later = evaluateElements(p.scenes[0]!, 1000).find(state => state.element.id === "price")!;
    expect(later.x).toBeCloseTo(0.8, 9);
    expect(later.opacity).toBe(1);
  });
});

describe("element schema validation", () => {
  it("rejects a track for an element that does not exist", () => {
    expect(() => project({ tracks: [{ elementId: "ghost", property: "x", keyframes: [{ atMs: 0, value: 0 }] }] })).toThrow(/unknown element/);
  });
  it("rejects duplicate element ids and duplicate keyframe times", () => {
    expect(() => project({ elements: [{ id: "a", kind: "text", text: "x" }, { id: "a", kind: "text", text: "y" }] })).toThrow(/duplicate element id/);
    expect(() => project({ tracks: [{ elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0 }, { atMs: 0, value: 1 }] }] })).toThrow(/duplicate keyframe time/);
  });
  it("requires text elements to carry text and rects to carry geometry", () => {
    expect(() => project({ elements: [{ id: "a", kind: "text" }] })).toThrow();
    expect(() => project({ elements: [{ id: "b", kind: "rect", x: 0, y: 0, w: 1 }] })).toThrow();
  });
});
