// EDIT-07: look presets, masks and blends must survive the real NLE export
// pipeline as pixels, not just as project JSON. Instrument: ffmpeg-synthesised
// solid-colour clips (deterministic, no stock media), full renderNle runs, then
// RGB24 frame probes at known coordinates. The mask/blend matrix uses pure red
// under pure blue overlays so every expected value is analytically known:
// screen(red, blue) = magenta, multiply(red, blue) = black.
//   tsx qa-look-preset-parity.ts --out=evidence/EDIT-07/run-20261025b
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeLookPreset } from "@glintai/scenescript";
import { renderNle } from "./nle-render";
import { runMediaProcess } from "./native-process";

const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const outDir = path.resolve(arg("out") ?? path.join("evidence", "EDIT-07", `run-${new Date().toISOString().slice(0, 10)}`));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "glint-edit07-"));
const assets = path.join(work, "assets");
fs.mkdirSync(assets, { recursive: true });

// Solid-colour sources: every probe below has an analytically expected value.
await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:size=640x360:rate=30:duration=1", "-pix_fmt", "yuv420p", path.join(assets, "red.mp4")], { timeoutMs: 60_000 });
await runMediaProcess("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=30:duration=1", "-pix_fmt", "yuv420p", path.join(assets, "blue.mp4")], { timeoutMs: 60_000 });

const project = (overlays: Array<Record<string, unknown>>) => JSON.stringify({
  schemaVersion: 1, id: "edit07-parity", title: "预设与蒙版对照", fps: 30, width: 640, height: 360,
  tracks: [
    // volume 0: the lavfi colour sources carry no audio track, and this matrix
    // verifies pixels only — audio routing has its own suites.
    { id: "v1", kind: "video", name: "V1", clips: [{ id: "base", kind: "video", src: "assets/red.mp4", startMs: 0, durationMs: 1000, volume: 0 }] },
    ...overlays.map((clip, index) => ({ id: `o${index}`, kind: "overlay", name: `V${index + 2}`, clips: [{ id: `c${index}`, kind: "video", src: "assets/blue.mp4", startMs: 0, durationMs: 1000, volume: 0, ...clip }] })),
  ],
});
const mono = makeLookPreset("silver-mono", 1, "qa-look");
const runs: Array<{ name: string; json: string; probes: Array<{ at: number; nx: number; ny: number; label: string; expect: (p: RGB) => boolean }> }> = [
  {
    name: "base", json: project([]),
    probes: [{ at: 500, nx: 0.5, ny: 0.5, label: "centre is source red", expect: p => p.r > 200 && p.g < 60 && p.b < 60 }],
  },
  {
    name: "silver-mono", json: project([{ effects: mono }]),
    probes: [
      { at: 500, nx: 0.5, ny: 0.5, label: "preset frame is channel-flat (grayscale)", expect: p => Math.abs(p.r - p.g) < 16 && Math.abs(p.g - p.b) < 16 && p.r > 40 },
      { at: 500, nx: 0.5, ny: 0.5, label: "preset differs from base red (red channel collapses)", expect: p => p.r < 200 },
    ],
  },
  {
    name: "mask-circle-screen", json: project([{ mask: { shape: "circle" }, blend: "screen" }]),
    probes: [
      { at: 500, nx: 0.5, ny: 0.5, label: "circle centre shows screen(red,blue)=magenta", expect: p => p.r > 180 && p.b > 180 && p.g < 90 },
      { at: 500, nx: 20 / 640, ny: 20 / 360, label: "circle corner keeps base red", expect: p => p.r > 200 && p.g < 60 && p.b < 60 },
    ],
  },
  {
    // Rect feather paints a horizontal gradient (90deg): 0-30% clear, 30-70%
    // solid, 70-100% clear. Multiply(red, blue) = black where visible.
    name: "mask-rect-feather-multiply", json: project([{ mask: { shape: "rect", feather: 0.3 }, blend: "multiply" }]),
    probes: [
      { at: 500, nx: 0.5, ny: 0.5, label: "rect centre shows multiply=black", expect: p => p.r < 50 && p.g < 50 && p.b < 50 },
      { at: 500, nx: 32 / 640, ny: 0.5, label: "feather-clear left edge keeps base red", expect: p => p.r > 170 && p.b < 110 },
    ],
  },
  {
    name: "transition-in-fade", json: project([{ transitionIn: { type: "fade", durationMs: 400 } }]),
    probes: [
      { at: 50, nx: 0.5, ny: 0.5, label: "fade-in start still shows mostly base red", expect: p => p.r > 200 && p.b < 90 },
      { at: 500, nx: 0.5, ny: 0.5, label: "after fade the overlay is fully blue", expect: p => p.b > 200 && p.r < 60 },
    ],
  },
];

