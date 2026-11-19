import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { exportAlphaWebm } from "./alpha-webm";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const installed = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-webm-")); roots.push(root);
  const project = { schemaVersion: 1, id: "alpha-test", title: "Alpha", aspect: "16:9", fps: 2, knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: " ", narration: { text: "one", durationMs: 1000 }, elements: [{ id: "box", kind: "rect", x: .5, y: .5, w: .2, h: .2, fill: "#ff0000" }] },
    { id: "two", kind: "title", title: " ", narration: { text: "two", durationMs: 1000 }, elements: [{ id: "box", kind: "rect", x: .5, y: .5, w: .2, h: .2, fill: "#0000ff" }] },
  ] };
  const projectPath = path.join(root, "p.json"); fs.writeFileSync(projectPath, JSON.stringify(project));
  return { root, project, projectPath };
}
it.skipIf(!installed)("exports a silent VP9 WebM with transparent and colored pixels at both scene times", async () => {
  const { root, projectPath } = fixture(), out = path.join(root, "out.webm");
  const result = await exportAlphaWebm({ projectPath, out, width: 320, height: 180 });
  expect(result).toMatchObject({ alpha: true, audio: false, fps: "2", frames: 4, width: 320, height: 180 });
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,codec_type,width,height,r_frame_rate,nb_read_frames:stream_tags=alpha_mode", "-of", "json", out]);
  expect(probe.status, probe.stderr.toString()).toBe(0);
  expect(JSON.parse(probe.stdout.toString()).streams).toEqual([expect.objectContaining({ codec_name: "vp9", codec_type: "video", width: 320, height: 180, r_frame_rate: "2/1", nb_read_frames: "4", tags: expect.objectContaining({ alpha_mode: "1" }) })]);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0);
  const frameBytes = 320 * 180 * 4, center = (90 * 320 + 160) * 4;
  expect(decoded.stdout.length).toBe(frameBytes * 4);
  expect(decoded.stdout[3]).toBeLessThan(10); expect(decoded.stdout[center]).toBeGreaterThan(180); expect(decoded.stdout[center + 3]).toBeGreaterThan(240);
  expect(decoded.stdout[frameBytes * 2 + 3]).toBeLessThan(10); expect(decoded.stdout[frameBytes * 2 + center + 2]).toBeGreaterThan(180); expect(decoded.stdout[frameBytes * 2 + center + 3]).toBeGreaterThan(240);
  expect(fs.readdirSync(root).sort()).toEqual(["out.webm", "p.json"]);
}, 60000);
it("rejects wrong output, non-SVG scenes and preexisting files without changing them", async () => {
  const { root, projectPath, project } = fixture(), out = path.join(root, "out.webm");
  await expect(exportAlphaWebm({ projectPath, out: path.join(root, "bad.mp4"), width: 320, height: 180 })).rejects.toThrow(/webm/i);
  fs.writeFileSync(out, "existing");
  await expect(exportAlphaWebm({ projectPath, out, width: 320, height: 180 })).rejects.toThrow(/已存在/); expect(fs.readFileSync(out, "utf8")).toBe("existing");
  const bad = path.join(root, "bad.json"); fs.writeFileSync(bad, JSON.stringify({ ...project, scenes: [{ id: "img", kind: "image", src: "assets/a.png", narration: { text: "x", durationMs: 1000 } }] }));
  await expect(exportAlphaWebm({ projectPath: bad, out: path.join(root, "bad.webm"), width: 320, height: 180 })).rejects.toThrow(/预检/);
  await expect(exportAlphaWebm({ projectPath, out: path.join(root, "odd.webm"), width: 80, height: 45 })).rejects.toThrow(/偶数/);
  expect(fs.existsSync(path.join(root, "odd.webm"))).toBe(false);
  expect(fs.readdirSync(root).filter(name => name.startsWith(".glint-alpha-"))).toEqual([]);
});
it("cleans exclusive temporary files when cancelled", async () => {
  const { root, projectPath } = fixture(), out = path.join(root, "cancel.webm"), controller = new AbortController();
  const work = exportAlphaWebm({ projectPath, out, width: 320, height: 180, signal: controller.signal }); controller.abort();
  await expect(work).rejects.toThrow(); expect(fs.existsSync(out)).toBe(false); expect(fs.readdirSync(root)).toEqual(["p.json"]);
});
it.skipIf(!installed)("runs the actual CLI without overwriting its target", () => {
  const { root, projectPath } = fixture(), out = path.join(root, "cli.webm");
  const cli = path.resolve("apps/studio/scripts/glint.ts"), tsx = pathToFileURL(createRequire(path.resolve("apps/studio/package.json")).resolve("tsx/esm")).href;
  const invoke = () => spawnSync(process.execPath, ["--import", tsx, cli, "alpha-webm", `--project=${projectPath}`, `--out=${out}`, "--width=320", "--height=180"], { encoding: "utf8", timeout: 60000 });
  const first = invoke(); expect(first.status, first.stderr).toBe(0); expect(JSON.parse(first.stdout)).toMatchObject({ alpha: true, frames: 4, audio: false });
  const prior = fs.readFileSync(out), second = invoke(); expect(second.status).not.toBe(0); expect(fs.readFileSync(out)).toEqual(prior);
}, 90000);
