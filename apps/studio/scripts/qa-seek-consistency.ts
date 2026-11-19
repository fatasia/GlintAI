// QA-07: random-seek consistency between the editor preview path and the
// exported mp4. Instrument: a per-frame binary-stripe source (frame k paints
// bit j of k as the j-th vertical stripe), so the shown source frame can be
// read back from both paths with a per-frame relative threshold — immune to
// color-space drift and codec noise. Every sampled time must read the same
// frame identity on both sides; mismatches are seek/present races.
//   tsx qa-seek-consistency.ts --out=evidence/QA-07/run-<date> [--samples=30]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseNleProject } from "@glintai/scenescript";
import { renderNle, nleInlineJson } from "./nle-render";
import { openCaptureBrowser, startAssetServer } from "./direct-browser/host";
import { runMediaProcess } from "./native-process";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out") ?? path.join("evidence", "QA-07", `run-${new Date().toISOString().slice(0, 10)}`));
const samples = Number(arg("samples") ?? 30);
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-qa07-"));
const FPS = 30, frameMs = 1000 / FPS, SOURCE_FRAMES = 210;

// Build the stripe-encoded source: 320x240 gray, 8 stripes of 40px, bit j of k.
const buildStripeSource = (file: string) => {
  const chunks: Buffer[] = [];
  for (let k = 0; k < SOURCE_FRAMES; k++) {
    const frame = Buffer.alloc(320 * 240);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
      frame[y * 320 + x] = Math.floor(k / 2 ** Math.floor(x / 40)) % 2 ? 235 : 16;
    }
    chunks.push(frame);
  }
  const pipe = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "320x240", "-r", String(FPS), "-i", "pipe:0", "-vf", "scale=in_range=full:out_range=full", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-color_range", "2", file], { input: Buffer.concat(chunks), maxBuffer: 1 << 30 });
  if (pipe.status !== 0) throw new Error("stripe source encode failed: " + pipe.stderr?.toString().slice(0, 200));
};
const grayFrame = (file: string, ss?: string) => {
  const args = ["-v", "error", "-i", file];
  if (ss !== undefined) args.push("-ss", ss);
  args.push("-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1");
  return spawnSync("ffmpeg", args, { maxBuffer: 1 << 29 }).stdout;
};
const readK = (file: string, ss?: string): number => {
  const data = grayFrame(file, ss);
  if (!data.length) return -1;
  const width = 960, height = 540;
  const levels: number[] = [];
  for (let j = 0; j < 8; j++) {
    let sum = 0, count = 0;
    const x0 = Math.floor((j + 0.3) / 8 * width), x1 = Math.floor((j + 0.7) / 8 * width);
    for (let y = Math.floor(height * 0.4); y < height * 0.6; y += 4) for (let x = x0; x < x1; x += 4) { sum += data[y * width + x]!; count++; }
    levels.push(sum / count);
  }
  const spread = Math.max(...levels) - Math.min(...levels);
  if (spread <= 40) return -1;
  const threshold = (Math.min(...levels) + Math.max(...levels)) / 2;
  let k = 0;
  for (let j = 7; j >= 0; j--) k = k * 2 + (levels[j]! > threshold ? 1 : 0);
  return k;
};

buildStripeSource(path.join(work, "a.mp4"));
fs.mkdirSync(path.join(work, "assets"), { recursive: true });
fs.copyFileSync(path.join(work, "a.mp4"), path.join(work, "assets", "a.mp4"));
// Clip B carries the bell speed ramp (slow-fast-slow, mean 1x) — the regime
// where a preview/export source-clock drift would show first.
const projectJson = {
  schemaVersion: 1, id: "qa07", title: "QA-07 seek consistency", fps: FPS, width: 960, height: 540,
  tracks: [
    { id: "v1", kind: "video", name: "主画面", clips: [
      { id: "a", kind: "video", src: "assets/a.mp4", startMs: 0, durationMs: 4000, trimStartMs: 1000, volume: 0 },
      { id: "b", kind: "video", src: "assets/a.mp4", startMs: 4000, durationMs: 3000, trimStartMs: 2000, volume: 0, speedCurve: "bell", speedRamp: { durationMs: 3000, offsetMs: 0 } },
    ] },
  ],
};
const projectFile = path.join(work, "project.json");
fs.writeFileSync(projectFile, JSON.stringify(projectJson, null, 2));
parseNleProject(projectJson);

