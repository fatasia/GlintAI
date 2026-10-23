import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Delivery QA gates, modeled on dashi's 自检 pipeline: sample frames every
 * SAMPLE_INTERVAL seconds at thumbnail size, then measure motion richness,
 * static spans, blue/purple "AI-slop" coverage and near-empty frames in pure
 * Node. ffmpeg/ffprobe provide decoding only — no judgments live there.
 * Gates are calibration-start values (2026-10); tune against real failures.
 */

export const SAMPLE_INTERVAL_SEC = 2.5;
export function qaSampleInterval(durationSec: number, fps: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error("Invalid video duration or fps for QA sampling");
  return Math.max(1 / fps, Math.min(SAMPLE_INTERVAL_SEC, durationSec / 8));
}
const THUMB_WIDTH = 192;

export interface QaGate {
  id: string;
  level: "green" | "yellow" | "red";
  detail: string;
}

export interface QaReport {
  video: string;
  spec: { width: number; height: number; fps: number; durationSec: number };
  frames: number;
  avgFrameDiff: number;
  longestStaticSec: number;
  bluePurpleRatio: number;
  flatFrameRatio: number;
  /** Standard deviation of the first sampled frame; low means an empty opening. */
  firstFrameStd?: number;
  firstFrameLuma?: number;
  gates: QaGate[];
  verdict: "green" | "yellow" | "red";
}

export interface QaThresholds {
  /** Average inter-frame diff below this = the film barely moves (red). */
  minAvgDiff: number;
  /** Below this = noticeable stillness stretch (yellow). */
  warnAvgDiff: number;
  /** A single static gap longer than this many seconds fails (red). */
  maxStaticSec: number;
  /** Blue/purple pixel share that reads as generic AI look (red). */
  maxBluePurpleRatio: number;
  warnBluePurpleRatio: number;
  /** First frame below this is a near-empty opening (red). */
  minFirstFrameStd: number;
  /** First frame below this is visually weak (yellow). */
  warnFirstFrameStd: number;
}

export const DEFAULT_QA_THRESHOLDS: QaThresholds = {
  minAvgDiff: 1.2,
  warnAvgDiff: 3,
  maxStaticSec: 5,
  maxBluePurpleRatio: 0.3,
  warnBluePurpleRatio: 0.18,
  minFirstFrameStd: 3,
  warnFirstFrameStd: 8,
};

function ffprobeJson(file: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", file,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => code === 0
      ? resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 200)}`)));
  });
}

export interface SpecInfo { width: number; height: number; fps: number; durationSec: number }

export async function probeVideo(videoPath: string): Promise<SpecInfo> {
  if (!fs.existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);
  const info = await ffprobeJson(videoPath);
  const stream = (info.streams ?? []).find((entry: any) => entry.codec_type === "video");
  if (!stream) throw new Error("No video stream found");
  const [numRaw, denRaw] = String(stream.r_frame_rate ?? "30/1").split("/");
  const num = Number(numRaw), den = Number(denRaw);
  const fps = Number.isFinite(num) && Number.isFinite(den) && den !== 0 ? num / den : 30;
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps: Math.round(fps * 100) / 100,
    durationSec: Number(info.format?.duration ?? stream.duration ?? 0),
  };
}

/** Decodes sample frames as raw RGB at thumbnail size. */
export async function extractFrames(videoPath: string, spec: SpecInfo): Promise<Uint8Array[]> {
  const thumbHeight = Math.max(2, Math.round((THUMB_WIDTH / spec.width) * spec.height));
  const frameBytes = THUMB_WIDTH * thumbHeight * 3;
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-loglevel", "error", "-i", videoPath,
      "-vf", `fps=1/${qaSampleInterval(spec.durationSec, spec.fps)},scale=${THUMB_WIDTH}:${thumbHeight}:flags=area`,
      "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("frame extraction timed out")); }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 200)}`));
      const raw = Buffer.concat(chunks);
      const frames: Uint8Array[] = [];
      for (let offset = 0; offset + frameBytes <= raw.length; offset += frameBytes) {
        frames.push(new Uint8Array(raw.subarray(offset, offset + frameBytes)));
      }
      resolve(frames);
    });
  });
}

