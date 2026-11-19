import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { updateNleProjectSettings } from "../../web/src/NleProjectSettings";
import { renderNle } from "./nle-render";
import { findSystemBrowser } from "./direct-browser/host";

let available = true; try { findSystemBrowser(); if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) available = false; } catch { available = false; }
it.skipIf(process.env.GLINT_NLE_4K_E2E !== "1" || !available)("renders a 4K clip with the selected frame rate and visible text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-4k-settings-"));
  try {
    const original = parseNleProject({ schemaVersion: 1, id: "resolution", title: "4K", width: 1920, height: 1080, fps: 30, tracks: [{ id: "t", kind: "text", name: "文字", clips: [{ id: "caption", kind: "text", text: "4K TEST", fontSize: 64, startMs: 0, durationMs: 100 }] }] });
    const project = updateNleProjectSettings(original, 3840, 20), source = path.join(dir, "project.json"), output = path.join(dir, "out.mp4");
    fs.writeFileSync(source, JSON.stringify(project)); const start = performance.now();
    const result = await renderNle({ projectFile: source, assetsDir: dir, out: output, encoding: "balanced" });
    const elapsedSeconds = (performance.now() - start) / 1000;
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", output]);
    expect(probe.status, probe.stderr.toString()).toBe(0);
    expect(JSON.parse(probe.stdout.toString()).streams[0]).toMatchObject({ width: 3840, height: 2160, r_frame_rate: "20/1" });
    const frame = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-frames:v", "1", "-vf", "crop=1600:500:1120:830,format=gray", "-f", "rawvideo", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
    expect(frame.status, frame.stderr.toString()).toBe(0); expect(frame.stdout.filter(value => value > 180).length).toBeGreaterThan(100);
    expect(result.bytes).toBeGreaterThan(0);
    console.log(JSON.stringify({ resolution: "3840x2160", fps: 20, durationMs: 100, wallSeconds: Math.round(elapsedSeconds * 10) / 10, note: "短片单次测量，不代表长片性能或峰值内存" }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(process.env.GLINT_NLE_4K_E2E !== "1" || !available)("compares the same media timeline at 1080p and 4K", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-resolution-compare-"));
  try {
    const generate = (args: string[]) => { const run = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args]); expect(run.status, run.stderr.toString()).toBe(0); };
    generate(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=20:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "source.mp4")]);
    generate(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", path.join(dir, "source.wav")]);
    const original = parseNleProject({ schemaVersion: 1, id: "compare", title: "Resolution compare", width: 1920, height: 1080, fps: 20, tracks: [
      { id: "v", kind: "video", name: "画面", clips: [{ id: "video", kind: "video", src: "assets/source.mp4", startMs: 0, durationMs: 500, volume: 0 }] },
      { id: "t", kind: "text", name: "文字", clips: [{ id: "caption", kind: "text", text: "Resolution test", fontSize: 64, startMs: 0, durationMs: 500 }] },
      { id: "a", kind: "audio", name: "声音", clips: [{ id: "audio", kind: "audio", src: "assets/source.wav", startMs: 0, durationMs: 500 }] },
    ] });
    const measurements = [];
    for (const width of [1920, 3840]) {
      const project = updateNleProjectSettings(original, width, 20), source = path.join(dir, `${width}.json`), output = path.join(dir, `${width}.mp4`);
      fs.writeFileSync(source, JSON.stringify(project)); const started = performance.now();
      const result = await renderNle({ projectFile: source, assetsDir: dir, out: output, encoding: "balanced" });
      const seconds = (performance.now() - started) / 1000;
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_frames", "-of", "json", output]);
      expect(probe.status, probe.stderr.toString()).toBe(0);
      const streams = JSON.parse(probe.stdout.toString()).streams as Array<Record<string, unknown>>;
      expect(streams.find(stream => stream.codec_type === "video")).toMatchObject({ width, height: width * 9 / 16, r_frame_rate: "20/1", nb_frames: "10" });
      expect(streams.some(stream => stream.codec_type === "audio")).toBe(true); expect(result.bytes).toBeGreaterThan(0);
      measurements.push({ resolution: `${width}x${width * 9 / 16}`, fps: 20, frames: 10, seconds: +seconds.toFixed(3), bytes: result.bytes });
    }
    console.log("NLE_COMPARISON", JSON.stringify(measurements));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