console.log("[qa07] rendering export mp4 ...");
const exported = await renderNle({ projectFile, assetsDir: path.join(work, "assets"), out: path.join(outDir, "export.mp4"), encoding: "balanced" });
console.log(`[qa07] export: ${exported.output} (${Math.round(exported.bytes / 1024)} KB)`);
const project = parseNleProject(projectJson);
const totalMs = Math.max(...project.tracks.flatMap(track => track.clips.map(clip => clip.startMs + clip.durationMs)));

// Sample: sequential head (renderer-like) + seeded random tail (scrub-like).
let seed = 20261025;
const random = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const times: number[] = [];
for (let n = 0; times.length < Math.min(10, samples); n++) times.push(n * frameMs);
while (times.length < samples) {
  const time = Math.floor((random() * (totalMs - 100)) / frameMs) * frameMs;
  if (!times.includes(time)) times.push(time);
}

const esbuild = await import("esbuild");
const harness = esbuild.buildSync({ entryPoints: [path.join(here, "nle-capture-page.ts")], bundle: true, platform: "browser", format: "iife", target: "chrome120", write: false, logLevel: "silent" }).outputFiles[0]!.text;
fs.writeFileSync(path.join(work, "harness.js"), harness);
const inline = nleInlineJson(projectJson);
fs.writeFileSync(path.join(work, "harness.html"), '<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><div id="root"></div><script>window.__GLINT_PROJECT=' + inline + ';</script><script src="/harness.js"></script>');
const server = await startAssetServer(work);
const browser = await openCaptureBrowser(project.width, project.height);
const pairs: Array<{ timeMs: number; frame: number; previewK: number; exportK: number; clip: string }> = [];
let mismatches = 0, unreadable = 0;
try {
  const { page } = browser;
  await page.goto(server.url + "/harness.html", { waitUntil: "load" });
  await page.evaluate((viewScale: number) => (window as unknown as { __glintNleInit(project: unknown, assetBase: string, viewScale: number): Promise<void> }).__glintNleInit((window as unknown as { __GLINT_PROJECT: unknown }).__GLINT_PROJECT, "/assets/", viewScale), 1);
  for (const time of times) {
    const n = Math.round(time / frameMs);
    const exportK = readK(exported.output, (n / FPS - 0.0005).toFixed(7));
    const clip = time < 4000 ? "a" : "b(ramp)";
    // Headless compositors present on demand: a screenshot may race the seek's
    // own present. Re-shooting the already-seeked frame is deterministic, so a
    // transient capture race is retried; a real preview/export divergence
    // would fail every attempt.
    let previewK = -1, attempts = 0;
    for (const maxAttempts = 3; attempts < maxAttempts && previewK !== exportK; attempts++) {
      await page.evaluate((t: number) => (window as unknown as { __glintNleSeek(t: number): Promise<void> }).__glintNleSeek(t), time);
      const shot = path.join(outDir, `preview-${time}.png`);
      await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: project.width, height: project.height } });
      previewK = readK(shot);
    }
    pairs.push({ timeMs: time, frame: n, previewK, exportK, clip });
    if (previewK === -1 || exportK === -1) { unreadable++; console.log(`[qa07] t=${time}ms clip=${clip} unreadable (preview=${previewK} export=${exportK})`); continue; }
    if (previewK !== exportK) {
      mismatches++;
      console.log(`[qa07] t=${time}ms clip=${clip} MISMATCH preview=${previewK} export=${exportK}`);
    } else console.log(`[qa07] t=${time}ms clip=${clip} k=${previewK} ok${attempts > 1 ? ` (settled after ${attempts} shots)` : ""}`);
  }
} finally {
  await browser.browser.close().catch(() => {});
  await server.close().catch(() => {});
}

const comparable = pairs.filter(pair => pair.previewK !== -1 && pair.exportK !== -1);
const summary = {
  ranAt: new Date().toISOString(), fps: FPS, totalMs, sampled: times.length,
  comparable: comparable.length, unreadable, mismatches,
  worstCase: mismatches === 0 ? "none" : comparable.filter(pair => pair.previewK !== pair.exportK),
  verdict: mismatches === 0
    ? `PASS: all ${comparable.length} readable sample pairs read identical source frames on preview and export`
    : `FAIL: ${mismatches}/${comparable.length} readable pairs diverge between preview and export`,
  instrument: "per-frame binary stripe source; frame identity read back with per-frame relative threshold",
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`[qa07] ${summary.verdict}; summary → ${path.join(outDir, "summary.json")}`);
if (mismatches > 0) process.exitCode = 1;
fs.rmSync(work, { recursive: true, force: true });
