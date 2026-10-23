// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SceneEffect, effectFilterSvg, sampleEffects, wrapSvgEffects } from "./effects";

const effect = (kind: SceneEffect["kind"], value: number, extra: Partial<SceneEffect> = {}): SceneEffect =>
  SceneEffect.parse({ id: `test-${kind}`, kind, value, ...extra });
const documentFor = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="red"/><text>Overlay</text></svg>';

describe("SceneEffect validation", () => {
  it.each([
    ["brightness", 0, 3], ["contrast", 0, 3], ["saturate", 0, 3],
    ["grayscale", 0, 1], ["sepia", 0, 1], ["hue", -180, 180], ["blur", 0, 30],
  ] as const)("enforces %s ranges on base and keyframe values", (kind, min, max) => {
    for (const value of [min, max]) expect(effect(kind, value).value).toBe(value);
    for (const value of [min - 0.001, max + 0.001, NaN, Infinity, -Infinity]) {
      expect(() => effect(kind, value)).toThrow();
      expect(() => effect(kind, min, { keyframes: [{ atMs: 0, value }] })).toThrow();
    }
  });
  it("rejects IDs capable of markup injection, unknown kinds and arbitrary fields", () => {
    for (const id of ['', 'Upper', 'a b', 'a\"/><script>', 'url(http://host)', '-start']) {
      expect(() => effect("blur", 1, { id })).toThrow();
    }
    expect(effect("blur", 1, { id: "soft-2" }).id).toBe("soft-2");
    expect(SceneEffect.safeParse({ id: "x", kind: "script", value: 1 }).success).toBe(false);
    expect(SceneEffect.safeParse({ id: "x", kind: "blur", value: 1, url: "https://host" }).success).toBe(false);
  });
  it("requires nonnegative integer times, nonempty keys and unique keyframe times", () => {
    for (const value of [-1, 0.5, Infinity, NaN]) {
      expect(() => effect("blur", 1, { startMs: value })).toThrow();
      expect(() => effect("blur", 1, { endMs: value })).toThrow();
      expect(() => effect("blur", 1, { keyframes: [{ atMs: value, value: 1 }] })).toThrow();
    }
    expect(() => effect("blur", 1, { endMs: 0 })).toThrow(/greater than/);
    expect(() => effect("blur", 1, { startMs: 5, endMs: 5 })).toThrow(/greater than/);
    expect(() => effect("blur", 1, { startMs: 6, endMs: 5 })).toThrow(/greater than/);
    expect(() => effect("blur", 1, { keyframes: [] })).toThrow();
    expect(() => effect("blur", 1, { keyframes: [{ atMs: 1, value: 1 }, { atMs: 1, value: 2 }] })).toThrow(/duplicate keyframe time/);
  });
  it("validates independent easing without a runtime types module dependency", () => {
    for (const easing of ["spring", { bezier: [-0.1, 0, 1, 1] }, { bezier: [0, NaN, 1, 1] }, { bezier: [0, 0, 1, Infinity] }]) {
      expect(SceneEffect.safeParse({ id: "x", kind: "blur", value: 1, keyframes: [{ atMs: 0, value: 1, easing }] }).success).toBe(false);
    }
    expect(effect("blur", 1, { keyframes: [{ atMs: 0, value: 1, easing: { bezier: [0, -2, 1, 3] } }] })).toBeDefined();
  });
});

