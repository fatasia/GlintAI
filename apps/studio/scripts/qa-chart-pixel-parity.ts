// MOTION-06: the chart data chain must survive real browser rasterisation —
// bar heights on screen must equal the data ratios, grow with the frame, and
// move when the table moves. Instrument: esbuild bundles ChartSceneView with
// remotion aliased to a deterministic stub (frame injected, same clamp semantics
// as remotion's interpolate), a real Chrome renders the SVG at 1:1, and ffmpeg
// decodes RGB24 pixels so pure-red bar pixels can be counted per column.
//   tsx qa-chart-pixel-parity.ts --out=evidence/MOTION-06/run-20261025b
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { openCaptureBrowser, startAssetServer } from "./direct-browser/host";

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out") ?? path.join("evidence", "MOTION-06", `run-${new Date().toISOString().slice(0, 10)}`));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion06-"));
const videoRoot = path.resolve("..", "..", "packages", "video", "src");

// Same clamp/linear semantics the real remotion interpolate applies; the frame
// is injected instead of read from a Player context.
const stub = `
let frame = 0;
export function useCurrentFrame() { return frame; }
export function useVideoConfig() { return { fps: 30, width: 1920, height: 1080 }; }
export function __glintQaSetFrame(next) { frame = next; }
export function interpolate(input, inRange, outRange, options) {
  const [inMin, inMax] = inRange, [outMin, outMax] = outRange;
  let progress = inMax === inMin ? 0 : (input - inMin) / (inMax - inMin);
  if (options?.extrapolateLeft === "clamp" && progress < 0) progress = 0;
  if (options?.extrapolateRight === "clamp" && progress > 1) progress = 1;
  return outMin + progress * (outMax - outMin);
}
`;
const entry = `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartSceneView } from ${JSON.stringify(path.resolve(videoRoot, "scenes", "ChartScene").replace(/\\/g, "/"))};
import { __glintQaSetFrame } from "remotion";
window.__glintQaRender = (scene, frame) => {
  __glintQaSetFrame(frame);
  document.getElementById("glint-root").innerHTML = renderToStaticMarkup(createElement(ChartSceneView, { scene }));
  return document.getElementById("glint-root").innerHTML;
};
`;
fs.writeFileSync(path.join(work, "remotion-stub.ts"), stub);
const bundle = await build({
  // resolveDir must sit inside the repo so bare imports (react) walk up to the
  // pnpm node_modules; the temp work dir has none.
  stdin: { contents: entry, resolveDir: videoRoot, sourcefile: "chart-qa-entry.ts", loader: "ts" },
  bundle: true, format: "iife", platform: "browser", write: false, minify: true,
  alias: { remotion: path.join(work, "remotion-stub.ts") },
});
fs.writeFileSync(path.join(work, "chart-qa.js"), bundle.outputFiles[0]!.text);
// Pure-red accent keeps bar pixels separable from axis ink and background by
// channel thresholds after RGB24 decode.
fs.writeFileSync(path.join(work, "host.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; height: 660px; background: #fff; }
:root { --glint-color-accent: #ff2d00; --glint-color-accent-2: #0ea5e9; --glint-color-text: #111114; --glint-color-text-muted: #6b6b76; --glint-font-size-h1: 28px; --glint-font-display: sans-serif; }
</style></head><body><div id="glint-root"></div><script src="/chart-qa.js"></script></body></html>`);

const decodeRgb = (file: string): { data: Buffer; width: number; height: number } => {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { maxBuffer: 1 << 20 });
  const [width, height] = (probe.stdout.toString().trim().split(",") || ["0", "0"]).map(Number);
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 29 });
  if (out.status !== 0 || !out.stdout.length || !width || !height) throw new Error(`decode failed: ${file}`);
  return { data: out.stdout, width, height };
};
const isRed = (frame: { data: Buffer; width: number }, x: number, y: number) => {
  const at = (y * frame.width + x) * 3;
  return frame.data[at]! > 180 && frame.data[at + 1]! < 110 && frame.data[at + 2]! < 110;
};
const redColumnHeight = (frame: { data: Buffer; width: number; height: number }, svgX: number) => {
  const column = Math.min(frame.width - 1, Math.max(0, Math.round(svgX * frame.width / 1000)));
  let count = 0;
  for (let y = 0; y < frame.height; y++) if (isRed(frame, column, y)) count++;
  return count;
};

const barScene = (values: number[], extra: Record<string, unknown> = {}) => ({
  id: "chart", kind: "chart", chartType: "bar", narration: { text: "数据" },
  data: values.map((value, index) => ({ label: `第${index + 1}项`, value })), ...extra,
});
// bar centres on the 1000-wide viewBox for a 2-bar series (graphW 855 from x=105).
const centre = (index: number, bars: number) => 105 + 855 * (index + 0.5) / bars;

const server = await startAssetServer(work);
const browser = await openCaptureBrowser(1000, 660);
const page = browser.page;
const failures: string[] = [];
try {
  await page.goto(server.url + "/host.html", { waitUntil: "load" });
  const render = (scene: unknown, frame: number) => page.evaluate(`window.__glintQaRender(${JSON.stringify(scene)}, ${frame})`) as Promise<string>;
  const shot = (name: string) => page.screenshot({ path: path.join(outDir, name) });

  // Explicit durationMs fixes the animation window (min(fps*1.2, pageFrames*0.6)
  // = 36 frames), so frame 24 sits inside the growth ramp while frame 90 is final.
  const full = barScene([40, 80], { narration: { text: "数据", durationMs: 6000 } });
  const markupA = await render(full, 90);
  await shot("bars-full-90.png");
  const frame90 = decodeRgb(path.join(outDir, "bars-full-90.png"));
  const h1full = redColumnHeight(frame90, centre(0, 2)), h2full = redColumnHeight(frame90, centre(1, 2));
  if (Math.abs(h1full / h2full - 0.5) > 0.06) failures.push(`bar ratio ${h1full}/${h2full} != 0.5 at frame 90`);
  if (h2full < 80) failures.push(`tallest bar only ${h2full}px of ~250 expected`);

  const markupA2 = await render(full, 90);
  if (markupA !== markupA2) failures.push("same frame rendered different markup");
  const markupMid = await render(full, 24);
  await shot("bars-mid-24.png");
  if (markupMid === markupA) failures.push("frame 24 markup identical to frame 90 (no growth animation)");
  const frame24 = decodeRgb(path.join(outDir, "bars-mid-24.png"));
  const h2mid = redColumnHeight(frame24, centre(1, 2));
  if (h2mid >= h2full) failures.push(`bar did not grow with frame: ${h2mid} >= ${h2full}`);

  const moved = barScene([70, 30], { narration: { text: "数据", durationMs: 6000 } });
  await render(moved, 90);
  await shot("bars-moved-90.png");
  const frameMoved = decodeRgb(path.join(outDir, "bars-moved-90.png"));
  const m1 = redColumnHeight(frameMoved, centre(0, 2)), m2 = redColumnHeight(frameMoved, centre(1, 2));
  if (!(m1 > m2)) failures.push(`data update did not move geometry: m1=${m1} m2=${m2} (expected first bar taller)`);

  const paged = await render(barScene(Array.from({ length: 13 }, (_, index) => index + 1), { narration: { text: "数据", durationMs: 6000 } }), 150);
  if (!/13–13/.test(paged)) failures.push("long series did not page to the last slice");
  await shot("bars-paged-150.png");
} finally {
  await browser.browser.close().catch(() => {});
  await server.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
const summary = {
  ranAt: new Date().toISOString(),
  checks: ["bar pixel ratio == data ratio (0.5 ±0.06)", "tall bar >= 80px at frame 90", "markup deterministic per frame", "bar grows with frame", "table update moves geometry", "long series pages"],
  failures,
  verdict: failures.length === 0
    ? "PASS: ChartScene pixels equal the data ratios in a real Chrome, grow with the frame, move when the table moves, and page long series"
    : `FAIL: ${failures.join("; ")}`,
  instrument: "esbuild bundle of ChartSceneView with remotion aliased to a frame-injected stub; real Chrome SVG raster; ffmpeg RGB24 decode counting pure-red bar pixels per column",
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`[motion06] ${summary.verdict}; summary → ${path.join(outDir, "summary.json")}`);
if (failures.length > 0) process.exitCode = 1;