type RGB = { r: number; g: number; b: number };
const decodeRgb = (file: string): { data: Buffer; width: number; height: number } => {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { maxBuffer: 1 << 20 });
  const [width, height] = (probe.stdout.toString().trim().split(",") || ["0", "0"]).map(Number);
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { maxBuffer: 1 << 29 });
  if (out.status !== 0 || !out.stdout.length || !width || !height) throw new Error(`decode failed: ${file}`);
  return { data: out.stdout, width, height };
};
const probePng = (mp4: string, atMs: number, file: string) =>
  runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", (atMs / 1000).toFixed(3), "-i", mp4, "-frames:v", "1", file], { timeoutMs: 60_000 });
// The export resolution follows the capture page scale, so probes address the
// frame by share of width/height instead of absolute pixels.
const pixel = (frame: { data: Buffer; width: number; height: number }, nx: number, ny: number): RGB => {
  const x = Math.min(frame.width - 1, Math.round(nx * frame.width));
  const y = Math.min(frame.height - 1, Math.round(ny * frame.height));
  const at = (y * frame.width + x) * 3;
  return { r: frame.data[at]!, g: frame.data[at + 1]!, b: frame.data[at + 2]! };
};
const describe = (p: RGB) => `rgb(${p.r},${p.g},${p.b})`;

const failures: string[] = [];
const evidence: string[] = [];
for (const run of runs) {
  const projectFile = path.join(work, `${run.name}.json`), mp4 = path.join(work, `${run.name}.mp4`);
  fs.writeFileSync(projectFile, run.json);
  const rendered = await renderNle({ projectFile, assetsDir: assets, out: mp4, encoding: "draft" });
  for (const probeSpec of run.probes) {
    const png = path.join(outDir, `${run.name}-${probeSpec.at}ms.png`);
    await probePng(mp4, probeSpec.at, png);
    if (!evidence.includes(png)) evidence.push(png);
    const actual = pixel(decodeRgb(png), probeSpec.nx, probeSpec.ny);
    if (!probeSpec.expect(actual)) failures.push(`${run.name} @${probeSpec.at}ms ${probeSpec.label}: got ${describe(actual)}`);
  }
  void rendered;
}
try {
  fs.rmSync(work, { recursive: true, force: true });
} catch { /* temp dir is best-effort */ }
const summary = {
  ranAt: new Date().toISOString(),
  matrix: runs.map(run => ({ run: run.name, probes: run.probes.map(probe => probe.label) })),
  evidenceScreenshots: evidence.map(file => path.relative(process.cwd(), file)),
  failures,
  verdict: failures.length === 0
    ? "PASS: silver-mono preset, circle+screen and feathered-rect+multiply masks, and fade-in transitions all land as analytically expected pixels through the full NLE export"
    : `FAIL: ${failures.join("; ")}`,
  instrument: "ffmpeg solid-colour fixtures (red base, blue overlay); full renderNle export per matrix cell; RGB24 frame probes at fixed coordinates against analytic expectations",
};
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`[edit07] ${summary.verdict}; summary → ${path.join(outDir, "summary.json")}`);
if (failures.length > 0) process.exitCode = 1;