export interface FrameStats { meanLuma: number; pixelStd: number; bluePurpleShare: number }

/** Per-frame color statistics (pure — unit-tested against synthetic pixels). */
export function frameStats(rgb: Uint8Array): FrameStats {
  let lumaSum = 0, lumaSqSum = 0, bluePurple = 0, count = 0;
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const r = rgb[i]!, g = rgb[i + 1]!, b = rgb[i + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma; lumaSqSum += luma * luma; count++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const value = max / 255, saturation = max === 0 ? 0 : (max - min) / max;
    let hue = 0;
    if (max !== min) {
      const delta = max - min;
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
    }
    // The "AI slop" band: saturated blue→purple backgrounds (not cyan, not navy text).
    if (saturation > 0.35 && value > 0.15 && hue >= 230 && hue <= 300) bluePurple++;
  }
  const meanLuma = lumaSum / count;
  return {
    meanLuma,
    pixelStd: Math.sqrt(Math.max(0, lumaSqSum / count - meanLuma * meanLuma)),
    bluePurpleShare: bluePurple / count,
  };
}

/** Mean absolute luma diff between two same-size frames (pure). */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i + 2 < limit; i += 3) {
    const la = 0.2126 * a[i]! + 0.7152 * a[i + 1]! + 0.0722 * a[i + 2]!;
    const lb = 0.2126 * b[i]! + 0.7152 * b[i + 1]! + 0.0722 * b[i + 2]!;
    sum += Math.abs(la - lb);
  }
  return sum / (limit / 3);
}

export function analyzeFrames(
  frames: Uint8Array[],
  thresholds: QaThresholds = DEFAULT_QA_THRESHOLDS,
  sampleIntervalSec = SAMPLE_INTERVAL_SEC,
): { avgFrameDiff: number; longestStaticSec: number; bluePurpleRatio: number; flatFrameRatio: number; firstFrameStd?: number; firstFrameLuma?: number } {
  if (frames.length === 0) return { avgFrameDiff: 0, longestStaticSec: 0, bluePurpleRatio: 0, flatFrameRatio: 1, firstFrameStd: 0, firstFrameLuma: 0 };
  const stats = frames.map(frameStats);
  const diffs: number[] = [];
  for (let i = 1; i < frames.length; i++) diffs.push(frameDiff(frames[i - 1]!, frames[i]!));
  const avgFrameDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  let longestStatic = 0, currentStatic = 0;
  for (const diff of diffs) {
    if (diff < 0.4) { currentStatic++; longestStatic = Math.max(longestStatic, currentStatic); }
    else currentStatic = 0;
  }
  // A static "span" is count+1 identical samples; the first pair is forgiven
  // (title cards legitimately open on a held frame).
  const longestStaticSec = diffs.length > 1 ? longestStatic * sampleIntervalSec : 0;
  const bluePurpleRatio = stats.reduce((sum, entry) => sum + entry.bluePurpleShare, 0) / stats.length;
  const flatFrames = stats.filter((entry) => entry.pixelStd < 4).length;
  return {
    avgFrameDiff,
    longestStaticSec,
    bluePurpleRatio,
    flatFrameRatio: flatFrames / stats.length,
    firstFrameStd: stats[0]!.pixelStd,
    firstFrameLuma: stats[0]!.meanLuma,
  };
}

