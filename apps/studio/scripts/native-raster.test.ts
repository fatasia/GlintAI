import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { renderSceneSvg } from "./native-svg";

/**
 * Pixel-level determinism guard that runs in CI without Chrome.
 * It cannot pin a cross-machine hash (fonts differ), but it does catch a
 * renderer that became order-dependent or time-dependent between two calls.
 */
const project = (): SceneScriptProject => parseProject({
  schemaVersion: 1, id: "raster-fixture", title: "Raster", aspect: "16:9", knowledgeSources: [],
  scenes: [{ id: "one", kind: "chart", chartType: "bar", data: [{ label: "甲", value: 3 }, { label: "乙", value: 5 }], narration: { text: "说明", durationMs: 1000 } }],
});

const raster = (svg: string) => new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();

describe("raster determinism", () => {
  it("produces identical PNG bytes for the same frame", () => {
    const p = project();
    const svg = renderSceneSvg(p, p.scenes[0]!, 30, { width: 640, height: 360 });
    const first = raster(svg), second = raster(svg);
    expect(first.length).toBeGreaterThan(1000);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
  it("produces different bytes for a different frame", () => {
    const p = project();
    const a = raster(renderSceneSvg(p, p.scenes[0]!, 10, { width: 640, height: 360 }));
    const b = raster(renderSceneSvg(p, p.scenes[0]!, 60, { width: 640, height: 360 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
  it("keeps the requested canvas size", () => {
    const p = project();
    const png = raster(renderSceneSvg(p, p.scenes[0]!, 0, { width: 360, height: 640 }));
    // PNG IHDR: width/height are big-endian uint32 at byte 16 and 20.
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(640);
  });
});
