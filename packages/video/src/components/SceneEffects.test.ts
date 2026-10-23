import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneEffects } from "./SceneEffects";

const state = vi.hoisted(() => ({ frame: 0, fps: 30 }));
vi.mock("remotion", () => ({
  useCurrentFrame: () => state.frame,
  useVideoConfig: () => ({ fps: state.fps }),
  AbsoluteFill: ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) => createElement("div", { style }, children),
}));
const child = createElement("span", null, "Scene pixels");
describe("preview effect wiring", () => {
  it("is markup-identical for an absent or identity stack", () => {
    expect(renderToStaticMarkup(createElement(SceneEffects, { children: child }))).toBe(renderToStaticMarkup(child));
    expect(renderToStaticMarkup(createElement(SceneEffects, { children: child, effects: [{ id: "identity", kind: "brightness", value: 1 }] }))).toBe(renderToStaticMarkup(child));
  });
  it("samples the scene clock and emits shared SVG primitive parameters in order", () => {
    state.frame = 15;
    const markup = renderToStaticMarkup(createElement(SceneEffects, { children: child, effects: [
      { id: "fade", kind: "brightness", value: 1, keyframes: [{ atMs: 0, value: 0 }, { atMs: 1000, value: 1 }] },
      { id: "mono", kind: "grayscale", value: 1 },
    ] }));
    expect(markup).toContain('slope="0.5"');
    expect(markup).toContain('type="saturate" values="0"');
    expect(markup.indexOf("feComponentTransfer")).toBeLessThan(markup.indexOf("feColorMatrix"));
    expect(markup).toContain("Scene pixels"); expect(markup).toContain("filter:url(#glint-fx-preview-");
  });
  it("uses a topmost backdrop for sandboxed HTML without weakening iframe isolation", () => {
    const iframe = createElement("iframe", { sandbox: "allow-scripts", srcDoc: "<p>isolated</p>" });
    const markup = renderToStaticMarkup(createElement(SceneEffects, { children: iframe, composited: true,
      effects: [{ id: "mono", kind: "grayscale", value: 1 }] }));
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).toContain("backdrop-filter:url(#glint-fx-preview-");
    expect(markup.indexOf("</iframe>")).toBeLessThan(markup.indexOf("backdrop-filter"));
    expect(markup).toContain("pointer-events:none");
  });
});
