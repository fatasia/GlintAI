import { isSafeRelativeAssetPath } from "./assets";
import type { Scene, SceneScriptProject } from "./types";
import { buildTimeline } from "./timeline";
import { parseNleProject, type NleClip, type NleProject } from "./nle";

/**
 * Minimal SceneScript ⇄ NLE bridge (CORE-04/CORE-05 compatible path).
 *
 * Honest scope: the NLE projection carries object identity (clip id ↔ scene
 * id) and timing; scene *content* stays authored in SceneScript. Raster kinds
 * (video/image) map to media clips; every other kind maps to a text clip that
 * summarizes what the scene shows. The round-trip contract covers timing
 * (durationMs), source in-points (video) and scene order — nothing else is
 * claimed lossless yet.
 */

export interface SceneNleLink {
  sceneId: string;
  trackId: string;
  clipId: string;
  startMs: number;
  durationMs: number;
}

export interface SceneScriptNleProjection {
  nle: NleProject;
  links: SceneNleLink[];
  /** Narration audio that could not become an audio clip (non-local path); never dropped silently. */
  skippedAudio: Array<{ sceneId: string; audioRef: string }>;
}

const PREVIEW_SIZES: Record<SceneScriptProject["aspect"], [number, number]> = {
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "1:1": [720, 720],
};

const RASTER_TRACK = "v1";
const CAPTION_TRACK = "ov1";
const AUDIO_TRACK = "a1";

/**
 * Stable clip id from a scene id, clamped to the NLE contract (≤64 kebab
 * chars). Two scenes colliding after the clamp is a hard error — identity
 * links must stay unique rather than silently merging scenes.
 */
function clipIdForScene(prefix: string, sceneId: string, used: Set<string>): string {
  const id = `${prefix}-${sceneId}`.slice(0, 64);
  if (used.has(id)) throw new Error(`Scene id "${sceneId}" collides with another scene after clipping to the NLE id limit; rename the scene`);
  used.add(id);
  return id;
}

/** One line of what the scene shows, for the NLE text clip. Content stays in SceneScript. */
export function sceneSummaryText(scene: Scene): string {
  switch (scene.kind) {
    case "title": return scene.subtitle ? `${scene.title} — ${scene.subtitle}` : scene.title;
    case "bullets": return scene.heading ?? scene.items.join(" · ");
    case "definition": return `${scene.term}：${scene.definition}`;
    case "quote": return scene.attribution ? `${scene.text} — ${scene.attribution}` : scene.text;
    case "comparison": return scene.heading ?? `${scene.left.label} vs ${scene.right.label}`;
    case "code": return scene.heading ?? scene.caption ?? scene.language ?? "代码";
    case "three": return scene.caption ?? `3D ${scene.model}`;
    case "diagram": return scene.heading ?? scene.steps.map(step => step.label).join(" → ");
    case "chart": return scene.heading ?? `${scene.chartType} 图表`;
    case "image": return scene.caption ?? scene.src;
    case "video": return scene.caption ?? scene.src;
    case "html": return scene.caption ?? "HTML 动画";
  }
}

function localAssetOrNull(ref: string | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("assets/") && isSafeRelativeAssetPath(ref) ? ref : null;
}

/**
 * Project a SceneScript film onto a multi-track NLE timeline. Every scene
 * becomes exactly one visual clip (media for raster kinds, text otherwise);
 * local narration audio becomes a parallel audio clip.
 */
