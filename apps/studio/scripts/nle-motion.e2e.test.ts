import fs from "node:fs";
import * as publication from "./nle-publish";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { parseNleProject } from "@glintai/scenescript";
import { renderNle } from "./nle-render";
import { findSystemBrowser } from "./direct-browser/host";
let available = true; try { findSystemBrowser(); if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) available = false; } catch { available = false; }
const run = (tool: string, args: string[]) => { const result = spawnSync(tool, args, { maxBuffer: 16 * 1024 * 1024 }); expect(result.status, result.stderr.toString()).toBe(0); return result.stdout; };
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available)("integrates moving MG and video at subframes, preserves default bytes/audio and repeats frame hashes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-e2e-"));
  try {
    run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=60:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, "footage.mp4")]);
    run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", path.join(root, "tone.wav")]);
    const project = parseNleProject({ schemaVersion: 1, id: "motion", title: "Motion integration", width: 320, height: 180, fps: 10, tracks: [
      { id: "v", kind: "video", name: "Generated-media equivalent local fixture", clips: [{ id: "v1", kind: "video", src: "assets/footage.mp4", startMs: 0, durationMs: 400, volume: 0 }] },
      { id: "t", kind: "text", name: "MG", clips: [{ id: "text", kind: "text", text: "MOVE", fontSize: 48, startMs: 0, durationMs: 400, keyframes: [{ ms: 0, x: -0.4 }, { ms: 400, x: 0.4 }] }] },
      { id: "a", kind: "audio", name: "Audio", clips: [{ id: "audio", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 400 }] },
    ] });
    const source = path.join(root, "project.json"); fs.writeFileSync(source, JSON.stringify(project)); const original = fs.readFileSync(source);
    const results = [];
    for (const [name, samples] of [["default", undefined], ["one", 1], ["two", 2], ["four", 4], ["repeat", 4], ["eight", 8]] as const) {
      const output = path.join(root, name + ".mp4");
      const result = await renderNle({ projectFile: source, assetsDir: root, out: output, motionSamples: samples, shutterAngle: 360 }); results.push(result);
      const streams = JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_frames", "-of", "json", output]).toString()).streams;
      expect(streams.find((stream: { codec_type: string }) => stream.codec_type === "video")).toMatchObject({ width: 320, height: 180, r_frame_rate: "10/1", nb_frames: "4" });
      expect(streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
      if (samples && samples > 1) { expect(result.motion?.samplesRendered).toBe(samples * 4); expect(result.motion?.outputSha256).toBe(hash(fs.readFileSync(output))); }
    }
    expect(fs.readFileSync(path.join(root, "default.mp4"))).toEqual(fs.readFileSync(path.join(root, "one.mp4")));
    expect(results[3]!.motion?.frameSha256).toBe(results[4]!.motion?.frameSha256);
    const raw = (name: string) => run("ffmpeg", ["-v", "error", "-i", path.join(root, name + ".mp4"), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(hash(raw("four"))).not.toBe(hash(raw("one"))); expect(raw("four")).toEqual(raw("repeat"));
    const audio = (name: string) => run("ffmpeg", ["-v", "error", "-i", path.join(root, name + ".mp4"), "-map", "0:a", "-f", "s16le", "pipe:1"]);
    expect(audio("four")).toEqual(audio("one")); expect(fs.readFileSync(source)).toEqual(original);
    console.log("MOTION_EXPORT", JSON.stringify(results.map(result => ({ bytes: result.bytes, durationMs: result.durationMs, motion: result.motion }))));
    if (process.env.GLINT_MOTION_EVIDENCE_DIR) { fs.mkdirSync(process.env.GLINT_MOTION_EVIDENCE_DIR, { recursive: true }); for (const name of ["one.mp4", "four.mp4", "four.cover.jpg"]) fs.copyFileSync(path.join(root, name), path.join(process.env.GLINT_MOTION_EVIDENCE_DIR, name)); }
  } finally { if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available)("preserves supported alpha and refuses unsupported media before capture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-alpha-"));
  try {
    const project = { schemaVersion: 1, id: "alpha", title: "Alpha", width: 320, height: 180, fps: 10, tracks: [{ id: "t", kind: "text", name: "Text", clips: [{ id: "c", kind: "text", text: "ALPHA", fontSize: 40, startMs: 0, durationMs: 200, keyframes: [{ ms: 0, x: -0.2 }, { ms: 200, x: 0.2 }] }] }] };
    const source = path.join(root, "project.json"); fs.writeFileSync(source, JSON.stringify(project));
    const out = path.join(root, "alpha.webm"); await renderNle({ projectFile: source, assetsDir: root, out, alpha: true, motionSamples: 4 });
    const pixels = run("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", out, "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"]);
    const alpha = pixels.filter((_, index) => index % 4 === 3); expect(alpha.some(value => value === 0)).toBe(true); expect(alpha.some(value => value > 200)).toBe(true);
    fs.writeFileSync(source, JSON.stringify({ ...project, tracks: [{ id: "v", kind: "video", name: "Video", clips: [{ id: "v", kind: "video", src: "assets/missing.mp4", startMs: 0, durationMs: 200 }] }] }));
    await expect(renderNle({ projectFile: source, assetsDir: root, out: path.join(root, "bad.webm"), alpha: true, motionSamples: 4 })).rejects.toThrow("不支持画面片段");
    expect(fs.existsSync(path.join(root, "bad.webm"))).toBe(false);
  } finally { if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available)("does not borrow prior-shot colors across a hard cut", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-cut-"));
  try {
    for (const color of ["red", "blue"]) run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", `color=${color}:s=160x90:r=20:d=0.3`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(root, `${color}.mp4`)]);
    const source = path.join(root, "project.json"), out = path.join(root, "cut.mp4");
    fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, id: "cut", title: "Cut", width: 160, height: 90, fps: 20, tracks: [{ id: "v", kind: "video", name: "Video", clips: [
      { id: "red", kind: "video", src: "assets/red.mp4", startMs: 0, durationMs: 100, volume: 0 }, { id: "blue", kind: "video", src: "assets/blue.mp4", startMs: 100, durationMs: 100, volume: 0 },
    ] }] }));
    const captureCut = async (output: string, samples: number) => {
      let png: Buffer | undefined;
      const timer = setInterval(() => {
        for (const name of fs.readdirSync(root).filter(value => value.startsWith("glint-nle-"))) {
          const frame = path.join(root, name, "frames", "000002.png");
          if (fs.existsSync(frame)) png = fs.readFileSync(frame);
        }
      }, 5);
      try { await renderNle({ projectFile: source, assetsDir: root, out: output, motionSamples: samples, shutterAngle: 360 }); }
      finally { clearInterval(timer); }
      expect(png).toBeDefined(); return png!;
    };
    const sampledPng = await captureCut(out, 4);
    const baseline = path.join(root, "baseline.mp4"), originalPng = await captureCut(baseline, 1);
    const sampleFrame = path.join(root, "sample.png"), originalFrame = path.join(root, "original.png");
    fs.writeFileSync(sampleFrame, sampledPng); fs.writeFileSync(originalFrame, originalPng);
    const pngPixels = (file: string) => run("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    expect(pngPixels(sampleFrame)).toEqual(pngPixels(originalFrame));
    const reference = run("ffmpeg", ["-v", "error", "-i", baseline, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    const pixels = run("ffmpeg", ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]), stride = 160 * 90 * 3;
    expect(pixels.length).toBe(stride * 4);
    const center = (frame: number) => [...pixels.subarray(frame * stride + (45 * 160 + 80) * 3, frame * stride + (45 * 160 + 80) * 3 + 3)];
    console.log("CUT_DIAGNOSTIC", JSON.stringify({ actual: [center(0),center(1),center(2),center(3)], baseline: Array.from({ length: 4 }, (_, frame) => [...reference.subarray(frame * stride + (45 * 160 + 80) * 3, frame * stride + (45 * 160 + 80) * 3 + 3)]) }));
    expect(center(1)[0]).toBeGreaterThan(230); expect(center(1)[2]).toBeLessThan(20);
    // Source/browser color conversion has red=25 even in the unblurred blue shot.
    // Strict full-frame equality to that baseline tests leakage without relaxing a guessed threshold.
    expect(pixels).toEqual(reference); expect(center(2)[2]).toBeGreaterThan(230);
  } finally { if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available)("cancels an owned FFmpeg process and cleans only this render workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-cancel-")), previous = process.env.GLINT_PROCESS_LEDGER;
  const ledger = path.join(root, "processes.jsonl"), controller = new AbortController(); let timer: ReturnType<typeof setInterval> | undefined;
  try {
    run("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", path.join(root, "tone.wav")]);
    const source = path.join(root, "project.json"), out = path.join(root, "cancelled.mp4");
    fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, id: "cancel", title: "Cancel", width: 160, height: 90, fps: 10, tracks: [
      { id: "t", kind: "text", name: "Text", clips: [{ id: "c", kind: "text", text: "Cancel", startMs: 0, durationMs: 200 }] },
      { id: "a", kind: "audio", name: "Audio", clips: [{ id: "a", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 200 }] },
    ] }));
    process.env.GLINT_PROCESS_LEDGER = ledger;
    timer = setInterval(() => { if (fs.existsSync(ledger) && fs.readFileSync(ledger, "utf8").includes('"command":"ffmpeg"')) controller.abort(); }, 5);
    await expect(renderNle({ projectFile: source, assetsDir: root, out, motionSamples: 2, signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true); expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.startsWith("glint-nle-"))).toBe(false);
    const records = fs.readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as { pid: number; command: string });
    expect(records.some(record => record.command === "ffmpeg")).toBe(true);
    console.log("OWNED_PROCESS_DIAGNOSTIC", JSON.stringify(records.map(record => { try { process.kill(record.pid, 0); return { command: record.command, alive: true }; } catch { return { command: record.command, alive: false }; } })));
    for (const record of records) expect(() => process.kill(record.pid, 0)).toThrow(); // Only PIDs from this test's owned spawn ledger; no enumeration or kill.
    expect(fs.existsSync(source)).toBe(true); expect(fs.existsSync(path.join(root, "tone.wav"))).toBe(true);
  } finally {
    if (timer) clearInterval(timer); if (previous === undefined) delete process.env.GLINT_PROCESS_LEDGER; else process.env.GLINT_PROCESS_LEDGER = previous;
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
  }
}, 120_000);


