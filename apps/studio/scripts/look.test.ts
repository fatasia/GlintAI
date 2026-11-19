import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { inspectLook, runLook } from "./look";
import { captureLook } from "./look-diagnostics";
import { runMediaProcess } from "./native-process";

let root: string, video: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glint-look-")); video = path.join(root, "source.mkv");
  await runMediaProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=160x90:r=10:d=2", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0\\,0.999):s=8000:d=2", "-c:v", "libx264", "-threads", "1", "-c:a", "pcm_s16le", video]);
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

it("exports contact sheet, frame, interval and real black/silence/sample-peak findings without changing input", async () => {
  const before = await fs.readFile(video), out = path.join(root, "look");
  const report = await inspectLook({ video, out, samples: 4, at: 0.5, start: 0.2, end: 1.2 });
  expect(report.diagnostics.black[0]!.start).toBe(0);
  expect(report.diagnostics.black[0]!.end).toBeGreaterThan(1.8);
  expect(report.diagnostics.silence[0]!.end).toBeCloseTo(1, 1);
  expect(report.diagnostics.nearFullScale).toBe(true);
  expect(report.artifacts.map(a => a.path)).toEqual(expect.arrayContaining(["contact.png", "frame.png", "interval.mp4"]));
  expect((await fs.readFile(path.join(out, "contact.png"))).subarray(1, 4).toString()).toBe("PNG");
  const probe = JSON.parse((await captureLook("ffprobe", ["-v", "error", "-show_format", "-of", "json", path.join(out, "interval.mp4")])).stdout);
  expect(Number(probe.format.duration)).toBeGreaterThanOrEqual(0.9);
  expect(Number(probe.format.duration)).toBeLessThan(1.2);
  expect(await fs.readFile(video)).toEqual(before);
  expect(JSON.parse(await fs.readFile(path.join(out, "look.json"), "utf8")).sourceSha256).toBe(report.sourceSha256);
  await expect(inspectLook({ video, out })).rejects.toThrow();
});

it("reports absent audio explicitly", async () => {
  const silent = path.join(root, "no-audio.mp4");
  await runMediaProcess("ffmpeg", ["-v", "error", "-i", video, "-c:v", "copy", "-an", silent]);
  const report = await inspectLook({ video: silent, out: path.join(root, "silent-look"), samples: 1 });
  expect(report.diagnostics.audio).toBe("absent");
  expect(report.diagnostics.silence).toEqual([]);
});

it("rejects invalid ranges/limits and indirect input without creating output", async () => {
  const out = path.join(root, "invalid");
  for (const values of [{ at: -1 }, { at: 2 }, { samples: 25 }, { start: 1 }, { start: 1, end: 0 }, { samples: NaN }]) {
    await expect(inspectLook({ video, out, ...values })).rejects.toThrow();
  }
  await expect(inspectLook({ video: "https://invalid.example/video.mp4", out })).rejects.toThrow("local");
  const list = path.join(root, "indirect.m3u8"); await fs.writeFile(list, "#EXTM3U\n#EXTINF:2\nhttps://invalid.example/video.ts\n");
  await expect(inspectLook({ video: list, out })).rejects.toThrow();
  await expect(fs.stat(out)).rejects.toThrow();
  await expect(runLook(["--video=x", "--video=y"])).rejects.toThrow();
});
