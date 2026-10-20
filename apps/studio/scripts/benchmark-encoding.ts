import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderFrames, renderMedia, selectComposition } from "@remotion/renderer";
import { parseProject } from "@glintai/scenescript";
import { encodingOptions, type EncodingProfile } from "./encoding";
import { copyProjectAssets } from "./assets";
import { copyRuntimeDecoders, ensureDecoders } from "./decoders";
const read = (name: string, fallback: string) => process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const parallelism = read("concurrency", "1").split(",").map(Number);
const repeats = Number(read("repeats", "3"));
const profiles = read("profiles", "quality,balanced,compact").split(",") as EncodingProfile[];
assert(parallelism.length && parallelism.length <= 4 && parallelism.every(value => Number.isInteger(value) && value >= 1 && value <= 16));
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
for (const profile of profiles) encodingOptions(profile);
const studio = fileURLToPath(new URL("../", import.meta.url)), repo = path.resolve(studio, "../..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "glint-encoding-check-"));
const fixture = path.join(repo, "examples/local-media/readiness.scenescript.json");
const publicDir = path.join(studio, "public");
const project = await copyProjectAssets(path.dirname(fixture), publicDir, parseProject(JSON.parse(fs.readFileSync(fixture, "utf8"))));
await Promise.all([copyRuntimeDecoders(publicDir), ensureDecoders(publicDir)]);
const serveUrl = await bundle({ entryPoint: path.join(studio, "src/index.ts"), publicDir });
const browser = await openBrowser("chrome");
const report: Record<string, unknown> = { output: out, platform: process.platform, cpu: os.cpus()[0]?.model, node: process.version, scale: 0.5, audio: false, status: "running", samples: [] };
try {
  const inputProps = { project }, composition = await selectComposition({ serveUrl, inputProps, id: "Glint", puppeteerInstance: browser });
  const frames = path.join(out, "reference"); fs.mkdirSync(frames);
  await renderFrames({ serveUrl, inputProps, composition, puppeteerInstance: browser, scale: 0.5, concurrency: 1, imageFormat: "png", outputDir: null, muted: true,
    onStart: () => {}, onFrameUpdate: () => {}, onFrameBuffer: (buffer, frame) => { fs.writeFileSync(path.join(frames, `${String(frame).padStart(4, "0")}.png`), buffer); },
  });
  // Rotate order to reduce first-encode bias. Timings include rendering and encoding, not bundling.
  const orders = Array.from({ length: repeats }, (_, index) => [...profiles.slice(index % profiles.length), ...profiles.slice(0, index % profiles.length)]);
  for (const [repeat, order] of orders.entries()) for (const concurrency of repeat % 2 ? [...parallelism].reverse() : parallelism) for (const profile of order) {
    const file = path.join(out, `${profile}-c${concurrency}-${repeat}.mp4`), start = performance.now();
    await renderMedia({ serveUrl, inputProps, composition, puppeteerInstance: browser, scale: 0.5, concurrency, codec: "h264", pixelFormat: "yuv420p", muted: true, outputLocation: file, ...encodingOptions(profile) });
    const elapsedMs = performance.now() - start;
    const psnr = spawnSync("ffmpeg", ["-v", "info", "-framerate", String(composition.fps), "-i", path.join(frames, "%04d.png"), "-i", file, "-lavfi", "[0:v]format=yuv420p[r];[r][1:v]psnr", "-f", "null", "-"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(psnr.status, 0, psnr.stderr);
    const match = /average:([\d.]+|inf)/.exec(psnr.stderr); assert(match, "PSNR summary missing");
    (report.samples as unknown[]).push({ profile, repeat, concurrency, frames: composition.durationInFrames, elapsedMs, bytes: fs.statSync(file).size, psnrDb: match[1] === "inf" ? "infinity" : Number(match[1]) });
    console.log(`[encoding] ${profile} c${concurrency} #${repeat}: ${elapsedMs.toFixed(0)}ms, ${fs.statSync(file).size} bytes, PSNR ${match[1]}`);
  }
  report.status = "passed"; console.log(`[encoding] report: ${out}`);
} catch (error) { report.status = "failed"; report.error = String(error); throw error; }
finally { await browser.close({ silent: true }); fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2)); }
