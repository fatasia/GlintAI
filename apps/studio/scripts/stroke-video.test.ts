import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { renderNative } from "./native-render";

function assertVideoFramesChange(output: string) {
  const frame = (time: string) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-ss", time, "-i", output, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    return result.stdout;
  };
  expect(frame("0.1").equals(frame("2.2"))).toBe(false);
}

it.skipIf(process.env.GLINT_STROKE_VIDEO !== "1")("exports a real editable stroke project to H.264 with no model calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-stroke-video-"));
  const project = parseProject({ schemaVersion: 1, id: "draw-an-idea", title: "把想法画出来", aspect: "16:9", theme: "whiteboard", fps: 30, knowledgeSources: [], scenes: [{ id: "first-line", kind: "title", title: "把想法画出来", subtitle: "从一笔开始。", narration: { text: "把想法画出来", durationMs: 2500 }, elements: [{ id: "underline", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M510 675 Q740 650 960 675 Q1180 700 1390 665", stroke: "#d65b37", strokeWidth: 12, drawStartMs: 500, drawDurationMs: 900 }, { id: "arrow", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M1380 760 C1580 790 1670 670 1580 570 M1535 575 L1580 570 L1585 615", stroke: "#376b82", strokeWidth: 10, drawStartMs: 1300, drawDurationMs: 800 }] }] });
  try {
    const source = path.join(root, "project.json"), output = path.join(root, "draw-an-idea.mp4"); fs.writeFileSync(source, JSON.stringify(project, null, 2));
    await renderNative({ projectPath: source, output, fast: true, tts: "mock", music: "off", noCache: true });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(0); const video = JSON.parse(probe.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    expect(video).toMatchObject({ codec_name: "h264", width: 960, height: 540, nb_frames: "75" });
    assertVideoFramesChange(output);
    if (process.env.GLINT_STROKE_EVIDENCE) {
      const target = process.env.GLINT_STROKE_EVIDENCE; fs.mkdirSync(target, { recursive: true });
      for (const [name, saved] of [["project.json", "idea-project.json"], ["draw-an-idea.mp4", "draw-an-idea.mp4"]] as [string, string][]) fs.copyFileSync(path.join(root, name), path.join(target, saved), fs.constants.COPYFILE_EXCL);
      const still = spawnSync("ffmpeg", ["-v", "error", "-ss", "2.2", "-i", output, "-frames:v", "1", path.join(target, "sample-frame.png")], { windowsHide: true }); expect(still.status).toBe(0);
    }
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

it.skipIf(process.env.GLINT_STROKE_VIDEO !== "1")("exports arc and relative-command strokes to a real H.264 file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-stroke-arc-video-"));
  const project = parseProject({ schemaVersion: 1, id: "arc-strokes", title: "弧线笔记", aspect: "16:9", theme: "whiteboard", fps: 30, knowledgeSources: [], scenes: [{ id: "arc-scene", kind: "title", title: "弧线笔记", narration: { text: "弧线笔记", durationMs: 2500 }, elements: [
    { id: "arc", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M360 640 a300 300 0 0 1 600 0", stroke: "#376b82", strokeWidth: 14, drawStartMs: 300, drawDurationMs: 900 },
    { id: "smooth", kind: "path", x: 0.5, y: 0.5, w: 1, h: 1, viewBox: [1920, 1080], d: "M540 620 h240 V360 s-120 -80 -240 0 T540 360 Z", stroke: "#d65b37", strokeWidth: 10, drawStartMs: 1200, drawDurationMs: 900 },
  ] }] });
  try {
    const source = path.join(root, "project.json"), output = path.join(root, "arc-strokes.mp4"); fs.writeFileSync(source, JSON.stringify(project, null, 2));
    await renderNative({ projectPath: source, output, fast: true, tts: "mock", music: "off", noCache: true });
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames", "-of", "json", output], { encoding: "utf8", windowsHide: true });
    expect(probe.status).toBe(0); const video = JSON.parse(probe.stdout).streams.find((stream: { codec_type: string }) => stream.codec_type === "video");
    expect(video).toMatchObject({ codec_name: "h264", width: 960, height: 540, nb_frames: "75" });
    assertVideoFramesChange(output);
    // CREATE-11:渲染回执带环境指纹(FFmpeg/浏览器/字体),换机或升级可追溯。
    const metrics = JSON.parse(fs.readFileSync(`${output}.metrics.json`, "utf8")) as { environment: { ffmpeg: string; browser: string; resvg: string; fontIdentity: unknown } };
    expect(metrics.environment).toMatchObject({ platform: process.platform, resvg: expect.any(String), fontIdentity: expect.anything() });
    expect(metrics.environment.ffmpeg).toMatch(/^[0-9a-f]{64}$/);
    if (process.env.GLINT_STROKE_EVIDENCE) {
      const target = process.env.GLINT_STROKE_EVIDENCE; fs.mkdirSync(target, { recursive: true });
      for (const [name, saved] of [["project.json", "arc-project.json"], ["arc-strokes.mp4", "arc-strokes.mp4"]] as [string, string][]) fs.copyFileSync(path.join(root, name), path.join(target, saved), fs.constants.COPYFILE_EXCL);
      const still = spawnSync("ffmpeg", ["-v", "error", "-ss", "2.2", "-i", output, "-frames:v", "1", path.join(target, "arc-sample-frame.png")], { windowsHide: true }); expect(still.status).toBe(0);
    }
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("unsafe temporary path");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
