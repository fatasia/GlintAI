import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseProject } from "@glintai/scenescript";
import { exportNleTimeline } from "./nle-export";

// DELIVER-04 第三方兼容性:Glint 导出的 FCPXML 1.9 与 CMX3600 EDL 由
// OpenTimelineIO(独立 venv,显式 opt-in)读回,轨道/片段/时长必须一致。
// OTIO 是多家剪辑软件共享的交换层,作为本机无 FCP/Premiere 时的真实第三方读取。
const VENV_PYTHON = process.env.GLINT_OTIO_PYTHON ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cache", "otio-venv", "Scripts", "python.exe");

it.skipIf(process.env.GLINT_OTIO_E2E !== "1")("exports a timeline that OpenTimelineIO reads back with matching structure", () => {
  if (!fs.existsSync(VENV_PYTHON)) throw new Error(`OpenTimelineIO venv missing: ${VENV_PYTHON}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "glint-otio-"));
  const project = parseProject({ schemaVersion: 1, id: "otio-check", title: "OTIO 交换验证", aspect: "16:9", fps: 30, knowledgeSources: [], scenes: [
    { id: "one", kind: "title", title: "第一镜", narration: { text: "第一镜", durationMs: 2000 } },
    { id: "two", kind: "title", title: "第二镜", narration: { text: "第二镜", durationMs: 1500 } },
    { id: "three", kind: "title", title: "第三镜", narration: { text: "第三镜", durationMs: 2500 } },
  ] });
  const spec = { width: 1920, height: 1080, fps: 30 };
  const fcpxml = exportNleTimeline({ project, videoPath: "D:/render/master.mp4", format: "fcpxml", outPath: path.join(root, "edit.fcpxml"), spec });
  const edl = exportNleTimeline({ project, videoPath: "D:/render/master.mp4", format: "edl", outPath: path.join(root, "edit.edl"), spec });
  expect(fcpxml.cuts).toBe(3); expect(edl.cuts).toBe(3);
  let summary: { fcpxml: { tracks: number; clipCount: number; durationSeconds: number; clips: Array<{ name: string; sourceSeconds: number | null }> }; edl: { tracks: number; clipCount: number; durationSeconds: number } };
  try {
    const json = execFileSync(VENV_PYTHON, [path.resolve("apps/studio/scripts/otio-check.py"), fcpxml.file, edl.file, String(spec.fps)], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    summary = JSON.parse(json.split(/\r?\n/, 1)[0]!);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  console.log("OTIO_READBACK", JSON.stringify(summary));
  // FCPXML:三个场景片段读回,时长 6 秒(±一帧取整)。
  expect(summary.fcpxml.clipCount).toBe(3);
  expect(summary.fcpxml.tracks).toBeGreaterThanOrEqual(1);
  expect(Math.abs(summary.fcpxml.durationSeconds - 6)).toBeLessThanOrEqual(1 / 30);
  expect(summary.fcpxml.clips.map(clip => clip.name.replace(/^\d+\s/, ""))).toEqual(["第一镜", "第二镜", "第三镜"]);
  for (const [index, seconds] of summary.fcpxml.clips.entries()) {
    const expected = [2000, 1500, 2500][index]! / 1000;
    expect(seconds.sourceSeconds, `clip ${index}`).not.toBeNull();
    expect(Math.abs(seconds.sourceSeconds! - expected)).toBeLessThanOrEqual(1 / 30);
  }
  // EDL:CMX3600 读回同样三个事件,总时长一致。
  expect(summary.edl.clipCount).toBe(3);
  expect(Math.abs(summary.edl.durationSeconds - 6)).toBeLessThanOrEqual(1 / 30);
});
