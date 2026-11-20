import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { nleAlphaIssues, parseNleProject } from "@glintai/scenescript";
import { renderNle } from "./nle-render";
import { findSystemBrowser } from "./direct-browser/host";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const text = parseNleProject({ schemaVersion: 1, id: "alpha", title: "透明", width: 320, height: 180, fps: 10, background: "#102030", tracks: [{ id: "t", kind: "text", name: "文字", clips: [{ id: "title", kind: "text", text: "ALPHA", fontSize: 64, startMs: 0, durationMs: 300 }] }] });
it("preflights every opaque picture clip with an actionable identity", () => {
  const mixed = parseNleProject({ ...text, tracks: [...text.tracks, { id: "v", kind: "video", name: "画面", muted: true, clips: [{ id: "still", kind: "image", src: "assets/a.png", startMs: 0, durationMs: 300 }, { id: "footage", kind: "video", src: "assets/a.mp4", startMs: 0, durationMs: 300 }] }] });
  expect(nleAlphaIssues(mixed).map(item => [item.trackId, item.clipId])).toEqual([["v", "still"], ["v", "footage"]]);
  expect(nleAlphaIssues(text)).toEqual([]);
});
it("rejects bad extensions, odd dimensions and opaque clips before output creation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-reject-")); dirs.push(dir);
  const file = path.join(dir, "p.json"), out = path.join(dir, "out.webm"); fs.writeFileSync(file, JSON.stringify(text));
  await expect(renderNle({ projectFile: file, assetsDir: dir, out: path.join(dir, "out.mp4"), alpha: true })).rejects.toThrow(/webm/i);
  fs.writeFileSync(file, JSON.stringify({ ...text, width: 321 }));
  await expect(renderNle({ projectFile: file, assetsDir: dir, out, alpha: true })).rejects.toThrow(/偶数/);
  fs.writeFileSync(file, JSON.stringify({ ...text, tracks: [...text.tracks, { id: "v", kind: "video", name: "画面", clips: [{ id: "still", kind: "image", src: "assets/a.png", startMs: 0, durationMs: 300 }] }] }));
  await expect(renderNle({ projectFile: file, assetsDir: dir, out, alpha: true })).rejects.toThrow(/v\/still/);
  expect(fs.existsSync(out)).toBe(false); expect(fs.readdirSync(dir)).toEqual(["p.json"]);
});
let available = true;
try { findSystemBrowser(); if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) available = false; } catch { available = false; }
it.skipIf(!available)("encodes text as VP9 WebM with real transparent and visible pixels", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-")); dirs.push(dir);
  const projectFile = path.join(dir, "project.json"), out = path.join(dir, "alpha.webm"); fs.writeFileSync(projectFile, JSON.stringify(text));
  const result = await renderNle({ projectFile, assetsDir: dir, out, alpha: true }); expect(result.bytes).toBeGreaterThan(0);
  // The native VP9 decoder may discard alpha. Force libvpx-vp9 and inspect RGBA pixels.
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout.length).toBe(320 * 180 * 4);
  const alpha: number[] = []; for (let i = 3; i < decoded.stdout.length; i += 4) alpha.push(decoded.stdout[i]!);
  expect(alpha[0]).toBeLessThan(10); expect(alpha.filter(a => a < 10).length).toBeGreaterThan(30000); expect(alpha.filter(a => a > 240).length).toBeGreaterThan(100);
}, 60000);
it.skipIf(!available)("retains a real audio track as Opus while keeping alpha pixels", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-audio-")); dirs.push(dir);
  const audio = path.join(dir, "tone.wav"), out = path.join(dir, "alpha.webm"), projectFile = path.join(dir, "p.json");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-ar", "48000", audio]);
  expect(generated.status, generated.stderr.toString()).toBe(0);
  fs.writeFileSync(projectFile, JSON.stringify({ ...text, tracks: [...text.tracks, { id: "audio", kind: "audio", name: "音频", clips: [{ id: "sound", kind: "audio", src: "assets/tone.wav", startMs: 0, durationMs: 300 }] }] }));
  await renderNle({ projectFile, assetsDir: dir, out, alpha: true });
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", out]);
  expect(probe.status, probe.stderr.toString()).toBe(0);
  expect(JSON.parse(probe.stdout.toString()).streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_type: "video", codec_name: "vp9" }), expect.objectContaining({ codec_type: "audio", codec_name: "opus" })]));
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 2 * 1024 * 1024 });
  expect(decoded.status, decoded.stderr.toString()).toBe(0); expect(decoded.stdout[3]).toBeLessThan(10);
}, 60000);
it.skipIf(!available)("refuses an old capture harness instead of silently exporting opaque frames", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glint-alpha-stale-")); dirs.push(dir);
  const projectFile = path.join(dir, "p.json"), harness = path.join(dir, "harness.js"), out = path.join(dir, "alpha.webm");
  fs.writeFileSync(projectFile, JSON.stringify(text));
  fs.writeFileSync(harness, 'window.__glintNleInit = async function() { document.body.style.background="#000"; }; window.__glintNleSeek = async function() {};');
  const previous = process.env.GLINT_NLE_HARNESS; process.env.GLINT_NLE_HARNESS = harness;
  // A mismatched environment lock must refuse before any browser launch, on every platform.
  const lock = path.join(dir, "env-lock.json");
  fs.writeFileSync(lock, JSON.stringify({ version: 1, environment: { platform: "ci-nonexistent", node: "v0.0.0", ffmpeg: "missing", browser: "missing", browserPath: "missing", resvg: "missing", designTokens: "missing", scenescript: "missing", fontsHash: "0000000000000000" } }));
  try {
    await expect(renderNle({ projectFile, assetsDir: dir, out, alpha: true, envLock: lock })).rejects.toThrow(/渲染环境与锁不匹配/);
    expect(fs.existsSync(out)).toBe(false);
    await expect(renderNle({ projectFile, assetsDir: dir, out, alpha: true })).rejects.toThrow(/版本不匹配/);
    expect(fs.existsSync(out)).toBe(false);
  }
  finally { if (previous === undefined) delete process.env.GLINT_NLE_HARNESS; else process.env.GLINT_NLE_HARNESS = previous; }
}, 60000);