it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available).each(["corrupt-copy", "cover-race"])("fails exclusive publication safely on %s", async fault => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-publish-"));
  const out = path.join(root, "result.mp4"), cover = path.join(root, "result.cover.jpg"), source = path.join(root, "project.json");
  const copy = publication.publishExclusive;
  try {
    fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, id: "publish", title: "Publish", width: 160, height: 90, fps: 10, tracks: [{ id: "t", kind: "text", name: "MG", clips: [{ id: "c", kind: "text", text: "COPY", startMs: 0, durationMs: 100 }] }] }));
    vi.spyOn(publication, "publishExclusive").mockImplementation(async (from, to, signal) => {
      await copy(from, to, signal);
      if (to === out) {
        if (fault === "corrupt-copy") fs.appendFileSync(out, "corrupt");
        else fs.writeFileSync(cover, "concurrent-user-cover", { flag: "wx" });
      }
    });
    await expect(renderNle({ projectFile: source, assetsDir: root, out, motionSamples: 2 })).rejects.toThrow(fault === "corrupt-copy" ? "digest mismatch" : "EEXIST");
    expect(fs.existsSync(out)).toBe(false);
    if (fault === "cover-race") expect(fs.readFileSync(cover, "utf8")).toBe("concurrent-user-cover"); else expect(fs.existsSync(cover)).toBe(false);
    expect(fs.existsSync(source)).toBe(true); expect(fs.readdirSync(root).some(name => name.startsWith("glint-nle-"))).toBe(false);
  } finally { vi.restoreAllMocks(); if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
it.skipIf(process.env.GLINT_NLE_MOTION_E2E !== "1" || !available)("publishes a one-frame motion render with verified output and cover", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-motion-publish-ok-"));
  try {
    const source = path.join(root, "project.json"), out = path.join(root, "result.mp4");
    fs.writeFileSync(source, JSON.stringify({ schemaVersion: 1, id: "publish", title: "Publish", width: 160, height: 90, fps: 10, tracks: [{ id: "t", kind: "text", name: "MG", clips: [{ id: "c", kind: "text", text: "COPY", startMs: 0, durationMs: 100 }] }] }));
    const result = await renderNle({ projectFile: source, assetsDir: root, out, motionSamples: 2 });
    expect(result.motion?.outputSha256).toBe(hash(fs.readFileSync(out)));
    expect(result.cover && fs.statSync(result.cover).size).toBeGreaterThan(0);
    const probe = JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", out]).toString());
    expect(probe.streams[0]).toMatchObject({ width: 160, height: 90, nb_read_frames: "1" });
    expect(fs.readdirSync(root).some(name => name.startsWith("glint-nle-"))).toBe(false);
    console.log("OWNED_PUBLICATION", JSON.stringify({ bytes: result.bytes, sha256: result.motion?.outputSha256, frames: 1 }));
  } finally { if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true }); }
}, 120_000);
