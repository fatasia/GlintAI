import { nleDurationMs, parseNleProject, type NleProject } from "@glintai/scenescript";
import type { VideoPlan } from "@glintai/composer/plan";

/**
 * DRAMA-07 / SKILL-09：分镜计划 → 多轨 NLE 时间线工程。
 * 约束：
 * - 三轨同切点：video 轨每场一张场景卡（image）、text 轨字幕、audio 轨旁白，逐场对齐。
 * - 剪辑时长跟音频走：sceneAudioMs[i] 由导出脚本在 TTS 合成后回填实际音频时长
 *   （真实或 mock 同一合同）；缺省退回计划估值 seconds*1000（只是预算不是承诺）。
 * - 资产命名 assets/scene-NN.png / scene-NN.wav 由导出脚本用本地 ffmpeg / mock TTS
 *   生成；本模块只定契约，不碰磁盘与进程。
 * - 首场之外每场 fade-in：转场渲染在 clip 自身时长内，不引入轨间重叠。
 */

const TRANSITION_MS = 400;
const DIMENSIONS: Record<VideoPlan["platform"], { width: number; height: number }> = {
  "9:16": { width: 720, height: 1280 },
  "16:9": { width: 1280, height: 720 },
  "1:1": { width: 1080, height: 1080 },
};

export interface DramaTimelineAsset { name: string; kind: "image" | "audio"; scene: number; narration: string; ms: number }

export interface DramaTimeline { project: NleProject; assets: DramaTimelineAsset[]; audioMs: number[]; starts: number[]; totalMs: number }

/** NLE ids are lowercase kebab-case (scenescript contract); titles stay free-form. */
const kebab = (value: string, fallback: string) => {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return /^[a-z0-9]/.test(cleaned) ? cleaned : fallback;
};

export function buildDramaTimeline(plan: VideoPlan, options: { fps?: number; id?: string; sceneAudioMs?: number[] } = {}): DramaTimeline {
  const dims = DIMENSIONS[plan.platform];
  const fps = options.fps ?? 24;
  const audioMs = plan.scenes.map((scene, index) => Math.max(100, Math.round(options.sceneAudioMs?.[index] ?? scene.seconds * 1000)));
  let clock = 0;
  const starts: number[] = [];
  const imageClips: Array<{ id: string; kind: "image"; src: string; startMs: number; durationMs: number; transitionIn?: { type: "fade"; durationMs: number } }> = [];
  const captionClips: Array<{ id: string; kind: "text"; text: string; fontSize: number; color: string; weight: 400 | 600 | 700 | 800; align: "left" | "center" | "right"; startMs: number; durationMs: number }> = [];
  const voiceClips: Array<{ id: string; kind: "audio"; src: string; startMs: number; durationMs: number }> = [];
  const assets: DramaTimelineAsset[] = [];
  plan.scenes.forEach((scene, index) => {
    const nn = String(index + 1).padStart(2, "0");
    const startMs = clock, durationMs = audioMs[index]!;
    clock += durationMs;
    starts.push(startMs);
    imageClips.push({
      id: `scene-${nn}`, kind: "image" as const, src: `assets/scene-${nn}.png`, startMs, durationMs,
      ...(index > 0 ? { transitionIn: { type: "fade" as const, durationMs: Math.max(100, Math.min(TRANSITION_MS, durationMs)) } } : {}),
    });
    captionClips.push({ id: `caption-${nn}`, kind: "text" as const, text: scene.narration.slice(0, 500), fontSize: Math.round(dims.height * 0.042), color: "#ffffff", weight: 600 as const, align: "center" as const, startMs, durationMs });
    voiceClips.push({ id: `voice-${nn}`, kind: "audio" as const, src: `assets/scene-${nn}.wav`, startMs, durationMs });
    assets.push({ name: `scene-${nn}.png`, kind: "image", scene: index + 1, narration: scene.narration, ms: durationMs });
    assets.push({ name: `scene-${nn}.wav`, kind: "audio", scene: index + 1, narration: scene.narration, ms: durationMs });
  });
  const project = parseNleProject({
    schemaVersion: 1 as const,
    id: kebab(options.id ?? plan.title, "drama-episode"),
    title: plan.title.slice(0, 200),
    fps,
    width: dims.width,
    height: dims.height,
    background: "#0b0b12",
    tracks: [
      { id: "v1", kind: "video" as const, name: "场景卡", clips: imageClips },
      { id: "t1", kind: "text" as const, name: "字幕", clips: captionClips },
      { id: "a1", kind: "audio" as const, name: "旁白", clips: voiceClips },
    ],
  });
  return { project, assets, audioMs, starts, totalMs: nleDurationMs(project) };
}
