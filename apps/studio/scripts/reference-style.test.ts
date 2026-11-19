import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureProcess } from "./frame-diff";
import { analyzeReferenceStyle, applyReferenceStyle, quantizePalette } from "./reference-style";
import type { SceneScriptProject } from "@glintai/scenescript";

const roots: string[] = [];
afterAll(async () => { for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }); });

const installed = await (async () => {
  try { await captureProcess("ffmpeg", ["-version"], { timeoutMs: 5000 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
})();

describe("reference palette quantization (CREATE-10)", () => {
  it("buckets a downsampled rgb24 frame into dominant colors with shares", () => {
    // 2x2 frame: three red pixels, one blue — red must win with share 3/4.
    const frame = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255]);
    const palette = quantizePalette(frame, 4);
    expect(palette[0]).toEqual({ hex: "#ff0000", share: 0.75 });
    expect(palette[1]).toEqual({ hex: "#0000ff", share: 0.25 });
    expect(palette.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 5);
  });
  it("keeps at most the requested number of entries", () => {
    // Four distinct 4-bit bins (red, green, blue, yellow); top=2 keeps two.
    const frame = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]);
    expect(quantizePalette(frame, 2)).toHaveLength(2);
  });
});

describe("applyReferenceStyle writes an inline theme override (CREATE-10)", () => {
  const base: SceneScriptProject = {
    schemaVersion: 1, id: "ref-style", title: "参考风格", aspect: "16:9", theme: "glint-dark", knowledgeSources: [],
    scenes: [{ id: "shot-1", kind: "title", title: "标题", narration: { text: "旁白", durationMs: 1500 } }],
  };
  it("overrides bg and accent as object tokens, keeping everything else editable", () => {
    const styled = applyReferenceStyle(base, {
      format: "glint-reference-style", version: 1, source: "ref.mp4", scope: "palette-and-rhythm",
      palette: [{ hex: "#112233", share: 0.6 }, { hex: "#445566", share: 0.3 }],
    });
    expect(styled.theme).toEqual({ colors: { bg: "#112233", accent: "#445566" } });
    expect(styled.scenes).toEqual(base.scenes); // shots stay untouched; the human edits them
  });
  it("keeps the project unchanged when no palette could be read", () => {
    const fallback = applyReferenceStyle(base, { format: "glint-reference-style", version: 1, source: "ref.mp4", scope: "palette-and-rhythm", palette: [] });
    expect(fallback).toBe(base);
  });
});

describe.skipIf(!installed)("analyzeReferenceStyle on a real local clip (CREATE-10)", () => {
  it("proposes the rendered dominant color and a rhythm hint without any network", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glint-ref-style-")); roots.push(dir);
    const file = path.join(dir, "ref-style.mp4");
    // Two seconds of pure red: palette[0] must be red-dominant, rhythm = duration/4.
    await captureProcess("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=10:d=2", "-c:v", "mpeg4", "-q:v", "2", file], { timeoutMs: 30_000 });
    const style = await analyzeReferenceStyle(file);
    expect(style.scope).toBe("palette-and-rhythm");
    const red = style.palette[0]!;
    expect(parseInt(red.hex.slice(1, 3), 16)).toBeGreaterThan(180); // red channel dominates
    expect(red.share).toBeGreaterThan(0.5);
    expect(style.medianShotMs).toBe(500); // 2000ms / 4
  });
});