export function buildGates(
  analysis: ReturnType<typeof analyzeFrames>,
  spec: SpecInfo,
  thresholds: QaThresholds = DEFAULT_QA_THRESHOLDS,
): QaGate[] {
  const gates: QaGate[] = [];
  gates.push(analysis.avgFrameDiff >= thresholds.warnAvgDiff
    ? { id: "richness", level: "green", detail: `平均帧差 ${analysis.avgFrameDiff.toFixed(2)},画面变化充足` }
    : analysis.avgFrameDiff >= thresholds.minAvgDiff
      ? { id: "richness", level: "yellow", detail: `平均帧差 ${analysis.avgFrameDiff.toFixed(2)} 偏静,建议加次要动作或运镜` }
      : { id: "richness", level: "red", detail: `平均帧差仅 ${analysis.avgFrameDiff.toFixed(2)},整片接近静止(翻页式 PPT)` });
  gates.push(analysis.longestStaticSec <= thresholds.maxStaticSec
    ? { id: "static-span", level: "green", detail: `最长静止 ${analysis.longestStaticSec.toFixed(1)}s` }
    : { id: "static-span", level: "red", detail: `中段静止超过 ${thresholds.maxStaticSec}s(${analysis.longestStaticSec.toFixed(1)}s),补变化或切镜头` });
  gates.push(analysis.bluePurpleRatio <= thresholds.warnBluePurpleRatio
    ? { id: "blue-purple", level: "green", detail: `蓝紫底占比 ${(analysis.bluePurpleRatio * 100).toFixed(1)}%` }
    : analysis.bluePurpleRatio <= thresholds.maxBluePurpleRatio
      ? { id: "blue-purple", level: "yellow", detail: `蓝紫底占比 ${(analysis.bluePurpleRatio * 100).toFixed(1)}% 偏高,有 AI 味` }
      : { id: "blue-purple", level: "red", detail: `蓝紫底占比 ${(analysis.bluePurpleRatio * 100).toFixed(1)}%,一眼 AI 生成感,换风格包底色` });
  gates.push(analysis.flatFrameRatio <= 0.25
    ? { id: "empty-frames", level: "green", detail: `近空画面帧占比 ${(analysis.flatFrameRatio * 100).toFixed(0)}%` }
    : { id: "empty-frames", level: "red", detail: `近空画面帧占比 ${(analysis.flatFrameRatio * 100).toFixed(0)}%,存在大段无内容画面` });
  if (typeof analysis.firstFrameStd === "number") {
    const std = analysis.firstFrameStd.toFixed(1), luma = analysis.firstFrameLuma?.toFixed(0) ?? "?";
    gates.push(Number(std) >= thresholds.warnFirstFrameStd
      ? { id: "first-frame", level: "green", detail: `首帧有内容（标准差 ${std}，亮度 ${luma}）` }
      : Number(std) >= thresholds.minFirstFrameStd
        ? { id: "first-frame", level: "yellow", detail: `首帧偏空（标准差 ${std}，亮度 ${luma}），封面/自动播放第一眼会显得没内容` }
        : { id: "first-frame", level: "red", detail: `首帧接近纯色（标准差 ${std}，亮度 ${luma}），打开就是空镜` });
  }
  gates.push(spec.durationSec > 0 && Number.isFinite(spec.durationSec)
    ? { id: "spec", level: "green", detail: `${spec.width}x${spec.height}@${spec.fps}, ${spec.durationSec.toFixed(2)}s` }
    : { id: "spec", level: "red", detail: "无法读取时长,成片可能损坏" });
  return gates;
}

export function verdictOf(gates: QaGate[]): "green" | "yellow" | "red" {
  if (gates.some((gate) => gate.level === "red")) return "red";
  if (gates.some((gate) => gate.level === "yellow")) return "yellow";
  return "green";
}

export async function runQa(videoPath: string, thresholds: QaThresholds = DEFAULT_QA_THRESHOLDS): Promise<QaReport> {
  const spec = await probeVideo(videoPath);
  const frames = await extractFrames(videoPath, spec);
  const analysis = analyzeFrames(frames, thresholds, qaSampleInterval(spec.durationSec, spec.fps));
  const gates = buildGates(analysis, spec, thresholds);
  if (frames.length < 2) gates.splice(0, 1, { id: "richness", level: "yellow", detail: "可用帧不足两帧，无法判断运动；需要人工检查，不作静止结论。" });
  return {
    video: path.resolve(videoPath),
    spec,
    frames: frames.length,
    ...analysis,
    gates,
    verdict: verdictOf(gates),
  };
}

export function printQaReport(report: QaReport): void {
  const icon = { green: "✓", yellow: "◆", red: "✗" } as const;
  console.log(`[glint] QA ${report.verdict.toUpperCase()} — ${path.basename(report.video)} (${report.spec.width}x${report.spec.height}, ${report.spec.durationSec.toFixed(1)}s, ${report.frames} 样帧)`);
  for (const gate of report.gates) console.log(`  ${icon[gate.level]} ${gate.id}: ${gate.detail}`);
}
