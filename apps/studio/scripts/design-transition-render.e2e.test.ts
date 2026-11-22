import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { buildTimeline, parseProject, type SceneScriptProject } from "@glintai/scenescript";
import { renderNative } from "./native-render";
import { captureProcess } from "./frame-diff";

// S-03b AC1/AC2: an explicit page transition must cross-dissolve the two pages in
// the rendered MP4 (not just shrink the timeline), and unset pages must keep the
// accepted legacy behavior. Real Chromium + real FFmpeg.
const decode = (png: Uint8Array, width: number, height: number) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/></svg>`).render().pixels;
const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];
const scaledTimeout = (ms: number) => ms * (process.env.GLINT_CI_SLOW ? 3 : 1);

const page = (id: string, color: string) => ({
  id, kind: "html" as const, presentation: "slide" as const,
  html: `<!doctype html><html><body style="margin:0;background:${color}"></body></html>`,
  narration: { text: `${id}`, durationMs: 2000 },
});

describe("design transition overlap renders a two-page blend", () => {
  const hasTools = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  let available = hasTools;
  try { spawnSync(process.execPath, ["-e", "void 0"], { stdio: "ignore" }); } catch { available = false; }
  it.skipIf(!available)("renders an explicit wipe as a real two-page cross-dissolve", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-s03b-"));
    try {
      const project: SceneScriptProject = parseProject({
        schemaVersion: 1, id: "s03b", title: "转场叠化", aspect: "16:9", fps: 30, knowledgeSources: [],
        scenes: [
          { ...page("one", "rgb(200,40,40)") },
          { ...page("two", "rgb(40,80,200)"), transition: { in: "wipe", durationMs: 1200, overlapMs: 500 } },
        ],
      });
      const timeline = buildTimeline(project);
      // AC2: the timeline contracts by the overlap (2000+2000-500).
      expect(timeline.entries[1]!.startMs).toBe(1500);
      expect(timeline.totalMs).toBe(3500);

      const file = path.join(root, "project.json"); fs.writeFileSync(file, JSON.stringify(project));
      const rendered = await renderNative({ projectPath: file, output: path.join(root, "out.mp4"), fast: true, tts: "mock", music: "off", log: () => {} });
      expect(rendered.metrics.overlaps).toEqual([0, 15]); // 500ms at 30fps, frame-rounded

      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(root, "out.mp4")], { encoding: "utf8" });
      expect(Number(probe.stdout.trim())).toBeGreaterThan(3.2);
      expect(Number(probe.stdout.trim())).toBeLessThan(3.9);

      const isBlue = (rgb: number[]) => rgb[2]! > 140 && rgb[0]! < 90;
      const isRed = (rgb: number[]) => rgb[0]! > 140 && rgb[2]! < 90;
      const grab = async (atSec: string) => {
        const frame = path.join(root, `frame-${atSec}.png`);
        await captureProcess("ffmpeg", ["-v", "error", "-ss", atSec, "-i", path.join(root, "out.mp4"), "-frames:v", "1", frame]);
        return decode(fs.readFileSync(frame), 960, 540);
      };
      // fast renders at half resolution: 960x540 for a 16:9 project.
      const pureOne = await grab("1.0"), blend = await grab("1.75"), pureTwo = await grab("3.0");
      // AC1: at the overlap midpoint the wipe frontier has old-page red and new-page
      // blue on screen simultaneously — a genuine two-page blend.
      // Encoded YUV shifts absolute channels; assert color families (learned in QA-07).
      expect(isRed(pixel(pureOne, 960, 480, 270))).toBe(true);
      expect(isBlue(pixel(pureTwo, 960, 480, 270))).toBe(true);
      const midLeft = pixel(blend, 960, 240, 270), midRight = pixel(blend, 960, 720, 270);
      // At the overlap midpoint both pages are on screen. The wipe frontier plus the
      // xfade blend means sample colors sit BETWEEN the two page colors: assert the
      // red→blue mix ratio stays strictly inside (0.2, 0.8) on both sample points,
      // and that the two points differ (the wipe frontier separates them).
      const mixTowardBlue = (rgb: ArrayLike<number>, red: ArrayLike<number>, blue: ArrayLike<number>) => {
        const span = red[0]! - blue[0]!;
        return span === 0 ? null : (red[0]! - rgb[0]!) / span;
      };
      const one = mixTowardBlue(midLeft, pureOne, pureTwo)!, two = mixTowardBlue(midRight, pureOne, pureTwo)!;
      // Both samples sit strictly between the two page colors (real two-page blend),
      // and the wipe frontier keeps the left side further toward the incoming page.
      expect(one).toBeGreaterThan(0.2); expect(one).toBeLessThan(0.8);
      expect(two).toBeGreaterThan(0.2); expect(two).toBeLessThan(0.8);
      expect(one).toBeLessThan(two);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, scaledTimeout(120_000));

  it("keeps unset pages on the legacy hard-cut-with-fade timeline", () => {
    const project: SceneScriptProject = parseProject({
      schemaVersion: 1, id: "s03b-legacy", title: "缺省", aspect: "16:9", fps: 30, knowledgeSources: [],
      scenes: [page("one", "rgb(200,40,40)"), page("two", "rgb(40,80,200)")],
    });
    const timeline = buildTimeline(project);
    expect(timeline.entries[1]!.startMs).toBe(2000);
    expect(timeline.totalMs).toBe(4000);
  });
});

