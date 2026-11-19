import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseNleProject, type NleProject } from "@glintai/scenescript";
import { formatSrt } from "./jianying";
import { runMediaProcess } from "./native-process";
import { coverFrameIndex } from "./nle-render";

/**
 * DELIVER-03 成片交付包：MP4 + SRT + 封面三件套 + manifest.json。
 * SRT 来自 NLE 文字轨（text clip 即一条字幕，起止即时间轴位置）；
 * 封面优先用渲染回执的 <video>.cover.jpg，缺席时按 coverAtMs 从成片抽帧
 * （省略=首帧，与 nle-render 默认一致）。
 */

export interface DeliveryPackage {
  dir: string;
  video: string;
  srt: string;
  cover: string;
  manifestFile: string;
  cues: number;
}

/** NLE 文字轨 → SRT 字幕串；按时间轴排序，空文本/零时长剔除。 */
export function buildNleSrt(project: NleProject): string {
  const cues = project.tracks.flatMap(track => track.clips.flatMap(clip =>
    clip.kind === "text" && clip.text.trim() && clip.durationMs > 0
      ? [{ startMs: clip.startMs, endMs: clip.startMs + clip.durationMs, text: clip.text }]
      : [])).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return formatSrt(cues);
}

function probeVideoFps(video: string): number {
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate", "-of", "json", video], { encoding: "utf8", timeout: 30_000 });
  const stream = JSON.parse(probe.stdout || "{}").streams?.[0];
  for (const rate of [stream?.avg_frame_rate, stream?.r_frame_rate]) {
    const match = /^(\d+)\/(\d+)$/.exec(String(rate ?? ""));
    if (match && Number(match[2]) > 0 && Number(match[1]) > 0) return Number(match[1]) / Number(match[2]);
  }
  throw new Error("无法读取成片帧率；确认 MP4 可解码。");
}

export async function assembleDeliveryPackage(options: {
  projectFile: string;
  video: string;
  /** 封面帧时间点（毫秒）；仅当渲染回执封面缺席时用于抽帧，省略=首帧。 */
  coverAtMs?: number;
  outDir: string;
}): Promise<DeliveryPackage> {
  const project = parseNleProject(JSON.parse(fs.readFileSync(options.projectFile, "utf8")));
  const video = path.resolve(options.video);
  if (!fs.existsSync(video) || fs.statSync(video).size === 0) throw new Error(`成片不存在或为空：${video}`);
  fs.mkdirSync(options.outDir, { recursive: true });
  const base = path.basename(video).replace(/\.[a-z0-9]+$/i, "");

  const srtFile = path.join(options.outDir, `${base}.srt`);
  const srt = buildNleSrt(project);
  fs.writeFileSync(srtFile, srt, "utf8");

  const renderedCover = video.replace(/\.[a-z0-9]+$/i, "") + ".cover.jpg";
  const coverFile = path.join(options.outDir, `${base}.cover.jpg`);
  if (fs.existsSync(renderedCover)) {
    fs.copyFileSync(renderedCover, coverFile);
  } else {
    const fps = probeVideoFps(video);
    const durationMs = probeVideoDurationMs(video);
    const frame = coverFrameIndex(options.coverAtMs, fps, Math.max(1, Math.round(durationMs / 1000 * fps)));
    await runMediaProcess("ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", video, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-q:v", "3", coverFile], { timeoutMs: 60_000 });
  }
  if (!fs.existsSync(coverFile) || fs.statSync(coverFile).size === 0) throw new Error("封面帧抽取失败；成片可能无可解码视频轨。");

  const videoOut = path.join(options.outDir, path.basename(video));
  fs.copyFileSync(video, videoOut);
  const files = [videoOut, srtFile, coverFile];
  const manifestFile = path.join(options.outDir, "delivery.json");
  fs.writeFileSync(manifestFile, JSON.stringify({
    assembledAt: new Date().toISOString(),
    project: project.id,
    coverAtMs: fs.existsSync(renderedCover) ? "rendered" : options.coverAtMs ?? 0,
    cues: (srt.match(/-->/g) ?? []).length,
    files: files.map(file => ({ file: path.basename(file), bytes: fs.statSync(file).size })),
  }, null, 2));
  return { dir: path.resolve(options.outDir), video: videoOut, srt: srtFile, cover: coverFile, manifestFile, cues: (srt.match(/-->/g) ?? []).length };
}

function probeVideoDurationMs(video: string): number {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", video], { encoding: "utf8", timeout: 30_000 });
  const duration = Number(JSON.parse(probe.stdout || "{}").format?.duration ?? 0);
  if (!(duration > 0)) throw new Error("无法读取成片时长；确认 MP4 可解码。");
  return Math.round(duration * 1000);
}