describe("ordered effect sampling", () => {
  it("retains array order, removes disabled effects and clips on [start,end)", () => {
    const effects = [effect("brightness", 1.5), effect("blur", 5, { enabled: false }),
      effect("contrast", 2, { startMs: 100, endMs: 200 })];
    expect(sampleEffects(effects, 99).map(item => item.kind)).toEqual(["brightness"]);
    expect(sampleEffects(effects, 100)).toEqual([
      { id: "test-brightness", kind: "brightness", value: 1.5 }, { id: "test-contrast", kind: "contrast", value: 2 },
    ]);
    expect(sampleEffects(effects, 199).length).toBe(2);
    expect(sampleEffects(effects, 200).map(item => item.kind)).toEqual(["brightness"]);
    expect(sampleEffects(effects, -1)).toEqual([]);
    expect(sampleEffects(undefined, 0)).toEqual([]);
  });
  it("sorts keys without mutating, interpolates on scene clock, clamps endpoints", () => {
    const animated = effect("blur", 20, { startMs: 100, keyframes: [
      { atMs: 1000, value: 10 }, { atMs: 0, value: 0 },
    ] });
    const before = JSON.stringify(animated);
    expect(sampleEffects([animated], 100)[0]!.value).toBe(1);
    expect(sampleEffects([animated], 500)[0]!.value).toBe(5);
    expect(sampleEffects([animated], 2000)[0]!.value).toBe(10);
    expect(JSON.stringify(animated)).toBe(before);
  });
  it("uses destination easing and clamps custom bezier overshoot to kind range", () => {
    const animated = effect("sepia", 0, { keyframes: [
      { atMs: 0, value: 0 }, { atMs: 1000, value: 1, easing: "ease-in" },
    ] });
    expect(sampleEffects([animated], 500)[0]!.value).toBeCloseTo(0.315357, 5);
    animated.keyframes![1]!.easing = { bezier: [0, 5, 1, 5] };
    expect(sampleEffects([animated], 500)[0]!.value).toBe(1);
    animated.keyframes![1]!.easing = { bezier: [0, -5, 1, -5] };
    expect(sampleEffects([animated], 500)[0]!.value).toBe(0);
    expect(sampleEffects([effect("hue", 0, { keyframes: [{ atMs: 100, value: -60 }] })], 0)[0]!.value).toBe(-60);
  });
  it("rejects nonfinite clocks and unvalidated nonfinite numeric values", () => {
    for (const time of [NaN, Infinity, -Infinity]) expect(() => sampleEffects([], time)).toThrow(/finite/);
    expect(() => sampleEffects([{ id: "x", kind: "blur", value: Infinity }], 0)).toThrow(/finite/);
  });
});

