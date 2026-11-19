import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { expandImageCanvas } from "./image-canvas";
import { runMediaProcess } from "./native-process";
import { captureProcess } from "./frame-diff";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const installed = ["ffmpeg", "ffprobe"].every(name => spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0);
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-canvas-test-")); roots.push(root);
  const raw = path.join(root, "source.rgba"), source = path.join(root, "source.png");
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 0, 0]);
  fs.writeFileSync(raw, rgba);
  await runMediaProcess("ffmpeg", ["-v", "error", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "2x2", "-i", raw, "-frames:v", "1", "-threads", "1", source]);
  return { root, source, rgba, sourceBytes: fs.readFileSync(source) };
}
async function pixels(file: string) { return captureProcess("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]); }

it.skipIf(!installed)("expands asymmetric transparent margins and preserves every source RGBA pixel", async () => {
  const { root, source, rgba, sourceBytes } = await fixture(), out = path.join(root, "out.png");
  const result = await expandImageCanvas({ src: source, out, left: 1, right: 2, top: 2, bottom: 1 });
  expect(result).toMatchObject({ source: { width: 2, height: 2 }, canvas: { width: 5, height: 5 }, origin: { x: 1, y: 2 }, operation: "canvas-only" });
  const data = await pixels(out); expect(data.length).toBe(5 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const actual = data.subarray((y * 5 + x) * 4, (y * 5 + x + 1) * 4);
    if (x >= 1 && x < 3 && y >= 2 && y < 4) expect(actual).toEqual(rgba.subarray(((y - 2) * 2 + x - 1) * 4, ((y - 2) * 2 + x) * 4));
    else expect(actual[3]).toBe(0);
  }
  expect(fs.readFileSync(source)).toEqual(sourceBytes);
  expect(fs.readdirSync(root).some(name => name.startsWith(".glint-canvas-"))).toBe(false);
}, 30000);
it.skipIf(!installed)("uses solid color padding and never overwrites an existing output", async () => {
  const { root, source } = await fixture(), out = path.join(root, "solid.png");
  await expandImageCanvas({ src: source, out, left: 1, color: "#123456" });
  const data = await pixels(out); expect([...data.subarray(0, 4)]).toEqual([18, 52, 86, 255]);
  const before = fs.readFileSync(out);
  await expect(expandImageCanvas({ src: source, out, right: 1 })).rejects.toThrow(/exists/);
  expect(fs.readFileSync(out)).toEqual(before);
}, 30000);
it.skipIf(!installed)("refuses invalid parameters and cancels before publication", async () => {
  const { root, source } = await fixture(), out = path.join(root, "new.png");
  await expect(expandImageCanvas({ src: source, out, left: -1 })).rejects.toThrow(/Margins/);
  await expect(expandImageCanvas({ src: source, out, right: 1, color: "red;unsafe" })).rejects.toThrow(/Color/);
  await expect(expandImageCanvas({ src: source, out: path.join(root, "new.jpg"), right: 1 })).rejects.toThrow(/png/);
  const controller = new AbortController(); controller.abort();
  await expect(expandImageCanvas({ src: source, out, right: 1, signal: controller.signal })).rejects.toThrow();
  expect(fs.existsSync(out)).toBe(false);
}, 30000);
it.skipIf(!installed)("leaves no output or staging directory for an invalid image, and does not overwrite under a race", async () => {
  const { root, source } = await fixture(), broken = path.join(root, "broken.png"), failed = path.join(root, "failed.png");
  fs.writeFileSync(broken, "not an image");
  await expect(expandImageCanvas({ src: broken, out: failed, left: 1 })).rejects.toThrow();
  expect(fs.existsSync(failed)).toBe(false);
  const out = path.join(root, "race.png");
  const results = await Promise.allSettled([expandImageCanvas({ src: source, out, left: 1 }), expandImageCanvas({ src: source, out, right: 1 })]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(fs.readFileSync(out).subarray(0, 8)).toEqual(Buffer.from("89504e470d0a1a0a", "hex"));
  expect(fs.readdirSync(root).some(name => name.startsWith(".glint-canvas-"))).toBe(false);
}, 30000);
it.skipIf(!installed)("runs the actual CLI and reports original placement", async () => {
  const { root, source } = await fixture(), out = path.join(root, "cli.png");
  const cli = path.resolve("apps/studio/scripts/glint.ts"), tsx = pathToFileURL(createRequire(path.resolve("apps/studio/package.json")).resolve("tsx/esm")).href;
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "image-canvas", `--src=${source}`, `--out=${out}`, "--left=2", "--bottom=1"], { encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ origin: { x: 2, y: 0 }, canvas: { width: 4, height: 3 }, operation: "canvas-only" });
}, 30000);
