import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { ElementOverlay } from "./ElementOverlay";

const scene = parseProject({
  schemaVersion: 1, id: "overlay", title: "Overlay", aspect: "16:9", knowledgeSources: [],
  scenes: [{
    id: "one", kind: "title", title: "One", narration: { text: "a", durationMs: 2000 },
    elements: [
      { id: "price", kind: "text", text: "¥199", x: 0.5, y: 0.7, fontSize: 64 },
      { id: "card", kind: "rect", x: 0.2, y: 0.2, w: 0.3, h: 0.2, fill: "#112233", radius: 8 },
    ],
    tracks: [
      { elementId: "price", property: "x", keyframes: [{ atMs: 0, value: 0.5 }, { atMs: 1000, value: 0.8 }] },
      { elementId: "price", property: "opacity", keyframes: [{ atMs: 0, value: 0 }, { atMs: 500, value: 1 }] },
    ],
  }],
}).scenes[0]!;

const html = (timeMs: number) => renderToStaticMarkup(createElement(ElementOverlay, { scene, timeMs }));

describe("Remotion element overlay", () => {
  it("renders text and rect elements with base geometry", () => {
    const markup = html(0);
    expect(markup).toContain("¥199");
    expect(markup).toContain("left:20%");
    expect(markup).toContain("background:#112233");
  });
  it("applies animated position and opacity at a given millisecond", () => {
    const start = html(0), end = html(1000);
    expect(start).toContain("opacity:0");
    expect(start).toContain("left:50%");
    expect(end).toContain("left:80%");
    expect(end).toContain("opacity:1");
  });
  it("uses sampled positions for rectangles as well as text", () => {
    const animated = { ...scene, tracks: [...(scene.tracks ?? []), { elementId: "card", property: "x" as const, keyframes: [{ atMs: 0, value: 0.2 }, { atMs: 1000, value: 0.9 }] }] };
    const markup = renderToStaticMarkup(createElement(ElementOverlay, { scene: animated, timeMs: 1000 }));
    const positions = [...markup.matchAll(/left:([\d.]+)%/g)].map(match => Number(match[1]));
    expect(positions.some(position => Math.abs(position - 90) < 1e-6)).toBe(true);
    expect(markup).not.toContain("left:20%");
  });
  it("renders nothing when the scene has no elements", () => {
    const plain = { ...scene, elements: undefined, tracks: undefined };
    expect(renderToStaticMarkup(createElement(ElementOverlay, { scene: plain, timeMs: 0 }))).toBe("");
  });
});