describe("shared browser/export SVG filters", () => {
  it("builds exact ordered primitives with explicit input/result links", () => {
    const effects = [effect("brightness", 1.5), effect("contrast", 2), effect("blur", 3)];
    const output = effectFilterSvg(effects, 0, "scene-1");
    expect(output.id).toBe("glint-fx-scene-1");
    expect(output.filter).toBe("url(#glint-fx-scene-1)");
    const doc = documentFor(`<svg xmlns="http://www.w3.org/2000/svg">${output.defs}</svg>`);
    const filter = doc.querySelector("filter")!;
    expect(filter.getAttribute("color-interpolation-filters")).toBe("sRGB");
    expect([filter.getAttribute("x"), filter.getAttribute("width")]).toEqual(["-100%", "300%"]);
    expect(Array.from(filter.children, child => [child.tagName, child.getAttribute("in"), child.getAttribute("result")])).toEqual([
      ["feComponentTransfer", "SourceGraphic", "glint-fx-scene-1-step-0"],
      ["feComponentTransfer", "glint-fx-scene-1-step-0", "glint-fx-scene-1-step-1"],
      ["feGaussianBlur", "glint-fx-scene-1-step-1", "glint-fx-scene-1-step-2"],
    ]);
    const functions = doc.querySelectorAll("feFuncR");
    expect(functions[0]!.outerHTML).toContain('slope="1.5" intercept="0"');
    expect(functions[1]!.outerHTML).toContain('slope="2" intercept="-0.5"');
    expect(doc.querySelector("feGaussianBlur")!.getAttribute("stdDeviation")).toBe("3");
    expect(effectFilterSvg([...effects].reverse(), 0, "scene-1").defs).not.toBe(output.defs);
    expect(effectFilterSvg(effects, 0, "scene-1")).toEqual(output);
  });
  it("uses native saturation/grayscale and hue matrices plus interpolated sepia matrix", () => {
    const output = effectFilterSvg([effect("saturate", 2), effect("grayscale", 0.25), effect("hue", -90), effect("sepia", 0.5)], 0, "colors");
    const doc = documentFor(`<svg xmlns="http://www.w3.org/2000/svg">${output.defs}</svg>`);
    const matrices = Array.from(doc.querySelectorAll("feColorMatrix"));
    expect(matrices.map(matrix => matrix.getAttribute("type"))).toEqual(["saturate", "saturate", "hueRotate", "matrix"]);
    expect(matrices.slice(0, 3).map(matrix => matrix.getAttribute("values"))).toEqual(["2", "0.75", "-90"]);
    const values = matrices[3]!.getAttribute("values")!.split(" ").map(Number);
    expect(values).toHaveLength(20);
    expect(values.every(Number.isFinite)).toBe(true);
    expect(values[0]).toBe(0.6965);
    expect(values[1]).toBe(0.3845);
    expect(values[6]).toBe(0.843);
    expect(values.slice(15)).toEqual([0, 0, 0, 1, 0]);
  });
  it("keeps zero-valued brightness/contrast/saturation meaningful while omitting true identities", () => {
    const neutral = [effect("brightness", 1), effect("contrast", 1), effect("saturate", 1),
      effect("grayscale", 0), effect("sepia", 0), effect("hue", 0), effect("blur", 0)];
    expect(effectFilterSvg(neutral, 0, "empty")).toEqual({ id: "glint-fx-empty", defs: "", filter: "none" });
    expect(wrapSvgEffects(svg, neutral, 0)).toBe(svg);
    expect(effectFilterSvg([effect("brightness", 0), effect("contrast", 0), effect("saturate", 0)], 0, "zero").defs).toContain('slope="0"');
    expect(effectFilterSvg([effect("blur", 1, { enabled: false })], 0, "off").filter).toBe("none");
    expect(effectFilterSvg([effect("blur", 1, { endMs: 10 })], 10, "end").defs).toBe("");
  });
  it("rejects unsafe filter IDs instead of injecting markup or URLs", () => {
    for (const id of ["", "x\" onload=\"evil", "#x", "url(http://host)", "a b", "a.b", "<script>"]) {
      expect(() => effectFilterSvg([], 0, id)).toThrow(/Unsafe effect filter id/);
    }
    expect(effectFilterSvg([], 0, "Scene_2").id).toBe("glint-fx-Scene_2");
  });
  it("wraps the complete frame including overlays while preserving the SVG root", () => {
    const effects = [effect("blur", 2)];
    const output = wrapSvgEffects(svg, effects, 0);
    const doc = documentFor(output);
    expect(doc.documentElement.getAttribute("width")).toBe("1920");
    expect(Array.from(doc.documentElement.children, node => node.tagName)).toEqual(["defs", "g"]);
    expect(doc.querySelector("g")!.getAttribute("filter")).toBe("url(#glint-fx-frame)");
    expect(doc.querySelector("g > text")!.textContent).toBe("Overlay");
    expect(output).toContain(effectFilterSvg(effects, 0, "frame").defs);
    expect(wrapSvgEffects(svg, effects, 0)).toBe(output);
    expect(wrapSvgEffects(`<?xml version="1.0"?>\n${svg}`, effects, 0)).toContain('<?xml version="1.0"?>');
  });
  it("avoids existing renderer IDs and leaves empty stacks byte-identical", () => {
    const collision = svg.replace("<rect", '<defs><filter id="glint-fx-frame"/><filter id=\'glint-fx-frame-1\'/></defs><rect');
    const output = wrapSvgEffects(collision, [effect("blur", 2)], 0);
    const ids = Array.from(documentFor(output).querySelectorAll("[id]"), node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(output).toContain('filter="url(#glint-fx-frame-2)"');
    expect(wrapSvgEffects(svg, [], 0)).toBe(svg);
    expect(wrapSvgEffects("not SVG", undefined, 0)).toBe("not SVG");
    expect(() => wrapSvgEffects("not SVG", [effect("blur", 1)], 0)).toThrow(/complete renderer SVG/);
  });
});
