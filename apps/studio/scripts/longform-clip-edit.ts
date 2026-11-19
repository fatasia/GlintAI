import fs from "node:fs";
import path from "node:path";
import { nleMoveClip, nleTrimClip, parseNleProject, parseProject, type NleClip, type NleProject, type SceneScriptProject } from "@glintai/scenescript";

/**
 * CLIP-03 边界编辑：切片工程（SceneScript）导出为 NleProject，用 nleTrimClip
 * 改边界。NleClip 是 strict schema（不收额外字段），所以「源时间码」只能活在
 * SceneScript 的 notes 里——每次编辑后必须把 notes 重写回新窗口，追溯不断链。
 */

export interface ClipSourceWindow { startMs: number; endMs: number }

const clipNotes = (window: ClipSourceWindow, sourceVideo: string, original: ClipSourceWindow, edited: boolean): string => {
  const seconds = ((window.endMs - window.startMs) / 1000).toFixed(1);
  const history = edited ? `，边界经 NLE 编辑 自 ${original.startMs}ms–${original.endMs}ms` : "";
  return `源时间码 ${window.startMs}ms–${window.endMs}ms（源片 ${path.basename(sourceVideo)}，时长 ${seconds}s${history}）`;
};

/** 切片工程 → NLE 工程：切片资产在时间轴上原样铺开，入点即源窗起点。 */
export function clipProjectToNle(input: {
  project: SceneScriptProject;
  sourceWindow: ClipSourceWindow;
  width: number;
  height: number;
  fps?: number;
}): { nle: NleProject; trackId: string; clipId: string } {
  const scene = input.project.scenes[0];
  if (!scene || scene.kind !== "video") throw new Error("切片工程第一个场景必须是 video；先运行 glint clip。");
  const clipId = `${input.project.id}-segment`;
  const nle = parseNleProject({
    schemaVersion: 1,
    id: `${input.project.id}-nle`,
    title: input.project.title,
    fps: input.fps ?? 30,
    width: Math.round(input.width),
    height: Math.round(input.height),
    tracks: [{
      id: "v1", kind: "video", name: "主轨",
      clips: [{
        id: clipId, kind: "video", src: scene.src,
        startMs: 0, durationMs: Math.max(100, input.sourceWindow.endMs - input.sourceWindow.startMs),
        trimStartMs: Math.max(0, Math.round((scene.trimStartSec ?? 0) * 1000)),
      }],
    }],
  });
  return { nle, trackId: "v1", clipId };
}

/** NLE 边界反推源片时间窗：trimStart 是相对切片文件的入点，变速参与源消耗。 */
export function editedSourceWindow(input: { nle: NleProject; trackId: string; clipId: string; original: ClipSourceWindow }): ClipSourceWindow {
  const clip = input.nle.tracks.find(track => track.id === input.trackId)?.clips.find(item => item.id === input.clipId) as NleClip | undefined;
  if (!clip || clip.kind !== "video") throw new Error(`NLE 里找不到视频片段 ${input.clipId}`);
  const speed = clip.speed ?? 1;
  return {
    startMs: input.original.startMs + (clip.trimStartMs ?? 0),
    endMs: Math.round(input.original.startMs + (clip.trimStartMs ?? 0) + clip.durationMs * speed),
  };
}

/** 把新源窗写回切片工程 notes（不可变重建，返回值必须重新落盘）。 */
export function withTracedBoundaries(input: { project: SceneScriptProject; window: ClipSourceWindow; sourceVideo: string; original: ClipSourceWindow; edited: boolean }): SceneScriptProject {
  const scene = input.project.scenes[0];
  if (!scene || scene.kind !== "video") throw new Error("切片工程第一个场景必须是 video。");
  return parseProject({
    ...input.project,
    scenes: [{ ...scene, notes: clipNotes(input.window, input.sourceVideo, input.original, input.edited) }],
  });
}

export interface ClipEditOutcome { project: SceneScriptProject; nle: NleProject; window: ClipSourceWindow; edited: boolean }

/**
 * 清单级入口：读 clips.json → 找片 → NLE 双边 trim → notes 同步 → 工程文件回写。
 * 零改动（delta 都为 0 或被夹具拒绝）时不动工程文件，notes 保持原样。
 */
export function editClipBoundaries(options: {
  manifestFile: string;
  clipId: string;
  /** 正数=左边界向右收进（源入点后移）；0/省略=不动。 */
  trimStartMs?: number;
  /** 正数=右边界向左收进；0/省略=不动。 */
  trimEndMs?: number;
  width: number;
  height: number;
  fps?: number;
}): ClipEditOutcome {
  const manifestPath = path.resolve(options.manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    source: { videoPath: string };
    clips: Array<{ id: string; startMs: number; endMs: number; projectFile: string }>;
  };
  const clip = manifest.clips.find(entry => entry.id === options.clipId);
  if (!clip) throw new Error(`清单里没有 ${options.clipId}；可用：${manifest.clips.map(entry => entry.id).join("、")}`);
  const sourceVideo = manifest.source.videoPath;
  const original: ClipSourceWindow = { startMs: clip.startMs, endMs: clip.endMs };
  const project = parseProject(JSON.parse(fs.readFileSync(path.resolve(path.dirname(manifestPath), clip.projectFile), "utf8")));
  const { nle, trackId, clipId } = clipProjectToNle({ project, sourceWindow: original, width: options.width, height: options.height, fps: options.fps });

  const trimStart = Math.max(0, Math.round(options.trimStartMs ?? 0));
  const trimEnd = Math.max(0, Math.round(options.trimEndMs ?? 0));
  let edited: NleProject = nle;
  if (trimStart > 0) edited = nleMoveClip(nleTrimClip(edited, trackId, clipId, "start", trimStart), trackId, clipId, 0); // 头部收进后时间轴保持贴零，导出不带黑场
  if (trimEnd > 0) edited = nleTrimClip(edited, trackId, clipId, "end", -trimEnd);
  const window = editedSourceWindow({ nle: edited, trackId, clipId, original });
  const changed = window.startMs !== original.startMs || window.endMs !== original.endMs;
  if (!changed) return { project, nle: edited, window: original, edited: false };

  const next = withTracedBoundaries({ project, window, sourceVideo, original, edited: true });
  fs.writeFileSync(path.resolve(path.dirname(manifestPath), clip.projectFile), JSON.stringify(next, null, 2));
  return { project: next, nle: edited, window, edited: true };
}