export function sceneScriptToNle(project: SceneScriptProject, options: { width?: number; height?: number } = {}): SceneScriptNleProjection {
  const timeline = buildTimeline(project);
  const [defaultWidth, defaultHeight] = PREVIEW_SIZES[project.aspect];
  const rasterClips: NleClip[] = [];
  const captionClips: NleClip[] = [];
  const audioClips: NleClip[] = [];
  const links: SceneNleLink[] = [];
  const skippedAudio: SceneScriptNleProjection["skippedAudio"] = [];
  const usedClipIds = new Set<string>(["music"]);

  for (const entry of timeline.entries) {
    const { scene, startMs, durationMs } = entry;
    const id = clipIdForScene("scene", scene.id, usedClipIds);
    // Raster kinds become media on the main track; authored kinds become a
    // caption clip on the overlay track (content stays in SceneScript).
    let trackId: string;
    if (scene.kind === "video") {
      rasterClips.push({ id, kind: "video", src: scene.src, startMs, durationMs, trimStartMs: Math.round((scene.trimStartSec ?? 0) * 1000), ...(scene.speed !== undefined ? { speed: scene.speed } : {}) });
      trackId = RASTER_TRACK;
    } else if (scene.kind === "image") {
      rasterClips.push({ id, kind: "image", src: scene.src, startMs, durationMs });
      trackId = RASTER_TRACK;
    } else {
      captionClips.push({ id, kind: "text", text: sceneSummaryText(scene).slice(0, 500), startMs, durationMs });
      trackId = CAPTION_TRACK;
    }
    links.push({ sceneId: scene.id, trackId, clipId: id, startMs, durationMs });

    const audioRef = localAssetOrNull(scene.narration.audioRef);
    if (scene.narration.audioRef && !audioRef) skippedAudio.push({ sceneId: scene.id, audioRef: scene.narration.audioRef });
    if (audioRef) audioClips.push({ id: clipIdForScene("voice", scene.id, usedClipIds), kind: "audio", src: audioRef, startMs, durationMs });
  }

  const musicRef = localAssetOrNull(project.music?.src);
  if (project.music?.src && !musicRef) skippedAudio.push({ sceneId: "__music__", audioRef: project.music.src });
  if (musicRef) {
    audioClips.push({ id: "music", kind: "audio", src: musicRef, startMs: 0, durationMs: timeline.totalMs, ...(project.music?.volume !== undefined ? { volume: project.music.volume } : {}) });
  }

  const nle = parseNleProject({
    schemaVersion: 1,
    id: project.id,
    title: project.title,
    fps: project.fps ?? 30,
    width: options.width ?? defaultWidth,
    height: options.height ?? defaultHeight,
    tracks: [
      { id: RASTER_TRACK, kind: "video", name: "主轨", clips: rasterClips },
      { id: CAPTION_TRACK, kind: "overlay", name: "场景", clips: captionClips },
      { id: AUDIO_TRACK, kind: "audio", name: "音频", clips: audioClips },
    ],
  });
  return { nle, links, skippedAudio };
}

export interface NleApplyResult {
  project: SceneScriptProject;
  /** Links whose clips still exist and were written back. */
  applied: SceneNleLink[];
  /** Links whose clips were deleted from the NLE; scenes keep their timing and are reported, never dropped. */
  missing: SceneNleLink[];
}

/**
 * Write NLE edits back into the SceneScript film through the projection's
 * identity links: clip durations become narration durations, video trims and
 * speed become scene source ranges, and clip order becomes scene order.
 * Deleted clips never delete scenes — they surface in `missing`.
 */
export function applyNleToSceneScript(project: SceneScriptProject, projection: Pick<SceneScriptNleProjection, "links">, nle: Pick<NleProject, "tracks">): NleApplyResult {
  const clips = new Map<string, NleClip>();
  for (const track of nle.tracks) for (const clip of track.clips) clips.set(clip.id, clip);

  const applied: SceneNleLink[] = [], missing: SceneNleLink[] = [];
  const updated = new Map<string, Scene>();
  for (const link of projection.links) {
    const scene = project.scenes.find(candidate => candidate.id === link.sceneId);
    if (!scene) continue;
    const clip = clips.get(link.clipId);
    if (!clip) { missing.push(link); continue; }
    if (clip.speedCurve && clip.speedCurve !== "linear") {
      throw new Error(`片段 ${clip.id} 使用曲线变速，SceneScript 暂不能无损回写；请保留 NLE 工程或先渲染该片段。`);
    }
    applied.push(link);
    const narration = { ...scene.narration, durationMs: clip.durationMs };
    let next: Scene;
    if (scene.kind === "video") {
      next = {
        ...scene, narration,
        trimStartSec: (clip.trimStartMs ?? 0) / 1000,
        ...(clip.speed !== undefined ? { speed: clip.speed } : {}),
      };
    } else {
      next = { ...scene, narration };
    }
    updated.set(scene.id, next);
  }

  const order = [...projection.links]
    .filter(link => clips.has(link.clipId))
    .sort((a, b) => clips.get(a.clipId)!.startMs - clips.get(b.clipId)!.startMs || a.clipId.localeCompare(b.clipId))
    .map(link => link.sceneId);
  const scenes = [...project.scenes.map(scene => updated.get(scene.id) ?? scene)]
    .sort((a: Scene, b: Scene) => {
      const indexA = order.indexOf(a.id), indexB = order.indexOf(b.id);
      return (indexA === -1 ? project.scenes.length : indexA) - (indexB === -1 ? project.scenes.length : indexB);
    });
  return { project: { ...project, scenes }, applied, missing };
}
