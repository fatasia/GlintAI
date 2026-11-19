import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { exportAlphaFrames } from "./alpha-frames";
import { captureProcess } from "./frame-diff";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const installed = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-frames-")); roots.push(root);
  const project = { schemaVersion: 1, id: "alpha-test", title: "Alpha", aspect: "16:9", fps: 2, knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: " ", narration: { text: "one", durationMs: 1000 }, elements: [{ id: "box", kind: "rect", x: .5, y: .5, w: .2, h: .2, fill: "#ff0000" }] },
    { id: "two", kind: "title", title: " ", narration: { text: "two", durationMs: 1000 }, elements: [{ id: "box", kind: "rect", x: .5, y: .5, w: .2, h: .2, fill: "#0000ff" }] },
  ] };
  const projectPath = path.join(root, "project.json"); fs.writeFileSync(projectPath, JSON.stringify(project));
  return { root, project, projectPath };
}
async function pixelData(file: string) { return captureProcess("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]); }
it.skipIf(!installed)("renders real transparent and visible pixels for each scene with frame-accurate order", async () => {
  const { root, projectPath } = fixture(), outDir = path.join(root, "alpha");
  const result = await exportAlphaFrames({ projectPath, outDir, width: 320, height: 180 });
  expect(result).toMatchObject({ width: 320, height: 180, fps: "2", frames: 4, alpha: true, audio: false });
  const files = fs.readdirSync(outDir).sort(); expect(files).toEqual(["000000.png", "000001.png", "000002.png", "000003.png", "manifest.json"]);
  const first = await pixelData(path.join(outDir, files[0]!)), third = await pixelData(path.join(outDir, files[2]!));
  expect(first[3]).toBe(0); expect(third[3]).toBe(0);
  const center = (90 * 320 + 160) * 4;
  expect(first[center]).toBeGreaterThan(240); expect(first[center + 3]).toBeGreaterThan(240);
  expect(third[center + 2]).toBeGreaterThan(240); expect(third[center + 3]).toBeGreaterThan(240);
}, 30000);
it("rejects non-SVG scenes, overlap, filters, huge dimensions and preexisting outputs", async () => {
  const { root, projectPath, project } = fixture(), outDir = path.join(root, "alpha");
  const invalids = [
    { ...project, scenes: [{ id: "pic", kind: "image", src: "assets/x.png", narration: { text: "x", durationMs: 1000 } }] },
    { ...project, scenes: [project.scenes[0], { ...project.scenes[1], transition: { in: "fade", overlapMs: 300 } }] },
    { ...project, scenes: [{ ...project.scenes[0], effects: [{ id: "mono", kind: "grayscale", value: 1 }] }] },
    { ...project, fps: 120, scenes: [{ ...project.scenes[0], narration: { text: "a", durationMs: 3000 } }] },
  ];
  for (const value of invalids) { fs.writeFileSync(projectPath, JSON.stringify(value)); await expect(exportAlphaFrames({ projectPath, outDir, width: 320, height: 180 })).rejects.toThrow(); expect(fs.existsSync(outDir)).toBe(false); }
  fs.writeFileSync(projectPath, JSON.stringify(project));
  await expect(exportAlphaFrames({ projectPath, outDir, width: 3840, height: 2160 })).rejects.toThrow(/尺寸/);
  await expect(exportAlphaFrames({ projectPath, outDir, width: 320, height: 320 })).rejects.toThrow(/画幅/);
  fs.mkdirSync(outDir); fs.writeFileSync(path.join(outDir, "keep.txt"), "keep");
  await expect(exportAlphaFrames({ projectPath, outDir, width: 320, height: 180 })).rejects.toThrow(/已存在/);
  expect(fs.readFileSync(path.join(outDir, "keep.txt"), "utf8")).toBe("keep");
});
it("cleans a partially written sequence when cancelled", async () => {
  const { root, projectPath } = fixture(), outDir = path.join(root, "cancel"), controller = new AbortController();
  const started = exportAlphaFrames({ projectPath, outDir, width: 320, height: 180, signal: controller.signal });
  controller.abort(); await expect(started).rejects.toThrow(); expect(fs.existsSync(outDir)).toBe(false);
});
it("reaches the real CLI and writes a machine-readable manifest", async () => {
  const { root, projectPath } = fixture(), outDir = path.join(root, "cli");
  const cli = path.resolve("apps/studio/scripts/glint.ts"), tsx = pathToFileURL(createRequire(path.resolve("apps/studio/package.json")).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "alpha-frames", `--project=${projectPath}`, `--out=${outDir}`, "--width=320", "--height=180"], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ alpha: true, frames: 4, audio: false });
  expect(JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))).toMatchObject({ scope: "svg-scenes-only", frames: 4 });
}, 30000);
